import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBackend } from "../test/fake-backend";
import { MemoryBuffer } from "../test/memory-buffer";
import { DocumentManager } from "./documents";

function setup(options: { snapshotDelayMs?: number; legacyEncoding?: string } = {}) {
  const backend = new FakeBackend();
  const buffers = new Map<string, MemoryBuffer>();
  const manager = new DocumentManager({
    backend,
    rootId: backend.root.id,
    createBuffer: (text, path) => {
      const buffer = new MemoryBuffer(text);
      buffers.set(path, buffer);
      return buffer;
    },
    legacyEncoding: () => options.legacyEncoding ?? "windows-1252",
    snapshotDelayMs: () => options.snapshotDelayMs ?? 1000,
  });
  const edit = (path: string, text: string): void => {
    const buffer = buffers.get(path);
    if (buffer === undefined) throw new Error("tampon absent");
    buffer.text = text;
    manager.notifyEdited(path);
  };
  return { backend, manager, buffers, edit };
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DocumentManager - ouverture", () => {
  it("decode le fichier, memorise l'encodage et les fins de ligne et normalise le texte de l'editeur en LF", async () => {
    const { backend, manager, buffers } = setup();
    backend.put("a.txt", "mes \"a\";\r\nclose;\r\n");
    const outcome = await manager.open("a.txt");
    expect(outcome).toMatchObject({ ok: true, alreadyOpen: false, info: { encoding: "utf-8", eol: "CRLF", dirty: false, external: "none" } });
    expect(buffers.get("a.txt")?.text).toBe('mes "a";\nclose;\n');
    expect(await manager.open("a.txt")).toMatchObject({ ok: true, alreadyOpen: true });
    expect(buffers.size).toBe(1);
  });

  it("refuse un fichier binaire et signale une lecture impossible", async () => {
    const { backend, manager } = setup();
    backend.put("bin.txt", bytes(0x4d, 0x5a, 0x00, 0x01));
    expect(await manager.open("bin.txt")).toEqual({ ok: false, reason: "unsupported", detail: "binary" });
    expect(await manager.open("absent.txt")).toMatchObject({ ok: false, reason: "error", error: { code: "not_found" } });
    expect(manager.has("bin.txt")).toBe(false);
  });
});

describe("DocumentManager - enregistrement", () => {
  it("n'ecrit jamais un document inchange", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "x\n");
    await manager.open("a.txt");
    expect(await manager.save("a.txt")).toEqual({ status: "unchanged" });
    edit("a.txt", "x\ny\n");
    edit("a.txt", "x\n"); // retour a l'etat enregistre
    expect(manager.info("a.txt")?.dirty).toBe(false);
    expect(await manager.save("a.txt")).toEqual({ status: "unchanged" });
    expect(backend.writes).toHaveLength(0);
  });

  it("restitue CRLF, BOM UTF-8 et ecrit avec la precondition de l'empreinte lue", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a\r\nb\r\n")]));
    await manager.open("a.txt");
    edit("a.txt", "a\nB\nc\n");
    const outcome = await manager.save("a.txt");
    expect(outcome).toMatchObject({ status: "saved", historySaved: true });
    expect([...(backend.bytesOf("a.txt") ?? [])]).toEqual([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a\r\nB\r\nc\r\n")]);
    expect(backend.writes[0]?.precondition.kind).toBe("mustMatch");
    expect(manager.info("a.txt")).toMatchObject({ dirty: false, external: "none", eol: "CRLF", bom: true });
  });

  it("conserve les fins de ligne d'un fichier mixte pour les lignes inchangees", async () => {
    const { backend, manager, edit } = setup();
    backend.put("m.txt", "a\r\nb\nc\r\n");
    await manager.open("m.txt");
    expect(manager.info("m.txt")?.eol).toBe("mixed");
    edit("m.txt", "A\nb\nc\n");
    await manager.save("m.txt");
    expect(backend.textOf("m.txt")).toBe("A\r\nb\nc\r\n");
  });

  it("reecrit un fichier en encodage herite sans alterer les octets non modifies", async () => {
    const { backend, manager, edit } = setup();
    backend.put("l.txt", bytes(...new TextEncoder().encode("mes \"caf"), 0xe9, ...new TextEncoder().encode("\";\n")));
    const opened = await manager.open("l.txt");
    expect(opened).toMatchObject({ ok: true, info: { encoding: "windows-1252" } });
    edit("l.txt", 'mes "café";\nclose;\n');
    await manager.save("l.txt");
    expect([...(backend.bytesOf("l.txt") ?? [])]).toEqual([...new TextEncoder().encode('mes "caf'), 0xe9, ...new TextEncoder().encode('";\nclose;\n')]);
  });

  it("bloque l'enregistrement d'un caractere non representable puis accepte la conversion explicite en UTF-8", async () => {
    const { backend, manager, edit } = setup();
    backend.put("l.txt", bytes(0x61, 0xe9, 0x0a));
    await manager.open("l.txt");
    edit("l.txt", "aé \u{1F600}\n");
    const blocked = await manager.save("l.txt");
    expect(blocked.status).toBe("unencodable");
    expect(backend.writes).toHaveLength(0);
    expect([...(backend.bytesOf("l.txt") ?? [])]).toEqual([0x61, 0xe9, 0x0a]); // disque intact
    manager.changeEncoding("l.txt", "utf-8", false);
    expect(manager.info("l.txt")).toMatchObject({ encoding: "utf-8", dirty: true });
    await manager.save("l.txt");
    expect(backend.textOf("l.txt")).toBe("aé \u{1F600}\n");
  });

  it("un changement d'encodage seul rend le document modifie et reecrit les octets", async () => {
    const { backend, manager } = setup();
    backend.put("l.txt", bytes(0x61, 0xe9, 0x0a));
    await manager.open("l.txt");
    manager.changeEncoding("l.txt", "utf-8", false);
    expect(manager.info("l.txt")?.dirty).toBe(true);
    await manager.save("l.txt");
    expect([...(backend.bytesOf("l.txt") ?? [])]).toEqual([0x61, 0xc3, 0xa9, 0x0a]);
    expect(manager.info("l.txt")?.dirty).toBe(false);
  });

  it("detecte une modification externe et ne l'ecrase pas sans decision explicite", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "mon edition\n");
    backend.put("a.txt", "modifie ailleurs\n");
    const outcome = await manager.save("a.txt");
    expect(outcome.status).toBe("conflict");
    expect(backend.textOf("a.txt")).toBe("modifie ailleurs\n");
    expect(manager.info("a.txt")).toMatchObject({ external: "modified", dirty: true });
    const forced = await manager.save("a.txt", { overwrite: true });
    expect(forced.status).toBe("saved");
    expect(backend.textOf("a.txt")).toBe("mon edition\n");
    expect(manager.info("a.txt")?.external).toBe("none");
  });

  it("permet d'abandonner ses modifications en rechargeant le disque", async () => {
    const { backend, manager, edit, buffers } = setup();
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "brouillon\n");
    backend.put("a.txt", "v2 externe\r\n");
    await manager.reloadFromDisk("a.txt");
    expect(buffers.get("a.txt")?.text).toBe("v2 externe\n");
    expect(manager.info("a.txt")).toMatchObject({ dirty: false, eol: "CRLF", external: "none" });
    expect(backend.recovery.size).toBe(0);
  });

  it("signale un fichier supprime puis le recree sur enregistrement explicite", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "v2\n");
    backend.files.delete("a.txt");
    expect((await manager.save("a.txt")).status).toBe("deleted");
    expect(manager.info("a.txt")?.external).toBe("deleted");
    expect((await manager.save("a.txt")).status).toBe("saved");
    expect(backend.textOf("a.txt")).toBe("v2\n");
  });

  it("refuse l'ecriture d'un fichier en lecture seule sans perdre les modifications", async () => {
    const { backend, manager, edit } = setup();
    backend.put("ro.txt", "x\n", { readonly: true });
    await manager.open("ro.txt");
    edit("ro.txt", "y\n");
    expect(await manager.save("ro.txt")).toMatchObject({ status: "error", error: { code: "permission_denied" } });
    expect(manager.info("ro.txt")?.dirty).toBe(true);
    expect(manager.textOf("ro.txt")).toBe("y\n");
  });

  it("serialise deux enregistrements simultanes sans faux conflit", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "v2\n");
    const first = manager.save("a.txt");
    const second = manager.save("a.txt");
    expect((await first).status).toBe("saved");
    expect((await second).status).toBe("unchanged");
    expect(backend.writes).toHaveLength(1);
  });

  it("conserve les modifications faites pendant l'ecriture", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "v2\n");
    backend.duringWrite = () => edit("a.txt", "v3\n"); // frappe pendant l'ecriture
    await manager.save("a.txt");
    backend.duringWrite = null;
    expect(backend.textOf("a.txt")).toBe("v2\n");
    expect(manager.info("a.txt")?.dirty).toBe(true);
    expect(manager.textOf("a.txt")).toBe("v3\n");
  });

  it("enregistre tous les documents modifies", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "1\n");
    backend.put("b.txt", "2\n");
    backend.put("c.txt", "3\n");
    for (const path of ["a.txt", "b.txt", "c.txt"]) await manager.open(path);
    edit("a.txt", "A\n");
    edit("c.txt", "C\n");
    const outcomes = await manager.saveAll();
    expect([...outcomes.keys()].sort()).toEqual(["a.txt", "c.txt"]);
    expect(backend.textOf("a.txt")).toBe("A\n");
    expect(backend.textOf("b.txt")).toBe("2\n");
  });
});

describe("DocumentManager - recuperation", () => {
  it("ecrit un instantane de recuperation apres le delai, regroupe les frappes et le supprime a l'enregistrement", async () => {
    const { backend, manager, edit } = setup({ snapshotDelayMs: 1000 });
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "v1 a\n");
    await vi.advanceTimersByTimeAsync(600);
    edit("a.txt", "v1 ab\n"); // relance le delai
    await vi.advanceTimersByTimeAsync(600);
    expect(backend.recovery.size).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.recovery.size).toBe(1);
    expect(new TextDecoder().decode(backend.recovery.get("a.txt")?.data)).toBe("v1 ab\n");
    expect(backend.recovery.get("a.txt")?.meta.baseSha256).toBe(manager.info("a.txt")?.stat.sha256);
    await manager.save("a.txt");
    expect(backend.recovery.size).toBe(0);
  });

  it("supprime l'instantane quand le texte revient a l'etat enregistre", async () => {
    const { backend, manager, edit } = setup({ snapshotDelayMs: 100 });
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "v2\n");
    await vi.advanceTimersByTimeAsync(150);
    expect(backend.recovery.size).toBe(1);
    edit("a.txt", "v1\n");
    await vi.advanceTimersByTimeAsync(10);
    expect(backend.recovery.size).toBe(0);
  });

  it("restaure un instantane : document modifie, conflit signale si le disque a change depuis", async () => {
    const { backend, manager } = setup();
    backend.put("a.txt", "disque\n");
    const meta = { version: 1, relative: "a.txt", savedAtMs: 1, baseSha256: "autre-empreinte", encoding: "utf-8" };
    const outcome = await manager.restoreRecovered("a.txt", "texte recupere\n", meta);
    expect(outcome).toMatchObject({ ok: true, info: { dirty: true, external: "modified" } });
    expect(manager.textOf("a.txt")).toBe("texte recupere\n");
    expect(backend.textOf("a.txt")).toBe("disque\n"); // rien n'est ecrit tant que l'utilisateur n'enregistre pas
  });

  it("restaure un instantane dont le fichier a disparu : texte conserve, enregistrement recree le fichier", async () => {
    const { backend, manager } = setup();
    const meta = { version: 1, relative: "gone.txt", savedAtMs: 1, baseSha256: "x", encoding: "utf-8" };
    const outcome = await manager.restoreRecovered("gone.txt", "contenu sauve\n", meta);
    expect(outcome).toMatchObject({ ok: true, info: { dirty: true, external: "deleted" } });
    expect((await manager.save("gone.txt")).status).toBe("saved");
    expect(backend.textOf("gone.txt")).toBe("contenu sauve\n");
  });
});

describe("DocumentManager - modifications externes et fermeture", () => {
  it("recharge silencieusement un document inchange modifie sur le disque", async () => {
    const { backend, manager, buffers } = setup();
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    backend.put("a.txt", "v2\n");
    const changes = await manager.checkExternalChanges();
    expect(changes).toEqual([{ path: "a.txt", action: "reloaded" }]);
    expect(buffers.get("a.txt")?.text).toBe("v2\n");
    expect(manager.info("a.txt")?.dirty).toBe(false);
  });

  it("signale un conflit sans toucher au texte modifie, puis un fichier supprime", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "v1\n");
    backend.put("b.txt", "b\n");
    await manager.open("a.txt");
    await manager.open("b.txt");
    edit("a.txt", "mon travail\n");
    backend.put("a.txt", "externe\n");
    backend.files.delete("b.txt");
    const changes = await manager.checkExternalChanges();
    expect(changes).toEqual(expect.arrayContaining([{ path: "a.txt", action: "conflict" }, { path: "b.txt", action: "deleted" }]));
    expect(manager.textOf("a.txt")).toBe("mon travail\n");
    expect(manager.info("a.txt")?.external).toBe("modified");
    // Un second controle ne rejoue pas les memes alertes.
    expect(await manager.checkExternalChanges()).toEqual([]);
  });

  it("efface le marqueur de conflit quand le disque revient au contenu lu", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "mien\n");
    backend.put("a.txt", "externe\n");
    await manager.checkExternalChanges();
    expect(manager.info("a.txt")?.external).toBe("modified");
    backend.put("a.txt", "v1\n");
    await manager.checkExternalChanges();
    expect(manager.info("a.txt")?.external).toBe("none");
  });

  it("ferme un document : libere le tampon, annule l'instantane et supprime la recuperation", async () => {
    const { backend, manager, edit, buffers } = setup({ snapshotDelayMs: 100 });
    backend.put("a.txt", "v1\n");
    await manager.open("a.txt");
    edit("a.txt", "v2\n");
    await vi.advanceTimersByTimeAsync(150);
    expect(backend.recovery.size).toBe(1);
    const events: string[] = [];
    manager.subscribe((event) => events.push(event.type));
    await manager.close("a.txt");
    expect(buffers.get("a.txt")?.disposed).toBe(true);
    expect(backend.recovery.size).toBe(0);
    expect(manager.has("a.txt")).toBe(false);
    expect(events).toContain("closed");
  });

  it("liste les documents modifies", async () => {
    const { backend, manager, edit } = setup();
    backend.put("a.txt", "1\n");
    backend.put("b.txt", "2\n");
    await manager.open("a.txt");
    await manager.open("b.txt");
    edit("b.txt", "B\n");
    expect(manager.dirtyPaths()).toEqual(["b.txt"]);
  });
});

describe("DocumentManager - contenu fourni par un assistant", () => {
  it("remplace le contenu d'un document ouvert : modifie, rien d'ecrit, instantane de recuperation planifie", async () => {
    const { backend, manager, buffers } = setup({ snapshotDelayMs: 100 });
    backend.put("neuf.txt", "");
    await manager.open("neuf.txt");
    const writes = backend.writes.length;
    const events: string[] = [];
    manager.subscribe((event) => events.push(event.type));

    expect(manager.setContent("neuf.txt", "prontera,1,1,0\twarp\tw\t1,1,geffen,1,1\n")).toBe(true);

    expect(buffers.get("neuf.txt")?.text).toBe("prontera,1,1,0\twarp\tw\t1,1,geffen,1,1\n");
    expect(manager.textOf("neuf.txt")).toBe("prontera,1,1,0\twarp\tw\t1,1,geffen,1,1\n");
    expect(manager.info("neuf.txt")?.dirty).toBe(true);
    expect(manager.dirtyPaths()).toEqual(["neuf.txt"]);
    expect(events).toEqual(["changed"]);
    expect(backend.writes.length).toBe(writes);
    expect(backend.textOf("neuf.txt")).toBe("");
    await vi.advanceTimersByTimeAsync(150);
    expect(backend.recovery.get("neuf.txt")?.data).toEqual(new TextEncoder().encode("prontera,1,1,0\twarp\tw\t1,1,geffen,1,1\n"));
  });

  it("normalise les fins de ligne en LF et s'enregistre comme une modification ordinaire", async () => {
    const { backend, manager, buffers } = setup();
    backend.put("neuf.txt", "");
    await manager.open("neuf.txt");
    manager.setContent("neuf.txt", "a\r\nb\rc\n");
    expect(buffers.get("neuf.txt")?.text).toBe("a\nb\nc\n");
    expect(await manager.save("neuf.txt")).toMatchObject({ status: "saved" });
    expect(backend.textOf("neuf.txt")).toBe("a\nb\nc\n");
    expect(manager.info("neuf.txt")?.dirty).toBe(false);
  });

  it("ne fait rien pour un document qui n'est pas ouvert", () => {
    const { backend, manager } = setup();
    expect(manager.setContent("absent.txt", "x\n")).toBe(false);
    expect(backend.writes).toEqual([]);
  });
});
