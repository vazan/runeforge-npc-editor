/**
 * Mise en forme des signatures de commandes pour l'aide a la saisie (aide de signature, survol, completion).
 *
 * Deux sources, de la plus a la moins lisible :
 * - le **manuel** du serveur, dont chaque titre est une signature ecrite pour les humains
 *   (`mes "<string>"{,"<string>"{,...}};`) : on y repere la plage de chaque parametre pour le mettre en evidence ;
 * - la **notation compacte** de la table du serveur (`"sii?"`), dont on tire une signature generique.
 * Ces fonctions ne servent qu'a l'affichage : le nombre d'arguments verifie vient toujours de la table (DEC-025).
 */
import { parseParameterTypes } from "./commands";

/** Plage (offsets UTF-16 dans `SignatureView.label`) d'un parametre. */
export interface ParameterRange {
  readonly start: number;
  readonly end: number;
  /** Parametre entre accolades dans le manuel, ou facultatif (`?`) dans la table. */
  readonly optional: boolean;
}

export interface SignatureView {
  /** Texte affiche, sans le `;` final. */
  readonly label: string;
  readonly parameters: readonly ParameterRange[];
  /** Un nombre libre d'arguments supplementaires est possible (`...` du manuel, `*` de la table). */
  readonly variadic: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Decoupe une signature du manuel en parametres. Les parametres sont les elements separes par des virgules ou des
 * accolades, en dehors des `<...>` ; ceux d'accolades sont facultatifs ; un `...` signale un nombre libre d'arguments ;
 * `[<indice>]` n'est pas un parametre mais l'indice du precedent.
 */
export function parseSignatureText(text: string): SignatureView {
  const label = text.trim().replace(/\s*;$/, "");
  const name = NAME.exec(label)?.[0] ?? "";
  let from = name.length;
  let to = label.length;
  // Forme parenthesee : `nom(<arg>,<arg>)` ou `nom (<arg>)` ; sinon les arguments suivent le nom.
  const afterName = label.slice(from);
  const open = /^\s*\(/.exec(afterName);
  if (open !== null) {
    from += open[0].length;
    if (label.endsWith(")")) to -= 1;
  }

  const parameters: ParameterRange[] = [];
  let variadic = false;
  let braces = 0;
  let angle = 0;
  let itemStart = -1;
  let itemEnd = -1;
  let itemOptional = false;

  const flush = (): void => {
    if (itemStart === -1) return;
    const start = itemStart;
    const end = itemEnd;
    const optional = itemOptional;
    itemStart = -1;
    const item = label.slice(start, end);
    if (item.startsWith("[")) return;
    if (item.startsWith("...")) {
      variadic = true;
      return;
    }
    if (item.includes("...")) variadic = true;
    parameters.push({ start, end, optional });
  };

  for (let index = from; index < to; index += 1) {
    const char = label.charAt(index);
    if (angle > 0) {
      if (char === ">") angle -= 1;
      else if (char === "<") angle += 1;
      itemEnd = index + 1;
      continue;
    }
    if (char === "{") {
      flush();
      braces += 1;
    } else if (char === "}") {
      flush();
      braces = Math.max(0, braces - 1);
    } else if (char === ",") {
      flush();
    } else if (char === " " || char === "\t") {
      // Les espaces ne commencent ni ne terminent un element.
    } else {
      if (itemStart === -1) {
        itemStart = index;
        itemOptional = braces > 0;
      }
      if (char === "<") angle += 1;
      itemEnd = index + 1;
    }
  }
  flush();
  return { label, parameters, variadic };
}

const TYPE_NAMES: Readonly<Record<string, string>> = { v: "value", s: "string", i: "int", r: "reference", l: "label" };

/** Signature generique tiree de la notation de la table (`warp` + `"sii?"` -> `warp(string, int, int, [optional])`). */
export function signatureFromTypes(name: string, types: string): SignatureView {
  const arity = parseParameterTypes(types);
  const required = arity === null ? 0 : arity.min;
  const optional = arity === null || arity.max === null ? 0 : arity.max - arity.min;
  const variadic = arity !== null && arity.max === null;
  const parts: { text: string; optional: boolean }[] = [];
  for (let i = 0; i < required; i += 1) parts.push({ text: TYPE_NAMES[types.charAt(i)] ?? "value", optional: false });
  for (let i = 0; i < optional; i += 1) parts.push({ text: "[optional]", optional: true });
  if (variadic) parts.push({ text: "...", optional: true });

  let label = `${name}(`;
  const parameters: ParameterRange[] = [];
  parts.forEach((part, index) => {
    if (index > 0) label += ", ";
    // `...` n'est pas un parametre : il indique la repetition du dernier.
    if (part.text !== "...") parameters.push({ start: label.length, end: label.length + part.text.length, optional: part.optional });
    label += part.text;
  });
  return { label: `${label})`, parameters, variadic };
}

export interface DocumentationExcerpt {
  readonly text: string;
  /** Vrai si le texte d'origine est plus long que l'extrait. */
  readonly truncated: boolean;
}

/**
 * Debut de l'aide d'une commande, coupe a une fin de ligne : au plus `maxLines` lignes et `maxChars` caracteres.
 * Les tabulations sont ramenees a deux espaces (les exemples du manuel sont indentes par tabulations).
 */
export function excerptDocumentation(text: string, maxChars: number, maxLines: number): DocumentationExcerpt {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || used + line.length > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  // Ne jamais finir sur des lignes vides.
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return { text: kept.join("\n"), truncated: kept.length < lines.length };
}
