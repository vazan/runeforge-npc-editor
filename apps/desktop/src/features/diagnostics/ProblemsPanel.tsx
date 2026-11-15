import { describeDiagnostic, type ParseDiagnostic } from "@runeforge/runescript-core";
import { useMemo } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { Icon, type IconName } from "../../components/Icon";

const SEVERITY_ICON: Record<ParseDiagnostic["severity"], IconName> = { error: "error", warning: "warning", info: "info" };
const SEVERITY_ORDER: Record<ParseDiagnostic["severity"], number> = { error: 0, warning: 1, info: 2 };

interface Row {
  readonly path: string;
  readonly diagnostic: ParseDiagnostic;
}

/** Liste des diagnostics des fichiers ouverts, avec niveau de confiance et conseil de correction. */
export function ProblemsPanel() {
  const controller = useController();
  const t = useT();
  const language = useAppState((state) => state.language);
  const diagnostics = useAppState((state) => state.diagnostics);
  const tabs = useAppState((state) => state.tabs);

  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [];
    for (const path of tabs) {
      for (const diagnostic of diagnostics[path]?.diagnostics ?? []) all.push({ path, diagnostic });
    }
    return all.sort(
      (a, b) =>
        SEVERITY_ORDER[a.diagnostic.severity] - SEVERITY_ORDER[b.diagnostic.severity] ||
        a.path.localeCompare(b.path) ||
        a.diagnostic.range.start - b.diagnostic.range.start,
    );
  }, [diagnostics, tabs]);

  const truncated = tabs.some((path) => diagnostics[path]?.truncated === true);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const row of rows) counts[row.diagnostic.severity] += 1;

  return (
    <section className="problems" aria-label={t("problems.title")}>
      <header className="problems-header">
        <h2>{t("problems.title")}</h2>
        <span className="problems-count">
          {t("problems.errors", { count: counts.error })} · {t("problems.warnings", { count: counts.warning })} · {t("problems.infos", { count: counts.info })}
        </span>
        <span className="problems-disclaimer">{t("problems.disclaimer")}</span>
        <button type="button" className="button button-small report-link" onClick={() => controller.showProjectReport()}>
          {t("report.title")}
        </button>
      </header>
      {truncated && <p className="problems-note">{t("problems.truncated")}</p>}
      {rows.length === 0 ? (
        <p className="problems-empty">{t("problems.none")}</p>
      ) : (
        <ul className="problems-list">
          {rows.map(({ path, diagnostic }, index) => {
            const text = describeDiagnostic(diagnostic, language);
            const position = controller.positionOf(path, diagnostic.range.start);
            return (
              <li key={`${path}:${diagnostic.code}:${diagnostic.range.start}:${index}`}>
                <button type="button" className={`problem problem-${diagnostic.severity}`} onClick={() => void controller.revealPosition(path, position.line, position.column)}>
                  <Icon name={SEVERITY_ICON[diagnostic.severity]} size={15} />
                  <span className="problem-message">{text.message}</span>
                  <span className="problem-meta">
                    {diagnostic.code} · {t(`problems.confidence.${diagnostic.confidence}`)} · {path}:{position.line}:{position.column}
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
    </section>
  );
}
