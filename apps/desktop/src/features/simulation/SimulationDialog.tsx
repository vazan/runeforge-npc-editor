import { useEffect, useRef, useState } from "react";
import { RATHENA_JOB_CLASSES } from "@runeforge/emulator-rathena/job-classes";
import { parse, type NpcDeclaration } from "@runeforge/runescript-parser";
import {
  MAX_INPUT_LENGTH,
  resolveFunctions,
  SimulationSession,
  type FunctionSource,
  type SimulationContext,
  type SimulationView,
  type SimValue,
  type TranscriptEntry,
} from "@runeforge/simulation-core";
import { useController, useT } from "../../app/context";
import { Modal } from "../../components/Modal";
import type { MessageKey } from "../../i18n/messages";
import { AIProposalPanel } from "./AIProposalPanel";

function entries<T>(text: string, valid: (value: unknown) => value is T): [string, T][] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid context");
  const result: [string, T][] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!valid(value)) throw new Error("invalid context value");
    result.push([key, value]);
  }
  return result;
}

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isAmount = (value: unknown): value is number => isInteger(value) && value >= 0;
const isValue = (value: unknown): value is SimValue => isInteger(value) || (typeof value === "string" && value.length <= 1_000);
const isQuest = (value: unknown): value is number => isInteger(value) && value >= -1 && value <= 2;

interface ScenarioInput {
  readonly context: SimulationContext;
  readonly seed: number;
}

function readContext(form: FormData): ScenarioInput {
  const level = Number(form.get("level"));
  const job = Number(form.get("job"));
  const zeny = Number(form.get("zeny"));
  const seed = Number(form.get("seed") ?? 1);
  if (!isAmount(level) || level === 0 || !isAmount(job) || !isAmount(zeny) || !isAmount(seed)) throw new Error("invalid character");
  const variables = new Map(entries(String(form.get("variables")), isValue));
  const items = new Map(entries(String(form.get("items")), isAmount).map(([key, value]) => [key.toLowerCase(), value] as const));
  const quests = new Map(entries(String(form.get("quests")), isQuest).map(([key, value]) => {
    const id = Number(key);
    if (!/^\d+$/.test(key) || !isAmount(id)) throw new Error("invalid quest id");
    return [id, value] as const;
  }));
  const results = new Map(entries(String(form.get("results") ?? "{}"), isValue).map(([key, value]) => [key.toLowerCase(), value] as const));
  const name = String(form.get("name") ?? "").trim().slice(0, 24);
  return { context: { level, job, zeny, variables, items, quests, results, ...(name === "" ? {} : { name }) }, seed };
}

interface LoadedNpc {
  readonly npc: NpcDeclaration;
  /** Fonctions globales définies dans le même fichier : `callfunc` les exécute. */
  readonly functions: ReadonlyMap<string, FunctionSource>;
  /**
   * Erreurs de syntaxe du NPC (corps non fermé compris). L'analyseur est tolérant : le dialogue joue ce qu'il a compris, note
   * le reste « non simulé », et ne refuse jamais le NPC.
   */
  readonly syntaxErrors: number;
}

function loadNpc(source: string, offset: number): LoadedNpc | undefined {
  const parsed = parse(source);
  const npc = parsed.ast.declarations.find((declaration): declaration is NpcDeclaration =>
    declaration.kind === "NpcDeclaration" && declaration.range.start === offset && declaration.body !== null);
  if (npc === undefined) return undefined;
  const syntaxErrors =
    parsed.diagnostics.filter((item) => item.severity === "error" && item.range.start >= npc.range.start && item.range.start < npc.range.end).length +
    (npc.body?.closeRange == null ? 1 : 0);
  const functions = new Map<string, FunctionSource>();
  for (const declaration of parsed.ast.declarations) {
    if (declaration.kind === "FunctionDeclaration") functions.set(declaration.name.toLowerCase(), { declaration, source });
  }
  return { npc, functions, syntaxErrors };
}

/** Valeurs des constantes du serveur (`Job_Knight`, `Sex_Male`...), chargées à la première simulation seulement. */
let constantsPromise: Promise<ReadonlyMap<string, SimValue>> | undefined;
function loadConstants(): Promise<ReadonlyMap<string, SimValue>> {
  constantsPromise ??= import("@runeforge/emulator-rathena/script-constants").then(
    (module) => module.RATHENA_SCRIPT_CONSTANTS,
    () => new Map<string, SimValue>(),
  );
  return constantsPromise;
}

/** Les codes de couleur du client (`^FF0000`) ne sont pas du texte. */
const plain = (text: string): string => text.replace(/\^[0-9a-fA-F]{6}/g, "");

/** Ce que le serveur reprocherait à une opération que la simulation a franchie (`detail` : voir `TranscriptEntry`). */
function faultReason(detail: string): { readonly key: MessageKey; readonly name: string } {
  switch (detail) {
    case "divide": return { key: "sim.fault.divide", name: "" };
    case "shift": return { key: "sim.fault.shift", name: "" };
    case "overflow": return { key: "sim.fault.overflow", name: "" };
    case "operand": return { key: "sim.fault.operand", name: "" };
    case "zeny": return { key: "sim.fault.zeny", name: "" };
    case "index": return { key: "sim.fault.index", name: "" };
    case "getarg": return { key: "sim.fault.getarg", name: "" };
    case "return": return { key: "sim.fault.return", name: "" };
    case "delitem": return { key: "sim.fault.delitem", name: "" };
    default:
      return detail.startsWith("label ") ? { key: "sim.fault.label", name: detail.slice(6) } : { key: "sim.fault.generic", name: detail };
  }
}

/** Limites qui interrompent une simulation (protègent l'application d'une boucle sans fin, d'un texte démesuré...). */
const LIMIT_REASONS: Readonly<Record<string, MessageKey>> = {
  steps: "sim.limit.steps",
  depth: "sim.limit.depth",
  calls: "sim.limit.calls",
  text: "sim.limit.text",
  variables: "sim.limit.variables",
  menu: "sim.limit.menu",
};

function Line({ entry }: { readonly entry: TranscriptEntry }) {
  const t = useT();
  switch (entry.kind) {
    case "mes":
      return <p>{plain(entry.text)}</p>;
    case "speech":
      return <p className="sim-speech">{t("sim.speech", { name: entry.name, text: plain(entry.text) })}</p>;
    case "player":
      return <p className="sim-player">{t("sim.player", { text: entry.text })}</p>;
    case "effect":
      return <p className="sim-note">{t("sim.effect", { text: entry.text })}{entry.count > 1 ? ` ${t("sim.times", { count: entry.count })}` : ""}</p>;
    case "assumed":
      return (
        <p className="sim-note">
          {t("sim.assumed", { text: entry.text, value: typeof entry.value === "string" ? JSON.stringify(entry.value) : entry.value })}
          {entry.count > 1 ? ` ${t("sim.times", { count: entry.count })}` : ""}
        </p>
      );
    case "fault": {
      const reason = faultReason(entry.detail);
      return (
        <p className="sim-note sim-fault">
          {entry.detail === "internal" ? t("sim.internal", { text: entry.text }) : t("sim.fault", { text: entry.text, reason: t(reason.key, { name: reason.name }) })}
          {entry.count > 1 ? ` ${t("sim.times", { count: entry.count })}` : ""}
        </p>
      );
    }
  }
}

export function SimulationDialog({ source, declarationStart }: { readonly source: string; readonly declarationStart: number }) {
  const controller = useController();
  const t = useT();
  const [loaded] = useState(() => loadNpc(source, declarationStart));
  const [session, setSession] = useState<SimulationSession | null>(null);
  const [view, setView] = useState<SimulationView | null>(null);
  const [invalid, setInvalid] = useState(false);
  const pauseRef = useRef<HTMLDivElement>(null);
  /** Fonctions du fichier et des autres fichiers du projet que le NPC appelle : cherchées une fois par ouverture du dialogue. */
  const functionsRef = useRef<Promise<ReadonlyMap<string, FunctionSource>> | null>(null);
  // Le bouton qui avait le focus disparait quand le script avance : sans ceci le focus tomberait sur la page (Echap ne
  // fermerait plus le dialogue, Tab repartirait du debut du document). Il passe au premier controle de l'attente suivante,
  // sinon a la zone de reponse elle-meme (fin du script, arret).
  useEffect(() => {
    const area = pauseRef.current;
    if (view === null || area === null) return;
    (area.querySelector<HTMLElement>("button, input") ?? area).focus();
  }, [view]);
  const active = view?.state;

  async function start(form: FormData): Promise<void> {
    if (loaded === undefined) return;
    let scenario: ScenarioInput;
    try {
      scenario = readContext(form);
    } catch {
      setInvalid(true);
      return;
    }
    const constants = await loadConstants();
    // Les fonctions que le NPC appelle ailleurs dans le projet (index du langage) s'ajoutent à celles de son fichier ; sans index,
    // ou pour une fonction qu'il ne connaît pas, l'appel reste noté « non simulé ».
    functionsRef.current ??= resolveFunctions([loaded.npc], loaded.functions, controller.createFunctionLookup()).catch(() => loaded.functions);
    const functions = await functionsRef.current;
    const next = new SimulationSession(loaded.npc, scenario.context, { source, functions, constants, seed: scenario.seed });
    setInvalid(false);
    setSession(next);
    setView(next.advance());
  }

  function reply(response?: SimValue): void {
    if (session !== null) setView(session.advance(response));
  }

  return (
    <Modal title={t("sim.title")} wide onDismiss={() => controller.closeDialog()} actions={
      <button type="button" className="button" onClick={() => controller.closeDialog()}>{t("dialog.close")}</button>
    }>
      <p>{t("sim.disclaimer")}</p>
      {loaded === undefined ? <p role="alert">{t("sim.noNpc")}</p> : (
        <>
          <h3>{loaded.npc.name.display}</h3>
          {loaded.syntaxErrors > 0 && <p className="hint" role="status">{t("sim.syntaxNotice", { count: loaded.syntaxErrors })}</p>}
          <AIProposalPanel source={source.slice(loaded.npc.range.start, loaded.npc.range.end)} />
          <form onSubmit={(event) => {
            event.preventDefault();
            void start(new FormData(event.currentTarget));
          }}>
            <fieldset>
              <legend>{t("sim.context")}</legend>
              <label>{t("sim.level")} <input name="level" type="number" min="1" step="1" defaultValue="1" required data-autofocus /></label>{" "}
              {/* Les noms de classe sont ceux du serveur (`jobname()`) ; la valeur envoyée est l'identifiant, celui de `Class`. */}
              <label>{t("sim.job")} <select name="job" defaultValue="0">
                {RATHENA_JOB_CLASSES.map((job) => <option key={job.id} value={job.id}>{job.name}</option>)}
              </select></label>{" "}
              <label>{t("sim.zeny")} <input name="zeny" type="number" min="0" step="1" defaultValue="0" required /></label>
              <details>
                <summary>{t("sim.advanced")}</summary>
                <p className="hint">{t("sim.contextHint")}</p>
                <label className="field">{t("sim.variables")} <textarea name="variables" defaultValue="{}" maxLength={4000} rows={2} /></label>
                <label className="field">{t("sim.items")} <textarea name="items" defaultValue="{}" maxLength={4000} rows={2} /></label>
                <label className="field">{t("sim.quests")} <textarea name="quests" defaultValue="{}" maxLength={4000} rows={2} /></label>
                <label className="field">{t("sim.results")} <textarea name="results" defaultValue="{}" maxLength={4000} rows={2} /></label>
                <label>{t("sim.name")} <input name="name" type="text" maxLength={24} defaultValue="Player" /></label>{" "}
                <label>{t("sim.seed")} <input name="seed" type="number" min="0" step="1" defaultValue="1" required /></label>
              </details>
            </fieldset>
            {invalid && <p className="field-error" role="alert">{t("sim.invalidContext")}</p>}
            <button type="submit" className="button button-primary">{t(view === null ? "sim.start" : "sim.restart")}</button>
          </form>
        </>
      )}
      {view !== null && (
        <section aria-label={t("sim.output")}>
          <h3>{t("sim.output")}</h3>
          <div role="log" aria-label={t("sim.output")} className="sim-log">
            {view.transcript.map((entry, index) => <Line key={index} entry={entry} />)}
          </div>
          <div ref={pauseRef} tabIndex={-1} className="sim-pause">
          {active?.kind === "page" && (
            <button type="button" className="button" onClick={() => reply()}>{t(active.closing ? "sim.close" : "sim.next")}</button>
          )}
          {active?.kind === "choice" && (
            <fieldset>
              <legend>{t("sim.choice")}</legend>
              {active.options.map((option) => (
                <button key={option.value} type="button" className="button" onClick={() => reply(option.value)}>{plain(option.label)}</button>
              ))}
            </fieldset>
          )}
          {active?.kind === "input" && (
            <form onSubmit={(event) => {
              event.preventDefault();
              const text = String(new FormData(event.currentTarget).get("answer") ?? "");
              if (active.numeric) {
                const amount = Number(text);
                if (text.trim() !== "" && Number.isSafeInteger(amount)) reply(amount);
              } else {
                reply(text);
              }
            }}>
              <label>
                {active.numeric ? t("sim.inputNumber", { min: active.min, max: active.max }) : t("sim.inputText")}{" "}
                {active.numeric
                  ? <input name="answer" type="number" step="1" required autoFocus />
                  : <input name="answer" type="text" maxLength={MAX_INPUT_LENGTH} autoFocus />}
              </label>{" "}
              <button type="submit" className="button">{t("sim.send")}</button>
            </form>
          )}
          {active?.kind === "end" && <p role="status">{t("sim.end")}</p>}
          {active?.kind === "closed" && <p role="status">{t("sim.closed")}</p>}
          {active?.kind === "limit" && (
            <p role="status">{t("sim.limit", { reason: LIMIT_REASONS[active.detail] === undefined ? active.detail : t(LIMIT_REASONS[active.detail] as MessageKey), text: plain(active.text) })}</p>
          )}
          </div>
          <p>{t("sim.balance", { value: view.zeny })}</p>
          <details>
            <summary>{t("sim.state")}</summary>
            <h4>{t("sim.variables")}</h4>
            <pre>{JSON.stringify(Object.fromEntries(view.variables), null, 2)}</pre>
            <h4>{t("sim.items")}</h4>
            <pre>{JSON.stringify(Object.fromEntries(view.items), null, 2)}</pre>
            <h4>{t("sim.quests")}</h4>
            <pre>{JSON.stringify(Object.fromEntries(view.quests), null, 2)}</pre>
          </details>
        </section>
      )}
    </Modal>
  );
}
