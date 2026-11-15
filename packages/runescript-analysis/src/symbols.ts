import type { ParseDiagnostic, SourceRange } from "@runeforge/runescript-core";
import type { VariablePrefix, VariableScope } from "@runeforge/runescript-parser";

/**
 * Modele de symboles d'un fichier de script (M2).
 *
 * Tout est en donnees simples (tableaux et objets, sans Map/Set/classe) : un resultat peut donc etre
 * transmis tel quel d'un Worker a l'interface, serialise en JSON pour les tests, et compare par valeur.
 * Les `range` sont des offsets UTF-16 dans le texte du document (convention DEC-004).
 */

/** Comment un label (ou une fonction locale) est atteint. */
export type LabelReferenceKind = "goto" | "callsub" | "menu" | "jump_zero" | "call";

/** Definition d'un nom dans l'espace de noms des labels d'un script : label `Nom:` ou fonction locale `function Nom {`. */
export interface LabelSymbol {
  readonly kind: "label" | "function";
  /** Nom tel qu'ecrit. */
  readonly name: string;
  /** Nom normalise (minuscules) : les labels sont insensibles a la casse sur le serveur. */
  readonly key: string;
  readonly nameRange: SourceRange;
  /** Instruction complete (`Nom:` ou `function Nom { ... }`). */
  readonly range: SourceRange;
  /** Label d'evenement (`On...`) : exporte par le serveur, appelable depuis d'autres NPC. */
  readonly isEvent: boolean;
}

export interface LabelReference {
  readonly via: LabelReferenceKind;
  readonly name: string;
  readonly key: string;
  readonly range: SourceRange;
}

/** `function Nom;` : declaration anticipee d'une fonction locale. */
export interface LocalFunctionDeclaration {
  readonly name: string;
  readonly key: string;
  readonly nameRange: SourceRange;
}

/** Variable observee dans une portee (ou dans le fichier pour les portees globales). */
export interface VariableSummary {
  /** Cle normalisee : prefixe + nom en minuscules + `$` eventuel. Deux variables de meme cle sont la meme variable. */
  readonly key: string;
  /** Nom sans prefixe ni suffixe, orthographe de la premiere occurrence. */
  readonly name: string;
  readonly prefix: VariablePrefix;
  readonly scope: VariableScope;
  readonly isString: boolean;
  /** Utilisee avec un indice (`x[0]`) au moins une fois. */
  readonly isArray: boolean;
  readonly occurrences: number;
  /** Plage de la premiere occurrence (nom compris). */
  readonly firstRange: SourceRange;
  /**
   * Premiere ecriture reconnue : affectation, `++/--`, premier argument de `set`/`setarray`.
   * Les autres commandes qui ecrivent dans une variable ne sont pas reconnues sans registre de commandes (M4).
   */
  readonly firstWriteRange: SourceRange | null;
}

/** Portee d'un script : corps d'un NPC ou d'une fonction globale (les labels sont propres a chaque script). */
export interface ScriptScope {
  readonly bodyRange: SourceRange;
  /** Definitions, dans l'ordre du source. Labels et fonctions locales partagent le meme espace de noms. */
  readonly labels: readonly LabelSymbol[];
  readonly labelReferences: readonly LabelReference[];
  readonly functionDeclarations: readonly LocalFunctionDeclaration[];
  /** Variables `.@x` (locales au script) et `.x` (propres au NPC / a la fonction). */
  readonly variables: readonly VariableSummary[];
  /**
   * Faux si le corps contient une region non analysee (instruction ou expression brute), n'est pas ferme ou a ete
   * tronque : une definition a pu nous echapper, donc les verifications de labels manquants sont desactivees.
   */
  readonly complete: boolean;
}

export type NpcType = "script" | "warp" | "shop" | "cashshop" | "itemshop" | "pointshop" | "marketshop" | "duplicate";

interface DeclarationSymbolBase {
  /** Position de la declaration dans le fichier (0, 1, ...). */
  readonly index: number;
  readonly range: SourceRange;
  readonly headerRange: SourceRange;
}

export interface NpcSymbol extends DeclarationSymbolBase {
  readonly kind: "npc";
  readonly npcType: NpcType;
  /** Nom affiche (avant `::`). */
  readonly displayName: string;
  /** Nom unique (apres `::`, sinon le nom complet) : cle d'identification sur le serveur, sensible a la casse. */
  readonly uniqueName: string;
  /** Plage du champ nom dans l'en-tete. */
  readonly nameRange: SourceRange;
  /** Pour `duplicate(cible)` : le NPC source. */
  readonly duplicateOf: { readonly name: string; readonly range: SourceRange } | null;
  readonly map: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly floating: boolean;
  readonly scope: ScriptScope | null;
}

export interface FunctionSymbol extends DeclarationSymbolBase {
  readonly kind: "function";
  /** Nom de la fonction globale (sensible a la casse pour `callfunc`). */
  readonly name: string;
  readonly nameRange: SourceRange;
  readonly scope: ScriptScope | null;
}

export type DeclarationSymbol = NpcSymbol | FunctionSymbol;

/** `callfunc "Nom"` : reference a une fonction globale. */
export interface FunctionReference {
  readonly name: string;
  /** Plage du litteral de chaine, guillemets compris. */
  readonly range: SourceRange;
}

/**
 * Appel d'un nom qui n'est ni une commande du registre ni une fonction locale du script : le serveur n'accepte un tel
 * appel que si le nom est une fonction globale deja chargee, ce que seul l'index du projet peut dire (candidat `RA0001`).
 */
export interface UnknownCall {
  /** Nom tel qu'ecrit. */
  readonly name: string;
  /** Plage du nom seul. */
  readonly range: SourceRange;
}

export interface FileAnalysis {
  readonly uri: string;
  readonly declarations: readonly DeclarationSymbol[];
  readonly functionReferences: readonly FunctionReference[];
  /** Vide quand aucun registre de commandes n'etait disponible a l'analyse. */
  readonly unknownCalls: readonly UnknownCall[];
  /** Variables globales (`@`, `$`, `$@`, `#`, `##`, `'`, permanentes) vues dans le fichier. */
  readonly globalVariables: readonly VariableSummary[];
  /** Diagnostics ne dependant que de ce fichier (labels, fonctions locales). */
  readonly diagnostics: readonly ParseDiagnostic[];
}

/** Normalise un identifiant de label ou de fonction locale (insensible a la casse sur le serveur). */
export function labelKey(name: string): string {
  return name.toLowerCase();
}

/** Les labels `On...` sont exportes comme evenements par le serveur (test insensible a la casse dans `npc.cpp`). */
export function isEventLabelName(name: string): boolean {
  return name.length >= 2 && (name.charCodeAt(0) | 0x20) === 0x6f /* o */ && (name.charCodeAt(1) | 0x20) === 0x6e; /* n */
}

/** Longueur maximale du nom unique d'un NPC (`NPC_NAME_LENGTH` de `mmo.hpp`) ; au-dela le serveur tronque. */
export const NPC_NAME_LENGTH = 50;

/** Cle d'unicite d'un NPC : nom unique tronque comme le fait le serveur, sensible a la casse. */
export function npcKey(uniqueName: string): string {
  return uniqueName.length > NPC_NAME_LENGTH ? uniqueName.slice(0, NPC_NAME_LENGTH) : uniqueName;
}
