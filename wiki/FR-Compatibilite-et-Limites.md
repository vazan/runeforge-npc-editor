# Compatibilité et limites

*🇬🇧 [English version](EN-Compatibility-and-Limitations)*

Cette page dit sans fard ce qui est **vérifié**, ce qui est **supposé** et ce qui est **inconnu**. Rien n'est embelli. Sources détaillées : [`docs/COMPATIBILITY.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/COMPATIBILITY.md) et [`docs/KNOWN_LIMITATIONS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/KNOWN_LIMITATIONS.md). État au **2026-11-15**.

## Émulateurs

| Famille · profil | État | Ce que fait RuneForge |
|---|---|---|
| **rAthena · Renewal** | **Vérifié par lecture** (le serveur n'a jamais été exécuté) sur un fork local ; révision inconnue | Bibliothèque de commandes hors ligne, vérifications depuis les sources de votre serveur, règles de chargement, bases, diagnostics `RA0001`–`RA0016` |
| **rAthena · Pre-renewal** | **Partiel** : la logique (imports `Mode: Prerenewal`, `npc/pre-re/…`) est testée sur des fixtures rédigées | Mêmes fonctions, jamais confrontées à un vrai serveur pre-renewal |
| **Hercules** | **Non pris en charge** — aucune installation n'était disponible pour vérifier | Rien : ni registre, ni catalogue, ni modèle, ni alerte de commande. Seuls le lexer et l'analyseur s'appliquent, et leur identité avec la syntaxe Hercules est une **hypothèse**. L'application le dit au lieu de deviner |
| Fork personnalisé / sans serveur | Pris en charge par vos déclarations | Commandes et constantes du projet (`commands.custom`, `constants.custom`) ; jamais présentées comme une « erreur certaine » |

Les diagnostics reposent sur la **lecture** du serveur, jamais sur son exécution : ils sont donc « probables », pas « certains ». Débloquer Hercules exige une copie de Hercules fournie par vous (ou téléchargée avec votre accord explicite) ; la méthode est celle qui a servi pour rAthena : lire le code, écrire des oracles indépendants, faire des mutations, confronter de vrais scripts.

## Plateformes

| Plateforme | État |
|---|---|
| **Windows 11** | Application entièrement vérifiée : parcours automatisé de bout en bout sur l'exécutable réel (WebView2), audit d'accessibilité, démarrage mesuré (interface rendue en 360–489 ms) |
| **Linux x86_64** | Se construit ; tous les tests TypeScript et Rust passent (Ubuntu 26.04 sous WSL2) ; l'exécutable a été **lancé 20 secondes sous WSLg** (il démarre, rien de plus). **Non vérifiés** : rendu de WebKitGTK, Monaco, méthodes de saisie, clavier, hautes résolutions, accessibilité, mise à jour dans la fenêtre |
| Autres distributions, ARM | Non essayés. Le binaire lie dynamiquement GTK 3, WebKitGTK 4.1, libsoup 3, la glibc et OpenSSL 3 : il ne démarre pas sur une distribution qui ne les a pas ou plus ancienne que la machine de construction |
| macOS | Non pris en charge |
| Distribution | Pré-version 0.1.0-beta.1 : un `.exe` Windows brut et un binaire Linux brut (glibc ≥ 2.39) sur la page des Releases. Ni installateur, ni `.deb`/`.rpm`, ni signature de code. Un AppImage peut être construit (glibc ≥ 2.43 exigée s'il est construit sous Ubuntu 26.04) |
| Windows 10 | Windows 11 est le système testé ; Windows 10 est proposé dans les modèles de tickets mais n'est pas une cible vérifiée |

## Fonctions et leur maturité

| Domaine | État |
|---|---|
| Éditeur sûr, encodages, récupération | **Vérifié** (Windows) |
| Diagnostics de syntaxe et sémantiques locaux, navigation, renommage | **Vérifié** (Windows) |
| Vérifications rAthena des commandes, objets, monstres, cartes et constantes | **Vérifié** (Windows, Renewal) |
| Rapport de projet | **Vérifié** ; un instantané des fichiers indexés, export par copie seulement |
| Modèles et assistants de NPC | **Vérifié statiquement** ; aucun script produit n'a été chargé par un serveur en marche |
| Panneau Git (lecture seule) | **Vérifié** (Windows) |
| Déploiement local avec sauvegarde et restauration | **Vérifié** (Windows) |
| Éditeur visuel de dialogues, constructeur en nœuds | **Partiel** : crée de nouveaux NPC, édite des blocs de dialogue ; ne relit pas un script existant sous forme de graphe |
| Simulation de dialogue | **Partiel** : un aperçu local, pas un serveur |
| Assistance IA | **Partiel** : testée avec un fournisseur simulé seulement ; aucun fournisseur réel vérifié |
| SFTP | **Précoce** : comparaison en lecture seule ; pas de transfert |
| Mises à jour signées | **Implémentées et testées contre un faux GitHub** ; la clé de production et une première release signée existent, mais aucune mise à jour n'a encore été installée depuis une vraie release |
| Extensions | **Manifestes JSON statiques seulement**, temporaires ; ni code, ni permissions |

## Limites du moteur de langage

- Les règles reproduisent le comportement du **serveur rAthena local** ; les différences d'autres révisions ou forks sont inconnues.
- **Aucun diagnostic ne veut pas dire que le script se charge** : seule une exécution sur votre serveur tranche.
- La précédence des opérateurs suit les conventions du C et n'est pas confrontée à toutes les subtilités du serveur.
- Les caractères non ASCII hors chaînes et commentaires deviennent des jetons `Unknown` ; les types de déclaration inconnus sont conservés comme déclarations brutes et leur corps `{…}` n'est pas analysé.
- Le contexte de complétion est déduit de la ligne et des deux précédentes, pas de l'arbre syntaxique complet ; une instruction étalée sur plus de quelques lignes peut ne pas être reconnue.
- Seuls les nombres et chaînes **écrits en clair** sont comparés aux bases d'objets, de monstres et de cartes (pas les variables ni les expressions) ; une constante inconnue n'est **pas** signalée.
- Le *nombre* d'arguments des commandes est vérifié ; leurs *types* ne le sont pas.
- Les appels `callfunc "Nom"` à chaîne littérale sont suivis ; les appels par nom nu et par chaîne dynamique le sont partiellement ou pas du tout ; les références d'événements par chaîne (`donpcevent`, `addtimer`, `doevent`) ne le sont pas.
- L'index est en mémoire (pas de persistance) et reconstruit à chaque ouverture de projet ; il n'y a pas de surveillance continue du disque.

## Autres limites

- Explorateur : ni renommage, ni déplacement, ni suppression de fichiers.
- Éditeur : un seul groupe, pas de glisser-déposer des onglets, changement d'encodage absent de la barre d'état.
- Accessibilité : audit automatisé seulement (noms, contraste du texte, clavier, dialogues). **Aucun essai au lecteur d'écran** (NVDA, Narrateur), ni audit du contraste non textuel, du zoom à 200 %, du mode contraste élevé ou des IME. Voir [`docs/ACCESSIBILITY.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/ACCESSIBILITY.md).
- Le simulateur ne joue qu'un clic sur le NPC (plus `OnInit`) ; les minuteries et événements de contact ne sont pas déclenchés. Les quêtes ne sont modélisées que par leur état ; le personnage de test n'a ni groupe, ni guilde, ni monture, ni équipement.
- Les chiffres de performance viennent d'**une seule machine** ; une machine modeste et Linux n'ont pas été mesurés.

## Ce que veut dire « BLOCKED_EXTERNAL » dans les documents du projet

Un travail qui dépend d'un tiers et que le code seul ne peut pas réaliser : une installation Hercules, un certificat de signature de code Windows/Linux, une clé de signature des mises à jour de production, une revue juridique et de sécurité indépendante, un poste de bureau Linux pour tester, l'accès au réseau pour les audits de dépendances.
