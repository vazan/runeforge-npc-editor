import { describe, expect, it } from "vitest";
import { LineIndex } from "@runeforge/runescript-core";
import type { Position } from "@runeforge/runescript-core";
import { completionContextAt } from "./completion-context";
import { LanguageServer } from "./server";
import { CompletionItemKind } from "./types";

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;
const fn = (name: string): string => `function\tscript\t${name}\t{\n\treturn;\n}\n`;

/** Ouvre `source` (dont le caractere `|` marque le curseur, retire du texte) et renvoie la position du curseur. */
function open(ls: LanguageServer, uri: string, source: string, version = 1): { text: string; position: Position; offset: number } {
  const offset = source.indexOf("|");
  if (offset === -1) throw new Error("curseur | absent");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  ls.updateDocument(uri, version, text);
  return { text, position: new LineIndex(text).positionAt(offset), offset };
}

function labelsOf(ls: LanguageServer, uri: string, position: Position): string[] {
  return ls.completion(uri, position).map((item) => item.label).sort();
}

const BODY = 'OnInit:\nend;\nL_Menu:\nmes "a";\nfunction Helper {\n  return;\n}\nL_End:\nclose;';

describe("contexte de completion", () => {
  const ctx = (source: string) => {
    const offset = source.indexOf("|");
    return completionContextAt(source.slice(0, offset) + source.slice(offset + 1), offset);
  };

  it("reconnait les arguments de label de goto, callsub, menu et jump_zero", () => {
    expect(ctx("\tgoto |;")).toMatchObject({ kind: "label", partial: "" });
    expect(ctx("\tgoto L_M|;")).toMatchObject({ kind: "label", partial: "L_M" });
    expect(ctx("\tcallsub |, 1;")).toMatchObject({ kind: "label" });
    expect(ctx("\tcallsub (L_|")).toMatchObject({ kind: "label", partial: "L_" });
    expect(ctx('\tmenu "a", |')).toMatchObject({ kind: "label" });
    expect(ctx('\tmenu "a", L_A, "b", L|')).toMatchObject({ kind: "label", partial: "L" });
    expect(ctx("\tjump_zero(.@x, |")).toMatchObject({ kind: "label" });
    expect(ctx("\tL_Start: goto |")).toMatchObject({ kind: "label" });
  });

  it("reconnait un goto apres une condition ou un else", () => {
    expect(ctx("\tif (.@a == 1) goto |")).toMatchObject({ kind: "label" });
    expect(ctx("\tif ((.@a + 1) > f(2, 3)) goto L_|")).toMatchObject({ kind: "label", partial: "L_" });
    expect(ctx("\telse goto |")).toMatchObject({ kind: "label" });
    expect(ctx("\telse if (.@a) callsub |")).toMatchObject({ kind: "label" });
    expect(ctx("\twhile (.@i < 3) goto |")).toMatchObject({ kind: "label" });
    // Pas un label : une commande ou une fonction native peut s'ecrire en operande.
    expect(ctx("\tif (.@a == 1) mes |")).toMatchObject({ kind: "command", position: "expression" });
  });

  it("reconnait callfunc, callsub et goto employes dans une expression", () => {
    expect(ctx('\tset .@r, callfunc("F_|')).toMatchObject({ kind: "function-name", partial: "F_" });
    expect(ctx('\t.@r = callfunc "F_|')).toMatchObject({ kind: "function-name", partial: "F_" });
    expect(ctx('\tif (callfunc("F_Ok") && callfunc("|')).toMatchObject({ kind: "function-name", partial: "" });
    expect(ctx("\tset .@r, callsub(L_|")).toMatchObject({ kind: "label", partial: "L_" });
    expect(ctx('\tcallfunc(\n\t\t"F_|')).toMatchObject({ kind: "function-name", partial: "F_" });
    // Une autre chaine est l'argument d'une commande : le service verra s'il s'agit d'un objet, d'un monstre ou d'une carte.
    expect(ctx('\tcallfunc(\n\t\t"F_Ok",\n\t\t"|')).toMatchObject({ kind: "string-argument", command: "callfunc", argumentIndex: 1 });
    expect(ctx('\tmenu "a", L_A,\n\t\t"b", |')).toMatchObject({ kind: "label" });
    expect(ctx('\tcallfunc("F_Ok", "|')).toMatchObject({ kind: "string-argument", command: "callfunc", argumentIndex: 1 });
    expect(ctx('\tmes callfunc("F_Ok", 1) + "|')).toMatchObject({ kind: "string-argument", command: "mes", argumentIndex: 0 });
  });

  it("ne propose de label qu'aux positions de label", () => {
    expect(ctx("\tmenu |")).toMatchObject({ kind: "command", position: "expression" });
    expect(ctx('\tmenu "a", L_A, |')).toMatchObject({ kind: "command", position: "expression" });
    expect(ctx('\tmenu "a, b", |')).toMatchObject({ kind: "label" }); // la virgule d'une chaine ne compte pas
    expect(ctx("\tmes |")).toMatchObject({ kind: "command", position: "expression" });
    expect(ctx("\tclose;|")).toMatchObject({ kind: "command", position: "statement" });
    expect(ctx('\tmes "goto |')).toMatchObject({ kind: "string-argument", command: "mes", partial: "goto " });
    expect(ctx("\t// goto |")).toBeUndefined();
    expect(ctx("\t/* goto |")).toBeUndefined();
    expect(ctx("\tgoto L_A(|")).toMatchObject({ kind: "command", position: "expression" });
  });

  it("reconnait la cible de callfunc dans la chaine, avec ou sans parenthese, et delimite le remplacement", () => {
    expect(ctx('\tcallfunc "F_|";')).toMatchObject({ kind: "function-name", partial: "F_" });
    expect(ctx('\tcallfunc("|')).toMatchObject({ kind: "function-name", partial: "" });
    expect(ctx('\tcallfunc "F_|Lib", 1;')).toMatchObject({ kind: "function-name", partial: "F_" });
    expect(ctx('\tcallfunc "F_Lib", "|')).toMatchObject({ kind: "string-argument", command: "callfunc", argumentIndex: 1 });
    const source = '\tcallfunc "F_|Lib", 1;';
    const offset = source.indexOf("|");
    const text = source.slice(0, offset) + source.slice(offset + 1);
    const found = completionContextAt(text, offset);
    expect(found && text.slice(found.start, found.end)).toBe("F_Lib");
  });

  it("reconnait le nom du NPC source dans l'en-tete d'un duplicate", () => {
    expect(ctx("prontera,1,1,0\tduplicate(Sou|)\tCopy\t100")).toMatchObject({ kind: "npc-name", partial: "Sou" });
    expect(ctx("prontera,1,1,0\tscript\tNom|\t100,{")).toBeUndefined();
  });

  it("reconnait un fragment de variable, quel que soit son prefixe", () => {
    for (const prefix of [".@", ".", "@", "$", "$@", "#", "##", "'"]) {
      expect(ctx(`\tset ${prefix}co|, 1;`)).toMatchObject({ kind: "variable", partial: `${prefix}co` });
    }
    expect(ctx("\tmes .@|")).toMatchObject({ kind: "variable", partial: ".@" });
  });

  it("etend le remplacement jusqu'a la fin du mot sous le curseur", () => {
    const source = "\tgoto L_M|enu;";
    const offset = source.indexOf("|");
    const text = source.slice(0, offset) + source.slice(offset + 1);
    const found = completionContextAt(text, offset);
    expect(found && text.slice(found.start, found.end)).toBe("L_Menu");
  });
});

describe("completion", () => {
  it("propose les labels, evenements et fonctions locales du script dans goto/callsub/menu", () => {
    const ls = new LanguageServer();
    const { position, text } = open(ls, "a.txt", npc(`${BODY}\ngoto |;`));
    const items = ls.completion("a.txt", position);
    expect(items.map((item) => [item.label, item.kind]).sort()).toEqual([
      ["Helper", CompletionItemKind.Function],
      ["L_End", CompletionItemKind.Field],
      ["L_Menu", CompletionItemKind.Field],
      ["OnInit", CompletionItemKind.Event],
    ]);
    // Aucun fragment saisi : le remplacement est vide, a la position du curseur.
    expect(items[0]?.range.start).toEqual(position);
    expect(items[0]?.range.end).toEqual(position);
    expect(text).toContain("goto ;");
  });

  it("ne propose que les labels du script courant", () => {
    const ls = new LanguageServer();
    const { position } = open(ls, "a.txt", npc("L_One:\nclose;", "A") + npc("L_Two:\ngoto |;", "B"));
    expect(labelsOf(ls, "a.txt", position)).toEqual(["L_Two"]);
  });

  it("remplace le fragment deja saisi et le mot qui le prolonge", () => {
    const ls = new LanguageServer();
    const { position, text } = open(ls, "a.txt", npc(`${BODY}\ngoto L_M|enu;`));
    const item = ls.completion("a.txt", position).find((candidate) => candidate.label === "L_Menu");
    expect(item).toBeDefined();
    const index = new LineIndex(text);
    const start = index.offsetAt(item!.range.start, text);
    const end = index.offsetAt(item!.range.end, text);
    expect(text.slice(start, end)).toBe("L_Menu");
  });

  it("propose les fonctions globales du projet dans callfunc, classees par pertinence, sans doublon", () => {
    const ls = new LanguageServer();
    ls.indexText("lib.txt", fn("F_Lib") + fn("F_Other") + fn("Heal") + fn("F_Lib"));
    const { position } = open(ls, "a.txt", npc('callfunc "F_|";\nclose;'));
    const items = ls.completion("a.txt", position);
    expect(items.map((item) => item.label)).toEqual(["F_Lib", "F_Other"]);
    expect(items[0]).toMatchObject({ kind: CompletionItemKind.Function, detail: "lib.txt" });
  });

  it("remplace tout le contenu de la chaine de callfunc jusqu'au guillemet fermant", () => {
    const ls = new LanguageServer();
    ls.indexText("lib.txt", fn("F_Lib"));
    const { position, text } = open(ls, "a.txt", npc('callfunc "F_|Old";\nclose;'));
    const [item] = ls.completion("a.txt", position);
    const index = new LineIndex(text);
    expect(text.slice(index.offsetAt(item!.range.start, text), index.offsetAt(item!.range.end, text))).toBe("F_Old");
  });

  it("complete aussi un nom de fonction ecrit sur la ligne qui suit `callfunc(`", () => {
    const ls = new LanguageServer();
    ls.indexText("lib.txt", fn("F_Lib"));
    const { position, text } = open(ls, "a.txt", npc('callfunc(\n\t"F_|Old",\n\t1);\nclose;'));
    const [item] = ls.completion("a.txt", position);
    expect(item?.label).toBe("F_Lib");
    const index = new LineIndex(text);
    expect(text.slice(index.offsetAt(item!.range.start, text), index.offsetAt(item!.range.end, text))).toBe("F_Old");
  });

  it("propose les noms uniques de NPC dans l'en-tete d'un duplicate", () => {
    const ls = new LanguageServer();
    ls.indexText("src.txt", npc("close;", "Source::SourceUnique") + npc("close;", "Autre"));
    const { position } = open(ls, "dup.txt", "prontera,2,2,0\tduplicate(Sou|)\tCopy\t100\n");
    const items = ls.completion("dup.txt", position);
    expect(items.map((item) => item.label)).toEqual(["SourceUnique"]);
    expect(items[0]).toMatchObject({ kind: CompletionItemKind.Class, detail: "script prontera" });
  });

  it("propose les variables visibles : locales du script et globales du fichier, sans se proposer soi-meme", () => {
    const ls = new LanguageServer();
    const source = npc("set .@count, 1;\nset .@color$, \"a\";\n$total = 2;\nmes .@co|;\nclose;", "A") + npc("set .@other, 1;\nclose;", "B");
    const { position } = open(ls, "a.txt", source);
    expect(labelsOf(ls, "a.txt", position)).toEqual([".@color$", ".@count"]);

    const dollar = open(ls, "a.txt", npc("$total = 1;\n$total2 = 2;\nmes $|;\nclose;"), 2);
    expect(labelsOf(ls, "a.txt", dollar.position)).toEqual(["$total", "$total2"]);
  });

  it("n'inclut pas la variable en cours de saisie quand elle est seule", () => {
    const ls = new LanguageServer();
    const { position } = open(ls, "a.txt", npc("mes .@new|;\nclose;"));
    expect(ls.completion("a.txt", position)).toEqual([]);
  });

  it("ne propose rien dans le texte, les commentaires, les chaines et hors des cas pris en charge", () => {
    const ls = new LanguageServer();
    for (const source of ['mes "goto |";', "// goto |", "mes |;", "close;|"]) {
      const { position } = open(ls, "a.txt", npc(source));
      expect(ls.completion("a.txt", position)).toEqual([]);
    }
    expect(ls.completion("absent.txt", { line: 0, character: 0 })).toEqual([]);
  });

  it("ne leve jamais d'exception sur des textes et des positions arbitraires", () => {
    const fragments = ["goto ", "callsub ", "menu ", "callfunc \"", "duplicate(", ".@", "$", "L_A:", "{", "}", ";", ",", "\"", "(", ")", "\n", "\t", "function ", "-"];
    let seed = 424242;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ls = new LanguageServer();
    ls.indexText("lib.txt", fn("F_Lib") + npc("close;", "Known"));
    for (let round = 0; round < 300; round += 1) {
      let text = "";
      for (let i = 0, n = 3 + Math.floor(random() * 25); i < n; i += 1) text += fragments[Math.floor(random() * fragments.length)]!;
      ls.updateDocument("f.txt", round, text);
      ls.completion("f.txt", { line: Math.floor(random() * 5), character: Math.floor(random() * 30) });
      ls.hover("f.txt", { line: Math.floor(random() * 5), character: Math.floor(random() * 30) });
    }
  });
});

describe("survol", () => {
  const setup = (): LanguageServer => {
    const ls = new LanguageServer();
    ls.indexText("lib.txt", fn("F_Lib"));
    ls.indexText("src.txt", npc("close;", "Source") + "prontera,3,3,0\tduplicate(Source)\tC1\t100\n");
    ls.indexText("other.txt", npc('callfunc "F_Lib";\nclose;', "Other"));
    return ls;
  };

  it("decrit un label defini : type, evenement, ligne et nombre de references", () => {
    const ls = setup();
    const { position } = open(ls, "a.txt", npc("goto L_|End;\nclose;\nL_End:\nclose;\nOnInit:\nend;"));
    expect(ls.hover("a.txt", position)).toMatchObject({ kind: "label", name: "L_End", isFunction: false, isEvent: false, defined: true, line: 4, references: 1 });
    const event = open(ls, "a.txt", npc("OnI|nit:\nend;"), 2);
    expect(ls.hover("a.txt", event.position)).toMatchObject({ kind: "label", isEvent: true, defined: true, references: 0 });
  });

  it("signale un label inconnu et distingue une fonction locale", () => {
    const ls = setup();
    const missing = open(ls, "a.txt", npc("goto L_Mis|sing;\nclose;"));
    expect(ls.hover("a.txt", missing.position)).toMatchObject({ kind: "label", defined: false, line: null });
    const local = open(ls, "a.txt", npc("function Help|er {\n  return;\n}\nclose;"), 2);
    expect(ls.hover("a.txt", local.position)).toMatchObject({ kind: "label", isFunction: true, defined: true });
  });

  it("decrit une fonction globale : definitions et nombre d'appels dans le projet", () => {
    const ls = setup();
    const { position } = open(ls, "a.txt", npc('callfunc "F_|Lib";\nclose;'));
    expect(ls.hover("a.txt", position)).toMatchObject({
      kind: "function",
      name: "F_Lib",
      definitions: [{ uri: "lib.txt", line: 1 }],
      references: 2,
    });
  });

  it("decrit un NPC (type, carte, emplacement) et le nombre de duplicate() qui le visent", () => {
    const ls = setup();
    const { position } = open(ls, "dup.txt", "prontera,9,9,0\tduplicate(Sou|rce)\tCopy\t100\n");
    expect(ls.hover("dup.txt", position)).toMatchObject({
      kind: "npc",
      name: "Source",
      definitions: [{ uri: "src.txt", line: 1, npcType: "script", displayName: "Source", map: "prontera" }],
      references: 2, // le duplicate de src.txt et celui du document ouvert
    });
  });

  it("decrit une variable : portee, type, occurrences et premiere ecriture", () => {
    const ls = setup();
    const { position } = open(ls, "a.txt", npc("mes .@na|me$;\nset .@name$, \"x\";\n.@name$ += \"y\";\nclose;"));
    expect(ls.hover("a.txt", position)).toMatchObject({
      kind: "variable",
      name: ".@name$",
      scope: "script",
      isString: true,
      isArray: false,
      occurrences: 3,
      firstWriteLine: 3,
    });
  });

  it("ne renvoie rien hors d'un symbole ou pour un document non ouvert", () => {
    const ls = setup();
    const { position } = open(ls, "a.txt", npc('mes "te|xte";\nclose;'));
    expect(ls.hover("a.txt", position)).toBeUndefined();
    expect(ls.hover("absent.txt", { line: 0, character: 0 })).toBeUndefined();
  });
});
