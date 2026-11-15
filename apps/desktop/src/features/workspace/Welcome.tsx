import { useAppState, useController, useT } from "../../app/context";
import { Icon } from "../../components/Icon";

/** Ecran d'accueil : ouvrir un projet, projets recents, choix de la langue et du theme au premier lancement. */
export function Welcome() {
  const controller = useController();
  const t = useT();
  const recents = useAppState((state) => state.recents);
  const settings = useAppState((state) => state.settings);
  const version = useAppState((state) => state.appVersion);

  return (
    <main className="welcome">
      <div className="welcome-card">
        <h1>{t("welcome.title")}</h1>
        <p className="welcome-subtitle">{t("welcome.subtitle")}</p>

        <button type="button" className="button button-primary welcome-open" data-autofocus onClick={() => void controller.openFolder()}>
          <Icon name="folder" /> {t("welcome.openFolder")}
        </button>
        <p className="hint">{t("welcome.openFolderHint")}</p>

        <section aria-labelledby="recent-title" className="welcome-recent">
          <h2 id="recent-title">{t("welcome.recent")}</h2>
          {recents.length === 0 ? (
            <p className="hint">{t("welcome.noRecent")}</p>
          ) : (
            <ul>
              {recents.map((project) => (
                <li key={project.path}>
                  <button type="button" className="recent-open" onClick={() => void controller.openRecent(project.path)} title={project.path}>
                    <strong>{project.name}</strong>
                    <span>{project.path}</span>
                  </button>
                  <button type="button" className="icon-button" aria-label={`${t("welcome.forget")} : ${project.name}`} title={t("welcome.forget")} onClick={() => void controller.forgetRecent(project.path)}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="welcome-prefs">
          <label>
            {t("welcome.language")}
            <select value={settings.language} onChange={(event) => void controller.updateSettings({ language: event.target.value as "system" | "fr" | "en" })}>
              <option value="system">{t("settings.language.system")}</option>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </label>
          <label>
            {t("welcome.theme")}
            <select value={settings.theme} onChange={(event) => void controller.updateSettings({ theme: event.target.value as "system" | "light" | "dark" })}>
              <option value="system">{t("settings.theme.system")}</option>
              <option value="light">{t("settings.theme.light")}</option>
              <option value="dark">{t("settings.theme.dark")}</option>
            </select>
          </label>
        </div>
        <p className="hint">{t("welcome.offline")}</p>
        <p className="hint">
          {t("app.unofficial")} {version !== "" && `v${version}`}
        </p>
      </div>
    </main>
  );
}
