import { excerptDocumentation, parseSignatureText, signatureFromTypes } from "@runeforge/emulator-core";
import type { CommandDefinition, SignatureView } from "@runeforge/emulator-core";
import type { CommandInfo, SignatureHelp } from "./types";

/** Taille de l'extrait d'aide du manuel affiche dans le survol et l'aide de signature. */
export const DOC_EXCERPT_CHARS = 900;
export const DOC_EXCERPT_LINES = 14;

const viewsCache = new WeakMap<CommandDefinition, readonly SignatureView[]>();

/**
 * Signatures affichables d'une commande : celles du manuel (avec la plage de chaque parametre) ; sinon une signature
 * generique tiree de la notation de la table du serveur ; sinon le nom seul.
 */
export function signatureViewsOf(definition: CommandDefinition): readonly SignatureView[] {
  const cached = viewsCache.get(definition);
  if (cached !== undefined) return cached;
  let views = definition.signatures.map(parseSignatureText).filter((view) => view.label !== "");
  if (views.length === 0) {
    views = [
      definition.parameterTypes === null
        ? { label: definition.name, parameters: [], variadic: false }
        : signatureFromTypes(definition.name, definition.parameterTypes),
    ];
  }
  viewsCache.set(definition, views);
  return views;
}

/** Ce que le registre sait d'une commande, sous forme de donnees (aucun texte redige). */
export function commandInfoOf(definition: CommandDefinition): CommandInfo {
  const excerpt = definition.documentation === null ? null : excerptDocumentation(definition.documentation, DOC_EXCERPT_CHARS, DOC_EXCERPT_LINES);
  return {
    name: definition.name,
    signatures: signatureViewsOf(definition).map((view) => view.label),
    arity: definition.arity,
    parameterTypes: definition.parameterTypes,
    documentation: excerpt === null || excerpt.text === "" ? null : excerpt.text,
    documentationTruncated: excerpt?.truncated ?? false,
    deprecated: definition.deprecated,
    conditional: definition.conditional,
    sources: definition.sources,
  };
}

/**
 * Aide de signature pour l'argument de rang `argIndex` : la premiere signature qui peut recevoir cet argument (sinon celle
 * qui a le plus de parametres) ; pour un nombre libre d'arguments, le dernier parametre reste actif.
 */
export function signatureHelpOf(definition: CommandDefinition, argIndex: number): SignatureHelp {
  const views = signatureViewsOf(definition);
  let active = views.findIndex((view) => argIndex < view.parameters.length || view.variadic);
  if (active === -1) {
    active = 0;
    let most = -1;
    views.forEach((view, index) => {
      if (view.parameters.length > most) {
        most = view.parameters.length;
        active = index;
      }
    });
  }
  const view = views[active];
  const last = (view?.parameters.length ?? 0) - 1;
  const activeParameter = view?.variadic === true && last >= 0 && argIndex > last ? last : argIndex;
  return {
    signatures: views.map((candidate) => ({ label: candidate.label, parameters: candidate.parameters.map(({ start, end }) => ({ start, end })) })),
    activeSignature: active,
    activeParameter,
    command: commandInfoOf(definition),
  };
}
