/**
 * Mesure du demarrage de l'application reelle (WebView2) : combien de temps entre le lancement du processus et une interface
 * utilisable. Cible du cahier des charges : « application utilisable en < 3 s ».
 *
 * Usage : pnpm exec tsx scripts/e2e/startup.ts <chemin-de-l-exe-e2e> [--runs N]
 * L'executable doit avoir ete construit avec `--features e2e` (le crochet de test lit l'etat de l'application). Rien n'est ecrit
 * hors d'un dossier temporaire ; aucun serveur n'est lance.
 *
 * Jalons, chronometres depuis `spawn` (interrogation toutes les 15 ms) :
 * - `fenetre` : la page WebView2 existe (le protocole de debogage repond) ;
 * - `interface` : l'application a rendu son premier ecran (`.workbench` avec un projet, `.welcome` sans) ;
 * - `explorateur` : l'explorateur liste des fichiers (avec un projet) ;
 * - `index` : le worker a fini d'indexer le projet ;
 * - `editeur` : un fichier ouvert s'affiche dans Monaco et ses premiers jetons sont colores (Monaco se charge a la demande).
 * Trois situations : **A** profil WebView2 neuf (premier lancement), **B** profil deja utilise, avec un projet, **C** profil deja
 * utilise, sans projet (ecran d'accueil). Les caches du systeme de fichiers restent chauds apres le premier lancement : le tout
 * premier lancement d'une machine fraiche peut etre plus lent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Cdp, launch, sleep, type AppProcess } from "./cdp";

const [exeArgument, ...rest] = process.argv.slice(2);
if (exeArgument === undefined) {
  console.error("Usage : tsx scripts/e2e/startup.ts <exe-e2e> [--runs N]");
  process.exit(2);
}
const exe: string = exeArgument;
const runsIndex = rest.indexOf("--runs");
const runs = Math.max(2, Math.floor(Number(runsIndex >= 0 ? rest[runsIndex + 1] : "") || 8));
const PORT = 9335;
const POLL_MS = 15;

const work = mkdtempSync(join(tmpdir(), "runeforge-startup-"));
const project = join(work, "project");
mkdirSync(join(project, "npc"), { recursive: true });
// Un petit projet : une dizaine de scripts (le serveur reel est mesure par `real-server-smoke.ts`).
for (let index = 0; index < 12; index += 1) {
  const text = `prontera,${100 + index},${100 + index},4\tscript\tStartup${index}\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n`;
  writeFileSync(join(project, "npc", `s${index}.txt`), text);
}

interface Sample {
  readonly fenetre: number;
  readonly interface: number;
  readonly explorateur: number | null;
  readonly index: number | null;
  readonly editeur: number | null;
}

const E2E = "window.__RUNEFORGE_E2E__";

/** Attend qu'une expression devienne vraie, en l'interrogeant souvent ; retourne le temps (ms) depuis `origin`. */
async function until(client: Cdp, expression: string, origin: number, timeoutMs = 30_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if ((await client.evaluate<boolean>(expression).catch(() => false)) === true) return performance.now() - origin;
    await sleep(POLL_MS);
  }
  throw new Error(`delai depasse : ${expression}`);
}

async function measure(options: { webview: string; appData: string; withProject: boolean }): Promise<Sample> {
  const env: Record<string, string> = { RUNEFORGE_E2E_DATA_DIR: options.appData };
  if (options.withProject) env["RUNEFORGE_E2E_PROJECT"] = project;
  const origin = performance.now();
  const app: AppProcess = launch({ exe, port: PORT, webviewDataDir: options.webview, env });
  let client: Cdp | null = null;
  try {
    client = await Cdp.connect(PORT, 60_000, POLL_MS);
    const fenetre = performance.now() - origin;
    const ui = await until(client, options.withProject ? "!!document.querySelector('.workbench')" : "!!document.querySelector('.welcome')", origin);
    if (!options.withProject) return { fenetre, interface: ui, explorateur: null, index: null, editeur: null };
    const explorateur = await until(client, "document.querySelectorAll('[role=treeitem]').length > 0", origin);
    const index = await until(client, `${E2E}.store.getState().indexing.status === "done"`, origin);
    // Premiere ouverture d'un fichier : Monaco et ses polices se chargent a la demande.
    const opened = performance.now();
    await client.evaluate(`${E2E}.controller.openFile("npc/s0.txt")`);
    const editeur = await until(client, "!!document.querySelector('.monaco-editor .view-lines .mtk1, .monaco-editor .view-lines [class*=mtk]')", opened);
    return { fenetre, interface: ui, explorateur, index, editeur };
  } finally {
    client?.close();
    app.kill();
    // Laisse le systeme liberer le port et les verrous du profil avant la mesure suivante.
    await sleep(1500);
  }
}

function describe(label: string, values: readonly number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return `${label} : min ${Math.round(sorted[0] ?? 0)} / mediane ${Math.round(median)} / max ${Math.round(sorted[sorted.length - 1] ?? 0)} ms`;
}

function report(title: string, samples: readonly Sample[]): void {
  console.log(`\n${title} (${samples.length} lancements)`);
  console.log(`  ${describe("fenetre    ", samples.map((s) => s.fenetre))}`);
  console.log(`  ${describe("interface  ", samples.map((s) => s.interface))}`);
  const tree = samples.flatMap((s) => (s.explorateur === null ? [] : [s.explorateur]));
  const index = samples.flatMap((s) => (s.index === null ? [] : [s.index]));
  const editor = samples.flatMap((s) => (s.editeur === null ? [] : [s.editeur]));
  if (tree.length > 0) console.log(`  ${describe("explorateur", tree)}`);
  if (index.length > 0) console.log(`  ${describe("index      ", index)}`);
  if (editor.length > 0) console.log(`  ${describe("editeur    ", editor)}  (depuis l'ouverture du fichier)`);
}

async function main(): Promise<void> {
  console.log(`Demarrage - exe : ${exe} - ${runs} lancements par situation`);
  const cold: Sample[] = [];
  for (let run = 0; run < runs; run += 1) {
    cold.push(await measure({ webview: join(work, `webview-cold-${run}`), appData: join(work, `data-cold-${run}`), withProject: true }));
  }
  report("A. profil WebView2 neuf, avec un projet", cold);

  const shared = { webview: join(work, "webview-warm"), appData: join(work, "data-warm") };
  await measure({ ...shared, withProject: true }); // amorce le profil (non compte)
  const warm: Sample[] = [];
  for (let run = 0; run < runs; run += 1) warm.push(await measure({ ...shared, withProject: true }));
  report("B. profil deja utilise, avec un projet", warm);

  const welcome: Sample[] = [];
  for (let run = 0; run < runs; run += 1) welcome.push(await measure({ ...shared, withProject: false }));
  report("C. profil deja utilise, sans projet (ecran d'accueil)", welcome);

  const target = 3000;
  const worst = Math.max(...[...cold, ...warm, ...welcome].map((s) => s.interface));
  console.log(`\nCible : interface utilisable en moins de ${target} ms. Pire mesure : ${Math.round(worst)} ms -> ${worst < target ? "ATTEINTE" : "NON ATTEINTE"}.`);
  process.exitCode = worst < target ? 0 : 1;
}

try {
  await main();
} finally {
  rmSync(work, { recursive: true, force: true });
}
