# Guide de l'utilisateur — RuneForge Studio

> *English version: [`USER_GUIDE.md`](USER_GUIDE.md).* Ce guide décrit ce que l'application fait **réellement** aujourd'hui (Windows 11 ; pour Linux, voir le § 1). Ce qui n'existe pas encore est dit dans « Limites » ; le détail est dans
> [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md). RuneForge Studio est un outil **non officiel, sans lien avec Gravity**.

## 1. Installation

Aucun installateur n'existe encore : l'application se lance depuis l'exécutable produit par `pnpm --filter @runeforge/desktop tauri build --no-bundle` (dossier `target/release/`). Elle a besoin du runtime **WebView2** de Microsoft (fourni avec Windows 11).
**Linux** : l'exécutable `runeforge-studio` (sans extension) se construit et ses tests passent (Ubuntu 26.04), mais **la fenêtre n'a jamais été ouverte sous Linux** : son affichage, son clavier et sa saisie ne sont pas vérifiés. Il lui faut `libwebkit2gtk-4.1`, `libgtk-3` et `libssl3`, fournis par votre distribution ; un fichier téléchargé depuis GitHub n'est pas exécutable : `chmod +x runeforge-studio-<version>-linux-x86_64`. Voir [`DEV_SETUP.md`](DEV_SETUP.md). Les versions suivantes s'installent depuis l'application (**Aide › Mises à jour…**, voir § 12).

## 2. Premier lancement

L'écran d'accueil propose d'**ouvrir un dossier de projet** et liste les projets récents. Choisissez le dossier qui contient vos scripts — typiquement la racine de votre serveur rAthena, ou son dossier `npc/`. L'application **ne modifie rien à l'ouverture**.
La langue (français, anglais ou celle du système) et le thème (clair, sombre ou celui du système) se règlent dans **Paramètres** (Ctrl+,).

## 3. L'espace de travail

À gauche, l'**explorateur** (flèches pour parcourir, Entrée pour ouvrir) ; au centre, les **onglets** et l'éditeur ; en bas, les panneaux **Problèmes**, **Références** et **Rapport de projet** ; la **barre d'état** résume le serveur reconnu et l'état de l'indexation.

- **Enregistrer** : Ctrl+S (Ctrl+Maj+S pour tout). Un fichier ouvert puis enregistré **sans modification n'est pas réécrit** ; sinon seuls les octets modifiés changent. L'encodage hérité (par exemple windows-1252), le BOM et les fins de ligne (CRLF/LF, même mélangés) sont **préservés**.
  Un caractère impossible à représenter dans l'encodage du fichier **bloque** l'enregistrement au lieu d'être remplacé.
- **Fichier modifié ailleurs** : s'il n'a pas été modifié ici, il est rechargé au retour dans la fenêtre ; sinon l'application propose de **comparer, recharger ou écraser** — jamais d'écrasement silencieux.
- **Plantage** : vos modifications non enregistrées sont conservées dans des instantanés ; l'application les propose au redémarrage.

## 4. Votre serveur rAthena

L'application inclut une bibliothèque de scripting rAthena hors ligne pour la complétion des commandes, leur aide au survol et leurs signatures ; elle ne lit pas `doc/script_commands.txt` à l'exécution. Si le projet contient un serveur rAthena, l'application le **reconnaît** (barre d'état) et lit **dans vos fichiers** la table des commandes (`src/map/script.cpp`) et les définitions personnalisées (`src/custom/script_def.inc`) pour les vérifications propres au serveur, ainsi que le mode (renewal ou pre-renewal), les listes de scripts chargés (`npc/…/scripts_main.conf`), les cartes chargées
(`conf/map_athena.conf`) et les bases (objets, monstres, cartes, constantes, options aléatoires). Plusieurs serveurs dans le même projet ? Choisissez-le dans **Paramètres › Projet**. **Hercules n'est pas pris en charge** pour l'instant.

Paramètres › Projet : dossier du serveur, mode, **portée de l'index** (`sources` : les fichiers que désignent vos motifs ; `loaded` : seulement les scripts que le serveur charge), niveau d'alerte des commandes inconnues et des références introuvables, **commandes** et **constantes** personnalisées de votre fork.
Ces réglages sont enregistrés dans `.runeforge/project.json`, **seulement quand vous le demandez**.

## 5. Écrire un script

| Fonction | Raccourci |
|---|---|
| Compléter (commandes, labels, fonctions, NPC, variables, objets, monstres, cartes, constantes) | Ctrl+Espace |
| Aide de signature (paramètre en cours) | Ctrl+Maj+Espace |
| Survol : documentation, signature, source | souris |
| Aller à la définition | F12 (ou Ctrl+clic) |
| Toutes les références | Maj+F12 |
| Renommer (labels et variables locales, partout où c'est sûr) | F2 |
| Aller au symbole du projet (fonction, NPC) | Ctrl+T |
| Aller au fichier | Ctrl+P |
| Action rapide (ex. déclarer une commande de votre fork) | Ctrl+. |
| Rechercher dans les bases du serveur (objets, monstres, cartes, constantes) et insérer | Ctrl+Maj+D |
| Palette de commandes | Ctrl+Maj+P |

Dans un fichier vide, tapez **`npc-`** puis Entrée pour insérer un **modèle** de NPC (`npc-script`, `npc-warp`, `npc-shop`, `npc-healer`) ; Tab passe d'un champ à l'autre. Les modèles sont vérifiés contre le registre de votre serveur.

**Assistants de NPC** (menu **Fichier › Assistant de NPC…**, ou la palette de commandes) : un formulaire par type de NPC — **portail de téléportation**, **PNJ téléporteur**, **boutique**, **soigneur** (rAthena). Remplissez les champs : le **script est produit en direct**
à droite ; chaque champ dit ce qui ne va pas (nombre, nom de carte, sprite, liste d'objets…) et **aucun script n'est produit tant qu'il reste une erreur** ; un avertissement (prix à 0, prix démesuré, objet en double) n'empêche rien. Une **vérification locale** (la même analyse que
l'éditeur, sans rien indexer) annonce ensuite les problèmes du script produit. Trois sorties, toutes explicites :
- **Copier** le script dans le presse-papiers ;
- **Ajouter au fichier ouvert** : le script est ajouté **à la fin** du fichier affiché, annulable d'un Ctrl+Z ; il n'est écrit sur le disque que quand vous enregistrez (Ctrl+S) ;
- **Créer le fichier** : crée un nouveau fichier (le nom proposé est modifiable ; un fichier existant n'est jamais écrasé) qui contient le script, à enregistrer avec Ctrl+S.

Le serveur ne charge un fichier de script que si l'un de vos fichiers `scripts_*.conf` le cite — l'application ne les modifie jamais. Les textes proposés sont en anglais sans accent ; l'analyse locale n'est pas une exécution du serveur.

## 6. Comprendre les diagnostics

Les problèmes apparaissent dans l'éditeur (soulignements), dans le panneau **Problèmes** (Ctrl+J) et, pour tout le projet, dans le **Rapport de projet** (Ctrl+Maj+M : par fichier, les plus graves d'abord, ouverture au clic, copie en texte pour un ticket).
Chaque message dit **quoi, où, pourquoi et comment corriger**, et son niveau de confiance. **Une analyse locale n'est pas une exécution du serveur** : seul le serveur confirme.

| Code | Signifie |
|---|---|
| `RS…` | erreur de syntaxe (chaîne ou bloc non fermé, `;` attendu, en-tête incomplet, tabulations…) |
| `RA0001` | commande inconnue du serveur (ou fonction qu'aucun fichier ne définit) |
| `RA0006` | mauvais nombre d'arguments (d'après la table du serveur) |
| `RA0002` | `goto`/`callsub`/`menu` vers un label qui n'existe pas |
| `RA0003` | label ou fonction locale défini deux fois |
| `RA0012` | `function X;` jamais définie |
| `RA0004`, `RA0013` | `callfunc "X"` ou `duplicate(X)` sans cible (index complet seulement) |
| `RA0005`, `RA0011` | nom de NPC ou fonction globale en double |
| `RA0008`, `RA0009`, `RA0010` | carte, objet ou monstre introuvable dans les bases de votre serveur |
| `RA0015` | NPC sur une carte que le serveur **ne charge pas** : il l'ignore **sans aucun message** |
| `RA0014` | label qui porte le nom d'une commande, d'une constante ou d'un paramètre : le serveur le refuse |
| `RA0016` | fonction appelée **par son nom** avant que le serveur l'ait chargée : le script ne se charge pas (`callfunc "Nom"` n'est pas concerné) |

La liste complète et les preuves : [`LANGUAGE_SPEC.md`](LANGUAGE_SPEC.md). Les alertes sur les commandes inconnues se règlent (ou se coupent) dans Paramètres › Projet.

## 7. Raccourcis

Ctrl+O ouvrir un dossier · Ctrl+N nouveau fichier · Ctrl+S / Ctrl+Maj+S enregistrer · Ctrl+W fermer l'onglet · Ctrl+PageSuivante / PagePrécédente changer d'onglet · Ctrl+B barre latérale · Ctrl+J panneau du bas · Ctrl+, paramètres · F12 · Maj+F12 · F2 · Ctrl+T · Ctrl+P ·
Ctrl+Maj+P · Ctrl+Maj+D · Ctrl+Maj+M · Ctrl+Espace · Ctrl+Maj+Espace · Ctrl+.

## 8. Confidentialité et sécurité

Par défaut, l'application ne fait aucune requête réseau et n'envoie pas de télémétrie. La recherche de mises à jour ne contacte GitHub que lorsque vous appuyez sur « Rechercher des mises à jour » (§ 12). La proposition IA transmet le NPC affiché et le prompt; le générateur transmet le prompt sans NPC existant. Les deux exigent un consentement explicite et une destination hors boucle locale exige une confirmation distincte. Une clé API saisie est envoyée comme jeton Bearer, mais n'est jamais enregistrée; l'URL et le modèle sont conservés dans Paramètres › Modèle IA. HTTP n'est accepté que pour la boucle locale ou une adresse IPv4 privée et n'est pas chiffré : utilisez-le seulement sur un réseau de confiance. L'application lit les scripts sans les exécuter et limite ses opérations de fichiers aux dossiers approuvés. Voir [`SECURITY.md`](SECURITY.md).
Les instantanés de récupération contiennent votre code source et restent sur votre machine.
Le **journal de diagnostic local** est **désactivé par défaut** (Paramètres › Confidentialité). Activé, il consigne seulement des événements — ouverture du projet, fin d'indexation avec des compteurs, échec ou conflit d'enregistrement, erreur non gérée de l'interface — dans
`logs\runeforge.log`, sous le dossier de données locales de l'application (`%LOCALAPPDATA%\dev.runeforge.studio`), sur 512 Kio au plus plus une génération précédente : **jamais de code, de chemin ni de message d'erreur**. Il ne quitte jamais votre machine ; décochez la case pour l'arrêter.

## 9. Assistants, dialogues, Git et déploiement local

- **Fichier › Assistant de NPC…** propose quatre formulaires rAthena (portail, téléporteur, boutique, soigneur). Vérifiez l'aperçu, puis copiez le script, ajoutez-le au fichier ouvert ou créez un fichier. Enregistrez avec Ctrl+S.
- **Fichier › Éditeur visuel de dialogues…** ouvre le NPC sous le curseur. Les instructions non prises en charge restent verrouillées. Relisez la comparaison, appliquez les changements au document et enregistrez avec Ctrl+S.
- **Fichier › Créer un NPC avec l’éditeur visuel…** est un éditeur de nœuds. Glissez une commande de la bibliothèque rAthena (hors ligne) sur le canevas, ou activez-la pour l’insérer après le nœud sélectionné, puis glissez d’une **prise de sortie** (bord droit d’un nœud) vers la **prise d’entrée** (bord gauche) d’un autre nœud pour les relier : le script suit les fils, pas la position des nœuds. Une condition a deux sorties, **Alors** et **Sinon**, et une entrée accepte plusieurs fils : des branches peuvent donc se rejoindre. Sans souris, activez une prise de sortie puis une prise d’entrée ; Suppr sur une sortie la débranche, de même que le bouton × d’un fil ; Échap annule une connexion en cours. Chaque chemin doit finir par `close` ou `end` : un nœud ou une sortie non reliés sont signalés et bloquent la création, et un fil qui ferait revenir le flux sur lui-même est refusé. Les arguments et l’aide hors ligne se trouvent dans chaque nœud ; seules les commandes dont la signature est connue sont disponibles. Le script complet est analysé localement avant la création d’un nouveau fichier non enregistré. Voir [DEC-042](DECISIONS.md).
- **Fichier › Générer un NPC à partir d’un prompt…** crée un NPC sans script de départ. Configurez l’URL de base compatible OpenAI (par exemple `http://127.0.0.1:8000/v1`) et le modèle sous Paramètres › Modèle IA. Examinez le script et les diagnostics locaux avant d’approuver la création d’un fichier de projet non enregistré. Le prompt, l’URL et le modèle sont affichés avant l’envoi; une destination hors boucle locale exige une confirmation distincte. Les clés API restent volatiles et ne sont pas enregistrées.
- **Fichier › Simuler le dialogue…** joue le NPC sous le curseur dans un aperçu local. Il exécute les variables de toute portée (une variable jamais écrite vaut 0, comme sur le serveur), les constantes, les tableaux, `switch`, les boucles, `callsub` et `callfunc` (vers les fonctions du même fichier et vers celles des autres fichiers du projet que l’index connaît), les commandes de quêtes et d’inventaire, `input` et `close2`. Les instructions qui exigent le serveur de jeu (`warp`, `cutin`, `specialeffect`…) sont listées comme *Non simulé* et ignorées ; les valeurs que le serveur calculerait sont *supposées* (0 sauf si vous les fixez sous *Résultats supposés des fonctions*) et signalées : une partie menée à son terme ne prouve donc pas que le NPC fonctionne sur le serveur. La simulation ne s’arrête jamais sur une erreur : une opération que le serveur refuserait (division par zéro, argument absent, label inexistant…) apparaît comme une ligne *Opération invalide* qui en donne la raison, et le dialogue continue avec une valeur par défaut ; un NPC qui a des erreurs de syntaxe est joué quand même, et ce qui n’a pas pu être lu est listé comme *Non simulé*. Seule une limite (boucle sans fin, texte démesuré) interrompt une partie, par un message d’état qui cite l’instruction atteinte. Choisissez la **classe du personnage de test par son nom** (les noms que le serveur donne lui-même, comme *Knight*, *High Priest* ou *Rune Knight*, en anglais dans les deux langues ; le script lit le numéro de classe correspondant dans `Class`), son niveau et ses Zeny. Sous *Variables, inventaire, quêtes et hypothèses*, fixez les variables, objets et quêtes du personnage de test ; la graine du hasard rend une partie reproductible. Rien n’est envoyé à un serveur et aucun fichier ni état de jeu n’est modifié.
- **Fichier › Simuler le dialogue…** offre aussi une proposition IA facultative pour le NPC affiché. Le NPC et l’instruction sont validés et présentés avant la création d’un fichier séparé non enregistré; le document ouvert n’est jamais remplacé.
- **Affichage › Afficher les modifications Git** liste les changements et permet de comparer un fichier avec `HEAD`. Activez Git uniquement pour un projet de confiance. L'application lance le client Git installé pour les lectures.
- **Fichier › Déployer vers un dossier…** prépare un plan à partir des scripts enregistrés. Vérifiez le plan avant de confirmer la copie. Vous pouvez ensuite restaurer les fichiers remplacés du dernier déploiement si leur contenu correspond encore à la version déployée.

## 10. Limites

L'adaptateur Hercules, l'édition directe du graphe général, l'intégration de fournisseurs IA réels et SSH/SFTP restent incomplets. La simulation et l'IA sont des prévisualisations limitées et ne remplacent pas un essai sur serveur. L'application fonctionne comme exécutable seul sous Windows. L'installateur reste à faire, tout comme l'ouverture de la fenêtre sous Linux (l'exécutable s'y construit et ses tests passent, mais il n'y a jamais été lancé) ; la mise à jour depuis une release GitHub (§ 12) existe sous Windows et sous Linux, ne se lance jamais seule, et n'a pas encore été essayée avec le vrai GitHub. Le rapport de projet est un instantané des fichiers indexés. La matrice de compatibilité décrit la couverture des diagnostics rAthena Renewal. Voir [`COMPATIBILITY.md`](COMPATIBILITY.md).

## 11. En cas de problème

- *Aucune commande n'est proposée* : le serveur n'est pas reconnu — regardez la barre d'état et Paramètres › Projet.
- *Trop d'alertes `RA0001`* : votre fork a des commandes que le serveur local ne connaît pas — déclarez-les (Ctrl+. sur l'alerte) ou réglez le niveau d'alerte.
- *Un fichier ne s'affiche pas bien* : vérifiez l'encodage dans la barre d'état (les encodages hérités sont préservés).
- Rapportez un problème avec le **rapport de projet copié en texte** (il ne contient jamais le contenu de vos scripts).

## 12. Mettre à jour l'application

**Aide › Mises à jour…** (ou Paramètres › Mises à jour) cherche une version plus récente dans les **releases d'un dépôt GitHub**. **Rien n'est contacté avant que vous appuyiez sur « Rechercher des mises à jour »** : l'application ne vérifie rien au démarrage et ne se met jamais à jour seule.

1. **Dépôt** : `propriétaire/nom` du dépôt qui publie les versions (par défaut celui de l'éditeur). Seul GitHub est contacté.
2. **Canal** : « Versions stables seulement » (par défaut) ou « Versions stables et bêta ».
3. **Jeton d'accès**, seulement si le dépôt est **privé** : créez sur GitHub (Settings › Developer settings › Fine-grained tokens) un jeton limité à **ce dépôt**, avec la permission **Contents : Read-only** et une date d'expiration, puis collez-le dans le champ. Il reste en mémoire jusqu'à la fermeture de l'application, n'est jamais enregistré et n'est envoyé qu'à GitHub. Un tel jeton permet aussi de lire le code du dépôt : ne le créez pas plus large que nécessaire.
4. **Rechercher des mises à jour**. Si une version plus récente est publiée, l'application affiche sa version, sa date, sa taille et ses notes (du texte brut).
5. **Installer et redémarrer** : enregistrez d'abord vos modifications (l'application redémarre ; le bouton le dit). Une boîte de dialogue du système vous demande de confirmer, puis l'application télécharge l'exécutable (avec une barre de progression), vérifie son empreinte, se remplace elle-même et redémarre.

Chaque version publiée est **signée par l'éditeur** et l'application n'installe que ce que cette signature garantit : si GitHub ou le réseau envoyait autre chose, elle le refuse (« la signature n'est pas valide ») sans rien télécharger. Un échec laisse l'ancienne version en place. Sous Windows, si le message dit que l'ancienne version n'a pas pu être remise en place, renommez `runeforge-studio.exe.old` (à côté de l'application) en `runeforge-studio.exe` ; sous Linux, l'ancienne version reste à côté sous le nom `runeforge-studio.old` jusqu'au lancement suivant, de quoi revenir en arrière à la main (`mv runeforge-studio.old runeforge-studio`). L'installation automatique existe sous **Windows et Linux** (sous Linux, elle n'a pas été essayée dans la fenêtre) et exige un dossier d'application où vous pouvez écrire : un exécutable installé par un paquet dans `/usr/bin` ne se met pas à jour seul. Sur un autre système, le bouton explique qu'elle n'est pas disponible. Une version qui ne contient pas la clé de signature de l'éditeur (« cette version ne peut pas vérifier les mises à jour ») doit être remplacée à la main une fois.

Dernière validation des preuves : 2026-11-10 · commit ebf2bf0+local-changes.
