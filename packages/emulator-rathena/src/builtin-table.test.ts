import { describe, expect, it } from "vitest";
import { parseBuiltinTable } from "./builtin-table";

// Fixture redigee pour ces tests : meme forme que la table d'un serveur rAthena, contenu original.
const SCRIPT_CPP = [
  "#define BUILDIN_DEF(x,args) { buildin_ ## x , #x , args, nullptr }",
  "#define BUILDIN_DEF2(x,x2,args) { buildin_ ## x , x2 , args, nullptr }",
  "",
  "/// script command definitions",
  "struct script_function buildin_func[] = {",
  "\t// NPC interaction",
  '\tBUILDIN_DEF(mes,"s*"),',
  '\tBUILDIN_DEF(next,""),',
  '\tBUILDIN_DEF2(close, "close3", ""),',
  '\tBUILDIN_DEF2(setr,"set","rv?"),',
  '\tBUILDIN_DEF(jobchange,"i??"), // commentaire de fin de ligne',
  '\t/* BUILDIN_DEF(commente,"i"), */',
  "\t/* debut de commentaire",
  '\t   BUILDIN_DEF(dans_un_bloc,"i"),',
  "\t   fin */",
  "#ifdef PCRE_SUPPORT",
  '\tBUILDIN_DEF(defpattern,"iss"),',
  "#endif",
  '\tBUILDIN_DEF_DEPRECATED(vieille,"ri","20230101"),',
  '\tBUILDIN_DEF2_DEPRECATED(foo,"bar","i","20240101"),',
  '\tBUILDIN_DEF(cassee,"x"),',
  "\tBUILDIN_DEF(",
  '\t   multiligne,"i"),',
  '\tBUILDIN_DEF(deux,"i"),',
  '\tBUILDIN_DEF(DEUX,"ii"),',
  "\t{nullptr,nullptr,nullptr},",
  "};",
  'BUILDIN_DEF(apres_la_table,"i")',
].join("\n");

describe("parseBuiltinTable", () => {
  const result = parseBuiltinTable(SCRIPT_CPP, "src/map/script.cpp");
  const byName = new Map(result.definitions.map((definition) => [definition.name, definition]));

  it("lit les noms et l'arite (BUILDIN_DEF et BUILDIN_DEF2 : le nom est l'alias)", () => {
    expect(byName.get("mes")?.arity).toEqual({ min: 1, max: null });
    expect(byName.get("mes")?.parameterTypes).toBe("s*");
    expect(byName.get("next")?.arity).toEqual({ min: 0, max: 0 });
    expect(byName.get("close3")?.arity).toEqual({ min: 0, max: 0 });
    expect(byName.get("set")?.arity).toEqual({ min: 2, max: 3 });
    expect(byName.get("jobchange")?.arity).toEqual({ min: 1, max: 3 });
    expect(byName.has("setr")).toBe(false);
    expect(byName.has("close")).toBe(false);
  });

  it("indique d'ou vient chaque commande (fichier et ligne)", () => {
    expect(byName.get("mes")?.sources).toEqual([{ kind: "server-source", reference: "src/map/script.cpp:7" }]);
    expect(byName.get("set")?.sources[0]?.reference).toBe("src/map/script.cpp:10");
  });

  it("ignore les commentaires, y compris sur plusieurs lignes, et ce qui suit la table", () => {
    expect(byName.has("commente")).toBe(false);
    expect(byName.has("dans_un_bloc")).toBe(false);
    expect(byName.has("apres_la_table")).toBe(false);
    expect(byName.has("x")).toBe(false);
  });

  it("marque les commandes sous #ifdef et les commandes depreciees", () => {
    expect(byName.get("defpattern")?.conditional).toBe(true);
    expect(byName.get("mes")?.conditional).toBe(false);
    expect(byName.get("DEUX")?.conditional).toBe(false);
    expect(byName.get("vieille")?.deprecated).toBe(true);
    expect(byName.get("bar")?.deprecated).toBe(true);
    expect(byName.get("bar")?.arity).toEqual({ min: 1, max: 1 });
    expect(byName.get("mes")?.deprecated).toBe(false);
  });

  it("signale ce qu'il ne comprend pas au lieu de l'ignorer en silence", () => {
    expect(result.unrecognized).toEqual(["22: BUILDIN_DEF("]);
    expect(result.invalid).toEqual(['cassee "x" (src/map/script.cpp:21)']);
    expect(byName.has("cassee")).toBe(false);
  });

  it("garde la derniere definition d'un nom defini plusieurs fois, comme le serveur", () => {
    expect(result.duplicates).toEqual(["DEUX"]);
    expect(byName.get("DEUX")?.arity).toEqual({ min: 2, max: 2 });
    expect(byName.has("deux")).toBe(false);
  });

  it("lit un fragment sans table (src/custom/script_def.inc)", () => {
    const fragment = parseBuiltinTable('// exemple\n//BUILDIN_DEF(exemple,""),\nBUILDIN_DEF(mon_cmd,"s?"),\n', "src/custom/script_def.inc");
    expect(fragment.definitions.map((d) => [d.name, d.arity])).toEqual([["mon_cmd", { min: 1, max: 2 }]]);
    expect(fragment.definitions[0]?.sources[0]?.reference).toBe("src/custom/script_def.inc:3");
  });

  it("supporte les fins de ligne CRLF", () => {
    const crlf = parseBuiltinTable(SCRIPT_CPP.replaceAll("\n", "\r\n"), "src/map/script.cpp");
    expect(crlf.definitions.map((d) => d.name)).toEqual(result.definitions.map((d) => d.name));
  });
});
