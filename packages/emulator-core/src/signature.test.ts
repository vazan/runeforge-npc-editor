import { describe, expect, it } from "vitest";
import { excerptDocumentation, parseSignatureText, signatureFromTypes } from "./signature";
import type { SignatureView } from "./signature";

/** Texte de chaque parametre d'une signature, avec son caractere facultatif. */
function shown(view: SignatureView): [string, boolean][] {
  return view.parameters.map((parameter) => [view.label.slice(parameter.start, parameter.end), parameter.optional]);
}

describe("parseSignatureText (titres du manuel)", () => {
  it("repere chaque parametre d'une signature a arguments libres", () => {
    const view = parseSignatureText('mes "<string>"{,"<string>"{,...}};');
    expect(view.label).toBe('mes "<string>"{,"<string>"{,...}}');
    expect(shown(view)).toEqual([
      ['"<string>"', false],
      ['"<string>"', true],
    ]);
    expect(view.variadic).toBe(true);
  });

  it("lit la forme parenthesee et la forme a espaces d'une meme commande", () => {
    const statement = parseSignatureText("set <variable>,<expression>{,<char_id>};");
    expect(shown(statement)).toEqual([
      ["<variable>", false],
      ["<expression>", false],
      ["<char_id>", true],
    ]);
    expect(statement.variadic).toBe(false);
    const call = parseSignatureText("set(<variable>,<expression>{,<char id>})");
    expect(call.label).toBe("set(<variable>,<expression>{,<char id>})");
    expect(shown(call)).toEqual([
      ["<variable>", false],
      ["<expression>", false],
      ["<char id>", true],
    ]);
  });

  it("garde les alternatives d'un meme argument ensemble et ignore les virgules entre chevrons", () => {
    const view = parseSignatureText('getcharip({"<character name>"|<account id>|<char id>})');
    expect(shown(view)).toEqual([['"<character name>"|<account id>|<char id>', true]]);
    const commas = parseSignatureText("foo(<a, b>,<c>)");
    expect(shown(commas)).toEqual([
      ["<a, b>", false],
      ["<c>", false],
    ]);
  });

  it("traite `[<indice>]` comme l'indice du parametre precedent, pas comme un parametre", () => {
    const view = parseSignatureText("setarray <array name>[<first value>],<value>{,<value>...<value>};");
    expect(shown(view)).toEqual([
      ["<array name>[<first value>]", false],
      ["<value>", false],
      ["<value>...<value>", true],
    ]);
    expect(view.variadic).toBe(true);
    expect(shown(parseSignatureText("countinarray <array name>{[<start index>]},<array name>{[<start index>]};")).map(([text]) => text)).toEqual([
      "<array name>",
      "<array name>",
    ]);
  });

  it("reconnait les repetitions `...` ecrites comme un element a part", () => {
    const view = parseSignatureText('callfunc "<function>"{,<argument>,...<argument>};');
    expect(shown(view)).toEqual([
      ['"<function>"', false],
      ["<argument>", true],
    ]);
    expect(view.variadic).toBe(true);
    const select = parseSignatureText('select("<option>"{,"<option>",...})');
    expect(shown(select)).toEqual([
      ['"<option>"', false],
      ['"<option>"', true],
    ]);
    expect(select.variadic).toBe(true);
  });

  it("n'invente aucun parametre pour une commande sans argument", () => {
    for (const text of ["next;", "close;", "getargcount()", "cardscnt()"]) {
      const view = parseSignatureText(text);
      expect(view.parameters).toEqual([]);
      expect(view.variadic).toBe(false);
    }
    expect(parseSignatureText("next;").label).toBe("next");
  });

  it("garde les plages valides pour n'importe quel texte", () => {
    for (const text of ["", ";", "(", "{{{", "}}}", "<<<", ">>>", "a<b", "a{,,,}", "x(((", "mes \"<", "...", "...x,...,...y"]) {
      const view = parseSignatureText(text);
      for (const parameter of view.parameters) {
        expect(parameter.start).toBeGreaterThanOrEqual(0);
        expect(parameter.end).toBeLessThanOrEqual(view.label.length);
        expect(parameter.start).toBeLessThan(parameter.end);
      }
    }
  });
});

describe("signatureFromTypes (notation de la table)", () => {
  it("nomme les types des arguments obligatoires, puis les facultatifs", () => {
    const view = signatureFromTypes("warp", "sii?");
    expect(view.label).toBe("warp(string, int, int, [optional])");
    expect(shown(view)).toEqual([
      ["string", false],
      ["int", false],
      ["int", false],
      ["[optional]", true],
    ]);
    expect(view.variadic).toBe(false);
  });

  it("signale les arguments en nombre libre", () => {
    const view = signatureFromTypes("mes", "s*");
    expect(view.label).toBe("mes(string, ...)");
    expect(shown(view)).toEqual([["string", false]]);
    expect(view.variadic).toBe(true);
    expect(signatureFromTypes("menu", "sl*").label).toBe("menu(string, label, ...)");
    expect(signatureFromTypes("setarray", "rv*").label).toBe("setarray(reference, value, ...)");
  });

  it("ecrit une commande sans argument et un argument unique facultatif", () => {
    expect(signatureFromTypes("next", "").label).toBe("next()");
    expect(signatureFromTypes("next", "").parameters).toEqual([]);
    expect(signatureFromTypes("return", "?").label).toBe("return([optional])");
    expect(signatureFromTypes("min", "*").label).toBe("min(...)");
  });

  it("ne plante pas sur une notation invalide", () => {
    expect(signatureFromTypes("x", "zz").label).toBe("x()");
  });
});

describe("excerptDocumentation", () => {
  const text = ["", "Premiere ligne.", "", "\texemple indente", "Troisieme ligne.", "", "Derniere ligne.", ""].join("\n");

  it("garde tout quand les limites sont larges, sans lignes vides aux extremites", () => {
    expect(excerptDocumentation(text, 1000, 50)).toEqual({
      text: "Premiere ligne.\n\n  exemple indente\nTroisieme ligne.\n\nDerniere ligne.",
      truncated: false,
    });
  });

  it("coupe a une fin de ligne et le dit", () => {
    expect(excerptDocumentation(text, 1000, 2)).toEqual({ text: "Premiere ligne.", truncated: true });
    expect(excerptDocumentation(text, 20, 50)).toEqual({ text: "Premiere ligne.", truncated: true });
    expect(excerptDocumentation(text, 1000, 3)).toEqual({ text: "Premiere ligne.\n\n  exemple indente", truncated: true });
  });

  it("normalise les fins de ligne et retire les espaces de fin", () => {
    expect(excerptDocumentation("a  \r\nb\t\r\n", 100, 10)).toEqual({ text: "a\nb", truncated: false });
    expect(excerptDocumentation("", 100, 10)).toEqual({ text: "", truncated: false });
  });
});
