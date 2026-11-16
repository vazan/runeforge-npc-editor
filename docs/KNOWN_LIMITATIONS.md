# Limitations connues

> Ce qui n'est pas implémenté, simulé ou vérifié. Mise à jour à chaque tranche. Rien n'est embelli.
> État au 2026-11-15. Les preuves Windows et Linux et l'état des tranches M4 à M9 figurent dans [`STATUS.md`](STATUS.md).

## Fonctionnalités absentes à ce jour
- **Intelligence de langage** : sont disponibles la navigation (F12 / Ctrl+clic vers la définition, plan du document, références par
  Maj+F12, recherche de symboles du projet par Ctrl+T), la complétion et le survol des symboles du projet, **des commandes** et — pour un
  serveur rAthena reconnu — **des objets, monstres, cartes et constantes du serveur**, l'aide de signature, le renommage sûr, une action
  rapide (déclarer une commande), des modèles de NPC, la recherche et l'insertion de références (Ctrl+Maj+D), et les diagnostics de
  **syntaxe**, **sémantiques**, de **commande inconnue**, de **nombre d'arguments** et d'**objet, monstre ou carte introuvable**. Sont
  absents : les arguments d'autres natures (compétence, quête, groupe d'objets, état…), les autres actions rapides (ajouter un `;`, créer un
  label…). Les fonctions introuvables et noms de NPC en double entre fichiers ne sont signalés que si le projet active `validation.crossFile`
  (réglage « Vérifications entre fichiers », désactivé par défaut). Le **rapport de projet** (Ctrl+Maj+M) liste les problèmes de tous les
  fichiers indexés : voir « Rapport de projet » plus bas pour ses limites.
- **Aucun adaptateur Hercules** : pour un projet Hercules l'application l'affiche (« pas de registre »), n'émet aucune alerte de commande
  ou de référence et ne propose ni commande, ni modèle, ni objet, monstre, carte ou constante.
- Le **transfert** SSH/SFTP (seul un aperçu en lecture seule existe : « Aperçu SFTP en lecture seule » plus bas), graphe visuel général, simulateur, IA, plugins et exécution sur un serveur de test. Les sections M6 et M7 ci-dessous délimitent les fonctions disponibles.
- Explorateur : pas de renommage, déplacement ni suppression de fichiers (choix volontaire : aucune opération destructive
  tant que leur garde-fou n'est pas conçu) ; création de fichiers vides uniquement.
- Éditeur : un seul groupe d'éditeurs ; pas de réorganisation des onglets par glisser-déposer ; l'encodage ne se change que
  via le dialogue « caractères non enregistrables » (pas encore depuis la barre d'état) ; l'historique local est consultable
  dans la comparaison mais pas restaurable en un clic.
- Distribution : pas d'installateur ni de signature de code (M5, `BLOCKED_EXTERNAL`). Les mises à jour depuis les releases d'un dépôt GitHub existent (DEC-046) ; la clé de signature de production et une première release (0.1.0-beta.1, binaires bruts Windows et Linux) existent depuis le 2026-11-15, mais aucune mise à jour n'a encore été installée depuis une vraie release ; voir « Mises à jour signées » plus bas.

## Moteur de langage (vérifié sur corpus, avec réserves)
- Les règles du lexer/parseur reproduisent le comportement du serveur **rAthena local** (lecture de `src/map/script.cpp`).
  Elles n'ont **pas** été confrontées à un serveur Hercules : les différences de syntaxe éventuelles sont inconnues.
- L'absence de diagnostic sur un script ne signifie pas qu'il se charge sur le serveur : seule l'exécution sur le serveur
  cible fait foi (cahier des charges §0.7).
- Précédence des opérateurs : convention C ; non confrontée à toutes les subtilités du serveur.
- Les caractères non ASCII hors chaînes/commentaires deviennent des tokens `Unknown`.
- Les déclarations de type inconnu sont conservées (`RawDeclaration`) ; un bloc `{…}` rattaché n'est pas analysé.
- Le surlignage des diagnostics utilise les offsets de la dernière analyse : pendant la frappe (≤ 250 ms) un soulignement peut
  être décalé avant d'être recalculé.

## Navigation et index du projet (M3-S1)
- **Une seule définition** est proposée à F12 / Ctrl+clic : l'aperçu de Monaco n'affiche que des fichiers dont le modèle est ouvert
  (DEC-023). Les définitions multiples (fonction définie deux fois) sont signalées par `RA0011` si `validation.crossFile` est actif.
- **Références** : labels (dans leur script), fonctions globales (appels `callfunc "Nom"` à chaîne littérale seulement : les appels
  par nom nu `F_Nom arg;` ou par chaîne dynamique ne sont pas trouvés), noms de NPC (`duplicate(...)`), variables locales (`.@`, `.`)
  dans leur script, variables globales dans le **fichier courant** seulement. Les références d'événements par chaîne
  (`donpcevent "NPC::OnX"`, `addtimer`, `doevent`) ne sont pas suivies. Affichage limité à 500 résultats.
- **Recherche de symboles** (Ctrl+T) : fonctions globales et noms de NPC (pas les labels), 100 résultats au plus.
- **Index en mémoire**, reconstruit à chaque ouverture de projet (≈1,2 s pour 841 fichiers, ≈7 s pour 5 000) ; pas de persistance
  (SQLite/FTS5 non mis en place). Resynchronisé à la prise de focus de la fenêtre (au plus toutes les 15 s) et après création de
  fichier : **pas de surveillance continue du disque**.
- L'indexation lit par défaut tout ce que désigne `sources` (`**/*.txt`) : un projet qui mélange des variantes exclusives (`re/` et
  `pre-re/`) produit de faux doublons si `validation.crossFile` est actif. Remède : la portée « Scripts chargés par le serveur »
  (`emulator.indexScope: "loaded"`, voir plus bas), **non activée par défaut** ; limite de parcours : 200 000 fichiers (non signalée à l'utilisateur).
- Un fichier non lisible ou binaire est ignoré et compté (« ignorés » dans l'info-bulle de l'indicateur d'indexation).
- L'indicateur d'indexation de la barre d'état n'est pas annoncé aux lecteurs d'écran (pas de région `aria-live`).

## Serveur, registre de commandes et règles de chargement (M4-S1)
- **rAthena seulement** : Hercules n'a ni registre ni règles de chargement. Les règles de chargement et la table des commandes sont
  prouvées dans le code source du serveur rAthena **local** ; leur identité avec d'autres révisions ou forks est une hypothèse
  (un fork qui change `parse_callfunc` ou la notation des arguments donnerait de fausses alertes).
- **Bibliothèque rAthena intégrée** (DEC-041) : 667 commandes depuis le checkout local `rathena-kov`, avec 662 aides/signatures du manuel dont la dernière mise à jour connue est le 2022-03-08. La révision précise du checkout n'est pas identifiée ; d'autres versions et forks peuvent différer. `pnpm run generate:rathena-library` exige les sources rAthena et le manuel dans le dépôt, mais l'application n'en dépend pas à l'exécution.
- **Validation serveur** : `src/map/script.cpp` fait foi pour les noms et l'arité ; `src/custom/script_def.inc` ajoute les commandes personnalisées. Sans code source (serveur précompilé), l'aide intégrée reste disponible, mais **aucune** alerte d'arité ou de commande inconnue n'est émise. Les diagnostics ne se basent jamais uniquement sur le snapshot afin d'éviter les faux positifs entre versions.
- **Un serveur compilé avec d'autres options peut différer du code source lu** : les commandes sous `#ifdef` (ex. `PCRE_SUPPORT`) sont
  considérées connues quelle que soit la compilation (marquées `conditional`), donc jamais signalées à tort, mais une commande absente
  du binaire n'est pas détectée.
- **Détection de la racine du serveur** : par la présence de fichiers caractéristiques (`doc/script_commands.txt`, dont le contenu n'est pas ouvert,
  `src/map/script.cpp`,
  `npc/re/scripts_main.conf`, `npc/pre-re/scripts_main.conf`, `conf/map_athena.conf`). Plusieurs serveurs dans le projet : **rien n'est
  choisi** (barre d'état « Choisir un serveur »), l'utilisateur indique le dossier dans les paramètres du projet. Une racine configurée
  est prise telle quelle, sans vérification de son contenu.
- **Mode de compilation** (`re`/`pre-re`) : lu dans `src/config/renewal.hpp` ; une compilation pilotée par des options du compilateur
  n'y est pas visible (réglage « Mode de compilation du serveur » pour l'imposer). Fichier absent : renewal supposé, et le dit.
- **Scripts chargés par le serveur** : calculés à chaque synchronisation de l'index (lecture des `.conf`, ~40 ms pour 17 fichiers) ;
  l'**ordre de chargement n'est pas encore exploité** par les diagnostics (un appel de fonction par son nom, ou un `duplicate`,
  avant le chargement de sa cible est une erreur du serveur : non détecté). Un script cité mais absent, ou hors des exclusions du
  projet, est ignoré et compté (« problèmes dans scripts_*.conf » de l'info-bulle) sans message détaillé dans l'interface.
- **Commande inconnue (`RA0001`)** : un nom qui n'est ni une commande, ni une fonction locale du script, ni une fonction globale
  **indexée** est signalé (avertissement, confiance « inconnue » — jamais présenté comme une erreur certaine du serveur). Une fonction
  définie dans un fichier hors de l'index (`sources` trop étroit, exclusions) est donc signalée à tort ; pendant l'indexation initiale
  aucune alerte de commande n'est émise. Une commande propre à un fork se déclare dans le projet (`commands.custom` : paramètres du
  projet ou action rapide, voir « Commandes dans l'éditeur ») ou dans `src/custom/script_def.inc` du serveur ; on peut aussi régler
  « Commandes inconnues » sur « Ignorer ».
- **Nombre d'arguments (`RA0006`)** : seulement le nombre, pas les types (`s`, `i`, `v`, `r`, `l` de la table sont lus mais non vérifiés) ;
  une instruction mal formée (`;` manquant, fragment illisible) n'est pas vérifiée.
- Changer de serveur, de mode ou de portée **relit tout le projet** (aucune relecture partielle) ; l'index n'est toujours pas persistant.

## Complétion et survol des symboles (M3-S2)
- Les symboles du projet (labels, fonctions locales et globales, noms de NPC, variables) sont proposés et documentés ici ; les
  **commandes** le sont par la tranche M3-S3 (section suivante) et exigent le registre d'un serveur reconnu.
- Le contexte de complétion des symboles est déduit du texte de la ligne et des deux précédentes : une commande dont l'argument est
  séparé par plus de deux lignes, ou un `goto` précédé d'une condition qui s'étend sur plusieurs lignes, n'est pas reconnu.
- Dans une boucle `for (a; b; c) goto L;`, le `goto` n'est pas reconnu (les `;` de l'en-tête de `for` terminent l'instruction).
- Les variables proposées sont celles **déjà utilisées** dans le script (locales) et le fichier (globales) ; les variables
  d'autres fichiers, les constantes et les paramètres du serveur (`Zeny`, `BaseLevel`…) ne le sont pas (registre/bases, M4).
- Les propositions de fonctions et de NPC sont plafonnées à 200 (le filtre de Monaco affine ensuite).
- Le survol est limité aux symboles du projet ; la mise en page des textes est dans la langue de l'interface (FR/EN).
- La complétion déclenchée par Ctrl+Espace et par la frappe est vérifiée sur l'exécutable réel pour `callfunc "…"` ; les autres
  contextes (labels, variables, `duplicate`) sont couverts par des tests unitaires et le corpus réel, pas par l'E2E.

## Commandes dans l'éditeur (M3-S3)
- **Un registre de serveur rAthena est requis** : sans serveur reconnu (projet seul, Hercules), aucune commande n'est proposée,
  documentée ni signalée. Les commandes du projet (`commands.custom`) **complètent** un registre existant, elles n'en créent pas : un
  registre construit sur elles seules ferait signaler toutes les autres commandes comme inconnues (DEC-028).
- **Complétion** : 1 000 propositions au plus par liste ; la liste s'ouvre à partir de la première lettre saisie, et par Ctrl+Espace
  tant que rien n'est saisi (sinon chaque ligne vide en ouvrirait une) ; rien dans un commentaire ni dans une chaîne, sauf pour les
  arguments de carte, d'objet et de monstre (section « Bases du serveur »). L'aide du manuel est résolue à la sélection : second
  Ctrl+Espace pour le panneau de détails.
- **Contexte déduit des mots, pas de l'AST** (le code en cours de frappe est presque toujours invalide, DEC-024) : fenêtre de 120 lignes
  avant le curseur (la plus longue instruction du corpus local en compte 57). Au-delà, pas d'aide de signature. L'aide est silencieuse
  sur le nom de la commande lui-même, dans un commentaire et hors du corps d'un script (vérifié sur 25 558 positions réelles).
- **Signatures** : le texte est celui du **manuel** du serveur, tel qu'écrit ; la plage de chaque paramètre est déduite en découpant sur
  les virgules et accolades hors `<…>`. Pour une signature qui sort de cette forme (alternatives, éléments facultatifs au milieu), le
  paramètre mis en évidence peut ne pas correspondre au sens de l'argument : **seul le rang de l'argument actif est vérifié** sur le code
  réel, pas l'adéquation de la plage au texte du manuel. Sans manuel, la signature est tirée de la notation de la table du serveur
  (`warp(string, int, int, [optional])`) : types génériques (`value`, `string`, `int`, `reference`, `label`), jamais vérifiés.
- **Aide du manuel** : un extrait de 14 lignes et 900 caractères au plus (« la suite est dans le manuel » est indiqué) ; le manuel reste
  celui du serveur de l'utilisateur, lu à l'exécution : il n'est ni copié ni enregistré.
- **Commandes du projet** : déclarées dans les paramètres du projet (une par ligne : `nom` ou `nom arguments`, par exemple `mycmd s?`)
  ou par l'action rapide ; 1 000 au plus ; l'aide libre (`description`) ne s'édite que dans `.runeforge/project.json`. Sans notation des
  arguments, leur nombre n'est **pas vérifié** (jamais une erreur certaine du serveur). Une commande du projet l'emporte sur une commande
  de même nom du serveur : à employer à bon escient.
- **Action rapide « déclarer cette commande »** (Ctrl+.) : proposée uniquement sur une alerte `RA0001` dont le nom est un mot de commande
  valide et pas déjà déclaré ; elle écrit **seulement** `.runeforge/project.json` (jamais un fichier du serveur) et le dit. Il n'existe pas
  d'autre action rapide (`;` manquant, label à créer…).
- **Modèles de NPC** : `npc-script`, `npc-warp`, `npc-shop`, `npc-healer`, pour rAthena seulement (aucun pour Hercules : syntaxe non vérifiée).
  Ce sont des **snippets** à compléter dans l'éditeur, pas des assistants (formulaire, aperçu et validation : M6). Proposés en début de
  ligne, hors d'un script, en tapant `npc-` ; les valeurs par défaut (carte, coordonnées, sprite, objets) sont des **exemples** à
  remplacer : aucune n'est vérifiée contre les bases du serveur (M4-S2) — seuls les sprites `4_M_01`/`4_F_01` et les objets 501/502 ont été
  retrouvés dans le serveur local. Chaque modèle est analysé sans diagnostic et ses commandes sont contrôlées contre le registre du serveur
  local, mais **aucun n'a été chargé par un serveur** (`map-server` non lancé).
- **Latence** : mesurée sur l'application réelle (voir [`PERFORMANCE.md`](PERFORMANCE.md)) pour la **complétion** seulement (E2E : registre de
  3 commandes ; serveur local : 667 commandes, un seul fichier et un seul emplacement), sur **une** machine, au niveau du DOM (hors
  peinture). Non mesurées dans l'application : l'aide de signature et le survol (le service seul l'est), la frappe pendant une analyse,
  une machine modeste, Linux. La classe `visible` du widget de Monaco n'arrive qu'après un délai fixe de 100 ms qui lui est propre.

## Bases du serveur : objets, monstres, cartes, constantes (M4-S2)
- **rAthena seulement, lu à l'exécution** (rien n'est embarqué, DEC-012) : `db/item_db.yml` et `db/mob_db.yml` avec leurs imports (`db/re/` ou `db/pre-re/` selon le mode, puis
  `db/import/`), `db/map_index.txt` et `db/import/map_index.txt`, `db/const.yml` et `src/map/script_constants.hpp`. Sans ces fichiers (serveur précompilé sans `src/`, dossier `db/`
  absent), il n'y a **ni proposition ni alerte** pour ce qui en dépend ; la barre d'état le dit. Le **mode de compilation** (`re`/`pre-re`) choisit les fichiers lus : une
  erreur de mode lit les mauvaises bases (voir « Serveur, registre… »).
- **Un serveur configuré avec `use_sql_db: yes`** lit ses objets et monstres dans MySQL : les fichiers YAML lus peuvent alors différer de ceux que le serveur utilise. Même
  remarque pour des bases modifiées par un fork de façon que le lecteur ne comprend pas : les lignes non comprises sont comptées et signalées (info-bulle de la barre d'état),
  jamais inventées.
- **Constantes** : les noms exportés par le code du serveur (10 297 sur le serveur local : constantes, paramètres, sprites de NPC), `db/const.yml` et, depuis M4-S3d, les `RDMOPT_<Option>` des options aléatoires
  (249). Sont absentes celles que d'autres bases enregistrent à l'exécution ; leur **valeur** n'est connue que si elle est écrite en clair (`db/const.yml`, `export_constant2`) : sinon le
  survol dit qu'elle vient du code du serveur. Une constante inconnue dans un script n'est **pas** signalée (seuls objets, monstres et cartes le sont).
- **Cartes** : l'index (`map_index.txt`) liste les cartes que le serveur connaît, pas celles qu'il **charge** (`conf/maps_athena.conf`) : une carte de l'index non chargée n'est pas
  signalée. Les noms sont comparés exactement (sensible à la casse, comme le serveur). Les valeurs spéciales (`Random`, `SavePoint`, `this`…) et les textes qui ne sont pas des noms
  de carte (espaces, `#`) ne sont pas vérifiés.
- **Quels arguments** : seuls ceux dont le **manuel** du serveur nomme le paramètre (`<map name>`, `<item id>`, `<item name>`, `<mob id>`…) et dont toutes les signatures s'accordent. Un
  **nombre ou une chaîne écrits en clair** sont vérifiés ; une variable ou une expression jamais, ni zéro, ni un nombre négatif. L'alerte est une **information** (réglable : « Objets,
  monstres et cartes introuvables ») de confiance « inconnue » : le serveur peut en connaître plus que les fichiers lus. Elle contrôle l'existence du nom, pas son bon usage.
- **Complétion** : 200 propositions de références au plus par liste (la liste est redemandée en continuant la saisie : un identifiant de 6 chiffres se retrouve avec plus de chiffres) ;
  100 pour les constantes, proposées à partir de 2 lettres. À un argument d'objet ou de monstre, hors chaîne, la proposition écrit l'**identifiant** (Maj+Entrée dans la palette : le nom).
- **Recherche (Ctrl+Maj+D)** : 8 résultats par nature (100 avec `item:`, `mob:`, `map:`, `const:`) ; l'insertion remplace la sélection de l'éditeur affiché (aucune sans éditeur) et n'écrit
  aucun fichier. Les constantes du projet (`constants.custom`) complètent celles du serveur sans les remplacer.
- **Mesures** : sur un seul serveur (le local, mode renewal), une seule machine (voir [`PERFORMANCE.md`](PERFORMANCE.md)) ; le lecteur est comparé à un analyseur YAML complet sur ce
  serveur, pas sur d'autres bases ni d'autres révisions.

## Cartes des déclarations et noms de labels (M4-S3)

- **`RA0015` (carte non chargée)** : information, confiance « probable », jamais certaine — un serveur à **plusieurs serveurs de cartes** peut charger la carte ailleurs. Elle ne voit que les `map:` de `conf/map_athena.conf` et de ses imports
  (lus au démarrage du serveur du projet et à chaque changement de ses réglages, **pas** à la modification d'un `maps_athena.conf` ouvert dans l'éditeur) ; une liste absente, vide ou illisible est « inconnue » et ne déclenche rien.
  Elle ignore les lignes `mapflag` et les destinations de warp (mesure : les 26 lignes `mapflag` du serveur local sur une carte non chargée sont livrées ainsi par la distribution).
- **Coordonnées hors de la carte** (`npc_parsesrcfile` les refuse) : non vérifiées, il faudrait lire les cartes (`.gat`, cache) ; **destination d'un warp ou argument `warp "carte"` sur une carte de l'index non chargée** : non signalée.
- **`RA0014` (label réservé)** : seules comptent les commandes de la table du code source du serveur (non conditionnelles) et les constantes et paramètres que le serveur exporte ou lit dans `db/const.yml` ; les constantes ajoutées à l'exécution,
  celles du projet et les commandes du seul manuel ne sont pas jugées (aucune fausse alerte, mais des manques) ; les `RDMOPT_…` le sont depuis M4-S3d.

## Ordre de chargement des fonctions (M4-S3c)

- **`RA0016` (fonction appelée par son nom avant d'être chargée)** : erreur, confiance « probable », jamais certaine — l'ordre vient des listes de scripts lues au démarrage (`npc:`, `import:`, `delnpc:`, `npc: clear`), et le comportement du serveur est lu
  dans son code, pas observé en l'exécutant (le serveur n'est jamais lancé sans l'accord explicite de l'utilisateur). `@loadnpc` (fichier chargé à chaud) et les fichiers chargés autrement que par ces listes ne sont pas modélisés.
- **Quand l'ordre est relu** : au démarrage du projet, à chaque synchronisation de l'index (rafraîchissement de l'explorateur, retour du focus de la fenêtre) — **pas à l'enregistrement d'un `scripts_*.conf` depuis l'éditeur** tant que l'arbre
  n'est pas rafraîchi. Une liste vide (configuration absente ou illisible) ne dit rien du serveur : pas d'ordre, pas d'alerte.
- **Ce qui est reconnu comme appel** : `Nom arg;` et `Nom(arg)`. Un mot qui nomme une fonction sans parenthèses dans une expression (le serveur le lit pourtant comme un appel) ne l'est pas ; `callfunc "Nom"`, résolu à l'exécution, n'est jamais concerné.
- **Portée d'index « sources »** (par défaut) : l'index contient aussi des fichiers que le serveur ne charge pas ; l'appel d'une fonction qui n'y est définie que reçoit `RA0016` (en portée « loaded » ces fichiers ne sont pas indexés et c'est `RA0001`). Un fichier qui n'est dans
  aucune liste de scripts n'a pas de rang : rien n'est dit sur ses propres appels (un projet dont le serveur n'est qu'une copie de référence n'est donc pas inondé d'alertes).
- **Réglage** : l'alerte se coupe avec `validation.unknownCommands: off` (elle vient des mêmes appels) mais en garde la gravité d'erreur quand elle est active ; elle exige le registre de commandes (rAthena reconnu), donc rien pour Hercules ni sans serveur.

## Rapport de projet (RF-015)

- **C'est un instantané des fichiers indexés** : un fichier hors de l'index (autre motif de `sources`, exclu, binaire ou illisible — leur nombre est dit) n'y figure pas ; un fichier modifié ailleurs n'y
  entre qu'après la resynchronisation de l'index. Le rapport est dit « périmé » dès que le service change, et recalculé tout seul seulement s'il est à l'écran.
- **Restreint par défaut aux scripts que le serveur charge** (serveur reconnu, portée d'index `sources`) : les autres fichiers de l'index (documentation, bases, configuration, autre mode de
  compilation) sont laissés de côté **par le service**, leur nombre et celui de leurs problèmes sont dits, et une case les montre (le rapport est alors recalculé). Sur le serveur local : 454 fichiers
  indexés ne sont pas chargés, 124 d'entre eux ont 14 127 « problèmes » qui ne concernent pas le serveur. **Avec les vérifications entre fichiers activées** (`validation.crossFile` ≠ `off`, désactivé par défaut),
  des alertes causées par des fichiers non chargés subsistent sur les fichiers chargés : 531 `RA0005` (nom de NPC en double, jumeaux dans l'autre mode) avec la portée `sources` contre 0 avec la portée
  « scripts chargés par le serveur » ; de même un `RA0004` (fonction introuvable) peut être masqué par une définition située dans un fichier non chargé. Seule la portée « chargés » rend ces vérifications fiables (DEC-026).
- **Détail borné à 5 000 problèmes** de la vue affichée (les fichiers les moins graves perdent leur détail d'abord ; totaux et codes exacts, dits à l'écran) ; l'écran dessine au plus 300 fichiers (les filtres
  affinent) sans virtualisation, et 100 problèmes de chargement du serveur.
- **Filtres non conservés** : gravités, code, chemin et fichiers dépliés se remettent à zéro quand on change d'onglet du panneau du bas ; seul le choix « seulement les scripts chargés » dure tant que le projet est ouvert.
- **Export** : copie dans le presse-papiers seulement (texte Markdown) ; pas d'enregistrement dans un fichier ni de format machine (JSON, SARIF) — prévus avec M5. Sous WebView2, la page ne peut pas relire le
  presse-papiers : l'E2E vérifie le texte confié à `writeText` et la confirmation de l'écriture, pas le contenu final du presse-papiers.
- **Problèmes de chargement du serveur** : listés seulement avec la portée « scripts chargés » (c'est elle qui lit `scripts_*.conf` pour l'index) ; le rapport ne dit pas quels scripts du projet ne sont **pas** chargés
  par le serveur (un script jamais déclaré) : l'information existe (`scope.loaded`) mais n'est pas encore présentée comme un constat.
- **Pas de diagnostic propre au projet** au-delà de la somme de ceux des fichiers et de `scripts_*.conf` : pas de contrôle des bases, des fichiers de configuration ni du `project.json`.

## Renommage (M3-S2)
- Seuls se renomment (F2) les **labels et fonctions locales** et les **variables locales** (`.@x`, `.x`) **d'un script**, avec toutes leurs
  occurrences connues avec certitude. Sont refusés, avec une explication : fonctions globales et noms de NPC (référencés par d'autres
  fichiers, parfois par chaîne : `callfunc "…"`, `duplicate(…)`, `donpcevent`), variables globales (`$x`, `#x`…), labels d'événement `On…`
  (appelés par le serveur et par d'autres scripts), scripts dont l'analyse est incomplète, noms invalides (lettres, chiffres et `_` ; ni
  nombre, ni mot-clé, ni préfixe `On`) ou déjà pris dans le script.
- Un label nommé comme une commande ou une constante du serveur est refusé au chargement par le serveur (`set_label: invalid label name`)
  mais n'est pas encore détecté ici (voir « Analyse sémantique »).
- Pas d'aperçu des modifications avant application (Monaco applique le renommage ; Ctrl+Z l'annule). Document unique : aucun renommage multi-fichiers.

## Analyse sémantique (`runescript-analysis`)
- **Hercules non vérifié** : les règles (portée des labels, arguments de `callsub`/`menu`, `function X;`, noms de NPC) sont
  prouvées dans le code rAthena local ; leur identité avec Hercules est une hypothèse.
- **Ordre de chargement ignoré par l'index** : le serveur charge les scripts listés par `npc/re/` ou `npc/pre-re/scripts_main.conf`,
  dans l'ordre (un `duplicate` ou un appel de fonction par nom nu exige que la cible soit déjà chargée). L'adaptateur lit désormais ces
  fichiers (M4-S1) mais l'index n'en tient pas compte pour ses diagnostics : il ne dit pas quel doublon le serveur retiendra et les
  signale tous. Indexer un dossier qui contient des variantes exclusives produit de faux doublons (1 070 `RA0005` mesurés sur `npc/`
  complet, 0 sur l'ensemble chargé : choisir la portée « Scripts chargés par le serveur »).
- `RA0004` (fonction non résolue) et `RA0013` (source de `duplicate` absente) ne sont émis que si l'appelant affirme que l'index
  est complet ; l'éditeur ne les affiche pas encore.
- Labels : une étiquette portant le nom d'une constante, d'un paramètre ou d'une commande est refusée par le serveur (`set_label: invalid label
  name`) ; non détecté. Le registre de commandes et le catalogue de constantes existent (M4-S1, M4-S2) mais ne sont pas encore comparés aux labels.
- Fonctions globales : seuls les appels `callfunc "Nom"` à chaîne littérale sont suivis ; les appels par nom nu (`F_Nom arg;`),
  par chaîne dynamique, et les références d'événements par chaîne (`donpcevent "NPC::OnX"`, `addtimer`, `doevent`) ne le sont pas.
- Variables : seules les affectations, `++/--` et le premier argument de `set`/`setarray` sont reconnus comme écritures ; les autres
  commandes qui écrivent dans une variable (`input`, `getarg`, `select`…) pourront l'être grâce aux paramètres de type `r` de la
  table du serveur (non exploités encore).
- Mémoire : ~0,9 octet d'index par octet de source (113 Mo pour 5 046 fichiers) ; non mesurée sur machine modeste.
- La suggestion `RA0007` (label jamais référencé) est désactivée par défaut et sans réglage utilisateur pour l'instant.

## Encodages et fins de ligne
- Un fichier non UTF-8 est supposé en `windows-1252` (configurable par projet) ; si l'hypothèse est fausse, le texte affiché est
  incorrect **mais les octets sont préservés** (vérifié sur 58 fichiers réels). UTF-32 et fichiers binaires ne sont pas ouverts.
- Les encodages multi-octets (Shift_JIS, GBK…) sont gérés par table construite à la volée ; testés sur Shift_JIS uniquement.
- Fichier à EOL mixtes : les lignes **inchangées** gardent leur fin de ligne, les lignes modifiées reprennent celle de la ligne
  remplacée, les nouvelles lignes la plus fréquente (vérifié par propriété et sur 4 fichiers réels).

## Plateformes
- **Linux : construit et testé, jamais lancé** (2026-11-15, DEC-047). Sous Ubuntu 26.04 dans WSL2 (x86_64), l'exécutable se construit (`cargo build --release`, 17 092 344 octets, ELF), `pnpm check` (types, ESLint, tests TypeScript), `cargo clippy --workspace --all-targets -D warnings` et tous les tests Rust passent, dont le remplacement d'un exécutable réellement en cours d'exécution. **Aucune fenêtre n'a été ouverte** : le rendu de WebKitGTK, Monaco, l'IME, le clavier, les hautes résolutions, le démarrage, l'accessibilité et le parcours réel d'une mise à jour dans l'application sont inconnus (`BLOCKED_EXTERNAL` pour un essai sur une machine de bureau Linux).
- **Une distribution, une architecture** : Ubuntu 26.04 sur x86_64. Debian, Fedora, Arch et les machines ARM n'ont pas été essayées ; **aucun AppImage, `.deb` ni `.rpm`** n'est produit (CLAUDE.md §5.1). L'exécutable lie dynamiquement `libwebkit2gtk-4.1`, `libgtk-3`, `libsoup-3.0` et `libssl.so.3` : une distribution qui ne les fournit pas, ou dont la glibc est plus ancienne que celle de la machine de construction, ne le lance pas (construire sur la plus ancienne distribution à prendre en charge : `RELEASE.md`, « Construire pour Linux »).
- L'E2E utilise le protocole de débogage de WebView2 (Windows) et ne tourne pas sous Linux (`scripts/e2e/run-all.mjs` s'arrête avec un message). Il faudrait WebKit WebDriver, `tauri-driver` et un serveur d'affichage virtuel : non installés, le périmètre accordé pour WSL ne les incluait pas.
- **L'E2E Windows dépend du timing** : les étapes qui pilotent la souris (constructeur en nœuds) ou la liste de complétion de Monaco peuvent échouer une fois sur une machine chargée, puis passer à l'exécution suivante. Le 2026-11-15, deux exécutions ont donné 43/44 sur deux étapes différentes (la 1re pendant une compilation Linux, la 2e sur une machine seulement occupée par d'autres applications), puis la 3e 44/44 et 9/9. Aucune étape n'a été assouplie ; avant de conclure à une régression, rejouer l'étape fautive seule (`E2E_ONLY="<fragment du nom>"`) sur une machine au repos.
- **CI** : `.github/workflows/ci.yml` tourne sur GitHub et est verte sur `master` (7 tâches sur `998ff6c`, dont l'E2E Windows et la construction Tauri sous Windows et Ubuntu : `STATUS.md`, « Publication de 0.1.0-beta.1 »). Elle ne lance **aucun essai d'interface sous Linux**.
- Les liens symboliques et jonctions sont **ignorés** par l'explorateur (jamais suivis) ; les chemins UNC et très longs ne sont pas testés.
- La construction `e2e` expose un crochet de test (`window.__RUNEFORGE_E2E__`, variable `RUNEFORGE_E2E_PROJECT`) : elle ne doit
  jamais être distribuée. La version normale n'inclut ni l'un ni l'autre (commande `e2e_project` présente mais renvoie toujours `null`).

## Sécurité (état)
- Les 27 commandes de `src-tauri/src/command_names.rs` sont accordées explicitement dans la capability (test de cohérence).
  Le panneau Git lance le client Git local après activation explicite pour le projet ; l'aperçu SFTP lance le client OpenSSH du système après accord dans une boîte de dialogue native. Voir [`SECURITY.md`](SECURITY.md).
- CSP de production : `script-src 'self'` (pas d'inline, pas d'eval) mais `style-src 'unsafe-inline'` car Monaco injecte des
  styles à l'exécution (DEC-016).
- L'inventaire des licences existe dans [`LEGAL.md`](LEGAL.md) pour la version auditée. Les audits de vulnérabilités exigent un accès réseau.

## Droits et conformité
- Le nom « RuneForge Studio » est un nom de travail (recherche d'antériorité à faire).
- Le produit et ses paquets sont déclarés sous GPL-3.0-only et `LICENSE` contient le texte GPLv3 requis pour la bibliothèque. La revue juridique de distribution, des autres dépendances, de la marque et des notices reste à faire : `BLOCKED_EXTERNAL`.
- La bibliothèque générée inclut le texte d'aide rAthena sous GPL-3.0-only, avec ses références de provenance. Aucun code serveur ni base de données du serveur n'est embarqué ; ils restent lus à l'exécution depuis le projet de l'utilisateur selon les besoins.

## Dépendances externes (non réalisables ici)
- Clés de signature de code Windows/Linux, serveur de licences/paiement : `BLOCKED_EXTERNAL`. Pour les mises à jour, la **clé de signature de production** (`pnpm release:keygen`) et la **première release réelle** sont des actions du propriétaire ; il n'y a pas de serveur de mises à jour (GitHub héberge les releases).
- Validation sur un vrai serveur de test isolé, modèle IA réel (DGX Spark/vLLM) : `BLOCKED_EXTERNAL` sauf accord explicite
  de l'utilisateur d'exécuter son serveur/modèle (un `map-server.exe` compilé est présent dans le dépôt mais n'a **pas** été lancé).

## Livraison, accessibilité et vie privée (M5)

- **Pas d'installateur ni de signature de code** : l'application se lance depuis l'exécutable seul (`tauri build --no-bundle`). Les deux sont `BLOCKED_EXTERNAL` (outils de paquetage téléchargés, certificats). La **mise à jour depuis une release GitHub** existe (DEC-046 et DEC-047, Windows et Linux) : voir « Mises à jour signées » plus bas. Linux : un AppImage se construit (`pnpm build:linux`, DEC-048 : lancé 20 s sous WSLg, rien d'autre vérifié ; **glibc ≥ 2.43 exigée** parce que construit sous Ubuntu 26.04 ; **LGPL redistribuée à examiner** ; mise à jour en place d'un AppImage jamais essayée) ; ni `.deb`, ni `.rpm`, ni E2E graphique.
- **Accessibilité** : l'arbre d'accessibilité, les contrastes (texte), le clavier et les dialogues sont audités de façon automatisée ; **aucun lecteur d'écran n'a été utilisé**, et le contraste des éléments non textuels, le zoom à 200 %, le mode contraste élevé de Windows et la saisie par IME ne sont pas audités
  ([`ACCESSIBILITY.md`](ACCESSIBILITY.md)).
- **Journal de diagnostic local** (Paramètres › Confidentialité, désactivé par défaut). Il consigne les événements autorisés par Rust, dont les résultats d'indexation et de déploiement, sans contenu utilisateur. Il n'est ni exportable ni consultable depuis l'application (le fichier `logs/runeforge.log` du dossier de données locales se lit avec un éditeur de
  texte), ne couvre pas les plantages du processus natif (aucun gestionnaire de panique n'écrit dedans), et la rotation garde une seule génération précédente de 512 Kio au plus (DEC-037).
- **Démarrage mesuré sur la variante E2E**, un petit projet et une seule machine, cache du système chaud (voir [`PERFORMANCE.md`](PERFORMANCE.md)).
- **Licences** : inventaire fait pour la cible Windows ; le paquet de notices tiers (textes de licence), la confirmation de la licence de la police `codicon.ttf` et la revue juridique restent à faire ([`LEGAL.md`](LEGAL.md)). Les audits de vulnérabilités (`pnpm audit`, `cargo audit`) exigent le réseau : non exécutés.

## Assistants de NPC (M6-S1, RF-017)

- **Quatre assistants** (portail de téléportation, PNJ téléporteur, boutique, soigneur), **vérifiés pour rAthena seulement** : pour un projet Hercules la boîte de dialogue l'explique au lieu d'offrir un formulaire (aucun script inventé).
- Les scripts produits sont vérifiés **statiquement** (registre de commandes et bases d'un vrai serveur : 1 600 scripts, aucun diagnostic) ; **aucun n'a été chargé par un serveur** (le serveur de jeu n'est jamais lancé).
- Les textes proposés sont en **anglais ASCII** : l'encodage des textes dans le jeu dépend du serveur et du client, que l'application ne connaît pas. La saisie n'impose qu'une ligne, sans tabulation, de longueur bornée.
- Les coordonnées sont bornées (0 à 511) mais **pas comparées à la taille ni aux cases praticables de la carte** ; une carte de destination absente des bases ou non chargée est signalée par l'analyse locale (`RA0008`, `RA0015`), pas par le formulaire.
- Les **identifiants d'objets d'une boutique ne sont pas confrontés à la base d'objets** (`RA0009` ne couvre que les arguments de commandes) ; le sprite n'est confronté à aucune base ; l'unicité du nom du NPC n'est vérifiée qu'une fois le script dans le projet (vérifications entre fichiers).
- **« Ajouter au fichier ouvert » ajoute à la fin du fichier**, jamais à la position du curseur ; la saisie du formulaire n'est conservée que tant que la boîte de dialogue est ouverte.
- **« Créer le fichier »** crée tout de suite un fichier **vide** sur le disque (comme « Nouveau fichier ») et y place le script **sans l'enregistrer** (Ctrl+S). Un script n'est chargé par le serveur que si un fichier `scripts_*.conf` le cite : l'application ne modifie jamais ces fichiers (le panneau des problèmes le dit par `RA0016` quand un appel dépend de l'ordre).
- L'annulation de l'ajout par Ctrl+Z, l'affichage du script ajouté et le comportement de Monaco ne sont vérifiés que par l'E2E (Monaco ne s'exécute pas dans les tests de composants).

## Git et déploiement local (M6)

- Le panneau Git exige un client Git installé et une activation explicite pour le projet. Il compare les fichiers à `HEAD` et affiche les changements de l'index et du dossier de travail. Les opérations d'écriture Git et les commandes réseau sont hors périmètre.
- Le déploiement copie les versions enregistrées de scripts vers un dossier local choisi, à raison de 2 000 fichiers au maximum par plan. Une sauvegarde précède chaque remplacement. La restauration vise les fichiers remplacés du dernier déploiement et conserve les fichiers nouvellement créés. Si un fichier a changé depuis le déploiement, sa restauration est refusée.
- Pour charger les scripts copiés, l'opérateur doit gérer séparément les listes `scripts_*.conf` et le rechargement sur son serveur. Le **transfert** par SSH/SFTP reste à implémenter : seul l'aperçu en lecture seule décrit ci-dessous existe.

## Aperçu SFTP en lecture seule (M6)

**Fichier › Aperçu SFTP…** compare des scripts **enregistrés** avec un dossier distant. Code : `crates/remote-transport`, `apps/desktop/src-tauri/src/sftp.rs` (commande `sftp_dry_run`), `SftpDialog.tsx`. Mesures de sécurité : [`SECURITY.md`](SECURITY.md) (« Aperçu SFTP »).

- **Lecture seule** : aucun transfert, aucune sauvegarde, aucun rechargement, aucune commande distante. Le client n'émet que des requêtes de lecture (ouverture en lecture seule, lecture, fermeture, `LSTAT`, `FSTAT`, `REALPATH`). Le résultat par fichier est *Identique*, *Différent* ou *Absent à distance* (taille et SHA-256 comparés) ; le texte non enregistré n'est pas comparé.
- **Client OpenSSH du système requis** : `%SystemRoot%\System32\OpenSSH\ssh.exe` sous Windows, `/usr/bin/ssh` ou `/bin/ssh` ailleurs ; sans lui, l'aperçu échoue (`unavailable`). Sa présence n'est pas contrôlée avant l'appui sur « Comparer ».
- **Authentification par clé publique via l'agent SSH seulement** (`SSH_AUTH_SOCK`) : ni mot de passe, ni fichier d'identité, ni `ProxyCommand`/`ProxyJump`, ni redirection. L'agent de l'utilisateur doit donc être démarré et porter une clé acceptée par le serveur.
- **Clé d'hôte `ssh-ed25519` épinglée, saisie à la main** : l'application ne la découvre ni ne la vérifie ; la protection contre un hôte usurpé vaut ce que vaut le canal par lequel l'utilisateur l'a obtenue. Une clé d'un autre type (RSA, ECDSA) est refusée.
- **Accord par boîte de dialogue native** pour la destination exacte (utilisateur, hôte, port, dossier, empreinte SHA-256 de la clé) avant toute connexion ; un refus donne `cancelled`.
- **Bornes** : 1 à 100 chemins `.txt` relatifs au projet (jamais `.runeforge`), 4 Mio par fichier et 16 Mio au total — les fichiers locaux sont lus et hachés **avant** tout accès réseau —, dossier distant absolu en ASCII, 30 secondes au plus (le processus est alors tué), une seule comparaison à la fois (`busy`). Un composant du chemin distant qui n'est pas un dossier (lien symbolique compris), un chemin que `REALPATH` ne rend pas à l'identique et un fichier qui change pendant sa lecture sont refusés.
- **Rien n'est mémorisé** : hôte, utilisateur, clé d'hôte, dossier et chemins vivent dans le dialogue et disparaissent à sa fermeture (ni réglages, ni journal).
- **Jamais essayé contre un vrai serveur** : les 6 tests Rust et les 5 tests TypeScript font tourner le client sur des flux en mémoire et vérifient la ligne de commande construite ; il n'y a pas d'étape E2E, ni d'essai sous Linux. Le comportement avec une version donnée d'OpenSSH ou d'un serveur SFTP n'est pas connu. Considérez la fonction comme **précoce**.

## Éditeur visuel de dialogues (M7)

- L'éditeur travaille sur un NPC à corps fermé dans le fichier courant. Il représente les appels `mes` avec une chaîne, `next`, `close` et les branches `if` avec accolades. Les autres instructions sont des blocs verrouillés conservés tels quels.
- Certaines opérations structurelles exigent qu'un bloc occupe sa propre ligne. Un commentaire en fin de ligne survit à la suppression du bloc. La suppression d'un bloc qui contient un commentaire et la réécriture d'une condition commentée passent par l'éditeur de code.
- Un document qui a changé depuis l'ouverture du dialogue doit être rouvert avant d'appliquer des changements. L'enregistrement reste une action séparée.
- L'édition par blocs couvre les dialogues. L'import de flux plus complexes (boucles, `select`, `goto`) reste à réaliser : l'éditeur visuel de dialogues ne montre pas encore le script d'un NPC existant comme un graphe modifiable.

## Constructeur de NPC en nœuds (M7-S2)

- Le graphe sert à **créer** un NPC dans un nouveau fichier ; il ne se relit pas depuis un script existant. Les positions des nœuds ne sont pas enregistrées avec le script : elles ne vivent que le temps du dialogue, qui ne garde rien à sa fermeture.
- Seul le flux structuré s'écrit : `if`/`else` dont les branches se rejoignent ou se terminent chacune par `close`/`end`. Pas de boucle (refusée dès le fil), pas de `goto`, de label, de `select`/`menu` à plusieurs sorties ni de `switch`. Deux branches qui ne se rejoignent pas mais mènent à un même nœud sont refusées (« partagé ») plutôt que dupliquées ; une sortie anticipée (une branche finit par `close`, l'autre continue) s'écrit avec la suite dans la branche qui continue.
- Pas d'annulation ni de rétablissement dans le dialogue, pas de zoom, pas de sélection multiple ni de déplacement de plusieurs nœuds ; le canevas défile. L'agencement automatique (« Ranger le canevas ») estime la hauteur des nœuds : un nœud aux arguments nombreux peut en recouvrir un autre jusqu'à ce qu'on le déplace.
- Les fils se tirent à la souris, au stylet ou au doigt par les événements du pointeur ; la souris est la seule entrée vérifiée dans l'application réelle (E2E WebView2). La variante clavier (activer une sortie puis une entrée) est vérifiée par des tests de composants, pas par un essai au lecteur d'écran.
- Le canevas est sombre dans les deux thèmes (comme un éditeur de nœuds) ; son contraste de texte est audité, pas celui des éléments non textuels (fils, prises).

## Simulation de dialogue (M8-S1b, M8-S1c)

La simulation est un aperçu local, pas le serveur (CLAUDE.md §12.1). Rien n'est lu ni écrit hors de la mémoire de la session (les fichiers des autres NPC et fonctions sont seulement lus, par le service de fichiers du projet) ; aucun serveur n'est lancé. Voir DEC-043 et DEC-044.

- **La simulation ne s'arrête plus sur une erreur : elle la note et continue.** Une opération que le serveur refuserait (division par zéro, `getarg` sans l'argument, label ou sous-programme introuvable, `return` hors d'un appel, texte mêlé à un nombre, solde de Zeny négatif, `delitem` de trop...) devient une ligne **« Opération invalide »** à sa place, avec sa raison et une valeur de repli (0, indice borné, calcul sur les nombres que les textes représentent) ; une syntaxe que la simulation ne sait pas calculer devient « Non simulé ». **Sur le serveur, le script s'arrêterait là** : ce qui suit un écart est le déroulé du simulateur, pas celui du serveur. `return` hors d'un appel, un label introuvable et un menu sans option (`select("")`, où le joueur ne peut qu'annuler) terminent le script. Seules les limites de ressources interrompent encore une partie (200 000 pas, 100 000 caractères de texte, 40 appels imbriqués, 64 options de menu, 20 000 éléments de variables), par un message d'état qui cite l'instruction atteinte : une boucle sans fin ne peut pas être « continuée ».
- **Un défaut du simulateur lui-même** ne s'échappe jamais vers l'application : il est noté « Problème du simulateur » et termine le script. Le rapport sur corpus le compte comme défaut ; aucun n'a été observé (corpus réel et 196 648 parties sur des scripts abîmés au hasard).
- **Une partie menée à son terme ne prouve pas que le NPC fonctionne.** Une instruction inconnue est sautée (« Non simulé ») et une fonction inconnue vaut 0 (« Résultat supposé ») ; si la suite du script dépend de leur effet (une fonction globale qui termine le script, un `warp` qui change de carte), le déroulé peut s'écarter du serveur. Les lignes « Non simulé » et « Résultat supposé » de la transcription sont la liste de ce qui n'a pas été calculé.
- **Fonctions d'un autre fichier** : `callfunc "F_Nom"` exécute les fonctions du fichier du NPC et celles que l'index du projet connaît (recherche par nom, lecture du fichier — le texte non enregistré d'un onglet ouvert, sinon le disque —, puis de proche en proche celles que ces fonctions appellent ; 150 recherches au plus par simulation). **Ne sont pas résolues** : un nom calculé (`callfunc .@nom$`), une fonction que l'index ne contient pas (fichier non indexé, hors de la portée d'index choisie, ou pendant que l'indexation n'est pas terminée), un fichier de plus de 8 Mio ; l'appel est alors noté « Non simulé » ou « Résultat supposé ». Deux fonctions de même nom : la première trouvée par l'index. Les extraits de la transcription citent le fichier de la fonction exécutée.
- **Valeurs de texte supposées** : une fonction inconnue vaut 0 ; comparée à un texte ou mêlée à un texte, elle prend le type de l'autre opérande **sans reproche au script** (`instance_live_info(ILI_NAME) == "Villa"` vaut faux au lieu de s'arrêter). Mais `mes fonction_inconnue()` affiche 0 et un `switch (fonction_inconnue())` ne correspond à aucun `case` de texte. Le champ « Résultats supposés des fonctions » permet d'imposer une chaîne.
- **NPC avec erreurs de syntaxe, corps non fermé, fichier volumineux** : le dialogue joue le NPC (l'analyseur est tolérant), ce qu'il n'a pas compris est noté « Non simulé » et la fenêtre annonce le nombre de problèmes de syntaxe ; le déroulé peut s'écarter fortement du serveur. Un fichier de plus de 4 Mi caractères n'est pas simulé (le plus gros script du serveur de référence en compte 0,66 million) ; un fichier sans NPC à script n'a rien à simuler.
- **Quêtes** : seul l'état (−1 à 2) est modélisé ; `checkquest(id, HUNTING)` et `PLAYTIME` en déduisent leur valeur (absente −1, terminée 2, sinon 0) sans compter les monstres ni le temps.
- **Classe du personnage de test** : la liste (153 classes) vient de `job_name()` et de `map_msg.conf` du serveur de référence `rathena-kov` ; les noms sont ceux du serveur, **en anglais dans les deux langues** (« Swordsman », « Magician », « High Novice », « Rune Knight T » : le `T` est le suffixe du serveur pour la version transcendée). Une monture ou un costume qui porte le même nom qu'une classe (`JOB_KNIGHT2`, `JOB_SUMMER2`…) n'a pas de ligne : on garde le plus petit identifiant. Un identifiant que `job_name()` ne nomme pas (classe ajoutée par un fork sans toucher à cette fonction) ne se choisit plus ; la liste se régénère avec `generate-script-constants.ts`, qui lit `Serveur/rathena-kov`. `jobname()` n'est pas simulée (valeur supposée 0).
- **Personnage** : sans groupe, guilde, partenaire, monture ni équipement ; le poids des objets n'est pas calculé (`checkweight` = 1) ; `BaseClass` et `BaseJob` ne sont déduits que pour la lignée classique, les classes évoluées et les bébés ; `readparam(<nombre>)` n'est pas résolu (`readparam(BaseLevel)` l'est). Une variable du contexte remplace le défaut du paramètre du même nom.
- **Variables d'autres NPC** : `getvariableofnpc(.x, "Autre")` lit et écrit un espace de noms à part, vide au départ (le `OnInit` des autres NPC n'est pas exécuté).
- **Événements** : seul le déroulé d'un clic sur le NPC est joué (plus son `OnInit`). `OnTimer`, `OnTouch`, `OnTalk`, `donpcevent` et les minuteries ne sont pas déclenchés.
- **Sémantique de référence** : une affectation utilisée comme valeur (`.@t = (.@a += 10)`) renvoie la valeur au moment du calcul, alors que le serveur renvoie une référence relue plus tard ; un label placé dans une boucle ou un `switch` ne peut pas être la cible d'un `goto` ; `callfunc` retrouve ses fonctions sans tenir compte de la casse (le serveur, avec).
- **Constantes** : 31 des 10 264 constantes exportées n'ont pas de valeur établie (dont les `ITEMJ_*`, `DROPEFFECT_*`, `GUILD_PERM_*`) ; elles se lisent comme des variables à 0. Les noms d'objets (`Red_Potion`) ne sont des constantes que si l'appelant fournit le catalogue : sans lui, l'inventaire de test les distingue des identifiants numériques.
- **Hercules** : la simulation est refusée pour le profil Hercules (adaptateur `BLOCKED_EXTERNAL`).
- **Non couvert** : aucun essai avec un lecteur d'écran (l'étape E2E et l'audit d'accessibilité WebView2 couvrent la fenêtre depuis le 2026-11-14).

## Mises à jour signées (DEC-046)

Procédure : [`RELEASE.md`](RELEASE.md) · garde-fous : [`SECURITY.md`](SECURITY.md) (« Mises à jour signées »).

- **La clé de signature de production et une première release existent** (0.1.0-beta.1, publiée le 2026-11-15 ; la clé publique est dans `apps/desktop/src-tauri/update-public-key.txt` et embarquée). **Aucune mise à jour n'a pourtant encore été installée depuis une vraie release** : cela exige une seconde release. Les exemplaires construits avant l'intégration de la clé (`UNCONFIGURED`) répondent « cette version ne peut pas vérifier les mises à jour » (`not_configured`) et doivent être réinstallés à la main une fois. Le canal par défaut est « stables seulement » : une bêta ne reçoit la bêta suivante qu'avec « Versions stables et bêta ».
- **Le TLS réel vers `api.github.com`, les redirections de téléchargement d'un dépôt privé, les limites de débit de GitHub et le comportement d'un antivirus n'ont jamais été exercés** : tout est testé contre un faux GitHub en mémoire, un serveur HTTP local (`tests/http.rs`) et l'E2E sur un faux serveur de releases local (`http://127.0.0.1`). Un premier contrôle avec une vraie release est à faire avant de compter dessus (`RELEASE.md`, § 4).
- **Windows et Linux seulement** (DEC-047) : sur tout autre système (macOS, FreeBSD…) l'installation est refusée (`unsupported_platform`), rien n'est téléchargé et le menu l'indique. Le dossier de l'application doit être modifiable par l'utilisateur (un exécutable dans `C:\Program Files`, ou dans `/usr/local/bin` sans droits d'écriture, ne se met pas à jour : `not_writable`). Pas d'installateur ni de paquet : l'application est l'exécutable seul.
- **Linux, ce qui est vérifié et ce qui ne l'est pas** : le remplacement atomique (un seul `rename` au-dessus de l'exécutable en cours d'exécution, droits de l'ancien fichier recopiés, `.old` conservé), le contrôle ELF après le SHA-256, l'outillage de release pour deux plateformes et le client HTTP/TLS (OpenSSL du système) compilent et passent leurs tests sous Ubuntu 26.04 (WSL2) ; **aucune mise à jour n'a été déroulée dans l'application sous Linux** (pas de fenêtre, pas d'E2E). GitHub ne conserve pas le bit d'exécution : à la première installation à la main, `chmod +x` ; les mises à jour suivantes recopient les droits du fichier remplacé. Le client TLS lit le magasin de certificats du système (`ca-certificates`) : sans lui, GitHub n'est pas joignable. Sous AppImage (non fourni), c'est le fichier `$APPIMAGE` qui serait remplacé : code présent, jamais essayé.
- **Jamais automatique** : l'utilisateur lance chaque contrôle ; il n'y a ni vérification au démarrage, ni notification, ni installation en arrière-plan (CLAUDE.md §0 n° 8).
- **Dépôt privé** : l'utilisateur doit saisir un jeton GitHub à granularité fine (lecture du contenu) à chaque lancement de l'application (il n'est jamais enregistré ; le stockage sécurisé du système exigerait une dépendance de plus). **Un tel jeton lit aussi le code source du dépôt** : pour l'éviter, publier les releases dans un dépôt distinct (`RELEASE.md`, § 2).
- **Deux plateformes, une architecture** : chaque exemplaire lit dans le manifeste l'entrée de **sa** plateforme (`windows-x86_64`, `linux-x86_64`) ; une release qui ne la porte pas est signalée (`no_platform_asset`), une autre architecture (ARM) n'a pas d'exécutable. Pas de mise à jour différentielle (l'exécutable est téléchargé en entier, jusqu'à 256 Mio), pas de reprise d'un téléchargement interrompu, pas de limitation de débit.
- **Pas de signature de code Windows** (`BLOCKED_EXTERNAL`) : seule la signature du manifeste garantit l'exécutable. SmartScreen peut avertir au premier lancement d'un exécutable téléchargé à la main.
- **Clé de signature** : un seul signataire, pas de rotation prévue. Changer ou perdre la clé coupe les mises à jour de tous les exemplaires déjà distribués (`RELEASE.md`, § 6).
- **Aucun retour en arrière** (jamais de version plus ancienne) et **pas de version minimale imposée côté application** : une release peut en déclarer une (`minimumVersion`), alors les versions plus anciennes sont invitées à s'installer d'abord à la main.
- **Notes de version** en texte brut, 8 Kio au plus, sans mise en forme ni traduction (une seule langue par release).
- **Si le retour arrière échoue** (Windows, cas extrême : deux renommages de suite refusés), l'ancienne version reste à côté de l'application avec l'extension `.old` et l'application le dit ; il faut la renommer à la main. Sous Linux il n'y a qu'un renommage atomique : l'application n'est jamais absente, et l'ancienne version reste en `.old` (lien dur, sinon copie) jusqu'au lancement de la suivante.
- **Vérifications non couvertes** : la seconde vérification des modifications non enregistrées (après le téléchargement) n'a pas de test automatisé ; un essai avec un lecteur d'écran n'a pas eu lieu (voir `ACCESSIBILITY.md`).
