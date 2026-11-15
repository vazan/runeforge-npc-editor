# Spécification du langage — ce qui est réellement supporté

> Ce document décrit **uniquement le comportement implémenté** (CLAUDE.md §19.4), pas la grammaire idéale.
> Les règles sont **dérivées du code du serveur rAthena local** (`Serveur/rathena-kov/src/map/script.cpp`, `npc.cpp`),
> puis vérifiées sur ~2 300 scripts réels. **Hercules n'a pas été vérifié** : toute règle ci-dessous est supposée
> identique pour lui, sans preuve (voir [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) et DEC-005).
> Dernière mise à jour : 2026-11-05 (M2-S1).

Implémentation : `packages/runescript-core` (lexer, diagnostics) · `packages/runescript-parser` (parseur, AST) ·
`packages/runescript-analysis` (sémantique). Tests : fichiers `*.test.ts` de chacun.

## Garanties

- **Total** : toute chaîne, y compris invalide, produit des tokens, un AST et des diagnostics ; aucune exception.
- **Sans perte** : les tokens sont contigus et leur concaténation redonne exactement le texte source (tabulations,
  CRLF/LF/CR, commentaires, caractères inconnus). L'AST ne sert qu'à l'analyse, le texte n'est jamais régénéré depuis lui.
- **Déterministe et pur** : aucune exécution, aucun accès au système, aucun réseau.
- **Offsets** : code units UTF-16, base 0, fin exclue, texte sans BOM (DEC-004). Ce sont aussi ceux de Monaco.
- **Limites** : profondeur d'imbrication 200 (`RS0050`, le reste de la déclaration n'est pas analysé), 1 000 diagnostics.
- **Mesuré** : 0 plantage, 0 perte de texte sur 2 303 fichiers réels ; ~24 Mo/s (analyse sémantique : ~150 Mo/s en plus).

## Lexer (`runescript-core/src/lexer.ts`)

| Kind | Reconnaît | Trivia |
|---|---|---|
| `Spaces` | suite d'espaces, `\v`, `\f` | oui |
| `Tabs` | suite de tabulations (séparateurs des déclarations de premier niveau) | oui |
| `Newline` | `\n`, `\r\n` ou `\r` | oui |
| `LineComment` | `//` jusqu'à la fin de ligne | oui |
| `BlockComment` | `/* … */` ; non fermé → jusqu'à la fin du texte (`RS0002`) | oui |
| `String` | `"…"` ; `\` échappe le caractère suivant ; non fermée → s'arrête **avant** la fin de ligne (`RS0001`) | non |
| `Number` | mot **entièrement** décimal, ou `0x` + chiffres hexadécimaux | non |
| `Identifier` | mot `[A-Za-z0-9_]+` non numérique ; **peut commencer par un chiffre** (`4_DR_KID_01`) | non |
| `Variable` | préfixe `.@` `.` `@` `$@` `$` `##` `#` `'` + nom (`[A-Za-z0-9_]+`, peut commencer par un chiffre : `$2011_agit_invest`) + `$` facultatif ; ou un mot suivi de `$` (`name$`, chaîne permanente de personnage) | non |
| `Operator` | `<<=` `>>=` ; `== != <= >= && \|\| << >> ++ -- += -= *= /= %= &= \|= ^= ~=` ; `+ - * / % = < > ! & \| ^ ~ ?` | non |
| `Punctuation` | `{ } ( ) [ ] ; , :` | non |
| `Unknown` | tout autre caractère (un code point entier) | non |

Les identifiants, labels et noms de variables sont **insensibles à la casse** (`strcasecmp` dans `script.cpp`).

## Parseur (`runescript-parser`)

### Déclarations de premier niveau
Les champs d'en-tête sont séparés par des **tabulations** (plusieurs tabulations consécutives = un séparateur) ; les noms
peuvent contenir des espaces. Chaque valeur garde sa plage source exacte.

| Forme | Nœud AST | Remarques |
|---|---|---|
| `carte,x,y,dir⇥script⇥Nom⇥sprite{,tx,ty},{ … }` | `NpcDeclaration` | `script(CLOAKED)` accepté ; `-` à la place de la position = NPC flottant |
| `function⇥script⇥Nom⇥{ … }` | `FunctionDeclaration` | fonction globale, appelée par `callfunc "Nom"` |
| `carte,x,y,dir⇥duplicate(cible)⇥Nom⇥sprite…` | `DuplicateDeclaration` | |
| `carte,x,y{,dir}⇥warp⇥Nom⇥sx,sy,carte,x,y` (`warp2`) | `WarpDeclaration` | la direction est **facultative** : le serveur ne lit que `carte,x,y` d'un warp (`npc_parse_warp`) alors que `script`, `shop` et `duplicate` en exigent quatre valeurs (`RS0036` sinon) |
| `…⇥shop⇥Nom⇥sprite,objet:prix,…` (`cashshop`, `itemshop`, `pointshop`, `marketshop`) | `ShopDeclaration` | |
| `…⇥monster⇥Nom⇥id,nombre,…` (`boss_monster`) | `MonsterDeclaration` | |
| `carte⇥mapflag⇥drapeau{⇥valeur}` | `MapflagDeclaration` | |
| tout autre type | `RawDeclaration` | conservé tel quel, `RS0031` (avertissement, confiance inconnue) |

Nom de NPC : `<Affiché>{::<Unique>}` ; le **nom unique** est la partie après `::`, sinon le nom complet (clé d'identification
du serveur). Une carte peut commencer par un chiffre ou contenir `@` (instances).
Reprise d'erreur au premier niveau : une nouvelle déclaration est reconnue à son en-tête, donc une erreur ne contamine
pas les déclarations suivantes.

### Instructions et expressions
- Instructions : bloc `{ }`, `if/else` (chaînes `else if` itératives), `while`, `do…while`, `for`, `switch/case/default`,
  `break`, `continue`, `return`, `goto`, label `Nom:`, `function Nom;` (déclaration locale) et `function Nom { … }`
  (définition locale), commande `nom arg, arg;` ou `nom(arg, arg);`, expression-instruction. Le `;` manquant est signalé
  (`RS0020`) mais la lecture continue (comme le serveur, qui saute le caractère après une affectation sans le vérifier).
- La condition d'un `if`/`while` est une **expression complète** : `if (a) && (b) instr;` est valide.
- `cmd (x)` : la parenthèse est une parenthèse d'**expression** sauf si une virgule suit la première valeur
  (`cmd (a), b` ; reproduit la logique `ARGLIST_UNDEFINED` du serveur).
- `menu "A",-,"B",Label;` : le `-` est un `Placeholder` (suite au label suivant), pas un opérateur.
- Expressions : priorités calquées sur C — `||`(3) `&&`(4) `|`(5) `^`(6) `&`(7) `== !=`(8) `< <= > >=`(9) `<< >>`(10)
  `+ -`(11) `* / %`(12) ; ternaire, affectations (`= += -= *= /= %= &= |= ^= ~= <<= >>=`), préfixes `! ~ - +`,
  `++/--`, appels `f(x)`, indices `x[i]`. Les écarts éventuels avec le serveur ne sont pas tous vérifiés.
- Tout fragment illisible devient `RawStatement` / `ErrorExpression` / `RawDeclaration` (jamais supprimé).

### Variables (préfixe → portée)
`.@x` script (locale à l'exécution du script ou de la fonction) · `.x` NPC (ou fonction) · `@x` personnage temporaire ·
`x` personnage permanent · `$@x` serveur temporaire · `$x` serveur permanent · `#x` compte (local) · `##x` compte (global) ·
`'x` instance. Le suffixe `$` marque une chaîne : `.@x` et `.@x$` sont **deux variables distinctes** (le suffixe fait partie du nom).

## Analyse sémantique (`runescript-analysis`, M2)

Entrée : un `ParseResult`. Sortie : `FileAnalysis` (données simples, sérialisables, transmissibles d'un Worker) et un
`WorkspaceIndex` pour les vérifications entre fichiers. Aucune lecture de fichier, aucun effet de bord.

### Portées (vérifié dans `script.cpp`)
- **Un script = un espace de noms de labels.** Chaque corps de NPC ou de fonction globale est analysé séparément ;
  le serveur réinitialise ses références de labels à chaque `parse_script`.
- **Labels et fonctions locales partagent le même espace de noms** (`set_label` les enregistre dans la même table),
  insensible à la casse. Les labels sont reconnus à tout niveau d'imbrication (dans `if`, `switch`…). Le corps d'une
  fonction locale partage l'espace de noms du script qui la contient.
- Les labels `On…` (insensible à la casse) sont des **événements** exportés par le serveur (`npc.cpp`) : jamais signalés comme inutilisés.
- Variables : `.@` et `.` sont tenues par script ; `@ $ $@ # ## '` et les permanentes sont agrégées par fichier.
  Une écriture n'est reconnue que pour l'affectation, `++/--` et le premier argument de `set`/`setarray`
  (les autres commandes qui écrivent dans une variable exigent le registre de commandes, M4).

### Références reconnues
| Source | Cible |
|---|---|
| `goto L;` | label du script |
| `callsub L, …;` ou `callsub(L, …)` | label ou fonction locale (identifiant ; une chaîne ou une variable est ignorée) |
| `menu "t", L, "t", L;` | labels aux positions impaires ; `-` ignoré |
| `jump_zero(cond, L)` | label |
| `Nom args;` / `Nom(args)` | fonction locale `Nom` (le serveur la traduit en `callsub`) |
| `callfunc "Nom"` / `callfunc("Nom")` | fonction **globale** (chaîne littérale seulement) |
| `duplicate(Nom)` (en-tête) | NPC source |

### Diagnostics sémantiques implémentés
| Code | Sévérité · confiance | Condition | Preuve |
|---|---|---|---|
| `RA0002` | erreur · probable | `goto`/`callsub`/`menu`/`jump_zero` vers un label absent du script | `buildin_goto`, `buildin_callsub`, `buildin_menu` exigent un label |
| `RA0003` | erreur · certaine | label ou fonction locale défini deux fois dans un script (casse ignorée) | `set_label: dup label` |
| `RA0012` | erreur · certaine | `function X;` jamais définie dans le script | `parse_script: function declared but not defined` (le script n'est pas chargé) |
| `RA0007` | info · certaine | label non-événement jamais référencé (désactivé par défaut : `styleHints`) | — |
| `RA0011` | avertissement · probable | fonction globale définie plusieurs fois (**nom exact, sensible à la casse**) | `npc_parse_function: Overwriting user function` |
| `RA0005` | avertissement · probable | nom unique de NPC identique (**sensible à la casse**, tronqué à 50 caractères) ; scripts, warps, boutiques, duplicates | `npc_parsename: Duplicate unique name … Renaming` |
| `RA0004` | info · inconnue | `callfunc "X"` sans définition de `X` dans l'index (seulement si l'index est complet) | `buildin_callfunc: Function not found!` (erreur d'exécution) |
| `RA0013` | avertissement · probable | `duplicate(X)` dont `X` est absent de l'index (seulement si l'index est complet) | `npc_parse_duplicate: original npc not found` |
| `RA0014` | erreur · probable | label ou fonction locale dont le nom est une **commande de la table du serveur** (ni le manuel seul, ni le projet, ni une commande compilée sous condition), une **constante ou un paramètre lus dans le serveur** (ni ceux du projet) ; casse ignorée | `set_label: invalid label name` (`script.cpp`) |
| `RA0015` | info · probable | déclaration (script, warp, boutique, monstres, duplicate) sur une carte **de l'index que le serveur ne charge pas** (absente des `map:` de `conf/map_athena.conf` et de ses imports) ; jamais pour une ligne `mapflag` ni une destination de warp ; gravité réglable (`validation.unknownReferences`) | `npc_parsesrcfile` (`npc.cpp`) ignore la ligne **sans aucun message** |
| `RA0016` | erreur · probable | appel **par son nom** (`Nom arg;`, `Nom(arg)`) d'une fonction globale définie dans le projet mais **pas encore connue du serveur à cet endroit** : définie dans un fichier chargé après l'appelant ou que le serveur ne charge pas, plus bas dans le même fichier, ou dans l'appelant lui-même (récursion) ; `callfunc "Nom"` n'est pas concerné ; seulement quand l'ordre des scripts du serveur est connu ; se coupe avec `validation.unknownCommands: off` | `parse_callfunc` (`script.cpp`) : « calling undeclared function » ; `npc_parse_function` (`npc.cpp`) enregistre la fonction **après** l'analyse de son corps |

Prudence : la vérification des labels est **désactivée** pour un script dont l'analyse est incomplète (région brute, bloc non
fermé, profondeur dépassée) — une définition a pu échapper à l'analyse. `RA0004`/`RA0013` ne sont émis que si l'appelant
déclare que l'index couvre tous les fichiers chargés par le serveur.

**Ordre de chargement** : le serveur charge les scripts listés par `npc/<mode>/scripts_main.conf` (`npc:` / `import:`),
`re/` en mode renouvelé (`#define RENEWAL`), `pre-re/` sinon. Indexer tout `npc/` mélange des variantes exclusives (1 070 faux doublons
`RA0005` mesurés) ; l'ensemble réellement chargé n'en produit aucun. L'adaptateur rAthena lit ces fichiers (voir « Registre de commandes et
règles de chargement » ci-dessous) ; l'index lui-même ne connaît pas l'ordre.

## Service de langage (M3) — ce qui est proposé

Implémentation : `packages/runescript-language-server` (forme LSP : positions `{ligne, colonne}` en base 0, UTF-16).

- **Définition** (F12, Ctrl+clic), **références** (Maj+F12), **plan du document** (Ctrl+Maj+O), **symboles du projet** (Ctrl+T) :
  labels et fonctions locales (dans leur script), fonctions globales (`callfunc "…"` et appels par nom nu si la fonction est indexée),
  noms de NPC (`duplicate(…)`), variables (`.@`/`.` dans leur script, globales dans le fichier).
- **Complétion** — le contexte est déduit du **texte de la ligne et des deux précédentes**, pas de l'AST (le code en cours de frappe est
  presque toujours invalide) :

  | Position du curseur | Propositions |
  |---|---|
  | argument de `goto` ou `callsub` (aussi dans une expression, ou après `if (…)` / `else`), arguments de rang impair de `menu`, 2e argument de `jump_zero` | labels, événements `On…` et fonctions locales **du script courant** |
  | dans `callfunc "…"` (commande ou fonction, même si la chaîne est sur la ligne suivante) | fonctions globales de l'index (filtre tolérant, 200 au plus) ; le remplacement va jusqu'au guillemet fermant |
  | dans l'en-tête `duplicate(…)` | noms uniques de NPC de l'index (200 au plus) |
  | fragment commençant par `.@` `.` `@` `$` `$@` `#` `##` `'` | variables du script et variables globales du fichier ; la variable en cours de saisie ne se propose pas elle-même |
  | début d'instruction, dans le corps d'un script ; mot en cours de saisie, ou rien après Ctrl+Espace | **commandes** du registre du serveur, fonctions locales du script et mots-clés (`if`, `else`, `for`, `while`, `do`, `switch`, `case`, `default`, `break`, `continue`, `function`) — voir ci-dessous |
  | opérande d'une expression (`set .@x, get…`), dans le corps d'un script | commandes du registre, **sans** mots-clés |
  | début de ligne **hors d'un script**, mot de la forme `npc-…` | modèles de NPC (voir ci-dessous) |
  | argument d'une commande dont le manuel le nomme objet, monstre ou carte (`getitem <item id>`, `monster …<mob id>`, `warp "<map name>"`) : nombre en cours de saisie, mot, ou dans une chaîne | **références du serveur** (voir « Bases du serveur » ci-dessous) |
  | opérande d'une expression, mot de 2 lettres ou plus (ou Ctrl+Espace), argument qui n'est ni objet, ni monstre, ni carte | **constantes** et paramètres exportés par le serveur (`Job_Alchemist`, `BaseLevel`) |

  Aucune proposition : dans un commentaire, dans une chaîne autre que la cible de `callfunc`, et partout ailleurs. Les commandes ne sont
  proposées que si un registre de serveur existe (M4-S1) ; sans lui, aucune.
- **Survol** : label (type : label / événement / fonction locale, ligne, nombre d'utilisations ; ou « non défini »), fonction globale
  (définitions, avertissement si plusieurs, nombre d'appels `callfunc`), NPC (type, carte, définitions, nombre de `duplicate`),
  variable (portée, texte/nombre, tableau, utilisations, première affectation).
- **Commandes (M3-S3)** — tout vient du registre (DEC-025), lu à l'exécution dans le serveur de l'utilisateur ; une commande propre au
  projet (`commands.custom` de `.runeforge/project.json`, DEC-028) le complète :
  - **Complétion** : nom, signature en bref (ligne de détail), source (« commande rAthena », « commande personnalisée (projet) »…) ; l'aide
    du manuel est résolue à la sélection. Les commandes obsolètes sont barrées. Ordre : fonctions locales du script, puis commandes du projet,
    commandes du serveur, mots-clés.
  - **Aide de signature** (Ctrl+Maj+Espace, et automatiquement après l'espace qui suit une commande, `(` et `,`) : les signatures du manuel
    avec le paramètre du rang de l'argument en évidence (la première signature qui admet ce rang ; pour un nombre libre d'arguments, le
    dernier paramètre reste actif). Absente sur le nom de la commande, dans un commentaire et hors d'un script.
  - **Survol** : signature(s), nombre d'arguments (« 1 argument(s) ou plus », « de 1 à 3 arguments », « non vérifié »), extrait du manuel,
    drapeaux (obsolète, conditionnelle) et provenance (`fichier:ligne`). Une commande du projet sans notation affiche « Nombre d'arguments
    non déclaré : non vérifié ».
  - **Contexte** : déduit des **jetons**, jamais de l'AST ; instruction (début, opérande, appel en cours et rang de l'argument) dans une
    fenêtre de 120 lignes ; `commande (` est transparent ; l'en-tête d'une structure de contrôle (`if (`, `for (`, `while (`…) repart de zéro.
  - **Action rapide** sur `RA0001` : « Déclarer « X » comme commande personnalisée du projet » (écrit `commands.custom` dans `project.json`).
  - **Modèles de NPC** (`npc-script`, `npc-warp`, `npc-shop`, `npc-healer` ; rAthena) : snippets Monaco (`${n:valeur}`), valeurs par défaut
    modifiables par Tab ; les séparateurs d'en-tête sont de vraies tabulations ; aucun modèle sans émulateur vérifié.
- **Références du serveur (M4-S2)** — à partir du catalogue de ses bases (voir « Bases du serveur » plus bas) :
  - **Complétion** à l'argument d'un objet, d'un monstre ou d'une carte : les références passent avant les commandes ; hors d'une chaîne, l'**identifiant** (objets, monstres) ou le nom
    entre guillemets (cartes) remplace le fragment saisi ; dans une chaîne, le nom. Détail : `501 · Red Potion · Healing`. 200 propositions au plus, liste « incomplète » redemandée à la
    frappe. **Constantes** et paramètres à une position d'opérande (dès 2 lettres, 100 au plus), avec leur valeur quand elle est connue.
  - **Survol** d'un nombre ou d'une chaîne à la position d'un objet, d'un monstre ou d'une carte : nom, identifiant, AegisName, type ou niveau, `fichier:ligne` ; « introuvable » avec la même
    règle que `RA0008`–`RA0010`. Survol d'une constante : valeur (si écrite en clair), `fichier:ligne`.
  - **Recherche et insertion** (Ctrl+Maj+D, palette) : objets, monstres, cartes, constantes ; Entrée insère l'identifiant (le nom pour cartes et constantes), Maj+Entrée le nom entre guillemets ;
    `item:`, `mob:`, `map:`, `const:` restreignent la recherche.
- **Renommage** (F2) : labels, fonctions locales et variables locales **d'un script**, toutes occurrences (définition, `function X;`, `goto`,
  `callsub`, `menu`, `jump_zero`, appels par nom nu ; pour une variable : le nom nu, préfixe `.@`/`.`, suffixe `$` et indice conservés). Refusé :
  label d'événement `On…`, fonction globale, nom de NPC, variable globale, script incomplet ; nom invalide (lettres/chiffres/`_`, ni nombre, ni
  mot-clé, ni préfixe `On` pour un label) ou déjà pris (labels : insensible à la casse ; variables : même préfixe et même type texte/nombre).
- **Mesuré sur 841 scripts réels** : 1 806/1 806 `callfunc` et 107/107 `goto` reçoivent la bonne proposition (3 lettres saisies pour
  `callfunc`, rien pour `goto`) ; 1 913/1 913 survols informatifs ; latence de complétion p99 ≈ 0,1 ms (service seul).
- **Mesuré sur le serveur local, commandes** (`scripts/commands-report.ts`, 667 commandes dont 662 avec la signature du manuel et 5 avec une
  signature générée depuis la table, 540 avec aide) : sur 12 779 instructions-commandes réelles (une sur 40) et leurs 13 377 arguments,
  survol sur le nom **12 779/12 779**, complétion après deux lettres **12 779/12 779**, aide de signature à chaque argument **13 377/13 377**
  (oracle : l'AST du parseur) ; **aucune aide** aux 25 558 positions où elle doit se taire ; les quatre modèles de NPC : 0 diagnostic et 0
  commande inconnue. Latences (service seul) : liste complète p50 0,19 ms / p99 1,4 ms, aide de signature p50 0,06 ms / p99 0,5 ms.

## Registre de commandes et règles de chargement (M4-S1)

Implémentation : `packages/emulator-core` (registre, notation des arguments, lecture de `scripts_*.conf`) et `packages/emulator-rathena`
(bibliothèque intégrée et lecture des sources du serveur pour la validation). L'aide rAthena est embarquée dans `script-library.ts` ; l'application ne lit pas le manuel à l'exécution (DEC-041).

**Sources du registre rAthena**, relatives à la racine du serveur, de la plus à la moins prioritaire (la première information disponible
l'emporte, les suivantes complètent) :

| Source | Apporte | Fiabilité |
|---|---|---|
| `src/custom/script_def.inc` | commandes ajoutées par l'utilisateur (`BUILDIN_DEF(nom,"args")`) | nom et arité exacts |
| `src/map/script.cpp` (`buildin_func[]`) | noms (insensibles à la casse) et chaîne d'arguments de chaque commande ; `BUILDIN_DEF2(fonction,"alias","args")` : l'alias | **fait foi** : le serveur vérifie ce nombre à la lecture de chaque script (`parse_callfunc`) |
| Bibliothèque intégrée, générée de `script.cpp` et `script_commands.txt` | commandes, signatures et aides hors ligne ; mots-clés (`if`, `for`…) écartés | snapshot local ; les diagnostics utilisent les sources réelles du serveur, jamais la seule bibliothèque |

**Notation des arguments** (`add_buildin_func`) : `(v|s|i|r|l)*` obligatoires (valeur, chaîne, entier, référence de variable, label), puis
`?` (un argument optionnel chacun), puis `*` (autant d'arguments supplémentaires que l'on veut). `"s*"` : au moins 1 ; `"i??"` : de 1 à 3 ;
`""` : aucun. Une chaîne qui n'a pas cette forme est ignorée par le serveur, et par nous.

**`RA0006` — nombre d'arguments** : émis à l'analyse, sur le **nom** de la commande, quand l'arité est connue (table du serveur) et que le
nombre d'arguments est hors de l'intervalle. Le serveur refuse alors le script. Ne sont pas vérifiées : les commandes dont seul le manuel
est connu, et les instructions mal formées (`;` manquant, fragment illisible, analyse tronquée). Les types ne sont pas vérifiés.

**`RA0001` — commande inconnue** : un appel (instruction `nom args;` ou `nom(args)` dans une expression) dont le nom n'est **ni** une
commande du registre (insensible à la casse), **ni** une fonction locale du script (`function X {`, `function X;`), **ni** une fonction
globale de l'index (casse exacte, comme `callfunc`) : le serveur n'accepte l'appel d'un nom nu que dans ces trois cas (`parse_callfunc` :
« expect command, missing function name or calling undeclared function »). Avertissement par défaut, confiance « inconnue », gravité réglable
(`validation.unknownCommands` : `off`, `info`, `warning`, `error`). Aucune alerte sans registre, ni pendant l'indexation initiale.

**Règles de chargement des scripts** (`map_config_read`, `map_reloadnpc_sub`, `npc_addsrcfile`, `npc_delsrcfile`) :
- une ligne commençant par `//` est ignorée ; la suite d'une ligne après `//` est un commentaire, **même au milieu d'un chemin** ;
- `réglage: valeur` : le réglage est tout ce qui précède le premier « : » **sans retirer les espaces** (`npc : x` est un réglage inconnu) ;
  la valeur s'arrête à une tabulation ou à la fin de ligne, ses espaces finaux sont retirés ;
- `npc: chemin` ajoute un script s'il existe et n'est pas déjà dans la liste (comparaison exacte) ; `npc: clear` vide la liste ;
  `delnpc: chemin` retire un script, `delnpc: all` vide la liste ; `import: chemin` lit l'autre fichier **à cet endroit** (le serveur ne se
  protège pas d'un import circulaire ; ici il est signalé puis ignoré) ;
- ordre : `conf/map_athena.conf` (et ses `import:`, dont `conf/import/map_conf.txt`), puis `npc/re/scripts_main.conf` en mode renewal ou
  `npc/pre-re/scripts_main.conf` ; `re/` et `pre-re/` sont des variantes **exclusives** ;
- mode renewal : `#define RENEWAL` actif dans `src/config/renewal.hpp` et pas de `#define PRERE` ; fichier absent : renewal supposé.

**Portée de l'index** (`emulator.indexScope`) : `sources` (défaut) indexe les fichiers désignés par les motifs de `sources` ; `loaded`
n'indexe que les scripts que le serveur charge (liste ci-dessus), ce qui rend fiables les vérifications entre fichiers ; sans serveur reconnu,
`sources` s'applique. La **racine du serveur** (`emulator.root`) est détectée si elle est vide : le projet lui-même, sinon l'unique serveur
trouvé dans ses sous-dossiers ; plusieurs serveurs : l'utilisateur choisit.

**Mesuré sur le serveur local** (`scripts/registry-report.ts`) : 667 commandes dans la table (aucune ligne non comprise, aucun doublon), 662
au manuel, 5 de la table absentes du manuel (`warpchar`, `setr`, `needed_trait_point`, `achievement_condition`, `getvariableofinstance`) ;
841 scripts chargés (identiques, contenu et ordre, à l'outil de mesure indépendant) ; sur 557 894 appels réels : 0 alerte d'arité et 0
`RA0001` après index du projet ; avec l'arité du manuel au lieu de celle de la table : 2 329 fausses alertes.

## Bases du serveur : objets, monstres, cartes, constantes (M4-S2)

Implémentation : `packages/emulator-core` (`ReferenceCatalog`, `argumentKindsOf`) et `packages/emulator-rathena` (`yaml-db.ts`, `database-readers.ts`,
`catalog.ts`). **Rien n'est embarqué** : tout est lu à l'exécution dans le serveur de l'utilisateur (DEC-012, DEC-030) ; chaque enregistrement garde `fichier:ligne`.

**Fichiers lus**, relatifs à la racine du serveur (le serveur lui-même charge ainsi ses bases : `YamlDatabase::load`) :

| Base | Fichiers, dans l'ordre | Règles |
|---|---|---|
| Objets | `db/item_db.yml` → ses `Footer: Imports:` (`db/re/item_db.yml` ou `db/pre-re/item_db.yml` selon `Mode:`, puis `db/import/item_db.yml`) → leurs propres imports (`item_db_usable.yml`, `_equip`, `_etc`) | un fichier **avant** ses imports ; `Header: Clear: true` efface ; un nouvel objet exige `Id`, `AegisName`, `Name` ; une entrée dont l'`AegisName` est déjà celui d'**un autre** objet est ignorée en entier ; sinon elle ne modifie que les champs qu'elle écrit |
| Monstres | `db/mob_db.yml` → `db/re/` ou `db/pre-re/mob_db.yml` → `db/import/mob_db.yml` | identifiant de 1001 à 3998 ou de 20021 à 31998 ; `JapaneseName` vaut le nom d'affichage par défaut |
| Cartes | `db/map_index.txt` puis `db/import/map_index.txt` | `nom` (index = précédent + 1) ou `nom index` ; nom lu sur 11 caractères ; un index réécrit remplace la carte ; `.gat` retiré ; comparaison exacte (casse comprise) |
| Constantes | `src/map/script_constants.hpp` (`export_constant(NOM)`, `export_constant2("Nom", v)`, `export_parameter`, `export_constant_npc(JT_X)` → `X`), puis `db/const.yml` | insensible à la casse comme les commandes ; la première définition d'un nom l'emporte |

**Lecture** (`scanYamlDatabase`) : par **indentation**, sans arbre YAML ; ne retient que `Id`, `AegisName`, `Name`, `Type`, `JapaneseName`, `Level` ; saute le contenu imbriqué (`Script: |`, `Drops:`) ;
lit aussi les tables en ligne ; compte les lignes non comprises. **Correspondance** (comme le serveur) : objet par identifiant, ou par AegisName puis nom d'affichage (sans casse) ; monstre par
identifiant ou AegisName, et pour une chaîne aussi par nom d'affichage ou japonais ; carte par nom exact.

**Nature des arguments** : lue dans les **signatures du manuel** de l'utilisateur (`argumentKindsOf`) : un paramètre nommé `<map name>`, `<item id>`, `<item name>`, `<mob id>`, `<monster id>`… (liste fermée,
voir `argument-kinds.ts`) donne sa nature à la position ; elle n'est retenue que si toutes les signatures de la commande s'accordent. Les valeurs écrites en clair sont vérifiées par `RA0008` (carte),
`RA0009` (objet) et `RA0010` (monstre) — voir le catalogue ci-dessous ; les propositions, le survol et la recherche en tirent la même information.

**Mesuré sur le serveur local** (`catalog-report.ts`, `references-report.ts`) : 27 826 objets, 2 555 monstres, 1 248 cartes, 10 303 constantes (10 297 du code du serveur, 6 de `const.yml`) ; le lecteur est
**identique à un analyseur YAML complet** (0 différence) et 25 fois plus rapide ; sur les 841 scripts chargés, 26 428 arguments en clair vérifiés pour **un seul signalé, une vraie erreur du script** ; 440/440 mutations
détectées, 0 alerte parasite ; survol 1 054/1 054, complétion (3 caractères) 1 042/1 054.
**M4-S3d** : les constantes `RDMOPT_<Option>` des options aléatoires (`db/item_randomopt_db.yml`, que le serveur crée à la fin du chargement de cette base) rejoignent le catalogue : 249 sur le serveur local, soit 10 552
constantes en tout, identiques à un analyseur YAML complet ; elles sont proposées, décrites et cherchées comme les autres, et un label de ce nom est refusé (`RA0014`).

## Catalogue complet des diagnostics
Défini dans `runescript-core/src/diagnostics.ts` (messages FR/EN, conseil de correction, niveau de confiance, catégorie).
- `RS0001`–`RS0003` lexique · `RS0010`–`RS0013` délimiteurs · `RS0020`–`RS0024` attendus (`;`, expression, `(`, label…) ·
  `RS0030`–`RS0036` en-têtes · `RS0040`–`RS0041` `else`/`case` mal placés · `RS0050` profondeur · `RS0051` instruction attendue.
- `RA0001` (commande inconnue) et `RA0006` (nombre d'arguments) sont **émis** pour un serveur rAthena reconnu (M4-S1). `RA0008` (carte introuvable),
  `RA0009` (objet introuvable) et `RA0010` (monstre introuvable) sont **émis** à l'analyse (M4-S2) : information, confiance « inconnue », gravité réglable
  (`validation.unknownReferences`) ; ils ne portent que sur un nombre ou une chaîne **écrits en clair** à la position d'un tel argument, jamais sur une variable, une
  expression, zéro, un nombre négatif, une valeur spéciale (`Random`, `SavePoint`, `Save`, `this`, `SavePointAll`, `Leader`, `RandomAll`) ni un texte qui n'est pas un nom de carte.
  **M4-S3** : `RA0008` porte aussi sur la **carte de chaque déclaration** de premier niveau (script, warp, boutique, monstres, duplicate, mapflag) et sur la **destination d'un warp** (le serveur ignore la
  déclaration et journalise une erreur) ; jamais quand l'index des cartes est vide. `RA0015` (déclaration sur une carte que le serveur ne charge pas), `RA0014` (label portant un nom réservé) : voir le tableau
  ci-dessus. Les cartes chargées se lisent dans `conf/map_athena.conf` et ses imports (`map:`, `delmap:`, `import:`) comme `map_config_read` ; une liste inconnue ne déclenche jamais `RA0015`.
  **M4-S3c** : `RA0016` (appel par son nom d'une fonction que le serveur ne connaît pas encore) suppose l'ordre de chargement des scripts : les listes `scripts_*.conf`, `import:`, `delnpc:` et `npc: clear`
  appliqués comme le serveur ; elle porte sur une fonction définie quelque part (sinon c'est `RA0001`).
  `RC0001`–`RC0003` sont **définis mais pas encore émis** : ils exigent un second profil à comparer.

## Non supporté / non vérifié
- **Hercules** : aucune règle vérifiée (syntaxe, commandes, `callsub`/`menu`).
- Hors serveur rAthena reconnu (Hercules, projet sans serveur) : pas de registre, donc commande inconnue et nombre d'arguments non
  vérifiés, et aucune commande proposée, documentée ni aide de signature (les modèles de NPC non plus : ils sont propres à rAthena) ;
  pas de catalogue non plus : ni objet, monstre, carte ou constante proposés, décrits ou vérifiés.
- Les appels de fonctions globales par leur nom nu (`F_Name arg;`) ne sont pas suivis comme références (seulement `callfunc "…"`) ; ils
  évitent `RA0001` si la fonction est indexée. Le serveur exige que la fonction soit déjà chargée à ce moment (`parse_simpleexpr` ne reconnaît un appel par nom que si le nom est dans
  `userfunc_db`, rempli au fur et à mesure du chargement : sinon le mot est lu comme une variable et le script ne se charge pas) : `RA0016` (M4-S3c) le signale quand l'ordre de
  chargement des scripts du serveur est connu (voir le tableau) ; un mot qui nomme une fonction sans parenthèses dans une expression n'est pas reconnu comme un appel.
- Références par chaîne vers des événements (`donpcevent "NPC::OnLabel"`, `addtimer`, `doevent`…) : non analysées (M3/M4).
- Une étiquette portant le nom d'une constante, d'un paramètre ou d'une commande est refusée par le serveur (`set_label: invalid label name`) : détecté par `RA0014` (M4-S3) pour les
  commandes de la table du serveur et les constantes qu'il exporte ; une constante ajoutée à l'exécution n'est pas connue du catalogue (aucune alerte) ; les constantes `RDMOPT_…` le sont depuis M4-S3d.
- Caractères non ASCII hors chaînes/commentaires → tokens `Unknown`.
- `===`/`!==` : découpés en `==` + `=` ; à vérifier.
