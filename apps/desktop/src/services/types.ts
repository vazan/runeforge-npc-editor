/**
 * Types du contrat IPC avec le coeur Rust. Ils reflettent exactement les structures serialisees par
 * `crates/filesystem` et `apps/desktop/src-tauri/src/commands.rs` (champs en camelCase).
 */

export interface ApprovedRoot {
  /** Identifiant opaque de la racine approuvee (cle de toutes les operations de fichiers). */
  readonly id: string;
  /** Chemin affichable, jamais reutilise comme argument d'operation. */
  readonly displayPath: string;
}

export interface FileStat {
  readonly size: number;
  readonly modifiedMs: number;
  readonly sha256: string;
  readonly readonly: boolean;
}

export type EntryKind = "file" | "directory";

export interface ScanEntry {
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly modifiedMs: number;
}

export type SkipReason = "symlink" | "unreadable" | "non_utf8_name" | "too_deep";

export interface SkippedEntry {
  readonly path: string;
  readonly reason: SkipReason;
}

export interface ScanResult {
  readonly entries: readonly ScanEntry[];
  readonly skipped: readonly SkippedEntry[];
  readonly truncated: boolean;
}

export interface ScanOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

export type Precondition =
  | { readonly kind: "overwrite" }
  | { readonly kind: "mustNotExist" }
  | { readonly kind: "mustMatch"; readonly sha256: string };

export interface WriteOutcome {
  readonly stat: FileStat;
  readonly created: boolean;
  readonly historySaved: boolean;
}

export interface RecentProject {
  readonly path: string;
  readonly name: string;
  readonly lastOpenedMs: number;
}

export interface RecoveryEntry {
  readonly relative: string;
  readonly savedAtMs: number;
  readonly size: number;
  readonly baseSha256: string | null;
}

export interface RecoveryMeta {
  readonly version: number;
  readonly relative: string;
  readonly savedAtMs: number;
  readonly baseSha256: string | null;
  readonly encoding: string | null;
}

export interface HistoryEntry {
  readonly id: string;
  readonly savedAtMs: number;
  readonly size: number;
}

/** Un fichier dont l'etat Git differe de `HEAD`. */
export interface GitEntry {
  /** Chemin relatif au projet, avec des `/`. */
  readonly path: string;
  /** Etat dans l'index : `M` modifie, `A` ajoute, `D` supprime, `T` type change, `R` renomme, `U` conflit, `.` inchange, `?` non suivi. */
  readonly x: string;
  /** Etat dans le dossier de travail (memes lettres). */
  readonly y: string;
}

/** Etat Git d'un projet (lecture seule), tel que le coeur natif le rend. */
export interface GitStatus {
  /** Branche courante ; `null` en `HEAD` detache. */
  readonly branch: string | null;
  readonly detached: boolean;
  /** Aucun commit n'existe encore. */
  readonly unborn: boolean;
  /** Debut de l'identifiant du commit de `HEAD`. */
  readonly head: string | null;
  readonly entries: readonly GitEntry[];
  /** La liste a ete coupee (trop de fichiers). */
  readonly truncated: boolean;
}

/**
 * Resultat d'un controle de mise a jour (DEC-046), tel que le coeur natif le rend : tout vient du manifeste signe par l'editeur, la
 * page ne decide de rien. `notes` est du texte brut (jamais du HTML) ; `size` est la taille de l'executable, en octets.
 */
export type UpdateCheckResult =
  | { readonly kind: "upToDate"; readonly current: string }
  | {
      readonly kind: "available";
      readonly current: string;
      readonly version: string;
      readonly channel: "stable" | "beta";
      readonly notes: string;
      readonly publishedAt: string;
      readonly size: number;
    };

/** Avancement du telechargement d'une mise a jour : octets recus sur octets annonces par le manifeste signe. */
export interface UpdateProgress {
  readonly received: number;
  readonly total: number;
}

/** Codes d'erreur des mises a jour (`UpdateError::code` du coeur natif) ; tout autre code est traite comme `failed`. */
export const UPDATE_ERROR_CODES = [
  "not_configured",
  "invalid_repository",
  "invalid_channel",
  "invalid_token",
  "repository_not_found",
  "unauthorized",
  "rate_limited",
  "network",
  "bad_response",
  "bad_manifest",
  "bad_signature",
  "unsupported_schema",
  "no_platform_asset",
  "manual_update_required",
  "too_large",
  "hash_mismatch",
  "not_executable",
  "unsafe_redirect",
  "insecure_url",
  "no_pending_update",
  "unsaved_changes",
  "unsupported_platform",
  "not_writable",
  "install_failed",
  "io",
] as const;

export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly e2e: boolean;
}

/** Erreur structuree du coeur Rust : `{ code, ... }` (voir `FsError`). */
export interface BackendErrorPayload {
  readonly code: string;
  readonly message?: string;
  readonly reason?: string;
  readonly current?: FileStat;
  readonly size?: number;
  readonly limit?: number;
  /** `manual_update_required` : la version minimale a partir de laquelle une mise a jour automatique est possible. */
  readonly minimum?: string;
}

export class BackendError extends Error {
  readonly code: string;
  readonly payload: BackendErrorPayload;

  constructor(payload: BackendErrorPayload) {
    super(payload.message ?? payload.reason ?? payload.code);
    this.name = "BackendError";
    this.code = payload.code;
    this.payload = payload;
  }
}

/** Convertit une valeur rejetee par `invoke` (objet serialise, texte ou Error) en `BackendError`. */
export function toBackendError(value: unknown): BackendError {
  if (value instanceof BackendError) return value;
  if (typeof value === "object" && value !== null && "code" in value && typeof (value as { code: unknown }).code === "string") {
    return new BackendError(value as BackendErrorPayload);
  }
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "unknown error";
  return new BackendError({ code: "unknown", message });
}

export type ReadFileResult =
  | { readonly path: string; readonly ok: true; readonly bytes: Uint8Array; readonly stat: FileStat }
  | { readonly path: string; readonly ok: false; readonly error: BackendError };
