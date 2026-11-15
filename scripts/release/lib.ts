/**
 * Mises a jour signees : fabrication du manifeste de release et signature (DEC-046). Miroir de `crates/updater/src/manifest.rs`
 * (le format et ses limites) et de `verify.rs` (la signature minisign, la meme que `tauri signer`).
 *
 * Aucun acces reseau. La cle privee n'est jamais lue par ce code : elle est confiee a `tauri signer sign` (chemin et mot de passe en
 * variables d'environnement du processus fils), puis la signature est **re-verifiee ici** avec la cle publique, par une
 * implementation independante de celle de l'application (Node : Ed25519 et BLAKE2b-512).
 */
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const softwareRoot = resolve(here, "..", "..");
const tauriCli = join(softwareRoot, "apps", "desktop", "node_modules", "@tauri-apps", "cli", "tauri.js");

export const PRODUCT = "runeforge-studio";
export const SCHEMA = 1;
export const MANIFEST_ASSET = "update-manifest.json";
export const SIGNATURE_ASSET = "update-manifest.json.sig";
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_NOTES_BYTES = 8 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

export type Channel = "stable" | "beta";

export interface PlatformArtifact {
  /** Cle de plateforme du manifeste : `windows-x86_64`. */
  readonly platform: string;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ManifestInput {
  readonly version: string;
  readonly channel: Channel;
  /** Date de publication (RFC 3339), informative. */
  readonly publishedAt: string;
  /** Notes de version en texte brut (jamais interpretees comme du HTML ou du Markdown). */
  readonly notes: string;
  /** La plus ancienne version qui peut installer celle-ci directement ; une plus ancienne doit d'abord passer par une autre. */
  readonly minimumVersion?: string;
  readonly artifacts: readonly PlatformArtifact[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** Version semver stricte, sans prefixe `v` ni metadonnees de construction. Le suffixe eventuel est une pre-version. */
export function isVersion(text: string): boolean {
  return SEMVER.test(text);
}

export function isPreRelease(version: string): boolean {
  return SEMVER.exec(version)?.[4] !== undefined;
}

/** Nom du fichier d'une release pour une plateforme : `runeforge-studio-0.2.0-windows-x86_64.exe`, `runeforge-studio-0.2.0-linux-x86_64`. */
export function artifactName(version: string, platform: string): string {
  return `${PRODUCT}-${version}-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
}

/**
 * Le format d'executable d'un systeme (miroir de `crates/updater/src/platform.rs`) : `pe` pour Windows (`MZ`), `elf` pour Linux
 * (`\x7fELF`). Un systeme que les mises a jour ne savent pas installer n'a pas de format : on n'en publie pas.
 */
export type ExecutableKind = "pe" | "elf";

export function executableKindFor(platform: string): ExecutableKind | undefined {
  const system = platform.split("-")[0];
  return system === "windows" ? "pe" : system === "linux" ? "elf" : undefined;
}

/** Vrai si le debut de `bytes` est l'en-tete du format. */
export function hasExecutableHeader(kind: ExecutableKind, bytes: Uint8Array): boolean {
  if (kind === "pe") return bytes[0] === 0x4d && bytes[1] === 0x5a;
  return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSafeFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..");
}

function fail(reason: string): never {
  throw new Error(`manifeste invalide : ${reason}`);
}

/** Caracteres de controle (C0, DEL et C1) autres que la tabulation et les sauts de ligne : l'application les refuse dans les notes. */
function hasControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (control && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/** Texte du manifeste, ou une erreur explicite : meme controles que l'application, pour ne jamais publier ce qu'elle refuserait. */
export function buildManifest(input: ManifestInput): string {
  if (!isVersion(input.version)) fail(`version « ${input.version} »`);
  if (input.channel !== "stable" && input.channel !== "beta") fail("canal");
  if (input.channel === "stable" && isPreRelease(input.version)) fail("un canal stable ne peut pas porter une pre-version");
  if (!/^[0-9TZ:+.-]{1,40}$/.test(input.publishedAt)) fail("publishedAt");
  if (Buffer.byteLength(input.notes) > MAX_NOTES_BYTES || hasControlCharacters(input.notes)) fail("notes");
  if (input.minimumVersion !== undefined && !isVersion(input.minimumVersion)) fail("minimumVersion");
  if (input.artifacts.length === 0 || input.artifacts.length > 16) fail("plateformes");
  const platforms: Record<string, { file: string; size: number; sha256: string }> = {};
  for (const artifact of input.artifacts) {
    if (!/^[a-z0-9_]{1,16}-[a-z0-9_]{1,16}$/.test(artifact.platform)) fail(`plateforme « ${artifact.platform} »`);
    if (executableKindFor(artifact.platform) === undefined) fail(`plateforme « ${artifact.platform} » non prise en charge (Windows et Linux seulement)`);
    if (!isSafeFileName(artifact.file)) fail(`fichier « ${artifact.file} »`);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) fail("sha256");
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_ARTIFACT_BYTES) fail("taille");
    if (platforms[artifact.platform] !== undefined) fail(`plateforme en double « ${artifact.platform} »`);
    platforms[artifact.platform] = { file: artifact.file, size: artifact.size, sha256: artifact.sha256 };
  }
  const text = `${JSON.stringify(
    {
      schema: SCHEMA,
      product: PRODUCT,
      version: input.version,
      channel: input.channel,
      publishedAt: input.publishedAt,
      notes: input.notes,
      ...(input.minimumVersion === undefined ? {} : { minimumVersion: input.minimumVersion }),
      platforms,
    },
    null,
    2,
  )}\n`;
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) fail("taille du manifeste");
  return text;
}

// --- Signature (minisign, via `tauri signer`) ------------------------------------------------------------------------------

function runTauri(args: readonly string[], env: Record<string, string>): string {
  if (!existsSync(tauriCli)) throw new Error("l'outil `tauri` est introuvable : lancez `pnpm install` dans Software/");
  const result = spawnSync(process.execPath, [tauriCli, ...args], { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  if (result.status !== 0) {
    // Le message de l'outil ne contient ni la cle ni le mot de passe ; on ne l'enrichit pas.
    throw new Error(`tauri ${args.slice(0, 2).join(" ")} a echoue : ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  }
  return result.stdout;
}

export interface SigningKey {
  /** Chemin du fichier de cle privee. */
  readonly path: string;
  readonly password: string;
}

/** Cree une paire de cles (privee dans `path`, publique dans `path.pub`). */
export function generateKeyPair(path: string, password: string): void {
  runTauri(["signer", "generate", "--ci", "-p", password, "-w", path, "-f"], {});
}

/** Signe `file` ; renvoie le texte de la signature (le fichier `<file>.sig` est aussi ecrit par l'outil). */
export function signFile(file: string, key: SigningKey): string {
  runTauri(["signer", "sign", file], { TAURI_SIGNING_PRIVATE_KEY_PATH: key.path, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: key.password });
  return readFileSync(`${file}.sig`, "utf8");
}

// --- Verification independante (Ed25519 + BLAKE2b-512 de Node) ----------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Texte minisign d'un fichier `.pub` ou `.sig` : tel quel, ou en base64 comme `tauri signer` l'ecrit. */
function minisignText(input: string): string {
  const text = input.trim();
  return text.startsWith("untrusted comment:") ? text : Buffer.from(text, "base64").toString("utf8");
}

/** Vrai si `signature` (fichier `.sig`) est une signature valide de `data` par la cle `publicKey` (fichier `.pub`). */
export function verifySignature(publicKey: string, signature: string, data: Uint8Array): boolean {
  try {
    const keyLines = minisignText(publicKey).split(/\r?\n/);
    const key = Buffer.from(keyLines[1] ?? "", "base64");
    const signatureLines = minisignText(signature).split(/\r?\n/);
    const body = Buffer.from(signatureLines[1] ?? "", "base64");
    const trusted = (signatureLines[2] ?? "").replace(/^trusted comment: ?/, "");
    const global = Buffer.from(signatureLines[3] ?? "", "base64");
    // Cle : 'Ed' + identifiant (8) + cle (32). Signature : 'ED' (pre-hachee) + identifiant (8) + signature (64).
    if (key.length !== 42 || body.length !== 74 || global.length !== 64 || key.subarray(0, 2).toString() !== "Ed" || body.subarray(0, 2).toString() !== "ED") return false;
    if (!key.subarray(2, 10).equals(body.subarray(2, 10))) return false;
    const publicObject = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key.subarray(10)]), format: "der", type: "spki" });
    const digest = createHash("blake2b512").update(data).digest();
    if (!verify(null, digest, publicObject, body.subarray(10))) return false;
    return verify(null, Buffer.concat([body.subarray(10), Buffer.from(trusted)]), publicObject, global);
  } catch {
    return false;
  }
}
