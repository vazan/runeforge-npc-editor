import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovedRoot } from "../services/types";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { inProcessLanguage } from "../test/in-process-worker";
import { MemoryBuffer } from "../test/memory-buffer";
import { AppController } from "./controller";

const NPC = (name: string): string => `prontera,150,150,4\tscript\t${name}\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n`;
const BAD = 'prontera,3,3,0\tscript\tB\t100,{\n\tmes "a"\n}\n';
const DESTINATION: ApprovedRoot = { id: "destroot", displayPath: "C:\\fake\\server" };

interface Harness {
  backend: FakeBackend;
  server: FakeBackend;
  store: AppStore;
  controller: AppController;
}

function harness(): Harness {
  const backend = new FakeBackend();
  const server = new FakeBackend();
  backend.destination = { root: DESTINATION, disk: server };
  const store = createAppStore();
  const { client } = inProcessLanguage();
  const controller = new AppController({
    backend,
    store,
    editor: { createBuffer: (text) => new MemoryBuffer(text) },
    diagnostics: client,
    language: client,
    systemLanguage: () => "en-US",
    systemPrefersDark: () => false,
  });
  return { backend, server, store, controller };
}

async function loaded(h: Harness, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  await h.controller.whenIndexed();
}

const toasts = (h: Harness): string[] => h.store.getState().toasts.map((toast) => `${toast.kind}:${toast.text}`);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AppController - deploiement : candidats", () => {
  it("liste les fichiers du dossier demande, dans l'ordre, sans les dossiers de l'outil ni de Git", async () => {
    const h = harness();
    await loaded(h, {
      "npc/custom/b.txt": NPC("B"),
      "npc/custom/a.txt": NPC("A"),
      "npc/custom/sous/c.txt": NPC("C"),
      "npc/autre.txt": NPC("D"),
      "npc/custom/.git/HEAD": "ref",
      ".runeforge/deploy/x/manifest.json": "{}",
      ".git/config": "[core]",
    });
    expect(h.controller.deployCandidates("npc/custom")).toEqual(["npc/custom/a.txt", "npc/custom/b.txt", "npc/custom/sous/c.txt"]);
    // Le dossier peut etre ecrit avec des antislashs, des barres en trop ou des espaces ; un nom qui n'est qu'un debut de nom ne correspond pas.
    expect(h.controller.deployCandidates("  \\npc\\custom\\/ ")).toEqual(["npc/custom/a.txt", "npc/custom/b.txt", "npc/custom/sous/c.txt"]);
    expect(h.controller.deployCandidates("npc/cust")).toEqual([]);
    expect(h.controller.deployCandidates("")).toEqual(["npc/autre.txt", "npc/custom/a.txt", "npc/custom/b.txt", "npc/custom/sous/c.txt"]);
  });

  it("n'en liste aucun sans projet", async () => {
    const h = harness();
    await h.controller.init();
    expect(h.controller.deployCandidates("")).toEqual([]);
    expect(await h.controller.pickDeployDestination()).toBeNull();
    expect(h.backend.destinationPicks).toBe(0);
  });
});

describe("AppController - deploiement : destination", () => {
  it("rend la racine choisie, ou rien si l'utilisateur annule, ou un refus pour le projet lui-meme", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC("A") });
    expect(await h.controller.pickDeployDestination()).toEqual({ root: DESTINATION });
    h.backend.destination = null;
    expect(await h.controller.pickDeployDestination()).toBeNull();
    h.backend.destination = { root: h.backend.root, disk: h.server };
    expect(await h.controller.pickDeployDestination()).toEqual({ error: "same-as-project" });
  });

  it("signale l'echec de la boite de dialogue du systeme", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC("A") });
    vi.spyOn(h.backend, "pickDestinationFolder").mockRejectedValue(Object.assign(new Error("dialogue indisponible"), { code: "io" }));
    expect(await h.controller.pickDeployDestination()).toBeNull();
    expect(toasts(h).some((toast) => toast.startsWith("error:"))).toBe(true);
  });
});

describe("AppController - deploiement : plan et execution", () => {
  const FILES = { "npc/custom/a.txt": NPC("A"), "npc/custom/mauvais.txt": BAD };

  it("compte les erreurs d'analyse des fichiers du plan, sans ecrire quoi que ce soit", async () => {
    const h = harness();
    await loaded(h, FILES);
    const view = await h.controller.prepareDeployment(DESTINATION, "npc/custom");
    expect(view?.preparation.plan.counts).toEqual({ create: 2, update: 0, unchanged: 0, conflict: 0 });
    expect([...(view?.errorCounts ?? [])]).toEqual([["npc/custom/mauvais.txt", 1]]);
    expect(view?.last).toBeNull();
    expect(h.backend.writes).toEqual([]);
    expect(h.server.writes).toEqual([]);
  });

  it("refuse d'envoyer des fichiers a erreurs sans decision de l'utilisateur, et les envoie avec", async () => {
    const h = harness();
    await loaded(h, FILES);
    const view = await h.controller.prepareDeployment(DESTINATION, "npc/custom");
    if (view === null) throw new Error("plan absent");
    expect(await h.controller.runDeployment(DESTINATION, view, { overwriteConflicts: false, allowErrors: false })).toBeNull();
    expect(toasts(h)).toEqual(["error:Some files to send have analysis errors: tick the box to deploy anyway."]);
    expect(h.server.files.size).toBe(0);

    const done = await h.controller.runDeployment(DESTINATION, view, { overwriteConflicts: false, allowErrors: true });
    expect(done?.report.complete).toBe(true);
    expect(h.server.textOf("npc/custom/mauvais.txt")).toBe(BAD);
  });

  it("n'oppose rien a un fichier en erreur qui ne sera pas envoye (identique, ou conflit non ecrase)", async () => {
    const h = harness();
    await loaded(h, FILES);
    h.server.put("npc/custom/mauvais.txt", "// du serveur\n");
    const view = await h.controller.prepareDeployment(DESTINATION, "npc/custom");
    if (view === null) throw new Error("plan absent");
    const done = await h.controller.runDeployment(DESTINATION, view, { overwriteConflicts: false, allowErrors: false });
    expect(done?.report.results.map((entry) => [entry.path, entry.status])).toEqual([["npc/custom/a.txt", "created"], ["npc/custom/mauvais.txt", "skipped"]]);
    // Et avec l'ecrasement du conflit, ce fichier en erreur redevient un obstacle.
    expect(await h.controller.runDeployment(DESTINATION, view, { overwriteConflicts: true, allowErrors: false })).toBeNull();
  });

  it("journalise des nombres, jamais des chemins, et rafraichit l'arbre du projet", async () => {
    const h = harness();
    await loaded(h, { "npc/custom/a.txt": NPC("A") });
    h.store.setState({ settings: { ...h.store.getState().settings, logging: { enabled: true } } });
    await h.backend.configSet("settings", JSON.stringify({ logging: { enabled: true } }));
    const scans = h.backend.scans.length;
    const view = await h.controller.prepareDeployment(DESTINATION, "npc/custom");
    if (view === null) throw new Error("plan absent");
    await h.controller.runDeployment(DESTINATION, view, { overwriteConflicts: false, allowErrors: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.backend.logs).toContainEqual({ level: "info", code: "DEPLOY_DONE", detail: "created=1 updated=0 overwritten=0 unchanged=0 failed=0 skipped=0" });
    expect(JSON.stringify(h.backend.logs)).not.toContain("a.txt");
    expect(h.backend.scans.length).toBeGreaterThan(scans);
  });

  it("restaure puis le journalise", async () => {
    const h = harness();
    await loaded(h, { "npc/custom/a.txt": NPC("A") });
    await h.backend.configSet("settings", JSON.stringify({ logging: { enabled: true } }));
    h.store.setState({ settings: { ...h.store.getState().settings, logging: { enabled: true } } });
    h.server.put("npc/custom/a.txt", "// ancien\n");
    const view = await h.controller.prepareDeployment(DESTINATION, "npc/custom");
    if (view === null) throw new Error("plan absent");
    const done = await h.controller.runDeployment(DESTINATION, view, { overwriteConflicts: true, allowErrors: false });
    if (done === null) throw new Error("deploiement absent");
    const result = await h.controller.rollbackDeployment(DESTINATION, done);
    expect(result).toMatchObject({ restored: ["npc/custom/a.txt"], failed: [] });
    expect(h.server.textOf("npc/custom/a.txt")).toBe("// ancien\n");
    await vi.advanceTimersByTimeAsync(10);
    expect(h.backend.logs).toContainEqual({ level: "info", code: "DEPLOY_ROLLBACK", detail: "restored=1 failed=0" });
  });

  it("dit l'echec d'une lecture du projet ou de la destination sans rien deployer", async () => {
    const h = harness();
    await loaded(h, { "npc/custom/a.txt": NPC("A") });
    const read = vi.spyOn(h.server, "readFiles").mockResolvedValue([{ path: "npc/custom/a.txt", ok: false, error: Object.assign(new Error("refuse"), { code: "permission_denied", payload: { code: "permission_denied" } }) as never }]);
    expect(await h.controller.prepareDeployment(DESTINATION, "npc/custom")).toBeNull();
    expect(toasts(h).some((toast) => toast.startsWith("error:"))).toBe(true);
    read.mockRestore();
  });

  it("n'agit pas sans projet", async () => {
    const h = harness();
    await h.controller.init();
    expect(await h.controller.prepareDeployment(DESTINATION, "")).toBeNull();
    expect(await h.controller.rollbackDeployment(DESTINATION, { stamp: "2026-11-09T17-30-05-123Z", report: { results: [], complete: true, startedAtMs: 0, finishedAtMs: 0 } })).toBeNull();
    expect(h.server.writes).toEqual([]);
  });
});
