import { describeDiagnostic, type ParseDiagnostic } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";
import { useId, useState } from "react";
import { useAppState, useController, useServices, useT } from "../../app/context";
import { AIProviderError, isRemoteAIEndpoint, requestAIProposal } from "./ai";

type PanelError = "consent" | "endpoint" | "request" | "response" | "invalidProposal" | "validationUnavailable" | "validationFailed" | "fileExists" | "fileInvalid" | "settingsSave";

function isCompleteNpc(source: string): boolean {
  const parsed = parse(source);
  const declarations = parsed.ast.declarations;
  return !parsed.truncated &&
    parsed.diagnostics.every((diagnostic) => diagnostic.severity !== "error") &&
    declarations.length === 1 &&
    declarations[0]?.kind === "NpcDeclaration" &&
    declarations[0].range.start >= 0 &&
    declarations[0].range.end <= source.length &&
    declarations[0].body !== null &&
    declarations[0].body.closeRange !== null;
}

export function AIProposalPanel({ source, mode = "proposal" }: { readonly source: string; readonly mode?: "proposal" | "generate" }) {
  const controller = useController();
  const { surfaces } = useServices();
  const t = useT();
  const language = useAppState((state) => state.language);
  const aiSettings = useAppState((state) => state.settings.ai);
  const id = useId();
  const generating = mode === "generate";
  const [endpoint, setEndpoint] = useState(aiSettings.endpoint);
  const [model, setModel] = useState(aiSettings.model);
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState(t(generating ? "ai.defaultGenerationPrompt" : "ai.defaultProposalPrompt"));
  const [sourceConsent, setSourceConsent] = useState(false);
  const [remoteConsent, setRemoteConsent] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [filePath, setFilePath] = useState("npc/custom/ai_proposal.txt");
  const [error, setError] = useState<PanelError | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly ParseDiagnostic[]>([]);
  const [busy, setBusy] = useState(false);

  let remote: boolean | null = null;
  try {
    remote = isRemoteAIEndpoint(endpoint);
  } catch (caught) {
    if (!(caught instanceof AIProviderError) || caught.code !== "invalid-endpoint") throw caught;
  }

  const resetProposal = (): void => {
    setProposal(null);
    setError(null);
    setDiagnostics([]);
    setSourceConsent(false);
    setRemoteConsent(false);
  };

  const request = async (): Promise<void> => {
    if (!sourceConsent || remote === null || (remote && !remoteConsent)) {
      setError("consent");
      return;
    }
    setBusy(true);
    setError(null);
    setProposal(null);
    setDiagnostics([]);
    try {
      if (!await controller.updateSettings({ ai: { endpoint, model } })) {
        setError("settingsSave");
        return;
      }
      const candidate = await requestAIProposal(
        { endpoint, model, apiKey, prompt, source },
        { accepted: sourceConsent, allowRemote: remoteConsent, endpoint, model, prompt, source },
      );
      if (!isCompleteNpc(candidate)) {
        setError("invalidProposal");
        return;
      }
      const diagnostics = await controller.previewWizardDiagnostics(candidate);
      if (diagnostics === null) {
        setError("validationUnavailable");
        return;
      }
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      setDiagnostics(diagnostics);
      if (errors.length > 0) {
        setError("validationFailed");
        return;
      }
      setProposal(candidate);
      setSourceConsent(false);
      setRemoteConsent(false);
    } catch (caught) {
      if (caught instanceof AIProviderError) {
        if (caught.code === "consent-required") setError("consent");
        else if (caught.code === "invalid-endpoint") setError("endpoint");
        else if (caught.code === "response") setError("response");
        else setError("request");
      } else if (caught instanceof TypeError) {
        setError("request");
      } else {
        throw caught;
      }
    } finally {
      setApiKey("");
      setBusy(false);
    }
  };

  const createFile = async (): Promise<void> => {
    if (proposal === null || !isCompleteNpc(proposal) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await controller.createWizardFile(filePath, proposal);
      if (outcome === "exists") setError("fileExists");
      else if (outcome === "invalid") setError("fileInvalid");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="ai-proposal-panel" open={generating}>
      <summary>{t(generating ? "ai.generateTitle" : "ai.title")}</summary>
      <p className="hint">{t(generating ? "ai.generateDisclaimer" : "ai.disclaimer")}</p>
      {source.trim() === "" ? <p>{t("ai.noSource")}</p> : (
        <>
          <p>{t("ai.includedSource")}</p>
          <pre className="visual-builder-preview" tabIndex={0}>{source}</pre>
        </>
      )}
      <div className="field">
        <label htmlFor={`${id}-endpoint`}>{t("ai.endpoint")}</label>
        <input id={`${id}-endpoint`} type="url" autoComplete="url" value={endpoint} onChange={(event) => {
          setEndpoint(event.target.value);
          resetProposal();
          setRemoteConsent(false);
        }} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-model`}>{t("ai.model")}</label>
        <input id={`${id}-model`} type="text" autoComplete="off" value={model} onChange={(event) => {
          setModel(event.target.value);
          resetProposal();
        }} />
      </div>
      <p className="hint">{t("ai.modelHint")}</p>
      <div className="field">
        <label htmlFor={`${id}-key`}>{t("ai.apiKey")}</label>
        <input id={`${id}-key`} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => {
          setApiKey(event.target.value);
          resetProposal();
        }} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-prompt`}>{t("ai.prompt")}</label>
        <textarea id={`${id}-prompt`} value={prompt} maxLength={4000} rows={3} onChange={(event) => {
          setPrompt(event.target.value);
          resetProposal();
        }} />
      </div>
      <label className="ai-proposal-consent">
        <input type="checkbox" checked={sourceConsent} onChange={(event) => setSourceConsent(event.target.checked)} />
        {t(generating ? "ai.generateSourceConsent" : "ai.sourceConsent")}
      </label>
      {remote === true && (
        <label className="ai-proposal-consent">
          <input type="checkbox" checked={remoteConsent} onChange={(event) => setRemoteConsent(event.target.checked)} />
          {t("ai.remoteConsent")}
        </label>
      )}
      {remote === null && <p className="field-error" role="alert">{t("ai.error.endpoint")}</p>}
      <button type="button" className="button" disabled={busy || remote === null || model.trim() === "" || !sourceConsent || (remote && !remoteConsent)} onClick={() => void request()}>
        {busy ? t("ai.requesting") : t(generating ? "ai.generateRequest" : "ai.request")}
      </button>
      {error !== null && (
        <p className="field-error" role="alert">
          {error === "settingsSave" ? t("settings.saveFailed") : t(`ai.error.${error}`)}
        </p>
      )}
      {diagnostics.length > 0 && (
        <ul className="hint" aria-label={t("ai.diagnostics")}>
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}:${index}`}>
              {t(`ai.diagnostic.${diagnostic.severity}`)} {diagnostic.code}: {describeDiagnostic(diagnostic, language).message}
            </li>
          ))}
        </ul>
      )}
      {proposal !== null && (
        <section aria-labelledby={`${id}-diff`}>
          <h4 id={`${id}-diff`}>{t("ai.diff")}</h4>
          <div className="ai-proposal-diff">
            <surfaces.Diff
              original={source}
              modified={proposal}
              originalLabel={t(source.trim() === "" ? "ai.noSource" : "ai.before")}
              modifiedLabel={t(generating ? "ai.generated" : "ai.after")}
            />
          </div>
          <label className="field" htmlFor={`${id}-path`}>{t("ai.filePath")}</label>
          <input id={`${id}-path`} type="text" value={filePath} onChange={(event) => setFilePath(event.target.value)} />
          <p className="hint">{t("ai.approvalHint")}</p>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => void createFile()}>
            {t("ai.approve")}
          </button>
        </section>
      )}
    </details>
  );
}
