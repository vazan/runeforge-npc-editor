import type { SourceRange } from "@runeforge/runescript-core";
import type { AstNode, Expression, Statement, TopLevelDeclaration } from "./ast";

/** Enfants directs d'un noeud (declarations -> bloc ; instructions -> sous-instructions et expressions). */
export function childrenOf(node: AstNode): AstNode[] {
  switch (node.kind) {
    case "ScriptFile":
      return [...node.declarations];
    case "NpcDeclaration":
    case "FunctionDeclaration":
      return node.body === null ? [] : [node.body];
    case "BlockStatement":
      return [...node.statements];
    case "CommandStatement":
      return [...node.args];
    case "ExpressionStatement":
      return [node.expression];
    case "IfStatement":
      return node.alternate === null ? [node.condition, node.consequent] : [node.condition, node.consequent, node.alternate];
    case "WhileStatement":
      return [node.condition, node.body];
    case "DoWhileStatement":
      return [node.body, node.condition];
    case "ForStatement": {
      const children: AstNode[] = [];
      if (node.init !== null) children.push(node.init);
      if (node.condition !== null) children.push(node.condition);
      if (node.update !== null) children.push(node.update);
      children.push(node.body);
      return children;
    }
    case "SwitchStatement":
      return [node.discriminant, node.body];
    case "CaseStatement":
      return [node.test];
    case "ReturnStatement":
      return node.value === null ? [] : [node.value];
    case "FunctionStatement":
      return node.body === null ? [] : [node.body];
    case "Call":
      return [...node.args];
    case "Variable":
      return node.index === null ? [] : [node.index];
    case "Unary":
    case "Update":
      return [node.operand];
    case "Binary":
      return [node.left, node.right];
    case "Assignment":
      return [node.target, node.value];
    case "Conditional":
      return [node.test, node.consequent, node.alternate];
    case "Parenthesized":
      return [node.expression];
    default:
      return [];
  }
}

export interface WalkContext {
  /** Ancetres du noeud visite, du plus proche au plus eloigne. */
  readonly ancestors: readonly AstNode[];
}

/**
 * Parcours en profondeur (pre-ordre). Retourner `false` depuis le visiteur empeche la descente
 * dans les enfants du noeud courant. Iteratif : sans risque de depassement de pile.
 */
export function walk(root: AstNode, visitor: (node: AstNode, context: WalkContext) => boolean | void): void {
  interface Frame {
    node: AstNode;
    ancestors: AstNode[];
  }
  const stack: Frame[] = [{ node: root, ancestors: [] }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const result = visitor(frame.node, { ancestors: frame.ancestors });
    if (result === false) continue;
    const children = childrenOf(frame.node);
    const ancestors = [frame.node, ...frame.ancestors];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child !== undefined) stack.push({ node: child, ancestors });
    }
  }
}

function contains(range: SourceRange, offset: number): boolean {
  return offset >= range.start && offset <= range.end;
}

/** Chemin des noeuds contenant `offset`, de la racine au plus profond. */
export function findPathAt(root: AstNode, offset: number): AstNode[] {
  const path: AstNode[] = [];
  let current: AstNode | undefined = root;
  while (current !== undefined) {
    path.push(current);
    const next: AstNode | undefined = childrenOf(current).find((child) => contains(child.range, offset));
    current = next;
  }
  return path;
}

/** Noeud le plus profond contenant `offset`. */
export function findNodeAt(root: AstNode, offset: number): AstNode {
  const path = findPathAt(root, offset);
  return path[path.length - 1] ?? root;
}

/** Declaration de premier niveau contenant `offset`, ou `undefined`. */
export function findDeclarationAt(declarations: readonly TopLevelDeclaration[], offset: number): TopLevelDeclaration | undefined {
  return declarations.find((declaration) => contains(declaration.range, offset));
}

export function isStatement(node: AstNode): node is Statement {
  return node.kind.endsWith("Statement");
}

export function isExpression(node: AstNode): node is Expression {
  switch (node.kind) {
    case "NumberLiteral":
    case "StringLiteral":
    case "Identifier":
    case "Variable":
    case "Call":
    case "Unary":
    case "Update":
    case "Binary":
    case "Assignment":
    case "Conditional":
    case "Parenthesized":
    case "Placeholder":
    case "ErrorExpression":
      return true;
    default:
      return false;
  }
}
