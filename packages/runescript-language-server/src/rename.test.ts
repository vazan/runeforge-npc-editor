import { describe, expect, it } from "vitest";
import { LineIndex } from "@runeforge/runescript-core";
import type { Position } from "@runeforge/runescript-core";
import { LanguageServer } from "./server";
import type { RenameResult, TextEdit } from "./rename";

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;
const fn = (name: string): string => `function\tscript\t${name}\t{\n\treturn;\n}\n`;

/** Ouvre `source` (le caractere `|` marque le curseur, retire du texte) et renvoie le texte et la position. */
function open(ls: LanguageServer, source: string, version = 1): { text: string; position: Position } {
  const offset = source.indexOf("|");
  if (offset === -1) throw new Error("curseur | absent");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  ls.updateDocument("a.txt", version, text);
  return { text, position: new LineIndex(text).positionAt(offset) };
}

function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const index = new LineIndex(text);
  const absolute = edits.map((edit) => ({ start: index.offsetAt(edit.range.start, text), end: index.offsetAt(edit.range.end, text), text: edit.newText }));
  let result = text;
  for (const edit of absolute.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function renamed(ls: LanguageServer, source: string, newName: string): { result: RenameResult; text: string; after: string | null } {
  const { text, position } = open(ls, source);
  const result = ls.rename("a.txt", position, newName);
  return { result, text, after: result.ok ? applyEdits(text, result.edits) : null };
}

describe("renommage de labels", () => {
  it("renomme la definition et toutes les references du script (goto, callsub, menu, jump_zero)", () => {
    const ls = new LanguageServer();
    const { after } = renamed(
      ls,
      npc('goto L_Old;\ncallsub L_Old, 1;\nmenu "a", L_Old, "b", L_Old;\njump_zero(.@x, L_Old);\nL_O|ld:\nclose;'),
      "L_New",
    );
    expect(after).toBe(npc('goto L_New;\ncallsub L_New, 1;\nmenu "a", L_New, "b", L_New;\njump_zero(.@x, L_New);\nL_New:\nclose;'));
  });

  it("se declenche depuis une reference comme depuis la definition, sans toucher aux autres scripts", () => {
    const ls = new LanguageServer();
    const { after } = renamed(ls, npc("goto L_|X;\nL_X:\nclose;", "A") + npc("goto L_X;\nL_X:\nclose;", "B"), "L_Y");
    expect(after).toBe(npc("goto L_Y;\nL_Y:\nclose;", "A") + npc("goto L_X;\nL_X:\nclose;", "B"));
  });

  it("accepte un changement de casse seul et renomme aussi une fonction locale, sa declaration et ses appels", () => {
    const ls = new LanguageServer();
    const { after } = renamed(ls, npc("function Help|er;\nHelper 1;\ncallsub helper;\nclose;\nfunction Helper {\n  return;\n}"), "Assist");
    expect(after).toBe(npc("function Assist;\nAssist 1;\ncallsub Assist;\nclose;\nfunction Assist {\n  return;\n}"));
    const caseOnly = renamed(ls, npc("goto L_a;\nL_|A:\nclose;"), "L_Z").after;
    expect(caseOnly).toContain("L_Z:");
    const sameKey = renamed(ls, npc("goto L_a;\nL_|A:\nclose;"), "l_a");
    expect(sameKey.result.ok).toBe(true);
  });

  it("laisse le script sans nouveau diagnostic apres le renommage", () => {
    const ls = new LanguageServer();
    const { after } = renamed(ls, npc("goto L_One;\nmenu \"x\", L_One, \"y\", L_Two;\nL_O|ne:\nclose;\nL_Two:\nclose;"), "L_Renamed");
    ls.updateDocument("a.txt", 2, after ?? "");
    expect(ls.diagnostics("a.txt")).toEqual([]);
  });

  it("refuse : label inconnu, evenement, nom invalide, nom deja pris, script incomplet", () => {
    const ls = new LanguageServer();
    const reason = (source: string, name: string): string => {
      const { result } = renamed(ls, source, name);
      return result.ok ? "ok" : result.reason;
    };
    expect(reason(npc("goto L_Mis|sing;\nclose;"), "L_X")).toBe("not-renameable");
    expect(reason(npc("OnIn|it:\nend;"), "L_X")).toBe("event-label");
    expect(reason(npc("L_A:\nL_|B:\nclose;"), "L_A")).toBe("name-taken");
    expect(reason(npc("L_A:\nL_|B:\nclose;"), "l_a")).toBe("name-taken");
    expect(reason(npc("L_|A:\nclose;"), "OnTouch")).toBe("invalid-name"); // deviendrait un evenement
    expect(reason(npc("L_|A:\nclose;"), "12")).toBe("invalid-name");
    expect(reason(npc("L_|A:\nclose;"), "0xFF")).toBe("invalid-name");
    expect(reason(npc("L_|A:\nclose;"), "goto")).toBe("invalid-name");
    expect(reason(npc("L_|A:\nclose;"), "avec espace")).toBe("invalid-name");
    expect(reason(npc("L_|A:\nclose;"), "")).toBe("invalid-name");
    expect(reason(`prontera,1,1,0\tscript\tT\t1,{\n  goto L_A;\n  L_|A:\n  if (1) {\n    mes "x";\n`, "L_B")).toBe("incomplete-script");
  });
});

describe("renommage de variables locales", () => {
  it("renomme toutes les occurrences en gardant le prefixe, l'indice et le suffixe chaine", () => {
    const ls = new LanguageServer();
    const { after } = renamed(ls, npc("set .@na|me$, \"a\";\n.@name$ += \"b\";\nmes .@name$;\nset .@name, 1;\nclose;"), "title");
    expect(after).toBe(npc("set .@title$, \"a\";\n.@title$ += \"b\";\nmes .@title$;\nset .@name, 1;\nclose;"));
    const array = renamed(ls, npc("setarray .@lis|t[0], 1, 2;\nmes .@list[1];\nclose;"), "items").after;
    expect(array).toBe(npc("setarray .@items[0], 1, 2;\nmes .@items[1];\nclose;"));
  });

  it("limite le renommage au script courant et traite `.x` (variable de NPC) comme `.@x`", () => {
    const ls = new LanguageServer();
    const { after } = renamed(ls, npc("set .cou|nt, 1;\nmes .count;\nclose;", "A") + npc("set .count, 2;\nclose;", "B"), "total");
    expect(after).toBe(npc("set .total, 1;\nmes .total;\nclose;", "A") + npc("set .count, 2;\nclose;", "B"));
  });

  it("refuse : variable globale, collision avec une autre variable du script, nom invalide", () => {
    const ls = new LanguageServer();
    const reason = (source: string, name: string): string => {
      const { result } = renamed(ls, source, name);
      return result.ok ? "ok" : result.reason;
    };
    expect(reason(npc("$tot|al = 1;\nclose;"), "sum")).toBe("not-renameable");
    expect(reason(npc("set .@a|, 1;\nset .@b, 2;\nclose;"), "b")).toBe("name-taken");
    expect(reason(npc("set .@a|, 1;\nset .@b$, 2;\nclose;"), "b")).toBe("ok"); // .@b$ est une autre variable que .@b
    expect(reason(npc("set .@a|, 1;\nclose;"), "bad name")).toBe("invalid-name");
  });
});

describe("preparation du renommage", () => {
  it("donne la plage et le nom actuel, et refuse hors d'un symbole renommable", () => {
    const ls = new LanguageServer();
    const label = open(ls, npc("goto L_Ta|rget;\nL_Target:\nclose;"));
    const prepared = ls.prepareRename("a.txt", label.position);
    expect(prepared).toMatchObject({ ok: true, placeholder: "L_Target" });
    const variable = open(ls, npc("set .@na|me$, \"a\";\nclose;"), 2);
    const preparedVariable = ls.prepareRename("a.txt", variable.position);
    expect(preparedVariable).toMatchObject({ ok: true, placeholder: "name" });
    if (preparedVariable.ok) {
      const text = variable.text;
      const index = new LineIndex(text);
      expect(text.slice(index.offsetAt(preparedVariable.range.start, text), index.offsetAt(preparedVariable.range.end, text))).toBe("name");
    }
    const nothing = open(ls, npc('mes "te|xte";\nclose;'), 3);
    expect(ls.prepareRename("a.txt", nothing.position)).toEqual({ ok: false, reason: "not-renameable" });
    expect(ls.prepareRename("absent.txt", { line: 0, character: 0 })).toEqual({ ok: false, reason: "not-renameable" });
    expect(ls.rename("absent.txt", { line: 0, character: 0 }, "x")).toEqual({ ok: false, reason: "not-renameable" });
  });

  it("ne propose pas de renommer une fonction globale ni un nom de NPC (references hors du script)", () => {
    const ls = new LanguageServer();
    ls.indexText("lib.txt", fn("F_Lib"));
    const call = open(ls, npc('callfunc "F_|Lib";\nclose;'));
    expect(ls.prepareRename("a.txt", call.position)).toEqual({ ok: false, reason: "not-renameable" });
    const header = open(ls, npc("close;", "Nam|e"), 2);
    expect(ls.prepareRename("a.txt", header.position)).toEqual({ ok: false, reason: "not-renameable" });
  });
});
