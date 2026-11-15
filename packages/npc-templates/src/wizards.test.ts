import { describe, expect, it } from "vitest";
import { CommandRegistry, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { analyzeFile } from "@runeforge/runescript-analysis";
import { parse } from "@runeforge/runescript-parser";
import {
  displayNameOf,
  hasErrors,
  initialValues,
  NPC_WIZARDS,
  parseShopItems,
  quote,
  runWizard,
  validateWizard,
  validateWizardField,
  wizardById,
  wizardsFor,
} from "./wizards";
import type { WizardField, WizardId, WizardProblem } from "./wizards";

/** Table de commandes rédigée pour ce test : les mêmes noms et la même notation que la table d'un serveur rAthena. */
const REGISTRY = CommandRegistry.create(
  (
    [
      ["mes", "s*"],
      ["next", ""],
      ["close", ""],
      ["select", "s*"],
      ["warp", "sii?"],
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

const IDS: readonly WizardId[] = ["warp-portal", "warp-npc", "shop", "healer"];

function generated(id: WizardId, overrides: Record<string, string> = {}): string {
  const result = runWizard(id, { ...initialValues(id), ...overrides });
  if (result.source === null) throw new Error(`${id} : ${JSON.stringify(result.problems)}`);
  return result.source;
}

/** Les diagnostics que l'analyse du produit trouve dans un script généré (syntaxe, sémantique locale, commandes inconnues). */
function diagnosticsOf(source: string): string[] {
  const parsed = parse(source);
  const analysis = analyzeFile(parsed, "wizard.txt", { commands: REGISTRY });
  return [...parsed.diagnostics, ...analysis.diagnostics].map((diagnostic) => diagnostic.code).concat(analysis.unknownCalls.map((call) => `inconnue:${call.name}`));
}

const codes = (problems: readonly WizardProblem[]): string[] => problems.map((problem) => `${problem.field}:${problem.code}`);

describe("assistants de NPC : définitions", () => {
  it("proposent quatre assistants, vérifiés pour rAthena seulement", () => {
    expect(NPC_WIZARDS.map((wizard) => wizard.id)).toEqual(IDS);
    expect(wizardsFor("rathena")).toHaveLength(4);
    expect(wizardsFor("hercules")).toEqual([]);
    expect(wizardsFor(null)).toEqual([]);
    for (const wizard of NPC_WIZARDS) expect(wizard.emulators).toEqual(["rathena"]);
  });

  it("donnent une valeur initiale à chaque champ et n'ont aucun champ en double", () => {
    for (const wizard of NPC_WIZARDS) {
      const keys = wizard.fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(Object.keys(initialValues(wizard.id))).toEqual(keys);
    }
    expect(() => wizardById("nope" as WizardId)).toThrow(/inconnu/);
  });

  it("sont valides tels quels : les valeurs initiales ne produisent aucune erreur ni aucun avertissement", () => {
    for (const id of IDS) expect(validateWizard(id, initialValues(id)), id).toEqual([]);
  });
});

describe("assistants de NPC : scripts générés", () => {
  it("écrit exactement les scripts attendus pour les valeurs initiales (tabulations aux séparateurs de l'en-tête)", () => {
    expect(generated("warp-portal")).toBe("prontera,155,180,0\twarp\twarp_to_geffen\t2,2,geffen,120,60\n");
    expect(generated("shop")).toBe("prontera,155,180,4\tshop\tMerchant\t4_M_01,501:50,502:200\n");
    expect(generated("warp-npc")).toBe(
      [
        "prontera,155,180,4\tscript\tWarper\t4_F_01,{",
        '\tmes "[Warper]";',
        '\tmes "Where would you like to go?";',
        "\tnext;",
        '\tif (select("Take me there:Not now") == 2) close;',
        '\twarp "geffen",120,60;',
        "}",
        "",
      ].join("\n"),
    );
    expect(generated("healer")).toBe(
      [
        "prontera,155,180,4\tscript\tHealer\t4_F_01,{",
        '\tmes "[Healer]";',
        '\tmes "I can heal your wounds.";',
        "\tnext;",
        '\tif (select("Heal me:No, thanks") == 2) {',
        '\t\tmes "[Healer]";',
        '\t\tmes "Take care.";',
        "\t\tclose;",
        "\t}",
        "\tpercentheal 100,100;",
        '\tmes "[Healer]";',
        '\tmes "There you go.";',
        "\tclose;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("ne produit aucun diagnostic : syntaxe, sémantique locale, commandes toutes connues du registre", () => {
    for (const id of IDS) expect(diagnosticsOf(generated(id)), id).toEqual([]);
  });

  it("produit une déclaration du bon type, au bon endroit, pour le nom demandé", () => {
    const expected: Record<WizardId, string> = { "warp-portal": "warp", "warp-npc": "script", shop: "shop", healer: "script" };
    for (const id of IDS) {
      const source = generated(id, { map: "geffen", x: "10", y: "20", facing: "6", name: "Mon NPC" });
      const analysis = analyzeFile(parse(source), "w.txt", { commands: REGISTRY });
      expect(analysis.declarations, id).toHaveLength(1);
      expect(analysis.declarations[0], id).toMatchObject({ kind: "npc", npcType: expected[id], map: "geffen", x: 10, y: 20, displayName: "Mon NPC" });
    }
  });

  it("ajoute le contrôle du niveau et le coût seulement quand ils sont demandés", () => {
    const free = generated("warp-npc");
    expect(free).not.toContain("BaseLevel");
    expect(free).not.toContain("Zeny");
    const paid = generated("warp-npc", { cost: "1000", minLevel: "30" });
    expect(paid).toContain("\tif (BaseLevel < 30) {");
    expect(paid).toContain("\tif (Zeny < 1000) {");
    expect(paid).toContain("\tZeny -= 1000;");
    // Le niveau est contrôlé avant l'argent, l'argent avant le départ.
    expect(paid.indexOf("BaseLevel")).toBeLessThan(paid.indexOf("Zeny <"));
    expect(paid.indexOf("Zeny -= 1000")).toBeLessThan(paid.indexOf("\twarp "));
    expect(diagnosticsOf(paid)).toEqual([]);
    expect(generated("warp-npc", { minLevel: "30" })).not.toContain("Zeny");
    expect(generated("healer", { cost: "500" })).toContain("\tZeny -= 500;");
    expect(generated("healer")).not.toContain("Zeny");
    expect(diagnosticsOf(generated("healer", { cost: "500", healHp: "50", healSp: "0" }))).toEqual([]);
    expect(generated("healer", { healHp: "50", healSp: "0" })).toContain("\tpercentheal 50,0;");
  });

  it("protège les guillemets et les barres obliques des textes, sans rien changer d'autre", () => {
    const source = generated("healer", { greeting: 'Dites "bonjour" \\ ici', done: "C:\\fini" });
    expect(source).toContain('\tmes "Dites \\"bonjour\\" \\\\ ici";');
    expect(source).toContain('\tmes "C:\\\\fini";');
    expect(diagnosticsOf(source)).toEqual([]);
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quote("")).toBe('""');
  });

  it("n'affiche que la partie visible d'un nom (avant # et ::) et garde le nom complet dans l'en-tête", () => {
    const source = generated("warp-npc", { name: "Passeur#cache::unique_1" });
    expect(source.split("\n")[0]).toBe("prontera,155,180,4\tscript\tPasseur#cache::unique_1\t4_F_01,{");
    expect(source).toContain('\tmes "[Passeur]";');
    expect(displayNameOf("Passeur#cache")).toBe("Passeur");
    expect(displayNameOf("A::B")).toBe("A");
    expect(displayNameOf("Simple")).toBe("Simple");
    expect(displayNameOf("  Espace  ")).toBe("Espace");
  });

  it("tire les prix de la liste d'objets : -1 quand l'utilisateur n'en donne pas (prix du serveur)", () => {
    expect(generated("shop", { items: "501\n 502:60\n503,70\n504 80\r\n\n  " })).toBe("prontera,155,180,4\tshop\tMerchant\t4_M_01,501:-1,502:60,503:70,504:80\n");
  });

  it("est déterministe et ne tient pas compte des espaces autour des valeurs", () => {
    const loose = { name: "  Merchant ", map: " prontera", x: " 155 ", sprite: " 4_M_01 ", items: "  501 50  \n 502 200 " };
    expect(generated("shop", loose)).toBe(generated("shop"));
    expect(generated("shop")).toBe(generated("shop"));
  });

  it("accepte un sprite numérique, négatif ou nommé", () => {
    for (const sprite of ["123", "-1", "HIDDEN_NPC", "4_M_01"]) expect(generated("shop", { sprite }), sprite).toContain(`\t${sprite},501:50`);
  });
});

describe("assistants de NPC : validation", () => {
  it("n'accepte pas un champ obligatoire vide", () => {
    for (const key of ["name", "map", "x", "y", "facing", "sprite", "items"]) {
      expect(codes(validateWizard("shop", { ...initialValues("shop"), [key]: "  " })), key).toContain(`${key}:${key === "items" ? "itemsRequired" : "required"}`);
    }
    expect(codes(validateWizard("warp-npc", { ...initialValues("warp-npc"), greeting: "" }))).toEqual(["greeting:required"]);
  });

  it("vérifie les entiers et leurs bornes", () => {
    const check = (overrides: Record<string, string>): string[] => codes(validateWizard("warp-portal", { ...initialValues("warp-portal"), ...overrides }));
    expect(check({ x: "abc" })).toEqual(["x:notInteger"]);
    expect(check({ x: "1.5" })).toEqual(["x:notInteger"]);
    expect(check({ x: "-1" })).toEqual(["x:outOfRange"]);
    expect(check({ x: "512" })).toEqual(["x:outOfRange"]);
    expect(check({ x: "511", y: "0" })).toEqual([]);
    expect(check({ facing: "8" })).toEqual(["facing:outOfRange"]);
    expect(check({ facing: "7" })).toEqual([]);
    expect(check({ areaX: "101" })).toEqual(["areaX:outOfRange"]);
    expect(check({ destY: "9999999999999999999999" })).toEqual(["destY:outOfRange"]);
    expect(validateWizard("warp-portal", { ...initialValues("warp-portal"), x: "512" })[0]).toMatchObject({ params: { min: 0, max: 511 } });
  });

  it("vérifie les noms de carte et de sprite", () => {
    const check = (overrides: Record<string, string>): string[] => codes(validateWizard("warp-npc", { ...initialValues("warp-npc"), ...overrides }));
    expect(check({ map: "douze_lettres" })).toEqual(["map:badMap"]);
    expect(check({ destMap: "pront era" })).toEqual(["destMap:badMap"]);
    expect(check({ map: "1@tower" })).toEqual([]);
    expect(check({ map: "abcdefghijk" })).toEqual([]);
    expect(check({ map: "abcdefghijkl" })).toEqual(["map:badMap"]);
    expect(check({ map: "a,b" })).toEqual(["map:badMap"]);
    expect(check({ map: "prontera.gat" })).toEqual(["map:badMap"]);
    expect(check({ sprite: "pas un sprite!" })).toEqual(["sprite:badSprite"]);
    expect(check({ sprite: "-2" })).toEqual(["sprite:badSprite"]);
  });

  it("refuse les tabulations et les sauts de ligne dans un texte, et les textes trop longs", () => {
    const check = (overrides: Record<string, string>): string[] => codes(validateWizard("healer", { ...initialValues("healer"), ...overrides }));
    expect(check({ greeting: "a\tb" })).toEqual(["greeting:badCharacters"]);
    expect(check({ greeting: "a\nb" })).toEqual(["greeting:badCharacters"]);
    expect(check({ greeting: "a\rb" })).toEqual(["greeting:badCharacters"]);
    expect(check({ name: "x".repeat(51) })).toEqual(["name:tooLong", "name:displayNameLong"]);
    expect(check({ name: "x".repeat(50) })).toEqual(["name:displayNameLong"]);
    expect(check({ yes: "y".repeat(41) })).toEqual(["yes:tooLong"]);
  });

  it("avertit d'un nom d'affichage de plus de 23 caractères, sans compter ce qui suit # ou ::", () => {
    const check = (name: string): string[] => codes(validateWizard("shop", { ...initialValues("shop"), name }));
    expect(check("x".repeat(23))).toEqual([]);
    expect(check("x".repeat(24))).toEqual(["name:displayNameLong"]);
    expect(check(`${"x".repeat(23)}#${"y".repeat(20)}`)).toEqual([]);
    expect(check(`${"x".repeat(24)}::unique`)).toEqual(["name:displayNameLong"]);
  });

  it("refuse les deux-points dans les choix du menu (ils séparent les choix de select)", () => {
    expect(codes(validateWizard("warp-npc", { ...initialValues("warp-npc"), yes: "Oui: allons-y" }))).toEqual(["yes:colon"]);
    expect(codes(validateWizard("healer", { ...initialValues("healer"), no: "Non:" }))).toEqual(["no:colon"]);
    // Les autres textes peuvent en contenir.
    expect(codes(validateWizard("healer", { ...initialValues("healer"), greeting: "Ecoute: je soigne" }))).toEqual([]);
  });

  it("lit la liste d'objets d'une boutique ligne par ligne et dit laquelle est fausse", () => {
    const check = (items: string): string[] =>
      parseShopItems(items).problems.map((problem) => `${problem.severity}:${problem.code}${problem.params?.["line"] === undefined ? "" : `@${problem.params["line"]}`}`);
    expect(check("")).toEqual(["error:itemsRequired"]);
    expect(check("  \n\n")).toEqual(["error:itemsRequired"]);
    expect(check("501\nabc\n502")).toEqual(["error:badItemLine@2"]);
    // Une liste dont aucune ligne n'est lisible ne dit pas en plus qu'elle est vide.
    expect(check("abc")).toEqual(["error:badItemLine@1"]);
    expect(check("501:50,")).toEqual(["error:badItemLine@1"]);
    expect(check("0")).toEqual(["error:itemIdRange@1"]);
    expect(check("4294967296")).toEqual(["error:itemIdRange@1"]);
    expect(check("4294967295")).toEqual([]);
    expect(check("501 -2")).toEqual(["error:priceRange@1"]);
    expect(check("501 2147483648")).toEqual(["error:priceRange@1"]);
    expect(check("501 2147483647")).toEqual(["warning:priceHigh@1"]);
    expect(check("501 1000000000")).toEqual([]);
    expect(check("501 1000000001")).toEqual(["warning:priceHigh@1"]);
    expect(check("501 0")).toEqual(["warning:priceFree@1"]);
    expect(check("501 -1")).toEqual([]);
    expect(check("501 50\n501 60")).toEqual(["warning:itemDuplicate@2"]);
    expect(parseShopItems("501 50\n501 60").problems[0]?.params).toEqual({ line: 2, id: 501 });
    // Un objet valide mélangé à des lignes fausses reste lu (l'interface montre les erreurs, pas un script).
    expect(parseShopItems("501 50\nabc").items).toEqual([{ id: 501, price: 50 }]);
  });

  it("classe les erreurs avant les avertissements", () => {
    const problems = validateWizard("shop", { ...initialValues("shop"), items: "501 0\nabc", x: "-5" });
    expect(problems.map((problem) => problem.severity)).toEqual(["error", "error", "warning"]);
    expect(hasErrors(problems)).toBe(true);
    expect(hasErrors(problems.filter((problem) => problem.severity === "warning"))).toBe(false);
  });
});

describe("assistants de NPC : champ seul", () => {
  const optional: WizardField = { key: "extra", kind: "integer", initial: "", required: false, min: 1, max: 5 };

  it("accepte une valeur vide ou absente quand le champ est facultatif, pas quand il est obligatoire", () => {
    expect(validateWizardField(optional, "")).toEqual([]);
    expect(validateWizardField(optional, "   ")).toEqual([]);
    expect(validateWizardField(optional, undefined)).toEqual([]);
    expect(validateWizardField({ ...optional, required: true }, "")).toEqual([{ field: "extra", severity: "error", code: "required" }]);
    expect(validateWizardField({ ...optional, required: true }, undefined)).toEqual([{ field: "extra", severity: "error", code: "required" }]);
  });

  it("juge un champ facultatif renseigne comme un autre", () => {
    expect(validateWizardField(optional, "3")).toEqual([]);
    expect(validateWizardField(optional, "9")).toEqual([{ field: "extra", severity: "error", code: "outOfRange", params: { min: 1, max: 5 } }]);
    expect(validateWizardField(optional, "x")).toEqual([{ field: "extra", severity: "error", code: "notInteger" }]);
  });

  it("ne limite pas la longueur d'un texte qui n'a pas de maximum, mais refuse toujours les caracteres de ligne", () => {
    const free: WizardField = { key: "note", kind: "longText", initial: "", required: true };
    expect(validateWizardField(free, "x".repeat(5000))).toEqual([]);
    expect(validateWizardField(free, "a\tb")).toEqual([{ field: "note", severity: "error", code: "badCharacters" }]);
  });

  it("borne un entier sans minimum ni maximum seulement par ce qu'un nombre sûr peut représenter", () => {
    const open: WizardField = { key: "n", kind: "integer", initial: "", required: true };
    expect(validateWizardField(open, "-99999999")).toEqual([]);
    expect(validateWizardField(open, "99999999999999999999")).toMatchObject([{ code: "outOfRange" }]);
  });
});

describe("assistants de NPC : runWizard", () => {
  it("ne génère rien tant que la saisie a une erreur, et dit lesquelles", () => {
    const result = runWizard("shop", { ...initialValues("shop"), x: "abc" });
    expect(result.source).toBeNull();
    expect(codes(result.problems)).toEqual(["x:notInteger"]);
  });

  it("génère malgré des avertissements, qu'il rapporte", () => {
    const result = runWizard("shop", { ...initialValues("shop"), items: "501 0\n502 50" });
    expect(result.source).toBe("prontera,155,180,4\tshop\tMerchant\t4_M_01,501:0,502:50\n");
    expect(codes(result.problems)).toEqual(["items:priceFree"]);
  });

  it("traite une valeur absente comme vide", () => {
    const values = initialValues("warp-portal");
    delete values["destMap"];
    expect(codes(validateWizard("warp-portal", values))).toEqual(["destMap:required"]);
  });
});
