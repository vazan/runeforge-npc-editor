import { describe, expect, it } from "vitest";
import { CompletionItemKind, SymbolKind, type DocumentSymbol } from "@runeforge/runescript-language-server";
import { declarableCommandNames, startOf, toMonacoRange, toMonacoSignatureHelp, toMonacoSuggestion, toMonacoSymbols } from "./language-mapping";

const range = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });

describe("conversion des positions", () => {
  it("passe de la base 0 (LSP) a la base 1 (Monaco)", () => {
    expect(toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 5 } })).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 6,
    });
  });

  it("lit la position de depart d'une plage, d'une position ou de rien", () => {
    expect(startOf({ startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 9 })).toEqual({ line: 4, column: 7 });
    expect(startOf({ lineNumber: 2, column: 3 })).toEqual({ line: 2, column: 3 });
    expect(startOf(undefined)).toEqual({ line: 1, column: 1 });
  });
});

describe("conversion des propositions de completion", () => {
  it("traduit le type, le texte inserte et la plage (base 1)", () => {
    const base = { label: "L_Menu", detail: "label", sortText: "0l_menu", range: range(2, 5, 7) };
    expect(toMonacoSuggestion({ ...base, kind: CompletionItemKind.Field })).toEqual({
      label: "L_Menu",
      kind: 3,
      detail: "label",
      insertText: "L_Menu",
      filterText: "L_Menu",
      sortText: "0l_menu",
      range: { startLineNumber: 3, startColumn: 6, endLineNumber: 3, endColumn: 8 },
    });
    expect([CompletionItemKind.Function, CompletionItemKind.Variable, CompletionItemKind.Class, CompletionItemKind.Event].map((kind) => toMonacoSuggestion({ ...base, kind }).kind)).toEqual([1, 4, 5, 10]);
    expect(toMonacoSuggestion({ label: "x", kind: CompletionItemKind.Field, range: range(0, 0, 0), sortText: "x" }).detail).toBe("");
  });
});

describe("conversion des commandes", () => {
  const base = { label: "mes", detail: 'mes "<string>"', sortText: "1mes", range: range(1, 1, 2) };

  it("traduit le type mot-cle et signale les commandes pour la resolution de l'aide", () => {
    expect(toMonacoSuggestion({ label: "if", kind: CompletionItemKind.Keyword, range: range(0, 0, 0), sortText: "2if" })).toMatchObject({ kind: 17 });
    const item = toMonacoSuggestion({ ...base, kind: CompletionItemKind.Function, command: { source: "server-source", deprecated: false } });
    expect(item).toMatchObject({ label: "mes", kind: 1, commandName: "mes" });
    expect(item.tags).toBeUndefined();
    expect(toMonacoSuggestion({ ...base, kind: CompletionItemKind.Function })).not.toHaveProperty("commandName");
  });

  it("barre une commande obsolete dans la liste", () => {
    expect(toMonacoSuggestion({ ...base, kind: CompletionItemKind.Function, command: { source: "server-source", deprecated: true } }).tags).toEqual([1]);
  });

  it("transmet l'aide de signature avec la plage de chaque parametre et la documentation", () => {
    const help = {
      signatures: [
        { label: "warp(string, int, int)", parameters: [{ start: 5, end: 11 }, { start: 13, end: 16 }, { start: 18, end: 21 }] },
        { label: "warp2()", parameters: [] },
      ],
      activeSignature: 0,
      activeParameter: 2,
      command: {
        name: "warp",
        signatures: ["warp(string, int, int)"],
        arity: { min: 3, max: 3 },
        parameterTypes: "sii",
        documentation: null,
        documentationTruncated: false,
        deprecated: false,
        conditional: false,
        sources: [],
      },
    };
    const converted = toMonacoSignatureHelp(help, "Aide **Markdown**");
    expect(converted.activeSignature).toBe(0);
    expect(converted.activeParameter).toBe(2);
    expect(converted.signatures).toHaveLength(2);
    expect(converted.signatures[0]).toEqual({
      label: "warp(string, int, int)",
      documentation: { value: "Aide **Markdown**" },
      parameters: [{ label: [5, 11] }, { label: [13, 16] }, { label: [18, 21] }],
    });
    expect(converted.signatures[1]?.parameters).toEqual([]);
  });
});

describe("conversion des modeles de NPC (snippets)", () => {
  const item = {
    label: "npc-warp",
    kind: CompletionItemKind.Snippet,
    detail: "Warp portal",
    range: range(0, 0, 5),
    sortText: "3npc-warp",
    insertText: "${1:prontera},${2:155}\twarp\t$0",
    format: "snippet" as const,
    template: "npc-warp",
  };

  it("insere le texte du snippet et demande a Monaco de le traiter comme tel", () => {
    expect(toMonacoSuggestion(item)).toMatchObject({
      label: "npc-warp",
      kind: 27,
      insertText: "${1:prontera},${2:155}\twarp\t$0",
      insertTextRules: 4,
      filterText: "npc-warp",
      detail: "Warp portal",
    });
  });

  it("remplace la description par celle de l'interface, dans sa langue", () => {
    expect(toMonacoSuggestion(item, (id) => (id === "npc-warp" ? "Portail (warp)" : undefined)).detail).toBe("Portail (warp)");
    expect(toMonacoSuggestion(item, () => undefined).detail).toBe("Warp portal");
  });

  it("n'applique pas les regles de snippet a une proposition ordinaire", () => {
    const plain = toMonacoSuggestion({ label: "mes", kind: CompletionItemKind.Function, range: range(0, 0, 1), sortText: "1mes" });
    expect(plain.insertText).toBe("mes");
    expect(plain).not.toHaveProperty("insertTextRules");
  });
});

describe("action rapide : declarer une commande inconnue", () => {
  const marker = (code: string | { value: string } | undefined, column: number) => ({ code, startLineNumber: 3, startColumn: column, endLineNumber: 3, endColumn: column + 5 });
  const text = (value: string) => (): string => value;

  it("propose de declarer le nom d'une commande inconnue (RA0001) et pas les autres diagnostics", () => {
    const markers = [marker("RA0001", 2), marker("RA0002", 10), marker(undefined, 20)];
    const found = declarableCommandNames(markers, (m) => (m.startColumn === 2 ? "Inconnue" : "L_Autre"));
    expect(found.map((f) => f.name)).toEqual(["Inconnue"]);
    expect(found[0]?.marker).toBe(markers[0]);
    expect(declarableCommandNames([marker({ value: "RA0001" }, 2)], text("Objet")).map((f) => f.name)).toEqual(["Objet"]);
  });

  it("ecarte ce qui n'est pas un nom de commande et les noms en double", () => {
    expect(declarableCommandNames([marker("RA0001", 2)], text("1abc"))).toEqual([]);
    expect(declarableCommandNames([marker("RA0001", 2)], text("a b"))).toEqual([]);
    expect(declarableCommandNames([marker("RA0001", 2)], text(""))).toEqual([]);
    const twice = declarableCommandNames([marker("RA0001", 2), marker("RA0001", 12)], text("  Meme  "));
    expect(twice.map((f) => f.name)).toEqual(["Meme"]);
    const caseInsensitive = declarableCommandNames([marker("RA0001", 2), marker("RA0001", 12)], (m) => (m.startColumn === 2 ? "Cmd" : "CMD"));
    expect(caseInsensitive.map((f) => f.name)).toEqual(["Cmd"]);
  });
});

describe("conversion du plan du document", () => {
  const outline: DocumentSymbol[] = [
    {
      name: "Guide",
      detail: "prontera 150,150",
      kind: SymbolKind.Class,
      range: range(0, 0, 40),
      selectionRange: range(0, 20, 25),
      children: [{ name: "OnInit", kind: SymbolKind.Event, range: range(1, 0, 7), selectionRange: range(1, 0, 6), children: [] }],
    },
  ];

  it("decale le type de symbole (LSP commence a 1, Monaco a 0), conserve la hierarchie et complete le detail", () => {
    const [guide] = toMonacoSymbols(outline);
    expect(guide).toMatchObject({ name: "Guide", detail: "prontera 150,150", kind: SymbolKind.Class - 1 });
    expect(guide?.selectionRange).toEqual({ startLineNumber: 1, startColumn: 21, endLineNumber: 1, endColumn: 26 });
    expect(guide?.children).toHaveLength(1);
    expect(guide?.children[0]).toMatchObject({ name: "OnInit", detail: "", kind: SymbolKind.Event - 1, children: [] });
  });
});
