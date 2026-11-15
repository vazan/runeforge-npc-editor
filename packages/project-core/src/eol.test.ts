import { describe, expect, it } from "vitest";
import { detectEol, normalizeToLf } from "@runeforge/runescript-core";
import { preserveMixedEol, restoreEol, splitWithEol } from "./index";

describe("splitWithEol", () => {
  it("conserve la fin de ligne de chaque ligne, la derniere pouvant ne pas en avoir", () => {
    expect(splitWithEol("a\r\nb\nc\rd")).toEqual([
      { content: "a", eol: "\r\n" },
      { content: "b", eol: "\n" },
      { content: "c", eol: "\r" },
      { content: "d", eol: "" },
    ]);
    expect(splitWithEol("a\n")).toEqual([
      { content: "a", eol: "\n" },
      { content: "", eol: "" },
    ]);
    expect(splitWithEol("")).toEqual([{ content: "", eol: "" }]);
  });
});

describe("restoreEol", () => {
  it("convertit simplement les fichiers a fins de ligne uniformes", () => {
    expect(restoreEol("a\nb\n", { text: "x\r\ny\r\n", eol: "CRLF" })).toBe("a\r\nb\r\n");
    expect(restoreEol("a\nb", { text: "x\ry", eol: "CR" })).toBe("a\rb");
    expect(restoreEol("a\nb", { text: "x\ny", eol: "LF" })).toBe("a\nb");
  });

  it("restitue exactement un fichier mixte non modifie", () => {
    const original = "a\r\nb\nc\r\nd\re";
    expect(detectEol(original)).toBe("mixed");
    expect(restoreEol(normalizeToLf(original), { text: original, eol: "mixed" })).toBe(original);
  });

  it("conserve la fin de ligne des lignes inchangees d'un fichier mixte apres une edition", () => {
    const original = "a\r\nb\nc\r\nd\r\n";
    // modification de "b" : conserve son LF ; les autres lignes gardent CRLF
    expect(preserveMixedEol(original, "a\nB\nc\nd\n")).toBe("a\r\nB\nc\r\nd\r\n");
  });

  it("donne la fin de ligne dominante aux lignes nouvelles et gere ajout/suppression en fin de fichier", () => {
    const original = "a\r\nb\r\nc\n"; // CRLF dominant
    expect(preserveMixedEol(original, "a\nnew\nb\nc\n")).toBe("a\r\nnew\r\nb\r\nc\n");
    expect(preserveMixedEol(original, "a\nb\n")).toBe("a\r\nb\r\n");
    expect(preserveMixedEol(original, "a\nb\nc\nd")).toBe("a\r\nb\r\nc\n" + "d");
  });

  it("ne cree pas de fin de ligne finale qui n'existait pas", () => {
    expect(preserveMixedEol("a\r\nb\nc", "a\nb\nc")).toBe("a\r\nb\nc");
  });

  it("preserve le contenu et restitue l'original sur des fichiers et edits aleatoires (propriete)", () => {
    let state = 987654321;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const eols = ["\n", "\r\n", "\r"];
    for (let run = 0; run < 300; run += 1) {
      const lineCount = Math.floor(random() * 12) + 1;
      let original = "";
      for (let i = 0; i < lineCount; i += 1) {
        original += `ligne ${Math.floor(random() * 6)}`;
        if (i < lineCount - 1 || random() < 0.5) original += eols[Math.floor(random() * 3)];
      }
      const lf = normalizeToLf(original);
      // 1) non modifie -> identique, quel que soit le type de fins de ligne
      expect(restoreEol(lf, { text: original, eol: detectEol(original) })).toBe(original);
      // 2) edite -> le contenu normalise est exactement le texte edite
      const lines = lf.split("\n");
      const edited = lines.map((line) => (random() < 0.2 ? `${line}!` : line));
      if (random() < 0.4) edited.splice(Math.floor(random() * edited.length), 0, "inseree");
      if (random() < 0.3 && edited.length > 1) edited.splice(Math.floor(random() * edited.length), 1);
      const editedLf = edited.join("\n");
      expect(normalizeToLf(restoreEol(editedLf, { text: original, eol: detectEol(original) }))).toBe(editedLf);
    }
  });
});
