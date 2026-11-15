import type { MessageKey } from "../i18n/messages";
import type { EmulatorState } from "../state/store";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

export interface ServerStatusView {
  /** Texte court de la barre d'etat. */
  readonly text: string;
  /** Explication detaillee (info-bulle). */
  readonly title: string;
  /** Vrai si l'utilisateur doit agir (serveur introuvable ou ambigu) : l'element est mis en avant. */
  readonly attention: boolean;
}

/** Ce que la barre d'etat dit du serveur et de son registre de commandes ; `null` quand il n'y a rien a dire. */
export function describeServer(emulator: EmulatorState, emulatorName: string, t: Translate): ServerStatusView | null {
  switch (emulator.status) {
    case "none":
      return null;
    case "loading":
      return { text: t("status.server.loading"), title: "", attention: false };
    case "unsupported":
      return {
        text: t("status.server.unsupported", { emulator: emulatorName }),
        title: t("status.server.unsupported.title"),
        attention: false,
      };
    case "not-found":
      return { text: t("status.server.notFound"), title: t("status.server.notFound.title"), attention: true };
    case "ambiguous":
      return {
        text: t("status.server.ambiguous"),
        title: t("status.server.ambiguous.title", { candidates: emulator.candidates.join(", ") }),
        attention: true,
      };
    case "ready": {
      const summary =
        emulator.level === "server-source"
          ? { text: t("status.server.source", { commands: emulator.commands }), title: t("status.server.source.title") }
          : emulator.level === "server-doc"
            ? { text: t("status.server.doc", { commands: emulator.commands }), title: t("status.server.doc.title") }
            : { text: t("status.server.noRegistry"), title: t("status.server.noRegistry.title") };
      let details = t("status.server.folder", { root: emulator.root === "" || emulator.root === null ? t("status.server.folder.root") : emulator.root });
      if (emulator.detected) details += t("status.server.detected");
      if (emulator.renewal !== null && emulator.renewalSource !== null) {
        details += t("status.server.mode", {
          mode: t(emulator.renewal ? "status.server.mode.renewal" : "status.server.mode.preRenewal"),
          source: t(`status.server.modeSource.${emulator.renewalSource}` as MessageKey),
        });
      }
      if (emulator.loadedScripts !== null) {
        details += t("status.server.loaded", { count: emulator.loadedScripts });
        if (emulator.loadIssues > 0) details += t("status.server.loadIssues", { issues: emulator.loadIssues });
      }
      if (emulator.warnings.length > 0) details += t("status.server.warnings", { count: emulator.warnings.length });
      // Bases du serveur : objets, monstres, cartes et constantes lus (ou l'absence de catalogue).
      const catalog =
        emulator.catalog === null
          ? t("status.server.catalog.none")
          : t("status.server.catalog", { items: emulator.catalog.items, mobs: emulator.catalog.mobs, maps: emulator.catalog.maps, constants: emulator.catalog.constants }) +
            (emulator.catalog.skills > 0 ? t("status.server.catalogSkills", { skills: emulator.catalog.skills }) : "") +
            // Les cartes que le serveur charge : c'est ce qui permet de signaler un NPC place sur une carte qu'il ignore.
            (emulator.catalog.loadedMaps === null ? t("status.server.loadedMaps.unknown") : t("status.server.loadedMaps", { count: emulator.catalog.loadedMaps }));
      const catalogNotes = emulator.catalogWarnings.length > 0 ? t("status.server.catalogWarnings", { count: emulator.catalogWarnings.length }) : "";
      return { text: summary.text, title: `${summary.title}\n${details}\n${catalog}${catalogNotes}`, attention: emulator.level === "none" };
    }
  }
}
