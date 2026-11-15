/**
 * Nature des arguments d'une commande (carte, objet, monstre), deduite des **signatures du manuel** du serveur de
 * l'utilisateur : `warp "<map name>",<x>,<y>;`, `getitem <item id>,<amount>;`, `monster ...,<mob id>,...`.
 *
 * La notation compacte de la table du serveur (`"sii?"`) ne distingue pas un objet d'un entier quelconque : seul le manuel
 * le dit. L'information est donc aussi fiable que le manuel : un parametre n'est retenu que si **toutes** les signatures de
 * la commande qui ont un parametre a cette position s'accordent, et seuls des noms de parametres reconnus sont retenus
 * (`<name to show>`, `<variable for map name>`, `<map id>` ne designent rien du catalogue).
 */
import { parseSignatureText } from "./signature";

/** Les natures d'arguments que le catalogue sait verifier et completer. */
export type ArgumentKind = "item" | "mob" | "map" | "skill";

const MAP_LABELS: ReadonlySet<string> = new Set([
  "map",
  "map name",
  "mapname",
  "from map",
  "to map",
  "from map name",
  "to map name",
  "from mapname",
  "to mapname",
  "dest map",
  "alternate map name",
  "battleground map name",
]);
const ITEM_LABELS: ReadonlySet<string> = new Set(["item", "item id", "item name", "aegis item name"]);
const MOB_LABELS: ReadonlySet<string> = new Set(["mob id", "mob name", "monster id", "monster name"]);
const SKILL_LABELS: ReadonlySet<string> = new Set(["skill id", "skill name"]);

/** Nature designee par le nom d'un parametre du manuel (`item id`, `Map Name`, `to_mapname`...) ; `null` si aucune. */
export function kindOfParameterLabel(label: string): ArgumentKind | null {
  const normalized = normalizeLabel(label);
  if (MAP_LABELS.has(normalized)) return "map";
  if (ITEM_LABELS.has(normalized)) return "item";
  if (MOB_LABELS.has(normalized)) return "mob";
  if (SKILL_LABELS.has(normalized)) return "skill";
  return null;
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function parameterLabels(signature: string): (string | undefined)[] {
  const view = parseSignatureText(signature);
  return view.parameters.map(({ start, end }) => /<([^<>]*)>/.exec(view.label.slice(start, end))?.[1]);
}

/** Nature de chaque parametre (par position) d'une signature ecrite comme dans le manuel. */
export function parameterKindsOfSignature(signature: string): (ArgumentKind | null)[] {
  return parameterLabels(signature).map((label) => label === undefined ? null : kindOfParameterLabel(label));
}

/** La representation documentee d'un argument de competence : certaines commandes ne prennent qu'un identifiant. */
export function allowsSkillArgument(definition: { readonly signatures: readonly string[] }, index: number, form: "id" | "name"): boolean {
  return definition.signatures.some((signature) => {
    const label = parameterLabels(signature)[index];
    return label !== undefined && normalizeLabel(label) === `skill ${form}`;
  });
}

const cache = new WeakMap<object, readonly (ArgumentKind | null)[]>();

/**
 * Nature de l'argument de chaque position d'une commande, a partir de ses signatures : la nature d'une position n'est retenue
 * que si toutes les signatures qui y ont un parametre la donnent. Vide pour une commande sans signature du manuel.
 */
export function argumentKindsOf(definition: { readonly signatures: readonly string[] }): readonly (ArgumentKind | null)[] {
  const cached = cache.get(definition);
  if (cached !== undefined) return cached;
  const perSignature = definition.signatures.map(parameterKindsOfSignature);
  const width = perSignature.reduce((most, kinds) => Math.max(most, kinds.length), 0);
  const result: (ArgumentKind | null)[] = [];
  for (let position = 0; position < width; position += 1) {
    let agreed: ArgumentKind | null | undefined;
    for (const kinds of perSignature) {
      if (position >= kinds.length) continue;
      const kind = kinds[position] ?? null;
      if (agreed === undefined) agreed = kind;
      else if (agreed !== kind) agreed = null;
    }
    result.push(agreed ?? null);
  }
  cache.set(definition, result);
  return result;
}
