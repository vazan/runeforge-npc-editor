import {
  FLOW_HEADER_HEIGHT,
  FLOW_NODE_WIDTH,
  FLOW_ROW_HEIGHT,
  addVisualCommandArgument,
  estimateFlowNodeHeight,
  findFlowNode,
  flowTarget,
  inputSocketPosition,
  outputPorts,
  outputSocketPosition,
  removeVisualCommandArgument,
  wireMidpoint,
  wirePath,
  type FlowCommandNode,
  type FlowGraph,
  type FlowNode,
  type FlowPort,
  type FlowPosition,
  type VisualCommandNode,
  type VisualScriptCommandDefinition,
} from "@runeforge/visual-core";
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useT } from "../../app/context";
import { Icon } from "../../components/Icon";
import type { MessageKey } from "../../i18n/messages";

/** Deplacement (px) en deca duquel un appui sur une prise reste un clic. */
export const DRAG_THRESHOLD = 4;

export const PORT_LABEL: Readonly<Record<FlowPort, MessageKey>> = {
  next: "flow.port.next",
  then: "flow.port.then",
  else: "flow.port.else",
};

const ARGUMENT_KIND_MESSAGE = {
  string: "visualBuilder.argument.string",
  integer: "visualBuilder.argument.integer",
  expression: "visualBuilder.argument.expression",
  reference: "visualBuilder.argument.reference",
  label: "visualBuilder.argument.labelKind",
} as const satisfies Record<VisualCommandNode["arguments"][number]["kind"], MessageKey>;

type Translate = ReturnType<typeof useT>;

/** Les noms affiches des noeuds : « Depart », « mes 1 », « Condition 3 » (le rang est celui du noeud dans le graphe, le depart etant le 0). */
export function flowNodeNames(graph: FlowGraph, t: Translate): Map<string, string> {
  const names = new Map<string, string>();
  graph.nodes.forEach((node, index) => {
    names.set(
      node.id,
      node.type === "start"
        ? t("flow.start")
        : node.type === "if"
          ? t("visualBuilder.conditionNode", { index })
          : t("flow.node", { name: node.commandName, index }),
    );
  });
  return names;
}

/** Un point de l'ecran dans le repere d'un canevas defilant (defilement et bordure compris). */
export function toCanvasPoint(root: HTMLElement, clientX: number, clientY: number): FlowPosition {
  const rect = root.getBoundingClientRect();
  return { x: clientX - rect.left - root.clientLeft + root.scrollLeft, y: clientY - rect.top - root.clientTop + root.scrollTop };
}

/** Une sortie « prise » en attendant qu'on choisisse l'entree (clic sur la sortie, puis clic sur l'entree). */
export interface FlowPending {
  readonly id: string;
  readonly port: FlowPort;
}

export interface FlowCanvasProps {
  readonly graph: FlowGraph;
  readonly npcName: string;
  readonly definitions: ReadonlyMap<string, VisualScriptCommandDefinition>;
  readonly selectedId: string | null;
  /** Les noeuds a signaler (un probleme de validation les concerne). */
  readonly invalidIds: ReadonlySet<string>;
  readonly pending: FlowPending | null;
  /** L'element defilant du canevas : sert a convertir un point de l'ecran en point du canevas (depot d'une commande de la bibliotheque). */
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly describedBy?: string | undefined;
  readonly onSelect: (id: string | null) => void;
  readonly onMove: (id: string, position: FlowPosition) => void;
  readonly onConnect: (from: string, port: FlowPort, to: string) => void;
  readonly onDisconnect: (from: string, port: FlowPort) => void;
  readonly onPick: (pending: FlowPending | null) => void;
  readonly onUpdate: (id: string, update: (node: FlowNode) => FlowNode) => void;
  readonly onRemove: (id: string) => void;
}

function ArgumentFields({ node, onChange }: { readonly node: VisualCommandNode; readonly onChange: (argumentId: string, value: string) => void }) {
  const t = useT();
  const baseId = useId();
  return (
    <div className="visual-builder-arguments">
      {node.arguments.map((argument, index) => {
        const id = `${baseId}-${index}`;
        return (
          <div className="field" key={argument.id}>
            <label htmlFor={id}>
              {t("visualBuilder.argument.label", { index: index + 1, kind: t(ARGUMENT_KIND_MESSAGE[argument.kind]) })}
              {argument.required ? ` (${t("visualBuilder.required")})` : ""}
            </label>
            <input id={id} type="text" value={argument.value} autoComplete="off" spellCheck={false} onChange={(event) => onChange(argument.id, event.target.value)} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Le canevas de noeuds du constructeur (RF-020) : des noeuds relies par des fils, comme dans un editeur de noeuds. Un fil se tire d'une
 * prise de sortie (a droite) vers une prise d'entree (a gauche) a la souris, ou en activant la sortie puis l'entree au clavier. Les
 * positions des prises viennent de la geometrie de `visual-core` : les noeuds ont une largeur, un titre et des lignes de hauteur fixes.
 */
export function FlowCanvas(props: FlowCanvasProps) {
  const { graph, npcName, definitions, selectedId, invalidIds, pending, rootRef, describedBy } = props;
  const { onSelect, onMove, onConnect, onDisconnect, onPick, onUpdate, onRemove } = props;
  const t = useT();
  const wireDrag = useRef<{ from: string; port: FlowPort; startX: number; startY: number; moved: boolean } | null>(null);
  const nodeDrag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const suppressClick = useRef(false);
  const [wiring, setWiring] = useState<{ from: string; port: FlowPort; x: number; y: number } | null>(null);

  const names = flowNodeNames(graph, t);
  const nameOf = (id: string): string => names.get(id) ?? id;

  const width = graph.nodes.reduce((widest, node) => Math.max(widest, node.position.x + FLOW_NODE_WIDTH), 0) + 120;
  const height = graph.nodes.reduce((lowest, node) => Math.max(lowest, node.position.y + estimateFlowNodeHeight(node)), 0) + 120;

  const canvasPoint = (clientX: number, clientY: number): FlowPosition => {
    const root = rootRef.current;
    return root === null ? { x: clientX, y: clientY } : toCanvasPoint(root, clientX, clientY);
  };

  /** Le noeud dont l'entree est sous le pointeur : la prise elle-meme, ou a defaut n'importe quel point du noeud. */
  const inputAt = (clientX: number, clientY: number): string | null => {
    const element = typeof document.elementFromPoint === "function" ? document.elementFromPoint(clientX, clientY) : null;
    if (element === null) return null;
    return element.closest("[data-flow-in]")?.getAttribute("data-flow-in") ?? element.closest("[data-flow-node]")?.getAttribute("data-flow-node") ?? null;
  };

  const releaseClickSoon = (): void => {
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const startWire = (event: PointerEvent<HTMLButtonElement>, from: string, port: FlowPort): void => {
    if (event.button !== 0) return;
    wireDrag.current = { from, port, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveWire = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = wireDrag.current;
    if (drag === null) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_THRESHOLD) drag.moved = true;
    if (drag.moved) {
      const point = canvasPoint(event.clientX, event.clientY);
      setWiring({ from: drag.from, port: drag.port, x: point.x, y: point.y });
    }
  };
  const endWire = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = wireDrag.current;
    wireDrag.current = null;
    setWiring(null);
    if (drag === null || !drag.moved) return;
    releaseClickSoon();
    const target = inputAt(event.clientX, event.clientY);
    if (target !== null) onConnect(drag.from, drag.port, target);
  };
  const cancelWire = (): void => {
    wireDrag.current = null;
    setWiring(null);
  };

  const startNodeDrag = (event: PointerEvent<HTMLElement>, node: FlowNode): void => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button") !== null)) return;
    const point = canvasPoint(event.clientX, event.clientY);
    nodeDrag.current = { id: node.id, dx: point.x - node.position.x, dy: point.y - node.position.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveNode = (event: PointerEvent<HTMLElement>): void => {
    const drag = nodeDrag.current;
    if (drag === null) return;
    const point = canvasPoint(event.clientX, event.clientY);
    onMove(drag.id, { x: point.x - drag.dx, y: point.y - drag.dy });
  };
  const endNodeDrag = (): void => {
    nodeDrag.current = null;
  };

  const rootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && (pending !== null || wiring !== null)) {
      // Annuler le fil en cours, sans fermer le dialogue.
      event.stopPropagation();
      cancelWire();
      onPick(null);
    }
  };

  const connecting = pending !== null || wiring !== null;
  const wires = graph.edges.flatMap((edge) => {
    const from = findFlowNode(graph, edge.from);
    const to = findFlowNode(graph, edge.to);
    const start = from === undefined ? undefined : outputSocketPosition(from, edge.port);
    return from === undefined || to === undefined || start === undefined ? [] : [{ edge, from, to, start, end: inputSocketPosition(to) }];
  });
  const liveFrom = wiring === null ? undefined : findFlowNode(graph, wiring.from);
  const liveStart = liveFrom === undefined || wiring === null ? undefined : outputSocketPosition(liveFrom, wiring.port);

  const geometry = {
    "--flow-node-width": `${FLOW_NODE_WIDTH}px`,
    "--flow-header-height": `${FLOW_HEADER_HEIGHT}px`,
    "--flow-row-height": `${FLOW_ROW_HEIGHT}px`,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className="flow-canvas"
      role="group"
      aria-label={t("flow.canvas")}
      aria-describedby={describedBy}
      data-connecting={connecting ? "" : undefined}
      style={geometry}
      onKeyDown={rootKeyDown}
      onPointerDown={(event) => {
        if (event.target instanceof Element && (event.target === event.currentTarget || event.target.classList.contains("flow-content"))) onSelect(null);
      }}
    >
      <div className="flow-content" style={{ width, height, minWidth: "100%", minHeight: "100%" }}>
        <svg className="flow-wires" width={width} height={height} aria-hidden="true" focusable="false">
          {wires.map(({ edge, start, end }) => (
            <path key={`${edge.from}:${edge.port}`} className="flow-wire" d={wirePath(start, end)} data-wire={`${edge.from}:${edge.port}`} />
          ))}
          {wiring !== null && liveStart !== undefined && <path className="flow-wire flow-wire-live" d={wirePath(liveStart, { x: wiring.x, y: wiring.y })} />}
        </svg>

        {graph.nodes.map((node) => {
          const name = nameOf(node.id);
          const ports = outputPorts(node);
          const rows = Math.max(1, ports.length);
          const incoming = graph.edges.filter((edge) => edge.to === node.id).length;
          const definition = node.type === "command" ? definitions.get(node.commandName.toLowerCase()) : undefined;
          const classes = ["flow-node", `flow-node-${node.type}`];
          if (selectedId === node.id) classes.push("flow-node-selected");
          if (invalidIds.has(node.id)) classes.push("flow-node-invalid");
          return (
            <article
              key={node.id}
              className={classes.join(" ")}
              style={{ left: node.position.x, top: node.position.y }}
              aria-label={name}
              data-flow-node={node.id}
              data-selected={selectedId === node.id ? "" : undefined}
              onPointerDown={() => onSelect(node.id)}
            >
              <header
                className="flow-node-header"
                onPointerDown={(event) => startNodeDrag(event, node)}
                onPointerMove={moveNode}
                onPointerUp={(event) => {
                  // La position du relachement fait foi : le navigateur peut regrouper les derniers deplacements.
                  moveNode(event);
                  endNodeDrag();
                }}
                onPointerCancel={endNodeDrag}
              >
                <span className="flow-node-title">{node.type === "start" ? t("flow.startNpc", { name: npcName.trim() === "" ? "…" : npcName }) : name}</span>
                {node.type !== "start" && (
                  <button type="button" className="icon-button flow-node-remove" aria-label={t("visualBuilder.removeNode", { name })} onClick={() => onRemove(node.id)}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </header>

              {Array.from({ length: rows }, (_, row) => {
                const port = ports[row];
                const target = port === undefined ? undefined : flowTarget(graph, node.id, port);
                const isPending = port !== undefined && pending?.id === node.id && pending.port === port;
                return (
                  <div className="flow-port-row" key={row}>
                    {row === 0 && node.type !== "start" ? (
                      <>
                        <button
                          type="button"
                          className={`flow-socket flow-socket-in${incoming > 0 ? " flow-socket-connected" : ""}`}
                          data-flow-in={node.id}
                          aria-label={incoming > 0 ? t("flow.inputWires", { node: name, count: incoming }) : t("flow.input", { node: name })}
                          onClick={() => {
                            if (pending !== null) onConnect(pending.id, pending.port, node.id);
                          }}
                        />
                        <span>{t("flow.in")}</span>
                      </>
                    ) : (
                      <span />
                    )}
                    {port !== undefined ? (
                      <>
                        <span>{t(PORT_LABEL[port])}</span>
                        <button
                          type="button"
                          className={`flow-socket flow-socket-out${target !== undefined ? " flow-socket-connected" : ""}`}
                          data-flow-out={node.id}
                          data-port={port}
                          aria-pressed={isPending}
                          aria-label={t("flow.output", {
                            port: t(PORT_LABEL[port]),
                            node: name,
                            state: isPending ? t("flow.state.picked") : target !== undefined ? t("flow.state.connected", { target: nameOf(target) }) : t("flow.state.free"),
                          })}
                          onPointerDown={(event) => startWire(event, node.id, port)}
                          onPointerMove={moveWire}
                          onPointerUp={endWire}
                          onPointerCancel={cancelWire}
                          onClick={() => {
                            if (suppressClick.current) return;
                            onPick(isPending ? null : { id: node.id, port });
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Delete" || event.key === "Backspace") {
                              event.preventDefault();
                              onDisconnect(node.id, port);
                            }
                          }}
                        />
                      </>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}

              {node.type !== "start" && (
                <div className="flow-node-body">
                  {node.type === "if" && (
                    <div className="field">
                      <label htmlFor={`${node.id}-condition`}>{t("visualBuilder.condition")}</label>
                      <input
                        id={`${node.id}-condition`}
                        type="text"
                        value={node.condition}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => onUpdate(node.id, (current) => (current.type === "if" ? { ...current, condition: event.target.value } : current))}
                      />
                    </div>
                  )}
                  {node.type === "command" && (
                    <>
                      <ArgumentFields
                        node={node}
                        onChange={(argumentId, value) =>
                          onUpdate(node.id, (current) =>
                            current.type === "command" ? { ...current, arguments: current.arguments.map((argument) => (argument.id === argumentId ? { ...argument, value } : argument)) } : current,
                          )
                        }
                      />
                      <div className="visual-actions" role="group" aria-label={t("visualBuilder.nodeActions", { name })}>
                        {(node.arity.max === null || node.arguments.length < node.arity.max) && (
                          <button
                            type="button"
                            className="button button-small"
                            onClick={() =>
                              onUpdate(node.id, (current) => {
                                const added = current.type === "command" ? addVisualCommandArgument(current) : null;
                                return added === null || current.type !== "command" ? current : ({ ...added, position: current.position } satisfies FlowCommandNode);
                              })
                            }
                          >
                            {t("visualBuilder.addArgument")}
                          </button>
                        )}
                        {node.arguments.some((argument) => !argument.required) && (
                          <button
                            type="button"
                            className="button button-small"
                            onClick={() =>
                              onUpdate(node.id, (current) => {
                                const removed = current.type === "command" ? removeVisualCommandArgument(current, current.arguments.at(-1)?.id ?? "") : null;
                                return removed === null || current.type !== "command" ? current : ({ ...removed, position: current.position } satisfies FlowCommandNode);
                              })
                            }
                          >
                            {t("visualBuilder.removeArgument")}
                          </button>
                        )}
                      </div>
                      {definition?.documentation !== null && definition?.documentation !== undefined && (
                        <details>
                          <summary>{t("visualBuilder.help")}</summary>
                          <pre className="visual-builder-help">{definition.documentation}</pre>
                        </details>
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}

        {wires.map(({ edge, from, to, start, end }) => {
          const middle = wireMidpoint(start, end);
          return (
            <button
              key={`${edge.from}:${edge.port}`}
              type="button"
              className="flow-wire-delete"
              style={{ left: middle.x - 12, top: middle.y - 12 }}
              aria-label={t("flow.disconnect", { port: t(PORT_LABEL[edge.port]), from: nameOf(from.id), to: nameOf(to.id) })}
              onClick={() => onDisconnect(edge.from, edge.port)}
            >
              ×
            </button>
          );
        })}
      </div>
    </div>
  );
}
