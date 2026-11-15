import { describe, expect, it } from "vitest";
import { checkArity, CommandRegistry, formatArity, parseParameterTypes } from "./commands";
import type { CommandDefinition } from "./commands";

function definition(name: string, extra: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    name,
    arity: null,
    parameterTypes: null,
    signatures: [],
    documentation: null,
    deprecated: false,
    conditional: false,
    sources: [{ kind: "server-doc", reference: "doc/script_commands.txt:1" }],
    ...extra,
  };
}

describe("parseParameterTypes (notation des arguments du serveur)", () => {
  it.each([
    ["", { min: 0, max: 0 }],
    ["s*", { min: 1, max: null }],
    ["sl*", { min: 2, max: null }],
    ["i?", { min: 1, max: 2 }],
    ["i??", { min: 1, max: 3 }],
    ["?", { min: 0, max: 1 }],
    ["*", { min: 0, max: null }],
    ["rv*", { min: 2, max: null }],
    ["viiiiiiii?", { min: 9, max: 10 }],
  ])("%j", (types, expected) => {
    expect(parseParameterTypes(types)).toEqual(expected);
  });

  it.each(["x", "s?s", "*s", "s**", "?*?", "sx", " s", "S"])("refuse %j comme le serveur", (types) => {
    expect(parseParameterTypes(types)).toBeNull();
  });
});

describe("formatArity / checkArity", () => {
  it("ecrit l'arite sans langue", () => {
    expect(formatArity({ min: 2, max: 2 })).toBe("2");
    expect(formatArity({ min: 1, max: 3 })).toBe("1-3");
    expect(formatArity({ min: 2, max: null })).toBe("2+");
    expect(formatArity({ min: 0, max: 0 })).toBe("0");
  });

  it("verifie le nombre d'arguments", () => {
    const arity = { min: 1, max: 2 };
    expect(checkArity({ arity }, 0)).toEqual({ kind: "mismatch", arity });
    expect(checkArity({ arity }, 1)).toEqual({ kind: "ok" });
    expect(checkArity({ arity }, 2)).toEqual({ kind: "ok" });
    expect(checkArity({ arity }, 3)).toEqual({ kind: "mismatch", arity });
    expect(checkArity({ arity: { min: 1, max: null } }, 40)).toEqual({ kind: "ok" });
  });

  it("ne verifie rien quand l'arite est inconnue", () => {
    expect(checkArity({ arity: null }, 99)).toEqual({ kind: "unchecked" });
  });
});

describe("CommandRegistry", () => {
  const registry = CommandRegistry.create(
    [definition("mes", { arity: { min: 1, max: null }, parameterTypes: "s*" }), definition("WarpChar")],
    "rAthena",
  );

  it("retrouve une commande sans tenir compte de la casse (comme le serveur)", () => {
    expect(registry.has("MES")).toBe(true);
    expect(registry.has("warpchar")).toBe(true);
    expect(registry.get("Mes")?.name).toBe("mes");
    expect(registry.has("inconnue")).toBe(false);
    expect(registry.size).toBe(2);
    expect(registry.profileLabel).toBe("rAthena");
  });

  it("fusionne les definitions d'un meme nom : la premiere l'emporte, la suivante complete", () => {
    const merged = CommandRegistry.create(
      [
        definition("Close", { arity: { min: 0, max: 0 }, parameterTypes: "", sources: [{ kind: "server-source", reference: "src/map/script.cpp:3" }] }),
        definition("close", { signatures: ["close;"], documentation: "Ferme la fenetre.", deprecated: true }),
        definition("CLOSE", { signatures: ["close;", "close();"] }),
      ],
      "rAthena",
    );
    const close = merged.get("close");
    expect(merged.size).toBe(1);
    expect(close?.name).toBe("Close");
    expect(close?.arity).toEqual({ min: 0, max: 0 });
    expect(close?.parameterTypes).toBe("");
    expect(close?.signatures).toEqual(["close;", "close();"]);
    expect(close?.documentation).toBe("Ferme la fenetre.");
    expect(close?.deprecated).toBe(true);
    expect(close?.sources.map((s) => s.kind)).toEqual(["server-source", "server-doc", "server-doc"]);
  });

  it("une declaration de projet prioritaire remplace l'arite de la source", () => {
    const merged = CommandRegistry.create(
      [
        definition("foo", { arity: { min: 0, max: 5 }, sources: [{ kind: "project", reference: ".runeforge/project.json" }] }),
        definition("foo", { arity: { min: 1, max: 1 }, sources: [{ kind: "server-source", reference: "src/map/script.cpp:9" }] }),
      ],
      "rAthena",
    );
    expect(merged.get("foo")?.arity).toEqual({ min: 0, max: 5 });
  });

  it("compte les definitions par origine", () => {
    const stats = CommandRegistry.create(
      [
        definition("a", { arity: { min: 0, max: 0 }, sources: [{ kind: "server-source", reference: "s:1" }] }),
        definition("a"),
        definition("b"),
        definition("c", { arity: { min: 1, max: 1 }, sources: [{ kind: "project", reference: "p" }] }),
      ],
      "x",
    ).stats();
    expect(stats).toEqual({ total: 3, withArity: 2, fromServerSource: 1, fromServerDoc: 2, fromProject: 1 });
  });
});
