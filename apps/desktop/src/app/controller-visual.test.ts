import { parse } from "@runeforge/runescript-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { MemoryBuffer } from "../test/memory-buffer";
import { AppController } from "./controller";

/**
 * Editeur visuel de dialogues (RF-020 a RF-023) cote controleur : choix du NPC sous le curseur, et application du resultat au document
 * en une seule modification de texte — refusee si le document a change entre-temps.
 */
const NPC_A = '-\tscript\tA\t-1,{\n\tmes "a";\n\tclose;\n}\n';
const NPC_B = 'prontera,1,1,0\tscript\tB\t100,{\n\tmes "b";\n\tnext;\n\tclose;\n}\n';
const TWO = `// en-tete\n${NPC_A}\n// entre\n\n${NPC_B}`;

interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  buffers: Map<string, MemoryBuffer>;
  edits: { path: string; start: number; end: number; text: string }[];
}

function harness(options: { applyEdit?: "ok" | "refusing" | "absent" } = {}): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const buffers = new Map<string, MemoryBuffer>();
  const edits: Harness["edits"] = [];
  const mode = options.applyEdit ?? "ok";
  const controller: AppController = new AppController({
    backend,
    store,
    editor: {
      createBuffer: (text, path) => {
        const buffer = new MemoryBuffer(text);
        buffers.set(path, buffer);
        return buffer;
      },
      ...(mode === "absent"
        ? {}
        : {
            applyEdit: (path: string, start: number, end: number, text: string) => {
              edits.push({ path, start, end, text });
              if (mode === "refusing") return false;
              const buffer = buffers.get(path);
              if (buffer === undefined) return false;
              buffer.text = buffer.text.slice(0, start) + text + buffer.text.slice(end);
              controller.notifyEdited(path);
              return true;
            },
          }),
    },
    diagnostics: {
      analyze: async (_path, _version, text) => {
        const result = parse(text);
        return { diagnostics: result.diagnostics, truncated: result.truncated };
      },
    },
    systemLanguage: () => "en-US",
    systemPrefersDark: () => false,
  });
  return { backend, store, controller, buffers, edits };
}

async function opened(h: Harness, files: Record<string, string | Uint8Array>, open?: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  if (open !== undefined) await h.controller.openFile(open);
}

const texts = (h: Harness): string[] => h.store.getState().toasts.map((toast) => `${toast.kind}:${toast.text}`);

/** Ligne et colonne (base 1) du debut de `needle` dans `text`. */
function at(text: string, needle: string): [number, number] {
  const before = text.slice(0, text.indexOf(needle)).split("\n");
  return [before.length, (before[before.length - 1] ?? "").length + 1];
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AppController - editeur visuel : choix du NPC", () => {
  it("ouvre le NPC sous le curseur, avec le texte du document et le debut de sa declaration", async () => {
    const h = harness();
    await opened(h, { "n.txt": TWO }, "n.txt");
    h.controller.setCursor(...at(TWO, 'mes "b"'));
    expect(h.controller.openVisual()).toBe(true);
    expect(h.store.getState().dialog).toEqual({ kind: "visual", path: "n.txt", declarationStart: TWO.indexOf("prontera,1,1,0"), baseText: TWO });
    h.controller.closeDialog();
    h.controller.setCursor(...at(TWO, 'mes "a"'));
    h.controller.openVisual();
    expect(h.store.getState().dialog).toMatchObject({ kind: "visual", declarationStart: TWO.indexOf("-\tscript\tA") });
  });

  it("entre deux NPC prend celui qui precede, avant le premier le premier, et sans curseur le premier", async () => {
    const h = harness();
    await opened(h, { "n.txt": TWO }, "n.txt");
    const first = TWO.indexOf("-\tscript\tA");
    const second = TWO.indexOf("prontera,1,1,0");
    const declarationOf = (): unknown => (h.store.getState().dialog?.kind === "visual" ? h.store.getState().dialog : null);
    h.controller.setCursor(...at(TWO, "// entre"));
    h.controller.openVisual();
    expect(declarationOf()).toMatchObject({ declarationStart: first });
    h.controller.closeDialog();
    h.controller.setCursor(1, 1);
    h.controller.openVisual();
    expect(declarationOf()).toMatchObject({ declarationStart: first });
    h.controller.closeDialog();
    // Apres le dernier NPC (ligne au-dela de la fin) : le dernier qui precede.
    h.controller.setCursor(999, 1);
    h.controller.openVisual();
    expect(declarationOf()).toMatchObject({ declarationStart: second });
    h.controller.closeDialog();
    // Sans position de curseur connue (document tout juste ouvert) : le premier NPC du fichier.
    h.store.setState({ cursor: null });
    h.controller.openVisual();
    expect(declarationOf()).toMatchObject({ declarationStart: first });
  });

  it("lit le texte normalise en LF : un fichier CRLF donne les memes positions", async () => {
    const h = harness();
    const crlf = TWO.replace(/\n/g, "\r\n");
    await opened(h, { "n.txt": crlf }, "n.txt");
    h.controller.setCursor(...at(TWO, 'mes "b"'));
    expect(h.controller.openVisual()).toBe(true);
    expect(h.store.getState().dialog).toEqual({ kind: "visual", path: "n.txt", declarationStart: TWO.indexOf("prontera,1,1,0"), baseText: TWO });
  });

  it("avertit quand aucun document n'est affiche", async () => {
    const h = harness();
    await opened(h, { "n.txt": TWO });
    expect(h.controller.openVisual()).toBe(false);
    expect(h.store.getState().dialog).toBeNull();
    expect(texts(h)).toEqual(["warning:Open a file in the editor first."]);
  });

  it("dit qu'il n'y a rien a editer dans un fichier sans NPC a corps complet", async () => {
    const h = harness();
    await opened(h, { "empty.txt": "// rien\n", "open.txt": '-\tscript\tA\t-1,{\n\tmes "a";\n', "shop.txt": "prontera,1,1,4\tshop\tS\t4_M_01,501:50\n" }, "empty.txt");
    expect(h.controller.openVisual()).toBe(false);
    for (const path of ["open.txt", "shop.txt"]) {
      await h.controller.openFile(path);
      expect(h.controller.openVisual()).toBe(false);
    }
    expect(h.store.getState().dialog).toBeNull();
    expect(texts(h)).toEqual(Array(3).fill("info:No NPC with a complete body was found in this file."));
  });
});

describe("AppController - editeur visuel : application au document", () => {
  const edited = TWO.replace('mes "b";', 'mes "bonjour";');

  async function open(h: Harness): Promise<void> {
    await opened(h, { "n.txt": TWO }, "n.txt");
    h.controller.setCursor(...at(TWO, 'mes "b"'));
    h.controller.openVisual();
  }

  it("remplace seulement la plage qui change : une seule modification, le document est modifie et rien n'est ecrit", async () => {
    const h = harness();
    await open(h);
    expect(h.controller.applyVisualEdit("n.txt", TWO, edited)).toBe(true);
    // « b » devient « bonjour » : le prefixe commun est garde, il ne reste que l'insertion de « onjour » apres le « b ».
    const afterB = TWO.indexOf('b";') + 1;
    expect(h.edits).toEqual([{ path: "n.txt", start: afterB, end: afterB, text: "onjour" }]);
    expect(h.buffers.get("n.txt")?.text).toBe(edited);
    expect(h.store.getState().docs["n.txt"]?.dirty).toBe(true);
    expect(h.store.getState().dialog).toBeNull();
    expect(texts(h)).toEqual(["success:Changes applied to n.txt. Nothing is saved until you save (Ctrl+S)."]);
    // Rien n'a ete ecrit sur le disque.
    expect(h.backend.textOf("n.txt")).toBe(TWO);
  });

  it("applique aussi une insertion et une suppression comme une seule modification", async () => {
    const h = harness();
    await open(h);
    const inserted = TWO.replace("\tnext;\n", '\tnext;\n\tmes "ajoute";\n');
    expect(h.controller.applyVisualEdit("n.txt", TWO, inserted)).toBe(true);
    expect(h.edits).toHaveLength(1);
    expect(h.buffers.get("n.txt")?.text).toBe(inserted);
  });

  it("refuse si le document a change depuis l'ouverture du dialogue : rien n'est applique et le dialogue reste ouvert", async () => {
    const h = harness();
    await open(h);
    h.buffers.get("n.txt")!.text = `${TWO}// ajout\n`;
    expect(h.controller.applyVisualEdit("n.txt", TWO, edited)).toBe(false);
    expect(h.edits).toEqual([]);
    expect(h.buffers.get("n.txt")?.text).toBe(`${TWO}// ajout\n`);
    expect(h.store.getState().dialog?.kind).toBe("visual");
    expect(texts(h)).toEqual(["error:The document changed while the editor was open, so nothing was applied. Open the visual editor again."]);
  });

  it("ferme sans rien modifier quand il n'y a aucun changement", async () => {
    const h = harness();
    await open(h);
    expect(h.controller.applyVisualEdit("n.txt", TWO, TWO)).toBe(true);
    expect(h.edits).toEqual([]);
    expect(h.store.getState().dialog).toBeNull();
    expect(h.store.getState().docs["n.txt"]?.dirty).toBe(false);
    expect(texts(h)).toEqual([]);
  });

  it("signale un editeur qui ne sait pas appliquer, ou qui refuse, et garde le dialogue ouvert", async () => {
    for (const applyEdit of ["absent", "refusing"] as const) {
      const h = harness({ applyEdit });
      await open(h);
      expect(h.controller.applyVisualEdit("n.txt", TWO, edited)).toBe(false);
      expect(h.store.getState().dialog?.kind).toBe("visual");
      expect(texts(h)).toEqual(["error:Open a file in the editor first."]);
      expect(h.store.getState().docs["n.txt"]?.dirty).toBe(false);
    }
  });

  it("signale un document qui n'est plus ouvert", async () => {
    const h = harness();
    await open(h);
    expect(h.controller.applyVisualEdit("autre.txt", TWO, edited)).toBe(false);
    expect(texts(h)).toEqual(["error:Open a file in the editor first."]);
  });
});
