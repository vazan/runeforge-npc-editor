import { useAppState, useController, useServices, useT } from "../../app/context";
import { Icon } from "../../components/Icon";

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function EditorTabs() {
  const controller = useController();
  const t = useT();
  const tabs = useAppState((state) => state.tabs);
  const activePath = useAppState((state) => state.activePath);
  const docs = useAppState((state) => state.docs);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = activePath === null ? 0 : tabs.indexOf(activePath);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else next = tabs.length - 1;
    const path = tabs[next];
    if (path !== undefined) controller.activateTab(path);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  };

  return (
    <div className="tabs" role="tablist" aria-label={t("tabs.none")} onKeyDown={onKeyDown}>
      {tabs.map((path, index) => {
        const active = path === activePath;
        const dirty = docs[path]?.dirty === true;
        const name = basename(path);
        return (
          <div key={path} className={`tab${active ? " active" : ""}`} onAuxClick={(event) => event.button === 1 && void controller.requestCloseTab(path)}>
            <button
              type="button"
              id={`tab-${index}`}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className="tab-label"
              title={path}
              onClick={() => controller.activateTab(path)}
            >
              <Icon name="file" size={14} />
              <span>{name}</span>
              {dirty && <span className="tab-dirty" role="img" aria-label={t("tabs.modified")} title={t("tabs.modified")} />}
            </button>
            <button type="button" className="icon-button tab-close" aria-label={t("tabs.close", { name })} title={t("tabs.close", { name })} onClick={() => void controller.requestCloseTab(path)}>
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Banners({ path }: { readonly path: string }) {
  const controller = useController();
  const t = useT();
  const info = useAppState((state) => state.docs[path]);
  const project = useAppState((state) => state.project);
  const dismissed = useAppState((state) => state.dismissedBanners);
  if (info === undefined) return null;

  const key = (name: string): string => `${name}:${path}`;
  const banners: React.ReactNode[] = [];

  if (info.external === "modified") {
    banners.push(
      <div key="external" className="banner banner-warning" role="alert">
        <span>{t("banner.external.modified")}</span>
        <button type="button" className="button button-small" onClick={() => controller.openDialog({ kind: "diff", path })}>
          {t("banner.compare")}
        </button>
        <button type="button" className="button button-small" onClick={() => void controller.reloadFromDisk(path)}>
          {t("banner.reload")}
        </button>
        <button type="button" className="button button-small" onClick={() => void controller.save(path, { overwrite: true })}>
          {t("conflict.overwrite")}
        </button>
      </div>,
    );
  } else if (info.external === "deleted") {
    banners.push(
      <div key="deleted" className="banner banner-warning" role="alert">
        <span>{t("banner.external.deleted")}</span>
        <button type="button" className="button button-small" onClick={() => void controller.save(path, { overwrite: true })}>
          {t("conflict.recreate")}
        </button>
      </div>,
    );
  }
  if (info.warnings.some((warning) => warning.code === "legacy-encoding-assumed") && !dismissed.includes(key("legacy"))) {
    banners.push(
      <div key="legacy" className="banner banner-info">
        <span>{t("banner.legacyEncoding", { encoding: info.encoding })}</span>
        <button type="button" className="button button-small" onClick={() => controller.dismissBanner(key("legacy"))}>
          {t("banner.dismiss")}
        </button>
      </div>,
    );
  }
  if (info.eol === "mixed" && !dismissed.includes(key("eol"))) {
    banners.push(
      <div key="eol" className="banner banner-info">
        <span>{t("banner.mixedEol")}</span>
        <button type="button" className="button button-small" onClick={() => controller.dismissBanner(key("eol"))}>
          {t("banner.dismiss")}
        </button>
      </div>,
    );
  }
  if (project !== null && !project.configExists && !dismissed.includes("noConfig")) {
    banners.push(
      <div key="config" className="banner banner-info">
        <span>{t("banner.noConfig")}</span>
        <button type="button" className="button button-small" onClick={() => void controller.createProjectConfig()}>
          {t("banner.createConfig")}
        </button>
        <button type="button" className="button button-small" onClick={() => controller.dismissBanner("noConfig")}>
          {t("banner.dismiss")}
        </button>
      </div>,
    );
  }
  return <div className="banners">{banners}</div>;
}

export function EditorArea() {
  const t = useT();
  const activePath = useAppState((state) => state.activePath);
  const tabs = useAppState((state) => state.tabs);
  const { surfaces } = useServices();
  const Surface = surfaces.Editor;

  return (
    <section className="editor-area" aria-label="Editor">
      {tabs.length > 0 && <EditorTabs />}
      {activePath === null ? (
        <div className="editor-empty">
          <h2>{t("tabs.none")}</h2>
          <p>{t("tabs.noneHint")}</p>
        </div>
      ) : (
        <>
          <Banners path={activePath} />
          <div className="editor-surface" role="tabpanel" aria-label={basename(activePath)}>
            <Surface path={activePath} />
          </div>
        </>
      )}
    </section>
  );
}
