/**
 * E2E Windows (WebView2) de l'application reelle : ouvre un projet, edite avec la vraie saisie clavier, enregistre,
 * verifie les octets sur le disque, simule un plantage et la recuperation, les modifications externes, la fermeture.
 *
 * Usage : pnpm exec tsx scripts/e2e/run.ts <chemin-de-l-exe-e2e> <dossier-de-captures>
 * L'executable doit avoir ete construit avec `--features e2e` (jamais une version distribuee).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialValues, NPC_TEMPLATES, renderTemplate, runWizard } from "@runeforge/npc-templates";
import { FLOW_NODE_WIDTH } from "@runeforge/visual-core";
import { Cdp, launch, sleep, type AppProcess } from "./cdp";
import { closeCompletion, describeSeries, measureCompletion, measureRoundTrips, summarize, ms, type CompletionLatency } from "./completion-latency";

const [exeArgument, outArgument] = process.argv.slice(2);
if (exeArgument === undefined || outArgument === undefined) {
  console.error("Usage : tsx scripts/e2e/run.ts <exe-e2e> <dossier-captures>");
  process.exit(2);
}
const exe: string = exeArgument;
const outDir: string = outArgument;
mkdirSync(outDir, { recursive: true });

const PORT = 9333;
const work = mkdtempSync(join(tmpdir(), "runeforge-e2e-"));
const project = join(work, "project");
const appData = join(work, "appdata");
const webview = join(work, "webview");
// Destination des deploiements de test : dans la construction de test, le coeur natif l'approuve sans boite de dialogue du systeme.
const destination = join(work, "destination");
mkdirSync(join(project, "npc"), { recursive: true });
mkdirSync(destination, { recursive: true });

const A_TXT = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';
const LEGACY = Buffer.from('prontera,1,1,0\tscript\tCaf\xe9\t100,{\r\n\tmes "caf\xe9";\r\n\tclose;\r\n}\r\n', "latin1");
const MIXED = 'prontera,2,2,0\tscript\tM\t100,{\r\n\tmes "a";\n\tclose;\r\n}\n';
const BAD = 'prontera,3,3,0\tscript\tB\t100,{\n\tmes "a"\n}\n';
const LABELS = 'prontera,4,4,0\tscript\tL\t100,{\n\tgoto L_Missing;\n\tclose;\n}\n';
const LIB = 'function\tscript\tF_Lib\t{\n\treturn;\n}\n';
const CALLER = 'prontera,5,5,0\tscript\tCaller\t100,{\n\tcallfunc "F_Lib";\n\tclose;\n}\n';
const MENU = 'prontera,6,6,0\tscript\tMenu\t100,{\n\tgoto L_Next;\nL_Next:\n\tclose;\n}\n';
writeFileSync(join(project, "npc", "a.txt"), A_TXT);
writeFileSync(join(project, "npc", "legacy.txt"), LEGACY);
writeFileSync(join(project, "npc", "mixed.txt"), MIXED);
writeFileSync(join(project, "npc", "bad.txt"), BAD);
writeFileSync(join(project, "npc", "labels.txt"), LABELS);
writeFileSync(join(project, "npc", "lib.txt"), LIB);
writeFileSync(join(project, "npc", "caller.txt"), CALLER);
writeFileSync(join(project, "npc", "menu.txt"), MENU);
writeFileSync(join(project, "readme.md"), "hello\n");

// Mini serveur rAthena redige pour ce test, dans un sous-dossier (detection automatique) : table des commandes, manuel,
// mode de compilation, liste des scripts charges. `F_Lib` (npc/lib.txt, hors du serveur) est appelee par son seul nom.
const SERVER_TABLE = ["struct script_function buildin_func[] = {", '\tBUILDIN_DEF(mes,"s*"),', '\tBUILDIN_DEF(close,""),', '\tBUILDIN_DEF(callfunc,"s*"),', '\tBUILDIN_DEF(getitem,"vi?"),', '\tBUILDIN_DEF(warp,"sii?"),', '\tBUILDIN_DEF(monster,"siisvi?????"),', "\t{nullptr,nullptr,nullptr},", "};", ""].join("\n");
const SERVER_MANUAL = ["=====", "|1.- Base.|", "=====", '*mes "<string>"{,"<string>"};', "", "Affiche une boite de dialogue.", "", "*close;", "", "Ferme la boite.", "", "*getitem <item id>,<amount>;", '*getitem "<item name>",<amount>;', "", "Donne un objet.", "", '*warp "<map name>",<x>,<y>;', "", "Envoie le joueur.", "", '*monster "<map name>",<x>,<y>,"<name to show>",<mob id>,<amount>;', "", "Fait apparaitre un monstre.", ""].join("\n");
const PROBE = 'prontera,7,7,0\tscript\tProbe\t100,{\n\tmes;\n\tInconnue 1;\n\tF_Lib;\n\tclose;\n}\n';
// Script d'essai de l'aide a la saisie : le code est deja ecrit, l'E2E ne fait que placer le curseur (aucune saisie, donc aucune
// modification du document).
const ASSIST = 'prontera,8,8,0\tscript\tAssist\t100,{\n\tme;\n\tmes "a", "b";\n\tclose;\n}\n';
// Bases du mini serveur (objets, monstres, cartes, constantes) et script qui les reference : la ligne 2 cite une carte inconnue,
// la 4 un objet inconnu, la 6 un monstre inconnu ; les lignes 3, 5 et 7 en citent de connus.
const ITEM_DB = ["Header:", "  Type: ITEM_DB", "  Version: 3", "Body:", "  - Id: 501", "    AegisName: Red_Potion", "    Name: Red Potion", "    Type: Healing", "  - Id: 502", "    AegisName: Orange_Potion", "    Name: Orange Potion", "    Type: Healing", ""].join("\n");
const MOB_DB = ["Header:", "  Type: MOB_DB", "  Version: 4", "Body:", "  - Id: 1002", "    AegisName: PORING", "    Name: Poring", "    Level: 1", ""].join("\n");
const MAP_INDEX = "// index des cartes de test\nprontera 1\nprt_fild08\n";
const SCRIPT_CONSTANTS = ["export_constant(Job_Alchemist);", 'export_parameter("BaseLevel",SP_BASELEVEL);', ""].join("\n");
// Quatre NPC : sur une carte chargee (rien), sur une carte de l'index que le serveur ne charge pas (RA0015, ligne 4), sur une carte
// inconnue de l'index (RA0008, ligne 7), et un NPC dont deux labels portent le nom d'une commande (`mes`, ligne 12) et d'une
// constante (`Job_Alchemist`, ligne 14) du mini serveur : le serveur refuse ces labels (RA0014).
const PLACED =
  'prontera,10,10,4\tscript\tOnLoaded\t100,{\n\tclose;\n}\nprt_fild08,10,10,4\tscript\tOnNotLoaded\t100,{\n\tclose;\n}\nnowhere,10,10,4\tscript\tOnUnknown\t100,{\n\tclose;\n}\n' +
  'prontera,11,11,4\tscript\tOnLabels\t100,{\n\tgoto mes;\nmes:\n\tclose;\nJob_Alchemist:\n\tclose;\n}\n';
const REFS =
  'prontera,9,9,0\tscript\tRefs\t100,{\n\twarp "nowhere",1,1;\n\twarp "prontera",1,1;\n\tgetitem 99999,1;\n\tgetitem 501,1;\n\tmonster "prontera",1,1,"x",9999,1;\n\tmonster "prontera",1,1,"x",1002,1;\n\tclose;\n}\n';
for (const directory of ["src/map", "src/config", "doc", "conf", "db", "npc/re"]) mkdirSync(join(project, "srv", directory), { recursive: true });
writeFileSync(join(project, "srv", "src", "map", "script.cpp"), SERVER_TABLE);
writeFileSync(join(project, "srv", "src", "config", "renewal.hpp"), "#define RENEWAL\n");
writeFileSync(join(project, "srv", "doc", "script_commands.txt"), SERVER_MANUAL);
// Le serveur charge prontera ; prt_fild08 est dans l'index des cartes (db/map_index.txt) mais en commentaire dans la liste des cartes.
writeFileSync(join(project, "srv", "conf", "map_athena.conf"), "// configuration de test\nimport: conf/maps_athena.conf\n");
writeFileSync(join(project, "srv", "conf", "maps_athena.conf"), "// cartes chargees par le serveur de test\nmap: prontera\n//map: prt_fild08\n");
writeFileSync(join(project, "srv", "npc", "re", "scripts_main.conf"), "npc: npc/re/probe.txt\n");
writeFileSync(join(project, "srv", "npc", "re", "probe.txt"), PROBE);
writeFileSync(join(project, "srv", "npc", "re", "assist.txt"), ASSIST);
writeFileSync(join(project, "srv", "npc", "re", "refs.txt"), REFS);
writeFileSync(join(project, "srv", "npc", "re", "placed.txt"), PLACED);
writeFileSync(join(project, "srv", "db", "item_db.yml"), ITEM_DB);
writeFileSync(join(project, "srv", "db", "mob_db.yml"), MOB_DB);
writeFileSync(join(project, "srv", "db", "map_index.txt"), MAP_INDEX);
writeFileSync(join(project, "srv", "src", "map", "script_constants.hpp"), SCRIPT_CONSTANTS);

const results: { name: string; ok: boolean; detail?: string }[] = [];
const session: { app: AppProcess | null; cdp: Cdp | null } = { app: null, cdp: null };

const E2E = "window.__RUNEFORGE_E2E__";
const state = (expression: string): string => `${E2E}.store.getState().${expression}`;

/** `E2E_ONLY=fragment` : ne joue que les etapes dont le nom contient ce fragment (mise au point d'une etape autonome ; jamais pour une validation). */
const ONLY = process.env["E2E_ONLY"];

async function step(name: string, run: () => Promise<void>): Promise<void> {
  if (ONLY !== undefined && !name.includes(ONLY)) return;
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail}`);
    if (session.cdp !== null) await session.cdp.screenshot(join(outDir, `FAIL-${results.length}.png`)).catch(() => undefined);
  }
}

function expectBytes(actual: Buffer, expected: Buffer, label: string): void {
  if (!actual.equals(expected)) {
    throw new Error(`${label} : octets differents\n   attendu ${JSON.stringify(expected.toString("latin1"))}\n   obtenu  ${JSON.stringify(actual.toString("latin1"))}`);
  }
}

function startApp(): void {
  session.app = launch({
    exe,
    port: PORT,
    webviewDataDir: webview,
    env: { RUNEFORGE_E2E_PROJECT: project, RUNEFORGE_E2E_DATA_DIR: appData, RUNEFORGE_E2E_DESTINATION: destination },
  });
}

async function connect(): Promise<Cdp> {
  const client = await Cdp.connect(PORT);
  await client.waitFor(`!!${E2E} && ${state("ready")} && ${state("project")} !== null`, "projet ouvert", 30_000);
  return client;
}

const ctrlKey = (client: Cdp, key: string, code: string, vk: number): Promise<void> =>
  client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers: 2, windowsVirtualKeyCode: vk }).then(() => client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: 2, windowsVirtualKeyCode: vk })).then(() => undefined);

const keyWith = (client: Cdp, modifiers: number, key: string, code: string, vk: number): Promise<void> =>
  client
    .send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, windowsVirtualKeyCode: vk })
    .then(() => client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: vk }))
    .then(() => undefined);
const shiftKey = (client: Cdp, key: string, code: string, vk: number): Promise<void> => keyWith(client, 8, key, code, vk);
const plainKey = (client: Cdp, key: string, code: string, vk: number): Promise<void> => keyWith(client, 0, key, code, vk);

/** Place le curseur de Monaco (API, hors du chemin teste) puis saisit du texte avec la vraie saisie. */
async function typeAt(client: Cdp, line: number, column: number, text: string): Promise<void> {
  await client.waitFor("!!document.querySelector('.monaco-editor')", "editeur Monaco monte", 15_000);
  await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: ${line}, column: ${column} }); editor.focus(); })()`);
  await client.insertText(text);
}

async function openByClick(client: Cdp, folder: string, file: string): Promise<void> {
  await client.evaluate(`(() => { const row = document.querySelector('[role=treeitem][title="${folder}"]'); if (row && row.getAttribute('aria-expanded') === 'false') row.click(); })()`);
  await client.waitFor(`!!document.querySelector('[role=treeitem][title="${folder}/${file}"]')`, `ligne ${folder}/${file}`);
  await client.evaluate(`document.querySelector('[role=treeitem][title="${folder}/${file}"]').click()`);
  await client.waitFor(`${state("activePath")} === "${folder}/${file}" && !!document.querySelector('.monaco-editor')`, `${file} ouvert dans Monaco`);
}

const isDirty = (path: string): string => `${state(`docs["${path}"]?.dirty`)} === true`;

/** Clic de souris reel (evenements d'entree du navigateur, donc avec activation utilisateur) au centre de l'element designe. */
async function realClick(client: Cdp, elementExpression: string, description: string, mayCloseToasts = true): Promise<void> {
  // `scrollIntoView` peut aussi decaler la page elle-meme (le `body` est en overflow: hidden mais reste defilable par programme) :
  // on la remet en haut a gauche avant de mesurer, puis on verifie que le centre est bien dans la fenetre.
  const center = await client.evaluate<{ x: number; y: number; visible: boolean; rect: string; covered: string | null; coveredByToast: boolean } | null>(
    `(() => { const element = ${elementExpression}; if (!element) return null; element.scrollIntoView({ block: "nearest", inline: "nearest" }); window.scrollTo(0, 0); document.documentElement.scrollLeft = 0; document.body.scrollLeft = 0; const r = element.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); const covered = top && !(top === element || element.contains(top)) ? top.tagName.toLowerCase() + '.' + String(top.className).slice(0, 40) + ' « ' + (top.textContent || '').slice(0, 60) + ' »' : null; return { x, y, visible: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight, rect: [r.left, r.top, r.width, r.height].map(Math.round).join(","), covered, coveredByToast: !!(top && top.closest('.toast')) }; })()`,
  );
  if (center === null) throw new Error(`element introuvable : ${description}`);
  if (!center.visible) {
    const layout = await client.evaluate<string>(
      `(() => { const box = (selector) => { const e = document.querySelector(selector); if (!e) return selector + ": absent"; const r = e.getBoundingClientRect(); return selector + ": x=" + Math.round(r.left) + " w=" + Math.round(r.width) + " scrollW=" + e.scrollWidth + " clientW=" + e.clientWidth; }; const wide = [...document.querySelectorAll('.report *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName.toLowerCase() + "." + e.className + " right=" + Math.round(e.getBoundingClientRect().right)); return ["inner=" + innerWidth, "doc=" + document.documentElement.scrollWidth, box(".workbench"), box(".workbench-body"), box(".workbench-main"), box(".editor-area"), box(".bottom-panel"), box(".report"), box(".report .problems-header"), "larges: " + wide.join(" | ")].join("\\n          "); })()`,
    );
    throw new Error(`element hors de la fenetre : ${description} (${center.rect})\n          ${layout}`);
  }
  if (center.covered !== null) {
    // Une notification qui gene se ferme d'un clic sur sa croix : un utilisateur ferait de meme. Tout autre element qui recouvre reste un defaut.
    if (center.coveredByToast && mayCloseToasts) {
      await closeToasts(client);
      return realClick(client, elementExpression, description, false);
    }
    throw new Error(`element recouvert : ${description} (${center.rect}) est cache par ${center.covered}`);
  }
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1 });
}

/** Glisser a la souris (evenements d'entree reels) : appui en `from`, deplacements par etapes jusqu'a `to`, relachement. */
async function realDrag(client: Cdp, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10): Promise<void> {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= steps; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
}

/** Centre (dans la fenetre) d'un element, qui doit y etre entierement visible. */
async function centerOf(client: Cdp, elementExpression: string, description: string): Promise<{ x: number; y: number }> {
  const point = await client.evaluate<{ x: number; y: number; visible: boolean } | null>(
    `(() => { const e = ${elementExpression}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`,
  );
  if (point === null) throw new Error(`element introuvable : ${description}`);
  if (!point.visible) throw new Error(`element hors de la fenetre : ${description}`);
  return { x: point.x, y: point.y };
}

/** Ferme les notifications a l'ecran, une par une, par un vrai clic sur leur croix. */
async function closeToasts(client: Cdp): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    const count = await client.evaluate<number>(`document.querySelectorAll('.toast').length`);
    if (count === 0) return;
    await realClick(client, `document.querySelector('.toast .icon-button')`, "croix d'une notification", false);
    await client.waitFor(`document.querySelectorAll('.toast').length < ${count}`, "fermeture d'une notification", 3000);
  }
}

/** Texte courant du modele Monaco du document `path` (`null` s'il n'a pas de modele). */
const modelTextOf = (client: Cdp, path: string): Promise<string | null> =>
  client.evaluate<string | null>(`(async () => { const monaco = await ${E2E}.monaco(); const model = monaco.editor.getModels().find((m) => m.uri.path === "/${path}"); return model ? model.getValue() : null; })()`);

/** Attend que le modele Monaco de `path` contienne exactement `expected`. */
async function waitModelText(client: Cdp, path: string, expected: string, description: string): Promise<void> {
  const started = Date.now();
  let last: string | null = null;
  while (Date.now() - started < 10_000) {
    last = await modelTextOf(client, path);
    if (last === expected) return;
    await sleep(100);
  }
  throw new Error(`${description} : ${JSON.stringify(last)} au lieu de ${JSON.stringify(expected)}`);
}

/** Ligne et colonne (base 1) de la premiere occurrence de `needle` dans `source`. */
function positionIn(source: string, needle: string): string {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`"${needle}" absent du fichier de test`);
  const before = source.slice(0, offset).split("\n");
  return `${before.length}:${(before[before.length - 1] ?? "").length + 1}`;
}

async function main(): Promise<void> {
  console.log(`E2E - exe : ${exe}`);
  startApp();
  session.cdp = await connect();
  const client = session.cdp;

  await step("l'application demarre avec le projet de test et affiche l'explorateur", async () => {
    const info = await client.evaluate<{ fileCount: number; name: string }>(`({ fileCount: ${state("project.fileCount")}, name: ${state("project.name")} })`);
    if (info.fileCount !== 23) throw new Error(`23 fichiers attendus, ${info.fileCount} trouves`);
    await client.screenshot(join(outDir, "01-workbench.png"));
  });

  await step("le projet est indexe en arriere-plan par le worker (fichiers, fonctions, noms de NPC)", async () => {
    await client.waitFor(`${state("indexing.status")} === "done"`, "fin de l'indexation du projet", 30_000);
    const indexing = await client.evaluate<{ files: number; functions: number; npcs: number; skipped: number }>(`${state("indexing")}`);
    // 14 fichiers .txt (8 dans npc/, le manuel, l'index des cartes et les quatre scripts du mini serveur ; readme.md, les .cpp, .hpp,
    // .yml et .conf sont exclus par `sources`), 1 fonction globale, 14 NPC ; aucun fichier ignore.
    if (indexing.files !== 14 || indexing.functions !== 1 || indexing.npcs !== 14 || indexing.skipped !== 0) {
      throw new Error(`index inattendu : ${JSON.stringify(indexing)}`);
    }
    const label = await client.evaluate<string>(`document.querySelector('.status-index')?.textContent ?? ''`);
    if (!/14/.test(label)) throw new Error(`indicateur d'indexation inattendu : ${label}`);
  });

  await step("ouvre un fichier par clic dans l'explorateur et l'affiche dans Monaco", async () => {
    await openByClick(client, "npc", "a.txt");
    const text = await client.evaluate<string>(`${E2E}.controller.getManager().textOf("npc/a.txt")`);
    if (text !== A_TXT) throw new Error(`contenu inattendu : ${JSON.stringify(text)}`);
    const tokens = await client.evaluate<number>(`document.querySelectorAll('.monaco-editor .view-line span span[class*="mtk"]').length`);
    if (tokens < 5) throw new Error("coloration syntaxique absente");
  });

  await step("saisie clavier reelle + Ctrl+S : seul le texte ajoute change sur le disque (octets exacts)", async () => {
    await typeAt(client, 3, 8, " // ajoute");
    await client.waitFor(isDirty("npc/a.txt"), "document marque modifie");
    await ctrlKey(client, "s", "KeyS", 83);
    await client.waitFor(`${state('docs["npc/a.txt"]?.dirty')} === false`, "document enregistre");
    expectBytes(readFileSync(join(project, "npc", "a.txt")), Buffer.from(A_TXT.replace("close;", "close; // ajoute")), "a.txt");
  });

  await step("fichier en encodage herite (windows-1252, CRLF) : octets non modifies preserves", async () => {
    await openByClick(client, "npc", "legacy.txt");
    const info = await client.evaluate<{ encoding: string; eol: string }>(`${state('docs["npc/legacy.txt"]')}`);
    if (info.encoding !== "windows-1252" || info.eol !== "CRLF") throw new Error(`detection incorrecte : ${JSON.stringify(info)}`);
    await typeAt(client, 2, 14, " // note");
    await ctrlKey(client, "s", "KeyS", 83);
    await client.waitFor(`${state('docs["npc/legacy.txt"]?.dirty')} === false`, "legacy enregistre");
    expectBytes(readFileSync(join(project, "npc", "legacy.txt")), Buffer.from(LEGACY.toString("latin1").replace('mes "caf\xe9";', 'mes "caf\xe9"; // note'), "latin1"), "legacy.txt");
  });

  await step("fichier a fins de ligne mixtes : les lignes inchangees gardent leur fin de ligne", async () => {
    await openByClick(client, "npc", "mixed.txt");
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setSelection({ startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 8 }); editor.focus(); })()`);
    await client.insertText("b");
    await ctrlKey(client, "s", "KeyS", 83);
    await client.waitFor(`${state('docs["npc/mixed.txt"]?.dirty')} === false`, "mixed enregistre");
    expectBytes(readFileSync(join(project, "npc", "mixed.txt")), Buffer.from(MIXED.replace('mes "a"', 'mes "b"')), "mixed.txt");
  });

  await step("un fichier avec une erreur de syntaxe affiche un marqueur et une entree dans le panneau des problemes", async () => {
    await openByClick(client, "npc", "bad.txt");
    await client.waitFor(`(${state('diagnostics["npc/bad.txt"]?.diagnostics?.length')} ?? 0) > 0`, "diagnostics calcules par le worker", 20_000);
    await client.waitFor(`document.querySelectorAll('.monaco-editor .squiggly-error').length > 0`, "soulignement d'erreur dans l'editeur");
    await ctrlKey(client, "j", "KeyJ", 74);
    await client.waitFor(`!!document.querySelector('.problems .problem-error')`, "ligne du panneau des problemes");
    const row = await client.evaluate<string>(`document.querySelector('.problems .problem-error .problem-meta').textContent`);
    if (!row.includes("RS0020") || !row.includes("npc/bad.txt:2")) throw new Error(`ligne inattendue : ${row}`);
    await client.screenshot(join(outDir, "02-problems.png"));
  });

  await step("une erreur semantique (label inconnu) est signalee dans l'editeur et le panneau des problemes", async () => {
    await openByClick(client, "npc", "labels.txt");
    await client.waitFor(`(${state('diagnostics["npc/labels.txt"]?.diagnostics?.length')} ?? 0) > 0`, "diagnostics semantiques calcules par le worker", 20_000);
    const codes = await client.evaluate<string[]>(`${state('diagnostics["npc/labels.txt"].diagnostics')}.map((d) => d.code)`);
    if (codes.join(",") !== "RA0002") throw new Error(`diagnostics inattendus : ${codes.join(",")}`);
    await client.waitFor(`document.querySelectorAll('.monaco-editor .squiggly-error').length > 0`, "soulignement d'erreur dans l'editeur");
    await client.waitFor(
      `[...document.querySelectorAll('.problems .problem-meta')].some((e) => e.textContent.includes('RA0002') && e.textContent.includes('npc/labels.txt:2'))`,
      "ligne RA0002 dans le panneau des problemes",
    );
    await client.screenshot(join(outDir, "02b-semantic.png"));
  });

  await step("F12 (vraie touche, fournisseur Monaco) ouvre le fichier de la fonction globale", async () => {
    await openByClick(client, "npc", "caller.txt");
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 2, column: 14 }); editor.focus(); })()`);
    await plainKey(client, "F12", "F12", 123);
    await client.waitFor(`${state("activePath")} === "npc/lib.txt"`, "navigation vers la definition", 15_000);
    await client.waitFor(`${state("cursor.line")} === 1 && ${state("cursor.column")} === 17`, "curseur sur le nom de la fonction");
  });

  await step("Maj+F12 liste les references dans le panneau du bas (appel callfunc + definition)", async () => {
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 1, column: 18 }); editor.focus(); })()`);
    await shiftKey(client, "F12", "F12", 123);
    await client.waitFor(`document.querySelectorAll('.references .reference').length === 2`, "deux references affichees", 15_000);
    const metas = await client.evaluate<string[]>(`[...document.querySelectorAll('.references .reference .problem-meta')].map((element) => element.textContent)`);
    if (metas.join("|") !== "npc/caller.txt:2:11|npc/lib.txt:1:17") throw new Error(`references inattendues : ${metas.join("|")}`);
    const preview = await client.evaluate<string>(`document.querySelector('.references .reference .reference-preview').textContent`);
    if (preview !== 'callfunc "F_Lib";') throw new Error(`extrait inattendu : ${preview}`);
    await client.screenshot(join(outDir, "02c-references.png"));
    await client.evaluate(`document.querySelector('.references .reference').click()`);
    await client.waitFor(`${state("activePath")} === "npc/caller.txt" && ${state("cursor.line")} === 2`, "ouverture d'une reference");
  });

  await step("Ctrl+T cherche un symbole dans tout le projet et ouvre sa definition", async () => {
    await ctrlKey(client, "t", "KeyT", 84);
    await client.waitFor(`!!document.querySelector('.palette-input')`, "palette ouverte");
    await client.insertText("lib");
    await client.waitFor(`[...document.querySelectorAll('.palette-item')].some((item) => item.textContent.includes('F_Lib') && item.textContent.includes('npc/lib.txt'))`, "resultat F_Lib");
    await client.screenshot(join(outDir, "02d-symbols.png"));
    await plainKey(client, "Enter", "Enter", 13);
    await client.waitFor(`${state("activePath")} === "npc/lib.txt" && ${state("cursor.line")} === 1 && ${state("cursor.column")} === 17`, "ouverture de la definition");
    await client.waitFor(`!document.querySelector('.palette-input')`, "palette fermee");
  });

  await step("Ctrl+Espace dans callfunc \"F_ propose la fonction du projet (completion Monaco reelle)", async () => {
    await openByClick(client, "npc", "caller.txt");
    // Curseur apres `F_` dans `callfunc "F_Lib";` (ligne 2, colonne 14).
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 2, column: 14 }); editor.focus(); })()`);
    await ctrlKey(client, " ", "Space", 32);
    await client.waitFor(
      `[...document.querySelectorAll('.suggest-widget .monaco-list-row')].some((row) => row.textContent.includes('F_Lib'))`,
      "proposition F_Lib dans la liste de completion",
      15_000,
    );
    await sleep(600); // laisse finir l'animation d'apparition avant la capture
    // Le libelle de la proposition doit etre dans la ligne (un style global de l'application l'avait deja fait passer a la ligne
    // suivante, donc masque, alors que le texte etait present dans le DOM).
    const geometry = await client.evaluate<{ found: boolean; inside: boolean; text: string }>(
      `(() => { const row = document.querySelector('.suggest-widget .monaco-list-row.focused'); const label = row?.querySelector('.label-name'); if (!row || !label) return { found: false, inside: false, text: '' }; const a = row.getBoundingClientRect(); const b = label.getBoundingClientRect(); return { found: true, inside: b.width > 0 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1, text: label.textContent }; })()`,
    );
    if (!geometry.found || !geometry.inside || geometry.text !== "F_Lib") throw new Error(`proposition masquee ou absente : ${JSON.stringify(geometry)}`);
    await client.screenshot(join(outDir, "02e-completion.png"));
    await plainKey(client, "Escape", "Escape", 27);
    await client.waitFor(`![...document.querySelectorAll('.suggest-widget')].some((widget) => widget.classList.contains('visible'))`, "liste de completion fermee");
    if (readFileSync(join(project, "npc", "caller.txt"), "utf8") !== CALLER) throw new Error("le fichier a ete modifie par la completion");
  });

  await step("le survol d'une fonction affiche sa definition et le nombre d'appels", async () => {
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 2, column: 14 }); editor.focus(); editor.trigger("e2e", "editor.action.showHover", {}); })()`);
    await client.waitFor(`[...document.querySelectorAll('.monaco-hover')].some((hover) => hover.textContent.includes('global function'))`, "survol de la fonction", 15_000);
    const text = await client.evaluate<string>(`[...document.querySelectorAll('.monaco-hover')].map((hover) => hover.textContent).join(' | ')`);
    if (!text.includes("npc/lib.txt:1") || !text.includes("1 call(s)")) throw new Error(`survol inattendu : ${text}`);
    await sleep(600);
    await client.screenshot(join(outDir, "02f-hover.png"));
    await plainKey(client, "Escape", "Escape", 27);
  });

  await step("F2 renomme un label et toutes ses references ; l'enregistrement ecrit le fichier attendu", async () => {
    await openByClick(client, "npc", "menu.txt");
    // Curseur dans `goto L_Next;` (ligne 2, colonne 10) : F2 ouvre la zone de renommage sur le label.
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 2, column: 10 }); editor.focus(); })()`);
    await plainKey(client, "F2", "F2", 113);
    await client.waitFor(`!!document.querySelector('.rename-input')`, "zone de renommage", 15_000);
    // Le champ est rempli une fois la reponse du service recue (resolveRenameLocation).
    await client.waitFor(`document.querySelector('.rename-input')?.value === "L_Next"`, "nom actuel propose dans la zone de renommage", 15_000);
    // Focus et selection explicites du champ : ceux de Monaco sont poses apres le rendu, et `Input.insertText` ecrit dans
    // l'element qui a le focus (sans cela, la saisie pouvait aller dans l'editeur : course observee une fois sur deux).
    await client.evaluate(`(() => { const input = document.querySelector('.rename-input'); input.focus(); input.select(); })()`);
    await client.waitFor(`document.activeElement === document.querySelector('.rename-input')`, "focus dans la zone de renommage");
    await client.insertText("L_After");
    await client.waitFor(`document.querySelector('.rename-input')?.value === "L_After"`, "nouveau nom saisi dans la zone de renommage");
    await plainKey(client, "Enter", "Enter", 13);
    const expected = MENU.replaceAll("L_Next", "L_After");
    await client.waitFor(`${E2E}.controller.getManager().textOf("npc/menu.txt") === ${JSON.stringify(expected)}`, "label renomme partout", 15_000);
    await ctrlKey(client, "s", "KeyS", 83);
    await client.waitFor(`${state('docs["npc/menu.txt"]?.dirty')} === false`, "menu.txt enregistre");
    expectBytes(readFileSync(join(project, "npc", "menu.txt")), Buffer.from(expected), "menu.txt");
  });

  await step("F2 sur un symbole non renommable (nom de NPC) est refuse avec une explication", async () => {
    // `prontera,6,6,0<tab>script<tab>Menu` : curseur dans « Menu » (ligne 1, colonne 24).
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 1, column: 24 }); editor.focus(); })()`);
    await plainKey(client, "F2", "F2", 113);
    await client.waitFor(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some((message) => message.textContent.includes('cannot be renamed'))`, "message de refus", 15_000);
    const opened = await client.evaluate<boolean>(
      `(() => { const box = document.querySelector('.rename-box'); if (!box) return false; const style = getComputedStyle(box); return style.visibility !== 'hidden' && style.display !== 'none' && box.getBoundingClientRect().width > 0; })()`,
    );
    if (opened) throw new Error("la zone de renommage s'est ouverte sur un symbole non renommable");
    await plainKey(client, "Escape", "Escape", 27);
  });

  await step("le serveur du sous-dossier est reconnu et son registre de commandes lu dans son code source (barre d'etat)", async () => {
    await client.waitFor(`${state("emulator.status")} === "ready"`, "serveur reconnu", 20_000);
    const emulator = await client.evaluate<{ root: string; detected: boolean; level: string; commands: number; withArity: number; renewal: boolean; renewalSource: string }>(`${state("emulator")}`);
    if (emulator.root !== "srv" || !emulator.detected || emulator.level !== "server-source" || emulator.commands !== 6 || emulator.withArity !== 6 || emulator.renewal !== true || emulator.renewalSource !== "header") {
      throw new Error(`serveur inattendu : ${JSON.stringify(emulator)}`);
    }
    const view = await client.evaluate<{ text: string; title: string; attention: string | null }>(
      `(() => { const item = document.querySelector('.status-server'); return { text: item?.textContent ?? '', title: item?.getAttribute('title') ?? '', attention: item?.getAttribute('data-attention') ?? null }; })()`,
    );
    if (view.text !== "6 commands" || view.attention !== "false" || !view.title.includes("Server folder: srv (detected)") || !view.title.includes("renewal mode")) {
      throw new Error(`barre d'etat inattendue : ${JSON.stringify(view)}`);
    }
    await client.screenshot(join(outDir, "02g-server-status.png"));
  });

  await step("une commande inconnue et un nombre d'arguments faux sont signales (RA0001, RA0006) ; une fonction du projet ne l'est pas comme commande inconnue, mais comme fonction que le serveur ne charge pas (RA0016)", async () => {
    await client.evaluate(`${E2E}.controller.openFile("srv/npc/re/probe.txt")`);
    await client.waitFor(`${state("activePath")} === "srv/npc/re/probe.txt" && !!document.querySelector('.monaco-editor')`, "probe ouvert dans Monaco", 15_000);
    // RA0006 sur `mes;` (ligne 2), RA0001 sur `Inconnue` (ligne 3). `F_Lib;` (ligne 4) est une fonction du projet : ce n'est pas une
    // commande inconnue ; mais `npc/lib.txt`, qui la definit, n'est dans aucune liste de scripts de ce serveur : il ne la chargera jamais (RA0016).
    await client.waitFor(`(${state('diagnostics["srv/npc/re/probe.txt"]?.diagnostics')} ?? []).map((d) => d.code).join() === "RA0006,RA0001,RA0016"`, "diagnostics de commande calcules par le worker", 20_000);
    const found = await client.evaluate<{ code: string; severity: string; confidence: string; text: string }[]>(
      `${state('diagnostics["srv/npc/re/probe.txt"].diagnostics')}.map((d) => ({ code: d.code, severity: d.severity, confidence: d.confidence, text: ${E2E}.controller.getManager().textOf("srv/npc/re/probe.txt").slice(d.range.start, d.range.end) }))`,
    );
    if (found.map((d) => d.text).join() !== "mes,Inconnue,F_Lib") throw new Error(`diagnostics inattendus : ${JSON.stringify(found)}`);
    if (found[1]?.severity !== "warning" || found[1]?.confidence !== "unknown") throw new Error(`RA0001 mal classee : ${JSON.stringify(found[1])}`);
    if (found[2]?.severity !== "error" || found[2]?.confidence !== "probable") throw new Error(`RA0016 mal classee : ${JSON.stringify(found[2])}`);
    await client.waitFor(`document.querySelectorAll('.monaco-editor .squiggly-warning').length >= 2 && document.querySelectorAll('.monaco-editor .squiggly-error').length >= 1`, "soulignements d'avertissement et d'erreur dans l'editeur");
    await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
    await client.waitFor(
      `(() => { const rows = [...document.querySelectorAll('.problems .problem')].map((e) => e.textContent); return rows.some((t) => t.includes('RA0006') && t.includes('srv/npc/re/probe.txt:2')) && rows.some((t) => t.includes('RA0001') && t.includes('srv/npc/re/probe.txt:3')) && rows.some((t) => t.includes('RA0016') && t.includes('srv/npc/re/probe.txt:4') && t.includes("before the server has loaded it")); })()`,
      "lignes RA0006, RA0001 et RA0016 dans le panneau des problemes",
    );
    await client.screenshot(join(outDir, "02h-commands.png"));
    if (readFileSync(join(project, "srv", "npc", "re", "probe.txt"), "utf8") !== PROBE) throw new Error("le fichier a ete modifie par l'analyse");
  });

  await step("Ctrl+Espace apres « me » propose la commande mes, avec sa signature et l'aide de la bibliotheque integree (completion Monaco reelle)", async () => {
    await client.evaluate(`${E2E}.controller.openFile("srv/npc/re/assist.txt")`);
    await client.waitFor(`${state("activePath")} === "srv/npc/re/assist.txt" && !!document.querySelector('.monaco-editor')`, "assist ouvert dans Monaco", 15_000);
    // Curseur apres `me` (ligne 2, colonne 4) : un debut d'instruction.
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 2, column: 4 }); editor.focus(); })()`);
    const firstLatency = await measureCompletion(client, "mes");
    await sleep(600);
    const row = await client.evaluate<{ found: boolean; inside: boolean; text: string }>(
      `(() => { const row = document.querySelector('.suggest-widget .monaco-list-row.focused'); const label = row?.querySelector('.label-name'); if (!row || !label) return { found: false, inside: false, text: '' }; const a = row.getBoundingClientRect(); const b = label.getBoundingClientRect(); return { found: true, inside: b.width > 0 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1, text: label.textContent }; })()`,
    );
    if (!row.found || !row.inside || row.text !== "mes") throw new Error(`proposition masquee ou absente : ${JSON.stringify(row)}`);
    // Un second Ctrl+Espace ouvre le panneau d'aide : il recoit l'aide de la bibliotheque integree a la selection.
    await ctrlKey(client, " ", "Space", 32);
    await client.waitFor(
      `[...document.querySelectorAll('.suggest-details')].some((panel) => panel.textContent.includes('This command will display a box on the screen') && panel.textContent.includes('1 argument(s) or more.'))`,
      "aide de la commande dans le panneau de details",
      15_000,
    );
    await sleep(400);
    await client.screenshot(join(outDir, "02i-command-completion.png"));
    await plainKey(client, "Escape", "Escape", 27);
    await client.waitFor(`![...document.querySelectorAll('.suggest-widget')].some((widget) => widget.classList.contains('visible'))`, "liste de completion fermee");
    if (readFileSync(join(project, "srv", "npc", "re", "assist.txt"), "utf8") !== ASSIST) throw new Error("le fichier a ete modifie par la completion");
    if ((await client.evaluate<boolean>(`${state('docs["srv/npc/re/assist.txt"].dirty')}`)) !== false) throw new Error("le document est marque modifie");
    // Latence percue dans l'application reelle : la premiere liste (a froid, ci-dessus), puis neuf autres (a chaud).
    const warm: CompletionLatency[] = [];
    for (let index = 0; index < 9; index += 1) {
      warm.push(await measureCompletion(client, "mes"));
      await closeCompletion(client);
    }
    for (const line of describeSeries(firstLatency, warm)) console.log(`        ${line}`);
    // Part du controleur (appel -> Worker -> service -> reponse), sans Monaco : situe ou le temps est passe.
    const trips = await measureRoundTrips(client, `${E2E}.controller`, "srv/npc/re/assist.txt", 2, 4, 10);
    const trip = summarize(trips.times);
    console.log(`        dont controleur -> Worker -> service -> reponse (sans Monaco, 10 appels, ${trips.items} proposition(s)) : min ${ms(trip.min)} / mediane ${ms(trip.median)} / max ${ms(trip.max)} ms`);
    writeFileSync(join(outDir, "completion-latency.json"), JSON.stringify({ first: firstLatency, warm, roundTrips: trips.times }, null, 2));
    // Bornes larges (le test ne doit pas dependre de la machine) : les valeurs mesurees sont consignees dans docs/PERFORMANCE.md.
    const shown = summarize(warm.map((sample) => sample.shown));
    if (shown.median > 250 || shown.max > 2000 || trip.median > 50) throw new Error(`latence de completion anormale : ${JSON.stringify({ firstLatency, warm, roundTrips: trips.times })}`);
  });

  await step("Ctrl+Maj+Espace dans `mes \"a\", ` affiche la signature et met en evidence le deuxieme parametre", async () => {
    // Ligne 3 `\tmes "a", "b";`, curseur apres la virgule et l'espace (colonne 11).
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 3, column: 11 }); editor.focus(); })()`);
    await keyWith(client, 2 | 8, " ", "Space", 32);
    await client.waitFor(`[...document.querySelectorAll('.parameter-hints-widget')].some((widget) => widget.classList.contains('visible') && widget.textContent.includes('mes'))`, "aide de signature affichee", 15_000);
    await sleep(500);
    const hint = await client.evaluate<{ label: string; active: string; text: string }>(
      `(() => { const widget = [...document.querySelectorAll('.parameter-hints-widget')].find((w) => w.classList.contains('visible')); return { label: widget?.querySelector('.signature')?.textContent ?? '', active: widget?.querySelector('.parameter.active')?.textContent ?? '', text: widget?.textContent ?? '' }; })()`,
    );
    if (!hint.label.includes('mes "<string>"')) throw new Error(`signature inattendue : ${JSON.stringify(hint)}`);
    if (hint.active !== '"<string>"') throw new Error(`parametre actif inattendu : ${JSON.stringify(hint)}`);
    if (!hint.text.includes("1 argument(s) or more.")) throw new Error(`documentation absente de l'aide : ${JSON.stringify(hint)}`);
    await client.screenshot(join(outDir, "02j-signature-help.png"));
    await plainKey(client, "Escape", "Escape", 27);
  });

  await step("le survol d'une commande affiche sa signature, son nombre d'arguments, l'aide de la bibliotheque integree et sa provenance", async () => {
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 3, column: 3 }); editor.focus(); editor.trigger("e2e", "editor.action.showHover", {}); })()`);
    await client.waitFor(`[...document.querySelectorAll('.monaco-hover')].some((hover) => hover.textContent.includes('rAthena command'))`, "survol de la commande", 15_000);
    const text = await client.evaluate<string>(`[...document.querySelectorAll('.monaco-hover')].map((hover) => hover.textContent).join(' | ')`);
    for (const expected of ['mes "<string>"', "1 argument(s) or more.", "This command will display a box on the screen", "rAthena built-in library", "src/map/script.cpp:", "doc/script_commands.txt:"]) {
      if (!text.includes(expected)) throw new Error(`survol incomplet (manque « ${expected} ») : ${text}`);
    }
    await sleep(600);
    await client.screenshot(join(outDir, "02k-command-hover.png"));
    await plainKey(client, "Escape", "Escape", 27);
    if (readFileSync(join(project, "srv", "npc", "re", "assist.txt"), "utf8") !== ASSIST) throw new Error("le fichier a ete modifie");
  });

  await step("action rapide (Ctrl+.) sur une commande inconnue : la declarer comme commande du projet ecrit project.json et supprime l'alerte", async () => {
    await client.evaluate(`${E2E}.controller.openFile("srv/npc/re/probe.txt")`);
    await client.waitFor(`${state("activePath")} === "srv/npc/re/probe.txt" && !!document.querySelector('.monaco-editor')`, "probe ouvert dans Monaco", 15_000);
    await client.waitFor(`(${state('diagnostics["srv/npc/re/probe.txt"]?.diagnostics?.length')} ?? 0) > 0`, "diagnostics de probe", 20_000);
    if (existsSync(join(project, ".runeforge", "project.json"))) throw new Error("project.json existe deja : l'etat de depart de l'etape est faux");
    // Curseur dans « Inconnue » (ligne 3, colonne 4).
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 3, column: 4 }); editor.focus(); })()`);
    await ctrlKey(client, ".", "Period", 190);
    await client.waitFor(
      `[...document.querySelectorAll('.action-widget .monaco-list-row')].some((row) => row.textContent.includes("Declare 'Inconnue' as a custom command of the project"))`,
      "action rapide proposee",
      15_000,
    );
    await sleep(400);
    await client.screenshot(join(outDir, "02l-quick-fix.png"));
    await plainKey(client, "Enter", "Enter", 13);
    // L'ecriture de project.json est une action explicite de l'utilisateur (l'action rapide).
    const started = Date.now();
    let written = "";
    while (Date.now() - started < 20_000) {
      try {
        written = readFileSync(join(project, ".runeforge", "project.json"), "utf8");
      } catch {
        written = "";
      }
      if (written.includes("Inconnue")) break;
      await sleep(250);
    }
    const config = JSON.parse(written === "" ? "{}" : written) as { commands?: { custom?: { name: string }[] } };
    if (config.commands?.custom?.map((command) => command.name).join() !== "Inconnue") throw new Error(`project.json inattendu : ${written}`);
    // Il reste `RA0006` (`mes;`) et `RA0016` (`F_Lib;` est definie hors des listes de scripts du serveur) : plus de commande inconnue.
    await client.waitFor(`${state('diagnostics["srv/npc/re/probe.txt"].diagnostics')}.map((d) => d.code).join() === "RA0006,RA0016"`, "plus d'alerte de commande inconnue", 30_000);
    // Le survol la decrit comme commande du projet, sans arite verifiee.
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 3, column: 4 }); editor.focus(); editor.trigger("e2e", "editor.action.showHover", {}); })()`);
    await client.waitFor(`[...document.querySelectorAll('.monaco-hover')].some((hover) => hover.textContent.includes('custom command (project)'))`, "survol de la commande personnalisee", 15_000);
    const hover = await client.evaluate<string>(`[...document.querySelectorAll('.monaco-hover')].map((element) => element.textContent).join(' | ')`);
    if (!hover.includes("Argument count not declared")) throw new Error(`survol inattendu : ${hover}`);
    await sleep(500);
    await client.screenshot(join(outDir, "02m-custom-command.png"));
    await plainKey(client, "Escape", "Escape", 27);
    if (readFileSync(join(project, "srv", "npc", "re", "probe.txt"), "utf8") !== PROBE) throw new Error("probe.txt a ete modifie");
  });

  await step("npc-sc puis Entree dans un fichier vide insere le modele de NPC (snippet Monaco) : script enregistre tel quel, sans diagnostic", async () => {
    const template = NPC_TEMPLATES.find((candidate) => candidate.id === "npc-script");
    if (template === undefined) throw new Error("modele npc-script absent");
    const expected = renderTemplate(template);
    await client.evaluate(`${E2E}.controller.createFile("srv/npc/re/new.txt")`);
    await client.waitFor(`${state("activePath")} === "srv/npc/re/new.txt" && !!document.querySelector('.monaco-editor')`, "nouveau fichier ouvert dans Monaco", 15_000);
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); })()`);
    await client.insertText("npc-sc");
    const listed = `[...document.querySelectorAll('.suggest-widget .monaco-list-row')].some((row) => row.textContent.includes('npc-script'))`;
    try {
      await client.waitFor(listed, "liste ouverte par la frappe", 3_000);
    } catch {
      await ctrlKey(client, " ", "Space", 32);
      await client.waitFor(listed, "proposition npc-script dans la liste", 15_000);
    }
    await sleep(500);
    const row = await client.evaluate<{ found: boolean; inside: boolean; text: string }>(
      `(() => { const row = document.querySelector('.suggest-widget .monaco-list-row.focused'); const label = row?.querySelector('.label-name'); if (!row || !label) return { found: false, inside: false, text: '' }; const a = row.getBoundingClientRect(); const b = label.getBoundingClientRect(); return { found: true, inside: b.width > 0 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1, text: label.textContent }; })()`,
    );
    if (!row.found || !row.inside || row.text !== "npc-script") throw new Error(`proposition masquee ou absente : ${JSON.stringify(row)}`);
    await client.screenshot(join(outDir, "02n-template-completion.png"));
    await plainKey(client, "Enter", "Enter", 13);
    await client.waitFor(`${E2E}.controller.getManager().textOf("srv/npc/re/new.txt") === ${JSON.stringify(expected)}`, "modele insere tel quel (valeurs par defaut)", 15_000);
    await sleep(400);
    await client.screenshot(join(outDir, "02o-template-inserted.png"));
    await ctrlKey(client, "s", "KeyS", 83);
    await client.waitFor(`${state('docs["srv/npc/re/new.txt"]?.dirty')} === false`, "nouveau fichier enregistre");
    expectBytes(readFileSync(join(project, "srv", "npc", "re", "new.txt")), Buffer.from(expected), "new.txt");
    await client.waitFor(`!!${state('diagnostics["srv/npc/re/new.txt"]')}`, "diagnostics du nouveau fichier", 20_000);
    const codes = await client.evaluate<string[]>(`${state('diagnostics["srv/npc/re/new.txt"].diagnostics')}.map((d) => d.code)`);
    if (codes.length > 0) throw new Error(`le modele produit des diagnostics : ${codes.join(",")}`);
  });

  await step("bases du serveur : une carte, un objet et un monstre introuvables sont signales (information), pas ceux qui existent", async () => {
    await client.evaluate(`${E2E}.controller.openFile("srv/npc/re/refs.txt")`);
    await client.waitFor(`${state("activePath")} === "srv/npc/re/refs.txt" && !!document.querySelector('.monaco-editor')`, "refs ouvert dans Monaco", 15_000);
    await client.waitFor(`${state("emulator.catalog")} !== null`, "bases du serveur lues", 20_000);
    const catalog = await client.evaluate<{ items: number; mobs: number; maps: number; constants: number }>(`${state("emulator.catalog")}`);
    if (catalog.items !== 2 || catalog.mobs !== 1 || catalog.maps !== 2 || catalog.constants !== 2) throw new Error(`bases inattendues : ${JSON.stringify(catalog)}`);
    const tooltip = await client.evaluate<string>(`document.querySelector('.status-server')?.getAttribute('title') ?? ''`);
    if (!tooltip.includes("Databases: 2 items, 1 monsters, 2 maps, 2 constants.")) throw new Error(`info-bulle de la barre d'etat sans les bases : ${tooltip}`);
    await client.waitFor(`(${state('diagnostics["srv/npc/re/refs.txt"]?.diagnostics')} ?? []).map((d) => d.code).join() === "RA0008,RA0009,RA0010"`, "RA0008, RA0009 et RA0010", 20_000);
    const severities = await client.evaluate<string[]>(`${state('diagnostics["srv/npc/re/refs.txt"].diagnostics')}.map((d) => d.severity)`);
    if (severities.join() !== "info,info,info") throw new Error(`gravites inattendues : ${severities.join()}`);
    await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
    await client.waitFor(
      `(() => { const rows = [...document.querySelectorAll('.problems .problem-meta')].map((e) => e.textContent); return ['RA0008:2', 'RA0009:4', 'RA0010:6'].every((token) => { const [code, line] = token.split(':'); return rows.some((t) => t.includes(code) && t.includes('srv/npc/re/refs.txt:' + line)); }); })()`,
      "lignes RA0008, RA0009 et RA0010 dans le panneau des problemes",
    );
    await client.waitFor(`document.querySelectorAll('.monaco-editor .squiggly-info').length >= 3`, "trois soulignements d'information dans l'editeur");
    await client.screenshot(join(outDir, "02p-references-diagnostics.png"));
    if (readFileSync(join(project, "srv", "npc", "re", "refs.txt"), "utf8") !== REFS) throw new Error("refs.txt a ete modifie par l'analyse");
  });

  await step("le survol d'un objet donne son nom, son identifiant, son type et sa source ; un objet inconnu est dit introuvable", async () => {
    // Ligne 5 `\tgetitem 501,1;` : le curseur est sur le nombre (colonne 11).
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 5, column: 11 }); editor.focus(); editor.trigger("e2e", "editor.action.showHover", {}); })()`);
    await client.waitFor(`[...document.querySelectorAll('.monaco-hover')].some((hover) => hover.textContent.includes('Red Potion'))`, "survol de l'objet", 15_000);
    const text = await client.evaluate<string>(`[...document.querySelectorAll('.monaco-hover')].map((hover) => hover.textContent).join(' | ')`);
    for (const expected of ["Red Potion", "item 501", "Red_Potion", "Healing", "db/item_db.yml:5"]) {
      if (!text.includes(expected)) throw new Error(`survol incomplet (manque « ${expected} ») : ${text}`);
    }
    await sleep(500);
    await client.screenshot(join(outDir, "02q-item-hover.png"));
    await plainKey(client, "Escape", "Escape", 27);
    // Ligne 4 `\tgetitem 99999,1;` : un objet que la base ne contient pas.
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 4, column: 12 }); editor.focus(); editor.trigger("e2e", "editor.action.showHover", {}); })()`);
    await client.waitFor(`[...document.querySelectorAll('.monaco-hover')].some((hover) => hover.textContent.includes('99999'))`, "survol de l'objet inconnu", 15_000);
    const unknown = await client.evaluate<string>(`[...document.querySelectorAll('.monaco-hover')].map((hover) => hover.textContent).join(' | ')`);
    if (!unknown.includes("is not in the item database")) throw new Error(`survol d'un objet inconnu inattendu : ${unknown}`);
    await plainKey(client, "Escape", "Escape", 27);
  });

  await step("Ctrl+Espace sur l'argument d'un getitem propose les objets de la base du serveur, avec identifiant et type", async () => {
    // Curseur au debut de l'argument de `getitem 501,1;` (ligne 5, colonne 10) : rien n'est saisi, la liste est demandee.
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 5, column: 10 }); editor.focus(); })()`);
    await ctrlKey(client, " ", "Space", 32);
    await client.waitFor(`[...document.querySelectorAll('.suggest-widget .monaco-list-row')].some((row) => row.textContent.includes('Red_Potion'))`, "proposition Red_Potion dans la liste", 15_000);
    await sleep(600);
    // L'identifiant, le nom d'affichage et le type sont dans le detail de la proposition (ligne ou panneau d'aide).
    const detail = "501 · Red Potion · Healing";
    const shown = await client.evaluate<boolean>(`document.querySelector('.suggest-widget')?.textContent.includes(${JSON.stringify(detail)}) ?? false`);
    if (!shown) {
      await ctrlKey(client, " ", "Space", 32);
      await client.waitFor(`[...document.querySelectorAll('.suggest-details, .suggest-widget')].some((panel) => panel.textContent.includes(${JSON.stringify(detail)}))`, "detail de la proposition", 15_000);
    }
    await client.screenshot(join(outDir, "02r-item-completion.png"));
    await plainKey(client, "Escape", "Escape", 27);
    await client.waitFor(`![...document.querySelectorAll('.suggest-widget')].some((widget) => widget.classList.contains('visible'))`, "liste de completion fermee");
    if (readFileSync(join(project, "srv", "npc", "re", "refs.txt"), "utf8") !== REFS) throw new Error("refs.txt a ete modifie par la completion");
    if ((await client.evaluate<boolean>(`${state('docs["srv/npc/re/refs.txt"].dirty')}`)) !== false) throw new Error("le document est marque modifie");
  });

  await step("Ctrl+Maj+D ouvre la recherche dans les bases du serveur : Entree insere l'identifiant, Maj+Entree le nom entre guillemets", async () => {
    await client.evaluate(`${E2E}.controller.createFile("srv/npc/re/ins.txt")`);
    await client.waitFor(`${state("activePath")} === "srv/npc/re/ins.txt" && !!document.querySelector('.monaco-editor')`, "ins.txt ouvert dans Monaco", 15_000);
    await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getEditors()[0]; editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); })()`);
    const search = async (query: string, alt: boolean): Promise<void> => {
      await keyWith(client, 2 | 8, "D", "KeyD", 68);
      await client.waitFor(`!!document.querySelector('.palette-input')`, "palette ouverte", 10_000);
      await client.insertText(query);
      await client.waitFor(`[...document.querySelectorAll('.palette-item')].length > 0 && [...document.querySelectorAll('.palette-item')][0].textContent.includes('Potion')`, `resultats pour ${query}`, 15_000);
      await sleep(300);
      await client.screenshot(join(outDir, alt ? "02t-databases-palette-name.png" : "02s-databases-palette.png"));
      await keyWith(client, alt ? 8 : 0, "Enter", "Enter", 13);
      await client.waitFor(`!document.querySelector('.palette-input')`, "palette fermee", 10_000);
    };
    await search("red", false);
    await client.waitFor(`${E2E}.controller.getManager().textOf("srv/npc/re/ins.txt") === "501"`, "identifiant de Red_Potion insere", 15_000);
    await search("item:orange", true);
    await client.waitFor(`${E2E}.controller.getManager().textOf("srv/npc/re/ins.txt") === '501"Orange_Potion"'`, "nom d'Orange_Potion insere entre guillemets", 15_000);
    await ctrlKey(client, "s", "KeyS", 83);
    await client.waitFor(`${state('docs["srv/npc/re/ins.txt"]?.dirty')} === false`, "fichier enregistre");
    expectBytes(readFileSync(join(project, "srv", "npc", "re", "ins.txt")), Buffer.from('501"Orange_Potion"'), "ins.txt");
  });

  await step("cartes des declarations et noms de labels : carte non chargee (RA0015), carte inconnue (RA0008), label nomme comme une commande ou une constante (RA0014), pas une carte chargee", async () => {
    await client.evaluate(`${E2E}.controller.openFile("srv/npc/re/placed.txt")`);
    await client.waitFor(`${state("activePath")} === "srv/npc/re/placed.txt" && !!document.querySelector('.monaco-editor')`, "placed.txt ouvert dans Monaco", 15_000);
    // La barre d'etat dit combien de cartes le serveur charge (lu dans conf/map_athena.conf et son import).
    await client.waitFor(`${state("emulator.catalog.loadedMaps")} === 1`, "cartes chargees lues", 20_000);
    const tooltip = await client.evaluate<string>(`document.querySelector('.status-server')?.getAttribute('title') ?? ''`);
    if (!tooltip.includes("1 of the maps are loaded by the server (conf/maps_athena.conf).")) throw new Error(`info-bulle sans les cartes chargees : ${tooltip}`);
    await client.waitFor(`(${state('diagnostics["srv/npc/re/placed.txt"]?.diagnostics')} ?? []).map((d) => d.code).join() === "RA0015,RA0008,RA0014,RA0014"`, "RA0015, RA0008 puis deux RA0014", 20_000);
    const found = await client.evaluate<{ severity: string; confidence: string; text: string }[]>(
      `${state('diagnostics["srv/npc/re/placed.txt"].diagnostics')}.map((d) => ({ severity: d.severity, confidence: d.confidence, text: ${E2E}.controller.getManager().textOf("srv/npc/re/placed.txt").slice(d.range.start, d.range.end) }))`,
    );
    if (found.map((d) => d.text).join() !== "prt_fild08,nowhere,mes,Job_Alchemist" || found.map((d) => d.severity).join() !== "info,info,error,error") throw new Error(`diagnostics inattendus : ${JSON.stringify(found)}`);
    // Panneau des problemes : positions et textes (messages en anglais, la langue de l'application dans ce test).
    await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
    await client.waitFor(
      `(() => { const rows = [...document.querySelectorAll('.problems .problem')].map((e) => e.textContent); return rows.some((t) => t.includes('RA0015') && t.includes('srv/npc/re/placed.txt:${positionIn(PLACED, "prt_fild08")}') && t.includes("this server does not load it")) && rows.some((t) => t.includes('RA0008') && t.includes('srv/npc/re/placed.txt:${positionIn(PLACED, "nowhere")}')) && rows.some((t) => t.includes('RA0014') && t.includes('srv/npc/re/placed.txt:${positionIn(PLACED, "mes:")}') && t.includes("invalid label name")) && rows.some((t) => t.includes('RA0014') && t.includes('srv/npc/re/placed.txt:${positionIn(PLACED, "Job_Alchemist:")}')); })()`,
      "lignes RA0015, RA0008 et RA0014 dans le panneau des problemes",
      15_000,
    );
    await client.waitFor(`document.querySelectorAll('.monaco-editor .squiggly-info').length >= 2 && document.querySelectorAll('.monaco-editor .squiggly-error').length >= 2`, "soulignements d'information (cartes) et d'erreur (labels) dans l'editeur");
    await client.screenshot(join(outDir, "02w-declaration-maps.png"));
    // Ni la carte chargee (prontera), ni les lignes de refs.txt (sur prontera) ne sont concernees.
    const refsCodes = await client.evaluate<string>(`(${state('diagnostics["srv/npc/re/refs.txt"]?.diagnostics')} ?? []).map((d) => d.code).join()`);
    if (refsCodes !== "RA0008,RA0009,RA0010") throw new Error(`refs.txt : ${refsCodes}`);
    if (readFileSync(join(project, "srv", "npc", "re", "placed.txt"), "utf8") !== PLACED) throw new Error("placed.txt a ete modifie par l'analyse");
  });

  await step("de nombreux onglets ouverts : la mise en page reste dans la fenetre (la barre d'onglets defile, la page ne deborde pas)", async () => {
    const tabCount = await client.evaluate<number>(state("tabs.length"));
    if (tabCount < 12) throw new Error(`ce test suppose au moins 12 onglets ouverts, ${tabCount} trouves`);
    const layout = await client.evaluate<{ inner: number; document: number; workbench: number; statusRight: number; tabsScroll: number; tabsClient: number; panelRight: number }>(
      `(() => { const right = (selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().right ?? 0); const tabs = document.querySelector('.tabs'); return { inner: innerWidth, document: document.documentElement.scrollWidth, workbench: document.querySelector('.workbench')?.scrollWidth ?? 0, statusRight: right('.statusbar'), tabsScroll: tabs?.scrollWidth ?? 0, tabsClient: tabs?.clientWidth ?? 0, panelRight: right('.workbench-main') }; })()`,
    );
    // Une barre d'onglets plus large que la fenetre defile dans son propre cadre ; elle ne doit pas elargir la page.
    if (layout.tabsScroll <= layout.tabsClient) throw new Error(`la barre d'onglets ne deborde pas (${JSON.stringify(layout)}) : le test ne prouve rien`);
    if (layout.document > layout.inner || layout.workbench > layout.inner) throw new Error(`la page deborde de la fenetre : ${JSON.stringify(layout)}`);
    if (layout.statusRight > layout.inner || layout.panelRight > layout.inner) throw new Error(`la barre d'etat ou la zone principale depasse la fenetre : ${JSON.stringify(layout)}`);
  });

  await step("Ctrl+Maj+M ouvre le rapport de projet : seulement les scripts charges par defaut, positions exactes, filtres, copie ; un clic ouvre un fichier ferme au bon endroit", async () => {
    // Rien n'est calcule tant que l'utilisateur n'a pas demande le rapport.
    if ((await client.evaluate<boolean>(`${state("projectReport")} === null`)) !== true) throw new Error("le rapport a ete calcule sans avoir ete demande");
    await keyWith(client, 2 | 8, "M", "KeyM", 77);
    await client.waitFor(`${state("bottomTab")} === "report" && ${state("bottomVisible")} === true`, "onglet Rapport affiche", 10_000);
    await client.waitFor(`${state("projectReport.status")} === "ready" && ${state("projectReport.complete")} === true`, "rapport calcule", 20_000);
    await client.waitFor(`document.querySelectorAll('.report-file-toggle').length > 0`, "fichiers dans le rapport", 10_000);

    // Par defaut : seulement les scripts que le serveur charge (ici `npc/re/probe.txt`), calcules par le service ; l'ecran le dit.
    const scope = await client.evaluate<{ loaded: string[]; notLoaded: number; hide: boolean; files: string[]; excluded: { examined: number; files: number; problems: number } | null }>(
      `({ loaded: [...${state("projectReport.scope.loaded")}], notLoaded: ${state("projectReport.scope.notLoaded")}, hide: ${state("projectReport.hideUnloaded")}, files: ${state("projectReport.report.files")}.map((file) => file.uri), excluded: ${state("projectReport.report.excluded")} })`,
    );
    if (scope.loaded.join() !== "srv/npc/re/probe.txt" || scope.hide !== true || scope.notLoaded < 10) throw new Error(`portee inattendue : ${JSON.stringify(scope)}`);
    if (scope.files.join() !== "srv/npc/re/probe.txt") throw new Error(`fichiers du rapport par defaut : ${scope.files.join()}`);
    if (scope.excluded === null || scope.excluded.examined !== scope.notLoaded || scope.excluded.files < 5) throw new Error(`fichiers laisses de cote : ${JSON.stringify(scope.excluded)}`);
    const shown = (): Promise<string[]> => client.evaluate<string[]>(`[...document.querySelectorAll('.report-file-path')].map((e) => e.textContent)`);
    if ((await shown()).join() !== "srv/npc/re/probe.txt") throw new Error(`fichiers affiches par defaut : ${(await shown()).join()}`);
    const notice = await client.evaluate<string>(`document.querySelector('.report-scope')?.textContent ?? ''`);
    if (!notice.includes("Only scripts loaded by the server") || !notice.includes("are hidden: the server never loads them")) throw new Error(`avis de portee absent : ${notice}`);
    const probeTotals = await client.evaluate<{ errors: number; warnings: number; infos: number }>(`${state("projectReport.report.totals")}`);
    const header = await client.evaluate<string>(`document.querySelector('.report .problems-count')?.textContent ?? ''`);
    const expectedHeader = `${probeTotals.errors} error(s) · ${probeTotals.warnings} warning(s) · ${probeTotals.infos} notice(s)`;
    if (header !== expectedHeader) throw new Error(`totaux affiches : « ${header} » (attendu « ${expectedHeader} »)`);
    if (!(await client.evaluate<boolean>(`document.getElementById('bottom-tab-report')?.getAttribute('aria-selected') === 'true'`))) throw new Error("l'onglet Rapport n'est pas selectionne");
    await client.screenshot(join(outDir, "02u-project-report.png"));

    // Copie (clic reel = activation utilisateur) : le texte est celui de l'ecran, avec la mention de ce qui est masque. La page ne
    // relit pas le presse-papiers (`readText` demande une autorisation que personne ne donne : l'appel resterait suspendu) : on
    // note le texte que l'application confie a `writeText`, dont la reussite est confirmee par le message affiche.
    await client.evaluate(
      `(() => { window.__copied = []; const clipboard = navigator.clipboard; const original = clipboard.writeText.bind(clipboard); clipboard.writeText = (text) => { window.__copied.push(text); return original(text); }; })()`,
    );
    await client.waitFor(`document.querySelectorAll('.report-actions button').length === 2`, "boutons du rapport", 10_000);
    await realClick(client, `document.querySelectorAll('.report-actions button')[1]`, "bouton Copier le rapport");
    await client.waitFor(`${state("toasts")}.some((toast) => toast.text.includes("roject report"))`, "resultat de la copie (confirmation ou echec)", 10_000);
    const copyToast = await client.evaluate<string>(`${state("toasts")}.map((toast) => toast.text).filter((text) => text.includes("roject report")).join(" | ")`);
    if (copyToast !== "Project report copied to the clipboard.") throw new Error(`la copie n'a pas ete confirmee : ${copyToast}`);
    const copied = await client.evaluate<string[]>(`window.__copied`);
    const clipboard = copied[0] ?? "";
    if (copied.length !== 1 || !clipboard.startsWith("# Project report: ") || !clipboard.includes("### srv/npc/re/probe.txt") || !clipboard.includes("Not shown: ") || clipboard.includes("npc/labels.txt")) {
      throw new Error(`texte confie au presse-papiers inattendu (${copied.length} ecriture(s)) : ${clipboard.slice(0, 300)}`);
    }

    // Tout montrer (clic reel sur la case) : le rapport est recalcule pour tous les fichiers indexes.
    await realClick(client, `document.querySelector('.report-scope input[type=checkbox]')`, "case « seulement les scripts charges »");
    await client.waitFor(`${state("projectReport.report.excluded")} === null && ${state("projectReport.status")} === "ready"`, "rapport recalcule pour tous les fichiers", 15_000);
    await client.waitFor(`document.querySelectorAll('.report-file-path').length > 1`, "tous les fichiers du rapport affiches", 5_000);

    // Le rapport complet.
    const files = await client.evaluate<{ uri: string; errors: number; warnings: number; infos: number; codes: string[]; positions: string[] }[]>(
      `${state("projectReport.report.files")}.map((file) => ({ uri: file.uri, errors: file.errors, warnings: file.warnings, infos: file.infos, codes: file.items.map((i) => i.diagnostic.code), positions: file.items.map((i) => i.line + ":" + i.column) }))`,
    );
    const byUri = new Map(files.map((file) => [file.uri, file]));
    const labels = byUri.get("npc/labels.txt");
    if (labels === undefined || labels.codes.join() !== "RA0002" || labels.positions.join() !== positionIn(LABELS, "L_Missing")) {
      throw new Error(`npc/labels.txt : ${JSON.stringify(labels)} (attendu RA0002 a ${positionIn(LABELS, "L_Missing")})`);
    }
    const refs = byUri.get("srv/npc/re/refs.txt");
    if (refs === undefined || refs.codes.join() !== "RA0008,RA0009,RA0010") throw new Error(`srv/npc/re/refs.txt : ${JSON.stringify(refs)}`);
    const refLines = refs.positions.map((position) => position.split(":")[0]).join();
    if (refLines !== "2,4,6") throw new Error(`lignes des references introuvables : ${refLines}`);
    const probe = byUri.get("srv/npc/re/probe.txt");
    if (probe === undefined || !probe.codes.includes("RA0006") || probe.errors !== probeTotals.errors || probe.warnings !== probeTotals.warnings || probe.infos !== probeTotals.infos) {
      throw new Error(`srv/npc/re/probe.txt : ${JSON.stringify(probe)} (attendu les memes totaux que la vue restreinte : ${expectedHeader})`);
    }
    if (!byUri.has("npc/bad.txt")) throw new Error("npc/bad.txt (erreur de syntaxe) absent du rapport");
    for (const clean of ["npc/lib.txt", "npc/caller.txt"]) if (byUri.has(clean)) throw new Error(`${clean} n'a aucun probleme et ne doit pas figurer au rapport`);
    // Le manuel du mini serveur est un `.txt` : indexe comme un script par la portee par defaut, il fait des « erreurs » qui ne
    // concernent pas le serveur (il ne le lit jamais). C'est le bruit que la portee « charges par le serveur » retire.
    if (!(byUri.get("srv/doc/script_commands.txt")?.errors ?? 0)) throw new Error("le manuel indexe comme un script ne produit pas d'erreurs : le test de la portee ne prouverait rien");

    // Le rapport montre ce que le panneau des problemes montre pour un document ouvert.
    const panelCodes = await client.evaluate<string>(`${state('diagnostics["srv/npc/re/refs.txt"].diagnostics')}.map((d) => d.code).join()`);
    if (panelCodes !== refs.codes.join()) throw new Error(`rapport et panneau des problemes different : ${refs.codes.join()} / ${panelCodes}`);

    // Ce que l'ecran dit correspond au rapport : une ligne par fichier, totaux.
    if ((await shown()).join() !== files.map((file) => file.uri).join()) throw new Error(`fichiers affiches : ${(await shown()).join()}`);
    const totals = await client.evaluate<{ errors: number; warnings: number; infos: number }>(`${state("projectReport.report.totals")}`);
    const allHeader = await client.evaluate<string>(`document.querySelector('.report .problems-count')?.textContent ?? ''`);
    if (allHeader !== `${totals.errors} error(s) · ${totals.warnings} warning(s) · ${totals.infos} notice(s)`) throw new Error(`totaux de tout le rapport : « ${allHeader} »`);
    await client.screenshot(join(outDir, "02u2-project-report-all.png"));

    // Filtre par gravite (clics reels) : sans les erreurs, npc/labels.txt disparait du rapport et refs.txt reste.
    const checkbox = (index: number): string => `document.querySelectorAll('.report-filters .report-check input')[${index}]`;
    await realClick(client, checkbox(0), "case Erreurs");
    await client.waitFor(`![...document.querySelectorAll('.report-file-path')].some((e) => e.textContent === 'npc/labels.txt')`, "npc/labels.txt masque par le filtre", 5_000);
    if (!(await client.evaluate<boolean>(`[...document.querySelectorAll('.report-file-path')].some((e) => e.textContent === 'srv/npc/re/refs.txt')`))) throw new Error("refs.txt a disparu avec le filtre des erreurs");
    await realClick(client, checkbox(0), "case Erreurs");
    await client.waitFor(`[...document.querySelectorAll('.report-file-path')].some((e) => e.textContent === 'npc/labels.txt')`, "npc/labels.txt de nouveau affiche", 5_000);

    // Un fichier ferme : le clic sur son probleme l'ouvre et place le curseur sur le mot signale.
    await client.evaluate(`${E2E}.controller.requestCloseTab("npc/labels.txt")`);
    await client.waitFor(`!${state("tabs")}.includes("npc/labels.txt")`, "onglet labels.txt ferme", 10_000);
    const item = `[...document.querySelectorAll('.report-files > li')].find((li) => li.querySelector('.report-file-path')?.textContent === 'npc/labels.txt')?.querySelector('.problem')`;
    await realClick(client, item, "probleme de npc/labels.txt");
    await client.waitFor(`${state("activePath")} === "npc/labels.txt" && !!document.querySelector('.monaco-editor')`, "labels.txt ouvert au clic", 15_000);
    const [wantedLine, wantedColumn] = positionIn(LABELS, "L_Missing").split(":");
    await client.waitFor(
      `(async () => { const monaco = await ${E2E}.monaco(); const p = monaco.editor.getEditors()[0].getPosition(); return !!p && p.lineNumber === ${wantedLine} && p.column === ${wantedColumn}; })()`,
      `curseur de Monaco en ${wantedLine}:${wantedColumn}`,
      15_000,
    );
    await client.screenshot(join(outDir, "02v-project-report-open.png"));

    // L'analyse n'ecrit rien dans les fichiers.
    if (readFileSync(join(project, "srv", "npc", "re", "refs.txt"), "utf8") !== REFS) throw new Error("refs.txt a ete modifie");
    if (readFileSync(join(project, "npc", "labels.txt"), "utf8") !== LABELS) throw new Error("labels.txt a ete modifie");
    await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
  });

  await step("ordre de chargement du serveur : l'appel par son nom d'une fonction chargee apres l'appelant est refuse (RA0016) ; reordonner la liste des scripts le corrige au retour sur le projet", async () => {
    const callerPath = "srv/npc/re/order_caller.txt";
    const confPath = join(project, "srv", "npc", "re", "scripts_main.conf");
    const files = [join(project, "srv", "npc", "re", "order_caller.txt"), join(project, "srv", "npc", "re", "order_lib.txt")];
    const ORDER_CALLER = 'prontera,13,13,4\tscript\tOrderCaller\t100,{\n\tOrderLib;\n\tclose;\n}\n';
    const ORDER_LIB = "function\tscript\tOrderLib\t{\n\tclose;\n}\n";
    const original = readFileSync(confPath, "utf8");
    const codesOf = `(${state(`diagnostics["${callerPath}"]?.diagnostics`)} ?? []).map((d) => d.code).join()`;
    writeFileSync(files[0] ?? "", ORDER_CALLER);
    writeFileSync(files[1] ?? "", ORDER_LIB);
    try {
      // Le serveur charge d'abord l'appelant, puis la fonction qu'il appelle : `OrderLib` n'existe pas encore quand il lit l'appel.
      writeFileSync(confPath, `${original}npc: npc/re/order_caller.txt\nnpc: npc/re/order_lib.txt\n`);
      await client.evaluate(`${E2E}.controller.refreshTree()`);
      await client.evaluate(`${E2E}.controller.openFile("${callerPath}")`);
      await client.waitFor(`${state("activePath")} === "${callerPath}" && !!document.querySelector('.monaco-editor')`, "order_caller ouvert dans Monaco", 15_000);
      await client.waitFor(`${codesOf} === "RA0016"`, "RA0016 sur l'appel premature", 20_000);
      const found = await client.evaluate<{ severity: string; confidence: string; text: string }>(
        `(() => { const d = ${state(`diagnostics["${callerPath}"].diagnostics[0]`)}; return { severity: d.severity, confidence: d.confidence, text: ${E2E}.controller.getManager().textOf("${callerPath}").slice(d.range.start, d.range.end) }; })()`,
      );
      if (found.text !== "OrderLib" || found.severity !== "error" || found.confidence !== "probable") throw new Error(`RA0016 inattendue : ${JSON.stringify(found)}`);
      await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
      await client.waitFor(
        `[...document.querySelectorAll('.problems .problem')].some((e) => e.textContent.includes('RA0016') && e.textContent.includes('${callerPath}:${positionIn(ORDER_CALLER, "OrderLib")}') && e.textContent.includes("before the server has loaded it"))`,
        "ligne RA0016 dans le panneau des problemes",
        15_000,
      );
      await client.screenshot(join(outDir, "02w2-load-order.png"));

      // L'ordre est corrige : la fonction d'abord. Rien d'autre n'a change (ni les scripts, ni le texte ouvert).
      writeFileSync(confPath, `${original}npc: npc/re/order_lib.txt\nnpc: npc/re/order_caller.txt\n`);
      await client.evaluate(`${E2E}.controller.refreshTree()`);
      await client.waitFor(`${codesOf} === ""`, "RA0016 disparue apres le reordonnancement", 20_000);
      await client.waitFor(`document.querySelectorAll('.problems .problem').length === 0 || ![...document.querySelectorAll('.problems .problem')].some((e) => e.textContent.includes('RA0016') && e.textContent.includes('${callerPath}'))`, "ligne RA0016 retiree du panneau", 15_000);
      if (readFileSync(files[0] ?? "", "utf8") !== ORDER_CALLER) throw new Error("order_caller.txt a ete modifie par l'analyse");
    } finally {
      // Le projet de test retrouve son etat d'avant ; l'onglet est ferme avant de retirer le fichier.
      await client.evaluate(`${E2E}.controller.requestCloseTab("${callerPath}")`).catch(() => undefined);
      writeFileSync(confPath, original);
      for (const file of files) rmSync(file, { force: true });
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  await step("journal de diagnostic local : rien tant qu'il n'est pas active ; active, il consigne des evenements sans chemin ni texte de script ; desactive, il se tait", async () => {
    const logFile = join(appData, "data", "logs", "runeforge.log");
    const extra = join(project, "npc", "journal.txt");
    const lines = (): string[] => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((line) => line !== "") : []);
    const syncNewFile = async (name: string): Promise<void> => {
      writeFileSync(extra, `function\tscript\t${name}\t{\n\treturn;\n}\n`);
      await client.evaluate(`${E2E}.controller.refreshTree()`);
      await client.evaluate(`${E2E}.controller.whenIndexed()`);
    };
    try {
      // Par defaut : aucun fichier, meme apres tout ce que le scenario a deja fait.
      if (existsSync(logFile)) throw new Error("un journal existe alors que l'utilisateur ne l'a pas active");
      await client.evaluate(`${E2E}.controller.updateSettings({ logging: { enabled: true } })`);
      const started = Date.now();
      while (lines().length === 0 && Date.now() - started < 10_000) await sleep(100);
      if (!lines().some((line) => /^\d+ INFO LOG_ENABLED$/.test(line))) throw new Error(`activation absente du journal : ${JSON.stringify(lines())}`);

      await syncNewFile("F_JournalSecret");
      const syncStarted = Date.now();
      while (!lines().some((line) => / INFO INDEX_DONE files=\d+ functions=\d+ npcs=\d+ ms=\d+$/.test(line)) && Date.now() - syncStarted < 15_000) await sleep(100);
      if (!lines().some((line) => line.includes(" INDEX_DONE "))) throw new Error(`fin d'indexation absente du journal : ${JSON.stringify(lines())}`);
      // Le type standard est consigné même si l'instance redéfinit son nom.
      await client.evaluate(`(() => {
        const error = new TypeError("message secret C:\\\\Users\\\\moi\\\\a.txt");
        error.name = "PrivateErrorName";
        window.dispatchEvent(new ErrorEvent("error", { error, message: "message secret" }));
      })()`);
      const errorStarted = Date.now();
      while (!lines().some((line) => / ERROR UI_ERROR name=TypeError$/.test(line)) && Date.now() - errorStarted < 10_000) await sleep(100);
      if (!lines().some((line) => / ERROR UI_ERROR name=TypeError$/.test(line))) throw new Error(`erreur de l'interface absente du journal : ${JSON.stringify(lines())}`);

      // Rien de sensible : format strict, ni chemin du projet, ni nom de fichier ou de fonction, ni texte de script, ni message d'erreur.
      const content = lines().join("\n");
      for (const line of lines()) {
        if (!/^\d+ (INFO|WARN|ERROR) [A-Z0-9_]+( [A-Za-z0-9 _.,=;()-]+)?$/.test(line)) throw new Error(`ligne de journal hors format : ${line}`);
      }
      for (const secret of [project, "journal.txt", "F_JournalSecret", "Bonjour", "a.txt", "message secret", "Users", "PrivateErrorName"]) {
        if (content.includes(secret)) throw new Error(`le journal contient « ${secret} »`);
      }

      // Desactive : le journal se tait aussitot.
      await client.evaluate(`${E2E}.controller.updateSettings({ logging: { enabled: false } })`);
      await sleep(400);
      const frozen = lines().length;
      await syncNewFile("F_JournalApres");
      await client.evaluate(`window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("x"), message: "x" }))`);
      await sleep(1_200);
      if (lines().length !== frozen) throw new Error(`le journal a continue apres sa desactivation : ${JSON.stringify(lines().slice(frozen))}`);
    } finally {
      rmSync(extra, { force: true });
      await client.evaluate(`${E2E}.controller.updateSettings({ logging: { enabled: false } })`).catch(() => undefined);
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  await step("assistant de NPC : ouvert par le menu Fichier, script verifie ; « Ajouter au fichier ouvert » l'ecrit en fin de fichier (annulable) sans toucher le disque, Ctrl+S l'enregistre ; « Creer le fichier » cree un fichier non enregistre", async () => {
    const target = join(project, "npc", "wizard-target.txt");
    const created = join(project, "npc", "merchant.txt");
    const TARGET = "// cible de l'assistant\n";
    const portal = runWizard("warp-portal", { ...initialValues("warp-portal"), destMap: "prontera" }).source ?? "";
    const shop = runWizard("shop", initialValues("shop")).source ?? "";
    const waitModel = (path: string, expected: string, description: string): Promise<void> => waitModelText(client, path, expected, description);
    const openWizard = async (): Promise<void> => {
      await realClick(client, "document.querySelector('#menu-button-file')", "menu Fichier");
      await client.waitFor("!!document.querySelector('#menu-file')", "menu Fichier deplie");
      await realClick(client, "[...document.querySelectorAll('#menu-file [role=menuitem]')].find((item) => /NPC wizard|Assistant de NPC/.test(item.textContent))", "commande Assistant de NPC");
      await client.waitFor("!!document.querySelector('[role=dialog] .wizard')", "assistant de NPC ouvert");
    };
    const fieldText = async (suffix: string, text: string): Promise<void> => {
      await client.evaluate(`(() => { const input = document.querySelector('[role=dialog] [id$="-${suffix}"]'); input.focus(); input.select(); })()`);
      await client.insertText(text);
    };
    const previewIs = (expected: string): string => `document.querySelector('[role=dialog] .wizard-preview')?.textContent === ${JSON.stringify(expected)}`;
    try {
      writeFileSync(target, TARGET);
      await client.evaluate(`${E2E}.controller.refreshTree()`);
      await openByClick(client, "npc", "wizard-target.txt");

      // Ouverture par le menu : le portail par defaut, puis une vraie saisie dans « carte de destination ».
      await openWizard();
      await client.waitFor(previewIs(runWizard("warp-portal", initialValues("warp-portal")).source ?? ""), "script du portail par defaut");
      await fieldText("destMap", "prontera");
      await client.waitFor(previewIs(portal), "script mis a jour par la saisie");
      await client.waitFor("!!document.querySelector('[role=dialog] .wizard-check-ok')", "verification locale terminee sans probleme", 20_000);
      await client.screenshot(join(outDir, "04-wizard.png"));

      // « Ajouter au fichier ouvert » (bouton principal) : fin du fichier, apres une ligne vide ; rien sur le disque.
      await realClick(client, "document.querySelector('[role=dialog] .modal-actions .button-primary')", "Ajouter au fichier ouvert");
      await client
        .waitFor("!document.querySelector('[role=dialog]')", "assistant ferme", 8_000)
        .catch(async (error: unknown) => {
          const detail = await client.evaluate<string>(`JSON.stringify({ toasts: ${state("toasts")}, dialog: ${state("dialog")}, queue: ${state("dialogQueue")}, text: (document.querySelector('[role=dialog]')?.textContent ?? '').slice(0, 160), active: ${state("activePath")}, primary: (() => { const b = document.querySelector('[role=dialog] .modal-actions .button-primary'); return b ? { disabled: b.disabled, text: b.textContent } : null; })() })`);
          throw new Error(`${error instanceof Error ? error.message : String(error)} ${detail}`);
        });
      const expected = `${TARGET}\n${portal}`;
      await waitModel("npc/wizard-target.txt", expected, "texte de Monaco apres l'ajout");
      await client.waitFor(isDirty("npc/wizard-target.txt"), "fichier marque modifie");
      if (readFileSync(target, "utf8") !== TARGET) throw new Error("le disque a ete modifie avant l'enregistrement");
      // Le script ajoute est montre (ligne 3 : le commentaire, une ligne vide, puis le script).
      const line = await client.evaluate<number>(`(async () => { const monaco = await ${E2E}.monaco(); return monaco.editor.getEditors()[0].getPosition().lineNumber; })()`);
      if (line !== 3) throw new Error(`curseur a la ligne ${line}, attendu 3`);
      // Annulable d'un seul Ctrl+Z (le fichier redevient intact), retablissable, puis enregistre par Ctrl+S.
      await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); monaco.editor.getEditors()[0].focus(); })()`);
      await ctrlKey(client, "z", "KeyZ", 90);
      await waitModel("npc/wizard-target.txt", TARGET, "texte de Monaco apres Ctrl+Z");
      await client.waitFor(`${state('docs["npc/wizard-target.txt"]?.dirty')} === false`, "fichier de nouveau intact apres l'annulation");
      await ctrlKey(client, "y", "KeyY", 89);
      await waitModel("npc/wizard-target.txt", expected, "texte de Monaco apres Ctrl+Y");
      await ctrlKey(client, "s", "KeyS", 83);
      await client.waitFor(`${state('docs["npc/wizard-target.txt"]?.dirty')} === false`, "fichier enregistre");
      expectBytes(readFileSync(target), Buffer.from(expected), "wizard-target.txt");

      // « Creer le fichier » : proposition de nom a cote du fichier ouvert, fichier vide sur le disque, script non enregistre.
      await openWizard();
      await realClick(client, "document.querySelectorAll('[role=dialog] [role=tab]')[2]", "onglet Boutique");
      await client.waitFor(previewIs(shop), "script de la boutique");
      const proposed = await client.evaluate<string>(`document.querySelector('[role=dialog] [id$="-file"]').value`);
      if (proposed !== "npc/merchant.txt") throw new Error(`nom de fichier propose : ${proposed}`);
      await realClick(client, "document.querySelectorAll('[role=dialog] .modal-actions .button')[2]", "Creer le fichier");
      await client.waitFor(`${state("activePath")} === "npc/merchant.txt" && !document.querySelector('[role=dialog]')`, "fichier cree et ouvert", 20_000);
      await waitModel("npc/merchant.txt", shop, "texte de Monaco du fichier cree");
      await client.waitFor(isDirty("npc/merchant.txt"), "fichier cree marque modifie");
      if (readFileSync(created).length !== 0) throw new Error("le fichier cree n'est pas vide avant l'enregistrement");
      await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); monaco.editor.getEditors()[0].focus(); })()`);
      await ctrlKey(client, "s", "KeyS", 83);
      await client.waitFor(`${state('docs["npc/merchant.txt"]?.dirty')} === false`, "fichier cree enregistre");
      expectBytes(readFileSync(created), Buffer.from(shop), "merchant.txt");
    } finally {
      // Ni dialogue, ni onglet, ni fichier ne doit rester pour les etapes suivantes.
      await client
        .evaluate(
          `(async () => { const c = ${E2E}.controller; if (${state("dialog")}?.kind === "npc-wizard") c.closeDialog(); for (const p of ["npc/wizard-target.txt", "npc/merchant.txt"]) { if (c.getManager().has(p)) { await c.requestCloseTab(p); if (${state("dialog")}?.kind === "unsaved-close") await c.resolveUnsaved(p, "discard"); } } })()`,
        )
        .catch(() => undefined);
      rmSync(target, { force: true });
      rmSync(created, { force: true });
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  const openVisual = async (): Promise<void> => {
    await realClick(client, "document.querySelector('#menu-button-file')", "menu Fichier");
    await client.waitFor("!!document.querySelector('#menu-file')", "menu Fichier deplie");
    await realClick(client, "[...document.querySelectorAll('#menu-file [role=menuitem]')].find((item) => /Visual dialogue editor|diteur visuel/.test(item.textContent))", "commande Editeur visuel de dialogues");
    await client.waitFor("!!document.querySelector('[role=dialog] #visual-npc-heading')", "editeur visuel ouvert");
  };
  /** Selectionne tout le champ d'un bloc puis y saisit du texte reel, et valide par Entree. */
  const typeInBlock = async (id: string, text: string): Promise<void> => {
    await client.evaluate(`(() => { const input = document.querySelector('[role=dialog] [data-block-id="${id}"] input'); input.focus(); input.select(); })()`);
    await client.insertText(text);
    await plainKey(client, "Enter", "Enter", 13);
  };

  await step("editeur visuel : ouvert par le menu Fichier sur le NPC du fichier, les blocs se modifient dans une copie (focus suivi) ; Echap confirme l'abandon ; « Appliquer » ecrit une seule modification annulable d'un Ctrl+Z, le bloc brut reste intact au caractere pres, et Ctrl+S enregistre", async () => {
    const target = join(project, "npc", "visual-target.txt");
    const HEAD = "prontera,150,150,4\tscript\tVisualGuide\t100,{";
    const RAW = '\tcallfunc "F_Bonus";   // bonus';
    const END = [RAW, "\tif (a) {", "\t\tnext;", "\t}", "\tclose;", "}", ""];
    const BEFORE = [HEAD, '\tmes "[Guide]";', '\tmes "Welcome, traveler.";', "\tnext;", ...END].join("\n");
    const AFTER = [HEAD, '\tmes "Hello";', '\tmes "Welcome, traveler.";', '\tmes "Take this.";', "\tnext;", ...END].join("\n");
    const rows = (): Promise<string[]> =>
      client.evaluate<string[]>(`[...document.querySelectorAll('[role=dialog] [data-block-id]')].map((row) => row.getAttribute('data-block-id') + ':' + row.className.replace('visual-block visual-block-', ''))`);
    try {
      writeFileSync(target, BEFORE);
      await client.evaluate(`${E2E}.controller.refreshTree()`);
      await openByClick(client, "npc", "visual-target.txt");

      // Ouverture par le menu : le NPC du fichier en blocs (le bloc brut est reconnu comme tel), le focus sur le premier champ.
      await openVisual();
      const initial = await rows();
      if (JSON.stringify(initial) !== JSON.stringify(["0:mes", "1:mes", "2:next", "3:raw", "4:if", "4.t.0:next", "5:close"])) throw new Error(`blocs lus : ${JSON.stringify(initial)}`);
      const focused = await client.evaluate<string>(`(() => { const e = document.activeElement; return (e && e.tagName) + ':' + (e && e.closest('[data-block-id]') ? e.closest('[data-block-id]').getAttribute('data-block-id') : '') })()`);
      if (focused !== "INPUT:0") throw new Error(`focus a l'ouverture : ${focused}`);
      const locked = await client.evaluate<number>(`document.querySelectorAll('[role=dialog] [data-block-id="3"] .visual-actions button').length`);
      if (locked !== 4) throw new Error(`le bloc brut a ${locked} boutons au lieu de 4 (ajouter seulement)`);
      await client.screenshot(join(outDir, "07-visual.png"));

      // Une condition peut contenir une expression, mais pas introduire un autre bloc.
      await typeInBlock("4", "1) { next; } if (2");
      await client.waitFor("!!document.querySelector('[role=dialog] [role=alert]') && !document.querySelector('[role=dialog] .diff-surface')", "condition refusée sans modification");
      await typeInBlock("4", "a");

      // Premiere modification : une vraie saisie dans le champ du premier message (rien ne change encore dans le document).
      await typeInBlock("0", "Hello");
      await client.waitFor(`document.querySelector('[role=dialog] [data-block-id="0"] input')?.value === "Hello" && !!document.querySelector('[role=dialog] .diff-surface')`, "changement en attente et apercu");
      if ((await modelTextOf(client, "npc/visual-target.txt")) !== BEFORE) throw new Error("le document a change avant « Appliquer »");

      // Echap avec des changements en attente : confirmation d'abord (le dialogue reste ouvert), jamais de perte silencieuse.
      await plainKey(client, "Escape", "Escape", 27);
      await client.waitFor("!!document.querySelector('[role=dialog] [role=alert]')", "avertissement des changements non appliques");
      if (!(await client.evaluate<boolean>("!!document.querySelector('[role=dialog] .visual-list')"))) throw new Error("Echap a ferme le dialogue malgre des changements en attente");

      // Deuxieme modification : un message ajoute apres le deuxieme bloc, dont le champ prend le focus (saisie directe).
      await realClick(client, "document.querySelectorAll('[role=dialog] [data-block-id=\"1\"] .visual-actions button')[3]", "+ Message apres le deuxieme bloc");
      await client.waitFor(`(() => { const e = document.activeElement; return e.tagName === 'INPUT' && e.closest('[data-block-id]')?.getAttribute('data-block-id') === '2' && e.value === '...'; })()`, "le focus suit le bloc ajoute");
      await client.evaluate(`document.activeElement.select()`);
      await client.insertText("Take this.");
      await plainKey(client, "Enter", "Enter", 13);
      await client.waitFor(`document.querySelector('[role=dialog] [data-block-id="2"] input')?.value === "Take this."`, "texte du message ajoute");
      await client.screenshot(join(outDir, "07b-visual-changed.png"));

      // « Appliquer au document » : le dialogue se ferme, le texte de Monaco est le resultat, le disque n'a pas bouge.
      await realClick(client, "document.querySelector('[role=dialog] .modal-actions .button-primary')", "Appliquer au document");
      await client.waitFor("!document.querySelector('[role=dialog]')", "editeur visuel ferme apres l'application", 8_000);
      await waitModelText(client, "npc/visual-target.txt", AFTER, "texte de Monaco apres l'application");
      await client.waitFor(isDirty("npc/visual-target.txt"), "fichier marque modifie");
      if (readFileSync(target, "utf8") !== BEFORE) throw new Error("le disque a ete modifie avant l'enregistrement");

      // Une seule etape d'annulation : Ctrl+Z restitue le fichier d'origine d'un coup, Ctrl+Y le resultat.
      await client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); monaco.editor.getEditors()[0].focus(); })()`);
      await ctrlKey(client, "z", "KeyZ", 90);
      await waitModelText(client, "npc/visual-target.txt", BEFORE, "texte de Monaco apres un seul Ctrl+Z");
      await client.waitFor(`${state('docs["npc/visual-target.txt"]?.dirty')} === false`, "fichier de nouveau intact apres l'annulation");
      await ctrlKey(client, "y", "KeyY", 89);
      await waitModelText(client, "npc/visual-target.txt", AFTER, "texte de Monaco apres Ctrl+Y");

      // Ctrl+S : le fichier enregistre est exactement le resultat, bloc brut et commentaire compris.
      await ctrlKey(client, "s", "KeyS", 83);
      await client.waitFor(`${state('docs["npc/visual-target.txt"]?.dirty')} === false`, "fichier enregistre");
      expectBytes(readFileSync(target), Buffer.from(AFTER), "visual-target.txt");
      if (!readFileSync(target, "utf8").includes(`${RAW}\n`)) throw new Error("le bloc brut n'est pas intact");

      // Fermer sans rien changer ne demande rien ; abandonner apres confirmation laisse le document tel quel.
      await openVisual();
      await plainKey(client, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "fermeture directe sans changement");
      await openVisual();
      await realClick(client, "document.querySelectorAll('[role=dialog] [data-block-id=\"0\"] .visual-actions button')[1]", "Descendre le premier message");
      await client.waitFor("!!document.querySelector('[role=dialog] .diff-surface')", "changement en attente");
      await plainKey(client, "Escape", "Escape", 27);
      await client.waitFor("!!document.querySelector('[role=dialog] [role=alert]')", "confirmation de l'abandon");
      await plainKey(client, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "abandon confirme");
      await waitModelText(client, "npc/visual-target.txt", AFTER, "texte de Monaco apres l'abandon");
      await client.waitFor(`${state('docs["npc/visual-target.txt"]?.dirty')} === false`, "document inchange apres l'abandon");
    } finally {
      // Ni dialogue, ni onglet, ni fichier ne doit rester pour les etapes suivantes.
      await client
        .evaluate(
          `(async () => { const c = ${E2E}.controller; if (${state("dialog")}?.kind === "visual") c.closeDialog(); const p = "npc/visual-target.txt"; if (c.getManager().has(p)) { await c.requestCloseTab(p); if (${state("dialog")}?.kind === "unsaved-close") await c.resolveUnsaved(p, "discard"); } })()`,
        )
        .catch(() => undefined);
      rmSync(target, { force: true });
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  await step("editeur visuel : un NPC vide reçoit une condition, ses deux branches et une fermeture, avec aperçu avant application", async () => {
    const path = "npc/visual-empty.txt";
    const target = join(project, path);
    const head = '-\tscript\tVisualEmpty\t-1,{';
    const comment = "\t// commentaire d'origine";
    const original = [head, comment, "}", ""].join("\n");
    const expected = [head, comment, "\tif (BaseLevel > 10) {", '\t\tmes "Welcome";', "\t} else {", '\t\tmes "Come back later";', "\t}", "\tclose;", "}", ""].join("\n");
    const selector = (query: string): string => `document.querySelector(${JSON.stringify(`[role=dialog] ${query}`)})`;
    try {
      writeFileSync(target, original);
      await client.evaluate(`${E2E}.controller.refreshTree()`);
      await openByClick(client, "npc", "visual-empty.txt");
      await openVisual();
      await realClick(client, selector(".visual-actions button:last-child"), "condition dans un NPC vide");
      await client.waitFor(`${selector('[data-block-id="0"] input')}?.value === "1"`, "nouvelle condition");
      await typeInBlock("0", "BaseLevel > 10");

      await realClick(client, selector('[data-branch="then"] .visual-actions button:first-child'), "premier message dans Alors");
      await client.waitFor(`${selector('[data-block-id="0.t.0"] input')} === document.activeElement`, "focus dans Alors");
      await typeInBlock("0.t.0", "Welcome");
      await realClick(client, selector('[data-branch="else"] .visual-actions button:first-child'), "creer Sinon avec son premier message");
      await client.waitFor(`${selector('[data-block-id="0.e.0"] input')} === document.activeElement`, "focus dans Sinon");
      await typeInBlock("0.e.0", "Come back later");
      await realClick(client, `[...${selector('[data-block-id="0"] > .visual-actions')}.querySelectorAll('button')].find((button) => /Add a close after|Ajouter une fermeture après/.test(button.getAttribute('aria-label') ?? ''))`, "fermeture apres la condition");
      await client.waitFor(`!!${selector('[data-block-id="1"].visual-block-close')} && !!${selector('.diff-surface')}`, "fermeture et apercu du nouveau dialogue");
      await waitModelText(client, path, original, "le document reste intact pendant la creation");
      expectBytes(readFileSync(target), Buffer.from(original), "visual-empty.txt avant application");

      await realClick(client, selector(".modal-actions .button-primary"), "appliquer le dialogue créé");
      await waitModelText(client, path, expected, "le dialogue créé et ses deux branches sont dans le document");
      expectBytes(readFileSync(target), Buffer.from(original), "visual-empty.txt avant enregistrement");
      await ctrlKey(client, "s", "KeyS", 83);
      await client.waitFor(`${state(`docs[${JSON.stringify(path)}]?.dirty`)} === false`, "dialogue créé enregistré");
      expectBytes(readFileSync(target), Buffer.from(expected), "visual-empty.txt après enregistrement");
    } finally {
      await client.evaluate(`(async () => { const c = ${E2E}.controller; if (${state("dialog")}?.kind === "visual") c.closeDialog(); const p = ${JSON.stringify(path)}; if (c.getManager().has(p)) { await c.requestCloseTab(p); if (${state("dialog")}?.kind === "unsaved-close") await c.resolveUnsaved(p, "discard"); } })()`).catch(() => undefined);
      rmSync(target, { force: true });
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  await step("constructeur visuel de NPC en noeuds : une commande glissee de la bibliotheque sur le canevas, des fils tires a la souris entre prises (la geometrie des fils colle aux prises), un noeud deplace, un lacher hors du canevas sans effet ; le script suit les fils, puis « Creer le fichier » l'ouvre non enregistre", async () => {
    const created = join(project, "npc", "builder-npc.txt");
    const sel = (query: string): string => `document.querySelector(${JSON.stringify(`[role=dialog] ${query}`)})`;
    const node = (id: string): string => sel(`[data-flow-node="${id}"]`);
    const output = (id: string): string => sel(`[data-flow-out="${id}"][data-port="next"]`);
    const input = (id: string): string => sel(`[data-flow-in="${id}"]`);
    const EXPECTED = ["prontera,150,150,4\tscript\tNew NPC\t100,{", '\tmes "Welcome to my NPC!";', "\tgetitem 501, 1;", "\tclose;", "}", ""].join("\n");
    const wires = (): Promise<string[]> => client.evaluate<string[]>(`[...document.querySelectorAll('[role=dialog] path[data-wire]')].map((path) => path.getAttribute('data-wire')).sort()`);
    /** Ecart maximal (px) entre les extremites des fils et les centres des prises qu'ils relient. */
    const wireError = (): Promise<{ wires: number; error: number }> =>
      client.evaluate<{ wires: number; error: number }>(
        `(() => { const content = document.querySelector('[role=dialog] .flow-content'); const origin = content.getBoundingClientRect(); const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2 - origin.left, y: r.top + r.height / 2 - origin.top }; }; const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y); let error = 0; let count = 0; for (const path of content.querySelectorAll('path[data-wire]')) { const [from, port] = path.getAttribute('data-wire').split(':'); const numbers = path.getAttribute('d').match(/-?\\d+(?:\\.\\d+)?/g).map(Number); const start = { x: numbers[0], y: numbers[1] }; const end = { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] }; const out = content.querySelector('[data-flow-out="' + from + '"][data-port="' + port + '"]'); const target = [...content.querySelectorAll('[data-flow-in]')].map((e) => distance(center(e), end)).sort((a, b) => a - b)[0]; error = Math.max(error, distance(center(out), start), target); count += 1; } return { wires: count, error }; })()`,
      );
    try {
      await realClick(client, "document.querySelector('#menu-button-file')", "menu Fichier");
      await client.waitFor("!!document.querySelector('#menu-file')", "menu Fichier deplie");
      await realClick(client, "[...document.querySelectorAll('#menu-file [role=menuitem]')].find((item) => /visual builder|constructeur visuel/i.test(item.textContent))", "commande Constructeur visuel de NPC");
      await client.waitFor(`!!${sel(".flow-canvas")}`, "canevas de noeuds");
      await client.evaluate(`${sel(".flow-canvas")}.scrollIntoView({ block: "center" })`);

      // Le graphe de depart : depart, message, close ; deux fils, dont les extremites sont exactement sur les prises.
      if (JSON.stringify(await wires()) !== JSON.stringify(["command-1:next", "start:next"])) throw new Error(`fils de depart : ${JSON.stringify(await wires())}`);
      const initial = await wireError();
      if (initial.wires !== 2 || initial.error > 1.5) throw new Error(`les fils ne tombent pas sur les prises : ${JSON.stringify(initial)}`);
      await client.waitFor(`/Welcome to my NPC!/.test((${sel(".visual-builder-preview")})?.textContent ?? '')`, "apercu du script de depart");
      await client.screenshot(join(outDir, "08-builder-nodes.png"));

      // Glisser « getitem » de la bibliotheque jusqu'au canevas : le noeud se pose sous le pointeur, sans fil.
      await client.evaluate(`${sel("input[type=search]")}.focus()`);
      await client.insertText("getitem");
      await client.waitFor(`!![...document.querySelectorAll('[role=dialog] .visual-builder-command')].find((b) => b.querySelector('strong')?.textContent === 'getitem')`, "getitem dans la bibliotheque");
      const library = `[...document.querySelectorAll('[role=dialog] .visual-builder-command')].find((b) => b.querySelector('strong')?.textContent === 'getitem')`;
      const canvasBox = await client.evaluate<{ left: number; top: number; width: number; height: number }>(`(() => { const r = ${sel(".flow-canvas")}.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
      const dropAt = { x: canvasBox.left + 330, y: canvasBox.top + Math.min(canvasBox.height - 60, 250) };
      await realDrag(client, await centerOf(client, library, "getitem dans la bibliotheque"), dropAt);
      await client.waitFor(`!!${node("command-3")}`, "noeud getitem depose sur le canevas");
      const placed = await client.evaluate<{ left: number; top: number; expectedLeft: number; expectedTop: number }>(
        `(() => { const canvas = ${sel(".flow-canvas")}; const r = canvas.getBoundingClientRect(); const n = ${node("command-3")}; return { left: parseFloat(n.style.left), top: parseFloat(n.style.top), expectedLeft: ${dropAt.x} - r.left - canvas.clientLeft + canvas.scrollLeft - ${FLOW_NODE_WIDTH / 2}, expectedTop: ${dropAt.y} - r.top - canvas.clientTop + canvas.scrollTop - 16 }; })()`,
      );
      if (Math.abs(placed.left - placed.expectedLeft) > 1.5 || Math.abs(placed.top - placed.expectedTop) > 1.5) throw new Error(`noeud depose a ${JSON.stringify(placed)}`);
      if (JSON.stringify(await wires()) !== JSON.stringify(["command-1:next", "start:next"])) throw new Error("le noeud depose ne devrait avoir aucun fil");
      if (!(await client.evaluate<boolean>(`/not connected to the start|pas relié au départ/i.test(document.querySelector('[role=dialog] .field-error')?.textContent ?? '')`))) throw new Error("le noeud non relie n'est pas signale");
      await client.screenshot(join(outDir, "08b-builder-dropped.png"));

      // Tirer les fils a la souris : message -> getitem (remplace le fil vers le close), puis getitem -> close.
      await realDrag(client, await centerOf(client, output("command-1"), "sortie du message"), await centerOf(client, input("command-3"), "entree de getitem"));
      await client.waitFor(`(${output("command-1")}).getAttribute('aria-label').includes('getitem 3')`, "message relie a getitem");
      await realDrag(client, await centerOf(client, output("command-3"), "sortie de getitem"), await centerOf(client, input("command-2"), "entree du close"));
      await client.waitFor(`(${output("command-3")}).getAttribute('aria-label').includes('close 2')`, "getitem relie au close");
      const wired = JSON.stringify(await wires());
      if (wired !== JSON.stringify(["command-1:next", "command-3:next", "start:next"])) throw new Error(`fils apres les glisser : ${wired}`);

      // Les arguments se saisissent dans le noeud (vraie saisie) ; le script suit les fils, dans l'ordre des fils.
      await client.evaluate(`${node("command-3")}.querySelectorAll('input')[0].focus()`);
      await client.insertText("501");
      await client.evaluate(`${node("command-3")}.querySelectorAll('input')[1].focus()`);
      await client.insertText("1");
      await client.waitFor(`(${sel(".visual-builder-preview")})?.textContent === ${JSON.stringify(EXPECTED)}`, "script genere dans l'ordre des fils", 10_000);

      // Deplacer un noeud par son titre : il suit le pointeur, ses fils aussi.
      const before = await client.evaluate<{ left: number; top: number }>(`({ left: parseFloat(${node("command-3")}.style.left), top: parseFloat(${node("command-3")}.style.top) })`);
      const title = await centerOf(client, `${node("command-3")}.querySelector('.flow-node-header .flow-node-title')`, "titre de getitem");
      await realDrag(client, title, { x: title.x + 40, y: title.y + 24 });
      const after = await client.evaluate<{ left: number; top: number }>(`({ left: parseFloat(${node("command-3")}.style.left), top: parseFloat(${node("command-3")}.style.top) })`);
      if (Math.abs(after.left - before.left - 40) > 1.5 || Math.abs(after.top - before.top - 24) > 1.5) throw new Error(`deplacement : ${JSON.stringify({ before, after })}`);
      const moved = await wireError();
      if (moved.wires !== 3 || moved.error > 1.5) throw new Error(`les fils ne suivent pas le noeud deplace : ${JSON.stringify(moved)}`);

      // Un lacher hors du canevas (sur le titre du dialogue) n'ajoute rien.
      const count = await client.evaluate<number>(`document.querySelectorAll('[role=dialog] .flow-node').length`);
      await realDrag(client, await centerOf(client, library, "getitem dans la bibliotheque"), await centerOf(client, "document.querySelector('[role=dialog] .modal-title')", "titre du dialogue"));
      if ((await client.evaluate<number>(`document.querySelectorAll('[role=dialog] .flow-node').length`)) !== count) throw new Error("un lacher hors du canevas a ajoute un noeud");
      await client.screenshot(join(outDir, "08c-builder-wired.png"));

      // « Creer le fichier » : le script est ouvert non enregistre ; le disque ne recoit qu'un fichier vide.
      await client.evaluate(`(() => { const input = document.querySelector('[role=dialog] input[id$="-file"]'); input.focus(); input.select(); })()`);
      await client.insertText("npc/builder-npc.txt");
      await client.waitFor(`!${sel(".modal-actions .button-primary")}.disabled`, "analyse locale terminee : Creer le fichier est disponible", 20_000);
      await realClick(client, sel(".modal-actions .button-primary"), "Creer le fichier");
      await client.waitFor(`${state("activePath")} === "npc/builder-npc.txt" && !document.querySelector('[role=dialog]')`, "fichier cree et ouvert", 20_000);
      await waitModelText(client, "npc/builder-npc.txt", EXPECTED, "texte de Monaco du fichier cree");
      await client.waitFor(isDirty("npc/builder-npc.txt"), "fichier cree marque modifie");
      if (readFileSync(created).length !== 0) throw new Error("le fichier cree n'est pas vide avant l'enregistrement");
    } finally {
      await client
        .evaluate(
          `(async () => { const c = ${E2E}.controller; if (${state("dialog")}?.kind === "visual-builder") c.closeDialog(); const p = "npc/builder-npc.txt"; if (c.getManager().has(p)) { await c.requestCloseTab(p); if (${state("dialog")}?.kind === "unsaved-close") await c.resolveUnsaved(p, "discard"); } })()`,
        )
        .catch(() => undefined);
      rmSync(created, { force: true });
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  await step("simulation de dialogue : le NPC du fichier est joue dans l'application reelle (variable permanente jamais ecrite, constante du serveur chargee a la demande, fonction d'un autre fichier executee, instruction serveur et operation refusee par le serveur notees sans arret, choix, saisie, close2), sans toucher au disque", async () => {
    const path = "npc/simulation-target.txt";
    const target = join(project, path);
    const SOURCE = [
      "prontera,150,150,4\tscript\tSimGuide\t100,{",
      "\tif (bard_q > 5) set gef_bard_q, bard_q;",
      '\tcutin "bard_eland02",2;',
      '\tmes "[Guide]";',
      // Fonction d'un autre fichier du projet (npc/lib.txt, indexe a l'ouverture) : executee, donc jamais notee « non simulee ».
      '\tcallfunc "F_Lib";',
      // Division par zero : le serveur arreterait le script ; la simulation le note et continue.
      '\tmes "Ratio " + (10 / .@zero);',
      '\tmes "Hello ^FF0000" + strcharinfo(0) + "^000000, class " + Class + " is " + (Class == Job_Knight ? "a knight" : "not a knight");',
      "\tnext;",
      '\tswitch (select("Story:Song")) {',
      '\tcase 1: mes "A story."; break;',
      '\tcase 2: mes "A song."; break;',
      "\t}",
      "\tinput .@n, 1, 10;",
      '\tmes "Typed " + .@n;',
      "\tclose2;",
      '\tmes "after close2";',
      "\tclose;",
      "}",
      "",
    ].join("\n");
    const log = (): Promise<string> => client.evaluate<string>("document.querySelector('[role=dialog] [role=log]')?.textContent ?? ''");
    /** Le bouton du dialogue dont le texte correspond (le dialogue est en francais ou en anglais selon le systeme). */
    const button = (pattern: string): string => "[...document.querySelectorAll('[role=dialog] button')].find((item) => /" + pattern + "/.test(item.textContent))";
    try {
      writeFileSync(target, SOURCE);
      await client.evaluate(E2E + ".controller.refreshTree()");
      await openByClick(client, "npc", "simulation-target.txt");
      await realClick(client, "document.querySelector('#menu-button-file')", "menu Fichier");
      await client.waitFor("!!document.querySelector('#menu-file')", "menu Fichier deplie");
      await realClick(client, "[...document.querySelectorAll('#menu-file [role=menuitem]')].find((item) => /Simulate NPC dialogue|Simuler le dialogue/.test(item.textContent))", "commande Simuler le dialogue");
      await client.waitFor("!!document.querySelector('[role=dialog] form button.button-primary')", "fenetre de simulation");

      // Un chevalier, choisi par son nom dans la liste des classes du serveur : la constante Job_Knight (7) vient du chargement a la
      // demande des constantes du serveur.
      const classNames = await client.evaluate<string[]>("[...document.querySelectorAll('[role=dialog] select[name=job] option')].map((option) => option.textContent)");
      if (classNames[0] !== "Novice" || !classNames.includes("Knight") || classNames.length < 100 || await client.evaluate<boolean>("!!document.querySelector('[role=dialog] input[name=job]')")) {
        throw new Error("la classe du personnage n'est pas une liste de noms de classe : " + classNames.slice(0, 5).join(", "));
      }
      await client.evaluate("(() => { const field = document.querySelector('[role=dialog] select[name=job]'); field.value = [...field.options].find((option) => option.textContent === 'Knight').value; })()");
      await realClick(client, "document.querySelector('[role=dialog] form button.button-primary')", "Demarrer la simulation");
      await client.waitFor("/Hello Player, class 7 is a knight/.test(document.querySelector('[role=dialog] [role=log]')?.textContent ?? '')", "dialogue du NPC (constante resolue, codes de couleur retires)", 8_000);
      const first = await log();
      if (!/Not simulated|Non simul/.test(first) || !first.includes("cutin")) throw new Error("cutin n'est pas note comme instruction non simulee : " + first);
      if (await client.evaluate<boolean>("!!document.querySelector('[role=dialog] [role=alert]')")) throw new Error("la simulation s'est arretee sur bard_q");
      if (/callfunc/.test(first)) throw new Error("callfunc \"F_Lib\" (fonction d'un autre fichier) n'a pas ete executee : " + first);
      if (!/Ratio 0/.test(first) || !/Invalid operation|Op.ration invalide/.test(first) || !/division by zero|division par z.ro/.test(first)) {
        throw new Error("la division par zero n'est pas notee avec la suite du dialogue : " + first);
      }
      await client.screenshot(join(outDir, "08d-simulation.png"));

      // Page suivante, puis un choix : seule la branche choisie est jouee.
      await realClick(client, button("Next page|Page suivante"), "Page suivante");
      await client.waitFor("!!" + button("^Song$"), "choix du joueur");
      await realClick(client, button("^Song$"), "choix Song");
      await client.waitFor("/A song\\./.test(document.querySelector('[role=dialog] [role=log]')?.textContent ?? '')", "branche choisie");
      if (/A story\\./.test(await log())) throw new Error("la branche non choisie a ete jouee");

      // Saisie d'un nombre au clavier reel, puis close2 : le script continue apres la fermeture du dialogue.
      await client.waitFor("!!document.querySelector('[role=dialog] input[name=answer][type=number]')", "champ de saisie du nombre");
      await client.evaluate("document.querySelector('[role=dialog] input[name=answer]').focus()");
      await client.insertText("5");
      await realClick(client, button("^(Send|Envoyer)$"), "Envoyer");
      await client.waitFor("/Typed 5/.test(document.querySelector('[role=dialog] [role=log]')?.textContent ?? '')", "valeur saisie");
      if (/after close2/.test(await log())) throw new Error("le script a continue avant close2");
      await realClick(client, button("Close the dialogue window|Fermer la fen"), "Fermer la fenetre de dialogue");
      await client.waitFor("/after close2/.test(document.querySelector('[role=dialog] [role=log]')?.textContent ?? '') && !!document.querySelector('[role=dialog] [role=status]')", "suite du script apres close2 et fin du dialogue");
      if (readFileSync(target, "utf8") !== SOURCE) throw new Error("la simulation a modifie le fichier");
    } finally {
      await client
        .evaluate(
          "(async () => { const c = " + E2E + ".controller; if (" + state("dialog") + "?.kind === 'simulation') c.closeDialog(); const p = '" + path + "'; if (c.getManager().has(p)) { await c.requestCloseTab(p); if (" + state("dialog") + "?.kind === 'unsaved-close') await c.resolveUnsaved(p, 'discard'); } })()",
        )
        .catch(() => undefined);
      rmSync(target, { force: true });
      await client.evaluate(E2E + ".controller.refreshTree()").catch(() => undefined);
    }
  });

  await step("Git : aucun processus tant que l'utilisateur n'a pas accepte ; accepte, l'onglet liste les fichiers modifies d'un vrai depot, la comparaison montre HEAD en regard du texte courant, et le depot n'est ni modifie ni execute (crochet de surveillance)", async () => {
    const git = (args: string[]): string => {
      const result = spawnSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: project, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} : ${result.stderr}`);
      return result.stdout;
    };
    const aPath = join(project, "npc", "a.txt");
    const fresh = join(project, "npc", "git-neuf.txt");
    const edited = "// modifie dans l'editeur\n";
    const marker = join(work, "crochet-declenche.txt");
    const index = join(project, ".git", "index");
    const originalA = readFileSync(aPath);
    const dialogKind = `${state("dialog")}?.kind`;
    try {
      git(["init", "-q", "-b", "main"]);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "etat initial"]);
      // Un depot qui declare un programme de surveillance : un `git status` ordinaire l'execute (controle), le produit ne doit pas le faire.
      git(["config", "core.fsmonitor", `echo declenche > '${marker.replace(/\\/g, "/")}'`]);
      writeFileSync(fresh, "// fichier neuf\n");
      // Le fichier modifie l'est comme le ferait l'utilisateur : saisie dans l'editeur, puis Ctrl+S.
      await openByClick(client, "npc", "a.txt");
      await typeAt(client, 1, 1, edited);
      await ctrlKey(client, "s", "KeyS", 83);
      await client.waitFor(`${state('docs["npc/a.txt"]?.dirty')} === false`, "a.txt enregistre");
      if (readFileSync(aPath, "utf8") !== edited + originalA.toString("utf8")) throw new Error("a.txt n'a pas l'ecriture attendue");
      const indexBefore = readFileSync(index);
      await client.evaluate(`${E2E}.controller.refreshTree()`);
      await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
      if ((await client.evaluate<string>(state("git.status"))) !== "off") throw new Error("Git a ete lu avant toute demande de l'utilisateur");

      // Ouverture par le menu Affichage : la boite d'accord s'ouvre, rien n'est lu tant qu'on n'a pas accepte.
      await realClick(client, "document.querySelector('#menu-button-view')", "menu Affichage");
      await client.waitFor("!!document.querySelector('#menu-view')", "menu Affichage deplie");
      await realClick(client, "[...document.querySelectorAll('#menu-view [role=menuitem]')].find((item) => /Show Git changes|Afficher les modifications Git/.test(item.textContent))", "commande Modifications Git");
      await client.waitFor(`${dialogKind} === "git-trust"`, "boite d'accord de Git");
      await client.waitFor(`${state("git.status")} === "unavailable" && ${state("git.reason")} === "not_trusted"`, "Git refuse tant qu'il n'est pas autorise");
      await client.screenshot(join(outDir, "05-git-trust.png"));
      // Le focus est sur « Annuler » : le refus est le choix par defaut.
      const focused = await client.evaluate<string>(`document.activeElement?.textContent ?? ""`);
      if (!/Cancel|Annuler/.test(focused)) throw new Error(`focus de la boite d'accord sur « ${focused} »`);
      await realClick(client, "document.querySelector('[role=dialog] .modal-actions .button-primary')", "Activer Git");
      await client.waitFor(`${state("git.status")} === "ready" && !document.querySelector('[role=dialog]')`, "etat Git lu", 30_000);

      // Les fichiers modifies : exactement ce que git en dit.
      const entries = await client.evaluate<{ path: string; x: string; y: string }[]>(state("git.data.entries"));
      const expected = [
        { path: "npc/a.txt", x: ".", y: "M" },
        { path: "npc/git-neuf.txt", x: "?", y: "?" },
      ];
      if (JSON.stringify([...entries].sort((a, b) => a.path.localeCompare(b.path))) !== JSON.stringify(expected)) throw new Error(`entrees inattendues : ${JSON.stringify(entries)}`);
      const branch = await client.evaluate<string>(state("git.data.branch"));
      if (branch !== "main") throw new Error(`branche ${branch}`);
      await client.waitFor("document.querySelectorAll('.git .git-row').length === 2", "deux lignes dans l'onglet Git");
      const status = await client.evaluate<string>("document.querySelector('.status-git')?.textContent ?? ''");
      if (!/main/.test(status) || !/2/.test(status)) throw new Error(`barre d'etat : « ${status} »`);
      await client.screenshot(join(outDir, "06-git-panel.png"));

      // Le depot n'a pas ete touche, et son programme de surveillance n'a pas ete execute.
      if (!readFileSync(index).equals(indexBefore)) throw new Error("l'index du depot a ete reecrit");
      if (existsSync(join(project, ".git", "index.lock"))) throw new Error("un verrou a ete laisse dans le depot");
      if (existsSync(marker)) throw new Error("le programme que le depot declare a ete execute par l'application");
      git(["status", "-s"]);
      if (!existsSync(marker)) process.stdout.write("        (note : ce git n'a pas execute le programme avec un status ordinaire ; le controle est sans portee ici)\n");

      // Comparer : « Git (HEAD) » en regard du texte courant, dans le vrai editeur de differences de Monaco.
      await realClick(client, "[...document.querySelectorAll('.git-row button.button-small')].find((button) => (button.getAttribute('aria-label') ?? '').includes('a.txt'))", "Comparer a.txt");
      await client.waitFor("!!document.querySelector('[role=dialog] .monaco-diff-editor')", "comparaison ouverte", 20_000);
      const head = git(["show", "HEAD:npc/a.txt"]);
      const sides = async (): Promise<{ original: string; modified: string }> =>
        client.evaluate(`(async () => { const monaco = await ${E2E}.monaco(); const editor = monaco.editor.getDiffEditors()[0]; return { original: editor.getOriginalEditor().getValue(), modified: editor.getModifiedEditor().getValue() }; })()`);
      const started = Date.now();
      let seen = await sides();
      while (seen.original !== head && Date.now() - started < 10_000) {
        await sleep(100);
        seen = await sides();
      }
      if (seen.original !== head) throw new Error(`cote HEAD : ${JSON.stringify(seen.original)} au lieu de ${JSON.stringify(head)}`);
      if (seen.modified !== edited + originalA.toString("utf8")) throw new Error(`cote courant : ${JSON.stringify(seen.modified)}`);
      if (seen.original === seen.modified) throw new Error("les deux cotes sont identiques");
      await client.screenshot(join(outDir, "07-git-diff.png"));
      await keyWith(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "comparaison fermee");

      // Un fichier neuf : tout est ajoute, et la boite le dit.
      await realClick(client, "[...document.querySelectorAll('.git-row button.button-small')].find((button) => (button.getAttribute('aria-label') ?? '').includes('git-neuf.txt'))", "Comparer git-neuf.txt");
      await client.waitFor("!!document.querySelector('[role=dialog] .monaco-diff-editor')", "comparaison du fichier neuf", 20_000);
      await client.waitFor("/not in HEAD|n'est pas dans HEAD/.test(document.querySelector('[role=dialog]')?.textContent ?? '')", "mention « pas dans HEAD »");
      await keyWith(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "comparaison du fichier neuf fermee");

      // Enregistrer un fichier ouvert releve l'etat Git quand l'onglet est affiche (apres une courte pause), sans autre action.
      const readAt = await client.evaluate<number>(state("git.refreshedAt"));
      await client.evaluate(`${E2E}.controller.setBottomTab("git")`);
      await typeAt(client, 1, 1, "// ");
      await ctrlKey(client, "s", "KeyS", 83);
      await client.waitFor(`${state('docs["npc/a.txt"]?.dirty')} === false`, "a.txt enregistre");
      await client.waitFor(`${state("git.status")} === "ready" && ${state("git.refreshedAt")} > ${readAt}`, "etat Git relu apres l'enregistrement", 20_000);
      const count = await client.evaluate<number>(state("git.data.entries.length"));
      if (count !== 2) throw new Error(`${count} entrees apres l'enregistrement`);
      const still = git(["status", "--porcelain=v1"]);
      if (!/ M npc\/a\.txt/.test(still) || !/\?\? npc\/git-neuf\.txt/.test(still)) throw new Error(`git status : ${still}`);
    } finally {
      await client
        .evaluate(
          `(async () => { const c = ${E2E}.controller; c.closeDialog(); c.setBottomTab("problems"); for (const p of ["npc/a.txt"]) { if (c.getManager().has(p)) { await c.requestCloseTab(p); if (${state("dialog")}?.kind === "unsaved-close") await c.resolveUnsaved(p, "discard"); } } })()`,
        )
        .catch(() => undefined);
      writeFileSync(aPath, originalA);
      rmSync(fresh, { force: true });
      rmSync(join(project, ".git"), { recursive: true, force: true });
      rmSync(marker, { force: true });
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  await step("deploiement vers un dossier : le plan n'ecrit rien ; confirme, il sauvegarde le fichier remplace dans le projet, copie, verifie et note le deploiement ; la restauration remet la version d'avant", async () => {
    const folder = join(project, "npc", "deploy-test");
    const X = 'prontera,20,20,4\tscript\tDeployX\t100,{\n\tclose;\n}\n';
    const Y = 'prontera,21,21,4\tscript\tDeployY\t100,{\n\tclose;\n}\n';
    const OLD_Y = "// version du serveur, jamais deployee d'ici\n";
    const target = (name: string): string => join(destination, "npc", "deploy-test", name);
    const deployDirectory = join(project, ".runeforge", "deploy");
    try {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "x.txt"), X);
      writeFileSync(join(folder, "y.txt"), Y);
      mkdirSync(join(destination, "npc", "deploy-test"), { recursive: true });
      writeFileSync(target("y.txt"), OLD_Y);
      await client.evaluate(`${E2E}.controller.refreshTree()`);

      await realClick(client, "document.querySelector('#menu-button-file')", "menu Fichier");
      await client.waitFor("!!document.querySelector('#menu-file')", "menu Fichier deplie");
      await realClick(client, "[...document.querySelectorAll('#menu-file [role=menuitem]')].find((item) => /Deploy to a folder|Deployer vers un dossier|Déployer vers un dossier/.test(item.textContent))", "commande Deployer");
      await client.waitFor("!!document.querySelector('[role=dialog] .deploy-destination')", "boite de deploiement ouverte");

      // Destination (la construction de test l'approuve sans boite du systeme) et dossier du projet a deployer.
      await realClick(client, "document.querySelector('[role=dialog] .deploy-destination button')", "Choisir un dossier");
      await client.waitFor("!!document.querySelector('[role=dialog] .deploy-path') && document.querySelector('[role=dialog] .deploy-path').textContent.length > 3 && !/No folder|Aucun dossier/.test(document.querySelector('[role=dialog] .deploy-path').textContent)", "destination choisie");
      await client.evaluate("(() => { const input = [...document.querySelectorAll('[role=dialog] input[type=text]')].find((item) => item.value === 'npc/custom' || item.value === ''); input.focus(); input.select(); })()");
      await client.insertText("npc/deploy-test");
      await realClick(client, "[...document.querySelectorAll('[role=dialog] button')].find((button) => /Prepare the plan|Preparer le plan|Préparer le plan/.test(button.textContent))", "Preparer le plan");
      await client.waitFor("!!document.querySelector('[role=dialog] .deploy-plan .deploy-list')", "plan affiche", 20_000);

      // Dry-run : x.txt a creer, y.txt en conflit (il existe a la destination sans que nous l'y ayons mis) ; rien n'a ete ecrit.
      const rows = await client.evaluate<string[]>("[...document.querySelectorAll('[role=dialog] .deploy-plan .deploy-row')].map((row) => row.className.replace('deploy-row deploy-row-', '') + ':' + row.textContent)");
      if (rows.length !== 2 || !rows[0]?.startsWith("create:") || !rows[0].includes("npc/deploy-test/x.txt") || !rows[1]?.startsWith("conflict:") || !rows[1].includes("npc/deploy-test/y.txt")) {
        throw new Error(`plan inattendu : ${JSON.stringify(rows)}`);
      }
      if (existsSync(target("x.txt")) || readFileSync(target("y.txt"), "utf8") !== OLD_Y) throw new Error("le plan a ecrit dans la destination");
      if (existsSync(deployDirectory)) throw new Error("le plan a ecrit dans le projet");
      await client.screenshot(join(outDir, "08-deploy-plan.png"));

      // On decide d'ecraser le conflit, puis on deploie.
      await realClick(client, "document.querySelector('[role=dialog] .deploy-plan input[type=checkbox]')", "Ecraser les conflits");
      await realClick(client, "document.querySelector('[role=dialog] .modal-actions .button-primary')", "Deployer");
      await client.waitFor("!!document.querySelector('[role=dialog] .deploy-result')", "resultat du deploiement", 30_000);
      if (readFileSync(target("x.txt"), "utf8") !== X) throw new Error("x.txt n'a pas ete copie");
      if (readFileSync(target("y.txt"), "utf8") !== Y) throw new Error("y.txt n'a pas ete remplace");
      const manifests = readdirSync(deployDirectory);
      if (manifests.length !== 1) throw new Error(`dossiers de deploiement : ${JSON.stringify(manifests)}`);
      const base = join(deployDirectory, manifests[0] as string);
      const backups = readdirSync(join(base, "backups"));
      const backupFile = join(base, "backups", backups[0] as string, "npc", "deploy-test", "y.txt.bak");
      if (backups.length !== 1 || readFileSync(backupFile, "utf8") !== OLD_Y) throw new Error("la version remplacee n'a pas ete sauvegardee dans le projet");
      const manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8")) as { files: Record<string, string> };
      if (Object.keys(manifest.files).sort().join(",") !== "npc/deploy-test/x.txt,npc/deploy-test/y.txt") throw new Error(`manifeste : ${JSON.stringify(manifest)}`);
      const report = await client.evaluate<string>("document.querySelector('[role=dialog] .deploy-result')?.textContent ?? ''");
      if (!/2 created|2 créé/.test(report) && !/1 created, 0 updated, 1 overwritten|1 créé\(s\), 0 mis à jour, 1 écrasé/.test(report)) throw new Error(`resume : ${report}`);
      await client.screenshot(join(outDir, "09-deploy-done.png"));

      // Restauration : y.txt retrouve la version du serveur ; x.txt, cree par le deploiement, reste en place.
      await realClick(client, "[...document.querySelectorAll('[role=dialog] .modal-actions button')].find((button) => /Restore the previous versions|Restaurer les versions/.test(button.textContent))", "Restaurer");
      await client.waitFor("/Restored: 1|Restauré : 1/.test(document.querySelector('[role=dialog]')?.textContent ?? '')", "restauration faite", 20_000);
      if (readFileSync(target("y.txt"), "utf8") !== OLD_Y) throw new Error("y.txt n'a pas ete restaure");
      if (readFileSync(target("x.txt"), "utf8") !== X) throw new Error("x.txt, cree par le deploiement, aurait du rester en place");
      // Les fichiers du projet n'ont pas bouge.
      if (readFileSync(join(folder, "x.txt"), "utf8") !== X || readFileSync(join(folder, "y.txt"), "utf8") !== Y) throw new Error("un fichier du projet a ete modifie");
    } finally {
      await client.evaluate(`${E2E}.controller.closeDialog()`).catch(() => undefined);
      rmSync(folder, { recursive: true, force: true });
      rmSync(deployDirectory, { recursive: true, force: true });
      rmSync(join(destination, "npc"), { recursive: true, force: true });
      await client.evaluate(`${E2E}.controller.refreshTree()`).catch(() => undefined);
    }
  });

  await step("theme sombre applique a l'interface et a Monaco", async () => {
    await client.evaluate(`${E2E}.controller.updateSettings({ theme: "dark" })`);
    await client.waitFor(`document.documentElement.dataset.theme === "dark"`, "attribut data-theme");
    await sleep(300);
    await client.screenshot(join(outDir, "03-dark.png"));
    await client.evaluate(`${E2E}.controller.updateSettings({ theme: "light" })`);
  });

  await step("modification externe d'un document inchange : rechargement automatique au retour du focus", async () => {
    await openByClick(client, "npc", "a.txt");
    writeFileSync(join(project, "npc", "a.txt"), "externe\n");
    await client.evaluate(`window.dispatchEvent(new Event("focus"))`);
    await client.waitFor(`${E2E}.controller.getManager().textOf("npc/a.txt") === "externe\\n"`, "document recharge");
  });

  await step("modification externe d'un document modifie : conflit, jamais d'ecrasement silencieux", async () => {
    await typeAt(client, 1, 8, "MIEN");
    await client.waitFor(isDirty("npc/a.txt"), "document modifie");
    writeFileSync(join(project, "npc", "a.txt"), "re-externe\n");
    await ctrlKey(client, "s", "KeyS", 83);
    await client.waitFor(`${state("dialog?.kind")} === "conflict"`, "dialogue de conflit");
    expectBytes(readFileSync(join(project, "npc", "a.txt")), Buffer.from("re-externe\n"), "a.txt apres tentative d'enregistrement");
    await client.screenshot(join(outDir, "04-conflict.png"));
    await client.evaluate(`document.querySelector('.modal .button-danger').click()`);
    await client.waitFor(`${state("dialog")} === null && ${state('docs["npc/a.txt"]?.dirty')} === false`, "ecrasement explicite termine");
    if (!readFileSync(join(project, "npc", "a.txt"), "utf8").includes("MIEN")) throw new Error("l'ecrasement explicite n'a pas ecrit la version de l'utilisateur");
  });

  await step("plantage simule : l'instantane de recuperation est ecrit puis propose au redemarrage", async () => {
    await openByClick(client, "npc", "a.txt");
    const before = readFileSync(join(project, "npc", "a.txt"));
    await typeAt(client, 1, 1, "// BROUILLON NON ENREGISTRE\n");
    await client.waitFor(isDirty("npc/a.txt"), "document modifie");
    // Attend l'ecriture de l'instantane (delai par defaut 1500 ms).
    const recoveryRoot = join(appData, "data", "recovery");
    const started = Date.now();
    let found = false;
    while (Date.now() - started < 8000 && !found) {
      found = existsSync(recoveryRoot) && readdirSync(recoveryRoot).some((folder) => readdirSync(join(recoveryRoot, folder)).some((file) => file.endsWith(".rfrec")));
      if (!found) await sleep(250);
    }
    if (!found) throw new Error("aucun instantane de recuperation ecrit");
    session.cdp?.close();
    session.app?.kill(); // arret brutal : aucun gestionnaire de fermeture n'est execute
    await sleep(800);
    expectBytes(readFileSync(join(project, "npc", "a.txt")), before, "a.txt apres plantage (inchange)");

    startApp();
    const restarted = await connect();
    session.cdp = restarted;
    await restarted.waitFor(`${state("dialog?.kind")} === "recovery"`, "dialogue de recuperation", 20_000);
    await restarted.screenshot(join(outDir, "05-recovery.png"));
    await restarted.evaluate(`document.querySelector('.recovery-actions button').click()`);
    await restarted.waitFor(`${state("activePath")} === "npc/a.txt" && ${state('docs["npc/a.txt"]?.dirty')} === true`, "document restaure et modifie");
    const restored = await restarted.evaluate<string>(`${E2E}.controller.getManager().textOf("npc/a.txt")`);
    if (!restored.startsWith("// BROUILLON NON ENREGISTRE")) throw new Error("le brouillon n'a pas ete restaure");
    await ctrlKey(restarted, "s", "KeyS", 83);
    await restarted.waitFor(`${state('docs["npc/a.txt"]?.dirty')} === false`, "restauration enregistree");
    if (!readFileSync(join(project, "npc", "a.txt"), "utf8").startsWith("// BROUILLON NON ENREGISTRE")) throw new Error("le brouillon n'est pas sur le disque");
  });

  await step("fermeture de la fenetre avec des modifications : differee, puis ferme apres abandon explicite", async () => {
    const c = session.cdp as Cdp;
    await typeAt(c, 1, 1, "x");
    await c.waitFor(isDirty("npc/a.txt"), "document modifie");
    await c.waitFor(`${E2E}.controller.getManager().dirtyPaths().length === 1`, "etat modifie propage");
    await sleep(300); // laisse partir set_dirty vers le coeur
    const pid = session.app?.pid;
    spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`], { stdio: "ignore" });
    await c.waitFor(`${state("dialog?.kind")} === "exit"`, "dialogue de sortie");
    if (!session.app?.running) throw new Error("l'application s'est fermee malgre des modifications non enregistrees");
    await c.screenshot(join(outDir, "06-exit.png"));
    await c.evaluate(`${E2E}.controller.resolveExit("cancel")`);
    await sleep(500);
    if (!session.app?.running) throw new Error("l'application s'est fermee apres Annuler");
    await c.evaluate(`${E2E}.controller.resolveExit("discard")`);
    const waited = Date.now();
    while (session.app?.running && Date.now() - waited < 8000) await sleep(200);
    if (session.app?.running) throw new Error("l'application ne s'est pas fermee apres l'abandon explicite");
  });

  // Aucun filtre : une violation de CSP pendant l'usage normal (Monaco, workers) doit faire echouer le test.
  const unexpected = session.cdp?.consoleErrors ?? [];
  await step("aucune erreur inattendue dans la console", async () => {
    if (unexpected.length > 0) throw new Error(unexpected.join("\n        "));
  });
}

try {
  await main();
} catch (error) {
  results.push({ name: "execution du scenario", ok: false, detail: error instanceof Error ? error.stack ?? error.message : String(error) });
  console.log(`  FAIL  execution du scenario\n        ${results[results.length - 1]?.detail}`);
} finally {
  session.cdp?.close();
  session.app?.kill();
  await sleep(500);
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} etapes reussies`);
process.exit(failed.length === 0 ? 0 : 1);
