import { describe, expect, it } from "vitest";
import { rathenaEntryPoints, resolveRathenaScripts } from "./load-rules";
import { buildRathenaRegistry } from "./registry";

const SOURCE = [
  "struct script_function buildin_func[] = {",
  '\tBUILDIN_DEF(mes,"s*"),',
  '\tBUILDIN_DEF(next,""),',
  '\tBUILDIN_DEF(warpchar,"sii?"),',
  "\t{nullptr,nullptr,nullptr},",
  "};",
].join("\n");

const DOC = ["=====================", "|1.- Base.|", "=====================", '*mes "<string>"{,"<string>"};', "", "Affiche.", "", "*next;", "", "Attend.", "", "*close;", "", "Ferme.", ""].join("\n");

describe("buildRathenaRegistry", () => {
  it("combine la table du serveur (noms, arite) et la documentation (signatures, aide)", () => {
    const report = buildRathenaRegistry({ builtinSource: SOURCE, commandDoc: DOC });
    expect(report.level).toBe("server-source");
    expect(report.registry?.profileLabel).toBe("rAthena");
    expect(report.sourceCommands).toBe(3);
    expect(report.docCommands).toBe(3);
    expect(report.sourceOnly).toEqual(["warpchar"]);
    expect(report.docOnly).toEqual(["close"]);

    const mes = report.registry?.get("MES");
    expect(mes?.arity).toEqual({ min: 1, max: null });
    expect(mes?.signatures).toEqual(['mes "<string>"{,"<string>"};']);
    expect(mes?.documentation).toBe("Affiche.");
    expect(mes?.sources.map((source) => source.kind)).toEqual(["server-source", "server-doc"]);
    // Une commande uniquement documentee est connue, mais son arite n'est pas verifiee.
    expect(report.registry?.get("close")?.arity).toBeNull();
    // Une commande absente de la documentation reste connue grace a la table.
    expect(report.registry?.get("warpchar")?.arity).toEqual({ min: 3, max: 4 });
  });

  it("sans code source, se limite aux noms et signatures de la documentation, sans arite", () => {
    const report = buildRathenaRegistry({ commandDoc: DOC });
    expect(report.level).toBe("server-doc");
    expect(report.registry?.size).toBe(3);
    expect(report.registry?.stats().withArity).toBe(0);
    expect(report.sourceOnly).toEqual([]);
    expect(report.docOnly).toEqual([]);
  });

  it("n'invente pas de registre quand aucun fichier n'est exploitable", () => {
    expect(buildRathenaRegistry({})).toMatchObject({ registry: null, level: "none" });
    expect(buildRathenaRegistry({ builtinSource: null, commandDoc: null, customBuiltins: null }).registry).toBeNull();
    expect(buildRathenaRegistry({ commandDoc: "Aucun titre ici.\n" }).registry).toBeNull();
  });

  it("donne priorite aux commandes personnalisees du serveur (script_def.inc)", () => {
    const report = buildRathenaRegistry({
      builtinSource: SOURCE,
      customBuiltins: 'BUILDIN_DEF(mes,"s"),\nBUILDIN_DEF(maquette,"i?"),\n',
      commandDoc: DOC,
    });
    expect(report.customCommands).toBe(2);
    expect(report.registry?.get("mes")?.arity).toEqual({ min: 1, max: 1 });
    expect(report.registry?.get("maquette")?.arity).toEqual({ min: 1, max: 2 });
    expect(report.registry?.get("maquette")?.sources[0]).toEqual({ kind: "server-source", reference: "src/custom/script_def.inc:2" });
  });

  it("donne la priorite aux commandes declarees dans le projet, qui completent le registre du serveur", () => {
    const report = buildRathenaRegistry({
      builtinSource: SOURCE,
      commandDoc: DOC,
      projectCommands: [
        { name: "maquette", args: "s?", description: "Commande de mon fork." },
        { name: "MES", args: "s", description: null },
        { name: "sansarite", args: null, description: null },
      ],
    });
    expect(report.projectCommands).toBe(3);
    const maquette = report.registry?.get("maquette");
    expect(maquette).toMatchObject({ arity: { min: 1, max: 2 }, parameterTypes: "s?", documentation: "Commande de mon fork." });
    expect(maquette?.sources).toEqual([{ kind: "project", reference: ".runeforge/project.json" }]);
    // Le projet peut redefinir une commande du serveur (fork) : son arite l'emporte, la source du serveur complete.
    const mes = report.registry?.get("mes");
    expect(mes?.arity).toEqual({ min: 1, max: 1 });
    expect(mes?.name).toBe("MES");
    expect(mes?.sources.map((source) => source.kind)).toEqual(["project", "server-source", "server-doc"]);
    expect(mes?.signatures).toEqual(['mes "<string>"{,"<string>"};']);
    // Sans arite declaree, rien n'est verifie pour cette commande.
    expect(report.registry?.get("sansarite")?.arity).toBeNull();
  });

  it("ne cree jamais de registre a partir des seules commandes du projet", () => {
    const report = buildRathenaRegistry({ projectCommands: [{ name: "maquette", args: null, description: null }] });
    expect(report).toMatchObject({ registry: null, level: "none", projectCommands: 0 });
  });

  it("ignore une notation d'arguments invalide au lieu de verifier un nombre faux", () => {
    const report = buildRathenaRegistry({ builtinSource: SOURCE, projectCommands: [{ name: "oups", args: "zz", description: null }] });
    expect(report.registry?.get("oups")).toMatchObject({ arity: null, parameterTypes: null });
  });

  it("remonte les lignes que la table n'a pas permis de comprendre", () => {
    const report = buildRathenaRegistry({ builtinSource: `${SOURCE.replace("\t{nullptr", '\tBUILDIN_DEF(cassee,"x"),\n\t{nullptr')}` });
    expect(report.warnings).toEqual(['commande ignoree par le serveur : cassee "x" (src/map/script.cpp:5)']);
  });
});

describe("regles de chargement rAthena", () => {
  it("lit map_athena.conf puis la liste de scripts du mode de compilation", () => {
    expect(rathenaEntryPoints(true)).toEqual([
      { path: "conf/map_athena.conf", mode: "map-config" },
      { path: "npc/re/scripts_main.conf", mode: "npc-list" },
    ]);
    expect(rathenaEntryPoints(false)[1]).toEqual({ path: "npc/pre-re/scripts_main.conf", mode: "npc-list" });
  });

  it("n'inclut que les scripts du mode choisi (re et pre-re sont exclusifs)", async () => {
    const files: Record<string, string> = {
      "conf/map_athena.conf": "import: conf/import/map_conf.txt",
      "conf/import/map_conf.txt": "",
      "npc/re/scripts_main.conf": "npc: npc/re/a.txt\nnpc: npc/shared.txt",
      "npc/pre-re/scripts_main.conf": "npc: npc/pre-re/a.txt\nnpc: npc/shared.txt",
      "npc/re/a.txt": "",
      "npc/pre-re/a.txt": "",
      "npc/shared.txt": "",
    };
    const fileSystem = {
      readText: (path: string) => Promise.resolve(files[path] ?? null),
      existingFiles: (paths: readonly string[]) => Promise.resolve(new Set(paths.filter((path) => path in files))),
    };
    expect((await resolveRathenaScripts(fileSystem, true)).files).toEqual(["npc/re/a.txt", "npc/shared.txt"]);
    expect((await resolveRathenaScripts(fileSystem, false)).files).toEqual(["npc/pre-re/a.txt", "npc/shared.txt"]);
  });
});
