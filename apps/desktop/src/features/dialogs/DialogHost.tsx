import { useEffect, useRef, useState } from "react";
import { useAppState, useController, useServices, useT } from "../../app/context";
import { GIT_UNAVAILABLE_MESSAGE } from "../../app/git-text";
import { Modal } from "../../components/Modal";
import type { HistoryEntry } from "../../services/types";
import type { DialogRequest, GitUnavailable } from "../../state/store";
import { DeployDialog } from "../deploy/DeployDialog";
import { SftpDialog } from "../remote/SftpDialog";
import { SettingsDialog } from "../settings/SettingsDialog";
import { SimulationDialog } from "../simulation/SimulationDialog";
import { NpcPromptGeneratorDialog } from "../simulation/NpcPromptGeneratorDialog";
import { NpcWizardDialog } from "../wizards/NpcWizardDialog";
import { VisualDialog } from "../visual/VisualDialog";
import { VisualBuilderDialog } from "../visual/VisualBuilderDialog";

const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function UnsavedDialog({ path }: { readonly path: string }) {
  const controller = useController();
  const t = useT();
  return (
    <Modal
      title={t("unsaved.title")}
      onDismiss={() => void controller.resolveUnsaved(path, "cancel")}
      actions={
        <>
          <button type="button" className="button" onClick={() => void controller.resolveUnsaved(path, "cancel")}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="button" onClick={() => void controller.resolveUnsaved(path, "discard")}>
            {t("dialog.discard")}
          </button>
          <button type="button" className="button button-primary" data-autofocus onClick={() => void controller.resolveUnsaved(path, "save")}>
            {t("dialog.save")}
          </button>
        </>
      }
    >
      <p>{t("unsaved.body", { name: name(path) })}</p>
    </Modal>
  );
}

function ExitDialog({ paths }: { readonly paths: readonly string[] }) {
  const controller = useController();
  const t = useT();
  return (
    <Modal
      title={t("exit.title")}
      onDismiss={() => void controller.resolveExit("cancel")}
      actions={
        <>
          <button type="button" className="button" onClick={() => void controller.resolveExit("cancel")}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="button" onClick={() => void controller.resolveExit("discard")}>
            {t("dialog.discardAll")}
          </button>
          <button type="button" className="button button-primary" data-autofocus onClick={() => void controller.resolveExit("save")}>
            {t("dialog.saveAll")}
          </button>
        </>
      }
    >
      <p>{t("exit.body", { count: paths.length })}</p>
      <ul className="modal-list" aria-label={t("exit.list")}>
        {paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </Modal>
  );
}

function ConflictDialog({ path, deleted }: { readonly path: string; readonly deleted: boolean }) {
  const controller = useController();
  const t = useT();
  return (
    <Modal
      title={t("conflict.title")}
      onDismiss={() => void controller.resolveConflict(path, "cancel")}
      actions={
        <>
          <button type="button" className="button" data-autofocus onClick={() => void controller.resolveConflict(path, "cancel")}>
            {t("dialog.cancel")}
          </button>
          {!deleted && (
            <>
              <button type="button" className="button" onClick={() => void controller.resolveConflict(path, "compare")}>
                {t("conflict.compare")}
              </button>
              <button type="button" className="button" onClick={() => void controller.resolveConflict(path, "reload")}>
                {t("conflict.reload")}
              </button>
            </>
          )}
          <button type="button" className="button button-danger" onClick={() => void controller.resolveConflict(path, "overwrite")}>
            {deleted ? t("conflict.recreate") : t("conflict.overwrite")}
          </button>
        </>
      }
    >
      <p>{deleted ? t("conflict.deletedBody", { name: name(path) }) : t("conflict.body", { name: name(path) })}</p>
    </Modal>
  );
}

function UnencodableDialog({ path, chars, encoding }: { readonly path: string; readonly chars: readonly string[]; readonly encoding: string }) {
  const controller = useController();
  const t = useT();
  return (
    <Modal
      title={t("unencodable.title")}
      onDismiss={() => void controller.resolveUnencodable(path, "edit")}
      actions={
        <>
          <button type="button" className="button" data-autofocus onClick={() => void controller.resolveUnencodable(path, "edit")}>
            {t("unencodable.edit")}
          </button>
          <button type="button" className="button button-primary" onClick={() => void controller.resolveUnencodable(path, "convert")}>
            {t("unencodable.convert")}
          </button>
        </>
      }
    >
      <p>{t("unencodable.body", { name: name(path), encoding, chars: chars.join(" ") })}</p>
    </Modal>
  );
}

function RecoveryDialog({ items }: { readonly items: Extract<DialogRequest, { kind: "recovery" }>["items"] }) {
  const controller = useController();
  const t = useT();
  const language = useAppState((state) => state.language);
  const format = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" });
  return (
    <Modal
      title={t("recovery.title")}
      wide
      actions={
        <>
          <button type="button" className="button" onClick={() => void controller.resolveAllRecovery("discard")}>
            {t("recovery.discardAll")}
          </button>
          <button type="button" className="button button-primary" data-autofocus onClick={() => void controller.resolveAllRecovery("restore")}>
            {t("recovery.restoreAll")}
          </button>
        </>
      }
    >
      <p>{t("recovery.body")}</p>
      <ul className="recovery-list">
        {items.map((item) => (
          <li key={item.path}>
            <div>
              <strong>{item.path}</strong>
              <span className="hint">{t("recovery.savedAt", { date: format.format(new Date(item.savedAtMs)) })}</span>
            </div>
            <div className="recovery-actions">
              <button type="button" className="button button-small" onClick={() => void controller.restoreRecovered(item.path)}>
                {t("recovery.restore")}
              </button>
              <button type="button" className="button button-small" onClick={() => void controller.discardRecovered(item.path)}>
                {t("recovery.discard")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function NewFileDialog({ directory, error }: { readonly directory: string; readonly error?: "exists" | "invalid" | undefined }) {
  const controller = useController();
  const t = useT();
  const [value, setValue] = useState(directory === "" ? "" : `${directory}/`);
  const submit = (): void => void controller.createFile(value);
  return (
    <Modal
      title={t("file.new.title")}
      onDismiss={() => controller.closeDialog()}
      actions={
        <>
          <button type="button" className="button" onClick={() => controller.closeDialog()}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="button button-primary" disabled={value.trim() === ""} onClick={submit}>
            {t("dialog.create")}
          </button>
        </>
      }
    >
      <label className="field">
        {t("file.new.name")}
        <input
          data-autofocus
          type="text"
          value={value}
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby="new-file-hint"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && value.trim() !== "" && submit()}
        />
      </label>
      <p id="new-file-hint" className="hint">
        {t("file.new.hint")}
      </p>
      {error !== undefined && (
        <p className="field-error" role="alert">
          {error === "exists" ? t("file.new.error.exists") : t("file.new.error.invalid")}
        </p>
      )}
    </Modal>
  );
}

/** Comparaison d'un document avec le disque, une version de l'historique local ou, apres accord de l'utilisateur, sa version de `HEAD` (Git). */
function DiffDialog({ path, initialSource }: { readonly path: string; readonly initialSource: "disk" | "git" }) {
  const controller = useController();
  const t = useT();
  const { surfaces } = useServices();
  const Diff = surfaces.Diff;
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const [source, setSource] = useState<string>(initialSource);
  // La derniere version chargee, avec la source dont elle vient ; `note` : ce que Git a repondu quand ce n'est pas un texte (fichier absent
  // de HEAD, ou la raison pour laquelle il n'a pas pu etre lu).
  const [loaded, setLoaded] = useState<{ readonly source: string; readonly text: string; readonly note: "new" | GitUnavailable | null } | null>(null);
  const gitReady = useAppState((state) => state.git.status === "ready");
  const language = useAppState((state) => state.language);
  const current = controller.currentText(path) ?? "";
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void controller.historyEntries(path).then((entries) => mounted.current && setHistory(entries));
    return () => {
      mounted.current = false;
    };
  }, [controller, path]);

  useEffect(() => {
    let cancelled = false;
    if (source === "git") {
      void controller.loadGitHeadText(path).then((result) => {
        if (!cancelled) setLoaded({ source, text: result.kind === "text" ? result.text : "", note: result.kind === "new" ? "new" : result.kind === "error" ? result.reason : null });
      });
    } else {
      const load = source === "disk" ? controller.loadDiskText(path) : controller.loadHistoryText(path, source);
      void load.then((text) => !cancelled && setLoaded({ source, text: text ?? "", note: null }));
    }
    return () => {
      cancelled = true;
    };
  }, [controller, path, source]);
  // Ce qui est affiche est toujours celui de la source choisie : le temps d'un changement de source, rien (et non l'ancienne version).
  const other = loaded !== null && loaded.source === source ? loaded.text : null;
  const gitNote = loaded !== null && loaded.source === source ? loaded.note : null;

  const format = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });
  return (
    <Modal
      title={`${t("diff.title")} — ${name(path)}`}
      wide
      onDismiss={() => controller.closeDialog()}
      actions={
        <button type="button" className="button button-primary" data-autofocus onClick={() => controller.closeDialog()}>
          {t("dialog.close")}
        </button>
      }
    >
      <label className="field field-inline">
        {t("diff.history")}
        <select value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="disk">{t("diff.disk")}</option>
          {(gitReady || source === "git") && <option value="git">{t("diff.git")}</option>}
          {history.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {format.format(new Date(entry.savedAtMs))}
            </option>
          ))}
        </select>
      </label>
      {history.length === 0 && source !== "git" && <p className="hint">{t("diff.noHistory")}</p>}
      {source === "git" && gitNote !== null && (
        <p className="hint" role="status">
          {gitNote === "new" ? t("diff.gitNew") : t("diff.gitError", { reason: t(GIT_UNAVAILABLE_MESSAGE[gitNote]) })}
        </p>
      )}
      <div className="diff-surface">
        {other !== null && (
          <Diff original={other} modified={current} originalLabel={source === "disk" ? t("diff.disk") : source === "git" ? t("diff.git") : t("diff.history")} modifiedLabel={t("diff.mine")} />
        )}
      </div>
    </Modal>
  );
}

/** Demande l'accord de l'utilisateur pour lancer `git` dans ce projet : rien n'est lance avant sa reponse (DEC-039). */
function GitTrustDialog() {
  const controller = useController();
  const t = useT();
  return (
    <Modal
      title={t("git.trust.title")}
      onDismiss={() => controller.closeDialog()}
      actions={
        <>
          <button type="button" className="button" data-autofocus onClick={() => controller.closeDialog()}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="button button-primary" onClick={() => void controller.confirmGitTrust()}>
            {t("git.trust.confirm")}
          </button>
        </>
      }
    >
      <p>{t("git.trust.body")}</p>
      <p className="hint">{t("git.trust.warning")}</p>
    </Modal>
  );
}

/** Affiche le dialogue modal courant (les suivants attendent dans la file). */
export function DialogHost() {
  const dialog = useAppState((state) => state.dialog);
  if (dialog === null) return null;
  switch (dialog.kind) {
    case "unsaved-close":
      return <UnsavedDialog path={dialog.path} />;
    case "exit":
      return <ExitDialog paths={dialog.paths} />;
    case "conflict":
      return <ConflictDialog path={dialog.path} deleted={dialog.deleted} />;
    case "unencodable":
      return <UnencodableDialog path={dialog.path} chars={dialog.chars} encoding={dialog.encoding} />;
    case "recovery":
      return <RecoveryDialog items={dialog.items} />;
    case "new-file":
      return <NewFileDialog directory={dialog.directory} error={dialog.error} />;
    case "settings":
      return <SettingsDialog tab={dialog.tab} />;
    case "diff":
      return <DiffDialog path={dialog.path} initialSource={dialog.source ?? "disk"} />;
    case "git-trust":
      return <GitTrustDialog />;
    case "deploy":
      return <DeployDialog />;
    case "sftp":
      return <SftpDialog />;
    case "npc-wizard":
      return <NpcWizardDialog wizard={dialog.wizard} />;
    case "visual":
      return <VisualDialog path={dialog.path} declarationStart={dialog.declarationStart} baseText={dialog.baseText} />;
    case "visual-builder":
      return <VisualBuilderDialog />;
    case "npc-ai-generator":
      return <NpcPromptGeneratorDialog />;
    case "simulation":
      return <SimulationDialog source={dialog.source} declarationStart={dialog.declarationStart} />;
  }
}
