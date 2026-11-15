import { isCommandName } from "@runeforge/project-core";
import type { CompletionItem, DocumentSymbol, Range, SignatureHelp } from "@runeforge/runescript-language-server";

/**
 * Conversions entre les structures du service de langage (positions LSP : base 0) et celles de Monaco (base 1).
 * Fonctions pures, sans import de Monaco : testables sans navigateur.
 */

export interface MonacoRangeLike {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export function toMonacoRange(range: Range): MonacoRangeLike {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export interface MonacoDocumentSymbolLike {
  readonly name: string;
  readonly detail: string;
  /** `SymbolKind` de Monaco : celui de LSP moins 1 (LSP commence a 1, Monaco a 0). */
  readonly kind: number;
  readonly tags: readonly number[];
  readonly range: MonacoRangeLike;
  readonly selectionRange: MonacoRangeLike;
  readonly children: readonly MonacoDocumentSymbolLike[];
}

export function toMonacoSymbols(symbols: readonly DocumentSymbol[]): MonacoDocumentSymbolLike[] {
  return symbols.map((symbol) => ({
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: symbol.kind - 1,
    tags: [],
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange),
    children: toMonacoSymbols(symbol.children),
  }));
}

/**
 * `CompletionItemKind` de LSP vers celui de Monaco (Function=1, Field=3, Variable=4, Class=5, Event=10, Value=13, Constant=14,
 * Keyword=17, Text=18, Snippet=27) : objets, monstres et cartes sont des valeurs, les constantes du serveur des constantes.
 */
const MONACO_COMPLETION_KIND: Readonly<Record<number, number>> = { 3: 1, 5: 3, 6: 4, 7: 5, 12: 13, 14: 17, 15: 27, 21: 14, 23: 10 };

/** `CompletionItemInsertTextRule.InsertAsSnippet` de Monaco. */
const MONACO_INSERT_AS_SNIPPET = 4;

/** `CompletionItemTag.Deprecated` de Monaco. */
const MONACO_TAG_DEPRECATED = 1;

export interface MonacoSuggestionLike {
  readonly label: string;
  readonly kind: number;
  readonly detail: string;
  readonly insertText: string;
  readonly filterText: string;
  readonly sortText: string;
  readonly range: MonacoRangeLike;
  /** Propositions obsoletes (barrees dans la liste). */
  readonly tags?: readonly number[];
  /** Nom de la commande du registre : Monaco rend cet objet a `resolveCompletionItem`, qui y joint l'aide. */
  readonly commandName?: string;
  /** Modele de NPC : `insertText` est un snippet que Monaco fait remplir champ par champ. */
  readonly insertTextRules?: number;
}

/** `describeTemplate` : description localisee d'un modele de NPC d'apres son identifiant. */
export function toMonacoSuggestion(item: CompletionItem, describeTemplate?: (id: string) => string | undefined): MonacoSuggestionLike {
  const described = item.template === undefined ? undefined : describeTemplate?.(item.template);
  return {
    label: item.label,
    kind: MONACO_COMPLETION_KIND[item.kind] ?? 18,
    detail: described ?? item.detail ?? "",
    insertText: item.insertText ?? item.label,
    ...(item.format === "snippet" ? { insertTextRules: MONACO_INSERT_AS_SNIPPET } : {}),
    filterText: item.filterText ?? item.label,
    sortText: item.sortText,
    range: toMonacoRange(item.range),
    ...(item.command?.deprecated === true ? { tags: [MONACO_TAG_DEPRECATED] } : {}),
    ...(item.command === undefined ? {} : { commandName: item.label }),
  };
}

export interface MonacoSignatureHelpLike {
  readonly signatures: readonly {
    readonly label: string;
    readonly documentation: { readonly value: string };
    readonly parameters: readonly { readonly label: readonly [number, number] }[];
  }[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

/** Aide de signature du service vers Monaco ; `documentation` (Markdown) est jointe a chaque signature. */
export function toMonacoSignatureHelp(help: SignatureHelp, documentation: string): MonacoSignatureHelpLike {
  return {
    signatures: help.signatures.map((signature) => ({
      label: signature.label,
      documentation: { value: documentation },
      parameters: signature.parameters.map((parameter) => ({ label: [parameter.start, parameter.end] as const })),
    })),
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
  };
}

/** Marqueur Monaco, tel que l'action rapide le recoit (seul ce que la fonction lit). */
export interface FixableMarker {
  readonly code?: string | { readonly value: string };
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/**
 * Commandes inconnues (`RA0001`) que l'on peut declarer comme commandes du projet : le texte du marqueur doit etre un nom de
 * commande valide ; un meme nom (insensible a la casse) n'est propose qu'une fois.
 */
export function declarableCommandNames<M extends FixableMarker>(markers: readonly M[], textOf: (marker: M) => string): { name: string; marker: M }[] {
  const found: { name: string; marker: M }[] = [];
  const seen = new Set<string>();
  for (const marker of markers) {
    const code = typeof marker.code === "string" ? marker.code : marker.code?.value;
    if (code !== "RA0001") continue;
    const name = textOf(marker).trim();
    if (!isCommandName(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    found.push({ name, marker });
  }
  return found;
}

/** Position de depart (ligne et colonne, base 1) d'une plage ou d'une position Monaco ; `1:1` si absente. */
export function startOf(
  target:
    | { startLineNumber?: number; startColumn?: number; endLineNumber?: number; endColumn?: number; lineNumber?: number; column?: number }
    | undefined,
): { line: number; column: number } {
  if (target === undefined) return { line: 1, column: 1 };
  return { line: target.startLineNumber ?? target.lineNumber ?? 1, column: target.startColumn ?? target.column ?? 1 };
}
