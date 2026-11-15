import { ReferenceCatalog } from "@runeforge/emulator-core";
import type { ConstantRecord } from "@runeforge/emulator-core";
import { parseScriptConstants, readConstantDatabase, readItemDatabase, readMapIndex, readMobDatabase, readRandomOptionDatabase, readSkillDatabase } from "./database-readers";
import type { DatabaseReadReport, DatabaseText } from "./database-readers";
import { RATHENA_PROFILE_LABEL } from "./paths";
import { FOOTER_WINDOW_BYTES, footerImports } from "./yaml-db";

/** Constante declaree dans le projet (`.runeforge/project.json`, `constants.custom`). */
export interface ProjectConstantInput {
  readonly name: string;
  readonly value: number | null;
}

/** Texte des fichiers de bases du serveur de l'utilisateur, dans l'ordre de chargement du serveur. */
export interface RathenaCatalogInputs {
  readonly items?: readonly DatabaseText[];
  readonly mobs?: readonly DatabaseText[];
  readonly skills?: readonly DatabaseText[];
  readonly constantsYaml?: readonly DatabaseText[];
  /** `src/map/script_constants.hpp`. */
  readonly constantsSource?: DatabaseText | null;
  readonly mapIndex?: readonly DatabaseText[];
  /** `db/item_randomopt_db.yml` et ses imports : le serveur en tire les constantes `RDMOPT_<Option>`. */
  readonly randomOptions?: readonly DatabaseText[];
  /** Constantes du projet : elles completent celles du serveur, qui l'emportent en cas de meme nom. */
  readonly projectConstants?: readonly ProjectConstantInput[];
  /**
   * Cartes que le serveur charge (`map:` de `conf/map_athena.conf` et de ses imports, `ScriptLoadReport.maps`). Absent ou vide :
   * la liste n'est pas connue et aucune carte n'est dite « non chargee ».
   */
  readonly loadedMaps?: readonly string[] | null;
}

export interface RathenaCatalogReport {
  /** `null` si aucun fichier de base n'a donne quoi que ce soit : aucune verification ne doit alors en etre tiree. */
  readonly catalog: ReferenceCatalog | null;
  readonly items: DatabaseReadReport & { readonly count: number };
  readonly mobs: DatabaseReadReport & { readonly count: number };
  readonly skills: DatabaseReadReport & { readonly count: number };
  readonly maps: DatabaseReadReport & { readonly count: number };
  /** Constantes du code du serveur, de `db/const.yml`, des options aleatoires (`RDMOPT_`), du projet. */
  readonly constants: { readonly source: number; readonly yaml: number; readonly randomOptions: number; readonly project: number; readonly duplicates: number };
  /** A afficher en cas de doute sur le catalogue : entrees ou lignes ecartees. */
  readonly warnings: readonly string[];
}

const PROJECT_REFERENCE = ".runeforge/project.json";

/** Construit le catalogue de references d'un serveur rAthena a partir des fichiers de l'utilisateur. */
export function buildRathenaCatalog(inputs: RathenaCatalogInputs): RathenaCatalogReport {
  const warnings: string[] = [];
  const items = readItemDatabase(inputs.items ?? []);
  const mobs = readMobDatabase(inputs.mobs ?? []);
  const skills = readSkillDatabase(inputs.skills ?? []);
  const maps = readMapIndex(inputs.mapIndex ?? []);
  const hardcoded = inputs.constantsSource == null ? [] : parseScriptConstants(inputs.constantsSource.text, inputs.constantsSource.path);
  const yaml = readConstantDatabase(inputs.constantsYaml ?? []);
  const randomOptions = readRandomOptionDatabase(inputs.randomOptions ?? []);

  // Le code du serveur exporte ses constantes avant la lecture de `db/const.yml`, puis les bases creent les leurs (`RDMOPT_`) ; un nom
  // deja pris n'est pas remplace.
  const seen = new Set<string>();
  const constants: ConstantRecord[] = [];
  let duplicates = yaml.report.duplicates;
  for (const constant of [...hardcoded, ...yaml.constants, ...randomOptions.constants]) {
    const key = constant.name.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    constants.push(constant);
  }
  let projectCount = 0;
  for (const constant of inputs.projectConstants ?? []) {
    const key = constant.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    constants.push({ name: constant.name, value: constant.value, parameter: false, deprecated: false, source: PROJECT_REFERENCE, custom: true });
    projectCount += 1;
  }

  const describe = (label: string, report: DatabaseReadReport): void => {
    if (report.skipped > 0) warnings.push(`${label} : ${report.skipped} entree(s) ignoree(s) (identifiant invalide ou champs obligatoires absents)`);
    if (report.duplicates > 0) warnings.push(`${label} : ${report.duplicates} entree(s) ignoree(s) (nom deja pris par un autre identifiant)`);
    for (const place of report.unreadable) warnings.push(`${label} : ligne non comprise a ${place}`);
  };
  describe("objets", items.report);
  describe("monstres", mobs.report);
  describe("competences", skills.report);
  describe("cartes", maps.report);
  describe("options aleatoires", randomOptions.report);

  const catalog = ReferenceCatalog.create(
    { items: items.items, mobs: mobs.mobs, skills: skills.skills, maps: maps.maps, constants, loadedMaps: inputs.loadedMaps ?? null },
    RATHENA_PROFILE_LABEL,
  );
  return {
    catalog: catalog.isEmpty ? null : catalog,
    items: { ...items.report, count: items.items.length },
    mobs: { ...mobs.report, count: mobs.mobs.length },
    skills: { ...skills.report, count: skills.skills.length },
    maps: { ...maps.report, count: maps.maps.length },
    constants: { source: hardcoded.length, yaml: yaml.constants.length, randomOptions: randomOptions.constants.length, project: projectCount, duplicates },
    warnings,
  };
}

// --- Decouverte des fichiers ----------------------------------------------------------------------------------------

/** Lecture groupee de fichiers du serveur (octets, `null` si le fichier n'existe pas), dans l'ordre demande. */
export interface DatabaseReader {
  readBytes(paths: readonly string[]): Promise<readonly (Uint8Array | null)[]>;
}

export interface DatabaseSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface DatabaseSources {
  readonly items: readonly DatabaseSourceFile[];
  readonly mobs: readonly DatabaseSourceFile[];
  readonly skills: readonly DatabaseSourceFile[];
  readonly constantsYaml: readonly DatabaseSourceFile[];
  readonly constantsSource: DatabaseSourceFile | null;
  readonly mapIndex: readonly DatabaseSourceFile[];
  readonly randomOptions: readonly DatabaseSourceFile[];
}

const MAX_IMPORT_DEPTH = 8;

/** Un import reserve a un mode de compilation n'est lu que si le serveur est compile dans ce mode (`YamlDatabase::parseImports`). */
function importApplies(mode: string | null, renewal: boolean): boolean {
  if (mode === null) return true;
  return mode === (renewal ? "Renewal" : "Prerenewal");
}

/**
 * Fichiers d'une base YAML, dans l'ordre ou le serveur les charge : le fichier racine, puis chacun de ses imports (eux-memes
 * suivis de leurs imports), un fichier avant ses imports. Chaque fichier n'est lu qu'une fois ; son pied n'est decode que sur
 * sa fin. Les imports reserves a l'autre mode de compilation, et ceux des outils (`Generator`), sont sautes.
 */
async function collectYamlChain(reader: DatabaseReader, root: string, renewal: boolean, warnings: string[]): Promise<DatabaseSourceFile[]> {
  const files: DatabaseSourceFile[] = [];
  const decoder = new TextDecoder();
  const visit = async (path: string, depth: number, stack: readonly string[]): Promise<void> => {
    if (stack.includes(path)) {
      warnings.push(`import circulaire ignore : ${path}`);
      return;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      warnings.push(`imports trop profonds : ${path} n'est pas lu`);
      return;
    }
    const [bytes] = await reader.readBytes([path]);
    if (bytes === undefined || bytes === null) {
      // La racine absente n'est pas un probleme (serveur sans cette base) ; un import absent est signale par le serveur.
      if (depth > 0) warnings.push(`fichier de base introuvable : ${path}`);
      return;
    }
    files.push({ path, bytes });
    const tail = decoder.decode(bytes.length > FOOTER_WINDOW_BYTES ? bytes.subarray(bytes.length - FOOTER_WINDOW_BYTES) : bytes);
    for (const imported of footerImports(tail)) {
      if (imported.generator || !importApplies(imported.mode, renewal)) continue;
      await visit(imported.path, depth + 1, [...stack, path]);
    }
  };
  await visit(root, 0, []);
  return files;
}

/** Lit les fichiers de bases que le serveur charge, selon son mode de compilation, sans rien en decoder d'autre que les pieds. */
export async function collectRathenaDatabaseSources(
  reader: DatabaseReader,
  renewal: boolean,
  paths: {
    readonly itemDb: string;
    readonly mobDb: string;
    readonly skillDb: string;
    readonly constantDb: string;
    readonly randomOptionDb: string;
    readonly scriptConstants: string;
    readonly mapIndex: readonly string[];
  },
): Promise<{ readonly sources: DatabaseSources; readonly warnings: readonly string[] }> {
  const warnings: string[] = [];
  const [items, mobs, skills, constantsYaml, randomOptions, extras] = await Promise.all([
    collectYamlChain(reader, paths.itemDb, renewal, warnings),
    collectYamlChain(reader, paths.mobDb, renewal, warnings),
    collectYamlChain(reader, paths.skillDb, renewal, warnings),
    collectYamlChain(reader, paths.constantDb, renewal, warnings),
    collectYamlChain(reader, paths.randomOptionDb, renewal, warnings),
    reader.readBytes([paths.scriptConstants, ...paths.mapIndex]),
  ]);
  const constantsBytes = extras[0] ?? null;
  const mapIndex: DatabaseSourceFile[] = [];
  paths.mapIndex.forEach((path, position) => {
    const bytes = extras[position + 1] ?? null;
    if (bytes !== null) mapIndex.push({ path, bytes });
  });
  return {
    sources: { items, mobs, skills, constantsYaml, constantsSource: constantsBytes === null ? null : { path: paths.scriptConstants, bytes: constantsBytes }, mapIndex, randomOptions },
    warnings,
  };
}
