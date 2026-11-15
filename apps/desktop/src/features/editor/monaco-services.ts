import type { EditorServices } from "../../app/controller";

/**
 * Services d'edition adosses a Monaco. Monaco (plusieurs Mio) n'est charge qu'a la premiere ouverture d'un fichier :
 * l'ecran d'accueil reste instantane.
 */
export function createMonacoEditorServices(): EditorServices {
  let loaded: typeof import("./monaco-setup") | null = null;
  return {
    async ready() {
      loaded ??= await import("./monaco-setup");
    },
    createBuffer(initialText, path, onEdit) {
      if (loaded === null) throw new Error("Monaco n'est pas charge");
      return loaded.createModelBuffer(initialText, path, onEdit);
    },
    insertAtCursor(text, insideString) {
      return loaded?.insertAtCursor(text, insideString) ?? false;
    },
    appendText(path, text) {
      return loaded?.appendToModel(path, text) ?? false;
    },
    applyEdit(path, start, end, text) {
      return loaded?.applyEditToModel(path, start, end, text) ?? false;
    },
  };
}
