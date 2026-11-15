import { describe, expect, it } from "vitest";
import { CommandRegistry, parseParameterTypes } from "@runeforge/emulator-core";
import type { CommandDefinition, DefinitionSourceKind } from "@runeforge/emulator-core";
import { LineIndex } from "@runeforge/runescript-core";
import type { Position } from "@runeforge/runescript-core";
import { LanguageServer } from "./server";
import { CompletionItemKind } from "./types";

const npc = (body: string, name = "Test"): string => `prontera,150,150,4\tscript\t${name}\t4_M_01,{\n${body}\n}\n`;

interface DefinitionOptions {
  readonly types?: string | null;
  readonly signatures?: readonly string[];
  readonly documentation?: string | null;
  readonly source?: DefinitionSourceKind;
  readonly deprecated?: boolean;
  readonly conditional?: boolean;
}

function definition(name: string, options: DefinitionOptions = {}): CommandDefinition {
  const types = options.types === undefined ? null : options.types;
  const source = options.source ?? "server-source";
  return {
    name,
    arity: types === null ? null : parseParameterTypes(types),
    parameterTypes: types,
    signatures: options.signatures ?? [],
    documentation: options.documentation ?? null,
    deprecated: options.deprecated ?? false,
    conditional: options.conditional ?? false,
    sources: [{ kind: source, reference: `${source === "server-doc" ? "doc/script_commands.txt" : "src/map/script.cpp"}:1` }],
  };
}

const LONG_DOC = Array.from({ length: 40 }, (_, i) => `Ligne ${i + 1} de l'aide.`).join("\n");

const REGISTRY = CommandRegistry.create(
  [
    definition("mes", { types: "s*", signatures: ['mes "<string>"{,"<string>"{,...}};'], documentation: "Affiche une boite de dialogue.\n\n\tmes \"Bonjour\";" }),
    definition("menu", { types: "sl*", signatures: ['menu "<option_text>",<target_label>{,"<option_text>",<target_label>,...};'] }),
    definition("close", { types: "" }),
    definition("next", { types: "" }),
    definition("warp", { types: "sii?" }),
    definition("rand", { types: "i?", signatures: ["rand(<number>{,<number>})"], documentation: LONG_DOC }),
    definition("getitemname", { types: "v", signatures: ["getitemname(<item id>)", "getitemname(<aegis item name>)"] }),
    definition("set", { types: "rv?", signatures: ["set <variable>,<expression>{,<char_id>};", "set(<variable>,<expression>{,<char id>})"] }),
    definition("goto", { types: "l", signatures: ["goto <label>;"], documentation: "Saute a un label." }),
    definition("return", { types: "?", signatures: ["return {<value>};"] }),
    definition("oldcmd", { types: "i", deprecated: true, conditional: true }),
    definition("mycmd", { types: "s?", source: "project" }),
    definition("manualonly", { types: null, source: "server-doc", signatures: ["manualonly <a>,<b>;"] }),
  ],
  "rAthena",
);

/** Ouvre `source` (le caractere `|` marque le curseur, retire du texte) dans un service dote du registre. */
function setup(source: string, options: { registry?: CommandRegistry | null } = {}): { ls: LanguageServer; position: Position; text: string } {
  const ls = new LanguageServer();
  ls.setCommandRegistry(options.registry === undefined ? REGISTRY : options.registry);
  const offset = source.indexOf("|");
  if (offset === -1) throw new Error("curseur | absent");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  ls.updateDocument("a.txt", 1, text);
  return { ls, position: new LineIndex(text).positionAt(offset), text };
}

const labels = (items: readonly { label: string }[]): string[] => items.map((item) => item.label);

describe("completion des commandes", () => {
  it("propose au debut d'une instruction les commandes, fonctions locales et mots-cles qui correspondent au fragment", () => {
    const { ls, position } = setup(npc("\tfunction Helper {\n\t\treturn;\n\t}\n\tm|"));
    const items = ls.completion("a.txt", position);
    // Les commandes qui commencent par « m », puis celles qui contiennent un « m » (le filtre de Monaco affine ensuite).
    expect(labels(items)).toEqual(["mes", "menu", "mycmd", "manualonly", "oldcmd", "getitemname"]);
    const [mes] = items;
    expect(mes).toMatchObject({
      kind: CompletionItemKind.Function,
      detail: 'mes "<string>"{,"<string>"{,...}}',
      command: { source: "server-source", deprecated: false },
    });
  });

  it("preserve l'ordre de pertinence des commandes lorsque Monaco trie par sortText", () => {
    const { ls, position } = setup(npc("\tme|"));
    const items = ls.completion("a.txt", position);
    const sortedForMonaco = [...items].sort((left, right) => left.sortText.localeCompare(right.sortText));
    expect(sortedForMonaco.slice(0, 2).map((item) => item.label)).toEqual(["mes", "menu"]);
  });

  it("classe les fonctions locales avant les commandes du serveur, les commandes du projet avant celles du serveur, puis les mots-cles", () => {
    const { ls, position } = setup(npc("\tfunction Helper {\n\t\treturn;\n\t}\n\tfunction Next2;\n\tne|"));
    const items = ls.completion("a.txt", position);
    const bySort = [...items].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((item) => item.label);
    expect(bySort.indexOf("Next2")).toBeLessThan(bySort.indexOf("next"));
    const all = setup(npc("\t|")).ls.completion("a.txt", setup(npc("\t|")).position, { explicit: true });
    const sorted = [...all].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((item) => item.label);
    expect(sorted.indexOf("mycmd")).toBeLessThan(sorted.indexOf("mes"));
    expect(sorted.indexOf("mes")).toBeLessThan(sorted.indexOf("if"));
    const keyword = all.find((item) => item.label === "if");
    expect(keyword?.kind).toBe(CompletionItemKind.Keyword);
    expect(keyword?.command).toBeUndefined();
  });

  it("ne s'ouvre pas tout seul sans fragment saisi, mais repond a la completion demandee", () => {
    const { ls, position } = setup(npc("\tclose;\n\t|"));
    expect(ls.completion("a.txt", position)).toEqual([]);
    const explicit = ls.completion("a.txt", position, { explicit: true });
    expect(labels(explicit)).toEqual(expect.arrayContaining(["mes", "warp", "if", "for", "mycmd"]));
    expect(explicit.length).toBeGreaterThan(15);
  });

  it("remplace le fragment saisi et le mot qui le prolonge", () => {
    const { ls, position, text } = setup(npc("\tme|s \"a\";"));
    const item = ls.completion("a.txt", position).find((candidate) => candidate.label === "mes");
    const index = new LineIndex(text);
    expect(text.slice(index.offsetAt(item!.range.start, text), index.offsetAt(item!.range.end, text))).toBe("mes");
  });

  it("propose les commandes comme fonctions a une position d'operande, sans mots-cles", () => {
    const { ls, position } = setup(npc("\t.@r = ra|"));
    expect(labels(ls.completion("a.txt", position))).toEqual(["rand"]);
    const second = setup(npc("\tmes ge|"));
    expect(labels(second.ls.completion("a.txt", second.position))).toEqual(["getitemname"]);
    const third = setup(npc("\tif (cl|"));
    expect(labels(third.ls.completion("a.txt", third.position))).toEqual(["close"]);
    expect(labels(setup(npc("\t.@r = i|")).ls.completion("a.txt", setup(npc("\t.@r = i|")).position))).not.toContain("if");
  });

  it("n'ouvre pas la liste apres un espace ou une virgule en position d'operande, sauf demande explicite", () => {
    const { ls, position } = setup(npc('\tmes "a", |'));
    expect(ls.completion("a.txt", position)).toEqual([]);
    expect(labels(ls.completion("a.txt", position, { explicit: true }))).toContain("rand");
  });

  it("garde les propositions de label pour goto, callsub et menu", () => {
    const { ls, position } = setup(npc("L_End:\n\tclose;\n\tgoto L|"));
    expect(labels(ls.completion("a.txt", position))).toEqual(["L_End"]);
  });

  it("ne propose aucune commande hors du corps d'un script, dans un commentaire ou dans une chaine", () => {
    const header = setup("prontera,150,150,4\tscript\tNo|m\t4_M_01,{\n\tclose;\n}\n");
    expect(header.ls.completion("a.txt", header.position, { explicit: true })).toEqual([]);
    const between = setup(npc("\tclose;") + "m|\n");
    expect(between.ls.completion("a.txt", between.position)).toEqual([]);
    const comment = setup(npc("\t// m|"));
    expect(comment.ls.completion("a.txt", comment.position, { explicit: true })).toEqual([]);
    const text = setup(npc('\tmes "m|'));
    expect(text.ls.completion("a.txt", text.position, { explicit: true })).toEqual([]);
  });

  it("sans registre, ne propose que les mots-cles et les fonctions locales", () => {
    const { ls, position } = setup(npc("\tfunction Helper {\n\t\treturn;\n\t}\n\t|"), { registry: null });
    expect(labels(ls.completion("a.txt", position, { explicit: true })).sort()).toEqual(
      ["Helper", "break", "case", "continue", "default", "do", "else", "for", "function", "if", "switch", "while"].sort(),
    );
    const typed = setup(npc("\tm|"), { registry: null });
    expect(typed.ls.completion("a.txt", typed.position)).toEqual([]);
  });

  it("signale une commande obsolete et reprend l'origine de sa definition", () => {
    const { ls, position } = setup(npc("\told|"));
    expect(ls.completion("a.txt", position)[0]).toMatchObject({ label: "oldcmd", command: { source: "server-source", deprecated: true } });
    const manual = setup(npc("\tmanual|"));
    expect(manual.ls.completion("a.txt", manual.position)[0]).toMatchObject({ label: "manualonly", command: { source: "server-doc" }, detail: "manualonly <a>,<b>" });
  });

  it("donne une signature generee quand le manuel n'en a pas", () => {
    const { ls, position } = setup(npc("\twar|"));
    expect(ls.completion("a.txt", position)[0]).toMatchObject({ label: "warp", detail: "warp(string, int, int, [optional])" });
  });
});

describe("aide de signature", () => {
  it("affiche la signature du manuel et met en evidence l'argument en cours", () => {
    const { ls, position } = setup(npc("\tmes |"));
    const help = ls.signatureHelp("a.txt", position);
    expect(help).toBeDefined();
    expect(help?.signatures[0]?.label).toBe('mes "<string>"{,"<string>"{,...}}');
    expect(help?.activeSignature).toBe(0);
    expect(help?.activeParameter).toBe(0);
    const [first, second] = help?.signatures[0]?.parameters ?? [];
    const label = help?.signatures[0]?.label ?? "";
    expect([label.slice(first?.start, first?.end), label.slice(second?.start, second?.end)]).toEqual(['"<string>"', '"<string>"']);
  });

  it("suit les virgules et garde le dernier parametre actif pour un nombre libre d'arguments", () => {
    const second = setup(npc('\tmes "a", |'));
    expect(second.ls.signatureHelp("a.txt", second.position)?.activeParameter).toBe(1);
    const far = setup(npc('\tmes "a", "b", "c", "d", |'));
    expect(far.ls.signatureHelp("a.txt", far.position)?.activeParameter).toBe(1);
  });

  it("genere une signature depuis la table quand le manuel n'en a pas", () => {
    const { ls, position } = setup(npc('\twarp "prontera", 150, |'));
    const help = ls.signatureHelp("a.txt", position);
    expect(help?.signatures.map((signature) => signature.label)).toEqual(["warp(string, int, int, [optional])"]);
    expect(help?.activeParameter).toBe(2);
    const [, , third] = help?.signatures[0]?.parameters ?? [];
    expect(help?.signatures[0]?.label.slice(third?.start, third?.end)).toBe("int");
  });

  it("comprend un appel parenthese en expression et revient a la commande englobante", () => {
    const call = setup(npc("\t.@a = rand(1, |"));
    const help = call.ls.signatureHelp("a.txt", call.position);
    expect(help?.command.name).toBe("rand");
    expect(help?.activeParameter).toBe(1);

    const nested = setup(npc("\tmes getitemname(|"));
    expect(nested.ls.signatureHelp("a.txt", nested.position)?.command.name).toBe("getitemname");
    const after = setup(npc("\tmes getitemname(501), |"));
    expect(after.ls.signatureHelp("a.txt", after.position)).toMatchObject({ activeParameter: 1, command: { name: "mes" } });
  });

  it("suit un appel ecrit sur plusieurs lignes", () => {
    const { ls, position } = setup(npc('\tmenu "A", L_A,\n\t\t"B", |'));
    const help = ls.signatureHelp("a.txt", position);
    expect(help?.command.name).toBe("menu");
    expect(help?.activeParameter).toBe(3);
  });

  it("choisit parmi plusieurs signatures celle qui peut recevoir l'argument", () => {
    const { ls, position } = setup(npc("\tset .@a, 1, |"));
    const help = ls.signatureHelp("a.txt", position);
    expect(help?.signatures).toHaveLength(2);
    expect(help?.activeSignature).toBe(0);
    expect(help?.activeParameter).toBe(2);
  });

  it("laisse l'argument hors des parametres quand il y en a trop", () => {
    const { ls, position } = setup(npc("\tclose |"));
    expect(ls.signatureHelp("a.txt", position)).toMatchObject({ activeParameter: 0 });
    const tooMany = setup(npc("\tgetitemname(1, 2, |"));
    const help = tooMany.ls.signatureHelp("a.txt", tooMany.position);
    expect(help?.activeParameter).toBe(2);
    expect(help?.signatures[0]?.parameters).toHaveLength(1);
  });

  it("n'affiche rien sur le nom lui-meme, hors d'un appel, pour un nom inconnu, dans un commentaire ou hors d'un script", () => {
    const onName = setup(npc("\tmes|"));
    expect(onName.ls.signatureHelp("a.txt", onName.position)).toBeUndefined();
    const none = setup(npc("\tclose;|"));
    expect(none.ls.signatureHelp("a.txt", none.position)).toBeUndefined();
    const unknown = setup(npc("\tinconnue 1, |"));
    expect(unknown.ls.signatureHelp("a.txt", unknown.position)).toBeUndefined();
    const comment = setup(npc("\tmes 1, // un, deux |"));
    expect(comment.ls.signatureHelp("a.txt", comment.position)).toBeUndefined();
    const header = setup("prontera,1,1,0\tscript\tNo|m\t4_M_01,{\n\tclose;\n}\n");
    expect(header.ls.signatureHelp("a.txt", header.position)).toBeUndefined();
  });

  it("n'affiche rien sans registre", () => {
    const { ls, position } = setup(npc("\tmes |"), { registry: null });
    expect(ls.signatureHelp("a.txt", position)).toBeUndefined();
  });

  it("joint l'extrait d'aide et l'origine de la definition", () => {
    const { ls, position } = setup(npc("\tmes |"));
    const command = ls.signatureHelp("a.txt", position)?.command;
    expect(command?.documentation).toContain("Affiche une boite de dialogue.");
    expect(command?.sources).toEqual([{ kind: "server-source", reference: "src/map/script.cpp:1" }]);
  });
});

describe("survol des commandes", () => {
  it("decrit la commande sous le curseur : signatures, arite, aide et origine", () => {
    const { ls, position } = setup(npc('\tm|es "Bonjour";'));
    const hover = ls.hover("a.txt", position);
    expect(hover).toMatchObject({ kind: "command", name: "mes" });
    if (hover?.kind !== "command") throw new Error("survol de commande attendu");
    expect(hover.info.signatures).toEqual(['mes "<string>"{,"<string>"{,...}}']);
    expect(hover.info.arity).toEqual({ min: 1, max: null });
    expect(hover.info.parameterTypes).toBe("s*");
    expect(hover.info.documentation).toBe('Affiche une boite de dialogue.\n\n  mes "Bonjour";');
    expect(hover.info.documentationTruncated).toBe(false);
    expect(hover.info.deprecated).toBe(false);
    expect(hover.info.sources).toEqual([{ kind: "server-source", reference: "src/map/script.cpp:1" }]);
    // La plage est celle du nom seul.
    expect(hover.range).toEqual({ start: { line: 1, character: 1 }, end: { line: 1, character: 4 } });
  });

  it("decrit une fonction native employee dans une expression, et goto / return", () => {
    const call = setup(npc("\t.@a = ra|nd(1, 2);"));
    expect(call.ls.hover("a.txt", call.position)).toMatchObject({ kind: "command", name: "rand" });
    const jump = setup(npc("L_A:\n\tgo|to L_A;"));
    expect(jump.ls.hover("a.txt", jump.position)).toMatchObject({ kind: "command", name: "goto" });
    const out = setup(npc("\tret|urn;"));
    expect(out.ls.hover("a.txt", out.position)).toMatchObject({ kind: "command", name: "return" });
  });

  it("coupe une aide longue et le signale", () => {
    const { ls, position } = setup(npc("\t.@a = ra|nd(1, 2);"));
    const hover = ls.hover("a.txt", position);
    if (hover?.kind !== "command") throw new Error("survol de commande attendu");
    expect(hover.info.documentationTruncated).toBe(true);
    expect(hover.info.documentation?.split("\n").length).toBeLessThanOrEqual(14);
    expect(hover.info.documentation).toContain("Ligne 1 de l'aide.");
    expect(hover.info.documentation).not.toContain("Ligne 40");
  });

  it("indique l'obsolescence, la compilation conditionnelle et un arite inconnue (manuel seul)", () => {
    const old = setup(npc("\told|cmd 1;"));
    const hover = old.ls.hover("a.txt", old.position);
    if (hover?.kind !== "command") throw new Error("survol de commande attendu");
    expect(hover.info).toMatchObject({ deprecated: true, conditional: true, signatures: ["oldcmd(int)"] });
    const manual = setup(npc("\tmanual|only 1, 2;"));
    const manualHover = manual.ls.hover("a.txt", manual.position);
    if (manualHover?.kind !== "command") throw new Error("survol de commande attendu");
    expect(manualHover.info.arity).toBeNull();
    expect(manualHover.info.sources[0]?.kind).toBe("server-doc");
  });

  it("ne decrit pas les arguments, et laisse le survol des symboles du projet inchange", () => {
    const argument = setup(npc('\tmes "Bon|jour";'));
    expect(argument.ls.hover("a.txt", argument.position)).toBeUndefined();
    const ls = new LanguageServer();
    ls.setCommandRegistry(REGISTRY);
    ls.indexText("lib.txt", "function\tscript\tF_Lib\t{\n\treturn;\n}\n");
    const text = npc('\tcallfunc "F_Lib";\n\tF_Lib;');
    ls.updateDocument("a.txt", 1, text);
    const index = new LineIndex(text);
    expect(ls.hover("a.txt", index.positionAt(text.lastIndexOf("F_Lib") + 2))).toMatchObject({ kind: "function", name: "F_Lib" });
  });

  it("ne decrit rien sans registre", () => {
    const { ls, position } = setup(npc('\tm|es "a";'), { registry: null });
    expect(ls.hover("a.txt", position)).toBeUndefined();
  });
});

describe("commandInfo", () => {
  it("renvoie les informations d'une commande sans tenir compte de la casse, ou rien", () => {
    const { ls } = setup(npc("\tclose;|"));
    expect(ls.commandInfo("MES")).toMatchObject({ name: "mes", arity: { min: 1, max: null } });
    expect(ls.commandInfo("inconnue")).toBeUndefined();
    expect(new LanguageServer().commandInfo("mes")).toBeUndefined();
  });
});

describe("modeles de NPC (snippets)", () => {
  /** Ouvre `source` (le caractere `|` marque le curseur) avec l'emulateur donne. */
  function openWith(source: string, emulator: "rathena" | "hercules" | null = "rathena"): { ls: LanguageServer; position: Position; text: string } {
    const ls = new LanguageServer();
    ls.setOptions({ emulator });
    const offset = source.indexOf("|");
    const text = source.slice(0, offset) + source.slice(offset + 1);
    ls.updateDocument("a.txt", 1, text);
    return { ls, position: new LineIndex(text).positionAt(offset), text };
  }

  it("propose les quatre modeles sur demande explicite dans un fichier vide", () => {
    const { ls, position } = openWith("|");
    const items = ls.completion("a.txt", position, { explicit: true });
    expect(items.map((item) => item.label)).toEqual(["npc-healer", "npc-script", "npc-shop", "npc-warp"]);
    expect(items[0]).toMatchObject({ kind: CompletionItemKind.Snippet, format: "snippet", template: "npc-healer", detail: "Healer NPC with a menu" });
    expect(items[0]?.insertText).toContain("${1:prontera}");
    expect(ls.completion("a.txt", position)).toEqual([]);
  });

  it("se declenche en tapant l'identifiant du modele, tiret compris, et remplace ce qui est ecrit", () => {
    const { ls, position, text } = openWith("npc-w|arp");
    const [item] = ls.completion("a.txt", position);
    expect(item).toMatchObject({ label: "npc-warp", template: "npc-warp" });
    const index = new LineIndex(text);
    expect(text.slice(index.offsetAt(item!.range.start, text), index.offsetAt(item!.range.end, text))).toBe("npc-warp");
    expect(openWith("npc|").ls.completion("a.txt", openWith("npc|").position).map((i) => i.label)).toEqual(["npc-shop", "npc-warp", "npc-healer", "npc-script"]);
    expect(openWith("sho|").ls.completion("a.txt", openWith("sho|").position).map((i) => i.label)).toEqual(["npc-shop"]);
  });

  it("se propose entre deux scripts, pas dans un script ni dans une en-tete ni apres du texte", () => {
    const between = openWith(npc("\tclose;") + "\nnpc-|\n");
    expect(between.ls.completion("a.txt", between.position).map((i) => i.label)).toEqual(["npc-shop", "npc-warp", "npc-healer", "npc-script"]);
    const inside = openWith(npc("\tnpc-|"));
    expect(inside.ls.completion("a.txt", inside.position, { explicit: true }).filter((i) => i.kind === CompletionItemKind.Snippet)).toEqual([]);
    const header = openWith("prontera,1,1,0\tscript\tnpc-|\t100,{\n\tclose;\n}\n");
    expect(header.ls.completion("a.txt", header.position, { explicit: true })).toEqual([]);
    const afterText = openWith("prontera npc-|");
    expect(afterText.ls.completion("a.txt", afterText.position, { explicit: true })).toEqual([]);
    const comment = openWith("// npc-|");
    expect(comment.ls.completion("a.txt", comment.position, { explicit: true })).toEqual([]);
  });

  it("ne propose rien pour un emulateur sans modele verifie ou inconnu", () => {
    for (const emulator of ["hercules", null] as const) {
      const { ls, position } = openWith("npc-|", emulator);
      expect(ls.completion("a.txt", position, { explicit: true })).toEqual([]);
    }
  });
});
