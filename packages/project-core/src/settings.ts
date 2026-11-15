/** Preferences de l'application (documents `settings`), toujours normalisees : jamais d'exception sur une entree corrompue. */

export type LanguageSetting = "system" | "fr" | "en";
export type ThemeSetting = "system" | "light" | "dark";
export type WhitespaceSetting = "none" | "boundary" | "all";
export type UpdateChannelSetting = "stable" | "beta";

/**
 * Depot des releases dont l'application se met a jour (`proprietaire/depot`). Valeur par defaut des nouveaux profils : le depot
 * d'ou viennent les versions distribuees (voir docs/RELEASE.md) ; l'utilisateur peut le changer dans les reglages.
 */
export const DEFAULT_UPDATE_REPOSITORY = "vazan/KingdomOfValhalla";

/** Memes regles que le coeur natif (`RepoRef::parse`) : deux noms de caracteres GitHub separes par `/`, jamais un chemin. */
export function isUpdateRepository(text: string): boolean {
  const parts = text.trim().split("/");
  if (parts.length !== 2) return false;
  const valid = (part: string, max: number): boolean => part.length > 0 && part.length <= max && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part);
  return valid(parts[0] ?? "", 39) && valid(parts[1] ?? "", 100);
}

export interface Settings {
  readonly version: 1;
  readonly language: LanguageSetting;
  readonly theme: ThemeSetting;
  /** Vrai une fois l'ecran d'accueil de premier lancement passe. */
  readonly onboardingDone: boolean;
  readonly editor: {
    readonly fontSize: number;
    readonly tabSize: number;
    readonly insertSpaces: boolean;
    readonly wordWrap: boolean;
    readonly minimap: boolean;
    readonly renderWhitespace: WhitespaceSetting;
  };
  readonly recovery: {
    /** Delai (ms) apres la derniere frappe avant d'ecrire un instantane de recuperation. */
    readonly snapshotDelayMs: number;
  };
  /** Configuration du fournisseur IA; la cle API reste volatile et n'est jamais enregistree ici. */
  readonly ai: {
    readonly endpoint: string;
    readonly model: string;
  };
  /** Journal local de diagnostic : desactive par defaut, sans source ni chemin (CLAUDE.md 4). */
  readonly logging: { readonly enabled: boolean };
  /**
   * Mises a jour signees (DEC-046) : jamais automatiques, l'utilisateur lance chaque controle. Le jeton d'acces d'un depot prive reste
   * en memoire et n'est jamais enregistre ici.
   */
  readonly updates: {
    readonly repository: string;
    readonly channel: UpdateChannelSetting;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  language: "system",
  theme: "system",
  onboardingDone: false,
  editor: { fontSize: 14, tabSize: 4, insertSpaces: false, wordWrap: false, minimap: true, renderWhitespace: "boundary" },
  recovery: { snapshotDelayMs: 1500 },
  ai: { endpoint: "http://localhost:1234/v1", model: "" },
  logging: { enabled: false },
  updates: { repository: DEFAULT_UPDATE_REPOSITORY, channel: "stable" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function boundedString(value: unknown, maxLength: number, fallback: string): string {
  return typeof value === "string" && value.length <= maxLength ? value : fallback;
}

export function normalizeSettings(input: unknown): Settings {
  const raw = isRecord(input) ? input : {};
  const editor = isRecord(raw["editor"]) ? raw["editor"] : {};
  const recovery = isRecord(raw["recovery"]) ? raw["recovery"] : {};
  const ai = isRecord(raw["ai"]) ? raw["ai"] : {};
  const logging = isRecord(raw["logging"]) ? raw["logging"] : {};
  const updates = isRecord(raw["updates"]) ? raw["updates"] : {};
  const repository = typeof updates["repository"] === "string" ? updates["repository"].trim() : "";
  const defaults = DEFAULT_SETTINGS;
  return {
    version: 1,
    language: pick(raw["language"], ["system", "fr", "en"], defaults.language),
    theme: pick(raw["theme"], ["system", "light", "dark"], defaults.theme),
    onboardingDone: bool(raw["onboardingDone"], defaults.onboardingDone),
    editor: {
      fontSize: clampInt(editor["fontSize"], 8, 40, defaults.editor.fontSize),
      tabSize: clampInt(editor["tabSize"], 1, 8, defaults.editor.tabSize),
      insertSpaces: bool(editor["insertSpaces"], defaults.editor.insertSpaces),
      wordWrap: bool(editor["wordWrap"], defaults.editor.wordWrap),
      minimap: bool(editor["minimap"], defaults.editor.minimap),
      renderWhitespace: pick(editor["renderWhitespace"], ["none", "boundary", "all"], defaults.editor.renderWhitespace),
    },
    recovery: { snapshotDelayMs: clampInt(recovery["snapshotDelayMs"], 300, 60_000, defaults.recovery.snapshotDelayMs) },
    ai: {
      endpoint: boundedString(ai["endpoint"], 2_048, defaults.ai.endpoint),
      model: boundedString(ai["model"], 256, defaults.ai.model),
    },
    logging: { enabled: bool(logging["enabled"], defaults.logging.enabled) },
    updates: {
      repository: isUpdateRepository(repository) ? repository : defaults.updates.repository,
      channel: pick(updates["channel"], ["stable", "beta"], defaults.updates.channel),
    },
  };
}

/** Langue effective a partir du reglage et de la langue du systeme (`navigator.language`). */
export function resolveLanguage(setting: LanguageSetting, systemLanguage: string): "fr" | "en" {
  if (setting !== "system") return setting;
  return systemLanguage.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function resolveTheme(setting: ThemeSetting, systemPrefersDark: boolean): "light" | "dark" {
  if (setting !== "system") return setting;
  return systemPrefersDark ? "dark" : "light";
}
