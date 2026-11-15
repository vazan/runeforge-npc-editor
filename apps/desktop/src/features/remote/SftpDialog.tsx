import { useState } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { Modal } from "../../components/Modal";

interface Digest {
  readonly size: number;
  readonly sha256: string;
}

/** Wire format returned by the existing read-only Rust command. */
interface Preview {
  readonly files: readonly { readonly path: string; readonly local: Digest; readonly remote: Digest | null }[];
}

/** RF-018: comparison only. The native command validates inputs and obtains consent before any network access. */
export function SftpDialog() {
  const controller = useController();
  const t = useT();
  const project = useAppState((state) => state.project);
  const locale = useAppState((state) => state.language);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [hostKey, setHostKey] = useState("");
  const [directory, setDirectory] = useState("");
  const [pathsText, setPathsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<"cancelled" | "failure" | null>(null);
  const paths = pathsText.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  const ready = project !== null && host.trim() !== "" && username.trim() !== "" && hostKey.trim() !== ""
    && directory.startsWith("/") && Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535
    && paths.length > 0 && paths.length <= 100;

  const invalidate = (): void => { setPreview(null); setError(null); };
  const compare = async (): Promise<void> => {
    if (!ready || busy || project === null) return;
    invalidate();
    setBusy(true);
    try {
      // Load Tauri only on the explicit action; opening or editing the dialog never connects.
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<Preview>("sftp_dry_run", {
        rootId: project.root.id, locale, paths,
        target: { host: host.trim(), port: Number(port), username: username.trim(), hostKey: hostKey.trim(), directory },
      });
      setPreview(result);
    } catch (reason) {
      // Never display raw native errors, which may contain local paths or authentication details.
      setError(typeof reason === "object" && reason !== null && "code" in reason && reason.code === "cancelled" ? "cancelled" : "failure");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("sftp.title")} wide onDismiss={busy ? undefined : () => controller.closeDialog()} actions={
      <>
        <button type="button" className="button" disabled={busy} onClick={() => controller.closeDialog()}>{t("dialog.close")}</button>
        <button type="button" className="button button-primary" disabled={!ready || busy} onClick={() => void compare()}>
          {busy ? t("sftp.busy") : t("sftp.compare")}
        </button>
      </>
    }>
      <p>{t("sftp.disclaimer")}</p>
      <fieldset disabled={busy}>
        <label className="field">{t("sftp.host")}<input data-autofocus value={host} onChange={(event) => { setHost(event.target.value); invalidate(); }} /></label>
        <label className="field">{t("sftp.port")}<input type="number" min="1" max="65535" value={port} onChange={(event) => { setPort(event.target.value); invalidate(); }} /></label>
        <label className="field">{t("sftp.username")}<input value={username} onChange={(event) => { setUsername(event.target.value); invalidate(); }} /></label>
        <label className="field">{t("sftp.hostKey")}<input value={hostKey} spellCheck={false} onChange={(event) => { setHostKey(event.target.value); invalidate(); }} /></label>
        <label className="field">{t("sftp.directory")}<input value={directory} spellCheck={false} onChange={(event) => { setDirectory(event.target.value); invalidate(); }} /></label>
        <label className="field">{t("sftp.paths")}<textarea value={pathsText} spellCheck={false} onChange={(event) => { setPathsText(event.target.value); invalidate(); }} /></label>
      </fieldset>
      <p className="hint">{t("sftp.limits")}</p>
      {busy && <p role="status">{t("sftp.busy")}</p>}
      {error !== null && <p role="alert">{t(error === "cancelled" ? "sftp.cancelled" : "sftp.failure")}</p>}
      {preview !== null && (
        <table>
          <thead><tr><th>{t("sftp.path")}</th><th>{t("sftp.localSize")}</th><th>{t("sftp.remoteSize")}</th><th>{t("sftp.result")}</th></tr></thead>
          <tbody>{preview.files.map((file) => (
            <tr key={file.path}>
              <td>{file.path}</td><td>{file.local.size}</td><td>{file.remote?.size ?? "—"}</td>
              <td>{t(file.remote === null ? "sftp.missing" : file.local.sha256 === file.remote.sha256 ? "sftp.same" : "sftp.different")}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
}
