/**
 * Assistants de NPC (M6-S1, RF-017) confrontes a un serveur rAthena reel : les scripts generes sont-ils valables pour LUI ?
 *
 * Usage : node --import tsx scripts/wizards-report.ts --server-root <racine du serveur> [--samples N] [--seed N]
 *
 * Lecture seule. Pour chaque assistant, des saisies valides tirees au hasard (cartes chargees, objets, sprites et prix reels du
 * serveur ; noms, textes avec guillemets, barres obliques, accents et couleurs ^RRGGBB) donnent un script, qui doit :
 * 1. etre analyse **sans aucun diagnostic** par le produit, avec le registre de commandes et le catalogue du serveur (syntaxe,
 *    semantique locale, commande inconnue, nombre d'arguments, carte/objet/monstre introuvable, carte non chargee) ;
 * 2. etre accepte par un **modele independant de l'analyse de l'en-tete du serveur** (`npc_parse_warp`, `npc_parse_shop` et
 *    `npc_parsesrcfile`, dont les formats `sscanf` sont reecrits ici) et lui rendre les valeurs saisies ;
 * 3. produire une declaration du bon type, au bon endroit, pour le bon nom (AST du produit).
 * Puis des **temoins negatifs** : chaque saisie valide est abimee (entier, carte, texte avec tabulation, liste d'objets...) et
 * l'assistant doit refuser, sur le bon champ, sans rien generer.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import {
  buildRathenaCatalog,
  buildRathenaRegistry,
  collectRathenaDatabaseSources,
  detectRenewal,
  RATHENA_PATHS,
  readItemDatabase,
  resolveRathenaScripts,
} from "@runeforge/emulator-rathena";
import { analyzeFile } from "@runeforge/runescript-analysis";
import { normalizeToLf } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";
import { initialValues, NPC_WIZARDS, runWizard, validateWizard } from "@runeforge/npc-templates";
import type { WizardId } from "@runeforge/npc-templates";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--samples", "--seed"]);
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : node --import tsx scripts/wizards-report.ts --server-root <racine du serveur> [--samples N] [--seed N]");
  process.exit(2);
}
const serverRoot: string = root;
const samples = Math.max(1, Math.floor(Number(cli.value("--samples")) || 400));
let state = Math.floor(Number(cli.value("--seed")) || 20260606) >>> 0;

const readBytes = (relative: string): Buffer | null => {
  const path = join(serverRoot, relative);
  return existsSync(path) ? readFileSync(path) : null;
};
const readText = (relative: string): string | null => readBytes(relative)?.toString("latin1") ?? null;

// --- Serveur -------------------------------------------------------------------------------------------------------------
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
const { sources } = await collectRathenaDatabaseSources({ readBytes: (paths) => Promise.resolve(paths.map(readBytes)) }, renewal, RATHENA_PATHS);
const decode = (file: { path: string; bytes: Uint8Array }): { path: string; text: string } => ({ path: file.path, text: new TextDecoder().decode(file.bytes) });
const catalog = buildRathenaCatalog({
  items: sources.items.map(decode),
  mobs: sources.mobs.map(decode),
  constantsYaml: sources.constantsYaml.map(decode),
  constantsSource: sources.constantsSource === null ? null : decode(sources.constantsSource),
  mapIndex: sources.mapIndex.map(decode),
  randomOptions: sources.randomOptions.map(decode),
  loadedMaps: load.maps,
}).catalog;
if (catalog === null) {
  console.error("Aucun catalogue de references dans ce serveur.");
  process.exit(2);
}
const itemIds = readItemDatabase(sources.items.map(decode)).items.map((item) => item.id);
const maps = load.maps.filter((name) => /^[A-Za-z0-9_@#]{1,11}$/.test(name) && catalog.mapByName(name) !== undefined);
console.log(`Serveur : ${registry.stats().total} commandes | ${itemIds.length} objets | ${maps.length} cartes chargees (sur ${load.maps.length}) | mode ${renewal ? "renewal" : "pre-renewal"}`);
if (maps.length === 0 || itemIds.length === 0) {
  console.error("Ni carte chargee ni objet : rien a tirer au sort.");
  process.exit(2);
}

// --- Tirage --------------------------------------------------------------------------------------------------------------
const random = (): number => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 0x100000000;
};
const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)] as T;

const NAMES = ["Warper", "Kafra", "Merchant", "Healer", "Guide", "Sage", "Guard", "Passeur", "Marchand", "Soigneuse"];
const TEXTS = [
  "Hello there.",
  'He said "hello" to me.',
  "C:\\temp\\file and a backslash \\",
  "100% sure, 50/50 chance; (yes), no?",
  "^0000FFBlue^000000 text and ^FF0000red^000000.",
  "Caf\u00e9 cr\u00e8me, \u00e7a va ?",
  "Where would you like to go?",
  "A very long sentence that keeps going to see that long texts are written without being cut or wrapped by the generator.",
];
const SPRITES = ["4_M_01", "4_F_01", "4_M_KID1", "HIDDEN_NPC", "FAKE_NPC", "111", "1002", "-1", "4_M_ALCHE_A", "4_F_KAFRA1"];
const LABELS = ["Yes", "Take me there", "Heal me", "Oui, allons-y", "Go", "Quoi? Non", "OK", "Not now", "No, thanks", "Plus tard"];

function nameValue(): string {
  let name = `${pick(NAMES)}${random() < 0.3 ? ` ${int(1, 99)}` : ""}`;
  if (random() < 0.2) name += `#hidden${int(1, 9)}`;
  else if (random() < 0.15) name += `::unique_${int(1, 99999)}`;
  return name;
}

function validInput(id: WizardId): Record<string, string> {
  const values = initialValues(id);
  values["name"] = nameValue();
  values["map"] = pick(maps);
  values["x"] = String(int(0, 400));
  values["y"] = String(int(0, 400));
  values["facing"] = String(int(0, 7));
  if ("sprite" in values) values["sprite"] = pick(SPRITES);
  if ("destMap" in values) {
    values["destMap"] = pick(maps);
    values["destX"] = String(int(0, 400));
    values["destY"] = String(int(0, 400));
  }
  if ("areaX" in values) {
    values["areaX"] = String(int(0, 100));
    values["areaY"] = String(int(0, 100));
  }
  if ("cost" in values) values["cost"] = random() < 0.5 ? "0" : String(int(1, 2_000_000));
  if ("minLevel" in values) values["minLevel"] = random() < 0.5 ? "0" : String(int(1, 999));
  if ("healHp" in values) {
    values["healHp"] = String(int(0, 100));
    values["healSp"] = String(int(0, 100));
  }
  for (const key of ["greeting", "tooLow", "noMoney", "goodbye", "done"]) if (key in values) values[key] = pick(TEXTS);
  for (const key of ["yes", "no"]) if (key in values) values[key] = pick(LABELS);
  if (id === "shop") {
    const count = int(1, 12);
    const chosen = new Set<number>();
    while (chosen.size < count) chosen.add(pick(itemIds));
    values["items"] = [...chosen]
      .map((item) => {
        const draw = random();
        return draw < 0.2 ? String(item) : draw < 0.3 ? `${item} 0` : draw < 0.4 ? `${item}:-1` : `${item}${pick([" ", ":", ","])}${int(1, 500_000)}`;
      })
      .join(random() < 0.5 ? "\n" : "\r\n");
  }
  return values;
}

// --- Modele independant de l'analyse des en-tetes du serveur --------------------------------------------------------------
// `npc_parsesrcfile` coupe la ligne en quatre mots separes par des tabulations ; chaque type relit ensuite w1 et w4 avec `sscanf`.
interface Header {
  readonly w1: [string, number, number, number];
  readonly w2: string;
  readonly w3: string;
  readonly w4: string;
}

function parseHeader(line: string): Header | null {
  const fields = line.split("\t");
  if (fields.length !== 4) return null;
  const [w1, w2, w3, w4] = fields as [string, string, string, string];
  // `%15[^,],%6hd,%6hd,%4hd`
  const m = /^([^,]{1,15}),(-?\d{1,6}),(-?\d{1,6}),(-?\d{1,4})$/.exec(w1);
  if (m === null || w3 === "" || w4 === "") return null;
  return { w1: [m[1] as string, Number(m[2]), Number(m[3]), Number(m[4])], w2, w3, w4 };
}

/** `npc_parse_warp` : w4 = `%6hd,%6hd,%15[^,],%6hd,%6hd`. */
function serverReadsWarp(header: Header): { span: [number, number]; to: string; at: [number, number] } | null {
  if (header.w2 !== "warp") return null;
  const m = /^(-?\d{1,6}),(-?\d{1,6}),([^,]{1,15}),(-?\d{1,6}),(-?\d{1,6})$/.exec(header.w4);
  return m === null ? null : { span: [Number(m[1]), Number(m[2])], to: m[3] as string, at: [Number(m[4]), Number(m[5])] };
}

/** `npc_parse_shop` : w4 contient une virgule, puis un `,%u:%11d` par objet. */
function serverReadsShop(header: Header): { sprite: string; items: [number, number][] } | null {
  if (header.w2 !== "shop" || !header.w4.includes(",")) return null;
  const [sprite, ...rest] = header.w4.split(",");
  const items: [number, number][] = [];
  for (const part of rest) {
    const m = /^(\d+):(-?\d{1,11})$/.exec(part);
    if (m === null) return null;
    items.push([Number(m[1]), Number(m[2])]);
  }
  return sprite === undefined || items.length === 0 ? null : { sprite, items };
}

/** Ce que l'utilisateur a demande pour les objets, relu sans le code du produit. */
function expectedItems(text: string): [number, number][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const m = /^(\d+)(?:\s*[:,\s]\s*(-?\d+))?$/.exec(line);
      return [Number(m?.[1]), m?.[2] === undefined ? -1 : Number(m[2])] as [number, number];
    });
}

// --- Verifications -------------------------------------------------------------------------------------------------------
const failures: string[] = [];
const fail = (message: string): void => {
  if (failures.length < 25) failures.push(message);
};

const TYPES: Record<WizardId, string> = { "warp-portal": "warp", "warp-npc": "script", shop: "shop", healer: "script" };
const totals = { scripts: 0, bytes: 0, warnings: 0, diagnostics: 0, mismatches: 0 };
const t0 = performance.now();

console.log("");
for (const wizard of NPC_WIZARDS) {
  let scripts = 0;
  let warnings = 0;
  for (let round = 0; round < samples; round += 1) {
    const values = validInput(wizard.id);
    const result = runWizard(wizard.id, values);
    if (result.source === null) {
      fail(`${wizard.id} : saisie valide refusee ${JSON.stringify(result.problems)} pour ${JSON.stringify(values)}`);
      totals.mismatches += 1;
      continue;
    }
    scripts += 1;
    warnings += result.problems.length;
    totals.bytes += result.source.length;
    const source = normalizeToLf(result.source);

    // 1. Analyse du produit : aucun diagnostic.
    const parsed = parse(source);
    const analysis = analyzeFile(parsed, "wizard.txt", { commands: registry, references: catalog });
    const diagnostics = [...parsed.diagnostics, ...analysis.diagnostics].map((diagnostic) => diagnostic.code);
    for (const call of analysis.unknownCalls) diagnostics.push(`RA0001:${call.name}`);
    if (diagnostics.length > 0) {
      totals.diagnostics += diagnostics.length;
      fail(`${wizard.id} : diagnostics ${diagnostics.join(",")} pour ${JSON.stringify(source)}`);
    }

    // 3. Declaration du bon type, au bon endroit, pour le bon nom.
    const declaration = analysis.declarations[0];
    const expectedName = (values["name"] ?? "").trim();
    if (
      analysis.declarations.length !== 1 ||
      declaration?.kind !== "npc" ||
      declaration.npcType !== TYPES[wizard.id] ||
      declaration.map !== values["map"] ||
      declaration.x !== Number(values["x"]) ||
      declaration.y !== Number(values["y"]) ||
      // Le nom que garde le serveur est ce qui precede `::` (le suffixe `#...` en fait partie : seul le client le cache).
      declaration.displayName !== (expectedName.split("::")[0] ?? "")
    ) {
      totals.mismatches += 1;
      fail(`${wizard.id} : declaration inattendue ${JSON.stringify(declaration)} pour ${JSON.stringify(values)}`);
    }

    // 2. Modele du serveur : l'en-tete est accepte et rend ce qui a ete saisi.
    const first = source.split("\n")[0] ?? "";
    const header = parseHeader(first);
    if (header === null || header.w1[0] !== values["map"] || header.w1[1] !== Number(values["x"]) || header.w1[2] !== Number(values["y"]) || header.w1[3] !== Number(values["facing"]) || header.w2 !== TYPES[wizard.id] || header.w3 !== expectedName) {
      totals.mismatches += 1;
      fail(`${wizard.id} : en-tete refuse ou different : ${JSON.stringify(first)}`);
    } else if (wizard.id === "warp-portal") {
      const warp = serverReadsWarp(header);
      if (warp === null || warp.span[0] !== Number(values["areaX"]) || warp.span[1] !== Number(values["areaY"]) || warp.to !== values["destMap"] || warp.at[0] !== Number(values["destX"]) || warp.at[1] !== Number(values["destY"])) {
        totals.mismatches += 1;
        fail(`warp-portal : destination refusee ou differente : ${JSON.stringify(first)}`);
      }
    } else if (wizard.id === "shop") {
      const shop = serverReadsShop(header);
      const wanted = expectedItems(values["items"] ?? "");
      if (shop === null || shop.sprite !== values["sprite"] || JSON.stringify(shop.items) !== JSON.stringify(wanted)) {
        totals.mismatches += 1;
        fail(`shop : liste d'objets refusee ou differente : ${JSON.stringify(first)}`);
      }
      // Les objets existent dans la base du serveur (sinon `npc_parse_shop` les ignore avec un avertissement).
      for (const [item] of wanted) if (catalog.itemById(item) === undefined) fail(`shop : objet ${item} absent de la base`);
    } else {
      if (!header.w4.endsWith(",{") || header.w4.slice(0, -2) !== values["sprite"]) {
        totals.mismatches += 1;
        fail(`${wizard.id} : sprite ou accolade differents : ${JSON.stringify(first)}`);
      }
    }
  }
  totals.scripts += scripts;
  totals.warnings += warnings;
  console.log(`${wizard.id.padEnd(12)} ${scripts}/${samples} scripts generes, ${warnings} avertissement(s) de saisie (prix a 0, doublons...)`);
}
console.log(`\n1-3. SCRIPTS GENERES : ${totals.scripts} scripts (${(totals.bytes / 1024).toFixed(0)} Kio) en ${((performance.now() - t0) / 1000).toFixed(1)} s : ${totals.diagnostics} diagnostic(s) du produit, ${totals.mismatches} ecart(s) avec le modele du serveur`);

// --- Temoins negatifs ----------------------------------------------------------------------------------------------------
{
  const spoilers: { label: string; field: (id: WizardId) => string | null; value: string; expected: string }[] = [
    { label: "x non entier", field: () => "x", value: "12a", expected: "notInteger" },
    { label: "x hors borne", field: () => "x", value: "512", expected: "outOfRange" },
    { label: "direction hors borne", field: () => "facing", value: "9", expected: "outOfRange" },
    { label: "carte trop longue", field: () => "map", value: "carte_de_douze", expected: "badMap" },
    { label: "carte avec une virgule", field: () => "map", value: "a,b", expected: "badMap" },
    { label: "nom vide", field: () => "name", value: "   ", expected: "required" },
    { label: "nom avec tabulation", field: () => "name", value: "a\tb", expected: "badCharacters" },
    { label: "nom trop long", field: () => "name", value: "n".repeat(51), expected: "tooLong" },
    { label: "sprite invalide", field: (id) => (id === "warp-portal" ? null : "sprite"), value: "pas un sprite!", expected: "badSprite" },
    { label: "destination absente", field: (id) => (id === "warp-portal" || id === "warp-npc" ? "destMap" : null), value: "", expected: "required" },
    { label: "destination hors borne", field: (id) => (id === "warp-portal" || id === "warp-npc" ? "destY" : null), value: "-1", expected: "outOfRange" },
    { label: "cout non entier", field: (id) => (id === "warp-npc" || id === "healer" ? "cost" : null), value: "mille", expected: "notInteger" },
    { label: "texte avec saut de ligne", field: (id) => (id === "warp-npc" || id === "healer" ? "greeting" : null), value: "a\nb", expected: "badCharacters" },
    { label: "choix avec deux-points", field: (id) => (id === "warp-npc" || id === "healer" ? "yes" : null), value: "Oui: allons-y", expected: "colon" },
    { label: "liste d'objets vide", field: (id) => (id === "shop" ? "items" : null), value: " \n ", expected: "itemsRequired" },
    { label: "objet illisible", field: (id) => (id === "shop" ? "items" : null), value: "501 50\nrouge", expected: "badItemLine" },
    { label: "prix hors borne", field: (id) => (id === "shop" ? "items" : null), value: "501 99999999999", expected: "priceRange" },
    { label: "identifiant d'objet nul", field: (id) => (id === "shop" ? "items" : null), value: "0 5", expected: "itemIdRange" },
  ];
  let done = 0;
  let refused = 0;
  const missed: string[] = [];
  for (const spoiler of spoilers) {
    for (const wizard of NPC_WIZARDS) {
      const field = spoiler.field(wizard.id);
      if (field === null) continue;
      for (let round = 0; round < Math.max(1, Math.floor(samples / 20)); round += 1) {
        const values = { ...validInput(wizard.id), [field]: spoiler.value };
        const result = runWizard(wizard.id, values);
        const problems = validateWizard(wizard.id, values);
        done += 1;
        const reported = problems.some((problem) => problem.severity === "error" && problem.field === field && problem.code === spoiler.expected);
        if (result.source === null && reported) refused += 1;
        else if (missed.length < 6) missed.push(`${wizard.id} ${spoiler.label} (${field}=${JSON.stringify(spoiler.value)}) : ${result.source === null ? "refus sans le bon motif" : "script genere"}`);
      }
    }
  }
  console.log(`\n4. TEMOINS NEGATIFS : ${refused}/${done} saisies abimees refusees sur le bon champ, avec le bon motif, sans rien generer`);
  for (const line of missed) console.log(`   non detecte : ${line}`);
  if (refused !== done) fail(`${done - refused} saisie(s) abimee(s) non refusee(s) correctement`);
}

if (totals.scripts !== samples * NPC_WIZARDS.length) fail(`${samples * NPC_WIZARDS.length - totals.scripts} saisie(s) valide(s) refusee(s)`);
console.log(failures.length === 0 ? "\nTOUT EST CONFORME" : `\nECHECS :\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
