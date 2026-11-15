/**
 * Types de base partages par le moteur de langage (T-003).
 *
 * Ce module ne depend ni de React, ni de Monaco, ni de Tauri, ni du systeme
 * de fichiers (CLAUDE.md 5.3). Les unions de l'AST vivent dans `runescript-parser`.
 */

/**
 * Plage dans un texte source.
 *
 * Convention d'offsets (decision DEC-004) :
 * - unite : code unit UTF-16, comme les index de `String` en JavaScript ;
 * - base 0, `start` inclus, `end` exclus ;
 * - relatifs au texte decode du document, BOM exclu (voir `SourceDocument`).
 *
 * C'est aussi l'unite des offsets de Monaco et celle des colonnes LSP par defaut.
 */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** Position ligne/colonne, base 0 ; `character` en code units UTF-16 (convention LSP par defaut). */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export type EndOfLine = "LF" | "CRLF" | "CR" | "mixed";

/**
 * Instantane immuable d'un document source.
 *
 * `text` est le contenu decode SANS BOM ; `bom` memorise si le fichier
 * d'origine en portait un afin de pouvoir le reecrire a l'identique.
 * `version` s'incremente a chaque changement (anti-staleness des diagnostics).
 */
export interface SourceDocument {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
  readonly encoding: string;
  readonly bom: boolean;
  readonly eol: EndOfLine;
}

/** Classes de diagnostics (CLAUDE.md 6.2). */
export type DiagnosticCategory =
  | "syntax-error"
  | "semantic-error"
  | "compatibility-warning"
  | "unknown-extension"
  | "style-hint";

export type DiagnosticSeverity = "error" | "warning" | "info";

/** Niveau de confiance affiche avec chaque diagnostic (CLAUDE.md 1.3 et 6.5). */
export type DiagnosticConfidence = "certain" | "probable" | "unknown";

export type DiagnosticSource = "parser" | "analyzer" | "compatibility";

/** Parametres d'interpolation des messages localises. */
export type DiagnosticParams = Readonly<Record<string, string | number>>;

/** Autre emplacement lie a un diagnostic (ex. l'autre definition d'une fonction en double). */
export interface RelatedLocation {
  /** Identifiant du document (chemin relatif du projet ou URI) ; meme convention que `SourceDocument.uri`. */
  readonly uri: string;
  readonly range: SourceRange;
}

export interface ParseDiagnostic {
  readonly code: string;
  readonly category: DiagnosticCategory;
  readonly range: SourceRange;
  readonly severity: DiagnosticSeverity;
  /** Message canonique (anglais). Utiliser `describeDiagnostic` pour l'affichage localise. */
  readonly message: string;
  readonly confidence: DiagnosticConfidence;
  readonly source: DiagnosticSource;
  /** Valeurs injectees dans le message ; conservees pour la localisation. */
  readonly params?: DiagnosticParams;
  /** Autres emplacements concernes (doublons inter-fichiers) ; absent si le diagnostic est purement local. */
  readonly related?: readonly RelatedLocation[];
}
