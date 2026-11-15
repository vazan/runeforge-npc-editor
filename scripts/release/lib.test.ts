import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactName, buildManifest, executableKindFor, hasExecutableHeader, isPreRelease, isSafeFileName, isVersion, sha256Hex, softwareRoot, verifySignature, type ManifestInput } from "./lib";

const fixtures = join(softwareRoot, "crates", "updater", "tests", "fixtures");
const read = (name: string): string => readFileSync(join(fixtures, name), "utf8");
const testPublic = read(join("keys", "test.key.pub"));

const HASH = "a".repeat(64);
const input = (extra: Partial<ManifestInput> = {}): ManifestInput => ({
  version: "0.2.0",
  channel: "stable",
  publishedAt: "2026-11-15T10:00:00Z",
  notes: "Premiere ligne.\nSeconde ligne.",
  artifacts: [{ platform: "windows-x86_64", file: "runeforge-studio-0.2.0-windows-x86_64.exe", size: 1000, sha256: HASH }],
  ...extra,
});

describe("versions et noms de fichiers", () => {
  it("n'accepte que du semver strict, sans prefixe v ni metadonnees de construction", () => {
    for (const good of ["0.0.0", "1.2.3", "10.20.30", "1.0.0-beta.1", "1.0.0-rc.1", "0.3.0-beta.1"]) expect(isVersion(good), good).toBe(true);
    for (const bad of ["", "1", "1.2", "v1.2.3", "01.2.3", "1.2.3+build", "1.2.3-", "1.2.3-01", "1.2.x", " 1.2.3", "1.2.3 "]) expect(isVersion(bad), bad).toBe(false);
  });

  it("reconnait une pre-version", () => {
    expect(isPreRelease("1.0.0-beta.1")).toBe(true);
    expect(isPreRelease("1.0.0")).toBe(false);
  });

  it("nomme le fichier d'une release d'apres la version et la plateforme", () => {
    expect(artifactName("0.2.0", "windows-x86_64")).toBe("runeforge-studio-0.2.0-windows-x86_64.exe");
    expect(artifactName("0.2.0", "linux-x86_64")).toBe("runeforge-studio-0.2.0-linux-x86_64");
  });

  it("associe Windows a l'en-tete MZ et Linux a l'en-tete ELF, comme le coeur de mise a jour (lu dans le code Rust), et ne connait rien d'autre", () => {
    const source = readFileSync(join(softwareRoot, "crates", "updater", "src", "platform.rs"), "utf8");
    const arms = [...source.matchAll(/"([a-z]+)" => Some\(ExecutableKind::(Pe|Elf)\)/g)].map((match) => `${match[1]}:${match[2]}`);
    expect(arms.sort()).toEqual(["linux:Elf", "windows:Pe"]);

    expect(executableKindFor("windows-x86_64")).toBe("pe");
    expect(executableKindFor("linux-x86_64")).toBe("elf");
    expect(executableKindFor("linux-aarch64")).toBe("elf");
    for (const unknown of ["macos-aarch64", "freebsd-x86_64", "x86_64", "", "Windows-x86_64"]) expect(executableKindFor(unknown), unknown).toBeUndefined();

    const windows = Buffer.from("MZ\x90\x00");
    const linux = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]);
    expect(hasExecutableHeader("pe", windows) && !hasExecutableHeader("pe", linux)).toBe(true);
    expect(hasExecutableHeader("elf", linux) && !hasExecutableHeader("elf", windows)).toBe(true);
    for (const wrong of [Buffer.alloc(0), Buffer.from("M"), Buffer.from([0x7f, 0x45, 0x4c]), Buffer.from("#!/bin/sh\n"), Buffer.from("PK\x03\x04")]) {
      expect(hasExecutableHeader("pe", wrong) || hasExecutableHeader("elf", wrong), JSON.stringify(wrong)).toBe(false);
    }
  });

  it("refuse les noms de fichier qui sortiraient du dossier ou prendraient un autre sens", () => {
    for (const good of ["a.exe", "runeforge-studio-0.2.0-windows-x86_64.exe", "A_b-c.1"]) expect(isSafeFileName(good), good).toBe(true);
    for (const bad of ["", ".hidden", "-x", "a/b", "a\\b", "..", "a..b", "a b", "é.exe", "a".repeat(129), "C:x"]) expect(isSafeFileName(bad), bad).toBe(false);
  });
});

describe("manifeste de release", () => {
  it("produit un JSON stable, avec le produit, le schema et un seul champ par fait", () => {
    const text = buildManifest(input({ minimumVersion: "0.1.0" }));
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      schema: 1,
      product: "runeforge-studio",
      version: "0.2.0",
      channel: "stable",
      publishedAt: "2026-11-15T10:00:00Z",
      notes: "Premiere ligne.\nSeconde ligne.",
      minimumVersion: "0.1.0",
      platforms: { "windows-x86_64": { file: "runeforge-studio-0.2.0-windows-x86_64.exe", size: 1000, sha256: HASH } },
    });
    expect(buildManifest(input())).toBe(buildManifest(input()));
    expect(JSON.parse(buildManifest(input()))).not.toHaveProperty("minimumVersion");
  });

  it("refuse ce que l'application refuserait de lire, avant toute signature", () => {
    const refused: [string, Partial<ManifestInput>][] = [
      ["version", { version: "v0.2.0" }],
      ["canal", { channel: "nightly" as never }],
      ["pre-version", { version: "0.2.0-beta.1", channel: "stable" }],
      ["publishedAt", { publishedAt: "hier" }],
      ["notes (cloche)", { notes: "bip\u0007" }],
      ["notes (DEL)", { notes: "x\u007f" }],
      ["notes (C1)", { notes: "x\u0085y" }],
      ["notes (trop longues)", { notes: "x".repeat(8 * 1024 + 1) }],
      ["minimumVersion", { minimumVersion: "1.x" }],
      ["plateformes", { artifacts: [] }],
      ["plateforme", { artifacts: [{ platform: "Windows", file: "a.exe", size: 1, sha256: HASH }] }],
      ["plateforme non prise en charge (macOS)", { artifacts: [{ platform: "macos-aarch64", file: "a", size: 1, sha256: HASH }] }],
      ["fichier", { artifacts: [{ platform: "windows-x86_64", file: "../a.exe", size: 1, sha256: HASH }] }],
      ["sha256", { artifacts: [{ platform: "windows-x86_64", file: "a.exe", size: 1, sha256: "ABC" }] }],
      ["taille (zero)", { artifacts: [{ platform: "windows-x86_64", file: "a.exe", size: 0, sha256: HASH }] }],
      ["taille (enorme)", { artifacts: [{ platform: "windows-x86_64", file: "a.exe", size: 257 * 1024 * 1024, sha256: HASH }] }],
      [
        "plateforme en double",
        { artifacts: [{ platform: "windows-x86_64", file: "a.exe", size: 1, sha256: HASH }, { platform: "windows-x86_64", file: "b.exe", size: 1, sha256: HASH }] },
      ],
    ];
    for (const [name, extra] of refused) expect(() => buildManifest(input(extra)), name).toThrow(/manifeste invalide/);
  });

  it("accepte les notes avec tabulations et sauts de ligne, et une pre-version sur le canal bêta", () => {
    expect(() => buildManifest(input({ notes: "a\tb\r\nc\n" }))).not.toThrow();
    expect(() => buildManifest(input({ version: "0.3.0-beta.1", channel: "beta" }))).not.toThrow();
  });

  it("accepte Windows et Linux (x86_64 et aarch64) dans un meme manifeste, chacun avec son fichier", () => {
    const text = buildManifest(
      input({
        artifacts: [
          { platform: "windows-x86_64", file: artifactName("0.2.0", "windows-x86_64"), size: 1000, sha256: HASH },
          { platform: "linux-x86_64", file: artifactName("0.2.0", "linux-x86_64"), size: 2000, sha256: "b".repeat(64) },
          { platform: "linux-aarch64", file: artifactName("0.2.0", "linux-aarch64"), size: 3000, sha256: "c".repeat(64) },
        ],
      }),
    );
    expect(JSON.parse(text).platforms).toEqual({
      "windows-x86_64": { file: "runeforge-studio-0.2.0-windows-x86_64.exe", size: 1000, sha256: HASH },
      "linux-x86_64": { file: "runeforge-studio-0.2.0-linux-x86_64", size: 2000, sha256: "b".repeat(64) },
      "linux-aarch64": { file: "runeforge-studio-0.2.0-linux-aarch64", size: 3000, sha256: "c".repeat(64) },
    });
  });
});

describe("signature de test (verification independante de celle de l'application)", () => {
  it("accepte les manifestes signes par la cle de test, tels que les tests Rust les lisent", () => {
    for (const name of ["ok", "beta", "minimum", "linux-only", "bad-hash", "not-exe", "other-version", "future-schema", "wrong-product"]) {
      const manifest = readFileSync(join(fixtures, `${name}.manifest.json`));
      expect(verifySignature(testPublic, read(`${name}.manifest.json.sig`), manifest), name).toBe(true);
    }
  });

  it("refuse une signature d'une autre cle, un manifeste modifie et une signature d'un autre manifeste", () => {
    const manifest = readFileSync(join(fixtures, "ok.manifest.json"));
    expect(verifySignature(testPublic, read("other-key.manifest.json.sig"), readFileSync(join(fixtures, "other-key.manifest.json")))).toBe(false);
    expect(verifySignature(testPublic, read("ok.manifest.json.sig"), Buffer.concat([manifest, Buffer.from(" ")]))).toBe(false);
    expect(verifySignature(testPublic, read("beta.manifest.json.sig"), manifest)).toBe(false);
    expect(verifySignature(testPublic, "n'importe quoi", manifest)).toBe(false);
    expect(verifySignature("n'importe quoi", read("ok.manifest.json.sig"), manifest)).toBe(false);
  });

  it("connait l'empreinte de l'executable factice des fixtures", () => {
    const exe = readFileSync(join(fixtures, "artifact.exe"));
    const manifest = JSON.parse(read("ok.manifest.json")) as { platforms: Record<string, { size: number; sha256: string }> };
    expect(manifest.platforms["windows-x86_64"]).toMatchObject({ size: exe.length, sha256: sha256Hex(exe) });
  });
});
