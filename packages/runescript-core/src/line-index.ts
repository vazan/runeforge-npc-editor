import type { Position, SourceRange } from "./types";

/**
 * Index des debuts de ligne d'un texte. Les sauts de ligne reconnus sont les memes
 * que ceux du lexer : `\n`, `\r\n` et `\r` seul. Les offsets sont des code units UTF-16.
 */
export class LineIndex {
  /** Tableau compact (4 octets par ligne) : un index est conserve par fichier du projet. */
  private readonly starts: Int32Array;
  readonly length: number;

  constructor(text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 13) {
        if (text.charCodeAt(i + 1) === 10) i += 1;
        starts.push(i + 1);
      } else if (code === 10) {
        starts.push(i + 1);
      }
    }
    this.starts = Int32Array.from(starts);
    this.length = text.length;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** Offset du premier caractere de la ligne (0-based) ; borne a la derniere ligne. */
  lineStart(line: number): number {
    const clamped = Math.min(Math.max(line, 0), this.starts.length - 1);
    return this.starts[clamped] ?? 0;
  }

  /** Plage de la ligne, saut de ligne final exclu n'est PAS retire : `end` = debut de la ligne suivante. */
  lineRange(line: number): SourceRange {
    const start = this.lineStart(line);
    const end = line + 1 < this.starts.length ? this.lineStart(line + 1) : this.length;
    return { start, end };
  }

  /** Position (ligne, colonne) d'un offset ; l'offset est borne a [0, length]. */
  positionAt(offset: number): Position {
    const clamped = Math.min(Math.max(offset, 0), this.length);
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: clamped - (this.starts[low] ?? 0) };
  }

  /** Offset d'une position ; la colonne est bornee a la fin de la ligne (saut de ligne exclu). */
  offsetAt(position: Position, text: string): number {
    if (position.line < 0) return 0;
    if (position.line >= this.starts.length) return this.length;
    const start = this.starts[position.line] ?? 0;
    let end = position.line + 1 < this.starts.length ? (this.starts[position.line + 1] ?? this.length) : this.length;
    // Exclut le saut de ligne de la ligne courante.
    while (end > start) {
      const code = text.charCodeAt(end - 1);
      if (code === 10 || code === 13) end -= 1;
      else break;
    }
    return Math.min(Math.max(start + position.character, start), end);
  }
}
