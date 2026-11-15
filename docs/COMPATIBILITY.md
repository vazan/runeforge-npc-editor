# Compatibilité des émulateurs

> Ce document dit, par émulateur, ce qui est **vérifié** (lu dans une installation réelle, avec preuve), **supposé** (hypothèse non vérifiée) ou **inconnu**. Rien n'est inventé : sans preuve,
> l'application se tait (aucune alerte, aucune proposition). Les preuves sont dans [`STATUS.md`](STATUS.md), [`TEST_MATRIX.md`](TEST_MATRIX.md) et [`DECISIONS.md`](DECISIONS.md) ; les limites dans
> [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md). Dernière mise à jour : **2026-11-09**.

## Matrice

| Famille · profil | État | Référence lue | Ce que l'application en fait |
|---|---|---|---|
| **rAthena · Renewal** (`db/re`, `npc/re`) | **Vérifié par lecture** (le serveur n'a jamais été exécuté) | fork local `Serveur/rathena-kov` : dépôt sans historique propre, **révision inconnue** ; licence GPL-3.0 (`LICENSE` du serveur) ; mode Renewal (`src/config/renewal.hpp`) ; bibliothèque intégrée générée depuis ce checkout, manuel mis à jour le 2022-03-08 | registre d'aide intégré, validation depuis les sources configurées, règles de chargement, bases (objets, monstres, cartes, constantes, options aléatoires), diagnostics `RA0001`–`RA0016` |
| **rAthena · Pre-renewal** | **Partiel** : la logique (imports `Mode: Prerenewal`, `npc/pre-re/…`) est testée sur des fixtures rédigées | aucune installation pré-renewal réelle | mêmes fonctions, jamais confrontées à un serveur réel de ce mode |
| **Hercules** | **`BLOCKED_EXTERNAL`** | aucune installation fournie | rien : ni registre, ni catalogue, ni modèle, ni alerte de commande ; seuls le lexer et le parseur s'appliquent, et leur identité avec la syntaxe Hercules est une **hypothèse** |
| Fork personnalisé · projet sans serveur | pris en charge par déclaration de l'utilisateur | — | commandes et constantes du projet (`commands.custom`, `constants.custom`), jamais une « erreur certaine » |

## Ce que l'adaptateur rAthena lit à l'exécution

L'aide et les signatures des commandes rAthena proviennent de la bibliothèque intégrée (DEC-041). La table des commandes et les définitions personnalisées du serveur de l'utilisateur sont lues au démarrage du projet et à chaque changement de ses réglages, uniquement pour la validation spécifique à ce serveur.

| Besoin | Fichiers lus | Décision |
|---|---|---|
| Commandes et arité | Bibliothèque générée depuis `src/map/script.cpp` et `doc/script_commands.txt`; les sources `src/map/script.cpp` et `src/custom/script_def.inc` du serveur configuré font foi pour la validation | DEC-025, DEC-041 |
| Scripts chargés et leur ordre | `conf/map_athena.conf`, `npc/re/scripts_main.conf` ou `npc/pre-re/scripts_main.conf`, avec `import:`, `delnpc:`, `npc: clear` | DEC-026, DEC-035 |
| Cartes chargées | `conf/map_athena.conf` et ses imports (`map:`, `delmap:`) | DEC-034 |
| Index des cartes | `db/map_index.txt`, `db/import/map_index.txt` | DEC-030 |
| Objets, monstres, constantes | `db/item_db.yml`, `db/mob_db.yml`, `db/const.yml` et leurs imports selon le mode, `src/map/script_constants.hpp` | DEC-030 |
| Options aléatoires (`RDMOPT_…`) | `db/item_randomopt_db.yml` et ses imports | DEC-036 |
| Mode de compilation | `src/config/renewal.hpp` (ou le réglage du projet) | DEC-026 |

## Règles de langage prouvées dans le code du serveur local

Chaque règle ci-dessous a été **lue** dans le code du serveur local (rien n'a été exécuté), puis confrontée à ses scripts réels par un oracle indépendant et des mutations (voir `TEST_MATRIX.md`).

- Portée des labels, fonctions locales, noms de NPC et fonctions globales (casse, troncature, doublons) : DEC-019 ; `set_label` refuse un label nommé comme une commande, une constante ou un paramètre : DEC-034.
- Une déclaration sur une carte absente de l'index est ignorée avec une erreur, sur une carte de l'index non chargée **sans message** : DEC-034.
- Une fonction globale n'existe pour le serveur qu'**après** l'analyse de sa définition : un appel par son nom avant elle (autre fichier chargé plus tard, plus bas dans le fichier, récursion) empêche le script de se charger : DEC-035.
- Les constantes `RDMOPT_<Option>` sont créées à la fin du chargement de la base des options aléatoires : DEC-036.

## Ce qui n'est pas vérifié

- **Aucune exécution du serveur** (le lancer exige l'accord explicite de l'utilisateur) : le comportement décrit vient de la lecture du code ; les diagnostics qui en dépendent sont donc « probables », jamais « certains ».
- **Pre-renewal** : voir la matrice. **Révision** du serveur local : inconnue (pas d'historique). **Autres forks** : leurs différences éventuelles (commandes, bases, règles de chargement) sont lues dans leurs fichiers, pas supposées.
- **Hercules** : tout. Voir ci-dessous.

## Débloquer Hercules

Statut : **`BLOCKED_EXTERNAL`**. Il faut une copie de Hercules : fournie par l'utilisateur, ou téléchargée **avec son accord explicite** (dépôt public : <https://github.com/HerculesWS/Hercules>) ; rien n'est téléchargé sans lui.
Avec elle, la démarche est celle qui a servi pour rAthena : lire le code, écrire des oracles indépendants, faire des mutations, confronter ses scripts réels.

À confirmer dans le code Hercules (**hypothèses**, tirées de la connaissance générale du projet, aucune n'est vérifiée) :
1. où se trouve la table des commandes de script et si son format de notation des arguments est celui de rAthena (`"s*"`, `"vi?"`) ;
2. le format des bases (objets, monstres, constantes) : il pourrait ne pas être du YAML — le lecteur par indentation de rAthena ne s'y appliquerait alors pas ;
3. les fichiers qui listent les scripts chargés et la manière dont `import:`, `delnpc:` et le mode de compilation s'y appliquent ;
4. si les règles de DEC-019 (labels, fonctions locales, `callsub`, `menu`, `function X;`), DEC-034 (cartes, labels réservés) et DEC-035 (ordre des fonctions) valent à l'identique ;
5. les commandes et constantes propres à Hercules, et celles de rAthena qu'il n'a pas (`RC0001`–`RC0003` : compatibilité entre profils, définis mais pas encore émis).
