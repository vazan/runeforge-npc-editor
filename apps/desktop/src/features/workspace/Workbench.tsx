import { useAppState, useController, useT } from "../../app/context";
import { Icon } from "../../components/Icon";
import { Splitter } from "../../components/Splitter";
import { MAX_BOTTOM, MAX_SIDEBAR, MIN_BOTTOM, MIN_SIDEBAR } from "../../state/store";
import { BottomPanel } from "../diagnostics/BottomPanel";
import { EditorArea } from "../editor/EditorArea";
import { ExplorerPanel } from "./ExplorerPanel";
import { MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";

/** Disposition principale : menus, barre d'activite, explorateur, editeur, panneau des problemes, barre d'etat. */
export function Workbench() {
  const controller = useController();
  const t = useT();
  const sidebarVisible = useAppState((state) => state.sidebarVisible);
  const bottomVisible = useAppState((state) => state.bottomVisible);
  const sidebarWidth = useAppState((state) => state.sidebarWidth);
  const bottomHeight = useAppState((state) => state.bottomHeight);

  return (
    <div className="workbench">
      <MenuBar />
      <div className="workbench-body">
        <nav className="activitybar" aria-label={t("explorer.title")}>
          <button
            type="button"
            className={`activity-button${sidebarVisible ? " active" : ""}`}
            aria-pressed={sidebarVisible}
            title={`${t("explorer.title")} (Ctrl+B)`}
            aria-label={t("explorer.title")}
            onClick={() => controller.toggleSidebar()}
          >
            <Icon name="folder" size={22} />
          </button>
          <button
            type="button"
            className={`activity-button${bottomVisible ? " active" : ""}`}
            aria-pressed={bottomVisible}
            title={`${t("problems.title")} (Ctrl+J)`}
            aria-label={t("problems.title")}
            onClick={() => controller.toggleBottomPanel()}
          >
            <Icon name="warning" size={22} />
          </button>
          <button type="button" className="activity-button activity-bottom" title={`${t("cmd.settings")} (Ctrl+,)`} aria-label={t("cmd.settings")} onClick={() => controller.openSettings("general")}>
            <Icon name="settings" size={22} />
          </button>
        </nav>
        {sidebarVisible && (
          <>
            <aside className="sidebar" style={{ width: sidebarWidth }} aria-label={t("explorer.title")}>
              <ExplorerPanel />
            </aside>
            <Splitter orientation="vertical" value={sidebarWidth} min={MIN_SIDEBAR} max={MAX_SIDEBAR} label={t("explorer.title")} onChange={(value) => controller.setSidebarWidth(value)} />
          </>
        )}
        <div className="workbench-main">
          <EditorArea />
          {bottomVisible && (
            <>
              <Splitter orientation="horizontal" inverted value={bottomHeight} min={MIN_BOTTOM} max={MAX_BOTTOM} label={t("problems.title")} onChange={(value) => controller.setBottomHeight(value)} />
              <div className="bottom-panel" style={{ height: bottomHeight }}>
                <BottomPanel />
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
