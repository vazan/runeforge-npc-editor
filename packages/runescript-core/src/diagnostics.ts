import type {
  DiagnosticCategory,
  DiagnosticConfidence,
  DiagnosticParams,
  DiagnosticSeverity,
  DiagnosticSource,
  ParseDiagnostic,
  RelatedLocation,
  SourceRange,
} from "./types";

export type Language = "fr" | "en";

interface LocalizedMessage {
  /** Ce qui ne va pas (peut contenir des `{parametres}`). */
  readonly message: string;
  /** Comment corriger (optionnel). */
  readonly hint?: string;
}

interface CatalogEntry {
  readonly category: DiagnosticCategory;
  readonly severity: DiagnosticSeverity;
  readonly confidence: DiagnosticConfidence;
  readonly source: DiagnosticSource;
  readonly en: LocalizedMessage;
  readonly fr: LocalizedMessage;
}

/**
 * Catalogue unique des diagnostics (CLAUDE.md 1.3 : quoi, ou, pourquoi, comment corriger).
 *
 * Convention des codes :
 * - RSxxxx : syntaxe (lexer/parser) ;
 * - RAxxxx : analyse semantique ;
 * - RCxxxx : compatibilite avec un profil d'emulateur.
 *
 * Les niveaux de confiance suivent CLAUDE.md 6.5 : `certain` seulement pour une
 * incoherence demontrable par les regles implementees ; une commande ou une donnee
 * inconnue est `unknown` (jamais presentee comme une erreur serveur certaine).
 */
const CATALOG = {
  RS0001: {
    category: "syntax-error", severity: "error", confidence: "certain", source: "parser",
    en: { message: "Unterminated string literal.", hint: "Add the closing double quote \" before the end of the line." },
    fr: { message: "Chaîne de caractères non terminée.", hint: "Ajoutez le guillemet fermant \" avant la fin de la ligne." },
  },
  RS0002: {
    category: "syntax-error", severity: "error", confidence: "certain", source: "parser",
    en: { message: "Unterminated block comment.", hint: "Close the comment with */ or remove the opening /*." },
    fr: { message: "Commentaire bloc non terminé.", hint: "Fermez le commentaire avec */ ou supprimez le /* d'ouverture." },
  },
  RS0003: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Unexpected character '{char}'.", hint: "Remove it, or put it inside a string if it is text." },
    fr: { message: "Caractère inattendu « {char} ».", hint: "Supprimez-le, ou placez-le dans une chaîne s'il s'agit de texte." },
  },
  RS0010: {
    category: "syntax-error", severity: "error", confidence: "certain", source: "parser",
    en: { message: "Unmatched closing '{token}'.", hint: "Remove it or add the matching opening delimiter." },
    fr: { message: "« {token} » fermant sans ouvrant correspondant.", hint: "Supprimez-le ou ajoutez le délimiteur ouvrant correspondant." },
  },
  RS0011: {
    category: "syntax-error", severity: "error", confidence: "certain", source: "parser",
    en: { message: "Block opened here is never closed.", hint: "Add a closing '}' for this '{'." },
    fr: { message: "Le bloc ouvert ici n'est jamais fermé.", hint: "Ajoutez un « } » fermant pour ce « { »." },
  },
  RS0012: {
    category: "syntax-error", severity: "error", confidence: "certain", source: "parser",
    en: { message: "Parenthesis opened here is never closed.", hint: "Add a closing ')'." },
    fr: { message: "La parenthèse ouverte ici n'est jamais fermée.", hint: "Ajoutez une parenthèse fermante « ) »." },
  },
  RS0013: {
    category: "syntax-error", severity: "error", confidence: "certain", source: "parser",
    en: { message: "Bracket opened here is never closed.", hint: "Add a closing ']'." },
    fr: { message: "Le crochet ouvert ici n'est jamais fermé.", hint: "Ajoutez un crochet fermant « ] »." },
  },
  RS0020: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Expected ';' to end the statement.", hint: "Add ';' at the end of the statement." },
    fr: { message: "« ; » attendu pour terminer l'instruction.", hint: "Ajoutez « ; » à la fin de l'instruction." },
  },
  RS0021: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Expected an expression.", hint: "Provide a value, variable or function call here." },
    fr: { message: "Expression attendue.", hint: "Indiquez ici une valeur, une variable ou un appel de fonction." },
  },
  RS0022: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Expected '{expected}'.", hint: "Insert the missing '{expected}'." },
    fr: { message: "« {expected} » attendu.", hint: "Insérez le « {expected} » manquant." },
  },
  RS0023: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Expected '(' after '{keyword}'.", hint: "Write the condition between parentheses." },
    fr: { message: "« ( » attendu après « {keyword} ».", hint: "Écrivez la condition entre parenthèses." },
  },
  RS0024: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Expected a label name after '{keyword}'.", hint: "Give the name of a label defined in this script." },
    fr: { message: "Nom de label attendu après « {keyword} ».", hint: "Indiquez le nom d'un label défini dans ce script." },
  },
  RS0030: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Incomplete declaration header: expected at least {expected} tab-separated fields, found {count}.", hint: "Separate the fields with tab characters (not spaces)." },
    fr: { message: "En-tête de déclaration incomplet : au moins {expected} champs séparés par des tabulations attendus, {count} trouvé(s).", hint: "Séparez les champs par des tabulations (pas des espaces)." },
  },
  RS0031: {
    category: "unknown-extension", severity: "warning", confidence: "unknown", source: "parser",
    en: { message: "Unknown declaration type '{type}'; the text is kept unchanged.", hint: "If this is a custom extension of your server, ignore this notice; otherwise check the spelling." },
    fr: { message: "Type de déclaration inconnu « {type} » ; le texte est conservé tel quel.", hint: "S'il s'agit d'une extension propre à votre serveur, ignorez cet avis ; sinon vérifiez l'orthographe." },
  },
  RS0032: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Declaration fields are not separated by tab characters.", hint: "rAthena and Hercules expect TAB between the fields of a top-level declaration; replace the spaces with tabs." },
    fr: { message: "Les champs de la déclaration ne sont pas séparés par des tabulations.", hint: "rAthena et Hercules attendent des TAB entre les champs d'une déclaration de premier niveau ; remplacez les espaces par des tabulations." },
  },
  RS0033: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Script declaration without a '{' code block.", hint: "Add the code between '{' and '}' at the end of the header line." },
    fr: { message: "Déclaration de script sans bloc de code « { ».", hint: "Ajoutez le code entre « { » et « } » à la fin de la ligne d'en-tête." },
  },
  RS0034: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "'{value}' is not a valid {what}.", hint: "Use a whole number." },
    fr: { message: "« {value} » n'est pas {what} valide.", hint: "Utilisez un nombre entier." },
  },
  RS0035: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Unexpected text after the declaration.", hint: "Start the next declaration on a new line." },
    fr: { message: "Texte inattendu après la déclaration.", hint: "Commencez la déclaration suivante sur une nouvelle ligne." },
  },
  RS0036: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Invalid position: expected '{expected}', found {count} value(s).", hint: "Write the position as {expected}." },
    fr: { message: "Position invalide : « {expected} » attendu, {count} valeur(s) trouvée(s).", hint: "Écrivez la position sous la forme {expected}." },
  },
  RS0040: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "'else' without a matching 'if'.", hint: "Remove it or add the missing 'if'." },
    fr: { message: "« else » sans « if » correspondant.", hint: "Supprimez-le ou ajoutez le « if » manquant." },
  },
  RS0041: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "'{keyword}' outside of a 'switch' block.", hint: "Move it inside a switch (...) { } block." },
    fr: { message: "« {keyword} » en dehors d'un bloc « switch ».", hint: "Déplacez-le dans un bloc switch (...) { }." },
  },
  RS0050: {
    category: "syntax-error", severity: "warning", confidence: "unknown", source: "parser",
    en: { message: "Nesting is too deep: the rest of this declaration was not analyzed.", hint: "Simplify the structure or split it into functions; the text itself is kept unchanged." },
    fr: { message: "Imbrication trop profonde : le reste de cette déclaration n'a pas été analysé.", hint: "Simplifiez la structure ou découpez-la en fonctions ; le texte lui-même reste inchangé." },
  },
  RS0051: {
    category: "syntax-error", severity: "error", confidence: "probable", source: "parser",
    en: { message: "Expected a statement.", hint: "Write a statement, or ';' for an empty one." },
    fr: { message: "Instruction attendue.", hint: "Écrivez une instruction, ou « ; » pour une instruction vide." },
  },
  RA0001: {
    category: "unknown-extension", severity: "warning", confidence: "unknown", source: "analyzer",
    en: { message: "'{name}' is not a known command or function for profile {profile}.", hint: "Check the spelling. If it is a command added by your fork, declare it as a custom command of the project (quick fix) or register it in the server's command table (src/custom/script_def.inc); if it is a function of your scripts, the file that defines it must be part of the project." },
    fr: { message: "« {name} » n'est pas une commande ou fonction connue pour le profil {profile}.", hint: "Vérifiez l'orthographe. S'il s'agit d'une commande ajoutée par votre fork, déclarez-la comme commande personnalisée du projet (action rapide) ou enregistrez-la dans la table des commandes du serveur (src/custom/script_def.inc) ; s'il s'agit d'une fonction de vos scripts, le fichier qui la définit doit faire partie du projet." },
  },
  RA0002: {
    category: "semantic-error", severity: "error", confidence: "probable", source: "analyzer",
    en: { message: "Label '{name}' is not defined in this script.", hint: "Define the label ('{name}:') in the same NPC or function, or fix the name." },
    fr: { message: "Le label « {name} » n'est pas défini dans ce script.", hint: "Définissez le label (« {name}: ») dans le même NPC ou la même fonction, ou corrigez le nom." },
  },
  RA0003: {
    category: "semantic-error", severity: "error", confidence: "certain", source: "analyzer",
    en: { message: "Label '{name}' is defined more than once in this script.", hint: "Rename one of the labels (names are case-insensitive)." },
    fr: { message: "Le label « {name} » est défini plusieurs fois dans ce script.", hint: "Renommez l'un des labels (les noms sont insensibles à la casse)." },
  },
  RA0004: {
    category: "semantic-error", severity: "info", confidence: "unknown", source: "analyzer",
    en: { message: "Function '{name}' was not found in the indexed project files (unresolved).", hint: "It may be defined in a file that is not part of the project sources, or the name may be misspelled." },
    fr: { message: "La fonction « {name} » est introuvable dans les fichiers indexés du projet (non résolue).", hint: "Elle est peut-être définie dans un fichier hors des sources du projet, ou le nom est mal orthographié." },
  },
  RA0005: {
    category: "semantic-error", severity: "warning", confidence: "probable", source: "analyzer",
    en: { message: "NPC unique name '{name}' is declared more than once in the project.", hint: "The server renames the NPC it loads last (to something like '1_map_x_y'), which breaks events and duplicate() references. Give each NPC its own unique name with '::UniqueName'." },
    fr: { message: "Le nom unique de NPC « {name} » est déclaré plusieurs fois dans le projet.", hint: "Le serveur renomme le NPC chargé en dernier (en « 1_carte_x_y » par exemple), ce qui casse les événements et les références de duplicate(). Donnez à chaque NPC son propre nom unique avec « ::NomUnique »." },
  },
  RA0006: {
    category: "semantic-error", severity: "warning", confidence: "probable", source: "analyzer",
    en: { message: "'{name}' expects {expected} argument(s) but {count} were given.", hint: "Check the signature of '{name}'." },
    fr: { message: "« {name} » attend {expected} argument(s) mais {count} ont été fournis.", hint: "Vérifiez la signature de « {name} »." },
  },
  RA0007: {
    category: "style-hint", severity: "info", confidence: "certain", source: "analyzer",
    en: { message: "Label '{name}' is never referenced in this script.", hint: "Remove it if it is unused (event labels such as OnInit are ignored)." },
    fr: { message: "Le label « {name} » n'est jamais référencé dans ce script.", hint: "Supprimez-le s'il est inutile (les labels d'événement comme OnInit sont ignorés)." },
  },
  RA0008: {
    category: "semantic-error", severity: "info", confidence: "unknown", source: "analyzer",
    en: { message: "Map '{name}' was not found in the loaded map index (unresolved).", hint: "Check the spelling, or load the map index of your server (db/map_index.txt)." },
    fr: { message: "La carte « {name} » est introuvable dans l'index des cartes chargé (non résolue).", hint: "Vérifiez l'orthographe, ou chargez l'index des cartes de votre serveur (db/map_index.txt)." },
  },
  RA0009: {
    category: "semantic-error", severity: "info", confidence: "unknown", source: "analyzer",
    en: { message: "Item '{name}' was not found in the loaded item database (unresolved).", hint: "Check the id or AegisName, or load your item database." },
    fr: { message: "L'objet « {name} » est introuvable dans la base d'objets chargée (non résolu).", hint: "Vérifiez l'identifiant ou l'AegisName, ou chargez votre base d'objets." },
  },
  RA0010: {
    category: "semantic-error", severity: "info", confidence: "unknown", source: "analyzer",
    en: { message: "Monster '{name}' was not found in the loaded monster database (unresolved).", hint: "Check the id or AegisName, or load your monster database." },
    fr: { message: "Le monstre « {name} » est introuvable dans la base de monstres chargée (non résolu).", hint: "Vérifiez l'identifiant ou l'AegisName, ou chargez votre base de monstres." },
  },
  RA0011: {
    category: "semantic-error", severity: "warning", confidence: "probable", source: "analyzer",
    en: { message: "Function '{name}' is defined more than once in the project.", hint: "The server keeps only the last definition it loads (it logs 'Overwriting user function'). Function names are case-sensitive; rename or remove one of the definitions." },
    fr: { message: "La fonction « {name} » est définie plusieurs fois dans le projet.", hint: "Le serveur ne garde que la dernière définition chargée (il journalise « Overwriting user function »). Les noms de fonctions sont sensibles à la casse ; renommez ou supprimez l'une des définitions." },
  },
  RA0012: {
    category: "semantic-error", severity: "error", confidence: "certain", source: "analyzer",
    en: { message: "Local function '{name}' is declared but never defined.", hint: "Add 'function {name} { ... }' in the same script, or remove the declaration. The server refuses to load a script with an undefined local function." },
    fr: { message: "La fonction locale « {name} » est déclarée mais jamais définie.", hint: "Ajoutez « function {name} { ... } » dans le même script, ou supprimez la déclaration. Le serveur refuse de charger un script dont une fonction locale n'est pas définie." },
  },
  RA0013: {
    category: "semantic-error", severity: "warning", confidence: "probable", source: "analyzer",
    en: { message: "The NPC '{name}' duplicated here was not found in the indexed project files (unresolved).", hint: "duplicate() needs its source NPC to be loaded earlier, under the same unique name (case-sensitive). Check the name and the load order of your script files." },
    fr: { message: "Le NPC « {name} » dupliqué ici est introuvable dans les fichiers indexés du projet (non résolu).", hint: "duplicate() exige que son NPC source soit chargé avant, avec le même nom unique (sensible à la casse). Vérifiez le nom et l'ordre de chargement de vos fichiers de scripts." },
  },
  RA0014: {
    category: "semantic-error", severity: "error", confidence: "probable", source: "analyzer",
    en: { message: "Label '{name}' has the name of a script command, constant or parameter of the server: the server refuses it ('set_label: invalid label name').", hint: "Rename the label (for example 'L_{name}'); the server ignores it, so a goto to it cannot work." },
    fr: { message: "Le label « {name} » porte le nom d'une commande, d'une constante ou d'un paramètre de script du serveur : le serveur le refuse (« set_label: invalid label name »).", hint: "Renommez le label (par exemple « L_{name} ») ; le serveur l'ignore, un goto vers lui ne peut donc pas fonctionner." },
  },
  RA0016: {
    category: "semantic-error", severity: "error", confidence: "probable", source: "analyzer",
    en: { message: "Function '{name}' is called by name before the server has loaded it: the script fails to load ('calling undeclared function').", hint: "The server only knows a function once its definition has been loaded. Load the file that defines '{name}' earlier in your script list (scripts_*.conf), define it higher up in the same file, or call it with callfunc \"{name}\", which is resolved at run time (also needed for a function that calls itself)." },
    fr: { message: "La fonction « {name} » est appelée par son nom avant que le serveur l'ait chargée : le script ne se charge pas (« calling undeclared function »).", hint: "Le serveur ne connaît une fonction qu'une fois sa définition chargée. Chargez le fichier qui définit « {name} » plus tôt dans votre liste de scripts (scripts_*.conf), définissez-la plus haut dans le même fichier, ou appelez-la avec callfunc \"{name}\", résolu à l'exécution (nécessaire aussi pour une fonction qui s'appelle elle-même)." },
  },
  RA0015: {
    category: "semantic-error", severity: "info", confidence: "probable", source: "analyzer",
    en: { message: "Map '{name}' is in the map index but this server does not load it: the server skips this declaration without logging anything.", hint: "Add 'map: {name}' to conf/maps_athena.conf, or remove the declaration. If another map-server loads this map, ignore this notice." },
    fr: { message: "La carte « {name} » est dans l'index des cartes mais ce serveur ne la charge pas : il ignore cette déclaration sans rien journaliser.", hint: "Ajoutez « map: {name} » à conf/maps_athena.conf, ou supprimez la déclaration. Si un autre serveur de cartes charge cette carte, ignorez cet avis." },
  },
  RC0001: {
    category: "compatibility-warning", severity: "warning", confidence: "probable", source: "compatibility",
    en: { message: "'{name}' is not documented for profile {profile} ({reference}).", hint: "Check the manual of your emulator; the command may exist only in {other}." },
    fr: { message: "« {name} » n'est pas documentée pour le profil {profile} ({reference}).", hint: "Consultez le manuel de votre émulateur ; la commande n'existe peut-être que pour {other}." },
  },
  RC0002: {
    category: "compatibility-warning", severity: "info", confidence: "probable", source: "compatibility",
    en: { message: "'{name}' is deprecated for profile {profile}.", hint: "{replacement}" },
    fr: { message: "« {name} » est dépréciée pour le profil {profile}.", hint: "{replacement}" },
  },
  RC0003: {
    category: "compatibility-warning", severity: "warning", confidence: "probable", source: "compatibility",
    en: { message: "Syntax '{feature}' is not documented for profile {profile}.", hint: "Check the manual of your emulator or switch the project profile." },
    fr: { message: "La syntaxe « {feature} » n'est pas documentée pour le profil {profile}.", hint: "Consultez le manuel de votre émulateur ou changez le profil du projet." },
  },
} as const satisfies Record<string, CatalogEntry>;

export type DiagnosticCode = keyof typeof CATALOG;

export function isDiagnosticCode(code: string): code is DiagnosticCode {
  return Object.prototype.hasOwnProperty.call(CATALOG, code);
}

export function listDiagnosticCodes(): DiagnosticCode[] {
  return Object.keys(CATALOG) as DiagnosticCode[];
}

function interpolate(template: string, params: DiagnosticParams | undefined): string {
  if (params === undefined) return template;
  let output = "";
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("{", index);
    if (open === -1) {
      output += template.slice(index);
      break;
    }
    const close = template.indexOf("}", open + 1);
    if (close === -1) {
      output += template.slice(index);
      break;
    }
    const key = template.slice(open + 1, close);
    const value = Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined;
    output += template.slice(index, open) + (value === undefined ? `{${key}}` : String(value));
    index = close + 1;
  }
  return output;
}

export interface DiagnosticOverrides {
  readonly severity?: DiagnosticSeverity;
  readonly confidence?: DiagnosticConfidence;
  /** Autres emplacements concernes (ex. les autres definitions d'une fonction en double). */
  readonly related?: readonly RelatedLocation[];
}

/** Cree un diagnostic a partir du catalogue (message canonique en anglais, `params` conserves pour la localisation). */
export function createDiagnostic(
  code: DiagnosticCode,
  range: SourceRange,
  params?: DiagnosticParams,
  overrides?: DiagnosticOverrides,
): ParseDiagnostic {
  const entry: CatalogEntry = CATALOG[code];
  const base = {
    code,
    category: entry.category,
    range,
    severity: overrides?.severity ?? entry.severity,
    message: interpolate(entry.en.message, params),
    confidence: overrides?.confidence ?? entry.confidence,
    source: entry.source,
  };
  const related = overrides?.related;
  const withParams = params === undefined ? base : { ...base, params };
  return related === undefined || related.length === 0 ? withParams : { ...withParams, related };
}

/** Message et conseil localises pour l'affichage (repli sur le message canonique si le code est inconnu). */
export function describeDiagnostic(
  diagnostic: Pick<ParseDiagnostic, "code" | "message" | "params">,
  language: Language,
): { message: string; hint?: string } {
  if (!isDiagnosticCode(diagnostic.code)) return { message: diagnostic.message };
  const entry: CatalogEntry = CATALOG[diagnostic.code];
  const localized = entry[language];
  const message = interpolate(localized.message, diagnostic.params);
  if (localized.hint === undefined) return { message };
  return { message, hint: interpolate(localized.hint, diagnostic.params) };
}
