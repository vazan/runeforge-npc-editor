import type { SimValue } from "./types";

/** Plus grand indice de tableau accepté (le serveur en autorise 2^31 ; la simulation reste petite). */
export const MAX_INDEX = 99_999;
/** Éléments conservés en tout, pour borner la mémoire d'un script qui remplit des tableaux. */
export const MAX_ENTRIES = 20_000;

export const isDefaultValue = (value: SimValue): boolean => value === 0 || value === "";

/**
 * Variables d'une portée. `x` et `x[0]` désignent le même élément ; un tableau est l'ensemble des éléments d'un même nom.
 * Comme sur le serveur, la taille d'un tableau est le plus grand indice **non nul** + 1.
 */
export class Store {
  private readonly arrays = new Map<string, Map<number, SimValue>>();
  private count = 0;

  get(base: string, index: number): SimValue | undefined {
    return this.arrays.get(base)?.get(index);
  }

  /** Faux si la limite d'éléments est atteinte (l'élément n'est alors pas écrit). */
  set(base: string, index: number, value: SimValue): boolean {
    let array = this.arrays.get(base);
    if (array === undefined) {
      array = new Map();
      this.arrays.set(base, array);
    }
    if (!array.has(index)) {
      if (this.count >= MAX_ENTRIES) return false;
      this.count += 1;
    }
    array.set(index, value);
    return true;
  }

  size(base: string): number {
    let size = 0;
    for (const [index, value] of this.arrays.get(base) ?? []) {
      if (!isDefaultValue(value) && index + 1 > size) size = index + 1;
    }
    return size;
  }

  /** `deletearray` : retire `count` éléments à partir de `from` et décale les suivants vers le début. */
  remove(base: string, from: number, count: number): void {
    const array = this.arrays.get(base);
    if (array === undefined) return;
    const next = new Map<number, SimValue>();
    for (const [index, value] of array) {
      if (index < from) next.set(index, value);
      else if (index >= from + count) next.set(index - count, value);
    }
    this.count += next.size - array.size;
    this.arrays.set(base, next);
  }

  /** Éléments à plat : `x` pour l'indice 0, `x[2]` sinon. Les éléments de valeur par défaut (indice > 0) n'existent pas. */
  entries(): Array<[string, SimValue]> {
    const out: Array<[string, SimValue]> = [];
    for (const [base, array] of this.arrays) {
      for (const index of [...array.keys()].sort((a, b) => a - b)) {
        const value = array.get(index) as SimValue;
        if (index > 0 && isDefaultValue(value)) continue;
        out.push([index === 0 ? base : `${base}[${index}]`, value]);
      }
    }
    return out;
  }
}
