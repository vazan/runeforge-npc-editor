import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_UPDATE_REPOSITORY,
  EMPTY_SESSION,
  defaultProjectConfig,
  formatCustomCommands,
  formatCustomConstants,
  isCommandName,
  isConstantName,
  parseCustomCommandLines,
  parseCustomConstantLines,
  normalizeSession,
  normalizeSettings,
  parseProjectConfig,
  resolveLanguage,
  resolveTheme,
  serializeProjectConfig,
} from "./index";

const SPEC_EXAMPLE = `{
  "schemaVersion": 1,
  "projectName": "My Server",
  "emulator": { "family": "rathena", "version": "custom", "revision": null },
  "sources": ["npc/**/*.txt"],
  "exclude": ["**/node_modules/**", "**/.git/**"],
  "databasePaths": ["db"],
  "validation": { "unknownCommands": "warning" }
}`;

describe("parseProjectConfig", () => {
  it("lit l'exemple du cahier des charges sans avertissement", () => {
    const result = parseProjectConfig(SPEC_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.config).toMatchObject({
      projectName: "My Server",
      emulator: { family: "rathena", version: "custom", revision: null },
      sources: ["npc/**/*.txt"],
      validation: { unknownCommands: "warning" },
      encoding: { legacy: "windows-1252" },
    });
  });

  it("complete les valeurs absentes et signale les anomalies sans echouer", () => {
    const result = parseProjectConfig('{ "emulator": { "family": "mystery" }, "validation": { "unknownCommands": "loud" } }');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.emulator.family).toBe("rathena");
    expect(result.config.validation.unknownCommands).toBe("warning");
    expect(result.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining(["schemaVersion", "emulator.family", "validation.unknownCommands"]),
    );
  });

  it("lit validation.crossFile, le met a off par defaut et signale une valeur inconnue", () => {
    const absent = parseProjectConfig(SPEC_EXAMPLE);
    if (!absent.ok) throw new Error("echec");
    expect(absent.config.validation.crossFile).toBe("off");
    for (const value of ["off", "duplicates", "all"] as const) {
      const result = parseProjectConfig(`{ "schemaVersion": 1, "validation": { "crossFile": "${value}" } }`);
      expect(result.ok && result.config.validation.crossFile).toBe(value);
    }
    const unknown = parseProjectConfig('{ "schemaVersion": 1, "validation": { "crossFile": "everything" } }');
    expect(unknown.ok && unknown.config.validation.crossFile).toBe("off");
    expect(unknown.ok && unknown.warnings.map((w) => w.path)).toContain("validation.crossFile");
  });

  it("lit la racine du serveur, le mode de compilation et la portee de l'index, avec des valeurs par defaut sures", () => {
    const absent = parseProjectConfig(SPEC_EXAMPLE);
    if (!absent.ok) throw new Error("echec");
    expect(absent.config.emulator).toMatchObject({ root: "", mode: "auto", indexScope: "sources" });

    const given = parseProjectConfig(
      '{ "schemaVersion": 1, "emulator": { "family": "rathena", "root": ".\\\\Serveur//rathena-kov/", "mode": "pre-renewal", "indexScope": "loaded" } }',
    );
    if (!given.ok) throw new Error("echec");
    expect(given.warnings).toEqual([]);
    expect(given.config.emulator).toMatchObject({ root: "Serveur/rathena-kov", mode: "pre-renewal", indexScope: "loaded" });
  });

  it("ecarte une racine de serveur absolue ou hors du projet, un mode ou une portee inconnus", () => {
    for (const root of ["/etc", "C:\\\\Serveur", "../autre", "a/../../b"]) {
      const result = parseProjectConfig(JSON.stringify({ schemaVersion: 1, emulator: { root } }));
      if (!result.ok) throw new Error("echec");
      expect(result.config.emulator.root).toBe("");
      expect(result.warnings.map((w) => w.path)).toContain("emulator.root");
    }
    const odd = parseProjectConfig('{ "schemaVersion": 1, "emulator": { "root": 3, "mode": "turbo", "indexScope": "all" } }');
    if (!odd.ok) throw new Error("echec");
    expect(odd.config.emulator).toMatchObject({ root: "", mode: "auto", indexScope: "sources" });
    expect(odd.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(["emulator.root", "emulator.mode", "emulator.indexScope"]));
  });

  it("conserve les reglages de serveur a la reecriture sans toucher aux cles inconnues", () => {
    const parsed = parseProjectConfig('{ "schemaVersion": 1, "emulator": { "root": "srv", "mode": "renewal", "indexScope": "loaded", "futureKey": 1 } }');
    if (!parsed.ok) throw new Error("echec");
    const rewritten = JSON.parse(serializeProjectConfig(parsed.config, parsed.raw)) as { emulator: Record<string, unknown> };
    expect(rewritten.emulator).toMatchObject({ root: "srv", mode: "renewal", indexScope: "loaded", futureKey: 1 });
  });

  it("lit les commandes personnalisees : nom, notation des arguments, aide ; vide par defaut", () => {
    const absent = parseProjectConfig(SPEC_EXAMPLE);
    if (!absent.ok) throw new Error("echec");
    expect(absent.config.commands).toEqual({ custom: [] });
    const result = parseProjectConfig(
      JSON.stringify({
        schemaVersion: 1,
        commands: { custom: [{ name: "mycmd", args: " s? ", description: "  Fait ceci.  " }, { name: "Autre" }, { name: "x", args: "", description: "" }] },
      }),
    );
    if (!result.ok) throw new Error("echec");
    expect(result.warnings.filter((w) => w.path.startsWith("commands"))).toEqual([]);
    expect(result.config.commands.custom).toEqual([
      { name: "mycmd", args: "s?", description: "Fait ceci." },
      { name: "Autre", args: null, description: null },
      { name: "x", args: null, description: null },
    ]);
  });

  it("ecarte les commandes invalides, en double ou mal notees, avec un avertissement chacune", () => {
    const result = parseProjectConfig(
      JSON.stringify({
        schemaVersion: 1,
        commands: {
          custom: [
            { name: "ok" },
            { name: "1abc" },
            { name: "avec espace" },
            { name: "" },
            { nom: "x" },
            "pas un objet",
            { name: "OK" },
            { name: "mauvaise", args: "zz" },
            { name: "pasunechaine", args: 3 },
            { name: "a".repeat(65) },
          ],
        },
      }),
    );
    if (!result.ok) throw new Error("echec");
    expect(result.config.commands.custom.map((c) => [c.name, c.args])).toEqual([
      ["ok", null],
      ["mauvaise", null],
      ["pasunechaine", null],
    ]);
    expect(result.warnings.map((w) => w.path).filter((path) => path.startsWith("commands"))).toEqual([
      "commands.custom[1].name",
      "commands.custom[2].name",
      "commands.custom[3].name",
      "commands.custom[4].name",
      "commands.custom[5]",
      "commands.custom[6].name",
      "commands.custom[7].args",
      "commands.custom[8].args",
      "commands.custom[9].name",
    ]);
    const notAList = parseProjectConfig('{ "schemaVersion": 1, "commands": { "custom": "x" } }');
    expect(notAList.ok && notAList.warnings.map((w) => w.path).filter((path) => path.startsWith("commands"))).toEqual(["commands.custom"]);
  });

  it("borne le nombre de commandes personnalisees et le dit une seule fois", () => {
    const many = Array.from({ length: 1005 }, (_, i) => ({ name: `cmd${i}` }));
    const result = parseProjectConfig(JSON.stringify({ schemaVersion: 1, commands: { custom: many } }));
    if (!result.ok) throw new Error("echec");
    expect(result.config.commands.custom).toHaveLength(1000);
    expect(result.warnings.filter((w) => w.path === "commands.custom")).toHaveLength(1);
  });

  it("reecrit les commandes personnalisees sans valeur nulle et sans perdre les cles inconnues", () => {
    const parsed = parseProjectConfig(
      JSON.stringify({ schemaVersion: 1, commands: { future: true, custom: [{ name: "a", args: "i" }, { name: "b", description: "Aide" }, { name: "c" }] } }),
    );
    if (!parsed.ok) throw new Error("echec");
    const rewritten = JSON.parse(serializeProjectConfig(parsed.config, parsed.raw)) as { commands: Record<string, unknown> };
    expect(rewritten.commands).toEqual({ future: true, custom: [{ name: "a", args: "i" }, { name: "b", description: "Aide" }, { name: "c" }] });
  });

  it("conserve validation.crossFile a la reecriture", () => {
    const parsed = parseProjectConfig('{ "schemaVersion": 1, "validation": { "crossFile": "all", "futureRule": true } }');
    if (!parsed.ok) throw new Error("echec");
    const rewritten = JSON.parse(serializeProjectConfig(parsed.config, parsed.raw)) as { validation: Record<string, unknown> };
    expect(rewritten.validation).toMatchObject({ crossFile: "all", unknownCommands: "warning", futureRule: true });
  });

  it("refuse un JSON invalide, un non-objet et une version plus recente", () => {
    expect(parseProjectConfig("{ nope").ok).toBe(false);
    expect(parseProjectConfig("[]").ok).toBe(false);
    const newer = parseProjectConfig('{ "schemaVersion": 2 }');
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.errors[0]?.message).toContain("plus recente");
    expect(parseProjectConfig('{ "schemaVersion": 0 }').ok).toBe(false);
    expect(parseProjectConfig('{ "schemaVersion": "1" }').ok).toBe(false);
  });

  it("ecarte les motifs absolus ou qui sortent de la racine", () => {
    const result = parseProjectConfig('{ "schemaVersion": 1, "sources": ["npc/**/*.txt", "../outside/*.txt", "/etc/*", "C:\\\\x\\\\*.txt", ""] }');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.sources).toEqual(["npc/**/*.txt"]);
      expect(result.warnings.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("conserve les cles inconnues et les sous-cles inconnues a la reecriture", () => {
    const text = '{ "schemaVersion": 1, "futureFeature": { "x": 1 }, "emulator": { "family": "hercules", "branch": "stable" } }';
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) throw new Error("echec");
    const rewritten = JSON.parse(serializeProjectConfig(parsed.config, parsed.raw)) as Record<string, unknown>;
    expect(rewritten["futureFeature"]).toEqual({ x: 1 });
    expect(rewritten["emulator"]).toMatchObject({ family: "hercules", branch: "stable" });
  });

  it("aller-retour : serialize puis parse redonne la meme configuration", () => {
    const config = defaultProjectConfig("Demo", "hercules");
    const text = serializeProjectConfig(config);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = parseProjectConfig(text);
    expect(parsed.ok && parsed.config).toEqual(config);
  });
});

describe("normalizeSettings", () => {
  it("retourne les valeurs par defaut pour une entree invalide", () => {
    for (const input of [undefined, null, 42, "x", [], {}]) {
      expect(normalizeSettings(input)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("borne les valeurs numeriques et rejette les valeurs hors liste", () => {
    const settings = normalizeSettings({
      language: "de",
      theme: "dark",
      editor: { fontSize: 500, tabSize: 0, wordWrap: "yes", renderWhitespace: "all" },
      recovery: { snapshotDelayMs: 5 },
      ai: { endpoint: "http://10.10.11.74:8000/v1", model: "local-model" },
      logging: { enabled: true },
    });
    expect(settings.language).toBe("system");
    expect(settings.theme).toBe("dark");
    expect(settings.editor).toMatchObject({ fontSize: 40, tabSize: 1, wordWrap: false, renderWhitespace: "all" });
    expect(settings.recovery.snapshotDelayMs).toBe(300);
    expect(settings.ai).toEqual({ endpoint: "http://10.10.11.74:8000/v1", model: "local-model" });
    expect(settings.logging.enabled).toBe(true);
  });

  it("uses safe AI defaults for malformed or oversized provider settings", () => {
    expect(normalizeSettings({ ai: { endpoint: 42, model: "m".repeat(257) } }).ai).toEqual(DEFAULT_SETTINGS.ai);
  });

  it("keeps a valid update repository and channel, trims the repository, and falls back to the defaults otherwise", () => {
    expect(normalizeSettings({ updates: { repository: "  acme/studio-releases ", channel: "beta" } }).updates).toEqual({ repository: "acme/studio-releases", channel: "beta" });
    expect(normalizeSettings({}).updates).toEqual({ repository: DEFAULT_UPDATE_REPOSITORY, channel: "stable" });
    for (const repository of ["", "norepo", "a/b/c", "../x", "a/..", "./b", "a b/c", "a/b c", "https://github.com/a/b", "a/b/", 5, null, "o".repeat(40) + "/r", "o/" + "r".repeat(101)]) {
      expect(normalizeSettings({ updates: { repository, channel: "nightly" } }).updates).toEqual(DEFAULT_SETTINGS.updates);
    }
  });

  it("never stores a token with the update settings", () => {
    const stored = JSON.stringify(normalizeSettings({ updates: { repository: "a/b", channel: "stable", token: "ghp_secret", accessToken: "x" } }));
    expect(stored).not.toContain("ghp_secret");
    expect(Object.keys(normalizeSettings({ updates: { token: "ghp_secret" } }).updates).sort()).toEqual(["channel", "repository"]);
  });

  it("resout langue et theme depuis le systeme", () => {
    expect(resolveLanguage("system", "fr-CA")).toBe("fr");
    expect(resolveLanguage("system", "de-DE")).toBe("en");
    expect(resolveLanguage("en", "fr-FR")).toBe("en");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("normalizeSession", () => {
  it("nettoie les doublons, limite la liste et choisit un fichier actif valide", () => {
    const session = normalizeSession({
      projectPath: "C:\\proj",
      openFiles: ["a.txt", "a.txt", "", 5, "b.txt"],
      activeFile: "zzz.txt",
      expandedDirectories: ["npc", "npc"],
    });
    expect(session).toEqual({ version: 1, projectPath: "C:\\proj", openFiles: ["a.txt", "b.txt"], activeFile: "a.txt", expandedDirectories: ["npc"] });
  });

  it("retourne une session vide pour une entree invalide", () => {
    expect(normalizeSession(null)).toEqual(EMPTY_SESSION);
    expect(normalizeSession("x")).toEqual(EMPTY_SESSION);
    expect(normalizeSession({ openFiles: "nope" })).toMatchObject({ openFiles: [], activeFile: null });
  });
});

describe("commandes personnalisees : edition par lignes", () => {
  it("n'accepte comme noms que des mots qui ne commencent pas par un chiffre", () => {
    for (const name of ["mes", "_x", "A1", "a_b_c"]) expect(isCommandName(name)).toBe(true);
    for (const name of ["", "1a", "a b", "a-b", "a.b", "é", "a".repeat(65)]) expect(isCommandName(name)).toBe(false);
  });

  it("ecrit une commande par ligne, avec ses arguments quand ils sont declares", () => {
    expect(formatCustomCommands([{ name: "a", args: "s?", description: null }, { name: "b", args: null, description: "Aide" }])).toBe("a s?\nb");
    expect(formatCustomCommands([])).toBe("");
  });

  it("lit les lignes, ignore les vides et les commentaires, et garde l'aide deja declaree", () => {
    const previous = [{ name: "Alpha", args: "i", description: "Aide alpha" }];
    const result = parseCustomCommandLines("# mes commandes\n\nalpha s?\n// autre commentaire\r\nbeta\r\n  gamma   i*  \n", previous);
    expect(result.errors).toEqual([]);
    expect(result.commands).toEqual([
      { name: "alpha", args: "s?", description: "Aide alpha" },
      { name: "beta", args: null, description: null },
      { name: "gamma", args: "i*", description: null },
    ]);
  });

  it("refuse chaque ligne invalide en disant laquelle et pourquoi, sans arreter la lecture", () => {
    const result = parseCustomCommandLines("ok\n1mauvais\nb zz\nc s? en trop\nOK\nd\n", []);
    expect(result.commands.map((c) => c.name)).toEqual(["ok", "d"]);
    expect(result.errors).toEqual([
      { line: 2, text: "1mauvais", reason: "name" },
      { line: 3, text: "b zz", reason: "arguments" },
      { line: 4, text: "c s? en trop", reason: "extra" },
      { line: 5, text: "OK", reason: "duplicate" },
    ]);
  });

  it("fait l'aller-retour entre texte et liste", () => {
    const commands = [{ name: "a", args: "s?", description: null }, { name: "b", args: null, description: null }];
    expect(parseCustomCommandLines(formatCustomCommands(commands), commands).commands).toEqual(commands);
  });
});

describe("constantes personnalisees et gravite des references introuvables", () => {
  const withBody = (body: Record<string, unknown>): string => JSON.stringify({ schemaVersion: 1, ...body });

  it("la gravite des alertes de reference vaut `info` par defaut, se lit et se refuse si elle est inconnue", () => {
    expect(defaultProjectConfig("x").validation.unknownReferences).toBe("info");
    const ok = parseProjectConfig(withBody({ validation: { unknownReferences: "warning" } }));
    expect(ok.ok && ok.config.validation.unknownReferences).toBe("warning");
    const bad = parseProjectConfig(withBody({ validation: { unknownReferences: "fatal" } }));
    expect(bad.ok && bad.config.validation.unknownReferences).toBe("info");
    expect(bad.ok && bad.warnings.map((warning) => warning.path).filter((path) => path.startsWith("validation"))).toEqual(["validation.unknownReferences"]);
  });

  it("n'accepte comme noms de constantes que des mots de lettres, chiffres et `_`, y compris commencant par un chiffre", () => {
    expect(isConstantName("MY_EVENT")).toBe(true);
    expect(isConstantName("4_M_01")).toBe(true);
    expect(isConstantName("a-b")).toBe(false);
    expect(isConstantName("a b")).toBe(false);
    expect(isConstantName("")).toBe(false);
    expect(isConstantName("a".repeat(65))).toBe(false);
  });

  it("lit les constantes du projet, ecarte les entrees invalides avec un avertissement et garde la valeur entiere", () => {
    const result = parseProjectConfig(
      withBody({
        constants: {
          custom: [{ name: "EVENT_A", value: 7 }, { name: "EVENT_B" }, { name: "bad name" }, { name: "event_a", value: 1 }, { name: "EVENT_C", value: "x" }, 5],
        },
      }),
    );
    expect(result.ok && result.config.constants.custom).toEqual([
      { name: "EVENT_A", value: 7 },
      { name: "EVENT_B", value: null },
      { name: "EVENT_C", value: null },
    ]);
    expect(result.ok && result.warnings.map((warning) => warning.path).filter((path) => path.startsWith("constants"))).toEqual([
      "constants.custom[2].name",
      "constants.custom[3].name",
      "constants.custom[4].value",
      "constants.custom[5]",
    ]);
  });

  it("reecrit les constantes du projet sans valeur nulle et sans perdre les cles inconnues", () => {
    const parsed = parseProjectConfig(withBody({ constants: { custom: [{ name: "A", value: 1 }, { name: "B" }], keep: true } }));
    if (!parsed.ok) throw new Error("configuration refusee");
    const written = JSON.parse(serializeProjectConfig(parsed.config, parsed.raw)) as { constants: { custom: unknown[]; keep: boolean } };
    expect(written.constants).toEqual({ custom: [{ name: "A", value: 1 }, { name: "B" }], keep: true });
  });

  it("ecrit une constante par ligne et lit les lignes en disant lesquelles sont refusees", () => {
    const constants = [{ name: "A", value: 5 }, { name: "B", value: null }];
    expect(formatCustomConstants(constants)).toBe("A 5\nB");
    expect(parseCustomConstantLines(formatCustomConstants(constants)).constants).toEqual(constants);
    const result = parseCustomConstantLines("# note\n\nOK 3\nbad-name\nC x\nD 1 2\nok 4\n// fin");
    expect(result.constants).toEqual([{ name: "OK", value: 3 }]);
    expect(result.errors).toEqual([
      { line: 4, text: "bad-name", reason: "name" },
      { line: 5, text: "C x", reason: "value" },
      { line: 6, text: "D 1 2", reason: "extra" },
      { line: 7, text: "ok 4", reason: "duplicate" },
    ]);
  });
});
