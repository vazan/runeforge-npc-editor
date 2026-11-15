/**
 * Mesure de l'analyse semantique sur un corpus reel de scripts (CLAUDE.md 4 : indexer au moins 5 000 scripts ;
 * 16.2 : corpus mesure).
 *
 * Usage : pnpm exec tsx scripts/analysis-report.ts <dossier> [<dossier>...] [--examples N] [--hints] [--json]
 *         node --expose-gc --import tsx scripts/analysis-report.ts <dossier>   (mesure de memoire plus fiable)
 *
 * Lecture seule. Plusieurs dossiers sont indexes ensemble comme un seul projet (les chemins sont prefixes par
 * l'indice du dossier si necessaire). Les fichiers sont decodes en latin1 (1 octet = 1 caractere).
 *
 * Interpretation : sur un corpus qui charge sur un vrai serveur, RA0002/RA0003/RA0012 devraient etre quasi nuls
 * (ce sont des erreurs de chargement ou d'execution) ; chaque occurrence est a examiner comme faux positif ou
 * vraie faute du script. RA0004/RA0005/RA0011 dependent de l'ensemble de fichiers indexes et de l'ordre de chargement
 * (scripts_*.conf, non pris en compte ici).
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { LineIndex } from "@runeforge/runescript-core";
import type { ParseDiagnostic } from "@runeforge/runescript-core";
import { analyzeFile, WorkspaceIndex } from "@runeforge/runescript-analysis";
import { parse } from "@runeforge/runescript-parser";
import { CORPUS_USAGE, loadCorpus, parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--examples"]);
const exampleCount = Number(cli.value("--examples")) || 3;
const asJson = cli.has("--json");
const styleHints = cli.has("--hints");
const corpus = loadCorpus(cli);
if (corpus === undefined) {
  console.error(`Usage : tsx scripts/analysis-report.ts <dossier> [<dossier>...] [--examples N] [--hints] [--json]\n${CORPUS_USAGE}`);
  process.exit(2);
}
const { files, missingFiles } = corpus;

interface Example {
  readonly uri: string;
  readonly line: number;
  readonly message: string;
  readonly excerpt: string;
}

const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const heapBefore = process.memoryUsage().heapUsed;

const index = new WorkspaceIndex();
let bytes = 0;
let parseMs = 0;
let analyzeMs = 0;
let indexMs = 0;
let declarations = 0;
let scopes = 0;
let incompleteScopes = 0;
let labels = 0;
let labelReferences = 0;
let variables = 0;
let functionReferences = 0;
let crashes = 0;
const localByCode = new Map<string, { count: number; files: Set<string>; examples: Example[] }>();

function record(map: typeof localByCode, uri: string, text: string, diagnostic: ParseDiagnostic, lines: () => LineIndex): void {
  const entry = map.get(diagnostic.code) ?? { count: 0, files: new Set<string>(), examples: [] };
  entry.count += 1;
  entry.files.add(uri);
  if (entry.examples.length < exampleCount) {
    const lineIndex = lines();
    const position = lineIndex.positionAt(diagnostic.range.start);
    const lineRange = lineIndex.lineRange(position.line);
    entry.examples.push({
      uri,
      line: position.line + 1,
      message: diagnostic.message,
      excerpt: text.slice(lineRange.start, Math.min(lineRange.end, lineRange.start + 110)).replace(/\r?\n$/, ""),
    });
  }
  map.set(diagnostic.code, entry);
}

for (const file of files) {
  const text = readFileSync(file.path).toString("latin1");
  bytes += text.length;
  try {
    let started = performance.now();
    const parsed = parse(text);
    parseMs += performance.now() - started;

    started = performance.now();
    const analysis = analyzeFile(parsed, file.uri, { styleHints });
    analyzeMs += performance.now() - started;

    started = performance.now();
    index.set(analysis);
    indexMs += performance.now() - started;

    declarations += analysis.declarations.length;
    functionReferences += analysis.functionReferences.length;
    for (const declaration of analysis.declarations) {
      if (declaration.scope === null) continue;
      scopes += 1;
      if (!declaration.scope.complete) incompleteScopes += 1;
      labels += declaration.scope.labels.length;
      labelReferences += declaration.scope.labelReferences.length;
      variables += declaration.scope.variables.length;
    }
    let lines: LineIndex | undefined;
    for (const diagnostic of analysis.diagnostics) {
      record(localByCode, file.uri, text, diagnostic, () => (lines ??= new LineIndex(text)));
    }
  } catch (error) {
    crashes += 1;
    console.error(`CRASH ${file.uri}: ${String(error)}`);
  }
}

gc?.();
const heapAfter = process.memoryUsage().heapUsed;

const crossByCode = new Map<string, { count: number; files: Set<string>; examples: Example[] }>();
const crossStarted = performance.now();
const pathByUri = new Map(files.map((file) => [file.uri, file.path] as const));
for (const uri of index.uris()) {
  const diagnostics = index.crossFileDiagnostics(uri, { reportUnresolved: true });
  if (diagnostics.length === 0) continue;
  // Le texte n'est relu que pour les fichiers qui ont un diagnostic (on ne le garde pas en memoire pendant la mesure).
  const text = readFileSync(pathByUri.get(uri) ?? uri).toString("latin1");
  let lines: LineIndex | undefined;
  for (const diagnostic of diagnostics) {
    record(crossByCode, uri, text, diagnostic, () => (lines ??= new LineIndex(text)));
  }
}
const crossMs = performance.now() - crossStarted;

const megabytes = bytes / 1048576;
const totalSeconds = (parseMs + analyzeMs + indexMs) / 1000;

function formatMap(map: typeof localByCode): Record<string, { count: number; files: number; examples: Example[] }> {
  return Object.fromEntries(
    [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([code, entry]) => [code, { count: entry.count, files: entry.files.size, examples: entry.examples }]),
  );
}

const summary = {
  roots: corpus.label,
  missingFiles,
  files: files.length,
  megabytes: Number(megabytes.toFixed(1)),
  crashes,
  parseSeconds: Number((parseMs / 1000).toFixed(2)),
  analyzeSeconds: Number((analyzeMs / 1000).toFixed(2)),
  indexSeconds: Number((indexMs / 1000).toFixed(2)),
  crossFileSeconds: Number((crossMs / 1000).toFixed(2)),
  analyzeMBps: Number((megabytes / (analyzeMs / 1000)).toFixed(1)),
  totalMBps: Number((megabytes / totalSeconds).toFixed(1)),
  retainedHeapMB: gc === undefined ? null : Number(((heapAfter - heapBefore) / 1048576).toFixed(1)),
  declarations,
  scripts: scopes,
  incompleteScripts: incompleteScopes,
  labels,
  labelReferences,
  localVariables: variables,
  callfuncReferences: functionReferences,
  indexedFunctions: index.functionCount,
  indexedNpcNames: index.npcCount,
  localDiagnostics: formatMap(localByCode),
  crossFileDiagnostics: formatMap(crossByCode),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Corpus : ${summary.roots.join(" + ")}${styleHints ? " (avec suggestions de style)" : ""}`);
  console.log(
    `${summary.files} fichiers, ${summary.megabytes} Mo | plantages : ${crashes}` +
      (missingFiles.length > 0 ? ` | fichiers references mais absents : ${missingFiles.length} (${missingFiles.slice(0, 3).join(", ")}...)` : ""),
  );
  console.log(
    `Temps : parse ${summary.parseSeconds} s, analyse ${summary.analyzeSeconds} s (${summary.analyzeMBps} Mo/s), ` +
      `index ${summary.indexSeconds} s, inter-fichiers ${summary.crossFileSeconds} s | parse+analyse+index : ${summary.totalMBps} Mo/s`,
  );
  console.log(`Memoire conservee par les analyses : ${summary.retainedHeapMB === null ? "non mesuree (lancer avec --expose-gc)" : `${summary.retainedHeapMB} Mo`}`);
  console.log(
    `Symboles : ${declarations} declarations, ${scopes} scripts (${incompleteScopes} incomplets), ${labels} labels, ` +
      `${labelReferences} references de labels, ${variables} variables locales, ${functionReferences} callfunc ; ` +
      `index : ${summary.indexedFunctions} fonctions, ${summary.indexedNpcNames} noms de NPC`,
  );
  for (const [title, group] of [
    ["Diagnostics locaux", summary.localDiagnostics],
    ["Diagnostics inter-fichiers", summary.crossFileDiagnostics],
  ] as const) {
    console.log(`\n=== ${title} ===`);
    const entries = Object.entries(group);
    if (entries.length === 0) console.log("(aucun)");
    for (const [code, entry] of entries) {
      console.log(`\n${code} x${entry.count} dans ${entry.files} fichier(s)`);
      for (const example of entry.examples) {
        console.log(`  ${example.uri}:${example.line}  ${example.message}\n    | ${example.excerpt}`);
      }
    }
  }
}
