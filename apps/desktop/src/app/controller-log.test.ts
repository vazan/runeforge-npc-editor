import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { inProcessLanguage } from "../test/in-process-worker";
import { MemoryBuffer } from "../test/memory-buffer";
import type { LanguageClient } from "../workers/language-client";
import { AppController } from "./controller";

/**
 * Journal de diagnostic local, facultatif (CLAUDE.md §2.1 n° 16). Le coeur natif ne l'ecrit que si l'utilisateur l'a active et refuse
 * tout detail qui ressemblerait a un chemin ou a du code ; le controleur, lui, n'envoie que des compteurs et des indicateurs.
 */
interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  language: LanguageClient;
  edit(path: string, text: string): void;
}

function harness(): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const { client: language } = inProcessLanguage();
  const buffers = new Map<string, MemoryBuffer>();
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
    systemLanguage: () => "en-US",
    systemPrefersDark: () => false,
  });
  return {
    backend,
    store,
    controller,
    language,
    edit: (path, text) => {
      const buffer = buffers.get(path);
      if (buffer === undefined) throw new Error("tampon absent");
      buffer.text = text;
      controller.notifyEdited(path);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const NPC = 'prontera,150,150,4\tscript\tSecretNpcName\t100,{\n\tmes "texte confidentiel";\n\tclose;\n}\n';

async function open(h: Harness, files: Record<string, string> = { "npc/cities/prontera.txt": NPC, "npc/lib.txt": "function\tscript\tF_Secret\t{\n\treturn;\n}\n" }): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  await h.controller.whenIndexed();
}

/** Ce que le coeur natif accepte comme detail : voir `runeforge_filesystem::log`. */
const ALLOWED_DETAIL = /^[A-Za-z0-9 _.,=;()-]*$/;
const ALLOWED_CODE = /^[A-Z0-9_]{1,40}$/;

describe("AppController - journal de diagnostic local", () => {
  it("n'envoie rien tant que l'utilisateur n'a pas active le journal", async () => {
    const h = harness();
    const logEvent = vi.spyOn(h.backend, "logEvent");
    await open(h);
    await h.controller.openFile("npc/cities/prontera.txt");
    await h.controller.refreshTree();
    expect(logEvent).not.toHaveBeenCalled();
    expect(h.backend.logs).toEqual([]);
  });

  it("journalise l'activation, l'ouverture du projet et la fin de l'indexation : des compteurs, jamais de nom ni de texte", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.updateSettings({ logging: { enabled: true } });
    // La duree de l'indexation est celle de l'horloge : on la fait avancer pendant la lecture des fichiers.
    const indexFiles = h.language.indexFiles.bind(h.language);
    vi.spyOn(h.language, "indexFiles").mockImplementation(async (...args) => {
      vi.advanceTimersByTime(37);
      return indexFiles(...args);
    });
    await open(h);
    const codes = h.backend.logs.map((entry) => entry.code);
    expect(codes).toEqual(["LOG_ENABLED", "PROJECT_OPENED", "INDEX_DONE"]);
    expect(h.backend.logs[1]).toEqual({ level: "info", code: "PROJECT_OPENED", detail: "files=2 truncated=false" });
    expect(h.backend.logs[2]?.detail).toBe("files=2 functions=1 npcs=1 ms=37");
    for (const entry of h.backend.logs) {
      expect(entry.code).toMatch(ALLOWED_CODE);
      expect(entry.detail).toMatch(ALLOWED_DETAIL);
      const line = `${entry.code} ${entry.detail}`;
      for (const secret of ["prontera", "SecretNpcName", "F_Secret", "confidentiel", "npc/", "lib.txt"]) expect(line).not.toContain(secret);
    }
  });

  it("ne journalise pas une resynchronisation qui ne change rien, mais journalise celle qui a lu des fichiers", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.updateSettings({ logging: { enabled: true } });
    await open(h);
    const before = h.backend.logs.length;
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    expect(h.backend.logs).toHaveLength(before);
    h.backend.put("npc/new.txt", "function\tscript\tF_New\t{\n\treturn;\n}\n");
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    expect(h.backend.logs.slice(before).map((entry) => entry.code)).toEqual(["INDEX_DONE"]);
    expect(h.backend.logs[h.backend.logs.length - 1]?.detail).toMatch(/^files=3 functions=2 npcs=1 ms=\d+$/);
  });

  it("cesse de journaliser quand l'utilisateur desactive le journal", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.updateSettings({ logging: { enabled: true } });
    await open(h);
    await h.controller.updateSettings({ logging: { enabled: false } });
    const before = h.backend.logs.length;
    h.backend.put("npc/new.txt", "function\tscript\tF_New\t{\n\treturn;\n}\n");
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    expect(h.backend.logs).toHaveLength(before);
    // Reactiver ne rejoue pas le passe : seul le nouvel evenement d'activation figure.
    await h.controller.updateSettings({ logging: { enabled: true } });
    expect(h.backend.logs.slice(before).map((entry) => entry.code)).toEqual(["LOG_ENABLED"]);
  });

  it("n'ajoute pas d'evenement d'activation quand le reglage ne change pas", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.updateSettings({ logging: { enabled: true } });
    await h.controller.updateSettings({ theme: "dark" });
    await h.controller.updateSettings({ logging: { enabled: true } });
    expect(h.backend.logs.map((entry) => entry.code)).toEqual(["LOG_ENABLED"]);
  });

  it("journalise un conflit d'enregistrement et une recuperation proposee, sans le nom du fichier", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.updateSettings({ logging: { enabled: true } });
    h.backend.put("secret-name.txt", "v1\n");
    h.backend.recovery.set("secret-name.txt", {
      meta: { version: 1, relative: "secret-name.txt", savedAtMs: 5, baseSha256: null, encoding: "utf-8" },
      data: new TextEncoder().encode("travail perdu\n"),
    });
    await h.controller.loadProject(h.backend.root);
    await h.controller.whenIndexed();
    expect(h.backend.logs.map((entry) => entry.code)).toContain("RECOVERY_OFFERED");
    expect(h.backend.logs.find((entry) => entry.code === "RECOVERY_OFFERED")).toMatchObject({ level: "warn", detail: "count=1" });

    h.controller.closeDialog();
    await h.controller.openFile("secret-name.txt");
    h.edit("secret-name.txt", "mon edition\n");
    h.backend.put("secret-name.txt", "externe\n");
    await h.controller.saveActive();
    expect(h.backend.logs.find((entry) => entry.code === "SAVE_CONFLICT")).toEqual({ level: "warn", code: "SAVE_CONFLICT", detail: "deleted=false" });
    for (const entry of h.backend.logs) expect(`${entry.code} ${entry.detail}`).not.toContain("secret-name");
  });

  it("journalise l'echec de l'indexation et un enregistrement impossible par leur seul code", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.updateSettings({ logging: { enabled: true } });
    await open(h);
    vi.spyOn(h.language, "indexFiles").mockRejectedValue(new Error("lecture impossible de C:\\secret\\a.txt"));
    h.backend.put("npc/new.txt", "function\tscript\tF_New\t{\n\treturn;\n}\n");
    await h.controller.refreshTree();
    await h.controller.whenIndexed();
    expect(h.backend.logs[h.backend.logs.length - 1]).toEqual({ level: "error", code: "INDEX_ERROR", detail: "" });

    await h.controller.openFile("npc/lib.txt");
    h.edit("npc/lib.txt", "modifie\n");
    vi.spyOn(h.backend, "writeFile").mockRejectedValue({ code: "io", message: "disque plein dans C:\\secret" });
    await h.controller.saveActive();
    expect(h.backend.logs[h.backend.logs.length - 1]).toEqual({ level: "error", code: "SAVE_FAILED", detail: "code=io" });
    for (const entry of h.backend.logs) expect(`${entry.code} ${entry.detail}`).not.toMatch(/secret|plein|impossible/);
  });

  it("ne fait pas echouer l'application quand le coeur natif refuse ou echoue", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.updateSettings({ logging: { enabled: true } });
    // L'echec est absorbe par le controleur (`catch`) : sans cela, chaque evenement refuse serait une promesse rejetee sans gestionnaire.
    const failure = Promise.reject(new Error("disque plein"));
    const absorbed = vi.spyOn(failure, "catch");
    vi.spyOn(h.backend, "logEvent").mockReturnValue(failure);
    await expect(open(h)).resolves.toBeUndefined();
    expect(h.store.getState().project).not.toBeNull();
    expect(absorbed).toHaveBeenCalled();
  });
});
