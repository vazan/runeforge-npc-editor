import { CommandRegistry, ReferenceCatalog } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { parse } from "@runeforge/runescript-parser";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "./analyze";

function command(name: string, ...signatures: string[]): CommandDefinition {
  return { name, arity: null, parameterTypes: null, signatures, documentation: null, deprecated: false, conditional: false, sources: [{ kind: "server-doc", reference: "doc.txt:1" }] };
}

const registry = CommandRegistry.create(
  [
    command("warp", 'warp "<map name>",<x>,<y>{,<char_id>};'),
    command("getitem", "getitem <item id>,<amount>{,<account ID>};", 'getitem "<item name>",<amount>{,<account ID>};'),
    command("monster", 'monster "<map name>",<x>,<y>,"<name to show>",<mob id>,<amount>;', 'monster "<map name>",<x>,<y>,"<name to show>","<mob name>",<amount>;'),
    command("mes", 'mes "<string>";'),
  ],
  "rAthena",
);

const catalog = ReferenceCatalog.create(
  {
    items: [
      { id: 501, aegisName: "Red_Potion", name: "Red Potion", type: "Healing", source: "db/i.yml:1" },
      { id: 502, aegisName: "Orange_Potion", name: "Orange Potion", type: "Healing", source: "db/i.yml:2" },
    ],
    mobs: [{ id: 1002, aegisName: "PORING", name: "Poring", japaneseName: "ポリン", level: 1, source: "db/m.yml:1" }],
    maps: [
      { name: "prontera", index: 1, source: "db/map_index.txt:1" },
      { name: "prt_fild08", index: 2, source: "db/map_index.txt:2" },
      { name: "2@cata", index: 3, source: "db/map_index.txt:3" },
      { name: "force_5-1", index: 4, source: "db/map_index.txt:4" },
    ],
  },
  "rAthena",
);

function diagnose(body: string, withCatalog = true): { code: string; text: string; name: unknown }[] {
  const source = `prontera,1,1,0\tscript\tTest\t100,{\n${body}\n}\n`;
  const parsed = parse(source);
  const analysis = analyzeFile(parsed, "t.txt", { commands: registry, references: withCatalog ? catalog : null });
  return analysis.diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith("RA00") && ["RA0008", "RA0009", "RA0010"].includes(diagnostic.code))
    .map((diagnostic) => ({ code: diagnostic.code, text: source.slice(diagnostic.range.start, diagnostic.range.end), name: diagnostic.params?.["name"] }));
}

describe("RA0008 - carte inconnue", () => {
  it("signale une carte absente de l'index, sur la chaine elle-meme", () => {
    expect(diagnose('\twarp "nowhere",1,1;')).toEqual([{ code: "RA0008", text: '"nowhere"', name: "nowhere" }]);
    expect(diagnose('\twarp "prontera",1,1;\n\twarp "prt_fild08",1,1;\n\twarp "prontera.gat",1,1;')).toEqual([]);
  });

  it("la casse compte comme pour l'index du serveur", () => {
    expect(diagnose('\twarp "Prontera",1,1;')).toEqual([{ code: "RA0008", text: '"Prontera"', name: "Prontera" }]);
  });

  it("verifie comme les autres les cartes d'instance (`2@cata`) et les noms avec un tiret (`force_5-1`)", () => {
    expect(diagnose('\twarp "2@cata",1,1;\n\twarp "force_5-1",1,1;')).toEqual([]);
    expect(diagnose('\twarp "1@gef",1,1;')).toEqual([{ code: "RA0008", text: '"1@gef"', name: "1@gef" }]);
  });

  it("ne dit rien des valeurs speciales du manuel, des textes qui ne sont pas des noms de carte, des variables ni des expressions", () => {
    expect(diagnose('\twarp "Random",0,0;\n\twarp "SavePoint",0,0;\n\twarp "Save",0,0;\n\twarp "RandomAll",0,0;\n\tmonster "this",1,1,"x",1002,1;')).toEqual([]);
    expect(diagnose('\twarp "a b",1,1;\n\twarp "x#1",1,1;')).toEqual([]);
    expect(diagnose('\twarp .@map$,1,1;\n\twarp "pront" + "era",1,1;\n\twarp getarg(0),1,1;')).toEqual([]);
  });
});

describe("RA0009 - objet inconnu", () => {
  it("accepte un identifiant, un AegisName ou un nom d'affichage connus, sans tenir compte de la casse", () => {
    expect(diagnose('\tgetitem 501,1;\n\tgetitem "Red_Potion",1;\n\tgetitem "red potion",1;\n\tgetitem "ORANGE_POTION",1;')).toEqual([]);
  });

  it("signale un identifiant ou un nom absents", () => {
    expect(diagnose('\tgetitem 99999,1;\n\tgetitem "Nope",1;')).toEqual([
      { code: "RA0009", text: "99999", name: "99999" },
      { code: "RA0009", text: '"Nope"', name: "Nope" },
    ]);
  });

  it("ne verifie ni zero, ni un nombre negatif, ni une variable, ni une chaine vide", () => {
    expect(diagnose('\tgetitem 0,1;\n\tgetitem -1,1;\n\tgetitem .@item,1;\n\tgetitem "",1;')).toEqual([]);
  });

  it("verifie malgre un nombre d'arguments faux, mais pas une instruction mal formee", () => {
    expect(diagnose("\tgetitem 99999;")).toEqual([{ code: "RA0009", text: "99999", name: "99999" }]);
    expect(diagnose("\tgetitem 99999,1\n\tmes \"x\";")).toEqual([]);
  });
});

describe("RA0010 - monstre inconnu", () => {
  it("accepte un identifiant, un AegisName, un nom d'affichage ou japonais connus", () => {
    expect(diagnose('\tmonster "prontera",1,1,"x",1002,1;\n\tmonster "prontera",1,1,"x","PORING",1;\n\tmonster "prontera",1,1,"x","poring",1;\n\tmonster "prontera",1,1,"x","ポリン",1;')).toEqual([]);
  });

  it("signale un monstre absent, a sa position (et pas le nom affiche ni la carte)", () => {
    expect(diagnose('\tmonster "prontera",1,1,"Boss",9999,1;\n\tmonster "prontera",1,1,"Boss","Nope",1;')).toEqual([
      { code: "RA0010", text: "9999", name: "9999" },
      { code: "RA0010", text: '"Nope"', name: "Nope" },
    ]);
  });

  it("ne verifie pas un identifiant negatif (groupe aleatoire)", () => {
    expect(diagnose('\tmonster "prontera",1,1,"x",-1,1;')).toEqual([]);
  });
});

describe("sans catalogue ou sans signature", () => {
  it("n'emet rien sans catalogue", () => {
    expect(diagnose('\twarp "nowhere",1,1;\n\tgetitem 99999,1;', false)).toEqual([]);
  });

  it("n'emet rien pour une commande dont le manuel ne dit rien de ses arguments", () => {
    const bare = CommandRegistry.create([command("warp")], "rAthena");
    const analysis = analyzeFile(parse('prontera,1,1,0\tscript\tT\t100,{\n\twarp "nowhere",1,1;\n}\n'), "t.txt", { commands: bare, references: catalog });
    expect(analysis.diagnostics.filter((diagnostic) => diagnostic.code === "RA0008")).toEqual([]);
  });

  it("n'emet rien sans registre de commandes", () => {
    const analysis = analyzeFile(parse('prontera,1,1,0\tscript\tT\t100,{\n\twarp "nowhere",1,1;\n}\n'), "t.txt", { references: catalog });
    expect(analysis.diagnostics.filter((diagnostic) => diagnostic.code === "RA0008")).toEqual([]);
  });

  it("uses reference signatures when the server registry has no argument documentation", () => {
    const serverRegistry = CommandRegistry.create([command("getitem")], "rAthena");
    const analysis = analyzeFile(
      parse('prontera,1,1,0\tscript\tT\t100,{\n\tgetitem 99999,1;\n}\n'),
      "t.txt",
      { commands: serverRegistry, references: catalog, referenceCommands: registry },
    );

    expect(analysis.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RA0009"]);
  });

  it("ne dit d'aucune carte qu'elle est introuvable quand l'index des cartes est vide (db/map_index.txt non lu) : seuls les objets et monstres sont verifies", () => {
    const withoutMaps = ReferenceCatalog.create({ items: [{ id: 501, aegisName: "Red_Potion", name: "Red Potion", type: "Healing", source: "db/i.yml:1" }] }, "rAthena");
    const analysis = analyzeFile(parse('prontera,1,1,0\tscript\tT\t100,{\n\twarp "nowhere",1,1;\n\tgetitem 99999,1;\n}\n'), "t.txt", { commands: registry, references: withoutMaps });
    expect(analysis.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RA0009"]);
  });
});
