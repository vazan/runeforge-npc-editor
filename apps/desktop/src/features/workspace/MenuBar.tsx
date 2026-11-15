import { useEffect, useRef, useState } from "react";
import { COMMANDS, formatShortcut, type MenuId } from "../../app/commands";
import { useAppState, useController, useT } from "../../app/context";
import type { MessageKey } from "../../i18n/messages";

const MENUS: readonly { readonly id: MenuId; readonly title: MessageKey }[] = [
  { id: "file", title: "menu.file" },
  { id: "view", title: "menu.view" },
  { id: "go", title: "menu.go" },
  { id: "help", title: "menu.help" },
];

/** Barre de menus (motif ARIA `menubar`) : les memes commandes que la palette et les raccourcis. */
export function MenuBar() {
  const controller = useController();
  const t = useT();
  const state = useAppState((current) => current);
  const [open, setOpen] = useState<MenuId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, id: MenuId): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(null);
      document.getElementById(`menu-button-${id}`)?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="menubar" role="menubar" ref={rootRef}>
      <span className="menubar-title">{t("app.name")}</span>
      {MENUS.map((menu) => {
        const commands = COMMANDS.filter((command) => command.menu === menu.id);
        const expanded = open === menu.id;
        return (
          <div key={menu.id} className="menu">
            <button
              id={`menu-button-${menu.id}`}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={expanded}
              className={`menu-button${expanded ? " open" : ""}`}
              onClick={() => setOpen(expanded ? null : menu.id)}
              onMouseEnter={() => open !== null && setOpen(menu.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setOpen(menu.id);
                  requestAnimationFrame(() => document.querySelector<HTMLElement>(`#menu-${menu.id} [role="menuitem"]`)?.focus());
                }
              }}
            >
              {t(menu.title)}
            </button>
            {expanded && (
              <div id={`menu-${menu.id}`} className="menu-popup" role="menu" aria-labelledby={`menu-button-${menu.id}`} onKeyDown={(event) => onMenuKeyDown(event, menu.id)}>
                {commands.map((command) => {
                  const enabled = command.enabled === undefined || command.enabled(state);
                  return (
                    <button
                      key={command.id}
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      aria-disabled={!enabled}
                      onClick={() => {
                        if (!enabled) return;
                        setOpen(null);
                        void command.run(controller);
                      }}
                    >
                      <span>{t(command.title)}</span>
                      {command.shortcut !== undefined && <kbd>{formatShortcut(command.shortcut)}</kbd>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
