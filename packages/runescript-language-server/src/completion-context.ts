import { tokenize } from "@runeforge/runescript-core";
import type { Token } from "@runeforge/runescript-core";
import { scanCalls } from "./call-scan";

/**
 * Contexte de completion au curseur, deduit du **texte de la ligne** (pas de l'AST : le code en cours de frappe est
 * presque toujours invalide, donc non analysable). `start` / `end` : plage, en offsets du document, du fragment que la
 * completion remplace.
 */
export type CompletionContext =
  | { readonly kind: "label"; readonly partial: string; readonly start: number; readonly end: number }
  | { readonly kind: "function-name"; readonly partial: string; readonly start: number; readonly end: number }
  | { readonly kind: "npc-name"; readonly partial: string; readonly start: number; readonly end: number }
  | { readonly kind: "variable"; readonly partial: string; readonly start: number; readonly end: number }
  /**
   * Commande ou fonction native : `statement` au debut d'une instruction (les mots-cles du langage s'y proposent aussi),
   * `expression` a une position d'operande (argument, apres un operateur ou une parenthese). Le service decide s'il propose
   * quelque chose (la completion explicite, ou un fragment deja saisi).
   */
  | {
      readonly kind: "command";
      readonly position: "statement" | "expression";
      readonly partial: string;
      readonly start: number;
      readonly end: number;
      /**
       * A une position d'operande dans l'appel d'une commande : cette commande et le rang de l'argument en cours. Le service
       * en tire, avec le registre, la nature de l'argument (objet, monstre, carte).
       */
      readonly argument?: { readonly command: string; readonly index: number };
    }
  /**
   * Dans une chaine non fermee, argument d'une commande (autre que la cible de `callfunc`, completee a part) : `partial` est
   * le texte deja ecrit apres le guillemet ouvrant.
   */
  | {
      readonly kind: "string-argument";
      readonly command: string;
      readonly argumentIndex: number;
      readonly partial: string;
      readonly start: number;
      readonly end: number;
    };

/**
 * Instructions dont l'argument d'indice donne designe un label du script (voir `runescript-analysis`). `goto` et
 * `callsub` sont traites a part (`LABEL_FIRST_ARGUMENT`) car ils s'emploient aussi dans une expression.
 */
const LABEL_ARGUMENTS: ReadonlyMap<string, (argumentIndex: number) => boolean> = new Map([
  ["menu", (index) => index % 2 === 1],
  ["jump_zero", (index) => index === 1],
]);

/** Mots dont le premier argument est un label, ou un nom de fonction globale, quel que soit leur contexte. */
const LABEL_FIRST_ARGUMENT: ReadonlySet<string> = new Set(["goto", "callsub"]);
const FUNCTION_FIRST_ARGUMENT: ReadonlySet<string> = new Set(["callfunc"]);

/** Mots-cles dont la condition entre parentheses precede l'instruction qu'ils controlent. */
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set(["if", "while", "for", "switch"]);

const PARTIAL_WORD = /[.@$#']*[A-Za-z0-9_]*\$?$/;
const WORD_REST = /^[A-Za-z0-9_]*\$?/;
const LINE_START_WORD_WITH_HYPHEN = /^[ \t]*([A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]*)+)$/;
const HYPHEN_WORD_REST = /^[A-Za-z0-9_-]*/;
const DUPLICATE_HEADER = /^[^\t]*\t+duplicate\(([^)\t]*)$/i;

function isTrivia(token: Token): boolean {
  return token.kind === "Spaces" || token.kind === "Tabs" || token.kind === "Newline" || token.kind === "LineComment" || token.kind === "BlockComment";
}

interface CallContext {
  /** Nom (minuscules) de la commande de l'instruction courante ; `""` si l'instruction ne commence pas par un mot. */
  readonly command: string | undefined;
  /** Indice de l'argument en cours de saisie (nombre de virgules de premier niveau deja vues). */
  readonly argumentIndex: number;
  /** Profondeur de parentheses/crochets ouverts (0 = au premier niveau des arguments). */
  readonly depth: number;
}

interface CallState {
  command: string | undefined;
  argumentIndex: number;
  depth: number;
  /** Tokens significatifs vus depuis la commande. */
  since: number;
  /** La parenthese qui suit directement la commande (`callsub (L_X)`) a ete rencontree. */
  parenthesis: boolean;
}

const freshState = (): CallState => ({ command: undefined, argumentIndex: 0, depth: 0, since: 0, parenthesis: false });

/** Lit les tokens de la ligne jusqu'au curseur et retourne la commande et l'argument en cours. */
function callContext(tokens: readonly Token[]): CallContext {
  let state = freshState();
  for (const token of tokens) {
    if (isTrivia(token)) continue;
    if (token.kind === "Punctuation" && (token.text === ";" || token.text === "{" || token.text === "}")) {
      state = freshState();
      continue;
    }
    if (state.command === undefined) {
      state.command = token.kind === "Identifier" ? token.text.toLowerCase() : "";
      // `else goto L;` / `do callsub L;` : l'instruction commence juste apres le mot-cle.
      if (state.command === "else" || state.command === "do") state = freshState();
      continue;
    }
    // `Nom:` (label) ou `case 1:` : l'instruction recommence apres les deux-points.
    if (token.kind === "Punctuation" && token.text === ":" && state.depth === 0 && state.since === 0) {
      state = freshState();
      continue;
    }
    state.since += 1;
    if (token.kind !== "Punctuation") continue;
    switch (token.text) {
      case "(":
        // `callsub (L_X, 1)` : la parenthese qui suit directement la commande ne compte pas comme une imbrication.
        if (!state.parenthesis && state.depth === 0 && state.argumentIndex === 0 && state.since === 1) state.parenthesis = true;
        else state.depth += 1;
        break;
      case "[":
        state.depth += 1;
        break;
      case ")":
      case "]":
        if (state.depth > 0) {
          state.depth -= 1;
        } else if (token.text === ")" && state.parenthesis && CONTROL_KEYWORDS.has(state.command)) {
          // `if (condition) goto L;` : l'instruction commence apres la parenthese de la condition.
          state = freshState();
        }
        break;
      case ",":
        if (state.depth === 0) state.argumentIndex += 1;
        break;
      default:
        break;
    }
  }
  return { command: state.command, argumentIndex: state.argumentIndex, depth: state.depth };
}

/**
 * Vrai si le curseur, place juste apres `tokens`, est le premier argument d'un des mots `names`, sous la forme
 * `mot <ici>` ou `mot(<ici>` — y compris au milieu d'une expression (`set .@x, callfunc("F_Rand", 3)`).
 */
function isFirstArgumentOf(tokens: readonly Token[], names: ReadonlySet<string>): boolean {
  const significant = tokens.filter((token) => !isTrivia(token));
  const last = significant[significant.length - 1];
  if (last === undefined) return false;
  if (last.kind === "Identifier") return names.has(last.text.toLowerCase());
  const before = significant[significant.length - 2];
  return last.kind === "Punctuation" && last.text === "(" && before?.kind === "Identifier" && names.has(before.text.toLowerCase());
}

/** Indice (dans `text`) du debut de la ligne qui contient `offset`. */
function lineStartOf(text: string, offset: number): number {
  return offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** Nombre de lignes precedentes lues pour retrouver la commande d'un argument ecrit sur une autre ligne. */
const CONTEXT_LINES = 2;

export function completionContextAt(text: string, offset: number): CompletionContext | undefined {
  const lineStart = lineStartOf(text, offset);
  const prefix = text.slice(lineStart, offset);
  // Un argument peut etre sur une autre ligne que sa commande (appel `callfunc(` suivi de `"F_...",` a la ligne).
  let contextStart = lineStart;
  for (let i = 0; i < CONTEXT_LINES && contextStart > 0; i += 1) contextStart = lineStartOf(text, contextStart - 1);
  const contextPrefix = text.slice(contextStart, offset);
  const lineEnd = ((): number => {
    const next = text.indexOf("\n", offset);
    return next === -1 ? text.length : next;
  })();
  const rest = text.slice(offset, lineEnd);

  // En-tete `duplicate(Nom)` : nom d'un NPC source.
  const header = DUPLICATE_HEADER.exec(prefix);
  if (header !== null) {
    const partial = header[1] ?? "";
    const closing = rest.search(/[)\t]/);
    return { kind: "npc-name", partial, start: offset - partial.length, end: offset + (closing === -1 ? rest.length : closing) };
  }

  const tokens = tokenize(contextPrefix);
  const last = tokens[tokens.length - 1];
  if (last !== undefined) {
    if (last.kind === "LineComment" || (last.kind === "BlockComment" && last.unterminated === true)) return undefined;
    if (last.kind === "String" && last.unterminated === true) {
      // Dans une chaine : la cible de `callfunc "..."`, puis l'argument d'une commande (carte, objet, monstre : le service decide).
      const partial = last.text.slice(1);
      const quote = rest.indexOf('"');
      const start = contextStart + last.range.start + 1;
      const end = offset + (quote === -1 ? rest.search(/[;)\s]|$/) : quote);
      if (isFirstArgumentOf(tokens.slice(0, -1), FUNCTION_FIRST_ARGUMENT)) return { kind: "function-name", partial, start, end };
      const scan = scanCalls(contextPrefix.slice(0, last.range.start));
      if (scan.inComment || scan.call === null) return undefined;
      return { kind: "string-argument", command: scan.call.name, argumentIndex: scan.call.argIndex, partial, start, end };
    }
  }

  // Mot a tiret en debut de ligne : un modele de NPC se declenche par son identifiant (`npc-warp`).
  const lineWord = LINE_START_WORD_WITH_HYPHEN.exec(prefix)?.[1];
  if (lineWord !== undefined) {
    return { kind: "command", position: "statement", partial: lineWord, start: offset - lineWord.length, end: offset + (HYPHEN_WORD_REST.exec(rest)?.[0].length ?? 0) };
  }

  const partial = PARTIAL_WORD.exec(prefix)?.[0] ?? "";
  const start = offset - partial.length;
  const end = offset + (WORD_REST.exec(rest)?.[0].length ?? 0);

  if (/^[.@$#']/.test(partial)) return { kind: "variable", partial, start, end };

  const before = tokenize(contextPrefix.slice(0, contextPrefix.length - partial.length));
  if (isFirstArgumentOf(before, LABEL_FIRST_ARGUMENT)) return { kind: "label", partial, start, end };
  const call = callContext(before);
  if (call.command !== undefined && call.depth === 0 && LABEL_ARGUMENTS.get(call.command)?.(call.argumentIndex) === true) {
    return { kind: "label", partial, start, end };
  }

  // Commande ou fonction native : un mot simple, au debut d'une instruction ou a une position d'operande. Un nombre en cours de
  // saisie a une position d'argument (`getitem 50|`) en est un aussi : le service y cherche un identifiant d'objet ou de monstre.
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*)?$/.test(partial) || /^\d+$/.test(partial)) {
    const scan = scanCalls(contextPrefix.slice(0, contextPrefix.length - partial.length));
    const isNumber = partial !== "" && /^\d/.test(partial);
    if (scan.statementStart && !isNumber) return { kind: "command", position: "statement", partial, start, end };
    if (scan.operand && (!isNumber || scan.call !== null)) {
      const argument = scan.call === null ? undefined : { command: scan.call.name, index: scan.call.argIndex };
      return argument === undefined ? { kind: "command", position: "expression", partial, start, end } : { kind: "command", position: "expression", partial, start, end, argument };
    }
  }
  return undefined;
}
