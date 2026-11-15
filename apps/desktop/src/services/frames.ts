/**
 * Decodage des reponses binaires du coeur Rust (contrat : `src-tauri/src/frames.rs`).
 *
 * ```text
 * u32 LE nombre d'enregistrements
 * pour chaque enregistrement : u32 LE longueur_meta | meta (JSON UTF-8) | u32 LE longueur_donnees | donnees
 * ```
 */

export interface Frame<M = unknown> {
  readonly meta: M;
  readonly data: Uint8Array;
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export function decodeFrames<M = unknown>(input: ArrayBuffer | Uint8Array): Frame<M>[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const readU32 = (): number => {
    if (offset + 4 > bytes.length) throw new FrameError("truncated frame header");
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const take = (length: number): Uint8Array => {
    if (offset + length > bytes.length) throw new FrameError("truncated frame payload");
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };

  const count = readU32();
  const frames: Frame<M>[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index += 1) {
    const metaBytes = take(readU32());
    let meta: M;
    try {
      meta = JSON.parse(decoder.decode(metaBytes)) as M;
    } catch {
      throw new FrameError("invalid frame metadata");
    }
    const data = take(readU32());
    frames.push({ meta, data });
  }
  if (offset !== bytes.length) throw new FrameError("unexpected trailing bytes");
  return frames;
}

/** Encodage (utilise par les doublures de test pour imiter le coeur Rust ; meme format). */
export function encodeFrames(frames: readonly Frame[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const u32 = (value: number): Uint8Array => {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value, true);
    return buffer;
  };
  parts.push(u32(frames.length));
  for (const frame of frames) {
    const meta = encoder.encode(JSON.stringify(frame.meta));
    parts.push(u32(meta.length), meta, u32(frame.data.length), frame.data);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    output.set(part, position);
    position += part.length;
  }
  return output;
}
