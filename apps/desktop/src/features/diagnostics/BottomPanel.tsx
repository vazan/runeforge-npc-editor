import { useAppState, useController, useT } from "../../app/context";
import type { BottomTab } from "../../state/store";
import { GitPanel } from "./GitPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { ReferencesPanel } from "./ReferencesPanel";
import { ReportPanel } from "./ReportPanel";

const TABS: readonly { readonly id: BottomTab; readonly label: "problems.title" | "references.title" | "report.title" | "git.title" }[] = [
  { id: "problems", label: "problems.title" },
  { id: "references", label: "references.title" },
  { id: "report", label: "report.title" },
  { id: "git", label: "git.title" },
];

/** Panneau du bas : problemes, references, rapport de projet et Git, un onglet a la fois. */
export function BottomPanel() {
  const controller = useController();
  const t = useT();
  const active = useAppState((state) => state.bottomTab);

  return (
    <>
      <div className="panel-tabs" role="tablist" aria-label={t("problems.title")}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`bottom-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`bottom-panel-${tab.id}`}
            className="panel-tab"
            onClick={() => controller.setBottomTab(tab.id)}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`bottom-panel-${active}`} aria-labelledby={`bottom-tab-${active}`}>
        {active === "problems" ? <ProblemsPanel /> : active === "references" ? <ReferencesPanel /> : active === "git" ? <GitPanel /> : <ReportPanel />}
      </div>
    </>
  );
}
