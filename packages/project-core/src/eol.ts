import { applyEol, dominantEol, eolString, type EndOfLine } from "@runeforge/runescript-core";
import { diffSequences } from "./diff";

export interface LineWithEol {
  readonly content: string;
  /** Fin de ligne d'origine (`\n`, `\r\n`, `\r`) ; vide pour la derniere ligne si le texte ne se termine pas par un saut. */
  readonly eol: string;
}

/** Decoupe un texte en lignes en conservant la fin de ligne de chacune (le texte vide donne une ligne vide). */
export function splitWithEol(text: string): LineWithEol[] {
  const lines: LineWithEol[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      const crlf = text.charCodeAt(i + 1) === 10;
      lines.push({ content: text.slice(start, i), eol: crlf ? "\r\n" : "\r" });
      if (crlf) i += 1;
      start = i + 1;
    } else if (code === 10) {
      lines.push({ content: text.slice(start, i), eol: "\n" });
      start = i + 1;
    }
  }
  lines.push({ content: text.slice(start), eol: "" });
  return lines;
}

/**
 * Reapplique les fins de ligne d'un fichier a un texte edite (normalise en `\n`).
 *
 * - fichier uniforme (LF, CRLF ou CR) : conversion simple ;
 * - fichier `mixed` : les lignes inchangees gardent leur fin de ligne d'origine (alignement par diff de lignes),
 *   les lignes modifiees reprennent celle de la ligne remplacee, les lignes nouvelles la plus frequente.
 */
export function restoreEol(editedLf: string, original: { readonly text: string; readonly eol: EndOfLine }): string {
  if (original.eol !== "mixed") return applyEol(editedLf, original.eol);
  return preserveMixedEol(original.text, editedLf);
}

export function preserveMixedEol(originalText: string, editedLf: string): string {
  const original = splitWithEol(originalText);
  const dominant = eolString(dominantEol(originalText));
  const newLines = editedLf.split("\n");
  const ops = diffSequences(
    original.map((line) => line.content),
    newLines,
  );

  const assigned: string[] = new Array<string>(newLines.length).fill(dominant);
  const lastIndex = newLines.length - 1;
  const orUsable = (eol: string | undefined, index: number): string =>
    eol === undefined || eol === "" || index === lastIndex ? dominant : eol;

  let pendingDeletes: number[] = [];
  let pendingInserts: number[] = [];
  const flush = (): void => {
    pendingInserts.forEach((newIndex, position) => {
      const replaced = pendingDeletes[position];
      assigned[newIndex] = orUsable(replaced === undefined ? undefined : original[replaced]?.eol, newIndex);
    });
    pendingDeletes = [];
    pendingInserts = [];
  };
  for (const op of ops) {
    if (op.type === "delete") {
      pendingDeletes.push(op.a);
    } else if (op.type === "insert") {
      pendingInserts.push(op.b);
    } else {
      flush();
      assigned[op.b] = orUsable(original[op.a]?.eol, op.b);
    }
  }
  flush();

  let output = "";
  newLines.forEach((line, index) => {
    output += line + (index === lastIndex ? "" : (assigned[index] ?? dominant));
  });
  return output;
}
