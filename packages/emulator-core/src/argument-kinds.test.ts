import { describe, expect, it } from "vitest";
import { allowsSkillArgument, argumentKindsOf, kindOfParameterLabel, parameterKindsOfSignature } from "./argument-kinds";

const definition = (...signatures: string[]): { signatures: string[] } => ({ signatures });

describe("kindOfParameterLabel", () => {
  it("reconnait les noms de parametres du manuel, sans tenir compte de la casse, des espaces ni de `_`", () => {
    for (const label of ["map name", "Map Name", "mapname", "to_mapname", "from map", "dest_map", "battleground_map_name", "alternate map name", "map"]) {
      expect(kindOfParameterLabel(label), label).toBe("map");
    }
    for (const label of ["item id", "Item ID", "item_id", "item name", "aegis item name", "item"]) expect(kindOfParameterLabel(label), label).toBe("item");
    for (const label of ["mob id", "mob ID", "Monster ID", "monster_id", "mob name", "monster name"]) expect(kindOfParameterLabel(label), label).toBe("mob");
    for (const label of ["skill id", "Skill_Name"]) expect(kindOfParameterLabel(label), label).toBe("skill");
  });

  it("ecarte ce qui ne designe rien du catalogue", () => {
    for (const label of ["name to show", "variable for map name", "map id", "map mark color", "item share", "item level", "max items", "item id array", "x", "skill level"]) {
      expect(kindOfParameterLabel(label), label).toBeNull();
    }
  });
});

describe("parameterKindsOfSignature", () => {
  it("lit la nature de chaque parametre, ecrit entre guillemets ou non, obligatoire ou entre accolades", () => {
    expect(parameterKindsOfSignature('warp "<map name>",<x>,<y>{,<char_id>};')).toEqual(["map", null, null, null]);
    expect(parameterKindsOfSignature("getitem <item id>,<amount>{,<account ID>};")).toEqual(["item", null, null]);
    expect(parameterKindsOfSignature('monster "<map name>",<x>,<y>,"<name to show>",<mob id>,<amount>{,"<event label>",<size>,<ai>};')).toEqual([
      "map",
      null,
      null,
      null,
      "mob",
      null,
      null,
      null,
      null,
    ]);
  });

  it("lit la forme parenthesee", () => {
    expect(parameterKindsOfSignature("getareadropitem(<map name>,<x1>,<y1>,<x2>,<y2>,<item>)")).toEqual(["map", null, null, null, null, "item"]);
  });
});

describe("argumentKindsOf", () => {
  it("retient la nature d'une position quand toutes les signatures s'accordent (nombre ou nom)", () => {
    const getitem = definition("getitem <item id>,<amount>{,<account ID>};", 'getitem "<item name>",<amount>{,<account ID>};');
    expect(argumentKindsOf(getitem)).toEqual(["item", null, null]);
    const monster = definition(
      'monster "<map name>",<x>,<y>,"<name to show>",<mob id>,<amount>;',
      'monster "<map name>",<x>,<y>,"<name to show>","<mob name>",<amount>;',
    );
    expect(argumentKindsOf(monster)).toEqual(["map", null, null, null, "mob", null]);
  });

  it("ne retient rien quand les signatures se contredisent", () => {
    expect(argumentKindsOf(definition("cmd <item id>,<x>;", "cmd <map name>,<x>;"))).toEqual([null, null]);
    expect(argumentKindsOf(definition("cmd <item id>;", "cmd <x>,<y>;"))).toEqual([null, null]);
  });

  it("ignore une signature trop courte pour avoir un parametre a cette position", () => {
    expect(argumentKindsOf(definition("cmd <map name>;", "cmd <map name>,<item id>;"))).toEqual(["map", "item"]);
  });

  it("ne sait rien d'une commande sans signature du manuel", () => {
    expect(argumentKindsOf(definition())).toEqual([]);
  });

  it("distingue les deux formes des arguments de competence", () => {
    const skill = definition("unitskilluseid <GID>,<skill id>,<level>;", 'unitskilluseid <GID>,"<skill name>",<level>;');
    expect(argumentKindsOf(skill)).toEqual([null, "skill", null]);
    expect(allowsSkillArgument(skill, 1, "name")).toBe(true);
    expect(allowsSkillArgument(skill, 1, "id")).toBe(true);
    expect(allowsSkillArgument(skill, 0, "id")).toBe(false);
    expect(allowsSkillArgument(definition("plagiarizeskill <skill_id>,<level>;"), 0, "name")).toBe(false);
  });
});
