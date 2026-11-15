import { tokenize } from "@runeforge/runescript-core";
import type { Token } from "@runeforge/runescript-core";

/**
 * Lecture du **texte qui precede le curseur** pour savoir ou l'on en est dans une instruction : debut d'instruction,
 * operande, commande ou fonction dont on ecrit les arguments et rang de l'argument. Comme pour la completion de labels,
 * c'est le texte qui fait foi et non l'AST : le code en cours de frappe est presque toujours invalide.
 *
 * Le lecteur suit le serveur (`parse_line`, `parse_callfunc`) :
 * - une instruction commence apres `;`, `{`, `}`, un label (`Nom:`), `else`, `do`, `case X:` et l'en-tete d'un `if`, `while`,
 *   `for` ou `switch` ;
 * - un appel s'ecrit `commande arg, arg;` ou `commande(arg, arg)` ; en expression seule la forme parenthesee existe ;
 * - `commande (a, b)` : la parenthese qui suit directement le nom regroupe les arguments (`callsub (L_X, 1)`) ;
 * - les virgules entre parentheses de regroupement ou entre crochets ne separent pas les arguments de l'appel englobant.
 */

export interface ScannedCall {
  /** Nom tel qu'ecrit. */
  readonly name: string;
  /** Plage du nom dans le texte lu. */
  readonly nameStart: number;
  readonly nameEnd: number;
  /** Rang de l'argument en cours de saisie : nombre de virgules de premier niveau deja vues. */
  readonly argIndex: number;
  /** Ecrit avec des parentheses (`rand(1, 2)`) ou sans (`mes "a", "b";`). */
  readonly parenthesized: boolean;
}

export interface CallScan {
  /** Rien n'est ecrit depuis le debut de l'instruction courante : une commande peut s'ecrire ici. */
  readonly statementStart: boolean;
  /** Le curseur est a une position d'operande : apres `(`, `[`, `,`, un operateur ou le nom d'une commande. */
  readonly operand: boolean;
  /** L'appel le plus interne dont le curseur est dans les arguments, ou `null`. */
  readonly call: ScannedCall | null;
  /** Le curseur est dans un commentaire (de ligne, ou bloc non ferme) : rien ne se propose ni ne s'affiche. */
  readonly inComment: boolean;
}

interface CallFrame {
  readonly kind: "call";
  readonly name: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  argIndex: number;
  readonly parenthesized: boolean;
}
interface GroupFrame {
  readonly kind: "group";
  /** Parenthese qui suit directement le nom d'une commande : ses virgules separent les arguments de la commande. */
  readonly transparent: boolean;
  /** Parentheses de l'en-tete d'un `if`, `while`, `for` ou `switch`. */
  readonly control: boolean;
}
interface IndexFrame {
  readonly kind: "index";
}
type Frame = CallFrame | GroupFrame | IndexFrame;

const CONTROL_KEYWORDS: ReadonlySet<string> = new Set(["if", "while", "for", "switch"]);

function isTrivia(token: Token): boolean {
  return token.kind === "Spaces" || token.kind === "Tabs" || token.kind === "Newline" || token.kind === "LineComment" || token.kind === "BlockComment";
}

function isPunctuation(token: Token | null, text: string): boolean {
  return token !== null && token.kind === "Punctuation" && token.text === text;
}

/** Lit `text` (le texte qui precede le curseur) et decrit la position du curseur dans l'instruction courante. */
export function scanCalls(text: string): CallScan {
  const stack: Frame[] = [];
  let statementStart = true;
  let controlPending = false;
  let caseMode = false;
  let pending: { name: string; start: number; end: number } | null = null;
  let last: Token | null = null;

  const top = (): Frame | undefined => stack[stack.length - 1];
  const resetStatement = (): void => {
    stack.length = 0;
    statementStart = true;
    controlPending = false;
    caseMode = false;
    pending = null;
  };
  const insideControlHeader = (): boolean => stack.some((frame) => frame.kind === "group" && frame.control);
  /** L'appel auquel appartient une virgule lue maintenant, s'il y en a un. */
  const owner = (): CallFrame | undefined => {
    const frame = top();
    if (frame === undefined) return undefined;
    if (frame.kind === "call") return frame;
    if (frame.kind === "group" && frame.transparent) {
      const below = stack[stack.length - 2];
      return below?.kind === "call" ? below : undefined;
    }
    return undefined;
  };

  let inComment = false;
  for (const token of tokenize(text)) {
    inComment = token.kind === "LineComment" || (token.kind === "BlockComment" && token.unterminated === true);
    if (isTrivia(token)) continue;
    const previous = last;
    last = token;

    if (token.kind === "Identifier") {
      const lower = token.text.toLowerCase();
      if (stack.length === 0 && statementStart) {
        if (lower === "else" || lower === "do") continue; // l'instruction commence juste apres le mot-cle
        statementStart = false;
        pending = null;
        if (CONTROL_KEYWORDS.has(lower)) {
          controlPending = true;
        } else if (lower === "case" || lower === "default") {
          caseMode = true;
        } else if (lower !== "function") {
          stack.push({ kind: "call", name: token.text, nameStart: token.range.start, nameEnd: token.range.end, argIndex: 0, parenthesized: false });
        }
        continue;
      }
      pending = { name: token.text, start: token.range.start, end: token.range.end };
      continue;
    }

    if (token.kind !== "Punctuation") {
      // Chaine, nombre, variable, operateur : un argument ou un operande, jamais un debut d'instruction.
      if (stack.length === 0) statementStart = false;
      pending = null;
      continue;
    }

    switch (token.text) {
      case ";":
        if (insideControlHeader()) break; // `for (a; b; c)`
        resetStatement();
        break;
      case "{":
      case "}":
        resetStatement();
        break;
      case "(": {
        if (stack.length === 0) statementStart = false;
        const frame = top();
        if (controlPending) {
          stack.push({ kind: "group", transparent: false, control: true });
          controlPending = false;
        } else if (pending !== null) {
          stack.push({ kind: "call", name: pending.name, nameStart: pending.start, nameEnd: pending.end, argIndex: 0, parenthesized: true });
        } else if (frame?.kind === "call" && !frame.parenthesized && previous !== null && previous.range.end === frame.nameEnd) {
          stack.push({ kind: "group", transparent: true, control: false });
        } else {
          stack.push({ kind: "group", transparent: false, control: false });
        }
        pending = null;
        break;
      }
      case ")": {
        const closed = stack.pop();
        if (closed?.kind === "group" && closed.control) resetStatement();
        pending = null;
        break;
      }
      case "[":
        stack.push({ kind: "index" });
        pending = null;
        break;
      case "]":
        if (top()?.kind === "index") stack.pop();
        pending = null;
        break;
      case ",": {
        const call = owner();
        if (call !== undefined) call.argIndex += 1;
        pending = null;
        break;
      }
      case ":": {
        const frame = top();
        const isLabel = stack.length === 1 && frame?.kind === "call" && !frame.parenthesized && previous !== null && previous.range.end === frame.nameEnd;
        if (isLabel || (caseMode && stack.length === 0)) resetStatement();
        pending = null;
        break;
      }
      default:
        if (stack.length === 0) statementStart = false;
        pending = null;
    }
  }

  let call: ScannedCall | null = null;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];
    if (frame?.kind === "call") {
      // `commande(` ecrit a l'instruction : la parenthese encore ouverte juste au-dessus du nom est celle de l'appel.
      const next = stack[index + 1];
      const opened = next?.kind === "group" && next.transparent;
      call = { name: frame.name, nameStart: frame.nameStart, nameEnd: frame.nameEnd, argIndex: frame.argIndex, parenthesized: frame.parenthesized || opened };
      break;
    }
  }

  const frame = top();
  const operand =
    last !== null &&
    (last.kind === "Operator" ||
      isPunctuation(last, "(") ||
      isPunctuation(last, "[") ||
      isPunctuation(last, ",") ||
      // `mes <ici>` : le premier argument d'une commande ecrite sans parentheses.
      (last.kind === "Identifier" && frame?.kind === "call" && !frame.parenthesized && last.range.end === frame.nameEnd));

  return { statementStart: stack.length === 0 && statementStart, operand, call, inComment };
}
