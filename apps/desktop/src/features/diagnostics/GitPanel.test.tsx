// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { GitStatus } from "../../services/types";
import { renderApp, type AppHarness } from "../../test/render-app";

/**
 * Onglet Git (RF-019) dans l'application complete : l'accord de l'utilisateur, l'etat du depot, l'ouverture d'un fichier, la
 * comparaison avec HEAD, la barre d'etat. Le depot est un faux (`FakeBackend.gitRepository`) ; le vrai `git` est teste en Rust et en E2E.
 */
const A_TXT = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';
const A_HEAD = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Salut";\n\tclose;\n}\n';

const STATUS: GitStatus = {
  branch: "main",
  detached: false,
  unborn: false,
  head: "0123456789ab",
  entries: [
    { path: "a.txt", x: ".", y: "M" },
    { path: "npc/ajoute.txt", x: "A", y: "." },
    { path: "neuf.txt", x: "?", y: "?" },
    { path: "supprime.txt", x: ".", y: "D" },
  ],
  truncated: false,
};

afterEach(() => {
  cleanup();
});

type User = ReturnType<typeof userEvent.setup>;

async function openProject(options: { status?: GitStatus; trusted?: boolean; language?: string; failure?: string; notARepository?: boolean } = {}): Promise<{ h: AppHarness; user: User }> {
  const h = renderApp({
    withLanguage: true,
    ...(options.language === undefined ? {} : { language: options.language }),
    files: { "a.txt": A_TXT, "neuf.txt": "// neuf\n", "npc/ajoute.txt": "// ajoute\n" },
    configure: (backend) => {
      backend.gitRepository = options.notARepository === true ? null : { status: options.status ?? STATUS, heads: new Map([["a.txt", A_HEAD]]) };
      if (options.trusted === true) backend.gitTrusted.add(backend.root.id);
      if (options.failure !== undefined) backend.gitFailure = options.failure;
    },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder|ouvrir un dossier/i }));
  await screen.findByRole("tree");
  return { h, user };
}

async function showGit(user: User, names = { menu: "View", item: /Show Git changes/ }): Promise<void> {
  await user.click(screen.getByRole("menuitem", { name: names.menu }));
  await user.click(await screen.findByRole("menuitem", { name: names.item }));
}

const panel = (): HTMLElement => screen.getByRole("region", { name: "Git" });

describe("onglet Git : accord de l'utilisateur", () => {
  it("demande l'accord avant toute lecture, explique les risques, et ne lit rien tant que l'utilisateur n'a pas accepte", async () => {
    const { h, user } = await openProject();
    expect(h.backend.gitCalls).toEqual([]);
    await showGit(user);

    const dialog = await screen.findByRole("dialog", { name: "Enable Git for this project?" });
    expect(within(dialog).getByText(/run the git program of this machine, read-only/)).toBeTruthy();
    expect(within(dialog).getByText(/Git can run programs that a repository's own configuration declares/)).toBeTruthy();
    // Le refus est le choix par defaut (le focus y est).
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(h.backend.gitCalls).toEqual([{ kind: "status", grantTrust: false }]);
    expect(h.backend.gitTrusted.size).toBe(0);

    await user.click(within(dialog).getByRole("button", { name: "Enable Git" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.backend.gitCalls).toEqual([
      { kind: "status", grantTrust: false },
      { kind: "status", grantTrust: true },
    ]);
    expect(await within(panel()).findByText("Branch main · Changed files: 4")).toBeTruthy();
  });

  it("n'active rien quand l'utilisateur refuse (Annuler ou Echap) et propose de recommencer", async () => {
    const { h, user } = await openProject();
    await showGit(user);
    await screen.findByRole("dialog", { name: "Enable Git for this project?" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await within(panel()).findByText("Git is not enabled for this project.")).toBeTruthy();
    expect(h.backend.gitTrusted.size).toBe(0);

    await user.click(within(panel()).getByRole("button", { name: "Enable Git for this project…" }));
    const dialog = await screen.findByRole("dialog", { name: "Enable Git for this project?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.backend.gitTrusted.size).toBe(0);
    expect(h.backend.gitCalls.every((call) => call.grantTrust === false)).toBe(true);
  });

  it("ne redemande pas pour un projet deja autorise", async () => {
    const { user } = await openProject({ trusted: true });
    await showGit(user);
    expect(await within(panel()).findByText("Branch main · Changed files: 4")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("onglet Git : etat du depot", () => {
  it("liste les fichiers modifies avec leur nature, ce qui est dans l'index, et la branche", async () => {
    const { user } = await openProject({ trusted: true });
    await showGit(user);
    const list = await within(panel()).findByRole("list", { name: "Files changed since HEAD" });
    const rows = within(list).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual([
      "Ma.txt ModifiedCompare",
      "Anpc/ajoute.txt Added · stagedCompare",
      "?neuf.txt UntrackedCompare",
      "Dsupprime.txt DeletedCompare",
    ]);
    expect(within(panel()).getByText("Read only: nothing is committed, pushed or changed in the repository.")).toBeTruthy();
    // La lettre de la pastille est decorative : le nom accessible du bouton dit la nature.
    expect(within(list).getByRole("button", { name: /^a\.txt Modified$/ })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Compare a.txt with HEAD" })).toBeTruthy();
  });

  it("desactive l'ouverture et la comparaison d'un fichier supprime", async () => {
    const { user } = await openProject({ trusted: true });
    await showGit(user);
    const list = await within(panel()).findByRole("list", { name: "Files changed since HEAD" });
    expect((within(list).getByRole("button", { name: /^supprime\.txt/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(list).getByRole("button", { name: "Compare supprime.txt with HEAD" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(list).getByRole("button", { name: /^a\.txt/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("dit qu'il n'y a aucune modification", async () => {
    const { user } = await openProject({ trusted: true, status: { ...STATUS, entries: [] } });
    await showGit(user);
    expect(await within(panel()).findByText("No change: the working folder matches HEAD.")).toBeTruthy();
    expect(within(panel()).queryByRole("list")).toBeNull();
    expect(within(panel()).getByText("Branch main · Changed files: 0")).toBeTruthy();
  });

  it("dit une branche sans commit, un HEAD detache et une liste coupee", async () => {
    const unborn = await openProject({ trusted: true, status: { ...STATUS, unborn: true, head: null, entries: [] } });
    await showGit(unborn.user);
    expect(await within(panel()).findByText("Branch main (no commit yet) · Changed files: 0")).toBeTruthy();
    cleanup();

    const detached = await openProject({ trusted: true, status: { ...STATUS, branch: null, detached: true, truncated: true } });
    await showGit(detached.user);
    expect(await within(panel()).findByText("Detached HEAD at 0123456789ab · Changed files: 4")).toBeTruthy();
    expect(within(panel()).getByText("The list is cut: only the first 4 files are shown.")).toBeTruthy();
  });

  it.each([
    ["not_a_repository", "This folder is not inside a Git repository."],
    ["git_unavailable", "The git program was not found on this machine."],
    ["unsafe_repository", "Git refuses this repository because it belongs to another user (safe.directory)."],
    ["timeout", "Git took too long to answer."],
    ["too_large", "Git's answer is too large to be read."],
    ["failed", "Git could not read this project."],
  ])("dit pourquoi Git n'est pas disponible : %s", async (failure, message) => {
    const { user } = await openProject({ trusted: true, failure });
    await showGit(user);
    expect(await within(panel()).findByText(message)).toBeTruthy();
    expect(within(panel()).queryByRole("list")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Seul un projet non autorise propose d'activer Git.
    expect(within(panel()).queryByRole("button", { name: /Enable Git/ })).toBeNull();
  });

  it("marque Actualiser occupe pendant la lecture, sans lui retirer le focus", async () => {
    const { h, user } = await openProject({ trusted: true });
    await showGit(user);
    await within(panel()).findByText("Branch main · Changed files: 4");
    let release: (status: GitStatus) => void = () => undefined;
    const original = h.backend.gitStatus.bind(h.backend);
    h.backend.gitStatus = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const refresh = within(panel()).getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    await user.click(refresh);
    await waitFor(() => expect(refresh.getAttribute("aria-disabled")).toBe("true"));
    // Occupe, mais jamais `disabled` : le bouton garde le focus pendant la lecture.
    expect(refresh.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(refresh);
    release(STATUS);
    await waitFor(() => expect(refresh.getAttribute("aria-disabled")).toBe("false"));
    expect(document.activeElement).toBe(refresh);
    h.backend.gitStatus = original;
  });

  it("relit l'etat au bouton Actualiser", async () => {
    const { h, user } = await openProject({ trusted: true });
    await showGit(user);
    await within(panel()).findByText("Branch main · Changed files: 4");
    h.backend.gitCalls.length = 0;
    h.backend.gitRepository = { status: { ...STATUS, entries: [{ path: "a.txt", x: ".", y: "M" }] }, heads: new Map() };
    await user.click(within(panel()).getByRole("button", { name: "Refresh" }));
    expect(await within(panel()).findByText("Branch main · Changed files: 1")).toBeTruthy();
    expect(h.backend.gitCalls).toEqual([{ kind: "status", grantTrust: false }]);
  });

  it("ouvre le fichier dans l'editeur au clic", async () => {
    const { user } = await openProject({ trusted: true });
    await showGit(user);
    await user.click(await within(panel()).findByRole("button", { name: /^neuf\.txt/ }));
    expect(await screen.findByLabelText("editor:neuf.txt")).toBeTruthy();
  });

  it("annonce les textes en francais", async () => {
    const { user } = await openProject({ trusted: true, language: "fr-FR" });
    await showGit(user, { menu: "Affichage", item: /Afficher les modifications Git/ });
    expect(await within(screen.getByRole("region", { name: "Git" })).findByText("Branche main · Fichiers modifiés : 4")).toBeTruthy();
    expect(screen.getByText("Lecture seule : rien n'est validé, poussé ni modifié dans le dépôt.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Comparer a.txt avec HEAD" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^neuf\.txt Non suivi$/ })).toBeTruthy();
  });
});

describe("onglet Git : barre d'etat et commandes", () => {
  it("montre la branche et le nombre de fichiers modifies dans la barre d'etat, qui ouvre l'onglet", async () => {
    const { user } = await openProject({ trusted: true });
    expect(screen.queryByRole("button", { name: /^Git:/ })).toBeNull();
    await showGit(user);
    const button = await screen.findByRole("button", { name: "Git: main · 4" });
    await user.click(screen.getByRole("tab", { name: "Problems" }));
    expect(screen.queryByRole("region", { name: "Git" })).toBeNull();
    await user.click(button);
    expect(panel()).toBeTruthy();
  });

  it("ne montre que la branche quand il n'y a aucune modification", async () => {
    const { user } = await openProject({ trusted: true, status: { ...STATUS, entries: [] } });
    await showGit(user);
    expect(await screen.findByRole("button", { name: "Git: main" })).toBeTruthy();
  });

  it("propose la commande dans la palette, et la comparaison seulement avec un fichier ouvert", async () => {
    const { user } = await openProject({ trusted: true });
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    const input = await screen.findByRole("combobox");
    await user.type(input, "Git");
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    // La recherche est floue (« Git » est aussi une suite de lettres de « Go to symbol in project »).
    expect(options).toContain("Show Git changes");
    // Sans fichier ouvert, la comparaison avec HEAD n'est pas proposee.
    expect(options.some((option) => option?.startsWith("Compare with Git"))).toBe(false);
    await user.keyboard("{Escape}");

    await user.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    await screen.findByLabelText("editor:a.txt");
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await user.type(await screen.findByRole("combobox"), "Compare with Git");
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Compare with Git (HEAD)"]);
    await user.keyboard("{Escape}");
  });
});

describe("comparaison avec HEAD", () => {
  it("montre la version de HEAD en regard du texte courant", async () => {
    const { user } = await openProject({ trusted: true });
    await showGit(user);
    await user.click(await within(panel()).findByRole("button", { name: "Compare a.txt with HEAD" }));
    const dialog = await screen.findByRole("dialog", { name: /Compare with disk — a\.txt/ });
    expect((within(dialog).getByLabelText("Local history") as HTMLSelectElement).value).toBe("git");
    expect(within(dialog).getByRole("option", { name: "Git (HEAD)" })).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByTestId("diff-original").textContent).toBe(A_HEAD));
    expect(within(dialog).getByTestId("diff-modified").textContent).toBe(A_TXT);
    expect(within(dialog).queryByText(/No earlier version/)).toBeNull();
  });

  it("dit qu'un fichier neuf n'est pas dans HEAD et compte tout comme ajoute", async () => {
    const { user } = await openProject({ trusted: true });
    await showGit(user);
    await user.click(await within(panel()).findByRole("button", { name: "Compare neuf.txt with HEAD" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("This file is not in HEAD: everything counts as added.")).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByTestId("diff-original").textContent).toBe(""));
    expect(within(dialog).getByTestId("diff-modified").textContent).toBe("// neuf\n");
  });

  it("dit pourquoi la version de HEAD n'a pas pu etre lue", async () => {
    const { h, user } = await openProject({ trusted: true });
    await showGit(user);
    await within(panel()).findByRole("list", { name: "Files changed since HEAD" });
    h.backend.gitFailure = "timeout";
    await user.click(within(panel()).getByRole("button", { name: "Compare a.txt with HEAD" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("The version in HEAD could not be read: Git took too long to answer.")).toBeTruthy();
  });

  it("permet de passer de HEAD au disque dans la meme boite", async () => {
    const { h, user } = await openProject({ trusted: true });
    await showGit(user);
    await user.click(await within(panel()).findByRole("button", { name: "Compare a.txt with HEAD" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByTestId("diff-original").textContent).toBe(A_HEAD));
    await user.selectOptions(within(dialog).getByLabelText("Local history"), "On disk");
    await waitFor(() => expect(within(dialog).getByTestId("diff-original").textContent).toBe(A_TXT));
    expect(within(dialog).getByText("No earlier version has been kept yet.")).toBeTruthy();
    expect(h.backend.gitCalls.filter((call) => call.kind === "head")).toHaveLength(1);
  });

  it("n'offre pas Git dans la comparaison ordinaire tant que Git n'est pas lu", async () => {
    const { h, user } = await openProject();
    await user.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    await screen.findByLabelText("editor:a.txt");
    h.controller.openDialog({ kind: "diff", path: "a.txt" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("option", { name: "Git (HEAD)" })).toBeNull();
    expect((within(dialog).getByLabelText("Local history") as HTMLSelectElement).value).toBe("disk");
    expect(h.backend.gitCalls).toEqual([]);
  });

  it("la commande « Comparer avec Git » demande l'accord puis, une fois Git autorise, s'ouvre sur le fichier actif", async () => {
    const { h, user } = await openProject();
    await user.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    await screen.findByLabelText("editor:a.txt");
    await user.click(screen.getByRole("menuitem", { name: "View" }));
    await user.click(await screen.findByRole("menuitem", { name: /Compare with Git \(HEAD\)/ }));
    const trust = await screen.findByRole("dialog", { name: "Enable Git for this project?" });
    await user.click(within(trust).getByRole("button", { name: "Enable Git" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // La comparaison n'a pas ete ouverte d'elle-meme : l'utilisateur redemande.
    await user.click(screen.getByRole("menuitem", { name: "View" }));
    await user.click(await screen.findByRole("menuitem", { name: /Compare with Git \(HEAD\)/ }));
    const dialog = await screen.findByRole("dialog", { name: /a\.txt/ });
    await waitFor(() => expect(within(dialog).getByTestId("diff-original").textContent).toBe(A_HEAD));
    expect(h.backend.gitCalls.filter((call) => call.kind === "head")).toHaveLength(1);
  });
});
