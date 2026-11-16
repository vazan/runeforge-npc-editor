# Git et déploiement

*🇬🇧 [English version](EN-Git-and-Deployment)*

Deux fonctions facultatives relient votre projet à l'extérieur : un **panneau Git en lecture seule**, et le **déploiement** des scripts enregistrés vers un dossier (avec une comparaison SFTP en lecture seule).

## Panneau Git (lecture seule)

**Affichage › Afficher les modifications Git** liste les changements de l'arbre de travail et de l'index et permet de **comparer un fichier avec `HEAD`**. La barre d'état affiche la branche.

- RuneForge lance votre programme **`git`** installé, et seulement quand vous ouvrez l'onglet Git ou comparez un fichier.
- **Vous devez activer Git pour chaque projet** (boîte de confirmation, refusée par défaut). Pourquoi : un dépôt reçu d'un tiers peut déclarer dans son `.git/config` des programmes que `git status` exécuterait. RuneForge impose `core.fsmonitor=false`, vide l'environnement transmis à Git (18 variables autorisées), utilise `--no-optional-locks` pour que rien ne soit écrit dans le dépôt, et ne lance que `rev-parse`, `status` et `cat-file`. **N'activez Git que pour des projets de confiance** : un dépôt qui déclare un programme de *filtre* pourrait quand même le faire exécuter par `git status`.
- Il ne lance jamais de commande d'écriture (ni commit, ni checkout) ni de commande réseau.
- Limites : 5 000 fichiers listés, délai de 15 secondes par appel, sous-modules ignorés.

## Déployer vers un dossier

**Fichier › Déployer vers un dossier…** copie les scripts **enregistrés** vers une destination de votre choix.

1. RuneForge établit un **plan** (ce qui sera créé ou remplacé). Relisez-le — rien n'est encore copié. 2 000 fichiers au plus par plan.
2. Confirmez. Une **sauvegarde** de chaque fichier à remplacer est faite d'abord, et la copie est vérifiée.
3. Ensuite, vous pouvez **restaurer** les fichiers remplacés par le dernier déploiement — mais seulement s'ils correspondent encore à la version déployée ; un fichier modifié depuis est refusé.

Les fichiers nouvellement créés sont conservés à la restauration. Vous gérez toujours vous-même vos listes `scripts_*.conf` et le rechargement sur votre serveur : RuneForge ne les modifie jamais et ne redémarre jamais un serveur.

## Aperçu SFTP (comparaison en lecture seule)

**Fichier › Aperçu SFTP…** compare les scripts enregistrés avec un dossier distant. **Il ne transfère rien, ne sauvegarde rien, ne recharge rien et ne lance aucune commande distante.**

- Vous indiquez l'hôte, le port, l'utilisateur, la **clé publique d'hôte épinglée (`ssh-ed25519`)**, un dossier distant absolu, et de 1 à 100 chemins `.txt` relatifs au projet (4 Mio au plus par fichier et 16 Mio au total).
- Un **dialogue natif demande votre accord pour la destination exacte** avant la connexion ; un fichier de configuration ne peut pas l'accorder.
- L'authentification se fait par **clé publique via votre agent SSH** uniquement — pas de mot de passe. Il utilise le **client OpenSSH `ssh` déjà installé** (sous Windows `System32\OpenSSH\ssh.exe`, sous Linux `/usr/bin/ssh`), avec la clé d'hôte vérifiée strictement contre celle que vous avez épinglée.
- Chaque fichier est rapporté **Identique**, **Différent** ou **Absent à distance**, avec les octets locaux et distants.

> État : le client du protocole est couvert par des tests unitaires. Les documents de preuve du projet ne consignent pas d'essai contre un vrai serveur distant, et décrivent encore le transport distant comme « à implémenter » — considérez cet aperçu comme **précoce**. Obtenez la clé d'hôte par un canal fiable.

## Ce qui n'existe pas

- Pas encore de transfert SSH/SFTP (seulement la comparaison).
- Pas d'opération d'écriture Git, ni de chargement automatique des scripts déployés sur un serveur.
- Lancer les scripts contre un serveur rAthena de test réellement isolé figure dans la [feuille de route](FR-Feuille-de-route), pas disponible.
