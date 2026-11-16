# Fonctions du langage

*🇬🇧 [English version](EN-Language-Features)*

RuneForge comprend le **langage de script rAthena** (scripts de NPC, fonctions, warps, boutiques, monstres, mapflags). Cette page liste ce que l'éditeur offre pendant la frappe.

> L'analyseur est *tolérant* et *sans perte* : tout texte — même cassé — produit un arbre et des diagnostics, jamais une exception, et le texte d'origine n'est jamais régénéré depuis l'arbre. Il a été exécuté sur ~2 300 scripts réels : 0 plantage, 0 caractère perdu.

## Raccourcis

| Fonction | Raccourci |
|---|---|
| Compléter (commandes, labels, fonctions, NPC, variables, objets, monstres, cartes, constantes) | `Ctrl+Espace` |
| Aide de signature (met en évidence le paramètre en cours) | `Ctrl+Maj+Espace` |
| Survol : documentation, signature, origine | souris |
| Aller à la définition | `F12` ou `Ctrl+clic` |
| Toutes les références | `Maj+F12` |
| Renommer (labels et variables locales, seulement là où c'est sûr) | `F2` |
| Aller à un symbole du projet (fonction globale, NPC) | `Ctrl+T` |
| Plan du document | `Ctrl+Maj+O` |
| Aller au fichier | `Ctrl+P` |
| Action rapide (par ex. déclarer une commande de votre fork) | `Ctrl+.` |
| Rechercher dans les bases du serveur et insérer | `Ctrl+Maj+D` |
| Panneau Problèmes | `Ctrl+J` |
| Rapport de projet | `Ctrl+Maj+M` |
| Palette de commandes | `Ctrl+Maj+P` |

## Ce qui est proposé et documenté

| Nature | Faut-il un serveur rAthena reconnu ? |
|---|---|
| Labels, fonctions locales et globales, noms de NPC, variables de votre projet | Non |
| **Commandes** avec signature, nombre d'arguments et extrait du manuel | Non pour la bibliothèque hors ligne intégrée ; oui pour les vérifications propres au serveur |
| **Objets, monstres, cartes, constantes** de votre serveur | Oui (lus dans vos fichiers) |
| **Modèles** de NPC | rAthena seulement |

- **Bibliothèque de commandes hors ligne** : 667 commandes rAthena, avec signatures et texte d'aide, sont intégrées ; la complétion et le survol fonctionnent donc même sans dossier de serveur. Le texte d'aide provient de `script_commands.txt` de rAthena (GPL-3.0).
- À une position d'argument qui attend un objet ou un monstre, la complétion écrit l'**identifiant** ; dans la palette des bases, `Maj+Entrée` insère à la place le **nom entre guillemets**.
- Les listes de complétion sont plafonnées (par exemple 200 références) et s'affinent à mesure que vous tapez.

## Renommer (`F2`)

Le renommage ne change que ce qu'il peut prouver sûr : **labels**, **fonctions locales** et **variables locales** (`.@x`, `.x`) d'un script, avec toutes les occurrences connues avec certitude. Il refuse — en expliquant pourquoi — pour les fonctions globales et noms de NPC (d'autres fichiers peuvent les référencer, parfois par chaîne), les variables globales, les labels d'événement `On…`, les scripts dont l'analyse est incomplète et les noms invalides ou déjà pris. Vérifié sur 841 scripts réels : 1 002 renommages appliqués, **0 nouveau diagnostic**.

## Modèles de NPC

Dans un fichier vide (ou en début de ligne, hors d'un script), tapez `npc-` puis Entrée :

| Modèle | Produit |
|---|---|
| `npc-script` | Un NPC avec un court dialogue |
| `npc-warp` | Un portail de téléportation |
| `npc-shop` | Une boutique de deux objets |
| `npc-healer` | Un soigneur avec un menu |

`Tab` passe d'un champ à l'autre. Les valeurs par défaut (carte, coordonnées, sprite, objets) sont des **exemples à remplacer**. Les modèles s'analysent sans aucun diagnostic et leurs commandes sont contrôlées contre la table de commandes d'un vrai serveur, mais aucun n'a été chargé par un serveur en marche.

Pour des formulaires guidés, voir [Outils NPC](FR-Outils-NPC).

## Déclarer les commandes de votre fork

Si votre fork du serveur ajoute des commandes, un avertissement `RA0001` (« commande inconnue ») apparaît. Appuyez sur `Ctrl+.` dessus pour **déclarer la commande** dans `.runeforge/project.json` (jamais dans un fichier du serveur), ou ajoutez-la à la main dans **Paramètres › Projet**. Vous pouvez aussi y abaisser ou couper ces alertes. Voir [Intégration du serveur](FR-Integration-Serveur).

## Portée de la navigation

- **La définition** (`F12`) propose une seule cible (limite de l'éditeur) ; les doublons sont signalés par les diagnostics.
- **Les références** couvrent les labels, les fonctions appelées par un `callfunc "Nom"` littéral, les noms de NPC de `duplicate(...)`, les variables locales et les variables globales du fichier courant. Les références par chaîne dynamique (`donpcevent`, `addtimer`…) ne sont pas suivies.
- **La recherche de symboles du projet** (`Ctrl+T`) liste les fonctions globales et les noms de NPC (100 résultats au plus).
- L'index est en mémoire et reconstruit à chaque ouverture de projet : environ 1,2 s pour 841 fichiers, environ 7 s pour 5 000 fichiers, en arrière-plan.

## Réactivité mesurée

Sur une machine de référence (Ryzen 7, Windows 11), les listes de complétion s'affichent en 11 à 16 ms environ dans l'application réelle (le service de langage lui-même répond en 0,1 à 0,8 ms). Ce sont des mesures, pas des garanties ; voir [`docs/PERFORMANCE.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/PERFORMANCE.md).
