import { commandKey } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";

export interface CommandDocResult {
  readonly definitions: CommandDefinition[];
  /** Titres qui decrivent un mot-cle du langage (`if`, `for`...) et non une commande : ils ne sont pas importes. */
  readonly skipped: string[];
}

/** Mots-cles traites par l'analyseur du langage, jamais des commandes. */
const LANGUAGE_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "function",
]);

/** `*nom`, puis une espace, `(`, `;`, `{` ou la fin de ligne (`*Notes:` ou `*_SIZE` ne sont pas des titres). */
const HEADING = /^\*([A-Za-z_][A-Za-z0-9_]*)(?=$|[\s(;{])/;
/** Cadre d'un titre de section : `=====` ou `|1.- Commandes de base.|`. */
const SECTION_BORDER = /^(={5,}|\|\d+(\.\d+)*\.-.*\|)\s*$/;

interface Entry {
  readonly name: string;
  readonly signatures: string[];
  readonly firstLine: number;
  /** Offset (dans le texte) du debut de l'aide : ligne qui suit le dernier titre consecutif. */
  helpStart: number;
  helpEnd: number;
}

/**
 * Lit le manuel des commandes de script d'un serveur (`doc/script_commands.txt`) : chaque titre `*commande <arguments>;`
 * donne un nom et une signature lisible, le texte qui suit jusqu'au titre suivant en est l'aide.
 *
 * La documentation sert aux signatures et a l'aide, **pas a l'arite** : elle est ecrite pour les humains. Sur le jeu de
 * scripts du serveur local, deduire l'arite des titres produirait 2 329 fausses alertes (`initnpctimer` sans argument y est
 * documente avec 1 a 3 arguments) ; elle manque aussi deux commandes valides (`warpchar`, `needed_trait_point`). Le registre
 * l'utilise donc comme complement de la table du serveur, et comme seule source de noms si le code source est absent.
 *
 * Le parseur est utilise pour generer la bibliotheque integree ; l'application ne lit pas ce manuel a l'execution.
 *
 * @param path Chemin du fichier lu, pour la provenance.
 */
export function parseCommandDoc(text: string, path: string): CommandDocResult {
  const lines = text.split("\n");
  const entries = new Map<string, Entry>();
  const skipped: string[] = [];
  const hasSections = lines.some((line) => /^\|\d+(\.\d+)*\.-.*\|\s*$/.test(line));

  let offset = 0;
  let inCommands = !hasSections;
  let current: Entry | null = null;
  let previousWasHeading = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;

    if (SECTION_BORDER.test(clean)) {
      if (/^\|/.test(clean)) inCommands = true;
      if (current !== null) current.helpEnd = lineStart;
      current = null;
      previousWasHeading = false;
      continue;
    }
    if (!inCommands) continue;

    const heading = HEADING.exec(clean);
    if (heading !== null) {
      const name = heading[1] ?? "";
      // Signature lisible : le titre sans l'asterisque (`mes "<string>"{,"<string>"};`).
      const signature = clean.slice(1).trim();
      if (LANGUAGE_KEYWORDS.has(commandKey(name))) {
        skipped.push(name);
        if (current !== null) current.helpEnd = lineStart;
        current = null;
        previousWasHeading = true;
        continue;
      }
      const key = commandKey(name);
      if (previousWasHeading && current !== null && commandKey(current.name) === key) {
        // Titres consecutifs d'une meme commande : plusieurs signatures, une seule aide.
        current.signatures.push(signature);
        current.helpStart = lineEnd + 1;
        current.helpEnd = lineEnd + 1;
      } else {
        if (current !== null) current.helpEnd = lineStart;
        const existing = entries.get(key);
        if (existing !== undefined) {
          // Commande documentee a plusieurs endroits : la premiere aide est conservee, les signatures s'additionnent.
          existing.signatures.push(signature);
          current = null;
        } else {
          current = { name, signatures: [signature], firstLine: index + 1, helpStart: lineEnd + 1, helpEnd: lineEnd + 1 };
          entries.set(key, current);
        }
      }
      previousWasHeading = true;
      continue;
    }
    previousWasHeading = false;
    if (current !== null) current.helpEnd = lineEnd;
  }

  const definitions: CommandDefinition[] = [];
  for (const entry of entries.values()) {
    const help = text.slice(entry.helpStart, Math.max(entry.helpStart, entry.helpEnd)).trim();
    definitions.push({
      name: entry.name,
      arity: null,
      parameterTypes: null,
      signatures: entry.signatures,
      documentation: help === "" ? null : help,
      deprecated: false,
      conditional: false,
      sources: [{ kind: "server-doc", reference: `${path}:${entry.firstLine}` }],
    });
  }
  return { definitions, skipped };
}
