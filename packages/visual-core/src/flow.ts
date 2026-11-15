import { buildVisualNpc } from "./builder";
import type { VisualBuilderNode, VisualCommandNode, VisualNpcBuildResult, VisualNpcHeader, VisualScriptCommandDefinition } from "./builder";

/**
 * Graphe de flux d'un NPC pour le constructeur visuel (RF-020, RF-021) : des noeuds (une entree, une ou deux sorties) relies par des fils,
 * comme un editeur de noeuds. Le graphe est le modele d'edition ; le script est toujours genere par `buildVisualNpc` a partir de l'arbre
 * que `flowToBuilderNodes` en tire, jamais ecrit directement : un graphe qui ne se laisse pas ecrire en script structure est refuse
 * avec une raison, jamais « repare » en silence.
 *
 * Regles : une sortie porte au plus un fil ; une entree en accepte plusieurs (une jonction apres un `if`) ; aucun cycle ; `start` n'a pas
 * d'entree ; `close` et `end` n'ont pas de sortie.
 */

export type FlowPort = "next" | "then" | "else";

export interface FlowPosition {
  readonly x: number;
  readonly y: number;
}

export interface FlowStartNode {
  readonly id: "start";
  readonly type: "start";
  readonly position: FlowPosition;
}

export interface FlowIfNode {
  readonly id: string;
  readonly type: "if";
  readonly condition: string;
  readonly position: FlowPosition;
}

export interface FlowCommandNode extends VisualCommandNode {
  readonly position: FlowPosition;
}

export type FlowNode = FlowStartNode | FlowIfNode | FlowCommandNode;

/** Un fil : de la sortie `port` du noeud `from` vers l'entree du noeud `to`. Une sortie n'a qu'un fil : `(from, port)` l'identifie. */
export interface FlowEdge {
  readonly from: string;
  readonly port: FlowPort;
  readonly to: string;
}

export interface FlowGraph {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

export const FLOW_START_ID = "start";
/** Largeur d'un noeud, hauteur de son titre et d'une ligne de prises (px) : la geometrie des prises en depend, l'interface l'applique telle quelle. */
export const FLOW_NODE_WIDTH = 220;
export const FLOW_HEADER_HEIGHT = 32;
export const FLOW_ROW_HEIGHT = 28;
export const FLOW_COLUMN_GAP = 56;
export const FLOW_ROW_GAP = 24;
export const FLOW_MARGIN = 24;
/** Commandes et conditions au plus (le depart en plus) : la meme borne que le generateur de script. */
export const FLOW_MAX_NODES = 500;
export const FLOW_MAX_COORDINATE = 6000;

const TERMINAL_COMMANDS: ReadonlySet<string> = new Set(["close", "end"]);

export function isTerminalFlowNode(node: FlowNode): boolean {
  return node.type === "command" && TERMINAL_COMMANDS.has(node.commandName.toLowerCase());
}

/** Les sorties d'un noeud, dans l'ordre ou elles s'affichent. */
export function outputPorts(node: FlowNode): readonly FlowPort[] {
  switch (node.type) {
    case "start":
      return ["next"];
    case "if":
      return ["then", "else"];
    case "command":
      return isTerminalFlowNode(node) ? [] : ["next"];
  }
}

export function hasInput(node: FlowNode): boolean {
  return node.type !== "start";
}

export function createFlow(): FlowGraph {
  return { nodes: [{ id: FLOW_START_ID, type: "start", position: { x: FLOW_MARGIN, y: FLOW_MARGIN } }], edges: [] };
}

export function findFlowNode(graph: FlowGraph, id: string): FlowNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

/** Le noeud auquel la sortie `port` de `from` est reliee. */
export function flowTarget(graph: FlowGraph, from: string, port: FlowPort): string | undefined {
  return graph.edges.find((edge) => edge.from === from && edge.port === port)?.to;
}

/** Les sorties de `id` qui n'ont pas de fil. */
export function freePorts(graph: FlowGraph, id: string): readonly FlowPort[] {
  const node = findFlowNode(graph, id);
  return node === undefined ? [] : outputPorts(node).filter((port) => flowTarget(graph, id, port) === undefined);
}

/** Vrai si l'on peut aller de `from` a `to` en suivant des fils (un noeud « atteint » lui-meme). */
export function flowReaches(graph: FlowGraph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges) if (edge.from === id) pending.push(edge.to);
  }
  return false;
}

export type FlowFailure =
  | "unknown-node"
  | "unknown-port"
  /** `start` n'a pas d'entree. */
  | "no-input"
  | "self"
  /** Le fil fermerait une boucle : le script structure n'en a pas. */
  | "cycle"
  | "duplicate-id"
  | "too-many-nodes"
  /** Le noeud de depart ne se supprime ni ne se remplace. */
  | "protected-node";

export type FlowChange = { readonly ok: true; readonly graph: FlowGraph } | { readonly ok: false; readonly reason: FlowFailure };

const fail = (reason: FlowFailure): FlowChange => ({ ok: false, reason });
const done = (graph: FlowGraph): FlowChange => ({ ok: true, graph });

/** Relie la sortie `port` de `from` a l'entree de `to` ; un fil deja present sur cette sortie est remplace. */
export function connectFlow(graph: FlowGraph, from: string, port: FlowPort, to: string): FlowChange {
  const source = findFlowNode(graph, from);
  const target = findFlowNode(graph, to);
  if (source === undefined || target === undefined) return fail("unknown-node");
  if (!outputPorts(source).includes(port)) return fail("unknown-port");
  if (!hasInput(target)) return fail("no-input");
  if (from === to) return fail("self");
  if (flowReaches(graph, to, from)) return fail("cycle");
  const kept = graph.edges.filter((edge) => !(edge.from === from && edge.port === port));
  return done({ ...graph, edges: [...kept, { from, port, to }] });
}

/** Retire le fil de la sortie `port` de `from` (le meme graphe s'il n'y en a pas). */
export function disconnectFlow(graph: FlowGraph, from: string, port: FlowPort): FlowGraph {
  if (flowTarget(graph, from, port) === undefined) return graph;
  return { ...graph, edges: graph.edges.filter((edge) => !(edge.from === from && edge.port === port)) };
}

/** Supprime un noeud avec tous ses fils. */
export function removeFlowNode(graph: FlowGraph, id: string): FlowChange {
  const node = findFlowNode(graph, id);
  if (node === undefined) return fail("unknown-node");
  if (node.type === "start") return fail("protected-node");
  return done({
    nodes: graph.nodes.filter((candidate) => candidate.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  });
}

/**
 * Supprime un noeud et, pour une commande qui avait un fil `next`, relie ce qui y menait a ce qu'elle suivait : la chaine se referme au
 * lieu d'etre coupee. Une condition ou un `close` n'ont pas de suite unique : leurs entrees restent simplement sans fil.
 */
export function dissolveFlowNode(graph: FlowGraph, id: string): FlowChange {
  const node = findFlowNode(graph, id);
  if (node === undefined) return fail("unknown-node");
  const bridge = node.type === "command" ? flowTarget(graph, id, "next") : undefined;
  const incoming = graph.edges.filter((edge) => edge.to === id);
  const removed = removeFlowNode(graph, id);
  if (!removed.ok || bridge === undefined) return removed;
  let result = removed.graph;
  for (const edge of incoming) {
    const joined = connectFlow(result, edge.from, edge.port, bridge);
    if (joined.ok) result = joined.graph;
  }
  return done(result);
}

/**
 * La sortie apres laquelle un noeud ajoute d'un clic prend place : celle du noeud choisi (`preferred` si il l'a, sinon sa premiere sortie
 * libre, sinon la premiere), et a defaut de noeud choisi la fin de la chaine principale, avant son `close`.
 */
export function flowAnchor(graph: FlowGraph, selectedId: string | null, preferred?: FlowPort): { readonly id: string; readonly port: FlowPort } | null {
  const selected = selectedId === null ? undefined : findFlowNode(graph, selectedId);
  if (selected !== undefined) {
    const ports = outputPorts(selected);
    if (ports.length > 0) {
      const port = preferred !== undefined && ports.includes(preferred) ? preferred : (freePorts(graph, selected.id)[0] ?? (ports[0] as FlowPort));
      return { id: selected.id, port };
    }
  }
  let anchor: { id: string; port: FlowPort } | null = null;
  let current = findFlowNode(graph, FLOW_START_ID);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const ports = outputPorts(current);
    if (ports.length === 0) break;
    const port = freePorts(graph, current.id)[0] ?? (ports[0] as FlowPort);
    anchor = { id: current.id, port };
    const target = flowTarget(graph, current.id, port);
    if (target === undefined) break;
    current = findFlowNode(graph, target);
  }
  return anchor;
}

const clampCoordinate = (value: number): number => (Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), FLOW_MAX_COORDINATE) : 0);

/** Deplace un noeud (coordonnees entieres, bornees a la zone de travail) ; le meme graphe si rien ne change. */
export function moveFlowNode(graph: FlowGraph, id: string, position: FlowPosition): FlowGraph {
  const next: FlowPosition = { x: clampCoordinate(position.x), y: clampCoordinate(position.y) };
  const node = findFlowNode(graph, id);
  if (node === undefined || (node.position.x === next.x && node.position.y === next.y)) return graph;
  return { ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === id ? ({ ...candidate, position: next } as FlowNode) : candidate)) };
}

/** Remplace le contenu d'un noeud (un argument, une condition) sans changer son identifiant ni sa sorte ; une autre sorte est ignoree. */
export function updateFlowNode(graph: FlowGraph, id: string, update: (node: FlowNode) => FlowNode): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== id) return node;
      const changed = update(node);
      return changed.id === node.id && changed.type === node.type ? changed : node;
    }),
  };
}

/** Ajoute un noeud, sans fil. */
export function addFlowNode(graph: FlowGraph, node: FlowNode): FlowChange {
  if (node.type === "start") return fail("protected-node");
  if (findFlowNode(graph, node.id) !== undefined) return fail("duplicate-id");
  if (graph.nodes.length > FLOW_MAX_NODES) return fail("too-many-nodes");
  const position = { x: clampCoordinate(node.position.x), y: clampCoordinate(node.position.y) };
  return done({ ...graph, nodes: [...graph.nodes, { ...node, position } as FlowNode] });
}

/**
 * Ajoute `node` apres `after` : le fil de cette sortie va au nouveau noeud, et si elle etait reliee a un noeud `X`, le nouveau noeud le
 * prolonge vers `X` (par chacune de ses sorties) : on insere dans la chaine au lieu de la couper.
 */
export function insertFlowNode(graph: FlowGraph, node: FlowNode, after: { readonly id: string; readonly port: FlowPort }): FlowChange {
  const added = addFlowNode(graph, node);
  if (!added.ok) return added;
  const previous = flowTarget(graph, after.id, after.port);
  const linked = connectFlow(added.graph, after.id, after.port, node.id);
  if (!linked.ok) return linked;
  if (previous === undefined) return linked;
  let result = linked.graph;
  for (const port of outputPorts(node)) {
    const forwarded = connectFlow(result, node.id, port, previous);
    if (forwarded.ok) result = forwarded.graph;
  }
  return done(result);
}

// ------------------------------------------------------------------------------------------------------------------
// Geometrie des prises
// ------------------------------------------------------------------------------------------------------------------

/** Centre de la prise d'entree d'un noeud (sur son bord gauche, a la hauteur de la premiere ligne de prises). */
export function inputSocketPosition(node: FlowNode): FlowPosition {
  return { x: node.position.x, y: node.position.y + FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT / 2 };
}

/** Centre de la prise de sortie `port` (sur le bord droit, une ligne par sortie) ; `undefined` si le noeud n'a pas cette sortie. */
export function outputSocketPosition(node: FlowNode, port: FlowPort): FlowPosition | undefined {
  const index = outputPorts(node).indexOf(port);
  if (index < 0) return undefined;
  return { x: node.position.x + FLOW_NODE_WIDTH, y: node.position.y + FLOW_HEADER_HEIGHT + FLOW_ROW_HEIGHT * index + FLOW_ROW_HEIGHT / 2 };
}

/** Le trace d'un fil : une courbe de Bezier qui sort horizontalement de la sortie et entre horizontalement dans l'entree. */
export function wirePath(from: FlowPosition, to: FlowPosition): string {
  const reach = Math.max(48, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
}

/** Le milieu d'un fil (les deux poignees ont la hauteur de leur extremite : c'est le milieu du segment). */
export function wireMidpoint(from: FlowPosition, to: FlowPosition): FlowPosition {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

/** Hauteur approximative d'un noeud affiche, pour l'agencement automatique et la recherche d'une place libre. */
export function estimateFlowNodeHeight(node: FlowNode): number {
  const rows = Math.max(1, outputPorts(node).length) * FLOW_ROW_HEIGHT;
  switch (node.type) {
    case "start":
      return FLOW_HEADER_HEIGHT + rows + 14;
    case "if":
      return FLOW_HEADER_HEIGHT + rows + 64 + 14;
    case "command":
      // Les arguments (64 px chacun), les boutons d'arguments (34), l'aide repliee (44) et la marge basse (14).
      return FLOW_HEADER_HEIGHT + rows + node.arguments.length * 64 + 34 + 44 + 14;
  }
}

const boxesOverlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** La premiere place, a partir de `preferred` en descendant, ou un noeud de `height` px ne recouvre aucun noeud existant. */
export function freeFlowPosition(graph: FlowGraph, preferred: FlowPosition, height = 140): FlowPosition {
  let y = clampCoordinate(preferred.y);
  const x = clampCoordinate(preferred.x);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const candidate = { x, y, w: FLOW_NODE_WIDTH, h: height };
    const blocked = graph.nodes.some((node) => boxesOverlap(candidate, { x: node.position.x, y: node.position.y, w: FLOW_NODE_WIDTH, h: estimateFlowNodeHeight(node) }));
    if (!blocked) return { x, y };
    y += FLOW_ROW_GAP + 16;
    if (y > FLOW_MAX_COORDINATE) break;
  }
  return { x, y: clampCoordinate(y) };
}

/** Ou poser un noeud neuf : a droite du noeud `afterId` s'il y en a un, sinon sous tous les autres. */
export function suggestFlowPosition(graph: FlowGraph, afterId?: string): FlowPosition {
  const after = afterId === undefined ? undefined : findFlowNode(graph, afterId);
  if (after !== undefined) return freeFlowPosition(graph, { x: after.position.x + FLOW_NODE_WIDTH + FLOW_COLUMN_GAP, y: after.position.y });
  const bottom = graph.nodes.reduce((lowest, node) => Math.max(lowest, node.position.y + estimateFlowNodeHeight(node)), 0);
  return freeFlowPosition(graph, { x: FLOW_MARGIN, y: bottom + FLOW_ROW_GAP });
}

// ------------------------------------------------------------------------------------------------------------------
// Analyse et conversion en arbre de blocs
// ------------------------------------------------------------------------------------------------------------------

export type FlowIssueCode =
  | "no-start"
  /** Un fil qui ne mene nulle part, une sortie inconnue, une entree sur `start` ou une sortie qui a deux fils. */
  | "invalid-edge"
  | "cycle"
  /** Un noeud qu'aucun chemin ne relie au depart : il ne serait pas ecrit. */
  | "unreachable-node"
  /** Une sortie sans fil : le flux s'arrete la sans `close` ni `end`. */
  | "dangling-output"
  /** Un noeud atteint par deux branches qui ne se rejoignent pas : le script structure l'ecrirait deux fois. */
  | "shared-node"
  | "too-complex";

export interface FlowIssue {
  readonly code: FlowIssueCode;
  readonly nodeId?: string;
  readonly port?: FlowPort;
}

export interface FlowAnalysis {
  /** Le flux relie au depart, en arbre de blocs (vide si le graphe n'a pas de depart ou contient une boucle). */
  readonly nodes: readonly VisualBuilderNode[];
  readonly issues: readonly FlowIssue[];
}

/** Le puits virtuel de l'analyse : toute fin de flux (close, end, sortie sans fil) y mene. */
const EXIT = "\u0000exit";

function toBuilderCommand(node: FlowCommandNode): VisualCommandNode {
  return { id: node.id, type: "command", commandName: node.commandName, parameterTypes: node.parameterTypes, arity: node.arity, arguments: node.arguments };
}

/**
 * Lit le graphe comme un script structure. Le point de jonction d'un `if` est le premier noeud par lequel passent tous les chemins qui
 * en partent (son post-dominateur immediat) ; les deux branches s'ecrivent jusque-la, puis le script continue de la jonction. Pas de
 * jonction (chaque branche finit par `close`) : le `if` est le dernier de sa liste.
 */
export function analyzeFlow(graph: FlowGraph): FlowAnalysis {
  if (graph.nodes.length > FLOW_MAX_NODES + 1) return { nodes: [], issues: [{ code: "too-complex" }] };
  const issues: FlowIssue[] = [];
  const byId = new Map<string, FlowNode>();
  for (const node of graph.nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const start = byId.get(FLOW_START_ID);
  if (start === undefined || start.type !== "start") return { nodes: [], issues: [{ code: "no-start" }] };

  const targets = new Map<string, string>();
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const key = `${edge.from}:${edge.port}`;
    if (from === undefined || to === undefined || !hasInput(to) || !outputPorts(from).includes(edge.port) || targets.has(key)) {
      issues.push({ code: "invalid-edge", nodeId: edge.from, port: edge.port });
      continue;
    }
    targets.set(key, edge.to);
  }
  const target = (id: string, port: FlowPort): string | undefined => targets.get(`${id}:${port}`);

  // Parcours en profondeur depuis le depart : ordre de fin (les successeurs avant leur noeud) et detection des boucles.
  const state = new Map<string, "open" | "done">();
  const finished: string[] = [];
  let cyclic = false;
  const visit = (id: string): void => {
    state.set(id, "open");
    const node = byId.get(id) as FlowNode;
    for (const port of outputPorts(node)) {
      const next = target(id, port);
      if (next === undefined) continue;
      const status = state.get(next);
      if (status === "open") cyclic = true;
      else if (status === undefined) visit(next);
    }
    state.set(id, "done");
    finished.push(id);
  };
  visit(FLOW_START_ID);
  if (cyclic) return { nodes: [], issues: [...issues, { code: "cycle" }] };
  for (const node of graph.nodes) {
    if (node.id !== FLOW_START_ID && !state.has(node.id)) issues.push({ code: "unreachable-node", nodeId: node.id });
  }

  // Post-dominateurs : pdom(n) = {n} + intersection des pdom de ses suivants ; une sortie sans fil, ou `close`, mene au puits.
  const pdom = new Map<string, ReadonlySet<string>>([[EXIT, new Set([EXIT])]]);
  for (const id of finished) {
    const node = byId.get(id) as FlowNode;
    const successors: string[] = [];
    const ports = outputPorts(node);
    for (const port of ports) {
      const next = target(id, port);
      successors.push(next ?? EXIT);
      if (next === undefined) issues.push({ code: "dangling-output", nodeId: id, port });
    }
    if (ports.length === 0) successors.push(EXIT);
    let common: Set<string> | undefined;
    for (const successor of successors) {
      const set = pdom.get(successor) as ReadonlySet<string>;
      if (common === undefined) common = new Set<string>(set);
      else for (const member of [...common]) if (!set.has(member)) common.delete(member);
    }
    const own = common ?? new Set<string>();
    own.add(id);
    pdom.set(id, own);
  }
  const junction = (id: string): string | null => {
    let best: string | null = null;
    let bestSize = 0;
    for (const candidate of pdom.get(id) as ReadonlySet<string>) {
      if (candidate === id) continue;
      const size = (pdom.get(candidate) as ReadonlySet<string>).size;
      if (size > bestSize) {
        best = candidate;
        bestSize = size;
      }
    }
    return best === EXIT ? null : best;
  };

  const emitted = new Set<string>();
  let tooComplex = false;
  const emit = (first: string | undefined, stop: ReadonlySet<string>): VisualBuilderNode[] => {
    const list: VisualBuilderNode[] = [];
    let current = first;
    while (current !== undefined && !stop.has(current)) {
      if (emitted.has(current)) {
        issues.push({ code: "shared-node", nodeId: current });
        break;
      }
      if (emitted.size >= FLOW_MAX_NODES) {
        tooComplex = true;
        break;
      }
      emitted.add(current);
      const node = byId.get(current) as FlowNode;
      if (node.type === "command") {
        list.push(toBuilderCommand(node));
        current = target(current, "next");
      } else if (node.type === "if") {
        const join = junction(node.id);
        const inner = join === null ? stop : new Set([...stop, join]);
        const thenNodes = emit(target(node.id, "then"), inner);
        const elseNodes = emit(target(node.id, "else"), inner);
        list.push({ id: node.id, type: "if", condition: node.condition, then: thenNodes, else: elseNodes.length === 0 ? null : elseNodes });
        current = join ?? undefined;
      } else {
        break;
      }
    }
    return list;
  };
  const nodes = emit(target(FLOW_START_ID, "next"), new Set());
  if (tooComplex) issues.push({ code: "too-complex" });
  return { nodes, issues };
}

export interface FlowBuildResult extends VisualNpcBuildResult {
  /** Ce qui empeche d'ecrire le graphe en script structure (en plus des problemes du script lui-meme, dans `issues`). */
  readonly flowIssues: readonly FlowIssue[];
}

/**
 * Le script d'un NPC a partir de son graphe : le flux relie au depart devient un arbre de blocs, que `buildVisualNpc` valide et ecrit.
 * Un flux incomplet donne quand meme un apercu (la partie reliee), mais jamais un script exportable : `issues` ou `flowIssues` ne sont
 * pas vides.
 */
export function buildFlowNpc(header: VisualNpcHeader, graph: FlowGraph, definitions: readonly VisualScriptCommandDefinition[]): FlowBuildResult {
  const analysis = analyzeFlow(graph);
  const built = buildVisualNpc(header, analysis.nodes, definitions);
  // Un graphe qui a deja un probleme (sortie sans fil, boucle, noeud partage...) ne dit pas en plus que le script ne finit pas par
  // close ou end : ce serait la consequence de la partie qui manque, et le dire deux fois noie la cause.
  const explained = analysis.issues.length > 0;
  const issues = explained ? built.issues.filter((issue) => issue.code !== "missing-terminal") : built.issues;
  return { source: built.source, issues, flowIssues: analysis.issues };
}

// ------------------------------------------------------------------------------------------------------------------
// Agencement automatique et graphe a partir d'un arbre
// ------------------------------------------------------------------------------------------------------------------

/**
 * Range les noeuds en colonnes selon leur distance au depart (le plus long chemin), de haut en bas dans l'ordre d'un parcours qui suit
 * la branche « then » avant la branche « else » ; les noeuds non relies vont dans une derniere colonne.
 */
export function layoutFlow(graph: FlowGraph): FlowGraph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const depth = new Map<string, number>([[FLOW_START_ID, 0]]);
  const order: string[] = [];
  const outgoing = (id: string): string[] => {
    const node = byId.get(id);
    if (node === undefined) return [];
    return outputPorts(node).flatMap((port) => {
      const to = flowTarget(graph, id, port);
      return to === undefined || !byId.has(to) ? [] : [to];
    });
  };
  // Longueur du plus long chemin, par relaxation bornee (le graphe est un DAG ; la borne protege d'une entree qui ne le serait pas).
  const pending: string[] = [FLOW_START_ID];
  let budget = graph.nodes.length * graph.nodes.length + 16;
  while (pending.length > 0 && budget > 0) {
    budget -= 1;
    const id = pending.shift() as string;
    for (const to of outgoing(id)) {
      const candidate = (depth.get(id) ?? 0) + 1;
      if (candidate > (depth.get(to) ?? -1) && candidate <= graph.nodes.length) {
        depth.set(to, candidate);
        pending.push(to);
      }
    }
  }
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const to of outgoing(id)) walk(to);
  };
  walk(FLOW_START_ID);
  const deepest = Math.max(0, ...depth.values());
  for (const node of graph.nodes) {
    if (!seen.has(node.id)) {
      order.push(node.id);
      depth.set(node.id, deepest + 1);
    }
  }
  const nextY = new Map<number, number>();
  const placed = new Map<string, FlowPosition>();
  for (const id of order) {
    const node = byId.get(id) as FlowNode;
    const column = depth.get(id) ?? 0;
    const y = nextY.get(column) ?? FLOW_MARGIN;
    placed.set(id, { x: FLOW_MARGIN + column * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP), y });
    nextY.set(column, y + estimateFlowNodeHeight(node) + FLOW_ROW_GAP);
  }
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: placed.get(node.id) ?? node.position }) as FlowNode) };
}

/**
 * Le graphe qui represente un arbre de blocs : les noeuds se suivent par leur sortie, et chaque branche qui ne finit pas par `close`
 * rejoint le noeud qui suit le `if`. Les noeuds d'un `if` qui finissent tous par `close` laissent ce qui suit sans fil (inateignable).
 */
export function flowFromNodes(nodes: readonly VisualBuilderNode[]): FlowGraph {
  const created: FlowNode[] = [{ id: FLOW_START_ID, type: "start", position: { x: FLOW_MARGIN, y: FLOW_MARGIN } }];
  const edges: FlowEdge[] = [];
  const known = new Set<string>([FLOW_START_ID]);
  const origin = { x: FLOW_MARGIN, y: FLOW_MARGIN };
  const place = (list: readonly VisualBuilderNode[], pending: readonly { readonly id: string; readonly port: FlowPort }[]): readonly { readonly id: string; readonly port: FlowPort }[] => {
    let tails = pending;
    for (const node of list) {
      if (known.has(node.id)) continue;
      known.add(node.id);
      for (const tail of tails) edges.push({ from: tail.id, port: tail.port, to: node.id });
      if (node.type === "command") {
        created.push({ ...node, position: origin });
        tails = TERMINAL_COMMANDS.has(node.commandName.toLowerCase()) ? [] : [{ id: node.id, port: "next" }];
      } else {
        created.push({ id: node.id, type: "if", condition: node.condition, position: origin });
        const thenTails = place(node.then, [{ id: node.id, port: "then" }]);
        const elseTails = place(node.else ?? [], [{ id: node.id, port: "else" }]);
        tails = [...thenTails, ...elseTails];
      }
    }
    return tails;
  };
  place(nodes, [{ id: FLOW_START_ID, port: "next" }]);
  return layoutFlow({ nodes: created, edges });
}
