/**
 * Recherche floue par sous-sequence (palette de commandes, "aller au fichier"). Retourne `null` si `query` n'est pas
 * une sous-sequence de `text`, sinon un score : plus il est eleve, meilleure est la correspondance.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (needle === "") return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let position = 0;
  let previousMatch = -2;
  for (let i = 0; i < needle.length; i += 1) {
    const found = haystack.indexOf(needle[i] as string, position);
    if (found === -1) return null;
    const before = found === 0 ? "" : (haystack[found - 1] as string);
    const atBoundary = found === 0 || before === "/" || before === "\\" || before === "_" || before === "-" || before === "." || before === " ";
    score += 1;
    if (found === previousMatch + 1) score += 8; // lettres consecutives
    if (atBoundary) score += 6; // debut de mot ou de segment
    if (found === 0) score += 4;
    score -= Math.min(3, found - position) * 0.3; // petite penalite pour les trous
    previousMatch = found;
    position = found + 1;
  }
  // Prefere les textes courts : a score egal, la correspondance la plus ciblee gagne.
  return score - text.length * 0.01;
}

/** Score d'un chemin : la correspondance sur le nom du fichier est favorisee. */
export function fuzzyScorePath(query: string, path: string): number | null {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const onName = fuzzyScore(query, name);
  const onPath = fuzzyScore(query, path);
  if (onName === null) return onPath;
  return Math.max(onName + 25, onPath ?? Number.NEGATIVE_INFINITY);
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
}

/** Filtre et classe `items` ; au plus `limit` resultats. Une requete vide conserve l'ordre d'origine. */
export function rank<T>(query: string, items: readonly T[], text: (item: T) => string, limit = 50, pathLike = false): Ranked<T>[] {
  if (query.trim() === "") return items.slice(0, limit).map((item) => ({ item, score: 0 }));
  const scored: Ranked<T>[] = [];
  for (const item of items) {
    const value = text(item);
    const score = pathLike ? fuzzyScorePath(query, value) : fuzzyScore(query, value);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
