import type { ProjectReport } from "@runeforge/runescript-language-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { inProcessLanguage } from "../test/in-process-worker";
import { MemoryBuffer } from "../test/memory-buffer";
import type { LanguageClient } from "../workers/language-client";
import { AppController } from "./controller";

interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  language: LanguageClient;
  copied: string[];
  edit(path: string, text: string): void;
}

/** Controleur branche sur le vrai service de langage (execute en processus), un faux disque et un faux presse-papiers. */
function harness(clipboard: { writeText(text: string): Promise<void> } | null | "recording" = "recording"): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const buffers = new Map<string, MemoryBuffer>();
  const copied: string[] = [];
  const { client: language } = inProcessLanguage();
  const controller = new AppController({
    backend,
    store,
    editor: {
      createBuffer: (text, path) => {
        const buffer = new MemoryBuffer(text);
        buffers.set(path, buffer);
        return buffer;
      },
    },
    diagnostics: language,
    language,
    systemLanguage: () => "fr-FR",
    systemPrefersDark: () => false,
    clipboard:
      clipboard === "recording"
        ? {
            writeText: (text) => {
              copied.push(text);
              return Promise.resolve();
            },
          }
        : clipboard,
  });
  return {
    backend,
    store,
    controller,
    language,
    copied,
    edit: (path, text) => {
      const buffer = buffers.get(path);
      if (buffer === undefined) throw new Error("tampon absent");
      buffer.text = text;
      controller.notifyEdited(path);
    },
  };
}

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t100,{\n${body}\n}\n`;
const fn = (name: string): string => `function\tscript\t${name}\t{\n\treturn;\n}\n`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function loaded(h: Harness, files: Record<string, string>, config?: Record<string, unknown>): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  if (config !== undefined) h.backend.put(".runeforge/project.json", JSON.stringify({ schemaVersion: 1, projectName: "P", ...config }));
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  await h.controller.whenIndexed();
}

const FILES = {
  "npc/ok.txt": fn("F_Ok"),
  "npc/bad.txt": npc("goto L_Nope;\nclose;", "Bad"),
  "npc/worse.txt": npc("goto L_One;\ngoto L_Two;\nclose;", "Worse"),
  "readme.md": "pas un script\n",
};

function reportOf(h: Harness): ProjectReport {
  const report = h.store.getState().projectReport?.report;
  if (report === null || report === undefined) throw new Error("pas de rapport");
  return report;
}

async function ready(h: Harness): Promise<void> {
  await vi.waitFor(() => expect(h.store.getState().projectReport?.status).toBe("ready"));
}

/** Une promesse que le test resout lui-meme : permet de tenir un calcul « en cours ». */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AppController - rapport de projet (RF-015)", () => {
  it("calcule le rapport de tous les fichiers indexes, sans ouvrir aucun document", async () => {
    const h = harness();
    await loaded(h, FILES);
    expect(h.store.getState().projectReport).toBeNull();

    h.controller.showProjectReport();
    await ready(h);
    const state = h.store.getState();
    expect(state.projectReport).toMatchObject({ status: "ready", complete: true, stale: false });
    expect(state).toMatchObject({ bottomTab: "report", bottomVisible: true });
    expect(state.tabs).toEqual([]);
    expect(reportOf(h).examined).toBe(3);
    expect(reportOf(h).files.map((file) => [file.uri, file.errors])).toEqual([
      ["npc/worse.txt", 2],
      ["npc/bad.txt", 1],
    ]);
  });

  it("ne calcule rien tant que le rapport n'a pas ete demande, meme apres des modifications", async () => {
    const h = harness();
    const spy = vi.spyOn(h.language, "projectReport");
    await loaded(h, FILES);
    await h.controller.openFile("npc/bad.txt");
    h.edit("npc/bad.txt", npc("close;", "Bad"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).not.toHaveBeenCalled();
    expect(h.store.getState().projectReport).toBeNull();
  });

  it("ouvre un fichier ferme du rapport a la position du probleme", async () => {
    const h = harness();
    await loaded(h, FILES);
    h.controller.showProjectReport();
    await ready(h);
    const file = reportOf(h).files.find((entry) => entry.uri === "npc/bad.txt");
    const item = file?.items[0];
    expect([item?.diagnostic.code, item?.line, item?.column]).toEqual(["RA0002", 2, 6]);

    await h.controller.revealPosition("npc/bad.txt", item?.line ?? 0, item?.column ?? 0);
    expect(h.store.getState().tabs).toEqual(["npc/bad.txt"]);
    expect(h.store.getState().reveal).toMatchObject({ path: "npc/bad.txt", line: 2, column: 6 });
  });

  it("montre le texte de l'editeur pour un fichier ouvert, meme si son analyse est encore en attente", async () => {
    const h = harness();
    await loaded(h, FILES);
    await h.controller.openFile("npc/bad.txt");
    await vi.advanceTimersByTimeAsync(300);
    // Modification recente : l'analyse (250 ms) n'a pas encore ete envoyee au service.
    h.edit("npc/bad.txt", npc("\n\ngoto L_Autre;\nclose;", "Bad"));
    h.controller.showProjectReport();
    await ready(h);
    const item = reportOf(h).files.find((entry) => entry.uri === "npc/bad.txt")?.items[0];
    expect(item?.diagnostic.params).toMatchObject({ name: "L_Autre" });
    expect([item?.line, item?.column]).toEqual([4, 6]);
  });

  it("marque le rapport perime apres un changement et le recalcule tout seul quand le panneau est affiche", async () => {
    const h = harness();
    await loaded(h, FILES);
    h.controller.showProjectReport();
    await ready(h);
    expect(reportOf(h).totals.errors).toBe(3);

    await h.controller.openFile("npc/ok.txt");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.store.getState().projectReport?.stale).toBe(false); // ouvrir un fichier sans le modifier ne change rien
    h.edit("npc/ok.txt", fn("F_Ok") + npc("goto L_Neuf;\nclose;", "Neuf"));
    await vi.advanceTimersByTimeAsync(260); // analyse du document (250 ms)
    expect(h.store.getState().projectReport?.stale).toBe(true);
    expect(reportOf(h).totals.errors).toBe(3);

    await vi.advanceTimersByTimeAsync(450); // puis le recalcul (400 ms)
    await vi.waitFor(() => expect(h.store.getState().projectReport?.stale).toBe(false));
    expect(reportOf(h).totals.errors).toBe(4);
    expect(reportOf(h).files.map((file) => file.uri)).toContain("npc/ok.txt");
  });

  it("remet le rapport a jour quand un fichier modifie est recharge depuis le disque", async () => {
    const h = harness();
    await loaded(h, FILES);
    await h.controller.openFile("npc/ok.txt");
    h.edit("npc/ok.txt", npc("goto L_Neuf;\nclose;", "Neuf"));
    h.controller.showProjectReport();
    await ready(h);
    expect(reportOf(h).totals.errors).toBe(4);

    await h.controller.reloadFromDisk("npc/ok.txt");
    await vi.advanceTimersByTimeAsync(300); // analyse du document recharge
    await vi.advanceTimersByTimeAsync(450); // recalcul du rapport
    await vi.waitFor(() => expect(h.store.getState().projectReport?.stale).toBe(false));
    expect(reportOf(h).totals.errors).toBe(3);
  });

  it("recalcule le rapport demande pendant l'indexation quand celle-ci se termine", async () => {
    const h = harness();
    for (const [path, content] of Object.entries(FILES)) h.backend.put(path, content);
    await h.controller.init();
    await h.controller.loadProject(h.backend.root);
    h.controller.showProjectReport(); // l'indexation n'est pas terminee
    await ready(h);
    expect(h.store.getState().projectReport?.complete).toBe(false);

    await h.controller.whenIndexed();
    await vi.advanceTimersByTimeAsync(450);
    await vi.waitFor(() => expect(h.store.getState().projectReport).toMatchObject({ complete: true, stale: false }));
    expect(reportOf(h).examined).toBe(3);
    expect(reportOf(h).totals.errors).toBe(3);
  });

  it("reste perime, sans recalcul, tant que le panneau du rapport n'est pas affiche, puis se met a jour a l'affichage", async () => {
    const h = harness();
    const spy = vi.spyOn(h.language, "projectReport");
    await loaded(h, FILES);
    h.controller.showProjectReport();
    await ready(h);
    expect(spy).toHaveBeenCalledTimes(1);

    h.controller.setBottomTab("problems");
    await h.controller.openFile("npc/ok.txt");
    h.edit("npc/ok.txt", npc("goto L_Neuf;\nclose;", "Neuf"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.store.getState().projectReport?.stale).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    h.controller.setBottomTab("report");
    await vi.waitFor(() => expect(h.store.getState().projectReport?.stale).toBe(false));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(reportOf(h).totals.errors).toBe(4);
  });

  it("abandonne le resultat d'un calcul depasse par un calcul plus recent", async () => {
    const h = harness();
    await loaded(h, FILES);
    const first = deferred<ProjectReport>();
    const second = deferred<ProjectReport>();
    const empty = (examined: number): ProjectReport => ({ examined, files: [], totals: { errors: 0, warnings: 0, infos: 0 }, byCode: [], truncated: false, excluded: null });
    vi.spyOn(h.language, "projectReport").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = h.controller.refreshProjectReport();
    const b = h.controller.refreshProjectReport();
    second.resolve(empty(222));
    await b;
    first.resolve(empty(111));
    await a;
    expect(reportOf(h).examined).toBe(222);
  });

  it("laisse perime un rapport pendant le calcul duquel le service a change", async () => {
    const h = harness();
    await loaded(h, FILES);
    await h.controller.openFile("npc/ok.txt");
    await vi.advanceTimersByTimeAsync(300);
    const slow = deferred<ProjectReport>();
    const real = h.language.projectReport.bind(h.language);
    vi.spyOn(h.language, "projectReport").mockImplementationOnce(() => slow.promise);

    const pending = h.controller.refreshProjectReport();
    await vi.advanceTimersByTimeAsync(0);
    h.edit("npc/ok.txt", npc("goto L_Neuf;\nclose;", "Neuf"));
    await vi.advanceTimersByTimeAsync(260);
    slow.resolve(await real());
    await pending;
    expect(h.store.getState().projectReport).toMatchObject({ status: "ready", stale: true });
  });

  it("dit qu'un rapport calcule pendant l'indexation est partiel", async () => {
    const h = harness();
    await loaded(h, FILES);
    h.store.setState((state) => ({ indexing: { ...state.indexing, status: "running" } }));
    await h.controller.refreshProjectReport();
    expect(h.store.getState().projectReport?.complete).toBe(false);
    h.store.setState((state) => ({ indexing: { ...state.indexing, status: "done" } }));
    await h.controller.refreshProjectReport();
    expect(h.store.getState().projectReport?.complete).toBe(true);
  });

  it("efface le rapport a la fermeture du projet et ignore un calcul encore en cours", async () => {
    const h = harness();
    await loaded(h, FILES);
    const slow = deferred<ProjectReport>();
    const real = h.language.projectReport.bind(h.language);
    const original = await real();
    vi.spyOn(h.language, "projectReport").mockImplementationOnce(() => slow.promise);
    const pending = h.controller.refreshProjectReport();
    await vi.advanceTimersByTimeAsync(0);

    await h.controller.closeProject();
    slow.resolve(original);
    await pending;
    expect(h.store.getState().projectReport).toBeNull();
  });

  it("signale un echec de calcul sans perdre le dernier rapport", async () => {
    const h = harness();
    await loaded(h, FILES);
    h.controller.showProjectReport();
    await ready(h);
    vi.spyOn(h.language, "projectReport").mockRejectedValueOnce(new Error("panne"));
    await h.controller.refreshProjectReport();
    const state = h.store.getState().projectReport;
    expect(state).toMatchObject({ status: "error", stale: true });
    expect(state?.report?.examined).toBe(3);
    // Reessayer a l'affichage de l'onglet.
    h.controller.setBottomTab("problems");
    h.controller.setBottomTab("report");
    await ready(h);
    expect(h.store.getState().projectReport?.stale).toBe(false);
  });

  it("copie le rapport dans le presse-papiers : titre, totaux, fichiers, positions, codes", async () => {
    const h = harness();
    await loaded(h, FILES);
    h.controller.showProjectReport();
    await ready(h);
    expect(await h.controller.copyProjectReport()).toBe(true);
    expect(h.copied).toHaveLength(1);
    const text = h.copied[0] ?? "";
    expect(text).toContain("# Rapport de projet : ");
    expect(text).toContain("3 fichier(s) examiné(s) · 2 avec des problèmes · 3 erreur(s), 0 avertissement(s), 0 information(s)");
    expect(text).toContain("### npc/worse.txt — 2 erreur(s)");
    expect(text).toMatch(/- 2:6 · erreur · RA0002 · probable · Le label « L_One » n'est pas défini/);
    expect(text).toContain("Comment corriger : Définissez le label");
    expect(text).toContain("- RA0002 × 3");
    expect(text).not.toContain("npc/ok.txt");
    expect(h.store.getState().toasts.at(-1)).toMatchObject({ kind: "success", text: "Rapport de projet copié dans le presse-papiers." });
  });

  it("dit que la copie a echoue quand il n'y a pas de rapport ou que le presse-papiers refuse", async () => {
    const none = harness();
    await loaded(none, FILES);
    expect(await none.controller.copyProjectReport()).toBe(false);
    expect(none.store.getState().toasts.at(-1)).toMatchObject({ kind: "error", text: "Impossible de copier le rapport de projet." });

    const refusing = harness({ writeText: () => Promise.reject(new Error("refus")) });
    await loaded(refusing, FILES);
    refusing.controller.showProjectReport();
    await ready(refusing);
    expect(await refusing.controller.copyProjectReport()).toBe(false);
    expect(refusing.store.getState().toasts.at(-1)).toMatchObject({ kind: "error" });
  });
});

describe("AppController - portee du rapport : seulement ce que le serveur charge", () => {
  // Un serveur dans un sous-dossier ; la portee d'index est celle par defaut (`sources`, `**/*.txt`) : la documentation, les listes
  // et un script que `scripts_main.conf` ne cite pas sont indexes comme les scripts charges.
  const server = (list: string): Record<string, string> => ({
    "srv/src/config/renewal.hpp": "#define RENEWAL\n",
    "srv/conf/map_athena.conf": "import: conf/import/map_conf.txt\n",
    "srv/conf/import/map_conf.txt": "",
    "srv/npc/re/scripts_main.conf": list,
    "srv/npc/re/a.txt": npc("goto L_Charge;\nclose;", "A"),
    "srv/npc/re/unlisted.txt": npc("goto L_Absent;\nclose;", "U"),
    "srv/doc/manual.txt": "Une ligne de prose sans tabulation\nune autre ligne\n",
  });

  it("calcule les scripts charges sans toucher a l'etat du serveur", async () => {
    const h = harness();
    await loaded(h, server("npc: npc/re/a.txt\n"));
    h.controller.showProjectReport();
    await ready(h);
    const state = h.store.getState();
    expect([...(state.projectReport?.scope.loaded ?? [])]).toEqual(["srv/npc/re/a.txt"]);
    // Indexes : a.txt, unlisted.txt, manual.txt et map_conf.txt ; un seul est charge.
    expect(state.projectReport?.scope.notLoaded).toBe(3);
    expect(state.projectReport?.hideUnloaded).toBe(true);
    // Par defaut le service ne rapporte que les scripts charges, et compte ce qu'il laisse de cote.
    expect(reportOf(h).files.map((entry) => entry.uri)).toEqual(["srv/npc/re/a.txt"]);
    expect(reportOf(h).examined).toBe(1);
    expect(reportOf(h).excluded).toMatchObject({ examined: 3, files: 2 });
    expect(reportOf(h).excluded?.problems).toBeGreaterThan(2);
    // La portee d'index n'a pas change : l'etat du serveur ne parle pas de scripts charges.
    expect(state.emulator).toMatchObject({ status: "ready", loadedScripts: null, loadIssues: 0 });
  });

  it("restreint le texte copie aux scripts charges et dit ce qui est masque", async () => {
    const h = harness();
    await loaded(h, server("npc: npc/re/a.txt\n"));
    h.controller.showProjectReport();
    await ready(h);
    await h.controller.copyProjectReport();
    const text = h.copied[0] ?? "";
    expect(text).toContain("### srv/npc/re/a.txt — 1 erreur(s)");
    expect(text).not.toContain("srv/npc/re/unlisted.txt");
    expect(text).not.toContain("srv/doc/manual.txt");
    expect(text).toMatch(/Non montrés : 2 fichier\(s\) que le serveur ne charge pas \(\d+ problème\(s\)\)\./);
    expect(text).toContain("1 fichier(s) examiné(s) · 1 avec des problèmes · 1 erreur(s)");
  });

  it("montre tout quand l'utilisateur le demande, y compris dans le texte copie", async () => {
    const h = harness();
    await loaded(h, server("npc: npc/re/a.txt\n"));
    h.controller.showProjectReport();
    await ready(h);
    h.controller.setReportHideUnloaded(false);
    expect(h.store.getState().projectReport?.hideUnloaded).toBe(false);
    // Le rapport est recalcule pour le nouveau choix : tous les fichiers indexes, rien de laisse de cote.
    await vi.waitFor(() => expect(reportOf(h).excluded).toBeNull());
    expect(reportOf(h).files.map((entry) => entry.uri).sort()).toEqual(["srv/doc/manual.txt", "srv/npc/re/a.txt", "srv/npc/re/unlisted.txt"]);
    await h.controller.copyProjectReport();
    const text = h.copied[0] ?? "";
    expect(text).toContain("### srv/npc/re/a.txt");
    expect(text).toContain("### srv/npc/re/unlisted.txt");
    expect(text).toContain("### srv/doc/manual.txt");
    expect(text).not.toContain("Non montrés");
    // Le choix survit a un nouveau calcul, et on peut revenir aux seuls scripts charges.
    await h.controller.refreshProjectReport();
    expect(h.store.getState().projectReport?.hideUnloaded).toBe(false);
    h.controller.setReportHideUnloaded(true);
    await vi.waitFor(() => expect(reportOf(h).files.map((entry) => entry.uri)).toEqual(["srv/npc/re/a.txt"]));
  });

  it("garde le detail des vrais problemes meme quand les fichiers laisses de cote en ont des milliers (la limite ne s'applique qu'a la vue)", async () => {
    const h = harness();
    // Huit « manuels » indexes comme des scripts : une erreur de syntaxe par ligne (le parseur en garde 1 000 par fichier), bien
    // plus que la limite du detail du rapport.
    const noise = Array.from({ length: 1200 }, (_, i) => `ligne de prose ${i}`).join("\n") + "\n";
    const manuals = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`srv/doc/enorme${i}.txt`, noise]));
    await loaded(h, { ...server("npc: npc/re/a.txt\n"), ...manuals });
    h.controller.showProjectReport();
    await ready(h);
    const report = reportOf(h);
    expect(report.truncated).toBe(false);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.items.map((item) => item.diagnostic.code)).toEqual(["RA0002"]);
    expect(report.excluded?.problems).toBeGreaterThan(5000);
    // Sans la restriction, le meme bruit epuise la limite : le vrai probleme perd son detail (celui des fichiers les moins graves).
    h.controller.setReportHideUnloaded(false);
    await vi.waitFor(() => expect(reportOf(h).excluded).toBeNull());
    expect(reportOf(h).truncated).toBe(true);
    expect(reportOf(h).files.find((entry) => entry.uri === "srv/npc/re/a.txt")?.items).toEqual([]);
  });

  it("recalcule le rapport quand le choix change pendant un calcul", async () => {
    const h = harness();
    await loaded(h, server("npc: npc/re/a.txt\n"));
    const slow = deferred<ProjectReport>();
    const real = h.language.projectReport.bind(h.language);
    vi.spyOn(h.language, "projectReport").mockImplementationOnce(() => slow.promise);
    h.controller.showProjectReport(); // calcul 1 (suspendu) pour « seulement les scripts charges »
    await vi.advanceTimersByTimeAsync(0);
    h.controller.setReportHideUnloaded(false); // calcul 2, pour « tout »
    await vi.waitFor(() => expect(reportOf(h).excluded).toBeNull());
    slow.resolve(await real({ only: ["srv/npc/re/a.txt"] }));
    await vi.advanceTimersByTimeAsync(10);
    // Le calcul 1, depasse, n'a rien ecrase.
    expect(reportOf(h).excluded).toBeNull();
    expect(reportOf(h).files).toHaveLength(3);
  });

  it("ne calcule pas la portee tant que le serveur est en cours de lecture (son mode de compilation n'est pas encore connu)", async () => {
    const h = harness();
    await loaded(h, server("npc: npc/re/a.txt\n"));
    h.store.setState((state) => ({ emulator: { ...state.emulator, status: "loading" } }));
    await h.controller.refreshProjectReport();
    expect(h.store.getState().projectReport?.scope).toEqual({ loaded: null, notLoaded: 0 });
    h.store.setState((state) => ({ emulator: { ...state.emulator, status: "ready" } }));
    await h.controller.refreshProjectReport();
    expect(h.store.getState().projectReport?.scope.notLoaded).toBe(3);
  });

  it("ne restreint rien quand la portee d'index est deja « scripts charges », sans serveur reconnu, ou sans liste de scripts lisible", async () => {
    const loadedScope = harness();
    await loaded(loadedScope, server("npc: npc/re/a.txt\n"), { emulator: { family: "rathena", indexScope: "loaded" } });
    loadedScope.controller.showProjectReport();
    await ready(loadedScope);
    expect(loadedScope.store.getState().projectReport?.scope).toEqual({ loaded: null, notLoaded: 0 });
    expect(reportOf(loadedScope).files.map((entry) => entry.uri)).toEqual(["srv/npc/re/a.txt"]);

    const noServer = harness();
    await loaded(noServer, FILES);
    noServer.controller.showProjectReport();
    await ready(noServer);
    expect(noServer.store.getState().projectReport?.scope).toEqual({ loaded: null, notLoaded: 0 });

    // Un serveur dont la liste ne cite aucun script : on ne sait rien de ce qu'il charge, on ne masque rien.
    const emptyList = harness();
    await loaded(emptyList, server("// rien\n"));
    emptyList.controller.showProjectReport();
    await ready(emptyList);
    expect(emptyList.store.getState().projectReport?.scope).toEqual({ loaded: null, notLoaded: 0 });
    expect(reportOf(emptyList).files).toHaveLength(3);
  });
});

describe("AppController - problemes de chargement du serveur dans le rapport", () => {
  const server = (prefix: string): Record<string, string> => ({
    [`${prefix}src/config/renewal.hpp`]: "#define RENEWAL\n",
    [`${prefix}conf/map_athena.conf`]: "import: conf/import/map_conf.txt\n",
    [`${prefix}conf/import/map_conf.txt`]: "",
    [`${prefix}npc/re/scripts_main.conf`]: "// liste\nnpc: npc/re/a.txt\nnpc: npc/re/absent.txt\nreglage_inconnu: 1\n",
    [`${prefix}npc/re/a.txt`]: npc("close;", "A"),
  });

  it("garde le detail des problemes avec des chemins relatifs au projet (serveur dans un sous-dossier)", async () => {
    const h = harness();
    await loaded(h, server("Serveur/rathena/"), { emulator: { family: "rathena", indexScope: "loaded" } });
    const emulator = h.store.getState().emulator;
    expect(emulator.loadIssues).toBe(2);
    expect(emulator.loadIssueList).toEqual([
      { kind: "missing-script", file: "Serveur/rathena/npc/re/scripts_main.conf", line: 3, subject: "Serveur/rathena/npc/re/absent.txt" },
      { kind: "unknown-setting", file: "Serveur/rathena/npc/re/scripts_main.conf", line: 4, subject: "reglage_inconnu" },
    ]);
  });

  it("les met dans le rapport copie, avec leur emplacement", async () => {
    const h = harness();
    await loaded(h, server(""), { emulator: { family: "rathena", indexScope: "loaded" } });
    h.controller.showProjectReport();
    await ready(h);
    expect(await h.controller.copyProjectReport()).toBe(true);
    const text = h.copied[0] ?? "";
    expect(text).toContain("## Listes de scripts du serveur");
    expect(text).toContain("- npc/re/scripts_main.conf:3 — npc/re/absent.txt est cité mais le fichier n'existe pas.");
    expect(text).toContain("- npc/re/scripts_main.conf:4 — Réglage inconnu « reglage_inconnu » dans une liste de scripts.");
  });

  it("n'a aucun detail quand le serveur n'est pas reconnu ou que la portee est `sources`", async () => {
    const h = harness();
    await loaded(h, server(""));
    expect(h.store.getState().emulator.loadIssueList).toEqual([]);
    const other = harness();
    await loaded(other, FILES, { emulator: { family: "rathena", indexScope: "loaded" } });
    expect(other.store.getState().emulator.loadIssueList).toEqual([]);
  });
});
