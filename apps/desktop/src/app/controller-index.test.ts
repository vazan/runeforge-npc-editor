import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { inProcessLanguage } from "../test/in-process-worker";
import { MemoryBuffer } from "../test/memory-buffer";
import type { LanguageClient } from "../workers/language-client";
import { AppController } from "./controller";

interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  language: LanguageClient;
  buffers: Map<string, MemoryBuffer>;
  edit(path: string, text: string): void;
}

/** Controleur branche sur le vrai service de langage (execute en processus) et un faux disque. */
function harness(): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const buffers = new Map<string, MemoryBuffer>();
  const { client: language } = inProcessLanguage();
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
    diagnostics: language,
    language,
    systemLanguage: () => "fr-FR",
    systemPrefersDark: () => false,
  });
  return {
    backend,
    store,
    controller,
    language,
    buffers,
    edit: (path, text) => {
      const buffer = buffers.get(path);
      if (buffer === undefined) throw new Error("tampon absent");
      buffer.text = text;
      controller.notifyEdited(path);
    },
  };
}

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t100,{\n${body}\n}\n`;
const fn = (name: string): string => `function\tscript\t${name}\t{\n\treturn;\n}\n`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function loaded(h: Harness, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  await h.controller.whenIndexed();
}

const PROJECT_FILES = {
  "npc/lib.txt": fn("F_Lib"),
  "npc/main.txt": npc('callfunc "F_Lib";\nclose;', "Main"),
  "readme.md": "pas un script\n",
};

describe("AppController - indexation du projet", () => {
  it("indexe en arriere-plan les fichiers de `sources` et publie la progression", async () => {
    const h = harness();
    const statuses: string[] = [];
    h.store.subscribe((state) => {
      if (statuses.at(-1) !== state.indexing.status) statuses.push(state.indexing.status);
    });
    await loaded(h, PROJECT_FILES);
    expect(statuses.filter((status) => status !== "idle")).toEqual(["running", "done"]);
    const { indexing } = h.store.getState();
    expect(indexing).toMatchObject({ status: "done", done: 2, total: 2, skipped: 0, files: 2, functions: 1, npcs: 1 });
    // `sources` (par defaut **/*.txt) est transmis au parcours : readme.md n'est pas lu.
    expect(h.backend.scans.some((scan) => scan.include?.join() === "**/*.txt")).toBe(true);
    expect(h.backend.readCount).toBe(3); // project.json absent (1 lecture) + 2 scripts
  });

  it("lit les fichiers par lots", async () => {
    const h = harness();
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) files[`npc/f${String(i).padStart(3, "0")}.txt`] = fn(`F_${i}`);
    const spy = vi.spyOn(h.language, "indexFiles");
    await loaded(h, files);
    expect(spy.mock.calls.map((call) => call[0].length)).toEqual([40, 40, 20]);
    expect(h.store.getState().indexing).toMatchObject({ status: "done", done: 100, total: 100, functions: 100 });
  });

  it("respecte `sources` du projet", async () => {
    const h = harness();
    h.backend.put(".runeforge/project.json", JSON.stringify({ schemaVersion: 1, projectName: "P", sources: ["npc/**/*.txt"] }));
    await loaded(h, { "npc/in.txt": fn("F_In"), "other/out.txt": fn("F_Out") });
    expect((await h.controller.searchSymbols("F_")).map((s) => s.name)).toEqual(["F_In"]);
  });

  it("arrete l'indexation et vide l'index quand le projet est ferme", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.closeProject();
    await h.controller.whenIndexed();
    expect(h.store.getState().indexing.status).toBe("idle");
    expect(await h.language.stats()).toMatchObject({ files: 0, functions: 0, npcs: 0 });
  });

  it("resynchronise apres une modification externe : nouveau, modifie et supprime", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    h.backend.put("npc/lib.txt", fn("F_Renamed"));
    h.backend.put("npc/extra.txt", fn("F_Extra"));
    h.backend.files.delete("npc/main.txt");
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    expect((await h.controller.searchSymbols("F_")).map((s) => s.name).sort()).toEqual(["F_Extra", "F_Renamed"]);
    expect(await h.controller.searchSymbols("Main")).toEqual([]);
    expect(h.store.getState().indexing).toMatchObject({ status: "done", files: 2 });
  });

  it("ne relit pas les fichiers inchanges lors d'une resynchronisation", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    const before = h.backend.readCount;
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    expect(h.backend.readCount).toBe(before);
  });
});

describe("AppController - navigation", () => {
  it("resout la definition d'un callfunc dans un autre fichier du projet", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.openFile("npc/main.txt");
    const found = await h.controller.definitionAt("npc/main.txt", 2, 12);
    expect(found.map((location) => location.uri)).toEqual(["npc/lib.txt"]);
    expect(found[0]?.range.start).toEqual({ line: 0, character: 16 });
  });

  it("liste les references d'une fonction et ouvre un resultat a la bonne position", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.openFile("npc/main.txt");
    const references = await h.controller.referencesAt("npc/main.txt", 2, 12, true);
    expect(references.map((location) => location.uri).sort()).toEqual(["npc/lib.txt", "npc/main.txt"]);
    const definition = references.find((location) => location.uri === "npc/lib.txt");
    if (definition === undefined) throw new Error("definition absente");
    await h.controller.openLocation(definition);
    expect(h.store.getState().activePath).toBe("npc/lib.txt");
    expect(h.store.getState().reveal).toMatchObject({ path: "npc/lib.txt", line: 1, column: 17 });
  });

  it("donne le plan du document ouvert et recherche les symboles du projet", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.openFile("npc/main.txt");
    expect((await h.controller.documentSymbolsOf("npc/main.txt")).map((symbol) => symbol.name)).toEqual(["Main"]);
    expect((await h.controller.searchSymbols("lib")).map((symbol) => symbol.name)).toEqual(["F_Lib"]);
  });

  it("utilise le texte de l'editeur, non enregistre, pour les requetes de navigation", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.openFile("npc/lib.txt");
    h.edit("npc/lib.txt", fn("F_Unsaved"));
    // Aucune attente du delai d'analyse : la requete envoie d'abord le texte courant au service.
    expect((await h.controller.searchSymbols("F_Unsaved")).length).toBe(0);
    await h.controller.definitionAt("npc/lib.txt", 1, 1);
    expect((await h.controller.searchSymbols("F_Unsaved")).map((symbol) => symbol.name)).toEqual(["F_Unsaved"]);
    expect(await h.controller.searchSymbols("F_Lib")).toEqual([]);
  });

  it("retrouve une fonction definie dans un autre fichier (nom insensible a la casse) avec le texte de ce fichier, pour la simulation", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    const lookup = h.controller.createFunctionLookup();
    const found = await lookup("F_Lib");
    expect(found?.declaration.name).toBe("F_Lib");
    expect(found?.source).toBe(fn("F_Lib"));
    expect((await lookup("f_lib"))?.declaration.name).toBe("F_Lib");
    // Un NPC de meme nom n'est pas une fonction, et une fonction absente de l'index reste inconnue.
    expect(await lookup("Main")).toBeUndefined();
    expect(await lookup("F_Missing")).toBeUndefined();
  });

  it("ne lit que le fichier qui declare la fonction, pas celui d'un NPC de meme nom, et une seule fois par fichier", async () => {
    const h = harness();
    // Le fichier du NPC precede celui de la fonction dans l'ordre de l'index : un filtre de type absent le ferait lire d'abord.
    await loaded(h, { "npc/a_npc.txt": npc("close;", "F_Same"), "npc/b_lib.txt": fn("F_Same") + fn("F_Other") });
    const lookup = h.controller.createFunctionLookup();
    const before = h.backend.readCount;
    expect((await lookup("F_Same"))?.declaration.name).toBe("F_Same");
    expect(h.backend.readCount - before).toBe(1);
    expect((await lookup("F_Other"))?.declaration.name).toBe("F_Other");
    expect(h.backend.readCount - before).toBe(1);
  });

  it("lit le texte non enregistre d'un onglet ouvert, pas le disque, pour la fonction cherchee par la simulation", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.openFile("npc/lib.txt");
    const edited = `${fn("F_Lib")}// modifie dans l'editeur\n`;
    h.edit("npc/lib.txt", edited);
    expect((await h.controller.createFunctionLookup()("F_Lib"))?.source).toBe(edited);
  });

  it("revient a la version du disque quand un document modifie est ferme sans enregistrer", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.openFile("npc/lib.txt");
    h.edit("npc/lib.txt", fn("F_Unsaved"));
    await vi.advanceTimersByTimeAsync(400);
    expect((await h.controller.searchSymbols("F_Unsaved")).length).toBe(1);
    await h.controller.closeTab("npc/lib.txt");
    await vi.waitFor(async () => {
      expect((await h.controller.searchSymbols("F_")).map((symbol) => symbol.name)).toEqual(["F_Lib"]);
    });
  });

  it("propose des completions et decrit le symbole survole, a partir du texte courant de l'editeur", async () => {
    const h = harness();
    await loaded(h, PROJECT_FILES);
    await h.controller.openFile("npc/main.txt");
    // Saisie non enregistree : `callfunc "F_` -> le service doit voir ce texte sans attendre le delai d'analyse.
    h.edit("npc/main.txt", npc('callfunc "F_";\nclose;', "Main"));
    const proposals = await h.controller.completionAt("npc/main.txt", 2, 13); // curseur apres `F_`
    expect(proposals.map((item) => item.label)).toEqual(["F_Lib"]);
    expect((await h.controller.completionAt("npc/main.txt", 3, 3)).map((item) => item.label)).toContain("close");

    h.edit("npc/main.txt", npc('callfunc "F_Lib";\nclose;', "Main"));
    const info = await h.controller.hoverAt("npc/main.txt", 2, 13);
    expect(info).toMatchObject({ kind: "function", name: "F_Lib", references: 1 });
  });

  it("sans service de langage, les requetes de navigation renvoient des listes vides", async () => {
    const backend = new FakeBackend();
    const controller = new AppController({
      backend,
      store: createAppStore(),
      editor: { createBuffer: (text) => new MemoryBuffer(text) },
    });
    expect(await controller.definitionAt("a.txt", 1, 1)).toEqual([]);
    expect(await controller.searchSymbols("x")).toEqual([]);
    await controller.whenIndexed();
  });
});

describe("AppController - verifications entre fichiers", () => {
  const caller = npc('callfunc "F_Missing";\ncallfunc "F_Lib";\nclose;', "Main");

  it("n'en fait aucune par defaut", async () => {
    const h = harness();
    await loaded(h, { "npc/lib.txt": fn("F_Lib"), "npc/main.txt": caller });
    await h.controller.openFile("npc/main.txt");
    await vi.advanceTimersByTimeAsync(10);
    await h.controller.whenIndexed();
    expect(h.store.getState().diagnostics["npc/main.txt"]?.diagnostics).toEqual([]);
  });

  it("signale les appels non resolus quand le projet declare `crossFile: all`", async () => {
    const h = harness();
    h.backend.put(".runeforge/project.json", JSON.stringify({ schemaVersion: 1, projectName: "P", validation: { crossFile: "all" } }));
    await loaded(h, { "npc/lib.txt": fn("F_Lib"), "npc/main.txt": caller });
    await h.controller.openFile("npc/main.txt");
    await vi.advanceTimersByTimeAsync(10);
    const codes = h.store.getState().diagnostics["npc/main.txt"]?.diagnostics.map((d) => d.code);
    expect(codes).toEqual(["RA0004"]);
  });

  it("applique un changement de reglage sans relire les fichiers et rafraichit les documents ouverts", async () => {
    const h = harness();
    await loaded(h, { "npc/lib.txt": fn("F_Lib"), "npc/main.txt": caller });
    await h.controller.openFile("npc/main.txt");
    await vi.advanceTimersByTimeAsync(10);
    expect(h.store.getState().diagnostics["npc/main.txt"]?.diagnostics).toEqual([]);
    const reads = h.backend.readCount;
    const config = h.store.getState().project?.config;
    if (config === undefined) throw new Error("projet absent");
    await h.controller.saveProjectConfig({ ...config, validation: { ...config.validation, crossFile: "all" } });
    await vi.waitFor(() => {
      expect(h.store.getState().diagnostics["npc/main.txt"]?.diagnostics.map((d) => d.code)).toEqual(["RA0004"]);
    });
    expect(h.backend.readCount).toBe(reads);
  });
});
