import type { TemplateEmulator } from "./templates";

/**
 * Assistants de NPC (RF-017, CLAUDE.md 10.2) : un formulaire typé, validé champ par champ, qui produit un script.
 *
 *   saisie typée → validation des champs → script généré (déterministe) → analyse et diagnostics → aperçu → enregistrement explicite
 *
 * Ce module est la partie « saisie → script » : pur (aucune lecture de fichier, aucun accès à l'éditeur), il ne connaît ni React ni
 * Tauri. L'analyse du script produit et l'aperçu sont faits par l'application avec le service de langage. Chaque assistant n'est
 * proposé que pour les émulateurs sur lesquels il est vérifié (`scripts/wizards-report.ts` confronte les scripts générés au registre
 * et aux bases d'un vrai serveur) ; la syntaxe est celle des déclarations rAthena (`npc_parse_warp`, `npc_parse_shop`,
 * `npc_parse_script`, lues dans le code du serveur local).
 *
 * Toute valeur est une chaîne (la saisie de l'utilisateur) : la validation dit ce qui ne va pas, la génération suppose qu'elle n'a
 * trouvé aucune erreur.
 */

export type WizardId = "warp-portal" | "warp-npc" | "shop" | "healer";

export type WizardFieldKind = "text" | "longText" | "integer" | "map" | "sprite" | "direction" | "items";

export interface WizardField {
  readonly key: string;
  readonly kind: WizardFieldKind;
  /** Valeur initiale. L'interface peut proposer des textes dans la langue de l'utilisateur pour les champs `text`/`longText`. */
  readonly initial: string;
  readonly required: boolean;
  /** Bornes d'un entier (incluses). */
  readonly min?: number;
  readonly max?: number;
  /** Longueur maximale d'un texte. */
  readonly maxLength?: number;
}

export type WizardValues = Readonly<Record<string, string>>;

/** Ce que la validation reproche à un champ ; `code` identifie le message (l'interface le traduit) et `params` ses valeurs. */
export type WizardProblemCode =
  | "required"
  | "notInteger"
  | "outOfRange"
  | "tooLong"
  | "badCharacters"
  | "badMap"
  | "badSprite"
  | "badItemLine"
  | "itemIdRange"
  | "priceRange"
  | "priceFree"
  | "priceHigh"
  | "itemDuplicate"
  | "itemsRequired"
  | "colon"
  | "displayNameLong";

export interface WizardProblem {
  readonly field: string;
  readonly severity: "error" | "warning";
  readonly code: WizardProblemCode;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface WizardDefinition {
  readonly id: WizardId;
  /** Émulateurs sur lesquels l'assistant est vérifié. */
  readonly emulators: readonly TemplateEmulator[];
  readonly fields: readonly WizardField[];
}

/** Plafond habituel des zénys d'un serveur ; au-delà, un prix est suspect (le serveur local accepte jusqu'à `INT_MAX`). */
export const PRICE_WARNING_THRESHOLD = 1_000_000_000;
/** Un prix tient dans un entier signé de 32 bits (`%11d` du serveur). */
export const PRICE_MAX = 2_147_483_647;
export const ITEM_ID_MAX = 4_294_967_295;
/** `NPC_NAME_LENGTH` et `NAME_LENGTH - 1` du serveur local. */
export const NPC_NAME_MAX = 50;
export const NPC_DISPLAY_NAME_MAX = 23;

// ---------------------------------------------------------------------------------------------------------------------------
// Champs
// ---------------------------------------------------------------------------------------------------------------------------

const SINGLE_LINE = /^[^\t\r\n]*$/;
const MAP_NAME = /^[A-Za-z0-9_@#]{1,11}$/;
/** Un identifiant numérique, `-1`, ou un nom de sprite (`4_M_01`, `HIDDEN_NPC`) : des mots de serveur (`[A-Za-z0-9_]`). */
const SPRITE = /^(?:-1|[A-Za-z0-9_]+)$/;
const INTEGER = /^-?\d+$/;

const location = (name: string): readonly WizardField[] => [
  { key: "name", kind: "text", initial: name, required: true, maxLength: NPC_NAME_MAX },
  { key: "map", kind: "map", initial: "prontera", required: true },
  { key: "x", kind: "integer", initial: "155", required: true, min: 0, max: 511 },
  { key: "y", kind: "integer", initial: "180", required: true, min: 0, max: 511 },
  { key: "facing", kind: "direction", initial: "4", required: true, min: 0, max: 7 },
];

const sprite = (initial: string): WizardField => ({ key: "sprite", kind: "sprite", initial, required: true });
const text = (key: string, initial: string, maxLength = 200, required = true): WizardField => ({ key, kind: "text", initial, required, maxLength });
const integer = (key: string, initial: string, min: number, max: number, required = true): WizardField => ({ key, kind: "integer", initial, required, min, max });

export const NPC_WIZARDS: readonly WizardDefinition[] = [
  {
    id: "warp-portal",
    emulators: ["rathena"],
    fields: [
      ...location("warp_to_geffen").map((field) => (field.key === "facing" ? { ...field, initial: "0" } : field)),
      integer("areaX", "2", 0, 100),
      integer("areaY", "2", 0, 100),
      { key: "destMap", kind: "map", initial: "geffen", required: true },
      integer("destX", "120", 0, 511),
      integer("destY", "60", 0, 511),
    ],
  },
  {
    id: "warp-npc",
    emulators: ["rathena"],
    fields: [
      ...location("Warper"),
      sprite("4_F_01"),
      { key: "destMap", kind: "map", initial: "geffen", required: true },
      integer("destX", "120", 0, 511),
      integer("destY", "60", 0, 511),
      integer("cost", "0", 0, PRICE_MAX),
      integer("minLevel", "0", 0, 999),
      text("greeting", "Where would you like to go?"),
      text("yes", "Take me there", 40),
      text("no", "Not now", 40),
      text("tooLow", "You are not strong enough to go there yet."),
      text("noMoney", "You do not have enough Zeny."),
    ],
  },
  {
    id: "shop",
    emulators: ["rathena"],
    fields: [...location("Merchant"), sprite("4_M_01"), { key: "items", kind: "items", initial: "501 50\n502 200", required: true }],
  },
  {
    id: "healer",
    emulators: ["rathena"],
    fields: [
      ...location("Healer"),
      sprite("4_F_01"),
      integer("healHp", "100", 0, 100),
      integer("healSp", "100", 0, 100),
      integer("cost", "0", 0, PRICE_MAX),
      text("greeting", "I can heal your wounds."),
      text("yes", "Heal me", 40),
      text("no", "No, thanks", 40),
      text("goodbye", "Take care."),
      text("noMoney", "You do not have enough Zeny."),
      text("done", "There you go."),
    ],
  },
];

/** Les assistants vérifiés pour un émulateur ; aucun si l'émulateur est inconnu. */
export function wizardsFor(emulator: string | null): readonly WizardDefinition[] {
  return NPC_WIZARDS.filter((wizard) => (wizard.emulators as readonly string[]).includes(emulator ?? ""));
}

export function wizardById(id: WizardId): WizardDefinition {
  const wizard = NPC_WIZARDS.find((candidate) => candidate.id === id);
  if (wizard === undefined) throw new Error(`assistant inconnu : ${id}`);
  return wizard;
}

/** Les valeurs initiales d'un assistant. */
export function initialValues(id: WizardId): Record<string, string> {
  return Object.fromEntries(wizardById(id).fields.map((field) => [field.key, field.initial]));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------------

export interface ShopItem {
  readonly id: number;
  /** `-1` : le prix d'achat de la base d'objets du serveur. */
  readonly price: number;
}

/** Une ligne de la liste d'objets : `501`, `501 50`, `501:50` ou `501,50`. */
const ITEM_LINE = /^(\d+)(?:\s*[:,\s]\s*(-?\d+))?$/;

export interface ParsedItems {
  readonly items: readonly ShopItem[];
  readonly problems: readonly WizardProblem[];
}

/** Lit la liste d'objets d'une boutique (une ligne par objet) ; les lignes vides sont ignorées. */
export function parseShopItems(value: string): ParsedItems {
  const items: ShopItem[] = [];
  const problems: WizardProblem[] = [];
  const seen = new Set<number>();
  value.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    const number = index + 1;
    const match = ITEM_LINE.exec(line);
    if (match === null) {
      problems.push({ field: "items", severity: "error", code: "badItemLine", params: { line: number } });
      return;
    }
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 1 || id > ITEM_ID_MAX) {
      problems.push({ field: "items", severity: "error", code: "itemIdRange", params: { line: number } });
      return;
    }
    const price = match[2] === undefined ? -1 : Number(match[2]);
    if (!Number.isSafeInteger(price) || price < -1 || price > PRICE_MAX) {
      problems.push({ field: "items", severity: "error", code: "priceRange", params: { line: number } });
      return;
    }
    if (price === 0) problems.push({ field: "items", severity: "warning", code: "priceFree", params: { line: number } });
    if (price > PRICE_WARNING_THRESHOLD) problems.push({ field: "items", severity: "warning", code: "priceHigh", params: { line: number } });
    if (seen.has(id)) problems.push({ field: "items", severity: "warning", code: "itemDuplicate", params: { line: number, id } });
    seen.add(id);
    items.push({ id, price });
  });
  if (items.length === 0 && problems.every((problem) => problem.severity !== "error")) {
    problems.push({ field: "items", severity: "error", code: "itemsRequired" });
  }
  return { items, problems };
}

/** Ce que la validation reproche a un champ (utilisable seule, par exemple pour un champ facultatif). */
export function validateWizardField(field: WizardField, raw: string | undefined): WizardProblem[] {
  const value = raw ?? "";
  const problem = (severity: "error" | "warning", code: WizardProblemCode, params?: Record<string, string | number>): WizardProblem[] => [
    params === undefined ? { field: field.key, severity, code } : { field: field.key, severity, code, params },
  ];
  if (field.kind === "items") return parseShopItems(value).problems.slice();
  if (value.trim() === "") return field.required ? problem("error", "required") : [];
  switch (field.kind) {
    case "integer":
    case "direction": {
      if (!INTEGER.test(value.trim())) return problem("error", "notInteger");
      const number = Number(value.trim());
      const min = field.min ?? Number.NEGATIVE_INFINITY;
      const max = field.max ?? Number.POSITIVE_INFINITY;
      if (!Number.isSafeInteger(number) || number < min || number > max) return problem("error", "outOfRange", { min: field.min ?? 0, max: field.max ?? 0 });
      return [];
    }
    case "map":
      return MAP_NAME.test(value.trim()) ? [] : problem("error", "badMap");
    case "sprite":
      return SPRITE.test(value.trim()) ? [] : problem("error", "badSprite");
    case "text":
    case "longText": {
      if (!SINGLE_LINE.test(value)) return problem("error", "badCharacters");
      if (field.maxLength !== undefined && value.length > field.maxLength) return problem("error", "tooLong", { max: field.maxLength });
      return [];
    }
  }
}

/** Fragment d'un nom d'affichage : ce qui précède `#` ou `::` (le reste identifie le NPC mais ne s'affiche pas). */
export function displayNameOf(name: string): string {
  const cut = name.search(/::|#/);
  return (cut === -1 ? name : name.slice(0, cut)).trim();
}

/** Champs de texte dont le contenu ne doit pas contenir `:` (séparateur des choix de `select`). */
const SELECT_LABELS: ReadonlySet<string> = new Set(["yes", "no"]);

/** Tout ce que la saisie a de contestable : erreurs (le script ne serait pas valable) puis avertissements. */
export function validateWizard(id: WizardId, values: WizardValues): WizardProblem[] {
  const wizard = wizardById(id);
  const problems: WizardProblem[] = [];
  for (const field of wizard.fields) problems.push(...validateWizardField(field, values[field.key]));
  const name = values["name"] ?? "";
  if (name.trim() !== "" && displayNameOf(name).length > NPC_DISPLAY_NAME_MAX) {
    problems.push({ field: "name", severity: "warning", code: "displayNameLong", params: { max: NPC_DISPLAY_NAME_MAX } });
  }
  for (const key of SELECT_LABELS) {
    if (wizard.fields.some((field) => field.key === key) && (values[key] ?? "").includes(":")) {
      problems.push({ field: key, severity: "error", code: "colon" });
    }
  }
  return problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

export const hasErrors = (problems: readonly WizardProblem[]): boolean => problems.some((problem) => problem.severity === "error");

// ---------------------------------------------------------------------------------------------------------------------------
// Génération
// ---------------------------------------------------------------------------------------------------------------------------

/** Chaîne de script : `"` et `\` protégés, rien d'autre n'est modifié. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const get = (values: WizardValues, key: string): string => (values[key] ?? "").trim();
const num = (values: WizardValues, key: string): number => Number(get(values, key));

function header(values: WizardValues, type: string, tail: string): string {
  return `${get(values, "map")},${num(values, "x")},${num(values, "y")},${num(values, "facing")}\t${type}\t${get(values, "name")}\t${tail}`;
}

function warpPortal(values: WizardValues): string {
  const tail = `${num(values, "areaX")},${num(values, "areaY")},${get(values, "destMap")},${num(values, "destX")},${num(values, "destY")}`;
  return `${header(values, "warp", tail)}\n`;
}

function dialogue(display: string, text: string): string[] {
  return [`\tmes ${quote(`[${display}]`)};`, `\tmes ${quote(text)};`];
}

function warpNpc(values: WizardValues): string {
  const display = displayNameOf(get(values, "name"));
  const cost = num(values, "cost");
  const minLevel = num(values, "minLevel");
  const lines = [header(values, "script", `${get(values, "sprite")},{`)];
  lines.push(...dialogue(display, get(values, "greeting")), "\tnext;");
  lines.push(`\tif (select(${quote(`${get(values, "yes")}:${get(values, "no")}`)}) == 2) close;`);
  if (minLevel > 0) {
    lines.push(`\tif (BaseLevel < ${minLevel}) {`, ...dialogue(display, get(values, "tooLow")).map((line) => `\t${line}`), "\t\tclose;", "\t}");
  }
  if (cost > 0) {
    lines.push(`\tif (Zeny < ${cost}) {`, ...dialogue(display, get(values, "noMoney")).map((line) => `\t${line}`), "\t\tclose;", "\t}", `\tZeny -= ${cost};`);
  }
  lines.push(`\twarp ${quote(get(values, "destMap"))},${num(values, "destX")},${num(values, "destY")};`, "}");
  return `${lines.join("\n")}\n`;
}

function shop(values: WizardValues): string {
  const { items } = parseShopItems(values["items"] ?? "");
  const list = items.map((item) => `${item.id}:${item.price}`).join(",");
  return `${header(values, "shop", `${get(values, "sprite")},${list}`)}\n`;
}

function healer(values: WizardValues): string {
  const display = displayNameOf(get(values, "name"));
  const cost = num(values, "cost");
  const lines = [header(values, "script", `${get(values, "sprite")},{`)];
  lines.push(...dialogue(display, get(values, "greeting")), "\tnext;");
  lines.push(`\tif (select(${quote(`${get(values, "yes")}:${get(values, "no")}`)}) == 2) {`, ...dialogue(display, get(values, "goodbye")).map((line) => `\t${line}`), "\t\tclose;", "\t}");
  if (cost > 0) {
    lines.push(`\tif (Zeny < ${cost}) {`, ...dialogue(display, get(values, "noMoney")).map((line) => `\t${line}`), "\t\tclose;", "\t}", `\tZeny -= ${cost};`);
  }
  lines.push(`\tpercentheal ${num(values, "healHp")},${num(values, "healSp")};`, ...dialogue(display, get(values, "done")), "\tclose;", "}");
  return `${lines.join("\n")}\n`;
}

const GENERATORS: Readonly<Record<WizardId, (values: WizardValues) => string>> = {
  "warp-portal": warpPortal,
  "warp-npc": warpNpc,
  shop,
  healer,
};

export interface WizardResult {
  /** Le script, ou `null` tant que la saisie a des erreurs. */
  readonly source: string | null;
  readonly problems: readonly WizardProblem[];
}

/** Valide la saisie puis, si elle n'a aucune erreur, génère le script (les avertissements n'empêchent pas la génération). */
export function runWizard(id: WizardId, values: WizardValues): WizardResult {
  const problems = validateWizard(id, values);
  return { source: hasErrors(problems) ? null : GENERATORS[id](values), problems };
}
