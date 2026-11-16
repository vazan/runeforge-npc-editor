# Confidentialité et sécurité

*🇬🇧 [English version](EN-Privacy-and-Security)*

> Ceci est une vue d'ensemble, pas une certification. **Aucune revue de sécurité externe n'a eu lieu.** Le modèle de menaces détaillé, test par test, est [`docs/SECURITY.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/SECURITY.md).

## La confidentialité en un tableau

| Question | Réponse |
|---|---|
| Envoie-t-il de la télémétrie ? | **Non.** Il n'y a aucun code d'analyse d'usage |
| Utilise-t-il le réseau ? | **Seulement quand vous déclenchez une fonction qui en a besoin** : *Rechercher des mises à jour* (GitHub), une *proposition ou génération par IA* que vous confirmez (le point d'accès que vous configurez), un *aperçu SFTP* auquel vous consentez (l'hôte que vous nommez) |
| Vérifie-t-il les mises à jour en arrière-plan ? | **Non.** Jamais au démarrage, jamais automatiquement |
| Que lance-t-il ? | Votre `git` installé (panneau Git, après activation par projet) et le client OpenSSH `ssh` (aperçu SFTP, après votre accord). Rien d'autre. **Il ne lance jamais votre serveur de jeu** |
| Exécute-t-il mes scripts ? | **Non.** Votre code est du texte : l'analyseur le lit et n'exécute rien |
| Quelque chose est-il stocké ? | Localement seulement — voir ci-dessous |

## Ce qui est stocké sur votre machine

| Donnée | Où | Sensibilité |
|---|---|---|
| `.runeforge/project.json` | Dans votre projet | Aucun secret. Écrit **seulement sur votre action** |
| Réglages, projets récents, session | Le dossier de données de l'application | Chemins de dossiers |
| **Instantanés de récupération, historique local** | Le dossier de données de l'application | **Contiennent votre code source** — même sensibilité que vos scripts |
| Projets pour lesquels Git est autorisé | Le dossier de configuration de l'application | Identifiants de projets (empreintes) ; jamais dans le projet |
| URL et nom du modèle IA | Réglages locaux | Aucune clé API |
| **Clé API, jeton GitHub des mises à jour** | **En mémoire seulement** jusqu'à la fermeture | **Jamais enregistrés** (ni réglages, ni journaux, ni fichiers) |
| Journal de diagnostic | `logs/runeforge.log` dans le dossier de données locales | **Désactivé par défaut** — voir ci-dessous |

### Le journal de diagnostic facultatif

**Paramètres › Confidentialité** contient une case, **décochée par défaut**. Cochée, elle ne consigne que des *événements* — projet ouvert, fin d'indexation avec des compteurs, échec ou conflit d'enregistrement, erreur non gérée de l'interface — jamais de code, de chemin, de nom de fichier ni de message d'erreur. Le côté natif valide chaque événement contre un schéma fixe. Le fichier est plafonné à 512 Kio plus une génération précédente, ne quitte jamais votre machine et s'arrête dès que vous décochez la case. Sous Windows, il se trouve sous `%LOCALAPPDATA%\dev.runeforge.studio\logs\`. On peut le joindre sans risque à un rapport de bogue.

## Comment l'application est durcie

- **Privilèges minimaux.** Une seule fenêtre, **27 commandes natives nommées explicitement**, aucune permission générique de système de fichiers ou d'interpréteur donnée à la page web. Un test Rust échoue si une commande est accordée sans être déclarée (ou l'inverse).
- **L'interface ne manipule jamais de chemin absolu.** Elle ne connaît que des *racines approuvées* opaques et des *chemins relatifs*, validés et canonicalisés en Rust : chemins vides, absolus, `..`, noms de périphériques, flux de données alternatifs et liens qui sortent de la racine sont refusés.
- **Aucune écriture sans action explicite**, et jamais par-dessus un fichier modifié ailleurs sans votre décision. Les écritures sont atomiques.
- **Politique de sécurité du contenu (CSP)** sans `unsafe-eval` et sans script en ligne. (`style-src 'unsafe-inline'` est accepté parce que Monaco injecte des styles à l'exécution ; cela ne permet pas d'exécuter du code.)
- **Tout est borné** : fichiers lus (20 Mio), parcours de l'arbre (200 000 fichiers, 64 niveaux), configuration (1 Mio), diagnostics par fichier (1 000), sortie et durée de Git.
- **Mises à jour signées** : voir [Mises à jour](FR-Mises-a-jour).
- **Aucun Rust `unsafe`** dans les crates du projet ni le cœur de l'application ; les fichiers de verrouillage des dépendances sont versionnés et installés avec un lockfile figé.
- **Isolation du crochet de test** : le crochet des tests de bout en bout n'existe que dans une construction avec la fonctionnalité `e2e`, qui ne doit jamais être distribuée.

## Ce qui n'a pas été fait

- Aucune revue de sécurité externe ni test d'intrusion.
- Aucun `pnpm audit` / `cargo audit` exécuté pour l'instant (il exige l'accès au réseau).
- Le `connect-src` de la CSP autorise HTTPS et HTTP pour pouvoir configurer un fournisseur d'IA local ; le contrôle applicatif restreint HTTP à la boucle locale et aux adresses IPv4 privées, mais la portée plus large de la CSP doit encore être revue indépendamment avant diffusion.
- Pas de signature de code Windows ; pas de stockage de secrets au niveau du système (les secrets restent simplement en mémoire).
- Sous Linux, la fenêtre a été très peu exercée, et les correctifs de sécurité de GTK/WebKitGTK/OpenSSL viennent de votre distribution.

## Signaler une vulnérabilité

**N'ouvrez pas de ticket public.** Utilisez le signalement privé de vulnérabilités de GitHub : [signaler une vulnérabilité](https://github.com/vazan/runeforge-npc-editor/security/advisories/new). (Le propriétaire du dépôt doit avoir activé *Private vulnerability reporting* dans Settings › Code security.)

Pour les bogues hors sécurité, voir [Dépannage et FAQ](FR-Depannage-et-FAQ#signaler-un-bogue) — et ne collez jamais de secret dans un rapport.
