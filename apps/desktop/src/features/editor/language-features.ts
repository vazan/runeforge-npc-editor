import { MAX_COMPLETIONS } from "@runeforge/runescript-language-server";
import type { RenameError } from "@runeforge/runescript-language-server";
import type { AppController } from "../../app/controller";
import type { MessageKey } from "../../i18n/messages";
import { formatCommand, formatHover } from "../../app/hover-text";
import { declarableCommandNames, startOf, toMonacoRange, toMonacoSignatureHelp, toMonacoSuggestion, toMonacoSymbols } from "./language-mapping";
import { LANGUAGE_ID, monaco, pathOfUri, uriForPath } from "./monaco-setup";

/**
 * Branche le service de langage sur Monaco : definition (Ctrl+clic, F12), plan du document (Ctrl+Maj+O, fil d'Ariane),
 * completion, survol et ouverture des fichiers cibles. Les references et la recherche de symboles du projet ont leurs
 * propres vues (panneau du bas, palette) car Monaco ne sait afficher que des fichiers dont le modele est deja ouvert.
 */

const RENAME_ERROR_KEYS: Readonly<Record<RenameError, MessageKey>> = {
  "not-renameable": "rename.error.not-renameable",
  "event-label": "rename.error.event-label",
  "invalid-name": "rename.error.invalid-name",
  "name-taken": "rename.error.name-taken",
  "incomplete-script": "rename.error.incomplete-script",
};

/** Nom de l'emulateur du projet ouvert, pour les textes d'aide (« rAthena »). */
function emulatorNameOf(controller: AppController): string {
  return controller.getStore().getState().project?.config.emulator.family === "hercules" ? "Hercules" : "rAthena";
}

/** Commande Monaco de l'action rapide « declarer la commande » (RF-011). */
const DECLARE_COMMAND = "runeforge.declareCustomCommand";

let registeredFor: AppController | null = null;
let registrations: monaco.IDisposable[] = [];

export function registerLanguageFeatures(controller: AppController): void {
  if (registeredFor === controller) return;
  for (const registration of registrations) registration.dispose();
  registeredFor = controller;
  registrations = [
    monaco.languages.registerDefinitionProvider(LANGUAGE_ID, {
      async provideDefinition(model, position) {
        const path = pathOfUri(model.uri);
        if (path === undefined) return null;
        // Un seul resultat : l'apercu de Monaco exige un modele deja ouvert pour chaque cible.
        const [first] = await controller.definitionAt(path, position.lineNumber, position.column);
        return first === undefined ? null : [{ uri: uriForPath(first.uri), range: toMonacoRange(first.range) }];
      },
    }),
    monaco.languages.registerDocumentSymbolProvider(LANGUAGE_ID, {
      displayName: "RuneScript",
      async provideDocumentSymbols(model) {
        const path = pathOfUri(model.uri);
        if (path === undefined) return [];
        return toMonacoSymbols(await controller.documentSymbolsOf(path)) as unknown as monaco.languages.DocumentSymbol[];
      },
    }),
    monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
      // Les prefixes de variables, les guillemets de callfunc, l'espace et la virgule (arguments de label) declenchent la completion.
      triggerCharacters: ['"', ".", "@", "$", "#", "'", " ", "(", ","],
      async provideCompletionItems(model, position, context) {
        const path = pathOfUri(model.uri);
        if (path === undefined) return { suggestions: [] };
        // Sans fragment saisi, les commandes ne se proposent que sur demande (Ctrl+Espace), pas apres une espace ou une virgule.
        const explicit = context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke;
        const items = await controller.completionAt(path, position.lineNumber, position.column, explicit);
        const describeTemplate = (id: string): string => controller.t(`template.${id}` as MessageKey);
        // Une liste de references (objets, monstres, cartes) tronquee a son maximum est « incomplete » : en continuant de saisir,
        // Monaco la redemande au service plutot que de filtrer une liste qui ne contient pas tout (un identifiant de 6 chiffres).
        const truncated = items.filter((item) => item.reference !== undefined && item.reference.kind !== "constant").length >= MAX_COMPLETIONS;
        return {
          suggestions: items.map((item) => toMonacoSuggestion(item, describeTemplate)) as unknown as monaco.languages.CompletionItem[],
          incomplete: truncated,
        };
      },
      // L'aide du manuel n'est lue qu'a la selection d'une commande : la liste reste legere.
      async resolveCompletionItem(item) {
        const name = (item as unknown as { commandName?: string }).commandName;
        if (name === undefined) return item;
        const info = await controller.commandInfoOf(name);
        if (info === null) return item;
        const value = formatCommand(info, (key, params) => controller.t(key, params), {
          emulator: emulatorNameOf(controller),
          title: false,
          signatures: false,
          maxDocLines: 10,
        });
        return { ...item, documentation: { value } };
      },
    }),
    monaco.languages.registerSignatureHelpProvider(LANGUAGE_ID, {
      signatureHelpTriggerCharacters: [" ", "(", ","],
      signatureHelpRetriggerCharacters: [",", ")"],
      async provideSignatureHelp(model, position) {
        const path = pathOfUri(model.uri);
        if (path === undefined) return null;
        const help = await controller.signatureHelpAt(path, position.lineNumber, position.column);
        if (help === null) return null;
        const documentation = formatCommand(help.command, (key, params) => controller.t(key, params), {
          emulator: emulatorNameOf(controller),
          title: false,
          signatures: false,
          maxDocLines: 6,
          sources: false,
        });
        return { value: toMonacoSignatureHelp(help, documentation) as unknown as monaco.languages.SignatureHelp, dispose: () => undefined };
      },
    }),
    // Action rapide sur « commande inconnue » : la declarer comme commande personnalisee du projet (ecrit `project.json`).
    monaco.languages.registerCodeActionProvider(
      LANGUAGE_ID,
      {
        provideCodeActions(model, _range, context) {
          const actions = declarableCommandNames(context.markers, (marker) => model.getValueInRange(marker)).map(({ name, marker }) => {
            const title = controller.t("codeAction.declareCommand", { name });
            return { title, kind: "quickfix", diagnostics: [marker], isPreferred: true, command: { id: DECLARE_COMMAND, title, arguments: [name] } };
          });
          return { actions, dispose: () => undefined };
        },
      },
      { providedCodeActionKinds: ["quickfix"] },
    ),
    monaco.editor.registerCommand(DECLARE_COMMAND, (_accessor, name: unknown) => {
      if (typeof name === "string") void controller.declareCustomCommand(name);
    }),
    monaco.languages.registerHoverProvider(LANGUAGE_ID, {
      async provideHover(model, position) {
        const path = pathOfUri(model.uri);
        if (path === undefined) return null;
        const info = await controller.hoverAt(path, position.lineNumber, position.column);
        if (info === null) return null;
        const value = formatHover(info, (key, params) => controller.t(key, params), { emulator: emulatorNameOf(controller) });
        return { range: toMonacoRange(info.range), contents: [{ value }] };
      },
    }),
    monaco.languages.registerRenameProvider(LANGUAGE_ID, {
      async resolveRenameLocation(model, position) {
        const path = pathOfUri(model.uri);
        const nowhere = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
        if (path === undefined) return { range: nowhere, text: "", rejectReason: controller.t("rename.error.not-renameable") };
        const prepared = await controller.prepareRenameAt(path, position.lineNumber, position.column);
        if (!prepared.ok) return { range: nowhere, text: "", rejectReason: controller.t(RENAME_ERROR_KEYS[prepared.reason]) };
        return { range: toMonacoRange(prepared.range), text: prepared.placeholder };
      },
      async provideRenameEdits(model, position, newName) {
        const path = pathOfUri(model.uri);
        if (path === undefined) return { edits: [], rejectReason: controller.t("rename.error.not-renameable") };
        const result = await controller.renameAt(path, position.lineNumber, position.column, newName);
        if (!result.ok) return { edits: [], rejectReason: controller.t(RENAME_ERROR_KEYS[result.reason]) };
        const versionId = model.getVersionId();
        return {
          edits: result.edits.map((edit) => ({ resource: model.uri, versionId, textEdit: { range: toMonacoRange(edit.range), text: edit.newText } })),
        };
      },
    }),
    // Monaco ne sait ouvrir qu'un modele existant : l'ouverture (et le changement d'onglet) passe par l'application.
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const path = pathOfUri(resource);
        if (path === undefined) return false;
        const { line, column } = startOf(selectionOrPosition);
        void controller.revealPosition(path, line, column);
        return true;
      },
    }),
  ];
}
