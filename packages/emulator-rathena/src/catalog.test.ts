import { describe, expect, it } from "vitest";
import { buildRathenaCatalog, collectRathenaDatabaseSources } from "./catalog";
import type { DatabaseReader } from "./catalog";
import { RATHENA_PATHS } from "./paths";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

const HPP = ["#define export_constant_npc(a) export_constant_offset(a,3)", "export_constant(Job_Alchemist);", 'export_parameter("BaseLevel",SP_BASELEVEL);', "export_constant_npc(JT_4_M_01);"].join("\n");

describe("buildRathenaCatalog", () => {
  const items = [{ path: "db/re/item_db_usable.yml", text: ["Body:", "  - Id: 501", "    AegisName: Red_Potion", "    Name: Red Potion", "    Type: Healing"].join("\n") }];
  const mobs = [{ path: "db/re/mob_db.yml", text: ["Body:", "  - Id: 1002", "    AegisName: PORING", "    Name: Poring", "    Level: 1"].join("\n") }];
  const skills = [{ path: "db/re/skill_db.yml", text: "Body:\n  - Id: 1\n    Name: NV_BASIC\n    Description: Basic Skill\n    MaxLevel: 9" }];
  const mapIndex = [{ path: "db/map_index.txt", text: "prontera 1\nprt_fild08" }];
  const constantsYaml = [{ path: "db/const.yml", text: ["Body:", "  - Name: SWORDCLAN", "    Value: 1"].join("\n") }];

  it("assemble objets, monstres, cartes et constantes, avec leur provenance", () => {
    const report = buildRathenaCatalog({ items, mobs, skills, mapIndex, constantsYaml, constantsSource: { path: RATHENA_PATHS.scriptConstants, text: HPP } });
    const catalog = report.catalog;
    expect(catalog?.stats()).toEqual({ items: 1, mobs: 1, skills: 1, maps: 2, constants: 4 });
    expect(catalog?.itemByAegisName("red_potion")?.source).toBe("db/re/item_db_usable.yml:2");
    expect(catalog?.mobByAegisName("PORING")?.level).toBe(1);
    expect(catalog?.skillByName("nv_basic")).toEqual({ id: 1, name: "NV_BASIC", description: "Basic Skill", maxLevel: 9, source: "db/re/skill_db.yml:2" });
    expect(catalog?.skillByName("Basic Skill")).toBeUndefined();
    expect(buildRathenaCatalog({ skills }).catalog?.search("skill", "basic skill", 1)).toMatchObject([{ id: 1, name: "NV_BASIC" }]);
    expect(catalog?.mapByName("prt_fild08")?.index).toBe(2);
    expect(catalog?.constantByName("4_M_01")?.source).toBe("src/map/script_constants.hpp:4");
    expect(catalog?.constantByName("swordclan")?.value).toBe(1);
    expect(report.constants).toEqual({ source: 3, yaml: 1, randomOptions: 0, project: 0, duplicates: 0 });
    expect(report.warnings).toEqual([]);
  });

  it("transmet les cartes que le serveur charge au catalogue, sans toucher aux cartes de l'index", () => {
    const report = buildRathenaCatalog({ items, mapIndex, loadedMaps: ["prontera", "carte_hors_index"] });
    const catalog = report.catalog;
    expect(catalog?.mapIsLoaded("prontera")).toBe(true);
    expect(catalog?.mapIsLoaded("prt_fild08")).toBe(false);
    expect(catalog?.loadedMapCount).toBe(2);
    expect(catalog?.stats().maps).toBe(2);
    // Sans liste (absente, nulle, vide) : on ne sait pas quelles cartes sont chargees.
    for (const loadedMaps of [undefined, null, []]) expect(buildRathenaCatalog({ items, mapIndex, loadedMaps }).catalog?.mapIsLoaded("prontera")).toBeNull();
  });

  it("le code du serveur l'emporte sur `const.yml`, et les constantes du projet completent sans remplacer", () => {
    const report = buildRathenaCatalog({
      constantsYaml: [{ path: "db/const.yml", text: ["Body:", "  - Name: Job_Alchemist", "    Value: 18"].join("\n") }],
      constantsSource: { path: "h", text: HPP },
      projectConstants: [{ name: "BaseLevel", value: 1 }, { name: "MY_EVENT", value: 7 }],
    });
    expect(report.catalog?.constantByName("Job_Alchemist")?.source).toBe("h:2");
    expect(report.catalog?.constantByName("BaseLevel")?.parameter).toBe(true);
    expect(report.catalog?.constantByName("my_event")).toMatchObject({ value: 7, source: ".runeforge/project.json", custom: true });
    // Seules les constantes du projet sont marquees : celles du serveur servent a juger un nom (un label ne peut pas les porter).
    expect(report.catalog?.constantByName("Job_Alchemist")?.custom).toBeUndefined();
    expect(report.catalog?.constantByName("BaseLevel")?.custom).toBeUndefined();
    expect(report.constants).toMatchObject({ project: 1, duplicates: 1 });
  });

  it("ajoute les constantes RDMOPT_ des options aleatoires apres celles du serveur et de `const.yml`, qui l'emportent", () => {
    const randomOptions = [
      { path: "db/re/item_randomopt_db.yml", text: ["Body:", "  - Id: 1", "    Option: VAR_MAXHPAMOUNT", "    Script: |", "      bonus bMaxHP,1;", "  - Id: 3", "    Option: VAR_STRAMOUNT", "    Script: |", "      bonus bStr,1;"].join("\n") },
    ];
    const report = buildRathenaCatalog({
      constantsYaml: [{ path: "db/const.yml", text: ["Body:", "  - Name: RDMOPT_VAR_MAXHPAMOUNT", "    Value: 99"].join("\n") }],
      randomOptions,
      projectConstants: [{ name: "rdmopt_var_stramount", value: 5 }],
    });
    // Le nom pris par `const.yml` n'est pas remplace ; le nom du projet ne remplace pas celui du serveur (sans tenir compte de la casse).
    expect(report.catalog?.constantByName("RDMOPT_VAR_MAXHPAMOUNT")).toMatchObject({ value: 99, source: "db/const.yml:2" });
    expect(report.catalog?.constantByName("rdmopt_var_stramount")).toMatchObject({ name: "RDMOPT_VAR_STRAMOUNT", value: 3, source: "db/re/item_randomopt_db.yml:6" });
    expect(report.catalog?.constantByName("RDMOPT_VAR_STRAMOUNT")?.custom).toBeUndefined();
    expect(report.constants).toEqual({ source: 0, yaml: 1, randomOptions: 2, project: 0, duplicates: 1 });
    expect(buildRathenaCatalog({ randomOptions }).catalog?.stats().constants).toBe(2);
  });

  it("rend compte des options aleatoires ecartees", () => {
    const report = buildRathenaCatalog({
      randomOptions: [{ path: "db/ro.yml", text: ["Body:", "  - Id: 1", "    Option: A", "    Script: |", "      bonus bStr,1;", "  - Id: 2", "    Option: A", "    Script: |", "      bonus bStr,1;", "  - oops"].join("\n") }],
    });
    expect(report.warnings).toEqual(["options aleatoires : 1 entree(s) ignoree(s) (nom deja pris par un autre identifiant)", "options aleatoires : ligne non comprise a db/ro.yml:10"]);
  });

  it("ne donne aucun catalogue quand aucun fichier n'a rien apporte", () => {
    expect(buildRathenaCatalog({}).catalog).toBeNull();
    expect(buildRathenaCatalog({ items: [{ path: "x.yml", text: "Body:\n" }] }).catalog).toBeNull();
  });

  it("rend compte de ce qui a ete ecarte", () => {
    const report = buildRathenaCatalog({
      items: [{ path: "db/i.yml", text: ["Body:", "  - Id: 1", "    AegisName: A", "    Name: A", "  - Id: 2", "    AegisName: a", "    Name: B", "  - oops"].join("\n") }],
    });
    expect(report.warnings).toEqual([
      "objets : 1 entree(s) ignoree(s) (nom deja pris par un autre identifiant)",
      "objets : ligne non comprise a db/i.yml:8",
    ]);
  });
});

describe("collectRathenaDatabaseSources", () => {
  const files: Record<string, string> = {
    "db/item_db.yml": ["Header:", "  Type: ITEM_DB", "Footer:", "  Imports:", "  - Path: db/pre-re/item_db.yml", "    Mode: Prerenewal", "  - Path: db/re/item_db.yml", "    Mode: Renewal", "  - Path: db/import/item_db.yml"].join("\n"),
    "db/re/item_db.yml": ["Header:", "  Type: ITEM_DB", "Footer:", "  Imports:", "  - Path: db/re/item_db_usable.yml", "  - Path: db/re/item_db_etc.yml", "  - Path: db/generator/g.yml", "    Generator: true"].join("\n"),
    "db/re/item_db_usable.yml": "Body:\n  - Id: 1\n",
    "db/re/item_db_etc.yml": "Body:\n  - Id: 2\n",
    "db/pre-re/item_db.yml": "Body:\n  - Id: 3\n",
    "db/import/item_db.yml": "Body:\n  - Id: 4\n",
    "db/mob_db.yml": "Body:\n",
    "db/skill_db.yml": "Footer:\n  Imports:\n  - Path: db/pre-re/skill_db.yml\n    Mode: Prerenewal\n  - Path: db/re/skill_db.yml\n    Mode: Renewal\n  - Path: db/import/skill_db.yml",
    "db/re/skill_db.yml": "Body:\n  - Id: 1\n",
    "db/pre-re/skill_db.yml": "Body:\n  - Id: 2\n",
    "db/import/skill_db.yml": "Body:\n  - Id: 3\n",
    "db/const.yml": ["Footer:", "  Imports:", "  - Path: db/import/const.yml"].join("\n"),
    "db/import/const.yml": "Body:\n",
    "src/map/script_constants.hpp": HPP,
    "db/map_index.txt": "prontera 1\n",
    "db/item_randomopt_db.yml": ["Header:", "  Type: RANDOM_OPTION_DB", "Footer:", "  Imports:", "  - Path: db/re/item_randomopt_db.yml", "    Mode: Renewal", "  - Path: db/import/item_randomopt_db.yml"].join("\n"),
    "db/re/item_randomopt_db.yml": "Body:\n  - Id: 1\n",
    "db/import/item_randomopt_db.yml": "Body:\n  - Id: 2\n",
  };

  function readerOf(source: Record<string, string>, reads: string[] = []): DatabaseReader {
    return {
      readBytes: async (paths) =>
        paths.map((path) => {
          reads.push(path);
          const content = source[path];
          return content === undefined ? null : bytes(content);
        }),
    };
  }

  it("suit les imports dans l'ordre du serveur (un fichier avant ses imports) selon le mode renewal", async () => {
    const reads: string[] = [];
    const { sources, warnings } = await collectRathenaDatabaseSources(readerOf(files, reads), true, RATHENA_PATHS);
    expect(sources.items.map((file) => file.path)).toEqual(["db/item_db.yml", "db/re/item_db.yml", "db/re/item_db_usable.yml", "db/re/item_db_etc.yml", "db/import/item_db.yml"]);
    expect(sources.mobs.map((file) => file.path)).toEqual(["db/mob_db.yml"]);
    expect(sources.skills.map((file) => file.path)).toEqual(["db/skill_db.yml", "db/re/skill_db.yml", "db/import/skill_db.yml"]);
    expect(sources.constantsYaml.map((file) => file.path)).toEqual(["db/const.yml", "db/import/const.yml"]);
    expect(sources.constantsSource?.path).toBe("src/map/script_constants.hpp");
    expect(text(sources.constantsSource?.bytes ?? new Uint8Array())).toBe(HPP);
    expect(sources.mapIndex.map((file) => file.path)).toEqual(["db/map_index.txt"]);
    expect(sources.randomOptions.map((file) => file.path)).toEqual(["db/item_randomopt_db.yml", "db/re/item_randomopt_db.yml", "db/import/item_randomopt_db.yml"]);
    // `db/import/map_index.txt` n'existe pas ici : ce n'est pas un probleme.
    expect(warnings).toEqual([]);
    // Chaque fichier n'est lu qu'une fois ; les fichiers de l'autre mode et des outils ne sont pas lus.
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads).not.toContain("db/pre-re/item_db.yml");
    expect(reads).not.toContain("db/generator/g.yml");
  });

  it("choisit les fichiers du mode pre-renewal", async () => {
    const { sources } = await collectRathenaDatabaseSources(readerOf(files), false, RATHENA_PATHS);
    expect(sources.items.map((file) => file.path)).toEqual(["db/item_db.yml", "db/pre-re/item_db.yml", "db/import/item_db.yml"]);
    expect(sources.skills.map((file) => file.path)).toEqual(["db/skill_db.yml", "db/pre-re/skill_db.yml", "db/import/skill_db.yml"]);
    // Les options aleatoires n'ont d'import que pour le mode renewal : la base racine et l'import de l'utilisateur seulement.
    expect(sources.randomOptions.map((file) => file.path)).toEqual(["db/item_randomopt_db.yml", "db/import/item_randomopt_db.yml"]);
  });

  it("signale un import absent ou circulaire, pas une base racine absente", async () => {
    const broken = {
      "db/item_db.yml": ["Footer:", "  Imports:", "  - Path: db/missing.yml", "  - Path: db/loop.yml"].join("\n"),
      "db/loop.yml": ["Footer:", "  Imports:", "  - Path: db/item_db.yml"].join("\n"),
    };
    const { sources, warnings } = await collectRathenaDatabaseSources(readerOf(broken), true, RATHENA_PATHS);
    expect(sources.items.map((file) => file.path)).toEqual(["db/item_db.yml", "db/loop.yml"]);
    expect(sources.mobs).toEqual([]);
    expect(warnings).toEqual(["fichier de base introuvable : db/missing.yml", "import circulaire ignore : db/item_db.yml"]);
  });
});
