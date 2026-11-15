import { describe, expect, it } from "vitest";
import { RATHENA_SCRIPT_LIBRARY, RATHENA_SCRIPT_LIBRARY_INFO } from "@runeforge/emulator-rathena";
import { InProcessWorker } from "../test/in-process-worker";
import { createDispatcher } from "./dispatch";
import { LanguageClient } from "./language-client";
import type { LanguageMethod, LanguageMethods, LanguageRequest } from "./protocol";

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;
const fn = (name: string): string => `function\tscript\t${name}\t{\n\treturn;\n}\n`;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

let counter = 0;
function ask<M extends LanguageMethod>(
  dispatcher: ReturnType<typeof createDispatcher>,
  method: M,
  params: LanguageMethods[M]["params"],
): LanguageMethods[M]["result"] {
  const response = dispatcher.handle({ id: (counter += 1), method, params } as LanguageRequest);
  if (!response.ok) throw new Error(response.error);
  return response.result as LanguageMethods[M]["result"];
}

describe("dispatcher du worker de langage", () => {
  it("analyse un document : diagnostics de syntaxe et de semantique locale", () => {
    const dispatcher = createDispatcher();
    const result = ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text: npc("goto L_Missing;\nclose;") });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["RA0002"]);
    expect(result.truncated).toBe(false);
  });

  it("decode les octets des fichiers du projet puis resout une definition entre fichiers", () => {
    const dispatcher = createDispatcher();
    const outcome = ask(dispatcher, "indexFiles", {
      files: [{ uri: "lib.txt", bytes: bytes(fn("F_Lib")) }],
      legacyEncoding: "windows-1252",
    });
    expect(outcome).toEqual({ indexed: 1, skipped: [] });
    ask(dispatcher, "analyze", { uri: "main.txt", version: 1, text: npc('callfunc "F_Lib";\nclose;') });
    const found = ask(dispatcher, "definition", { uri: "main.txt", position: { line: 1, character: 12 } });
    expect(found).toEqual([{ uri: "lib.txt", range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } }]);
  });

  it("lit un fichier en encodage herite (windows-1252) sans le corrompre", () => {
    const dispatcher = createDispatcher();
    const latin1 = Uint8Array.from(Buffer.from(`function\tscript\tF_Caf\xe9\t{\n\treturn;\n}\n`, "latin1"));
    expect(ask(dispatcher, "indexFiles", { files: [{ uri: "legacy.txt", bytes: latin1 }], legacyEncoding: "windows-1252" }).indexed).toBe(1);
    expect(ask(dispatcher, "workspaceSymbols", { query: "caf", limit: 5 }).map((s) => s.name)).toEqual(["F_Caf\u00e9"]);
  });

  it("applique les options de verification entre fichiers", () => {
    const dispatcher = createDispatcher();
    ask(dispatcher, "indexFiles", { files: [{ uri: "lib.txt", bytes: bytes(npc("close;", "Twin")) }], legacyEncoding: "windows-1252" });
    ask(dispatcher, "analyze", { uri: "main.txt", version: 1, text: npc("close;", "Twin") });
    expect(ask(dispatcher, "diagnostics", { uri: "main.txt" })).toEqual([]);
    ask(dispatcher, "setOptions", { crossFile: "duplicates" });
    expect(ask(dispatcher, "diagnostics", { uri: "main.txt" }).map((d) => d.code)).toEqual(["RA0005"]);
  });

  it("retire des fichiers, vide l'index et renvoie des statistiques", () => {
    const dispatcher = createDispatcher();
    ask(dispatcher, "indexFiles", { files: [{ uri: "a.txt", bytes: bytes(fn("F_A")) }, { uri: "b.txt", bytes: bytes(fn("F_B")) }], legacyEncoding: "windows-1252" });
    expect(ask(dispatcher, "stats", {})).toMatchObject({ files: 2, functions: 2 });
    ask(dispatcher, "removeFiles", { uris: ["a.txt"] });
    expect(ask(dispatcher, "stats", {})).toMatchObject({ files: 1, functions: 1 });
    ask(dispatcher, "clearIndex", {});
    expect(ask(dispatcher, "stats", {})).toMatchObject({ files: 0, functions: 0 });
  });

  it("repond par une erreur (sans lever) a une methode inconnue", () => {
    const response = createDispatcher().handle({ id: 1, method: "nope", params: {} } as unknown as LanguageRequest);
    expect(response.ok).toBe(false);
  });
});

class FakeWorker extends InProcessWorker {}

describe("LanguageClient", () => {
  it("transmet le chemin du document et resout les requetes par identifiant", async () => {
    const worker = new FakeWorker();
    const client = new LanguageClient(() => worker);
    const [first, second] = await Promise.all([
      client.analyze("npc/a.txt", 1, npc("goto L_X;\nL_X:\nclose;")),
      client.analyze("npc/b.txt", 1, npc("goto L_None;\nclose;")),
    ]);
    expect(worker.sent.map((m) => (m.params as { uri: string }).uri)).toEqual(["npc/a.txt", "npc/b.txt"]);
    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics.map((d) => d.code)).toEqual(["RA0002"]);
  });

  it("indexe puis navigue : definition et references entre fichiers", async () => {
    const client = new LanguageClient(() => new FakeWorker());
    await client.indexFiles([{ uri: "lib.txt", bytes: bytes(fn("F_Lib")) }], "windows-1252");
    await client.analyze("main.txt", 1, npc('callfunc "F_Lib";\nclose;'));
    const at = { line: 1, character: 12 };
    expect((await client.definition("main.txt", at)).map((l) => l.uri)).toEqual(["lib.txt"]);
    expect((await client.references("main.txt", at, true)).map((l) => l.uri).sort()).toEqual(["lib.txt", "main.txt"]);
    expect((await client.documentSymbols("main.txt")).map((s) => s.name)).toEqual(["Test"]);
    expect(await client.stats()).toMatchObject({ files: 2, openDocuments: 1 });
  });

  it("rejette la requete si le worker repond par une erreur", async () => {
    const worker = new FakeWorker();
    const client = new LanguageClient(() => worker);
    await expect(client.request("nope" as LanguageMethod, {} as never)).rejects.toThrow();
  });

  it("rejette les requetes en attente si le worker plante", async () => {
    const worker = new FakeWorker();
    worker.postMessage = () => undefined;
    const client = new LanguageClient(() => worker);
    const pending = client.analyze("npc/a.txt", 1, "x");
    worker.onerror?.({} as ErrorEvent);
    await expect(pending).rejects.toThrow("language worker failed");
    expect(worker.terminated).toBe(true);
  });
});

describe("registre de commandes du serveur (setCommandSources)", () => {
  const TABLE = ["struct script_function buildin_func[] = {", '\tBUILDIN_DEF(mes,"s*"),', '\tBUILDIN_DEF(close,""),', "\t{nullptr,nullptr,nullptr},", "};"].join("\n");
  const sources = (over: Partial<LanguageMethods["setCommandSources"]["params"]> = {}): LanguageMethods["setCommandSources"]["params"] => ({
    family: "rathena",
    builtinSource: bytes(TABLE),
    customBuiltins: null,
    legacyEncoding: "windows-1252",
    ...over,
  });

  it("construit le registre depuis les octets des fichiers du serveur et applique l'arite et la politique", () => {
    const dispatcher = createDispatcher();
    expect(ask(dispatcher, "setCommandSources", sources())).toEqual({
      level: "server-source",
      commands: 2,
      withArity: 2,
      sourceCommands: 2,
      customCommands: 0,
      docCommands: 0,
      projectCommands: 0,
      warnings: [],
    });
    const text = npc("mes;\nInconnue 1;\nclose;");
    const result = ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text });
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["RA0006", "warning"],
      ["RA0001", "warning"],
    ]);
    ask(dispatcher, "setOptions", { unknownCommands: "off" });
    expect(ask(dispatcher, "diagnostics", { uri: "a.txt" }).map((d) => d.code)).toEqual(["RA0006"]);
  });

  it("ne valide aucune commande sans source serveur", () => {
    const dispatcher = createDispatcher();
    const summary = ask(dispatcher, "setCommandSources", sources({ builtinSource: null }));
    expect(summary).toMatchObject({ level: "none", commands: 0, sourceCommands: 0, docCommands: 0 });
    const result = ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text: npc("mes;\nmes 1, 2, 3;\nInconnue;") });
    expect(result.diagnostics).toEqual([]);
  });

  it("lit les commandes personnalisees du serveur", () => {
    const dispatcher = createDispatcher();
    const summary = ask(dispatcher, "setCommandSources", sources({ customBuiltins: bytes('BUILDIN_DEF(maquette,"i?"),\n') }));
    expect(summary).toMatchObject({ level: "server-source", commands: 3, customCommands: 1, docCommands: 0 });
    const result = ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text: npc("maquette 1;\nmaquette 1, 2, 3;\nclose;") });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["RA0006"]);
  });

  it("ne cree aucun registre pour un emulateur sans adaptateur (Hercules) et retire le precedent", () => {
    const dispatcher = createDispatcher();
    ask(dispatcher, "setCommandSources", sources());
    expect(ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text: npc("mes;") }).diagnostics).toHaveLength(1);
    const summary = ask(dispatcher, "setCommandSources", sources({ family: "hercules" }));
    expect(summary).toMatchObject({ level: "none", commands: 0 });
    expect(ask(dispatcher, "diagnostics", { uri: "a.txt" })).toEqual([]);
  });

  it("sans fichier exploitable, retire le registre et toute alerte de commande", () => {
    const dispatcher = createDispatcher();
    ask(dispatcher, "setCommandSources", sources());
    const summary = ask(dispatcher, "setCommandSources", sources({ builtinSource: null }));
    expect(summary.level).toBe("none");
    expect(ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text: npc("mes;\nInconnue;") }).diagnostics).toEqual([]);
  });

  it("passe par le client comme les autres requetes", async () => {
    const client = new LanguageClient(() => new InProcessWorker());
    expect((await client.setCommandSources(sources())).level).toBe("server-source");
    expect((await client.analyze("a.txt", 1, npc("mes;"))).diagnostics.map((d) => d.code)).toEqual(["RA0006"]);
  });
});

describe("ordre de chargement des scripts (RA0016)", () => {
  const TABLE = ["struct script_function buildin_func[] = {", '\tBUILDIN_DEF(close,""),', "\t{nullptr,nullptr,nullptr},", "};"].join("\n");
  const sources = { family: "rathena" as const, builtinSource: bytes(TABLE), customBuiltins: null, legacyEncoding: "windows-1252" };
  const caller = npc("F_Lib;\n\tclose;");
  const codes = (dispatcher: ReturnType<typeof createDispatcher>): string[] => ask(dispatcher, "diagnostics", { uri: "main.txt" }).map((d) => d.code);

  function ready(): ReturnType<typeof createDispatcher> {
    const dispatcher = createDispatcher();
    ask(dispatcher, "setCommandSources", sources);
    ask(dispatcher, "indexFiles", { files: [{ uri: "lib.txt", bytes: bytes(fn("F_Lib")) }], legacyEncoding: "windows-1252" });
    ask(dispatcher, "analyze", { uri: "main.txt", version: 1, text: caller });
    return dispatcher;
  }

  it("signale l'appel d'une fonction chargee apres l'appelant, jusqu'a ce que l'ordre change ou soit retire", () => {
    const dispatcher = ready();
    expect(codes(dispatcher)).toEqual([]);
    expect(ask(dispatcher, "setLoadOrder", { files: ["main.txt", "lib.txt"] })).toBeNull();
    expect(codes(dispatcher)).toEqual(["RA0016"]);
    ask(dispatcher, "setLoadOrder", { files: ["lib.txt", "main.txt"] });
    expect(codes(dispatcher)).toEqual([]);
    ask(dispatcher, "setLoadOrder", { files: ["main.txt", "lib.txt"] });
    ask(dispatcher, "setLoadOrder", { files: null });
    expect(codes(dispatcher)).toEqual([]);
  });

  it("figure dans le rapport de projet comme un probleme du fichier", () => {
    const dispatcher = ready();
    ask(dispatcher, "setLoadOrder", { files: ["main.txt", "lib.txt"] });
    const report = ask(dispatcher, "projectReport", {});
    expect(report.files.map((file) => [file.uri, file.items.map((item) => item.diagnostic.code)])).toEqual([["main.txt", ["RA0016"]]]);
    expect(report.totals.errors).toBe(1);
    expect(report.byCode).toEqual([{ code: "RA0016", count: 1 }]);
  });

  it("analyse un texte hors projet (apercu d'un assistant) sans l'indexer ni le retenir", async () => {
    const dispatcher = ready();
    const before = ask(dispatcher, "stats", {});
    expect(ask(dispatcher, "previewDiagnostics", { text: npc("Inconnue;\n\tclose;") }).map((d) => d.code)).toEqual(["RA0001"]);
    expect(ask(dispatcher, "previewDiagnostics", { text: npc("F_Lib;\n\tclose;") })).toEqual([]);
    expect(ask(dispatcher, "stats", {})).toEqual(before);

    const client = new LanguageClient(() => new InProcessWorker());
    await client.setCommandSources(sources);
    expect((await client.previewDiagnostics(npc("Inconnue;\n\tclose;"))).map((d) => d.code)).toEqual(["RA0001"]);
  });

  it("passe par le client comme les autres requetes, et accepte une liste en lecture seule", async () => {
    const client = new LanguageClient(() => new InProcessWorker());
    await client.setCommandSources(sources);
    await client.indexFiles([{ uri: "lib.txt", bytes: bytes(fn("F_Lib")) }], "windows-1252");
    await client.analyze("main.txt", 1, caller);
    const order: readonly string[] = ["main.txt", "lib.txt"];
    await client.setLoadOrder(order);
    expect((await client.diagnostics("main.txt")).map((d) => d.code)).toEqual(["RA0016"]);
    await client.setLoadOrder(null);
    expect(await client.diagnostics("main.txt")).toEqual([]);
  });
});

describe("commandes dans l'editeur (completion, aide de signature, informations)", () => {
  const TABLE = [
    "struct script_function buildin_func[] = {",
    '\tBUILDIN_DEF(mes,"s*"),',
    '\tBUILDIN_DEF(close,""),',
    '\tBUILDIN_DEF(warp,"sii?"),',
    "\t{nullptr,nullptr,nullptr},",
    "};",
  ].join("\n");
  const ready = (): ReturnType<typeof createDispatcher> => {
    const dispatcher = createDispatcher();
    ask(dispatcher, "setCommandSources", { family: "rathena", builtinSource: bytes(TABLE), customBuiltins: null, legacyEncoding: "windows-1252" });
    return dispatcher;
  };

  it("propose les commandes sur demande explicite seulement quand aucun fragment n'est saisi", () => {
    const dispatcher = ready();
    const text = npc("\tclose;\n\t");
    ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text });
    const position = { line: 2, character: 1 };
    expect(ask(dispatcher, "completion", { uri: "a.txt", position })).toEqual([]);
    expect(ask(dispatcher, "completion", { uri: "a.txt", position, explicit: false })).toEqual([]);
    const labels = ask(dispatcher, "completion", { uri: "a.txt", position, explicit: true }).map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(["mes", "close", "warp", "if"]));
  });

  it("donne l'aide de signature et les informations de la commande", () => {
    const dispatcher = ready();
    ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text: npc('\twarp "prontera", ') });
    const help = ask(dispatcher, "signatureHelp", { uri: "a.txt", position: { line: 1, character: 19 } });
    expect(help?.signatures[0]?.label).toBe("warp(string, int, int, [optional])");
    expect(help?.activeParameter).toBe(1);
    expect(ask(dispatcher, "commandInfo", { name: "MES" })).toMatchObject({ name: "mes", arity: { min: 1, max: null } });
    expect(ask(dispatcher, "commandInfo", { name: "inconnue" })).toBeNull();
  });

  it("decrit une commande au survol et ne repond rien sans registre", () => {
    const dispatcher = createDispatcher();
    ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text: npc('\tmes "a";') });
    expect(ask(dispatcher, "hover", { uri: "a.txt", position: { line: 1, character: 2 } })).toBeNull();
    expect(ask(dispatcher, "signatureHelp", { uri: "a.txt", position: { line: 1, character: 5 } })).toBeNull();
    const registered = ready();
    ask(registered, "analyze", { uri: "a.txt", version: 1, text: npc('\tmes "a";') });
    expect(ask(registered, "hover", { uri: "a.txt", position: { line: 1, character: 2 } })).toMatchObject({ kind: "command", name: "mes" });
  });

  it("passe par le client comme les autres requetes", async () => {
    const client = new LanguageClient(() => new InProcessWorker());
    await client.setCommandSources({ family: "rathena", builtinSource: bytes(TABLE), customBuiltins: null, legacyEncoding: "windows-1252" });
    await client.analyze("a.txt", 1, npc("\tclo"));
    expect((await client.completion("a.txt", { line: 1, character: 4 })).map((item) => item.label)).toEqual(["close"]);
    expect((await client.commandInfo("warp"))?.arity).toEqual({ min: 3, max: 4 });
    expect(await client.signatureHelp("a.txt", { line: 1, character: 4 })).toBeNull();
  });

  it("propose toute la bibliotheque hors ligne sans activer les diagnostics de commandes", () => {
    const dispatcher = createDispatcher(undefined, { includeRathenaLibrary: true });
    const summary = ask(dispatcher, "setCommandSources", {
      family: "rathena",
      builtinSource: null,
      customBuiltins: null,
      legacyEncoding: "windows-1252",
    });
    expect(summary.level).toBe("none");
    expect(RATHENA_SCRIPT_LIBRARY_INFO.commandCount).toBe(RATHENA_SCRIPT_LIBRARY.length);
    expect(RATHENA_SCRIPT_LIBRARY.length).toBeGreaterThanOrEqual(650);
    expect(RATHENA_SCRIPT_LIBRARY.every((definition) => definition.documentation !== null)).toBe(true);

    const text = npc("\t");
    ask(dispatcher, "analyze", { uri: "a.txt", version: 1, text });
    const completion = ask(dispatcher, "completion", { uri: "a.txt", position: { line: 1, character: 1 }, explicit: true });
    const labels = new Set(completion.map((item) => item.label.toLowerCase()));
    expect(RATHENA_SCRIPT_LIBRARY.every((definition) => labels.has(definition.name.toLowerCase()))).toBe(true);
    expect(ask(dispatcher, "commandInfo", { name: "MES" })).toMatchObject({
      name: "mes",
      documentation: expect.any(String),
      sources: expect.arrayContaining([expect.objectContaining({ kind: "builtin-library" })]),
    });
    expect(ask(dispatcher, "analyze", { uri: "b.txt", version: 1, text: npc("Inconnue;") }).diagnostics).toEqual([]);
  });
});
