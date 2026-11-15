// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FLOW_NODE_WIDTH } from "@runeforge/visual-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp, type AppHarness } from "../../test/render-app";
import { toCanvasPoint } from "./FlowCanvas";

/**
 * Constructeur visuel de NPC (RF-020, RF-021) : un graphe de noeuds relies par des fils, a la maniere d'un editeur de noeuds.
 * jsdom n'a ni mise en page ni capture du pointeur : les coordonnees sont celles des evenements (le canevas est a l'origine) et
 * `document.elementFromPoint` est remplace pour designer la cible d'un fil ou d'un depot.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
});

type User = ReturnType<typeof userEvent.setup>;

async function openBuilder(): Promise<{ readonly harness: AppHarness; readonly user: User; readonly dialog: HTMLElement }> {
  const harness = renderApp({ withLanguage: true, files: {} });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  await user.click(screen.getByRole("menuitem", { name: "File" }));
  await user.click(await screen.findByRole("menuitem", { name: "Create NPC with visual builder…" }));
  const dialog = await screen.findByRole("dialog", { name: "Visual NPC builder" });
  return { harness, user, dialog };
}

const canvasOf = (dialog: HTMLElement): HTMLElement => within(dialog).getByRole("group", { name: "Node canvas" });
const nodeOf = (dialog: HTMLElement, name: string): HTMLElement => within(canvasOf(dialog)).getByRole("article", { name });
const inputOf = (dialog: HTMLElement, node: string): HTMLElement => within(dialog).getByRole("button", { name: new RegExp(`^Input of ${node}\\b`) });
const outputOf = (dialog: HTMLElement, node: string, port: string): HTMLElement => within(dialog).getByRole("button", { name: new RegExp(`^${port} output of ${node}:`) });
const preview = (dialog: HTMLElement): string => dialog.querySelector(".visual-builder-preview")?.textContent ?? "";
const nodeNames = (dialog: HTMLElement): string[] => [...canvasOf(dialog).querySelectorAll("article")].map((node) => node.getAttribute("aria-label") ?? "");
const wires = (dialog: HTMLElement): string[] => [...canvasOf(dialog).querySelectorAll("path[data-wire]")].map((path) => path.getAttribute("data-wire") ?? "");
const status = (dialog: HTMLElement): string => within(dialog).getAllByRole("status").map((element) => element.textContent ?? "").join(" | ");
const left = (node: HTMLElement): number => Number.parseFloat(node.style.left);
const top = (node: HTMLElement): number => Number.parseFloat(node.style.top);

/** `document.elementFromPoint` designe `element` pour tous les points (jsdom ne le fournit pas). */
function pointAt(element: Element | null): void {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => element });
}

async function search(dialog: HTMLElement, user: User, text: string): Promise<void> {
  const box = within(dialog).getByRole("searchbox", { name: "Search commands" });
  await user.clear(box);
  await user.type(box, text);
}

/** Tire un fil de la sortie `from` jusqu'a l'element `target`, avec les evenements du pointeur. */
function drag(from: HTMLElement, target: Element, to: { x: number; y: number } = { x: 300, y: 200 }): void {
  pointAt(target);
  fireEvent.pointerDown(from, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(from, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(from, { pointerId: 1, clientX: to.x, clientY: to.y });
}

describe("constructeur visuel de NPC : le graphe de depart", () => {
  it("part d'un noeud de depart relie a un message puis a un close, avec le script correspondant", async () => {
    const { dialog } = await openBuilder();
    expect(within(dialog).getByText("rAthena scripting library")).toBeTruthy();
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2"]);
    expect(wires(dialog)).toEqual(["start:next", "command-1:next"]);
    expect(preview(dialog)).toContain('\tmes "Welcome to my NPC!";');
    expect(preview(dialog)).toContain("\tclose;");
    expect(outputOf(dialog, "Start", "Next").getAttribute("aria-label")).toBe("Next output of Start: connected to mes 1");
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-label")).toBe("Next output of mes 1: connected to close 2");
    expect(within(nodeOf(dialog, "close 2")).queryByRole("button", { name: /output of close 2/ })).toBeNull();
    expect(inputOf(dialog, "close 2").getAttribute("aria-label")).toBe("Input of close 2: 1 wire(s) connected");
    expect(within(nodeOf(dialog, "Start")).queryByRole("button", { name: /^Input of/ })).toBeNull();
    expect(within(nodeOf(dialog, "Start")).getByText("Start: New NPC")).toBeTruthy();
  });

  it("place les prises a l'endroit ou finissent les fils : le bord du noeud, a la hauteur de leur ligne", async () => {
    const { dialog } = await openBuilder();
    const start = nodeOf(dialog, "Start");
    const message = nodeOf(dialog, "mes 1");
    const path = canvasOf(dialog).querySelector('path[data-wire="start:next"]')?.getAttribute("d") ?? "";
    // Du bord droit du depart (x + largeur, y + 32 + 14) au bord gauche du message (x, y + 32 + 14).
    const from = { x: left(start) + FLOW_NODE_WIDTH, y: top(start) + 32 + 14 };
    const to = { x: left(message), y: top(message) + 32 + 14 };
    expect(path.startsWith(`M ${from.x} ${from.y} C `)).toBe(true);
    expect(path.endsWith(`${to.x} ${to.y}`)).toBe(true);
  });
});

describe("constructeur visuel de NPC : la bibliotheque", () => {
  it("cree un fichier de NPC avec une commande ajoutee d'un clic entre le message et le close, apres validation locale", async () => {
    const { harness, user, dialog } = await openBuilder();
    await search(dialog, user, "getitem");
    await user.click(await within(dialog).findByRole("button", { name: "Add command getitem" }));
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2", "getitem 3"]);
    expect(wires(dialog).sort()).toEqual(["command-1:next", "command-3:next", "start:next"]);

    const create = within(dialog).getByRole("button", { name: "Create NPC file" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const node = nodeOf(dialog, "getitem 3");
    await user.type(within(node).getByRole("textbox", { name: "Argument 1: expression (required)" }), "501");
    await user.type(within(node).getByRole("textbox", { name: "Argument 2: integer (required)" }), "1");
    await waitFor(() => expect(create.disabled).toBe(false));
    expect(preview(dialog)).toContain(['\tmes "Welcome to my NPC!";', "\tgetitem 501, 1;", "\tclose;"].join("\n"));

    await user.click(create);
    await waitFor(() => expect(harness.buffers.get("npc/custom/new_npc.txt")?.text).toContain("\tgetitem 501, 1;"));
    expect(harness.buffers.get("npc/custom/new_npc.txt")?.text).toContain('mes "Welcome to my NPC!";');
    expect(harness.buffers.get("npc/custom/new_npc.txt")?.text).toContain("\tclose;");
    expect(harness.backend.textOf("npc/custom/new_npc.txt")).toBe("");
  });

  it("ajoute la commande suivante apres la precedente : le noeud neuf est le noeud choisi", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "mes");
    await user.click(await within(dialog).findByRole("button", { name: "Add command mes" }));
    await user.click(within(dialog).getByRole("button", { name: "Add command mes" }));
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2", "mes 3", "mes 4"]);
    expect(wires(dialog)).toHaveLength(4);
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-label")).toBe("Next output of mes 1: connected to mes 3");
    expect(outputOf(dialog, "mes 3", "Next").getAttribute("aria-label")).toBe("Next output of mes 3: connected to mes 4");
    expect(outputOf(dialog, "mes 4", "Next").getAttribute("aria-label")).toBe("Next output of mes 4: connected to close 2");
    expect(nodeOf(dialog, "mes 4").hasAttribute("data-selected")).toBe(true);
  });

  it("depose une commande de la bibliotheque a l'endroit du lacher : sans fil, donc pas encore exportable", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "mes");
    const command = await within(dialog).findByRole("button", { name: "Add command mes" });
    const canvas = canvasOf(dialog);
    pointAt(canvas);
    fireEvent.pointerDown(command, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(command, { pointerId: 1, clientX: 600, clientY: 300 });
    expect(within(dialog).getByText("Drop mes on the canvas")).toBeTruthy();
    fireEvent.pointerUp(command, { pointerId: 1, clientX: 600, clientY: 300 });
    expect(screen.queryByText("Drop mes on the canvas")).toBeNull();

    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2", "mes 3"]);
    const dropped = nodeOf(dialog, "mes 3");
    expect([left(dropped), top(dropped)]).toEqual([600 - FLOW_NODE_WIDTH / 2, 300 - 32 / 2]);
    expect(wires(dialog)).toEqual(["start:next", "command-1:next"]);
    expect(within(dialog).getByText("A node is not connected to the start, so it is not part of the script.")).toBeTruthy();
    expect(inputOf(dialog, "mes 3").getAttribute("aria-label")).toBe("Input of mes 3");
    expect((within(dialog).getByRole("button", { name: "Create NPC file" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("n'ajoute qu'un noeud par depot : le clic que le navigateur envoie apres le glisser est ignore, puis les clics redeviennent utiles", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "mes");
    const command = await within(dialog).findByRole("button", { name: "Add command mes" });
    pointAt(canvasOf(dialog));
    fireEvent.pointerDown(command, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(command, { pointerId: 1, clientX: 600, clientY: 300 });
    fireEvent.pointerUp(command, { pointerId: 1, clientX: 600, clientY: 300 });
    fireEvent.click(command);
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2", "mes 3"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fireEvent.click(command);
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2", "mes 3", "mes 4"]);
  });

  it("ne glisse qu'avec le bouton principal", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "mes");
    const command = await within(dialog).findByRole("button", { name: "Add command mes" });
    pointAt(canvasOf(dialog));
    fireEvent.pointerDown(command, { pointerId: 1, button: 2, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(command, { pointerId: 1, clientX: 600, clientY: 300 });
    expect(screen.queryByText("Drop mes on the canvas")).toBeNull();
    fireEvent.pointerUp(command, { pointerId: 1, button: 2, clientX: 600, clientY: 300 });
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2"]);
  });

  it("ne fait rien d'un lacher hors du canevas, et traite un simple appui comme un clic", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "mes");
    const command = await within(dialog).findByRole("button", { name: "Add command mes" });
    pointAt(document.body);
    fireEvent.pointerDown(command, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(command, { pointerId: 1, clientX: 600, clientY: 300 });
    fireEvent.pointerUp(command, { pointerId: 1, clientX: 600, clientY: 300 });
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2"]);
    expect(status(dialog)).toContain("Drop a command on the canvas to add it.");
    // Un appui qui ne bouge pas de plus de quelques pixels n'est pas un glisser.
    fireEvent.pointerDown(command, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(command, { pointerId: 1, clientX: 22, clientY: 21 });
    expect(screen.queryByText("Drop mes on the canvas")).toBeNull();
    fireEvent.pointerUp(command, { pointerId: 1, clientX: 22, clientY: 21 });
    expect(screen.queryByText("Drop mes on the canvas")).toBeNull();
    await user.click(command);
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2", "mes 3"]);
  });

  it("ne glisse rien qui ne soit pas dans la bibliotheque, et accepte une commande d'extension declarative", async () => {
    const { dialog, user } = await openBuilder();
    const manifest = {
      schemaVersion: 1,
      apiVersion: 1,
      id: "local.commands",
      name: "Local commands",
      permissions: [],
      commands: [{
        name: "custom_reward",
        parameterTypes: "is?",
        signatures: ["custom_reward(<item>,<amount>{,<announce>})"],
        documentation: "Awards a server-defined item.",
      }],
    };
    const file = new File([JSON.stringify(manifest)], "local-commands.json", { type: "application/json" });
    await user.upload(within(dialog).getByLabelText("Load declarative extension JSON"), file);
    await within(dialog).findByText("Loaded extension Local commands into the palette for this builder session.");
    await search(dialog, user, "custom_reward");
    await user.click(await within(dialog).findByRole("button", { name: "Add command custom_reward" }));
    expect(nodeNames(dialog)).toContain("custom_reward 3");
  });
});

describe("constructeur visuel de NPC : les fils", () => {
  it("relie une sortie a une entree en les activant l'une apres l'autre, au clavier comme a la souris", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Next of mes 1 from close 2" }));
    expect(wires(dialog)).toEqual(["start:next"]);
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-label")).toBe("Next output of mes 1: not connected");
    expect(within(dialog).getAllByText("An output is not connected: every path must end with close or end.").length).toBeGreaterThan(0);
    expect((within(dialog).getByRole("button", { name: "Create NPC file" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(outputOf(dialog, "mes 1", "Next"));
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-pressed")).toBe("true");
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-label")).toBe("Next output of mes 1: picked, now choose an input");
    expect(status(dialog)).toContain("Next output of mes 1 picked. Choose an input socket, or press Escape to cancel.");
    await user.click(inputOf(dialog, "close 2"));
    expect(wires(dialog)).toEqual(["start:next", "command-1:next"]);
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-pressed")).toBe("false");
    expect(status(dialog)).toContain("Connected Next of mes 1 to close 2.");
    expect(within(dialog).queryByText("An output is not connected: every path must end with close or end.")).toBeNull();
  });

  it("relie en tirant le fil jusqu'a une prise, ou n'importe ou sur le noeud visé, et suit le pointeur", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Next of mes 1 from close 2" }));
    const output = outputOf(dialog, "mes 1", "Next");
    pointAt(inputOf(dialog, "close 2"));
    fireEvent.pointerDown(output, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(output, { pointerId: 1, clientX: 200, clientY: 120 });
    // Le fil en cours suit le pointeur, en pointille.
    expect(canvasOf(dialog).querySelector(".flow-wire-live")?.getAttribute("d")?.endsWith("200 120")).toBe(true);
    expect(canvasOf(dialog).hasAttribute("data-connecting")).toBe(true);
    fireEvent.pointerUp(output, { pointerId: 1, clientX: 200, clientY: 120 });
    expect(canvasOf(dialog).querySelector(".flow-wire-live")).toBeNull();
    expect(canvasOf(dialog).hasAttribute("data-connecting")).toBe(false);
    expect(wires(dialog)).toEqual(["start:next", "command-1:next"]);

    // N'importe ou sur le noeud cible : son entree.
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Next of mes 1 from close 2" }));
    drag(outputOf(dialog, "mes 1", "Next"), within(nodeOf(dialog, "close 2")).getByText("In"));
    expect(wires(dialog)).toEqual(["start:next", "command-1:next"]);
  });

  it("ne tire un fil qu'avec le bouton principal, et ignore le clic qui suit un fil tire", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Next of mes 1 from close 2" }));
    const output = outputOf(dialog, "mes 1", "Next");
    pointAt(inputOf(dialog, "close 2"));
    fireEvent.pointerDown(output, { pointerId: 1, button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(output, { pointerId: 1, clientX: 200, clientY: 120 });
    expect(canvasOf(dialog).querySelector(".flow-wire-live")).toBeNull();
    fireEvent.pointerUp(output, { pointerId: 1, button: 2, clientX: 200, clientY: 120 });
    expect(wires(dialog)).toEqual(["start:next"]);

    drag(output, inputOf(dialog, "close 2"));
    expect(wires(dialog)).toEqual(["start:next", "command-1:next"]);
    // Le navigateur envoie un clic apres le relachement : il ne doit pas « prendre » la sortie ; plus tard, un clic le fait.
    fireEvent.click(output);
    expect(output.getAttribute("aria-pressed")).toBe("false");
    await new Promise((resolve) => setTimeout(resolve, 10));
    fireEvent.click(output);
    expect(output.getAttribute("aria-pressed")).toBe("true");
  });

  it("traite un appui qui bouge a peine sur une sortie comme un clic : pas de fil en cours, pas de connexion", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Next of mes 1 from close 2" }));
    const output = outputOf(dialog, "mes 1", "Next");
    pointAt(inputOf(dialog, "close 2"));
    fireEvent.pointerDown(output, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(output, { pointerId: 1, clientX: 12, clientY: 11 });
    expect(canvasOf(dialog).querySelector(".flow-wire-live")).toBeNull();
    fireEvent.pointerUp(output, { pointerId: 1, clientX: 12, clientY: 11 });
    expect(wires(dialog)).toEqual(["start:next"]);
  });

  it("convertit un point de l'ecran en point du canevas, defilement et bordure compris", () => {
    const root = { getBoundingClientRect: () => ({ left: 100, top: 50 }), clientLeft: 1, clientTop: 2, scrollLeft: 30, scrollTop: 40 } as unknown as HTMLElement;
    expect(toCanvasPoint(root, 250, 150)).toEqual({ x: 250 - 100 - 1 + 30, y: 150 - 50 - 2 + 40 });
  });

  it("n'ajoute pas un fil qui ferait une boucle, ni vers le depart ou vers soi-meme, et le dit", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "mes");
    await user.click(await within(dialog).findByRole("button", { name: "Add command mes" }));
    // start -> mes 1 -> mes 3 -> close 2 : refermer mes 3 sur mes 1 est une boucle.
    await user.click(outputOf(dialog, "mes 3", "Next"));
    await user.click(inputOf(dialog, "mes 1"));
    expect(status(dialog)).toContain("That wire would make the flow loop back on itself, so it was not added.");
    expect(outputOf(dialog, "mes 3", "Next").getAttribute("aria-label")).toBe("Next output of mes 3: connected to close 2");
    await user.click(outputOf(dialog, "mes 3", "Next"));
    await user.click(inputOf(dialog, "mes 3"));
    expect(status(dialog)).toContain("A node cannot be connected to itself.");
    drag(outputOf(dialog, "mes 3", "Next"), nodeOf(dialog, "Start"));
    expect(status(dialog)).toContain("The start node has no input.");
    expect(wires(dialog)).toHaveLength(3);
  });

  it("remplace le fil d'une sortie, et accepte plusieurs fils vers une meme entree", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Add condition" }));
    expect(nodeNames(dialog)).toEqual(["Start", "mes 1", "close 2", "Condition 3"]);
    // Les deux branches de la condition inseree rejoignent le close.
    expect(inputOf(dialog, "close 2").getAttribute("aria-label")).toBe("Input of close 2: 2 wire(s) connected");
    await user.click(outputOf(dialog, "mes 1", "Next"));
    await user.click(inputOf(dialog, "close 2"));
    expect(inputOf(dialog, "close 2").getAttribute("aria-label")).toBe("Input of close 2: 3 wire(s) connected");
    expect(wires(dialog)).toHaveLength(4);
  });

  it("annule le fil pris par Echap sans fermer le dialogue, ou en reactivant la sortie", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(outputOf(dialog, "mes 1", "Next"));
    expect(canvasOf(dialog).hasAttribute("data-connecting")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Visual NPC builder" })).not.toBeNull();
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-pressed")).toBe("false");
    expect(status(dialog)).toContain("Connection cancelled.");
    await user.click(outputOf(dialog, "mes 1", "Next"));
    await user.click(outputOf(dialog, "mes 1", "Next"));
    expect(outputOf(dialog, "mes 1", "Next").getAttribute("aria-pressed")).toBe("false");
    // Sans fil en cours, Echap ferme le dialogue comme avant.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Visual NPC builder" })).toBeNull();
  });

  it("retire le fil d'une sortie avec Suppr, et laisse la sortie suivante intacte", async () => {
    const { user, dialog } = await openBuilder();
    outputOf(dialog, "mes 1", "Next").focus();
    await user.keyboard("{Delete}");
    expect(wires(dialog)).toEqual(["start:next"]);
    expect(status(dialog)).toContain("Disconnected Next of mes 1.");
    outputOf(dialog, "Start", "Next").focus();
    await user.keyboard("{Backspace}");
    expect(wires(dialog)).toEqual([]);
  });
});

describe("constructeur visuel de NPC : les noeuds", () => {
  it("deplace un noeud en tirant son titre, et les fils le suivent", async () => {
    const { dialog } = await openBuilder();
    const message = nodeOf(dialog, "mes 1");
    const before = { left: left(message), top: top(message) };
    const pathBefore = canvasOf(dialog).querySelector('path[data-wire="command-1:next"]')?.getAttribute("d");
    const title = message.querySelector(".flow-node-header") as HTMLElement;
    fireEvent.pointerDown(title, { pointerId: 1, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 450, clientY: 180 });
    fireEvent.pointerUp(title, { pointerId: 1, clientX: 450, clientY: 180 });
    expect([left(message), top(message)]).toEqual([before.left + 50, before.top + 80]);
    expect(canvasOf(dialog).querySelector('path[data-wire="command-1:next"]')?.getAttribute("d")).not.toBe(pathBefore);
    expect(message.hasAttribute("data-selected")).toBe(true);
    // Apres le lacher, le noeud ne suit plus le pointeur.
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 900, clientY: 900 });
    expect([left(message), top(message)]).toEqual([before.left + 50, before.top + 80]);
  });

  it("ne deplace pas un noeud quand on appuie sur son bouton de suppression", async () => {
    const { dialog } = await openBuilder();
    const message = nodeOf(dialog, "mes 1");
    const before = left(message);
    const remove = within(message).getByRole("button", { name: "Remove mes 1" });
    fireEvent.pointerDown(remove, { pointerId: 1, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(remove, { pointerId: 1, clientX: 500, clientY: 100 });
    expect(left(message)).toBe(before);
  });

  it("fait foi de la position du relachement, meme quand les derniers deplacements ont ete regroupes", async () => {
    const { dialog } = await openBuilder();
    const message = nodeOf(dialog, "mes 1");
    const before = { left: left(message), top: top(message) };
    const title = message.querySelector(".flow-node-header") as HTMLElement;
    fireEvent.pointerDown(title, { pointerId: 1, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 430, clientY: 130 });
    fireEvent.pointerUp(title, { pointerId: 1, clientX: 470, clientY: 190 });
    expect([left(message), top(message)]).toEqual([before.left + 70, before.top + 90]);
  });

  it("ne deplace un noeud qu'avec le bouton principal", async () => {
    const { dialog } = await openBuilder();
    const message = nodeOf(dialog, "mes 1");
    const before = [left(message), top(message)];
    const title = message.querySelector(".flow-node-header") as HTMLElement;
    fireEvent.pointerDown(title, { pointerId: 1, button: 2, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 450, clientY: 180 });
    fireEvent.pointerUp(title, { pointerId: 1, button: 2, clientX: 450, clientY: 180 });
    expect([left(message), top(message)]).toEqual(before);
  });

  it("garde un noeud dans la zone de travail", async () => {
    const { dialog } = await openBuilder();
    const message = nodeOf(dialog, "mes 1");
    const title = message.querySelector(".flow-node-header") as HTMLElement;
    fireEvent.pointerDown(title, { pointerId: 1, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(title, { pointerId: 1, clientX: -5000, clientY: -5000 });
    expect([left(message), top(message)]).toEqual([0, 0]);
  });

  it("supprimer le noeud choisi ou la sortie prise efface la selection et le fil en cours", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(outputOf(dialog, "mes 1", "Next"));
    expect(canvasOf(dialog).hasAttribute("data-connecting")).toBe(true);
    await user.click(within(nodeOf(dialog, "mes 1")).getByRole("button", { name: "Remove mes 1" }));
    expect(canvasOf(dialog).hasAttribute("data-connecting")).toBe(false);
    expect(within(dialog).getByText("No node selected: new commands go at the end of the main flow.")).toBeTruthy();
    expect(dialog.querySelector("[data-selected]")).toBeNull();
  });

  it("supprime un noeud en refermant la chaine, et selectionne ou deselectionne au clic", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(nodeOf(dialog, "mes 1")).getByRole("button", { name: "Remove mes 1" }));
    expect(nodeNames(dialog)).toEqual(["Start", "close 1"]);
    expect(wires(dialog)).toEqual(["start:next"]);
    expect(outputOf(dialog, "Start", "Next").getAttribute("aria-label")).toBe("Next output of Start: connected to close 1");
    expect(status(dialog)).toContain("mes 1 removed.");
    expect(preview(dialog)).toContain("\tclose;");
    expect(preview(dialog)).not.toContain("mes");
    expect(within(nodeOf(dialog, "Start")).queryByRole("button", { name: /^Remove/ })).toBeNull();

    fireEvent.pointerDown(nodeOf(dialog, "close 1"), { pointerId: 1, button: 0 });
    expect(nodeOf(dialog, "close 1").hasAttribute("data-selected")).toBe(true);
    fireEvent.pointerDown(canvasOf(dialog), { pointerId: 1, button: 0 });
    expect(nodeOf(dialog, "close 1").hasAttribute("data-selected")).toBe(false);
    expect(within(dialog).getByText("No node selected: new commands go at the end of the main flow.")).toBeTruthy();
  });

  it("modifie les arguments d'un noeud, en ajoute un facultatif et le retire", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "getitem");
    await user.click(await within(dialog).findByRole("button", { name: "Add command getitem" }));
    const node = nodeOf(dialog, "getitem 3");
    expect(within(node).getAllByRole("textbox")).toHaveLength(2);
    await user.click(within(node).getByRole("button", { name: "Add argument" }));
    expect(within(node).getAllByRole("textbox")).toHaveLength(3);
    expect(within(node).queryByRole("button", { name: "Add argument" })).toBeNull();
    await user.type(within(node).getByRole("textbox", { name: "Argument 3: expression" }), "7");
    await user.click(within(node).getByRole("button", { name: "Remove last optional argument" }));
    expect(within(node).getAllByRole("textbox")).toHaveLength(2);
    expect(within(node).getByText("Command help from the offline library")).toBeTruthy();
  });

  it("signale les noeuds en cause d'un probleme de validation", async () => {
    const { user, dialog } = await openBuilder();
    await search(dialog, user, "getitem");
    await user.click(await within(dialog).findByRole("button", { name: "Add command getitem" }));
    expect(nodeOf(dialog, "getitem 3").classList.contains("flow-node-invalid")).toBe(true);
    expect(nodeOf(dialog, "mes 1").classList.contains("flow-node-invalid")).toBe(false);
    expect(within(dialog).getByText("Fill in every required argument.")).toBeTruthy();
  });

  it("range les noeuds tant qu'on n'en a place aucun, sans recouvrement : le noeud ajoute prend sa colonne", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Add condition" }));
    await search(dialog, user, "getitem");
    await user.click(await within(dialog).findByRole("button", { name: "Add command getitem" }));
    // Depart, message, condition, getitem (branche « then »), close : une colonne par distance au depart.
    const columns = ["Start", "mes 1", "Condition 3", "getitem 4", "close 2"].map((name) => left(nodeOf(dialog, name)));
    expect(columns).toEqual([...columns].sort((a, b) => a - b));
    expect(new Set(columns).size).toBe(5);
    // Deux noeuds d'une meme colonne ne se recouvrent pas.
    const boxes = [...canvasOf(dialog).querySelectorAll("article")].map((article) => ({ x: left(article as HTMLElement), y: top(article as HTMLElement) }));
    for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) if (a.x === b.x) expect(Math.abs(a.y - b.y)).toBeGreaterThan(100);
  });

  it("ne range plus des qu'un noeud a ete deplace a la main, jusqu'a « Ranger le canevas »", async () => {
    const { user, dialog } = await openBuilder();
    const title = nodeOf(dialog, "mes 1").querySelector(".flow-node-header") as HTMLElement;
    fireEvent.pointerDown(title, { pointerId: 1, button: 0, clientX: 400, clientY: 100 });
    fireEvent.pointerUp(title, { pointerId: 1, clientX: 500, clientY: 300 });
    const placed = [left(nodeOf(dialog, "mes 1")), top(nodeOf(dialog, "mes 1"))];
    await user.click(within(dialog).getByRole("button", { name: "Add condition" }));
    expect([left(nodeOf(dialog, "mes 1")), top(nodeOf(dialog, "mes 1"))]).toEqual(placed);
    await user.click(within(dialog).getByRole("button", { name: "Tidy layout" }));
    expect(left(nodeOf(dialog, "mes 1"))).not.toBe(placed[0]);
    // Range de nouveau : un ajout reorganise les colonnes.
    const closeBefore = left(nodeOf(dialog, "close 2"));
    await user.click(within(dialog).getByRole("button", { name: "Add condition" }));
    expect(left(nodeOf(dialog, "close 2"))).toBeGreaterThan(closeBefore);
  });

  it("range le canevas en colonnes apres des deplacements", async () => {
    const { user, dialog } = await openBuilder();
    const original = ["Start", "mes 1", "close 2"].map((name) => [left(nodeOf(dialog, name)), top(nodeOf(dialog, name))]);
    const title = nodeOf(dialog, "close 2").querySelector(".flow-node-header") as HTMLElement;
    fireEvent.pointerDown(title, { pointerId: 1, button: 0, clientX: 600, clientY: 100 });
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 100, clientY: 400 });
    fireEvent.pointerUp(title, { pointerId: 1, clientX: 100, clientY: 400 });
    expect([left(nodeOf(dialog, "close 2")), top(nodeOf(dialog, "close 2"))]).not.toEqual(original[2]);
    await user.click(within(dialog).getByRole("button", { name: "Tidy layout" }));
    expect(["Start", "mes 1", "close 2"].map((name) => [left(nodeOf(dialog, name)), top(nodeOf(dialog, name))])).toEqual(original);
  });
});

describe("constructeur visuel de NPC : les conditions", () => {
  it("construit un if/else dont les deux branches rejoignent la suite, en ajoutant chaque commande a la sortie choisie", async () => {
    const { harness, user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Add condition" }));
    const condition = within(nodeOf(dialog, "Condition 3")).getByRole("textbox", { name: "Condition expression" });
    await user.clear(condition);
    await user.type(condition, "BaseLevel > 10");
    // Des branches vides qui se rejoignent : un if sans corps.
    expect(preview(dialog)).toContain(["\tif (BaseLevel > 10) {", "\t}", "\tclose;"].join("\n"));

    // Le noeud choisi est la condition : la commande va dans la branche « Then », puis dans « Otherwise ».
    await search(dialog, user, "mes");
    expect((within(dialog).getByRole("combobox", { name: "Add after output" }) as HTMLSelectElement).value).toBe("then");
    await user.click(await within(dialog).findByRole("button", { name: "Add command mes" }));
    await user.type(within(nodeOf(dialog, "mes 4")).getByRole("textbox", { name: "Argument 1: text (required)" }), "Welcome");

    fireEvent.pointerDown(nodeOf(dialog, "Condition 3"), { pointerId: 1, button: 0 });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Add after output" }), "else");
    await user.click(within(dialog).getByRole("button", { name: "Add command mes" }));
    await user.type(within(nodeOf(dialog, "mes 5")).getByRole("textbox", { name: "Argument 1: text (required)" }), "Train more");

    expect(preview(dialog)).toContain(
      [
        '\tmes "Welcome to my NPC!";',
        "\tif (BaseLevel > 10) {",
        '\t\tmes "Welcome";',
        "\t} else {",
        '\t\tmes "Train more";',
        "\t}",
        "\tclose;",
      ].join("\n"),
    );
    expect(outputOf(dialog, "Condition 3", "Then").getAttribute("aria-label")).toBe("Then output of Condition 3: connected to mes 4");
    expect(outputOf(dialog, "Condition 3", "Otherwise").getAttribute("aria-label")).toBe("Otherwise output of Condition 3: connected to mes 5");

    const create = within(dialog).getByRole("button", { name: "Create NPC file" }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    await user.click(create);
    await waitFor(() => expect(harness.buffers.get("npc/custom/new_npc.txt")?.text).toContain("\tif (BaseLevel > 10) {"));
    expect(harness.buffers.get("npc/custom/new_npc.txt")?.text).toContain('\t\tmes "Train more";');
    expect(harness.backend.textOf("npc/custom/new_npc.txt")).toBe("");
  });

  it("accepte un if dont chaque branche finit par close, sans rien apres", async () => {
    const { user, dialog } = await openBuilder();
    await user.click(within(dialog).getByRole("button", { name: "Add condition" }));
    // La condition est inseree avant le close ; chaque branche va a un close different.
    await search(dialog, user, "close");
    await user.click(await within(dialog).findByRole("button", { name: "Add command close" }));
    expect(nodeNames(dialog)).toContain("close 4");
    // Le fil de « Then » passe au nouveau close : « Otherwise » reste vers le premier.
    expect(outputOf(dialog, "Condition 3", "Then").getAttribute("aria-label")).toBe("Then output of Condition 3: connected to close 4");
    // Chaque branche finit par close, rien ne suit le if : le script est complet.
    expect(preview(dialog)).toContain(["\tif (1) {", "\t\tclose;", "\t} else {", "\t\tclose;", "\t}"].join("\n"));
    expect(within(dialog).queryByText("An output is not connected: every path must end with close or end.")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Create NPC file" }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("constructeur visuel de NPC : disponibilite", () => {
  it("n'est pas propose sans projet ouvert", async () => {
    const harness = renderApp({ withLanguage: true, files: {} });
    await screen.findByRole("button", { name: /open a project folder/i });
    expect(harness.controller.openVisualBuilder()).toBe(false);
    expect(harness.store.getState().dialog).toBeNull();
  });
});
