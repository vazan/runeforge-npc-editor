# Licences et conformité

> **Inventaire technique, pas un avis juridique.** CLAUDE.md §15.3 exige une revue par un professionnel compétent avant toute vente : elle n'a pas eu lieu (**`BLOCKED_EXTERNAL`**). Ce document dit ce que l'on sait,
> ce que l'on a vérifié, et les questions à poser. État au **2026-11-15**, cibles **Windows** et **Linux** (x86_64 ; l'inventaire Linux est au point 5 des « Points à traiter »).

## Licence du produit

RuneForge Studio est déclaré sous **GPL-3.0-only** dans `LICENSE`, les manifestes pnpm et Cargo. Ce choix est une hypothèse d'implémentation pour permettre l'inclusion de la bibliothèque rAthena ; il ne constitue pas un avis juridique ni une certification de compatibilité. La revue juridique avant distribution reste **`BLOCKED_EXTERNAL`**.

## Dépendances

`pnpm exec tsx scripts/licenses-report.ts` (hors ligne : `pnpm licenses list` lit `node_modules`, `cargo metadata --offline` lit `Cargo.lock` et le cache local) classe chaque composant d'après son expression SPDX (`OR` : on choisit,
`AND` : tout s'applique). Résultat du 2026-11-15 (après l'ajout des mises à jour signées, DEC-046 et DEC-047 : +13 composants Rust livrés) :

| Écosystème · usage | Composants | Permissives | Copyleft faible | Copyleft fort | À examiner |
|---|---|---|---|---|---|
| TypeScript · **livré** (frontend) | 11 | 11 | 0 | 0 | 0 |
| TypeScript · construction et tests (jamais livré) | 210 | 208 | 2 | 0 | 0 |
| Rust · **livré** (cible Windows) | 252 | 247 | 5 | 0 | 0 |
| Rust · construction (jamais livré) | 17 | 17 | 0 | 0 | 0 |

L'inventaire automatisé des dépendances ne trouve aucun composant GPL/AGPL/LGPL ni licence inconnue. Il ne couvre pas les fichiers du produit : la bibliothèque de commandes rAthena est un contenu GPL-3.0-only livré séparément et documenté ci-dessous. Licences des dépendances livrées, par fréquence : `MIT OR Apache-2.0` (129), `MIT` (49), `Apache-2.0 OR MIT` (30), `Unicode-3.0` (18), `Unlicense OR MIT` (9),
`MPL-2.0` (5), BSD-3-Clause, Zlib et combinaisons permissives. La liste complète (nom, version, licence) est dans [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md), regénérable avec `--markdown`.

### Points à traiter avant la distribution

1. **MPL-2.0 (copyleft faible, au niveau du fichier)** — cinq caisses Rust liées à l'exécutable, via la pile de Tauri : `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors`. Elles sont utilisées **sans modification** : la MPL
   impose de conserver leurs avis, de fournir leur texte de licence et d'indiquer où obtenir leur code source (dépôts publics) ; elle n'impose rien au code du produit qui les appelle. Les deux composants `lightningcss`
   (MPL-2.0) sont des outils de construction du frontend, non livrés.
2. **Notices de tiers** — MIT, BSD, Apache-2.0 et Unicode exigent de reproduire leur avis et leur texte dans la distribution. Le paquet de notices complet (textes de licence de chacun des 263 composants livrés pour Windows) n'existe pas encore : il sera produit
   au packaging. Monaco fournit son propre `ThirdPartyNotices.txt` (code et spécifications tiers qu'il embarque, dont du matériel sous Creative Commons Attribution 4.0 et Apache-2.0) : **à distribuer avec l'application**.
3. **Police des icônes de Monaco (`codicon.ttf`)**, livrée dans le frontend : elle provient du projet « vscode-codicons », dont la police est publiée, à notre connaissance, sous CC-BY-4.0 (attribution exigée) — **à confirmer dans le paquet amont avant la
   distribution** (le paquet `monaco-editor` 0.57.0 est sous licence MIT ; la mention de la police n'a pas été retrouvée dans ses fichiers de licence).
4. **WebView2** : Windows 11 fournit le runtime Microsoft Edge WebView2 (licence Microsoft, non redistribuée par ce produit). Un installateur pour des systèmes qui ne l'ont pas devra le prévoir (prérequis à valider ; téléchargement : `BLOCKED_EXTERNAL`).
5. **Linux** (inventaire du 2026-11-15, Ubuntu 26.04 sous WSL2, `scripts/licenses-report.ts --target x86_64-unknown-linux-gnu`, tableau dans [`THIRD_PARTY_LICENSES_LINUX.md`](THIRD_PARTY_LICENSES_LINUX.md)) : **298 caisses Rust livrées** (293 permissives, les **mêmes cinq MPL-2.0** que sous Windows, aucune GPL/AGPL/LGPL, aucune à examiner) et les 11 paquets du frontend. La pile GTK 3 / WebKitGTK 4.1 / glibc / **OpenSSL 3** est liée **dynamiquement** et fournie par la distribution de l'utilisateur : elle n'est pas distribuée avec l'application, donc ni ses licences (LGPL, Apache-2.0…) ni ses notices ne sont dans le paquet ; la revue juridique doit confirmer que **ne pas redistribuer** ces bibliothèques suffit, et dire ce que la documentation d'installation doit mentionner (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libssl3`). Les autres distributions, les architectures ARM et un éventuel AppImage (qui, lui, embarquerait des bibliothèques) ne sont pas inventoriés.

## rAthena et Hercules (GPL)

- La bibliothèque intégrée contient les signatures et le texte d'aide de `script_commands.txt`, attribué à rAthena Dev Team ; elle est générée depuis le checkout local `Serveur/rathena-kov` et distribuée sous GPL-3.0-only avec `LICENSE` et des références de provenance. La révision du checkout est inconnue.
- La table des valeurs de constantes de script (`packages/emulator-rathena/src/script-constants-values.ts` : 10 233 noms avec leur valeur numérique) est générée par `packages/emulator-rathena/lib/generate-script-constants.ts` depuis `src/map/script_constants.hpp` et les énumérations de `src/**/*.hpp` du même checkout. Elle ne contient aucune ligne de code serveur, mais des noms et des nombres issus de code GPL-3.0-only : elle est distribuée sous GPL-3.0-only avec `LICENSE` (DEC-043). La révision du checkout est inconnue.
- La liste des noms de classe (`packages/emulator-rathena/src/job-classes-values.ts` : 153 classes, identifiant et nom) est écrite par le même générateur depuis `job_name()` de `src/map/pc.cpp` et `conf/msg_conf/map_msg.conf` du même checkout, qui donnent à chaque identifiant de classe le nom que la commande `jobname()` renvoie (« Knight », « Rune Knight T »…). Ce sont des noms et des nombres issus de code et de données GPL-3.0-only, sans ligne de code serveur : le fichier est distribué sous GPL-3.0-only avec `LICENSE` (DEC-045). La fenêtre de simulation les montre tels quels, en anglais, y compris dans l'interface française.
- Aucun code serveur ni base de données rAthena n'est intégré. L'application lit les sources du serveur de l'utilisateur à l'exécution pour la validation spécifique au serveur ; le manuel n'est ni lu ni transmis à l'exécution.
- Les **fixtures de test** restent rédigées pour ce projet (texte original, même disposition de fichiers que l'émulateur) ; les mesures sur corpus réel (`scripts/*-report.ts`) lisent le serveur local en lecture seule et n'en copient rien dans le dépôt du produit.
- **Questions pour le conseil juridique** : confirmer que la licence et les avis accompagnant le texte embarqué répondent aux obligations de distribution, et évaluer les notations d'arguments extraites de la table du serveur. L'inclusion sous GPL n'est pas une certification juridique.
- Hercules n'est pas utilisé (`BLOCKED_EXTERNAL`) : ses licences seront à examiner si un adaptateur est écrit.

## Contenus du jeu et marque

- **Aucune ressource de Ragnarok Online** (sprites, cartes, musiques, noms de marque dans l'interface) n'est incluse. L'icône actuelle est un placeholder original (DEC-007).
- « Ragnarok Online » et « Gravity » sont des marques de leurs titulaires. La mention **« Outil non officiel, sans lien avec Gravity »** est affichée sur l'écran d'accueil et dans « À propos » (`app.unofficial`) ; à reprendre dans la documentation de distribution et la page de vente.
- **« RuneForge Studio » est un nom de travail** : recherche d'antériorité et de disponibilité de marque à faire avant le lancement (`BLOCKED_EXTERNAL`).

## Vie privée

L'application ne collecte rien et ne stocke ailleurs que **localement** : aucune télémétrie ; le réseau n'est utilisé que sur une **action explicite** de l'utilisateur (voir [`SECURITY.md`](SECURITY.md)). La recherche de mises à jour contacte `api.github.com` (et les hôtes de téléchargement de GitHub) : GitHub voit alors l'adresse IP de l'utilisateur, le nom du dépôt consulté et, pour un dépôt privé, le jeton qu'il a saisi (qui n'est jamais enregistré par l'application). Les instantanés de récupération et l'historique local contiennent du code source de l'utilisateur
et restent sur sa machine. Le **journal de diagnostic local** est facultatif (désactivé par défaut, case à cocher dans Paramètres › Confidentialité) et ne contient que des événements techniques (codes et compteurs : jamais de source, de chemin ni de message d'erreur) ; il reste dans le dossier
de données locales de l'application et n'est jamais envoyé (DEC-037). Une politique de confidentialité devra décrire ces fonctions en ligne (mises à jour depuis GitHub, IA, et plus tard la licence) — chacune exige une action explicite de l'utilisateur.

## Avant de vendre

- [ ] Revue juridique des licences et avis (bibliothèque rAthena GPL-3.0-only, MPL-2.0, autres notices) — `BLOCKED_EXTERNAL`.
- [ ] Paquet de notices tiers complet, généré au packaging, avec les textes de licence.
- [ ] Confirmer la licence de la police `codicon.ttf` ; distribuer `ThirdPartyNotices.txt` de Monaco.
- [ ] EULA, politique de confidentialité, reprise de la mention de non-affiliation dans la distribution, vérification de marque.
- [ ] Revue de l'inventaire Linux (bibliothèques système non redistribuées **pour l'ELF brut ; l'AppImage de `pnpm build:linux` (DEC-048) les redistribue** : 102 paquets de la distribution avec leur `copyright`, dont WebKitGTK, JavaScriptCore, GTK et libsoup en LGPL-2 / LGPL-2.1+ — notices, accès aux sources et licences des 102 paquets à examiner, inventaire non fait) ; `cargo audit` / `pnpm audit` (exige le réseau, voir `SECURITY.md`).

## Rejouer l'inventaire

```bash
pnpm exec tsx scripts/licenses-report.ts              # résumé et composants à examiner
pnpm exec tsx scripts/licenses-report.ts --markdown   # tableau des composants livrés (docs/THIRD_PARTY_LICENSES.md)
pnpm exec tsx scripts/licenses-report.ts --json       # données brutes
# Même inventaire pour l'exécutable Linux (docs/THIRD_PARTY_LICENSES_LINUX.md) ; la cible par défaut est x86_64-pc-windows-msvc
pnpm exec tsx scripts/licenses-report.ts --target x86_64-unknown-linux-gnu --markdown
```
