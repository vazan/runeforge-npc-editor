/**
 * Mesure et verification du service de langage sur un corpus reel (navigation, recherche de symboles, latences).
 *
 * Usage : pnpm exec tsx scripts/language-report.ts --server-root <racine> --entry npc/re/scripts_main.conf [--json]
 *         pnpm exec tsx scripts/language-report.ts <dossier> [...]
 *         node --expose-gc --import tsx scripts/language-report.ts ...   (mesure de memoire plus fiable)
 *
 * Lecture seule. Les verifications utilisent un **oracle independant de l'analyseur** (expressions regulieres sur le
 * texte brut) : chaque `callfunc "Nom"` et chaque `goto Label;` du corpus est interroge par `definition` et le resultat
 * est compare a ce que l'oracle attend. Sur un corpus qui charge sur un vrai serveur, les labels doivent tous se resoudre ;
 * les fonctions non resolues doivent correspondre exactement aux diagnostics `RA0004`.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { LineIndex, normalizeToLf, tokenize } from "@runeforge/runescript-core";
import { LanguageServer } from "@runeforge/runescript-language-server";
import type { DocumentSymbol, TextEdit } from "@runeforge/runescript-language-server";
import { CORPUS_USAGE, loadCorpus, parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2));
const asJson = cli.has("--json");
const corpus = loadCorpus(cli);
if (corpus === undefined) {
  console.error(`Usage : tsx scripts/language-report.ts <dossier>... | --server-root <racine> --entry <conf> [--json]\n${CORPUS_USAGE}`);
  process.exit(2);
}
const { files } = corpus;

const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const heapBefore = process.memoryUsage().heapUsed;

const server = new LanguageServer();
server.setOptions({ crossFile: "all" });

// --- Indexation ---------------------------------------------------------------------------------------------------
let bytes = 0;
const indexStarted = performance.now();
for (const file of files) {
  const text = readFileSync(file.path).toString("latin1");
  bytes += text.length;
  server.indexText(file.uri, text);
}
const indexMs = performance.now() - indexStarted;
gc?.();
const heapAfter = process.memoryUsage().heapUsed;
const stats = server.stats();

// --- Rapport de projet (diagnostics) ------------------------------------------------------------------------------
const reportStarted = performance.now();
const projectReport = server.projectDiagnostics();
const reportMs = performance.now() - reportStarted;
const diagnosticsByCode = new Map<string, number>();
for (const entry of projectReport) for (const d of entry.diagnostics) diagnosticsByCode.set(d.code, (diagnosticsByCode.get(d.code) ?? 0) + 1);
const unresolvedByDiagnostic = new Set<string>();
for (const entry of projectReport) {
  for (const d of entry.diagnostics) if (d.code === "RA0004") unresolvedByDiagnostic.add(`${entry.uri}:${String(d.params?.name)}`);
}

// --- Navigation : oracle regex ------------------------------------------------------------------------------------
const CALLFUNC = /callfunc\s*\(?\s*"([^"\r\n]+)"/gi;
const GOTO = /\bgoto\s+([A-Za-z0-9_]+)\s*;/gi;

/**
 * Plages des commentaires d'un texte (reperees par le lexer, seule partie de l'analyseur que l'oracle utilise) : le
 * code mis en commentaire (`// callfunc "F_Rand"`, `/* goto L_X; *\/`) n'est pas du code et ne doit pas etre interroge.
 */
function commentRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const token of tokenize(text)) {
    if (token.kind === "LineComment" || token.kind === "BlockComment") ranges.push(token.range);
  }
  return ranges;
}

function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const index = new LineIndex(text);
  const absolute = edits.map((edit) => ({ start: index.offsetAt(edit.range.start, text), end: index.offsetAt(edit.range.end, text), text: edit.newText }));
  let result = text;
  for (const edit of absolute.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function labelPositions(symbols: readonly DocumentSymbol[], found: { line: number; character: number }[] = []): { line: number; character: number }[] {
  for (const symbol of symbols) {
    if (symbol.kind === 8) found.push(symbol.selectionRange.start); // SymbolKind.Field = label
    labelPositions(symbol.children, found);
  }
  return found;
}

function isInComment(ranges: readonly { start: number; end: number }[], offset: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (range === undefined) return false;
    if (offset < range.start) high = mid - 1;
    else if (offset >= range.end) low = mid + 1;
    else return true;
  }
  return false;
}

interface Tally {
  checked: number;
  resolved: number;
  unresolved: number;
  multiple: number;
  wrongFile: number;
  failures: string[];
}
const callfuncTally: Tally = { checked: 0, resolved: 0, unresolved: 0, multiple: 0, wrongFile: 0, failures: [] };
const gotoTally: Tally = { checked: 0, resolved: 0, unresolved: 0, multiple: 0, wrongFile: 0, failures: [] };
const unresolvedByOracle = new Set<string>();
const latencies: number[] = [];
let largestFile = { uri: "", lines: 0 };
/** Completion : au point d'un `callfunc "Nom"` (3 premieres lettres saisies) et d'un `goto Label;` (rien saisi). */
const completionTally = { callfunc: { checked: 0, found: 0 }, goto: { checked: 0, found: 0 }, failures: [] as string[] };
const hoverTally = { checked: 0, informative: 0 };
/** Renommage : sur un echantillon de labels et de variables locales, le script renomme ne doit produire aucun diagnostic nouveau. */
const renameTally = { attempted: 0, applied: 0, refused: {} as Record<string, number>, regressions: [] as string[] };
const probe = new LanguageServer();
const completionLatencies: number[] = [];
const hoverLatencies: number[] = [];

for (const file of files) {
  const raw = readFileSync(file.path).toString("latin1");
  const text = normalizeToLf(raw);
  const lines = new LineIndex(text);
  if (lines.lineCount > largestFile.lines) largestFile = { uri: file.uri, lines: lines.lineCount };
  server.updateDocument(file.uri, 1, text);
  const comments = commentRanges(text);

  for (const match of text.matchAll(CALLFUNC)) {
    if (isInComment(comments, match.index ?? 0)) continue;
    const name = match[1] ?? "";
    const at = (match.index ?? 0) + match[0].lastIndexOf(name);
    const started = performance.now();
    const found = server.definition(file.uri, lines.positionAt(at + 1));
    latencies.push(performance.now() - started);
    callfuncTally.checked += 1;
    if (found.length === 0) {
      callfuncTally.unresolved += 1;
      unresolvedByOracle.add(`${file.uri}:${name}`);
    } else {
      callfuncTally.resolved += 1;
      if (found.length > 1) callfuncTally.multiple += 1;
      let measured = performance.now();
      const proposals = server.completion(file.uri, lines.positionAt(at + Math.min(3, name.length)));
      completionLatencies.push(performance.now() - measured);
      completionTally.callfunc.checked += 1;
      if (proposals.some((item) => item.label === name)) completionTally.callfunc.found += 1;
      else if (completionTally.failures.length < 5) completionTally.failures.push(`${file.uri}:${lines.positionAt(at).line + 1} callfunc "${name}"`);
      measured = performance.now();
      const hovered = server.hover(file.uri, lines.positionAt(at + 1));
      hoverLatencies.push(performance.now() - measured);
      hoverTally.checked += 1;
      if (hovered?.kind === "function" && hovered.definitions.length > 0) hoverTally.informative += 1;
    }
  }

  for (const match of text.matchAll(GOTO)) {
    if (isInComment(comments, match.index ?? 0)) continue;
    const name = match[1] ?? "";
    const at = (match.index ?? 0) + match[0].indexOf(name, 4);
    const started = performance.now();
    const found = server.definition(file.uri, lines.positionAt(at + 1));
    latencies.push(performance.now() - started);
    gotoTally.checked += 1;
    if (found.length === 0) {
      gotoTally.unresolved += 1;
      if (gotoTally.failures.length < 5) gotoTally.failures.push(`${file.uri}:${lines.positionAt(at).line + 1} goto ${name}`);
    } else {
      gotoTally.resolved += 1;
      if (found.length > 1) gotoTally.multiple += 1;
      if (found.some((location) => location.uri !== file.uri)) gotoTally.wrongFile += 1;
      let measured = performance.now();
      const proposals = server.completion(file.uri, lines.positionAt(at));
      completionLatencies.push(performance.now() - measured);
      completionTally.goto.checked += 1;
      if (proposals.some((item) => item.label.toLowerCase() === name.toLowerCase())) completionTally.goto.found += 1;
      else if (completionTally.failures.length < 5) completionTally.failures.push(`${file.uri}:${lines.positionAt(at).line + 1} goto ${name}`);
      measured = performance.now();
      const hovered = server.hover(file.uri, lines.positionAt(at + 1));
      hoverLatencies.push(performance.now() - measured);
      hoverTally.checked += 1;
      if (hovered?.kind === "label" && hovered.defined) hoverTally.informative += 1;
    }
  }

  // Renommage : au plus 3 labels et 2 variables locales par fichier.
  const sample: { line: number; character: number; newName: string }[] = labelPositions(server.documentSymbols(file.uri))
    .slice(0, 3)
    .map((position) => ({ ...position, newName: "RF_Renamed" }));
  let variables = 0;
  for (const match of text.matchAll(/.@[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (variables >= 2) break;
    if (isInComment(comments, match.index ?? 0)) continue;
    const position = lines.positionAt((match.index ?? 0) + 3);
    sample.push({ ...position, newName: "rfrenamed" });
    variables += 1;
  }
  probe.updateDocument(file.uri, 1, text);
  const baseline = probe.diagnostics(file.uri).map((d) => d.code).sort().join();
  for (const entry of sample) {
    renameTally.attempted += 1;
    const result = server.rename(file.uri, entry, entry.newName);
    if (!result.ok) {
      renameTally.refused[result.reason] = (renameTally.refused[result.reason] ?? 0) + 1;
      continue;
    }
    renameTally.applied += 1;
    probe.updateDocument(file.uri, renameTally.applied + 1, applyEdits(text, result.edits));
    const after = probe.diagnostics(file.uri).map((d) => d.code).sort().join();
    if (after !== baseline && renameTally.regressions.length < 5) renameTally.regressions.push(`${file.uri}:${entry.line + 1} (${baseline} -> ${after})`);
    probe.updateDocument(file.uri, renameTally.applied + 1000000, text);
  }
  server.closeDocument(file.uri);
}

const oracleAgrees =
  unresolvedByOracle.size === unresolvedByDiagnostic.size && [...unresolvedByOracle].every((entry) => unresolvedByDiagnostic.has(entry));

// --- Latences des requetes -----------------------------------------------------------------------------------------
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

function time<T>(run: () => T, repeat: number): { result: T; medianMs: number; maxMs: number } {
  const samples: number[] = [];
  let result = run();
  for (let i = 0; i < repeat; i += 1) {
    const started = performance.now();
    result = run();
    samples.push(performance.now() - started);
  }
  return { result, medianMs: percentile(samples, 0.5), maxMs: Math.max(...samples) };
}

const symbolQueries = ["kafra", "heal", "F_", "prontera", "zzzz", "K"].map((query) => {
  const measured = time(() => server.workspaceSymbols(query, 100), 20);
  return { query, hits: measured.result.length, medianMs: measured.medianMs, maxMs: measured.maxMs };
});
const outline = time(() => server.documentSymbols(largestFile.uri), 20);

// Reference d'une fonction tres appelee : on ouvre un fichier qui l'appelle.
const callCounts = new Map<string, { count: number; uri: string }>();
for (const file of files) {
  const text = readFileSync(file.path).toString("latin1");
  const comments = commentRanges(text);
  for (const match of text.matchAll(CALLFUNC)) {
    if (isInComment(comments, match.index ?? 0)) continue;
    const name = match[1] ?? "";
    const entry = callCounts.get(name);
    callCounts.set(name, { count: (entry?.count ?? 0) + 1, uri: entry?.uri ?? file.uri });
  }
}
const [topName, top] = [...callCounts.entries()].sort((a, b) => b[1].count - a[1].count)[0] ?? ["", { count: 0, uri: "" }];
let topReferences = { name: topName, expected: top.count, found: 0, medianMs: 0, maxMs: 0 };
if (top.uri !== "") {
  const file = files.find((candidate) => candidate.uri === top.uri);
  if (file !== undefined) {
    const text = normalizeToLf(readFileSync(file.path).toString("latin1"));
    const lines = new LineIndex(text);
    server.updateDocument(file.uri, 2, text);
    const at = text.search(new RegExp(`callfunc\\s*\\(?\\s*"${topName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i"));
    const position = lines.positionAt(text.indexOf(topName, at) + 1);
    const measured = time(() => server.references(file.uri, position, false), 20);
    topReferences = { name: topName, expected: top.count, found: measured.result.length, medianMs: measured.medianMs, maxMs: measured.maxMs };
    server.closeDocument(file.uri);
  }
}

const megabytes = bytes / 1048576;
const summary = {
  corpus: corpus.label,
  files: files.length,
  megabytes: Number(megabytes.toFixed(1)),
  indexSeconds: Number((indexMs / 1000).toFixed(2)),
  indexMBps: Number((megabytes / (indexMs / 1000)).toFixed(1)),
  retainedHeapMB: gc === undefined ? null : Number(((heapAfter - heapBefore) / 1048576).toFixed(1)),
  stats,
  projectReport: { seconds: Number((reportMs / 1000).toFixed(3)), filesWithDiagnostics: projectReport.length, byCode: Object.fromEntries(diagnosticsByCode) },
  callfunc: callfuncTally,
  goto: gotoTally,
  unresolvedMatchDiagnostics: oracleAgrees,
  rename: renameTally,
  completion: {
    ...completionTally,
    calls: completionLatencies.length,
    p50: Number(percentile(completionLatencies, 0.5).toFixed(3)),
    p99: Number(percentile(completionLatencies, 0.99).toFixed(3)),
    max: Number(Math.max(0, ...completionLatencies).toFixed(3)),
  },
  hover: {
    ...hoverTally,
    p50: Number(percentile(hoverLatencies, 0.5).toFixed(3)),
    p99: Number(percentile(hoverLatencies, 0.99).toFixed(3)),
  },
  definitionLatencyMs: {
    calls: latencies.length,
    p50: Number(percentile(latencies, 0.5).toFixed(3)),
    p95: Number(percentile(latencies, 0.95).toFixed(3)),
    p99: Number(percentile(latencies, 0.99).toFixed(3)),
    max: Number(Math.max(0, ...latencies).toFixed(3)),
  },
  outline: { file: largestFile.uri, lines: largestFile.lines, medianMs: Number(outline.medianMs.toFixed(3)), maxMs: Number(outline.maxMs.toFixed(3)), symbols: outline.result.length },
  workspaceSymbols: symbolQueries.map((q) => ({ ...q, medianMs: Number(q.medianMs.toFixed(3)), maxMs: Number(q.maxMs.toFixed(3)) })),
  mostCalledFunction: { ...topReferences, medianMs: Number(topReferences.medianMs.toFixed(3)), maxMs: Number(topReferences.maxMs.toFixed(3)) },
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Corpus : ${summary.corpus.join(" + ")}`);
  console.log(`${summary.files} fichiers, ${summary.megabytes} Mo | index : ${summary.stats.functions} fonctions, ${summary.stats.npcs} noms de NPC`);
  console.log(
    `Indexation (parse + analyse + index + table de lignes) : ${summary.indexSeconds} s (${summary.indexMBps} Mo/s) | memoire conservee : ${
      summary.retainedHeapMB === null ? "non mesuree (--expose-gc)" : `${summary.retainedHeapMB} Mo`
    }`,
  );
  console.log(
    `Rapport de projet : ${summary.projectReport.seconds} s, ${summary.projectReport.filesWithDiagnostics} fichier(s) avec diagnostics ${JSON.stringify(summary.projectReport.byCode)}`,
  );
  const line = (title: string, t: Tally): string =>
    `${title} : ${t.checked} interroges, ${t.resolved} resolus (${t.multiple} multiples), ${t.unresolved} sans resultat, ${t.wrongFile} hors fichier`;
  console.log(line("Definition de callfunc", callfuncTally));
  console.log(`  non resolus == diagnostics RA0004 : ${oracleAgrees ? "OUI" : "NON"} (${[...unresolvedByOracle].join(", ") || "aucun"})`);
  console.log(line("Definition de goto    ", gotoTally));
  if (gotoTally.failures.length > 0) console.log(`  exemples sans resultat : ${gotoTally.failures.join(" | ")}`);
  const r = summary.rename;
  console.log(
    `Renommage (echantillon : 3 labels + 2 variables locales par fichier) : ${r.attempted} essais, ${r.applied} appliques, refus ${JSON.stringify(r.refused)}, ` +
      `nouveaux diagnostics apres renommage : ${r.regressions.length}`,
  );
  if (r.regressions.length > 0) console.log(`  regressions : ${r.regressions.join(" | ")}`);
  const c = summary.completion;
  console.log(
    `Completion : callfunc ${c.callfunc.found}/${c.callfunc.checked} (3 lettres saisies), goto ${c.goto.found}/${c.goto.checked} (rien saisi) ; ` +
      `latence p50 ${c.p50} ms, p99 ${c.p99} ms, max ${c.max} ms`,
  );
  if (c.failures.length > 0) console.log(`  absents des propositions : ${c.failures.join(" | ")}`);
  console.log(`Survol : ${summary.hover.informative}/${summary.hover.checked} informatifs ; latence p50 ${summary.hover.p50} ms, p99 ${summary.hover.p99} ms`);
  const d = summary.definitionLatencyMs;
  console.log(`Latence de definition (${d.calls} appels, fichier ouvert) : p50 ${d.p50} ms, p95 ${d.p95} ms, p99 ${d.p99} ms, max ${d.max} ms`);
  console.log(`Plan du plus gros fichier (${summary.outline.file}, ${summary.outline.lines} lignes, ${summary.outline.symbols} symboles) : mediane ${summary.outline.medianMs} ms`);
  for (const q of summary.workspaceSymbols) console.log(`Recherche de symboles "${q.query}" : ${q.hits} resultat(s), mediane ${q.medianMs} ms, max ${q.maxMs} ms`);
  const m = summary.mostCalledFunction;
  console.log(`References de ${m.name} : ${m.found} trouvees / ${m.expected} attendues (oracle), mediane ${m.medianMs} ms`);
}
