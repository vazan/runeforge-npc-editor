import { isUpdateRepository, type UpdateChannelSetting } from "@runeforge/project-core";
import { useState } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { canInstallOn, formatMebibytes, isUpdateToken, releaseDate, updateFailureText, updateProgressPercent } from "../../app/update-text";
import type { UpdateFailure } from "../../state/store";

function Failure({ failure }: { readonly failure: UpdateFailure }) {
  const t = useT();
  const { key, params } = updateFailureText(failure);
  return (
    <p className="field-error" role="alert">
      {t(key, params)}
    </p>
  );
}

/**
 * Mises a jour signees (DEC-046). Rien n'est contacte avant l'appui sur « Rechercher » ; le jeton d'acces d'un depot prive n'est
 * conserve qu'en memoire (dans le controleur), jamais dans les reglages ni dans l'etat affiche.
 */
export function UpdatesTab() {
  const controller = useController();
  const t = useT();
  const settings = useAppState((state) => state.settings.updates);
  const update = useAppState((state) => state.update);
  const version = useAppState((state) => state.appVersion);
  const platform = useAppState((state) => state.platform);
  const language = useAppState((state) => state.language);
  const hasUnsaved = useAppState((state) => Object.values(state.docs).some((doc) => doc.dirty));
  const [repository, setRepository] = useState(settings.repository);
  const [token, setToken] = useState("");
  const [tokenKept, setTokenKept] = useState(controller.updates.hasToken());

  const repositoryValid = isUpdateRepository(repository);
  const tokenInvalid = token.trim() !== "" && !isUpdateToken(token.trim());
  const busy = update.status === "checking" || update.status === "installing" || update.status === "restarting";
  const installable = canInstallOn(platform);
  const canInstall = installable && !hasUnsaved;

  const changeRepository = (value: string): void => {
    setRepository(value);
    if (isUpdateRepository(value)) void controller.updateSettings({ updates: { repository: value.trim() } });
  };
  const changeToken = (value: string): void => {
    setToken(value);
    setTokenKept(controller.updates.setToken(value) && value.trim() !== "");
  };
  const forgetToken = (): void => {
    controller.updates.setToken("");
    setToken("");
    setTokenKept(false);
  };

  return (
    <>
      <p>{t("update.intro")}</p>
      <p>{t("update.current", { version })}</p>
      <label className="field">
        {t("update.repository")}
        <input
          type="text"
          value={repository}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!repositoryValid}
          aria-describedby="update-repository-hint"
          disabled={busy}
          onChange={(event) => changeRepository(event.target.value)}
        />
      </label>
      <p id="update-repository-hint" className={repositoryValid ? "hint" : "field-error"}>
        {repositoryValid ? t("update.repository.hint") : t("update.repository.invalid")}
      </p>
      <label className="field">
        {t("update.channel")}
        <select
          value={settings.channel}
          disabled={busy}
          onChange={(event) => void controller.updateSettings({ updates: { channel: event.target.value as UpdateChannelSetting } })}
        >
          <option value="stable">{t("update.channel.stable")}</option>
          <option value="beta">{t("update.channel.beta")}</option>
        </select>
      </label>
      <label className="field">
        {t("update.token")}
        <input
          type="password"
          value={token}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={tokenInvalid}
          aria-describedby="update-token-hint"
          disabled={busy}
          onChange={(event) => changeToken(event.target.value)}
        />
      </label>
      <p id="update-token-hint" className={tokenInvalid ? "field-error" : "hint"}>
        {tokenInvalid ? t("update.token.invalid") : t("update.token.hint")}
      </p>
      {tokenKept && token === "" && (
        <p className="hint">
          {t("update.token.kept")}{" "}
          <button type="button" className="button" disabled={busy} onClick={forgetToken}>
            {t("update.token.forget")}
          </button>
        </p>
      )}
      <div className="update-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !repositoryValid || tokenInvalid}
          onClick={() => void controller.updates.check()}
        >
          {update.status === "checking" ? t("update.checking") : t("update.check")}
        </button>
      </div>

      <div role="status" aria-live="polite">
        {update.status === "up-to-date" && <p>{t("update.upToDate", { version: update.current })}</p>}
        {(update.status === "available" || update.status === "installing" || update.status === "restarting") && (
          <p>
            {t(update.update.channel === "beta" ? "update.available.beta" : "update.available", {
              version: update.update.version,
              date: releaseDate(update.update.publishedAt),
              size: formatMebibytes(update.update.size, language),
            })}
          </p>
        )}
        {update.status === "installing" && (
          <>
            <p>{t("update.installing", { percent: updateProgressPercent(update.received, update.total) })}</p>
            <progress className="update-progress" max={update.total} value={update.received} aria-label={t("update.progress")} />
          </>
        )}
        {update.status === "restarting" && <p>{t("update.restarting")}</p>}
      </div>

      {update.status === "error" && <Failure failure={update.failure} />}
      {update.status === "available" && update.failure !== null && <Failure failure={update.failure} />}
      {(update.status === "available" || update.status === "installing" || update.status === "restarting") && update.update.notes !== "" && (
        <>
          <h3 className="update-notes-title">{t("update.notes")}</h3>
          <div className="update-notes" role="region" aria-label={t("update.notes")} tabIndex={0}>
            {update.update.notes}
          </div>
        </>
      )}
      {update.status === "available" && (
        <>
          {!installable ? (
            <p className="hint">{t("update.unsupportedPlatform")}</p>
          ) : (
            <>
              {hasUnsaved && <p className="field-error">{t("update.unsaved")}</p>}
              <p className="hint">{t("update.install.hint")}</p>
            </>
          )}
          <div className="update-actions">
            <button type="button" className="button button-primary" disabled={!canInstall} onClick={() => void controller.updates.install()}>
              {t("update.install")}
            </button>
          </div>
        </>
      )}
    </>
  );
}
