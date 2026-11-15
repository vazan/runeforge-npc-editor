import { describe, expect, it } from "vitest";
import { RATHENA_JOB_CLASSES, RATHENA_JOB_CLASSES_INFO } from "./job-classes-values";
import { RATHENA_SCRIPT_CONSTANTS } from "./script-constants-values";

describe("rAthena job class names (generated)", () => {
  it("names the classes as the server's jobname() does", () => {
    const name = (id: number): string | undefined => RATHENA_JOB_CLASSES.find((job) => job.id === id)?.name;
    expect(name(0)).toBe("Novice");
    expect(name(1)).toBe("Swordsman");
    expect(name(2)).toBe("Magician");
    expect(name(7)).toBe("Knight");
    expect(name(23)).toBe("Super Novice");
    expect(name(4001)).toBe("High Novice");
    expect(name(4008)).toBe("Lord Knight");
    expect(name(4054)).toBe("Rune Knight");
    expect(name(4060)).toBe("Rune Knight T");
    expect(name(4252)).toBe("Dragon Knight");
  });

  it("lists each class once, by increasing identifier, without the mounted or costume variants of the same name", () => {
    const ids = RATHENA_JOB_CLASSES.map((job) => job.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(RATHENA_JOB_CLASSES.map((job) => job.name)).size).toBe(ids.length);
    expect(ids.length).toBe(RATHENA_JOB_CLASSES_INFO.classes);
    expect(RATHENA_JOB_CLASSES_INFO.named).toBeGreaterThan(ids.length);
    // Knight (7) and its mounted sprite (13), Crusader (14) and (21), the two Summer outfits (27 and 30), Lord Knight (4008) and (4014)...
    for (const variant of [13, 21, 30, 4014, 4022, 4036, 4048, 4080]) expect(ids).not.toContain(variant);
  });

  it("only offers identifiers that a Job_ constant of the server also names", () => {
    const constants = new Set([...RATHENA_SCRIPT_CONSTANTS].filter(([name]) => name.startsWith("job_")).map(([, value]) => value));
    for (const job of RATHENA_JOB_CLASSES) expect(constants.has(job.id), `${job.name} (${job.id})`).toBe(true);
  });
});
