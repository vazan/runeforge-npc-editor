/**
 * Test de fumee de l'executable reel (variante E2E) sur un **vrai serveur rAthena**, ouvert comme projet, en lecture seule :
 * temps de reconnaissance du serveur, indexation, portee « scripts charges » et diagnostics de quelques fichiers reels.
 * Aucune ecriture dans le dossier du serveur (la portee « charges » est appliquee en memoire, sans enregistrer la configuration).
 *
 * Usage : pnpm exec tsx scripts/e2e/real-server-smoke.ts <exe-e2e> <racine-du-serveur> [fichier-relatif ...]
 * Les fichiers donnes sont ouverts et leurs diagnostics affiches (par defaut : trois fichiers du serveur local de developpement).
 * N'est pas lance par `pnpm e2e` : il depend d'un serveur present sur la machine.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, launch, sleep } from "./cdp";
import { closeCompletion, describeSeries, measureCompletion, measureRoundTrips, ms, summarize, type CompletionLatency } from "./completion-latency";

const [exe, server, ...requested] = process.argv.slice(2);
if (exe === undefined || server === undefined) {
  console.error("Usage : tsx scripts/e2e/real-server-smoke.ts <exe-e2e> <racine-du-serveur> [fichier-relatif ...]");
  process.exit(2);
}
const files = requested.length > 0 ? requested : ["npc/jobs/2-1/assassin.txt", "npc/other/CashShop_Functions.txt", "npc/custom/warper.txt"];
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "target", "e2e-artifacts");
mkdirSync(outDir, { recursive: true });

const work = mkdtempSync(join(tmpdir(), "runeforge-smoke-"));
const PORT = 9334;
const E2E = "window.__RUNEFORGE_E2E__";
const state = (expression: string): string => `${E2E}.store.getState().${expression}`;

const app = launch({
  exe,
  port: PORT,
  webviewDataDir: join(work, "webview"),
  env: { RUNEFORGE_E2E_PROJECT: server, RUNEFORGE_E2E_DATA_DIR: join(work, "appdata") },
});
try {
  const client = await Cdp.connect(PORT);
  const started = Date.now();
  await client.waitFor(`!!${E2E} && ${state("ready")} && ${state("project")} !== null`, "projet ouvert", 60_000);
  console.log(`projet ouvert apres ${Date.now() - started} ms : ${await client.evaluate<number>(state("project.fileCount"))} fichiers dans l'arbre`);

  await client.waitFor(`${state("emulator.status")} === "ready"`, "serveur reconnu", 60_000);
  console.log(`serveur reconnu apres ${Date.now() - started} ms :`, JSON.stringify(await client.evaluate(state("emulator"))));

  // Bases du serveur (objets, monstres, cartes, constantes) : lecture par l'IPC, decodage et construction dans le worker.
  await client.waitFor(`${state("emulator.catalog")} !== null`, "bases du serveur lues", 60_000);
  console.log(`bases du serveur lues apres ${Date.now() - started} ms :`, JSON.stringify(await client.evaluate(state("emulator.catalog"))));

  await client.waitFor(`${state("indexing.status")} === "done"`, "indexation terminee", 180_000);
  console.log(`indexation (portee sources) terminee apres ${Date.now() - started} ms :`, JSON.stringify(await client.evaluate(state("indexing"))));
  console.log(
    "barre d'etat :",
    JSON.stringify(await client.evaluate(`(() => { const e = document.querySelector('.status-server'); return { text: e?.textContent, title: e?.getAttribute('title') }; })()`)),
  );

  // Rapport de projet (RF-015) avec la portee par defaut : tous les .txt du serveur sont indexes, documentation et bases comprises.
  // Par defaut le rapport ne montre que les scripts que le serveur charge ; la case permet de tout voir.
  const reportView = (): Promise<{ examined: number; files: number; header: string; shown: number; notice: string; loaded: number | null; notLoaded: number }> =>
    client.evaluate(
      `({ examined: ${state("projectReport.report.examined")}, files: ${state("projectReport.report.files.length")}, header: document.querySelector('.report .problems-count')?.textContent ?? '', shown: document.querySelectorAll('.report-file-path').length, notice: document.querySelector('.report-scope')?.textContent ?? '', loaded: ${state("projectReport.scope.loaded")}?.size ?? null, notLoaded: ${state("projectReport.scope.notLoaded")} })`,
    );
  // Les durees sont mesurees DANS la page (`performance.now()`, sondage a 0 ms) : un sondage depuis ici aurait 150 ms de resolution.
  const timeInPage = (start: string, done: string, limitMs = 60_000): Promise<number> =>
    client.evaluate<number>(
      `new Promise((resolve, reject) => { const t0 = performance.now(); ${start}; const poll = () => { if (${done}) resolve(performance.now() - t0); else if (performance.now() - t0 > ${limitMs}) reject(new Error("delai depasse")); else setTimeout(poll, 0); }; poll(); })`,
    );
  const reportShownMs = await timeInPage(
    `${E2E}.controller.showProjectReport()`,
    `${state("projectReport.status")} === "ready" && document.querySelectorAll('.report-file-path').length > 0`,
  );
  const restricted = await reportView();
  console.log(`rapport de projet (portee sources, restreint aux scripts charges) affiche ${reportShownMs.toFixed(0)} ms apres la demande : ${JSON.stringify(restricted)}`);
  await client.screenshot(join(outDir, "smoke-real-report-loaded-only.png"));
  const unhideMs = await timeInPage(
    `${E2E}.controller.setReportHideUnloaded(false)`,
    `${state("projectReport.status")} === "ready" && ${state("projectReport.report.excluded")} === null && document.querySelectorAll('.report-file-path').length > ${restricted.shown}`,
  );
  console.log(`rapport complet (tous les fichiers indexes) recalcule et affiche ${unhideMs.toFixed(0)} ms apres la case decochee : ${JSON.stringify(await reportView())}`);
  await client.screenshot(join(outDir, "smoke-real-report-all.png"));
  await client.evaluate(`${E2E}.controller.setReportHideUnloaded(true)`);
  await client.waitFor(`${state("projectReport.status")} === "ready" && ${state("projectReport.report.excluded")} !== null`, "retour a la vue restreinte", 30_000);

  // Portee « scripts charges » appliquee en memoire seulement : rien n'est ecrit dans le dossier du serveur.
  const switched = Date.now();
  await client.evaluate(
    `(() => { const s = ${E2E}.store; const p = s.getState().project; s.setState({ project: { ...p, config: { ...p.config, emulator: { ...p.config.emulator, indexScope: "loaded" } } } }); return ${E2E}.controller.refreshTree(true); })()`,
  );
  await client.waitFor(`${state("emulator.loadedScripts")} !== null`, "scripts charges calcules", 60_000);
  await client.waitFor(`${state("indexing.status")} === "done"`, "reindexation terminee", 120_000);
  await sleep(500);
  console.log(
    `portee « scripts charges » appliquee apres ${Date.now() - switched} ms :`,
    JSON.stringify(await client.evaluate(`({ loadedScripts: ${state("emulator.loadedScripts")}, loadIssues: ${state("emulator.loadIssues")}, indexing: ${state("indexing")} })`)),
  );

  // Le meme rapport avec la portee « scripts charges » : plus rien a masquer.
  const refreshMs = await timeInPage(
    `${E2E}.controller.refreshProjectReport()`,
    `${state("projectReport.status")} === "ready" && ${state("projectReport.scope.loaded")} === null && ${state("projectReport.complete")} === true && ${state("projectReport.stale")} === false`,
  );
  console.log(`rapport de projet (portee scripts charges) recalcule ${refreshMs.toFixed(0)} ms apres la demande : ${JSON.stringify(await reportView())}`);
  await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);

  for (const path of files) {
    const quoted = JSON.stringify(path);
    await client.evaluate(`${E2E}.controller.openFile(${quoted})`);
    await client.waitFor(`${state("activePath")} === ${quoted}`, `${path} ouvert`, 30_000);
    await client.waitFor(`!!${state(`diagnostics[${quoted}]`)}`, `diagnostics de ${path}`, 60_000);
    const codes = await client.evaluate<string[]>(`${state(`diagnostics[${quoted}].diagnostics`)}.map((d) => d.code + ":" + d.severity)`);
    console.log(`diagnostics de ${path} : ${codes.length === 0 ? "aucun" : codes.join(", ")}`);
  }
  await client.screenshot(join(outDir, "smoke-real-server.png"));

  // Latence de la completion des commandes avec le registre complet du serveur, dans l'application reelle : le curseur est place
  // au debut d'une instruction d'un vrai script, sans rien saisir ; Ctrl+Espace liste alors toutes les commandes. Rien n'est modifie.
  const subject = files[0];
  if (subject !== undefined) {
    const quoted = JSON.stringify(subject);
    await client.evaluate(`${E2E}.controller.openFile(${quoted})`);
    await client.waitFor(`${state("activePath")} === ${quoted} && !!document.querySelector('.monaco-editor')`, `${subject} ouvert dans Monaco`, 30_000);
    const position = await client.evaluate<{ line: number; column: number } | null>(
      `(() => { const lines = ${E2E}.controller.getManager().textOf(${quoted}).split('\\n'); const index = lines.findIndex((line) => /^\\t[a-z]+ .*;\\s*$/.test(line)); return index < 0 ? null : { line: index + 1, column: 2 }; })()`,
    );
    if (position === null) {
      console.log(`latence de completion : aucune ligne d'instruction trouvee dans ${subject}`);
    } else {
      const trips = await measureRoundTrips(client, `${E2E}.controller`, subject, position.line, position.column, 10);
      const trip = summarize(trips.times);
      console.log(
        `completion des commandes (${subject}:${position.line}, mot vide, ${trips.items} propositions) : controleur -> Worker -> service -> reponse (sans Monaco, 10 appels) min ${ms(trip.min)} / mediane ${ms(trip.median)} / max ${ms(trip.max)} ms`,
      );
      await client.evaluate(
        `(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: ${position.line}, column: ${position.column} }); editor.focus(); })()`,
      );
      const first = await measureCompletion(client, null);
      await sleep(400);
      await client.screenshot(join(outDir, "smoke-real-completion.png"));
      await closeCompletion(client);
      const warm: CompletionLatency[] = [];
      for (let index = 0; index < 9; index += 1) {
        warm.push(await measureCompletion(client, null));
        await closeCompletion(client);
      }
      for (const line of describeSeries(first, warm)) console.log(`  ${line}`);
      const dirty = await client.evaluate<boolean>(state(`docs[${quoted}]?.dirty === true`));
      console.log(`document modifie par la completion ? ${dirty}`);
    }
  }
  // Bases du serveur lues par l'application (objets, monstres, cartes, constantes) et completion de l'argument d'un objet parmi
  // tous ceux du serveur, dans un vrai script (curseur au debut du nombre de `getitem`/`countitem`/`delitem`, rien de saisi).
  const catalog = await client.evaluate<{ items: number; mobs: number; maps: number; constants: number } | null>(state("emulator.catalog"));
  const catalogWarnings = await client.evaluate<string[]>(state("emulator.catalogWarnings"));
  console.log(`bases du serveur lues par l'application : ${JSON.stringify(catalog)} ; avertissements : ${catalogWarnings.length === 0 ? "aucun" : catalogWarnings.join(" ; ")}`);
  const itemFile = "npc/instances/EndlessTower.txt";
  const quotedItemFile = JSON.stringify(itemFile);
  await client.evaluate(`${E2E}.controller.openFile(${quotedItemFile})`);
  await client.waitFor(`${state("activePath")} === ${quotedItemFile} && !!document.querySelector('.monaco-editor')`, `${itemFile} ouvert dans Monaco`, 30_000);
  await client.waitFor(`!!${state(`diagnostics[${quotedItemFile}]`)}`, `diagnostics de ${itemFile}`, 60_000);
  const itemCodes = await client.evaluate<string[]>(`${state(`diagnostics[${quotedItemFile}].diagnostics`)}.map((d) => d.code)`);
  console.log(`diagnostics de ${itemFile} : ${itemCodes.length === 0 ? "aucun" : itemCodes.join(", ")}`);
  const itemPosition = await client.evaluate<{ line: number; column: number } | null>(
    `(() => { const lines = ${E2E}.controller.getManager().textOf(${quotedItemFile}).split('\\n'); for (let i = 0; i < lines.length; i++) { const m = /^\\t(?:countitem|getitem|delitem) (?=\\d)/.exec(lines[i]); if (m) return { line: i + 1, column: m[0].length + 1 }; } return null; })()`,
  );
  if (itemPosition === null) {
    console.log(`completion d'objet : aucune ligne getitem/countitem/delitem dans ${itemFile}`);
  } else {
    const trips = await measureRoundTrips(client, `${E2E}.controller`, itemFile, itemPosition.line, itemPosition.column, 10);
    const trip = summarize(trips.times);
    console.log(
      `completion d'un objet (${itemFile}:${itemPosition.line}, mot vide, ${trips.items} propositions) : controleur -> Worker -> service -> reponse (sans Monaco, 10 appels) min ${ms(trip.min)} / mediane ${ms(trip.median)} / max ${ms(trip.max)} ms`,
    );
    await client.evaluate(
      `(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: ${itemPosition.line}, column: ${itemPosition.column} }); editor.focus(); })()`,
    );
    const firstItem = await measureCompletion(client, null);
    await sleep(400);
    await client.screenshot(join(outDir, "smoke-real-item-completion.png"));
    await closeCompletion(client);
    const warmItems: CompletionLatency[] = [];
    for (let index = 0; index < 9; index += 1) {
      warmItems.push(await measureCompletion(client, null));
      await closeCompletion(client);
    }
    for (const line of describeSeries(firstItem, warmItems)) console.log(`  ${line}`);
    console.log(`document modifie par la completion ? ${await client.evaluate<boolean>(state(`docs[${quotedItemFile}]?.dirty === true`))}`);
  }
  console.log("dossier .runeforge cree dans le serveur ?", existsSync(join(server, ".runeforge")));
  client.close();
} finally {
  app.kill();
  await sleep(500);
  rmSync(work, { recursive: true, force: true });
}
