import { detectEol, normalizeToLf, type EndOfLine } from "@runeforge/runescript-core";
import {
  decodeDocument,
  encodeDocument,
  restoreEol,
  type DocumentWarning,
  type UnencodableCharacter,
  type UnsupportedDocument,
} from "@runeforge/project-core";
import type { BackendApi } from "../services/backend";
import { BackendError, toBackendError, type FileStat, type RecoveryMeta } from "../services/types";

/** Taille maximale ouverte dans l'editeur (alignee sur la limite du coeur Rust). */
export const MAX_OPEN_BYTES = 20 * 1024 * 1024;

/** Contenu textuel d'un document ouvert, normalise en `\n` (l'adaptateur Monaco en est l'implementation reelle). */
export interface TextBuffer {
  getText(): string;
  setText(text: string): void;
  dispose?(): void;
}

export type ExternalState = "none" | "modified" | "deleted";

/** Vue immuable d'un document, destinee a l'interface. */
export interface DocumentInfo {
  readonly path: string;
  readonly encoding: string;
  readonly bom: boolean;
  readonly eol: EndOfLine;
  readonly warnings: readonly DocumentWarning[];
  readonly dirty: boolean;
  readonly external: ExternalState;
  readonly stat: FileStat;
}

export type OpenOutcome =
  | { readonly ok: true; readonly info: DocumentInfo; readonly alreadyOpen: boolean }
  | { readonly ok: false; readonly reason: "unsupported"; readonly detail: UnsupportedDocument["reason"] }
  | { readonly ok: false; readonly reason: "error"; readonly error: BackendError };

export type SaveOutcome =
  | { readonly status: "saved"; readonly stat: FileStat; readonly historySaved: boolean }
  | { readonly status: "unchanged" }
  | { readonly status: "unencodable"; readonly unencodable: readonly UnencodableCharacter[] }
  | { readonly status: "conflict"; readonly current: FileStat | undefined }
  | { readonly status: "deleted" }
  | { readonly status: "error"; readonly error: BackendError };

export type ExternalChange =
  | { readonly path: string; readonly action: "reloaded" }
  | { readonly path: string; readonly action: "conflict" }
  | { readonly path: string; readonly action: "deleted" };

export type DocumentEvent =
  | { readonly type: "changed"; readonly path: string }
  | { readonly type: "closed"; readonly path: string };

export interface DocumentManagerOptions {
  readonly backend: BackendApi;
  readonly rootId: string;
  /** Cree le tampon de texte (Monaco en production) avec le contenu initial normalise en `\n`. */
  readonly createBuffer: (initialText: string, path: string) => TextBuffer;
  readonly legacyEncoding: () => string;
  /** Delai avant l'ecriture d'un instantane de recuperation apres la derniere modification. */
  readonly snapshotDelayMs: () => number;
}

interface Entry {
  path: string;
  buffer: TextBuffer;
  /** Dernier texte lu ou enregistre, avec ses fins de ligne reelles (sert a les restituer a l'enregistrement). */
  original: { text: string; eol: EndOfLine };
  encoding: string;
  bom: boolean;
  warnings: DocumentWarning[];
  stat: FileStat;
  /** Texte (LF) correspondant au contenu actuel du disque. */
  savedLf: string;
  /** Vrai si l'encodage a ete change explicitement : le fichier doit etre reecrit meme si le texte est identique. */
  encodingChanged: boolean;
  external: ExternalState;
  snapshotTimer: ReturnType<typeof setTimeout> | undefined;
}

const EMPTY_STAT: FileStat = { size: 0, modifiedMs: 0, sha256: "", readonly: false };

/**
 * Gere les documents ouverts d'un projet : lecture/decodage, suivi des modifications, enregistrement sur,
 * detection des modifications externes et instantanes de recuperation (RF-002, RF-003, RF-014, RF-016).
 *
 * Garanties :
 * - un document inchange n'est jamais reecrit sur le disque ;
 * - un enregistrement n'ecrase jamais un fichier modifie ailleurs sans decision explicite (`overwrite`) ;
 * - un caractere impossible a representer dans l'encodage du fichier bloque l'enregistrement (aucun remplacement) ;
 * - les fins de ligne, le BOM et l'encodage d'origine sont restitues.
 */
export class DocumentManager {
  private readonly entries = new Map<string, Entry>();
  /** Documents dont le tampon est remplace par le programme (recharger, restaurer) : leurs evenements de modification sont ignores. */
  private readonly applying = new Set<string>();
  private readonly listeners = new Set<(event: DocumentEvent) => void>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: DocumentManagerOptions) {}

  // ---------------------------------------------------------------------------------------------
  // Observation
  // ---------------------------------------------------------------------------------------------

  subscribe(listener: (event: DocumentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: DocumentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  info(path: string): DocumentInfo | undefined {
    const entry = this.entries.get(path);
    return entry === undefined ? undefined : this.toInfo(entry);
  }

  dirtyPaths(): string[] {
    return [...this.entries.values()].filter((entry) => this.isDirty(entry)).map((entry) => entry.path);
  }

  /** Texte courant (LF) d'un document ouvert. */
  textOf(path: string): string | undefined {
    return this.entries.get(path)?.buffer.getText();
  }

  private isDirty(entry: Entry): boolean {
    return entry.encodingChanged || entry.buffer.getText() !== entry.savedLf;
  }

  private toInfo(entry: Entry): DocumentInfo {
    return {
      path: entry.path,
      encoding: entry.encoding,
      bom: entry.bom,
      eol: entry.original.eol,
      warnings: entry.warnings,
      dirty: this.isDirty(entry),
      external: entry.external,
      stat: entry.stat,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Ouverture
  // ---------------------------------------------------------------------------------------------

  async open(path: string): Promise<OpenOutcome> {
    const existing = this.entries.get(path);
    if (existing !== undefined) return { ok: true, info: this.toInfo(existing), alreadyOpen: true };

    const [result] = await this.readOne(path);
    if (result === undefined || !result.ok) {
      return { ok: false, reason: "error", error: result?.error ?? new BackendError({ code: "unknown" }) };
    }
    const decoded = decodeDocument(result.bytes, { legacyEncoding: this.options.legacyEncoding() });
    if (decoded.kind !== "text") return { ok: false, reason: "unsupported", detail: decoded.reason };

    const savedLf = normalizeToLf(decoded.text);
    const entry: Entry = {
      path,
      buffer: this.options.createBuffer(savedLf, path),
      original: { text: decoded.text, eol: decoded.eol },
      encoding: decoded.encoding,
      bom: decoded.bom,
      warnings: [...decoded.warnings],
      stat: result.stat,
      savedLf,
      encodingChanged: false,
      external: "none",
      snapshotTimer: undefined,
    };
    this.entries.set(path, entry);
    this.emit({ type: "changed", path });
    return { ok: true, info: this.toInfo(entry), alreadyOpen: false };
  }

  private readOne(path: string) {
    return this.options.backend.readFiles(this.options.rootId, [path], MAX_OPEN_BYTES);
  }

  // ---------------------------------------------------------------------------------------------
  // Modifications et recuperation
  // ---------------------------------------------------------------------------------------------

  /** A appeler a chaque modification du tampon : recalcule l'etat modifie et planifie l'instantane de recuperation. */
  notifyEdited(path: string): void {
    const entry = this.entries.get(path);
    if (entry === undefined || this.applying.has(path)) return;
    this.cancelSnapshot(entry);
    if (this.isDirty(entry)) {
      entry.snapshotTimer = setTimeout(() => void this.snapshotNow(path), this.options.snapshotDelayMs());
    } else {
      // Retour a l'etat enregistre (annulation) : plus rien a recuperer.
      void this.options.backend.recoveryClear(this.options.rootId, path).catch(() => undefined);
    }
    this.emit({ type: "changed", path });
  }

  /** Remplace le contenu du tampon par le programme (sans declencher le suivi des modifications utilisateur). */
  private replaceText(entry: Entry, text: string): void {
    this.applying.add(entry.path);
    try {
      entry.buffer.setText(text);
    } finally {
      this.applying.delete(entry.path);
    }
  }

  private cancelSnapshot(entry: Entry): void {
    if (entry.snapshotTimer !== undefined) {
      clearTimeout(entry.snapshotTimer);
      entry.snapshotTimer = undefined;
    }
  }

  /** Ecrit immediatement l'instantane de recuperation (texte courant, en UTF-8) du document. */
  async snapshotNow(path: string): Promise<void> {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    entry.snapshotTimer = undefined;
    if (!this.isDirty(entry)) return;
    const data = new TextEncoder().encode(entry.buffer.getText());
    try {
      await this.options.backend.recoverySave(this.options.rootId, path, data, { baseSha256: entry.stat.sha256, encoding: entry.encoding });
    } catch {
      // Un echec d'instantane ne doit jamais gener l'edition ; il sera retente a la prochaine modification.
    }
  }

  /**
   * Remplace tout le contenu d'un document ouvert par `text` (un assistant qui remplit un fichier neuf) : le document devient
   * "modifie", rien n'est ecrit sur le disque avant l'enregistrement explicite, et un instantane de recuperation est planifie.
   * `false` si le document n'est pas ouvert.
   */
  setContent(path: string, text: string): boolean {
    const entry = this.entries.get(path);
    if (entry === undefined) return false;
    this.replaceText(entry, normalizeToLf(text));
    this.notifyEdited(path);
    return true;
  }

  /** Ouvre un document dont le contenu est remplace par un instantane recupere (le document reste "modifie"). */
  async restoreRecovered(path: string, recoveredLf: string, meta: RecoveryMeta): Promise<OpenOutcome> {
    const opened = await this.open(path);
    if (!opened.ok) {
      if (opened.reason === "error" && opened.error.code === "not_found") return this.openAsDeleted(path, recoveredLf, meta);
      return opened;
    }
    const entry = this.entries.get(path);
    if (entry === undefined) return opened;
    this.replaceText(entry, recoveredLf);
    if (meta.baseSha256 !== null && meta.baseSha256 !== entry.stat.sha256) entry.external = "modified";
    this.notifyEdited(path);
    return { ok: true, info: this.toInfo(entry), alreadyOpen: opened.alreadyOpen };
  }

  /** Le fichier a disparu depuis l'instantane : le texte recupere est conserve et l'enregistrement le recreera. */
  private openAsDeleted(path: string, recoveredLf: string, meta: RecoveryMeta): OpenOutcome {
    const entry: Entry = {
      path,
      buffer: this.options.createBuffer(recoveredLf, path),
      original: { text: "", eol: "LF" },
      encoding: meta.encoding !== null && meta.encoding !== "" ? meta.encoding : "utf-8",
      bom: false,
      warnings: [],
      stat: EMPTY_STAT,
      savedLf: "",
      encodingChanged: false,
      external: "deleted",
      snapshotTimer: undefined,
    };
    this.entries.set(path, entry);
    this.notifyEdited(path);
    return { ok: true, info: this.toInfo(entry), alreadyOpen: false };
  }

  // ---------------------------------------------------------------------------------------------
  // Enregistrement
  // ---------------------------------------------------------------------------------------------

  private async withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(path) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.locks.set(path, run.catch(() => undefined));
    return run;
  }

  /**
   * Enregistre un document. Ne fait rien s'il est inchange (le fichier n'est pas reecrit).
   * `overwrite: true` : decision explicite de l'utilisateur d'ecraser une version modifiee ailleurs ou de recreer un fichier supprime.
   */
  save(path: string, options: { overwrite?: boolean } = {}): Promise<SaveOutcome> {
    return this.withLock(path, () => this.saveNow(path, options.overwrite === true));
  }

  private async saveNow(path: string, overwrite: boolean): Promise<SaveOutcome> {
    const entry = this.entries.get(path);
    if (entry === undefined) return { status: "error", error: new BackendError({ code: "not_found" }) };
    if (!this.isDirty(entry)) return { status: "unchanged" };

    const lf = entry.buffer.getText();
    const text = restoreEol(lf, entry.original);
    const encoded = encodeDocument(text, { encoding: entry.encoding, bom: entry.bom });
    if (!encoded.ok) return { status: "unencodable", unencodable: encoded.unencodable };

    const recreate = entry.external === "deleted";
    try {
      const outcome = await this.options.backend.writeFile(
        this.options.rootId,
        path,
        encoded.bytes,
        overwrite || recreate ? { kind: "overwrite" } : { kind: "mustMatch", sha256: entry.stat.sha256 },
      );
      entry.stat = outcome.stat;
      entry.savedLf = lf;
      entry.original = { text, eol: detectEol(text) };
      entry.encodingChanged = false;
      entry.external = "none";
      this.cancelSnapshot(entry);
      if (this.isDirty(entry)) {
        // Modifie pendant l'ecriture : un nouvel instantane protegera les modifications restantes.
        entry.snapshotTimer = setTimeout(() => void this.snapshotNow(path), this.options.snapshotDelayMs());
      } else {
        await this.options.backend.recoveryClear(this.options.rootId, path).catch(() => undefined);
      }
      this.emit({ type: "changed", path });
      return { status: "saved", stat: outcome.stat, historySaved: outcome.historySaved };
    } catch (error) {
      const failure = toBackendError(error);
      if (failure.code === "external_modification") {
        entry.external = "modified";
        this.emit({ type: "changed", path });
        return { status: "conflict", current: failure.payload.current };
      }
      if (failure.code === "not_found") {
        entry.external = "deleted";
        this.emit({ type: "changed", path });
        return { status: "deleted" };
      }
      return { status: "error", error: failure };
    }
  }

  /** Enregistre tous les documents modifies, un par un. */
  async saveAll(): Promise<Map<string, SaveOutcome>> {
    const outcomes = new Map<string, SaveOutcome>();
    for (const path of this.dirtyPaths()) outcomes.set(path, await this.save(path));
    return outcomes;
  }

  /** Change l'encodage d'enregistrement (ex. conversion explicite en UTF-8 apres un caractere non representable). */
  changeEncoding(path: string, encoding: string, bom: boolean): void {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    entry.encoding = encoding;
    entry.bom = bom;
    entry.encodingChanged = true;
    entry.warnings = entry.warnings.filter((warning) => warning.code === "mixed-eol");
    this.notifyEdited(path);
  }

  // ---------------------------------------------------------------------------------------------
  // Disque
  // ---------------------------------------------------------------------------------------------

  /** Abandonne les modifications et recharge le contenu du disque. */
  async reloadFromDisk(path: string): Promise<OpenOutcome> {
    const entry = this.entries.get(path);
    if (entry === undefined) return this.open(path);
    const [result] = await this.readOne(path);
    if (result === undefined || !result.ok) {
      if (result !== undefined && result.error.code === "not_found") {
        entry.external = "deleted";
        this.emit({ type: "changed", path });
      }
      return { ok: false, reason: "error", error: result?.error ?? new BackendError({ code: "unknown" }) };
    }
    const decoded = decodeDocument(result.bytes, { legacyEncoding: this.options.legacyEncoding() });
    if (decoded.kind !== "text") return { ok: false, reason: "unsupported", detail: decoded.reason };
    const lf = normalizeToLf(decoded.text);
    this.cancelSnapshot(entry);
    this.replaceText(entry, lf);
    entry.original = { text: decoded.text, eol: decoded.eol };
    entry.encoding = decoded.encoding;
    entry.bom = decoded.bom;
    entry.warnings = [...decoded.warnings];
    entry.stat = result.stat;
    entry.savedLf = lf;
    entry.encodingChanged = false;
    entry.external = "none";
    await this.options.backend.recoveryClear(this.options.rootId, path).catch(() => undefined);
    this.emit({ type: "changed", path });
    return { ok: true, info: this.toInfo(entry), alreadyOpen: true };
  }

  /**
   * Compare les documents ouverts au disque (appele quand la fenetre reprend le focus). Un document inchange
   * dans l'editeur est recharge silencieusement ; un document modifie des deux cotes est signale en conflit.
   */
  async checkExternalChanges(): Promise<ExternalChange[]> {
    const paths = this.paths();
    if (paths.length === 0) return [];
    const results = await this.options.backend.readFiles(this.options.rootId, paths, MAX_OPEN_BYTES);
    const changes: ExternalChange[] = [];
    for (const result of results) {
      const entry = this.entries.get(result.path);
      if (entry === undefined) continue;
      if (!result.ok) {
        if (result.error.code === "not_found" && entry.external !== "deleted") {
          entry.external = "deleted";
          this.emit({ type: "changed", path: entry.path });
          changes.push({ path: entry.path, action: "deleted" });
        }
        continue;
      }
      if (result.stat.sha256 === entry.stat.sha256) {
        if (entry.external === "modified") {
          entry.external = "none";
          this.emit({ type: "changed", path: entry.path });
        }
        continue;
      }
      if (this.isDirty(entry)) {
        if (entry.external !== "modified") {
          entry.external = "modified";
          this.emit({ type: "changed", path: entry.path });
          changes.push({ path: entry.path, action: "conflict" });
        }
      } else {
        await this.reloadFromDisk(entry.path);
        changes.push({ path: entry.path, action: "reloaded" });
      }
    }
    return changes;
  }

  // ---------------------------------------------------------------------------------------------
  // Fermeture
  // ---------------------------------------------------------------------------------------------

  /** Ferme un document sans enregistrer (l'appelant a deja demande confirmation) et supprime son instantane. */
  async close(path: string): Promise<void> {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    this.cancelSnapshot(entry);
    this.entries.delete(path);
    entry.buffer.dispose?.();
    await this.options.backend.recoveryClear(this.options.rootId, path).catch(() => undefined);
    this.emit({ type: "closed", path });
  }

  /** Libere tous les documents (changement de projet) sans toucher aux instantanes de recuperation. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      this.cancelSnapshot(entry);
      entry.buffer.dispose?.();
    }
    this.entries.clear();
    this.listeners.clear();
  }
}
