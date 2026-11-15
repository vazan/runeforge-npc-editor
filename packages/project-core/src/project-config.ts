import { parseParameterTypes } from "@runeforge/emulator-core";

/**
 * Configuration d'un projet RuneForge : `.runeforge/project.json` (CLAUDE.md 9.1).
 * Format propre a RuneForge (pas une configuration rAthena/Hercules), versionne et migrable.
 * Les cles inconnues sont conservees a la reecriture (compatibilite ascendante).
 */

export type EmulatorFamily = "rathena" | "hercules";
/**
 * Mode de compilation du serveur : `auto` le deduit de ses fichiers (rAthena : `src/config/renewal.hpp`), les deux autres
 * l'imposent. Il determine quels scripts le serveur charge (`npc/re/` ou `npc/pre-re/`).
 */
export type EmulatorMode = "auto" | "renewal" | "pre-renewal";
/**
 * Fichiers de script que l'application indexe :
 * - `sources` (defaut) : ceux que designent les motifs de `sources` ;
 * - `loaded` : seulement ceux que le serveur charge reellement (lus dans ses fichiers `scripts_*.conf`), ce qui rend fiables
 *   les verifications entre fichiers. Sans serveur reconnu, retombe sur `sources`.
 */
export type IndexScope = "sources" | "loaded";
export type UnknownCommandPolicy = "off" | "info" | "warning" | "error";
/**
 * Verifications entre fichiers du projet :
 * - `off` (defaut) : aucune ;
 * - `duplicates` : fonctions et noms de NPC definis plusieurs fois ;
 * - `all` : en plus, appels `callfunc` et `duplicate()` dont la cible est introuvable. A n'activer que si `sources`
 *   designe exactement les fichiers charges par le serveur (sinon, fausses alertes).
 */
export type CrossFileChecks = "off" | "duplicates" | "all";

/**
 * Commande propre a un fork, declaree dans le projet sans toucher au serveur (RF-011). Elle complete le registre du serveur :
 * elle n'est plus signalee comme inconnue, se propose a la completion et se documente au survol, marquee « personnalisee ».
 */
export interface CustomCommandConfig {
  /** Mot (lettres, chiffres, `_`), insensible a la casse comme sur le serveur. */
  readonly name: string;
  /** Notation compacte des arguments du serveur (`s?`, `i*`...) ; `null` : nombre d'arguments non verifie. */
  readonly args: string | null;
  /** Aide libre affichee au survol. */
  readonly description: string | null;
}

/** Nombre maximal de commandes personnalisees lues (au-dela, ignorees avec un avertissement). */
export const MAX_CUSTOM_COMMANDS = 1000;
const MAX_COMMAND_NAME = 64;
const MAX_COMMAND_DESCRIPTION = 500;
const COMMAND_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Un nom de commande valide : un mot de 64 caracteres au plus qui ne commence pas par un chiffre. */
export function isCommandName(name: string): boolean {
  return name.length <= MAX_COMMAND_NAME && COMMAND_NAME.test(name);
}

export interface ProjectConfig {
  readonly schemaVersion: 1;
  readonly projectName: string;
  readonly emulator: {
    readonly family: EmulatorFamily;
    readonly version: string;
    readonly revision: string | null;
    /**
     * Racine du serveur (celle qui contient `conf/`, `npc/`, `doc/`), relative a la racine du projet, avec `/`.
     * Vide : l'application la cherche (la racine du projet, puis un unique serveur dans ses sous-dossiers).
     */
    readonly root: string;
    readonly mode: EmulatorMode;
    readonly indexScope: IndexScope;
  };
  /** Motifs glob (relatifs a la racine) des fichiers de script. */
  readonly sources: readonly string[];
  readonly exclude: readonly string[];
  /** Dossiers contenant les bases de donnees du serveur (relatifs a la racine). */
  readonly databasePaths: readonly string[];
  readonly validation: {
    readonly unknownCommands: UnknownCommandPolicy;
    /** Gravite des alertes d'objet, de monstre ou de carte introuvable (`RA0008`-`RA0010`). */
    readonly unknownReferences: UnknownCommandPolicy;
    readonly crossFile: CrossFileChecks;
  };
  readonly commands: { readonly custom: readonly CustomCommandConfig[] };
  readonly constants: { readonly custom: readonly CustomConstantConfig[] };
  readonly encoding: { readonly legacy: string };
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export type ConfigParseResult =
  | { readonly ok: true; readonly config: ProjectConfig; readonly raw: Record<string, unknown>; readonly warnings: ConfigIssue[] }
  | { readonly ok: false; readonly errors: ConfigIssue[] };

export const CURRENT_SCHEMA_VERSION = 1;
export const PROJECT_CONFIG_PATH = ".runeforge/project.json";
export const PROJECT_CONFIG_DIRECTORY = ".runeforge";

const DEFAULT_EXCLUDE: readonly string[] = ["**/node_modules/**", "**/.git/**", "**/.runeforge/**"];

export function defaultProjectConfig(projectName: string, family: EmulatorFamily = "rathena"): ProjectConfig {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectName,
    emulator: { family, version: "custom", revision: null, root: "", mode: "auto", indexScope: "sources" },
    sources: ["**/*.txt"],
    exclude: DEFAULT_EXCLUDE,
    databasePaths: ["db"],
    validation: { unknownCommands: "warning", unknownReferences: "info", crossFile: "off" },
    commands: { custom: [] },
    constants: { custom: [] },
    encoding: { legacy: "windows-1252" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Un motif est refuse s'il est absolu, vide, ou remonte hors de la racine. */
function safeGlob(pattern: string): boolean {
  if (pattern.trim() === "") return false;
  const normalized = pattern.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

/**
 * Dossier relatif a la racine du projet : separateurs `/`, sans `./` initial ni `/` final. Vide = racine. `null` si le
 * chemin est absolu ou remonte hors de la racine.
 */
export function normalizeRelativeDirectory(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return null;
  return segments.join("/");
}

function parseCustomCommands(value: unknown, issues: ConfigIssue[]): CustomCommandConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path: "commands.custom", message: "doit etre une liste ; ignoree" });
    return [];
  }
  const seen = new Set<string>();
  const commands: CustomCommandConfig[] = [];
  let limitReported = false;
  value.forEach((entry: unknown, index) => {
    const path = `commands.custom[${index}]`;
    if (commands.length >= MAX_CUSTOM_COMMANDS) {
      if (!limitReported) issues.push({ path: "commands.custom", message: `${MAX_CUSTOM_COMMANDS} commandes au plus : les suivantes sont ignorees` });
      limitReported = true;
      return;
    }
    if (!isRecord(entry)) {
      issues.push({ path, message: "doit etre un objet { name, args?, description? } ; ignoree" });
      return;
    }
    const name = entry["name"];
    if (typeof name !== "string" || !isCommandName(name)) {
      issues.push({ path: `${path}.name`, message: "nom invalide (lettres, chiffres et _, sans commencer par un chiffre) ; commande ignoree" });
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      issues.push({ path: `${path}.name`, message: `${name} est deja declaree (les noms sont insensibles a la casse) ; doublon ignore` });
      return;
    }
    seen.add(key);
    let args: string | null = null;
    const rawArgs = entry["args"];
    if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
      const trimmed = rawArgs.trim();
      if (parseParameterTypes(trimmed) !== null) args = trimmed;
      else issues.push({ path: `${path}.args`, message: "notation invalide (v, s, i, r, l, puis ?, puis *) : nombre d'arguments non verifie" });
    } else if (rawArgs !== undefined && rawArgs !== null && rawArgs !== "") {
      issues.push({ path: `${path}.args`, message: "doit etre une chaine : nombre d'arguments non verifie" });
    }
    const rawDescription = entry["description"];
    const description = typeof rawDescription === "string" && rawDescription.trim() !== "" ? rawDescription.trim().slice(0, MAX_COMMAND_DESCRIPTION) : null;
    commands.push({ name, args, description });
  });
  return commands;
}

/** Une commande par ligne : `nom` ou `nom arguments` (`mycmd s?`), pour l'edition dans les parametres du projet. */
export function formatCustomCommands(commands: readonly CustomCommandConfig[]): string {
  return commands.map((command) => (command.args === null ? command.name : `${command.name} ${command.args}`)).join("\n");
}

export interface CustomCommandLines {
  readonly commands: CustomCommandConfig[];
  /** Lignes refusees (numero en base 1), avec la raison. */
  readonly errors: { readonly line: number; readonly text: string; readonly reason: "name" | "arguments" | "extra" | "duplicate" }[];
}

/**
 * Lit les lignes `nom [arguments]` ; les lignes vides et celles qui commencent par `#` ou `//` sont ignorees. L'aide
 * (`description`) d'une commande deja declaree est conservee : elle ne s'edite que dans `project.json`.
 */
export function parseCustomCommandLines(text: string, previous: readonly CustomCommandConfig[]): CustomCommandLines {
  const commands: CustomCommandConfig[] = [];
  const errors: CustomCommandLines["errors"][number][] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) return;
    const [name, args, ...rest] = line.split(/\s+/);
    if (name === undefined || !isCommandName(name)) {
      errors.push({ line: index + 1, text: line, reason: "name" });
    } else if (rest.length > 0) {
      errors.push({ line: index + 1, text: line, reason: "extra" });
    } else if (args !== undefined && parseParameterTypes(args) === null) {
      errors.push({ line: index + 1, text: line, reason: "arguments" });
    } else if (seen.has(name.toLowerCase())) {
      errors.push({ line: index + 1, text: line, reason: "duplicate" });
    } else {
      seen.add(name.toLowerCase());
      const known = previous.find((command) => command.name.toLowerCase() === name.toLowerCase());
      commands.push({ name, args: args ?? null, description: known?.description ?? null });
    }
  });
  if (commands.length > MAX_CUSTOM_COMMANDS) commands.length = MAX_CUSTOM_COMMANDS;
  return { commands, errors };
}

/**
 * Constante propre a un fork ou au projet, declaree sans toucher au serveur : elle complete celles du serveur (qui l'emportent
 * en cas de meme nom), se propose a la completion et se decrit au survol.
 */
export interface CustomConstantConfig {
  /** Mot (lettres, chiffres, `_`) ; comme sur le serveur, il peut commencer par un chiffre. */
  readonly name: string;
  /** Valeur entiere quand elle est connue ; `null` sinon. */
  readonly value: number | null;
}

/** Nombre maximal de constantes personnalisees lues (au-dela, ignorees avec un avertissement). */
export const MAX_CUSTOM_CONSTANTS = 1000;
const CONSTANT_NAME = /^[A-Za-z0-9_]+$/;

/** Un nom de constante valide : un mot de 64 caracteres au plus, lettres, chiffres et `_`. */
export function isConstantName(name: string): boolean {
  return name.length <= MAX_COMMAND_NAME && CONSTANT_NAME.test(name);
}

function parseCustomConstants(value: unknown, issues: ConfigIssue[]): CustomConstantConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path: "constants.custom", message: "doit etre une liste ; ignoree" });
    return [];
  }
  const seen = new Set<string>();
  const constants: CustomConstantConfig[] = [];
  let limitReported = false;
  value.forEach((entry: unknown, index) => {
    const path = `constants.custom[${index}]`;
    if (constants.length >= MAX_CUSTOM_CONSTANTS) {
      if (!limitReported) issues.push({ path: "constants.custom", message: `${MAX_CUSTOM_CONSTANTS} constantes au plus : les suivantes sont ignorees` });
      limitReported = true;
      return;
    }
    if (!isRecord(entry)) {
      issues.push({ path, message: "doit etre un objet { name, value? } ; ignoree" });
      return;
    }
    const name = entry["name"];
    if (typeof name !== "string" || !isConstantName(name)) {
      issues.push({ path: `${path}.name`, message: "nom invalide (lettres, chiffres et _) ; constante ignoree" });
      return;
    }
    if (seen.has(name.toLowerCase())) {
      issues.push({ path: `${path}.name`, message: `${name} est deja declaree (les noms sont insensibles a la casse) ; doublon ignore` });
      return;
    }
    seen.add(name.toLowerCase());
    const raw = entry["value"];
    let constantValue: number | null = null;
    if (typeof raw === "number" && Number.isInteger(raw)) constantValue = raw;
    else if (raw !== undefined && raw !== null) issues.push({ path: `${path}.value`, message: "doit etre un entier : valeur ignoree" });
    constants.push({ name, value: constantValue });
  });
  return constants;
}

/** Une constante par ligne : `NOM` ou `NOM valeur`, pour l'edition dans les parametres du projet. */
export function formatCustomConstants(constants: readonly CustomConstantConfig[]): string {
  return constants.map((constant) => (constant.value === null ? constant.name : `${constant.name} ${constant.value}`)).join("\n");
}

export interface CustomConstantLines {
  readonly constants: CustomConstantConfig[];
  /** Lignes refusees (numero en base 1), avec la raison. */
  readonly errors: { readonly line: number; readonly text: string; readonly reason: "name" | "value" | "extra" | "duplicate" }[];
}

/** Lit les lignes `NOM [valeur]` ; les lignes vides et celles qui commencent par `#` ou `//` sont ignorees. */
export function parseCustomConstantLines(text: string): CustomConstantLines {
  const constants: CustomConstantConfig[] = [];
  const errors: CustomConstantLines["errors"][number][] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) return;
    const [name, value, ...rest] = line.split(/\s+/);
    if (name === undefined || !isConstantName(name)) {
      errors.push({ line: index + 1, text: line, reason: "name" });
    } else if (rest.length > 0) {
      errors.push({ line: index + 1, text: line, reason: "extra" });
    } else if (value !== undefined && !/^-?\d+$/.test(value)) {
      errors.push({ line: index + 1, text: line, reason: "value" });
    } else if (seen.has(name.toLowerCase())) {
      errors.push({ line: index + 1, text: line, reason: "duplicate" });
    } else {
      seen.add(name.toLowerCase());
      constants.push({ name, value: value === undefined ? null : Number(value) });
    }
  });
  if (constants.length > MAX_CUSTOM_CONSTANTS) constants.length = MAX_CUSTOM_CONSTANTS;
  return { constants, errors };
}

function stringList(
  value: unknown,
  path: string,
  fallback: readonly string[],
  issues: ConfigIssue[],
  check: (item: string) => boolean,
): readonly string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "doit etre une liste de chaines ; valeur par defaut utilisee" });
    return fallback;
  }
  const kept: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && check(item)) kept.push(item);
    else issues.push({ path, message: `entree ignoree : ${JSON.stringify(item)}` });
  }
  return kept;
}

export function parseProjectConfig(text: string): ConfigParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [{ path: "", message: `JSON invalide : ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: [{ path: "", message: "le document doit etre un objet JSON" }] };

  const warnings: ConfigIssue[] = [];
  const version = parsed["schemaVersion"];
  if (version === undefined) {
    warnings.push({ path: "schemaVersion", message: "absent : version 1 supposee" });
  } else if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, errors: [{ path: "schemaVersion", message: "doit etre un entier >= 1" }] };
  } else if (version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [{ path: "schemaVersion", message: `cree par une version plus recente (${version}) ; mettez RuneForge Studio a jour` }],
    };
  }

  const defaults = defaultProjectConfig("");
  const emulatorRaw = isRecord(parsed["emulator"]) ? parsed["emulator"] : {};
  if (!isRecord(parsed["emulator"])) warnings.push({ path: "emulator", message: "absent : profil rathena par defaut" });
  let family: EmulatorFamily = defaults.emulator.family;
  if (emulatorRaw["family"] === "rathena" || emulatorRaw["family"] === "hercules") {
    family = emulatorRaw["family"];
  } else if (emulatorRaw["family"] !== undefined) {
    warnings.push({ path: "emulator.family", message: "valeur inconnue : rathena utilise" });
  }
  let root = defaults.emulator.root;
  if (typeof emulatorRaw["root"] === "string") {
    const normalized = normalizeRelativeDirectory(emulatorRaw["root"]);
    if (normalized === null) warnings.push({ path: "emulator.root", message: "chemin absolu ou hors du projet : detection automatique utilisee" });
    else root = normalized;
  } else if (emulatorRaw["root"] !== undefined) {
    warnings.push({ path: "emulator.root", message: "doit etre une chaine ; detection automatique utilisee" });
  }
  const modeRaw = emulatorRaw["mode"];
  const mode: EmulatorMode = modeRaw === "auto" || modeRaw === "renewal" || modeRaw === "pre-renewal" ? modeRaw : defaults.emulator.mode;
  if (modeRaw !== undefined && mode !== modeRaw) warnings.push({ path: "emulator.mode", message: "valeur inconnue : auto utilise" });
  const scopeRaw = emulatorRaw["indexScope"];
  const indexScope: IndexScope = scopeRaw === "sources" || scopeRaw === "loaded" ? scopeRaw : defaults.emulator.indexScope;
  if (scopeRaw !== undefined && indexScope !== scopeRaw) warnings.push({ path: "emulator.indexScope", message: "valeur inconnue : sources utilise" });
  const validationRaw = isRecord(parsed["validation"]) ? parsed["validation"] : {};
  const policy = validationRaw["unknownCommands"];
  const unknownCommands: UnknownCommandPolicy =
    policy === "off" || policy === "info" || policy === "warning" || policy === "error" ? policy : defaults.validation.unknownCommands;
  if (policy !== undefined && unknownCommands !== policy) {
    warnings.push({ path: "validation.unknownCommands", message: "valeur inconnue : warning utilise" });
  }
  const referencesRaw = validationRaw["unknownReferences"];
  const unknownReferences: UnknownCommandPolicy =
    referencesRaw === "off" || referencesRaw === "info" || referencesRaw === "warning" || referencesRaw === "error"
      ? referencesRaw
      : defaults.validation.unknownReferences;
  if (referencesRaw !== undefined && unknownReferences !== referencesRaw) {
    warnings.push({ path: "validation.unknownReferences", message: "valeur inconnue : info utilise" });
  }
  const crossFileRaw = validationRaw["crossFile"];
  const crossFile: CrossFileChecks =
    crossFileRaw === "off" || crossFileRaw === "duplicates" || crossFileRaw === "all" ? crossFileRaw : defaults.validation.crossFile;
  if (crossFileRaw !== undefined && crossFile !== crossFileRaw) {
    warnings.push({ path: "validation.crossFile", message: "valeur inconnue : off utilise" });
  }
  const encodingRaw = isRecord(parsed["encoding"]) ? parsed["encoding"] : {};
  const commandsRaw = isRecord(parsed["commands"]) ? parsed["commands"] : {};
  const constantsRaw = isRecord(parsed["constants"]) ? parsed["constants"] : {};

  const config: ProjectConfig = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectName: typeof parsed["projectName"] === "string" && parsed["projectName"].trim() !== "" ? parsed["projectName"] : "Projet",
    emulator: {
      family,
      version: typeof emulatorRaw["version"] === "string" ? emulatorRaw["version"] : defaults.emulator.version,
      revision: typeof emulatorRaw["revision"] === "string" ? emulatorRaw["revision"] : null,
      root,
      mode,
      indexScope,
    },
    sources: stringList(parsed["sources"], "sources", defaults.sources, warnings, safeGlob),
    exclude: stringList(parsed["exclude"], "exclude", defaults.exclude, warnings, safeGlob),
    databasePaths: stringList(parsed["databasePaths"], "databasePaths", defaults.databasePaths, warnings, safeGlob),
    validation: { unknownCommands, unknownReferences, crossFile },
    commands: { custom: parseCustomCommands(commandsRaw["custom"], warnings) },
    constants: { custom: parseCustomConstants(constantsRaw["custom"], warnings) },
    encoding: { legacy: typeof encodingRaw["legacy"] === "string" && encodingRaw["legacy"] !== "" ? encodingRaw["legacy"] : defaults.encoding.legacy },
  };
  return { ok: true, config, raw: parsed, warnings };
}

/** JSON indente, termine par un saut de ligne ; les cles inconnues de `raw` sont conservees. */
export function serializeProjectConfig(config: ProjectConfig, raw: Record<string, unknown> = {}): string {
  const known = {
    schemaVersion: config.schemaVersion,
    projectName: config.projectName,
    emulator: { ...(isRecord(raw["emulator"]) ? raw["emulator"] : {}), ...config.emulator },
    sources: config.sources,
    exclude: config.exclude,
    databasePaths: config.databasePaths,
    validation: { ...(isRecord(raw["validation"]) ? raw["validation"] : {}), ...config.validation },
    commands: {
      ...(isRecord(raw["commands"]) ? raw["commands"] : {}),
      custom: config.commands.custom.map((command) => ({
        name: command.name,
        ...(command.args === null ? {} : { args: command.args }),
        ...(command.description === null ? {} : { description: command.description }),
      })),
    },
    constants: {
      ...(isRecord(raw["constants"]) ? raw["constants"] : {}),
      custom: config.constants.custom.map((constant) => ({ name: constant.name, ...(constant.value === null ? {} : { value: constant.value }) })),
    },
    encoding: { ...(isRecord(raw["encoding"]) ? raw["encoding"] : {}), ...config.encoding },
  };
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in known)) unknown[key] = value;
  }
  return `${JSON.stringify({ ...known, ...unknown }, null, 2)}\n`;
}
