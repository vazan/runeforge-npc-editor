/**
 * Lecture tolerante des bases YAML de rAthena (`db/**\/item_db_*.yml`, `mob_db.yml`, `const.yml`).
 *
 * Ces fichiers pesent des megaoctets (12 Mo pour les objets et les monstres du serveur local) mais ont tous la meme forme :
 * un en-tete (`Header:`), une liste d'entrees (`Body:`) dont chacune est une table de reglages, un pied (`Footer:`) qui
 * liste les fichiers importes. Pour referencer un objet ou un monstre il suffit de quelques champs de premier niveau de
 * chaque entree (`Id`, `AegisName`, `Name`...) : plutot que de construire l'arbre YAML complet, cette lecture parcourt
 * le texte ligne a ligne, par **indentation**, et ne retient que les champs demandes. Le contenu imbrique (`Script: |`,
 * `Drops:`, `Flags:`...) est saute sans etre lu.
 *
 * Ce n'est pas un analyseur YAML general : il comprend la forme que le serveur lit et que ses outils ecrivent (listes en
 * blocs, avec ou sans decalage, et tables en ligne `- {Id: 1, ...}`), et **compte ce qu'il n'a pas compris** au lieu de
 * l'inventer. `scripts/catalog-report.ts` le compare, sur les fichiers du serveur local, a un analyseur YAML complet.
 */

export interface YamlEntry {
  /** Ligne (base 1) de l'entree : celle de son `- `. */
  readonly line: number;
  /** Les champs demandes de premier niveau, sous forme de texte (sans guillemets ni commentaire). */
  readonly fields: Readonly<Record<string, string>>;
}

export interface YamlImport {
  /** Chemin relatif a la racine du serveur (`db/re/item_db.yml`). */
  readonly path: string;
  /** `Renewal` ou `Prerenewal` quand l'import est reserve a un mode de compilation. */
  readonly mode: string | null;
  /** Import de generateur d'outils : jamais charge par le serveur en fonctionnement normal. */
  readonly generator: boolean;
}

export interface YamlDatabaseInfo {
  readonly type: string | null;
  readonly version: number | null;
  /** `Header: Clear: true` : les entrees deja lues sont oubliees. */
  readonly clear: boolean;
  readonly imports: readonly YamlImport[];
  /** Entrees du corps rencontrees (comprises ou non). */
  readonly entries: number;
  /** Premieres lignes (base 1) du corps que la lecture n'a pas comprises. */
  readonly unreadable: readonly number[];
}

type Section = "none" | "header" | "body" | "footer" | "other";

const MAX_UNREADABLE = 20;
const SPACE = 32;
const TAB = 9;
const HASH = 35;
const DASH = 45;

const unescapeDouble = (char: string): string => {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "0":
      return "\0";
    default:
      return char;
  }
};

/** Valeur d'un scalaire YAML : sans guillemets (les echappements `\"` et `''` sont resolus), sans commentaire de fin. */
function scalar(raw: string): string {
  const value = raw.trim();
  const first = value.charAt(0);
  if (first === '"') {
    let out = "";
    for (let i = 1; i < value.length; i += 1) {
      const char = value.charAt(i);
      if (char === "\\") {
        out += unescapeDouble(value.charAt(i + 1));
        i += 1;
      } else if (char === '"') {
        break;
      } else {
        out += char;
      }
    }
    return out;
  }
  if (first === "'") {
    let out = "";
    for (let i = 1; i < value.length; i += 1) {
      const char = value.charAt(i);
      if (char === "'") {
        if (value.charAt(i + 1) === "'") {
          out += "'";
          i += 1;
        } else {
          break;
        }
      } else {
        out += char;
      }
    }
    return out;
  }
  // Scalaire de bloc (`|`, `>`) : le texte est sur les lignes suivantes, qui ne sont pas lues.
  if (first === "|" || first === ">") return "";
  const hash = value.search(/\s#/);
  return hash === -1 ? value : value.slice(0, hash).trimEnd();
}

/** `Cle: valeur` dans `text[from, end)` ; `null` si la ligne n'a pas cette forme. */
function keyValue(text: string, from: number, end: number): { key: string; raw: string } | null {
  let colon = from;
  // Premier « : » suivi d'un espace (ou de la fin de ligne) : un « : » colle au texte fait partie de la cle ou de la valeur.
  for (;;) {
    colon = text.indexOf(":", colon);
    if (colon === -1 || colon >= end) return null;
    const after = colon + 1 < end ? text.charCodeAt(colon + 1) : SPACE;
    if (after === SPACE || after === TAB) break;
    colon += 1;
  }
  let key = text.slice(from, colon).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  return key === "" ? null : { key, raw: text.slice(colon + 1, end) };
}

/** Table en ligne `{Id: 1, Name: "A, B"}` : les champs demandes, ou `null` si elle n'est pas fermee sur la ligne. */
function flowMapping(source: string, wanted: ReadonlySet<string>): Record<string, string> | null {
  if (!source.startsWith("{")) return null;
  const fields: Record<string, string> = {};
  let depth = 0;
  let quote = "";
  let partStart = 1;
  const takePart = (end: number): void => {
    const pair = keyValue(source, partStart, end);
    if (pair !== null && wanted.has(pair.key)) fields[pair.key] = scalar(pair.raw);
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (quote !== "") {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        takePart(i);
        return fields;
      }
    } else if (char === "," && depth === 1) {
      takePart(i);
      partStart = i + 1;
    }
  }
  return null;
}

/**
 * Parcourt une base YAML et appelle `onEntry` pour chaque entree du corps, dans l'ordre, avec les champs de `wanted`.
 * Retourne l'en-tete, les imports du pied et ce qui n'a pas ete compris.
 */
export function scanYamlDatabase(text: string, wanted: ReadonlySet<string>, onEntry: (entry: YamlEntry) => void): YamlDatabaseInfo {
  let section: Section = "none";
  let type: string | null = null;
  let version: number | null = null;
  let clear = false;
  const imports: YamlImport[] = [];
  let entries = 0;
  const unreadable: number[] = [];
  const markUnreadable = (line: number): void => {
    if (unreadable.length < MAX_UNREADABLE) unreadable.push(line);
  };

  // Corps.
  let itemIndent = -1;
  let keyIndent = 0;
  let current: Record<string, string> | null = null;
  let currentLine = 0;
  const flush = (): void => {
    if (current !== null) onEntry({ line: currentLine, fields: current });
    current = null;
  };

  // Pied.
  let inImports = false;
  let pendingIndent = -1;
  let pending: { path: string | null; mode: string | null; generator: boolean } | null = null;
  const flushImport = (): void => {
    if (pending !== null && pending.path !== null) imports.push({ path: pending.path, mode: pending.mode, generator: pending.generator });
    pending = null;
  };
  const readImportKey = (from: number, end: number): void => {
    const pair = keyValue(text, from, end);
    if (pair === null || pending === null) return;
    const value = scalar(pair.raw);
    if (pair.key === "Path") pending.path = value;
    else if (pair.key === "Mode") pending.mode = value;
    else if (pair.key === "Generator") pending.generator = value.toLowerCase() === "true";
  };

  const length = text.length;
  let position = 0;
  let lineNumber = 0;
  while (position <= length) {
    lineNumber += 1;
    let lineEnd = text.indexOf("\n", position);
    const nextPosition = lineEnd === -1 ? length + 1 : lineEnd + 1;
    if (lineEnd === -1) lineEnd = length;
    let end = lineEnd;
    if (end > position && text.charCodeAt(end - 1) === 13) end -= 1;
    let start = position;
    while (start < end && text.charCodeAt(start) === SPACE) start += 1;
    const indent = start - position;
    position = nextPosition;
    if (start >= end || text.charCodeAt(start) === HASH) continue;

    const isDash = text.charCodeAt(start) === DASH && (start + 1 >= end || text.charCodeAt(start + 1) === SPACE);

    // Cle de premier niveau : change de section.
    if (indent === 0 && !isDash) {
      if (text.startsWith("---", start) || text.startsWith("...", start)) continue;
      const pair = keyValue(text, start, end);
      if (pair === null) continue;
      flush();
      flushImport();
      inImports = false;
      itemIndent = -1;
      if (pair.key === "Header") section = "header";
      else if (pair.key === "Body") section = "body";
      else if (pair.key === "Footer") section = "footer";
      else section = "other";
      continue;
    }

    switch (section) {
      case "header": {
        const pair = keyValue(text, start, end);
        if (pair === null) break;
        if (pair.key === "Type") type = scalar(pair.raw);
        else if (pair.key === "Version") {
          const number = Number(scalar(pair.raw));
          version = Number.isInteger(number) ? number : null;
        } else if (pair.key === "Clear") clear = scalar(pair.raw).toLowerCase() === "true";
        break;
      }
      case "footer": {
        if (!inImports) {
          const pair = keyValue(text, start, end);
          if (pair !== null && pair.key === "Imports") inImports = true;
          break;
        }
        if (isDash) {
          if (pendingIndent === -1 || indent <= pendingIndent) {
            flushImport();
            pendingIndent = indent;
            pending = { path: null, mode: null, generator: false };
            let inner = start + 1;
            while (inner < end && text.charCodeAt(inner) === SPACE) inner += 1;
            readImportKey(inner, end);
          }
        } else if (indent > pendingIndent) {
          readImportKey(start, end);
        } else {
          flushImport();
          inImports = false;
          pendingIndent = -1;
        }
        break;
      }
      case "body": {
        if (isDash) {
          if (itemIndent === -1) itemIndent = indent;
          if (indent > itemIndent) break; // liste imbriquee dans l'entree courante
          itemIndent = indent;
          flush();
          entries += 1;
          currentLine = lineNumber;
          let inner = start + 1;
          while (inner < end && text.charCodeAt(inner) === SPACE) inner += 1;
          keyIndent = indent + (inner - start);
          if (text.charCodeAt(inner) === 123 /* { */) {
            // Table en ligne : tout doit tenir sur la ligne, sinon elle n'est pas comprise.
            const flow = flowMapping(text.slice(inner, end), wanted);
            if (flow === null) markUnreadable(lineNumber);
            else onEntry({ line: lineNumber, fields: flow });
            current = null;
            break;
          }
          const pair = keyValue(text, inner, end);
          if (pair === null) {
            markUnreadable(lineNumber);
            current = null;
            break;
          }
          current = {};
          if (wanted.has(pair.key)) current[pair.key] = scalar(pair.raw);
          break;
        }
        if (current !== null && indent === keyIndent) {
          const pair = keyValue(text, start, end);
          if (pair !== null && wanted.has(pair.key)) current[pair.key] = scalar(pair.raw);
        }
        break;
      }
      default:
        break;
    }
  }
  flush();
  flushImport();
  return { type, version, clear, imports, entries, unreadable };
}

/** Taille de la fin d'un fichier dans laquelle chercher son pied (`Footer:`), pour ne pas decoder un fichier de 6 Mo entier. */
export const FOOTER_WINDOW_BYTES = 16 * 1024;

/**
 * Imports du pied d'une base, a partir de la **fin** de son texte (au moins le pied) : le chemin des fichiers d'un serveur se
 * decouvre ainsi sans lire les entrees. Sans pied dans le texte donne, aucun import.
 */
export function footerImports(tail: string): readonly YamlImport[] {
  return scanYamlDatabase(tail, new Set(), () => undefined).imports;
}
