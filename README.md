# RuneForge Studio

IDE desktop (Tauri 2 + React + TypeScript + Rust) pour développer des scripts **rAthena** et **Hercules**
(Ragnarok Online) sur Windows et Linux. *Nom de travail, à valider commercialement. Produit non officiel, sans lien avec Gravity.*

> **État réel (voir [`docs/STATUS.md`](docs/STATUS.md)).** Un éditeur de scripts fiable fonctionne sur **Windows** (l'application et son E2E ont été lancés) ; sous **Linux**, l'exécutable se construit et tous les tests passent (Ubuntu 26.04 sous WSL2) et l'exécutable a été **lancé 20 secondes sous WSLg (il démarre ; aucune interface n'y a été testée, pas d'E2E Linux)** :
> projets, explorateur, onglets, Monaco avec coloration, diagnostics de **syntaxe** et **sémantiques** (label inconnu
> ou en double, fonction locale non définie, et — sur demande — doublons et références non résolues entre fichiers),
> **navigation** (F12 / Ctrl+clic, plan, références avec Maj+F12, symboles du projet avec Ctrl+T), **complétion et survol**
> des symboles du projet (labels, fonctions, noms de NPC, variables), **renommage sûr** (F2) des labels et variables locales,
> le tout sur un index du projet construit en arrière-plan ; enregistrement sûr (octets préservés, encodages hérités, fins de
> ligne, détection des modifications externes), récupération après plantage, FR/EN, thèmes clair/sombre.
> La **bibliothèque rAthena intégrée** fournit hors ligne la complétion, l'aide au survol et les signatures des commandes. Pour un serveur
> **rAthena** reconnu dans le projet, l'application lit à l'exécution sa table de commandes et ses règles de chargement pour les vérifications
> propres au serveur : **commande inconnue** et **nombre d'arguments** sont signalés, l'index peut se limiter aux scripts que
> le serveur charge réellement, et les **commandes** sont proposées (complétion), documentées (survol, aide de signature avec le paramètre
> actif) et déclarables pour un fork (commandes du projet, action rapide Ctrl+.). Quatre **modèles de NPC** (`npc-script`, `npc-warp`,
> `npc-shop`, `npc-healer`) s'insèrent en tapant `npc-`. Les **bases du serveur** (objets, monstres, cartes, constantes) sont lues de la même
> façon : l'application propose et décrit ce que le serveur connaît, signale en information un objet, un monstre ou une carte **introuvable**, et
> permet de les rechercher et de les insérer (Ctrl+Maj+D).
> Le **rapport de projet** (Ctrl+Maj+M) liste, fichier par fichier et les plus graves d'abord, les problèmes de tous les fichiers indexés — pas
> seulement des fichiers ouverts — avec filtres, ouverture au clic à la position du problème, copie en texte, et, pour un serveur reconnu,
> seulement les scripts que le serveur charge par défaut (la documentation et les bases du serveur n'ont rien à y faire).
> Le serveur ne charge pas toujours ce qu'un script déclare : une déclaration sur une carte **que le serveur ne charge pas** (`conf/maps_athena.conf`) est ignorée par lui **sans aucun message** — l'application la signale, comme
> une carte inconnue de l'index et un **label qui porte le nom d'une commande, d'une constante ou d'un paramètre** (le serveur le refuse). Il lit aussi l'**ordre dans lequel le serveur charge ses scripts** : une
> fonction appelée **par son nom** avant d'être chargée (fichier chargé après, ou fonction définie plus bas) empêche le script de se charger — l'application le signale (`callfunc "Nom"`, résolu à l'exécution, n'est pas concerné).
> Le menu Fichier donne accès à quatre **assistants rAthena**, à l'**éditeur visuel de dialogues** et au **déploiement vers un dossier local** avec aperçu, sauvegarde et restauration des fichiers remplacés.
> Le panneau **Git** affiche les changements et les compare à `HEAD` après activation explicite pour le projet. Le journal de diagnostic local s'active dans Paramètres › Confidentialité.
> **Aide › Mises à jour…** installe une version plus récente depuis les **releases d'un dépôt GitHub** (privé ou non), **sous Windows et sous Linux** : manifeste signé par l'éditeur, vérifié avec une clé publique embarquée, un exécutable par système, jamais sans l'utilisateur ; la clé de production et la première release restent à créer ([`docs/RELEASE.md`](docs/RELEASE.md)).
> Hercules, SSH/SFTP, le graphe visuel général, la simulation et l'IA restent à réaliser. Les vérifications de l'interface couvrent Windows ; Linux est couvert par la construction et les tests (voir [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md), « Plateformes »).
> Le cahier des charges est dans [`CLAUDE.md`](CLAUDE.md).

## Structure

```text
apps/desktop/              Application Tauri 2 + React (src/) et coeur Rust (src-tauri/)
crates/filesystem/         Services de fichiers sûrs (racines approuvées, écriture atomique, récupération, historique)
crates/git/                Statut Git et lecture de fichiers dans HEAD
crates/updater/            Mises à jour signées : releases GitHub, manifeste minisign, téléchargement vérifié, remplacement de l'exécutable
packages/runescript-core/  Lexer sans perte, types, catalogue de diagnostics FR/EN (sans dépendance UI/OS)
packages/runescript-parser/ Parseur tolérant et AST avec plages de source
packages/runescript-analysis/ Symboles, portées de labels, références, index de projet, diagnostics sémantiques
packages/runescript-language-server/ Service de langage (forme LSP) : diagnostics, plan, définition, références, recherche de symboles
packages/emulator-core/    Registre de commandes sourcées, catalogue de références (objets, monstres, cartes, constantes), notation des arguments, règles de chargement `scripts_*.conf` (sans dépendance UI/OS)
packages/emulator-rathena/ Adaptateur rAthena : table des commandes, manuel, mode renewal, scripts chargés, bases `db/*.yml` et `map_index.txt` (lus dans les fichiers de l'utilisateur)
packages/npc-templates/    Modèles de NPC et assistants rAthena avec validation statique
packages/deploy-core/      Planification, exécution et restauration du déploiement
packages/visual-core/      Import en blocs et modifications ciblées de dialogues NPC
packages/project-core/     Codec d'encodage/EOL sans perte, configuration, préférences, session, diff, arbre
scripts/                   Mesures sur corpus (parseur, analyse, aller-retour), E2E Windows, outillage de release (scripts/release)
docs/                      STATUS, ROADMAP, DECISIONS, TEST_MATRIX, KNOWN_LIMITATIONS, RELEASE_CHECKLIST, RELEASE, DEV_SETUP,
                           LANGUAGE_SPEC, PERFORMANCE, COMPATIBILITY, SECURITY, LEGAL, ACCESSIBILITY,
                           GUIDE_UTILISATEUR (FR), USER_GUIDE (EN)
```

## Démarrage rapide

Prérequis et détails : [`docs/DEV_SETUP.md`](docs/DEV_SETUP.md) (Node ≥ 22, pnpm 10, Rust stable, outils C++ + WebView2 sous Windows ; sous Linux, les paquets WebKitGTK/GTK/OpenSSL listés dans la section « Linux »).

```bash
pnpm install
pnpm check:all                                    # typecheck + lint + tests TypeScript + clippy + tests Rust
pnpm --filter @runeforge/desktop tauri dev        # lance l'application en développement
pnpm --filter @runeforge/desktop tauri build --no-bundle   # exécutable dans target/release/ (runeforge-studio.exe, ou runeforge-studio sous Linux)
pnpm build:linux                                  # depuis Windows : construit dans WSL l'ELF Linux et un AppImage -> target/release/runeforge-studio-linux-x86_64[.AppImage]
pnpm e2e                                          # scénario E2E Windows sur l'exécutable réel (Windows seulement)
```

Aucun installateur Windows (MSI, NSIS) ni paquet `.deb`/`.rpm` n'est fourni ni testé : sous Windows l'application est l'exécutable seul ; sous Linux, `pnpm build:linux` produit l'ELF brut et un **AppImage** (lancé 20 s sous WSLg ; il exige une glibc aussi récente que celle de la machine de construction, voir [`docs/RELEASE.md`](docs/RELEASE.md)) ; `chmod +x` au premier lancement. Publier une version que les utilisateurs installent depuis l'application : [`docs/RELEASE.md`](docs/RELEASE.md) (`pnpm release:keygen`, `release:prepare`, `release:publish`).

## Garanties de fiabilité (vérifiées)

- Ouvrir puis enregistrer **sans modification n'écrit rien** ; avec modification, seuls les octets modifiés changent
  (aller-retour identique sur 2 303 scripts réels, dont 58 en encodage hérité et 4 à fins de ligne mixtes).
- Un fichier modifié ailleurs n'est **jamais écrasé** sans décision explicite (comparaison, rechargement ou écrasement).
- Un caractère impossible à représenter dans l'encodage du fichier **bloque** l'enregistrement au lieu d'être remplacé.
- Les modifications non enregistrées survivent à un plantage (instantanés de récupération).
- Les écritures dans un projet ou une destination choisie passent par des racines approuvées et des chemins relatifs vérifiés côté Rust. L'application n'envoie pas de télémétrie.

## Sécurité par défaut

Les 27 commandes IPC sont explicitement autorisées. Rust valide les chemins et la CSP bloque les scripts inline et `eval`. Voir [`docs/SECURITY.md`](docs/SECURITY.md).
