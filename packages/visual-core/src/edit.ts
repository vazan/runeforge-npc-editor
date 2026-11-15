import { isTrivia, tokenize, type SourceRange } from "@runeforge/runescript-core";
import { parse, type ParseResult } from "@runeforge/runescript-parser";
import { locateNpc } from "./import";
import type { IfBlock, VisualBlock, VisualNpc } from "./ir";
import { findBlock, hasControlCharacter, walkBlocks } from "./ir";

/** Un remplacement de la plage `[start, end)` du texte par `text`. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type NewBlock =
  | { readonly kind: "mes"; readonly text: string }
  | { readonly kind: "next" }
  | { readonly kind: "close" }
  | { readonly kind: "if"; readonly condition: string };

type BlockTarget = { readonly kind: "body" } | { readonly kind: "branch"; readonly id: string; readonly branch: "then" | "else" };

export type VisualAction =
  | { readonly type: "setMesText"; readonly id: string; readonly text: string }
  | { readonly type: "setCondition"; readonly id: string; readonly text: string }
  | { readonly type: "insertAfter"; readonly id: string; readonly block: NewBlock }
  | { readonly type: "insertBefore"; readonly id: string; readonly block: NewBlock }
  | { readonly type: "append"; readonly target: BlockTarget; readonly block: NewBlock }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "move"; readonly id: string; readonly direction: "up" | "down" };

export type EditFailure =
  | "unknown-block"
  /** Le bloc est brut, ou la modification ferait perdre du code brut ou un commentaire. */
  | "locked"
  | "bad-text"
  /** Le bloc partage sa ligne avec autre chose : l'inserer, le supprimer ou le deplacer toucherait ce voisin. */
  | "not-alone-on-line"
  | "no-neighbour"
  | "invalid-condition"
  /** La modification n'a pas la forme syntaxique attendue ou ajoute une erreur au document. */
  | "new-syntax-error"
  /** Le NPC ne se retrouve plus dans le texte. */
  | "unknown-npc";

export type PlanResult = { readonly ok: true; readonly edits: readonly TextEdit[] } | { readonly ok: false; readonly reason: EditFailure };

type Failure = { readonly ok: false; readonly reason: EditFailure };
const fail = (reason: EditFailure): Failure => ({ ok: false, reason });
const done = (edits: readonly TextEdit[]): PlanResult => ({ ok: true, edits });

/** Une chaine de script : `"` et `\` proteges, rien d'autre n'est modifie. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Le texte d'un bloc neuf. */
export function generateBlock(block: NewBlock): string {
  switch (block.kind) {
    case "mes":
      return `mes ${quote(block.text)};`;
    case "next":
      return "next;";
    case "close":
      return "close;";
    case "if":
      return `if (${block.condition.trim()}) {\n}`;
  }
}

const lineStartOf = (text: string, offset: number): number => text.lastIndexOf("\n", offset - 1) + 1;
const lineEndOf = (text: string, offset: number): number => {
  const index = text.indexOf("\n", offset);
  return index === -1 ? text.length : index;
};

/** Le bloc occupe ses lignes seul : rien devant, et derriere seulement des blancs ou un commentaire de fin de ligne. */
function aloneOnLines(text: string, block: VisualBlock): boolean {
  const before = text.slice(lineStartOf(text, block.range.start), block.range.start);
  const after = text.slice(block.range.end, lineEndOf(text, block.range.end));
  return /^[ \t]*$/.test(before) && /^[ \t]*(\/\/.*)?\r?$/.test(after);
}

const indentOf = (text: string, block: VisualBlock): string => text.slice(lineStartOf(text, block.range.start), block.range.start);

const leadingIndent = (text: string, offset: number): string => /^[ \t]*/.exec(text.slice(lineStartOf(text, offset)))?.[0] ?? "";

function lineEndingAt(text: string, offset: number): { start: number; value: string } {
  const end = lineEndOf(text, offset);
  // Un bloc compact en fin de fichier reprend la dernière fin de ligne existante, si elle existe.
  const newline = end < text.length ? end : text.lastIndexOf("\n", end - 1);
  const crlf = newline >= 1 && text[newline - 1] === "\r";
  return { start: end < text.length && crlf ? end - 1 : end, value: crlf ? "\r\n" : "\n" };
}

const indentedBlock = (block: NewBlock, indent: string, eol: string): string =>
  indent + generateBlock(block).split("\n").join(eol + indent);

const childIndent = (parent: string): string => parent + (parent === "" || parent.includes("\t") ? "\t" : "    ");

const hasComment = (text: string): boolean =>
  tokenize(text).some((token) => token.kind === "LineComment" || token.kind === "BlockComment");

/** Valide la condition seule pour que la recuperation d'erreurs du fichier ne puisse pas masquer une expression invalide. */
function isSingleCondition(condition: string): boolean {
  const prefix = "-\tscript\tCondition\t-1,{\nif (";
  const source = `${prefix}${condition}) {}\n}\n`;
  const parsed = parse(source);
  if (parsed.truncated || errorCount(parsed) > 0) return false;
  const block = locateNpc(parsed, source, 0)?.blocks[0];
  return block?.kind === "if" && block.conditionRange.start === prefix.length && block.conditionRange.end === prefix.length + condition.length;
}

function conditionFailure(condition: string): EditFailure | null {
  if (condition === "" || hasControlCharacter(condition)) return "invalid-condition";
  return isSingleCondition(condition) ? null : "new-syntax-error";
}

function newBlockFailure(block: NewBlock): EditFailure | null {
  if (block.kind === "if") return conditionFailure(block.condition.trim());
  return block.kind === "mes" && hasControlCharacter(block.text) ? "bad-text" : null;
}

/** Ajoute une instruction juste avant l'accolade fermante d'un corps ou d'une branche. */
function appendIn(text: string, range: SourceRange, blocks: readonly VisualBlock[], block: NewBlock): PlanResult {
  const close = range.end - 1;
  const closeLine = lineStartOf(text, close);
  const prefix = text.slice(closeLine, close);
  const ownLine = closeLine > range.start && /^[ \t]*$/.test(prefix);
  const closingIndent = ownLine ? prefix : leadingIndent(text, range.start);
  const last = blocks.at(-1);
  const previousIndent = last === undefined ? "" : indentOf(text, last);
  const indent = /^[ \t]+$/.test(previousIndent) && previousIndent.startsWith(closingIndent) && previousIndent.length > closingIndent.length
    ? previousIndent : childIndent(closingIndent);
  const eol = lineEndingAt(text, close).value;
  const source = indentedBlock(block, indent, eol);
  return ownLine
    ? done([{ start: closeLine, end: closeLine, text: source + eol }])
    : done([{ start: close, end: close, text: eol + source + eol + closingIndent }]);
}

function appendElse(text: string, branch: IfBlock, block: NewBlock): PlanResult {
  const line = lineEndingAt(text, branch.range.end);
  const after = text.slice(branch.range.end, line.start).trimStart();
  // Un commentaire de fin de ligne reste attaché à l'accolade du « alors ».
  const commented = after.startsWith("//");
  if (after.startsWith("/*")) return fail("not-alone-on-line");
  const at = commented ? line.start : branch.range.end;
  const indent = leadingIndent(text, branch.range.start);
  const prefix = commented ? line.value + indent : " ";
  const source = indentedBlock(block, childIndent(indent), line.value);
  return done([{ start: at, end: at, text: `${prefix}else {${line.value}${source}${line.value}${indent}}` }]);
}

const hasRaw = (block: VisualBlock): boolean => {
  let raw = block.kind === "raw";
  if (block.kind === "if") walkBlocks([...block.then, ...(block.else ?? [])], (inner) => (raw = raw || inner.kind === "raw"));
  return raw;
};

/**
 * Les modifications de texte qui realisent `action`, sans rien appliquer. Chaque modification ne touche que la plage du bloc concerne (ou
 * l'insertion d'une ligne a cote) : le reste du fichier — commentaires, espacement, blocs bruts — n'est jamais reecrit.
 */
export function planEdit(npc: VisualNpc, text: string, action: VisualAction): PlanResult {
  if (action.type === "insertAfter" || action.type === "insertBefore" || action.type === "append") {
    const reason = newBlockFailure(action.block);
    if (reason !== null) return fail(reason);
  }
  if (action.type === "append") {
    const { target, block } = action;
    if (target.kind === "body") return appendIn(text, npc.bodyRange, npc.blocks, block);
    const branch = findBlock(npc.blocks, target.id)?.block;
    if (branch === undefined) return fail("unknown-block");
    if (branch.kind !== "if") return fail("locked");
    if (target.branch === "then") return appendIn(text, branch.thenRange, branch.then, block);
    return branch.elseRange === null ? appendElse(text, branch, block) : appendIn(text, branch.elseRange, branch.else ?? [], block);
  }
  const found = findBlock(npc.blocks, action.id);
  if (found === null) return fail("unknown-block");
  const { block, list, index } = found;

  switch (action.type) {
    case "setMesText": {
      if (block.kind !== "mes") return fail("locked");
      if (hasControlCharacter(action.text)) return fail("bad-text");
      if (action.text === block.text) return done([]);
      return done([{ start: block.textRange.start, end: block.textRange.end, text: quote(action.text) }]);
    }
    case "setCondition": {
      if (block.kind !== "if") return fail("locked");
      const condition = action.text.trim();
      if (condition === block.condition) return done([]);
      if (hasComment(block.condition)) return fail("locked");
      const reason = conditionFailure(condition);
      if (reason !== null) return fail(reason);
      const { start, end } = block.conditionRange;
      // Pour `if (a) && (b)`, la plage couvre toute l'expression, parentheses comprises.
      const before = tokenize(text.slice(block.range.start, start)).filter((token) => !isTrivia(token.kind));
      const replacement = before.at(-1)?.text === "(" ? condition : `(${condition})`;
      return done([{ start, end, text: replacement }]);
    }
    case "insertAfter": {
      if (!aloneOnLines(text, block)) return fail("not-alone-on-line");
      const line = lineEndingAt(text, block.range.end);
      return done([{ start: line.start, end: line.start, text: line.value + indentedBlock(action.block, indentOf(text, block), line.value) }]);
    }
    case "insertBefore": {
      if (!aloneOnLines(text, block)) return fail("not-alone-on-line");
      const at = lineStartOf(text, block.range.start);
      const eol = lineEndingAt(text, at).value;
      return done([{ start: at, end: at, text: indentedBlock(action.block, indentOf(text, block), eol) + eol }]);
    }
    case "remove": {
      if (hasRaw(block) || hasComment(text.slice(block.range.start, block.range.end))) return fail("locked");
      if (!aloneOnLines(text, block)) return fail("not-alone-on-line");
      const start = lineStartOf(text, block.range.start);
      const lineEnd = lineEndOf(text, block.range.end);
      if (text.slice(block.range.end, lineEnd).trimStart().startsWith("//")) {
        return done([{ start: block.range.start, end: block.range.end, text: "" }]);
      }
      // Derniere ligne sans saut final : c'est le saut qui la precede qui part.
      if (lineEnd === text.length && start > 0) return done([{ start: start - 1, end: lineEnd, text: "" }]);
      return done([{ start, end: Math.min(lineEnd + 1, text.length), text: "" }]);
    }
    case "move": {
      const neighbourIndex = action.direction === "up" ? index - 1 : index + 1;
      const neighbour = list[neighbourIndex];
      if (neighbour === undefined) return fail("no-neighbour");
      if (hasRaw(block) || hasRaw(neighbour)) return fail("locked");
      if (!aloneOnLines(text, block) || !aloneOnLines(text, neighbour)) return fail("not-alone-on-line");
      const [upper, lower] = action.direction === "up" ? [neighbour, block] : [block, neighbour];
      const upperStart = lineStartOf(text, upper.range.start);
      const upperEnd = lineEndOf(text, upper.range.end);
      const lowerStart = lineStartOf(text, lower.range.start);
      const lowerEnd = lineEndOf(text, lower.range.end);
      const swapped = text.slice(lowerStart, lowerEnd) + text.slice(upperEnd, lowerStart) + text.slice(upperStart, upperEnd);
      return done([{ start: upperStart, end: lowerEnd, text: swapped }]);
    }
  }
}

/** Applique des modifications sans chevauchement a `text` ; `null` si elles se chevauchent ou sortent du texte. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string | null {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  let limit = text.length + 1;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > limit || edit.end > text.length) return null;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    limit = edit.start;
  }
  return result;
}

/** L'unique remplacement qui fait passer de `before` a `after` (les prefixe et suffixe communs sont laisses tels quels) ; `null` si identiques. */
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}

const errorCount = (result: ParseResult): number => result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;

const rawTexts = (npc: VisualNpc): string[] => {
  const texts: string[] = [];
  walkBlocks(npc.blocks, (block) => {
    if (block.kind === "raw") texts.push(block.text);
  });
  return texts;
};

export type ApplyResult =
  | { readonly ok: true; readonly text: string; readonly edits: readonly TextEdit[]; readonly npc: VisualNpc }
  | { readonly ok: false; readonly reason: EditFailure };

/**
 * Applique une action a l'unique NPC qui commence a `declarationStart` : planifie, applique, relit le resultat et le refuse s'il a plus
 * d'erreurs de syntaxe qu'avant ou si un bloc brut a change. Le texte rendu est celui qu'un enregistrement ecrirait.
 */
export function applyAction(text: string, declarationStart: number, action: VisualAction): ApplyResult {
  const before = parse(text);
  const npc = locateNpc(before, text, declarationStart);
  if (npc === null) return fail("unknown-npc");
  const plan = planEdit(npc, text, action);
  if (!plan.ok) return plan;
  const next = applyEdits(text, plan.edits);
  if (next === null) return fail("bad-text");
  const after = parse(next);
  const afterNpc = locateNpc(after, next, declarationStart);
  if (afterNpc === null) return fail("new-syntax-error");
  if (errorCount(after) > errorCount(before)) return fail("new-syntax-error");
  // Un bloc brut est du texte que l'edition ne comprend pas : il doit etre intact, au caractere pres.
  const rawBefore = rawTexts(npc);
  const rawAfter = rawTexts(afterNpc);
  if (rawBefore.length !== rawAfter.length || rawBefore.some((value, position) => value !== rawAfter[position])) return fail("new-syntax-error");
  return { ok: true, text: next, edits: plan.edits, npc: afterNpc };
}

