import { CommandRegistry, ReferenceCatalog } from "@runeforge/emulator-core";
import type { CommandDefinition, DefinitionSourceKind } from "@runeforge/emulator-core";
import { parse } from "@runeforge/runescript-parser";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "./analyze";

function command(name: string, kind: DefinitionSourceKind, conditional = false): CommandDefinition {
  return { name, arity: null, parameterTypes: null, signatures: [], documentation: null, deprecated: false, conditional, sources: [{ kind, reference: "script.cpp:1" }] };
}

const registry = CommandRegistry.create(
  [
    command("mes", "server-source"),
    command("menu", "server-source"),
    command("next", "server-source"),
    command("close", "server-source"),
    command("only_if_compiled", "server-source", true),
    command("only_in_manual", "server-doc"),
    command("my_fork_command", "project"),
  ],
  "rAthena",
);

const catalog = ReferenceCatalog.create(
  {
    constants: [
      { name: "Job_Alchemist", value: null, parameter: false, deprecated: false, source: "src/map/script_constants.hpp:10" },
      { name: "BaseLevel", value: 3, parameter: true, deprecated: false, source: "src/map/script_constants.hpp:20" },
      { name: "MyConstant", value: 7, parameter: false, deprecated: false, source: ".runeforge/project.json", custom: true },
    ],
  },
  "rAthena",
);

interface Found {
  readonly name: unknown;
  readonly text: string;
}

function reserved(body: string, options: { commands?: CommandRegistry | null; references?: ReferenceCatalog | null } = {}): Found[] {
  const source = `prontera,1,1,0\tscript\tT\t100,{\n${body}\n}\n`;
  const analysis = analyzeFile(parse(source), "t.txt", {
    commands: options.commands === undefined ? registry : options.commands,
    references: options.references === undefined ? catalog : options.references,
  });
  return analysis.diagnostics
    .filter((diagnostic) => diagnostic.code === "RA0014")
    .map((diagnostic) => ({ name: diagnostic.params?.["name"], text: source.slice(diagnostic.range.start, diagnostic.range.end) }));
}

describe("RA0014 - label qui porte le nom d'une commande, d'une constante ou d'un parametre du serveur", () => {
  it("signale un label nomme comme une commande de la table du serveur, sur son nom (sans les deux-points)", () => {
    expect(reserved("mes:\n\tclose;")).toEqual([{ name: "mes", text: "mes" }]);
    expect(reserved("L_Ok:\n\tmenu:\n\tclose;")).toEqual([{ name: "menu", text: "menu" }]);
  });

  it("signale un label nomme comme une constante ou un parametre lus dans le serveur", () => {
    expect(reserved("Job_Alchemist:\n\tclose;")).toEqual([{ name: "Job_Alchemist", text: "Job_Alchemist" }]);
    expect(reserved("BaseLevel:\n\tclose;")).toEqual([{ name: "BaseLevel", text: "BaseLevel" }]);
  });

  it("ne tient pas compte de la casse, comme les mots du langage de script", () => {
    expect(reserved("MES:\n\tclose;").map((found) => found.name)).toEqual(["MES"]);
    expect(reserved("job_alchemist:\n\tclose;").map((found) => found.name)).toEqual(["job_alchemist"]);
    expect(reserved("baselevel:\n\tclose;").map((found) => found.name)).toEqual(["baselevel"]);
  });

  it("signale aussi une fonction locale qui porte un tel nom, et chaque declaration d'un label repete", () => {
    expect(reserved("\tfunction next {\n\t\treturn;\n\t}\n\tclose;").map((found) => found.name)).toEqual(["next"]);
    expect(reserved("mes:\n\tmes:\n\tclose;").map((found) => found.name)).toEqual(["mes", "mes"]);
  });

  it("ne dit rien d'un label ordinaire ni d'un label d'evenement", () => {
    expect(reserved("L_Menu:\n\tclose;\nOnInit:\n\tend;\nOnTouch:\n\tend;")).toEqual([]);
    expect(reserved("Menu_1:\n\tclose;")).toEqual([]);
  });

  it("ne tient compte que de ce que le serveur refuse : ni le manuel seul, ni une commande du projet, ni une commande compilee sous condition, ni une constante du projet", () => {
    expect(reserved("only_in_manual:\n\tclose;")).toEqual([]);
    expect(reserved("my_fork_command:\n\tclose;")).toEqual([]);
    expect(reserved("only_if_compiled:\n\tclose;")).toEqual([]);
    expect(reserved("MyConstant:\n\tclose;")).toEqual([]);
  });

  it("verifie ce dont il dispose : sans registre, seules les constantes ; sans catalogue, seules les commandes ; sans rien, rien", () => {
    expect(reserved("mes:\nBaseLevel:\n\tclose;", { commands: null }).map((found) => found.name)).toEqual(["BaseLevel"]);
    expect(reserved("mes:\nBaseLevel:\n\tclose;", { references: null }).map((found) => found.name)).toEqual(["mes"]);
    expect(reserved("mes:\nBaseLevel:\n\tclose;", { commands: null, references: null })).toEqual([]);
  });

  it("n'empeche pas les autres diagnostics : un goto vers un tel label n'est pas dit inconnu, un label en double l'est toujours", () => {
    const source = `prontera,1,1,0\tscript\tT\t100,{\n\tgoto mes;\nmes:\n\tclose;\nmes:\n\tend;\n}\n`;
    const codes = analyzeFile(parse(source), "t.txt", { commands: registry, references: catalog }).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes.filter((code) => code === "RA0014")).toHaveLength(2);
    expect(codes).toContain("RA0003");
    expect(codes).not.toContain("RA0002");
  });
});
