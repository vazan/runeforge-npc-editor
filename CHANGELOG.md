# Changelog

Format inspiré de *Keep a Changelog*. Les versions suivent l'état réel du produit.

## [Non publié]

### Corrigé — `release:prepare` face à de vrais binaires

- Premier passage de l'outillage sur de vrais exécutables (0.1.0-beta.1) : le contrôle « l'exécutable contient la version » cherchait le texte en UTF-8, or un binaire de Tauri n'écrit pas la version en clair — un `.exe` la porte en **UTF-16** dans sa ressource de version (`FileVersion` / `ProductVersion` vérifiés), un **ELF n'en porte aucune**. Windows : la version est lue en UTF-8 ou en UTF-16 ; Linux : seule la date (l'exécutable doit être plus récent que `tauri.conf.json`) protège d'une construction antérieure au changement de version. Deux tests ajoutés (UTF-16 accepté, autre version refusée ; ELF sans texte de version accepté mais date, clé et en-tête contrôlés), mutation détectée ; `docs/RELEASE.md` mis à jour.

## [0.1.0-beta.1] — 2026-11-15

**Première pré-version publique** (canal bêta, publiée comme *pre-release* GitHub). Windows x86_64 et Linux x86_64 (binaire brut). La clé de signature des mises à jour de production a été créée et sa clé publique est embarquée (`apps/desktop/src-tauri/update-public-key.txt`) : cette version peut donc déjà vérifier les mises à jour signées, sans qu'une mise à jour réelle ait encore été essayée contre GitHub. Pas de signature de code Windows ; la fenêtre Linux n'a été lancée que 20 secondes. Le dépôt de mises à jour proposé par défaut est désormais `vazan/runeforge-npc-editor` (c'était l'ancien dépôt parent `vazan/KingdomOfValhalla`). Le contenu de cette version est l'ensemble des entrées ci-dessous.

### Ajouté — fichiers de communauté pour un projet public

- **Formulaires de tickets** (`.github/ISSUE_TEMPLATE/`) : ajout de **`question.yml`** (question ou aide, étiquette `question` ; les tickets vierges sont désactivés et les Discussions ne sont pas activées) et de **`documentation.yml`** (problème de documentation, étiquette `documentation`). `diagnostic_report.yml` : le niveau de confiance proposé suit désormais l'interface (« unverified » / « non vérifié » au lieu de « unknown »). `config.yml` : lien vers la FAQ du wiki ; le texte public ne contient plus de note destinée au propriétaire.
- **`.github/PULL_REQUEST_TEMPLATE.md`**, **`CONTRIBUTING.md`** et **`SECURITY.md`** (politique de sécurité : signalement privé, périmètre, limites connues ; aucun délai de réponse garanti).
- **README** plus court (anglais et français) : une capture, points forts, démarrage rapide, liens ; le détail est dans le wiki. Pages du wiki « Dépannage et FAQ » et « Développement » (EN et FR) mises à jour.

### Corrigé — documentation : aperçu SFTP et références périmées

- **Aperçu SFTP en lecture seule**, présent dans le code (`crates/remote-transport`, commande `sftp_dry_run`, `SftpDialog`, menu Fichier › Aperçu SFTP…) mais absent des documents, qui annonçaient le SSH/SFTP « à implémenter » : désormais décrit dans `STATUS.md` (M6, RF-018, vérifications du 2026-11-15 : 6 tests Rust et 5 tests TypeScript PASS), `KNOWN_LIMITATIONS.md`, `SECURITY.md` (commandes `sftp_dry_run` et `pick_destination_folder`, section « Aperçu SFTP », **deuxième lancement de processus : le client OpenSSH**), `ROADMAP.md`, `TEST_MATRIX.md` et les guides utilisateur FR/EN. Le **transfert** SSH/SFTP reste à réaliser ; l'aperçu n'a jamais été essayé contre un vrai serveur SSH. Aucun changement de code.
- **Références périmées** : `STATUS.md` ne renvoie plus par lien à `PROMPT_CLAUDE_APPLICATION_COMPLETE.md` ni à `CLAUDE.md` (supprimés par le commit `d2c5b96`, relisibles dans l'historique) ; `Software/LICENSE` devient `LICENSE` dans `LEGAL.md`, `KNOWN_LIMITATIONS.md`, `RELEASE_CHECKLIST.md` et `THIRD_PARTY_LICENSES.md`.

### Ajouté — documentation pour un projet ouvert

- **Wiki bilingue** (`wiki/`, sources compatibles avec un wiki GitHub : 15 pages en anglais `EN-…` et en français `FR-…`, page d'accueil, barre latérale) ; **`README.md`** réécrit en anglais pour un projet open source et **`README.fr.md`** ; captures d'écran de l'E2E dans `docs/images/`.

### Ajouté — modèles de tickets GitHub (`.github/ISSUE_TEMPLATE/`)

- **`bug_report.yml`** (bogue, dont une question obligatoire sur l'intégrité des fichiers de l'utilisateur), **`diagnostic_report.yml`** (fausse alerte, problème manqué ou documentation de commande erronée, avec le résultat observé sur un vrai serveur : l'application n'exécute jamais le serveur) et **`feature_request.yml`** (besoin avant solution, persona, lien vers un identifiant `RF-xxx`). Formulaires en anglais, tickets en français bienvenus ; chacun rappelle de ne jamais coller de secret et de ne publier qu'un extrait minimal anonymisé.
- **`config.yml`** : tickets vierges désactivés ; liens vers le signalement privé des vulnérabilités (`vazan/runeforge-npc-editor`, d'après `origin`) et vers `KNOWN_LIMITATIONS.md`. Le signalement privé doit être activé dans les réglages du dépôt (Settings › Code security) ; le dépôt n'a encore aucun commit, donc rien n'a pu être essayé sur GitHub.

### Corrigé — revalidation Windows et Linux après le déplacement du projet (2026-11-15, DEC-048)

- **`package.json`** : retrait de la dépendance accidentelle `"tauri": "0.15.0"` (ancien paquet npm, ajouté par un `npm install tauri`) ; `package-lock.json` supprimé ; `node_modules` recréé depuis `pnpm-lock.yaml` (inchangé).
- **CI** (`.github/workflows/ci.yml`) : le préfixe `Software/` (16 occurrences) est retiré, le projet étant à la racine du dépôt ; `desktop-build` téléverse l'exécutable brut Windows et Linux (non signé, sans installateur). Analysé, **jamais exécuté sur GitHub**.
- **Docs** : `DEV_SETUP.md` (pièges : pas de `npm`, `target/` périmé après un déplacement), chemin Linux de `RELEASE.md`, « jamais lancé » remplacé par « lancé 20 s sous WSLg, démarre » (README, RELEASE_CHECKLIST, SECURITY).
- **`pnpm build:linux`** (`scripts/build-linux.mjs`) : depuis Windows, copie les sources dans WSL (sans `node_modules`, `target`, `.git`, `release-out`, `*.key` de la racine), construit l'exécutable Linux et le dépose dans `target/release` à côté du `.exe` : `runeforge-studio-linux-x86_64` (l'ELF brut, sans extension comme tout exécutable Linux ; 17 092 344 octets) et **`runeforge-studio-linux-x86_64.AppImage`** (type 2, 89 569 784 octets, WebKitGTK et GTK embarqués ; `tauri build --bundles appimage`), avec contrôle des en-têtes et SHA-256 recalculés côté Windows. Options `--distro`, `--no-appimage`, `--allow-download` : le bundler d'AppImage **télécharge puis exécute** trois outils (AppRun, linuxdeploy, linuxdeploy-plugin-appimage, depuis GitHub) ; sans cache dans `~/.cache/tauri`, le script s'arrête avant de construire (code 6) tant que `--allow-download` n'est pas donné. Vérifié : AppImage lancé 20 s sous WSLg, codes de sortie propagés, option inconnue refusée (code 2). **Limites** : `GLIBC_2.43` exigée (construit sous Ubuntu 26.04), LGPL redistribuée à examiner, AppImage non reproductible, mise à jour en place jamais essayée.
- Aucun changement du code de l'application. Preuves : Windows `pnpm check` 1 728 tests, 180 tests Rust, E2E 44/44 + 9/9 ; Ubuntu 26.04 (WSL2) 1 728 tests, 183 tests Rust, exécutable ELF de 17 Mo.

### Ajouté — M5-S5, mises à jour sous Linux (construit et testé sous Ubuntu 26.04 / WSL2 ; l'application n'a jamais été lancée sous Linux)

- **À la demande du propriétaire** (2026-11-15) : « on doit également couvrir linux » (DEC-047). Le mécanisme de M5-S4 fonctionne désormais pour **Windows et Linux** : **une seule release signée** porte un exécutable par système (`runeforge-studio-<version>-windows-x86_64.exe`, `runeforge-studio-<version>-linux-x86_64`) et chaque ordinateur lit l'entrée de sa plateforme. Cela remplace « Windows seulement » dans l'entrée M5-S4 ci-dessous.
- **Remplacement atomique sous Linux** : un seul `rename` par-dessus l'exécutable en cours d'exécution (le processus garde l'ancien fichier, le chemin ne manque jamais), droits de l'ancien fichier — bit d'exécution compris — recopiés sur le nouveau (GitHub n'en conserve aucun), ancienne version gardée en `<nom>.old` (lien dur, sinon copie) jusqu'au démarrage suivant. Le fichier remplacé est celui que Tauri relance (`current_binary`, dont `$APPIMAGE`). Dossier non modifiable ou système de fichiers en lecture seule : `not_writable`, avec un message qui renvoie au gestionnaire de paquets.
- **Format d'exécutable par système** : `MZ` pour `windows-*`, `\x7fELF` pour `linux-*`, vérifié après le SHA-256 (`not_executable`) ; un système que l'on ne sait pas installer ne télécharge rien (`unsupported_platform`) ; l'interface dit « n'existe que sous Windows et Linux ».
- **Outillage** : `pnpm release:prepare --artifact <plateforme>=<fichier>` (répétable ; `--exe` reste l'alias de Windows) applique à chaque exécutable les contrôles existants (en-tête de son système, clé publique de production, aucune clé de test, version, date) puis signe **un** manifeste ; `release:publish` envoie tous les fichiers. `docs/RELEASE.md` : « Construire pour Linux » (paquets, commande, premier lancement avec `chmod +x`). `scripts/licenses-report.ts --target <triplet>`.
- **TLS** : `ureq` passe à `native-tls-no-default` — le TLS du système (schannel, OpenSSL) sans la liste de certificats de Mozilla que l'application n'utilisait pas : `webpki-root-certs`, le seul composant « à examiner », n'est plus lié. Inventaire des licences Linux : `docs/THIRD_PARTY_LICENSES_LINUX.md` (298 caisses Rust livrées, mêmes cinq MPL-2.0, aucune GPL ni LGPL).
- **Corrigé en chemin** : `.gitattributes` protège les manifestes signés des fixtures (`crates/updater/tests/fixtures/** -text`) — avec `core.autocrlf=true`, Git aurait converti leurs fins de ligne à l'extraction sous Windows et cassé leurs signatures (défaut latent de M5-S4) ; un test de `isInside` utilisait des chemins Windows en dur. **Trouvé par les mutations sous Linux** : aucun test ne protégeait le retrait d'une sauvegarde `.old` périmée qui est un lien vers l'exécutable — `std::fs::copy` sur un lien dur vers sa source rend `Ok(0)` et **tronque le fichier** ; test ajouté.
- **Qualité** : 1 728 tests TypeScript / 90 fichiers (+15) sous Windows et sous Linux ; tests Rust : 180 sous Windows (165 avant), 183 sous Linux ; clippy `-D warnings` des deux côtés ; l'exécutable Linux se construit (ELF de 17 Mo) ; mutations : 19 sous Windows (18 détectées, 1 équivalente), 12 sous Linux (12 détectées) ; E2E Windows 44/44 et 9/9 (3e exécution : les deux premières avaient échoué sur une étape sensible au timing) ; audit d'accessibilité sans défaut.
- **Limites** : **l'application n'a jamais été lancée sous Linux** (aucun serveur d'affichage ni WebKit WebDriver installé) : rendu de WebKitGTK, Monaco, IME, clavier, démarrage, accessibilité et mise à jour dans la fenêtre sont inconnus ; une distribution (Ubuntu 26.04), une architecture (x86_64) ; ni AppImage, ni `.deb`, ni `.rpm` ; le TLS réel vers GitHub n'a pas été essayé ; la clé de production et la première release restent à créer. Voir `KNOWN_LIMITATIONS.md`.

### Ajouté — M5-S4, mises à jour signées depuis les releases d'un dépôt GitHub (vérifié sur Windows contre un faux GitHub local)

- **À la demande du propriétaire** (2026-11-15) : un système de mise à jour « basé sur les releases du git privé » pour que les utilisateurs mettent l'éditeur à jour depuis l'application (DEC-046). **Aide › Mises à jour…** (ou Paramètres › Mises à jour) : dépôt (`propriétaire/nom`), canal (stables seulement, ou stables et bêta), jeton d'accès pour un dépôt privé, « Rechercher des mises à jour », version/date/taille/notes, « Installer et redémarrer » avec barre de progression. **Rien n'est contacté avant l'appui sur « Rechercher »** (pas au démarrage, pas à l'ouverture de l'onglet).
- **Un manifeste signé fait foi, GitHub n'est qu'un transport** : chaque release porte `update-manifest.json` (version, canal, notes, taille et SHA-256 de l'exécutable) et sa signature minisign (format de `tauri signer`) ; l'application embarque la clé publique et vérifie la signature (`minisign-verify`) avant de lire le manifeste. Un dépôt, un compte ou un réseau compromis peuvent empêcher une mise à jour, jamais en imposer une. Jamais de retour en arrière, le canal stable ignore les pré-versions, l'étiquette et l'indicateur « pre-release » de GitHub doivent concorder avec le manifeste signé.
- **Client natif** (`crates/updater`, Rust) : `ureq` avec le TLS de Windows ; première requête vers `https://api.github.com` seulement, **qui seule porte le jeton** ; redirections vers HTTPS `github.com`/`*.githubusercontent.com` seulement ; tailles bornées ; erreurs en codes stables (25) expliqués en français et en anglais, sans texte du serveur ni adresse. Commandes IPC `update_check` et `update_install` (27 commandes en tout).
- **Installation** d'un exécutable en cours d'exécution par renommages dans le dossier de l'application (téléchargement `.download` vérifié — taille, SHA-256, en-tête `MZ` —, puis `.old`/`.new`), avec retour arrière, nouvel essai des renommages (antivirus), redémarrage et nettoyage au démarrage suivant. Accord de l'utilisateur dans une boîte de dialogue du système ; refusée tant que des modifications ne sont pas enregistrées.
- **Jeton en mémoire seulement** (jamais dans les réglages, le journal ni un fichier). Réglages : `updates.repository` et `updates.channel`. Journal de diagnostic : `UPDATE_CHECK`, `UPDATE_INSTALL`, `UPDATE_FAILED code=…`.
- **Outillage du propriétaire** : `pnpm release:keygen` (paire de clés hors du dépôt, clé publique copiée dans `update-public-key.txt`), `pnpm release:prepare` (manifeste, signature, contrôles : version de `tauri.conf.json`, clé publique embarquée, aucune clé de test), `pnpm release:publish` (brouillon de release, aperçu par défaut). Procédure : `docs/RELEASE.md`.
- **Dépendances** (acceptées par le propriétaire) : `minisign-verify`, `ureq` avec `native-tls` et leurs dépendances (+14 composants livrés) ; `webpki-root-certs` (CDLA-Permissive-2.0) est à faire examiner. Un client HTTP est désormais lié pour Windows (voir `SECURITY.md`).
- **Corrigé en chemin** : le piège du focus de `Modal` laissait sortir Maj+Tab quand un dialogue s'ouvre sur un onglet qui n'est pas le premier, par exemple Paramètres › À propos (défaut existant, trouvé par l'audit d'accessibilité sur le nouvel onglet).
- **Qualité** : 1 713 tests TypeScript / 90 fichiers (+82), 165 tests Rust (dont 59 pour `crates/updater`, 5 pour les commandes) ; 62 mutations du code, 58 détectées (4 jugées équivalentes) ; E2E sur l'exécutable réel : 44/44 et **9/9 pour les mises à jour** (dont une vraie installation avec redémarrage) ; audit d'accessibilité sans défaut (onze écrans, huit dialogues).
- **Limites** : la **clé de signature de production n'existe pas** (action du propriétaire : `pnpm release:keygen`) et **aucune release réelle n'a été publiée** ; le TLS réel vers GitHub, les redirections d'un dépôt privé et les limites de débit n'ont jamais été essayés ; Windows seulement ; pas de signature de code Windows. Voir `KNOWN_LIMITATIONS.md` (« Mises à jour signées »).

### Ajouté — M8-S1d, la classe du personnage de test se choisit par son nom (vérifié sur Windows)

- **À la demande de l'utilisateur** (2026-11-15) : la fenêtre « Simuler le dialogue » ne demande plus un « Class ID » (un nombre) mais la **classe par son vrai nom**, dans une liste déroulante (Novice, Swordsman, Magician, … Knight, … Rune Knight, Dragon Knight…). Le script lit toujours le numéro correspondant dans `Class` (DEC-045). L'étiquette devient « Classe » (« Class »), Novice est la classe par défaut.
- **Les noms sont ceux du serveur, pas une liste écrite à la main** : `packages/emulator-rathena/lib/generate-script-constants.ts` lit `job_name()` de `src/map/pc.cpp` (la fonction derrière la commande `jobname()`) et `conf/msg_conf/map_msg.conf`, et évalue chaque `case JOB_…` avec la valeur du symbole : **181 identifiants nommés, 153 classes** (une monture ou un costume du même nom que la classe — `JOB_KNIGHT2`, `JOB_SUMMER2`… — n'a pas de ligne), par identifiant croissant. Les noms restent en anglais dans les deux langues (« Swordsman », « High Novice », « Rune Knight T »).
- **Qualité** : 3 tests de la liste (noms de référence, une ligne par classe, chaque identifiant proposé est aussi la valeur d'une constante `Job_*` du serveur) et 1 test de la fenêtre (aucun champ numérique, la liste commence par Novice, « Rune Knight » donne `Class` = 4054) ; l'E2E sur l'exécutable réel vérifie la liste (plus de 100 noms, Novice en tête) et joue un « Knight » choisi par son nom (`class 7 is a knight`) ; audit d'accessibilité sans défaut.
- **Limites** : voir `KNOWN_LIMITATIONS.md` — les noms ne sont pas traduits ; un identifiant que `job_name()` ne nomme pas ne se choisit plus ; `jobname()` n'est pas simulée.

### Ajouté — M8-S1c, le simulateur de dialogues ne s'arrête plus sur une erreur (vérifié sur Windows)

- **Le but, précisé par l'utilisateur** (2026-11-15) : ne plus voir d'erreur en utilisant le simulateur, sans avoir à corriger les NPC (DEC-044). Après M8-S1b il restait 50 parties arrêtées sur 73 664 (« Opération … invalide ») et des refus à l'ouverture : un fichier de plus de 512 Kio (3 fichiers du serveur de référence), un NPC avec une erreur de syntaxe ou un corps non fermé (« Sélectionnez un NPC complet sans erreur de syntaxe »).
- **Plus aucune issue d'erreur.** Une opération que le serveur refuserait (division par zéro, `getarg` sans l'argument, label ou sous-programme introuvable, `return` hors d'un appel, texte mêlé à un nombre, Zeny négatif, `delitem` de trop, indice de tableau hors bornes, dépassement...) est notée **« Opération invalide (raison) : instruction — le serveur arrêterait le script ici ; la simulation continue avec une valeur par défaut »** à sa place, et le dialogue continue (0, indice borné, calcul sur les nombres que les textes représentent). Une syntaxe que la simulation ne sait pas calculer est « Non simulé ». Seules les limites de ressources (boucle sans fin, texte démesuré...) interrompent encore une partie, par un message d'état poli qui cite l'instruction atteinte, plus par une alerte. Un défaut du simulateur lui-même est rattrapé et noté (« Problème du simulateur »), jamais propagé.
- **Les causes des arrêts restants, traitées** : `select("")` (menu sans option : le joueur ne peut qu'annuler, le script se termine, comme sur le serveur) ; une fonction inconnue comparée à un texte (`instance_live_info(ILI_NAME) == "…"` : la valeur supposée prend le type de ce qu'elle rencontre, sans reproche au script) ; `callfunc` vers une fonction d'un autre fichier (ci-dessous) ; un script réellement fautif (`gld_mission_exchange.txt` lit `getarg(4)` après quatre arguments) : noté, le dialogue continue.
- **Les fonctions des autres fichiers du projet sont exécutées** : `callfunc "F_Nom"` retrouve la fonction par l'index du langage, lit son fichier (le texte non enregistré d'un onglet ouvert, sinon le disque, par le service de fichiers du projet), l'exécute avec celles qu'elle appelle à son tour (150 recherches au plus) et cite dans la transcription le fichier de la fonction exécutée. Sans index, ou pour une fonction qu'il ne connaît pas, l'appel reste noté « Non simulé ».
- **Le dialogue ne refuse plus un NPC** : un NPC avec des erreurs de syntaxe ou un corps non fermé est joué (la fenêtre annonce « Problèmes de syntaxe dans ce NPC : N », le reste est « Non simulé ») ; le plafond de taille passe de 512 Ki à 4 Mi caractères ; un fichier sans NPC à script explique qu'il n'y a rien à simuler.
- **Mesures** (`scripts/simulation-report.ts`, désormais aussi : écarts, NPC mal formés, `--mutate N`) : sur les 9 211 NPC à corps du serveur de référence, **73 688 parties, 0 limite, 0 arrêt, 0 défaut** (au lieu de 50 arrêts) ; 52 écarts, tous des `getarg` après un `callfunc` vers un autre fichier, qui deviennent 8 avec toutes les fonctions du corpus (le défaut réel de `S_Kvasir`). Mêmes résultats sur les 9 219 NPC de `upgraded-kov` (73 752 parties). **Robustesse** : 24 581 variantes de ces NPC abîmées au hasard (suppression, ponctuation et commandes fautives insérées, troncature, lignes dupliquées ou échangées) jouées en 196 648 parties : **0 exception, 0 défaut interne**, 164 limites (les boucles `while (1) { }` insérées), 3 437 écarts notés.
- **Qualité** : 1 627 tests TypeScript (+41) sur 83 fichiers (93 pour le moteur dont 4 pour la résolution des fonctions, 9 pour la fenêtre, 5 pour le contrôleur ajoutés) ; **50 mutations** de la reprise sur erreur, du moteur à la fenêtre : 44 détectées d'emblée, 6 survivantes qui ont donné 6 tests (alors détectées).
- **E2E et accessibilité sur l'exécutable réel (WebView2)** : l'étape « simulation de dialogue » exécute désormais une fonction d'un autre fichier (`F_Lib`) et franchit une division par zéro (note « Opération invalide (division par zéro) » sans alerte) : **44/44 étapes, deux exécutions** ; audit d'accessibilité **sans défaut** (le NPC de l'audit note une instruction non simulée et une division par zéro : 81 textes par thème sans contraste insuffisant, 296 nœuds sans contrôle sans nom, 7 dialogues conformes).
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Simulation de dialogue ») — après un écart, le déroulé affiché est celui du simulateur, pas celui du serveur ; un nom de fonction calculé ou une fonction hors de l'index n'est pas résolu ; aucun événement (`OnTimer`, `OnTouch`) n'est déclenché ; pas d'essai avec un lecteur d'écran ; `cargo test`, `startup.ts` et `licenses-report.ts` non rejoués (aucun changement Rust ni de dépendance).

### Ajouté — M8-S1b, simulateur de dialogues complet, paquet `simulation-core` (vérifié sur Windows)

- **Le rapport « Requires the server or an unsupported operation: bard_q, line 33 »** (Bard#2, puis tous les NPC essayés) était exact : l'ancien simulateur ne connaissait que `.@x`, `@x`, `Class`, `BaseLevel` et `Zeny`. Mesuré sur les 9 208 NPC du serveur (deux personnages, deux stratégies de réponse, 36 832 parties) : **67,2 % des parties s'arrêtaient** sur « opération non prise en charge » et seuls 3 119 NPC allaient jusqu'à une fin.
- **Nouveau moteur** `packages/simulation-core` (sans dépendance UI, DEC-043) : variables de toute portée (`bard_q`, `#x`, `$x`, `.x`, `.@x`) et tableaux, constantes, `switch`, `while`/`do`/`for`/`break`/`continue`, `goto`, `callsub`/`callfunc`/`getarg`/`return`, fonctions locales, `input`, `close2`, une centaine de commandes et fonctions (quêtes, inventaire, texte, nombres, temps, hasard à graine), et `OnInit` exécuté avant la première visite. La sémantique suit `script.cpp` et le manuel du serveur : noms insensibles à la casse, un mot nu inconnu est une variable à 0, `set` convertit au type de la variable, les deux côtés de `&&`, `||` et `?:` sont évalués, entiers 64 bits, `delitem` de trop retire ce qui existe puis arrête.
- **Ce que le serveur calculerait n'arrête plus le dialogue** : une instruction non simulée (`cutin`, `warp`, `specialeffect`…) est listée **« Non simulé »** à sa place, avec l'extrait du script ; une fonction inconnue vaut 0 et est signalée **« Résultat supposé »**, remplaçable par le test (champ « Résultats supposés des fonctions »). Les choix, les saisies et les paroles du NPC (`npctalk`, `announce`) apparaissent dans la transcription ; les codes de couleur `^RRGGBB` ne sont plus affichés.
- **Constantes du serveur** : `packages/emulator-rathena/lib/generate-script-constants.ts` lit les énumérations de `src/**.hpp` (**10 233 constantes sur 10 264** exportées ; les symboles ambigus sont écartés) ; table chargée à la première simulation seulement, distribuée sous GPL-3.0-only (`LEGAL.md`).
- **Fenêtre** : saisie d'un nombre ou d'un texte, bouton « Fermer la fenêtre de dialogue » pour `close2`, champs nom, graine et résultats supposés, inventaire et quêtes à la fin de la partie.
- **Mesure sur corpus** (`pnpm exec tsx scripts/simulation-report.ts --server-root … --entry npc/re/scripts_main.conf`) : 9 208 NPC, deux personnages, quatre stratégies, **73 664 parties : 99,9 % vont jusqu'à une fin** (au lieu de 32,8 %), 0 opération non prise en charge, 0 limite atteinte, 0 défaut, 7 s ; 50 arrêts, dont 30 viennent de fonctions situées dans un autre fichier (28 arrêts au total si le corpus entier est connu : `--functions project`).
- **Qualité** : 1 586 tests TypeScript (+65) sur 82 fichiers (61 pour le moteur, 5 pour la fenêtre, 3 pour les constantes, 4 anciens tests du simulateur repris) ; **mutations du moteur** : 93 modifications volontaires, 73 détectées d'emblée, 19 après l'ajout de 13 tests, 1 ligne redondante **et incorrecte** supprimée (un texte « 0501 » était lu comme l'objet 501).
- **E2E et accessibilité sur l'exécutable réel (WebView2)** : nouvelle étape qui joue un NPC dans l'application (variable permanente jamais écrite, constante chargée à la demande, `cutin` noté, choix, saisie au clavier réel, `close2`) : **44/44 étapes, deux exécutions** ; audit d'accessibilité **sans défaut** (neuf écrans, sept dialogues). L'audit a trouvé deux défauts de focus, corrigés : le focus tombait sur la page quand le bouton activé disparaissait (Échap ne fermait plus la fenêtre), et `Modal` comptait les contrôles d'un `<details>` fermé comme atteignables (le focus initial n'entrait pas dans le dialogue, Maj+Tab sortait du piège) ; seul le résumé d'un `<details>` fermé est désormais atteignable, ce qui vaut pour tous les dialogues.
- **Limites** : voir `KNOWN_LIMITATIONS.md` (« Simulation de dialogue ») — les fonctions des autres fichiers du projet ne sont pas encore résolues, une partie menée à son terme ne prouve pas que le NPC fonctionne sur le serveur, aucun événement (`OnTimer`, `OnTouch`) n'est déclenché.

### Ajouté — M7-S2b, constructeur de NPC en graphe de nœuds (vérifié sur Windows)

- **Fichier › Créer un NPC avec l’éditeur visuel…** est maintenant un **éditeur de nœuds**, à la demande de l’utilisateur : on glisse une commande de la bibliothèque sur un canevas sombre, on tire un **fil** d’une prise de sortie vers une prise d’entrée, et le script suit les fils (DEC-042). Une condition a deux sorties (Alors, Sinon) ; une entrée accepte plusieurs fils, ce qui fait rejoindre les branches ; un fil qui ferait revenir le flux sur lui-même est refusé.
- Le modèle est `packages/visual-core/src/flow.ts` (sans dépendance UI) : le graphe ne produit jamais le script lui-même, `buildVisualNpc` l’écrit après lecture du graphe en arbre de blocs (jonction d’un `if` = post-dominateur immédiat). Un graphe non structurable est refusé avec une raison (sortie sans fil, nœud non relié, nœud partagé, boucle) au lieu d’être réparé. « Chaque chemin doit finir par `close` ou `end` » remplace « le dernier bloc est un `close` » : un `if`/`else` dont les deux branches ferment complète le script.
- Au clavier : activer une sortie puis une entrée relie ; Suppr débranche, Échap annule, un bouton × nomme et retire chaque fil ; chaque prise est un bouton nommé (« Next output of mes 1: connected to close 2 »). Un clic sur une commande de la bibliothèque l’insère dans la chaîne, après le nœud choisi ; supprimer une commande referme la chaîne.
- **Défauts trouvés par l’E2E dans l’application réelle et corrigés** : la barre d’outils changeait de hauteur à la sélection d’un nœud et décalait le canevas de 27 px sous le pointeur ; un nœud déplacé s’arrêtait à 90 % de sa course parce que le navigateur regroupe les derniers déplacements (la position du relâchement fait désormais foi).
- Remplace la liste imbriquée de M7-S2 (l’interface de dépôt HTML5 et la liste « Add commands to » disparaissent).
- **Qualité** : 1 521 tests TypeScript (+77) sur 80 fichiers ; mutations du noyau (67) et de l’interface (34), toutes détectées après correction (2 contrôles redondants supprimés) ; E2E 43/43 à deux exécutions sur l’exécutable reconstruit, avec un vrai glisser de souris et la vérification que chaque fil finit à ≤ 1,5 px du centre de sa prise ; audit d’accessibilité sans défaut (le canevas sombre est audité dans les deux thèmes).
- **Limites** : création seulement (pas de relecture d’un script existant en graphe), pas de boucle, de `goto` ni de `select`/`menu` à plusieurs sorties, pas d’annulation dans le dialogue ; les positions des nœuds ne sont pas enregistrées. Aucun essai au lecteur d’écran.

### Ajouté — bibliothèque de scripting rAthena intégrée
- Bibliothèque hors ligne de 667 commandes pour complétion, aide au survol et signatures, générée depuis les sources rAthena locales (662 entrées documentées).
- Le manuel n'est plus lu au runtime. Les diagnostics continuent d'utiliser uniquement le code source du serveur sélectionné ; sans source, l'aide demeure active, mais aucune validation de commande n'est faite.
- Ajout du générateur `pnpm run generate:rathena-library`, du texte de licence GPL-3.0-only et des références de provenance. La révision rAthena locale est inconnue; une revue juridique reste requise avant distribution.

### Ajouté — M7-S1, éditeur visuel de dialogues

- **Fichier › Éditeur visuel de dialogues…** affiche le NPC sous le curseur en blocs `mes`, `next`, `close` et `if` avec accolades. Les instructions non converties restent verrouillées et sont conservées telles quelles.
- Les changements s'affichent dans une comparaison avant application. L'application modifie le document en une seule action annulable et vérifie que son texte correspond encore à celui du départ.
- L'édition d'une condition exige une expression complète. La suppression d'un bloc préserve un commentaire de fin de ligne et refuse l'opération lorsque des commentaires se trouvent à l'intérieur du bloc.
- Les deux champs de la comparaison Monaco ont des noms accessibles distincts. L'audit WebView2 couvre sept écrans dans les deux thèmes.
- Le rapport de préservation sur les scripts chargés lit 9 211 NPC dans 841 fichiers. Les 44 022 modifications échantillonnées passent les contrôles de confinement, de syntaxe, de code brut et de commentaires.

### Ajouté — M6, assistants rAthena, Git et déploiement local

- Quatre assistants génèrent un portail, un téléporteur, une boutique ou un soigneur. Ils affichent le script et les résultats de l'analyse statique avant copie, ajout ou création de fichier. Le rapport `wizards-report.ts` valide 1 600 scripts sur les données du serveur de référence et vérifie le rejet de 980 saisies invalides.
- Le panneau Git présente le statut du dépôt et les différences par rapport à `HEAD` après activation explicite du client Git pour le projet.
- Le déploiement local présente un plan avant confirmation, sauvegarde les fichiers remplacés, vérifie la copie et permet de restaurer les versions précédentes. Le transport SSH/SFTP reste à réaliser.

### Ajouté — M5-S3, journal de diagnostic local

- Le réglage de confidentialité active un journal local à rotation. Rust valide chaque type d'événement et la structure de ses champs avant écriture. Le journal reste désactivé par défaut.

### Ajouté — M5-S1 et M5-S2 : démarrage mesuré, accessibilité, sécurité, licences, guide (vérifié sur Windows)
- **Démarrage mesuré dans l'application réelle** (`scripts/e2e/startup.ts`) : fenêtre prête en ~300 ms, **interface rendue en 360–489 ms** (cible du cahier des charges : < 3 s), projet indexé en ≤ 0,5 s, premier fichier dans Monaco en ~0,55 s.
- **Audit d'accessibilité automatisé** (`scripts/e2e/accessibility.ts`, sans dépendance) : noms accessibles par l'arbre du navigateur, langue, contrastes WCAG dans les deux thèmes sur quatre écrans, parcours à la vraie touche Tab, dialogues. Il a trouvé **5 défauts réels**, corrigés :
  la palette de commandes laissait Tab la quitter et cessait de se fermer par Échap hors de sa saisie, sans rendre le focus ; sa liste de résultats et les onglets des paramètres n'avaient pas de nom. Nouveau crochet `useRestoreFocus`.
- **Documentation** : `docs/SECURITY.md` (surface IPC, chemins, CSP, absence de réseau, de télémétrie et de processus — vérifiée), `docs/LEGAL.md` et `docs/THIRD_PARTY_LICENSES.md` (inventaire hors ligne : 250 composants livrés, aucun GPL/AGPL/LGPL, 5 caisses MPL-2.0),
  `docs/ACCESSIBILITY.md`, guide utilisateur `docs/GUIDE_UTILISATEUR.md` / `docs/USER_GUIDE.md`, `docs/RELEASE_CHECKLIST.md` réécrite avec ses preuves.
- Nouveaux outils : `scripts/e2e/startup.ts`, `scripts/e2e/accessibility.ts`, `scripts/licenses-report.ts` ; `Cdp.connect` accepte un intervalle d'interrogation.
- **Qualité** : **1 007 tests TypeScript** (+9), E2E 36/36 à chacune de 3 exécutions sur l'exécutable reconstruit ; 9 mutations des corrections d'accessibilité, toutes détectées.
- **Limites** : aucun lecteur d'écran utilisé ; contraste des éléments non textuels, zoom 200 %, contraste élevé de Windows non audités ; pas d'installateur, de signature ni de mise à jour ; audits de vulnérabilités non exécutés (réseau).

### Ajouté — M4-S3d : constantes d'options aléatoires `RDMOPT_…` (vérifié sur Windows)
- **Constantes `RDMOPT_<Option>`** : le serveur les crée, à la fin du chargement de `db/item_randomopt_db.yml`, une par option (valeur : son `Id`) ; elles n'étaient ni dans `script_constants.hpp` ni dans `db/const.yml`. Le catalogue les lit désormais
  (`db/item_randomopt_db.yml` et ses imports selon le mode, avec les règles de `parseBodyNode` : `Id` sur 16 bits, `Option` et `Script` exigés pour une nouvelle entrée, un nom d'option déjà pris par un autre identifiant fait ignorer l'entrée,
  `Header: Clear`) : elles sont proposées, décrites et cherchées comme les autres constantes (Ctrl+Maj+D), et un label de ce nom est refusé (`RA0014`). Un nom déjà pris par le code du serveur ou `const.yml` n'est pas remplacé.
- Nouveaux : `readRandomOptionDatabase`, `RATHENA_PATHS.randomOptionDb`, `DatabaseSources.randomOptions`, `ReferenceSourcesInput.randomOptions` (facultatif), `RathenaCatalogReport.constants.randomOptions`.
- **Mesures** (serveur local, `catalog-report.ts`) : 249 options → 249 constantes ; **10 552 constantes** (10 303 avant), **identiques à l'analyseur YAML complet** (0 différence de nom ni de valeur) ; catalogue construit en 105 ms ;
  l'application sur le serveur réel affiche « 10552 constants » dans la barre d'état.
- **Qualité** : **998 tests TypeScript** (+18 depuis M4-S3c) / 53 fichiers, 52 tests Rust, clippy strict, **E2E 36/36 à chacune de 3 exécutions** sur l'exécutable reconstruit avec le code final (M4-S3c et M4-S3d) ; 23 mutations du code, toutes détectées.
- **Documentation** : `docs/COMPATIBILITY.md` (nouveau) : matrice des émulateurs (rAthena Renewal vérifié par lecture, pre-renewal partiel, Hercules `BLOCKED_EXTERNAL`), fichiers lus, règles prouvées, liste de contrôle pour débloquer Hercules.
- **Limites** : le `Script` des options n'est ni lu ni vérifié ; pas de fichier d'options en pré-renewal ; les constantes enregistrées à l'exécution par d'autres bases restent inconnues du catalogue.

### Ajouté — M4-S3c : ordre de chargement des fonctions, `RA0016` (vérifié sur Windows)
- **`RA0016` (nouveau)** : un appel **par son nom** (`Nom arg;`, `Nom(arg)`) d'une fonction globale que le serveur ne connaît pas encore à cet endroit — définie dans un fichier chargé après l'appelant, dans un fichier qu'il ne charge pas, plus bas dans le
  même fichier, ou dans l'appelant lui-même (récursion). Le serveur enregistre une fonction **après** l'analyse de son corps (`npc_parse_function`) et refuse l'appel d'un nom inconnu (`parse_callfunc` : « calling undeclared function ») :
  le script ne se charge pas. Erreur, confiance « probable » ; `callfunc "Nom"` (résolu à l'exécution) n'est pas concerné ; un nom défini nulle part reste à `RA0001`.
- **Ordre de chargement** : le contrôleur le lit dans les listes de scripts du serveur (`npc:`, `import:`, `delnpc:`, `npc: clear`) à chaque synchronisation de l'index — en portée « loaded » comme « sources » — et ne le renvoie au service que s'il change ;
  un changement refait les diagnostics des documents ouverts et périme le rapport de projet. Une liste vide ne dit rien du serveur. Nouveaux : `WorkspaceIndex.setLoadOrder` / `loadOrderDiagnostics`, `LanguageServer.setLoadOrder`, méthode `setLoadOrder` du worker.
- **Conséquence visible** : le mini serveur de l'E2E appelait par son nom `F_Lib`, définie hors des listes de scripts ; l'étape correspondante signale désormais `RA0016` en plus (`RA0001` reste absente).
- **Mesures** (serveur local, `scripts/order-report.ts`, oracle qui lit le texte brut) : 149 fonctions globales, **822 appels par leur nom** (même nombre pour l'oracle et l'analyse), **0 `RA0016`** sur les 841 scripts chargés ; **183 ordres mutés, 150 426 verdicts
  identiques à l'oracle** ; 149 définitions déplacées (444 appels prématurés signalés au bon endroit) ; 149 récursions injectées toutes signalées.
- **Qualité** : 980 tests TypeScript (+41), 52 tests Rust, clippy strict, **E2E 36/36** sur l'exécutable reconstruit (une étape de plus : ordre de chargement) ; 42 mutations du code, 40 détectées et 2 équivalentes déclarées.
- **Limites** : l'ordre est celui des listes au démarrage (`@loadnpc` et autres chargements non modélisés) ; relu à la synchronisation de l'index, pas à l'enregistrement d'un `scripts_*.conf` ; un mot nu qui nomme une fonction dans une expression n'est pas reconnu comme appel.

### Ajouté — M4-S3 (a, b) : cartes des déclarations et labels réservés (vérifié sur Windows)
- **Cartes chargées par le serveur** : `map:`, `delmap:` (`all`), `map: clear` et `import:` de `conf/map_athena.conf` sont lus comme `map_config_read` (extension `.gat` retirée, doublons gardés, casse exacte) ; la liste
  rejoint le catalogue de références (`loadedMaps`) jusqu'au worker ; **une liste absente ou vide est « inconnue » et ne déclenche jamais d'alerte** ; la barre d'état dit combien de cartes sont chargées.
- **`RA0008` étendu** à la carte de chaque déclaration de premier niveau (script, warp, boutique, monstres, duplicate, mapflag) et à la destination d'un warp — le serveur ignore la déclaration en journalisant une erreur
  (`npc_parsesrcfile`, `npc_parse_warp`). **Garde ajoutée** : un index des cartes vide (`db/map_index.txt` non lu) ne rend plus aucune carte « introuvable » (c'était aussi le cas des arguments `warp "…"` depuis M4-S2).
- **`RA0015` (nouveau)** : déclaration sur une carte de l'index que le serveur ne charge pas — il l'**ignore sans aucun message** (le NPC « n'apparaît pas » et le journal est muet). Information, confiance « probable »,
  réglage `validation.unknownReferences` ; jamais pour une ligne `mapflag` ni une destination de warp (les 26 déclarations du serveur local sur une carte non chargée sont toutes des lignes `mapflag` livrées ainsi).
- **`RA0014` (nouveau)** : un label ou une fonction locale dont le nom est une commande de la table du serveur, une constante ou un paramètre qu'il exporte — le serveur le refuse (`set_label: invalid label name`) et le
  label n'existe pas. Erreur, confiance « probable » ; ne juge ni le manuel seul, ni les commandes ou constantes du projet, ni les commandes compilées sous condition.
- Nouveaux : `ScriptLoadReport.maps`, `ReferenceCatalog.{mapIsLoaded, loadedMapCount, hasMaps}`, `resolveLoadedMaps` (application), outils `scripts/maps-report.ts` et `scripts/labels-report.ts`.
- **Mesures** (serveur local) : liste des cartes chargées **identique** à celle d'un lecteur indépendant (1 218) ; **33 933 déclarations, 37 108 noms de carte** contre un oracle indépendant : 0 faux positif, 0 faux négatif ;
  mutations 619/619 (cartes inconnues, dont 93/93 destinations de warp), 429/429 (cartes non chargées), 97/97 (mapflag non signalé), 0 parasite ; **12 010 labels : 0 `RA0014`**, 2 886 mutations toutes détectées ;
  aucun surcoût mesurable (analyse des 841 scripts : 1,4 s).
- **Qualité** : 939 tests TypeScript (+42 depuis RF-015), 52 tests Rust, clippy strict, **E2E 35/35** sur l'exécutable réel (une étape de plus : cartes et labels) ; 21 mutations du code des cartes et 8 de celui des labels,
  toutes détectées (les survivantes ont fait ajouter 3 tests et retirer un garde redondant).
- **Limites** : un serveur à plusieurs serveurs de cartes peut charger ailleurs une carte signalée par `RA0015` (d'où « information ») ; coordonnées hors carte non vérifiées (il faudrait lire les cartes) ; la liste des cartes
  chargées est relue au démarrage du serveur du projet et à chaque changement de ses réglages, pas à la modification d'un `maps_athena.conf` ; constantes `RDMOPT_…` et constantes ajoutées à l'exécution inconnues du catalogue.

### Ajouté — RF-015 : rapport de projet (vérifié sur Windows)
- **Rapport de projet** (Ctrl+Maj+M, menu Affichage, palette, bouton du panneau des problèmes) : les problèmes de **tous les fichiers indexés** — pas seulement des fichiers ouverts —, fichier par fichier,
  **les plus graves d'abord**, chacun avec sa position (ligne:colonne) et son conseil de correction ; totaux par gravité et par code ; filtres (gravité, code, chemin) ; ouverture au clic **à la position du problème**,
  même dans un fichier fermé ; **copie en texte** (Markdown) pour un ticket ou un message ; bouton « Actualiser ». Les mêmes diagnostics que le panneau des problèmes (texte de l'éditeur pour un fichier ouvert).
- **Instantané honnête** : dit quand il est périmé (un document modifié, une indexation terminée, un réglage changé) et se recalcule alors tout seul s'il est à l'écran ; jamais calculé tant qu'on ne l'a pas demandé ;
  « partiel » (et recalculé à la fin) s'il est demandé pendant l'indexation ; détail borné à 5 000 problèmes avec totaux exacts.
- **Seulement les scripts que le serveur charge, par défaut** (serveur reconnu, portée d'index `sources`) : sur le serveur local, 454 des 1 295 fichiers indexés (documentation, bases, configuration, autre mode de
  compilation) ne sont jamais lus par le serveur et auraient donné **12 700 erreurs** sans rapport avec lui ; la vue par défaut montre les 4 fichiers qui comptent (3 erreurs, 1 information), dit ce qu'elle laisse de
  côté et pourquoi, et une case montre tout. Le défaut de la portée d'index reste inchangé.
- **Problèmes de chargement du serveur** (script cité dans `scripts_*.conf` mais absent, réglage inconnu, import circulaire…) : listés avec `fichier:ligne`, ouverts à la ligne.
- Nouveaux : `LanguageServer.projectReport({ only })` (`runescript-language-server`), `ProjectReportState` et `AppController.{showProjectReport, refreshProjectReport, setReportHideUnloaded, copyProjectReport}`,
  `ReportPanel`, `report-text.ts` ; outil `scripts/project-report.ts` (quatre scénarios sur un vrai serveur, positions et totaux vérifiés par des calculs indépendants) ; `real-server-smoke.ts` mesure aussi le rapport.
- **Corrigé** : (1) **mise en page** — avec 12 onglets ouverts ou plus, la page devenait plus large que la fenêtre (colonne de grille `auto`), boutons du panneau du bas et barre d'état hors d'atteinte ;
  corrigé et gardé par une étape E2E ; (2) la limite du détail du rapport s'appliquait avant la restriction aux scripts chargés : les fichiers de bruit épuisaient la limite et les vraies erreurs perdaient leur
  détail (trouvé en mesurant sur le serveur réel, corrigé et couvert par un test de non-régression) ; (3) le scénario E2E restait suspendu sur une promesse de la page qui ne se résout jamais : les commandes CDP ont un délai ;
  (4) hauteur par défaut du panneau du bas 220 → 280 px.
- **Mesures** (serveur local) : rapport de 841 scripts en **~1 ms** (médiane), de 1 133 fichiers en 2,3 ms, de 5 046 fichiers en 113–134 ms (cas extrême : détail coupé à 5 000, 31 ms de clonage) ; dans l'application,
  rapport affiché 35 ms après la demande (voir `PERFORMANCE.md`).
- **Qualité** : 897 tests TypeScript (+64), 52 tests Rust, clippy strict, **E2E 34/34** sur l'exécutable réel (deux nouvelles étapes : mise en page avec 13 onglets, rapport) ; tests du service, du contrôleur et du
  panneau contrôlés par mutation (une mutation survivante a révélé un code mort, supprimé).
- **Limites** : instantané des fichiers indexés ; avec les vérifications entre fichiers activées, des `RA0005` causés par des fichiers non chargés subsistent sur les fichiers chargés (portée « chargés » : 0) ;
  copie seulement (pas d'export de fichier) ; filtres non conservés d'un onglet à l'autre ; liste non virtualisée (300 fichiers au plus).

### Ajouté — M4-S2 : bases du serveur (objets, monstres, cartes, constantes), vérifications et recherche (vérifié sur Windows)
- **Catalogue de références lu à l'exécution** dans le serveur de l'utilisateur (rien n'est embarqué, DEC-012) : `db/item_db.yml` et `db/mob_db.yml` avec leurs imports (selon le mode
  `re`/`pre-re`, puis `db/import/`), `db/map_index.txt`, `db/const.yml` et les constantes exportées par `src/map/script_constants.hpp`. Lecteur **par indentation** (sans arbre YAML), qui
  compte ce qu'il ne comprend pas ; règles de fusion du serveur (entrée partielle, `AegisName` en double, `Clear`, bornes d'identifiants). Chaque enregistrement garde `fichier:ligne`.
- **`RA0008` carte, `RA0009` objet, `RA0010` monstre introuvables** : l'argument écrit en clair (nombre ou chaîne) d'une commande dont le **manuel** nomme le paramètre est cherché dans le
  catalogue ; information de confiance « inconnue », gravité réglable (« Objets, monstres et cartes introuvables »). Jamais une variable, une expression, zéro, un négatif, une valeur
  spéciale (`Random`, `SavePoint`, `this`…) ni un texte qui n'est pas un nom de carte.
- **Complétion** à l'argument d'un objet, d'un monstre ou d'une carte (identifiant hors chaîne, nom dans une chaîne, détail `501 · Red Potion · Healing`), **constantes** et paramètres du serveur
  à une position d'opérande ; **survol** d'une référence (nom, identifiant, AegisName, type ou niveau, source) ou d'une constante ; liste « incomplète » redemandée en continuant la saisie.
- **Recherche et insertion** (RF-012) : Ctrl+Maj+D ouvre la palette sur les objets, monstres, cartes et constantes (`item:`, `mob:`, `map:`, `const:` restreignent) ; Entrée insère l'identifiant,
  Maj+Entrée le nom entre guillemets (sans guillemets dans une chaîne ouverte) ; l'insertion est une édition annulable.
- **Constantes du projet** (`constants.custom` de `project.json`, éditables dans les paramètres) ; **barre d'état** : contenu des bases en info-bulle ; réglage `validation.unknownReferences`.
- Nouveaux : `ReferenceCatalog`, `argumentKindsOf` (`emulator-core`) ; `yaml-db`, `database-readers`, `catalog` (`emulator-rathena`) ; outils `scripts/catalog-report.ts` (comparaison à un
  analyseur YAML complet — paquet `yaml`, dépendance de développement de ce seul outil) et `scripts/references-report.ts` ; `real-server-smoke.ts` mesure aussi les bases et la complétion d'un objet.
- **Mesures** (serveur local) : **27 826 objets, 2 555 monstres, 1 248 cartes, 10 303 constantes** lus et construits en **110–141 ms** (analyseur complet : 3,5 s), **identiques à l'oracle**, 23,5 Mo
  (43,8 Mo avant de copier les chaînes extraites) ; dans l'application, bases lues 150 ms après le registre ; **26 428 arguments réels vérifiés, 1 signalé = une vraie erreur du script du serveur**,
  mutations 440/440 sans alerte parasite ; survol 1 054/1 054, complétion 1 042/1 054 ; liste de complétion d'un objet affichée en ~12 ms (médiane).
- **Corrigé** : une première version signalait `warpparty "RandomAll"` (valeur spéciale du manuel) et ignorait les cartes à tiret ou en `@` ; le lecteur gardait en mémoire le texte de chaque
  fichier de bases (copie des chaînes extraites : −46 %).
- **Qualité** : 833 tests TypeScript (+102), 52 tests Rust, clippy strict, **E2E 32/32** sur l'exécutable réel.
- **Limites** : rAthena seulement ; seuls les arguments que le manuel nomme sont vérifiés ; `use_sql_db: yes`, constantes `RDMOPT_…` et cartes chargées non pris en compte ; Hercules sans catalogue.

### Ajouté — M3-S3 : commandes dans l'éditeur, commandes du projet, modèles de NPC (vérifié sur Windows)
- **Complétion des commandes** à partir du registre du serveur (début d'instruction et opérande d'une expression ; Ctrl+Espace quand rien n'est
  encore saisi) : signature en bref, source (« commande rAthena », « commande personnalisée (projet) »), commandes obsolètes barrées ;
  **l'aide du manuel s'affiche à la sélection** (panneau de détails). 1 000 propositions au plus.
- **Aide de signature** (Ctrl+Maj+Espace, et automatiquement après l'espace qui suit la commande, `(` et `,`) : la signature du manuel avec le
  paramètre courant en évidence ; silencieuse sur le nom de la commande, dans un commentaire et hors d'un script.
- **Survol des commandes** : signature(s), nombre d'arguments vérifié, extrait du manuel, drapeaux (obsolète, conditionnelle) et provenance
  (`fichier:ligne`).
- **Commandes du projet** (RF-011) : `commands.custom` dans `.runeforge/project.json` (nom, notation des arguments facultative, aide libre),
  modifiables dans les paramètres du projet ; elles complètent le registre du serveur, ne sont plus signalées `RA0001`, sont proposées et
  marquées « personnalisées ». Sans notation des arguments, leur nombre n'est pas vérifié.
- **Action rapide** (Ctrl+.) sur `RA0001` : « Déclarer « X » comme commande personnalisée du projet » (n'écrit que `.runeforge/project.json`).
- **Modèles de NPC** (RF-013) : `npc-script`, `npc-warp`, `npc-shop`, `npc-healer` (snippets Monaco, valeurs à compléter par Tab ; rAthena
  seulement) ; nouveau paquet `@runeforge/npc-templates`.
- **Corrigé** : un `warp` dont l'en-tête n'a que `carte,x,y` était signalé `RS0036` à tort ; le serveur ne lit que ces trois valeurs
  (`npc_parse_warp`), la direction est facultative. Le conseil de `RA0001` (FR/EN) indique désormais comment déclarer la commande.
- Outils : `scripts/commands-report.ts` (oracle : AST du parseur, silence, latences, modèles) ; mesure de la **latence perçue** de la
  complétion dans l'application réelle (`scripts/e2e/completion-latency.ts`, `real-server-smoke.ts`) ; `pnpm e2e --skip-build`.
- **Mesures** (serveur local, 667 commandes) : survol, complétion et aide de signature **conformes à 100 %** sur 12 779 instructions et
  13 377 arguments réels, aide silencieuse aux 25 558 positions voulues, 4 modèles sans diagnostic ; latence perçue de la liste de complétion
  **≈ 11 à 14 ms** (médiane, max 17 ms), dont service 0,1–0,8 ms ; non-régression : registre, corpus, complétion de symboles et renommage
  identiques.
- **Qualité** : 731 tests TypeScript (+146), 52 tests Rust, clippy strict, **E2E 28/28** sur l'exécutable réel.
- **Limites** : rAthena seulement ; arguments non complétés par type (carte, objet, monstre : M4-S2) ; modèles validés par analyse mais jamais
  chargés par un serveur ; plages de paramètres déduites du texte du manuel (seul le rang de l'argument est vérifié).

### Ajouté — M4-S1 : registre de commandes et règles de chargement (vérifié sur Windows)
- **Registre de commandes rAthena lu à l'exécution** dans le serveur de l'utilisateur (rien n'est embarqué, DEC-012) : table `buildin_func[]` de
  `src/map/script.cpp` (noms et nombre d'arguments : fait foi), `src/custom/script_def.inc` (commandes ajoutées), manuel
  `doc/script_commands.txt` (signatures et aide, sans arité). Chaque définition garde sa provenance (fichier:ligne).
- **`RA0006` — nombre d'arguments** et **`RA0001` — commande inconnue** (avertissement, confiance « inconnue », gravité réglable par
  `validation.unknownCommands`) : un nom est accepté s'il est une commande, une fonction locale du script ou une fonction globale de
  l'index. Aucune alerte sans registre, ni pendant l'indexation initiale.
- **Règles de chargement des scripts** (`scripts_*.conf`, `map_athena.conf`) lues comme le serveur (`npc:`, `delnpc:`, `import:`, `clear`/`all`,
  commentaires, ordre) ; mode `re`/`pre-re` déduit de `src/config/renewal.hpp` ou imposé ; racine du serveur détectée (racine du projet ou unique
  serveur d'un sous-dossier ; plusieurs : à choisir).
- **Réglages du projet** : `emulator.root`, `emulator.mode`, `emulator.indexScope` (`sources` par défaut, ou « scripts chargés par le
  serveur » : plus de faux doublons `re`/`pre-re` pour les vérifications entre fichiers) ; champs dans les paramètres du projet.
- **Barre d'état** : registre (nombre de commandes ou état à corriger), avec le détail en info-bulle (niveau, dossier, mode, scripts chargés).
- Nouveaux paquets `@runeforge/emulator-core` (registre, notation des arguments, lecture de `scripts_*.conf`) et `@runeforge/emulator-rathena`.
- Outil : `scripts/registry-report.ts` (registre, scripts chargés, alertes sur le code réel, **mutations de code réel**).
- **Mesures** (serveur local) : 667 commandes ; **0 fausse alerte sur 557 894 appels réels** ; 4 200 mutations toutes détectées au bon endroit ;
  841 scripts chargés identiques (contenu et ordre) à l'outil de mesure indépendant ; l'arité tirée du manuel aurait donné 2 329 fausses alertes.
- **Qualité** : 585 tests TypeScript (+156), 52 tests Rust, clippy strict, **E2E 23/23** sur l'exécutable réel (3 exécutions consécutives).
- **Limites** : rAthena seulement (aucun adaptateur Hercules) ; les commandes ne sont pas encore proposées ni documentées dans l'éditeur
  (M3-S3) ; l'ordre de chargement n'est pas exploité par les diagnostics.

### Ajouté — M3-S2 : complétion, survol et renommage (vérifié sur Windows)
- **Complétion** : labels, événements et fonctions locales du script (arguments de `goto`, `callsub`, `menu`, `jump_zero`, y compris après
  `if (…)`/`else` ou dans une expression), fonctions globales dans `callfunc "…"` (même sur plusieurs lignes), noms de NPC dans
  `duplicate(…)`, variables visibles (`.@x`, `$x`…). Déclenchée à la frappe et par Ctrl+Espace, y compris dans une chaîne. **Les commandes ne
  sont pas proposées** (registre de commandes : M4).
- **Survol** : label (type, ligne, utilisations), fonction globale (définitions, appels), NPC (type, carte, duplicates), variable (portée,
  type, utilisations, première affectation), en français ou en anglais.
- **Renommage sûr (F2)** des labels, fonctions locales et variables locales d'un script ; refus expliqué pour tout ce dont les occurrences
  ne sont pas toutes connues (événements, fonctions globales, NPC, variables globales, script incomplet).
- Réglage « Vérifications entre fichiers » et indicateur d'indexation (rappel M3-S1).
- **Corrigé** : la classe CSS globale `.main` de l'application s'appliquait aussi à l'élément interne `.main` de la liste de complétion de
  Monaco et masquait les libellés ; renommée `workbench-main`, avec une assertion E2E sur la géométrie de la proposition.
- **Mesures** (841 scripts réels) : complétion 1 806/1 806 (`callfunc`) et 107/107 (`goto`), survol 1 913/1 913, **1 002 renommages
  appliqués sans aucun nouveau diagnostic** ; latences de l'ordre de 0,1 ms (service seul).
- **Qualité** : 429 tests TypeScript (+41), 52 tests Rust, clippy strict, **E2E 21/21** sur l'exécutable réel.

### Ajouté — M3-S1 : index du projet et navigation (vérifié sur Windows)
- **Navigation dans l'éditeur** : **F12 / Ctrl+clic** vers la définition (labels, fonctions locales et globales via `callfunc "…"`,
  NPC via `duplicate(…)`, variables), y compris dans un autre fichier ; **plan du document** (Ctrl+Maj+O, fil d'Ariane) ;
  **Maj+F12** : panneau **Références** (une ligne de code par résultat) ; **Ctrl+T** (ou `#` dans Ctrl+P) : recherche des
  fonctions et noms de NPC de tout le projet.
- **Index du projet en arrière-plan** : tous les fichiers de `sources` sont lus par lots, décodés et analysés dans un Worker,
  puis resynchronisés (nouveaux, modifiés, supprimés) ; le texte de l'éditeur, même non enregistré, prime sur le disque ;
  indicateur dans la barre d'état (« Indexation 12/841 », puis « 841 indexés »).
- **Réglage « Vérifications entre fichiers »** (`validation.crossFile` : désactivées par défaut, doublons, ou doublons + références
  non résolues) dans les réglages du projet ; conservé à la réécriture de `project.json`.
- **`@runeforge/runescript-language-server`** (forme LSP : positions `{ligne, colonne}`, `Location`, `DocumentSymbol`) ; protocole
  typé du Worker, répartiteur testable sans Worker, `LanguageClient`.
- Outils : `scripts/language-report.ts` (oracle indépendant sur le corpus réel), `scripts/lib/corpus.ts` partagé ;
  `LineIndex` plus compact (`Int32Array`).
- **Qualité** : 388 tests TypeScript (+65 par rapport à la tranche précédente), 52 tests Rust, clippy strict, **E2E 17/17** sur
  l'exécutable réel (indexation, F12 réelle, Maj+F12, Ctrl+T).

### Ajouté — M2 : analyse sémantique (vérifié sur Windows)
- **`@runeforge/runescript-analysis`** : table de symboles par fichier (NPC, warps, boutiques, `duplicate`, fonctions globales,
  labels, fonctions locales, variables), références (`goto`, `callsub`, `menu`, `jump_zero`, appels de fonctions locales,
  `callfunc "…"`), et `WorkspaceIndex` incrémental pour les vérifications entre fichiers.
- **Diagnostics** : `RA0002` label inconnu, `RA0003` label en double, `RA0012` fonction locale non définie (désormais erreur
  certaine), `RA0007` label inutilisé (désactivé par défaut), `RA0004` fonction introuvable, `RA0005` nom de NPC en double,
  `RA0011` fonction en double, **`RA0013`** source de `duplicate` introuvable (nouveau). Conseils de `RA0005`/`RA0011` réécrits
  d'après le comportement réel du serveur. Un diagnostic peut porter des emplacements liés (`related`).
- **Dans l'application** : le worker de langage calcule maintenant la sémantique locale du document ; le label inconnu est
  souligné dans l'éditeur et listé dans le panneau des problèmes (E2E, 13 étapes).
- **Mesures** (`scripts/analysis-report.ts`, `docs/PERFORMANCE.md`) : 841 fichiers chargés par le serveur local = 0 diagnostic
  local, 0 doublon ; 5 046 fichiers indexés en ~6,8 s ; mémoire de l'index réduite de 52 % (copie des chaînes extraites).
- `docs/LANGUAGE_SPEC.md` réécrit d'après le code réel ; `docs/PERFORMANCE.md` créé ; DEC-019 à DEC-022.
- **Qualité** : 323 tests TypeScript (dont 58 nouveaux), 52 tests Rust, clippy strict, E2E 13/13.

### Corrigé
- `RA0012` était classé avertissement/probable : le serveur refuse de charger un script dont une fonction locale n'est pas
  définie, c'est une erreur certaine.

### Ajouté — M1 : IDE desktop (vérifié sur Windows)
- **Application** : accueil (projets récents, langue/thème), explorateur virtualisé et accessible au clavier, onglets,
  Monaco (coloration par le lexer du moteur, thèmes clair/sombre), panneau des problèmes, barre d'état, menus, palette
  « aller au fichier » et commandes, paramètres (éditeur, projet, confidentialité), FR/EN, notifications.
- **Fiabilité des fichiers** : `crates/filesystem` (racines approuvées, validation de chemins, écriture atomique avec
  précondition SHA-256, historique local, instantanés de récupération, parcours) ; codec d'encodage sans perte (UTF-8/16,
  BOM, windows-1252, multi-octets), fins de ligne mixtes préservées par diff de lignes ; dialogues de conflit, de caractères
  non enregistrables, de récupération et de fermeture.
- **Sécurité** : 20 commandes IPC autorisées une à une (manifeste + capability), CSP stricte côté scripts, aucun accès réseau.
- **Qualité** : 265 tests TypeScript, 52 tests Rust, clippy strict, E2E Windows de 12 étapes sur l'exécutable réel (`pnpm e2e`).

### Ajouté — M0/M2 : moteur de langage
- `@runeforge/runescript-core` : lexer sans perte (offsets UTF-16, trivia), lexer par ligne avec état, index de lignes,
  utilitaires de fins de ligne, catalogue de diagnostics FR/EN (quoi / où / comment corriger, niveau de confiance).
- `@runeforge/runescript-parser` : parseur tolérant (déclarations `script`, `function`, `warp`, `shop`, `monster`,
  `mapflag`, `duplicate` ; instructions et expressions ; récupération d'erreurs ; AST avec plages) — règles dérivées du
  code du serveur rAthena local ; 0 plantage et 0 perte de texte sur ~2 300 scripts réels.
- `scripts/` : `corpus-report.ts`, `roundtrip-report.ts`, scénario E2E.
- Documents de pilotage : `STATUS`, `ROADMAP`, `DECISIONS`, `TEST_MATRIX`, `RELEASE_CHECKLIST`, `KNOWN_LIMITATIONS`, `DEV_SETUP`.

### Compatibilité
- Règles de syntaxe calquées sur rAthena (lecture de `script.cpp`). Hercules : non vérifié. Linux : non testé.
