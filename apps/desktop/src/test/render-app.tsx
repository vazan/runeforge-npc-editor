import { render } from "@testing-library/react";
import { parse } from "@runeforge/runescript-parser";
import { App } from "../App";
import { ServicesProvider, type DiffSurfaceProps, type EditorSurfaceProps, type Surfaces } from "../app/context";
import { AppController } from "../app/controller";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "./fake-backend";
import { inProcessLanguage } from "./in-process-worker";
import { MemoryBuffer } from "./memory-buffer";

export interface AppHarness {
  readonly backend: FakeBackend;
  readonly store: AppStore;
  readonly controller: AppController;
  readonly buffers: Map<string, MemoryBuffer>;
  readonly unmount: () => void;
}

/**
 * Monte l'application complete avec un faux disque et des surfaces d'edition simplifiees (Monaco ne s'execute pas dans
 * jsdom). La surface d'edition est un `textarea` branche sur le meme tampon que Monaco en production.
 */
export function renderApp(options: {
    language?: string;
    files?: Record<string, string | Uint8Array>;
    configure?: (backend: FakeBackend) => void;
    /** Branche le vrai service de langage (execute en processus) : index du projet, navigation, recherche de symboles. */
    withLanguage?: boolean;
  } = {}): AppHarness {
  const backend = new FakeBackend();
  for (const [path, content] of Object.entries(options.files ?? {})) backend.put(path, content);
  options.configure?.(backend);

  const store = createAppStore();
  const buffers = new Map<string, MemoryBuffer>();
  const language = options.withLanguage === true ? inProcessLanguage().client : null;
  const controller = new AppController({
    backend,
    store,
    editor: {
      createBuffer: (text, path) => {
        const buffer = new MemoryBuffer(text);
        buffers.set(path, buffer);
        return buffer;
      },
      // Comme Monaco : ajoute a la fin du tampon, puis signale la modification.
      appendText: (path, text) => {
        const buffer = buffers.get(path);
        if (buffer === undefined) return false;
        buffer.text += text;
        controller.notifyEdited(path);
        return true;
      },
      // Comme Monaco : remplace la plage du tampon, puis signale la modification.
      applyEdit: (path, start, end, text) => {
        const buffer = buffers.get(path);
        if (buffer === undefined || start < 0 || end < start || end > buffer.text.length) return false;
        buffer.text = buffer.text.slice(0, start) + text + buffer.text.slice(end);
        controller.notifyEdited(path);
        return true;
      },
    },
    diagnostics:
      language ?? {
        analyze: async (_path, _version, text) => {
          const result = parse(text);
          return { diagnostics: result.diagnostics, truncated: result.truncated };
        },
      },
    language,
    systemLanguage: () => options.language ?? "en-US",
    systemPrefersDark: () => false,
  });

  const Editor = ({ path }: EditorSurfaceProps) => {
    const buffer = buffers.get(path);
    return (
      <textarea
        data-testid="editor"
        aria-label={`editor:${path}`}
        defaultValue={buffer?.text ?? ""}
        onChange={(event) => {
          if (buffer === undefined) return;
          buffer.text = event.target.value;
          controller.notifyEdited(path);
        }}
      />
    );
  };
  const Diff = ({ original, modified }: DiffSurfaceProps) => (
    <div data-testid="diff">
      <pre data-testid="diff-original">{original}</pre>
      <pre data-testid="diff-modified">{modified}</pre>
    </div>
  );
  const surfaces: Surfaces = { Editor, Diff };

  const view = render(
    <ServicesProvider services={{ controller, store, surfaces }}>
      <App />
    </ServicesProvider>,
  );
  return { backend, store, controller, buffers, unmount: view.unmount };
}
