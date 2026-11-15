import { describe, expect, it } from "vitest";
import { FrameError, decodeFrames, encodeFrames } from "./frames";

describe("decodeFrames", () => {
  it("decode la structure exacte produite par le coeur Rust (octets d'or du test frames.rs)", () => {
    // 1 enregistrement ; meta = {"p":"a"} (9 octets) ; donnees = [1,2,3]
    const golden = Uint8Array.from([1, 0, 0, 0, 9, 0, 0, 0, ...new TextEncoder().encode('{"p":"a"}'), 3, 0, 0, 0, 1, 2, 3]);
    const frames = decodeFrames<{ p: string }>(golden);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta).toEqual({ p: "a" });
    expect([...(frames[0]?.data ?? [])]).toEqual([1, 2, 3]);
  });

  it("fait l'aller-retour de donnees binaires quelconques et de charges vides", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    const frames = decodeFrames(encodeFrames([
      { meta: { ok: true }, data: new Uint8Array() },
      { meta: { ok: true, nom: "café" }, data: all },
    ]));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.data.length).toBe(0);
    expect([...(frames[1]?.data ?? [])]).toEqual([...all]);
    expect(frames[1]?.meta).toEqual({ ok: true, nom: "café" });
  });

  it("accepte un ArrayBuffer et une vue decalee dans un tampon plus grand", () => {
    const encoded = encodeFrames([{ meta: {}, data: Uint8Array.of(9) }]);
    expect(decodeFrames(encoded.buffer.slice(0) as ArrayBuffer)).toHaveLength(1);
    const padded = new Uint8Array(encoded.length + 8);
    padded.set(encoded, 8);
    expect(decodeFrames(padded.subarray(8))).toHaveLength(1);
  });

  it("rejette les tampons tronques, les metadonnees invalides et les octets en trop", () => {
    const valid = encodeFrames([{ meta: { a: 1 }, data: Uint8Array.of(1, 2) }]);
    expect(() => decodeFrames(valid.subarray(0, valid.length - 1))).toThrow(FrameError);
    expect(() => decodeFrames(valid.subarray(0, 3))).toThrow(FrameError);
    expect(() => decodeFrames(Uint8Array.from([...valid, 0]))).toThrow(FrameError);
    const badMeta = Uint8Array.from([1, 0, 0, 0, 2, 0, 0, 0, 0x7b, 0x7b, 0, 0, 0, 0]);
    expect(() => decodeFrames(badMeta)).toThrow(FrameError);
  });
});
