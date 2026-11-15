import { describe, expect, it } from "vitest";
import { CommandRegistry, ReferenceCatalog } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { LineIndex } from "@runeforge/runescript-core";
import type { Position } from "@runeforge/runescript-core";
import { LanguageServer } from "./server";
import { CompletionItemKind } from "./types";

const npc = (body: string): string => `prontera,150,150,4\tscript\tTest\t4_M_01,{\n${body}\n}\n`;

function command(name: string, ...signatures: string[]): CommandDefinition {
  return { name, arity: null, parameterTypes: null, signatures, documentation: null, deprecated: false, conditional: false, sources: [{ kind: "server-doc", reference: "doc.txt:1" }] };
}

const REGISTRY = CommandRegistry.create(
  [
    command("warp", 'warp "<map name>",<x>,<y>{,<char_id>};'),
    command("getitem", "getitem <item id>,<amount>{,<account ID>};", 'getitem "<item name>",<amount>{,<account ID>};'),
    command("monster", 'monster "<map name>",<x>,<y>,"<name to show>",<mob id>,<amount>;', 'monster "<map name>",<x>,<y>,"<name to show>","<mob name>",<amount>;'),
    command("skill", "skill <skill id>,<level>;", 'skill "<skill name>",<level>;'),
    command("getskilllv", "getskilllv(<skill id>)", 'getskilllv("<skill name>")'),
    command("plagiarizeskill", "plagiarizeskill <skill_id>,<level>;"),
    command("mes", 'mes "<string>";'),
    command("set", "set <variable>,<expression>;"),
  ],
  "rAthena",
);

const CATALOG = ReferenceCatalog.create(
  {
    items: [
      { id: 501, aegisName: "Red_Potion", name: "Red Potion", type: "Healing", source: "db/i.yml:1" },
      { id: 502, aegisName: "Orange_Potion", name: "Orange Potion", type: "Healing", source: "db/i.yml:2" },
      { id: 5010, aegisName: "Red_Ribbon", name: "Red Ribbon", type: "Armor", source: "db/i.yml:3" },
    ],
    mobs: [
      { id: 1002, aegisName: "PORING", name: "Poring", japaneseName: "Poring", level: 1, source: "db/m.yml:1" },
      { id: 1113, aegisName: "DROPS", name: "Drops", japaneseName: "Drops", level: 3, source: "db/m.yml:2" },
    ],
    skills: [{ id: 10, name: "TEST_SKILL", description: "Test skill", maxLevel: 2, source: "db/re/skill_db.yml:1" }],
    maps: [
      { name: "prontera", index: 1, source: "db/map_index.txt:1" },
      { name: "prt_fild08", index: 2, source: "db/map_index.txt:2" },
    ],
    constants: [
      { name: "Job_Alchemist", value: null, parameter: false, deprecated: false, source: "src/map/script_constants.hpp:10" },
      { name: "Job_Assassin", value: 12, parameter: false, deprecated: false, source: "src/map/script_constants.hpp:11" },
      { name: "BaseLevel", value: null, parameter: true, deprecated: false, source: "src/map/script_constants.hpp:12" },
    ],
  },
  "rAthena",
);

function setup(source: string, options: { catalog?: ReferenceCatalog | null } = {}): { ls: LanguageServer; position: Position; text: string } {
  const ls = new LanguageServer();
  ls.setCommandRegistry(REGISTRY);
  ls.setReferenceCatalog(options.catalog === undefined ? CATALOG : options.catalog);
  const offset = source.indexOf("|");
  if (offset === -1) throw new Error("curseur | absent");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  ls.updateDocument("a.txt", 1, text);
  return { ls, position: new LineIndex(text).positionAt(offset), text };
}

const labels = (items: readonly { label: string }[]): string[] => items.map((item) => item.label);
const referenceCodes = (ls: LanguageServer): string[] => ls.diagnostics("a.txt").filter((d) => ["RA0008", "RA0009", "RA0010"].includes(d.code)).map((d) => d.code);

describe("references de competences", () => {
  it("complete un identifiant en instruction et un nom dans un appel parenthese", () => {
    const byId = setup(npc("\tskill 1|,1;"));
    expect(byId.ls.completion("a.txt", byId.position)).toMatchObject([{ label: "TEST_SKILL", insertText: "10", reference: { kind: "skill", id: 10 } }]);
    const byName = setup(npc('\tset .@lv,getskilllv("test_|");'));
    expect(byName.ls.completion("a.txt", byName.position)).toMatchObject([{ label: "TEST_SKILL", reference: { kind: "skill", id: 10 } }]);
    const otherArg = setup(npc("\tskill 10,1|;"));
    expect(otherArg.ls.completion("a.txt", otherArg.position).some((item) => item.reference?.kind === "skill")).toBe(false);
  });

  it("ne propose pas de nom a une commande documentee pour les seuls identifiants", () => {
    const byName = setup(npc('\tplagiarizeskill "test_|",1;'));
    expect(byName.ls.completion("a.txt", byName.position)).toEqual([]);
    const byId = setup(npc("\tplagiarizeskill 1|,1;"));
    expect(byId.ls.completion("a.txt", byId.position)).toMatchObject([{ insertText: "10", reference: { kind: "skill", id: 10 } }]);
  });

  it("decrit une competence connue par identifiant ou par nom, sans diagnostiquer les inconnues", () => {
    for (const literal of ["1|0", '"test_|skill"']) {
      const { ls, position } = setup(npc(`\tskill ${literal},1;`));
      expect(ls.hover("a.txt", position)).toMatchObject({ kind: "reference", referenceKind: "skill", record: { id: 10, maxLevel: 2 } });
    }
    const missing = setup(npc('\tskill "un|known",1;'));
    expect(missing.ls.hover("a.txt", missing.position)).toBeUndefined();
    expect(missing.ls.diagnostics("a.txt")).toEqual([]);
  });
});

describe("diagnostics RA0008-RA0010", () => {
  const source = npc('\twarp "nowhere",1,1;\n\tgetitem 99999,1;\n\tmonster "prontera",1,1,"x",9999,1;');

  it("signale carte, objet et monstre introuvables, avec la gravite de `unknownReferences` (information par defaut)", () => {
    const { ls } = setup(source.replace("\n}", "|\n}"));
    expect(referenceCodes(ls)).toEqual(["RA0008", "RA0009", "RA0010"]);
    expect(ls.diagnostics("a.txt").find((d) => d.code === "RA0009")?.severity).toBe("info");
    ls.setOptions({ unknownReferences: "warning" });
    expect(ls.diagnostics("a.txt").filter((d) => d.code.startsWith("RA00") && d.code >= "RA0008").map((d) => d.severity)).toEqual(["warning", "warning", "warning"]);
    ls.setOptions({ unknownReferences: "off" });
    expect(referenceCodes(ls)).toEqual([]);
  });

  it("analyse de nouveau les documents ouverts quand le catalogue change ou disparait", () => {
    const { ls } = setup(source.replace("\n}", "|\n}"), { catalog: null });
    expect(referenceCodes(ls)).toEqual([]);
    ls.setReferenceCatalog(CATALOG);
    expect(referenceCodes(ls)).toEqual(["RA0008", "RA0009", "RA0010"]);
    ls.setReferenceCatalog(null);
    expect(referenceCodes(ls)).toEqual([]);
  });
});

describe("completion des arguments : objets et monstres", () => {
  it("propose sur demande explicite les objets d'un argument d'objet, ecrits par identifiant hors d'une chaine", () => {
    const { ls, position } = setup(npc("\tgetitem |"));
    expect(ls.completion("a.txt", position)).toEqual([]);
    // Les commandes (`getarg(0)` peut aussi etre un argument) suivent les references, qui passent en premier.
    const all = ls.completion("a.txt", position, { explicit: true });
    expect(all.slice(0, 3).map((item) => item.reference?.kind)).toEqual(["item", "item", "item"]);
    const items = all.filter((item) => item.reference !== undefined);
    expect(labels(items)).toEqual(["Red_Potion", "Orange_Potion", "Red_Ribbon"]);
    expect(items[0]).toMatchObject({ kind: CompletionItemKind.Value, insertText: "501", detail: "501 · Red Potion · Healing", reference: { kind: "item", id: 501 } });
    expect(items[0]?.filterText).toBe("501 Red_Potion Red Potion");
  });

  it("filtre par identifiant, par nom ou par nom d'affichage, sans rien demander d'explicite", () => {
    expect(labels(setup(npc("\tgetitem 50|")).ls.completion("a.txt", setup(npc("\tgetitem 50|")).position))).toEqual(["Red_Potion", "Orange_Potion", "Red_Ribbon"]);
    const byName = setup(npc("\tgetitem Red|"));
    expect(labels(byName.ls.completion("a.txt", byName.position))).toEqual(["Red_Potion", "Red_Ribbon"]);
    // Dans une chaine, le fragment peut compter plusieurs mots (nom d'affichage) : tous doivent correspondre.
    const byDisplay = setup(npc('\tgetitem "orange pot|'));
    expect(labels(byDisplay.ls.completion("a.txt", byDisplay.position))).toEqual(["Orange_Potion"]);
  });

  it("dans une chaine, propose le nom sans guillemets et remplace seulement ce qui est ecrit", () => {
    const { ls, position, text } = setup(npc('\tgetitem "Red_|",1;'));
    const items = ls.completion("a.txt", position);
    expect(labels(items)).toEqual(["Red_Potion", "Red_Ribbon"]);
    expect(items[0]?.insertText).toBeUndefined();
    // Le remplacement va du premier caractere apres le guillemet au guillemet fermant.
    const start = text.indexOf('"Red_') + 1;
    expect(new LineIndex(text).offsetAt(items[0]?.range.start ?? { line: 0, character: 0 }, text)).toBe(start);
    expect(new LineIndex(text).offsetAt(items[0]?.range.end ?? { line: 0, character: 0 }, text)).toBe(text.indexOf('",1;'));
  });

  it("propose les monstres d'un argument de monstre, par identifiant ou par nom dans une chaine", () => {
    const byId = setup(npc('\tmonster "prontera",1,1,"x",|'));
    expect(byId.ls.completion("a.txt", byId.position, { explicit: true }).filter((item) => item.reference !== undefined).map((item) => item.insertText)).toEqual(["1002", "1113"]);
    const byName = setup(npc('\tmonster "prontera",1,1,"x","PO|'));
    const items = byName.ls.completion("a.txt", byName.position);
    expect(labels(items)).toEqual(["PORING"]);
    expect(items[0]?.insertText).toBeUndefined();
  });
});

describe("completion des arguments : cartes", () => {
  it("ecrit une carte entre guillemets quand elle est proposee hors d'une chaine", () => {
    const { ls, position } = setup(npc("\twarp |"));
    const items = ls.completion("a.txt", position, { explicit: true }).filter((item) => item.reference !== undefined);
    expect(labels(items)).toEqual(["prontera", "prt_fild08"]);
    expect(items[0]).toMatchObject({ insertText: '"prontera"', detail: "#1", reference: { kind: "map", id: 1 } });
  });

  it("dans une chaine, filtre par fragment et ne rajoute pas de guillemets", () => {
    const { ls, position } = setup(npc('\twarp "prt|'));
    const items = ls.completion("a.txt", position);
    expect(labels(items)).toEqual(["prt_fild08"]);
    expect(items[0]?.insertText).toBeUndefined();
  });

  it("ne propose rien dans une chaine qui n'est pas l'argument d'un objet, d'un monstre ou d'une carte", () => {
    const { ls, position } = setup(npc('\tmes "Red|'));
    expect(ls.completion("a.txt", position)).toEqual([]);
    const second = setup(npc('\twarp "prontera",1,"Red|'));
    expect(second.ls.completion("a.txt", second.position)).toEqual([]);
  });

  it("ne propose rien sans catalogue", () => {
    const { ls, position } = setup(npc("\tgetitem |"), { catalog: null });
    expect(ls.completion("a.txt", position, { explicit: true }).filter((item) => item.reference !== undefined)).toEqual([]);
  });
});

describe("completion des constantes", () => {
  it("propose les constantes du serveur a une position d'operande, avec leur valeur quand elle est connue", () => {
    const { ls, position } = setup(npc("\tif (Class == Job_A|) {\n\t}"));
    const items = ls.completion("a.txt", position).filter((item) => item.reference?.kind === "constant");
    expect(items.map((item) => [item.label, item.kind, item.detail])).toEqual([
      ["Job_Alchemist", CompletionItemKind.Constant, ""],
      ["Job_Assassin", CompletionItemKind.Constant, "= 12"],
    ]);
  });

  it("n'ouvre pas de liste de constantes pour une seule lettre, mais la donne sur demande explicite", () => {
    const one = setup(npc("\tset .@x, J|;"));
    expect(one.ls.completion("a.txt", one.position).filter((item) => item.reference?.kind === "constant")).toEqual([]);
    const explicit = setup(npc("\tset .@x, J|;"));
    expect(explicit.ls.completion("a.txt", explicit.position, { explicit: true }).filter((item) => item.reference?.kind === "constant")).toHaveLength(2);
  });

  it("ne propose pas de constante a la place d'un objet ou d'une carte", () => {
    const { ls, position } = setup(npc("\tgetitem Job|"));
    expect(ls.completion("a.txt", position).filter((item) => item.reference?.kind === "constant")).toEqual([]);
  });
});

describe("survol des references", () => {
  const hoverAt = (source: string): ReturnType<LanguageServer["hover"]> => {
    const { ls, position } = setup(source);
    return ls.hover("a.txt", position);
  };

  it("decrit l'objet ecrit par identifiant, par AegisName ou par nom d'affichage", () => {
    for (const written of ["501", '"Red_Potion"', '"red potion"']) {
      const hover = hoverAt(npc(`\tgetitem ${written.slice(0, 1)}|${written.slice(1)},1;`));
      expect(hover).toMatchObject({ kind: "reference", referenceKind: "item", record: { id: 501, aegisName: "Red_Potion", source: "db/i.yml:1" } });
    }
  });

  it("signale un objet, un monstre ou une carte introuvable (record null), comme le diagnostic", () => {
    expect(hoverAt(npc("\tgetitem 9|9999,1;"))).toMatchObject({ kind: "reference", referenceKind: "item", written: "99999", record: null });
    expect(hoverAt(npc('\twarp "no|where",1,1;'))).toMatchObject({ kind: "reference", referenceKind: "map", written: "nowhere", record: null });
  });

  it("decrit un monstre et une carte", () => {
    expect(hoverAt(npc('\tmonster "prontera",1,1,"x",10|02,1;'))).toMatchObject({ kind: "reference", referenceKind: "mob", record: { id: 1002, name: "Poring" } });
    expect(hoverAt(npc('\twarp "pro|ntera",1,1;'))).toMatchObject({ kind: "reference", referenceKind: "map", record: { name: "prontera", index: 1 } });
  });

  it("ne dit rien d'une valeur speciale, de zero, ni d'un argument qui n'est ni objet ni monstre ni carte", () => {
    expect(hoverAt(npc('\twarp "Ran|dom",0,0;'))).toBeUndefined();
    expect(hoverAt(npc("\tgetitem 0|,1;"))).toBeUndefined();
    expect(hoverAt(npc("\tgetitem 501,1|;"))).toBeUndefined();
    expect(hoverAt(npc('\tmes "Red_Po|tion";'))).toBeUndefined();
  });

  it("decrit une constante du serveur, mais laisse la priorite aux symboles du projet", () => {
    expect(hoverAt(npc("\tif (Class == Job_Alch|emist) {\n\t}"))).toMatchObject({ kind: "constant", constant: { name: "Job_Alchemist", source: "src/map/script_constants.hpp:10" } });
    expect(hoverAt(npc("\tif (BaseLev|el > 5) {\n\t}"))).toMatchObject({ kind: "constant", constant: { name: "BaseLevel", parameter: true } });
    expect(hoverAt(npc("\tif (Class == Unknow|n) {\n\t}"))).toBeUndefined();
  });
});

describe("recherche dans le catalogue", () => {
  it("retrouve des references par nom ou identifiant, et ne sait rien sans catalogue", () => {
    const { ls } = setup(npc("\tclose;|"));
    expect(ls.searchReferences("item", "red", 10).map((hit) => hit.name)).toEqual(["Red_Potion", "Red_Ribbon"]);
    expect(ls.searchReferences("mob", "1002", 10).map((hit) => hit.name)).toEqual(["PORING"]);
    expect(ls.searchReferences("map", "prt", 10).map((hit) => hit.name)).toEqual(["prt_fild08"]);
    expect(ls.searchReferences("constant", "job_a", 10).map((hit) => hit.name)).toEqual(["Job_Alchemist", "Job_Assassin"]);
    expect(ls.referenceStats()).toEqual({ items: 3, mobs: 2, skills: 1, maps: 2, constants: 3 });
    ls.setReferenceCatalog(null);
    expect(ls.searchReferences("item", "red", 10)).toEqual([]);
    expect(ls.referenceStats()).toBeNull();
  });
});
