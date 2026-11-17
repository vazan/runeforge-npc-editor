import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isUpdateRepository } from "@runeforge/project-core";
import { isVersion, softwareRoot } from "./lib";

type Step = "checks" | "e2e" | "windows" | "linux" | "prepare" | "draft" | "upload";

export interface ReleaseOptions {
  readonly root: string;
  readonly version: string;
  readonly notes: string;
  readonly repository: string;
  readonly allowDownload: boolean;
}

interface Command {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell?: boolean;
  readonly signing?: boolean;
}

export function stepCommand(step: Step, options: ReleaseOptions, head: string): Command {
  const { root, version, notes, repository, allowDownload } = options;
  const desktop = join(root, "apps", "desktop");
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const release = join(root, "scripts", "release");
  const out = join(root, "release-out", version);
  const linux = join(root, "target", "release", "runeforge-studio-linux-x86_64");
  switch (step) {
    case "checks": return { executable: "pnpm", args: ["check:all"], cwd: root, shell: true };
    case "e2e": return { executable: "pnpm", args: ["e2e"], cwd: root, shell: true };
    case "windows": return { executable: process.execPath, args: [join(desktop, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build", "--no-bundle"], cwd: desktop };
    case "linux": return { executable: process.execPath, args: [join(root, "scripts", "build-linux.mjs"), ...(allowDownload ? ["--allow-download"] : [])], cwd: root };
    case "prepare": return {
      executable: process.execPath,
      args: [tsx, join(release, "prepare.ts"), "--version", version, "--notes", notes,
        "--artifact", `windows-x86_64=${join(root, "target", "release", "runeforge-studio.exe")}`,
        "--artifact", `linux-x86_64=${linux}`],
      cwd: root,
      signing: true,
    };
    case "draft": return {
      executable: process.execPath,
      args: [tsx, join(release, "publish.ts"), "--repo", repository, "--dir", out, "--target", head, "--yes"],
      cwd: root,
    };
    case "upload": return {
      executable: "gh",
      args: ["release", "upload", `v${version}`, `${linux}.AppImage`, "--repo", repository],
      cwd: root,
    };
  }
}

export interface ReleaseOperations {
  readonly checkGit: () => string;
  readonly run: (step: Step, head: string) => void;
  readonly checkAppImage: () => void;
}

export function buildRelease(operations: ReleaseOperations): void {
  const head = operations.checkGit();
  for (const step of ["checks", "e2e", "windows", "linux"] as const) operations.run(step, head);
  operations.checkAppImage();
  operations.run("prepare", head);
  if (operations.checkGit() !== head) throw new Error("HEAD a change pendant la construction : aucun brouillon n'a ete cree");
  operations.run("draft", head);
  try {
    operations.run("upload", head);
  } catch (error) {
    throw new Error("Le brouillon existe, mais l'AppImage n'a pas ete ajoute. Corrigez l'erreur puis ajoutez-le au brouillon manuellement.", { cause: error });
  }
}

export function checkAppImage(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(11);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length ||
        !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        !header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))) {
      throw new Error(`${path} n'est pas un AppImage de type 2`);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function argumentsForRelease(argv: readonly string[]): { notes: string; repository: string; allowDownload: boolean } {
  let notes: string | undefined;
  let repository: string | undefined;
  let confirmSync = false;
  let confirmLicenses = false;
  let allowDownload = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-wsl-sync") confirmSync = true;
    else if (arg === "--confirm-appimage-licenses") confirmLicenses = true;
    else if (arg === "--allow-download") allowDownload = true;
    else if (arg === "--notes" || arg === "--repo") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} exige une valeur`);
      if (arg === "--notes" && notes === undefined) notes = value;
      else if (arg === "--repo" && repository === undefined) repository = value;
      else throw new Error(`${arg} ne se donne qu'une fois`);
    } else throw new Error(`argument inconnu : ${arg}`);
  }
  if (!notes || !repository || !isUpdateRepository(repository)) throw new Error("--notes <fichier> et --repo <proprietaire/depot> sont obligatoires");
  if (!confirmSync) throw new Error("--confirm-wsl-sync est requis : la copie WSL et les artefacts Linux seront modifies");
  if (!confirmLicenses) throw new Error("--confirm-appimage-licenses est requis apres la revue des licences et notices AppImage");
  return { notes, repository, allowDownload };
}

export function withoutSigningSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const name of Object.keys(safe)) {
    if (name.toUpperCase() === "TAURI_SIGNING_PRIVATE_KEY_PATH" || name.toUpperCase() === "TAURI_SIGNING_PRIVATE_KEY_PASSWORD") delete safe[name];
  }
  return safe;
}

function main(): void {
  if (process.platform !== "win32") throw new Error("Ce lanceur exige Windows avec WSL.");
  const args = argumentsForRelease(process.argv.slice(2));
  if (!process.env["TAURI_SIGNING_PRIVATE_KEY_PATH"] || !process.env["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) {
    throw new Error("Configurez TAURI_SIGNING_PRIVATE_KEY_PATH et TAURI_SIGNING_PRIVATE_KEY_PASSWORD avant de lancer la release.");
  }
  const root = softwareRoot;
  const config = JSON.parse(readFileSync(join(root, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8")) as { version?: unknown };
  if (typeof config.version !== "string" || !isVersion(config.version)) throw new Error("La version de tauri.conf.json est invalide.");
  const notes = resolve(args.notes);
  const notesRelative = relative(root, notes);
  if (!notesRelative || notesRelative.startsWith("..") || isAbsolute(notesRelative) || !existsSync(notes)) {
    throw new Error("Les notes doivent etre un fichier suivi dans le depot.");
  }
  const out = join(root, "release-out", config.version);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`Le dossier de sortie n'est pas vide : ${out}`);

  const safeEnv = withoutSigningSecrets(process.env);
  const git = (gitArgs: readonly string[]): string => {
    const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", env: safeEnv, windowsHide: true });
    if (result.error) throw new Error(`git n'a pas pu demarrer : ${result.error.message}`);
    if (result.status !== 0) throw new Error(`git ${gitArgs[0]} a echoue : ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  git(["ls-files", "--error-unmatch", "--", notesRelative]);
  const checkGit = (): string => {
    if (git(["status", "--porcelain", "--untracked-files=normal"]) !== "") throw new Error("Le depot doit etre propre : commitez d'abord les changements.");
    const head = git(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("Le commit HEAD est invalide.");
    return head;
  };
  const options: ReleaseOptions = { root, version: config.version, notes, repository: args.repository, allowDownload: args.allowDownload };
  const run = (step: Step, head: string): void => {
    const command = stepCommand(step, options, head);
    console.log(`\nrelease: ${step}`);
    const result = spawnSync(command.executable, command.args, {
      cwd: command.cwd,
      stdio: "inherit",
      shell: command.shell ?? false,
      env: command.signing ? process.env : safeEnv,
      windowsHide: true,
    });
    if (result.error) throw new Error(`${step} n'a pas pu demarrer : ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${step} a echoue (code ${result.status ?? "inconnu"})`);
  };
  buildRelease({
    checkGit,
    run,
    checkAppImage: () => checkAppImage(join(root, "target", "release", "runeforge-studio-linux-x86_64.AppImage")),
  });
  console.log(`Brouillon v${options.version} cree avec l'AppImage. Relisez-le et publiez-le dans GitHub.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ERREUR : ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  }
}
