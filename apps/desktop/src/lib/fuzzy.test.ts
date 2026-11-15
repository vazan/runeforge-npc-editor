import { describe, expect, it } from "vitest";
import { fuzzyScore, fuzzyScorePath, rank } from "./fuzzy";

describe("fuzzyScore", () => {
  it("retourne null quand la requete n'est pas une sous-sequence", () => {
    expect(fuzzyScore("xyz", "prontera")).toBeNull();
    expect(fuzzyScore("tp", "prt")).toBeNull();
  });

  it("accepte une requete vide et ignore la casse et les espaces", () => {
    expect(fuzzyScore("", "abc")).toBe(0);
    expect(fuzzyScore("PRON", "prontera")).not.toBeNull();
    expect(fuzzyScore("pr on", "prontera")).not.toBeNull();
  });

  it("prefere les lettres consecutives et les debuts de mot", () => {
    const consecutive = fuzzyScore("prt", "prt_fild") ?? 0;
    const scattered = fuzzyScore("prt", "plain_rathena_tool") ?? 0;
    expect(consecutive).toBeGreaterThan(scattered);
    expect(fuzzyScore("ql", "quest_log") ?? 0).toBeGreaterThan(fuzzyScore("ql", "equal") ?? 0);
  });
});

describe("fuzzyScorePath / rank", () => {
  it("favorise une correspondance sur le nom du fichier", () => {
    const byName = fuzzyScorePath("pront", "npc/cities/prontera.txt") ?? 0;
    const byFolder = fuzzyScorePath("pront", "npc/prontera/other.txt") ?? 0;
    expect(byName).toBeGreaterThan(byFolder);
  });

  it("classe les resultats par score decroissant et limite leur nombre", () => {
    const files = ["npc/cities/prontera.txt", "npc/quests/prontera_quest.txt", "db/item_db.yml", "readme.md"];
    const ranked = rank("prontera", files, (path) => path, 10, true);
    expect(ranked.map((entry) => entry.item)).toEqual(["npc/cities/prontera.txt", "npc/quests/prontera_quest.txt"]);
    expect(rank("", files, (path) => path, 2, true)).toHaveLength(2);
    expect(rank("zzz", files, (path) => path)).toEqual([]);
  });
});
