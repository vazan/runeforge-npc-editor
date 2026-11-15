import { describe, expect, it } from "vitest";
import { CommandRegistry, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { analyzeFile } from "@runeforge/runescript-analysis";
import { parse } from "@runeforge/runescript-parser";
import { expandSnippet, snippetFields } from "./snippet";
import { NPC_TEMPLATES, renderTemplate, templatesFor } from "./templates";

describe("expandSnippet", () => {
  it("remplace chaque champ par sa valeur par defaut et retire les positions de curseur", () => {
    expect(expandSnippet("a ${1:un} b ${2:deux} $0")).toBe("a un b deux ");
    expect(expandSnippet("${1}x$2y${3:}")).toBe("xy");
  });

  it("garde la valeur par defaut d'un champ repete a chaque occurrence", () => {
    expect(expandSnippet("[${1:Nom}] dit ${2:Salut}, ${1:Nom}")).toBe("[Nom] dit Salut, Nom");
  });

  it("ecrit tels quels les caracteres proteges", () => {
    expect(expandSnippet("\\$ \\} \\\\ ${1:a\\}b\\$c}")).toBe("$ } \\ a}b$c");
    expect(expandSnippet("prix : 5$ et {accolades} libres")).toBe("prix : 5$ et {accolades} libres");
  });

  it("garde les tabulations et les sauts de ligne", () => {
    expect(expandSnippet("a\t${1:b}\n\\}")).toBe("a\tb\n}");
  });
});

describe("snippetFields", () => {
  it("liste les champs dans l'ordre, avec leur valeur par defaut", () => {
    expect(snippetFields("${1:a} \\${2:pas un champ} $3 ${1:a} $0")).toEqual([
      { index: 1, defaultValue: "a" },
      { index: 3, defaultValue: "" },
      { index: 1, defaultValue: "a" },
      { index: 0, defaultValue: "" },
    ]);
  });
});

/** Table de commandes redigee pour ce test : les memes noms et la meme notation que la table d'un serveur rAthena. */
const REGISTRY = CommandRegistry.create(
  (
    [
      ["mes", "s*"],
      ["next", ""],
      ["close", ""],
      ["menu", "sl*"],
      ["percentheal", "ii?"],
    ] as const
  ).map(
    ([name, types]): CommandDefinition => ({
      name,
      arity: parseParameterTypes(types),
      parameterTypes: types,
      signatures: [],
      documentation: null,
      deprecated: false,
      conditional: false,
      sources: [{ kind: "server-source", reference: "test" }],
    }),
  ),
  "rAthena",
);

describe("modeles de NPC", () => {
  it("ont des identifiants uniques et ne sont verifies que pour rAthena", () => {
    expect(NPC_TEMPLATES.map((template) => template.id)).toEqual(["npc-script", "npc-warp", "npc-shop", "npc-healer"]);
    for (const template of NPC_TEMPLATES) expect(template.emulators).toEqual(["rathena"]);
    expect(templatesFor("rathena")).toHaveLength(4);
    expect(templatesFor("hercules")).toEqual([]);
    expect(templatesFor(null)).toEqual([]);
  });

  it.each(NPC_TEMPLATES.map((template) => [template.id, template] as const))("%s : champs numerotes, sans caractere special laisse nu", (_id, template) => {
    const fields = snippetFields(template.snippet);
    expect(fields.at(-1)).toEqual({ index: 0, defaultValue: "" });
    // Chaque champ non nul porte une valeur par defaut visible, numerotee sans trou.
    const numbers = [...new Set(fields.filter((field) => field.index > 0).map((field) => field.index))].sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
    for (const field of fields) if (field.index > 0) expect(field.defaultValue).not.toBe("");
    const text = renderTemplate(template);
    expect(text).not.toMatch(/[$\\]/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it.each(NPC_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s : l'en-tete separe ses champs par des tabulations et le script obtenu est analyse sans aucun diagnostic",
    (_id, template) => {
      const text = renderTemplate(template);
      const header = text.split("\n")[0] ?? "";
      expect(header.split("\t")).toHaveLength(template.id === "npc-warp" ? 4 : 4);
      expect(header).toMatch(/^[^\t,]+,\d+,\d+(,\d+)?\t(script|warp|shop)\t[^\t]+\t[^\t]+/);

      const parsed = parse(text);
      expect(parsed.diagnostics).toEqual([]);
      // Sans registre, puis avec le registre d'un serveur : aucune commande inconnue ni mauvais nombre d'arguments.
      expect(analyzeFile(parsed, "template.txt").diagnostics).toEqual([]);
      const analysis = analyzeFile(parsed, "template.txt", { commands: REGISTRY });
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.unknownCalls).toEqual([]);
    },
  );

  it("produisent le type de declaration annonce", () => {
    const kinds = Object.fromEntries(
      NPC_TEMPLATES.map((template) => [template.id, parse(renderTemplate(template)).ast.declarations.map((declaration) => declaration.kind)]),
    );
    expect(kinds).toEqual({
      "npc-script": ["NpcDeclaration"],
      "npc-warp": ["WarpDeclaration"],
      "npc-shop": ["ShopDeclaration"],
      "npc-healer": ["NpcDeclaration"],
    });
    const shop = parse(renderTemplate(NPC_TEMPLATES[2]!)).ast.declarations[0];
    expect(shop?.kind === "ShopDeclaration" && shop.items.map((item) => [item.item.text, item.price?.value])).toEqual([
      ["501", 50],
      ["502", 200],
    ]);
  });

  it("le soigneur declare ses labels et les atteint tous", () => {
    const healer = NPC_TEMPLATES[3]!;
    const analysis = analyzeFile(parse(renderTemplate(healer)), "healer.txt", { styleHints: true });
    const [declaration] = analysis.declarations;
    expect(declaration?.kind === "npc" && declaration.scope?.labels.map((label) => label.name)).toEqual(["L_Heal", "L_End"]);
    expect(analysis.diagnostics).toEqual([]);
  });

  it("peuvent s'enchainer dans un meme fichier sans doublon de nom ni de label", () => {
    const text = NPC_TEMPLATES.map((template) => renderTemplate(template)).join("");
    const parsed = parse(text);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.ast.declarations).toHaveLength(4);
    expect(analyzeFile(parsed, "all.txt", { commands: REGISTRY }).diagnostics).toEqual([]);
  });
});
