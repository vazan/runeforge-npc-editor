/**
 * Diff de sequences (algorithme de Myers, O(ND)) avec elagage des prefixes/suffixes communs.
 * Utilise pour conserver les fins de ligne d'un fichier mixte et pour decrire des modifications (patchs, IA, graphe).
 */

export type DiffOp =
  | { readonly type: "equal"; readonly a: number; readonly b: number }
  | { readonly type: "delete"; readonly a: number }
  | { readonly type: "insert"; readonly b: number };

/** Nombre maximal d'edits explores avant de renoncer a un diff minimal (repli : tout supprimer puis tout inserer). */
const DEFAULT_MAX_EDITS = 1500;

export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  equals: (x: T, y: T) => boolean = (x, y) => x === y,
  maxEdits = DEFAULT_MAX_EDITS,
): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && equals(a[start] as T, b[start] as T)) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && equals(a[endA - 1] as T, b[endB - 1] as T)) {
    endA -= 1;
    endB -= 1;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: "equal", a: i, b: i });
  const middle = myers(a.slice(start, endA), b.slice(start, endB), equals, maxEdits);
  for (const op of middle) {
    if (op.type === "equal") ops.push({ type: "equal", a: op.a + start, b: op.b + start });
    else if (op.type === "delete") ops.push({ type: "delete", a: op.a + start });
    else ops.push({ type: "insert", b: op.b + start });
  }
  for (let i = 0; i < a.length - endA; i += 1) ops.push({ type: "equal", a: endA + i, b: endB + i });
  return ops;
}

function fallback(n: number, m: number): DiffOp[] {
  const ops: DiffOp[] = [];
  for (let i = 0; i < n; i += 1) ops.push({ type: "delete", a: i });
  for (let j = 0; j < m; j += 1) ops.push({ type: "insert", b: j });
  return ops;
}

function myers<T>(a: readonly T[], b: readonly T[], equals: (x: T, y: T) => boolean, maxEdits: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return fallback(n, m);

  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d] = copie compacte de v pour k dans [-d, d] apres l'etape d.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && equals(a[x] as T, b[y] as T)) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(trace, n, m);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return fallback(n, m);
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): DiffOp[] {
  const reversed: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const previous = trace[d - 1] as Int32Array;
    const k = x - y;
    // previous est indexe par (k' + (d - 1)).
    const at = (kk: number): number => previous[kk + (d - 1)] ?? 0;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      reversed.push({ type: "equal", a: x, b: y });
    }
    if (x === previousX) {
      y -= 1;
      reversed.push({ type: "insert", b: y });
    } else {
      x -= 1;
      reversed.push({ type: "delete", a: x });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ type: "equal", a: x, b: y });
  }
  return reversed.reverse();
}

/** Diff ligne a ligne de deux textes (sauts de ligne `\n` ; pas de gestion de `\r`, a utiliser sur du texte normalise). */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  return diffSequences(oldText.split("\n"), newText.split("\n"));
}
