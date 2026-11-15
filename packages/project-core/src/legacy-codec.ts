/**
 * Codec d'encodages "herites" (octets <-> texte) **sans perte** pour les octets valides.
 *
 * Les scripts de serveurs reels melangent UTF-8 et encodages 8 bits historiques (28 fichiers sur 1 133 dans le
 * corpus local). Aucun encodage n'est converti silencieusement : le fichier est relu et reecrit dans son encodage
 * d'origine. `TextDecoder` sait decoder tous les encodages WHATWG mais pas les encoder ; ce module construit donc
 * les tables inverses en decodant toutes les sequences possibles.
 */

export interface UnencodableCharacter {
  /** Offset UTF-16 du caractere dans le texte. */
  readonly offset: number;
  readonly char: string;
}

export interface LegacyCodec {
  readonly label: string;
  readonly multiByte: boolean;
  decode(bytes: Uint8Array): string;
  /** `bytes` si tout est encodable, sinon la liste des caracteres impossibles a representer. */
  encode(text: string): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly unencodable: UnencodableCharacter[] };
}

const REPLACEMENT = "�";
const cache = new Map<string, LegacyCodec | null>();

/** Codec pour un libelle WHATWG (`windows-1252`, `shift_jis`, `gbk`...) ; `null` si le libelle n'est pas supporte. */
export function getLegacyCodec(label: string): LegacyCodec | null {
  const key = label.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const codec = buildCodec(key);
  cache.set(key, codec);
  return codec;
}

function tryDecoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/**
 * Table WHATWG de windows-1252 pour les octets 0x80-0x9F (les autres octets sont identiques a ISO-8859-1).
 * Les cinq octets non assignes (0x81, 0x8D, 0x8F, 0x90, 0x9D) donnent le point de code identique, ce qui rend
 * l'encodage bijectif sur 256 valeurs. Table explicite car `TextDecoder` de certaines plateformes (Node)
 * decode `windows-1252` comme ISO-8859-1 (0x80 -> U+0080), contrairement aux navigateurs.
 */
const WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Libelles WHATWG equivalents a windows-1252 (l'Encoding Standard traite ISO-8859-1 et US-ASCII comme windows-1252). */
const WINDOWS_1252_LABELS: ReadonlySet<string> = new Set([
  "windows-1252", "cp1252", "x-cp1252", "latin1", "iso-8859-1", "iso8859-1", "iso_8859-1", "l1", "latin-1", "ascii", "us-ascii",
]);

function windows1252Table(): string[] {
  const table: string[] = new Array<string>(256);
  for (let byte = 0; byte < 256; byte += 1) {
    const codePoint = byte >= 0x80 && byte <= 0x9f ? (WINDOWS_1252_HIGH[byte - 0x80] ?? byte) : byte;
    table[byte] = String.fromCodePoint(codePoint);
  }
  return table;
}

function buildCodec(label: string): LegacyCodec | null {
  let decoder: TextDecoder | null = null;
  let single: string[];
  let encodingName: string;
  if (WINDOWS_1252_LABELS.has(label)) {
    single = windows1252Table();
    encodingName = "windows-1252";
  } else {
    decoder = tryDecoder(label);
    if (decoder === null) return null;
    // Les encodages UTF-* ne sont pas "herites" : ils sont geres par le codec principal.
    if (/^utf-?(8|16|32)/.test(decoder.encoding)) return null;
    encodingName = decoder.encoding;
    single = new Array<string>(256);
    for (let byte = 0; byte < 256; byte += 1) single[byte] = decoder.decode(Uint8Array.of(byte));
  }
  let invalidSingles = 0;
  for (let byte = 0x80; byte < 256; byte += 1) {
    const text = single[byte];
    if (text === undefined || text === REPLACEMENT || text.length === 0) invalidSingles += 1;
  }

  // Plus de 30 octets hauts invalides : encodage a plusieurs octets (octets de tete).
  const multiByte = invalidSingles > 30;
  const reverse = new Map<string, number[]>();
  for (let byte = 0; byte < 256; byte += 1) {
    const text = single[byte];
    if (text !== undefined && text !== REPLACEMENT && text.length > 0 && !reverse.has(text)) reverse.set(text, [byte]);
  }
  if (multiByte && decoder !== null) {
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) {
        const text = decoder.decode(Uint8Array.of(lead, trail));
        const codePoints = [...text];
        if (codePoints.length === 1 && text !== REPLACEMENT && !reverse.has(text)) reverse.set(text, [lead, trail]);
      }
    }
  }

  return {
    label: encodingName,
    multiByte,
    decode(bytes) {
      if (!multiByte) {
        const parts: string[] = [];
        const chunk = 8192;
        for (let start = 0; start < bytes.length; start += chunk) {
          const end = Math.min(start + chunk, bytes.length);
          let piece = "";
          for (let i = start; i < end; i += 1) piece += single[bytes[i] ?? 0] ?? REPLACEMENT;
          parts.push(piece);
        }
        return parts.join("");
      }
      return new TextDecoder(encodingName).decode(bytes);
    },
    encode(text) {
      const out: number[] = [];
      const unencodable: UnencodableCharacter[] = [];
      for (let offset = 0; offset < text.length; ) {
        const codePoint = text.codePointAt(offset) ?? 0;
        const char = String.fromCodePoint(codePoint);
        const mapped = reverse.get(char);
        if (mapped !== undefined) {
          for (const byte of mapped) out.push(byte);
        } else {
          unencodable.push({ offset, char });
        }
        offset += char.length;
      }
      return unencodable.length > 0 ? { ok: false, unencodable } : { ok: true, bytes: Uint8Array.from(out) };
    },
  };
}
