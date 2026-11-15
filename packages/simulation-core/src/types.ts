import type { SourceRange } from "@runeforge/runescript-core";
import type { Expression, FunctionDeclaration, NpcDeclaration } from "@runeforge/runescript-parser";
import type { Store } from "./store";

/** Valeur d'un script : entier ou chaîne (les nombres du serveur sont des entiers 64 bits ; ici, des entiers sûrs). */
export type SimValue = string | number;

/** Personnage de test : tout ce que le scénario peut lire ou modifier. Jamais modifié par la simulation. */
export interface SimulationContext {
  readonly level: number;
  readonly job: number;
  readonly zeny: number;
  /** Variables de tout type (`bard_q`, `.@x`, `#compte`, `$global`...) et paramètres (`SkillPoint`, `Weight`...) ; noms insensibles à la casse. */
  readonly variables: ReadonlyMap<string, SimValue>;
  /** Quantités par identifiant ou nom interne (insensible à la casse). */
  readonly items: ReadonlyMap<string, number>;
  /** État de chaque quête : -1 absente, 0 inactive, 1 active, 2 terminée. */
  readonly quests: ReadonlyMap<number, number>;
  /** Nom du personnage (`strcharinfo(0)`) ; « Player » par défaut. */
  readonly name?: string;
  /** Résultats imposés aux fonctions que la simulation ne calcule pas (nom en minuscules → valeur). */
  readonly results?: ReadonlyMap<string, SimValue>;
}

/** Fonction globale appelable par `callfunc`, avec le texte du fichier qui la définit : les notes citent l'instruction d'origine. */
export interface FunctionSource {
  readonly declaration: FunctionDeclaration;
  readonly source: string;
}

/** Ce que le scénario peut atteindre en dehors du NPC simulé. */
export interface SimulationWorld {
  /** Texte du fichier du NPC : les notes (effets non simulés, valeurs supposées, écarts) citent l'instruction d'origine. */
  readonly source?: string;
  /** Fonctions globales appelables par `callfunc` (nom en minuscules), de ce fichier ou d'un autre. */
  readonly functions?: ReadonlyMap<string, FunctionSource>;
  /** Constantes du serveur et noms d'objets (nom en minuscules → valeur). */
  readonly constants?: ReadonlyMap<string, SimValue>;
  /** Graine du tirage pseudo-aléatoire (1 par défaut) : une simulation se rejoue à l'identique. */
  readonly seed?: number;
  /** Instant simulé de `gettime` (millisecondes depuis 1970 UTC ; 2026-01-01 12:00 par défaut). */
  readonly clock?: number;
}

export interface MenuOption {
  readonly value: number;
  readonly label: string;
}

export type Pause =
  /** `next` (page suivante) ou `close2` (le dialogue se ferme mais le script continue). */
  | { readonly kind: "page"; readonly closing: boolean }
  | { readonly kind: "choice"; readonly options: readonly MenuOption[] }
  | { readonly kind: "input"; readonly numeric: boolean; readonly min: number; readonly max: number };

/**
 * Fin d'une simulation. Seule une limite de ressources l'interrompt avant le script : une opération que le serveur
 * refuserait, ou que la simulation ne sait pas calculer, est notée dans la transcription et le dialogue continue.
 */
export type Outcome =
  | { readonly kind: "end" | "closed" }
  /** Trop d'étapes, de texte, d'appels imbriqués ou de variables (boucle sans fin ?) : `text` cite l'instruction atteinte. */
  | { readonly kind: "limit"; readonly detail: string; readonly range: SourceRange; readonly text: string };

export type State = { readonly kind: "ready" } | Pause | Outcome;

export type TranscriptEntry =
  /** Texte affiché dans la fenêtre du NPC. */
  | { readonly kind: "mes"; readonly text: string }
  /** Parole du NPC hors fenêtre (`npctalk`, `announce`...). */
  | { readonly kind: "speech"; readonly name: string; readonly text: string }
  /** Réponse du joueur : option choisie ou valeur saisie. */
  | { readonly kind: "player"; readonly text: string }
  /** Instruction que la simulation n'exécute pas (effet sur le serveur) : `text` cite l'instruction. */
  | { readonly kind: "effect"; readonly name: string; readonly text: string; readonly range: SourceRange; readonly count: number }
  /** Valeur supposée faute de serveur : `text` cite l'appel, `value` la valeur retenue. */
  | { readonly kind: "assumed"; readonly name: string; readonly text: string; readonly value: SimValue; readonly range: SourceRange; readonly count: number }
  /**
   * Opération que le serveur refuserait (le serveur arrêterait le script) : `text` cite l'instruction et la simulation
   * continue avec une valeur de repli. `detail` la désigne : `divide` (division ou modulo par zéro), `shift`, `overflow`,
   * `operand` (texte mêlé à un nombre), `zeny` (solde négatif), `index` (indice de tableau hors bornes), `getarg` (argument
   * non fourni), `return` (hors d'un appel), `label <nom>` (label ou sous-programme introuvable), le nom de la commande
   * sinon (`mes`, `delitem`, `callfunc`...), ou `internal` : défaut du simulateur lui-même (le script se termine là).
   */
  | { readonly kind: "fault"; readonly detail: string; readonly text: string; readonly range: SourceRange; readonly count: number };

export interface SimulationView {
  readonly state: State;
  /** Lignes affichées par `mes`, dans l'ordre. */
  readonly messages: readonly string[];
  /** Tout ce que le joueur a vu et fait, dans l'ordre. */
  readonly transcript: readonly TranscriptEntry[];
  readonly variables: ReadonlyMap<string, SimValue>;
  readonly zeny: number;
  /** Inventaire courant (identifiant ou nom en minuscules → quantité). */
  readonly items: ReadonlyMap<string, number>;
  /** États de quête courants. */
  readonly quests: ReadonlyMap<number, number>;
}

/** Exécution pas à pas : chaque `yield` attend la réponse du joueur. */
export type Script<T> = Generator<Pause, T, SimValue | undefined>;

/** Arrêt de la simulation, à l'intérieur de l'interpréteur uniquement. */
export class Stop extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.kind);
  }
}

/**
 * Opération que l'interpréteur rattrape sans arrêter le dialogue, à l'intérieur de l'interpréteur uniquement :
 * `invalid` : le serveur la refuserait (il arrêterait le script) ; `unsupported` : la simulation ne sait pas la calculer.
 * L'expression ou l'instruction fautive prend une valeur de repli et le script continue.
 */
export class Fault extends Error {
  constructor(
    readonly reason: "invalid" | "unsupported",
    readonly detail: string,
    readonly range: SourceRange,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/** Cible d'une affectation : un élément (`index` 0 pour une variable simple) d'une variable. */
export interface Reference {
  /** Nom complet en minuscules, préfixe et suffixe `$` compris, sans l'indice. */
  readonly base: string;
  readonly index: number;
  readonly isString: boolean;
  /** Variable du script appelant passée en argument (`callsub S_X, .@liste;`) : le tableau reste celui de l'appelant. */
  readonly store?: Store;
}

export interface CallArguments {
  readonly values: readonly SimValue[];
  readonly references: readonly (Reference | null)[];
}

export interface CallInfo {
  /** Nom de la commande ou de la fonction, en minuscules. */
  readonly name: string;
  readonly args: readonly Expression[];
  readonly range: SourceRange;
  readonly depth: number;
  /** Faux quand l'appel est une instruction : la valeur renvoyée est ignorée. */
  readonly wantValue: boolean;
}

/** Ce que les fonctions intégrées peuvent demander à l'interpréteur. */
export interface Machine {
  readonly npc: NpcDeclaration;
  readonly context: SimulationContext;
  readonly world: SimulationWorld;
  readonly items: Map<string, number>;
  readonly quests: Map<number, number>;
  evaluate(node: Expression, depth: number): Script<SimValue>;
  values(args: readonly Expression[], depth: number): Script<SimValue[]>;
  reference(node: Expression, depth: number): Script<Reference | null>;
  read(reference: Reference): SimValue;
  write(reference: Reference, value: SimValue, range: SourceRange): void;
  arraySize(reference: Reference): number;
  removeFromArray(reference: Reference, count: number): void;
  /** Clé d'inventaire d'un objet : son identifiant, ou son nom interne en minuscules. */
  itemKey(value: SimValue): string;
  /** Opérande « objet » : un mot nu sans valeur connue désigne l'objet de ce nom (`getitem Red_Potion,1`). */
  itemOperand(node: Expression, depth: number): Script<string>;
  say(text: string, range: SourceRange): void;
  speak(name: string, text: string): void;
  chosen(text: string): void;
  /** Note qu'une instruction n'est pas simulée. */
  effect(call: CallInfo): void;
  /** Note la valeur supposée d'un appel (ou celle que le test impose) et la renvoie. */
  assume(call: CallInfo, fallback: SimValue): SimValue;
  random(): number;
  clock(): number;
  hasFunction(name: string): boolean;
  /** Arguments d'un appel : les valeurs et, pour une variable passée telle quelle, sa référence (un tableau se passe par référence). */
  arguments(args: readonly Expression[], depth: number): Script<CallArguments>;
  callFunction(name: string, args: CallArguments, range: SourceRange, depth: number): Script<SimValue | undefined>;
  callLabel(label: string, args: CallArguments, range: SourceRange, depth: number): Script<SimValue | undefined>;
  getArgument(index: number, range: SourceRange, fallback: SimValue | undefined): SimValue;
  argumentCount(): number;
  /** Affiche les options, attend le choix, positionne `@menu` et renvoie le numéro choisi. */
  choose(options: readonly string[], range: SourceRange): Script<number>;
  /** Un mot nu est-il une variable, un paramètre ou une constante connus ? */
  isKnownName(name: string): boolean;
  stop(outcome: Outcome): never;
  /** Note une opération que le serveur refuserait ; l'appelant continue avec une valeur de repli. */
  warn(detail: string, range: SourceRange): void;
  /** Opération que le serveur refuserait et qui n'a pas de valeur de repli : l'instruction ou l'expression est abandonnée (notée). */
  invalid(detail: string, range: SourceRange): never;
  /** Opération que la simulation ne sait pas calculer : abandonnée comme une instruction « non simulée ». */
  unsupported(detail: string, range: SourceRange): never;
  limit(detail: string, range: SourceRange): never;
}
