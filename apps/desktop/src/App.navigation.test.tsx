// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./test/render-app";

const LIB = "function\tscript\tF_Lib\t{\n\treturn;\n}\n";
const CALLER = 'prontera,5,5,0\tscript\tCaller\t100,{\n\tcallfunc "F_Lib";\n\tclose;\n}\n';
const FILES = { "npc/lib.txt": LIB, "npc/caller.txt": CALLER, "readme.md": "notes\n" };

afterEach(() => {
  cleanup();
});

async function openIndexedProject() {
  const harness = renderApp({ files: FILES, withLanguage: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  await harness.controller.whenIndexed();
  return { harness, user };
}

describe("App - index du projet et navigation", () => {
  it("affiche le resultat de l'indexation dans la barre d'etat, avec le detail en info-bulle", async () => {
    await openIndexedProject();
    const indicator = await screen.findByText("2 indexed");
    expect(indicator.getAttribute("title")).toBe("2 files indexed · 1 functions · 1 NPC names");
    expect(indicator.getAttribute("data-index-status")).toBe("done");
  });

  it("cherche un symbole du projet avec Ctrl+T et ouvre sa definition", async () => {
    const { user } = await openIndexedProject();
    await user.keyboard("{Control>}t{/Control}");
    const input = await screen.findByRole("combobox");
    expect(input.getAttribute("placeholder")).toMatch(/search functions and npc names/i);
    await user.type(input, "lib");
    const option = await screen.findByRole("option", { name: /F_Lib/ });
    expect(option.textContent).toContain("npc/lib.txt");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("tab", { name: /lib\.txt/ })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("passe en recherche de symboles en tapant # dans la palette de fichiers", async () => {
    const { user } = await openIndexedProject();
    await user.keyboard("{Control>}p{/Control}");
    const input = await screen.findByRole("combobox");
    await user.type(input, "#caller");
    const option = await screen.findByRole("option", { name: /Caller/ });
    expect(option.textContent).toContain("script");
  });

  it("liste les references avec Maj+F12 dans le panneau du bas et ouvre l'une d'elles", async () => {
    const { harness, user } = await openIndexedProject();
    await harness.controller.openFile("npc/caller.txt");
    harness.controller.setCursor(2, 14); // sur « F_Lib » dans callfunc "F_Lib"
    await user.keyboard("{Shift>}{F12}{/Shift}");
    const panel = await screen.findByRole("region", { name: /^references$/i });
    await waitFor(() => expect(within(panel).getByText("2 result(s) for F_Lib")).toBeTruthy(), { timeout: 3000 });
    expect(within(panel).getByText('callfunc "F_Lib";')).toBeTruthy();
    expect(within(panel).getByText("npc/caller.txt:2:11")).toBeTruthy();
    expect(within(panel).getByText("npc/lib.txt:1:17")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /references/i }).getAttribute("aria-selected")).toBe("true");

    await user.click(within(panel).getByText("npc/lib.txt:1:17"));
    expect(await screen.findByRole("tab", { name: /lib\.txt/ })).toBeTruthy();
    expect(harness.store.getState().reveal).toMatchObject({ path: "npc/lib.txt", line: 1, column: 17 });
  });

  it("revient aux problemes quand on choisit l'onglet correspondant", async () => {
    const { harness, user } = await openIndexedProject();
    harness.controller.setBottomTab("references");
    expect(await screen.findByRole("region", { name: /^references$/i })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /problems/i }));
    expect(await screen.findByRole("region", { name: /problems/i })).toBeTruthy();
  });

  it("enregistre le reglage des verifications entre fichiers dans la configuration du projet", async () => {
    const { harness, user } = await openIndexedProject();
    harness.controller.openSettings("project");
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    await user.selectOptions(within(dialog).getByLabelText(/cross-file checks/i), "all");
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.backend.textOf(".runeforge/project.json")).toContain('"crossFile": "all"'));
    expect(harness.store.getState().project?.config.validation.crossFile).toBe("all");
  });
});
