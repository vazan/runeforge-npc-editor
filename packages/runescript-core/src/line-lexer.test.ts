import { describe, expect, it } from "vitest";
import { INITIAL_LINE_STATE, tokenize, tokenizeLine, type LineLexState, type TokenKind } from "./index";

function lexByLines(text: string): { kinds: (TokenKind | "newline")[]; rebuilt: string } {
  const lines = text.split("\n");
  let state: LineLexState = INITIAL_LINE_STATE;
  const kinds: (TokenKind | "newline")[] = [];
  let rebuilt = "";
  lines.forEach((line, index) => {
    const result = tokenizeLine(line, state);
    state = result.endState;
    let position = 0;
    for (const token of result.tokens) {
      expect(token.range.start).toBe(position);
      position = token.range.end;
      for (let i = 0; i < token.text.length; i += 1) kinds.push(token.kind);
      rebuilt += token.text;
    }
    expect(position).toBe(line.length);
    if (index < lines.length - 1) {
      kinds.push("newline");
      rebuilt += "\n";
    }
  });
  return { kinds, rebuilt };
}

function lexWhole(text: string): (TokenKind | "newline")[] {
  const kinds: (TokenKind | "newline")[] = [];
  for (const token of tokenize(text)) {
    for (const char of token.text) {
      // Les fins de ligne sont des tokens a part ; dans un commentaire bloc multi-lignes elles en font partie.
      for (let i = 0; i < char.length; i += 1) kinds.push(char === "\n" ? "newline" : token.kind);
    }
  }
  return kinds;
}

describe("tokenizeLine", () => {
  it("decoupe une ligne simple comme tokenize", () => {
    const { tokens, endState } = tokenizeLine('\tmes "a"; // fin', INITIAL_LINE_STATE);
    expect(tokens.map((token) => [token.kind, token.text])).toEqual([
      ["Tabs", "\t"],
      ["Identifier", "mes"],
      ["Spaces", " "],
      ["String", '"a"'],
      ["Punctuation", ";"],
      ["Spaces", " "],
      ["LineComment", "// fin"],
    ]);
    expect(endState.inBlockComment).toBe(false);
  });

  it("suit un commentaire bloc sur plusieurs lignes", () => {
    const first = tokenizeLine("a /* debut", INITIAL_LINE_STATE);
    expect(first.endState.inBlockComment).toBe(true);
    expect(first.tokens.at(-1)).toMatchObject({ kind: "BlockComment", unterminated: true });
    const middle = tokenizeLine("toujours dans le commentaire", first.endState);
    expect(middle.tokens.map((token) => token.kind)).toEqual(["BlockComment"]);
    expect(middle.endState.inBlockComment).toBe(true);
    const last = tokenizeLine("fin */ b", middle.endState);
    expect(last.tokens.map((token) => [token.kind, token.text])).toEqual([
      ["BlockComment", "fin */"],
      ["Spaces", " "],
      ["Identifier", "b"],
    ]);
    expect(last.endState.inBlockComment).toBe(false);
  });

  it("gere une ligne vide dans un commentaire et un commentaire ouvert puis ferme puis rouvert", () => {
    expect(tokenizeLine("", { inBlockComment: true })).toEqual({ tokens: [], endState: { inBlockComment: true } });
    const result = tokenizeLine("*/ x /* y", { inBlockComment: true });
    expect(result.endState.inBlockComment).toBe(true);
    expect(result.tokens.map((token) => token.kind)).toEqual(["BlockComment", "Spaces", "Identifier", "Spaces", "BlockComment"]);
  });

  it("equivaut au lexer complet (propriete sur des textes multi-lignes aleatoires)", () => {
    const fragments = ["/*", "*/", "//", '"', "a", "x1", ".@v", "$g", " ", "\t", "\n", "\n", ";", "{", "}", "0x1F", "é", "+", "\\"];
    let state = 424242;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let run = 0; run < 400; run += 1) {
      let text = "";
      for (let i = 0, count = Math.floor(random() * 40); i < count; i += 1) text += fragments[Math.floor(random() * fragments.length)] ?? "";
      const byLine = lexByLines(text);
      expect(byLine.rebuilt).toBe(text);
      expect(byLine.kinds).toEqual(lexWhole(text));
    }
  });
});
