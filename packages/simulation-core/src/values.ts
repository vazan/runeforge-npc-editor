import type { Reference, SimValue } from "./types";

/** Conversion d'une chaîne en nombre comme le serveur : le préfixe entier, 0 sinon. */
export function toNumber(value: SimValue): number {
  if (typeof value === "number") return value;
  const match = /^\s*([-+]?\d+)/.exec(value);
  const parsed = match === null ? 0 : Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export const toText = (value: SimValue): string => (typeof value === "string" ? value : String(value));

/** Un nombre non nul ou une chaîne non vide est vrai. */
export const truthy = (value: SimValue): boolean => (typeof value === "number" ? value !== 0 : value !== "");

const VARIABLE = /^(\.@|\$@|\$|##|#|\.|@|')?([A-Za-z_][A-Za-z_0-9]*)(\$)?(?:\[\s*(\d+)\s*\])?$/;

/** Lit un nom de variable écrit en texte (`getd`, `setd`, contexte de test) : `$@liste$[2]`, `.@x`, `bard_q`. */
export function parseVariableName(text: string): Reference | null {
  const match = VARIABLE.exec(text.trim());
  if (match === null) return null;
  const index = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isSafeInteger(index)) return null;
  return {
    base: `${match[1] ?? ""}${match[2] ?? ""}${match[3] ?? ""}`.toLowerCase(),
    index,
    isString: match[3] === "$",
  };
}

/** Texte lisible d'une liste de valeurs : les chaînes entre guillemets, les nombres tels quels. */
export function describeValues(values: readonly SimValue[]): string {
  return values.map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value))).join(", ");
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) : une graine, une suite. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
