import { describe, expect, it } from "vitest";
import { RATHENA_SCRIPT_CONSTANTS, RATHENA_SCRIPT_CONSTANTS_INFO } from "./script-constants-values";

describe("rAthena script constant values (generated)", () => {
  it("resolves the jobs, the sexes and the booleans that dialogue conditions compare against", () => {
    const value = (name: string): number | undefined => RATHENA_SCRIPT_CONSTANTS.get(name);
    expect(value("job_novice")).toBe(0);
    expect(value("job_knight")).toBe(7);
    expect(value("job_super_novice")).toBe(23);
    expect(value("job_novice_high")).toBe(4001);
    expect(value("job_rune_knight")).toBe(4054);
    expect(value("sex_female")).toBe(0);
    expect(value("sex_male")).toBe(1);
    expect(value("true")).toBe(1);
    expect(value("false")).toBe(0);
  });

  it("resolves the other enumerations the scripts read", () => {
    expect(RATHENA_SCRIPT_CONSTANTS.get("dt_hour")).toBe(3);
    expect(RATHENA_SCRIPT_CONSTANTS.get("ie_ok")).toBe(0);
    expect(RATHENA_SCRIPT_CONSTANTS.get("playtime")).toBe(1);
    expect(RATHENA_SCRIPT_CONSTANTS.get("hunting")).toBe(2);
    expect(RATHENA_SCRIPT_CONSTANTS.get("bl_npc")).toBe(128);
  });

  it("keeps only names, never an invented value for an ambiguous or unknown symbol", () => {
    expect(RATHENA_SCRIPT_CONSTANTS.has("max_chars")).toBe(false);
    expect(RATHENA_SCRIPT_CONSTANTS.has("no_such_constant")).toBe(false);
    expect(RATHENA_SCRIPT_CONSTANTS.size).toBe(RATHENA_SCRIPT_CONSTANTS_INFO.resolved);
    expect(RATHENA_SCRIPT_CONSTANTS_INFO.resolved).toBeGreaterThan(9_000);
    for (const [name, value] of RATHENA_SCRIPT_CONSTANTS) {
      expect(name).toBe(name.toLowerCase());
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });
});
