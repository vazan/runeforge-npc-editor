import {
  initialValues,
  runWizard,
  wizardsFor,
  type WizardField,
  type WizardId,
  type WizardProblem,
} from "@runeforge/npc-templates";
import { describeDiagnostic, LineIndex, type ParseDiagnostic } from "@runeforge/runescript-core";
import { useEffect, useId, useMemo, useState } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { Modal } from "../../components/Modal";
import {
  DIRECTION_LABEL,
  fieldHintKey,
  fieldLabelKey,
  PROBLEM_MESSAGE,
  problemParams,
  suggestFileName,
  WIZARD_DESCRIPTION,
  WIZARD_NAME,
} from "./wizard-ui";

/** Delai entre la derniere frappe et la verification du script produit. */
const CHECK_DELAY_MS = 150;

type Check =
  | { readonly status: "pending" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly diagnostics: readonly ParseDiagnostic[] };

/** Le dernier script verifie et ce que la verification en a dit (`null` : elle a echoue). */
interface Checked {
  readonly source: string;
  readonly diagnostics: readonly ParseDiagnostic[] | null;
}

type Edits = Readonly<Partial<Record<WizardId, Readonly<Record<string, string>>>>>;

/** Champs sur toute la largeur du formulaire ; les autres (carte, nombres, sprite, orientation) se placent deux par ligne. */
const isWide = (field: WizardField): boolean => field.kind === "text" || field.kind === "longText" || field.kind === "items";

/**
 * Assistant de NPC (RF-017) : un formulaire par type de NPC, le script produit en direct, sa verification locale, puis trois
 * sorties explicites : copier, ajouter au fichier ouvert ou creer un fichier. Dans les deux derniers cas le contenu reste "modifie" :
 * l'enregistrement est une action distincte (Ctrl+S).
 */
export function NpcWizardDialog({ wizard: initial }: { readonly wizard: WizardId }) {
  const controller = useController();
  const t = useT();
  const language = useAppState((state) => state.language);
  const family = useAppState((state) => state.project?.config.emulator.family ?? null);
  const tree = useAppState((state) => state.project?.tree ?? null);
  const activePath = useAppState((state) => state.activePath);
  const idBase = useId();

  const available = useMemo(() => wizardsFor(family), [family]);
  const [selected, setSelected] = useState<WizardId>(initial);
  const current = available.find((candidate) => candidate.id === selected) ?? available[0];
  const [edits, setEdits] = useState<Edits>({});
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<"exists" | "invalid" | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);

  const currentId = current?.id;
  const defaults = useMemo(() => (currentId === undefined ? {} : initialValues(currentId)), [currentId]);
  const values = currentId === undefined ? defaults : (edits[currentId] ?? defaults);
  const result = useMemo(() => (currentId === undefined ? null : runWizard(currentId, values)), [currentId, values]);
  const source = result?.source ?? null;

  // Verification locale du script produit, apres une courte pause de la saisie ; un resultat perime est ecarte.
  useEffect(() => {
    if (source === null) return undefined; // pas de script, pas de verification : la section est masquee
    let cancelled = false;
    const timer = setTimeout(() => {
      void controller.previewWizardDiagnostics(source).then((diagnostics) => {
        if (!cancelled) setChecked({ source, diagnostics });
      });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [controller, source]);

  // « En cours » tant que la derniere verification n'est pas celle du script affiche.
  const check = useMemo<Check>(() => {
    if (checked === null || checked.source !== source) return { status: "pending" };
    return checked.diagnostics === null ? { status: "failed" } : { status: "ready", diagnostics: checked.diagnostics };
  }, [checked, source]);

  const close = (): void => controller.closeDialog();

  if (current === undefined || result === null) {
    return (
      <Modal
        title={t("wizard.title")}
        onDismiss={close}
        actions={
          <button type="button" className="button button-primary" data-autofocus onClick={close}>
            {t("dialog.close")}
          </button>
        }
      >
        <p role="status">{t("wizard.none", { family: family ?? "?" })}</p>
      </Modal>
    );
  }

  const tabId = (id: WizardId): string => `${idBase}-tab-${id}`;
  const panelId = `${idBase}-panel`;
  const problemsOf = (key: string): WizardProblem[] => result.problems.filter((problem) => problem.field === key);
  const path = fileName ?? suggestFileName(values["name"] ?? "", activePath, tree);

  const edit = (key: string, value: string): void => setEdits((previous) => ({ ...previous, [current.id]: { ...(previous[current.id] ?? defaults), [key]: value } }));

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = available.findIndex((candidate) => candidate.id === current.id);
    const target =
      event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    const next = available[target];
    if (next !== undefined) {
      setSelected(next.id);
      requestAnimationFrame(() => document.getElementById(tabId(next.id))?.focus());
    }
  };

  const create = async (): Promise<void> => {
    if (source === null || busy) return;
    setBusy(true);
    const outcome = await controller.createWizardFile(path, source);
    if (outcome !== "created") {
      setFileError(outcome);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("wizard.title")}
      wide
      onDismiss={close}
      actions={
        <>
          <button type="button" className="button" onClick={close}>
            {t("dialog.close")}
          </button>
          <button type="button" className="button" disabled={source === null} onClick={() => source !== null && void controller.copyWizardScript(source)}>
            {t("wizard.action.copy")}
          </button>
          <button type="button" className="button" disabled={source === null || path.trim() === ""} aria-disabled={busy} onClick={() => void create()}>
            {t("wizard.action.create")}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={source === null || activePath === null}
            aria-describedby={`${idBase}-target`}
            onClick={() => source !== null && controller.insertWizardScript(source)}
          >
            {t("wizard.action.insert")}
          </button>
        </>
      }
    >
      <p className="hint">{t("wizard.intro")}</p>
      <div className="wizard-tabs" role="tablist" aria-label={t("wizard.list")} onKeyDown={onTabKeyDown}>
        {available.map((candidate) => (
          <button
            key={candidate.id}
            id={tabId(candidate.id)}
            type="button"
            role="tab"
            aria-selected={candidate.id === current.id}
            aria-controls={panelId}
            tabIndex={candidate.id === current.id ? 0 : -1}
            className={`wizard-tab${candidate.id === current.id ? " active" : ""}`}
            onClick={() => setSelected(candidate.id)}
          >
            {t(WIZARD_NAME[candidate.id])}
          </button>
        ))}
      </div>
      <div id={panelId} className="wizard" role="tabpanel" aria-labelledby={tabId(current.id)}>
        <p className="hint">{t(WIZARD_DESCRIPTION[current.id])}</p>
        <div className="wizard-columns">
          <div className="wizard-fields">
            {current.fields.map((field, index) => {
              const id = `${idBase}-${field.key}`;
              const problems = problemsOf(field.key);
              const labelKey = fieldLabelKey(field.key);
              const hintKey = fieldHintKey(field.key);
              const hasError = problems.some((problem) => problem.severity === "error");
              const describedBy = [hintKey === undefined ? null : `${id}-hint`, `${id}-problems`].filter((part) => part !== null).join(" ");
              const common = {
                id,
                value: values[field.key] ?? "",
                "aria-invalid": hasError,
                "aria-required": field.required,
                "aria-describedby": describedBy,
                ...(index === 0 ? { "data-autofocus": true } : {}),
              };
              return (
                <div key={field.key} className={`field${isWide(field) ? " wizard-wide" : ""}`}>
                  <label htmlFor={id}>{labelKey === undefined ? field.key : t(labelKey)}</label>
                  {field.kind === "direction" ? (
                    <select {...common} onChange={(event) => edit(field.key, event.target.value)}>
                      {DIRECTION_LABEL.map((label, direction) => (
                        <option key={label} value={String(direction)}>
                          {t(label)}
                        </option>
                      ))}
                    </select>
                  ) : field.kind === "items" ? (
                    <textarea {...common} rows={5} spellCheck={false} onChange={(event) => edit(field.key, event.target.value)} />
                  ) : (
                    <input
                      {...common}
                      type="text"
                      spellCheck={false}
                      autoComplete="off"
                      {...(field.kind === "integer" ? { inputMode: "numeric" as const } : {})}
                      onChange={(event) => edit(field.key, event.target.value)}
                    />
                  )}
                  {hintKey !== undefined && (
                    <p id={`${id}-hint`} className="hint">
                      {t(hintKey)}
                    </p>
                  )}
                  <div id={`${id}-problems`} aria-live="polite">
                    {problems.map((problem, position) => (
                      <p key={`${problem.code}:${position}`} className={problem.severity === "error" ? "field-error" : "field-warning"}>
                        <strong>{t(problem.severity === "error" ? "wizard.severity.error" : "wizard.severity.warning")}</strong>{" "}
                        {t(PROBLEM_MESSAGE[problem.code], problemParams(problem, language))}
                      </p>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="wizard-output">
            <h3>{t("wizard.preview.title")}</h3>
            {source === null ? (
              <p className="hint" role="status">
                {t("wizard.preview.blocked")}
              </p>
            ) : (
              <pre className="wizard-preview" role="region" aria-label={t("wizard.preview.label")} tabIndex={0}>
                {source}
              </pre>
            )}
            <CheckSection check={check} source={source} />
            <div className="field">
              <label htmlFor={`${idBase}-file`}>{t("wizard.file.label")}</label>
              <input
                id={`${idBase}-file`}
                type="text"
                value={path}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={fileError !== null}
                aria-describedby={`${idBase}-file-hint ${idBase}-file-error`}
                onChange={(event) => {
                  setFileName(event.target.value);
                  setFileError(null);
                }}
              />
              <p id={`${idBase}-file-hint`} className="hint">
                {t("wizard.file.hint")}
              </p>
              <div id={`${idBase}-file-error`} aria-live="polite">
                {fileError !== null && <p className="field-error">{fileError === "exists" ? t("wizard.file.exists") : t("wizard.file.invalid")}</p>}
              </div>
            </div>
            <p id={`${idBase}-target`} className="hint">
              {activePath === null ? t("wizard.noDocument") : t("wizard.target", { name: activePath })}
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Resultat de l'analyse locale du script produit (le meme service que l'editeur, sans rien indexer). */
function CheckSection({ check, source }: { readonly check: Check; readonly source: string | null }) {
  const t = useT();
  const headingId = useId();
  const language = useAppState((state) => state.language);
  const rows = useMemo(() => {
    if (check.status !== "ready" || source === null) return [];
    const index = new LineIndex(source);
    return check.diagnostics.map((diagnostic) => ({ diagnostic, line: index.positionAt(diagnostic.range.start).line + 1 }));
  }, [check, source]);
  if (source === null) return null;
  return (
    <section className="wizard-check" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("wizard.check.title")}</h3>
      <div aria-live="polite">
        {check.status === "pending" && <p className="hint">{t("wizard.check.pending")}</p>}
        {check.status === "failed" && <p className="field-warning">{t("wizard.check.failed")}</p>}
        {check.status === "ready" && rows.length === 0 && <p className="wizard-check-ok">{t("wizard.check.ok")}</p>}
        {check.status === "ready" && rows.length > 0 && <p>{t("wizard.check.count", { count: rows.length })}</p>}
      </div>
      {rows.length > 0 && (
        <ul className="wizard-diagnostics">
          {rows.map(({ diagnostic, line }, position) => {
            const text = describeDiagnostic(diagnostic, language);
            return (
              <li key={`${diagnostic.code}:${diagnostic.range.start}:${position}`} className={`wizard-diagnostic wizard-diagnostic-${diagnostic.severity}`}>
                <strong>{t(diagnostic.severity === "error" ? "wizard.severity.error" : diagnostic.severity === "warning" ? "wizard.severity.warning" : "wizard.severity.info")}</strong>{" "}
                {text.message}
                <span className="hint">
                  {" "}
                  {diagnostic.code} · {t("wizard.check.line", { line })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">{t("wizard.check.note")}</p>
    </section>
  );
}
