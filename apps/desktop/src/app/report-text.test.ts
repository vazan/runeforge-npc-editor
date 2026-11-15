import type { ParseDiagnostic } from "@runeforge/runescript-core";
import type { ProjectReport, ReportFile, ReportItem } from "@runeforge/runescript-language-server";
import { MAX_REPORT_ITEMS } from "@runeforge/runescript-language-server";
import { describe, expect, it } from "vitest";
import type { LoadIssue } from "../state/store";
import { formatReportText, formatTimestamp, loadIssueLocation, loadIssueMessage, severityCounts } from "./report-text";

function diagnostic(code: string, severity: ParseDiagnostic["severity"], params: ParseDiagnostic["params"] = {}): ParseDiagnostic {
  return { code, category: "semantic-error", range: { start: 0, end: 1 }, severity, message: `canonical ${code}`, confidence: "probable", source: "analyzer", params };
}

function item(code: string, severity: ParseDiagnostic["severity"], line: number, column: number, params: ParseDiagnostic["params"] = {}): ReportItem {
  return { diagnostic: diagnostic(code, severity, params), line, column };
}

function file(uri: string, items: ReportItem[], extra: Partial<Pick<ReportFile, "errors" | "warnings" | "infos">> = {}): ReportFile {
  const count = (severity: string): number => items.filter((entry) => entry.diagnostic.severity === severity).length;
  return { uri, errors: extra.errors ?? count("error"), warnings: extra.warnings ?? count("warning"), infos: extra.infos ?? count("info"), items };
}

function reportOf(files: ReportFile[], examined = 10, truncated = false): ProjectReport {
  const totals = {
    errors: files.reduce((sum, entry) => sum + entry.errors, 0),
    warnings: files.reduce((sum, entry) => sum + entry.warnings, 0),
    infos: files.reduce((sum, entry) => sum + entry.infos, 0),
  };
  const counts = new Map<string, number>();
  for (const entry of files) for (const found of entry.items) counts.set(found.diagnostic.code, (counts.get(found.diagnostic.code) ?? 0) + 1);
  const byCode = [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return { examined, files, totals, byCode, truncated, excluded: null };
}

const GENERATED = new Date(2026, 10, 9, 14, 5, 3).getTime();

describe("formatTimestamp", () => {
  it("ecrit la date et l'heure locales avec des zeros", () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("2026-01-02 03:04:05");
    expect(formatTimestamp(GENERATED)).toBe("2026-11-09 14:05:03");
  });
});

describe("severityCounts", () => {
  it("ne nomme que les gravites presentes", () => {
    expect(severityCounts({ errors: 2, warnings: 0, infos: 1 }, "fr")).toBe("2 erreur(s), 1 information(s)");
    expect(severityCounts({ errors: 0, warnings: 3, infos: 0 }, "en")).toBe("3 warning(s)");
    expect(severityCounts({ errors: 0, warnings: 0, infos: 0 }, "en")).toBe("");
  });
});

describe("problemes de chargement", () => {
  const missing: LoadIssue = { kind: "missing-script", file: "conf/scripts.conf", line: 12, subject: "npc/old.txt" };

  it("donnent l'emplacement `fichier:ligne`, ou rien quand le fichier de configuration est lui-meme absent", () => {
    expect(loadIssueLocation(missing)).toBe("conf/scripts.conf:12");
    expect(loadIssueLocation({ ...missing, line: null })).toBe("conf/scripts.conf");
    expect(loadIssueLocation({ kind: "missing-config", file: null, line: null, subject: "npc/scripts_main.conf" })).toBe("");
  });

  it("ont un message dans chaque langue pour chaque sorte", () => {
    const kinds: LoadIssue["kind"][] = ["missing-config", "missing-script", "unknown-setting", "import-cycle", "limit-depth", "limit-reads"];
    for (const kind of kinds) {
      for (const language of ["fr", "en"] as const) {
        const text = loadIssueMessage({ kind, file: "a.conf", line: 1, subject: "SUJET" }, language);
        expect(text).toContain("SUJET");
        expect(text).not.toContain("report.issue");
      }
    }
    expect(loadIssueMessage(missing, "en")).toBe("npc/old.txt is listed but the file does not exist.");
  });
});

describe("formatReportText", () => {
  const input = {
    projectName: "Mon serveur",
    profile: "rAthena",
    complete: true,
    generatedAt: GENERATED,
    loadIssues: [] as LoadIssue[],
  };

  it("ecrit l'en-tete, les codes puis chaque fichier avec la position, la gravite, le code, la confiance et le message", () => {
    const report = reportOf([
      file("npc/a.txt", [item("RA0002", "error", 12, 5, { name: "L_Fin" }), item("RA0001", "warning", 20, 1, { name: "Zorg", profile: "rAthena" })]),
      file("npc/b.txt", [item("RA0002", "error", 3, 6, { name: "L_X" })]),
    ]);
    const text = formatReportText({ ...input, language: "en", report });
    expect(text.startsWith("# Project report: Mon serveur\n")).toBe(true);
    expect(text).toContain("Generated on 2026-11-09 14:05:03 · emulator: rAthena");
    expect(text).toContain("10 file(s) examined · 2 with problems · 2 error(s), 1 warning(s), 0 notice(s)");
    expect(text).toContain("Static checks only.");
    expect(text).toContain("## Codes\n- RA0002 × 2\n- RA0001 × 1\n");
    expect(text).toContain("### npc/a.txt — 1 error(s), 1 warning(s)\n- 12:5 · error · RA0002 · probable · ");
    expect(text).toContain("- 20:1 · warning · RA0001 · probable · ");
    expect(text).toContain("### npc/b.txt — 1 error(s)\n- 3:6 · error · RA0002");
    expect(text.indexOf("npc/a.txt")).toBeLessThan(text.indexOf("npc/b.txt"));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("report.");
  });

  it("repete le conseil de correction sous le probleme quand le catalogue en a un", () => {
    const text = formatReportText({ ...input, language: "fr", report: reportOf([file("npc/a.txt", [item("RA0002", "error", 2, 6, { name: "L_Nope" })])]) });
    expect(text).toContain("- 2:6 · erreur · RA0002 · probable · Le label « L_Nope » n'est pas défini dans ce script.\n  Comment corriger : ");
  });

  it("dit quand le rapport est partiel ou que son detail est coupe, et combien de problemes manquent a un fichier", () => {
    const cut = file("npc/a.txt", [item("RA0002", "error", 2, 6, { name: "L_A" })], { errors: 5 });
    const text = formatReportText({ ...input, language: "en", complete: false, report: reportOf([cut], 10, true) });
    expect(text).toContain("Incomplete: the project was still being indexed.");
    expect(text).toContain(`The detailed list is limited to ${MAX_REPORT_ITEMS} problems; the totals are exact.`);
    expect(text).toContain(`- … 4 more problem(s) are not listed (the detailed list is limited to ${MAX_REPORT_ITEMS}); the totals above are exact.`);
    expect(text).toContain("5 error(s)");
  });

  it("n'ecrit ni section de codes ni section de fichiers pour un projet sans probleme", () => {
    const text = formatReportText({ ...input, language: "en", report: reportOf([], 7) });
    expect(text).toContain("7 file(s) examined · 0 with problems · 0 error(s), 0 warning(s), 0 notice(s)");
    expect(text).not.toContain("## ");
  });

  it("dit combien de fichiers que le serveur ne charge pas sont masques", () => {
    const report = reportOf([file("npc/a.txt", [item("RA0002", "error", 2, 6, { name: "L_A" })])], 4);
    const shown = formatReportText({ ...input, language: "fr", report, hidden: { files: 3, problems: 120 } });
    expect(shown).toContain("Non montrés : 3 fichier(s) que le serveur ne charge pas (120 problème(s)).");
    expect(formatReportText({ ...input, language: "en", report, hidden: { files: 3, problems: 120 } })).toContain("Not shown: 3 file(s) that the server does not load (120 problem(s)).");
    expect(formatReportText({ ...input, language: "fr", report, hidden: { files: 0, problems: 0 } })).not.toContain("Non montrés");
    expect(formatReportText({ ...input, language: "fr", report })).not.toContain("Non montrés");
  });

  it("liste les problemes de chargement du serveur avec leur emplacement", () => {
    const loadIssues: LoadIssue[] = [
      { kind: "missing-script", file: "npc/scripts_main.conf", line: 7, subject: "npc/old.txt" },
      { kind: "missing-config", file: null, line: null, subject: "npc/scripts_custom.conf" },
    ];
    const text = formatReportText({ ...input, language: "fr", loadIssues, report: reportOf([], 3) });
    expect(text).toContain("## Listes de scripts du serveur\n- npc/scripts_main.conf:7 — npc/old.txt est cité mais le fichier n'existe pas.\n- Le fichier de configuration npc/scripts_custom.conf est introuvable.\n");
  });

  it("ne contient que des chemins du projet, des messages et des codes : jamais le texte des scripts", () => {
    const text = formatReportText({ ...input, language: "en", report: reportOf([file("npc/a.txt", [item("RA0002", "error", 2, 6, { name: "L_A" })])]) });
    expect(text).not.toContain("script\t");
    expect(text).not.toContain("goto");
  });
});
