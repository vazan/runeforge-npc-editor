import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { inProcessLanguage } from "../test/in-process-worker";
import { MemoryBuffer } from "../test/memory-buffer";
import type { LanguageClient } from "../workers/language-client";
import { AppController } from "./controller";

/**
 * Ordre de chargement des scripts par le serveur (`scripts_*.conf`) et `RA0016` : un nom appele seul n'est accepte que si la
 * fonction globale est deja chargee. Le controleur donne l'ordre au service quelle que soit la portee de l'index.
 */
interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  language: LanguageClient;
}

function harness(): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const { client: language } = inProcessLanguage();
  const controller = new AppController({
    backend,
    store,
    editor: { createBuffer: (text) => new MemoryBuffer(text) },
    diagnostics: language,
    language,
    systemLanguage: () => "fr-FR",
    systemPrefersDark: () => false,
  });
  return { backend, store, controller, language };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t100,{\n${body}\n}\n`;
const fn = (name: string): string => `function\tscript\t${name}\t{\n\tclose;\n}\n`;

// Mini serveur rAthena redige pour ces tests.
const TABLE = [
  "struct script_function buildin_func[] = {",
  '\tBUILDIN_DEF(mes,"s*"),',
  '\tBUILDIN_DEF(close,""),',
  '\tBUILDIN_DEF(callfunc,"s*"),',
  "\t{nullptr,nullptr,nullptr},",
  "};",
].join("\n");
const MANUAL = ["=====", "|1.- Base.|", "=====", '*mes "<string>"{,"<string>"};', "", "Affiche.", "", "*close;", "", "Ferme.", ""].join("\n");

const CALLER = "npc/re/caller.txt";
const DEFS = "npc/re/defs.txt";
const LATE = "npc/re/late.txt";
const CONF = "npc/re/scripts_main.conf";

const confOf = (order: readonly string[]): string => `${order.map((path) => `npc: ${path}`).join("\n")}\n`;

/** Un serveur dont la liste de scripts charge `order` dans cet ordre ; `CALLER` appelle `F_Lib` (definie dans `DEFS`) par son nom. */
function serverFiles(order: readonly string[], extra: Record<string, string> = {}): Record<string, string> {
  return {
    "src/map/script.cpp": TABLE,
    "doc/script_commands.txt": MANUAL,
    "src/config/renewal.hpp": "#define RENEWAL\n",
    "conf/map_athena.conf": "import: conf/import/map_conf.txt\n",
    "conf/import/map_conf.txt": "",
    [CONF]: confOf(order),
    [CALLER]: npc("F_Lib;\nclose;", "Caller"),
    [DEFS]: fn("F_Lib"),
    ...extra,
  };
}

async function loaded(h: Harness, files: Record<string, string>, config?: Record<string, unknown>): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  if (config !== undefined) h.backend.put(".runeforge/project.json", JSON.stringify({ schemaVersion: 1, projectName: "P", ...config }));
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  await h.controller.whenIndexed();
}

async function diagnosticsOf(h: Harness, path: string): Promise<string[]> {
  await h.controller.openFile(path);
  await vi.advanceTimersByTimeAsync(10);
  return currentCodes(h, path);
}

const currentCodes = (h: Harness, path: string): string[] => (h.store.getState().diagnostics[path]?.diagnostics ?? []).map((d) => d.code);

/** Le texte souligne par chaque diagnostic d'un document ouvert. */
const underlined = (h: Harness, path: string, text: string): string[] =>
  (h.store.getState().diagnostics[path]?.diagnostics ?? []).map((d) => text.slice(d.range.start, d.range.end));

describe.each([["sources"], ["loaded"]] as const)("AppController - ordre de chargement (RA0016), portee d'index %s", (scope) => {
  const config = { emulator: { family: "rathena", indexScope: scope } };

  it("signale l'appel par son nom d'une fonction que le serveur charge apres l'appelant", async () => {
    const h = harness();
    await loaded(h, serverFiles([CALLER, DEFS]), config);
    expect(await diagnosticsOf(h, CALLER)).toEqual(["RA0016"]);
    expect(underlined(h, CALLER, npc("F_Lib;\nclose;", "Caller"))).toEqual(["F_Lib"]);
    expect(h.store.getState().diagnostics[CALLER]?.diagnostics[0]).toMatchObject({ severity: "error", params: { name: "F_Lib" } });
  });

  it("ne signale rien quand la fonction est chargee avant l'appelant", async () => {
    const h = harness();
    await loaded(h, serverFiles([DEFS, CALLER]), config);
    expect(await diagnosticsOf(h, CALLER)).toEqual([]);
  });

  it("ne dit rien d'un fichier que le serveur ne charge pas", async () => {
    const h = harness();
    await loaded(h, serverFiles([DEFS]), config);
    // `caller.txt` n'est pas charge : la portee « sources » l'indexe, « loaded » non (il est alors inconnu de l'index, pas de l'ordre).
    expect(await diagnosticsOf(h, CALLER)).toEqual([]);
  });

  it("distingue une fonction definie dans un fichier que le serveur ne charge pas : RA0016 si l'index la connait, RA0001 sinon", async () => {
    const h = harness();
    await loaded(h, serverFiles([CALLER]), config);
    expect(await diagnosticsOf(h, CALLER)).toEqual([scope === "sources" ? "RA0016" : "RA0001"]);
  });

  it("refait les diagnostics quand l'ordre change dans la configuration du serveur, sans relire aucun script", async () => {
    const h = harness();
    await loaded(h, serverFiles([CALLER, DEFS]), config);
    expect(await diagnosticsOf(h, CALLER)).toEqual(["RA0016"]);

    h.backend.put(CONF, confOf([DEFS, CALLER]));
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    await vi.advanceTimersByTimeAsync(10);
    expect(currentCodes(h, CALLER)).toEqual([]);

    h.backend.put(CONF, confOf([CALLER, DEFS]));
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    await vi.advanceTimersByTimeAsync(10);
    expect(currentCodes(h, CALLER)).toEqual(["RA0016"]);
  });

  it("tient compte d'un fichier ajoute a la liste du serveur (l'ordre s'allonge sans changer ses premiers elements)", async () => {
    const h = harness();
    // Appelle `F_Local` avant de la definir : refuse des que le serveur charge ce fichier.
    const late = npc("F_Local;\nclose;", "Early") + fn("F_Local");
    await loaded(h, serverFiles([CALLER, DEFS], { [LATE]: late }), config);
    expect(await diagnosticsOf(h, LATE)).toEqual([]);

    h.backend.put(CONF, confOf([CALLER, DEFS, LATE]));
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    await vi.advanceTimersByTimeAsync(10);
    expect(currentCodes(h, LATE)).toEqual(["RA0016"]);
  });

  it("confie de nouveau l'ordre en rouvrant le meme projet", async () => {
    const h = harness();
    await loaded(h, serverFiles([CALLER, DEFS]), config);
    expect(await diagnosticsOf(h, CALLER)).toEqual(["RA0016"]);
    await h.controller.closeProject();
    await h.controller.loadProject(h.backend.root);
    await h.controller.whenIndexed();
    expect(await diagnosticsOf(h, CALLER)).toEqual(["RA0016"]);
  });

  it("ne confie l'ordre au service qu'une fois tant qu'il ne change pas, et le retire en quittant le projet", async () => {
    const h = harness();
    const setLoadOrder = vi.spyOn(h.language, "setLoadOrder");
    await loaded(h, serverFiles([CALLER, DEFS]), config);
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    // La remise a zero de l'ouverture du projet, puis la liste que le serveur charge dans son ordre : une seule fois.
    expect(setLoadOrder.mock.calls).toEqual([[null], [[CALLER, DEFS]]]);

    await h.controller.closeProject();
    expect(setLoadOrder.mock.calls).toEqual([[null], [[CALLER, DEFS]], [null]]);
  });
});

describe("AppController - ordre de chargement (RA0016), cas communs", () => {
  // Dans ces cas aucun ordre n'est connu : le service ne recoit que la remise a zero de l'ouverture du projet.
  it("ne dit rien sans serveur reconnu et ne confie aucun ordre au service", async () => {
    const h = harness();
    const setLoadOrder = vi.spyOn(h.language, "setLoadOrder");
    await loaded(h, { "npc/a.txt": npc("F_Lib;\nclose;", "Caller"), "npc/b.txt": fn("F_Lib") });
    expect(await diagnosticsOf(h, "npc/a.txt")).toEqual([]);
    expect(setLoadOrder.mock.calls).toEqual([[null]]);
  });

  it("ne dit rien quand les listes de scripts du serveur sont introuvables (une liste vide ne dit rien du serveur)", async () => {
    const h = harness();
    const setLoadOrder = vi.spyOn(h.language, "setLoadOrder");
    const files = serverFiles([CALLER, DEFS]);
    delete files[CONF];
    await loaded(h, files);
    expect(h.store.getState().emulator.status).toBe("ready");
    expect(await diagnosticsOf(h, CALLER)).toEqual([]);
    expect(setLoadOrder.mock.calls).toEqual([[null]]);
  });

  it("ne confie pas non plus d'ordre vide en portee « loaded » quand les listes de scripts sont introuvables", async () => {
    const h = harness();
    const setLoadOrder = vi.spyOn(h.language, "setLoadOrder");
    const files = serverFiles([CALLER, DEFS]);
    delete files[CONF];
    await loaded(h, files, { emulator: { family: "rathena", indexScope: "loaded" } });
    expect(h.store.getState().emulator).toMatchObject({ status: "ready", loadedScripts: 0 });
    expect(setLoadOrder.mock.calls).toEqual([[null]]);
  });

  it("respecte la politique `unknownCommands: off` du projet (et la rend quand on la rouvre)", async () => {
    const h = harness();
    await loaded(h, serverFiles([CALLER, DEFS]), { validation: { unknownCommands: "off" } });
    expect(await diagnosticsOf(h, CALLER)).toEqual([]);
    const config = h.store.getState().project?.config;
    if (config === undefined) throw new Error("projet absent");
    await h.controller.saveProjectConfig({ ...config, validation: { ...config.validation, unknownCommands: "warning" } });
    await vi.waitFor(() => {
      expect(currentCodes(h, CALLER)).toEqual(["RA0016"]);
    });
  });

  it("figure dans le rapport de projet quand le serveur charge l'appelant", async () => {
    const h = harness();
    await loaded(h, serverFiles([CALLER, DEFS]));
    await h.controller.refreshProjectReport();
    const report = h.store.getState().projectReport?.report;
    expect(report?.files.map((file) => [file.uri, file.items.map((item) => item.diagnostic.code)])).toEqual([[CALLER, ["RA0016"]]]);
  });
});
