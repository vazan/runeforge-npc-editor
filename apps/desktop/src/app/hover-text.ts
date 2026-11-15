import type { CommandInfo, HoverInfo } from "@runeforge/runescript-language-server";
import type { MessageKey } from "../i18n/messages";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

const SCOPE_KEYS: Readonly<Record<string, MessageKey>> = {
  script: "hover.scope.script",
  npc: "hover.scope.npc",
  "character-temporary": "hover.scope.character-temporary",
  "character-permanent": "hover.scope.character-permanent",
  "global-temporary": "hover.scope.global-temporary",
  "global-permanent": "hover.scope.global-permanent",
  "account-local": "hover.scope.account-local",
  "account-global": "hover.scope.account-global",
  instance: "hover.scope.instance",
};

export interface CommandFormatOptions {
  /** Nom de l'emulateur du projet (« rAthena »). */
  readonly emulator: string;
  /** Titre (nom et origine) : inutile dans l'aide de signature ou la completion, dont le titre est deja affiche. */
  readonly title?: boolean;
  /** Signatures : inutiles dans l'aide de signature, qui les affiche elle-meme. */
  readonly signatures?: boolean;
  /** Nombre maximal de lignes de l'aide du manuel. */
  readonly maxDocLines?: number;
  /** Fichier et ligne d'ou vient la definition. */
  readonly sources?: boolean;
}

/** Bloc de code Markdown dont les barrieres sont plus longues que toute suite d'accents graves du contenu. */
function fence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const mark = "`".repeat(Math.max(3, longest + 1));
  return `${mark}text\n${text}\n${mark}`;
}

function arityText(info: CommandInfo, t: Translate): string {
  const arity = info.arity;
  if (arity === null) return t(info.sources[0]?.kind === "project" ? "hover.command.arity.undeclared" : "hover.command.arity.unknown");
  if (arity.max === null) return t("hover.command.arity.atLeast", { min: arity.min });
  if (arity.min === arity.max) return arity.min === 0 ? t("hover.command.arity.none") : t("hover.command.arity.exact", { count: arity.min });
  return t("hover.command.arity.range", { min: arity.min, max: arity.max });
}

/**
 * Texte Markdown d'une commande du registre : origine, signatures, nombre d'arguments verifie, avertissements et extrait de
 * l'aide du manuel de l'utilisateur. Sert au survol, a l'aide de signature et au detail d'une proposition.
 */
export function formatCommand(info: CommandInfo, t: Translate, options: CommandFormatOptions): string {
  const parts: string[] = [];
  if (options.title !== false) {
    const kind = t(`hover.command.kind.${info.sources[0]?.kind ?? "server-doc"}` as MessageKey, { emulator: options.emulator });
    parts.push(`**${info.name}** — ${kind}`);
  }
  if (options.signatures !== false && info.signatures.length > 0) parts.push(fence(info.signatures.join("\n")));
  parts.push(arityText(info, t));
  if (info.deprecated) parts.push(t("hover.command.deprecated"));
  if (info.conditional) parts.push(t("hover.command.conditional"));
  if (info.documentation !== null) {
    const lines = info.documentation.split("\n");
    const limit = options.maxDocLines ?? lines.length;
    parts.push(fence(lines.slice(0, limit).join("\n")));
    if (lines.length > limit || info.documentationTruncated) parts.push(`*${t("hover.command.truncated")}*`);
  }
  if (options.sources !== false && info.sources.length > 0) {
    parts.push(t("hover.command.sources", { places: info.sources.map((source) => `\`${source.reference}\``).join(" · ") }));
  }
  return parts.join("\n\n");
}

/** Texte Markdown du survol d'un symbole, dans la langue de l'interface. */
export function formatHover(info: HoverInfo, t: Translate, context: { readonly emulator?: string } = {}): string {
  const parts: string[] = [];
  switch (info.kind) {
    case "label": {
      if (!info.defined) {
        parts.push(t("hover.label.undefined", { name: info.name }));
        break;
      }
      const kind = info.isFunction ? t("hover.kind.localFunction") : info.isEvent ? t("hover.kind.event") : t("hover.kind.label");
      parts.push(t("hover.label.title", { name: info.name, kind }));
      parts.push(t("hover.label.line", { line: info.line ?? 0, references: info.references }));
      break;
    }
    case "function": {
      parts.push(t("hover.function.title", { name: info.name }));
      if (info.definitions.length === 0) {
        parts.push(t("hover.function.none"));
      } else {
        for (const definition of info.definitions) parts.push(t("hover.function.definedIn", { place: `${definition.uri}:${definition.line}` }));
        if (info.definitions.length > 1) parts.push(t("hover.function.multiple", { count: info.definitions.length }));
      }
      parts.push(t("hover.function.references", { references: info.references }));
      break;
    }
    case "npc": {
      const first = info.definitions[0];
      parts.push(t("hover.npc.title", { name: info.name, type: first?.npcType ?? "" }));
      if (info.definitions.length === 0) {
        parts.push(t("hover.npc.none"));
      } else {
        for (const definition of info.definitions) {
          parts.push(
            t("hover.npc.definedIn", {
              display: definition.displayName,
              map: definition.map ?? "-",
              place: `${definition.uri}:${definition.line}`,
            }),
          );
        }
      }
      parts.push(t("hover.npc.references", { references: info.references }));
      break;
    }
    case "command":
      return formatCommand(info.info, t, { emulator: context.emulator ?? "rAthena", maxDocLines: 14 });
    case "reference": {
      const record = info.record;
      if (record === null) {
        if (info.referenceKind !== "skill") parts.push(t(`hover.reference.notFound.${info.referenceKind}`, { written: info.written }));
        break;
      }
      if ("aegisName" in record && "type" in record) {
        parts.push(t("hover.reference.item", { id: record.id, name: record.name }));
        parts.push([t("hover.reference.aegis", { name: record.aegisName }), ...(record.type === null ? [] : [t("hover.reference.type", { type: record.type })])].join(" · "));
      } else if ("aegisName" in record) {
        parts.push(t("hover.reference.mob", { id: record.id, name: record.name }));
        parts.push([t("hover.reference.aegis", { name: record.aegisName }), ...(record.level === null ? [] : [t("hover.reference.level", { level: record.level })])].join(" · "));
      } else if ("maxLevel" in record) {
        parts.push(t("hover.reference.skill", { id: record.id, name: record.description }));
        parts.push(t("hover.reference.skillDetail", { name: record.name, level: record.maxLevel }));
      } else {
        parts.push(t("hover.reference.map", { name: record.name }));
        parts.push(t("hover.reference.index", { index: record.index }));
      }
      parts.push(t("hover.reference.source", { place: record.source }));
      break;
    }
    case "constant": {
      const constant = info.constant;
      parts.push(t(constant.parameter ? "hover.constant.parameter" : "hover.constant.title", { name: constant.name }));
      parts.push(constant.value === null ? t("hover.constant.valueUnknown") : t("hover.constant.value", { value: constant.value }));
      if (constant.deprecated) parts.push(t("hover.constant.deprecated"));
      parts.push(t("hover.reference.source", { place: constant.source }));
      break;
    }
    case "variable": {
      const scopeKey = SCOPE_KEYS[info.scope];
      parts.push(t("hover.variable.title", { name: info.name, scope: scopeKey === undefined ? info.scope : t(scopeKey) }));
      parts.push([info.isString ? t("hover.variable.string") : t("hover.variable.number"), ...(info.isArray ? [t("hover.variable.array")] : [])].join(" · "));
      parts.push(t("hover.variable.uses", { count: info.occurrences }));
      parts.push(info.firstWriteLine === null ? t("hover.variable.noWrite") : t("hover.variable.firstWrite", { line: info.firstWriteLine }));
      break;
    }
  }
  return parts.join("\n\n");
}
