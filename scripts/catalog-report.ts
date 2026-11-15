/**
 * Verification du catalogue de references (objets, monstres, cartes, constantes) sur un serveur rAthena reel (M4-S2).
 *
 * Usage : node --expose-gc --import tsx scripts/catalog-report.ts --server-root <racine du serveur> [--mode re|pre-re]
 *
 * Lecture seule. **Oracle independant** : un analyseur YAML complet (paquet `yaml`, dependance de developpement de ce seul
 * outil : le produit ne l'embarque pas) lit les memes fichiers dans l'ordre ou le serveur les charge, et une seconde mise en
 * oeuvre, ecrite ici, applique les regles de fusion du serveur. Le catalogue du produit (lecteur par indentation) doit donner
 * exactement les memes objets, monstres, competences, constantes et cartes.
 */
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { buildRathenaCatalog, collectRathenaDatabaseSources, detectRenewal, RATHENA_PATHS } from "@runeforge/emulator-rathena";
import type { DatabaseSourceFile } from "@runeforge/emulator-rathena";
import { parse } from "yaml";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--mode"]);
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : node --expose-gc --import tsx scripts/catalog-report.ts --server-root <racine du serveur> [--mode re|pre-re]");
  process.exit(2);
}
const serverRoot: string = root;

const readOptional = (relative: string): Buffer | null => {
  const path = join(serverRoot, relative);
  return existsSync(path) ? readFileSync(path) : null;
};
const modeOption = cli.value("--mode");
const renewal = modeOption === "re" ? true : modeOption === "pre-re" ? false : detectRenewal(readOptional(RATHENA_PATHS.renewalHeader)?.toString("latin1") ?? null).renewal;
console.log(`Serveur : ${serverRoot} | mode ${renewal ? "renewal (re)" : "pre-renewal (pre-re)"}`);

const gc = (globalThis as { gc?: () => void }).gc;
const heap = (): number => {
  gc?.();
  return process.memoryUsage().heapUsed / 1048576;
};

// --- Produit -------------------------------------------------------------------------------------------------------------

// Memoire du catalogue seul : les textes lus sont abandonnes des que le catalogue est construit (comme dans le worker).
{
  const base = heap();
  const kept = await (async () => {
    const { sources: files } = await collectRathenaDatabaseSources({ readBytes: (paths) => Promise.resolve(paths.map((path) => readOptional(path))) }, renewal, RATHENA_PATHS);
    const asText = (file: DatabaseSourceFile): { path: string; text: string } => ({ path: file.path, text: new TextDecoder().decode(file.bytes) });
    return buildRathenaCatalog({
      items: files.items.map(asText),
      mobs: files.mobs.map(asText),
      skills: files.skills.map(asText),
      constantsYaml: files.constantsYaml.map(asText),
      constantsSource: files.constantsSource === null ? null : asText(files.constantsSource),
      mapIndex: files.mapIndex.map(asText),
      randomOptions: files.randomOptions.map(asText),
    }).catalog;
  })();
  console.log(`MEMOIRE du catalogue seul (textes sources abandonnes) : ${(heap() - base).toFixed(1)} Mo${gc === undefined ? " (non mesuree : --expose-gc)" : ""} pour ${JSON.stringify(kept?.stats())}`);
}

const before = heap();
const t0 = performance.now();
const { sources, warnings: collectWarnings } = await collectRathenaDatabaseSources(
  { readBytes: (paths) => Promise.resolve(paths.map((path) => readOptional(path))) },
  renewal,
  RATHENA_PATHS,
);
const t1 = performance.now();
const decode = (file: DatabaseSourceFile): { path: string; text: string } => ({ path: file.path, text: new TextDecoder().decode(file.bytes) });
const inputs = {
  items: sources.items.map(decode),
  mobs: sources.mobs.map(decode),
  skills: sources.skills.map(decode),
  constantsYaml: sources.constantsYaml.map(decode),
  constantsSource: sources.constantsSource === null ? null : decode(sources.constantsSource),
  mapIndex: sources.mapIndex.map(decode),
  randomOptions: sources.randomOptions.map(decode),
};
const t2 = performance.now();
const built = buildRathenaCatalog(inputs);
const t3 = performance.now();
const catalog = built.catalog;
if (catalog === null) {
  console.error("Aucun catalogue : ce dossier ne contient pas de bases de serveur.");
  process.exit(2);
}
const after = heap();
const totalBytes = [...sources.items, ...sources.mobs, ...sources.skills, ...sources.constantsYaml, ...sources.mapIndex, ...sources.randomOptions].reduce((sum, file) => sum + file.bytes.length, 0) + (sources.constantsSource?.bytes.length ?? 0);

console.log(`\nFICHIERS lus (${(totalBytes / 1048576).toFixed(1)} Mo) :`);
console.log(`  objets : ${sources.items.map((file) => file.path).join(" -> ")}`);
console.log(`  monstres : ${sources.mobs.map((file) => file.path).join(" -> ")}`);
console.log(`  competences : ${sources.skills.map((file) => file.path).join(" -> ")}`);
console.log(`  constantes : ${sources.constantsYaml.map((file) => file.path).join(" -> ")} + ${sources.constantsSource?.path ?? "(code du serveur absent)"}`);
  console.log(`  cartes : ${sources.mapIndex.map((file) => file.path).join(", ")}`);
console.log(`  options aleatoires : ${sources.randomOptions.map((file) => file.path).join(" -> ")}`);
console.log(`  avertissements de decouverte : ${collectWarnings.length === 0 ? "aucun" : collectWarnings.join(" ; ")}`);
console.log(`\nCATALOGUE : ${JSON.stringify(catalog.stats())}`);
console.log(`  objets : ${built.items.entries} entrees, ${built.items.count} objets, ${built.items.skipped} ignorees, ${built.items.duplicates} doublons d'AegisName, ${built.items.unreadable.length} lignes non comprises`);
console.log(`  monstres : ${built.mobs.entries} entrees, ${built.mobs.count} monstres, ${built.mobs.skipped} ignores, ${built.mobs.unreadable.length} lignes non comprises`);
console.log(`  competences : ${built.skills.entries} entrees, ${built.skills.count} competences, ${built.skills.skipped} ignorees, ${built.skills.unreadable.length} lignes non comprises`);
console.log(`  cartes : ${built.maps.entries} lignes, ${built.maps.count} cartes`);
console.log(`  constantes : ${built.constants.source} du code du serveur, ${built.constants.yaml} de const.yml, ${built.constants.randomOptions} options aleatoires (RDMOPT_), ${built.constants.duplicates} doublons`);
console.log(`  avertissements : ${built.warnings.length === 0 ? "aucun" : built.warnings.join(" ; ")}`);
console.log(`TEMPS : lecture des fichiers ${(t1 - t0).toFixed(0)} ms, decodage ${(t2 - t1).toFixed(0)} ms, catalogue ${(t3 - t2).toFixed(0)} ms | memoire conservee ${(after - before).toFixed(1)} Mo${gc === undefined ? " (non mesuree : --expose-gc)" : ""}`);

// --- Oracle : analyseur YAML complet + regles de fusion reecrites ---------------------------------------------------------

interface YamlNode {
  [key: string]: unknown;
}
const yamlDocuments = new Map<string, YamlNode>();
function documentOf(path: string): YamlNode | null {
  const cached = yamlDocuments.get(path);
  if (cached !== undefined) return cached;
  const text = readOptional(path)?.toString("utf8");
  if (text === undefined) return null;
  // Le serveur (rapidyaml) tolere une cle repetee dans une table (`Trade:` ecrit deux fois dans un objet du serveur local) :
  // l'analyseur strict la refuse par defaut.
  const document = (parse(text, { uniqueKeys: false }) ?? {}) as YamlNode;
  yamlDocuments.set(path, document);
  return document;
}

function oracleChain(path: string, depth = 0): string[] {
  const document = documentOf(path);
  if (document === null || depth > 8) return [];
  const order = [path];
  const footer = document["Footer"] as { Imports?: { Path?: string; Mode?: string; Generator?: boolean }[] } | undefined;
  for (const entry of footer?.Imports ?? []) {
    if (entry.Path === undefined || entry.Generator === true) continue;
    if (entry.Mode !== undefined && entry.Mode !== (renewal ? "Renewal" : "Prerenewal")) continue;
    order.push(...oracleChain(entry.Path, depth + 1));
  }
  return order;
}

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const mismatches: string[] = [];
const compare = (label: string, expected: unknown, actual: unknown): void => {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatches.push(`${label} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
};

const o0 = performance.now();
compare("ordre des fichiers d'objets", oracleChain(RATHENA_PATHS.itemDb), sources.items.map((file) => file.path));
compare("ordre des fichiers de monstres", oracleChain(RATHENA_PATHS.mobDb), sources.mobs.map((file) => file.path));
compare("ordre des fichiers de competences", oracleChain(RATHENA_PATHS.skillDb), sources.skills.map((file) => file.path));
compare("ordre des fichiers de constantes", oracleChain(RATHENA_PATHS.constantDb), sources.constantsYaml.map((file) => file.path));
compare("ordre des fichiers d'options aleatoires", oracleChain(RATHENA_PATHS.randomOptionDb), sources.randomOptions.map((file) => file.path));

// Objets.
{
  const byId = new Map<number, { aegis: string; name: string; type: string | null }>();
  const owner = new Map<string, number>();
  let duplicates = 0;
  for (const path of oracleChain(RATHENA_PATHS.itemDb)) {
    const document = documentOf(path);
    if ((document?.["Header"] as YamlNode | undefined)?.["Clear"] === true) {
      byId.clear();
      owner.clear();
    }
    for (const node of (document?.["Body"] as YamlNode[] | undefined) ?? []) {
      const id = node["Id"];
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0) continue;
      const existing = byId.get(id);
      if (existing === undefined && (node["AegisName"] === undefined || node["Name"] === undefined)) continue;
      if (node["AegisName"] !== undefined) {
        const key = text(node["AegisName"]).toLowerCase();
        const holder = owner.get(key);
        if (holder !== undefined && holder !== id) {
          duplicates += 1;
          continue;
        }
        if (existing !== undefined) owner.delete(existing.aegis.toLowerCase());
        owner.set(key, id);
      }
      const record = existing ?? { aegis: "", name: "", type: null };
      if (node["AegisName"] !== undefined) record.aegis = text(node["AegisName"]);
      if (node["Name"] !== undefined) record.name = text(node["Name"]);
      if (node["Type"] !== undefined) record.type = text(node["Type"]);
      byId.set(id, record);
    }
  }
  compare("nombre d'objets", byId.size, catalog.stats().items);
  compare("doublons d'AegisName d'objets", duplicates, built.items.duplicates);
  let wrong = 0;
  for (const [id, expected] of byId) {
    const actual = catalog.itemById(id);
    if (actual === undefined || actual.aegisName !== expected.aegis || actual.name !== expected.name || (actual.type ?? null) !== expected.type) {
      wrong += 1;
      if (wrong <= 5) mismatches.push(`objet ${id} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
    }
  }
  if (wrong > 5) mismatches.push(`... et ${wrong - 5} autres objets`);
  console.log(`\nORACLE objets : ${byId.size} objets, ${duplicates} doublons d'AegisName, ${wrong} differences`);
}

// Monstres.
{
  const byId = new Map<number, { aegis: string; name: string; jname: string | null; level: number | null }>();
  for (const path of oracleChain(RATHENA_PATHS.mobDb)) {
    const document = documentOf(path);
    if ((document?.["Header"] as YamlNode | undefined)?.["Clear"] === true) byId.clear();
    for (const node of (document?.["Body"] as YamlNode[] | undefined) ?? []) {
      const id = node["Id"];
      if (typeof id !== "number" || !Number.isInteger(id) || !((id > 1000 && id < 3999) || (id > 20020 && id < 31999))) continue;
      const existing = byId.get(id);
      if (existing === undefined && (node["AegisName"] === undefined || node["Name"] === undefined)) continue;
      const record = existing ?? { aegis: "", name: "", jname: null, level: null };
      if (node["AegisName"] !== undefined) record.aegis = text(node["AegisName"]);
      if (node["Name"] !== undefined) {
        record.name = text(node["Name"]);
        if (existing === undefined && node["JapaneseName"] === undefined) record.jname = record.name;
      }
      if (node["JapaneseName"] !== undefined) record.jname = text(node["JapaneseName"]);
      if (typeof node["Level"] === "number") record.level = node["Level"];
      byId.set(id, record);
    }
  }
  compare("nombre de monstres", byId.size, catalog.stats().mobs);
  let wrong = 0;
  for (const [id, expected] of byId) {
    const actual = catalog.mobById(id);
    if (actual === undefined || actual.aegisName !== expected.aegis || actual.name !== expected.name || actual.japaneseName !== expected.jname || actual.level !== expected.level) {
      wrong += 1;
      if (wrong <= 5) mismatches.push(`monstre ${id} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
    }
  }
  console.log(`ORACLE monstres : ${byId.size} monstres, ${wrong} differences`);
}

// Competences : champs de reference, sans modeliser les effets de combat.
{
  const byId = new Map<number, { name: string; description: string; maxLevel: number }>();
  for (const path of oracleChain(RATHENA_PATHS.skillDb)) {
    const document = documentOf(path);
    if ((document?.["Header"] as YamlNode | undefined)?.["Clear"] === true) byId.clear();
    for (const row of (document?.["Body"] as YamlNode[] | undefined) ?? []) {
      const id = row["Id"];
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > 65535) continue;
      const previous = byId.get(id);
      const name = row["Name"] ?? previous?.name;
      const description = row["Description"] ?? previous?.description;
      const maxLevel = row["MaxLevel"] ?? previous?.maxLevel;
      if (typeof name !== "string" || Buffer.byteLength(name) < 1 || Buffer.byteLength(name) > 40) continue;
      if (typeof description !== "string" || Buffer.byteLength(description) > 40) continue;
      if (typeof maxLevel !== "number" || !Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 13) continue;
      byId.set(id, { name, description, maxLevel });
    }
  }
  compare("nombre de competences", byId.size, catalog.stats().skills);
  let wrong = 0;
  for (const [id, expected] of byId) {
    const actual = catalog.skillById(id);
    if (actual?.name === expected.name && actual.description === expected.description && actual.maxLevel === expected.maxLevel) continue;
    wrong += 1;
    if (wrong <= 5) mismatches.push(`competence ${id} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  }
  console.log(`ORACLE competences : ${byId.size} competences, ${wrong} differences`);
}

// Constantes du code du serveur : recherche globale (et non ligne a ligne) des appels d'exportation.
{
  const hpp = sources.constantsSource === null ? "" : new TextDecoder().decode(sources.constantsSource.bytes);
  const names = new Set<string>();
  for (const match of hpp.matchAll(/^[ \t]*export_(?:deprecated_)?constant\(\s*([A-Za-z_]\w*)\s*\)/gm)) names.add((match[1] ?? "").toLowerCase());
  for (const match of hpp.matchAll(/^[ \t]*export_(?:deprecated_constant[23]?|constant2|parameter)\(\s*"([^"]+)"/gm)) names.add((match[1] ?? "").toLowerCase());
  for (const match of hpp.matchAll(/^[ \t]*export_constant_npc\(\s*JT_(\w+)\s*\)/gm)) names.add((match[1] ?? "").toLowerCase());
  const yamlNames = new Set<string>();
  for (const path of oracleChain(RATHENA_PATHS.constantDb)) {
    for (const node of (documentOf(path)?.["Body"] as YamlNode[] | undefined) ?? []) {
      const name = /^[A-Za-z0-9/_]+/.exec(text(node["Name"]))?.[0];
      if (name !== undefined && typeof node["Value"] === "number") yamlNames.add(name.toLowerCase());
    }
  }
  // Options aleatoires : le serveur cree RDMOPT_<Option> = Id a la fin du chargement de la base (itemdb.cpp), apres les autres constantes.
  const randomOptions = new Map<number, string>();
  let randomSkipped = 0;
  let randomDuplicates = 0;
  for (const path of oracleChain(RATHENA_PATHS.randomOptionDb)) {
    const document = documentOf(path);
    if ((document?.["Header"] as YamlNode | undefined)?.["Clear"] === true) randomOptions.clear();
    for (const node of (document?.["Body"] as YamlNode[] | undefined) ?? []) {
      const id = node["Id"];
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 0xffff) {
        randomSkipped += 1;
        continue;
      }
      const existing = randomOptions.get(id);
      if (existing === undefined && (node["Option"] === undefined || node["Script"] === undefined)) {
        randomSkipped += 1;
        continue;
      }
      if (node["Option"] !== undefined) {
        const name = text(node["Option"]);
        if (name !== (existing ?? "") && [...randomOptions.values()].includes(name)) {
          randomDuplicates += 1;
          continue;
        }
        randomOptions.set(id, name);
      } else if (existing === undefined) {
        randomOptions.set(id, "");
      }
    }
  }
  const randomNames = new Map<string, number>();
  for (const [id, option] of randomOptions) if (/^[A-Za-z0-9_]+$/.test(option)) randomNames.set(("RDMOPT_" + option).toLowerCase(), id);
  const expected = new Set([...names, ...yamlNames, ...randomNames.keys()]);
  compare("nombre de constantes", expected.size, catalog.stats().constants);
  let wrongRandom = 0;
  for (const [name, id] of randomNames) {
    // Un nom deja pris par le code du serveur ou par const.yml n'est pas remplace : on ne compare que les autres.
    if (names.has(name) || yamlNames.has(name)) continue;
    if (catalog.constantByName(name)?.value !== id) {
      wrongRandom += 1;
      if (wrongRandom <= 5) mismatches.push("constante d'option aleatoire " + name + " : attendu " + id + ", obtenu " + String(catalog.constantByName(name)?.value));
    }
  }
  console.log("ORACLE options aleatoires : " + randomOptions.size + " options (" + randomNames.size + " constantes RDMOPT_), " + randomSkipped + " entrees ecartees, " + randomDuplicates + " doublons de nom, " + wrongRandom + " differences de valeur ; produit : " + built.constants.randomOptions + " constantes");
  compare("constantes RDMOPT_", randomNames.size, built.constants.randomOptions);
  let missing = 0;
  for (const name of expected) {
    if (catalog.constantByName(name) === undefined) {
      missing += 1;
      if (missing <= 5) mismatches.push(`constante absente du catalogue : ${name}`);
    }
  }
  console.log(`ORACLE constantes : ${expected.size} noms (${names.size} du code du serveur, ${yamlNames.size} de const.yml), ${missing} absentes du catalogue`);
}

// Cartes : decoupage par mots, sans l'expression reguliere du produit.
{
  const maps = new Map<number, string>();
  let last = -1;
  for (const file of sources.mapIndex) {
    for (const raw of new TextDecoder().decode(file.bytes).split(/\r?\n/)) {
      if (raw.startsWith("//")) continue;
      const parts = raw.trim().split(/\s+/).filter((part) => part !== "");
      const name = parts[0]?.slice(0, 11);
      if (name === undefined) continue;
      const explicit = parts[1] !== undefined && /^-?\d+$/.test(parts[1]);
      const index = explicit ? Number(parts[1]) : last + 1;
      maps.set(index, name.replace(/\.gat$/i, ""));
      last = index;
    }
  }
  compare("nombre de cartes", maps.size, catalog.stats().maps);
  let wrong = 0;
  for (const [index, name] of maps) if (catalog.mapByName(name)?.index !== index && !(catalog.mapByName(name) !== undefined)) wrong += 1;
  console.log(`ORACLE cartes : ${maps.size} cartes, ${wrong} absentes`);
  compare("cartes absentes", 0, wrong);
}
console.log(`(oracle : ${((performance.now() - o0) / 1000).toFixed(1)} s)`);

console.log(`\nRESULTAT : ${mismatches.length === 0 ? "le catalogue du produit est identique a l'oracle" : `${mismatches.length} difference(s)`}`);
for (const line of mismatches.slice(0, 20)) console.log(`  - ${line}`);
process.exit(mismatches.length === 0 ? 0 : 1);
