import { describeDiagnostic } from "@runeforge/runescript-core";
import { useEffect, useRef } from "react";
import { useAppState, useController, type EditorSurfaceProps } from "../../app/context";
import { registerLanguageFeatures } from "./language-features";
import { LANGUAGE_ID, THEME_DARK, THEME_LIGHT, modelFor, monaco } from "./monaco-setup";

const MARKER_OWNER = "runeforge";

const SEVERITY = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
} as const;

/** Surface d'edition Monaco : un seul editeur dont le modele change avec l'onglet actif. */
export default function MonacoSurface({ path }: EditorSurfaceProps) {
  const controller = useController();
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const previousPath = useRef<string | null>(null);

  const settings = useAppState((state) => state.settings);
  const theme = useAppState((state) => state.theme);
  const language = useAppState((state) => state.language);
  const diagnostics = useAppState((state) => state.diagnostics[path]);
  const reveal = useAppState((state) => state.reveal);

  // Creation unique de l'editeur.
  useEffect(() => {
    if (host.current === null) return;
    const editor = monaco.editor.create(host.current, {
      model: null,
      automaticLayout: true,
      // Les tabulations sont significatives dans les declarations rAthena/Hercules : jamais d'indentation devinee.
      detectIndentation: false,
      scrollBeyondLastLine: false,
      renderControlCharacters: true,
      fixedOverflowWidgets: true,
      accessibilitySupport: "auto",
      // Completion pendant la frappe, y compris dans une chaine (`callfunc "F_...`) ; pas de mots du document.
      quickSuggestions: { other: true, comments: false, strings: true },
      wordBasedSuggestions: "off",
      ariaLabel: "RuneScript",
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void controller.saveActive());
    editor.addCommand(monaco.KeyCode.F1, () => controller.openPalette("commands"));
    // Monaco reserve Maj+F12 a ses references (apercu limite aux modeles ouverts) : le panneau de l'application les remplace.
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F12, () => void controller.findReferences());
    registerLanguageFeatures(controller);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => controller.openPalette("commands"));
    const cursor = editor.onDidChangeCursorPosition((event) => controller.setCursor(event.position.lineNumber, event.position.column));
    return () => {
      cursor.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [controller]);

  // Changement d'onglet : conserve la position de lecture de l'ancien document et restaure celle du nouveau.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    if (previousPath.current !== null) viewStates.current.set(previousPath.current, editor.saveViewState());
    const model = modelFor(path) ?? null;
    editor.setModel(model);
    if (model !== null) {
      const saved = viewStates.current.get(path);
      if (saved !== undefined && saved !== null) editor.restoreViewState(saved);
      const position = editor.getPosition();
      if (position !== null) controller.setCursor(position.lineNumber, position.column);
      editor.focus();
    }
    previousPath.current = path;
  }, [path, controller]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: settings.editor.fontSize,
      tabSize: settings.editor.tabSize,
      insertSpaces: settings.editor.insertSpaces,
      wordWrap: settings.editor.wordWrap ? "on" : "off",
      minimap: { enabled: settings.editor.minimap },
      renderWhitespace: settings.editor.renderWhitespace,
    });
  }, [settings.editor]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? THEME_DARK : THEME_LIGHT);
  }, [theme]);

  // Marqueurs : message localise + conseil de correction + niveau de confiance.
  useEffect(() => {
    const model = modelFor(path);
    if (model === undefined) return;
    if (diagnostics === undefined) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      return;
    }
    const markers: monaco.editor.IMarkerData[] = diagnostics.diagnostics.map((diagnostic) => {
      const text = describeDiagnostic(diagnostic, language);
      const start = model.getPositionAt(diagnostic.range.start);
      const end = model.getPositionAt(Math.max(diagnostic.range.end, diagnostic.range.start + 1));
      return {
        severity: SEVERITY[diagnostic.severity],
        message: text.hint === undefined ? text.message : `${text.message}\n${text.hint}`,
        code: diagnostic.code,
        source: `RuneForge (${diagnostic.confidence})`,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
    });
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  }, [diagnostics, language, path]);

  // Affichage d'une position demandee depuis le panneau des problemes.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || reveal === null || reveal.path !== path) return;
    const position = { lineNumber: reveal.line, column: reveal.column };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [reveal, path]);

  return <div ref={host} className="monaco-host" data-language={LANGUAGE_ID} />;
}
