import {
  executeDeploy,
  findBlockers,
  nextManifest,
  parseManifest,
  planDeploy,
  rollbackDeploy,
  serializeManifest,
  type DeployIo,
  type DeployManifest,
  type DeployPlan,
  type DeployReport,
  type FileEntry,
  type RollbackIo,
  type RollbackReport,
} from "@runeforge/deploy-core";
import type { BackendApi } from "../services/backend";
import { BackendError, toBackendError, type Precondition } from "../services/types";

/**
 * Deploiement vers un dossier (RF-018) : relie `@runeforge/deploy-core` aux fichiers. La destination est une **racine approuvee** a part
 * (choisie par l'utilisateur dans la boite de dialogue du systeme) ; le projet garde, dans `.runeforge/deploy/<destination>/`, le manifeste
 * du dernier deploiement, ses sauvegardes (`*.bak`, jamais prises pour des scripts) et son rapport. Rien n'est jamais ecrit ailleurs.
 */

/** Les seuls acces au disque dont le deploiement a besoin. */
export type DeployBackend = Pick<BackendApi, "readFiles" | "writeFile" | "createDirectory">;

export interface DeployRoots {
  readonly projectRootId: string;
  readonly destinationRootId: string;
}

/** Au plus ce nombre de fichiers par deploiement (un dossier plus gros se deploie en plusieurs fois). */
export const MAX_DEPLOY_FILES = 2000;

const DIRECTORY = ".runeforge/deploy";
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export const deployDirectory = (roots: DeployRoots): string => `${DIRECTORY}/${roots.destinationRootId}`;
export const manifestPath = (roots: DeployRoots): string => `${deployDirectory(roots)}/manifest.json`;
export const lastReportPath = (roots: DeployRoots): string => `${deployDirectory(roots)}/last-report.json`;
export const backupPath = (roots: DeployRoots, stamp: string, path: string): string => `${deployDirectory(roots)}/backups/${stamp}/${path}.bak`;

/** Horodatage d'un deploiement, sans caractere interdit dans un nom de fichier Windows. */
export const stampOf = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, "-");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cree les dossiers manquants au-dessus de `path` (un niveau a la fois, comme le fait la creation de fichier). */
async function ensureParents(backend: DeployBackend, rootId: string, path: string): Promise<void> {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) await backend.createDirectory(rootId, segments.slice(0, index).join("/"));
}

/** Lit un fichier ; `null` s'il n'existe pas, une erreur pour tout autre echec (jamais pris pour une absence). */
async function readOne(backend: DeployBackend, rootId: string, path: string): Promise<Uint8Array | null> {
  const [result] = await backend.readFiles(rootId, [path]);
  if (result === undefined) throw new BackendError({ code: "protocol", message: "empty read" });
  if (result.ok) return result.bytes;
  if (result.error.code === "not_found") return null;
  throw result.error;
}

function precondition(value: { readonly kind: "mustNotExist" } | { readonly kind: "mustMatch"; readonly sha256: string }): Precondition {
  return value.kind === "mustNotExist" ? { kind: "mustNotExist" } : { kind: "mustMatch", sha256: value.sha256 };
}

export function createIo(backend: DeployBackend, roots: DeployRoots, stamp: string): DeployIo & RollbackIo {
  return {
    async readLocal(path) {
      const bytes = await readOne(backend, roots.projectRootId, path);
      if (bytes === null) throw new BackendError({ code: "not_found" });
      return bytes;
    },
    readRemote: (path) => readOne(backend, roots.destinationRootId, path),
    async writeRemote(path, bytes, expected) {
      await ensureParents(backend, roots.destinationRootId, path);
      await backend.writeFile(roots.destinationRootId, path, bytes, precondition(expected), false);
    },
    async saveBackup(path, bytes) {
      const target = backupPath(roots, stamp, path);
      await ensureParents(backend, roots.projectRootId, target);
      await backend.writeFile(roots.projectRootId, target, bytes, { kind: "mustNotExist" }, false);
    },
    readBackup: (path) => readOne(backend, roots.projectRootId, backupPath(roots, stamp, path)),
    sha256: sha256Hex,
  };
}

export interface Preparation {
  readonly plan: DeployPlan;
  /** Le manifeste du dernier deploiement vers cette destination (`null` : jamais deploye, ou manifeste illisible). */
  readonly manifest: DeployManifest | null;
  /** Fichiers du projet qui n'ont pas pu etre lus (ils ne sont pas dans le plan). */
  readonly unreadable: readonly string[];
  /** Fichiers du projet que le plan ne couvre pas parce que la limite est atteinte. */
  readonly omitted: number;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Le manifeste du dernier deploiement vers cette destination, ou `null`. */
export async function readManifest(backend: DeployBackend, roots: DeployRoots): Promise<DeployManifest | null> {
  const bytes = await readOne(backend, roots.projectRootId, manifestPath(roots)).catch(() => null);
  const manifest = bytes === null ? null : parseManifest(decode(bytes));
  return manifest !== null && manifest.target === roots.destinationRootId ? manifest : null;
}

/**
 * Le plan (dry-run) du deploiement de `paths` : lit les deux cotes, n'ecrit rien. Une destination illisible (autrement qu'absente) est une
 * erreur, pas un fichier a creer.
 */
export async function prepareDeploy(backend: DeployBackend, roots: DeployRoots, paths: readonly string[]): Promise<Preparation> {
  const kept = paths.slice(0, MAX_DEPLOY_FILES);
  const local: FileEntry[] = [];
  const unreadable: string[] = [];
  for (const result of await backend.readFiles(roots.projectRootId, kept)) {
    if (result.ok) local.push({ path: result.path, size: result.stat.size, sha256: result.stat.sha256 });
    else unreadable.push(result.path);
  }
  const remote = new Map<string, FileEntry>();
  for (const result of await backend.readFiles(roots.destinationRootId, local.map((entry) => entry.path))) {
    if (result.ok) remote.set(result.path, { path: result.path, size: result.stat.size, sha256: result.stat.sha256 });
    else if (result.error.code !== "not_found") throw result.error;
  }
  const manifest = await readManifest(backend, roots);
  const baseline = new Map(Object.entries(manifest?.files ?? {}));
  return { plan: planDeploy({ local, remote, baseline }), manifest, unreadable, omitted: paths.length - kept.length };
}

/** Fichiers du plan qui ont des erreurs d'analyse locale (voir `findBlockers`). */
export { findBlockers };

interface SavedDeploy {
  readonly version: 1;
  readonly stamp: string;
  readonly report: DeployReport;
}

/** Ce que le dernier deploiement vers cette destination a fait (pour pouvoir le restaurer apres un redemarrage), ou `null`. */
export async function readLastDeploy(backend: DeployBackend, roots: DeployRoots): Promise<{ stamp: string; report: DeployReport } | null> {
  const bytes = await readOne(backend, roots.projectRootId, lastReportPath(roots)).catch(() => null);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(decode(bytes)) as Partial<SavedDeploy>;
    if (value.version !== 1 || typeof value.stamp !== "string" || !STAMP.test(value.stamp) || value.report === undefined || !Array.isArray(value.report.results)) return null;
    return { stamp: value.stamp, report: value.report };
  } catch {
    return null;
  }
}

async function writeProjectFile(backend: DeployBackend, roots: DeployRoots, path: string, text: string): Promise<void> {
  await ensureParents(backend, roots.projectRootId, path);
  await backend.writeFile(roots.projectRootId, path, new TextEncoder().encode(text), { kind: "overwrite" }, false);
}

export interface RunOptions {
  readonly overwriteConflicts: boolean;
  readonly now: () => number;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Execute un plan confirme : sauvegarde, ecrit, verifie, puis note ce qui a ete laisse a la destination (manifeste) et ce qui a ete fait
 * (rapport, pour la restauration). Le manifeste et le rapport sont ecrits meme apres un echec partiel : ils disent la verite de la destination.
 */
export async function runDeploy(backend: DeployBackend, roots: DeployRoots, preparation: Preparation, options: RunOptions): Promise<{ stamp: string; report: DeployReport }> {
  const stamp = stampOf(options.now());
  const report = await executeDeploy(preparation.plan, createIo(backend, roots, stamp), options);
  const manifest = nextManifest(preparation.manifest, roots.destinationRootId, report);
  await writeProjectFile(backend, roots, manifestPath(roots), serializeManifest(manifest));
  const saved: SavedDeploy = { version: 1, stamp, report };
  await writeProjectFile(backend, roots, lastReportPath(roots), `${JSON.stringify(saved, null, 2)}\n`);
  return { stamp, report };
}

/** Restaure ce que le dernier deploiement a remplace, et remet le manifeste en accord avec la destination. */
export async function rollbackLast(backend: DeployBackend, roots: DeployRoots, last: { stamp: string; report: DeployReport }): Promise<RollbackReport> {
  const result = await rollbackDeploy(last.report, createIo(backend, roots, last.stamp));
  const manifest = await readManifest(backend, roots);
  if (manifest !== null) {
    const files: Record<string, string> = { ...manifest.files };
    for (const path of result.restored) {
      const previous = last.report.results.find((entry) => entry.path === path)?.previousSha256;
      if (previous !== undefined) files[path] = previous;
    }
    await writeProjectFile(backend, roots, manifestPath(roots), serializeManifest({ ...manifest, files }));
  }
  // Le rapport restaure n'est plus a restaurer.
  await writeProjectFile(backend, roots, lastReportPath(roots), `${JSON.stringify({ version: 1, stamp: last.stamp, report: { ...last.report, results: last.report.results.filter((entry) => !result.restored.includes(entry.path)) } }, null, 2)}\n`);
  return result;
}

/** Combien de fichiers dans chaque etat (pour le resume et le journal : des nombres, jamais des chemins). */
export function countResults(report: DeployReport): Record<"created" | "updated" | "overwritten" | "unchanged" | "skipped" | "failed", number> {
  const counts = { created: 0, updated: 0, overwritten: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const result of report.results) counts[result.status] += 1;
  return counts;
}

/** Un code d'erreur lisible par l'interface, pour un echec de lecture ou d'ecriture pendant la preparation ou la restauration. */
export const failureCode = (error: unknown): string => toBackendError(error).code;
