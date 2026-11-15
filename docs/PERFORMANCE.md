# Performance — mesures reproductibles

> Cibles du cahier des charges (CLAUDE.md §4) = **objectifs**, pas des garanties. Ce document ne contient que des
> mesures **réellement exécutées**, avec leur méthode ; ce qui n'est pas mesuré est marqué comme tel.
> Dernière mise à jour : 2026-11-09 (M4-S2).

## Environnement de référence (unique pour l'instant)
AMD Ryzen 7 9700X (8 cœurs / 16 threads) · 93,6 Go de RAM · Windows 11 Pro 10.0.26200 · Node 22.15.1 · pnpm 10.33.
Mesures en **un seul fil Node.js** (pas dans un Worker WebView2), sur disque local SSD. Une exécution par mesure, sans
moyenne ni écart-type : à traiter comme un ordre de grandeur, pas comme une valeur contractuelle.
Aucune machine « modeste » ni Linux n'a été mesurée.

## Corpus
Scripts réels du serveur rAthena local (`Serveur/rathena-kov`, mode renouvelé) :
- **Ensemble chargé** : les fichiers listés par `npc/re/scripts_main.conf` (récursivement) = **841 fichiers, 23,1 Mo,
  24 405 déclarations, 9 360 scripts** ;
- **Dossier complet** `npc/` : 1 133 fichiers, 25,8 Mo (inclut les variantes `pre-re/` et `custom/` non chargées) ;
- **~5 000 scripts** : l'ensemble chargé indexé 6 fois sous des chemins distincts (`--repeat 6`) = **5 046 fichiers,
  138,7 Mo, 146 430 déclarations, 56 160 scripts**. C'est un corpus synthétique (copies) : les doublons de noms n'ont pas de sens,
  seuls temps et mémoire sont interprétables.

## Commandes
```bash
# Parseur seul (plantages, perte de texte, diagnostics, débit)
pnpm exec tsx scripts/corpus-report.ts "<racine>/npc"
# Registre de commandes, scripts chargés, alertes sur le code réel, mutations (M4-S1)
node --expose-gc --import tsx scripts/registry-report.ts --server-root "<racine serveur>"
# Assistance aux commandes : survol, complétion, aide de signature, silence, latences du service, modèles de NPC (M3-S3)
pnpm exec tsx scripts/commands-report.ts --server-root "<racine serveur>"
# Catalogue de références (objets, monstres, cartes, constantes) comparé à un analyseur YAML complet, mémoire, temps (M4-S2)
node --expose-gc --import tsx scripts/catalog-report.ts --server-root "<racine serveur>"
# Références des scripts réels : arguments vérifiés, mutations, survol et complétion du service (M4-S2)
node --expose-gc --import tsx scripts/references-report.ts --server-root "<racine serveur>"
# Latence perçue de la complétion dans l'application réelle (E2E : `pnpm e2e` construit l'exécutable, `--skip-build` le réutilise)
pnpm e2e --skip-build
pnpm exec tsx scripts/e2e/real-server-smoke.ts "<exe-e2e>" "<racine serveur>"
# Analyse sémantique + index (temps par phase, mémoire conservée, diagnostics)
node --expose-gc --import tsx scripts/analysis-report.ts --server-root "<racine serveur>" --entry npc/re/scripts_main.conf
node --expose-gc --import tsx scripts/analysis-report.ts --server-root "<racine serveur>" --entry npc/re/scripts_main.conf --repeat 6
```
`--expose-gc` est nécessaire pour la mesure de mémoire (`heapUsed` après ramasse-miettes, moins avant les analyses).
Les temps excluent la lecture des fichiers sur disque (ils mesurent `parse`, `analyzeFile`, `WorkspaceIndex.set`).

## Résultats (2026-11-05)

| Mesure | 841 fichiers (23,1 Mo) | 5 046 fichiers (138,7 Mo) |
|---|---|---|
| Parseur (lexer + AST) | 0,92 s · ~25 Mo/s | 5,72 s · ~24 Mo/s |
| Analyse sémantique (`analyzeFile`) | 0,14 s · ~165 Mo/s | 0,96 s · ~145 Mo/s |
| Ajout à l'index (`WorkspaceIndex.set`) | 0,02 s | 0,07 s |
| Diagnostics inter-fichiers (tous les fichiers) | 0,01 s | 0,41 s |
| **Total indexation à froid (parse + analyse + index)** | **~1,1 s (~21 Mo/s)** | **~6,8 s (~20,5 Mo/s)** |
| Mémoire conservée par l'index des analyses | 21,3 Mo | 113,3 Mo |
| Plantages / textes non restitués | 0 / 0 | 0 / 0 |

Le parseur domine (~85 % du temps) ; l'analyse sémantique ajoute ~15 %.

### Service de langage (M3-S1) — `scripts/language-report.ts`, 841 fichiers chargés (23,1 Mo)

| Mesure | Résultat |
|---|---|
| Indexation complète (parse + analyse + index + table de lignes) | 1,17 s (19,7 Mo/s) ; 22,2 Mo conservés |
| `definition` (1 914 appels sur fichiers ouverts : `goto` et `callfunc`) | p50 0,002 ms · p95 0,014 ms · p99 0,034 ms · max 0,53 ms |
| `documentSymbols` du plus gros fichier (18 842 lignes, 371 symboles) | 0,29 ms (médiane) |
| `workspaceSymbols` (fonctions + 24 256 noms de NPC, limite 100) | ≈1,6–2,3 ms (médiane), max 5,8 ms |
| `references` de la fonction la plus appelée (153 appels) | 0,012 ms ; 153/153 trouvées (oracle indépendant) |
| `completion` (1 913 positions : `callfunc` 3 lettres saisies, `goto` rien saisi) | p50 0,018 ms · p99 0,12 ms · max 2,7 ms ; 100 % des appels proposent la bonne cible |
| `hover` (1 913 positions) | p50 0,001 ms · p99 0,01 ms ; 100 % informatifs |
| `rename` (1 115 essais : 3 labels + 2 variables locales par fichier) | 1 002 appliqués (parse du script modifié inclus), 113 refusés, **0 nouveau diagnostic** |
| `projectDiagnostics` (tous les fichiers, `crossFile: all`) | 0,01 s |
| Dans l'application réelle (E2E) | indexation de 7 fichiers terminée en moins de 30 s (borne du test) ; durée exacte non mesurée |

Ces durées sont celles du **service** exécuté dans Node ; elles n'incluent ni le transport du Worker ni la lecture des
fichiers par l'IPC Tauri : la latence perçue dans l'application n'est pas mesurée.

### Décision fondée sur une mesure : copie des chaînes extraites
Première version : 44,2 Mo conservés pour 841 fichiers. V8 représente une sous-chaîne de 13 caractères ou plus par un
renvoi vers la chaîne d'origine : conserver un nom de NPC retenait **tout le texte de son fichier**. Copier et dédoublonner les
noms extraits (`createInterner`, `analyze.ts`) a ramené la mémoire à **21,3 Mo (−52 %)** sans changer le temps ni les
résultats (53 tests inchangés). Voir DEC-020.

### Registre de commandes et règles de chargement (M4-S1) — `scripts/registry-report.ts`, serveur local, 841 fichiers chargés

| Mesure | Résultat |
|---|---|
| Construction du registre (table de 0,78 Mo + manuel de 431 Ko) | 7,7–8,0 ms ; 667 commandes (662 au manuel) |
| Liste des scripts chargés (17 fichiers `.conf` lus, 841 existences vérifiées) | 37–39 ms |
| Analyse de 841 fichiers **sans** registre | 1,07–1,14 s ; 21–23 Mo conservés |
| Analyse de 841 fichiers **avec** registre (table + manuel) | 1,07–1,09 s ; 21–22 Mo conservés |
| Appels vérifiés | 557 894 (instructions et appels dans des expressions), 421 noms distincts, 556 348 connus du registre |
| Appels de noms hors registre conservés pour l'index (candidats `RA0001`) | 822 (les 724 autres sont des fonctions locales du même script) |
| Mutations de code réel (4 200 appels, 3 mutations chacune, 1 appel sur 120) | environ 1 min 40 s au total (réanalyse du fichier entier à chaque mutation) |
| **Dans l'application réelle** (exécutable E2E, serveur local ouvert comme projet, `scripts/e2e/real-server-smoke.ts`) | serveur reconnu et registre publié ~150 ms après la connexion au protocole de débogage ; 1 295 fichiers `.txt` indexés (portée `sources`) en ~1,6 s ; bascule en portée « scripts chargés » (841 fichiers) en ~0,7 s |

Le registre n'ajoute aucun coût mesurable à l'analyse (les écarts entre exécutions sont du bruit : les deux sens ont été observés). Les
lignes « Dans l'application réelle » sont des durées **depuis la connexion au protocole de débogage** (le démarrage de l'exécutable n'est
pas inclus, une seule exécution) ; la durée de démarrage de l'application reste **non mesurée**.

### Assistance aux commandes (M3-S3)

**Service seul** — `scripts/commands-report.ts`, serveur local (667 commandes), un seul fil Node.js :

| Mesure | Résultat |
|---|---|
| Liste complète des commandes (400 requêtes, mot vide) | p50 0,19 ms · p99 1,38 ms · max 7,24 ms |
| Aide de signature (5 000 requêtes, à chaque argument d'appels réels) | p50 0,059 ms · p99 0,50 ms · max 3,90 ms |
| Échantillon vérifié contre l'AST | 12 779 instructions, 13 377 arguments ; 8,4 s au total (service + oracle) |

**Application réelle** — de la touche Ctrl+Espace (événement `keydown` capturé dans la page) à trois états de la liste de complétion de
Monaco, relevés par `MutationObserver` (donc au niveau du DOM, **hors peinture** : jusqu'à une image, ≈ 16 ms, de plus). Exécutable E2E
(WebView2), `scripts/e2e/completion-latency.ts`. À gauche : `pnpm e2e` (projet de test, registre de **3** commandes), 6 exécutions ; à droite :
`real-server-smoke.ts` (serveur local, **667 commandes**, **678 propositions** avec les mots-clés, curseur au début d'une instruction d'un vrai
script, mot vide), 1 exécution. Une première liste (« à froid ») puis neuf autres (« à chaud »), la liste étant fermée entre deux :

| Mesure (ms) | E2E, registre de 3 commandes | Serveur local, 678 propositions |
|---|---|---|
| Contrôleur → Worker → service → réponse, sans Monaco : médiane (max) sur 10 appels | 0,1 (0,3) | 0,8 (8,0) |
| Touche → une ligne est présente dans la liste : 1re, à froid | 6,2 – 10 | 21 |
| Touche → une ligne est présente dans la liste : 9 suivantes, médiane (min – max) | 3,4 – 6,3 (1,9 – 9,3) | 6,6 (3,4 – 9,8) |
| Touche → liste **affichée** (taille non nulle, visible, opaque) : 1re, à froid | 11 – 18 | 28 |
| Touche → liste **affichée** : 9 suivantes, médiane (min – max) | 11 – 14 (8,6 – 17) | 13 (9,4 – 15) |
| Touche → classe `visible` du widget (délai fixe de Monaco) | 103 – 121 | 105 – 122 |

Lecture : la réponse du service est de l'ordre de la milliseconde ; la liste est **affichée environ 11 à 14 ms après la touche** (un à deux
cycles d'affichage), soit plus de sept fois moins que la cible de 100 ms. La classe `visible` est ajoutée par Monaco après un délai fixe de 100 ms
(`suggestWidget.js`, `_show`) mais **ne conditionne pas l'affichage** : ne pas l'employer comme indicateur d'affichage dans un test (une première
version de la mesure l'avait fait et annonçait à tort ~110 ms). Résolution du chronomètre de la page : 0,1 ms.

Limites de ces mesures : **une machine**, fenêtre au premier plan, quelques dizaines d'échantillons ; aucune mesure sur machine modeste ni
sous Linux ; seule la **complétion** est mesurée dans l'application (l'aide de signature et le survol ne le sont que par le service) ; le serveur
local n'est mesuré qu'à un emplacement d'un seul fichier.

### Bases du serveur : catalogue de références (M4-S2)

**Lecture et construction** — `scripts/catalog-report.ts`, serveur local, un seul fil Node.js :

| Mesure | Résultat |
|---|---|
| Fichiers lus | 11,8 Mo : objets (6 fichiers, dont `item_db_equip.yml` 5,8 Mo), monstres (3), constantes (`const.yml`, `script_constants.hpp` 391 Ko), cartes (2) |
| Lecture des octets · décodage | 6–13 ms · 8–10 ms |
| **Construction du catalogue** (lecteur par indentation) | **110–141 ms** : 27 826 objets, 2 555 monstres, 1 248 cartes, 10 303 constantes (M4-S2) ; **105 ms** avec les 249 constantes `RDMOPT_` de M4-S3d (10 552 constantes ; lecture 6 ms, décodage 10 ms) |
| Analyseur YAML complet (oracle, mêmes fichiers) | 3,5 s : le lecteur est ~25 fois plus rapide, et identique (0 différence) |
| **Mémoire conservée** par le catalogue (textes abandonnés) | **23,5 Mo** |

**Décision fondée sur une mesure : copie des chaînes extraites.** Première version : 43,8 Mo conservés. Même cause que pour l'analyse (DEC-020) : V8 représente une
sous-chaîne de 13 caractères ou plus par un renvoi vers la chaîne d'origine, si bien que conserver un nom d'objet retenait **tout le texte de son fichier** (5,8 Mo pour les
équipements). Copier les noms retenus (`own`, `database-readers.ts`) a ramené la mémoire à **23,5 Mo (−46 %)** sans changer le temps ni les résultats (0 différence avec l'oracle).

**Dans l'application réelle** — `scripts/e2e/real-server-smoke.ts`, exécutable E2E, serveur local ouvert comme projet, 2 exécutions ; les durées partent de la connexion au protocole de
débogage (le démarrage de l'exécutable n'est pas inclus) :

| Mesure | Résultat |
|---|---|
| Registre de commandes prêt | 154–156 ms |
| **Bases du serveur lues** (lecture par l'IPC, décodage et construction dans le worker) | **308 ms**, soit environ 150 ms de plus que le registre |
| Indexation des 1 295 fichiers `.txt` | 1,87–1,88 s (inchangée : les bases sont lues avant l'indexation, sans surcoût mesurable) |
| Complétion d'un objet parmi les 27 826 (867 propositions : 200 références + 667 commandes) : contrôleur → Worker → service → réponse, sans Monaco | médiane 1,7–3,3 ms (max 3,3–9,1) |
| Touche → liste **affichée** : 1re à froid · 9 suivantes, médiane (min – max) | 14–22 ms · 12 (8,0 – 17) |

**Service de langage seul** — `scripts/references-report.ts`, 1 054 arguments réels d'objets, de monstres et de cartes (catalogue complet) : survol p50 0,28 ms · p99 3,4–3,7 ms · max 7,9 ms ;
complétion après 3 caractères p50 0,7 ms · p99 9,3–9,5 ms · max 10–12 ms (le p99 est la recherche dans les 27 826 objets). Analyse de 841 fichiers (23,1 Mo) avec registre et catalogue, parcours de leurs
26 428 arguments compris : 1,4 s, dont ~1 s de parseur ; le coût propre de la vérification n'a pas été isolé.

Limites : un seul serveur (mode renewal), une seule machine, Windows seulement ; la mémoire du catalogue n'a pas été mesurée dans le worker de l'application (seulement dans Node) ; aucune mesure
avec les bases d'un serveur pre-renewal ni d'une autre révision.

### Rapport de projet (RF-015)

**Service de langage seul** — `scripts/project-report.ts`, serveur local, registre de commandes et catalogue de références chargés, vérifications entre fichiers activées (`crossFile: all`) ;
chaque scénario : médiane de 7 calculs, puis clonage structuré du rapport (ce que coûte son transfert du worker à l'interface) :

| Scénario | Fichiers indexés | Rapport | Calcul (médiane · max) | Transfert : JSON · clonage |
|---|---|---|---|---|
| A. scripts chargés par le serveur | 841 | 5 fichiers, 3 erreurs, 2 informations, 5 problèmes détaillés | 0,97 ms · 1,6 ms | 2 Kio · 0,1 ms |
| B. tout `npc/` (variantes `re/` et `pre-re/` ensemble) | 1 133 | 106 fichiers, 1 070 faux doublons `RA0005`, 1 078 problèmes détaillés | 2,3 ms · 3,1 ms | 415 Kio · 4,3 ms |
| C. volume : le jeu A répliqué 6 fois | 5 046 | 4 170 fichiers, 146 460 problèmes, **détail coupé à 5 000** | 113–134 ms · 249–339 ms | 3 936 Kio · 31–33 ms |
| D. tous les `.txt` du serveur (portée par défaut), **restreint aux scripts chargés** (`only`) | 1 295 (841 chargés) | 53 fichiers, 535 problèmes détaillés (complets) ; 454 fichiers et 14 127 problèmes laissés de côté | — | — |

Vérifié à chaque scénario par des calculs **indépendants** du service : mêmes fichiers que ceux dont `diagnostics(uri)` n'est pas vide, mêmes diagnostics, totaux par gravité et par code exacts, ordre
(erreurs, avertissements, informations, chemin) et **positions ligne/colonne** recalculées sur le texte brut (CRLF compris) ; pour D, totaux, codes, fichiers examinés et fichiers laissés de côté égaux à une somme
indépendante des diagnostics de chaque fichier.

**Décision fondée sur une mesure : limite du détail à 5 000 problèmes.** Première version : 20 000. Le scénario C en donne 14,5 Mio de JSON et **111 ms** de clonage (~5 µs par problème, dans un cas où chaque
doublon cite tous ses jumeaux) : un à-coup visible du fil de l'interface pour des lignes que personne ne lit. À 5 000 : 3,9 Mio et ~31 ms. Les totaux restent exacts au-delà.

**Dans l'application réelle** — `scripts/e2e/real-server-smoke.ts` (serveur local ouvert comme projet, 1 295 fichiers indexés) :

| Mesure | Résultat |
|---|---|
| Rapport demandé → affiché, portée `sources` (restreint aux 841 scripts chargés, calcul des scripts chargés compris) | 35 ms |
| Même demande pour « tous les fichiers » (case décochée : le rapport est recalculé) | 43 ms |
| Rapport après passage à la portée « scripts chargés » | 2 ms |
| Vue restreinte (configuration par défaut : vérifications entre fichiers désactivées) | 4 fichiers : 3 erreurs, 0 avertissement, 1 information ; 454 fichiers laissés de côté |
| Vue complète | 76 fichiers : 12 700 erreurs, 884 avertissements, 4 informations |

Limites : une seule machine, Windows seulement ; le calcul du rapport tourne dans le worker de langage et retarde ses autres requêtes (complétion…) de sa durée (≈ 1 à 3 ms sur le serveur local, ≈ 0,1 s dans le cas extrême C) ; le
rendu de la liste n'est pas virtualisé (au plus 300 fichiers dessinés), et son coût n'a pas été isolé.

### Cartes des déclarations et labels réservés (M4-S3 a et b)

Mesuré sur le serveur local (`scripts/maps-report.ts`, `scripts/labels-report.ts`, un seul fil Node.js, registre de 667 commandes et catalogue de 27 826 objets… chargés) :

| Mesure | Résultat |
|---|---|
| Analyse des **841 scripts chargés** avec les contrôles de cartes (33 933 déclarations, 37 108 noms de carte confrontés à un oracle indépendant) | **1,4 s** — le temps de M4-S2 pour le même jeu (parseur ~1 s) : aucun surcoût mesurable |
| Analyse des mêmes scripts avec le contrôle des **12 010 labels** et fonctions locales (`RA0014`) | **1,4 s**, de même |
| Lecture des cartes chargées (`conf/map_athena.conf` + `maps_athena.conf` + `import`, 1 218 cartes) | comprise dans la lecture des listes de scripts (17 fichiers de configuration, ~37 ms) ; ajoutée au démarrage du serveur du projet dans l'application (bases lues ~160 ms après le registre, inchangé à la précision de la mesure) |
| Mutations (619 + 429 + 97 noms de carte, 2 886 noms de label) | chaque analyse d'un fichier modifié : quelques millisecondes ; ~10 s pour chaque outil |

Limites : une seule machine ; le coût propre des contrôles n'a pas été isolé (ils tiennent dans le bruit de l'analyse) ; la lecture des cartes dans l'application n'a pas été chronométrée seule.

### Ordre de chargement des fonctions (M4-S3c)

Mesuré sur le serveur local (`scripts/order-report.ts`, un seul fil Node.js, registre de 667 commandes) :

| Mesure | Résultat |
|---|---|
| Analyse des **841 scripts chargés** avec le registre | **1,1 à 1,3 s** selon les exécutions (1,4 s en M4-S3) : aucun surcoût mesurable |
| Diagnostics `RA0016` des **841 fichiers** sous un ordre donné (822 appels par leur nom, 149 fonctions) | **0,1 ms** en moyenne sur 183 ordres |
| Relecture de l'ordre à chaque synchronisation de l'index (portée « sources ») | lecture des 17 fichiers de configuration (~37 ms, mesure de M4-S1) ; la liste (~840 chemins) n'est renvoyée au service que si elle change |
| Application sur le serveur réel (fumée sur l'exécutable E2E) | rapport restreint aux scripts chargés affiché 37 ms après la demande (inchangé : 4 fichiers, 3 erreurs, 1 information) ; latence perçue de la complétion inchangée (1re à froid 14–27 ms, suivantes ≈ 12 ms) |

Limites : une seule machine ; le coût de la relecture de l'ordre n'a pas été chronométré seule dans l'application.

### Démarrage de l'application (M5-S1)

`scripts/e2e/startup.ts` lance l'exécutable réel (variante E2E, WebView2) 8 fois par situation et chronomètre depuis `spawn` (interrogation toutes les 15 ms), minimum / médiane / maximum en ms :

| Jalon | A. profil WebView2 neuf, avec un projet | B. profil déjà utilisé, avec un projet | C. profil utilisé, écran d'accueil |
|---|---|---|---|
| fenêtre WebView2 prête | 298 / 308 / 317 | 292 / 301 / 354 | 289 / 292 / 296 |
| **interface rendue** (`.workbench` ou `.welcome`) | **412 / 436 / 438** | **406 / 425 / 489** | **360 / 377 / 394** |
| explorateur rempli | 413 / 436 / 439 | 407 / 425 / 489 | — |
| projet indexé par le worker | 435 / 445 / 468 | 434 / 455 / 490 | — |
| premier fichier affiché dans Monaco, depuis son ouverture (Monaco est chargé à la demande) | 533 / 543 / 613 | 538 / 549 / 578 | — |

Cible du cahier des charges : application utilisable en **moins de 3 s** — **atteinte, pire mesure 489 ms**. Limites : variante E2E (même frontend et même cœur Rust, plus un crochet de test) et non l'exécutable distribué ; petit projet (12 scripts) ; cache du système de fichiers chaud ;
une seule machine ; le tout premier lancement d'une machine fraîche (antivirus, WebView2 à froid) n'est pas mesuré. Le serveur réel (1 295 fichiers `.txt`, 841 chargés) s'indexe en ~1,9 s après l'ouverture du projet (fumée sur l'exécutable).

## Cibles du cahier des charges
| Cible (CLAUDE.md §4) | Statut |
|---|---|
| Indexer au minimum 5 000 scripts | **Atteint pour l'indexation en mémoire** : ~6,8 s à froid sur la machine de référence, hors du fil de l'interface (Worker, pas encore branché sur tout le projet : l'indexation de projet est une tranche M3). Persistance SQLite/FTS5 non mesurée. |
| Démarrage < 3 s | **Non mesuré** (l'E2E vérifie le démarrage, pas sa durée). |
| Suggestions < 100 ms sur fichier indexé | **Atteint, mesuré dans l'application réelle** (voir « Assistance aux commandes ») : liste affichée **≈ 11 à 14 ms** après la touche (médiane ; max 17 ms en E2E, sur le serveur local avec 678 propositions de commandes comme avec 867 propositions d'objets), service 0,1 – 3,3 ms. Une machine, Windows seulement. |
| Pas de blocage de la saisie pendant l'analyse | Analyse de chaque document dans un Worker avec anti-péremption par version (vérifié fonctionnellement) ; latence de saisie **non mesurée**. |
| Fichiers de plusieurs milliers de lignes | Le plus gros script du corpus est analysé sans incident ; ouverture dans Monaco d'un très gros fichier **non mesurée**. |

## À mesurer ensuite
Durée de démarrage de l'exécutable ; ouverture d'un fichier de 10 000+ lignes dans Monaco ; latence de frappe pendant une
analyse ; latence perçue de l'aide de signature et du survol dans l'application ; complétion sur machine modeste et sous Linux ; mémoire du processus WebView2 ; indexation incrémentale (un fichier modifié) ; SQLite/FTS5 si la recherche
transversale l'exige ; machine modeste et Linux (`BLOCKED_EXTERNAL` pour Linux).
