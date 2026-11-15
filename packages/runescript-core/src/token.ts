import type { SourceRange } from "./types";

/**
 * Categories lexicales.
 *
 * Les cinq premieres sont des "trivia" : elles ne portent pas de sens pour le
 * parser mais sont conservees pour que la concatenation des tokens redonne
 * exactement le texte source.
 */
export type TokenKind =
  | "Spaces"
  | "Tabs"
  | "Newline"
  | "LineComment"
  | "BlockComment"
  | "String"
  | "Number"
  | "Identifier"
  | "Variable"
  | "Operator"
  | "Punctuation"
  | "Unknown";

export interface Token {
  readonly kind: TokenKind;
  /** Plage UTF-16 dans le texte source (voir `SourceRange`). */
  readonly range: SourceRange;
  /** Texte exact du token : `source.slice(range.start, range.end)`. */
  readonly text: string;
  /** Present (a `true`) pour une chaine ou un commentaire bloc non ferme. */
  readonly unterminated?: true;
}

const TRIVIA_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "Spaces",
  "Tabs",
  "Newline",
  "LineComment",
  "BlockComment",
]);

export function isTrivia(kind: TokenKind): boolean {
  return TRIVIA_KINDS.has(kind);
}
