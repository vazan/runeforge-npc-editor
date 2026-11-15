/**
 * Regles de chargement des scripts d'un serveur : fichiers `conf/map_athena.conf`, `npc/re/scripts_main.conf`...
 *
 * Reproduit la lecture du serveur rAthena (`map_config_read`, `map_reloadnpc_sub` dans `map.cpp`, `npc_addsrcfile` et
 * `npc_delsrcfile` dans `npc.cpp`), verifiee sur le code source du serveur local :
 * - une ligne commence par `//` (ignoree) ou contient `//` (la suite est un commentaire, meme au milieu d'un chemin) ;
 * - `reglage: valeur` ; le reglage est tout ce qui precede le premier « : » **sans retirer les espaces** (`npc : x` est donc
 *   un reglage inconnu), la valeur s'arrete a une tabulation ou a la fin de ligne, ses espaces finaux sont retires ;
 * - `npc: chemin` ajoute un fichier de script (il doit exister ; un chemin deja present n'est pas ajoute une seconde
 *   fois ; `npc: clear` vide la liste) ;
 * - `delnpc: chemin` retire un fichier (`delnpc: all` vide la liste) ;
 * - `import: chemin` lit un autre fichier de configuration, immediatement, au meme endroit ;
 * - dans `conf/map_athena.conf` et ses imports seulement : `map: nom` ajoute une carte au serveur (`map: clear` vide la
 *   liste ; l'extension `.gat` est retiree ; un nom deja present est ajoute une seconde fois), `delmap: nom` retire la
 *   premiere carte de ce nom (`delmap: all` vide la liste). Un fichier de liste de scripts (`npc-list`) ne les lit pas.
 * L'ordre obtenu est celui dans lequel le serveur charge les scripts (important : une fonction globale doit etre chargee
 * avant d'etre appelee par son seul nom).
 *
 * Le serveur ne se protege pas contre les `import` circulaires ; ici une boucle est signalee puis ignoree.
 */

import { normalizeMapName } from "./reference-catalog";

export interface ScriptConfSetting {
  /** Nom du reglage tel qu'ecrit. */
  readonly setting: string;
  readonly value: string;
}

const COMMENT = "//";

function isCSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function isValueTerminator(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Decoupe une ligne de configuration comme le serveur ; `null` si la ligne est ignoree. */
export function parseScriptConfLine(rawLine: string): ScriptConfSetting | null {
  if (rawLine.startsWith(COMMENT)) return null;
  const cut = rawLine.indexOf(COMMENT);
  const line = cut === -1 ? rawLine : rawLine.slice(0, cut);
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  let start = colon + 1;
  while (start < line.length && isCSpace(line.charCodeAt(start))) start += 1;
  let end = start;
  while (end < line.length && !isValueTerminator(line.charCodeAt(end))) end += 1;
  while (end > start && line.charCodeAt(end - 1) === 0x20) end -= 1;
  if (end === start) return null;
  return { setting: line.slice(0, colon), value: line.slice(start, end) };
}

/**
 * Nature d'un fichier de configuration :
 * - `map-config` (`conf/map_athena.conf`) : contient beaucoup d'autres reglages, ignores sans bruit ;
 * - `npc-list` (`npc/re/scripts_main.conf`) : ne devrait contenir que `npc:`, `delnpc:` et `import:` (le serveur signale
 *   tout autre reglage).
 * Le mode se transmet aux fichiers importes.
 */
export type ScriptConfMode = "map-config" | "npc-list";

export interface ScriptLoadEntryPoint {
  /** Chemin relatif a la racine du serveur, avec `/`. */
  readonly path: string;
  readonly mode: ScriptConfMode;
}

/** Acces aux fichiers du serveur, fourni par l'appelant (disque, projet ouvert dans l'application, tests...). */
export interface ScriptLoadFileSystem {
  /** Contenu d'un fichier de configuration, ou `null` s'il n'existe pas. */
  readText(path: string): Promise<string | null>;
  /**
   * Parmi ces chemins, ceux qui designent un fichier existant (pas un dossier). Appele une seule fois avec tous les
   * scripts cites : le serveur verifie l'existence a chaque `npc:`, mais le resultat est le meme (un fichier absent n'est
   * pas ajoute) et un appel groupe evite des milliers d'allers-retours avec le disque.
   */
  existingFiles(paths: readonly string[]): Promise<ReadonlySet<string>>;
}

export type ScriptLoadIssue =
  /** Fichier de configuration introuvable (point d'entree ou `import:`). */
  | { readonly kind: "missing-config"; readonly path: string; readonly importedFrom: string | null; readonly line: number | null }
  /** `npc:` vers un fichier absent : le serveur l'ignore et journalise une erreur. */
  | { readonly kind: "missing-script"; readonly path: string; readonly config: string; readonly line: number }
  /** Reglage inconnu dans une liste de scripts : le serveur journalise un avertissement. */
  | { readonly kind: "unknown-setting"; readonly setting: string; readonly config: string; readonly line: number }
  /** `import:` circulaire : ignore (le serveur, lui, ne se protege pas). */
  | { readonly kind: "import-cycle"; readonly path: string; readonly config: string; readonly line: number }
  /** Profondeur d'imports ou nombre de lectures anormalement eleves : la suite n'est pas suivie. */
  | { readonly kind: "limit"; readonly limit: "depth" | "reads"; readonly path: string; readonly config: string; readonly line: number };

export interface ScriptLoadReport {
  /** Fichiers de script, dans l'ordre de chargement du serveur. */
  readonly files: readonly string[];
  /** Fichiers de configuration lus, dans l'ordre. */
  readonly configs: readonly string[];
  readonly issues: readonly ScriptLoadIssue[];
  /** Cartes que le serveur charge (`map:` de `conf/map_athena.conf` et de ses imports), dans l'ordre, noms sans `.gat`. */
  readonly maps: readonly string[];
}

export interface ScriptLoadOptions {
  /** Profondeur maximale d'`import:` imbriques (defaut 16). */
  readonly maxImportDepth?: number;
  /** Nombre maximal de lectures de fichiers de configuration (defaut 2000). */
  readonly maxConfigReads?: number;
}

const DEFAULT_MAX_IMPORT_DEPTH = 16;
const DEFAULT_MAX_CONFIG_READS = 2000;

/**
 * Developpe les points d'entree dans l'ordre et retourne les scripts que le serveur charge. Aucun fichier de script n'est
 * lu : seule son existence est verifiee.
 */
export async function resolveScriptLoadOrder(
  entryPoints: readonly ScriptLoadEntryPoint[],
  fileSystem: ScriptLoadFileSystem,
  options: ScriptLoadOptions = {},
): Promise<ScriptLoadReport> {
  const maxDepth = options.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH;
  const maxReads = options.maxConfigReads ?? DEFAULT_MAX_CONFIG_READS;
  // Liste « provisoire » : tous les `npc:` y figurent ; les fichiers absents en sont retires a la fin (voir plus bas).
  const files: string[] = [];
  const present = new Set<string>();
  const configs: string[] = [];
  const maps: string[] = [];
  let issues: ScriptLoadIssue[] = [];
  let reads = 0;

  const clear = (): void => {
    files.length = 0;
    present.clear();
  };

  const readConfig = async (
    path: string,
    mode: ScriptConfMode,
    importedFrom: string | null,
    importLine: number | null,
    stack: readonly string[],
  ): Promise<void> => {
    reads += 1;
    const text = await fileSystem.readText(path);
    if (text === null) {
      issues.push({ kind: "missing-config", path, importedFrom, line: importLine });
      return;
    }
    configs.push(path);
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const parsed = parseScriptConfLine(lines[index] ?? "");
      if (parsed === null) continue;
      const lineNumber = index + 1;
      switch (parsed.setting.toLowerCase()) {
        case "npc": {
          if (parsed.value.toLowerCase() === "clear") {
            clear();
            break;
          }
          // Chaque citation est supposee en echec ; elle est effacee des problemes si le fichier existe.
          issues.push({ kind: "missing-script", path: parsed.value, config: path, line: lineNumber });
          if (!present.has(parsed.value)) {
            present.add(parsed.value);
            files.push(parsed.value);
          }
          break;
        }
        case "delnpc": {
          if (parsed.value.toLowerCase() === "all") {
            clear();
          } else if (present.delete(parsed.value)) {
            files.splice(files.indexOf(parsed.value), 1);
          }
          break;
        }
        case "import": {
          const target = parsed.value;
          if (stack.includes(target) || target === path) {
            issues.push({ kind: "import-cycle", path: target, config: path, line: lineNumber });
          } else if (stack.length + 1 >= maxDepth) {
            issues.push({ kind: "limit", limit: "depth", path: target, config: path, line: lineNumber });
          } else if (reads >= maxReads) {
            issues.push({ kind: "limit", limit: "reads", path: target, config: path, line: lineNumber });
          } else {
            await readConfig(target, mode, path, lineNumber, [...stack, path]);
          }
          break;
        }
        case "map":
        case "delmap": {
          // Seul `map_config_read` les lit : une liste de scripts (`map_reloadnpc_sub`) les signale comme reglage inconnu.
          if (mode === "npc-list") {
            issues.push({ kind: "unknown-setting", setting: parsed.setting, config: path, line: lineNumber });
            break;
          }
          const value = parsed.value.toLowerCase();
          if (value === (parsed.setting.toLowerCase() === "map" ? "clear" : "all")) {
            maps.length = 0;
          } else if (parsed.setting.toLowerCase() === "map") {
            maps.push(normalizeMapName(parsed.value));
          } else {
            const at = maps.indexOf(normalizeMapName(parsed.value));
            if (at !== -1) maps.splice(at, 1);
          }
          break;
        }
        default:
          if (mode === "npc-list") issues.push({ kind: "unknown-setting", setting: parsed.setting, config: path, line: lineNumber });
      }
    }
  };

  for (const entry of entryPoints) await readConfig(entry.path, entry.mode, null, null, []);

  // Le serveur n'ajoute un `npc:` que si le fichier existe. Verifier a la fin donne la meme liste (un fichier absent n'a
  // jamais d'effet, ni sur l'ordre ni sur `delnpc`) en un seul appel au lieu d'un par ligne.
  const cited = new Set<string>();
  for (const issue of issues) if (issue.kind === "missing-script") cited.add(issue.path);
  const existing = cited.size === 0 ? new Set<string>() : await fileSystem.existingFiles([...cited]);
  issues = issues.filter((issue) => issue.kind !== "missing-script" || !existing.has(issue.path));
  return { files: files.filter((path) => existing.has(path)), configs, issues, maps };
}
