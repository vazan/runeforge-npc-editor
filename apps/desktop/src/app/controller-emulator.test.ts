import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "@runeforge/project-core";
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
}

/** Textes que l'application demande d'inserer dans l'editeur (l'editeur de ces tests n'en a pas : il les enregistre). */
interface Inserted {
  readonly text: string;
  readonly insideString: string | undefined;
}

function harness(inserted: Inserted[] = []): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const { client: language } = inProcessLanguage();
  const controller = new AppController({
    backend,
    store,
    editor: {
      createBuffer: (text) => new MemoryBuffer(text),
      insertAtCursor: (text, insideString) => {
        inserted.push({ text, insideString });
        return true;
      },
    },
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
const fn = (name: string): string => `function\tscript\t${name}\t{\n\treturn;\n}\n`;

// Mini serveur rAthena redige pour ces tests (meme disposition qu'un vrai serveur, contenu original).
const TABLE = [
  "struct script_function buildin_func[] = {",
  '\tBUILDIN_DEF(mes,"s*"),',
  '\tBUILDIN_DEF(next,""),',
  '\tBUILDIN_DEF(close,""),',
  '\tBUILDIN_DEF(callfunc,"s*"),',
  '\tBUILDIN_DEF2(setr,"set","rv?"),',
  "\t{nullptr,nullptr,nullptr},",
  "};",
].join("\n");
const MANUAL = ["=====", "|1.- Base.|", "=====", '*mes "<string>"{,"<string>"};', "", "Affiche.", "", "*close;", "", "Ferme.", ""].join("\n");

/** Fichiers d'un serveur dont la racine est `prefix` (vide, ou `dossier/`). */
function serverFiles(prefix: string): Record<string, string> {
  return {
    [`${prefix}src/map/script.cpp`]: TABLE,
    [`${prefix}doc/script_commands.txt`]: MANUAL,
    [`${prefix}src/config/renewal.hpp`]: "#define RENEWAL\n",
    [`${prefix}conf/map_athena.conf`]: "import: conf/import/map_conf.txt\n",
    [`${prefix}conf/import/map_conf.txt`]: "",
    [`${prefix}npc/re/scripts_main.conf`]: "// scripts du mode renewal\nnpc: npc/re/a.txt\nnpc: npc/shared.txt\n",
    [`${prefix}npc/pre-re/scripts_main.conf`]: "npc: npc/pre-re/a.txt\nnpc: npc/shared.txt\n",
    // `Twin` existe dans les deux modes (variantes exclusives) : un doublon artificiel si on indexe les deux.
    [`${prefix}npc/re/a.txt`]: npc('mes "re";\ncallfunc "F_Shared";\nclose;', "Twin"),
    [`${prefix}npc/pre-re/a.txt`]: npc('mes "pre-re";\nclose;', "Twin"),
    [`${prefix}npc/shared.txt`]: fn("F_Shared"),
    [`${prefix}npc/unloaded.txt`]: npc("close;", "Orphan"),
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
  return (h.store.getState().diagnostics[path]?.diagnostics ?? []).map((d) => d.code);
}

function currentConfig(h: Harness): ProjectConfig {
  const config = h.store.getState().project?.config;
  if (config === undefined) throw new Error("projet absent");
  return config;
}

describe("AppController - serveur et registre de commandes", () => {
  it("reconnait un serveur a la racine du projet et publie son registre (code source du serveur)", async () => {
    const h = harness();
    await loaded(h, serverFiles(""));
    expect(h.store.getState().emulator).toMatchObject({
      status: "ready",
      root: "",
      detected: true,
      candidates: [],
      level: "server-source",
      commands: 5,
      withArity: 5,
      renewal: true,
      renewalSource: "header",
      loadedScripts: null,
    });
  });

  it("reconnait un unique serveur dans un sous-dossier du projet", async () => {
    const h = harness();
    await loaded(h, serverFiles("Serveur/rathena/"));
    expect(h.store.getState().emulator).toMatchObject({ status: "ready", root: "Serveur/rathena", detected: true, commands: 5 });
  });

  it("signale le nombre d'arguments et les commandes inconnues, mais pas les fonctions globales du projet", async () => {
    const h = harness();
    const script = npc('mes;\nF_Shared;\nInconnue 1;\nnext 1;\nclose;', "Probe");
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": script });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual(["RA0006", "RA0001", "RA0006"]);
    const found = h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics ?? [];
    expect(found.map((d) => script.slice(d.range.start, d.range.end))).toEqual(["mes", "Inconnue", "next"]);
    expect(found[1]).toMatchObject({ severity: "warning", params: { name: "Inconnue", profile: "rAthena" } });
  });

  it("applique la politique `unknownCommands` du projet, au demarrage et apres un changement de reglage", async () => {
    const h = harness();
    const script = npc("Inconnue 1;\nclose;", "Probe");
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": script }, { validation: { unknownCommands: "error" } });
    expect(h.store.getState().diagnostics["npc/probe.txt"]).toBeUndefined();
    await diagnosticsOf(h, "npc/probe.txt");
    expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics.map((d) => d.severity)).toEqual(["error"]);

    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, validation: { ...config.validation, unknownCommands: "off" } });
    await vi.waitFor(() => {
      expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics).toEqual([]);
    });
  });

  it("n'alerte sur aucune commande tant que l'indexation n'est pas terminee (la fonction pourrait etre dans un autre fichier)", async () => {
    const h = harness();
    for (const [path, content] of Object.entries({ ...serverFiles(""), "npc/probe.txt": npc("F_Shared;\nclose;", "Probe") })) h.backend.put(path, content);
    // L'indexation est suspendue avant la lecture du premier lot : l'index est vide, F_Shared n'y est pas encore.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const original = h.language.indexFiles.bind(h.language);
    vi.spyOn(h.language, "indexFiles").mockImplementation(async (files, legacyEncoding) => {
      reached = true;
      await gate;
      return original(files, legacyEncoding);
    });
    const seen: string[][] = [];
    h.store.subscribe((state) => {
      const entry = state.diagnostics["npc/probe.txt"];
      if (entry !== undefined) seen.push(entry.diagnostics.map((d) => d.code));
    });
    await h.controller.init();
    await h.controller.loadProject(h.backend.root);
    await vi.waitFor(() => {
      expect(reached).toBe(true);
    });
    await h.controller.openFile("npc/probe.txt");
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.flat()).toEqual([]);

    release();
    await h.controller.whenIndexed();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.flat()).toEqual([]);
    expect(h.store.getState().indexing.status).toBe("done");
  });

  it("ne choisit pas entre plusieurs serveurs et n'invente aucune alerte", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles("Serveur/a/"), ...serverFiles("Serveur/b/"), "npc/probe.txt": npc("Inconnue;\nmes;\nclose;", "Probe") });
    expect(h.store.getState().emulator).toMatchObject({ status: "ambiguous", candidates: ["Serveur/a", "Serveur/b"], commands: 0 });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual([]);
  });

  it("adopte le serveur choisi dans les parametres, reconstruit le registre et relit tout", async () => {
    const h = harness();
    const script = npc("Inconnue;\nmes;\nclose;", "Probe");
    await loaded(h, { ...serverFiles("Serveur/a/"), ...serverFiles("Serveur/b/"), "npc/probe.txt": script });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual([]);
    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, emulator: { ...config.emulator, root: "Serveur/b" } });
    await h.controller.whenIndexed();
    await vi.waitFor(() => {
      expect(h.store.getState().emulator).toMatchObject({ status: "ready", root: "Serveur/b", detected: false, commands: 5 });
      expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics.map((d) => d.code)).toEqual(["RA0001", "RA0006"]);
    });
  });

  it("une racine configuree sans fichiers de serveur donne un serveur sans registre, sans alerte", async () => {
    const h = harness();
    await loaded(h, { "npc/probe.txt": npc("Inconnue;\nmes;\nclose;", "Probe") }, { emulator: { family: "rathena", root: "absent" } });
    expect(h.store.getState().emulator).toMatchObject({ status: "ready", root: "absent", detected: false, level: "none", commands: 0 });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual([]);
  });

  it("garde l'aide integree quand le code source du serveur est absent, sans valider les commandes", async () => {
    const h = harness();
    const files = serverFiles("");
    delete files["src/map/script.cpp"];
    await loaded(h, { ...files, "npc/probe.txt": npc("mes;\nmes 1, 2, 3;\nInconnue;\nclose;", "Probe") });
    expect(h.store.getState().emulator).toMatchObject({ status: "ready", level: "none", commands: 0, withArity: 0 });
    expect(await h.language.commandInfo("mes")).toMatchObject({ name: "mes", documentation: expect.any(String) });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual([]);
  });

  it("n'a pas de registre pour Hercules", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": npc("Inconnue;\nmes;\nclose;", "Probe") }, { emulator: { family: "hercules" } });
    expect(h.store.getState().emulator).toMatchObject({ status: "unsupported", commands: 0 });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual([]);
  });

  it("n'emporte pas le registre d'un projet dans le suivant", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": npc("mes;\nclose;", "Probe") });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual(["RA0006"]);
    await h.controller.closeProject();
    expect(h.store.getState().emulator.status).toBe("none");
    for (const path of [...h.backend.files.keys()]) if (path !== "npc/probe.txt") h.backend.files.delete(path);
    await h.controller.loadProject(h.backend.root);
    await h.controller.whenIndexed();
    expect(h.store.getState().emulator).toMatchObject({ status: "not-found", commands: 0 });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual([]);
  });
});

describe("AppController - portee de l'index : scripts charges par le serveur", () => {
  it("indexe tout ce qui correspond a `sources` par defaut, y compris les variantes exclusives re et pre-re", async () => {
    const h = harness();
    await loaded(h, serverFiles(""), { validation: { crossFile: "duplicates" } });
    const names = (await h.controller.searchSymbols("")).map((symbol) => symbol.name);
    expect(names).toContain("Orphan");
    expect(await diagnosticsOf(h, "npc/re/a.txt")).toEqual(["RA0005"]);
    expect(h.store.getState().emulator.loadedScripts).toBeNull();
  });

  it("n'indexe que les scripts que le serveur charge, dans le mode detecte, et supprime les faux doublons", async () => {
    const h = harness();
    await loaded(h, serverFiles(""), { emulator: { family: "rathena", indexScope: "loaded" }, validation: { crossFile: "all" } });
    const names = (await h.controller.searchSymbols("")).map((symbol) => symbol.name);
    expect(names).toContain("Twin");
    expect(names).toContain("F_Shared");
    expect(names).not.toContain("Orphan");
    expect(h.store.getState().emulator).toMatchObject({ loadedScripts: 2, loadIssues: 0 });
    expect(h.store.getState().indexing).toMatchObject({ status: "done", files: 2, total: 2 });
    expect(await diagnosticsOf(h, "npc/re/a.txt")).toEqual([]);
  });

  it("suit le mode impose par le projet (pre-renewal) et la liste des imports de map_athena.conf", async () => {
    const h = harness();
    const files = { ...serverFiles(""), "conf/import/map_conf.txt": "npc: npc/unloaded.txt\n" };
    await loaded(h, files, { emulator: { family: "rathena", mode: "pre-renewal", indexScope: "loaded" } });
    expect(h.store.getState().emulator).toMatchObject({ renewal: false, renewalSource: "config", loadedScripts: 3 });
    const names = (await h.controller.searchSymbols("")).map((symbol) => symbol.name);
    expect(names).toContain("Orphan");
    expect((await h.controller.searchSymbols("Twin")).map((s) => s.location.uri)).toEqual(["npc/pre-re/a.txt"]);
  });

  it("retombe sur `sources` quand aucun serveur n'est reconnu", async () => {
    const h = harness();
    await loaded(h, { "npc/a.txt": npc("close;", "Alone"), "npc/b.txt": fn("F_B") }, { emulator: { family: "rathena", indexScope: "loaded" } });
    expect(h.store.getState().emulator.status).toBe("not-found");
    expect(h.store.getState().indexing).toMatchObject({ status: "done", files: 2 });
  });

  it("applique un changement de portee sans redemarrer : l'index est reconstruit", async () => {
    const h = harness();
    await loaded(h, serverFiles(""));
    expect((await h.controller.searchSymbols("Orphan")).length).toBe(1);
    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, emulator: { ...config.emulator, indexScope: "loaded" } });
    await h.controller.whenIndexed();
    await vi.waitFor(async () => {
      expect(await h.controller.searchSymbols("Orphan")).toEqual([]);
      expect(h.store.getState().emulator.loadedScripts).toBe(2);
    });
  });
});

describe("AppController - commandes personnalisees du projet (RF-011)", () => {
  const custom = (...commands: { name: string; args?: string; description?: string }[]): Record<string, unknown> => ({ commands: { custom: commands } });

  it("ne signale plus une commande declaree dans le projet et verifie l'arite qu'il declare", async () => {
    const h = harness();
    const script = npc('maquette "a";\nmaquette;\nmaquette 1, 2, 3;\nInconnue;\nsansarite 1, 2, 3;\nclose;', "Probe");
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": script }, custom({ name: "maquette", args: "s?" }, { name: "sansarite" }));
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual(["RA0006", "RA0006", "RA0001"]);
    const found = h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics ?? [];
    expect(found.map((d) => script.slice(d.range.start, d.range.end))).toEqual(["maquette", "maquette", "Inconnue"]);
  });

  it("propose la commande du projet a la completion, avant celles du serveur, avec son origine", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": npc("\tmaq", "Probe") }, custom({ name: "maquette", args: "s?", description: "Commande de mon fork." }));
    await h.controller.openFile("npc/probe.txt");
    const items = await h.controller.completionAt("npc/probe.txt", 2, 5);
    expect(items[0]).toMatchObject({
      label: "maquette",
      command: { source: "project", deprecated: false },
      sortText: expect.stringMatching(/^0/),
    });
    const info = await h.controller.commandInfoOf("maquette");
    expect(info).toMatchObject({ arity: { min: 1, max: 2 }, documentation: "Commande de mon fork.", sources: [{ kind: "project" }] });
  });

  it("declare une commande inconnue d'une action rapide : ecrit project.json, reconstruit le registre, plus d'alerte", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": npc("Inconnue 1;\nclose;", "Probe") });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual(["RA0001"]);
    expect(h.backend.textOf(".runeforge/project.json")).toBeUndefined();

    expect(await h.controller.declareCustomCommand("Inconnue")).toBe(true);
    expect(JSON.parse(h.backend.textOf(".runeforge/project.json") ?? "{}")).toMatchObject({ commands: { custom: [{ name: "Inconnue" }] } });
    expect(h.store.getState().project?.config.commands.custom).toEqual([{ name: "Inconnue", args: null, description: null }]);
    await vi.waitFor(() => {
      expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics).toEqual([]);
    });
    expect(h.store.getState().toasts.at(-1)?.text).toContain("Inconnue");
  });

  it("ne declare pas deux fois la meme commande ni un nom invalide", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": npc("Inconnue 1;\nclose;", "Probe") });
    expect(await h.controller.declareCustomCommand("Inconnue")).toBe(true);
    const writes = h.backend.writes.length;
    expect(await h.controller.declareCustomCommand("INCONNUE")).toBe(true);
    expect(await h.controller.declareCustomCommand("1mauvais")).toBe(false);
    expect(await h.controller.declareCustomCommand("deux mots")).toBe(false);
    expect(h.backend.writes.length).toBe(writes);
    expect(h.store.getState().project?.config.commands.custom).toHaveLength(1);
  });

  it("n'en fait pas un registre : sans serveur, les commandes du projet ne declenchent aucune alerte sur les autres", async () => {
    const h = harness();
    await loaded(h, { "npc/probe.txt": npc("Inconnue;\nmes;\nclose;", "Probe") }, custom({ name: "maquette" }));
    expect(h.store.getState().emulator.status).toBe("not-found");
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual([]);
  });

  it("applique un changement de la liste enregistre dans les parametres a tout le projet", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "npc/probe.txt": npc("maquette 1;\nclose;", "Probe") });
    expect(await diagnosticsOf(h, "npc/probe.txt")).toEqual(["RA0001"]);
    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, commands: { custom: [{ name: "maquette", args: "s", description: null }] } });
    await vi.waitFor(() => {
      expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics.map((d) => d.code)).toEqual([]);
    });
    expect(h.store.getState().emulator.commands).toBe(6);
  });
});

// Bases d'un mini serveur rAthena (objets, monstres, cartes, constantes), redigees pour ces tests.
const TABLE_REFERENCES = TABLE.replace(
  "\t{nullptr,nullptr,nullptr},",
  ['\tBUILDIN_DEF(warp,"sii?"),', '\tBUILDIN_DEF(getitem,"vi?"),', '\tBUILDIN_DEF(monster,"siisvi?????"),', "\t{nullptr,nullptr,nullptr},"].join("\n"),
);
const MANUAL_REFERENCES = [
  MANUAL,
  '*warp "<map name>",<x>,<y>;',
  "",
  "Envoie le joueur.",
  "",
  "*getitem <item id>,<amount>;",
  '*getitem "<item name>",<amount>;',
  "",
  "Donne un objet.",
  "",
  '*monster "<map name>",<x>,<y>,"<name to show>",<mob id>,<amount>;',
  "",
  "Fait apparaitre un monstre.",
  "",
].join("\n");

function databaseFiles(prefix: string): Record<string, string> {
  return {
    ...serverFiles(prefix),
    [`${prefix}src/map/script.cpp`]: TABLE_REFERENCES,
    [`${prefix}doc/script_commands.txt`]: MANUAL_REFERENCES,
    [`${prefix}db/item_db.yml`]: ["Header:", "  Type: ITEM_DB", "  Version: 3", "Footer:", "  Imports:", "  - Path: db/pre-re/item_db.yml", "    Mode: Prerenewal", "  - Path: db/re/item_db.yml", "    Mode: Renewal", "  - Path: db/import/item_db.yml"].join("\n"),
    [`${prefix}db/re/item_db.yml`]: ["Body:", "  - Id: 501", "    AegisName: Red_Potion", "    Name: Red Potion", "    Type: Healing", "  - Id: 502", "    AegisName: Orange_Potion", "    Name: Orange Potion", "    Type: Healing"].join("\n"),
    [`${prefix}db/pre-re/item_db.yml`]: ["Body:", "  - Id: 9999", "    AegisName: Pre_Only", "    Name: Pre Only"].join("\n"),
    [`${prefix}db/import/item_db.yml`]: ["Body:", "  - Id: 30000", "    AegisName: My_Item", "    Name: Mon objet"].join("\n"),
    [`${prefix}db/mob_db.yml`]: ["Footer:", "  Imports:", "  - Path: db/re/mob_db.yml", "    Mode: Renewal"].join("\n"),
    [`${prefix}db/re/mob_db.yml`]: ["Body:", "  - Id: 1002", "    AegisName: PORING", "    Name: Poring", "    Level: 1"].join("\n"),
    [`${prefix}db/map_index.txt`]: "// index\nprontera 1\nprt_fild08\n",
    [`${prefix}db/const.yml`]: ["Body:", "  - Name: SWORDCLAN", "    Value: 1"].join("\n"),
    [`${prefix}src/map/script_constants.hpp`]: ["export_constant(Job_Alchemist);", 'export_parameter("BaseLevel",SP_BASELEVEL);'].join("\n"),
  };
}

describe("AppController - bases du serveur : objets, monstres, cartes, constantes (RF-012)", () => {
  const probe = npc(
    [
      '\twarp "nowhere",1,1;',
      '\twarp "prontera",1,1;',
      "\tgetitem 99999,1;",
      "\tgetitem 501,1;",
      '\tgetitem "Red_Potion",1;',
      '\tmonster "prontera",1,1,"x",9999,1;',
      '\tmonster "prontera",1,1,"x",1002,1;',
      "\tclose;",
    ].join("\n"),
    "Probe",
  );
  const referenceCodes = async (h: Harness, path: string): Promise<string[]> => (await diagnosticsOf(h, path)).filter((code) => ["RA0008", "RA0009", "RA0010"].includes(code));

  it("lit les bases que le serveur charge (selon son mode) et publie ce qu'elles contiennent", async () => {
    const h = harness();
    await loaded(h, { ...databaseFiles(""), "npc/probe.txt": probe });
    // Mode renewal : db/re/ et db/import/, pas db/pre-re/ (variantes exclusives).
    expect(h.store.getState().emulator.catalog).toEqual({ items: 3, mobs: 1, skills: 0, maps: 2, constants: 3, loadedMaps: null });
    expect(h.store.getState().emulator.catalogWarnings).toEqual([]);
    expect((await h.controller.searchReferences("item", "pre", 10)).map((hit) => hit.name)).toEqual([]);
    expect((await h.controller.searchReferences("item", "red", 10)).map((hit) => hit.name)).toEqual(["Red_Potion"]);
  });

  it("charge les competences meme si elles sont la seule base disponible", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "db/skill_db.yml": "Body:\n  - Id: 44\n    Name: TEST_SKILL\n    Description: Test Skill\n    MaxLevel: 5" });
    expect(h.store.getState().emulator.catalog).toMatchObject({ items: 0, mobs: 0, skills: 1 });
    expect(await h.controller.searchReferences("skill", "test skill", 1)).toMatchObject([{ id: 44, name: "TEST_SKILL", source: "db/skill_db.yml:2" }]);
  });

  it("lit les options aleatoires du serveur : une constante RDMOPT_<Option> par option, selon le mode de compilation", async () => {
    const h = harness();
    const randomOptions = {
      "db/item_randomopt_db.yml": ["Header:", "  Type: RANDOM_OPTION_DB", "Footer:", "  Imports:", "  - Path: db/pre-re/item_randomopt_db.yml", "    Mode: Prerenewal", "  - Path: db/re/item_randomopt_db.yml", "    Mode: Renewal", "  - Path: db/import/item_randomopt_db.yml"].join("\n"),
      "db/re/item_randomopt_db.yml": ["Body:", "  - Id: 1", "    Option: VAR_MAXHPAMOUNT", "    Script: |", "      bonus bMaxHP,1;", "  - Id: 3", "    Option: VAR_STRAMOUNT", "    Script: |", "      bonus bStr,1;"].join("\n"),
      "db/pre-re/item_randomopt_db.yml": ["Body:", "  - Id: 9", "    Option: PRE_ONLY", "    Script: |", "      bonus bStr,1;"].join("\n"),
      "db/import/item_randomopt_db.yml": ["Body:", "  - Id: 500", "    Option: MY_OPTION", "    Script: |", "      bonus bStr,1;"].join("\n"),
    };
    await loaded(h, { ...databaseFiles(""), ...randomOptions, "npc/probe.txt": probe });
    // 3 constantes des bases + 3 options (celle du mode pre-renewal n'est pas lue).
    expect(h.store.getState().emulator.catalog).toMatchObject({ constants: 6 });
    expect((await h.controller.searchReferences("constant", "rdmopt_", 10)).map((hit) => [hit.name, hit.id, hit.source])).toEqual([
      ["RDMOPT_VAR_MAXHPAMOUNT", 1, "db/re/item_randomopt_db.yml:2"],
      ["RDMOPT_VAR_STRAMOUNT", 3, "db/re/item_randomopt_db.yml:6"],
      ["RDMOPT_MY_OPTION", 500, "db/import/item_randomopt_db.yml:2"],
    ]);
  });

  it("un label portant le nom d'une constante RDMOPT_ est refuse comme n'importe quelle constante du serveur (RA0014)", async () => {
    const h = harness();
    const files = {
      "db/item_randomopt_db.yml": "Footer:\n  Imports:\n  - Path: db/import/item_randomopt_db.yml",
      "db/import/item_randomopt_db.yml": ["Body:", "  - Id: 7", "    Option: VAR_X", "    Script: |", "      bonus bStr,1;"].join("\n"),
    };
    await loaded(h, { ...databaseFiles(""), ...files, "npc/l.txt": npc("\tgoto rdmopt_var_x;\nRDMOPT_VAR_X:\n\tclose;", "Labels") });
    expect(await diagnosticsOf(h, "npc/l.txt")).toEqual(["RA0014"]);
  });

  it("signale un objet, un monstre ou une carte introuvable, pas ceux qui existent", async () => {
    const h = harness();
    await loaded(h, { ...databaseFiles(""), "npc/probe.txt": probe });
    expect(await referenceCodes(h, "npc/probe.txt")).toEqual(["RA0008", "RA0009", "RA0010"]);
  });

  it("propose les objets d'un argument d'objet et decrit un objet au survol", async () => {
    const h = harness();
    await loaded(h, { ...databaseFiles(""), "npc/c.txt": npc("\tgetitem ", "C"), "npc/probe.txt": probe });
    await h.controller.openFile("npc/c.txt");
    const items = (await h.controller.completionAt("npc/c.txt", 2, 10, true)).filter((item) => item.reference !== undefined);
    expect(items.map((item) => [item.label, item.insertText])).toEqual([["Red_Potion", "501"], ["Orange_Potion", "502"], ["My_Item", "30000"]]);
    await h.controller.openFile("npc/probe.txt");
    // Ligne 5 : `\tgetitem 501,1;` : le curseur est sur le nombre.
    const hover = await h.controller.hoverAt("npc/probe.txt", 5, 11);
    expect(hover).toMatchObject({ kind: "reference", referenceKind: "item", record: { id: 501, aegisName: "Red_Potion" } });
  });

  it("insere l'identifiant ou le nom d'une reference a la place de la selection, entre guillemets quand il le faut", async () => {
    const inserted: Inserted[] = [];
    const h = harness(inserted);
    await loaded(h, { ...databaseFiles(""), "npc/probe.txt": probe });
    const [potion] = await h.controller.searchReferences("item", "red", 1);
    const [poring] = await h.controller.searchReferences("mob", "poring", 1);
    const [prontera] = await h.controller.searchReferences("map", "prontera", 1);
    const [alchemist] = await h.controller.searchReferences("constant", "job_a", 1);
    if (potion === undefined || poring === undefined || prontera === undefined || alchemist === undefined) throw new Error("recherche vide");
    expect(h.controller.insertReference(potion, "id")).toBe("501");
    expect(h.controller.insertReference(potion, "name")).toBe('"Red_Potion"');
    expect(h.controller.insertReference(poring, "id")).toBe("1002");
    expect(h.controller.insertReference(prontera, "id")).toBe('"prontera"');
    expect(h.controller.insertReference(alchemist, "id")).toBe("Job_Alchemist");
    expect(inserted).toEqual([
      { text: "501", insideString: undefined },
      { text: '"Red_Potion"', insideString: "Red_Potion" },
      { text: "1002", insideString: undefined },
      { text: '"prontera"', insideString: "prontera" },
      { text: "Job_Alchemist", insideString: undefined },
    ]);
  });

  it("regle la gravite des alertes de reference, ou les supprime", async () => {
    const h = harness();
    await loaded(h, { ...databaseFiles(""), "npc/probe.txt": probe });
    expect(await referenceCodes(h, "npc/probe.txt")).toHaveLength(3);
    expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics.find((d) => d.code === "RA0009")?.severity).toBe("info");
    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, validation: { ...config.validation, unknownReferences: "warning" } });
    await vi.waitFor(() => {
      expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics.find((d) => d.code === "RA0009")?.severity).toBe("warning");
    });
    await h.controller.saveProjectConfig({ ...currentConfig(h), validation: { ...currentConfig(h).validation, unknownReferences: "off" } });
    await vi.waitFor(() => {
      expect(h.store.getState().diagnostics["npc/probe.txt"]?.diagnostics.map((d) => d.code).filter((code) => code.startsWith("RA00") && code >= "RA0008")).toEqual([]);
    });
  });

  it("ajoute les constantes du projet a celles du serveur", async () => {
    const h = harness();
    await loaded(h, { ...databaseFiles(""), "npc/probe.txt": probe });
    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, constants: { custom: [{ name: "MY_EVENT", value: 7 }] } });
    await h.controller.whenIndexed();
    await vi.waitFor(() => {
      expect(h.store.getState().emulator.catalog?.constants).toBe(4);
    });
    expect((await h.controller.searchReferences("constant", "my_ev", 5)).map((hit) => [hit.name, hit.id, hit.source])).toEqual([["MY_EVENT", 7, ".runeforge/project.json"]]);
  });

  it("n'a pas de catalogue sans serveur reconnu, ni pour Hercules, et le retire en changeant d'emulateur", async () => {
    const none = harness();
    await loaded(none, { "npc/probe.txt": probe });
    expect(none.store.getState().emulator.catalog).toBeNull();
    expect(await none.controller.searchReferences("item", "red", 5)).toEqual([]);

    const h = harness();
    await loaded(h, { ...databaseFiles(""), "npc/probe.txt": probe });
    expect(h.store.getState().emulator.catalog).not.toBeNull();
    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, emulator: { ...config.emulator, family: "hercules" } });
    await h.controller.whenIndexed();
    await vi.waitFor(() => {
      expect(h.store.getState().emulator.catalog).toBeNull();
    });
    expect(await h.controller.searchReferences("item", "red", 5)).toEqual([]);
    expect(await referenceCodes(h, "npc/probe.txt")).toEqual([]);
  });

  it("signale dans les avertissements ce que les bases contiennent de non lu", async () => {
    const h = harness();
    await loaded(h, { ...databaseFiles(""), "db/re/item_db.yml": ["Body:", "  - Id: 501", "    AegisName: Red_Potion", "    Name: Red Potion", "  - oops"].join("\n") });
    expect(h.store.getState().emulator.catalogWarnings).toEqual(["objets : ligne non comprise a db/re/item_db.yml:5"]);
  });
});

describe("AppController - cartes chargees par le serveur : RA0008 et RA0015 sur les declarations", () => {
  // L'index (db/map_index.txt) connait prontera et prt_fild08 ; le serveur ne charge que prontera (prt_fild08 est en commentaire).
  const withMaps = (prefix: string): Record<string, string> => ({
    ...databaseFiles(prefix),
    [`${prefix}conf/map_athena.conf`]: "import: conf/maps_athena.conf\nimport: conf/import/map_conf.txt\n",
    [`${prefix}conf/maps_athena.conf`]: "// cartes\nmap: prontera\n//map: prt_fild08\n",
  });
  const declaration = (map: string, name: string): string => `${map},10,10,4\tscript\t${name}\t100,{\n\tclose;\n}\n`;
  const placed = declaration("prontera", "Charge") + declaration("prt_fild08", "NonCharge") + declaration("nowhere", "Inconnue");
  const mapCodes = async (h: Harness, path: string): Promise<string[]> => (await diagnosticsOf(h, path)).filter((code) => code === "RA0008" || code === "RA0015");

  it("publie le nombre de cartes que le serveur charge, lu dans la configuration de la map et ses imports", async () => {
    const h = harness();
    await loaded(h, { ...withMaps(""), "npc/placed.txt": placed });
    expect(h.store.getState().emulator.catalog).toEqual({ items: 3, mobs: 1, skills: 0, maps: 2, constants: 3, loadedMaps: 1 });
  });

  it("signale une declaration sur une carte de l'index que le serveur ne charge pas (RA0015) et sur une carte inconnue (RA0008), pas sur une carte chargee", async () => {
    const h = harness();
    await loaded(h, { ...withMaps(""), "npc/placed.txt": placed });
    expect(await mapCodes(h, "npc/placed.txt")).toEqual(["RA0015", "RA0008"]);
    const found = h.store.getState().diagnostics["npc/placed.txt"]?.diagnostics ?? [];
    expect(found.map((d) => [d.code, placed.slice(d.range.start, d.range.end)])).toEqual([
      ["RA0015", "prt_fild08"],
      ["RA0008", "nowhere"],
    ]);
    expect(found.map((d) => d.severity)).toEqual(["info", "info"]);
  });

  it("applique le reglage des references introuvables aux deux codes", async () => {
    const off = harness();
    await loaded(off, { ...withMaps(""), "npc/placed.txt": placed }, { validation: { unknownReferences: "off" } });
    expect(await mapCodes(off, "npc/placed.txt")).toEqual([]);

    const warning = harness();
    await loaded(warning, { ...withMaps(""), "npc/placed.txt": placed }, { validation: { unknownReferences: "warning" } });
    await mapCodes(warning, "npc/placed.txt");
    expect((warning.store.getState().diagnostics["npc/placed.txt"]?.diagnostics ?? []).map((d) => [d.code, d.severity])).toEqual([
      ["RA0015", "warning"],
      ["RA0008", "warning"],
    ]);
  });

  it("sans carte dans la configuration de la map, la liste est inconnue : aucune carte n'est dite non chargee, mais l'index reste verifie", async () => {
    const h = harness();
    await loaded(h, { ...databaseFiles(""), "npc/placed.txt": placed });
    expect(h.store.getState().emulator.catalog?.loadedMaps).toBeNull();
    expect(await mapCodes(h, "npc/placed.txt")).toEqual(["RA0008"]);
  });

  it("lit la configuration d'un serveur place dans un sous-dossier du projet", async () => {
    const h = harness();
    await loaded(h, { ...withMaps("Serveur/rathena/"), "npc/placed.txt": placed });
    expect(h.store.getState().emulator.catalog?.loadedMaps).toBe(1);
    expect(await mapCodes(h, "npc/placed.txt")).toEqual(["RA0015", "RA0008"]);
  });

  it("ne signale pas une ligne mapflag sur une carte non chargee (la distribution en livre pour des cartes desactivees), mais sur une carte inconnue", async () => {
    const h = harness();
    await loaded(h, { ...withMaps(""), "npc/flags.txt": "prt_fild08\tmapflag\tnoteleport\nnowhere\tmapflag\tnoteleport\n" });
    expect(await mapCodes(h, "npc/flags.txt")).toEqual(["RA0008"]);
  });
});

describe("AppController - modeles de NPC", () => {
  it("propose les modeles dans un fichier vide pour un projet rAthena, et plus rien quand l'emulateur change", async () => {
    const h = harness();
    await loaded(h, { ...serverFiles(""), "npc/new.txt": "npc-" });
    await h.controller.openFile("npc/new.txt");
    const items = await h.controller.completionAt("npc/new.txt", 1, 5);
    expect(items.map((item) => item.label)).toEqual(["npc-shop", "npc-warp", "npc-healer", "npc-script"]);
    expect(items[0]).toMatchObject({ format: "snippet", template: "npc-shop" });

    const config = currentConfig(h);
    await h.controller.saveProjectConfig({ ...config, emulator: { ...config.emulator, family: "hercules" } });
    await h.controller.whenIndexed();
    await vi.waitFor(async () => {
      expect(await h.controller.completionAt("npc/new.txt", 1, 5, true)).toEqual([]);
    });
  });
});


describe("AppController - profil de simulation", () => {
  it.each(["rathena", "hercules"] as const)("utilise la configuration %s sans inventer de membre EmulatorState", async (family) => {
    const h = harness();
    const source = npc('mes "Hello"; close;');
    await loaded(h, { "npc/test.txt": source }, { emulator: { family } });
    await h.controller.openFile("npc/test.txt");
    const emulator = new Proxy(h.store.getState().emulator, {
      get(target, key, receiver) {
        if (!(key in target)) throw new Error("Unknown EmulatorState member: " + String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    h.store.setState({ emulator });
    h.controller.openSimulation();
    if (family === "hercules") {
      expect(h.store.getState().dialog).toBeNull();
      expect(h.store.getState().toasts.at(-1)?.text).toContain("rAthena");
    } else {
      expect(h.store.getState().dialog).toEqual({ kind: "simulation", source, declarationStart: 0 });
    }
    expect(h.backend.textOf("npc/test.txt")).toBe(source);
    h.controller.dispose();
  });

  it("n'oppose aucun refus a un fichier volumineux, a un NPC sans fermeture ni a un NPC avec erreur de syntaxe", async () => {
    const h = harness();
    // Le plus gros script du serveur de reference depasse 600 Kio : l'ancien plafond (512 Kio) refusait ces fichiers.
    const big = `// ${"x".repeat(700_000)}\n${npc('mes "Hello"; close;')}`;
    const unclosed = 'prontera,150,150,4\tscript\tOpen\t100,{\n\tmes "a";\n';
    const broken = npc('mes "a";\n\t.@x = ;\nmes "b";');
    await loaded(h, { "npc/big.txt": big, "npc/open.txt": unclosed, "npc/broken.txt": broken });
    for (const [path, text] of [["npc/big.txt", big], ["npc/open.txt", unclosed], ["npc/broken.txt", broken]] as const) {
      await h.controller.openFile(path);
      h.controller.openSimulation();
      expect(h.store.getState().dialog).toEqual({ kind: "simulation", source: text, declarationStart: text.indexOf("prontera,") });
      h.controller.closeDialog();
    }
    expect(h.store.getState().toasts).toEqual([]);
    h.controller.dispose();
  });

  it("explique qu'un fichier sans NPC n'a rien a simuler, et qu'un fichier de plus de 4 Mi caracteres est trop gros", async () => {
    const h = harness();
    await loaded(h, { "npc/functions.txt": fn("F_Only"), "npc/huge.txt": `// ${"x".repeat(4 * 1024 * 1024)}\n${npc("close;")}` });
    await h.controller.openFile("npc/functions.txt");
    h.controller.openSimulation();
    expect(h.store.getState().dialog).toBeNull();
    expect(h.store.getState().toasts.at(-1)?.text).toBe("Ce fichier ne contient aucun NPC avec un script à simuler.");
    await h.controller.openFile("npc/huge.txt");
    h.controller.openSimulation();
    expect(h.store.getState().dialog).toBeNull();
    expect(h.store.getState().toasts.at(-1)?.text).toContain("4 M caractères");
    h.controller.dispose();
  });
});
