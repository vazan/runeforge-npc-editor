import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@runeforge/emulator-core";
import { describeDiagnostic } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";
import { analyzeFile } from "./analyze";
import { WorkspaceIndex } from "./workspace-index";

/**
 * `RA0016` : un nom appele seul (`Nom arg;`, `Nom(arg)`) n'est accepte par le serveur que si la fonction globale est deja chargee
 * (`parse_callfunc` : « calling undeclared function »). L'index le sait des qu'on lui donne l'ordre de chargement des fichiers.
 */
const SOURCE = [{ kind: "server-source", reference: "t" }] as const;
const COMMANDS = CommandRegistry.create(
  [
    { name: "mes", arity: { min: 1, max: null }, parameterTypes: "s*", signatures: [], documentation: null, deprecated: false, conditional: false, sources: SOURCE },
    { name: "callfunc", arity: { min: 1, max: null }, parameterTypes: "s*", signatures: [], documentation: null, deprecated: false, conditional: false, sources: SOURCE },
    { name: "close", arity: { min: 0, max: 0 }, parameterTypes: "", signatures: [], documentation: null, deprecated: false, conditional: false, sources: SOURCE },
  ],
  "rAthena",
);

/** Un NPC dont le corps contient `body` (un NPC par fichier suffit : le nom unique n'est pas en jeu). */
function npc(body: string, name = "Caller"): string {
  return `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\nclose;\n}\n`;
}

function fn(name: string, body = "close;"): string {
  return `function\tscript\t${name}\t{\n${body}\n}\n`;
}

function indexOf(files: Record<string, string>): WorkspaceIndex {
  const index = new WorkspaceIndex();
  for (const [uri, text] of Object.entries(files)) index.set(analyzeFile(parse(text), uri, { commands: COMMANDS }));
  return index;
}

/** Les noms signales par `RA0016` dans `uri`, tels qu'ecrits dans `text`. */
function flagged(index: WorkspaceIndex, uri: string, text: string): string[] {
  return index.loadOrderDiagnostics(uri).map((d) => text.slice(d.range.start, d.range.end));
}

describe("WorkspaceIndex : fonction appelee avant d'etre chargee (RA0016)", () => {
  it("accepte une fonction d'un fichier charge avant l'appelant et signale celle d'un fichier charge apres", () => {
    const text = npc("F_Shared;");
    const index = indexOf({ "a.txt": fn("F_Shared"), "b.txt": text });
    index.setLoadOrder(["a.txt", "b.txt"]);
    expect(index.loadOrderDiagnostics("b.txt")).toEqual([]);

    index.setLoadOrder(["b.txt", "a.txt"]);
    expect(flagged(index, "b.txt", text)).toEqual(["F_Shared"]);
    // L'ordre des fichiers, pas celui dans lequel ils ont ete ajoutes a l'index.
    expect(index.loadOrderDiagnostics("a.txt")).toEqual([]);
  });

  it("decrit l'alerte : erreur probable de l'analyseur, avec le nom et la correction", () => {
    const text = npc("F_Shared;");
    const index = indexOf({ "a.txt": fn("F_Shared"), "b.txt": text });
    index.setLoadOrder(["b.txt", "a.txt"]);
    const [diagnostic] = index.loadOrderDiagnostics("b.txt");
    if (diagnostic === undefined) throw new Error("RA0016 attendu");
    expect(diagnostic).toMatchObject({
      code: "RA0016",
      category: "semantic-error",
      severity: "error",
      confidence: "probable",
      source: "analyzer",
      params: { name: "F_Shared" },
    });
    expect(diagnostic.message).toContain("'F_Shared' is called by name before the server has loaded it");
    // Le conseil dit quoi faire, dans les deux langues, avec le nom de la fonction.
    expect(describeDiagnostic(diagnostic, "en").hint).toContain('callfunc "F_Shared"');
    expect(describeDiagnostic(diagnostic, "fr").message).toContain("« F_Shared » est appelée par son nom avant que le serveur l'ait chargée");
    expect(describeDiagnostic(diagnostic, "fr").hint).toContain('callfunc "F_Shared"');
  });

  it("dans un meme fichier, exige la definition avant l'appel", () => {
    const defined = fn("F_Here") + npc("F_Here;");
    const index = indexOf({ "one.txt": defined });
    index.setLoadOrder(["one.txt"]);
    expect(index.loadOrderDiagnostics("one.txt")).toEqual([]);

    const afterwards = npc("F_Here;") + fn("F_Here");
    index.set(analyzeFile(parse(afterwards), "one.txt", { commands: COMMANDS }));
    expect(flagged(index, "one.txt", afterwards)).toEqual(["F_Here"]);
  });

  it("applique la meme regle d'une fonction a l'autre", () => {
    const first = fn("F_B") + fn("F_A", "F_B;\nclose;");
    const index = indexOf({ "one.txt": first });
    index.setLoadOrder(["one.txt"]);
    expect(index.loadOrderDiagnostics("one.txt")).toEqual([]);

    const reversed = fn("F_A", "F_B;\nclose;") + fn("F_B");
    index.set(analyzeFile(parse(reversed), "one.txt", { commands: COMMANDS }));
    expect(flagged(index, "one.txt", reversed)).toEqual(["F_B"]);
  });

  it("signale une fonction qui s'appelle elle-meme par son nom (elle n'est connue qu'apres son corps) mais pas par callfunc", () => {
    const byName = fn("F_Loop", "F_Loop;\nclose;");
    const index = indexOf({ "one.txt": byName });
    index.setLoadOrder(["one.txt"]);
    expect(flagged(index, "one.txt", byName)).toEqual(["F_Loop"]);

    const viaCallfunc = fn("F_Loop", 'callfunc "F_Loop";\nclose;');
    index.set(analyzeFile(parse(viaCallfunc), "one.txt", { commands: COMMANDS }));
    expect(index.loadOrderDiagnostics("one.txt")).toEqual([]);
  });

  it("se contente d'une definition chargee avant l'appelant quand la fonction est definie plusieurs fois", () => {
    const files = { "early.txt": fn("F_Twice"), "caller.txt": npc("F_Twice;"), "late.txt": fn("F_Twice") };
    const index = indexOf(files);
    index.setLoadOrder(["early.txt", "caller.txt", "late.txt"]);
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);

    index.setLoadOrder(["caller.txt", "early.txt", "late.txt"]);
    expect(flagged(index, "caller.txt", files["caller.txt"])).toEqual(["F_Twice"]);
  });

  it("ignore une definition situee dans un fichier que le serveur ne charge pas (l'index la connait, pas le serveur)", () => {
    const text = npc("F_Orphan;");
    const index = indexOf({ "caller.txt": text, "unloaded.txt": fn("F_Orphan") });
    index.setLoadOrder(["caller.txt"]);
    expect(flagged(index, "caller.txt", text)).toEqual(["F_Orphan"]);
    // `RA0001` ne la signale pas : pour l'index, la fonction existe.
    expect(index.unknownCommandDiagnostics("caller.txt", { severity: "warning", profile: "rAthena" })).toEqual([]);
  });

  it("ne dit rien d'un fichier que le serveur ne charge pas", () => {
    const index = indexOf({ "caller.txt": npc("F_Later;"), "defs.txt": fn("F_Later") });
    index.setLoadOrder(["defs.txt"]);
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);
  });

  it("ne dit rien tant qu'il n'a pas l'ordre, ni quand on le lui retire", () => {
    const index = indexOf({ "caller.txt": npc("F_Later;"), "defs.txt": fn("F_Later") });
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);

    index.setLoadOrder(["caller.txt", "defs.txt"]);
    expect(index.loadOrderDiagnostics("caller.txt")).toHaveLength(1);
    index.setLoadOrder(null);
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);
  });

  it("laisse `RA0001` aux noms qu'aucun fichier ne definit", () => {
    const index = indexOf({ "caller.txt": npc("F_Nowhere;") });
    index.setLoadOrder(["caller.txt"]);
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);
    expect(index.unknownCommandDiagnostics("caller.txt", { severity: "warning", profile: "rAthena" })).toHaveLength(1);
  });

  it("ne dit rien d'un fichier inconnu de l'index", () => {
    const index = indexOf({ "defs.txt": fn("F_Later") });
    index.setLoadOrder(["missing.txt", "defs.txt"]);
    expect(index.loadOrderDiagnostics("missing.txt")).toEqual([]);
  });

  it("compte un fichier cite plusieurs fois a sa premiere occurrence", () => {
    const text = npc("F_Twice;");
    // Appelant d'abord : le serveur l'analyse a ce rang, la definition (rang 1) n'existe pas encore.
    const callerFirst = indexOf({ "a.txt": fn("F_Twice"), "b.txt": text });
    callerFirst.setLoadOrder(["b.txt", "a.txt", "b.txt"]);
    expect(flagged(callerFirst, "b.txt", text)).toEqual(["F_Twice"]);

    // Definition d'abord : la fonction existe des le rang 0, la seconde citation de son fichier n'y change rien.
    const definitionFirst = indexOf({ "a.txt": text, "b.txt": fn("F_Twice") });
    definitionFirst.setLoadOrder(["b.txt", "a.txt", "b.txt"]);
    expect(definitionFirst.loadOrderDiagnostics("a.txt")).toEqual([]);
  });

  it("ne signale que les appels qui ne sont pas encore connus, sans toucher aux autres", () => {
    const text = npc("F_Good;\nmes \"x\";\nF_Bad;\nF_Good;");
    const index = indexOf({ "good.txt": fn("F_Good"), "caller.txt": text, "bad.txt": fn("F_Bad") });
    index.setLoadOrder(["good.txt", "caller.txt", "bad.txt"]);
    expect(flagged(index, "caller.txt", text)).toEqual(["F_Bad"]);
    const [only] = index.loadOrderDiagnostics("caller.txt");
    expect(text.slice(0, only?.range.start).split("\n").length - 1).toBe(3);
  });

  it("suit la fonction quand elle est retiree ou que le fichier de l'appelant est remplace", () => {
    const text = npc("F_Later;");
    const index = indexOf({ "caller.txt": text, "defs.txt": fn("F_Later") });
    index.setLoadOrder(["caller.txt", "defs.txt"]);
    expect(index.loadOrderDiagnostics("caller.txt")).toHaveLength(1);

    const fixed = npc("close;");
    index.set(analyzeFile(parse(fixed), "caller.txt", { commands: COMMANDS }));
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);

    index.set(analyzeFile(parse(text), "caller.txt", { commands: COMMANDS }));
    expect(index.loadOrderDiagnostics("caller.txt")).toHaveLength(1);
    index.delete("defs.txt");
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);
  });

  it("ne dit rien sans registre de commandes (les appels ne sont pas distingues des commandes)", () => {
    const index = new WorkspaceIndex();
    index.set(analyzeFile(parse(npc("F_Later;")), "caller.txt"));
    index.set(analyzeFile(parse(fn("F_Later")), "defs.txt"));
    index.setLoadOrder(["caller.txt", "defs.txt"]);
    expect(index.loadOrderDiagnostics("caller.txt")).toEqual([]);
  });
});
