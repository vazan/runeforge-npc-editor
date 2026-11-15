import { parse } from "@runeforge/runescript-parser";
import { describe, expect, it } from "vitest";
import { createVisualGraph, importNpc, parseVisualGraph, scriptNpcs } from "./index";

const GUIDE = [
  'prontera,150,150,4\tscript\tGuide\t100,{',
  '\tmes "Welcome";',
  "\tif (BaseLevel > 50) {",
  '\t\tmes "Strong";',
  "\t} else {",
  '\t\tcallfunc "F_Train";',
  "\t}",
  "\tclose;",
  "}",
].join("\n");

function graphFor(text: string = GUIDE) {
  const npcDeclaration = scriptNpcs(parse(text))[0];
  if (npcDeclaration === undefined) throw new Error("NPC declaration expected");
  const npc = importNpc(text, npcDeclaration);
  if (npc === null) throw new Error("Closed NPC body expected");
  return createVisualGraph(npc, "file:///guide.txt", 7, "rathena");
}

describe("graphe visuel versionne", () => {
  it("builds stable nodes, source mappings, and explicit branch and raw-code edges", () => {
    const graph = graphFor();
    expect(graph.schemaVersion).toBe(1);
    expect(graph.documentVersion).toBe(7);
    expect(graph.nodes.map((node) => [node.id, node.type])).toEqual([
      ["start", "start"],
      ["block:0", "mes"],
      ["block:1", "if"],
      ["block:1.t.0", "mes"],
      ["block:1.e.0", "raw"],
      ["block:2", "close"],
      ["end", "end"],
    ]);
    expect(graph.nodes.every((node) => node.sourceMapping.documentUri === "file:///guide.txt" &&
      node.sourceMapping.documentVersion === 7)).toBe(true);
    expect(graph.edges.map(({ sourceNodeId, sourcePort, targetNodeId, kind }) =>
      [sourceNodeId, sourcePort, targetNodeId, kind])).toEqual([
      ["start", "next", "block:0", "control"],
      ["block:0", "next", "block:1", "control"],
      ["block:1", "then", "block:1.t.0", "control"],
      ["block:1", "else", "block:1.e.0", "control"],
      ["block:1.t.0", "next", "block:2", "control"],
      ["block:1.e.0", "sequence", "block:2", "source-order"],
      ["block:2", "terminal", "end", "control"],
    ]);
    expect(graphFor()).toEqual(graph);
    expect(parseVisualGraph(graph)).toEqual({ ok: true, graph });
  });

  it("connects an empty NPC directly to its end node", () => {
    const graph = graphFor('-\tscript\tEmpty\t-1,{\n}');
    expect(graph.nodes.map((node) => node.type)).toEqual(["start", "end"]);
    expect(graph.edges).toMatchObject([
      { sourceNodeId: "start", sourcePort: "next", targetNodeId: "end", kind: "control" },
    ]);
  });

  it("rejects malformed, dangling, and disconnected graphs", () => {
    const graph = graphFor();
    expect(parseVisualGraph({ ...graph, schemaVersion: 2 })).toEqual({
      ok: false,
      issues: [{ code: "VG0001" }],
    });

    const dangling = {
      ...graph,
      edges: graph.edges.map((edge, index) => index === 0 ? { ...edge, targetNodeId: "missing" } : edge),
    };
    const danglingResult = parseVisualGraph(dangling);
    expect(danglingResult.ok).toBe(false);
    if (!danglingResult.ok) expect(danglingResult.issues).toContainEqual({ code: "VG0006", id: graph.edges[0]?.id });

    const disconnected = { ...graph, edges: graph.edges.filter((edge) => edge.sourceNodeId !== "start") };
    const disconnectedResult = parseVisualGraph(disconnected);
    expect(disconnectedResult.ok).toBe(false);
    if (!disconnectedResult.ok) expect(disconnectedResult.issues).toContainEqual({ code: "VG0009", id: "start" });
  });
});
