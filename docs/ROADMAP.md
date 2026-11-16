# Feuille de route exécutable

Ordre de réalisation imposé par le mandat : **M0 → M9**, par tranches verticales courtes (code + tests + doc).
Chaque tranche se termine par la mise à jour de [`STATUS.md`](STATUS.md). Les durées ne sont volontairement pas estimées.

Légende des dépendances : `→` « nécessite ».

## M0 — Fondations *(VERIFIED, CI verte sur GitHub)*
- [x] Monorepo pnpm, TypeScript strict, Vitest, ESLint, application Tauri 2 + React qui démarre.
- [x] Lexer sans perte, parseur tolérant, mesure sur corpus réel (`scripts/corpus-report.ts`).
- [x] Documents de pilotage.
- [x] Exécution de la CI sur runners GitHub : verte sur `master` (7 tâches sur `998ff6c`, 2026-11-15 ; `STATUS.md`, « Publication de 0.1.0-beta.1 »).

## M1 — IDE desktop *(VERIFIED sur Windows)*
- [x] **M1-S1** Workspace Cargo + `crates/filesystem` (chemins sûrs, lecture, écriture atomique, conflit externe, récupération, historique) + tests Rust.
- [x] **M1-S2** Commandes Tauri minimales + manifeste de permissions (`build.rs`), dialogue de dossier, hook E2E (feature `e2e`).
- [x] **M1-S3** `project-core` : codec encodage/BOM/EOL sans perte (→ M1-S1), configuration de projet `.runeforge/project.json` + migrations, diff de lignes.
- [x] **M1-S4** UI : mise en page redimensionnable, explorateur, onglets, Monaco (coloration par le lexer), barre d'état, palette de commandes, thèmes, FR/EN.
- [x] **M1-S5** Sauvegarde sûre bout en bout, récupération après crash, historique local, restauration de session, E2E (CDP/WebView2).

## M2 — Moteur de langage *(VERIFIED sur Windows ; Hercules non vérifié)*
- [x] Lexer sans perte, parseur tolérant, mesure sur corpus (voir M0), lexer par ligne pour la coloration.
- [x] **M2-S1** `runescript-analysis` : portées (NPC, fonctions globales/locales, labels), table de symboles par fichier,
  références de labels et de fonctions, variables, `WorkspaceIndex` inter-fichiers incrémental ; diagnostics `RA0002/3/4/5/7/11/12/13`.
  Règles prouvées dans `script.cpp`/`npc.cpp` (DEC-019) ; 53 tests ; corpus réel 0 faux positif local ; diagnostic visible dans l'IDE (E2E).
- [x] Mesures de performance sur 5 000 scripts (`docs/PERFORMANCE.md`, `scripts/analysis-report.ts --repeat 6`).
- ~~Registre de commandes et diagnostics dépendant d'un profil~~ → **reclassés en M4** (DEC-022).

## M3 — IntelliSense / LSP *(VERIFIED sur Windows ; commandes : rAthena seulement)* (→ M1, M2)
- [x] **M3-S1 (VERIFIED : 388 tests, E2E 17/17 sur l'exécutable réel, corpus réel)** Service de langage en Web Worker (protocole typé calqué sur LSP, anti-péremption par version) ; indexation du
  projet ouvert ; symboles du document, définition, références, recherche de symboles (labels, fonctions, NPC).
- [x] **M3-S2 (VERIFIED : 429 tests, E2E 21/21, corpus réel)** Complétion contextuelle (labels, fonctions locales et globales, noms de NPC, variables), survol des symboles du projet, renommage sûr des labels et variables locales.
- [x] **M3-S3 (VERIFIED : 731 tests, E2E 28/28, serveur réel)** Complétion, aide de signature et survol des commandes (à partir du registre de
  M4-S1), commandes personnalisées déclarables dans le projet (RF-011), action rapide « déclarer cette commande », modèles de NPC
  `npc-script`/`npc-warp`/`npc-shop`/`npc-healer` (RF-013, rAthena) ; latence de complétion mesurée dans l'application réelle ; warp à trois
  valeurs d'en-tête accepté comme par le serveur (correction du parseur).
- Reclassé en M4-S2 (dépend des bases de données) : complétion des **arguments** d'une commande selon leur type (carte, objet, monstre, constante).

## M4 — Émulateurs et bases (→ M2)
- [x] **M4-S1 (VERIFIED : 585 tests, E2E 23/23, serveur réel)** Adaptateur rAthena (`emulator-core`, `emulator-rathena`) : registre de commandes lu **à
  l'exécution** dans le serveur de l'utilisateur (table du code source, manuel, `script_def.inc`), reconnaissance du serveur dans le projet
  (racine, mode `re`/`pre-re`), règles de chargement `scripts_*.conf` (`npc:`/`import:`/`delnpc:`), portée d'index « scripts chargés par le
  serveur », diagnostics `RA0001` (commande inconnue) et `RA0006` (nombre d'arguments).
- [x] **M4-S2 (VERIFIED : 833 tests, E2E 32/32, serveur réel)** Catalogue de références lu **à l'exécution** dans le serveur de l'utilisateur (`db/item_db.yml` et `mob_db.yml` avec leurs imports selon
  le mode, `map_index.txt`, `const.yml`, `script_constants.hpp` : 27 826 objets, 2 555 monstres, 1 248 cartes, 10 303 constantes, **identique à un analyseur YAML complet**) ; nature des arguments
  déduite du manuel ; `RA0008`–`RA0010` (carte, objet, monstre introuvables) ; complétion et survol des références et des constantes ; recherche et insertion (RF-012, Ctrl+Maj+D) ;
  constantes du projet. (`mapflags.txt` n'est pas une base mais un manuel : rien à lire.)
- [x] **RF-015 (VERIFIED : 897 tests, E2E 34/34, serveur réel)** Rapport de projet (Ctrl+Maj+M) : `LanguageServer.projectReport()` (problèmes de tous les fichiers indexés avec position, totaux par gravité et
  par code, plus graves d'abord, détail borné à 5 000), instantané « périmé » recalculé seulement s'il est à l'écran, **restreint par défaut aux scripts que le serveur charge** (restriction faite par le
  service), problèmes de `scripts_*.conf` listés avec `fichier:ligne`, filtres, ouverture au clic, copie en texte ; l'E2E a aussi révélé et fait corriger un débordement de la page avec 12 onglets ou plus.
- [x] **M4-S3 a et b (VERIFIED : 939 tests, E2E 35/35, serveur réel)** Cartes des déclarations : `map:`/`delmap:` lus comme `map_config_read`, `RA0008` étendu aux déclarations et destinations de warp, **`RA0015`** (déclaration sur une carte que
  le serveur ne charge pas : ignorée sans message) ; **`RA0014`** (label portant le nom d'une commande, d'une constante ou d'un paramètre : `set_label: invalid label name`) ; preuves sur le serveur local : oracles indépendants, mutations, 0 faux positif.
- [x] **M4-S3c (VERIFIED : 980 tests, E2E 36/36, serveur réel)** Ordre de chargement des fonctions : **`RA0016`** (appel par son nom d'une fonction que le serveur ne connaît pas encore : fichier chargé après, plus bas dans le fichier, ou récursion ;
  `parse_callfunc` / `npc_parse_function`) à partir de l'ordre des `scripts_*.conf`, en portée « sources » comme « loaded » ; preuves sur le serveur local : 822 appels par nom, 0 alerte, 150 426 verdicts sous 183 ordres mutés identiques à un oracle indépendant.
- [x] **M4-S3d (VERIFIED : 998 tests, E2E 36/36, serveur réel)** Constantes d'options aléatoires `RDMOPT_<Option>` (créées par le serveur à la fin du chargement de `db/item_randomopt_db.yml`) lues dans le catalogue : 249 sur le serveur local, 10 552 constantes en tout,
  identiques à un analyseur YAML complet ; `docs/COMPATIBILITY.md` (matrice, liste de contrôle Hercules).
- [ ] **Suite de M4** adaptateur Hercules (`BLOCKED_EXTERNAL` : à vérifier sur un serveur Hercules) ; `RC0001`–`RC0003` (compatibilité entre profils) ; autres natures d'arguments (compétences, quêtes, groupes d'objets).

## M5 — Release V1 (→ M1–M4)
- [x] **M5-S1 (VERIFIED : 1 007 tests, E2E 36/36, audit d'accessibilité)** Démarrage mesuré dans l'application réelle (interface utilisable en 0,36–0,49 s pour une cible < 3 s) ; audit d'accessibilité automatisé (noms, langue, contrastes clair/sombre, clavier, dialogues) qui a trouvé et fait corriger
  trois défauts (palette de commandes : Tab, Échap et focus ; deux listes sans nom).
- [x] **M5-S2 (documentation vérifiée)** `SECURITY.md`, `LEGAL.md` avec l'inventaire hors ligne des licences (250 composants livrés), `ACCESSIBILITY.md`, guide utilisateur FR/EN, `RELEASE_CHECKLIST.md` réécrite avec ses preuves.
- [x] **M5-S3** Journal de diagnostic local facultatif, rotation et contrôle des événements côté Rust (DEC-037).
- [x] **M5-S4 (VERIFIED contre un faux GitHub local : 1 713 tests TypeScript, 165 tests Rust, E2E 44/44 + 9/9)** Mises à jour signées depuis les releases d'un dépôt GitHub (DEC-046) : `crates/updater` (manifeste signé minisign, politique réseau, téléchargement vérifié, remplacement de l'exécutable avec retour arrière), commandes `update_check`/`update_install`, Paramètres › Mises à jour (jeton en mémoire seulement), outillage `release:keygen/prepare/publish`, `docs/RELEASE.md`.
- [x] **M5-S5 (VERIFIED en construction et tests sous Ubuntu 26.04/WSL2, sans fenêtre : 1 728 tests TypeScript, 183 tests Rust sous Linux et 180 sous Windows, mutations 12/12 sous Linux, E2E Windows 44/44 + 9/9)** Mises à jour sous Linux (DEC-047) : une release signée pour Windows et Linux, remplacement atomique d'un ELF en cours d'exécution avec ses droits recopiés, contrôle d'en-tête propre à chaque système, TLS d'OpenSSL sans liste de certificats embarquée (`webpki-root-certs` retiré), `release:prepare --artifact <plateforme>=<fichier>`, inventaire des licences Linux (`THIRD_PARTY_LICENSES_LINUX.md`).
- [x] Clé de signature de production créée (`pnpm release:keygen`) et **première release 0.1.0-beta.1 publiée** le 2026-11-15 (pre-release, canal bêta ; binaires bruts Windows **et** Linux).
- [ ] **Mises à jour, ce qui reste (action du propriétaire)** : publier une seconde release et vérifier, depuis un exemplaire de la première, **une mise à jour réellement installée** contre le vrai GitHub (TLS) — `BLOCKED_EXTERNAL`.
- [ ] **Linux, ce qui reste** : lancer l'application (rendu de WebKitGTK, Monaco, IME, clavier, démarrage, accessibilité) et dérouler une vraie mise à jour dans la fenêtre — sur une machine de bureau Linux, ou ici avec WebKit WebDriver, `tauri-driver` et un serveur d'affichage virtuel (téléchargements à autoriser) ; autres distributions, ARM, AppImage/`.deb`/`.rpm`.
- [ ] Installateur, signature de code, licence, paquets Linux, essai au lecteur d'écran, `pnpm audit`/`cargo audit` (`BLOCKED_EXTERNAL`).

## M6 — Assistants et serveur (→ M5)
- [x] **M6-S1** Quatre assistants rAthena (portail, téléporteur, boutique et soigneur) avec aperçu et validation statique.
- [x] **M6-S2** Panneau Git de lecture seule avec statut et comparaison à `HEAD` (vérifié sous Windows).
- [x] **M6-S3** Déploiement vers un dossier local avec dry-run, sauvegarde et restauration (vérifié sous Windows).
- [x] **Aperçu SFTP en lecture seule** : comparaison de scripts enregistrés avec un dossier distant (`crates/remote-transport`, commande `sftp_dry_run`, `SftpDialog`), clé d'hôte épinglée, accord par boîte de dialogue native, client OpenSSH du système. Testé hors ligne seulement (flux simulés ; aucun essai contre un vrai serveur SSH, aucune étape E2E) : voir `STATUS.md` et `KNOWN_LIMITATIONS.md`.
- [ ] Assistants supplémentaires (buffer, quête) et **transfert** SSH/SFTP (téléversement, sauvegarde et restauration distantes) avec validation sur un serveur de test.

## M7 — Studio visuel (→ M2)
- [x] **M7-S1** Édition par blocs de dialogues avec import partiel, code brut verrouillé, aperçu et modifications ciblées (vérifiée sous Windows).
- [x] **M7-S2** Constructeur de NPC par glisser-déposer depuis la bibliothèque intégrée, aide hors ligne, arguments, ordre du flot et branches `if/else` avec commandes déposées ou ajoutées au clavier dans chaque branche; génération et validation locale avant création du fichier.
- [x] **M7-S2b** (2026-11-14, à la demande de l'utilisateur) Le constructeur est un **éditeur de nœuds** : des nœuds aux prises d'entrée et de sortie, des fils courbes tirés à la souris (ou activés au clavier), un canevas sombre ; le script suit les fils (DEC-042).
- [x] **M7-S3** Import temporaire d’extensions déclaratives JSON pour ajouter des commandes statiques; aucun code ni permission d’exécution n’est accepté.
- [ ] Relecture d'un script **existant** en graphe modifiable (le constructeur en nœuds crée ses NPC, il ne les relit pas), conversion de constructions supplémentaires (`select`/`menu` à plusieurs sorties, `goto`, boucles), annulation et rétablissement dans le dialogue.

## M8 — Simulation + IA (→ M7)
- [x] **M8-S1** Simulateur borné de dialogues, choix et conditions; les opérations non prises en charge s’arrêtent explicitement.
- [x] **M8-S1b** Simulateur complet des dialogues (paquet `simulation-core`, DEC-043) : variables de toute portée, tableaux, `switch`, boucles, `callsub`/`callfunc`/`getarg`, `input`, `close2`, quêtes et inventaire, `OnInit` ; ce que le serveur calcule est noté « non simulé » ou « supposé » au lieu d'arrêter le dialogue. Sur les 9 208 NPC du serveur (73 664 parties), 99,9 % des parties vont jusqu'à une fin, contre 32,8 % avant ; 0 opération non prise en charge.
- [x] **M8-S2** Fournisseur compatible OpenAI, consentement par requête et destination distante, clé éphémère, validation locale et comparaison avant/après avant la création explicite d’un nouveau fichier.
- [x] **M8-S1c** Le simulateur ne s'arrête plus sur une erreur (DEC-044) : une opération que le serveur refuserait est notée « Opération invalide » et le dialogue continue avec une valeur de repli ; les fonctions des autres fichiers du projet sont exécutées (index de l'espace de travail et lecture des fichiers) ; un NPC avec erreurs de syntaxe, un corps non fermé ou un gros fichier (jusqu'à 4 Mi caractères) est joué au lieu d'être refusé. Seules les limites de ressources interrompent une partie.
- [x] **M8-S1d** La classe du personnage de test se choisit par son vrai nom (DEC-045) : la liste déroulante des 153 classes vient de `job_name()` et de `map_msg.conf` du serveur (ce que renvoie `jobname()`) et remplace le champ numérique « Class ID ».
- [ ] Simulation : déclenchement des événements (`OnTimer`, `OnTouch`, `donpcevent`), essai avec un lecteur d'écran.
- [ ] Vérification d’intégration sur un fournisseur local et un fournisseur distant réels, puis revue indépendante de la surface réseau.

## M9 — Studio avancé (→ M6–M8)
- [x] **M9-S1** Manifeste déclaratif versionné et limité aux commandes statiques; aucune permission ni exécution de code d’extension.
- [ ] Exécution contre un serveur de test réellement isolé, extensions persistantes/gestion des permissions, audit des dépendances et finalisation.

## Prochaine étape exécutable
**M4 — Références de compétences rAthena.** Ajouter la lecture de `db/skill_db.yml` et de ses imports, puis vérifier le catalogue pour les deux modes et les surcharges locales. Voir « Point de reprise » dans [`STATUS.md`](STATUS.md).

Dernière validation des preuves : 2026-11-10 · commit ebf2bf0+local-changes.
