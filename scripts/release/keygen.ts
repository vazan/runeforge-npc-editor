/**
 * Genere la paire de cles de signature des mises a jour (DEC-046). A faire **une seule fois**, par le proprietaire :
 *
 *   pnpm release:keygen --out C:\chemin\hors\du\depot\runeforge-update.key
 *
 * `tauri signer generate` demande le mot de passe de la cle privee dans ce terminal (il ne passe ni par un argument ni par un fichier).
 * La cle publique est ensuite copiee dans `apps/desktop/src-tauri/update-public-key.txt`, que l'application embarque a la construction.
 *
 * Garde-fous :
 *  - la cle privee doit etre ecrite **hors du depot** (sinon elle finirait dans Git) et sans ecraser un fichier existant ;
 *  - une cle publique deja configuree n'est jamais remplacee : chaque exemplaire installe fait confiance a elle seule, donc la
 *    changer coupe les mises a jour de tous les exemplaires deja distribues (ils devraient etre reinstalles a la main).
 *
 * Sauvegardez la cle privee ET son mot de passe en lieu sur : sans eux, plus aucune mise a jour ne peut etre signee.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { softwareRoot } from "./lib";
import { PUBLIC_KEY_FILE } from "./prepare";

const tauriCli = join(softwareRoot, "apps", "desktop", "node_modules", "@tauri-apps", "cli", "tauri.js");
/** La racine du depot Git (le dossier qui contient `Software/`). */
const repositoryRoot = resolve(softwareRoot, "..");

function refuse(reason: string): never {
  throw new Error(reason);
}

export function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export interface KeygenOptions {
  /** Fichier de la cle privee ; la cle publique est ecrite a cote, avec le suffixe `.pub`. */
  readonly out: string;
  readonly publicKeyFile: string;
  readonly repositoryRoot: string;
  /** Lance `tauri signer generate -w <out>` (interactif) ; remplacee dans les tests. */
  readonly generate: (out: string) => void;
}

/** Les controles, puis la generation ; renvoie le texte de la cle publique configuree. */
export function generateProductionKey(options: KeygenOptions): string {
  const out = resolve(options.out);
  if (isInside(options.repositoryRoot, out)) refuse("la cle privee doit etre ecrite hors du depot Git (sinon elle serait commitee) : choisissez un dossier de votre profil ou un coffre");
  if (existsSync(out) || existsSync(`${out}.pub`)) refuse(`${out} existe deja : une cle existante n'est jamais ecrasee`);
  const current = readFileSync(options.publicKeyFile, "utf8").trim();
  if (!current.startsWith("UNCONFIGURED")) {
    refuse("une cle publique est deja configuree : la remplacer couperait les mises a jour de tous les exemplaires deja distribues. Si c'est voulu, videz update-public-key.txt a la main (et lisez docs/RELEASE.md)");
  }
  options.generate(out);
  if (!existsSync(out) || !existsSync(`${out}.pub`)) refuse("la generation n'a pas produit la paire de cles");
  const publicKey = readFileSync(`${out}.pub`, "utf8").trim();
  if (publicKey === "") refuse("la cle publique generee est vide");
  writeFileSync(options.publicKeyFile, `${publicKey}\n`);
  return publicKey;
}

function interactiveGenerate(out: string): void {
  if (!existsSync(tauriCli)) refuse("l'outil `tauri` est introuvable : lancez `pnpm install` dans Software/");
  const result = spawnSync(process.execPath, [tauriCli, "signer", "generate", "-w", out], { stdio: "inherit", windowsHide: false });
  if (result.status !== 0) refuse("`tauri signer generate` a echoue ou a ete interrompu");
}

function main(): void {
  const argv = process.argv.slice(2).filter((argument) => argument !== "--");
  const index = argv.indexOf("--out");
  const out = index === -1 ? undefined : argv[index + 1];
  if (out === undefined || out.startsWith("--") || argv.length !== 2) refuse("usage : pnpm release:keygen --out <fichier de cle privee hors du depot>");
  const publicKey = generateProductionKey({ out, publicKeyFile: PUBLIC_KEY_FILE, repositoryRoot, generate: interactiveGenerate });
  console.log(`Cle privee : ${resolve(out)}`);
  console.log(`Cle publique (copiee dans ${PUBLIC_KEY_FILE}) :\n${publicKey}`);
  console.log("\nA FAIRE MAINTENANT :");
  console.log("  1. Sauvegardez la cle privee ET son mot de passe en deux lieux surs, hors du depot (sans eux, plus de mise a jour possible).");
  console.log("  2. Ne les envoyez a personne : qui les detient peut publier une mise a jour acceptee par toutes les installations.");
  console.log("  3. Reconstruisez l'application : la premiere version distribuee doit deja contenir cette cle publique.");
  console.log(`  4. Pensez a commiter ${join("apps", "desktop", "src-tauri", "update-public-key.txt")} (la cle publique n'est pas un secret).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ERREUR : ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
