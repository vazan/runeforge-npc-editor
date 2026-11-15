import { parse } from "@runeforge/runescript-parser";
import { describe, expect, it } from "vitest";
import {
  FLOW_COLUMN_GAP,
  FLOW_HEADER_HEIGHT,
  FLOW_MARGIN,
  FLOW_MAX_NODES,
  FLOW_NODE_WIDTH,
  FLOW_ROW_HEIGHT,
  FLOW_START_ID,
  addFlowNode,
  analyzeFlow,
  buildFlowNpc,
  buildVisualNpc,
  connectFlow,
  createFlow,
  createVisualCommandNode,
  disconnectFlow,
  dissolveFlowNode,
  estimateFlowNodeHeight,
  flowAnchor,
  findFlowNode,
  flowFromNodes,
  flowReaches,
  flowTarget,
  freeFlowPosition,
  freePorts,
  inputSocketPosition,
  insertFlowNode,
  layoutFlow,
  moveFlowNode,
  outputPorts,
  outputSocketPosition,
  removeFlowNode,
  suggestFlowPosition,
  updateFlowNode,
  wireMidpoint,
  wirePath,
  type FlowCommandNode,
  type FlowEdge,
  type FlowGraph,
  type FlowIfNode,
  type FlowNode,
  type FlowPort,
  type VisualBuilderNode,
  type VisualScriptCommandDefinition,
} from "./index";

const definitions: readonly VisualScriptCommandDefinition[] = [
  { name: "mes", arity: { min: 1, max: null }, parameterTypes: "s*", signatures: ["mes <text>"], documentation: "Display text.", deprecated: false },
  { name: "next", arity: { min: 0, max: 0 }, parameterTypes: "", signatures: ["next;"], documentation: "Wait.", deprecated: false },
  { name: "close", arity: { min: 0, max: 0 }, parameterTypes: "", signatures: ["close;"], documentation: "End the dialogue.", deprecated: false },
  { name: "end", arity: { min: 0, max: 0 }, parameterTypes: "", signatures: ["end;"], documentation: "End the script.", deprecated: false },
  { name: "getitem", arity: { min: 2, max: 3 }, parameterTypes: "vi?", signatures: ["getitem <item>,<amount>"], documentation: "Give an item.", deprecated: false },
];

const header = { map: "prontera", x: "150", y: "150", direction: "4", name: "Flow NPC", sprite: "100" };
const ORIGIN = { x: 0, y: 0 };

function command(name: string, id: string, values: readonly string[] = [], position = ORIGIN): FlowCommandNode {
  const definition = definitions.find((item) => item.name === name);
  if (definition === undefined) throw new Error(`definition absente : ${name}`);
  const created = createVisualCommandNode(definition, id);
  if (created === null) throw new Error(`definition inutilisable : ${name}`);
  return { ...created, arguments: created.arguments.map((argument, index) => ({ ...argument, value: values[index] ?? "x" })), position };
}

const mes = (id: string, text = "hello"): FlowCommandNode => command("mes", id, [text]);
const close = (id: string): FlowCommandNode => command("close", id);
const condition = (id: string, text = "BaseLevel > 10"): FlowIfNode => ({ id, type: "if", condition: text, position: ORIGIN });

/** Un graphe a partir de noeuds et de fils `de.port->vers`. */
function graphOf(nodes: readonly FlowNode[], ...wires: readonly string[]): FlowGraph {
  let graph: FlowGraph = createFlow();
  for (const node of nodes) {
    const added = addFlowNode(graph, node);
    if (!added.ok) throw new Error(`noeud refuse : ${added.reason}`);
    graph = added.graph;
  }
  for (const wire of wires) {
    const match = /^([^.]+)\.(next|then|else)->(.+)$/.exec(wire);
    if (match === null) throw new Error(`fil mal ecrit : ${wire}`);
    const connected = connectFlow(graph, match[1] as string, match[2] as FlowPort, match[3] as string);
    if (!connected.ok) throw new Error(`fil refuse (${wire}) : ${connected.reason}`);
    graph = connected.graph;
  }
  return graph;
}

/** Le noeud d'un arbre de blocs : une commande sans sa position. */
function plain(node: FlowCommandNode): VisualBuilderNode {
  const { position: _position, ...rest } = node;
  void _position;
  return rest;
}

const source = (graph: FlowGraph): string | null => buildFlowNpc(header, graph, definitions).source;
const body = (graph: FlowGraph): string => (source(graph) ?? "").split("\n").slice(1, -2).join("\n");
const codes = (graph: FlowGraph): string[] => analyzeFlow(graph).issues.map((issue) => `${issue.code}${issue.nodeId === undefined ? "" : `:${issue.nodeId}`}${issue.port === undefined ? "" : `.${issue.port}`}`);

describe("graphe de flux : noeuds et fils", () => {
  it("part d'un noeud de depart sans entree et avec une seule sortie", () => {
    const graph = createFlow();
    expect(graph.nodes).toEqual([{ id: "start", type: "start", position: { x: FLOW_MARGIN, y: FLOW_MARGIN } }]);
    expect(graph.edges).toEqual([]);
    expect(outputPorts(graph.nodes[0] as FlowNode)).toEqual(["next"]);
    expect(outputPorts(condition("c"))).toEqual(["then", "else"]);
    expect(outputPorts(mes("m"))).toEqual(["next"]);
    expect(outputPorts(close("k"))).toEqual([]);
    expect(outputPorts(command("end", "e"))).toEqual([]);
    expect(outputPorts({ ...close("k2"), commandName: "CLOSE" })).toEqual([]);
  });

  it("relie une sortie a une entree, remplace le fil d'une sortie et accepte plusieurs fils vers une meme entree", () => {
    let graph = graphOf([mes("a"), mes("b"), close("k")], "start.next->a", "a.next->b");
    expect(flowTarget(graph, "start", "next")).toBe("a");
    const replaced = connectFlow(graph, "a", "next", "k");
    expect(replaced.ok && flowTarget(replaced.graph, "a", "next")).toBe("k");
    expect(replaced.ok && replaced.graph.edges).toHaveLength(2);
    // Une jonction : deux sorties vers la meme entree.
    graph = graphOf([condition("c"), mes("a"), close("k")], "start.next->c", "c.then->a", "c.else->k", "a.next->k");
    expect(graph.edges.filter((edge) => edge.to === "k")).toHaveLength(2);
  });

  it("refuse un fil inconnu, vers le depart, sur soi-meme, depuis une sortie qui n'existe pas ou qui fermerait une boucle", () => {
    const graph = graphOf([mes("a"), mes("b"), close("k")], "start.next->a", "a.next->b");
    expect(connectFlow(graph, "zz", "next", "a")).toEqual({ ok: false, reason: "unknown-node" });
    expect(connectFlow(graph, "a", "next", "zz")).toEqual({ ok: false, reason: "unknown-node" });
    expect(connectFlow(graph, "a", "then", "b")).toEqual({ ok: false, reason: "unknown-port" });
    expect(connectFlow(graph, "k", "next", "a")).toEqual({ ok: false, reason: "unknown-port" });
    expect(connectFlow(graph, "a", "next", "start")).toEqual({ ok: false, reason: "no-input" });
    expect(connectFlow(graph, "a", "next", "a")).toEqual({ ok: false, reason: "self" });
    expect(connectFlow(graph, "b", "next", "a")).toEqual({ ok: false, reason: "cycle" });
    expect(connectFlow(graph, "b", "next", "start")).toEqual({ ok: false, reason: "no-input" });
  });

  it("retire un fil, et laisse le graphe tel quel s'il n'y en a pas", () => {
    const graph = graphOf([mes("a")], "start.next->a");
    const cut = disconnectFlow(graph, "start", "next");
    expect(cut.edges).toEqual([]);
    expect(disconnectFlow(cut, "start", "next")).toBe(cut);
    expect(disconnectFlow(graph, "a", "next")).toBe(graph);
  });

  it("supprime un noeud avec ses fils, sauf le depart", () => {
    const graph = graphOf([mes("a"), mes("b"), close("k")], "start.next->a", "a.next->b", "b.next->k");
    const removed = removeFlowNode(graph, "b");
    expect(removed.ok && removed.graph.nodes.map((node) => node.id)).toEqual(["start", "a", "k"]);
    expect(removed.ok && removed.graph.edges).toEqual([{ from: "start", port: "next", to: "a" }]);
    expect(removeFlowNode(graph, "start")).toEqual({ ok: false, reason: "protected-node" });
    expect(removeFlowNode(graph, "zz")).toEqual({ ok: false, reason: "unknown-node" });
  });

  it("n'ajoute ni doublon, ni second depart, ni plus de noeuds que le script n'en admet", () => {
    const graph = graphOf([mes("a")]);
    expect(addFlowNode(graph, mes("a"))).toEqual({ ok: false, reason: "duplicate-id" });
    expect(addFlowNode(graph, { id: "start", type: "start", position: ORIGIN })).toEqual({ ok: false, reason: "protected-node" });
    let full = createFlow();
    for (let index = 0; index < FLOW_MAX_NODES; index += 1) {
      const added = addFlowNode(full, mes(`n${index}`));
      if (!added.ok) throw new Error(`refus a ${index}`);
      full = added.graph;
    }
    expect(addFlowNode(full, mes("de-trop"))).toEqual({ ok: false, reason: "too-many-nodes" });
  });

  it("deplace un noeud en coordonnees entieres bornees, et ne change rien quand il ne bouge pas", () => {
    const graph = graphOf([mes("a")]);
    const moved = moveFlowNode(graph, "a", { x: 10.6, y: -5 });
    expect(findFlowNode(moved, "a")?.position).toEqual({ x: 11, y: 0 });
    expect(findFlowNode(moveFlowNode(moved, "a", { x: 1e9, y: Number.NaN }), "a")?.position).toEqual({ x: 6000, y: 0 });
    expect(moveFlowNode(moved, "a", { x: 11, y: 0 })).toBe(moved);
    expect(moveFlowNode(moved, "zz", { x: 1, y: 1 })).toBe(moved);
    expect(findFlowNode(moveFlowNode(graph, "start", { x: 100, y: 50 }), "start")?.position).toEqual({ x: 100, y: 50 });
  });

  it("modifie le contenu d'un noeud sans en changer l'identifiant ni la sorte", () => {
    const graph = graphOf([mes("a"), condition("c")]);
    const changed = updateFlowNode(graph, "c", (node) => (node.type === "if" ? { ...node, condition: "Zeny > 1" } : node));
    expect((findFlowNode(changed, "c") as FlowIfNode).condition).toBe("Zeny > 1");
    expect(updateFlowNode(graph, "c", (node) => ({ ...node, id: "autre" }) as FlowNode)).toEqual(graph);
    expect(updateFlowNode(graph, "c", () => mes("c"))).toEqual(graph);
    expect(updateFlowNode(graph, "zz", (node) => node)).toEqual(graph);
  });

  it("atteint un noeud en suivant les fils", () => {
    const graph = graphOf([mes("a"), mes("b"), mes("lone")], "start.next->a", "a.next->b");
    expect(flowReaches(graph, "start", "b")).toBe(true);
    expect(flowReaches(graph, "b", "a")).toBe(false);
    expect(flowReaches(graph, "a", "a")).toBe(true);
    expect(flowReaches(graph, "start", "lone")).toBe(false);
  });

  it("liste les sorties sans fil", () => {
    const graph = graphOf([condition("c"), mes("a")], "start.next->c", "c.then->a");
    expect(freePorts(graph, "c")).toEqual(["else"]);
    expect(freePorts(graph, "a")).toEqual(["next"]);
    expect(freePorts(graph, "start")).toEqual([]);
    expect(freePorts(graph, "zz")).toEqual([]);
  });
});

describe("graphe de flux : inserer dans la chaine", () => {
  it("met le noeud neuf entre la sortie et son ancienne cible", () => {
    const graph = graphOf([mes("a"), close("k")], "start.next->a", "a.next->k");
    const inserted = insertFlowNode(graph, mes("b"), { id: "a", port: "next" });
    expect(inserted.ok && inserted.graph.edges).toEqual(
      expect.arrayContaining([
        { from: "start", port: "next", to: "a" },
        { from: "a", port: "next", to: "b" },
        { from: "b", port: "next", to: "k" },
      ]),
    );
    expect(inserted.ok && inserted.graph.edges).toHaveLength(3);
  });

  it("insere apres la sortie demandee d'une condition, pas apres sa premiere", () => {
    const graph = graphOf([condition("c"), mes("a"), close("k")], "start.next->c", "c.then->a", "a.next->k", "c.else->k");
    const inElse = insertFlowNode(graph, mes("b"), { id: "c", port: "else" });
    expect(inElse.ok && inElse.graph.edges).toEqual(
      expect.arrayContaining([
        { from: "c", port: "then", to: "a" },
        { from: "c", port: "else", to: "b" },
        { from: "b", port: "next", to: "k" },
      ]),
    );
    const inThen = insertFlowNode(graph, mes("b"), { id: "c", port: "then" });
    expect(inThen.ok && inThen.graph.edges).toEqual(
      expect.arrayContaining([
        { from: "c", port: "then", to: "b" },
        { from: "b", port: "next", to: "a" },
        { from: "c", port: "else", to: "k" },
      ]),
    );
  });

  it("ajoute simplement a la suite quand la sortie etait libre", () => {
    const graph = graphOf([mes("a")], "start.next->a");
    const inserted = insertFlowNode(graph, close("k"), { id: "a", port: "next" });
    expect(inserted.ok && inserted.graph.edges).toEqual([
      { from: "start", port: "next", to: "a" },
      { from: "a", port: "next", to: "k" },
    ]);
  });

  it("relie les deux sorties d'une condition inseree a l'ancienne cible : des branches vides qui se rejoignent", () => {
    const graph = graphOf([mes("a"), close("k")], "start.next->a", "a.next->k");
    const inserted = insertFlowNode(graph, condition("c"), { id: "a", port: "next" });
    expect(inserted.ok && inserted.graph.edges).toEqual(
      expect.arrayContaining([
        { from: "a", port: "next", to: "c" },
        { from: "c", port: "then", to: "k" },
        { from: "c", port: "else", to: "k" },
      ]),
    );
  });

  it("refuse sans rien changer une sortie qui n'existe pas ou un identifiant deja pris", () => {
    const graph = graphOf([mes("a"), close("k")], "start.next->a", "a.next->k");
    expect(insertFlowNode(graph, mes("b"), { id: "k", port: "next" })).toEqual({ ok: false, reason: "unknown-port" });
    expect(insertFlowNode(graph, mes("a"), { id: "start", port: "next" })).toEqual({ ok: false, reason: "duplicate-id" });
    expect(insertFlowNode(graph, mes("b"), { id: "zz", port: "next" })).toEqual({ ok: false, reason: "unknown-node" });
  });
});

describe("graphe de flux : dissoudre un noeud et choisir ou ajouter", () => {
  it("referme la chaine : ce qui menait au noeud mene a ce qu'il suivait", () => {
    const graph = graphOf([mes("a"), mes("b"), mes("c"), close("k")], "start.next->a", "a.next->b", "b.next->c", "c.next->k");
    const dissolved = dissolveFlowNode(graph, "b");
    expect(dissolved.ok && dissolved.graph.nodes.map((node) => node.id)).toEqual(["start", "a", "c", "k"]);
    expect(dissolved.ok && dissolved.graph.edges).toEqual(
      expect.arrayContaining([
        { from: "start", port: "next", to: "a" },
        { from: "a", port: "next", to: "c" },
        { from: "c", port: "next", to: "k" },
      ]),
    );
    expect(dissolved.ok && dissolved.graph.edges).toHaveLength(3);
    expect(dissolved.ok && analyzeFlow(dissolved.graph).issues).toEqual([]);
  });

  it("referme chaque entree d'un noeud dans lequel plusieurs branches se rejoignaient", () => {
    const graph = graphOf(
      [condition("c"), mes("yes"), mes("join"), close("k")],
      "start.next->c", "c.then->yes", "yes.next->join", "c.else->join", "join.next->k",
    );
    const dissolved = dissolveFlowNode(graph, "join");
    expect(dissolved.ok && dissolved.graph.edges).toEqual(
      expect.arrayContaining([
        { from: "yes", port: "next", to: "k" },
        { from: "c", port: "else", to: "k" },
      ]),
    );
    expect(dissolved.ok && analyzeFlow(dissolved.graph).issues).toEqual([]);
  });

  it("laisse sans fil ce qui menait a un close ou a une condition supprimes", () => {
    const graph = graphOf([mes("a"), close("k"), condition("c"), mes("x")], "start.next->a", "a.next->k", "c.then->x");
    const noClose = dissolveFlowNode(graph, "k");
    expect(noClose.ok && noClose.graph.edges.some((edge) => edge.from === "a")).toBe(false);
    const noCondition = dissolveFlowNode(graphOf([mes("a"), condition("c"), mes("x")], "start.next->a", "a.next->c", "c.then->x"), "c");
    expect(noCondition.ok && noCondition.graph.edges).toEqual([{ from: "start", port: "next", to: "a" }]);
    expect(dissolveFlowNode(graph, "start")).toEqual({ ok: false, reason: "protected-node" });
    expect(dissolveFlowNode(graph, "zz")).toEqual({ ok: false, reason: "unknown-node" });
  });

  it("ajoute apres le noeud choisi : la sortie demandee, sinon la premiere libre, sinon la premiere", () => {
    const graph = graphOf([condition("c"), mes("a"), close("k")], "start.next->c", "c.then->a", "a.next->k");
    expect(flowAnchor(graph, "c")).toEqual({ id: "c", port: "else" });
    expect(flowAnchor(graph, "c", "then")).toEqual({ id: "c", port: "then" });
    expect(flowAnchor(graph, "c", "next")).toEqual({ id: "c", port: "else" });
    expect(flowAnchor(graph, "a")).toEqual({ id: "a", port: "next" });
    const full = graphOf([condition("c"), close("k")], "start.next->c", "c.then->k", "c.else->k");
    expect(flowAnchor(full, "c")).toEqual({ id: "c", port: "then" });
  });

  it("sans noeud choisi, ajoute a la fin de la chaine principale, avant son close", () => {
    const graph = graphOf([mes("a"), mes("b"), close("k")], "start.next->a", "a.next->b", "b.next->k");
    expect(flowAnchor(graph, null)).toEqual({ id: "b", port: "next" });
    expect(flowAnchor(graph, "k")).toEqual({ id: "b", port: "next" });
    expect(flowAnchor(graph, "zz")).toEqual({ id: "b", port: "next" });
    expect(flowAnchor(createFlow(), null)).toEqual({ id: "start", port: "next" });
    // Une chaine qui s'arrete sans close : apres son dernier noeud.
    expect(flowAnchor(graphOf([mes("a")], "start.next->a"), null)).toEqual({ id: "a", port: "next" });
    // A travers une condition : par sa branche « then ».
    const branching = graphOf([condition("c"), mes("a"), close("k")], "start.next->c", "c.then->a", "c.else->k", "a.next->k");
    expect(flowAnchor(branching, null)).toEqual({ id: "a", port: "next" });
  });
});

describe("graphe de flux : lecture en script structure", () => {
  it("ecrit une chaine de commandes dans l'ordre des fils, pas dans l'ordre des noeuds", () => {
    const graph = graphOf([close("k"), mes("b", "second"), mes("a", "premier")], "start.next->a", "a.next->b", "b.next->k");
    expect(body(graph)).toBe(['\tmes "premier";', '\tmes "second";', "\tclose;"].join("\n"));
    expect(analyzeFlow(graph).issues).toEqual([]);
    expect(buildFlowNpc(header, graph, definitions)).toMatchObject({ issues: [], flowIssues: [] });
    expect(parse(source(graph) ?? "").diagnostics).toEqual([]);
  });

  it("ecrit un if/else dont les branches se rejoignent, puis la suite", () => {
    const graph = graphOf(
      [mes("hi", "salut"), condition("c"), mes("yes", "oui"), mes("no", "non"), mes("bye", "au revoir"), close("k")],
      "start.next->hi", "hi.next->c", "c.then->yes", "c.else->no", "yes.next->bye", "no.next->bye", "bye.next->k",
    );
    expect(body(graph)).toBe(
      [
        '\tmes "salut";',
        "\tif (BaseLevel > 10) {",
        '\t\tmes "oui";',
        "\t} else {",
        '\t\tmes "non";',
        "\t}",
        '\tmes "au revoir";',
        "\tclose;",
      ].join("\n"),
    );
    expect(buildFlowNpc(header, graph, definitions).issues).toEqual([]);
  });

  it("n'ecrit pas de else quand cette branche va directement a la jonction", () => {
    const graph = graphOf([condition("c"), mes("yes", "oui"), close("k")], "start.next->c", "c.then->yes", "c.else->k", "yes.next->k");
    expect(body(graph)).toBe(["\tif (BaseLevel > 10) {", '\t\tmes "oui";', "\t}", "\tclose;"].join("\n"));
  });

  it("ecrit des branches vides qui se rejoignent comme un if sans corps", () => {
    const graph = graphOf([condition("c"), close("k")], "start.next->c", "c.then->k", "c.else->k");
    expect(body(graph)).toBe(["\tif (BaseLevel > 10) {", "\t}", "\tclose;"].join("\n"));
  });

  it("ecrit un if dont chaque branche finit par close, sans suite : le script est complet", () => {
    const graph = graphOf(
      [condition("c"), mes("yes", "oui"), close("k1"), mes("no", "non"), command("end", "k2")],
      "start.next->c", "c.then->yes", "yes.next->k1", "c.else->no", "no.next->k2",
    );
    expect(body(graph)).toBe(
      ["\tif (BaseLevel > 10) {", '\t\tmes "oui";', "\t\tclose;", "\t} else {", '\t\tmes "non";', "\t\tend;", "\t}"].join("\n"),
    );
    expect(buildFlowNpc(header, graph, definitions)).toMatchObject({ issues: [], flowIssues: [] });
    expect(parse(source(graph) ?? "").diagnostics).toEqual([]);
  });

  it("ecrit une sortie anticipee : une branche finit par close, l'autre continue", () => {
    const graph = graphOf(
      [condition("c"), close("early"), mes("more", "suite"), close("k")],
      "start.next->c", "c.then->early", "c.else->more", "more.next->k",
    );
    expect(body(graph)).toBe(["\tif (BaseLevel > 10) {", "\t\tclose;", "\t} else {", '\t\tmes "suite";', "\t\tclose;", "\t}"].join("\n"));
    expect(buildFlowNpc(header, graph, definitions).issues).toEqual([]);
  });

  it("emboite les conditions et rejoint chacune a son propre point", () => {
    const graph = graphOf(
      [condition("a", "x > 1"), condition("b", "y > 1"), mes("m1", "un"), mes("m2", "deux"), mes("m3", "trois"), mes("after", "fin"), close("k")],
      "start.next->a", "a.then->b", "a.else->m3", "b.then->m1", "b.else->m2", "m1.next->after", "m2.next->after", "m3.next->after", "after.next->k",
    );
    expect(body(graph)).toBe(
      [
        "\tif (x > 1) {",
        "\t\tif (y > 1) {",
        '\t\t\tmes "un";',
        "\t\t} else {",
        '\t\t\tmes "deux";',
        "\t\t}",
        "\t} else {",
        '\t\tmes "trois";',
        "\t}",
        '\tmes "fin";',
        "\tclose;",
      ].join("\n"),
    );
    expect(buildFlowNpc(header, graph, definitions).issues).toEqual([]);
  });

  it("rejoint une condition interne avant la jonction de l'externe", () => {
    const graph = graphOf(
      [condition("a", "x > 1"), condition("b", "y > 1"), mes("m1", "un"), mes("mid", "milieu"), mes("tail", "queue"), close("k")],
      "start.next->a", "a.then->b", "b.then->m1", "b.else->mid", "m1.next->mid", "mid.next->tail", "a.else->tail", "tail.next->k",
    );
    expect(body(graph)).toBe(
      [
        "\tif (x > 1) {",
        "\t\tif (y > 1) {",
        '\t\t\tmes "un";',
        "\t\t}",
        '\t\tmes "milieu";',
        "\t}",
        '\tmes "queue";',
        "\tclose;",
      ].join("\n"),
    );
  });

  it("signale une sortie sans fil : le flux ne finit pas par close ou end, sans doublon avec le script", () => {
    const graph = graphOf([mes("a")], "start.next->a");
    expect(codes(graph)).toEqual(["dangling-output:a.next"]);
    const built = buildFlowNpc(header, graph, definitions);
    expect(built.flowIssues).toEqual([{ code: "dangling-output", nodeId: "a", port: "next" }]);
    expect(built.issues).toEqual([]);
    expect(built.source).not.toBeNull();
    expect(codes(createFlow())).toEqual(["dangling-output:start.next"]);
  });

  it("signale la branche d'une condition qui n'est pas reliee", () => {
    const graph = graphOf([condition("c"), close("k")], "start.next->c", "c.then->k");
    expect(codes(graph)).toEqual(["dangling-output:c.else"]);
    // Le flux s'arrete dans la branche « else » : aucune jonction, le close n'est ecrit que dans « then ».
    expect(analyzeFlow(graph).nodes).toEqual([{ id: "c", type: "if", condition: "BaseLevel > 10", then: [plain(close("k"))], else: null }]);
  });

  it("signale un noeud qu'aucun chemin ne relie au depart, et ne l'ecrit pas", () => {
    const graph = graphOf([mes("a"), mes("orphan", "perdu"), close("k")], "start.next->a", "a.next->k");
    expect(codes(graph)).toEqual(["unreachable-node:orphan"]);
    expect(body(graph)).not.toContain("perdu");
    expect(buildFlowNpc(header, graph, definitions).source).not.toBeNull();
  });

  it("refuse deux branches qui partagent un noeud sans se rejoindre : il serait ecrit deux fois", () => {
    // then -> m -> (cond d : then -> n -> k1, else -> k2) ; else -> n : n est atteint par deux branches, mais pas par tous les chemins.
    const graph = graphOf(
      [condition("c"), mes("m"), condition("d"), mes("n", "partage"), close("k1"), close("k2")],
      "start.next->c", "c.then->m", "m.next->d", "d.then->n", "d.else->k2", "n.next->k1", "c.else->n",
    );
    expect(codes(graph)).toContain("shared-node:n");
    // Le script produit n'est jamais exportable.
    expect(buildFlowNpc(header, graph, definitions).flowIssues.some((issue) => issue.code === "shared-node")).toBe(true);
  });

  it("refuse une boucle, sans rien ecrire", () => {
    // Le script ne dit pas en plus qu'il ne finit pas par close : la boucle est la cause, et la seule a dire.
    const graph: FlowGraph = {
      nodes: [...createFlow().nodes, mes("a"), mes("b")],
      edges: [
        { from: "start", port: "next", to: "a" },
        { from: "a", port: "next", to: "b" },
        { from: "b", port: "next", to: "a" },
      ],
    };
    expect(analyzeFlow(graph)).toEqual({ nodes: [], issues: [{ code: "cycle" }] });
    expect(buildFlowNpc(header, graph, definitions)).toMatchObject({ flowIssues: [{ code: "cycle" }], issues: [] });
  });

  it("lit un graphe de la taille maximale, jusqu'a sa derniere commande", () => {
    let graph = createFlow();
    let previous = "start";
    for (let index = 0; index < FLOW_MAX_NODES; index += 1) {
      const id = `n${index}`;
      const added = addFlowNode(graph, index === FLOW_MAX_NODES - 1 ? close(id) : mes(id));
      if (!added.ok) throw new Error(`refus a ${index}`);
      const linked = connectFlow(added.graph, previous, "next", id);
      if (!linked.ok) throw new Error(`fil refuse a ${index}`);
      graph = linked.graph;
      previous = id;
    }
    const analysis = analyzeFlow(graph);
    expect(analysis.issues).toEqual([]);
    expect(analysis.nodes).toHaveLength(FLOW_MAX_NODES);
    expect(analysis.nodes.at(-1)?.id).toBe(`n${FLOW_MAX_NODES - 1}`);
  });

  it("refuse un graphe sans depart, trop gros, ou dont les fils sont invalides", () => {
    expect(analyzeFlow({ nodes: [mes("a")], edges: [] })).toEqual({ nodes: [], issues: [{ code: "no-start" }] });
    const big: FlowGraph = { nodes: [...createFlow().nodes, ...Array.from({ length: FLOW_MAX_NODES + 1 }, (_, index) => mes(`n${index}`))], edges: [] };
    expect(analyzeFlow(big)).toEqual({ nodes: [], issues: [{ code: "too-complex" }] });
    const bad: FlowGraph = {
      nodes: [...createFlow().nodes, mes("a"), close("k")],
      edges: [
        { from: "start", port: "next", to: "a" },
        { from: "start", port: "next", to: "k" },
        { from: "a", port: "then", to: "k" },
        { from: "a", port: "next", to: "start" },
        { from: "a", port: "next", to: "ghost" },
        { from: "ghost", port: "next", to: "k" },
        { from: "k", port: "next", to: "a" },
      ],
    };
    expect(analyzeFlow(bad).issues.filter((issue) => issue.code === "invalid-edge")).toHaveLength(6);
  });

  it("ecrit une echelle de conditions qui se rejoignent chacune sur la suivante : une fois chacune", () => {
    // Chaque condition a deux branches vers la meme suivante : une chaine de jonctions.
    const nodes: FlowNode[] = [];
    const wires: string[] = ["start.next->c0"];
    const rungs = 40;
    for (let index = 0; index < rungs; index += 1) {
      nodes.push(condition(`c${index}`, `x${index} > 0`));
      wires.push(`c${index}.then->c${index + 1}`, `c${index}.else->c${index + 1}`);
    }
    nodes.push(close(`c${rungs}`));
    const graph = graphOf(nodes, ...wires);
    const analysis = analyzeFlow(graph);
    expect(analysis.issues).toEqual([]);
    expect(buildFlowNpc(header, graph, definitions).issues).toEqual([]);
  });
});

describe("graphe de flux : tree <-> graphe", () => {
  const tree = (): VisualBuilderNode[] => [
    plain(mes("m1", "bonjour")),
    { id: "c1", type: "if", condition: "BaseLevel > 10", then: [plain(mes("m2", "oui"))], else: [plain(mes("m3", "non"))] },
    plain(mes("m4", "suite")),
    plain(close("k")),
  ];

  it("represente un arbre, puis le relit a l'identique", () => {
    const graph = flowFromNodes(tree());
    expect(graph.nodes.map((node) => node.id)).toEqual(["start", "m1", "c1", "m2", "m3", "m4", "k"]);
    expect(analyzeFlow(graph)).toEqual({ nodes: tree(), issues: [] });
    expect(buildFlowNpc(header, graph, definitions).source).toBe(buildVisualNpc(header, tree(), definitions).source);
  });

  it("relit un else vide comme l'absence de else", () => {
    const withEmptyElse: VisualBuilderNode[] = [{ id: "c", type: "if", condition: "a > 1", then: [plain(mes("m", "x"))], else: [] }, plain(close("k"))];
    const expected: VisualBuilderNode[] = [{ id: "c", type: "if", condition: "a > 1", then: [plain(mes("m", "x"))], else: null }, plain(close("k"))];
    expect(analyzeFlow(flowFromNodes(withEmptyElse)).nodes).toEqual(expected);
  });

  it("relie les fins de branche a ce qui suit le if, et pas celle qui finit par close", () => {
    const early: VisualBuilderNode[] = [
      { id: "c", type: "if", condition: "a > 1", then: [plain(close("k1"))], else: [plain(mes("m", "x"))] },
      plain(close("k2")),
    ];
    const graph = flowFromNodes(early);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "c", port: "then", to: "k1" },
        { from: "c", port: "else", to: "m" },
        { from: "m", port: "next", to: "k2" },
      ]),
    );
    expect(graph.edges.some((edge) => edge.from === "k1")).toBe(false);
    // Les deux ecritures sont equivalentes : la suite du if est ecrite dans la branche qui continue, puisque l'autre ne la rejoint jamais.
    expect(analyzeFlow(graph).nodes).toEqual([{ id: "c", type: "if", condition: "a > 1", then: [plain(close("k1"))], else: [plain(mes("m", "x")), plain(close("k2"))] }]);
  });

  it("agence les noeuds en colonnes sans recouvrement", () => {
    const graph = flowFromNodes(tree());
    const columns = new Map<number, FlowNode[]>();
    for (const node of graph.nodes) columns.set(node.position.x, [...(columns.get(node.position.x) ?? []), node]);
    // Une colonne par distance au depart : m1 (1), c1 (2), m2 et m3 (3), m4 (4), k (5).
    expect([...columns.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5].map((column) => FLOW_MARGIN + column * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP)));
    const branches = columns.get(FLOW_MARGIN + 3 * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP)) ?? [];
    expect(branches.map((node) => node.id)).toEqual(["m2", "m3"]);
    for (const nodes of columns.values()) {
      const sorted = [...nodes].sort((a, b) => a.position.y - b.position.y);
      sorted.slice(1).forEach((node, index) => {
        const above = sorted[index] as FlowNode;
        expect(node.position.y).toBeGreaterThanOrEqual(above.position.y + estimateFlowNodeHeight(above));
      });
    }
    expect(findFlowNode(graph, "start")?.position).toEqual({ x: FLOW_MARGIN, y: FLOW_MARGIN });
    expect(layoutFlow(graph)).toEqual(graph);
  });

  it("met une jonction apres la plus longue de ses branches, pas apres la plus courte", () => {
    // then : c -> x -> y -> join ; else : c -> join. La jonction est a quatre colonnes du depart, pas a deux.
    const graph = layoutFlow(
      graphOf([condition("c"), mes("x"), mes("y"), mes("join"), close("k")], "start.next->c", "c.then->x", "x.next->y", "y.next->join", "c.else->join", "join.next->k"),
    );
    const column = (id: string): number => ((findFlowNode(graph, id) as FlowNode).position.x - FLOW_MARGIN) / (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP);
    expect(["start", "c", "x", "y", "join", "k"].map(column)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("met les noeuds non relies dans une derniere colonne", () => {
    const graph = layoutFlow(graphOf([mes("a"), mes("orphan")], "start.next->a"));
    expect(findFlowNode(graph, "a")?.position.x).toBe(FLOW_MARGIN + (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP));
    expect(findFlowNode(graph, "orphan")?.position.x).toBe(FLOW_MARGIN + 2 * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP));
  });
});

describe("graphe de flux : geometrie", () => {
  it("place les prises sur les bords, a la hauteur de leur ligne", () => {
    const node = condition("c");
    const placed = { ...node, position: { x: 100, y: 40 } } as FlowNode;
    expect(inputSocketPosition(placed)).toEqual({ x: 100, y: 40 + FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT / 2 });
    expect(outputSocketPosition(placed, "then")).toEqual({ x: 100 + FLOW_NODE_WIDTH, y: 40 + FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT / 2 });
    expect(outputSocketPosition(placed, "else")).toEqual({ x: 100 + FLOW_NODE_WIDTH, y: 40 + FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT * 1.5 });
    expect(outputSocketPosition(placed, "next")).toBeUndefined();
    expect(outputSocketPosition({ ...close("k"), position: { x: 0, y: 0 } }, "next")).toBeUndefined();
  });

  it("trace un fil qui sort et entre horizontalement, et en donne le milieu", () => {
    expect(wirePath({ x: 0, y: 0 }, { x: 200, y: 100 })).toBe("M 0 0 C 100 0, 100 100, 200 100");
    // Une entree a gauche de la sortie : la courbe garde au moins 48 px de poignee.
    expect(wirePath({ x: 300, y: 0 }, { x: 290, y: 100 })).toBe("M 300 0 C 348 0, 242 100, 290 100");
    expect(wireMidpoint({ x: 0, y: 0 }, { x: 200, y: 100 })).toEqual({ x: 100, y: 50 });
  });

  it("estime la hauteur d'un noeud d'apres ses lignes de prises et ses champs", () => {
    expect(estimateFlowNodeHeight(createFlow().nodes[0] as FlowNode)).toBe(FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT + 14);
    expect(estimateFlowNodeHeight(condition("c"))).toBe(FLOW_HEADER_HEIGHT + 2 * FLOW_ROW_HEIGHT + 64 + 14);
    expect(estimateFlowNodeHeight(mes("m"))).toBe(FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT + 64 + 34 + 44 + 14);
    expect(estimateFlowNodeHeight(command("getitem", "g"))).toBe(FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT + 2 * 64 + 34 + 44 + 14);
    expect(estimateFlowNodeHeight(close("k"))).toBe(FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT + 34 + 44 + 14);
  });

  it("cherche une place libre sous les noeuds existants et a droite d'un noeud donne", () => {
    const graph = graphOf([mes("a")]);
    const a = moveFlowNode(graph, "a", { x: 300, y: 24 });
    const free = freeFlowPosition(a, { x: 300, y: 24 });
    expect(free.x).toBe(300);
    expect(free.y).toBeGreaterThanOrEqual(24 + estimateFlowNodeHeight(findFlowNode(a, "a") as FlowNode) - 1);
    expect(freeFlowPosition(a, { x: 900, y: 24 })).toEqual({ x: 900, y: 24 });
    const right = suggestFlowPosition(a, "a");
    expect(right.x).toBe(300 + FLOW_NODE_WIDTH + FLOW_COLUMN_GAP);
    const below = suggestFlowPosition(a);
    expect(below.x).toBe(FLOW_MARGIN);
    expect(below.y).toBeGreaterThanOrEqual(24 + estimateFlowNodeHeight(findFlowNode(a, "a") as FlowNode));
    expect(suggestFlowPosition(a, "zz")).toEqual(below);
  });
});

/** Un generateur pseudo-aleatoire (mulberry32) : les proprietes rejouent les memes cas a chaque execution. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("graphe de flux : proprietes", () => {
  /**
   * Un arbre de blocs valide, tire au hasard. `flow` : le flux continue apres la liste (aucun close, aucun if qui se termine) ;
   * `end` : la liste se termine, par un close ou par un if dont les deux branches se terminent. Un if n'a jamais une branche qui se
   * termine et l'autre qui continue : cette sortie anticipee s'ecrit autrement (elle a son propre test).
   */
  function randomTree(rand: () => number, depth: number, counter: { n: number }, mode: "flow" | "end"): VisualBuilderNode[] {
    const list: VisualBuilderNode[] = [];
    const next = (): string => {
      counter.n += 1;
      return `n${counter.n}`;
    };
    const items = 1 + Math.floor(rand() * 3);
    for (let index = 0; index < items; index += 1) {
      const id = next();
      if (depth > 0 && rand() < 0.35) {
        const thenList = randomTree(rand, depth - 1, counter, "flow");
        const elseList = rand() < 0.5 ? randomTree(rand, depth - 1, counter, "flow") : [];
        list.push({ id, type: "if", condition: `v${counter.n} > ${Math.floor(rand() * 9)}`, then: thenList, else: elseList });
      } else {
        list.push(plain(mes(id, `texte ${counter.n}`)));
      }
    }
    if (mode === "end") {
      const id = next();
      if (depth > 0 && rand() < 0.4) {
        const thenList = randomTree(rand, depth - 1, counter, "end");
        const elseList = randomTree(rand, depth - 1, counter, "end");
        list.push({ id, type: "if", condition: `w${counter.n} > ${Math.floor(rand() * 9)}`, then: thenList, else: elseList });
      } else {
        list.push(plain(close(id)));
      }
    }
    return list;
  }

  const withoutEmptyElse = (nodes: readonly VisualBuilderNode[]): VisualBuilderNode[] =>
    nodes.map((node) =>
      node.type === "if" ? { ...node, then: withoutEmptyElse(node.then), else: node.else === null || node.else.length === 0 ? null : withoutEmptyElse(node.else) } : node,
    );

  it("relit comme l'arbre d'origine, et ecrit le meme script, pour des centaines d'arbres valides", () => {
    const rand = random(20261109);
    let checked = 0;
    for (let round = 0; round < 400; round += 1) {
      const counter = { n: 0 };
      const original = randomTree(rand, 3, counter, "end");
      const expected = withoutEmptyElse(original);
      const built = buildVisualNpc(header, original, definitions);
      if (built.issues.length > 0) continue; // un arbre ou un close n'est pas en derniere place : sans objet pour cette propriete
      const graph = flowFromNodes(original);
      const analysis = analyzeFlow(graph);
      expect(analysis.issues, `arbre ${round}`).toEqual([]);
      expect(analysis.nodes, `arbre ${round}`).toEqual(expected);
      const result = buildFlowNpc(header, graph, definitions);
      expect(result.source, `arbre ${round}`).toBe(buildVisualNpc(header, expected, definitions).source);
      expect(result.issues, `arbre ${round}`).toEqual([]);
      expect(parse(result.source ?? "").diagnostics, `arbre ${round}`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("garde les invariants apres n'importe quelle suite d'operations : fils valides, une sortie un fil, jamais de boucle, jamais d'exception", () => {
    const rand = random(7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
    let operations = 0;
    for (let round = 0; round < 60; round += 1) {
      let graph = createFlow();
      let counter = 0;
      for (let step = 0; step < 60; step += 1) {
        const dice = rand();
        const ids = graph.nodes.map((node) => node.id);
        if (dice < 0.3) {
          counter += 1;
          const node = rand() < 0.25 ? condition(`c${counter}`) : rand() < 0.2 ? close(`k${counter}`) : mes(`m${counter}`);
          const added = addFlowNode(graph, node);
          if (added.ok) graph = added.graph;
        } else if (dice < 0.7) {
          const from = findFlowNode(graph, pick(ids)) as FlowNode;
          const ports = outputPorts(from);
          if (ports.length > 0) {
            const changed = connectFlow(graph, from.id, pick(ports), pick(ids));
            if (changed.ok) graph = changed.graph;
          }
        } else if (dice < 0.8) {
          graph = disconnectFlow(graph, pick(ids), pick(["next", "then", "else"] as const));
        } else if (dice < 0.9) {
          const removed = removeFlowNode(graph, pick(ids));
          if (removed.ok) graph = removed.graph;
        } else {
          graph = moveFlowNode(graph, pick(ids), { x: rand() * 3000, y: rand() * 3000 });
        }
        operations += 1;

        const byId = new Map(graph.nodes.map((node) => [node.id, node]));
        expect(byId.size).toBe(graph.nodes.length);
        const outputs = new Set<string>();
        for (const edge of graph.edges as readonly FlowEdge[]) {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          expect(from, `fil ${edge.from}.${edge.port}`).toBeDefined();
          expect(to).toBeDefined();
          expect(outputPorts(from as FlowNode)).toContain(edge.port);
          expect(to?.type).not.toBe("start");
          expect(edge.from).not.toBe(edge.to);
          const key = `${edge.from}:${edge.port}`;
          expect(outputs.has(key)).toBe(false);
          outputs.add(key);
          // Pas de boucle : on ne revient jamais a la source en suivant les fils.
          const others = { ...graph, edges: graph.edges.filter((candidate) => candidate !== edge) };
          expect(flowReaches(others, edge.to, edge.from)).toBe(false);
        }
        const analysis = analyzeFlow(graph);
        expect(analysis.issues.some((issue) => issue.code === "cycle" || issue.code === "invalid-edge" || issue.code === "no-start")).toBe(false);
        // Tout ce qui est ecrit est atteint depuis le depart, une seule fois.
        const written: string[] = [];
        const walk = (nodes: readonly VisualBuilderNode[]): void => {
          for (const node of nodes) {
            written.push(node.id);
            if (node.type === "if") {
              walk(node.then);
              walk(node.else ?? []);
            }
          }
        };
        walk(analysis.nodes);
        expect(new Set(written).size).toBe(written.length);
        for (const id of written) expect(flowReaches(graph, FLOW_START_ID, id)).toBe(true);
      }
    }
    expect(operations).toBe(3600);
  });
});
