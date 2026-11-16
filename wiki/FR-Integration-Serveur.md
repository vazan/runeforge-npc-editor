# Intégration du serveur

*🇬🇧 [English version](EN-Server-Integration)*

RuneForge peut lire le dossier de votre serveur **rAthena** pour rendre ses vérifications propres au serveur que vous faites réellement tourner. Il **lit seulement** vos fichiers et **ne lance jamais** le serveur de jeu.

## Reconnaissance

Quand vous ouvrez un projet qui contient un serveur rAthena, la barre d'état l'affiche (par exemple `rAthena · re`). Le serveur est reconnu grâce à des fichiers caractéristiques :

`src/map/script.cpp` · `npc/re/scripts_main.conf` · `npc/pre-re/scripts_main.conf` · `conf/map_athena.conf` · `doc/script_commands.txt` (sa présence est notée, son contenu n'est pas ouvert).

- **Plusieurs serveurs dans un projet ?** Rien n'est choisi automatiquement ; la barre d'état affiche « Choisir un serveur » et vous désignez le dossier dans **Paramètres › Projet**.
- **Aucun serveur** (dossier de scripts isolé), **Hercules**, ou **serveur précompilé sans `src/`** : la bibliothèque de commandes hors ligne donne toujours complétion, survol et signatures, mais aucune alerte propre au serveur n'est émise.

## Ce qui est lu dans vos fichiers

À l'ouverture du projet et à chaque changement des réglages du serveur :

| Besoin | Lu dans votre serveur |
|---|---|
| Noms des commandes et nombre d'arguments | `src/map/script.cpp` (la table des commandes) et `src/custom/script_def.inc` (vos commandes personnalisées) |
| Scripts chargés et leur ordre | `npc/re/scripts_main.conf` ou `npc/pre-re/scripts_main.conf` et ce qu'ils `import:` / `delnpc:` |
| Cartes chargées | `conf/map_athena.conf` et ses imports (`map:`, `delmap:`) |
| Index des cartes | `db/map_index.txt`, `db/import/map_index.txt` |
| Objets, monstres | `db/item_db.yml`, `db/mob_db.yml` et leurs imports (`db/re/` ou `db/pre-re/` selon le mode, puis `db/import/`) |
| Constantes | `db/const.yml`, `src/map/script_constants.hpp` |
| Options aléatoires (`RDMOPT_…`) | `db/item_randomopt_db.yml` et imports |
| Mode (Renewal / pre-Renewal) | `src/config/renewal.hpp` (ou votre réglage) |

Ces données sont lues à l'exécution et gardées en mémoire ; aucun fichier du serveur n'est copié dans RuneForge ni dans votre projet. Sur un serveur de référence, c'est rapide : 27 826 objets, 2 555 monstres, 1 248 cartes et 10 552 constantes lus en 0,1 s environ, identiques à un analyseur YAML complet (0 différence).

## Paramètres › Projet

| Réglage | Rôle |
|---|---|
| Dossier du serveur | Choisir parmi les serveurs détectés, ou en désigner un |
| Mode de compilation | `re` ou `pre-re`, s'il ne peut pas être détecté (sans `renewal.hpp`, Renewal est supposé et l'application le dit) |
| **Portée de l'index** | `sources` (par défaut) ou `loaded` (seulement les scripts que le serveur charge) |
| Niveau d'alerte | Commandes inconnues ; références introuvables (objets, monstres, cartes) |
| Vérifications entre fichiers | `validation.crossFile`, désactivé par défaut |
| **Commandes personnalisées** | Une par ligne : `nom` ou `nom arguments` (par exemple `mycmd s?`). Sans notation des arguments, leur nombre n'est pas vérifié |
| **Constantes personnalisées** | Complètent celles du serveur |

Ces réglages sont enregistrés dans `.runeforge/project.json` **seulement quand vous le demandez**. Une commande personnalisée **complète** le registre d'un serveur reconnu ; elle ne le remplace jamais (seule, elle ferait signaler toutes les autres commandes comme inconnues).

## Rechercher dans les bases

`Ctrl+Maj+D` ouvre une palette sur les objets, monstres, cartes et constantes de votre serveur. Préfixez une requête par `item:`, `mob:`, `map:` ou `const:` pour la restreindre. `Entrée` insère l'identifiant, `Maj+Entrée` le nom entre guillemets. Rien n'est écrit dans un fichier : l'insertion se fait dans l'éditeur ouvert.

## Les règles d'ordre de chargement

Certaines erreurs font qu'un serveur ignore ou refuse un script sans le dire. RuneForge lit le code du serveur pour les signaler :

- **`RA0015`** — un NPC sur une carte que le serveur ne charge pas (`conf/map_athena.conf`) est ignoré **sans aucun message**.
- **`RA0014`** — un label qui porte le nom d'une commande, d'une constante ou d'un paramètre est refusé.
- **`RA0016`** — une fonction appelée par son nom nu avant d'être chargée (chargée par un fichier suivant, définie plus bas dans le même fichier, ou récursion) empêche le script de se charger.

Voir [Diagnostics](FR-Diagnostics) pour la liste complète.

## Limites à connaître

- **rAthena seulement.** Hercules n'a pas encore d'adaptateur (voir [Compatibilité et limites](FR-Compatibilite-et-Limites)).
- Les règles ont été prouvées sur **un seul fork rAthena local en mode Renewal** (révision inconnue). La logique pre-renewal est testée sur des fixtures rédigées, pas sur une vraie installation pre-renewal. Un fork qui change la façon dont `callfunc` est analysé ou la notation des arguments pourrait provoquer de fausses alertes — déclarez ses différences ou réglez le niveau d'alerte.
- Un serveur compilé avec d'autres options peut différer du code source lu : les commandes sous `#ifdef` sont considérées connues, donc jamais signalées à tort, mais une commande absente du binaire n'est pas détectée.
- Avec `use_sql_db: yes`, le serveur lit objets et monstres dans MySQL : les fichiers YAML que RuneForge lit peuvent alors différer de ce que le serveur utilise.
- Changer de serveur, de mode ou de portée relit tout le projet.
