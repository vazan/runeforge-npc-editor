// Ce paquet n'inclut volontairement pas la bibliotheque DOM (il doit rester pur : ni DOM, ni Node, ni Tauri).
// Seules les API d'encodage standard, presentes dans les navigateurs, Node et les workers, sont declarees.

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  decode(input?: Uint8Array): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
