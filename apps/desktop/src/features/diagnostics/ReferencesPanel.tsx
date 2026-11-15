import { useAppState, useController, useT } from "../../app/context";
import { MAX_REFERENCES } from "../../state/store";

/** Resultats de « Rechercher toutes les references » : une ligne de code par resultat, ouverte au clic. */
export function ReferencesPanel() {
  const controller = useController();
  const t = useT();
  const result = useAppState((state) => state.references);

  if (result === null) {
    return (
      <section className="references" aria-label={t("references.title")}>
        <p className="problems-empty">{t("references.none")}</p>
      </section>
    );
  }
  if (result.status === "loading") {
    return (
      <section className="references" aria-label={t("references.title")} aria-busy="true">
        <p className="problems-empty" role="status">
          {t("references.loading")}
        </p>
      </section>
    );
  }
  const count = result.items.length;
  return (
    <section className="references" aria-label={t("references.title")}>
      <header className="problems-header">
        <h2>{t("references.title")}</h2>
        <span className="problems-count">
          {result.name === "" ? t("references.countNoName", { count }) : t("references.count", { count, name: result.name })}
        </span>
      </header>
      {result.truncated && <p className="problems-note">{t("references.truncated", { limit: MAX_REFERENCES })}</p>}
      {count === 0 ? (
        <p className="problems-empty">{t("references.none")}</p>
      ) : (
        <ul className="problems-list">
          {result.items.map((item, index) => (
            <li key={`${item.uri}:${item.line}:${item.column}:${index}`}>
              <button type="button" className="problem reference" onClick={() => void controller.openReference(item)}>
                <span className="reference-preview">{item.preview === "" ? " " : item.preview}</span>
                <span className="problem-meta">
                  {item.uri}:{item.line}:{item.column}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
