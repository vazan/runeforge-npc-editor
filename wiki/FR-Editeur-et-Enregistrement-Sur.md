# Éditeur et enregistrement sûr

*🇬🇧 [English version](EN-Editor-and-Safe-Saving)*

Le texte de vos scripts est traité comme sacré. Cette page décrit l'espace de travail et les garanties qui entourent vos fichiers. Chaque garantie ci-dessous s'appuie sur un test ou une mesure consignés dans le dépôt (voir [`docs/STATUS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/STATUS.md)).

## L'espace de travail

![L'éditeur avec ses diagnostics, l'explorateur et le panneau Problèmes](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/images/editor-diagnostics.png?raw=true)

| Zone | Rôle |
|---|---|
| **Explorateur** (à gauche) | Arbre du projet. Flèches pour parcourir, Entrée pour ouvrir. Champ de filtre en haut. Création de fichiers vides ; ni renommage, ni déplacement, ni suppression (choix volontaire) |
| **Onglets + éditeur** (au centre) | L'éditeur Monaco (le moteur de VS Code) avec la coloration RuneScript |
| **Panneau du bas** | **Problèmes**, **Références**, **Rapport de projet**, **Git** |
| **Barre d'état** | Serveur et mode reconnus, nombre de commandes connues, avancement de l'indexation, nombre d'erreurs et d'avertissements, curseur, encodage, fin de ligne, état enregistré |

Menus : **Fichier**, **Affichage**, **Aller à**, **Aide**. Tout est aussi accessible depuis la **palette de commandes** (`Ctrl+Maj+P`).

## Ce qui se passe à l'enregistrement

| Situation | Comportement |
|---|---|
| Ouvrir un fichier et l'enregistrer **sans modification** | **Rien n'est écrit** |
| Enregistrer après modification | **Seuls les octets modifiés** diffèrent de l'original |
| Le fichier utilise un encodage hérité (par ex. windows-1252, Shift_JIS), a un BOM, ou des fins de ligne CRLF, LF ou **mélangées** | Tout est **préservé** |
| Vous saisissez un caractère que l'encodage du fichier ne peut pas représenter | L'enregistrement est **bloqué** ; le caractère n'est jamais remplacé en silence |
| Le fichier a été modifié par un autre programme | Si vous ne l'avez pas modifié ici, il se recharge à votre retour dans la fenêtre. Sinon, on vous propose de **comparer, recharger ou écraser** — jamais d'écrasement silencieux |
| L'application ou la machine plante | Les modifications non enregistrées sont conservées sous forme d'**instantanés de récupération** et proposées au redémarrage suivant |

Comment c'est vérifié : ouvrir puis réenregistrer **2 303 scripts réels** a restitué chaque fichier octet pour octet, dont 58 fichiers en encodage hérité et 4 à fins de ligne mélangées.

En coulisses, les écritures sont atomiques (fichier temporaire, puis remplacement) et conditionnelles : RuneForge refuse d'écraser un fichier dont l'empreinte a changé depuis sa lecture.

## Historique local et comparaison

- **Comparer avec la version enregistrée** montre vos modifications non enregistrées face au disque.
- **Afficher l'historique local** liste d'anciens instantanés locaux dans la vue de comparaison (on ne peut pas encore les restaurer d'un clic).
- Si le projet est un dépôt Git, voir [Git et déploiement](FR-Git-et-Deploiement).

## Réglages qui touchent l'édition

Ouvrez-les avec `Ctrl+,`. Onglets : **Général**, **Éditeur** (taille de police, retour à la ligne, affichage des espaces, largeur de tabulation), **Projet** (voir [Intégration du serveur](FR-Integration-Serveur)), **Modèle IA**, **Confidentialité**, **Mises à jour**, **À propos**.

Un projet peut porter sa propre configuration dans `.runeforge/project.json`. RuneForge n'écrit ce fichier **que sur votre demande** (par exemple en choisissant « Créer la configuration » ou une action rapide).

## Raccourcis clavier

| Raccourci | Action |
|---|---|
| `Ctrl+O` | Ouvrir un dossier |
| `Ctrl+N` | Nouveau fichier |
| `Ctrl+S` / `Ctrl+Maj+S` | Enregistrer / tout enregistrer |
| `Ctrl+W` | Fermer l'onglet |
| `Ctrl+PageSuivante` / `Ctrl+PagePrécédente` | Onglet suivant / précédent |
| `Ctrl+B` | Afficher/masquer la barre latérale |
| `Ctrl+J` | Afficher/masquer le panneau du bas |
| `Ctrl+,` | Paramètres |
| `Ctrl+P` | Aller au fichier |
| `Ctrl+Maj+P` | Palette de commandes |

Les raccourcis du langage (complétion, définition, renommage…) sont sur [Fonctions du langage](FR-Fonctions-du-Langage).

## Limites connues

Un seul groupe d'éditeurs ; pas de réorganisation des onglets par glisser-déposer ; l'encodage ne se change pas encore depuis la barre d'état (seulement par le dialogue « caractères non enregistrables ») ; pas de surveillance continue du disque (l'index se resynchronise quand la fenêtre reprend le focus, au plus toutes les 15 secondes). Liste complète : [`docs/KNOWN_LIMITATIONS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/KNOWN_LIMITATIONS.md).
