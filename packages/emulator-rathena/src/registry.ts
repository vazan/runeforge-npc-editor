import { CommandRegistry, commandKey, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { parseBuiltinTable } from "./builtin-table";
import { parseCommandDoc } from "./command-doc";
import { RATHENA_PATHS, RATHENA_PROFILE_LABEL } from "./paths";

/** Commande declaree dans la configuration du projet (`.runeforge/project.json`, `commands.custom`). */
export interface ProjectCommandInput {
  readonly name: string;
  /** Notation compacte des arguments du serveur (`s?`, `i*`...) ; `null` : nombre d'arguments non verifie. */
  readonly args: string | null;
  readonly description: string | null;
}

/** Texte des fichiers du serveur de l'utilisateur ; `null` ou absent quand le fichier n'existe pas. */
export interface RathenaRegistryInputs {
  /** `src/map/script.cpp` : table des commandes (fait foi pour les noms et l'arite). */
  readonly builtinSource?: string | null;
  /** `src/custom/script_def.inc` : commandes personnalisees ajoutees a la table (prioritaires sur elle). */
  readonly customBuiltins?: string | null;
  /** `doc/script_commands.txt` : signatures lisibles et aide. */
  readonly commandDoc?: string | null;
  /**
   * Commandes declarees dans le projet : les plus prioritaires (un fork peut redefinir la signature d'une commande), mais
   * elles **completent** un registre de serveur, elles ne le remplacent pas : sans aucun fichier de serveur, il n'y a pas de
   * registre (sinon toutes les autres commandes seraient signalees comme inconnues).
   */
  readonly projectCommands?: readonly ProjectCommandInput[];
}

/** Provenance des commandes declarees dans le projet. */
const PROJECT_REFERENCE = ".runeforge/project.json";

/**
 * Niveau de fiabilite du registre obtenu :
 * - `server-source` : noms et nombres d'arguments lus dans le code du serveur ;
 * - `server-doc` : noms et signatures lus dans la documentation seule (arite non verifiee) ;
 * - `none` : aucun fichier exploitable, pas de registre.
 */
export type RegistryLevel = "server-source" | "server-doc" | "none";

export interface RathenaRegistryReport {
  readonly registry: CommandRegistry | null;
  readonly level: RegistryLevel;
  readonly sourceCommands: number;
  readonly customCommands: number;
  readonly docCommands: number;
  /** Commandes declarees dans le projet et retenues (0 sans registre de serveur). */
  readonly projectCommands: number;
  /** Commandes de la table absentes de la documentation (documentation incomplete). */
  readonly sourceOnly: readonly string[];
  /** Commandes documentees mais absentes de la table (documentation en avance, ou commande retiree). */
  readonly docOnly: readonly string[];
  /** Lignes `BUILDIN_DEF` non comprises et commandes invalides : a afficher en cas de doute sur le registre. */
  readonly warnings: readonly string[];
}

function projectDefinitions(commands: readonly ProjectCommandInput[]): CommandDefinition[] {
  return commands.map((command) => {
    const arity = command.args === null ? null : parseParameterTypes(command.args);
    return {
      name: command.name,
      arity,
      parameterTypes: arity === null ? null : command.args,
      signatures: [],
      documentation: command.description,
      deprecated: false,
      conditional: false,
      sources: [{ kind: "project", reference: PROJECT_REFERENCE }],
    };
  });
}

/**
 * Construit le registre des commandes d'un serveur rAthena a partir des fichiers de l'utilisateur. Ordre de priorite :
 * commandes du projet, commandes personnalisees du serveur, table du serveur, documentation (qui ne fournit ni nom en plus
 * ni arite quand la table existe).
 */
export function buildRathenaRegistry(inputs: RathenaRegistryInputs): RathenaRegistryReport {
  const warnings: string[] = [];

  let custom: CommandDefinition[] = [];
  if (inputs.customBuiltins != null) {
    const table = parseBuiltinTable(inputs.customBuiltins, RATHENA_PATHS.customBuiltins);
    custom = table.definitions;
    for (const line of table.unrecognized) warnings.push(`${RATHENA_PATHS.customBuiltins} ${line}`);
    for (const entry of table.invalid) warnings.push(`commande ignoree par le serveur : ${entry}`);
  }
  let source: CommandDefinition[] = [];
  if (inputs.builtinSource != null) {
    const table = parseBuiltinTable(inputs.builtinSource, RATHENA_PATHS.builtinSource);
    source = table.definitions;
    for (const line of table.unrecognized) warnings.push(`${RATHENA_PATHS.builtinSource} ${line}`);
    for (const entry of table.invalid) warnings.push(`commande ignoree par le serveur : ${entry}`);
  }
  let documented: CommandDefinition[] = [];
  if (inputs.commandDoc != null) documented = parseCommandDoc(inputs.commandDoc, RATHENA_PATHS.commandDoc).definitions;

  const serverDefinitions = [...custom, ...source, ...documented];
  if (serverDefinitions.length === 0) {
    return { registry: null, level: "none", sourceCommands: 0, customCommands: 0, docCommands: 0, projectCommands: 0, sourceOnly: [], docOnly: [], warnings };
  }

  const project = projectDefinitions(inputs.projectCommands ?? []);
  const sourceKeys = new Set(source.map((definition) => commandKey(definition.name)));
  const docKeys = new Set(documented.map((definition) => commandKey(definition.name)));
  const hasTable = source.length > 0;
  return {
    registry: CommandRegistry.create([...project, ...serverDefinitions], RATHENA_PROFILE_LABEL),
    level: hasTable ? "server-source" : "server-doc",
    sourceCommands: source.length,
    customCommands: custom.length,
    docCommands: documented.length,
    projectCommands: project.length,
    sourceOnly: hasTable && documented.length > 0 ? source.filter((d) => !docKeys.has(commandKey(d.name))).map((d) => d.name) : [],
    docOnly: hasTable && documented.length > 0 ? documented.filter((d) => !sourceKeys.has(commandKey(d.name))).map((d) => d.name) : [],
    warnings,
  };
}
