import { detectEol, type EndOfLine } from "@runeforge/runescript-core";
import { getLegacyCodec, type UnencodableCharacter } from "./legacy-codec";

/**
 * Codec de documents : octets <-> texte, sans perte silencieuse (CLAUDE.md 9.2, RF-003/RF-014).
 *
 * Ordre de detection : BOM UTF-8/UTF-16 -> UTF-8 strict -> encodage herite configure (defaut windows-1252).
 * Un fichier contenant des octets nuls (hors UTF-16) est considere binaire et n'est pas ouvert comme texte.
 * Un texte n'est jamais "reecrit" par remplacement de caracteres : si un caractere ne peut pas etre represente
 * dans l'encodage du fichier, l'encodage est refuse et la liste des caracteres fautifs est renvoyee.
 */

export type DocumentWarningCode =
  /** Fichier non UTF-8 : l'encodage herite configure est suppose (le texte affiche peut etre incorrect si l'hypothese est fausse). */
  | "legacy-encoding-assumed"
  /** Le codec herite configure ne reproduit pas les octets : repli sur windows-1252 (octet pour octet). */
  | "legacy-fallback"
  | "mixed-eol";

export interface DocumentWarning {
  readonly code: DocumentWarningCode;
  readonly detail?: string;
}

export interface DecodedDocument {
  readonly kind: "text";
  /** Texte decode, sans BOM, avec les fins de ligne d'origine. */
  readonly text: string;
  /** `utf-8`, `utf-16le`, `utf-16be` ou un libelle WHATWG d'encodage herite. */
  readonly encoding: string;
  readonly bom: boolean;
  readonly eol: EndOfLine;
  readonly encodingSource: "bom" | "utf-8" | "legacy";
  readonly warnings: readonly DocumentWarning[];
}

export interface UnsupportedDocument {
  readonly kind: "unsupported";
  readonly reason: "binary" | "utf32" | "invalid-utf16";
}

export interface DecodeOptions {
  /** Encodage herite suppose pour les fichiers non UTF-8. Defaut : `windows-1252`. */
  readonly legacyEncoding?: string;
}

export interface EncodeMeta {
  readonly encoding: string;
  readonly bom: boolean;
}

export type EncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly unencodable: readonly UnencodableCharacter[] };

const DEFAULT_LEGACY = "windows-1252";

function hasPrefix(bytes: Uint8Array, ...prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function textDocument(
  text: string,
  encoding: string,
  bom: boolean,
  encodingSource: DecodedDocument["encodingSource"],
  warnings: DocumentWarning[],
): DecodedDocument {
  const eol = detectEol(text);
  if (eol === "mixed") warnings.push({ code: "mixed-eol" });
  return { kind: "text", text, encoding, bom, eol, encodingSource, warnings };
}

export function decodeDocument(bytes: Uint8Array, options: DecodeOptions = {}): DecodedDocument | UnsupportedDocument {
  if (bytes.length === 0) return textDocument("", "utf-8", false, "utf-8", []);

  if (hasPrefix(bytes, 0xff, 0xfe, 0x00, 0x00) || hasPrefix(bytes, 0x00, 0x00, 0xfe, 0xff)) {
    return { kind: "unsupported", reason: "utf32" };
  }
  if (hasPrefix(bytes, 0xff, 0xfe) || hasPrefix(bytes, 0xfe, 0xff)) {
    const little = bytes[0] === 0xff;
    const encoding = little ? "utf-16le" : "utf-16be";
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(2));
      return textDocument(text, encoding, true, "bom", []);
    } catch {
      return { kind: "unsupported", reason: "invalid-utf16" };
    }
  }

  const hasUtf8Bom = hasPrefix(bytes, 0xef, 0xbb, 0xbf);
  const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
  if (bytes.includes(0)) return { kind: "unsupported", reason: "binary" };

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return textDocument(text, "utf-8", hasUtf8Bom, hasUtf8Bom ? "bom" : "utf-8", []);
  } catch {
    // Pas de l'UTF-8 valide : encodage herite.
  }

  const warnings: DocumentWarning[] = [];
  const requested = options.legacyEncoding ?? DEFAULT_LEGACY;
  let codec = getLegacyCodec(requested);
  if (codec !== null) {
    const text = codec.decode(bytes);
    const again = codec.encode(text);
    if (again.ok && sameBytes(again.bytes, bytes)) {
      warnings.push({ code: "legacy-encoding-assumed", detail: codec.label });
      return textDocument(text, codec.label, false, "legacy", warnings);
    }
  }
  codec = getLegacyCodec(DEFAULT_LEGACY);
  if (codec === null) return { kind: "unsupported", reason: "binary" };
  warnings.push({ code: "legacy-fallback", detail: requested });
  warnings.push({ code: "legacy-encoding-assumed", detail: codec.label });
  return textDocument(codec.decode(bytes), codec.label, false, "legacy", warnings);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Positions des demi-paires de substitution isolees (non representables en UTF-8). */
function findLoneSurrogates(text: string): UnencodableCharacter[] {
  const found: UnencodableCharacter[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      } else {
        found.push({ offset: i, char: text.charAt(i) });
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      found.push({ offset: i, char: text.charAt(i) });
    }
  }
  return found;
}

function encodeUtf16(text: string, little: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out[i * 2] = little ? unit & 0xff : unit >> 8;
    out[i * 2 + 1] = little ? unit >> 8 : unit & 0xff;
  }
  return out;
}

export function encodeDocument(text: string, meta: EncodeMeta): EncodeResult {
  let body: Uint8Array;
  let bomBytes: number[] = [];
  switch (meta.encoding) {
    case "utf-8": {
      const lone = findLoneSurrogates(text);
      if (lone.length > 0) return { ok: false, unencodable: lone };
      body = new TextEncoder().encode(text);
      if (meta.bom) bomBytes = [0xef, 0xbb, 0xbf];
      break;
    }
    case "utf-16le":
      body = encodeUtf16(text, true);
      if (meta.bom) bomBytes = [0xff, 0xfe];
      break;
    case "utf-16be":
      body = encodeUtf16(text, false);
      if (meta.bom) bomBytes = [0xfe, 0xff];
      break;
    default: {
      const codec = getLegacyCodec(meta.encoding);
      if (codec === null) return { ok: false, unencodable: [{ offset: 0, char: "" }] };
      const result = codec.encode(text);
      if (!result.ok) return result;
      body = result.bytes;
    }
  }
  if (bomBytes.length === 0) return { ok: true, bytes: body };
  const bytes = new Uint8Array(bomBytes.length + body.length);
  bytes.set(bomBytes, 0);
  bytes.set(body, bomBytes.length);
  return { ok: true, bytes };
}
