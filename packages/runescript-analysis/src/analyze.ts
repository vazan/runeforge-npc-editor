import { argumentKindsOf, checkArity, formatArity } from "@runeforge/emulator-core";
import type { ArgumentKind, CommandDefinition, CommandRegistry, ReferenceCatalog } from "@runeforge/emulator-core";
import { createDiagnostic } from "@runeforge/runescript-core";
import type { ParseDiagnostic, SourceRange } from "@runeforge/runescript-core";
import { childrenOf } from "@runeforge/runescript-parser";
import type {
  AstNode,
  BlockStatement,
  CallExpression,
  CommandStatement,
  Expression,
  MapLocation,
  ParseResult,
  VariableExpression,
} from "@runeforge/runescript-parser";
import { isEventLabelName, labelKey } from "./symbols";
import type {
  DeclarationSymbol,
  FileAnalysis,
  FunctionReference,
  LabelReference,
  LabelReferenceKind,
  LabelSymbol,
  LocalFunctionDeclaration,
  NpcSymbol,
  ScriptScope,
  UnknownCall,
  VariableSummary,
} from "./symbols";

export interface AnalyzeOptions {
  /** Emet aussi les suggestions de style (RA0007 : label jamais reference). Faux par defaut : ce ne sont pas des erreurs. */
  readonly styleHints?: boolean;
  /**
   * Registre de commandes du profil. Fourni : le nombre d'arguments des commandes connues est verifie (`RA0006`, seulement
   * si leur arite est connue avec certitude) et les appels de noms inconnus sont gardes (`FileAnalysis.unknownCalls`) pour
   * que l'index du projet decide s'il s'agit de fonctions globales ou d'inconnues (`RA0001`). Absent : aucune verification.
   */
  readonly commands?: CommandRegistry | null;
  /** Catalogue de signatures pour interpreter les arguments de references, sans les valider comme commandes. */
  readonly referenceCommands?: CommandRegistry | null;
  /**
   * Catalogue de references du serveur (objets, monstres, cartes). Fourni avec un registre de commandes : un argument ecrit
   * en clair (nombre ou chaine) a la place d'un objet, d'un monstre ou d'une carte est cherche dans le catalogue, et signale
   * quand il n'y est pas (`RA0009`, `RA0010`, `RA0008` : information, confiance « inconnue »). Absent : aucune verification.
   */
  readonly references?: ReferenceCatalog | null;
}

/**
 * Valeurs de chaine qui, dans une position de carte, ne designent pas une carte de l'index : `warp` accepte `"Random"`,
 * `"SavePoint"` et `"Save"`, `monster` accepte `"this"` (la carte du joueur) (`script.cpp`) ; `warpparty` documente en plus
 * `"SavePointAll"`, `"Leader"` et `"RandomAll"` (manuel du serveur). Ecartes pour toutes les commandes, en minuscules : mieux
 * vaut ne rien dire que signaler une valeur speciale. Mesure : sur 26 428 arguments reels du serveur local, seul `RandomAll`
 * (`warpparty`) a ete signale a tort avant d'etre ajoute.
 */
const SPECIAL_MAP_VALUES: ReadonlySet<string> = new Set(["this", "random", "randomall", "save", "savepoint", "savepointall", "leader"]);
/**
 * Un nom de carte tel que l'ecrit l'index du serveur : lettres, chiffres, `_`, `-` (`force_5-1`) et `@` (cartes d'instance :
 * `2@cata` est une carte de l'index comme une autre). Un texte avec des espaces ou d'autres signes n'est pas un nom de carte
 * litteral et n'est pas verifie.
 */
const PLAIN_MAP_NAME = /^[A-Za-z0-9_@-]+(?:\.gat)?$/;

/** Une chaine placee a la place d'une carte designe-t-elle une carte de l'index (ni valeur speciale, ni texte quelconque) ? */
export function isCheckableMapName(value: string): boolean {
  return PLAIN_MAP_NAME.test(value) && !SPECIAL_MAP_VALUES.has(value.toLowerCase());
}

/** Commandes qui ecrivent dans leur premier argument (liste minimale : les autres exigent le registre de commandes, M4). */
const SET_COMMANDS: ReadonlySet<string> = new Set(["set", "setarray"]);

interface MutableVariable {
  readonly key: string;
  readonly name: string;
  readonly prefix: VariableSummary["prefix"];
  readonly scope: VariableSummary["scope"];
  readonly isString: boolean;
  isArray: boolean;
  occurrences: number;
  readonly firstRange: SourceRange;
  firstWriteRange: SourceRange | null;
}

type Interner = (value: string) => string;

/**
 * Copie les chaines extraites du source. V8 represente une sous-chaine de 13 caracteres ou plus par un renvoi vers la
 * chaine d'origine : sans copie, conserver un seul nom retiendrait tout le texte de son fichier en memoire. Le
 * dedoublonnage (par fichier) evite en plus de stocker cent fois « L_Menu » ou « OnInit ».
 */
function createInterner(): Interner {
  const pool = new Map<string, string>();
  return (value) => {
    let interned = pool.get(value);
    if (interned === undefined) {
      interned = value.length < 13 ? value : (" " + value).slice(1);
      pool.set(interned, interned);
    }
    return interned;
  };
}

class VariableTable {
  private readonly entries = new Map<string, MutableVariable>();

  constructor(private readonly intern: Interner) {}

  add(node: VariableExpression, isWrite: boolean): void {
    const key = this.intern(node.prefix + node.name.toLowerCase() + (node.isString ? "$" : ""));
    const identifierRange: SourceRange = { start: node.range.start, end: node.range.start + node.raw.length };
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, {
        key,
        name: this.intern(node.name),
        prefix: node.prefix,
        scope: node.scope,
        isString: node.isString,
        isArray: node.index !== null,
        occurrences: 1,
        firstRange: identifierRange,
        firstWriteRange: isWrite ? identifierRange : null,
      });
      return;
    }
    existing.occurrences += 1;
    if (node.index !== null) existing.isArray = true;
    if (isWrite && existing.firstWriteRange === null) existing.firstWriteRange = identifierRange;
  }

  toArray(): VariableSummary[] {
    return [...this.entries.values()];
  }
}

interface FileContext {
  readonly intern: Interner;
  readonly diagnostics: ParseDiagnostic[];
  readonly functionReferences: FunctionReference[];
  readonly unknownCalls: UnknownCall[];
  readonly globals: VariableTable;
  readonly styleHints: boolean;
  readonly commands: CommandRegistry | null;
  readonly referenceCommands: CommandRegistry | null;
  readonly references: ReferenceCatalog | null;
  readonly truncated: boolean;
}

/**
 * Verifie les arguments ecrits en clair d'une commande dont le manuel dit qu'ils designent un objet, un monstre ou une carte.
 * Un argument qui n'est pas un nombre ou une chaine (variable, expression, appel) n'est jamais verifie ; une valeur nulle ou
 * negative non plus (`0` : « aucun », monstre negatif : groupe aleatoire).
 */
function checkReferenceArguments(definition: CommandDefinition, args: readonly Expression[], catalog: ReferenceCatalog, context: FileContext): void {
  const kinds = argumentKindsOf(definition);
  const limit = Math.min(args.length, kinds.length);
  for (let index = 0; index < limit; index += 1) {
    const kind: ArgumentKind | null | undefined = kinds[index];
    if (kind === null || kind === undefined) continue;
    const argument = unwrap(args[index]);
    if (argument === undefined) continue;
    if (argument.kind === "NumberLiteral") {
      const value = argument.value;
      if (!Number.isInteger(value) || value <= 0) continue;
      if (kind === "item" && catalog.itemById(value) === undefined) {
        context.diagnostics.push(createDiagnostic("RA0009", argument.range, { name: String(value) }));
      } else if (kind === "mob" && catalog.mobById(value) === undefined) {
        context.diagnostics.push(createDiagnostic("RA0010", argument.range, { name: String(value) }));
      }
    } else if (argument.kind === "StringLiteral" && !argument.unterminated) {
      const value = argument.value;
      if (value === "") continue;
      if (kind === "item" && catalog.itemByName(value) === undefined) {
        context.diagnostics.push(createDiagnostic("RA0009", argument.range, { name: value }));
      } else if (kind === "mob" && catalog.mobByName(value) === undefined) {
        context.diagnostics.push(createDiagnostic("RA0010", argument.range, { name: value }));
      } else if (kind === "map" && catalog.hasMaps && isCheckableMapName(value) && catalog.mapByName(value) === undefined) {
        context.diagnostics.push(createDiagnostic("RA0008", argument.range, { name: value }));
      }
    }
  }
}

/**
 * Verifie la carte d'une declaration de premier niveau (`prontera,150,150,4\tscript\t...`). `npc_parsesrcfile` (`npc.cpp`) ignore
 * la declaration dont la carte est absente de l'index (erreur journalisee : RA0008), et **sans aucun message** celle dont la
 * carte est dans l'index mais n'est pas chargee par ce serveur (`map_mapname2mapid < 0` : RA0015). `loadable` : faux pour les
 * lignes `mapflag` et les destinations de warp, ou une carte non chargee est sans consequence (le serveur local en compte 26 :
 * toutes des lignes `mapflag`, que la distribution livre pour des cartes qu'un serveur peut desactiver).
 */
function checkDeclarationMap(map: string, range: SourceRange, loadable: boolean, context: FileContext): void {
  const catalog = context.references;
  if (catalog === null || !catalog.hasMaps || !isCheckableMapName(map)) return;
  if (catalog.mapByName(map) === undefined) {
    context.diagnostics.push(createDiagnostic("RA0008", range, { name: map }));
  } else if (loadable && catalog.mapIsLoaded(map) === false) {
    context.diagnostics.push(createDiagnostic("RA0015", range, { name: map }));
  }
}

/**
 * Un label (ou une fonction locale) peut-il porter ce nom ? `set_label` (`script.cpp`) refuse un nom deja pris par une constante
 * (`C_INT`), un parametre (`C_PARAM`) ou une commande du serveur (`C_FUNC`) : « set_label: invalid label name », et le label
 * n'existe pas. Seules comptent les commandes de la table du code source du serveur (pas celles du seul manuel, pas celles que
 * le projet declare, pas celles compilees sous condition) et les constantes lues dans le serveur (pas celles du projet).
 */
function isReservedLabelName(name: string, context: FileContext): boolean {
  const definition = context.commands?.get(name);
  if (definition !== undefined && !definition.conditional && definition.sources.some((source) => source.kind === "server-source")) return true;
  const constant = context.references?.constantByName(name);
  return constant !== undefined && constant.custom !== true;
}

/** Les arguments d'une instruction mal formee (`;` manquant, fragment illisible) ont pu etre mal decoupes : pas de verification. */
function hasReliableArguments(node: CommandStatement | CallExpression, truncated: boolean): boolean {
  if (truncated) return false;
  if (node.kind === "CommandStatement" && !node.terminated) return false;
  return !node.args.some((argument) => argument.kind === "ErrorExpression");
}

function unwrap(expression: Expression | undefined): Expression | undefined {
  let current = expression;
  while (current !== undefined && current.kind === "Parenthesized") current = current.expression;
  return current;
}

function isLocalVariableScope(scope: VariableSummary["scope"]): boolean {
  return scope === "script" || scope === "npc";
}

/** Analyse un script (corps d'un NPC ou d'une fonction globale) : labels, references, variables, diagnostics locaux. */
function analyzeScope(body: BlockStatement, context: FileContext): ScriptScope {
  const labels: LabelSymbol[] = [];
  const references: LabelReference[] = [];
  const functionDeclarations: LocalFunctionDeclaration[] = [];
  const intern = context.intern;
  const locals = new VariableTable(intern);
  const writeTargets = new Set<AstNode>();
  const callNodes: (CommandStatement | CallExpression)[] = [];
  const mentions = new Set<string>();
  let complete = !context.truncated;

  const addReference = (via: LabelReferenceKind, argument: Expression | undefined): void => {
    const target = unwrap(argument);
    if (target !== undefined && target.kind === "Identifier") {
      const name = intern(target.name);
      references.push({ via, name, key: intern(labelKey(name)), range: target.range });
    }
  };

  // Commandes dont des arguments designent un label du script courant. Source : `src/map/script.cpp` de rAthena
  // (`BUILDIN_FUNC(callsub)`, `menu`, `jump_zero`) ; `goto` est une instruction a part dans l'AST.
  // Hercules est suppose identique (non verifie, voir KNOWN_LIMITATIONS).
  const handleInvocation = (
    name: string,
    args: readonly Expression[],
    node: CommandStatement | CallExpression,
  ): void => {
    // Le serveur verifie le nombre d'arguments de chaque commande a la lecture du script (`parse_callfunc`).
    const definition = context.commands?.get(name);
    if (definition !== undefined && hasReliableArguments(node, context.truncated)) {
      const check = checkArity(definition, args.length);
      if (check.kind === "mismatch") {
        const range = node.kind === "CommandStatement" ? node.nameRange : node.calleeRange;
        context.diagnostics.push(createDiagnostic("RA0006", range, { name, expected: formatArity(check.arity), count: args.length }));
      }
    }
    if (context.references !== null && hasReliableArguments(node, context.truncated)) {
      const referenceDefinition = context.referenceCommands?.get(name) ?? definition;
      if (referenceDefinition !== undefined) checkReferenceArguments(referenceDefinition, args, context.references, context);
    }
    const lower = name.toLowerCase();
    switch (lower) {
      case "callsub":
        addReference("callsub", args[0]);
        return;
      case "menu":
        // menu "texte", label, "texte", label ... : les labels occupent les positions impaires (le `-` n'est pas un label).
        for (let i = 1; i < args.length; i += 2) addReference("menu", args[i]);
        return;
      case "jump_zero":
        addReference("jump_zero", args[1]);
        return;
      case "callfunc": {
        const target = unwrap(args[0]);
        if (target !== undefined && target.kind === "StringLiteral" && !target.unterminated) {
          context.functionReferences.push({ name: intern(target.value), range: target.range });
        }
        return;
      }
      default:
        if (SET_COMMANDS.has(lower)) {
          const target = args[0];
          if (target !== undefined && target.kind === "Variable") writeTargets.add(target);
        }
        callNodes.push(node);
    }
  };

  const stack: AstNode[] = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    switch (node.kind) {
      case "LabelStatement": {
        const name = intern(node.name);
        labels.push({
          kind: "label",
          name,
          key: intern(labelKey(name)),
          nameRange: node.nameRange,
          range: node.range,
          isEvent: isEventLabelName(name),
        });
        break;
      }
      case "FunctionStatement": {
        const name = intern(node.name);
        const key = intern(labelKey(name));
        if (node.body === null) {
          functionDeclarations.push({ name, key, nameRange: node.nameRange });
        } else {
          labels.push({ kind: "function", name, key, nameRange: node.nameRange, range: node.range, isEvent: false });
        }
        break;
      }
      case "GotoStatement": {
        const name = intern(node.label);
        references.push({ via: "goto", name, key: intern(labelKey(name)), range: node.labelRange });
        break;
      }
      case "CommandStatement":
        handleInvocation(node.name, node.args, node);
        break;
      case "Call":
        handleInvocation(node.callee, node.args, node);
        break;
      case "Identifier":
        if (context.styleHints) mentions.add(labelKey(node.name));
        break;
      case "Variable": {
        const table = isLocalVariableScope(node.scope) ? locals : context.globals;
        table.add(node, writeTargets.has(node));
        break;
      }
      case "Assignment":
        if (node.target.kind === "Variable") writeTargets.add(node.target);
        break;
      case "Update":
        if (node.operand.kind === "Variable") writeTargets.add(node.operand);
        break;
      case "BlockStatement":
        if (node.closeRange === null) complete = false;
        break;
      case "RawStatement":
      case "ErrorExpression":
        complete = false;
        break;
      default:
        break;
    }
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child !== undefined) stack.push(child);
    }
  }

  // Espace de noms unique : labels et fonctions locales (`set_label` dans script.cpp). Un nom declare par `function X;`
  // est satisfait par n'importe quelle definition de ce nom.
  const definedKeys = new Set<string>();
  const functionKeys = new Set<string>();
  for (const label of labels) {
    definedKeys.add(label.key);
    if (label.kind === "function") functionKeys.add(label.key);
  }
  const declaredKeys = new Set<string>();
  for (const declaration of functionDeclarations) declaredKeys.add(declaration.key);

  // `Nom arg;` ou `Nom(arg)` appelle une fonction locale (le serveur la traduit en callsub). Sinon, avec un registre,
  // un nom qui n'en est pas une commande est garde : seule une fonction globale deja chargee est acceptee par le serveur.
  const commands = context.commands;
  if (functionKeys.size > 0 || declaredKeys.size > 0 || commands !== null) {
    for (const node of callNodes) {
      const isCommand = node.kind === "CommandStatement";
      const written = isCommand ? node.name : node.callee;
      const range = isCommand ? node.nameRange : node.calleeRange;
      const key = labelKey(written);
      if (functionKeys.has(key) || declaredKeys.has(key)) {
        references.push({ via: "call", name: intern(written), key: intern(key), range });
      } else if (commands !== null && !commands.has(written)) {
        context.unknownCalls.push({ name: intern(written), range });
      }
    }
  }

  // --- Diagnostics locaux -------------------------------------------------------------------------------------
  for (const label of labels) {
    if (isReservedLabelName(label.name, context)) context.diagnostics.push(createDiagnostic("RA0014", label.nameRange, { name: label.name }));
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.key)) {
      context.diagnostics.push(createDiagnostic("RA0003", label.nameRange, { name: label.name }));
    } else {
      seen.add(label.key);
    }
  }
  if (complete) {
    for (const declaration of functionDeclarations) {
      if (!definedKeys.has(declaration.key)) {
        context.diagnostics.push(createDiagnostic("RA0012", declaration.nameRange, { name: declaration.name }));
      }
    }
    for (const reference of references) {
      if (reference.via === "call") continue;
      if (!definedKeys.has(reference.key) && !declaredKeys.has(reference.key)) {
        context.diagnostics.push(createDiagnostic("RA0002", reference.range, { name: reference.name }));
      }
    }
    if (context.styleHints) {
      const referenced = new Set<string>(mentions);
      for (const reference of references) referenced.add(reference.key);
      const reported = new Set<string>();
      for (const label of labels) {
        if (label.kind !== "label" || label.isEvent || referenced.has(label.key) || reported.has(label.key)) continue;
        reported.add(label.key);
        context.diagnostics.push(createDiagnostic("RA0007", label.nameRange, { name: label.name }));
      }
    }
  }

  return {
    bodyRange: body.range,
    labels,
    labelReferences: references,
    functionDeclarations,
    variables: locals.toArray(),
    complete,
  };
}

function locationOf(location: MapLocation | null, intern: Interner): Pick<NpcSymbol, "map" | "x" | "y"> {
  if (location === null) return { map: null, x: null, y: null };
  return { map: intern(location.map), x: location.x?.value ?? null, y: location.y?.value ?? null };
}

/**
 * Analyse semantique d'un fichier deja parse : table des symboles (NPC, fonctions, labels, variables), references et
 * diagnostics qui ne dependent que de ce fichier. Les verifications entre fichiers (fonctions introuvables, noms de NPC
 * ou de fonctions en double) sont faites par `WorkspaceIndex`.
 *
 * Fonction pure : ne lit aucun fichier, ne modifie pas l'AST, resultat serialisable.
 */
export function analyzeFile(parse: ParseResult, uri: string, options: AnalyzeOptions = {}): FileAnalysis {
  const intern = createInterner();
  const context: FileContext = {
    intern,
    diagnostics: [],
    functionReferences: [],
    unknownCalls: [],
    globals: new VariableTable(intern),
    styleHints: options.styleHints === true,
    commands: options.commands ?? null,
    referenceCommands: options.referenceCommands ?? null,
    references: options.references ?? null,
    truncated: parse.truncated,
  };
  const declarations: DeclarationSymbol[] = [];

  parse.ast.declarations.forEach((declaration, index) => {
    switch (declaration.kind) {
      case "NpcDeclaration":
        if (declaration.location !== null) checkDeclarationMap(declaration.location.map, declaration.location.mapRange, true, context);
        declarations.push({
          kind: "npc",
          index,
          npcType: "script",
          displayName: intern(declaration.name.display),
          uniqueName: intern(declaration.name.unique),
          nameRange: declaration.name.range,
          range: declaration.range,
          headerRange: declaration.headerRange,
          duplicateOf: null,
          ...locationOf(declaration.location, intern),
          floating: declaration.floating,
          scope: declaration.body === null ? null : analyzeScope(declaration.body, context),
        });
        break;
      case "FunctionDeclaration":
        declarations.push({
          kind: "function",
          index,
          name: intern(declaration.name),
          nameRange: declaration.nameRange,
          range: declaration.range,
          headerRange: declaration.headerRange,
          scope: declaration.body === null ? null : analyzeScope(declaration.body, context),
        });
        break;
      case "DuplicateDeclaration":
        if (declaration.location !== null) checkDeclarationMap(declaration.location.map, declaration.location.mapRange, true, context);
        declarations.push({
          kind: "npc",
          index,
          npcType: "duplicate",
          displayName: intern(declaration.name.display),
          uniqueName: intern(declaration.name.unique),
          nameRange: declaration.name.range,
          range: declaration.range,
          headerRange: declaration.headerRange,
          duplicateOf: { name: intern(declaration.target), range: declaration.targetRange },
          ...locationOf(declaration.location, intern),
          floating: declaration.floating,
          scope: null,
        });
        break;
      case "WarpDeclaration":
        if (declaration.location !== null) checkDeclarationMap(declaration.location.map, declaration.location.mapRange, true, context);
        if (declaration.destination !== null) checkDeclarationMap(declaration.destination.map, declaration.destination.mapRange, false, context);
        declarations.push({
          kind: "npc",
          index,
          npcType: "warp",
          displayName: intern(declaration.name.display),
          uniqueName: intern(declaration.name.unique),
          nameRange: declaration.name.range,
          range: declaration.range,
          headerRange: declaration.headerRange,
          duplicateOf: null,
          ...locationOf(declaration.location, intern),
          floating: false,
          scope: null,
        });
        break;
      case "ShopDeclaration":
        if (declaration.location !== null) checkDeclarationMap(declaration.location.map, declaration.location.mapRange, true, context);
        declarations.push({
          kind: "npc",
          index,
          npcType: declaration.shopType,
          displayName: intern(declaration.name.display),
          uniqueName: intern(declaration.name.unique),
          nameRange: declaration.name.range,
          range: declaration.range,
          headerRange: declaration.headerRange,
          duplicateOf: null,
          ...locationOf(declaration.location, intern),
          floating: declaration.floating,
          scope: null,
        });
        break;
      case "MonsterDeclaration":
        if (declaration.location !== null) checkDeclarationMap(declaration.location.map, declaration.location.mapRange, true, context);
        break;
      case "MapflagDeclaration":
        if (declaration.map !== null) checkDeclarationMap(declaration.map.text, declaration.map.range, false, context);
        break;
      case "RawDeclaration":
        break;
    }
  });

  const diagnostics = context.diagnostics.slice().sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  return {
    uri,
    declarations,
    functionReferences: context.functionReferences,
    unknownCalls: context.unknownCalls,
    globalVariables: context.globals.toArray(),
    diagnostics,
  };
}
