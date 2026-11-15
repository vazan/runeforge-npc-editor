import type { ParseDiagnostic, SourceRange, Token } from "@runeforge/runescript-core";

/**
 * AST du langage de script rAthena/Hercules.
 *
 * Invariants (testes) :
 * - chaque noeud porte une `range` valide dans le texte source (offsets UTF-16) ;
 * - une construction non reconnue est conservee dans un noeud `Raw*` (jamais supprimee) ;
 * - le texte d'origine n'est jamais regenere depuis l'AST : il reste disponible via `tokens`
 *   (concatenation sans perte), l'AST ne sert qu'a l'analyse.
 */

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** Prefixe d'une variable (CLAUDE.md 6.1). `""` = variable permanente de personnage. */
export type VariablePrefix = ".@" | "." | "@" | "$@" | "$" | "##" | "#" | "'" | "";

export type VariableScope =
  | "script" // .@x : locale au script/fonction appelant
  | "npc" // .x : variable de NPC
  | "character-temporary" // @x
  | "character-permanent" // x (sans prefixe)
  | "global-temporary" // $@x
  | "global-permanent" // $x
  | "account-local" // #x
  | "account-global" // ##x
  | "instance"; // 'x

export interface NumberLiteral {
  readonly kind: "NumberLiteral";
  readonly range: SourceRange;
  readonly value: number;
  readonly text: string;
}

export interface StringLiteral {
  readonly kind: "StringLiteral";
  readonly range: SourceRange;
  /** Valeur apres interpretation des echappements usuels. */
  readonly value: string;
  /** Texte source, guillemets compris. */
  readonly raw: string;
  readonly unterminated: boolean;
}

/** Mot nu : constante, parametre (`Zeny`), label, commande sans argument... */
export interface IdentifierExpression {
  readonly kind: "Identifier";
  readonly range: SourceRange;
  readonly name: string;
}

export interface VariableExpression {
  readonly kind: "Variable";
  readonly range: SourceRange;
  /** Texte complet du nom (prefixe et suffixe `$` inclus), sans l'indice. */
  readonly raw: string;
  /** Nom sans prefixe ni suffixe. */
  readonly name: string;
  readonly prefix: VariablePrefix;
  readonly scope: VariableScope;
  /** Suffixe `$` : variable de type chaine. */
  readonly isString: boolean;
  readonly nameRange: SourceRange;
  readonly index: Expression | null;
}

export interface CallExpression {
  readonly kind: "Call";
  readonly range: SourceRange;
  readonly callee: string;
  readonly calleeRange: SourceRange;
  readonly args: readonly Expression[];
}

export interface UnaryExpression {
  readonly kind: "Unary";
  readonly range: SourceRange;
  readonly operator: "!" | "~" | "-" | "+";
  readonly operand: Expression;
}

export interface UpdateExpression {
  readonly kind: "Update";
  readonly range: SourceRange;
  readonly operator: "++" | "--";
  readonly prefix: boolean;
  readonly operand: Expression;
}

export interface BinaryExpression {
  readonly kind: "Binary";
  readonly range: SourceRange;
  readonly operator: string;
  readonly left: Expression;
  readonly right: Expression;
}

export interface AssignmentExpression {
  readonly kind: "Assignment";
  readonly range: SourceRange;
  readonly operator: string;
  readonly target: Expression;
  readonly value: Expression;
}

export interface ConditionalExpression {
  readonly kind: "Conditional";
  readonly range: SourceRange;
  readonly test: Expression;
  readonly consequent: Expression;
  readonly alternate: Expression;
}

export interface ParenthesizedExpression {
  readonly kind: "Parenthesized";
  readonly range: SourceRange;
  readonly expression: Expression;
}

/** `-` seul dans une liste d'arguments (cible "suite" d'un `menu`) ou argument omis. */
export interface PlaceholderExpression {
  readonly kind: "Placeholder";
  readonly range: SourceRange;
  readonly reason: "dash" | "empty";
}

/** Fragment d'expression non analysable, conserve tel quel. */
export interface ErrorExpression {
  readonly kind: "ErrorExpression";
  readonly range: SourceRange;
  readonly originalText: string;
}

export type Expression =
  | NumberLiteral
  | StringLiteral
  | IdentifierExpression
  | VariableExpression
  | CallExpression
  | UnaryExpression
  | UpdateExpression
  | BinaryExpression
  | AssignmentExpression
  | ConditionalExpression
  | ParenthesizedExpression
  | PlaceholderExpression
  | ErrorExpression;

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export interface BlockStatement {
  readonly kind: "BlockStatement";
  readonly range: SourceRange;
  readonly openRange: SourceRange;
  /** `null` si le bloc n'est pas ferme. */
  readonly closeRange: SourceRange | null;
  readonly statements: readonly Statement[];
}

/** `Nom:` (label d'evenement `OnInit:` ou label de saut). */
export interface LabelStatement {
  readonly kind: "LabelStatement";
  readonly range: SourceRange;
  readonly name: string;
  readonly nameRange: SourceRange;
}

/** `commande arg1, arg2;` ou `commande(arg1, arg2);` */
export interface CommandStatement {
  readonly kind: "CommandStatement";
  readonly range: SourceRange;
  readonly name: string;
  readonly nameRange: SourceRange;
  readonly args: readonly Expression[];
  readonly parenthesized: boolean;
  readonly terminated: boolean;
}

export interface ExpressionStatement {
  readonly kind: "ExpressionStatement";
  readonly range: SourceRange;
  readonly expression: Expression;
  readonly terminated: boolean;
}

export interface IfStatement {
  readonly kind: "IfStatement";
  readonly range: SourceRange;
  readonly condition: Expression;
  readonly consequent: Statement;
  readonly alternate: Statement | null;
}

export interface WhileStatement {
  readonly kind: "WhileStatement";
  readonly range: SourceRange;
  readonly condition: Expression;
  readonly body: Statement;
}

export interface DoWhileStatement {
  readonly kind: "DoWhileStatement";
  readonly range: SourceRange;
  readonly body: Statement;
  readonly condition: Expression;
}

export interface ForStatement {
  readonly kind: "ForStatement";
  readonly range: SourceRange;
  readonly init: Statement | null;
  readonly condition: Expression | null;
  readonly update: Statement | null;
  readonly body: Statement;
}

export interface SwitchStatement {
  readonly kind: "SwitchStatement";
  readonly range: SourceRange;
  readonly discriminant: Expression;
  readonly body: Statement;
}

export interface CaseStatement {
  readonly kind: "CaseStatement";
  readonly range: SourceRange;
  readonly test: Expression;
}

export interface DefaultStatement {
  readonly kind: "DefaultStatement";
  readonly range: SourceRange;
}

export interface BreakStatement {
  readonly kind: "BreakStatement";
  readonly range: SourceRange;
}

export interface ContinueStatement {
  readonly kind: "ContinueStatement";
  readonly range: SourceRange;
}

export interface ReturnStatement {
  readonly kind: "ReturnStatement";
  readonly range: SourceRange;
  readonly value: Expression | null;
}

export interface GotoStatement {
  readonly kind: "GotoStatement";
  readonly range: SourceRange;
  readonly label: string;
  readonly labelRange: SourceRange;
}

/** `function Nom;` (declaration) ou `function Nom { ... }` (definition locale a un script). */
export interface FunctionStatement {
  readonly kind: "FunctionStatement";
  readonly range: SourceRange;
  readonly name: string;
  readonly nameRange: SourceRange;
  readonly body: BlockStatement | null;
}

export interface EmptyStatement {
  readonly kind: "EmptyStatement";
  readonly range: SourceRange;
}

/** Region non analysable, conservee telle quelle. */
export interface RawStatement {
  readonly kind: "RawStatement";
  readonly range: SourceRange;
  readonly originalText: string;
}

export type Statement =
  | BlockStatement
  | LabelStatement
  | CommandStatement
  | ExpressionStatement
  | IfStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | SwitchStatement
  | CaseStatement
  | DefaultStatement
  | BreakStatement
  | ContinueStatement
  | ReturnStatement
  | GotoStatement
  | FunctionStatement
  | EmptyStatement
  | RawStatement;

// ---------------------------------------------------------------------------
// Declarations de premier niveau
// ---------------------------------------------------------------------------

/** Champ d'en-tete separe par des tabulations. `text` est le texte source rogne. */
export interface HeaderField {
  readonly text: string;
  readonly range: SourceRange;
}

/** Valeur numerique decodee d'un champ, avec sa plage. `null` si absente ou non numerique. */
export interface NumericValue {
  readonly value: number | null;
  readonly text: string;
  readonly range: SourceRange;
}

/** `carte,x,y,direction` (ou `carte`, ou `carte,x,y,xs,ys` pour les monstres). */
export interface MapLocation {
  readonly map: string;
  readonly mapRange: SourceRange;
  readonly x: NumericValue | null;
  readonly y: NumericValue | null;
  readonly extra: readonly NumericValue[];
  readonly range: SourceRange;
}

export interface NpcName {
  /** Texte complet du champ nom. */
  readonly full: string;
  /** Partie avant `::` (nom affiche, `#...` masque cote client). */
  readonly display: string;
  /** Partie apres `::`, sinon le nom affiche (CLAUDE.md : cle d'identification). */
  readonly unique: string;
  readonly range: SourceRange;
}

interface DeclarationBase {
  /** De la premiere a la derniere token de la declaration (bloc de code compris). */
  readonly range: SourceRange;
  /** De la premiere token au dernier champ d'en-tete (hors bloc de code). */
  readonly headerRange: SourceRange;
  readonly fields: readonly HeaderField[];
}

export interface NpcDeclaration extends DeclarationBase {
  readonly kind: "NpcDeclaration";
  /** Declare avec `-` a la place de la position (NPC flottant). */
  readonly floating: boolean;
  readonly location: MapLocation | null;
  /** Etats declares : `script(CLOAKED)` -> ["CLOAKED"]. */
  readonly states: readonly string[];
  readonly name: NpcName;
  readonly sprite: HeaderField | null;
  /** Zone de declenchement `triggerX,triggerY` si presente. */
  readonly trigger: { readonly x: NumericValue; readonly y: NumericValue } | null;
  readonly body: BlockStatement | null;
}

export interface FunctionDeclaration extends DeclarationBase {
  readonly kind: "FunctionDeclaration";
  readonly name: string;
  readonly nameRange: SourceRange;
  readonly body: BlockStatement | null;
}

export interface DuplicateDeclaration extends DeclarationBase {
  readonly kind: "DuplicateDeclaration";
  /** NPC (script, shop, warp...) duplique : `duplicate(cible)`. */
  readonly target: string;
  readonly targetRange: SourceRange;
  readonly floating: boolean;
  readonly location: MapLocation | null;
  readonly name: NpcName;
  readonly parameters: readonly HeaderField[];
}

export interface WarpDeclaration extends DeclarationBase {
  readonly kind: "WarpDeclaration";
  readonly variant: "warp" | "warp2";
  readonly states: readonly string[];
  readonly location: MapLocation | null;
  readonly name: NpcName;
  readonly spanX: NumericValue | null;
  readonly spanY: NumericValue | null;
  readonly destination: MapLocation | null;
}

export type ShopType = "shop" | "cashshop" | "itemshop" | "pointshop" | "marketshop";

export interface ShopItem {
  /** Identifiant ou nom d'objet (`501` ou `Red_Potion`). */
  readonly item: HeaderField;
  readonly price: NumericValue | null;
  readonly stock: NumericValue | null;
  readonly range: SourceRange;
}

export interface ShopDeclaration extends DeclarationBase {
  readonly kind: "ShopDeclaration";
  readonly shopType: ShopType;
  readonly floating: boolean;
  readonly location: MapLocation | null;
  readonly name: NpcName;
  readonly sprite: HeaderField | null;
  /** Options entre le sprite et la liste d'objets (remise, objet/variable de cout). */
  readonly options: readonly HeaderField[];
  readonly items: readonly ShopItem[];
}

export interface MonsterDeclaration extends DeclarationBase {
  readonly kind: "MonsterDeclaration";
  readonly boss: boolean;
  readonly location: MapLocation | null;
  /** Nom affiche (`--ja--`, `--en--` ou texte), niveau eventuel apres une virgule. */
  readonly monsterName: HeaderField | null;
  readonly parameters: readonly HeaderField[];
}

export interface MapflagDeclaration extends DeclarationBase {
  readonly kind: "MapflagDeclaration";
  readonly map: HeaderField | null;
  readonly flag: HeaderField | null;
  readonly parameters: readonly HeaderField[];
}

/** Declaration inconnue ou illisible : le texte est conserve integralement. */
export interface RawDeclaration {
  readonly kind: "RawDeclaration";
  readonly range: SourceRange;
  readonly originalText: string;
  readonly fields: readonly HeaderField[];
}

export type TopLevelDeclaration =
  | NpcDeclaration
  | FunctionDeclaration
  | DuplicateDeclaration
  | WarpDeclaration
  | ShopDeclaration
  | MonsterDeclaration
  | MapflagDeclaration
  | RawDeclaration;

export interface ScriptFile {
  readonly kind: "ScriptFile";
  readonly range: SourceRange;
  readonly declarations: readonly TopLevelDeclaration[];
}

export type AstNode = ScriptFile | TopLevelDeclaration | Statement | Expression;

export interface ParseResult {
  readonly ast: ScriptFile;
  /** Tokens sans perte : leur concatenation redonne exactement le texte source. */
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly ParseDiagnostic[];
  /** Vrai si l'analyse a ete interrompue par une limite (profondeur, taille). */
  readonly truncated: boolean;
}
