// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./test/render-app";

const NPC = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';

afterEach(() => {
  cleanup();
});

async function openProject(_harness: ReturnType<typeof renderApp>): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
}

describe("App - ecran d'accueil", () => {
  it("affiche l'accueil sans projet, avec les projets recents, et reste utilisable au clavier", async () => {
    renderApp({
      configure: (backend) => {
        backend.recents = [{ path: "C:\\srv\\mon-serveur", name: "mon-serveur", lastOpenedMs: 1 }];
      },
    });
    expect(await screen.findByRole("heading", { name: /welcome to runeforge studio/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^mon-serveur/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove from list.*mon-serveur/i })).toBeTruthy();
    expect(screen.getByText(/nothing is sent over the network/i)).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("utilise le francais quand le systeme est en francais, et bascule en direct", async () => {
    renderApp({ language: "fr-FR" });
    expect(await screen.findByRole("heading", { name: /bienvenue dans runeforge studio/i })).toBeTruthy();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/langue/i), "en");
    expect(await screen.findByRole("heading", { name: /welcome to runeforge studio/i })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("explique qu'une application de bureau est necessaire quand le coeur natif est absent", async () => {
    renderApp({
      configure: (backend) => {
        backend.appInfo = async () => {
          throw new Error("no runtime");
        };
      },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/desktop application required/i);
  });
});

describe("App - parcours projet, edition et enregistrement", () => {
  it("ouvre un dossier, liste les fichiers, ouvre un onglet et l'edite jusqu'a l'enregistrement au clavier", async () => {
    const harness = renderApp({ files: { "npc/a.txt": NPC, "readme.md": "hello\n" } });
    await openProject(harness);
    const user = userEvent.setup();

    const tree = screen.getByRole("tree", { name: /explorer/i });
    expect(within(tree).getByRole("treeitem", { name: /readme\.md/ })).toBeTruthy();
    await user.click(within(tree).getByRole("treeitem", { name: /npc/ })); // deplie le dossier
    await user.click(await within(tree).findByRole("treeitem", { name: /a\.txt/ }));

    expect(await screen.findByRole("tab", { name: /a\.txt/ })).toBeTruthy();
    const editor = (await screen.findByTestId("editor")) as HTMLTextAreaElement;
    expect(editor.value).toBe(NPC);

    // Une modification marque l'onglet et la barre d'etat.
    fireEvent.change(editor, { target: { value: NPC.replace("Bonjour", "Salut") } });
    await waitFor(() => expect(screen.getByRole("img", { name: /modified/i })).toBeTruthy());
    expect(screen.getByText("Modified")).toBeTruthy();

    // Ctrl+S enregistre sur le disque, en conservant les fins de ligne.
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(harness.backend.textOf("npc/a.txt")).toContain("Salut"));
    expect(screen.queryByRole("img", { name: /modified/i })).toBeNull();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("demande confirmation avant de fermer un onglet modifie et n'ecrit rien si on abandonne", async () => {
    const harness = renderApp({ files: { "a.txt": NPC } });
    await openProject(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    fireEvent.change(await screen.findByTestId("editor"), { target: { value: "autre contenu\n" } });
    await waitFor(() => expect(screen.getByRole("img", { name: /modified/i })).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /close a\.txt/i }));
    const dialog = await screen.findByRole("dialog", { name: /unsaved changes/i });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: /don't save/i }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /a\.txt/ })).toBeNull());
    expect(harness.backend.textOf("a.txt")).toBe(NPC);
    expect(harness.backend.writes).toHaveLength(0);
  });

  it("propose de comparer, recharger ou ecraser quand le fichier a change sur le disque", async () => {
    const harness = renderApp({ files: { "a.txt": NPC } });
    await openProject(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    fireEvent.change(await screen.findByTestId("editor"), { target: { value: "mon travail\n" } });
    harness.backend.put("a.txt", "version externe\n");
    await user.keyboard("{Control>}s{/Control}");

    const dialog = await screen.findByRole("dialog", { name: /file changed on disk/i });
    expect(harness.backend.textOf("a.txt")).toBe("version externe\n");
    await user.click(within(dialog).getByRole("button", { name: /compare versions/i }));
    const diff = await screen.findByTestId("diff");
    expect(within(diff).getByTestId("diff-original").textContent).toBe("version externe\n");
    expect(within(diff).getByTestId("diff-modified").textContent).toBe("mon travail\n");
  });

  it("affiche les problemes du fichier ouvert avec confiance et conseil de correction", async () => {
    const harness = renderApp({ files: { "bad.txt": 'prontera,1,1,0\tscript\tX\t100,{\n\tmes "a"\n}\n' } });
    await openProject(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("treeitem", { name: /bad\.txt/ }));
    await user.keyboard("{Control>}j{/Control}");
    const panel = await screen.findByRole("region", { name: /problems/i });
    await waitFor(() => expect(within(panel).getByText(/Expected ';' to end the statement/)).toBeTruthy(), { timeout: 3000 });
    expect(within(panel).getByText(/RS0020 · probable · bad\.txt:2/)).toBeTruthy();
    expect(within(panel).getByText(/Add ';' at the end of the statement/)).toBeTruthy();
  });

  it("ouvre un fichier par la palette (Ctrl+P) avec recherche floue", async () => {
    const harness = renderApp({ files: { "npc/cities/prontera.txt": "a\n", "npc/cities/geffen.txt": "b\n", "db/item_db.yml": "c\n" } });
    await openProject(harness);
    const user = userEvent.setup();
    await user.keyboard("{Control>}p{/Control}");
    const input = await screen.findByRole("combobox");
    await user.type(input, "pront");
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("tab", { name: /prontera\.txt/ })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("ouvre la palette de commandes et execute une commande", async () => {
    const harness = renderApp({ files: { "a.txt": NPC } });
    await openProject(harness);
    const user = userEvent.setup();
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    const input = await screen.findByRole("combobox");
    await user.type(input, "settings");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: /settings/i })).toBeTruthy();
  });

  it("propose la creation d'un fichier et refuse un nom deja utilise", async () => {
    const harness = renderApp({ files: { "a.txt": NPC } });
    await openProject(harness);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /new file/i }));
    const dialog = await screen.findByRole("dialog", { name: /new script file/i });
    const field = within(dialog).getByLabelText(/file name or path/i);
    await user.type(field, "a.txt");
    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/already exists/i);
    await user.clear(field);
    await user.type(field, "npc/new.txt");
    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByRole("tab", { name: /new\.txt/ })).toBeTruthy();
    expect(harness.backend.files.has("npc/new.txt")).toBe(true);
  });
});

describe("App - accessibilite", () => {
  it("expose les roles ARIA des regions principales et rend le focus au dialogue puis a l'element precedent", async () => {
    const harness = renderApp({ files: { "a.txt": NPC } });
    await openProject(harness);
    const user = userEvent.setup();
    expect(screen.getByRole("menubar")).toBeTruthy();
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();

    const settingsButton = screen.getByRole("button", { name: /settings/i });
    settingsButton.focus();
    await user.click(settingsButton);
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole("tablist")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(settingsButton);
  });

  it("permet de redimensionner l'explorateur au clavier (separateur ARIA)", async () => {
    const harness = renderApp({ files: { "a.txt": NPC } });
    await openProject(harness);
    const user = userEvent.setup();
    const splitter = screen.getByRole("separator", { name: /explorer/i });
    const before = Number(splitter.getAttribute("aria-valuenow"));
    splitter.focus();
    await user.keyboard("{ArrowRight}");
    expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(before + 16);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(before + 16 - 64);
  });

  it("navigue dans l'arbre au clavier et ouvre un fichier avec Entree", async () => {
    const harness = renderApp({ files: { "a.txt": "a\n", "b.txt": "b\n" } });
    await openProject(harness);
    const user = userEvent.setup();
    const tree = screen.getByRole("tree");
    tree.focus();
    // Sans selection, la premiere fleche se place sur la premiere ligne ; la suivante descend.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("treeitem", { name: /a\.txt/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(await screen.findByRole("tab", { name: /b\.txt/ })).toBeTruthy();
  });
});
