/**
 * Ordre de chargement et fonctions appelees par leur nom (M4-S3c, `RA0016`) sur un serveur rAthena reel.
 *
 * Usage : node --import tsx scripts/order-report.ts --server-root <racine du serveur> [--shuffles N] [--seed N]
 *
 * Lecture seule. `parse_callfunc` (`script.cpp`) n'accepte `Nom arg;` que si `Nom` est une commande, une fonction locale ou une
 * fonction globale deja enregistree dans `userfunc_db`, ce que `npc_parse_function` (`npc.cpp`) fait **apres** l'analyse du corps :
 * une fonction n'existe que pour ce qui est analyse apres elle. Quatre verifications, contre un **oracle independant** (lecture du
 * texte brut : commentaires et chaines effaces, `function<TAB>script<TAB>Nom<TAB>{` retrouves par expression reguliere, fin de la
 * fonction par comptage des accolades, appels retrouves par leurs mots), pas contre le parseur :
 * 1. **Serveur tel quel** : les scripts que le serveur charge se chargent sans cette erreur ; aucun `RA0016` n'est attendu, et le
 *    nombre d'appels par nom que l'oracle trouve est celui que l'analyse trouve ;
 * 2. **Ordres mutes** : chaque fichier qui definit une fonction est charge en dernier, puis retire de la liste ; l'ordre inverse ; des
 *    melanges : l'ensemble exact des appels signales est celui de l'oracle (aucun manque, aucune alerte parasite) ;
 * 3. **Definitions deplacees** : chaque fonction globale est deplacee a la fin de son fichier, l'ordre des fichiers restant celui du
 *    serveur ;
 * 4. **Recursion injectee** : chaque fonction globale recoit en premiere instruction un appel a elle-meme par son nom.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { buildRathenaRegistry, detectRenewal, RATHENA_PATHS, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import { analyzeFile, WorkspaceIndex } from "@runeforge/runescript-analysis";
import type { FileAnalysis } from "@runeforge/runescript-analysis";
import { normalizeToLf } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--shuffles", "--seed"]);
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : node --import tsx scripts/order-report.ts --server-root <racine du serveur> [--shuffles N] [--seed N]");
  process.exit(2);
}
const serverRoot: string = root;
const shuffles = Math.max(0, Math.floor(Number(cli.value("--shuffles")) || 40));
const seed = Math.floor(Number(cli.value("--seed")) || 20260605);

const readBytes = (relative: string): Buffer | null => {
  const path = join(serverRoot, relative);
  return existsSync(path) ? readFileSync(path) : null;
};
const readText = (relative: string): string | null => readBytes(relative)?.toString("latin1") ?? null;

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
const order: readonly string[] = load.files;

const texts = new Map<string, string>();
for (const path of order) {
  const bytes = readBytes(path);
  if (bytes !== null) texts.set(path, normalizeToLf(bytes.toString("latin1")));
}

// --- Analyse du projet par le service (l'implementation controlee) ----------------------------------------------------------
const options = { commands: registry } as const;
const analyses = new Map<string, FileAnalysis>();
const index = new WorkspaceIndex();
const t0 = performance.now();
for (const [path, text] of texts) {
  const analysis = analyzeFile(parse(text), path, options);
  analyses.set(path, analysis);
  index.set(analysis);
}
console.log(`Registre : ${registry.stats().total} commandes | ${order.length} scripts charges, ${texts.size} lus, analyses en ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// --- Oracle independant : lecture du texte brut -----------------------------------------------------------------------------
interface Def {
  readonly name: string;
  readonly file: string;
  /** Debut de l'en-tete (`function`), fin apres l'accolade fermante. */
  readonly start: number;
  readonly end: number;
  readonly nameAt: number;
  /** Position de l'accolade ouvrante. */
  readonly open: number;
}
interface Call {
  readonly name: string;
  readonly file: string;
  readonly at: number;
}
interface FileScan {
  readonly code: string;
  readonly defs: Def[];
}

/** Le texte avec les commentaires et les chaines remplaces par des espaces (memes positions, memes fins de ligne). */
function blank(text: string): string {
  const out = text.split("");
  const n = text.length;
  const erase = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (text[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j += 1;
      erase(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close === -1 ? n : close + 2;
      erase(i, stop);
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, n);
      erase(i, stop);
      i = stop;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

function scanDefs(file: string, text: string): FileScan {
  const code = blank(text);
  const defs: Def[] = [];
  for (const match of code.matchAll(/^function[ \t]+script[ \t]+([^\s{]+)\s*\{/gm)) {
    const name = match[1];
    if (name === undefined) continue;
    const open = match.index + match[0].length - 1;
    let depth = 1;
    let i = open + 1;
    while (i < code.length && depth > 0) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") depth -= 1;
      i += 1;
    }
    defs.push({ name, file, start: match.index, end: i, nameAt: match.index + match[0].lastIndexOf(name), open });
  }
  return { code, defs };
}

const scans = new Map<string, FileScan>();
for (const [path, text] of texts) scans.set(path, scanDefs(path, text));

function tableOf(all: ReadonlyMap<string, FileScan>): Map<string, Def[]> {
  const table = new Map<string, Def[]>();
  for (const scan of all.values()) {
    for (const def of scan.defs) {
      const list = table.get(def.name);
      if (list === undefined) table.set(def.name, [def]);
      else list.push(def);
    }
  }
  return table;
}
const table = tableOf(scans);
const names: ReadonlySet<string> = new Set(table.keys());

/** Les appels par leur nom d'une fonction globale, retrouves par leurs mots (pas par le parseur). */
function scanCalls(file: string, scan: FileScan): Call[] {
  const { code, defs } = scan;
  const headers = new Set(defs.map((def) => def.nameAt));
  const found: { name: string; at: number }[] = [];
  const local = new Set<string>();
  // Un mot du serveur (`skip_word`) : lettres, chiffres et `_`, y compris au debut (`171_worker_talk` est une fonction du serveur).
  for (const match of code.matchAll(/[A-Za-z0-9_]+/g)) {
    const at = match.index;
    const name = match[0];
    if (headers.has(at)) continue;
    // `function Nom;` ou `function Nom {` : fonction locale du script, appelee seule sans rapport avec une fonction globale.
    if (/\bfunction[ \t]+$/.test(code.slice(Math.max(0, at - 24), at))) {
      local.add(name.toLowerCase());
      continue;
    }
    if (!names.has(name) || registry?.has(name) === true) continue;
    const before = code[at - 1];
    if (before !== undefined && ".@$#'".includes(before)) continue;
    if (/^[ \t]*:/.test(code.slice(at + name.length, at + name.length + 8))) continue;
    found.push({ name, at });
  }
  return found.filter((call) => !local.has(call.name.toLowerCase())).map((call) => ({ ...call, file }));
}

function allCalls(): Call[] {
  const calls: Call[] = [];
  for (const [path, scan] of scans) calls.push(...scanCalls(path, scan));
  return calls;
}

function rankOf(files: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  files.forEach((file, rank) => {
    if (!ranks.has(file)) ranks.set(file, rank);
  });
  return ranks;
}

/** Les appels que le serveur refuse, selon l'oracle : la fonction n'est connue ni dans un fichier charge avant, ni plus haut dans le fichier. */
function expectedFlags(ranks: ReadonlyMap<string, number>, defsByName: ReadonlyMap<string, Def[]>, calls: readonly Call[]): Set<string> {
  const flags = new Set<string>();
  for (const call of calls) {
    const callRank = ranks.get(call.file);
    const defs = defsByName.get(call.name);
    if (callRank === undefined || defs === undefined || defs.length === 0) continue;
    const known = defs.some((def) => (def.file === call.file ? def.end <= call.at : (ranks.get(def.file) ?? Number.POSITIVE_INFINITY) < callRank));
    if (!known) flags.add(`${call.file}:${call.at}`);
  }
  return flags;
}

function actualFlags(): Set<string> {
  const flags = new Set<string>();
  for (const file of texts.keys()) for (const diagnostic of index.loadOrderDiagnostics(file)) flags.add(`${file}:${diagnostic.range.start}`);
  return flags;
}

function compare(expected: ReadonlySet<string>, actual: ReadonlySet<string>): { missing: string[]; extra: string[] } {
  return { missing: [...expected].filter((key) => !actual.has(key)), extra: [...actual].filter((key) => !expected.has(key)) };
}

const failures: string[] = [];
const fail = (message: string): void => {
  if (failures.length < 25) failures.push(message);
};
const describeKey = (key: string): string => {
  const at = key.lastIndexOf(":");
  const file = key.slice(0, at);
  const offset = Number(key.slice(at + 1));
  const text = texts.get(file) ?? "";
  return `${key} « ${text.slice(offset, offset + 28).split("\n")[0] ?? ""} »`;
};

// --- 1. Le serveur tel quel ---------------------------------------------------------------------------------------------------
const baseCalls = allCalls();
let analysisCalls = 0;
let crossFile = 0;
let sameFile = 0;
const distinct = new Set<string>();
for (const [path, analysis] of analyses) {
  for (const call of analysis.unknownCalls) {
    const defs = index.findFunctions(call.name);
    if (defs.length === 0) continue;
    analysisCalls += 1;
    distinct.add(call.name);
    if (defs.some((def) => def.uri === path)) sameFile += 1;
    else crossFile += 1;
  }
}
const astDefs = [...analyses.values()].reduce((total, analysis) => total + analysis.declarations.filter((d) => d.kind === "function").length, 0);
const oracleDefs = [...scans.values()].reduce((total, scan) => total + scan.defs.length, 0);
const duplicates = [...table].filter(([, defs]) => defs.length > 1).map(([name, defs]) => `${name} (${defs.length})`);
console.log(`\n1. SERVEUR TEL QUEL : ${oracleDefs} fonctions globales selon l'oracle, ${astDefs} selon le parseur${duplicates.length > 0 ? ` | definies plusieurs fois : ${duplicates.join(", ")}` : ""}`);
console.log(`   appels par leur nom : ${baseCalls.length} selon l'oracle, ${analysisCalls} selon l'analyse (${distinct.size} fonctions appelees ; ${crossFile} d'un autre fichier, ${sameFile} du meme fichier)`);
if (oracleDefs !== astDefs) fail(`fonctions globales : oracle ${oracleDefs}, parseur ${astDefs}`);
if (baseCalls.length !== analysisCalls) fail(`appels par leur nom : oracle ${baseCalls.length}, analyse ${analysisCalls}`);
index.setLoadOrder(order);
{
  const expected = expectedFlags(rankOf(order), table, baseCalls);
  const actual = actualFlags();
  console.log(`   RA0016 : ${actual.size} obtenu(s), ${expected.size} attendu(s) par l'oracle (le serveur charge ces scripts sans erreur : 0 attendu)`);
  for (const key of actual) console.log(`   alerte : ${describeKey(key)}`);
  if (actual.size > 0) fail(`${actual.size} RA0016 sur des scripts que le serveur charge`);
  const { missing, extra } = compare(expected, actual);
  if (missing.length > 0 || extra.length > 0) fail(`serveur tel quel : ${missing.length} manquant(s), ${extra.length} en trop`);
}

// --- 2. Ordres mutes ------------------------------------------------------------------------------------------------------------
{
  const definingFiles = [...new Set([...table.values()].flatMap((defs) => defs.map((def) => def.file)))].sort();
  const orders: { label: string; files: string[] }[] = [];
  for (const file of definingFiles) {
    orders.push({ label: `${file} charge en dernier`, files: [...order.filter((path) => path !== file), file] });
    orders.push({ label: `${file} non charge`, files: order.filter((path) => path !== file) });
  }
  orders.push({ label: "ordre inverse", files: [...order].reverse() });
  let state = seed;
  const random = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let round = 0; round < shuffles; round += 1) {
    const files = [...order];
    for (let i = files.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const kept = files[i];
      const other = files[j];
      if (kept !== undefined && other !== undefined) {
        files[i] = other;
        files[j] = kept;
      }
    }
    orders.push({ label: `melange ${round + 1}`, files });
  }
  let flagged = 0;
  let silent = 0;
  let compared = 0;
  let spent = 0;
  for (const candidate of orders) {
    index.setLoadOrder(candidate.files);
    const expected = expectedFlags(rankOf(candidate.files), table, baseCalls);
    const startedAt = performance.now();
    const actual = actualFlags();
    spent += performance.now() - startedAt;
    flagged += expected.size;
    if (expected.size === 0) silent += 1;
    compared += baseCalls.length;
    const { missing, extra } = compare(expected, actual);
    if (missing.length > 0 || extra.length > 0) {
      fail(`ordre « ${candidate.label} » : ${missing.length} manquant(s) (${missing.slice(0, 2).map(describeKey).join(" ; ")}), ${extra.length} en trop (${extra.slice(0, 2).map(describeKey).join(" ; ")})`);
    }
  }
  index.setLoadOrder(order);
  console.log(`\n2. ORDRES MUTES : ${orders.length} ordres (${definingFiles.length} fichiers de fonctions en dernier ou non charges, inverse, ${shuffles} melanges) : ${compared} verdicts d'appels compares, ${flagged} appels signales attendus, ${silent} ordre(s) sans aucun appel signale`);
  console.log(`   cout du controle : ${(spent / orders.length).toFixed(1)} ms en moyenne pour les diagnostics RA0016 de ${texts.size} fichiers sous un ordre donne`);
  if (flagged === 0) fail("aucun appel signale par les ordres mutes : controle vide");
}

// --- 3 et 4. Definitions deplacees, recursion injectee -----------------------------------------------------------------------
function mutateFile(file: string, mutated: string, body: () => void): void {
  const originalAnalysis = analyses.get(file);
  const originalScan = scans.get(file);
  if (originalAnalysis === undefined || originalScan === undefined) return;
  index.set(analyzeFile(parse(mutated), file, options));
  scans.set(file, scanDefs(file, mutated));
  try {
    body();
  } finally {
    index.set(originalAnalysis);
    scans.set(file, originalScan);
  }
}

function check(label: string, ranks: ReadonlyMap<string, number>): { flagged: number } {
  const expected = expectedFlags(ranks, tableOf(scans), allCalls());
  const actual = actualFlags();
  const { missing, extra } = compare(expected, actual);
  if (missing.length > 0 || extra.length > 0) {
    fail(`${label} : ${missing.length} manquant(s) (${missing.slice(0, 2).map(describeKey).join(" ; ")}), ${extra.length} en trop (${extra.slice(0, 2).map(describeKey).join(" ; ")})`);
  }
  return { flagged: expected.size };
}

{
  const ranks = rankOf(order);
  let moves = 0;
  let withCalls = 0;
  let flagged = 0;
  for (const [file, scan] of [...scans]) {
    const text = texts.get(file) ?? "";
    for (const def of scan.defs) {
      const moved = `${text.slice(0, def.start)}${text.slice(def.end)}\n${text.slice(def.start, def.end)}\n`;
      let outcome = 0;
      mutateFile(file, moved, () => {
        outcome = check(`${def.name} deplacee a la fin de ${file}`, ranks).flagged;
      });
      moves += 1;
      flagged += outcome;
      if (outcome > 0) withCalls += 1;
    }
  }
  console.log(`\n3. DEFINITIONS DEPLACEES A LA FIN DE LEUR FICHIER : ${moves} deplacements, ${withCalls} avec au moins un appel qui precede desormais sa definition (${flagged} appels signales attendus et obtenus)`);
  if (withCalls === 0) fail("aucun deplacement n'a cree d'appel premature : controle vide");
}

{
  const ranks = rankOf(order);
  let injected = 0;
  let flagged = 0;
  for (const [file, scan] of [...scans]) {
    const text = texts.get(file) ?? "";
    for (const def of scan.defs) {
      const changed = `${text.slice(0, def.open + 1)}\n\t${def.name};${text.slice(def.open + 1)}`;
      let outcome = 0;
      mutateFile(file, changed, () => {
        const calls = allCalls();
        const at = def.open + 1 + "\n\t".length;
        const own = calls.find((call) => call.file === file && call.at === at);
        const verdict = check(`${def.name} s'appelant elle-meme dans ${file}`, ranks);
        outcome = verdict.flagged;
        // L'appel injecte est dans le corps de la fonction : il est refuse, sauf si une autre definition le precede (ordre des fichiers).
        const others = (tableOf(scans).get(def.name) ?? []).filter((other) => !(other.file === file && other.nameAt === def.nameAt + 0));
        const earlier = others.some((other) => (other.file === file ? other.end <= at : (ranks.get(other.file) ?? Number.POSITIVE_INFINITY) < (ranks.get(file) ?? -1)));
        const flaggedHere = index.loadOrderDiagnostics(file).some((diagnostic) => diagnostic.range.start === at);
        if (own === undefined) fail(`${def.name} dans ${file} : l'appel injecte n'est pas vu par l'oracle`);
        else if (flaggedHere === earlier) fail(`${def.name} dans ${file} : appel de soi-meme ${flaggedHere ? "signale alors qu'une autre definition le precede" : "non signale"}`);
      });
      injected += 1;
      flagged += outcome;
    }
  }
  console.log(`\n4. RECURSION INJECTEE : ${injected} fonctions recoivent un appel a elles-memes par leur nom (${flagged} appels signales attendus et obtenus, injectes compris)`);
}

index.setLoadOrder(order);
console.log(failures.length === 0 ? "\nTOUT EST CONFORME" : `\nECHECS :\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
