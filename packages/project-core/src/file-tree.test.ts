import { describe, expect, it } from "vitest";
import { ancestorDirectories, buildTree, flattenVisible } from "./index";
import type { ScanEntryLike } from "./index";

const entries: ScanEntryLike[] = [
  { path: "npc", kind: "directory" },
  { path: "npc/cities", kind: "directory" },
  { path: "npc/cities/prontera.txt", kind: "file", size: 10 },
  { path: "npc/cities/alberta.txt", kind: "file", size: 20 },
  { path: "npc/quests", kind: "directory" },
  { path: "npc/quests/q10.txt", kind: "file", size: 1 },
  { path: "npc/quests/q2.txt", kind: "file", size: 1 },
  { path: "db", kind: "directory" },
  { path: "db/item_db.yml", kind: "file", size: 5 },
  { path: "Readme.md", kind: "file", size: 1 },
  { path: "empty", kind: "directory" },
];

describe("buildTree", () => {
  it("trie les dossiers avant les fichiers, en ordre naturel insensible a la casse", () => {
    const root = buildTree(entries);
    expect(root.children.map((node) => node.name)).toEqual(["db", "empty", "npc", "Readme.md"]);
    const quests = root.children.find((node) => node.name === "npc")?.children.find((node) => node.name === "quests");
    expect(quests?.children.map((node) => node.name)).toEqual(["q2.txt", "q10.txt"]);
  });

  it("cree les dossiers parents manquants", () => {
    const root = buildTree([{ path: "a/b/c.txt", kind: "file" }]);
    expect(root.children[0]?.name).toBe("a");
    expect(root.children[0]?.children[0]?.children[0]).toMatchObject({ name: "c.txt", path: "a/b/c.txt", kind: "file" });
  });
});

describe("flattenVisible", () => {
  const root = buildTree(entries);

  it("n'affiche que le premier niveau quand rien n'est deplie", () => {
    expect(flattenVisible(root, new Set()).map((row) => row.node.path)).toEqual(["db", "empty", "npc", "Readme.md"]);
  });

  it("affiche les enfants des dossiers deplies avec leur profondeur", () => {
    const rows = flattenVisible(root, new Set(["npc", "npc/cities"]));
    expect(rows.map((row) => [row.node.path, row.depth])).toEqual([
      ["db", 0],
      ["empty", 0],
      ["npc", 0],
      ["npc/cities", 1],
      ["npc/cities/alberta.txt", 2],
      ["npc/cities/prontera.txt", 2],
      ["npc/quests", 1],
      ["Readme.md", 0],
    ]);
  });

  it("filtre par nom en depliant les parents des resultats", () => {
    const rows = flattenVisible(root, new Set(), "prontera");
    expect(rows.map((row) => row.node.path)).toEqual(["npc", "npc/cities", "npc/cities/prontera.txt"]);
    expect(flattenVisible(root, new Set(), "zzz")).toEqual([]);
  });
});

describe("ancestorDirectories", () => {
  it("liste les dossiers parents d'un fichier", () => {
    expect(ancestorDirectories("a/b/c.txt")).toEqual(["a", "a/b"]);
    expect(ancestorDirectories("c.txt")).toEqual([]);
  });
});
