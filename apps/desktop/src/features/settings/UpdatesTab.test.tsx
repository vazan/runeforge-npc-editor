// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdateCheckResult } from "../../services/types";
import { renderApp, type AppHarness } from "../../test/render-app";

/**
 * Onglet « Mises a jour » dans l'application complete (DEC-046) : rien n'est contacte sans l'utilisateur, le jeton n'est jamais
 * enregistre, l'installation exige des documents enregistres. Le depot GitHub est un faux (`FakeBackend`) ; le vrai reseau, la
 * signature et le remplacement de l'executable sont testes en Rust et en E2E.
 */
const AVAILABLE: UpdateCheckResult = {
  kind: "available",
  current: "0.0.0-test",
  version: "0.2.0",
  channel: "stable",
  notes: "Fixes\n<script>alert(1)</script>\nA new wizard.",
  publishedAt: "2026-11-15T10:00:00Z",
  size: 12_345_678,
};

afterEach(() => {
  cleanup();
});

type User = ReturnType<typeof userEvent.setup>;

async function openUpdates(options: { platform?: string; language?: string; reply?: UpdateCheckResult | { error: "network" | "bad_signature" } } = {}): Promise<{ h: AppHarness; user: User }> {
  const h = renderApp({
    ...(options.language === undefined ? {} : { language: options.language }),
    files: { "a.txt": "// a\n" },
    configure: (backend) => {
      if (options.platform !== undefined) backend.platform = options.platform;
      if (options.reply !== undefined) backend.updateCheckReply = options.reply;
    },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder|ouvrir un dossier/i }));
  await screen.findByRole("tree");
  await user.click(screen.getByRole("menuitem", { name: /^Help$|^Aide$/ }));
  await user.click(await screen.findByRole("menuitem", { name: /^Updates…$|^Mises à jour…$/ }));
  await screen.findByRole("dialog");
  return { h, user };
}

const checkButton = (): HTMLElement => screen.getByRole("button", { name: /check for updates|rechercher des mises à jour/i });

describe("onglet Mises a jour", () => {
  it("s'ouvre depuis le menu Aide sans rien contacter, et explique la regle du reseau", async () => {
    const { h } = await openUpdates();
    expect(screen.getByRole("tab", { name: "Updates", selected: true })).toBeTruthy();
    expect(screen.getByText(/Nothing is contacted until you press/)).toBeTruthy();
    expect(screen.getByText("Installed version: 0.0.0-test")).toBeTruthy();
    expect(h.backend.updateChecks).toEqual([]);
    expect(screen.getByRole("textbox", { name: /Repository/ })).toHaveProperty("value", "vazan/runeforge-npc-editor");
  });

  it("cherche une mise a jour au clic seulement et annonce une application a jour", async () => {
    const { h, user } = await openUpdates({ reply: { kind: "upToDate", current: "0.0.0-test" } });
    await user.click(checkButton());
    expect(await screen.findByText("You have the latest version (0.0.0-test).")).toBeTruthy();
    expect(h.backend.updateChecks).toEqual([{ repository: "vazan/runeforge-npc-editor", channel: "stable", token: null }]);
    expect(screen.queryByRole("button", { name: /install and restart/i })).toBeNull();
  });

  it("montre la version, la taille, la date et les notes comme du texte, jamais comme du HTML", async () => {
    const { user } = await openUpdates({ reply: AVAILABLE, platform: "windows" });
    await user.click(checkButton());
    expect(await screen.findByText("Version 0.2.0 is available: published 2026-11-15, 11.8 MiB.")).toBeTruthy();
    const notes = screen.getByRole("region", { name: "Release notes" });
    expect(notes.textContent).toBe("Fixes\n<script>alert(1)</script>\nA new wizard.");
    expect(notes.querySelector("script")).toBeNull();
    expect(notes.getAttribute("tabindex")).toBe("0");
  });

  it("enregistre le depot et le canal choisis, jamais le jeton, et envoie le jeton au coeur natif seulement", async () => {
    const { h, user } = await openUpdates({ reply: { kind: "upToDate", current: "0.0.0-test" } });
    const repository = screen.getByRole("textbox", { name: /Repository/ });
    await user.clear(repository);
    await user.type(repository, "acme/studio-releases");
    await user.selectOptions(screen.getByRole("combobox", { name: "Channel" }), "beta");
    const token = screen.getByLabelText(/Access token/);
    expect(token.getAttribute("type")).toBe("password");
    await user.type(token, "ghp_TopSecret_123");
    await user.click(checkButton());
    await screen.findByText(/You have the latest version/);

    expect(h.backend.updateChecks).toEqual([{ repository: "acme/studio-releases", channel: "beta", token: "ghp_TopSecret_123" }]);
    await waitFor(() => expect(JSON.parse(h.backend.configs.get("settings") ?? "{}")).toMatchObject({ updates: { repository: "acme/studio-releases", channel: "beta" } }));
    for (const stored of h.backend.configs.values()) expect(stored).not.toContain("ghp_TopSecret_123");
    expect(JSON.stringify(h.store.getState())).not.toContain("ghp_TopSecret_123");
  });

  it("refuse un depot mal ecrit avant tout envoi et garde le dernier depot valide", async () => {
    const { h, user } = await openUpdates();
    const repository = screen.getByRole("textbox", { name: /Repository/ });
    await user.clear(repository);
    await user.type(repository, "acme/studio-releases");
    await waitFor(() => expect(h.store.getState().settings.updates.repository).toBe("acme/studio-releases"));
    await user.clear(repository);
    await user.type(repository, "not a repo");
    expect(screen.getByText(/Write the repository as owner\/name/)).toBeTruthy();
    expect(repository.getAttribute("aria-invalid")).toBe("true");
    expect(checkButton()).toHaveProperty("disabled", true);
    // Le dernier depot valide reste enregistre (ni le texte invalide, ni le depot par defaut).
    expect(h.store.getState().settings.updates.repository).toBe("acme/studio-releases");
    expect(JSON.parse(h.backend.configs.get("settings") ?? "{}")).toMatchObject({ updates: { repository: "acme/studio-releases" } });
  });

  it("refuse un jeton mal forme, sans le retenir", async () => {
    const { h, user } = await openUpdates();
    await user.type(screen.getByLabelText(/Access token/), "ghp bad");
    expect(screen.getByText(/A token only contains letters, digits/)).toBeTruthy();
    expect(checkButton()).toHaveProperty("disabled", true);
    expect(h.controller.updates.hasToken()).toBe(false);
  });

  it("garde le jeton en memoire pour la session et permet de l'oublier", async () => {
    const { h, user } = await openUpdates();
    await user.type(screen.getByLabelText(/Access token/), "ghp_session");
    // Le champ est vide a la reouverture (le jeton n'est jamais reaffiche) mais le jeton est encore la, et l'onglet le dit.
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Help" }));
    await user.click(await screen.findByRole("menuitem", { name: "Updates…" }));
    expect(await screen.findByText(/A token is kept in memory for this session/)).toBeTruthy();
    expect(screen.getByLabelText(/Access token/)).toHaveProperty("value", "");
    expect(h.controller.updates.hasToken()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Forget the token" }));
    expect(h.controller.updates.hasToken()).toBe(false);
    expect(screen.queryByText(/A token is kept in memory/)).toBeNull();
  });

  it("explique une erreur dans la langue de l'interface, sans texte du serveur", async () => {
    const { user } = await openUpdates({ reply: { error: "bad_signature" } });
    await user.click(checkButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/signature is not valid for this application/);
    expect(alert.textContent).toMatch(/nothing was downloaded/);
  });

  it("s'affiche en francais", async () => {
    const { user } = await openUpdates({ language: "fr-FR", reply: { error: "network" } });
    expect(screen.getByText(/Rien n'est contacté tant que vous n'appuyez pas/)).toBeTruthy();
    await user.click(checkButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/serveur de mises à jour est injoignable/);
  });

  it.each(["windows", "linux"])("installe sous %s puis annonce le redemarrage, apres avoir envoye la langue et le jeton", async (platform) => {
    const { h, user } = await openUpdates({ reply: AVAILABLE, platform });
    await user.type(screen.getByLabelText(/Access token/), "ghp_x");
    await user.click(checkButton());
    expect(await screen.findByRole("button", { name: "Install and restart" })).toHaveProperty("disabled", false);
    await user.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("Update installed. Restarting…")).toBeTruthy();
    expect(h.backend.updateInstalls).toEqual([{ token: "ghp_x", locale: "en" }]);
    expect(checkButton()).toHaveProperty("disabled", true);
    expect(screen.queryByText(/only available on Windows and Linux/)).toBeNull();
  });

  it("montre la progression du telechargement avec un nom accessible", async () => {
    const { h, user } = await openUpdates({ reply: AVAILABLE, platform: "windows" });
    let release: () => void = () => undefined;
    h.backend.updateInstallGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.backend.updateProgressScript = [{ received: 5000, total: 10_000 }];
    await user.click(checkButton());
    await user.click(await screen.findByRole("button", { name: "Install and restart" }));
    const bar = await screen.findByRole("progressbar", { name: "Update download progress" });
    expect(bar.getAttribute("max")).toBe("10000");
    await waitFor(() => expect(bar.getAttribute("value")).toBe("5000"));
    expect(screen.getByText("Downloading… 50%")).toBeTruthy();
    release();
    await screen.findByText("Update installed. Restarting…");
  });

  it("garde la mise a jour disponible avec l'erreur quand l'installation echoue", async () => {
    const { h, user } = await openUpdates({ reply: AVAILABLE, platform: "windows" });
    h.backend.updateInstallReply = { error: "hash_mismatch" };
    await user.click(checkButton());
    await user.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not match the signed manifest/);
    expect(screen.getByRole("button", { name: "Install and restart" })).toHaveProperty("disabled", false);
  });

  it.each(["macos", "freebsd", "test"])("n'offre pas l'installation automatique sous %s (ni Windows, ni Linux)", async (platform) => {
    const { h, user } = await openUpdates({ reply: AVAILABLE, platform });
    await user.click(checkButton());
    await screen.findByText(/Version 0\.2\.0 is available/);
    expect(screen.getByText(/only available on Windows and Linux/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install and restart" })).toHaveProperty("disabled", true);
    expect(h.backend.updateInstalls).toEqual([]);
  });

  it("empeche d'installer tant qu'un document est modifie et dit pourquoi", async () => {
    const h = renderApp({
      files: { "a.txt": "// a\n" },
      configure: (backend) => {
        backend.platform = "windows";
        backend.updateCheckReply = AVAILABLE;
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
    await user.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    fireEvent.change(await screen.findByTestId("editor"), { target: { value: "// modifie\n" } });
    await waitFor(() => expect(screen.getByRole("img", { name: /modified/i })).toBeTruthy());

    await user.click(screen.getByRole("menuitem", { name: "Help" }));
    await user.click(await screen.findByRole("menuitem", { name: "Updates…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Check for updates" }));
    await within(dialog).findByText(/Version 0\.2\.0 is available/);
    expect(within(dialog).getByText(/Save your changes first/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Install and restart" })).toHaveProperty("disabled", true);
    expect(h.backend.updateInstalls).toEqual([]);
  });
});
