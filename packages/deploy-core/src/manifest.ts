import type { DeployReport } from "./execute";

/**
 * Ce que le dernier deploiement a laisse a la destination : l'empreinte de chaque fichier envoye. C'est la reference qui distingue une mise a
 * jour (la destination est telle que nous l'avons laissee) d'un conflit (elle a change depuis). Un fichier du projet, pas un secret.
 */
export interface DeployManifest {
  readonly version: 1;
  /** Nom de la destination (le manifeste lui appartient). */
  readonly target: string;
  readonly deployedAtMs: number;
  readonly files: Readonly<Record<string, string>>;
}

export const MAX_MANIFEST_FILES = 100_000;
const SHA256 = /^[0-9a-f]{64}$/;

function safeRelativePath(path: string): boolean {
  if (path === "" || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes(":")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Le manifeste en JSON stable (cles rangees) : deux deploiements identiques donnent le meme texte. */
export function serializeManifest(manifest: DeployManifest): string {
  const files: Record<string, string> = {};
  for (const path of Object.keys(manifest.files).sort()) files[path] = manifest.files[path] as string;
  return `${JSON.stringify({ version: 1, target: manifest.target, deployedAtMs: manifest.deployedAtMs, files }, null, 2)}\n`;
}

/** Lit un manifeste ; `null` s'il est illisible ou invalide (un manifeste douteux n'est jamais utilise : le plan retombe sur « jamais deploye »). */
export function parseManifest(text: string): DeployManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || typeof record["target"] !== "string" || record["target"] === "") return null;
  if (typeof record["deployedAtMs"] !== "number" || !Number.isFinite(record["deployedAtMs"])) return null;
  const files = record["files"];
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null;
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > MAX_MANIFEST_FILES) return null;
  const clean: Record<string, string> = {};
  for (const [path, sha256] of entries) {
    if (!safeRelativePath(path) || typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
    clean[path] = sha256;
  }
  return { version: 1, target: record["target"], deployedAtMs: record["deployedAtMs"], files: clean };
}

/**
 * Le manifeste qui suit un deploiement : l'ancien, plus l'empreinte de chaque fichier que la destination contient desormais identique au projet
 * (crees, mis a jour, ecrases, et deja identiques). Un fichier en echec ou ignore garde son ancienne empreinte (ou reste inconnu).
 */
export function nextManifest(previous: DeployManifest | null, target: string, report: DeployReport): DeployManifest {
  const files: Record<string, string> = previous !== null && previous.target === target ? { ...previous.files } : {};
  for (const result of report.results) {
    if ((result.status === "created" || result.status === "updated" || result.status === "overwritten" || result.status === "unchanged") && result.sha256 !== undefined) {
      files[result.path] = result.sha256;
    }
  }
  return { version: 1, target, deployedAtMs: report.finishedAtMs, files };
}
