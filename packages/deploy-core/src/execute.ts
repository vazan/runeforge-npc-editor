import type { DeployPlan, PlanAction } from "./types";

export type RemotePrecondition =
  /** Le fichier ne doit pas exister a la destination. */
  | { readonly kind: "mustNotExist" }
  /** Le fichier doit toujours avoir cette empreinte (personne ne l'a modifie depuis qu'on l'a lu). */
  | { readonly kind: "mustMatch"; readonly sha256: string };

/**
 * Les acces dont un deploiement a besoin. L'application les fournit (dossier local aujourd'hui ; un transport distant plus tard) : ce module
 * ne lit ni n'ecrit rien lui-meme, et ne sait pas ou sont les fichiers.
 */
export interface DeployIo {
  readLocal(path: string): Promise<Uint8Array>;
  /** Contenu actuel du fichier de la destination, ou `null` s'il n'existe pas. */
  readRemote(path: string): Promise<Uint8Array | null>;
  /** Ecrit le fichier de la destination de facon atomique et sous precondition ; rejette si la precondition n'est plus vraie. */
  writeRemote(path: string, bytes: Uint8Array, precondition: RemotePrecondition): Promise<void>;
  /** Garde la version qui va etre remplacee, avant de la remplacer. */
  saveBackup(path: string, bytes: Uint8Array): Promise<void>;
  sha256(bytes: Uint8Array): Promise<string>;
}

export type ResultStatus = "created" | "updated" | "overwritten" | "unchanged" | "skipped" | "failed";

export type FailureCode =
  /** Le fichier local n'a pas pu etre lu. */
  | "read-failed"
  /** Le fichier local a change depuis le plan : ce qui serait envoye n'est plus ce qui a ete montre. */
  | "local-changed"
  /** Le fichier de la destination a change depuis le plan. */
  | "remote-changed"
  | "backup-failed"
  | "write-failed"
  /** Relu apres l'ecriture, le fichier de la destination n'est pas celui qu'on a envoye. */
  | "verify-failed";

export interface FileResult {
  readonly path: string;
  readonly status: ResultStatus;
  /** Empreinte du contenu que la destination a maintenant (crees, mis a jour, ecrases, deja identiques). */
  readonly sha256?: string;
  /** Empreinte de ce que la destination contenait avant (mis a jour, ecrases) : ce que la sauvegarde restaure. */
  readonly previousSha256?: string;
  readonly failure?: FailureCode;
  /** Pourquoi un fichier n'a pas ete envoye : conflit que l'utilisateur n'a pas decide d'ecraser, ou arret du deploiement. */
  readonly skippedBecause?: "conflict" | "stopped";
}

export interface DeployReport {
  readonly results: readonly FileResult[];
  /** Tous les fichiers sont dans l'etat voulu : aucun echec, aucun arret, aucun conflit laisse de cote. */
  readonly complete: boolean;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

export interface ExecuteOptions {
  /** Ecraser aussi les conflits (apres sauvegarde) : une decision explicite de l'utilisateur. */
  readonly overwriteConflicts: boolean;
  readonly now: () => number;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

const failed = (path: string, failure: FailureCode): FileResult => ({ path, status: "failed", failure });

/** Envoie un fichier : relit les deux cotes, sauvegarde ce qui sera remplace, ecrit sous precondition, relit et compare. */
async function transfer(action: PlanAction, io: DeployIo): Promise<FileResult> {
  const bytes = await io.readLocal(action.path).catch(() => null);
  if (bytes === null) return failed(action.path, "read-failed");
  if ((await io.sha256(bytes)) !== action.sha256) return failed(action.path, "local-changed");

  let precondition: RemotePrecondition = { kind: "mustNotExist" };
  let previousSha256: string | undefined;
  if (action.remote !== null) {
    const current = await io.readRemote(action.path).catch(() => null);
    if (current === null || (await io.sha256(current)) !== action.remote.sha256) return failed(action.path, "remote-changed");
    try {
      await io.saveBackup(action.path, current);
    } catch {
      return failed(action.path, "backup-failed");
    }
    previousSha256 = action.remote.sha256;
    precondition = { kind: "mustMatch", sha256: action.remote.sha256 };
  }
  try {
    await io.writeRemote(action.path, bytes, precondition);
  } catch {
    return failed(action.path, "write-failed");
  }
  const written = await io.readRemote(action.path).catch(() => null);
  if (written === null || (await io.sha256(written)) !== action.sha256) return failed(action.path, "verify-failed");
  const status = action.remote === null ? "created" : action.kind === "conflict" ? "overwritten" : "updated";
  return previousSha256 === undefined ? { path: action.path, status, sha256: action.sha256 } : { path: action.path, status, sha256: action.sha256, previousSha256 };
}

/**
 * Execute un plan que l'utilisateur a confirme. Fichier par fichier, dans l'ordre du plan : le premier echec arrete le deploiement (les
 * fichiers suivants sont laisses de cote, jamais envoyes a moitie). Un conflit n'est ecrase que si `overwriteConflicts` ; un fichier deja
 * identique n'est pas retransfere. Rien n'est ecrit sans que ce qui sera remplace ait ete sauvegarde.
 */
export async function executeDeploy(plan: DeployPlan, io: DeployIo, options: ExecuteOptions): Promise<DeployReport> {
  const startedAtMs = options.now();
  const results: FileResult[] = [];
  let stopped = false;
  const total = plan.actions.length;
  for (const action of plan.actions) {
    if (action.kind === "unchanged") {
      results.push({ path: action.path, status: "unchanged", sha256: action.sha256 });
    } else if (action.kind === "conflict" && !options.overwriteConflicts) {
      results.push({ path: action.path, status: "skipped", skippedBecause: "conflict" });
    } else if (stopped || options.signal?.aborted === true) {
      stopped = true;
      results.push({ path: action.path, status: "skipped", skippedBecause: "stopped" });
    } else {
      const result = await transfer(action, io);
      if (result.status === "failed") stopped = true;
      results.push(result);
    }
    options.onProgress?.(results.length, total);
  }
  const complete = results.every((result) => result.status !== "failed" && result.status !== "skipped");
  return { results, complete, startedAtMs, finishedAtMs: options.now() };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Restauration
// ---------------------------------------------------------------------------------------------------------------------------

export interface RollbackIo {
  /** Version sauvegardee par ce deploiement, ou `null` si elle a disparu. */
  readBackup(path: string): Promise<Uint8Array | null>;
  readRemote(path: string): Promise<Uint8Array | null>;
  writeRemote(path: string, bytes: Uint8Array, precondition: RemotePrecondition): Promise<void>;
  sha256(bytes: Uint8Array): Promise<string>;
}

export type RollbackFailure =
  | "backup-missing"
  /** Le fichier de la destination n'est plus celui que ce deploiement y a ecrit : quelqu'un l'a modifie depuis, on n'ecrase pas son travail. */
  | "changed-since-deploy"
  | "write-failed"
  | "verify-failed";

export interface RollbackReport {
  readonly restored: readonly string[];
  readonly failed: readonly { readonly path: string; readonly failure: RollbackFailure }[];
  /** Fichiers que le deploiement a crees : ils restent en place (aucune suppression automatique), a retirer a la main si besoin. */
  readonly leftInPlace: readonly string[];
}

/**
 * Remet en place les versions sauvegardees des fichiers que ce deploiement a mis a jour ou ecrases — a condition que la destination soit
 * encore telle que le deploiement l'a laissee. Les fichiers crees ne sont pas supprimes.
 */
export async function rollbackDeploy(report: DeployReport, io: RollbackIo): Promise<RollbackReport> {
  const restored: string[] = [];
  const problems: { path: string; failure: RollbackFailure }[] = [];
  const leftInPlace: string[] = [];
  for (const result of report.results) {
    if (result.status === "created") {
      leftInPlace.push(result.path);
      continue;
    }
    if ((result.status !== "updated" && result.status !== "overwritten") || result.sha256 === undefined || result.previousSha256 === undefined) continue;
    const backup = await io.readBackup(result.path).catch(() => null);
    if (backup === null || (await io.sha256(backup)) !== result.previousSha256) {
      problems.push({ path: result.path, failure: "backup-missing" });
      continue;
    }
    const current = await io.readRemote(result.path).catch(() => null);
    if (current === null || (await io.sha256(current)) !== result.sha256) {
      problems.push({ path: result.path, failure: "changed-since-deploy" });
      continue;
    }
    try {
      await io.writeRemote(result.path, backup, { kind: "mustMatch", sha256: result.sha256 });
    } catch {
      problems.push({ path: result.path, failure: "write-failed" });
      continue;
    }
    const after = await io.readRemote(result.path).catch(() => null);
    if (after === null || (await io.sha256(after)) !== result.previousSha256) problems.push({ path: result.path, failure: "verify-failed" });
    else restored.push(result.path);
  }
  return { restored, failed: problems, leftInPlace };
}
