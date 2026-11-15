import type { MessageKey } from "../i18n/messages";
import { UPDATE_ERROR_CODES } from "../services/types";
import type { UpdateFailure, UpdateFailureCode } from "../state/store";

/**
 * Textes et petites regles des mises a jour (DEC-046). Partie pure : l'interface n'y met que de l'affichage.
 */

export const UPDATE_ERROR_MESSAGE: Readonly<Record<UpdateFailureCode, MessageKey>> = {
  not_configured: "update.error.not_configured",
  invalid_repository: "update.error.invalid_repository",
  invalid_channel: "update.error.invalid_channel",
  invalid_token: "update.error.invalid_token",
  repository_not_found: "update.error.repository_not_found",
  unauthorized: "update.error.unauthorized",
  rate_limited: "update.error.rate_limited",
  network: "update.error.network",
  bad_response: "update.error.bad_response",
  bad_manifest: "update.error.bad_manifest",
  bad_signature: "update.error.bad_signature",
  unsupported_schema: "update.error.unsupported_schema",
  no_platform_asset: "update.error.no_platform_asset",
  manual_update_required: "update.error.manual_update_required",
  too_large: "update.error.too_large",
  hash_mismatch: "update.error.hash_mismatch",
  not_executable: "update.error.not_executable",
  unsafe_redirect: "update.error.unsafe_redirect",
  insecure_url: "update.error.insecure_url",
  no_pending_update: "update.error.no_pending_update",
  unsaved_changes: "update.error.unsaved_changes",
  unsupported_platform: "update.error.unsupported_platform",
  not_writable: "update.error.not_writable",
  install_failed: "update.error.install_failed",
  io: "update.error.io",
  failed: "update.error.failed",
};

/** Un code du coeur natif que la page sait expliquer ; tout autre devient `failed`. */
export function updateFailureCode(code: string): UpdateFailureCode {
  return (UPDATE_ERROR_CODES as readonly string[]).includes(code) ? (code as UpdateFailureCode) : "failed";
}

/**
 * Le texte d'un echec. Le seul detail d'installation montre a l'utilisateur est celui qui lui demande d'agir : l'ancienne version n'a
 * pas pu etre remise en place automatiquement (`replace_kept_backup`).
 */
export function updateFailureText(failure: UpdateFailure): { readonly key: MessageKey; readonly params: Readonly<Record<string, string>> } {
  if (failure.code === "install_failed" && failure.reason === "replace_kept_backup") return { key: "update.error.install_failed.kept_backup", params: {} };
  return { key: UPDATE_ERROR_MESSAGE[failure.code], params: { minimum: failure.minimum ?? "?" } };
}

/** Le code que le journal de diagnostic local accepte pour cet echec (`UPDATE_CODES` du coeur natif). */
export const updateLogCode = (code: UpdateFailureCode): string => (code === "failed" ? "unknown" : code);

/**
 * Systemes (`AppInfo.platform`, le `std::env::consts::OS` du coeur natif) ou l'application sait se remplacer elle-meme : Windows par
 * renommages, Linux par un remplacement atomique (`supports_install` de `crates/updater`).
 */
export const SELF_UPDATE_PLATFORMS: readonly string[] = ["windows", "linux"];

export const canInstallOn = (platform: string): boolean => SELF_UPDATE_PLATFORMS.includes(platform);

/** Jeton d'acces GitHub : lettres, chiffres, `_` et `-`, sans espace ni saut de ligne (memes regles que le coeur natif). */
export const isUpdateToken = (value: string): boolean => /^[A-Za-z0-9_-]{1,255}$/.test(value);

export function updateProgressPercent(received: number, total: number): number {
  return total <= 0 ? 0 : Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}

/** Taille d'un executable en Mio, avec une decimale. */
export function formatMebibytes(bytes: number, language: "fr" | "en"): string {
  return new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / (1024 * 1024));
}

/** Date de publication (`2026-11-15T10:00:00Z` donne `2026-11-15`). */
export const releaseDate = (publishedAt: string): string => publishedAt.slice(0, 10);
