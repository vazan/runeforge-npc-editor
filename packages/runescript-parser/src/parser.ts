import {
  createDiagnostic,
  tokenize,
  type DiagnosticCode,
  type DiagnosticOverrides,
  type DiagnosticParams,
  type ParseDiagnostic,
  type SourceRange,
  type Token,
} from "@runeforge/runescript-core";
import type {
  BlockStatement,
  CaseStatement,
  CommandStatement,
  DefaultStatement,
  DuplicateDeclaration,
  EmptyStatement,
  Expression,
  ExpressionStatement,
  FunctionDeclaration,
  FunctionStatement,
  HeaderField,
  LabelStatement,
  MapflagDeclaration,
  MapLocation,
  MonsterDeclaration,
  NpcDeclaration,
  NumericValue,
  ParseResult,
  RawDeclaration,
  RawStatement,
  ScriptFile,
  ShopDeclaration,
  ShopItem,
  ShopType,
  Statement,
  StringLiteral,
  TopLevelDeclaration,
  VariableExpression,
  VariablePrefix,
  VariableScope,
  WarpDeclaration,
} from "./ast";
import {
  buildFields,
  DECLARATION_KEYWORDS,
  parseMapLocation,
  parseNpcName,
  parseNumeric,
  parseTypeKeyword,
  SHOP_KEYWORDS,
  splitField,
} from "./header";

export interface ParseOptions {
  /** Profondeur maximale d'imbrication (blocs, parentheses). Defaut : 200. */
  readonly maxDepth?: number;
  /** Nombre maximal de diagnostics conserves. Defaut : 1000. */
  readonly maxDiagnostics?: number;
}

const DEFAULT_MAX_DEPTH = 200;
const DEFAULT_MAX_DIAGNOSTICS = 1000;

/** Priorites des operateurs binaires (convention C ; voir docs/LANGUAGE_SPEC.md). */
const BINARY_PRECEDENCE: ReadonlyMap<string, number> = new Map([
  ["||", 3], ["&&", 4], ["|", 5], ["^", 6], ["&", 7],
  ["==", 8], ["!=", 8],
  ["<", 9], ["<=", 9], [">", 9], [">=", 9],
  ["<<", 10], [">>", 10],
  ["+", 11], ["-", 11],
  ["*", 12], ["/", 12], ["%", 12],
]);

const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "~=", "<<=", ">>=",
]);

/** Mots-cles de structure de controle (insensibles a la casse comme les identifiants du serveur). */
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "else", "while", "for", "do", "switch", "case", "default",
  "break", "continue", "return", "goto", "function",
]);

const VARIABLE_PREFIXES: ReadonlyArray<readonly [VariablePrefix, VariableScope]> = [
  [".@", "script"],
  ["$@", "global-temporary"],
  ["##", "account-global"],
  [".", "npc"],
  ["@", "character-temporary"],
  ["$", "global-permanent"],
  ["#", "account-local"],
  ["'", "instance"],
];

export function parse(text: string, options: ParseOptions = {}): ParseResult {
  const tokens = tokenize(text);
  const parser = new ScriptParser(text, tokens, options);
  return parser.run();
}

class ScriptParser {
  private readonly sig: number[] = [];
  private readonly atLineStart: boolean[] = [];
  private readonly codeBefore: boolean[] = [];
  private readonly rawToSig: number[];
  private readonly diagnostics: ParseDiagnostic[] = [];
  private readonly maxDepth: number;
  private readonly maxDiagnostics: number;
  private pos = 0;
  private depth = 0;
  private switchDepth = 0;
  private truncated = false;

  constructor(
    private readonly text: string,
    private readonly tokens: readonly Token[],
    options: ParseOptions,
  ) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxDiagnostics = options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS;

    let lineStart = true;
    let codeOnLine = false;
    const sigIndexOfRaw = new Map<number, number>();
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === undefined) continue;
      if (token.kind === "Newline") {
        lineStart = true;
        codeOnLine = false;
        continue;
      }
      if (token.kind === "Spaces" || token.kind === "Tabs" || token.kind === "LineComment" || token.kind === "BlockComment") {
        lineStart = false;
        continue;
      }
      sigIndexOfRaw.set(i, this.sig.length);
      this.sig.push(i);
      this.atLineStart.push(lineStart);
      this.codeBefore.push(codeOnLine);
      lineStart = false;
      codeOnLine = true;
    }
    this.rawToSig = new Array<number>(tokens.length + 1);
    let next = this.sig.length;
    this.rawToSig[tokens.length] = next;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      const sigIndex = sigIndexOfRaw.get(i);
      if (sigIndex !== undefined) next = sigIndex;
      this.rawToSig[i] = next;
    }
  }

  run(): ParseResult {
    this.reportLexicalProblems();
    const ast = this.parseFile();
    return { ast, tokens: this.tokens, diagnostics: this.diagnostics, truncated: this.truncated };
  }

  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------

  private report(
    code: DiagnosticCode,
    range: SourceRange,
    params?: DiagnosticParams,
    overrides?: DiagnosticOverrides,
  ): void {
    if (this.diagnostics.length >= this.maxDiagnostics) return;
    this.diagnostics.push(createDiagnostic(code, range, params, overrides));
  }

  private reportLexicalProblems(): void {
    for (const token of this.tokens) {
      if (token.unterminated !== true) continue;
      this.report(token.kind === "BlockComment" ? "RS0002" : "RS0001", token.range);
    }
  }

  private peek(offset = 0): Token | undefined {
    const raw = this.sig[this.pos + offset];
    return raw === undefined ? undefined : this.tokens[raw];
  }

  private advance(): Token | undefined {
    const token = this.peek();
    if (token !== undefined) this.pos += 1;
    return token;
  }

  private previous(): Token | undefined {
    const raw = this.sig[this.pos - 1];
    return raw === undefined ? undefined : this.tokens[raw];
  }

  private isPunct(token: Token | undefined, char: string): boolean {
    return token !== undefined && token.kind === "Punctuation" && token.text === char;
  }

  private isKeyword(token: Token | undefined, keyword: string): boolean {
    return token !== undefined && token.kind === "Identifier" && token.text.toLowerCase() === keyword;
  }

  private emptyRangeAtEnd(): SourceRange {
    const previous = this.previous();
    const at = previous === undefined ? 0 : previous.range.end;
    return { start: at, end: at };
  }

  private rangeFromPrevious(): SourceRange {
    const previous = this.previous();
    return previous === undefined ? { start: 0, end: 0 } : previous.range;
  }

  /** Tokens `Tabs` presents sur la ligne qui commence au token significatif `sigPos`. */
  private isTopLevelStartAt(sigPos: number): boolean {
    if (this.atLineStart[sigPos] !== true) return false;
    const raw = this.sig[sigPos];
    if (raw === undefined) return false;
    let i = raw;
    while (i < this.tokens.length) {
      const kind = this.tokens[i]?.kind;
      if (kind === "Tabs" || kind === "Newline") break;
      i += 1;
    }
    if (this.tokens[i]?.kind !== "Tabs") return false;
    while (this.tokens[i]?.kind === "Tabs" || this.tokens[i]?.kind === "Spaces") i += 1;
    const second = this.tokens[i];
    if (second === undefined || second.kind !== "Identifier") return false;
    return DECLARATION_KEYWORDS.has(second.text.toLowerCase());
  }

  private enter(): boolean {
    if (this.depth >= this.maxDepth) {
      if (!this.truncated) {
        this.truncated = true;
        const token = this.peek();
        this.report("RS0050", token === undefined ? this.emptyRangeAtEnd() : token.range);
      }
      return false;
    }
    this.depth += 1;
    return true;
  }

  private leave(): void {
    this.depth -= 1;
  }

  /** Saute jusqu'a la prochaine declaration de premier niveau (ou la fin du fichier). */
  private skipToNextDeclaration(): SourceRange {
    const start = this.peek()?.range.start ?? this.text.length;
    let end = start;
    while (this.pos < this.sig.length) {
      if (this.pos > 0 && this.isTopLevelStartAt(this.pos)) break;
      const token = this.advance();
      if (token !== undefined) end = token.range.end;
    }
    return { start, end };
  }

  // -------------------------------------------------------------------------
  // Fichier et declarations
  // -------------------------------------------------------------------------

  private parseFile(): ScriptFile {
    const declarations: TopLevelDeclaration[] = [];
    while (this.pos < this.sig.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (this.codeBefore[this.pos] === true) {
        this.skipRestOfLine("RS0035");
        continue;
      }
      if (this.isPunct(token, "}")) {
        this.report("RS0010", token.range, { token: "}" });
        this.advance();
        continue;
      }
      this.depth = 0;
      this.switchDepth = 0;
      declarations.push(this.parseDeclaration());
    }
    return { kind: "ScriptFile", range: { start: 0, end: this.text.length }, declarations };
  }

  private skipRestOfLine(code: DiagnosticCode): void {
    const first = this.peek();
    if (first === undefined) return;
    let end = first.range.end;
    this.advance();
    while (this.pos < this.sig.length && this.codeBefore[this.pos] === true) {
      end = this.peek()?.range.end ?? end;
      this.advance();
    }
    this.report(code, { start: first.range.start, end });
  }

  private parseDeclaration(): TopLevelDeclaration {
    const startSig = this.pos;
    const startRaw = this.sig[startSig] ?? 0;
    const startOffset = this.tokens[startRaw]?.range.start ?? 0;
    const tokens = this.tokens;

    let lineEndRaw = startRaw;
    while (lineEndRaw < tokens.length) {
      const kind = tokens[lineEndRaw]?.kind;
      if (kind === "Newline" || kind === "LineComment") break;
      lineEndRaw += 1;
    }

    let fields = buildFields(this.text, tokens, startRaw, lineEndRaw);
    const typeKeyword = parseTypeKeyword(fields[1]);
    const isFunction = fields[0]?.text.toLowerCase() === "function" && typeKeyword?.keyword === "script";
    const isScript = !isFunction && typeKeyword?.keyword === "script";

    let braceRaw = -1;
    if (isScript || isFunction) {
      for (let i = startRaw; i < lineEndRaw; i += 1) {
        const token = tokens[i];
        if (token !== undefined && token.kind === "Punctuation" && token.text === "{") {
          braceRaw = i;
          break;
        }
      }
      if (braceRaw !== -1) fields = buildFields(this.text, tokens, startRaw, braceRaw);
    }
    const lastField = fields[fields.length - 1];
    const lineLastToken = this.lastSignificantRawBefore(lineEndRaw, startRaw);
    const lineEndOffset = lineLastToken === undefined ? startOffset : (tokens[lineLastToken]?.range.end ?? startOffset);
    const headerRange: SourceRange = {
      start: startOffset,
      end: lastField === undefined ? lineEndOffset : lastField.range.end,
    };

    // En-tete a champs insuffisants : espaces a la place de tabulations, ou texte libre.
    if (fields.length < 2 || typeKeyword === null) {
      return this.rawDeclaration(startOffset, lineEndOffset, fields, lineEndRaw, headerRange);
    }
    if (!DECLARATION_KEYWORDS.has(typeKeyword.keyword) && !isFunction) {
      this.report("RS0031", fields[1]?.range ?? headerRange, { type: fields[1]?.text ?? "" });
      return this.rawDeclaration(startOffset, lineEndOffset, fields, lineEndRaw, headerRange, false);
    }

    const keyword = typeKeyword.keyword;
    const states = typeKeyword.argument === "" ? [] : typeKeyword.argument.split(",").map((part) => part.trim());

    if (isFunction) {
      const nameField = fields[2];
      if (nameField === undefined) this.report("RS0030", headerRange, { expected: 3, count: fields.length });
      const declaration = this.finishScriptDeclaration(startOffset, headerRange, braceRaw, lineEndRaw);
      const node: FunctionDeclaration = {
        kind: "FunctionDeclaration",
        range: declaration.range,
        headerRange,
        fields,
        name: nameField?.text ?? "",
        nameRange: nameField?.range ?? { start: headerRange.end, end: headerRange.end },
        body: declaration.body,
      };
      return node;
    }

    switch (keyword) {
      case "script":
        return this.decodeNpc(startOffset, headerRange, fields, states, braceRaw, lineEndRaw);
      case "duplicate":
        this.moveAfterRaw(lineEndRaw);
        return this.decodeDuplicate(startOffset, headerRange, fields, lineEndOffset, typeKeyword);
      case "warp":
      case "warp2":
        this.moveAfterRaw(lineEndRaw);
        return this.decodeWarp(startOffset, headerRange, fields, lineEndOffset, keyword, states);
      case "monster":
      case "boss_monster":
        this.moveAfterRaw(lineEndRaw);
        return this.decodeMonster(startOffset, headerRange, fields, lineEndOffset, keyword === "boss_monster");
      case "mapflag":
        this.moveAfterRaw(lineEndRaw);
        return this.decodeMapflag(startOffset, headerRange, fields, lineEndOffset);
      default:
        if (SHOP_KEYWORDS.has(keyword)) {
          this.moveAfterRaw(lineEndRaw);
          return this.decodeShop(startOffset, headerRange, fields, lineEndOffset, keyword as ShopType);
        }
        this.moveAfterRaw(lineEndRaw);
        return this.rawDeclaration(startOffset, lineEndOffset, fields, lineEndRaw, headerRange, false);
    }
  }

  private lastSignificantRawBefore(endRaw: number, startRaw: number): number | undefined {
    for (let i = endRaw - 1; i >= startRaw; i -= 1) {
      const kind = this.tokens[i]?.kind;
      if (kind !== undefined && kind !== "Spaces" && kind !== "Tabs" && kind !== "Newline" && kind !== "LineComment" && kind !== "BlockComment") {
        return i;
      }
    }
    return undefined;
  }

  /** Place le curseur sur le premier token significatif situe apres l'index brut donne. */
  private moveAfterRaw(raw: number): void {
    const target = this.rawToSig[raw] ?? this.sig.length;
    if (target > this.pos) this.pos = target;
  }

  private rawDeclaration(
    start: number,
    end: number,
    fields: readonly HeaderField[],
    lineEndRaw: number,
    headerRange: SourceRange,
    diagnose = true,
  ): RawDeclaration {
    if (diagnose) {
      const hasSpaces = this.lineHasDeclarationKeywordWithoutTabs(start, end);
      if (hasSpaces) {
        this.report("RS0032", headerRange);
      } else {
        this.report("RS0030", headerRange, { expected: 3, count: fields.length });
      }
    }
    this.moveAfterRaw(lineEndRaw);
    // Un bloc `{` ouvert sur la ligne rejetee est saute pour ne pas generer d'erreurs en cascade.
    return { kind: "RawDeclaration", range: { start, end }, originalText: this.text.slice(start, end), fields };
  }

  private lineHasDeclarationKeywordWithoutTabs(start: number, end: number): boolean {
    const words = this.text.slice(start, end).split(/[ \t]+/);
    let index = 0;
    for (const word of words) {
      const keyword = word.toLowerCase().replace(/\(.*$/, "");
      if (index > 0 && DECLARATION_KEYWORDS.has(keyword)) return true;
      index += 1;
    }
    return false;
  }

  /** Parse le bloc de code d'un `script`/`function` et retourne la plage totale de la declaration. */
  private finishScriptDeclaration(
    startOffset: number,
    headerRange: SourceRange,
    braceRaw: number,
    lineEndRaw: number,
  ): { range: SourceRange; body: BlockStatement | null } {
    if (braceRaw === -1) {
      this.report("RS0033", headerRange);
      this.moveAfterRaw(lineEndRaw);
      return { range: { start: startOffset, end: headerRange.end }, body: null };
    }
    this.pos = this.rawToSig[braceRaw] ?? this.sig.length;
    const body = this.parseBlock();
    return { range: { start: startOffset, end: body.range.end }, body };
  }

  private decodeNpc(
    startOffset: number,
    headerRange: SourceRange,
    fields: readonly HeaderField[],
    states: readonly string[],
    braceRaw: number,
    lineEndRaw: number,
  ): NpcDeclaration {
    if (fields.length < 4) this.report("RS0030", headerRange, { expected: 4, count: fields.length });
    const locationField = fields[0];
    const floating = locationField?.text === "-";
    const location = locationField === undefined || floating ? null : this.checkedLocation(locationField, 4);
    const name = parseNpcName(fields[2], headerRange.end);
    const spriteSegments = fields[3] === undefined ? [] : splitField(fields[3], ",");
    while (spriteSegments.length > 0 && spriteSegments[spriteSegments.length - 1]?.text === "") spriteSegments.pop();
    const sprite = spriteSegments[0] ?? null;
    const triggerX = spriteSegments[1];
    const triggerY = spriteSegments[2];
    let trigger: NpcDeclaration["trigger"] = null;
    if (triggerX !== undefined && triggerY !== undefined) {
      const x = this.checkedNumber(triggerX, "trigger coordinate");
      const y = this.checkedNumber(triggerY, "trigger coordinate");
      trigger = { x, y };
    }
    const declaration = this.finishScriptDeclaration(startOffset, headerRange, braceRaw, lineEndRaw);
    return {
      kind: "NpcDeclaration",
      range: declaration.range,
      headerRange,
      fields,
      floating,
      location,
      states,
      name,
      sprite,
      trigger,
      body: declaration.body,
    };
  }

  private decodeDuplicate(
    startOffset: number,
    headerRange: SourceRange,
    fields: readonly HeaderField[],
    endOffset: number,
    typeKeyword: NonNullable<ReturnType<typeof parseTypeKeyword>>,
  ): DuplicateDeclaration {
    if (fields.length < 3) this.report("RS0030", headerRange, { expected: 3, count: fields.length });
    const locationField = fields[0];
    const floating = locationField?.text === "-";
    return {
      kind: "DuplicateDeclaration",
      range: { start: startOffset, end: endOffset },
      headerRange,
      fields,
      target: typeKeyword.argument,
      targetRange: typeKeyword.argumentRange ?? { start: headerRange.end, end: headerRange.end },
      floating,
      location: locationField === undefined || floating ? null : this.checkedLocation(locationField, 4),
      name: parseNpcName(fields[2], headerRange.end),
      parameters: fields[3] === undefined ? [] : splitField(fields[3], ","),
    };
  }

  private decodeWarp(
    startOffset: number,
    headerRange: SourceRange,
    fields: readonly HeaderField[],
    endOffset: number,
    variant: string,
    states: readonly string[],
  ): WarpDeclaration {
    if (fields.length < 4) this.report("RS0030", headerRange, { expected: 4, count: fields.length });
    const locationField = fields[0];
    const parts = fields[3] === undefined ? [] : splitField(fields[3], ",");
    const [spanX, spanY, toMap, toX, toY] = parts;
    let destination: MapLocation | null = null;
    if (toMap !== undefined) {
      const lastPart = toY ?? toX ?? toMap;
      destination = {
        map: toMap.text,
        mapRange: toMap.range,
        x: toX === undefined ? null : this.checkedNumber(toX, "destination coordinate"),
        y: toY === undefined ? null : this.checkedNumber(toY, "destination coordinate"),
        extra: [],
        range: { start: toMap.range.start, end: lastPart.range.end },
      };
    }
    if (parts.length !== 5 && fields[3] !== undefined) {
      this.report("RS0036", fields[3].range, { expected: "spanX,spanY,map,x,y", count: parts.length });
    }
    return {
      kind: "WarpDeclaration",
      range: { start: startOffset, end: endOffset },
      headerRange,
      fields,
      variant: variant === "warp2" ? "warp2" : "warp",
      states,
      // Le serveur ne lit que `carte,x,y` d'un warp (`npc_parse_warp` : `sscanf(...) != 3`) ; la direction documentee est facultative.
      location: locationField === undefined ? null : this.checkedLocation(locationField, 3),
      name: parseNpcName(fields[2], headerRange.end),
      spanX: spanX === undefined ? null : this.checkedNumber(spanX, "warp span"),
      spanY: spanY === undefined ? null : this.checkedNumber(spanY, "warp span"),
      destination,
    };
  }

  private decodeShop(
    startOffset: number,
    headerRange: SourceRange,
    fields: readonly HeaderField[],
    endOffset: number,
    shopType: ShopType,
  ): ShopDeclaration {
    if (fields.length < 4) this.report("RS0030", headerRange, { expected: 4, count: fields.length });
    const locationField = fields[0];
    const floating = locationField?.text === "-";
    const parts = fields[3] === undefined ? [] : splitField(fields[3], ",");
    const sprite = parts[0] ?? null;
    let index = 1;
    const options: HeaderField[] = [];
    if (shopType === "itemshop" || shopType === "pointshop") {
      const cost = parts[index];
      if (cost !== undefined) options.push(cost);
      index += 1;
    } else if (shopType === "shop") {
      const maybeDiscount = parts[index];
      if (maybeDiscount !== undefined && !maybeDiscount.text.includes(":")) {
        options.push(maybeDiscount);
        index += 1;
      }
    }
    const items: ShopItem[] = [];
    for (const part of parts.slice(index)) {
      if (part.text === "") continue;
      const pieces = splitField(part, ":");
      const [itemField, priceField, stockField] = pieces;
      if (itemField === undefined) continue;
      items.push({
        item: itemField,
        price: priceField === undefined ? null : parseNumeric(priceField),
        stock: stockField === undefined ? null : parseNumeric(stockField),
        range: part.range,
      });
    }
    return {
      kind: "ShopDeclaration",
      range: { start: startOffset, end: endOffset },
      headerRange,
      fields,
      shopType,
      floating,
      location: locationField === undefined || floating ? null : this.checkedLocation(locationField, 4),
      name: parseNpcName(fields[2], headerRange.end),
      sprite,
      options,
      items,
    };
  }

  private decodeMonster(
    startOffset: number,
    headerRange: SourceRange,
    fields: readonly HeaderField[],
    endOffset: number,
    boss: boolean,
  ): MonsterDeclaration {
    if (fields.length < 4) this.report("RS0030", headerRange, { expected: 4, count: fields.length });
    const locationField = fields[0];
    return {
      kind: "MonsterDeclaration",
      range: { start: startOffset, end: endOffset },
      headerRange,
      fields,
      boss,
      location: locationField === undefined ? null : parseMapLocation(locationField),
      monsterName: fields[2] ?? null,
      parameters: fields[3] === undefined ? [] : splitField(fields[3], ","),
    };
  }

  private decodeMapflag(
    startOffset: number,
    headerRange: SourceRange,
    fields: readonly HeaderField[],
    endOffset: number,
  ): MapflagDeclaration {
    if (fields.length < 3) this.report("RS0030", headerRange, { expected: 3, count: fields.length });
    return {
      kind: "MapflagDeclaration",
      range: { start: startOffset, end: endOffset },
      headerRange,
      fields,
      map: fields[0] ?? null,
      flag: fields[2] ?? null,
      parameters: fields.slice(3),
    };
  }

  /** Position `carte,x,y,direction` : verifie le nombre de valeurs et leur nature numerique. */
  private checkedLocation(field: HeaderField, expectedCount: number): MapLocation {
    const location = parseMapLocation(field);
    const count = 1 + (location.x === null ? 0 : 1) + (location.y === null ? 0 : 1) + location.extra.length;
    // Le serveur lit les quatre premieres valeurs et ignore les suivantes (ex. `1@mcd,144,212,5,0` existe
    // dans des scripts reels) : seul un manque est une erreur.
    if (count < expectedCount) {
      this.report("RS0036", field.range, { expected: expectedCount === 3 ? "map,x,y" : "map,x,y,facing", count });
    }
    for (const value of [location.x, location.y, ...location.extra]) {
      if (value !== null && value.value === null) {
        this.report("RS0034", value.range, { value: value.text, what: "a coordinate" });
      }
    }
    return location;
  }

  private checkedNumber(field: HeaderField, what: string): NumericValue {
    const value = parseNumeric(field);
    if (value.value === null) {
      this.report("RS0034", value.range, { value: value.text, what: `a ${what}` });
    }
    return value;
  }

  // -------------------------------------------------------------------------
  // Blocs et instructions
  // -------------------------------------------------------------------------

  private parseBlock(): BlockStatement {
    const open = this.advance();
    if (open === undefined) {
      return { kind: "BlockStatement", range: { start: this.text.length, end: this.text.length }, openRange: { start: this.text.length, end: this.text.length }, closeRange: null, statements: [] };
    }
    const statements: Statement[] = [];
    let closeRange: SourceRange | null = null;
    if (!this.enter()) {
      const skipped = this.skipToNextDeclaration();
      return { kind: "BlockStatement", range: { start: open.range.start, end: Math.max(skipped.end, open.range.end) }, openRange: open.range, closeRange: null, statements };
    }
    for (;;) {
      const token = this.peek();
      if (token === undefined || this.isTopLevelStartAt(this.pos)) {
        this.report("RS0011", open.range);
        break;
      }
      if (this.isPunct(token, "}")) {
        closeRange = token.range;
        this.advance();
        break;
      }
      const before = this.pos;
      statements.push(this.parseStatement());
      if (this.pos === before) {
        // Garde-fou : ne jamais boucler sans progresser.
        const stuck = this.advance();
        if (stuck !== undefined) statements.push(this.raw(stuck.range));
      }
    }
    this.leave();
    const end = closeRange?.end ?? this.previous()?.range.end ?? open.range.end;
    return { kind: "BlockStatement", range: { start: open.range.start, end }, openRange: open.range, closeRange, statements };
  }

  private raw(range: SourceRange): RawStatement {
    return { kind: "RawStatement", range, originalText: this.text.slice(range.start, range.end) };
  }

  /** Saute jusqu'a `;` (consomme) ou au prochain `}` / debut de declaration (non consommes). */
  private recoverStatement(): RawStatement {
    const first = this.peek();
    const start = first?.range.start ?? this.text.length;
    let end = start;
    let braceDepth = 0;
    while (this.pos < this.sig.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (this.isTopLevelStartAt(this.pos) && end > start) break;
      if (this.isPunct(token, "{")) {
        braceDepth += 1;
      } else if (this.isPunct(token, "}")) {
        if (braceDepth === 0) break;
        braceDepth -= 1;
      } else if (this.isPunct(token, ";") && braceDepth === 0) {
        end = token.range.end;
        this.advance();
        break;
      }
      end = token.range.end;
      this.advance();
    }
    return this.raw({ start, end });
  }

  private parseStatement(): Statement {
    const token = this.peek();
    if (token === undefined || this.isPunct(token, "}") || this.isTopLevelStartAt(this.pos)) {
      this.report("RS0051", token === undefined ? this.emptyRangeAtEnd() : { start: token.range.start, end: token.range.start });
      return { kind: "EmptyStatement", range: this.emptyRangeAtEnd() } satisfies EmptyStatement;
    }
    if (this.isPunct(token, ";")) {
      this.advance();
      return { kind: "EmptyStatement", range: token.range } satisfies EmptyStatement;
    }
    if (this.isPunct(token, "{")) {
      return this.parseBlock();
    }
    if (token.kind === "Identifier") {
      const word = token.text.toLowerCase();
      if (CONTROL_KEYWORDS.has(word)) {
        const keywordStatement = this.parseKeywordStatement(token, word);
        if (keywordStatement !== null) return keywordStatement;
      }
      const next = this.peek(1);
      if (this.isPunct(next, ":") && !this.isPunct(this.peek(2), ":")) {
        this.advance();
        this.advance();
        const label: LabelStatement = {
          kind: "LabelStatement",
          range: { start: token.range.start, end: next?.range.end ?? token.range.end },
          name: token.text,
          nameRange: token.range,
        };
        return label;
      }
      if (this.startsAssignmentOrUpdate(next)) {
        return this.parseExpressionStatement(false);
      }
      return this.parseCommand(false);
    }
    if (token.kind === "Unknown") {
      this.report("RS0003", token.range, { char: token.text });
      return this.recoverStatement();
    }
    if (token.kind === "Punctuation" && (token.text === ")" || token.text === "]" || token.text === ",")) {
      this.report(token.text === "," ? "RS0021" : "RS0010", token.range, { token: token.text });
      this.advance();
      return this.raw(token.range);
    }
    if (token.kind === "Punctuation" && token.text === ":") {
      this.report("RS0021", token.range);
      this.advance();
      return this.raw(token.range);
    }
    if (token.kind === "Punctuation" && token.text === "[") {
      this.report("RS0010", token.range, { token: "[" });
      return this.recoverStatement();
    }
    return this.parseExpressionStatement(false);
  }

  private startsAssignmentOrUpdate(next: Token | undefined): boolean {
    if (next === undefined || next.kind !== "Operator") return this.isPunct(next, "[");
    return ASSIGNMENT_OPERATORS.has(next.text) || next.text === "++" || next.text === "--";
  }

  /**
   * Consomme le `;` terminal. Avec `lenient`, un unique caractere de ponctuation parasite a la place
   * du `;` (`x = 1:`, `x = (1));`) est signale une seule fois puis saute : le serveur fait de meme apres une
   * affectation (il saute le caractere suivant sans le verifier), ce qui evite une cascade d'erreurs.
   */
  private consumeSemicolon(lastRange: SourceRange, lenient = false): boolean {
    const token = this.peek();
    if (this.isPunct(token, ";")) {
      this.advance();
      return true;
    }
    if (lenient && token !== undefined && token.kind === "Punctuation") {
      if (token.text === "," || token.text === ":") {
        this.report("RS0020", token.range);
        this.advance();
        return false;
      }
      if (token.text === ")" || token.text === "]") {
        this.report("RS0010", token.range, { token: token.text });
        this.advance();
        return false;
      }
    }
    this.report("RS0020", lastRange);
    return false;
  }

  /** `inHeader` : instruction d'un `for (...)`, terminee par `;` ou `)` non consommes. */
  private parseExpressionStatement(inHeader: boolean): ExpressionStatement {
    const start = this.peek()?.range.start ?? this.text.length;
    const expression = this.parseExpression(0);
    let end = expression.range.end;
    let terminated = false;
    if (!inHeader) {
      terminated = this.consumeSemicolon(this.rangeFromPrevious(), true);
      end = this.previous()?.range.end ?? end;
    }
    return { kind: "ExpressionStatement", range: { start, end }, expression, terminated };
  }

  private parseCommand(inHeader: boolean): CommandStatement {
    const nameToken = this.advance();
    if (nameToken === undefined) {
      const range = this.emptyRangeAtEnd();
      return { kind: "CommandStatement", range, name: "", nameRange: range, args: [], parenthesized: false, terminated: false };
    }
    const args: Expression[] = [];
    let parenthesized = false;
    const next = this.peek();
    if (this.isPunct(next, "(")) {
      const open = this.advance();
      if (open !== undefined) {
        const group = this.parseCommandParenthesis(open);
        args.push(...group.args);
        parenthesized = group.parenthesized;
      }
      while (this.isPunct(this.peek(), ",") && !parenthesized) {
        this.advance();
        const after = this.peek();
        if (after === undefined || this.isPunct(after, ";")) {
          args.push({ kind: "Placeholder", range: this.emptyRangeAtEnd(), reason: "empty" });
          break;
        }
        args.push(this.parseArgument());
      }
    } else if (next !== undefined && !this.isPunct(next, ";") && !this.isPunct(next, "}") && !this.isTopLevelStartAt(this.pos) && !(inHeader && this.isPunct(next, ")"))) {
      for (;;) {
        args.push(this.parseArgument());
        const separator = this.peek();
        if (this.isPunct(separator, ",")) {
          this.advance();
          const after = this.peek();
          if (after === undefined || this.isPunct(after, ";")) {
            args.push({ kind: "Placeholder", range: this.emptyRangeAtEnd(), reason: "empty" });
            break;
          }
          continue;
        }
        break;
      }
    }
    let end = this.previous()?.range.end ?? nameToken.range.end;
    let terminated = false;
    if (!inHeader) {
      terminated = this.consumeSemicolon(this.rangeFromPrevious());
      if (terminated) end = this.previous()?.range.end ?? end;
    }
    return {
      kind: "CommandStatement",
      range: { start: nameToken.range.start, end },
      name: nameToken.text,
      nameRange: nameToken.range,
      args,
      parenthesized,
      terminated,
    };
  }

  /**
   * `commande (` : comme le serveur (parse_simpleexpr), la parenthese ouvre une liste d'arguments
   * si la premiere valeur est suivie d'une virgule ; sinon elle appartient a une expression qui peut
   * se poursuivre (ex. `getexp (checkre(3))?1000:10000,0;`). `mes ("a");` est normalise en
   * `parenthesized: true` avec l'argument interieur.
   */
  private parseCommandParenthesis(open: Token): { args: Expression[]; parenthesized: boolean } {
    if (!this.enter()) {
      this.skipToNextDeclaration();
      return { args: [], parenthesized: true };
    }
    if (this.isPunct(this.peek(), ")")) {
      this.advance();
      this.leave();
      return { args: [], parenthesized: true };
    }
    const first = this.parseExpression(0);
    if (this.isPunct(this.peek(), ",")) {
      const args: Expression[] = [first];
      while (this.isPunct(this.peek(), ",")) {
        this.advance();
        if (this.isPunct(this.peek(), ")")) {
          args.push({ kind: "Placeholder", range: this.emptyRangeAtEnd(), reason: "empty" });
          break;
        }
        args.push(this.parseArgument());
      }
      if (this.isPunct(this.peek(), ")")) this.advance();
      else this.report("RS0012", open.range);
      this.leave();
      return { args, parenthesized: true };
    }
    if (this.isPunct(this.peek(), ")")) this.advance();
    else this.report("RS0012", open.range);
    const closeEnd = this.previous()?.range.end ?? first.range.end;
    const group: Expression = { kind: "Parenthesized", range: { start: open.range.start, end: closeEnd }, expression: first };
    this.leave();
    const full = this.continueExpression(group, 0);
    if (full === group && !this.isPunct(this.peek(), ",")) {
      return { args: [first], parenthesized: true };
    }
    return { args: [full], parenthesized: false };
  }

  private parseKeywordStatement(token: Token, word: string): Statement | null {
    switch (word) {
      case "if":
        return this.parseIf(token);
      case "while":
        return this.parseWhile(token);
      case "do":
        return this.parseDoWhile(token);
      case "for":
        return this.parseFor(token);
      case "switch":
        return this.parseSwitch(token);
      case "case":
        return this.parseCase(token);
      case "default":
        return this.isPunct(this.peek(1), ":") ? this.parseDefault(token) : null;
      case "break":
      case "continue": {
        this.advance();
        const terminated = this.consumeSemicolon(token.range);
        const end = terminated ? (this.previous()?.range.end ?? token.range.end) : token.range.end;
        return { kind: word === "break" ? "BreakStatement" : "ContinueStatement", range: { start: token.range.start, end } };
      }
      case "return":
        return this.parseReturn(token);
      case "goto":
        return this.parseGoto(token);
      case "function":
        return this.parseLocalFunction(token);
      case "else": {
        this.report("RS0040", token.range);
        this.advance();
        return this.parseStatement();
      }
      default:
        return null;
    }
  }

  /**
   * Condition de `if` / `while` / `switch`. Comme dans le serveur, c'est une expression complete
   * qui commence par `(` : `if (a)&&(b) goto L;` a pour condition `(a)&&(b)`.
   */
  private parseParenthesizedCondition(keyword: Token): Expression {
    const open = this.peek();
    if (open === undefined || !this.isPunct(open, "(")) {
      this.report("RS0023", keyword.range, { keyword: keyword.text });
      return { kind: "ErrorExpression", range: this.emptyRangeAtEnd(), originalText: "" };
    }
    return this.parseExpression(0);
  }

  /** Consomme le delimiteur fermant ; sinon signale le delimiteur ouvrant non ferme. */
  private expectClosing(open: Token, closing: ")" | "]"): void {
    const token = this.peek();
    if (this.isPunct(token, closing)) {
      this.advance();
    } else {
      this.report(closing === ")" ? "RS0012" : "RS0013", open.range);
    }
  }

  private parseBranch(): Statement {
    if (!this.enter()) return this.recoverStatement();
    const statement = this.parseStatement();
    this.leave();
    return statement;
  }

  /**
   * `if ... else if ... else if ... else ...` : la chaine est lue iterativement (des scripts reels
   * enchainent plusieurs centaines de `else if`) puis l'AST imbrique est construit de la fin vers le debut.
   */
  private parseIf(keyword: Token): Statement {
    interface Link {
      readonly keyword: Token;
      readonly condition: Expression;
      readonly consequent: Statement;
    }
    const links: Link[] = [];
    let tail: Statement | null = null;
    let current: Token = keyword;
    for (;;) {
      this.advance();
      const condition = this.parseParenthesizedCondition(current);
      const consequent = this.parseBranch();
      links.push({ keyword: current, condition, consequent });
      if (!this.isKeyword(this.peek(), "else")) break;
      this.advance();
      const afterElse = this.peek();
      if (afterElse !== undefined && this.isKeyword(afterElse, "if")) {
        current = afterElse;
        continue;
      }
      tail = this.parseBranch();
      break;
    }
    let result: Statement = this.raw(keyword.range);
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const link = links[i];
      if (link === undefined) continue;
      const end = (tail ?? link.consequent).range.end;
      result = {
        kind: "IfStatement",
        range: { start: link.keyword.range.start, end },
        condition: link.condition,
        consequent: link.consequent,
        alternate: tail,
      };
      tail = result;
    }
    return result;
  }

  private parseWhile(keyword: Token): Statement {
    this.advance();
    const condition = this.parseParenthesizedCondition(keyword);
    if (!this.enter()) return this.recoverStatement();
    const body = this.parseStatement();
    this.leave();
    return { kind: "WhileStatement", range: { start: keyword.range.start, end: body.range.end }, condition, body };
  }

  private parseDoWhile(keyword: Token): Statement {
    this.advance();
    if (!this.enter()) return this.recoverStatement();
    const body = this.parseStatement();
    this.leave();
    const whileToken = this.peek();
    let condition: Expression = { kind: "ErrorExpression", range: this.emptyRangeAtEnd(), originalText: "" };
    if (this.isKeyword(whileToken, "while") && whileToken !== undefined) {
      this.advance();
      condition = this.parseParenthesizedCondition(whileToken);
    } else {
      this.report("RS0022", this.rangeFromPrevious(), { expected: "while" });
    }
    this.consumeSemicolon(this.rangeFromPrevious());
    return { kind: "DoWhileStatement", range: { start: keyword.range.start, end: this.previous()?.range.end ?? body.range.end }, body, condition };
  }

  private parseFor(keyword: Token): Statement {
    this.advance();
    const open = this.peek();
    if (open === undefined || !this.isPunct(open, "(")) {
      this.report("RS0023", keyword.range, { keyword: keyword.text });
      return this.recoverStatement();
    }
    this.advance();
    let init: Statement | null = null;
    let condition: Expression | null = null;
    let update: Statement | null = null;
    if (!this.isPunct(this.peek(), ";")) init = this.parseHeaderStatement();
    this.expectSemicolonInFor();
    if (!this.isPunct(this.peek(), ";")) condition = this.parseExpression(0);
    this.expectSemicolonInFor();
    if (!this.isPunct(this.peek(), ")")) update = this.parseHeaderStatement();
    this.expectClosing(open as Token, ")");
    if (!this.enter()) return this.recoverStatement();
    const body = this.parseStatement();
    this.leave();
    return { kind: "ForStatement", range: { start: keyword.range.start, end: body.range.end }, init, condition, update, body };
  }

  /** Separateur d'un `for (a; b; c)`. Une virgule a la place du `;` est signalee une fois puis acceptee (tolerance du serveur). */
  private expectSemicolonInFor(): void {
    const token = this.peek();
    if (this.isPunct(token, ";")) {
      this.advance();
    } else if (this.isPunct(token, ",") && token !== undefined) {
      this.report("RS0022", token.range, { expected: ";" });
      this.advance();
    } else {
      this.report("RS0022", this.rangeFromPrevious(), { expected: ";" });
    }
  }

  /** Instruction d'en-tete de `for` : commande (`set .@i,0`) ou expression, sans `;` terminal. */
  private parseHeaderStatement(): Statement {
    const token = this.peek();
    if (token !== undefined && token.kind === "Identifier" && !CONTROL_KEYWORDS.has(token.text.toLowerCase()) && !this.startsAssignmentOrUpdate(this.peek(1))) {
      return this.parseCommand(true);
    }
    return this.parseExpressionStatement(true);
  }

  private parseSwitch(keyword: Token): Statement {
    this.advance();
    const discriminant = this.parseParenthesizedCondition(keyword);
    if (!this.enter()) return this.recoverStatement();
    this.switchDepth += 1;
    const body = this.parseStatement();
    this.switchDepth -= 1;
    this.leave();
    return { kind: "SwitchStatement", range: { start: keyword.range.start, end: body.range.end }, discriminant, body };
  }

  private parseCase(keyword: Token): CaseStatement {
    if (this.switchDepth === 0) this.report("RS0041", keyword.range, { keyword: keyword.text });
    this.advance();
    const test = this.parseExpression(0);
    const colon = this.peek();
    if (this.isPunct(colon, ":")) {
      this.advance();
    } else {
      this.report("RS0022", this.rangeFromPrevious(), { expected: ":" });
    }
    return { kind: "CaseStatement", range: { start: keyword.range.start, end: this.previous()?.range.end ?? keyword.range.end }, test };
  }

  private parseDefault(keyword: Token): DefaultStatement {
    if (this.switchDepth === 0) this.report("RS0041", keyword.range, { keyword: keyword.text });
    this.advance();
    this.advance();
    return { kind: "DefaultStatement", range: { start: keyword.range.start, end: this.previous()?.range.end ?? keyword.range.end } };
  }

  private parseReturn(keyword: Token): Statement {
    this.advance();
    let value: Expression | null = null;
    const next = this.peek();
    if (next !== undefined && !this.isPunct(next, ";") && !this.isPunct(next, "}") && !this.isTopLevelStartAt(this.pos)) {
      value = this.parseExpression(0);
    }
    const terminated = this.consumeSemicolon(this.rangeFromPrevious());
    const end = terminated ? (this.previous()?.range.end ?? keyword.range.end) : (value?.range.end ?? keyword.range.end);
    return { kind: "ReturnStatement", range: { start: keyword.range.start, end }, value };
  }

  private parseGoto(keyword: Token): Statement {
    this.advance();
    const label = this.peek();
    if (label === undefined || label.kind !== "Identifier") {
      this.report("RS0024", keyword.range, { keyword: keyword.text });
      return this.recoverStatement();
    }
    this.advance();
    const terminated = this.consumeSemicolon(label.range);
    const end = terminated ? (this.previous()?.range.end ?? label.range.end) : label.range.end;
    return { kind: "GotoStatement", range: { start: keyword.range.start, end }, label: label.text, labelRange: label.range };
  }

  private parseLocalFunction(keyword: Token): FunctionStatement | null {
    const nameToken = this.peek(1);
    if (nameToken === undefined || nameToken.kind !== "Identifier") return null;
    this.advance();
    this.advance();
    const next = this.peek();
    if (this.isPunct(next, "{")) {
      const body = this.parseBlock();
      return { kind: "FunctionStatement", range: { start: keyword.range.start, end: body.range.end }, name: nameToken.text, nameRange: nameToken.range, body };
    }
    const terminated = this.consumeSemicolon(nameToken.range);
    const end = terminated ? (this.previous()?.range.end ?? nameToken.range.end) : nameToken.range.end;
    return { kind: "FunctionStatement", range: { start: keyword.range.start, end }, name: nameToken.text, nameRange: nameToken.range, body: null };
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /** Argument de commande : expression, ou espace reserve si la valeur est omise. */
  private parseArgument(): Expression {
    const token = this.peek();
    if (token === undefined || this.isPunct(token, ",") || this.isPunct(token, ")")) {
      return { kind: "Placeholder", range: this.emptyRangeAtEnd(), reason: "empty" };
    }
    return this.parseExpression(0);
  }

  /** Liste d'arguments d'un appel entre parentheses ; `open` est la `(` deja consommee. */
  private parseArguments(open: Token): Expression[] {
    const args: Expression[] = [];
    if (!this.enter()) {
      this.skipToNextDeclaration();
      return args;
    }
    if (this.isPunct(this.peek(), ")")) {
      this.advance();
      this.leave();
      return args;
    }
    for (;;) {
      args.push(this.parseArgument());
      const separator = this.peek();
      if (this.isPunct(separator, ",")) {
        this.advance();
        if (this.isPunct(this.peek(), ")")) args.push({ kind: "Placeholder", range: this.emptyRangeAtEnd(), reason: "empty" });
        else continue;
      }
      if (this.isPunct(this.peek(), ")")) {
        this.advance();
        break;
      }
      // Parenthese jamais fermee : le token courant n'est pas consomme (il peut etre `;` ou `}`).
      this.report("RS0012", open.range);
      break;
    }
    this.leave();
    return args;
  }

  private parseExpression(minPrecedence: number): Expression {
    if (!this.enter()) {
      const range = this.peek()?.range ?? this.emptyRangeAtEnd();
      this.skipToNextDeclaration();
      return { kind: "ErrorExpression", range, originalText: this.text.slice(range.start, range.end) };
    }
    const result = this.continueExpression(this.parseUnary(), minPrecedence);
    this.leave();
    return result;
  }

  /**
   * Poursuit une expression dont l'operande de gauche est deja lu (precedence montante).
   * Retourne `initial` lui-meme (meme objet) si aucun operateur ne suit.
   */
  private continueExpression(initial: Expression, minPrecedence: number): Expression {
    let left = initial;
    for (;;) {
      const token = this.peek();
      if (token === undefined || token.kind !== "Operator") break;
      const operator = token.text;
      if (ASSIGNMENT_OPERATORS.has(operator)) {
        if (minPrecedence > 1) break;
        this.advance();
        const value = this.parseExpression(1);
        left = { kind: "Assignment", range: { start: left.range.start, end: value.range.end }, operator, target: left, value };
        continue;
      }
      if (operator === "?") {
        if (minPrecedence > 2) break;
        this.advance();
        const consequent = this.parseExpression(2);
        const colon = this.peek();
        if (this.isPunct(colon, ":")) {
          this.advance();
        } else {
          this.report("RS0022", this.rangeFromPrevious(), { expected: ":" });
        }
        const alternate = this.parseExpression(2);
        left = { kind: "Conditional", range: { start: left.range.start, end: alternate.range.end }, test: left, consequent, alternate };
        continue;
      }
      const precedence = BINARY_PRECEDENCE.get(operator);
      if (precedence === undefined || precedence < minPrecedence) break;
      this.advance();
      const right = this.parseExpression(precedence + 1);
      left = { kind: "Binary", range: { start: left.range.start, end: right.range.end }, operator, left, right };
    }
    return left;
  }

  private parseUnary(): Expression {
    const token = this.peek();
    if (token !== undefined && token.kind === "Operator") {
      const text = token.text;
      if (text === "!" || text === "~" || text === "-" || text === "+") {
        const next = this.peek(1);
        if (text === "-" && (next === undefined || this.isPunct(next, ",") || this.isPunct(next, ";") || this.isPunct(next, ")"))) {
          this.advance();
          return { kind: "Placeholder", range: token.range, reason: "dash" };
        }
        this.advance();
        if (!this.enter()) return { kind: "ErrorExpression", range: token.range, originalText: token.text };
        const operand = this.parseUnary();
        this.leave();
        return { kind: "Unary", range: { start: token.range.start, end: operand.range.end }, operator: text, operand };
      }
      if (text === "++" || text === "--") {
        this.advance();
        if (!this.enter()) return { kind: "ErrorExpression", range: token.range, originalText: token.text };
        const operand = this.parseUnary();
        this.leave();
        return { kind: "Update", range: { start: token.range.start, end: operand.range.end }, operator: text, prefix: true, operand };
      }
    }
    const primary = this.parsePrimary();
    const after = this.peek();
    if (after !== undefined && after.kind === "Operator" && (after.text === "++" || after.text === "--") && (primary.kind === "Variable" || primary.kind === "Identifier")) {
      this.advance();
      return { kind: "Update", range: { start: primary.range.start, end: after.range.end }, operator: after.text, prefix: false, operand: primary };
    }
    return primary;
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    if (token === undefined) {
      this.report("RS0021", this.emptyRangeAtEnd());
      return { kind: "ErrorExpression", range: this.emptyRangeAtEnd(), originalText: "" };
    }
    switch (token.kind) {
      case "Number": {
        this.advance();
        const value = /^0[xX]/.test(token.text) ? Number.parseInt(token.text, 16) : Number.parseInt(token.text, 10);
        return { kind: "NumberLiteral", range: token.range, value, text: token.text };
      }
      case "String": {
        this.advance();
        return this.stringLiteral(token);
      }
      case "Variable":
        this.advance();
        return this.variableExpression(token);
      case "Identifier": {
        this.advance();
        const next = this.peek();
        if (this.isPunct(next, "(")) {
          this.advance();
          const args = this.parseArguments(next as Token);
          const end = this.previous()?.range.end ?? token.range.end;
          return { kind: "Call", range: { start: token.range.start, end }, callee: token.text, calleeRange: token.range, args };
        }
        if (this.isPunct(next, "[")) {
          return this.indexedVariable(token, "", token.text, token.range);
        }
        return { kind: "Identifier", range: token.range, name: token.text };
      }
      case "Punctuation": {
        if (token.text === "(") {
          this.advance();
          const inner = this.parseExpression(0);
          this.expectClosing(token, ")");
          const end = this.previous()?.range.end ?? inner.range.end;
          return { kind: "Parenthesized", range: { start: token.range.start, end }, expression: inner };
        }
        break;
      }
      case "Unknown": {
        this.report("RS0003", token.range, { char: token.text });
        this.advance();
        return { kind: "ErrorExpression", range: token.range, originalText: token.text };
      }
      default:
        break;
    }
    // Delimiteur ou operateur inattendu : ne rien consommer pour les terminateurs, sinon avancer d'un token.
    this.report("RS0021", token.range);
    if (token.kind === "Punctuation" && (token.text === ";" || token.text === ")" || token.text === "]" || token.text === "}" || token.text === "," || token.text === ":")) {
      return { kind: "ErrorExpression", range: { start: token.range.start, end: token.range.start }, originalText: "" };
    }
    this.advance();
    return { kind: "ErrorExpression", range: token.range, originalText: token.text };
  }

  private stringLiteral(token: Token): StringLiteral {
    const closed = token.unterminated !== true;
    const inner = token.text.slice(1, closed ? token.text.length - 1 : token.text.length);
    return {
      kind: "StringLiteral",
      range: token.range,
      value: unescapeString(inner),
      raw: token.text,
      unterminated: !closed,
    };
  }

  private variableExpression(token: Token): Expression {
    let prefix: VariablePrefix = "";
    let scope: VariableScope = "character-permanent";
    for (const [candidate, candidateScope] of VARIABLE_PREFIXES) {
      if (token.text.startsWith(candidate)) {
        prefix = candidate;
        scope = candidateScope;
        break;
      }
    }
    const isString = token.text.endsWith("$") && token.text.length > prefix.length + 1;
    const nameStart = token.range.start + prefix.length;
    const nameEnd = token.range.end - (isString ? 1 : 0);
    const name = this.text.slice(nameStart, nameEnd);
    return this.indexedVariable(token, prefix, name, { start: nameStart, end: nameEnd }, scope, isString);
  }

  private indexedVariable(
    token: Token,
    prefix: VariablePrefix,
    name: string,
    nameRange: SourceRange,
    scope: VariableScope = "character-permanent",
    isString = false,
  ): VariableExpression {
    let index: Expression | null = null;
    let end = token.range.end;
    const open = this.peek();
    if (this.isPunct(open, "[")) {
      this.advance();
      index = this.parseExpression(0);
      this.expectClosing(open as Token, "]");
      end = this.previous()?.range.end ?? end;
    }
    return {
      kind: "Variable",
      range: { start: token.range.start, end },
      raw: token.text,
      name,
      prefix,
      scope,
      isString,
      nameRange,
      index,
    };
  }
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  a: "\u0007",
  b: "\b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "'": "'",
  "?": "?",
};

/** Interprete les echappements usuels d'une chaine ; un echappement inconnu est conserve tel quel. */
export function unescapeString(inner: string): string {
  if (!inner.includes("\\")) return inner;
  let output = "";
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1] ?? "";
      const mapped = SIMPLE_ESCAPES[next];
      if (mapped !== undefined) {
        output += mapped;
        i += 1;
        continue;
      }
    }
    output += char;
  }
  return output;
}
