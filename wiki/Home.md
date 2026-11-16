# RuneForge Studio — Wiki

**EN** — A desktop IDE for writing and checking **rAthena** NPC scripts (Ragnarok Online server emulator). It opens your server folder, understands its scripts, and tells you what the server would complain about — without ever running the server, and without touching your files unless you save.

**FR** — Un IDE de bureau pour écrire et vérifier les scripts de NPC **rAthena** (émulateur de serveur Ragnarok Online). Il ouvre le dossier de votre serveur, comprend ses scripts et signale ce que le serveur refuserait — sans jamais lancer le serveur, et sans toucher à vos fichiers tant que vous n'enregistrez pas.

> *Unofficial tool, not affiliated with Gravity. / Outil non officiel, sans lien avec Gravity.*
> *"RuneForge Studio" is a working name. / « RuneForge Studio » est un nom de travail.*

---

## Choose your language / Choisissez votre langue

| | English | Français |
|---|---|---|
| **Start here** | [Getting started](EN-Getting-Started) | [Premiers pas](FR-Premiers-Pas) |
| **Using the app** | [Editor and safe saving](EN-Editor-and-Safe-Saving) · [Language features](EN-Language-Features) · [Diagnostics](EN-Diagnostics) · [Server integration](EN-Server-Integration) · [NPC tools](EN-NPC-Tools) · [Git and deployment](EN-Git-and-Deployment) · [Updates](EN-Updates) | [Éditeur et enregistrement sûr](FR-Editeur-et-Enregistrement-Sur) · [Fonctions du langage](FR-Fonctions-du-Langage) · [Diagnostics](FR-Diagnostics) · [Intégration du serveur](FR-Integration-Serveur) · [Outils NPC](FR-Outils-NPC) · [Git et déploiement](FR-Git-et-Deploiement) · [Mises à jour](FR-Mises-a-jour) |
| **Trust** | [Privacy and security](EN-Privacy-and-Security) · [Compatibility and limitations](EN-Compatibility-and-Limitations) | [Confidentialité et sécurité](FR-Confidentialite-et-Securite) · [Compatibilité et limites](FR-Compatibilite-et-Limites) |
| **Help** | [Troubleshooting and FAQ](EN-Troubleshooting-and-FAQ) | [Dépannage et FAQ](FR-Depannage-et-FAQ) |
| **Contributing** | [Development](EN-Development) · [Architecture](EN-Architecture) · [Roadmap](EN-Roadmap) · [License](EN-License) | [Développement](FR-Developpement) · [Architecture](FR-Architecture) · [Feuille de route](FR-Feuille-de-route) · [Licence](FR-Licence) |

## At a glance / En un coup d'œil

| | |
|---|---|
| Platforms / Plateformes | Windows 11 (fully verified) · Linux x86_64 (builds and tests pass; window barely tested) |
| Emulators / Émulateurs | rAthena (Renewal verified) · Hercules not supported yet / pas encore pris en charge |
| Stack | Tauri 2 · React · TypeScript · Rust · Monaco |
| Interface | English / Français · light / dark / system |
| License / Licence | GPL-3.0-only |
| Status / État | Pre-release 0.1.0-beta.1, see [Releases](https://github.com/vazan/runeforge-npc-editor/releases) / Pré-version 0.1.0-beta.1, voir les [Releases](https://github.com/vazan/runeforge-npc-editor/releases) |

## Where the source of truth lives / Où se trouve la référence

This wiki is a readable summary. The detailed, evidence-backed project documents (in French) live in the repository's [`docs/`](https://github.com/vazan/runeforge-npc-editor/tree/HEAD/docs) folder: `STATUS.md`, `KNOWN_LIMITATIONS.md`, `DECISIONS.md`, `SECURITY.md`, `TEST_MATRIX.md`. When the wiki and `docs/` disagree, `docs/` wins — and please [open an issue](https://github.com/vazan/runeforge-npc-editor/issues/new/choose).

Ce wiki est un résumé lisible. Les documents détaillés et prouvés du projet (en français) sont dans le dossier [`docs/`](https://github.com/vazan/runeforge-npc-editor/tree/HEAD/docs) du dépôt : `STATUS.md`, `KNOWN_LIMITATIONS.md`, `DECISIONS.md`, `SECURITY.md`, `TEST_MATRIX.md`. En cas de désaccord entre le wiki et `docs/`, c'est `docs/` qui fait foi — et merci d'[ouvrir un ticket](https://github.com/vazan/runeforge-npc-editor/issues/new/choose).
