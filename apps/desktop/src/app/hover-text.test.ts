import { describe, expect, it } from "vitest";
import type { CommandInfo, HoverInfo } from "@runeforge/runescript-language-server";
import { translate } from "../i18n/messages";
import { formatCommand, formatHover } from "./hover-text";

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const en = (info: HoverInfo): string => formatHover(info, (key, params) => translate("en", key, params));
const fr = (info: HoverInfo): string => formatHover(info, (key, params) => translate("fr", key, params));

const MES: CommandInfo = {
  name: "mes",
  signatures: ['mes "<string>"{,"<string>"{,...}}'],
  arity: { min: 1, max: null },
  parameterTypes: "s*",
  documentation: 'Affiche une boite de dialogue.\n\n  mes "Bonjour";',
  documentationTruncated: false,
  deprecated: false,
  conditional: false,
  sources: [
    { kind: "server-source", reference: "src/map/script.cpp:27763" },
    { kind: "server-doc", reference: "doc/script_commands.txt:1108" },
  ],
};
const tEn = (key: Parameters<typeof translate>[1], params?: Readonly<Record<string, string | number>>): string => translate("en", key, params);
const tFr = (key: Parameters<typeof translate>[1], params?: Readonly<Record<string, string | number>>): string => translate("fr", key, params);

describe("formatCommand / survol d'une commande", () => {
  it("decrit la commande : origine, signature, arite, aide et sources", () => {
    const hover: HoverInfo = { kind: "command", range, name: "mes", info: MES };
    expect(en(hover)).toBe(
      [
        "**mes** — rAthena command",
        '```text\nmes "<string>"{,"<string>"{,...}}\n```',
        "1 argument(s) or more.",
        '```text\nAffiche une boite de dialogue.\n\n  mes "Bonjour";\n```',
        "Source: `src/map/script.cpp:27763` · `doc/script_commands.txt:1108`",
      ].join("\n\n"),
    );
    expect(fr(hover)).toContain("**mes** — commande rAthena");
    expect(fr(hover)).toContain("1 argument(s) ou plus.");
    expect(fr(hover)).toContain("Source : ");
  });

  it("dit l'arite sous toutes ses formes, y compris inconnue", () => {
    const arity = (value: CommandInfo["arity"]): string => formatCommand({ ...MES, arity: value }, tEn, { emulator: "rAthena", title: false, signatures: false, sources: false });
    expect(arity({ min: 0, max: 0 })).toContain("No arguments.");
    expect(arity({ min: 2, max: 2 })).toContain("Exactly 2 argument(s).");
    expect(arity({ min: 1, max: 3 })).toContain("1 to 3 arguments.");
    expect(arity(null)).toContain("Argument count not checked (manual only).");
    expect(formatCommand({ ...MES, arity: { min: 1, max: 3 } }, tFr, { emulator: "rAthena", title: false, signatures: false, sources: false })).toContain("De 1 à 3 arguments.");
  });

  it("signale une commande obsolete, conditionnelle, et un extrait coupe", () => {
    const text = formatCommand({ ...MES, deprecated: true, conditional: true, documentationTruncated: true }, tEn, { emulator: "rAthena" });
    expect(text).toContain("Deprecated: the server may remove it.");
    expect(text).toContain("Compiled conditionally (#ifdef): it may be missing from your server.");
    expect(text).toContain("*Excerpt: the rest is in the manual.*");
  });

  it("limite le nombre de lignes d'aide et le dit", () => {
    const long = { ...MES, documentation: ["a", "b", "c", "d"].join("\n") };
    const text = formatCommand(long, tEn, { emulator: "rAthena", title: false, signatures: false, sources: false, maxDocLines: 2 });
    expect(text).toContain("```text\na\nb\n```");
    expect(text).not.toContain("\nc");
    expect(text).toContain("*Excerpt: the rest is in the manual.*");
  });

  it("nomme l'origine d'une commande du projet ou du manuel seul, et l'emulateur du projet", () => {
    const project: CommandInfo = { ...MES, sources: [{ kind: "project", reference: ".runeforge/project.json" }] };
    expect(formatCommand(project, tEn, { emulator: "rAthena" })).toContain("**mes** — custom command (project)");
    const manual: CommandInfo = { ...MES, arity: null, sources: [{ kind: "server-doc", reference: "doc/script_commands.txt:1" }] };
    expect(formatCommand(manual, tFr, { emulator: "rAthena" })).toContain("**mes** — commande (manuel du serveur)");
    expect(formatCommand({ ...MES, sources: [{ kind: "server-source", reference: "x:1" }] }, tEn, { emulator: "Hercules" })).toContain("Hercules command");
  });

  it("protege le bloc de code quand l'aide contient des accents graves", () => {
    const tricky = { ...MES, documentation: "avant ``` apres" };
    const text = formatCommand(tricky, tEn, { emulator: "rAthena", title: false, signatures: false, sources: false });
    expect(text).toContain("````text\navant ``` apres\n````");
  });
});

describe("formatHover", () => {
  it("decrit un label defini, un evenement, une fonction locale et un label inconnu", () => {
    const label: HoverInfo = { kind: "label", range, name: "L_End", isFunction: false, isEvent: false, defined: true, line: 12, references: 3 };
    expect(en(label)).toBe("`L_End` — label\n\nDefined line 12 · used 3 time(s) in this script");
    expect(fr(label)).toBe("`L_End` — label\n\nDéfini ligne 12 · utilisé 3 fois dans ce script");
    expect(en({ ...label, isEvent: true, name: "OnInit" })).toContain("event label");
    expect(fr({ ...label, isFunction: true, name: "Aide" })).toContain("fonction locale");
    expect(en({ ...label, defined: false, line: null })).toBe("`L_End` — label not defined in this script");
  });

  it("decrit une fonction globale, ses definitions multiples et ses appels", () => {
    const one: HoverInfo = { kind: "function", range, name: "F_Lib", definitions: [{ uri: "npc/lib.txt", line: 4 }], references: 7 };
    expect(en(one)).toBe("`F_Lib` — global function\n\nDefined in `npc/lib.txt:4`\n\n7 call(s) with callfunc in the project");
    const twice: HoverInfo = { ...one, definitions: [{ uri: "a.txt", line: 1 }, { uri: "b.txt", line: 2 }] };
    expect(fr(twice)).toContain("Définie 2 fois");
    expect(en({ ...one, definitions: [] })).toContain("No definition found");
  });

  it("decrit un NPC avec son type, sa carte et ses duplicates", () => {
    const npc: HoverInfo = {
      kind: "npc",
      range,
      name: "KafraPront",
      definitions: [{ uri: "npc/kafra.txt", line: 20, npcType: "script", displayName: "Kafra Employee", map: "prontera" }],
      references: 2,
    };
    expect(en(npc)).toBe("`KafraPront` — NPC script\n\nKafra Employee · map prontera · `npc/kafra.txt:20`\n\n2 duplicate(s) of this NPC");
    expect(fr({ ...npc, definitions: [] })).toContain("Aucun NPC");
  });

  it("decrit une variable : portee, type, utilisations et premiere affectation", () => {
    const variable: HoverInfo = { kind: "variable", range, name: ".@name$", scope: "script", isString: true, isArray: true, occurrences: 3, firstWriteLine: 8 };
    expect(en(variable)).toBe("`.@name$` — variable (local to the script)\n\ntext · array\n\n3 use(s) in this scope\n\nFirst assignment: line 8");
    expect(fr({ ...variable, scope: "global-permanent", isString: false, isArray: false, firstWriteLine: null })).toBe(
      "`.@name$` — variable (permanente, serveur)\n\nnombre\n\n3 utilisation(s) dans cette portée\n\nAucune affectation vue dans cette portée",
    );
  });
});
