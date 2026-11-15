// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./test/render-app";

const fn = (name: string): string => `function\tscript\t${name}\t{\n\treturn;\n}\n`;
const npc = (body: string, name: string): string => `prontera,5,5,0\tscript\t${name}\t100,{\n${body}\n}\n`;

// Quatre fichiers : une erreur (label inconnu), deux avertissements (nom de NPC en double), une information (fonction introuvable).
const FILES = {
  ".runeforge/project.json": JSON.stringify({ schemaVersion: 1, projectName: "P", validation: { crossFile: "all" } }),
  "npc/ok.txt": fn("F_Ok"),
  "npc/bad.txt": npc("goto L_Nope;\nclose;", "Bad"),
  "npc/lib.txt": fn("F_Lib") + npc("close;", "Twin"),
  "npc/twin.txt": npc('callfunc "F_Missing";\nclose;', "Twin"),
};

afterEach(() => {
  cleanup();
});

async function openReport(files: Record<string, string> = FILES) {
  const harness = renderApp({ files, withLanguage: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  await harness.controller.whenIndexed();
  harness.controller.showProjectReport();
  const panel = await screen.findByRole("region", { name: "Project report" });
  await waitFor(() => expect(harness.store.getState().projectReport?.status).toBe("ready"));
  return { harness, user, panel };
}

/** Les boutons qui plient et deplient un fichier du rapport (les seuls a porter `aria-expanded`). */
function toggles(panel: HTMLElement): HTMLElement[] {
  return within(panel)
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-expanded"));
}

function toggleOf(panel: HTMLElement, path: string): HTMLElement {
  const found = toggles(panel).find((button) => button.querySelector(".report-file-path")?.textContent === path);
  if (found === undefined) throw new Error(`fichier absent du rapport : ${path}`);
  return found;
}

function paths(panel: HTMLElement): (string | null | undefined)[] {
  return toggles(panel).map((button) => button.querySelector(".report-file-path")?.textContent);
}

describe("App - rapport de projet", () => {
  it("affiche les totaux, puis les fichiers qui ont des problemes, les plus graves d'abord, avec leurs problemes", async () => {
    const { panel } = await openReport();
    expect(within(panel).getByText("1 error(s) · 2 warning(s) · 1 notice(s)")).toBeTruthy();
    expect(within(panel).getByText(/4 file\(s\) examined · 3 with problems/)).toBeTruthy();
    expect(paths(panel)).toEqual(["npc/bad.txt", "npc/twin.txt", "npc/lib.txt"]);
    expect(within(panel).getByText("Label 'L_Nope' is not defined in this script.")).toBeTruthy();
    expect(within(panel).getByText("npc/bad.txt:2:6", { exact: false })).toBeTruthy();
    expect(within(panel).queryByText("npc/ok.txt")).toBeNull();
    expect(screen.getByRole("tab", { name: "Project report" }).getAttribute("aria-selected")).toBe("true");
  });

  it("plie et deplie un fichier", async () => {
    const { user, panel } = await openReport();
    await user.click(toggleOf(panel, "npc/bad.txt"));
    expect(within(panel).queryByText("Label 'L_Nope' is not defined in this script.")).toBeNull();
    expect(toggleOf(panel, "npc/bad.txt").getAttribute("aria-expanded")).toBe("false");
    await user.click(toggleOf(panel, "npc/bad.txt"));
    expect(within(panel).getByText("Label 'L_Nope' is not defined in this script.")).toBeTruthy();
  });

  it("filtre par gravite, par code et par chemin", async () => {
    const { user, panel } = await openReport();

    await user.click(within(panel).getByRole("checkbox", { name: /warning/ }));
    await user.click(within(panel).getByRole("checkbox", { name: /notice/ }));
    expect(paths(panel)).toEqual(["npc/bad.txt"]);

    await user.click(within(panel).getByRole("checkbox", { name: /error/ }));
    expect(within(panel).getByText("No problem matches these filters.")).toBeTruthy();
    await user.click(within(panel).getByRole("checkbox", { name: /error/ }));
    await user.click(within(panel).getByRole("checkbox", { name: /warning/ }));
    await user.click(within(panel).getByRole("checkbox", { name: /notice/ }));

    await user.selectOptions(within(panel).getByLabelText("Code"), "RA0005");
    expect(paths(panel)).toEqual(["npc/twin.txt", "npc/lib.txt"]);
    // Le compteur d'un fichier suit le filtre : twin.txt a un avertissement et une information, seul l'avertissement reste.
    expect(toggleOf(panel, "npc/twin.txt").textContent).toContain("1 warning(s)");
    expect(toggleOf(panel, "npc/twin.txt").textContent).not.toContain("notice");
    await user.selectOptions(within(panel).getByLabelText("Code"), "");

    await user.type(within(panel).getByLabelText("Filter files"), "LIB");
    expect(paths(panel)).toEqual(["npc/lib.txt"]);
  });

  it("ouvre le fichier du probleme a sa position, meme s'il n'etait pas ouvert", async () => {
    const { harness, user, panel } = await openReport();
    expect(harness.store.getState().tabs).toEqual([]);
    await user.click(within(panel).getByText("Label 'L_Nope' is not defined in this script."));
    expect(await screen.findByRole("tab", { name: /bad\.txt/ })).toBeTruthy();
    expect(harness.store.getState().reveal).toMatchObject({ path: "npc/bad.txt", line: 2, column: 6 });
  });

  it("copie le rapport dans le presse-papiers", async () => {
    const { user, panel } = await openReport();
    await user.click(within(panel).getByRole("button", { name: "Copy report" }));
    expect(await screen.findByText("Project report copied to the clipboard.")).toBeTruthy();
    const text = await navigator.clipboard.readText();
    expect(text).toContain("# Project report: ");
    expect(text).toContain("### npc/bad.txt — 1 error(s)");
    expect(text).toContain("- 2:6 · error · RA0002");
  });

  it("dit que le rapport est perime quand un fichier ouvert change, puis le met a jour tout seul", async () => {
    const { harness, user, panel } = await openReport();
    await harness.controller.openFile("npc/ok.txt");
    // Le panneau du bas reste sur le rapport : l'onglet actif ne change pas a l'ouverture d'un fichier.
    expect(screen.getByRole("tab", { name: "Project report" }).getAttribute("aria-selected")).toBe("true");
    await user.type(await screen.findByLabelText("editor:npc/ok.txt"), " ");
    harness.buffers.get("npc/ok.txt")!.text = fn("F_Ok") + npc("goto L_Neuf;\nclose;", "Neuf");
    harness.controller.notifyEdited("npc/ok.txt");
    await waitFor(() => expect(within(panel).getByText("The project changed since this report was computed.")).toBeTruthy(), { timeout: 3000 });
    await waitFor(() => expect(within(panel).queryByText("The project changed since this report was computed.")).toBeNull(), { timeout: 4000 });
    expect(within(panel).getByText("2 error(s) · 2 warning(s) · 1 notice(s)")).toBeTruthy();
    expect(paths(panel)).toContain("npc/ok.txt");
  });

  it("s'ouvre avec Ctrl+Maj+M et se ferme avec le panneau", async () => {
    const harness = renderApp({ files: FILES, withLanguage: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
    await screen.findByRole("tree");
    await harness.controller.whenIndexed();
    await user.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
    expect(await screen.findByRole("region", { name: "Project report" })).toBeTruthy();
    expect(harness.store.getState()).toMatchObject({ bottomVisible: true, bottomTab: "report" });
  });

  it("s'ouvre depuis le panneau des problemes, qui ne montre que les fichiers ouverts", async () => {
    const harness = renderApp({ files: FILES, withLanguage: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
    await screen.findByRole("tree");
    await harness.controller.whenIndexed();
    harness.controller.setBottomTab("problems");
    const problems = await screen.findByRole("region", { name: "Problems" });
    expect(within(problems).getByText("No problem detected in open files.")).toBeTruthy();
    await user.click(within(problems).getByRole("button", { name: "Project report" }));
    const panel = await screen.findByRole("region", { name: "Project report" });
    await waitFor(() => expect(harness.store.getState().projectReport?.status).toBe("ready"));
    expect(paths(panel)).toEqual(["npc/bad.txt", "npc/twin.txt", "npc/lib.txt"]);
  });

  it("dit qu'aucun probleme n'a ete trouve quand tous les fichiers sont propres", async () => {
    const { panel } = await openReport({ "npc/ok.txt": fn("F_Ok"), "npc/also.txt": npc("close;", "Also") });
    expect(within(panel).getByText("No problem found in the 2 file(s) examined.")).toBeTruthy();
    expect(toggles(panel)).toEqual([]);
  });
});

describe("App - rapport de projet : seulement ce que le serveur charge", () => {
  // Portee d'index par defaut (`sources`) : la documentation et un script que la liste ne cite pas sont indexes comme les autres.
  const FILES_WITH_SERVER = {
    "src/config/renewal.hpp": "#define RENEWAL\n",
    "conf/map_athena.conf": "import: conf/import/map_conf.txt\n",
    "conf/import/map_conf.txt": "",
    "npc/re/scripts_main.conf": "npc: npc/re/a.txt\n",
    "npc/re/a.txt": npc("goto L_Charge;\nclose;", "A"),
    "npc/re/unlisted.txt": npc("goto L_Absent;\nclose;", "U"),
    "doc/manual.txt": "Une ligne de prose sans tabulation\nune autre ligne\n",
  };

  it("masque par defaut les fichiers que le serveur ne charge pas, le dit, et les montre sur demande", async () => {
    const { user, panel } = await openReport(FILES_WITH_SERVER);
    const filter = within(panel).getByRole("checkbox", { name: "Only scripts loaded by the server" }) as HTMLInputElement;
    expect(filter.checked).toBe(true);
    expect(within(panel).getByText(/2 file\(s\) with \d+ problem\(s\) are hidden: the server never loads them/)).toBeTruthy();
    // Le conseil (changer la portee de l'index) est l'info-bulle du bouton qui ouvre les parametres du projet.
    expect(within(panel).getByRole("button", { name: "Project settings" }).getAttribute("title")).toMatch(/To leave them out of the whole project analysis, including the duplicate-name alerts they cause/);
    expect(paths(panel)).toEqual(["npc/re/a.txt"]);
    expect(within(panel).getByText("1 error(s) · 0 warning(s) · 0 notice(s)")).toBeTruthy();
    expect(within(panel).getByText(/1 file\(s\) examined · 1 with problems/)).toBeTruthy();

    await user.click(filter);
    expect(filter.checked).toBe(false);
    // Le rapport est recalcule pour tous les fichiers indexes.
    await waitFor(() => expect(paths(panel)).toHaveLength(3));
    expect(paths(panel)).toEqual(expect.arrayContaining(["npc/re/a.txt", "npc/re/unlisted.txt", "doc/manual.txt"]));
    expect(within(panel).getByText(/3 indexed file\(s\) are not loaded by the server/)).toBeTruthy();
    expect(within(panel).queryByText(/are hidden/)).toBeNull();
  });

  it("ne laisse pas un code qui a disparu du rapport vider la liste", async () => {
    const { user, panel } = await openReport(FILES_WITH_SERVER);
    const filter = within(panel).getByRole("checkbox", { name: "Only scripts loaded by the server" });
    await user.click(filter); // tout montrer
    await waitFor(() => expect(paths(panel)).toHaveLength(3));
    await user.selectOptions(within(panel).getByLabelText("Code"), "RS0030");
    expect(paths(panel)).toEqual(["doc/manual.txt"]);
    await user.click(filter); // de nouveau seulement les scripts charges : RS0030 n'existe plus dans ce rapport
    await waitFor(() => expect(paths(panel)).toEqual(["npc/re/a.txt"]));
    expect((within(panel).getByLabelText("Code") as HTMLSelectElement).value).toBe("");
    expect(within(panel).queryByText("No problem matches these filters.")).toBeNull();
  });

  it("ouvre les parametres du projet pour changer la portee de l'index", async () => {
    const { user, panel } = await openReport(FILES_WITH_SERVER);
    await user.click(within(panel).getByRole("button", { name: "Project settings" }));
    expect(await screen.findByRole("dialog", { name: /settings/i })).toBeTruthy();
  });

  it("ne propose rien quand tout ce qui est indexe est charge ou qu'il n'y a pas de serveur", async () => {
    const { panel } = await openReport();
    expect(within(panel).queryByRole("checkbox", { name: "Only scripts loaded by the server" })).toBeNull();
    expect(within(panel).queryByText(/Project settings/)).toBeNull();
  });
});

describe("App - rapport de projet : listes de scripts du serveur", () => {
  const SERVER = {
    ".runeforge/project.json": JSON.stringify({ schemaVersion: 1, projectName: "P", emulator: { family: "rathena", indexScope: "loaded" } }),
    "src/config/renewal.hpp": "#define RENEWAL\n",
    "conf/map_athena.conf": "import: conf/import/map_conf.txt\n",
    "conf/import/map_conf.txt": "",
    "npc/re/scripts_main.conf": "// liste\nnpc: npc/re/a.txt\nnpc: npc/re/absent.txt\n",
    "npc/re/a.txt": npc("close;", "A"),
  };

  it("liste ce que le serveur ne trouverait pas, et ouvre la liste a la bonne ligne", async () => {
    const { harness, user, panel } = await openReport(SERVER);
    expect(within(panel).getByRole("heading", { name: "Server script lists" })).toBeTruthy();
    expect(within(panel).getByText("1 problem(s) in the server's script lists (scripts_*.conf)")).toBeTruthy();
    const issue = within(panel).getByRole("button", { name: /npc\/re\/absent\.txt is listed but the file does not exist/ });
    expect(issue.textContent).toContain("npc/re/scripts_main.conf:3");
    await user.click(issue);
    expect(await screen.findByRole("tab", { name: /scripts_main\.conf/ })).toBeTruthy();
    expect(harness.store.getState().reveal).toMatchObject({ path: "npc/re/scripts_main.conf", line: 3, column: 1 });
  });
});
