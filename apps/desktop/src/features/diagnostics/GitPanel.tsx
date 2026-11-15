import { useAppState, useController, useT } from "../../app/context";
import { branchSummary, GIT_KIND_MESSAGE, GIT_LETTER, GIT_UNAVAILABLE_MESSAGE, gitKind, isOnDisk, isStaged } from "../../app/git-text";

const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Onglet Git du panneau du bas (RF-019) : la branche et les fichiers modifies depuis `HEAD`, en lecture seule. Un clic ouvre le fichier,
 * « Comparer » l'ouvre en regard de sa version de `HEAD`. Rien n'est lance tant que l'utilisateur n'a pas autorise Git pour le projet.
 */
export function GitPanel() {
  const controller = useController();
  const t = useT();
  const git = useAppState((state) => state.git);
  const data = git.status === "ready" || git.status === "loading" ? git.data : null;
  const summary = data === null ? null : branchSummary(data);

  return (
    <section className="problems git" aria-label={t("git.title")}>
      <header className="problems-header">
        <h2>{t("git.title")}</h2>
        {data !== null && summary !== null && (
          <span className="problems-count">
            {t(summary.key, summary.params)} · {t("git.count", { count: data.entries.length })}
          </span>
        )}
        <span className="problems-disclaimer">{t("git.readOnly")}</span>
        <button
          type="button"
          className="button button-small report-link"
          aria-disabled={git.status === "loading"}
          onClick={() => git.status !== "loading" && void controller.refreshGit({ ask: true })}
        >
          {t("git.refresh")}
        </button>
      </header>
      {git.status === "unavailable" && (
        <div className="problems-note" role="status">
          <p>{t(GIT_UNAVAILABLE_MESSAGE[git.reason])}</p>
          {git.reason === "not_trusted" && (
            <button type="button" className="button button-small" onClick={() => controller.requestGitTrust()}>
              {t("git.enable")}
            </button>
          )}
        </div>
      )}
      {(git.status === "off" || (git.status === "loading" && data === null)) && (
        <p className="problems-empty" role="status">
          {t("git.refreshing")}
        </p>
      )}
      {data !== null && data.entries.length === 0 && git.status === "ready" && <p className="problems-empty">{t("git.clean")}</p>}
      {data !== null && data.entries.length > 0 && (
        <ul className="problems-list" aria-label={t("git.list")} aria-busy={git.status === "loading"}>
          {data.entries.map((entry) => {
            const kind = gitKind(entry);
            const onDisk = isOnDisk(entry);
            const kindText = t(GIT_KIND_MESSAGE[kind]);
            return (
              <li key={entry.path} className="git-row">
                <button type="button" className="problem git-open" disabled={!onDisk} onClick={() => void controller.openFile(entry.path)}>
                  <span className={`git-badge git-badge-${kind}`} aria-hidden="true">
                    {GIT_LETTER[kind]}
                  </span>
                  <span className="problem-message">{entry.path}</span>{" "}
                  <span className="problem-meta">
                    {kindText}
                    {isStaged(entry) ? ` · ${t("git.staged")}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="button button-small"
                  disabled={!onDisk}
                  aria-label={t("git.compareFile", { name: lastSegment(entry.path) })}
                  onClick={() => void controller.compareWithGit(entry.path)}
                >
                  {t("git.compare")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {data !== null && data.truncated && <p className="problems-note">{t("git.truncated", { count: data.entries.length })}</p>}
    </section>
  );
}
