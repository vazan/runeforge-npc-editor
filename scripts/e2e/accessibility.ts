/**
 * Audit d'accessibilite de l'application reelle (WebView2), sans dependance : arbre d'accessibilite du navigateur (CDP
 * `Accessibility.getFullAXTree`), contrastes WCAG calcules sur les styles reellement appliques (themes clair et sombre), parcours
 * au clavier avec la vraie touche Tab, dialogues (focus pris, piege, rendu).
 *
 * Usage : pnpm exec tsx scripts/e2e/accessibility.ts <chemin-de-l-exe-e2e> [dossier-de-captures]
 * L'executable doit avoir ete construit avec `--features e2e`. Rien n'est ecrit hors d'un dossier temporaire.
 *
 * Verifications (criteres WCAG 2.1 AA) :
 * 1. noms accessibles : tout controle de l'arbre d'accessibilite (bouton, champ, onglet, ligne d'arbre, menu...) en a un (4.1.2) ;
 * 2. langue : `<html lang>` suit la langue de l'application (3.1.1) ;
 * 3. contrastes : texte >= 4,5:1 (3:1 si grand), sur l'arriere-plan reel, dans les deux themes et dans chaque ecran (1.4.3) ;
 * 4. clavier : Tab parcourt l'interface sans piege, chaque arret a un nom et un indicateur de focus visible (2.1.1, 2.4.7, 4.1.2) ;
 * 5. dialogues : le focus entre dans le dialogue, Tab et Maj+Tab y restent, Echap le ferme et rend le focus (2.1.2, 2.4.3).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, launch, sleep } from "./cdp";

const [exeArgument, outArgument] = process.argv.slice(2);
if (exeArgument === undefined) {
  console.error("Usage : tsx scripts/e2e/accessibility.ts <exe-e2e> [dossier-captures]");
  process.exit(2);
}
const exe: string = exeArgument;
const outDir = outArgument;
if (outDir !== undefined) mkdirSync(outDir, { recursive: true });
const PORT = 9336;
const E2E = "window.__RUNEFORGE_E2E__";
const state = (expression: string): string => `${E2E}.store.getState().${expression}`;

const work = mkdtempSync(join(tmpdir(), "runeforge-a11y-"));
const project = join(work, "project");
// Destination d'un deploiement de test : la construction E2E l'approuve sans boite de dialogue du systeme.
mkdirSync(join(work, "destination"), { recursive: true });
mkdirSync(join(project, "npc"), { recursive: true });
writeFileSync(join(project, "npc", "a.txt"), 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n');
// Une erreur de syntaxe : le panneau des problemes a du contenu a auditer.
writeFileSync(join(project, "npc", "bad.txt"), 'prontera,3,3,0\tscript\tB\t100,{\n\tmes "a"\n}\n');
writeFileSync(join(project, "npc", "lib.txt"), "function\tscript\tF_Lib\t{\n\treturn;\n}\n");
// Un NPC pour l'editeur visuel : messages, un if avec ses deux branches et un bloc brut (un appel de fonction). La simulation y
// note une instruction non simulee (cutin) et une operation que le serveur refuserait (division par zero) : les deux a auditer.
writeFileSync(
  join(project, "npc", "visual.txt"),
  ['prontera,150,150,4\tscript\tVisualGuide\t100,{', '\tmes "[Guide]";', '\tmes "Welcome, traveler.";', '\tcutin "guide", 2;', "\tmes 10 / .@zero;", "\tnext;", "\tif (BaseLevel > 50) {", '\t\tmes "You are strong.";', "\t} else {", '\t\tmes "Train more.";', "\t}", '\tcallfunc "F_Lib";', "\tclose;", "}", ""].join("\n"),
);

const findings: { audit: string; message: string }[] = [];
const fail = (audit: string, message: string): void => {
  findings.push({ audit, message });
};
const summary: string[] = [];

// ---------------------------------------------------------------------------------------------------------------------------
// Contrastes (calcules dans la page, sur les styles appliques)
// ---------------------------------------------------------------------------------------------------------------------------

const CONTRAST_SCAN = `(() => {
  const parse = (value) => {
    let m = /^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+%?))?\\s*\\)$/.exec(value);
    if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])];
    m = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\s*\\)$/.exec(value);
    if (m) return [parseFloat(m[1]) * 255, parseFloat(m[2]) * 255, parseFloat(m[3]) * 255, m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])];
    return null;
  };
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat([a]);
  };
  const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const ratio = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const root = parse(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255, 1];
  const page = root[3] === 0 ? [255, 255, 255, 1] : root;
  const editorBackground = (() => { const e = document.querySelector('.monaco-editor-background'); return e ? parse(getComputedStyle(e).backgroundColor) : null; })();
  const background = (element) => {
    if (editorBackground && element.closest('.monaco-editor')) return editorBackground;
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') return null;
      const color = parse(style.backgroundColor);
      if (color && color[3] > 0) { layers.push(color); if (color[3] >= 0.999) break; }
    }
    let result = layers.length && layers[layers.length - 1][3] >= 0.999 ? layers.pop() : page;
    while (layers.length) result = over(layers.pop(), result);
    return result;
  };
  const opacityOf = (element) => { let value = 1; for (let node = element; node; node = node.parentElement) value *= parseFloat(getComputedStyle(node).opacity); return value; };
  const label = (element) => { const parts = []; for (let node = element, i = 0; node && node !== document.body && i < 3; node = node.parentElement, i += 1) parts.push(node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')); return parts.join(' < '); };
  const groups = new Map();
  let checked = 0, unknown = 0;
  for (const element of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'svg', 'path', 'CANVAS'].includes(element.tagName)) continue;
    const own = [...element.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own === '') continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width === 0 || rect.height === 0 || style.visibility !== 'visible' || style.display === 'none') continue;
    if (element.closest('[disabled], [aria-disabled="true"], [hidden], [aria-hidden="true"]')) continue;
    const fg = parse(style.color);
    const bg = background(element);
    if (!fg || !bg) { unknown += 1; continue; }
    const alpha = fg[3] * opacityOf(element);
    const text = over([fg[0], fg[1], fg[2], alpha], bg);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight, 10) >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(text, bg);
    checked += 1;
    if (got + 1e-9 < need) {
      const key = [style.color, 'sur', bg.map((v) => Math.round(v)).join(','), size, style.fontWeight].join(' ');
      const group = groups.get(key) || { count: 0, ratio: got, need, sample: own.slice(0, 40), where: label(element) };
      group.count += 1;
      groups.set(key, group);
    }
  }
  return { checked, unknown, failures: [...groups].map(([key, value]) => ({ key, ...value })).sort((a, b) => a.ratio - b.ratio) };
})()`;

interface ContrastResult {
  readonly checked: number;
  readonly unknown: number;
  readonly failures: { key: string; count: number; ratio: number; need: number; sample: string; where: string }[];
}

async function contrast(client: Cdp, label: string): Promise<void> {
  const result = await client.evaluate<ContrastResult>(CONTRAST_SCAN);
  summary.push(`contraste ${label} : ${result.checked} textes verifies, ${result.unknown} sur fond non uniforme (non juges), ${result.failures.length} combinaison(s) insuffisante(s)`);
  for (const failure of result.failures.slice(0, 12)) {
    fail("contraste", `${label} : ${failure.ratio.toFixed(2)}:1 < ${failure.need}:1 (${failure.count} element(s)) ${failure.key} - « ${failure.sample} » dans ${failure.where}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Noms accessibles (arbre d'accessibilite du navigateur)
// ---------------------------------------------------------------------------------------------------------------------------

const NAMED_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "combobox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "treeitem", "option", "slider", "spinbutton", "listbox", "tree", "dialog", "tablist", "img", "progressbar", "menu", "region",
]);

interface AxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: { value: string };
  readonly name?: { value?: string };
  readonly backendDOMNodeId?: number;
}

async function names(client: Cdp, label: string): Promise<void> {
  await client.send("DOM.enable");
  await client.send("Accessibility.enable");
  const { nodes } = await client.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
  const roles = new Map<string, number>();
  let unnamed = 0;
  for (const node of nodes) {
    if (node.ignored === true || node.role?.value === undefined) continue;
    const role = node.role.value;
    roles.set(role, (roles.get(role) ?? 0) + 1);
    if (!NAMED_ROLES.has(role) || (node.name?.value ?? "").trim() !== "") continue;
    unnamed += 1;
    if (unnamed > 10) continue;
    let description = `role=${role}`;
    if (node.backendDOMNodeId !== undefined) {
      const described = await client
        .send<{ node: { localName: string; attributes?: string[] } }>("DOM.describeNode", { backendNodeId: node.backendDOMNodeId })
        .catch(() => null);
      const attributes = described?.node.attributes ?? [];
      const className = attributes[attributes.indexOf("class") + 1] ?? "";
      description += ` <${described?.node.localName ?? "?"}${className === "" ? "" : ` class="${className}"`}>`;
    }
    fail("noms", `${label} : controle sans nom accessible : ${description}`);
  }
  const common = ["button", "tab", "treeitem", "textbox", "menuitem", "dialog", "tree", "tablist"].map((role) => `${role} ${roles.get(role) ?? 0}`).join(", ");
  summary.push(`noms ${label} : ${nodes.length} noeuds, ${unnamed} controle(s) sans nom (${common})`);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Clavier : vraie touche Tab, indicateur de focus
// ---------------------------------------------------------------------------------------------------------------------------

const tabKey = async (client: Cdp, shift = false): Promise<void> => {
  const common = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
};

const SIGNATURE = `(() => {
  const signature = (element) => { const s = getComputedStyle(element); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.backgroundColor, s.color, s.textDecorationLine].join('|'); };
  window.__a11y = { signature, before: new Map() };
  for (const element of document.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex], [role=treeitem], [role=tab]')) window.__a11y.before.set(element, signature(element));
  return window.__a11y.before.size;
})()`;

const ACTIVE = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  const a = window.__a11y;
  const rect = element.getBoundingClientRect();
  const aria = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('aria-labelledby') || '';
  const text = (element.innerText || element.value || '').trim().slice(0, 30);
  const monaco = !!element.closest('.monaco-editor');
  const before = a.before.get(element);
  const after = a.signature(element);
  const labelled = element.getAttribute('aria-labelledby') ? (document.getElementById(element.getAttribute('aria-labelledby'))?.textContent || '') : '';
  return {
    id: element.tagName.toLowerCase() + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + (element.getAttribute('role') ? '[' + element.getAttribute('role') + ']' : ''),
    name: (aria || labelled || text),
    monaco,
    changed: before === undefined ? null : before !== after,
    visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    inDialog: !!element.closest('[role=dialog]'),
  };
})()`;

interface Stop {
  readonly id: string;
  readonly name: string;
  readonly monaco: boolean;
  readonly changed: boolean | null;
  readonly visible: boolean;
  readonly inDialog: boolean;
}

async function keyboard(client: Cdp, label: string, maxStops = 70): Promise<void> {
  const candidates = await client.evaluate<number>(SIGNATURE);
  // Point de depart : le premier controle focalisable de la page, puis la vraie touche Tab.
  await client.evaluate("document.body.querySelector('a[href], button:not([disabled]), input:not([disabled]), [tabindex=\"0\"]')?.focus()");
  const stops: Stop[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < maxStops; step += 1) {
    if (step > 0) {
      await tabKey(client);
      await sleep(25);
    }
    const stop = await client.evaluate<Stop | null>(ACTIVE);
    if (stop === null) {
      // Le focus a quitte les controles (ou n'a jamais pu y entrer) : on le dit, un audit sans arret ne prouve rien.
      const where = await client.evaluate<string>("document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : 'aucun'");
      if (stops.length === 0) fail("clavier", `${label} : aucun arret de Tab (element actif : ${where})`);
      break;
    }
    const key = `${stop.id}|${stop.name}`;
    if (stop.monaco) {
      // Monaco prend Tab pour l'indentation : on sort de l'editeur avec Echap puis Tab (comportement documente de Monaco).
      stops.push(stop);
      break;
    }
    if (seen.has(key) && stops.length > 2) break;
    seen.add(key);
    stops.push(stop);
  }
  let withoutName = 0;
  let withoutIndicator = 0;
  for (const stop of stops) {
    if (stop.name.trim() === "") {
      withoutName += 1;
      fail("clavier", `${label} : arret de Tab sans nom : ${stop.id}`);
    }
    if (stop.changed === false) {
      withoutIndicator += 1;
      fail("clavier", `${label} : aucun indicateur de focus visible sur ${stop.id} « ${stop.name} »`);
    }
    if (!stop.visible) fail("clavier", `${label} : le focus est sur un element hors de la fenetre : ${stop.id}`);
  }
  summary.push(`clavier ${label} : ${stops.length} arrets de Tab (${candidates} elements focalisables), ${withoutName} sans nom, ${withoutIndicator} sans indicateur de focus`);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Dialogues
// ---------------------------------------------------------------------------------------------------------------------------

const keyCombo = async (client: Cdp, modifiers: number, key: string, code: string, vk: number): Promise<void> => {
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, windowsVirtualKeyCode: vk });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: vk });
};

async function dialog(client: Cdp, label: string, open: () => Promise<void>): Promise<void> {
  // Le focus est d'abord sur un vrai controle (un bouton de la barre d'activite, qui n'est jamais recree) : c'est lui que le dialogue doit retrouver en se fermant.
  await client.evaluate("(() => { const opener = document.querySelector('.activity-button') || document.querySelector('button'); opener.focus(); window.__opener = opener; })()");
  await open();
  await client.waitFor("!!document.querySelector('[role=dialog]')", `${label} ouvert`, 8_000);
  const info = await client.evaluate<{ modal: string | null; name: string; inside: boolean }>(
    `(() => { const d = document.querySelector('[role=dialog]'); const id = d.getAttribute('aria-labelledby'); const name = d.getAttribute('aria-label') || (id ? (document.getElementById(id)?.textContent || '') : ''); return { modal: d.getAttribute('aria-modal'), name, inside: d.contains(document.activeElement) }; })()`,
  );
  if (info.modal !== "true") fail("dialogue", `${label} : aria-modal absent`);
  if (info.name.trim() === "") fail("dialogue", `${label} : dialogue sans nom accessible`);
  if (!info.inside) fail("dialogue", `${label} : le focus n'est pas entre dans le dialogue`);
  let escaped = 0;
  for (let press = 0; press < 25; press += 1) {
    await tabKey(client, press % 5 === 4);
    await sleep(20);
    if (!(await client.evaluate<boolean>("!!document.querySelector('[role=dialog]')?.contains(document.activeElement)"))) escaped += 1;
  }
  if (escaped > 0) fail("dialogue", `${label} : le focus est sorti du dialogue ${escaped} fois en 25 appuis sur Tab (piege absent)`);
  await keyCombo(client, 0, "Escape", "Escape", 27);
  await client.waitFor("!document.querySelector('[role=dialog]')", `${label} ferme par Echap`, 6_000).catch(() => fail("dialogue", `${label} : Echap ne ferme pas le dialogue`));
  const restored = await client.evaluate<string>("document.activeElement === window.__opener ? 'OPENER' : (document.activeElement ? document.activeElement.tagName : 'NONE')");
  if (restored !== "OPENER") fail("dialogue", `${label} : le focus n'est pas rendu au controle qui avait ouvert le dialogue (apres la fermeture : <${restored.toLowerCase()}>)`);
  summary.push(`dialogue ${label} : modal ${info.modal}, nom « ${info.name.trim()} », piege ${escaped === 0 ? "ok" : "ROMPU"}, focus ${restored === "OPENER" ? "rendu au controle d'origine" : `perdu (<${restored.toLowerCase()}>)`}`);
}

// ---------------------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const app = launch({ exe, port: PORT, webviewDataDir: join(work, "webview"), env: { RUNEFORGE_E2E_PROJECT: project, RUNEFORGE_E2E_DATA_DIR: join(work, "data"), RUNEFORGE_E2E_DESTINATION: join(work, "destination") } });
  let client: Cdp | null = null;
  try {
    client = await Cdp.connect(PORT, 60_000, 50);
    // La fenetre pilotee n'est pas forcement celle qui a le focus du systeme : sans cela, Tab ne deplace pas le focus.
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await client.waitFor(`!!${E2E} && ${state("ready")} && ${state("project")} !== null && ${state("indexing.status")} === "done"`, "projet ouvert et indexe", 40_000);
    const shot = async (name: string): Promise<void> => {
      if (outDir !== undefined && client !== null) await client.screenshot(join(outDir, `a11y-${name}.png`));
    };

    // Langue de l'application.
    for (const language of ["en", "fr"] as const) {
      await client.evaluate(`${E2E}.controller.updateSettings({ language: "${language}" })`);
      await sleep(250);
      const lang = await client.evaluate<string>("document.documentElement.lang");
      if (!lang.toLowerCase().startsWith(language)) fail("langue", `<html lang="${lang}"> alors que l'application est en « ${language} »`);
      summary.push(`langue : <html lang="${lang}"> pour l'interface « ${language} »`);
    }
    await client.evaluate(`${E2E}.controller.updateSettings({ language: "en" })`);

    for (const theme of ["light", "dark"] as const) {
      await client.evaluate(`${E2E}.controller.updateSettings({ theme: "${theme}" })`);
      await sleep(300);
      // Ecran 1 : espace de travail avec un fichier ouvert et le panneau des problemes.
      await client.evaluate(`${E2E}.controller.openFile("npc/bad.txt")`);
      await client.waitFor("!!document.querySelector('.monaco-editor .view-lines [class*=mtk]')", "Monaco affiche le fichier", 20_000);
      await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
      await sleep(600);
      await shot(`${theme}-workbench`);
      await contrast(client, `${theme} / espace de travail`);
      if (theme === "light") await names(client, "espace de travail");
      // Ecran 2 : rapport de projet.
      await client.evaluate(`${E2E}.controller.showProjectReport()`);
      await client.waitFor("!!document.querySelector('.report')", "rapport de projet", 15_000);
      await sleep(800);
      await shot(`${theme}-report`);
      await contrast(client, `${theme} / rapport de projet`);
      if (theme === "light") await names(client, "rapport de projet");
      await client.evaluate(`${E2E}.controller.setBottomTab("problems")`);
      // Ecran 3 : parametres.
      await keyCombo(client, 2, ",", "Comma", 188);
      await client.waitFor("!!document.querySelector('[role=dialog]')", "dialogue des parametres", 8_000);
      await sleep(400);
      await shot(`${theme}-settings`);
      await contrast(client, `${theme} / parametres`);
      if (theme === "light") await names(client, "parametres");
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "parametres fermes", 6_000);
      // Ecran 3b : parametres, onglet Mises a jour. Les etats « mise a jour disponible » (avec un echec) puis « telechargement » sont poses
      // dans le magasin : la vraie interface les affiche, sans contacter personne.
      const available = `{ kind: "available", current: "0.0.0", version: "9.9.9", channel: "stable", notes: "Notes de test.\\nDeuxieme ligne.", publishedAt: "2026-11-15T10:00:00Z", size: 12345678 }`;
      await client.evaluate(`${E2E}.controller.openSettings("updates")`);
      await client.waitFor("!!document.querySelector('[role=dialog] .update-actions')", "onglet Mises a jour", 8_000);
      await client.evaluate(`${E2E}.store.setState({ update: { status: "available", update: ${available}, failure: { code: "bad_signature" } } })`);
      await client.waitFor("!!document.querySelector('[role=dialog] .update-notes') && !!document.querySelector('[role=dialog] [role=alert]')", "mise a jour disponible et son echec affiches", 8_000);
      await sleep(400);
      await shot(`${theme}-updates`);
      await contrast(client, `${theme} / mises a jour`);
      if (theme === "light") await names(client, "mises a jour");
      await client.evaluate(`${E2E}.store.setState({ update: { status: "installing", update: ${available}, received: 5000000, total: 12345678 } })`);
      await client.waitFor("!!document.querySelector('[role=dialog] progress')", "barre de progression du telechargement", 8_000);
      await sleep(300);
      await shot(`${theme}-updates-installing`);
      await contrast(client, `${theme} / mises a jour (telechargement)`);
      if (theme === "light") await names(client, "mises a jour (telechargement)");
      await client.evaluate(`${E2E}.store.setState({ update: { status: "idle" } })`);
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "mises a jour fermees", 6_000);
      // Ecran 4 : palette de commandes.
      await keyCombo(client, 10, "P", "KeyP", 80);
      await client.waitFor("!!document.querySelector('[role=dialog]')", "palette ouverte", 8_000);
      await sleep(400);
      await shot(`${theme}-palette`);
      await contrast(client, `${theme} / palette de commandes`);
      if (theme === "light") await names(client, "palette de commandes");
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "palette fermee", 6_000);
      // Ecran 5 : assistant de NPC (formulaire, script produit, verification locale terminee).
      await client.evaluate(`${E2E}.controller.openNpcWizard()`);
      await client.waitFor("!!document.querySelector('[role=dialog] .wizard-check-ok, [role=dialog] .wizard-diagnostics')", "verification locale de l'assistant terminee", 20_000);
      await sleep(300);
      await shot(`${theme}-wizard`);
      await contrast(client, `${theme} / assistant de NPC`);
      if (theme === "light") await names(client, "assistant de NPC");
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "assistant de NPC ferme", 6_000);
      // Ecran 6 : deploiement vers un dossier (destination choisie par la construction de test, plan affiche).
      await client.evaluate(`${E2E}.controller.openDeploy()`);
      await client.waitFor("!!document.querySelector('[role=dialog] .deploy-destination')", "boite de deploiement", 8_000);
      await client.evaluate("document.querySelector('[role=dialog] .deploy-destination button').click()");
      await client.waitFor("!/No folder|Aucun dossier/.test(document.querySelector('[role=dialog] .deploy-path')?.textContent ?? 'No folder')", "destination choisie", 8_000);
      await client.evaluate("[...document.querySelectorAll('[role=dialog] button')].find((button) => /Prepare the plan|Preparer le plan|Préparer le plan/.test(button.textContent)).click()");
      await client.waitFor("!!document.querySelector('[role=dialog] .deploy-plan')", "plan de deploiement", 20_000);
      await sleep(300);
      await shot(`${theme}-deploy`);
      await contrast(client, `${theme} / deploiement`);
      if (theme === "light") await names(client, "deploiement");
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "deploiement ferme", 6_000);
      // Ecran 7 : editeur visuel de dialogues, avec une modification en attente (l'apercu des changements fait partie de l'ecran).
      await client.evaluate(`${E2E}.controller.openFile("npc/visual.txt")`);
      await client.waitFor(`${state("activePath")} === "npc/visual.txt"`, "fichier de l'editeur visuel ouvert", 10_000);
      await client.evaluate(`${E2E}.controller.openVisual()`);
      await client.waitFor("!!document.querySelector('[role=dialog] .visual-list')", "editeur visuel", 8_000);
      await client.evaluate("document.querySelector('[role=dialog] [data-block-id=\"1\"] .visual-actions').querySelectorAll('button')[3].click()");
      await client.waitFor("!!document.querySelector('[role=dialog] .diff-surface .monaco-diff-editor')", "apercu des changements", 15_000);
      await sleep(600);
      await shot(`${theme}-visual`);
      await contrast(client, `${theme} / editeur visuel`);
      if (theme === "light") await names(client, "editeur visuel");
      // Des changements en attente : Echap demande confirmation, une seconde fois il abandonne.
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!!document.querySelector('[role=dialog] [role=alert]')", "confirmation de l'abandon", 6_000);
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "editeur visuel ferme", 6_000);
      await client.evaluate(`${E2E}.controller.requestCloseTab("npc/visual.txt")`).catch(() => undefined);
      await client.evaluate(`${E2E}.controller.requestCloseTab("npc/bad.txt")`).catch(() => undefined);
      // Ecran 8 : constructeur de NPC en noeuds (canevas sombre, noeuds relies, bibliotheque) ; un noeud ajoute montre un noeud signale.
      await client.evaluate(`${E2E}.controller.openVisualBuilder()`);
      await client.waitFor("!!document.querySelector('[role=dialog] .flow-canvas')", "constructeur de NPC en noeuds", 8_000);
      await client.evaluate("document.querySelector('[role=dialog] .visual-builder-command').click()");
      await client.evaluate("document.querySelector('[role=dialog] .flow-canvas').scrollIntoView({ block: 'center' })");
      await sleep(500);
      await shot(`${theme}-builder`);
      await contrast(client, `${theme} / constructeur de NPC`);
      if (theme === "light") await names(client, "constructeur de NPC");
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "constructeur de NPC ferme", 6_000);
      // Ecran 9 : simulation de dialogue (transcription avec une instruction non simulee, formulaire du personnage de test, page suivante).
      await client.evaluate(`${E2E}.controller.openFile("npc/visual.txt")`);
      await client.waitFor(`${state("activePath")} === "npc/visual.txt"`, "fichier de la simulation ouvert", 10_000);
      await client.evaluate(`${E2E}.controller.openSimulation()`);
      await client.waitFor("!!document.querySelector('[role=dialog] form button.button-primary')", "fenetre de simulation", 8_000);
      await client.evaluate("document.querySelector('[role=dialog] form button.button-primary').click()");
      await client.waitFor("!!document.querySelector('[role=dialog] [role=log] p')", "transcription de la simulation", 8_000);
      await client.evaluate("[...document.querySelectorAll('[role=dialog] button')].find((button) => /Next page|Page suivante/.test(button.textContent)).click()");
      await client.waitFor("!!document.querySelector('[role=dialog] .sim-note')", "instruction non simulee affichee", 8_000);
      await sleep(400);
      await shot(`${theme}-simulation`);
      await contrast(client, `${theme} / simulation de dialogue`);
      if (theme === "light") await names(client, "simulation de dialogue");
      await keyCombo(client, 0, "Escape", "Escape", 27);
      await client.waitFor("!document.querySelector('[role=dialog]')", "simulation fermee", 6_000);
      await client.evaluate(`${E2E}.controller.requestCloseTab("npc/visual.txt")`).catch(() => undefined);
      await sleep(300);
    }

    // Clavier : espace de travail sans editeur ouvert (Monaco prend Tab), puis dialogues.
    await client.evaluate(`${E2E}.controller.updateSettings({ theme: "light" })`);
    await sleep(300);
    await keyboard(client, "espace de travail");
    await dialog(client, "parametres", () => keyCombo(client as Cdp, 2, ",", "Comma", 188));
    await dialog(client, "mises a jour", async () => {
      await (client as Cdp).evaluate(`${E2E}.controller.openSettings("updates")`);
    });
    await dialog(client, "palette de commandes", () => keyCombo(client as Cdp, 10, "P", "KeyP", 80));
    await dialog(client, "assistant de NPC", async () => {
      await (client as Cdp).evaluate(`${E2E}.controller.openNpcWizard()`);
    });
    await dialog(client, "deploiement", async () => {
      await (client as Cdp).evaluate(`${E2E}.controller.openDeploy()`);
    });
    await dialog(client, "constructeur de NPC", async () => {
      await (client as Cdp).evaluate(`${E2E}.controller.openVisualBuilder()`);
    });
    // L'editeur visuel travaille sur le document affiche : on l'ouvre avant que le controle d'origine reprenne le focus.
    await client.evaluate(`${E2E}.controller.openFile("npc/visual.txt")`);
    await client.waitFor(`${state("activePath")} === "npc/visual.txt"`, "fichier de l'editeur visuel ouvert", 10_000);
    await dialog(client, "editeur visuel", async () => {
      await (client as Cdp).evaluate(`${E2E}.controller.openVisual()`);
    });
    await dialog(client, "simulation de dialogue", async () => {
      await (client as Cdp).evaluate(`${E2E}.controller.openSimulation()`);
    });
  } finally {
    client?.close();
    app.kill();
  }
}

try {
  await main();
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("Audit d'accessibilite - resume");
for (const line of summary) console.log(`  ${line}`);
if (findings.length === 0) {
  console.log("\nAUCUN DEFAUT DETECTE");
} else {
  console.log(`\n${findings.length} DEFAUT(S) :`);
  for (const finding of findings) console.log(`  [${finding.audit}] ${finding.message}`);
}
process.exitCode = findings.length === 0 ? 0 : 1;
