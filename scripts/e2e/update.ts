/**
 * E2E Windows (WebView2) des mises a jour signees (DEC-046) sur l'application reelle, contre un **faux serveur GitHub local**
 * (`http://127.0.0.1`) : aucune requete ne quitte la machine, aucune vraie release n'est lue.
 *
 * Ce que ce scenario prouve, sur le vrai executable (construction `--features e2e`, qui embarque la cle publique de TEST) :
 *  - rien n'est contacte au demarrage ni a l'ouverture de l'onglet : seulement apres l'appui sur « Rechercher » ;
 *  - un depot prive sans jeton est refuse (404) et explique ; avec le jeton, il est lu, et le jeton n'est ecrit nulle part sur le disque ;
 *  - une signature d'une autre cle est refusee avant tout telechargement de l'executable ;
 *  - un executable altere apres signature est detecte (empreinte), supprime, et l'application reste intacte ;
 *  - l'installation est refusee sans controle prealable, et tant que des modifications ne sont pas enregistrees ;
 *  - une installation reelle : telechargement avec progression, remplacement de l'executable en cours d'execution, redemarrage,
 *    nettoyage de l'ancienne version.
 *
 * Usage : pnpm exec tsx scripts/e2e/update.ts <chemin-de-l-exe-e2e> <dossier-de-captures>
 * L'executable est COPIE (sous un nom propre a ce scenario) : l'original n'est jamais remplace.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, launch, sleep, type AppProcess } from "./cdp";
import { artifactName, buildManifest, sha256Hex, signFile, softwareRoot, type SigningKey } from "../release/lib";

const [exeArgument, outArgument] = process.argv.slice(2);
if (exeArgument === undefined || outArgument === undefined) {
  console.error("Usage : tsx scripts/e2e/update.ts <exe-e2e> <dossier-captures>");
  process.exit(2);
}
const outDir: string = outArgument;
mkdirSync(outDir, { recursive: true });

const PORT = 9334;
const IMAGE = "runeforge-e2e-update.exe";
const REPOSITORY = "e2e/releases-repo";
const TOKEN = "e2e_token-0123456789";
const keys = join(softwareRoot, "crates", "updater", "tests", "fixtures", "keys");
const testKey: SigningKey = { path: join(keys, "test.key"), password: "test-only" };
const otherKey: SigningKey = { path: join(keys, "other.key"), password: "test-only" };

const work = mkdtempSync(join(tmpdir(), "runeforge-e2e-update-"));
const appDir = join(work, "app");
const appExe = join(appDir, IMAGE);
const project = join(work, "project");
const appData = join(work, "appdata");
const webview = join(work, "webview");
mkdirSync(appDir, { recursive: true });
mkdirSync(join(project, "npc"), { recursive: true });
writeFileSync(join(project, "npc", "a.txt"), 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n');
copyFileSync(exeArgument, appExe);

// La « nouvelle version » : le meme programme suivi de donnees ignorees par le chargeur Windows (un executable valide et different).
const original = readFileSync(appExe);
const marker = Buffer.from("\nRUNEFORGE-E2E-UPDATE-MARKER\n");
const upgraded = Buffer.concat([original, marker]);
const tampered = Buffer.from(upgraded);
tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0xff;

// --- Faux serveur de releases GitHub --------------------------------------------------------------------------------------------

interface MockAsset {
  readonly id: number;
  readonly name: string;
  readonly bytes: Buffer;
  /** Servi en morceaux espaces, pour que la progression soit observable. */
  readonly slow?: boolean;
}

interface MockRelease {
  readonly tag: string;
  readonly assets: readonly MockAsset[];
}

const mock = {
  releases: [] as MockRelease[],
  /** Depot « prive » : sans `Authorization: Bearer <jeton>`, l'API repond 404 comme GitHub. */
  requireToken: null as string | null,
  log: [] as { path: string; bearer: boolean }[],
};
let nextAssetId = 100;

function signedRelease(version: string, options: { key: SigningKey; declared: Buffer; served?: Buffer; notes?: string; slow?: boolean }): MockRelease {
  const name = artifactName(version, "windows-x86_64");
  const manifestPath = join(work, `manifest-${version}.json`);
  writeFileSync(
    manifestPath,
    buildManifest({
      version,
      channel: "stable",
      publishedAt: "2026-11-15T10:00:00Z",
      notes: options.notes ?? `Notes ${version}.\nLigne avec <b>balises</b> et & esperluette.`,
      artifacts: [{ platform: "windows-x86_64", file: name, size: options.declared.length, sha256: sha256Hex(options.declared) }],
    }),
  );
  const signature = signFile(manifestPath, options.key);
  return {
    tag: `v${version}`,
    assets: [
      { id: nextAssetId++, name: "update-manifest.json", bytes: readFileSync(manifestPath) },
      { id: nextAssetId++, name: "update-manifest.json.sig", bytes: Buffer.from(signature) },
      { id: nextAssetId++, name, bytes: options.served ?? options.declared, ...(options.slow === true ? { slow: true } : {}) },
    ],
  };
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const bearer = request.headers.authorization === `Bearer ${TOKEN}`;
  mock.log.push({ path, bearer });
  const notFound = (): void => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"message":"Not Found"}');
  };
  if (mock.requireToken !== null && !bearer) return notFound();
  if (path === `/repos/${REPOSITORY}/releases`) {
    const list = mock.releases.map((release) => ({
      tag_name: release.tag,
      draft: false,
      prerelease: false,
      assets: release.assets.map((asset) => ({ id: asset.id, name: asset.name, size: asset.bytes.length })),
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(list));
    return;
  }
  const assetId = /^\/repos\/e2e\/releases-repo\/releases\/assets\/(\d+)$/.exec(path)?.[1];
  const asset = mock.releases.flatMap((release) => release.assets).find((candidate) => String(candidate.id) === assetId);
  if (asset === undefined) return notFound();
  response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(asset.bytes.length) });
  if (asset.slow !== true) {
    response.end(asset.bytes);
    return;
  }
  const chunks = 16;
  const size = Math.ceil(asset.bytes.length / chunks);
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= asset.bytes.length || response.destroyed) {
      clearInterval(timer);
      response.end();
      return;
    }
    response.write(asset.bytes.subarray(offset, offset + size));
    offset += size;
  }, 120);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiPort = (server.address() as AddressInfo).port;

// --- Pilotage de l'application ----------------------------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail?: string }[] = [];
const session: { app: AppProcess | null; cdp: Cdp | null } = { app: null, cdp: null };
const E2E = "window.__RUNEFORGE_E2E__";
const state = (expression: string): string => `${E2E}.store.getState().${expression}`;

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail}`);
    if (session.cdp !== null) await session.cdp.screenshot(join(outDir, `UPDATE-FAIL-${results.length}.png`)).catch(() => undefined);
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function listDirectory(directory: string): string[] {
  return readdirSync(directory).sort();
}

/** Tous les fichiers sous `directory` (chemins relatifs). */
function filesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? filesUnder(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

async function waitUntil(description: string, test: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (test()) return;
    await sleep(150);
  }
  throw new Error(`delai depasse : ${description}`);
}

const dialogText = (client: Cdp): Promise<string> => client.evaluate<string>(`document.querySelector('[role=dialog]')?.innerText ?? ''`);
const buttonByName = (name: string): string => `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
const inputByLabel = (label: string): string => `[...document.querySelectorAll('[role=dialog] label.field')].find((l) => l.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('input')`;

async function typeInto(client: Cdp, inputExpression: string, text: string): Promise<void> {
  await client.evaluate(`(() => { const el = ${inputExpression}; el.focus(); el.select(); })()`);
  await client.insertText(text);
}

async function click(client: Cdp, buttonExpression: string): Promise<void> {
  await client.waitFor(`!!${buttonExpression} && !${buttonExpression}.disabled`, `bouton actif ${buttonExpression.slice(0, 60)}`);
  await client.evaluate(`${buttonExpression}.click()`);
}

/** Appelle directement une commande native (comme le ferait la page), et rend le code d'erreur rejete ou `resolved`. */
const invokeCode = (client: Cdp, command: string, args: Record<string, unknown>): Promise<string> =>
  client.evaluate<string>(
    `(async () => { try { await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}); return "resolved"; } catch (error) { return error && error.code ? error.code : String(error); } })()`,
  );

function startApp(): void {
  session.app = launch({
    exe: appExe,
    port: PORT,
    webviewDataDir: webview,
    env: {
      RUNEFORGE_E2E_PROJECT: project,
      RUNEFORGE_E2E_DATA_DIR: appData,
      RUNEFORGE_E2E_UPDATE_API: `http://127.0.0.1:${apiPort}`,
      RUNEFORGE_E2E_UPDATE_CONFIRM: "1",
    },
  });
}

async function connect(): Promise<Cdp> {
  const client = await Cdp.connect(PORT, 60_000);
  await client.waitFor(`!!${E2E} && ${state("ready")} && ${state("project")} !== null`, "projet ouvert", 40_000);
  return client;
}

async function openUpdatesTab(client: Cdp): Promise<void> {
  await client.evaluate(`${E2E}.controller.openSettings("updates")`);
  await client.waitFor(`document.querySelector('[role=dialog]')?.innerText.includes('Installed version')`, "onglet Updates affiche");
}

const checkButton = buttonByName("Check for updates");
const installButton = buttonByName("Install and restart");

async function runCheck(client: Cdp): Promise<void> {
  const before = mock.log.length;
  await click(client, checkButton);
  await client.waitFor(`${state("update.status")} !== "checking" && ${state("update.status")} !== "idle"`, "controle termine", 30_000);
  expect(mock.log.length > before, "le controle n'a fait aucune requete");
}

async function main(): Promise<void> {
  startApp();
  session.cdp = await connect();
  const c = session.cdp;

  await step("rien n'est contacte au demarrage, ni a l'ouverture de l'onglet Mises a jour", async () => {
    await sleep(1500);
    expect(mock.log.length === 0, `requetes inattendues au demarrage : ${JSON.stringify(mock.log)}`);
    await openUpdatesTab(c);
    await sleep(500);
    expect(mock.log.length === 0, `requetes a l'ouverture de l'onglet : ${JSON.stringify(mock.log)}`);
    expect((await dialogText(c)).includes("Nothing is contacted until you press"), "la regle du reseau n'est pas affichee");
    await c.screenshot(join(outDir, "update-01-tab.png"));
  });

  await step("depot prive sans jeton : refuse, explique, sans rien afficher du serveur", async () => {
    mock.requireToken = TOKEN;
    mock.releases = [signedRelease("0.9.0", { key: testKey, declared: upgraded, served: upgraded })];
    await typeInto(c, inputByLabel("Repository"), REPOSITORY);
    await c.waitFor(`${state("settings.updates.repository")} === ${JSON.stringify(REPOSITORY)}`, "depot enregistre dans les reglages");
    await runCheck(c);
    await c.waitFor(`${state("update.status")} === "error"`, "echec affiche");
    const text = await dialogText(c);
    expect(text.includes("GitHub does not show this repository"), `message inattendu : ${text}`);
    expect(mock.log.every((entry) => !entry.bearer), "un jeton est parti alors qu'aucun n'avait ete saisi");
    expect(mock.log.length === 1, `une seule requete attendue, vue : ${JSON.stringify(mock.log)}`);
  });

  await step("avec le jeton : la mise a jour est proposee, les notes sont du texte, le jeton n'est ecrit nulle part", async () => {
    mock.log.length = 0;
    await typeInto(c, inputByLabel("Access token"), TOKEN);
    await runCheck(c);
    await c.waitFor(`${state("update.status")} === "available"`, "mise a jour proposee");
    const text = await dialogText(c);
    expect(text.includes("Version 0.9.0 is available"), `texte inattendu : ${text}`);
    const notes = await c.evaluate<string>(`document.querySelector('[role=dialog] .update-notes')?.textContent ?? ''`);
    expect(notes.includes("<b>balises</b> et & esperluette"), `notes alterees : ${notes}`);
    expect(await c.evaluate<boolean>(`!document.querySelector('[role=dialog] .update-notes b')`), "les notes ont ete interpretees comme du HTML");
    // 3 requetes : la liste, le manifeste, la signature — toutes avec le jeton, aucune pour l'executable.
    expect(mock.log.length === 3 && mock.log.every((entry) => entry.bearer), `requetes inattendues : ${JSON.stringify(mock.log)}`);
    expect(!mock.log.some((entry) => entry.path.endsWith(`/${mock.releases[0]?.assets[2]?.id ?? 0}`)), "l'executable a ete telecharge avant l'installation");
    for (const file of filesUnder(appData)) {
      expect(!readFileSync(join(appData, file)).includes(Buffer.from(TOKEN)), `le jeton est ecrit dans ${file}`);
    }
    const settings = JSON.parse(readFileSync(join(appData, "config", "settings.json"), "utf8")) as { updates?: { repository?: string; channel?: string } };
    expect(settings.updates?.repository === REPOSITORY && settings.updates.channel === "stable", `reglages enregistres : ${JSON.stringify(settings.updates)}`);
    await c.screenshot(join(outDir, "update-02-available.png"));
  });

  await step("une signature d'une autre cle est refusee avant tout telechargement de l'executable", async () => {
    mock.log.length = 0;
    mock.releases = [signedRelease("0.9.1", { key: otherKey, declared: upgraded })];
    await runCheck(c);
    await c.waitFor(`${state("update.status")} === "error"`, "echec affiche");
    expect((await dialogText(c)).includes("signature is not valid for this application"), `message inattendu : ${await dialogText(c)}`);
    const exeId = mock.releases[0]?.assets[2]?.id ?? 0;
    expect(!mock.log.some((entry) => entry.path.endsWith(`/${exeId}`)), "l'executable a ete telecharge malgre une signature invalide");
  });

  await step("l'installation est refusee tant qu'aucune mise a jour n'a ete verifiee", async () => {
    mock.log.length = 0;
    const code = await invokeCode(c, "update_install", { request: { token: TOKEN, locale: "en" } });
    expect(code === "no_pending_update", `code inattendu : ${code}`);
    expect(mock.log.length === 0, "des requetes ont ete faites sans mise a jour verifiee");
  });

  await step("un executable altere apres signature est detecte, supprime, et l'application reste intacte", async () => {
    mock.log.length = 0;
    mock.releases = [signedRelease("0.9.2", { key: testKey, declared: upgraded, served: tampered })];
    await runCheck(c);
    await c.waitFor(`${state("update.status")} === "available"`, "mise a jour proposee");
    await click(c, installButton);
    await c.waitFor(`${state("update.status")} === "available" && ${state("update.failure?.code")} === "hash_mismatch"`, "echec d'empreinte", 60_000);
    expect((await dialogText(c)).includes("does not match the signed manifest"), `message inattendu : ${await dialogText(c)}`);
    expect(readFileSync(appExe).equals(original), "l'executable a ete modifie");
    expect(listDirectory(appDir).join(",") === IMAGE, `fichiers restants a cote de l'application : ${listDirectory(appDir).join(", ")}`);
    expect(session.app?.running === true, "l'application s'est arretee");
  });

  await step("l'installation est refusee tant que des modifications ne sont pas enregistrees (verifie par le coeur natif)", async () => {
    mock.log.length = 0;
    mock.releases = [signedRelease("0.9.0", { key: testKey, declared: upgraded, served: upgraded, slow: true })];
    await runCheck(c);
    await c.waitFor(`${state("update.status")} === "available"`, "mise a jour proposee");
    mock.log.length = 0;
    await c.evaluate(`window.__TAURI_INTERNALS__.invoke("set_dirty", { dirty: true })`);
    const code = await invokeCode(c, "update_install", { request: { token: TOKEN, locale: "en" } });
    await c.evaluate(`window.__TAURI_INTERNALS__.invoke("set_dirty", { dirty: false })`);
    expect(code === "unsaved_changes", `code inattendu : ${code}`);
    expect(mock.log.length === 0, "un telechargement a commence malgre des modifications non enregistrees");
    expect(readFileSync(appExe).equals(original), "l'executable a ete modifie");
  });

  await step("installation reelle : progression, remplacement de l'executable en cours, redemarrage, nettoyage", async () => {
    mock.log.length = 0;
    await c.evaluate(`(() => { window.__samples = []; ${E2E}.store.subscribe((s) => { const u = s.update; if (u.status === "installing") window.__samples.push([u.received, u.total]); }); })()`);
    await click(c, installButton);
    await c.waitFor(`window.__samples.some((s) => s[0] > 0 && s[0] < s[1])`, "progression observee pendant le telechargement", 30_000);
    await c.screenshot(join(outDir, "update-03-installing.png")).catch(() => undefined);

    await waitUntil("l'ancienne instance quitte", () => session.app?.running === false, 60_000);
    expect(readFileSync(appExe).equals(upgraded), "l'executable n'est pas la nouvelle version");
    c.close();
    session.cdp = null;

    // Le programme relance (meme dossier de donnees, meme port de debogage) : il doit etre pret et avoir nettoye l'ancienne version.
    session.cdp = await connect();
    await waitUntil("l'ancienne version est supprimee au redemarrage", () => !existsSync(`${appExe}.old`), 20_000);
    expect(listDirectory(appDir).join(",") === IMAGE, `fichiers restants a cote de l'application : ${listDirectory(appDir).join(", ")}`);
    expect(readFileSync(appExe).equals(upgraded), "la nouvelle version n'est plus en place");
    expect(await session.cdp.evaluate<boolean>(`${state("ready")} === true`), "l'application redemarree n'est pas prete");
    // L'executable a ete telecharge une seule fois, avec le jeton.
    const downloads = mock.log.filter((entry) => !entry.path.endsWith("/releases"));
    expect(downloads.length >= 1 && downloads.every((entry) => entry.bearer), `requetes de telechargement : ${JSON.stringify(downloads)}`);
    await session.cdp.screenshot(join(outDir, "update-04-restarted.png"));
  });

  await step("aucune erreur inattendue dans la console de la premiere instance", async () => {
    // `c` n'est plus connecte apres le redemarrage : ses erreurs ont ete collectees pendant tout le scenario.
    expect(c.consoleErrors.length === 0, c.consoleErrors.join("\n        "));
  });
}

try {
  await main();
} catch (error) {
  results.push({ name: "execution du scenario", ok: false, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  console.log(`  FAIL  execution du scenario\n        ${results[results.length - 1]?.detail}`);
} finally {
  session.cdp?.close();
  session.app?.kill();
  // L'instance relancee par la mise a jour n'est pas un enfant de ce script : on l'arrete par son nom d'image, propre a ce scenario.
  spawnSync("taskkill", ["/IM", IMAGE, "/T", "/F"], { stdio: "ignore" });
  server.close();
  await sleep(800);
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} etapes reussies`);
process.exit(failed.length === 0 ? 0 : 1);
