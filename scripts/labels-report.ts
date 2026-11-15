/**
 * Labels nommes comme une commande, une constante ou un parametre du serveur (M4-S3b, `RA0014`) sur un serveur rAthena reel.
 *
 * Usage : node --import tsx scripts/labels-report.ts --server-root <racine du serveur> [--mutation-step N]
 *
 * Lecture seule. `set_label` (`script.cpp`) refuse un label dont le nom est deja celui d'une constante (`C_INT`), d'un parametre
 * (`C_PARAM`) ou d'une commande (`C_FUNC`) du serveur. Deux verifications :
 * 1. **Aucune fausse alerte** : les scripts que le serveur charge se chargent sans cette erreur ; chacun de leurs labels et de leurs
 *    fonctions locales doit donc etre accepte (aucun `RA0014`) ;
 * 2. **Mutations** : le nom de un label sur N est remplace par une commande du serveur, une constante, puis un parametre : chaque
 *    alteration est signalee a l'endroit exact, sans alerte parasite ; le meme nom en majuscules est signale aussi.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { buildRathenaCatalog, buildRathenaRegistry, collectRathenaDatabaseSources, detectRenewal, RATHENA_PATHS, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import { analyzeFile } from "@runeforge/runescript-analysis";
import { normalizeToLf } from "@runeforge/runescript-core";
import type { SourceRange } from "@runeforge/runescript-core";
import { childrenOf, parse } from "@runeforge/runescript-parser";
import type { AstNode } from "@runeforge/runescript-parser";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--mutation-step"]);
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : node --import tsx scripts/labels-report.ts --server-root <racine du serveur> [--mutation-step N]");
  process.exit(2);
}
const serverRoot: string = root;
const mutationStep = Math.max(1, Math.floor(Number(cli.value("--mutation-step")) || 25));

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
const catalog = buildRathenaCatalog({
  items: sources.items.map(decode),
  mobs: sources.mobs.map(decode),
  constantsYaml: sources.constantsYaml.map(decode),
  constantsSource: sources.constantsSource === null ? null : decode(sources.constantsSource),
  mapIndex: sources.mapIndex.map(decode),
}).catalog;
if (catalog === null) {
  console.error("Aucun catalogue de references dans ce serveur.");
  process.exit(2);
}
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

// Noms servant aux mutations : des commandes de la table du serveur (non conditionnelles), des constantes et des parametres.
const commandNames = ["mes", "menu", "next", "close", "select", "getitem", "warp", "set", "callfunc", "input"].filter((name) => {
  const definition = registry.get(name);
  return definition !== undefined && !definition.conditional && definition.sources.some((source) => source.kind === "server-source");
});
const constantNames = ["Job_Alchemist", "Job_Novice", "Sex_Male", "PC_BASELEVEL"].filter((name) => catalog.constantByName(name) !== undefined && catalog.constantByName(name)?.parameter === false);
const parameterNames = ["BaseLevel", "Zeny", "JobLevel", "Sex"].filter((name) => catalog.constantByName(name)?.parameter === true);
console.log(`Registre : ${registry.stats().total} commandes ; catalogue : ${JSON.stringify(catalog.stats())} | ${load.files.length} scripts charges`);
console.log(`Noms de mutation : commandes ${commandNames.join(", ")} ; constantes ${constantNames.join(", ")} ; parametres ${parameterNames.join(", ")}`);

interface LabelSite {
  readonly path: string;
  readonly text: string;
  readonly name: string;
  readonly range: SourceRange;
}
const sites: LabelSite[] = [];
const failures: string[] = [];
let falseAlerts = 0;
const falseExamples: string[] = [];
const t0 = performance.now();
for (const path of load.files) {
  const bytes = readBytes(path);
  if (bytes === null) continue;
  const text = normalizeToLf(bytes.toString("latin1"));
  const parsed = parse(text);
  const analysis = analyzeFile(parsed, path, { commands: registry, references: catalog });
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.code !== "RA0014") continue;
    falseAlerts += 1;
    if (falseExamples.length < 8) falseExamples.push(`${path}:${diagnostic.range.start} ${text.slice(diagnostic.range.start, diagnostic.range.end)}`);
  }
  const stack: AstNode[] = [parsed.ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.kind === "LabelStatement") sites.push({ path, text, name: node.name, range: node.nameRange });
    else if (node.kind === "FunctionStatement" && node.body !== null) sites.push({ path, text, name: node.name, range: node.nameRange });
    for (const child of childrenOf(node)) stack.push(child);
  }
}
const elapsed = performance.now() - t0;
console.log(`\n1. SCRIPTS CHARGES : ${load.files.length} fichiers, ${sites.length} labels et fonctions locales verifies en ${(elapsed / 1000).toFixed(1)} s : ${falseAlerts} RA0014`);
for (const example of falseExamples) console.log(`   alerte : ${example}`);
if (falseAlerts > 0) failures.push(`${falseAlerts} RA0014 sur des scripts que le serveur charge sans erreur`);

// --- Mutations ------------------------------------------------------------------------------------------------------------
{
  const kinds: { label: string; names: string[] }[] = [
    { label: "commande", names: commandNames },
    { label: "constante", names: constantNames },
    { label: "parametre", names: parameterNames },
  ];
  const tally = new Map<string, { done: number; ok: number }>();
  let parasitic = 0;
  const misses: string[] = [];
  sites.forEach((site, index) => {
    if (index % mutationStep !== 0) return;
    const original = site.text.slice(site.range.start, site.range.end);
    if (original !== site.name) return;
    kinds.forEach((kind, kindIndex) => {
      const name = kind.names[(index / mutationStep + kindIndex) % Math.max(1, kind.names.length)];
      if (name === undefined) return;
      for (const written of [name, name.toUpperCase()]) {
        const changed = site.text.slice(0, site.range.start) + written + site.text.slice(site.range.end);
        const found = analyzeFile(parse(changed), site.path, { commands: registry, references: catalog }).diagnostics.filter((d) => d.code === "RA0014");
        const here = found.find((d) => d.range.start === site.range.start && d.range.end === site.range.start + written.length);
        const entry = tally.get(kind.label) ?? { done: 0, ok: 0 };
        entry.done += 1;
        if (here !== undefined) entry.ok += 1;
        else if (misses.length < 10) misses.push(`${site.path}:${site.range.start} ${site.name} -> ${written} (${kind.label})`);
        tally.set(kind.label, entry);
        parasitic += found.length - (here === undefined ? 0 : 1);
      }
    });
  });
  const summary = [...tally].map(([label, entry]) => `${label} ${entry.ok}/${entry.done}`).join(" | ");
  console.log(`\n2. MUTATIONS (1 label sur ${mutationStep}, nom puis nom en majuscules) : ${summary} | alertes parasites : ${parasitic}`);
  for (const miss of misses) console.log(`   non signale : ${miss}`);
  for (const [label, entry] of tally) if (entry.ok !== entry.done) failures.push(`mutations « ${label} » : ${entry.ok}/${entry.done}`);
  if (parasitic > 0) failures.push(`${parasitic} alerte(s) parasite(s) apres mutation`);
  if ([...tally.values()].every((entry) => entry.done === 0)) failures.push("aucune mutation effectuee");
}

console.log(failures.length === 0 ? "\nTOUT EST CONFORME" : `\nECHECS :\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
