import { describeDiagnostic } from "@runeforge/runescript-core";
import { MAX_REPORT_ITEMS } from "@runeforge/runescript-language-server";
import type { ProjectReport, ReportFile } from "@runeforge/runescript-language-server";
import { translate, type MessageKey } from "../i18n/messages";
import type { Language, LoadIssue } from "../state/store";

type Params = Readonly<Record<string, string | number>>;

/** Ce que dit le rapport de projet d'un probleme de chargement du serveur (texte localise, sans emplacement). */
export function loadIssueMessage(issue: LoadIssue, language: Language): string {
  return translate(language, `report.issue.${issue.kind}` as MessageKey, { subject: issue.subject });
}

/** Emplacement d'un probleme de chargement : `fichier:ligne` (ou `fichier`, ou rien si le fichier est lui-meme absent). */
export function loadIssueLocation(issue: LoadIssue): string {
  if (issue.file === null) return "";
  return issue.line === null ? issue.file : `${issue.file}:${issue.line}`;
}

/** `2 erreur(s), 1 avertissement(s)` : seules les gravites presentes sont nommees. */
export function severityCounts(counts: { readonly errors: number; readonly warnings: number; readonly infos: number }, language: Language): string {
  const parts: string[] = [];
  if (counts.errors > 0) parts.push(translate(language, "problems.errors", { count: counts.errors }));
  if (counts.warnings > 0) parts.push(translate(language, "problems.warnings", { count: counts.warnings }));
  if (counts.infos > 0) parts.push(translate(language, "problems.infos", { count: counts.infos }));
  return parts.join(", ");
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-11-09 14:05:03`, en heure locale. */
export function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

export interface ReportTextInput {
  readonly language: Language;
  readonly projectName: string;
  /** Emulateur du projet (`rAthena`, `Hercules`). */
  readonly profile: string;
  readonly report: ProjectReport;
  /** Fichiers que le serveur ne charge pas et que le rapport ne montre pas (`ProjectReport.excluded`). */
  readonly hidden?: { readonly files: number; readonly problems: number };
  readonly loadIssues: readonly LoadIssue[];
  /** Faux si l'indexation du projet n'etait pas terminee au calcul du rapport. */
  readonly complete: boolean;
  /** Date du calcul (ms depuis 1970). */
  readonly generatedAt: number;
}

function fileSection(file: ReportFile, language: Language): string[] {
  const t = (key: MessageKey, params?: Params): string => translate(language, key, params);
  const lines = [`### ${file.uri} — ${severityCounts(file, language)}`];
  for (const item of file.items) {
    const { diagnostic } = item;
    const text = describeDiagnostic(diagnostic, language);
    lines.push(
      `- ${item.line}:${item.column} · ${t(`report.severity.${diagnostic.severity}` as MessageKey)} · ${diagnostic.code} · ${t(`problems.confidence.${diagnostic.confidence}` as MessageKey)} · ${text.message}`,
    );
    if (text.hint !== undefined) lines.push(`  ${t("problems.fix")} : ${text.hint}`);
  }
  const omitted = file.errors + file.warnings + file.infos - file.items.length;
  if (omitted > 0) lines.push(`- … ${t("report.itemsOmitted", { count: omitted, limit: MAX_REPORT_ITEMS })}`);
  return lines;
}

/**
 * Le rapport de projet en texte (Markdown simple) : de quoi le coller dans un ticket ou un message. Aucune information
 * n'y figure qui ne soit deja a l'ecran (chemins relatifs au projet, messages, codes), jamais le contenu des scripts.
 */
export function formatReportText(input: ReportTextInput): string {
  const { language, report } = input;
  const t = (key: MessageKey, params?: Params): string => translate(language, key, params);
  const lines: string[] = [
    `# ${t("report.text.title", { name: input.projectName })}`,
    "",
    t("report.text.generated", { date: formatTimestamp(input.generatedAt), profile: input.profile }),
    t("report.text.totals", {
      examined: report.examined,
      files: report.files.length,
      errors: report.totals.errors,
      warnings: report.totals.warnings,
      infos: report.totals.infos,
    }),
  ];
  if (input.hidden !== undefined && input.hidden.files > 0) lines.push(t("report.text.hidden", { files: input.hidden.files, problems: input.hidden.problems }));
  if (!input.complete) lines.push(t("report.text.partial"));
  if (report.truncated) lines.push(t("report.text.truncated", { limit: MAX_REPORT_ITEMS }));
  lines.push(t("problems.disclaimer"));

  if (report.byCode.length > 0) {
    lines.push("", `## ${t("report.text.codes")}`);
    for (const entry of report.byCode) lines.push(`- ${entry.code} × ${entry.count}`);
  }
  if (report.files.length > 0) {
    lines.push("", `## ${t("report.text.files")}`);
    for (const file of report.files) lines.push("", ...fileSection(file, language));
  }
  if (input.loadIssues.length > 0) {
    lines.push("", `## ${t("report.text.server")}`);
    for (const issue of input.loadIssues) {
      const location = loadIssueLocation(issue);
      lines.push(`- ${location === "" ? "" : `${location} — `}${loadIssueMessage(issue, language)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
