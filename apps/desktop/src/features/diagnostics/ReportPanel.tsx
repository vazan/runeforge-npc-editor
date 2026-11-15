import { describeDiagnostic, type ParseDiagnostic } from "@runeforge/runescript-core";
import { MAX_REPORT_ITEMS } from "@runeforge/runescript-language-server";
import type { ReportFile, ReportItem } from "@runeforge/runescript-language-server";
import { useMemo, useState } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { formatTimestamp, loadIssueLocation, loadIssueMessage, severityCounts } from "../../app/report-text";
import { Icon, type IconName } from "../../components/Icon";
import type { MessageKey } from "../../i18n/messages";
import { NO_REPORT_SCOPE } from "../../state/store";

type Severity = ParseDiagnostic["severity"];

const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];
const SEVERITY_ICON: Record<Severity, IconName> = { error: "error", warning: "warning", info: "info" };
const SEVERITY_LABEL: Record<Severity, MessageKey> = { error: "problems.errors", warning: "problems.warnings", info: "problems.infos" };
const TOTAL_KEY: Record<Severity, "errors" | "warnings" | "infos"> = { error: "errors", warning: "warnings", info: "infos" };

/** Au plus ce nombre de fichiers est dessine : au-dela, les filtres servent a affiner (le rapport, lui, les contient tous). */
const MAX_FILES_SHOWN = 300;
/** Au plus ce nombre de problemes de chargement du serveur est dessine. */
const MAX_ISSUES_SHOWN = 100;
/** Un rapport qui tient en ce nombre de problemes s'affiche deplie ; un plus gros, replie fichier par fichier. */
const AUTO_EXPAND_MAX_ITEMS = 40;

interface VisibleFile {
  readonly file: ReportFile;
  readonly items: readonly ReportItem[];
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

/**
 * Rapport de projet (RF-015) : les problemes de tous les fichiers indexes, fichier par fichier, les plus graves d'abord,
 * avec des filtres par gravite, par code et par chemin. Un clic ouvre le fichier a la position du probleme.
 */
export function ReportPanel() {
  const controller = useController();
  const t = useT();
  const language = useAppState((state) => state.language);
  const state = useAppState((store) => store.projectReport);
  const indexing = useAppState((store) => store.indexing);
  const loadIssues = useAppState((store) => store.emulator.loadIssueList);
  const [severities, setSeverities] = useState<ReadonlySet<Severity>>(new Set(SEVERITIES));
  const [code, setCode] = useState("");
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());

  // Le rapport que l'on montre est celui que le controleur a calcule pour le choix courant : par defaut, seulement ce que le serveur
  // charge (le reste de l'index est de la documentation, de la configuration...), le service ayant compte ce qu'il a laisse de cote.
  const report = state?.report ?? null;
  const scope = state?.scope ?? NO_REPORT_SCOPE;
  const hideUnloaded = state?.hideUnloaded ?? true;
  const excluded = report?.excluded ?? null;
  // Un code choisi qui n'est plus dans le rapport (autre portee, nouveau calcul) ne filtre plus : la liste ne doit pas devenir vide
  // sans que rien ne l'explique.
  const activeCode = code !== "" && report !== null && report.byCode.some((entry) => entry.code === code) ? code : "";
  const filtering = severities.size < SEVERITIES.length || activeCode !== "" || query.trim() !== "";

  const visible = useMemo<VisibleFile[]>(() => {
    if (report === null) return [];
    const needle = query.trim().toLowerCase();
    const result: VisibleFile[] = [];
    for (const file of report.files) {
      if (needle !== "" && !file.uri.toLowerCase().includes(needle)) continue;
      const items = file.items.filter((item) => severities.has(item.diagnostic.severity) && (activeCode === "" || item.diagnostic.code === activeCode));
      // Le detail d'un fichier n'est coupe que si le rapport a atteint sa limite : ses totaux sont alors les seuls chiffres
      // exacts, mais filtrer ne peut plus les ventiler (on ne compte que les problemes detailles).
      const complete = file.items.length === file.errors + file.warnings + file.infos;
      if (complete ? items.length === 0 : filtering && items.length === 0) continue;
      const counts = complete || filtering ? countOf(items) : file;
      result.push({ file, items, errors: counts.errors, warnings: counts.warnings, infos: counts.infos });
    }
    return result;
  }, [report, severities, activeCode, query, filtering]);

  if (state === null || (report === null && state.status === "loading")) {
    return (
      <section className="report" aria-label={t("report.title")} aria-busy="true">
        <p className="problems-empty" role="status">
          {t("report.loading")}
        </p>
      </section>
    );
  }

  const shownItems = visible.reduce((sum, entry) => sum + entry.items.length, 0);
  const autoExpand = shownItems <= AUTO_EXPAND_MAX_ITEMS;
  const toggle = (uri: string): void => {
    const next = new Map(overrides);
    next.set(uri, !(overrides.get(uri) ?? autoExpand));
    setOverrides(next);
  };
  const toggleSeverity = (severity: Severity): void => {
    const next = new Set(severities);
    if (next.has(severity)) next.delete(severity);
    else next.add(severity);
    setSeverities(next);
  };

  const totals = report?.totals ?? { errors: 0, warnings: 0, infos: 0 };
  const omitted = report === null ? 0 : report.files.reduce((sum, file) => sum + file.errors + file.warnings + file.infos - file.items.length, 0);
  const busy = state.status === "loading";
  const issuesShown = loadIssues.slice(0, MAX_ISSUES_SHOWN);

  return (
    <section className="report" aria-label={t("report.title")} aria-busy={busy}>
      <header className="problems-header">
        <h2>{t("report.title")}</h2>
        {report !== null && (
          <span className="problems-count">
            {t("problems.errors", { count: totals.errors })} · {t("problems.warnings", { count: totals.warnings })} · {t("problems.infos", { count: totals.infos })}
          </span>
        )}
        <span className="report-actions">
          <button type="button" className="button button-small" onClick={() => void controller.refreshProjectReport()} disabled={busy}>
            <Icon name="refresh" size={13} /> {t("report.refresh")}
          </button>
          <button type="button" className="button button-small" onClick={() => void controller.copyProjectReport()} disabled={report === null}>
            {t("report.copy")}
          </button>
        </span>
      </header>

      <p className="problems-note" role="status">
        {report !== null &&
          `${t("report.summary", { examined: report.examined, files: report.files.length })} · ${t("report.computedAt", { time: formatTimestamp(state.generatedAt).slice(11) })} · `}
        {t("problems.disclaimer")}
      </p>
      {state.status === "error" && <p className="problems-note report-warning">{t("report.error")}</p>}
      {state.stale && state.status !== "error" && <p className="problems-note report-warning">{t("report.stale")}</p>}
      {report !== null && !state.complete && <p className="problems-note report-warning">{t("report.partial")}</p>}
      {indexing.status === "running" && <p className="problems-note">{t("report.indexing", { done: indexing.done, total: indexing.total })}</p>}
      {indexing.skipped > 0 && <p className="problems-note">{t("report.skipped", { count: indexing.skipped })}</p>}
      {omitted > 0 && <p className="problems-note">{t("report.itemsOmitted", { count: omitted, limit: MAX_REPORT_ITEMS })}</p>}

      {scope.loaded !== null && scope.notLoaded > 0 && (
        <div className="report-scope">
          <label className="report-check">
            <input type="checkbox" checked={hideUnloaded} onChange={(event) => controller.setReportHideUnloaded(event.target.checked)} />
            {t("report.scope.filter")}
          </label>
          <span className="problems-note report-warning">
            {hideUnloaded && excluded !== null && excluded.files > 0
              ? t("report.scope.hidden", { files: excluded.files, problems: excluded.problems })
              : t("report.scope.available", { count: scope.notLoaded })}
          </span>
          <button type="button" className="button button-small" title={t("report.scope.hint")} onClick={() => controller.openSettings("project")}>
            {t("report.scope.settings")}
          </button>
        </div>
      )}

      {report !== null && report.files.length > 0 && (
        <div className="report-filters" role="group" aria-label={t("report.filter.severity")}>
          {SEVERITIES.map((severity) => (
            <label key={severity} className="report-check">
              <input type="checkbox" checked={severities.has(severity)} onChange={() => toggleSeverity(severity)} />
              <Icon name={SEVERITY_ICON[severity]} size={13} className={`report-severity report-severity-${severity}`} />
              {t(SEVERITY_LABEL[severity], { count: totals[TOTAL_KEY[severity]] })}
            </label>
          ))}
          <label className="report-field">
            {t("report.filter.code")}
            <select value={activeCode} onChange={(event) => setCode(event.target.value)}>
              <option value="">{t("report.filter.allCodes")}</option>
              {report.byCode.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code} ({entry.count})
                </option>
              ))}
            </select>
          </label>
          <label className="report-field">
            {t("report.filter.path")}
            <input type="search" value={query} placeholder={t("report.filter.pathPlaceholder")} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
      )}

      {report !== null && report.examined === 0 && <p className="problems-empty">{t("report.nothing")}</p>}
      {report !== null && report.examined > 0 && report.files.length === 0 && loadIssues.length === 0 && (
        <p className="problems-empty">{t("report.none", { examined: report.examined })}</p>
      )}
      {report !== null && report.files.length > 0 && visible.length === 0 && <p className="problems-empty">{t("report.filter.noMatch")}</p>}

      {visible.length > 0 && (
        <ul className="problems-list report-files">
          {visible.slice(0, MAX_FILES_SHOWN).map((entry) => {
            const open = overrides.get(entry.file.uri) ?? autoExpand;
            return (
              <li key={entry.file.uri} className="report-file">
                <button type="button" className="report-file-toggle" aria-expanded={open} onClick={() => toggle(entry.file.uri)}>
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
                  <span className="report-file-path">{entry.file.uri}</span>
                  <span className="report-file-counts">{severityCounts(entry, language)}</span>
                </button>
                {open && (
                  <ul className="problems-list report-items">
                    {entry.items.map((item, index) => {
                      const text = describeDiagnostic(item.diagnostic, language);
                      return (
                        <li key={`${item.diagnostic.code}:${item.line}:${item.column}:${index}`}>
                          <button
                            type="button"
                            className={`problem problem-${item.diagnostic.severity}`}
                            onClick={() => void controller.revealPosition(entry.file.uri, item.line, item.column)}
                          >
                            <Icon name={SEVERITY_ICON[item.diagnostic.severity]} size={15} />
                            <span className="problem-message">{text.message}</span>
                            <span className="problem-meta">
                              {item.diagnostic.code} · {t(`problems.confidence.${item.diagnostic.confidence}` as MessageKey)} · {entry.file.uri}:{item.line}:{item.column}
                            </span>
                            {text.hint !== undefined && (
                              <span className="problem-hint">
                                {t("problems.fix")} : {text.hint}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {visible.length > MAX_FILES_SHOWN && <p className="problems-note">{t("report.filesHidden", { count: visible.length - MAX_FILES_SHOWN })}</p>}

      {loadIssues.length > 0 && (
        <div className="report-server">
          <h3>{t("report.server.title")}</h3>
          <p className="problems-note">{t("report.server.count", { count: loadIssues.length })}</p>
          <ul className="problems-list">
            {issuesShown.map((issue, index) => {
              const location = loadIssueLocation(issue);
              const body = (
                <>
                  <Icon name="warning" size={15} />
                  <span className="problem-message">{loadIssueMessage(issue, language)}</span>
                  {location !== "" && <span className="problem-meta">{location}</span>}
                </>
              );
              return (
                <li key={`${issue.kind}:${issue.subject}:${issue.line ?? 0}:${index}`}>
                  {issue.file === null ? (
                    <div className="problem problem-warning">{body}</div>
                  ) : (
                    <button type="button" className="problem problem-warning" onClick={() => void controller.revealPosition(issue.file ?? "", issue.line ?? 1, 1)}>
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {loadIssues.length > MAX_ISSUES_SHOWN && <p className="problems-note">{t("report.server.more", { count: loadIssues.length - MAX_ISSUES_SHOWN })}</p>}
        </div>
      )}
    </section>
  );
}

function countOf(items: readonly ReportItem[]): { errors: number; warnings: number; infos: number } {
  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const item of items) {
    if (item.diagnostic.severity === "error") counts.errors += 1;
    else if (item.diagnostic.severity === "warning") counts.warnings += 1;
    else counts.infos += 1;
  }
  return counts;
}
