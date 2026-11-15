/**
 * Doublure de test du coeur Rust : un systeme de fichiers en memoire qui reproduit la semantique de
 * `crates/filesystem` (preconditions d'ecriture, modification externe, lecture seule, recuperation, historique).
 * N'est importee que par les tests.
 */
import type { BackendApi } from "../services/backend";
import {
  BackendError,
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
  type UpdateErrorCode,
  type UpdateProgress,
  type WriteOutcome,
} from "../services/types";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface StoredFile {
  bytes: Uint8Array;
  modifiedMs: number;
  readonly: boolean;
}

const toBytes = (value: string | Uint8Array): Uint8Array => (typeof value === "string" ? new TextEncoder().encode(value) : value);

/** Motif glob minimal (`**`, `*`, `?`) converti en expression reguliere ; suffit aux motifs de `sources` des tests. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === "*") {
      if (glob.charAt(i + 1) === "*") {
        i += 1;
        if (glob.charAt(i + 1) === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export class FakeBackend implements BackendApi {
  readonly root: ApprovedRoot = { id: "fakeroot", displayPath: "C:\\fake\\project" };
  readonly files = new Map<string, StoredFile>();
  readonly directories = new Set<string>();
  readonly recovery = new Map<string, { meta: RecoveryMeta; data: Uint8Array }>();
  readonly history = new Map<string, { entry: HistoryEntry; data: Uint8Array }[]>();
  recents: RecentProject[] = [];
  readonly configs = new Map<string, string>();
  dirtyFlag = false;
  exitConfirmed = false;
  pickResult: ApprovedRoot | null = this.root;
  e2e: ApprovedRoot | null = null;
  closeHandler: (() => void) | null = null;
  readonly writes: { path: string; precondition: Precondition }[] = [];
  readCount = 0;
  clock = 1_700_000_000_000;
  /** Appele pendant une ecriture (apres la lecture du contenu a ecrire, avant la fin) pour simuler une frappe concurrente. */
  duringWrite: (() => void) | null = null;

  /** Cree ou remplace un fichier comme le ferait l'utilisateur en dehors de l'application. */
  put(path: string, content: string | Uint8Array, options: { readonly?: boolean } = {}): void {
    this.clock += 1000;
    this.files.set(path, { bytes: toBytes(content), modifiedMs: this.clock, readonly: options.readonly ?? false });
  }

  /** Contenu d'un fichier (pour les assertions). */
  bytesOf(path: string): Uint8Array | undefined {
    return this.files.get(path)?.bytes;
  }

  textOf(path: string): string | undefined {
    const bytes = this.bytesOf(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  private async statOf(file: StoredFile): Promise<FileStat> {
    return { size: file.bytes.length, modifiedMs: file.modifiedMs, sha256: await sha256(file.bytes), readonly: file.readonly };
  }

  /** Le systeme que declare le coeur natif (`windows` : l'installation automatique des mises a jour est disponible). */
  platform = "test";

  async appInfo(): Promise<AppInfo> {
    return { name: "runeforge-studio", version: "0.0.0-test", platform: this.platform, e2e: false };
  }

  async pickProjectFolder(): Promise<ApprovedRoot | null> {
    return this.pickResult;
  }

  /** La destination d'un deploiement : un second faux disque (`null` : l'utilisateur annule la boite de dialogue). */
  destination: { root: ApprovedRoot; disk: FakeBackend } | null = null;
  destinationPicks = 0;

  async pickDestinationFolder(): Promise<ApprovedRoot | null> {
    this.destinationPicks += 1;
    return this.destination?.root ?? null;
  }

  /** Le disque qui repond pour cette racine : la destination si c'est elle, sinon ce faux disque. */
  private diskFor(rootId: string): FakeBackend {
    return this.destination !== null && rootId === this.destination.root.id ? this.destination.disk : this;
  }

  async listRecentProjects(): Promise<RecentProject[]> {
    return this.recents;
  }

  async openRecentProject(path: string): Promise<ApprovedRoot> {
    if (!this.recents.some((project) => project.path === path)) throw new BackendError({ code: "unknown_root" });
    return this.root;
  }

  async forgetRecentProject(path: string): Promise<void> {
    this.recents = this.recents.filter((project) => project.path !== path);
  }

  /** Options recues par chaque parcours du projet (pour verifier ce que demande le controleur). */
  readonly scans: ScanOptions[] = [];

  async scanProject(_rootId: string, options?: ScanOptions): Promise<ScanResult> {
    this.scans.push(options ?? {});
    // `include` filtre les fichiers (comme le coeur Rust) ; `exclude` n'est pas applique par cette doublure.
    const include = (options?.include ?? []).map(globToRegExp);
    const entries = [
      ...[...this.directories].map((path) => ({ path, kind: "directory" as const, size: 0, modifiedMs: 0 })),
      ...[...this.files.entries()]
        .filter(([path]) => include.length === 0 || include.some((pattern) => pattern.test(path)))
        .map(([path, file]) => ({ path, kind: "file" as const, size: file.bytes.length, modifiedMs: file.modifiedMs })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    return { entries, skipped: [], truncated: false };
  }

  async readFiles(rootId: string, paths: readonly string[], maxBytes?: number): Promise<ReadFileResult[]> {
    const disk = this.diskFor(rootId);
    if (disk !== this) return disk.readFiles(rootId, paths, maxBytes);
    this.readCount += paths.length;
    const results: ReadFileResult[] = [];
    for (const path of paths) {
      const file = this.files.get(path);
      if (file === undefined) {
        results.push({ path, ok: false, error: new BackendError({ code: "not_found" }) });
      } else if (maxBytes !== undefined && file.bytes.length > maxBytes) {
        results.push({ path, ok: false, error: new BackendError({ code: "too_large", size: file.bytes.length, limit: maxBytes }) });
      } else {
        results.push({ path, ok: true, bytes: file.bytes.slice(), stat: await this.statOf(file) });
      }
    }
    return results;
  }

  async writeFile(rootId: string, path: string, data: Uint8Array, precondition: Precondition, keepHistory = true): Promise<WriteOutcome> {
    const disk = this.diskFor(rootId);
    if (disk !== this) return disk.writeFile(rootId, path, data, precondition, keepHistory);
    this.writes.push({ path, precondition });
    if (path.split(/[\\/]/).includes("..")) throw new BackendError({ code: "invalid_path", reason: "relative navigation is not allowed" });
    this.duringWrite?.();
    const existing = this.files.get(path);
    if (precondition.kind === "mustNotExist") {
      if (existing !== undefined) throw new BackendError({ code: "already_exists" });
      this.clock += 1000;
      const file = { bytes: data.slice(), modifiedMs: this.clock, readonly: false };
      this.files.set(path, file);
      return { stat: await this.statOf(file), created: true, historySaved: false };
    }
    if (existing === undefined) {
      if (precondition.kind === "mustMatch") throw new BackendError({ code: "not_found" });
      return this.writeFile(rootId, path, data, { kind: "mustNotExist" }, keepHistory);
    }
    if (existing.readonly) throw new BackendError({ code: "permission_denied" });
    if (precondition.kind === "mustMatch") {
      const current = await this.statOf(existing);
      if (current.sha256 !== precondition.sha256) throw new BackendError({ code: "external_modification", current });
    }
    let historySaved = false;
    if (keepHistory) {
      const list = this.history.get(path) ?? [];
      list.unshift({ entry: { id: `${this.clock}-${list.length}.bak`, savedAtMs: this.clock, size: existing.bytes.length }, data: existing.bytes.slice() });
      this.history.set(path, list);
      historySaved = true;
    }
    this.clock += 1000;
    existing.bytes = data.slice();
    existing.modifiedMs = this.clock;
    return { stat: await this.statOf(existing), created: false, historySaved };
  }

  async createDirectory(rootId: string, path: string): Promise<boolean> {
    const disk = this.diskFor(rootId);
    if (disk !== this) return disk.createDirectory(rootId, path);
    const existed = this.directories.has(path);
    this.directories.add(path);
    return !existed;
  }

  async recoverySave(_rootId: string, path: string, data: Uint8Array, meta: { baseSha256?: string | null; encoding?: string | null }): Promise<void> {
    this.recovery.set(path, {
      meta: { version: 1, relative: path, savedAtMs: this.clock, baseSha256: meta.baseSha256 ?? null, encoding: meta.encoding ?? null },
      data: data.slice(),
    });
  }

  async recoveryList(_rootId: string): Promise<RecoveryEntry[]> {
    return [...this.recovery.values()].map(({ meta, data }) => ({ relative: meta.relative, savedAtMs: meta.savedAtMs, size: data.length, baseSha256: meta.baseSha256 }));
  }

  async recoveryRead(_rootId: string, path: string): Promise<{ meta: RecoveryMeta; data: Uint8Array }> {
    const entry = this.recovery.get(path);
    if (entry === undefined) throw new BackendError({ code: "not_found" });
    return entry;
  }

  async recoveryClear(_rootId: string, path: string): Promise<void> {
    this.recovery.delete(path);
  }

  async historyList(_rootId: string, path: string): Promise<HistoryEntry[]> {
    return (this.history.get(path) ?? []).map((item) => item.entry);
  }

  async historyRead(_rootId: string, path: string, id: string): Promise<Uint8Array> {
    const found = (this.history.get(path) ?? []).find((item) => item.entry.id === id);
    if (found === undefined) throw new BackendError({ code: "not_found" });
    return found.data;
  }

  async configGet(name: string): Promise<string | null> {
    return this.configs.get(name) ?? null;
  }

  async configSet(name: string, json: string): Promise<void> {
    this.configs.set(name, json);
  }

  async setDirty(dirty: boolean): Promise<void> {
    this.dirtyFlag = dirty;
  }

  async confirmExit(): Promise<void> {
    this.exitConfirmed = true;
  }

  async onCloseRequested(handler: () => void): Promise<() => void> {
    this.closeHandler = handler;
    return () => {
      this.closeHandler = null;
    };
  }

  async e2eProject(): Promise<ApprovedRoot | null> {
    return this.e2e;
  }

  /** Evenements journalises (le coeur natif ne les ecrit que si `logging.enabled` est vrai dans les reglages enregistres). */
  readonly logs: { level: string; code: string; detail: string }[] = [];

  async logEvent(level: "info" | "warn" | "error", code: string, detail: string): Promise<boolean> {
    const settings = this.configs.get("settings");
    const enabled = (settings === undefined ? null : (JSON.parse(settings) as { logging?: { enabled?: unknown } }).logging?.enabled) === true;
    if (!enabled) return false;
    this.logs.push({ level, code, detail });
    return true;
  }

  // ---- Git (lecture seule, apres consentement) : un faux depot que les tests remplissent ----

  /** Racines pour lesquelles l'utilisateur a autorise Git. */
  readonly gitTrusted = new Set<string>();
  /** Le depot du projet ; `null` : le dossier n'est pas dans un depot Git. */
  gitRepository: { status: GitStatus; heads: Map<string, string | Uint8Array> } | null = null;
  /** Code d'erreur a renvoyer a la place de la reponse (`git_unavailable`, `timeout`...). */
  gitFailure: string | null = null;
  readonly gitCalls: { kind: "status" | "head"; grantTrust?: boolean; path?: string }[] = [];

  async gitStatus(rootId: string, grantTrust: boolean): Promise<GitStatus> {
    this.gitCalls.push({ kind: "status", grantTrust });
    if (this.gitFailure !== null) throw new BackendError({ code: this.gitFailure });
    if (!this.gitTrusted.has(rootId)) {
      if (!grantTrust) throw new BackendError({ code: "not_trusted" });
      this.gitTrusted.add(rootId);
    }
    if (this.gitRepository === null) throw new BackendError({ code: "not_a_repository" });
    return this.gitRepository.status;
  }

  async gitHeadFile(rootId: string, path: string): Promise<Uint8Array> {
    this.gitCalls.push({ kind: "head", path });
    if (this.gitFailure !== null) throw new BackendError({ code: this.gitFailure });
    if (!this.gitTrusted.has(rootId)) throw new BackendError({ code: "not_trusted" });
    if (this.gitRepository === null) throw new BackendError({ code: "not_a_repository" });
    const head = this.gitRepository.heads.get(path);
    if (head === undefined) throw new BackendError({ code: "not_in_head" });
    return toBytes(head);
  }

  // ---- Mises a jour (DEC-046) : un faux depot de releases que les tests scriptent ----

  /** Ce que repond le prochain controle : un resultat, ou le code de l'erreur a lever. */
  updateCheckReply: UpdateCheckResult | { readonly error: UpdateErrorCode; readonly minimum?: string } = { kind: "upToDate", current: "0.0.0-test" };
  /** Ce que repond l'installation : `installed` (le coeur natif redemarre l'application), `cancelled` (refus dans la boite de dialogue du systeme) ou une erreur. */
  updateInstallReply: "installed" | "cancelled" | { readonly error: UpdateErrorCode; readonly reason?: string } = "installed";
  /** Avancement emis pendant l'installation, avant sa reponse. */
  updateProgressScript: UpdateProgress[] = [];
  readonly updateChecks: { repository: string; channel: string; token: string | null }[] = [];
  readonly updateInstalls: { token: string | null; locale: string }[] = [];
  private updateProgressHandlers = new Set<(progress: UpdateProgress) => void>();
  /** Vrai apres un controle qui a trouve une mise a jour : le coeur natif n'installe que celle du dernier controle. */
  private updatePending = false;
  /** Rend la main a l'installation au moment voulu (pour observer l'etat « en cours »). */
  updateInstallGate: Promise<void> | null = null;

  async updateCheck(request: { repository: string; channel: "stable" | "beta"; token: string | null }): Promise<UpdateCheckResult> {
    this.updateChecks.push({ ...request });
    this.updatePending = false;
    const reply = this.updateCheckReply;
    if ("error" in reply) throw new BackendError({ code: reply.error, ...(reply.minimum === undefined ? {} : { minimum: reply.minimum }) });
    this.updatePending = reply.kind === "available";
    return reply;
  }

  async updateInstall(request: { token: string | null; locale: "fr" | "en" }): Promise<void> {
    this.updateInstalls.push({ ...request });
    if (this.dirtyFlag) throw new BackendError({ code: "unsaved_changes" });
    if (!this.updatePending) throw new BackendError({ code: "no_pending_update" });
    for (const progress of this.updateProgressScript) for (const handler of this.updateProgressHandlers) handler(progress);
    if (this.updateInstallGate !== null) await this.updateInstallGate;
    const reply = this.updateInstallReply;
    if (reply === "cancelled") throw new BackendError({ code: "install_failed", reason: "cancelled" });
    if (reply !== "installed") throw new BackendError({ code: reply.error, ...(reply.reason === undefined ? {} : { reason: reply.reason }) });
    this.updatePending = false;
  }

  async onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<() => void> {
    this.updateProgressHandlers.add(handler);
    return () => {
      this.updateProgressHandlers.delete(handler);
    };
  }

  /** Nombre d'abonnes a l'avancement (doit revenir a zero apres une installation). */
  get updateProgressSubscribers(): number {
    return this.updateProgressHandlers.size;
  }
}
