import { describe, expect, it } from "vitest";
import { CommandRegistry, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { parse } from "@runeforge/runescript-parser";
import { analyzeFile } from "./analyze";
import type { AnalyzeOptions } from "./analyze";
import type { FileAnalysis, NpcSymbol, ScriptScope } from "./symbols";
import { isEventLabelName, labelKey, npcKey } from "./symbols";

const HEADER = "prontera,150,150,4\tscript\tTest\t4_M_01,{";

/** Enveloppe un corps de script dans un NPC valide. */
function npc(body: string, name = "Test"): string {
  return `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;
}

function analyze(text: string, options?: AnalyzeOptions): FileAnalysis {
  return analyzeFile(parse(text), "npc/test.txt", options);
}

function firstScope(analysis: FileAnalysis): ScriptScope {
  const declaration = analysis.declarations[0];
  if (declaration === undefined || declaration.scope === null) throw new Error("scope attendue");
  return declaration.scope;
}

function codes(analysis: FileAnalysis): string[] {
  return analysis.diagnostics.map((d) => d.code);
}

function slice(text: string, range: { start: number; end: number }): string {
  return text.slice(range.start, range.end);
}

describe("symbols : utilitaires", () => {
  it("normalise les labels sans tenir compte de la casse", () => {
    expect(labelKey("L_Menu")).toBe("l_menu");
  });

  it("reconnait les labels d'evenement On* sans tenir compte de la casse", () => {
    expect(isEventLabelName("OnInit")).toBe(true);
    expect(isEventLabelName("ONTOUCH")).toBe(true);
    expect(isEventLabelName("onclock0100")).toBe(true);
    expect(isEventLabelName("L_On")).toBe(false);
    expect(isEventLabelName("O")).toBe(false);
    expect(isEventLabelName("")).toBe(false);
  });

  it("tronque le nom unique d'un NPC a 50 caracteres comme le serveur", () => {
    const long = "a".repeat(60);
    expect(npcKey(long)).toBe("a".repeat(50));
    expect(npcKey("Kafra")).toBe("Kafra");
    expect(npcKey("Kafra")).not.toBe(npcKey("kafra"));
  });
});

describe("analyzeFile : symboles de declaration", () => {
  it("decrit un NPC script (noms, position) et ses labels", () => {
    const text = npc('OnInit:\n\tmes "a";\nL_End:\n\tclose;', "Guide::GuideUnique");
    const analysis = analyze(text);
    expect(analysis.declarations).toHaveLength(1);
    const declaration = analysis.declarations[0] as NpcSymbol;
    expect(declaration.kind).toBe("npc");
    expect(declaration.npcType).toBe("script");
    expect(declaration.displayName).toBe("Guide");
    expect(declaration.uniqueName).toBe("GuideUnique");
    expect(declaration.map).toBe("prontera");
    expect(declaration.x).toBe(150);
    expect(declaration.y).toBe(150);
    expect(slice(text, declaration.nameRange)).toBe("Guide::GuideUnique");
    const scope = firstScope(analysis);
    expect(scope.labels.map((l) => [l.name, l.isEvent, l.kind])).toEqual([
      ["OnInit", true, "label"],
      ["L_End", false, "label"],
    ]);
    expect(slice(text, scope.labels[1]!.nameRange)).toBe("L_End");
    expect(scope.complete).toBe(true);
  });

  it("utilise le nom complet comme nom unique en l'absence de ::", () => {
    const analysis = analyze(npc("close;", "Kafra#01"));
    const declaration = analysis.declarations[0] as NpcSymbol;
    expect(declaration.uniqueName).toBe("Kafra#01");
    expect(declaration.displayName).toBe("Kafra#01");
  });

  it("decrit une fonction globale, un warp, une boutique et un duplicate", () => {
    const text = [
      "function\tscript\tF_Test\t{\n\treturn 1;\n}\n",
      "prt_fild08,10,10,0\twarp\tprt_exit\t2,2,prontera,150,150\n",
      "prontera,160,160,4\tshop\tTool_Shop\t4_M_01,501:50,502:200\n",
      "prontera,170,170,4\tduplicate(Test)\tCopy\t4_M_01\n",
      npc("close;"),
    ].join("");
    const analysis = analyze(text);
    expect(analysis.declarations.map((d) => (d.kind === "function" ? `function:${d.name}` : `${d.npcType}:${d.uniqueName}`))).toEqual([
      "function:F_Test",
      "warp:prt_exit",
      "shop:Tool_Shop",
      "duplicate:Copy",
      "script:Test",
    ]);
    const duplicate = analysis.declarations[3] as NpcSymbol;
    expect(duplicate.duplicateOf?.name).toBe("Test");
    expect(slice(text, duplicate.duplicateOf!.range)).toBe("Test");
    expect(analysis.declarations.map((d) => d.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("ignore les monstres et mapflags (aucun symbole) mais conserve l'index des declarations", () => {
    const text = "prontera\tmapflag\tnoteleport\nprontera,0,0\tmonster\tPoring\t1002,5,0,0,0\n" + npc("close;");
    const analysis = analyze(text);
    expect(analysis.declarations).toHaveLength(1);
    expect(analysis.declarations[0]?.index).toBe(2);
  });

  it("n'echoue pas sur un fichier vide ou sans declaration", () => {
    expect(analyze("").declarations).toEqual([]);
    expect(analyze("// juste un commentaire\n").diagnostics).toEqual([]);
  });
});

describe("analyzeFile : labels (RA0002, RA0003)", () => {
  it("accepte un goto vers un label defini, quelle que soit la casse", () => {
    const analysis = analyze(npc("goto L_END;\nL_end:\nclose;"));
    expect(codes(analysis)).toEqual([]);
    const scope = firstScope(analysis);
    expect(scope.labelReferences).toMatchObject([{ via: "goto", key: "l_end" }]);
  });

  it("signale un goto vers un label inconnu avec la plage exacte du nom", () => {
    const text = npc("goto L_Missing;\nclose;");
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0002"]);
    const diagnostic = analysis.diagnostics[0]!;
    expect(slice(text, diagnostic.range)).toBe("L_Missing");
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.confidence).toBe("probable");
    expect(diagnostic.params).toEqual({ name: "L_Missing" });
  });

  it("verifie les cibles de callsub (identifiant) et ignore une cible chaine ou dynamique", () => {
    const text = npc('callsub L_Ok, 1;\ncallsub L_Nope;\ncallsub "L_Str";\ncallsub .@target$;\nclose;\nL_Ok:\nreturn;');
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0002"]);
    expect(slice(text, analysis.diagnostics[0]!.range)).toBe("L_Nope");
  });

  it("verifie la forme fonction de callsub utilisee comme expression", () => {
    const text = npc("set .@r, callsub(L_Absent, 2);\nclose;");
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0002"]);
    expect(slice(text, analysis.diagnostics[0]!.range)).toBe("L_Absent");
  });

  it("verifie les labels de menu (positions impaires) et ignore le tiret", () => {
    const text = npc('menu "A",L_A,"B",-,"C",L_C;\nmes "suite";\nclose;\nL_A:\nclose;');
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0002"]);
    expect(slice(text, analysis.diagnostics[0]!.range)).toBe("L_C");
    const references = firstScope(analysis).labelReferences;
    expect(references.map((r) => [r.via, r.name])).toEqual([
      ["menu", "L_A"],
      ["menu", "L_C"],
    ]);
  });

  it("verifie le label de jump_zero", () => {
    const text = npc("jump_zero(.@x, L_Gone);\nclose;");
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0002"]);
    expect(slice(text, analysis.diagnostics[0]!.range)).toBe("L_Gone");
  });

  it("limite la portee des labels a chaque script", () => {
    const text = npc("L_Only:\nclose;", "A") + npc("goto L_Only;\nclose;", "B");
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0002"]);
    expect(analysis.diagnostics[0]!.range.start).toBeGreaterThan(text.indexOf("script\tB"));
  });

  it("trouve les labels places dans des blocs imbriques", () => {
    const text = npc("if (.@a) {\n  goto L_Deep;\n} else {\n  L_Deep:\n  mes \"x\";\n}\nswitch (.@b) {\ncase 1:\n  goto L_Case;\n  L_Case:\n  break;\n}\nclose;");
    expect(codes(analyze(text))).toEqual([]);
    expect(firstScope(analyze(text)).labels.map((l) => l.name)).toEqual(["L_Deep", "L_Case"]);
  });

  it("signale les labels definis plusieurs fois, sans tenir compte de la casse, sur les doublons seulement", () => {
    const text = npc("L_X:\nmes \"1\";\nl_x:\nmes \"2\";\nL_X:\nclose;");
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0003", "RA0003"]);
    expect(analysis.diagnostics.map((d) => slice(text, d.range))).toEqual(["l_x", "L_X"]);
    expect(analysis.diagnostics[0]!.severity).toBe("error");
    expect(analysis.diagnostics[0]!.confidence).toBe("certain");
  });

  it("ne confond pas un meme label dans deux NPC distincts", () => {
    const text = npc("L_X:\nclose;", "A") + npc("L_X:\nclose;", "B");
    expect(codes(analyze(text))).toEqual([]);
  });

  it("ne signale rien dans une portee incomplete (region brute ou bloc non ferme)", () => {
    const unclosed = `${HEADER}\n  goto L_Hidden;\n  if (1) {\n    mes "x";\n`;
    const analysis = analyze(unclosed);
    expect(firstScope(analysis).complete).toBe(false);
    expect(codes(analysis)).not.toContain("RA0002");
  });

  it("ne signale rien quand l'analyse syntaxique a ete tronquee par la limite de profondeur", () => {
    const text = npc("goto L_Missing;\nif (1) { if (1) { if (1) { if (1) { mes \"x\"; } } } }\nclose;");
    const truncated = analyzeFile(parse(text, { maxDepth: 3 }), "t.txt");
    expect(truncated.declarations.every((d) => d.scope === null || !d.scope.complete)).toBe(true);
    expect(truncated.diagnostics.filter((d) => d.code === "RA0002")).toEqual([]);
  });
});

describe("analyzeFile : fonctions locales (RA0012)", () => {
  it("accepte une fonction declaree puis definie, appelee par callsub et par son nom", () => {
    const text = npc("function Helper;\nHelper 1;\ncallsub Helper, 2;\nclose;\nfunction Helper {\n  return;\n}");
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual([]);
    const scope = firstScope(analysis);
    expect(scope.functionDeclarations.map((f) => f.name)).toEqual(["Helper"]);
    expect(scope.labels.map((l) => [l.name, l.kind])).toEqual([["Helper", "function"]]);
    expect(scope.labelReferences.map((r) => r.via).sort()).toEqual(["call", "callsub"]);
  });

  it("signale une fonction locale declaree mais jamais definie (erreur certaine)", () => {
    const text = npc("function Ghost;\nclose;");
    const analysis = analyze(text);
    expect(codes(analysis)).toEqual(["RA0012"]);
    const diagnostic = analysis.diagnostics[0]!;
    expect(slice(text, diagnostic.range)).toBe("Ghost");
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.confidence).toBe("certain");
  });

  it("considere comme defini un nom declare par function X; puis defini par un label X: (comportement du serveur)", () => {
    expect(codes(analyze(npc("function Both;\nclose;\nBoth:\nreturn;")))).toEqual([]);
  });

  it("partage l'espace de noms entre labels et fonctions locales", () => {
    const text = npc("Twin:\nclose;\nfunction twin {\n  return;\n}");
    expect(codes(analyze(text))).toEqual(["RA0003"]);
  });

  it("ne signale pas comme label manquant une fonction seulement declaree", () => {
    const text = npc("function Later;\ncallsub Later;\nclose;");
    expect(codes(analyze(text))).toEqual(["RA0012"]);
  });

  it("partage les labels entre le script et le corps de ses fonctions locales", () => {
    const text = npc("function Run {\n  goto L_Out;\n}\nclose;\nL_Out:\nclose;");
    expect(codes(analyze(text))).toEqual([]);
  });
});

describe("analyzeFile : suggestions de style (RA0007)", () => {
  const body = "goto L_Used;\nL_Unused:\nmes \"x\";\nL_Used:\nclose;\nOnInit:\nend;";

  it("n'emet rien par defaut", () => {
    expect(codes(analyze(npc(body)))).toEqual([]);
  });

  it("signale un label jamais reference, en ignorant les labels d'evenement et les labels utilises", () => {
    const text = npc(body);
    const analysis = analyze(text, { styleHints: true });
    expect(codes(analysis)).toEqual(["RA0007"]);
    expect(slice(text, analysis.diagnostics[0]!.range)).toBe("L_Unused");
    expect(analysis.diagnostics[0]!.category).toBe("style-hint");
  });

  it("considere comme reference un label mentionne comme simple identifiant", () => {
    const analysis = analyze(npc("set .@dest, L_Dyn;\nclose;\nL_Dyn:\nreturn;"), { styleHints: true });
    expect(codes(analysis)).toEqual([]);
  });
});

describe("analyzeFile : references de fonctions globales", () => {
  it("enregistre callfunc \"Nom\" sous forme d'instruction et d'expression, avec la plage du litteral", () => {
    const text = npc('callfunc "F_One", 1;\nset .@r, callfunc("F_Two");\ncallfunc .@dyn$;\ncallfunc "Unterminated;\nclose;');
    const analysis = analyze(text);
    expect(analysis.functionReferences.map((r) => r.name)).toEqual(["F_One", "F_Two"]);
    expect(slice(text, analysis.functionReferences[0]!.range)).toBe('"F_One"');
  });

  it("garde la casse du nom (callfunc est sensible a la casse)", () => {
    const analysis = analyze(npc('callfunc "f_one";\nclose;'));
    expect(analysis.functionReferences.map((r) => r.name)).toEqual(["f_one"]);
  });
});

describe("analyzeFile : variables", () => {
  it("separe les variables locales de chaque script des variables globales du fichier", () => {
    const text =
      npc('set .@a, 1;\n.@a += 2;\nset .npcvar, .@a;\n$global = 1;\n#acct = 2;\nset @temp, 3;\nmes "x" + .@a$;\nclose;', "One") +
      npc("set .@a, 9;\nclose;", "Two");
    const analysis = analyze(text);
    const one = analysis.declarations[0]!.scope!;
    const two = analysis.declarations[1]!.scope!;
    expect(one.variables.map((v) => v.key).sort()).toEqual([".@a", ".@a$", ".npcvar"]);
    expect(two.variables.map((v) => v.key)).toEqual([".@a"]);
    const a = one.variables.find((v) => v.key === ".@a")!;
    expect(a.occurrences).toBe(3);
    expect(a.scope).toBe("script");
    expect(a.isString).toBe(false);
    expect(slice(text, a.firstWriteRange!)).toBe(".@a");
    expect(analysis.globalVariables.map((v) => [v.key, v.scope]).sort()).toEqual([
      ["#acct", "account-local"],
      ["$global", "global-permanent"],
      ["@temp", "character-temporary"],
    ]);
  });

  it("traite les noms de variables sans tenir compte de la casse et reconnait les tableaux", () => {
    const analysis = analyze(npc("set .@Count, 1;\n.@COUNT[2] = 5;\nclose;"));
    const variables = firstScope(analysis).variables;
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({ key: ".@count", name: "Count", occurrences: 2, isArray: true });
  });

  it("distingue une variable lue d'une variable ecrite", () => {
    const analysis = analyze(npc("mes .@read;\nset .@write, 1;\nsetarray .@arr[0], 1, 2;\n.@inc++;\nclose;"));
    const byKey = new Map(firstScope(analysis).variables.map((v) => [v.key, v]));
    expect(byKey.get(".@read")?.firstWriteRange).toBeNull();
    expect(byKey.get(".@write")?.firstWriteRange).not.toBeNull();
    expect(byKey.get(".@arr")?.firstWriteRange).not.toBeNull();
    expect(byKey.get(".@inc")?.firstWriteRange).not.toBeNull();
  });
});

describe("analyzeFile : robustesse", () => {
  it("trie les diagnostics par position et ne depasse jamais le texte", () => {
    const text = npc("goto L_Z;\nL_A:\nL_a:\ngoto L_Y;\nclose;");
    const analysis = analyze(text);
    const starts = analysis.diagnostics.map((d) => d.range.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (const d of analysis.diagnostics) {
      expect(d.range.start).toBeGreaterThanOrEqual(0);
      expect(d.range.end).toBeLessThanOrEqual(text.length);
    }
  });

  it("est serialisable en JSON sans perte (donnees simples uniquement)", () => {
    const analysis = analyze(npc("goto L_X;\nL_X:\nset .@a, 1;\nclose;"));
    expect(JSON.parse(JSON.stringify(analysis))).toEqual(analysis);
  });

  it("ne leve jamais d'exception et garde des plages valides sur du texte arbitraire", () => {
    const fragments = [
      "goto ", "callsub ", "menu ", "function ", "L_A:", "L_B:", "{", "}", ";", ",", "\"", "(", ")", "\n", "\t",
      "prontera,1,1,0\tscript\tN\t1,{", "-\tscript\tF\t-1,{", "function\tscript\tG\t{", "callfunc \"F\"", ".@x", "$y", "if (1) ", "else ",
      "OnInit:", "L_A", "-", "set ", "/*", "*/", "//",
    ];
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 300; round += 1) {
      let text = "";
      const length = 5 + Math.floor(random() * 40);
      for (let i = 0; i < length; i += 1) text += fragments[Math.floor(random() * fragments.length)]!;
      const analysis = analyze(text, { styleHints: true });
      for (const d of analysis.diagnostics) {
        expect(d.range.start).toBeGreaterThanOrEqual(0);
        expect(d.range.end).toBeLessThanOrEqual(text.length);
        expect(d.range.start).toBeLessThanOrEqual(d.range.end);
      }
    }
  });
});

function registryOf(entries: Record<string, string | null>): CommandRegistry {
  const definitions: CommandDefinition[] = Object.entries(entries).map(([name, types]) => ({
    name,
    arity: types === null ? null : parseParameterTypes(types),
    parameterTypes: types,
    signatures: [],
    documentation: null,
    deprecated: false,
    conditional: false,
    sources: [{ kind: types === null ? "server-doc" : "server-source", reference: "test" }],
  }));
  return CommandRegistry.create(definitions, "rAthena");
}

const COMMANDS = registryOf({
  mes: "s*",
  next: "",
  close: "",
  rand: "i?",
  callfunc: "s*",
  callsub: "l*",
  menu: "sl*",
  set: "rv?",
  doc_only: null,
});

describe("analyzeFile : registre de commandes", () => {
  const withCommands = (body: string): FileAnalysis => analyze(npc(body), { commands: COMMANDS });
  const arityDiagnostics = (analysis: FileAnalysis): FileAnalysis["diagnostics"] => analysis.diagnostics.filter((d) => d.code === "RA0006");

  it("signale un nombre d'arguments que le serveur refuserait (RA0006), sur le nom de la commande", () => {
    const text = npc("mes;\nnext 1;\nset .@a;\nclose;");
    const found = arityDiagnostics(analyze(text, { commands: COMMANDS }));
    expect(found.map((d) => [slice(text, d.range), d.params])).toEqual([
      ["mes", { name: "mes", expected: "1+", count: 0 }],
      ["next", { name: "next", expected: "0", count: 1 }],
      ["set", { name: "set", expected: "2-3", count: 1 }],
    ]);
    expect(found[0]).toMatchObject({
      severity: "warning",
      category: "semantic-error",
      confidence: "probable",
      source: "analyzer",
      message: "'mes' expects 1+ argument(s) but 0 were given.",
    });
  });

  it("ne tient pas compte de la casse du nom, comme le serveur", () => {
    expect(arityDiagnostics(withCommands("MES;\nClose;\nclose;")).map((d) => d.params?.["name"])).toEqual(["MES"]);
  });

  it("accepte tout nombre d'arguments dans l'intervalle de la commande", () => {
    expect(arityDiagnostics(withCommands('mes "a";\nmes "a", "b", "c";\nset .@a, 1;\nset .@a, 1, 2;\nclose;'))).toEqual([]);
  });

  it("verifie aussi les appels dans les expressions", () => {
    const found = arityDiagnostics(withCommands("set .@a, rand(1, 2, 3);\nset .@b, rand(5);\nclose;"));
    expect(found.map((d) => d.params)).toEqual([{ name: "rand", expected: "1-2", count: 3 }]);
  });

  it("verifie aussi les commandes dont le premier argument est un label ou une fonction", () => {
    const found = arityDiagnostics(withCommands('callfunc;\ncallsub;\nmenu "seul";\nclose;'));
    expect(found.map((d) => d.params)).toEqual([
      { name: "callfunc", expected: "1+", count: 0 },
      { name: "callsub", expected: "1+", count: 0 },
      { name: "menu", expected: "2+", count: 1 },
    ]);
  });

  it("ne verifie pas l'arite d'une commande dont seule la documentation est connue", () => {
    const analysis = withCommands("doc_only 1, 2, 3, 4;\ndoc_only;\nclose;");
    expect(arityDiagnostics(analysis)).toEqual([]);
    expect(analysis.unknownCalls).toEqual([]);
  });

  it("ne verifie pas une instruction mal formee, dont les arguments ont pu etre mal decoupes", () => {
    expect(arityDiagnostics(withCommands("next 1;\nclose;"))).toHaveLength(1);
    expect(arityDiagnostics(withCommands("next 1"))).toEqual([]);
  });

  it("garde les appels de noms inconnus, sauf les fonctions locales du script", () => {
    const text = npc(
      ['Inconnue 1;', "var_fn;", "Local 2;", "function Local {", "\treturn;", "}", "function Declared;", "Declared;", 'mes "x";', ".@v = Autre(3);", "close;"].join("\n"),
    );
    const analysis = analyze(text, { commands: COMMANDS });
    expect(analysis.unknownCalls.map((c) => slice(text, c.range))).toEqual(["Inconnue", "var_fn", "Autre"]);
    expect(analysis.unknownCalls.map((c) => c.name)).toEqual(["Inconnue", "var_fn", "Autre"]);
    const scope = firstScope(analysis);
    expect(scope.labelReferences.filter((r) => r.via === "call").map((r) => r.name)).toEqual(["Local", "Declared"]);
  });

  it("ne garde rien sans registre : ni RA0006 ni appel inconnu", () => {
    const analysis = analyze(npc("mes;\nInconnue 1;\nclose;"));
    expect(analysis.unknownCalls).toEqual([]);
    expect(codes(analysis)).not.toContain("RA0006");
  });

  it("reste serialisable en JSON avec un registre", () => {
    const analysis = analyze(npc("mes;\nInconnue 1;\nclose;"), { commands: COMMANDS });
    expect(JSON.parse(JSON.stringify(analysis))).toEqual(analysis);
  });

  it("ne leve jamais d'exception et garde des plages valides avec un registre, sur du texte arbitraire", () => {
    const fragments = ["mes ", "next", "foo(", "bar ", "rand(", "set ", ",", ";", "(", ")", "\"x\"", "1", ".@a", "function F;", "function G {", "}", "{", "\n", "callsub ", "menu ", "-"];
    let seed = 777;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 300; round += 1) {
      let body = "";
      const length = 4 + Math.floor(random() * 30);
      for (let i = 0; i < length; i += 1) body += fragments[Math.floor(random() * fragments.length)]!;
      const text = npc(body);
      const analysis = analyze(text, { commands: COMMANDS });
      for (const range of [...analysis.diagnostics, ...analysis.unknownCalls].map((item) => item.range)) {
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.end).toBeLessThanOrEqual(text.length);
        expect(range.start).toBeLessThanOrEqual(range.end);
      }
    }
  });
});
