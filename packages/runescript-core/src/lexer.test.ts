import { describe, expect, it } from "vitest";
import { isTrivia, tokenize } from "./index";
import type { TokenKind } from "./index";

/** Paires [kind, text] : lisible dans les assertions. */
function pairs(text: string): Array<[TokenKind, string]> {
  return tokenize(text).map((token) => [token.kind, token.text]);
}

/** Invariant central : tokens contigus, non vides, concatenation == source. */
function expectLossless(text: string): void {
  const tokens = tokenize(text);
  let cursor = 0;
  for (const token of tokens) {
    expect(token.range.start).toBe(cursor);
    expect(token.range.end).toBeGreaterThan(token.range.start);
    expect(text.slice(token.range.start, token.range.end)).toBe(token.text);
    cursor = token.range.end;
  }
  expect(cursor).toBe(text.length);
  expect(tokens.map((token) => token.text).join("")).toBe(text);
}

describe("tokenize - cas de base", () => {
  it("retourne une liste vide pour un texte vide", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("decoupe l'en-tete d'un NPC separe par des tabulations", () => {
    const header = "prontera,150,150,4\tscript\tTest NPC#t1\t100,{\n";
    expect(pairs(header)).toEqual([
      ["Identifier", "prontera"],
      ["Punctuation", ","],
      ["Number", "150"],
      ["Punctuation", ","],
      ["Number", "150"],
      ["Punctuation", ","],
      ["Number", "4"],
      ["Tabs", "\t"],
      ["Identifier", "script"],
      ["Tabs", "\t"],
      ["Identifier", "Test"],
      ["Spaces", " "],
      ["Identifier", "NPC"],
      // `#t1` est un token Variable : le parser de premier niveau reassemble le nom.
      ["Variable", "#t1"],
      ["Tabs", "\t"],
      ["Number", "100"],
      ["Punctuation", ","],
      ["Punctuation", "{"],
      ["Newline", "\n"],
    ]);
    expectLossless(header);
  });

  it("decoupe une instruction avec chaine et variable locale", () => {
    expect(pairs('\tmes "Bonjour";\n\tset .@x, 1;')).toEqual([
      ["Tabs", "\t"],
      ["Identifier", "mes"],
      ["Spaces", " "],
      ["String", '"Bonjour"'],
      ["Punctuation", ";"],
      ["Newline", "\n"],
      ["Tabs", "\t"],
      ["Identifier", "set"],
      ["Spaces", " "],
      ["Variable", ".@x"],
      ["Punctuation", ","],
      ["Spaces", " "],
      ["Number", "1"],
      ["Punctuation", ";"],
    ]);
  });

  it("distingue un label d'evenement", () => {
    expect(pairs("OnInit:")).toEqual([
      ["Identifier", "OnInit"],
      ["Punctuation", ":"],
    ]);
  });
});

describe("tokenize - fins de ligne", () => {
  it("produit un token par fin de ligne, CRLF compte pour un seul", () => {
    expect(pairs("a\nb\r\nc\rd")).toEqual([
      ["Identifier", "a"],
      ["Newline", "\n"],
      ["Identifier", "b"],
      ["Newline", "\r\n"],
      ["Identifier", "c"],
      ["Newline", "\r"],
      ["Identifier", "d"],
    ]);
  });

  it("ne fusionne pas deux fins de ligne successives", () => {
    expect(pairs("\r\n\r\n").map(([, text]) => text)).toEqual(["\r\n", "\r\n"]);
    expect(pairs("\n\r").map(([, text]) => text)).toEqual(["\n", "\r"]);
  });
});

describe("tokenize - commentaires", () => {
  it("lit un commentaire de ligne sans la fin de ligne", () => {
    expect(pairs("// note\nx")).toEqual([
      ["LineComment", "// note"],
      ["Newline", "\n"],
      ["Identifier", "x"],
    ]);
  });

  it("lit un commentaire bloc sur plusieurs lignes", () => {
    const [comment] = tokenize("/* a\nb */ y");
    expect(comment).toMatchObject({ kind: "BlockComment", text: "/* a\nb */" });
    expect(comment?.unterminated).toBeUndefined();
  });

  it("marque un commentaire bloc non ferme et le conserve jusqu'a la fin", () => {
    const tokens = tokenize("x /* ouvert\nsuite");
    const last = tokens[tokens.length - 1];
    expect(last).toMatchObject({ kind: "BlockComment", text: "/* ouvert\nsuite", unterminated: true });
  });

  it("ne ferme pas /*/ avec ses propres caracteres", () => {
    expect(tokenize("/*/")[0]).toMatchObject({ kind: "BlockComment", unterminated: true });
  });

  it("traite /= comme un operateur et // comme un commentaire", () => {
    expect(pairs("a /= 2")[2]).toEqual(["Operator", "/="]);
    expect(pairs("//=")[0]).toEqual(["LineComment", "//="]);
  });
});

describe("tokenize - chaines", () => {
  it("garde une chaine avec guillemet echappe en un seul token", () => {
    const [str] = tokenize('"a\\"b" suite');
    expect(str).toMatchObject({ kind: "String", text: '"a\\"b"' });
    expect(str?.unterminated).toBeUndefined();
  });

  it("arrete une chaine non fermee avant la fin de ligne", () => {
    expect(pairs('"abc\nnext;')).toEqual([
      ["String", '"abc'],
      ["Newline", "\n"],
      ["Identifier", "next"],
      ["Punctuation", ";"],
    ]);
    expect(tokenize('"abc\nnext;')[0]?.unterminated).toBe(true);
  });

  it("gere un antislash final et un guillemet isole", () => {
    expect(tokenize('"a\\')[0]).toMatchObject({ kind: "String", text: '"a\\', unterminated: true });
    expect(tokenize('"')[0]).toMatchObject({ kind: "String", text: '"', unterminated: true });
  });

  it("conserve les caracteres non ASCII a l'interieur d'une chaine", () => {
    expect(pairs('"é😀"')).toEqual([["String", '"é😀"']]);
  });
});

describe("tokenize - nombres", () => {
  it("lit les entiers decimaux et hexadecimaux", () => {
    expect(pairs("42 0x1F 0XaB")).toEqual([
      ["Number", "42"],
      ["Spaces", " "],
      ["Number", "0x1F"],
      ["Spaces", " "],
      ["Number", "0XaB"],
    ]);
  });

  it("ne prend pas un prefixe 0x sans chiffre pour un nombre hexadecimal", () => {
    expect(pairs("0x")).toEqual([["Identifier", "0x"]]);
    expect(pairs("0xZZ")).toEqual([["Identifier", "0xZZ"]]);
  });

  it("traite un mot commencant par un chiffre comme un identifiant (comme le serveur)", () => {
    // Constantes de sprite reelles : 4_DR_KID_01, 4_4JOB_LETICIA ; seule une suite de chiffres est un nombre.
    expect(pairs("4_DR_KID_01 12abc 7_ 100")).toEqual([
      ["Identifier", "4_DR_KID_01"],
      ["Spaces", " "],
      ["Identifier", "12abc"],
      ["Spaces", " "],
      ["Identifier", "7_"],
      ["Spaces", " "],
      ["Number", "100"],
    ]);
  });
});

describe("tokenize - variables chaine sans prefixe", () => {
  it("rattache le suffixe $ a un mot (variable permanente de type chaine)", () => {
    expect(pairs('currentquest$ + "x"')).toEqual([
      ["Variable", "currentquest$"],
      ["Spaces", " "],
      ["Operator", "+"],
      ["Spaces", " "],
      ["String", '"x"'],
    ]);
  });

  it("ne rattache pas $ a un nombre", () => {
    expect(pairs("12$")).toEqual([
      ["Number", "12"],
      ["Unknown", "$"],
    ]);
  });
});

describe("tokenize - variables", () => {
  it.each([".@x", ".x", "@x", "$x", "$@x", "#x", "##x", "'x", ".@name$", "$name$", "#a_1", "$050320_ein_typing", "$2011_agit_invest", ".@1"])(
    "reconnait %s comme une seule variable",
    (source) => {
      expect(pairs(source)).toEqual([["Variable", source]]);
    },
  );

  it.each([".", "@", "$", "#", "'", ".@", "$@", "##"])(
    "ne cree pas de variable pour le prefixe isole %s",
    (source) => {
      expect(pairs(source).every(([kind]) => kind === "Unknown")).toBe(true);
      expectLossless(source);
    },
  );

  it("separe l'indice de tableau de la variable", () => {
    expect(pairs(".@a[0]")).toEqual([
      ["Variable", ".@a"],
      ["Punctuation", "["],
      ["Number", "0"],
      ["Punctuation", "]"],
    ]);
  });
});

describe("tokenize - operateurs", () => {
  it.each(["<<=", ">>=", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "++", "--", "+=", "%=", "~=", "+", "?"])(
    "reconnait l'operateur %s",
    (source) => {
      expect(pairs(source)).toEqual([["Operator", source]]);
    },
  );

  it("prefere l'operateur le plus long", () => {
    expect(pairs("a>>=b")).toEqual([
      ["Identifier", "a"],
      ["Operator", ">>="],
      ["Identifier", "b"],
    ]);
  });
});

describe("tokenize - Unicode et inconnus", () => {
  it("conserve un caractere inconnu et un BOM en tete sans les supprimer", () => {
    expect(pairs("﻿mes")).toEqual([
      ["Unknown", "﻿"],
      ["Identifier", "mes"],
    ]);
    expect(pairs("é")).toEqual([["Unknown", "é"]]);
  });

  it("garde une paire de substitution dans un seul token Unknown", () => {
    expect(tokenize("😀")).toHaveLength(1);
    expect(tokenize("😀")[0]?.range).toEqual({ start: 0, end: 2 });
  });

  it("accepte des substituts isoles", () => {
    expect(pairs("\uD83D")).toEqual([["Unknown", "\uD83D"]]);
    expect(pairs("\uDE00")).toEqual([["Unknown", "\uDE00"]]);
  });

  it("exprime les offsets en code units UTF-16", () => {
    const tokens = tokenize('"😀" x');
    const x = tokens[tokens.length - 1];
    expect(x).toMatchObject({ kind: "Identifier", text: "x", range: { start: 5, end: 6 } });
  });
});

describe("isTrivia", () => {
  it("classe les espaces, tabulations, fins de ligne et commentaires en trivia", () => {
    const trivia: TokenKind[] = ["Spaces", "Tabs", "Newline", "LineComment", "BlockComment"];
    const significant: TokenKind[] = [
      "String", "Number", "Identifier", "Variable", "Operator", "Punctuation", "Unknown",
    ];
    expect(trivia.every(isTrivia)).toBe(true);
    expect(significant.some(isTrivia)).toBe(false);
  });
});

describe("tokenize - invariant sans perte", () => {
  const samples = [
    "",
    " ",
    "\t\t \t",
    "-\tscript\tHelper\t-1,{\r\n\tmes \"x\";\r\n\tclose;\r\n}\r\n",
    "prontera,155,180,4\twarp\tgate\t2,2,geffen,120,60\n",
    "function\tscript\tF_Test\t{\n\treturn .@a$ + \"é\";\n}\n",
    "/* commentaire\n sur deux lignes */\n// fin sans retour",
    "a\r\nb\nc\rd\n\r",
    "\"non ferme\n'x $y #z ##w .@v $@u\n",
  ];

  it.each(samples.map((sample, index) => [index, sample] as const))(
    "echantillon %i : tokens contigus et concatenation identique",
    (_index, sample) => {
      expectLossless(sample);
    },
  );

  it("est deterministe", () => {
    const sample = samples[3] ?? "";
    expect(tokenize(sample)).toEqual(tokenize(sample));
  });

  it("ne leve jamais d'exception et reste sans perte sur 1000 textes pseudo-aleatoires (graine fixe)", () => {
    const fragments = [
      '"', "\\", "/", "*", "//", "/*", "*/", "\n", "\r", "\r\n", "\t", " ", ".", "@", "$", "#", "'",
      "a", "Z", "_", "0", "9", "x", "<<=", "=", "{", "}", "(", ")", "[", "]", ";", ",", ":",
      "😀", "\uD83D", "\uDE00", "é", "﻿", "\0",
    ];
    // PRNG mulberry32 : suite reproductible, sans dependance.
    let state = 0x2f6e2b1;
    const random = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let run = 0; run < 1000; run += 1) {
      const count = Math.floor(random() * 40);
      let text = "";
      for (let i = 0; i < count; i += 1) {
        text += fragments[Math.floor(random() * fragments.length)] ?? "";
      }
      expectLossless(text);
    }
  });
});
