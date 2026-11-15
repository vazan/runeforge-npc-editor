import type { SourceRange } from "@runeforge/runescript-core";
import type { ConversionStatus, VisualBlock, VisualNpc } from "./ir";

export interface VisualSourceMapping {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly range: SourceRange;
}

interface VisualNodeBase {
  readonly id: string;
  readonly sourceMapping: VisualSourceMapping;
}

export type VisualGraphNode =
  | (VisualNodeBase & { readonly type: "start" | "end" })
  | (VisualNodeBase & { readonly type: "mes"; readonly text: string })
  | (VisualNodeBase & { readonly type: "next" | "close" })
  | (VisualNodeBase & { readonly type: "if"; readonly condition: string })
  | (VisualNodeBase & { readonly type: "raw"; readonly code: string });

export interface VisualGraphEdge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly sourcePort: "next" | "then" | "else" | "terminal" | "sequence";
  readonly targetNodeId: string;
  readonly targetPort: "in";
  readonly kind: "control" | "source-order";
}

export interface VisualGraph {
  readonly schemaVersion: 1;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly profileId: string;
  readonly conversionStatus: ConversionStatus;
  readonly counts: { readonly convertible: number; readonly raw: number };
  readonly nodes: readonly VisualGraphNode[];
  readonly edges: readonly VisualGraphEdge[];
}

export interface VisualGraphIssue {
  readonly code:
    | "VG0001"
    | "VG0002"
    | "VG0003"
    | "VG0004"
    | "VG0005"
    | "VG0006"
    | "VG0007"
    | "VG0008"
    | "VG0009"
    | "VG0010";
  readonly id?: string;
}

export type VisualGraphParseResult =
  | { readonly ok: true; readonly graph: VisualGraph }
  | { readonly ok: false; readonly issues: readonly VisualGraphIssue[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length <= maximum;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isRange(value: unknown): value is SourceRange {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.start) && isNonNegativeInteger(value.end) && value.end >= value.start;
}

function parseSourceMapping(value: unknown): VisualSourceMapping | null {
  if (!isRecord(value) || !isText(value.documentUri, 4096) || value.documentUri.length === 0 ||
      !isNonNegativeInteger(value.documentVersion) || !isRange(value.range)) return null;
  return {
    documentUri: value.documentUri,
    documentVersion: value.documentVersion,
    range: { start: value.range.start, end: value.range.end },
  };
}

function parseNode(value: unknown): VisualGraphNode | null {
  if (!isRecord(value) || !isText(value.id, 256) || value.id.length === 0) return null;
  const sourceMapping = parseSourceMapping(value.sourceMapping);
  if (sourceMapping === null) return null;
  switch (value.type) {
    case "start":
    case "end":
    case "next":
    case "close":
      return { id: value.id, type: value.type, sourceMapping };
    case "mes":
      return isText(value.text, 24_000) ? { id: value.id, type: "mes", text: value.text, sourceMapping } : null;
    case "if":
      return isText(value.condition, 24_000) ? { id: value.id, type: "if", condition: value.condition, sourceMapping } : null;
    case "raw":
      return isText(value.code, 512 * 1024) ? { id: value.id, type: "raw", code: value.code, sourceMapping } : null;
    default:
      return null;
  }
}

function parseEdge(value: unknown): VisualGraphEdge | null {
  if (!isRecord(value) || !isText(value.id, 1024) || value.id.length === 0 ||
      !isText(value.sourceNodeId, 256) || !isText(value.targetNodeId, 256) || value.targetPort !== "in") return null;
  if (value.sourcePort !== "next" && value.sourcePort !== "then" && value.sourcePort !== "else" &&
      value.sourcePort !== "terminal" && value.sourcePort !== "sequence") return null;
  if (value.kind !== "control" && value.kind !== "source-order") return null;
  return {
    id: value.id,
    sourceNodeId: value.sourceNodeId,
    sourcePort: value.sourcePort,
    targetNodeId: value.targetNodeId,
    targetPort: "in",
    kind: value.kind,
  };
}

function expectedPorts(node: VisualGraphNode): readonly VisualGraphEdge["sourcePort"][] {
  switch (node.type) {
    case "start":
    case "mes":
    case "next":
      return ["next"];
    case "if":
      return ["then", "else"];
    case "close":
      return ["terminal"];
    case "raw":
      return ["sequence"];
    case "end":
      return [];
  }
}

function validateGraph(
  graph: VisualGraph,
): readonly VisualGraphIssue[] {
  const issues: VisualGraphIssue[] = [];
  const nodes = new Map<string, VisualGraphNode>();
  const edges = new Map<string, VisualGraphEdge>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) issues.push({ code: "VG0002", id: node.id });
    else nodes.set(node.id, node);
    if (node.sourceMapping.documentUri !== graph.documentUri ||
        node.sourceMapping.documentVersion !== graph.documentVersion) {
      issues.push({ code: "VG0003", id: node.id });
    }
  }

  if ([...nodes.values()].filter((node) => node.type === "start").length !== 1 ||
      [...nodes.values()].filter((node) => node.type === "end").length !== 1) {
    issues.push({ code: "VG0004" });
  }

  const connectedPorts = new Set<string>();
  for (const edge of graph.edges) {
    if (edges.has(edge.id)) issues.push({ code: "VG0005", id: edge.id });
    else edges.set(edge.id, edge);
    const source = nodes.get(edge.sourceNodeId);
    const target = nodes.get(edge.targetNodeId);
    if (source === undefined || target === undefined || target.type === "start" || source.type === "end") {
      issues.push({ code: "VG0006", id: edge.id });
      continue;
    }
    if (!expectedPorts(source).includes(edge.sourcePort) ||
        (source.type === "raw") !== (edge.kind === "source-order")) {
      issues.push({ code: "VG0007", id: edge.id });
    }
    const key = `${source.id}:${edge.sourcePort}`;
    if (connectedPorts.has(key)) issues.push({ code: "VG0008", id: edge.id });
    connectedPorts.add(key);
  }

  for (const node of nodes.values()) {
    for (const port of expectedPorts(node)) {
      if (!connectedPorts.has(`${node.id}:${port}`)) issues.push({ code: "VG0009", id: node.id });
    }
  }
  const rawCount = [...nodes.values()].filter((node) => node.type === "raw").length;
  const convertibleCount = [...nodes.values()].filter((node) =>
    node.type === "mes" || node.type === "next" || node.type === "close" || node.type === "if").length;
  const status: ConversionStatus = convertibleCount === 0 && rawCount > 0
    ? "unsupported"
    : rawCount > 0
      ? "partial"
      : "full";
  if (graph.counts.raw !== rawCount || graph.counts.convertible !== convertibleCount || graph.conversionStatus !== status) {
    issues.push({ code: "VG0010" });
  }
  return issues;
}

/** Valide une representation serialisee avant qu'elle soit consommee par l'editeur. */
export function parseVisualGraph(value: unknown): VisualGraphParseResult {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      !isText(value.documentUri, 4096) || value.documentUri.length === 0 ||
      !isNonNegativeInteger(value.documentVersion) ||
      !isText(value.profileId, 128) || value.profileId.length === 0 ||
      (value.conversionStatus !== "full" && value.conversionStatus !== "partial" && value.conversionStatus !== "unsupported") ||
      !isRecord(value.counts) || !isNonNegativeInteger(value.counts.convertible) || !isNonNegativeInteger(value.counts.raw) ||
      !Array.isArray(value.nodes) || value.nodes.length > 20_000 ||
      !Array.isArray(value.edges) || value.edges.length > 40_000) {
    return { ok: false, issues: [{ code: "VG0001" }] };
  }

  const nodes: VisualGraphNode[] = [];
  for (const node of value.nodes) {
    const parsed = parseNode(node);
    if (parsed === null) return { ok: false, issues: [{ code: "VG0001" }] };
    nodes.push(parsed);
  }
  const edges: VisualGraphEdge[] = [];
  for (const edge of value.edges) {
    const parsed = parseEdge(edge);
    if (parsed === null) return { ok: false, issues: [{ code: "VG0001" }] };
    edges.push(parsed);
  }
  const graph: VisualGraph = {
    schemaVersion: 1,
    documentUri: value.documentUri,
    documentVersion: value.documentVersion,
    profileId: value.profileId,
    conversionStatus: value.conversionStatus,
    counts: { convertible: value.counts.convertible, raw: value.counts.raw },
    nodes,
    edges,
  };
  const issues = validateGraph(graph);
  return issues.length === 0 ? { ok: true, graph } : { ok: false, issues };
}

function nodeFor(block: VisualBlock, documentUri: string, documentVersion: number): VisualGraphNode {
  const id = `block:${block.id}`;
  const sourceMapping: VisualSourceMapping = { documentUri, documentVersion, range: block.range };
  switch (block.kind) {
    case "mes":
      return { id, type: "mes", text: block.text, sourceMapping };
    case "next":
      return { id, type: "next", sourceMapping };
    case "close":
      return { id, type: "close", sourceMapping };
    case "if":
      return { id, type: "if", condition: block.condition, sourceMapping };
    case "raw":
      return { id, type: "raw", code: block.text, sourceMapping };
  }
}

function nodeIds(blocks: readonly VisualBlock[]): readonly string[] {
  return blocks.map((block) => `block:${block.id}`);
}

/** Construit un graphe deterministe sans regenerer ni modifier le texte source. */
export function createVisualGraph(
  npc: VisualNpc,
  documentUri: string,
  documentVersion: number,
  profileId: string,
): VisualGraph {
  if (documentUri.length === 0 || documentUri.length > 4096 ||
      !Number.isSafeInteger(documentVersion) || documentVersion < 0 ||
      profileId.length === 0 || profileId.length > 128) {
    throw new RangeError("Invalid visual graph source metadata");
  }

  const source = (range: SourceRange): VisualSourceMapping => ({ documentUri, documentVersion, range });
  const nodes: VisualGraphNode[] = [
    { id: "start", type: "start", sourceMapping: source({ start: npc.declarationStart, end: npc.bodyRange.start }) },
  ];
  const addBlocks = (blocks: readonly VisualBlock[]): void => {
    for (const block of blocks) {
      nodes.push(nodeFor(block, documentUri, documentVersion));
      if (block.kind === "if") {
        addBlocks(block.then);
        if (block.else !== null) addBlocks(block.else);
      }
    }
  };
  addBlocks(npc.blocks);
  nodes.push({
    id: "end",
    type: "end",
    sourceMapping: source({ start: Math.max(npc.bodyRange.start, npc.bodyRange.end - 1), end: npc.bodyRange.end }),
  });

  const edges: VisualGraphEdge[] = [];
  const addEdge = (
    sourceNodeId: string,
    sourcePort: VisualGraphEdge["sourcePort"],
    targetNodeId: string,
    kind: VisualGraphEdge["kind"] = "control",
  ): void => {
    edges.push({
      id: `${sourceNodeId}:${sourcePort}:${targetNodeId}`,
      sourceNodeId,
      sourcePort,
      targetNodeId,
      targetPort: "in",
      kind,
    });
  };
  const connectList = (blocks: readonly VisualBlock[], continuation: string): void => {
    blocks.forEach((block, index) => {
      const successor = blocks[index + 1] === undefined ? continuation : `block:${blocks[index + 1]?.id ?? ""}`;
      const id = `block:${block.id}`;
      if (block.kind === "if") {
        const thenFirst = nodeIds(block.then)[0] ?? successor;
        const elseFirst = block.else === null ? successor : nodeIds(block.else)[0] ?? successor;
        addEdge(id, "then", thenFirst);
        addEdge(id, "else", elseFirst);
        connectList(block.then, successor);
        if (block.else !== null) connectList(block.else, successor);
      } else if (block.kind === "close") {
        addEdge(id, "terminal", "end");
      } else if (block.kind === "raw") {
        addEdge(id, "sequence", successor, "source-order");
      } else {
        addEdge(id, "next", successor);
      }
    });
  };
  const first = nodeIds(npc.blocks)[0] ?? "end";
  addEdge("start", "next", first);
  connectList(npc.blocks, "end");

  const parsed = parseVisualGraph({
    schemaVersion: 1,
    documentUri,
    documentVersion,
    profileId,
    conversionStatus: npc.status,
    counts: npc.counts,
    nodes,
    edges,
  });
  if (!parsed.ok) throw new Error(`Generated invalid visual graph: ${parsed.issues.map((issue) => issue.code).join(", ")}`);
  return parsed.graph;
}
