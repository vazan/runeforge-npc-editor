import { describe, expect, it } from "vitest";
import { CommandRegistry, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition } from "@runeforge/emulator-core";
import { LanguageServer } from "./server";
import { MAX_REPORT_ITEMS } from "./types";
import type { CrossFileMode } from "./types";

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;
const fn = (name: string, body = "return;"): string => `function\tscript\t${name}\t{\n${body}\n}\n`;

function server(options: { crossFile?: CrossFileMode } = {}): LanguageServer {
  const instance = new LanguageServer();
  if (options.crossFile !== undefined) instance.setOptions({ crossFile: options.crossFile });
  return instance;
}

/** Registre minimal : `mes` (n'importe quels arguments) et `close` (aucun). Tout autre nom est une commande inconnue. */
function registry(): CommandRegistry {
  const definition = (name: string, types: string): CommandDefinition => ({
    name,
    arity: parseParameterTypes(types),
    parameterTypes: types,
    signatures: [],
    documentation: null,
    deprecated: false,
    conditional: false,
    sources: [{ kind: "server-source", reference: "test" }],
  });
  return CommandRegistry.create([definition("mes", "s*"), definition("close", "")], "rAthena");
}

describe("rapport de projet (RF-015)", () => {
  it("ne liste que les fichiers qui ont des problemes, mais compte tous les fichiers examines", () => {
    const ls = server();
    ls.indexText("ok.txt", fn("F_Ok"));
    ls.indexText("autre-ok.txt", npc("close;", "Autre"));
    ls.indexText("bad.txt", npc("goto L_Nope;\nclose;"));
    const report = ls.projectReport();
    expect(report.examined).toBe(3);
    expect(report.files.map((file) => file.uri)).toEqual(["bad.txt"]);
    expect(report.truncated).toBe(false);
  });

  it("donne la position (base 1) du debut de chaque probleme, dans l'ordre du fichier", () => {
    const ls = server();
    const text = npc("mes \"a\";\ngoto L_Nope;\nclose;\ngoto L_Aussi;");
    ls.indexText("bad.txt", text);
    const file = ls.projectReport().files[0]!;
    expect(file.items.map((item) => [item.diagnostic.code, item.line, item.column])).toEqual([
      ["RA0002", 3, 6],
      ["RA0002", 5, 6],
    ]);
    // Chaque position pointe bien le mot signale.
    const lines = text.split("\n");
    for (const item of file.items) {
      const name = String((item.diagnostic.params as { name: string }).name);
      expect(lines[item.line - 1]?.slice(item.column - 1).startsWith(name)).toBe(true);
    }
    expect(file.items.map((item) => (item.diagnostic.params as { name: string }).name)).toEqual(["L_Nope", "L_Aussi"]);
  });

  it("donne les memes positions pour un fichier lu en CRLF que pour son texte en LF", () => {
    const lf = `// commentaire\n${npc("goto L_Nope;\nclose;")}`;
    const a = server();
    const b = server();
    a.indexText("x.txt", lf);
    b.indexText("x.txt", lf.replaceAll("\n", "\r\n"));
    const positions = (ls: LanguageServer): number[][] => ls.projectReport().files[0]!.items.map((item) => [item.line, item.column]);
    expect(positions(b)).toEqual(positions(a));
    expect(positions(a)).toEqual([[3, 6]]);
  });

  it("totalise par gravite et par code, et les totaux du fichier sont ceux de ses problemes", () => {
    const ls = server();
    ls.setCommandRegistry(registry());
    ls.indexText("a.txt", npc("goto L_Nope;\nInconnue 1;\nAutre 2;\nclose;"));
    ls.indexText("b.txt", npc("Inconnue 3;\nclose;", "Autre"));
    const report = ls.projectReport();
    expect(report.totals).toEqual({ errors: 1, warnings: 3, infos: 0 });
    expect(report.byCode).toEqual([
      { code: "RA0001", count: 3 },
      { code: "RA0002", count: 1 },
    ]);
    const a = report.files.find((file) => file.uri === "a.txt")!;
    expect([a.errors, a.warnings, a.infos]).toEqual([1, 2, 0]);
    expect(a.items).toHaveLength(a.errors + a.warnings + a.infos);
  });

  it("range les fichiers les plus graves d'abord, puis par chemin", () => {
    const ls = server();
    ls.setCommandRegistry(registry());
    ls.indexText("a-avertissement.txt", npc("Inconnue 1;\nclose;", "A"));
    ls.indexText("b-deux-erreurs.txt", npc("goto L_A;\ngoto L_B;\nclose;", "B"));
    ls.indexText("c-erreur.txt", npc("goto L_A;\nclose;", "C"));
    ls.indexText("d-erreur.txt", npc("goto L_A;\nclose;", "D"));
    ls.indexText("e-propre.txt", npc("close;", "E"));
    expect(ls.projectReport().files.map((file) => file.uri)).toEqual(["b-deux-erreurs.txt", "c-erreur.txt", "d-erreur.txt", "a-avertissement.txt"]);
  });

  it("applique les gravites reglees par le projet, comme le panneau des problemes", () => {
    const ls = server();
    ls.setCommandRegistry(registry());
    ls.indexText("a.txt", npc("Inconnue 1;\nclose;"));
    ls.setOptions({ unknownCommands: "info" });
    expect(ls.projectReport().totals).toEqual({ errors: 0, warnings: 0, infos: 1 });
    ls.setOptions({ unknownCommands: "off" });
    expect(ls.projectReport().files).toEqual([]);
    expect(ls.projectReport().totals).toEqual({ errors: 0, warnings: 0, infos: 0 });
  });

  it("montre pour un fichier ouvert le texte de l'editeur, pas celui du disque", () => {
    const ls = server();
    ls.indexText("a.txt", npc("goto L_Disque;\nclose;"));
    expect(ls.projectReport().files[0]?.items[0]?.diagnostic.params).toMatchObject({ name: "L_Disque" });
    ls.updateDocument("a.txt", 1, npc("close;"));
    expect(ls.projectReport().files).toEqual([]);
    ls.updateDocument("a.txt", 2, npc("\n\ngoto L_Editeur;\nclose;"));
    const item = ls.projectReport().files[0]?.items[0];
    expect(item?.diagnostic.params).toMatchObject({ name: "L_Editeur" });
    expect([item?.line, item?.column]).toEqual([4, 6]);
  });

  it("donne les memes problemes que diagnostics() de chaque fichier, ouvert ou non", () => {
    const ls = server({ crossFile: "all" });
    ls.setCommandRegistry(registry());
    ls.indexText("lib.txt", fn("F_Known") + npc("close;", "Twin"));
    ls.indexText("closed.txt", npc('callfunc "F_Missing";\nInconnue 2;\nclose;', "Closed"));
    ls.updateDocument("open.txt", 1, npc('callfunc "F_Missing";\ngoto L_Nope;\nclose;', "Unique"));
    const report = ls.projectReport();
    for (const file of report.files) {
      expect(file.items.map((item) => item.diagnostic)).toEqual(ls.diagnostics(file.uri));
    }
    expect(report.files.map((file) => file.uri).sort()).toEqual(["closed.txt", "open.txt"]);
    // Les totaux du rapport sont la somme des diagnostics de chaque fichier.
    const all = [...report.files.map((file) => file.uri), "lib.txt"].flatMap((uri) => ls.diagnostics(uri));
    expect(report.totals.errors + report.totals.warnings + report.totals.infos).toBe(all.length);
  });

  it("apres la suppression d'un fichier de l'index, il disparait du rapport et du compte", () => {
    const ls = server();
    ls.indexText("a.txt", npc("goto L_A;\nclose;"));
    ls.indexText("b.txt", npc("goto L_B;\nclose;", "B"));
    ls.removeFile("a.txt");
    const report = ls.projectReport();
    expect(report.examined).toBe(1);
    expect(report.files.map((file) => file.uri)).toEqual(["b.txt"]);
  });

  it("un projet vide donne un rapport vide", () => {
    expect(server().projectReport()).toEqual({ examined: 0, files: [], totals: { errors: 0, warnings: 0, infos: 0 }, byCode: [], truncated: false, excluded: null });
  });

  it("ne rapporte avec `only` que les fichiers nommes, et compte ceux qu'il laisse de cote avec leurs problemes", () => {
    const ls = server();
    ls.indexText("charge.txt", npc("goto L_A;\nclose;", "C"));
    ls.indexText("bruit1.txt", npc("goto L_B;\ngoto L_C;\nclose;", "B1"));
    ls.indexText("bruit2.txt", npc("goto L_D;\nclose;", "B2"));
    ls.indexText("propre.txt", npc("close;", "P"));
    const report = ls.projectReport({ only: ["charge.txt", "propre.txt", "absent-de-l-index.txt"] });
    expect(report.files.map((file) => file.uri)).toEqual(["charge.txt"]);
    expect(report.totals).toEqual({ errors: 1, warnings: 0, infos: 0 });
    expect(report.byCode).toEqual([{ code: "RA0002", count: 1 }]);
    expect(report.examined).toBe(2);
    expect(report.excluded).toEqual({ examined: 2, files: 2, problems: 3 });
  });

  it("n'a pas de `excluded` sans restriction (absente ou nulle), et un `only` vide laisse tout de cote", () => {
    const ls = server();
    ls.indexText("a.txt", npc("goto L_A;\nclose;", "A"));
    expect(ls.projectReport().excluded).toBeNull();
    expect(ls.projectReport({ only: null }).excluded).toBeNull();
    expect(ls.projectReport({ only: undefined }).excluded).toBeNull();
    const none = ls.projectReport({ only: [] });
    expect(none).toMatchObject({ examined: 0, files: [], totals: { errors: 0, warnings: 0, infos: 0 }, excluded: { examined: 1, files: 1, problems: 1 } });
  });

  it("applique la limite du detail aux seuls fichiers rapportes : le bruit des autres ne l'epuise pas", () => {
    const ls = server();
    const labels = (count: number): string => Array.from({ length: count }, (_, i) => `goto L_${i};`).join("\n");
    // Deux gros fichiers laisses de cote (plus de problemes que la limite a eux deux) et un petit fichier que l'on veut voir.
    ls.indexText("bruit-a.txt", npc(`${labels(MAX_REPORT_ITEMS)}\nclose;`, "NA"));
    ls.indexText("bruit-b.txt", npc(`${labels(MAX_REPORT_ITEMS)}\nclose;`, "NB"));
    ls.indexText("vrai.txt", npc("goto L_Vrai;\nclose;", "V"));
    // Sans restriction : les gros fichiers passent avant (plus d'erreurs) et epuisent la limite, le vrai probleme perd son detail.
    const everything = ls.projectReport();
    expect(everything.truncated).toBe(true);
    expect(everything.files.find((file) => file.uri === "vrai.txt")?.items).toEqual([]);
    // Avec `only` : la limite ne vaut que pour les fichiers rapportes, rien n'est coupe.
    const only = ls.projectReport({ only: ["vrai.txt"] });
    expect(only.truncated).toBe(false);
    expect(only.files.map((file) => [file.uri, file.items.length])).toEqual([["vrai.txt", 1]]);
    expect(only.excluded).toEqual({ examined: 2, files: 2, problems: MAX_REPORT_ITEMS * 2 });
  });

  it("coupe le detail au-dela de la limite, en gardant les fichiers les plus graves et des totaux exacts", () => {
    const ls = server();
    const labels = (count: number): string => Array.from({ length: count }, (_, i) => `goto L_${i};`).join("\n");
    // 3 fichiers de 2 000 erreurs : la limite (5 000) tombe au milieu du troisieme.
    const perFile = Math.floor(MAX_REPORT_ITEMS * 0.4);
    expect(perFile * 3).toBeGreaterThan(MAX_REPORT_ITEMS);
    expect(perFile * 2).toBeLessThan(MAX_REPORT_ITEMS);
    for (const name of ["a.txt", "b.txt", "c.txt"]) ls.indexText(name, npc(`${labels(perFile)}\nclose;`, name.slice(0, 1)));
    // Un fichier avec une seule erreur : le moins grave, il perd son detail.
    ls.indexText("z-une-erreur.txt", npc("goto L_Z;\nclose;", "Z"));
    const report = ls.projectReport();
    expect(report.truncated).toBe(true);
    expect(report.totals.errors).toBe(perFile * 3 + 1);
    const kept = report.files.reduce((sum, file) => sum + file.items.length, 0);
    expect(kept).toBe(MAX_REPORT_ITEMS);
    const last = report.files[report.files.length - 1]!;
    expect(last.uri).toBe("z-une-erreur.txt");
    expect(last.errors).toBe(1);
    expect(last.items).toEqual([]);
  });
});
