/**
 * Reconnaissance du serveur d'un projet : ou est sa racine, quel mode de compilation, quels scripts il charge.
 * Fonctions pures (aucun acces fichier ni interface) : le controleur leur fournit la liste des fichiers du projet et un
 * lecteur de texte. Seul l'adaptateur rAthena existe pour l'instant.
 */
import type { ScriptLoadFileSystem, ScriptLoadIssue, ScriptLoadReport } from "@runeforge/emulator-core";
import { detectRenewal, RATHENA_PATHS, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import type { EmulatorMode } from "@runeforge/project-core";
import type { LoadIssue } from "../state/store";

/** Fichiers qui trahissent la racine d'un serveur rAthena (chemins relatifs a cette racine). */
const SERVER_MARKERS: readonly string[] = [
  RATHENA_PATHS.commandDoc,
  RATHENA_PATHS.builtinSource,
  RATHENA_PATHS.scriptsMain.renewal,
  RATHENA_PATHS.scriptsMain.preRenewal,
  RATHENA_PATHS.mapConfig,
];

/** Chemin d'un fichier du serveur, depuis la racine du projet (`root` vide : le projet est la racine du serveur). */
export function joinServerPath(root: string, relative: string): string {
  // Les configurations du serveur acceptent `./` ; le scan et le backend utilisent des chemins sans segment `.`.
  // Ne pas effacer les segments vides ou `..` : le garde de chemins doit encore refuser les chemins dangereux.
  const normalized = relative.split("/").filter((segment) => segment !== ".").join("/");
  return root === "" ? normalized : `${root}/${normalized}`;
}

/**
 * Racines de serveur rAthena que laissent supposer les fichiers du projet (chemins relatifs, avec `/`), triees. La racine
 * du projet elle-meme est notee `""`.
 */
export function findServerRoots(files: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const path of files) {
    for (const marker of SERVER_MARKERS) {
      if (path === marker) roots.add("");
      else if (path.endsWith(`/${marker}`)) roots.add(path.slice(0, path.length - marker.length - 1));
    }
  }
  return [...roots].sort();
}

export type ServerLocation =
  /** Serveur retenu : impose par la configuration, ou trouve automatiquement (`detected`). */
  | { readonly status: "found"; readonly root: string; readonly detected: boolean }
  /** Plusieurs serveurs possibles : l'application ne choisit pas a la place de l'utilisateur. */
  | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly status: "not-found" };

/**
 * Choisit la racine du serveur. Une racine configuree est prise telle quelle. Sinon : la racine du projet si c'est un
 * serveur, sinon l'unique serveur trouve dans ses sous-dossiers ; s'il y en a plusieurs, rien n'est choisi.
 */
export function locateServer(configuredRoot: string, files: Iterable<string>): ServerLocation {
  if (configuredRoot !== "") return { status: "found", root: configuredRoot, detected: false };
  const candidates = findServerRoots(files);
  if (candidates.length === 0) return { status: "not-found" };
  if (candidates.includes("")) return { status: "found", root: "", detected: true };
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return { status: "found", root: only, detected: true };
  return { status: "ambiguous", candidates };
}

export interface RenewalChoice {
  readonly renewal: boolean;
  /** `config` : impose par le projet ; `header` : lu dans le serveur ; `default` : suppose (renewal), a confirmer. */
  readonly source: "config" | "header" | "default";
}

/** Mode de compilation retenu : celui du projet s'il est impose, sinon celui deduit de `src/config/renewal.hpp`. */
export function resolveRenewal(mode: EmulatorMode, headerText: string | null): RenewalChoice {
  if (mode === "renewal") return { renewal: true, source: "config" };
  if (mode === "pre-renewal") return { renewal: false, source: "config" };
  const detected = detectRenewal(headerText);
  return { renewal: detected.renewal, source: detected.evidence };
}

/**
 * Les problemes releves dans les listes de scripts du serveur, avec des chemins relatifs au projet (ceux du rapport de
 * chargement le sont a la racine du serveur) : de quoi les afficher et ouvrir le fichier de configuration a la bonne ligne.
 */
export function describeLoadIssues(issues: readonly ScriptLoadIssue[], root: string): LoadIssue[] {
  const project = (path: string): string => joinServerPath(root, path);
  return issues.map((issue): LoadIssue => {
    switch (issue.kind) {
      case "missing-config":
        return { kind: "missing-config", file: issue.importedFrom === null ? null : project(issue.importedFrom), line: issue.line, subject: project(issue.path) };
      case "missing-script":
        return { kind: "missing-script", file: project(issue.config), line: issue.line, subject: project(issue.path) };
      case "unknown-setting":
        return { kind: "unknown-setting", file: project(issue.config), line: issue.line, subject: issue.setting };
      case "import-cycle":
        return { kind: "import-cycle", file: project(issue.config), line: issue.line, subject: project(issue.path) };
      case "limit":
        return { kind: issue.limit === "depth" ? "limit-depth" : "limit-reads", file: project(issue.config), line: issue.line, subject: project(issue.path) };
    }
  });
}

/**
 * Cartes que le serveur charge (`map:` de `conf/map_athena.conf` et de ses imports, dans leur ordre, `delmap:` appliques), ou
 * `null` quand la liste n'est pas connue (configuration absente ou illisible, aucune carte) : le catalogue ne dit alors d'aucune
 * carte qu'elle n'est pas chargee. `readText` lit un fichier de configuration (chemin relatif au projet), le serveur est a `root`.
 */
export async function resolveLoadedMaps(input: {
  readonly root: string;
  readonly renewal: boolean;
  readonly readText: (projectPath: string) => Promise<string | null>;
}): Promise<readonly string[] | null> {
  // Seules les cartes comptent ici : l'existence des scripts cites n'a pas besoin d'etre verifiee.
  const loaded = await resolveLoadedScripts({ ...input, hasFile: () => true });
  return loaded.report.maps.length > 0 ? loaded.report.maps : null;
}

export interface LoadedScripts {
  /** Scripts charges par le serveur, dans son ordre, chemins relatifs a la racine du projet. */
  readonly files: readonly string[];
  readonly report: ScriptLoadReport;
}

/**
 * Scripts que le serveur charge reellement. `readText` lit un fichier de configuration (chemin relatif au projet) et
 * `hasFile` dit si un fichier existe dans le projet ; le serveur est a `root` (relative au projet).
 */
export async function resolveLoadedScripts(input: {
  readonly root: string;
  readonly renewal: boolean;
  readonly readText: (projectPath: string) => Promise<string | null>;
  readonly hasFile: (projectPath: string) => boolean;
}): Promise<LoadedScripts> {
  const fileSystem: ScriptLoadFileSystem = {
    readText: (path) => input.readText(joinServerPath(input.root, path)),
    existingFiles: (paths) => Promise.resolve(new Set(paths.filter((path) => input.hasFile(joinServerPath(input.root, path))))),
  };
  const report = await resolveRathenaScripts(fileSystem, input.renewal);
  return { files: report.files.map((path) => joinServerPath(input.root, path)), report };
}
