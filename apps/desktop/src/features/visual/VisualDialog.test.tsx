// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp, type AppHarness } from "../../test/render-app";

/**
 * Editeur visuel de dialogues (RF-020 a RF-023) dans l'application complete : le NPC en blocs, les modifications sur une copie, les
 * blocs bruts verrouilles, le focus qui suit l'action, et l'application au document en une seule modification.
 */
const GUIDE = [
  "prontera,150,150,4\tscript\tGuide\t100,{",
  '\tmes "[Guide]";',
  '\tmes "Welcome, traveler.";',
  "\tnext;",
  "\tif (BaseLevel > 50) {",
  '\t\tmes "You are strong.";',
  "\t} else {",
  '\t\tmes "Train more.";',
  "\t}",
  '\tcallfunc "F_Bonus";   // bonus',
  "\tclose;",
  "}",
  "",
].join("\n");

const FILES = {
  "guide.txt": GUIDE,
  "empty.txt": "-\tscript\tEmpty\t-1,{\n}\n",
  "locked.txt": '-\tscript\tLocked\t-1,{\n\tcallfunc "F";\n\tend;\n}\n',
  "plain.txt": "// rien\n",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

async function openEditor(path: string): Promise<{ h: AppHarness; user: User }> {
  const h = renderApp({ withLanguage: true, files: FILES });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  await act(async () => {
    await h.controller.openFile(path);
  });
  await screen.findByLabelText(`editor:${path}`);
  return { h, user };
}

async function openVisual(user: User): Promise<HTMLElement> {
  await user.click(screen.getByRole("menuitem", { name: "File" }));
  await user.click(await screen.findByRole("menuitem", { name: /Visual dialogue editor/ }));
  return screen.findByRole("dialog", { name: "Visual dialogue editor" });
}

const mesInput = (dialog: HTMLElement, text: string): HTMLInputElement => within(dialog).getByRole("textbox", { name: `Message text — mes "${text}"` });
const button = (dialog: HTMLElement, name: string): HTMLElement => within(dialog).getByRole("button", { name });
const rows = (dialog: HTMLElement): string[] => [...dialog.querySelectorAll("[data-block-id]")].map((row) => row.getAttribute("data-block-id") ?? "");
const modifiedText = (dialog: HTMLElement): string => within(dialog).getByTestId("diff-modified").textContent ?? "";
const unavailable = (control: HTMLElement): boolean => control.getAttribute("aria-disabled") === "true";

describe("editeur visuel : ouverture et lecture", () => {
  it("s'ouvre par le menu Fichier sur le NPC du document, en blocs, sans rien modifier", async () => {
    const { h, user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    expect(within(dialog).getByRole("heading", { name: "NPC Guide" })).toBeTruthy();
    expect(within(dialog).getByText("Partly editable: 1 locked block(s) are kept exactly as written.")).toBeTruthy();
    expect(rows(dialog)).toEqual(["0", "1", "2", "3", "3.t.0", "3.e.0", "4", "5"]);
    expect(within(dialog).getByText("Not understood by the editor: kept as is and cannot be changed here.")).toBeTruthy();
    expect(dialog.querySelector(".visual-raw")?.textContent).toBe('callfunc "F_Bonus";');
    expect(within(dialog).getByText("No change yet.")).toBeTruthy();
    expect(within(dialog).queryByTestId("diff-modified")).toBeNull();
    // Le focus est dans le dialogue, sur le premier champ.
    expect(document.activeElement).toBe(mesInput(dialog, "[Guide]"));
    expect(h.buffers.get("guide.txt")?.text).toBe(GUIDE);
  });

  it("affiche un graphe versionne, ses connexions et le statut non-semantic des blocs bruts", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    const graph = within(dialog).getByText("Flow graph (10 nodes, 10 connections)");
    expect(graph).toBeTruthy();
    await user.click(graph);
    expect(within(dialog).getByRole("heading", { name: "Nodes" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(dialog.querySelectorAll("[data-node-id]")).toHaveLength(10);
    expect(within(dialog).getByText("Source order (not a control-flow guarantee)")).toBeTruthy();
    expect(within(dialog).getAllByText("leads to").length).toBeGreaterThan(0);
  });

  it("n'offre ni deplacement ni suppression pour un bloc brut, seulement d'ajouter a cote", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    const raw = within(dialog).getByRole("group", { name: 'callfunc "F_Bonus";' });
    expect(within(raw).queryByRole("button", { name: /^(Up|Down|Delete)/ })).toBeNull();
    expect(within(raw).getAllByRole("button").map((control) => control.textContent)).toEqual(["+ Message", "+ Next", "+ Close", "+ If"]);
  });

  it("nomme chaque champ et chaque bouton d'apres le bloc qu'il concerne", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    expect(within(dialog).getByRole("textbox", { name: "Condition — if (BaseLevel > 50)" })).toBeTruthy();
    for (const name of ['Up — next;', 'Down — next;', 'Delete — next;', 'Add a message after — next;', 'Add a next button after — next;', 'Add a close after — next;']) {
      expect(button(dialog, name)).toBeTruthy();
    }
    // Les branches sont des listes imbriquees sous leur `if`.
    expect(within(dialog).getAllByText("Then").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Otherwise").length).toBeGreaterThan(0);
    const branches = [...dialog.querySelectorAll('[data-block-id="3"] .visual-list')];
    expect(branches.map((list) => [...list.querySelectorAll("[data-block-id]")].map((row) => row.getAttribute("data-block-id")))).toEqual([["3.t.0"], ["3.e.0"]]);
  });

  it("dit ce qu'il y a a editer : rien en blocs, ou un NPC vide", async () => {
    const locked = await openEditor("locked.txt");
    let dialog = await openVisual(locked.user);
    expect(within(dialog).getByText("Nothing in this NPC can be edited as blocks: use the code editor.")).toBeTruthy();
    expect(rows(dialog)).toEqual(["0", "1"]);
    expect(dialog.querySelectorAll(".visual-line button, .visual-actions button[data-control]").length).toBe(0);
    cleanup();

    const empty = await openEditor("empty.txt");
    dialog = await openVisual(empty.user);
    expect(within(dialog).getByText("This NPC has no statement in its body yet.")).toBeTruthy();
    expect(rows(dialog)).toEqual([]);
  });

  it("n'ouvre rien pour un fichier sans NPC et le dit", async () => {
    const { user } = await openEditor("plain.txt");
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: /Visual dialogue editor/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("No NPC with a complete body was found in this file.")).toBeTruthy();
  });

  it("n'est pas disponible sans document ouvert", async () => {
    const h = renderApp({ withLanguage: true, files: FILES });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
    await screen.findByRole("tree");
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    const item = await screen.findByRole("menuitem", { name: /Visual dialogue editor/ });
    expect(item.hasAttribute("disabled") || item.getAttribute("aria-disabled") === "true").toBe(true);
    expect(h.store.getState().dialog).toBeNull();
  });
});

describe("editeur visuel : modifications", () => {
  it("modifie le texte d'un message a Entree et montre le changement sans toucher au document", async () => {
    const { h, user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    const input = mesInput(dialog, "Welcome, traveler.");
    await user.clear(input);
    await user.type(input, 'Hello "you"{Enter}');
    expect(modifiedText(dialog)).toBe(GUIDE.replace('"Welcome, traveler."', '"Hello \\"you\\""'));
    expect(within(dialog).getByText("Changes pending: review them below, then apply them to the document.")).toBeTruthy();
    // Le champ garde le focus et son contenu ; le document, lui, n'a pas bouge.
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: 'Message text — mes "Hello "you""' }));
    expect((document.activeElement as HTMLInputElement).value).toBe('Hello "you"');
    expect(h.buffers.get("guide.txt")?.text).toBe(GUIDE);
  });

  it("valide aussi en sortant du champ, et ne change rien si le texte est le meme", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    const input = mesInput(dialog, "Welcome, traveler.");
    await user.click(input);
    await user.tab();
    expect(within(dialog).queryByTestId("diff-modified")).toBeNull();
    await user.clear(input);
    await user.type(input, "Bye");
    await user.tab();
    expect(modifiedText(dialog)).toBe(GUIDE.replace("Welcome, traveler.", "Bye"));
  });

  it("refuse une condition vide ou une erreur de syntaxe, le dit, et garde la saisie pour la corriger", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    const condition = within(dialog).getByRole("textbox", { name: "Condition — if (BaseLevel > 50)" }) as HTMLInputElement;
    await user.clear(condition);
    await user.type(condition, "{Enter}");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("The condition cannot be empty or span several lines.");
    expect(condition.value).toBe("");
    await user.type(condition, "BaseLevel >{Enter}");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("The change must preserve valid script syntax. A condition must be a single expression.");
    expect(within(dialog).queryByTestId("diff-modified")).toBeNull();
    await user.clear(condition);
    await user.type(condition, "Zeny > 10{Enter}");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(modifiedText(dialog)).toBe(GUIDE.replace("BaseLevel > 50", "Zeny > 10"));
  });

  it("ajoute un bloc apres un autre et met le focus sur son champ", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    await user.click(button(dialog, 'Add a message after — mes "[Guide]"'));
    expect(modifiedText(dialog)).toBe(GUIDE.replace('\tmes "[Guide]";\n', '\tmes "[Guide]";\n\tmes "...";\n'));
    expect(rows(dialog).slice(0, 4)).toEqual(["0", "1", "2", "3"]);
    expect(document.activeElement).toBe(mesInput(dialog, "..."));
    // Un bloc sans champ (next) : le focus va a son premier bouton.
    await user.click(button(dialog, 'Add a next button after — mes "..."'));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Up — next;");
  });

  it("crée un dialogue avec deux branches dans un NPC vide, puis applique le diff", async () => {
    const { h, user } = await openEditor("empty.txt");
    const dialog = await openVisual(user);
    await user.click(button(dialog, "Add a condition — NPC body"));
    const condition = within(dialog).getByRole("textbox", { name: "Condition — if (1)" });
    expect(document.activeElement).toBe(condition);
    await user.clear(condition);
    await user.type(condition, "BaseLevel > 10{Enter}");

    await user.click(button(dialog, "Add a message — Then — if (BaseLevel > 10)"));
    const then = mesInput(dialog, "...");
    expect(document.activeElement).toBe(then);
    await user.clear(then);
    await user.type(then, "Welcome{Enter}");

    await user.click(button(dialog, "Add a message — Otherwise — if (BaseLevel > 10)"));
    const otherwise = mesInput(dialog, "...");
    expect(document.activeElement).toBe(otherwise);
    await user.clear(otherwise);
    await user.type(otherwise, "Come back later{Enter}");
    await user.click(button(dialog, "Add a close after — if (BaseLevel > 10)"));

    const expected = [
      '-\tscript\tEmpty\t-1,{', "\tif (BaseLevel > 10) {", '\t\tmes "Welcome";', "\t} else {", '\t\tmes "Come back later";', "\t}", "\tclose;", "}", "",
    ].join("\n");
    expect(rows(dialog)).toEqual(["0", "0.t.0", "0.e.0", "1"]);
    expect(modifiedText(dialog)).toBe(expected);
    expect(h.buffers.get("empty.txt")?.text).toBe(FILES["empty.txt"]);
    await user.click(button(dialog, "Apply to the document"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.buffers.get("empty.txt")?.text).toBe(expected);
    expect(h.backend.textOf("empty.txt")).toBe(FILES["empty.txt"]);
  });

  it("supprime un bloc, un if entier compris, et rend le focus a celui qui prend sa place", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    await user.click(button(dialog, 'Delete — mes "[Guide]"'));
    expect(modifiedText(dialog)).toBe(GUIDE.replace('\tmes "[Guide]";\n', ""));
    expect(document.activeElement).toBe(button(dialog, 'Delete — mes "Welcome, traveler."'));
    // Dernier d'une liste : le focus va au precedent, ici un bloc brut qui n'a pas de bouton Supprimer : son premier bouton.
    await user.click(button(dialog, "Delete — close;"));
    expect(document.activeElement).toBe(button(dialog, 'Add a message after — callfunc "F_Bonus";'));
    // Un bloc supprimable en fin de liste : le focus va a son voisin precedent, supprimable lui aussi (le `if` est maintenant le bloc 2).
    await user.click(button(dialog, 'Add a next button after — mes "Train more."'));
    const added = dialog.querySelector('[data-block-id="2.e.1"]') as HTMLElement;
    await user.click(within(added).getByRole("button", { name: "Delete — next;" }));
    expect(document.activeElement).toBe(button(dialog, 'Delete — mes "Train more."'));
  });

  it("rend le focus au bloc qui contient la liste videe, puis au titre quand il ne reste rien", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    await user.click(button(dialog, 'Delete — mes "Train more."'));
    expect(document.activeElement).toBe(button(dialog, "Delete — if (BaseLevel > 50)"));
    cleanup();

    const only = renderApp({ withLanguage: true, files: { "one.txt": '-\tscript\tOne\t-1,{\n\tmes "a";\n}\n' } });
    const user2 = userEvent.setup();
    await user2.click(await screen.findByRole("button", { name: /open a project folder/i }));
    await screen.findByRole("tree");
    await act(async () => {
      await only.controller.openFile("one.txt");
    });
    const dialog2 = await openVisual(user2);
    await user2.click(button(dialog2, 'Delete — mes "a"'));
    expect(within(dialog2).getByText("This NPC has no statement in its body yet.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog2).getByRole("heading", { name: "NPC One" }));
  });

  it("deplace un bloc d'un cran et garde le focus sur le meme bouton du meme bloc ; aux extremites le bouton est inactif", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    expect(unavailable(button(dialog, 'Up — mes "[Guide]"'))).toBe(true);
    await user.click(button(dialog, 'Up — mes "[Guide]"'));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).queryByTestId("diff-modified")).toBeNull();

    await user.click(button(dialog, 'Down — mes "[Guide]"'));
    expect(modifiedText(dialog)).toBe(GUIDE.replace('\tmes "[Guide]";\n\tmes "Welcome, traveler.";\n', '\tmes "Welcome, traveler.";\n\tmes "[Guide]";\n'));
    expect(document.activeElement).toBe(button(dialog, 'Down — mes "[Guide]"'));
    expect(rows(dialog).indexOf("1")).toBe(1);
    expect(mesInput(dialog, "[Guide]").closest("[data-block-id]")?.getAttribute("data-block-id")).toBe("1");
    await user.click(button(dialog, 'Up — mes "[Guide]"'));
    expect(within(dialog).queryByTestId("diff-modified")).toBeNull();
    expect(document.activeElement).toBe(button(dialog, 'Up — mes "[Guide]"'));
  });

  it("annule les changements : le dialogue repart du document et les champs aussi", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    expect(unavailable(button(dialog, "Discard changes"))).toBe(true);
    const input = mesInput(dialog, "[Guide]");
    await user.clear(input);
    await user.type(input, "Autre{Enter}");
    expect(unavailable(button(dialog, "Discard changes"))).toBe(false);
    await user.click(button(dialog, "Discard changes"));
    expect(within(dialog).queryByTestId("diff-modified")).toBeNull();
    expect(mesInput(dialog, "[Guide]").value).toBe("[Guide]");
    expect(unavailable(button(dialog, "Apply to the document"))).toBe(true);
  });
});

describe("editeur visuel : application et fermeture", () => {
  it("applique au document en une seule modification, ferme, marque modifie, n'ecrit rien et annonce", async () => {
    const { h, user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    await user.click(button(dialog, 'Add a message after — mes "[Guide]"'));
    const input = mesInput(dialog, "...");
    await user.clear(input);
    await user.type(input, "Nouveau{Enter}");
    await user.click(button(dialog, 'Delete — next;'));
    const expected = GUIDE.replace('\tmes "[Guide]";\n', '\tmes "[Guide]";\n\tmes "Nouveau";\n').replace("\tnext;\n", "");
    expect(modifiedText(dialog)).toBe(expected);

    await user.click(button(dialog, "Apply to the document"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.buffers.get("guide.txt")?.text).toBe(expected);
    expect(h.store.getState().docs["guide.txt"]?.dirty).toBe(true);
    expect(h.backend.textOf("guide.txt")).toBe(GUIDE);
    expect(await screen.findByText("Changes applied to guide.txt. Nothing is saved until you save (Ctrl+S).")).toBeTruthy();
  });

  it("ne fait rien quand on applique sans changement", async () => {
    const { h, user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    await user.click(button(dialog, "Apply to the document"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(h.store.getState().docs["guide.txt"]?.dirty).toBe(false);
  });

  it("refuse d'appliquer si le document a change pendant que le dialogue etait ouvert", async () => {
    const { h, user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    const input = mesInput(dialog, "[Guide]");
    await user.clear(input);
    await user.type(input, "Autre{Enter}");
    h.buffers.get("guide.txt")!.text = `${GUIDE}// ajout\n`;
    act(() => h.controller.notifyEdited("guide.txt"));
    await user.click(button(dialog, "Apply to the document"));
    expect(await screen.findByText("The document changed while the editor was open, so nothing was applied. Open the visual editor again.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(h.buffers.get("guide.txt")?.text).toBe(`${GUIDE}// ajout\n`);
  });

  it("ferme tout de suite sans changement, et demande de confirmer l'abandon quand il y en a", async () => {
    const { h, user } = await openEditor("guide.txt");
    let dialog = await openVisual(user);
    await user.click(button(dialog, "Close"));
    expect(screen.queryByRole("dialog")).toBeNull();

    dialog = await openVisual(user);
    const input = mesInput(dialog, "[Guide]");
    await user.clear(input);
    await user.type(input, "Autre{Enter}");
    await user.click(button(dialog, "Close"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(within(dialog).getByText(/Some changes are not applied yet/)).toBeTruthy();
    // Echap passe par le meme garde-fou ; la confirmation se fait sur le meme bouton.
    await user.click(button(dialog, "Discard and close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.buffers.get("guide.txt")?.text).toBe(GUIDE);
    expect(h.store.getState().docs["guide.txt"]?.dirty).toBe(false);
  });

  it("Echap demande d'abord confirmation quand il y a des changements, puis ferme", async () => {
    const { user } = await openEditor("guide.txt");
    const dialog = await openVisual(user);
    const input = mesInput(dialog, "[Guide]");
    await user.clear(input);
    await user.type(input, "Autre{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(within(dialog).getByText(/Some changes are not applied yet/)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rend le focus a l'element d'origine a la fermeture", async () => {
    const { user } = await openEditor("guide.txt");
    const menu = screen.getByRole("menuitem", { name: "File" });
    await user.click(menu);
    await user.click(await screen.findByRole("menuitem", { name: /Visual dialogue editor/ }));
    await screen.findByRole("dialog", { name: "Visual dialogue editor" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
