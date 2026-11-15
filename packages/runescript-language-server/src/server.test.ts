import { describe, expect, it } from "vitest";
import { CommandRegistry, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { LineIndex } from "@runeforge/runescript-core";
import type { Position } from "@runeforge/runescript-core";
import { LanguageServer } from "./server";
import { matchScore } from "./search";
import { SymbolKind } from "./types";
import type { CrossFileMode, DocumentSymbol, Location, Range } from "./types";

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;
const fn = (name: string, body = "return;"): string => `function\tscript\t${name}\t{\n${body}\n}\n`;

/** Position (ligne/colonne base 0) du `occurrence`-ieme `needle` dans `text`, decalee de `delta` caracteres. */
function positionOf(text: string, needle: string, occurrence = 0, delta = 0): Position {
  let at = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    at = text.indexOf(needle, at + 1);
    if (at === -1) throw new Error(`"${needle}" introuvable (occurrence ${occurrence})`);
  }
  return new LineIndex(text).positionAt(at + delta);
}

/** Plage attendue du `occurrence`-ieme `needle` dans `text`. */
function rangeOfText(text: string, needle: string, occurrence = 0): Range {
  const start = positionOf(text, needle, occurrence);
  return { start, end: { line: start.line, character: start.character + needle.length } };
}

function server(options: { crossFile?: CrossFileMode } = {}): LanguageServer {
  const instance = new LanguageServer();
  if (options.crossFile !== undefined) instance.setOptions({ crossFile: options.crossFile });
  return instance;
}

function names(symbols: readonly DocumentSymbol[]): string[] {
  return symbols.map((symbol) => symbol.name);
}

describe("synchronisation", () => {
  it("ignore une version plus ancienne que celle deja connue", () => {
    const ls = server();
    ls.updateDocument("a.txt", 5, npc("goto L_Ok;\nL_Ok:\nclose;"));
    ls.updateDocument("a.txt", 4, npc("goto L_Missing;\nclose;"));
    expect(ls.diagnostics("a.txt")).toEqual([]);
  });

  it("garde l'analyse d'un document ferme dans l'index, sans texte ni AST", () => {
    const ls = server();
    ls.updateDocument("f.txt", 1, fn("F_Kept"));
    ls.closeDocument("f.txt");
    expect(ls.stats()).toMatchObject({ files: 1, openDocuments: 0, functions: 1 });
    expect(ls.documentSymbols("f.txt")).toHaveLength(1);
    expect(ls.definition("f.txt", { line: 0, character: 0 })).toEqual([]);
  });

  it("le texte de l'editeur prime sur le disque pour un document ouvert", () => {
    const ls = server();
    ls.indexText("a.txt", fn("F_Disk"));
    ls.updateDocument("a.txt", 1, fn("F_Editor"));
    ls.indexText("a.txt", fn("F_DiskAgain"));
    expect(ls.workspaceSymbols("F_").map((s) => s.name)).toEqual(["F_Editor"]);
  });

  it("remplace les symboles d'un fichier modifie et retire ceux d'un fichier supprime", () => {
    const ls = server();
    ls.indexText("a.txt", fn("F_One"));
    ls.indexText("b.txt", fn("F_Two"));
    ls.indexText("a.txt", fn("F_Renamed"));
    expect(ls.workspaceSymbols("").map((s) => s.name).sort()).toEqual(["F_Renamed", "F_Two"]);
    ls.removeFile("b.txt");
    expect(ls.workspaceSymbols("").map((s) => s.name)).toEqual(["F_Renamed"]);
    ls.clearIndex();
    expect(ls.stats()).toEqual({ files: 0, openDocuments: 0, functions: 0, npcs: 0 });
  });
});

describe("diagnostics", () => {
  const caller = npc('callfunc "F_Missing";\ncallfunc "F_Known";\ngoto L_None;\nclose;', "Caller");
  const setup = (crossFile: CrossFileMode): LanguageServer => {
    const ls = server({ crossFile });
    ls.indexText("lib.txt", fn("F_Known") + npc("close;", "Twin"));
    ls.updateDocument("caller.txt", 1, caller + npc("close;", "Twin"));
    return ls;
  };

  it("n'emet que la syntaxe et la semantique locale par defaut", () => {
    expect(setup("off").diagnostics("caller.txt").map((d) => d.code)).toEqual(["RA0002"]);
  });

  it("signale les doublons entre fichiers en mode duplicates", () => {
    const codes = setup("duplicates").diagnostics("caller.txt").map((d) => d.code);
    expect(codes).toContain("RA0005");
    expect(codes).not.toContain("RA0004");
  });

  it("signale aussi les fonctions introuvables en mode all", () => {
    const diagnostics = setup("all").diagnostics("caller.txt");
    expect(diagnostics.map((d) => d.code).sort()).toEqual(["RA0002", "RA0004", "RA0005"]);
    expect(diagnostics.find((d) => d.code === "RA0004")?.params).toEqual({ name: "F_Missing" });
  });

  it("inclut les erreurs de syntaxe, triees par position", () => {
    const ls = server();
    ls.updateDocument("bad.txt", 1, npc('mes "a"\ngoto L_Nope;\nclose;'));
    const diagnostics = ls.diagnostics("bad.txt");
    expect(diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["RS0020", "RA0002"]));
    const starts = diagnostics.map((d) => d.range.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("produit un rapport de projet pour les seuls fichiers qui ont des diagnostics", () => {
    const ls = server({ crossFile: "all" });
    ls.indexText("z-ok.txt", fn("F_Ok"));
    ls.indexText("b-bad.txt", npc("goto L_Nope;\nclose;"));
    ls.indexText("a-bad.txt", npc('callfunc "F_Nowhere";\nclose;', "Other"));
    const report = ls.projectDiagnostics();
    expect(report.map((entry) => entry.uri)).toEqual(["a-bad.txt", "b-bad.txt"]);
    expect(report[0]?.diagnostics.map((d) => d.code)).toEqual(["RA0004"]);
  });

  it("renvoie une liste vide pour un fichier inconnu", () => {
    expect(server().diagnostics("nope.txt")).toEqual([]);
  });
});

describe("plan du document", () => {
  it("decrit NPC, fonction, warp, boutique et duplicate avec leurs labels en enfants", () => {
    const text = [
      fn("F_Helper"),
      "prt_fild08,10,10,0\twarp\tprt_exit\t2,2,prontera,150,150\n",
      "prontera,160,160,4\tshop\tTool_Shop\t4_M_01,501:50\n",
      "prontera,170,170,4\tduplicate(Guide)\tCopy\t4_M_01\n",
      npc("OnInit:\nend;\nL_Menu:\nclose;", "Guide::GuideUnique"),
    ].join("");
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    const outline = ls.documentSymbols("a.txt");
    expect(names(outline)).toEqual(["F_Helper", "prt_exit", "Tool_Shop", "Copy", "Guide"]);
    expect(outline.map((s) => s.kind)).toEqual([SymbolKind.Function, SymbolKind.Namespace, SymbolKind.Struct, SymbolKind.Class, SymbolKind.Class]);
    expect(outline[3]?.detail).toContain("duplicate(Guide)");
    expect(outline[4]?.detail).toContain("::GuideUnique");
    expect(outline[4]?.detail).toContain("prontera 150,150");
    const guide = outline[4]!;
    expect(guide.children.map((c) => [c.name, c.kind])).toEqual([
      ["OnInit", SymbolKind.Event],
      ["L_Menu", SymbolKind.Field],
    ]);
    expect(guide.selectionRange.start).toEqual(rangeOfText(text, "Guide::GuideUnique").start);
  });

  it("imbrique les labels d'une fonction locale sous elle", () => {
    const ls = server();
    ls.updateDocument("a.txt", 1, npc("L_Before:\nfunction Helper {\n  L_Inside:\n  return;\n}\nL_After:\nclose;"));
    const [guide] = ls.documentSymbols("a.txt");
    expect(names(guide!.children)).toEqual(["L_Before", "Helper", "L_After"]);
    expect(names(guide!.children[1]!.children)).toEqual(["L_Inside"]);
  });

  it("respecte la contenance des plages (enfant dans parent, selection dans plage)", () => {
    const ls = server();
    ls.updateDocument("a.txt", 1, npc("L_A:\nfunction F {\n  L_B:\n  return;\n}\nclose;") + fn("F_Glob", "L_X:\nreturn;"));
    const before = (a: { line: number; character: number }, b: { line: number; character: number }): boolean =>
      a.line < b.line || (a.line === b.line && a.character <= b.character);
    const check = (symbol: DocumentSymbol): void => {
      expect(before(symbol.range.start, symbol.selectionRange.start)).toBe(true);
      expect(before(symbol.selectionRange.end, symbol.range.end)).toBe(true);
      for (const child of symbol.children) {
        expect(before(symbol.range.start, child.range.start)).toBe(true);
        expect(before(child.range.end, symbol.range.end)).toBe(true);
        check(child);
      }
    };
    for (const symbol of ls.documentSymbols("a.txt")) check(symbol);
  });

  it("fonctionne aussi pour un fichier seulement indexe", () => {
    const ls = server();
    ls.indexText("a.txt", fn("F_Disk"));
    expect(names(ls.documentSymbols("a.txt"))).toEqual(["F_Disk"]);
    expect(ls.documentSymbols("inconnu.txt")).toEqual([]);
  });
});

describe("definition", () => {
  it("va du goto, du callsub et d'une option de menu a leur label", () => {
    const text = npc('goto L_A;\ncallsub L_B, 1;\nmenu "x", L_C, "y", L_A;\nL_A:\nclose;\nL_B:\nreturn;\nL_C:\nclose;');
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    const defOf = (needle: string, occurrence: number): Location[] => ls.definition("a.txt", positionOf(text, needle, occurrence, 1));
    expect(defOf("L_A", 0)).toEqual([{ uri: "a.txt", range: rangeOfText(text, "L_A", 2) }]);
    expect(defOf("L_B", 0)).toEqual([{ uri: "a.txt", range: rangeOfText(text, "L_B", 1) }]);
    expect(defOf("L_C", 0)).toEqual([{ uri: "a.txt", range: rangeOfText(text, "L_C", 1) }]);
    expect(defOf("L_A", 1)).toEqual([{ uri: "a.txt", range: rangeOfText(text, "L_A", 2) }]);
  });

  it("renvoie la definition elle-meme depuis le label et rien pour un label inconnu", () => {
    const text = npc("goto L_None;\nL_Here:\nclose;");
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    expect(ls.definition("a.txt", positionOf(text, "L_Here", 0, 2))).toEqual([{ uri: "a.txt", range: rangeOfText(text, "L_Here") }]);
    expect(ls.definition("a.txt", positionOf(text, "L_None", 0, 2))).toEqual([]);
  });

  it("resout un appel de fonction locale par son nom ou par callsub", () => {
    const text = npc("function Helper;\nHelper 1;\ncallsub Helper;\nclose;\nfunction Helper {\n  return;\n}");
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    const target = rangeOfText(text, "Helper", 3);
    expect(ls.definition("a.txt", positionOf(text, "Helper", 1, 1))).toEqual([{ uri: "a.txt", range: target }]);
    expect(ls.definition("a.txt", positionOf(text, "Helper", 2, 1))).toEqual([{ uri: "a.txt", range: target }]);
  });

  it("va de callfunc \"F\" a la fonction globale definie dans un autre fichier, en respectant la casse", () => {
    const lib = fn("F_Greet");
    const main = npc('callfunc "F_Greet";\ncallfunc "f_greet";\nclose;');
    const ls = server();
    ls.indexText("npc/lib.txt", lib);
    ls.updateDocument("npc/main.txt", 1, main);
    expect(ls.definition("npc/main.txt", positionOf(main, "F_Greet", 0, 2))).toEqual([{ uri: "npc/lib.txt", range: rangeOfText(lib, "F_Greet") }]);
    expect(ls.definition("npc/main.txt", positionOf(main, "f_greet", 0, 2))).toEqual([]);
  });

  it("va d'un appel par nom nu a la fonction globale indexee", () => {
    const lib = fn("F_Bare");
    const main = npc("F_Bare 1, 2;\nclose;");
    const ls = server();
    ls.indexText("lib.txt", lib);
    ls.updateDocument("main.txt", 1, main);
    expect(ls.definition("main.txt", positionOf(main, "F_Bare", 0, 1))).toEqual([{ uri: "lib.txt", range: rangeOfText(lib, "F_Bare") }]);
  });

  it("va de duplicate(Nom) au NPC source et du nom d'un NPC a lui-meme", () => {
    const source = npc("close;", "Source");
    const copies = "prontera,170,170,4\tduplicate(Source)\tCopy\t4_M_01\n";
    const ls = server();
    ls.indexText("source.txt", source);
    ls.updateDocument("copies.txt", 1, copies);
    expect(ls.definition("copies.txt", positionOf(copies, "Source", 0, 1))).toEqual([{ uri: "source.txt", range: rangeOfText(source, "Source") }]);
    expect(ls.definition("copies.txt", positionOf(copies, "Copy", 0, 1))).toEqual([{ uri: "copies.txt", range: rangeOfText(copies, "Copy") }]);
  });

  it("va d'une variable locale a sa premiere ecriture, sans confondre les NPC", () => {
    const text = npc("mes .@x;\nset .@x, 1;\nmes .@x;\nclose;", "A") + npc("set .@x, 2;\nclose;", "B");
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    expect(ls.definition("a.txt", positionOf(text, ".@x", 0, 1))).toEqual([{ uri: "a.txt", range: rangeOfText(text, ".@x", 1) }]);
    expect(ls.definition("a.txt", positionOf(text, ".@x", 3, 1))).toEqual([{ uri: "a.txt", range: rangeOfText(text, ".@x", 3) }]);
  });

  it("renvoie une liste vide hors de tout symbole ou pour un document non ouvert", () => {
    const text = npc('mes "texte";\nclose;');
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    expect(ls.definition("a.txt", positionOf(text, "texte", 0, 1))).toEqual([]);
    expect(ls.definition("a.txt", { line: 999, character: 0 })).toEqual([]);
    expect(ls.definition("absent.txt", { line: 0, character: 0 })).toEqual([]);
  });
});

describe("references", () => {
  it("liste les references d'un label avec ou sans sa declaration", () => {
    const text = npc("goto L_A;\nmenu \"x\", L_A, \"y\", L_B;\nL_A:\nclose;\nL_B:\nclose;");
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    const at = positionOf(text, "L_A", 2, 1);
    const withDeclaration = ls.references("a.txt", at, true);
    expect(withDeclaration.map((l) => l.range)).toEqual(
      expect.arrayContaining([rangeOfText(text, "L_A", 0), rangeOfText(text, "L_A", 1), rangeOfText(text, "L_A", 2)]),
    );
    expect(withDeclaration).toHaveLength(3);
    expect(ls.references("a.txt", at, false)).toHaveLength(2);
  });

  it("liste les appels callfunc d'une fonction dans tous les fichiers et sa definition", () => {
    const lib = fn("F_Used");
    const a = npc('callfunc "F_Used";\nclose;', "A");
    const b = npc('callfunc("F_Used", 1);\nclose;', "B");
    const ls = server();
    ls.indexText("lib.txt", lib);
    ls.indexText("b.txt", b);
    ls.updateDocument("a.txt", 1, a);
    const at = positionOf(a, "F_Used", 0, 2);
    const all = ls.references("a.txt", at, true);
    expect(all.map((l) => l.uri).sort()).toEqual(["a.txt", "b.txt", "lib.txt"]);
    expect(ls.references("a.txt", at, false).map((l) => l.uri).sort()).toEqual(["a.txt", "b.txt"]);
    // depuis la definition elle-meme
    ls.updateDocument("lib.txt", 1, lib);
    expect(ls.references("lib.txt", positionOf(lib, "F_Used", 0, 1), false)).toHaveLength(2);
  });

  it("liste les duplicate() qui visent un NPC", () => {
    const source = npc("close;", "Source");
    const copies = "prontera,1,1,0\tduplicate(Source)\tC1\t4_M_01\nprontera,2,2,0\tduplicate(Source)\tC2\t4_M_01\n";
    const ls = server();
    ls.indexText("copies.txt", copies);
    ls.updateDocument("source.txt", 1, source);
    const found = ls.references("source.txt", positionOf(source, "Source", 0, 1), false);
    expect(found).toHaveLength(2);
    expect(found.every((l) => l.uri === "copies.txt")).toBe(true);
  });

  it("limite les references d'une variable locale a son script", () => {
    const text = npc("set .@x, 1;\nmes .@x;\nclose;", "A") + npc("set .@x, 2;\nclose;", "B");
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    expect(ls.references("a.txt", positionOf(text, ".@x", 0, 1), true)).toHaveLength(2);
    expect(ls.references("a.txt", positionOf(text, ".@x", 2, 1), true)).toHaveLength(1);
  });

  it("couvre toutes les declarations du fichier pour une variable globale", () => {
    const text = npc("$total = 1;\nclose;", "A") + npc("mes $total;\nclose;", "B");
    const ls = server();
    ls.updateDocument("a.txt", 1, text);
    expect(ls.references("a.txt", positionOf(text, "$total", 0, 2), true)).toHaveLength(2);
  });
});

describe("recherche de symboles du projet", () => {
  const setup = (): LanguageServer => {
    const ls = server();
    ls.indexText("npc/functions.txt", fn("F_Kafra_Save") + fn("F_Heal"));
    ls.indexText("npc/cities/prontera.txt", npc("close;", "Kafra Employee::KafraPront") + npc("close;", "Healer"));
    ls.indexText("npc/warps.txt", "prt_fild08,10,10,0\twarp\tprt_to_field\t2,2,prt_fild08,5,5\n");
    return ls;
  };

  it("classe egalite, prefixe, debut de mot et sous-chaine dans cet ordre", () => {
    const ls = server();
    ls.indexText("a.txt", fn("Heal") + fn("Healer_Basic") + fn("F_Heal") + fn("Superheal"));
    expect(ls.workspaceSymbols("heal").map((s) => s.name)).toEqual(["Heal", "Healer_Basic", "F_Heal", "Superheal"]);
  });

  it("trouve fonctions et NPC, par nom unique ou par nom affiche", () => {
    const ls = setup();
    expect(ls.workspaceSymbols("kafra").map((s) => s.name).sort()).toEqual(["F_Kafra_Save", "KafraPront"]);
    expect(ls.workspaceSymbols("employee").map((s) => s.name)).toEqual(["KafraPront"]);
    expect(ls.workspaceSymbols("to_field")[0]).toMatchObject({ name: "prt_to_field", kind: SymbolKind.Namespace });
  });

  it("tolere une sous-sequence et renvoie l'emplacement exact du nom", () => {
    const ls = setup();
    const [hit] = ls.workspaceSymbols("fksv");
    expect(hit?.name).toBe("F_Kafra_Save");
    expect(hit?.location.uri).toBe("npc/functions.txt");
    expect(hit?.location.range).toEqual(rangeOfText(fn("F_Kafra_Save") + fn("F_Heal"), "F_Kafra_Save"));
    expect(ls.workspaceSymbols("zzzz")).toEqual([]);
  });

  it("applique la limite et trie de facon deterministe", () => {
    const ls = server();
    for (let i = 0; i < 30; i += 1) ls.indexText(`f${i}.txt`, fn(`F_Item${String(i).padStart(2, "0")}`));
    const limited = ls.workspaceSymbols("F_Item", 5);
    expect(limited.map((s) => s.name)).toEqual(["F_Item00", "F_Item01", "F_Item02", "F_Item03", "F_Item04"]);
    expect(ls.workspaceSymbols("", 3)).toHaveLength(3);
  });

  it("donne les memes positions pour un fichier indexe en CRLF que pour son texte en LF", () => {
    const lf = `// commentaire\n${fn("F_Same")}`;
    const crlf = lf.replaceAll("\n", "\r\n");
    const a = server();
    const b = server();
    a.indexText("x.txt", lf);
    b.indexText("x.txt", crlf);
    expect(a.workspaceSymbols("F_Same")[0]?.location).toEqual(b.workspaceSymbols("F_Same")[0]?.location);
    // "function⇥script⇥" = 8 + 1 + 6 + 1 = 16 caracteres avant le nom, sur la 2e ligne (apres le commentaire).
    expect(b.workspaceSymbols("F_Same")[0]?.location.range.start).toEqual({ line: 1, character: 16 });
  });
});

function commandRegistry(): CommandRegistry {
  const definition = (name: string, types: string | null): CommandDefinition => ({
    name,
    arity: types === null ? null : parseParameterTypes(types),
    parameterTypes: types,
    signatures: [],
    documentation: null,
    deprecated: false,
    conditional: false,
    sources: [{ kind: types === null ? "server-doc" : "server-source", reference: "test" }],
  });
  return CommandRegistry.create([definition("mes", "s*"), definition("close", ""), definition("doc_only", null)], "rAthena");
}

describe("registre de commandes", () => {
  const caller = npc("mes;\nInconnue 1;\nF_Navi;\nclose;");

  it("n'emet ni RA0006 ni RA0001 tant qu'aucun registre n'est defini", () => {
    const ls = server();
    ls.updateDocument("a.txt", 1, caller);
    expect(ls.diagnostics("a.txt")).toEqual([]);
    expect(ls.commandStats()).toBeNull();
  });

  it("signale le nombre d'arguments (RA0006) et les commandes inconnues (RA0001) d'un document ouvert", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    ls.updateDocument("a.txt", 1, caller);
    const found = ls.diagnostics("a.txt");
    expect(found.map((d) => [d.code, caller.slice(d.range.start, d.range.end)])).toEqual([
      ["RA0006", "mes"],
      ["RA0001", "Inconnue"],
      ["RA0001", "F_Navi"],
    ]);
    expect(found[1]).toMatchObject({ severity: "warning", confidence: "unknown", params: { name: "Inconnue", profile: "rAthena" } });
  });

  it("une fonction globale d'un autre fichier du projet n'est pas une commande inconnue", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    ls.indexText("functions.txt", fn("F_Navi"));
    ls.updateDocument("a.txt", 1, caller);
    expect(ls.diagnostics("a.txt").map((d) => caller.slice(d.range.start, d.range.end))).toEqual(["mes", "Inconnue"]);
    ls.removeFile("functions.txt");
    expect(ls.diagnostics("a.txt").map((d) => caller.slice(d.range.start, d.range.end))).toEqual(["mes", "Inconnue", "F_Navi"]);
  });

  it("applique la politique unknownCommands (off, info, error) sans toucher a RA0006", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    ls.updateDocument("a.txt", 1, caller);
    ls.setOptions({ unknownCommands: "off" });
    expect(ls.diagnostics("a.txt").map((d) => d.code)).toEqual(["RA0006"]);
    ls.setOptions({ unknownCommands: "info" });
    expect(ls.diagnostics("a.txt").filter((d) => d.code === "RA0001").map((d) => d.severity)).toEqual(["info", "info"]);
    ls.setOptions({ unknownCommands: "error" });
    expect(ls.diagnostics("a.txt").filter((d) => d.code === "RA0001").map((d) => d.severity)).toEqual(["error", "error"]);
  });

  it("analyse de nouveau les documents ouverts quand le registre change, sans les rouvrir", () => {
    const ls = server();
    ls.updateDocument("a.txt", 1, caller);
    expect(ls.diagnostics("a.txt")).toEqual([]);
    ls.setCommandRegistry(commandRegistry());
    expect(ls.diagnostics("a.txt").map((d) => d.code)).toEqual(["RA0006", "RA0001", "RA0001"]);
    ls.setCommandRegistry(null);
    expect(ls.diagnostics("a.txt")).toEqual([]);
  });

  it("applique le registre aux fichiers indexes apres sa definition, et figure dans le rapport de projet", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    ls.indexText("b.txt", caller);
    expect(ls.projectDiagnostics().map((entry) => [entry.uri, entry.diagnostics.map((d) => d.code)])).toEqual([
      ["b.txt", ["RA0006", "RA0001", "RA0001"]],
    ]);
  });

  it("n'emet rien pour une commande dont seule la documentation est connue", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    ls.updateDocument("a.txt", 1, npc("doc_only 1, 2, 3;\nclose;"));
    expect(ls.diagnostics("a.txt")).toEqual([]);
  });

  it("decrit le registre actif", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    expect(ls.commandStats()).toEqual({ total: 3, withArity: 2, fromServerSource: 2, fromServerDoc: 1, fromProject: 0 });
  });
});

describe("apercu d'un texte (previewDiagnostics)", () => {
  const good = npc("mes \"a\";\nclose;");

  it("analyse comme un fichier du projet : syntaxe, arguments, commande inconnue", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    expect(ls.previewDiagnostics(good)).toEqual([]);
    const text = npc("mes;\nInconnue 1;\nclose;");
    expect(ls.previewDiagnostics(text).map((d) => [d.code, text.slice(d.range.start, d.range.end)])).toEqual([
      ["RA0006", "mes"],
      ["RA0001", "Inconnue"],
    ]);
    expect(ls.previewDiagnostics('prontera,1,1,0\tscript\tX\t100,{\n\tmes "a"\n}\n').some((d) => d.code.startsWith("RS"))).toBe(true);
  });

  it("n'entre ni dans l'index ni dans les documents : ses fonctions n'existent pas pour le projet", () => {
    const ls = server({ crossFile: "all" });
    ls.setCommandRegistry(commandRegistry());
    const before = ls.stats();
    expect(ls.previewDiagnostics(fn("F_Preview", "close;") + npc("close;")).length).toBe(0);
    expect(ls.stats()).toEqual(before);
    expect(ls.workspaceSymbols("F_Preview", 10)).toEqual([]);
    // Une fonction du projet, elle, est connue de l'apercu (pas de commande inconnue).
    ls.indexText("lib.txt", fn("F_Navi", "close;"));
    const text = npc("F_Navi;\nclose;");
    expect(ls.previewDiagnostics(text)).toEqual([]);
    ls.removeFile("lib.txt");
    expect(ls.previewDiagnostics(text).map((d) => d.code)).toEqual(["RA0001"]);
  });

  it("suit la politique unknownCommands et se tait sans registre", () => {
    const ls = server();
    const text = npc("Inconnue 1;\nclose;");
    expect(ls.previewDiagnostics(text)).toEqual([]);
    ls.setCommandRegistry(commandRegistry());
    expect(ls.previewDiagnostics(text).map((d) => [d.code, d.severity])).toEqual([["RA0001", "warning"]]);
    ls.setOptions({ unknownCommands: "error" });
    expect(ls.previewDiagnostics(text).map((d) => d.severity)).toEqual(["error"]);
    ls.setOptions({ unknownCommands: "off" });
    expect(ls.previewDiagnostics(text)).toEqual([]);
  });

  it("ne signale pas l'ordre de chargement, qui ne s'applique qu'aux fichiers du projet", () => {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    ls.indexText("defs.txt", fn("F_Navi", "close;"));
    ls.setLoadOrder(["preview://text", "defs.txt"]);
    expect(ls.previewDiagnostics(npc("F_Navi;\nclose;"))).toEqual([]);
  });
});

describe("ordre de chargement (RA0016)", () => {
  const caller = npc("F_Navi;\nclose;");
  const definition = fn("F_Navi", "close;");
  const codes = (ls: LanguageServer, uri: string): string[] => ls.diagnostics(uri).map((d) => d.code);

  function ready(): LanguageServer {
    const ls = server();
    ls.setCommandRegistry(commandRegistry());
    ls.indexText("defs.txt", definition);
    ls.updateDocument("a.txt", 1, caller);
    return ls;
  }

  it("signale l'appel d'une fonction que le serveur charge apres l'appelant, dans le document et dans le rapport de projet", () => {
    const ls = ready();
    ls.setLoadOrder(["a.txt", "defs.txt"]);
    const found = ls.diagnostics("a.txt");
    expect(found.map((d) => [d.code, caller.slice(d.range.start, d.range.end)])).toEqual([["RA0016", "F_Navi"]]);
    expect(found[0]).toMatchObject({ severity: "error", confidence: "probable", params: { name: "F_Navi" } });
    expect(ls.projectDiagnostics().map((entry) => [entry.uri, entry.diagnostics.map((d) => d.code)])).toEqual([["a.txt", ["RA0016"]]]);

    // Le meme index, dans l'ordre qui convient : plus rien.
    ls.setLoadOrder(["defs.txt", "a.txt"]);
    expect(codes(ls, "a.txt")).toEqual([]);
    expect(ls.projectDiagnostics()).toEqual([]);
  });

  it("ne dit rien tant que l'ordre n'est pas connu, ni quand on le retire", () => {
    const ls = ready();
    expect(codes(ls, "a.txt")).toEqual([]);
    ls.setLoadOrder(["a.txt", "defs.txt"]);
    expect(codes(ls, "a.txt")).toEqual(["RA0016"]);
    ls.setLoadOrder(null);
    expect(codes(ls, "a.txt")).toEqual([]);
  });

  it("suit la politique unknownCommands sans en prendre la gravite : coupe avec `off`, toujours une erreur sinon", () => {
    const ls = ready();
    ls.setLoadOrder(["a.txt", "defs.txt"]);
    ls.setOptions({ unknownCommands: "off" });
    expect(codes(ls, "a.txt")).toEqual([]);
    ls.setOptions({ unknownCommands: "info" });
    expect(ls.diagnostics("a.txt").map((d) => [d.code, d.severity])).toEqual([["RA0016", "error"]]);
    ls.setOptions({ unknownCommands: "warning" });
    expect(ls.diagnostics("a.txt").map((d) => [d.code, d.severity])).toEqual([["RA0016", "error"]]);
  });

  it("n'a pas de sens sans registre de commandes : les appels ne se distinguent pas des commandes", () => {
    const ls = ready();
    ls.setLoadOrder(["a.txt", "defs.txt"]);
    ls.setCommandRegistry(null);
    expect(codes(ls, "a.txt")).toEqual([]);
  });

  it("appartient au serveur du projet : vider l'index ne l'oublie pas, un nouvel ordre le remplace", () => {
    const ls = ready();
    ls.setLoadOrder(["a.txt", "defs.txt"]);
    ls.clearIndex();
    ls.indexText("defs.txt", definition);
    ls.updateDocument("a.txt", 1, caller);
    expect(codes(ls, "a.txt")).toEqual(["RA0016"]);
    ls.setLoadOrder(["defs.txt", "a.txt"]);
    expect(codes(ls, "a.txt")).toEqual([]);
  });

  it("suit le texte de l'editeur : corriger l'appel fait disparaitre l'alerte, sans toucher a l'ordre", () => {
    const ls = ready();
    ls.setLoadOrder(["a.txt", "defs.txt"]);
    expect(codes(ls, "a.txt")).toEqual(["RA0016"]);
    ls.updateDocument("a.txt", 2, npc('callfunc "F_Navi";\nclose;'));
    expect(codes(ls, "a.txt")).toEqual([]);
  });
});

describe("matchScore", () => {
  it("ordonne les types de correspondance et rejette ce qui ne correspond pas", () => {
    const score = (q: string, t: string): number | null => matchScore(q, t);
    expect(score("abc", "abc")).toBeGreaterThan(score("abc", "abcd")!);
    expect(score("abc", "abcd")).toBeGreaterThan(score("abc", "x_abc")!);
    expect(score("abc", "x_abc")).toBeGreaterThan(score("abc", "xabc")!);
    expect(score("abc", "xabc")).toBeGreaterThan(score("abc", "a_b_c")!);
    expect(score("abc", "acb")).toBeNull();
    expect(score("", "tout")).toBe(1);
  });
});

describe("robustesse", () => {
  it("ne leve jamais d'exception sur des textes et des positions arbitraires", () => {
    const fragments = [
      "goto ", "callsub ", "menu ", "callfunc \"F\"", "function ", "L_A:", "L_B:", "{", "}", ";", ",", "\"", "(", ")", "\n", "\t",
      "prontera,1,1,0\tscript\tN\t1,{", "function\tscript\tF\t{", "prontera,2,2,0\tduplicate(N)\tD\t1\n", ".@x", "$y", "set ", "-",
    ];
    let seed = 987654;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ls = server({ crossFile: "all" });
    for (let round = 0; round < 200; round += 1) {
      let text = "";
      const length = 5 + Math.floor(random() * 40);
      for (let i = 0; i < length; i += 1) text += fragments[Math.floor(random() * fragments.length)]!;
      const uri = `f${round % 7}.txt`;
      if (round % 3 === 0) ls.indexText(uri, text);
      else ls.updateDocument(uri, round, text);
      const position = { line: Math.floor(random() * 6), character: Math.floor(random() * 30) };
      ls.definition(uri, position);
      ls.references(uri, position, round % 2 === 0);
      ls.documentSymbols(uri);
      ls.diagnostics(uri);
      if (round % 25 === 0) ls.workspaceSymbols("f", 10);
      if (round % 11 === 0) ls.closeDocument(uri);
    }
    expect(ls.projectDiagnostics().length).toBeGreaterThanOrEqual(0);
  });
});
