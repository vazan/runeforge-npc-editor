# Premiers pas

*🇬🇧 [English version](EN-Getting-Started)*

RuneForge Studio est une **pré-version** (version 0.1.0-beta.1). Une première [pré-version est publiée sur la page des Releases](https://github.com/vazan/runeforge-npc-editor/releases) pour Windows et Linux ; il n'y a pas d'installateur, et vous pouvez aussi le construire vous-même depuis les sources.

## 1. Prérequis

| | Windows | Linux |
|---|---|---|
| Niveau de vérification | **Complet** : l'application réelle est pilotée par un parcours automatisé de bout en bout sous Windows 11 | **Se construit et les tests passent** sous Ubuntu 26.04 (WSL2, x86_64). La fenêtre n'a été lancée que 20 secondes ; aucun test d'interface |
| Environnement d'exécution | **WebView2** de Microsoft (fourni avec Windows 11) | `libwebkit2gtk-4.1`, `libgtk-3`, `libssl3`, fournis par votre distribution |
| Git (facultatif) | Seulement pour le panneau Git | Seulement pour le panneau Git |
| macOS | Non pris en charge | — |

Un AppImage peut être construit pour Linux (`pnpm build:linux`), mais il exige une glibc aussi récente que celle de la machine de construction et n'a été lancé que 20 secondes. Voir [Compatibilité et limites](FR-Compatibilite-et-Limites).

## 2. Obtenir l'application

**Le plus simple : télécharger une pré-version.** Sur la [page des Releases](https://github.com/vazan/runeforge-npc-editor/releases), prenez le fichier de votre système : `runeforge-studio-<version>-windows-x86_64.exe`, ou `runeforge-studio-<version>-linux-x86_64` (il exige une glibc 2.39 ou plus récente ; faites d'abord `chmod +x`). Il n'y a pas d'installateur : lancez-le simplement. L'exécutable Windows n'est pas signé, donc SmartScreen peut avertir au premier lancement.

**Ou construisez-la depuis les sources** — la procédure complète est dans [Développement](FR-Developpement). En bref :

```bash
pnpm install
pnpm --filter @runeforge/desktop tauri build --no-bundle
```

L'exécutable apparaît dans `target/release/` (`runeforge-studio.exe` sous Windows, `runeforge-studio` sous Linux). Sous Linux, rendez-le d'abord exécutable : `chmod +x runeforge-studio`.

Pour l'essayer sans construire d'exécutable de production : `pnpm --filter @runeforge/desktop tauri dev`.

## 3. Premier lancement

1. L'écran d'accueil propose **Ouvrir un dossier de projet…** et liste les projets récents.
2. Choisissez le dossier qui contient vos scripts — typiquement la **racine de votre serveur rAthena**, ou son dossier `npc/`.
3. RuneForge **ne modifie rien à l'ouverture d'un projet**. Il lit les fichiers, construit un index en arrière-plan, et la barre d'état affiche le serveur reconnu et l'avancement de l'indexation.
4. Réglez la langue (français, anglais ou celle du système) et le thème (clair, sombre ou celui du système) dans **Paramètres** (`Ctrl+,`).

## 4. Vos cinq premières minutes

| Faites ceci | Pour voir cela |
|---|---|
| Ouvrez un script depuis l'explorateur (ou `Ctrl+P`) | La coloration syntaxique et les problèmes soulignés |
| Appuyez sur `Ctrl+J` | Le panneau **Problèmes** : quoi, où, pourquoi, comment corriger |
| Appuyez sur `Ctrl+Maj+M` | Le **Rapport de projet** : les problèmes de tous les fichiers indexés |
| Placez le curseur sur un `callfunc "F_Nom"` et appuyez sur `F12` | Un saut vers la définition de la fonction |
| Dans un fichier vide, tapez `npc-` puis Entrée | Un modèle de NPC (`npc-script`, `npc-warp`, `npc-shop`, `npc-healer`) |
| **Fichier › Assistant de NPC…** | Un formulaire qui produit en direct un script de portail, de téléporteur, de boutique ou de soigneur |
| `Ctrl+Maj+D` | Recherche dans les objets, monstres, cartes et constantes du serveur, puis insertion |

Rien n'est écrit sur le disque tant que vous n'appuyez pas sur `Ctrl+S`.

## Pour continuer

- [Éditeur et enregistrement sûr](FR-Editeur-et-Enregistrement-Sur) — ce que « vos fichiers sont en sécurité » veut vraiment dire.
- [Intégration du serveur](FR-Integration-Serveur) — rendre les vérifications propres à *votre* serveur.
- [Fonctions du langage](FR-Fonctions-du-Langage) — complétion, survol, renommage, raccourcis.
- Un comportement étrange ? [Dépannage et FAQ](FR-Depannage-et-FAQ).
