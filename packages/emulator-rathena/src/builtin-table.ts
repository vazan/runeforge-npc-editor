import { commandKey, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";

export interface BuiltinTableResult {
  readonly definitions: CommandDefinition[];
  /** Lignes mentionnant `BUILDIN_DEF` que la lecture n'a pas comprises (format inattendu), au format « ligne: texte ». */
  readonly unrecognized: string[];
  /** Commandes que le serveur lui-meme ignore parce que leur chaine d'arguments est invalide. */
  readonly invalid: string[];
  /** Noms definis plusieurs fois : le serveur garde la derniere definition. */
  readonly duplicates: string[];
}

const TABLE_START = /struct\s+script_function\s+buildin_func\s*\[\s*]\s*=\s*\{/;
const TABLE_END = /^\s*\{\s*nullptr\s*,\s*nullptr/;

const DEF = /\bBUILDIN_DEF\s*\(\s*(\w+)\s*,\s*"([^"]*)"\s*\)/;
const DEF2 = /\bBUILDIN_DEF2\s*\(\s*\w+\s*,\s*"(\w+)"\s*,\s*"([^"]*)"\s*\)/;
const DEF_DEPRECATED = /\bBUILDIN_DEF_DEPRECATED\s*\(\s*(\w+)\s*,\s*"([^"]*)"\s*,\s*"[^"]*"\s*\)/;
const DEF2_DEPRECATED = /\bBUILDIN_DEF2_DEPRECATED\s*\(\s*\w+\s*,\s*"(\w+)"\s*,\s*"([^"]*)"\s*,\s*"[^"]*"\s*\)/;

/** Retire les commentaires d'une ligne en suivant l'etat d'un commentaire bloc qui s'etend sur plusieurs lignes. */
function stripComments(line: string, state: { inBlock: boolean }): string {
  let output = "";
  let index = 0;
  while (index < line.length) {
    if (state.inBlock) {
      const close = line.indexOf("*/", index);
      if (close === -1) return output;
      state.inBlock = false;
      index = close + 2;
      continue;
    }
    const lineComment = line.indexOf("//", index);
    const blockComment = line.indexOf("/*", index);
    if (lineComment !== -1 && (blockComment === -1 || lineComment < blockComment)) return output + line.slice(index, lineComment);
    if (blockComment === -1) return output + line.slice(index);
    output += line.slice(index, blockComment);
    state.inBlock = true;
    index = blockComment + 2;
  }
  return output;
}

/**
 * Lit la table des commandes d'un serveur rAthena : `BUILDIN_DEF(nom, "arguments")`, `BUILDIN_DEF2(fonction, "nom", ...)`
 * et leurs variantes `_DEPRECATED`. Fonctionne sur `src/map/script.cpp` (la lecture commence apres
 * `struct script_function buildin_func[] = {` et s'arrete a `{nullptr,nullptr,nullptr}`) et sur un fragment sans table comme
 * `src/custom/script_def.inc`.
 *
 * C'est la source qui fait foi pour les noms et le nombre d'arguments : le serveur verifie ce nombre au chargement de chaque
 * script (`parse_callfunc`). Verifie sur le serveur local : 667 commandes, aucune ligne non comprise, aucun appel du jeu de
 * scripts charge ne contredit leur arite. Les commandes sous `#ifdef` sont marquees `conditional`.
 *
 * @param path Chemin du fichier lu, pour la provenance (« src/map/script.cpp:27763 »).
 */
export function parseBuiltinTable(text: string, path: string): BuiltinTableResult {
  const lines = text.split("\n");
  const marker = lines.findIndex((line) => TABLE_START.test(line));
  const first = marker === -1 ? 0 : marker + 1;
  const byKey = new Map<string, CommandDefinition>();
  const unrecognized: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const comments = { inBlock: false };
  let conditionalDepth = 0;

  for (let index = first; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (TABLE_END.test(raw)) break;
    const code = stripComments(raw, comments).trim();
    if (/^#\s*(if|ifdef|ifndef)\b/.test(code)) conditionalDepth += 1;
    else if (/^#\s*endif\b/.test(code)) conditionalDepth = Math.max(0, conditionalDepth - 1);
    if (!code.includes("BUILDIN_DEF")) continue;

    const deprecated = code.includes("_DEPRECATED");
    const match = DEF2_DEPRECATED.exec(code) ?? DEF_DEPRECATED.exec(code) ?? DEF2.exec(code) ?? DEF.exec(code);
    const name = match?.[1];
    const types = match?.[2];
    if (name === undefined || types === undefined) {
      unrecognized.push(`${index + 1}: ${raw.trim()}`);
      continue;
    }
    const arity = parseParameterTypes(types);
    if (arity === null) {
      invalid.push(`${name} "${types}" (${path}:${index + 1})`);
      continue;
    }
    const key = commandKey(name);
    if (byKey.has(key)) duplicates.push(name);
    byKey.set(key, {
      name,
      arity,
      parameterTypes: types,
      signatures: [],
      documentation: null,
      deprecated,
      conditional: conditionalDepth > 0,
      sources: [{ kind: "server-source", reference: `${path}:${index + 1}` }],
    });
  }
  return { definitions: [...byKey.values()], unrecognized, invalid, duplicates };
}
