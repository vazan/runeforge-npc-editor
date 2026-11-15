/**
 * Mesure et verification du registre de commandes et des regles de chargement sur un serveur rAthena reel (M4-S1).
 *
 * Usage : pnpm exec tsx scripts/registry-report.ts --server-root <racine du serveur> [--json]
 *         node --expose-gc --import tsx scripts/registry-report.ts --server-root <racine>   (mesure de memoire plus fiable)
 *
 * Lecture seule. Verifie, sur les fichiers de l'utilisateur :
 * - le registre construit depuis `src/map/script.cpp` (+ `src/custom/script_def.inc`) et `doc/script_commands.txt` ;
 * - le jeu de scripts charge, deduit de `conf/map_athena.conf` et `npc/<mode>/scripts_main.conf`, compare a celui de
 *   l'outil de mesure independant (`lib/corpus.ts`, premiere implementation) ;
 * - sur ce jeu de scripts, que le serveur charge sans erreur : aucune alerte d'arite (`RA0006`) ne doit apparaitre, et les
 *   commandes inconnues (`RA0001`) restantes sont listees pour verification.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CommandRegistry } from "@runeforge/emulator-core";
import { buildRathenaRegistry, detectRenewal, RATHENA_PATHS, RATHENA_PROFILE_LABEL, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import { analyzeFile, WorkspaceIndex } from "@runeforge/runescript-analysis";
import { LineIndex } from "@runeforge/runescript-core";
import { childrenOf, parse } from "@runeforge/runescript-parser";
import type { AstNode } from "@runeforge/runescript-parser";
import { loadCorpus, parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--mutation-step"]);
const root = cli.value("--server-root");
const asJson = cli.has("--json");
if (root === undefined) {
  console.error("Usage : tsx scripts/registry-report.ts --server-root <racine du serveur> [--json]");
  process.exit(2);
}

function readOptional(relative: string): string | null {
  try {
    return readFileSync(join(root as string, relative)).toString("latin1");
  } catch {
    return null;
  }
}

const gc = (globalThis as { gc?: () => void }).gc;
const report: Record<string, unknown> = {};
const lines: string[] = [];
const say = (text: string): void => {
  lines.push(text);
};

// --- 1. Registre ------------------------------------------------------------------------------------------------------
const builtinSource = readOptional(RATHENA_PATHS.builtinSource);
const customBuiltins = readOptional(RATHENA_PATHS.customBuiltins);
const commandDoc = readOptional(RATHENA_PATHS.commandDoc);
const registryStarted = performance.now();
const full = buildRathenaRegistry({ builtinSource, customBuiltins, commandDoc });
const registryMs = performance.now() - registryStarted;
const docOnly = buildRathenaRegistry({ commandDoc });
const sourceOnly = buildRathenaRegistry({ builtinSource, customBuiltins });
const stats = full.registry?.stats() ?? null;
say(`REGISTRE (${registryMs.toFixed(1)} ms, source ${builtinSource === null ? "absente" : `${(builtinSource.length / 1e6).toFixed(2)} Mo`}, doc ${commandDoc === null ? "absente" : `${(commandDoc.length / 1e3).toFixed(0)} Ko`})`);
say(`  niveau ${full.level} : ${stats?.total ?? 0} commandes (${stats?.withArity ?? 0} avec arite verifiable) ; table ${full.sourceCommands}, personnalisees ${full.customCommands}, doc ${full.docCommands}`);
say(`  table \\ doc : ${full.sourceOnly.length} [${full.sourceOnly.join(" ")}]`);
say(`  doc \\ table : ${full.docOnly.length} [${full.docOnly.join(" ")}]`);
say(`  avertissements de lecture : ${full.warnings.length}${full.warnings.length > 0 ? ` -> ${full.warnings.slice(0, 5).join(" | ")}` : ""}`);
report["registry"] = { level: full.level, stats, sourceOnly: full.sourceOnly, docOnly: full.docOnly, warnings: full.warnings, ms: registryMs };

// --- 2. Jeu de scripts charge -----------------------------------------------------------------------------------------
const renewal = detectRenewal(readOptional(RATHENA_PATHS.renewalHeader));
const loadStarted = performance.now();
const load = await resolveRathenaScripts(
  {
    readText: (path) => Promise.resolve(readOptional(path)),
    existingFiles: (paths) =>
      Promise.resolve(
        new Set(
          paths.filter((path) => {
            try {
              return statSync(join(root, path)).isFile();
            } catch {
              return false;
            }
          }),
        ),
      ),
  },
  renewal.renewal,
);
const loadMs = performance.now() - loadStarted;
const entry = renewal.renewal ? RATHENA_PATHS.scriptsMain.renewal : RATHENA_PATHS.scriptsMain.preRenewal;
const reference = loadCorpus(parseCommandLine(["--server-root", root, "--entry", entry]));
const referenceFiles = reference?.files.map((file) => file.uri) ?? [];
const sameSet = referenceFiles.length === load.files.length && referenceFiles.every((uri, i) => uri === load.files[i]);
say(`CHARGEMENT (${loadMs.toFixed(0)} ms) : mode ${renewal.renewal ? "renewal" : "pre-renewal"} (${renewal.evidence})`);
say(`  ${load.files.length} scripts dans l'ordre du serveur, ${load.configs.length} fichiers de configuration lus`);
say(`  identique (contenu ET ordre) a la premiere implementation de mesure : ${sameSet ? "OUI" : `NON (${referenceFiles.length} fichiers)`}`);
const issueKinds = new Map<string, number>();
for (const issue of load.issues) issueKinds.set(issue.kind, (issueKinds.get(issue.kind) ?? 0) + 1);
say(`  problemes : ${load.issues.length === 0 ? "aucun" : [...issueKinds].map(([kind, n]) => `${kind} x${n}`).join(", ")}`);
for (const issue of load.issues.slice(0, 6)) say(`    ${JSON.stringify(issue)}`);
report["loading"] = { renewal, files: load.files.length, configs: load.configs, issues: load.issues, sameAsReference: sameSet, ms: loadMs };

// --- 3. Analyse du jeu de scripts charge ------------------------------------------------------------------------------
interface Residual {
  count: number;
  files: Set<string>;
  firstUri: string;
  firstOffset: number;
}

function analyzeLoaded(registry: CommandRegistry | null): {
  ms: number;
  arity: string[];
  residual: Map<string, Residual>;
  unknownCalls: number;
  heapMb: number;
} {
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const index = new WorkspaceIndex();
  const arity: string[] = [];
  const started = performance.now();
  for (const uri of load.files) {
    const text = readOptional(uri);
    if (text === null) continue;
    const analysis = analyzeFile(parse(text), uri, { commands: registry });
    index.set(analysis);
    for (const d of analysis.diagnostics) {
      if (d.code === "RA0006") arity.push(`${uri}@${d.range.start} ${JSON.stringify(d.params)}`);
    }
  }
  const ms = performance.now() - started;
  gc?.();
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
  const residual = new Map<string, Residual>();
  let unknownCalls = 0;
  if (registry !== null) {
    for (const uri of index.uris()) {
      unknownCalls += index.getFile(uri)?.unknownCalls.length ?? 0;
      for (const d of index.unknownCommandDiagnostics(uri, { severity: "warning", profile: RATHENA_PROFILE_LABEL })) {
        const name = String(d.params?.["name"]);
        const known = residual.get(name);
        if (known === undefined) residual.set(name, { count: 1, files: new Set([uri]), firstUri: uri, firstOffset: d.range.start });
        else {
          known.count += 1;
          known.files.add(uri);
        }
      }
    }
  }
  return { ms, arity, residual, unknownCalls, heapMb };
}

function locate(uri: string, offset: number): string {
  const text = readOptional(uri) ?? "";
  const position = new LineIndex(text).positionAt(offset);
  return `${uri}:${position.line + 1}:${position.character + 1}`;
}

// Ampleur de ce qui est verifie : instructions-commandes et appels dans des expressions, connus ou non du registre.
{
  let sites = 0;
  let known = 0;
  const names = new Set<string>();
  for (const uri of load.files) {
    const text = readOptional(uri);
    if (text === null) continue;
    const stack: AstNode[] = [parse(text).ast];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      const name = node.kind === "CommandStatement" ? node.name : node.kind === "Call" ? node.callee : undefined;
      if (name !== undefined) {
        sites += 1;
        names.add(name.toLowerCase());
        if (full.registry?.has(name) === true) known += 1;
      }
      for (const child of childrenOf(node)) stack.push(child);
    }
  }
  say(`SITES D'APPEL dans les scripts charges : ${sites} (${names.size} noms distincts) ; connus du registre : ${known} ; autres (fonctions du projet) : ${sites - known}`);
  report["callSites"] = { sites, distinctNames: names.size, knownToRegistry: known };
}

const baseline = analyzeLoaded(null);
say(`ANALYSE de ${load.files.length} scripts charges`);
say(`  sans registre : ${baseline.ms.toFixed(0)} ms, ${baseline.heapMb.toFixed(1)} Mo`);
const levels: [string, CommandRegistry | null][] = [
  ["table + doc", full.registry],
  ["table seule", sourceOnly.registry],
  ["doc seule", docOnly.registry],
];
const analysisReport: Record<string, unknown> = { baseline: { ms: baseline.ms, heapMb: baseline.heapMb } };
for (const [label, registry] of levels) {
  if (registry === null) continue;
  const result = analyzeLoaded(registry);
  const total = [...result.residual.values()].reduce((sum, r) => sum + r.count, 0);
  say(`  registre ${label} : ${result.ms.toFixed(0)} ms, ${result.heapMb.toFixed(1)} Mo ; alertes d'arite RA0006 : ${result.arity.length} ; appels de noms inconnus gardes : ${result.unknownCalls} ; RA0001 apres index du projet : ${total} (${result.residual.size} noms)`);
  for (const sample of result.arity.slice(0, 8)) say(`    RA0006 ${sample}`);
  const ranked = [...result.residual].sort((a, b) => b[1].count - a[1].count);
  for (const [name, r] of ranked.slice(0, label === "table + doc" ? 25 : 8)) {
    say(`    RA0001 ${name} x${r.count} (${r.files.size} fichier(s)) ex. ${locate(r.firstUri, r.firstOffset)}`);
  }
  analysisReport[label] = {
    ms: result.ms,
    heapMb: result.heapMb,
    arity: result.arity.length,
    unknownCalls: result.unknownCalls,
    ra0001: total,
    ra0001Names: result.residual.size,
    residual: ranked.map(([name, r]) => ({ name, count: r.count, files: r.files.size, example: locate(r.firstUri, r.firstOffset) })),
  };
}
report["analysis"] = analysisReport;

// --- 4. Mutations controlees sur le code reel -------------------------------------------------------------------------
// Le silence sur du code valide ne prouve pas que les alertes se declenchent : on casse volontairement des appels reels
// et on verifie que chaque cassure est detectee a l'endroit exact, sans alerte parasite.
if (full.registry !== null) {
  const registry = full.registry;
  const step = Math.max(1, Math.floor(Number(cli.value("--mutation-step")) || 120));
  interface Site {
    readonly uri: string;
    readonly text: string;
    readonly name: string;
    readonly nameStart: number;
    readonly nameEnd: number;
    readonly end: number;
    readonly argCount: number;
  }
  const sites: Site[] = [];
  let seen = 0;
  for (const uri of load.files) {
    const text = readOptional(uri);
    if (text === null) continue;
    const stack: AstNode[] = [parse(text).ast];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (node.kind === "CommandStatement" && node.terminated && !node.parenthesized && text.charAt(node.range.end - 1) === ";") {
        seen += 1;
        if (seen % step === 0 && registry.has(node.name)) {
          sites.push({ uri, text, name: node.name, nameStart: node.nameRange.start, nameEnd: node.nameRange.end, end: node.range.end, argCount: node.args.length });
        }
      }
      for (const child of childrenOf(node)) stack.push(child);
    }
  }

  const arityIn = (text: string, uri: string): { start: number; count: number }[] =>
    analyzeFile(parse(text), uri, { commands: registry }).diagnostics.filter((d) => d.code === "RA0006").map((d) => ({ start: d.range.start, count: Number(d.params?.["count"]) }));

  const tally = { typo: { tried: 0, detected: 0, spurious: 0 }, extra: { tried: 0, detected: 0, spurious: 0 }, dropped: { tried: 0, detected: 0, spurious: 0 } };
  for (const site of sites) {
    const definition = registry.get(site.name);
    const arity = definition?.arity ?? null;
    if (arity === null) continue;
    const before = arityIn(site.text, site.uri);

    // 1. Faute de frappe dans le nom : le nom devient inconnu a cet endroit et plus aucune alerte d'arite n'y est possible.
    {
      const typo = `${site.name}_x`;
      const mutated = `${site.text.slice(0, site.nameEnd)}_x${site.text.slice(site.nameEnd)}`;
      const analysis = analyzeFile(parse(mutated), site.uri, { commands: registry });
      tally.typo.tried += 1;
      if (analysis.unknownCalls.some((call) => call.range.start === site.nameStart && call.name === typo)) tally.typo.detected += 1;
      const after = analysis.diagnostics.filter((d) => d.code === "RA0006").length;
      if (after > before.length) tally.typo.spurious += 1;
    }
    // 2. Arguments en trop (commande a nombre d'arguments borne).
    if (arity.max !== null && site.argCount >= 1) {
      const extra = ",0,0,0,0,0,0,0,0,0,0,0,0";
      const mutated = `${site.text.slice(0, site.end - 1)}${extra}${site.text.slice(site.end - 1)}`;
      const found = arityIn(mutated, site.uri);
      tally.extra.tried += 1;
      if (found.some((d) => d.start === site.nameStart && d.count === site.argCount + 12)) tally.extra.detected += 1;
      if (found.length !== before.length + 1) tally.extra.spurious += 1;
    }
    // 3. Tous les arguments supprimes (commande qui en exige au moins un).
    if (arity.min >= 1 && site.argCount >= 1) {
      const mutated = `${site.text.slice(0, site.nameEnd)}${site.text.slice(site.end - 1)}`;
      const found = arityIn(mutated, site.uri);
      tally.dropped.tried += 1;
      if (found.some((d) => d.start === site.nameStart && d.count === 0)) tally.dropped.detected += 1;
      if (found.length !== before.length + 1) tally.dropped.spurious += 1;
    }
  }
  say(`MUTATIONS sur ${sites.length} appels reels (1 appel sur ${step})`);
  const describeTally = (label: string, t: { tried: number; detected: number; spurious: number }): string =>
    `  ${label} : ${t.detected}/${t.tried} detectees a l'endroit exact, ${t.spurious} alerte(s) parasite(s)`;
  say(describeTally("nom modifie (RA0001)        ", tally.typo));
  say(describeTally("arguments en trop (RA0006)   ", tally.extra));
  say(describeTally("arguments supprimes (RA0006) ", tally.dropped));
  report["mutations"] = { sites: sites.length, step, ...tally };
}

if (asJson) console.log(JSON.stringify(report, null, 2));
else console.log(lines.join("\n"));
