/**
 * Cartes des declarations d'un serveur rAthena reel (M4-S3a) : `RA0008` (carte absente de l'index) et `RA0015` (carte de l'index
 * que le serveur ne charge pas) sur les declarations de premier niveau (script, warp et sa destination, boutique, monstres,
 * duplicate, mapflag).
 *
 * Usage : node --import tsx scripts/maps-report.ts --server-root <racine du serveur> [--mutation-step N]
 *
 * Lecture seule. Quatre verifications :
 * 1. **Lecture des cartes chargees** : la liste que lit `resolveRathenaScripts` (`map:`, `delmap:`, `import:` de
 *    `conf/map_athena.conf`) est egale a celle d'un lecteur independant ecrit ici ;
 * 2. **Les scripts charges** : chaque declaration est confrontee a un oracle independant (l'index et la liste des cartes chargees,
 *    lus directement) : aucun faux positif ni faux negatif, et le nombre de declarations dites « sur une carte non chargee » ;
 * 3. **Les lignes mapflag** sur une carte non chargee ne sont jamais signalees (la distribution en livre pour des cartes qu'un
 *    serveur peut desactiver : le serveur local en a 26) ;
 * 4. **Mutations** : le nom de carte de une declaration sur N est remplace par une carte inconnue, puis par une carte de l'index non
 *    chargee ; la destination d'un warp par une carte inconnue : chaque alteration est signalee a l'endroit exact avec le bon
 *    code, sans alerte parasite.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { buildRathenaCatalog, buildRathenaRegistry, collectRathenaDatabaseSources, detectRenewal, RATHENA_PATHS, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import { analyzeFile } from "@runeforge/runescript-analysis";
import { LineIndex, normalizeToLf } from "@runeforge/runescript-core";
import type { SourceRange } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";
import type { TopLevelDeclaration } from "@runeforge/runescript-parser";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--mutation-step"]);
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : node --import tsx scripts/maps-report.ts --server-root <racine du serveur> [--mutation-step N]");
  process.exit(2);
}
const serverRoot: string = root;
const mutationStep = Math.max(1, Math.floor(Number(cli.value("--mutation-step")) || 60));

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
const catalog = buildRathenaCatalog({
  items: sources.items.map(decode),
  mobs: sources.mobs.map(decode),
  constantsYaml: sources.constantsYaml.map(decode),
  constantsSource: sources.constantsSource === null ? null : decode(sources.constantsSource),
  mapIndex: sources.mapIndex.map(decode),
  loadedMaps: load.maps,
}).catalog;
if (catalog === null) {
  console.error("Aucun catalogue de references dans ce serveur.");
  process.exit(2);
}
console.log(`Catalogue : ${JSON.stringify(catalog.stats())} ; cartes chargees : ${catalog.loadedMapCount} | mode ${renewal ? "renewal" : "pre-renewal"} | ${load.files.length} scripts charges`);

const failures: string[] = [];

// --- 1. Lecteur independant de `map_config_read` ----------------------------------------------------------------------------
function independentMaps(entry: string, seen = new Set<string>(), maps: string[] = []): string[] {
  if (seen.has(entry)) return maps;
  seen.add(entry);
  const text = readText(entry);
  if (text === null) return maps;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("//")) continue;
    const cut = raw.indexOf("//");
    const line = cut === -1 ? raw : raw.slice(0, cut);
    const match = /^([^:]+):\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").replace(/\.gat$/i, "");
    if (key === "map") {
      if (value.toLowerCase() === "clear") maps.length = 0;
      else maps.push(value);
    } else if (key === "delmap") {
      if (value.toLowerCase() === "all") maps.length = 0;
      else {
        const at = maps.indexOf(value);
        if (at >= 0) maps.splice(at, 1);
      }
    } else if (key === "import") independentMaps(value, seen, maps);
  }
  return maps;
}
const independent = independentMaps(RATHENA_PATHS.mapConfig);
console.log(`\n1. CARTES CHARGEES : ${load.maps.length} lues par l'adaptateur, ${independent.length} par le lecteur independant`);
if (load.maps.join("\n") !== independent.join("\n")) failures.push("la liste des cartes chargees differe de celle du lecteur independant");
const loaded = new Set(independent);

// Index des cartes, lu directement (premiere colonne de chaque ligne de `db/map_index.txt` et de son import).
const indexNames = new Set<string>();
for (const file of sources.mapIndex) {
  for (const line of new TextDecoder().decode(file.bytes).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    const name = /^(\S+)/.exec(trimmed)?.[1];
    if (name !== undefined) indexNames.add(name.replace(/\.gat$/i, ""));
  }
}
const unloadedInIndex = [...indexNames].filter((name) => !loaded.has(name)).sort();
console.log(`   index : ${indexNames.size} cartes, dont ${unloadedInIndex.length} que le serveur ne charge pas (${unloadedInIndex.slice(0, 6).join(", ")}...)`);

// --- 2 et 3. Chaque declaration des scripts charges contre un oracle independant -----------------------------------------
interface Placed {
  readonly path: string;
  readonly text: string;
  readonly map: string;
  readonly range: SourceRange;
  /** `declaration` : en-tete d'une declaration ; `destination` : destination d'un warp ; `mapflag`. */
  readonly role: "declaration" | "destination" | "mapflag";
}
const placed: Placed[] = [];
const texts = new Map<string, string>();
const baselines = new Map<string, number>();
const t0 = performance.now();
let declarations = 0;
const counts = { checked: 0, unknown: 0, notLoaded: 0, mapflagOnUnloaded: 0, falsePositive: 0, falseNegative: 0 };
const examples: string[] = [];
for (const path of load.files) {
  const bytes = readBytes(path);
  if (bytes === null) continue;
  const text = normalizeToLf(bytes.toString("latin1"));
  texts.set(path, text);
  const parsed = parse(text);
  const analysis = analyzeFile(parsed, path, { commands: registry, references: catalog });
  const mapDiagnostics = analysis.diagnostics.filter((d) => d.code === "RA0008" || d.code === "RA0015");
  baselines.set(path, mapDiagnostics.length);
  const reported = new Map<number, string>();
  for (const d of mapDiagnostics) reported.set(d.range.start, d.code);
  const lines = new LineIndex(text);

  const consider = (map: string, range: SourceRange, role: Placed["role"]): void => {
    placed.push({ path, text, map, range, role });
    counts.checked += 1;
    const name = map.replace(/\.gat$/i, "");
    // Oracle : l'index d'abord (erreur du serveur), puis, pour une declaration (pas un mapflag, pas une destination), la liste chargee.
    let expected: string | null = null;
    if (!indexNames.has(name)) expected = "RA0008";
    else if (role === "declaration" && !loaded.has(name)) expected = "RA0015";
    if (expected === "RA0008") counts.unknown += 1;
    if (expected === "RA0015") counts.notLoaded += 1;
    if (role === "mapflag" && indexNames.has(name) && !loaded.has(name)) counts.mapflagOnUnloaded += 1;
    const actual = reported.get(range.start) ?? null;
    if (actual !== expected) {
      if (expected === null) counts.falsePositive += 1;
      else counts.falseNegative += 1;
      if (examples.length < 8) examples.push(`${path}:${lines.positionAt(range.start).line + 1} ${map} : attendu ${expected ?? "rien"}, obtenu ${actual ?? "rien"}`);
    }
  };
  for (const declaration of parsed.ast.declarations as readonly TopLevelDeclaration[]) {
    declarations += 1;
    switch (declaration.kind) {
      case "NpcDeclaration":
      case "ShopDeclaration":
      case "MonsterDeclaration":
      case "DuplicateDeclaration":
        if (declaration.location !== null) consider(declaration.location.map, declaration.location.mapRange, "declaration");
        break;
      case "WarpDeclaration":
        if (declaration.location !== null) consider(declaration.location.map, declaration.location.mapRange, "declaration");
        if (declaration.destination !== null) consider(declaration.destination.map, declaration.destination.mapRange, "destination");
        break;
      case "MapflagDeclaration":
        if (declaration.map !== null) consider(declaration.map.text, declaration.map.range, "mapflag");
        break;
      default:
        break;
    }
  }
}
const elapsed = performance.now() - t0;
console.log(`\n2. SCRIPTS CHARGES : ${texts.size} fichiers, ${declarations} declarations, ${counts.checked} noms de carte confrontes a l'oracle en ${(elapsed / 1000).toFixed(1)} s`);
console.log(`   carte absente de l'index : ${counts.unknown} | declaration sur une carte non chargee : ${counts.notLoaded} | faux positifs : ${counts.falsePositive} | faux negatifs : ${counts.falseNegative}`);
console.log(`3. LIGNES MAPFLAG sur une carte de l'index non chargee : ${counts.mapflagOnUnloaded} (aucune n'est signalee : verifie par l'oracle ci-dessus)`);
for (const example of examples) console.log(`   ecart : ${example}`);
if (counts.falsePositive + counts.falseNegative > 0) failures.push(`${counts.falsePositive} faux positifs et ${counts.falseNegative} faux negatifs sur les declarations`);

// --- 4. Mutations ---------------------------------------------------------------------------------------------------------
{
  const unknownName = "zz_unknown";
  const notLoadedName = unloadedInIndex[0] ?? "";
  const tally = { unknown: { done: 0, ok: 0 }, notLoaded: { done: 0, ok: 0 }, destination: { done: 0, ok: 0 }, mapflagBenign: { done: 0, ok: 0 }, wrongOrParasitic: 0 };
  const misses: string[] = [];
  placed.forEach((item, index) => {
    if (index % mutationStep !== 0) return;
    const baseline = baselines.get(item.path) ?? 0;
    const original = item.text.slice(item.range.start, item.range.end);
    if (original !== item.map) return; // le nom ecrit n'est pas celui de l'AST (rien d'inattendu dans ce corpus)
    const mutate = (replacement: string): { code: string | null; count: number } => {
      const changed = item.text.slice(0, item.range.start) + replacement + item.text.slice(item.range.end);
      const found = analyzeFile(parse(changed), item.path, { commands: registry, references: catalog }).diagnostics.filter((d) => d.code === "RA0008" || d.code === "RA0015");
      const here = found.find((d) => d.range.start === item.range.start);
      return { code: here?.code ?? null, count: found.length - (here === undefined ? 0 : 1) };
    };
    // Une carte inconnue est toujours signalee (declaration, destination, mapflag).
    const unknown = mutate(unknownName);
    tally.unknown.done += 1;
    if (unknown.code === "RA0008") tally.unknown.ok += 1;
    else if (misses.length < 10) misses.push(`inconnue ${item.path}:${item.range.start} ${item.map} -> ${unknownName} : ${unknown.code ?? "rien"}`);
    if (unknown.count > baseline - (baselines.get(item.path) === undefined ? 0 : 0)) tally.wrongOrParasitic += Math.max(0, unknown.count - baseline);
    if (item.role === "destination") {
      tally.destination.done += 1;
      if (unknown.code === "RA0008") tally.destination.ok += 1;
      return;
    }
    // Une carte de l'index non chargee : RA0015 sur une declaration, rien sur un mapflag.
    if (notLoadedName !== "") {
      const notLoaded = mutate(notLoadedName);
      if (item.role === "declaration") {
        tally.notLoaded.done += 1;
        if (notLoaded.code === "RA0015") tally.notLoaded.ok += 1;
        else if (misses.length < 10) misses.push(`non chargee ${item.path}:${item.range.start} ${item.map} -> ${notLoadedName} : ${notLoaded.code ?? "rien"}`);
      } else {
        tally.mapflagBenign.done += 1;
        if (notLoaded.code === null) tally.mapflagBenign.ok += 1;
        else if (misses.length < 10) misses.push(`mapflag ${item.path}:${item.range.start} ${item.map} -> ${notLoadedName} signale a tort : ${notLoaded.code}`);
      }
      tally.wrongOrParasitic += Math.max(0, notLoaded.count - baseline);
    }
  });
  const line = (name: string, entry: { done: number; ok: number }): string => `${name} ${entry.ok}/${entry.done}`;
  console.log(`\n4. MUTATIONS (1 nom de carte sur ${mutationStep}) : ${line("carte inconnue signalee (RA0008)", tally.unknown)} | ${line("dont destinations de warp", tally.destination)} | ${line("carte non chargee signalee (RA0015)", tally.notLoaded)} | ${line("mapflag sur carte non chargee non signale", tally.mapflagBenign)} | alertes parasites : ${tally.wrongOrParasitic}`);
  for (const miss of misses) console.log(`   non conforme : ${miss}`);
  for (const [name, entry] of Object.entries({ unknown: tally.unknown, notLoaded: tally.notLoaded, destination: tally.destination, mapflagBenign: tally.mapflagBenign })) {
    if (entry.ok !== entry.done) failures.push(`mutations « ${name} » : ${entry.ok}/${entry.done}`);
  }
  if (tally.wrongOrParasitic > 0) failures.push(`${tally.wrongOrParasitic} alerte(s) parasite(s) apres mutation`);
}

console.log(failures.length === 0 ? "\nTOUT EST CONFORME" : `\nECHECS :\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
