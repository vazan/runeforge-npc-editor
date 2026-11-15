import { describe, expect, it } from "vitest";
import { footerImports, scanYamlDatabase } from "./yaml-db";
import type { YamlEntry } from "./yaml-db";

const lines = (...rows: string[]): string => rows.join("\n");
const WANTED: ReadonlySet<string> = new Set(["Id", "AegisName", "Name"]);

function scan(text: string, wanted: ReadonlySet<string> = WANTED): { entries: YamlEntry[]; info: ReturnType<typeof scanYamlDatabase> } {
  const entries: YamlEntry[] = [];
  const info = scanYamlDatabase(text, wanted, (entry) => entries.push(entry));
  return { entries, info };
}

describe("scanYamlDatabase - corps", () => {
  const DB = lines(
    "# commentaire de tete",
    "Header:",
    "  Type: ITEM_DB",
    "  Version: 3",
    "",
    "Body:",
    "  - Id: 501",
    "    AegisName: Red_Potion",
    "    Name: Red Potion",
    "    Type: Healing",
    "    Script: |",
    "      itemheal rand(45,65),0;",
    "      # Id: 999 (dans le script, a ignorer)",
    "  - Id: 502",
    "    # un commentaire entre deux champs",
    "    AegisName: Orange_Potion",
    "    Name: Orange Potion",
    "    Drops:",
    "      - Item: Jellopy",
    "        Rate: 100",
    "      - Id: 7",
    "        Name: Faux",
    "  - Id: 503",
  );

  it("rend chaque entree avec les seuls champs demandes, a la bonne ligne, et lit l'en-tete", () => {
    const { entries, info } = scan(DB);
    expect(info).toMatchObject({ type: "ITEM_DB", version: 3, clear: false, entries: 3, imports: [], unreadable: [] });
    expect(entries.map((entry) => [entry.line, entry.fields])).toEqual([
      [7, { Id: "501", AegisName: "Red_Potion", Name: "Red Potion" }],
      [14, { Id: "502", AegisName: "Orange_Potion", Name: "Orange Potion" }],
      [23, { Id: "503" }],
    ]);
  });

  it("ne confond ni le contenu d'un scalaire de bloc ni une liste imbriquee avec des entrees", () => {
    const { entries } = scan(DB);
    expect(entries).toHaveLength(3);
    expect(entries.some((entry) => entry.fields["Name"] === "Faux")).toBe(false);
  });

  it("lit les fins de ligne CRLF comme LF", () => {
    const crlf = DB.replace(/\n/g, "\r\n");
    expect(scan(crlf).entries.map((entry) => entry.fields)).toEqual(scan(DB).entries.map((entry) => entry.fields));
  });

  it("decode guillemets, apostrophes doublees et commentaires de fin de ligne", () => {
    const { entries } = scan(
      lines(
        "Body:",
        "  - Id: 1",
        '    Name: "Poring: \\"Doll\\""',
        "    AegisName: 'It''s'",
        "  - Id: 2 # commentaire",
        "    Name: Un # commentaire",
        "    AegisName: A#B",
      ),
    );
    expect(entries.map((entry) => entry.fields)).toEqual([
      { Id: "1", Name: 'Poring: "Doll"', AegisName: "It's" },
      { Id: "2", Name: "Un", AegisName: "A#B" },
    ]);
  });

  it("accepte une liste sans decalage et une indentation de quatre espaces", () => {
    expect(scan(lines("Body:", "- Id: 1", "  Name: A", "- Id: 2", "  Name: B")).entries.map((entry) => entry.fields)).toEqual([
      { Id: "1", Name: "A" },
      { Id: "2", Name: "B" },
    ]);
    expect(scan(lines("Body:", "    -   Id: 1", "        Name: A", "    -   Id: 2")).entries.map((entry) => entry.fields)).toEqual([{ Id: "1", Name: "A" }, { Id: "2" }]);
  });

  it("lit les tables en ligne, virgules entre guillemets comprises", () => {
    const { entries, info } = scan(lines("Body:", '  - {Id: 5, AegisName: "A, B", Name: C}', "  - { Id: 6 }", "  - Id: 7"));
    expect(entries.map((entry) => entry.fields)).toEqual([{ Id: "5", AegisName: "A, B", Name: "C" }, { Id: "6" }, { Id: "7" }]);
    expect(info.entries).toBe(3);
  });

  it("compte ce qu'il ne comprend pas sans l'inventer", () => {
    const { entries, info } = scan(lines("Body:", "  - Id: 1", "  - 42", "  - {Id: 3", "  - Id: 4"));
    expect(entries.map((entry) => entry.fields["Id"])).toEqual(["1", "4"]);
    expect(info.entries).toBe(4);
    expect(info.unreadable).toEqual([3, 4]);
  });

  it("n'appelle rien pour un fichier vide ou sans corps", () => {
    expect(scan("").entries).toEqual([]);
    expect(scan("# rien\n\n").info.entries).toBe(0);
    expect(scan(lines("Header:", "  Type: X", "  Version: 1")).entries).toEqual([]);
  });

  it("lit Header: Clear", () => {
    expect(scan(lines("Header:", "  Type: ITEM_DB", "  Version: 3", "  Clear: true", "Body:")).info.clear).toBe(true);
  });
});

describe("scanYamlDatabase - pied", () => {
  const FOOTER = lines(
    "Body:",
    "  - Id: 1",
    "Footer:",
    "  Imports:",
    "  - Path: db/pre-re/item_db.yml",
    "    Mode: Prerenewal",
    "  - Path: db/re/item_db.yml",
    "    Mode: Renewal",
    "  - Path: db/import/item_db.yml",
    "  - Path: db/generator/item_db.yml",
    "    Generator: true",
  );

  it("liste les imports avec leur mode et leur drapeau Generator", () => {
    expect(scan(FOOTER).info.imports).toEqual([
      { path: "db/pre-re/item_db.yml", mode: "Prerenewal", generator: false },
      { path: "db/re/item_db.yml", mode: "Renewal", generator: false },
      { path: "db/import/item_db.yml", mode: null, generator: false },
      { path: "db/generator/item_db.yml", mode: null, generator: true },
    ]);
  });

  it("retrouve les imports depuis la fin du texte seulement, meme coupee au milieu du corps", () => {
    const body = Array.from({ length: 50 }, (_, index) => `  - Id: ${index}\n    Name: N${index}`).join("\n");
    const text = `Header:\n  Type: X\n  Version: 1\nBody:\n${body}\n${FOOTER.slice(FOOTER.indexOf("Footer:"))}`;
    const tail = text.slice(text.length - 300);
    expect(footerImports(tail).map((entry) => entry.path)).toEqual(["db/pre-re/item_db.yml", "db/re/item_db.yml", "db/import/item_db.yml", "db/generator/item_db.yml"]);
    expect(footerImports(text.slice(0, 80))).toEqual([]);
  });

  it("accepte des imports sans decalage et un autre reglage apres la liste", () => {
    const text = lines("Footer:", "  Imports:", "  - Path: a.yml", "  - Path: b.yml", "    Mode: Renewal", "  Other: x");
    expect(footerImports(text).map((entry) => [entry.path, entry.mode])).toEqual([["a.yml", null], ["b.yml", "Renewal"]]);
  });
});
