import {
  applyAction,
  createVisualGraph,
  loadNpc,
  type EditFailure,
  type IfBlock,
  type NewBlock,
  type VisualAction,
  type VisualBlock,
  type VisualGraph,
  type VisualGraphEdge,
  type VisualGraphNode,
} from "@runeforge/visual-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState, useController, useServices, useT } from "../../app/context";
import { Modal } from "../../components/Modal";
import type { MessageKey } from "../../i18n/messages";

const KIND_LABEL: Readonly<Record<VisualBlock["kind"], MessageKey>> = {
  mes: "visual.kind.mes",
  next: "visual.kind.next",
  close: "visual.kind.close",
  if: "visual.kind.if",
  raw: "visual.kind.raw",
};

const GRAPH_NODE_LABEL: Readonly<Record<VisualGraphNode["type"], MessageKey>> = {
  start: "visual.graph.start",
  end: "visual.graph.end",
  mes: "visual.kind.mes",
  next: "visual.kind.next",
  close: "visual.kind.close",
  if: "visual.kind.if",
  raw: "visual.kind.raw",
};

const GRAPH_PORT_LABEL: Readonly<Record<VisualGraphEdge["sourcePort"], MessageKey>> = {
  next: "visual.graph.next",
  then: "visual.then",
  else: "visual.else",
  terminal: "visual.graph.terminal",
  sequence: "visual.graph.sourceOrder",
};

const FAILURE_MESSAGE: Readonly<Record<EditFailure, MessageKey>> = {
  "unknown-block": "visual.failure.unknown-block",
  locked: "visual.failure.locked",
  "bad-text": "visual.failure.bad-text",
  "not-alone-on-line": "visual.failure.not-alone-on-line",
  "no-neighbour": "visual.failure.no-neighbour",
  "invalid-condition": "visual.failure.invalid-condition",
  "new-syntax-error": "visual.failure.new-syntax-error",
  "unknown-npc": "visual.failure.unknown-npc",
};

const ADDABLE: readonly { readonly block: NewBlock; readonly append: MessageKey; readonly after: MessageKey }[] = [
  { block: { kind: "mes", text: "..." }, append: "visual.add.mes", after: "visual.addAfter.mes" },
  { block: { kind: "next" }, append: "visual.add.next", after: "visual.addAfter.next" },
  { block: { kind: "close" }, append: "visual.add.close", after: "visual.addAfter.close" },
  { block: { kind: "if", condition: "1" }, append: "visual.add.if", after: "visual.addAfter.if" },
];

/** Ce qui prend le focus apres une action : le bloc d'identifiant `id`, et dans sa ligne le controle `control` (a defaut le premier). */
interface FocusTarget {
  readonly id: string | null;
  readonly control: "up" | "down" | "delete" | "first";
}

/** Un court resume d'un bloc pour nommer ses boutons. */
function summary(block: VisualBlock): string {
  switch (block.kind) {
    case "mes":
      return `mes "${block.text.slice(0, 24)}${block.text.length > 24 ? "…" : ""}"`;
    case "if":
      return `if (${block.condition.slice(0, 24)}${block.condition.length > 24 ? "…" : ""})`;
    case "raw":
      return block.text.split("\n")[0]?.trim().slice(0, 28) ?? "";
    default:
      return `${block.kind};`;
  }
}

function projectDocumentUri(path: string): string {
  return `runeforge://project/${path.split(/[\\/]/).map((part) => encodeURIComponent(part)).join("/")}`;
}

/** Identifiant du frere d'indice `index` : `3.t.0` -> `3.t.1`. */
function siblingId(id: string, index: number): string {
  const parts = id.split(".");
  parts[parts.length - 1] = String(index);
  return parts.join(".");
}

/** Identifiant du bloc qui contient celui-ci (`3.t.0` -> `3`) ; `null` pour un bloc du corps. */
function parentId(id: string): string | null {
  const parts = id.split(".");
  return parts.length < 3 ? null : parts.slice(0, -2).join(".");
}

interface InputProps {
  readonly value: string;
  readonly label: string;
  readonly onCommit: (text: string) => void;
}

/**
 * Champ de texte d'un bloc : la saisie reste un brouillon jusqu'a Entree ou la sortie du champ ; le brouillon repart de la valeur du
 * bloc quand celle-ci change d'ailleurs (changements annules, ou ligne reutilisee par un autre bloc). Le champ n'est jamais recree :
 * il garde le focus pendant et apres la validation.
 */
function CommitInput({ value, label, onCommit }: InputProps) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      className="visual-input"
      value={draft}
      spellCheck={false}
      aria-label={label}
      data-control="first"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

interface RowProps {
  readonly block: VisualBlock;
  readonly index: number;
  readonly count: number;
  readonly act: (action: VisualAction, focus: FocusTarget | null) => void;
}

function AddButtons({ label, onAdd, after = false }: { readonly label: string; readonly onAdd: (block: NewBlock) => void; readonly after?: boolean }) {
  const t = useT();
  return ADDABLE.map((entry) => (
    <button
      key={entry.block.kind}
      type="button"
      className="button button-small"
      aria-label={`${t(after ? entry.after : entry.append)} — ${label}`}
      onClick={() => onAdd(entry.block)}
    >
      + {t(KIND_LABEL[entry.block.kind])}
    </button>
  ));
}

function BranchList({ block, branch, act }: { readonly block: IfBlock; readonly branch: "then" | "else"; readonly act: RowProps["act"] }) {
  const t = useT();
  const name = t(branch === "then" ? "visual.then" : "visual.else");
  const label = `${name} — ${summary(block)}`;
  const blocks = block[branch] ?? [];
  const append = (newBlock: NewBlock): void => {
    act({ type: "append", target: { kind: "branch", id: block.id, branch }, block: newBlock }, { id: `${block.id}.${branch === "then" ? "t" : "e"}.0`, control: "first" });
  };
  return (
    <section className="visual-flow-branch" data-branch={branch} aria-label={label}>
      <p className="hint visual-branch">{name}</p>
      {blocks.length > 0 ? <BlockList blocks={blocks} act={act} /> : (
        <>
          {block[branch] === null && <p className="hint">{t("visual.noElse")}</p>}
          <div className="visual-actions"><AddButtons label={label} onAdd={append} /></div>
        </>
      )}
    </section>
  );
}

/** Une ligne de la liste : le bloc, ses champs modifiables, ses boutons. Un bloc brut n'a ni deplacement ni suppression. */
function BlockRow({ block, index, count, act }: RowProps) {
  const t = useT();
  const name = summary(block);
  const locked = block.kind === "raw";
  const canUp = index > 0;
  const canDown = index < count - 1;
  const move = (direction: "up" | "down"): void => {
    if (direction === "up" ? !canUp : !canDown) return;
    act({ type: "move", id: block.id, direction }, { id: siblingId(block.id, direction === "up" ? index - 1 : index + 1), control: direction });
  };
  const remove = (): void => {
    // Le focus va au bloc qui prend la place de celui-ci (le precedent si c'etait le dernier), a defaut au bloc qui contient la liste.
    const next = index < count - 1 ? block.id : index > 0 ? siblingId(block.id, index - 1) : parentId(block.id);
    act({ type: "remove", id: block.id }, { id: next, control: "delete" });
  };
  return (
    <li className={`visual-block visual-block-${block.kind}`} data-block-id={block.id}>
      <div className="visual-line">
        <strong className="visual-kind">{t(KIND_LABEL[block.kind])}</strong>
        {block.kind === "mes" && (
          <CommitInput value={block.text} label={`${t("visual.mesText")} — ${name}`} onCommit={(text) => act({ type: "setMesText", id: block.id, text }, null)} />
        )}
        {block.kind === "if" && (
          <CommitInput value={block.condition} label={`${t("visual.condition")} — ${name}`} onCommit={(text) => act({ type: "setCondition", id: block.id, text }, null)} />
        )}
        {(block.kind === "next" || block.kind === "close") && <code>{block.kind};</code>}
        {block.kind === "raw" && (
          <>
            <pre className="visual-raw">{block.text}</pre>
            <span className="hint">{t("visual.raw.locked")}</span>
          </>
        )}
      </div>
      <div className="visual-actions" role="group" aria-label={name}>
        {!locked && (
          <>
            <button type="button" className="button button-small" data-control="up" aria-disabled={!canUp} aria-label={`${t("visual.up")} — ${name}`} onClick={() => move("up")}>
              {t("visual.up")}
            </button>
            <button type="button" className="button button-small" data-control="down" aria-disabled={!canDown} aria-label={`${t("visual.down")} — ${name}`} onClick={() => move("down")}>
              {t("visual.down")}
            </button>
            <button type="button" className="button button-small" data-control="delete" aria-label={`${t("visual.delete")} — ${name}`} onClick={remove}>
              {t("visual.delete")}
            </button>
          </>
        )}
        <AddButtons label={name} after onAdd={(newBlock) => act({ type: "insertAfter", id: block.id, block: newBlock }, { id: siblingId(block.id, index + 1), control: "first" })} />
      </div>
      {block.kind === "if" && (
        <>
          <BranchList block={block} branch="then" act={act} />
          <BranchList block={block} branch="else" act={act} />
        </>
      )}
    </li>
  );
}

function BlockList({ blocks, act }: { readonly blocks: readonly VisualBlock[]; readonly act: RowProps["act"] }) {
  return (
    <ul className="visual-list">
      {blocks.map((block, index) => (
        <BlockRow key={block.id} block={block} index={index} count={blocks.length} act={act} />
      ))}
    </ul>
  );
}

function FlowGraph({ graph }: { readonly graph: VisualGraph }) {
  const t = useT();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <details className="visual-graph">
      <summary>{t("visual.graph.summary", { nodes: graph.nodes.length, edges: graph.edges.length })}</summary>
      <section aria-label={t("visual.graph.title")}>
        <h4>{t("visual.graph.nodes")}</h4>
        <ol className="visual-graph-nodes">
          {graph.nodes.map((node) => (
            <li key={node.id} data-node-id={node.id}>
              <strong>{t(GRAPH_NODE_LABEL[node.type])}</strong>
              <code>{node.id}</code>
              {node.type === "mes" && <q>{node.text}</q>}
              {node.type === "if" && <code>{node.condition}</code>}
              {node.type === "raw" && <pre>{node.code}</pre>}
            </li>
          ))}
        </ol>
        <h4>{t("visual.graph.connections")}</h4>
        <ul className="visual-graph-edges">
          {graph.edges.map((edge) => {
            const source = nodes.get(edge.sourceNodeId);
            const target = nodes.get(edge.targetNodeId);
            if (source === undefined || target === undefined) return null;
            return (
              <li key={edge.id} data-edge-id={edge.id}>
                <span>{t(GRAPH_NODE_LABEL[source.type])} <code>{source.id}</code></span>
                <span>{t(GRAPH_PORT_LABEL[edge.sourcePort])}</span>
                <span>{t("visual.graph.to")}</span>
                <span>{t(GRAPH_NODE_LABEL[target.type])} <code>{target.id}</code></span>
              </li>
            );
          })}
        </ul>
      </section>
    </details>
  );
}

/**
 * Editeur visuel de dialogues (RF-020 a RF-023) : un NPC lu en blocs ; chaque action est une modification de texte ciblee appliquee a une
 * copie, les changements sont montres en regard de l'original et ne vont a l'editeur qu'apres confirmation, en une seule etape d'annulation.
 */
export function VisualDialog({ path, declarationStart, baseText }: { readonly path: string; readonly declarationStart: number; readonly baseText: string }) {
  const controller = useController();
  const t = useT();
  const { surfaces } = useServices();
  const Diff = surfaces.Diff;
  const profileId = useAppState((state) => state.project?.config.emulator.family ?? "unknown");
  const [working, setWorking] = useState(baseText);
  const [workingVersion, setWorkingVersion] = useState(0);
  const [failure, setFailure] = useState<EditFailure | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const npc = useMemo(() => loadNpc(working, declarationStart), [working, declarationStart]);
  const graph = useMemo(
    () => npc === null ? null : createVisualGraph(npc, projectDocumentUri(path), workingVersion, profileId),
    [npc, path, profileId, workingVersion],
  );

  // Un bloc qui disparait ou change de place emporterait le focus avec lui (il retomberait sur la page derriere le dialogue) : il suit
  // le bloc concerne, ou a defaut le titre du NPC.
  useEffect(() => {
    if (focus === null) return;
    const row = focus.id === null ? null : bodyRef.current?.querySelector<HTMLElement>(`[data-block-id="${focus.id}"]`);
    const target = row?.querySelector<HTMLElement>(`[data-control="${focus.control}"]`) ?? row?.querySelector<HTMLElement>("input, button") ?? headingRef.current;
    target?.focus();
  }, [focus, working]);

  const act = (action: VisualAction, next: FocusTarget | null): void => {
    const result = applyAction(working, declarationStart, action);
    if (result.ok) {
      setFailure(null);
      setConfirmingClose(false);
      if (result.text !== working) {
        setWorking(result.text);
        setWorkingVersion((version) => version + 1);
      }
      if (next !== null) setFocus(next);
    } else {
      setFailure(result.reason);
    }
  };

  const changed = working !== baseText;
  const close = (): void => {
    if (changed && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    controller.closeDialog();
  };
  const status = npc === null ? null : npc.status === "full" ? t("visual.status.full") : npc.status === "partial" ? t("visual.status.partial", { raw: npc.counts.raw }) : t("visual.status.unsupported");

  return (
    <Modal
      title={t("visual.title")}
      wide
      onDismiss={close}
      actions={
        <>
          <button type="button" className="button" onClick={close}>
            {confirmingClose ? t("visual.discardClose") : t("dialog.close")}
          </button>
          <button
            type="button"
            className="button"
            aria-disabled={!changed}
            onClick={() => {
              if (!changed) return;
              setWorking(baseText);
              setWorkingVersion((version) => version + 1);
              setFailure(null);
              setConfirmingClose(false);
            }}
          >
            {t("visual.discard")}
          </button>
          <button type="button" className="button button-primary" aria-disabled={!changed} onClick={() => changed && controller.applyVisualEdit(path, baseText, working)}>
            {t("visual.apply")}
          </button>
        </>
      }
    >
      <div ref={bodyRef}>
        <p className="hint">{t("visual.intro")}</p>
        {npc === null ? (
          <p className="field-error" role="alert">
            {t("visual.failure.unknown-npc")}
          </p>
        ) : (
          <section aria-labelledby="visual-npc-heading">
            <h3 id="visual-npc-heading" ref={headingRef} tabIndex={-1}>
              {t("visual.npc", { name: npc.name })}
            </h3>
            <p className="hint">{status}</p>
            {npc.blocks.length > 0 ? <BlockList blocks={npc.blocks} act={act} /> : (
              <>
                <p className="hint">{t("visual.empty")}</p>
                <div className="visual-actions">
                  <AddButtons label={t("visual.body")} onAdd={(block) => act({ type: "append", target: { kind: "body" }, block }, { id: "0", control: "first" })} />
                </div>
              </>
            )}
            {graph !== null && <FlowGraph graph={graph} />}
          </section>
        )}
        {failure !== null && (
          <p className="field-error" role="alert">
            {t(FAILURE_MESSAGE[failure])}
          </p>
        )}
        {confirmingClose && (
          <p className="field-warning" role="alert">
            {t("visual.unsaved")}
          </p>
        )}
        <p className="hint" role="status">
          {changed ? t("visual.changed") : t("visual.unchanged")}
        </p>
        {changed && (
          <section aria-label={t("visual.changes")}>
            <h3>{t("visual.changes")}</h3>
            <div className="diff-surface">
              <Diff original={baseText} modified={working} originalLabel={t("visual.before")} modifiedLabel={t("visual.after")} />
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
