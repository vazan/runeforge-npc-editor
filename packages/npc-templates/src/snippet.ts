/**
 * Format « snippet » des modeles : celui de Monaco et de LSP. `${1:valeur}` est un champ a remplir (la valeur par defaut est
 * pre-selectionnee ; un meme numero plusieurs fois se remplit en une fois), `$0` la position finale du curseur, et `\$`, `\}`,
 * `\\` ecrivent le caractere lui-meme.
 */

const PLACEHOLDER = /^\$\{(\d+)(?::((?:[^}\\]|\\.)*))?\}/;
const TABSTOP = /^\$(\d+)/;

function unescape(text: string): string {
  return text.replace(/\\([$}\\])/g, "$1");
}

/** Le texte que produit le snippet quand l'utilisateur garde toutes les valeurs par defaut. */
export function expandSnippet(snippet: string): string {
  let output = "";
  let index = 0;
  while (index < snippet.length) {
    const char = snippet.charAt(index);
    if (char === "\\" && index + 1 < snippet.length && "$}\\".includes(snippet.charAt(index + 1))) {
      output += snippet.charAt(index + 1);
      index += 2;
      continue;
    }
    if (char === "$") {
      const rest = snippet.slice(index);
      const placeholder = PLACEHOLDER.exec(rest);
      if (placeholder !== null) {
        output += unescape(placeholder[2] ?? "");
        index += placeholder[0].length;
        continue;
      }
      const tabstop = TABSTOP.exec(rest);
      if (tabstop !== null) {
        index += tabstop[0].length;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
}

export interface SnippetField {
  /** Numero du champ (`1` pour `${1:...}`) ; `0` : position finale. */
  readonly index: number;
  readonly defaultValue: string;
}

/** Les champs d'un snippet, dans l'ordre d'apparition (un champ repete apparait chaque fois). */
export function snippetFields(snippet: string): SnippetField[] {
  const fields: SnippetField[] = [];
  let index = 0;
  while (index < snippet.length) {
    const char = snippet.charAt(index);
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "$") {
      const rest = snippet.slice(index);
      const placeholder = PLACEHOLDER.exec(rest);
      if (placeholder !== null) {
        fields.push({ index: Number(placeholder[1]), defaultValue: unescape(placeholder[2] ?? "") });
        index += placeholder[0].length;
        continue;
      }
      const tabstop = TABSTOP.exec(rest);
      if (tabstop !== null) {
        fields.push({ index: Number(tabstop[1]), defaultValue: "" });
        index += tabstop[0].length;
        continue;
      }
    }
    index += 1;
  }
  return fields;
}
