import type { ReferenceHit, ReferenceKind } from "@runeforge/emulator-core";
import { collectRathenaDatabaseSources, RATHENA_PATHS } from "@runeforge/emulator-rathena";
import type { DeployReport, RollbackReport } from "@runeforge/deploy-core";
import type { WizardId } from "@runeforge/npc-templates";
import type { ParseDiagnostic } from "@runeforge/runescript-core";
import {
  ancestorDirectories,
  buildTree,
  decodeDocument,
  defaultProjectConfig,
  isCommandName,
  normalizeSession,
  normalizeSettings,
  parseProjectConfig,
  resolveLanguage,
  resolveTheme,
  serializeProjectConfig,
  PROJECT_CONFIG_DIRECTORY,
  PROJECT_CONFIG_PATH,
  type ProjectConfig,
  type Settings,
  type TreeNode,
} from "@runeforge/project-core";
import { LineIndex, normalizeToLf } from "@runeforge/runescript-core";
import { parse, type FunctionDeclaration } from "@runeforge/runescript-parser";
import { SymbolKind } from "@runeforge/runescript-language-server";
import type { FunctionLookup } from "@runeforge/simulation-core";
import type {
  CommandInfo,
  CompletionItem,
  CrossFileMode,
  DocumentSymbol,
  FileDiagnostics,
  HoverInfo,
  IndexStats,
  Location,
  ProjectReport,
  RenamePreparation,
  RenameResult,
  SignatureHelp,
  UnknownCommandMode,
  WorkspaceSymbol,
} from "@runeforge/runescript-language-server";
import { minimalEdit, npcAt, visualNpcAt } from "@runeforge/visual-core";
import { translate, type MessageKey } from "../i18n/messages";
import type { BackendApi } from "../services/backend";
import {
  BackendError,
  toBackendError,
  type ApprovedRoot,
  type HistoryEntry,
  type ReadFileResult,
  type RecoveryEntry,
  type ScanEntry,
} from "../services/types";
import { DocumentManager, type DocumentEvent, type SaveOutcome, type TextBuffer } from "../state/documents";
import type {
  CommandRegistrySummary,
  CommandSourcesInput,
  IndexFileInput,
  ReferenceCatalogSummary,
  ReferenceSourcesInput,
} from "../workers/protocol";
import {
  countResults,
  findBlockers,
  prepareDeploy,
  readLastDeploy,
  rollbackLast,
  runDeploy,
  type Preparation,
} from "./deploy-service";
import { formatReportText } from "./report-text";
import { describeLoadIssues, joinServerPath, locateServer, resolveLoadedMaps, resolveLoadedScripts, resolveRenewal } from "./server-profile";
import { UpdateController } from "./update-controller";
import {
  IDLE_INDEXING,
  MAX_BOTTOM,
  MAX_REFERENCES,
  MAX_SIDEBAR,
  MIN_BOTTOM,
  MIN_SIDEBAR,
  NO_EMULATOR,
  NO_REPORT_SCOPE,
  GIT_UNAVAILABLE_REASONS,
  type AppStore,
  type BottomTab,
  type DialogRequest,
  type EmulatorState,
  type GitUnavailable,
  type PaletteMode,
  type RecoveryItem,
  type ReferenceItem,
  type ReportScope,
  type SettingsTab,
  type ToastKind,
} from "../state/store";

/** Pause entre un changement des fichiers du projet et la relecture de l'etat Git (une rafale n'en declenche qu'une). */
const GIT_REFRESH_DELAY_MS = 500;

/** Ce que le plan d'un deploiement montre a l'utilisateur, et de quoi il decide (DEC-040). */
export interface DeployPlanView {
  readonly preparation: Preparation;
  /** Nombre d'erreurs d'analyse locale par fichier du plan (les fichiers sans erreur n'y figurent pas). */
  readonly errorCounts: ReadonlyMap<string, number>;
  /** Le dernier deploiement vers cette destination, s'il peut encore etre restaure. */
  readonly last: { readonly stamp: string; readonly report: DeployReport } | null;
}

/** Ce que Git sait de la version, dans `HEAD`, d'un fichier du projet. */
export type GitHeadText =
  | { readonly kind: "text"; readonly text: string }
  /** Le fichier n'est pas dans `HEAD` (fichier neuf, dossier, depot sans commit) : tout compte comme ajoute. */
  | { readonly kind: "new" }
  | { readonly kind: "error"; readonly reason: GitUnavailable };

/** Services fournis par l'editeur reel (Monaco) ; remplaces par des doublures dans les tests. */
export interface EditorServices {
  /** Charge l'editeur a la demande (Monaco) avant la premiere creation de tampon. */
  ready?(): Promise<void>;
  /** `onEdit` doit etre appele a chaque modification utilisateur du tampon. */
  createBuffer(initialLf: string, path: string, onEdit: () => void): TextBuffer;
  /**
   * Insere du texte a la place de la selection de l'editeur affiche ; `false` si aucun n'est affiche. `insideString` : le texte
   * a inserer a la place quand le curseur est deja dans une chaine (sans guillemets).
   */
  insertAtCursor?(text: string, insideString?: string): boolean;
  /**
   * Ajoute `text` a la fin du document `path`, comme une saisie (annulable) : le document est marque modifie. `false` si le
   * document n'a pas de tampon.
   */
  appendText?(path: string, text: string): boolean;
  /**
   * Remplace la plage `[start, end)` (offsets du texte LF du document) de `path` par `text`, comme une saisie : une seule etape
   * d'annulation, le document est marque modifie. `false` si le document n'a pas de tampon ou si la plage sort du texte.
   */
  applyEdit?(path: string, start: number, end: number, text: string): boolean;
}

export interface DiagnosticsService {
  analyze(path: string, version: number, text: string): Promise<{ diagnostics: readonly ParseDiagnostic[]; truncated: boolean }>;
}

/** Position LSP : ligne et colonne en base 0 (code units UTF-16). */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

/**
 * Service de langage complet (worker) : en plus des diagnostics d'un document, navigation, recherche de symboles et
 * indexation du projet. Les positions sont celles de LSP (base 0).
 */
export interface LanguageService extends DiagnosticsService {
  closeDocument(path: string): Promise<void>;
  definition(path: string, position: LspPosition): Promise<Location[]>;
  references(path: string, position: LspPosition, includeDeclaration: boolean): Promise<Location[]>;
  documentSymbols(path: string): Promise<DocumentSymbol[]>;
  completion(path: string, position: LspPosition, explicit?: boolean): Promise<CompletionItem[]>;
  hover(path: string, position: LspPosition): Promise<HoverInfo | null>;
  signatureHelp(path: string, position: LspPosition): Promise<SignatureHelp | null>;
  commandInfo(name: string): Promise<CommandInfo | null>;
  prepareRename(path: string, position: LspPosition): Promise<RenamePreparation>;
  rename(path: string, position: LspPosition, newName: string): Promise<RenameResult>;
  workspaceSymbols(query: string, limit: number): Promise<WorkspaceSymbol[]>;
  projectDiagnostics(): Promise<FileDiagnostics[]>;
  /** Diagnostics d'un texte qui n'est pas un document du projet (apercu d'un assistant) ; rien n'est indexe. */
  previewDiagnostics(text: string): Promise<ParseDiagnostic[]>;
  /** Rapport de projet (RF-015) : problemes des fichiers indexes (ou des seuls `only`), avec position, totaux par gravite et par code. */
  projectReport(options?: { only?: string[] | null }): Promise<ProjectReport>;
  indexFiles(files: IndexFileInput[], legacyEncoding: string): Promise<{ indexed: number; skipped: string[] }>;
  removeFiles(paths: string[]): Promise<void>;
  clearIndex(): Promise<void>;
  setOptions(options: {
    crossFile?: CrossFileMode;
    styleHints?: boolean;
    unknownCommands?: UnknownCommandMode;
    unknownReferences?: UnknownCommandMode;
    emulator?: "rathena" | "hercules" | null;
  }): Promise<void>;
  /** Ordre de chargement des scripts par le serveur (les plus tot charges d'abord), `null` s'il est inconnu : active `RA0016`. */
  setLoadOrder(files: readonly string[] | null): Promise<void>;
  /** Construit le registre de commandes depuis les fichiers du serveur (aucun fichier : plus de registre). */
  setCommandSources(sources: CommandSourcesInput): Promise<CommandRegistrySummary>;
  /** Construit le catalogue de references (objets, monstres, cartes, constantes) depuis les bases du serveur. */
  setReferenceSources(sources: ReferenceSourcesInput): Promise<ReferenceCatalogSummary>;
  /** Recherche libre dans le catalogue de references. */
  searchReferences(kind: ReferenceKind, query: string, limit: number): Promise<ReferenceHit[]>;
  stats(): Promise<IndexStats>;
}

export interface ControllerDeps {
  readonly backend: BackendApi;
  readonly store: AppStore;
  readonly editor: EditorServices;
  readonly diagnostics?: DiagnosticsService | null;
  /** Service de langage (navigation, index du projet). Absent : seules les fonctions de base sont disponibles. */
  readonly language?: LanguageService | null;
  readonly systemLanguage?: () => string;
  readonly systemPrefersDark?: () => boolean;
  /** Presse-papiers (copie du rapport de projet) ; absent : celui de la page, s'il existe. */
  readonly clipboard?: { writeText(text: string): Promise<void> } | null;
}

/** Delai (ms) avant analyse apres une modification. */
const DIAGNOSTICS_DELAY_MS = 250;
const TOAST_LIFETIME_MS = 5000;
/** Notifications visibles en meme temps : au-dela, les plus anciennes partent (cinq empilees recouvraient un tiers de la fenetre, l'E2E l'a vu). */
const TOASTS_MAX = 3;
const SESSION_SAVE_DELAY_MS = 500;
const TREE_REFRESH_MIN_INTERVAL_MS = 15_000;
/** Nombre de fichiers lus puis transmis au worker par lot lors de l'indexation du projet. */
const INDEX_BATCH_SIZE = 40;
/** Delai (ms) avant de recalculer le rapport de projet affiche apres un changement : une rafale de frappes n'en declenche qu'un. */
const REPORT_REFRESH_DELAY_MS = 400;
/** Taille maximale d'un fichier relu pour afficher l'extrait d'une reference. */
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
/** Taille maximale (caracteres) d'un fichier dont on simule un NPC : le plus gros script du serveur de reference en compte 0,66 million. */
const MAX_SIMULATION_SOURCE = 4 * 1024 * 1024;

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** Des sources de references vides : le service de langage n'a plus de catalogue (ni verification, ni proposition). */
function emptyReferenceSources(family: "rathena" | "hercules", legacyEncoding: string): ReferenceSourcesInput {
  return { family, items: [], mobs: [], constantsYaml: [], constantsSource: null, mapIndex: [], legacyEncoding };
}

/**
 * Orchestre l'application : projet, documents, dialogues, diagnostics, preferences. Sans React ni Monaco :
 * les composants appellent ces methodes et lisent le store.
 */
export class AppController {
  private manager: DocumentManager | null = null;
  private unsubscribeManager: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private persistedSettings: Settings | null = null;
  private settingsWriteQueue: Promise<void> = Promise.resolve();
  private toastCounter = 0;
  private readonly diagnosticsTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly diagnosticsVersions = new Map<string, number>();
  private sessionTimer: ReturnType<typeof setTimeout> | undefined;
  private lastDirty = false;
  private lastTreeRefresh = 0;
  private configSha256: string | null = null;
  private leaveResolver: ((proceed: boolean) => void) | null = null;
  private revealToken = 0;
  private lineIndexCache: { path: string; text: string; index: LineIndex } | null = null;
  /** Incremente a chaque (re)demarrage ou arret de l'indexation : une indexation obsolete s'interrompt. */
  private indexToken = 0;
  /** Empreinte (`taille:date`) de chaque fichier du projet au moment ou il a ete indexe. */
  private readonly indexedStamps = new Map<string, string>();
  private syncingIndex = false;
  /** Fichiers du projet (hors exclusions) au dernier parcours : sert a reconnaitre le serveur et ses scripts. */
  private projectFiles: ReadonlyMap<string, ScanEntry> = new Map();
  /** Dernier ordre de chargement confie au service (`null` : inconnu) : une modification relance les diagnostics. */
  private loadOrder: readonly string[] | null = null;
  /** Incremente a chaque lecture des fichiers du serveur : un resultat obsolete est abandonne. */
  private emulatorToken = 0;
  /** Reconnaissance du serveur puis premiere indexation, a l'ouverture du projet. */
  private startPromise: Promise<void> | null = null;

  /** Mises a jour signees de l'application (DEC-046) : jamais lancees sans l'utilisateur. */
  readonly updates: UpdateController;

  constructor(private readonly deps: ControllerDeps) {
    this.updates = new UpdateController({
      backend: deps.backend,
      store: deps.store,
      hasUnsavedChanges: () => (this.manager?.dirtyPaths().length ?? 0) > 0,
      log: (level, code, detail) => this.logEvent(level, code, detail),
    });
  }

  private get store(): AppStore {
    return this.deps.store;
  }

  private get backend(): BackendApi {
    return this.deps.backend;
  }

  /** Texte localise dans la langue courante. */
  t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
    return translate(this.store.getState().language, key, params);
  }

  getManager(): DocumentManager | null {
    return this.manager;
  }

  /** Acces au store (utilise par les commandes et les composants). */
  getStore(): AppStore {
    return this.deps.store;
  }

  // ---------------------------------------------------------------------------------------------
  // Demarrage
  // ---------------------------------------------------------------------------------------------

  async init(): Promise<void> {
    let info;
    try {
      info = await this.backend.appInfo();
    } catch {
      this.store.setState({ runtimeAvailable: false, ready: true });
      return;
    }
    const settings = await this.loadSettings();
    this.persistedSettings = settings;
    const layout = await this.loadJson("layout");
    const recents = await this.backend.listRecentProjects().catch(() => []);
    this.applySettings(settings);
    this.store.setState({
      ready: true,
      appVersion: info.version,
      platform: info.platform,
      recents,
      ...this.layoutFrom(layout),
    });
    this.unsubscribeClose = await this.backend.onCloseRequested(() => void this.requestExit()).catch(() => null);

    const e2e = await this.backend.e2eProject().catch(() => null);
    if (e2e !== null) {
      await this.loadProject(e2e);
      return;
    }
    const session = normalizeSession(await this.loadJson("session"));
    if (settings.onboardingDone && session.projectPath !== null && recents.some((project) => project.path === session.projectPath)) {
      try {
        const root = await this.backend.openRecentProject(session.projectPath);
        await this.loadProject(root, session);
      } catch {
        // Projet deplace ou supprime : retour a l'ecran d'accueil.
      }
    }
  }

  private layoutFrom(layout: unknown): { sidebarWidth?: number; bottomHeight?: number; sidebarVisible?: boolean; bottomVisible?: boolean } {
    if (typeof layout !== "object" || layout === null) return {};
    const raw = layout as Record<string, unknown>;
    const clamp = (value: unknown, min: number, max: number): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined;
    const result: { sidebarWidth?: number; bottomHeight?: number; sidebarVisible?: boolean; bottomVisible?: boolean } = {};
    const sidebarWidth = clamp(raw["sidebarWidth"], MIN_SIDEBAR, MAX_SIDEBAR);
    const bottomHeight = clamp(raw["bottomHeight"], MIN_BOTTOM, MAX_BOTTOM);
    if (sidebarWidth !== undefined) result.sidebarWidth = sidebarWidth;
    if (bottomHeight !== undefined) result.bottomHeight = bottomHeight;
    if (typeof raw["sidebarVisible"] === "boolean") result.sidebarVisible = raw["sidebarVisible"];
    if (typeof raw["bottomVisible"] === "boolean") result.bottomVisible = raw["bottomVisible"];
    return result;
  }

  private async loadJson(name: "settings" | "session" | "layout"): Promise<unknown> {
    try {
      const text = await this.backend.configGet(name);
      return text === null ? null : (JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }

  private async loadSettings(): Promise<Settings> {
    return normalizeSettings(await this.loadJson("settings"));
  }

  dispose(): void {
    this.unsubscribeClose?.();
    this.unsubscribeManager?.();
    this.manager?.dispose();
    for (const timer of this.diagnosticsTimers.values()) clearTimeout(timer);
    this.diagnosticsTimers.clear();
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer);
  }

  // ---------------------------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------------------------

  private applySettings(settings: Settings): void {
    const language = resolveLanguage(settings.language, this.deps.systemLanguage?.() ?? "en");
    const theme = resolveTheme(settings.theme, this.deps.systemPrefersDark?.() ?? false);
    this.store.setState({ settings, language, theme });
  }

  async updateSettings(patch: {
    language?: Settings["language"];
    theme?: Settings["theme"];
    onboardingDone?: boolean;
    editor?: Partial<Settings["editor"]>;
    recovery?: Partial<Settings["recovery"]>;
    ai?: Partial<Settings["ai"]>;
    logging?: Partial<Settings["logging"]>;
    updates?: Partial<Settings["updates"]>;
  }): Promise<boolean> {
    const current = this.store.getState().settings;
    const next = normalizeSettings({
      ...current,
      ...patch,
      editor: { ...current.editor, ...patch.editor },
      recovery: { ...current.recovery, ...patch.recovery },
      ai: { ...current.ai, ...patch.ai },
      logging: { ...current.logging, ...patch.logging },
      updates: { ...current.updates, ...patch.updates },
    });
    this.applySettings(next);
    const write = this.settingsWriteQueue.then(async () => {
      await this.backend.configSet("settings", JSON.stringify(next));
      this.persistedSettings = next;
    });
    this.settingsWriteQueue = write.then(() => undefined, () => undefined);
    try {
      await write;
    } catch {
      if (this.store.getState().settings === next) this.applySettings(this.persistedSettings ?? current);
      this.notify("error", this.t("settings.saveFailed"));
      return false;
    }
    // Le journal s'ouvre sur son activation (le coeur natif relit le reglage enregistre : il l'est a ce stade).
    if (!current.logging.enabled && next.logging.enabled) this.logEvent("info", "LOG_ENABLED");
    return true;
  }

  /**
   * Ajoute un evenement au journal de diagnostic local, si l'utilisateur l'a active. `detail` : des valeurs `cle=valeur` (compteurs,
   * indicateurs), **jamais** un chemin, un nom de fichier, un extrait de source ni un message libre ; le coeur natif refuse le reste.
   */
  logEvent(level: "info" | "warn" | "error", code: string, detail = ""): void {
    if (!this.store.getState().settings.logging.enabled) return;
    void this.backend.logEvent(level, code, detail).catch(() => undefined);
  }

  /** Re-resout la langue et le theme apres un changement du systeme (theme "systeme"). */
  refreshSystemPreferences(): void {
    this.applySettings(this.store.getState().settings);
  }

  setSidebarWidth(width: number): void {
    this.store.setState({ sidebarWidth: Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, Math.round(width))) });
    void this.persistLayout();
  }

  setBottomHeight(height: number): void {
    this.store.setState({ bottomHeight: Math.min(MAX_BOTTOM, Math.max(MIN_BOTTOM, Math.round(height))) });
    void this.persistLayout();
  }

  toggleSidebar(): void {
    this.store.setState((state) => ({ sidebarVisible: !state.sidebarVisible }));
    void this.persistLayout();
  }

  toggleBottomPanel(): void {
    this.store.setState((state) => ({ bottomVisible: !state.bottomVisible }));
    if (this.reportVisible()) this.ensureProjectReport();
    void this.persistLayout();
  }

  private async persistLayout(): Promise<void> {
    const { sidebarWidth, bottomHeight, sidebarVisible, bottomVisible } = this.store.getState();
    await this.backend.configSet("layout", JSON.stringify({ sidebarWidth, bottomHeight, sidebarVisible, bottomVisible })).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // Notifications et dialogues
  // ---------------------------------------------------------------------------------------------

  notify(kind: ToastKind, text: string): void {
    const id = ++this.toastCounter;
    this.store.setState((state) => ({ toasts: [...state.toasts.slice(1 - TOASTS_MAX), { id, kind, text }] }));
    setTimeout(() => this.dismissToast(id), kind === "error" ? TOAST_LIFETIME_MS * 2 : TOAST_LIFETIME_MS);
  }

  dismissToast(id: number): void {
    this.store.setState((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  }

  /** Affiche un dialogue modal (les suivants sont mis en file). */
  openDialog(request: DialogRequest): void {
    this.store.setState((state) =>
      state.dialog === null ? { dialog: request } : { dialogQueue: [...state.dialogQueue, request] },
    );
  }

  closeDialog(): void {
    this.store.setState((state) => {
      const [next, ...rest] = state.dialogQueue;
      return { dialog: next ?? null, dialogQueue: rest };
    });
  }

  /** Remplace le dialogue courant (ex. nouveau fichier avec une erreur de nom). */
  replaceDialog(request: DialogRequest): void {
    this.store.setState({ dialog: request });
  }

  openSettings(tab: SettingsTab = "general"): void {
    this.openDialog({ kind: "settings", tab });
  }

  openPalette(mode: PaletteMode): void {
    this.store.setState({ palette: { open: true, mode } });
  }

  closePalette(): void {
    this.store.setState((state) => ({ palette: { ...state.palette, open: false } }));
  }

  dismissBanner(key: string): void {
    this.store.setState((state) => ({ dismissedBanners: [...state.dismissedBanners, key] }));
  }

  setCursor(line: number, column: number): void {
    this.store.setState({ cursor: { line, column } });
  }

  private describe(error: BackendError): string {
    const key = `error.${error.code}` as MessageKey;
    const known: readonly string[] = ["not_found", "permission_denied", "too_large", "invalid_path", "outside_root", "already_exists", "external_modification", "io"];
    return this.t(known.includes(error.code) ? key : "error.unknown");
  }

  // ---------------------------------------------------------------------------------------------
  // Projet
  // ---------------------------------------------------------------------------------------------

  async openFolder(): Promise<void> {
    if (!(await this.confirmLeaveProject())) return;
    try {
      const root = await this.backend.pickProjectFolder();
      if (root !== null) await this.loadProject(root);
    } catch (error) {
      this.notify("error", this.describe(toBackendError(error)));
    }
  }

  async openRecent(path: string): Promise<void> {
    if (!(await this.confirmLeaveProject())) return;
    try {
      const root = await this.backend.openRecentProject(path);
      await this.loadProject(root);
    } catch (error) {
      await this.backend.forgetRecentProject(path).catch(() => undefined);
      this.store.setState({ recents: await this.backend.listRecentProjects().catch(() => []) });
      this.notify("error", this.describe(toBackendError(error)));
    }
  }

  async forgetRecent(path: string): Promise<void> {
    await this.backend.forgetRecentProject(path).catch(() => undefined);
    this.store.setState({ recents: await this.backend.listRecentProjects().catch(() => []) });
  }

  /**
   * Les modifications non enregistrees empechent de quitter le projet sans decision : le dialogue de sortie est
   * affiche et l'action en attente (ouvrir un autre dossier, fermer le projet) reprend selon le choix.
   */
  private confirmLeaveProject(): Promise<boolean> {
    const dirty = this.manager?.dirtyPaths() ?? [];
    if (dirty.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      this.leaveResolver = resolve;
      this.openDialog({ kind: "exit", paths: dirty, purpose: "leave-project" });
    });
  }

  async closeProject(): Promise<void> {
    if (!(await this.confirmLeaveProject())) return;
    await this.teardownProject();
    this.store.setState({ project: null });
  }

  private async teardownProject(): Promise<void> {
    this.unsubscribeManager?.();
    this.unsubscribeManager = null;
    this.manager?.dispose();
    this.manager = null;
    for (const timer of this.diagnosticsTimers.values()) clearTimeout(timer);
    this.diagnosticsTimers.clear();
    this.diagnosticsVersions.clear();
    this.analyzedDirty.clear();
    this.indexToken += 1;
    this.emulatorToken += 1;
    this.pendingSync = null;
    this.startPromise = null;
    this.indexedStamps.clear();
    this.projectFiles = new Map();
    await this.deps.language?.clearIndex().catch(() => undefined);
    // Le registre de commandes appartient au serveur du projet quitte : il ne doit pas servir au projet suivant.
    await this.deps.language
      ?.setCommandSources({ family: "rathena", builtinSource: null, customBuiltins: null, legacyEncoding: "windows-1252" })
      .catch(() => undefined);
    // Il en va de meme du catalogue de references (objets, monstres, cartes, constantes).
    await this.deps.language?.setReferenceSources(emptyReferenceSources("rathena", "windows-1252")).catch(() => undefined);
    // L'ordre dans lequel le serveur charge ses scripts aussi.
    await this.deps.language?.setLoadOrder(null).catch(() => undefined);
    this.loadOrder = null;
    this.configSha256 = null;
    this.lastDirty = false;
    await this.backend.setDirty(false).catch(() => undefined);
    // Le rapport appartient au projet quitte.
    this.reportToken += 1;
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer);
    this.reportTimer = undefined;
    // Et l'etat Git : il appartient au projet quitte (le suivant n'a pas encore autorise Git).
    this.gitToken += 1;
    this.gitStale = false;
    if (this.gitTimer !== undefined) clearTimeout(this.gitTimer);
    this.gitTimer = undefined;
    this.store.setState({
      indexing: IDLE_INDEXING,
      emulator: NO_EMULATOR,
      projectReport: null,
      git: { status: "off" },
      tabs: [],
      activePath: null,
      docs: {},
      diagnostics: {},
      expanded: [],
      selectedPath: null,
      explorerFilter: "",
      cursor: null,
      dismissedBanners: [],
    });
  }

  private async readConfig(root: ApprovedRoot): Promise<{ config: ProjectConfig; raw: Record<string, unknown>; exists: boolean }> {
    const folderName = lastSegment(root.displayPath);
    const fallback = { config: defaultProjectConfig(folderName), raw: {}, exists: false };
    const [result] = await this.backend.readFiles(root.id, [PROJECT_CONFIG_PATH]).catch(() => []);
    if (result === undefined || !result.ok) return fallback;
    this.configSha256 = result.stat.sha256;
    const parsed = parseProjectConfig(new TextDecoder().decode(result.bytes));
    if (!parsed.ok) {
      this.notify("warning", `${PROJECT_CONFIG_PATH}: ${parsed.errors.map((issue) => issue.message).join("; ")}`);
      return fallback;
    }
    return { config: parsed.config, raw: parsed.raw, exists: true };
  }

  private async scan(root: ApprovedRoot, config: ProjectConfig) {
    const result = await this.backend.scanProject(root.id, { exclude: config.exclude });
    this.projectFiles = new Map(result.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
    return {
      tree: buildTree(result.entries),
      fileCount: result.entries.filter((entry) => entry.kind === "file").length,
      truncated: result.truncated,
      skipped: result.skipped.length,
    };
  }

  async loadProject(root: ApprovedRoot, session?: ReturnType<typeof normalizeSession>): Promise<void> {
    await this.teardownProject();
    const { config, raw, exists } = await this.readConfig(root);
    const scanned = await this.scan(root, config);
    this.lastTreeRefresh = Date.now();

    const manager = new DocumentManager({
      backend: this.backend,
      rootId: root.id,
      createBuffer: (text, path) => this.deps.editor.createBuffer(text, path, () => this.notifyEdited(path)),
      legacyEncoding: () => this.store.getState().project?.config.encoding.legacy ?? "windows-1252",
      snapshotDelayMs: () => this.store.getState().settings.recovery.snapshotDelayMs,
    });
    this.manager = manager;
    this.unsubscribeManager = manager.subscribe((event) => this.onDocumentEvent(event));

    this.store.setState({
      project: {
        root,
        name: exists ? config.projectName : lastSegment(root.displayPath),
        config,
        configRaw: raw,
        configExists: exists,
        ...scanned,
      },
      expanded: session?.expandedDirectories.slice() ?? [],
    });
    this.store.setState({ recents: await this.backend.listRecentProjects().catch(() => []) });
    this.logEvent("info", "PROJECT_OPENED", `files=${scanned.fileCount} truncated=${scanned.truncated}`);
    this.startPromise = this.indexProject();
    void this.startPromise;

    const recovery = await this.backend.recoveryList(root.id).catch(() => [] as RecoveryEntry[]);
    if (recovery.length > 0) {
      const items: RecoveryItem[] = recovery.map((entry) => ({
        path: entry.relative,
        savedAtMs: entry.savedAtMs,
        size: entry.size,
        baseSha256: entry.baseSha256,
      }));
      this.openDialog({ kind: "recovery", items });
      this.logEvent("warn", "RECOVERY_OFFERED", `count=${items.length}`);
    }
    if (session !== undefined) {
      for (const path of session.openFiles) await this.openFile(path, { activate: path === session.activeFile });
    }
  }

  async refreshTree(force = true): Promise<void> {
    const project = this.store.getState().project;
    if (project === null) return;
    if (!force && Date.now() - this.lastTreeRefresh < TREE_REFRESH_MIN_INTERVAL_MS) return;
    try {
      const scanned = await this.scan(project.root, project.config);
      this.lastTreeRefresh = Date.now();
      this.store.setState((state) => (state.project === null ? {} : { project: { ...state.project, ...scanned } }));
      this.markGitStale();
      void this.syncIndex();
    } catch (error) {
      this.notify("error", this.describe(toBackendError(error)));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Explorateur
  // ---------------------------------------------------------------------------------------------

  toggleDirectory(path: string): void {
    this.store.setState((state) => ({
      expanded: state.expanded.includes(path) ? state.expanded.filter((item) => item !== path) : [...state.expanded, path],
    }));
    this.scheduleSessionSave();
  }

  collapseAll(): void {
    this.store.setState({ expanded: [] });
    this.scheduleSessionSave();
  }

  setExplorerFilter(filter: string): void {
    this.store.setState({ explorerFilter: filter });
  }

  selectInExplorer(path: string | null): void {
    this.store.setState({ selectedPath: path });
  }

  // ---------------------------------------------------------------------------------------------
  // Documents et onglets
  // ---------------------------------------------------------------------------------------------

  async openFile(path: string, options: { activate?: boolean } = {}): Promise<boolean> {
    const manager = this.manager;
    if (manager === null) return false;
    const name = lastSegment(path);
    await this.deps.editor.ready?.();
    const outcome = await manager.open(path);
    if (!outcome.ok) {
      if (outcome.reason === "unsupported") {
        this.notify("warning", this.t(`file.unsupported.${outcome.detail}` as MessageKey, { name }));
      } else {
        this.notify("error", this.t("file.openError", { name, reason: this.describe(outcome.error) }));
      }
      return false;
    }
    this.store.setState((state) => ({
      tabs: state.tabs.includes(path) ? state.tabs : [...state.tabs, path],
      activePath: options.activate === false ? (state.activePath ?? path) : path,
      selectedPath: path,
      expanded: [...new Set([...state.expanded, ...ancestorDirectories(path)])],
      docs: { ...state.docs, [path]: outcome.info },
    }));
    this.scheduleDiagnostics(path, 0);
    this.scheduleSessionSave();
    return true;
  }

  activateTab(path: string): void {
    if (!this.store.getState().tabs.includes(path)) return;
    this.store.setState({ activePath: path, selectedPath: path });
    this.scheduleSessionSave();
  }

  cycleTab(direction: 1 | -1): void {
    const { tabs, activePath } = this.store.getState();
    if (tabs.length === 0) return;
    const index = activePath === null ? 0 : tabs.indexOf(activePath);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next !== undefined) this.activateTab(next);
  }

  /** Ferme un onglet en demandant confirmation si le document est modifie. */
  async requestCloseTab(path: string): Promise<void> {
    const info = this.manager?.info(path);
    if (info?.dirty === true) {
      this.openDialog({ kind: "unsaved-close", path });
      return;
    }
    await this.closeTab(path);
  }

  async closeTab(path: string): Promise<void> {
    const wasDirty = this.manager?.info(path)?.dirty === true;
    await this.manager?.close(path);
    const language = this.deps.language;
    if (language !== undefined && language !== null) {
      const timer = this.diagnosticsTimers.get(path);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.diagnosticsTimers.delete(path);
      }
      // Le texte non enregistre est abandonne : l'index doit revenir a la version du disque.
      void language
        .closeDocument(path)
        .then(() => (wasDirty ? this.reindexFromDisk([path]) : undefined))
        .catch(() => undefined);
    }
    this.store.setState((state) => {
      const index = state.tabs.indexOf(path);
      const tabs = state.tabs.filter((tab) => tab !== path);
      const activePath = state.activePath === path ? (tabs[index] ?? tabs[index - 1] ?? null) : state.activePath;
      const { [path]: _removedDoc, ...docs } = state.docs;
      const { [path]: _removedDiagnostics, ...diagnostics } = state.diagnostics;
      return { tabs, activePath, docs, diagnostics };
    });
    this.diagnosticsVersions.delete(path);
    this.analyzedDirty.delete(path);
    this.scheduleSessionSave();
  }

  private onDocumentEvent(event: DocumentEvent): void {
    if (event.type === "closed") return;
    const info = this.manager?.info(event.path);
    if (info !== undefined) {
      this.store.setState((state) => (event.path in state.docs || state.tabs.includes(event.path) ? { docs: { ...state.docs, [event.path]: info } } : {}));
    }
    const dirty = (this.manager?.dirtyPaths().length ?? 0) > 0;
    if (dirty !== this.lastDirty) {
      this.lastDirty = dirty;
      void this.backend.setDirty(dirty).catch(() => undefined);
    }
    this.scheduleDiagnostics(event.path, DIAGNOSTICS_DELAY_MS);
  }

  /** Ouvre le fichier et demande a l'editeur d'afficher la position donnee (base 1). */
  async revealPosition(path: string, line: number, column: number): Promise<void> {
    if (!(await this.openFile(path))) return;
    this.activateTab(path);
    this.store.setState({ reveal: { path, line, column, token: ++this.revealToken } });
  }

  /** Ligne et colonne (base 1) d'un offset du texte courant d'un document ouvert. */
  positionOf(path: string, offset: number): { line: number; column: number } {
    const text = this.manager?.textOf(path) ?? "";
    if (this.lineIndexCache?.path !== path || this.lineIndexCache.text !== text) {
      this.lineIndexCache = { path, text, index: new LineIndex(text) };
    }
    const position = this.lineIndexCache.index.positionAt(offset);
    return { line: position.line + 1, column: position.character + 1 };
  }

  /** A appeler par l'editeur apres chaque modification du tampon. */
  notifyEdited(path: string): void {
    this.manager?.notifyEdited(path);
  }

  // ---------------------------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------------------------

  private scheduleDiagnostics(path: string, delay: number): void {
    const service = this.deps.diagnostics;
    if (service === undefined || service === null || this.manager === null) return;
    const existing = this.diagnosticsTimers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    this.diagnosticsTimers.set(
      path,
      setTimeout(() => {
        this.diagnosticsTimers.delete(path);
        void this.runDiagnostics(path, service);
      }, delay),
    );
  }

  private async runDiagnostics(path: string, service: DiagnosticsService): Promise<void> {
    const text = this.manager?.textOf(path);
    if (text === undefined) return;
    const version = (this.diagnosticsVersions.get(path) ?? 0) + 1;
    this.diagnosticsVersions.set(path, version);
    try {
      const result = await service.analyze(path, version, text);
      if (this.diagnosticsVersions.get(path) !== version) return; // resultat perime
      this.store.setState((state) => ({
        diagnostics: { ...state.diagnostics, [path]: { version, diagnostics: result.diagnostics, truncated: result.truncated } },
      }));
      // Ouvrir un fichier deja indexe sans le modifier ne change rien au rapport ; le modifier (ou le ramener a son etat
      // enregistre), ou ouvrir un fichier que l'index ne connaissait pas, le change.
      const dirty = this.manager?.info(path)?.dirty === true;
      const wasDirty = this.analyzedDirty.has(path);
      if (dirty) this.analyzedDirty.add(path);
      else this.analyzedDirty.delete(path);
      if (dirty || wasDirty || !this.indexedStamps.has(path)) this.markReportStale();
    } catch {
      // L'analyse est informative : un echec ne doit jamais gener l'edition.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Service de langage : index du projet et navigation
  // ---------------------------------------------------------------------------------------------

  /** Envoie au service le texte courant d'un document dont l'analyse etait en attente (anti-peremption). */
  private async flushDocument(path: string): Promise<void> {
    const service = this.deps.diagnostics;
    const timer = this.diagnosticsTimers.get(path);
    if (service === undefined || service === null || timer === undefined) return;
    clearTimeout(timer);
    this.diagnosticsTimers.delete(path);
    await this.runDiagnostics(path, service);
  }

  /** Definition(s) du symbole a la position (ligne/colonne en base 1) d'un document ouvert. */
  async definitionAt(path: string, line: number, column: number): Promise<Location[]> {
    const language = this.deps.language;
    if (language === undefined || language === null) return [];
    await this.flushDocument(path);
    return language.definition(path, { line: line - 1, character: column - 1 }).catch(() => []);
  }

  async referencesAt(path: string, line: number, column: number, includeDeclaration = true): Promise<Location[]> {
    const language = this.deps.language;
    if (language === undefined || language === null) return [];
    await this.flushDocument(path);
    return language.references(path, { line: line - 1, character: column - 1 }, includeDeclaration).catch(() => []);
  }

  /** Propositions de completion a la position (ligne/colonne en base 1) d'un document ouvert. */
  async completionAt(path: string, line: number, column: number, explicit = false): Promise<CompletionItem[]> {
    const language = this.deps.language;
    if (language === undefined || language === null) return [];
    await this.flushDocument(path);
    return language.completion(path, { line: line - 1, character: column - 1 }, explicit).catch(() => []);
  }

  /** Aide de signature a la position (ligne/colonne en base 1) : la commande dont le curseur est dans les arguments. */
  async signatureHelpAt(path: string, line: number, column: number): Promise<SignatureHelp | null> {
    const language = this.deps.language;
    if (language === undefined || language === null) return null;
    await this.flushDocument(path);
    return language.signatureHelp(path, { line: line - 1, character: column - 1 }).catch(() => null);
  }

  /** Ce que le registre sait d'une commande (detail d'une proposition de completion). */
  async commandInfoOf(name: string): Promise<CommandInfo | null> {
    const language = this.deps.language;
    if (language === undefined || language === null) return null;
    return language.commandInfo(name).catch(() => null);
  }

  /** Informations sur le symbole a la position (ligne/colonne en base 1), ou `null`. */
  async hoverAt(path: string, line: number, column: number): Promise<HoverInfo | null> {
    const language = this.deps.language;
    if (language === undefined || language === null) return null;
    await this.flushDocument(path);
    return language.hover(path, { line: line - 1, character: column - 1 }).catch(() => null);
  }

  /** Le symbole a la position (base 1) est-il renommable ? Renvoie sa plage et son nom actuel, ou la raison du refus. */
  async prepareRenameAt(path: string, line: number, column: number): Promise<RenamePreparation> {
    const language = this.deps.language;
    if (language === undefined || language === null) return { ok: false, reason: "not-renameable" };
    await this.flushDocument(path);
    return language.prepareRename(path, { line: line - 1, character: column - 1 }).catch(() => ({ ok: false, reason: "not-renameable" }) as const);
  }

  /** Modifications du document qui renomment le symbole a la position (base 1), ou la raison du refus. */
  async renameAt(path: string, line: number, column: number, newName: string): Promise<RenameResult> {
    const language = this.deps.language;
    if (language === undefined || language === null) return { ok: false, reason: "not-renameable" };
    await this.flushDocument(path);
    return language.rename(path, { line: line - 1, character: column - 1 }, newName).catch(() => ({ ok: false, reason: "not-renameable" }) as const);
  }

  async documentSymbolsOf(path: string): Promise<DocumentSymbol[]> {
    const language = this.deps.language;
    if (language === undefined || language === null) return [];
    await this.flushDocument(path);
    return language.documentSymbols(path).catch(() => []);
  }

  async searchSymbols(query: string, limit = 100): Promise<WorkspaceSymbol[]> {
    const language = this.deps.language;
    if (language === undefined || language === null) return [];
    return language.workspaceSymbols(query, limit).catch(() => []);
  }

  /** Ouvre le fichier d'un resultat de navigation et place le curseur sur son debut. */
  async openLocation(location: Location): Promise<void> {
    await this.revealPosition(location.uri, location.range.start.line + 1, location.range.start.character + 1);
  }

  /** Mot (avec ses prefixes de variable) sous la position donnee (base 1) d'un document ouvert, ou `""`. */
  private wordAt(path: string, line: number, column: number): string {
    const lineText = (this.manager?.textOf(path) ?? "").split("\n")[line - 1] ?? "";
    for (const match of lineText.matchAll(/[.@$#']*[A-Za-z0-9_]+\$?/g)) {
      const start = match.index ?? 0;
      if (column - 1 >= start && column - 1 <= start + match[0].length) return match[0];
    }
    return "";
  }

  /** Associe a chaque resultat de navigation la ligne de code correspondante (lue dans l'editeur ou sur le disque). */
  private async describeLocations(locations: readonly Location[]): Promise<ReferenceItem[]> {
    const project = this.store.getState().project;
    const lines = new Map<string, string[]>();
    const toRead: string[] = [];
    for (const uri of new Set(locations.map((location) => location.uri))) {
      const open = this.manager?.textOf(uri);
      if (open !== undefined) lines.set(uri, open.split("\n"));
      else toRead.push(uri);
    }
    if (project !== null && toRead.length > 0) {
      const results = await this.backend.readFiles(project.root.id, toRead, PREVIEW_MAX_BYTES).catch(() => []);
      for (const result of results) {
        if (!result.ok) continue;
        const decoded = decodeDocument(result.bytes, { legacyEncoding: project.config.encoding.legacy });
        if (decoded.kind === "text") lines.set(result.path, decoded.text.split(/\r\n|\r|\n/));
      }
    }
    return locations
      .map((location) => ({
        uri: location.uri,
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
        preview: (lines.get(location.uri)?.[location.range.start.line] ?? "").trim().slice(0, 200),
      }))
      .sort((a, b) => a.uri.localeCompare(b.uri) || a.line - b.line || a.column - b.column);
  }

  private referencesToken = 0;

  /** Cherche les references du symbole sous le curseur de l'onglet actif et les affiche dans le panneau du bas. */
  async findReferences(): Promise<void> {
    const { activePath, cursor } = this.store.getState();
    if (activePath === null || cursor === null) return;
    const token = ++this.referencesToken;
    const name = this.wordAt(activePath, cursor.line, cursor.column);
    this.store.setState({ bottomVisible: true, bottomTab: "references", references: { status: "loading", name, items: [], truncated: false } });
    const locations = await this.referencesAt(activePath, cursor.line, cursor.column, true);
    const truncated = locations.length > MAX_REFERENCES;
    const items = await this.describeLocations(truncated ? locations.slice(0, MAX_REFERENCES) : locations);
    if (token !== this.referencesToken) return; // une recherche plus recente a pris le relais
    this.store.setState({ references: { status: "ready", name, items, truncated } });
  }

  /** Ouvre une reference du panneau a sa position. */
  async openReference(item: ReferenceItem): Promise<void> {
    await this.revealPosition(item.uri, item.line, item.column);
  }

  setBottomTab(tab: BottomTab): void {
    this.store.setState({ bottomTab: tab, bottomVisible: true });
    if (tab === "report") this.ensureProjectReport();
    if (tab === "git") this.ensureGit();
  }

  // ---------------------------------------------------------------------------------------------
  // Rapport de projet (RF-015)
  // ---------------------------------------------------------------------------------------------

  /** Incremente a chaque changement des resultats du service : un rapport calcule avant est perime. */
  private languageRevision = 0;
  /** Documents ouverts dont la derniere analyse portait sur un texte different du disque. */
  private readonly analyzedDirty = new Set<string>();
  private reportToken = 0;
  private reportTimer: ReturnType<typeof setTimeout> | undefined;

  private reportVisible(): boolean {
    const state = this.store.getState();
    return state.bottomVisible && state.bottomTab === "report";
  }

  /**
   * Les resultats du service ont change (fichier modifie, indexation terminee, reglage) : le rapport affiche est perime et,
   * s'il est a l'ecran, il est recalcule apres une courte pause (une rafale de frappes n'en declenche qu'un).
   */
  private markReportStale(): void {
    this.languageRevision += 1;
    const report = this.store.getState().projectReport;
    if (report === null) return;
    if (!report.stale) this.store.setState({ projectReport: { ...report, stale: true } });
    if (this.reportVisible()) this.scheduleReportRefresh(REPORT_REFRESH_DELAY_MS);
  }

  private scheduleReportRefresh(delay: number): void {
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined;
      void this.refreshProjectReport();
    }, delay);
  }

  /** Affiche le rapport de projet dans le panneau du bas (il est calcule s'il n'existe pas encore ou s'il est perime). */
  showProjectReport(): void {
    this.setBottomTab("report");
  }

  private ensureProjectReport(): void {
    const report = this.store.getState().projectReport;
    if (report === null || report.stale || report.status === "error") void this.refreshProjectReport();
  }

  /**
   * Parmi les fichiers examines, ceux que le serveur du projet charge. Sans objet (`NO_REPORT_SCOPE`) quand aucun serveur n'est
   * reconnu, quand la portee d'index est deja « scripts charges », ou quand on ne sait pas lire ses listes de scripts : on ne
   * retire alors rien. Ne touche pas a l'etat du serveur (`emulator.loadedScripts` reste ce que la portee d'index en dit).
   */
  private async reportScope(): Promise<ReportScope> {
    const state = this.store.getState();
    const { project, emulator } = state;
    if (project === null || emulator.status !== "ready" || emulator.root === null) return NO_REPORT_SCOPE;
    if (project.config.emulator.indexScope === "loaded") return NO_REPORT_SCOPE;
    const root = project.root;
    const indexed = new Set<string>([...this.indexedStamps.keys(), ...state.tabs]);
    const loaded = await resolveLoadedScripts({
      root: emulator.root,
      renewal: emulator.renewal ?? true,
      readText: async (path) => {
        const [result] = await this.backend.readFiles(root.id, [path]).catch(() => []);
        return result?.ok === true ? new TextDecoder().decode(result.bytes) : null;
      },
      hasFile: (path) => indexed.has(path),
    }).catch(() => null);
    // Une liste vide ne dit rien du serveur (fichiers de configuration absents ou illisibles) : elle ne doit rien masquer.
    if (loaded === null || loaded.files.length === 0) return NO_REPORT_SCOPE;
    const set = new Set(loaded.files);
    let notLoaded = 0;
    for (const path of indexed) if (!set.has(path)) notLoaded += 1;
    return { loaded: set, notLoaded };
  }

  /** Calcule le rapport de projet : les problemes de tous les fichiers indexes, comme le panneau des problemes les montre. */
  async refreshProjectReport(): Promise<void> {
    const language = this.deps.language;
    if (language === undefined || language === null || this.store.getState().project === null) return;
    const token = ++this.reportToken;
    const before = this.store.getState().projectReport;
    this.store.setState({
      projectReport: {
        status: "loading",
        report: before?.report ?? null,
        stale: before?.stale ?? false,
        complete: before?.complete ?? false,
        generatedAt: before?.generatedAt ?? 0,
        scope: before?.scope ?? NO_REPORT_SCOPE,
        hideUnloaded: before?.hideUnloaded ?? true,
      },
    });
    // Les documents dont l'analyse est en attente sont envoyes d'abord : le rapport montre ce que contient l'editeur.
    await Promise.all(this.store.getState().tabs.map((path) => this.flushDocument(path)));
    if (this.reportTimer !== undefined) {
      clearTimeout(this.reportTimer);
      this.reportTimer = undefined;
    }
    const revision = this.languageRevision;
    try {
      const scope = await this.reportScope();
      // Seulement les scripts que le serveur charge (le choix par defaut) : la restriction est faite par le service, avant la
      // limite du detail, pour que le bruit des autres fichiers ne l'epuise pas.
      const only = (before?.hideUnloaded ?? true) && scope.loaded !== null && scope.notLoaded > 0 ? [...scope.loaded] : null;
      const report = await language.projectReport({ only });
      if (token !== this.reportToken) return; // un calcul plus recent a pris le relais, ou le projet a ete quitte
      this.store.setState((state) => ({
        projectReport: {
          status: "ready",
          report,
          // Si le service a change pendant le calcul, ce rapport est deja perime.
          stale: revision !== this.languageRevision,
          complete: state.indexing.status === "done",
          generatedAt: Date.now(),
          scope,
          hideUnloaded: state.projectReport?.hideUnloaded ?? true,
        },
      }));
    } catch {
      if (token !== this.reportToken) return;
      const current = this.store.getState().projectReport;
      this.store.setState({
        projectReport: {
          status: "error",
          report: current?.report ?? null,
          stale: true,
          complete: current?.complete ?? false,
          generatedAt: current?.generatedAt ?? 0,
          scope: current?.scope ?? NO_REPORT_SCOPE,
          hideUnloaded: current?.hideUnloaded ?? true,
        },
      });
    }
  }

  /** Montre (ou masque) les fichiers que le serveur ne charge pas dans le rapport de projet : il est recalcule pour l'un ou l'autre. */
  setReportHideUnloaded(hide: boolean): void {
    const current = this.store.getState().projectReport;
    if (current === null || current.hideUnloaded === hide) return;
    this.store.setState({ projectReport: { ...current, hideUnloaded: hide } });
    void this.refreshProjectReport();
  }

  /** Le rapport de projet courant en texte (Markdown simple), pour le coller dans un ticket ou un message ; `null` s'il n'y en a pas. */
  projectReportText(): string | null {
    const state = this.store.getState();
    const current = state.projectReport;
    if (current?.report == null || state.project === null) return null;
    // Le texte copie est celui que le panneau montre : le rapport calcule pour le choix courant (scripts charges ou tout).
    const { excluded } = current.report;
    return formatReportText({
      language: state.language,
      projectName: state.project.name,
      profile: state.project.config.emulator.family === "rathena" ? "rAthena" : "Hercules",
      report: current.report,
      hidden: excluded === null ? undefined : { files: excluded.files, problems: excluded.problems },
      loadIssues: state.emulator.loadIssueList,
      complete: current.complete,
      generatedAt: current.generatedAt,
    });
  }

  /** Copie le rapport de projet dans le presse-papiers (action explicite de l'utilisateur ; rien n'est ecrit sur le disque). */
  async copyProjectReport(): Promise<boolean> {
    const copied = await this.writeClipboard(this.projectReportText());
    this.notify(copied ? "success" : "error", this.t(copied ? "report.copied" : "report.copyFailed"));
    return copied;
  }

  /** Ecrit `text` dans le presse-papiers (`null` : rien a copier) ; `false` si le presse-papiers est absent ou refuse. */
  private async writeClipboard(text: string | null): Promise<boolean> {
    const clipboard = this.deps.clipboard === undefined ? (typeof navigator === "undefined" ? null : (navigator.clipboard ?? null)) : this.deps.clipboard;
    if (text === null || clipboard === null) return false;
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private pendingSync: { force: boolean } | null = null;
  private syncPromise: Promise<void> | null = null;

  /**
   * Demarrage du projet : reconnait le serveur et construit son registre de commandes (les fichiers sont analyses avec lui),
   * puis indexation initiale : lit tous les fichiers a indexer et les confie au service de langage.
   */
  private async indexProject(): Promise<void> {
    await this.setupEmulator().catch(() => undefined);
    await this.syncIndex(true);
  }

  /**
   * Reconnait le serveur du projet (racine, mode de compilation), lit les fichiers dont on tire le registre de commandes et
   * les confie au service de langage. Les fichiers deja indexes ne tiennent compte du nouveau registre qu'une fois relus :
   * l'appelant relance l'indexation.
   */
  private async setupEmulator(): Promise<void> {
    const language = this.deps.language;
    const project = this.store.getState().project;
    if (language === undefined || language === null || project === null) return;
    const token = (this.emulatorToken += 1);
    const { config, root } = project;
    const legacyEncoding = config.encoding.legacy;
    const publish = (emulator: EmulatorState): void => {
      if (token === this.emulatorToken) this.store.setState({ emulator });
    };
    const clearRegistry = async (): Promise<void> => {
      if (token !== this.emulatorToken) return;
      await language
        .setCommandSources({ family: config.emulator.family, builtinSource: null, customBuiltins: null, legacyEncoding })
        .catch(() => undefined);
      await language.setReferenceSources(emptyReferenceSources(config.emulator.family, legacyEncoding)).catch(() => undefined);
    };

    if (config.emulator.family !== "rathena") {
      await clearRegistry();
      publish({ ...NO_EMULATOR, status: "unsupported" });
      return;
    }
    const location = locateServer(config.emulator.root, this.projectFiles.keys());
    if (location.status !== "found") {
      await clearRegistry();
      publish({ ...NO_EMULATOR, status: location.status, candidates: location.status === "ambiguous" ? location.candidates : [] });
      return;
    }
    publish({ ...NO_EMULATOR, status: "loading", root: location.root, detected: location.detected });

    const pathOf = (relative: string): string => joinServerPath(location.root, relative);
    const wanted = [RATHENA_PATHS.builtinSource, RATHENA_PATHS.customBuiltins, RATHENA_PATHS.renewalHeader];
    const results: ReadFileResult[] = await this.backend.readFiles(root.id, wanted.map(pathOf)).catch(() => []);
    const bytesOf = (relative: string): Uint8Array | null => {
      const result = results.find((entry) => entry.path === pathOf(relative));
      return result?.ok === true ? result.bytes : null;
    };
    if (token !== this.emulatorToken) return;

    const summary = await language.setCommandSources({
      family: "rathena",
      builtinSource: bytesOf(RATHENA_PATHS.builtinSource),
      customBuiltins: bytesOf(RATHENA_PATHS.customBuiltins),
      projectCommands: config.commands.custom,
      legacyEncoding,
    });
    const header = bytesOf(RATHENA_PATHS.renewalHeader);
    const renewal = resolveRenewal(config.emulator.mode, header === null ? null : new TextDecoder().decode(header));
    publish({
      status: "ready",
      root: location.root,
      detected: location.detected,
      candidates: [],
      level: summary.level,
      commands: summary.commands,
      withArity: summary.withArity,
      warnings: summary.warnings,
      renewal: renewal.renewal,
      renewalSource: renewal.source,
      loadedScripts: null,
      loadIssues: 0,
      loadIssueList: [],
      catalog: null,
      catalogWarnings: [],
    });
    await this.setupReferences(token, language, location.root, renewal.renewal);
  }

  /**
   * Lit les bases du serveur (objets, monstres, constantes, index des cartes : les fichiers que celui-ci charge, selon son mode
   * de compilation) et les confie au service de langage, qui en construit le catalogue de references. Un serveur sans bases
   * (ou sans catalogue exploitable) n'est pas une erreur : il n'y a alors ni verification ni proposition.
   */
  private async setupReferences(token: number, language: LanguageService, serverRoot: string, renewal: boolean): Promise<void> {
    const project = this.store.getState().project;
    if (project === null || token !== this.emulatorToken) return;
    const { config, root } = project;
    const pathOf = (relative: string): string => joinServerPath(serverRoot, relative);
    const reader = {
      readBytes: async (paths: readonly string[]): Promise<(Uint8Array | null)[]> => {
        const results: ReadFileResult[] = await this.backend.readFiles(root.id, paths.map(pathOf)).catch(() => []);
        return paths.map((path) => {
          const result = results.find((entry) => entry.path === pathOf(path));
          return result?.ok === true ? result.bytes : null;
        });
      },
    };
    const collected = await collectRathenaDatabaseSources(reader, renewal, RATHENA_PATHS).catch(() => null);
    if (collected === null || token !== this.emulatorToken) return;
    const { sources } = collected;
    // Les cartes que le serveur charge : un NPC place sur une carte de l'index qui n'en fait pas partie est ignore sans message.
    const loadedMaps = await resolveLoadedMaps({
      root: serverRoot,
      renewal,
      readText: async (path) => {
        const [result] = await this.backend.readFiles(root.id, [path]).catch(() => []);
        return result?.ok === true ? new TextDecoder().decode(result.bytes) : null;
      },
    }).catch(() => null);
    if (token !== this.emulatorToken) return;
    const summary = await language
      .setReferenceSources({
        family: "rathena",
        items: sources.items,
        mobs: sources.mobs,
        skills: sources.skills,
        constantsYaml: sources.constantsYaml,
        constantsSource: sources.constantsSource,
        mapIndex: sources.mapIndex,
        randomOptions: sources.randomOptions,
        projectConstants: config.constants.custom,
        loadedMaps: loadedMaps === null ? null : [...loadedMaps],
        legacyEncoding: config.encoding.legacy,
      })
      .catch(() => null);
    if (summary === null || token !== this.emulatorToken) return;
    const { warnings, ...catalog } = summary;
    const empty = catalog.items + catalog.mobs + catalog.skills + catalog.maps + catalog.constants === 0;
    this.store.setState((state) => ({
      emulator: {
        ...state.emulator,
        catalog: empty ? null : catalog,
        catalogWarnings: [...collected.warnings, ...warnings],
      },
    }));
  }

  /** Recherche libre dans les bases du serveur (objets, monstres, cartes, constantes) pour retrouver et inserer une reference. */
  async searchReferences(kind: ReferenceKind, query: string, limit = 50): Promise<ReferenceHit[]> {
    const language = this.deps.language;
    if (language === undefined || language === null || this.store.getState().emulator.catalog === null) return [];
    return language.searchReferences(kind, query, limit).catch(() => []);
  }

  /**
   * Insere une reference du catalogue a la place de la selection de l'editeur, comme une saisie (annulable) : `id` ecrit
   * l'identifiant d'un objet ou d'un monstre (le style le plus courant des scripts), `name` leur AegisName. Une carte s'ecrit
   * toujours comme une chaine, une constante par son nom. Les textes entre guillemets perdent leurs guillemets quand le
   * curseur est deja dans une chaine. Retourne le texte insere, ou `null` si aucun editeur n'est affiche.
   */
  insertReference(hit: ReferenceHit, form: "id" | "name"): string | null {
    const insert = this.deps.editor.insertAtCursor;
    if (insert === undefined) return null;
    const quoted = hit.kind === "map" || (hit.kind !== "constant" && (form === "name" || hit.id === null));
    const name = quoted ? JSON.stringify(hit.name) : hit.name;
    const text = hit.kind !== "map" && hit.kind !== "constant" && form === "id" && hit.id !== null ? String(hit.id) : name;
    return insert.call(this.deps.editor, text, quoted ? name.slice(1, -1) : undefined) ? text : null;
  }

  /**
   * Fichiers de script que le serveur charge reellement, parmi ceux du projet. `null` si le serveur n'est pas reconnu
   * (l'appelant retombe alors sur les motifs de `sources`).
   */
  private async loadedScriptSet(root: ApprovedRoot): Promise<readonly string[] | null> {
    const emulator = this.store.getState().emulator;
    if (emulator.status !== "ready" || emulator.root === null) return null;
    const serverRoot = emulator.root;
    const loaded = await resolveLoadedScripts({
      root: serverRoot,
      renewal: emulator.renewal ?? true,
      readText: async (path) => {
        const [result] = await this.backend.readFiles(root.id, [path]).catch(() => []);
        return result?.ok === true ? new TextDecoder().decode(result.bytes) : null;
      },
      hasFile: (path) => this.projectFiles.has(path),
    });
    this.store.setState((state) => ({
      emulator: {
        ...state.emulator,
        loadedScripts: loaded.files.length,
        loadIssues: loaded.report.issues.length,
        loadIssueList: describeLoadIssues(loaded.report.issues, serverRoot),
      },
    }));
    return loaded.files;
  }

  /**
   * Ordre dans lequel le serveur charge ses scripts, pour une portee d'index qui ne l'a pas deja lu (`sources`) : `null` sans
   * serveur reconnu ou quand on ne sait pas lire ses listes de scripts (une liste vide ne dit rien du serveur). L'existence des
   * fichiers n'a pas a etre verifiee : seul l'ordre relatif des fichiers indexes compte, un fichier absent n'a aucun rang utile.
   */
  private async serverLoadOrder(root: ApprovedRoot): Promise<readonly string[] | null> {
    const emulator = this.store.getState().emulator;
    if (emulator.status !== "ready" || emulator.root === null) return null;
    const loaded = await resolveLoadedScripts({
      root: emulator.root,
      renewal: emulator.renewal ?? true,
      readText: async (path) => {
        const [result] = await this.backend.readFiles(root.id, [path]).catch(() => []);
        return result?.ok === true ? new TextDecoder().decode(result.bytes) : null;
      },
      hasFile: () => true,
    }).catch(() => null);
    return loaded === null || loaded.files.length === 0 ? null : loaded.files;
  }

  /**
   * Confie au service l'ordre de chargement des scripts (`null` : inconnu). Renvoie `true` quand il a change : les diagnostics des
   * documents ouverts et le rapport de projet doivent alors etre refaits (`RA0016` en depend).
   */
  private async applyLoadOrder(language: LanguageService, order: readonly string[] | null): Promise<boolean> {
    const previous = this.loadOrder;
    const same =
      previous === order ||
      (previous !== null && order !== null && previous.length === order.length && previous.every((path, index) => path === order[index]));
    if (same) return false;
    // Retenu avant l'attente : si le projet est quitte entre-temps, sa remise a zero (qui suit la requete) l'efface a juste titre.
    this.loadOrder = order;
    await language.setLoadOrder(order);
    return true;
  }

  /**
   * Met l'index du projet en accord avec le disque : lit les fichiers nouveaux ou modifies (taille/date), retire ceux qui
   * ont disparu, sans toucher aux documents ouverts (le texte de l'editeur fait foi). `force` relit tout.
   */
  private syncIndex(force = false): Promise<void> {
    const language = this.deps.language;
    if (language === undefined || language === null || this.store.getState().project === null) return Promise.resolve();
    if (this.syncingIndex) {
      this.pendingSync = { force: force || (this.pendingSync?.force ?? false) };
      return this.syncPromise ?? Promise.resolve();
    }
    this.syncingIndex = true;
    const run: Promise<void> = this.syncLoop(language, force).finally(() => {
      this.syncingIndex = false;
      if (this.syncPromise === run) this.syncPromise = null;
    });
    this.syncPromise = run;
    return run;
  }

  private async syncLoop(language: LanguageService, force: boolean): Promise<void> {
    let request: { force: boolean } | null = { force };
    while (request !== null) {
      this.pendingSync = null;
      await this.runIndexSync(language, request.force).catch(() => {
        this.store.setState((state) => ({ indexing: { ...state.indexing, status: "error" } }));
        this.markReportStale();
        this.logEvent("error", "INDEX_ERROR");
      });
      request = this.pendingSync;
    }
  }

  /** Resolu quand l'indexation du projet (et les resynchronisations en attente) est terminee. */
  async whenIndexed(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    while (this.syncPromise !== null) await this.syncPromise;
  }

  private async runIndexSync(language: LanguageService, force: boolean): Promise<void> {
    const token = this.indexToken;
    const startedAt = performance.now();
    const project = this.store.getState().project;
    if (project === null) return;
    const { root, config } = project;
    const stamp = (entry: { size: number; modifiedMs: number }): string => `${entry.size}:${entry.modifiedMs}`;

    if (force) {
      // Index partiel pendant la relecture : ni verification entre fichiers ni commande inconnue (elle pourrait etre une
      // fonction d'un fichier pas encore lu) tant qu'il n'est pas complet.
      await language.setOptions({ crossFile: "off", unknownCommands: "off", emulator: config.emulator.family });
      this.store.setState((state) => ({ indexing: { ...state.indexing, status: "running", done: 0, total: 0, skipped: 0 } }));
    }
    // Portee « scripts charges par le serveur » : tout le projet est parcouru, puis restreint aux fichiers que le serveur
    // charge. Sans serveur reconnu, on retombe sur les motifs de `sources`.
    const loadedScope = config.emulator.indexScope === "loaded" && this.store.getState().emulator.status === "ready";
    const scan = await this.backend.scanProject(root.id, loadedScope ? { exclude: config.exclude } : { include: config.sources, exclude: config.exclude });
    if (token !== this.indexToken) return;

    let files = scan.entries.filter((entry) => entry.kind === "file");
    // Ordre de chargement du serveur : lu avec la liste des scripts charges, ou a part quand l'index suit les motifs de `sources`.
    let order: readonly string[] | null = null;
    if (loadedScope) {
      this.projectFiles = new Map(files.map((entry) => [entry.path, entry]));
      const loaded = await this.loadedScriptSet(root);
      if (token !== this.indexToken) return;
      if (loaded !== null) {
        const set = new Set(loaded);
        files = files.filter((entry) => set.has(entry.path));
        // Une liste vide ne dit rien du serveur (fichiers de configuration absents ou illisibles) : pas d'ordre.
        order = loaded.length > 0 ? loaded : null;
      }
    } else {
      order = await this.serverLoadOrder(root);
      if (token !== this.indexToken) return;
    }
    const present = new Set(files.map((entry) => entry.path));
    const open = new Set(this.store.getState().tabs);
    const removed = [...this.indexedStamps.keys()].filter((path) => !present.has(path) && !open.has(path));
    const changed = files.filter((entry) => force || this.indexedStamps.get(entry.path) !== stamp(entry));
    const toRead = changed.filter((entry) => !open.has(entry.path));

    if (removed.length > 0) {
      await language.removeFiles(removed);
      for (const path of removed) this.indexedStamps.delete(path);
    }
    if (toRead.length > 0) {
      this.store.setState((state) => ({ indexing: { ...state.indexing, status: "running", done: 0, total: toRead.length, skipped: 0 } }));
    }
    let done = 0;
    let skipped = 0;
    for (let start = 0; start < toRead.length; start += INDEX_BATCH_SIZE) {
      if (token !== this.indexToken) return;
      const batch = toRead.slice(start, start + INDEX_BATCH_SIZE);
      const results = await this.backend.readFiles(root.id, batch.map((entry) => entry.path));
      const inputs: IndexFileInput[] = [];
      for (const result of results) {
        if (result.ok) inputs.push({ uri: result.path, bytes: result.bytes });
        else skipped += 1;
      }
      const outcome = await language.indexFiles(inputs, config.encoding.legacy);
      skipped += outcome.skipped.length;
      for (const entry of batch) this.indexedStamps.set(entry.path, stamp(entry));
      done += batch.length;
      this.store.setState((state) => ({ indexing: { ...state.indexing, status: "running", done, total: toRead.length, skipped } }));
    }
    // Un document ouvert n'est pas relu (son texte fait foi) mais son empreinte est memorisee.
    for (const entry of changed) if (open.has(entry.path)) this.indexedStamps.set(entry.path, stamp(entry));
    if (token !== this.indexToken) return;

    const orderChanged = await this.applyLoadOrder(language, order);
    await this.applyLanguageOptions();
    const stats = await language.stats();
    if (token !== this.indexToken) return;
    this.store.setState({
      indexing: { status: "done", done, total: toRead.length, skipped, files: stats.files, functions: stats.functions, npcs: stats.npcs },
    });
    if (force || orderChanged || removed.length > 0 || toRead.length > 0) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      this.logEvent("info", "INDEX_DONE", `files=${stats.files} functions=${stats.functions} npcs=${stats.npcs} ms=${elapsedMs}`);
      this.refreshOpenDiagnostics();
      // L'index a change : le rapport de projet affiche n'est plus a jour.
      this.markReportStale();
    }
  }

  /** Relit sur le disque et reindexe des fichiers (ex. document ferme sans enregistrer). */
  private async reindexFromDisk(paths: readonly string[]): Promise<void> {
    const language = this.deps.language;
    const project = this.store.getState().project;
    if (language === undefined || language === null || project === null) return;
    const results = await this.backend.readFiles(project.root.id, paths);
    const inputs: IndexFileInput[] = results.flatMap((result) => (result.ok ? [{ uri: result.path, bytes: result.bytes }] : []));
    if (inputs.length > 0) await language.indexFiles(inputs, project.config.encoding.legacy);
    this.markReportStale();
  }

  /** Applique au service les options du projet (verifications entre fichiers, commandes inconnues). */
  private async applyLanguageOptions(): Promise<void> {
    const project = this.store.getState().project;
    if (this.deps.language === undefined || this.deps.language === null || project === null) return;
    await this.deps.language.setOptions({
      crossFile: project.config.validation.crossFile,
      unknownCommands: project.config.validation.unknownCommands,
      unknownReferences: project.config.validation.unknownReferences,
      emulator: project.config.emulator.family,
    });
  }

  private refreshOpenDiagnostics(): void {
    for (const path of this.store.getState().tabs) this.scheduleDiagnostics(path, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Enregistrement et conflits
  // ---------------------------------------------------------------------------------------------

  async saveActive(): Promise<void> {
    const path = this.store.getState().activePath;
    if (path !== null) await this.save(path);
  }

  async save(path: string, options: { overwrite?: boolean } = {}): Promise<SaveOutcome | undefined> {
    const manager = this.manager;
    if (manager === null) return undefined;
    const name = lastSegment(path);
    const outcome = await manager.save(path, options);
    this.handleSaveOutcome(path, name, outcome);
    return outcome;
  }

  private handleSaveOutcome(path: string, name: string, outcome: SaveOutcome): void {
    switch (outcome.status) {
      case "saved":
        this.notify("success", this.t("file.saved", { name }));
        this.markGitStale();
        break;
      case "unchanged":
        break;
      case "unencodable": {
        const info = this.manager?.info(path);
        this.openDialog({
          kind: "unencodable",
          path,
          chars: [...new Set(outcome.unencodable.map((item) => item.char))].slice(0, 12),
          encoding: info?.encoding ?? "",
        });
        break;
      }
      case "conflict":
        this.openDialog({ kind: "conflict", path, deleted: false });
        this.logEvent("warn", "SAVE_CONFLICT", "deleted=false");
        break;
      case "deleted":
        this.openDialog({ kind: "conflict", path, deleted: true });
        this.logEvent("warn", "SAVE_CONFLICT", "deleted=true");
        break;
      case "error":
        this.notify("error", this.t("file.saveError", { name, reason: this.describe(outcome.error) }));
        this.logEvent("error", "SAVE_FAILED", `code=${outcome.error.code}`);
        break;
    }
  }

  async saveAll(): Promise<void> {
    const manager = this.manager;
    if (manager === null) return;
    const outcomes = await manager.saveAll();
    let saved = 0;
    for (const [path, outcome] of outcomes) {
      if (outcome.status === "saved") saved += 1;
      else this.handleSaveOutcome(path, lastSegment(path), outcome);
    }
    if (saved > 0) {
      this.notify("success", this.t("file.saved", { name: `${saved}` }));
      this.markGitStale();
    }
  }

  async resolveConflict(path: string, choice: "overwrite" | "reload" | "compare" | "cancel"): Promise<void> {
    this.closeDialog();
    if (choice === "overwrite") await this.save(path, { overwrite: true });
    else if (choice === "reload") await this.manager?.reloadFromDisk(path);
    else if (choice === "compare") this.openDialog({ kind: "diff", path });
  }

  async resolveUnencodable(path: string, choice: "convert" | "edit"): Promise<void> {
    this.closeDialog();
    if (choice === "convert") {
      this.manager?.changeEncoding(path, "utf-8", false);
      await this.save(path);
    }
  }

  async reloadFromDisk(path: string): Promise<void> {
    await this.manager?.reloadFromDisk(path);
  }

  /** Contenu actuel du disque (texte normalise en LF), pour la comparaison. */
  async loadDiskText(path: string): Promise<string | null> {
    const project = this.store.getState().project;
    if (project === null) return null;
    const [result] = await this.backend.readFiles(project.root.id, [path]);
    if (result === undefined || !result.ok) return null;
    const decoded = decodeDocument(result.bytes, { legacyEncoding: project.config.encoding.legacy });
    return decoded.kind === "text" ? normalizeToLf(decoded.text) : null;
  }

  /** Versions anterieures conservees par l'historique local (la plus recente d'abord). */
  async historyEntries(path: string): Promise<readonly HistoryEntry[]> {
    const project = this.store.getState().project;
    if (project === null) return [];
    return this.backend.historyList(project.root.id, path).catch(() => []);
  }

  /** Contenu d'une version de l'historique local (texte normalise en LF). */
  async loadHistoryText(path: string, id: string): Promise<string | null> {
    const project = this.store.getState().project;
    if (project === null) return null;
    try {
      const bytes = await this.backend.historyRead(project.root.id, path, id);
      const decoded = decodeDocument(bytes, { legacyEncoding: project.config.encoding.legacy });
      return decoded.kind === "text" ? normalizeToLf(decoded.text) : null;
    } catch {
      return null;
    }
  }

  /** Texte courant (LF) d'un document ouvert. */
  currentText(path: string): string | null {
    return this.manager?.textOf(path) ?? null;
  }

  async resolveUnsaved(path: string, choice: "save" | "discard" | "cancel"): Promise<void> {
    this.closeDialog();
    if (choice === "cancel") return;
    if (choice === "save") {
      const outcome = await this.save(path);
      if (outcome === undefined || (outcome.status !== "saved" && outcome.status !== "unchanged")) return;
    }
    await this.closeTab(path);
  }

  // ---------------------------------------------------------------------------------------------
  // Fermeture de l'application
  // ---------------------------------------------------------------------------------------------

  async requestExit(): Promise<void> {
    const dirty = this.manager?.dirtyPaths() ?? [];
    if (dirty.length === 0) {
      await this.backend.confirmExit();
      return;
    }
    this.openDialog({ kind: "exit", paths: dirty, purpose: "exit" });
  }

  /** Decision de l'utilisateur sur des modifications non enregistrees avant de fermer l'application ou le projet. */
  async resolveExit(choice: "save" | "discard" | "cancel"): Promise<void> {
    const dialog = this.store.getState().dialog;
    const purpose = dialog?.kind === "exit" ? dialog.purpose : "exit";
    this.closeDialog();

    const finish = async (proceed: boolean): Promise<void> => {
      if (purpose === "leave-project") {
        const resolver = this.leaveResolver;
        this.leaveResolver = null;
        resolver?.(proceed);
      } else if (proceed) {
        await this.backend.setDirty(false).catch(() => undefined);
        await this.backend.confirmExit();
      }
    };

    if (choice === "cancel") return finish(false);
    const manager = this.manager;
    if (choice === "save" && manager !== null) {
      await manager.saveAll();
      const remaining = manager.dirtyPaths();
      if (remaining.length > 0) {
        // Un enregistrement a echoue ou demande une decision : on n'abandonne ni ne ferme rien.
        for (const path of remaining) {
          this.openDialog({ kind: "conflict", path, deleted: manager.info(path)?.external === "deleted" });
        }
        return finish(false);
      }
    }
    if (choice === "discard" && manager !== null) {
      for (const path of manager.dirtyPaths()) await manager.close(path);
    }
    return finish(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Recuperation
  // ---------------------------------------------------------------------------------------------

  async restoreRecovered(path: string): Promise<void> {
    const project = this.store.getState().project;
    const manager = this.manager;
    if (project === null || manager === null) return;
    try {
      await this.deps.editor.ready?.();
      const { meta, data } = await this.backend.recoveryRead(project.root.id, path);
      const text = new TextDecoder().decode(data);
      const outcome = await manager.restoreRecovered(path, text, meta);
      if (outcome.ok) {
        this.store.setState((state) => ({
          tabs: state.tabs.includes(path) ? state.tabs : [...state.tabs, path],
          activePath: path,
          docs: { ...state.docs, [path]: outcome.info },
          expanded: [...new Set([...state.expanded, ...ancestorDirectories(path)])],
        }));
        this.scheduleDiagnostics(path, 0);
      }
    } catch (error) {
      this.notify("error", this.describe(toBackendError(error)));
    }
    this.removeRecoveryItem(path);
  }

  async discardRecovered(path: string): Promise<void> {
    const project = this.store.getState().project;
    if (project !== null) await this.backend.recoveryClear(project.root.id, path).catch(() => undefined);
    this.removeRecoveryItem(path);
  }

  private removeRecoveryItem(path: string): void {
    const dialog = this.store.getState().dialog;
    if (dialog === null || dialog.kind !== "recovery") return;
    const items = dialog.items.filter((item) => item.path !== path);
    if (items.length === 0) this.closeDialog();
    else this.replaceDialog({ kind: "recovery", items });
  }

  async resolveAllRecovery(choice: "restore" | "discard"): Promise<void> {
    const dialog = this.store.getState().dialog;
    if (dialog === null || dialog.kind !== "recovery") return;
    for (const item of dialog.items) {
      if (choice === "restore") await this.restoreRecovered(item.path);
      else await this.discardRecovered(item.path);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Creation de fichiers et configuration du projet
  // ---------------------------------------------------------------------------------------------

  requestNewFile(directory = ""): void {
    this.openDialog({ kind: "new-file", directory });
  }

  async createFile(relativePath: string): Promise<boolean> {
    const project = this.store.getState().project;
    if (project === null) return false;
    const cleaned = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const dialog = this.store.getState().dialog;
    const directory = dialog?.kind === "new-file" ? dialog.directory : "";
    if (cleaned === "") return false;
    const outcome = await this.createEmptyFile(project.root.id, cleaned);
    if (outcome !== "created") {
      this.replaceDialog({ kind: "new-file", directory, error: outcome });
      return false;
    }
    this.closeDialog();
    await this.refreshTree();
    await this.openFile(cleaned);
    return true;
  }

  /** Cree un fichier vide (et ses dossiers) sans jamais ecraser un fichier existant. */
  private async createEmptyFile(rootId: string, cleaned: string): Promise<"created" | "exists" | "invalid"> {
    try {
      const segments = cleaned.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        await this.backend.createDirectory(rootId, segments.slice(0, index).join("/"));
      }
      await this.backend.writeFile(rootId, cleaned, new Uint8Array(), { kind: "mustNotExist" }, false);
      return "created";
    } catch (error) {
      return toBackendError(error).code === "already_exists" ? "exists" : "invalid";
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Deploiement vers un dossier (RF-018, DEC-040)
  // ---------------------------------------------------------------------------------------------

  openDeploy(): void {
    this.openDialog({ kind: "deploy" });
  }

  /** Choisit la destination dans la boite de dialogue du systeme ; la destination ne peut pas etre le projet lui-meme. */
  async pickDeployDestination(): Promise<{ readonly root: ApprovedRoot } | { readonly error: "same-as-project" } | null> {
    const project = this.store.getState().project;
    if (project === null) return null;
    try {
      const root = await this.backend.pickDestinationFolder();
      if (root === null) return null;
      return root.id === project.root.id ? { error: "same-as-project" } : { root };
    } catch (error) {
      this.notify("error", this.describe(toBackendError(error)));
      return null;
    }
  }

  /** Fichiers du projet sous `prefix` (un dossier relatif ; vide : tout le projet), sans les dossiers de l'outil ni de Git. */
  deployCandidates(prefix: string): string[] {
    const tree = this.store.getState().project?.tree;
    if (tree === undefined) return [];
    const wanted = prefix.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const paths: string[] = [];
    const visit = (node: TreeNode): void => {
      if (node.kind === "file") {
        if (wanted === "" || node.path.startsWith(`${wanted}/`)) paths.push(node.path);
        return;
      }
      if (node.path !== "" && (lastSegment(node.path) === ".git" || lastSegment(node.path) === PROJECT_CONFIG_DIRECTORY)) return;
      for (const child of node.children) visit(child);
    };
    visit(tree);
    return paths.sort();
  }

  /** Nombre d'erreurs d'analyse locale par fichier (le service de langage ; vide s'il n'est pas disponible). */
  private async analysisErrors(paths: readonly string[]): Promise<Map<string, number>> {
    try {
      const report = await this.deps.language?.projectReport({ only: [...paths] });
      return new Map((report?.files ?? []).filter((file) => file.errors > 0).map((file) => [file.uri, file.errors]));
    } catch {
      return new Map();
    }
  }

  /** Le plan (dry-run) du deploiement de `prefix` vers `destination` : rien n'est ecrit. `null` si la lecture a echoue (dit par une notification). */
  async prepareDeployment(destination: ApprovedRoot, prefix: string): Promise<DeployPlanView | null> {
    const project = this.store.getState().project;
    if (project === null) return null;
    const roots = { projectRootId: project.root.id, destinationRootId: destination.id };
    try {
      const preparation = await prepareDeploy(this.backend, roots, this.deployCandidates(prefix));
      const errorCounts = await this.analysisErrors(preparation.plan.actions.map((action) => action.path));
      return { preparation, errorCounts, last: await readLastDeploy(this.backend, roots) };
    } catch (error) {
      this.notify("error", this.describe(toBackendError(error)));
      return null;
    }
  }

  /**
   * Execute un plan que l'utilisateur a confirme : sauvegarde ce qui sera remplace, ecrit, verifie, puis note le resultat. Refuse un plan dont
   * des fichiers a envoyer ont des erreurs d'analyse, sauf si l'utilisateur l'a decide (`allowErrors`).
   */
  async runDeployment(
    destination: ApprovedRoot,
    view: DeployPlanView,
    options: { overwriteConflicts: boolean; allowErrors: boolean; onProgress?: (done: number, total: number) => void },
  ): Promise<{ readonly stamp: string; readonly report: DeployReport } | null> {
    const project = this.store.getState().project;
    if (project === null) return null;
    if (!options.allowErrors && findBlockers(view.preparation.plan, view.errorCounts, options.overwriteConflicts).length > 0) {
      this.notify("error", this.t("deploy.blocked"));
      return null;
    }
    const roots = { projectRootId: project.root.id, destinationRootId: destination.id };
    try {
      const done = await runDeploy(this.backend, roots, view.preparation, { overwriteConflicts: options.overwriteConflicts, now: Date.now, onProgress: options.onProgress });
      const counts = countResults(done.report);
      this.logEvent(
        done.report.complete ? "info" : "warn",
        "DEPLOY_DONE",
        `created=${counts.created} updated=${counts.updated} overwritten=${counts.overwritten} unchanged=${counts.unchanged} failed=${counts.failed} skipped=${counts.skipped}`,
      );
      void this.refreshTree();
      return done;
    } catch (error) {
      this.notify("error", this.describe(toBackendError(error)));
      return null;
    }
  }

  /** Remet en place ce que le dernier deploiement a remplace (jamais ce qui a ete modifie depuis). */
  async rollbackDeployment(destination: ApprovedRoot, last: { readonly stamp: string; readonly report: DeployReport }): Promise<RollbackReport | null> {
    const project = this.store.getState().project;
    if (project === null) return null;
    try {
      const result = await rollbackLast(this.backend, { projectRootId: project.root.id, destinationRootId: destination.id }, last);
      this.logEvent(result.failed.length === 0 ? "info" : "warn", "DEPLOY_ROLLBACK", `restored=${result.restored.length} failed=${result.failed.length}`);
      return result;
    } catch (error) {
      this.notify("error", this.describe(toBackendError(error)));
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Git, en lecture seule (RF-019, DEC-039)
  // ---------------------------------------------------------------------------------------------

  private gitToken = 0;
  /** Des fichiers ont change depuis la derniere lecture de l'etat Git. */
  private gitStale = false;
  private gitTimer: ReturnType<typeof setTimeout> | undefined;

  private gitVisible(): boolean {
    const state = this.store.getState();
    return state.bottomVisible && state.bottomTab === "git";
  }

  /** Les fichiers du projet ont change : la lecture Git est perimee ; si l'onglet Git est affiche, elle est relue apres une courte pause. */
  private markGitStale(): void {
    if (this.store.getState().git.status !== "ready") return;
    this.gitStale = true;
    if (this.gitVisible()) {
      if (this.gitTimer !== undefined) clearTimeout(this.gitTimer);
      this.gitTimer = setTimeout(() => {
        this.gitTimer = undefined;
        void this.refreshGit();
      }, GIT_REFRESH_DELAY_MS);
    }
  }

  private ensureGit(): void {
    const git = this.store.getState().git;
    if (git.status === "off") void this.refreshGit({ ask: true });
    else if (git.status === "ready" && this.gitStale) void this.refreshGit();
  }

  /** Affiche l'onglet Git du panneau du bas ; la premiere fois, demande l'accord de l'utilisateur pour ce projet. */
  showGit(): void {
    this.setBottomTab("git");
  }

  /**
   * Lit l'etat Git du projet (le programme `git` de la machine, en lecture seule). `grantTrust` : l'utilisateur vient de l'autoriser pour
   * ce projet ; `ask` : si Git n'est pas encore autorise, ouvre la boite de dialogue qui le demande. Rien n'est lance sans l'une de ces
   * deux actions de l'utilisateur.
   */
  async refreshGit(options: { grantTrust?: boolean; ask?: boolean } = {}): Promise<void> {
    const project = this.store.getState().project;
    if (project === null) return;
    const token = ++this.gitToken;
    this.gitStale = false;
    const before = this.store.getState().git;
    this.store.setState({ git: { status: "loading", data: before.status === "ready" || before.status === "loading" ? before.data : null } });
    try {
      const data = await this.backend.gitStatus(project.root.id, options.grantTrust === true);
      if (token !== this.gitToken) return;
      this.store.setState({ git: { status: "ready", data, refreshedAt: Date.now() } });
    } catch (error) {
      if (token !== this.gitToken) return;
      const code = toBackendError(error).code;
      const reason = GIT_UNAVAILABLE_REASONS.find((known) => known === code) ?? "failed";
      this.store.setState({ git: { status: "unavailable", reason } });
      if (reason === "not_trusted" && options.ask === true) this.requestGitTrust();
    }
  }

  /** Demande a l'utilisateur d'autoriser Git pour ce projet (rien n'est lance avant sa reponse). */
  requestGitTrust(): void {
    const open = this.store.getState().dialog?.kind === "git-trust" || this.store.getState().dialogQueue.some((request) => request.kind === "git-trust");
    if (!open) this.openDialog({ kind: "git-trust" });
  }

  /** L'utilisateur autorise Git pour ce projet. */
  async confirmGitTrust(): Promise<void> {
    this.closeDialog();
    await this.refreshGit({ grantTrust: true });
  }

  /** Version, dans `HEAD`, d'un fichier du projet (texte normalise en LF), ou pourquoi elle n'est pas disponible. */
  async loadGitHeadText(path: string): Promise<GitHeadText> {
    const project = this.store.getState().project;
    if (project === null) return { kind: "error", reason: "failed" };
    try {
      const bytes = await this.backend.gitHeadFile(project.root.id, path);
      const decoded = decodeDocument(bytes, { legacyEncoding: project.config.encoding.legacy });
      return decoded.kind === "text" ? { kind: "text", text: normalizeToLf(decoded.text) } : { kind: "error", reason: "failed" };
    } catch (error) {
      const code = toBackendError(error).code;
      if (code === "not_in_head") return { kind: "new" };
      return { kind: "error", reason: GIT_UNAVAILABLE_REASONS.find((known) => known === code) ?? "failed" };
    }
  }

  /** Compare un document (par defaut l'actif) avec sa version dans `HEAD` ; demande d'abord l'accord de l'utilisateur si Git n'est pas autorise. */
  async compareWithGit(path: string | null = this.store.getState().activePath): Promise<void> {
    if (path === null) return;
    if (this.store.getState().git.status !== "ready") await this.refreshGit({ ask: true });
    if (this.store.getState().git.status !== "ready") return;
    // La comparaison est celle d'un document : « ma version » est le texte ouvert dans l'editeur, que l'on ouvre s'il ne l'est pas.
    if (!(await this.openFile(path))) return;
    this.openDialog({ kind: "diff", path, source: "git" });
  }

  // ---------------------------------------------------------------------------------------------
  // Assistants de NPC (RF-017)
  // ---------------------------------------------------------------------------------------------

  /** Ouvre l'assistant de NPC sur l'assistant `wizard` (le dialogue retombe sur le premier assistant verifie pour le profil du projet). */
  openNpcWizard(wizard: WizardId = "warp-portal"): void {
    this.openDialog({ kind: "npc-wizard", wizard });
  }

  openVisualBuilder(): boolean {
    if (this.store.getState().project === null) {
      this.notify("warning", this.t("visualBuilder.noProject"));
      return false;
    }
    this.openDialog({ kind: "visual-builder" });
    return true;
  }

  /**
   * Diagnostics du script produit par un assistant, analyse comme un fichier du projet (syntaxe, commandes connues du serveur,
   * references du catalogue) sans l'indexer. `null` : le service de langage n'est pas disponible ou a echoue.
   */
  async previewWizardDiagnostics(source: string): Promise<readonly ParseDiagnostic[] | null> {
    try {
      return (await this.deps.language?.previewDiagnostics(source)) ?? null;
    } catch {
      return null;
    }
  }

  async copyWizardScript(source: string): Promise<boolean> {
    const copied = await this.writeClipboard(source);
    this.notify(copied ? "success" : "error", this.t(copied ? "wizard.copied" : "wizard.copyFailed"));
    return copied;
  }

  /**
   * Ajoute le script a la fin du document affiche, apres une ligne vide, comme une saisie annulable : le document devient
   * "modifie" et rien n'est ecrit sur le disque avant l'enregistrement explicite. Ferme l'assistant et montre le script ajoute.
   */
  insertWizardScript(source: string): boolean {
    const path = this.store.getState().activePath;
    const text = path === null ? undefined : this.manager?.textOf(path);
    const append = this.deps.editor.appendText;
    if (path === null || text === undefined || append === undefined) {
      this.notify("error", this.t("wizard.noDocument"));
      return false;
    }
    const lead = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    if (!append.call(this.deps.editor, path, lead + source)) {
      this.notify("error", this.t("wizard.noDocument"));
      return false;
    }
    this.closeDialog();
    this.notify("success", this.t("wizard.inserted", { name: path.slice(path.lastIndexOf("/") + 1) }));
    void this.revealPosition(path, (text + lead).split("\n").length, 1);
    return true;
  }

  /**
   * Cree le fichier `relativePath` (vide, sans jamais ecraser un fichier existant), l'ouvre et y place le script de l'assistant :
   * le contenu reste non enregistre (Ctrl+S), comme pour tout fichier neuf. `exists` et `invalid` : rien n'est cree.
   */
  async createWizardFile(relativePath: string, source: string): Promise<"created" | "exists" | "invalid"> {
    const project = this.store.getState().project;
    const cleaned = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (project === null || cleaned === "" || cleaned.endsWith("/")) return "invalid";
    const outcome = await this.createEmptyFile(project.root.id, cleaned);
    if (outcome !== "created") return outcome;
    this.closeDialog();
    await this.refreshTree();
    const name = cleaned.slice(cleaned.lastIndexOf("/") + 1);
    await this.openFile(cleaned);
    if (this.manager?.setContent(cleaned, source) !== true) {
      this.notify("error", this.t("wizard.fillFailed", { name }));
      return "created";
    }
    this.scheduleDiagnostics(cleaned, 0);
    this.notify("success", this.t("wizard.created", { name }));
    void this.revealPosition(cleaned, 1, 1);
    return "created";
  }

  // ---------------------------------------------------------------------------------------------
  // Editeur visuel de dialogues (RF-020 a RF-023)
  // ---------------------------------------------------------------------------------------------

  /**
   * Ouvre l'editeur visuel sur le NPC que le curseur du document affiche designe (a defaut le dernier qui precede, ou le premier). Le
   * dialogue travaille sur une copie du texte : le document n'est modifie qu'apres « Appliquer ».
   */
  openVisual(): boolean {
    const { activePath: path, cursor } = this.store.getState();
    const text = path === null ? undefined : this.manager?.textOf(path);
    if (path === null || text === undefined) {
      this.notify("warning", this.t("visual.noDocument"));
      return false;
    }
    const offset = cursor === null ? 0 : new LineIndex(text).offsetAt({ line: cursor.line - 1, character: cursor.column - 1 }, text);
    const npc = visualNpcAt(text, offset);
    if (npc === null) {
      this.notify("info", this.t("visual.noNpc"));
      return false;
    }
    this.openDialog({ kind: "visual", path, declarationStart: npc.declarationStart, baseText: text });
    return true;
  }

  /**
   * Applique au document le resultat de l'editeur visuel : un seul remplacement (le plus petit qui passe de `baseText` a `newText`), donc
   * une seule etape d'annulation ; le document est marque modifie et rien n'est ecrit sur le disque avant l'enregistrement. Refuse si le
   * document a change depuis l'ouverture du dialogue : les positions calculees ne vaudraient plus.
   */
  applyVisualEdit(path: string, baseText: string, newText: string): boolean {
    const current = this.manager?.textOf(path);
    const apply = this.deps.editor.applyEdit;
    if (current === undefined || apply === undefined) {
      this.notify("error", this.t("visual.noDocument"));
      return false;
    }
    if (current !== baseText) {
      this.notify("error", this.t("visual.stale"));
      return false;
    }
    const edit = minimalEdit(baseText, newText);
    if (edit !== null && !apply.call(this.deps.editor, path, edit.start, edit.end, edit.text)) {
      this.notify("error", this.t("visual.noDocument"));
      return false;
    }
    this.closeDialog();
    if (edit !== null) this.notify("success", this.t("visual.applied", { name: path.slice(path.lastIndexOf("/") + 1) }));
    return true;
  }

  openSimulation(): void {
    const { activePath, cursor, project } = this.store.getState();
    const source = activePath === null ? null : this.currentText(activePath);
    if (source === null || source.length > MAX_SIMULATION_SOURCE) {
      this.notify("warning", this.t("sim.invalidSource"));
      return;
    }
    if (project?.config.emulator.family === "hercules") {
      this.notify("warning", this.t("sim.profile"));
      return;
    }
    const offset = cursor === null ? 0 : new LineIndex(source).offsetAt({ line: cursor.line - 1, character: cursor.column - 1 }, source);
    // Le dialogue joue aussi un NPC dont le corps n'est pas fermé ou qui a une erreur de syntaxe (l'analyseur est tolérant) :
    // ce qu'il n'a pas compris est noté dans la transcription, jamais refusé.
    const npc = npcAt(parse(source), offset);
    if (npc === null) {
      this.notify("info", this.t("sim.noNpc"));
      return;
    }
    this.openDialog({ kind: "simulation", declarationStart: npc.range.start, source });
  }

  /**
   * Cherche une fonction globale dans tout le projet : l'index du langage dit quel fichier la déclare, puis ce fichier est lu (le
   * texte en cours d'un onglet ouvert, sinon le disque, par le service de fichiers du projet) et analysé. La simulation s'en sert pour
   * exécuter `callfunc "F_Nom"` même quand la fonction est définie ailleurs que dans le fichier du NPC. Un fichier n'est lu et
   * analysé qu'une fois par recherche ; une fonction que l'index ne connaît pas reste inconnue (`undefined`).
   */
  createFunctionLookup(): FunctionLookup {
    interface Library {
      readonly text: string;
      readonly functions: ReadonlyMap<string, FunctionDeclaration>;
    }
    const libraries = new Map<string, Promise<Library | null>>();
    const read = async (uri: string): Promise<Library | null> => {
      let text = this.manager?.textOf(uri);
      if (text === undefined) {
        const project = this.store.getState().project;
        if (project === null) return null;
        const [result] = await this.backend.readFiles(project.root.id, [uri], PREVIEW_MAX_BYTES).catch(() => []);
        if (result?.ok !== true) return null;
        const decoded = decodeDocument(result.bytes, { legacyEncoding: project.config.encoding.legacy });
        if (decoded.kind !== "text") return null;
        text = normalizeToLf(decoded.text);
      }
      const functions = new Map<string, FunctionDeclaration>();
      for (const declaration of parse(text).ast.declarations) {
        if (declaration.kind === "FunctionDeclaration" && !functions.has(declaration.name.toLowerCase())) functions.set(declaration.name.toLowerCase(), declaration);
      }
      return { text, functions };
    };
    return async (name) => {
      const wanted = name.toLowerCase();
      const matches = (await this.searchSymbols(name, 40)).filter((symbol) => symbol.kind === SymbolKind.Function && symbol.name.toLowerCase() === wanted);
      for (const match of matches) {
        let library = libraries.get(match.location.uri);
        if (library === undefined) {
          library = read(match.location.uri).catch(() => null);
          libraries.set(match.location.uri, library);
        }
        const file = await library;
        const declaration = file?.functions.get(wanted);
        if (file !== null && declaration !== undefined) return { declaration, source: file.text };
      }
      return undefined;
    };
  }

  openNpcPromptGenerator(): void {
    if (this.store.getState().project === null) {
      this.notify("warning", this.t("npc.ai.noProject"));
      return;
    }
    this.openDialog({ kind: "npc-ai-generator" });
  }

  /** Cree `.runeforge/project.json` avec la configuration par defaut du dossier courant. */
  async createProjectConfig(): Promise<void> {
    const project = this.store.getState().project;
    if (project === null) return;
    await this.saveProjectConfig(project.config);
  }

  async saveProjectConfig(config: ProjectConfig): Promise<boolean> {
    const project = this.store.getState().project;
    if (project === null) return false;
    const text = serializeProjectConfig(config, project.configRaw);
    const data = new TextEncoder().encode(text);
    try {
      if (!project.configExists) {
        await this.backend.createDirectory(project.root.id, PROJECT_CONFIG_DIRECTORY);
        const outcome = await this.backend.writeFile(project.root.id, PROJECT_CONFIG_PATH, data, { kind: "mustNotExist" }, false);
        this.configSha256 = outcome.stat.sha256;
      } else {
        const precondition = this.configSha256 === null ? ({ kind: "overwrite" } as const) : ({ kind: "mustMatch", sha256: this.configSha256 } as const);
        const outcome = await this.backend.writeFile(project.root.id, PROJECT_CONFIG_PATH, data, precondition, true);
        this.configSha256 = outcome.stat.sha256;
      }
    } catch (error) {
      this.notify("error", this.t("file.saveError", { name: PROJECT_CONFIG_PATH, reason: this.describe(toBackendError(error)) }));
      return false;
    }
    const excludeChanged = JSON.stringify(project.config.exclude) !== JSON.stringify(config.exclude);
    const { config: reparsed, raw } = this.reparse(text, config);
    this.store.setState((state) =>
      state.project === null ? {} : { project: { ...state.project, config: reparsed, configRaw: raw, configExists: true, name: reparsed.projectName } },
    );
    if (excludeChanged) await this.refreshTree();
    const indexInputsChanged =
      excludeChanged ||
      JSON.stringify(project.config.sources) !== JSON.stringify(reparsed.sources) ||
      project.config.encoding.legacy !== reparsed.encoding.legacy;
    const before = project.config.emulator;
    const after = reparsed.emulator;
    const serverChanged =
      before.family !== after.family ||
      before.root !== after.root ||
      before.mode !== after.mode ||
      before.indexScope !== after.indexScope ||
      JSON.stringify(project.config.commands) !== JSON.stringify(reparsed.commands) ||
      JSON.stringify(project.config.constants) !== JSON.stringify(reparsed.constants) ||
      project.config.encoding.legacy !== reparsed.encoding.legacy;
    if (serverChanged) {
      // Un autre serveur, un autre mode ou une autre portee : nouveau registre, puis tout est relu avec lui.
      void this.setupEmulator()
        .catch(() => undefined)
        .then(() => this.syncIndex(true));
    } else if (indexInputsChanged) {
      void this.syncIndex(true);
    } else if (
      project.config.validation.crossFile !== reparsed.validation.crossFile ||
      project.config.validation.unknownCommands !== reparsed.validation.unknownCommands ||
      project.config.validation.unknownReferences !== reparsed.validation.unknownReferences
    ) {
      void this.applyLanguageOptions().then(() => {
        this.refreshOpenDiagnostics();
        this.markReportStale();
      });
    }
    this.notify("success", this.t("settings.project.saved"));
    return true;
  }

  /**
   * Declare `name` comme commande personnalisee du projet (action rapide sur `RA0001`) : elle n'est plus signalee comme inconnue.
   * Ecrit `.runeforge/project.json` (action explicite de l'utilisateur) ; le registre est ensuite reconstruit et le projet relu.
   * Sans arguments declares : leur nombre n'est pas verifie. Retourne `false` si le nom est invalide ou l'ecriture echoue.
   */
  async declareCustomCommand(name: string): Promise<boolean> {
    const project = this.store.getState().project;
    if (project === null || !isCommandName(name)) return false;
    const known = project.config.commands.custom.some((command) => command.name.toLowerCase() === name.toLowerCase());
    if (known) return true;
    const saved = await this.saveProjectConfig({
      ...project.config,
      commands: { custom: [...project.config.commands.custom, { name, args: null, description: null }] },
    });
    if (saved) this.notify("success", this.t("toast.commandDeclared", { name }));
    return saved;
  }

  private reparse(text: string, fallback: ProjectConfig): { config: ProjectConfig; raw: Record<string, unknown> } {
    const parsed = parseProjectConfig(text);
    return parsed.ok ? { config: parsed.config, raw: parsed.raw } : { config: fallback, raw: {} };
  }

  // ---------------------------------------------------------------------------------------------
  // Fenetre et session
  // ---------------------------------------------------------------------------------------------

  /** A appeler quand la fenetre reprend le focus : detecte les modifications externes. */
  async onWindowFocus(): Promise<void> {
    const manager = this.manager;
    if (manager === null) return;
    const changes = await manager.checkExternalChanges().catch(() => []);
    for (const change of changes) {
      const name = lastSegment(change.path);
      if (change.action === "reloaded") this.notify("info", this.t("file.reloaded", { name }));
      else if (change.action === "conflict") this.notify("warning", this.t("file.conflictDetected", { name }));
      else this.notify("warning", this.t("file.deletedDetected", { name }));
    }
    await this.refreshTree(false);
  }

  private scheduleSessionSave(): void {
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      const { project, tabs, activePath, expanded } = this.store.getState();
      if (project === null) return;
      const session = { version: 1, projectPath: project.root.displayPath, openFiles: tabs, activeFile: activePath, expandedDirectories: expanded };
      void this.backend.configSet("session", JSON.stringify(session)).catch(() => undefined);
    }, SESSION_SAVE_DELAY_MS);
  }
}
