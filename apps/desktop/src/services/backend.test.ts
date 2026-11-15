import { describe, expect, it } from "vitest";
import { createTauriBackend, type TauriBindings } from "./backend";
import { encodeFrames } from "./frames";
import { BackendError } from "./types";

interface Call {
  command: string;
  args: unknown;
  headers?: Record<string, string>;
}

function fakeTauri(responses: Record<string, unknown>): { bindings: TauriBindings; calls: Call[] } {
  const calls: Call[] = [];
  const bindings: TauriBindings = {
    async invoke<T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
      calls.push({ command, args, ...(options?.headers === undefined ? {} : { headers: options.headers }) });
      const response = responses[command];
      if (response instanceof Error) throw response;
      // Tauri rejette la promesse avec la valeur d'erreur serialisee par le coeur Rust.
      if (typeof response === "object" && response !== null && "__reject" in response) throw (response as { __reject: unknown }).__reject;
      if (typeof response === "function") return (response as (a: unknown) => T)(args);
      return response as T;
    },
    async listen() {
      return () => undefined;
    },
  };
  return { bindings, calls };
}

describe("createTauriBackend", () => {
  it("transmet les arguments en camelCase et convertit les erreurs structurees", async () => {
    const { bindings, calls } = fakeTauri({
      scan_project: { entries: [], skipped: [], truncated: false },
      open_recent_project: { __reject: { code: "unknown_root" } },
    });
    const backend = createTauriBackend(bindings);
    await backend.scanProject("r1", { exclude: ["**/.git/**"] });
    expect(calls[0]).toMatchObject({ command: "scan_project", args: { rootId: "r1", options: { exclude: ["**/.git/**"] } } });
    await expect(backend.openRecentProject("C:\\x")).rejects.toMatchObject({ name: "BackendError", code: "unknown_root" });
  });

  it("envoie les ecritures avec un corps binaire et des metadonnees encodees dans l'en-tete", async () => {
    const { bindings, calls } = fakeTauri({
      write_file: { stat: { size: 3, modifiedMs: 1, sha256: "aa", readonly: false }, created: false, historySaved: true },
    });
    const backend = createTauriBackend(bindings);
    const data = Uint8Array.of(1, 2, 3);
    await backend.writeFile("r1", "npc/caf\u00e9 \"x\".txt", data, { kind: "mustMatch", sha256: "abc" });
    const call = calls[0];
    expect(call?.command).toBe("write_file");
    expect(call?.args).toBe(data);
    const header = call?.headers?.["x-rf-meta"] ?? "";
    expect(header).toMatch(/^[\x20-\x7e]+$/); // ASCII uniquement
    expect(JSON.parse(decodeURIComponent(header))).toEqual({
      rootId: "r1",
      path: "npc/caf\u00e9 \"x\".txt",
      precondition: { kind: "mustMatch", sha256: "abc" },
      keepHistory: true,
    });
  });

  it("decode les lectures par lots en conservant l'ordre et les erreurs individuelles", async () => {
    const stat = { size: 2, modifiedMs: 5, sha256: "ff", readonly: false };
    const { bindings, calls } = fakeTauri({
      read_files: (args: unknown) => {
        const { paths } = args as { paths: string[] };
        return encodeFrames(
          paths.map((path) =>
            path === "missing.txt"
              ? { meta: { path, ok: false, error: { code: "not_found" } }, data: new Uint8Array() }
              : { meta: { path, ok: true, stat }, data: new TextEncoder().encode(`contenu de ${path}`) },
          ),
        ).buffer;
      },
    });
    const backend = createTauriBackend(bindings);
    const paths = Array.from({ length: 300 }, (_, index) => (index === 7 ? "missing.txt" : `f${index}.txt`));
    const results = await backend.readFiles("r1", paths);
    expect(calls.map((call) => (call.args as { paths: string[] }).paths.length)).toEqual([256, 44]); // lots
    expect(results).toHaveLength(300);
    expect(results[0]).toMatchObject({ ok: true, path: "f0.txt" });
    expect(results[7]).toMatchObject({ ok: false, path: "missing.txt" });
    const failed = results[7];
    expect(failed?.ok === false && failed.error).toBeInstanceOf(BackendError);
    const first = results[0];
    expect(first?.ok && new TextDecoder().decode(first.bytes)).toBe("contenu de f0.txt");
  });

  it("detecte un nombre de trames inattendu", async () => {
    const { bindings } = fakeTauri({ read_files: encodeFrames([]).buffer });
    await expect(createTauriBackend(bindings).readFiles("r1", ["a.txt"])).rejects.toMatchObject({ code: "protocol" });
  });

  it("lit une recuperation et un historique via des trames", async () => {
    const meta = { version: 1, relative: "a.txt", savedAtMs: 9, baseSha256: "abc", encoding: "windows-1252" };
    const { bindings } = fakeTauri({
      recovery_read: encodeFrames([{ meta: { path: "a.txt", ok: true, recovery: meta }, data: Uint8Array.of(7, 8) }]).buffer,
      history_read: encodeFrames([{ meta: { path: "a.txt", ok: true, id: "1.bak" }, data: Uint8Array.of(5) }]).buffer,
    });
    const backend = createTauriBackend(bindings);
    const recovered = await backend.recoveryRead("r1", "a.txt");
    expect(recovered.meta).toEqual(meta);
    expect([...recovered.data]).toEqual([7, 8]);
    expect([...(await backend.historyRead("r1", "a.txt", "1.bak"))]).toEqual([5]);
  });

  it("demande l'etat Git en camelCase, sans chemin, et lit le contenu de HEAD dans une trame", async () => {
    const status = { branch: "main", detached: false, unborn: false, head: "0123456789ab", entries: [{ path: "npc/a.txt", x: ".", y: "M" }], truncated: false };
    const { bindings, calls } = fakeTauri({
      git_status: status,
      git_head_file: encodeFrames([{ meta: { path: "npc/a.txt", ok: true }, data: Uint8Array.of(1, 2, 3) }]).buffer,
    });
    const backend = createTauriBackend(bindings);
    expect(await backend.gitStatus("r1", false)).toEqual(status);
    expect(await backend.gitStatus("r1", true)).toEqual(status);
    expect([...(await backend.gitHeadFile("r1", "npc/a.txt"))]).toEqual([1, 2, 3]);
    expect(calls.map((call) => ({ command: call.command, args: call.args }))).toEqual([
      { command: "git_status", args: { rootId: "r1", grantTrust: false } },
      { command: "git_status", args: { rootId: "r1", grantTrust: true } },
      { command: "git_head_file", args: { rootId: "r1", path: "npc/a.txt" } },
    ]);
  });

  it("choisit une destination de deploiement par sa propre commande", async () => {
    const root = { id: "ab12", displayPath: "C:\\serveur" };
    const { bindings, calls } = fakeTauri({ pick_destination_folder: root });
    expect(await createTauriBackend(bindings).pickDestinationFolder()).toEqual(root);
    expect(calls.map((call) => call.command)).toEqual(["pick_destination_folder"]);
  });

  it("convertit les refus de Git en erreurs structurees et detecte une trame vide", async () => {
    const { bindings } = fakeTauri({ git_status: { __reject: { code: "not_trusted" } }, git_head_file: { __reject: { code: "not_in_head" } } });
    const backend = createTauriBackend(bindings);
    await expect(backend.gitStatus("r1", false)).rejects.toMatchObject({ name: "BackendError", code: "not_trusted" });
    await expect(backend.gitHeadFile("r1", "neuf.txt")).rejects.toMatchObject({ code: "not_in_head" });
    const empty = createTauriBackend(fakeTauri({ git_head_file: encodeFrames([]).buffer }).bindings);
    await expect(empty.gitHeadFile("r1", "a.txt")).rejects.toMatchObject({ code: "protocol" });
  });

  it("envoie les mises a jour sous `request`, en camelCase, et convertit leurs erreurs structurees", async () => {
    const available = { kind: "available", current: "0.1.0", version: "0.2.0", channel: "stable", notes: "n", publishedAt: "2026-11-15T10:00:00Z", size: 42 };
    const { bindings, calls } = fakeTauri({ update_check: available, update_install: undefined });
    const backend = createTauriBackend(bindings);
    expect(await backend.updateCheck({ repository: "acme/rel", channel: "beta", token: "ghp_x" })).toEqual(available);
    await backend.updateInstall({ token: null, locale: "fr" });
    expect(calls.map((call) => ({ command: call.command, args: call.args }))).toEqual([
      { command: "update_check", args: { request: { repository: "acme/rel", channel: "beta", token: "ghp_x" } } },
      { command: "update_install", args: { request: { token: null, locale: "fr" } } },
    ]);
    const failing = createTauriBackend(fakeTauri({ update_check: { __reject: { code: "manual_update_required", minimum: "0.3.0" } } }).bindings);
    await expect(failing.updateCheck({ repository: "a/b", channel: "stable", token: null })).rejects.toMatchObject({ code: "manual_update_required", payload: { minimum: "0.3.0" } });
  });

  it("n'ecoute l'avancement d'une mise a jour que sur demande et ignore les evenements mal formes", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const bindings: TauriBindings = {
      async invoke<T>(): Promise<T> {
        return undefined as T;
      },
      async listen(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    };
    const backend = createTauriBackend(bindings);
    expect(handlers.size).toBe(0);
    const seen: { received: number; total: number }[] = [];
    const stop = await backend.onUpdateProgress((progress) => seen.push(progress));
    const emit = handlers.get("runeforge://update-progress");
    expect(emit).toBeDefined();
    for (const payload of [{ received: 10, total: 100 }, { received: 500, total: 100 }, null, "x", {}, { received: "1", total: 2 }, { received: 1, total: 0 }, { received: -1, total: 5 }, { received: Number.NaN, total: 5 }]) {
      emit?.(payload);
    }
    expect(seen).toEqual([{ received: 10, total: 100 }, { received: 100, total: 100 }]);
    stop();
    expect(handlers.size).toBe(0);
  });

  it("transforme les rejets non structures en erreur inconnue", async () => {
    const { bindings } = fakeTauri({ app_info: new Error("boom") });
    await expect(createTauriBackend(bindings).appInfo()).rejects.toMatchObject({ code: "unknown", message: "boom" });
  });
});
