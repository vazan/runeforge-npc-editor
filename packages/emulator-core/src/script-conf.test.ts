import { describe, expect, it } from "vitest";
import { parseScriptConfLine, resolveScriptLoadOrder } from "./script-conf";
import type { ScriptLoadFileSystem } from "./script-conf";

describe("parseScriptConfLine (lecture identique a celle du serveur)", () => {
  it.each([
    ["npc: npc/a.txt", "npc", "npc/a.txt"],
    ["npc:npc/a.txt", "npc", "npc/a.txt"],
    ["npc:\tnpc/a.txt", "npc", "npc/a.txt"],
    ["npc: npc/a.txt\r", "npc", "npc/a.txt"],
    ["npc: npc/a.txt   ", "npc", "npc/a.txt"],
    ["npc: npc/a.txt\t// commentaire", "npc", "npc/a.txt"],
    ["npc: npc/a.txt // commentaire", "npc", "npc/a.txt"],
    ["import: conf/maps_athena.conf", "import", "conf/maps_athena.conf"],
    ["delnpc: npc/a.txt", "delnpc", "npc/a.txt"],
    ["userid: s1", "userid", "s1"],
  ])("%j", (line, setting, value) => {
    expect(parseScriptConfLine(line)).toEqual({ setting, value });
  });

  it("coupe au premier « // », meme au milieu d'un chemin (le serveur fait de meme)", () => {
    expect(parseScriptConfLine("npc: a//b.txt")).toEqual({ setting: "npc", value: "a" });
  });

  it("ne retire pas les espaces autour du nom du reglage : « npc : x » est un reglage inconnu", () => {
    expect(parseScriptConfLine("npc : x")).toEqual({ setting: "npc ", value: "x" });
    expect(parseScriptConfLine("  npc: x")).toEqual({ setting: "  npc", value: "x" });
  });

  it.each(["// npc: x", "//npc: x", ": x", "npc:", "npc:   ", "npc:\t", "pas de deux-points", ""])("ignore %j", (line) => {
    expect(parseScriptConfLine(line)).toBeNull();
  });
});

function memoryFileSystem(files: Record<string, string>): ScriptLoadFileSystem & { readonly reads: string[]; readonly checks: (readonly string[])[] } {
  const reads: string[] = [];
  const checks: (readonly string[])[] = [];
  const has = (path: string): boolean => Object.prototype.hasOwnProperty.call(files, path);
  return {
    reads,
    checks,
    readText: (path) => {
      reads.push(path);
      return Promise.resolve(has(path) ? (files[path] ?? null) : null);
    },
    existingFiles: (paths) => {
      checks.push(paths);
      return Promise.resolve(new Set(paths.filter(has)));
    },
  };
}

describe("resolveScriptLoadOrder", () => {
  it("developpe npc: et import: dans l'ordre du serveur, sans doublon", async () => {
    const fs = memoryFileSystem({
      "npc/scripts_main.conf": ["// debut", "npc: npc/a.txt", "import: npc/sub.conf", "npc: npc/d.txt", "npc: npc/a.txt"].join("\n"),
      "npc/sub.conf": "npc: npc/b.txt\nnpc: npc/c.txt\nnpc: npc/d.txt\n",
      "npc/a.txt": "",
      "npc/b.txt": "",
      "npc/c.txt": "",
      "npc/d.txt": "",
    });
    const report = await resolveScriptLoadOrder([{ path: "npc/scripts_main.conf", mode: "npc-list" }], fs);
    expect(report.files).toEqual(["npc/a.txt", "npc/b.txt", "npc/c.txt", "npc/d.txt"]);
    expect(report.configs).toEqual(["npc/scripts_main.conf", "npc/sub.conf"]);
    expect(report.issues).toEqual([]);
  });

  it("signale un script absent et continue sans l'ajouter", async () => {
    const fs = memoryFileSystem({ "main.conf": "npc: a.txt\nnpc: absent.txt\nnpc: b.txt\nnpc: absent.txt", "a.txt": "", "b.txt": "" });
    const report = await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], fs);
    expect(report.files).toEqual(["a.txt", "b.txt"]);
    expect(report.issues).toEqual([
      { kind: "missing-script", path: "absent.txt", config: "main.conf", line: 2 },
      { kind: "missing-script", path: "absent.txt", config: "main.conf", line: 4 },
    ]);
  });

  it("verifie l'existence des scripts en un seul appel groupe, sans doublon", async () => {
    const fs = memoryFileSystem({ "main.conf": "npc: a.txt\nnpc: b.txt\nnpc: a.txt\ndelnpc: b.txt", "a.txt": "", "b.txt": "" });
    await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], fs);
    expect(fs.checks).toEqual([["a.txt", "b.txt"]]);
    const none = memoryFileSystem({ "main.conf": "// rien" });
    await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], none);
    expect(none.checks).toEqual([]);
  });

  it("un fichier absent n'a aucun effet sur l'ordre ni sur delnpc", async () => {
    const fs = memoryFileSystem({ "main.conf": "npc: a.txt\nnpc: absent.txt\nnpc: b.txt\ndelnpc: absent.txt\nnpc: absent.txt", "a.txt": "", "b.txt": "" });
    const report = await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], fs);
    expect(report.files).toEqual(["a.txt", "b.txt"]);
    expect(report.issues.map((issue) => issue.kind)).toEqual(["missing-script", "missing-script"]);
  });

  it("signale une configuration absente (point d'entree ou import)", async () => {
    const fs = memoryFileSystem({ "main.conf": "import: nulle-part.conf\nnpc: a.txt", "a.txt": "" });
    const report = await resolveScriptLoadOrder(
      [
        { path: "main.conf", mode: "npc-list" },
        { path: "autre.conf", mode: "npc-list" },
      ],
      fs,
    );
    expect(report.files).toEqual(["a.txt"]);
    expect(report.issues).toEqual([
      { kind: "missing-config", path: "nulle-part.conf", importedFrom: "main.conf", line: 1 },
      { kind: "missing-config", path: "autre.conf", importedFrom: null, line: null },
    ]);
  });

  it("applique delnpc (un fichier, puis all) et npc: clear", async () => {
    const fs = memoryFileSystem({
      "main.conf": "npc: a.txt\nnpc: b.txt\nnpc: c.txt\ndelnpc: b.txt\ndelnpc: inconnu.txt\nnpc: b.txt",
      "a.txt": "",
      "b.txt": "",
      "c.txt": "",
      "all.conf": "npc: a.txt\nnpc: b.txt\ndelnpc: ALL\nnpc: c.txt",
      "clear.conf": "npc: a.txt\nnpc: CLEAR\nnpc: b.txt",
    });
    expect((await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], fs)).files).toEqual(["a.txt", "c.txt", "b.txt"]);
    expect((await resolveScriptLoadOrder([{ path: "all.conf", mode: "npc-list" }], fs)).files).toEqual(["c.txt"]);
    expect((await resolveScriptLoadOrder([{ path: "clear.conf", mode: "npc-list" }], fs)).files).toEqual(["b.txt"]);
  });

  it("est insensible a la casse pour les mots-cles mais exact pour les chemins", async () => {
    const fs = memoryFileSystem({ "main.conf": "NPC: a.txt\nnpc: A.txt\nImport: sub.conf", "a.txt": "", "sub.conf": "npc: a.txt" });
    const report = await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], fs);
    expect(report.files).toEqual(["a.txt"]);
    expect(report.issues).toEqual([{ kind: "missing-script", path: "A.txt", config: "main.conf", line: 2 }]);
  });

  it("detecte les imports circulaires sans boucler", async () => {
    const fs = memoryFileSystem({ "a.conf": "npc: x.txt\nimport: b.conf", "b.conf": "npc: y.txt\nimport: a.conf\nimport: b.conf", "x.txt": "", "y.txt": "" });
    const report = await resolveScriptLoadOrder([{ path: "a.conf", mode: "npc-list" }], fs);
    expect(report.files).toEqual(["x.txt", "y.txt"]);
    expect(report.issues).toEqual([
      { kind: "import-cycle", path: "a.conf", config: "b.conf", line: 2 },
      { kind: "import-cycle", path: "b.conf", config: "b.conf", line: 3 },
    ]);
  });

  it("relit un fichier importe par deux chemins (comme le serveur) sans dupliquer ses scripts", async () => {
    const fs = memoryFileSystem({
      "main.conf": "import: left.conf\nimport: right.conf",
      "left.conf": "import: shared.conf",
      "right.conf": "import: shared.conf",
      "shared.conf": "npc: s.txt",
      "s.txt": "",
    });
    const report = await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], fs);
    expect(report.files).toEqual(["s.txt"]);
    expect(fs.reads.filter((path) => path === "shared.conf")).toHaveLength(2);
  });

  it("n'avertit des reglages inconnus que dans une liste de scripts, pas dans la configuration de la map", async () => {
    const fs = memoryFileSystem({
      "conf/map_athena.conf": "userid: s1\nmap: prontera\nimport: conf/import/map_conf.txt",
      "conf/import/map_conf.txt": "npc: custom/x.txt\nautosave_time: 60",
      "custom/x.txt": "",
      "npc/scripts_main.conf": "npc: custom/x.txt\nnpc : y.txt\nbonus: 1",
    });
    const report = await resolveScriptLoadOrder(
      [
        { path: "conf/map_athena.conf", mode: "map-config" },
        { path: "npc/scripts_main.conf", mode: "npc-list" },
      ],
      fs,
    );
    expect(report.files).toEqual(["custom/x.txt"]);
    expect(report.issues).toEqual([
      { kind: "unknown-setting", setting: "npc ", config: "npc/scripts_main.conf", line: 2 },
      { kind: "unknown-setting", setting: "bonus", config: "npc/scripts_main.conf", line: 3 },
    ]);
  });

  it("charge d'abord les scripts de la configuration de la map, puis ceux de scripts_main.conf", async () => {
    const fs = memoryFileSystem({
      "conf/map_athena.conf": "npc: a.txt",
      "npc/scripts_main.conf": "npc: b.txt",
      "a.txt": "",
      "b.txt": "",
    });
    const report = await resolveScriptLoadOrder(
      [
        { path: "conf/map_athena.conf", mode: "map-config" },
        { path: "npc/scripts_main.conf", mode: "npc-list" },
      ],
      fs,
    );
    expect(report.files).toEqual(["a.txt", "b.txt"]);
  });

  describe("cartes chargees (map: et delmap: de la configuration de la map)", () => {
    const maps = async (files: Record<string, string>, entry = "conf/map_athena.conf"): Promise<readonly string[]> =>
      (await resolveScriptLoadOrder([{ path: entry, mode: "map-config" }], memoryFileSystem(files))).maps;

    it("lit map: dans l'ordre, dans la configuration et dans ses imports, sans l'extension .gat", async () => {
      expect(
        await maps({
          "conf/map_athena.conf": "map: prontera\nimport: conf/maps_athena.conf\nmap: alberta.gat\nmap: payon",
          "conf/maps_athena.conf": "//map: morocc\nmap: geffen // commentaire\nmap: aldebaran",
        }),
      ).toEqual(["prontera", "geffen", "aldebaran", "alberta", "payon"]);
    });

    it("applique delmap: (la premiere carte de ce nom, puis all) et map: clear", async () => {
      expect(await maps({ "conf/map_athena.conf": "map: a\nmap: b\nmap: a\ndelmap: a\nmap: c" })).toEqual(["b", "a", "c"]);
      expect(await maps({ "conf/map_athena.conf": "map: a\nmap: b\ndelmap: all\nmap: c" })).toEqual(["c"]);
      expect(await maps({ "conf/map_athena.conf": "map: a\nmap: b\nmap: clear\nmap: c" })).toEqual(["c"]);
      expect(await maps({ "conf/map_athena.conf": "map: a\ndelmap: inconnue\ndelmap: a.gat" })).toEqual([]);
    });

    it("garde un nom deja present une seconde fois, comme le serveur, et distingue les casses", async () => {
      expect(await maps({ "conf/map_athena.conf": "map: prontera\nmap: prontera\nmap: Prontera" })).toEqual(["prontera", "prontera", "Prontera"]);
    });

    it("insensible a la casse pour les mots-cles seulement, et ignore une ligne sans valeur", async () => {
      expect(await maps({ "conf/map_athena.conf": "MAP: a\nDelMap: b\nmap:\nmap: c" })).toEqual(["a", "c"]);
    });

    it("n'en lit pas dans une liste de scripts : le serveur les y signale comme reglage inconnu", async () => {
      const report = await resolveScriptLoadOrder(
        [
          { path: "conf/map_athena.conf", mode: "map-config" },
          { path: "npc/scripts_main.conf", mode: "npc-list" },
        ],
        memoryFileSystem({ "conf/map_athena.conf": "map: a", "npc/scripts_main.conf": "map: ignoree\ndelmap: a\nnpc: x.txt", "x.txt": "" }),
      );
      expect(report.maps).toEqual(["a"]);
      expect(report.issues).toEqual([
        { kind: "unknown-setting", setting: "map", config: "npc/scripts_main.conf", line: 1 },
        { kind: "unknown-setting", setting: "delmap", config: "npc/scripts_main.conf", line: 2 },
      ]);
    });

    it("est vide sans configuration de la map, et ne change ni les scripts ni les problemes", async () => {
      const report = await resolveScriptLoadOrder([{ path: "conf/map_athena.conf", mode: "map-config" }], memoryFileSystem({}));
      expect(report.maps).toEqual([]);
      expect(report.issues).toEqual([{ kind: "missing-config", path: "conf/map_athena.conf", importedFrom: null, line: null }]);
    });
  });

  it("borne la profondeur des imports", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`c${i}.conf`] = `import: c${i + 1}.conf`;
    const report = await resolveScriptLoadOrder([{ path: "c0.conf", mode: "npc-list" }], memoryFileSystem(files), { maxImportDepth: 4 });
    expect(report.configs).toEqual(["c0.conf", "c1.conf", "c2.conf", "c3.conf"]);
    expect(report.issues).toEqual([{ kind: "limit", limit: "depth", path: "c4.conf", config: "c3.conf", line: 1 }]);
  });

  it("borne le nombre de lectures", async () => {
    const files: Record<string, string> = { "main.conf": "import: x.conf\nimport: x.conf\nimport: x.conf", "x.conf": "" };
    const report = await resolveScriptLoadOrder([{ path: "main.conf", mode: "npc-list" }], memoryFileSystem(files), { maxConfigReads: 3 });
    expect(report.configs).toEqual(["main.conf", "x.conf", "x.conf"]);
    expect(report.issues).toEqual([{ kind: "limit", limit: "reads", path: "x.conf", config: "main.conf", line: 3 }]);
  });
});
