import { findBlockers, type ConflictReason, type DeployReport, type FailureCode, type RollbackFailure, type RollbackReport } from "@runeforge/deploy-core";
import { useId, useMemo, useState } from "react";
import { useAppState, useController, useT } from "../../app/context";
import type { DeployPlanView } from "../../app/controller";
import { MAX_DEPLOY_FILES } from "../../app/deploy-service";
import { Modal } from "../../components/Modal";
import type { MessageKey } from "../../i18n/messages";
import type { ApprovedRoot } from "../../services/types";

type Environment = "development" | "staging" | "production";
const ENVIRONMENTS: readonly Environment[] = ["development", "staging", "production"];
const ENVIRONMENT_LABEL: Readonly<Record<Environment, MessageKey>> = {
  development: "deploy.env.development",
  staging: "deploy.env.staging",
  production: "deploy.env.production",
};
const CONFLICT_MESSAGE: Readonly<Record<ConflictReason, MessageKey>> = {
  "remote-changed": "deploy.conflict.remote-changed",
  "never-deployed": "deploy.conflict.never-deployed",
};
const FAILURE_MESSAGE: Readonly<Record<FailureCode, MessageKey>> = {
  "read-failed": "deploy.failure.read-failed",
  "local-changed": "deploy.failure.local-changed",
  "remote-changed": "deploy.failure.remote-changed",
  "backup-failed": "deploy.failure.backup-failed",
  "write-failed": "deploy.failure.write-failed",
  "verify-failed": "deploy.failure.verify-failed",
};
const ROLLBACK_MESSAGE: Readonly<Record<RollbackFailure, MessageKey>> = {
  "backup-missing": "deploy.restore.failure.backup-missing",
  "changed-since-deploy": "deploy.restore.failure.changed-since-deploy",
  "write-failed": "deploy.restore.failure.write-failed",
  "verify-failed": "deploy.restore.failure.verify-failed",
};

/** Au plus ce nombre de lignes du plan est dessine ; le reste est compte. */
const MAX_ROWS = 300;
/** Au plus ce nombre de fichiers en erreur est nomme dans le message. */
const MAX_NAMED = 5;

const folderName = (displayPath: string): string => displayPath.split(/[\\/]/).filter((part) => part !== "").pop() ?? displayPath;

function formatBytes(bytes: number, language: string): string {
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${number.format(bytes)} B`;
  return bytes < 1024 * 1024 ? `${number.format(bytes / 1024)} KiB` : `${number.format(bytes / (1024 * 1024))} MiB`;
}

/**
 * Deploiement vers un dossier (RF-018) : choisir la destination, preparer le plan (rien n'est ecrit), puis — seulement apres confirmation — copier
 * avec sauvegarde, verification et restauration possible. « Deployer » ne fait que copier : ni les fichiers de chargement du serveur ni son
 * rechargement ne sont touches (CLAUDE.md 14.3).
 */
export function DeployDialog() {
  const controller = useController();
  const t = useT();
  const language = useAppState((state) => state.language);
  const project = useAppState((state) => state.project);
  const idBase = useId();

  const hasNpcFolder = project?.tree.children.some((child) => child.kind === "directory" && child.name === "npc") === true;
  const [destination, setDestination] = useState<ApprovedRoot | null>(null);
  const [destinationError, setDestinationError] = useState(false);
  const [environment, setEnvironment] = useState<Environment>("development");
  const [prefix, setPrefix] = useState(hasNpcFolder ? "npc/custom" : "");
  const [view, setView] = useState<DeployPlanView | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [allowErrors, setAllowErrors] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [phase, setPhase] = useState<"idle" | "planning" | "running" | "restoring">("idle");
  const [progress, setProgress] = useState<{ readonly done: number; readonly total: number } | null>(null);
  const [outcome, setOutcome] = useState<{ readonly stamp: string; readonly report: DeployReport } | null>(null);
  const [restored, setRestored] = useState<RollbackReport | null>(null);

  const plan = view?.preparation.plan ?? null;
  const toSend = plan === null ? 0 : plan.counts.create + plan.counts.update + (overwrite ? plan.counts.conflict : 0);
  const blockers = useMemo(() => (view === null ? [] : findBlockers(view.preparation.plan, view.errorCounts, overwrite)), [view, overwrite]);
  const name = destination === null ? "" : folderName(destination.displayPath);
  const confirmed = environment !== "production" || confirmation.trim() === name;
  const busy = phase !== "idle";
  const ready = view !== null && outcome === null && toSend > 0 && (blockers.length === 0 || allowErrors) && confirmed;
  const last = outcome ?? view?.last ?? null;
  const canRestore = destination !== null && last !== null && last.report.results.some((entry) => entry.status === "updated" || entry.status === "overwritten");

  const invalidate = (): void => {
    setView(null);
    setOutcome(null);
    setRestored(null);
    setOverwrite(false);
    setAllowErrors(false);
    setConfirmation("");
  };

  const choose = async (): Promise<void> => {
    if (busy) return;
    const picked = await controller.pickDeployDestination();
    if (picked === null) return;
    if ("error" in picked) {
      setDestinationError(true);
      return;
    }
    setDestinationError(false);
    setDestination(picked.root);
    invalidate();
  };

  const prepare = async (): Promise<void> => {
    if (destination === null || busy) return;
    setPhase("planning");
    invalidate();
    setView(await controller.prepareDeployment(destination, prefix));
    setPhase("idle");
  };

  const run = async (): Promise<void> => {
    if (destination === null || view === null || busy || !ready) return;
    setPhase("running");
    setProgress({ done: 0, total: view.preparation.plan.actions.length });
    const done = await controller.runDeployment(destination, view, { overwriteConflicts: overwrite, allowErrors, onProgress: (count, total) => setProgress({ done: count, total }) });
    if (done !== null) setOutcome(done);
    setProgress(null);
    setPhase("idle");
  };

  const restore = async (): Promise<void> => {
    if (destination === null || last === null || busy) return;
    setPhase("restoring");
    const result = await controller.rollbackDeployment(destination, last);
    if (result !== null) setRestored(result);
    setPhase("idle");
  };

  const counts = outcome === null ? null : { created: 0, updated: 0, overwritten: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (counts !== null && outcome !== null) for (const entry of outcome.report.results) counts[entry.status] += 1;
  const rows = plan === null ? [] : plan.actions.filter((action) => action.kind !== "unchanged");
  const date = last === null ? null : new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(last.report.finishedAtMs));

  return (
    <Modal
      title={t("deploy.title")}
      wide
      onDismiss={busy ? undefined : () => controller.closeDialog()}
      actions={
        <>
          <button type="button" className="button" aria-disabled={busy} onClick={() => !busy && controller.closeDialog()}>
            {t("dialog.close")}
          </button>
          {canRestore && (
            <button type="button" className="button" aria-disabled={busy} onClick={() => void restore()}>
              {t("deploy.restore")}
            </button>
          )}
          <button type="button" className="button button-primary" aria-disabled={busy || !ready} onClick={() => void run()}>
            {phase === "running" && progress !== null ? t("deploy.running", progress) : t("deploy.run")}
          </button>
        </>
      }
    >
      <p className="hint">{t("deploy.intro")}</p>

      <div className="field">
        <span id={`${idBase}-destination`}>{t("deploy.destination")}</span>
        <div className="deploy-destination">
          <button type="button" className="button" data-autofocus aria-disabled={busy} aria-describedby={`${idBase}-destination ${idBase}-path`} onClick={() => void choose()}>
            {t("deploy.choose")}
          </button>
          <span id={`${idBase}-path`} className="deploy-path" aria-live="polite">
            {destination === null ? t("deploy.noFolder") : destination.displayPath}
          </span>
        </div>
        {destinationError && (
          <p className="field-error" role="alert">
            {t("deploy.sameAsProject")}
          </p>
        )}
      </div>

      <label className="field">
        {t("deploy.environment")}
        <select
          value={environment}
          disabled={busy}
          onChange={(event) => {
            setEnvironment(event.target.value as Environment);
            setConfirmation("");
          }}
        >
          {ENVIRONMENTS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {t(ENVIRONMENT_LABEL[candidate])}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        {t("deploy.prefix")}
        <input
          type="text"
          value={prefix}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${idBase}-prefix-hint`}
          onChange={(event) => {
            setPrefix(event.target.value);
            invalidate();
          }}
        />
      </label>
      <p id={`${idBase}-prefix-hint`} className="hint">
        {t("deploy.prefix.hint")}
      </p>

      <button type="button" className="button" aria-disabled={destination === null || busy} onClick={() => void prepare()}>
        {phase === "planning" ? t("deploy.planning") : t("deploy.plan")}
      </button>

      {view !== null && plan !== null && (
        <section className="deploy-plan" aria-labelledby={`${idBase}-plan`}>
          <h3 id={`${idBase}-plan`}>{t("deploy.planTitle")}</h3>
          <p role="status">
            {toSend === 0 && plan.counts.conflict === 0
              ? t("deploy.nothing")
              : t("deploy.summary", { ...plan.counts, bytes: formatBytes(plan.bytes, language) })}
          </p>
          {date !== null && <p className="hint">{t("deploy.lastAt", { date })}</p>}
          {view.preparation.omitted > 0 && <p className="field-warning">{t("deploy.omitted", { count: view.preparation.omitted, max: MAX_DEPLOY_FILES })}</p>}
          {view.preparation.unreadable.length > 0 && <p className="field-warning">{t("deploy.unreadable", { count: view.preparation.unreadable.length })}</p>}
          {rows.length > 0 && (
            <ul className="deploy-list" aria-label={t("deploy.list")}>
              {rows.slice(0, MAX_ROWS).map((action) => (
                <li key={action.path} className={`deploy-row deploy-row-${action.kind}`}>
                  <strong>{t(action.kind === "create" ? "deploy.kind.create" : action.kind === "update" ? "deploy.kind.update" : "deploy.kind.conflict")}</strong> {action.path}
                  {action.reason !== undefined && <span className="hint"> — {t(CONFLICT_MESSAGE[action.reason])}</span>}
                </li>
              ))}
              {rows.length > MAX_ROWS && <li className="hint">{t("deploy.moreRows", { count: rows.length - MAX_ROWS })}</li>}
            </ul>
          )}
          {plan.counts.conflict > 0 && (
            <label className="check">
              <input type="checkbox" checked={overwrite} disabled={busy || outcome !== null} onChange={(event) => setOverwrite(event.target.checked)} />
              {t("deploy.overwrite")}
            </label>
          )}
          {blockers.length > 0 && (
            <>
              <p className="field-warning">
                {t("deploy.errorsIn", { files: `${blockers.slice(0, MAX_NAMED).join(", ")}${blockers.length > MAX_NAMED ? ` (+${blockers.length - MAX_NAMED})` : ""}` })}
              </p>
              <label className="check">
                <input type="checkbox" checked={allowErrors} disabled={busy || outcome !== null} onChange={(event) => setAllowErrors(event.target.checked)} />
                {t("deploy.allowErrors")}
              </label>
            </>
          )}
          {environment === "production" && toSend > 0 && outcome === null && (
            <label className="field">
              {t("deploy.confirmProduction", { name })}
              <input type="text" value={confirmation} spellCheck={false} autoComplete="off" disabled={busy} onChange={(event) => setConfirmation(event.target.value)} />
            </label>
          )}
        </section>
      )}

      {outcome !== null && counts !== null && (
        <section className="deploy-result" aria-label={t("deploy.title")}>
          <p role="status">{outcome.report.complete ? t("deploy.result.complete", counts) : t("deploy.result.incomplete", counts)}</p>
          {outcome.report.results.some((entry) => entry.status === "failed" || entry.status === "skipped") && (
            <>
              <h3>{t("deploy.failures")}</h3>
              <ul className="deploy-list">
                {outcome.report.results
                  .filter((entry) => entry.status === "failed" || entry.status === "skipped")
                  .slice(0, MAX_ROWS)
                  .map((entry) => (
                    <li key={entry.path}>
                      {entry.path} — {entry.failure !== undefined ? t(FAILURE_MESSAGE[entry.failure]) : t(entry.skippedBecause === "conflict" ? "deploy.skipped.conflict" : "deploy.skipped.stopped")}
                    </li>
                  ))}
              </ul>
            </>
          )}
          <p className="hint">{t("deploy.backups")}</p>
        </section>
      )}

      {phase === "restoring" && <p role="status">{t("deploy.restoring")}</p>}
      {restored !== null && (
        <div role="status" className="deploy-result">
          <p>{t("deploy.restore.done", { restored: restored.restored.length, left: restored.leftInPlace.length })}</p>
          {restored.failed.length > 0 && (
            <p className="field-error">{t("deploy.restore.failed", { files: restored.failed.map((entry) => `${entry.path} (${t(ROLLBACK_MESSAGE[entry.failure])})`).join(", ") })}</p>
          )}
        </div>
      )}

      <p className="hint">{t("deploy.reminder")}</p>
    </Modal>
  );
}
