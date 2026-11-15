import { allowsSkillArgument, argumentKindsOf, CommandRegistry } from "@runeforge/emulator-core";
import type { ArgumentKind, CatalogStats, ItemRecord, MapRecord, MobRecord, ReferenceCatalog, ReferenceHit, ReferenceKind, RegistryStats, SkillRecord } from "@runeforge/emulator-core";
import { LineIndex } from "@runeforge/runescript-core";
import type { ParseDiagnostic, Position, SourceRange } from "@runeforge/runescript-core";
import { analyzeFile, isCheckableMapName, WorkspaceIndex } from "@runeforge/runescript-analysis";
import type { FileAnalysis, ScriptScope, VariableSummary } from "@runeforge/runescript-analysis";
import { findNodeAt, parse, walk } from "@runeforge/runescript-parser";
import type { Expression, ParseResult } from "@runeforge/runescript-parser";
import { templatesFor } from "@runeforge/npc-templates";
import { scanCalls } from "./call-scan";
import { commandInfoOf, signatureHelpOf, signatureViewsOf } from "./command-info";
import { completionContextAt } from "./completion-context";
import type { CompletionContext } from "./completion-context";
import { buildOutline, toRange } from "./outline";
import { computeRename, prepareRename } from "./rename";
import type { RenamePreparation, RenameResult } from "./rename";
import { matchScore } from "./search";
import { contains, resolveTarget, variableKey, variableRange } from "./symbol-at";
import type { SymbolTarget } from "./symbol-at";
import { CompletionItemKind, MAX_COMMAND_COMPLETIONS, MAX_COMPLETIONS, MAX_REPORT_ITEMS, SymbolKind } from "./types";
import type {
  CommandInfo,
  CompletionItem,
  DocumentSymbol,
  FileDiagnostics,
  HoverInfo,
  IndexStats,
  LanguageServerOptions,
  Location,
  ProjectReport,
  ProjectReportOptions,
  Range,
  ReportFile,
  ReportItem,
  SignatureHelp,
  WorkspaceSymbol,
} from "./types";

/** Ce que le service retient d'un fichier du projet : de quoi repondre aux requetes sans conserver le texte. */
interface FileRecord {
  readonly analysis: FileAnalysis;
  readonly lines: LineIndex;
  readonly syntax: readonly ParseDiagnostic[];
}

/** Document ouvert dans l'editeur : son texte (en LF) fait foi, pas le disque. */
interface OpenDocument extends FileRecord {
  readonly version: number;
  readonly text: string;
  readonly parse: ParseResult;
}

/** Mots-cles du langage proposes au debut d'une instruction (ce ne sont pas des commandes du registre). */
const LANGUAGE_KEYWORDS: readonly string[] = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "function"];

/**
 * Nombre de lignes precedentes lues pour retrouver la commande dont on ecrit les arguments (appel sur plusieurs lignes).
 * Mesure sur les 512 801 instructions-commandes du serveur local : 99,99 % tiennent sur 12 lignes ou moins, la plus longue sur 57
 * (un `setarray` de 33 arguments, un par ligne) ; la borne est le double du maximum observe.
 */
const SIGNATURE_LINES = 120;

/** Debut de la ligne situee `lines` lignes avant celle qui contient `offset`. */
function windowStartOf(text: string, offset: number, lines: number): number {
  let start = offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
  for (let i = 0; i < lines && start > 0; i += 1) start = text.lastIndexOf("\n", start - 2) + 1;
  return start;
}

const DEFAULT_OPTIONS: LanguageServerOptions = { crossFile: "off", styleHints: false, unknownCommands: "warning", unknownReferences: "info", emulator: null };

function byPosition(a: ParseDiagnostic, b: ParseDiagnostic): number {
  return a.range.start - b.range.start || a.range.end - b.range.end;
}

const REFERENCE_CODES: ReadonlySet<string> = new Set(["RA0008", "RA0009", "RA0010", "RA0015"]);

/** Nombre de propositions de constantes (le serveur en exporte une dizaine de milliers : le filtre de l'editeur affine ensuite). */
const MAX_CONSTANT_COMPLETIONS = 100;

function unwrapExpression(expression: Expression | undefined): Expression | undefined {
  let current = expression;
  while (current !== undefined && current.kind === "Parenthesized") current = current.expression;
  return current;
}

/** Complement bref d'une reference proposee, sans texte redige (identifiant, nom d'affichage, type ou niveau). */
function describeHit(hit: ReferenceHit): string {
  if (hit.kind === "map") return hit.id === null ? "" : `#${hit.id}`;
  if (hit.kind === "constant") return hit.id === null ? (hit.detail ?? "") : `= ${hit.id}`;
  return [hit.id, hit.displayName, hit.detail].filter((part) => part !== null && part !== "").join(" · ");
}

/**
 * Service de langage RuneScript : synchronisation des documents, indexation du projet, diagnostics, plan, definition,
 * references et recherche de symboles. Aucune dependance a une interface, a Monaco, a Tauri ni au systeme de fichiers :
 * il recoit du texte et repond par des structures simples (utilisable depuis un Worker).
 *
 * Deux sources de texte coexistent :
 * - les **documents ouverts** (`updateDocument`) : texte de l'editeur, normalise en LF, qui prime sur le disque ;
 * - les **fichiers du projet** (`indexText`) : texte lu sur le disque, pour les fonctionnalites entre fichiers.
 * Les positions `{ line, character }` ne dependent pas du type de fin de ligne : un resultat reste valable que le
 * fichier soit ouvert (LF) ou seulement indexe (CRLF d'origine).
 */
export class LanguageServer {
  private readonly index = new WorkspaceIndex();
  private readonly records = new Map<string, FileRecord>();
  private readonly open = new Map<string, OpenDocument>();
  private options: LanguageServerOptions = DEFAULT_OPTIONS;
  private commands: CommandRegistry | null = null;
  private commandLibrary: CommandRegistry | null = null;
  private assistanceCommands: CommandRegistry | null = null;
  private referenceCatalog: ReferenceCatalog | null = null;

  setOptions(options: Partial<LanguageServerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  getOptions(): LanguageServerOptions {
    return this.options;
  }

  /**
   * Definit le registre de commandes du profil (`null` : aucune verification de commande). Les documents ouverts sont
   * analyses de nouveau tout de suite ; les fichiers seulement indexes ne gardent pas leur texte et doivent etre relus
   * par l'appelant pour tenir compte du nouveau registre.
   */
  setCommandRegistry(registry: CommandRegistry | null): void {
    this.commands = registry;
    this.refreshAssistanceCommands();
    this.reanalyzeOpenDocuments();
  }

  /** Definit les commandes utilisees seulement pour la completion et l'aide, sans modifier les diagnostics. */
  setCommandLibrary(registry: CommandRegistry | null): void {
    this.commandLibrary = registry;
    this.refreshAssistanceCommands();
    this.reanalyzeOpenDocuments();
  }

  private refreshAssistanceCommands(): void {
    const definitions = [...(this.commands?.definitions() ?? []), ...(this.commandLibrary?.definitions() ?? [])];
    this.assistanceCommands =
      definitions.length === 0
        ? null
        : CommandRegistry.create(definitions, this.commands?.profileLabel ?? this.commandLibrary?.profileLabel ?? "rAthena");
  }

  /**
   * Definit le catalogue de references (objets, monstres, cartes, constantes) du serveur (`null` : aucune verification ni
   * proposition). Meme regle que pour le registre : les documents ouverts sont analyses de nouveau, les fichiers simplement
   * indexes doivent etre relus par l'appelant.
   */
  setReferenceCatalog(catalog: ReferenceCatalog | null): void {
    this.referenceCatalog = catalog;
    this.reanalyzeOpenDocuments();
  }

  private reanalyzeOpenDocuments(): void {
    for (const [uri, document] of this.open) {
      const analysis = analyzeFile(document.parse, uri, this.analysisOptions());
      const updated: OpenDocument = { ...document, analysis };
      this.open.set(uri, updated);
      this.records.set(uri, updated);
      this.index.set(analysis);
    }
  }

  /** Nombre de commandes du registre actif, ou `null` s'il n'y en a pas. */
  commandStats(): RegistryStats | null {
    return this.commands === null ? null : this.commands.stats();
  }

  /** Ce que contient le catalogue de references actif, ou `null` s'il n'y en a pas. */
  referenceStats(): CatalogStats | null {
    return this.referenceCatalog === null ? null : this.referenceCatalog.stats();
  }

  /**
   * Recherche libre dans le catalogue de references (objets, monstres, cartes, constantes) : pour retrouver et inserer une
   * reference sans la connaitre par coeur. Vide sans catalogue.
   */
  searchReferences(kind: ReferenceKind, query: string, limit = 50): ReferenceHit[] {
    return this.referenceCatalog === null ? [] : this.referenceCatalog.search(kind, query, limit);
  }

  private analysisOptions(): {
    styleHints: boolean;
    commands: CommandRegistry | null;
    referenceCommands: CommandRegistry | null;
    references: ReferenceCatalog | null;
  } {
    return {
      styleHints: this.options.styleHints,
      commands: this.commands,
      referenceCommands: this.assistanceCommands,
      references: this.referenceCatalog,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Synchronisation
  // ---------------------------------------------------------------------------------------------

  /**
   * Ouvre ou met a jour un document (texte complet, en LF). Une version plus ancienne que la connue est ignoree.
   * `truncated` : l'analyse a ete interrompue par une limite (profondeur) ; le texte, lui, reste intact.
   */
  updateDocument(uri: string, version: number, text: string): { truncated: boolean } {
    const known = this.open.get(uri);
    if (known !== undefined && version < known.version) return { truncated: known.parse.truncated };
    const parsed = parse(text);
    const analysis = analyzeFile(parsed, uri, this.analysisOptions());
    const document: OpenDocument = {
      analysis,
      lines: new LineIndex(text),
      syntax: parsed.diagnostics,
      version,
      text,
      parse: parsed,
    };
    this.open.set(uri, document);
    this.records.set(uri, document);
    this.index.set(analysis);
    return { truncated: parsed.truncated };
  }

  /**
   * Diagnostics d'un texte qui n'est pas un document du projet : l'apercu d'un assistant. Il est analyse comme un fichier du
   * projet (syntaxe, semantique locale, commande inconnue, nombre d'arguments, references du catalogue) mais n'entre ni dans
   * l'index ni dans les documents ouverts : ses fonctions n'existent pas pour le reste du projet, et rien n'est retenu. Les
   * verifications qui comparent des fichiers entre eux (doublons, ordre de chargement) ne s'appliquent pas : le texte n'a pas
   * encore de place dans le projet.
   */
  previewDiagnostics(text: string): ParseDiagnostic[] {
    const parsed = parse(text);
    const analysis = analyzeFile(parsed, "preview://text", this.analysisOptions());
    const result: ParseDiagnostic[] = [...parsed.diagnostics, ...analysis.diagnostics];
    if (this.commands !== null && this.options.unknownCommands !== "off") {
      result.push(...this.index.unknownCommandsOf(analysis, { severity: this.options.unknownCommands, profile: this.commands.profileLabel }));
    }
    return result.sort(byPosition);
  }

  /** Ferme un document : son analyse reste dans l'index (derniere version connue), sans conserver texte ni AST. */
  closeDocument(uri: string): void {
    const document = this.open.get(uri);
    if (document === undefined) return;
    this.open.delete(uri);
    this.records.set(uri, { analysis: document.analysis, lines: document.lines, syntax: document.syntax });
  }

  /** Indexe un fichier du projet lu sur le disque. Ignore s'il est ouvert : le texte de l'editeur prime. */
  indexText(uri: string, text: string): void {
    if (this.open.has(uri)) return;
    const parsed = parse(text);
    const analysis = analyzeFile(parsed, uri, this.analysisOptions());
    this.records.set(uri, { analysis, lines: new LineIndex(text), syntax: parsed.diagnostics });
    this.index.set(analysis);
  }

  /** Retire un fichier (supprime du projet). */
  removeFile(uri: string): void {
    this.open.delete(uri);
    this.records.delete(uri);
    this.index.delete(uri);
  }

  /**
   * Donne l'ordre de chargement des fichiers par le serveur (les plus tot charges d'abord) ; `null` : ordre inconnu. Avec lui,
   * l'appel par son nom d'une fonction que le serveur n'a pas encore chargee est signale (`RA0016`).
   */
  setLoadOrder(files: readonly string[] | null): void {
    this.index.setLoadOrder(files);
  }

  clearIndex(): void {
    this.open.clear();
    this.records.clear();
    this.index.clear();
  }

  stats(): IndexStats {
    return {
      files: this.records.size,
      openDocuments: this.open.size,
      functions: this.index.functionCount,
      npcs: this.index.npcCount,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------------------------

  /**
   * Diagnostics d'un fichier : syntaxe, semantique locale (dont le nombre d'arguments des commandes, avec un registre),
   * selon `crossFile` les verifications entre fichiers, et selon `unknownCommands` les commandes inconnues.
   */
  diagnostics(uri: string): ParseDiagnostic[] {
    const record = this.records.get(uri);
    if (record === undefined) return [];
    const result: ParseDiagnostic[] = [...record.syntax];
    for (const diagnostic of record.analysis.diagnostics) {
      if (!REFERENCE_CODES.has(diagnostic.code)) {
        result.push(diagnostic);
      } else if (this.options.unknownReferences !== "off") {
        result.push(diagnostic.severity === this.options.unknownReferences ? diagnostic : { ...diagnostic, severity: this.options.unknownReferences });
      }
    }
    if (this.options.crossFile !== "off") {
      result.push(...this.index.crossFileDiagnostics(uri, { reportUnresolved: this.options.crossFile === "all" }));
    }
    if (this.commands !== null && this.options.unknownCommands !== "off") {
      result.push(
        ...this.index.unknownCommandDiagnostics(uri, { severity: this.options.unknownCommands, profile: this.commands.profileLabel }),
        ...this.index.loadOrderDiagnostics(uri),
      );
    }
    return result.sort(byPosition);
  }

  /** Diagnostics de tous les fichiers indexes qui en ont (rapport de projet). */
  projectDiagnostics(): FileDiagnostics[] {
    const report: FileDiagnostics[] = [];
    for (const uri of this.records.keys()) {
      const diagnostics = this.diagnostics(uri);
      if (diagnostics.length > 0) report.push({ uri, diagnostics });
    }
    return report.sort((a, b) => a.uri.localeCompare(b.uri));
  }

  /**
   * Rapport de projet (RF-015) : les diagnostics de tous les fichiers indexes avec la position de chacun, les totaux par
   * gravite et par code, et les fichiers les plus graves d'abord. Les diagnostics sont ceux de `diagnostics(uri)` : un fichier
   * ouvert y figure avec le texte de l'editeur, un autre avec celui qui a ete lu sur le disque. Au-dela de `MAX_REPORT_ITEMS`
   * problemes, le detail des derniers fichiers est omis (`truncated`) mais les totaux restent exacts. Avec `only`, seuls les
   * fichiers nommes sont rapportes (et la limite ne s'applique qu'a eux) ; les autres sont comptes dans `excluded`.
   */
  projectReport(options: ProjectReportOptions = {}): ProjectReport {
    interface Entry {
      readonly uri: string;
      readonly diagnostics: ParseDiagnostic[];
      errors: number;
      warnings: number;
      infos: number;
    }
    const only = options.only === undefined || options.only === null ? null : new Set(options.only);
    const excluded = { examined: 0, files: 0, problems: 0 };
    const entries: Entry[] = [];
    const totals = { errors: 0, warnings: 0, infos: 0 };
    const byCode = new Map<string, number>();
    for (const uri of this.records.keys()) {
      const diagnostics = this.diagnostics(uri);
      if (only !== null && !only.has(uri)) {
        excluded.examined += 1;
        if (diagnostics.length > 0) {
          excluded.files += 1;
          excluded.problems += diagnostics.length;
        }
        continue;
      }
      if (diagnostics.length === 0) continue;
      const entry: Entry = { uri, diagnostics, errors: 0, warnings: 0, infos: 0 };
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === "error") entry.errors += 1;
        else if (diagnostic.severity === "warning") entry.warnings += 1;
        else entry.infos += 1;
        byCode.set(diagnostic.code, (byCode.get(diagnostic.code) ?? 0) + 1);
      }
      totals.errors += entry.errors;
      totals.warnings += entry.warnings;
      totals.infos += entry.infos;
      entries.push(entry);
    }
    entries.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || b.infos - a.infos || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

    let kept = 0;
    let truncated = false;
    const files: ReportFile[] = entries.map((entry) => {
      const lines = this.records.get(entry.uri)?.lines;
      const items: ReportItem[] = [];
      for (const diagnostic of entry.diagnostics) {
        if (kept >= MAX_REPORT_ITEMS) {
          truncated = true;
          break;
        }
        const position = lines?.positionAt(diagnostic.range.start) ?? { line: 0, character: 0 };
        items.push({ diagnostic, line: position.line + 1, column: position.character + 1 });
        kept += 1;
      }
      return { uri: entry.uri, errors: entry.errors, warnings: entry.warnings, infos: entry.infos, items };
    });
    const codes = [...byCode].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
    return { examined: this.records.size - excluded.examined, files, totals, byCode: codes, truncated, excluded: only === null ? null : excluded };
  }

  // ---------------------------------------------------------------------------------------------
  // Plan, definition, references
  // ---------------------------------------------------------------------------------------------

  documentSymbols(uri: string): DocumentSymbol[] {
    const record = this.records.get(uri);
    return record === undefined ? [] : buildOutline(record.analysis, record.lines);
  }

  definition(uri: string, position: Position): Location[] {
    const document = this.open.get(uri);
    if (document === undefined) return [];
    const target = this.targetAt(document, position);
    return target === undefined ? [] : this.definitionsOf(uri, document, target);
  }

  references(uri: string, position: Position, includeDeclaration: boolean): Location[] {
    const document = this.open.get(uri);
    if (document === undefined) return [];
    const target = this.targetAt(document, position);
    return target === undefined ? [] : this.referencesOf(uri, document, target, includeDeclaration);
  }

  private targetAt(document: OpenDocument, position: Position): SymbolTarget | undefined {
    const offset = document.lines.offsetAt(position, document.text);
    return resolveTarget(document.analysis, document.parse.ast, offset, this.index);
  }

  private locationOf(uri: string, range: SourceRange): Location | undefined {
    const record = this.records.get(uri);
    return record === undefined ? undefined : { uri, range: toRange(record.lines, range) };
  }

  private definitionsOf(uri: string, document: OpenDocument, target: SymbolTarget): Location[] {
    const locations: Location[] = [];
    const push = (location: Location | undefined): void => {
      if (location !== undefined) locations.push(location);
    };
    switch (target.kind) {
      case "label": {
        const scope = target.declaration.scope;
        if (scope === null) break;
        for (const label of scope.labels) if (label.key === target.key) push(this.locationOf(uri, label.nameRange));
        if (locations.length === 0) {
          for (const declared of scope.functionDeclarations) if (declared.key === target.key) push(this.locationOf(uri, declared.nameRange));
        }
        break;
      }
      case "function":
        for (const entry of this.index.findFunctions(target.name)) push(this.locationOf(entry.uri, entry.nameRange));
        break;
      case "npc":
        for (const entry of this.index.findNpcs(target.name)) push(this.locationOf(entry.uri, entry.nameRange));
        break;
      case "variable": {
        const variables = target.declaration === null ? document.analysis.globalVariables : (target.declaration.scope?.variables ?? []);
        const found = variables.find((variable) => variable.key === target.key);
        if (found !== undefined) push(this.locationOf(uri, found.firstWriteRange ?? found.firstRange));
        break;
      }
    }
    return locations;
  }

  private referencesOf(uri: string, document: OpenDocument, target: SymbolTarget, includeDeclaration: boolean): Location[] {
    const locations: Location[] = [];
    const push = (location: Location | undefined): void => {
      if (location !== undefined) locations.push(location);
    };
    switch (target.kind) {
      case "label": {
        const scope = target.declaration.scope;
        if (scope === null) break;
        if (includeDeclaration) {
          for (const label of scope.labels) if (label.key === target.key) push(this.locationOf(uri, label.nameRange));
          for (const declared of scope.functionDeclarations) if (declared.key === target.key) push(this.locationOf(uri, declared.nameRange));
        }
        for (const reference of scope.labelReferences) if (reference.key === target.key) push(this.locationOf(uri, reference.range));
        break;
      }
      case "function":
        if (includeDeclaration) for (const entry of this.index.findFunctions(target.name)) push(this.locationOf(entry.uri, entry.nameRange));
        for (const entry of this.index.findFunctionReferences(target.name)) push(this.locationOf(entry.uri, entry.range));
        break;
      case "npc":
        if (includeDeclaration) for (const entry of this.index.findNpcs(target.name)) push(this.locationOf(entry.uri, entry.nameRange));
        for (const entry of this.index.findNpcReferences(target.name)) push(this.locationOf(entry.uri, entry.range));
        break;
      case "variable": {
        const root = target.declaration === null ? document.parse.ast : document.parse.ast.declarations[target.declaration.index];
        if (root === undefined) break;
        const ranges: SourceRange[] = [];
        walk(root, (node) => {
          if (node.kind === "Variable" && variableKey(node) === target.key) ranges.push(variableRange(node));
        });
        for (const range of ranges) push(this.locationOf(uri, range));
        break;
      }
    }
    return locations;
  }

  // ---------------------------------------------------------------------------------------------
  // Renommage
  // ---------------------------------------------------------------------------------------------

  /** Le symbole sous le curseur est-il renommable ? (labels, fonctions locales et variables locales d'un script) */
  prepareRename(uri: string, position: Position): RenamePreparation {
    const document = this.open.get(uri);
    if (document === undefined) return { ok: false, reason: "not-renameable" };
    return prepareRename(this.targetAt(document, position), document.lines);
  }

  /** Modifications (dans ce document seulement) qui renomment le symbole sous le curseur, ou la raison du refus. */
  rename(uri: string, position: Position, newName: string): RenameResult {
    const document = this.open.get(uri);
    if (document === undefined) return { ok: false, reason: "not-renameable" };
    return computeRename(this.targetAt(document, position), newName, document.parse.ast, document.lines);
  }

  // ---------------------------------------------------------------------------------------------
  // Completion et survol
  // ---------------------------------------------------------------------------------------------

  /**
   * Propositions au curseur d'un document ouvert : labels et fonctions locales (arguments de `goto`, `callsub`, `menu`),
   * fonctions globales (dans `callfunc "..."`), noms de NPC (dans `duplicate(...)`), variables visibles et — avec un registre
   * de commandes — commandes du serveur, fonctions locales et mots-cles du langage au debut d'une instruction.
   * `explicit` : la completion a ete demandee par l'utilisateur (Ctrl+Espace) ; sans fragment saisi, les commandes ne
   * se proposent que dans ce cas, pour ne pas ouvrir une liste de 700 entrees apres chaque espace ou virgule.
   */
  completion(uri: string, position: Position, options: { readonly explicit?: boolean } = {}): CompletionItem[] {
    const document = this.open.get(uri);
    if (document === undefined) return [];
    const offset = document.lines.offsetAt(position, document.text);
    const context = completionContextAt(document.text, offset);
    if (context === undefined) return [];
    const range = toRange(document.lines, { start: context.start, end: context.end });
    switch (context.kind) {
      case "label":
        return this.labelCompletions(document, offset, range);
      case "function-name":
        return this.functionCompletions(context.partial, range);
      case "npc-name":
        return this.npcCompletions(context.partial, range);
      case "variable":
        return this.variableCompletions(document, offset, context.partial, context.start, range);
      case "command": {
        const explicit = options.explicit === true;
        const commands = this.commandCompletions(document, offset, context, range, explicit);
        if (context.position !== "expression") return commands;
        return [...this.operandReferenceCompletions(context, range, explicit), ...commands];
      }
      case "string-argument": {
        const kind = this.argumentKindOf(context.command, context.argumentIndex, "name");
        return kind === null ? [] : this.referenceItems(kind, context.partial, range, true);
      }
    }
  }

  /** Nature (objet, monstre, carte) de l'argument de rang `index` d'une commande du registre, ou `null`. */
  private argumentKindOf(command: string, index: number, form: "id" | "name"): ArgumentKind | null {
    const definition = this.assistanceCommands?.get(command);
    if (definition === undefined) return null;
    const kind = argumentKindsOf(definition)[index] ?? null;
    return kind === "skill" && !allowsSkillArgument(definition, index, form) ? null : kind;
  }

  /**
   * Propositions du catalogue pour un argument d'objet, de monstre ou de carte. Dans une chaine : le nom (AegisName, nom de
   * carte). Hors d'une chaine : l'identifiant d'un objet ou d'un monstre (le style le plus courant des scripts), le nom de la
   * carte entre guillemets (une carte s'ecrit toujours comme une chaine).
   */
  private referenceItems(kind: ArgumentKind, partial: string, range: Range, inString: boolean): CompletionItem[] {
    const catalog = this.referenceCatalog;
    if (catalog === null) return [];
    const hits = catalog.search(kind, partial, MAX_COMPLETIONS);
    const available = kind === "skill" && inString ? hits.filter((hit) => catalog.skillByName(hit.name) !== undefined) : hits;
    return available.map((hit, rank) => {
      const name = kind === "skill" && inString ? JSON.stringify(hit.name).slice(1, -1) : hit.name;
      const text = kind === "map" ? (inString ? name : `"${name}"`) : inString || hit.id === null ? name : String(hit.id);
      return {
        label: hit.name,
        kind: CompletionItemKind.Value,
        detail: describeHit(hit),
        range,
        sortText: `0${String(rank).padStart(4, "0")}`,
        ...(text === hit.name ? {} : { insertText: text }),
        filterText: [hit.id, hit.name, hit.displayName].filter((part) => part !== null && part !== "").join(" "),
        reference: { kind, id: hit.id },
      };
    });
  }

  /** Constantes et parametres du serveur (`Job_Alchemist`, `BaseLevel`) dont le nom correspond au fragment saisi. */
  private constantItems(partial: string, range: Range): CompletionItem[] {
    if (this.referenceCatalog === null) return [];
    return this.referenceCatalog.search("constant", partial, MAX_CONSTANT_COMPLETIONS).map((hit, rank) => ({
      label: hit.name,
      kind: CompletionItemKind.Constant,
      detail: describeHit(hit),
      range,
      sortText: `1${String(rank).padStart(4, "0")}`,
      reference: { kind: "constant" as const, id: hit.id },
    }));
  }

  /**
   * A une position d'operande : les references de l'argument en cours si la commande dit qu'il designe un objet, un monstre
   * ou une carte, sinon les constantes du serveur. Comme pour les commandes, aucune liste ne s'ouvre d'elle-meme sans
   * fragment saisi (Ctrl+Espace pour la demander).
   */
  private operandReferenceCompletions(context: Extract<CompletionContext, { kind: "command" }>, range: Range, explicit: boolean): CompletionItem[] {
    if (this.referenceCatalog === null) return [];
    if (context.partial === "" && !explicit) return [];
    const kind = context.argument === undefined ? null : this.argumentKindOf(context.argument.command, context.argument.index, "id");
    if (kind !== null) return this.referenceItems(kind, context.partial, range, false);
    // Les constantes commencent par une lettre ; un fragment d'une seule lettre en proposerait des centaines.
    if (/^\d/.test(context.partial) || (context.partial.length < 2 && !explicit)) return [];
    return this.constantItems(context.partial, range);
  }

  /** Le script (NPC ou fonction globale) dont le corps contient le curseur, ou `undefined` hors d'un corps (en-tete, entre scripts). */
  private scopeAt(document: OpenDocument, offset: number): ScriptScope | undefined {
    const scope = document.analysis.declarations.find((declaration) => contains(declaration.range, offset))?.scope;
    if (scope === undefined || scope === null) return undefined;
    return offset > scope.bodyRange.start && offset <= scope.bodyRange.end ? scope : undefined;
  }

  private commandCompletions(
    document: OpenDocument,
    offset: number,
    context: Extract<CompletionContext, { kind: "command" }>,
    range: Range,
    explicit: boolean,
  ): CompletionItem[] {
    const scope = this.scopeAt(document, offset);
    if (scope === undefined) return this.templateCompletions(document, offset, context, range, explicit);
    if (context.partial === "" && !explicit) return [];

    const found: { score: number; item: CompletionItem }[] = [];
    const seen = new Set<string>();
    const add = (name: string, build: (score: number) => CompletionItem): void => {
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      const score = matchScore(context.partial, name);
      if (score === null) return;
      seen.add(key);
      found.push({ score, item: build(score) });
    };

    // Fonctions locales du script : elles s'appellent par leur nom, comme une commande.
    for (const label of scope.labels) {
      if (label.kind === "function") add(label.name, () => ({ label: label.name, kind: CompletionItemKind.Function, detail: "function", range, sortText: `0${label.key}` }));
    }
    for (const declared of scope.functionDeclarations) {
      add(declared.name, () => ({ label: declared.name, kind: CompletionItemKind.Function, detail: "function", range, sortText: `0${declared.key}` }));
    }
    if (context.position === "statement") {
      for (const keyword of LANGUAGE_KEYWORDS) add(keyword, () => ({ label: keyword, kind: CompletionItemKind.Keyword, range, sortText: `2${keyword}` }));
    }
    if (this.assistanceCommands !== null) {
      for (const definition of this.assistanceCommands.definitions()) {
        add(definition.name, (score) => ({
          label: definition.name,
          kind: CompletionItemKind.Function,
          detail: signatureViewsOf(definition)[0]?.label,
          range,
          // Monaco reclasse selon sortText; conserver le score de pertinence et la priorite des commandes du projet.
          sortText: `${definition.sources[0]?.kind === "project" ? "0" : "1"}${String(1000 - score).padStart(4, "0")}${String(definition.name.length).padStart(4, "0")}${definition.name.toLowerCase()}`,
          command: { source: definition.sources[0]?.kind ?? "server-doc", deprecated: definition.deprecated },
        }));
      }
    }
    found.sort((a, b) => b.score - a.score || a.item.label.length - b.item.label.length || a.item.label.localeCompare(b.item.label));
    return found.slice(0, MAX_COMMAND_COMPLETIONS).map((entry) => entry.item);
  }

  /**
   * Modeles de NPC (script, warp, boutique, soigneur) : proposes seulement hors de tout script, au debut d'une ligne, pour les
   * emulateurs sur lesquels ils sont verifies. Sans fragment saisi, seulement sur demande explicite.
   */
  private templateCompletions(
    document: OpenDocument,
    offset: number,
    context: Extract<CompletionContext, { kind: "command" }>,
    range: Range,
    explicit: boolean,
  ): CompletionItem[] {
    if (context.position !== "statement") return [];
    if (context.partial === "" && !explicit) return [];
    if (document.analysis.declarations.some((declaration) => contains(declaration.range, offset))) return [];
    const lineStart = document.text.lastIndexOf("\n", context.start - 1) + 1;
    if (!/^[ \t]*$/.test(document.text.slice(lineStart, context.start))) return [];
    const found: { score: number; item: CompletionItem }[] = [];
    for (const template of templatesFor(this.options.emulator)) {
      const score = matchScore(context.partial, template.id);
      if (score === null) continue;
      found.push({
        score,
        item: {
          label: template.id,
          kind: CompletionItemKind.Snippet,
          detail: template.description,
          range,
          sortText: `3${template.id}`,
          insertText: template.snippet,
          format: "snippet",
          template: template.id,
        },
      });
    }
    found.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
    return found.map((entry) => entry.item);
  }

  /**
   * Aide de signature : la commande dont le curseur est dans les arguments (ecrite avec ou sans parentheses, sur une ou
   * plusieurs lignes) et le rang de l'argument en cours. `undefined` hors d'un appel, dans un commentaire, sur le nom lui-meme,
   * ou pour un nom que le registre ne connait pas.
   */
  signatureHelp(uri: string, position: Position): SignatureHelp | undefined {
    const document = this.open.get(uri);
    if (this.assistanceCommands === null || document === undefined) return undefined;
    const offset = document.lines.offsetAt(position, document.text);
    if (this.scopeAt(document, offset) === undefined) return undefined;
    const windowStart = windowStartOf(document.text, offset, SIGNATURE_LINES);
    const scan = scanCalls(document.text.slice(windowStart, offset));
    if (scan.inComment || scan.call === null) return undefined;
    if (windowStart + scan.call.nameEnd === offset) return undefined;
    const definition = this.assistanceCommands.get(scan.call.name);
    return definition === undefined ? undefined : signatureHelpOf(definition, scan.call.argIndex);
  }

  /** Ce que le registre sait d'une commande (completion detaillee, survol), ou `undefined` si elle est inconnue. */
  commandInfo(name: string): CommandInfo | undefined {
    const definition = this.assistanceCommands?.get(name);
    return definition === undefined ? undefined : commandInfoOf(definition);
  }

  private labelCompletions(document: OpenDocument, offset: number, range: Range): CompletionItem[] {
    const scope = document.analysis.declarations.find((declaration) => contains(declaration.range, offset))?.scope;
    if (scope === undefined || scope === null) return [];
    const seen = new Set<string>();
    const items: CompletionItem[] = [];
    const add = (key: string, label: string, kind: CompletionItem["kind"], detail: string): void => {
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ label, kind, detail, range, sortText: `0${label.toLowerCase()}` });
    };
    for (const label of scope.labels) {
      if (label.kind === "function") add(label.key, label.name, CompletionItemKind.Function, "function");
      else add(label.key, label.name, label.isEvent ? CompletionItemKind.Event : CompletionItemKind.Field, "label");
    }
    for (const declared of scope.functionDeclarations) add(declared.key, declared.name, CompletionItemKind.Function, "function");
    return items;
  }

  private functionCompletions(partial: string, range: Range): CompletionItem[] {
    const scored: { score: number; name: string; uri: string }[] = [];
    const seen = new Set<string>();
    this.index.forEachFunction((entry) => {
      if (seen.has(entry.name)) return;
      const score = matchScore(partial, entry.name);
      if (score === null) return;
      seen.add(entry.name);
      scored.push({ score, name: entry.name, uri: entry.uri });
    });
    scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
    return scored.slice(0, MAX_COMPLETIONS).map((entry) => ({
      label: entry.name,
      kind: CompletionItemKind.Function,
      detail: entry.uri,
      range,
      sortText: `1${entry.name.toLowerCase()}`,
    }));
  }

  private npcCompletions(partial: string, range: Range): CompletionItem[] {
    const scored: { score: number; name: string; detail: string }[] = [];
    const seen = new Set<string>();
    this.index.forEachNpc((entry) => {
      if (seen.has(entry.uniqueName)) return;
      const score = matchScore(partial, entry.uniqueName);
      if (score === null) return;
      seen.add(entry.uniqueName);
      scored.push({ score, name: entry.uniqueName, detail: entry.map === null ? entry.npcType : `${entry.npcType} ${entry.map}` });
    });
    scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
    return scored.slice(0, MAX_COMPLETIONS).map((entry) => ({
      label: entry.name,
      kind: CompletionItemKind.Class,
      detail: entry.detail,
      range,
      sortText: `1${entry.name.toLowerCase()}`,
    }));
  }

  private variableCompletions(document: OpenDocument, offset: number, partial: string, partialStart: number, range: Range): CompletionItem[] {
    const scope = document.analysis.declarations.find((declaration) => contains(declaration.range, offset))?.scope;
    const candidates: readonly VariableSummary[] = [...(scope?.variables ?? []), ...document.analysis.globalVariables];
    const wanted = partial.toLowerCase();
    const seen = new Set<string>();
    const items: CompletionItem[] = [];
    for (const variable of candidates) {
      const shown = variable.prefix + variable.name + (variable.isString ? "$" : "");
      if (seen.has(variable.key) || !shown.toLowerCase().startsWith(wanted)) continue;
      // La variable en cours de saisie ne doit pas se proposer elle-meme.
      if (variable.occurrences === 1 && variable.firstRange.start === partialStart) continue;
      seen.add(variable.key);
      items.push({ label: shown, kind: CompletionItemKind.Variable, detail: `${variable.prefix} ${variable.scope}`, range, sortText: `0${shown.toLowerCase()}` });
    }
    return items;
  }

  private lineOf(uri: string, offset: number): number | null {
    const record = this.records.get(uri);
    return record === undefined ? null : record.lines.positionAt(offset).line + 1;
  }

  /** Survol d'une commande ou d'une fonction native du registre (le nom seul, pas ses arguments). */
  private commandHover(document: OpenDocument, offset: number): HoverInfo | undefined {
    if (this.assistanceCommands === null || this.scopeAt(document, offset) === undefined) return undefined;
    const node = findNodeAt(document.parse.ast, offset);
    let name: string;
    let range: SourceRange;
    switch (node.kind) {
      case "CommandStatement":
        name = node.name;
        range = node.nameRange;
        break;
      case "Call":
        name = node.callee;
        range = node.calleeRange;
        break;
      case "GotoStatement":
      case "ReturnStatement": {
        // `goto` et `return` sont des noeuds a part dans l'AST mais des commandes du registre.
        name = node.kind === "GotoStatement" ? "goto" : "return";
        range = { start: node.range.start, end: node.range.start + name.length };
        if (document.text.slice(range.start, range.end).toLowerCase() !== name) return undefined;
        break;
      }
      default:
        return undefined;
    }
    if (!contains(range, offset)) return undefined;
    const definition = this.assistanceCommands.get(name);
    if (definition === undefined) return undefined;
    return { kind: "command", range: toRange(document.lines, range), name: definition.name, info: commandInfoOf(definition) };
  }

  /** Le nombre ou la chaine sous le curseur, quand c'est un argument de commande ; la commande et le rang de l'argument. */
  private argumentAt(document: OpenDocument, offset: number): { command: string; index: number; literal: Expression } | undefined {
    const matches: { command: string; index: number; literal: Expression }[] = [];
    walk(document.parse.ast, (node) => {
      if ((node.kind !== "CommandStatement" && node.kind !== "Call") || !contains(node.range, offset)) return;
      const command = node.kind === "CommandStatement" ? node.name : node.callee;
      node.args.forEach((argument, index) => {
        const literal = unwrapExpression(argument);
        if (literal !== undefined && (literal.kind === "NumberLiteral" || literal.kind === "StringLiteral") && contains(literal.range, offset)) {
          matches.push({ command, index, literal });
        }
      });
    });
    // Les appels imbriques sont visites apres l'appel qui les contient : le dernier est le plus interieur.
    return matches[matches.length - 1];
  }

  /** Survol d'une reference litterale a la place d'un argument de ce type. */
  private referenceHover(document: OpenDocument, offset: number): HoverInfo | undefined {
    const catalog = this.referenceCatalog;
    if (catalog === null || this.assistanceCommands === null || this.scopeAt(document, offset) === undefined) return undefined;
    const at = this.argumentAt(document, offset);
    if (at === undefined) return undefined;
    const kind = this.argumentKindOf(at.command, at.index, at.literal.kind === "StringLiteral" ? "name" : "id");
    if (kind === null) return undefined;
    const literal = at.literal;
    let written: string;
    let record: ItemRecord | MobRecord | MapRecord | SkillRecord | undefined;
    if (literal.kind === "NumberLiteral") {
      if (kind === "map" || !Number.isInteger(literal.value) || literal.value <= 0) return undefined;
      written = String(literal.value);
      record = kind === "item" ? catalog.itemById(literal.value) : kind === "mob" ? catalog.mobById(literal.value) : catalog.skillById(literal.value);
    } else if (literal.kind === "StringLiteral" && !literal.unterminated && literal.value !== "") {
      written = literal.value;
      if (kind === "map") {
        if (!isCheckableMapName(written)) return undefined;
        record = catalog.mapByName(written);
      } else {
        record = kind === "item" ? catalog.itemByName(written) : kind === "mob" ? catalog.mobByName(written) : catalog.skillByName(written);
      }
    } else {
      return undefined;
    }
    if (kind === "skill" && record === undefined) return undefined;
    return { kind: "reference", range: toRange(document.lines, literal.range), referenceKind: kind, written, record: record ?? null };
  }

  /** Survol d'une constante ou d'un parametre exporte par le serveur (mot nu qui n'est pas un symbole du projet). */
  private constantHover(document: OpenDocument, offset: number): HoverInfo | undefined {
    if (this.referenceCatalog === null) return undefined;
    const node = findNodeAt(document.parse.ast, offset);
    if (node.kind !== "Identifier" || !contains(node.range, offset)) return undefined;
    const constant = this.referenceCatalog.constantByName(node.name);
    return constant === undefined ? undefined : { kind: "constant", range: toRange(document.lines, node.range), constant };
  }

  /** Informations sur le symbole sous le curseur (sans texte redige : l'interface les met en forme). */
  hover(uri: string, position: Position): HoverInfo | undefined {
    const document = this.open.get(uri);
    if (document === undefined) return undefined;
    const offset = document.lines.offsetAt(position, document.text);
    const command = this.commandHover(document, offset);
    if (command !== undefined) return command;
    const reference = this.referenceHover(document, offset);
    if (reference !== undefined) return reference;
    const target = this.targetAt(document, position);
    if (target === undefined) return this.constantHover(document, offset);
    const range = toRange(document.lines, target.range);
    switch (target.kind) {
      case "label": {
        const scope = target.declaration.scope;
        const first = scope?.labels.find((label) => label.key === target.key);
        const declared = scope?.functionDeclarations.some((entry) => entry.key === target.key) ?? false;
        return {
          kind: "label",
          range,
          name: first?.name ?? target.name,
          isFunction: first?.kind === "function" || (first === undefined && declared),
          isEvent: first?.isEvent ?? false,
          defined: first !== undefined,
          line: first === undefined ? null : this.lineOf(uri, first.nameRange.start),
          references: scope?.labelReferences.filter((reference) => reference.key === target.key).length ?? 0,
        };
      }
      case "function":
        return {
          kind: "function",
          range,
          name: target.name,
          definitions: this.index
            .findFunctions(target.name)
            .slice(0, 5)
            .map((entry) => ({ uri: entry.uri, line: this.lineOf(entry.uri, entry.nameRange.start) ?? 1 })),
          references: this.index.findFunctionReferences(target.name).length,
        };
      case "npc":
        return {
          kind: "npc",
          range,
          name: target.name,
          definitions: this.index
            .findNpcs(target.name)
            .slice(0, 5)
            .map((entry) => ({
              uri: entry.uri,
              line: this.lineOf(entry.uri, entry.nameRange.start) ?? 1,
              npcType: entry.npcType,
              displayName: entry.displayName,
              map: entry.map,
            })),
          references: this.index.findNpcReferences(target.name).length,
        };
      case "variable": {
        const variables = target.declaration === null ? document.analysis.globalVariables : (target.declaration.scope?.variables ?? []);
        const found = variables.find((variable) => variable.key === target.key);
        return {
          kind: "variable",
          range,
          name: found === undefined ? target.name : found.prefix + found.name + (found.isString ? "$" : ""),
          scope: found?.scope ?? "",
          isString: found?.isString ?? false,
          isArray: found?.isArray ?? false,
          occurrences: found?.occurrences ?? 0,
          firstWriteLine: found?.firstWriteRange == null ? null : this.lineOf(uri, found.firstWriteRange.start),
        };
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Recherche de symboles du projet
  // ---------------------------------------------------------------------------------------------

  /** Fonctions globales et NPC dont le nom correspond a `query` (insensible a la casse, tolerant), meilleurs d'abord. */
  workspaceSymbols(query: string, limit = 100): WorkspaceSymbol[] {
    interface Candidate {
      readonly score: number;
      readonly name: string;
      readonly detail: string;
      readonly kind: SymbolKind;
      readonly uri: string;
      readonly range: SourceRange;
    }
    const candidates: Candidate[] = [];
    this.index.forEachFunction((entry) => {
      const score = matchScore(query, entry.name);
      if (score !== null) {
        candidates.push({ score, name: entry.name, detail: "function", kind: SymbolKind.Function, uri: entry.uri, range: entry.nameRange });
      }
    });
    this.index.forEachNpc((entry) => {
      const byUnique = matchScore(query, entry.uniqueName);
      const byDisplay = entry.displayName === entry.uniqueName ? null : matchScore(query, entry.displayName);
      const score = byUnique === null ? byDisplay : byDisplay === null ? byUnique : Math.max(byUnique, byDisplay);
      if (score === null) return;
      const place = entry.map === null ? "" : ` ${entry.map}`;
      candidates.push({
        score,
        name: entry.uniqueName,
        detail: `${entry.npcType}${place}`,
        kind: entry.npcType === "warp" ? SymbolKind.Namespace : entry.npcType === "script" || entry.npcType === "duplicate" ? SymbolKind.Class : SymbolKind.Struct,
        uri: entry.uri,
        range: entry.nameRange,
      });
    });
    candidates.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri));
    const symbols: WorkspaceSymbol[] = [];
    for (const candidate of candidates) {
      if (symbols.length >= limit) break;
      const location = this.locationOf(candidate.uri, candidate.range);
      if (location === undefined) continue;
      symbols.push({ name: candidate.name, detail: candidate.detail, kind: candidate.kind, location });
    }
    return symbols;
  }
}
