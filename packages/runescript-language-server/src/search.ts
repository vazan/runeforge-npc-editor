/**
 * Score d'une correspondance de recherche de symbole (plus grand = meilleur), ou `null` si `query` ne correspond pas.
 * Insensible a la casse. Ordre : egalite > prefixe > debut de mot > sous-chaine > sous-sequence.
 */
export function matchScore(query: string, text: string): number | null {
  if (query === "") return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - Math.min(t.length - q.length, 100);

  const at = t.indexOf(q);
  if (at !== -1) {
    const before = t.charCodeAt(at - 1);
    const boundary = before === 95 /* _ */ || before === 35 /* # */ || before === 58 /* : */ || before === 32 /* espace */ || before === 46 /* . */;
    return (boundary ? 600 : 400) - Math.min(at, 100);
  }

  // Sous-sequence : toutes les lettres de `q` apparaissent dans l'ordre.
  let position = 0;
  let gaps = 0;
  let previous = -1;
  for (const char of q) {
    const found = t.indexOf(char, position);
    if (found === -1) return null;
    if (previous !== -1) gaps += found - previous - 1;
    previous = found;
    position = found + 1;
  }
  return 100 - Math.min(gaps, 90);
}
