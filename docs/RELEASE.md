# Livraison et mises à jour signées

> Comment publier une version de RuneForge Studio que les utilisateurs installent **depuis l'application** (Paramètres › Mises à jour), à partir des **releases d'un dépôt GitHub**, privé ou non. Décision : [DEC-046](DECISIONS.md). Menaces et garde-fous : [`SECURITY.md`](SECURITY.md) (« Mises à jour signées »).
> État : l'outillage et l'application sont testés hors ligne (voir [`STATUS.md`](STATUS.md)). **La clé de signature de production existe et une première release, 0.1.0-beta.1, est publiée depuis le 2026-11-15** (pre-release, canal bêta ; Windows et Linux). **Aucune mise à jour n'a encore été installée depuis une vraie release** : le comportement de l'application face au vrai GitHub (TLS, redirections de téléchargement) reste à vérifier avec une seconde release : voir « Premier contrôle réel ».

## Le principe en dix lignes

1. L'éditeur signe, avec une **clé privée qu'il garde**, un **manifeste** (`update-manifest.json`) qui décrit la version, son canal, l'exécutable (nom, taille, empreinte SHA-256) et des notes en texte brut.
2. L'application embarque la **clé publique** (`apps/desktop/src-tauri/update-public-key.txt`, ajoutée à la construction). Elle ne fait confiance qu'à elle.
3. Une release GitHub porte **un exécutable par système** — `runeforge-studio-<version>-windows-x86_64.exe`, `runeforge-studio-<version>-linux-x86_64` — plus `update-manifest.json` et `update-manifest.json.sig` : **un seul manifeste signé les décrit tous**.
4. Le menu **Aide › Mises à jour…** ouvre l'onglet ; **rien n'est contacté avant l'appui sur « Rechercher des mises à jour »**.
5. Le cœur natif (Rust) lit la liste des releases, télécharge le manifeste et sa signature, **vérifie la signature**, puis compare : version plus récente, canal, plateforme, version minimale.
6. GitHub, le réseau et le compte du dépôt ne sont que des **transports non fiables** : s'ils sont compromis, ils peuvent empêcher une mise à jour, jamais en imposer une (la signature manquerait).
7. L'installation demande l'accord de l'utilisateur dans une **boîte de dialogue du système**, télécharge l'exécutable **de son système** (taille et SHA-256 du manifeste signé, en-tête `MZ` pour Windows, `ELF` pour Linux), puis **remplace l'exécutable en cours d'exécution** et redémarre : par renommages sous Windows (qui autorise à renommer un exécutable qui tourne), par **un renommage atomique** sous Linux (le processus garde l'ancien fichier ; les droits d'exécution de l'ancienne version passent au nouveau, GitHub n'en conserve aucun). En cas d'échec, l'ancienne version est remise en place.
8. Elle est **refusée tant que des modifications ne sont pas enregistrées**.
9. **Windows et Linux** (x86_64 ; une architecture que la release ne porte pas, par exemple `linux-aarch64`, est signalée comme « pas de fichier pour cet ordinateur »). Il n'y a ni installateur ni paquet : l'application est l'exécutable seul (`tauri build --no-bundle`).
10. Le jeton d'accès d'un dépôt privé reste **en mémoire** : jamais enregistré, jamais dans les réglages, le journal ou la page.

## 1. Une fois : créer la clé de signature (action du propriétaire)

```bash
pnpm release:keygen --out C:\chemin\hors\du\depot\runeforge-update.key
```

`tauri signer generate` demande le mot de passe dans le terminal. Le script écrit la clé privée **hors du dépôt** (il refuse sinon), puis copie la clé publique dans `apps/desktop/src-tauri/update-public-key.txt`. Il ne remplace jamais une clé publique déjà configurée.

- **Sauvegardez la clé privée ET son mot de passe** en deux lieux sûrs. Sans eux, plus aucune mise à jour ne peut être signée ; avec eux, n'importe qui peut publier une mise à jour acceptée par toutes les installations.
- Commitez `update-public-key.txt` (la clé publique n'est pas un secret). Ne commitez jamais la clé privée (`*.key` est ignoré par Git, sauf les clés de **test** des fixtures).
- **La première version distribuée doit déjà contenir la clé publique** : une version construite avant cette étape contient le texte `UNCONFIGURED` et refuse toute mise à jour (`not_configured`). Ces exemplaires-là devront être réinstallés à la main une fois.
- Les clés de test (`crates/updater/tests/fixtures/keys/`, mot de passe `test-only`) sont **publiques dans le dépôt** : ne signez jamais une release avec. `release:prepare` refuse une release dont l'exécutable les embarque, et un test Rust échoue si la clé de production est celle de test.

## 2. Donner l'accès aux utilisateurs d'un dépôt privé

Un dépôt privé n'est visible que d'un compte autorisé. Chaque utilisateur crée un **jeton GitHub à granularité fine** (GitHub › Settings › Developer settings › Fine-grained tokens) :

- *Repository access* : **ce dépôt seulement** ; *Permissions* › *Contents* : **Read-only** (c'est la seule nécessaire) ; une date d'expiration.
- Il le colle dans Paramètres › Mises à jour › « Jeton d'accès ». Il reste en mémoire jusqu'à la fermeture et n'est envoyé qu'à `api.github.com`.

**Mise en garde (à décider)** : un jeton qui lit les releases d'un dépôt privé lit aussi **son code source**. Si les utilisateurs ne doivent pas voir le code, publiez les releases dans un **dépôt distinct réservé aux versions** (public, ou privé avec le même jeton réduit à celui-là), et renseignez ce dépôt dans l'onglet (ou changez `DEFAULT_UPDATE_REPOSITORY` dans `packages/project-core/src/settings.ts`). Un dépôt public n'exige aucun jeton (limite de 60 requêtes par heure sans jeton).

## 3. Publier une version

```bash
# 1. Changer la version (une seule source : apps/desktop/src-tauri/tauri.conf.json), tenir CHANGELOG.md à jour
# 2. Vérifier
pnpm check:all
pnpm e2e                         # Windows seulement (WebView2)
# 3. Construire l'exécutable de production (sans la fonctionnalité e2e) de CHAQUE système
pnpm --filter @runeforge/desktop tauri build --no-bundle      # Windows : target\release\runeforge-studio.exe
#    Linux (depuis Windows, via WSL) : pnpm build:linux  ->  target\release\runeforge-studio-linux-x86_64 (voir « Construire pour Linux » plus bas)
# 4. Écrire les notes de version en texte brut (8 Kio au plus) dans notes.txt, puis préparer la release avec chaque exécutable
set TAURI_SIGNING_PRIVATE_KEY_PATH=C:\chemin\hors\du\depot\runeforge-update.key
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...        # jamais en argument de commande
pnpm release:prepare --version 0.2.0 --notes notes.txt ^
    --artifact windows-x86_64=target\release\runeforge-studio.exe ^
    --artifact linux-x86_64=target\release\runeforge-studio-linux-x86_64
# 5. Aperçu (rien n'est envoyé), puis création du BROUILLON avec la session `gh` du propriétaire
pnpm release:publish --repo proprietaire/depot --dir release-out/0.2.0
pnpm release:publish --repo proprietaire/depot --dir release-out/0.2.0 --yes
```

Sans `--artifact`, `release:prepare` prend l'exécutable de la machine courante (`target\release\runeforge-studio.exe` sous Windows, `target/release/runeforge-studio` sous Linux). **Une release est un seul manifeste signé** : tous les systèmes qu'elle sert se préparent ensemble (le binaire Linux, construit sur une machine Linux, se donne par son chemin, y compris `\\wsl$\…` depuis Windows). Un système absent de la release n'a simplement pas de mise à jour (« la dernière release n'a pas de fichier pour cet ordinateur »).

Puis, dans GitHub : relire le brouillon et **le publier** (c'est seulement alors que l'application le propose ; un brouillon est invisible pour elle).

`release:prepare` refuse, avec la raison et la plateforme concernée (`[linux-x86_64] …`) :

| Contrôle | Pourquoi |
|---|---|
| la version de `tauri.conf.json` n'est pas celle de la release | sinon l'application mise à jour se proposerait la même mise à jour sans fin |
| l'exécutable est plus ancien que `tauri.conf.json`, ne contient pas la version | reconstruire après le changement de version |
| l'exécutable n'est pas de son système : en-tête `MZ` attendu pour `windows-*`, `ELF` pour `linux-*` | un exécutable Windows donné comme Linux (ou l'inverse) serait signé, haché, téléchargé… puis ne démarrerait jamais ; l'application le refuse aussi (`not_executable`) |
| une plateforme inconnue (`macos-…`), en double, ou aucun exécutable | seuls Windows et Linux savent s'installer |
| l'exécutable n'embarque pas la clé publique de production, ou embarque une clé de test (construction `e2e`) | une release signée ne serait pas vérifiable, ou serait signable par n'importe qui |
| la signature ne se vérifie pas avec la clé publique de l'application | mauvaise clé privée ; vérifié par une seconde implémentation (Ed25519 et BLAKE2b de Node) |
| un pré-numéro de version (`1.0.0-beta.1`) sur le canal stable | le canal stable n'offre jamais de pré-version |
| le dossier de sortie n'est pas vide | pas de mélange de deux releases |

`release:publish` revérifie le dossier (taille, SHA-256, signature) avant de rien envoyer, et marque une release du canal bêta comme *pre-release* (l'application exige que l'indicateur de GitHub et le canal du manifeste soient d'accord : sinon `bad_manifest`).

### Construire pour Linux

Le binaire Linux se construit **sur une machine Linux** (Ubuntu 22.04 ou plus récent ; WSL convient). Construisez-le sur la **plus ancienne distribution que vous voulez supporter** : il est lié dynamiquement à la glibc, à OpenSSL (`libssl.so.3`) et à WebKitGTK 4.1 (`libwebkit2gtk-4.1.so.0`), donc il ne démarre pas sur une distribution plus ancienne que celle où il a été construit.

```bash
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev patchelf curl wget file
# Node 22, pnpm 10.33 et Rust (rustup) : voir DEV_SETUP.md
pnpm install --frozen-lockfile
pnpm --filter @runeforge/desktop tauri build --no-bundle      # -> target/release/runeforge-studio (un ELF, sans extension)
```

**Depuis Windows : `pnpm build:linux`** (DEC-048). Le script copie les sources dans WSL (`~/runeforge-npc-editor`, sans `node_modules`, `target`, `.git`, `release-out` ni les clés `*.key` de la racine), lance `pnpm install --frozen-lockfile`, `tauri build --no-bundle` puis `tauri build --bundles appimage`, vérifie les en-têtes et dépose dans `target\release`, à côté du `.exe` :

| Fichier | Contenu |
|---|---|
| `runeforge-studio-linux-x86_64` | L'ELF brut. **Sans extension : c'est normal sous Linux.** C'est celui que prend `release:prepare`. |
| `runeforge-studio-linux-x86_64.AppImage` | Un AppImage de type 2 (WebKitGTK, GTK et leurs dépendances embarqués, environ 85 Mio). |

Les tailles et SHA-256 sont recalculés côté Windows. Les sorties d'une exécution remplacent celles d'avant (aucun fichier périmé). Options : `--distro <nom>` (ou `RUNEFORGE_WSL_DISTRO`), `--no-appimage` (ELF seul, aucun téléchargement), `--allow-download`. Prérequis dans WSL : Node 22, pnpm, Rust, `rsync` et les paquets ci-dessus.

**Téléchargements d'outils (AppImage).** Le bundler Tauri **télécharge puis exécute** trois outils, mis en cache dans `~/.cache/tauri` de WSL : `AppRun-x86_64` et `linuxdeploy-<version>-x86_64.AppImage` (`github.com/tauri-apps/binary-releases`), `linuxdeploy-plugin-appimage.AppImage` (`github.com/linuxdeploy/linuxdeploy-plugin-appimage`, version « continuous », **non épinglée**). Sans ce cache, `pnpm build:linux` **s'arrête avant de construire** (code 6) tant que vous n'avez pas ajouté `--allow-download`. Observé le 2026-11-15 : 31 552 + 19 810 808 + 16 488 952 octets.

Comme pour Windows, il doit être construit **après** la configuration de la clé publique et le changement de version, et **sans** la fonctionnalité `e2e` ; `release:prepare` le contrôle (clé publique embarquée, aucune clé de test, version, en-tête ELF). Donnez-le par `--artifact linux-x86_64=<chemin>` (`target\release\runeforge-studio-linux-x86_64` si construit par `pnpm build:linux`).

- **Premier lancement sous Linux** : l'utilisateur télécharge `runeforge-studio-<version>-linux-x86_64` depuis la release (GitHub ne conserve pas le bit d'exécution), fait `chmod +x`, puis le lance ; les versions suivantes s'installent depuis l'application (le nouveau fichier reprend les droits de l'ancien). Dépendances à l'exécution : `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libssl3`.
- **AppImage — ce qui est vérifié** (2026-11-15) : fichier de type 2 (`AI\x02`), 89 569 784 octets, 355 fichiers extraits (272 Mo) dont WebKitGTK 4.1 et GTK 3 ; **lancé 20 secondes sous WSLg** (démarre, reste en vie, deux avertissements `libEGL`). **Ce qui ne l'est pas** : l'interface, la mise à jour d'un AppImage en place (`$APPIMAGE`, le chemin que Tauri relance : prévue par DEC-047, jamais essayée avec un vrai AppImage), toute autre distribution.
- **AppImage — compatibilité** : il n'embarque **pas** la glibc. Construit sous Ubuntu 26.04, le binaire principal exige `GLIBC_2.39` mais les bibliothèques embarquées exigent jusqu'à **`GLIBC_2.43`** : il ne démarrera que sur une distribution de cette génération ou plus récente. Pour une portée plus large, construisez-le sur la plus ancienne distribution à supporter (voir plus haut) ; **l'ELF brut** exige `GLIBC_2.39` mais utilise le WebKitGTK de la distribution. Sur la machine de l'utilisateur, un AppImage se monte avec `libfuse2` (absent par défaut sur Ubuntu 22.04 et plus récent : `libfuse2t64`) ; sinon `APPIMAGE_EXTRACT_AND_RUN=1` ou `--appimage-extract-and-run`. Le bit d'exécution se perd en passant par Windows : `chmod +x`.
- **AppImage — licences** : il redistribue des bibliothèques de la distribution (dossiers `usr/share/doc/<paquet>/` inclus), notamment WebKitGTK et GTK. **102 paquets** y embarquent leur fichier `copyright` ; ceux de WebKitGTK, JavaScriptCore, GTK et libsoup y déclarent des licences LGPL-2 / LGPL-2.1+ (lu dans ces fichiers, 2026-11-15 ; aucune analyse juridique) ; **l'inventaire `THIRD_PARTY_LICENSES_LINUX.md` ne les couvre pas** (il décrit l'ELF brut, lié dynamiquement). Revue des obligations (notices, accès aux sources) à faire avant toute distribution : `BLOCKED_EXTERNAL` (`LEGAL.md`).
- **AppImage — reproductibilité** : l'ELF brut est identique d'une construction à l'autre (même SHA-256) ; **l'AppImage ne l'est pas** (deux constructions successives : SHA-256 différents).
- **Autres paquets** : aucun `.deb`, `.rpm` ni installateur Windows n'est produit ni testé (CLAUDE.md §5.1). Un exécutable installé par un paquet dans `/usr/bin` n'est pas modifiable par l'utilisateur (`not_writable`) : non essayé.
- **Autres architectures** : un manifeste peut porter `linux-aarch64` ; aucun binaire ARM n'est construit ni testé ici. Un ordinateur dont la plateforme n'est pas dans la release reçoit « la dernière release n'a pas de fichier pour cet ordinateur ».

### Canaux

- **Stable** : une version sans pré-numéro (`1.2.0`), publiée comme release ordinaire. C'est le canal par défaut.
- **Bêta** : `1.3.0-beta.1`, publiée comme *pre-release*. Un utilisateur du canal « Versions stables et bêta » reçoit la plus récente des deux ; un utilisateur stable ne reçoit jamais de bêta.
- **Versions minimales** (`--minimum 0.4.0`) : une version plus ancienne ne reçoit pas cette release ; elle est invitée à installer d'abord la version minimale à la main (à utiliser quand le remplacement exige une étape préalable).
- Jamais de retour en arrière : seule une version **strictement plus récente** est proposée.

## 4. Premier contrôle réel (avant de compter dessus)

Ce que les tests hors ligne ne peuvent pas prouver : le TLS réel vers `api.github.com` (schannel), les redirections de téléchargement d'un dépôt privé, les limites de l'API, le comportement d'un antivirus. **Fait le 2026-11-15** : la première release (0.1.0-beta.1) est publiée dans le vrai dépôt, ses fichiers se téléchargent sans authentification et l'exécutable téléchargé a le SHA-256 du manifeste signé (`STATUS.md`, « Publication de 0.1.0-beta.1 »). **Reste à faire** : publier une seconde release (version supérieure) puis, depuis un exemplaire de la première, vérifier de bout en bout : Rechercher → proposée → Installer → redémarrage sur la nouvelle version. C'est le premier essai réel du TLS de l'application vers `api.github.com` ; à noter dans `STATUS.md`. Rappel : une bêta ne reçoit la bêta suivante qu'avec le canal « Versions stables et bêta ».

## 5. Si une mise à jour échoue

Tout est refusé avant d'écrire quoi que ce soit si la signature, la taille ou l'empreinte ne correspondent pas : l'exécutable en place n'est pas touché. Le remplacement lui-même se fait par renommages dans le dossier de l'application :

| Fichier à côté de l'exécutable | Sens | Action |
|---|---|---|
| `runeforge-studio.exe.download` | téléchargement interrompu | supprimé automatiquement au démarrage suivant |
| `runeforge-studio.exe.new` | version prête à être mise en place | idem |
| `runeforge-studio.exe.old` | l'ancienne version, après une mise à jour réussie | supprimée au démarrage suivant (ou à celui d'après si l'ancien processus ne s'est pas encore arrêté) |

Si le remplacement échoue, l'ancienne version reprend sa place. Dans le cas extrême où ce retour échoue aussi, l'application l'annonce (« conservée à côté de l'application avec l'extension « .old » ») : **renommez `runeforge-studio.exe.old` en `runeforge-studio.exe`**.
Le dossier de l'application doit être modifiable par l'utilisateur (sinon `not_writable`) : un exécutable placé dans `C:\Program Files` sans droits d'écriture ne peut pas se mettre à jour lui-même.

**Sous Linux**, le remplacement est un **seul renommage atomique** : l'exécutable en place n'est ni déplacé ni modifié avant lui, donc il n'y a pas de `.new` et le chemin ne manque jamais. Les droits de l'ancienne version (dont le bit d'exécution) passent au nouveau fichier. L'ancienne version reste à côté sous `runeforge-studio.old` (un lien dur, ou une copie si le système de fichiers n'en admet pas) et n'est supprimée **qu'au démarrage d'une version qui a réussi à démarrer** : une nouvelle version qui ne démarre pas (bibliothèque système absente, par exemple) laisse donc l'ancienne à portée. Pour revenir en arrière à la main : `mv runeforge-studio.old runeforge-studio`. Un exécutable installé par un gestionnaire de paquets (`/usr/bin`) n'est pas modifiable par l'utilisateur : `not_writable`, la mise à jour se fait alors avec le gestionnaire de paquets.

## 6. Changer ou perdre la clé

Chaque exemplaire installé ne fait confiance qu'à **sa** clé publique. Changer de clé ou perdre la clé privée coupe donc la mise à jour de tous les exemplaires déjà distribués : ils doivent être **réinstallés à la main** avec une version construite avec la nouvelle clé. Pour remplacer volontairement une clé : videz `update-public-key.txt`, relancez `pnpm release:keygen`, reconstruisez, et prévenez les utilisateurs par un autre canal. En cas de **fuite de la clé privée**, faites-le sans attendre et considérez les anciennes releases comme non fiables.

## Limites (voir aussi `KNOWN_LIMITATIONS.md`)

- **Windows 11 et Linux, x86_64.** Linux a été vérifié par les tests automatisés (le crate de mise à jour, l'outillage, tous les tests du dépôt) sur Ubuntu 26.04 sous WSL2, avec le vrai remplacement d'un ELF en cours d'exécution ; **aucun essai de l'application graphique sous Linux** (pas d'E2E, pas de redémarrage Tauri observé) et aucune autre distribution ni architecture.
- Pas de signature de code Windows (certificat du propriétaire, `BLOCKED_EXTERNAL`) : Windows SmartScreen peut avertir au premier lancement d'un exécutable téléchargé à la main.
- Les mises à jour ne sont jamais automatiques : l'utilisateur lance chaque contrôle.
- Chaque ordinateur lit l'entrée de **sa** plateforme dans le manifeste (`windows-x86_64`, `linux-x86_64`, `linux-aarch64`…) ; macOS n'est pas pris en charge.
