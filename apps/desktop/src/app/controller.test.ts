import { parse } from "@runeforge/runescript-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { MemoryBuffer } from "../test/memory-buffer";
import { AppController } from "./controller";

interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  buffers: Map<string, MemoryBuffer>;
  edit(path: string, text: string): void;
}

function harness(options: { language?: string; dark?: boolean } = {}): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const buffers = new Map<string, MemoryBuffer>();
  const controller = new AppController({
    backend,
    store,
    editor: {
      createBuffer: (text, path) => {
        const buffer = new MemoryBuffer(text);
        buffers.set(path, buffer);
        return buffer;
      },
    },
    diagnostics: {
      analyze: async (_path, _version, text) => {
        const result = parse(text);
        return { diagnostics: result.diagnostics, truncated: result.truncated };
      },
    },
    systemLanguage: () => options.language ?? "fr-FR",
    systemPrefersDark: () => options.dark ?? false,
  });
  return {
    backend,
    store,
    controller,
    buffers,
    edit: (path, text) => {
      const buffer = buffers.get(path);
      if (buffer === undefined) throw new Error("tampon absent");
      buffer.text = text;
      controller.notifyEdited(path);
    },
  };
}

const NPC = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function openedProject(h: Harness, files: Record<string, string> = { "a.txt": NPC, "b.txt": "x\n" }): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
}

describe("AppController - demarrage et preferences", () => {
  it("charge les preferences, resout langue/theme depuis le systeme et liste les projets recents", async () => {
    const h = harness({ language: "fr-CA", dark: true });
    h.backend.recents = [{ path: "C:\\p", name: "p", lastOpenedMs: 1 }];
    await h.controller.init();
    const state = h.store.getState();
    expect(state).toMatchObject({ ready: true, runtimeAvailable: true, language: "fr", theme: "dark" });
    expect(state.recents).toHaveLength(1);
  });

  it("signale l'absence d'environnement natif quand le coeur ne repond pas", async () => {
    const h = harness();
    h.backend.appInfo = async () => {
      throw new Error("no tauri");
    };
    await h.controller.init();
    expect(h.store.getState()).toMatchObject({ ready: true, runtimeAvailable: false });
  });

  it("normalise des preferences corrompues et persiste les modifications", async () => {
    const h = harness();
    h.backend.configs.set("settings", "{ pas du json");
    await h.controller.init();
    expect(h.store.getState().settings.editor.fontSize).toBe(14);
    await h.controller.updateSettings({
      theme: "dark",
      editor: { fontSize: 99 },
      ai: { endpoint: "http://10.10.11.74:8000/v1", model: "local-model" },
    });
    expect(h.store.getState()).toMatchObject({ theme: "dark" });
    expect(h.store.getState().settings.editor.fontSize).toBe(40);
    expect(h.store.getState().settings.ai).toEqual({ endpoint: "http://10.10.11.74:8000/v1", model: "local-model" });
    expect(JSON.parse(h.backend.configs.get("settings") ?? "{}")).toMatchObject({
      theme: "dark",
      ai: { endpoint: "http://10.10.11.74:8000/v1", model: "local-model" },
    });
  });

  it("restores the last persisted settings and reports a storage failure", async () => {
    const h = harness();
    await h.controller.init();
    vi.spyOn(h.backend, "configSet").mockRejectedValue(new Error("storage unavailable"));
    await expect(h.controller.updateSettings({ ai: { model: "local-model" } })).resolves.toBe(false);
    expect(h.store.getState().settings.ai.model).toBe("");
    expect(h.store.getState().toasts.at(-1)).toMatchObject({ kind: "error" });
  });

  it("ouvre automatiquement le projet pre-approuve d'une construction de test", async () => {
    const h = harness();
    h.backend.put("a.txt", "x\n");
    h.backend.e2e = h.backend.root;
    await h.controller.init();
    expect(h.store.getState().project?.root.id).toBe(h.backend.root.id);
  });
});

describe("AppController - projet", () => {
  it("construit l'arbre, utilise une configuration par defaut en memoire et ne cree aucun fichier", async () => {
    const h = harness();
    await openedProject(h, { "npc/a.txt": NPC, "readme.md": "x" });
    const project = h.store.getState().project;
    expect(project).toMatchObject({ configExists: false, name: "project", fileCount: 2 });
    expect(project?.tree.children.map((node) => node.name)).toEqual(["npc", "readme.md"]);
    expect(h.backend.writes).toHaveLength(0);
  });

  it("lit .runeforge/project.json quand il existe", async () => {
    const h = harness();
    h.backend.put(".runeforge/project.json", JSON.stringify({ schemaVersion: 1, projectName: "Mon Serveur", emulator: { family: "hercules" } }));
    await openedProject(h);
    expect(h.store.getState().project).toMatchObject({ name: "Mon Serveur", configExists: true, config: { emulator: { family: "hercules" } } });
  });

  it("propose la recuperation des documents non enregistres trouves a l'ouverture", async () => {
    const h = harness();
    h.backend.put("a.txt", "v1\n");
    h.backend.recovery.set("a.txt", {
      meta: { version: 1, relative: "a.txt", savedAtMs: 5, baseSha256: null, encoding: "utf-8" },
      data: new TextEncoder().encode("travail perdu\n"),
    });
    await h.controller.init();
    await h.controller.loadProject(h.backend.root);
    expect(h.store.getState().dialog).toMatchObject({ kind: "recovery", items: [{ path: "a.txt" }] });
    await h.controller.restoreRecovered("a.txt");
    expect(h.store.getState().dialog).toBeNull();
    expect(h.store.getState().activePath).toBe("a.txt");
    expect(h.buffers.get("a.txt")?.text).toBe("travail perdu\n");
    expect(h.store.getState().docs["a.txt"]?.dirty).toBe(true);
    expect(h.backend.textOf("a.txt")).toBe("v1\n"); // rien n'est ecrit sans enregistrement explicite
  });

  it("permet d'abandonner un instantane de recuperation", async () => {
    const h = harness();
    h.backend.put("a.txt", "v1\n");
    h.backend.recovery.set("a.txt", {
      meta: { version: 1, relative: "a.txt", savedAtMs: 5, baseSha256: null, encoding: null },
      data: new TextEncoder().encode("x"),
    });
    await h.controller.init();
    await h.controller.loadProject(h.backend.root);
    await h.controller.discardRecovered("a.txt");
    expect(h.backend.recovery.size).toBe(0);
    expect(h.store.getState().dialog).toBeNull();
  });

  it("restaure les onglets de la session precedente", async () => {
    const h = harness();
    h.backend.put("a.txt", "a\n");
    h.backend.put("b.txt", "b\n");
    h.backend.recents = [{ path: h.backend.root.displayPath, name: "project", lastOpenedMs: 1 }];
    h.backend.configs.set("settings", JSON.stringify({ onboardingDone: true }));
    h.backend.configs.set(
      "session",
      JSON.stringify({ version: 1, projectPath: h.backend.root.displayPath, openFiles: ["a.txt", "b.txt"], activeFile: "b.txt", expandedDirectories: [] }),
    );
    await h.controller.init();
    expect(h.store.getState()).toMatchObject({ tabs: ["a.txt", "b.txt"], activePath: "b.txt" });
  });
});

describe("AppController - onglets et enregistrement", () => {
  it("ouvre un fichier dans un onglet actif et signale les fichiers illisibles", async () => {
    const h = harness();
    await openedProject(h);
    h.backend.put("bin.txt", Uint8Array.from([0, 1, 2]));
    expect(await h.controller.openFile("a.txt")).toBe(true);
    expect(h.store.getState()).toMatchObject({ tabs: ["a.txt"], activePath: "a.txt", selectedPath: "a.txt" });
    expect(await h.controller.openFile("bin.txt")).toBe(false);
    expect(await h.controller.openFile("absent.txt")).toBe(false);
    expect(h.store.getState().toasts.map((toast) => toast.kind)).toEqual(["warning", "error"]);
    expect(h.store.getState().tabs).toEqual(["a.txt"]);
  });

  it("ferme un onglet propre immediatement et active son voisin", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    await h.controller.openFile("b.txt");
    await h.controller.requestCloseTab("b.txt");
    expect(h.store.getState()).toMatchObject({ tabs: ["a.txt"], activePath: "a.txt", dialog: null });
  });

  it("demande confirmation avant de fermer un onglet modifie : enregistrer, abandonner ou annuler", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "modifie\n");
    await h.controller.requestCloseTab("a.txt");
    expect(h.store.getState().dialog).toEqual({ kind: "unsaved-close", path: "a.txt" });

    await h.controller.resolveUnsaved("a.txt", "cancel");
    expect(h.store.getState().tabs).toEqual(["a.txt"]);
    expect(h.backend.writes).toHaveLength(0);

    await h.controller.requestCloseTab("a.txt");
    await h.controller.resolveUnsaved("a.txt", "save");
    expect(h.backend.textOf("a.txt")).toBe("modifie\n");
    expect(h.store.getState().tabs).toEqual([]);

    await h.controller.openFile("b.txt");
    h.edit("b.txt", "autre\n");
    await h.controller.requestCloseTab("b.txt");
    await h.controller.resolveUnsaved("b.txt", "discard");
    expect(h.backend.textOf("b.txt")).toBe("x\n");
    expect(h.store.getState().tabs).toEqual([]);
    expect(h.backend.recovery.size).toBe(0);
  });

  it("n'ecrit pas sur le disque en cas de conflit et propose ecraser / recharger / comparer", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "mon edition\n");
    h.backend.put("a.txt", "externe\n");
    await h.controller.saveActive();
    expect(h.store.getState().dialog).toMatchObject({ kind: "conflict", path: "a.txt", deleted: false });
    expect(h.backend.textOf("a.txt")).toBe("externe\n");
    expect(await h.controller.loadDiskText("a.txt")).toBe("externe\n");

    await h.controller.resolveConflict("a.txt", "compare");
    expect(h.store.getState().dialog).toEqual({ kind: "diff", path: "a.txt" });
    h.controller.closeDialog();

    await h.controller.resolveConflict("a.txt", "overwrite");
    expect(h.backend.textOf("a.txt")).toBe("mon edition\n");
  });

  it("recharge le disque quand l'utilisateur abandonne ses modifications en conflit", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "mon edition\n");
    h.backend.put("a.txt", "externe\n");
    await h.controller.saveActive();
    await h.controller.resolveConflict("a.txt", "reload");
    expect(h.buffers.get("a.txt")?.text).toBe("externe\n");
    expect(h.store.getState().docs["a.txt"]?.dirty).toBe(false);
  });

  it("bloque un caractere non representable puis convertit en UTF-8 sur demande", async () => {
    const h = harness();
    h.backend.put("l.txt", Uint8Array.from([0x61, 0xe9, 0x0a]));
    await h.controller.init();
    await h.controller.loadProject(h.backend.root);
    await h.controller.openFile("l.txt");
    h.edit("l.txt", "a\u00e9 \u{1F600}\n");
    await h.controller.saveActive();
    expect(h.store.getState().dialog).toMatchObject({ kind: "unencodable", path: "l.txt", encoding: "windows-1252" });
    expect(h.backend.writes).toHaveLength(0);
    await h.controller.resolveUnencodable("l.txt", "convert");
    expect(h.backend.textOf("l.txt")).toBe("a\u00e9 \u{1F600}\n");
  });

  it("enregistre tout et resume par une notification", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    await h.controller.openFile("b.txt");
    h.edit("a.txt", "A\n");
    h.edit("b.txt", "B\n");
    await h.controller.saveAll();
    expect(h.backend.textOf("a.txt")).toBe("A\n");
    expect(h.backend.textOf("b.txt")).toBe("B\n");
    expect(h.store.getState().toasts.some((toast) => toast.kind === "success")).toBe(true);
  });

  it("signale le drapeau 'modifie' au coeur pour differer la fermeture de la fenetre", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "x\n");
    expect(h.backend.dirtyFlag).toBe(true);
    await h.controller.saveActive();
    expect(h.backend.dirtyFlag).toBe(false);
  });
});

describe("AppController - fermeture", () => {
  it("ferme directement quand rien n'est modifie", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.requestExit();
    expect(h.backend.exitConfirmed).toBe(true);
  });

  it("differe la fermeture quand des fichiers sont modifies : enregistrer, abandonner ou annuler", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "modifie\n");
    await h.controller.requestExit();
    expect(h.store.getState().dialog).toMatchObject({ kind: "exit", paths: ["a.txt"], purpose: "exit" });
    expect(h.backend.exitConfirmed).toBe(false);

    await h.controller.resolveExit("cancel");
    expect(h.backend.exitConfirmed).toBe(false);

    await h.controller.requestExit();
    await h.controller.resolveExit("save");
    expect(h.backend.textOf("a.txt")).toBe("modifie\n");
    expect(h.backend.exitConfirmed).toBe(true);
  });

  it("n'abandonne ni ne ferme rien si un enregistrement echoue pendant 'tout enregistrer'", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "mien\n");
    h.backend.put("a.txt", "externe\n");
    await h.controller.requestExit();
    await h.controller.resolveExit("save");
    expect(h.backend.exitConfirmed).toBe(false);
    expect(h.backend.textOf("a.txt")).toBe("externe\n");
    expect(h.store.getState().dialog).toMatchObject({ kind: "conflict" });
  });

  it("abandonne les modifications et ferme sur demande explicite", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "mien\n");
    await h.controller.requestExit();
    await h.controller.resolveExit("discard");
    expect(h.backend.exitConfirmed).toBe(true);
    expect(h.backend.textOf("a.txt")).toBe(NPC);
  });

  it("demande une decision avant de changer de projet quand des fichiers sont modifies", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.edit("a.txt", "mien\n");
    h.backend.pickResult = { id: "autre", displayPath: "C:\\fake\\autre" };
    const opening = h.controller.openFolder();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.store.getState().dialog).toMatchObject({ kind: "exit", purpose: "leave-project" });
    await h.controller.resolveExit("cancel");
    await opening;
    expect(h.store.getState().project?.root.id).toBe(h.backend.root.id); // projet conserve
    expect(h.store.getState().tabs).toEqual(["a.txt"]);
  });
});

describe("AppController - fichiers et configuration", () => {
  it("cree un fichier (et ses dossiers), l'ouvre, et refuse un nom deja pris", async () => {
    const h = harness();
    await openedProject(h);
    h.controller.requestNewFile("npc");
    expect(await h.controller.createFile("npc/custom/hello.txt")).toBe(true);
    expect(h.backend.files.has("npc/custom/hello.txt")).toBe(true);
    expect(h.backend.directories.has("npc")).toBe(true);
    expect(h.backend.directories.has("npc/custom")).toBe(true);
    expect(h.store.getState().activePath).toBe("npc/custom/hello.txt");
    expect(h.store.getState().project?.tree.children.some((node) => node.name === "npc")).toBe(true);

    h.controller.requestNewFile("");
    expect(await h.controller.createFile("a.txt")).toBe(false);
    expect(h.store.getState().dialog).toMatchObject({ kind: "new-file", error: "exists" });
    expect(h.backend.textOf("a.txt")).toBe(NPC); // le fichier existant n'est pas ecrase
  });

  it("refuse un nom de fichier dangereux sans rien ecrire hors du projet", async () => {
    const h = harness();
    await openedProject(h);
    h.controller.requestNewFile("");
    expect(await h.controller.createFile("../evil.txt")).toBe(false);
    expect(h.store.getState().dialog).toMatchObject({ kind: "new-file", error: "invalid" });
    expect(h.backend.files.has("../evil.txt")).toBe(false);
  });

  it("cree puis met a jour .runeforge/project.json en conservant les cles inconnues", async () => {
    const h = harness();
    await openedProject(h);
    const project = h.store.getState().project;
    if (project === null) throw new Error("projet absent");
    expect(await h.controller.saveProjectConfig({ ...project.config, projectName: "Mon projet" })).toBe(true);
    expect(JSON.parse(h.backend.textOf(".runeforge/project.json") ?? "{}")).toMatchObject({ projectName: "Mon projet", schemaVersion: 1 });
    expect(h.backend.writes.at(-1)?.precondition.kind).toBe("mustNotExist");
    expect(h.store.getState().project).toMatchObject({ configExists: true, name: "Mon projet" });

    // Une cle ajoutee par une version future est conservee a la reecriture.
    const withFuture = JSON.parse(h.backend.textOf(".runeforge/project.json") ?? "{}") as Record<string, unknown>;
    withFuture["futureKey"] = { keep: true };
    h.backend.put(".runeforge/project.json", JSON.stringify(withFuture));
    await h.controller.loadProject(h.backend.root);
    const reloaded = h.store.getState().project;
    if (reloaded === null) throw new Error("projet absent");
    await h.controller.saveProjectConfig({ ...reloaded.config, projectName: "Renomme" });
    const final = JSON.parse(h.backend.textOf(".runeforge/project.json") ?? "{}") as Record<string, unknown>;
    expect(final["futureKey"]).toEqual({ keep: true });
    expect(final["projectName"]).toBe("Renomme");
    expect(h.backend.writes.at(-1)?.precondition.kind).toBe("mustMatch");
  });
});

describe("AppController - diagnostics et fenetre", () => {
  it("analyse les documents ouverts et retire les resultats perimes", async () => {
    const h = harness();
    await openedProject(h, { "bad.txt": 'prontera,1,1,0\tscript\tX\t100,{\n\tmes "a"\n}\n' });
    await h.controller.openFile("bad.txt");
    await vi.advanceTimersByTimeAsync(50);
    expect(h.store.getState().diagnostics["bad.txt"]?.diagnostics.map((item) => item.code)).toEqual(["RS0020"]);
    h.edit("bad.txt", 'prontera,1,1,0\tscript\tX\t100,{\n\tmes "a";\n}\n');
    await vi.advanceTimersByTimeAsync(300);
    expect(h.store.getState().diagnostics["bad.txt"]?.diagnostics).toEqual([]);
  });

  it("notifie une modification externe quand la fenetre reprend le focus", async () => {
    const h = harness();
    await openedProject(h);
    await h.controller.openFile("a.txt");
    h.backend.put("a.txt", "externe\n");
    await h.controller.onWindowFocus();
    expect(h.buffers.get("a.txt")?.text).toBe("externe\n");
    expect(h.store.getState().toasts.some((toast) => toast.kind === "info")).toBe(true);
  });

  it("enregistre la session apres un delai (onglets ouverts et dossiers deplies)", async () => {
    const h = harness();
    await openedProject(h, { "npc/a.txt": "x\n" });
    await h.controller.openFile("npc/a.txt");
    await vi.advanceTimersByTimeAsync(600);
    expect(JSON.parse(h.backend.configs.get("session") ?? "{}")).toMatchObject({
      openFiles: ["npc/a.txt"],
      activeFile: "npc/a.txt",
      expandedDirectories: ["npc"],
    });
  });

  it("empile les dialogues et les presente un par un", () => {
    const h = harness();
    h.controller.openDialog({ kind: "settings", tab: "general" });
    h.controller.openDialog({ kind: "diff", path: "a.txt" });
    expect(h.store.getState().dialog?.kind).toBe("settings");
    h.controller.closeDialog();
    expect(h.store.getState().dialog?.kind).toBe("diff");
    h.controller.closeDialog();
    expect(h.store.getState().dialog).toBeNull();
  });
});

describe("AppController - notifications", () => {
  const texts = (h: Harness): string[] => h.store.getState().toasts.map((toast) => toast.text);

  it("n'en garde que trois a l'ecran : les plus anciennes partent d'abord", () => {
    const h = harness();
    for (const n of [1, 2, 3, 4, 5]) h.controller.notify("success", `n${n}`);
    expect(texts(h)).toEqual(["n3", "n4", "n5"]);
    h.controller.notify("error", "e6");
    expect(texts(h)).toEqual(["n4", "n5", "e6"]);
  });

  it("une notification qui part ne retire pas les autres, meme si une plus ancienne a deja ete evincee", async () => {
    const h = harness();
    for (const n of [1, 2, 3, 4]) h.controller.notify("info", `n${n}`);
    await vi.advanceTimersByTimeAsync(4000);
    h.controller.notify("info", "n5");
    expect(texts(h)).toEqual(["n3", "n4", "n5"]);
    // n2 et les precedentes sont deja parties de la pile : leur minuterie ne touche plus rien ; n3 et n4 expirent a 5 s, n5 a 9 s.
    await vi.advanceTimersByTimeAsync(1100);
    expect(texts(h)).toEqual(["n5"]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(texts(h)).toEqual([]);
  });

  it("les erreurs restent deux fois plus longtemps que les autres messages", async () => {
    const h = harness();
    h.controller.notify("error", "e");
    h.controller.notify("warning", "w");
    await vi.advanceTimersByTimeAsync(5100);
    expect(texts(h)).toEqual(["e"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(texts(h)).toEqual([]);
  });

  it("la croix retire la notification visee et elle seule", () => {
    const h = harness();
    h.controller.notify("success", "a");
    h.controller.notify("success", "b");
    const [first] = h.store.getState().toasts;
    h.controller.dismissToast(first?.id ?? -1);
    expect(texts(h)).toEqual(["b"]);
  });
});
