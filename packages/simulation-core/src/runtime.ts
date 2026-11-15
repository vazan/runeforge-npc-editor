import type { SourceRange } from "@runeforge/runescript-core";
import { walk } from "@runeforge/runescript-parser";
import type { BlockStatement, CommandStatement, Expression, NpcDeclaration, Statement } from "@runeforge/runescript-parser";
import { BUILTINS } from "./builtins";
import { PARAMETERS } from "./parameters";
import { MAX_INDEX, Store } from "./store";
import { Fault, Stop } from "./types";
import type {
  CallArguments,
  CallInfo,
  Machine,
  MenuOption,
  Outcome,
  Reference,
  Script,
  SimValue,
  SimulationContext,
  SimulationWorld,
  TranscriptEntry,
} from "./types";
import { createRandom, parseVariableName, toNumber, toText, truthy } from "./values";

/** Instructions et expressions exécutées au plus : borne les boucles sans fin. */
const MAX_STEPS = 200_000;
const MAX_TEXT = 100_000;
const MAX_OPTIONS = 64;
/** Profondeur d'imbrication (instructions, expressions et appels cumulés). */
const MAX_DEPTH = 600;
const MAX_CALLS = 40;
/** Effets et hypothèses distincts conservés dans la transcription. */
const MAX_NOTES = 400;
const MAX_SNIPPET = 160;
const DEFAULT_CLOCK = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Les constantes que la simulation connaît sans catalogue. */
const BASIC_CONSTANTS: ReadonlyMap<string, number> = new Map([
  ["true", 1],
  ["false", 0],
]);

/** Position d'un label : indice dans la liste, puis, pour un label imbriqué, indice dans le bloc (ou 0/1 pour `then`/`else`) et ainsi de suite. */
type Path = readonly number[];

interface Unit {
  readonly statements: readonly Statement[];
  readonly labels: ReadonlyMap<string, Path>;
  /** Texte du fichier qui contient ces instructions : les notes en citent un extrait. */
  readonly source: string;
}

interface Frame {
  readonly locals: Store;
  readonly args: CallArguments;
  readonly unit: Unit;
}

const NO_ARGUMENTS: CallArguments = { values: [], references: [] };

/** Ce qu'une instruction demande à l'instruction qui l'englobe. */
type Completion =
  | undefined
  | { readonly kind: "goto"; readonly label: string; readonly range: SourceRange }
  | { readonly kind: "break" | "continue" }
  | { readonly kind: "return"; readonly value: SimValue | undefined };

/** Labels atteignables par `goto`, `menu` et `callsub` : ceux de la liste, des blocs imbriqués et des branches `then`/`else` en bloc. */
function indexLabels(statements: readonly Statement[], prefix: Path, labels: Map<string, Path>): void {
  statements.forEach((statement, index) => {
    const path = [...prefix, index];
    switch (statement.kind) {
      case "LabelStatement": {
        const key = statement.name.toLowerCase();
        if (!labels.has(key)) labels.set(key, path);
        break;
      }
      case "BlockStatement":
        indexLabels(statement.statements, path, labels);
        break;
      case "IfStatement":
        if (statement.consequent.kind === "BlockStatement") indexLabels(statement.consequent.statements, [...path, 0], labels);
        if (statement.alternate?.kind === "BlockStatement") indexLabels(statement.alternate.statements, [...path, 1], labels);
        break;
      default:
        break;
    }
  });
}

function buildUnit(statements: readonly Statement[], source: string): Unit {
  const labels = new Map<string, Path>();
  indexLabels(statements, [], labels);
  return { statements, labels, source };
}

export class Runtime implements Machine {
  readonly items = new Map<string, number>();
  readonly quests = new Map<number, number>();
  readonly transcript: TranscriptEntry[] = [];
  /** Mots nus lus sans valeur connue : variables non écrites, ou constantes absentes du catalogue (utile aux mesures). */
  readonly unresolved = new Set<string>();
  private readonly globals = new Store();
  private readonly rootLocals = new Store();
  private frames: Frame[] = [];
  private readonly root: Unit;
  private readonly units = new Map<BlockStatement, Unit>();
  private readonly functions = new Map<string, Unit>();
  private readonly noteAt = new Map<string, number>();
  private readonly rng: () => number;
  private notes = 0;
  private steps = 0;
  private textLength = 0;
  /** Valeurs supposées jusqu'ici : un opérande dont le calcul en suppose une ne peut pas être reproché au script. */
  private assumptions = 0;

  constructor(
    readonly npc: NpcDeclaration,
    readonly context: SimulationContext,
    readonly world: SimulationWorld = {},
  ) {
    this.rng = createRandom(world.seed ?? 1);
    const source = world.source ?? "";
    this.root = npc.body === null ? buildUnit([], source) : this.unitOf(npc.body, source);
    this.frames = [{ locals: this.rootLocals, args: NO_ARGUMENTS, unit: this.root }];
    if (npc.body !== null) {
      walk(npc.body, (node) => {
        if (node.kind === "FunctionStatement" && node.body !== null) this.functions.set(node.name.toLowerCase(), this.unitOf(node.body, source));
      });
    }
    for (const [name, value] of context.variables) {
      const target = parseVariableName(name);
      if (target !== null) this.storeOf(target.base).set(target.base, target.index, target.isString ? toText(value) : toNumber(value));
    }
    this.globals.set("zeny", 0, context.zeny);
    this.globals.set("baselevel", 0, context.level);
    this.globals.set("class", 0, context.job);
    for (const [key, quantity] of context.items) this.items.set(this.itemKey(key), (this.items.get(this.itemKey(key)) ?? 0) + quantity);
    for (const [id, state] of context.quests) this.quests.set(id, state);
  }

  // --- Sorties --------------------------------------------------------------------------------------------------

  /** Variables visibles : portée globale et variables locales du script principal. */
  variables(): Map<string, SimValue> {
    return new Map([...this.globals.entries(), ...this.rootLocals.entries()]);
  }

  get zeny(): number {
    return toNumber(this.read({ base: "zeny", index: 0, isString: false }));
  }

  say(text: string, range: SourceRange): void {
    this.textLength += text.length + 1;
    if (this.textLength > MAX_TEXT) this.limit("text", range);
    this.transcript.push({ kind: "mes", text });
  }

  speak(name: string, text: string): void {
    this.textLength += text.length + 1;
    if (this.textLength <= MAX_TEXT) this.transcript.push({ kind: "speech", name, text });
  }

  chosen(text: string): void {
    this.transcript.push({ kind: "player", text });
  }

  effect(call: CallInfo): void {
    this.note("effect", call);
  }

  assume(call: CallInfo, fallback: SimValue): SimValue {
    const value = this.context.results?.get(call.name) ?? fallback;
    this.assumptions += 1;
    this.note("assumed", call, value);
    return value;
  }

  /** Extrait de l'instruction `range` du fichier en cours d'exécution (celui du NPC, ou celui de la fonction appelée). */
  private snippet(range: SourceRange): string {
    const text = this.frame.unit.source.slice(range.start, range.end).replace(/\s+/g, " ").trim();
    return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET - 1)}…` : text;
  }

  /** Une instruction répétée (boucle) n'occupe qu'une ligne, avec son nombre d'exécutions. */
  private note(kind: "effect" | "assumed" | "fault", call: CallInfo, value: SimValue = 0): void {
    const key = `${kind}:${call.range.start}:${call.name}`;
    const at = this.noteAt.get(key);
    const existing = at === undefined ? undefined : this.transcript[at];
    if (at !== undefined && (existing?.kind === "effect" || existing?.kind === "assumed" || existing?.kind === "fault")) {
      this.transcript[at] = { ...existing, count: existing.count + 1 };
      return;
    }
    if (this.notes >= MAX_NOTES) return;
    this.notes += 1;
    const text = this.snippet(call.range) || call.name;
    this.noteAt.set(key, this.transcript.length);
    this.transcript.push(
      kind === "effect"
        ? { kind, name: call.name, text, range: call.range, count: 1 }
        : kind === "fault"
          ? { kind, detail: call.name, text, range: call.range, count: 1 }
          : { kind, name: call.name, text, value, range: call.range, count: 1 },
    );
  }

  // --- Arrêts et écarts -----------------------------------------------------------------------------------------

  stop(outcome: Outcome): never {
    throw new Stop(outcome);
  }

  /** Le serveur arrêterait le script ici : l'écart est noté et l'appelant continue avec une valeur de repli. */
  warn(detail: string, range: SourceRange): void {
    this.note("fault", { name: detail, args: [], range, depth: 0, wantValue: false });
  }

  invalid(detail: string, range: SourceRange): never {
    throw new Fault("invalid", detail, range);
  }

  unsupported(detail: string, range: SourceRange): never {
    throw new Fault("unsupported", detail, range);
  }

  limit(detail: string, range: SourceRange): never {
    throw new Stop({ kind: "limit", detail, range, text: this.snippet(range) });
  }

  /** Note ce qu'une opération fautive a interrompu : le script continue, l'écart ou l'instruction non simulée reste visible. */
  private recover(fault: Fault): void {
    const call: CallInfo = { name: fault.detail, args: [], range: fault.range, depth: 0, wantValue: false };
    this.note(fault.reason === "unsupported" ? "effect" : "fault", call);
  }

  private tick(range: SourceRange, depth: number): void {
    if (++this.steps > MAX_STEPS) this.limit("steps", range);
    if (depth > MAX_DEPTH) this.limit("depth", range);
  }

  random(): number {
    return this.rng();
  }

  clock(): number {
    return this.world.clock ?? DEFAULT_CLOCK;
  }

  // --- Variables ------------------------------------------------------------------------------------------------

  private get frame(): Frame {
    return this.frames[this.frames.length - 1] as Frame;
  }

  /** Les variables `.@x` vivent dans l'appel en cours ; toutes les autres, pour toute la simulation. */
  private storeOf(base: string): Store {
    return base.startsWith(".@") ? this.frame.locals : this.globals;
  }

  private constantOf(key: string): SimValue | undefined {
    return this.world.constants?.get(key) ?? BASIC_CONSTANTS.get(key);
  }

  isKnownName(name: string): boolean {
    const key = name.toLowerCase();
    return this.globals.get(key, 0) !== undefined || PARAMETERS.has(key) || this.constantOf(key) !== undefined;
  }

  /** Mot nu : variable écrite, sinon paramètre du personnage, sinon constante, sinon variable permanente non écrite (0). */
  private readIdentifier(name: string): SimValue {
    const key = name.toLowerCase();
    const stored = this.globals.get(key, 0);
    if (stored !== undefined) return stored;
    const parameter = PARAMETERS.get(key);
    if (parameter !== undefined) return parameter(this.context);
    const constant = this.constantOf(key);
    if (constant !== undefined) return constant;
    this.unresolved.add(key);
    return 0;
  }

  read(reference: Reference): SimValue {
    const stored = (reference.store ?? this.storeOf(reference.base)).get(reference.base, reference.index);
    if (stored !== undefined) return stored;
    if (reference.index === 0 && !reference.isString) {
      const parameter = PARAMETERS.get(reference.base);
      if (parameter !== undefined) return parameter(this.context);
    }
    return reference.isString ? "" : 0;
  }

  /** Comme `set` du serveur : la valeur est convertie au type de la variable. */
  write(reference: Reference, value: SimValue, range: SourceRange): void {
    let converted = reference.isString ? toText(value) : toNumber(value);
    if (reference.base === "zeny" && reference.index === 0 && typeof converted === "number" && converted < 0) {
      // Le serveur refuse un solde négatif : le personnage de test n'a alors plus rien.
      this.warn("zeny", range);
      converted = 0;
    }
    if (typeof converted === "string" && converted.length > MAX_TEXT) this.limit("text", range);
    if (!(reference.store ?? this.storeOf(reference.base)).set(reference.base, reference.index, converted)) this.limit("variables", range);
  }

  arraySize(reference: Reference): number {
    return (reference.store ?? this.storeOf(reference.base)).size(reference.base);
  }

  removeFromArray(reference: Reference, count: number): void {
    (reference.store ?? this.storeOf(reference.base)).remove(reference.base, reference.index, count);
  }

  itemKey(value: SimValue): string {
    if (typeof value === "number") return String(value);
    // Un texte désigne un objet par son nom interne, jamais par un nombre : « 0501 » n'est pas l'objet 501.
    const text = value.trim().toLowerCase();
    const constant = this.world.constants?.get(text);
    return typeof constant === "number" ? String(constant) : text;
  }

  *itemOperand(node: Expression, depth: number): Script<string> {
    if (node.kind === "Identifier" && !this.isKnownName(node.name)) return node.name.toLowerCase();
    return this.itemKey(yield* this.evaluate(node, depth));
  }

  private *indexOf(node: Expression, depth: number): Script<number> {
    const value = yield* this.evaluate(node, depth);
    const index = toNumber(value);
    if (typeof value === "string" || index < 0 || index > MAX_INDEX) {
      // Indice hors des bornes du serveur : l'élément le plus proche tient lieu de l'élément demandé.
      this.warn("index", node.range);
      return Math.min(Math.max(index, 0), MAX_INDEX);
    }
    return index;
  }

  *reference(node: Expression, depth: number): Script<Reference | null> {
    switch (node.kind) {
      case "Variable": {
        const index = node.index === null ? 0 : yield* this.indexOf(node.index, depth + 1);
        return { base: node.raw.toLowerCase(), index, isString: node.isString };
      }
      case "Identifier":
        return { base: node.name.toLowerCase(), index: 0, isString: false };
      case "Parenthesized":
        return yield* this.reference(node.expression, depth + 1);
      case "Call": {
        const name = node.callee.toLowerCase();
        const [first, second] = node.args;
        if (name === "getd" && first !== undefined && node.args.length === 1) {
          return parseVariableName(toText(yield* this.evaluate(first, depth + 1)));
        }
        if (name === "getelementofarray" && first !== undefined && second !== undefined && node.args.length === 2) {
          const base = yield* this.reference(first, depth + 1);
          if (base === null) return null;
          return { ...base, index: yield* this.indexOf(second, depth + 1) };
        }
        if (name === "getarg" && first !== undefined && node.args.length === 1) {
          // Variable reçue en argument (`getelementofarray(getarg(0), 2)`, `getarraysize(getarg(0))`).
          return this.frame.args.references[toNumber(yield* this.evaluate(first, depth + 1))] ?? null;
        }
        if (name === "getvariableofnpc" && first !== undefined && second !== undefined && node.args.length === 2) {
          // Variable `.x` d'un autre NPC : un espace de noms à part ; celle du NPC simulé est la sienne.
          const variable = yield* this.reference(first, depth + 1);
          if (variable === null) return null;
          const owner = toText(yield* this.evaluate(second, depth + 1)).toLowerCase();
          const own = [this.npc.name.unique, this.npc.name.display, this.npc.name.full].map((value) => value.toLowerCase());
          return own.includes(owner) ? variable : { ...variable, base: `${variable.base}::${owner}` };
        }
        return null;
      }
      default:
        return null;
    }
  }

  // --- Évaluation -----------------------------------------------------------------------------------------------

  *values(args: readonly Expression[], depth: number): Script<SimValue[]> {
    const values: SimValue[] = [];
    for (const arg of args) values.push(yield* this.evaluate(arg, depth + 1));
    return values;
  }

  /** Entier hors des bornes sûres : le serveur dépasse ses 64 bits ; ici le plus proche entier sûr tient lieu du résultat. */
  private safe(value: number, range: SourceRange): number {
    if (Number.isSafeInteger(value)) return value;
    this.warn("overflow", range);
    return Number.isNaN(value) ? 0 : value > 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
  }

  /**
   * `assumed` : un opérande dépend d'une valeur supposée (fonction inconnue) ; son type est alors une hypothèse et un
   * texte comparé à un nombre n'est pas reproché au script.
   */
  private binary(operator: string, left: SimValue, right: SimValue, range: SourceRange, assumed = false): SimValue {
    if (typeof left === "string" || typeof right === "string") {
      if (operator === "+") {
        const text = toText(left) + toText(right);
        if (text.length > MAX_TEXT) this.limit("text", range);
        return text;
      }
      if (typeof left === "string" && typeof right === "string") {
        switch (operator) {
          case "==": return Number(left === right);
          case "!=": return Number(left !== right);
          case "<": return Number(left < right);
          case "<=": return Number(left <= right);
          case ">": return Number(left > right);
          case ">=": return Number(left >= right);
        }
      }
      // Le serveur s'arrête sur un texte mêlé à un nombre (ou sur un texte en arithmétique) ; ici, l'égalité compare les
      // textes et tout le reste, les nombres que les textes représentent.
      if (!assumed) this.warn("operand", range);
      if (operator === "==") return Number(toText(left) === toText(right));
      if (operator === "!=") return Number(toText(left) !== toText(right));
      return this.binary(operator, toNumber(left), toNumber(right), range, true);
    }
    switch (operator) {
      case "+": return this.safe(left + right, range);
      case "-": return this.safe(left - right, range);
      case "*": return this.safe(left * right, range);
      case "/":
      case "%":
        if (right === 0) {
          this.warn("divide", range);
          return 0;
        }
        return operator === "/" ? Math.trunc(left / right) : left % right;
      case "==": return Number(left === right);
      case "!=": return Number(left !== right);
      case "<": return Number(left < right);
      case "<=": return Number(left <= right);
      case ">": return Number(left > right);
      case ">=": return Number(left >= right);
      case "&&": return Number(left !== 0 && right !== 0);
      case "||": return Number(left !== 0 || right !== 0);
      case "&": return this.safe(Number(BigInt(left) & BigInt(right)), range);
      case "|": return this.safe(Number(BigInt(left) | BigInt(right)), range);
      case "^": return this.safe(Number(BigInt(left) ^ BigInt(right)), range);
      case "<<":
      case ">>":
        if (right < 0 || right > 62) {
          this.warn("shift", range);
          return 0;
        }
        return this.safe(Number(operator === "<<" ? BigInt(left) << BigInt(right) : BigInt(left) >> BigInt(right)), range);
      default:
        return this.unsupported(operator, range);
    }
  }

  /** Évalue une expression ; une opération fautive devient 0 (l'écart est noté) sans interrompre le script. */
  *evaluate(node: Expression, depth: number): Script<SimValue> {
    try {
      return yield* this.evaluateNode(node, depth);
    } catch (error) {
      if (!(error instanceof Fault)) throw error;
      this.recover(error);
      return 0;
    }
  }

  private *evaluateNode(node: Expression, depth: number): Script<SimValue> {
    this.tick(node.range, depth);
    const child = depth + 1;
    switch (node.kind) {
      case "NumberLiteral":
        return this.safe(node.value, node.range);
      case "StringLiteral":
        return node.value;
      case "Identifier":
        return this.readIdentifier(node.name);
      case "Variable": {
        const reference = yield* this.reference(node, child);
        return reference === null ? this.unsupported(node.raw, node.range) : this.read(reference);
      }
      case "Parenthesized":
        return yield* this.evaluate(node.expression, child);
      case "Placeholder":
        return 0;
      case "Unary": {
        const before = this.assumptions;
        const operand = yield* this.evaluate(node.operand, child);
        const range = node.range;
        // Un texte sous `!`, `-`, `+` ou `~` : le serveur s'arrête ; ici, le nombre que le texte représente.
        if (typeof operand === "string" && this.assumptions === before) this.warn("operand", range);
        const value = toNumber(operand);
        switch (node.operator) {
          case "!": return Number(value === 0);
          case "-": return -value;
          case "+": return value;
          case "~": return -value - 1;
          default: return this.unsupported("operator", range);
        }
      }
      case "Update": {
        const reference = yield* this.reference(node.operand, child);
        if (reference === null || reference.isString) return this.unsupported(node.operator, node.range);
        const before = toNumber(this.read(reference));
        const after = this.safe(before + (node.operator === "++" ? 1 : -1), node.range);
        this.write(reference, after, node.range);
        return node.prefix ? after : before;
      }
      case "Binary": {
        // Le serveur évalue toujours les deux opérandes, même pour `&&` et `||`.
        const before = this.assumptions;
        const left = yield* this.evaluate(node.left, child);
        const right = yield* this.evaluate(node.right, child);
        return this.binary(node.operator, left, right, node.range, this.assumptions !== before);
      }
      case "Conditional": {
        // Idem : les deux branches sont calculées, puis l'une est retenue.
        const test = yield* this.evaluate(node.test, child);
        const consequent = yield* this.evaluate(node.consequent, child);
        const alternate = yield* this.evaluate(node.alternate, child);
        return truthy(test) ? consequent : alternate;
      }
      case "Assignment": {
        const reference = yield* this.reference(node.target, child);
        if (reference === null) return this.unsupported("assignment", node.range);
        const before = this.assumptions;
        const right = yield* this.evaluate(node.value, child);
        const value = node.operator === "=" ? right : this.binary(node.operator.slice(0, -1), this.read(reference), right, node.range, this.assumptions !== before);
        this.write(reference, value, node.range);
        return this.read(reference);
      }
      case "Call": {
        const name = node.callee.toLowerCase();
        if (name === "getvariableofnpc") {
          const reference = yield* this.reference(node, child);
          return reference === null ? this.unsupported(name, node.range) : this.read(reference);
        }
        return (yield* this.call(name, node.args, node.range, child, true)) ?? 0;
      }
      case "ErrorExpression":
        return this.unsupported("syntax", node.range);
    }
  }

  /** Commande ou fonction : intégrée, définie par le script, ou inconnue (effet non simulé, valeur supposée). */
  private *call(
    name: string,
    args: readonly Expression[],
    range: SourceRange,
    depth: number,
    wantValue: boolean,
  ): Script<SimValue | undefined> {
    const info: CallInfo = { name, args, range, depth, wantValue };
    const builtin = BUILTINS.get(name);
    if (builtin !== undefined) return yield* builtin(this, info);
    if (this.hasFunction(name)) return yield* this.callFunction(name, yield* this.arguments(args, depth), range, depth);
    if (wantValue) return this.assume(info, 0);
    this.effect(info);
    return undefined;
  }

  // --- Appels ---------------------------------------------------------------------------------------------------

  private unitOf(block: BlockStatement, source: string): Unit {
    let unit = this.units.get(block);
    if (unit === undefined) {
      unit = buildUnit(block.statements, source);
      this.units.set(block, unit);
    }
    return unit;
  }

  private functionUnit(name: string): Unit | undefined {
    const local = this.functions.get(name);
    if (local !== undefined) return local;
    const found = this.world.functions?.get(name);
    return found?.declaration.body == null ? undefined : this.unitOf(found.declaration.body, found.source);
  }

  hasFunction(name: string): boolean {
    return this.functionUnit(name.toLowerCase()) !== undefined;
  }

  /** Valeurs des arguments d'un appel et, pour une variable passée telle quelle, sa référence. */
  *arguments(nodes: readonly Expression[], depth: number): Script<CallArguments> {
    const values = yield* this.values(nodes, depth);
    const references = nodes.map((node): Reference | null => {
      if (node.kind === "Variable" && node.index === null) {
        const base = node.raw.toLowerCase();
        return { base, index: 0, isString: node.isString, store: this.storeOf(base) };
      }
      if (node.kind === "Identifier" && !PARAMETERS.has(node.name.toLowerCase()) && this.constantOf(node.name.toLowerCase()) === undefined) {
        return { base: node.name.toLowerCase(), index: 0, isString: false, store: this.globals };
      }
      return null;
    });
    return { values, references };
  }

  *callFunction(name: string, args: CallArguments, range: SourceRange, depth: number): Script<SimValue | undefined> {
    const unit = this.functionUnit(name.toLowerCase());
    if (unit === undefined) return this.invalid(`label ${name}`, range);
    return yield* this.invoke(unit, [0], args, range, depth);
  }

  *callLabel(label: string, args: CallArguments, range: SourceRange, depth: number): Script<SimValue | undefined> {
    const unit = this.frame.unit;
    const path = unit.labels.get(label.toLowerCase());
    if (path === undefined) return this.invalid(`label ${label}`, range);
    return yield* this.invoke(unit, path, args, range, depth);
  }

  private *invoke(unit: Unit, path: Path, args: CallArguments, range: SourceRange, depth: number): Script<SimValue | undefined> {
    if (this.frames.length >= MAX_CALLS) this.limit("calls", range);
    this.frames.push({ locals: new Store(), args, unit });
    try {
      const completion = yield* this.runUnit(unit, path, depth + 1);
      if (completion?.kind === "return") return completion.value;
      // Sans `return`, la fin du code termine le script, comme sur le serveur.
      return this.stop({ kind: "end" });
    } finally {
      this.frames.pop();
    }
  }

  getArgument(index: number, range: SourceRange, fallback: SimValue | undefined): SimValue {
    const value = this.frame.args.values[index];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    // Le serveur s'arrête sur un argument que l'appel n'a pas fourni ; ici, 0 (ou le texte vide) tient lieu de l'argument.
    this.warn("getarg", range);
    return 0;
  }

  argumentCount(): number {
    return this.frame.args.values.length;
  }

  // --- Menus ----------------------------------------------------------------------------------------------------

  *choose(options: readonly string[], range: SourceRange): Script<number> {
    const labels = options.flatMap((text) => text.split(":"));
    if (labels.length > MAX_OPTIONS || labels.join("").length > MAX_TEXT) this.limit("menu", range);
    const entries: MenuOption[] = labels.flatMap((label, index) => (label === "" ? [] : [{ label, value: index + 1 }]));
    // Un menu sans option (`select("")`) n'offre au joueur que d'annuler, ce qui termine le script.
    if (entries.length === 0) return this.stop({ kind: "end" });
    const choice = yield { kind: "choice", options: entries };
    const picked = entries.find((entry) => entry.value === choice);
    if (picked === undefined) return this.invalid("menu", range);
    this.chosen(picked.label);
    this.globals.set("@menu", 0, picked.value);
    return picked.value;
  }

  /** `menu "texte",label,"texte",-;` : le choix saute au label, ou continue avec `-`. */
  private *menu(node: CommandStatement, depth: number): Script<Completion> {
    if (node.args.length === 0 || node.args.length % 2 !== 0) this.invalid("menu", node.range);
    const labels: string[] = [];
    const destinations: string[] = [];
    for (let index = 0; index < node.args.length; index += 2) {
      const text = node.args[index];
      const target = node.args[index + 1];
      if (text === undefined || target === undefined) return this.invalid("menu", node.range);
      const jump = target.kind === "Identifier" ? target.name : target.kind === "Placeholder" && target.reason === "dash" ? "" : null;
      if (jump === null) return this.unsupported("menu", node.range);
      const label = toText(yield* this.evaluate(text, depth + 1));
      labels.push(label);
      for (const _part of label.split(":")) destinations.push(jump);
    }
    const choice = yield* this.choose(labels, node.range);
    const destination = destinations[choice - 1];
    return destination ? { kind: "goto", label: destination, range: node.range } : undefined;
  }

  // --- Instructions ---------------------------------------------------------------------------------------------

  /** Exécute `statements` à partir de `path` ; un chemin plus long reprend à l'intérieur d'un bloc (label imbriqué). */
  private *execFrom(statements: readonly Statement[], path: Path, depth: number): Script<Completion> {
    const [start = 0, ...rest] = path;
    for (let index = start; index < statements.length; index += 1) {
      const statement = statements[index] as Statement;
      const completion = index === start && rest.length > 0 ? yield* this.resume(statement, rest, depth) : yield* this.statement(statement, depth);
      if (completion !== undefined) return completion;
    }
    return undefined;
  }

  private *resume(statement: Statement, rest: Path, depth: number): Script<Completion> {
    this.tick(statement.range, depth);
    if (statement.kind === "BlockStatement") return yield* this.execFrom(statement.statements, rest, depth + 1);
    if (statement.kind === "IfStatement") {
      const [branch = 0, ...inner] = rest;
      const body = branch === 0 ? statement.consequent : statement.alternate;
      if (body?.kind === "BlockStatement") return yield* this.execFrom(body.statements, inner, depth + 1);
    }
    return this.invalid("label", statement.range);
  }

  /** Exécute une unité (script, fonction) ; un `goto` ou `menu` saute à un de ses labels. */
  private *runUnit(unit: Unit, path: Path, depth: number): Script<Completion> {
    let next = path;
    for (;;) {
      const completion = yield* this.execFrom(unit.statements, next, depth);
      if (completion?.kind !== "goto") return completion?.kind === "return" ? completion : undefined;
      const target = unit.labels.get(completion.label.toLowerCase());
      if (target === undefined) {
        // Label introuvable : le serveur s'arrête ; ici, le code en cours se termine là.
        this.warn(`label ${completion.label}`, completion.range);
        return undefined;
      }
      this.tick(completion.range, depth);
      next = target;
    }
  }

  private *loopBody(body: Statement, depth: number): Script<{ readonly stop: boolean; readonly completion: Completion }> {
    const completion = yield* this.statement(body, depth);
    if (completion === undefined || completion.kind === "continue") return { stop: false, completion: undefined };
    if (completion.kind === "break") return { stop: true, completion: undefined };
    return { stop: true, completion };
  }

  /** Exécute une instruction ; si elle est fautive, l'écart est noté et le script reprend à l'instruction suivante. */
  private *statement(node: Statement, depth: number): Script<Completion> {
    try {
      return yield* this.statementNode(node, depth);
    } catch (error) {
      if (!(error instanceof Fault)) throw error;
      this.recover(error);
      return undefined;
    }
  }

  private *statementNode(node: Statement, depth: number): Script<Completion> {
    this.tick(node.range, depth);
    const child = depth + 1;
    switch (node.kind) {
      case "EmptyStatement":
      case "LabelStatement":
      case "FunctionStatement":
      case "CaseStatement":
      case "DefaultStatement":
        return undefined;
      case "BlockStatement":
        return yield* this.execFrom(node.statements, [0], child);
      case "IfStatement": {
        const test = yield* this.evaluate(node.condition, child);
        const branch = truthy(test) ? node.consequent : node.alternate;
        return branch === null ? undefined : yield* this.statement(branch, child);
      }
      case "WhileStatement":
        while (truthy(yield* this.evaluate(node.condition, child))) {
          this.tick(node.range, child);
          const result = yield* this.loopBody(node.body, child);
          if (result.stop) return result.completion;
        }
        return undefined;
      case "DoWhileStatement":
        do {
          this.tick(node.range, child);
          const result = yield* this.loopBody(node.body, child);
          if (result.stop) return result.completion;
        } while (truthy(yield* this.evaluate(node.condition, child)));
        return undefined;
      case "ForStatement": {
        if (node.init !== null) yield* this.statement(node.init, child);
        while (node.condition === null || truthy(yield* this.evaluate(node.condition, child))) {
          this.tick(node.range, child);
          const result = yield* this.loopBody(node.body, child);
          if (result.stop) return result.completion;
          if (node.update !== null) yield* this.statement(node.update, child);
        }
        return undefined;
      }
      case "SwitchStatement": {
        const value = yield* this.evaluate(node.discriminant, child);
        if (node.body.kind !== "BlockStatement") return this.unsupported("switch", node.range);
        const statements = node.body.statements;
        let start = -1;
        let fallback = -1;
        for (const [index, statement] of statements.entries()) {
          if (statement.kind === "DefaultStatement") fallback = index;
          if (statement.kind !== "CaseStatement") continue;
          const test = yield* this.evaluate(statement.test, child);
          if (test === value) {
            start = index;
            break;
          }
        }
        if (start < 0) start = fallback;
        if (start < 0) return undefined;
        for (let index = start; index < statements.length; index += 1) {
          const completion = yield* this.statement(statements[index] as Statement, child);
          if (completion?.kind === "break") return undefined;
          if (completion !== undefined) return completion;
        }
        return undefined;
      }
      case "BreakStatement":
        return { kind: "break" };
      case "ContinueStatement":
        return { kind: "continue" };
      case "ReturnStatement": {
        // `return` sert aux fonctions et aux sous-programmes : le script principal n'a rien à qui rendre la main, le serveur
        // l'arrête ; ici aussi.
        if (this.frames.length <= 1) {
          this.warn("return", node.range);
          return this.stop({ kind: "end" });
        }
        const value = node.value === null ? undefined : yield* this.evaluate(node.value, child);
        return { kind: "return", value };
      }
      case "GotoStatement":
        return { kind: "goto", label: node.label, range: node.range };
      case "CommandStatement":
        if (node.name.toLowerCase() === "menu") return yield* this.menu(node, child);
        yield* this.call(node.name.toLowerCase(), node.args, node.range, child, false);
        return undefined;
      case "ExpressionStatement":
        yield* this.evaluate(node.expression, child);
        return undefined;
      case "RawStatement":
        return this.unsupported("syntax", node.range);
    }
  }

  // --- Exécution ------------------------------------------------------------------------------------------------

  /**
   * Le serveur exécute `OnInit:` au chargement : les variables du NPC (`.prix`...) sont prêtes avant la première
   * visite. On l'exécute de même, sans rien montrer : texte, effets et attentes du joueur sont écartés.
   */
  private initialize(): void {
    const path = this.root.labels.get("oninit");
    if (path === undefined) return;
    const saved = { steps: this.steps, text: this.textLength };
    this.frames = [{ locals: new Store(), args: NO_ARGUMENTS, unit: this.root }];
    const execution = this.runUnit(this.root, path, 0);
    try {
      execution.next(undefined);
    } catch (error) {
      if (!(error instanceof Stop) && !(error instanceof Fault)) throw error;
    } finally {
      execution.return(undefined);
    }
    this.transcript.length = 0;
    this.noteAt.clear();
    this.notes = 0;
    this.assumptions = 0;
    this.steps = saved.steps;
    this.textLength = saved.text;
  }

  *run(): Script<Outcome> {
    try {
      this.initialize();
      this.frames = [{ locals: this.rootLocals, args: NO_ARGUMENTS, unit: this.root }];
      yield* this.runUnit(this.root, [0], 0);
      return { kind: "end" };
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      if (error instanceof Fault) {
        this.recover(error);
        return { kind: "end" };
      }
      // Défaut du simulateur lui-même : il ne doit jamais s'échapper vers l'application. Il est montré comme un écart
      // `internal` (les mesures sur corpus les comptent comme des défauts) et le script se termine là.
      this.transcript.push({ kind: "fault", detail: "internal", text: error instanceof Error ? error.message : String(error), range: { start: 0, end: 0 }, count: 1 });
      return { kind: "end" };
    }
  }
}
