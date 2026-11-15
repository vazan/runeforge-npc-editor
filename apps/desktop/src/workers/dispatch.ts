import { CommandRegistry } from "@runeforge/emulator-core";
import { buildRathenaCatalog, buildRathenaRegistry, RATHENA_PROFILE_LABEL, RATHENA_SCRIPT_LIBRARY } from "@runeforge/emulator-rathena";
import { decodeDocument } from "@runeforge/project-core";
import { LanguageServer } from "@runeforge/runescript-language-server";
import type {
  CommandRegistrySummary,
  LanguageMethod,
  LanguageMethods,
  LanguageRequest,
  LanguageResponse,
  ReferenceCatalogSummary,
} from "./protocol";

const NO_CATALOG: ReferenceCatalogSummary = { items: 0, mobs: 0, skills: 0, maps: 0, constants: 0, loadedMaps: null, warnings: [] };

const NO_REGISTRY: CommandRegistrySummary = {
  level: "none",
  commands: 0,
  withArity: 0,
  sourceCommands: 0,
  customCommands: 0,
  docCommands: 0,
  projectCommands: 0,
  warnings: [],
};

const RATHENA_LIBRARY_REGISTRY = CommandRegistry.create(RATHENA_SCRIPT_LIBRARY, RATHENA_PROFILE_LABEL);

type Handlers = { [M in LanguageMethod]: (params: LanguageMethods[M]["params"]) => LanguageMethods[M]["result"] };

/**
 * Cree le repartiteur du worker : il associe chaque methode du protocole a une operation du service de langage.
 * Pur et synchrone (le `LanguageServer` est le seul etat) : testable sans Worker.
 */
export function createDispatcher(server: LanguageServer = new LanguageServer(), options: { readonly includeRathenaLibrary?: boolean } = {}): {
  readonly server: LanguageServer;
  handle(request: LanguageRequest): LanguageResponse;
} {
  const handlers: Handlers = {
    analyze({ uri, version, text }) {
      const { truncated } = server.updateDocument(uri, version, text);
      return { diagnostics: server.diagnostics(uri), truncated };
    },
    closeDocument({ uri }) {
      server.closeDocument(uri);
      return null;
    },
    definition: ({ uri, position }) => server.definition(uri, position),
    references: ({ uri, position, includeDeclaration }) => server.references(uri, position, includeDeclaration),
    documentSymbols: ({ uri }) => server.documentSymbols(uri),
    completion: ({ uri, position, explicit }) => server.completion(uri, position, { explicit: explicit === true }),
    hover: ({ uri, position }) => server.hover(uri, position) ?? null,
    signatureHelp: ({ uri, position }) => server.signatureHelp(uri, position) ?? null,
    commandInfo: ({ name }) => server.commandInfo(name) ?? null,
    prepareRename: ({ uri, position }) => server.prepareRename(uri, position),
    rename: ({ uri, position, newName }) => server.rename(uri, position, newName),
    workspaceSymbols: ({ query, limit }) => server.workspaceSymbols(query, limit),
    diagnostics: ({ uri }) => server.diagnostics(uri),
    projectDiagnostics: () => server.projectDiagnostics(),
    previewDiagnostics: ({ text }) => server.previewDiagnostics(text),
    projectReport: ({ only }) => server.projectReport({ only }),
    indexFiles({ files, legacyEncoding }) {
      const skipped: string[] = [];
      let indexed = 0;
      for (const file of files) {
        const decoded = decodeDocument(file.bytes, { legacyEncoding });
        if (decoded.kind !== "text") {
          skipped.push(file.uri);
          continue;
        }
        // Le service raisonne en positions {ligne, colonne} : le type de fin de ligne du fichier n'a pas d'incidence.
        server.indexText(file.uri, decoded.text);
        indexed += 1;
      }
      return { indexed, skipped };
    },
    removeFiles({ uris }) {
      for (const uri of uris) server.removeFile(uri);
      return null;
    },
    clearIndex() {
      server.clearIndex();
      return null;
    },
    setOptions(options) {
      server.setOptions(options);
      return null;
    },
    setLoadOrder({ files }) {
      server.setLoadOrder(files);
      return null;
    },
    setCommandSources({ family, builtinSource, customBuiltins, projectCommands, legacyEncoding }) {
      // Seul l'adaptateur rAthena existe pour l'instant : pour Hercules il n'y a pas de registre (aucune alerte inventee).
      if (family !== "rathena") {
        server.setCommandRegistry(null);
        server.setCommandLibrary(null);
        return NO_REGISTRY;
      }
      server.setCommandLibrary(options.includeRathenaLibrary === true ? RATHENA_LIBRARY_REGISTRY : null);
      const textOf = (bytes: Uint8Array | null): string | null => {
        if (bytes === null) return null;
        const decoded = decodeDocument(bytes, { legacyEncoding });
        return decoded.kind === "text" ? decoded.text : null;
      };
      const report = buildRathenaRegistry({
        builtinSource: textOf(builtinSource),
        customBuiltins: textOf(customBuiltins),
        projectCommands: projectCommands ?? [],
      });
      server.setCommandRegistry(report.registry);
      const stats = report.registry?.stats();
      return {
        level: report.level,
        commands: stats?.total ?? 0,
        withArity: stats?.withArity ?? 0,
        sourceCommands: report.sourceCommands,
        customCommands: report.customCommands,
        docCommands: report.docCommands,
        projectCommands: report.projectCommands,
        warnings: [...report.warnings],
      };
    },
    setReferenceSources({ family, items, mobs, skills, constantsYaml, constantsSource, mapIndex, randomOptions, projectConstants, loadedMaps, legacyEncoding }) {
      // Comme pour les commandes : seul l'adaptateur rAthena existe ; pour Hercules il n'y a pas de catalogue.
      if (family !== "rathena") {
        server.setReferenceCatalog(null);
        return NO_CATALOG;
      }
      const decode = (file: { readonly path: string; readonly bytes: Uint8Array }): { path: string; text: string } => {
        const decoded = decodeDocument(file.bytes, { legacyEncoding });
        return { path: file.path, text: decoded.kind === "text" ? decoded.text : "" };
      };
      const report = buildRathenaCatalog({
        items: items.map(decode),
        mobs: mobs.map(decode),
        skills: (skills ?? []).map(decode),
        constantsYaml: constantsYaml.map(decode),
        constantsSource: constantsSource === null ? null : decode(constantsSource),
        mapIndex: mapIndex.map(decode),
        randomOptions: (randomOptions ?? []).map(decode),
        projectConstants: projectConstants ?? [],
        loadedMaps: loadedMaps ?? null,
      });
      server.setReferenceCatalog(report.catalog);
      const stats = report.catalog?.stats();
      return {
        items: stats?.items ?? 0,
        mobs: stats?.mobs ?? 0,
        skills: stats?.skills ?? 0,
        maps: stats?.maps ?? 0,
        constants: stats?.constants ?? 0,
        loadedMaps: report.catalog?.loadedMapCount ?? null,
        warnings: [...report.warnings],
      };
    },
    searchReferences: ({ kind, query, limit }) => server.searchReferences(kind, query, limit),
    stats: () => server.stats(),
  };

  return {
    server,
    handle(request) {
      try {
        const handler = handlers[request.method] as (params: unknown) => unknown;
        return { id: request.id, ok: true, result: handler(request.params) };
      } catch (error) {
        return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
