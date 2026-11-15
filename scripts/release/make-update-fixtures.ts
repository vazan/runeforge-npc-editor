/**
 * Fixtures des tests de mise a jour (`crates/updater/tests/fixtures/`) : un executable factice, des manifestes de toutes sortes et leurs
 * signatures, produits avec la **cle de test** (mot de passe `test-only`), qui n'est pas un secret et ne signe jamais une release.
 *
 * Usage : pnpm exec tsx scripts/release/make-update-fixtures.ts [--force]
 * Les cles ne sont creees que si elles manquent. Une signature porte l'heure de sa creation : on ne regenere les fixtures que pour
 * les changer (les tests lisent les fichiers committes). Aucun acces reseau.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactName, buildManifest, generateKeyPair, sha256Hex, signFile, softwareRoot, verifySignature, type ManifestInput } from "./lib";

const directory = join(softwareRoot, "crates", "updater", "tests", "fixtures");
const keys = join(directory, "keys");
const PASSWORD = "test-only";
const PLATFORM = "windows-x86_64";
const LINUX = "linux-x86_64";
const PUBLISHED = "2026-11-15T10:00:00Z";
const force = process.argv.includes("--force");

mkdirSync(keys, { recursive: true });
for (const name of ["test", "other"]) {
  const path = join(keys, `${name}.key`);
  if (force || !existsSync(path)) generateKeyPair(path, PASSWORD);
}
const testKey = { path: join(keys, "test.key"), password: PASSWORD };
const otherKey = { path: join(keys, "other.key"), password: PASSWORD };
const testPublic = readFileSync(join(keys, "test.key.pub"), "utf8");

const exe = Buffer.concat([Buffer.from("MZ"), Buffer.from("RuneForge Studio update test artifact\n".repeat(80))]);
const notExe = Buffer.from("this is not a windows executable\n".repeat(60));
writeFileSync(join(directory, "artifact.exe"), exe);
writeFileSync(join(directory, "not-an-exe.exe"), notExe);
// Linux : un « executable » qui commence par l'en-tete ELF (`\x7fELF`), et un fichier qui n'en est pas un.
const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("RuneForge Studio Linux update test artifact\n".repeat(80))]);
const notElf = Buffer.from("this is not a linux executable\n".repeat(60));
writeFileSync(join(directory, "artifact-linux"), elf);
writeFileSync(join(directory, "not-an-elf"), notElf);

const windows = (version: string, bytes: Buffer = exe, file: string = artifactName(version, PLATFORM)) => ({ platform: PLATFORM, file, size: bytes.length, sha256: sha256Hex(bytes) });
const linux = (version: string, bytes: Buffer = elf, file: string = artifactName(version, LINUX)) => ({ platform: LINUX, file, size: bytes.length, sha256: sha256Hex(bytes) });
const base = (version: string, extra: Partial<ManifestInput> = {}): ManifestInput => ({
  version,
  channel: "stable",
  publishedAt: PUBLISHED,
  notes: `Notes de la ${version}.\nDeuxieme ligne.`,
  artifacts: [windows(version)],
  ...extra,
});

interface Fixture {
  readonly name: string;
  readonly text: string;
  readonly key: { path: string; password: string };
}

const fixtures: Fixture[] = [
  { name: "ok", text: buildManifest(base("0.2.0")), key: testKey },
  { name: "beta", text: buildManifest(base("0.3.0-beta.1", { channel: "beta" })), key: testKey },
  { name: "minimum", text: buildManifest(base("0.4.0", { minimumVersion: "0.3.0" })), key: testKey },
  { name: "linux-only", text: buildManifest(base("0.2.1", { artifacts: [{ ...windows("0.2.1"), platform: "linux-x86_64", file: artifactName("0.2.1", "linux-x86_64") }] })), key: testKey },
  { name: "bad-hash", text: buildManifest(base("0.2.2", { artifacts: [{ ...windows("0.2.2"), sha256: "0".repeat(64) }] })), key: testKey },
  { name: "not-exe", text: buildManifest(base("0.2.3", { artifacts: [windows("0.2.3", notExe)] })), key: testKey },
  { name: "other-version", text: buildManifest(base("0.2.5")), key: testKey },
  { name: "other-key", text: buildManifest(base("0.2.6")), key: otherKey },
  // Windows et Linux dans la meme release : chaque systeme y trouve son fichier.
  { name: "both", text: buildManifest(base("0.5.0", { artifacts: [windows("0.5.0"), linux("0.5.0")] })), key: testKey },
  // Des fichiers dont l'empreinte est exacte et signee, mais qui ne sont pas l'executable du systeme de leur plateforme.
  { name: "linux-not-elf", text: buildManifest(base("0.5.1", { artifacts: [linux("0.5.1", notElf)] })), key: testKey },
  { name: "windows-exe-for-linux", text: buildManifest(base("0.5.2", { artifacts: [linux("0.5.2", exe)] })), key: testKey },
  { name: "elf-for-windows", text: buildManifest(base("0.5.3", { artifacts: [windows("0.5.3", elf)] })), key: testKey },
  // Ce que `buildManifest` refuse de produire : une signature valide ne rend pas acceptable un manifeste que l'application refuse.
  { name: "future-schema", text: buildManifest(base("0.2.7")).replace('"schema": 1', '"schema": 2'), key: testKey },
  { name: "wrong-product", text: buildManifest(base("0.2.8")).replace('"runeforge-studio"', '"another-product"'), key: testKey },
];

for (const fixture of fixtures) {
  const path = join(directory, `${fixture.name}.manifest.json`);
  writeFileSync(path, fixture.text);
  const signature = signFile(path, fixture.key);
  // Chaque signature est controlee par l'implementation independante avant d'etre committee : avec la cle de test pour toutes,
  // sauf `other-key`, qui ne doit PAS se verifier avec elle.
  const valid = verifySignature(testPublic, signature, readFileSync(path));
  if (valid !== (fixture.name !== "other-key")) throw new Error(`signature inattendue pour ${fixture.name} : ${valid}`);
}
console.log(`${fixtures.length} manifestes signes, executable factice de ${exe.length} octets (sha256 ${sha256Hex(exe)}) dans ${directory}`);
