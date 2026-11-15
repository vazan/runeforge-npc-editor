import { describe, expect, it } from "vitest";
import {
  bytesWithConflicts,
  executeDeploy,
  findBlockers,
  MAX_MANIFEST_FILES,
  nextManifest,
  parseManifest,
  planDeploy,
  rollbackDeploy,
  serializeManifest,
  type DeployIo,
  type DeployManifest,
  type DeployPlan,
  type DeployReport,
  type FileEntry,
  type RemotePrecondition,
  type RollbackIo,
} from "./index";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const hash = (text: string): Promise<string> => sha256(encode(text));
const entry = async (path: string, text: string): Promise<FileEntry> => ({ path, size: encode(text).length, sha256: await hash(text) });

/** Un projet et une destination en memoire, avec de quoi faire echouer chaque etape. */
class Memory implements DeployIo, RollbackIo {
  readonly local = new Map<string, string>();
  readonly remote = new Map<string, string>();
  readonly backups = new Map<string, string>();
  readonly calls: string[] = [];
  failOn: { op: "readLocal" | "readRemote" | "saveBackup" | "writeRemote"; path: string } | null = null;
  /** Fait ecrire autre chose que ce qui est envoye (la relecture doit le voir). */
  corruptWrites = new Set<string>();
  /** Modifie la destination au moment de l'ecriture (une main concurrente). */
  beforeWrite: ((path: string) => void) | null = null;

  private fails(op: string, path: string): boolean {
    return this.failOn !== null && this.failOn.op === op && this.failOn.path === path;
  }

  async readLocal(path: string): Promise<Uint8Array> {
    this.calls.push(`readLocal ${path}`);
    const text = this.local.get(path);
    if (text === undefined || this.fails("readLocal", path)) throw new Error("illisible");
    return encode(text);
  }
  async readRemote(path: string): Promise<Uint8Array | null> {
    this.calls.push(`readRemote ${path}`);
    if (this.fails("readRemote", path)) throw new Error("illisible");
    const text = this.remote.get(path);
    return text === undefined ? null : encode(text);
  }
  async writeRemote(path: string, bytes: Uint8Array, precondition: RemotePrecondition): Promise<void> {
    this.calls.push(`writeRemote ${path} ${precondition.kind}`);
    this.beforeWrite?.(path);
    if (this.fails("writeRemote", path)) throw new Error("ecriture impossible");
    const existing = this.remote.get(path);
    if (precondition.kind === "mustNotExist" && existing !== undefined) throw new Error("existe deja");
    if (precondition.kind === "mustMatch" && (existing === undefined || (await hash(existing)) !== precondition.sha256)) throw new Error("modifie");
    this.remote.set(path, this.corruptWrites.has(path) ? "corrompu" : (decode(bytes) ?? ""));
  }
  async saveBackup(path: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`saveBackup ${path}`);
    if (this.fails("saveBackup", path)) throw new Error("sauvegarde impossible");
    this.backups.set(path, decode(bytes) ?? "");
  }
  async readBackup(path: string): Promise<Uint8Array | null> {
    const text = this.backups.get(path);
    return text === undefined ? null : encode(text);
  }
  sha256 = sha256;
}

async function planOf(memory: Memory, baseline: Record<string, string> = {}): Promise<DeployPlan> {
  const local: FileEntry[] = [];
  const remote = new Map<string, FileEntry>();
  for (const [path, text] of memory.local) local.push(await entry(path, text));
  for (const [path, text] of memory.remote) remote.set(path, await entry(path, text));
  const known = new Map<string, string>();
  for (const [path, text] of Object.entries(baseline)) known.set(path, await hash(text));
  return planDeploy({ local, remote, baseline: known });
}

const options = (overrides: Partial<Parameters<typeof executeDeploy>[2]> = {}) => ({ overwriteConflicts: false, now: () => 1000, ...overrides });

// ---------------------------------------------------------------------------------------------------------------------------
describe("plan (dry-run)", () => {
  it("distingue ce qui sera cree, mis a jour, laisse tel quel et ce qui est en conflit", async () => {
    const memory = new Memory();
    for (const [path, text] of Object.entries({ "npc/neuf.txt": "n", "npc/maj.txt": "v2", "npc/pareil.txt": "p", "npc/jamais.txt": "j2", "npc/change.txt": "c2" })) memory.local.set(path, text);
    for (const [path, text] of Object.entries({ "npc/maj.txt": "v1", "npc/pareil.txt": "p", "npc/jamais.txt": "j1", "npc/change.txt": "c-modifie-ailleurs" })) memory.remote.set(path, text);
    // Le dernier deploiement a laisse maj.txt en v1 et change.txt en c1 ; jamais.txt ne vient pas de nous.
    const plan = await planOf(memory, { "npc/maj.txt": "v1", "npc/change.txt": "c1", "npc/pareil.txt": "p" });
    expect(plan.actions.map((action) => [action.path, action.kind, action.reason])).toEqual([
      ["npc/change.txt", "conflict", "remote-changed"],
      ["npc/jamais.txt", "conflict", "never-deployed"],
      ["npc/maj.txt", "update", undefined],
      ["npc/neuf.txt", "create", undefined],
      ["npc/pareil.txt", "unchanged", undefined],
    ]);
    expect(plan.counts).toEqual({ create: 1, update: 1, unchanged: 1, conflict: 2 });
    // Seuls les envois certains comptent : les conflits ne sont pas envoyes sans decision.
    expect(plan.bytes).toBe(1 + 2);
    expect(bytesWithConflicts(plan)).toBe(1 + 2 + 2 + 2);
    expect(plan.actions.find((action) => action.path === "npc/maj.txt")?.remote).toEqual(await entry("npc/maj.txt", "v1"));
    expect(plan.actions.find((action) => action.path === "npc/neuf.txt")?.remote).toBeNull();
  });

  it("n'a aucun effet : un plan ne lit ni n'ecrit rien", async () => {
    const memory = new Memory();
    memory.local.set("a.txt", "a");
    await planOf(memory);
    expect(memory.calls).toEqual([]);
    expect(memory.remote.size).toBe(0);
  });

  it("un fichier identique a la destination est inchange meme sans deploiement anterieur", async () => {
    const memory = new Memory();
    memory.local.set("a.txt", "a");
    memory.remote.set("a.txt", "a");
    expect((await planOf(memory)).actions[0]?.kind).toBe("unchanged");
  });

  it("ne garde qu'une action par chemin, range par chemin, et accepte un plan vide", async () => {
    const first = await entry("b.txt", "1");
    const last = await entry("b.txt", "22");
    const plan = planDeploy({ local: [await entry("c.txt", "c"), first, last, await entry("a.txt", "a")], remote: new Map(), baseline: new Map() });
    expect(plan.actions.map((action) => [action.path, action.size])).toEqual([["a.txt", 1], ["b.txt", 2], ["c.txt", 1]]);
    expect(planDeploy({ local: [], remote: new Map(), baseline: new Map() })).toEqual({ actions: [], counts: { create: 0, update: 0, unchanged: 0, conflict: 0 }, bytes: 0 });
  });

  it("repere les fichiers a envoyer qui ont des erreurs d'analyse", async () => {
    const memory = new Memory();
    for (const [path, text] of Object.entries({ "a.txt": "a", "b.txt": "b2", "c.txt": "c", "d.txt": "d2" })) memory.local.set(path, text);
    memory.remote.set("b.txt", "b1");
    memory.remote.set("c.txt", "c");
    memory.remote.set("d.txt", "d1");
    const plan = await planOf(memory, { "b.txt": "b1" });
    const errors = new Map([["a.txt", 2], ["b.txt", 1], ["c.txt", 5], ["d.txt", 3], ["e.txt", 4]]);
    // c.txt est identique (rien a envoyer) ; d.txt est en conflit (envoye seulement si on l'ecrase) ; e.txt n'est pas dans le plan.
    expect(findBlockers(plan, errors, false)).toEqual(["a.txt", "b.txt"]);
    expect(findBlockers(plan, errors, true)).toEqual(["a.txt", "b.txt", "d.txt"]);
    expect(findBlockers(plan, new Map(), true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("manifeste du dernier deploiement", () => {
  const sha = "a".repeat(64);

  it("est ecrit en JSON stable et relu a l'identique", () => {
    const manifest: DeployManifest = { version: 1, target: "test", deployedAtMs: 12, files: { "b.txt": sha, "a/c.txt": "b".repeat(64) } };
    const text = serializeManifest(manifest);
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text).files)).toEqual(["a/c.txt", "b.txt"]);
    expect(parseManifest(text)).toEqual(manifest);
    expect(serializeManifest(parseManifest(text) as DeployManifest)).toBe(text);
  });

  it.each([
    ["JSON invalide", "{"],
    ["pas un objet", "42"],
    ["null", "null"],
    ["version inconnue", JSON.stringify({ version: 2, target: "t", deployedAtMs: 1, files: {} })],
    ["destination vide", JSON.stringify({ version: 1, target: "", deployedAtMs: 1, files: {} })],
    ["destination absente", JSON.stringify({ version: 1, deployedAtMs: 1, files: {} })],
    ["date absente", JSON.stringify({ version: 1, target: "t", files: {} })],
    ["date infinie", '{"version":1,"target":"t","deployedAtMs":1e999,"files":{}}'],
    ["fichiers en tableau", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: [] })],
    ["empreinte trop courte", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "a.txt": "abc" } })],
    ["empreinte en majuscules", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "a.txt": "A".repeat(64) } })],
    ["empreinte pas un texte", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "a.txt": 5 } })],
    ["chemin remontant", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "../a.txt": sha } })],
    ["chemin avec ..", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "a/../b.txt": sha } })],
    ["chemin absolu", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "/a.txt": sha } })],
    ["chemin avec antislash", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "a\\b.txt": sha } })],
    ["chemin avec deux-points", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "C:a.txt": sha } })],
    ["segment vide", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "a//b.txt": sha } })],
    ["segment point", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "./a.txt": sha } })],
    ["chemin vide", JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files: { "": sha } })],
  ])("refuse un manifeste douteux : %s", (_name, text) => {
    expect(parseManifest(text)).toBeNull();
  });

  it("refuse un manifeste trop gros", () => {
    const files: Record<string, string> = {};
    for (let index = 0; index <= MAX_MANIFEST_FILES; index += 1) files[`f${index}.txt`] = sha;
    expect(parseManifest(JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files }))).toBeNull();
    delete files["f0.txt"];
    expect(parseManifest(JSON.stringify({ version: 1, target: "t", deployedAtMs: 1, files }))).not.toBeNull();
  });

  it("n'ajoute a la reference que les fichiers qui sont maintenant identiques a la destination", () => {
    const previous: DeployManifest = { version: 1, target: "test", deployedAtMs: 1, files: { "garde.txt": sha, "maj.txt": "1".repeat(64), "echec.txt": "2".repeat(64) } };
    const report: DeployReport = {
      startedAtMs: 5,
      finishedAtMs: 9,
      complete: false,
      results: [
        { path: "neuf.txt", status: "created", sha256: "3".repeat(64) },
        { path: "maj.txt", status: "updated", sha256: "4".repeat(64), previousSha256: "1".repeat(64) },
        { path: "ecrase.txt", status: "overwritten", sha256: "5".repeat(64), previousSha256: "6".repeat(64) },
        { path: "pareil.txt", status: "unchanged", sha256: "7".repeat(64) },
        { path: "echec.txt", status: "failed", failure: "write-failed" },
        { path: "conflit.txt", status: "skipped", skippedBecause: "conflict" },
        { path: "arret.txt", status: "skipped", skippedBecause: "stopped" },
      ],
    };
    expect(nextManifest(previous, "test", report)).toEqual({
      version: 1,
      target: "test",
      deployedAtMs: 9,
      files: { "garde.txt": sha, "maj.txt": "4".repeat(64), "echec.txt": "2".repeat(64), "neuf.txt": "3".repeat(64), "ecrase.txt": "5".repeat(64), "pareil.txt": "7".repeat(64) },
    });
    // Le manifeste d'une autre destination ne sert pas.
    expect(Object.keys(nextManifest(previous, "autre", report).files).sort()).toEqual(["ecrase.txt", "maj.txt", "neuf.txt", "pareil.txt"]);
    expect(Object.keys(nextManifest(null, "test", report).files).sort()).toEqual(["ecrase.txt", "maj.txt", "neuf.txt", "pareil.txt"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("execution", () => {
  async function ready(): Promise<{ memory: Memory; plan: DeployPlan }> {
    const memory = new Memory();
    for (const [path, text] of Object.entries({ "a.txt": "a2", "b.txt": "b", "c.txt": "c" })) memory.local.set(path, text);
    memory.remote.set("a.txt", "a1");
    memory.remote.set("c.txt", "c");
    return { memory, plan: await planOf(memory, { "a.txt": "a1" }) };
  }

  it("cree, remplace apres sauvegarde, relit pour verifier, et ne retransfere pas l'identique", async () => {
    const { memory, plan } = await ready();
    const report = await executeDeploy(plan, memory, options());
    expect(report.complete).toBe(true);
    expect(report.results.map((result) => [result.path, result.status])).toEqual([["a.txt", "updated"], ["b.txt", "created"], ["c.txt", "unchanged"]]);
    expect(Object.fromEntries(memory.remote)).toEqual({ "a.txt": "a2", "b.txt": "b", "c.txt": "c" });
    expect(Object.fromEntries(memory.backups)).toEqual({ "a.txt": "a1" });
    const updated = report.results[0];
    expect(updated).toMatchObject({ sha256: await hash("a2"), previousSha256: await hash("a1") });
    // L'identique n'est ni lu cote destination ni ecrit.
    expect(memory.calls.filter((call) => call.includes("c.txt"))).toEqual([]);
  });

  it("sauvegarde avant d'ecrire, ecrit sous precondition, et relit apres", async () => {
    const { memory, plan } = await ready();
    await executeDeploy(plan, memory, options());
    expect(memory.calls.filter((call) => call.includes("a.txt"))).toEqual([
      "readLocal a.txt",
      "readRemote a.txt",
      "saveBackup a.txt",
      "writeRemote a.txt mustMatch",
      "readRemote a.txt",
    ]);
    expect(memory.calls.filter((call) => call.includes("b.txt"))).toEqual(["readLocal b.txt", "writeRemote b.txt mustNotExist", "readRemote b.txt"]);
  });

  it("laisse de cote un conflit tant que l'utilisateur ne decide pas de l'ecraser, puis l'ecrase apres sauvegarde", async () => {
    const memory = new Memory();
    memory.local.set("x.txt", "nouveau");
    memory.remote.set("x.txt", "travail d'un autre");
    const plan = await planOf(memory);
    const skipped = await executeDeploy(plan, memory, options());
    expect(skipped.results).toEqual([{ path: "x.txt", status: "skipped", skippedBecause: "conflict" }]);
    expect(skipped.complete).toBe(false);
    expect(memory.remote.get("x.txt")).toBe("travail d'un autre");
    expect(memory.calls).toEqual([]);

    const overwritten = await executeDeploy(plan, memory, options({ overwriteConflicts: true }));
    expect(overwritten.results[0]).toMatchObject({ status: "overwritten", previousSha256: await hash("travail d'un autre") });
    expect(memory.remote.get("x.txt")).toBe("nouveau");
    expect(memory.backups.get("x.txt")).toBe("travail d'un autre");
  });

  it("s'arrete au premier echec : les fichiers suivants ne sont pas envoyes", async () => {
    const { memory, plan } = await ready();
    memory.failOn = { op: "writeRemote", path: "a.txt" };
    const report = await executeDeploy(plan, memory, options());
    expect(report.complete).toBe(false);
    expect(report.results.map((result) => [result.path, result.status, result.failure ?? result.skippedBecause])).toEqual([
      ["a.txt", "failed", "write-failed"],
      ["b.txt", "skipped", "stopped"],
      ["c.txt", "unchanged", undefined],
    ]);
    expect(memory.remote.has("b.txt")).toBe(false);
  });

  it.each([
    ["le fichier local est illisible", { op: "readLocal", path: "b.txt" } as const, "b.txt", "read-failed"],
    ["la destination est illisible", { op: "readRemote", path: "a.txt" } as const, "a.txt", "remote-changed"],
    ["la sauvegarde echoue", { op: "saveBackup", path: "a.txt" } as const, "a.txt", "backup-failed"],
    ["l'ecriture echoue", { op: "writeRemote", path: "b.txt" } as const, "b.txt", "write-failed"],
  ])("%s", async (_name, failOn, path, failure) => {
    const { memory, plan } = await ready();
    memory.failOn = failOn;
    const report = await executeDeploy(plan, memory, options());
    expect(report.results.find((result) => result.path === path)).toMatchObject({ status: "failed", failure });
    // Sans sauvegarde, rien n'est ecrit par-dessus.
    if (failure === "backup-failed") expect(memory.remote.get("a.txt")).toBe("a1");
  });

  it("refuse d'envoyer un fichier local qui a change depuis le plan", async () => {
    const { memory, plan } = await ready();
    memory.local.set("b.txt", "b-modifie-depuis-le-plan");
    const report = await executeDeploy(plan, memory, options());
    expect(report.results.find((result) => result.path === "b.txt")).toMatchObject({ status: "failed", failure: "local-changed" });
    expect(memory.remote.has("b.txt")).toBe(false);
  });

  it("refuse de remplacer un fichier de la destination qui a change depuis le plan, sans rien ecrire ni sauvegarder", async () => {
    const { memory, plan } = await ready();
    memory.remote.set("a.txt", "modifie pendant la confirmation");
    const report = await executeDeploy(plan, memory, options());
    expect(report.results[0]).toMatchObject({ path: "a.txt", status: "failed", failure: "remote-changed" });
    expect(memory.remote.get("a.txt")).toBe("modifie pendant la confirmation");
    expect(memory.backups.size).toBe(0);
  });

  it("detecte une modification concurrente entre la lecture et l'ecriture grace a la precondition", async () => {
    const { memory, plan } = await ready();
    memory.beforeWrite = (path) => {
      if (path === "a.txt") memory.remote.set("a.txt", "quelqu'un d'autre a ecrit ici");
    };
    const report = await executeDeploy(plan, memory, options());
    expect(report.results[0]).toMatchObject({ status: "failed", failure: "write-failed" });
    expect(memory.remote.get("a.txt")).toBe("quelqu'un d'autre a ecrit ici");
  });

  it("refuse d'ecraser un fichier apparu a la destination entre le plan et la creation", async () => {
    const { memory, plan } = await ready();
    memory.beforeWrite = (path) => {
      if (path === "b.txt") memory.remote.set("b.txt", "apparu entre-temps");
    };
    const report = await executeDeploy(plan, memory, options());
    expect(report.results.find((result) => result.path === "b.txt")).toMatchObject({ status: "failed", failure: "write-failed" });
    expect(memory.remote.get("b.txt")).toBe("apparu entre-temps");
  });

  it("signale un fichier qui n'est pas celui qu'on a envoye quand on le relit", async () => {
    const { memory, plan } = await ready();
    memory.corruptWrites.add("b.txt");
    const report = await executeDeploy(plan, memory, options());
    expect(report.results.find((result) => result.path === "b.txt")).toMatchObject({ status: "failed", failure: "verify-failed" });
    expect(report.complete).toBe(false);
  });

  it("s'arrete quand l'utilisateur annule, entre deux fichiers", async () => {
    const { memory, plan } = await ready();
    const controller = new AbortController();
    const seen: number[] = [];
    const report = await executeDeploy(plan, memory, options({ signal: controller.signal, onProgress: (done) => { seen.push(done); if (done === 1) controller.abort(); } }));
    expect(report.results.map((result) => [result.path, result.status, result.skippedBecause])).toEqual([["a.txt", "updated", undefined], ["b.txt", "skipped", "stopped"], ["c.txt", "unchanged", undefined]]);
    expect(report.complete).toBe(false);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("date le rapport", async () => {
    const { memory, plan } = await ready();
    let clock = 100;
    const report = await executeDeploy(plan, memory, options({ now: () => (clock += 50) }));
    expect(report.startedAtMs).toBe(150);
    expect(report.finishedAtMs).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("restauration", () => {
  async function deployed(): Promise<{ memory: Memory; report: DeployReport }> {
    const memory = new Memory();
    for (const [path, text] of Object.entries({ "a.txt": "a2", "b.txt": "b", "x.txt": "x2" })) memory.local.set(path, text);
    memory.remote.set("a.txt", "a1");
    memory.remote.set("x.txt", "x1");
    const plan = await planOf(memory, { "a.txt": "a1" });
    const report = await executeDeploy(plan, memory, options({ overwriteConflicts: true }));
    expect(report.results.map((result) => result.status)).toEqual(["updated", "created", "overwritten"]);
    return { memory, report };
  }

  it("remet en place ce qui a ete remplace, et laisse en place ce qui a ete cree", async () => {
    const { memory, report } = await deployed();
    const rollback = await rollbackDeploy(report, memory);
    expect(rollback).toEqual({ restored: ["a.txt", "x.txt"], failed: [], leftInPlace: ["b.txt"] });
    expect(Object.fromEntries(memory.remote)).toEqual({ "a.txt": "a1", "b.txt": "b", "x.txt": "x1" });
  });

  it("n'ecrase pas un fichier modifie depuis le deploiement", async () => {
    const { memory, report } = await deployed();
    memory.remote.set("a.txt", "retouche apres le deploiement");
    const rollback = await rollbackDeploy(report, memory);
    expect(rollback.failed).toEqual([{ path: "a.txt", failure: "changed-since-deploy" }]);
    expect(rollback.restored).toEqual(["x.txt"]);
    expect(memory.remote.get("a.txt")).toBe("retouche apres le deploiement");
  });

  it("signale une sauvegarde disparue ou alteree sans rien ecrire", async () => {
    const { memory, report } = await deployed();
    memory.backups.delete("a.txt");
    memory.backups.set("x.txt", "sauvegarde alteree");
    const rollback = await rollbackDeploy(report, memory);
    expect(rollback.failed).toEqual([{ path: "a.txt", failure: "backup-missing" }, { path: "x.txt", failure: "backup-missing" }]);
    expect(memory.remote.get("a.txt")).toBe("a2");
    expect(memory.remote.get("x.txt")).toBe("x2");
  });

  it("signale une ecriture impossible et une restauration qui ne se verifie pas", async () => {
    const { memory, report } = await deployed();
    memory.failOn = { op: "writeRemote", path: "a.txt" };
    memory.corruptWrites.add("x.txt");
    const rollback = await rollbackDeploy(report, memory);
    expect(rollback.failed).toEqual([{ path: "a.txt", failure: "write-failed" }, { path: "x.txt", failure: "verify-failed" }]);
    expect(rollback.restored).toEqual([]);
  });

  it("ignore ce qui n'a rien change a la destination", async () => {
    const memory = new Memory();
    const report: DeployReport = {
      startedAtMs: 1,
      finishedAtMs: 2,
      complete: false,
      results: [
        { path: "pareil.txt", status: "unchanged", sha256: "a".repeat(64) },
        { path: "echec.txt", status: "failed", failure: "write-failed" },
        { path: "conflit.txt", status: "skipped", skippedBecause: "conflict" },
      ],
    };
    expect(await rollbackDeploy(report, memory)).toEqual({ restored: [], failed: [], leftInPlace: [] });
    expect(memory.calls).toEqual([]);
  });
});
