import type { WizardId } from "@runeforge/npc-templates";
import type { ParseDiagnostic } from "@runeforge/runescript-core";
import type { ProjectReport } from "@runeforge/runescript-language-server";
import {
  DEFAULT_SETTINGS,
  type ProjectConfig,
  type Settings,
  type TreeNode,
} from "@runeforge/project-core";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { DocumentInfo } from "./documents";
import type { ApprovedRoot, GitStatus, RecentProject, UpdateCheckResult, UpdateErrorCode } from "../services/types";

export type Language = "fr" | "en";
export type ResolvedTheme = "light" | "dark";

export interface ProjectState {
  readonly root: ApprovedRoot;
  readonly name: string;
  readonly config: ProjectConfig;
  readonly configRaw: Record<string, unknown>;
  /** Faux si le dossier n'a pas encore de `.runeforge/project.json` (configuration par defaut en memoire). */
  readonly configExists: boolean;
  readonly tree: TreeNode;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly skipped: number;
}

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
}

export interface RecoveryItem {
  readonly path: string;
  readonly savedAtMs: number;
  readonly size: number;
  readonly baseSha256: string | null;
}

export type SettingsTab = "general" | "editor" | "project" | "ai" | "privacy" | "updates" | "about";

export type DialogRequest =
  | { readonly kind: "unsaved-close"; readonly path: string }
  | { readonly kind: "exit"; readonly paths: readonly string[]; readonly purpose: "exit" | "leave-project" }
  | { readonly kind: "conflict"; readonly path: string; readonly deleted: boolean }
  | { readonly kind: "unencodable"; readonly path: string; readonly chars: readonly string[]; readonly encoding: string }
  | { readonly kind: "recovery"; readonly items: readonly RecoveryItem[] }
  | { readonly kind: "new-file"; readonly directory: string; readonly error?: "exists" | "invalid" }
  | { readonly kind: "settings"; readonly tab: SettingsTab }
  /** Comparaison d'un document avec le disque (`source` absent ou `disk`) ou avec sa version dans `HEAD` de Git. */
  | { readonly kind: "diff"; readonly path: string; readonly source?: "disk" | "git" | undefined }
  /** Assistant de NPC (RF-017) ; `wizard` : l'assistant affiche a l'ouverture. */
  | { readonly kind: "npc-wizard"; readonly wizard: WizardId }
  /** Demande l'accord de l'utilisateur pour lancer `git` dans ce projet (DEC-039). */
  | { readonly kind: "git-trust" }
  /** Deploiement de fichiers du projet vers un autre dossier (RF-018, DEC-040). */
  | { readonly kind: "deploy" }
  | { readonly kind: "sftp" }
  /** Editeur visuel de dialogues (RF-020 a RF-023) : le NPC qui commence a `declarationStart`, sur la copie `baseText` du document. */
  | { readonly kind: "visual"; readonly path: string; readonly declarationStart: number; readonly baseText: string }
  /** Constructeur de NPC par graphe a partir de la bibliotheque de commandes integree. */
  | { readonly kind: "visual-builder" }
  | { readonly kind: "npc-ai-generator" }
  | { readonly kind: "simulation"; readonly declarationStart: number; readonly source: string };

export type PaletteMode = "files" | "commands" | "symbols" | "databases";

export interface PaletteState {
  readonly open: boolean;
  readonly mode: PaletteMode;
}

export type BottomTab = "problems" | "references" | "report" | "git";

/** Pourquoi l'etat Git n'est pas disponible (codes du coeur natif ; `failed` pour tout autre echec). */
export type GitUnavailable = "not_trusted" | "git_unavailable" | "not_a_repository" | "unsafe_repository" | "timeout" | "too_large" | "failed";

export const GIT_UNAVAILABLE_REASONS: readonly GitUnavailable[] = ["not_trusted", "git_unavailable", "not_a_repository", "unsafe_repository", "timeout", "too_large", "failed"];

/**
 * Etat Git du projet (RF-019). `off` : jamais demande — rien n'est lance tant que l'utilisateur n'ouvre pas l'onglet Git ou
 * n'utilise pas une commande Git ; `loading` garde la derniere lecture pour que la liste ne clignote pas.
 */
export type GitState =
  | { readonly status: "off" }
  | { readonly status: "loading"; readonly data: GitStatus | null }
  | { readonly status: "ready"; readonly data: GitStatus; readonly refreshedAt: number }
  | { readonly status: "unavailable"; readonly reason: GitUnavailable };

/** Pourquoi une mise a jour n'a pas abouti : un code du coeur natif (`failed` pour tout autre echec). */
export type UpdateFailureCode = UpdateErrorCode | "failed";

export interface UpdateFailure {
  readonly code: UpdateFailureCode;
  /** `manual_update_required` : la version minimale pour une mise a jour automatique. */
  readonly minimum?: string | undefined;
  /** `install_failed` : l'etape qui a echoue (code court du coeur natif, jamais un chemin). */
  readonly reason?: string | undefined;
}

/** Une mise a jour decrite par le manifeste signe de l'editeur, telle que le dernier controle l'a trouvee. */
export type AvailableUpdate = Extract<UpdateCheckResult, { readonly kind: "available" }>;

/**
 * Mises a jour (DEC-046). `idle` : jamais demande — rien n'est contacte tant que l'utilisateur n'a pas lance un controle. Le jeton
 * d'acces d'un depot prive n'est jamais dans l'etat (il reste dans le controleur, en memoire).
 */
export type UpdateState =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "up-to-date"; readonly current: string }
  /** `failure` : la derniere tentative d'installation a echoue ; la mise a jour reste disponible pour une nouvelle tentative. */
  | { readonly status: "available"; readonly update: AvailableUpdate; readonly failure: UpdateFailure | null }
  | { readonly status: "installing"; readonly update: AvailableUpdate; readonly received: number; readonly total: number }
  /** L'executable est remplace : l'application redemarre. */
  | { readonly status: "restarting"; readonly update: AvailableUpdate }
  | { readonly status: "error"; readonly failure: UpdateFailure };

/**
 * Rapport de projet (RF-015) : les problemes de tous les fichiers indexes. C'est un instantane : `stale` dit que le service
 * a change depuis (un fichier modifie, l'indexation terminee, un reglage) et que le rapport affiche n'est plus a jour.
 */
export interface ProjectReportState {
  readonly status: "loading" | "ready" | "error";
  /** Dernier rapport calcule ; conserve pendant un nouveau calcul pour que la liste ne clignote pas. */
  readonly report: ProjectReport | null;
  readonly stale: boolean;
  /** Vrai si l'indexation du projet etait terminee quand le rapport a ete calcule (sinon il est partiel). */
  readonly complete: boolean;
  /** Date du calcul (ms depuis 1970). */
  readonly generatedAt: number;
  /** Ce que le serveur charge, parmi les fichiers examines (voir `ReportScope`). */
  readonly scope: ReportScope;
  /** Choix de l'utilisateur : ne pas montrer les fichiers que le serveur ne charge pas (defaut : les masquer). */
  readonly hideUnloaded: boolean;
}

/**
 * Les scripts que le serveur du projet charge, quand la portee d'index est plus large que cela (`sources`) et qu'un serveur est
 * reconnu : l'index contient alors aussi de la documentation et des fichiers de configuration, dont les « problemes » ne
 * concernent pas le serveur.
 */
export interface ReportScope {
  /** Scripts charges par le serveur (chemins du projet) ; `null` : pas de serveur reconnu, ou l'index ne contient deja qu'eux. */
  readonly loaded: ReadonlySet<string> | null;
  /** Fichiers examines que le serveur ne charge pas. */
  readonly notLoaded: number;
}

export const NO_REPORT_SCOPE: ReportScope = { loaded: null, notLoaded: 0 };

/** Une reference trouvee : position (base 1) et ligne de code correspondante. */
export interface ReferenceItem {
  readonly uri: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export interface ReferencesResult {
  readonly status: "loading" | "ready";
  /** Symbole recherche (mot sous le curseur). */
  readonly name: string;
  readonly items: readonly ReferenceItem[];
  /** Vrai si la liste a ete coupee a `MAX_REFERENCES` resultats. */
  readonly truncated: boolean;
}

export interface DiagnosticsEntry {
  readonly version: number;
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly truncated: boolean;
}

export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

export interface RevealRequest {
  readonly path: string;
  /** Ligne et colonne (base 1). */
  readonly line: number;
  readonly column: number;
  /** Change a chaque demande pour re-declencher l'affichage d'une position deja demandee. */
  readonly token: number;
}

/** Etat de l'indexation en arriere-plan des fichiers du projet (fonctions, NPC, references). */
export interface IndexingState {
  readonly status: "idle" | "running" | "done" | "error";
  /** Fichiers traites / fichiers a traiter pendant l'indexation initiale. */
  readonly done: number;
  readonly total: number;
  /** Fichiers ignores (binaires, illisibles). */
  readonly skipped: number;
  readonly files: number;
  readonly functions: number;
  readonly npcs: number;
}

export const IDLE_INDEXING: IndexingState = { status: "idle", done: 0, total: 0, skipped: 0, files: 0, functions: 0, npcs: 0 };

/**
 * Probleme releve dans les listes de scripts du serveur (`scripts_*.conf`) : ce que le serveur signalerait au demarrage
 * (script cite mais absent, reglage inconnu...). Les chemins sont relatifs au projet.
 */
export interface LoadIssue {
  readonly kind: "missing-config" | "missing-script" | "unknown-setting" | "import-cycle" | "limit-depth" | "limit-reads";
  /** Fichier de configuration ou ouvrir le probleme ; `null` si ce fichier est lui-meme absent (point d'entree). */
  readonly file: string | null;
  readonly line: number | null;
  /** Chemin cite par la configuration, ou nom du reglage inconnu. */
  readonly subject: string;
}

/**
 * Serveur du projet et registre de commandes qui en est tire.
 * - `none` : pas de projet, ou pas encore examine ;
 * - `loading` : lecture des fichiers du serveur ;
 * - `ready` : serveur reconnu et registre construit (voir `level` pour sa fiabilite) ;
 * - `not-found` : aucun serveur reconnu dans le projet ;
 * - `ambiguous` : plusieurs serveurs possibles, l'utilisateur doit choisir (parametres du projet) ;
 * - `unsupported` : emulateur sans adaptateur (Hercules).
 */
export interface EmulatorState {
  readonly status: "none" | "loading" | "ready" | "not-found" | "ambiguous" | "unsupported";
  /** Racine du serveur relative au projet (`""` : la racine du projet) ; `null` tant qu'elle n'est pas connue. */
  readonly root: string | null;
  /** Vrai si la racine a ete trouvee par l'application (et non imposee par la configuration). */
  readonly detected: boolean;
  /** Serveurs possibles quand `status` vaut `ambiguous`. */
  readonly candidates: readonly string[];
  /** `server-source` : noms et arite lus dans le code du serveur ; `server-doc` : noms de la documentation seule. */
  readonly level: "server-source" | "server-doc" | "none";
  readonly commands: number;
  /** Commandes dont le nombre d'arguments est verifie. */
  readonly withArity: number;
  /** Lignes du code du serveur que la lecture n'a pas comprises. */
  readonly warnings: readonly string[];
  /** Mode de compilation retenu (`null` : inconnu) et d'ou il vient. */
  readonly renewal: boolean | null;
  readonly renewalSource: "config" | "header" | "default" | null;
  /** Scripts charges par le serveur ; `null` si la portee de l'index n'est pas `loaded`. */
  readonly loadedScripts: number | null;
  /** Problemes releves dans les fichiers `scripts_*.conf` (script cite mais absent...). */
  readonly loadIssues: number;
  /** Le detail de ces problemes (`loadIssues` en est le nombre). */
  readonly loadIssueList: readonly LoadIssue[];
  /** Ce que contiennent les bases du serveur (objets, monstres, cartes, constantes) ; `null` : pas de catalogue. */
  readonly catalog: {
    readonly items: number;
    readonly mobs: number;
    readonly skills: number;
    readonly maps: number;
    readonly constants: number;
    /** Cartes que le serveur charge (`conf/maps_athena.conf`) ; `null` : liste inconnue, aucune alerte « carte non chargee ». */
    readonly loadedMaps: number | null;
  } | null;
  /** Entrees des bases ecartees ou lignes non comprises. */
  readonly catalogWarnings: readonly string[];
}

export const NO_EMULATOR: EmulatorState = {
  status: "none",
  root: null,
  detected: false,
  candidates: [],
  level: "none",
  commands: 0,
  withArity: 0,
  warnings: [],
  renewal: null,
  renewalSource: null,
  loadedScripts: null,
  loadIssues: 0,
  loadIssueList: [],
  catalog: null,
  catalogWarnings: [],
};

export interface AppState {
  /** Faux tant que les reglages et la session n'ont pas ete charges. */
  readonly ready: boolean;
  /** Faux si la page n'est pas dans la fenetre Tauri (aucun acces fichier possible). */
  readonly runtimeAvailable: boolean;
  readonly appVersion: string;
  readonly platform: string;
  readonly settings: Settings;
  readonly language: Language;
  readonly theme: ResolvedTheme;
  readonly recents: readonly RecentProject[];
  readonly project: ProjectState | null;
  readonly tabs: readonly string[];
  readonly activePath: string | null;
  readonly docs: Readonly<Record<string, DocumentInfo>>;
  readonly expanded: readonly string[];
  readonly selectedPath: string | null;
  readonly explorerFilter: string;
  readonly sidebarVisible: boolean;
  readonly bottomVisible: boolean;
  readonly sidebarWidth: number;
  readonly bottomHeight: number;
  readonly dialog: DialogRequest | null;
  readonly dialogQueue: readonly DialogRequest[];
  readonly palette: PaletteState;
  readonly toasts: readonly Toast[];
  readonly diagnostics: Readonly<Record<string, DiagnosticsEntry>>;
  readonly cursor: CursorPosition | null;
  readonly reveal: RevealRequest | null;
  readonly dismissedBanners: readonly string[];
  readonly indexing: IndexingState;
  readonly emulator: EmulatorState;
  readonly bottomTab: BottomTab;
  readonly references: ReferencesResult | null;
  /** `null` tant que le rapport de projet n'a jamais ete demande. */
  readonly projectReport: ProjectReportState | null;
  readonly git: GitState;
  readonly update: UpdateState;
}

export const INITIAL_STATE: AppState = {
  ready: false,
  runtimeAvailable: true,
  appVersion: "",
  platform: "",
  settings: DEFAULT_SETTINGS,
  language: "en",
  theme: "light",
  recents: [],
  project: null,
  tabs: [],
  activePath: null,
  docs: {},
  expanded: [],
  selectedPath: null,
  explorerFilter: "",
  sidebarVisible: true,
  bottomVisible: false,
  sidebarWidth: 280,
  bottomHeight: 280,
  dialog: null,
  dialogQueue: [],
  palette: { open: false, mode: "files" },
  toasts: [],
  diagnostics: {},
  cursor: null,
  reveal: null,
  dismissedBanners: [],
  indexing: IDLE_INDEXING,
  emulator: NO_EMULATOR,
  bottomTab: "problems",
  references: null,
  projectReport: null,
  git: { status: "off" },
  update: { status: "idle" },
};

export type AppStore = StoreApi<AppState>;

export function createAppStore(initial: Partial<AppState> = {}): AppStore {
  return createStore<AppState>(() => ({ ...INITIAL_STATE, ...initial }));
}

/** Nombre maximal de references affichees (la recherche peut en trouver bien plus dans un gros projet). */
export const MAX_REFERENCES = 500;

export const MIN_SIDEBAR = 180;
export const MAX_SIDEBAR = 640;
export const MIN_BOTTOM = 100;
export const MAX_BOTTOM = 600;
