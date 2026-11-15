import type { ReferenceHit, ReferenceKind } from "@runeforge/emulator-core";
import type { WorkspaceSymbol } from "@runeforge/runescript-language-server";
import { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS, formatShortcut } from "../../app/commands";
import { useAppState, useController, useT } from "../../app/context";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import type { MessageKey } from "../../i18n/messages";
import { rank } from "../../lib/fuzzy";
import type { PaletteMode } from "../../state/store";

interface Entry {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  /** `alt` : Maj+Entree (les bases de donnees inserent alors le nom plutot que l'identifiant). */
  readonly run: (alt: boolean) => void;
}

const REFERENCE_KINDS: readonly ReferenceKind[] = ["item", "mob", "skill", "map", "constant"];
/** `item:rouge` restreint la recherche des bases a une nature (100 resultats) ; sans prefixe, 8 par nature. */
const KIND_PREFIX = /^\s*(item|mob|skill|map|const):\s*(.*)$/i;
const KIND_OF_PREFIX: Readonly<Record<string, ReferenceKind>> = { item: "item", mob: "mob", skill: "skill", map: "map", const: "constant" };

/** Complement bref d'une reference (identifiant, nom d'affichage, type ou niveau) pour la ligne de resultat. */
function describeHit(hit: ReferenceHit): string {
  if (hit.kind === "map") return hit.id === null ? "" : `#${hit.id}`;
  if (hit.kind === "constant") return hit.id === null ? "" : `= ${hit.id}`;
  return [hit.id, hit.displayName, hit.detail].filter((part) => part !== null && part !== "").join(" · ");
}

interface TreeLike {
  readonly kind: string;
  readonly path: string;
  readonly children: readonly TreeLike[];
}

function collectFiles(tree: TreeLike | undefined): string[] {
  const files: string[] = [];
  const stack: TreeLike[] = [...(tree?.children ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.kind === "file") files.push(node.path);
    else stack.push(...node.children);
  }
  return files.sort();
}

/** Palette : "aller au fichier" (Ctrl+P), commandes (Ctrl+Maj+P, ou `>`) et symboles du projet (Ctrl+T, ou `#`). */
export function CommandPalette() {
  const open = useAppState((state) => state.palette.open);
  // Le contenu est monte a l'ouverture seulement : son etat (requete, selection) repart de zero a chaque ouverture.
  return open ? <PaletteContent /> : null;
}

function PaletteContent() {
  const controller = useController();
  const t = useT();
  const initialMode = useAppState((state) => state.palette.mode);
  const project = useAppState((state) => state.project);
  const appState = useAppState((state) => state);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const mode: PaletteMode =
    initialMode === "databases"
      ? "databases"
      : initialMode === "commands"
        ? "commands"
        : initialMode === "symbols" || query.startsWith("#")
          ? "symbols"
          : query.startsWith(">")
            ? "commands"
            : "files";
  const symbolText = query.startsWith("#") ? query.slice(1) : query;
  const files = useMemo(() => (mode === "files" ? collectFiles(project?.tree) : []), [mode, project]);
  const [symbols, setSymbols] = useState<WorkspaceSymbol[]>([]);
  const hasCatalog = appState.emulator.catalog !== null;
  const [hits, setHits] = useState<ReferenceHit[]>([]);

  // Recherche dans les bases du serveur : une nature restreinte par `item:`, `mob:`, `skill:`, `map:`, `const:`, sinon toutes.
  useEffect(() => {
    if (mode !== "databases") return;
    let cancelled = false;
    const restricted = KIND_PREFIX.exec(query);
    const kinds = restricted === null ? REFERENCE_KINDS : [KIND_OF_PREFIX[(restricted[1] ?? "").toLowerCase()] ?? "item"];
    const text = restricted === null ? query : (restricted[2] ?? "");
    const limit = restricted === null ? 8 : 100;
    void Promise.all(kinds.map((kind) => controller.searchReferences(kind, text, limit))).then((found) => {
      if (!cancelled) setHits(found.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [mode, query, controller]);

  // Recherche de symboles : le service de langage repond de facon asynchrone ; un resultat perime est ignore.
  useEffect(() => {
    if (mode !== "symbols") return;
    let cancelled = false;
    void controller.searchSymbols(symbolText, 100).then((found) => {
      if (!cancelled) setSymbols(found);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, symbolText, controller]);

  // A la fermeture, le focus revient a ce qui l'avait avant la palette, sauf si l'action choisie l'a deja place ailleurs.
  useRestoreFocus();
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const text = query.startsWith(">") ? query.slice(1) : query;
    if (mode === "symbols") {
      return symbols.map((symbol, index) => ({
        id: `${symbol.location.uri}:${symbol.location.range.start.line}:${symbol.name}:${index}`,
        label: symbol.name,
        detail: `${symbol.detail ?? ""} · ${symbol.location.uri}`,
        run: () => void controller.openLocation(symbol.location),
      }));
    }
    if (mode === "databases") {
      return hits.map((hit, index) => ({
        id: `${hit.kind}:${hit.name}:${hit.id ?? ""}:${index}`,
        label: hit.name,
        detail: `${t(`references.kind.${hit.kind}` as MessageKey)} · ${describeHit(hit)}`,
        run: (alt: boolean) => void controller.insertReference(hit, alt ? "name" : "id"),
      }));
    }
    if (mode === "commands") {
      const commands = COMMANDS.filter((command) => command.enabled === undefined || command.enabled(appState));
      return rank(text, commands, (command) => t(command.title)).map(({ item }) => ({
        id: item.id,
        label: t(item.title),
        ...(item.shortcut === undefined ? {} : { detail: formatShortcut(item.shortcut) }),
        run: () => void item.run(controller),
      }));
    }
    return rank(text, files, (path) => path, 50, true).map(({ item }) => ({
      id: item,
      label: item.slice(item.lastIndexOf("/") + 1),
      detail: item,
      run: () => void controller.openFile(item),
    }));
  }, [query, mode, files, symbols, hits, appState, controller, t]);

  const active = Math.min(selected, Math.max(0, entries.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const choose = (entry: Entry | undefined, alt = false): void => {
    if (entry === undefined) return;
    controller.closePalette();
    entry.run(alt);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(Math.min(entries.length - 1, active + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(Math.max(0, active - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(entries[active], event.shiftKey);
    }
  };

  // Echap ferme la palette d'ou que vienne la touche, et Tab ne la quitte pas : la saisie est son seul controle (la liste se
  // parcourt avec les fleches, par `aria-activedescendant`).
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      controller.closePalette();
    } else if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && controller.closePalette()}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        aria-label={mode === "files" ? t("cmd.quickOpen") : mode === "symbols" ? t("cmd.goToSymbol") : mode === "databases" ? t("cmd.searchDatabases") : t("cmd.palette")}
      >
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={entries[active] === undefined ? undefined : `palette-item-${active}`}
          value={query}
          placeholder={
            mode === "files"
              ? t("palette.placeholderFiles")
              : mode === "symbols"
                ? t("palette.placeholderSymbols")
                : mode === "databases"
                  ? t("palette.placeholderDatabases")
                  : t("palette.placeholderCommands")
          }
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul id="palette-list" ref={listRef} className="palette-list" role="listbox" aria-label={t("palette.results")}>
          {entries.length === 0 && <li className="palette-empty">{mode === "databases" && !hasCatalog ? t("palette.noDatabases") : t("palette.noResult")}</li>}
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              id={`palette-item-${index}`}
              role="option"
              aria-selected={index === active}
              className={`palette-item${index === active ? " selected" : ""}`}
              onMouseMove={() => setSelected(index)}
              onClick={() => choose(entry)}
            >
              <span>{entry.label}</span>
              {entry.detail !== undefined && <span className="palette-detail">{entry.detail}</span>}
            </li>
          ))}
        </ul>
        {mode === "files" && <p className="palette-hint">{t("palette.hintCommands")}</p>}
        {mode === "symbols" && <p className="palette-hint">{t("palette.hintSymbols")}</p>}
        {mode === "databases" && <p className="palette-hint">{t("palette.hintDatabases")}</p>}
      </div>
    </div>
  );
}
