# Décisions d'architecture (ADR courtes)

Format : contexte → décision → conséquences. Les décisions marquées **hypothèse** sont provisoires
et doivent être revues au jalon indiqué. Date de la première session : 2026-11-05.

---

## DEC-001 — Emplacement du projet et gestion du dépôt git

- **Contexte** : le projet est demandé dans le dossier `Software/` du dépôt `KingdomOfValhalla`,
  qui est déjà un dépôt git (serveur rAthena, NPC, portail web).
- **Décision** : le monorepo RuneForge Studio vit dans `Software/` (cette racine joue le rôle de
  `runeforge-studio/` de CLAUDE.md §5.4). Aucun `git init` imbriqué. Aucun commit ni push n'a été
  fait (CLAUDE.md §0 règle 14) ; les fichiers sont simplement présents dans l'arbre de travail.
- **Conséquences** : `Software/.gitignore` couvre `node_modules`, `dist`, `target`. Les chemins
  de CI ou de release devront tenir compte du sous-dossier. Aucun fichier hors de `Software/` n'a
  été modifié.

## DEC-002 — Versions des outils, figées et vérifiées à l'installation

- **Contexte** : CLAUDE.md §5.1 interdit d'inventer des numéros de version.
- **Décision** : les versions sont celles résolues par `pnpm add` / `cargo add` le 2026-11-05,
  enregistrées en version exacte (`.npmrc` : `save-exact=true`) et verrouillées dans
  `pnpm-lock.yaml` et `apps/desktop/src-tauri/Cargo.lock`.
- **Exception — TypeScript fixé à 6.0.3** : `latest` est 7.0.2, mais `typescript-eslint` 8.72.1
  déclare `typescript >=4.8.4 <6.1.0`. Plutôt que d'utiliser un lint hors plage supportée,
  TypeScript est fixé à la dernière version compatible (6.0.3).
- **À revoir** : quand `typescript-eslint` annonce le support de TypeScript 7.

## DEC-003 — Packages internes consommés directement en TypeScript source

- **Décision** : `@runeforge/runescript-core` expose `./src/index.ts` via `exports` ; aucune étape de
  build intermédiaire. Vite, Vitest et `tsc` (résolution `Bundler`) le consomment tel quel.
- **Conséquences** : plus simple en V1. À revoir si un package doit être publié, exécuté hors
  Vite/Vitest (ex. worker CLI), ou si le temps de typecheck devient pénalisant.
- Le package est typé avec `lib: ["ES2022"]` et `types: []` : il ne peut pas utiliser le DOM ni
  Node, ce qui protège la frontière « le moteur ne dépend ni de l'UI ni de l'OS » (CLAUDE.md §5.3).

## DEC-004 — Convention d'offsets (hypothèse)

- **Décision** : tous les offsets sont des *code units UTF-16*, base 0, `start` inclus, `end` exclus,
  relatifs au texte décodé **sans BOM**. `SourceDocument.bom` mémorise la présence du BOM pour
  réécriture à l'identique.
- **Raison** : identique aux index de `String` JavaScript, aux offsets de Monaco et aux colonnes
  LSP par défaut ; évite toute conversion dans le chemin chaud.
- **À confirmer** : à T-014 (lecture/écriture de fichiers), avec des tests byte-level BOM/CRLF/LF.
  Les lignes (LF, CRLF, CR seul) et leur conversion en (ligne, colonne) restent à définir.

## DEC-005 — Périmètre du lexer de la session 1 (hypothèse)

- **Contexte** : le backlog (§18) limite la première session à T-001–T-003, mais la consigne de
  lancement (§24) demande aussi « un premier test du lexer ».
- **Décision** : un lexer minimal, écrit à la main (pas de regex comme parseur), est livré avec
  tests. **T-005 n'est pas considéré comme terminé** : T-004 (corpus de fixtures) et T-006 (BOM,
  cas réels) restent à faire.
- **Choix de conception** (voir `docs/LANGUAGE_SPEC.md`) :
  - tout caractère appartient à exactement un token (espaces, tabulations, fins de ligne,
    commentaires et caractères inconnus compris) → concaténation des tokens == texte source ;
  - une chaîne non fermée s'arrête avant la fin de ligne (récupération d'erreur), ce qui n'est
    **pas** une affirmation sur le comportement de rAthena/Hercules ;
  - préfixes de variables `.@ . @ $@ $ ## # '` et suffixe `$` d'après CLAUDE.md §6.1.
- **Non vérifié** : ces règles n'ont pas été confrontées aux sources rAthena/Hercules ni à un
  corpus réel. Elles seront validées en M2 ; les diagnostics ne doivent pas les présenter comme
  « erreur certaine » avant cela.

## DEC-006 — Shell Tauri minimal et sécurité par défaut

- **Décision** :
  - un seul `main.rs` (pas de séparation `lib.rs` pensée pour le mobile : cible Windows + Linux) ;
  - **aucune commande IPC** exposée, capability `default` sans aucune permission : le frontend
    n'appelle aucune API Tauri pour l'instant ;
  - CSP stricte en production (`default-src 'self'`, pas de script/style inline) ; CSP assouplie
    **en développement uniquement** (`devCsp`) pour le rechargement à chaud de Vite ;
  - `bundle.active = false` : on ne livre ni MSI/NSIS/AppImage/deb tant que leurs prérequis
    n'ont pas été testés (CLAUDE.md §5.1) ;
  - identifiant provisoire `dev.runeforge.studio` (nom de travail ; changer l'identifiant modifie
    les dossiers de données de l'application, à figer avant toute distribution).
- **À revoir** : la CSP devra autoriser les workers de Monaco (`worker-src blob:`) à T-010.

## DEC-007 — Icône placeholder

- **Décision** : icône géométrique originale générée par script (losanges), conservée sous
  `apps/desktop/src-tauri/icons/source.png`. Seuls les formats Windows/Linux référencés dans
  `tauri.conf.json` sont gardés. Aucune ressource graphique du jeu (CLAUDE.md §0 règle 9, §12.2).

## DEC-008 — Pas de test Rust pour l'instant

- Le code Rust ne contient aucune logique (démarrage Tauri). Les tests Rust arriveront avec le
  premier service de fichiers (T-014). La vérification du shell se limite au build et au
  démarrage de l'exécutable (voir `docs/STATUS.md`).

## DEC-009 — Interface en français uniquement pour l'instant

- Les textes de l'écran de socle sont en français en dur. L'internationalisation FR/EN est prévue
  en M1 (CLAUDE.md §4, §17).

---

## DEC-010 — Découpage des packages du moteur (écart assumé avec le prompt)

- **Contexte** : le prompt de mandat cite `runescript-lexer`, `runescript-ast`, `runescript-parser`… à titre indicatif ;
  `CLAUDE.md` §5.4 précise de ne créer un package que lorsqu'un morceau fonctionnel le nécessite.
- **Décision** : le lexer et les types partagés vivent dans `runescript-core` ; l'AST et le parseur dans
  `runescript-parser`. Séparer `lexer` et `ast` n'apporte aucun bénéfice vérifiable aujourd'hui (aucun consommateur
  n'a besoin de l'un sans l'autre). Les packages `runescript-analysis`, `runescript-language-server`, `emulator-*`, etc.
  seront créés aux jalons qui les utilisent.

## DEC-011 — Règles de syntaxe dérivées du serveur, pas d'une grammaire supposée

- **Décision** : les points ambigus sont tranchés par la lecture de `Serveur/rathena-kov/src/map/script.cpp` et des
  scripts réels, et fixés par des tests de régression : mots commençant par un chiffre (`4_DR_KID_01`,
  `$2011_agit_invest`), suffixe `$` sur tout mot, condition `if (a)&&(b)` = expression complète, `cmd (x)` =
  expression sauf virgule après la première valeur, chaînes `else if` itératives (plusieurs centaines).
- **Tolérances du serveur** (`x = 1:` ou `x = (1));` ou `,` dans un `for`) : un seul diagnostic, sans cascade.
- **Limite** : validé sur rAthena uniquement (voir `KNOWN_LIMITATIONS.md`).

## DEC-012 — Documentation du serveur lue à l'exécution, jamais embarquée (remplacée par DEC-041)

- **Contexte** : `script_commands.txt` et `mapflags.txt` (GPL) sont fournis avec chaque serveur rAthena/Hercules et
  partagent le même format (`*commande <arguments>` suivi du texte).
- **Décision historique** : un importateur de documentation locale (M4) lisait ces fichiers dans le projet de l'utilisateur.
  Cette décision a été remplacée par DEC-041 à la demande du propriétaire.

## DEC-013 — CI écrite mais non exécutée

- **Décision** : `.github/workflows/ci.yml` est placé dans `Software/` (le dépôt git englobant est `KingdomOfValhalla`).
  GitHub ne lit que `.github/` à la racine du dépôt : le fichier devra être déplacé/copié à la racine du dépôt, ou le
  projet extrait dans son propre dépôt. Il n'a jamais tourné ; son statut est `BLOCKED_EXTERNAL`.
- **Mise à jour (DEC-048, 2026-11-15)** : le projet est maintenant à la racine de son propre dépôt ; le fichier a été réécrit sans le préfixe `Software/`.
  Il n'a toujours pas tourné sur un runner GitHub (`BLOCKED_EXTERNAL`).
- **Mise à jour (2026-11-15)** : le CI a tourné sur GitHub et est vert sur `master` (`f98807a`, `3d4d36c`, `998ff6c` ; série de `998ff6c` : 7 tâches, dont l'E2E Windows et la construction Tauri sous Windows et Ubuntu). Le statut `BLOCKED_EXTERNAL` ci-dessus est levé ; voir `STATUS.md`, « Publication de 0.1.0-beta.1 ».

---

## DEC-014 — Modèle de sécurité des fichiers : racines approuvées, jamais de chemin absolu côté interface

- **Décision** : le frontend désigne un fichier par `(identifiant de racine, chemin relatif)`. Une racine n'existe que si
  l'utilisateur l'a choisie dans la boîte de dialogue native (ou dans la liste des projets récents, tenue par Rust). Chaque
  chemin est validé (`..`, absolu, noms réservés Windows, flux NTFS `:`, caractères de contrôle), canonicalisé, puis comparé
  à la racine : un lien symbolique sortant est refusé. Les contenus transitent en octets (aucune conversion côté Rust).
- **Garanties d'écriture** : remplacement atomique (fichier temporaire voisin + `fsync` + `rename`), précondition SHA-256 du
  dernier état lu (`mustMatch`), création sans écrasement (`mustNotExist`), refus des fichiers en lecture seule, copie de la
  version précédente dans l'historique local.
- **Surface IPC** : 20 commandes, déclarées dans `command_names.rs`, générées en permissions `allow-*` par le manifeste
  d'application (`build.rs`) et accordées une à une dans `capabilities/default.json` ; un test vérifie la cohérence.
- Voir `crates/filesystem` (42 tests).

## DEC-015 — Document = octets décodés sans perte ; texte de l'éditeur normalisé en LF

- **Décision** : à l'ouverture, détection BOM → UTF-8 strict → encodage hérité (défaut `windows-1252`, configurable) ; les
  octets doivent être reproduits à l'identique (sinon repli octet-pour-octet). L'éditeur manipule un texte en `\n` ; à
  l'enregistrement, `restoreEol` réapplique les fins de ligne d'origine (diff de lignes pour les fichiers mixtes). Un caractère
  non représentable bloque l'enregistrement (aucun remplacement) et propose la conversion explicite en UTF-8. Un document
  inchangé n'est jamais réécrit.
- **Table windows-1252 explicite** : le `TextDecoder` de Node décode `0x80` en `U+0080` (ISO-8859-1) contrairement au
  standard WHATWG suivi par WebView2 ; la table est donc codée en dur pour un comportement identique partout.
- **Preuve** : 2 303 fichiers réels restitués octet pour octet.

## DEC-016 — CSP : `style-src 'unsafe-inline'` accepté pour Monaco, `script-src` reste strict

- **Contexte** : Monaco insère des éléments `<style>` à l'exécution ; un `style-src` sans `'unsafe-inline'` casse l'éditeur.
- **Décision** : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:;
  worker-src 'self'; connect-src ipc: http://ipc.localhost`. Aucun script inline, aucun `eval`, aucun accès réseau. Les workers
  sont servis par l'application elle-même (pas de `blob:` en production). L'E2E échoue à la moindre violation de CSP.
- **Risque résiduel** : l'injection de styles est moins dangereuse que celle de scripts mais reste une surface ; à revoir si
  Monaco expose une option de nonce.

## DEC-017 — E2E par protocole de débogage de WebView2, variante de build dédiée

- **Décision** : le scénario pilote l'exécutable réel via `--remote-debugging-port` (variable `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`).
  Un build `--features e2e` (dossier `target/e2e`, jamais distribué) pré-approuve un projet (`RUNEFORGE_E2E_PROJECT`), isole
  les données (`RUNEFORGE_E2E_DATA_DIR`) et expose `window.__RUNEFORGE_E2E__`. Le plantage est simulé par `taskkill /F`.
- **Limites** : Windows uniquement ; la boîte de dialogue native de choix de dossier n'est pas automatisée (couverte par test
  unitaire côté contrôleur). Linux : `tauri-driver` à mettre en place (`BLOCKED_EXTERNAL`).

## DEC-018 — Monaco 0.57 : points d'entrée explicites

- **Décision** : `monaco-editor/editor/editor.api` + `monaco-editor/features/register.all` + `…/editor/editor.worker?worker`.
  `editor.main` est évité car il embarque ~80 langages. Le bundle initial reste à ~104 Ko compressés ; Monaco (~1 Mo
  compressé) est chargé à la première ouverture de fichier.
- Pas de mock dans la version de production : les doublures (`FakeBackend`, `MemoryBuffer`) vivent sous `src/test/` et ne sont
  importées que par les tests.

## DEC-019 — Sémantique des labels, fonctions et noms de NPC : règles prouvées dans le serveur

- **Contexte** : les diagnostics `RA0002/3/4/5/11/12/13` ne valent que s'ils reproduisent le serveur. Plutôt que supposer,
  les règles ont été lues dans `Serveur/rathena-kov/src/map/{script,npc}.cpp` (rAthena **uniquement**, Hercules non vérifié).
- **Décisions et preuves** :
  - un script (corps de NPC ou de fonction globale) = un espace de noms de labels, réinitialisé à chaque `parse_script` ;
    labels et fonctions locales partagent la même table (`set_label`), insensibles à la casse ; un doublon est une erreur de
    chargement (`set_label: dup label`) → `RA0003` *certaine* ;
  - `function X;` jamais définie : `parse_script: function declared but not defined` + `unresolved function references`, le
    script n'est pas chargé → `RA0012` passée d'avertissement/probable à **erreur/certaine** (catalogue corrigé) ;
  - `goto`, `callsub` (`data_islabel || data_isfunclabel`), `menu` (positions impaires), `jump_zero` exigent un label → `RA0002` ;
  - `callfunc` et les noms de NPC utilisent des `strdb` **sensibles à la casse** (`strdb_alloc`, pas `stridb_alloc`) : les
    fonctions globales et noms uniques se comparent à l'identique, contrairement aux labels ; nom unique tronqué à
    `NPC_NAME_LENGTH` = 50 ;
  - une fonction globale redéfinie écrase la précédente (`Overwriting user function`, niveau info) et un nom de NPC en double est
    renommé (`Duplicate unique name … Renaming`) : `RA0011`/`RA0005` restent des **avertissements probables** (et leurs conseils
    ont été réécrits pour dire ce que fait réellement le serveur) ;
  - `On…` (insensible à la casse) = label d'événement exporté (`npc.cpp`) : jamais « inutilisé ».
- **Nouveau code** `RA0013` : `duplicate(X)` dont `X` est introuvable (`npc_parse_duplicate: original npc not found`).
- **Prudence** : pas de diagnostic de label dans un script dont l'analyse est incomplète (région brute, bloc non fermé, tronqué).

## DEC-020 — Copie et dédoublonnage des chaînes extraites du source (mémoire de l'index)

- **Mesure** : 44,2 Mo conservés pour l'index de 841 fichiers (23,1 Mo de source) — un nom de 13 caractères ou plus est, dans V8,
  un renvoi vers la chaîne d'origine, donc chaque nom conservé retenait le texte entier de son fichier.
- **Décision** : tout nom stocké dans une analyse passe par un `createInterner()` par fichier (copie détachée + dédoublonnage).
  Résultat : **21,3 Mo (−52 %)**, temps identique, 53 tests inchangés. Les analyses sont en outre de simples données
  (sans `Map`/`Set`/classe) : sérialisables et transmissibles d'un Worker.
- **Limite** : dépend d'un comportement interne du moteur JavaScript ; sans effet sur la correction. À remesurer si le moteur
  change (WebView2 = V8 comme Node, mais autre version).

## DEC-021 — Diagnostics inter-fichiers : réservés à un index complet ; l'éditeur n'émet que le local

- **Constat** (mesuré, 2026-11-05) : sur le dossier `npc/` complet, `RA0005` signale 1 070 « doublons » parce que `re/` et
  `pre-re/` sont des variantes **exclusives** (le serveur charge `npc/re/scripts_main.conf` en mode `#define RENEWAL`, `pre-re/`
  sinon — `map.cpp`). Sur l'ensemble réellement chargé (841 fichiers) : **0 doublon**, 0 diagnostic local, 1 vrai
  `callfunc "F_MercKafra"` non résolu (fonction définie seulement dans `pre-re/`).
- **Décision** : `WorkspaceIndex.crossFileDiagnostics` ne signale `RA0004`/`RA0013` que si l'appelant affirme que l'index couvre
  tous les fichiers chargés (`reportUnresolved`). Tant que les règles de chargement (`scripts_*.conf`, M4) ne déterminent pas
  l'ensemble indexé, l'éditeur n'affiche que les diagnostics **locaux** au document (`analyzeDocument`), qui sont fiables seuls.
- **Conséquence** : l'indexation de projet (lecture des `.conf`, remplissage de l'index par un Worker) est la prochaine
  tranche ; le mode renouvelé/pré-renouvelé sera un réglage du profil d'émulateur, pas une supposition.

## DEC-022 — Reclassement : diagnostics dépendant d'un registre de commandes ou d'une base, de M2 vers M4

- **Contexte** : la feuille de route plaçait en M2 « registre de commandes et diagnostics sémantiques/compatibilité » avec la
  mention « → M4 pour les adaptateurs ». `RA0001` (commande inconnue), `RA0006` (arité), `RA0008`–`RA0010` (carte, objet,
  monstre introuvables) et `RC0001`–`RC0003` (compatibilité) n'ont de sens que relativement à un **profil d'émulateur** et à
  des bases chargées ; sans eux ils produiraient des faux positifs sur n'importe quelle commande.
- **Décision** : ces diagnostics (déjà définis dans le catalogue, non émis) relèvent de M4. M2 est jugé sur ce qui ne
  dépend d'aucun profil : lexer, parseur, symboles, portées, références, index, diagnostics `RS*` et `RA0002/3/4/5/11/12/13`.
- **Preuve de non-régression du périmètre** : `docs/LANGUAGE_SPEC.md` liste précisément ce qui est émis et ce qui ne l'est pas.

## DEC-023 — Service de langage : positions LSP, texte de l'éditeur prioritaire, navigation sans aperçu Monaco

- **Positions** : le service (`runescript-language-server`) parle la forme LSP (`{ ligne, colonne }` en base 0, code units UTF-16).
  Elles ne dépendent pas du type de fin de ligne : un résultat reste valable que le fichier soit ouvert (texte normalisé en LF par
  l'éditeur) ou seulement indexé (CRLF d'origine, mixte, windows-1252…). Les offsets internes restent propres à chaque analyse.
- **Deux sources de texte** : les documents **ouverts** (texte de l'éditeur, analysé à chaque modification) priment sur le disque ;
  les autres fichiers de `sources` sont lus par lots, décodés dans le Worker et analysés. L'index ne garde **ni texte ni AST** des
  fichiers non ouverts : seulement l'analyse (symboles, références) et une table de lignes compacte. Avant toute requête de
  navigation, le délai d'analyse en attente est purgé : jamais de résultat calculé sur un texte périmé. Un document fermé sans
  enregistrer est relu depuis le disque.
- **Navigation** : Monaco n'affiche (aperçu, références) que des fichiers dont le modèle est ouvert. Plutôt que d'ouvrir des modèles
  fantômes, F12 / Ctrl+clic renvoient **une** définition et un `registerEditorOpener` confie l'ouverture à l'application (onglet,
  curseur) ; les **références** ont leur panneau (une ligne de code lue dans l'éditeur ou sur le disque, 500 résultats au plus) ;
  la recherche de symboles est une palette (Ctrl+T, ou `#` dans Ctrl+P).
- **Monaco 0.57** : les actions de navigation (F12, Maj+F12…) sont des `Action2`, non accessibles par `editor.getAction` ; Maj+F12
  est surchargé par `editor.addCommand` (le panneau remplace l'aperçu) et l'E2E déclenche **les vraies touches**, pas l'API.
- **Prudence** : `validation.crossFile` reste désactivé par défaut (DEC-021) et le service est forcé à `off` pendant l'indexation
  initiale (un index partiel produirait de fausses alertes).
- **Preuves** : `server.test.ts` (34), `controller-index.test.ts` (15), `App.navigation.test.tsx` (6), corpus réel
  (`language-report.ts`), E2E 17/17 sur l'exécutable.

## DEC-024 — Complétion, survol et renommage : contexte tiré du texte, résultats structurés, renommage « sûr par construction »

- **Contexte de complétion tiré du texte, pas de l'AST** : le code en cours de frappe est presque toujours invalide ; le contexte
  (argument de `goto`/`callsub`/`menu`/`jump_zero`, chaîne de `callfunc`, en-tête `duplicate(`, fragment de variable) est donc déduit
  des tokens de la ligne courante et des deux précédentes. `callfunc`, `goto` et `callsub` sont reconnus par leur **voisinage immédiat**
  (`mot <ici>` ou `mot(<ici>`), car ils s'emploient aussi dans une expression : la première version, fondée sur le début de
  l'instruction, ne proposait que 1 012 des 1 806 `callfunc` du corpus ; la version actuelle, 1 806/1 806.
- **Les commandes ne sont pas proposées** : elles n'ont de sens que relativement à un profil d'émulateur (DEC-022) ; proposer une liste
  inventée ferait croire à une garantie qui n'existe pas.
- **Survol structuré** : le service renvoie des données (type, portée, lignes, compteurs), jamais du texte rédigé ; `hover-text.ts` les
  met en forme dans la langue de l'interface (FR/EN, parité testée).
- **Renommage sûr par construction** : il n'est offert que lorsque **toutes** les occurrences sont connues avec certitude et locales à un
  script (labels, fonctions locales, variables `.@`/`.`). Refus expliqués pour le reste (événements `On…`, fonctions globales et noms de NPC
  référencés par chaîne dans d'autres fichiers, variables globales, script incomplet). Preuve : 1 002 renommages appliqués sur le corpus
  réel sans aucun nouveau diagnostic. Le multi-fichiers viendra avec une garantie sur les références par chaîne.
- **Défaut trouvé par l'E2E** : un sélecteur CSS global `.main` (mise en page de l'application) s'appliquait à l'élément `.main` interne
  des listes de Monaco, empilant icône, libellé et détail sur trois lignes : la proposition était dans le DOM mais invisible. Classe
  renommée `workbench-main` ; l'E2E vérifie désormais que le libellé tient dans sa ligne. Règle : toute classe générique de l'application
  doit être préfixée (Monaco injecte des classes courtes : `.main`, `.left`, `.right`, `.contents`, `.details`…).
- **Monaco 0.57** : `editor.getAction("editor.action.triggerSuggest")` n'est pas utilisé ; l'E2E presse les vraies touches (Ctrl+Espace, F2)
  et `Input.insertText` après **focus et sélection explicites** du champ de renommage, puis vérification de sa valeur avant Entrée : le focus et
  la sélection de Monaco sont posés après le rendu, et la première version du test échouait environ une fois sur deux (la saisie partait dans
  l'éditeur). Après correction : 3 exécutions consécutives de l'E2E à 21/21.

## DEC-025 — Registre de commandes : la table du serveur fait foi pour l'arité, le manuel n'est qu'une aide

- **Contexte** : `RA0001` (commande inconnue) et `RA0006` (nombre d'arguments) exigent de savoir quelles commandes existent et combien
  d'arguments elles acceptent. Deux sources existent dans le serveur de l'utilisateur : le **manuel** `doc/script_commands.txt` (écrit pour
  les humains) et la **table** `buildin_func[]` de `src/map/script.cpp` (`BUILDIN_DEF(nom,"s*")`), que le serveur lui-même applique : à la
  lecture de chaque script, `parse_callfunc` refuse un appel dont le nombre d'arguments sort de l'intervalle déduit de cette chaîne.
- **Mesures qui ont tranché** (serveur local, 841 scripts chargés, 557 894 appels réels) : l'arité tirée de la table = **0 fausse alerte** ;
  l'arité devinée à partir des titres du manuel = **2 329 fausses alertes** (`initnpctimer`, `stopnpctimer` : « 1 à 3 arguments » au manuel,
  0 à 2 dans le serveur ; 26 désaccords sur 662 noms) ; le manuel **omet** 5 commandes de la table dont 2 utilisées (`warpchar`,
  `needed_trait_point`).
- **Décision** : priorité *commandes personnalisées du serveur* (`src/custom/script_def.inc`) > *table du code source* > *manuel*. Le nombre
  d'arguments ne vient **que** des deux premières ; le manuel apporte signatures lisibles et aide (sans arité). Sans code source (serveur
  précompilé), le registre se limite aux noms du manuel et l'arité n'est **pas** vérifiée : mieux vaut ne pas alerter que mentir (CLAUDE.md
  §0.7). Chaque définition garde sa provenance (`sources` : nature et `fichier:ligne`). Rien n'est embarqué : les fichiers sont lus à
  l'exécution (DEC-012), les fixtures de test sont rédigées pour ce projet.
- **Quand une alerte est-elle émise ?** Le serveur n'accepte l'appel d'un nom nu que dans trois cas, qui sont exactement les trois résolutions
  de `RA0001` : commande du registre (insensible à la casse, `strcasecmp` dans `add_str`), fonction locale du script (même espace de noms
  que les labels), fonction globale déjà chargée (`userfunc_db`, casse exacte). `RA0001` reste un **avertissement de confiance
  « inconnue »** (CLAUDE.md §6.5) : la commande peut exister dans un binaire différent de la source lue. Gravité réglable
  (`validation.unknownCommands`).
- **Conception** : l'arité se vérifie **à l'analyse** (le registre est une entrée d'`analyzeFile` ; le résultat reste de simples données) ;
  les noms inconnus sont conservés dans `FileAnalysis.unknownCalls` et résolus par l'index du projet (fonctions globales). Alternative
  écartée : conserver tous les sites d'appel et décider à la demande (plus de mémoire pour un gain nul : le registre ne change qu'à l'ouverture
  d'un projet ou d'un réglage de serveur, ce qui relit de toute façon les fichiers). Coût mesuré : des écarts de l'ordre du bruit de
  mesure (1,08 s / 22,1 Mo avec registre, 1,07 s / 21,1 Mo sans, pour 841 fichiers ; l'inverse dans une autre exécution).
- **Garde contre les fausses alertes transitoires** : tant que l'index n'est pas complet (ouverture du projet, changement de serveur ou de
  portée), le service est mis à `unknownCommands: off` ; une fonction définie dans un fichier pas encore lu serait sinon signalée.
  Le test du contrôleur suspend l'indexation et **échoue si la garde est retirée** (vérifié).
- **Preuves** : `registry-report.ts` sur le serveur local (0 fausse alerte ; **4 200 mutations de code réel** — nom modifié 4 200/4 200,
  arguments en trop 674/674, arguments supprimés 3 153/3 153 — toutes détectées au bon endroit, 0 alerte parasite) ; 87 tests des paquets
  `emulator-*` ; E2E 23/23.
- **Limites** : un binaire compilé avec d'autres options que le source lu peut différer ; les commandes sous `#ifdef` sont toujours
  considérées connues ; Hercules n'a pas d'adaptateur (aucun registre, aucune alerte) ; les types d'arguments ne sont pas vérifiés.

## DEC-026 — Règles de chargement des scripts, détection du serveur et portée de l'index

- **Contexte** : le serveur ne charge pas `npc/` : il suit `conf/map_athena.conf` puis `npc/re/` ou `npc/pre-re/scripts_main.conf`. Indexer tout
  `npc/` mélange des variantes exclusives (1 070 faux `RA0005` mesurés), d'où le défaut prudent de `validation.crossFile: off` (DEC-021).
- **Décision (lecture)** : `emulator-core` reproduit exactement la lecture de `map_config_read`/`map_reloadnpc_sub`/`npc_addsrcfile`/
  `npc_delsrcfile` (règles dans `LANGUAGE_SPEC.md`) : commentaire jusqu'à `//` même dans un chemin, nom de réglage sans retrait des espaces,
  `npc:`/`delnpc:`/`import:`, `clear`/`all`, dédoublonnage exact, ordre du serveur. Différences assumées : un `import:` circulaire est signalé
  et ignoré (le serveur boucle), des bornes de profondeur et de lectures existent, et l'existence des scripts est vérifiée **en un appel
  groupé** à la fin (équivalent : un fichier absent n'a jamais d'effet sur l'ordre ni sur `delnpc`, mais 841 allers-retours deviennent un).
- **Vérification indépendante** : la première implémentation (`scripts/lib/corpus.ts`, outil de mesure) et le nouveau module donnent la
  **la même liste, dans le même ordre,** pour les 841 scripts du serveur local (17 fichiers de configuration, 37 ms, aucun problème).
- **Décision (portée)** : `emulator.indexScope` vaut `sources` par défaut (comportement inchangé) ou `loaded` (seuls les scripts chargés par
  le serveur sont indexés ; repli sur `sources` sans serveur reconnu). Ce n'est pas le défaut : un script pas encore déclaré dans
  `scripts_*.conf` (travail en cours) disparaîtrait de la navigation. Le choix est un réglage explicite, expliqué dans les paramètres.
- **Décision (détection)** : la racine du serveur se déduit des fichiers caractéristiques du projet (`doc/script_commands.txt`,
  `src/map/script.cpp`, `npc/re|pre-re/scripts_main.conf`, `conf/map_athena.conf`) ; le projet lui-même d'abord, sinon l'unique serveur des
  sous-dossiers. **Plusieurs candidats : l'application ne choisit pas** (CLAUDE.md §7.3 : détection indicative, jamais implicite) ; la barre
  d'état invite à choisir et les paramètres proposent les candidats. Une racine configurée est prise telle quelle. Le mode `re`/`pre-re` se lit
  dans `src/config/renewal.hpp` (`#define RENEWAL` actif sans `#define PRERE`), sinon renewal est supposé **et affiché comme supposé** ; il
  peut être imposé.
- **Interface** : élément unique de la barre d'état (nombre de commandes, ou état à corriger) avec le détail en info-bulle (niveau du
  registre, dossier du serveur et s'il est détecté, mode et sa source, scripts chargés et problèmes de `scripts_*.conf`, lignes du code
  source non comprises) ; ouvre les paramètres du projet.
- **Preuves** : `script-conf.test.ts`, `server-profile.test.ts`, `controller-emulator.test.ts` (portée « chargés » : faux doublons supprimés,
  mode imposé, imports de `map_athena.conf`, repli, changement à chaud), E2E (serveur d'un sous-dossier détecté).
- **À faire** : exploiter l'**ordre** de chargement dans les diagnostics (appel d'une fonction avant son chargement, `duplicate` avant sa
  source) ; adaptateur Hercules ; messages détaillés pour les scripts cités mais absents.

## DEC-027 — Assistance aux commandes : contexte tiré des jetons, signatures du manuel, aide résolue à la sélection

- **Contexte** : le registre (DEC-025) existe mais n'est pas montré. Il faut proposer, documenter et guider la saisie des commandes sur du code
  presque toujours invalide pendant la frappe, sans jamais bloquer et sans afficher une aide fausse.
- **Contexte de saisie** : `scanCalls` (`call-scan.ts`) lit les **jetons** précédant le curseur et rend le début d'instruction, la position
  d'opérande et l'appel en cours (nom, plage du nom, rang de l'argument, parenthésé ou non). `commande (` est transparent (le serveur lit
  `cmd (a), b` comme une commande à deux arguments) ; l'en-tête d'une structure de contrôle (`if (`, `for (`, `while (`…) repart de zéro ;
  chaînes et commentaires sont inertes. **Pas d'AST** (DEC-024). Fenêtre de lecture : 30 lignes à l'origine, insuffisante pour de longues
  instructions ; la plus longue instruction réelle du serveur local en compte **57** (512 801 instructions lues) : **120 lignes**.
- **Complétion** : contexte « commande » en début d'instruction et en opérande ; **mot vide : seulement sur Ctrl+Espace** (sinon chaque
  ligne vide ouvrirait la liste) ; un mot à trait d'union (`npc-…`) est accepté pour les modèles (DEC-029). La liste ne porte que le nom, la
  signature en bref, la source et les drapeaux ; **l'aide longue est résolue à la sélection** (`resolveCompletionItem` → `commandInfo`) : 667
  commandes avec 431 Ko d'aide à chaque frappe seraient lourdes à transférer. Plafond : 1 000 propositions.
- **Signatures** : le texte affiché est celui du **manuel du serveur de l'utilisateur** (lu à l'exécution, DEC-012) ; la plage de chaque
  paramètre est repérée pour la mise en évidence (`parseSignatureText` : découpe sur les virgules et accolades hors `<…>`, `{…}` =
  facultatif, `...` = nombre libre). Sans manuel : signature générique tirée de la notation de la table (`warp(string, int, int,
  [optional])`). **Ces textes ne servent qu'à l'affichage** : le nombre d'arguments vérifié vient toujours de la table (DEC-025).
- **Silence** : l'aide de signature se tait sur le nom de la commande lui-même, dans les commentaires et hors du corps d'un script.
- **Preuves** : `scripts/commands-report.ts` sur le serveur local (une instruction sur 40 : 12 779 instructions, 13 377 arguments) — survol,
  complétion et aide de signature **conformes à 100 %** à l'oracle (AST du parseur : bonne commande, bonne signature, bon rang d'argument),
  **silence** respecté sur 25 558/25 558 positions ; même résultat à 100 % avec une instruction sur 8 (63 899 instructions, 67 187
  arguments) ; 75 tests (`call-scan.test.ts` 43, `command-features.test.ts` 32) ; E2E sur l'exécutable : complétion + panneau d'aide,
  aide de signature avec paramètre actif, survol (3 étapes). Latences : [`PERFORMANCE.md`](PERFORMANCE.md).
- **Limites** : l'adéquation des plages de paramètres au sens des arguments n'est pas mesurée (seul le rang l'est) ; voir
  `KNOWN_LIMITATIONS.md`, « Commandes dans l'éditeur ».
- **Constat sur Monaco** : l'E2E mesure la latence perçue en trois points ; la classe `visible` du widget de suggestion n'est ajoutée par
  Monaco qu'après un délai fixe de 100 ms (`suggestWidget.js`, `_show`) **sans conditionner l'affichage** : la liste est rendue ~11 à 14 ms après
  la touche. Ne pas prendre cette classe pour un indicateur d'affichage dans un test.

## DEC-028 — Commandes personnalisées du projet et action rapide « déclarer »

- **Contexte** : RF-011 et parcours C du cahier des charges : un fork déclare une commande sans patch du moteur ; elle est proposée avec une
  signature, n'est plus signalée comme inconnue, reste marquée « personnalisée ».
- **Décision (stockage)** : `commands.custom` dans `.runeforge/project.json` (`{ name, args, description }`, clé facultative : `schemaVersion`
  reste 1, les clés inconnues sont conservées à la réécriture). `name` : mot de 64 caractères au plus, ne commençant pas par un chiffre ;
  `args` : notation du serveur (`s?`, `i*`) ou absente ; `description` : 500 caractères au plus ; 1 000 commandes au plus. Une entrée
  au nom invalide, en double (noms insensibles à la casse) ou au-delà de la limite est ignorée **avec un avertissement**, jamais fatale ; une
  notation d'arguments invalide garde la commande **sans vérification de l'arité** (avertissement). Édition : paramètres du projet (une ligne `nom [arguments]`, avec erreurs
  par ligne) ; l'aide libre ne s'édite que dans `project.json` et est conservée.
- **Priorité** : projet > commandes personnalisées du serveur (`script_def.inc`) > table > manuel (DEC-025). Une commande du projet peut donc
  redéfinir une commande du serveur de même nom : choix assumé (fork qui change une signature), documenté.
- **Pas de registre sans serveur** : les commandes du projet **complètent** un registre existant, elles n'en créent jamais. Un registre bâti
  sur elles seules ferait signaler toutes les autres commandes comme inconnues (faux positifs massifs sur un serveur non reconnu).
- **Arité** : sans notation `args`, le nombre d'arguments **n'est pas vérifié** et le survol le dit (« non déclaré : non vérifié ») :
  aucune commande personnalisée n'est jamais classée « erreur certaine » (CLAUDE.md §20, critères de release).
- **Action rapide** (`textDocument/codeAction`, Ctrl+.) : proposée sur `RA0001` quand le nom est un mot de commande valide et pas déjà
  déclaré ; elle **écrit uniquement `.runeforge/project.json`**, jamais un fichier du serveur, par le même chemin que les paramètres (écriture
  sûre) et en informe par une notification. Le conseil de `RA0001` (FR/EN) l'indique.
- **Preuves** : tests de configuration (`config.test.ts` 25), de registre (`registry.test.ts` 10), du contrôleur (`controller-emulator.test.ts`
  23 : alerte et arité déclarée, ordre et origine à la complétion, action rapide, doublon et nom invalide refusés, pas de registre sans
  serveur, liste modifiée depuis les paramètres), de conversion Monaco (`language-mapping.test.ts` 12) et de l'interface
  (`App.server.test.tsx` 13) ; **E2E** : Ctrl+. sur `Inconnue 1;` → Entrée → `project.json` contient la commande, l'alerte `RA0001` disparaît
  (la barre d'état passe de 3 à 4 commandes), le survol affiche « commande personnalisée (projet) » et « non déclaré : non vérifié », le
  fichier de script n'est pas modifié.

## DEC-029 — Modèles de NPC : snippets validés, limités à rAthena ; warp à trois valeurs

- **Décision** : quatre modèles (`npc-script`, `npc-warp`, `npc-shop`, `npc-healer`) dans `packages/npc-templates`, au format snippet de Monaco
  (`${n:valeur}`, `$0`), **proposés seulement hors d'un script, en début de ligne, pour la famille rAthena** (aucun modèle n'est supposé valable
  pour Hercules, CLAUDE.md §0.6). Le texte à taper est l'identifiant (`npc-…`) ; la description est traduite par l'interface. Les séparateurs
  d'en-tête sont de **vraies tabulations** (le serveur les exige) ; l'accolade fermante est échappée dans le snippet.
- **Validation** (CLAUDE.md §10 : « pas de modèle non testé ») : chaque modèle rendu avec ses valeurs par défaut est analysé **sans aucun
  diagnostic** (17 tests) et ses commandes sont contrôlées (nom et nombre d'arguments) contre le **registre du serveur local**
  (`commands-report.ts`) ; l'E2E insère `npc-script` dans un fichier vide avec la vraie saisie, l'enregistre (octets attendus) et n'obtient
  aucun diagnostic. Valeurs par défaut : sprites `4_M_01` et `4_F_01` (employés par de vrais NPC du serveur local), objets 501 et 502
  (présents dans `item_db_usable.yml`) ; `prontera,155,180` est un **exemple** sans contrôle de cellule (cartes : M4-S2). **Aucun modèle n'a
  été chargé par un serveur** (`map-server` non lancé, sans accord) : validation statique uniquement.
- **Correction du parseur découverte par ce travail** : le modèle de warp à trois valeurs d'en-tête (`carte,x,y`) était signalé `RS0036` à tort.
  Dans le serveur, `npc_parse_warp` ne lit que `carte,x,y` (`sscanf … != 3`) alors que `script`, `shop` et `duplicate` en lisent quatre ;
  la direction d'un warp est désormais facultative (le manuel la documente, les 4 152 warps du serveur local la portent). Test de régression
  dans `parser.test.ts` ; message d'erreur adapté (`map,x,y` pour un warp). Aucune régression sur le corpus réel : voir `TEST_MATRIX.md`.
- **Hors périmètre** : ce ne sont pas des assistants (formulaire → validation → aperçu : M6, RF-017).

## DEC-030 — Catalogue de références : lu à l'exécution, lecteur par indentation, vérifié contre un analyseur YAML complet

- **Contexte** : M4-S2. Les scripts nomment des objets, des monstres, des cartes et des constantes ; savoir lesquels le serveur connaît permet de les
  proposer, de les décrire et de signaler les inconnus (`RA0008`–`RA0010`). Comme pour le registre (DEC-025), **rien n'est embarqué** (DEC-012) :
  le catalogue est construit à l'exécution à partir des fichiers du serveur de l'utilisateur, chaque enregistrement garde `fichier:ligne`.
- **Règles prouvées dans le code du serveur local** : `YamlDatabase::load` lit le fichier racine (`db/item_db.yml`, `db/mob_db.yml`, `db/const.yml`),
  applique son corps, puis ses `Footer: Imports:` dans l'ordre (un fichier **avant** ses imports), en sautant les imports d'un autre mode
  (`Mode: Renewal`/`Prerenewal`) et ceux des générateurs ; `Header: Clear: true` efface. Un objet existe s'il a `Id`, `AegisName` et `Name` ; une entrée
  dont l'`AegisName` appartient déjà à **un autre** identifiant est ignorée en entier (`itemdb.cpp`) ; une entrée d'un fichier suivant ne modifie que
  les champs qu'elle écrit. `item_db.searchname` cherche l'AegisName puis le nom d'affichage (sans casse) ; `mobdb_search_aegisname` n'accepte que
  l'AegisName, `mobdb_searchname` aussi les noms ; un monstre a un identifiant de 1001 à 3998 ou de 20021 à 31998 (`mob.cpp`). L'index des cartes est
  `db/map_index.txt` puis `db/import/map_index.txt` (`mapindex.cpp` : nom lu sur 11 caractères, index explicite ou précédent + 1, comparaison **sensible
  à la casse**). Les constantes viennent de `src/map/script_constants.hpp` (10 297 appels `export_constant*` : noms, valeur seulement si écrite en
  clair ; `export_constant_npc(JT_X)` exporte `X`, ce sont les noms de sprites de NPC comme `4_M_01`) puis de `db/const.yml` ; la première définition d'un
  nom l'emporte. Il n'existe **pas** de `db/mapflags.txt` : `doc/mapflags.txt` est un manuel, les drapeaux de carte sont des déclarations de script.
- **Décision (lecteur)** : `scanYamlDatabase` parcourt le texte ligne à ligne **par indentation** et ne retient que `Id`, `AegisName`, `Name`, `Type`,
  `JapaneseName`, `Level` de chaque entrée (le contenu imbriqué : `Script: |`, `Drops:`… est sauté sans être lu) ; il lit aussi les tables en ligne
  `- {Id: 1, …}` et **compte ce qu'il ne comprend pas** au lieu de l'inventer. Les fichiers sont lus une fois par le fil principal (leur pied suffit à
  trouver les imports : seuls 16 Ko de fin sont décodés), puis confiés au worker qui construit le catalogue.
- **Mesures qui ont tranché** : 11,8 Mo de bases (27 826 objets, 2 555 monstres, 1 248 cartes, 10 303 constantes) construits en **141 ms** ; un analyseur
  YAML complet (paquet `yaml`, dépendance de développement du **seul** outil de mesure) met 3,5 s : le lecteur est ~25 fois plus rapide. Il est
  **identique à cet oracle** sur tout le serveur local (`scripts/catalog-report.ts` : ordre des fichiers, 27 826 objets, doublons d'`AegisName`, 2 555 monstres
  avec noms japonais et niveau, 10 303 constantes, 1 248 cartes : 0 différence). Le serveur local contient une clé répétée (`Trade:` écrite deux fois
  dans un objet) que rapidyaml tolère et qu'un analyseur strict refuse : le lecteur par indentation la tolère aussi.
- **Limites** : les constantes `RDMOPT_…` (noms des options aléatoires, `item_randomopt_db.yml`) ne sont pas lues ; un nom de carte de plus de 11 caractères n'est pas
  traité comme le `sscanf` du serveur ; les cartes **chargées** (`conf/maps_athena.conf`) ne sont pas distinguées des cartes de l'index ; Hercules n'a pas de
  catalogue (formats `.conf`, non vérifiés).

## DEC-031 — Nature des arguments : déduite du manuel du serveur ; une vérification prudente (RA0008–RA0010)

- **Contexte** : la notation de la table du serveur (`"vi?"`) ne distingue pas un objet d'un entier. Le manuel (`doc/script_commands.txt`) nomme les paramètres :
  `<map name>` (73 signatures), `<item id>` (73), `<item name>` (49), `<mob id>`/`<monster id>`… Le registre garde déjà ces signatures (DEC-027).
- **Décision** : `argumentKindsOf` lit la nature de chaque position dans les **noms de paramètres reconnus** (carte, objet, monstre ; `<name to show>`,
  `<variable for map name>`, `<map id>` ne désignent rien du catalogue) ; une position n'a une nature que si **toutes** les signatures de la commande qui y
  ont un paramètre s'accordent (`getitem <item id>` et `getitem "<item name>"` : objet).
- **Vérification** (`checkReferenceArguments`, à l'analyse) : seuls un **nombre** ou une **chaîne écrits en clair** sont cherchés ; une variable, une expression, un
  appel, zéro, un nombre négatif (groupe aléatoire de monstres), une chaîne vide ne le sont jamais ; une carte seulement si c'est un nom d'index (lettres, chiffres,
  `_`, `-`, `@` : `force_5-1` et `2@cata` sont des cartes de l'index comme les autres) et pas une valeur spéciale (`Random`, `SavePoint`, `Save`, `this`, et
  `SavePointAll`, `Leader`, `RandomAll` documentés pour `warpparty`). Avertissement de **confiance « inconnue »**, gravité `info` par défaut, réglable
  (`validation.unknownReferences`) : le serveur peut en connaître plus que les fichiers lus.
- **Mesuré sur les 841 scripts chargés** (`scripts/references-report.ts`) : 26 428 arguments en clair vérifiés (9 258 cartes, 10 897 objets, 6 273 monstres),
  **un seul signalé : `getiteminfo("Amesha_Spenta")`**, une vraie erreur du script du serveur (l'AegisName est `AmeshaSpenta`). Une première version avait en
  plus signalé `warpparty "RandomAll"`, valeur spéciale du manuel (d'où la liste ci-dessus) et ignoré les cartes à tiret ou en `@` (38 mutations manquées sur 440,
  corrigé). **Mutations** : 440/440 valeurs réelles remplacées par une valeur absente (une sur 60) sont signalées au bon endroit avec le bon code, **0 alerte parasite**.
  Service de langage sur 1 054 arguments réels : survol 1 054/1 054, complétion après 3 caractères 1 042/1 054 (les 12 manques sont des identifiants de 6 chiffres, au-delà
  de la limite de 200 propositions : la liste est alors marquée « incomplète » et Monaco la redemande en continuant la saisie).
- **Limites** : la nature n'est connue que si le manuel la nomme (les commandes sans signature n'ont rien) ; les chaînes de formules, les noms construits et les valeurs
  spéciales propres à une commande non documentée ne sont pas vérifiés ; seul le **nom** d'un objet ou d'un monstre est contrôlé, pas son usage.

## DEC-032 — Recherche et insertion de références (RF-012), constantes du projet

- **Décision (recherche)** : une entrée de la palette (Ctrl+Maj+D, commande « Rechercher dans les bases du serveur ») cherche dans les objets, monstres, cartes et
  constantes à la fois (8 résultats par nature) ; `item:`, `mob:`, `map:`, `const:` restreignent à une nature (100 résultats). Le classement est celui du
  catalogue : identifiant exact, puis début de nom, début de mot, contenu ; tous les mots de la requête doivent correspondre.
- **Décision (insertion)** : Entrée insère l'**identifiant** d'un objet ou d'un monstre (le style le plus courant des scripts), Maj+Entrée leur **AegisName**
  entre guillemets ; une carte s'écrit toujours comme une chaîne, une constante par son nom. Dans une chaîne déjà ouverte (nombre impair de guillemets avant
  le curseur) le texte est inséré sans guillemets. L'insertion est une édition de l'éditeur (annulable, le document devient modifié), jamais une écriture de fichier.
- **Décision (complétion)** : à l'argument d'un objet, d'un monstre ou d'une carte, les références passent avant les commandes ; l'identifiant remplace le fragment saisi
  (hors chaîne), le nom dans une chaîne ; les constantes se proposent à une position d'opérande dès 2 lettres (100 au plus, le serveur en exporte ~10 000).
  Une liste de références tronquée à son maximum est « incomplète » pour Monaco, qui la redemande en continuant la saisie.
- **Constantes du projet** (`constants.custom` de `project.json`) : même principe que les commandes du projet (DEC-028) — elles **complètent** celles du serveur, qui
  l'emportent en cas de même nom ; édition dans les paramètres du projet (`NOM [valeur]`), clés inconnues conservées.
- **Constat sur Monaco** : le délai de 100 ms de la classe `visible` du widget de suggestion (DEC-027) vaut aussi pour les références ; les mesures de latence de
  la complétion d'un objet figurent dans `PERFORMANCE.md`.

## DEC-033 — Rapport de projet (RF-015) : un instantané du service, restreint par défaut aux scripts que le serveur charge

- **Contexte** : `LanguageServer.projectDiagnostics()` existait (M3-S1) mais aucune vue ne l'utilisait : le panneau des problèmes ne montre que les fichiers ouverts, et un
  administrateur qui ouvre un serveur de 1 295 fichiers n'avait aucun moyen de savoir lesquels ont un problème.
- **Décision (modèle)** : `LanguageServer.projectReport(options)` rend un `ProjectReport` : fichiers examinés, fichiers qui ont des problèmes (**les plus graves d'abord** : erreurs, puis avertissements,
  puis informations, puis chemin), pour chacun ses problèmes **avec leur position (ligne, colonne en base 1)** dans l'ordre du fichier, totaux par gravité et par code. Ce sont exactement les
  diagnostics de `diagnostics(uri)` (mêmes vérifications, mêmes gravités réglées par le projet) : un fichier ouvert y figure avec le texte de l'éditeur, un autre avec celui lu sur le disque.
  Le détail est borné (`MAX_REPORT_ITEMS` = 5 000 ; les derniers fichiers, les moins graves, perdent leur détail d'abord) ; les **totaux restent exacts**. La limite vient d'une mesure : le détail est
  transféré du worker à l'interface par clonage structuré, dont le coût est proportionnel à sa taille — avec 20 000 problèmes (146 000 de doublons dans le pire cas mesuré) : 14,5 Mio et 111 ms ;
  avec 5 000 : 3,9 Mio et ~31 ms ; un rapport réel en compte une centaine.
- **Décision (fraîcheur)** : le rapport est un **instantané**. Il est « périmé » quand le service change (un document modifié — ou ramené à son état enregistré —, un fichier que l'index ne
  connaissait pas qu'on ouvre, la fin d'une indexation, un réglage de validation, un fichier rechargé ou fermé sans enregistrer) ; ouvrir un fichier indexé sans le modifier ne le périme pas. Il n'est
  **jamais calculé tant qu'il n'a pas été demandé**, et recalculé tout seul 400 ms après le dernier changement **seulement si l'onglet est affiché**. Un calcul dépassé est abandonné ; un changement
  pendant le calcul laisse le résultat « périmé ». Les analyses de documents en attente sont envoyées avant le calcul : le rapport montre ce que contient l'éditeur. Calculé pendant l'indexation, il est
  signalé **partiel** et recalculé à la fin.
- **Décision (portée : seulement ce que le serveur charge)** : avec la portée d'index par défaut (`sources`, `**/*.txt`, DEC-026) l'index contient aussi la documentation, les bases et les fichiers
  de configuration du serveur (`doc/*.txt`, `db/*.txt`, `CMakeLists.txt`…). **Mesuré sur le serveur local** (`scripts/project-report.ts`, scénario D) : 1 295 fichiers indexés, dont 841 chargés ;
  rapport complet **177 fichiers, 12 700 erreurs, 1 957 avertissements, 5 informations** (12 518 `RS0030` : « en-tête incomplet » dans des fichiers qui ne sont pas des scripts) ; **restreint aux scripts
  chargés : 53 fichiers, 3 erreurs, 531 avertissements, 1 information** (454 fichiers laissés de côté, dont 124 avec 14 127 problèmes) ; dans l'application, avec la configuration par défaut (vérifications entre
  fichiers désactivées), la vue restreinte du même serveur est **4 fichiers : 3 erreurs, 0 avertissement, 1 information** — les seuls vrais constats. Le rapport est donc **restreint par défaut** quand un serveur est
  reconnu et que la portée est `sources` (case « Seulement les scripts chargés par le serveur », décochable : le rapport est alors recalculé pour tous les fichiers), dit combien de fichiers et de problèmes
  il laisse de côté et pourquoi, et propose d'ouvrir les paramètres du projet pour changer la portée. Le texte copié suit ce que l'écran montre. Calculer les scripts chargés ne touche pas
  `emulator.loadedScripts` (l'état du serveur continue de décrire la portée d'index) ; une liste vide (configuration absente ou illisible) ne retire jamais rien. **Le défaut de la portée d'index reste `sources`**
  (DEC-026 : un script pas encore déclaré disparaîtrait de la navigation).
- **Erreur de conception trouvée par la mesure, et corrigée** : la première version filtrait les fichiers chargés **dans l'interface**, sur un rapport déjà borné à 5 000 problèmes. Or les fichiers de bruit
  (doc, bases) ont le plus d'erreurs et passent donc **avant** les vrais fichiers : ils épuisaient la limite et les 3 vraies erreurs perdaient leur détail. La restriction est maintenant faite **par le service**
  (`projectReport({ only })`, qui compte aussi `excluded` : fichiers laissés de côté, ceux qui ont des problèmes, et leur nombre), avant la limite. Test de non-régression (8 manuels de 1 000 erreurs : le vrai
  problème garde son détail avec la restriction, le perd sans) et vérification sur le serveur réel (535 problèmes détaillés, complets, totaux et codes égaux à une somme indépendante des `diagnostics(uri)`).
  *Limite mesurée* : avec les vérifications entre fichiers activées, 531 `RA0005` subsistent sur des scripts chargés (jumeaux dans l'autre mode de compilation, que la portée `sources` indexe aussi) ; seule la portée
  « chargés » les écarte (0 sur le même serveur), d'où la mention dans l'avis.
- **Décision (chargement du serveur)** : les problèmes de `scripts_*.conf` (script cité mais absent, réglage inconnu, import circulaire, limites de profondeur) ne sont plus réduits à un nombre : ils
  sont listés dans le rapport avec `fichier:ligne` (chemins relatifs au projet) et s'ouvrent à la ligne ; ils n'existent qu'avec la portée « chargés » (c'est elle qui lit ces listes pour l'index).
- **Décision (export)** : le rapport se **copie dans le presse-papiers** en texte simple (Markdown : chemins du projet, positions, gravités, codes, confiance, messages et conseils ; jamais le contenu des
  scripts), sur action explicite. Aucune écriture de fichier : un export vers un fichier demanderait un dialogue d'enregistrement et une capacité de plus (M5).
- **Constat de l'E2E** : l'étape du rapport a révélé un défaut de mise en page **préexistant** : avec 12 onglets ouverts ou plus, la colonne implicite de la grille `.workbench` s'élargissait à la largeur
  minimale de la barre d'onglets (1 674 px dans une fenêtre de 1 280) et toute la page débordait — boutons du panneau du bas et barre d'état hors d'atteinte. Corrigé (`minmax(0, 1fr)`), gardé par une
  étape E2E de mise en page. L'E2E a aussi montré qu'une promesse de la page qui ne se résout jamais (`navigator.clipboard.readText()` attend une autorisation) suspendait tout le scénario : les commandes CDP
  ont maintenant un délai (90 s) et l'étape note le texte confié à `writeText` au lieu de relire le presse-papiers.
- **Preuves** : voir `TEST_MATRIX.md` (service, texte copié, contrôleur, composants, E2E, rapport sur le serveur réel) ; les tests du service, du contrôleur et du panneau ont été contrôlés par
  mutation (chaque modification volontaire du code est détectée par au moins un test ; une mutation survivante a révélé un code mort, supprimé).

## DEC-034 — Cartes des déclarations (RA0008, RA0015) et labels réservés (RA0014)

- **Contexte** : trois comportements du serveur, prouvés dans le code du serveur local (lecture seule), que l'application ne disait pas.
  1. `npc_parsesrcfile` (`npc.cpp`, ~5707-5737) : une déclaration dont la carte est **absente de l'index** (`mapindex_name2id == 0`) est ignorée avec une erreur journalisée ; celle dont la carte est
     dans l'index mais **non chargée par ce serveur** (`map_mapname2mapid < 0`, c'est-à-dire absente des `map:` de `conf/maps_athena.conf`) est ignorée **sans aucun message**. La destination d'un
     `warp` absente de l'index est aussi une erreur (`npc_parse_warp`, ~3873) ; une destination de l'index mais non chargée ne l'est pas.
  2. `map_config_read` (`map.cpp`, ~4032) lit `map: nom` (`clear` vide la liste), `delmap: nom` (`all` vide la liste) et `import:` dans `conf/map_athena.conf` ; `map_athena.conf` importe `conf/maps_athena.conf`.
  3. `set_label` (`script.cpp`, 845) refuse un label dont le nom est déjà une constante (`C_INT`), un paramètre (`C_PARAM`) ou une commande (`C_FUNC`) : « set_label: invalid label name ».
- **Décision (lecture)** : `resolveScriptLoadOrder` rend aussi `maps` (cartes chargées, dans l'ordre, sans `.gat`, doublons gardés, casse exacte) à partir des seuls fichiers de configuration de la map
  (`map-config`) : une liste de scripts (`npc-list`) les signale comme réglage inconnu, comme le serveur. La liste est transmise au catalogue (`loadedMaps`), jusqu'au worker. **Une liste absente, vide ou
  illisible est « inconnue »** : aucune carte n'est alors dite non chargée (on ne reproche jamais à un projet une configuration qu'on n'a pas pu lire). La barre d'état dit combien de cartes sont chargées.
- **Décision (`RA0008` étendu)** : il porte aussi sur la carte de toute déclaration (script, warp, boutique, monstres, duplicate, mapflag) et sur la destination d'un warp. Garde ajoutée, aux
  déclarations **et aux arguments** : un index des cartes vide (`db/map_index.txt` non lu) ne rend plus aucune carte « introuvable » (défaut de M4-S2 : sans index, chaque `warp "…"` aurait été signalé).
- **Décision (`RA0015`, nouveau)** : déclaration sur une carte de l'index que le serveur ne charge pas — le serveur l'ignore en silence (la question classique « mon NPC n'apparaît pas et le journal est
  muet »). Information, confiance « probable », gravité réglable avec les autres références (`validation.unknownReferences`). **Jamais pour une ligne `mapflag` ni pour une destination de warp** :
  mesuré sur le serveur local, les 26 seules déclarations sur une carte non chargée sont des lignes `mapflag` (10 cartes : `poring_c01`, `moc_fild04`…), livrées ainsi par la distribution pour des cartes
  qu'un serveur peut désactiver ; les signaler serait du bruit. Un serveur à plusieurs serveurs de cartes peut légitimement charger cette carte ailleurs : d'où « information » et l'avis qui le dit.
- **Décision (`RA0014`, nouveau)** : un label ou une fonction locale dont le nom est une **commande de la table du code source du serveur** (ni celles du seul manuel, ni celles du projet, ni celles compilées
  sous condition), une **constante ou un paramètre lus dans le serveur** (ni celles du projet : `ConstantRecord.custom`). Erreur, confiance « probable » (le registre et le catalogue sont ceux du serveur
  de l'utilisateur, mais une constante ajoutée à l'exécution nous échappe : on ne signale que ce qu'on sait). Casse ignorée, comme les mots du langage.
- **Preuves (serveur local, `scripts/maps-report.ts` et `scripts/labels-report.ts`)** : liste des cartes chargées **identique** à celle d'un lecteur indépendant (1 218 cartes, dont 30 de l'index ne sont
  pas chargées) ; **33 933 déclarations, 37 108 noms de carte** des 841 scripts chargés confrontés à un oracle indépendant en 1,4 s : **0 faux positif, 0 faux négatif**, 0 carte absente de l'index, 0
  déclaration sur une carte non chargée, les 26 lignes `mapflag` non signalées ; **mutations** (un nom de carte sur 60) : carte inconnue signalée 619/619 (dont 93/93 destinations de warp), carte non chargée
  429/429, mapflag sur carte non chargée non signalé 97/97, **0 alerte parasite** ; **12 010 labels et fonctions locales : 0 `RA0014`** (les scripts se chargent sans cette erreur), puis **2 886 mutations**
  (un label sur 25 renommé en commande, constante ou paramètre, en minuscules puis majuscules) : 962/962 pour chacun, 0 parasite. Code : 21 mutations volontaires sur les cartes et 8 sur les labels, toutes
  détectées (trois survivantes ont fait ajouter un test, une a fait retirer un garde redondant).
- **Limites** : les coordonnées hors de la carte (`npc_parsesrcfile` les refuse aussi) exigent les cartes elles-mêmes (`.gat`, cache) : non vérifiées ; la liste des cartes chargées est lue au démarrage du
  serveur du projet et à chaque changement de ses réglages, pas à la modification d'un `maps_athena.conf` ; les constantes `RDMOPT_…` et celles ajoutées à l'exécution ne figurent pas au catalogue (un label
  de ce nom ne serait pas signalé) ; `RA0015` ne voit pas les cartes qu'un autre serveur de cartes chargerait.

## DEC-035 — Ordre de chargement des fonctions globales (RA0016)

- **Contexte** : trois comportements du serveur, prouvés dans le code du serveur local (lecture seule), que l'application ne disait pas.
  1. `parse_callfunc` (`script.cpp`, ~987-991) : une instruction `Nom arg;` dont `Nom` n'est ni une commande, ni une fonction locale, ni un nom présent dans `userfunc_db` échoue (« expect command, missing function
     name or calling undeclared function ») : le script n'est pas chargé.
  2. `parse_simpleexpr` (~1368-1376) : dans une expression, `Nom(…)` n'est un appel que si `Nom` est dans `userfunc_db` ; sinon le mot est lu comme une variable.
  3. `npc_parse_function` (`npc.cpp`, ~5148-5153) analyse le corps **puis** enregistre la fonction (`func_db->put`) : une fonction n'existe que pour ce qui est analysé **après la fin de sa définition**. Une
     fonction définie dans un fichier chargé plus tard, plus bas dans le même fichier, ou qui s'appelle elle-même par son nom ne peut donc pas être appelée par son nom — alors que `callfunc "Nom"`, résolu à l'exécution, le
     peut. Seule la forme `function<TAB>script<TAB>Nom<TAB>{` existe au premier niveau (pas de déclaration anticipée d'une fonction globale).
  Avant M4-S3c, `RA0001` se taisait dès que la fonction existait dans l'index, quel que soit son rang.
- **Décision (règle)** : `WorkspaceIndex.setLoadOrder(fichiers | null)` reçoit les scripts que le serveur charge, dans l'ordre (un fichier cité deux fois compte à sa première occurrence : le serveur l'analyse à ce rang) ;
  `loadOrderDiagnostics(uri)` signale `RA0016` à chaque appel par son nom d'une fonction globale **définie quelque part** dont **aucune définition n'est connue** à cet endroit : une définition d'un autre fichier compte si ce
  fichier est chargé **avant** celui de l'appelant ; une définition du même fichier compte si elle **finit avant l'appel** (les déclarations ne se chevauchent pas : cela exclut la définition qui suit l'appelant et la récursion
  par le nom). Une définition située dans un fichier que le serveur ne charge pas ne compte pas. Un nom défini nulle part reste à `RA0001` ; un appelant absent de la liste, ou aucun ordre, ne donne rien.
- **Décision (gravité)** : erreur, confiance « probable » (jamais « certaine » : l'ordre vient des listes de scripts lues au démarrage, et le comportement du serveur est lu dans son code, pas observé en l'exécutant).
  La gravité ne suit **pas** `validation.unknownCommands` (c'est une erreur de chargement, pas une commande inconnue) mais l'alerte se coupe avec lui (`off`) : elle est calculée à partir des mêmes appels, et le contrôleur
  coupe cette option pendant une indexation complète, quand l'index est partiel.
- **Décision (contrôleur)** : l'ordre est confié au service **quelle que soit la portée d'index** : lu avec la liste des scripts chargés en portée « loaded » ; relu à chaque synchronisation en portée « sources »
  (`resolveLoadedScripts`, existence des fichiers non exigée : seul l'ordre relatif des fichiers indexés compte). En portée « sources » l'index connaît aussi les fichiers que le serveur ne charge pas : un appel
  d'une fonction qui n'y est définie que donne `RA0016` (et `RA0001` en portée « loaded », où ces fichiers ne sont pas indexés). **Une liste vide ne dit rien du serveur** (configuration absente ou illisible) :
  pas d'ordre. L'ordre n'est renvoyé au service que s'il change (comparaison du contenu, longueur comprise) ; un changement relance les diagnostics des documents ouverts et périme le rapport, même si aucun script
  n'a changé ; il est retenu **avant** l'attente de la requête, et retiré en quittant le projet (service et contrôleur). Il appartient au serveur du projet, comme le registre et le catalogue : `clearIndex` ne l'oublie pas.
- **Conséquence sur un faux serveur de test** : le mini serveur de l'E2E appelait `F_Lib` (définie dans `npc/lib.txt`, hors des listes de scripts) par son nom depuis un script chargé ; ce qui était « une fonction du projet,
  donc pas une commande inconnue » est désormais aussi « une fonction que ce serveur ne chargera jamais ». L'étape de l'E2E le dit.
- **Preuves (serveur local, `scripts/order-report.ts`, contre un oracle qui lit le texte brut — commentaires et chaînes effacés, accolades comptées, mots — et non le parseur)** : 149 fonctions globales (oracle = parseur) ;
  **822 appels par leur nom** (23 fonctions : 378 d'un autre fichier, 444 du même fichier), **le même nombre selon l'oracle et selon l'analyse** (un premier écart de 114 appels était un défaut de l'oracle : `171_worker_talk`
  commence par un chiffre) ; **0 `RA0016`** sur les 841 scripts que le serveur charge. **Mutations** : 183 ordres (chacun des 71 fichiers qui définissent une fonction chargé en dernier puis retiré de la liste, l'ordre
  inverse, 40 mélanges) : **150 426 verdicts comparés à l'oracle, accord exact** (8 943 appels signalés attendus, aucune alerte parasite) ; chacune des 149 définitions déplacée à la fin de son fichier : 15 créent des
  appels prématurés (444 appels, tous signalés au bon endroit) ; chacune des 149 fonctions recevant un appel à elle-même par son nom : 149/149 signalés. **Code** : 42 modifications volontaires (index, service, worker,
  contrôleur, catalogue), 40 détectées par au moins un test et 2 équivalentes déclarées (deux fichiers n'ont jamais le même rang ; un appel ne commence jamais exactement à la fin d'une définition).
- **Limites** : l'ordre est celui des listes de scripts au démarrage ; `@loadnpc` (fichier chargé à chaud) et les scripts chargés autrement que par ces listes ne sont pas modélisés ; un mot qui nomme une fonction
  sans parenthèses dans une expression (le serveur le lit comme un appel) n'est pas reconnu comme appel ; aucun profil Hercules ; l'ordre est relu à chaque synchronisation de l'index, pas à la modification d'un
  `scripts_*.conf` ouvert dans l'éditeur tant que l'arbre n'est pas rafraîchi.

## DEC-036 — Constantes d'options aléatoires (`RDMOPT_…`)

- **Contexte** : `RandomOptionDatabase::loadingFinished` (`itemdb.cpp`, ~4440, lu sans l'exécuter) crée, **à la fin du chargement** de `db/item_randomopt_db.yml` et de ses imports, une constante `RDMOPT_<Option>` valant l'`Id`
  de chaque option (si le nom existe déjà avec la même valeur il ne fait rien ; avec une autre, il le signale). Ces constantes ne sont ni dans `script_constants.hpp` ni dans `db/const.yml` (le code du serveur ne les cite que dans
  l'outil `csv2yaml`) : le catalogue de M4-S2 les ignorait — pas de complétion, de survol ni de recherche pour `RDMOPT_VAR_STRAMOUNT`, et un label de ce nom n'était pas refusé (`RA0014`). Le chargement suit `parseBodyNode` (~4389) :
  `Id` sur 16 bits ; une **nouvelle** entrée exige `Option` **et** `Script` ; une entrée qui existe déjà n'écrase que les champs qu'elle écrit ; un `Option` déjà pris par **un autre** identifiant fait ignorer l'entrée en entier
  (`compare` exact, casse comprise). Levée de la limite « `RDMOPT_…` non lues » de DEC-032 et DEC-034.
- **Décision** : `db/item_randomopt_db.yml` (racine) et ses imports selon le mode de compilation (`db/re/…` pour Renewal, `db/import/…`) sont découverts comme les autres bases (`collectYamlChain` : un fichier avant ses imports, `Mode`, générateurs sautés).
  `readRandomOptionDatabase` applique ces règles (dont `Header: Clear`) puis rend une constante par option, rangée par identifiant, avec sa provenance `fichier:ligne` ; un nom que `skip_word` ne lirait pas (hors lettres, chiffres, `_`) n'est pas
  retenu — il ne pourrait jamais s'écrire dans un script. Elles s'ajoutent **après** celles du code du serveur et de `const.yml` : un nom déjà pris n'est pas remplacé (comme `script_get_constant` avant `script_set_constant`), sans tenir compte
  de la casse, et celles du projet ne remplacent rien. Chaîne : `DatabaseSources.randomOptions` → `ReferenceSourcesInput.randomOptions` (facultatif : absent, aucune) → `RathenaCatalogInputs.randomOptions` ; le compte figure dans
  `RathenaCatalogReport.constants.randomOptions` et les entrées écartées dans les avertissements.
- **Preuves (serveur local, `scripts/catalog-report.ts`, contre un analyseur YAML complet)** : 249 options → 249 constantes `RDMOPT_…` ; le catalogue passe de 10 303 à **10 552 constantes** et reste **identique à l'oracle** (0 différence de nom
  ni de valeur, 0 entrée écartée, 0 doublon) ; catalogue construit en 105 ms (lecture 6 ms, décodage 10 ms). 9 tests du lecteur, 3 du catalogue (dont la découverte selon le mode), 2 du contrôleur (constantes lues et rangées par mode, label refusé
  par `RA0014`) ; 23 mutations volontaires du code, toutes détectées.
- **Limites** : le `Script` des options n'est ni lu ni vérifié ; un serveur compilé en pré-renewal n'a pas de fichier d'options (la base racine n'importe que `db/re/…` pour Renewal) : aucune constante ; les constantes que d'autres bases enregistrent
  à l'exécution restent inconnues du catalogue.

## DEC-037 — Journal de diagnostic local : facultatif, événements seulement, format imposé côté Rust

- **Contexte** : CLAUDE.md §2.1 n° 16 demande une « journalisation locale opt-in pour diagnostic » et §4 exige « aucun secret, chemin sensible ou source complet par défaut ». Le réglage « Écrire un journal de diagnostic local »
  existait (Paramètres › Confidentialité) mais n'écrivait rien. La page web (le frontend) est le composant le moins fiable du produit : elle affiche du texte de l'utilisateur et ne doit pas pouvoir, même par erreur, écrire un chemin ou un
  morceau de script dans un fichier.
- **Décision (contenu)**. Le journal accepte onze codes d’événement (`LOG_ENABLED`, `PROJECT_OPENED`, `RECOVERY_OFFERED`, `INDEX_DONE`, `INDEX_ERROR`, `SAVE_CONFLICT`, `SAVE_FAILED`, `UI_ERROR`, `UI_REJECTION`, `DEPLOY_DONE` et `DEPLOY_ROLLBACK`).
  L’interface identifie la classe standard d’une erreur, par exemple `TypeError`, même si l’instance redéfinit son nom.
- **Validation native**. Un filtre de caractères laissait passer des identifiants et des secrets en ASCII. `crates/filesystem/src/log.rs` impose désormais un niveau et des champs précis pour chaque code. Les champs se limitent à des compteurs bornés, des booléens et des valeurs prédéfinies. Le format reste `<millisecondes depuis 1970> <NIVEAU> <CODE>[ <détail>]`.
- **Activation**. `log_event` relit `logging.enabled` dans les réglages enregistrés à chaque appel. Si le réglage est désactivé, absent ou invalide, l’appel retourne sans créer de dossier ni de fichier.
- **Rotation**. Le fichier courant et la génération précédente font au plus 512 Kio chacun en fonctionnement normal. Un verrou sérialise la vérification de taille, la rotation et l’écriture dans le processus de l’application.
- **Vérifications**. Les tests Rust couvrent les schémas admis, le rejet de texte ASCII libre, l’activation et la rotation avec des écritures concurrentes. Les tests du contrôleur couvrent les événements produits par l’interface et la poursuite du travail en cas d’échec de journalisation.
- **Limites** : le journal n'est pas consultable dans l'application ; aucun gestionnaire de panique du processus natif n'y écrit ; la rotation est volontairement simple (une génération) ; l'événement `INDEX_DONE` donne des **compteurs** de fichiers
  du projet (une information, pas un contenu).

## DEC-039 — Lecture Git sur demande et par projet

L’intégration Git affiche le statut du dossier courant et compare les scripts à `HEAD`. L’application demande l’accord de l’utilisateur pour chaque racine. Elle enregistre cet accord dans les données locales de l’application.

Le code natif lance le client Git avec des arguments construits séparément, un environnement filtré et des limites de temps et de taille. Il désactive la surveillance configurée par le dépôt et bloque les protocoles réseau. Git peut encore utiliser des filtres déclarés dans sa configuration. Le dialogue demande donc de n’autoriser que les projets de confiance. Les tests vérifient l’accord, l’absence de modification de l’index et la désactivation du programme de surveillance. Le scénario Windows vérifie aussi le statut et la comparaison à `HEAD`.

## DEC-040 — Édition visuelle des dialogues et conservation des commentaires

L’éditeur traite la source comme référence et limite chaque action à des plages dans la déclaration du NPC sélectionné. Une condition remplacée doit former une seule expression. L’éditeur conserve le commentaire en fin de ligne lors de la suppression d’une instruction et refuse de supprimer un bloc ou de remplacer une condition si l’opération effacerait un commentaire interne. Les tests de régression couvrent les expressions qui tentent de sortir de la condition, les commentaires et les blocs bruts.

## DEC-041 — Bibliothèque de scripting rAthena intégrée et autonome

- **Décision** : versionner une bibliothèque TypeScript générée depuis la table `src/map/script.cpp` et le manuel `doc/script_commands.txt` du checkout local rAthena. L'application n'ouvre ni ne transmet le manuel à l'exécution. La bibliothèque couvre 667 commandes, dont 662 avec une aide ou une signature issue du manuel (mis à jour le 2022-03-08) ; les autres reçoivent une aide originale fondée sur leur notation d'arguments.
- **Assistance et validation séparées** : complétion, survol et aide de signature utilisent toujours la bibliothèque intégrée. Les diagnostics d'arité et de commandes inconnues utilisent seulement les sources du serveur sélectionné ; sans source, l'aide reste disponible mais aucune commande n'est validée.
- **Mise à jour** : `pnpm run generate:rathena-library` regénère les données et le fichier `Software/LICENSE` depuis `Serveur/rathena-kov` et `Document about NPC`. Ces sources ne sont requises qu'à la régénération, pas à l'exécution ni à la compilation de l'application.
- **Licence choisie par hypothèse** : GPL-3.0-only pour le produit et les paquets, afin de redistribuer le texte rAthena avec son avis de licence. La licence et les métadonnées sont modifiées en conséquence ; une revue juridique reste requise avant distribution. Ce choix n'est pas une certification de conformité.
- **Limites** : la révision du checkout local n'est pas identifiée ; la documentation embarquée peut différer d'autres versions et forks. La table source réellement configurée reste prioritaire pour les diagnostics. Une mise à jour des références exige une régénération et une revue du diff.
- **Options rejetées** : lire un manuel externe à l'exécution contredit l'objectif d'autonomie ; rédiger manuellement plusieurs centaines d'aides ferait perdre la provenance et compliquerait les mises à jour.

## DEC-042 — Constructeur de NPC en graphe de nœuds : le graphe édite, `buildVisualNpc` écrit

- **Contexte** : l'utilisateur a demandé (2026-11-14, avec la capture d'un éditeur de nœuds) que le glisser-déposer de création d'un NPC soit « relié par des nœuds » : des nœuds, des prises, des fils courbes. Le constructeur de M7-S2 était une liste imbriquée (`then`/`else`) dont les liens restaient implicites.
- **Modèle** (`packages/visual-core/src/flow.ts`, sans dépendance UI) : un nœud de départ, des commandes (une entrée, une sortie `next` ; aucune pour `close` et `end`) et des conditions (une entrée, sorties `then` et `else`). Un fil relie une sortie à une entrée : **une sortie porte au plus un fil, une entrée en accepte plusieurs** (la jonction qui suit un `if`). Aucune boucle : `connectFlow` refuse un fil qui en fermerait une, qui irait vers le départ ou vers son propre nœud ; un fil posé sur une sortie déjà reliée la remplace. Les positions sont des entiers dans [0, 6 000].
- **Le graphe n'écrit jamais le script.** `analyzeFlow` le lit comme un arbre de blocs, `buildVisualNpc` (validation des arguments et de l'en-tête, relecture du script par le parseur) l'écrit. La jonction d'un `if` est son **post-dominateur immédiat** — le premier nœud par lequel passent tous les chemins qui en partent : les deux branches s'écrivent jusque-là, puis le script continue. Un graphe qui ne s'écrit pas en script structuré est **refusé avec une raison**, jamais réparé : sortie sans fil (`dangling-output`), nœud non relié au départ (`unreachable-node`), nœud atteint par deux branches qui ne se rejoignent pas (`shared-node` : il serait écrit deux fois), boucle, fils invalides. Un flux incomplet donne un aperçu de sa partie reliée, jamais un fichier ; une cause de graphe n'est pas doublée du message « doit finir par close ».
- **Terminaison** : « chaque chemin finit par `close` ou `end` » remplace « le dernier bloc est un `close` » : un `if`/`else` dont les deux branches se terminent complète le script. Une sortie anticipée (une branche finit par `close`, l'autre continue) s'écrit avec la suite dans la branche qui continue : même comportement, autre écriture.
- **Interactions** : événements du pointeur, pas le glisser-déposer HTML5 — un seul chemin pour la souris, le stylet et le doigt, et l'E2E l'exerce avec de **vrais événements d'entrée** (CDP). Seuil de 4 px entre un clic et un glisser ; **la position du relâchement fait foi** : le navigateur regroupe les derniers déplacements, et l'E2E a vu un nœud s'arrêter à 90 % de sa course. Alternative clavier complète : activer une sortie puis une entrée (les prises sont des boutons nommés, « Next output of mes 1: connected to close 2 »), Suppr débranche, Échap annule sans fermer le dialogue, un bouton × sur chaque fil. Un fil lâché n'importe où sur un nœud se relie à son entrée.
- **Géométrie** : largeur 220 px, titre 32 px, lignes de prises de 28 px ; la zone cliquable d'une prise (24 px) est centrée sur le bord du nœud et le fil (courbe de Bézier) part de son centre. Ces constantes sont dans `visual-core` et appliquées par le CSS ; l'E2E mesure dans WebView2 l'écart entre l'extrémité de chaque fil et le centre de sa prise (≤ 1,5 px).
- **Conduite d'édition** : une commande ajoutée d'un clic s'insère **dans la chaîne** (après le nœud choisi, sur la sortie choisie, sinon avant le `close` final) en prolongeant l'ancienne cible ; supprimer une commande referme la chaîne ; un nœud déposé à la souris n'a aucun fil. Les nœuds sont rangés en colonnes (distance au départ) tant que l'utilisateur n'en a déplacé ni déposé aucun ; « Ranger le canevas » rend la main au rangement. La barre d'outils garde une hauteur constante : l'E2E a vu le canevas se décaler de 27 px à la sélection d'un nœud, ce qui faussait un glisser en cours.
- **Style** : éditeur sombre dans les deux thèmes (jetons redéfinis dans `.flow-canvas`), fils clairs, prises jaunes une fois reliées, contour rouge sur un nœud en cause d'un problème.
- **Preuves** (2026-11-14, Windows) : 48 tests du graphe dont deux propriétés (400 arbres tirés au hasard relus à l'identique et écrits de la même façon ; 3 600 opérations aléatoires qui gardent les invariants : fils valides, une sortie un fil, aucune boucle, chaque nœud écrit une fois et atteint depuis le départ) ; 33 tests d'interface (événements du pointeur simulés) ; mutations du noyau (67 : 63 détectées d'emblée, 3 tests ajoutés, 1 contrôle redondant supprimé) et de l'interface (34 : 31, 2 tests ajoutés, 1 désélection redondante supprimée) ; E2E sur l'exécutable réel, 43/43 deux fois, avec de vrais événements de souris ; audit d'accessibilité sans défaut (huit écrans, six dialogues). Deux défauts n'apparaissent que dans l'application réelle et ont été corrigés : le décalage du canevas à la sélection et la dernière position du pointeur perdue.
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Constructeur de NPC en nœuds ») — création seulement (pas de relecture d'un script existant), pas de boucle, de `goto`, de `select`/`menu` à plusieurs sorties, pas d'annulation dans le dialogue.

## DEC-043 — Simulation de dialogue : un interpréteur du langage dans `simulation-core`, les effets sont notés et n'arrêtent plus

- **Contexte** (2026-11-14) : l'utilisateur ouvre **Fichier › Simuler le dialogue…** sur *Bard#2* (`npc/quests/bard_quest.txt`) et obtient « Requires the server or an unsupported operation: bard_q, line 33 », puis la même erreur sur tous ses NPC. Cause : le simulateur de M8-S1 ne connaissait que `.@x`, `@x`, `Class`, `BaseLevel` et `Zeny` ; toute variable permanente, constante ou commande hors de `mes/next/close/end/set/select/menu` l'arrêtait. Mesure de l'**ancien** simulateur (HEAD, retrouvé dans git) sur les mêmes 9 208 NPC, deux personnages et deux stratégies de réponse (36 832 parties) : **67,2 % des parties s'arrêtaient sur « opération non prise en charge »** (24 740), seuls 3 119 NPC sur 9 208 (33,9 %) allaient jusqu'à une fin et 2 233 affichaient au moins une ligne ; causes principales : `callfunc` 2 270, `checkweight` 2 014, `switch` 1 479, `cutin` 1 116, `disablenpc` 796, `npctalk` 768, `isbegin_quest` 762, `donpcevent` 712, `isequipped` 648, `emotion` 642. Le rapport de l'utilisateur (« all the same kind of error ») était donc exact.
- **Décision 1 — un paquet sans interface.** Le moteur est `packages/simulation-core` (CLAUDE.md §5.3 : le moteur ne dépend ni de React, ni de Tauri). La fenêtre (`SimulationDialog.tsx`) et la mesure sur corpus (`scripts/simulation-report.ts`) l'utilisent toutes deux ; l'ancien `simulate.ts` du dossier de la fenêtre est supprimé, ses tests sont repris. API : `new SimulationSession(npc, contexte, monde).advance(réponse?)` ; `contexte` = personnage de test (niveau, classe, zeny, variables, inventaire, quêtes, nom, résultats imposés), `monde` = source, fonctions globales, constantes, graine, horloge.
- **Décision 2 — la sémantique est celle du serveur, vérifiée dans ses sources** : identifiants, labels et noms de variables insensibles à la casse (`strcasecmp` dans `search_str`) ; un mot nu qui n'est ni paramètre ni constante est une **variable permanente du personnage**, 0 (ou `""`) tant qu'elle n'est pas écrite ; `x` et `x[0]` sont le même élément, la taille d'un tableau est le plus grand indice **non nul** + 1 ; `set` convertit la valeur au type de la variable (`script_getnum`/`script_getstr`) ; `&&`, `||` et `?:` évaluent **toujours leurs deux côtés** (`op_2`, `op_3`) ; entiers de 64 bits, dépassement et division par zéro arrêtent le script ; texte + nombre concatène, tout autre mélange est une erreur ; chaînes comparées comme `strcmp` ; `.@x` est propre à chaque `callsub`/`callfunc`, une variable passée en argument l'est par référence (tableaux) ; sans `return`, la fin du code appelé termine le script, et `return` hors d'un appel est une erreur ; `delitem` d'une quantité supérieure à l'inventaire retire ce qui existe, puis arrête ; `input` borne le nombre à `[0 ; 10 000 000]` (`conf/script_athena.conf`) ; `close2` laisse le script continuer, `close`, `close3` et `end` le terminent.
- **Décision 3 — ce que la simulation ne calcule pas ne l'arrête plus** (CLAUDE.md §12.1 : « Not simulated / Requires server »). Une instruction inconnue (`cutin`, `warp`, `specialeffect`, `donpcevent`...) devient une ligne **« Non simulé »** dans la transcription, avec l'extrait du script, à sa place ; une fonction inconnue vaut 0 et devient une ligne **« Résultat supposé »**, que le test peut remplacer (`results`, champ « Résultats supposés des fonctions »). Une instruction répétée dans une boucle n'occupe qu'une ligne, avec son nombre d'exécutions. L'arrêt est réservé à ce que le serveur refuserait aussi (division par zéro, `delitem` sans l'objet, `return` hors appel, label introuvable, type incompatible), aux limites et à ce que l'interpréteur ne sait pas exécuter (syntaxe non analysable). Les paroles du NPC hors fenêtre (`npctalk`, `announce`...) sont montrées comme telles.
- **Décision 4 — le personnage de test est un modèle, ses valeurs par défaut sont des hypothèses** : sans groupe, guilde, partenaire, monture ni équipement ; `getcharid(0)` = 150 000 ; poids 0, poids maximal 20 000 ; niveau de classe = min(niveau, 50) ; `checkweight` = 1 ; `checkre` = 1 (renewal) ; `checkquest(id, PLAYTIME|HUNTING)` : -1 si la quête est absente, 2 si elle est terminée, 0 sinon (la progression de chasse n'est pas modélisée). Toute variable du contexte (`Weight`, `SkillPoint`, `BaseClass`...) remplace le défaut du paramètre du même nom. Les hypothèses qui dépendent du serveur sont notées « supposées » ; celles qui décrivent le personnage ne le sont pas.
- **Décision 5 — une partie se rejoue à l'identique** : le hasard (`rand`) vient d'un générateur à graine (1 par défaut, réglable) et `gettime` d'une horloge fixe (2026-01-01 12:00 UTC).
- **Décision 6 — `OnInit:` est exécuté avant la première visite**, comme le serveur le fait au chargement, pour que les variables du NPC (`.prix`, tableaux) soient prêtes. Son texte, ses effets et ses attentes sont écartés ; une erreur dans `OnInit` n'empêche pas la visite.
- **Décision 7 — constantes du serveur générées, pas écrites à la main.** `packages/emulator-rathena/lib/generate-script-constants.ts` lit les noms exportés par `src/map/script_constants.hpp` et les valeurs des énumérations et `#define` numériques de `src/**.hpp`, évalue les expressions entières simples et **écarte** tout symbole ambigu ou non évalué : 10 233 constantes sur 10 264 (99,7 %), 18 noms ambigus écartés. Le fichier généré (`script-constants-values.ts`, 295 Ko) dérive de code GPL-3.0-only et est distribué sous la même licence que la bibliothèque de commandes (DEC-041) ; il n'est chargé (import dynamique, sous-chemin `@runeforge/emulator-rathena/script-constants`) qu'à la première simulation. Une constante qui n'est pas dans la table se lit comme une variable à 0 : `SimulationSession.unresolvedNames()` les liste pour les mesures.
- **Décision 8 — bornes de sécurité** : 200 000 pas, 100 000 caractères de texte, 64 options de menu, 40 appels imbriqués, profondeur 600, 20 000 éléments de variables, indices de tableau ≤ 99 999, saisie de texte ≤ 255 caractères. Rien n'est lu ni écrit hors de la mémoire de la session ; aucun serveur n'est lancé.
- **Preuves** (2026-11-14, Windows) : 61 tests du moteur, 5 tests de la fenêtre (jsdom), 3 tests des constantes ; mutations du moteur : 93 modifications volontaires, 73 détectées d'emblée, 19 après l'ajout de 13 tests, 1 ligne redondante et incorrecte supprimée (un texte « 0501 » était lu comme l'objet 501) ; `scripts/simulation-report.ts` sur les 9 208 NPC à corps fermé des 841 scripts chargés par `npc/re/scripts_main.conf`, avec deux personnages et quatre stratégies de réponse (73 664 parties, 7 s) . Après (au lieu de 67,2 % d'arrêts « non pris en charge ») : 35 377 fins, 38 221 fermetures, **50 arrêts** (30 `getarg` après un `callfunc` vers une fonction d'un autre fichier, 12 `select("")`, 8 comparaison texte/nombre sur une valeur supposée), **0 opération non prise en charge, 0 limite atteinte, 0 défaut** ; 9 204 NPC sur 9 208 menés à une fin par au moins une partie ; parties rejouées à l'identique (une sur vingt). Avec `--functions project` (toutes les fonctions du corpus connues), les arrêts tombent à 28. E2E sur l'exécutable réel : 44/44 étapes, deux exécutions, dont une étape qui joue un NPC dans l'application (constantes chargées à la demande, `cutin` noté, choix, saisie, `close2`) ; audit d'accessibilité sans défaut (neuf écrans, sept dialogues) après la correction de deux défauts de focus qu'il a trouvés (voir `ACCESSIBILITY.md`).
- **Ce que ces chiffres ne disent pas** : la simulation est permissive par construction (une fonction inconnue vaut 0, une instruction inconnue est sautée) ; qu'une partie aille jusqu'au bout ne prouve pas que le NPC fonctionne sur le serveur. La sémantique est vérifiée par les tests unitaires ; le corpus mesure la robustesse et l'étendue de ce qui est supposé (liste « Instructions non simulées » et « Valeurs supposées » du rapport).
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Simulation de dialogue »).

## DEC-044 — Une simulation ne s'arrête plus sur une erreur : ce que le serveur refuserait est noté, les fonctions des autres fichiers sont exécutées

- **Contexte** (2026-11-15) : après DEC-043, l'utilisateur précise son but : « faire en sorte qu'il n'y ait plus d'erreur lors de l'utilisation du simulateur de dialogue » — pas corriger ou juger les NPC. DEC-043 laissait 50 parties arrêtées sur 73 664 (« Opération … invalide »), plus des refus côté application : un fichier de plus de 512 Kio (3 fichiers du serveur de référence, jusqu'à 660 Ko), un NPC avec une erreur de syntaxe ou un corps non fermé (« Sélectionnez un NPC complet sans erreur de syntaxe »). Les 50 arrêts avaient quatre causes, relevées dans les sources du serveur : 30 `getarg` (12 NPC) après un `callfunc` vers une fonction d'un autre fichier (par exemple `F_KafEnd` pour les Kafra de `Kafra_Teleportation_Services.txt`) : la fonction n'était pas exécutée, le script retombait dans un sous-programme appelé sans argument, 12 `select("")` (menu sans option : le joueur ne peut qu'annuler, le script se termine), 8 `instance_live_info(ILI_NAME) == "…"` (texte attendu, 0 supposé) et, une fois les fonctions de tout le corpus connues, 8 `getarg(4)` dans `gld_mission_exchange.txt` (le script appelle `S_Kvasir` avec quatre arguments et en lit cinq : un vrai défaut du NPC, que le serveur refuserait aussi).
- **Décision 1 — `Outcome` ne contient plus d'erreur.** Les issues sont `end`, `closed` et `limit`. Une opération que le serveur refuserait devient un **écart** (`fault`) dans la transcription (« Opération invalide (division par zéro) : 10 / 0 — le serveur arrêterait le script ici ; la simulation continue avec une valeur par défaut »), à sa place, regroupé avec son nombre d'exécutions ; une syntaxe que la simulation ne sait pas calculer devient « Non simulé ». Valeurs de repli : 0 (division, modulo, décalage, `getarg` absent), l'entier sûr le plus proche (dépassement), 0 Zeny (solde négatif), l'indice borné (tableau), les nombres que les textes représentent (texte mêlé à un nombre ; l'égalité compare les textes). Une instruction fautive est abandonnée et le script reprend à la suivante ; une expression fautive vaut 0. Terminent le script, faute de quoi continuer n'aurait pas de sens : `return` hors d'un appel, un label introuvable, un menu sans option (annuler termine le script).
- **Décision 2 — une valeur supposée prend le type de ce qu'elle rencontre.** Un opérande dont le calcul a supposé une valeur (fonction inconnue : compteur `assumptions` du moteur) n'est jamais reproché au script quand son type ne convient pas : `inconnue() == "texte"` compare des textes.
- **Décision 3 — les limites de ressources restent des arrêts.** 200 000 pas, 100 000 caractères de texte, 64 options, 40 appels, profondeur 600, 20 000 éléments de variables : une boucle sans fin ne peut pas être continuée. L'arrêt est présenté par un message d'état poli (`role="status"`, pas une alerte) qui cite l'instruction atteinte.
- **Décision 4 — un défaut du simulateur ne s'échappe jamais.** Toute exception de l'interpréteur est rattrapée, notée `internal` (« Problème du simulateur ») et termine le script ; `scripts/simulation-report.ts` la compte comme défaut, de même qu'une exception échappée ou une partie non reproductible.
- **Décision 5 — les fonctions des autres fichiers sont exécutées.** `resolveFunctions` (`simulation-core`, sans dépendance UI) parcourt les `callfunc "nom"` du NPC puis, de proche en proche, ceux des fonctions trouvées (150 recherches au plus), avec un `lookup` que l'application fournit : `AppController.createFunctionLookup()` interroge l'index du langage (`workspaceSymbols`), lit le fichier déclarant — le texte courant d'un onglet ouvert, sinon le service de fichiers du projet, donc seulement dans les racines approuvées —, l'analyse une fois et renvoie la déclaration **avec le texte de son fichier** : `SimulationWorld.functions` associe désormais un nom à `{ declaration, source }`, et les extraits de la transcription citent le fichier de la fonction exécutée, pas celui du NPC.
- **Décision 6 — le dialogue ne refuse plus un NPC.** Erreur de syntaxe ou corps non fermé : le NPC est joué (l'analyseur est tolérant), la fenêtre annonce « Problèmes de syntaxe dans ce NPC : N » et ce qui n'a pas été compris est « Non simulé ». Plafond relevé de 512 Ki à 4 Mi caractères. Un fichier sans NPC à script explique qu'il n'y a rien à simuler. Le profil Hercules reste refusé (adaptateur `BLOCKED_EXTERNAL`).
- **Alternatives écartées** : arrêter proprement la partie à chaque écart (reste une interruption : le dialogue s'arrête avant d'avoir montré la suite) ; masquer les écarts (le script a vraiment un défaut, CLAUDE.md §12.1 interdit de le taire) ; ignorer silencieusement une instruction fautive (l'utilisateur ne saurait pas que la simulation s'écarte du serveur) ; un second analyseur de fichiers dans le moteur (le moteur resterait sans accès aux fichiers : c'est l'application qui lit, dans ses racines approuvées).
- **Preuves** (2026-11-15, Windows) : `pnpm check` 1 627 tests / 83 fichiers ; 93 tests du moteur (dont 4 de résolution des fonctions), 9 de la fenêtre, 5 du contrôleur ajoutés ; **50 mutations** de la reprise sur erreur (moteur, fonctions, fenêtre, contrôleur) : 44 détectées d'emblée, 6 survivantes → 6 tests (alors détectées) ; `scripts/simulation-report.ts` sur les 9 211 NPC à corps du serveur de référence (73 688 parties) : **0 limite, 0 arrêt, 0 défaut** au lieu de 50 arrêts, 52 écarts notés qui tombent à 8 avec toutes les fonctions du corpus (le seul défaut réel : `S_Kvasir` lit `getarg(4)` après quatre arguments) ; mêmes résultats sur les 9 219 NPC de `upgraded-kov` ; **24 581 variantes abîmées au hasard** de ces NPC (196 648 parties) : 0 exception, 0 défaut interne, 164 limites (boucles sans fin insérées), 3 437 écarts notés ; E2E sur l'exécutable réel 44/44 deux fois, audit d'accessibilité sans défaut. Détails : `STATUS.md` (« Vérifications de la simulation sans arrêt ») et `TEST_MATRIX.md`.
- **Ce que ces chiffres ne disent pas** : « aucune erreur » décrit le simulateur, pas les NPC : un NPC peut avoir un défaut réel (c'est la ligne « Opération invalide »), et une partie menée à son terme ne prouve pas qu'il fonctionne sur le serveur. Après un écart, le déroulé affiché est celui du simulateur.
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Simulation de dialogue »).

## DEC-045 — La classe du personnage de test se choisit par son nom, celui que le serveur donne

- **Contexte** (2026-11-15) : la fenêtre de simulation demandait un « Class ID » (un nombre). L'utilisateur veut « les vrais noms de classe » à la place.
- **Décision 1 — les noms viennent du serveur, pas d'une liste écrite à la main.** `packages/emulator-rathena/lib/generate-script-constants.ts` lit `job_name()` de `src/map/pc.cpp` (la fonction derrière la commande de script `jobname()`), évalue chaque `case JOB_…:` avec la valeur du symbole C++ (`msg_txt(nullptr, 550 - JOB_NOVICE + class_)` donne un numéro de message), et cherche le texte dans `conf/msg_conf/map_msg.conf`. Résultat : 181 identifiants nommés, aucun sans nom établi, écrits dans `src/job-classes-values.ts` (export `@runeforge/emulator-rathena/job-classes`, 6 Ko, importé directement par la fenêtre : contrairement à la table des constantes, il est assez petit pour ne pas être chargé à la demande).
- **Décision 2 — une ligne par classe.** Une monture ou un costume qui porte le nom d'une classe (`JOB_KNIGHT2` = 13, `JOB_CRUSADER2`, `JOB_SUMMER2`, `JOB_LORD_KNIGHT2`, `JOB_RUNE_KNIGHT2`…) n'a pas de ligne : on garde le plus petit identifiant. 153 classes, par identifiant croissant (la progression du jeu : première classe, deuxième, transcendée, bébé, troisième, quatrième…).
- **Décision 3 — une liste déroulante native**, étiquette « Classe » (« Class »), Novice par défaut ; la valeur envoyée à la simulation reste l'identifiant, celui que le script lit dans `Class`. Les noms restent ceux du serveur, **en anglais dans les deux langues** (« Swordsman », « Magician », « High Novice », « Rune Knight T » : le `T` est le suffixe du serveur pour la version transcendée) : aucune traduction n'est inventée.
- **Alternatives écartées** : une liste écrite à la main (risque d'erreur d'identifiant, aucun lien avec le serveur) ; un nom tiré de la constante (`Job_Novice_High` → « Novice High » alors que le serveur dit « High Novice », `Job_Arch_Bishop_T`…) ; une saisie libre avec complétion (un identifiant que `job_name()` ne nomme pas n'a pas de nom à montrer, et une liste native se parcourt au clavier — touches fléchées et saisie de la première lettre — et se lit au lecteur d'écran sans composant sur mesure).
- **Preuves** : `job-classes-values.test.ts` (noms de référence, une ligne par classe, variantes de monture et de costume absentes, chaque identifiant proposé est aussi la valeur d'une constante `Job_*` du serveur) ; test de la fenêtre (la liste commence par Novice, Swordsman, Magician, Archer, Acolyte, Merchant, Thief, Knight, aucun champ numérique de classe ; « Rune Knight » donne `Class` = 4054) ; E2E sur l'exécutable réel (la liste de plus de 100 noms commence par Novice, « Knight » choisi par son nom donne `class 7 is a knight`) ; audit d'accessibilité.
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Simulation de dialogue » › classe du personnage de test).

## DEC-046 — Mises à jour depuis les releases d'un dépôt GitHub : un manifeste signé fait foi, GitHub n'est qu'un transport

- **Contexte** (2026-11-15) : le propriétaire veut un système de mise à jour « basé sur les releases du git privé » pour que les utilisateurs mettent à jour l'éditeur de NPC depuis l'application. L'application est un exécutable seul (`tauri build --no-bundle`, `bundle.active = false`) : il n'y a pas d'installateur. Contraintes : CLAUDE.md §0 n° 8 (aucune connexion réseau sans action explicite de l'utilisateur), §15.2 (artefacts et mises à jour signés et vérifiés), §16.1 (dépendances compromises). Le dépôt (`origin`) est `github.com/vazan/KingdomOfValhalla`, privé d'après le propriétaire.
- **Décision 1 — la confiance vient d'une signature, pas du dépôt.** Chaque release porte un **manifeste** `update-manifest.json` (schéma 1 : produit, version, canal, date, notes en texte brut, version minimale, et par plateforme le nom, la taille et le SHA-256 de l'exécutable) et sa signature **minisign** `update-manifest.json.sig` (le format que produit `tauri signer sign` : Ed25519 sur le BLAKE2b-512 du manifeste). L'application embarque **la clé publique** (`apps/desktop/src-tauri/update-public-key.txt`) et vérifie la signature avec `minisign-verify` (MIT, sans dépendance) **avant** d'interpréter le manifeste. Un compte GitHub volé, un dépôt compromis ou un homme du milieu peuvent donc empêcher une mise à jour, jamais en imposer une.
- **Décision 2 — GitHub est lu par son API REST, dans le cœur natif.** `GET /repos/{dépôt}/releases` puis `GET /repos/{dépôt}/releases/assets/{id}` (`Accept: application/octet-stream`) : c'est la seule voie qui sert aussi les fichiers d'un dépôt **privé**, par un jeton ; la réponse redirige vers un stockage signé. Le client est en **Rust** (`crates/updater`, `ureq` avec la pile TLS de Windows) et non dans la page : le jeton n'est jamais dans la page, la CSP n'a pas à changer, et les hôtes de redirection (probablement sans CORS) ne posent pas de problème. Politique réseau : première requête vers `https://api.github.com` seulement, qui **seule** porte le jeton ; redirections (5 au plus) seulement vers HTTPS, port 443, `github.com`, `api.github.com`, `*.githubusercontent.com` ; adresses des fichiers **construites** à partir de l'identifiant numérique, jamais copiées de la liste ; réponses bornées.
- **Décision 3 — règles de choix.** Seule une version **strictement plus récente** est proposée (jamais de retour en arrière) ; le canal stable ignore toute pré-version ; l'étiquette `v<version>` et l'indicateur « pre-release » de GitHub doivent concorder avec la version et le canal **du manifeste signé** (sinon `bad_manifest`) ; si la release la plus récente a une signature invalide, c'est une erreur et non un repli sur une plus ancienne ; une release sans fichier pour cette plateforme ou qui exige une version minimale supérieure est sautée au profit de la suivante (3 examinées au plus). Un manifeste d'un schéma plus récent est refusé (`unsupported_schema`).
- **Décision 4 — installation d'un exécutable en cours d'exécution.** Windows interdit de le supprimer ou de l'écraser mais autorise à le **renommer** : l'exécutable est téléchargé à côté de l'application (`.download`, donc même volume et mêmes droits ; un dossier non modifiable échoue avant le téléchargement), haché au fil de l'eau, comparé (taille, SHA-256, en-tête `MZ`), renommé `.new`, puis l'ancien devient `.old` et `.new` prend sa place ; chaque renommage est retenté 6 fois (un antivirus ouvre souvent un exécutable tout juste écrit) ; si une étape échoue, l'ancienne version reprend sa place ; `AppHandle::restart()` relance l'application ; au démarrage suivant, `.old`, `.new` et `.download` sont supprimés. L'installation exige l'accord de l'utilisateur dans une **boîte de dialogue du système** que la page ne peut ni afficher ni valider (comme `sftp_dry_run`), un contrôle préalable réussi (la mise à jour est retenue par le cœur natif : la page n'en désigne aucune) et des documents enregistrés (vérifié avant et après le téléchargement).
- **Décision 5 — jamais sans l'utilisateur ; le jeton ne survit pas à la session.** Aucun contrôle au démarrage, en arrière-plan ni à l'ouverture de l'onglet. Le jeton d'accès (jeton GitHub à granularité fine, lecture du contenu) est saisi par l'utilisateur, **en mémoire** dans le contrôleur (jamais dans le store, les réglages, le journal ni un fichier), de format imposé (`[A-Za-z0-9_-]`, 255 au plus), et n'est envoyé qu'à `api.github.com`. Seuls le dépôt (`proprietaire/depot`, par défaut celui de l'éditeur : `DEFAULT_UPDATE_REPOSITORY`) et le canal sont enregistrés. Le journal de diagnostic (DEC-037) accepte `UPDATE_CHECK result=…`, `UPDATE_INSTALL` et `UPDATE_FAILED code=…`, sans dépôt, version ni message.
- **Décision 6 — la clé de production est une action du propriétaire, et la clé de test est publique.** `pnpm release:keygen` crée la paire **hors du dépôt** (il refuse sinon et n'écrase jamais) et copie la clé publique dans `update-public-key.txt`, qui contient `UNCONFIGURED` d'ici là (l'application répond alors `not_configured`). Les clés de **test** (`crates/updater/tests/fixtures/keys/`, mot de passe `test-only`) sont versionnées, signent les fixtures et l'E2E, et ne signent jamais une release : un test Rust échoue si la clé de production est celle de test, et `pnpm release:prepare` refuse un exécutable qui embarque une clé de test (construction `e2e`), qui n'a pas la clé de production, ou dont la version n'est pas celle de `tauri.conf.json` (sinon l'application mise à jour se proposerait la même mise à jour sans fin). `pnpm release:publish` ne crée qu'un **brouillon** de release, en aperçu par défaut (`--yes` pour envoyer), avec la session `gh` du propriétaire. La première version distribuée doit déjà embarquer la clé publique.
- **Dépendances acceptées par le propriétaire** (2026-11-15) : `minisign-verify` (MIT) et `ureq` avec `native-tls` (MIT OR Apache-2.0) et leurs dépendances (14 composants de plus : `docs/THIRD_PARTY_LICENSES.md`). Un client HTTP est désormais lié pour Windows (`ureq`, utilisé par `crates/updater` seulement) ; `reqwest`, `hyper`, `openssl` et `rustls` ne le sont pas. `webpki-root-certs` (CDLA-Permissive-2.0), tiré par `ureq`, est à faire examiner (`LEGAL.md`). Aucune dépendance JavaScript n'est ajoutée ; la signature est produite par l'outil `tauri signer` déjà installé.
- **Alternatives écartées** : le plugin officiel `tauri-plugin-updater` (il s'appuie, sous Windows, sur les installateurs NSIS/MSI que ce produit n'a pas, et ajouterait des dépendances et des permissions au frontend ; non essayé ici) ; un `fetch` depuis la page (le jeton dans la page, redirections sans CORS, CSP à élargir) ; faire confiance à la seule release GitHub ou à un hachage affiché par GitHub (un compte volé publierait aussi le hachage) ; vérifier au démarrage (CLAUDE.md §0 n° 8) ; stocker le jeton (le coffre du système exigerait une dépendance de plus : décision future, avec l'accord du propriétaire) ; un téléchargement différentiel ou reprenable (hors du besoin).
- **Preuves** (2026-11-15, Windows) : `pnpm check:all` PASS — **1 713 tests TypeScript / 90 fichiers** (1 631 / 84 avant : +82) et **165 tests Rust** dont 59 pour `crates/updater` (33 unitaires, 19 de bout en bout contre un faux GitHub signé avec des fixtures, 7 contre un vrai serveur HTTP local avec le vrai client `ureq`) ; **62 mutations volontaires du code** (vérification, politique réseau, choix des releases, manifeste, installation, jeton, interface, piège du focus) : 54 détectées d'emblée, 8 survivantes dont 4 vraies lacunes de tests (taille annoncée du manifeste, budget de redirections, avancement qui recule, dépôt invalide enregistré) comblées puis détectées, et 4 jugées **équivalentes** (taille reçue redondante avec le SHA-256, garde de taille inatteignable, refus anticipé d'un `Content-Length` trop grand qui donne le même résultat, refus des signatures de l'ancien mode minisign sans vecteur de test) ; une seconde implémentation de la vérification (Node : Ed25519 + BLAKE2b) concorde avec le vérificateur Rust sur les 10 fixtures ; **E2E sur l'exécutable réel** reconstruit : 44/44 pour le scénario principal et **9/9 pour les mises à jour** contre un faux serveur GitHub local (rien au démarrage ni à l'ouverture de l'onglet ; 404 d'un dépôt privé sans jeton ; jeton écrit nulle part sur le disque ; signature d'une autre clé refusée sans télécharger l'exécutable ; exécutable altéré détecté, supprimé, application intacte ; installation refusée sans contrôle préalable et avec des modifications non enregistrées ; **installation réelle** : progression observée, remplacement de l'exécutable en cours d'exécution, redémarrage, nettoyage de `.old`) ; audit d'accessibilité sans défaut (onze écrans dont deux états de l'onglet Mises à jour, huit dialogues) après la correction d'un défaut qu'il a trouvé (voir ci-dessous).
- **Défaut trouvé par l'audit et corrigé** : le piège du focus de `Modal` comptait les boutons à `tabindex="-1"` (onglets inactifs) parmi les arrêts de Tab ; un dialogue ouvert sur un onglet qui n'est pas le premier (Paramètres › Mises à jour, ou À propos) laissait Maj+Tab sortir du dialogue et Échap ne le fermait plus. Corrigé dans `Modal.tsx` (les contrôles à `tabindex="-1"` ne sont pas des arrêts), avec un test de non-régression que les mutations détectent.
- **Ce que ces preuves ne disent pas** : tout a été exercé contre un faux GitHub (en mémoire, puis un serveur HTTP local). **Le TLS réel vers `api.github.com`, les redirections de téléchargement d'un dépôt privé, les limites de débit, le comportement d'un antivirus et le jeton à granularité fine n'ont jamais été essayés**, et aucune release réelle n'existe : un premier contrôle avec une vraie release est à faire (`RELEASE.md`, § 4). La seconde vérification des documents non enregistrés (après le téléchargement) n'a pas de test automatisé. Aucune signature de code Windows (SmartScreen).
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Mises à jour signées »).

## DEC-047 — Mises à jour sous Linux : un manifeste, un exécutable par système, un remplacement atomique

- **Contexte** (2026-11-15) : après DEC-046, qui ne couvrait que Windows, le propriétaire demande : « on doit également couvrir linux ». Le format (une cible par clé de plateforme) et la plupart du code étaient déjà neutres ; restaient ce qui dépend du système : la façon de remplacer l'exécutable en cours d'exécution, le format de l'exécutable attendu, les droits d'exécution, l'outillage de release et la preuve sur un vrai Linux.
- **Décision 1 — un seul manifeste signé, un exécutable par système.** Les clés de plateforme `windows-x86_64` et `linux-x86_64` (et `linux-aarch64`, admise par le format) coexistent dans le même `update-manifest.json`, signé une fois ; chaque ordinateur lit l'entrée de **sa** plateforme (`std::env::consts::OS` et `ARCH`). Une plateforme absente de la release est signalée (`no_platform_asset`).
- **Décision 2 — le format de l'exécutable vient du système de la plateforme.** `crates/updater/src/platform.rs` : `windows-*` attend l'en-tête `MZ`, `linux-*` l'en-tête `\x7fELF`, après le contrôle du SHA-256 ; un fichier signé mais de l'autre système est refusé (`not_executable`). Un système que l'on ne sait pas installer (`macos-*`) ne télécharge rien (`unsupported_platform`). L'outillage de release applique la même règle (miroir testé contre le code Rust).
- **Décision 3 — sous Linux, un renommage atomique remplace le fichier.** Contrairement à Windows, un renommage par-dessus un exécutable qui tourne est permis et atomique : le processus garde l'ancien fichier, et le chemin ne manque jamais (l'algorithme de Windows, deux renommages, laisserait un instant sans exécutable). Les droits de l'ancienne version, bit d'exécution compris, passent au nouveau fichier (GitHub ne conserve aucun bit : sans cette étape le redémarrage échouerait). L'ancienne version est gardée sous `<nom>.old` (lien dur, ou copie si le système de fichiers n'en admet pas) et n'est supprimée qu'au démarrage d'une version qui a démarré : une nouvelle version cassée laisse l'ancienne à portée. Les deux algorithmes sont compilés et testés sur les deux systèmes ; `apply` choisit selon `cfg!(windows)`.
- **Décision 4 — le fichier remplacé est celui que Tauri relance.** `tauri::process::current_binary` (le binaire de départ, ou `$APPIMAGE` sous Linux) remplace `std::env::current_exe()` pour le remplacement comme pour le nettoyage au démarrage : ce qu'on remplace est exactement ce que `restart()` exécute. Un AppImage serait donc remplacé sur place ; aucun AppImage, `.deb` ni `.rpm` n'est produit ni essayé (CLAUDE.md §5.1). Un exécutable installé par un paquet dans `/usr/bin` n'est pas modifiable par l'utilisateur : `not_writable`, message qui renvoie au gestionnaire de paquets.
- **Décision 5 — l'outillage prépare tous les systèmes ensemble.** `pnpm release:prepare --artifact <plateforme>=<fichier>` (répétable ; `--exe` reste l'alias de Windows ; sans option, l'exécutable de la machine) applique à **chaque** exécutable les mêmes contrôles (en-tête de son système, clé publique de production embarquée, aucune clé de test, version, date) avec des messages préfixés par la plateforme, puis signe **un** manifeste ; `release:publish` envoie tous les fichiers après avoir revérifié taille et SHA-256 de chacun. Le binaire Linux se construit sur une machine Linux (WSL convient) et se donne par son chemin.
- **Décision 6 — TLS : OpenSSL sous Linux, sans la liste de certificats de Mozilla.** `ureq` passe de la fonctionnalité `native-tls` à `native-tls-no-default` : même TLS du système (schannel sous Windows, OpenSSL sous Linux), mais sans `webpki-root-certs` que l'application n'utilisait jamais (`RootCerts::PlatformVerifier`). Un composant « à examiner » (CDLA-Permissive-2.0) et une liste de certificats embarquée disparaissent. Sous Linux le binaire est lié dynamiquement à `libssl.so.3` et à WebKitGTK 4.1 : à construire sur la plus ancienne distribution supportée.
- **Décision 7 — des tests qui ne dépendent d'aucun système, et des fixtures qui survivent à Git.** Les nouveaux tests n'ont aucun chemin Windows en dur (le test de `isInside` en avait ; corrigé). Les manifestes signés sont des octets exacts : `core.autocrlf=true` aurait converti leurs fins de ligne à l'extraction sous Windows et cassé leurs signatures ; `.gitattributes` (`crates/updater/tests/fixtures/** -text`) l'interdit, ce qui était un défaut latent de DEC-046.
- **Décision 8 — une sauvegarde `.old` périmée est retirée avant d'être refaite, et un test le verrouille (trouvé par les mutations sous Linux).** Une tentative interrompue entre le lien dur et le renommage laisse `.old` **lié au même fichier** que l'exécutable ; or `std::fs::copy(a, b)` quand `b` est un lien dur vers `a` rend `Ok(0)` et **tronque le fichier à 0 octet**, sans erreur (observé sous Linux). La ligne qui retire d'abord la sauvegarde existait, mais aucun test ne la protégeait : la mutation « sauvegarde périmée non retirée » survivait, puisque les tests n'utilisaient que des fichiers ordinaires comme sauvegarde périmée. Le test `a_backup_left_by_an_interrupted_attempt_as_a_link_to_the_current_file_never_damages_it` (`#[cfg(unix)]`) la tue désormais. **Cas résiduel non traité** : si cette suppression elle-même échoue (attribut immuable sur `.old`, dossier à bit collant d'un autre utilisateur) alors que `.old` est le même fichier que l'exécutable, la copie de repli écrirait dans l'exécutable ; je n'ai pas modifié le code de production après les vérifications finales pour un cas jamais observé (`SECURITY.md`).
- **Alternatives écartées** : appliquer l'algorithme de Windows sous Linux (un instant sans exécutable) ; passer à `rustls` pour un TLS identique partout (nouvelles dépendances, magasin de certificats à embarquer ou `rustls-platform-verifier`, autre revue de licences) ; lier OpenSSL statiquement (`vendored` : construction plus longue, plus de mises à jour de sécurité du système) ; produire un AppImage ou des paquets d'emblée (non demandé, non testable ici) ; un manifeste par système (deux signatures, deux releases à garder cohérentes).
- **Preuves** (2026-11-15 ; détail dans `STATUS.md` et `TEST_MATRIX.md`) :
  - **Windows 11**, `pnpm check:all` : typecheck, ESLint, **1 728 tests TypeScript / 90 fichiers** (1 713 avant), clippy `-D warnings`, **180 tests Rust** (165 avant) dont **74 pour `runeforge-updater`** : 42 unitaires, 24 de bout en bout, 7 contre un vrai serveur HTTP, 1 remplacement d'une copie réellement en cours d'exécution.
  - **Ubuntu 26.04 sous WSL2** (sources copiées sur le disque de Linux ; Node 22.22.1, pnpm 10.33.0, Rust 1.93.1) : `pnpm check` **1 728 tests / 90 fichiers**, clippy `--workspace --all-targets -D warnings` sans avertissement, `cargo test --workspace` **183 tests** dont **77 pour `runeforge-updater`** (44 + 24 + 7 + 2) ; `cargo build --release` de l'exécutable : 17 092 344 octets, ELF, liaisons dynamiques `libssl.so.3`, `libcrypto.so.3`, `libwebkit2gtk-4.1.so.0`, `libgtk-3.so.0`, `libsoup-3.0.so.0`, glibc, avec le texte `UNCONFIGURED` de la clé publique. `cargo tree` : `ureq` lié par `runeforge-updater` seul, TLS = OpenSSL (`openssl` 0.10.82 ← `native-tls` 0.2.18), ni `reqwest`/`hyper` lié, ni `rustls`, `ring`, `aws-lc-rs`, `webpki-root-certs` dans `Cargo.lock` ; 54 caisses sous le crate de mise à jour.
  - **Mutations** : *Windows*, 19 modifications (11 du code Rust — formats d'exécutable, plateformes, installation — et 8 de l'outillage de release et de l'interface), 18 détectées, 1 équivalente (plateforme en double : `buildManifest` la refuse aussi) ; *Linux* (copie WSL, `cargo test -p runeforge-updater` à chaque fois, fichiers restaurés et comparés à ceux de Windows), 12 modifications du code propre à Linux, **12 détectées**, chacune par les tests attendus — après l'ajout du test de la décision 8 (sans lui, une des douze survivait).
  - **E2E Windows** sur l'exécutable reconstruit avec le code final : **44/44 puis 9/9** à la troisième exécution (les deux premières : 43/44, sur deux étapes sensibles au timing sans rapport avec les mises à jour — constructeur en nœuds pendant une compilation Linux, puis liste de complétion de Monaco — chacune réussie ensuite ; `KNOWN_LIMITATIONS.md`). L'installation réelle d'une copie remplacée en cours d'exécution, puis relancée, passe avec `current_binary`.
  - **Licences** : 252 composants Rust livrés pour Windows (247 permissifs, 5 MPL-2.0, aucun à examiner : `webpki-root-certs` n'est plus lié), 298 pour Linux (293 permissifs, les mêmes 5 MPL-2.0) : `LEGAL.md`, `THIRD_PARTY_LICENSES.md`, `THIRD_PARTY_LICENSES_LINUX.md`.
- **Ce que ces preuves ne disent pas** : **l'application n'a jamais été lancée sous Linux** — aucun serveur d'affichage ni WebKit WebDriver n'a été installé (le périmètre accordé pour WSL ne les incluait pas) : le rendu de WebKitGTK, Monaco, l'IME, le clavier, le démarrage, l'accessibilité et le parcours réel d'une mise à jour dans la fenêtre sont **inconnus**. Une distribution (Ubuntu 26.04), une architecture (x86_64) ; ni AppImage, ni `.deb`, ni `.rpm`. Le TLS réel vers GitHub n'a pas été essayé sous Linux non plus (ni sous Windows). Les mutations propres à Linux portent sur `install.rs` et `error.rs` ; l'outillage de release et l'interface sont couverts par les 19 mutations de Windows.
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Plateformes » et « Mises à jour signées »).

## DEC-048 — Revalidation Windows et Linux après le déplacement du projet à la racine du dépôt

- **Contexte** (2026-11-15) : le propriétaire demande de revalider l'application pour pouvoir la construire sous Windows et sous Linux. Le projet, qui vivait dans `C:\Project\KingdomOfValhalla\Software`, est à la racine de `D:\Project\runeforge-npc-editor` (dépôt Git sans commit). Tout a été rejoué, pas seulement lu.
- **Trois défauts trouvés ; aucun n'était dans le code de l'application.**
  1. **Un `npm install tauri` accidentel** (`package.json` et `package-lock.json` écrits à la même seconde, 17:41) avait ajouté l'ancien paquet npm `tauri@0.15.0` aux dépendances du `package.json` racine, créé un `package-lock.json` et modifié `node_modules`. Le lockfile pnpm ne contient pas ce paquet, et `pnpm install --frozen-lockfile` voulait purger `node_modules` (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). *Correction* : dépendance retirée du `package.json`, `package-lock.json` supprimé, `node_modules` recréé par `pnpm install --frozen-lockfile` (226 paquets, `pnpm-lock.yaml` inchangé). L'outil `tauri` est `@tauri-apps/cli`, déjà déclaré dans `apps/desktop`. Le piège est consigné dans `DEV_SETUP.md`. Le comportement exact du lockfile figé avec la dépendance en trop n'a pas été rejoué.
  2. **`target/` gardait l'ancien chemin du projet** : `env!("CARGO_MANIFEST_DIR")` est figé à la compilation, et Cargo ne recompile pas un crate dont seul le chemin absolu a changé. 19 tests de bout en bout de `runeforge-updater` échouaient (`C:\Project\KingdomOfValhalla\Software\crates\updater\tests\fixtures\artifact.exe: The system cannot find the path specified`). *Correction* : `cargo clean -p` sur les cinq crates du workspace (dépendances conservées, captures E2E conservées). Un cache de Vite (`apps/desktop/node_modules/.vite`) contenait aussi l'ancien chemin : supprimé.
  3. **Le CI visait `Software/`**, qui n'existe plus (16 occurrences : `working-directory`, `package_json_file`, `cache-dependency-path`, `workspaces`, chemin des captures). *Correction* : `.github/workflows/ci.yml` réécrit sans ce préfixe ; la tâche `desktop-build` téléverse maintenant l'exécutable brut de chaque système (`runeforge-studio-windows-x64`, `runeforge-studio-linux-x64`), non signé et sans installateur, pour qu'un runner GitHub fournisse un binaire Linux sans machine Linux. Le YAML est syntaxiquement valide (analysé) mais **n'a pas tourné sur GitHub**.
- **Preuves** (détail dans `STATUS.md`) : Windows 11 — `pnpm check` 1 728 tests / 90 fichiers, `pnpm build`, clippy `-D warnings` sans avertissement, `cargo test --workspace` 180 tests, `tauri build --no-bundle` (15 049 728 octets), `pnpm e2e` 44/44 puis 9/9 sur l'exécutable réel. Ubuntu 26.04 sous WSL2 (sources copiées sur le disque de Linux) — mêmes étapes : 1 728 tests / 90 fichiers, clippy sans avertissement, 183 tests Rust, exécutable ELF de 17 092 344 octets.
- **Nouveau** : l'exécutable Linux a été **lancé** pour la première fois, 20 secondes, sous WSLg (`GDK_BACKEND=x11`, dossiers de données jetables) : il démarre, reste en vie, WebKit crée son stockage, et seuls deux avertissements `libEGL` (pas de DRI3, rendu logiciel) sont écrits. **Rien de plus n'a été vérifié** : aucune capture, aucune interaction, aucun test d'interface ; ce lancement ne remplace pas l'E2E Linux.
- **AppImage (même jour, à la demande du propriétaire : « c'est supposé être un AppImage »)** : `pnpm build:linux` produit aussi `target\release\runeforge-studio-linux-x86_64.AppImage` (89 569 784 octets) en plus de l'ELF brut, qui reste sans extension (convention Linux, et c'est ce que `release:prepare` attend). Le bundler Tauri **télécharge puis exécute** `AppRun-x86_64`, `linuxdeploy-07333c6-x86_64.AppImage` et `linuxdeploy-plugin-appimage.AppImage` (versions « continuous », non épinglée) : le propriétaire a accordé ces trois téléchargements après avoir vu leurs sources ; **cet accord vaut pour cette construction, pas pour la suite** — le script s'arrête donc avant de construire (code 6) quand le cache `~/.cache/tauri` est vide, tant que `--allow-download` n'est pas passé (`--no-appimage` pour l'ELF seul). Une archive `.tar.gz` ajoutée un tour plus tôt pour conserver le droit d'exécution est supprimée : l'AppImage la rend inutile. *Alternative écartée* : un `bundle.active: true` dans `tauri.conf.json` (modifierait aussi les builds Windows et le CI) — `--bundles appimage` suffit. **Trouvé en vérifiant** : l'AppImage n'embarque pas la glibc et ses bibliothèques exigent `GLIBC_2.43` (construit sous Ubuntu 26.04) alors que l'ELF brut exige `GLIBC_2.39` : **l'AppImage de cette machine est moins portable que l'ELF brut** ; il redistribue des bibliothèques LGPL (WebKitGTK, GTK, libsoup) absentes de `THIRD_PARTY_LICENSES_LINUX.md` ; il n'est pas reproductible octet pour octet ; sa mise à jour en place (`$APPIMAGE`) n'a pas été essayée. Un script bash lu sur l'entrée standard de `bash -l` voyait tout code de sortie ramené à 1 (`set -e` + `~/.bash_logout`) : corrigé par `bash -lc "exec bash -s"`.
- **Ce que ces preuves ne disent pas** : le CI n'a jamais tourné sur GitHub ; aucun installateur Windows ni paquet `.deb`/`.rpm` n'a été construit ni essayé (`bundle.active` est `false` ; `icons/` contient déjà `32x32.png`, `128x128.png`, `128x128@2x.png` (256), `icon.png` (512), `source.png` (1024) et `icon.ico`, mais `tauri.conf.json` n'en liste que quatre — correction d'une affirmation erronée faite d'après la configuration seule) ; une distribution et une architecture pour Linux (Ubuntu 26.04, x86_64) ; le binaire Linux construit sous 26.04 lie `libssl.so.3` et WebKitGTK 4.1 : son exécution sur une distribution plus ancienne n'est pas établie. Aucune signature de code, aucune clé de signature de mise à jour de production.
