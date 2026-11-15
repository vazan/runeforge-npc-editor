import { parse } from "@runeforge/runescript-parser";
import { describe, expect, it } from "vitest";
import {
  addVisualCommandArgument,
  buildVisualNpc,
  createVisualCommandNode,
  createVisualIfNode,
  removeVisualCommandArgument,
  type VisualBuilderNode,
  type VisualCommandNode,
  type VisualScriptCommandDefinition,
} from "./index";

const definitions: readonly VisualScriptCommandDefinition[] = [
  { name: "mes", arity: { min: 1, max: null }, parameterTypes: "s*", signatures: ["mes <text>"], documentation: "Display text.", deprecated: false },
  { name: "close", arity: { min: 0, max: 0 }, parameterTypes: "", signatures: ["close;"], documentation: "End the dialogue.", deprecated: false },
  { name: "getitem", arity: { min: 2, max: 3 }, parameterTypes: "vi?", signatures: ["getitem <item>,<amount>"], documentation: "Give an item.", deprecated: false },
];

const header = {
  map: "prontera",
  x: "150",
  y: "150",
  direction: "4",
  name: "New NPC",
  sprite: "100",
};

function node(name: string, id: string, values: readonly string[] = []): VisualCommandNode {
  const definition = definitions.find((item) => item.name === name);
  if (definition === undefined) throw new Error("Missing test definition");
  const result = createVisualCommandNode(definition, id);
  if (result === null) throw new Error("Unsupported test definition");
  return { ...result, arguments: result.arguments.map((argument, index) => ({ ...argument, value: values[index] ?? "" })) };
}

describe("constructeur visuel de NPC", () => {
  it("generates a complete script from library-backed command nodes", () => {
    const result = buildVisualNpc(header, [
      node("mes", "message", ["Welcome to my NPC!"]),
      node("getitem", "reward", ["501", "1"]),
      node("close", "close"),
    ], definitions);

    expect(result.issues).toEqual([]);
    expect(result.source).toBe([
      "prontera,150,150,4\tscript\tNew NPC\t100,{",
      '\tmes "Welcome to my NPC!";',
      "\tgetitem 501, 1;",
      "\tclose;",
      "}",
      "",
    ].join("\n"));
    expect(parse(result.source ?? "").diagnostics).toEqual([]);
  });

  it("does not export an unfilled argument, invalid header, or injection-shaped expression", () => {
    const incomplete = buildVisualNpc(header, [node("getitem", "reward"), node("close", "close")], definitions);
    expect(incomplete.source).not.toBeNull();
    expect(incomplete.issues).toContainEqual({ code: "required-argument", nodeId: "reward", argumentId: "reward:arg:0" });

    const invalidHeader = buildVisualNpc({ ...header, name: "Bad,{ close; //" }, [node("close", "close")], definitions);
    expect(invalidHeader.source).toBeNull();
    expect(invalidHeader.issues).toContainEqual({ code: "invalid-name" });

    const injected = buildVisualNpc(header, [
      node("getitem", "reward", ["1; close;", "1"]),
      node("close", "close"),
    ], definitions);
    expect(injected.issues).toContainEqual({ code: "invalid-script" });
  });

  it("requires a terminal command and rejects unreachable nodes after close", () => {
    expect(buildVisualNpc(header, [node("mes", "message", ["Hello"])], definitions).issues)
      .toContainEqual({ code: "missing-terminal", nodeId: "message" });
    expect(buildVisualNpc(header, [
      node("close", "close"),
      node("mes", "message", ["Unreachable"]),
    ], definitions).issues).toContainEqual({ code: "terminal-not-last", nodeId: "close" });
  });

  it("generates nested branches as valid script and rejects empty conditions", () => {
    const condition = createVisualIfNode("condition", "BaseLevel > 10");
    const nestedCondition = createVisualIfNode("nested-condition", "Zeny > 1000");
    const result = buildVisualNpc(header, [
      {
        ...condition,
        then: [{
          ...nestedCondition,
          then: [node("mes", "welcome", ["Welcome"])],
        }],
        else: [node("mes", "training", ["Train more"])],
      },
      node("close", "close"),
    ], definitions);

    expect(result.issues).toEqual([]);
    expect(result.source).toContain([
      "\tif (BaseLevel > 10) {",
      "\t\tif (Zeny > 1000) {",
      '\t\t\tmes "Welcome";',
      "\t\t}",
      "\t} else {",
      '\t\tmes "Train more";',
      "\t}",
    ].join("\n"));
    expect(parse(result.source ?? "").diagnostics).toEqual([]);

    const invalid = buildVisualNpc(header, [
      { ...createVisualIfNode("empty-condition", ""), then: [node("mes", "welcome", ["Welcome"])] },
      node("close", "close"),
    ], definitions);
    expect(invalid.issues).toContainEqual({ code: "invalid-condition", nodeId: "empty-condition" });
  });

  it("accepts a flow that ends in close or end on every path, and only then", () => {
    const branching = (thenNodes: VisualBuilderNode[], elseNodes: VisualBuilderNode[] | null, after: VisualBuilderNode[] = []): VisualBuilderNode[] => [
      { ...createVisualIfNode("branch", "BaseLevel > 10"), then: thenNodes, else: elseNodes },
      ...after,
    ];
    // Chaque branche se termine : le script est complet sans rien apres le if.
    const both = buildVisualNpc(header, branching([node("mes", "a", ["yes"]), node("close", "k1")], [node("mes", "b", ["no"]), node("close", "k2")]), definitions);
    expect(both.issues).toEqual([]);
    expect(parse(both.source ?? "").diagnostics).toEqual([]);
    // Une branche qui continue sans rien apres, ou pas de else : le flux peut s'arreter sans close.
    expect(buildVisualNpc(header, branching([node("close", "k1")], null), definitions).issues).toContainEqual({ code: "missing-terminal", nodeId: "branch" });
    expect(buildVisualNpc(header, branching([node("close", "k1")], [node("mes", "b", ["no"])]), definitions).issues).toContainEqual({ code: "missing-terminal", nodeId: "branch" });
    expect(buildVisualNpc(header, branching([node("mes", "a", ["yes"])], [node("close", "k2")]), definitions).issues).toContainEqual({ code: "missing-terminal", nodeId: "branch" });
    // Un else vide ne termine rien.
    expect(buildVisualNpc(header, branching([node("close", "k1")], []), definitions).issues).toContainEqual({ code: "missing-terminal", nodeId: "branch" });
    // Des branches qui continuent puis un close : complet comme avant.
    expect(buildVisualNpc(header, branching([node("mes", "a", ["yes"])], null, [node("close", "k")]), definitions).issues).toEqual([]);
    // Un if/else qui se termine, imbrique dans une branche qui se termine par lui.
    const nested = branching([{ ...createVisualIfNode("inner", "x > 1"), then: [node("close", "k1")], else: [node("close", "k2")] }], [node("close", "k3")]);
    expect(buildVisualNpc(header, nested, definitions).issues).toEqual([]);
    expect(buildVisualNpc(header, [], definitions).issues).toContainEqual({ code: "missing-terminal" });
  });

  it("creates and removes optional arguments within the library arity", () => {
    const reward = node("getitem", "reward");
    const withOptional = addVisualCommandArgument(reward);
    expect(withOptional?.arguments.map((argument) => [argument.kind, argument.required])).toEqual([
      ["expression", true],
      ["integer", true],
      ["expression", false],
    ]);
    expect(withOptional === null ? null : addVisualCommandArgument(withOptional)).toBeNull();
    expect(withOptional === null ? null : removeVisualCommandArgument(withOptional, "reward:arg:2")?.arguments).toHaveLength(2);
    expect(removeVisualCommandArgument(reward, "reward:arg:0")).toBeNull();
  });
});
