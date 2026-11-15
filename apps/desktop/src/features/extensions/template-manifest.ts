import type { EmulatorFamily } from "@runeforge/project-core";
import { normalizeToLf } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";

export const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TEMPLATES = 32;
const MAX_SOURCE_LENGTH = 20_000;

export interface CatalogTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly emulator: EmulatorFamily | "any";
  readonly source: string;
}

export interface TemplateManifest {
  readonly name: string;
  readonly templates: readonly CatalogTemplate[];
}

export type ManifestProblem =
  | { readonly code: "too-large" | "read" | "encoding" | "json" | "format" | "version" }
  | { readonly code: "entry" | "duplicate" | "script"; readonly position: number };

export type ManifestResult = { readonly ok: true; readonly manifest: TemplateManifest } | { readonly ok: false; readonly problem: ManifestProblem };

const failure = (problem: ManifestProblem): ManifestResult => ({ ok: false, problem });

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function label(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function parseTemplate(value: unknown): CatalogTemplate | null {
  if (!record(value, ["id", "name", "description", "emulator", "source"])) return null;
  const { id, name, description, emulator, source } = value;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || !label(name, 100)) return null;
  if (description !== undefined && !label(description, 300)) return null;
  if (emulator !== "rathena" && emulator !== "hercules" && emulator !== "any") return null;
  // Seules les fins de ligne et les tabulations sont autorisées parmi les caractères de contrôle du script.
  if (typeof source !== "string" || source.length > MAX_SOURCE_LENGTH || /\p{Cc}/u.test(source.replace(/[\r\n\t]/g, ""))) return null;
  const normalized = normalizeToLf(source);
  return { id, name: name.trim(), description: description?.trim() ?? null, emulator, source: normalized.endsWith("\n") ? normalized : `${normalized}\n` };
}

/** Un manifeste v1 est uniquement un catalogue de texte RuneScript. Les champs d'exécution et chemins sont rejetés. */
export function decodeTemplateManifest(bytes: Uint8Array): ManifestResult {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return failure({ code: "too-large" });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure({ code: "encoding" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return failure({ code: "json" });
  }
  if (!record(raw, ["format", "version", "name", "templates"]) || raw["format"] !== "runeforge-templates") return failure({ code: "format" });
  if (raw["version"] !== 1) return failure({ code: "version" });
  const name = raw["name"];
  const entries = raw["templates"];
  if (!label(name, 100) || !Array.isArray(entries) || entries.length === 0 || entries.length > MAX_TEMPLATES) return failure({ code: "format" });

  const templates: CatalogTemplate[] = [];
  const ids = new Set<string>();
  for (const [index, value] of (entries as unknown[]).entries()) {
    const position = index + 1;
    const template = parseTemplate(value);
    if (template === null) return failure({ code: "entry", position });
    if (ids.has(template.id)) return failure({ code: "duplicate", position });
    const result = parse(template.source);
    if (result.truncated || result.ast.declarations.length === 0 || result.ast.declarations.some((declaration) => declaration.kind === "RawDeclaration")
      || result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return failure({ code: "script", position });
    ids.add(template.id);
    templates.push(template);
  }
  return { ok: true, manifest: { name: name.trim(), templates } };
}

/** Le navigateur ne lit que le fichier que l'utilisateur vient de sélectionner dans ce dialogue. */
export function readTemplateManifest(file: File): Promise<ManifestResult> {
  if (file.size > MAX_MANIFEST_BYTES) return Promise.resolve(failure({ code: "too-large" }));
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => resolve(failure({ code: "read" }));
    reader.onload = () => resolve(reader.result instanceof ArrayBuffer ? decodeTemplateManifest(new Uint8Array(reader.result)) : failure({ code: "read" }));
    reader.readAsArrayBuffer(file);
  });
}
