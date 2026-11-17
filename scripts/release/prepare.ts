/**
 * Prepare les fichiers d'une release signee (DEC-046) a partir des executables de production deja construits, un par systeme :
 *
 *   pnpm release:prepare --version 0.2.0 --notes notes.txt [--artifact windows-x86_64=<fichier>] [--artifact linux-x86_64=<fichier>]
 *                        [--channel stable|beta] [--minimum 0.1.0] [--out dossier]
 *
 * Sans `--artifact`, l'executable de la machine courante est pris (`target/release/runeforge-studio.exe` sous Windows,
 * `target/release/runeforge-studio` sous Linux). `--exe <fichier>` est l'ancien nom de `--artifact windows-x86_64=<fichier>`.
 *
 * Une release est UN manifeste signe : tous les systemes qu'elle sert y figurent, donc se preparent ensemble. Le binaire Linux se construit
 * sur une machine Linux (voir `docs/RELEASE.md`) et se donne ici par son chemin, y compris `\\wsl$\...` depuis Windows.
 *
 * La cle privee n'est jamais lue par ce code : `--key` (ou `TAURI_SIGNING_PRIVATE_KEY_PATH`) et le mot de passe
 * (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, jamais en argument) sont confies a `tauri signer sign`. Aucun acces reseau, rien n'est publie.
 *
 * Les controles refusent les erreurs qui rendraient la mise a jour inutilisable ou dangereuse, pour chaque executable :
 *  - c'est un executable de son systeme (en-tete `MZ` pour Windows, `ELF` pour Linux : un fichier de l'autre systeme est refuse) ;
 *  - la version de `tauri.conf.json` est celle de la release (sinon l'application mise a jour se proposerait la meme mise a jour sans fin),
 *    il est plus recent que ce fichier et, pour Windows, il porte cette version (en clair ou dans sa ressource de version) ;
 *  - il embarque la cle publique de production et aucune cle de test (construit sans la fonctionnalite `e2e`, apres la configuration de
 *    la cle) ;
 * et pour le manifeste : la signature se verifie avec cette cle publique, par une implementation independante de celle de l'application.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MANIFEST_ASSET,
  MAX_ARTIFACT_BYTES,
  SIGNATURE_ASSET,
  artifactName,
  buildManifest,
  executableKindFor,
  hasExecutableHeader,
  isPreRelease,
  isVersion,
  sha256Hex,
  signFile,
  softwareRoot,
  verifySignature,
  type Channel,
  type SigningKey,
} from "./lib";

export const WINDOWS_PLATFORM = "windows-x86_64";
export const LINUX_PLATFORM = "linux-x86_64";
/** Ancien nom de `WINDOWS_PLATFORM` (le premier systeme pris en charge). */
export const PLATFORM = WINDOWS_PLATFORM;
const TAURI_CONF = join(softwareRoot, "apps", "desktop", "src-tauri", "tauri.conf.json");
export const PUBLIC_KEY_FILE = join(softwareRoot, "apps", "desktop", "src-tauri", "update-public-key.txt");
export const TEST_PUBLIC_KEY_FILE = join(softwareRoot, "crates", "updater", "tests", "fixtures", "keys", "test.key.pub");
const DEFAULT_OUT_ROOT = join(softwareRoot, "release-out");

/** Un executable de production deja construit, pour une plateforme du manifeste (`windows-x86_64`, `linux-x86_64`). */
export interface ArtifactInput {
  readonly platform: string;
  readonly path: string;
}

export interface PrepareOptions {
  readonly version: string;
  /** Par defaut : `beta` pour une pre-version, `stable` sinon. */
  readonly channel?: Channel;
  /** Notes de version en texte brut. */
  readonly notes: string;
  readonly minimumVersion?: string;
  /** Les executables de production deja construits : un par plateforme, au moins un. */
  readonly artifacts: readonly ArtifactInput[];
  /** Dossier de sortie : il ne doit pas exister, ou etre vide. */
  readonly out: string;
  readonly key: SigningKey;
  /** Cle publique de mise a jour de l'application (contenu de `update-public-key.txt`). */
  readonly publicKey: string;
  /** Cles de test que les executables ne doivent pas embarquer (leur cle privee est dans le depot). */
  readonly forbiddenKeys: readonly string[];
  /** Fichier `tauri.conf.json` dont la version est celle de l'application construite. */
  readonly configPath: string;
  readonly now?: () => Date;
}

export interface PreparedArtifact {
  readonly platform: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PreparedRelease {
  readonly directory: string;
  readonly tag: string;
  readonly channel: Channel;
  /** Indicateur « pre-release » que GitHub doit porter (il doit refleter le canal du manifeste). */
  readonly prerelease: boolean;
  readonly artifacts: readonly PreparedArtifact[];
  /** Les fichiers a publier : chaque executable, le manifeste et sa signature. */
  readonly files: readonly string[];
}

function refuse(reason: string): never {
  throw new Error(reason);
}

function configVersion(configPath: string): string {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : refuse(`${configPath} n'a pas de version`);
}

interface ReadArtifact {
  readonly platform: string;
  readonly name: string;
  readonly bytes: Buffer;
  readonly path: string;
}

/** Le texte de la version, en UTF-8 ou en UTF-16 (ressource de version d'un executable Windows). */
function carriesVersion(bytes: Buffer, version: string): boolean {
  return bytes.includes(Buffer.from(version)) || bytes.includes(Buffer.from(version, "utf16le"));
}

/** Lit un executable et refuse tout ce qui le rendrait inutilisable ou dangereux ; le message dit de quelle plateforme il s'agit. */
function readArtifact(input: ArtifactInput, context: { version: string; publicKey: string; forbiddenKeys: readonly string[]; configPath: string }): ReadArtifact {
  const kind = executableKindFor(input.platform);
  if (kind === undefined || !/^[a-z0-9_]{1,16}-[a-z0-9_]{1,16}$/.test(input.platform)) {
    refuse(`plateforme « ${input.platform} » non prise en charge (Windows et Linux : windows-x86_64, linux-x86_64, linux-aarch64)`);
  }
  const label = `[${input.platform}]`;
  if (!existsSync(input.path)) {
    refuse(`${label} executable introuvable : ${input.path} (construisez-le avec \`pnpm -C apps/desktop tauri build --no-bundle\` sur une machine du systeme voulu)`);
  }
  const bytes = readFileSync(input.path);
  if (!hasExecutableHeader(kind, bytes)) {
    refuse(kind === "pe" ? `${label} le fichier n'est pas un executable Windows (en-tete MZ absent)` : `${label} le fichier n'est pas un executable Linux (en-tete ELF absent)`);
  }
  if (bytes.length > MAX_ARTIFACT_BYTES) refuse(`${label} l'executable depasse la taille maximale acceptee par l'application (256 Mio)`);
  if (statSync(input.path).mtimeMs < statSync(context.configPath).mtimeMs) {
    refuse(`${label} l'executable est plus ancien que tauri.conf.json : reconstruisez-le apres le changement de version`);
  }
  if (!bytes.includes(Buffer.from(context.publicKey))) {
    refuse(`${label} l'executable n'embarque pas la cle publique de mise a jour : reconstruisez-le apres la configuration de la cle`);
  }
  for (const forbidden of context.forbiddenKeys) {
    if (forbidden.trim() !== "" && bytes.includes(Buffer.from(forbidden.trim()))) {
      refuse(`${label} l'executable embarque une cle de test (construction \`e2e\` ?) : reconstruisez-le en production`);
    }
  }
  const marker = "RUNEFORGE_RELEASE_VERSION=";
  const hasMarker = bytes.includes(Buffer.from(marker));
  // Les anciens PE n'ont pas de marqueur, mais leurs ressources contiennent la version.
  const hasVersion = hasMarker
    ? bytes.includes(Buffer.from(`${marker}${context.version}\0`))
    : kind === "pe" && carriesVersion(bytes, context.version);
  if (kind === "elf" && !hasMarker) {
    refuse(`${label} l'executable ne contient pas la version ${context.version} (marqueur absent) : reconstruisez l'executable Linux et l'AppImage avec l'outillage actuel`);
  }
  if (!hasVersion) {
    refuse(`${label} l'executable ne contient pas la version ${context.version} : reconstruisez-le apres le changement de version`);
  }
  return { platform: input.platform, name: artifactName(context.version, input.platform), bytes, path: input.path };
}

/** Les controles et la fabrication des fichiers ; l'erreur dit ce qu'il faut corriger. */
export function prepareRelease(options: PrepareOptions): PreparedRelease {
  const { version } = options;
  if (!isVersion(version)) refuse(`version invalide « ${version} » (attendu : 1.2.3 ou 1.2.3-beta.1, sans « v »)`);
  const channel: Channel = options.channel ?? (isPreRelease(version) ? "beta" : "stable");
  if (channel === "stable" && isPreRelease(version)) refuse("une pre-version ne peut pas etre publiee sur le canal stable");
  if (options.minimumVersion !== undefined && !isVersion(options.minimumVersion)) refuse(`version minimale invalide « ${options.minimumVersion} »`);

  const inConfig = configVersion(options.configPath);
  if (inConfig !== version) {
    refuse(`tauri.conf.json porte la version ${inConfig}, pas ${version} : changez-la, reconstruisez les executables, puis relancez (sinon l'application mise a jour se proposerait la meme mise a jour sans fin)`);
  }

  const publicKey = options.publicKey.trim();
  if (publicKey === "" || publicKey.startsWith("UNCONFIGURED")) refuse("la cle publique de mise a jour n'est pas configuree (update-public-key.txt) : generez la paire de cles avec `pnpm release:keygen`");
  if (options.forbiddenKeys.some((forbidden) => forbidden.trim() === publicKey)) refuse("la cle publique configuree est une cle de test : sa cle privee est dans le depot, ne signez jamais une release avec");

  if (options.artifacts.length === 0) refuse("au moins un executable est necessaire (--artifact <plateforme>=<fichier>)");
  const platforms = new Set<string>();
  for (const { platform } of options.artifacts) {
    if (platforms.has(platform)) refuse(`plateforme en double « ${platform} » : un seul executable par plateforme`);
    platforms.add(platform);
  }
  const artifacts = options.artifacts.map((input) => readArtifact(input, { version, publicKey, forbiddenKeys: options.forbiddenKeys, configPath: options.configPath }));

  if (existsSync(options.out) && readdirSync(options.out).length > 0) refuse(`le dossier de sortie n'est pas vide : ${options.out}`);
  const prepared: PreparedArtifact[] = artifacts.map(({ platform, name, bytes }) => ({ platform, name, size: bytes.length, sha256: sha256Hex(bytes) }));
  const manifest = buildManifest({
    version,
    channel,
    publishedAt: (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    notes: options.notes.replace(/\r\n/g, "\n").trim(),
    ...(options.minimumVersion === undefined ? {} : { minimumVersion: options.minimumVersion }),
    artifacts: prepared.map(({ platform, name, size, sha256 }) => ({ platform, file: name, size, sha256 })),
  });

  mkdirSync(options.out, { recursive: true });
  const manifestPath = join(options.out, MANIFEST_ASSET);
  const signaturePath = `${manifestPath}.sig`;
  try {
    writeFileSync(manifestPath, manifest);
    const signature = signFile(manifestPath, options.key);
    if (!verifySignature(publicKey, signature, readFileSync(manifestPath))) {
      refuse("la signature ne se verifie pas avec la cle publique de l'application : cette cle privee n'est pas celle de update-public-key.txt");
    }
    if (verifySignature(publicKey, signature, Buffer.from(`${manifest} `))) refuse("controle interne : la signature accepte un manifeste modifie");
    for (const artifact of artifacts) copyFileSync(artifact.path, join(options.out, artifact.name));
  } catch (error) {
    // Rien d'a moitie fait ne reste dans le dossier de sortie.
    rmSync(manifestPath, { force: true });
    rmSync(signaturePath, { force: true });
    for (const artifact of artifacts) rmSync(join(options.out, artifact.name), { force: true });
    throw error;
  }
  return {
    directory: options.out,
    tag: `v${version}`,
    channel,
    prerelease: channel === "beta",
    artifacts: prepared,
    files: [...prepared.map((artifact) => artifact.name), MANIFEST_ASSET, SIGNATURE_ASSET],
  };
}

// --- Ligne de commande ------------------------------------------------------------------------------------------------------

function parseArguments(argv: readonly string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined || value.startsWith("--")) refuse(`argument inattendu « ${name} » (voir l'en-tete de scripts/release/prepare.ts)`);
    values.set(name.slice(2), [...(values.get(name.slice(2)) ?? []), value]);
    index += 1;
  }
  return values;
}

function single(args: Map<string, string[]>, name: string): string | undefined {
  const list = args.get(name);
  if ((list?.length ?? 0) > 1) refuse(`--${name} ne se donne qu'une fois`);
  return list?.[0];
}

/** `--artifact windows-x86_64=C:\chemin\fichier.exe` : la plateforme, puis le fichier (qui peut contenir `=`). */
export function parseArtifact(text: string): ArtifactInput {
  const at = text.indexOf("=");
  if (at <= 0 || at === text.length - 1) refuse(`--artifact attend <plateforme>=<fichier> (recu « ${text} »)`);
  return { platform: text.slice(0, at), path: resolve(text.slice(at + 1)) };
}

/** L'executable de la machine courante, construit par `pnpm -C apps/desktop tauri build --no-bundle`. */
function hostArtifact(): ArtifactInput {
  if (process.platform === "win32") return { platform: WINDOWS_PLATFORM, path: join(softwareRoot, "target", "release", "runeforge-studio.exe") };
  if (process.platform === "linux") {
    const architecture = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : refuse(`architecture « ${process.arch} » non prise en charge : donnez --artifact <plateforme>=<fichier>`);
    return { platform: `linux-${architecture}`, path: join(softwareRoot, "target", "release", "runeforge-studio") };
  }
  return refuse("systeme non pris en charge : donnez --artifact <plateforme>=<fichier> (Windows et Linux seulement)");
}

function main(): void {
  const args = parseArguments(process.argv.slice(2).filter((argument) => argument !== "--"));
  const version = single(args, "version") ?? refuse("--version est obligatoire (ex. --version 0.2.0)");
  const notesFile = single(args, "notes") ?? refuse("--notes <fichier> est obligatoire (texte brut)");
  const keyPath = single(args, "key") ?? process.env["TAURI_SIGNING_PRIVATE_KEY_PATH"] ?? refuse("la cle privee est obligatoire : --key <fichier> ou TAURI_SIGNING_PRIVATE_KEY_PATH");
  const password = process.env["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] ?? refuse("le mot de passe de la cle est obligatoire : variable TAURI_SIGNING_PRIVATE_KEY_PASSWORD (jamais en argument)");
  const channel = single(args, "channel");
  if (channel !== undefined && channel !== "stable" && channel !== "beta") refuse("--channel : stable ou beta");
  const minimum = single(args, "minimum");
  const given = [...(args.get("artifact") ?? []), ...(args.get("exe") ?? []).map((path) => `${WINDOWS_PLATFORM}=${path}`)];
  const prepared = prepareRelease({
    version,
    ...(channel === undefined ? {} : { channel }),
    notes: readFileSync(resolve(notesFile), "utf8"),
    ...(minimum === undefined ? {} : { minimumVersion: minimum }),
    artifacts: given.length > 0 ? given.map(parseArtifact) : [hostArtifact()],
    out: resolve(single(args, "out") ?? join(DEFAULT_OUT_ROOT, version)),
    key: { path: resolve(keyPath), password },
    publicKey: readFileSync(PUBLIC_KEY_FILE, "utf8"),
    forbiddenKeys: [readFileSync(TEST_PUBLIC_KEY_FILE, "utf8")],
    configPath: TAURI_CONF,
  });
  console.log(`Release ${prepared.tag} (${prepared.channel}) preparee dans ${prepared.directory}`);
  for (const file of prepared.files) console.log(`  ${file}`);
  for (const artifact of prepared.artifacts) console.log(`  ${artifact.platform} : ${artifact.size} octets, sha256 ${artifact.sha256}`);
  console.log("Prochaine etape : `pnpm release:publish --repo proprietaire/depot --dir <dossier>` (apercu), puis avec --yes pour creer le brouillon.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ERREUR : ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
