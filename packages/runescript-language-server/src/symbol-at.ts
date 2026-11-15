import type { SourceRange } from "@runeforge/runescript-core";
import type { DeclarationSymbol, FileAnalysis, WorkspaceIndex } from "@runeforge/runescript-analysis";
import { findNodeAt } from "@runeforge/runescript-parser";
import type { ScriptFile, VariableExpression } from "@runeforge/runescript-parser";

/** Ce que designe le curseur, tel que le service de langage sait le resoudre. `range` = le texte sous le curseur. */
export type SymbolTarget =
  | {
      /** Label ou fonction locale (meme espace de noms), propre au script qui contient le curseur. */
      readonly kind: "label";
      readonly key: string;
      readonly name: string;
      readonly declaration: DeclarationSymbol;
      readonly range: SourceRange;
    }
  | { readonly kind: "function"; readonly name: string; readonly range: SourceRange }
  | { readonly kind: "npc"; readonly name: string; readonly range: SourceRange }
  | {
      readonly kind: "variable";
      readonly key: string;
      readonly name: string;
      /** Declaration qui porte la variable (`.@x`, `.x`) ; `null` pour une variable globale (portee : le fichier). */
      readonly declaration: DeclarationSymbol | null;
      readonly range: SourceRange;
    };

export function contains(range: SourceRange, offset: number): boolean {
  return offset >= range.start && offset <= range.end;
}

/** Cle d'une variable : meme formule que `runescript-analysis` (prefixe + nom en minuscules + `$`). */
export function variableKey(node: VariableExpression): string {
  return node.prefix + node.name.toLowerCase() + (node.isString ? "$" : "");
}

/** Plage de l'identifiant d'une variable (prefixe et suffixe compris, sans l'indice). */
export function variableRange(node: VariableExpression): SourceRange {
  return { start: node.range.start, end: node.range.start + node.raw.length };
}

function isLocalPrefix(prefix: string): boolean {
  return prefix === ".@" || prefix === ".";
}

/**
 * Resout le symbole sous le curseur d'un document ouvert. Ordre : en-tete de la declaration, labels et references de
 * labels du script, `callfunc "..."`, puis variables et appels par nom nu (via l'AST).
 */
export function resolveTarget(
  analysis: FileAnalysis,
  ast: ScriptFile,
  offset: number,
  index: WorkspaceIndex,
): SymbolTarget | undefined {
  const declaration = analysis.declarations.find((candidate) => contains(candidate.range, offset));
  if (declaration === undefined) return undefined;

  if (declaration.kind === "function") {
    if (contains(declaration.nameRange, offset)) return { kind: "function", name: declaration.name, range: declaration.nameRange };
  } else {
    if (declaration.duplicateOf !== null && contains(declaration.duplicateOf.range, offset)) {
      return { kind: "npc", name: declaration.duplicateOf.name, range: declaration.duplicateOf.range };
    }
    if (contains(declaration.nameRange, offset)) return { kind: "npc", name: declaration.uniqueName, range: declaration.nameRange };
  }

  const scope = declaration.scope;
  if (scope === null || !contains(scope.bodyRange, offset)) return undefined;

  for (const label of scope.labels) {
    if (contains(label.nameRange, offset)) return { kind: "label", key: label.key, name: label.name, declaration, range: label.nameRange };
  }
  for (const reference of scope.labelReferences) {
    if (contains(reference.range, offset)) return { kind: "label", key: reference.key, name: reference.name, declaration, range: reference.range };
  }
  for (const declared of scope.functionDeclarations) {
    if (contains(declared.nameRange, offset)) return { kind: "label", key: declared.key, name: declared.name, declaration, range: declared.nameRange };
  }
  for (const reference of analysis.functionReferences) {
    if (contains(reference.range, offset)) return { kind: "function", name: reference.name, range: reference.range };
  }

  const node = findNodeAt(ast, offset);
  switch (node.kind) {
    case "Variable": {
      const range = variableRange(node);
      if (!contains(range, offset)) return undefined;
      return {
        kind: "variable",
        key: variableKey(node),
        name: node.raw,
        declaration: isLocalPrefix(node.prefix) ? declaration : null,
        range,
      };
    }
    case "CommandStatement":
      if (contains(node.nameRange, offset) && index.findFunctions(node.name).length > 0) {
        return { kind: "function", name: node.name, range: node.nameRange };
      }
      return undefined;
    case "Call":
      if (contains(node.calleeRange, offset) && index.findFunctions(node.callee).length > 0) {
        return { kind: "function", name: node.callee, range: node.calleeRange };
      }
      return undefined;
    case "Identifier":
      return index.findFunctions(node.name).length > 0 ? { kind: "function", name: node.name, range: node.range } : undefined;
    default:
      return undefined;
  }
}
