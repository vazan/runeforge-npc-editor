import type { EndOfLine } from "./types";

export interface EolStats {
  readonly lf: number;
  readonly crlf: number;
  readonly cr: number;
}

export function countEols(text: string): EolStats {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf += 1;
        i += 1;
      } else {
        cr += 1;
      }
    } else if (code === 10) {
      lf += 1;
    }
  }
  return { lf, crlf, cr };
}

/** Convention de fin de ligne d'un texte ; `LF` par defaut s'il n'y a aucun saut de ligne. */
export function detectEol(text: string): EndOfLine {
  const { lf, crlf, cr } = countEols(text);
  const kinds = [lf, crlf, cr].filter((count) => count > 0).length;
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "CRLF";
  if (cr > 0) return "CR";
  return "LF";
}

/** Fin de ligne la plus frequente (utile pour les nouvelles lignes d'un fichier `mixed`). */
export function dominantEol(text: string): "LF" | "CRLF" | "CR" {
  const { lf, crlf, cr } = countEols(text);
  if (crlf >= lf && crlf >= cr && crlf > 0) return "CRLF";
  if (cr > lf && cr > crlf) return "CR";
  return "LF";
}

export function eolString(eol: "LF" | "CRLF" | "CR"): string {
  return eol === "CRLF" ? "\r\n" : eol === "CR" ? "\r" : "\n";
}

/** Remplace tous les sauts de ligne par `\n`. */
export function normalizeToLf(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r\n|\r/g, "\n");
}

/** Convertit un texte en `\n` vers la convention donnee (pas pour `mixed` : voir project-core). */
export function applyEol(textWithLf: string, eol: "LF" | "CRLF" | "CR"): string {
  if (eol === "LF") return textWithLf;
  return textWithLf.replace(/\n/g, eolString(eol));
}
