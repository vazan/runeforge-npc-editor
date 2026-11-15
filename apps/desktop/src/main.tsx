import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ServicesProvider, type Surfaces } from "./app/context";
import { AppController } from "./app/controller";
import { createMonacoEditorServices } from "./features/editor/monaco-services";
import { createAppStore } from "./state/store";
import { createDefaultBackend, isTauriRuntime, type BackendApi } from "./services/backend";
import { LanguageClient } from "./workers/language-client";
import "./styles/app.css";

const EditorSurface = lazy(() => import("./features/editor/MonacoSurface"));
const DiffSurface = lazy(() => import("./features/editor/DiffSurface"));

const surfaces: Surfaces = {
  Editor: (props) => (
    <Suspense fallback={null}>
      <EditorSurface {...props} />
    </Suspense>
  ),
  Diff: (props) => (
    <Suspense fallback={null}>
      <DiffSurface {...props} />
    </Suspense>
  ),
};

/** Hors de la fenetre native (navigateur ordinaire), aucune operation de fichier n'est possible. */
function unavailableBackend(): BackendApi {
  const refuse = (): Promise<never> => Promise.reject(new Error("The desktop runtime is not available"));
  return new Proxy({}, { get: () => refuse }) as BackendApi;
}

async function start(): Promise<void> {
  const container = document.getElementById("root");
  if (container === null) throw new Error("Element #root introuvable dans index.html");

  const backend = isTauriRuntime() ? await createDefaultBackend() : unavailableBackend();
  const store = createAppStore();
  const language = new LanguageClient(() => new Worker(new URL("./workers/language.worker.ts", import.meta.url), { type: "module" }));
  const controller = new AppController({
    backend,
    store,
    editor: createMonacoEditorServices(),
    diagnostics: language,
    language,
    systemLanguage: () => navigator.language,
    systemPrefersDark: () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  });

  // Crochet de test E2E : present uniquement dans une construction `e2e` (jamais en production).
  if (await backend.e2eProject().catch(() => null)) {
    (window as unknown as { __RUNEFORGE_E2E__: unknown }).__RUNEFORGE_E2E__ = {
      store,
      controller,
      // API Monaco (chargee a la demande) pour placer le curseur ou lire les marqueurs pendant les tests.
      monaco: () => import("./features/editor/monaco-setup").then((module) => module.monaco),
    };
  }

  // Seules les classes d'erreurs standard sont journalisées, même si une instance redéfinit son nom.
  const errorTypes = [AggregateError, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, Error];
  const errorName = (value: unknown): string => errorTypes.find((type) => value instanceof type)?.name ?? "unknown";
  window.addEventListener("error", (event) => controller.logEvent("error", "UI_ERROR", `name=${errorName(event.error)}`));
  window.addEventListener("unhandledrejection", (event) => controller.logEvent("error", "UI_REJECTION", `name=${errorName(event.reason)}`));

  createRoot(container).render(
    <StrictMode>
      <ServicesProvider services={{ controller, store, surfaces }}>
        <App />
      </ServicesProvider>
    </StrictMode>,
  );
}

void start();
