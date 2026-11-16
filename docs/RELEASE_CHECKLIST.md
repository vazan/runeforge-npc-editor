# Checklist de livraison

Légende : `[x]` fait **et prouvé** (la preuve est citée) · `[ ]` à faire · `BLOCKED_EXTERNAL` = dépend d'un tiers (clés, comptes, avis juridique, machine, accès réseau accordé par le propriétaire).
Rien n'est publié, signé ni commité sans autorisation explicite du propriétaire. État au **2026-11-15** (Windows 11 pour l'application complète ; Linux : construit et testé sous Ubuntu 26.04 / WSL2, **sans fenêtre**).

## Qualité
- [x] Typecheck, lint et tests TypeScript exécutés (1 728 tests, sous Windows et sous Linux). Voir les [résultats courants](STATUS.md).
- [x] Clippy strict et les tests Rust du workspace passent : 180 sous Windows, 183 sous Linux. Voir les [résultats courants](STATUS.md).
- [x] Les 44 étapes du scénario principal et les 9 étapes des mises à jour (CDP/WebView2) passent sur l'exécutable reconstruit (3e exécution ; les deux premières ont échoué sur une étape sensible au timing, voir `KNOWN_LIMITATIONS.md`). Voir la [matrice de tests](TEST_MATRIX.md).
- [x] L’exécutable Windows de production se construit avec `tauri build --no-bundle`.
- [x] L'exécutable Linux de production se construit (`tauri build --no-bundle` / `cargo build --release` sous Ubuntu 26.04 : un ELF de 17 Mo ; `ldd` : `libssl.so.3`, `libwebkit2gtk-4.1.so.0`, `libgtk-3.so.0`, `libsoup-3.0.so.0`). **Lancé une seule fois, 20 s sous WSLg (démarre, reste en vie, DEC-048) ; rien d'autre n'y a été vérifié.**
- [ ] Application lancée et vérifiée sous Linux (rendu de WebKitGTK, Monaco, IME, clavier, démarrage, accessibilité) et E2E Linux (WebKit WebDriver, `tauri-driver`, affichage virtuel) — `BLOCKED_EXTERNAL` (machine de bureau Linux, ou téléchargements dans WSL à autoriser).
- [x] Parseur : corpus mesuré, 0 plantage, 0 perte de texte (`scripts/corpus-report.ts`, M2 ; le parseur n'a pas changé depuis) — **à rejouer avant la livraison**.
- [x] Budgets de performance mesurés — [`PERFORMANCE.md`](PERFORMANCE.md) : démarrage **0,49 s** au pire (cible < 3 s), suggestions 0,1–0,8 ms côté service (liste affichée 11–16 ms) pour une cible < 100 ms, 5 046 scripts indexés en ~6,8 s.
- [x] L'audit automatisé de l'application réelle passe sur onze écrans dans les deux thèmes (noms, langue, contraste du texte, clavier et huit dialogues). Voir [`ACCESSIBILITY.md`](ACCESSIBILITY.md).
- [ ] Tester avec un lecteur d'écran.

## Sécurité — [`SECURITY.md`](SECURITY.md)
- [x] Les 27 commandes IPC sont explicitement nommées. Le test `capability_matches_command_list` vérifie la cohérence avec la capability.
- [x] CSP de production sans `unsafe-eval` ni script en ligne ; l'E2E n'observe aucune erreur de console (CSP incluse).
- [x] Chemins : traversée, liens symboliques, noms réservés Windows, flux NTFS testés (`crates/filesystem`, 42 tests Rust).
- [x] Secrets : le jeton d'accès des mises à jour et la clé API de l'IA restent en mémoire et ne sont jamais enregistrés (réglages, journal, fichiers : testé, dont par l'E2E) ; le stockage sécurisé de l'OS reste à faire si un secret doit survivre à la session.
- [x] Réseau : aucune connexion sans action explicite de l'utilisateur (E2E : rien au démarrage ni à l'ouverture de l'onglet Mises à jour) ; le seul client HTTP lié, pour Windows comme pour Linux, est `ureq`, utilisé par `crates/updater` seulement (`cargo tree`), avec le TLS du système (schannel ; OpenSSL sous Linux, sans liste de certificats embarquée) ; l'IA utilise `fetch` après consentement.
- [ ] `pnpm audit` et `cargo audit` sans vulnérabilité critique non traitée — `BLOCKED_EXTERNAL` (exige le réseau).
- [x] La fonctionnalité `e2e` (et sa clé de mise à jour de test) ne figure pas dans l'exécutable à distribuer : `pnpm release:prepare` refuse un exécutable qui embarque une clé de test ou qui n'embarque pas la clé de production. À rejouer pour chaque version.

## Données utilisateur
- [x] Ouvrir puis enregistrer sans modification = fichier non réécrit (tests du gestionnaire de documents, E2E).
- [x] BOM, encodage hérité, CRLF/LF/CR et EOL mixtes préservés : aller-retour octet pour octet sur 2 303 fichiers réels (`scripts/roundtrip-report.ts`).
- [x] Récupération après arrêt brutal, historique local, détection de modification externe (E2E : plantage simulé, conflit sans écrasement silencieux).
- [x] Journal de diagnostic local facultatif (CLAUDE.md §2.1 n° 16). Désactivé par défaut, il consigne les seuls événements autorisés et garde au plus une génération précédente de 512 Kio. Voir les tests Rust, `controller-log.test.ts` et DEC-037.

## Distribution
- [ ] Installateur Windows (MSI/NSIS) testé — non fait (`bundle.active` est `false`) ; l'outil de paquetage télécharge ses propres outils (WiX, NSIS) : accord du propriétaire requis — `BLOCKED_EXTERNAL`. En attendant : exécutable seul (`tauri build --no-bundle`).
- [x] Un AppImage Linux se construit (`pnpm build:linux`, DEC-048) : 89 569 784 octets, type 2, lancé 20 s sous WSLg. **Limites** : construit sous Ubuntu 26.04 donc `GLIBC_2.43` exigée ; ses bibliothèques LGPL embarquées (WebKitGTK, GTK, libsoup) sont à examiner avant distribution ; non reproductible octet pour octet ; mise à jour en place jamais essayée.
- [ ] Paquets `.deb`/`.rpm`, installateur Windows, et AppImage construit sur la plus ancienne distribution à supporter, testé sur une machine de bureau Linux — non fait ; `BLOCKED_EXTERNAL`.
- [ ] Signature de code Windows et Linux — `BLOCKED_EXTERNAL` (certificats du propriétaire).
- [x] Mécanisme de mise à jour signée depuis les releases d'un dépôt GitHub (DEC-046) : testé hors ligne (crate, interface, outillage) et sur l'exécutable réel contre un faux serveur GitHub local (E2E 9/9, dont une vraie installation avec redémarrage). Voir [`RELEASE.md`](RELEASE.md).
- [x] Même mécanisme **sous Linux** (DEC-047) : une release signée pour Windows et Linux, remplacement atomique d'un ELF en cours d'exécution, contrôle d'en-tête propre à chaque système, TLS d'OpenSSL — construit et testé sous Ubuntu 26.04 (183 tests Rust, mutations 12/12). **La mise à jour dans la fenêtre sous Linux n'a pas été déroulée.**
- [ ] Pour **chaque** release : construire sous Windows **et** sous Linux (sur la plus ancienne distribution à supporter), avec la clé de production et sans la fonctionnalité `e2e`, puis `release:prepare` avec un `--artifact <plateforme>=<fichier>` par système ; un système absent de la release recevra « la dernière release n'a pas de fichier pour cet ordinateur ».
- [x] **Clé de signature de production** créée le 2026-11-15 (`pnpm release:keygen`, clé privée hors du dépôt, mot de passe saisi par le propriétaire) et `update-public-key.txt` commité (PR #4) ; la première version distribuée l'embarque. La **sauvegarde de la clé privée et de son mot de passe en deux lieux sûrs** est une action du propriétaire, non vérifiable ici.
- [x] **Première release réelle** (0.1.0-beta.1, pre-release) publiée le 2026-11-15 avec `pnpm release:prepare` puis `pnpm release:publish` ; fichiers publics vérifiés (HTTP 200, SHA-256 de l'exécutable Windows identique à celui du manifeste signé). Voir `STATUS.md`, « Publication de 0.1.0-beta.1 ».
- [ ] **Mise à jour installée depuis une vraie release** (exige une seconde release) : TLS réel vers GitHub depuis l'application, redirections de téléchargement, antivirus — `BLOCKED_EXTERNAL`. Un dépôt privé et son jeton à granularité fine ne sont plus concernés : le dépôt est public.
- [x] Notes de version (texte brut dans le manifeste), canal stable/bêta, version minimale, procédure de récupération après mise à jour ratée : documentés dans [`RELEASE.md`](RELEASE.md) et le guide utilisateur (§ 12).

## Légal et commercial — [`LEGAL.md`](LEGAL.md)
- [x] Inventaire hors ligne des licences Windows : les 263 composants livrés correspondent au tableau [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md), aucun « à examiner » (`webpki-root-certs` n'est plus lié). Linux : 309 composants livrés dans [`THIRD_PARTY_LICENSES_LINUX.md`](THIRD_PARTY_LICENSES_LINUX.md) (mêmes cinq MPL-2.0) ; les bibliothèques système (GTK, WebKitGTK, glibc, OpenSSL) ne sont pas redistribuées.
- [x] Licence GPL-3.0-only et texte `LICENSE` présents ; la bibliothèque rAthena intégrée et sa provenance sont déclarées.
- [ ] Paquet de notices tiers (textes de licence) généré au packaging ; licence de la police `codicon.ttf` confirmée ; `ThirdPartyNotices.txt` de Monaco distribué.
- [ ] Revue juridique indépendante de la compatibilité des licences, marque « RuneForge » et obligations de distribution — `BLOCKED_EXTERNAL`.
- [ ] Licence : activation hors ligne raisonnable ; service distinct du moteur — compte marchand/serveur `BLOCKED_EXTERNAL`.
- [x] Mention « outil non officiel, sans lien avec Gravity » : écran d'accueil et « À propos ».

## Documentation
- [x] Guide utilisateur en français et en anglais ([`GUIDE_UTILISATEUR.md`](GUIDE_UTILISATEUR.md), [`USER_GUIDE.md`](USER_GUIDE.md)) ; limites de compatibilité publiées ([`COMPATIBILITY.md`](COMPATIBILITY.md), [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)).
- [x] `docs/STATUS.md`, `KNOWN_LIMITATIONS.md` et `CHANGELOG.md` à jour.
