// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { describeServer } from "./app/server-status";
import { translate } from "./i18n/messages";
import { NO_EMULATOR, type EmulatorState } from "./state/store";
import { renderApp } from "./test/render-app";

const TABLE = [
  "struct script_function buildin_func[] = {",
  '\tBUILDIN_DEF(mes,"s*"),',
  '\tBUILDIN_DEF(close,""),',
  "\t{nullptr,nullptr,nullptr},",
  "};",
].join("\n");
const MANUAL = ["=====", "|1.- Base.|", "=====", '*mes "<string>"{,"<string>"};', "", "Affiche.", ""].join("\n");
const SCRIPT = 'prontera,5,5,0\tscript\tProbe\t100,{\n\tmes;\n\tInconnue 1;\n\tclose;\n}\n';
const SERVER = {
  "src/map/script.cpp": TABLE,
  "doc/script_commands.txt": MANUAL,
  "src/config/renewal.hpp": "#define RENEWAL\n",
  "npc/re/scripts_main.conf": "npc: npc/probe.txt\n",
  "npc/probe.txt": SCRIPT,
};

afterEach(() => {
  cleanup();
});

async function openProject(files: Record<string, string>) {
  const harness = renderApp({ files, withLanguage: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  await harness.controller.whenIndexed();
  return { harness, user };
}

describe("App - serveur et registre de commandes", () => {
  it("affiche dans la barre d'etat le registre lu dans le serveur, avec le detail en info-bulle", async () => {
    await openProject(SERVER);
    const item = await screen.findByRole("button", { name: "2 commands" });
    expect(item.getAttribute("data-server-status")).toBe("ready");
    expect(item.getAttribute("data-attention")).toBe("false");
    const title = item.getAttribute("title") ?? "";
    expect(title).toContain("argument counts are checked");
    expect(title).toContain("Server folder: the project folder (detected)");
    expect(title).toContain("renewal mode (read from src/config/renewal.hpp)");
  });

  it("invite a choisir le serveur quand il est introuvable, et ouvre les parametres du projet", async () => {
    const { user } = await openProject({ "npc/a.txt": SCRIPT });
    const item = await screen.findByRole("button", { name: "Server not found" });
    expect(item.getAttribute("data-attention")).toBe("true");
    await user.click(item);
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    expect(within(dialog).getByLabelText(/server folder/i)).toBeTruthy();
  });

  it("propose les serveurs trouves quand il y en a plusieurs", async () => {
    const files = {
      "Serveur/a/src/map/script.cpp": TABLE,
      "Serveur/b/src/map/script.cpp": TABLE,
      "npc/a.txt": SCRIPT,
    };
    const { harness, user } = await openProject(files);
    const item = await screen.findByRole("button", { name: "Choose a server" });
    expect(item.getAttribute("title")).toContain("Serveur/a, Serveur/b");
    await user.click(item);
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    const options = [...dialog.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"));
    expect(options).toEqual(["Serveur/a", "Serveur/b"]);

    const field = within(dialog).getByLabelText(/server folder/i);
    await user.type(field, "Serveur/b");
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.backend.textOf(".runeforge/project.json")).toContain('"root": "Serveur/b"'));
    await waitFor(() => expect(harness.store.getState().emulator).toMatchObject({ status: "ready", root: "Serveur/b" }));
  });

  it("enregistre le mode de compilation et la portee de l'index dans la configuration du projet", async () => {
    const { harness, user } = await openProject(SERVER);
    harness.controller.openSettings("project");
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    await user.selectOptions(within(dialog).getByLabelText(/server build mode/i), "pre-renewal");
    await user.selectOptions(within(dialog).getByLabelText(/indexed scripts/i), "loaded");
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.backend.textOf(".runeforge/project.json")).toContain('"indexScope": "loaded"'));
    const saved = harness.backend.textOf(".runeforge/project.json") ?? "";
    expect(saved).toContain('"mode": "pre-renewal"');
    expect(harness.store.getState().project?.config.emulator).toMatchObject({ mode: "pre-renewal", indexScope: "loaded" });
    await waitFor(() => expect(harness.store.getState().emulator).toMatchObject({ renewal: false, renewalSource: "config" }));
  });

  it("enregistre les commandes personnalisees saisies dans les parametres et reconstruit le registre", async () => {
    const { harness, user } = await openProject(SERVER);
    harness.controller.openSettings("project");
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    const field = within(dialog).getByLabelText(/custom commands/i);
    await user.type(field, "maquette s?{Enter}autre");
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.backend.textOf(".runeforge/project.json")).toContain('"maquette"'));
    const saved = JSON.parse(harness.backend.textOf(".runeforge/project.json") ?? "{}") as { commands: { custom: unknown[] } };
    expect(saved.commands.custom).toEqual([{ name: "maquette", args: "s?" }, { name: "autre" }]);
    expect(harness.store.getState().project?.config.commands.custom).toHaveLength(2);
    // Les deux commandes du serveur de test (mes, close) et les deux du projet.
    await waitFor(() => expect(harness.store.getState().emulator).toMatchObject({ status: "ready", commands: 4 }));
  });

  it("signale la ligne invalide des commandes personnalisees et garde la liste enregistree", async () => {
    const { harness, user } = await openProject(SERVER);
    harness.controller.openSettings("project");
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    const field = within(dialog).getByLabelText(/custom commands/i);
    await user.type(field, "bonne{Enter}1mauvaise s");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(dialog).getByText(/Line 2: 1mauvaise s — invalid name/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.store.getState().project?.configExists).toBe(true));
    expect(harness.store.getState().project?.config.commands.custom).toEqual([]);
  });

  it("enregistre les constantes du projet et la gravite des references introuvables saisies dans les parametres", async () => {
    const { harness, user } = await openProject(SERVER);
    harness.controller.openSettings("project");
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    const field = within(dialog).getByLabelText(/custom constants/i);
    await user.type(field, "MY_EVENT 7{Enter}OTHER");
    await user.selectOptions(within(dialog).getByLabelText(/unknown items, monsters and maps/i), "warning");
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.backend.textOf(".runeforge/project.json")).toContain('"MY_EVENT"'));
    const saved = JSON.parse(harness.backend.textOf(".runeforge/project.json") ?? "{}") as { constants: { custom: unknown[] }; validation: { unknownReferences: string } };
    expect(saved.constants.custom).toEqual([{ name: "MY_EVENT", value: 7 }, { name: "OTHER" }]);
    expect(saved.validation.unknownReferences).toBe("warning");
    expect(harness.store.getState().project?.config.constants.custom).toHaveLength(2);
  });

  it("signale la ligne invalide des constantes du projet et garde la liste enregistree", async () => {
    const { harness, user } = await openProject(SERVER);
    harness.controller.openSettings("project");
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    const field = within(dialog).getByLabelText(/custom constants/i);
    await user.type(field, "BONNE 1{Enter}mauvaise-ligne");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(dialog).getByText(/Line 2: mauvaise-ligne — invalid name/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.store.getState().project?.configExists).toBe(true));
    expect(harness.store.getState().project?.config.constants.custom).toEqual([]);
  });

  it("refuse une racine de serveur hors du projet sans l'enregistrer", async () => {
    const { harness, user } = await openProject(SERVER);
    harness.controller.openSettings("project");
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    const field = within(dialog).getByLabelText(/server folder/i);
    await user.type(field, "../ailleurs");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(dialog).getByText(/no absolute path and no '\.\.'/i)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /save project settings/i }));
    await waitFor(() => expect(harness.store.getState().project?.configExists).toBe(true));
    expect(harness.store.getState().project?.config.emulator.root).toBe("");
  });

  it("signale la commande inconnue et l'arite dans le panneau des problemes, avec le niveau de confiance", async () => {
    const { harness } = await openProject(SERVER);
    await harness.controller.openFile("npc/probe.txt");
    harness.controller.toggleBottomPanel();
    const region = await screen.findByRole("region", { name: /problems/i });
    await waitFor(() => expect(within(region).getByText(/'mes' expects 1\+ argument\(s\) but 0 were given/)).toBeTruthy(), { timeout: 3000 });
    expect(within(region).getByText(/'Inconnue' is not a known command or function for profile rAthena/)).toBeTruthy();
  });
});

describe("describeServer", () => {
  const t = (key: Parameters<typeof translate>[1], params?: Readonly<Record<string, string | number>>): string => translate("fr", key, params);
  const ready: EmulatorState = {
    ...NO_EMULATOR,
    status: "ready",
    root: "Serveur/rathena-kov",
    detected: true,
    level: "server-source",
    commands: 667,
    withArity: 667,
    renewal: true,
    renewalSource: "header",
    loadedScripts: 841,
    loadIssues: 2,
  };

  it("ne dit rien tant que le projet n'a pas ete examine", () => {
    expect(describeServer(NO_EMULATOR, "rAthena", t)).toBeNull();
  });

  it("decrit le registre, le dossier, le mode et les scripts charges", () => {
    const view = describeServer(ready, "rAthena", t);
    expect(view?.text).toBe("667 commandes");
    expect(view?.attention).toBe(false);
    expect(view?.title).toBe(
      "Registre de commandes lu dans le code source de votre serveur : le nombre d'arguments est vérifié.\n" +
        "Dossier du serveur : Serveur/rathena-kov (détecté) · mode renewal (lu dans src/config/renewal.hpp) · 841 scripts chargés par le serveur (2 problèmes dans scripts_*.conf)\n" +
        "Aucune base de serveur n'a été lue (db/*.yml, map_index.txt) : objets, monstres et cartes ne sont ni proposés ni vérifiés.",
    );
  });

  it("dit ce que contiennent les bases du serveur et signale les entrees ecartees", () => {
    const withCatalog = { ...ready, catalog: { items: 27826, mobs: 2555, skills: 1436, maps: 1248, constants: 10303, loadedMaps: 1218 }, catalogWarnings: ["a", "b", "c"] };
    expect(describeServer(withCatalog, "rAthena", t)?.title).toContain(
      "Bases : 27826 objets, 2555 monstres, 1248 cartes, 10303 constantes. Compétences : 1436. 1218 de ces cartes sont chargées par le serveur (conf/maps_athena.conf). 3 entrées des bases ont été écartées.",
    );
    expect(describeServer({ ...withCatalog, catalogWarnings: [] }, "rAthena", t)?.title).toMatch(/\(conf\/maps_athena\.conf\)\.$/);
  });

  it("dit quand la liste des cartes chargees par le serveur est inconnue : aucune declaration n'est alors signalee sur ce motif", () => {
    const unknownList = { ...ready, catalog: { items: 1, mobs: 1, skills: 0, maps: 2, constants: 1, loadedMaps: null }, catalogWarnings: [] };
    expect(describeServer(unknownList, "rAthena", t)?.title).toMatch(/La liste des cartes que le serveur charge est inconnue : les déclarations sur une carte qu'il ne charge pas ne sont pas signalées\.$/);
  });

  it("distingue le manuel seul de l'absence de registre", () => {
    expect(describeServer({ ...ready, level: "server-doc", commands: 700, withArity: 0 }, "rAthena", t)?.text).toBe("Manuel : 700 commandes");
    const none = describeServer({ ...ready, level: "none", commands: 0, withArity: 0, root: "" }, "rAthena", t);
    expect(none?.text).toBe("Pas de registre de commandes");
    expect(none?.attention).toBe(true);
    expect(none?.title).toContain("Dossier du serveur : le dossier du projet (détecté)");
  });

  it("signale les etats qui demandent une action ou une explication", () => {
    expect(describeServer({ ...NO_EMULATOR, status: "not-found" }, "rAthena", t)).toMatchObject({ text: "Serveur non trouvé", attention: true });
    expect(describeServer({ ...NO_EMULATOR, status: "ambiguous", candidates: ["a", "b"] }, "rAthena", t)?.title).toContain("(a, b)");
    expect(describeServer({ ...NO_EMULATOR, status: "unsupported" }, "Hercules", t)).toMatchObject({ text: "Hercules : pas de registre", attention: false });
    expect(describeServer({ ...NO_EMULATOR, status: "loading" }, "rAthena", t)?.text).toBe("Lecture du serveur…");
  });

  it("signale les lignes du code source du serveur qui n'ont pas ete comprises", () => {
    expect(describeServer({ ...ready, warnings: ["a", "b"], loadedScripts: null }, "rAthena", t)?.title).toContain(" · 2 lignes du code source du serveur n'ont pas été comprises");
  });
});
