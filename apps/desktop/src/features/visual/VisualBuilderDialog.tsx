import { RATHENA_SCRIPT_LIBRARY } from "@runeforge/emulator-rathena";
import {
  FLOW_HEADER_HEIGHT,
  FLOW_NODE_WIDTH,
  addFlowNode,
  buildFlowNpc,
  connectFlow,
  createVisualCommandNode,
  disconnectFlow,
  dissolveFlowNode,
  findFlowNode,
  flowAnchor,
  flowFromNodes,
  insertFlowNode,
  layoutFlow,
  moveFlowNode,
  outputPorts,
  parseVisualExtensionManifest,
  suggestFlowPosition,
  updateFlowNode,
  type FlowChange,
  type FlowFailure,
  type FlowGraph,
  type FlowIssueCode,
  type FlowNode,
  type FlowPort,
  type FlowPosition,
  type VisualBuilderIssueCode,
  type VisualBuilderNode,
  type VisualNpcHeader,
  type VisualScriptCommandDefinition,
} from "@runeforge/visual-core";
import { describeDiagnostic } from "@runeforge/runescript-core";
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { Modal } from "../../components/Modal";
import type { MessageKey } from "../../i18n/messages";
import { DRAG_THRESHOLD, FlowCanvas, PORT_LABEL, flowNodeNames, toCanvasPoint, type FlowPending } from "./FlowCanvas";

const DEFINITIONS: readonly VisualScriptCommandDefinition[] = RATHENA_SCRIPT_LIBRARY;
const DEFINITION_BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name.toLowerCase(), definition]));
const BUILT_IN_NAMES = new Set(DEFINITION_BY_NAME.keys());

const ISSUE_MESSAGE: Readonly<Record<VisualBuilderIssueCode, MessageKey>> = {
  "invalid-map": "visualBuilder.error.map",
  "invalid-coordinate": "visualBuilder.error.coordinate",
  "invalid-direction": "visualBuilder.error.direction",
  "invalid-name": "visualBuilder.error.name",
  "invalid-sprite": "visualBuilder.error.sprite",
  "unknown-command": "visualBuilder.error.unknownCommand",
  "unsupported-signature": "visualBuilder.error.signature",
  "argument-count": "visualBuilder.error.arguments",
  "required-argument": "visualBuilder.error.requiredArgument",
  "invalid-argument": "visualBuilder.error.invalidArgument",
  "invalid-condition": "visualBuilder.error.invalidCondition",
  "missing-terminal": "visualBuilder.error.terminal",
  "terminal-not-last": "visualBuilder.error.terminalLast",
  "invalid-script": "visualBuilder.error.script",
};

const FLOW_ISSUE_MESSAGE: Readonly<Record<FlowIssueCode, MessageKey>> = {
  "no-start": "flow.issue.no-start",
  "invalid-edge": "flow.issue.invalid-edge",
  cycle: "flow.issue.cycle",
  "unreachable-node": "flow.issue.unreachable-node",
  "dangling-output": "flow.issue.dangling-output",
  "shared-node": "flow.issue.shared-node",
  "too-complex": "flow.issue.too-complex",
};

const REJECTION_MESSAGE: Readonly<Record<FlowFailure, MessageKey>> = {
  "unknown-node": "flow.status.rejected.other",
  "unknown-port": "flow.status.rejected.other",
  "no-input": "flow.status.rejected.no-input",
  self: "flow.status.rejected.self",
  cycle: "flow.status.rejected.cycle",
  "duplicate-id": "flow.status.rejected.other",
  "too-many-nodes": "flow.issue.too-complex",
  "protected-node": "flow.status.rejected.other",
};

const INITIAL_HEADER: VisualNpcHeader = {
  map: "prontera",
  x: "150",
  y: "150",
  direction: "4",
  name: "New NPC",
  sprite: "100",
};

function initialNodes(): VisualBuilderNode[] {
  const messageDefinition = DEFINITION_BY_NAME.get("mes");
  const closeDefinition = DEFINITION_BY_NAME.get("close");
  if (messageDefinition === undefined || closeDefinition === undefined) throw new Error("rAthena dialogue commands are missing from the built-in library");
  const message = createVisualCommandNode(messageDefinition, "command-1");
  const close = createVisualCommandNode(closeDefinition, "command-2");
  if (message === null || close === null) throw new Error("rAthena dialogue command signatures are unavailable");
  return [
    { ...message, arguments: message.arguments.map((argument) => ({ ...argument, value: "Welcome to my NPC!" })) },
    close,
  ];
}

interface CheckedSource {
  readonly source: string;
  readonly diagnostics: Awaited<ReturnType<ReturnType<typeof useController>["previewWizardDiagnostics"]>>;
}

/** Un glisser depuis la bibliotheque : tant qu'il n'a pas depasse le seuil, c'est un simple clic (ajouter apres le noeud choisi). */
interface PaletteDrag {
  readonly name: string;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

export function VisualBuilderDialog() {
  const controller = useController();
  const t = useT();
  const language = useAppState((state) => state.language);
  const idBase = useId();
  const [header, setHeader] = useState<VisualNpcHeader>(INITIAL_HEADER);
  const [graph, setGraph] = useState<FlowGraph>(() => flowFromNodes(initialNodes()));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Vrai des que l'utilisateur place un noeud lui-meme (deplacement, depot) : le dialogue ne range plus. « Ranger le canevas » le remet a faux. */
  const [placedByHand, setPlacedByHand] = useState(false);
  const [pending, setPending] = useState<FlowPending | null>(null);
  const [anchorPort, setAnchorPort] = useState<FlowPort | null>(null);
  const [extensionCommands, setExtensionCommands] = useState<VisualScriptCommandDefinition[]>([]);
  const [extensionMessage, setExtensionMessage] = useState("");
  const [extensionError, setExtensionError] = useState(false);
  const [fileName, setFileName] = useState("npc/custom/new_npc.txt");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);
  const [createError, setCreateError] = useState<"exists" | "invalid" | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<CheckedSource | null>(null);
  const nextId = useRef(3);
  const canvasRef = useRef<HTMLDivElement>(null);
  const paletteDrag = useRef<PaletteDrag | null>(null);
  const suppressClick = useRef(false);

  const definitions = useMemo(() => [...DEFINITIONS, ...extensionCommands], [extensionCommands]);
  const definitionByName = useMemo(() => new Map(definitions.map((definition) => [definition.name.toLowerCase(), definition])), [definitions]);
  const result = useMemo(() => buildFlowNpc(header, graph, definitions), [definitions, graph, header]);
  const source = result.source;
  const problems = result.issues.length + result.flowIssues.length;
  const names = flowNodeNames(graph, t);
  const nameOf = (id: string): string => names.get(id) ?? id;

  useEffect(() => {
    if (source === null || problems > 0) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      void controller.previewWizardDiagnostics(source).then((diagnostics) => {
        if (active) setChecked({ source, diagnostics });
      });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [controller, problems, source]);

  const matchingCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return definitions
      .filter((definition) => needle === "" ||
        definition.name.toLowerCase().includes(needle) ||
        definition.signatures.some((signature) => signature.toLowerCase().includes(needle)))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 40);
  }, [definitions, query]);

  const invalidIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of result.issues) if (issue.nodeId !== undefined) ids.add(issue.nodeId);
    for (const issue of result.flowIssues) if (issue.nodeId !== undefined) ids.add(issue.nodeId);
    return ids;
  }, [result.flowIssues, result.issues]);

  const selected = selectedId === null ? undefined : findFlowNode(graph, selectedId);
  const selectedPorts = selected === undefined ? [] : outputPorts(selected);
  const preferredPort = anchorPort !== null && selectedPorts.includes(anchorPort) ? anchorPort : undefined;

  const setHeaderValue = (key: keyof VisualNpcHeader, value: string): void =>
    setHeader((previous) => ({ ...previous, [key]: value }));

  /** Applique le resultat d'une modification du graphe, ou dit pourquoi elle est refusee. */
  const commit = (change: FlowChange, message: string, keepPositions = false): boolean => {
    if (change.ok) {
      setGraph(placedByHand || keepPositions ? change.graph : layoutFlow(change.graph));
      setStatus(message);
      return true;
    }
    setStatus(t(REJECTION_MESSAGE[change.reason]));
    return false;
  };

  /** Ajoute un noeud : a l'endroit du depot s'il y en a un (sans fil), sinon apres le noeud choisi, dans la chaine. */
  const addNode = (build: (id: string) => FlowNode | null, idPrefix: string, label: string, dropAt?: FlowPosition): void => {
    const id = `${idPrefix}-${nextId.current}`;
    const node = build(id);
    if (node === null) {
      setStatus(t("visualBuilder.error.signature"));
      return;
    }
    nextId.current += 1;
    const message = t("visualBuilder.commandAdded", { name: label });
    if (dropAt !== undefined) {
      setPlacedByHand(true);
      if (commit(addFlowNode(graph, { ...node, position: dropAt }), message, true)) setSelectedId(id);
      return;
    }
    const anchor = flowAnchor(graph, selectedId, preferredPort);
    const placed = { ...node, position: suggestFlowPosition(graph, anchor?.id) };
    const change = anchor === null ? addFlowNode(graph, placed) : insertFlowNode(graph, placed, anchor);
    if (commit(change, message)) setSelectedId(id);
  };

  const addCommand = (name: string, dropAt?: FlowPosition): void => {
    const definition = definitionByName.get(name.toLowerCase());
    if (definition === undefined) {
      setStatus(t("visualBuilder.dropRejected"));
      return;
    }
    addNode(
      (id) => {
        const created = createVisualCommandNode(definition, id);
        return created === null ? null : { ...created, position: { x: 0, y: 0 } };
      },
      "command",
      definition.name,
      dropAt,
    );
  };

  const addCondition = (): void =>
    addNode((id) => ({ id, type: "if", condition: "1", position: { x: 0, y: 0 } }), "condition", t("visualBuilder.condition"));

  const connect = (from: string, port: FlowPort, to: string): void => {
    setPending(null);
    commit(connectFlow(graph, from, port, to), t("flow.status.connected", { port: t(PORT_LABEL[port]), from: nameOf(from), to: nameOf(to) }));
  };

  const disconnect = (from: string, port: FlowPort): void => {
    setGraph((previous) => disconnectFlow(previous, from, port));
    setStatus(t("flow.status.disconnected", { port: t(PORT_LABEL[port]), from: nameOf(from) }));
  };

  const pick = (next: FlowPending | null): void => {
    setPending(next);
    setStatus(next === null ? t("flow.status.cancelled") : t("flow.status.picked", { port: t(PORT_LABEL[next.port]), from: nameOf(next.id) }));
  };

  const remove = (id: string): void => {
    const name = nameOf(id);
    // La selection d'un noeud supprime ne designe plus rien : elle se deduit de `findFlowNode`, il n'y a rien a effacer.
    if (commit(dissolveFlowNode(graph, id), t("flow.status.removed", { name })) && pending?.id === id) setPending(null);
  };

  // --- Glisser depuis la bibliotheque (evenements du pointeur : meme chemin a la souris, au stylet et au doigt) ----------------------

  const startPalette = (event: PointerEvent<HTMLButtonElement>, name: string): void => {
    if (event.button !== 0) return;
    paletteDrag.current = { name, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const movePalette = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = paletteDrag.current;
    if (drag === null) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_THRESHOLD) drag.moved = true;
    if (drag.moved) setGhost({ name: drag.name, x: event.clientX, y: event.clientY });
  };
  const endPalette = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = paletteDrag.current;
    paletteDrag.current = null;
    setGhost(null);
    if (drag === null || !drag.moved) return;
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    const root = canvasRef.current;
    const element = typeof document.elementFromPoint === "function" ? document.elementFromPoint(event.clientX, event.clientY) : null;
    if (root === null || element === null || !root.contains(element)) {
      setStatus(t("flow.status.dropOutside"));
      return;
    }
    const point = toCanvasPoint(root, event.clientX, event.clientY);
    addCommand(drag.name, { x: point.x - FLOW_NODE_WIDTH / 2, y: point.y - FLOW_HEADER_HEIGHT / 2 });
  };

  const loadExtension = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setExtensionMessage("");
    setExtensionError(false);
    if (file.size > 256 * 1024) {
      setExtensionMessage(t("visualBuilder.extensionTooLarge"));
      setExtensionError(true);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      setExtensionMessage(t("visualBuilder.extensionInvalid"));
      setExtensionError(true);
      return;
    }
    const reservedNames = new Set([
      ...BUILT_IN_NAMES,
      ...extensionCommands.map((definition) => definition.name.toLowerCase()),
    ]);
    const parsed = parseVisualExtensionManifest(text, reservedNames);
    if (!parsed.ok) {
      setExtensionMessage(t(`visualBuilder.extensionError.${parsed.code}`));
      setExtensionError(true);
      return;
    }
    setExtensionCommands((previous) => [...previous, ...parsed.manifest.commands]);
    setExtensionMessage(t("visualBuilder.extensionLoaded", {
      name: parsed.manifest.name,
      count: parsed.manifest.commands.length,
    }));
  };

  const diagnostics = checked?.source === source ? checked.diagnostics : null;
  const serverErrors = diagnostics?.filter((diagnostic) => diagnostic.severity === "error") ?? [];
  const ready = source !== null && problems === 0 && diagnostics !== null && serverErrors.length === 0;
  const create = async (): Promise<void> => {
    if (!ready || source === null || busy) return;
    setBusy(true);
    const outcome = await controller.createWizardFile(fileName, source);
    if (outcome !== "created") {
      setCreateError(outcome);
      setBusy(false);
    }
  };

  const messages = [...new Set([
    ...result.flowIssues.map((issue) => t(FLOW_ISSUE_MESSAGE[issue.code])),
    ...result.issues.map((issue) => t(ISSUE_MESSAGE[issue.code])),
  ])];

  return (
    <Modal
      title={t("visualBuilder.title")}
      wide
      extraWide
      onDismiss={() => controller.closeDialog()}
      actions={
        <>
          <button type="button" className="button" onClick={() => controller.closeDialog()}>{t("dialog.close")}</button>
          <button type="button" className="button button-primary" disabled={!ready || busy} onClick={() => void create()}>
            {busy ? t("visualBuilder.creating") : t("visualBuilder.create")}
          </button>
        </>
      }
    >
      <p className="hint">{t("visualBuilder.intro")}</p>
      <section aria-labelledby={`${idBase}-header`}>
        <h3 id={`${idBase}-header`}>{t("visualBuilder.header")}</h3>
        <div className="visual-builder-header">
          {([
            ["map", "visualBuilder.map"],
            ["x", "visualBuilder.x"],
            ["y", "visualBuilder.y"],
            ["direction", "visualBuilder.direction"],
            ["name", "visualBuilder.name"],
            ["sprite", "visualBuilder.sprite"],
          ] as const).map(([key, label]) => {
            const id = `${idBase}-${key}`;
            return (
              <div className="field" key={key}>
                <label htmlFor={id}>{t(label)}</label>
                <input id={id} type="text" value={header[key]} autoComplete="off" onChange={(event) => setHeaderValue(key, event.target.value)} />
              </div>
            );
          })}
        </div>
      </section>

      <div className="visual-builder-layout">
        <section className="visual-builder-palette" aria-labelledby={`${idBase}-palette`}>
          <h3 id={`${idBase}-palette`}>{t("visualBuilder.library")}</h3>
          <label className="field" htmlFor={`${idBase}-search`}>{t("visualBuilder.search")}</label>
          <input
            id={`${idBase}-search`}
            type="search"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          <p className="hint">{t("visualBuilder.libraryHint", { count: definitions.length })}</p>
          <ul className="visual-builder-command-list">
            {matchingCommands.map((definition) => {
              const supported = createVisualCommandNode(definition, "probe") !== null;
              const signature = definition.signatures[0] ?? definition.parameterTypes ?? "";
              return (
                <li key={definition.name}>
                  <button
                    type="button"
                    className="button visual-builder-command"
                    disabled={!supported}
                    aria-label={`${t("visualBuilder.addCommand")} ${definition.name}`}
                    onPointerDown={(event) => startPalette(event, definition.name)}
                    onPointerMove={movePalette}
                    onPointerUp={endPalette}
                    onPointerCancel={() => {
                      paletteDrag.current = null;
                      setGhost(null);
                    }}
                    onClick={() => {
                      if (suppressClick.current) return;
                      addCommand(definition.name);
                    }}
                  >
                    <strong>{definition.name}</strong>
                    <span>{signature}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {matchingCommands.length === 0 && <p className="hint">{t("visualBuilder.noCommands")}</p>}
        </section>

        <section className="visual-builder-workspace" aria-labelledby={`${idBase}-flow`}>
          <h3 id={`${idBase}-flow`}>{t("visualBuilder.flow")}</h3>
          <p className="hint" id={`${idBase}-flow-hint`}>{t("visualBuilder.flowHint")}</p>
          <div className="flow-toolbar">
            <button type="button" className="button button-small" onClick={addCondition}>{t("visualBuilder.addCondition")}</button>
            <button type="button" className="button button-small" onClick={() => {
              setPlacedByHand(false);
              setGraph((previous) => layoutFlow(previous));
            }}>{t("flow.tidy")}</button>
            <div className="field">
              <label htmlFor={`${idBase}-anchor`}>{t("visualBuilder.insertTarget")}</label>
              <select id={`${idBase}-anchor`} value={preferredPort ?? selectedPorts[0] ?? ""} disabled={selectedPorts.length === 0} onChange={(event) => setAnchorPort(event.target.value as FlowPort)}>
                {selectedPorts.length === 0 ? <option value="">—</option> : selectedPorts.map((port) => <option key={port} value={port}>{t(PORT_LABEL[port])}</option>)}
              </select>
            </div>
            <span className="hint">{selected === undefined ? t("flow.noSelection") : t("flow.selected", { name: nameOf(selected.id) })}</span>
          </div>
          <FlowCanvas
            graph={graph}
            npcName={header.name}
            definitions={definitionByName}
            selectedId={selectedId}
            invalidIds={invalidIds}
            pending={pending}
            rootRef={canvasRef}
            describedBy={`${idBase}-flow-hint`}
            onSelect={setSelectedId}
            onMove={(id, position) => {
              setPlacedByHand(true);
              setGraph((previous) => moveFlowNode(previous, id, position));
            }}
            onConnect={connect}
            onDisconnect={disconnect}
            onPick={pick}
            onUpdate={(id, update) => setGraph((previous) => updateFlowNode(previous, id, update))}
            onRemove={remove}
          />
          <p role="status" className="hint">{status || t("visualBuilder.dropHint")}</p>
        </section>
      </div>
      {ghost !== null && <div className="flow-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>{t("flow.dragging", { name: ghost.name })}</div>}

      <section aria-labelledby={`${idBase}-extensions`}>
        <h3 id={`${idBase}-extensions`}>{t("visualBuilder.extensions")}</h3>
        <p className="hint">{t("visualBuilder.extensionsHint")}</p>
        <label className="field" htmlFor={`${idBase}-extension`}>{t("visualBuilder.loadExtension")}</label>
        <input
          id={`${idBase}-extension`}
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            void loadExtension(file);
            event.currentTarget.value = "";
          }}
        />
        {extensionMessage !== "" && <p className={extensionError ? "field-error" : "hint"} role={extensionError ? "alert" : "status"}>{extensionMessage}</p>}
      </section>

      {messages.length > 0 && (
        <section aria-labelledby={`${idBase}-issues`}>
          <h3 id={`${idBase}-issues`}>{t("visualBuilder.validation")}</h3>
          <ul className="field-error" role="alert">
            {messages.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </section>
      )}
      {source !== null && problems === 0 && (
        <section aria-labelledby={`${idBase}-check`}>
          <h3 id={`${idBase}-check`}>{t("visualBuilder.validation")}</h3>
          {checked?.source !== source && <p role="status">{t("visualBuilder.checking")}</p>}
          {checked?.source === source && diagnostics === null && <p role="alert">{t("visualBuilder.checkUnavailable")}</p>}
          {checked?.source === source && diagnostics !== null && (
            serverErrors.length === 0
              ? <p role="status">{t("visualBuilder.checkPassed", { count: diagnostics.length })}</p>
              : <ul className="field-error" role="alert">{serverErrors.map((diagnostic, index) => (
                <li key={`${diagnostic.code}:${index}`}>{diagnostic.code}: {describeDiagnostic(diagnostic, language).message}</li>
              ))}</ul>
          )}
        </section>
      )}

      <section aria-labelledby={`${idBase}-preview`}>
        <h3 id={`${idBase}-preview`}>{t("visualBuilder.preview")}</h3>
        {source === null
          ? <p className="hint">{t("visualBuilder.noPreview")}</p>
          : <pre className="visual-builder-preview" role="region" aria-label={t("visualBuilder.preview")} tabIndex={0}>{source}</pre>}
        <label className="field" htmlFor={`${idBase}-file`}>{t("visualBuilder.fileName")}</label>
        <input
          id={`${idBase}-file`}
          type="text"
          value={fileName}
          autoComplete="off"
          onChange={(event) => {
            setFileName(event.target.value);
            setCreateError(null);
          }}
        />
        {createError !== null && <p className="field-error" role="alert">{t(createError === "exists" ? "visualBuilder.fileExists" : "visualBuilder.fileInvalid")}</p>}
      </section>
    </Modal>
  );
}
