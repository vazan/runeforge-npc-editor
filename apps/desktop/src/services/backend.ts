import { decodeFrames } from "./frames";
import {
  BackendError,
  toBackendError,
  type AppInfo,
  type ApprovedRoot,
  type FileStat,
  type GitStatus,
  type HistoryEntry,
  type Precondition,
  type ReadFileResult,
  type RecentProject,
  type RecoveryEntry,
  type RecoveryMeta,
  type ScanOptions,
  type ScanResult,
  type UpdateCheckResult,
  type UpdateProgress,
  type WriteOutcome,
} from "./types";

/**
 * Acces au coeur Rust. L'interface est l'unique frontiere entre l'interface React et les operations privilegiees
 * (fichiers, boites de dialogue, configuration) : tout le reste de l'application reste testable sans Tauri.
 */
export interface BackendApi {
  appInfo(): Promise<AppInfo>;
  pickProjectFolder(): Promise<ApprovedRoot | null>;
  /** Choisit (boite de dialogue du systeme) la destination d'un deploiement : une racine approuvee a part, absente des projets recents. */
  pickDestinationFolder(): Promise<ApprovedRoot | null>;
  listRecentProjects(): Promise<RecentProject[]>;
  openRecentProject(path: string): Promise<ApprovedRoot>;
  forgetRecentProject(path: string): Promise<void>;
  scanProject(rootId: string, options?: ScanOptions): Promise<ScanResult>;
  /** Lit des fichiers (par lots) ; un echec de lecture n'interrompt pas les autres. */
  readFiles(rootId: string, paths: readonly string[], maxBytes?: number): Promise<ReadFileResult[]>;
  writeFile(rootId: string, path: string, data: Uint8Array, precondition: Precondition, keepHistory?: boolean): Promise<WriteOutcome>;
  createDirectory(rootId: string, path: string): Promise<boolean>;
  recoverySave(rootId: string, path: string, data: Uint8Array, meta: { baseSha256?: string | null; encoding?: string | null }): Promise<void>;
  recoveryList(rootId: string): Promise<RecoveryEntry[]>;
  recoveryRead(rootId: string, path: string): Promise<{ meta: RecoveryMeta; data: Uint8Array }>;
  recoveryClear(rootId: string, path: string): Promise<void>;
  historyList(rootId: string, path: string): Promise<HistoryEntry[]>;
  historyRead(rootId: string, path: string, id: string): Promise<Uint8Array>;
  configGet(name: "settings" | "session" | "layout"): Promise<string | null>;
  configSet(name: "settings" | "session" | "layout", json: string): Promise<void>;
  setDirty(dirty: boolean): Promise<void>;
  confirmExit(): Promise<void>;
  /** Appele quand l'utilisateur ferme la fenetre alors que des modifications ne sont pas enregistrees. */
  onCloseRequested(handler: () => void): Promise<() => void>;
  /** Projet pre-approuve d'une construction de test E2E (toujours `null` en production). */
  e2eProject(): Promise<ApprovedRoot | null>;
  /**
   * Ajoute un evenement au journal de diagnostic local ; le coeur natif n'ecrit que si l'utilisateur l'a active (`false` sinon) et
   * refuse tout code ou detail qui ressemblerait a un chemin ou a du code : codes en majuscules, details `cle=valeur` seulement.
   */
  logEvent(level: "info" | "warn" | "error", code: string, detail: string): Promise<boolean>;
  /**
   * Etat Git du projet, en lecture seule (le coeur natif lance le programme `git` de la machine). `grantTrust` : l'utilisateur vient
   * d'autoriser Git pour ce projet ; sans cela un projet non autorise est refuse (`not_trusted`). Autres erreurs : `git_unavailable`,
   * `not_a_repository`, `unsafe_repository`, `timeout`, `too_large`, `failed`.
   */
  gitStatus(rootId: string, grantTrust: boolean): Promise<GitStatus>;
  /** Contenu, dans `HEAD`, d'un fichier du projet ; rejette avec `not_in_head` pour un fichier neuf. */
  gitHeadFile(rootId: string, path: string): Promise<Uint8Array>;
  /**
   * Cherche une mise a jour dans les releases du depot (DEC-046) : le coeur natif contacte GitHub, verifie la signature du manifeste
   * avec la cle publique de l'application et ne rend que ce que ce manifeste decrit. N'ecrit rien sur le disque. `token` : jeton
   * d'acces en lecture d'un depot prive (jamais enregistre, joint aux seules requetes a l'API de GitHub). Erreurs : `UpdateErrorCode`.
   */
  updateCheck(request: { repository: string; channel: "stable" | "beta"; token: string | null }): Promise<UpdateCheckResult>;
  /**
   * Telecharge, verifie puis installe la mise a jour du dernier controle, apres l'accord de l'utilisateur dans une boite de dialogue
   * du systeme ; en cas de succes l'application redemarre (la promesse ne se resout alors pas). Refuse tant que des modifications ne
   * sont pas enregistrees.
   */
  updateInstall(request: { token: string | null; locale: "fr" | "en" }): Promise<void>;
  /** Avancement du telechargement d'une mise a jour. */
  onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<() => void>;
}

export interface TauriBindings {
  invoke<T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/** Nombre maximal de fichiers lus par appel IPC (le coeur Rust en accepte davantage ; on borne la memoire par lot). */
const READ_BATCH = 256;
const CLOSE_REQUESTED_EVENT = "runeforge://close-requested";
const UPDATE_PROGRESS_EVENT = "runeforge://update-progress";

/** Lit le contenu d'un evenement d'avancement ; tout ce qui n'est pas deux nombres finis positifs est ignore. */
function toUpdateProgress(payload: unknown): UpdateProgress | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { received, total } = payload as { received?: unknown; total?: unknown };
  if (typeof received !== "number" || typeof total !== "number" || !Number.isFinite(received) || !Number.isFinite(total) || received < 0 || total <= 0) return null;
  return { received: Math.min(received, total), total };
}

interface ReadFrameMeta {
  readonly path: string;
  readonly ok: boolean;
  readonly stat?: FileStat;
  readonly error?: BackendError["payload"];
}

function metaHeader(meta: unknown): Record<string, string> {
  // Les valeurs d'en-tete HTTP sont ASCII : le JSON est encode comme `encodeURIComponent` (decode cote Rust).
  return { "x-rf-meta": encodeURIComponent(JSON.stringify(meta)) };
}

export function createTauriBackend(tauri: TauriBindings): BackendApi {
  const call = async <T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> => {
    try {
      return await tauri.invoke<T>(command, args, options);
    } catch (error) {
      throw toBackendError(error);
    }
  };

  return {
    appInfo: () => call<AppInfo>("app_info"),
    pickProjectFolder: () => call<ApprovedRoot | null>("pick_project_folder"),
    pickDestinationFolder: () => call<ApprovedRoot | null>("pick_destination_folder"),
    listRecentProjects: () => call<RecentProject[]>("list_recent_projects"),
    openRecentProject: (path) => call<ApprovedRoot>("open_recent_project", { path }),
    forgetRecentProject: (path) => call<void>("forget_recent_project", { path }),
    scanProject: (rootId, options) => call<ScanResult>("scan_project", { rootId, options: options ?? null }),

    async readFiles(rootId, paths, maxBytes) {
      const results: ReadFileResult[] = [];
      for (let start = 0; start < paths.length; start += READ_BATCH) {
        const chunk = paths.slice(start, start + READ_BATCH);
        const buffer = await call<ArrayBuffer>("read_files", { rootId, paths: chunk, maxBytes: maxBytes ?? null });
        const frames = decodeFrames<ReadFrameMeta>(buffer);
        if (frames.length !== chunk.length) {
          throw new BackendError({ code: "protocol", message: "unexpected number of frames" });
        }
        frames.forEach((frame, index) => {
          const path = chunk[index] ?? frame.meta.path;
          if (frame.meta.ok && frame.meta.stat !== undefined) {
            results.push({ path, ok: true, bytes: frame.data, stat: frame.meta.stat });
          } else {
            results.push({ path, ok: false, error: new BackendError(frame.meta.error ?? { code: "unknown" }) });
          }
        });
      }
      return results;
    },

    writeFile: (rootId, path, data, precondition, keepHistory = true) =>
      call<WriteOutcome>("write_file", data, { headers: metaHeader({ rootId, path, precondition, keepHistory }) }),
    createDirectory: (rootId, path) => call<boolean>("create_directory", { rootId, path }),

    recoverySave: (rootId, path, data, meta) =>
      call<void>("recovery_save", data, {
        headers: metaHeader({ rootId, path, baseSha256: meta.baseSha256 ?? null, encoding: meta.encoding ?? null }),
      }),
    recoveryList: (rootId) => call<RecoveryEntry[]>("recovery_list", { rootId }),
    async recoveryRead(rootId, path) {
      const buffer = await call<ArrayBuffer>("recovery_read", { rootId, path });
      const [frame] = decodeFrames<{ recovery: RecoveryMeta }>(buffer);
      if (frame === undefined) throw new BackendError({ code: "protocol", message: "empty recovery frame" });
      return { meta: frame.meta.recovery, data: frame.data };
    },
    recoveryClear: (rootId, path) => call<void>("recovery_clear", { rootId, path }),

    historyList: (rootId, path) => call<HistoryEntry[]>("history_list", { rootId, path }),
    async historyRead(rootId, path, id) {
      const buffer = await call<ArrayBuffer>("history_read", { rootId, path, id });
      const [frame] = decodeFrames(buffer);
      if (frame === undefined) throw new BackendError({ code: "protocol", message: "empty history frame" });
      return frame.data;
    },

    configGet: (name) => call<string | null>("config_get", { name }),
    configSet: (name, json) => call<void>("config_set", { name, json }),
    setDirty: (dirty) => call<void>("set_dirty", { dirty }),
    confirmExit: () => call<void>("confirm_exit"),
    onCloseRequested: (handler) => tauri.listen(CLOSE_REQUESTED_EVENT, () => handler()),
    e2eProject: () => call<ApprovedRoot | null>("e2e_project"),
    logEvent: (level, code, detail) => call<boolean>("log_event", { level, code, detail }),
    gitStatus: (rootId, grantTrust) => call<GitStatus>("git_status", { rootId, grantTrust }),
    async gitHeadFile(rootId, path) {
      const buffer = await call<ArrayBuffer>("git_head_file", { rootId, path });
      const [frame] = decodeFrames(buffer);
      if (frame === undefined) throw new BackendError({ code: "protocol", message: "empty git frame" });
      return frame.data;
    },
    updateCheck: (request) => call<UpdateCheckResult>("update_check", { request }),
    updateInstall: (request) => call<void>("update_install", { request }),
    onUpdateProgress: (handler) =>
      tauri.listen(UPDATE_PROGRESS_EVENT, (payload) => {
        const progress = toUpdateProgress(payload);
        if (progress !== null) handler(progress);
      }),
  };
}

/** Vrai si la page s'execute dans la fenetre Tauri (et non dans un navigateur ordinaire). */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Backend reel : charge les API Tauri a la demande pour ne pas les exiger hors de la fenetre native. */
export async function createDefaultBackend(): Promise<BackendApi> {
  const [core, event] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  return createTauriBackend({
    invoke: (command, args, options) => {
      const payload = args as Record<string, unknown> | Uint8Array | undefined;
      return options?.headers === undefined ? core.invoke(command, payload) : core.invoke(command, payload, { headers: options.headers });
    },
    listen: async (name, handler) => event.listen(name, (message) => handler(message.payload)),
  });
}
