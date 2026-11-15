import { describe, expect, it } from "vitest";
import { parse } from "@runeforge/runescript-parser";
import { calledFunctions, resolveFunctions } from "./functions";
import type { FunctionSource } from "./types";

/** Une « bibliothèque » : un fichier dont les fonctions sont indexées par nom, comme dans l'index du projet. */
function library(source: string): Map<string, FunctionSource> {
  const functions = new Map<string, FunctionSource>();
  for (const declaration of parse(source).ast.declarations) {
    if (declaration.kind === "FunctionDeclaration") functions.set(declaration.name.toLowerCase(), { declaration, source });
  }
  return functions;
}

function npcBody(source: string) {
  const declaration = parse(source).ast.declarations.find((item) => item.kind === "NpcDeclaration");
  if (declaration?.kind !== "NpcDeclaration" || declaration.body === null) throw new Error("NPC expected");
  return declaration.body;
}

describe("calledFunctions", () => {
  it("finds the names written out in callfunc commands and calls, wherever they are", () => {
    const body = npcBody(`-\tscript\tA\t-1,{
      callfunc "F_One", 1;
      .@x = callfunc("F_Two");
      if (callfunc( "F_Three" ) > 0) { CALLFUNC "F_Four"; }
      callfunc .@name$;
      callfunc "";
      callsub S_Local;
      mes "callfunc \\"F_Text\\"";
    }\n`);
    expect([...calledFunctions(body)].sort()).toEqual(["F_Four", "F_One", "F_Three", "F_Two"]);
  });
});

describe("resolveFunctions", () => {
  const files = library(`
function\tscript\tF_Entry\t{ callfunc "F_Inner"; callfunc "F_Missing"; return; }
function\tscript\tF_Inner\t{ callfunc "F_Entry"; callfunc "F_Deep"; return; }
function\tscript\tF_Deep\t{ mes "deep"; return; }
function\tscript\tF_Unused\t{ callfunc "F_Never"; return; }
`);

  it("looks up what the code calls and what those functions call, once each, even in a cycle", async () => {
    const asked: string[] = [];
    const found = await resolveFunctions([npcBody('-\tscript\tA\t-1,{ callfunc "F_Entry"; callfunc "f_entry"; }\n')], new Map(), (name) => {
      asked.push(name);
      return files.get(name.toLowerCase());
    });
    expect([...found.keys()].sort()).toEqual(["f_deep", "f_entry", "f_inner"]);
    expect(asked.sort()).toEqual(["F_Deep", "F_Entry", "F_Inner", "F_Missing"]);
  });

  it("does not look up what is already known, and still follows its calls", async () => {
    const known = new Map([...files].filter(([name]) => name === "f_entry"));
    const asked: string[] = [];
    const found = await resolveFunctions([npcBody('-\tscript\tA\t-1,{ callfunc "F_Entry"; }\n')], known, async (name) => {
      asked.push(name);
      return files.get(name.toLowerCase());
    });
    expect(asked.sort()).toEqual(["F_Deep", "F_Inner", "F_Missing"]);
    expect(found.has("f_deep")).toBe(true);
    expect(known.size).toBe(1);
  });

  it("leaves a function the project does not have unknown, and bounds the number of lookups", async () => {
    const calls = Array.from({ length: 400 }, (_unused, index) => `callfunc "F_N${index}";`).join(" ");
    let asked = 0;
    const found = await resolveFunctions([npcBody(`-\tscript\tA\t-1,{ ${calls} }\n`)], new Map(), () => {
      asked += 1;
      return undefined;
    });
    expect(found.size).toBe(0);
    expect(asked).toBe(150);
  });
});
