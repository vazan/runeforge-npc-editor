import { describe, expect, it } from "vitest";
import { parseCommandDoc } from "./command-doc";

// Fixture redigee pour ces tests : meme mise en page que le manuel d'un serveur rAthena, texte original.
const DOC = [
  "Introduction du manuel.",
  "*Premiere ligne decrivant la mise en page (ne doit pas etre prise pour une commande).",
  "",
  "=====================",
  "|1.- Commandes de base.|",
  "=====================",
  "---------------------------------------",
  "",
  '*mes "<string>"{,"<string>"{,...}};',
  "",
  "Affiche une boite de dialogue.",
  "",
  "Couleurs",
  "--------",
  "Les codes de couleur commencent par ^.",
  "",
  '\tmes "Bonjour";',
  "",
  "*next;",
  "",
  "Attend le clic du joueur.",
  "",
  "*set <variable>,<expression>{,<char_id>};",
  "*set(<variable>,<expression>{,<char id>})",
  "",
  "Affecte une valeur.",
  "",
  "*getitemname(<item id>)",
  "*getitemname(<aegis item name>)",
  "",
  "Retourne le nom d'un objet.",
  "",
  "*if (<condition>) <statement>;",
  "",
  "Instruction conditionnelle (mot-cle, pas une commande).",
  "",
  "*Notes:",
  "\t- ceci n'est pas un titre",
  "",
  "=====================",
  "|2.- Informations.|",
  "=====================",
  "---------------------------------------",
  "",
  "*strcharinfo(<type>{,<char_id>})",
  "",
  "Retourne une information.",
  "",
  "*sansaide;",
].join("\n");

describe("parseCommandDoc", () => {
  const result = parseCommandDoc(DOC, "doc/script_commands.txt");
  const byName = new Map(result.definitions.map((definition) => [definition.name, definition]));

  it("importe les titres de commandes, pas le texte qui precede la premiere section ni les notes", () => {
    expect([...byName.keys()]).toEqual(["mes", "next", "set", "getitemname", "strcharinfo", "sansaide"]);
  });

  it("garde la signature lisible de chaque titre, plusieurs signatures pour des titres consecutifs", () => {
    expect(byName.get("mes")?.signatures).toEqual(['mes "<string>"{,"<string>"{,...}};']);
    expect(byName.get("set")?.signatures).toEqual(["set <variable>,<expression>{,<char_id>};", "set(<variable>,<expression>{,<char id>})"]);
    expect(byName.get("getitemname")?.signatures).toHaveLength(2);
    expect(byName.get("strcharinfo")?.signatures).toEqual(["strcharinfo(<type>{,<char_id>})"]);
  });

  it("extrait l'aide jusqu'au titre suivant (sous-titres compris) et jusqu'au cadre de la section suivante", () => {
    expect(byName.get("mes")?.documentation).toContain("Affiche une boite de dialogue.");
    expect(byName.get("mes")?.documentation).toContain("Les codes de couleur commencent par ^.");
    expect(byName.get("mes")?.documentation).toContain('mes "Bonjour";');
    expect(byName.get("mes")?.documentation).not.toContain("Attend le clic");
    expect(byName.get("next")?.documentation).toBe("Attend le clic du joueur.");
    expect(byName.get("set")?.documentation).toBe("Affecte une valeur.");
    expect(byName.get("getitemname")?.documentation).toBe("Retourne le nom d'un objet.");
    expect(byName.get("strcharinfo")?.documentation).toBe("Retourne une information.");
    expect(byName.get("sansaide")?.documentation).toBeNull();
  });

  it("n'attribue aucune arite (la documentation est ecrite pour les humains)", () => {
    for (const definition of result.definitions) {
      expect(definition.arity).toBeNull();
      expect(definition.parameterTypes).toBeNull();
    }
  });

  it("ecarte les mots-cles du langage et le signale", () => {
    expect(byName.has("if")).toBe(false);
    expect(result.skipped).toEqual(["if"]);
  });

  it("indique la ligne du premier titre de chaque commande", () => {
    expect(byName.get("mes")?.sources).toEqual([{ kind: "server-doc", reference: "doc/script_commands.txt:9" }]);
    expect(byName.get("strcharinfo")?.sources[0]?.reference).toBe("doc/script_commands.txt:45");
  });

  it("donne le meme resultat avec des fins de ligne CRLF", () => {
    const crlf = parseCommandDoc(DOC.replaceAll("\n", "\r\n"), "doc/script_commands.txt");
    expect(crlf.definitions.map((d) => d.name)).toEqual(result.definitions.map((d) => d.name));
    expect(crlf.definitions.find((d) => d.name === "next")?.documentation).toBe("Attend le clic du joueur.");
    expect(crlf.definitions.find((d) => d.name === "set")?.signatures).toEqual(byName.get("set")?.signatures);
  });

  it("lit aussi un manuel sans titres de section", () => {
    const flat = parseCommandDoc("*alpha;\n\nAide alpha.\n\n*beta(<x>)\n\nAide beta.\n", "doc/x.txt");
    expect(flat.definitions.map((d) => [d.name, d.documentation])).toEqual([
      ["alpha", "Aide alpha."],
      ["beta", "Aide beta."],
    ]);
  });

  it("fusionne une commande decrite a plusieurs endroits sans perdre la premiere aide", () => {
    const twice = parseCommandDoc("*alpha <a>;\n\nPremiere aide.\n\n*alpha <a>,<b>;\n\nSeconde aide.\n", "doc/x.txt");
    expect(twice.definitions).toHaveLength(1);
    expect(twice.definitions[0]?.signatures).toEqual(["alpha <a>;", "alpha <a>,<b>;"]);
    expect(twice.definitions[0]?.documentation).toBe("Premiere aide.");
  });
});
