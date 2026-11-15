import type { ReferenceHit, ReferenceKind } from "@runeforge/emulator-core";
import type { ParseDiagnostic } from "@runeforge/runescript-core";
import type {
  CommandInfo,
  CompletionItem,
  CrossFileMode,
  DocumentSymbol,
  FileDiagnostics,
  HoverInfo,
  IndexStats,
  Location,
  Position,
  ProjectReport,
  RenamePreparation,
  RenameResult,
  SignatureHelp,
  UnknownCommandMode,
  WorkspaceSymbol,
} from "@runeforge/runescript-language-server";

/**
 * Protocole entre l'interface et le worker de langage : requetes typees par methode (forme proche de LSP), reponses
 * identifiees par `id`. Le worker ne fait que parser et analyser du texte : aucun acces fichier, reseau ni systeme.
 */

/** Un fichier du projet envoye a l'indexation : octets lus sur le disque, decodes dans le worker. */
export interface IndexFileInput {
  readonly uri: string;
  readonly bytes: Uint8Array;
}

/**
 * Fichiers source du serveur de l'utilisateur dont on tire les commandes servant a la validation, lus tels quels sur le
 * disque (octets, decodes dans le worker) ; `null` quand le fichier n'existe pas. L'aide vient de la bibliotheque integree.
 */
export interface CommandSourcesInput {
  readonly family: "rathena" | "hercules";
  /** `src/map/script.cpp` : table des commandes du serveur (noms et nombres d'arguments). */
  readonly builtinSource: Uint8Array | null;
  /** `src/custom/script_def.inc` : commandes ajoutees par l'utilisateur au serveur. */
  readonly customBuiltins: Uint8Array | null;
  /** Commandes declarees dans le projet (`commands.custom` de `project.json`) : elles completent le registre du serveur. */
  readonly projectCommands?: readonly { readonly name: string; readonly args: string | null; readonly description: string | null }[];
  readonly legacyEncoding: string;
}

/** Un fichier de base du serveur : chemin relatif a sa racine et octets lus sur le disque. */
export interface DatabaseFileInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Fichiers de bases du serveur de l'utilisateur (objets, monstres, constantes, index des cartes), dans l'ordre ou le serveur
 * les charge, lus tels quels sur le disque (octets, decodes dans le worker).
 */
export interface ReferenceSourcesInput {
  readonly family: "rathena" | "hercules";
  readonly items: readonly DatabaseFileInput[];
  readonly mobs: readonly DatabaseFileInput[];
  readonly skills?: readonly DatabaseFileInput[];
  readonly constantsYaml: readonly DatabaseFileInput[];
  /** `src/map/script_constants.hpp` : constantes exportees par le code du serveur. */
  readonly constantsSource: DatabaseFileInput | null;
  readonly mapIndex: readonly DatabaseFileInput[];
  /** `db/item_randomopt_db.yml` et ses imports : le serveur en tire les constantes `RDMOPT_<Option>`. Absent : aucune. */
  readonly randomOptions?: readonly DatabaseFileInput[];
  /** Constantes declarees dans le projet (`constants.custom` de `project.json`) : elles completent celles du serveur. */
  readonly projectConstants?: readonly { readonly name: string; readonly value: number | null }[];
  /**
   * Cartes que le serveur charge (`map:` de `conf/map_athena.conf` et de ses imports). Absent, `null` ou vide : la liste n'est pas
   * connue, et aucune declaration n'est dite « sur une carte non chargee » (`RA0015`).
   */
  readonly loadedMaps?: readonly string[] | null;
  readonly legacyEncoding: string;
}

/** Ce que le worker a retenu des bases du serveur : des comptes, jamais de contenu. */
export interface ReferenceCatalogSummary {
  readonly items: number;
  readonly mobs: number;
  readonly skills: number;
  readonly maps: number;
  readonly constants: number;
  /** Cartes que le serveur charge ; `null` quand la liste n'est pas connue. */
  readonly loadedMaps: number | null;
  /** Entrees ecartees et lignes non comprises (voir `buildRathenaCatalog`). */
  readonly warnings: string[];
}

/** Ce que le worker a retenu des fichiers du serveur : pas de contenu, seulement de quoi l'afficher. */
export interface CommandRegistrySummary {
  /** `none` : aucun registre (fichiers absents, ou emulateur sans adaptateur). */
  readonly level: "server-source" | "server-doc" | "none";
  readonly commands: number;
  /** Commandes dont le nombre d'arguments est verifie. */
  readonly withArity: number;
  readonly sourceCommands: number;
  readonly customCommands: number;
  readonly docCommands: number;
  /** Commandes du projet retenues (0 sans registre de serveur). */
  readonly projectCommands: number;
  readonly warnings: string[];
}

export interface LanguageMethods {
  /** Ouvre/met a jour un document (texte en LF) et renvoie ses diagnostics. */
  analyze: {
    params: { uri: string; version: number; text: string };
    result: { diagnostics: ParseDiagnostic[]; truncated: boolean };
  };
  closeDocument: { params: { uri: string }; result: null };
  definition: { params: { uri: string; position: Position }; result: Location[] };
  references: { params: { uri: string; position: Position; includeDeclaration: boolean }; result: Location[] };
  documentSymbols: { params: { uri: string }; result: DocumentSymbol[] };
  /** `explicit` : demandee par l'utilisateur (Ctrl+Espace) et non ouverte par la frappe : les commandes se proposent alors sans fragment saisi. */
  completion: { params: { uri: string; position: Position; explicit?: boolean }; result: CompletionItem[] };
  hover: { params: { uri: string; position: Position }; result: HoverInfo | null };
  /** Aide de signature de la commande dont le curseur est dans les arguments. */
  signatureHelp: { params: { uri: string; position: Position }; result: SignatureHelp | null };
  /** Ce que le registre sait d'une commande (detail d'une proposition de completion). */
  commandInfo: { params: { name: string }; result: CommandInfo | null };
  prepareRename: { params: { uri: string; position: Position }; result: RenamePreparation };
  rename: { params: { uri: string; position: Position; newName: string }; result: RenameResult };
  workspaceSymbols: { params: { query: string; limit: number }; result: WorkspaceSymbol[] };
  /** Diagnostics d'un fichier, y compris les verifications entre fichiers selon `crossFile`. */
  diagnostics: { params: { uri: string }; result: ParseDiagnostic[] };
  projectDiagnostics: { params: Record<string, never>; result: FileDiagnostics[] };
  /** Rapport de projet (RF-015) : problemes des fichiers indexes (ou des seuls `only`), avec position, totaux par gravite et par code. */
  projectReport: { params: { only?: string[] | null }; result: ProjectReport };
  /** Diagnostics d'un texte qui n'est pas un document du projet (apercu d'un assistant) ; rien n'est indexe ni retenu. */
  previewDiagnostics: { params: { text: string }; result: ParseDiagnostic[] };
  /** Decode (encodage herite configurable) puis indexe des fichiers lus sur le disque. */
  indexFiles: {
    params: { files: IndexFileInput[]; legacyEncoding: string };
    result: { indexed: number; skipped: string[] };
  };
  removeFiles: { params: { uris: string[] }; result: null };
  clearIndex: { params: Record<string, never>; result: null };
  setOptions: {
    params: {
      crossFile?: CrossFileMode;
      styleHints?: boolean;
      unknownCommands?: UnknownCommandMode;
      unknownReferences?: UnknownCommandMode;
      emulator?: "rathena" | "hercules" | null;
    };
    result: null;
  };
  /**
   * Ordre dans lequel le serveur charge les fichiers de script (les plus tot charges d'abord), ou `null` s'il n'est pas connu.
   * Avec lui, l'appel par son nom d'une fonction que le serveur n'a pas encore chargee est signale (`RA0016`).
   */
  setLoadOrder: { params: { files: string[] | null }; result: null };
  /**
   * Construit le registre de commandes a partir des fichiers du serveur et l'applique aux documents ouverts. Les fichiers
   * simplement indexes doivent etre relus par l'appelant pour en tenir compte.
   */
  setCommandSources: { params: CommandSourcesInput; result: CommandRegistrySummary };
  /**
   * Construit le catalogue de references (objets, monstres, cartes, constantes) a partir des bases du serveur et l'applique aux
   * documents ouverts. Les fichiers simplement indexes doivent etre relus par l'appelant pour en tenir compte.
   */
  setReferenceSources: { params: ReferenceSourcesInput; result: ReferenceCatalogSummary };
  /** Recherche libre dans le catalogue (retrouver et inserer une reference). */
  searchReferences: { params: { kind: ReferenceKind; query: string; limit: number }; result: ReferenceHit[] };
  stats: { params: Record<string, never>; result: IndexStats };
}

export type LanguageMethod = keyof LanguageMethods;

export interface LanguageRequest<M extends LanguageMethod = LanguageMethod> {
  readonly id: number;
  readonly method: M;
  readonly params: LanguageMethods[M]["params"];
}

export type LanguageResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };
