import { describe, expect, it } from "vitest";
import { isValidMobId, parseScriptConstants, readConstantDatabase, readItemDatabase, readMapIndex, readMobDatabase, readRandomOptionDatabase, readSkillDatabase } from "./database-readers";

const file = (path: string, ...rows: string[]): { path: string; text: string } => ({ path, text: rows.join("\n") });

describe("readSkillDatabase", () => {
  const base = file("base.yml", "Body:", "  - Id: 10", "    Name: TEST_OLD", "    Description: Test Skill", "    MaxLevel: 2");

  it("fusionne les surcharges partielles et garde la provenance", () => {
    const { skills, report } = readSkillDatabase([base, file("import.yml", "Body:", "  - Id: 10", "    Name: TEST_NEW", "    MaxLevel: 3")]);
    expect(skills).toEqual([{ id: 10, name: "TEST_NEW", description: "Test Skill", maxLevel: 3, source: "base.yml:2" }]);
    expect(report).toMatchObject({ files: 2, entries: 2, skipped: 0 });
  });

  it("ecarte les identifiants hors plage, nouvelles entrees incompletes et surcharges invalides", () => {
    const { skills, report } = readSkillDatabase([base, file("bad.yml", "Body:", "  - Id: 65536", "    Name: TOO_HIGH", "    Description: Invalid", "    MaxLevel: 2",
      "  - Id: 11", "    Name: INCOMPLETE", "  - Id: 10", "    Name: WOULD_RENAME", "    MaxLevel: 0", "  - Id: 10", `    Description: ${"é".repeat(21)}`)]);
    expect(skills).toEqual([{ id: 10, name: "TEST_OLD", description: "Test Skill", maxLevel: 2, source: "base.yml:2" }]);
    expect(report.skipped).toBe(4);
  });

  it("respecte Header.Clear et lit les champs scalaires seulement", () => {
    const { skills } = readSkillDatabase([base, file("reset.yml", "Header:", "  Clear: true", "Body:", "  - Id: 65535", "    Name: TEST_MAX", '    Description: "Skill: custom"', "    MaxLevel: 13", "    Flags:", "      Unknown: true")]);
    expect(skills).toEqual([{ id: 65535, name: "TEST_MAX", description: "Skill: custom", maxLevel: 13, source: "reset.yml:4" }]);
  });
});

describe("readRandomOptionDatabase - constantes RDMOPT_ comme le serveur", () => {
  const entry = (id: number | string, option?: string, script = true): string[] => [
    `  - Id: ${id}`,
    ...(option === undefined ? [] : [`    Option: ${option}`]),
    ...(script ? ["    Script: |", "      bonus bStr,1;"] : []),
  ];
  const summary = (files: { path: string; text: string }[]): [string, number][] => readRandomOptionDatabase(files).constants.map((constant) => [constant.name, constant.value as number]);

  it("cree une constante RDMOPT_<Option> par option, valant son identifiant, avec sa provenance", () => {
    const { constants, report } = readRandomOptionDatabase([file("db/re/item_randomopt_db.yml", "Body:", ...entry(1, "VAR_MAXHPAMOUNT"), ...entry(3, "VAR_STRAMOUNT"))]);
    expect(constants).toEqual([
      { name: "RDMOPT_VAR_MAXHPAMOUNT", value: 1, parameter: false, deprecated: false, source: "db/re/item_randomopt_db.yml:2" },
      { name: "RDMOPT_VAR_STRAMOUNT", value: 3, parameter: false, deprecated: false, source: "db/re/item_randomopt_db.yml:6" },
    ]);
    expect(report).toMatchObject({ files: 1, entries: 2, skipped: 0, duplicates: 0 });
  });

  it("les range par identifiant, quel que soit l'ordre des entrees", () => {
    expect(summary([file("a.yml", "Body:", ...entry(9, "NINE"), ...entry(2, "TWO"))])).toEqual([["RDMOPT_TWO", 2], ["RDMOPT_NINE", 9]]);
  });

  it("une nouvelle entree exige Option et Script ; une entree existante n'ecrase que les champs qu'elle ecrit", () => {
    const { constants, report } = readRandomOptionDatabase([
      file("a.yml", "Body:", ...entry(1, "KEEP"), ...entry(2, "SANS_SCRIPT", false), ...entry(3, undefined)),
      // Une entree ecartee n'existe pas pour les fichiers suivants : ils la creent, ou non, selon les memes regles.
      file("b.yml", "Body:", ...entry(1, undefined), ...entry(2, undefined), ...entry(3, "SANS_SCRIPT", false)),
    ]);
    expect(constants.map((constant) => [constant.name, constant.value])).toEqual([["RDMOPT_KEEP", 1]]);
    expect(report.skipped).toBe(4);
  });

  it("renomme l'option d'une entree existante : l'ancien nom disparait et peut servir a une autre", () => {
    expect(
      summary([
        file("a.yml", "Body:", ...entry(1, "OLD"), ...entry(2, "OTHER")),
        file("b.yml", "Body:", ...entry(1, "NEW", false), ...entry(3, "OLD")),
      ]),
    ).toEqual([["RDMOPT_NEW", 1], ["RDMOPT_OTHER", 2], ["RDMOPT_OLD", 3]]);
  });

  it("ignore en entier une entree dont l'option appartient a un autre identifiant (comparaison exacte, casse comprise)", () => {
    const { constants, report } = readRandomOptionDatabase([file("a.yml", "Body:", ...entry(1, "Same"), ...entry(2, "Same"), ...entry(3, "SAME"))]);
    expect(constants.map((constant) => [constant.name, constant.value])).toEqual([["RDMOPT_Same", 1], ["RDMOPT_SAME", 3]]);
    expect(report.duplicates).toBe(1);
    // Une entree qui reprend son propre nom n'est pas un doublon.
    expect(readRandomOptionDatabase([file("a.yml", "Body:", ...entry(1, "Same")), file("b.yml", "Body:", ...entry(1, "Same", false))]).report.duplicates).toBe(0);
  });

  it("n'accepte qu'un identifiant sur 16 bits", () => {
    const { constants, report } = readRandomOptionDatabase([
      file("a.yml", "Body:", ...entry("abc", "BAD_TEXT"), ...entry(65536, "TOO_BIG"), ...entry(-1, "NEGATIVE"), ...entry(65535, "MAX"), ...entry(0, "ZERO")),
    ]);
    expect(constants.map((constant) => [constant.name, constant.value])).toEqual([["RDMOPT_ZERO", 0], ["RDMOPT_MAX", 65535]]);
    expect(report.skipped).toBe(3);
  });

  it("Header: Clear efface les options des fichiers precedents", () => {
    expect(summary([file("a.yml", "Body:", ...entry(1, "A")), file("b.yml", "Header:", "  Clear: true", "Body:", ...entry(2, "B"))])).toEqual([["RDMOPT_B", 2]]);
  });

  it("ecarte un nom qu'un script ne pourrait pas ecrire", () => {
    const { constants, report } = readRandomOptionDatabase([file("a.yml", "Body:", ...entry(1, "A-B"), ...entry(2, '""'), ...entry(3, "Ok_1"))]);
    expect(constants.map((constant) => constant.name)).toEqual(["RDMOPT_Ok_1"]);
    expect(report.skipped).toBe(2);
  });

  it("lit les tables en ligne", () => {
    expect(summary([file("a.yml", "Body:", '  - {Id: 9, Option: VAR_X, Script: "bonus bStr,1;"}', "  - {Id: 10, Option: VAR_Y}")])).toEqual([["RDMOPT_VAR_X", 9]]);
  });

  it("ne rend rien sans entree", () => {
    expect(readRandomOptionDatabase([]).constants).toEqual([]);
    expect(readRandomOptionDatabase([file("a.yml", "Header:", "  Type: RANDOM_OPTION_DB")]).constants).toEqual([]);
  });
});

describe("readItemDatabase - fusion comme le serveur", () => {
  it("cree un objet avec AegisName et Name, avec sa provenance", () => {
    const { items, report } = readItemDatabase([
      file("db/a.yml", "Body:", "  - Id: 501", "    AegisName: Red_Potion", "    Name: Red Potion", "    Type: Healing", "  - Id: 502", "    AegisName: Orange_Potion", "    Name: Orange Potion"),
    ]);
    expect(items).toEqual([
      { id: 501, aegisName: "Red_Potion", name: "Red Potion", type: "Healing", source: "db/a.yml:2" },
      { id: 502, aegisName: "Orange_Potion", name: "Orange Potion", type: null, source: "db/a.yml:6" },
    ]);
    expect(report).toMatchObject({ files: 1, entries: 2, skipped: 0, duplicates: 0 });
  });

  it("une entree d'un fichier suivant ne modifie que les champs qu'elle ecrit", () => {
    const { items } = readItemDatabase([
      file("db/a.yml", "Body:", "  - Id: 501", "    AegisName: Red_Potion", "    Name: Red Potion", "    Type: Healing"),
      file("db/import.yml", "Body:", "  - Id: 501", "    Name: Crimson Potion"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 501, aegisName: "Red_Potion", name: "Crimson Potion", type: "Healing", source: "db/a.yml:2" });
  });

  it("renomme l'AegisName d'un objet existant et libere l'ancien nom", () => {
    const { items } = readItemDatabase([
      file("a.yml", "Body:", "  - Id: 1", "    AegisName: Old", "    Name: A", "  - Id: 2", "    AegisName: Other", "    Name: B"),
      file("b.yml", "Body:", "  - Id: 1", "    AegisName: New", "  - Id: 3", "    AegisName: Old", "    Name: C"),
    ]);
    expect(items.map((item) => [item.id, item.aegisName])).toEqual([[1, "New"], [2, "Other"], [3, "Old"]]);
  });

  it("ignore en entier une entree dont l'AegisName appartient deja a un autre objet (sans tenir compte de la casse)", () => {
    const { items, report } = readItemDatabase([
      file("a.yml", "Body:", "  - Id: 1", "    AegisName: Same", "    Name: A", "  - Id: 2", "    AegisName: SAME", "    Name: B", "    Type: Weapon"),
    ]);
    expect(items.map((item) => item.id)).toEqual([1]);
    expect(report.duplicates).toBe(1);
  });

  it("ignore un identifiant invalide et un nouvel objet sans AegisName ou sans Name", () => {
    const { items, report } = readItemDatabase([
      file("a.yml", "Body:", "  - Id: abc", "    AegisName: A", "    Name: A", "  - Id: 5", "    Name: Sans aegis", "  - Id: 6", "    AegisName: SansNom", "  - Id: -1", "    AegisName: B", "    Name: B", "  - Id: 7", "    AegisName: Ok", "    Name: Ok"),
    ]);
    expect(items.map((item) => item.id)).toEqual([7]);
    expect(report.skipped).toBe(4);
  });

  it("Header: Clear efface les objets des fichiers precedents", () => {
    const { items } = readItemDatabase([
      file("a.yml", "Body:", "  - Id: 1", "    AegisName: A", "    Name: A"),
      file("b.yml", "Header:", "  Clear: true", "Body:", "  - Id: 2", "    AegisName: B", "    Name: B"),
    ]);
    expect(items.map((item) => item.id)).toEqual([2]);
  });

  it("signale les lignes non comprises avec leur fichier", () => {
    const { report } = readItemDatabase([file("db/x.yml", "Body:", "  - Id: 1", "    AegisName: A", "    Name: A", "  - oops")]);
    expect(report.unreadable).toEqual(["db/x.yml:5"]);
  });
});

describe("readMobDatabase", () => {
  it("lit identifiant, noms et niveau ; le nom japonais vaut le nom d'affichage par defaut", () => {
    const { mobs } = readMobDatabase([
      file("m.yml", "Body:", "  - Id: 1002", "    AegisName: PORING", "    Name: Poring", "    Level: 1", "  - Id: 1113", "    AegisName: DROPS", "    Name: Drops", "    JapaneseName: ドロップス"),
    ]);
    expect(mobs).toEqual([
      { id: 1002, aegisName: "PORING", name: "Poring", japaneseName: "Poring", level: 1, source: "m.yml:2" },
      { id: 1113, aegisName: "DROPS", name: "Drops", japaneseName: "ドロップス", level: null, source: "m.yml:6" },
    ]);
  });

  it("refuse les identifiants hors des bornes du serveur et fusionne les fichiers suivants", () => {
    expect(isValidMobId(1000)).toBe(false);
    expect(isValidMobId(1001)).toBe(true);
    expect(isValidMobId(3998)).toBe(true);
    expect(isValidMobId(3999)).toBe(false);
    expect(isValidMobId(20020)).toBe(false);
    expect(isValidMobId(20021)).toBe(true);
    expect(isValidMobId(31999)).toBe(false);
    const { mobs, report } = readMobDatabase([
      file("a.yml", "Body:", "  - Id: 1002", "    AegisName: PORING", "    Name: Poring", "  - Id: 500", "    AegisName: TOO_LOW", "    Name: Bas"),
      file("b.yml", "Body:", "  - Id: 1002", "    Level: 5", "    Name: Gros Poring"),
    ]);
    expect(mobs).toHaveLength(1);
    expect(mobs[0]).toMatchObject({ id: 1002, aegisName: "PORING", name: "Gros Poring", level: 5 });
    expect(report.skipped).toBe(1);
  });
});

describe("readConstantDatabase", () => {
  it("lit nom, valeur et parametre ; ne garde du nom que les caracteres que le serveur lit ; la premiere definition l'emporte", () => {
    const { constants, report } = readConstantDatabase([
      file("db/const.yml", "Body:", "  - Name: SWORDCLAN", "    Value: 1", "  - Name: BaseX!junk", "    Value: 0x10", "    Parameter: true", "  - Name: swordclan", "    Value: 9", "  - Name: Sans_valeur", "  - Name: !!!", "    Value: 3"),
    ]);
    expect(constants).toEqual([
      { name: "SWORDCLAN", value: 1, parameter: false, deprecated: false, source: "db/const.yml:2" },
      { name: "BaseX", value: 16, parameter: true, deprecated: false, source: "db/const.yml:4" },
    ]);
    expect(report).toMatchObject({ skipped: 2, duplicates: 1 });
  });
});

describe("parseScriptConstants", () => {
  const HPP = [
    "#ifndef SCRIPT_CONSTANTS_HPP",
    "\t#define export_constant(a) script_set_constant(#a,a,false,false)",
    "\t#define export_constant_npc(a) export_constant_offset(a,3)",
    "\texport_constant(INT_MAX);",
    "\t// export_constant(COMMENTAIRE);",
    '\texport_constant2("Job_SuperNovice",JOB_SUPER_NOVICE); // TODO',
    '\texport_constant2("EAJL_2_1", 0x10);',
    '\texport_parameter("BaseLevel",SP_BASELEVEL);',
    "\texport_deprecated_constant(OLD_ONE);",
    '\texport_deprecated_constant2("Old_Two",NEW_TWO);',
    "\texport_constant_npc(JT_4_M_01);",
    "\texport_constant(INT_MAX);",
    "\tsomething_else(X);",
  ].join("\n");

  it("lit les noms exportes, les valeurs ecrites en clair, les parametres et les obsoletes", () => {
    const constants = parseScriptConstants(HPP, "src/map/script_constants.hpp");
    expect(constants.map((constant) => [constant.name, constant.value, constant.parameter, constant.deprecated, constant.source])).toEqual([
      ["INT_MAX", null, false, false, "src/map/script_constants.hpp:4"],
      ["Job_SuperNovice", null, false, false, "src/map/script_constants.hpp:6"],
      ["EAJL_2_1", 16, false, false, "src/map/script_constants.hpp:7"],
      ["BaseLevel", null, true, false, "src/map/script_constants.hpp:8"],
      ["OLD_ONE", null, false, true, "src/map/script_constants.hpp:9"],
      ["Old_Two", null, false, true, "src/map/script_constants.hpp:10"],
      ["4_M_01", null, false, false, "src/map/script_constants.hpp:11"],
    ]);
  });

  it("n'invente pas les sprites sans la definition du macro qui retire le prefixe", () => {
    expect(parseScriptConstants("export_constant_npc(JT_X);", "p").map((constant) => constant.name)).toEqual([]);
  });
});

describe("readMapIndex - mapindex_init", () => {
  it("numerote les cartes sans index, lit les index explicites et ignore les commentaires", () => {
    const { maps } = readMapIndex([file("db/map_index.txt", "// commentaire", "alb_ship 1", "alb2trea", "alberta", "", "prontera\t10", "prt_fild08")]);
    expect(maps.map((map) => [map.name, map.index])).toEqual([["alb_ship", 1], ["alb2trea", 2], ["alberta", 3], ["prontera", 10], ["prt_fild08", 11]]);
    expect(maps[0]?.source).toBe("db/map_index.txt:2");
  });

  it("continue la numerotation d'un fichier a l'autre et remplace une carte dont l'index est reecrit", () => {
    const { maps } = readMapIndex([file("db/map_index.txt", "a 1", "b", "c"), file("db/import/map_index.txt", "mymap", "other 2", "last")]);
    // `b` (index 2) devient `other`, `c` (index 3) devient `last` : les index reecrits remplacent les cartes.
    expect(maps.map((map) => [map.name, map.index])).toEqual([["a", 1], ["other", 2], ["last", 3], ["mymap", 4]]);
  });

  it("retire l'extension .gat, lit les fins de ligne CRLF et ne retient que 11 caracteres du nom", () => {
    const { maps } = readMapIndex([file("m.txt", "abc.gat 1\r", "abcdefghijklmnop 2\r")]);
    expect(maps.map((map) => map.name)).toEqual(["abc", "abcdefghijk"]);
  });
});
