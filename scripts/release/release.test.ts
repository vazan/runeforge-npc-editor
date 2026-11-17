import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_ASSET, SIGNATURE_ASSET, sha256Hex, softwareRoot, verifySignature } from "./lib";
import { generateProductionKey, isInside } from "./keygen";
import { planPublish } from "./publish";
import { LINUX_PLATFORM, WINDOWS_PLATFORM, parseArtifact, prepareRelease, type PrepareOptions } from "./prepare";

/**
 * Outillage de release (DEC-046) : preparation, apercu de publication et generation de la cle, pour Windows et Linux. Les signatures sont
 * faites avec la cle de TEST des fixtures (mot de passe `test-only`) par le vrai `tauri signer`, puis verifiees par l'implementation
 * independante ; aucun reseau. Les executables sont factices (un en-tete `MZ` ou `ELF` et du texte), ce qui rend ces tests identiques sous
 * Windows et sous Linux.
 */
const keys = join(softwareRoot, "crates", "updater", "tests", "fixtures", "keys");
const testKey = { path: join(keys, "test.key"), password: "test-only" };
const otherKey = { path: join(keys, "other.key"), password: "test-only" };
const testPublic = readFileSync(join(keys, "test.key.pub"), "utf8");
const otherPublic = readFileSync(join(keys, "other.key.pub"), "utf8");

const WINDOWS_FILE = "runeforge-studio-0.2.0-windows-x86_64.exe";
const LINUX_FILE = "runeforge-studio-0.2.0-linux-x86_64";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "runeforge-release-"));
  temporary.push(directory);
  return directory;
}

const HEADERS = { pe: Buffer.from("MZ"), elf: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) } as const;

/** Ecrit un executable factice (en-tete de son systeme puis `text`) dont la date est `olderBy` secondes avant « un peu avant maintenant ». */
function writeBinary(directory: string, name: string, kind: keyof typeof HEADERS, text: string, olderBy = 0): string {
  const path = join(directory, name);
  writeFileSync(path, Buffer.concat([HEADERS[kind], Buffer.from(text)]));
  const when = Date.now() / 1000 - 50 - olderBy;
  utimesSync(path, when, when);
  return path;
}

const goodText = (publicKey: string, version: string): string => `padding ${publicKey.trim()} padding version=${version} padding`;

interface World {
  readonly dir: string;
  readonly options: PrepareOptions;
  /** Le chemin de l'executable Windows factice. */
  readonly exe: string;
}

/** Un executable Windows factice, sa configuration et les options d'un appel valide : chaque test casse une seule chose. */
function world(change: Partial<Omit<PrepareOptions, "artifacts">> & { exeText?: (publicKey: string) => string; configVersion?: string; exeOlder?: boolean } = {}): World {
  const dir = scratch();
  const version = change.version ?? "0.2.0";
  const configPath = join(dir, "tauri.conf.json");
  writeFileSync(configPath, JSON.stringify({ version: change.configVersion ?? version }));
  const when = Date.now() / 1000 - 100;
  utimesSync(configPath, when, when);
  const publicKey = change.publicKey ?? testPublic;
  const exe = writeBinary(dir, "runeforge-studio.exe", "pe", change.exeText?.(publicKey) ?? goodText(publicKey, version), change.exeOlder === true ? 150 : 0);
  const { exeText: _exeText, configVersion: _configVersion, exeOlder: _exeOlder, ...overrides } = change;
  const options: PrepareOptions = {
    version,
    notes: "Corrections.\r\nNouvel assistant.\r\n",
    artifacts: [{ platform: WINDOWS_PLATFORM, path: exe }],
    out: join(dir, "out"),
    key: testKey,
    publicKey,
    forbiddenKeys: [],
    configPath,
    now: () => new Date("2026-11-15T10:20:30.456Z"),
    ...overrides,
  };
  return { dir, options, exe };
}

/** Ajoute a une preparation valide un executable Linux factice (ELF), construit « sur une autre machine ». */
function withLinux(base: World, change: { text?: (publicKey: string) => string; olderBy?: number } = {}): { options: PrepareOptions; linux: string } {
  const version = base.options.version;
  const linux = writeBinary(base.dir, "runeforge-studio", "elf", change.text?.(base.options.publicKey) ?? goodText(base.options.publicKey, version), change.olderBy ?? 0);
  return { options: { ...base.options, artifacts: [...base.options.artifacts, { platform: LINUX_PLATFORM, path: linux }] }, linux };
}

describe("release:prepare", () => {
  it("fabrique le manifeste, sa signature et l'executable, et la signature se verifie", { timeout: 60_000 }, () => {
    const { options, exe } = world();
    const prepared = prepareRelease(options);
    const exeBytes = readFileSync(exe);

    expect(prepared).toMatchObject({ tag: "v0.2.0", channel: "stable", prerelease: false });
    expect(prepared.files).toEqual([WINDOWS_FILE, MANIFEST_ASSET, SIGNATURE_ASSET]);
    expect(readdirSync(options.out).sort()).toEqual([...prepared.files].sort());
    expect(readFileSync(join(options.out, WINDOWS_FILE))).toEqual(exeBytes);

    const manifestBytes = readFileSync(join(options.out, MANIFEST_ASSET));
    expect(JSON.parse(manifestBytes.toString("utf8"))).toEqual({
      schema: 1,
      product: "runeforge-studio",
      version: "0.2.0",
      channel: "stable",
      publishedAt: "2026-11-15T10:20:30Z",
      notes: "Corrections.\nNouvel assistant.",
      platforms: { [WINDOWS_PLATFORM]: { file: WINDOWS_FILE, size: exeBytes.length, sha256: sha256Hex(exeBytes) } },
    });
    expect(prepared.artifacts).toEqual([{ platform: WINDOWS_PLATFORM, name: WINDOWS_FILE, size: exeBytes.length, sha256: sha256Hex(exeBytes) }]);
    expect(verifySignature(testPublic, readFileSync(join(options.out, SIGNATURE_ASSET), "utf8"), manifestBytes)).toBe(true);
  });

  it("prepare Windows et Linux dans UN manifeste signe, chaque systeme avec son fichier", { timeout: 60_000 }, () => {
    const { options, linux } = withLinux(world());
    const prepared = prepareRelease(options);
    const [windowsBytes, linuxBytes] = [readFileSync(options.artifacts[0]?.path ?? ""), readFileSync(linux)];

    expect(prepared.files).toEqual([WINDOWS_FILE, LINUX_FILE, MANIFEST_ASSET, SIGNATURE_ASSET]);
    expect(readdirSync(options.out).sort()).toEqual([...prepared.files].sort());
    expect(readFileSync(join(options.out, LINUX_FILE))).toEqual(linuxBytes);
    expect(linuxBytes.subarray(0, 4)).toEqual(HEADERS.elf);

    const manifestBytes = readFileSync(join(options.out, MANIFEST_ASSET));
    expect(JSON.parse(manifestBytes.toString("utf8")).platforms).toEqual({
      [WINDOWS_PLATFORM]: { file: WINDOWS_FILE, size: windowsBytes.length, sha256: sha256Hex(windowsBytes) },
      [LINUX_PLATFORM]: { file: LINUX_FILE, size: linuxBytes.length, sha256: sha256Hex(linuxBytes) },
    });
    // Une seule signature couvre les deux : celle du manifeste.
    expect(verifySignature(testPublic, readFileSync(join(options.out, SIGNATURE_ASSET), "utf8"), manifestBytes)).toBe(true);
    expect(prepared.artifacts.map((artifact) => artifact.platform)).toEqual([WINDOWS_PLATFORM, LINUX_PLATFORM]);
  });

  it("peut ne preparer que Linux (le binaire d'une machine Linux)", { timeout: 60_000 }, () => {
    const { options, linux } = withLinux(world());
    const alone = { ...options, artifacts: [{ platform: LINUX_PLATFORM, path: linux }] };
    expect(prepareRelease(alone).files).toEqual([LINUX_FILE, MANIFEST_ASSET, SIGNATURE_ASSET]);
  });

  it("choisit le canal bêta pour une pre-version et refuse une pre-version sur le canal stable", { timeout: 60_000 }, () => {
    const beta = world({ version: "0.3.0-beta.1" });
    expect(prepareRelease(beta.options)).toMatchObject({ tag: "v0.3.0-beta.1", channel: "beta", prerelease: true });
    expect(() => prepareRelease(world({ version: "0.3.0-beta.1", channel: "stable" }).options)).toThrow(/pre-version/);
  });

  it("ecrit la version minimale demandee", { timeout: 60_000 }, () => {
    const { options } = world({ minimumVersion: "0.1.0" });
    prepareRelease(options);
    expect(JSON.parse(readFileSync(join(options.out, MANIFEST_ASSET), "utf8"))).toMatchObject({ minimumVersion: "0.1.0" });
    expect(() => prepareRelease(world({ minimumVersion: "1" }).options)).toThrow(/minimale invalide/);
  });

  it("refuse une version mal ecrite ou differente de celle de tauri.conf.json (boucle de mise a jour sans fin)", () => {
    expect(() => prepareRelease(world({ version: "v0.2.0", configVersion: "0.2.0" }).options)).toThrow(/version invalide/);
    expect(() => prepareRelease(world({ version: "0.2.0", configVersion: "0.1.0" }).options)).toThrow(/tauri\.conf\.json porte la version 0\.1\.0, pas 0\.2\.0/);
  });

  it("refuse une cle publique absente, en attente ou de test, avant de lire un executable", () => {
    expect(() => prepareRelease(world({ publicKey: "UNCONFIGURED - a remplacer" }).options)).toThrow(/pas configuree/);
    expect(() => prepareRelease(world({ publicKey: "  " }).options)).toThrow(/pas configuree/);
    expect(() => prepareRelease(world({ forbiddenKeys: [testPublic] }).options)).toThrow(/cle de test/);
  });

  it("refuse un executable absent, qui n'en est pas un, trop ancien, ou sans la bonne cle ni la bonne version", () => {
    const missing = world();
    expect(() => prepareRelease({ ...missing.options, artifacts: [{ platform: WINDOWS_PLATFORM, path: join(missing.dir, "absent.exe") }] })).toThrow(/\[windows-x86_64\] executable introuvable/);
    const notExe = world();
    writeFileSync(notExe.exe, "texte");
    expect(() => prepareRelease(notExe.options)).toThrow(/pas un executable Windows \(en-tete MZ absent\)/);
    expect(() => prepareRelease(world({ exeOlder: true }).options)).toThrow(/plus ancien que tauri\.conf\.json/);
    expect(() => prepareRelease(world({ exeText: () => "padding sans cle version=0.2.0" }).options)).toThrow(/n'embarque pas la cle publique/);
    expect(() => prepareRelease(world({ exeText: (key) => `${key} sans la version` }).options)).toThrow(/ne contient pas la version 0\.2\.0/);
  });

  it("refuse un executable qui embarque une cle de test (construction `e2e`)", () => {
    const built = world({ publicKey: otherPublic, exeText: (key) => `${key} ${testPublic.trim()} version=0.2.0` });
    expect(() => prepareRelease({ ...built.options, forbiddenKeys: [testPublic] })).toThrow(/embarque une cle de test/);
  });

  it("accepte la version UTF-16LE des ressources Windows sans exiger une copie UTF-8", { timeout: 60_000 }, () => {
    const built = world({ version: "0.1.0-beta.2", exeText: (key) => `${key} sans version UTF-8` });
    writeFileSync(built.exe, Buffer.concat([readFileSync(built.exe), Buffer.from("0.1.0-beta.2", "utf16le")]));
    expect(prepareRelease(built.options)).toMatchObject({ tag: "v0.1.0-beta.2" });
  });

  it("refuse une ancienne version UTF-16LE sous Windows et conserve le controle UTF-8 sous Linux", () => {
    const built = world({ version: "0.1.0-beta.2", exeText: (key) => `${key} sans version UTF-8` });
    writeFileSync(built.exe, Buffer.concat([readFileSync(built.exe), Buffer.from("0.1.0-beta.1", "utf16le")]));
    expect(() => prepareRelease(built.options)).toThrow(/\[windows-x86_64\].*ne contient pas la version/);
    const linux = withLinux(world(), { text: (key) => `${key} sans version UTF-8` });
    writeFileSync(linux.linux, Buffer.concat([readFileSync(linux.linux), Buffer.from("0.2.0", "utf16le")]));
    expect(() => prepareRelease(linux.options)).toThrow(/\[linux-x86_64\].*ne contient pas la version/);
  });

  it("refuse l'executable d'un systeme donne pour l'autre, quelle que soit sa signature", () => {
    const base = world();
    // Un executable Windows (MZ) donne comme Linux, et un ELF donne comme Windows.
    expect(() => prepareRelease({ ...base.options, artifacts: [{ platform: LINUX_PLATFORM, path: base.exe }] })).toThrow(/\[linux-x86_64\] le fichier n'est pas un executable Linux \(en-tete ELF absent\)/);
    const { linux } = withLinux(base);
    expect(() => prepareRelease({ ...base.options, artifacts: [{ platform: WINDOWS_PLATFORM, path: linux }] })).toThrow(/\[windows-x86_64\] le fichier n'est pas un executable Windows/);
  });

  it("applique chaque controle a l'executable Linux aussi, et le dit par sa plateforme, sans creer le dossier de sortie", () => {
    const withoutKey = withLinux(world(), { text: () => "padding sans cle version=0.2.0" });
    expect(() => prepareRelease(withoutKey.options)).toThrow(/\[linux-x86_64\] l'executable n'embarque pas la cle publique/);
    expect(existsSync(withoutKey.options.out)).toBe(false);
    const withoutVersion = withLinux(world(), { text: (key) => `${key} sans la version` });
    expect(() => prepareRelease(withoutVersion.options)).toThrow(/\[linux-x86_64\] l'executable ne contient pas la version/);
    const stale = withLinux(world(), { olderBy: 150 });
    expect(() => prepareRelease(stale.options)).toThrow(/\[linux-x86_64\] l'executable est plus ancien/);
    const built = world({ publicKey: otherPublic });
    const testKeyed = withLinux(built, { text: (key) => `${key} ${testPublic.trim()} version=0.2.0` });
    expect(() => prepareRelease({ ...testKeyed.options, forbiddenKeys: [testPublic] })).toThrow(/\[linux-x86_64\] l'executable embarque une cle de test/);
  });

  it("refuse une plateforme inconnue, en double, ou l'absence de tout executable", () => {
    const base = world();
    expect(() => prepareRelease({ ...base.options, artifacts: [{ platform: "macos-aarch64", path: base.exe }] })).toThrow(/plateforme « macos-aarch64 » non prise en charge/);
    expect(() => prepareRelease({ ...base.options, artifacts: [{ platform: "Windows", path: base.exe }] })).toThrow(/non prise en charge/);
    expect(() => prepareRelease({ ...base.options, artifacts: [...base.options.artifacts, ...base.options.artifacts] })).toThrow(/plateforme en double « windows-x86_64 »/);
    expect(() => prepareRelease({ ...base.options, artifacts: [] })).toThrow(/au moins un executable/);
  });

  it("refuse un dossier de sortie deja rempli, sans y toucher", () => {
    const { options } = world();
    mkdirSync(options.out);
    writeFileSync(join(options.out, "ancien.txt"), "x");
    expect(() => prepareRelease(options)).toThrow(/pas vide/);
    expect(readdirSync(options.out)).toEqual(["ancien.txt"]);
  });

  it("refuse une cle privee qui n'est pas celle de la cle publique de l'application et ne laisse rien dans la sortie", { timeout: 60_000 }, () => {
    const { options } = withLinux(world());
    expect(() => prepareRelease({ ...options, key: otherKey })).toThrow(/cle privee n'est pas celle/);
    expect(readdirSync(options.out)).toEqual([]);
  });

  it("refuse de signer avec un mot de passe faux et ne laisse rien", { timeout: 60_000 }, () => {
    const { options } = world();
    expect(() => prepareRelease({ ...options, key: { ...testKey, password: "faux" } })).toThrow(/tauri signer sign a echoue/);
    expect(readdirSync(options.out)).toEqual([]);
  });

  it("refuse des notes avec des caracteres de controle", () => {
    expect(() => prepareRelease(world({ notes: "x\u0007" }).options)).toThrow(/notes/);
  });
});

describe("release:prepare (ligne de commande)", () => {
  it("lit `--artifact <plateforme>=<fichier>` : le fichier peut contenir `=` et la plateforme est celle d'avant le premier `=`", () => {
    const parsed = parseArtifact(`linux-x86_64=${join(tmpdir(), "a=b", "runeforge-studio")}`);
    expect(parsed.platform).toBe("linux-x86_64");
    expect(parsed.path.endsWith(`${sep}a=b${sep}runeforge-studio`)).toBe(true);
    expect(parseArtifact(`windows-x86_64=${join(tmpdir(), "runeforge-studio.exe")}`).platform).toBe("windows-x86_64");
  });

  it("refuse un argument mal forme", () => {
    for (const bad of ["linux-x86_64", "=fichier", "linux-x86_64=", ""]) expect(() => parseArtifact(bad), JSON.stringify(bad)).toThrow(/attend <plateforme>=<fichier>/);
  });
});

describe("release:publish (apercu)", () => {
  function prepared(version = "0.2.0", both = false): { directory: string } {
    const base = world({ version });
    const options = both ? withLinux(base).options : base.options;
    prepareRelease(options);
    return { directory: options.out };
  }

  it("compose un brouillon avec les trois fichiers, apres avoir verifie l'empreinte et la signature", { timeout: 60_000 }, () => {
    const { directory } = prepared();
    const plan = planPublish({ directory, repository: "acme/studio-releases", publicKey: testPublic, target: "main" });
    expect(plan).toMatchObject({ tag: "v0.2.0", title: "RuneForge Studio 0.2.0", prerelease: false });
    expect(plan.files.map((file) => file.slice(directory.length + 1))).toEqual([WINDOWS_FILE, MANIFEST_ASSET, SIGNATURE_ASSET]);
    expect(plan.args.slice(0, 3)).toEqual(["release", "create", "v0.2.0"]);
    expect(plan.args).toContain("--draft");
    expect(plan.args).not.toContain("--prerelease");
    expect(plan.args.slice(plan.args.indexOf("--repo"), plan.args.indexOf("--repo") + 2)).toEqual(["--repo", "acme/studio-releases"]);
    expect(plan.args.slice(plan.args.indexOf("--target"), plan.args.indexOf("--target") + 2)).toEqual(["--target", "main"]);
    expect(plan.args[plan.args.indexOf("--notes") + 1]).toBe("Corrections.\nNouvel assistant.");
  });

  it("envoie les executables des deux systemes, chacun verifie, avec le manifeste et sa signature", { timeout: 60_000 }, () => {
    const { directory } = prepared("0.2.0", true);
    const plan = planPublish({ directory, repository: "acme/studio-releases", publicKey: testPublic });
    expect(plan.files.map((file) => file.slice(directory.length + 1)).sort()).toEqual([LINUX_FILE, MANIFEST_ASSET, SIGNATURE_ASSET, WINDOWS_FILE].sort());
    expect(plan.args.slice(0, 3)).toEqual(["release", "create", "v0.2.0"]);
    // Un fichier Linux altere apres la signature bloque l'envoi de toute la release.
    const linuxPath = join(directory, LINUX_FILE);
    writeFileSync(linuxPath, Buffer.concat([readFileSync(linuxPath), Buffer.from("!")]));
    expect(() => planPublish({ directory, repository: "acme/r", publicKey: testPublic })).toThrow(new RegExp(`${LINUX_FILE} ne correspond pas au manifeste signe`));
    rmSync(linuxPath);
    expect(() => planPublish({ directory, repository: "acme/r", publicKey: testPublic })).toThrow(new RegExp(`fichier manquant : ${LINUX_FILE}`));
  });

  it("marque une release du canal bêta comme pre-release", { timeout: 60_000 }, () => {
    const { directory } = prepared("0.3.0-beta.1");
    const plan = planPublish({ directory, repository: "acme/studio-releases", publicKey: testPublic });
    expect(plan.prerelease).toBe(true);
    expect(plan.args).toContain("--prerelease");
  });

  it("n'envoie rien si un fichier a change apres la signature", { timeout: 60_000 }, () => {
    const { directory } = prepared();
    const exe = join(directory, WINDOWS_FILE);
    writeFileSync(exe, Buffer.concat([readFileSync(exe), Buffer.from("!")]));
    expect(() => planPublish({ directory, repository: "acme/r", publicKey: testPublic })).toThrow(/ne correspond pas au manifeste signe/);
  });

  it("n'envoie rien si le manifeste a change, si la signature manque ou si la cle n'est pas la bonne", { timeout: 60_000 }, () => {
    const { directory } = prepared();
    expect(() => planPublish({ directory, repository: "acme/r", publicKey: otherPublic })).toThrow(/signature ne se verifie pas/);
    const manifest = join(directory, MANIFEST_ASSET);
    writeFileSync(manifest, `${readFileSync(manifest, "utf8")} `);
    expect(() => planPublish({ directory, repository: "acme/r", publicKey: testPublic })).toThrow(/signature ne se verifie pas/);
    rmSync(join(directory, SIGNATURE_ASSET));
    expect(() => planPublish({ directory, repository: "acme/r", publicKey: testPublic })).toThrow(/doivent etre dans/);
  });

  it("refuse un nom de depot mal forme", { timeout: 60_000 }, () => {
    const { directory } = prepared();
    for (const repository of ["", "acme", "a/b/c", "../x", "a b/c", "https://github.com/a/b"]) {
      expect(() => planPublish({ directory, repository, publicKey: testPublic }), repository).toThrow(/--repo/);
    }
  });
});

describe("release:keygen", () => {
  function keygenWorld(publicKeyText = "UNCONFIGURED - a remplacer"): { root: string; outside: string; publicKeyFile: string } {
    const root = scratch();
    const outside = scratch();
    const publicKeyFile = join(root, "update-public-key.txt");
    writeFileSync(publicKeyFile, publicKeyText);
    return { root, outside, publicKeyFile };
  }
  const fakeGenerate = (out: string): void => {
    writeFileSync(out, "cle privee");
    writeFileSync(`${out}.pub`, "CLE-PUBLIQUE-BASE64\n");
  };

  it("ecrit la paire hors du depot et copie la cle publique dans le fichier embarque", () => {
    const { root, outside, publicKeyFile } = keygenWorld();
    const out = join(outside, "update.key");
    expect(generateProductionKey({ out, publicKeyFile, repositoryRoot: root, generate: fakeGenerate })).toBe("CLE-PUBLIQUE-BASE64");
    expect(readFileSync(publicKeyFile, "utf8")).toBe("CLE-PUBLIQUE-BASE64\n");
    expect(readFileSync(out, "utf8")).toBe("cle privee");
  });

  it("refuse d'ecrire la cle privee dans le depot, d'ecraser une cle ou de remplacer une cle publique deja configuree", () => {
    const { root, outside, publicKeyFile } = keygenWorld();
    expect(() => generateProductionKey({ out: join(root, "sous", "update.key"), publicKeyFile, repositoryRoot: root, generate: fakeGenerate })).toThrow(/hors du depot/);
    const existing = join(outside, "existe.key");
    writeFileSync(existing, "x");
    expect(() => generateProductionKey({ out: existing, publicKeyFile, repositoryRoot: root, generate: fakeGenerate })).toThrow(/existe deja/);
    const configured = keygenWorld("DEJA-UNE-CLE");
    expect(() => generateProductionKey({ out: join(configured.outside, "autre.key"), publicKeyFile: configured.publicKeyFile, repositoryRoot: configured.root, generate: fakeGenerate })).toThrow(/deja configuree/);
    expect(readFileSync(configured.publicKeyFile, "utf8")).toBe("DEJA-UNE-CLE");
    expect(existsSync(join(configured.outside, "autre.key"))).toBe(false);
  });

  it("n'ecrit rien si la generation n'a pas produit la paire", () => {
    const { root, outside, publicKeyFile } = keygenWorld();
    expect(() => generateProductionKey({ out: join(outside, "k.key"), publicKeyFile, repositoryRoot: root, generate: () => undefined })).toThrow(/n'a pas produit/);
    expect(readFileSync(publicKeyFile, "utf8")).toBe("UNCONFIGURED - a remplacer");
  });

  it("sait si un chemin est dans le depot (chemins du systeme courant, Windows comme Linux)", () => {
    const root = join(tmpdir(), "depot");
    expect(isInside(root, join(root, "a", "b.key"))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(tmpdir(), "depot-voisin", "b.key"))).toBe(false);
    expect(isInside(root, join(tmpdir(), "ailleurs", "b.key"))).toBe(false);
    // Un chemin non normalise qui remonte hors du depot (`depot/../ailleurs`), ecrit sans le normaliser.
    expect(isInside(root, `${root}${sep}..${sep}ailleurs${sep}b.key`)).toBe(false);
    expect(isInside(root, `${root}${sep}a${sep}..${sep}b.key`)).toBe(true);
  });
});
