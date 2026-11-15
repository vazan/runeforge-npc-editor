import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../services/types";
import { DESTINATION_ROOT, twoRoots } from "../test/deploy-backend";
import {
  backupPath,
  deployDirectory,
  lastReportPath,
  manifestPath,
  MAX_DEPLOY_FILES,
  prepareDeploy,
  readLastDeploy,
  readManifest,
  rollbackLast,
  runDeploy,
  sha256Hex,
  stampOf,
} from "./deploy-service";

const NOW = Date.UTC(2026, 10, 9, 17, 30, 5, 123);
const run = { overwriteConflicts: false, now: () => NOW };
const hash = (text: string): Promise<string> => sha256Hex(new TextEncoder().encode(text));

describe("deploiement vers un dossier : noms", () => {
  it("range le manifeste, le rapport et les sauvegardes dans le projet, sous .runeforge/deploy/<destination>", () => {
    const roots = { projectRootId: "p", destinationRootId: "ab12cd34" };
    expect(deployDirectory(roots)).toBe(".runeforge/deploy/ab12cd34");
    expect(manifestPath(roots)).toBe(".runeforge/deploy/ab12cd34/manifest.json");
    expect(lastReportPath(roots)).toBe(".runeforge/deploy/ab12cd34/last-report.json");
    // Une sauvegarde n'est jamais prise pour un script : elle ne finit pas par .txt.
    expect(backupPath(roots, "2026-11-09T17-30-05-123Z", "npc/a.txt")).toBe(".runeforge/deploy/ab12cd34/backups/2026-11-09T17-30-05-123Z/npc/a.txt.bak");
  });

  it("horodate sans deux-points ni point (noms de fichiers Windows)", () => {
    expect(stampOf(NOW)).toBe("2026-11-09T17-30-05-123Z");
  });

  it("calcule le SHA-256 attendu", async () => {
    expect(await hash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("preparation (dry-run)", () => {
  it("lit les deux cotes sans rien ecrire et classe chaque fichier", async () => {
    const { project, destination, backend, roots } = twoRoots();
    project.put("npc/neuf.txt", "n");
    project.put("npc/maj.txt", "v2");
    project.put("npc/pareil.txt", "p");
    destination.put("npc/maj.txt", "v1");
    destination.put("npc/pareil.txt", "p");
    const preparation = await prepareDeploy(backend, roots, ["npc/neuf.txt", "npc/maj.txt", "npc/pareil.txt"]);
    expect(preparation.plan.actions.map((action) => [action.path, action.kind, action.reason])).toEqual([
      ["npc/maj.txt", "conflict", "never-deployed"],
      ["npc/neuf.txt", "create", undefined],
      ["npc/pareil.txt", "unchanged", undefined],
    ]);
    expect(preparation.plan.actions[0]?.remote?.sha256).toBe(await hash("v1"));
    expect(preparation).toMatchObject({ manifest: null, unreadable: [], omitted: 0 });
    expect(project.writes).toEqual([]);
    expect(destination.writes).toEqual([]);
  });

  it("met les fichiers illisibles de cote, sans les mettre dans le plan", async () => {
    const { project, backend, roots } = twoRoots();
    project.put("a.txt", "a");
    const preparation = await prepareDeploy(backend, roots, ["a.txt", "absent.txt"]);
    expect(preparation.unreadable).toEqual(["absent.txt"]);
    expect(preparation.plan.actions.map((action) => action.path)).toEqual(["a.txt"]);
  });

  it("refuse de prendre une destination illisible pour une destination vide", async () => {
    const { project, destination, backend, roots } = twoRoots();
    project.put("a.txt", "a");
    vi.spyOn(destination, "readFiles").mockResolvedValue([{ path: "a.txt", ok: false, error: new BackendError({ code: "permission_denied" }) }]);
    await expect(prepareDeploy(backend, roots, ["a.txt"])).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("limite le nombre de fichiers d'un deploiement et dit combien sont laisses de cote", async () => {
    const { project, backend, roots } = twoRoots();
    const paths = Array.from({ length: MAX_DEPLOY_FILES + 2 }, (_, index) => `npc/f${index}.txt`);
    for (const path of paths) project.put(path, "x");
    const preparation = await prepareDeploy(backend, roots, paths);
    expect(preparation.plan.actions).toHaveLength(MAX_DEPLOY_FILES);
    expect(preparation.omitted).toBe(2);
  });
});

describe("deploiement", () => {
  async function deployFirst() {
    const disks = twoRoots();
    disks.project.put("npc/a.txt", "a2");
    disks.project.put("npc/b.txt", "b");
    disks.destination.put("npc/a.txt", "a1");
    const preparation = await prepareDeploy(disks.backend, disks.roots, ["npc/a.txt", "npc/b.txt"]);
    const result = await runDeploy(disks.backend, disks.roots, preparation, { ...run, overwriteConflicts: true });
    return { ...disks, result };
  }

  it("copie, sauvegarde ce qui est remplace dans le projet, et note le manifeste et le rapport", async () => {
    const { project, destination, backend, roots, result } = await deployFirst();
    expect(result.report.complete).toBe(true);
    expect(result.report.results.map((entry) => [entry.path, entry.status])).toEqual([["npc/a.txt", "overwritten"], ["npc/b.txt", "created"]]);
    expect(destination.textOf("npc/a.txt")).toBe("a2");
    expect(destination.textOf("npc/b.txt")).toBe("b");
    expect(project.textOf(backupPath(roots, result.stamp, "npc/a.txt"))).toBe("a1");
    const manifest = await readManifest(backend, roots);
    expect(manifest).toMatchObject({ version: 1, target: DESTINATION_ROOT, deployedAtMs: NOW });
    expect(manifest?.files).toEqual({ "npc/a.txt": await hash("a2"), "npc/b.txt": await hash("b") });
    expect(JSON.parse(project.textOf(lastReportPath(roots)) ?? "")).toMatchObject({ version: 1, stamp: result.stamp });
  });

  it("n'ecrit que dans les deux racines, et dans le projet que sous .runeforge/deploy", async () => {
    const { project, destination, result } = await deployFirst();
    expect(destination.writes.map((write) => write.path).sort()).toEqual(["npc/a.txt", "npc/b.txt"]);
    for (const write of project.writes) expect(write.path.startsWith(".runeforge/deploy/destination/"), write.path).toBe(true);
    // Les dossiers crees sont ceux des fichiers deployes et des sauvegardes.
    expect([...destination.directories]).toEqual(["npc"]);
    expect(result.stamp).toBe("2026-11-09T17-30-05-123Z");
  });

  it("prepare ensuite un plan sans rien a faire, puis des mises a jour sures, et des conflits pour ce que d'autres ont change", async () => {
    const { project, destination, backend, roots } = await deployFirst();
    const again = await prepareDeploy(backend, roots, ["npc/a.txt", "npc/b.txt"]);
    expect(again.plan.counts).toEqual({ create: 0, update: 0, unchanged: 2, conflict: 0 });
    expect(again.manifest).not.toBeNull();

    project.put("npc/a.txt", "a3");
    destination.put("npc/b.txt", "b-retouche-sur-le-serveur");
    project.put("npc/b.txt", "b2");
    const changed = await prepareDeploy(backend, roots, ["npc/a.txt", "npc/b.txt"]);
    expect(changed.plan.actions.map((action) => [action.path, action.kind, action.reason])).toEqual([
      ["npc/a.txt", "update", undefined],
      ["npc/b.txt", "conflict", "remote-changed"],
    ]);
  });

  it("n'ecrase pas un conflit sans decision, mais le fait apres sauvegarde quand on le decide", async () => {
    const disks = twoRoots();
    disks.project.put("a.txt", "mien");
    disks.destination.put("a.txt", "du serveur");
    const preparation = await prepareDeploy(disks.backend, disks.roots, ["a.txt"]);
    const refused = await runDeploy(disks.backend, disks.roots, preparation, run);
    expect(refused.report.results).toEqual([{ path: "a.txt", status: "skipped", skippedBecause: "conflict" }]);
    expect(disks.destination.textOf("a.txt")).toBe("du serveur");
    expect(disks.destination.writes).toEqual([]);
    // Rien n'est retenu comme deploye.
    expect((await readManifest(disks.backend, disks.roots))?.files).toEqual({});
  });

  it("note un echec partiel : le manifeste ne retient que ce qui est arrive", async () => {
    const disks = twoRoots();
    disks.project.put("a.txt", "a");
    disks.project.put("b.txt", "b");
    const original = disks.destination.writeFile.bind(disks.destination);
    vi.spyOn(disks.destination, "writeFile").mockImplementation((rootId, path, data, precondition, keepHistory) => {
      if (path === "b.txt") throw new BackendError({ code: "permission_denied" });
      return original(rootId, path, data, precondition, keepHistory);
    });
    const preparation = await prepareDeploy(disks.backend, disks.roots, ["a.txt", "b.txt"]);
    const { report } = await runDeploy(disks.backend, disks.roots, preparation, run);
    expect(report.complete).toBe(false);
    expect(report.results.map((entry) => [entry.path, entry.status, entry.failure])).toEqual([["a.txt", "created", undefined], ["b.txt", "failed", "write-failed"]]);
    expect((await readManifest(disks.backend, disks.roots))?.files).toEqual({ "a.txt": await hash("a") });
  });
});

describe("restauration", () => {
  it("remet les fichiers remplaces, met le manifeste d'accord avec la destination, et n'est plus a faire ensuite", async () => {
    const disks = twoRoots();
    disks.project.put("npc/a.txt", "a2");
    disks.project.put("npc/b.txt", "b");
    disks.destination.put("npc/a.txt", "a1");
    const preparation = await prepareDeploy(disks.backend, disks.roots, ["npc/a.txt", "npc/b.txt"]);
    await runDeploy(disks.backend, disks.roots, preparation, { ...run, overwriteConflicts: true });

    const last = await readLastDeploy(disks.backend, disks.roots);
    expect(last).not.toBeNull();
    if (last === null) return;
    const rollback = await rollbackLast(disks.backend, disks.roots, last);
    expect(rollback).toEqual({ restored: ["npc/a.txt"], failed: [], leftInPlace: ["npc/b.txt"] });
    expect(disks.destination.textOf("npc/a.txt")).toBe("a1");
    // Le fichier cree reste en place.
    expect(disks.destination.textOf("npc/b.txt")).toBe("b");
    // Le manifeste dit ce que la destination contient : a1 pour a.txt, qui n'est plus « notre » version.
    const manifest = await readManifest(disks.backend, disks.roots);
    expect(manifest?.files).toEqual({ "npc/a.txt": await hash("a1"), "npc/b.txt": await hash("b") });
    const after = await readLastDeploy(disks.backend, disks.roots);
    expect(after?.report.results.map((entry) => entry.path)).toEqual(["npc/b.txt"]);
    // Un nouveau plan propose de nouveau la mise a jour.
    const again = await prepareDeploy(disks.backend, disks.roots, ["npc/a.txt"]);
    expect(again.plan.actions[0]?.kind).toBe("update");
  });

  it("n'ecrase pas ce qui a ete modifie depuis le deploiement", async () => {
    const disks = twoRoots();
    disks.project.put("a.txt", "a2");
    disks.destination.put("a.txt", "a1");
    const preparation = await prepareDeploy(disks.backend, disks.roots, ["a.txt"]);
    await runDeploy(disks.backend, disks.roots, preparation, { ...run, overwriteConflicts: true });
    disks.destination.put("a.txt", "retouche apres coup");
    const last = await readLastDeploy(disks.backend, disks.roots);
    if (last === null) throw new Error("rapport absent");
    expect(await rollbackLast(disks.backend, disks.roots, last)).toMatchObject({ restored: [], failed: [{ path: "a.txt", failure: "changed-since-deploy" }] });
    expect(disks.destination.textOf("a.txt")).toBe("retouche apres coup");
  });
});

describe("rapport et manifeste douteux", () => {
  it("ignore un rapport illisible, d'une autre version, ou dont l'horodatage n'a pas la forme attendue", async () => {
    const { project, backend, roots } = twoRoots();
    expect(await readLastDeploy(backend, roots)).toBeNull();
    for (const text of ["{", "42", JSON.stringify({ version: 2, stamp: "2026-11-09T17-30-05-123Z", report: { results: [] } }), JSON.stringify({ version: 1, stamp: "../../etc", report: { results: [] } }), JSON.stringify({ version: 1, stamp: "2026-11-09T17-30-05-123Z", report: {} }), JSON.stringify({ version: 1, stamp: "2026-11-09T17-30-05-123Z" })]) {
      project.put(lastReportPath(roots), text);
      expect(await readLastDeploy(backend, roots), text).toBeNull();
    }
    project.put(lastReportPath(roots), JSON.stringify({ version: 1, stamp: "2026-11-09T17-30-05-123Z", report: { results: [], complete: true, startedAtMs: 1, finishedAtMs: 2 } }));
    expect(await readLastDeploy(backend, roots)).toMatchObject({ stamp: "2026-11-09T17-30-05-123Z" });
  });

  it("ignore le manifeste d'une autre destination ou un manifeste invalide : le plan retombe sur « jamais deploye »", async () => {
    const { project, destination, backend, roots } = twoRoots();
    const sha = "a".repeat(64);
    project.put(manifestPath(roots), JSON.stringify({ version: 1, target: "autre-destination", deployedAtMs: 1, files: { "a.txt": sha } }));
    expect(await readManifest(backend, roots)).toBeNull();
    project.put(manifestPath(roots), "pas du JSON");
    expect(await readManifest(backend, roots)).toBeNull();
    project.put("a.txt", "a");
    destination.put("a.txt", "different");
    const preparation = await prepareDeploy(backend, roots, ["a.txt"]);
    expect(preparation.manifest).toBeNull();
    expect(preparation.plan.actions[0]).toMatchObject({ kind: "conflict", reason: "never-deployed" });
  });
});
