/**
 * Verification des references (objets, monstres, competences, cartes) des scripts d'un serveur rAthena reel.
 *
 * Usage : node --expose-gc --import tsx scripts/references-report.ts --server-root <racine du serveur> [--examples N]
 *
 * Lecture seule. Pour chaque script **charge par le serveur** : les arguments ecrits en clair (nombre ou chaine) a la place
 * d'un objet, d'un monstre ou d'une carte — d'apres les signatures du manuel du serveur — sont cherches dans le catalogue
 * construit depuis ses bases. Le rapport donne, par commande et par nature, le nombre d'arguments verifies et non resolus : une
 * commande dont presque tous les arguments echouent est une commande mal comprise ; quelques echecs sont des erreurs reelles des
 * scripts (le serveur lui-meme les refuserait ou les journaliserait) a lire un par un.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { allowsSkillArgument, argumentKindsOf } from "@runeforge/emulator-core";
import type { ArgumentKind } from "@runeforge/emulator-core";
import { buildRathenaCatalog, buildRathenaRegistry, collectRathenaDatabaseSources, detectRenewal, RATHENA_PATHS, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import { analyzeFile } from "@runeforge/runescript-analysis";
import { LineIndex, normalizeToLf } from "@runeforge/runescript-core";
import { LanguageServer } from "@runeforge/runescript-language-server";
import { childrenOf, parse } from "@runeforge/runescript-parser";
import type { AstNode, Expression } from "@runeforge/runescript-parser";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--examples", "--mutation-step", "--probe-step"]);
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : node --expose-gc --import tsx scripts/references-report.ts --server-root <racine du serveur> [--examples N]");
  process.exit(2);
}
const serverRoot: string = root;
const exampleLimit = Math.max(0, Math.floor(Number(cli.value("--examples")) || 5));

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
const { sources } = await collectRathenaDatabaseSources({ readBytes: (paths) => Promise.resolve(paths.map(readBytes)) }, renewal, RATHENA_PATHS);
const decode = (file: { path: string; bytes: Uint8Array }): { path: string; text: string } => ({ path: file.path, text: new TextDecoder().decode(file.bytes) });
const built = buildRathenaCatalog({
  items: sources.items.map(decode),
  mobs: sources.mobs.map(decode),
  skills: sources.skills.map(decode),
  constantsYaml: sources.constantsYaml.map(decode),
  constantsSource: sources.constantsSource === null ? null : decode(sources.constantsSource),
  mapIndex: sources.mapIndex.map(decode),
});
const catalog = built.catalog;
if (catalog === null) {
  console.error("Aucun catalogue de references dans ce serveur.");
  process.exit(2);
}
console.log(`Catalogue : ${JSON.stringify(catalog.stats())} | mode ${renewal ? "renewal" : "pre-renewal"}`);

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

interface Tally {
  checked: number;
  unresolved: number;
  /** valeur -> exemples. */
  failures: Map<string, string[]>;
}
const tallies = new Map<string, Tally>();
const tallyOf = (key: string): Tally => {
  let tally = tallies.get(key);
  if (tally === undefined) {
    tally = { checked: 0, unresolved: 0, failures: new Map() };
    tallies.set(key, tally);
  }
  return tally;
};

const unwrap = (expression: Expression): Expression => {
  let current = expression;
  while (current.kind === "Parenthesized") current = current.expression;
  return current;
};

const codes: Record<string, number> = {};
let files = 0;
let literals = 0;
const skills = { known: 0, unknown: 0 };
/** Un argument sur `mutationStep` est remplace par une valeur absente de la base, pour verifier qu'il est signale au bon endroit. */
const mutationStep = Math.max(1, Math.floor(Number(cli.value("--mutation-step")) || 60));
interface Sample {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly kind: Exclude<ArgumentKind, "skill">;
  readonly isString: boolean;
  readonly baseline: number;
  readonly code: string;
}
const samples: Sample[] = [];
/** Un argument sur `probeStep` sert a verifier la completion et le survol (le texte des fichiers est normalise en LF, comme dans l'editeur). */
const probeStep = Math.max(1, Math.floor(Number(cli.value("--probe-step")) || 25));
interface Probe {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly kind: ArgumentKind;
  readonly raw: string;
  readonly isString: boolean;
  /** Ce que le catalogue en dit : le nom que la completion doit proposer. */
  readonly expected: string | null;
}
const probes: Probe[] = [];
const t0 = performance.now();
for (const path of load.files) {
  const bytes = readBytes(path);
  if (bytes === null) continue;
  files += 1;
  const text = normalizeToLf(bytes.toString("latin1"));
  const parsed = parse(text);
  const lines = new LineIndex(text);
  const analysis = analyzeFile(parsed, path, { commands: registry, references: catalog });
  const flagged = new Map<number, string>();
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.code === "RA0008" || diagnostic.code === "RA0009" || diagnostic.code === "RA0010") {
      codes[diagnostic.code] = (codes[diagnostic.code] ?? 0) + 1;
      flagged.set(diagnostic.range.start, diagnostic.code);
    }
  }
  const stack: AstNode[] = [parsed.ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.kind === "CommandStatement" || node.kind === "Call") {
      const name = node.kind === "CommandStatement" ? node.name : node.callee;
      const definition = registry.get(name);
      if (definition !== undefined) {
        const kinds = argumentKindsOf(definition);
        node.args.forEach((argument, index) => {
          const kind: ArgumentKind | null | undefined = kinds[index];
          if (kind === null || kind === undefined) return;
          const literal = unwrap(argument);
          if (literal.kind !== "NumberLiteral" && literal.kind !== "StringLiteral") return;
          if (kind === "skill") {
            const isString = literal.kind === "StringLiteral";
            if (!allowsSkillArgument(definition, index, isString ? "name" : "id")) return;
            const record = literal.kind === "StringLiteral" ? catalog.skillByName(literal.value) : catalog.skillById(literal.value);
            if (record === undefined) {
              skills.unknown += 1;
              return;
            }
            skills.known += 1;
            probes.push({ path, start: literal.range.start, end: literal.range.end, kind, raw: text.slice(literal.range.start, literal.range.end), isString, expected: record.name });
            return;
          }
          literals += 1;
          if (literals % probeStep === 0 && !flagged.has(literal.range.start)) {
            const written = literal.kind === "NumberLiteral" ? literal.value : literal.value;
            const record =
              kind === "map"
                ? catalog.mapByName(String(written))
                : kind === "item"
                  ? typeof written === "number"
                    ? catalog.itemById(written)
                    : catalog.itemByName(written)
                  : typeof written === "number"
                    ? catalog.mobById(written)
                    : catalog.mobByName(written);
            probes.push({
              path,
              start: literal.range.start,
              end: literal.range.end,
              kind,
              raw: text.slice(literal.range.start, literal.range.end),
              isString: literal.kind === "StringLiteral",
              expected: record === undefined ? null : "aegisName" in record ? record.aegisName : record.name,
            });
          }
          if (literals % mutationStep === 0 && !flagged.has(literal.range.start)) {
            samples.push({
              path,
              start: literal.range.start,
              end: literal.range.end,
              kind,
              isString: literal.kind === "StringLiteral",
              baseline: flagged.size,
              code: kind === "item" ? "RA0009" : kind === "mob" ? "RA0010" : "RA0008",
            });
          }
          const key = `${definition.name.toLowerCase()} #${index + 1} ${kind}`;
          const tally = tallyOf(key);
          tally.checked += 1;
          if (flagged.has(literal.range.start)) {
            tally.unresolved += 1;
            const value = literal.kind === "NumberLiteral" ? String(literal.value) : literal.value;
            const examples = tally.failures.get(value) ?? [];
            if (examples.length < exampleLimit) examples.push(`${path}:${lines.positionAt(literal.range.start).line + 1}`);
            tally.failures.set(value, examples);
          }
        });
      }
    }
    for (const child of childrenOf(node)) stack.push(child);
  }
}
const elapsed = performance.now() - t0;

const total = { checked: 0, unresolved: 0 };
const perKind: Record<string, { checked: number; unresolved: number }> = {};
for (const [key, tally] of tallies) {
  total.checked += tally.checked;
  total.unresolved += tally.unresolved;
  const kind = key.split(" ").pop() ?? "?";
  const entry = (perKind[kind] ??= { checked: 0, unresolved: 0 });
  entry.checked += tally.checked;
  entry.unresolved += tally.unresolved;
}
console.log(`\n${files} scripts charges analyses en ${(elapsed / 1000).toFixed(1)} s ; ${literals} arguments litteraux a verifier`);
console.log(`Diagnostics : ${JSON.stringify(codes)}`);
console.log(`  skill : ${skills.known} connus, ${skills.unknown} non resolus (completions et survol seulement, aucun diagnostic)`);
for (const [kind, entry] of Object.entries(perKind)) console.log(`  ${kind} : ${entry.checked} verifies, ${entry.unresolved} non resolus (${((100 * entry.unresolved) / Math.max(1, entry.checked)).toFixed(3)} %)`);
console.log(`  total : ${total.checked} verifies, ${total.unresolved} non resolus`);

console.log("\nPAR COMMANDE (position, nature) : verifies / non resolus");
for (const [key, tally] of [...tallies].sort((a, b) => b[1].checked - a[1].checked)) {
  console.log(`  ${key.padEnd(34)} ${String(tally.checked).padStart(6)} / ${tally.unresolved}`);
}

// --- Mutations : une valeur reelle remplacee par une valeur absente des bases -------------------------------------------
{
  const mutations = { done: 0, detected: 0, wrongCode: 0, parasitic: 0 };
  const perKind: Record<string, { done: number; detected: number }> = {};
  const misses: string[] = [];
  const byFile = new Map<string, Sample[]>();
  for (const sample of samples) byFile.set(sample.path, [...(byFile.get(sample.path) ?? []), sample]);
  for (const [path, list] of byFile) {
    const original = readBytes(path)?.toString("latin1");
    if (original === undefined) continue;
    const text = normalizeToLf(original);
    for (const sample of list) {
      const raw = text.slice(sample.start, sample.end);
      let mutated: string;
      if (sample.isString) {
        if (!raw.endsWith('"')) continue;
        mutated = `${raw.slice(0, -1)}_zz"`;
      } else {
        mutated = "9999999";
      }
      const changed = text.slice(0, sample.start) + mutated + text.slice(sample.end);
      const analysis = analyzeFile(parse(changed), path, { commands: registry, references: catalog });
      const found = analysis.diagnostics.filter((diagnostic) => diagnostic.code === "RA0008" || diagnostic.code === "RA0009" || diagnostic.code === "RA0010");
      const at = found.find((diagnostic) => diagnostic.range.start === sample.start);
      const tally = (perKind[sample.kind] ??= { done: 0, detected: 0 });
      mutations.done += 1;
      tally.done += 1;
      if (at === undefined) {
        if (misses.length < 10) misses.push(`${path}:${sample.start} ${raw} -> ${mutated}`);
      } else {
        mutations.detected += 1;
        tally.detected += 1;
        if (at.code !== sample.code) mutations.wrongCode += 1;
      }
      mutations.parasitic += Math.max(0, found.length - sample.baseline - (at === undefined ? 0 : 1));
    }
  }
  console.log(`\nMUTATIONS (1 argument sur ${mutationStep}) : ${mutations.detected}/${mutations.done} signalees a l'endroit exact, ${mutations.wrongCode} avec un mauvais code, ${mutations.parasitic} alerte(s) parasite(s)`);
  for (const [kind, tally] of Object.entries(perKind)) console.log(`  ${kind} : ${tally.detected}/${tally.done}`);
  for (const miss of misses) console.log(`  non signale : ${miss}`);
}

// --- Completion et survol : le service du produit, sur le texte de l'editeur -------------------------------------------
{
  const server = new LanguageServer();
  server.setCommandRegistry(registry);
  server.setReferenceCatalog(catalog);
  const tally = { hover: { done: 0, ok: 0 }, completion: { done: 0, ok: 0 } };
  const perKind: Record<string, { hover: number; hoverOk: number; completion: number; completionOk: number }> = {};
  const hoverMs: number[] = [];
  const completionMs: number[] = [];
  const misses: string[] = [];
  const byFile = new Map<string, Probe[]>();
  for (const probe of probes) byFile.set(probe.path, [...(byFile.get(probe.path) ?? []), probe]);
  for (const [path, list] of byFile) {
    const text = normalizeToLf(readBytes(path)?.toString("latin1") ?? "");
    const lines = new LineIndex(text);
    server.updateDocument(path, 1, text);
    for (const probe of list) {
      if (probe.expected === null) continue;
      const kindTally = (perKind[probe.kind] ??= { hover: 0, hoverOk: 0, completion: 0, completionOk: 0 });
      // Survol : au milieu du texte ecrit.
      const middle = probe.start + Math.max(1, Math.floor((probe.end - probe.start) / 2));
      let t = performance.now();
      const hover = server.hover(path, lines.positionAt(middle));
      hoverMs.push(performance.now() - t);
      tally.hover.done += 1;
      kindTally.hover += 1;
      if (hover?.kind === "reference" && hover.referenceKind === probe.kind && hover.record !== null) {
        tally.hover.ok += 1;
        kindTally.hoverOk += 1;
      } else if (misses.length < 10) misses.push(`survol ${path}:${probe.start} ${probe.raw}`);
      // Completion : les trois premiers caracteres du texte ecrit (guillemet ouvrant en plus pour une chaine), liste ouverte
      // par la frappe. Le nombre est celui que l'utilisateur taperait : on ne compte pas les nombres de moins de 3 chiffres.
      const inner = probe.isString ? probe.raw.slice(1, -1) : probe.raw;
      const typed = Math.min(3, inner.length);
      if (inner.length === 0) continue;
      const cursor = probe.start + (probe.isString ? 1 : 0) + typed;
      // Le texte apres le curseur est retire jusqu'au bout de la chaine : le service ne lit que ce qui precede, mais le test
      // du remplacement lit aussi le reste du mot.
      t = performance.now();
      const items = server.completion(path, lines.positionAt(cursor), { explicit: false });
      completionMs.push(performance.now() - t);
      tally.completion.done += 1;
      kindTally.completion += 1;
      if (items.some((item) => item.label === probe.expected)) {
        tally.completion.ok += 1;
        kindTally.completionOk += 1;
      } else if (misses.length < 10) misses.push(`completion ${path}:${probe.start} ${probe.raw} (attendu ${probe.expected})`);
    }
  }
  const percentile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };
  console.log(`\nSERVICE DE LANGAGE (1 argument sur ${probeStep}) :`);
  console.log(`  survol : ${tally.hover.ok}/${tally.hover.done} decrivent le bon enregistrement ; latence p50 ${percentile(hoverMs, 0.5).toFixed(3)} ms, p99 ${percentile(hoverMs, 0.99).toFixed(3)} ms, max ${Math.max(0, ...hoverMs).toFixed(2)} ms`);
  console.log(`  completion (3 premiers caracteres saisis) : ${tally.completion.ok}/${tally.completion.done} proposent le bon enregistrement ; latence p50 ${percentile(completionMs, 0.5).toFixed(3)} ms, p99 ${percentile(completionMs, 0.99).toFixed(3)} ms, max ${Math.max(0, ...completionMs).toFixed(2)} ms`);
  for (const [kind, entry] of Object.entries(perKind)) console.log(`    ${kind} : survol ${entry.hoverOk}/${entry.hover}, completion ${entry.completionOk}/${entry.completion}`);
  for (const miss of misses) console.log(`    manque : ${miss}`);
}

console.log("\nNON RESOLUS (valeur : exemples)");
for (const [key, tally] of [...tallies].sort((a, b) => b[1].unresolved - a[1].unresolved)) {
  if (tally.unresolved === 0) continue;
  console.log(`  ${key}`);
  for (const [value, examples] of [...tally.failures].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    console.log(`    ${JSON.stringify(value)} : ${examples.join(", ")}`);
  }
}
