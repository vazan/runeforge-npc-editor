// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "../../test/render-app";

afterEach(() => {
  cleanup();
});

type User = ReturnType<typeof userEvent.setup>;

/** Ouvre le dialogue de simulation sur le premier NPC d'un fichier du projet ; `others` : les autres fichiers du projet. */
async function openSimulation(source: string, others: Record<string, string> = {}): Promise<{ readonly user: User; readonly dialog: HTMLElement }> {
  const harness = renderApp({ withLanguage: true, files: { "npc/custom/example.txt": source, ...others } });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  await harness.controller.whenIndexed();
  await harness.controller.openFile("npc/custom/example.txt");
  harness.controller.openSimulation();
  const dialog = await screen.findByRole("dialog", { name: "NPC dialogue simulation" });
  return { user, dialog };
}

const npc = (...body: string[]): string => `-\tscript\tErrende\t-1,{\n${body.map((line) => `\t${line}`).join("\n")}\n}\n`;
const start = async (user: User, dialog: HTMLElement): Promise<HTMLElement> => {
  await user.click(within(dialog).getByRole("button", { name: /^(Start|Restart) simulation$/ }));
  return within(dialog).findByRole("log", { name: "Dialogue transcript" });
};
/** Ouvre la section avancée, puis remplace le contenu d'un champ JSON (les accolades gênent `user.type`). */
async function setJson(user: User, dialog: HTMLElement, name: string, value: string): Promise<void> {
  const summary = within(dialog).getByText("Variables, inventory, quests and assumptions");
  if (summary.closest("details")?.open !== true) await user.click(summary);
  fireEvent.change(within(dialog).getByRole("textbox", { name }), { target: { value } });
}

describe("fenêtre de simulation de dialogue", () => {
  it("joue un NPC qui lit des variables permanentes, saute les effets serveur et attend les réponses du joueur", async () => {
    const { user, dialog } = await openSimulation(npc(
      "if (bard_q > 5) set gef_bard_q,bard_q;",
      'cutin "bard_eland02",2;',
      'mes "[Errende]";',
      'mes "Hello ^FF0000" + strcharinfo(0) + "^000000, level " + BaseLevel;',
      "next;",
      'switch (select("Story:Song")) {',
      'case 1: mes "A story."; break;',
      'case 2: mes "A song."; break;',
      "}",
      "input .@n, 1, 10;",
      'mes "You typed " + .@n + " and the quest is " + checkquest(5001);',
      "close2;",
      'mes "after close2";',
      "close;",
    ));
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Base level" }), { target: { value: "42" } });
    const log = await start(user, dialog);

    // Le rapport d'origine : `bard_q` (variable permanente jamais écrite) ne doit plus arrêter la simulation.
    expect(log.textContent).toContain("Not simulated: cutin");
    expect(log.textContent).toContain('cutin "bard_eland02",2;');
    expect(log.textContent).toContain("Hello Player, level 42");
    expect(within(dialog).queryByRole("alert")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Next page" }));
    expect(within(dialog).getByRole("group", { name: "Choose an option" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Song" }));
    expect(log.textContent).toContain("Player: Song");
    expect(log.textContent).toContain("A song.");
    expect(log.textContent).not.toContain("A story.");

    await user.type(within(dialog).getByRole("spinbutton", { name: "Enter a number (1 to 10)" }), "5");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(log.textContent).toContain("Player: 5");
    expect(log.textContent).toContain("You typed 5 and the quest is -1");

    // close2 : le dialogue se ferme, le script continue.
    expect(log.textContent).not.toContain("after close2");
    await user.click(within(dialog).getByRole("button", { name: "Close the dialogue window" }));
    expect(log.textContent).toContain("after close2");
    expect(within(dialog).getByRole("status").textContent).toBe("The NPC closed the dialogue.");
  });

  it("amorce les variables de toute portée depuis le contexte et refuse un contexte mal formé", async () => {
    const { user, dialog } = await openSimulation(npc(
      'mes "quest " + bard_q + " weight " + Weight + " account " + #visits;',
      "if (bard_q > 5) set gef_bard_q, bard_q;",
      "close;",
    ));
    await setJson(user, dialog, "Variables", '{"bard_q": 7, "weight": 1500, "#visits": 3}');
    const log = await start(user, dialog);
    expect(log.textContent).toContain("quest 7 weight 1500 account 3");
    expect(dialog.textContent).toContain('"gef_bard_q": 7');

    await setJson(user, dialog, "Variables", "not json");
    await user.click(within(dialog).getByRole("button", { name: "Restart simulation" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Check the test values and JSON objects.");
  });

  it("résout les constantes du serveur et laisse le test imposer le résultat d'une fonction non simulée", async () => {
    const { user, dialog } = await openSimulation(npc(
      'if (Class == Job_Knight) mes "knight"; else mes "other";',
      'if (somecustomfn(3) == 5) mes "five"; else mes "zero";',
      "close;",
    ));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Class" }), "Knight");
    let log = await start(user, dialog);
    expect(log.textContent).toContain("knight");
    expect(log.textContent).toContain("zero");
    expect(log.textContent).toContain("Assumed result: somecustomfn(3) → 0");

    await setJson(user, dialog, "Assumed function results", '{"somecustomfn": 5}');
    log = await start(user, dialog);
    expect(log.textContent).toContain("five");
    expect(log.textContent).toContain("Assumed result: somecustomfn(3) → 5");
  });

  it("choisit la classe du personnage par son vrai nom, celui du serveur, et non par un identifiant", async () => {
    const { user, dialog } = await openSimulation(npc(
      'mes "Class " + Class;',
      'if (Class == Job_Rune_Knight) mes "rune knight";',
      "close;",
    ));
    const select = within(dialog).getByRole("combobox", { name: "Class" }) as HTMLSelectElement;
    expect(within(dialog).queryByRole("spinbutton", { name: /class/i })).toBeNull();
    const names = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(names.slice(0, 8)).toEqual(["Novice", "Swordsman", "Magician", "Archer", "Acolyte", "Merchant", "Thief", "Knight"]);
    expect(names).toContain("Rune Knight");
    expect(names).toContain("Dragon Knight");
    // Novice par défaut ; le nom choisi donne l'identifiant que le script lit dans `Class`.
    expect(select.selectedOptions[0]?.textContent).toBe("Novice");
    await user.selectOptions(select, "Rune Knight");
    const log = await start(user, dialog);
    expect(log.textContent).toContain("Class 4054");
    expect(log.textContent).toContain("rune knight");
  });

  it("garde le focus dans le dialogue quand le bouton activé disparaît, pour que Échap le ferme encore", async () => {
    const { user, dialog } = await openSimulation(npc('mes "one";', "next;", 'mes "two";', "close;"));
    await start(user, dialog);
    const next = within(dialog).getByRole("button", { name: "Next page" });
    expect(document.activeElement).toBe(next);
    await user.click(next);
    // Plus aucun bouton d'attente : le focus reste dans le dialogue (zone de réponse), jamais sur la page.
    expect(within(dialog).queryByRole("button", { name: "Next page" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "NPC dialogue simulation" })).toBeNull();
  });

  it("note une opération que le serveur refuserait et continue le dialogue, sans alerte", async () => {
    const { user, dialog } = await openSimulation(npc('mes "before";', "mes 10 / 0;", 'mes "after";', "close;"));
    const log = await start(user, dialog);
    expect(log.textContent).toContain("before");
    expect(log.textContent).toContain("after");
    expect(log.textContent).toContain("Invalid operation (division by zero): 10 / 0 — the server would stop the script here; the simulation continues with a default value.");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("status").textContent).toBe("The NPC closed the dialogue.");
  });

  it("joue un NPC qui a une erreur de syntaxe, en le signalant au lieu de le refuser", async () => {
    const { user, dialog } = await openSimulation(npc('mes "one";', ".@x = ;", 'mes "two";', "close;"));
    expect(within(dialog).getByRole("status").textContent).toContain("Syntax problems in this NPC: 1.");
    const log = await start(user, dialog);
    expect(log.textContent).toContain("one");
    expect(log.textContent).toContain("two");
    expect(log.textContent).toContain("Not simulated:");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("joue un NPC dont le corps n'est jamais fermé jusqu'à sa dernière instruction", async () => {
    const { user, dialog } = await openSimulation('-\tscript\tErrende\t-1,{\n\tmes "a";\n\tmes "b";\n');
    expect(within(dialog).getByRole("status").textContent).toContain("Syntax problems in this NPC: 2.");
    const log = await start(user, dialog);
    expect(log.textContent).toContain("a");
    expect(log.textContent).toContain("b");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("exécute une fonction définie dans un autre fichier du projet et cite le texte de ce fichier", async () => {
    const { user, dialog } = await openSimulation(
      npc('mes "Calling";', 'callfunc "F_Elsewhere", "arg";', 'mes "Back";', "close;"),
      { "npc/custom/library.txt": 'function\tscript\tF_Elsewhere\t{\n\tmes "From the library: " + getarg(0);\n\tcutin "lib_image", 2;\n\treturn;\n}\n' },
    );
    const log = await start(user, dialog);
    expect(log.textContent).toContain("From the library: arg");
    expect(log.textContent).toContain('Not simulated: cutin "lib_image", 2;');
    expect(log.textContent).toContain("Back");
    expect(log.textContent).not.toContain("callfunc");
  });

  it("interrompt une boucle sans fin par un message calme qui cite l'instruction atteinte, sans alerte", async () => {
    const { user, dialog } = await openSimulation(npc("while (1) { .@i++; }"));
    await start(user, dialog);
    const status = await within(dialog).findByText(/The simulation was stopped to protect the application: too many instructions executed \(endless loop\?\), at “/);
    expect(status.getAttribute("role")).toBe("status");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });
});
