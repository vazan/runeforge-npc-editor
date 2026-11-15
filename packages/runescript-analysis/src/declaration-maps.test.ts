import { CommandRegistry, ReferenceCatalog } from "@runeforge/emulator-core";
import type { MapRecord } from "@runeforge/emulator-core";
import { parse } from "@runeforge/runescript-parser";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "./analyze";

const registry = CommandRegistry.create([], "rAthena");

const MAPS: MapRecord[] = [
  { name: "prontera", index: 1, source: "db/map_index.txt:1" },
  { name: "prt_fild08", index: 2, source: "db/map_index.txt:2" },
  { name: "2@cata", index: 3, source: "db/map_index.txt:3" },
  { name: "moc_fild04", index: 4, source: "db/map_index.txt:4" },
];

function catalogOf(options: { maps?: MapRecord[]; loadedMaps?: readonly string[] | null } = {}): ReferenceCatalog {
  return ReferenceCatalog.create({ maps: options.maps ?? MAPS, loadedMaps: options.loadedMaps === undefined ? ["prontera", "prt_fild08", "2@cata"] : options.loadedMaps }, "rAthena");
}

interface Found {
  readonly code: string;
  readonly text: string;
}

/** Les diagnostics de carte (RA0008, RA0015) d'un fichier, avec le texte qu'ils soulignent. */
function maps(source: string, catalog: ReferenceCatalog | null = catalogOf()): Found[] {
  const analysis = analyzeFile(parse(source), "t.txt", { commands: registry, references: catalog });
  return analysis.diagnostics
    .filter((diagnostic) => diagnostic.code === "RA0008" || diagnostic.code === "RA0015")
    .map((diagnostic) => ({ code: diagnostic.code, text: source.slice(diagnostic.range.start, diagnostic.range.end) }));
}

const script = (map: string): string => `${map},10,10,4\tscript\tA\t100,{\n\tclose;\n}\n`;
const warp = (map: string, to: string): string => `${map},10,10,0\twarp\tW\t2,2,${to},100,100\n`;
const shop = (map: string): string => `${map},10,10,4\tshop\tS\t100,501:50\n`;
const monster = (map: string): string => `${map},10,10,5,5\tmonster\tPoring\t1002,10,5000,0\n`;
const duplicate = (map: string): string => `${map},10,10,4\tduplicate(A)\tB\t100\n`;
const mapflag = (map: string): string => `${map}\tmapflag\tnoteleport\n`;

describe("cartes des declarations (RA0008, RA0015)", () => {
  it("signale une carte absente de l'index, sur son nom dans l'en-tete", () => {
    expect(maps(script("nowhere"))).toEqual([{ code: "RA0008", text: "nowhere" }]);
    expect(maps(script("prontera"))).toEqual([]);
  });

  it("signale une carte de l'index que le serveur ne charge pas : il ignore la declaration sans rien dire", () => {
    expect(maps(script("moc_fild04"))).toEqual([{ code: "RA0015", text: "moc_fild04" }]);
  });

  it("verifie chaque sorte de declaration (script, warp, boutique, monstres, duplicate)", () => {
    expect(maps(script("moc_fild04"))).toEqual([{ code: "RA0015", text: "moc_fild04" }]);
    expect(maps(warp("moc_fild04", "prontera"))).toEqual([{ code: "RA0015", text: "moc_fild04" }]);
    expect(maps(shop("moc_fild04"))).toEqual([{ code: "RA0015", text: "moc_fild04" }]);
    expect(maps(monster("moc_fild04"))).toEqual([{ code: "RA0015", text: "moc_fild04" }]);
    expect(maps(duplicate("moc_fild04"))).toEqual([{ code: "RA0015", text: "moc_fild04" }]);
    for (const declaration of [script, shop, monster, duplicate]) expect(maps(declaration("nowhere"))).toEqual([{ code: "RA0008", text: "nowhere" }]);
    expect(maps(warp("nowhere", "prontera"))).toEqual([{ code: "RA0008", text: "nowhere" }]);
  });

  it("verifie la destination d'un warp dans l'index (le serveur l'exige), pas parmi les cartes chargees", () => {
    expect(maps(warp("prontera", "nowhere"))).toEqual([{ code: "RA0008", text: "nowhere" }]);
    // Une destination de l'index que ce serveur ne charge pas : le warp existe (le joueur ne pourra pas y entrer), rien d'aussi net a dire.
    expect(maps(warp("prontera", "moc_fild04"))).toEqual([]);
    expect(maps(warp("prontera", "prt_fild08"))).toEqual([]);
  });

  it("verifie une ligne mapflag dans l'index, mais ne reproche pas une carte non chargee (la distribution en livre pour des cartes desactivees)", () => {
    expect(maps(mapflag("nowhere"))).toEqual([{ code: "RA0008", text: "nowhere" }]);
    expect(maps(mapflag("moc_fild04"))).toEqual([]);
    expect(maps(mapflag("prontera"))).toEqual([]);
  });

  it("ignore un NPC flottant (`-`), une fonction et une declaration sans carte", () => {
    expect(maps("-\tscript\tFloating\t-1,{\n\tend;\n}\n")).toEqual([]);
    expect(maps("function\tscript\tF_Lib\t{\n\treturn;\n}\n")).toEqual([]);
  });

  it("ne dit rien de la liste des cartes chargees quand elle n'est pas connue, mais verifie toujours l'index", () => {
    for (const loadedMaps of [null, [], undefined]) {
      const catalog = ReferenceCatalog.create({ maps: MAPS, ...(loadedMaps === undefined ? {} : { loadedMaps }) }, "rAthena");
      expect(maps(script("moc_fild04"), catalog)).toEqual([]);
      expect(maps(script("nowhere"), catalog)).toEqual([{ code: "RA0008", text: "nowhere" }]);
    }
  });

  it("ne dit rien sans catalogue, ni avec un index des cartes vide (rien n'autorise a dire qu'une carte manque)", () => {
    expect(maps(script("nowhere"), null)).toEqual([]);
    const emptyIndex = ReferenceCatalog.create({ items: [{ id: 501, aegisName: "Red_Potion", name: "Red Potion", type: null, source: "db/i.yml:1" }], loadedMaps: ["prontera"] }, "rAthena");
    expect(maps(script("nowhere"), emptyIndex)).toEqual([]);
    expect(maps(script("moc_fild04"), emptyIndex)).toEqual([]);
  });

  it("retire `.gat` des deux cotes et distingue les casses, comme le serveur", () => {
    expect(maps(script("prontera.gat"))).toEqual([]);
    expect(maps(script("moc_fild04.gat"))).toEqual([{ code: "RA0015", text: "moc_fild04.gat" }]);
    expect(maps(script("Prontera"))).toEqual([{ code: "RA0008", text: "Prontera" }]);
    expect(maps(script("prontera"), catalogOf({ loadedMaps: ["prontera.gat"] }))).toEqual([]);
  });

  it("traite une carte d'instance comme les autres, et ne verifie pas un texte qui n'est pas un nom de carte", () => {
    expect(maps(script("2@cata"))).toEqual([]);
    expect(maps(script("1@gef"))).toEqual([{ code: "RA0008", text: "1@gef" }]);
    expect(maps(script("ma carte"))).toEqual([]);
  });

  it("signale chaque declaration d'un fichier a son propre endroit", () => {
    const source = script("moc_fild04") + warp("prontera", "nowhere") + shop("prontera") + monster("nowhere");
    expect(maps(source)).toEqual([
      { code: "RA0015", text: "moc_fild04" },
      { code: "RA0008", text: "nowhere" },
      { code: "RA0008", text: "nowhere" },
    ]);
  });

  it("garde l'ordre des diagnostics par position dans le fichier", () => {
    const source = script("nowhere") + script("moc_fild04") + warp("prontera", "nowhere");
    const analysis = analyzeFile(parse(source), "t.txt", { commands: registry, references: catalogOf() });
    const starts = analysis.diagnostics.map((diagnostic) => diagnostic.range.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(analysis.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RA0008", "RA0015", "RA0008"]);
  });
});
