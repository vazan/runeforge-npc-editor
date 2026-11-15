/** Etat de session restaure au prochain lancement (document `session`). Toujours normalise, jamais d'exception. */

export interface SessionState {
  readonly version: 1;
  /** Chemin d'affichage du dernier projet ouvert (sert a le retrouver dans les projets recents). */
  readonly projectPath: string | null;
  readonly openFiles: readonly string[];
  readonly activeFile: string | null;
  readonly expandedDirectories: readonly string[];
}

export const EMPTY_SESSION: SessionState = { version: 1, projectPath: null, openFiles: [], activeFile: null, expandedDirectories: [] };

const MAX_ITEMS = 200;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item !== "" && item.length <= 1024 && !result.includes(item)) result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}

export function normalizeSession(input: unknown): SessionState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return EMPTY_SESSION;
  const raw = input as Record<string, unknown>;
  const openFiles = stringArray(raw["openFiles"]);
  const active = typeof raw["activeFile"] === "string" && openFiles.includes(raw["activeFile"]) ? raw["activeFile"] : null;
  return {
    version: 1,
    projectPath: typeof raw["projectPath"] === "string" && raw["projectPath"] !== "" ? raw["projectPath"] : null,
    openFiles,
    activeFile: active ?? openFiles[0] ?? null,
    expandedDirectories: stringArray(raw["expandedDirectories"]),
  };
}
