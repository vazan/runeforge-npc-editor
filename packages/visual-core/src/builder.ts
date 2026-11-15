import { parse } from "@runeforge/runescript-parser";
import type { NpcDeclaration, Statement } from "@runeforge/runescript-parser";
import { quote } from "./edit";

export type VisualArgumentKind = "string" | "integer" | "expression" | "reference" | "label";

export interface VisualCommandArity {
  readonly min: number;
  readonly max: number | null;
}

export interface VisualScriptCommandDefinition {
  readonly name: string;
  readonly arity: VisualCommandArity | null;
  readonly parameterTypes: string | null;
  readonly signatures: readonly string[];
  readonly documentation: string | null;
  readonly deprecated: boolean;
}

export interface VisualCommandArgument {
  readonly id: string;
  readonly kind: VisualArgumentKind;
  readonly required: boolean;
  readonly value: string;
}

export interface VisualCommandNode {
  readonly id: string;
  readonly type: "command";
  readonly commandName: string;
  readonly parameterTypes: string;
  readonly arity: VisualCommandArity;
  readonly arguments: readonly VisualCommandArgument[];
}

export interface VisualIfNode {
  readonly id: string;
  readonly type: "if";
  readonly condition: string;
  readonly then: readonly VisualBuilderNode[];
  readonly else: readonly VisualBuilderNode[] | null;
}

export type VisualBuilderNode = VisualCommandNode | VisualIfNode;

export interface VisualNpcHeader {
  readonly map: string;
  readonly x: string;
  readonly y: string;
  readonly direction: string;
  readonly name: string;
  readonly sprite: string;
}

export type VisualBuilderIssueCode =
  | "invalid-map"
  | "invalid-coordinate"
  | "invalid-direction"
  | "invalid-name"
  | "invalid-sprite"
  | "unknown-command"
  | "unsupported-signature"
  | "argument-count"
  | "required-argument"
  | "invalid-argument"
  | "invalid-condition"
  | "missing-terminal"
  | "terminal-not-last"
  | "invalid-script";

export interface VisualBuilderIssue {
  readonly code: VisualBuilderIssueCode;
  readonly nodeId?: string;
  readonly argumentId?: string;
}

export interface VisualNpcBuildResult {
  readonly source: string | null;
  readonly issues: readonly VisualBuilderIssue[];
}

interface ParameterSchema {
  readonly required: readonly VisualArgumentKind[];
  readonly optional: number;
  readonly variadic: boolean;
}

function argumentKind(type: string): VisualArgumentKind | null {
  switch (type) {
    case "s": return "string";
    case "i": return "integer";
    case "r": return "reference";
    case "l": return "label";
    case "v": return "expression";
    default: return null;
  }
}

function parameterSchema(types: string): ParameterSchema | null {
  const required: VisualArgumentKind[] = [];
  let index = 0;
  while (index < types.length && "vsirl".includes(types.charAt(index))) {
    const kind = argumentKind(types.charAt(index));
    if (kind === null) return null;
    required.push(kind);
    index += 1;
  }
  let optional = 0;
  while (types.charAt(index) === "?") {
    optional += 1;
    index += 1;
  }
  const variadic = types.charAt(index) === "*";
  if (variadic) index += 1;
  return index === types.length ? { required, optional, variadic } : null;
}

function validDefinition(definition: VisualScriptCommandDefinition): ParameterSchema | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.name) ||
      definition.arity === null || definition.parameterTypes === null) return null;
  const schema = parameterSchema(definition.parameterTypes);
  if (schema === null || schema.required.length !== definition.arity.min) return null;
  if (schema.variadic ? definition.arity.max !== null : definition.arity.max !== schema.required.length + schema.optional) return null;
  return schema;
}

/** Creates a palette node only when its required arguments and signature are known. */
export function createVisualCommandNode(
  definition: VisualScriptCommandDefinition,
  id: string,
): VisualCommandNode | null {
  const schema = validDefinition(definition);
  const arity = definition.arity;
  if (schema === null || arity === null || id.length === 0 || id.length > 256) return null;
  const argumentsList = schema.required.map((kind, index): VisualCommandArgument => ({
    id: `${id}:arg:${index}`,
    kind,
    required: true,
    value: "",
  }));
  return {
    id,
    type: "command",
    commandName: definition.name,
    parameterTypes: definition.parameterTypes ?? "",
    arity,
    arguments: argumentsList,
  };
}

export function createVisualIfNode(id: string, condition = "1"): VisualIfNode {
  return { id, type: "if", condition, then: [], else: null };
}

/** Adds one optional or variadic argument, or returns null when the registry limit is reached. */
export function addVisualCommandArgument(node: VisualCommandNode): VisualCommandNode | null {
  if (node.arity.max !== null && node.arguments.length >= node.arity.max) return null;
  const index = node.arguments.length;
  return {
    ...node,
    arguments: [...node.arguments, {
      id: `${node.id}:arg:${index}`,
      kind: "expression",
      required: false,
      value: "",
    }],
  };
}

/** Removes only an optional argument; required arguments must be completed rather than removed. */
export function removeVisualCommandArgument(node: VisualCommandNode, argumentId: string): VisualCommandNode | null {
  const index = node.arguments.findIndex((argument) => argument.id === argumentId);
  if (index < 0 || node.arguments[index]?.required === true) return null;
  return { ...node, arguments: node.arguments.filter((argument) => argument.id !== argumentId) };
}

function safePreviewValue(argument: VisualCommandArgument): string {
  const value = argument.value.trim();
  if (argument.kind === "string") return quote(value);
  if (argument.kind === "integer") return /^-?\d+$/.test(value) ? value : "0";
  if (argument.kind === "label") return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : "L_End";
  return value === "" ? "0" : value;
}

function validateHeader(header: VisualNpcHeader, issues: VisualBuilderIssue[]): boolean {
  let valid = true;
  if (!/^[A-Za-z0-9_]+$/.test(header.map)) {
    issues.push({ code: "invalid-map" });
    valid = false;
  }
  for (const coordinate of [header.x, header.y]) {
    if (!/^\d+$/.test(coordinate) || !Number.isSafeInteger(Number(coordinate)) || Number(coordinate) > 9999) {
      issues.push({ code: "invalid-coordinate" });
      valid = false;
    }
  }
  if (!/^[0-7]$/.test(header.direction)) {
    issues.push({ code: "invalid-direction" });
    valid = false;
  }
  if (!/^[A-Za-z0-9_ ]{1,24}$/.test(header.name) || header.name.trim() === "") {
    issues.push({ code: "invalid-name" });
    valid = false;
  }
  if (!/^-1$|^[A-Za-z0-9_]+$/.test(header.sprite)) {
    issues.push({ code: "invalid-sprite" });
    valid = false;
  }
  return valid;
}

function validateArguments(node: VisualCommandNode, definition: VisualScriptCommandDefinition, issues: VisualBuilderIssue[]): void {
  const schema = validDefinition(definition);
  if (schema === null || node.parameterTypes !== definition.parameterTypes ||
      node.arity.min !== definition.arity?.min || node.arity.max !== definition.arity?.max) {
    issues.push({ code: "unsupported-signature", nodeId: node.id });
    return;
  }
  if (node.arguments.length < node.arity.min ||
      (node.arity.max !== null && node.arguments.length > node.arity.max)) {
    issues.push({ code: "argument-count", nodeId: node.id });
  }
  for (const [index, argument] of node.arguments.entries()) {
    const hasControlCharacter = Array.from(argument.value).some((character) => character.charCodeAt(0) < 32);
    if (argument.required && argument.value.trim() === "") {
      issues.push({ code: "required-argument", nodeId: node.id, argumentId: argument.id });
    } else if (argument.value.length > 4096 ||
        (argument.kind === "string" && hasControlCharacter) ||
        (argument.kind === "integer" && argument.value.trim() !== "" &&
          (!/^-?\d+$/.test(argument.value.trim()) || !Number.isSafeInteger(Number(argument.value.trim())))) ||
        (argument.kind === "label" && argument.value.trim() !== "" &&
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument.value.trim()))) {
      issues.push({ code: "invalid-argument", nodeId: node.id, argumentId: argument.id });
    }
    if (index < schema.required.length && argument.kind !== schema.required[index]) {
      issues.push({ code: "unsupported-signature", nodeId: node.id, argumentId: argument.id });
    }
  }
}

function terminal(node: VisualBuilderNode): boolean {
  return node.type === "command" && ["close", "end"].includes(node.commandName.toLowerCase());
}

/** Tous les chemins finissent par close ou end : un dernier noeud terminal, ou un if/else dont les deux branches finissent ainsi. */
function endsWithTerminal(nodes: readonly VisualBuilderNode[]): boolean {
  const last = nodes.at(-1);
  if (last === undefined) return false;
  if (last.type === "command") return terminal(last);
  return last.else !== null && endsWithTerminal(last.then) && endsWithTerminal(last.else);
}

function validateNodes(
  nodes: readonly VisualBuilderNode[],
  definitions: ReadonlyMap<string, VisualScriptCommandDefinition>,
  issues: VisualBuilderIssue[],
  ids: Set<string>,
  depth = 0,
): number {
  if (depth > 64) {
    issues.push({ code: "invalid-script" });
    return 0;
  }
  let count = 0;
  nodes.forEach((node, index) => {
    count += 1;
    if (node.id.length === 0 || node.id.length > 256 || ids.has(node.id)) {
      issues.push({ code: "invalid-script", nodeId: node.id });
    }
    ids.add(node.id);
    if (terminal(node) && index !== nodes.length - 1) {
      issues.push({ code: "terminal-not-last", nodeId: node.id });
    }
    if (node.type === "if") {
      const hasControlCharacter = Array.from(node.condition).some((character) => character.charCodeAt(0) < 32);
      if (node.condition.trim() === "" || node.condition.length > 4096 || hasControlCharacter) {
        issues.push({ code: "invalid-condition", nodeId: node.id });
      }
      count += validateNodes(node.then, definitions, issues, ids, depth + 1);
      if (node.else !== null) count += validateNodes(node.else, definitions, issues, ids, depth + 1);
      return;
    }
    const definition = definitions.get(node.commandName.toLowerCase());
    if (definition === undefined) {
      issues.push({ code: "unknown-command", nodeId: node.id });
      return;
    }
    validateArguments(node, definition, issues);
  });
  return count;
}

function renderNodes(nodes: readonly VisualBuilderNode[], depth: number): string[] {
  const indent = "\t".repeat(depth);
  return nodes.flatMap((node): string[] => {
    if (node.type === "command") {
      const args = node.arguments.map(safePreviewValue);
      return [`${indent}${node.commandName}${args.length === 0 ? "" : ` ${args.join(", ")}`};`];
    }
    const lines = [`${indent}if (${node.condition.trim()}) {`, ...renderNodes(node.then, depth + 1)];
    if (node.else !== null) {
      lines.push(`${indent}} else {`, ...renderNodes(node.else, depth + 1));
    }
    lines.push(`${indent}}`);
    return lines;
  });
}

function commandsInNodes(nodes: readonly VisualBuilderNode[]): readonly VisualCommandNode[] {
  return nodes.flatMap((node) =>
    node.type === "command"
      ? [node]
      : [...commandsInNodes(node.then), ...(node.else === null ? [] : commandsInNodes(node.else))]);
}

function statementsWithin(statement: Statement): readonly Statement[] {
  if (statement.kind === "BlockStatement") return statement.statements.flatMap(statementsWithin);
  if (statement.kind === "IfStatement") {
    return [
      ...statementsWithin(statement.consequent),
      ...(statement.alternate === null ? [] : statementsWithin(statement.alternate)),
    ];
  }
  return statement.kind === "EmptyStatement" ? [] : [statement];
}

/** Builds one self-contained NPC script; incomplete blocks remain preview-only and are never exportable. */
export function buildVisualNpc(
  header: VisualNpcHeader,
  nodes: readonly VisualBuilderNode[],
  definitions: readonly VisualScriptCommandDefinition[],
): VisualNpcBuildResult {
  const issues: VisualBuilderIssue[] = [];
  const headerValid = validateHeader(header, issues);
  const byName = new Map(definitions.map((definition) => [definition.name.toLowerCase(), definition]));
  const nodeIds = new Set<string>();
  const nodeCount = validateNodes(nodes, byName, issues, nodeIds);
  const last = nodes.at(-1);
  if (!endsWithTerminal(nodes)) issues.push({ code: "missing-terminal", nodeId: last?.id });
  if (nodeCount > 500) issues.push({ code: "invalid-script" });
  if (!headerValid || issues.some((issue) => issue.code === "invalid-script")) return { source: null, issues };

  const source = [
    `${header.map},${header.x},${header.y},${header.direction}\tscript\t${header.name}\t${header.sprite},{`,
    ...renderNodes(nodes, 1),
    "}",
    "",
  ].join("\n");
  const parsed = parse(source);
  const npc = parsed.ast.declarations.find((declaration): declaration is NpcDeclaration =>
    declaration.kind === "NpcDeclaration" && declaration.name.display === header.name);
  const statements = npc?.body?.statements.flatMap(statementsWithin).filter((statement) => statement.kind === "CommandStatement") ?? [];
  const expectedCommands = commandsInNodes(nodes);
  if (parsed.truncated || parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      npc === undefined || npc.body === null || npc.body.closeRange === null || statements.length !== expectedCommands.length ||
      statements.some((statement, index) => statement.kind !== "CommandStatement" || !statement.terminated ||
        statement.name.toLowerCase() !== expectedCommands[index]?.commandName.toLowerCase() ||
        statement.args.length !== expectedCommands[index]?.arguments.length)) {
    issues.push({ code: "invalid-script" });
  }
  return { source, issues };
}
