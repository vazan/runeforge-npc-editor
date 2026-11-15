import { useAppState, useController, useT } from "../../app/context";
import { shortBranch } from "../../app/git-text";
import { describeServer } from "../../app/server-status";
import { Icon } from "../../components/Icon";

export function StatusBar() {
  const controller = useController();
  const t = useT();
  const project = useAppState((state) => state.project);
  const emulator = useAppState((state) => state.emulator);
  const server =
    project === null ? null : describeServer(emulator, project.config.emulator.family === "rathena" ? "rAthena" : "Hercules", t);
  const activePath = useAppState((state) => state.activePath);
  const doc = useAppState((state) => (state.activePath === null ? undefined : state.docs[state.activePath]));
  const cursor = useAppState((state) => state.cursor);
  const diagnostics = useAppState((state) => state.diagnostics);
  const tabs = useAppState((state) => state.tabs);
  const indexing = useAppState((state) => state.indexing);
  const git = useAppState((state) => state.git);

  let errors = 0;
  let warnings = 0;
  for (const path of tabs) {
    for (const diagnostic of diagnostics[path]?.diagnostics ?? []) {
      if (diagnostic.severity === "error") errors += 1;
      else if (diagnostic.severity === "warning") warnings += 1;
    }
  }

  const encoding = doc === undefined ? null : doc.warnings.some((warning) => warning.code === "legacy-encoding-assumed") ? t("status.legacyEncoding", { encoding: doc.encoding }) : doc.encoding;
  const eol = doc === undefined ? null : doc.eol === "mixed" ? t("status.mixedEol") : doc.eol;

  return (
    <footer className="statusbar" role="contentinfo">
      <div className="status-group">
        <span className="status-item" title={project?.root.displayPath}>
          {project === null ? t("status.noProject") : project.name}
        </span>
        {project !== null && (
          <span className="status-item" title={t("status.profile")}>
            {project.config.emulator.family === "rathena" ? "rAthena" : "Hercules"} · {project.config.emulator.version}
          </span>
        )}
        {server !== null && (
          <button
            type="button"
            className="status-item status-button status-server"
            data-server-status={emulator.status}
            data-attention={server.attention}
            title={server.title === "" ? undefined : server.title}
            onClick={() => controller.openSettings("project")}
          >
            {server.text}
          </button>
        )}
        {project !== null && indexing.status !== "idle" && (
          <span
            className="status-item status-index"
            data-index-status={indexing.status}
            title={
              indexing.status === "done"
                ? t("status.indexed", { files: indexing.files, functions: indexing.functions, npcs: indexing.npcs }) +
                  (indexing.skipped > 0 ? t("status.indexSkipped", { skipped: indexing.skipped }) : "")
                : undefined
            }
          >
            {indexing.status === "running"
              ? t("status.indexing", { done: indexing.done, total: indexing.total })
              : indexing.status === "error"
                ? t("status.indexFailed")
                : t("status.indexedShort", { files: indexing.files })}
          </span>
        )}
        {project !== null && git.status === "ready" && (
          <button type="button" className="status-item status-button status-git" title={t("status.gitTitle")} onClick={() => controller.showGit()}>
            {git.data.entries.length === 0
              ? t("status.git", { branch: shortBranch(git.data) })
              : t("status.gitChanges", { branch: shortBranch(git.data), count: git.data.entries.length })}
          </button>
        )}
        <button type="button" className="status-item status-button" onClick={() => controller.toggleBottomPanel()} title={t("status.problems")}>
          <Icon name="error" size={13} /> {errors} <Icon name="warning" size={13} /> {warnings}
        </button>
      </div>
      <div className="status-group">
        {activePath !== null && cursor !== null && <span className="status-item">{t("status.line", { line: cursor.line, column: cursor.column })}</span>}
        {encoding !== null && (
          <span className="status-item" title={t("status.encoding")}>
            {encoding}
            {doc?.bom === true ? " BOM" : ""}
          </span>
        )}
        {eol !== null && (
          <span className="status-item" title={t("status.eol")}>
            {eol}
          </span>
        )}
        {doc !== undefined && <span className="status-item">{doc.dirty ? t("status.modified") : t("status.saved")}</span>}
      </div>
    </footer>
  );
}
