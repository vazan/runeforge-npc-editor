import { flattenVisible, type FlatRow } from "@runeforge/project-core";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { Icon } from "../../components/Icon";

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

function parentIndex(rows: readonly FlatRow[], index: number): number {
  const row = rows[index];
  if (row === undefined) return -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if ((rows[i]?.depth ?? 0) < row.depth) return i;
  }
  return -1;
}

/**
 * Explorateur de fichiers. La liste est virtualisee (seules les lignes visibles sont rendues) et suit le motif ARIA
 * `tree` avec navigation clavier : fleches, Home/End, Entree/Espace, fleche droite/gauche pour deplier/replier.
 */
export function ExplorerPanel() {
  const controller = useController();
  const t = useT();
  const project = useAppState((state) => state.project);
  const expanded = useAppState((state) => state.expanded);
  const filter = useAppState((state) => state.explorerFilter);
  const selectedPath = useAppState((state) => state.selectedPath);

  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const rows = useMemo(
    () => (project === null ? [] : flattenVisible(project.tree, expandedSet, filter)),
    [project, expandedSet, filter],
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const update = (): void => setHeight(element.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // La selection est l'unique source de verite du focus clavier (les fleches deplacent la selection) : elle suit
  // aussi les ouvertures faites ailleurs (palette, onglets).
  const selectedIndex = rows.findIndex((row) => row.node.path === selectedPath);
  const safeFocus = selectedIndex === -1 ? 0 : selectedIndex;

  const ensureVisible = (index: number): void => {
    const element = viewportRef.current;
    if (element === null) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  };

  const move = (index: number): void => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    const target = rows[next];
    if (target !== undefined) controller.selectInExplorer(target.node.path);
    ensureVisible(next);
  };

  /** Premiere fleche vers le bas sans selection : se place sur la premiere ligne. */
  const step = (delta: number): void => move(selectedIndex === -1 ? (delta > 0 ? 0 : rows.length - 1) : selectedIndex + delta);

  const activate = (row: FlatRow): void => {
    controller.selectInExplorer(row.node.path);
    if (row.node.kind === "directory") controller.toggleDirectory(row.node.path);
    else void controller.openFile(row.node.path);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[safeFocus];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        return step(1);
      case "ArrowUp":
        event.preventDefault();
        return step(-1);
      case "Home":
        event.preventDefault();
        return move(0);
      case "End":
        event.preventDefault();
        return move(rows.length - 1);
      case "PageDown":
        event.preventDefault();
        return move(safeFocus + Math.floor(height / ROW_HEIGHT));
      case "PageUp":
        event.preventDefault();
        return move(safeFocus - Math.floor(height / ROW_HEIGHT));
      case "ArrowRight":
        if (row === undefined) return;
        event.preventDefault();
        if (row.node.kind === "directory") {
          if (!row.expanded) controller.toggleDirectory(row.node.path);
          else move(safeFocus + 1);
        }
        return;
      case "ArrowLeft":
        if (row === undefined) return;
        event.preventDefault();
        if (row.node.kind === "directory" && row.expanded) controller.toggleDirectory(row.node.path);
        else move(parentIndex(rows, safeFocus));
        return;
      case "Enter":
      case " ":
        if (row === undefined) return;
        event.preventDefault();
        return activate(row);
      default:
        return;
    }
  };

  if (project === null) {
    return (
      <div className="panel-empty">
        <p>{t("explorer.empty")}</p>
        <button type="button" className="button" onClick={() => void controller.openFolder()}>
          {t("explorer.openFolder")}
        </button>
      </div>
    );
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);
  const activeId = rows[safeFocus] === undefined ? undefined : `tree-row-${safeFocus}`;

  return (
    <div className="explorer">
      <div className="explorer-toolbar">
        <span className="explorer-project" title={project.root.displayPath}>
          {project.name}
        </span>
        <button type="button" className="icon-button" title={t("explorer.newFile")} aria-label={t("explorer.newFile")} onClick={() => controller.requestNewFile("")}>
          <Icon name="plus" />
        </button>
        <button type="button" className="icon-button" title={t("explorer.refresh")} aria-label={t("explorer.refresh")} onClick={() => void controller.refreshTree()}>
          <Icon name="refresh" />
        </button>
        <button type="button" className="icon-button" title={t("explorer.collapseAll")} aria-label={t("explorer.collapseAll")} onClick={() => controller.collapseAll()}>
          <Icon name="collapse" />
        </button>
      </div>
      <input
        className="explorer-filter"
        type="search"
        value={filter}
        placeholder={t("explorer.filter")}
        aria-label={t("explorer.filter")}
        onChange={(event) => controller.setExplorerFilter(event.target.value)}
      />
      {project.truncated && <p className="explorer-note">{t("explorer.truncated")}</p>}
      {project.skipped > 0 && <p className="explorer-note">{t("explorer.skipped", { count: project.skipped })}</p>}
      {rows.length === 0 && filter !== "" && <p className="explorer-note">{t("explorer.noMatch")}</p>}
      <div
        ref={viewportRef}
        className="tree-viewport"
        role="tree"
        aria-label={t("explorer.title")}
        tabIndex={0}
        aria-activedescendant={activeId}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="tree-spacer" style={{ height: rows.length * ROW_HEIGHT }}>
          {visible.map((row, offset) => {
            const index = first + offset;
            const { node } = row;
            const isSelected = node.path === selectedPath;
            return (
              <div
                key={node.path}
                id={`tree-row-${index}`}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={isSelected}
                aria-expanded={node.kind === "directory" ? row.expanded : undefined}
                className={`tree-row${isSelected ? " selected" : ""}${index === safeFocus ? " focused" : ""}`}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 8 + row.depth * 14 }}
                title={node.path}
                onClick={() => activate(row)}
              >
                <span className="tree-chevron">{node.kind === "directory" && <Icon name={row.expanded ? "chevronDown" : "chevronRight"} size={14} />}</span>
                <Icon name={node.kind === "directory" ? "folder" : "file"} size={15} className="tree-icon" />
                <span className="tree-name">{node.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
