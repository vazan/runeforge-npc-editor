import { useController, useT } from "../../app/context";
import { Modal } from "../../components/Modal";
import { AIProposalPanel } from "./AIProposalPanel";

export function NpcPromptGeneratorDialog() {
  const controller = useController();
  const t = useT();
  return (
    <Modal
      title={t("ai.generateTitle")}
      wide
      onDismiss={() => controller.closeDialog()}
      actions={
        <button type="button" className="button button-primary" data-autofocus onClick={() => controller.closeDialog()}>
          {t("dialog.close")}
        </button>
      }
    >
      <AIProposalPanel source="" mode="generate" />
    </Modal>
  );
}
