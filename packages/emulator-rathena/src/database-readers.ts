/**
 * Lecture des bases d'un serveur rAthena : objets, monstres, constantes et index des cartes. Les regles de fusion sont celles
 * du serveur (verifiees dans `itemdb.cpp`, `mob.cpp`, `script.cpp`, `mapindex.cpp` du serveur local) :
 * - une entree identifiee par `Id` cree l'enregistrement s'il n'existe pas (il lui faut alors `AegisName` et `Name`) ; sinon
 *   elle n'en modifie que les champs qu'elle ecrit ;
 * - une entree d'objet dont l'`AegisName` est deja celui d'un **autre** objet est ignoree en entier ;
 * - les fichiers sont lus dans l'ordre de chargement du serveur (un fichier avant ses imports) ; `Header: Clear: true`
 *   efface ce qui precede.
 */
import { normalizeMapName } from "@runeforge/emulator-core";
import type { ConstantRecord, ItemRecord, MapRecord, MobRecord, SkillRecord } from "@runeforge/emulator-core";
import { scanYamlDatabase } from "./yaml-db";
import type { YamlEntry } from "./yaml-db";

/** Un fichier lu : chemin relatif a la racine du serveur et texte decode. */
export interface DatabaseText {
  readonly path: string;
  readonly text: string;
}

export interface DatabaseReadReport {
  readonly files: number;
  /** Entrees rencontrees dans les fichiers. */
  readonly entries: number;
  /** Entrees ignorees : sans identifiant valide, ou nouvelles sans les champs obligatoires. */
  readonly skipped: number;
  /** Entrees ignorees parce que leur nom est deja pris par un autre identifiant. */
  readonly duplicates: number;
  /** Lignes que la lecture n'a pas comprises (premieres seulement), `fichier:ligne`. */
  readonly unreadable: readonly string[];
}

const MAX_REPORTED_UNREADABLE = 10;

/**
 * Copie une chaine extraite du texte d'un fichier. V8 represente une sous-chaine de 13 caracteres ou plus par un renvoi vers la
 * chaine d'origine : conserver un seul nom retiendrait tout le texte du fichier (5,8 Mo pour les equipements) en memoire.
 * Meme precaution que dans l'analyse (DEC-020).
 */
function own(value: string): string {
  return value.length < 13 ? value : (" " + value).slice(1);
}

function parseUnsigned(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= 0xffffffff ? number : null;
}

interface Counters {
  files: number;
  entries: number;
  skipped: number;
  duplicates: number;
  unreadable: string[];
}

const newCounters = (): Counters => ({ files: 0, entries: 0, skipped: 0, duplicates: 0, unreadable: [] });

const reportOf = (counters: Counters): DatabaseReadReport => ({ ...counters, unreadable: counters.unreadable });

/** Lit chaque fichier en entier (pour connaitre `Clear`), puis rend ses entrees dans l'ordre. */
function entriesOf(file: DatabaseText, wanted: ReadonlySet<string>, counters: Counters): { entries: YamlEntry[]; clear: boolean } {
  const entries: YamlEntry[] = [];
  const info = scanYamlDatabase(file.text, wanted, (entry) => entries.push(entry));
  counters.files += 1;
  counters.entries += info.entries;
  for (const line of info.unreadable) {
    if (counters.unreadable.length < MAX_REPORTED_UNREADABLE) counters.unreadable.push(`${file.path}:${line}`);
  }
  return { entries, clear: info.clear };
}

// --- Objets ---------------------------------------------------------------------------------------------------------

interface MutableItem {
  id: number;
  aegisName: string;
  name: string;
  type: string | null;
  source: string;
}

const ITEM_FIELDS: ReadonlySet<string> = new Set(["Id", "AegisName", "Name", "Type"]);

export function readItemDatabase(files: readonly DatabaseText[]): { readonly items: ItemRecord[]; readonly report: DatabaseReadReport } {
  const counters = newCounters();
  let byId = new Map<number, MutableItem>();
  let aegis = new Map<string, MutableItem>();
  for (const file of files) {
    const { entries, clear } = entriesOf(file, ITEM_FIELDS, counters);
    if (clear) {
      byId = new Map();
      aegis = new Map();
    }
    for (const entry of entries) {
      const id = parseUnsigned(entry.fields["Id"]);
      if (id === null) {
        counters.skipped += 1;
        continue;
      }
      const existing = byId.get(id);
      const aegisName = entry.fields["AegisName"];
      const name = entry.fields["Name"];
      if (existing === undefined && (aegisName === undefined || aegisName === "" || name === undefined)) {
        counters.skipped += 1;
        continue;
      }
      if (aegisName !== undefined && aegisName !== "") {
        const other = aegis.get(aegisName.toLowerCase());
        if (other !== undefined && other.id !== id) {
          counters.duplicates += 1;
          continue;
        }
      }
      const item: MutableItem = existing ?? { id, aegisName: "", name: "", type: null, source: `${file.path}:${entry.line}` };
      if (aegisName !== undefined && aegisName !== "") {
        if (existing !== undefined) aegis.delete(existing.aegisName.toLowerCase());
        item.aegisName = own(aegisName);
        aegis.set(aegisName.toLowerCase(), item);
      }
      if (name !== undefined) item.name = own(name);
      const type = entry.fields["Type"];
      if (type !== undefined && type !== "") item.type = own(type);
      if (existing === undefined) byId.set(id, item);
    }
  }
  return { items: [...byId.values()].sort((a, b) => a.id - b.id), report: reportOf(counters) };
}

// --- Monstres -------------------------------------------------------------------------------------------------------

interface MutableMob {
  id: number;
  aegisName: string;
  name: string;
  japaneseName: string | null;
  level: number | null;
  source: string;
}

const MOB_FIELDS: ReadonlySet<string> = new Set(["Id", "AegisName", "Name", "JapaneseName", "Level"]);

/** Identifiants acceptes par `MobDatabase::parseBodyNode` (`mob.cpp` : `MIN_MOB_DB`...`MAX_MOB_DB2`, bornes exclues). */
export function isValidMobId(id: number): boolean {
  return (id > 1000 && id < 3999) || (id > 20020 && id < 31999);
}

export function readMobDatabase(files: readonly DatabaseText[]): { readonly mobs: MobRecord[]; readonly report: DatabaseReadReport } {
  const counters = newCounters();
  let byId = new Map<number, MutableMob>();
  for (const file of files) {
    const { entries, clear } = entriesOf(file, MOB_FIELDS, counters);
    if (clear) byId = new Map();
    for (const entry of entries) {
      const id = parseUnsigned(entry.fields["Id"]);
      if (id === null || !isValidMobId(id)) {
        counters.skipped += 1;
        continue;
      }
      const existing = byId.get(id);
      const aegisName = entry.fields["AegisName"];
      const name = entry.fields["Name"];
      if (existing === undefined && (aegisName === undefined || aegisName === "" || name === undefined)) {
        counters.skipped += 1;
        continue;
      }
      const mob: MutableMob = existing ?? { id, aegisName: "", name: "", japaneseName: null, level: null, source: `${file.path}:${entry.line}` };
      if (aegisName !== undefined && aegisName !== "") mob.aegisName = own(aegisName);
      if (name !== undefined) {
        mob.name = own(name);
        // Sans `JapaneseName`, le serveur reprend le nom d'affichage pour un nouveau monstre.
        if (existing === undefined && entry.fields["JapaneseName"] === undefined) mob.japaneseName = own(name);
      }
      const japanese = entry.fields["JapaneseName"];
      if (japanese !== undefined) mob.japaneseName = own(japanese);
      const level = parseUnsigned(entry.fields["Level"]);
      if (level !== null) mob.level = level;
      if (existing === undefined) byId.set(id, mob);
    }
  }
  return { mobs: [...byId.values()].sort((a, b) => a.id - b.id), report: reportOf(counters) };
}

// --- Competences ----------------------------------------------------------------------------------------------------

const SKILL_FIELDS: ReadonlySet<string> = new Set(["Id", "Name", "Description", "MaxLevel"]);

/** Champs de reference de `SkillDatabase::parseBodyNode`, sans les regles de combat des competences. */
export function readSkillDatabase(files: readonly DatabaseText[]): { readonly skills: SkillRecord[]; readonly report: DatabaseReadReport } {
  const counters = newCounters();
  const byId = new Map<number, SkillRecord>();
  const encoder = new TextEncoder();
  for (const file of files) {
    const { entries, clear } = entriesOf(file, SKILL_FIELDS, counters);
    if (clear) byId.clear();
    for (const entry of entries) {
      const id = parseUnsigned(entry.fields["Id"]);
      if (id === null || id === 0 || id > 0xffff) {
        counters.skipped += 1;
        continue;
      }
      const existing = byId.get(id);
      const name = entry.fields["Name"] ?? existing?.name;
      const description = entry.fields["Description"] ?? existing?.description;
      const maxLevel = entry.fields["MaxLevel"] === undefined ? existing?.maxLevel : parseUnsigned(entry.fields["MaxLevel"]);
      // Bornes de la version du schema lue (skill.hpp : SKILL_NAME_LENGTH, SKILL_DESC_LENGTH, MAX_SKILL_LEVEL).
      if (name === undefined || name === "" || encoder.encode(name).length > 40 || description === undefined || encoder.encode(description).length > 40 ||
        maxLevel == null || maxLevel < 1 || maxLevel > 13) {
        counters.skipped += 1;
        continue;
      }
      byId.set(id, { id, name: own(name), description: own(description), maxLevel, source: existing?.source ?? `${file.path}:${entry.line}` });
    }
  }
  return { skills: [...byId.values()].sort((a, b) => a.id - b.id), report: reportOf(counters) };
}

// --- Constantes -----------------------------------------------------------------------------------------------------

const CONSTANT_FIELDS: ReadonlySet<string> = new Set(["Name", "Value", "Parameter"]);
const NUMBER_LITERAL = /^-?(?:0x[0-9a-f]+|\d+)$/i;

/** `Name` de `db/const.yml` : le serveur lit `%1023[A-Za-z0-9/_]`, la suite est ecartee (`ConstantDatabase::parseBodyNode`). */
function constantNameOf(raw: string): string | null {
  const match = /^[A-Za-z0-9/_]+/.exec(raw);
  return match === null ? null : match[0];
}

function parseInteger(value: string): number | null {
  return NUMBER_LITERAL.test(value.trim()) ? Number(value.trim()) : null;
}

/** Constantes de `db/const.yml` (et de ses imports), dans l'ordre : la premiere definition d'un nom l'emporte. */
export function readConstantDatabase(files: readonly DatabaseText[]): { readonly constants: ConstantRecord[]; readonly report: DatabaseReadReport } {
  const counters = newCounters();
  const byKey = new Map<string, ConstantRecord>();
  for (const file of files) {
    const { entries } = entriesOf(file, CONSTANT_FIELDS, counters);
    for (const entry of entries) {
      const name = constantNameOf(entry.fields["Name"] ?? "");
      const value = entry.fields["Value"] === undefined ? null : parseInteger(entry.fields["Value"]);
      if (name === null || value === null) {
        counters.skipped += 1;
        continue;
      }
      const key = name.toLowerCase();
      if (byKey.has(key)) {
        counters.duplicates += 1;
        continue;
      }
      byKey.set(key, {
        name: own(name),
        value,
        parameter: (entry.fields["Parameter"] ?? "").toLowerCase() === "true",
        deprecated: false,
        source: `${file.path}:${entry.line}`,
      });
    }
  }
  return { constants: [...byKey.values()], report: reportOf(counters) };
}

// --- Options aleatoires : constantes RDMOPT_... ------------------------------------------------------------------------

const RANDOM_OPTION_FIELDS: ReadonlySet<string> = new Set(["Id", "Option", "Script"]);
const RANDOM_OPTION_PREFIX = "RDMOPT_";
/** Un mot du serveur : seul ce que `skip_word` lit peut s'ecrire dans un script. */
const OPTION_WORD = /^[A-Za-z0-9_]+$/;

interface MutableRandomOption {
  id: number;
  option: string;
  source: string;
}

/**
 * Constantes `RDMOPT_<Option>` que le serveur cree a la fin du chargement de `db/item_randomopt_db.yml` et de ses imports
 * (`RandomOptionDatabase::loadingFinished`, `itemdb.cpp`) : une par option, valant son `Id`. Regles de `parseBodyNode` :
 * - l'`Id` tient sur 16 bits ; une nouvelle entree exige `Option` **et** `Script` ; une entree qui existe deja n'en modifie
 *   que les champs qu'elle ecrit ;
 * - une entree dont l'`Option` est deja celle d'**un autre** identifiant est ignoree en entier (comparaison exacte).
 * Le nom d'une option qu'un script ne pourrait pas ecrire (hors lettres, chiffres, `_`) n'est pas retenu. Les noms des
 * constantes sont ceux de la **fin** du chargement : une option renommee par un import n'a plus son ancien nom.
 */
export function readRandomOptionDatabase(files: readonly DatabaseText[]): { readonly constants: ConstantRecord[]; readonly report: DatabaseReadReport } {
  const counters = newCounters();
  let byId = new Map<number, MutableRandomOption>();
  for (const file of files) {
    const { entries, clear } = entriesOf(file, RANDOM_OPTION_FIELDS, counters);
    if (clear) byId = new Map();
    for (const entry of entries) {
      const id = parseUnsigned(entry.fields["Id"]);
      if (id === null || id > 0xffff) {
        counters.skipped += 1;
        continue;
      }
      const existing = byId.get(id);
      const option = entry.fields["Option"];
      if (existing === undefined && (option === undefined || entry.fields["Script"] === undefined)) {
        counters.skipped += 1;
        continue;
      }
      if (option !== undefined && option !== (existing?.option ?? "")) {
        let taken = false;
        for (const other of byId.values()) if (other.option === option) taken = true;
        if (taken) {
          counters.duplicates += 1;
          continue;
        }
      }
      const randomOption: MutableRandomOption = existing ?? { id, option: "", source: `${file.path}:${entry.line}` };
      if (option !== undefined) randomOption.option = own(option);
      if (existing === undefined) byId.set(id, randomOption);
    }
  }
  const constants: ConstantRecord[] = [];
  for (const randomOption of [...byId.values()].sort((a, b) => a.id - b.id)) {
    if (!OPTION_WORD.test(randomOption.option)) {
      counters.skipped += 1;
      continue;
    }
    constants.push({ name: RANDOM_OPTION_PREFIX + randomOption.option, value: randomOption.id, parameter: false, deprecated: false, source: randomOption.source });
  }
  return { constants, report: reportOf(counters) };
}

const PLAIN_CONSTANT = /^\s*export_constant\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/;
const NAMED_CONSTANT = /^\s*export_constant2\(\s*"([^"]+)"\s*,\s*([^;]*?)\)\s*;/;
const PARAMETER = /^\s*export_parameter\(\s*"([^"]+)"\s*,\s*([^;]*?)\)\s*;/;
const DEPRECATED_PLAIN = /^\s*export_deprecated_constant\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/;
const DEPRECATED_NAMED = /^\s*export_deprecated_constant[23]\(\s*"([^"]+)"/;
const NPC_MACRO_DEFINITION = /#define\s+export_constant_npc\(\s*a\s*\)\s+export_constant_offset\(\s*a\s*,\s*(\d+)\s*\)/;
const NPC_CONSTANT = /^\s*export_constant_npc\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/;

/**
 * Noms des constantes que le serveur exporte vers les scripts : `src/map/script_constants.hpp`, une suite d'appels
 * `export_constant(NOM);`. Seuls les noms sont connus (la valeur est une expression C++ du serveur), sauf pour
 * `export_constant2("Nom", 5)` ecrit avec un nombre. Les noms de sprites de NPC s'exportent par `export_constant_npc(JT_X)`
 * qui retire le prefixe `JT_`.
 */
export function parseScriptConstants(text: string, path: string): ConstantRecord[] {
  const lines = text.split("\n");
  const npcOffset = (() => {
    const match = NPC_MACRO_DEFINITION.exec(text);
    return match?.[1] === undefined ? null : Number(match[1]);
  })();
  const seen = new Set<string>();
  const out: ConstantRecord[] = [];
  const add = (name: string, value: number | null, parameter: boolean, deprecated: boolean, line: number): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: own(name), value, parameter, deprecated, source: `${path}:${line}` });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // Les appels commencent la ligne (apres l'indentation) : un commentaire ou une directive est ecarte d'office.
    if (!/^\s*export_/.test(line)) continue;
    const lineNumber = index + 1;
    let match: RegExpExecArray | null;
    if ((match = PLAIN_CONSTANT.exec(line)) !== null) add(match[1] ?? "", null, false, false, lineNumber);
    else if ((match = NAMED_CONSTANT.exec(line)) !== null) add(match[1] ?? "", parseInteger(match[2] ?? ""), false, false, lineNumber);
    else if ((match = PARAMETER.exec(line)) !== null) add(match[1] ?? "", parseInteger(match[2] ?? ""), true, false, lineNumber);
    else if ((match = DEPRECATED_PLAIN.exec(line)) !== null) add(match[1] ?? "", null, false, true, lineNumber);
    else if ((match = DEPRECATED_NAMED.exec(line)) !== null) add(match[1] ?? "", null, false, true, lineNumber);
    else if (npcOffset !== null && (match = NPC_CONSTANT.exec(line)) !== null) add((match[1] ?? "").slice(npcOffset), null, false, false, lineNumber);
  }
  return out.filter((constant) => constant.name !== "");
}

// --- Cartes ---------------------------------------------------------------------------------------------------------

/**
 * Index des cartes (`mapindex_init` de `mapindex.cpp`) : `db/map_index.txt` puis `db/import/map_index.txt`. Une ligne est
 * `nom` (index = precedent + 1) ou `nom<espace>index` ; un nom est lu sur 11 caracteres au plus ; les lignes qui commencent
 * par `//` sont ignorees. Un index reecrit remplace la carte qu'il designait.
 */
export function readMapIndex(files: readonly DatabaseText[]): { readonly maps: MapRecord[]; readonly report: DatabaseReadReport } {
  const counters = newCounters();
  const byIndex = new Map<number, MapRecord>();
  let last = -1;
  for (const file of files) {
    counters.files += 1;
    const lines = file.text.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      if (line.startsWith("//")) continue;
      // `sscanf(line, "%11s\t%d", name, &index)`.
      const match = /^\s*(\S{1,11})\S*(?:\s+(-?\d+))?/.exec(line);
      if (match === null || match[1] === undefined) continue;
      counters.entries += 1;
      const index = match[2] === undefined ? last + 1 : Number(match[2]);
      const name = own(normalizeMapName(match[1]));
      if (name === "" || index < 0) {
        counters.skipped += 1;
        continue;
      }
      byIndex.set(index, { name, index, source: `${file.path}:${lineIndex + 1}` });
      last = index;
    }
  }
  // Une carte est connue sous le nom que porte son index final.
  return { maps: [...byIndex.values()].sort((a, b) => a.index - b.index), report: reportOf(counters) };
}
