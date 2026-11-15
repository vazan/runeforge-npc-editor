import { describe, expect, it } from "vitest";
import { diffLines, diffSequences } from "./index";
import type { DiffOp } from "./index";

/** Rejoue le script d'edition : doit redonner `b` a partir de `a`. */
function apply<T>(a: readonly T[], b: readonly T[], ops: readonly DiffOp[]): T[] {
  const result: T[] = [];
  for (const op of ops) {
    if (op.type === "equal") {
      expect(a[op.a]).toEqual(b[op.b]);
      result.push(a[op.a] as T);
    } else if (op.type === "insert") {
      result.push(b[op.b] as T);
    }
  }
  return result;
}

function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i]![j] = a[i - 1] === b[j - 1] ? (table[i - 1]![j - 1] ?? 0) + 1 : Math.max(table[i - 1]![j] ?? 0, table[i]![j - 1] ?? 0);
    }
  }
  return table[a.length]![b.length] ?? 0;
}

describe("diffSequences", () => {
  it("retourne uniquement des 'equal' pour des sequences identiques", () => {
    const ops = diffSequences([1, 2, 3], [1, 2, 3]);
    expect(ops.every((op) => op.type === "equal")).toBe(true);
    expect(ops).toHaveLength(3);
  });

  it("gere les sequences vides", () => {
    expect(diffSequences([], [1, 2]).map((op) => op.type)).toEqual(["insert", "insert"]);
    expect(diffSequences([1, 2], []).map((op) => op.type)).toEqual(["delete", "delete"]);
    expect(diffSequences([], [])).toEqual([]);
  });

  it("decrit une modification au milieu", () => {
    const a = ["a", "b", "c", "d"];
    const b = ["a", "B", "c", "d"];
    const ops = diffSequences(a, b);
    expect(apply(a, b, ops)).toEqual(b);
    expect(ops.filter((op) => op.type === "delete")).toEqual([{ type: "delete", a: 1 }]);
    expect(ops.filter((op) => op.type === "insert")).toEqual([{ type: "insert", b: 1 }]);
  });

  it("produit un script minimal (longueur de la plus longue sous-sequence commune) sur des cas aleatoires", () => {
    let state = 12345;
    const random = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    for (let run = 0; run < 300; run += 1) {
      const a = Array.from({ length: Math.floor(random() * 14) }, () => Math.floor(random() * 4));
      const b = Array.from({ length: Math.floor(random() * 14) }, () => Math.floor(random() * 4));
      const ops = diffSequences(a, b);
      const equalCount = ops.filter((op) => op.type === "equal").length;
      expect(equalCount).toBe(lcsLength(a, b));
      expect(ops.filter((op) => op.type !== "insert").length).toBe(a.length);
      expect(ops.filter((op) => op.type !== "delete").length).toBe(b.length);
      expect(apply(a, b, ops)).toEqual(b);
    }
  });

  it("se replie sur 'tout supprimer puis tout inserer' au-dela du budget d'edits, sans perdre de donnees", () => {
    const a = Array.from({ length: 300 }, (_, index) => `a${index}`);
    const b = Array.from({ length: 300 }, (_, index) => `b${index}`);
    const ops = diffSequences(a, b, (x, y) => x === y, 10);
    expect(ops.filter((op) => op.type === "delete")).toHaveLength(300);
    expect(ops.filter((op) => op.type === "insert")).toHaveLength(300);
  });

  it("est rapide sur un grand texte avec peu de differences", () => {
    const a = Array.from({ length: 50_000 }, (_, index) => `ligne ${index}`);
    const b = [...a];
    b[25_000] = "modifiee";
    b.splice(40_000, 0, "inseree");
    const started = Date.now();
    const ops = diffSequences(a, b);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(ops.filter((op) => op.type !== "equal")).toHaveLength(3);
  });
});

describe("diffLines", () => {
  it("compare deux textes ligne a ligne", () => {
    const ops = diffLines("a\nb\nc", "a\nc\nd");
    expect(ops.filter((op) => op.type === "delete")).toEqual([{ type: "delete", a: 1 }]);
    expect(ops.filter((op) => op.type === "insert")).toEqual([{ type: "insert", b: 2 }]);
  });
});
