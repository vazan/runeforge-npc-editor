import type { SourceRange, Token } from "@runeforge/runescript-core";
import type { HeaderField, MapLocation, NpcName, NumericValue } from "./ast";

/**
 * Decodage des en-tetes de declarations de premier niveau (CLAUDE.md 6.1, doc rAthena
 * "Script loading structure"). Les champs sont separes par des tabulations ; les noms
 * peuvent contenir des espaces. Toutes les valeurs gardent la plage exacte de leur texte
 * source afin de permettre des diagnostics et des remplacements cibles.
 */

/** Construit les champs d'en-tete a partir des tokens bruts `[from, to)` (separateur : tokens `Tabs`). */
export function buildFields(text: string, tokens: readonly Token[], from: number, to: number): HeaderField[] {
  const fields: HeaderField[] = [];
  let start = -1;
  let end = -1;

  const flush = (): void => {
    if (start !== -1) {
      fields.push({ text: text.slice(start, end), range: { start, end } });
    }
    start = -1;
    end = -1;
  };

  for (let i = from; i < to; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.kind === "Tabs") {
      flush();
    } else if (token.kind === "Newline" || token.kind === "LineComment") {
      break;
    } else if (token.kind === "Spaces" || token.kind === "BlockComment") {
      continue;
    } else {
      if (start === -1) start = token.range.start;
      end = token.range.end;
    }
  }
  flush();
  return fields;
}

/** Decoupe un champ sur un caractere separateur, en rognant chaque segment et en conservant les plages. */
export function splitField(field: HeaderField, separator: string): HeaderField[] {
  const segments: HeaderField[] = [];
  let segmentStart = 0;
  const pushSegment = (from: number, to: number): void => {
    let a = from;
    let b = to;
    while (a < b && isBlank(field.text.charCodeAt(a))) a += 1;
    while (b > a && isBlank(field.text.charCodeAt(b - 1))) b -= 1;
    segments.push({
      text: field.text.slice(a, b),
      range: { start: field.range.start + a, end: field.range.start + b },
    });
  };
  for (let i = 0; i < field.text.length; i += 1) {
    if (field.text[i] === separator) {
      pushSegment(segmentStart, i);
      segmentStart = i + 1;
    }
  }
  pushSegment(segmentStart, field.text.length);
  return segments;
}

function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

/** Entier decimal (signe accepte) ou hexadecimal `0x..`. */
export function parseNumeric(field: HeaderField): NumericValue {
  const text = field.text;
  let value: number | null = null;
  if (/^[+-]?\d+$/.test(text)) {
    value = Number.parseInt(text, 10);
  } else if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    value = Number.parseInt(text, 16);
  }
  return { value, text, range: field.range };
}

/**
 * Position `carte{,x{,y{,extra...}}}`. Une carte peut commencer par un chiffre ou contenir
 * `@` (cartes d'instance, ex. `1@orcs`).
 */
export function parseMapLocation(field: HeaderField): MapLocation {
  const segments = splitField(field, ",");
  const [mapSegment, xSegment, ySegment, ...rest] = segments;
  const map = mapSegment ?? { text: "", range: { start: field.range.start, end: field.range.start } };
  return {
    map: map.text,
    mapRange: map.range,
    x: xSegment === undefined ? null : parseNumeric(xSegment),
    y: ySegment === undefined ? null : parseNumeric(ySegment),
    extra: rest.map(parseNumeric),
    range: field.range,
  };
}

/** `<Nom affiche>{::<Nom unique>}` (doc rAthena "NPC names"). */
export function parseNpcName(field: HeaderField | undefined, fallbackAt: number): NpcName {
  if (field === undefined) {
    return { full: "", display: "", unique: "", range: { start: fallbackAt, end: fallbackAt } };
  }
  const separator = field.text.indexOf("::");
  const display = separator === -1 ? field.text : field.text.slice(0, separator);
  const unique = separator === -1 ? field.text : field.text.slice(separator + 2);
  return { full: field.text, display, unique, range: field.range };
}

export interface TypeKeyword {
  /** Mot-cle en minuscules, sans etat : `script(CLOAKED)` -> `script`. */
  readonly keyword: string;
  /** Contenu des parentheses : `script(CLOAKED)` -> `CLOAKED` (vide si absent). */
  readonly argument: string;
  readonly argumentRange: SourceRange | null;
}

/** Decompose `script`, `script(CLOAKED)`, `duplicate(label)`... */
export function parseTypeKeyword(field: HeaderField | undefined): TypeKeyword | null {
  if (field === undefined) return null;
  const open = field.text.indexOf("(");
  if (open === -1) {
    return { keyword: field.text.trim().toLowerCase(), argument: "", argumentRange: null };
  }
  const close = field.text.lastIndexOf(")");
  const argEnd = close > open ? close : field.text.length;
  return {
    keyword: field.text.slice(0, open).trim().toLowerCase(),
    argument: field.text.slice(open + 1, argEnd).trim(),
    argumentRange: { start: field.range.start + open + 1, end: field.range.start + argEnd },
  };
}

/** Mots-cles de type de declaration reconnus en 2e champ. */
export const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  "script",
  "warp",
  "warp2",
  "shop",
  "cashshop",
  "itemshop",
  "pointshop",
  "marketshop",
  "monster",
  "boss_monster",
  "mapflag",
  "duplicate",
]);

export const SHOP_KEYWORDS: ReadonlySet<string> = new Set([
  "shop",
  "cashshop",
  "itemshop",
  "pointshop",
  "marketshop",
]);
