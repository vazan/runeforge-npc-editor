import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "../services/types";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { inProcessLanguage } from "../test/in-process-worker";
import { MemoryBuffer } from "../test/memory-buffer";
import { AppController } from "./controller";

const NPC = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';

const STATUS: GitStatus = {
  branch: "main",
  detached: false,
  unborn: false,
  head: "0123456789ab",
  entries: [
    { path: "a.txt", x: ".", y: "M" },
    { path: "neuf.txt", x: "?", y: "?" },
  ],
  truncated: false,
};

interface Harness {
  backend: FakeBackend;
  store: AppStore;
  controller: AppController;
  buffers: Map<string, MemoryBuffer>;
}

function harness(): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const buffers = new Map<string, MemoryBuffer>();
  const { client } = inProcessLanguage();
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
    diagnostics: client,
    language: client,
    systemLanguage: () => "en-US",
    systemPrefersDark: () => false,
  });
  return { backend, store, controller, buffers };
}

async function loaded(h: Harness, files: Record<string, string | Uint8Array> = { "a.txt": NPC }): Promise<void> {
  for (const [path, content] of Object.entries(files)) h.backend.put(path, content);
  h.backend.gitRepository = { status: STATUS, heads: new Map([["a.txt", NPC]]) };
  await h.controller.init();
  await h.controller.loadProject(h.backend.root);
  await h.controller.whenIndexed();
}

/** Autorise Git pour le projet comme le ferait l'utilisateur dans la boite de dialogue. */
async function enabled(h: Harness): Promise<void> {
  h.controller.showGit();
  await vi.waitFor(() => expect(h.store.getState().dialog?.kind).toBe("git-trust"));
  await h.controller.confirmGitTrust();
  expect(h.store.getState().git.status).toBe("ready");
  h.backend.gitCalls.length = 0;
}

const gitState = (h: Harness) => h.store.getState().git;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AppController - Git : rien sans action de l'utilisateur", () => {
  it("ne lance rien a l'ouverture du projet, ni en changeant d'onglet du panneau du bas", async () => {
    const h = await (async () => {
      const harnessed = harness();
      await loaded(harnessed);
      return harnessed;
    })();
    h.controller.setBottomTab("report");
    h.controller.setBottomTab("references");
    h.controller.setBottomTab("problems");
    await h.controller.refreshTree();
    expect(h.backend.gitCalls).toEqual([]);
    expect(gitState(h)).toEqual({ status: "off" });
  });

  it("demande l'accord de l'utilisateur la premiere fois, et ne lit que l'etat (aucune lecture de fichier de HEAD)", async () => {
    const h = harness();
    await loaded(h);
    h.controller.showGit();
    await vi.waitFor(() => expect(gitState(h)).toEqual({ status: "unavailable", reason: "not_trusted" }));
    expect(h.store.getState()).toMatchObject({ bottomTab: "git", bottomVisible: true, dialog: { kind: "git-trust" } });
    expect(h.backend.gitCalls).toEqual([{ kind: "status", grantTrust: false }]);
    expect(h.backend.gitTrusted.size).toBe(0);
  });

  it("autorise Git pour ce projet quand l'utilisateur accepte, puis montre l'etat", async () => {
    const h = harness();
    await loaded(h);
    h.controller.showGit();
    await vi.waitFor(() => expect(h.store.getState().dialog?.kind).toBe("git-trust"));
    await h.controller.confirmGitTrust();
    expect(h.store.getState().dialog).toBeNull();
    expect(gitState(h)).toMatchObject({ status: "ready", data: STATUS });
    expect(h.backend.gitCalls).toEqual([
      { kind: "status", grantTrust: false },
      { kind: "status", grantTrust: true },
    ]);
    expect([...h.backend.gitTrusted]).toEqual([h.backend.root.id]);
  });

  it("n'autorise rien quand l'utilisateur refuse, et propose de recommencer sans rouvrir seul la boite", async () => {
    const h = harness();
    await loaded(h);
    h.controller.showGit();
    await vi.waitFor(() => expect(h.store.getState().dialog?.kind).toBe("git-trust"));
    h.controller.closeDialog();
    expect(gitState(h)).toEqual({ status: "unavailable", reason: "not_trusted" });
    expect(h.backend.gitTrusted.size).toBe(0);
    // Changer d'onglet puis revenir ne redemande pas : c'est le bouton « Activer Git » qui rouvre la boite.
    h.controller.setBottomTab("problems");
    h.controller.setBottomTab("git");
    expect(h.store.getState().dialog).toBeNull();
    h.controller.requestGitTrust();
    h.controller.requestGitTrust();
    expect(h.store.getState().dialog).toEqual({ kind: "git-trust" });
    expect(h.store.getState().dialogQueue).toEqual([]);
  });

  it("n'a plus besoin de redemander pour un projet deja autorise", async () => {
    const h = harness();
    await loaded(h);
    h.backend.gitTrusted.add(h.backend.root.id);
    h.controller.showGit();
    await vi.waitFor(() => expect(gitState(h).status).toBe("ready"));
    expect(h.store.getState().dialog).toBeNull();
    expect(h.backend.gitCalls).toEqual([{ kind: "status", grantTrust: false }]);
  });
});

describe("AppController - Git : lecture de l'etat", () => {
  it.each([
    ["not_a_repository", "not_a_repository"],
    ["git_unavailable", "git_unavailable"],
    ["unsafe_repository", "unsafe_repository"],
    ["timeout", "timeout"],
    ["too_large", "too_large"],
    ["failed", "failed"],
    ["quelque_chose_d_inconnu", "failed"],
  ] as const)("une erreur « %s » devient la raison « %s », sans boite de dialogue", async (code, reason) => {
    const h = harness();
    await loaded(h);
    h.backend.gitTrusted.add(h.backend.root.id);
    h.backend.gitFailure = code;
    h.controller.showGit();
    await vi.waitFor(() => expect(gitState(h)).toEqual({ status: "unavailable", reason }));
    expect(h.store.getState().dialog).toBeNull();
  });

  it("garde la derniere lecture pendant la suivante, puis la remplace", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    let release: (status: GitStatus) => void = () => undefined;
    vi.spyOn(h.backend, "gitStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const refreshing = h.controller.refreshGit();
    expect(gitState(h)).toEqual({ status: "loading", data: STATUS });
    const newer: GitStatus = { ...STATUS, entries: [] };
    release(newer);
    await refreshing;
    expect(gitState(h)).toMatchObject({ status: "ready", data: newer });
  });

  it("ecarte la reponse d'une lecture depassee par une plus recente", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    const releases: ((status: GitStatus) => void)[] = [];
    vi.spyOn(h.backend, "gitStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const first = h.controller.refreshGit();
    const second = h.controller.refreshGit();
    const recent: GitStatus = { ...STATUS, branch: "recente" };
    releases[1]?.(recent);
    await second;
    releases[0]?.({ ...STATUS, branch: "perimee" });
    await first;
    expect(gitState(h)).toMatchObject({ status: "ready", data: { branch: "recente" } });
  });

  it("ecarte aussi l'echec d'une lecture depassee par une plus recente", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    const settle: { resolve: (status: GitStatus) => void; reject: (error: Error) => void }[] = [];
    vi.spyOn(h.backend, "gitStatus").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle.push({ resolve, reject });
        }),
    );
    const first = h.controller.refreshGit();
    const second = h.controller.refreshGit();
    settle[1]?.resolve(STATUS);
    await second;
    settle[0]?.reject(Object.assign(new Error("trop tard"), { code: "timeout" }));
    await first;
    expect(gitState(h)).toMatchObject({ status: "ready", data: STATUS });
  });

  it("n'ouvre la boite d'accord que si l'utilisateur l'a demandee (une relecture seule ne la rouvre pas)", async () => {
    const h = harness();
    await loaded(h);
    await h.controller.refreshGit();
    expect(gitState(h)).toEqual({ status: "unavailable", reason: "not_trusted" });
    expect(h.store.getState().dialog).toBeNull();
    await h.controller.refreshGit({ ask: true });
    expect(h.store.getState().dialog).toEqual({ kind: "git-trust" });
  });

  it("n'applique pas la reponse d'un projet quitte entre-temps, et remet Git a zero", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    let release: (status: GitStatus) => void = () => undefined;
    vi.spyOn(h.backend, "gitStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const refreshing = h.controller.refreshGit();
    await h.controller.closeProject();
    expect(gitState(h)).toEqual({ status: "off" });
    release(STATUS);
    await refreshing;
    expect(gitState(h)).toEqual({ status: "off" });
  });

  it("ne fait rien sans projet ouvert", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.refreshGit({ ask: true });
    expect(h.backend.gitCalls).toEqual([]);
    expect(gitState(h)).toEqual({ status: "off" });
  });
});

describe("AppController - Git : relecture apres un changement des fichiers", () => {
  async function ready(): Promise<Harness> {
    const h = harness();
    await loaded(h);
    await enabled(h);
    await h.controller.openFile("a.txt");
    return h;
  }

  async function saveOneChange(h: Harness): Promise<void> {
    const buffer = h.buffers.get("a.txt");
    if (buffer === undefined) throw new Error("tampon absent");
    buffer.text += "// ajoute\n";
    h.controller.notifyEdited("a.txt");
    await h.controller.saveActive();
  }

  it("relit l'etat apres un enregistrement quand l'onglet Git est affiche, une seule fois pour une rafale", async () => {
    const h = await ready();
    h.controller.setBottomTab("git");
    await vi.waitFor(() => expect(gitState(h).status).toBe("ready"));
    h.backend.gitCalls.length = 0;
    await saveOneChange(h);
    await h.controller.refreshTree();
    expect(h.backend.gitCalls).toEqual([]);
    // La relecture attend une courte pause (une rafale d'enregistrements n'en declenche qu'une).
    await vi.advanceTimersByTimeAsync(200);
    expect(h.backend.gitCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.backend.gitCalls).toEqual([{ kind: "status", grantTrust: false }]);
  });

  it("ne harcele pas un Git indisponible : un enregistrement ne le relance pas", async () => {
    const h = await ready();
    h.backend.gitFailure = "timeout";
    await h.controller.refreshGit();
    expect(gitState(h)).toEqual({ status: "unavailable", reason: "timeout" });
    h.backend.gitFailure = null;
    h.backend.gitCalls.length = 0;
    h.controller.setBottomTab("git");
    await saveOneChange(h);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.backend.gitCalls).toEqual([]);
  });

  it("ne relit rien en arriere-plan quand l'onglet Git n'est pas affiche, mais relit en y revenant", async () => {
    const h = await ready();
    h.controller.setBottomTab("problems");
    await saveOneChange(h);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.backend.gitCalls).toEqual([]);
    h.controller.setBottomTab("git");
    await vi.waitFor(() => expect(h.backend.gitCalls).toEqual([{ kind: "status", grantTrust: false }]));
    // Rien n'a change depuis : revenir une fois de plus ne relit pas.
    await vi.waitFor(() => expect(gitState(h).status).toBe("ready"));
    h.controller.setBottomTab("problems");
    h.controller.setBottomTab("git");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.backend.gitCalls).toHaveLength(1);
  });

  it("ne relit pas quand Git n'a pas ete lu ou n'est pas disponible", async () => {
    const h = harness();
    await loaded(h);
    await h.controller.openFile("a.txt");
    h.controller.setBottomTab("problems");
    await saveOneChange(h);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.backend.gitCalls).toEqual([]);
  });
});

describe("AppController - Git : version de HEAD", () => {
  it("rend le texte de HEAD normalise en LF", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    h.backend.gitRepository?.heads.set("a.txt", "mes \"a\";\r\nclose;\r\n");
    expect(await h.controller.loadGitHeadText("a.txt")).toEqual({ kind: "text", text: 'mes "a";\nclose;\n' });
  });

  it("decode l'encodage herite du projet", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    h.backend.gitRepository?.heads.set("a.txt", Uint8Array.from([0x6d, 0x65, 0x73, 0x20, 0x22, 0x63, 0x61, 0x66, 0xe9, 0x22, 0x3b, 0x0a]));
    expect(await h.controller.loadGitHeadText("a.txt")).toEqual({ kind: "text", text: 'mes "café";\n' });
  });

  it("dit qu'un fichier neuf n'est pas dans HEAD, et pourquoi une lecture a echoue", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    expect(await h.controller.loadGitHeadText("neuf.txt")).toEqual({ kind: "new" });
    h.backend.gitRepository?.heads.set("binaire.txt", Uint8Array.from([0x4d, 0x5a, 0x00, 0x01]));
    expect(await h.controller.loadGitHeadText("binaire.txt")).toEqual({ kind: "error", reason: "failed" });
    h.backend.gitFailure = "timeout";
    expect(await h.controller.loadGitHeadText("a.txt")).toEqual({ kind: "error", reason: "timeout" });
    h.backend.gitFailure = "code_inconnu";
    expect(await h.controller.loadGitHeadText("a.txt")).toEqual({ kind: "error", reason: "failed" });
    h.backend.gitFailure = null;
    h.backend.gitTrusted.clear();
    expect(await h.controller.loadGitHeadText("a.txt")).toEqual({ kind: "error", reason: "not_trusted" });
  });

  it("n'accede a rien sans projet", async () => {
    const h = harness();
    await h.controller.init();
    expect(await h.controller.loadGitHeadText("a.txt")).toEqual({ kind: "error", reason: "failed" });
    expect(h.backend.gitCalls).toEqual([]);
  });
});

describe("AppController - Git : comparaison avec HEAD", () => {
  it("ouvre la comparaison du fichier actif une fois Git autorise", async () => {
    const h = harness();
    await loaded(h);
    await enabled(h);
    await h.controller.openFile("a.txt");
    await h.controller.compareWithGit();
    expect(h.store.getState().dialog).toEqual({ kind: "diff", path: "a.txt", source: "git" });
  });

  it("compare le fichier demande, pas forcement l'actif", async () => {
    const h = harness();
    await loaded(h, { "a.txt": NPC, "b.txt": "// b\n" });
    await enabled(h);
    await h.controller.openFile("a.txt");
    await h.controller.compareWithGit("b.txt");
    expect(h.store.getState().dialog).toEqual({ kind: "diff", path: "b.txt", source: "git" });
  });

  it("demande d'abord l'accord de l'utilisateur, et n'ouvre pas la comparaison tant que Git n'est pas autorise", async () => {
    const h = harness();
    await loaded(h);
    await h.controller.openFile("a.txt");
    await h.controller.compareWithGit();
    expect(h.store.getState().dialog).toEqual({ kind: "git-trust" });
    expect(h.backend.gitCalls).toEqual([{ kind: "status", grantTrust: false }]);
  });

  it("ne fait rien sans fichier", async () => {
    const h = harness();
    await loaded(h);
    await h.controller.compareWithGit();
    expect(h.store.getState().dialog).toBeNull();
    expect(h.backend.gitCalls).toEqual([]);
  });

  it("n'ouvre pas la comparaison quand Git est indisponible", async () => {
    const h = harness();
    await loaded(h);
    h.backend.gitTrusted.add(h.backend.root.id);
    h.backend.gitRepository = null;
    await h.controller.openFile("a.txt");
    await h.controller.compareWithGit();
    expect(h.store.getState().dialog).toBeNull();
    expect(gitState(h)).toEqual({ status: "unavailable", reason: "not_a_repository" });
  });
});
