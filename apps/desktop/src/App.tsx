import { useEffect } from "react";
import { commandForKeyEvent } from "./app/commands";
import { useAppState, useController, useServices, useT } from "./app/context";
import { Toasts } from "./components/Toasts";
import { DialogHost } from "./features/dialogs/DialogHost";
import { CommandPalette } from "./features/palette/CommandPalette";
import { Welcome } from "./features/workspace/Welcome";
import { Workbench } from "./features/workspace/Workbench";

function NoRuntime() {
  const t = useT();
  return (
    <main className="fullscreen-message" role="alert">
      <h1>{t("app.noRuntime.title")}</h1>
      <p>{t("app.noRuntime.body")}</p>
    </main>
  );
}

/** Racine de l'application : demarrage, theme/langue, raccourcis globaux, controle des modifications externes. */
export function App() {
  const controller = useController();
  const { store } = useServices();
  const t = useT();
  const ready = useAppState((state) => state.ready);
  const runtimeAvailable = useAppState((state) => state.runtimeAvailable);
  const hasProject = useAppState((state) => state.project !== null);
  const theme = useAppState((state) => state.theme);
  const language = useAppState((state) => state.language);

  useEffect(() => {
    void controller.init();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.lang = language;
    document.title = t("app.name");
  }, [theme, language, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const state = store.getState();
      // Un dialogue ou la palette ouverts gardent le clavier pour eux.
      if (state.dialog !== null || state.palette.open) return;
      const command = commandForKeyEvent(event);
      if (command === undefined || (command.enabled !== undefined && !command.enabled(state))) return;
      event.preventDefault();
      void command.run(controller);
    };
    const onFocus = (): void => void controller.onWindowFocus();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("focus", onFocus);
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystemTheme = (): void => controller.refreshSystemPreferences();
    media?.addEventListener?.("change", onSystemTheme);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("focus", onFocus);
      media?.removeEventListener?.("change", onSystemTheme);
    };
  }, [controller, store]);

  let content;
  if (!ready) content = <div className="fullscreen-message">{t("app.loading")}</div>;
  else if (!runtimeAvailable) content = <NoRuntime />;
  else if (!hasProject) content = <Welcome />;
  else content = <Workbench />;

  return (
    <>
      {content}
      <CommandPalette />
      <DialogHost />
      <Toasts />
    </>
  );
}
