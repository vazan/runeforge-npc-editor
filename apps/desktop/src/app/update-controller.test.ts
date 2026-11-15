import { describe, expect, it, vi } from "vitest";
import { BackendError, type UpdateCheckResult } from "../services/types";
import { createAppStore, type AppStore } from "../state/store";
import { FakeBackend } from "../test/fake-backend";
import { UpdateController } from "./update-controller";

const AVAILABLE: Extract<UpdateCheckResult, { kind: "available" }> = {
  kind: "available",
  current: "0.1.0",
  version: "0.2.0",
  channel: "stable",
  notes: "Fixes and a new wizard.",
  publishedAt: "2026-11-15T10:00:00Z",
  size: 12_345_678,
};

interface Harness {
  readonly backend: FakeBackend;
  readonly store: AppStore;
  readonly updates: UpdateController;
  readonly logs: string[];
  setUnsaved(value: boolean): void;
}

function setup(options: { unsaved?: boolean } = {}): Harness {
  const backend = new FakeBackend();
  const store = createAppStore();
  const logs: string[] = [];
  let unsaved = options.unsaved ?? false;
  const updates = new UpdateController({
    backend,
    store,
    hasUnsavedChanges: () => unsaved,
    log: (level, code, detail = "") => logs.push(`${level} ${code} ${detail}`.trim()),
  });
  return {
    backend,
    store,
    updates,
    logs,
    setUnsaved: (value) => {
      unsaved = value;
    },
  };
}

const state = (h: Harness) => h.store.getState().update;

async function available(h: Harness): Promise<void> {
  h.backend.updateCheckReply = AVAILABLE;
  await h.updates.check();
  expect(state(h).status).toBe("available");
}

describe("mises a jour : controle", () => {
  it("ne contacte rien tant que l'utilisateur ne l'a pas demande", () => {
    const h = setup();
    expect(state(h)).toEqual({ status: "idle" });
    expect(h.backend.updateChecks).toEqual([]);
    expect(h.backend.updateInstalls).toEqual([]);
  });

  it("envoie le depot et le canal des reglages, et le jeton gardé en memoire", async () => {
    const h = setup();
    h.store.setState((current) => ({ settings: { ...current.settings, updates: { repository: "acme/studio-releases", channel: "beta" } } }));
    expect(h.updates.setToken("  ghp_Abc-123_x  ")).toBe(true);
    await h.updates.check();
    expect(h.backend.updateChecks).toEqual([{ repository: "acme/studio-releases", channel: "beta", token: "ghp_Abc-123_x" }]);
  });

  it("sans jeton, envoie `null` (depot public)", async () => {
    const h = setup();
    await h.updates.check();
    expect(h.backend.updateChecks[0]?.token).toBeNull();
  });

  it("rend compte d'une application a jour", async () => {
    const h = setup();
    h.backend.updateCheckReply = { kind: "upToDate", current: "0.1.0" };
    await h.updates.check();
    expect(state(h)).toEqual({ status: "up-to-date", current: "0.1.0" });
    expect(h.logs).toEqual(["info UPDATE_CHECK result=up_to_date"]);
  });

  it("garde la mise a jour decrite par le manifeste signe, sans echec", async () => {
    const h = setup();
    await available(h);
    expect(state(h)).toEqual({ status: "available", update: AVAILABLE, failure: null });
    expect(h.logs).toEqual(["info UPDATE_CHECK result=available"]);
  });

  it("passe par `checking` pendant la requete et ignore un second controle en cours", async () => {
    const h = setup();
    let release: (value: UpdateCheckResult) => void = () => undefined;
    const spy = vi.spyOn(h.backend, "updateCheck").mockImplementation(
      () =>
        new Promise<UpdateCheckResult>((resolve) => {
          release = resolve;
        }),
    );
    const first = h.updates.check();
    expect(state(h).status).toBe("checking");
    await h.updates.check();
    expect(spy).toHaveBeenCalledTimes(1);
    release({ kind: "upToDate", current: "0.1.0" });
    await first;
    expect(state(h).status).toBe("up-to-date");
  });

  it("transforme chaque erreur du coeur natif en echec affichable, avec la version minimale quand elle existe", async () => {
    const h = setup();
    h.backend.updateCheckReply = { error: "manual_update_required", minimum: "0.3.0" };
    await h.updates.check();
    expect(state(h)).toEqual({ status: "error", failure: { code: "manual_update_required", minimum: "0.3.0", reason: undefined } });
    h.backend.updateCheckReply = { error: "bad_signature" };
    await h.updates.check();
    expect(state(h)).toMatchObject({ status: "error", failure: { code: "bad_signature" } });
    expect(h.logs).toEqual(["error UPDATE_FAILED code=manual_update_required", "error UPDATE_FAILED code=bad_signature"]);
  });

  it("traite un code inconnu ou une erreur quelconque comme un echec generique, sans texte du serveur", async () => {
    const h = setup();
    const spy = vi.spyOn(h.backend, "updateCheck");
    spy.mockRejectedValueOnce(new BackendError({ code: "something_new", message: "C:\\secret\\path ghp_leak" }));
    await h.updates.check();
    expect(state(h)).toMatchObject({ status: "error", failure: { code: "failed" } });
    spy.mockRejectedValueOnce(new Error("boom"));
    await h.updates.check();
    expect(state(h)).toMatchObject({ status: "error", failure: { code: "failed" } });
    expect(h.logs).toEqual(["error UPDATE_FAILED code=unknown", "error UPDATE_FAILED code=unknown"]);
  });

  it("un nouveau controle remplace le precedent : une mise a jour disparue ne peut plus etre installee", async () => {
    const h = setup();
    await available(h);
    h.backend.updateCheckReply = { error: "network" };
    await h.updates.check();
    expect(state(h).status).toBe("error");
    await h.updates.install();
    expect(h.backend.updateInstalls).toEqual([]);
  });
});

describe("mises a jour : jeton d'acces", () => {
  it("accepte les lettres, chiffres, _ et -, oublie un jeton vide et refuse un jeton mal forme", () => {
    const h = setup();
    expect(h.updates.setToken("github_pat_11AAAA_bbb-ccc")).toBe(true);
    expect(h.updates.hasToken()).toBe(true);
    expect(h.updates.setToken("   ")).toBe(true);
    expect(h.updates.hasToken()).toBe(false);
    expect(h.updates.setToken("ghp_ok")).toBe(true);
    // Un jeton invalide n'est pas retenu, et il efface le precedent : on ne laisse pas partir un autre jeton que celui du champ.
    for (const bad of ["ghp abc", "ghp_abc\r\nX-Evil: 1", "ghp_é", "tok;en", "a".repeat(256)]) {
      expect(h.updates.setToken(bad), bad).toBe(false);
      expect(h.updates.hasToken(), bad).toBe(false);
      h.updates.setToken("ghp_ok");
    }
  });

  it("ne laisse jamais le jeton dans l'etat, les reglages ni le journal", async () => {
    const h = setup();
    h.updates.setToken("ghp_TopSecret_123");
    await available(h);
    await h.updates.install();
    const everything = JSON.stringify({ update: h.store.getState().update, settings: h.store.getState().settings, logs: h.logs });
    expect(everything).not.toContain("ghp_TopSecret_123");
    // Le coeur natif, lui, le recoit : c'est lui qui le joint aux requetes a GitHub.
    expect(h.backend.updateChecks[0]?.token).toBe("ghp_TopSecret_123");
    expect(h.backend.updateInstalls[0]?.token).toBe("ghp_TopSecret_123");
  });
});

describe("mises a jour : installation", () => {
  it("ne fait rien tant qu'aucune mise a jour n'a ete trouvee", async () => {
    const h = setup();
    await h.updates.install();
    expect(state(h)).toEqual({ status: "idle" });
    expect(h.backend.updateInstalls).toEqual([]);
  });

  it("suit l'avancement sans jamais le faire reculer, puis annonce le redemarrage et se desabonne", async () => {
    const h = setup();
    h.updates.setToken("ghp_x");
    await available(h);
    let release: () => void = () => undefined;
    h.backend.updateInstallGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Un evenement tardif (50) arrive apres un plus avance (400) : la barre ne recule pas.
    h.backend.updateProgressScript = [
      { received: 100, total: 1000 },
      { received: 400, total: 1000 },
      { received: 50, total: 1000 },
    ];
    const installing = h.updates.install();
    await vi.waitFor(() => expect(state(h)).toMatchObject({ status: "installing", received: 400, total: 1000 }));
    expect(h.backend.updateProgressSubscribers).toBe(1);
    release();
    await installing;
    expect(state(h)).toEqual({ status: "restarting", update: AVAILABLE });
    expect(h.backend.updateProgressSubscribers).toBe(0);
    expect(h.backend.updateInstalls).toEqual([{ token: "ghp_x", locale: "en" }]);
    expect(h.logs).toEqual(["info UPDATE_CHECK result=available", "info UPDATE_INSTALL"]);
  });

  it("commence l'installation a zero sur la taille annoncee par le manifeste", async () => {
    const h = setup();
    await available(h);
    let release: () => void = () => undefined;
    h.backend.updateInstallGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const installing = h.updates.install();
    await vi.waitFor(() => expect(state(h)).toEqual({ status: "installing", update: AVAILABLE, received: 0, total: AVAILABLE.size }));
    release();
    await installing;
  });

  it("transmet la langue de l'interface pour la boite de dialogue du systeme", async () => {
    const h = setup();
    h.store.setState({ language: "fr" });
    await available(h);
    await h.updates.install();
    expect(h.backend.updateInstalls[0]?.locale).toBe("fr");
  });

  it("refuse tant que des modifications ne sont pas enregistrees, sans rien telecharger", async () => {
    const h = setup({ unsaved: true });
    await available(h);
    await h.updates.install();
    expect(state(h)).toEqual({ status: "available", update: AVAILABLE, failure: { code: "unsaved_changes" } });
    expect(h.backend.updateInstalls).toEqual([]);
    h.setUnsaved(false);
    await h.updates.install();
    expect(state(h).status).toBe("restarting");
  });

  it("le coeur natif refuse aussi, si la page se trompe sur l'etat des documents", async () => {
    const h = setup();
    await available(h);
    h.backend.dirtyFlag = true;
    await h.updates.install();
    expect(state(h)).toMatchObject({ status: "available", failure: { code: "unsaved_changes" } });
    expect(h.backend.updateInstalls).toHaveLength(1);
  });

  it("un refus dans la boite de dialogue du systeme ramene a la mise a jour disponible, sans erreur", async () => {
    const h = setup();
    await available(h);
    h.backend.updateInstallReply = "cancelled";
    await h.updates.install();
    expect(state(h)).toEqual({ status: "available", update: AVAILABLE, failure: null });
    expect(h.logs).not.toContain("error UPDATE_FAILED code=install_failed");
    expect(h.backend.updateProgressSubscribers).toBe(0);
  });

  it("garde la mise a jour disponible apres un echec, pour une nouvelle tentative", async () => {
    const h = setup();
    await available(h);
    h.backend.updateInstallReply = { error: "hash_mismatch" };
    await h.updates.install();
    expect(state(h)).toMatchObject({ status: "available", update: AVAILABLE, failure: { code: "hash_mismatch" } });
    expect(h.logs.at(-1)).toBe("error UPDATE_FAILED code=hash_mismatch");
    // Le coeur natif n'installe que la mise a jour du dernier controle : apres un echec elle est redemandee.
    await h.updates.check();
    h.backend.updateInstallReply = "installed";
    await h.updates.install();
    expect(state(h).status).toBe("restarting");
  });

  it("conserve l'etape qui a echoue quand l'ancienne version n'a pas pu etre remise", async () => {
    const h = setup();
    await available(h);
    h.backend.updateInstallReply = { error: "install_failed", reason: "replace_kept_backup" };
    await h.updates.install();
    expect(state(h)).toMatchObject({ status: "available", failure: { code: "install_failed", reason: "replace_kept_backup" } });
  });

  it("installe meme si l'abonnement a l'avancement echoue", async () => {
    const h = setup();
    await available(h);
    vi.spyOn(h.backend, "onUpdateProgress").mockRejectedValue(new Error("no events"));
    await h.updates.install();
    expect(state(h).status).toBe("restarting");
  });

  it("ne lance pas deux installations", async () => {
    const h = setup();
    await available(h);
    let release: () => void = () => undefined;
    h.backend.updateInstallGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = h.updates.install();
    await vi.waitFor(() => expect(state(h).status).toBe("installing"));
    await h.updates.install();
    await h.updates.check();
    expect(h.backend.updateInstalls).toHaveLength(1);
    expect(h.backend.updateChecks).toHaveLength(1);
    release();
    await first;
  });
});
