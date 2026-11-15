// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "../../services/types";
import { FakeBackend } from "../../test/fake-backend";
import { renderApp, type AppHarness } from "../../test/render-app";

/**
 * Deploiement vers un dossier (RF-018) dans l'application complete : le plan (dry-run) n'ecrit rien, le deploiement sauvegarde, ecrit, verifie,
 * et peut etre restaure. La destination est un second faux disque (`FakeBackend.destination`).
 */
const NPC = (name: string): string => `prontera,150,150,4\tscript\t${name}\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n`;
const BAD = 'prontera,3,3,0\tscript\tB\t100,{\n\tmes "a"\n}\n';

const FILES: Record<string, string> = {
  "npc/custom/a.txt": NPC("A"),
  "npc/custom/b.txt": NPC("B"),
  "npc/autre/c.txt": NPC("C"),
};

afterEach(() => {
  cleanup();
});

type User = ReturnType<typeof userEvent.setup>;

interface Setup {
  h: AppHarness;
  user: User;
  server: FakeBackend;
}

async function openProject(options: { files?: Record<string, string>; language?: string; destinationId?: string } = {}): Promise<Setup> {
  const server = new FakeBackend();
  const h = renderApp({
    withLanguage: true,
    ...(options.language === undefined ? {} : { language: options.language }),
    files: options.files ?? FILES,
    configure: (backend) => {
      backend.destination = { root: { id: options.destinationId ?? "destroot", displayPath: "C:\\fake\\server" }, disk: server };
    },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder|ouvrir un dossier/i }));
  await screen.findByRole("tree");
  await waitFor(() => expect(h.store.getState().indexing.status).toBe("done"));
  return { h, user, server };
}

async function openDeploy(user: User, names = { menu: "File", item: /Deploy to a folder/, dialog: "Deploy to a folder" }): Promise<HTMLElement> {
  await user.click(screen.getByRole("menuitem", { name: names.menu }));
  await user.click(await screen.findByRole("menuitem", { name: names.item }));
  return screen.findByRole("dialog", { name: names.dialog });
}

async function chooseAndPlan(user: User, dialog: HTMLElement): Promise<void> {
  await user.click(within(dialog).getByRole("button", { name: "Choose a folder…" }));
  await within(dialog).findByText("C:\\fake\\server");
  await user.click(within(dialog).getByRole("button", { name: "Prepare the plan" }));
  await within(dialog).findByText(/Plan \(nothing has been written\)/);
}

const deployButton = (dialog: HTMLElement): HTMLButtonElement => within(dialog).getByRole("button", { name: /^Deploy$|^Deploying/ }) as HTMLButtonElement;

/** Un bouton qu'on ne peut pas utiliser : `disabled`, ou `aria-disabled` (occupe, sans perdre le focus). */
const unavailable = (button: HTMLElement): boolean => (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true";

describe("deploiement : destination et plan", () => {
  it("s'ouvre par le menu Fichier, propose npc/custom, et demande une destination avant tout", async () => {
    const { h, user } = await openProject();
    const dialog = await openDeploy(user);
    expect((within(dialog).getByLabelText("Project folder to deploy") as HTMLInputElement).value).toBe("npc/custom");
    expect(within(dialog).getByText("No folder chosen.")).toBeTruthy();
    expect(unavailable(within(dialog).getByRole("button", { name: "Prepare the plan" }))).toBe(true);
    expect(unavailable(deployButton(dialog))).toBe(true);
    expect(h.backend.destinationPicks).toBe(0);
    expect(screen.getByText(/neither reconfigured nor restarted/)).toBeTruthy();
  });

  it("propose tout le projet quand il n'a pas de dossier npc", async () => {
    const { user } = await openProject({ files: { "scripts/a.txt": NPC("A") } });
    const dialog = await openDeploy(user);
    expect((within(dialog).getByLabelText("Project folder to deploy") as HTMLInputElement).value).toBe("");
  });

  it("laisse tout tel quel quand l'utilisateur annule le choix du dossier", async () => {
    const { h, user } = await openProject();
    h.backend.destination = null;
    const dialog = await openDeploy(user);
    await user.click(within(dialog).getByRole("button", { name: "Choose a folder…" }));
    expect(h.backend.destinationPicks).toBe(1);
    expect(within(dialog).getByText("No folder chosen.")).toBeTruthy();
    expect(unavailable(within(dialog).getByRole("button", { name: "Prepare the plan" }))).toBe(true);
  });

  it("refuse le projet lui-meme comme destination", async () => {
    const { h, user } = await openProject({ destinationId: "fakeroot" });
    const dialog = await openDeploy(user);
    await user.click(within(dialog).getByRole("button", { name: "Choose a folder…" }));
    expect(await within(dialog).findByText("The destination cannot be the project itself.")).toBeTruthy();
    expect(within(dialog).getByText("No folder chosen.")).toBeTruthy();
    expect(h.backend.writes).toEqual([]);
  });

  it("prepare un plan sans rien ecrire : ce qui sera cree, avec le total, et seulement le dossier demande", async () => {
    const { h, user, server } = await openProject();
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    expect(within(dialog).getByText("2 to create · 0 to update · 0 unchanged · 0 in conflict · " + (NPC("A").length + NPC("B").length) + " B to send")).toBeTruthy();
    const rows = within(dialog).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual(["Create npc/custom/a.txt", "Create npc/custom/b.txt"]);
    expect(h.backend.writes).toEqual([]);
    expect(server.writes).toEqual([]);
    expect(unavailable(deployButton(dialog))).toBe(false);
  });

  it("montre mises a jour, conflits et fichiers identiques", async () => {
    const { user, server } = await openProject();
    server.put("npc/custom/a.txt", NPC("A")); // identique
    server.put("npc/custom/b.txt", "// modifie ailleurs\n"); // existe, jamais deploye d'ici : conflit
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    expect(within(dialog).getByText(/0 to create · 0 to update · 1 unchanged · 1 in conflict/)).toBeTruthy();
    expect(within(dialog).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Conflict npc/custom/b.txt — already in the destination, never deployed from here"]);
    // Un conflit ne s'envoie pas sans decision : rien n'est a deployer tant que la case n'est pas cochee.
    expect(unavailable(deployButton(dialog))).toBe(true);
  });

  it("dit que la destination correspond deja quand il n'y a rien a envoyer", async () => {
    const { user, server } = await openProject();
    server.put("npc/custom/a.txt", NPC("A"));
    server.put("npc/custom/b.txt", NPC("B"));
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    expect(within(dialog).getByText("Nothing to send: the destination already matches.")).toBeTruthy();
    expect(unavailable(deployButton(dialog))).toBe(true);
  });

  it("jette le plan quand le dossier ou la destination change", async () => {
    const { user } = await openProject();
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    expect(unavailable(deployButton(dialog))).toBe(false);
    const prefix = within(dialog).getByLabelText("Project folder to deploy");
    await user.type(prefix, "x");
    expect(within(dialog).queryByText(/Plan \(nothing has been written\)/)).toBeNull();
    expect(unavailable(deployButton(dialog))).toBe(true);
  });

  it("couvre tout le projet quand le dossier est vide, et rien ne sort du dossier demande", async () => {
    const { user } = await openProject();
    const dialog = await openDeploy(user);
    await user.clear(within(dialog).getByLabelText("Project folder to deploy"));
    await user.click(within(dialog).getByRole("button", { name: "Choose a folder…" }));
    await within(dialog).findByText("C:\\fake\\server");
    await user.click(within(dialog).getByRole("button", { name: "Prepare the plan" }));
    await within(dialog).findByText(/Plan \(nothing has been written\)/);
    expect(within(dialog).getAllByRole("listitem").map((row) => row.textContent?.replace(/^Create /, ""))).toEqual(["npc/autre/c.txt", "npc/custom/a.txt", "npc/custom/b.txt"]);
  });

  it("n'inclut jamais les dossiers de l'outil ni de Git", async () => {
    const { user } = await openProject({ files: { ...FILES, ".runeforge/deploy/x/manifest.json": "{}", ".git/config": "[core]", "npc/custom/.git/HEAD": "ref" } });
    const dialog = await openDeploy(user);
    await user.clear(within(dialog).getByLabelText("Project folder to deploy"));
    await user.click(within(dialog).getByRole("button", { name: "Choose a folder…" }));
    await within(dialog).findByText("C:\\fake\\server");
    await user.click(within(dialog).getByRole("button", { name: "Prepare the plan" }));
    await within(dialog).findByText(/Plan \(nothing has been written\)/);
    const listed = within(dialog).getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(listed.some((row) => row.includes(".git") || row.includes(".runeforge"))).toBe(false);
  });
});

describe("deploiement : le focus reste sur le bouton clique", () => {
  it("n'utilise pas disabled pendant le travail : un bouton qui a le focus et se desactive le rendrait au document", async () => {
    const { h, user } = await openProject();
    const dialog = await openDeploy(user);
    await user.click(within(dialog).getByRole("button", { name: "Choose a folder…" }));
    await within(dialog).findByText("C:\\fake\\server");
    let finish: (value: null) => void = () => undefined;
    vi.spyOn(h.controller, "prepareDeployment").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const prepare = within(dialog).getByRole("button", { name: "Prepare the plan" });
    await user.click(prepare);
    const busy = within(dialog).getByRole("button", { name: "Reading both sides…" });
    expect(busy).toBe(prepare);
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(prepare);
    // Pendant le travail, ni le bouton principal ni Fermer ne sont desactives au sens du navigateur, et Echap ne ferme pas.
    expect(within(dialog).getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(false);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    finish(null);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Prepare the plan" }).getAttribute("aria-disabled")).toBe("false"));
    expect(document.activeElement).toBe(prepare);
  });

  it("garde le focus sur Deployer pendant et apres le deploiement, et sur Restaurer pendant la restauration", async () => {
    const { user, server } = await openProject();
    server.put("npc/custom/a.txt", NPC("A-ancien"));
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    await user.click(within(dialog).getByLabelText(/Also overwrite the files in conflict/));
    const run = deployButton(dialog);
    await user.click(run);
    await within(dialog).findByText(/Deployed: 1 created/);
    expect(run.hasAttribute("disabled")).toBe(false);
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(run);
    const restore = within(dialog).getByRole("button", { name: "Restore the previous versions" });
    await user.click(restore);
    await within(dialog).findByText(/Restored: 1/);
    expect(restore.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(restore);
    // Le dialogue reste utilisable au clavier : Echap le ferme.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("deploiement : execution", () => {
  it("copie les fichiers, dit ce qui a ete fait, et note le dernier deploiement dans le projet", async () => {
    const { h, user, server } = await openProject();
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    await user.click(deployButton(dialog));
    expect(await within(dialog).findByText("Deployed: 2 created, 0 updated, 0 overwritten, 0 unchanged.")).toBeTruthy();
    expect(server.textOf("npc/custom/a.txt")).toBe(NPC("A"));
    expect(server.textOf("npc/custom/b.txt")).toBe(NPC("B"));
    expect(server.textOf("npc/autre/c.txt")).toBeUndefined();
    // Le projet garde le manifeste et le rapport, rien ailleurs.
    // (le faux disque note deux fois une creation par « ecraser » : on ne compare que les chemins)
    const written = [...new Set(h.backend.writes.map((write) => write.path))];
    expect(written.sort()).toEqual([".runeforge/deploy/destroot/last-report.json", ".runeforge/deploy/destroot/manifest.json"]);
    expect(unavailable(deployButton(dialog))).toBe(true);
    expect(within(dialog).getByText("What was replaced is backed up in the project, under .runeforge/deploy/.")).toBeTruthy();
    // La journalisation ne contient que des nombres.
    expect(h.backend.logs).toEqual([]);
  });

  it("sauvegarde ce qu'il remplace dans le projet, et peut le restaurer", async () => {
    const { h, user, server } = await openProject();
    server.put("npc/custom/a.txt", NPC("A-ancien"));
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    await user.click(within(dialog).getByLabelText("Also overwrite the files in conflict (their current version is backed up first)"));
    await user.click(deployButton(dialog));
    expect(await within(dialog).findByText("Deployed: 1 created, 0 updated, 1 overwritten, 0 unchanged.")).toBeTruthy();
    expect(server.textOf("npc/custom/a.txt")).toBe(NPC("A"));
    const backups = [...h.backend.files.keys()].filter((path) => path.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^\.runeforge\/deploy\/destroot\/backups\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\/npc\/custom\/a\.txt\.bak$/);
    expect(h.backend.textOf(backups[0] ?? "")).toBe(NPC("A-ancien"));

    await user.click(within(dialog).getByRole("button", { name: "Restore the previous versions" }));
    expect(await within(dialog).findByText("Restored: 1. Left in place, because the deployment created them: 1.")).toBeTruthy();
    expect(server.textOf("npc/custom/a.txt")).toBe(NPC("A-ancien"));
    expect(server.textOf("npc/custom/b.txt")).toBe(NPC("B"));
  });

  it("n'ecrase pas un conflit tant que la case n'est pas cochee", async () => {
    const { user, server } = await openProject();
    server.put("npc/custom/a.txt", "// du serveur\n");
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    // Le reste (b.txt) part, le conflit reste.
    await user.click(deployButton(dialog));
    expect(await within(dialog).findByText(/Not everything was deployed: 1 created, 0 updated, 0 overwritten, 0 failed, 1 left out\./)).toBeTruthy();
    expect(within(dialog).getByText(/npc\/custom\/a\.txt — in conflict, not overwritten/)).toBeTruthy();
    expect(server.textOf("npc/custom/a.txt")).toBe("// du serveur\n");
  });

  it("refuse les fichiers a erreurs d'analyse tant que l'utilisateur ne l'a pas decide", async () => {
    const { user, server } = await openProject({ files: { "npc/custom/a.txt": NPC("A"), "npc/custom/mauvais.txt": BAD } });
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    expect(within(dialog).getByText("Files to send that have analysis errors: npc/custom/mauvais.txt")).toBeTruthy();
    expect(unavailable(deployButton(dialog))).toBe(true);
    await user.click(within(dialog).getByLabelText("Deploy anyway, errors included"));
    expect(unavailable(deployButton(dialog))).toBe(false);
    await user.click(deployButton(dialog));
    expect(await within(dialog).findByText(/Deployed: 2 created/)).toBeTruthy();
    expect(server.textOf("npc/custom/mauvais.txt")).toBe(BAD);
  });

  it("en production, exige de saisir le nom du dossier de destination", async () => {
    const { user, server } = await openProject();
    const dialog = await openDeploy(user);
    await user.selectOptions(within(dialog).getByLabelText("Environment"), "Production");
    await chooseAndPlan(user, dialog);
    expect(unavailable(deployButton(dialog))).toBe(true);
    const confirmation = within(dialog).getByLabelText(/Production: type the folder name server to confirm/);
    await user.type(confirmation, "serveur");
    expect(unavailable(deployButton(dialog))).toBe(true);
    await user.clear(confirmation);
    await user.type(confirmation, "server");
    expect(unavailable(deployButton(dialog))).toBe(false);
    await user.click(deployButton(dialog));
    expect(await within(dialog).findByText(/Deployed: 2 created/)).toBeTruthy();
    expect(server.textOf("npc/custom/a.txt")).toBe(NPC("A"));
  });

  it("ne demande rien de plus hors production", async () => {
    const { user } = await openProject();
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    expect(within(dialog).queryByLabelText(/Production: type the folder name/)).toBeNull();
  });

  it("dit ce qui a echoue et ce qui est reste de cote quand une ecriture est refusee", async () => {
    const { user, server } = await openProject();
    const original = server.writeFile.bind(server);
    vi.spyOn(server, "writeFile").mockImplementation((rootId, path, data, precondition, keepHistory) => {
      if (path === "npc/custom/a.txt") throw new BackendError({ code: "permission_denied" });
      return original(rootId, path, data, precondition, keepHistory);
    });
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    await user.click(deployButton(dialog));
    expect(await within(dialog).findByText("Not everything was deployed: 0 created, 0 updated, 0 overwritten, 1 failed, 1 left out.")).toBeTruthy();
    expect(within(dialog).getByText(/npc\/custom\/a\.txt — the file could not be written/)).toBeTruthy();
    expect(within(dialog).getByText(/npc\/custom\/b\.txt — not sent: the deployment stopped before it/)).toBeTruthy();
    expect(server.files.size).toBe(0);
  });

  it("ne restaure pas ce qui a ete modifie depuis le deploiement, et le dit", async () => {
    const { user, server } = await openProject();
    server.put("npc/custom/a.txt", NPC("A-ancien"));
    const dialog = await openDeploy(user);
    await chooseAndPlan(user, dialog);
    await user.click(within(dialog).getByLabelText(/Also overwrite the files in conflict/));
    await user.click(deployButton(dialog));
    await within(dialog).findByText(/Deployed: 1 created, 0 updated, 1 overwritten/);
    server.put("npc/custom/a.txt", "// retouche apres coup\n");
    await user.click(within(dialog).getByRole("button", { name: "Restore the previous versions" }));
    expect(await within(dialog).findByText("Could not restore: npc/custom/a.txt (changed since the deployment)")).toBeTruthy();
    expect(server.textOf("npc/custom/a.txt")).toBe("// retouche apres coup\n");
  });

  it("propose de restaurer le dernier deploiement apres un redemarrage (rapport conserve dans le projet)", async () => {
    const first = await openProject();
    first.server.put("npc/custom/a.txt", NPC("A-ancien"));
    const dialog = await openDeploy(first.user);
    await chooseAndPlan(first.user, dialog);
    await first.user.click(within(dialog).getByLabelText(/Also overwrite the files in conflict/));
    await first.user.click(deployButton(dialog));
    await within(dialog).findByText(/Deployed: 1 created, 0 updated, 1 overwritten/);
    // Autre session : meme projet, meme destination, nouveau dialogue.
    first.h.controller.closeDialog();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const again = await openDeploy(first.user);
    expect(within(again).queryByRole("button", { name: "Restore the previous versions" })).toBeNull();
    await chooseAndPlan(first.user, again);
    expect(within(again).getByText(/Last deployment to this folder:/)).toBeTruthy();
    expect(within(again).getByRole("button", { name: "Restore the previous versions" })).toBeTruthy();
  });

  it("annonce les textes en francais", async () => {
    const { user } = await openProject({ language: "fr-FR" });
    const dialog = await openDeploy(user, { menu: "Fichier", item: /Déployer vers un dossier/, dialog: "Déployer vers un dossier" });
    expect(within(dialog).getByText("Aucun dossier choisi.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Choisir un dossier…" }));
    await within(dialog).findByText("C:\\fake\\server");
    await user.click(within(dialog).getByRole("button", { name: "Préparer le plan" }));
    expect(await within(dialog).findByText(/2 à créer · 0 à mettre à jour/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Déployer" }));
    expect(await within(dialog).findByText("Déployé : 2 créé(s), 0 mis à jour, 0 écrasé(s), 0 inchangé(s).")).toBeTruthy();
  });
});
