import type { VisualCommandArity, VisualScriptCommandDefinition } from "./builder";

export interface VisualExtensionManifest {
  readonly schemaVersion: 1;
  readonly apiVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly [];
  readonly commands: readonly VisualScriptCommandDefinition[];
}

export type VisualExtensionParseResult =
  | { readonly ok: true; readonly manifest: VisualExtensionManifest }
  | { readonly ok: false; readonly code: "invalid-json" | "invalid-manifest" | "too-large" | "duplicate-command" | "reserved-command" };

const MAX_MANIFEST_LENGTH = 256 * 1024;
const MAX_COMMANDS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseArity(parameterTypes: string): VisualCommandArity | null {
  let index = 0;
  while (index < parameterTypes.length && "vsirl".includes(parameterTypes.charAt(index))) index += 1;
  const required = index;
  while (parameterTypes.charAt(index) === "?") index += 1;
  const optional = index - required;
  const variadic = parameterTypes.charAt(index) === "*";
  if (variadic) index += 1;
  if (index !== parameterTypes.length) return null;
  return { min: required, max: variadic ? null : required + optional };
}

function parseCommand(value: unknown): VisualScriptCommandDefinition | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "parameterTypes", "signatures", "documentation"]) ||
      typeof value.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.name) ||
      typeof value.parameterTypes !== "string" || value.parameterTypes.length > 32) return null;
  const arity = parseArity(value.parameterTypes);
  if (arity === null || !Array.isArray(value.signatures) || value.signatures.length > 32 ||
      !value.signatures.every((signature) => typeof signature === "string" && signature.length <= 512) ||
      (value.documentation !== null && typeof value.documentation !== "string") ||
      (typeof value.documentation === "string" && value.documentation.length > 10_000)) return null;
  return {
    name: value.name,
    arity,
    parameterTypes: value.parameterTypes,
    signatures: value.signatures,
    documentation: value.documentation,
    deprecated: false,
  };
}

/** Parses static extension data only. It accepts no code, runtime permissions, or undeclared fields. */
export function parseVisualExtensionManifest(
  input: string,
  reservedNames: ReadonlySet<string> = new Set(),
): VisualExtensionParseResult {
  if (input.length > MAX_MANIFEST_LENGTH) return { ok: false, code: "too-large" };
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return { ok: false, code: "invalid-json" };
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "apiVersion", "id", "name", "permissions", "commands"]) ||
      value.schemaVersion !== 1 || value.apiVersion !== 1 ||
      typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.id) ||
      typeof value.name !== "string" || value.name.trim() === "" || value.name.length > 128 ||
      !Array.isArray(value.permissions) || value.permissions.length !== 0 ||
      !Array.isArray(value.commands) || value.commands.length > MAX_COMMANDS) {
    return { ok: false, code: "invalid-manifest" };
  }
  const commands: VisualScriptCommandDefinition[] = [];
  const names = new Set<string>();
  for (const rawCommand of value.commands) {
    const command = parseCommand(rawCommand);
    if (command === null) return { ok: false, code: "invalid-manifest" };
    const normalizedName = command.name.toLowerCase();
    if (reservedNames.has(normalizedName)) return { ok: false, code: "reserved-command" };
    if (names.has(normalizedName)) return { ok: false, code: "duplicate-command" };
    names.add(normalizedName);
    commands.push(command);
  }
  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      apiVersion: 1,
      id: value.id,
      name: value.name,
      permissions: [],
      commands,
    },
  };
}
