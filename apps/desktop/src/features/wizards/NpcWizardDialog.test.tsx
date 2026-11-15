// @vitest-environment jsdom
import { initialValues, runWizard, type WizardId } from "@runeforge/npc-templates";
import type { ParseDiagnostic } from "@runeforge/runescript-core";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../app/commands";
import { createAppStore } from "../../state/store";
import { renderApp, type AppHarness } from "../../test/render-app";

/**
 * Assistant de NPC (RF-017) dans l'application complete : menu Fichier, formulaire, script produit en direct, verification locale
 * (le vrai service de langage, execute en processus) et les trois sorties (copier, ajouter au fichier ouvert, creer un fichier).
 */
const NPC = 'prontera,150,150,4\tscript\tTest\t100,{\n\tmes "Bonjour";\n\tclose;\n}\n';
const FILES = { "npc/a.txt": NPC, "b.txt": "// b\n" };

function script(id: WizardId, overrides: Record<string, string> = {}): string {
  const result = runWizard(id, { ...initialValues(id), ...overrides });
  if (result.source === null) throw new Error("saisie invalide");
  return result.source;
}

/** Un diagnostic pour les doublures du service de langage. */
function diagnostic(fields: Pick<ParseDiagnostic, "code" | "message" | "severity"> & Partial<ParseDiagnostic>): ParseDiagnostic {
  return { category: "semantic-error", confidence: "probable", source: "analyzer", range: { start: 0, end: 1 }, ...fields };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

async function openProject(options: Parameters<typeof renderApp>[0] = {}): Promise<{ h: AppHarness; user: User }> {
  const h = renderApp({ withLanguage: true, files: FILES, ...options });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder|ouvrir un dossier/i }));
  await screen.findByRole("tree");
  return { h, user };
}

async function openWizard(user: User, names: { menu: string; item: RegExp; dialog: string } = { menu: "File", item: /NPC wizard/, dialog: "NPC wizard" }): Promise<HTMLElement> {
  await user.click(screen.getByRole("menuitem", { name: names.menu }));
  await user.click(await screen.findByRole("menuitem", { name: names.item }));
  return screen.findByRole("dialog", { name: names.dialog });
}

const preview = (dialog: HTMLElement): string => within(dialog).getByRole("region", { name: "Generated script preview" }).textContent ?? "";

/** Remplace le contenu d'un champ (un vrai utilisateur selectionne tout, puis tape). */
async function fill(user: User, field: HTMLElement, text: string): Promise<void> {
  await user.clear(field);
  if (text !== "") await user.type(field, text);
}

describe("assistant de NPC : ouverture et formulaire", () => {
  it("s'ouvre par le menu Fichier sur le premier assistant, avec son script, et prend le focus sur le premier champ", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);

    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Warp portal", "Warper NPC", "Shop", "Healer"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(within(dialog).getByRole("tabpanel", { name: "Warp portal" })).toBeTruthy();
    expect(preview(dialog)).toBe(script("warp-portal"));
    expect(preview(dialog)).toBe("prontera,155,180,0\twarp\twarp_to_geffen\t2,2,geffen,120,60\n");
    expect(document.activeElement).toBe(within(dialog).getByLabelText("NPC name"));
    // Le dialogue est large (deux colonnes) ; l'apercu defile : il doit pouvoir recevoir le focus pour se lire au clavier.
    expect(dialog.className).toBe("modal modal-wide");
    expect(within(dialog).getByRole("region", { name: "Generated script preview" }).tabIndex).toBe(0);
  });

  it("ne met dans l'ordre de tabulation que l'assistant affiche (onglets a tabindex mobile)", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    await user.click(tabs[2] as HTMLElement);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1]);
    expect(tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual(Array(4).fill(within(dialog).getByRole("tabpanel").id));
  });

  it("decrit chaque champ pour les technologies d'assistance et le place dans la grille du formulaire", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    const name = within(dialog).getByLabelText("NPC name");
    const x = within(dialog).getByLabelText("Position X");
    expect(name.getAttribute("aria-required")).toBe("true");
    expect(name.getAttribute("spellcheck")).toBe("false");
    expect(name.getAttribute("autocomplete")).toBe("off");
    expect(name.getAttribute("inputmode")).toBeNull();
    expect(x.getAttribute("inputmode")).toBe("numeric");
    // Le nom prend toute la largeur ; une position et la carte se placent deux par ligne.
    expect(name.parentElement?.className).toBe("field wizard-wide");
    expect(x.parentElement?.className).toBe("field");
    expect(within(dialog).getByLabelText("Map").parentElement?.className).toBe("field");
    // L'aide du nom est reliee au champ.
    const hint = (name.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
    expect(hint.join(" ")).toContain("The text before # or :: is displayed in game");
    expect(x.getAttribute("aria-describedby")?.split(" ")).toHaveLength(1);
    // La liste d'objets (zone de texte) prend aussi toute la largeur ; le sprite se place a cote d'un autre champ.
    await user.click(within(dialog).getByRole("tab", { name: "Shop" }));
    expect(within(dialog).getByLabelText("Items for sale").parentElement?.className).toBe("field wizard-wide");
    expect(within(dialog).getByLabelText("Sprite").parentElement?.className).toBe("field");
  });

  it("n'est disponible que dans un projet ouvert", async () => {
    const command = COMMANDS.find((candidate) => candidate.id === "npcWizard");
    expect(command?.menu).toBe("file");
    const store = createAppStore();
    expect(command?.enabled?.(store.getState())).toBe(false);
    const { h } = await openProject();
    expect(command?.enabled?.(h.store.getState())).toBe(true);
  });

  it("est aussi dans la palette de commandes", async () => {
    const { user } = await openProject();
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await user.type(await screen.findByRole("combobox"), "NPC wizard");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "NPC wizard" })).toBeTruthy();
  });

  it("se ferme par Echap et par Fermer", async () => {
    const { user } = await openProject();
    await openWizard(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("change d'assistant a la souris, chacun avec son script et ses champs", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("tab", { name: "Shop" }));
    expect(within(dialog).getByRole("tabpanel", { name: "Shop" })).toBeTruthy();
    expect(preview(dialog)).toBe(script("shop"));
    expect(within(dialog).getByLabelText("Items for sale")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Destination map")).toBeNull();

    await user.click(within(dialog).getByRole("tab", { name: "Healer" }));
    expect(preview(dialog)).toBe(script("healer"));
    expect(within(dialog).getByLabelText("HP restored (%)")).toBeTruthy();
  });

  it("change d'assistant au clavier : fleches, Debut et Fin deplacent la selection et le focus", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    const tabs = within(dialog).getAllByRole("tab");
    tabs[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(tabs[1]));
    await user.keyboard("{End}");
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(tabs[3]));
    await user.keyboard("{ArrowRight}");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Home}");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("garde la saisie de chaque assistant quand on passe de l'un a l'autre", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    await fill(user, within(dialog).getByLabelText("NPC name"), "Portail du nord");
    await user.click(within(dialog).getByRole("tab", { name: "Shop" }));
    expect((within(dialog).getByLabelText("NPC name") as HTMLInputElement).value).toBe("Merchant");
    await user.click(within(dialog).getByRole("tab", { name: "Warp portal" }));
    expect((within(dialog).getByLabelText("NPC name") as HTMLInputElement).value).toBe("Portail du nord");
    expect(preview(dialog)).toContain("\twarp\tPortail du nord\t");
  });

  it("met le script a jour a chaque saisie, y compris la liste deroulante de l'orientation", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    await fill(user, within(dialog).getByLabelText("Destination map"), "payon");
    await user.selectOptions(within(dialog).getByLabelText("Facing"), "South (4)");
    expect(preview(dialog)).toBe("prontera,155,180,4\twarp\twarp_to_geffen\t2,2,payon,120,60\n");
    expect((within(dialog).getByLabelText("Facing") as HTMLSelectElement).value).toBe("4");
    await user.selectOptions(within(dialog).getByLabelText("Facing"), "North-east (7)");
    expect(preview(dialog)).toBe("prontera,155,180,7\twarp\twarp_to_geffen\t2,2,payon,120,60\n");
    const options = within(within(dialog).getByLabelText("Facing")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["North (0)", "North-west (1)", "West (2)", "South-west (3)", "South (4)", "South-east (5)", "East (6)", "North-east (7)"]);
  });
});

describe("assistant de NPC : validation de la saisie", () => {
  it("signale une erreur a cote du champ, relie le message au champ et bloque le script et les sorties", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    const name = within(dialog).getByLabelText("NPC name");
    await fill(user, name, "");

    expect(within(dialog).getByText("This field is required.")).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const described = (name.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described.join(" ")).toContain("This field is required.");
    expect(within(dialog).queryByRole("region", { name: "Generated script preview" })).toBeNull();
    expect(within(dialog).getByText("The script appears as soon as the form has no error.")).toBeTruthy();
    for (const label of ["Copy", "Create the file", "Add to the open file"]) {
      expect((within(dialog).getByRole("button", { name: label }) as HTMLButtonElement).disabled, label).toBe(true);
    }

    await user.type(name, "Portail");
    expect(within(dialog).queryByText("This field is required.")).toBeNull();
    expect(name.getAttribute("aria-invalid")).toBe("false");
    expect(preview(dialog)).toContain("\twarp\tPortail\t");
    expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("bloque aussi l'ajout au fichier ouvert tant que la saisie a une erreur", async () => {
    const { user } = await openProject();
    await user.click(await screen.findByRole("treeitem", { name: /b\.txt/ }));
    await screen.findByLabelText("editor:b.txt");
    const dialog = await openWizard(user);
    const add = within(dialog).getByRole("button", { name: "Add to the open file" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    await fill(user, within(dialog).getByLabelText("NPC name"), "");
    expect(add.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText("NPC name"), "Retour");
    expect(add.disabled).toBe(false);
  });

  it("explique chaque erreur de nombre, de carte et de sprite", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    await fill(user, within(dialog).getByLabelText("Position X"), "abc");
    await fill(user, within(dialog).getByLabelText("Position Y"), "9999");
    await fill(user, within(dialog).getByLabelText("Map"), "carte invalide");
    expect(within(dialog).getByText("Enter a whole number.")).toBeTruthy();
    expect(within(dialog).getByText("The value must be between 0 and 511.")).toBeTruthy();
    expect(within(dialog).getByText("Invalid map name: up to 11 letters, digits, _, @ or #.")).toBeTruthy();

    await user.click(within(dialog).getByRole("tab", { name: "Warper NPC" }));
    await fill(user, within(dialog).getByLabelText("Sprite"), "pas un sprite!");
    expect(within(dialog).getByText("Invalid sprite: use a name (letters, digits, _), a numeric id or -1.")).toBeTruthy();
    await fill(user, within(dialog).getByLabelText("Choice to accept"), "oui:non");
    expect(within(dialog).getByText("The colon is not allowed here: it separates the menu choices.")).toBeTruthy();
  });

  it("donne les bornes de la langue courante dans les messages des objets, avec le numero de ligne", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("tab", { name: "Shop" }));
    await fill(user, within(dialog).getByLabelText("Items for sale"), "501 99999999999");
    expect(within(dialog).getByText("Line 1: the price must be between -1 and 2,147,483,647 (-1 uses the price of the item database).")).toBeTruthy();
    await fill(user, within(dialog).getByLabelText("Items for sale"), "");
    expect(within(dialog).getByText("Add at least one item to sell.")).toBeTruthy();
  });

  it("n'empeche pas la generation pour un avertissement, mais le montre avec son niveau", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("tab", { name: "Shop" }));
    await fill(user, within(dialog).getByLabelText("Items for sale"), "501 0");
    const warning = within(dialog).getByText("Line 1: a price of 0 gives the item away.");
    expect(warning.textContent).toBe("Warning Line 1: a price of 0 gives the item away.");
    expect(warning.className).toBe("field-warning");
    expect(preview(dialog)).toBe("prontera,155,180,4\tshop\tMerchant\t4_M_01,501:0\n");
    expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("annonce les messages en francais quand l'interface est en francais", async () => {
    const { user } = await openProject({ language: "fr-FR" });
    const dialog = await openWizard(user, { menu: "Fichier", item: /Assistant de NPC/, dialog: "Assistant de NPC" });
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Portail de téléportation", "PNJ téléporteur", "Boutique", "Soigneur"]);
    await fill(user, within(dialog).getByLabelText("Nom du NPC"), "");
    expect(within(dialog).getByText("Ce champ est obligatoire.")).toBeTruthy();
    expect(within(dialog).getByText("Le script apparaît dès que le formulaire n'a plus d'erreur.")).toBeTruthy();
    await fill(user, within(dialog).getByLabelText("Position Y"), "9999");
    expect(within(dialog).getByText("La valeur doit être comprise entre 0 et 511.")).toBeTruthy();
    // Les bornes sont mises en forme pour la langue (espaces insecables en francais).
    await user.click(within(dialog).getByRole("tab", { name: "Boutique" }));
    await fill(user, within(dialog).getByLabelText("Objets en vente"), "501 99999999999");
    const priceMax = new Intl.NumberFormat("fr").format(2_147_483_647);
    expect(priceMax).not.toBe("2147483647");
    // Testing Library normalise les espaces du texte affiche (les insecables aussi) : on compare apres la meme normalisation.
    const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
    const expected = flat(`Erreur Ligne 1 : le prix doit être compris entre -1 et ${priceMax} (-1 prend le prix de la base d'objets).`);
    expect(within(dialog).getAllByText((_content, element) => element?.tagName === "P" && flat(element.textContent ?? "") === expected)).toHaveLength(1);
  });
});

describe("assistant de NPC : verification locale du script produit", () => {
  it("annonce que l'analyse locale ne releve rien, avec la reserve sur le serveur", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    expect(await within(dialog).findByText("The local analysis found no problem.")).toBeTruthy();
    expect(within(dialog).getByText(/only your server confirms/)).toBeTruthy();
    expect(within(dialog).queryByText(/Problems found by the local analysis/)).toBeNull();
    expect(within(dialog).queryByRole("listitem")).toBeNull();
    // La section porte le nom de son titre.
    expect(within(dialog).getByRole("region", { name: "Local check" })).toBeTruthy();
  });

  it("montre les problemes releves avec leur niveau, leur code et leur ligne dans le script produit", async () => {
    const { h, user } = await openProject();
    const source = script("warp-npc");
    const start = source.split("\n").slice(0, 2).join("\n").length + 1;
    const found: ParseDiagnostic[] = [
      diagnostic({ code: "X0001", message: "Premier probleme", severity: "warning", range: { start, end: start + 3 } }),
      diagnostic({ code: "X0002", message: "Second probleme", severity: "error" }),
      diagnostic({ code: "X0003", message: "Remarque", severity: "info" }),
    ];
    const spy = vi.spyOn(h.controller, "previewWizardDiagnostics").mockResolvedValue(found);
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("tab", { name: "Warper NPC" }));

    expect(await within(dialog).findByText("Problems found by the local analysis: 3")).toBeTruthy();
    const items = within(dialog).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual([
      "Warning Premier probleme X0001 · line 3",
      "Error Second probleme X0002 · line 1",
      "Notice Remarque X0003 · line 1",
    ]);
    expect(spy).toHaveBeenLastCalledWith(source);
    expect(within(dialog).queryByText("The local analysis found no problem.")).toBeNull();
  });

  it("repasse a « en cours » des que le script change, jusqu'au resultat de la nouvelle verification", async () => {
    const { h, user } = await openProject();
    const pending: { resolve: (value: ParseDiagnostic[]) => void }[] = [];
    vi.spyOn(h.controller, "previewWizardDiagnostics").mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push({ resolve });
        }),
    );
    const dialog = await openWizard(user);
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.resolve([]);
    expect(await within(dialog).findByText("The local analysis found no problem.")).toBeTruthy();

    await fill(user, within(dialog).getByLabelText("NPC name"), "Nouveau");
    // Le resultat precedent concernait un autre script : il ne doit plus etre montre.
    expect(within(dialog).queryByText("The local analysis found no problem.")).toBeNull();
    expect(within(dialog).getByText("Checking…")).toBeTruthy();
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.resolve([diagnostic({ code: "X0001", message: "Nouveau probleme", severity: "warning" })]);
    expect(await within(dialog).findByText("Problems found by the local analysis: 1")).toBeTruthy();
    expect(within(dialog).queryByText("Checking…")).toBeNull();
  });

  it("dit quand la verification est en cours puis quand elle a echoue", async () => {
    const { h, user } = await openProject();
    let release: (value: null) => void = () => undefined;
    const spy = vi.spyOn(h.controller, "previewWizardDiagnostics").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const dialog = await openWizard(user);
    expect(await within(dialog).findByText("Checking…")).toBeTruthy();
    // La verification ne part qu'apres une courte pause de la saisie.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByText("Checking…")).toBeTruthy();
    release(null);
    expect(await within(dialog).findByText("The check could not be run.")).toBeTruthy();
    expect(within(dialog).queryByText("Checking…")).toBeNull();
  });

  it("ecarte le resultat d'une verification perimee quand la saisie a change entre-temps", async () => {
    const { h, user } = await openProject();
    const pending: { source: string; resolve: (value: ParseDiagnostic[]) => void }[] = [];
    vi.spyOn(h.controller, "previewWizardDiagnostics").mockImplementation(
      (source) =>
        new Promise((resolve) => {
          pending.push({ source, resolve });
        }),
    );
    const dialog = await openWizard(user);
    await waitFor(() => expect(pending).toHaveLength(1));
    await fill(user, within(dialog).getByLabelText("NPC name"), "Autre");
    await waitFor(() => expect(pending.at(-1)?.source).toContain("\twarp\tAutre\t"));

    const latest = pending.at(-1);
    latest?.resolve([]);
    expect(await within(dialog).findByText("The local analysis found no problem.")).toBeTruthy();
    // La premiere verification, partie de l'ancien script, repond apres : elle ne doit rien changer.
    pending[0]?.resolve([diagnostic({ code: "X9999", message: "Perime", severity: "error" })]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(within(dialog).queryByText(/Perime/)).toBeNull();
    expect(within(dialog).getByText("The local analysis found no problem.")).toBeTruthy();
  });

  it("n'analyse pas un script qui n'existe pas encore (saisie en erreur) et annule l'analyse en attente", async () => {
    const { h, user } = await openProject();
    const spy = vi.spyOn(h.controller, "previewWizardDiagnostics");
    const dialog = await openWizard(user);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    spy.mockClear();

    // Une saisie valable (X = 7), aussitot suivie d'une saisie en erreur (X = 7z) : l'analyse du script a X = 7 ne doit pas partir.
    const x = within(dialog).getByLabelText("Position X");
    await fill(user, x, "7");
    await user.type(x, "z");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spy).not.toHaveBeenCalled();
    expect(within(dialog).queryByText("The local analysis found no problem.")).toBeNull();
    expect(within(dialog).queryByText("Checking…")).toBeNull();
    expect(within(dialog).queryByRole("region", { name: "Generated script preview" })).toBeNull();
  });

  it("n'analyse qu'une fois une rafale de frappes : seul le script final l'est", async () => {
    const { h, user } = await openProject();
    const spy = vi.spyOn(h.controller, "previewWizardDiagnostics");
    const dialog = await openWizard(user);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    spy.mockClear();

    await fill(user, within(dialog).getByLabelText("NPC name"), "Portail");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(script("warp-portal", { name: "Portail" }));
  });

  it("localise les messages des diagnostics dans la langue de l'interface", async () => {
    const { h, user } = await openProject({ language: "fr-FR" });
    vi.spyOn(h.controller, "previewWizardDiagnostics").mockResolvedValue([
      diagnostic({ code: "RA0002", message: "Label 'L_X' is not defined in this script.", severity: "error", params: { name: "L_X" } }),
    ]);
    const dialog = await openWizard(user, { menu: "Fichier", item: /Assistant de NPC/, dialog: "Assistant de NPC" });
    expect(await within(dialog).findByText("Problèmes relevés par l'analyse locale : 1")).toBeTruthy();
    const [item] = within(dialog).getAllByRole("listitem");
    expect(item?.textContent).toBe("Erreur Le label « L_X » n'est pas défini dans ce script. RA0002 · ligne 1");
  });
});

describe("assistant de NPC : sorties", () => {
  it("copie le script dans le presse-papiers", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(script("warp-portal"));
    expect(await screen.findByText("Script copied to the clipboard.")).toBeTruthy();
    // L'assistant reste ouvert : on peut copier, puis ajouter ailleurs.
    expect(screen.getByRole("dialog", { name: "NPC wizard" })).toBeTruthy();
  });

  it("ajoute le script a la fin du fichier ouvert, sans rien enregistrer, et ferme l'assistant", async () => {
    const { h, user } = await openProject();
    await user.click(await screen.findByRole("treeitem", { name: /b\.txt/ }));
    await screen.findByLabelText("editor:b.txt");
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("tab", { name: "Shop" }));
    expect(within(dialog).getByText("The script will be added at the end of b.txt.")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Add to the open file" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.buffers.get("b.txt")?.text).toBe(`// b\n\n${script("shop")}`);
    expect(h.store.getState().docs["b.txt"]?.dirty).toBe(true);
    expect(h.backend.textOf("b.txt")).toBe("// b\n");
    expect(await screen.findByText("Script added at the end of b.txt. Nothing is saved until you save (Ctrl+S).")).toBeTruthy();
  });

  it("n'offre d'ajouter qu'a un fichier ouvert, et le dit", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    expect((within(dialog).getByRole("button", { name: "Add to the open file" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText("Open a file in the editor first.")).toBeTruthy();
  });

  it("propose un fichier a creer dans npc/custom, qui suit le nom du NPC tant que l'utilisateur n'y touche pas", async () => {
    const { user } = await openProject();
    const dialog = await openWizard(user);
    const file = within(dialog).getByLabelText("File to create") as HTMLInputElement;
    expect(file.value).toBe("npc/custom/warp_to_geffen.txt");
    await fill(user, within(dialog).getByLabelText("NPC name"), "Éric le Forgeron");
    expect(file.value).toBe("npc/custom/eric_le_forgeron.txt");

    await fill(user, file, "mes_scripts/forge.txt");
    await fill(user, within(dialog).getByLabelText("NPC name"), "Autre nom");
    expect(file.value).toBe("mes_scripts/forge.txt");
  });

  it("cree le fichier avec le script, non enregistre, et l'ouvre", async () => {
    const { h, user } = await openProject();
    const dialog = await openWizard(user);
    await user.click(within(dialog).getByRole("tab", { name: "Shop" }));
    await user.click(within(dialog).getByRole("button", { name: "Create the file" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.backend.textOf("npc/custom/merchant.txt")).toBe("");
    expect(h.buffers.get("npc/custom/merchant.txt")?.text).toBe(script("shop"));
    expect(h.store.getState().activePath).toBe("npc/custom/merchant.txt");
    expect(h.store.getState().docs["npc/custom/merchant.txt"]?.dirty).toBe(true);
    expect(await screen.findByText("merchant.txt created with the script. Save it (Ctrl+S) to write it to disk.")).toBeTruthy();

    await h.controller.saveActive();
    expect(h.backend.textOf("npc/custom/merchant.txt")).toBe(script("shop"));
  });

  it("ne lance qu'une creation quand on double-clique pendant qu'elle se fait, et libere le bouton si elle echoue", async () => {
    const { h, user } = await openProject();
    let finish: (outcome: "exists") => void = () => undefined;
    const spy = vi.spyOn(h.controller, "createWizardFile").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const dialog = await openWizard(user);
    const create = within(dialog).getByRole("button", { name: "Create the file" }) as HTMLButtonElement;
    await user.dblClick(create);
    expect(spy).toHaveBeenCalledTimes(1);
    // Occupe, mais jamais `disabled` : le bouton garde le focus pendant la creation et si elle echoue.
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(create.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(create);
    finish("exists");
    expect(await within(dialog).findByText("A file with this name already exists; nothing was changed.")).toBeTruthy();
    expect(create.getAttribute("aria-disabled")).toBe("false");
    expect(document.activeElement).toBe(create);
  });

  it("cree le fichier une seule fois avec le vrai controleur", async () => {
    const { h, user } = await openProject();
    const spy = vi.spyOn(h.controller, "createWizardFile");
    const dialog = await openWizard(user);
    await user.dblClick(within(dialog).getByRole("button", { name: "Create the file" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.backend.files.has("npc/custom/warp_to_geffen.txt")).toBe(true);
  });

  it("refuse d'ecraser un fichier existant : le dit, garde l'assistant ouvert, et l'erreur disparait a la correction", async () => {
    const { h, user } = await openProject();
    const dialog = await openWizard(user);
    const file = within(dialog).getByLabelText("File to create");
    await fill(user, file, "npc/a.txt");
    await user.click(within(dialog).getByRole("button", { name: "Create the file" }));

    expect(await within(dialog).findByText("A file with this name already exists; nothing was changed.")).toBeTruthy();
    expect(file.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("dialog", { name: "NPC wizard" })).toBeTruthy();
    expect(h.backend.textOf("npc/a.txt")).toBe(NPC);
    expect((within(dialog).getByRole("button", { name: "Create the file" }) as HTMLButtonElement).disabled).toBe(false);

    await user.type(file, "2");
    expect(within(dialog).queryByText(/already exists/)).toBeNull();
    expect(file.getAttribute("aria-invalid")).toBe("false");
  });

  it("refuse un nom de fichier invalide sans rien creer", async () => {
    const { h, user } = await openProject();
    const dialog = await openWizard(user);
    await fill(user, within(dialog).getByLabelText("File to create"), "../hors.txt");
    await user.click(within(dialog).getByRole("button", { name: "Create the file" }));
    expect(await within(dialog).findByText("This file name is not valid or the file cannot be created.")).toBeTruthy();
    expect(h.backend.files.has("hors.txt")).toBe(false);
    await fill(user, within(dialog).getByLabelText("File to create"), "");
    expect((within(dialog).getByRole("button", { name: "Create the file" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("assistant de NPC : profil sans assistant verifie", () => {
  it("l'explique au lieu d'offrir un formulaire", async () => {
    const config = JSON.stringify({ schemaVersion: 1, projectName: "P", emulator: { family: "hercules" } });
    const { user } = await openProject({ files: { ...FILES, ".runeforge/project.json": config } });
    const dialog = await openWizard(user);
    expect(within(dialog).getByText("No wizard is verified for the hercules profile yet: the wizards are checked against rAthena only.")).toBeTruthy();
    expect(within(dialog).queryByRole("tab")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Create the file" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
