import { describe, expect, it } from "vitest";
import { findServerRoots, joinServerPath, locateServer, resolveLoadedMaps, resolveLoadedScripts, resolveRenewal } from "./server-profile";

describe("findServerRoots / locateServer", () => {
  it("reconnait la racine du projet comme racine de serveur", () => {
    const files = ["doc/script_commands.txt", "npc/re/scripts_main.conf", "npc/a.txt"];
    expect(findServerRoots(files)).toEqual([""]);
    expect(locateServer("", files)).toEqual({ status: "found", root: "", detected: true });
  });

  it("trouve un serveur dans un sous-dossier, par n'importe lequel de ses fichiers caracteristiques", () => {
    expect(findServerRoots(["Serveur/rathena/src/map/script.cpp"])).toEqual(["Serveur/rathena"]);
    expect(findServerRoots(["srv/conf/map_athena.conf"])).toEqual(["srv"]);
    expect(findServerRoots(["a/b/npc/pre-re/scripts_main.conf"])).toEqual(["a/b"]);
    expect(locateServer("", ["Serveur/rathena/doc/script_commands.txt"])).toEqual({ status: "found", root: "Serveur/rathena", detected: true });
  });

  it("ne choisit pas entre plusieurs serveurs, sauf si le projet est lui-meme un serveur", () => {
    const two = ["Serveur/a/doc/script_commands.txt", "Serveur/b/src/map/script.cpp", "autre/npc/a.txt"];
    expect(locateServer("", two)).toEqual({ status: "ambiguous", candidates: ["Serveur/a", "Serveur/b"] });
    expect(locateServer("", ["doc/script_commands.txt", ...two])).toMatchObject({ status: "found", root: "" });
  });

  it("ne confond pas un fichier au nom voisin avec un fichier caracteristique", () => {
    expect(findServerRoots(["backup-doc/script_commands.txt", "x/old_script_commands.txt", "src/map/script.cpp.bak"])).toEqual([]);
    expect(locateServer("", ["npc/a.txt"])).toEqual({ status: "not-found" });
  });

  it("prend telle quelle une racine imposee par la configuration", () => {
    expect(locateServer("mon/serveur", [])).toEqual({ status: "found", root: "mon/serveur", detected: false });
  });

  it("construit le chemin d'un fichier du serveur", () => {
    expect(joinServerPath("", "doc/x.txt")).toBe("doc/x.txt");
    expect(joinServerPath("srv", "doc/x.txt")).toBe("srv/doc/x.txt");
  });
});

describe("resolveRenewal", () => {
  it("prefere le mode impose par le projet", () => {
    expect(resolveRenewal("renewal", "//#define RENEWAL")).toEqual({ renewal: true, source: "config" });
    expect(resolveRenewal("pre-renewal", "#define RENEWAL")).toEqual({ renewal: false, source: "config" });
  });

  it("deduit le mode du serveur, sinon suppose renewal en le disant", () => {
    expect(resolveRenewal("auto", "#define RENEWAL\n")).toEqual({ renewal: true, source: "header" });
    expect(resolveRenewal("auto", "//#define RENEWAL\n")).toEqual({ renewal: false, source: "header" });
    expect(resolveRenewal("auto", null)).toEqual({ renewal: true, source: "default" });
  });
});

describe("resolveLoadedScripts", () => {
  const files = new Set([
    "srv/conf/map_athena.conf",
    "srv/npc/re/scripts_main.conf",
    "srv/npc/re/a.txt",
    "srv/npc/shared.txt",
    "srv/npc/pre-re/scripts_main.conf",
    "srv/npc/pre-re/a.txt",
  ]);
  const texts: Record<string, string> = {
    "srv/conf/map_athena.conf": "import: conf/import/map_conf.txt",
    "srv/npc/re/scripts_main.conf": "npc: npc/re/a.txt\nnpc: npc/shared.txt\nnpc: npc/manquant.txt",
    "srv/npc/pre-re/scripts_main.conf": "npc: npc/pre-re/a.txt\nnpc: npc/shared.txt",
  };
  const input = (renewal: boolean, root = "srv") => ({
    root,
    renewal,
    readText: (path: string) => Promise.resolve(texts[path] ?? null),
    hasFile: (path: string) => files.has(path),
  });

  it("liste les scripts du mode choisi, avec des chemins relatifs au projet", async () => {
    const renewal = await resolveLoadedScripts(input(true));
    expect(renewal.files).toEqual(["srv/npc/re/a.txt", "srv/npc/shared.txt"]);
    expect((await resolveLoadedScripts(input(false))).files).toEqual(["srv/npc/pre-re/a.txt", "srv/npc/shared.txt"]);
    expect(renewal.report.issues.map((issue) => issue.kind).sort()).toEqual(["missing-config", "missing-script"]);
  });

  it("fonctionne quand le projet est lui-meme la racine du serveur", async () => {
    const local = {
      root: "",
      renewal: true,
      readText: (path: string) => Promise.resolve(texts[`srv/${path}`] ?? null),
      hasFile: (path: string) => files.has(`srv/${path}`),
    };
    expect((await resolveLoadedScripts(local)).files).toEqual(["npc/re/a.txt", "npc/shared.txt"]);
  });
});

describe("resolveLoadedMaps", () => {
  const texts: Record<string, string> = {
    "srv/conf/map_athena.conf": "import: conf/maps_athena.conf\nmap: alberta.gat\nimport: conf/import/map_conf.txt",
    "srv/conf/maps_athena.conf": "//map: morocc\nmap: prontera\nmap: payon\n",
    "srv/conf/import/map_conf.txt": "delmap: payon\nmap: geffen\n",
  };
  const readText = (prefix: string) => (path: string) => Promise.resolve(texts[`${prefix}${path}`] ?? null);

  it("liste les cartes que le serveur charge, dans son ordre, avec ses imports et ses delmap, chemins relatifs au projet", async () => {
    expect(await resolveLoadedMaps({ root: "srv", renewal: true, readText: readText("") })).toEqual(["prontera", "alberta", "geffen"]);
  });

  it("fonctionne quand le projet est lui-meme la racine du serveur", async () => {
    expect(await resolveLoadedMaps({ root: "", renewal: false, readText: readText("srv/") })).toEqual(["prontera", "alberta", "geffen"]);
  });

  it("rend null, et non une liste vide, quand la liste n'est pas connue (configuration absente, ou sans aucune carte)", async () => {
    expect(await resolveLoadedMaps({ root: "srv", renewal: true, readText: () => Promise.resolve(null) })).toBeNull();
    expect(await resolveLoadedMaps({ root: "srv", renewal: true, readText: (path) => Promise.resolve(path === "srv/conf/map_athena.conf" ? "userid: s1\n" : null) })).toBeNull();
    expect(await resolveLoadedMaps({ root: "srv", renewal: true, readText: (path) => Promise.resolve(path === "srv/conf/map_athena.conf" ? "map: a\ndelmap: all\n" : null) })).toBeNull();
  });

  it("ne tient aucun compte de l'existence des scripts : seules les cartes comptent", async () => {
    const withScripts: Record<string, string> = { ...texts, "srv/npc/re/scripts_main.conf": "npc: npc/absent.txt\n" };
    const maps = await resolveLoadedMaps({ root: "srv", renewal: true, readText: (path) => Promise.resolve(withScripts[path] ?? null) });
    expect(maps).toEqual(["prontera", "alberta", "geffen"]);
  });
});
