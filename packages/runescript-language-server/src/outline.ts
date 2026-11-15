import type { LineIndex, SourceRange } from "@runeforge/runescript-core";
import type { DeclarationSymbol, FileAnalysis, LabelSymbol, NpcType } from "@runeforge/runescript-analysis";
import { SymbolKind } from "./types";
import type { DocumentSymbol, Range } from "./types";

export function toRange(lines: LineIndex, range: SourceRange): Range {
  return { start: lines.positionAt(range.start), end: lines.positionAt(range.end) };
}

const NPC_KIND: Record<NpcType, SymbolKind> = {
  script: SymbolKind.Class,
  duplicate: SymbolKind.Class,
  warp: SymbolKind.Namespace,
  shop: SymbolKind.Struct,
  cashshop: SymbolKind.Struct,
  itemshop: SymbolKind.Struct,
  pointshop: SymbolKind.Struct,
  marketshop: SymbolKind.Struct,
};

function labelSymbol(label: LabelSymbol, lines: LineIndex): DocumentSymbol {
  const kind = label.kind === "function" ? SymbolKind.Function : label.isEvent ? SymbolKind.Event : SymbolKind.Field;
  return {
    name: label.name,
    kind,
    range: toRange(lines, label.range),
    selectionRange: toRange(lines, label.nameRange),
    children: [],
  };
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/** Range des labels dans l'ordre du source ; une fonction locale contient les labels de son corps. */
function labelChildren(labels: readonly LabelSymbol[], lines: LineIndex): DocumentSymbol[] {
  const roots: DocumentSymbol[] = [];
  const stack: { symbol: DocumentSymbol; source: SourceRange }[] = [];
  for (const label of labels) {
    const symbol = labelSymbol(label, lines);
    while (stack.length > 0 && !contains(stack[stack.length - 1]!.source, label.range)) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(symbol);
    else parent.symbol.children.push(symbol);
    if (label.kind === "function") stack.push({ symbol, source: label.range });
  }
  return roots;
}

function declarationSymbol(declaration: DeclarationSymbol, lines: LineIndex): DocumentSymbol {
  const children = declaration.scope === null ? [] : labelChildren(declaration.scope.labels, lines);
  if (declaration.kind === "function") {
    return {
      name: declaration.name,
      detail: "function",
      kind: SymbolKind.Function,
      range: toRange(lines, declaration.range),
      selectionRange: toRange(lines, declaration.nameRange),
      children,
    };
  }
  const place =
    declaration.map === null ? "" : declaration.x === null || declaration.y === null ? declaration.map : `${declaration.map} ${declaration.x},${declaration.y}`;
  const parts: string[] = [];
  if (declaration.npcType === "duplicate" && declaration.duplicateOf !== null) parts.push(`duplicate(${declaration.duplicateOf.name})`);
  else if (declaration.npcType !== "script") parts.push(declaration.npcType);
  if (declaration.uniqueName !== declaration.displayName) parts.push(`::${declaration.uniqueName}`);
  if (place !== "") parts.push(place);
  const name = declaration.displayName !== "" ? declaration.displayName : declaration.uniqueName;
  return {
    name: name === "" ? "(sans nom)" : name,
    ...(parts.length > 0 ? { detail: parts.join(" · ") } : {}),
    kind: NPC_KIND[declaration.npcType],
    range: toRange(lines, declaration.range),
    selectionRange: toRange(lines, declaration.nameRange),
    children,
  };
}

/** Plan d'un fichier : NPC et fonctions, avec leurs labels et fonctions locales en enfants. */
export function buildOutline(analysis: FileAnalysis, lines: LineIndex): DocumentSymbol[] {
  return analysis.declarations.map((declaration) => declarationSymbol(declaration, lines));
}
