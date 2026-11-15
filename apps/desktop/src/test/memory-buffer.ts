import type { TextBuffer } from "../state/documents";

/** Tampon de texte en memoire (doublure de test du modele Monaco). */
export class MemoryBuffer implements TextBuffer {
  disposed = false;

  constructor(public text: string) {}

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }

  dispose(): void {
    this.disposed = true;
  }
}
