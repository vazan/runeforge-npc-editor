import { initialValues, runWizard, type WizardId } from "@runeforge/npc-templates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "../services/types";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { inProcessLanguage } from "../test/in-process-worker";
import { MemoryBuffer } from "../test/memory-buffer";
import type { LanguageClient } from "../workers/language-client";
import { AppController, type LanguageService } from "./controller";

/** Le script que produit un assistant avec ses valeurs initiales. */
function script(id: WizardId, overrides: Record<string, string> = {}): string {
  const result = runWizard(id, { ...initialValues(id), ...overrides });
  if (result.source === null) throw new Error("saisie invalide");
  return result.source;
}

const SHOP = "prontera,155,180,4\tshop\tMerchant\t4_M_01,501:50,502:200\n";
const NPC = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';

interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  language: LanguageClient;
  buffers: Map<string, MemoryBuffer>;
  copied: string[];
}

interface Options {
  appendText?: boolean;
  clipboard?: "recording" | "refusing" | null;
  language?: LanguageService | null;
}

function harness(options: Options = {}): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const buffers = new Map<string, MemoryBuffer>();
  const copied: string[] = [];
  const { client } = inProcessLanguage();
  const language = options.language === undefined ? client : options.language;
  const clipboard = options.clipboard === undefined ? "recording" : options.clipboard;
  const controller: AppController = new AppController({
    backend,
    store,
    editor: {
      createBuffer: (text, path) => {
        const buffer = new MemoryBuffer(text);
        buffers.set(path, buffer);
        return buffer;
      },
      // Comme Monaco : ajoute a la fin du tampon, puis signale la modification.
      ...(options.appendText === false
        ? {}
        : {
            appendText: (path: string, text: string) => {
              const buffer = buffers.get(path);
              if (buffer === undefined) return false;
              buffer.text += text;
              controller.notifyEdited(path);
              return true;
            },
          }),
    },
    diagnostics: client,
    language,
    systemLanguage: () => "en-US",
    systemPrefersDark: () => false,
    clipboard:
      clipboard === "recording"
        ? {
            writeText: (text) => {
              copied.push(text);
              return Promise.resolve();
            },
          }
        : clipboard === "refusing"
          ? { writeText: () => Promise.reject(new Error("refus")) }
          : null,
  });
  return { backend, store, controller, language: client, buffers, copied };
}

async function loaded(h: Harness, files: Record<string, string>, config?: Record<string, unknown>): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  if (config !== undefined) h.backend.put(".runeforge/project.json", JSON.stringify({ schemaVersion: 1, projectName: "P", ...config }));
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  await h.controller.whenIndexed();
}

const toasts = (h: Harness): string[] => h.store.getState().toasts.map((toast) => `${toast.kind}:${toast.text}`);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AppController - assistants de NPC : ouverture", () => {
  it("ouvre l'assistant demande, par defaut le portail de teleportation", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC });
    h.controller.openNpcWizard();
    expect(h.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "warp-portal" });
    h.controller.closeDialog();
    h.controller.openNpcWizard("shop");
    expect(h.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "shop" });
  });

  it("ouvre quand meme le dialogue pour un profil sans assistant verifie (il l'explique)", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC }, { emulator: { family: "hercules" } });
    h.controller.openNpcWizard();
    expect(h.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "warp-portal" });
  });

  it("met les dialogues suivants en file derriere l'assistant et revient au precedent a sa fermeture", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC });
    h.controller.openNpcWizard("healer");
    h.controller.openSettings("about");
    expect(h.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "healer" });
    h.controller.closeDialog();
    expect(h.store.getState().dialog).toEqual({ kind: "settings", tab: "about" });
  });
});

describe("AppController - assistants de NPC : verification du script produit", () => {
  it("ne releve rien dans les scripts que produisent les assistants", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC });
    for (const id of ["warp-portal", "warp-npc", "shop", "healer"] as const) {
      expect(await h.controller.previewWizardDiagnostics(script(id)), id).toEqual([]);
    }
  });

  it("signale une erreur de syntaxe du texte analyse", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC });
    const diagnostics = await h.controller.previewWizardDiagnostics('prontera,1,1,0\tscript\tX\t100,{\n\tmes "oups;\n}\n');
    expect(diagnostics?.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
  });

  it("n'indexe rien : ni le texte analyse, ni ses fonctions, ni ses NPC", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC });
    const before = await h.language.stats();
    await h.controller.previewWizardDiagnostics('function\tscript\tF_Apercu\t{\n\treturn;\n}\n-\tscript\tApercu\t-1,{\n\tend;\n}\n');
    expect(await h.language.stats()).toEqual(before);
    expect(await h.language.workspaceSymbols("F_Apercu", 10)).toEqual([]);
  });

  it("rend null quand le service de langage manque ou echoue", async () => {
    const without = harness({ language: null });
    await loaded(without, { "a.txt": NPC });
    expect(await without.controller.previewWizardDiagnostics(SHOP)).toBeNull();

    // Le meme service, sauf l'apercu qui echoue (un worker arrete, par exemple).
    const { client } = inProcessLanguage();
    const stopped = new Proxy(client, {
      get: (target, property) => {
        if (property === "previewDiagnostics") return () => Promise.reject(new Error("worker arrete"));
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const failing = harness({ language: stopped });
    await loaded(failing, { "a.txt": NPC });
    expect(await failing.controller.previewWizardDiagnostics(SHOP)).toBeNull();
  });
});

describe("AppController - assistants de NPC : ajout au fichier ouvert", () => {
  async function opened(content: string, options: Options = {}): Promise<Harness> {
    const h = harness(options);
    await loaded(h, { "npc/a.txt": content });
    await h.controller.openFile("npc/a.txt");
    h.controller.openNpcWizard("shop");
    return h;
  }

  it.each([
    ["apres un texte qui finit par un saut de ligne : une ligne vide les separe", NPC, `${NPC}\n${SHOP}`, 6],
    ["apres un texte sans saut de ligne final : un saut de ligne, puis une ligne vide", "// fin", `// fin\n\n${SHOP}`, 3],
    ["apres un texte qui finit deja par une ligne vide : rien de plus", `${NPC}\n`, `${NPC}\n${SHOP}`, 6],
    ["dans un fichier vide : le script seul", "", SHOP, 1],
  ] as const)("%s", async (_name, content, expected, line) => {
    const h = await opened(content);
    expect(h.controller.insertWizardScript(SHOP)).toBe(true);
    expect(h.buffers.get("npc/a.txt")?.text).toBe(expected);
    // Le script ajoute est montre a l'utilisateur.
    await vi.waitFor(() => expect(h.store.getState().reveal).toMatchObject({ path: "npc/a.txt", line, column: 1 }));
  });

  it("marque le document modifie sans rien ecrire sur le disque, ferme l'assistant et le dit", async () => {
    const h = await opened(NPC);
    const writes = h.backend.writes.length;
    expect(h.controller.insertWizardScript(SHOP)).toBe(true);
    expect(h.store.getState().docs["npc/a.txt"]?.dirty).toBe(true);
    expect(h.backend.writes.length).toBe(writes);
    expect(h.backend.textOf("npc/a.txt")).toBe(NPC);
    expect(h.store.getState().dialog).toBeNull();
    expect(toasts(h)).toContain("success:Script added at the end of a.txt. Nothing is saved until you save (Ctrl+S).");
  });

  it("n'ecrit sur le disque que lorsque l'utilisateur enregistre", async () => {
    const h = await opened(NPC);
    h.controller.insertWizardScript(SHOP);
    await h.controller.saveActive();
    expect(h.backend.textOf("npc/a.txt")).toBe(`${NPC}\n${SHOP}`);
  });

  it("refuse sans document ouvert : rien n'est modifie et l'assistant reste ouvert", async () => {
    const h = harness();
    await loaded(h, { "npc/a.txt": NPC });
    h.controller.openNpcWizard("shop");
    expect(h.controller.insertWizardScript(SHOP)).toBe(false);
    expect(h.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "shop" });
    expect(toasts(h)).toEqual(["error:Open a file in the editor first."]);
  });

  it("refuse quand l'editeur ne sait pas ajouter du texte, ou ne le peut pas", async () => {
    const without = await opened(NPC, { appendText: false });
    expect(without.controller.insertWizardScript(SHOP)).toBe(false);
    expect(without.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "shop" });
    expect(toasts(without)).toEqual(["error:Open a file in the editor first."]);

    const h = await opened(NPC);
    h.buffers.delete("npc/a.txt");
    expect(h.controller.insertWizardScript(SHOP)).toBe(false);
    expect(h.store.getState().docs["npc/a.txt"]?.dirty).toBe(false);
  });
});

describe("AppController - assistants de NPC : creation d'un fichier", () => {
  async function wizardOpen(): Promise<Harness> {
    const h = harness();
    await loaded(h, { "npc/a.txt": NPC });
    h.controller.openNpcWizard("shop");
    return h;
  }

  it("cree le fichier vide, l'ouvre avec le script et le laisse non enregistre", async () => {
    const h = await wizardOpen();
    expect(await h.controller.createWizardFile("npc/custom/merchant.txt", SHOP)).toBe("created");

    expect(h.backend.textOf("npc/custom/merchant.txt")).toBe("");
    expect(h.buffers.get("npc/custom/merchant.txt")?.text).toBe(SHOP);
    const state = h.store.getState();
    expect(state.activePath).toBe("npc/custom/merchant.txt");
    expect(state.tabs).toContain("npc/custom/merchant.txt");
    expect(state.docs["npc/custom/merchant.txt"]?.dirty).toBe(true);
    expect(state.dialog).toBeNull();
    expect(toasts(h)).toContain("success:merchant.txt created with the script. Save it (Ctrl+S) to write it to disk.");
    // Le fichier apparait dans l'explorateur.
    expect(JSON.stringify(state.project?.tree)).toContain("merchant.txt");
    await vi.waitFor(() => expect(h.store.getState().reveal).toMatchObject({ path: "npc/custom/merchant.txt", line: 1, column: 1 }));
  });

  it("ecrit le script sur le disque a l'enregistrement explicite, et pas avant", async () => {
    const h = await wizardOpen();
    await h.controller.createWizardFile("merchant.txt", SHOP);
    expect(h.backend.textOf("merchant.txt")).toBe("");
    await h.controller.saveActive();
    expect(h.backend.textOf("merchant.txt")).toBe(SHOP);
    expect(h.store.getState().docs["merchant.txt"]?.dirty).toBe(false);
  });

  it("analyse le fichier cree comme n'importe quel document ouvert", async () => {
    const h = await wizardOpen();
    await h.controller.createWizardFile("merchant.txt", 'prontera,1,1,0\tscript\tX\t100,{\n\tmes "oups;\n}\n');
    await vi.waitFor(() => expect(h.store.getState().diagnostics["merchant.txt"]?.diagnostics.length ?? 0).toBeGreaterThan(0));
  });

  it("cree les dossiers manquants et accepte les antislashs", async () => {
    const h = await wizardOpen();
    expect(await h.controller.createWizardFile("  \\npc\\perso\\x.txt ", SHOP)).toBe("created");
    expect(h.backend.directories.has("npc")).toBe(true);
    expect(h.backend.directories.has("npc/perso")).toBe(true);
    expect(h.backend.textOf("npc/perso/x.txt")).toBe("");
    expect(h.buffers.get("npc/perso/x.txt")?.text).toBe(SHOP);
  });

  it("n'ecrase jamais un fichier existant et laisse l'assistant ouvert", async () => {
    const h = await wizardOpen();
    expect(await h.controller.createWizardFile("npc/a.txt", SHOP)).toBe("exists");
    expect(h.backend.textOf("npc/a.txt")).toBe(NPC);
    expect(h.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "shop" });
    expect(h.store.getState().tabs).toEqual([]);
    expect(h.buffers.size).toBe(0);
  });

  it.each([["vide", ""], ["que des espaces", "   "], ["un dossier", "npc/"], ["une sortie du projet", "../hors.txt"]])("refuse un nom invalide : %s", async (_name, name) => {
    const h = await wizardOpen();
    expect(await h.controller.createWizardFile(name, SHOP)).toBe("invalid");
    expect(h.store.getState().dialog).toEqual({ kind: "npc-wizard", wizard: "shop" });
    expect(h.store.getState().tabs).toEqual([]);
    expect(h.backend.files.has("hors.txt")).toBe(false);
  });

  it("ne fait rien sans projet ouvert", async () => {
    const h = harness();
    await h.controller.init();
    expect(await h.controller.createWizardFile("a.txt", SHOP)).toBe("invalid");
    expect(h.backend.files.size).toBe(0);
  });

  it("analyse le script du fichier cree tout de suite, sans attendre la pause de la saisie", async () => {
    const h = await wizardOpen();
    await h.controller.createWizardFile("merchant.txt", 'prontera,1,1,0\tscript\tX\t100,{\n\tmes "oups;\n}\n');
    // La pause d'analyse apres une frappe est bien plus longue que ce delai.
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(h.store.getState().diagnostics["merchant.txt"]?.diagnostics.length ?? 0).toBeGreaterThan(0), { interval: 1, timeout: 200 });
  });

  it("dit que le fichier est cree mais vide quand le script ne peut pas y etre place", async () => {
    const h = await wizardOpen();
    vi.spyOn(h.controller.getManager() as NonNullable<ReturnType<typeof h.controller.getManager>>, "setContent").mockReturnValue(false);
    expect(await h.controller.createWizardFile("merchant.txt", SHOP)).toBe("created");
    expect(h.backend.textOf("merchant.txt")).toBe("");
    expect(toasts(h)).toContain("error:merchant.txt was created but the script could not be placed in it.");
    expect(toasts(h).some((toast) => toast.startsWith("success:"))).toBe(false);
  });

  it("dit que le fichier est cree mais vide quand il ne peut pas etre ouvert pour y placer le script", async () => {
    const h = await wizardOpen();
    vi.spyOn(h.backend, "readFiles").mockResolvedValue([{ path: "merchant.txt", ok: false, error: new BackendError({ code: "permission_denied" }) }]);
    expect(await h.controller.createWizardFile("merchant.txt", SHOP)).toBe("created");
    expect(h.backend.textOf("merchant.txt")).toBe("");
    expect(h.store.getState().tabs).toEqual([]);
    expect(toasts(h)).toContain("error:merchant.txt was created but the script could not be placed in it.");
    expect(toasts(h).some((toast) => toast.startsWith("success:"))).toBe(false);
  });
});

describe("AppController - assistants de NPC : copie", () => {
  it("copie le script dans le presse-papiers et le dit", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC });
    expect(await h.controller.copyWizardScript(SHOP)).toBe(true);
    expect(h.copied).toEqual([SHOP]);
    expect(toasts(h)).toEqual(["success:Script copied to the clipboard."]);
  });

  it("dit que la copie a echoue quand le presse-papiers refuse ou manque", async () => {
    const refusing = harness({ clipboard: "refusing" });
    await loaded(refusing, { "a.txt": NPC });
    expect(await refusing.controller.copyWizardScript(SHOP)).toBe(false);
    expect(toasts(refusing)).toEqual(["error:The script could not be copied."]);

    const missing = harness({ clipboard: null });
    await loaded(missing, { "a.txt": NPC });
    expect(await missing.controller.copyWizardScript(SHOP)).toBe(false);
    expect(toasts(missing)).toEqual(["error:The script could not be copied."]);
  });
});
