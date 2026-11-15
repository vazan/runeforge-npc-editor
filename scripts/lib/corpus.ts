/**
 * Selection des fichiers d'un corpus pour les outils de mesure (`analysis-report.ts`, `language-report.ts`).
 *
 * Deux modes :
 * - dossiers : tous les `.txt` trouves (plusieurs dossiers = un seul projet, chemins prefixes par `<indice>:`) ;
 * - serveur : `--server-root <racine> --entry npc/re/scripts_main.conf` developpe les `npc:` / `import:` comme
 *   `map_config_read` de rAthena pour obtenir l'ensemble des scripts **reellement charges** par le serveur.
 *
 * `--repeat N` replique le jeu N fois sous des chemins distincts (mesure de volume : les doublons de noms qui en resultent
 * sont attendus). Outil de mesure uniquement ; l'adaptateur d'emulateur du produit (M4) sera teste separement.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceFile {
  /** Identifiant du document (chemin relatif, avec `/`). */
  readonly uri: string;
  readonly path: string;
}

export interface Corpus {
  readonly files: SourceFile[];
  /** Fichiers references par une configuration mais absents du disque. */
  readonly missingFiles: string[];
  /** Description lisible de la source des fichiers. */
  readonly label: string[];
}

export interface CommandLine {
  readonly positional: readonly string[];
  value(name: string): string | undefined;
  has(name: string): boolean;
}

export const CORPUS_USAGE =
  "Selection du corpus :\n" +
  "  <dossier> [<dossier>...]                       tous les .txt de ces dossiers\n" +
  "  --server-root <racine> --entry npc/re/scripts_main.conf   les scripts charges par le serveur\n" +
  "  --repeat N                                     replique le jeu N fois (mesure de volume)";

const CORPUS_VALUE_OPTIONS = ["--entry", "--server-root", "--repeat"];

export function parseCommandLine(argv: readonly string[], extraValueOptions: readonly string[] = []): CommandLine {
  const valueOptions = new Set([...CORPUS_VALUE_OPTIONS, ...extraValueOptions]);
  const positional = argv.filter((argument, i) => !argument.startsWith("--") && !valueOptions.has(argv[i - 1] ?? ""));
  return {
    positional,
    value(name) {
      const at = argv.indexOf(name);
      return at === -1 ? undefined : argv[at + 1];
    },
    has: (name) => argv.includes(name),
  };
}

function expandServerConf(confRelativePath: string, base: string, seen: Set<string>, corpus: Corpus): void {
  if (seen.has(confRelativePath)) return;
  seen.add(confRelativePath);
  let content: string;
  try {
    content = readFileSync(join(base, confRelativePath)).toString("latin1");
  } catch {
    corpus.missingFiles.push(confRelativePath);
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const comment = rawLine.indexOf("//");
    const line = (comment === -1 ? rawLine : rawLine.slice(0, comment)).trim();
    const match = /^(npc|import)\s*:\s*(.+)$/i.exec(line);
    if (match === null) continue;
    const target = (match[2] ?? "").trim();
    if ((match[1] ?? "").toLowerCase() === "import") {
      expandServerConf(target, base, seen, corpus);
    } else if (!corpus.files.some((file) => file.uri === target)) {
      const path = join(base, target);
      try {
        readFileSync(path);
        corpus.files.push({ uri: target, path });
      } catch {
        corpus.missingFiles.push(target);
      }
    }
  }
}

function walkTextFiles(root: string, rootIndex: number, rootCount: number, into: SourceFile[]): void {
  (function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".txt")) {
        const relativePath = relative(root, full).replaceAll("\\", "/");
        into.push({ uri: rootCount > 1 ? `${rootIndex}:${relativePath}` : relativePath, path: full });
      }
    }
  })(root);
}

/** Construit le corpus demande par la ligne de commande, ou `undefined` si les arguments ne suffisent pas. */
export function loadCorpus(cli: CommandLine): Corpus | undefined {
  const entry = cli.value("--entry");
  const serverRoot = cli.value("--server-root");
  const corpus: Corpus = { files: [], missingFiles: [], label: [] };

  if (entry !== undefined || serverRoot !== undefined) {
    if (entry === undefined || serverRoot === undefined) return undefined;
    expandServerConf(entry, serverRoot, new Set(), corpus);
    corpus.label.push(`${serverRoot} :: ${entry}`);
  } else {
    if (cli.positional.length === 0) return undefined;
    cli.positional.forEach((root, rootIndex) => {
      walkTextFiles(root, rootIndex, cli.positional.length, corpus.files);
      corpus.label.push(root);
    });
  }

  const repeat = Math.max(1, Math.floor(Number(cli.value("--repeat")) || 1));
  if (repeat > 1) {
    const original = corpus.files.splice(0);
    for (let copy = 0; copy < repeat; copy += 1) {
      for (const file of original) corpus.files.push({ uri: `copy${copy}/${file.uri}`, path: file.path });
    }
    corpus.label.push(`x${repeat}`);
  }
  return corpus;
}
