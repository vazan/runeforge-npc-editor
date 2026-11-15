import type { ArgumentKind, Arity, ConstantRecord, DefinitionSource, DefinitionSourceKind, ItemRecord, MapRecord, MobRecord, ReferenceKind, SkillRecord } from "@runeforge/emulator-core";
import type { ParseDiagnostic, Position } from "@runeforge/runescript-core";

/**
 * Types de l'interface du service de langage. Ils suivent la forme du Language Server Protocol (positions
 * `{ line, character }` en base 0 et en code units UTF-16, `Location`, `DocumentSymbol`, `SymbolKind`) afin de pouvoir
 * brancher plus tard un transport LSP standard sans changer les appelants (CLAUDE.md 8.1).
 */

export type { Position };

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  /** Identifiant du document : chemin relatif du projet (meme convention que partout dans l'application). */
  readonly uri: string;
  readonly range: Range;
}

/** Valeurs numeriques identiques a celles de LSP. */
export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;
export type SymbolKind = (typeof SymbolKind)[keyof typeof SymbolKind];

export interface DocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: SymbolKind;
  /** Etendue complete du symbole (contient `selectionRange` et ses enfants). */
  readonly range: Range;
  /** Plage du nom, mise en evidence a la selection. */
  readonly selectionRange: Range;
  readonly children: DocumentSymbol[];
}

export interface WorkspaceSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: SymbolKind;
  readonly location: Location;
}

/**
 * Verifications entre fichiers :
 * - `off` : aucune (defaut : l'ensemble de fichiers indexe n'est pas garanti identique a celui charge par le serveur) ;
 * - `duplicates` : fonctions et noms de NPC en double (`RA0011`, `RA0005`) ;
 * - `all` : en plus, fonctions introuvables et sources de `duplicate` absentes (`RA0004`, `RA0013`) ; l'utilisateur affirme
 *   que les fichiers indexes sont exactement ceux que charge son serveur.
 */
export type CrossFileMode = "off" | "duplicates" | "all";

/**
 * Gravite des alertes de commande inconnue (`RA0001`), ou `off` pour les supprimer. Sans registre de commandes, il n'y a
 * jamais d'alerte, quelle que soit cette valeur.
 */
export type UnknownCommandMode = "off" | "info" | "warning" | "error";

export interface LanguageServerOptions {
  readonly crossFile: CrossFileMode;
  /** Suggestions de style (`RA0007`). */
  readonly styleHints: boolean;
  readonly unknownCommands: UnknownCommandMode;
  /**
   * Gravite des alertes de carte, d'objet ou de monstre introuvable (`RA0008`, `RA0009`, `RA0010`), ou `off` pour les
   * supprimer. Sans catalogue de references, il n'y en a jamais.
   */
  readonly unknownReferences: UnknownCommandMode;
  /** Emulateur du projet : seuls ses modeles de NPC verifies se proposent (`null` : aucun). */
  readonly emulator: "rathena" | "hercules" | null;
}

export interface IndexStats {
  readonly files: number;
  readonly openDocuments: number;
  readonly functions: number;
  readonly npcs: number;
}

export interface FileDiagnostics {
  readonly uri: string;
  readonly diagnostics: ParseDiagnostic[];
}

/** Un probleme du rapport de projet : le diagnostic et la position (base 1) du debut de sa plage. */
export interface ReportItem {
  readonly diagnostic: ParseDiagnostic;
  readonly line: number;
  readonly column: number;
}

/** Les problemes d'un fichier du projet, dans l'ordre du fichier. */
export interface ReportFile {
  readonly uri: string;
  /** Totaux exacts du fichier, meme quand `items` a ete coupe (voir `ProjectReport.truncated`). */
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly items: readonly ReportItem[];
}

export interface ReportCodeCount {
  readonly code: string;
  readonly count: number;
}

/**
 * Rapport de projet (RF-015) : les diagnostics de tous les fichiers indexes, tels que le panneau des problemes les
 * montre pour un document ouvert (memes verifications, memes gravites). C'est une analyse statique locale : elle ne dit
 * pas ce que le serveur fera de ces scripts.
 */
export interface ProjectReport {
  /** Fichiers examines : tous les fichiers indexes, avec ou sans probleme. */
  readonly examined: number;
  /** Fichiers qui ont au moins un probleme : les plus graves d'abord (erreurs, puis avertissements, puis informations), puis par chemin. */
  readonly files: readonly ReportFile[];
  readonly totals: { readonly errors: number; readonly warnings: number; readonly infos: number };
  /** Nombre de problemes par code, du plus frequent au plus rare. */
  readonly byCode: readonly ReportCodeCount[];
  /** Vrai si la liste des problemes (`items`) a ete coupee a `MAX_REPORT_ITEMS` ; les totaux restent exacts. */
  readonly truncated: boolean;
  /** Ce que `ProjectReportOptions.only` a laisse de cote ; `null` quand tous les fichiers indexes sont dans le rapport. */
  readonly excluded: ReportExcluded | null;
}

/** Fichiers indexes qui ne sont pas dans le rapport parce que `only` ne les nomme pas : combien, et ce qu'ils contiennent. */
export interface ReportExcluded {
  /** Fichiers indexes laisses de cote (avec ou sans probleme). */
  readonly examined: number;
  /** Parmi eux, ceux qui ont au moins un probleme, et le nombre de ces problemes. */
  readonly files: number;
  readonly problems: number;
}

export interface ProjectReportOptions {
  /**
   * Ne rapporter que ces fichiers : les autres sont comptes dans `excluded`, hors du detail et des totaux. La limite du detail
   * (`MAX_REPORT_ITEMS`) s'applique alors aux seuls fichiers rapportes : le bruit d'un fichier laisse de cote ne peut pas la
   * consommer. Absent : tous les fichiers indexes.
   */
  readonly only?: readonly string[] | null;
}

/**
 * Nombre maximal de problemes detailles dans un rapport : au-dela, seuls les totaux sont donnes. Le detail est transfere du worker
 * a l'interface par clonage structure, dont le cout est proportionnel a sa taille : 5 000 problemes pesent ~3,6 Mio et ~30 ms
 * (`scripts/project-report.ts`) ; un rapport reel en a une centaine, et personne ne lit des milliers de lignes.
 */
export const MAX_REPORT_ITEMS = 5_000;

/** Valeurs numeriques identiques a celles de LSP (`CompletionItemKind`). */
export const CompletionItemKind = {
  Function: 3,
  Field: 5,
  Variable: 6,
  Class: 7,
  Value: 12,
  Keyword: 14,
  Snippet: 15,
  Constant: 21,
  Event: 23,
} as const;
export type CompletionItemKind = (typeof CompletionItemKind)[keyof typeof CompletionItemKind];

export interface CompletionItem {
  /** Texte propose et insere (apres remplacement de `range`). */
  readonly label: string;
  readonly kind: CompletionItemKind;
  /** Information breve, non redactionnelle (chemin du fichier, type de NPC, portee de variable, signature d'une commande). */
  readonly detail?: string;
  /** Texte remplace par la completion : le fragment deja saisi (et, dans une chaine, jusqu'au guillemet fermant). */
  readonly range: Range;
  readonly sortText: string;
  /** Present pour une commande du registre : d'ou vient sa definition et si elle est obsolete. */
  readonly command?: { readonly source: DefinitionSourceKind; readonly deprecated: boolean };
  /** Texte insere quand il differe du libelle (modele au format snippet). */
  readonly insertText?: string;
  /** `snippet` : `insertText` contient des champs (`${1:valeur}`) que l'editeur fait remplir. */
  readonly format?: "snippet";
  /** Identifiant du modele de NPC (`npc-script`) : l'interface traduit sa description. */
  readonly template?: string;
  /** Texte sur lequel l'editeur filtre quand il differe du libelle (identifiant et noms d'un objet). */
  readonly filterText?: string;
  /** Present pour une reference du catalogue du serveur (objet, monstre, carte, constante). */
  readonly reference?: { readonly kind: ReferenceKind; readonly id: number | null };
}

/** Nombre maximal de propositions renvoyees pour les ensembles volumineux (fonctions, noms de NPC, references). */
export const MAX_COMPLETIONS = 200;

/** Nombre maximal de commandes proposees (la bibliotheque rAthena integree en compte environ 700). */
export const MAX_COMMAND_COMPLETIONS = 1000;

/**
 * Ce que le registre sait d'une commande, pour l'afficher (survol, aide de signature, detail de completion). Donnees
 * seulement : l'interface met en forme dans la langue de l'utilisateur. L'aide rAthena provient de la bibliotheque integree.
 */
export interface CommandInfo {
  readonly name: string;
  /** Signatures lisibles (bibliotheque ou generees depuis la notation du serveur) : jamais vide. */
  readonly signatures: readonly string[];
  /** Nombre d'arguments verifie, ou `null` quand il n'est pas connu avec certitude (manuel seul). */
  readonly arity: Arity | null;
  readonly parameterTypes: string | null;
  /** Aide du manuel integre ou de la declaration (voir `documentationTruncated`), ou `null`. */
  readonly documentation: string | null;
  readonly documentationTruncated: boolean;
  readonly deprecated: boolean;
  /** Compilee sous condition (`#ifdef`) : peut etre absente du serveur reel. */
  readonly conditional: boolean;
  /** Origine de chaque information, de la plus prioritaire a la moins prioritaire. */
  readonly sources: readonly DefinitionSource[];
}

export interface SignatureInformation {
  readonly label: string;
  /** Plage de chaque parametre dans `label` (offsets UTF-16). */
  readonly parameters: readonly { readonly start: number; readonly end: number }[];
}

/** Aide de signature (forme LSP `SignatureHelp`) : l'appel dont le curseur est dans les arguments. */
export interface SignatureHelp {
  readonly signatures: readonly SignatureInformation[];
  readonly activeSignature: number;
  /** Rang de l'argument en cours ; hors des parametres connus quand il y a trop d'arguments. */
  readonly activeParameter: number;
  readonly command: CommandInfo;
}

/**
 * Contenu d'un survol, sans texte redige : l'interface le met en forme dans la langue de l'utilisateur.
 * Les numeros de ligne sont en base 1.
 */
export type HoverInfo =
  | {
      readonly kind: "label";
      readonly range: Range;
      readonly name: string;
      /** `function X { ... }` (fonction locale) plutot que `X:`. */
      readonly isFunction: boolean;
      readonly isEvent: boolean;
      /** Faux si aucun label de ce nom n'est defini dans le script. */
      readonly defined: boolean;
      readonly line: number | null;
      readonly references: number;
    }
  | {
      readonly kind: "function";
      readonly range: Range;
      readonly name: string;
      readonly definitions: readonly { readonly uri: string; readonly line: number }[];
      /** Nombre d'appels `callfunc "..."` dans tout le projet. */
      readonly references: number;
    }
  | {
      readonly kind: "npc";
      readonly range: Range;
      readonly name: string;
      readonly definitions: readonly {
        readonly uri: string;
        readonly line: number;
        readonly npcType: string;
        readonly displayName: string;
        readonly map: string | null;
      }[];
      /** Nombre de `duplicate(...)` qui visent ce NPC. */
      readonly references: number;
    }
  | {
      readonly kind: "variable";
      readonly range: Range;
      readonly name: string;
      readonly scope: string;
      readonly isString: boolean;
      readonly isArray: boolean;
      readonly occurrences: number;
      readonly firstWriteLine: number | null;
    }
  | {
      /** Commande (ou fonction native) du registre du serveur. */
      readonly kind: "command";
      readonly range: Range;
      readonly name: string;
      readonly info: CommandInfo;
    }
  | {
      /** Objet, monstre ou carte ecrit en clair a la place d'un argument de ce type ; `record` est `null` s'il est introuvable. */
      readonly kind: "reference";
      readonly range: Range;
      readonly referenceKind: ArgumentKind;
      /** Le texte ecrit (`501`, `"Red_Potion"`), sans les guillemets. */
      readonly written: string;
      readonly record: ItemRecord | MobRecord | MapRecord | SkillRecord | null;
    }
  | {
      /** Constante ou parametre exporte par le serveur (`Job_Alchemist`, `BaseLevel`). */
      readonly kind: "constant";
      readonly range: Range;
      readonly constant: ConstantRecord;
    };
