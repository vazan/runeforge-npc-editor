import { parse } from "@runeforge/runescript-parser";
import type { BlockStatement, CommandStatement, Expression, IfStatement, NpcDeclaration, ParseResult, Statement, StringLiteral } from "@runeforge/runescript-parser";
import type { ConversionStatus, VisualBlock, VisualNpc } from "./ir";
import { hasControlCharacter, walkBlocks } from "./ir";

function isEditableString(expression: Expression | undefined): expression is StringLiteral {
  return expression !== undefined && expression.kind === "StringLiteral" && !expression.unterminated && !hasControlCharacter(expression.value);
}

const isCommand = (statement: Statement, name: string): statement is CommandStatement =>
  statement.kind === "CommandStatement" && statement.name.toLowerCase() === name && statement.terminated;

/** La condition d'un `if`, sans les parentheses qui l'entourent. */
function conditionOf(expression: Expression): Expression {
  return expression.kind === "Parenthesized" ? expression.expression : expression;
}

function isBracedBranch(statement: Statement | null): statement is BlockStatement {
  return statement !== null && statement.kind === "BlockStatement" && statement.closeRange !== null;
}

function convertIf(text: string, statement: IfStatement, id: string): VisualBlock | null {
  if (!isBracedBranch(statement.consequent)) return null;
  if (statement.alternate !== null && !isBracedBranch(statement.alternate)) return null;
  const condition = conditionOf(statement.condition);
  if (condition.kind === "ErrorExpression" || condition.kind === "Placeholder") return null;
  return {
    kind: "if",
    id,
    range: statement.range,
    condition: text.slice(condition.range.start, condition.range.end),
    conditionRange: condition.range,
    thenRange: statement.consequent.range,
    elseRange: statement.alternate?.range ?? null,
    then: convertList(text, statement.consequent.statements, `${id}.t`),
    else: statement.alternate === null || !isBracedBranch(statement.alternate) ? null : convertList(text, statement.alternate.statements, `${id}.e`),
  };
}

function convertStatement(text: string, statement: Statement, id: string): VisualBlock | null {
  if (statement.kind === "EmptyStatement") return null;
  if (isCommand(statement, "mes") && statement.args.length === 1 && isEditableString(statement.args[0])) {
    const literal = statement.args[0];
    return { kind: "mes", id, range: statement.range, text: literal.value, textRange: literal.range };
  }
  if (isCommand(statement, "next") && statement.args.length === 0) return { kind: "next", id, range: statement.range };
  if (isCommand(statement, "close") && statement.args.length === 0) return { kind: "close", id, range: statement.range };
  if (statement.kind === "IfStatement") {
    const converted = convertIf(text, statement, id);
    if (converted !== null) return converted;
  }
  return { kind: "raw", id, range: statement.range, text: text.slice(statement.range.start, statement.range.end) };
}

function convertList(text: string, statements: readonly Statement[], prefix: string): VisualBlock[] {
  const blocks: VisualBlock[] = [];
  for (const statement of statements) {
    const id = prefix === "" ? String(blocks.length) : `${prefix}.${blocks.length}`;
    const block = convertStatement(text, statement, id);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/**
 * Le corps d'un NPC en blocs ; `null` si le NPC n'a pas de corps ferme (rien a editer visuellement). Chaque instruction que l'edition ne
 * sait pas representer devient un bloc brut qui garde son texte exact.
 */
export function importNpc(text: string, declaration: NpcDeclaration): VisualNpc | null {
  const body = declaration.body;
  if (body === null || body.closeRange === null) return null;
  const blocks = convertList(text, body.statements, "");
  let convertible = 0;
  let raw = 0;
  walkBlocks(blocks, (block) => {
    if (block.kind === "raw") raw += 1;
    else convertible += 1;
  });
  const status: ConversionStatus = convertible === 0 && raw > 0 ? "unsupported" : raw > 0 ? "partial" : "full";
  return {
    name: declaration.name.display,
    declarationStart: declaration.range.start,
    bodyRange: body.range,
    blocks,
    status,
    counts: { convertible, raw },
  };
}

/** Les NPC (avec un corps) du fichier. */
export function scriptNpcs(result: ParseResult): NpcDeclaration[] {
  return result.ast.declarations.filter((declaration): declaration is NpcDeclaration => declaration.kind === "NpcDeclaration" && declaration.body !== null);
}

/** Le NPC dont la declaration commence a `declarationStart` dans un texte deja analyse ; `null` s'il n'existe plus ou n'a plus de corps ferme. */
export function locateNpc(parsed: ParseResult, text: string, declarationStart: number): VisualNpc | null {
  const declaration = scriptNpcs(parsed).find((npc) => npc.range.start === declarationStart);
  return declaration === undefined ? null : importNpc(text, declaration);
}

/** Le NPC dont la declaration commence a `declarationStart` : c'est ainsi qu'on le retrouve apres chaque modification de son corps. */
export function loadNpc(text: string, declarationStart: number): VisualNpc | null {
  return locateNpc(parse(text), text, declarationStart);
}

/** Le NPC a editer que le curseur (`offset`) designe, voir `npcAt` ; `null` si le fichier n'a aucun NPC a corps ferme. */
export function visualNpcAt(text: string, offset: number): VisualNpc | null {
  const declaration = npcAt(parse(text), offset);
  return declaration === null ? null : importNpc(text, declaration);
}

/**
 * Le NPC que le curseur designe : celui dont la declaration contient `offset` ; entre deux NPC (ou apres le dernier), le dernier qui precede ;
 * avant le premier, le premier du fichier. `null` s'il n'y a aucun NPC a corps.
 */
export function npcAt(result: ParseResult, offset: number): NpcDeclaration | null {
  const npcs = scriptNpcs(result);
  const inside = npcs.find((npc) => npc.range.start <= offset && offset <= npc.range.end);
  if (inside !== undefined) return inside;
  const preceding = npcs.filter((npc) => npc.range.end < offset);
  return preceding[preceding.length - 1] ?? npcs[0] ?? null;
}
