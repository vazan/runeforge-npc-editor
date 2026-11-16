# Dépannage et FAQ

*🇬🇧 [English version](EN-Troubleshooting-and-FAQ)*

## Dépannage

| Symptôme | Cause probable et remède |
|---|---|
| **Aucune commande n'est proposée** pendant la frappe | Aucun serveur rAthena n'a été reconnu. Regardez la barre d'état et **Paramètres › Projet** ; désignez le dossier du serveur. Sans serveur, vous gardez la bibliothèque de commandes hors ligne, mais les vérifications propres au serveur restent muettes |
| **Trop d'alertes `RA0001` (« commande inconnue »)** | Votre fork a des commandes que la table du serveur local ne connaît pas. Déclarez-les (`Ctrl+.` sur l'alerte, ou Paramètres › Projet), ou abaissez/coupez ce niveau d'alerte |
| Une fonction est signalée inconnue alors qu'elle existe | Elle est définie dans un fichier hors de l'index (motif `sources` trop étroit, ou exclusion). Vérifiez Paramètres › Projet ; élargissez `sources`, ou utilisez la portée « loaded » si le fichier est bien chargé par le serveur |
| **Beaucoup de noms de NPC en double (`RA0005`)** | L'index mélange des variantes exclusives (`re/` et `pre-re/`). Utilisez la portée d'index **« Scripts chargés par le serveur »** |
| Le Rapport de projet montre peu de fichiers | Par défaut, il ne liste que les scripts que le serveur charge. Décochez la case pour tout montrer (le rapport se recalcule) |
| Les accents d'un fichier s'affichent mal | Vérifiez l'encodage dans la barre d'état. Un fichier non UTF-8 est supposé en `windows-1252` (configurable par projet). Le texte affiché peut être faux, mais **les octets sont préservés** |
| `RA0016` sur une fonction que vous « appelez par son nom » | Le serveur ne connaît une fonction qu'après le chargement de sa définition. Chargez le fichier qui la définit plus tôt dans `scripts_*.conf`, définissez la fonction plus haut dans le fichier, ou appelez-la par `callfunc "Nom"` |
| Un script est « valide » pour RuneForge mais pas chargé par le serveur | Une analyse locale n'est pas une exécution du serveur. Vérifiez aussi qu'un fichier `scripts_*.conf` **cite** le script — RuneForge ne modifie jamais ces listes |
| L'enregistrement a été bloqué | Un caractère ne peut pas être représenté dans l'encodage du fichier. RuneForge refuse de le remplacer en silence ; changez ou retirez le caractère |
| « Ce dossier n'a pas encore de configuration RuneForge » | Information. Choisissez *Créer la configuration* seulement si vous voulez un `.runeforge/project.json` |
| **Le panneau Git demande d'activer Git** | Git est refusé tant que vous ne l'autorisez pas pour ce projet (boîte de confirmation). N'acceptez que pour des dépôts de confiance |
| « Cette version ne peut pas vérifier les mises à jour » | La version est antérieure à la clé de production des mises à jour (tout ce qui a été construit avant 0.1.0-beta.1). Installez une fois une release depuis la [page des Releases](https://github.com/vazan/runeforge-npc-editor/releases) ; les versions suivantes pourront ensuite se mettre à jour sur place. Voir [Mises à jour](FR-Mises-a-jour) |
| Les tests de bout en bout échouent une fois sur une machine chargée | Certaines étapes qui pilotent la souris ou la liste de complétion dépendent du timing. Rejouez l'étape fautive seule sur une machine au repos avant de conclure à une régression |
| Linux : la fenêtre ne s'ouvre pas | Installez `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libssl3` ; un binaire construit avec une glibc plus récente ne démarre pas sur une distribution plus ancienne. Pour un essai rapide sous WSL : `GDK_BACKEND=x11 ./runeforge-studio` |

## FAQ

**RuneForge Studio est-il officiel ou affilié à Gravity ?**
Non. C'est un outil **non officiel**. « Ragnarok Online » et « Gravity » sont des marques de leurs titulaires. Aucune ressource du jeu (sprite, carte, musique, marque) n'est incluse.

**Lance-t-il mon serveur ou mes scripts ?**
Jamais. Il lit le texte des scripts et les fichiers de votre serveur. Une analyse locale n'est *pas* une exécution du serveur ; seul le serveur confirme le comportement réel.

**Va-t-il modifier ou corrompre mes scripts ?**
Il est conçu pour ne pas pouvoir le faire en silence : aucune écriture sans votre action, préservation exacte des encodages, BOM et fins de ligne, écritures atomiques, détection de conflit, récupération après plantage. Si vous constatez le contraire, c'est le type de bogue de **plus haute priorité** — merci de le signaler.

**Quels émulateurs sont pris en charge ?**
**rAthena** (Renewal vérifié ; logique pre-renewal testée sur des fixtures). **Hercules n'est pas encore pris en charge** : pour un projet Hercules, seuls le lexer et l'analyseur s'appliquent, et RuneForge dit « pas de registre » plutôt que de deviner.

**Quelles plateformes ?**
Windows 11 est entièrement vérifié. Linux x86_64 se construit et passe tous les tests, mais sa fenêtre a très peu été testée. macOS n'est pas pris en charge.

**Existe-t-il un installateur ou un téléchargement ?**
Il n'y a pas d'installateur, mais il y a un téléchargement : le `.exe` Windows et le binaire Linux de la pré-version 0.1.0-beta.1 sont sur la page des Releases (voir [Premiers pas](FR-Premiers-Pas)). Vous pouvez aussi construire depuis les sources ([Développement](FR-Developpement)).

**Pourquoi « RuneForge Studio » ?**
C'est un nom de travail ; une recherche de marque n'a pas été faite.

**Sous quelle licence ?**
GPL-3.0-only. Voir [Licence](FR-Licence).

**Puis-je l'utiliser sur un fork de serveur ?**
Oui. RuneForge lit les fichiers propres du fork. Les différences qu'il ne peut pas lire (analyseur modifié, nouvelles commandes) peuvent être déclarées dans Paramètres › Projet.

**La fonction IA est-elle obligatoire ?**
Non. Elle est facultative, inactive tant que vous ne configurez pas de point d'accès, et demande un consentement avant chaque envoi.

**L'interface est-elle traduite ?**
En anglais et en français, au choix dans les Paramètres. Certains contenus restent en anglais volontairement (noms de classes, texte des NPC générés).

**Comment suivre l'avancement ?**
Voir la [feuille de route](FR-Feuille-de-route) et le [`CHANGELOG.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/CHANGELOG.md) du dépôt.

## Signaler un bogue

Ouvrez un ticket avec les modèles : [nouveau ticket](https://github.com/vazan/runeforge-npc-editor/issues/new/choose). Les tickets en **français ou en anglais** sont les bienvenus.

- **Bug report** — comporte une question obligatoire : un de vos fichiers a-t-il été modifié ou perdu ?
- **Diagnostic report** — pour une fausse alerte, un problème manqué ou une documentation de commande erronée. Indiquez ce que vous avez observé sur un vrai serveur (RuneForge ne le lance jamais).
- **Feature request** — décrivez le besoin avant la solution.
- **Question or help** — quand vous n'êtes pas sûr qu'il s'agisse d'un bogue.
- **Documentation problem** — quelque chose dans le README, le wiki ou `docs/` est faux, peu clair, manquant ou mal traduit.

Éléments utiles et sans risque à joindre : la version (Paramètres › À propos), votre système, s'il s'agit d'un `.exe` Windows, d'un binaire Linux, d'un AppImage ou d'une construction depuis les sources, l'émulateur affiché dans la barre d'état, un extrait de script **minimal et anonymisé** (avec l'encodage, le BOM et les fins de ligne pour les bogues de gestion de fichiers), le **Rapport de projet copié en texte** (il ne contient jamais le contenu de vos scripts) et le journal de diagnostic si vous l'avez activé.

**Ne collez jamais** de clé API, de jeton, de clé SSH, de clé de signature (`*.key`) ni de mot de passe. **Les vulnérabilités de sécurité n'ont pas leur place dans les tickets publics** — voir [Confidentialité et sécurité](FR-Confidentialite-et-Securite#signaler-une-vulnérabilité).
