import type { MessageKey } from "../i18n/messages";
import type { AppState } from "../state/store";
import type { AppController } from "./controller";

export type MenuId = "file" | "view" | "go" | "help";

export interface Command {
  readonly id: string;
  readonly title: MessageKey;
  /** Raccourci au format `Mod+Shift+P` (`Mod` = Ctrl). */
  readonly shortcut?: string;
  readonly menu?: MenuId;
  /** Vrai si la commande est disponible dans l'etat courant (defaut : toujours). */
  readonly enabled?: (state: AppState) => boolean;
  readonly run: (controller: AppController) => void | Promise<void>;
}

const hasProject = (state: AppState): boolean => state.project !== null;
const hasActiveDocument = (state: AppState): boolean => state.activePath !== null;

export const COMMANDS: readonly Command[] = [
  { id: "openFolder", title: "cmd.openFolder", shortcut: "Mod+O", menu: "file", run: (c) => c.openFolder() },
  { id: "newFile", title: "cmd.newFile", shortcut: "Mod+N", menu: "file", enabled: hasProject, run: (c) => c.requestNewFile("") },
  { id: "npcWizard", title: "cmd.npcWizard", menu: "file", enabled: hasProject, run: (c) => c.openNpcWizard() },
  { id: "visualBuilder", title: "cmd.visualBuilder", menu: "file", enabled: hasProject, run: (c) => void c.openVisualBuilder() },
  { id: "npcPromptGenerator", title: "cmd.npcPromptGenerator", menu: "file", enabled: hasProject, run: (c) => c.openNpcPromptGenerator() },
  { id: "visualEditor", title: "cmd.visualEditor", menu: "file", enabled: hasActiveDocument, run: (c) => void c.openVisual() },
  { id: "simulation", title: "cmd.simulation", menu: "file", enabled: hasActiveDocument, run: (c) => c.openSimulation() },
  { id: "deploy", title: "cmd.deploy", menu: "file", enabled: hasProject, run: (c) => c.openDeploy() },
  { id: "sftpPreview", title: "sftp.title", menu: "file", enabled: hasProject, run: (c) => c.openDialog({ kind: "sftp" }) },
  { id: "save", title: "cmd.save", shortcut: "Mod+S", menu: "file", enabled: hasActiveDocument, run: (c) => c.saveActive() },
  { id: "saveAll", title: "cmd.saveAll", shortcut: "Mod+Shift+S", menu: "file", enabled: hasProject, run: (c) => c.saveAll() },
  {
    id: "closeTab",
    title: "cmd.closeTab",
    shortcut: "Mod+W",
    menu: "file",
    enabled: hasActiveDocument,
    run: (c) => {
      const path = c.getStore().getState().activePath;
      return path === null ? undefined : c.requestCloseTab(path);
    },
  },
  {
    id: "reloadFromDisk",
    title: "cmd.reloadFromDisk",
    menu: "file",
    enabled: hasActiveDocument,
    run: (c) => {
      const path = c.getStore().getState().activePath;
      return path === null ? undefined : c.reloadFromDisk(path);
    },
  },
  { id: "closeProject", title: "cmd.closeProject", menu: "file", enabled: hasProject, run: (c) => c.closeProject() },
  { id: "settings", title: "cmd.settings", shortcut: "Mod+,", menu: "file", run: (c) => c.openSettings("general") },

  { id: "toggleSidebar", title: "cmd.toggleSidebar", shortcut: "Mod+B", menu: "view", run: (c) => c.toggleSidebar() },
  { id: "togglePanel", title: "cmd.togglePanel", shortcut: "Mod+J", menu: "view", run: (c) => c.toggleBottomPanel() },
  { id: "projectReport", title: "cmd.projectReport", shortcut: "Mod+Shift+M", menu: "view", enabled: hasProject, run: (c) => c.showProjectReport() },
  { id: "refreshExplorer", title: "cmd.refreshExplorer", menu: "view", enabled: hasProject, run: (c) => c.refreshTree() },
  { id: "gitChanges", title: "cmd.gitChanges", menu: "view", enabled: hasProject, run: (c) => c.showGit() },
  { id: "compareWithGit", title: "cmd.compareWithGit", menu: "view", enabled: hasActiveDocument, run: (c) => c.compareWithGit() },

  { id: "quickOpen", title: "cmd.quickOpen", shortcut: "Mod+P", menu: "go", enabled: hasProject, run: (c) => c.openPalette("files") },
  { id: "palette", title: "cmd.palette", shortcut: "Mod+Shift+P", menu: "go", run: (c) => c.openPalette("commands") },
  { id: "goToSymbol", title: "cmd.goToSymbol", shortcut: "Mod+T", menu: "go", enabled: hasProject, run: (c) => c.openPalette("symbols") },
  { id: "searchDatabases", title: "cmd.searchDatabases", shortcut: "Mod+Shift+D", menu: "go", enabled: hasProject, run: (c) => c.openPalette("databases") },
  { id: "findReferences", title: "cmd.findReferences", shortcut: "Shift+F12", menu: "go", enabled: hasActiveDocument, run: (c) => c.findReferences() },
  { id: "nextTab", title: "cmd.nextTab", shortcut: "Mod+PageDown", menu: "go", enabled: hasProject, run: (c) => c.cycleTab(1) },
  { id: "previousTab", title: "cmd.previousTab", shortcut: "Mod+PageUp", menu: "go", enabled: hasProject, run: (c) => c.cycleTab(-1) },

  { id: "updates", title: "cmd.updates", menu: "help", run: (c) => c.openSettings("updates") },
  { id: "about", title: "cmd.about", menu: "help", run: (c) => c.openSettings("about") },
];

interface ParsedShortcut {
  readonly key: string;
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+");
  const key = (parts[parts.length - 1] ?? "").toLowerCase();
  return { key, mod: parts.includes("Mod"), shift: parts.includes("Shift"), alt: parts.includes("Alt") };
}

/** Commande associee a un evenement clavier (ou `undefined`). `F1` ouvre la palette. */
export function commandForKeyEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): Command | undefined {
  if (event.key === "F1") return COMMANDS.find((command) => command.id === "palette");
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  return COMMANDS.find((command) => {
    if (command.shortcut === undefined) return false;
    const parsed = parseShortcut(command.shortcut);
    return parsed.key === key && parsed.mod === mod && parsed.shift === event.shiftKey && parsed.alt === event.altKey;
  });
}

/** Libelle d'affichage d'un raccourci (`Ctrl+Shift+P`). */
export function formatShortcut(shortcut: string): string {
  return shortcut.replace("Mod", "Ctrl").replace("PageDown", "PgDn").replace("PageUp", "PgUp");
}
