/**
 * Cree un **brouillon** de release GitHub a partir du dossier prepare par `prepare.ts` (DEC-046) :
 *
 *   pnpm release:publish --repo proprietaire/depot --dir release-out/0.2.0 [--target branche-ou-commit] [--yes]
 *
 * Par defaut, rien n'est envoye : le script verifie le dossier (fichiers, empreinte, signature) et affiche la commande. Avec `--yes`,
 * il lance `gh release create --draft` avec la session `gh` du proprietaire (aucun jeton ne passe par ce script). Un brouillon n'est
 * visible ni des utilisateurs ni de la mise a jour : le proprietaire le relit dans GitHub puis le publie lui-meme.
 */
import { isUpdateRepository } from "@runeforge/project-core";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST_ASSET, SIGNATURE_ASSET, isSafeFileName, sha256Hex, verifySignature } from "./lib";
import { PUBLIC_KEY_FILE } from "./prepare";

export interface PublishPlan {
  readonly tag: string;
  readonly title: string;
  readonly prerelease: boolean;
  /** Fichiers a envoyer, avec leur chemin complet. */
  readonly files: readonly string[];
  /** Arguments de `gh`. */
  readonly args: readonly string[];
}

interface ManifestShape {
  readonly version: string;
  readonly channel: string;
  readonly notes: string;
  readonly platforms: Readonly<Record<string, { readonly file: string; readonly size: number; readonly sha256: string }>>;
}

function refuse(reason: string): never {
  throw new Error(reason);
}

/** Verifie le dossier comme l'application le fera, puis compose la commande `gh`. */
export function planPublish(options: { readonly directory: string; readonly repository: string; readonly publicKey: string; readonly target?: string }): PublishPlan {
  // Meme regle que l'application et le coeur natif (jamais `.` ni `..`, jamais un chemin ou une adresse).
  if (!isUpdateRepository(options.repository) || options.repository !== options.repository.trim()) refuse("--repo : proprietaire/depot");
  const manifestPath = join(options.directory, MANIFEST_ASSET);
  const signaturePath = join(options.directory, SIGNATURE_ASSET);
  if (!existsSync(manifestPath) || !existsSync(signaturePath)) refuse(`${MANIFEST_ASSET} et ${SIGNATURE_ASSET} doivent etre dans ${options.directory} (voir \`pnpm release:prepare\`)`);
  const manifestBytes = readFileSync(manifestPath);
  if (!verifySignature(options.publicKey, readFileSync(signaturePath, "utf8"), manifestBytes)) refuse("la signature ne se verifie pas avec la cle publique de l'application : rien n'est envoye");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ManifestShape;
  const entries = Object.entries(manifest.platforms);
  if (entries.length === 0) refuse("le manifeste ne decrit aucun fichier");
  const files: string[] = [];
  for (const [platform, entry] of entries) {
    if (!isSafeFileName(entry.file)) refuse(`nom de fichier refuse pour ${platform}`);
    const path = join(options.directory, entry.file);
    if (!existsSync(path)) refuse(`fichier manquant : ${entry.file}`);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sha256) refuse(`${entry.file} ne correspond pas au manifeste signe (taille ou empreinte) : rien n'est envoye`);
    files.push(path);
  }
  files.push(manifestPath, signaturePath);
  const tag = `v${manifest.version}`;
  const title = `RuneForge Studio ${manifest.version}`;
  const prerelease = manifest.channel === "beta";
  const args = [
    "release", "create", tag, ...files,
    "--repo", options.repository,
    "--draft",
    "--title", title,
    "--notes", manifest.notes,
    ...(prerelease ? ["--prerelease"] : []),
    ...(options.target === undefined ? [] : ["--target", options.target]),
  ];
  return { tag, title, prerelease, files, args };
}

function main(): void {
  const argv = process.argv.slice(2).filter((argument) => argument !== "--");
  const yes = argv.includes("--yes");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index] ?? "";
    if (name === "--yes") continue;
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined || value.startsWith("--")) refuse(`argument inattendu « ${name} » (voir l'en-tete de scripts/release/publish.ts)`);
    values.set(name.slice(2), value);
    index += 1;
  }
  const repository = values.get("repo") ?? refuse("--repo est obligatoire (proprietaire/depot)");
  const directory = resolve(values.get("dir") ?? refuse("--dir est obligatoire (le dossier prepare par `pnpm release:prepare`)"));
  const target = values.get("target");
  const plan = planPublish({ directory, repository, publicKey: readFileSync(PUBLIC_KEY_FILE, "utf8"), ...(target === undefined ? {} : { target }) });
  console.log(`Brouillon de release ${plan.tag} (${plan.prerelease ? "pre-release / canal beta" : "canal stable"}) pour ${repository} :`);
  for (const file of plan.files) console.log(`  ${file}`);
  if (!yes) {
    console.log("Aucun envoi (apercu). Relancez avec --yes pour creer le brouillon avec `gh`, puis publiez-le vous-meme dans GitHub.");
    return;
  }
  const result = spawnSync("gh", [...plan.args], { stdio: "inherit", windowsHide: true });
  if (result.error !== undefined) refuse("l'outil `gh` (GitHub CLI) est introuvable ou n'a pas pu demarrer ; installez-le et connectez-vous avec `gh auth login`");
  if (result.status !== 0) refuse("`gh release create` a echoue (voir le message ci-dessus)");
  console.log("Brouillon cree. Relisez-le dans GitHub, puis publiez-le : ce n'est qu'alors que l'application le propose.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ERREUR : ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
