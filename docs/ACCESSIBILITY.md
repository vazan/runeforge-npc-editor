# Accessibilité

> État au **2026-11-09**, sur **Windows 11 / WebView2**. Un audit automatisé et rejouable sur l'application réelle, et — tout aussi important — ce qu'il **ne couvre pas**. Cible : WCAG 2.1 niveau AA pour l'interface de l'application
> (l'éditeur Monaco apporte son propre mode « lecteur d'écran »).

## Audit automatisé : `scripts/e2e/accessibility.ts`

```bash
pnpm e2e                                                                        # construit l'exécutable E2E (une fois)
pnpm exec tsx scripts/e2e/accessibility.ts target/e2e/release/runeforge-studio.exe [dossier-de-captures]
```

Aucune dépendance : l'arbre d'accessibilité vient du navigateur (CDP `Accessibility.getFullAXTree`), les contrastes sont calculés dans la page sur les styles réellement appliqués, le clavier est piloté par de **vraies touches** (`Input.dispatchKeyEvent`).

| Critère WCAG 2.1 | Vérification | Résultat (2026-11-09) |
|---|---|---|
| 4.1.2 Nom, rôle, valeur | Noms des contrôles sur onze écrans (espace de travail, rapport de projet, paramètres, **paramètres › Mises à jour** dans deux états — mise à jour disponible avec un échec, puis téléchargement avec sa barre de progression —, palette, assistant de NPC, déploiement, éditeur visuel avec aperçu, **constructeur de NPC en nœuds** et **simulation de dialogue**). | **0 contrôle sans nom** (218 à 884 nœuds par écran, 2026-11-15). |
| 3.1.1 Langue de la page | `<html lang>` suit la langue de l'interface (`en`, `fr`) | conforme |
| 1.4.3 Contraste (minimum) | Contraste du texte sur son arrière-plan dans les deux thèmes, avec des seuils de 4,5:1 pour le texte normal et de 3:1 pour le grand texte. | 35 à 214 textes par écran et par thème (157 pour le constructeur en nœuds, dont le canevas sombre ; 79 pour la simulation), **0 combinaison insuffisante**. |
| 2.1.1 Clavier, 2.4.7 Focus visible | Tab parcourt l’espace de travail. L’audit vérifie le nom et l’indicateur de focus à chaque arrêt. | **21 arrêts de Tab**, tous nommés et dotés d’un indicateur. |
| 2.1.2 Pas de piège, 2.4.3 Ordre du focus | Paramètres, **paramètres ouverts sur l’onglet Mises à jour**, palette, assistant, déploiement, éditeur visuel, constructeur de NPC et simulation de dialogue. L’audit vérifie l’entrée du focus, Tab et Maj+Tab dans le dialogue, puis la fermeture par Échap et le retour du focus. | **8 dialogues conformes** (2026-11-15). |

Le scénario E2E de l'application (41 étapes) vérifie en plus les raccourcis (F12, Maj+F12, Ctrl+T, F2, Ctrl+Espace, Ctrl+Maj+Espace, Ctrl+., Ctrl+Maj+D, Ctrl+Maj+M) avec de vraies touches.

## Défauts trouvés par l'audit et corrigés (M5-S1)

1. **Palette de commandes** : `Tab` la quittait (le focus passait au contenu caché derrière) et `Échap` ne la fermait plus dès que le focus n'était pas sur sa saisie ; à la fermeture, le focus était perdu. Corrigé : `Tab` reste sur la saisie, `Échap` est
   traité au niveau du dialogue (qui accepte le focus par un clic), le focus est rendu à l'élément d'origine sauf si l'action choisie l'a déjà placé ailleurs (`useRestoreFocus`).
2. La **liste des résultats** de la palette n'avait pas de nom (`aria-label`).
3. La **liste d'onglets des paramètres** n'avait pas de nom (`aria-label`).

Protection contre la régression : 9 tests de composants (`App.accessibility.test.tsx`, `useRestoreFocus.test.tsx`) et 9 mutations volontaires du code, toutes détectées.

## Correctif de l’aperçu des changements (M7)

L’audit étendu a trouvé deux zones de texte sans nom dans l’aperçu de l’éditeur visuel. L’application nomme chaque panneau Monaco et rétablit son nom si Monaco le perd lors d’un changement de disposition. Le nouvel audit retrouve les deux panneaux dans l’arbre d’accessibilité et relève zéro contrôle sans nom.

## Fenêtre de simulation de dialogue (M8-S1b, 2026-11-14)

- Dans le journal (`role="log"`), chaque entrée se distingue par son texte, pas seulement par sa couleur : « Non simulé : … », « Résultat supposé : … → … », « Joueur : … », « NPC (…) : … » ; l'italique et la bordure s'y ajoutent. L'audit de contraste couvre l'écran dans les deux thèmes (79 textes, **0 combinaison insuffisante**) ; 289 nœuds d'accessibilité, **0 contrôle sans nom**.
- **M8-S1d (2026-11-15)** : la classe du personnage de test est une liste déroulante native (`<select>`) étiquetée « Classe » (« Class »), qui remplace le champ numérique « Class ID » : Tab y accède, les flèches et la saisie de la première lettre d'un nom la parcourent (153 noms de classe), la valeur choisie suit `color-scheme` (thème sombre vérifié sur capture). Audit rejoué : 81 textes par thème sans contraste insuffisant, 447 nœuds d'accessibilité (les 153 options comprises), **0 contrôle sans nom**, sept dialogues conformes. Non couvert : l'annonce de la liste par un lecteur d'écran.
- **M8-S1c (2026-11-15)** : une opération que le serveur refuserait est une ligne du journal (« Opération invalide (division par zéro) : … — le serveur arrêterait le script ici… »), pas une alerte : rien ne vole le focus ni n'interrompt la lecture d'un lecteur d'écran, et la raison est dans le texte, pas dans la couleur (la bordure d'avertissement s'ajoute). Une limite de ressources (boucle sans fin) est un message d'état poli (`role="status"`), non une alerte ; l'avis « Problèmes de syntaxe dans ce NPC : N » aussi. Le NPC de l'audit simule désormais une instruction non simulée et une division par zéro : les deux types de lignes sont dans l'audit de contraste (2026-11-15 : 81 textes par thème, **0 combinaison insuffisante** ; 296 nœuds d'accessibilité, **0 contrôle sans nom** ; les sept dialogues restent conformes). Non audités : le contraste de la bordure d'avertissement (non textuelle) et l'annonce du journal par un lecteur d'écran.
- Quand le bouton activé disparaît (« Page suivante », un choix), le focus passe au premier contrôle de l'attente suivante, sinon à la zone de réponse. Sans cela, le focus tombait sur la page et Échap ne fermait plus le dialogue : **défaut trouvé par l'audit** le 2026-11-14, corrigé, avec un test jsdom de non-régression.
- **Défaut de fond corrigé dans `Modal`** : le focus initial et le piège de Tab comptaient comme atteignables les contrôles d'un `<details>` fermé (le panneau IA précède le formulaire). Le focus n'entrait pas dans le dialogue, Maj+Tab sortait du piège et Échap restait sans effet. Seul le résumé d'un `<details>` fermé est désormais atteignable, et le premier champ du formulaire reçoit le focus à l'ouverture. Les six autres dialogues restent conformes (audit rejoué).
- Non couvert : essai avec un lecteur d'écran (le journal est une région vive polie, son annonce n'a pas été écoutée).

### Onglet Mises à jour (DEC-046, 2026-11-15)

- Champs étiquetés (dépôt, canal, jeton), aide reliée par `aria-describedby`, `aria-invalid` sur le dépôt et le jeton mal formés ; le jeton est un champ `password` sans saisie semi-automatique. L'état (« Recherche… », « Version X disponible… », « Téléchargement… N % », « Redémarrage… ») est une région `role="status"` polie ; **une erreur est une alerte** (`role="alert"`) dont le texte dit quoi faire, sans code ni texte du serveur. La progression est un `<progress>` nommé « Progression du téléchargement de la mise à jour » **en plus** du pourcentage écrit. Les notes de version sont une région nommée, atteignable au clavier (`tabindex="0"`, elle défile), affichée comme du texte.
- L'audit couvre l'onglet dans deux états (mise à jour disponible avec un échec affiché ; téléchargement en cours) et les deux thèmes : 58 et 55 textes par thème, **0 combinaison insuffisante** ; 318 et 310 nœuds, **0 contrôle sans nom**.
- **Défaut trouvé par cet audit et corrigé dans `Modal`** : le piège du focus comptait comme arrêts de Tab les boutons à `tabindex="-1"` (les onglets inactifs d'un jeu d'onglets à tabindex mobile). Un dialogue ouvert sur un onglet qui n'est pas le premier de la liste — Paramètres › Mises à jour (menu Aide › Mises à jour…), mais aussi Paramètres › À propos, qui existait déjà — laissait Maj+Tab sortir du dialogue, et Échap ne le fermait plus. Désormais seuls les contrôles que Tab atteint réellement comptent. `Modal.test.tsx` (5 tests) couvre Maj+Tab depuis l'onglet actif, le retour du dernier au premier, l'ordre parcouru, le focus rendu et Échap ; les quatre mutations du piège sont détectées, y compris le défaut d'origine. Audit rejoué : huit dialogues conformes.
- Non couvert : l'annonce de ces états par un lecteur d'écran.

## Canevas de nœuds du constructeur (M7-S2b, 2026-11-14)

- Les nœuds sont des `article` nommés (« mes 1 », « Condition 3 »), le canevas un groupe nommé « Node canvas » décrit par son texte d'aide. Les fils (SVG) sont cachés aux technologies d'assistance : leur contenu est porté par le **nom des prises**, qui sont des boutons — « Next output of mes 1: connected to close 2 », « Input of close 2: 2 wire(s) connected ».
- Tout se fait au clavier : activer une sortie (bouton à bascule, `aria-pressed`) puis une entrée relie ; Suppr débranche ; Échap annule le fil en cours sans fermer le dialogue ; chaque fil a un bouton × nommé ; chaque action est annoncée par une région `role="status"` (« Connected Next of mes 1 to close 2. »).
- La zone cliquable d'une prise fait 24 × 24 px (le rond visible, 14 px) ; le canevas redéfinit ses jetons de couleur (sombre dans les deux thèmes) et l'audit de contraste couvre l'écran dans les deux thèmes (**0 combinaison insuffisante**).
- Non couvert : essai avec un lecteur d'écran ; contraste des fils et des prises (éléments non textuels, WCAG 1.4.11) ; déplacer un nœud au clavier (la position n'a pas d'effet sur le script).

## Ce que l'interface offre déjà

- Tout est accessible **au clavier** (raccourcis listés dans le guide, palette de commandes Ctrl+Maj+P, navigation de l'explorateur aux flèches, menus ARIA) ; thèmes **clair, sombre ou du système** ; langues **français et anglais** ; taille de police, retour à la ligne, affichage des espaces réglables dans l'éditeur.
- Les animations ne s'appliquent que si le système ne demande pas de mouvement réduit (`prefers-reduced-motion`).
- Notifications annoncées (`role="status"`), alertes (`role="alert"`), états de chargement et d'erreur explicites.

## Ce qui n'est pas couvert

- **Lecteur d'écran** (NVDA, Narrateur) : **non testé** — l'arbre d'accessibilité est audité, pas l'expérience de lecture. À faire avec un testeur concerné avant la distribution.
- **Contraste des éléments non textuels** (1.4.11 : icônes, bordures, indicateur de focus lui-même), **zoom à 200 % et réorganisation** (1.4.4, 1.4.10), **mode contraste élevé de Windows** (`forced-colors`), taille des cibles tactiles, saisie par IME : non audités.
- L'éditeur Monaco (son contenu, ses suggestions) suit ses propres règles d'accessibilité ; seule la couleur du texte de l'éditeur est incluse dans l'audit des contrastes.
- **Linux** (WebKitGTK) : non testé.
