/**
 * Registre de commandes de script d'un emulateur (CLAUDE.md 7.1 et 7.2).
 *
 * Un registre ne contient que des definitions **sourcees** : chaque information garde son origine (bibliotheque integree,
 * source du serveur de l'utilisateur, documentation locale ou declaration du projet).
 *
 * Les noms de commandes sont insensibles a la casse, comme sur le serveur (`strcasecmp` dans `add_str`, script.cpp).
 */

/** Nombre d'arguments accepte par une commande ; `max === null` signifie « illimite ». */
export interface Arity {
  readonly min: number;
  readonly max: number | null;
}

/**
 * Lit la notation compacte des arguments du serveur (`BUILDIN_DEF(nom, "vi?")`) : `(v|s|i|r|l)*` arguments obligatoires
 * (valeur, chaine, entier, reference, label), puis `?` (un argument optionnel chacun), puis `*` (autant d'arguments
 * supplementaires que l'on veut). Retourne `null` si la chaine n'a pas cette forme : le serveur ignore alors la commande
 * (`add_buildin_func`).
 */
export function parseParameterTypes(types: string): Arity | null {
  let index = 0;
  while (index < types.length && "vsirl".includes(types.charAt(index))) index += 1;
  const required = index;
  while (types.charAt(index) === "?") index += 1;
  const optional = index - required;
  let variadic = false;
  if (types.charAt(index) === "*") {
    variadic = true;
    index += 1;
  }
  if (index !== types.length) return null;
  return { min: required, max: variadic ? null : required + optional };
}

/** Texte neutre (sans langue) d'une arite pour les messages : `2`, `1-3` ou `2+`. */
export function formatArity(arity: Arity): string {
  if (arity.max === null) return `${arity.min}+`;
  return arity.min === arity.max ? String(arity.min) : `${arity.min}-${arity.max}`;
}

export type ArityCheck =
  /** Le nombre d'arguments est accepte. */
  | { readonly kind: "ok" }
  /** L'arite de la commande n'est pas connue avec certitude (documentation seule) : rien n'est verifie. */
  | { readonly kind: "unchecked" }
  | { readonly kind: "mismatch"; readonly arity: Arity };

export function checkArity(definition: { readonly arity: Arity | null }, count: number): ArityCheck {
  const arity = definition.arity;
  if (arity === null) return { kind: "unchecked" };
  if (count < arity.min || (arity.max !== null && count > arity.max)) return { kind: "mismatch", arity };
  return { kind: "ok" };
}

/** D'ou vient une information du registre. */
export type DefinitionSourceKind =
  /** Bibliotheque rAthena versionnee avec l'application ; aide et signatures disponibles hors ligne. */
  | "builtin-library"
  /** Table des commandes du code source du serveur de l'utilisateur : fait foi pour les noms et l'arite. */
  | "server-source"
  /** Documentation locale du serveur (`doc/script_commands.txt`) : signatures lisibles et aide, arite non garantie. */
  | "server-doc"
  /** Declaration propre au projet (commande personnalisee). */
  | "project";

export interface DefinitionSource {
  readonly kind: DefinitionSourceKind;
  /** Fichier et ligne, ou identifiant de provenance de la bibliotheque integree. */
  readonly reference: string;
}

export interface CommandDefinition {
  /** Nom canonique (orthographe de la source prioritaire). */
  readonly name: string;
  /** Nombre d'arguments accepte ; `null` si inconnu. Seules les sources fiables en fournissent une. */
  readonly arity: Arity | null;
  /** Notation compacte des arguments du serveur (`s*`, `vi?`) quand elle est connue : sert a l'aide de signature. */
  readonly parameterTypes: string | null;
  /** Signatures lisibles, telles qu'ecrites dans la documentation locale de l'utilisateur. */
  readonly signatures: readonly string[];
  /** Texte d'aide de la documentation rAthena ou d'une declaration du projet. */
  readonly documentation: string | null;
  readonly deprecated: boolean;
  /** Compilee sous condition (`#ifdef`) : sa presence depend de la configuration de compilation du serveur. */
  readonly conditional: boolean;
  /** Origine de chaque information, de la plus prioritaire a la moins prioritaire. */
  readonly sources: readonly DefinitionSource[];
}

/** Cle de comparaison d'un nom de commande. */
export function commandKey(name: string): string {
  return name.toLowerCase();
}

/** Fusionne deux definitions du meme nom : la premiere l'emporte, la seconde complete ce qui lui manque. */
function mergeDefinitions(first: CommandDefinition, second: CommandDefinition): CommandDefinition {
  const signatures = [...first.signatures];
  for (const signature of second.signatures) if (!signatures.includes(signature)) signatures.push(signature);
  return {
    name: first.name,
    arity: first.arity ?? second.arity,
    parameterTypes: first.parameterTypes ?? second.parameterTypes,
    signatures,
    documentation: first.documentation ?? second.documentation,
    deprecated: first.deprecated || second.deprecated,
    conditional: first.conditional || second.conditional,
    sources: [...first.sources, ...second.sources],
  };
}

export interface RegistryStats {
  readonly total: number;
  /** Commandes dont le nombre d'arguments est verifiable. */
  readonly withArity: number;
  readonly fromServerSource: number;
  readonly fromServerDoc: number;
  readonly fromProject: number;
}

/**
 * Ensemble immuable de commandes connues d'un profil d'emulateur. Les definitions d'un meme nom sont fusionnees dans
 * l'ordre donne : mettre d'abord les sources les plus prioritaires (declaration du projet, puis code source du serveur,
 * puis documentation).
 */
export class CommandRegistry {
  private constructor(
    private readonly byKey: ReadonlyMap<string, CommandDefinition>,
    /** Nom du profil pour les messages (« rAthena »). */
    readonly profileLabel: string,
  ) {}

  static create(definitions: Iterable<CommandDefinition>, profileLabel: string): CommandRegistry {
    const merged = new Map<string, CommandDefinition>();
    for (const definition of definitions) {
      const key = commandKey(definition.name);
      const existing = merged.get(key);
      merged.set(key, existing === undefined ? definition : mergeDefinitions(existing, definition));
    }
    return new CommandRegistry(merged, profileLabel);
  }

  get size(): number {
    return this.byKey.size;
  }

  has(name: string): boolean {
    return this.byKey.has(commandKey(name));
  }

  get(name: string): CommandDefinition | undefined {
    return this.byKey.get(commandKey(name));
  }

  definitions(): CommandDefinition[] {
    return [...this.byKey.values()];
  }

  stats(): RegistryStats {
    let withArity = 0;
    let fromServerSource = 0;
    let fromServerDoc = 0;
    let fromProject = 0;
    for (const definition of this.byKey.values()) {
      if (definition.arity !== null) withArity += 1;
      const kinds = new Set(definition.sources.map((source) => source.kind));
      if (kinds.has("server-source")) fromServerSource += 1;
      if (kinds.has("server-doc")) fromServerDoc += 1;
      if (kinds.has("project")) fromProject += 1;
    }
    return { total: this.byKey.size, withArity, fromServerSource, fromServerDoc, fromProject };
  }
}
