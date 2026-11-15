// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./test/render-app";

/**
 * Accessibilite des dialogues (WCAG 2.1.2, 2.4.3, 4.1.2), trouvee par l'audit de `scripts/e2e/accessibility.ts` sur l'application
 * reelle : la palette ne retenait pas le focus (Tab la quittait, Echap cessait alors de la fermer), ne le rendait pas, et sa liste de
 * resultats comme les onglets des parametres n'avaient pas de nom.
 */
const NPC = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';

afterEach(() => {
  cleanup();
});

async function openProject(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  return user;
}

describe("palette de commandes : clavier et focus", () => {
  it("garde le focus sur sa saisie quand on appuie sur Tab, avec Maj ou non", async () => {
    renderApp({ files: { "a.txt": NPC } });
    const user = await openProject();
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    const input = await screen.findByRole("combobox");
    expect(document.activeElement).toBe(input);
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(input);
  });

  it("ramene le focus sur sa saisie quand Tab est presse alors qu'il est ailleurs dans la palette", async () => {
    renderApp({ files: { "a.txt": NPC } });
    const user = await openProject();
    await user.keyboard("{Control>}p{/Control}");
    const input = await screen.findByRole("combobox");
    await user.click(screen.getByText(/type > for commands/i));
    expect(document.activeElement).not.toBe(input);
    await user.tab();
    expect(document.activeElement).toBe(input);
  });

  it("se ferme par Echap meme quand le focus est dans la palette sans etre sur la saisie, et rend le focus a son origine", async () => {
    renderApp({ files: { "a.txt": NPC } });
    const user = await openProject();
    const opener = screen.getByRole("tree", { name: /explorer/i });
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await user.keyboard("{Control>}p{/Control}");
    const dialog = await screen.findByRole("dialog");
    // Un clic dans une zone sans controle (le texte d'aide) sort le focus de la saisie : il reste dans le dialogue.
    await user.click(screen.getByText(/type > for commands/i));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole("combobox"));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(opener);
  });

  it("ne reprend pas le focus a l'action choisie : le fichier ouvert garde ce qu'elle a decide", async () => {
    renderApp({ files: { "npc/a.txt": NPC } });
    const user = await openProject();
    await user.keyboard("{Control>}p{/Control}");
    await user.type(await screen.findByRole("combobox"), "a.txt");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("tab", { name: /a\.txt/ })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("nomme sa liste de resultats", async () => {
    renderApp({ files: { "a.txt": NPC } });
    const user = await openProject();
    await user.keyboard("{Control>}p{/Control}");
    expect(await screen.findByRole("listbox", { name: "Results" })).toBeTruthy();
  });
});

describe("parametres : onglets nommes", () => {
  it("donne un nom a la liste d'onglets", async () => {
    renderApp({ files: { "a.txt": NPC } });
    const user = await openProject();
    await user.keyboard("{Control>},{/Control}");
    expect(await screen.findByRole("tablist", { name: "Settings" })).toBeTruthy();
  });
});
