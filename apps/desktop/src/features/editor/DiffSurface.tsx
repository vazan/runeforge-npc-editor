import { useEffect, useRef } from "react";
import { useAppState, type DiffSurfaceProps } from "../../app/context";
import { LANGUAGE_ID, THEME_DARK, THEME_LIGHT, monaco } from "./monaco-setup";

function labelPane(pane: monaco.editor.ICodeEditor, ariaLabel: string) {
  const option = monaco.editor.EditorOption.ariaLabel;
  pane.updateOptions({ ariaLabel });
  // Monaco can reset the pane label when it recalculates the diff layout.
  return pane.onDidChangeConfiguration((event) => {
    if (event.hasChanged(option) && pane.getOption(option) !== ariaLabel) pane.updateOptions({ ariaLabel });
  });
}

/** Comparaison cote a cote (lecture seule) de deux versions d'un texte. */
export default function DiffSurface({ original, modified, originalLabel, modifiedLabel }: DiffSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useAppState((state) => state.theme);

  useEffect(() => {
    if (host.current === null) return;
    monaco.editor.setTheme(theme === "dark" ? THEME_DARK : THEME_LIGHT);
    const editor = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      renderOverviewRuler: false,
    });
    const originalModel = monaco.editor.createModel(original, LANGUAGE_ID);
    const modifiedModel = monaco.editor.createModel(modified, LANGUAGE_ID);
    originalModel.setEOL(monaco.editor.EndOfLineSequence.LF);
    modifiedModel.setEOL(monaco.editor.EndOfLineSequence.LF);
    editor.setModel({ original: originalModel, modified: modifiedModel });
    const originalName = labelPane(editor.getOriginalEditor(), originalLabel);
    const modifiedName = labelPane(editor.getModifiedEditor(), modifiedLabel);
    return () => {
      originalName.dispose();
      modifiedName.dispose();
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [original, modified, originalLabel, modifiedLabel, theme]);

  return (
    <div className="diff-host-wrapper">
      <div className="diff-labels">
        <span>{originalLabel}</span>
        <span>{modifiedLabel}</span>
      </div>
      <div ref={host} className="monaco-host" />
    </div>
  );
}
