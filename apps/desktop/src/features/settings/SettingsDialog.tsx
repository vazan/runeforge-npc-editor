import {
  formatCustomCommands,
  formatCustomConstants,
  getLegacyCodec,
  normalizeRelativeDirectory,
  parseCustomCommandLines,
  parseCustomConstantLines,
  type CrossFileChecks,
  type EmulatorFamily,
  type EmulatorMode,
  type IndexScope,
  type ProjectConfig,
  type UnknownCommandPolicy,
} from "@runeforge/project-core";
import { useMemo, useState } from "react";
import { useAppState, useController, useT } from "../../app/context";
import { Modal } from "../../components/Modal";
import type { MessageKey } from "../../i18n/messages";
import type { SettingsTab } from "../../state/store";
import { UpdatesTab } from "./UpdatesTab";

const TABS: readonly { readonly id: SettingsTab; readonly label: MessageKey }[] = [
  { id: "general", label: "settings.tab.general" },
  { id: "editor", label: "settings.tab.editor" },
  { id: "project", label: "settings.tab.project" },
  { id: "ai", label: "settings.tab.ai" },
  { id: "privacy", label: "settings.tab.privacy" },
  { id: "updates", label: "settings.tab.updates" },
  { id: "about", label: "settings.tab.about" },
];

const lines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

function GeneralTab() {
  const controller = useController();
  const t = useT();
  const settings = useAppState((state) => state.settings);
  return (
    <>
      <label className="field">
        {t("settings.language")}
        <select value={settings.language} onChange={(event) => void controller.updateSettings({ language: event.target.value as "system" | "fr" | "en" })}>
          <option value="system">{t("settings.language.system")}</option>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </label>
      <label className="field">
        {t("settings.theme")}
        <select value={settings.theme} onChange={(event) => void controller.updateSettings({ theme: event.target.value as "system" | "light" | "dark" })}>
          <option value="system">{t("settings.theme.system")}</option>
          <option value="light">{t("settings.theme.light")}</option>
          <option value="dark">{t("settings.theme.dark")}</option>
        </select>
      </label>
    </>
  );
}

function EditorTab() {
  const controller = useController();
  const t = useT();
  const { editor, recovery } = useAppState((state) => state.settings);
  const number = (value: string, fallback: number): number => (Number.isFinite(Number(value)) && value !== "" ? Number(value) : fallback);
  return (
    <>
      <label className="field">
        {t("settings.fontSize")}
        <input type="number" min={8} max={40} value={editor.fontSize} onChange={(event) => void controller.updateSettings({ editor: { fontSize: number(event.target.value, editor.fontSize) } })} />
      </label>
      <label className="field">
        {t("settings.tabSize")}
        <input type="number" min={1} max={8} value={editor.tabSize} onChange={(event) => void controller.updateSettings({ editor: { tabSize: number(event.target.value, editor.tabSize) } })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={editor.insertSpaces} aria-describedby="spaces-hint" onChange={(event) => void controller.updateSettings({ editor: { insertSpaces: event.target.checked } })} />
        {t("settings.insertSpaces")}
      </label>
      <p id="spaces-hint" className="hint">
        {t("settings.insertSpaces.hint")}
      </p>
      <label className="check">
        <input type="checkbox" checked={editor.wordWrap} onChange={(event) => void controller.updateSettings({ editor: { wordWrap: event.target.checked } })} />
        {t("settings.wordWrap")}
      </label>
      <label className="check">
        <input type="checkbox" checked={editor.minimap} onChange={(event) => void controller.updateSettings({ editor: { minimap: event.target.checked } })} />
        {t("settings.minimap")}
      </label>
      <label className="field">
        {t("settings.renderWhitespace")}
        <select value={editor.renderWhitespace} onChange={(event) => void controller.updateSettings({ editor: { renderWhitespace: event.target.value as "none" | "boundary" | "all" } })}>
          <option value="none">{t("settings.renderWhitespace.none")}</option>
          <option value="boundary">{t("settings.renderWhitespace.boundary")}</option>
          <option value="all">{t("settings.renderWhitespace.all")}</option>
        </select>
      </label>
      <label className="field">
        {t("settings.snapshotDelay")}
        <input
          type="number"
          min={300}
          max={60000}
          step={100}
          value={recovery.snapshotDelayMs}
          onChange={(event) => void controller.updateSettings({ recovery: { snapshotDelayMs: number(event.target.value, recovery.snapshotDelayMs) } })}
        />
      </label>
    </>
  );
}

function ProjectTab() {
  const controller = useController();
  const t = useT();
  const project = useAppState((state) => state.project);
  const config = project?.config;
  const [name, setName] = useState(config?.projectName ?? "");
  const [family, setFamily] = useState<EmulatorFamily>(config?.emulator.family ?? "rathena");
  const [version, setVersion] = useState(config?.emulator.version ?? "custom");
  const [revision, setRevision] = useState(config?.emulator.revision ?? "");
  const [serverRoot, setServerRoot] = useState(config?.emulator.root ?? "");
  const [mode, setMode] = useState<EmulatorMode>(config?.emulator.mode ?? "auto");
  const [indexScope, setIndexScope] = useState<IndexScope>(config?.emulator.indexScope ?? "sources");
  const candidates = useAppState((state) => state.emulator.candidates);
  const [customCommands, setCustomCommands] = useState(formatCustomCommands(config?.commands.custom ?? []));
  const customParsed = useMemo(() => parseCustomCommandLines(customCommands, config?.commands.custom ?? []), [customCommands, config]);
  const [sources, setSources] = useState((config?.sources ?? []).join("\n"));
  const [exclude, setExclude] = useState((config?.exclude ?? []).join("\n"));
  const [databasePaths, setDatabasePaths] = useState((config?.databasePaths ?? []).join("\n"));
  const [policy, setPolicy] = useState<UnknownCommandPolicy>(config?.validation.unknownCommands ?? "warning");
  const [referencePolicy, setReferencePolicy] = useState<UnknownCommandPolicy>(config?.validation.unknownReferences ?? "info");
  const [customConstants, setCustomConstants] = useState(formatCustomConstants(config?.constants.custom ?? []));
  const constantsParsed = useMemo(() => parseCustomConstantLines(customConstants), [customConstants]);
  const [crossFile, setCrossFile] = useState<CrossFileChecks>(config?.validation.crossFile ?? "off");
  const [legacy, setLegacy] = useState(config?.encoding.legacy ?? "windows-1252");

  if (project === null || config === undefined) return <p className="hint">{t("settings.project.none")}</p>;
  const legacyValid = getLegacyCodec(legacy) !== null;
  const normalizedRoot = normalizeRelativeDirectory(serverRoot);
  const rootValid = normalizedRoot !== null;

  const apply = (): void => {
    const next: ProjectConfig = {
      ...config,
      projectName: name.trim() === "" ? config.projectName : name.trim(),
      emulator: {
        family,
        version: version.trim() === "" ? "custom" : version.trim(),
        revision: revision.trim() === "" ? null : revision.trim(),
        root: normalizedRoot ?? config.emulator.root,
        mode,
        indexScope,
      },
      sources: lines(sources),
      exclude: lines(exclude),
      databasePaths: lines(databasePaths),
      validation: { unknownCommands: policy, unknownReferences: referencePolicy, crossFile },
      // Une ligne invalide est signalee sous le champ : la liste enregistree reste celle d'avant tant qu'elle n'est pas corrigee.
      commands: { custom: customParsed.errors.length > 0 ? config.commands.custom : customParsed.commands },
      constants: { custom: constantsParsed.errors.length > 0 ? config.constants.custom : constantsParsed.constants },
      encoding: { legacy: legacyValid ? legacy.trim() : config.encoding.legacy },
    };
    void controller.saveProjectConfig(next);
  };

  return (
    <>
      <label className="field">
        {t("settings.project.name")}
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        {t("settings.project.emulator")}
        <select value={family} onChange={(event) => setFamily(event.target.value as EmulatorFamily)}>
          <option value="rathena">{t("settings.project.emulator.rathena")}</option>
          <option value="hercules">{t("settings.project.emulator.hercules")}</option>
        </select>
      </label>
      <label className="field">
        {t("settings.project.version")}
        <input type="text" value={version} onChange={(event) => setVersion(event.target.value)} />
      </label>
      <label className="field">
        {t("settings.project.revision")}
        <input type="text" value={revision} onChange={(event) => setRevision(event.target.value)} />
      </label>
      <label className="field">
        {t("settings.project.serverRoot")}
        <input
          type="text"
          list="server-root-candidates"
          spellCheck={false}
          value={serverRoot}
          aria-invalid={!rootValid}
          aria-describedby="server-root-hint"
          onChange={(event) => setServerRoot(event.target.value)}
        />
        <datalist id="server-root-candidates">
          {candidates.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
      </label>
      <p id="server-root-hint" className={rootValid ? "hint" : "field-error"}>
        {rootValid ? t("settings.project.serverRoot.hint") : t("settings.project.serverRoot.invalid")}
      </p>
      <label className="field">
        {t("settings.project.mode")}
        <select value={mode} onChange={(event) => setMode(event.target.value as EmulatorMode)}>
          <option value="auto">{t("settings.project.mode.auto")}</option>
          <option value="renewal">{t("settings.project.mode.renewal")}</option>
          <option value="pre-renewal">{t("settings.project.mode.preRenewal")}</option>
        </select>
      </label>
      <label className="field">
        {t("settings.project.indexScope")}
        <select value={indexScope} aria-describedby="index-scope-hint" onChange={(event) => setIndexScope(event.target.value as IndexScope)}>
          <option value="sources">{t("settings.project.indexScope.sources")}</option>
          <option value="loaded">{t("settings.project.indexScope.loaded")}</option>
        </select>
      </label>
      <p id="index-scope-hint" className="hint">
        {t("settings.project.indexScope.hint")}
      </p>
      <label className="field">
        {t("settings.project.sources")}
        <textarea rows={3} spellCheck={false} value={sources} onChange={(event) => setSources(event.target.value)} />
      </label>
      <label className="field">
        {t("settings.project.exclude")}
        <textarea rows={3} spellCheck={false} value={exclude} onChange={(event) => setExclude(event.target.value)} />
      </label>
      <label className="field">
        {t("settings.project.databasePaths")}
        <textarea rows={2} spellCheck={false} value={databasePaths} onChange={(event) => setDatabasePaths(event.target.value)} />
      </label>
      <label className="field">
        {t("settings.project.unknownCommands")}
        <select value={policy} onChange={(event) => setPolicy(event.target.value as UnknownCommandPolicy)}>
          <option value="off">{t("settings.project.unknownCommands.off")}</option>
          <option value="info">{t("settings.project.unknownCommands.info")}</option>
          <option value="warning">{t("settings.project.unknownCommands.warning")}</option>
          <option value="error">{t("settings.project.unknownCommands.error")}</option>
        </select>
      </label>
      <label className="field">
        {t("settings.project.customCommands")}
        <textarea
          rows={3}
          spellCheck={false}
          value={customCommands}
          aria-invalid={customParsed.errors.length > 0}
          aria-describedby="custom-commands-hint"
          onChange={(event) => setCustomCommands(event.target.value)}
        />
      </label>
      <p id="custom-commands-hint" className="hint">
        {t("settings.project.customCommands.hint")}
      </p>
      {customParsed.errors.slice(0, 5).map((error) => (
        <p key={error.line} className="field-error">
          {t("settings.project.customCommands.error", { line: error.line, text: error.text })} — {t(`settings.project.customCommands.reason.${error.reason}` as MessageKey)}
        </p>
      ))}
      <label className="field">
        {t("settings.project.unknownReferences")}
        <select value={referencePolicy} aria-describedby="unknown-references-hint" onChange={(event) => setReferencePolicy(event.target.value as UnknownCommandPolicy)}>
          <option value="off">{t("settings.project.unknownCommands.off")}</option>
          <option value="info">{t("settings.project.unknownCommands.info")}</option>
          <option value="warning">{t("settings.project.unknownCommands.warning")}</option>
          <option value="error">{t("settings.project.unknownCommands.error")}</option>
        </select>
      </label>
      <p id="unknown-references-hint" className="hint">
        {t("settings.project.unknownReferences.hint")}
      </p>
      <label className="field">
        {t("settings.project.customConstants")}
        <textarea
          rows={3}
          spellCheck={false}
          value={customConstants}
          aria-invalid={constantsParsed.errors.length > 0}
          aria-describedby="custom-constants-hint"
          onChange={(event) => setCustomConstants(event.target.value)}
        />
      </label>
      <p id="custom-constants-hint" className="hint">
        {t("settings.project.customConstants.hint")}
      </p>
      {constantsParsed.errors.slice(0, 5).map((error) => (
        <p key={error.line} className="field-error">
          {t("settings.project.customCommands.error", { line: error.line, text: error.text })} — {t(`settings.project.customConstants.reason.${error.reason}` as MessageKey)}
        </p>
      ))}
      <label className="field">
        {t("settings.project.crossFile")}
        <select value={crossFile} aria-describedby="crossfile-hint" onChange={(event) => setCrossFile(event.target.value as CrossFileChecks)}>
          <option value="off">{t("settings.project.crossFile.off")}</option>
          <option value="duplicates">{t("settings.project.crossFile.duplicates")}</option>
          <option value="all">{t("settings.project.crossFile.all")}</option>
        </select>
      </label>
      <p id="crossfile-hint" className="hint">
        {t("settings.project.crossFile.hint")}
      </p>
      <label className="field">
        {t("settings.project.legacyEncoding")}
        <input type="text" value={legacy} aria-invalid={!legacyValid} aria-describedby="legacy-hint" onChange={(event) => setLegacy(event.target.value)} />
      </label>
      <p id="legacy-hint" className={legacyValid ? "hint" : "field-error"}>
        {legacyValid ? t("settings.project.legacyEncoding.hint") : t("error.unknown")}
      </p>
      <button type="button" className="button button-primary" onClick={apply}>
        {t("settings.project.apply")}
      </button>
    </>
  );
}

function PrivacyTab() {
  const controller = useController();
  const t = useT();
  const logging = useAppState((state) => state.settings.logging.enabled);
  return (
    <>
      <p>{t("settings.privacy.network")}</p>
      <label className="check">
        <input type="checkbox" checked={logging} onChange={(event) => void controller.updateSettings({ logging: { enabled: event.target.checked } })} />
        {t("settings.privacy.logging")}
      </label>
      <p className="hint">{t("settings.privacy.loggingWhere")}</p>
    </>
  );
}

function AITab() {
  const controller = useController();
  const t = useT();
  const ai = useAppState((state) => state.settings.ai);
  const [endpoint, setEndpoint] = useState(ai.endpoint);
  const [model, setModel] = useState(ai.model);
  const [saveFailed, setSaveFailed] = useState(false);
  const save = async (): Promise<void> => {
    setSaveFailed(!(await controller.updateSettings({ ai: { endpoint, model } })));
  };
  return (
    <>
      <p>{t("settings.ai.description")}</p>
      <label className="field">
        {t("ai.endpoint")}
        <input
          type="url"
          autoComplete="url"
          value={endpoint}
          aria-describedby="settings-ai-endpoint-hint"
          onChange={(event) => setEndpoint(event.target.value)}
        />
      </label>
      <p id="settings-ai-endpoint-hint" className="hint">{t("settings.ai.endpointHint")}</p>
      <label className="field">
        {t("ai.model")}
        <input
          type="text"
          autoComplete="off"
          value={model}
          aria-describedby="settings-ai-model-hint"
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <p id="settings-ai-model-hint" className="hint">{t("settings.ai.modelHint")}</p>
      {saveFailed && <p className="field-error" role="alert">{t("settings.saveFailed")}</p>}
      <button type="button" className="button button-primary" onClick={() => void save()}>
        {t("settings.ai.save")}
      </button>
    </>
  );
}

function AboutTab() {
  const t = useT();
  const version = useAppState((state) => state.appVersion);
  const platform = useAppState((state) => state.platform);
  return (
    <>
      <p>
        <strong>{t("app.name")}</strong> — {t("app.tagline")}
      </p>
      <p>{t("settings.about.version", { version })}</p>
      <p>{t("settings.about.platform", { platform })}</p>
      <p className="hint">{t("app.unofficial")}</p>
      <p className="hint">{t("settings.about.license")}</p>
    </>
  );
}

export function SettingsDialog({ tab: initialTab }: { readonly tab: SettingsTab }) {
  const controller = useController();
  const t = useT();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const close = (): void => controller.closeDialog();

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(index + (event.key === "ArrowDown" ? 1 : -1) + TABS.length) % TABS.length];
    if (next !== undefined) {
      setTab(next.id);
      requestAnimationFrame(() => document.getElementById(`settings-tab-${next.id}`)?.focus());
    }
  };

  return (
    <Modal
      title={t("settings.title")}
      wide
      onDismiss={close}
      actions={
        <button type="button" className="button button-primary" data-autofocus onClick={close}>
          {t("dialog.close")}
        </button>
      }
    >
      <div className="settings">
        <div className="settings-tabs" role="tablist" aria-label={t("settings.title")} aria-orientation="vertical" onKeyDown={onTabKeyDown}>
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`settings-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="settings-panel"
              tabIndex={tab === item.id ? 0 : -1}
              className={`settings-tab${tab === item.id ? " active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <div id="settings-panel" className="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
          {tab === "general" && <GeneralTab />}
          {tab === "editor" && <EditorTab />}
          {tab === "project" && <ProjectTab />}
          {tab === "ai" && <AITab />}
          {tab === "privacy" && <PrivacyTab />}
          {tab === "updates" && <UpdatesTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}
