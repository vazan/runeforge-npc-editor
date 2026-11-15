/**
 * Fichiers d'un serveur rAthena que l'adaptateur sait lire, relatifs a la racine du serveur (celle qui contient `conf/`,
 * `npc/`, `db/`, `doc/`). Disposition verifiee sur le depot rAthena local ; une installation sans `src/` (serveur
 * precompile) reste utilisable : seules les sources manquantes sont ignorees.
 */
export const RATHENA_PATHS = {
  /** Manuel des commandes de script (signatures et aide). */
  commandDoc: "doc/script_commands.txt",
  /** Manuel des drapeaux de carte. */
  mapflagDoc: "doc/mapflags.txt",
  /** Code source du serveur : contient la table `buildin_func[]` de toutes les commandes. */
  builtinSource: "src/map/script.cpp",
  /** Commandes personnalisees : fragment inclus a la fin de la table `buildin_func[]` (`#include <custom/script_def.inc>`). */
  customBuiltins: "src/custom/script_def.inc",
  /** Configuration du serveur de cartes, lue avant `scripts_main.conf`. */
  mapConfig: "conf/map_athena.conf",
  /** Bases YAML (racines : leurs `Footer: Imports:` designent les fichiers lus, selon le mode de compilation). */
  itemDb: "db/item_db.yml",
  mobDb: "db/mob_db.yml",
  skillDb: "db/skill_db.yml",
  constantDb: "db/const.yml",
  /** Options aleatoires des objets : le serveur en tire les constantes `RDMOPT_<Option>` (`RandomOptionDatabase::loadingFinished`). */
  randomOptionDb: "db/item_randomopt_db.yml",
  /** Constantes exportees par le code du serveur vers les scripts (une suite d'appels `export_constant(NOM);`). */
  scriptConstants: "src/map/script_constants.hpp",
  /** Index des cartes du serveur, puis celui de l'utilisateur (`mapindex_init`). */
  mapIndex: ["db/map_index.txt", "db/import/map_index.txt"],
  /** Active ou non la compilation « renewal » (`#define RENEWAL`). */
  renewalHeader: "src/config/renewal.hpp",
  /** Liste des scripts charges selon le mode de compilation. */
  scriptsMain: { renewal: "npc/re/scripts_main.conf", preRenewal: "npc/pre-re/scripts_main.conf" },
} as const;

export const RATHENA_PROFILE_LABEL = "rAthena";
