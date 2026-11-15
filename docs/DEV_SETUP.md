# Installation de l'environnement de développement

## Prérequis
| Outil | Version testée | Remarque |
|---|---|---|
| Node.js | 22.15 (≥ 22) | |
| pnpm | 10.33 | `corepack enable`, puis `corepack prepare pnpm@10.33.0 --activate` |
| Rust | 1.93 stable | via [rustup](https://rustup.rs) |
| Windows | Visual Studio Build Tools (« Développement Desktop en C++ »), WebView2 | testé sur Windows 11 |
| Linux (Ubuntu) | paquets de la [documentation Tauri](https://v2.tauri.app/start/prerequisites/) : voir « Linux » ci-dessous | **construit et testé sous Ubuntu 26.04 (WSL2)** ; l'application graphique n'a pas été lancée |

Aucun NASM ni CMake n'est requis pour l'état actuel du projet.

## Linux (Ubuntu ; WSL2 convient)

Vérifié le 2026-11-15 (DEC-047) sur Ubuntu 26.04 dans WSL2, x86_64 : Node 22, pnpm 10.33, Rust 1.93 (rustup), les paquets ci-dessous.

```bash
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev patchelf curl wget file
# Node 22 (nvm, NodeSource ou le gestionnaire de votre choix), puis :  corepack enable && corepack prepare pnpm@10.33.0 --activate
# Rust : rustup (https://rustup.rs), toolchain stable
pnpm install --frozen-lockfile
pnpm check                                                       # types + ESLint + tests TypeScript
pnpm rust:check                                                  # clippy -D warnings + cargo test (workspace)
pnpm --filter @runeforge/desktop tauri build --no-bundle         # -> target/release/runeforge-studio (un ELF, sans extension)
```

- **Depuis Windows, `pnpm build:linux` fait tout cela dans WSL** (copie des sources, installation, construction) et dépose dans `target\release`, à côté du `.exe`, l'ELF brut (`runeforge-studio-linux-x86_64`, sans extension comme tout exécutable Linux) **et un AppImage** (`runeforge-studio-linux-x86_64.AppImage`, DEC-048). Le bundler d'AppImage télécharge puis exécute trois outils au premier usage : sans cache dans `~/.cache/tauri`, le script s'arrête tant que vous n'avez pas passé `--allow-download` ; `--no-appimage` ne construit que l'ELF. Détails et limites : `RELEASE.md`, « Construire pour Linux ». Il ne lance ni test ni clippy : pour cela, lancez `pnpm check` et `pnpm rust:check` dans la copie WSL.
- **Sous WSL, copiez les sources sur le disque de Linux** (`~/…`), pas sur `/mnt/c` : les binaires natifs de `node_modules` diffèrent d'un système à l'autre et `pnpm` ou `cargo` y sont lents et fragiles. Ne partagez jamais `node_modules` ni `target/` entre Windows et Linux.
- **Ce qui n'est pas pris en charge sous Linux** : `pnpm e2e` s'arrête avec un message (le scénario pilote WebView2, donc Windows seulement) ; il faudrait WebKit WebDriver, `tauri-driver` et un serveur d'affichage virtuel, non installés. L'exécutable construit n'a été **lancé qu'une fois, 20 secondes sous WSLg** (DEC-048 : il démarre et reste en vie) ; le rendu de WebKitGTK, Monaco, l'IME et le clavier restent inconnus (`KNOWN_LIMITATIONS.md`). Pour un essai rapide sous WSL : `GDK_BACKEND=x11 target/release/runeforge-studio`.
- Dépendances à l'exécution de l'exécutable construit : `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libssl3` (vérifiées par `ldd`). Aucun `.deb` ni `.rpm` n'est produit ; l'AppImage embarque WebKitGTK et GTK mais pas la glibc.

## Pièges connus (rencontrés le 2026-11-15, DEC-048)
- **N'utilisez jamais `npm install`** dans ce dépôt (le gestionnaire est pnpm, `packageManager` du `package.json`). Un `npm install tauri` ajoute l'ancien paquet npm `tauri@0.15.0` au `package.json` racine et crée un `package-lock.json` : le lockfile pnpm ne correspond plus, `pnpm install --frozen-lockfile` échoue (ou veut purger `node_modules`) et le CI aussi. L'outil de ligne de commande est `@tauri-apps/cli`, déjà déclaré dans `apps/desktop` et lancé par `pnpm --filter @runeforge/desktop tauri …`.
- **Après avoir déplacé ou renommé le dossier du projet**, `target/` garde l'ancien chemin absolu (`env!("CARGO_MANIFEST_DIR")`) : des tests Rust lisent alors un chemin qui n'existe plus (`crates/updater/tests`, 19 échecs « The system cannot find the path specified »). Remède : `cargo clean -p runeforge-filesystem -p runeforge-updater -p runeforge-studio -p runeforge-remote-transport -p runeforge-git` (les dépendances restent en cache). Le cache de Vite (`apps/desktop/node_modules/.vite`) garde aussi l'ancien chemin : le supprimer.

## Installation et vérification
```bash
pnpm install          # installe et lie les packages du workspace
pnpm check            # typecheck + lint + tests (Vitest)
pnpm build            # build du frontend
```

## Lancer l'application
```bash
pnpm --filter @runeforge/desktop tauri dev                       # développement (Vite + fenêtre native)
pnpm --filter @runeforge/desktop tauri build --no-bundle         # exécutable sans installateur
```
L'exécutable est produit dans `target/release/` (workspace Cargo à la racine du projet).

## Qualité et tests
```bash
pnpm check         # typecheck + lint + tests TypeScript (Vitest)
pnpm rust:check    # clippy -D warnings + cargo test (workspace)
pnpm check:all     # les deux
pnpm e2e           # E2E Windows : construit la variante e2e (target/e2e) puis lance le scenario sur l'executable reel
```
Le scenario E2E (Windows, WebView2) ecrit ses captures (`*.png`) et la latence mesuree de la completion (`completion-latency.json`) dans `target/e2e-artifacts` ; `pnpm e2e --skip-build` rejoue le scenario sans reconstruire l'executable. Les etapes qui pilotent la souris et la liste de completion de Monaco dependent du timing : sur une machine chargee, une etape peut echouer puis passer a l'execution suivante (voir `KNOWN_LIMITATIONS.md`). Linux : non pris en charge (`pnpm e2e` s'y arrete avec un message), voir « Linux » plus haut.

## Outils de développement
| Commande | Rôle |
|---|---|
| `pnpm exec tsx scripts/corpus-report.ts <dossier> [--examples N] [--json]` | Mesure le parseur sur un dossier de scripts `.txt` (plantages, perte de texte, diagnostics, débit). Lecture seule. |
| `pnpm exec tsx scripts/roundtrip-report.ts <dossier>` | Verifie que decoder puis reecrire chaque fichier redonne exactement les memes octets (RF-014). Lecture seule. |
| `pnpm exec tsx scripts/language-report.ts --server-root <racine> --entry npc/re/scripts_main.conf` (ou `<dossier>`) | Service de langage sur un corpus réel : définition de chaque `callfunc`/`goto` comparée à un oracle regex hors commentaires, latences, recherche de symboles, références, rapport de projet. Lecture seule. |
| `pnpm exec tsx scripts/registry-report.ts --server-root <racine du serveur>` | Registre de commandes lu dans le serveur (table, manuel), scripts chargés (comparés à l'implémentation de mesure indépendante), alertes `RA0006`/`RA0001` sur le code réel et **mutations contrôlées** (`--mutation-step N`). Lecture seule ; ~2 min. |
| `pnpm exec tsx scripts/commands-report.ts --server-root <racine du serveur> [--step N] [--json]` | Assistance aux commandes sur le code réel (M3-S3) : pour une instruction sur `N` (défaut 40), survol, complétion et aide de signature comparés à l'AST du parseur (bonne commande, bonne signature, rang de l'argument), silence aux positions interdites (nom de la commande, commentaire, hors script), latences, et modèles de NPC contrôlés contre le registre du serveur. Lecture seule ; ~1 min. |
| `node --expose-gc --import tsx scripts/catalog-report.ts --server-root <racine du serveur> [--mode re\|pre-re]` | Catalogue de références (objets, monstres, cartes, constantes) lu dans le serveur et **comparé à un analyseur YAML complet** (paquet `yaml`, dépendance de développement de ce seul outil) : ordre des fichiers, objets, monstres, constantes, **options aléatoires (`RDMOPT_`)**, cartes ; temps de lecture et de construction. Lecture seule ; ~5 s. |
| `node --expose-gc --import tsx scripts/references-report.ts --server-root <racine du serveur> [--examples N] [--mutation-step N] [--probe-step N]` | Vérification des références sur les scripts chargés : arguments en clair (carte, objet, monstre) cherchés dans le catalogue, par commande ; **mutations** de valeurs réelles (signalées au bon endroit, sans alerte parasite) ; survol et complétion du service sur des arguments réels ; latences. Lecture seule ; ~1 min. |
| `pnpm exec tsx scripts/project-report.ts --server-root <racine du serveur> [--json]` | Rapport de projet (RF-015) sur un vrai serveur, en quatre scénarios : **A.** scripts chargés (le rapport = exactement les fichiers dont `diagnostics(uri)` n'est pas vide, mêmes diagnostics, totaux exacts, ordre, **positions ligne/colonne vérifiées par un calcul indépendant** sur le texte brut), **B.** tout `npc/` (rapport volumineux), **C.** volume (jeu A ×6 : limite du détail, coût du transfert au worker), **D.** tous les `.txt` du serveur (portée par défaut) avec la restriction aux scripts chargés. Lecture seule ; ~30 s. |
| `node --import tsx scripts/maps-report.ts --server-root <racine du serveur> [--mutation-step N]` | Cartes des déclarations (M4-S3a) sur les scripts chargés : liste des cartes chargées comparée à un **lecteur indépendant**, chaque déclaration et chaque destination de warp confrontées à un **oracle indépendant** (faux positifs et négatifs), lignes `mapflag` sur une carte non chargée, **mutations** (carte inconnue, non chargée, destination de warp, mapflag). Lecture seule ; ~10 s. |
| `node --import tsx scripts/labels-report.ts --server-root <racine du serveur> [--mutation-step N]` | Labels réservés (M4-S3b, `RA0014`) : chaque label et fonction locale des scripts chargés (aucune fausse alerte attendue), puis **mutations** en commande, constante et paramètre (minuscules puis majuscules). Lecture seule ; ~10 s. |
| `node --import tsx scripts/order-report.ts --server-root <racine du serveur> [--shuffles N] [--seed N]` | Ordre de chargement et fonctions appelées par leur nom (M4-S3c, `RA0016`) : appels retrouvés par un **oracle qui lit le texte brut** (commentaires et chaînes effacés, accolades comptées), aucune alerte sur les scripts chargés, puis **ordres mutés** (fichier de fonctions chargé en dernier ou retiré, ordre inverse, mélanges), **définitions déplacées** en fin de fichier et **récursion injectée** : l'ensemble des appels signalés doit être exactement celui de l'oracle. Lecture seule ; ~45 s. |
| `node --import tsx scripts/wizards-report.ts --server-root <racine du serveur> [--samples N] [--seed N]` | Assistants de NPC (M6-S1, RF-017) confrontés à un vrai serveur : des saisies valides tirées au hasard (cartes chargées, objets, sprites et prix réels, textes avec guillemets, barres obliques, accents, couleurs) donnent un script qui doit être analysé **sans aucun diagnostic**, accepté par un modèle **indépendant** de l'analyse d'en-tête du serveur (`npc_parse_warp`, `npc_parse_shop`, `npc_parsesrcfile`) et produire la bonne déclaration ; puis des **témoins négatifs** (chaque saisie abîmée doit être refusée sur le bon champ). Lecture seule. |
| `pnpm exec tsx scripts/e2e/real-server-smoke.ts <exe-e2e> <racine du serveur> [fichier ...]` | Ouvre un vrai serveur comme projet dans l'exécutable E2E (après `pnpm e2e` pour le construire) : reconnaissance, registre, indexation, **rapport de projet** (par défaut, puis tous les fichiers), portée « scripts chargés », diagnostics des fichiers donnés. **Lecture seule** (aucune écriture dans le dossier du serveur). |
| `pnpm exec tsx scripts/analysis-report.ts <dossier>` ou `--server-root <racine> --entry npc/re/scripts_main.conf` | Analyse semantique + index : temps par phase, memoire (avec `node --expose-gc --import tsx`), diagnostics locaux et inter-fichiers. `--repeat N` replique le corpus (mesure sur ~5 000 fichiers), `--hints` active `RA0007`. Lecture seule. |

| `pnpm exec tsx scripts/e2e/startup.ts <exe-e2e> [--runs N]` | Démarrage de l'application réelle (M5-S1) : temps jusqu'à la fenêtre, l'interface rendue, l'explorateur, l'index et le premier fichier dans Monaco, sur profil WebView2 neuf et déjà utilisé, avec et sans projet. Dossiers temporaires uniquement ; ~2 min. |
| `pnpm exec tsx scripts/e2e/accessibility.ts <exe-e2e> [dossier-de-captures]` | Audit WebView2 sur onze écrans, dont l’aperçu de l’éditeur visuel et l’onglet Mises à jour. Il vérifie les noms accessibles, la langue, les contrastes de texte dans les deux thèmes et le parcours clavier des dialogues. |
| `pnpm exec tsx scripts/e2e/update.ts <exe-e2e> <dossier-de-captures>` | E2E des mises à jour signées (DEC-046) : un faux serveur GitHub local (`127.0.0.1`), l'exécutable E2E **copié** puis remplacé et relancé ; aucune requête ne quitte la machine. Lancé aussi par `pnpm e2e`. |
| `pnpm release:keygen --out <fichier hors du dépôt>` · `pnpm release:prepare --version X --notes notes.txt --artifact windows-x86_64=<exe> [--artifact linux-x86_64=<fichier>]` · `pnpm release:publish --repo propriétaire/dépôt --dir release-out/X [--yes]` | Outillage de release du propriétaire (clé de signature, manifeste signé, brouillon de release) : voir [`RELEASE.md`](RELEASE.md). `release:publish` n'envoie rien sans `--yes`. |
| `pnpm exec tsx scripts/licenses-report.ts [--json] [--markdown] [--list-all] [--target <triplet>]` | Inventaire hors ligne des licences des dépendances TypeScript et Rust classées par expression SPDX : composants livrés / de construction, permissives / copyleft / à examiner (`docs/LEGAL.md`, `docs/THIRD_PARTY_LICENSES.md`). La cible par défaut est `x86_64-pc-windows-msvc` ; `--target x86_64-unknown-linux-gnu` donne l'inventaire de l'exécutable Linux (`docs/THIRD_PARTY_LICENSES_LINUX.md`). |

Corpus utilisés pour les mesures (non inclus dans le dépôt produit) : `Serveur/rathena-kov/npc`,
`Serveur/upgraded-kov/npc`, `Document about NPC/sample` (voir `docs/TEST_MATRIX.md`).

## Conventions
- TypeScript `strict`, `noUncheckedIndexedAccess` ; pas de `any` sans justification.
- Packages internes consommés en TypeScript source (pas d'étape de build) — voir `DECISIONS.md` (DEC-003).
- Aucun commit ni push automatique ; les modifications restent dans l'arbre de travail jusqu'à instruction du propriétaire.
