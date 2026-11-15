import { isEventLabelName } from "@runeforge/runescript-analysis";
import type { LineIndex, SourceRange } from "@runeforge/runescript-core";
import { walk } from "@runeforge/runescript-parser";
import type { ScriptFile } from "@runeforge/runescript-parser";
import { toRange } from "./outline";
import { variableKey } from "./symbol-at";
import type { SymbolTarget } from "./symbol-at";
import type { Range } from "./types";

/**
 * Renommage sur : il ne s'applique qu'aux symboles dont **toutes** les occurrences sont connues avec certitude, a
 * l'interieur d'un seul script — les labels / fonctions locales et les variables locales (`.@x`, `.x`). Les fonctions
 * globales, les noms de NPC et les variables globales sont references par d'autres fichiers (parfois par chaine) : refus.
 */

export type RenameError =
  /** Rien a renommer ici, ou symbole dont les occurrences ne sont pas toutes connues (global, label non defini). */
  | "not-renameable"
  /** `On...` : le serveur l'exporte comme evenement, d'autres scripts peuvent l'appeler par son nom. */
  | "event-label"
  | "invalid-name"
  | "name-taken"
  /** Le script contient une region non analysee : une occurrence a pu echapper a l'analyse. */
  | "incomplete-script";

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

export type RenamePreparation =
  | { readonly ok: true; readonly range: Range; readonly placeholder: string }
  | { readonly ok: false; readonly reason: RenameError };

export type RenameResult =
  | { readonly ok: true; readonly edits: TextEdit[] }
  | { readonly ok: false; readonly reason: RenameError };

const NAME = /^[A-Za-z0-9_]+$/;
const NUMBER = /^(?:[0-9]+|0x[0-9a-f]+)$/i;
const RESERVED: ReadonlySet<string> = new Set([
  "if", "else", "while", "for", "do", "switch", "case", "default", "break", "continue", "return", "goto", "function",
]);

const fail = (reason: RenameError): { ok: false; reason: RenameError } => ({ ok: false, reason });

/** Prefixe d'une variable locale (`.@` ou `.`) et nom nu, sans le suffixe `$`. */
function splitLocalVariable(raw: string): { prefix: string; bare: string; suffix: string } {
  const prefix = raw.startsWith(".@") ? ".@" : ".";
  const suffix = raw.endsWith("$") ? "$" : "";
  return { prefix, bare: raw.slice(prefix.length, raw.length - suffix.length), suffix };
}

export function prepareRename(target: SymbolTarget | undefined, lines: LineIndex): RenamePreparation {
  if (target === undefined) return fail("not-renameable");
  switch (target.kind) {
    case "label": {
      const scope = target.declaration.scope;
      const definition = scope?.labels.find((label) => label.key === target.key);
      if (scope === null || scope === undefined || definition === undefined) return fail("not-renameable");
      if (definition.isEvent) return fail("event-label");
      if (!scope.complete) return fail("incomplete-script");
      return { ok: true, range: toRange(lines, target.range), placeholder: definition.name };
    }
    case "variable": {
      const scope = target.declaration?.scope;
      if (target.declaration === null || scope === null || scope === undefined) return fail("not-renameable");
      if (!scope.complete) return fail("incomplete-script");
      const { prefix, bare } = splitLocalVariable(target.name);
      const start = target.range.start + prefix.length;
      return { ok: true, range: toRange(lines, { start, end: start + bare.length }), placeholder: bare };
    }
    default:
      return fail("not-renameable");
  }
}

export function computeRename(target: SymbolTarget | undefined, newName: string, ast: ScriptFile, lines: LineIndex): RenameResult {
  const prepared = prepareRename(target, lines);
  if (!prepared.ok || target === undefined) return prepared.ok ? fail("not-renameable") : prepared;
  if (!NAME.test(newName) || RESERVED.has(newName.toLowerCase())) return fail("invalid-name");

  const ranges: SourceRange[] = [];
  if (target.kind === "label") {
    const scope = target.declaration.scope;
    if (scope === null) return fail("not-renameable");
    // Un nom `On...` deviendrait un evenement ; un nombre ne serait plus un identifiant.
    if (isEventLabelName(newName) || NUMBER.test(newName)) return fail("invalid-name");
    const newKey = newName.toLowerCase();
    const taken = scope.labels.some((label) => label.key === newKey) || scope.functionDeclarations.some((entry) => entry.key === newKey);
    if (newKey !== target.key && taken) return fail("name-taken");
    for (const label of scope.labels) if (label.key === target.key) ranges.push(label.nameRange);
    for (const declared of scope.functionDeclarations) if (declared.key === target.key) ranges.push(declared.nameRange);
    for (const reference of scope.labelReferences) if (reference.key === target.key) ranges.push(reference.range);
  } else if (target.kind === "variable") {
    const declaration = target.declaration;
    const scope = declaration?.scope;
    if (declaration === null || scope === null || scope === undefined) return fail("not-renameable");
    const { prefix, suffix } = splitLocalVariable(target.name);
    const newKey = prefix + newName.toLowerCase() + suffix;
    if (newKey !== target.key && scope.variables.some((variable) => variable.key === newKey)) return fail("name-taken");
    const root = ast.declarations[declaration.index];
    if (root === undefined) return fail("not-renameable");
    walk(root, (node) => {
      if (node.kind === "Variable" && variableKey(node) === target.key) ranges.push(node.nameRange);
    });
  } else {
    return fail("not-renameable");
  }

  const unique = new Map<number, SourceRange>();
  for (const range of ranges) unique.set(range.start, range);
  const edits = [...unique.values()]
    .sort((a, b) => a.start - b.start)
    .map((range): TextEdit => ({ range: toRange(lines, range), newText: newName }));
  return { ok: true, edits };
}
