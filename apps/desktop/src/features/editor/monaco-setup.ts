import { INITIAL_LINE_STATE, tokenizeLine, type Token } from "@runeforge/runescript-core";
import { DECLARATION_KEYWORDS } from "@runeforge/runescript-parser";
// Monaco 0.57 : `editor.api` = API seule ; `features/register.all` = fonctionnalites d'edition (recherche, pliage,
// suggestions, survol...) sans les ~80 langages integres, inutiles ici (le langage RuneScript est enregistre ci-dessous).
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { TextBuffer } from "../../state/documents";

/**
 * Initialisation de Monaco : worker de l'editeur, langage RuneScript (coloration par le lexer du moteur),
 * themes clair/sombre et modeles de documents. Ce module est charge a la demande (premier fichier ouvert).
 */

export { monaco };
export const LANGUAGE_ID = "rathena-script";
export const THEME_DARK = "runeforge-dark";
export const THEME_LIGHT = "runeforge-light";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "else", "while", "for", "do", "switch", "case", "default", "break", "continue", "return", "goto", "function",
]);

class ScriptLineState implements monaco.languages.IState {
  constructor(readonly inBlockComment: boolean) {}

  clone(): monaco.languages.IState {
    return new ScriptLineState(this.inBlockComment);
  }

  equals(other: monaco.languages.IState): boolean {
    return other instanceof ScriptLineState && other.inBlockComment === this.inBlockComment;
  }
}

function variableScope(text: string): string {
  if (text.startsWith(".@")) return "variable.script";
  if (text.startsWith("$@")) return "variable.global-temp";
  if (text.startsWith("##")) return "variable.account-global";
  if (text.startsWith(".")) return "variable.npc";
  if (text.startsWith("@")) return "variable.temp";
  if (text.startsWith("$")) return "variable.global";
  if (text.startsWith("#")) return "variable.account";
  if (text.startsWith("'")) return "variable.instance";
  return "variable.character";
}

/** Categorie de coloration d'un token (convention Monaco : prefixes separes par des points). */
export function scopeOf(token: Token, previous: Token | undefined): string {
  switch (token.kind) {
    case "Spaces":
    case "Tabs":
    case "Newline":
      return "";
    case "LineComment":
    case "BlockComment":
      return "comment";
    case "String":
      return token.unterminated === true ? "string.invalid" : "string";
    case "Number":
      return "number";
    case "Identifier": {
      const word = token.text.toLowerCase();
      // Le type de declaration est le 2e champ d'une ligne separee par des tabulations.
      if (previous?.kind === "Tabs" && DECLARATION_KEYWORDS.has(word)) return "keyword.declaration";
      return CONTROL_KEYWORDS.has(word) ? "keyword.control" : "identifier";
    }
    case "Variable":
      return variableScope(token.text);
    case "Operator":
      return "operator";
    case "Punctuation":
      return "delimiter";
    case "Unknown":
      return "invalid";
  }
}

monaco.languages.register({ id: LANGUAGE_ID, aliases: ["RuneScript", "rAthena", "Hercules"], extensions: [".txt"] });

monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  // Un mot inclut les prefixes de variables (`.@x$`, `$@y`, `##z`) pour que la selection et la recherche les gardent entiers.
  wordPattern: /[.@$#']*[A-Za-z0-9_]+\$?/,
});

monaco.languages.setTokensProvider(LANGUAGE_ID, {
  getInitialState: () => new ScriptLineState(INITIAL_LINE_STATE.inBlockComment),
  tokenize(line, state) {
    const lineState = state instanceof ScriptLineState ? state : new ScriptLineState(false);
    const result = tokenizeLine(line, { inBlockComment: lineState.inBlockComment });
    const tokens: monaco.languages.IToken[] = [];
    let previous: Token | undefined;
    for (const token of result.tokens) {
      const scope = scopeOf(token, previous);
      const last = tokens[tokens.length - 1];
      if (last === undefined || last.scopes !== scope) tokens.push({ startIndex: token.range.start, scopes: scope });
      previous = token;
    }
    return { tokens, endState: new ScriptLineState(result.endState.inBlockComment) };
  },
});

monaco.editor.defineTheme(THEME_DARK, {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "7CA668", fontStyle: "italic" },
    { token: "string", foreground: "CE9178" },
    { token: "string.invalid", foreground: "F48771", fontStyle: "underline" },
    { token: "number", foreground: "B5CEA8" },
    { token: "keyword.control", foreground: "C586C0" },
    { token: "keyword.declaration", foreground: "6CB6FF", fontStyle: "bold" },
    { token: "variable.script", foreground: "9CDCFE" },
    { token: "variable.npc", foreground: "4FC1FF" },
    { token: "variable.temp", foreground: "DCDCAA" },
    { token: "variable.character", foreground: "DCDCAA" },
    { token: "variable.global", foreground: "4EC9B0" },
    { token: "variable.global-temp", foreground: "4EC9B0" },
    { token: "variable.account", foreground: "E5C07B" },
    { token: "variable.account-global", foreground: "E5C07B" },
    { token: "variable.instance", foreground: "F2A57B" },
    { token: "operator", foreground: "D4D4D4" },
    { token: "delimiter", foreground: "D4D4D4" },
    { token: "invalid", foreground: "F48771", fontStyle: "underline" },
  ],
  colors: {},
});

monaco.editor.defineTheme(THEME_LIGHT, {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "3F7F3F", fontStyle: "italic" },
    { token: "string", foreground: "A31515" },
    { token: "string.invalid", foreground: "CD3131", fontStyle: "underline" },
    { token: "number", foreground: "0B6E4F" },
    { token: "keyword.control", foreground: "8F00AF" },
    { token: "keyword.declaration", foreground: "0000C8", fontStyle: "bold" },
    { token: "variable.script", foreground: "001080" },
    { token: "variable.npc", foreground: "0451A5" },
    { token: "variable.temp", foreground: "795E26" },
    { token: "variable.character", foreground: "795E26" },
    { token: "variable.global", foreground: "1F6F85" },
    { token: "variable.global-temp", foreground: "1F6F85" },
    { token: "variable.account", foreground: "8A4B08" },
    { token: "variable.account-global", foreground: "8A4B08" },
    { token: "variable.instance", foreground: "A0522D" },
    { token: "operator", foreground: "000000" },
    { token: "delimiter", foreground: "000000" },
    { token: "invalid", foreground: "CD3131", fontStyle: "underline" },
  ],
  colors: {},
});

const models = new Map<string, monaco.editor.ITextModel>();

/**
 * Insere `text` a la place de la selection (ou au curseur) de l'editeur affiche, comme une saisie : annulable d'un Ctrl+Z, et le
 * document est marque modifie. `false` quand aucun editeur n'est affiche. Il n'y a qu'un groupe d'editeurs.
 */
export function insertAtCursor(text: string, insideString?: string): boolean {
  const editor = monaco.editor.getEditors().find((candidate) => candidate.getModel() !== null);
  const model = editor?.getModel();
  const selections = editor?.getSelections();
  if (editor === undefined || model === null || model === undefined || selections === null || selections === undefined || selections.length === 0) return false;
  editor.focus();
  editor.executeEdits(
    "runeforge.insertReference",
    selections.map((range) => {
      // Dans une chaine deja ouverte (nombre impair de guillemets avant le curseur), le texte sans guillemets.
      const before = model.getValueInRange({ startLineNumber: range.startLineNumber, startColumn: 1, endLineNumber: range.startLineNumber, endColumn: range.startColumn });
      const inString = insideString !== undefined && (before.replace(/\\./g, "").match(/"/g)?.length ?? 0) % 2 === 1;
      return { range, text: inString ? insideString : text, forceMoveMarkers: true };
    }),
  );
  return true;
}

/**
 * Ajoute `text` a la fin du document `path`, comme une saisie : annulable d'un Ctrl+Z (une seule etape d'annulation), et le
 * document est marque modifie. `false` si le document n'a pas de modele.
 */
export function appendToModel(path: string, text: string): boolean {
  const model = models.get(path);
  if (model === undefined) return false;
  const end = model.getFullModelRange().getEndPosition();
  model.pushStackElement();
  model.pushEditOperations([], [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text }], () => null);
  model.pushStackElement();
  return true;
}

/**
 * Remplace `[start, end)` (offsets du texte LF du modele) par `text`, comme une saisie : une seule etape d'annulation, et le document
 * est marque modifie. `false` si le document n'a pas de modele ou si la plage sort du texte.
 */
export function applyEditToModel(path: string, start: number, end: number, text: string): boolean {
  const model = models.get(path);
  if (model === undefined || start < 0 || end < start || end > model.getValueLength()) return false;
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(end);
  model.pushStackElement();
  model.pushEditOperations([], [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text }], () => null);
  model.pushStackElement();
  return true;
}

export function modelFor(path: string): monaco.editor.ITextModel | undefined {
  return models.get(path);
}

const URI_SCHEME = "runeforge";

/** URI du modele d'un document du projet (`runeforge:/npc/a.txt`). */
export function uriForPath(path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: URI_SCHEME, path: `/${path}` });
}

/** Chemin relatif du projet designe par une URI de modele, ou `undefined` si ce n'est pas un document du projet. */
export function pathOfUri(uri: monaco.Uri): string | undefined {
  return uri.scheme === URI_SCHEME ? uri.path.slice(1) : undefined;
}

/**
 * Cree le modele Monaco d'un document. Le modele utilise `\n` comme fin de ligne : les offsets de l'analyseur
 * (texte normalise en LF) coincident ainsi avec ceux de Monaco ; les fins de ligne reelles sont restituees a l'enregistrement.
 */
export function createModelBuffer(initialText: string, path: string, onEdit: () => void): TextBuffer {
  monaco.editor.getModel(uriForPath(path))?.dispose();
  const model = monaco.editor.createModel(initialText, LANGUAGE_ID, uriForPath(path));
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  const subscription = model.onDidChangeContent(() => onEdit());
  models.set(path, model);
  return {
    getText: () => model.getValue(monaco.editor.EndOfLinePreference.LF),
    setText: (text) => model.setValue(text),
    dispose: () => {
      subscription.dispose();
      models.delete(path);
      model.dispose();
    },
  };
}
