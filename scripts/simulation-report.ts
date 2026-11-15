/**
 * Simulation de dialogue (M8, RF-024) confrontée à un corpus réel de scripts : combien de NPC se laissent jouer jusqu'au
 * bout, qu'est-ce que la simulation a dû supposer ou écarter, et résiste-t-elle à des scripts abîmés ?
 *
 * Usage : pnpm exec tsx scripts/simulation-report.ts --server-root <racine du serveur> --entry npc/re/scripts_main.conf
 *                [--functions file|project] [--runs N] [--mutate N] [--json]
 *         pnpm exec tsx scripts/simulation-report.ts <dossier> [...]
 *
 * Lecture seule. Chaque NPC à corps (fermé ou non, avec ou sans erreur de syntaxe : le dialogue les joue tous) est joué par
 * le simulateur du produit (le même que le dialogue « Simuler le dialogue ») avec deux personnages (un débutant sans rien,
 * un vétéran riche) et plusieurs stratégies de réponse (toujours la première option, toujours la dernière, tirages avec
 * graine). On mesure :
 * - l'issue de chaque partie : fin, fermeture, **limite** (boucle sans fin, trop de texte...) ou attente (le pilote cesse de répondre) ;
 * - les NPC dont au moins une partie est allée jusqu'à une fin ;
 * - les **écarts** notés : opérations que le serveur refuserait (division par zéro, argument absent...) et que le dialogue
 *   franchit avec une valeur de repli, par cause, avec un exemple ;
 * - les instructions notées « non simulées » et les valeurs « supposées » (ce que la simulation ne sait pas calculer) ;
 * - les mots nus lus sans valeur connue (variables non écrites ou constantes absentes de la table).
 * Un défaut est : une exception qui s'échappe du simulateur, un écart `internal` (défaut du simulateur rattrapé), ou deux
 * parties identiques (même graine) qui diffèrent. Un écart n'en est pas un : un script peut légitimement mal faire.
 *
 * `--functions file` (défaut) : seules les fonctions du fichier du NPC sont connues ;
 * `--functions project` : toutes les fonctions du corpus le sont, comme dans le dialogue quand l'index du projet est prêt.
 * `--mutate N` : en plus, chaque NPC est abîmé N fois au hasard (suppression, insertion de ponctuation ou de commandes
 * fautives, troncature, lignes dupliquées ou échangées) puis joué : la simulation doit aller jusqu'au bout sans défaut.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { LineIndex, normalizeToLf } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";
import type { NpcDeclaration } from "@runeforge/runescript-parser";
import { RATHENA_SCRIPT_CONSTANTS } from "@runeforge/emulator-rathena/script-constants";
import { SimulationSession } from "@runeforge/simulation-core";
import type { FunctionSource, SimulationContext, SimulationView, SimValue } from "@runeforge/simulation-core";
import { CORPUS_USAGE, loadCorpus, parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--functions", "--runs", "--mutate"]);
const corpus = loadCorpus(cli);
if (corpus === undefined) {
  console.error(`Usage : tsx scripts/simulation-report.ts <dossier> | --server-root <racine> --entry <conf> [--functions file|project] [--runs N] [--mutate N] [--json]\n${CORPUS_USAGE}`);
  process.exit(2);
}
const projectFunctions = cli.value("--functions") === "project";
const asJson = cli.has("--json");
/** Parties « au hasard » par personnage (en plus de « première » et « dernière » option). */
const randomRuns = Math.max(0, Math.floor(Number(cli.value("--runs")) || 2));
/** Variantes abîmées par NPC (0 : aucune). */
const mutants = Math.max(0, Math.floor(Number(cli.value("--mutate")) || 0));
const MAX_PAUSES = 400;

const constants: ReadonlyMap<string, SimValue> = RATHENA_SCRIPT_CONSTANTS;

const characters: readonly { readonly label: string; readonly context: SimulationContext }[] = [
  { label: "novice", context: { level: 1, job: 0, zeny: 0, variables: new Map(), items: new Map(), quests: new Map() } },
  { label: "veteran", context: { level: 150, job: 4054, zeny: 10_000_000, variables: new Map(), items: new Map(), quests: new Map() } },
];

type Strategy = "first" | "last" | `random-${number}`;
const strategies: Strategy[] = ["first", "last", ...Array.from({ length: randomRuns }, (_unused, index): Strategy => `random-${index + 1}`)];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Choix d'une option. « Première » et « dernière » tournent quand le même menu revient (un NPC qui reboucle sur
 * « autre chose ? » finit ainsi par laisser sortir) ; les autres tirent au hasard avec graine.
 */
function answer(view: SimulationView, strategy: Strategy, random: () => number, seen: Map<string, number>): SimValue | undefined {
  const state = view.state;
  if (state.kind === "choice") {
    const options = state.options;
    const key = options.map((option) => option.label).join("|");
    const visits = seen.get(key) ?? 0;
    seen.set(key, visits + 1);
    const pick = strategy === "first" ? visits % options.length : strategy === "last" ? options.length - 1 - (visits % options.length) : Math.floor(random() * options.length);
    return options[pick]?.value;
  }
  if (state.kind === "input") return state.numeric ? Math.min(Math.max(1, state.min), state.max) : "test";
  return undefined;
}

interface Run {
  readonly outcome: "end" | "closed" | "limit" | "paused";
  /** Pour une limite : sa cause et l'instruction atteinte. */
  readonly detail: string;
  readonly lines: number;
  readonly effects: readonly string[];
  readonly assumed: readonly string[];
  readonly faults: readonly { readonly detail: string; readonly text: string }[];
  readonly unresolved: readonly string[];
  /** Empreinte de la partie : texte, choix, effets, variables. */
  readonly digest: string;
}

function play(npc: NpcDeclaration, text: string, context: SimulationContext, strategy: Strategy, functions: ReadonlyMap<string, FunctionSource>): Run {
  const session = new SimulationSession(npc, context, { source: text, functions, constants, seed: 7 });
  const random = lcg(Number(strategy.startsWith("random-") ? strategy.slice(7) : 1) * 7919);
  const seen = new Map<string, number>();
  let view = session.advance();
  let pauses = 0;
  while ((view.state.kind === "page" || view.state.kind === "choice" || view.state.kind === "input") && pauses < MAX_PAUSES) {
    pauses += 1;
    view = session.advance(answer(view, strategy, random, seen));
  }
  const state = view.state;
  const outcome = state.kind === "end" || state.kind === "closed" || state.kind === "limit" ? state.kind : "paused";
  return {
    outcome,
    detail: state.kind === "limit" ? `${state.detail}: ${state.text}` : "",
    lines: view.messages.length,
    effects: view.transcript.flatMap((entry) => (entry.kind === "effect" ? [entry.name] : [])),
    assumed: view.transcript.flatMap((entry) => (entry.kind === "assumed" ? [entry.name] : [])),
    faults: view.transcript.flatMap((entry) => (entry.kind === "fault" ? [{ detail: entry.detail, text: entry.text }] : [])),
    unresolved: [...session.unresolvedNames()],
    digest: JSON.stringify([view.transcript, [...view.variables], view.zeny, [...view.items], [...view.quests], state.kind]),
  };
}

// --- Chargement ------------------------------------------------------------------------------------------------------

interface Loaded {
  readonly uri: string;
  readonly text: string;
  readonly index: LineIndex;
  readonly npcs: NpcDeclaration[];
  readonly functions: Map<string, FunctionSource>;
}

const started = performance.now();
const files: Loaded[] = [];
const globalFunctions = new Map<string, FunctionSource>();
let withSyntaxErrors = 0;
let totalNpcs = 0;
for (const file of corpus.files) {
  const text = normalizeToLf(readFileSync(file.path).toString("latin1"));
  const parsed = parse(text);
  const npcs: NpcDeclaration[] = [];
  const functions = new Map<string, FunctionSource>();
  for (const declaration of parsed.ast.declarations) {
    if (declaration.kind === "FunctionDeclaration") {
      const source: FunctionSource = { declaration, source: text };
      functions.set(declaration.name.toLowerCase(), source);
      if (!globalFunctions.has(declaration.name.toLowerCase())) globalFunctions.set(declaration.name.toLowerCase(), source);
    }
    if (declaration.kind !== "NpcDeclaration" || declaration.body === null) continue;
    totalNpcs += 1;
    // Le dialogue joue aussi un NPC dont le corps est ouvert ou qui a une erreur de syntaxe : on les compte, on les joue.
    const broken = declaration.body.closeRange === null ||
      parsed.truncated ||
      parsed.diagnostics.some((item) => item.severity === "error" && item.range.start >= declaration.range.start && item.range.start < declaration.range.end);
    if (broken) withSyntaxErrors += 1;
    npcs.push(declaration);
  }
  files.push({ uri: file.uri, text, index: new LineIndex(text), npcs, functions });
}
const loaded = performance.now();

// --- Parties -----------------------------------------------------------------------------------------------------------

const tally = (map: Map<string, Set<string>>, key: string, id: string): void => {
  const ids = map.get(key) ?? new Set<string>();
  ids.add(id);
  map.set(key, ids);
};

interface Cause {
  runs: number;
  readonly npcs: Set<string>;
  readonly example: string;
}

/** Mesures d'un ensemble de parties : le corpus tel quel, ou ses variantes abîmées. */
interface Stats {
  runs: number;
  readonly outcomes: Map<string, number>;
  readonly limits: Map<string, Cause>;
  readonly faults: Map<string, Cause>;
}

const newStats = (): Stats => ({ runs: 0, outcomes: new Map(), limits: new Map(), faults: new Map() });
const corpusStats = newStats();
const damagedStats = newStats();

const bump = (map: Map<string, Cause>, key: string, id: string, example: string): void => {
  const cause = map.get(key) ?? { runs: 0, npcs: new Set<string>(), example };
  cause.runs += 1;
  cause.npcs.add(id);
  map.set(key, cause);
};

const effectNpcs = new Map<string, Set<string>>();
const assumedNpcs = new Map<string, Set<string>>();
const unresolvedNpcs = new Map<string, Set<string>>();
const defects: string[] = [];
let npcCount = 0;
let withDialogue = 0;
let completed = 0;
let completedWithDialogue = 0;
const slowest: { ms: number; label: string }[] = [];

/** Joue un NPC (ou une variante abîmée) avec chaque personnage et chaque stratégie ; un défaut est consigné. */
function playAll(npc: NpcDeclaration, text: string, functions: ReadonlyMap<string, FunctionSource>, id: string, label: string, stats: Stats, detailed: boolean): { dialogue: boolean; finished: boolean } {
  let dialogue = false;
  let finished = false;
  for (const character of characters) {
    for (const strategy of strategies) {
      let run: Run;
      try {
        run = play(npc, text, character.context, strategy, functions);
      } catch (error) {
        defects.push(`exception | ${id} | ${label} | ${character.label}/${strategy} | ${error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" ") : String(error)}`);
        continue;
      }
      stats.runs += 1;
      stats.outcomes.set(run.outcome, (stats.outcomes.get(run.outcome) ?? 0) + 1);
      if (run.lines > 0) dialogue = true;
      if (run.outcome === "end" || run.outcome === "closed") finished = true;
      if (run.outcome === "limit") bump(stats.limits, run.detail.split(":")[0] ?? "", id, `${id} (${label}) ${run.detail}`);
      for (const fault of run.faults) {
        if (fault.detail === "internal") defects.push(`interne | ${id} | ${label} | ${character.label}/${strategy} | ${fault.text}`);
        bump(stats.faults, fault.detail, id, `${id} (${label}) « ${fault.text} »`);
      }
      if (!detailed) continue;
      for (const name of new Set(run.effects)) tally(effectNpcs, name, id);
      for (const name of new Set(run.assumed)) tally(assumedNpcs, name, id);
      for (const name of run.unresolved) tally(unresolvedNpcs, name, id);
      // Une partie rejouée à l'identique (même graine, mêmes réponses) doit donner exactement la même transcription.
      if (strategy === "first" && character.label === "novice" && npcCount % 20 === 0) {
        const again = play(npc, text, character.context, strategy, functions);
        if (again.digest !== run.digest) defects.push(`non-déterminisme | ${id} | ${label}`);
      }
    }
  }
  return { dialogue, finished };
}

for (const file of files) {
  const functions = projectFunctions ? globalFunctions : file.functions;
  for (const npc of file.npcs) {
    npcCount += 1;
    const id = `${file.uri}:${file.index.positionAt(npc.range.start).line + 1}`;
    const begun = performance.now();
    const { dialogue, finished } = playAll(npc, file.text, functions, id, npc.name.display, corpusStats, true);
    if (dialogue) withDialogue += 1;
    if (finished) completed += 1;
    if (finished && dialogue) completedWithDialogue += 1;
    slowest.push({ ms: performance.now() - begun, label: `${id} ${npc.name.display}` });
    if (slowest.length > 400) {
      slowest.sort((a, b) => b.ms - a.ms);
      slowest.length = 5;
    }
  }
}
const finishedAt = performance.now();
slowest.sort((a, b) => b.ms - a.ms);

// --- Scripts abîmés ----------------------------------------------------------------------------------------------------

/** Fragments qui cassent ou détournent un script : ponctuation, commandes sans argument, sauts vers rien... */
const FRAGMENTS = [
  '"', "'", "{", "}", "(", ")", "[", "]", ";", ",", ":", "::", "$", "@", "#", ".@", "/*", "//", "1/0", "-", "!", "~", "\\", "^ff0000",
  " goto L_Nowhere; ", " callsub S_Nowhere; ", ' select(""); ', " return; ", " getarg(9); ", ' menu "a",L_Nowhere; ', " case 1: ", " default: ",
  " callfunc; ", " set ; ", " input ; ", " delitem 501,99; ", " mes; ", " .@a[-1] = 1; ", ' mes -"x"; ', " 99999999999999999999 ", " while (1) { } ",
];

function damage(text: string, random: () => number): string {
  const at = Math.floor(random() * text.length);
  const lines = text.split("\n");
  const first = Math.floor(random() * lines.length);
  const second = Math.floor(random() * lines.length);
  switch (Math.floor(random() * 5)) {
    case 0: return text.slice(0, at) + text.slice(at + 1 + Math.floor(random() * 40));
    case 1: return text.slice(0, at) + (FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? "") + text.slice(at);
    case 2: return text.slice(0, at);
    case 3:
      lines.splice(first, 0, lines[first] ?? "");
      return lines.join("\n");
    default:
      [lines[first], lines[second]] = [lines[second] ?? "", lines[first] ?? ""];
      return lines.join("\n");
  }
}

let damaged = 0;
let unparsed = 0;
const damagedStart = performance.now();
if (mutants > 0) {
  let seed = 1;
  for (const file of files) {
    for (const npc of file.npcs) {
      const original = file.text.slice(npc.range.start, npc.range.end);
      const functions = projectFunctions ? globalFunctions : file.functions;
      for (let variant = 0; variant < mutants; variant += 1) {
        const random = lcg(seed++);
        let text = original;
        for (let times = 1 + Math.floor(random() * 3); times > 0; times -= 1) text = damage(text, random);
        const found = parse(text).ast.declarations.find((declaration): declaration is NpcDeclaration => declaration.kind === "NpcDeclaration" && declaration.body !== null);
        if (found === undefined) {
          unparsed += 1;
          continue;
        }
        damaged += 1;
        playAll(found, text, functions, `${file.uri}:${file.index.positionAt(npc.range.start).line + 1}#${variant}`, `${npc.name.display} (abîmé)`, damagedStats, false);
      }
    }
  }
}
const damagedAt = performance.now();

// --- Rapport -----------------------------------------------------------------------------------------------------------

const top = <T>(entries: Iterable<T>, size: number, by: (entry: T) => number): T[] => [...entries].sort((a, b) => by(b) - by(a)).slice(0, size);
const percent = (part: number, whole: number): string => (whole === 0 ? "0" : ((100 * part) / whole).toFixed(1));
const countOf = (stats: Stats, outcome: string): number => stats.outcomes.get(outcome) ?? 0;
const sumRuns = (map: Map<string, Cause>): number => [...map.values()].reduce((sum, cause) => sum + cause.runs, 0);

const issues = (stats: Stats): string =>
  `fin ${countOf(stats, "end")} (${percent(countOf(stats, "end"), stats.runs)} %) | fermeture ${countOf(stats, "closed")} (${percent(countOf(stats, "closed"), stats.runs)} %) | ` +
  `limite ${countOf(stats, "limit")} | en attente ${countOf(stats, "paused")}`;

function causes(title: string, map: Map<string, Cause>, size: number): void {
  console.log(`\n${title} : ${sumRuns(map)} au total, ${map.size} causes (parties | NPC | exemple)`);
  for (const [cause, value] of top(map, size, ([, entry]) => entry.runs)) {
    console.log(`  ${cause.padEnd(14)} ${String(value.runs).padStart(6)} | ${String(value.npcs.size).padStart(5)} | ${value.example}`);
  }
}

if (asJson) {
  const summarize = (stats: Stats): unknown => ({
    runs: stats.runs, outcomes: Object.fromEntries(stats.outcomes), limits: Object.fromEntries([...stats.limits].map(([name, cause]) => [name, cause.runs])),
    faults: Object.fromEntries([...stats.faults].map(([name, cause]) => [name, { runs: cause.runs, npcs: cause.npcs.size }])),
  });
  console.log(JSON.stringify({
    files: files.length, npcs: npcCount, withSyntaxErrors, withDialogue, completed, completedWithDialogue, corpus: summarize(corpusStats),
    damaged: { variants: damaged, unparsed, ...(summarize(damagedStats) as object) }, defects: defects.length,
  }));
} else {
  console.log(`Corpus : ${corpus.label.join(" ")} | fonctions : ${projectFunctions ? "tout le corpus" : "fichier du NPC"}`);
  console.log(`${files.length} fichiers | ${totalNpcs} NPC à corps, tous simulés (dont ${withSyntaxErrors} avec erreur de syntaxe ou corps ouvert)`);
  console.log(`${corpusStats.runs} parties (${characters.length} personnages × ${strategies.length} stratégies : ${strategies.join(", ")})`);
  console.log(`Issues : ${issues(corpusStats)}`);
  console.log(`NPC menés à une fin par au moins une partie : ${completed} / ${npcCount} (${percent(completed, npcCount)} %)`);
  console.log(`NPC qui dialoguent (au moins une ligne) : ${withDialogue} ; menés à une fin : ${completedWithDialogue} (${percent(completedWithDialogue, withDialogue)} %)`);
  causes("Limites atteintes", corpusStats.limits, 10);
  causes("Écarts notés (opérations que le serveur refuserait ; le dialogue continue)", corpusStats.faults, 25);
  const list = (title: string, map: Map<string, Set<string>>, size: number): void => {
    console.log(`\n${title} (${map.size} distincts ; NPC concernés) :`);
    console.log("  " + top(map, size, ([, ids]) => ids.size).map(([name, ids]) => `${name} ${ids.size}`).join(" | "));
  };
  list("Instructions non simulées", effectNpcs, 60);
  list("Valeurs supposées (fonctions)", assumedNpcs, 40);
  list("Mots nus sans valeur connue", unresolvedNpcs, 60);
  if (mutants > 0) {
    console.log(`\nScripts abîmés : ${damaged} variantes jouées (${unparsed} sans NPC lisible, écartées), ${damagedStats.runs} parties en ${((damagedAt - damagedStart) / 1000).toFixed(1)} s`);
    console.log(`Issues : ${issues(damagedStats)}`);
    causes("Limites atteintes (scripts abîmés)", damagedStats.limits, 10);
    causes("Écarts notés (scripts abîmés)", damagedStats.faults, 12);
  }
  console.log(`\nDurée : chargement ${((loaded - started) / 1000).toFixed(1)} s, parties ${((finishedAt - loaded) / 1000).toFixed(1)} s ; NPC les plus lents : ` +
    slowest.slice(0, 3).map((entry) => `${entry.ms.toFixed(0)} ms ${entry.label}`).join(" | "));
  console.log(`Défauts : ${defects.length}`);
  for (const defect of defects.slice(0, 20)) console.log(`  ${defect}`);
}
process.exit(defects.length === 0 ? 0 : 1);
