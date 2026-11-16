# Développement

*🇬🇧 [English version](EN-Development)*

Comment construire, tester et contribuer. Les notes d'installation de référence, toujours à jour, sont dans [`docs/DEV_SETUP.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/DEV_SETUP.md) ; cette page en est le guide pas à pas.

## Prérequis

| Outil | Version testée | Remarques |
|---|---|---|
| Node.js | 22.15 (≥ 22 exigé) | |
| pnpm | 10.33 | `corepack enable`, puis `corepack prepare pnpm@10.33.0 --activate` |
| Rust | 1.93 stable | via [rustup](https://rustup.rs) |
| Windows | Visual Studio Build Tools (« Développement Desktop en C++ ») et WebView2 | Testé sous Windows 11 |
| Linux (Ubuntu) | [Prérequis](https://v2.tauri.app/start/prerequisites/) de Tauri | Construit et testé sous Ubuntu 26.04 (WSL2) |

Ni NASM ni CMake ne sont nécessaires.

**Paquets Linux (Ubuntu) :**

```bash
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev \
  librsvg2-dev libayatana-appindicator3-dev libxdo-dev patchelf curl wget file
```

Sous **WSL**, copiez les sources sur le disque de Linux (`~/…`), jamais sur `/mnt/c`, et ne partagez jamais `node_modules` ni `target/` entre Windows et Linux.

## Commandes courantes

```bash
pnpm install                                         # installe et lie le workspace
pnpm check                                           # typecheck + ESLint + Vitest
pnpm rust:check                                      # clippy -D warnings + cargo test (workspace)
pnpm check:all                                       # les deux précédents
pnpm build                                           # construit le frontend
pnpm --filter @runeforge/desktop tauri dev           # lance en développement (Vite + fenêtre native)
pnpm --filter @runeforge/desktop tauri build --no-bundle   # exécutable dans target/release/
pnpm build:linux                                     # depuis Windows : construit l'ELF Linux + un AppImage dans WSL
pnpm e2e                                             # Windows seulement : parcours de bout en bout sur l'exécutable réel
```

> ⚠️ **N'exécutez jamais `npm install`** dans ce dépôt — le gestionnaire est pnpm. Un `npm install` accidentel ajoute un paquet sans rapport et un `package-lock.json`, ce qui casse `pnpm install --frozen-lockfile` et le CI.
>
> Après avoir **déplacé ou renommé le dossier du projet**, d'anciens chemins absolus subsistent dans `target/` et dans le cache de Vite : lancez `cargo clean -p runeforge-filesystem -p runeforge-updater -p runeforge-studio -p runeforge-remote-transport -p runeforge-git` et supprimez `apps/desktop/node_modules/.vite`.

Aucun installateur ni `.deb`/`.rpm` n'est produit. `pnpm build:linux` dépose l'ELF brut et un AppImage dans `target/release/` ; le bundler d'AppImage télécharge et exécute trois outils au premier usage, donc le script s'arrête tant que vous n'avez pas passé `--allow-download` (`--no-appimage` ne construit que l'ELF). Détails : [`docs/RELEASE.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/RELEASE.md).

## Tests et mesures

| Niveau | Comment |
|---|---|
| Tests unitaires et de propriétés TypeScript | `pnpm test` (Vitest) ; les fixtures sont rédigées pour ce projet |
| Tests de composants | Vitest + Testing Library (jsdom) |
| Rust | `cargo test --workspace` |
| De bout en bout (Windows) | `pnpm e2e` construit une variante `e2e` et pilote l'exécutable réel par le protocole de débogage de WebView2 ; captures et latence de complétion vont dans `target/e2e-artifacts`. `pnpm e2e --skip-build` rejoue sans reconstruire. Les étapes pilotées à la souris ou par la liste de complétion dépendent du timing : rejouez l'étape fautive seule (`E2E_ONLY="<fragment du nom>"`) sur une machine au repos avant de soupçonner une régression |
| Audit d'accessibilité | `pnpm exec tsx scripts/e2e/accessibility.ts <exe-e2e> [dossier-de-captures]` |
| Mesures sur un vrai serveur | `scripts/*-report.ts` (analyseur, analyse, aller-retour, registre, commandes, catalogue, références, rapport de projet, cartes, labels, ordre de chargement, assistants, visuel, simulation). Ils **lisent** un dossier de serveur et n'y écrivent jamais |

La fonctionnalité Cargo `e2e` expose un crochet de test et une clé de mise à jour de *test* embarquée. **Elle ne doit jamais figurer dans une construction distribuée** (`release:prepare` refuse un tel exécutable).

## Conventions

- TypeScript `strict` avec `noUncheckedIndexedAccess` ; pas de `any` sans justification.
- Les paquets internes sont consommés **en TypeScript source** (sans étape de construction) — DEC-003.
- **Fondé sur des preuves** : une fonction ou une règle n'est « vérifiée » qu'avec une commande exécutée et son résultat, consignés dans `docs/STATUS.md`. N'affirmez pas plus que ce qui a été mesuré.
- **La sécurité d'abord** : aucun chemin de code ne doit écrire un fichier de l'utilisateur sans action explicite ; n'élargissez pas les permissions IPC sans déclarer la commande (un test Rust le vérifie).
- **Diffs minimaux.** Consignez les choix non évidents dans une entrée numérotée de `docs/DECISIONS.md`.
- Mettez à jour `CHANGELOG.md` et la page de `docs/` concernée avec le changement.

## Où sont les choses

Voir [Architecture](FR-Architecture) pour l'organisation et le graphe de dépendances.

## Contribuer

La version courte est dans [`CONTRIBUTING.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/CONTRIBUTING.md) ; la liste de contrôle d'une pull request est dans le modèle de pull request du dépôt.

1. Regardez les tickets ouverts et la [feuille de route](FR-Feuille-de-route). Pour tout changement important, ouvrez d'abord un ticket afin de convenir de l'approche.
2. Créez une branche depuis `master` et gardez le changement ciblé.
3. Lancez `pnpm check:all` (et `pnpm e2e` sous Windows si vous touchez au comportement de l'interface). Ajoutez ou mettez à jour des tests — pour une règle de diagnostic, incluez un test qui échouerait si la règle était retirée.
4. Ouvrez une pull request qui décrit le **quoi et le pourquoi** et les **preuves** (commandes exécutées).

Pour les tickets : [Dépannage et FAQ](FR-Depannage-et-FAQ#signaler-un-bogue). Pour les failles de sécurité : [Confidentialité et sécurité](FR-Confidentialite-et-Securite#signaler-une-vulnérabilité).

## Modifier ce wiki

Les sources du wiki vivent dans le **dossier `wiki/` du dépôt principal**, pour être relues comme du code. Un wiki GitHub est un dépôt Git distinct (`<dépôt>.wiki.git`) qui existe une fois le wiki activé et sa première page créée dans l'interface web. Pour publier :

```bash
git clone https://github.com/vazan/runeforge-npc-editor.wiki.git ../runeforge-npc-editor.wiki
cp wiki/*.md ../runeforge-npc-editor.wiki/
cd ../runeforge-npc-editor.wiki && git add -A && git commit -m "Sync wiki from main repository" && git push
```

Conventions : chaque page existe en anglais (`EN-…`) et en français (`FR-…`) et renvoie à sa jumelle dès la première ligne ; les liens internes omettent l'extension `.md` (style des wikis GitHub) ; les captures vivent dans `docs/images/` et sont référencées par `…/blob/HEAD/docs/images/<nom>.png?raw=true`. Quand vous changez une langue, changez l'autre.

Les captures proviennent des artefacts du scénario de bout en bout (un petit projet synthétique) ; régénérez-les avec `pnpm e2e`.
