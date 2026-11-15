import { useAppState, useController, useT } from "../app/context";
import { Icon, type IconName } from "./Icon";

const ICONS: Record<"info" | "success" | "warning" | "error", IconName> = {
  info: "info",
  success: "check",
  warning: "warning",
  error: "error",
};

/** Notifications temporaires, annoncees aux lecteurs d'ecran (`role="status"`). */
export function Toasts() {
  const toasts = useAppState((state) => state.toasts);
  const controller = useController();
  const t = useT();
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          <Icon name={ICONS[toast.kind]} />
          <span className="toast-text">{toast.text}</span>
          <button type="button" className="icon-button" aria-label={t("toast.dismiss")} onClick={() => controller.dismissToast(toast.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
