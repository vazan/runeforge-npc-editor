import { displayNameOf, ITEM_ID_MAX, PRICE_MAX, PRICE_WARNING_THRESHOLD, type WizardId, type WizardProblem, type WizardProblemCode } from "@runeforge/npc-templates";
import type { TreeNode } from "@runeforge/project-core";
import type { MessageKey } from "../../i18n/messages";

/**
 * Partie pure de l'interface des assistants de NPC : quel message pour quel champ ou quel probleme, et le nom de fichier propose.
 * Les `Record` exhaustifs font echouer la compilation quand l'assistant (le coeur) gagne un code de probleme ; les champs, eux,
 * sont des chaines : `wizard-ui.test.ts` verifie que chaque champ de chaque assistant a un libelle.
 */

export const WIZARD_NAME: Readonly<Record<WizardId, MessageKey>> = {
  "warp-portal": "wizard.name.warp-portal",
  "warp-npc": "wizard.name.warp-npc",
  shop: "wizard.name.shop",
  healer: "wizard.name.healer",
};

export const WIZARD_DESCRIPTION: Readonly<Record<WizardId, MessageKey>> = {
  "warp-portal": "wizard.desc.warp-portal",
  "warp-npc": "wizard.desc.warp-npc",
  shop: "wizard.desc.shop",
  healer: "wizard.desc.healer",
};

const FIELD_LABEL: Readonly<Record<string, MessageKey>> = {
  name: "wizard.field.name",
  map: "wizard.field.map",
  x: "wizard.field.x",
  y: "wizard.field.y",
  facing: "wizard.field.facing",
  areaX: "wizard.field.areaX",
  areaY: "wizard.field.areaY",
  destMap: "wizard.field.destMap",
  destX: "wizard.field.destX",
  destY: "wizard.field.destY",
  sprite: "wizard.field.sprite",
  cost: "wizard.field.cost",
  minLevel: "wizard.field.minLevel",
  greeting: "wizard.field.greeting",
  yes: "wizard.field.yes",
  no: "wizard.field.no",
  tooLow: "wizard.field.tooLow",
  noMoney: "wizard.field.noMoney",
  items: "wizard.field.items",
  healHp: "wizard.field.healHp",
  healSp: "wizard.field.healSp",
  goodbye: "wizard.field.goodbye",
  done: "wizard.field.done",
};

const FIELD_HINT: Readonly<Record<string, MessageKey>> = {
  name: "wizard.hint.name",
  sprite: "wizard.hint.sprite",
  items: "wizard.hint.items",
};

/** Libelle d'un champ d'assistant ; `undefined` si le champ n'en a pas (l'interface affiche alors sa cle). */
export const fieldLabelKey = (key: string): MessageKey | undefined => FIELD_LABEL[key];

/** Aide d'un champ, s'il en a une. */
export const fieldHintKey = (key: string): MessageKey | undefined => FIELD_HINT[key];

export const PROBLEM_MESSAGE: Readonly<Record<WizardProblemCode, MessageKey>> = {
  required: "wizard.problem.required",
  notInteger: "wizard.problem.notInteger",
  outOfRange: "wizard.problem.outOfRange",
  tooLong: "wizard.problem.tooLong",
  badCharacters: "wizard.problem.badCharacters",
  badMap: "wizard.problem.badMap",
  badSprite: "wizard.problem.badSprite",
  badItemLine: "wizard.problem.badItemLine",
  itemIdRange: "wizard.problem.itemIdRange",
  priceRange: "wizard.problem.priceRange",
  priceFree: "wizard.problem.priceFree",
  priceHigh: "wizard.problem.priceHigh",
  itemDuplicate: "wizard.problem.itemDuplicate",
  itemsRequired: "wizard.problem.itemsRequired",
  colon: "wizard.problem.colon",
  displayNameLong: "wizard.problem.displayNameLong",
};

/** Les huit orientations d'un NPC, dans l'ordre du serveur (0 : nord, puis dans le sens inverse des aiguilles d'une montre). */
export const DIRECTION_LABEL: readonly MessageKey[] = [
  "wizard.direction.0",
  "wizard.direction.1",
  "wizard.direction.2",
  "wizard.direction.3",
  "wizard.direction.4",
  "wizard.direction.5",
  "wizard.direction.6",
  "wizard.direction.7",
];

/** Valeurs d'un message de probleme : celles du probleme, plus les bornes du coeur (mises en forme pour la langue). */
export function problemParams(problem: WizardProblem, language: string): Record<string, string | number> {
  const number = new Intl.NumberFormat(language);
  return {
    ...problem.params,
    itemIdMax: number.format(ITEM_ID_MAX),
    priceMax: number.format(PRICE_MAX),
    threshold: number.format(PRICE_WARNING_THRESHOLD),
  };
}

/**
 * Nom de fichier propose pour le script d'un assistant : le nom affiche du NPC en minuscules ASCII (`Marchand d'armes` devient
 * `marchand_d_armes.txt`), dans le dossier du fichier de script ouvert, sinon dans `npc/custom/` si le projet a un dossier `npc`,
 * sinon a la racine du projet. L'utilisateur le corrige a volonte.
 */
export function suggestFileName(npcName: string, activePath: string | null, tree: TreeNode | null): string {
  const slug = displayNameOf(npcName)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const file = `${slug === "" ? "npc" : slug}.txt`;
  if (activePath !== null && activePath.endsWith(".txt")) return `${activePath.slice(0, activePath.lastIndexOf("/") + 1)}${file}`;
  const hasNpcDirectory = tree?.children.some((child) => child.kind === "directory" && child.name === "npc") === true;
  return hasNpcDirectory ? `npc/custom/${file}` : file;
}
