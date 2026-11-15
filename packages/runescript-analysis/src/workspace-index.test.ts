import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@runeforge/emulator-core";
import { parse } from "@runeforge/runescript-parser";
import { analyzeFile } from "./analyze";
import { WorkspaceIndex } from "./workspace-index";

function npc(body: string, name = "Test"): string {
  return `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;
}

function fn(name: string, body = "return;"): string {
  return `function\tscript\t${name}\t{\n${body}\n}\n`;
}

function add(index: WorkspaceIndex, uri: string, text: string): void {
  index.set(analyzeFile(parse(text), uri));
}

const STRICT = { reportUnresolved: true } as const;
const LENIENT = { reportUnresolved: false } as const;

describe("WorkspaceIndex : fonctions globales", () => {
  it("retrouve une fonction par son nom exact, sensible a la casse", () => {
    const index = new WorkspaceIndex();
    add(index, "npc/functions.txt", fn("F_Test"));
    expect(index.findFunctions("F_Test")).toHaveLength(1);
    expect(index.findFunctions("F_Test")[0]).toMatchObject({ name: "F_Test", uri: "npc/functions.txt" });
    expect(index.findFunctions("f_test")).toHaveLength(0);
    expect(index.functionNames()).toEqual(["F_Test"]);
    expect(index.functionCount).toBe(1);
  });

  it("resout callfunc entre fichiers et signale les cibles introuvables seulement si demande", () => {
    const index = new WorkspaceIndex();
    add(index, "npc/functions.txt", fn("F_Test"));
    const caller = npc('callfunc "F_Test";\ncallfunc "f_test";\ncallfunc "F_Missing";\nclose;');
    add(index, "npc/caller.txt", caller);

    expect(index.crossFileDiagnostics("npc/caller.txt", LENIENT)).toEqual([]);

    const diagnostics = index.crossFileDiagnostics("npc/caller.txt", STRICT);
    expect(diagnostics.map((d) => d.code)).toEqual(["RA0004", "RA0004"]);
    expect(diagnostics.map((d) => caller.slice(d.range.start, d.range.end))).toEqual(['"f_test"', '"F_Missing"']);
    expect(diagnostics[0]).toMatchObject({ severity: "info", confidence: "unknown", category: "semantic-error" });
  });

  it("signale une fonction definie plusieurs fois, dans deux fichiers comme dans un seul", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", fn("F_Dup") + fn("F_Same"));
    add(index, "b.txt", fn("F_Dup") + fn("F_Same"));
    const a = index.crossFileDiagnostics("a.txt", LENIENT);
    expect(a.map((d) => d.code)).toEqual(["RA0011", "RA0011"]);
    expect(a[0]!.related).toEqual([{ uri: "b.txt", range: index.findFunctions("F_Dup")[1]!.nameRange }]);
    expect(a[0]!.severity).toBe("warning");

    const single = new WorkspaceIndex();
    add(single, "one.txt", fn("F_Twice") + fn("F_Twice"));
    const twice = single.crossFileDiagnostics("one.txt", LENIENT);
    expect(twice.map((d) => d.code)).toEqual(["RA0011", "RA0011"]);
    expect(twice[0]!.related).toHaveLength(1);
    expect(twice[0]!.related![0]!.range).not.toEqual(twice[0]!.range);
  });
});

describe("WorkspaceIndex : noms uniques de NPC", () => {
  it("signale les noms uniques identiques et les relie entre eux", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", npc("close;", "Kafra"));
    add(index, "b.txt", npc("close;", "Kafra"));
    const diagnostics = index.crossFileDiagnostics("a.txt", LENIENT);
    expect(diagnostics.map((d) => d.code)).toEqual(["RA0005"]);
    expect(diagnostics[0]!.params).toEqual({ name: "Kafra" });
    expect(diagnostics[0]!.related?.map((r) => r.uri)).toEqual(["b.txt"]);
    expect(index.crossFileDiagnostics("b.txt", LENIENT).map((d) => d.code)).toEqual(["RA0005"]);
  });

  it("distingue deux NPC de meme nom affiche par leur nom unique (::)", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", npc("close;", "Guide::GuideA"));
    add(index, "b.txt", npc("close;", "Guide::GuideB"));
    expect(index.crossFileDiagnostics("a.txt", LENIENT)).toEqual([]);
    expect(index.findNpcs("GuideA")).toHaveLength(1);
  });

  it("traite les noms uniques comme sensibles a la casse", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", npc("close;", "Kafra"));
    add(index, "b.txt", npc("close;", "kafra"));
    expect(index.crossFileDiagnostics("a.txt", LENIENT)).toEqual([]);
  });

  it("tronque les noms a 50 caracteres comme le serveur", () => {
    const base = "n".repeat(50);
    const index = new WorkspaceIndex();
    add(index, "a.txt", npc("close;", `${base}A`));
    add(index, "b.txt", npc("close;", `${base}B`));
    expect(index.crossFileDiagnostics("a.txt", LENIENT).map((d) => d.code)).toEqual(["RA0005"]);
  });

  it("compte les warps, boutiques et duplicates parmi les noms uniques", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", "prt_fild08,10,10,0\twarp\tShared\t2,2,prontera,150,150\n");
    add(index, "b.txt", "prontera,160,160,4\tshop\tShared\t4_M_01,501:50\n");
    expect(index.crossFileDiagnostics("a.txt", LENIENT).map((d) => d.code)).toEqual(["RA0005"]);
    expect(index.findNpcs("Shared").map((n) => n.npcType).sort()).toEqual(["shop", "warp"]);
  });

  it("resout la source d'un duplicate et signale une source absente seulement si demande", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", npc("close;", "Source"));
    add(index, "b.txt", "prontera,170,170,4\tduplicate(Source)\tCopy1\t4_M_01\nprontera,171,170,4\tduplicate(Absent)\tCopy2\t4_M_01\n");
    expect(index.crossFileDiagnostics("b.txt", LENIENT)).toEqual([]);
    const strict = index.crossFileDiagnostics("b.txt", STRICT);
    expect(strict.map((d) => d.code)).toEqual(["RA0013"]);
    expect(strict[0]!.params).toEqual({ name: "Absent" });
  });

  it("ignore les noms uniques vides (le serveur leur attribue un nom genere)", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", npc("close;", "Display::"));
    add(index, "b.txt", npc("close;", "Other::"));
    expect(index.npcCount).toBe(0);
    expect(index.crossFileDiagnostics("a.txt", LENIENT)).toEqual([]);
  });
});

describe("WorkspaceIndex : mises a jour incrementales", () => {
  it("remplace les entrees d'un fichier modifie sans toucher aux autres", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", fn("F_One") + npc("close;", "NpcA"));
    add(index, "b.txt", fn("F_Two"));
    expect(index.fileCount).toBe(2);

    add(index, "a.txt", fn("F_Renamed"));
    expect(index.findFunctions("F_One")).toHaveLength(0);
    expect(index.findFunctions("F_Renamed")).toHaveLength(1);
    expect(index.findFunctions("F_Two")).toHaveLength(1);
    expect(index.findNpcs("NpcA")).toHaveLength(0);
    expect(index.fileCount).toBe(2);
  });

  it("retire un fichier et ses symboles, et leve les doublons correspondants", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", fn("F_Dup") + npc("close;", "Twin"));
    add(index, "b.txt", fn("F_Dup") + npc("close;", "Twin"));
    expect(index.crossFileDiagnostics("a.txt", LENIENT)).toHaveLength(2);
    expect(index.delete("b.txt")).toBe(true);
    expect(index.delete("b.txt")).toBe(false);
    expect(index.crossFileDiagnostics("a.txt", LENIENT)).toEqual([]);
    expect(index.has("b.txt")).toBe(false);
    expect(index.crossFileDiagnostics("b.txt", STRICT)).toEqual([]);
  });

  it("vide l'index", () => {
    const index = new WorkspaceIndex();
    add(index, "a.txt", fn("F_One"));
    index.clear();
    expect(index.fileCount).toBe(0);
    expect(index.functionCount).toBe(0);
  });
});

describe("WorkspaceIndex : diagnostics combines", () => {
  it("fusionne les diagnostics locaux et inter-fichiers dans l'ordre du texte", () => {
    const index = new WorkspaceIndex();
    add(index, "other.txt", npc("close;", "Twin"));
    const text = npc("goto L_None;\nclose;", "Twin");
    add(index, "main.txt", text);
    const all = index.diagnosticsFor("main.txt", LENIENT);
    expect(all.map((d) => d.code)).toEqual(["RA0005", "RA0002"]);
    expect(all.map((d) => d.range.start)).toEqual([...all.map((d) => d.range.start)].sort((a, b) => a - b));
  });

  it("limite le nombre d'emplacements lies", () => {
    const index = new WorkspaceIndex();
    for (let i = 0; i < 10; i += 1) add(index, `f${i}.txt`, fn("F_Many"));
    const diagnostics = index.crossFileDiagnostics("f0.txt", { reportUnresolved: false, maxRelated: 3 });
    expect(diagnostics[0]!.related).toHaveLength(3);
  });

  it("renvoie une liste vide pour un fichier inconnu", () => {
    expect(new WorkspaceIndex().diagnosticsFor("missing.txt", STRICT)).toEqual([]);
  });
});

describe("WorkspaceIndex : commandes inconnues (RA0001)", () => {
  const COMMANDS = CommandRegistry.create(
    [
      { name: "mes", arity: { min: 1, max: null }, parameterTypes: "s*", signatures: [], documentation: null, deprecated: false, conditional: false, sources: [{ kind: "server-source", reference: "t" }] },
      { name: "close", arity: { min: 0, max: 0 }, parameterTypes: "", signatures: [], documentation: null, deprecated: false, conditional: false, sources: [{ kind: "server-source", reference: "t" }] },
    ],
    "rAthena",
  );
  const addWithCommands = (index: WorkspaceIndex, uri: string, text: string): void => {
    index.set(analyzeFile(parse(text), uri, { commands: COMMANDS }));
  };
  const OPTIONS = { severity: "warning", profile: "rAthena" } as const;

  it("signale un nom qui n'est ni une commande, ni une fonction locale, ni une fonction globale indexee", () => {
    const index = new WorkspaceIndex();
    const text = npc('mes "a";\nInconnue 1;\nF_Navi;\nf_navi;\nclose;');
    addWithCommands(index, "caller.txt", text);
    addWithCommands(index, "functions.txt", fn("F_Navi"));
    const found = index.unknownCommandDiagnostics("caller.txt", OPTIONS);
    // `F_Navi` est une fonction globale (appelable par son seul nom) ; `f_navi` ne l'est pas : la casse compte, comme pour callfunc.
    expect(found.map((d) => text.slice(d.range.start, d.range.end))).toEqual(["Inconnue", "f_navi"]);
    expect(found[0]).toMatchObject({
      code: "RA0001",
      category: "unknown-extension",
      severity: "warning",
      confidence: "unknown",
      source: "analyzer",
      params: { name: "Inconnue", profile: "rAthena" },
      message: "'Inconnue' is not a known command or function for profile rAthena.",
    });
  });

  it("applique la gravite choisie par le projet", () => {
    const index = new WorkspaceIndex();
    addWithCommands(index, "caller.txt", npc("Inconnue;\nclose;"));
    expect(index.unknownCommandDiagnostics("caller.txt", { severity: "info", profile: "rAthena" })[0]?.severity).toBe("info");
    expect(index.unknownCommandDiagnostics("caller.txt", { severity: "error", profile: "rAthena" })[0]?.severity).toBe("error");
  });

  it("tient compte d'une fonction globale ajoutee ou retiree apres coup", () => {
    const index = new WorkspaceIndex();
    addWithCommands(index, "caller.txt", npc("F_Late;\nclose;"));
    expect(index.unknownCommandDiagnostics("caller.txt", OPTIONS)).toHaveLength(1);
    addWithCommands(index, "functions.txt", fn("F_Late"));
    expect(index.unknownCommandDiagnostics("caller.txt", OPTIONS)).toEqual([]);
    index.delete("functions.txt");
    expect(index.unknownCommandDiagnostics("caller.txt", OPTIONS)).toHaveLength(1);
  });

  it("ne signale rien pour un fichier analyse sans registre ou inconnu", () => {
    const index = new WorkspaceIndex();
    add(index, "plain.txt", npc("Inconnue;\nclose;"));
    expect(index.unknownCommandDiagnostics("plain.txt", OPTIONS)).toEqual([]);
    expect(index.unknownCommandDiagnostics("missing.txt", OPTIONS)).toEqual([]);
  });
});
