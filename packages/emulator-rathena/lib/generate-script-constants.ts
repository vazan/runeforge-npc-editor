/**
 * Valeurs des constantes de script rAthena (`Job_Knight`, `Sex_Male`, `DT_Hour`...).
 *
 * `src/map/script_constants.hpp` ne donne que des noms (`export_constant(JOB_KNIGHT);`) : la valeur est celle du symbole C++,
 * une énumération d'un en-tête du serveur. Ce générateur lit les énumérations et les `#define` numériques de `src/**.hpp`,
 * évalue les expressions entières simples (littéraux, `|`, `<<`, `+`, symboles déjà connus...), puis ne retient que les
 * symboles réellement exportés vers les scripts. Un symbole dont la valeur n'est pas établie avec certitude (expression
 * non reconnue, nom défini deux fois avec des valeurs différentes) est écarté : une constante absente est signalée par le
 * simulateur, une valeur inventée ne le serait jamais.
 *
 * Le même passage écrit aussi `src/job-classes-values.ts` : le nom de chaque classe, tel que le serveur le donne (`job_name()` de
 * `src/map/pc.cpp`, ce que renvoie la commande de script `jobname()`), dont la liste de la fenêtre de simulation se sert à la
 * place d'un identifiant de classe. Chaque `case JOB_...:` de `job_name()` est évalué avec la valeur du symbole, le numéro de
 * message obtenu est cherché dans `conf/msg_conf/map_msg.conf`.
 *
 * Usage : pnpm exec tsx packages/emulator-rathena/lib/generate-script-constants.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(packageDirectory, "../../../..");
const serverDirectory = resolve(repositoryDirectory, "Serveur/rathena-kov");
const outputPath = resolve(packageDirectory, "../src/script-constants-values.ts");
const jobsOutputPath = resolve(packageDirectory, "../src/job-classes-values.ts");

function headers(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...headers(path));
    else if (/\.(hpp|h)$/i.test(entry.name)) found.push(path);
  }
  return found;
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");

// --- Évaluateur d'expressions entières C++ (BigInt) -----------------------------------------------------------------

type Lookup = (name: string) => bigint | undefined;

/** `undefined` si l'expression contient autre chose que ce que l'évaluateur sait calculer. */
function evaluate(expression: string, lookup: Lookup): bigint | undefined {
  const found = expression.match(/0[xX][0-9a-fA-F]+[uUlL]*|\d+[uUlL]*|[A-Za-z_]\w*|<<|>>|[-+*/%|&^~()]/g);
  if (found === null || found.join("").length !== expression.replace(/\s+/g, "").length) return undefined;
  const tokens: readonly string[] = found;
  let position = 0;
  let failed = false;
  const fail = (): bigint => {
    failed = true;
    return 0n;
  };
  function primary(): bigint {
    const token = tokens[position++];
    if (token === undefined) return fail();
    if (token === "(") {
      const value = bitOr();
      if (tokens[position++] !== ")") return fail();
      return value;
    }
    if (token === "-") return -primary();
    if (token === "+") return primary();
    if (token === "~") return ~primary();
    if (/^\d/.test(token)) return BigInt(token.replace(/[uUlL]+$/, ""));
    if (/^[A-Za-z_]/.test(token)) return lookup(token) ?? fail();
    return fail();
  }
  /** Niveau de priorité binaire : `next` est le niveau plus fort, `apply` calcule l'opération (ou échoue). */
  const level = (next: () => bigint, operators: readonly string[], apply: (operator: string, left: bigint, right: bigint) => bigint | undefined) => (): bigint => {
    let value = next();
    while (position < tokens.length && operators.includes(tokens[position] as string)) {
      const operator = tokens[position++] as string;
      const result = apply(operator, value, next());
      if (result === undefined) return fail();
      value = result;
    }
    return value;
  };
  const product = level(primary, ["*", "/", "%"], (operator, left, right) =>
    operator === "*" ? left * right : right === 0n ? undefined : operator === "/" ? left / right : left % right);
  const sum = level(product, ["+", "-"], (operator, left, right) => (operator === "+" ? left + right : left - right));
  const shift = level(sum, ["<<", ">>"], (operator, left, right) =>
    right < 0n || right > 62n ? undefined : operator === "<<" ? left << right : left >> right);
  const bitAnd = level(shift, ["&"], (_operator, left, right) => left & right);
  const bitXor = level(bitAnd, ["^"], (_operator, left, right) => left ^ right);
  const bitOr = level(bitXor, ["|"], (_operator, left, right) => left | right);
  const result = bitOr();
  return failed || position !== tokens.length ? undefined : result;
}

// --- Symboles C++ : énumérations et #define numériques ---------------------------------------------------------------

interface EnumBody {
  readonly file: string;
  readonly items: readonly { readonly name: string; readonly expression: string | null }[];
}

const enums: EnumBody[] = [];
const defines: { readonly name: string; readonly expression: string }[] = [];

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

for (const path of headers(join(serverDirectory, "src"))) {
  const text = stripComments(readFileSync(path, "latin1"));
  const file = relative(serverDirectory, path).replaceAll("\\", "/");
  for (const match of text.matchAll(/\benum\s+(?:class\s+)?(?:\w+\s*)?(?::\s*[\w\s]+?)?\s*\{([^{}]*)\}/g)) {
    const items: { name: string; expression: string | null }[] = [];
    for (const part of splitTopLevel(match[1] ?? "")) {
      const item = /^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(part);
      if (item === null) {
        items.length = 0;
        break;
      }
      items.push({ name: item[1] as string, expression: item[2]?.trim() ?? null });
    }
    if (items.length > 0) enums.push({ file, items });
  }
  for (const match of text.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+([^\n]+)$/gm)) {
    defines.push({ name: match[1] as string, expression: (match[2] ?? "").trim() });
  }
}

// Symboles du compilateur et mots-clés C++ que le serveur exporte tels quels (`<climits>`, `true`, `false`).
const values = new Map<string, bigint>([
  ["INT_MIN", -2147483648n],
  ["INT_MAX", 2147483647n],
  ["true", 1n],
  ["false", 0n],
]);
const conflicts = new Set<string>();
const define = (name: string, value: bigint): boolean => {
  const known = values.get(name);
  if (known === undefined) {
    if (conflicts.has(name)) return false;
    values.set(name, value);
    return true;
  }
  if (known !== value) {
    values.delete(name);
    conflicts.add(name);
  }
  return false;
};
const lookup: Lookup = (name) => values.get(name);

// Plusieurs passes : une énumération peut dépendre d'un symbole d'un autre en-tête.
for (let pass = 0; pass < 12; pass += 1) {
  let progress = false;
  for (const body of enums) {
    // Un énumérateur sans valeur vaut le précédent + 1, et 0 pour le premier (une valeur inconnue rend inconnus les suivants).
    let previous: bigint | undefined = -1n;
    for (const item of body.items) {
      let value: bigint | undefined;
      if (item.expression === null) value = previous === undefined ? undefined : previous + 1n;
      else value = evaluate(item.expression, lookup);
      previous = value;
      if (value !== undefined && define(item.name, value)) progress = true;
    }
  }
  for (const entry of defines) {
    const value = evaluate(entry.expression, lookup);
    if (value !== undefined && define(entry.name, value)) progress = true;
  }
  if (!progress) break;
}

// --- Noms exportés vers les scripts -------------------------------------------------------------------------------

const exported = stripComments(readFileSync(join(serverDirectory, "src/map/script_constants.hpp"), "latin1"));
const npcOffset = /#define\s+export_constant_npc\(\s*a\s*\)\s+export_constant_offset\(\s*a\s*,\s*(\d+)\s*\)/.exec(exported)?.[1];
const result = new Map<string, bigint>();
let exportedCount = 0;
let unresolved = 0;
const missing: string[] = [];
const add = (scriptName: string, expression: string): void => {
  exportedCount += 1;
  const value = evaluate(expression, lookup);
  if (value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    unresolved += 1;
    missing.push(scriptName);
    return;
  }
  result.set(scriptName.toLowerCase(), value);
};
for (const line of exported.split("\n")) {
  let match: RegExpExecArray | null;
  if ((match = /^\s*export_(?:deprecated_)?constant\(\s*([A-Za-z_]\w*)\s*\)/.exec(line)) !== null) add(match[1] as string, match[1] as string);
  else if ((match = /^\s*export_(?:deprecated_)?constant[23]\(\s*"([^"]+)"\s*,\s*([^;]*?)\s*(?:,[^;]*)?\)\s*;/.exec(line)) !== null) add(match[1] as string, match[2] as string);
  else if (npcOffset !== undefined && (match = /^\s*export_constant_npc\(\s*([A-Za-z_]\w*)\s*\)/.exec(line)) !== null) {
    add((match[1] as string).slice(Number(npcOffset)), match[1] as string);
  }
}

const ordered = [...result.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const output = `/*
 * Généré par \`pnpm exec tsx packages/emulator-rathena/lib/generate-script-constants.ts\`.
 * Sources : \`src/map/script_constants.hpp\` (noms exportés) et les énumérations des en-têtes de \`src/\` de rAthena (valeurs).
 * Ces valeurs viennent de code GPL-3.0-only ; ce fichier est distribué sous la même licence (voir \`../../../LICENSE\`).
 * Seules les constantes dont la valeur est établie sans ambiguïté sont écrites : ${ordered.length} sur ${exportedCount} exportées.
 */

export const RATHENA_SCRIPT_CONSTANTS_INFO = {
  source: "rathena-kov",
  exported: ${exportedCount},
  resolved: ${ordered.length},
  license: "GPL-3.0-only",
} as const;

/** Nom en minuscules (les identifiants du langage ignorent la casse) → valeur. */
export const RATHENA_SCRIPT_CONSTANTS: ReadonlyMap<string, number> = /* @__PURE__ */ new Map<string, number>([
${ordered.map(([name, value]) => `  [${JSON.stringify(name)}, ${value}],`).join("\n")}
]);
`;
writeFileSync(outputPath, output);
console.log(`${exportedCount} constantes exportées, ${ordered.length} avec une valeur établie, ${unresolved} sans (écartées), ${conflicts.size} noms ambigus ; ${output.length} octets.`);
if (process.argv.includes("--verbose")) {
  console.log(`Noms ambigus : ${[...conflicts].sort().join(" ")}`);
  console.log(`Sans valeur : ${missing.join(" ")}`);
}

// --- Noms de classe (`job_name()`) --------------------------------------------------------------------------------------

/** Messages du serveur (`conf/msg_conf/map_msg.conf`, lignes « 557: Knight »). */
const messages = new Map<number, string>();
for (const line of readFileSync(join(serverDirectory, "conf/msg_conf/map_msg.conf"), "latin1").split(/\r?\n/)) {
  const found = /^(\d+):\s?(.*)$/.exec(line);
  if (found !== null) messages.set(Number(found[1]), (found[2] ?? "").trim());
}

const pc = stripComments(readFileSync(join(serverDirectory, "src/map/pc.cpp"), "latin1"));
const jobNameStart = pc.indexOf("const char* job_name(int32 class_)");
const jobNameEnd = pc.indexOf("default:", jobNameStart);
if (jobNameStart < 0 || jobNameEnd < 0) throw new Error("job_name() est introuvable dans src/map/pc.cpp");
const jobNameBody = pc.slice(jobNameStart, jobNameEnd);

/** Identifiant de classe → nom, pour chaque `case` de `job_name()` dont l'identifiant et le message sont établis. */
const namesById = new Map<number, string>();
let jobCases = 0;
let jobUnresolved = 0;
for (const group of jobNameBody.matchAll(/((?:\s*case\s+[A-Za-z_]\w*\s*:)+)\s*return\s+msg_txt\(\s*nullptr\s*,\s*([^;]*?)\s*\)\s*;/g)) {
  for (const label of (group[1] ?? "").matchAll(/case\s+([A-Za-z_]\w*)\s*:/g)) {
    jobCases += 1;
    const id = values.get(label[1] as string);
    // `msg_txt(nullptr, 550 - JOB_NOVICE + class_)` : le numéro du message dépend de l'identifiant (`class_`) du `case`.
    const message = id === undefined ? undefined : evaluate(group[2] ?? "", (name) => (name === "class_" ? id : values.get(name)));
    const text = message === undefined ? undefined : messages.get(Number(message));
    if (id === undefined || text === undefined || text === "") jobUnresolved += 1;
    else namesById.set(Number(id), text);
  }
}

// Une monture ou un costume (`JOB_KNIGHT2`, `JOB_SUMMER2`) porte le nom de la classe d'origine : une seule ligne, le plus petit identifiant.
const lowestIdByName = new Map<string, number>();
for (const [id, name] of namesById) {
  const known = lowestIdByName.get(name);
  if (known === undefined || id < known) lowestIdByName.set(name, id);
}
const classes = [...lowestIdByName].map(([name, id]) => ({ id, name })).sort((a, b) => a.id - b.id);

const jobsOutput = `/*
 * Généré par \`pnpm exec tsx packages/emulator-rathena/lib/generate-script-constants.ts\`.
 * Sources : \`job_name()\` de \`src/map/pc.cpp\` (identifiant → numéro de message) et \`conf/msg_conf/map_msg.conf\` (texte) de rAthena.
 * Ces noms viennent de code et de données GPL-3.0-only ; ce fichier est distribué sous la même licence (voir \`../../../LICENSE\`).
 */

/** Une classe : son identifiant (la valeur de \`Class\` dans un script) et son nom, tel que \`jobname()\` le renvoie. */
export interface JobClass {
  readonly id: number;
  readonly name: string;
}

export const RATHENA_JOB_CLASSES_INFO = {
  source: "rathena-kov",
  /** Identifiants que \`job_name()\` nomme. */
  named: ${namesById.size},
  /** Classes distinctes : une monture ou un costume du même nom que la classe d'origine n'a pas de ligne à part. */
  classes: ${classes.length},
  license: "GPL-3.0-only",
} as const;

/** Par identifiant croissant. */
export const RATHENA_JOB_CLASSES: readonly JobClass[] = [
${classes.map((entry) => `  { id: ${entry.id}, name: ${JSON.stringify(entry.name)} },`).join("\n")}
];
`;
writeFileSync(jobsOutputPath, jobsOutput);
console.log(`${jobCases} case de job_name(), ${namesById.size} identifiants nommés (${jobUnresolved} sans nom établi), ${classes.length} classes distinctes ; ${jobsOutput.length} octets.`);
