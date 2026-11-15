import { walk } from "@runeforge/runescript-parser";
import type { AstNode } from "@runeforge/runescript-parser";
import type { FunctionSource } from "./types";

/** Fonctions cherchées au plus pour un même script : borne le travail d'un code qui en appelle beaucoup. */
const MAX_LOOKUPS = 150;

/** Fonction globale d'après son nom : l'index du projet, par exemple. `undefined` si elle n'est connue nulle part. */
export type FunctionLookup = (name: string) => Promise<FunctionSource | undefined> | FunctionSource | undefined;

/** Noms des fonctions globales que `callfunc "nom"` appelle dans ce code : seuls les noms écrits en toutes lettres sont connus. */
export function calledFunctions(root: AstNode): Set<string> {
  const names = new Set<string>();
  walk(root, (node) => {
    const args = node.kind === "CommandStatement" && node.name.toLowerCase() === "callfunc"
      ? node.args
      : node.kind === "Call" && node.callee.toLowerCase() === "callfunc"
        ? node.args
        : undefined;
    const first = args?.[0];
    if (first?.kind === "StringLiteral" && first.value !== "") names.add(first.value);
  });
  return names;
}

/**
 * Les fonctions globales que ce code appelle, directement ou par d'autres fonctions : celles de `known` (le fichier du NPC) et
 * celles que `lookup` trouve ailleurs dans le projet. Une fonction que `lookup` ne trouve pas reste inconnue : son appel est
 * noté « non simulé » pendant la simulation.
 */
export async function resolveFunctions(
  roots: readonly AstNode[],
  known: ReadonlyMap<string, FunctionSource>,
  lookup: FunctionLookup,
): Promise<Map<string, FunctionSource>> {
  const functions = new Map(known);
  const examined = new Set<string>();
  const pending: AstNode[] = [...roots];
  let lookups = 0;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const name of calledFunctions(node)) {
      const key = name.toLowerCase();
      if (examined.has(key)) continue;
      examined.add(key);
      let found = functions.get(key);
      if (found === undefined) {
        if (lookups >= MAX_LOOKUPS) continue;
        lookups += 1;
        found = await lookup(name);
        if (found === undefined) continue;
        functions.set(key, found);
      }
      if (found.declaration.body !== null) pending.push(found.declaration.body);
    }
  }
  return functions;
}
