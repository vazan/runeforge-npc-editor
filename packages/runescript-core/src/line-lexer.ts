import { tokenize } from "./lexer";
import type { Token } from "./token";

/**
 * Etat a conserver d'une ligne a la suivante : seuls les commentaires bloc peuvent s'etendre sur plusieurs
 * lignes (une chaine non fermee s'arrete a la fin de ligne, voir `lexer.ts`).
 */
export interface LineLexState {
  readonly inBlockComment: boolean;
}

export const INITIAL_LINE_STATE: LineLexState = { inBlockComment: false };

export interface LineTokens {
  /** Tokens de la ligne, offsets relatifs au debut de la ligne. */
  readonly tokens: Token[];
  readonly endState: LineLexState;
}

function shift(token: Token, offset: number): Token {
  if (offset === 0) return token;
  const range = { start: token.range.start + offset, end: token.range.end + offset };
  return token.unterminated === true
    ? { kind: token.kind, range, text: token.text, unterminated: true }
    : { kind: token.kind, range, text: token.text };
}

/**
 * Decoupe une ligne (sans fin de ligne) en reprenant l'etat de la ligne precedente. Concatener les tokens de toutes
 * les lignes redonne le texte ; les tokens sont identiques a ceux de `tokenize` hors decoupage d'un commentaire
 * bloc multi-lignes en un token par ligne. Concu pour les moteurs de coloration incrementaux (Monaco).
 */
export function tokenizeLine(line: string, state: LineLexState): LineTokens {
  const tokens: Token[] = [];
  let offset = 0;
  if (state.inBlockComment) {
    const close = line.indexOf("*/");
    if (close === -1) {
      if (line.length > 0) tokens.push({ kind: "BlockComment", range: { start: 0, end: line.length }, text: line, unterminated: true });
      return { tokens, endState: state };
    }
    offset = close + 2;
    tokens.push({ kind: "BlockComment", range: { start: 0, end: offset }, text: line.slice(0, offset) });
  }
  let stillInComment = false;
  for (const token of tokenize(line.slice(offset))) {
    tokens.push(shift(token, offset));
    stillInComment = token.kind === "BlockComment" && token.unterminated === true;
  }
  return { tokens, endState: { inBlockComment: stillInComment } };
}
