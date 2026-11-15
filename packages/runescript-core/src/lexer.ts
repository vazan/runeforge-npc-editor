import type { Token, TokenKind } from "./token";

/**
 * Lexer RuneScript (prototype, T-005 demarre).
 *
 * Proprietes garanties (testees dans lexer.test.ts) :
 * - total : toute chaine produit une suite de tokens, sans exception ;
 * - sans perte : les tokens sont contigus, non vides, et leur concatenation
 *   redonne exactement le texte source (espaces, tabulations, fins de ligne,
 *   commentaires et caracteres inconnus compris) ;
 * - deterministe et pur : aucune execution, aucun acces externe.
 *
 * Le lexer ne decide PAS du sens : l'en-tete d'un NPC (separe par tabulations,
 * avec des noms contenant espaces ou `#`) est reconstitue par le parser de
 * premier niveau a partir de ces tokens.
 */

const TAB = 9;
const LF = 10;
const VT = 11;
const FF = 12;
const CR = 13;
const SPACE = 32;
const QUOTE = 34;
const HASH = 35;
const DOLLAR = 36;
const APOSTROPHE = 39;
const STAR = 42;
const DOT = 46;
const SLASH = 47;
const ZERO = 48;
const AT = 64;
const BACKSLASH = 92;

const THREE_CHAR_OPERATORS: readonly string[] = ["<<=", ">>="];
const TWO_CHAR_OPERATORS: readonly string[] = [
  "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "~=",
];
const ONE_CHAR_OPERATORS = "+-*/%=<>!&|^~?";
const PUNCTUATION = "{}()[];,:";

interface Scan {
  readonly kind: TokenKind;
  readonly end: number;
  readonly unterminated?: true;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/**
 * Caractere d'un "mot" : lettre ASCII, chiffre ou `_`. Comme dans le serveur (`skip_word`),
 * un mot peut commencer par un chiffre (`4_DR_KID_01`) : seul un mot entierement numerique est un nombre.
 */
function isIdentPart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || isDigit(code);
}

function isSpace(code: number): boolean {
  return code === SPACE || code === VT || code === FF;
}

function isTab(code: number): boolean {
  return code === TAB;
}

function isNotLineBreak(code: number): boolean {
  return code !== LF && code !== CR;
}

/** Premier index >= `from` dont le code ne satisfait pas `predicate` (ou la fin du texte). */
function scanWhile(text: string, from: number, predicate: (code: number) => boolean): number {
  let pos = from;
  while (pos < text.length && predicate(text.charCodeAt(pos))) {
    pos += 1;
  }
  return pos;
}

function scanBlockComment(text: string, start: number): Scan {
  const close = text.indexOf("*/", start + 2);
  if (close === -1) {
    return { kind: "BlockComment", end: text.length, unterminated: true };
  }
  return { kind: "BlockComment", end: close + 2 };
}

/**
 * Chaine entre guillemets doubles. Un antislash consomme le caractere suivant
 * (sauf fin de ligne). Une chaine non fermee s'arrete AVANT la fin de ligne
 * pour qu'une erreur ne "mange" pas le reste du fichier : choix de recuperation
 * prudent, qui n'affirme rien sur le comportement du serveur.
 */
function scanString(text: string, start: number): Scan {
  const length = text.length;
  let pos = start + 1;
  while (pos < length) {
    const code = text.charCodeAt(pos);
    if (code === QUOTE) {
      return { kind: "String", end: pos + 1 };
    }
    if (code === LF || code === CR) {
      break;
    }
    if (code === BACKSLASH && pos + 1 < length) {
      const escaped = text.charCodeAt(pos + 1);
      if (escaped !== LF && escaped !== CR) {
        pos += 2;
        continue;
      }
    }
    pos += 1;
  }
  return { kind: "String", end: pos, unterminated: true };
}

/** Mot entierement numerique (decimal) ou hexadecimal `0x..` : un nombre. Sinon : un identifiant. */
function isNumberWord(text: string, start: number, end: number): boolean {
  const next = text.charCodeAt(start + 1);
  if (text.charCodeAt(start) === ZERO && (next === 120 || next === 88) && end - start > 2) {
    for (let i = start + 2; i < end; i += 1) {
      if (!isHexDigit(text.charCodeAt(i))) return false;
    }
    return true;
  }
  for (let i = start; i < end; i += 1) {
    if (!isDigit(text.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * Mot (lettres, chiffres, `_`) : nombre, identifiant, ou variable chaine sans prefixe
 * (`name$`, variable permanente de personnage de type chaine).
 */
function scanWord(text: string, start: number): Scan {
  const end = scanWhile(text, start + 1, isIdentPart);
  if (isNumberWord(text, start, end)) return { kind: "Number", end };
  if (text.charCodeAt(end) === DOLLAR) return { kind: "Variable", end: end + 1 };
  return { kind: "Identifier", end };
}

/**
 * Variable : prefixe (`.@` `.` `@` `$@` `$` `##` `#` `'`) + nom (lettres, chiffres, `_`,
 * pouvant commencer par un chiffre comme `$2011_agit_invest`) + suffixe `$` facultatif.
 * Retourne l'index de fin, ou -1 si ce n'est pas une variable.
 */
function scanVariable(text: string, start: number): number {
  const code = text.charCodeAt(start);
  const next = text.charCodeAt(start + 1);
  let nameStart: number;
  switch (code) {
    case DOT:
    case DOLLAR:
      nameStart = next === AT ? start + 2 : start + 1;
      break;
    case HASH:
      nameStart = next === HASH ? start + 2 : start + 1;
      break;
    case AT:
    case APOSTROPHE:
      nameStart = start + 1;
      break;
    default:
      return -1;
  }
  if (!isIdentPart(text.charCodeAt(nameStart))) {
    return -1;
  }
  let end = scanWhile(text, nameStart + 1, isIdentPart);
  if (text.charCodeAt(end) === DOLLAR) {
    end += 1;
  }
  return end;
}

function scanOperator(text: string, start: number): number {
  for (const operator of THREE_CHAR_OPERATORS) {
    if (text.startsWith(operator, start)) return start + 3;
  }
  for (const operator of TWO_CHAR_OPERATORS) {
    if (text.startsWith(operator, start)) return start + 2;
  }
  if (ONE_CHAR_OPERATORS.includes(text.charAt(start))) return start + 1;
  return -1;
}

/** Un caractere inconnu consomme un code point entier (jamais une paire de substitution coupee). */
function scanUnknown(text: string, start: number): number {
  const code = text.charCodeAt(start);
  const next = text.charCodeAt(start + 1);
  const startsPair = code >= 0xd800 && code <= 0xdbff;
  const endsPair = next >= 0xdc00 && next <= 0xdfff;
  return startsPair && endsPair ? start + 2 : start + 1;
}

function scanToken(text: string, start: number): Scan {
  const code = text.charCodeAt(start);
  const next = text.charCodeAt(start + 1);

  if (code === LF || code === CR) {
    return { kind: "Newline", end: code === CR && next === LF ? start + 2 : start + 1 };
  }
  if (code === TAB) {
    return { kind: "Tabs", end: scanWhile(text, start + 1, isTab) };
  }
  if (isSpace(code)) {
    return { kind: "Spaces", end: scanWhile(text, start + 1, isSpace) };
  }
  if (code === SLASH && next === SLASH) {
    return { kind: "LineComment", end: scanWhile(text, start + 2, isNotLineBreak) };
  }
  if (code === SLASH && next === STAR) {
    return scanBlockComment(text, start);
  }
  if (code === QUOTE) {
    return scanString(text, start);
  }
  if (isIdentPart(code)) {
    return scanWord(text, start);
  }
  const variableEnd = scanVariable(text, start);
  if (variableEnd !== -1) {
    return { kind: "Variable", end: variableEnd };
  }
  const operatorEnd = scanOperator(text, start);
  if (operatorEnd !== -1) {
    return { kind: "Operator", end: operatorEnd };
  }
  if (PUNCTUATION.includes(text.charAt(start))) {
    return { kind: "Punctuation", end: start + 1 };
  }
  return { kind: "Unknown", end: scanUnknown(text, start) };
}

/**
 * Decoupe `text` en tokens. Voir l'en-tete du module pour les garanties.
 * Les offsets sont des code units UTF-16 (voir `SourceRange`).
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < text.length) {
    const scan = scanToken(text, pos);
    const range = { start: pos, end: scan.end };
    const tokenText = text.slice(pos, scan.end);
    tokens.push(
      scan.unterminated
        ? { kind: scan.kind, range, text: tokenText, unterminated: true }
        : { kind: scan.kind, range, text: tokenText },
    );
    pos = scan.end;
  }
  return tokens;
}
