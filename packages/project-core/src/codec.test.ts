import { describe, expect, it } from "vitest";
import { decodeDocument, encodeDocument, getLegacyCodec } from "./index";
import type { DecodedDocument } from "./index";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function expectText(result: ReturnType<typeof decodeDocument>): DecodedDocument {
  if (result.kind !== "text") throw new Error(`document non texte : ${result.reason}`);
  return result;
}

function roundtrip(input: Uint8Array, legacyEncoding?: string): Uint8Array {
  const decoded = expectText(decodeDocument(input, legacyEncoding === undefined ? {} : { legacyEncoding }));
  const encoded = encodeDocument(decoded.text, { encoding: decoded.encoding, bom: decoded.bom });
  if (!encoded.ok) throw new Error("encodage impossible");
  return encoded.bytes;
}

describe("decodeDocument / encodeDocument", () => {
  it("traite un fichier vide comme un texte UTF-8 vide", () => {
    const decoded = expectText(decodeDocument(new Uint8Array()));
    expect(decoded).toMatchObject({ text: "", encoding: "utf-8", bom: false, eol: "LF" });
  });

  it("detecte l'UTF-8 valide, avec ou sans BOM, et reecrit les memes octets", () => {
    const plain = ascii('mes "café \u{1F600}";\r\n');
    const decoded = expectText(decodeDocument(plain));
    expect(decoded).toMatchObject({ encoding: "utf-8", bom: false, eol: "CRLF", encodingSource: "utf-8" });
    expect(roundtrip(plain)).toEqual(plain);

    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...ascii("mes \"a\";\n")]);
    const decodedBom = expectText(decodeDocument(withBom));
    expect(decodedBom).toMatchObject({ bom: true, text: 'mes "a";\n', encodingSource: "bom" });
    expect(roundtrip(withBom)).toEqual(withBom);
  });

  it("reconnait UTF-16 LE/BE avec BOM et les reecrit a l'identique", () => {
    const le = bytes(0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00, 0xe9, 0x00);
    expect(expectText(decodeDocument(le))).toMatchObject({ encoding: "utf-16le", bom: true, text: "a\né" });
    expect(roundtrip(le)).toEqual(le);
    const be = bytes(0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a);
    expect(expectText(decodeDocument(be))).toMatchObject({ encoding: "utf-16be", text: "a\n" });
    expect(roundtrip(be)).toEqual(be);
  });

  it("refuse UTF-16 tronque, UTF-32 et les fichiers binaires sans les convertir", () => {
    expect(decodeDocument(bytes(0xff, 0xfe, 0x61))).toEqual({ kind: "unsupported", reason: "invalid-utf16" });
    expect(decodeDocument(bytes(0xff, 0xfe, 0x00, 0x00, 0x61, 0, 0, 0))).toEqual({ kind: "unsupported", reason: "utf32" });
    expect(decodeDocument(bytes(0x00, 0x00, 0xfe, 0xff))).toEqual({ kind: "unsupported", reason: "utf32" });
    expect(decodeDocument(bytes(0x4d, 0x5a, 0x00, 0x90, 0x01))).toEqual({ kind: "unsupported", reason: "binary" });
  });

  it("lit un encodage 8 bits herite (windows-1252) sans perte et le signale", () => {
    const input = bytes(...ascii("mes \"caf"), 0xe9, ...ascii("\";\n"));
    const decoded = expectText(decodeDocument(input));
    expect(decoded).toMatchObject({ encoding: "windows-1252", encodingSource: "legacy", text: 'mes "café";\n' });
    expect(decoded.warnings.map((warning) => warning.code)).toEqual(["legacy-encoding-assumed"]);
    expect(roundtrip(input)).toEqual(input);
  });

  it("reproduit octet pour octet tous les octets non nuls en windows-1252 (y compris 0x81, 0x8D, 0x8F, 0x90, 0x9D)", () => {
    const all = Uint8Array.from({ length: 255 }, (_, index) => index + 1);
    const decoded = expectText(decodeDocument(all));
    expect(decoded.encoding).toBe("windows-1252");
    expect(roundtrip(all)).toEqual(all);
  });

  it("utilise l'encodage herite configure quand il reproduit les octets (Shift_JIS)", () => {
    if (getLegacyCodec("shift_jis") === null) return; // ICU sans Shift_JIS : test non applicable
    const input = bytes(0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, ...ascii("\n"));
    const decoded = expectText(decodeDocument(input, { legacyEncoding: "shift_jis" }));
    expect(decoded.text).toBe("こんに\n");
    expect(decoded.encoding).toBe("shift_jis");
    expect(roundtrip(input, "shift_jis")).toEqual(input);
  });

  it("se replie sur windows-1252 (octet pour octet) quand l'encodage configure ne reproduit pas les octets", () => {
    if (getLegacyCodec("shift_jis") === null) return;
    const input = bytes(...ascii("a"), 0x81, 0x0a); // octet de tete suivi d'un saut de ligne : sequence invalide en Shift_JIS
    const decoded = expectText(decodeDocument(input, { legacyEncoding: "shift_jis" }));
    expect(decoded.encoding).toBe("windows-1252");
    expect(decoded.warnings.map((warning) => warning.code)).toContain("legacy-fallback");
    expect(roundtrip(input, "shift_jis")).toEqual(input);
  });

  it("signale les fins de ligne mixtes", () => {
    const decoded = expectText(decodeDocument(ascii("a\r\nb\nc")));
    expect(decoded.eol).toBe("mixed");
    expect(decoded.warnings.map((warning) => warning.code)).toContain("mixed-eol");
  });

  it("refuse d'encoder un caractere absent de l'encodage du fichier au lieu de le remplacer", () => {
    const result = encodeDocument("café \u{1F600} ok", { encoding: "windows-1252", bom: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unencodable.map((item) => [item.offset, item.char])).toEqual([[5, "\u{1F600}"]]);
  });

  it("refuse une demi-paire de substitution isolee en UTF-8", () => {
    const result = encodeDocument("a\ud83dz", { encoding: "utf-8", bom: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unencodable[0]?.offset).toBe(1);
  });

  it("conserve les demi-paires isolees en UTF-16 (pas de perte)", () => {
    const result = encodeDocument("a\ud83d", { encoding: "utf-16le", bom: true });
    expect(result).toEqual({ ok: true, bytes: bytes(0xff, 0xfe, 0x61, 0x00, 0x3d, 0xd8) });
  });

  it("refuse un encodage inconnu a l'ecriture", () => {
    expect(encodeDocument("a", { encoding: "klingon", bom: false }).ok).toBe(false);
  });
});

describe("getLegacyCodec", () => {
  it("construit et met en cache un codec 8 bits, refuse les libelles inconnus et UTF-*", () => {
    const codec = getLegacyCodec("windows-1252");
    expect(codec).not.toBeNull();
    expect(getLegacyCodec("Windows-1252")).toBe(codec);
    expect(getLegacyCodec("klingon")).toBeNull();
    expect(getLegacyCodec("utf-8")).toBeNull();
  });

  it("decode et encode un texte avec le codec windows-1252 (euro en 0x80)", () => {
    const codec = getLegacyCodec("windows-1252");
    expect(codec?.decode(bytes(0x80, 0xe9))).toBe("€é");
    expect(codec?.encode("€é")).toEqual({ ok: true, bytes: bytes(0x80, 0xe9) });
  });
});
