/**
 * Rapport de projet (RF-015) sur un serveur rAthena reel : exactitude, completude, positions, temps et volume.
 *
 * Usage : pnpm exec tsx scripts/project-report.ts --server-root <racine du serveur> [--json]
 *
 * Lecture seule. Trois scenarios, tous avec le registre de commandes et le catalogue de references du serveur :
 * - **A. scripts charges** (ce que l'application indexe avec la portee « scripts charges ») : le rapport doit contenir
 *   exactement les fichiers dont `diagnostics(uri)` n'est pas vide, avec les memes diagnostics, des totaux exacts et des
 *   positions (ligne, colonne) justes — verifiees par un calcul independant sur le texte brut (CRLF, LF, CR) ;
 * - **B. tout `npc/`** (variantes `re/` et `pre-re/` ensemble) : un rapport volumineux naturel (faux doublons de noms) ;
 * - **C. volume** : le jeu A replique plusieurs fois sous des chemins distincts jusqu'a depasser la limite de detail du
 *   rapport : les totaux doivent rester exacts, le detail coupe, et le temps et le volume transferts au worker mesures ;
 * - **D. tout le serveur** (tous les `.txt`, la portee d'index par defaut) : documentation, bases et fichiers de configuration sont
 *   indexes comme des scripts ; le rapport montre ce que la restriction aux scripts charges (`scopeReport`) en retire.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join, relative } from "node:path";
import { buildRathenaCatalog, buildRathenaRegistry, collectRathenaDatabaseSources, detectRenewal, RATHENA_PATHS, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import { LanguageServer, MAX_REPORT_ITEMS } from "@runeforge/runescript-language-server";
import type { ProjectReport } from "@runeforge/runescript-language-server";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2));
const asJson = cli.has("--json");
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : pnpm exec tsx scripts/project-report.ts --server-root <racine du serveur> [--json]");
  process.exit(2);
}
const serverRoot: string = root;

const readBytes = (relativePath: string): Buffer | null => {
  const path = join(serverRoot, relativePath);
  return existsSync(path) ? readFileSync(path) : null;
};
const readText = (relativePath: string): string | null => readBytes(relativePath)?.toString("latin1") ?? null;

const registry = buildRathenaRegistry({
  builtinSource: readText(RATHENA_PATHS.builtinSource),
  customBuiltins: readText(RATHENA_PATHS.customBuiltins),
  commandDoc: readText(RATHENA_PATHS.commandDoc),
}).registry;
if (registry === null) {
  console.error("Aucun registre de commandes dans ce serveur.");
  process.exit(2);
}
const renewal = detectRenewal(readText(RATHENA_PATHS.renewalHeader)).renewal;
const { sources } = await collectRathenaDatabaseSources({ readBytes: (paths) => Promise.resolve(paths.map(readBytes)) }, renewal, RATHENA_PATHS);
const decode = (file: { path: string; bytes: Uint8Array }): { path: string; text: string } => ({ path: file.path, text: new TextDecoder().decode(file.bytes) });
const catalog = buildRathenaCatalog({
  items: sources.items.map(decode),
  mobs: sources.mobs.map(decode),
  constantsYaml: sources.constantsYaml.map(decode),
  constantsSource: sources.constantsSource === null ? null : decode(sources.constantsSource),
  mapIndex: sources.mapIndex.map(decode),
}).catalog;

const load = await resolveRathenaScripts(
  {
    readText: (path) => Promise.resolve(readText(path)),
    existingFiles: (paths) =>
      Promise.resolve(
        new Set(
          paths.filter((path) => {
            try {
              return statSync(join(serverRoot, path)).isFile();
            } catch {
              return false;
            }
          }),
        ),
      ),
  },
  renewal,
);

interface Source {
  readonly uri: string;
  readonly text: string;
}

function readAll(paths: readonly string[]): Source[] {
  const result: Source[] = [];
  for (const path of paths) {
    const text = readText(path);
    if (text !== null) result.push({ uri: path, text });
  }
  return result;
}

function walk(directory: string, found: string[]): string[] {
  for (const entry of readdirSync(join(serverRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(path, found);
    else if (entry.name.toLowerCase().endsWith(".txt")) found.push(path);
  }
  return found;
}

function newServer(): LanguageServer {
  const server = new LanguageServer();
  server.setOptions({ crossFile: "all", unknownCommands: "warning", unknownReferences: "info", emulator: "rathena" });
  server.setCommandRegistry(registry);
  if (catalog !== null) server.setReferenceCatalog(catalog);
  return server;
}

/** Ligne et colonne (base 1) d'un decalage, par un calcul independant du service : on compte les fins de ligne `\r\n`, `\r` et `\n`. */
function lineColumnOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const breaks = /\r\n|\r|\n/g;
  for (let match = breaks.exec(text); match !== null && match.index < offset; match = breaks.exec(text)) {
    const end = match.index + match[0].length;
    if (end > offset) break; // le decalage tombe entre le \r et le \n d'une fin de ligne \r\n
    line += 1;
    lineStart = end;
  }
  return { line, column: offset - lineStart + 1 };
}

interface Outcome {
  readonly name: string;
  readonly files: number;
  readonly examined: number;
  readonly withProblems: number;
  readonly totals: ProjectReport["totals"];
  readonly byCode: Record<string, number>;
  readonly truncated: boolean;
  readonly keptItems: number;
  readonly reportMs: { readonly median: number; readonly max: number };
  readonly payload: { readonly jsonKiB: number; readonly cloneMs: number };
  readonly failures: string[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function run(name: string, sourcesToIndex: readonly Source[], verifyPositions: boolean): Outcome {
  const server = newServer();
  for (const source of sourcesToIndex) server.indexText(source.uri, source.text);

  const times: number[] = [];
  let report = server.projectReport();
  for (let i = 0; i < 7; i += 1) {
    const started = performance.now();
    report = server.projectReport();
    times.push(performance.now() - started);
  }
  const failures: string[] = [];

  // Completude et exactitude : memes fichiers, memes diagnostics que diagnostics(uri), totaux exacts.
  const expected = new Map<string, number>();
  const sums = { errors: 0, warnings: 0, infos: 0 };
  const codeSums = new Map<string, number>();
  for (const source of sourcesToIndex) {
    const diagnostics = server.diagnostics(source.uri);
    if (diagnostics.length > 0) expected.set(source.uri, diagnostics.length);
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "error") sums.errors += 1;
      else if (diagnostic.severity === "warning") sums.warnings += 1;
      else sums.infos += 1;
      codeSums.set(diagnostic.code, (codeSums.get(diagnostic.code) ?? 0) + 1);
    }
  }
  if (report.examined !== sourcesToIndex.length) failures.push(`examined ${report.examined} au lieu de ${sourcesToIndex.length}`);
  if (report.files.length !== expected.size) failures.push(`${report.files.length} fichiers au rapport, ${expected.size} attendus`);
  for (const key of ["errors", "warnings", "infos"] as const) if (report.totals[key] !== sums[key]) failures.push(`total ${key} : ${report.totals[key]} au lieu de ${sums[key]}`);
  for (const entry of report.byCode) if (entry.count !== codeSums.get(entry.code)) failures.push(`code ${entry.code} : ${entry.count} au lieu de ${codeSums.get(entry.code) ?? 0}`);
  if (report.byCode.length !== codeSums.size) failures.push(`${report.byCode.length} codes au lieu de ${codeSums.size}`);

  const textOf = new Map(sourcesToIndex.map((source) => [source.uri, source.text]));
  let kept = 0;
  let previous: (typeof report.files)[number] | undefined;
  for (const file of report.files) {
    if (file.errors + file.warnings + file.infos !== expected.get(file.uri)) failures.push(`${file.uri} : totaux du fichier faux`);
    kept += file.items.length;
    if (!report.truncated && file.items.length !== expected.get(file.uri)) failures.push(`${file.uri} : detail incomplet sans troncature`);
    if (!report.truncated) {
      const diagnostics = server.diagnostics(file.uri);
      if (JSON.stringify(file.items.map((item) => item.diagnostic)) !== JSON.stringify(diagnostics)) failures.push(`${file.uri} : diagnostics differents de diagnostics(uri)`);
    }
    if (previous !== undefined) {
      const order = previous.errors - file.errors || previous.warnings - file.warnings || previous.infos - file.infos;
      if (order < 0 || (order === 0 && previous.uri >= file.uri)) failures.push(`ordre faux entre ${previous.uri} et ${file.uri}`);
    }
    previous = file;
    if (verifyPositions) {
      const text = textOf.get(file.uri);
      if (text === undefined) continue;
      for (const item of file.items) {
        const oracle = lineColumnOf(text, item.diagnostic.range.start);
        if (oracle.line !== item.line || oracle.column !== item.column) {
          failures.push(`${file.uri} : position ${item.line}:${item.column} au lieu de ${oracle.line}:${oracle.column} (${item.diagnostic.code})`);
          break;
        }
      }
    }
  }
  if (report.truncated && kept !== MAX_REPORT_ITEMS) failures.push(`detail coupe a ${kept} au lieu de ${MAX_REPORT_ITEMS}`);
  if (report.truncated && sums.errors + sums.warnings + sums.infos <= MAX_REPORT_ITEMS) failures.push("rapport marque coupe alors que la limite n'est pas atteinte");
  if (!report.truncated && sums.errors + sums.warnings + sums.infos > MAX_REPORT_ITEMS) failures.push("limite depassee sans troncature");

  // Volume transfere au worker : taille du JSON et cout d'un clonage structure (postMessage).
  const jsonKiB = Math.round(JSON.stringify(report).length / 1024);
  const cloneStarted = performance.now();
  structuredClone(report);
  const cloneMs = performance.now() - cloneStarted;

  const byCode: Record<string, number> = {};
  for (const entry of report.byCode) byCode[entry.code] = entry.count;
  return {
    name,
    files: sourcesToIndex.length,
    examined: report.examined,
    withProblems: report.files.length,
    totals: report.totals,
    byCode,
    truncated: report.truncated,
    keptItems: kept,
    reportMs: { median: median(times), max: Math.max(...times) },
    payload: { jsonKiB, cloneMs },
    failures,
  };
}

const loaded = readAll(load.files);
const everything = readAll(walk("npc", []).sort());

/** Le jeu A replique sous des chemins distincts jusqu'a depasser nettement la limite de detail. */
function replicate(sourcesToCopy: readonly Source[], copies: number): Source[] {
  const result: Source[] = [];
  for (let copy = 0; copy < copies; copy += 1) for (const source of sourcesToCopy) result.push({ uri: `copie${copy}/${source.uri}`, text: source.text });
  return result;
}

/** Tous les `.txt` du serveur (hors dossiers de dependances), comme le fait la portee d'index par defaut. */
function walkAll(directory: string, found: string[]): string[] {
  for (const entry of readdirSync(join(serverRoot, directory), { withFileTypes: true })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git") walkAll(path, found);
    } else if (entry.name.toLowerCase().endsWith(".txt")) found.push(path);
  }
  return found;
}

interface ScopeOutcome {
  readonly indexed: number;
  readonly loaded: number;
  readonly notLoaded: number;
  readonly raw: { files: number; totals: ProjectReport["totals"]; truncated: boolean; keptItems: number };
  readonly scoped: { files: number; totals: ProjectReport["totals"]; byCode: Record<string, number>; examined: number; truncated: boolean; keptItems: number };
  readonly excluded: { examined: number; files: number; problems: number };
  readonly failures: string[];
}

function runScope(): ScopeOutcome {
  const all = readAll(walkAll("", []).sort());
  const server = newServer();
  for (const source of all) server.indexText(source.uri, source.text);
  const loadedSet = new Set(load.files);
  const notLoaded = all.filter((source) => !loadedSet.has(source.uri)).length;
  const raw = server.projectReport();
  const scoped = server.projectReport({ only: [...loadedSet] });
  const failures: string[] = [];
  const kept = (r: ProjectReport): number => r.files.reduce((sum, file) => sum + file.items.length, 0);

  // Reference independante : les diagnostics de chaque fichier, additionnes a la main.
  const sums = { errors: 0, warnings: 0, infos: 0 };
  const codeSums = new Map<string, number>();
  let outsideProblems = 0;
  let outsideFiles = 0;
  for (const source of all) {
    const diagnostics = server.diagnostics(source.uri);
    if (!loadedSet.has(source.uri)) {
      if (diagnostics.length > 0) outsideFiles += 1;
      outsideProblems += diagnostics.length;
      continue;
    }
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "error") sums.errors += 1;
      else if (diagnostic.severity === "warning") sums.warnings += 1;
      else sums.infos += 1;
      codeSums.set(diagnostic.code, (codeSums.get(diagnostic.code) ?? 0) + 1);
    }
  }
  for (const key of ["errors", "warnings", "infos"] as const) if (scoped.totals[key] !== sums[key]) failures.push(`total ${key} restreint : ${scoped.totals[key]} au lieu de ${sums[key]}`);
  for (const entry of scoped.byCode) if (entry.count !== codeSums.get(entry.code)) failures.push(`code ${entry.code} restreint : ${entry.count} au lieu de ${codeSums.get(entry.code) ?? 0}`);
  if (scoped.byCode.length !== codeSums.size) failures.push("codes restreints : nombre de codes different");
  if (scoped.examined !== all.length - notLoaded) failures.push(`fichiers examines apres restriction : ${scoped.examined} au lieu de ${all.length - notLoaded}`);
  if (scoped.excluded?.examined !== notLoaded || scoped.excluded?.problems !== outsideProblems || scoped.excluded?.files !== outsideFiles) {
    failures.push(`fichiers laisses de cote : ${JSON.stringify(scoped.excluded)} au lieu de ${JSON.stringify({ examined: notLoaded, files: outsideFiles, problems: outsideProblems })}`);
  }
  if (scoped.files.some((file) => !loadedSet.has(file.uri))) failures.push("un fichier non charge figure au rapport restreint");
  // La restriction ne depend pas de la limite : le detail des vrais problemes est complet (il l'est quand leur nombre est sous la limite).
  const scopedTotal = sums.errors + sums.warnings + sums.infos;
  if (scopedTotal <= MAX_REPORT_ITEMS && (scoped.truncated || kept(scoped) !== scopedTotal)) failures.push("detail du rapport restreint incomplet alors qu'il tient dans la limite");
  // Sans restriction, le meme bruit peut epuiser la limite : c'est ce que la restriction evite.
  if (raw.excluded !== null) failures.push("rapport complet avec `excluded`");
  if (raw.examined !== all.length) failures.push("fichiers examines du rapport complet faux");
  return {
    indexed: all.length,
    loaded: loadedSet.size,
    notLoaded,
    raw: { files: raw.files.length, totals: raw.totals, truncated: raw.truncated, keptItems: kept(raw) },
    scoped: { files: scoped.files.length, totals: scoped.totals, byCode: Object.fromEntries(scoped.byCode.map((entry) => [entry.code, entry.count])), examined: scoped.examined, truncated: scoped.truncated, keptItems: kept(scoped) },
    excluded: scoped.excluded ?? { examined: 0, files: 0, problems: 0 },
    failures,
  };
}

const scopeOutcome = runScope();
const outcomes = [run("A. scripts charges", loaded, true), run("B. tout npc/ (re et pre-re)", everything, true), run("C. volume (jeu A x 6)", replicate(loaded, 6), true)];

if (asJson) {
  console.log(JSON.stringify({ outcomes, scope: scopeOutcome }, null, 2));
} else {
  console.log(`Serveur : ${relative(process.cwd(), serverRoot) || serverRoot} | mode ${renewal ? "renewal" : "pre-renewal"} | registre ${registry.stats().total} commandes | catalogue ${JSON.stringify(catalog?.stats() ?? null)}`);
  for (const outcome of outcomes) {
    console.log(`\n${outcome.name} : ${outcome.files} fichiers indexes`);
    console.log(`  rapport : ${outcome.withProblems} fichier(s) avec problemes | erreurs ${outcome.totals.errors}, avertissements ${outcome.totals.warnings}, informations ${outcome.totals.infos} | ${outcome.truncated ? `detail coupe a ${outcome.keptItems}` : `${outcome.keptItems} problemes detailles`}`);
    console.log(`  codes : ${JSON.stringify(outcome.byCode)}`);
    console.log(`  temps du calcul : mediane ${outcome.reportMs.median.toFixed(2)} ms, max ${outcome.reportMs.max.toFixed(2)} ms | volume transfere : ${outcome.payload.jsonKiB} Kio de JSON, clonage ${outcome.payload.cloneMs.toFixed(1)} ms`);
    console.log(outcome.failures.length === 0 ? "  verifications : completude, diagnostics identiques a diagnostics(uri), totaux exacts, ordre, positions : OK" : `  ECHECS (${outcome.failures.length}) :\n    ${outcome.failures.slice(0, 10).join("\n    ")}`);
  }
}
if (!asJson) {
  const o = scopeOutcome;
  console.log(`\nD. tout le serveur (tous les .txt, portee par defaut) : ${o.indexed} fichiers indexes, dont ${o.loaded} charges par le serveur et ${o.notLoaded} qui ne le sont pas`);
  console.log(`  rapport complet : ${o.raw.files} fichier(s) avec problemes | erreurs ${o.raw.totals.errors}, avertissements ${o.raw.totals.warnings}, informations ${o.raw.totals.infos} | ${o.raw.truncated ? `detail coupe a ${o.raw.keptItems}` : `${o.raw.keptItems} problemes detailles`}`);
  console.log(`  restreint aux scripts charges (\`only\`) : ${o.scoped.files} fichier(s) | erreurs ${o.scoped.totals.errors}, avertissements ${o.scoped.totals.warnings}, informations ${o.scoped.totals.infos} | ${o.scoped.examined} fichiers examines | ${o.scoped.truncated ? `detail coupe a ${o.scoped.keptItems}` : `${o.scoped.keptItems} problemes detailles`}`);
  console.log(`  codes (restreint) : ${JSON.stringify(o.scoped.byCode)}`);
  console.log(`  laisses de cote : ${o.excluded.examined} fichiers indexes, dont ${o.excluded.files} avec ${o.excluded.problems} problemes`);
  console.log(o.failures.length === 0 ? "  verifications : totaux, codes, fichiers examines et fichiers laisses de cote = somme independante des diagnostics(uri), detail complet : OK" : `  ECHECS : ${o.failures.join(" ; ")}`);
}
process.exit(outcomes.some((outcome) => outcome.failures.length > 0) || scopeOutcome.failures.length > 0 ? 1 : 0);
