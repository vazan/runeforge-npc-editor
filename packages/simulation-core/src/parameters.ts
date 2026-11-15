import type { SimulationContext } from "./types";

/**
 * Paramètres du personnage lus comme des variables (`BaseLevel`, `Weight`, `SkillPoint`...). Chacun a une valeur par défaut
 * pour le personnage de test ; une variable du même nom dans le contexte ou écrite par le script la remplace.
 *
 * Source des noms : `export_parameter` de `src/map/script_constants.hpp`. Les valeurs par défaut sont des hypothèses de test,
 * pas des données du serveur : un personnage de niveau 99 a un niveau de classe plafonné à 50, un poids nul, etc.
 */
export type ParameterDefault = (context: SimulationContext) => number;

/** Classe de base (Novice 0, Épéiste 1, Magicien 2, Archer 3, Acolyte 4, Marchand 5, Voleur 6) des classes 0 à 21 de la lignée classique. */
const CLASSIC_BASE = [0, 1, 2, 3, 4, 5, 6, 1, 4, 2, 5, 3, 6, 1, 1, 4, 2, 6, 5, 3, 3, 1] as const;

/** Rang d'évolution : 0 normal, 1 évolué (4001–4022), 2 bébé (4023–4045). */
export function upperOf(job: number): number {
  if (job >= 4001 && job <= 4022) return 1;
  if (job >= 4023 && job <= 4045) return 2;
  return 0;
}

/** Classe de la lignée classique d'une classe évoluée ou bébé (`BaseJob`) ; les autres lignées gardent leur identifiant. */
export function baseJobOf(job: number): number {
  if (job >= 4001 && job <= 4022) return job - 4001;
  if (job >= 4023 && job <= 4044) return job - 4023;
  if (job === 4045) return 23;
  return job;
}

/** Classe d'origine (`BaseClass`) : Novice, Épéiste, Magicien, Archer, Acolyte, Marchand ou Voleur ; 0 hors de la lignée classique. */
export function baseClassOf(job: number): number {
  return CLASSIC_BASE[baseJobOf(job)] ?? 0;
}

const constant = (value: number): ParameterDefault => () => value;

export const PARAMETERS: ReadonlyMap<string, ParameterDefault> = new Map<string, ParameterDefault>([
  ["baselevel", (context) => context.level],
  ["class", (context) => context.job],
  ["zeny", (context) => context.zeny],
  ["joblevel", (context) => Math.min(context.level, 50)],
  ["sex", constant(1)],
  ["upper", (context) => upperOf(context.job)],
  ["basejob", (context) => baseJobOf(context.job)],
  ["baseclass", (context) => baseClassOf(context.job)],
  ["weight", constant(0)],
  ["maxweight", constant(20_000)],
  ["hp", constant(1_000)],
  ["maxhp", constant(1_000)],
  ["sp", constant(100)],
  ["maxsp", constant(100)],
  ["ap", constant(0)],
  ["maxap", constant(0)],
  ["statuspoint", constant(0)],
  ["skillpoint", constant(0)],
  ["traitpoint", constant(0)],
  ["baseexp", constant(0)],
  ["jobexp", constant(0)],
  ["nextbaseexp", constant(1_000)],
  ["nextjobexp", constant(1_000)],
  ["karma", constant(0)],
  ["manner", constant(0)],
  ["sitting", constant(0)],
  ["charmoves", constant(0)],
  ["charrename", constant(0)],
  ["font", constant(0)],
  ["bankvault", constant(0)],
]);

/** Paramètres que la simulation montre ailleurs (formulaire, solde) et que la liste des variables n'a pas à répéter. */
export const SHOWN_ELSEWHERE: ReadonlySet<string> = new Set(["baselevel", "class", "zeny"]);
