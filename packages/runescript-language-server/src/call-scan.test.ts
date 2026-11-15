import { describe, expect, it } from "vitest";
import { scanCalls } from "./call-scan";

const call = (source: string) => scanCalls(source).call;

describe("scanCalls : debut d'instruction", () => {
  it.each([
    ["", "debut du texte"],
    ["\t", "ligne indentee"],
    ["\tclose;\n\t", "apres un point-virgule"],
    ["{\n\t", "apres une accolade ouvrante"],
    ["\tclose;\n}\n", "apres une accolade fermante"],
    ["L_Menu:\n\t", "apres un label"],
    ["OnInit:\n\t", "apres un label d'evenement"],
    ["\telse ", "apres else"],
    ["\tdo ", "apres do"],
    ["\tif (.@a == 1) ", "apres l'en-tete d'un if"],
    ["\tif ((.@a + 1) > f(2, 3)) ", "apres un if a parentheses imbriquees"],
    ["\twhile (.@i < 3) ", "apres un while"],
    ["\tfor (.@i = 0; .@i < 3; .@i++) ", "apres un for (les `;` de l'en-tete ne terminent rien)"],
    ["\tswitch (.@a) {\n\tcase 1:\n\t\t", "apres un case"],
    ["\tdefault:\n\t\t", "apres default"],
    ["\tfunction F {\n\t", "dans le corps d'une fonction locale"],
    ["\tmes getitemname(501;\n\t", "apres un point-virgule malgre une parenthese restee ouverte"],
    ["\tL_A: ", "apres un label sur la meme ligne"],
  ])("%j : %s", (source) => {
    expect(scanCalls(source)).toMatchObject({ statementStart: true, call: null });
  });

  it("n'est pas au debut d'une instruction une fois qu'un mot ou une valeur est ecrit", () => {
    for (const source of ["\tmes ", '\tmes "a" ', "\t.@a = ", "\t.@a ", "\tif ", "\tif (", "\t1 + ", "\tcase 1 "]) {
      expect(scanCalls(source).statementStart).toBe(false);
    }
  });
});

describe("scanCalls : operande", () => {
  it.each([
    ["\tmes ", true],
    ['\tmes "a", ', true],
    ["\t.@a = ", true],
    ["\t.@a += ", true],
    ["\tif (", true],
    ["\tif (.@a == ", true],
    ["\tset .@a, rand(", true],
    ["\tset .@a[", true],
    ["\treturn ", true],
    ['\tmes "a" ', false],
    ["\tmes .@x ", false],
    ["\tclose;", false],
    ["\tmes getitemname(501) ", false],
    ["\tif (.@a) ", false],
  ])("%j -> %s", (source, expected) => {
    expect(scanCalls(source).operand).toBe(expected);
  });
});

describe("scanCalls : appel en cours et rang de l'argument", () => {
  it("lit une commande ecrite sans parentheses", () => {
    expect(call("\tmes ")).toMatchObject({ name: "mes", argIndex: 0, parenthesized: false });
    expect(call('\tmes "a", ')).toMatchObject({ name: "mes", argIndex: 1 });
    expect(call('\twarp "prontera", 150, ')).toMatchObject({ name: "warp", argIndex: 2 });
    expect(call("\tmes")).toMatchObject({ name: "mes", argIndex: 0 });
  });

  it("lit un appel parenthese, dans une instruction ou une expression", () => {
    expect(call("\tgetitem(501, ")).toMatchObject({ name: "getitem", argIndex: 1, parenthesized: true });
    expect(call("\tset .@a, rand(1, ")).toMatchObject({ name: "rand", argIndex: 1, parenthesized: true });
    expect(call("\t.@a = rand (")).toMatchObject({ name: "rand", argIndex: 0, parenthesized: true });
    expect(call("\tif (rand(1, 2) > countitem(")).toMatchObject({ name: "countitem", argIndex: 0 });
  });

  it("revient a la commande englobante quand l'appel interieur est ferme", () => {
    expect(call("\tset .@a, rand(1, 2), ")).toMatchObject({ name: "set", argIndex: 2 });
    expect(call("\tmes getitemname(501) + ")).toMatchObject({ name: "mes", argIndex: 0 });
    expect(call("\tmes getitemname(501), ")).toMatchObject({ name: "mes", argIndex: 1 });
  });

  it("compte les virgules d'une parenthese qui suit directement le nom, pas celles d'un regroupement", () => {
    expect(call("\tcallsub (L_X, ")).toMatchObject({ name: "callsub", argIndex: 1 });
    expect(call("\tmes (1 + 2), ")).toMatchObject({ name: "mes", argIndex: 1 });
    expect(call("\tmes 1 + (2, ")).toMatchObject({ name: "mes", argIndex: 0 });
    expect(call("\tset .@a[rand(1, 2)], ")).toMatchObject({ name: "set", argIndex: 1 });
    expect(call("\tset .@a[1, 2")).toMatchObject({ name: "set", argIndex: 0 });
  });

  it("suit un appel ecrit sur plusieurs lignes et ignore les virgules des chaines et des commentaires", () => {
    expect(call('\tmenu "A", L_A,\n\t\t"B", ')).toMatchObject({ name: "menu", argIndex: 3 });
    expect(call('\tmes "a,b;c", ')).toMatchObject({ name: "mes", argIndex: 1 });
    expect(call("\tmes 1, // un, deux\n\t\t")).toMatchObject({ name: "mes", argIndex: 1 });
    expect(call("\tmes 1, /* a, b */ ")).toMatchObject({ name: "mes", argIndex: 1 });
  });

  it("ne voit pas d'appel hors d'un appel", () => {
    expect(call("\t")).toBeNull();
    expect(call("\tclose;\n\t")).toBeNull();
    expect(call("\t.@a = ")).toBeNull();
    expect(call("\tif (.@a == ")).toBeNull();
    expect(call("\tL_A: ")).toBeNull();
  });

  it("reprend a l'instruction suivante", () => {
    expect(call('\tmes "a", "b";\n\twarp ')).toMatchObject({ name: "warp", argIndex: 0 });
    expect(call("\tif (.@a) mes ")).toMatchObject({ name: "mes", argIndex: 0 });
    expect(call("\tL_A: goto ")).toMatchObject({ name: "goto", argIndex: 0 });
    expect(call("\telse mes ")).toMatchObject({ name: "mes", argIndex: 0 });
  });

  it("signale un curseur place dans un commentaire", () => {
    expect(scanCalls("\tmes 1, // reste").inComment).toBe(true);
    expect(scanCalls("\tmes 1, /* reste").inComment).toBe(true);
    expect(scanCalls("\tmes 1, /* ferme */ ").inComment).toBe(false);
    expect(scanCalls("\tmes 1, // fini\n\t").inComment).toBe(false);
    expect(scanCalls("\tmes 1, ").inComment).toBe(false);
  });

  it("donne la plage du nom de la commande", () => {
    const source = "\t\tmes 1, ";
    const found = call(source);
    expect(found && source.slice(found.nameStart, found.nameEnd)).toBe("mes");
  });

  it("ne plante jamais et garde des plages valides sur du texte arbitraire", () => {
    const fragments = ["mes ", "(", ")", "[", "]", ",", ";", "{", "}", ":", "if ", "else ", "case ", '"x', "1", ".@a", "=", "+", "\n", "/*", "//", "rand", "callsub "];
    let seed = 99;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 500; round += 1) {
      let text = "";
      const length = 1 + Math.floor(random() * 30);
      for (let i = 0; i < length; i += 1) text += fragments[Math.floor(random() * fragments.length)];
      const scan = scanCalls(text);
      if (scan.call !== null) {
        expect(scan.call.nameStart).toBeGreaterThanOrEqual(0);
        expect(scan.call.nameEnd).toBeLessThanOrEqual(text.length);
        expect(scan.call.argIndex).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
