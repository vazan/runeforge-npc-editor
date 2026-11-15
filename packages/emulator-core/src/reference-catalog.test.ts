import { describe, expect, it } from "vitest";
import { normalizeMapName, ReferenceCatalog } from "./reference-catalog";
import type { ItemRecord, MobRecord } from "./reference-catalog";

const item = (id: number, aegisName: string, name: string, type: string | null = null): ItemRecord => ({ id, aegisName, name, type, source: `db/items.yml:${id}` });
const mob = (id: number, aegisName: string, name: string, japaneseName: string | null = null, level: number | null = null): MobRecord => ({
  id,
  aegisName,
  name,
  japaneseName,
  level,
  source: `db/mobs.yml:${id}`,
});

const catalog = ReferenceCatalog.create(
  {
    items: [
      item(501, "Red_Potion", "Red Potion", "Healing"),
      item(502, "Orange_Potion", "Orange Potion", "Healing"),
      item(5010, "Red_Ribbon", "Red Ribbon", "Armor"),
      item(607, "Yggdrasilberry", "Yggdrasil Berry"),
      item(7000, "Poring_Doll", "Doll"),
      item(7001, "Doll", "Poring Doll"),
    ],
    mobs: [mob(1002, "PORING", "Poring", "ポリン", 1), mob(1113, "DROPS", "Drops", null, 3), mob(1114, "PORING_X", "Poring", null, 9)],
    maps: [
      { name: "prontera", index: 1, source: "db/map_index.txt:2" },
      { name: "prt_fild08", index: 2, source: "db/map_index.txt:3" },
    ],
    constants: [
      { name: "Job_Alchemist", value: null, parameter: false, deprecated: false, source: "src/map/script_constants.hpp:10" },
      { name: "BaseLevel", value: 3, parameter: true, deprecated: false, source: "src/map/script_constants.hpp:20" },
    ],
  },
  "rAthena",
);

describe("ReferenceCatalog - correspondances comme le serveur", () => {
  it("retrouve un objet par identifiant, AegisName puis nom d'affichage, sans tenir compte de la casse", () => {
    expect(catalog.itemById(501)?.aegisName).toBe("Red_Potion");
    expect(catalog.itemByAegisName("red_potion")?.id).toBe(501);
    expect(catalog.itemByName("RED POTION")?.id).toBe(501);
    expect(catalog.itemByAegisName("Red Potion")).toBeUndefined();
    expect(catalog.itemById(1)).toBeUndefined();
  });

  it("donne la priorite a l'AegisName sur un nom d'affichage identique (item_db.searchname)", () => {
    // « Doll » est l'AegisName de 7001 et le nom d'affichage de 7000.
    expect(catalog.itemByName("Doll")?.id).toBe(7001);
  });

  it("ne connait pour un monstre que l'AegisName comme `mobdb_search_aegisname`, mais tous les noms comme `mobdb_searchname`", () => {
    expect(catalog.mobByAegisName("poring")?.id).toBe(1002);
    expect(catalog.mobByAegisName("Drops")?.id).toBe(1113);
    expect(catalog.mobByAegisName("ポリン")).toBeUndefined();
    expect(catalog.mobByName("ポリン")?.id).toBe(1002);
    // Deux monstres de meme nom d'affichage : le premier (identifiant croissant) l'emporte.
    expect(catalog.mobByName("Poring")?.id).toBe(1002);
    expect(catalog.mobById(1113)?.name).toBe("Drops");
    expect(catalog.mobById(1)).toBeUndefined();
  });

  it("compare les cartes exactement (casse comprise) et retire l'extension .gat", () => {
    expect(catalog.mapByName("prontera")?.index).toBe(1);
    expect(catalog.mapByName("prontera.gat")?.index).toBe(1);
    expect(catalog.mapByName("prontera.GAT")?.index).toBe(1);
    expect(catalog.mapByName("Prontera")).toBeUndefined();
    expect(normalizeMapName("abc.gat")).toBe("abc");
    expect(normalizeMapName(".gat")).toBe("");
    expect(normalizeMapName("gat")).toBe("gat");
  });

  it("compare les constantes sans tenir compte de la casse", () => {
    expect(catalog.constantByName("JOB_ALCHEMIST")?.name).toBe("Job_Alchemist");
    expect(catalog.constantByName("baselevel")?.parameter).toBe(true);
    expect(catalog.constantByName("Unknown")).toBeUndefined();
  });

  it("compte ce qu'il connait", () => {
    expect(catalog.stats()).toEqual({ items: 6, mobs: 3, skills: 0, maps: 2, constants: 2 });
    expect(catalog.isEmpty).toBe(false);
    expect(ReferenceCatalog.create({}, "x").isEmpty).toBe(true);
  });
});

describe("ReferenceCatalog - recherche libre", () => {
  it("met l'identifiant exact en tete, puis ses prefixes, puis les noms", () => {
    expect(catalog.search("item", "501", 10).map((hit) => hit.id)).toEqual([501, 5010]);
    expect(catalog.search("item", "50", 10).map((hit) => hit.id)).toEqual([501, 502, 5010]);
  });

  it("classe un debut de nom avant un debut de mot, avant un simple contenu", () => {
    const hits = catalog.search("item", "red", 10);
    expect(hits.map((hit) => hit.name)).toEqual(["Red_Potion", "Red_Ribbon"]);
    // « pot » commence un mot (apres `_` ou espace) de Red_Potion/Orange_Potion ; « ion » n'est qu'un contenu.
    expect(catalog.search("item", "pot", 10).map((hit) => hit.name)).toEqual(["Red_Potion", "Orange_Potion"]);
    expect(catalog.search("item", "otion", 10).map((hit) => hit.score)).toEqual([300, 300]);
  });

  it("exige tous les mots de la requete", () => {
    expect(catalog.search("item", "orange potion", 10).map((hit) => hit.id)).toEqual([502]);
    expect(catalog.search("item", "red orange", 10)).toEqual([]);
  });

  it("sans requete, renvoie les premiers enregistrements par identifiant, dans la limite demandee", () => {
    expect(catalog.search("item", "", 2).map((hit) => hit.id)).toEqual([501, 502]);
    expect(catalog.search("item", "   ", 0)).toEqual([]);
  });

  it("decrit chaque nature de resultat", () => {
    expect(catalog.search("item", "red_potion", 1)[0]).toMatchObject({ kind: "item", name: "Red_Potion", id: 501, displayName: "Red Potion", detail: "Healing" });
    expect(catalog.search("mob", "poring", 5)[0]).toMatchObject({ kind: "mob", name: "PORING", id: 1002, displayName: "Poring", detail: "Lv 1" });
    expect(catalog.search("mob", "ポリン", 5).map((hit) => hit.id)).toEqual([1002]);
    expect(catalog.search("map", "prt", 5)[0]).toMatchObject({ kind: "map", name: "prt_fild08", id: 2 });
    expect(catalog.search("constant", "base", 5)[0]).toMatchObject({ kind: "constant", name: "BaseLevel", id: 3, detail: "parameter" });
  });
});

describe("ReferenceCatalog - cartes chargees par le serveur", () => {
  const maps = [
    { name: "prontera", index: 1, source: "db/map_index.txt:2" },
    { name: "prt_fild08", index: 2, source: "db/map_index.txt:3" },
    { name: "force_1-1", index: 3, source: "db/map_index.txt:4" },
  ];
  const make = (loadedMaps?: readonly string[] | null): ReferenceCatalog => ReferenceCatalog.create({ maps, loadedMaps }, "rAthena");

  it("dit si une carte est chargee, sans l'extension .gat, en distinguant les casses", () => {
    const loaded = make(["prontera", "force_1-1.gat"]);
    expect(loaded.mapIsLoaded("prontera")).toBe(true);
    expect(loaded.mapIsLoaded("prontera.gat")).toBe(true);
    expect(loaded.mapIsLoaded("force_1-1")).toBe(true);
    expect(loaded.mapIsLoaded("prt_fild08")).toBe(false);
    expect(loaded.mapIsLoaded("Prontera")).toBe(false);
    expect(loaded.loadedMapCount).toBe(2);
  });

  it("ne dit rien quand la liste des cartes chargees n'est pas connue (absente, nulle ou vide)", () => {
    for (const catalog of [make(), make(null), make([])]) {
      expect(catalog.mapIsLoaded("prontera")).toBeNull();
      expect(catalog.mapIsLoaded("inconnue")).toBeNull();
      expect(catalog.loadedMapCount).toBeNull();
    }
  });

  it("ne change ni les cartes de l'index ni les statistiques", () => {
    const loaded = make(["prontera"]);
    expect(loaded.stats()).toEqual({ items: 0, mobs: 0, skills: 0, maps: 3, constants: 0 });
    expect(loaded.mapByName("prt_fild08")?.index).toBe(2);
    expect(loaded.isEmpty).toBe(false);
  });
});
