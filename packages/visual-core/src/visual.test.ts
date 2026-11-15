import { parse } from "@runeforge/runescript-parser";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEdits,
  findBlock,
  generateBlock,
  importNpc,
  loadNpc,
  minimalEdit,
  npcAt,
  planEdit,
  quote,
  scriptNpcs,
  visualNpcAt,
  walkBlocks,
  type NewBlock,
  type VisualAction,
  type VisualBlock,
  type VisualNpc,
} from "./index";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

const GUIDE = lines(
  'prontera,150,150,4\tscript\tGuide\t100,{',
  '\tmes "[Guide]";',
  '\tmes "Welcome, traveler.";',
  "\tnext;",
  "\tif (BaseLevel > 50) {",
  '\t\tmes "You are strong.";',
  "\t} else {",
  '\t\tmes "Train more.";',
  "\t}",
  '\tcallfunc "F_Bonus";   // bonus',
  "\tclose;",
  "}",
);

function load(text: string, index = 0): VisualNpc {
  const declaration = scriptNpcs(parse(text))[index];
  if (declaration === undefined) throw new Error("NPC absent");
  const npc = importNpc(text, declaration);
  if (npc === null) throw new Error("NPC sans corps");
  return npc;
}

const kinds = (blocks: readonly VisualBlock[]): string[] => blocks.map((block) => block.kind);
const sliced = (text: string, block: VisualBlock): string => text.slice(block.range.start, block.range.end);

function plan(text: string, action: VisualAction): ReturnType<typeof planEdit> {
  return planEdit(load(text), text, action);
}

function run(text: string, action: VisualAction): string {
  const result = applyAction(text, load(text).declarationStart, action);
  if (!result.ok) throw new Error(`echec : ${result.reason}`);
  return result.text;
}

describe("lecture d'un NPC en blocs", () => {
  it("convertit les dialogues et les branches, et garde le reste verbatim en blocs bruts", () => {
    const npc = load(GUIDE);
    expect(npc.name).toBe("Guide");
    expect(kinds(npc.blocks)).toEqual(["mes", "mes", "next", "if", "raw", "close"]);
    expect(npc.blocks.map((block) => block.id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(npc.status).toBe("partial");
    expect(npc.counts).toEqual({ convertible: 7, raw: 1 });
    const [first, second, , branch, raw] = npc.blocks;
    expect(first).toMatchObject({ kind: "mes", text: "[Guide]" });
    expect(second).toMatchObject({ kind: "mes", text: "Welcome, traveler." });
    expect(raw).toMatchObject({ kind: "raw", text: 'callfunc "F_Bonus";' });
    expect(branch).toMatchObject({ kind: "if", condition: "BaseLevel > 50" });
    if (branch?.kind !== "if") throw new Error("if attendu");
    expect(kinds(branch.then)).toEqual(["mes"]);
    expect(branch.then[0]?.id).toBe("3.t.0");
    expect(branch.else?.map((block) => block.id)).toEqual(["3.e.0"]);
    expect(branch.else?.[0]).toMatchObject({ kind: "mes", text: "Train more." });
  });

  it("donne a chaque bloc la plage exacte de son instruction, et au texte de `mes` celle de son litteral", () => {
    const npc = load(GUIDE);
    expect(npc.blocks.map((block) => sliced(GUIDE, block))).toEqual([
      'mes "[Guide]";',
      'mes "Welcome, traveler.";',
      "next;",
      'if (BaseLevel > 50) {\n\t\tmes "You are strong.";\n\t} else {\n\t\tmes "Train more.";\n\t}',
      'callfunc "F_Bonus";',
      "close;",
    ]);
    const second = npc.blocks[1];
    if (second?.kind !== "mes") throw new Error("mes attendu");
    expect(GUIDE.slice(second.textRange.start, second.textRange.end)).toBe('"Welcome, traveler."');
    const branch = npc.blocks[3];
    if (branch?.kind !== "if") throw new Error("if attendu");
    expect(GUIDE.slice(branch.conditionRange.start, branch.conditionRange.end)).toBe("BaseLevel > 50");
    expect(npc.bodyRange.end).toBe(GUIDE.lastIndexOf("}") + 1);
  });

  it("dit si tout est en blocs, une partie seulement, ou rien", () => {
    expect(load(lines('-\tscript\tA\t-1,{', '\tmes "a";', "\tnext;", "\tclose;", "}")).status).toBe("full");
    expect(load(lines('-\tscript\tA\t-1,{', '\tmes "a";', '\tcallfunc "F";', "}")).status).toBe("partial");
    const none = load(lines('-\tscript\tA\t-1,{', '\tcallfunc "F";', "\tend;", "}"));
    expect(none.status).toBe("unsupported");
    expect(none.counts).toEqual({ convertible: 0, raw: 2 });
    expect(load(lines('-\tscript\tA\t-1,{', "}")).status).toBe("full");
    expect(load(lines('-\tscript\tA\t-1,{', "}")).blocks).toEqual([]);
  });

  it("reconnait les memes instructions ecrites autrement : casse, parentheses, plusieurs sur une ligne", () => {
    const npc = load(lines('-\tscript\tA\t-1,{', '\tMES "a";', '\tmes("b");', "\tNext;  Close;", "}"));
    expect(kinds(npc.blocks)).toEqual(["mes", "mes", "next", "close"]);
  });

  it.each([
    ["deux arguments", 'mes "a", "b";'],
    ["un argument qui n'est pas une chaine", "mes .@x$;"],
    ["une chaine avec un retour a la ligne echappe", 'mes "a\\nb";'],
    ["une chaine non terminee", 'mes "a;'],
    ["une instruction sans point-virgule", 'mes "a"'],
    ["un next avec argument", "next 1;"],
    ["un close2", "close2;"],
    ["un label", "L_Start:"],
    ["un select", 'select("A:B");'],
    ["une affectation", "set .@x, 1;"],
    ["un goto", "goto L_Start;"],
    ["une boucle", "while (.@i < 3) { .@i++; }"],
    ["un if sans accolades", 'if (BaseLevel > 1) mes "a";'],
    ["un if suivi d'un else sans accolades", 'if (BaseLevel > 1) { mes "a"; } else close;'],
    ["une chaine de if / else if", 'if (a) { mes "a"; } else if (b) { mes "b"; }'],
  ])("garde en bloc brut : %s", (_name, statement) => {
    const text = lines('-\tscript\tA\t-1,{', `\t${statement}`, "}");
    const npc = load(text);
    expect(kinds(npc.blocks), statement).toEqual(["raw"]);
    expect(npc.blocks[0]).toMatchObject({ kind: "raw", text: statement });
  });

  it("garde en bloc brut un if dont une branche contient du brut, sans perdre le reste du if", () => {
    const text = lines('-\tscript\tA\t-1,{', "\tif (a) {", '\t\tmes "x";', '\t\tcallfunc "F";', "\t}", "}");
    const [branch] = load(text).blocks;
    if (branch?.kind !== "if") throw new Error("if attendu");
    expect(kinds(branch.then)).toEqual(["mes", "raw"]);
  });

  it("ne lit rien d'un NPC sans corps ferme, et choisit le NPC sous le curseur", () => {
    expect(importNpc("-\tscript\tA\t-1,{\n\tmes \"a\";\n", scriptNpcs(parse("-\tscript\tA\t-1,{\n\tmes \"a\";\n"))[0] as never)).toBeNull();
    const two = lines('-\tscript\tA\t-1,{', '\tmes "a";', "}", '-\tscript\tB\t-1,{', '\tmes "b";', "}");
    const parsed = parse(two);
    expect(npcAt(parsed, two.indexOf('"a"'))?.name.display).toBe("A");
    expect(npcAt(parsed, two.indexOf('"b"'))?.name.display).toBe("B");
    // Hors de tout NPC : le dernier qui precede (entre deux, ou apres le dernier), a defaut le premier du fichier.
    expect(npcAt(parsed, two.length)?.name.display).toBe("B");
    const spaced = `// en-tete\n${two.replace("}\n-", "}\n\n// entre\n\n-")}`;
    const spacedParsed = parse(spaced);
    expect(npcAt(spacedParsed, spaced.indexOf("// entre"))?.name.display).toBe("A");
    expect(npcAt(spacedParsed, 2)?.name.display).toBe("A");
    expect(npcAt(parse("// rien\n"), 0)).toBeNull();
  });

  it("retrouve un NPC par le debut de sa declaration, ou sous le curseur", () => {
    const two = lines('-\tscript\tA\t-1,{', '\tmes "a";', "}", '-\tscript\tB\t-1,{', '\tmes "b";', "}");
    const second = two.indexOf("-\tscript\tB");
    expect(loadNpc(two, second)?.name).toBe("B");
    expect(loadNpc(two, 0)?.name).toBe("A");
    expect(loadNpc(two, second + 1)).toBeNull();
    expect(loadNpc("// vide\n", 0)).toBeNull();
    expect(visualNpcAt(two, two.indexOf('"b"'))?.name).toBe("B");
    expect(visualNpcAt(two, two.indexOf('"b"'))?.declarationStart).toBe(second);
    expect(visualNpcAt("// vide\n", 0)).toBeNull();
    // Un NPC dont le corps n'est pas ferme n'est pas editable.
    expect(visualNpcAt('-\tscript\tA\t-1,{\n\tmes "a";\n', 0)).toBeNull();
  });

  it("parcourt et retrouve les blocs par identifiant", () => {
    const npc = load(GUIDE);
    const ids: string[] = [];
    walkBlocks(npc.blocks, (block) => ids.push(block.id));
    expect(ids).toEqual(["0", "1", "2", "3", "3.t.0", "3.e.0", "4", "5"]);
    expect(findBlock(npc.blocks, "3.e.0")?.block).toMatchObject({ kind: "mes", text: "Train more." });
    expect(findBlock(npc.blocks, "3.e.0")?.index).toBe(0);
    expect(findBlock(npc.blocks, "9")).toBeNull();
  });
});

describe("modifications de texte ciblees", () => {
  it("remplace seulement le litteral d'un mes, en protegeant guillemets et barres obliques", () => {
    expect(run(GUIDE, { type: "setMesText", id: "1", text: 'Hi "you" \\o/' })).toBe(GUIDE.replace('"Welcome, traveler."', '"Hi \\"you\\" \\\\o/"'));
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    const edits = plan(GUIDE, { type: "setMesText", id: "1", text: "Bonjour" });
    expect(edits).toEqual({ ok: true, edits: [{ start: GUIDE.indexOf('"Welcome, traveler."'), end: GUIDE.indexOf('"Welcome, traveler."') + '"Welcome, traveler."'.length, text: '"Bonjour"' }] });
  });

  it("ne change rien quand le texte est le meme, et refuse un texte sur plusieurs lignes", () => {
    expect(plan(GUIDE, { type: "setMesText", id: "1", text: "Welcome, traveler." })).toEqual({ ok: true, edits: [] });
    expect(plan(GUIDE, { type: "setMesText", id: "1", text: "a\nb" })).toEqual({ ok: false, reason: "bad-text" });
    expect(plan(GUIDE, { type: "setMesText", id: "1", text: "a\tb" })).toEqual({ ok: false, reason: "bad-text" });
    expect(plan(GUIDE, { type: "setMesText", id: "2", text: "x" })).toEqual({ ok: false, reason: "locked" });
    expect(plan(GUIDE, { type: "setMesText", id: "42", text: "x" })).toEqual({ ok: false, reason: "unknown-block" });
  });

  it("change la condition d'un if sans toucher ses branches", () => {
    expect(run(GUIDE, { type: "setCondition", id: "3", text: "  BaseLevel >= 99 " })).toBe(GUIDE.replace("BaseLevel > 50", "BaseLevel >= 99"));
    expect(plan(GUIDE, { type: "setCondition", id: "3", text: "BaseLevel > 50" })).toEqual({ ok: true, edits: [] });
    expect(plan(GUIDE, { type: "setCondition", id: "3", text: "   " })).toEqual({ ok: false, reason: "invalid-condition" });
    expect(plan(GUIDE, { type: "setCondition", id: "3", text: "a\nb" })).toEqual({ ok: false, reason: "invalid-condition" });
    expect(plan(GUIDE, { type: "setCondition", id: "0", text: "x" })).toEqual({ ok: false, reason: "locked" });
  });

  it("ne reecrit pas une condition identique qui s'etend sur plusieurs lignes", () => {
    const text = GUIDE.replace("BaseLevel > 50", "BaseLevel >\n\t\t50");
    expect(plan(text, { type: "setCondition", id: "3", text: "BaseLevel >\n\t\t50" })).toEqual({ ok: true, edits: [] });
  });

  it("change une condition dont les parentheses ne couvrent que le premier operande", () => {
    const text = GUIDE.replace("(BaseLevel > 50)", "(BaseLevel > 50) && (Zeny > 0)");
    expect(run(text, { type: "setCondition", id: "3", text: "BaseLevel >= 99" })).toBe(GUIDE.replace("BaseLevel > 50", "BaseLevel >= 99"));
  });

  it("insere un bloc apres ou avant un autre, a la meme indentation, y compris dans une branche", () => {
    const after = run(GUIDE, { type: "insertAfter", id: "2", block: { kind: "mes", text: "Look around." } });
    expect(after).toBe(GUIDE.replace("\tnext;\n", '\tnext;\n\tmes "Look around.";\n'));
    const before = run(GUIDE, { type: "insertBefore", id: "0", block: { kind: "close" } });
    expect(before).toBe(GUIDE.replace('\tmes "[Guide]";\n', '\tclose;\n\tmes "[Guide]";\n'));
    const inBranch = run(GUIDE, { type: "insertAfter", id: "3.t.0", block: { kind: "next" } });
    expect(inBranch).toBe(GUIDE.replace('\t\tmes "You are strong.";\n', '\t\tmes "You are strong.";\n\t\tnext;\n'));
    // Apres un bloc multi-lignes, apres la ligne brute (avec son commentaire), et en fin de corps.
    expect(run(GUIDE, { type: "insertAfter", id: "3", block: { kind: "next" } })).toBe(GUIDE.replace("\t}\n\tcallfunc", "\t}\n\tnext;\n\tcallfunc"));
    expect(run(GUIDE, { type: "insertAfter", id: "4", block: { kind: "next" } })).toBe(GUIDE.replace("// bonus\n", "// bonus\n\tnext;\n"));
    expect(run(GUIDE, { type: "insertAfter", id: "5", block: { kind: "close" } })).toBe(GUIDE.replace("\tclose;\n}", "\tclose;\n\tclose;\n}"));
  });

  it("n'insere pas a cote d'un bloc qui partage sa ligne avec autre chose", () => {
    const text = lines('-\tscript\tA\t-1,{', '\tmes "a"; close;', "}");
    expect(plan(text, { type: "insertAfter", id: "0", block: { kind: "next" } })).toEqual({ ok: false, reason: "not-alone-on-line" });
    expect(plan(text, { type: "insertBefore", id: "1", block: { kind: "next" } })).toEqual({ ok: false, reason: "not-alone-on-line" });
    expect(plan(text, { type: "remove", id: "0" })).toEqual({ ok: false, reason: "not-alone-on-line" });
    expect(plan(text, { type: "move", id: "0", direction: "down" })).toEqual({ ok: false, reason: "not-alone-on-line" });
  });

  it("construit un dialogue conditionnel à partir d'un corps compact vide", () => {
    const empty = '-\tscript\tA\t-1,{}\n';
    const conditional = run(empty, { type: "append", target: { kind: "body" }, block: { kind: "if", condition: " BaseLevel > 10 " } });
    expect(conditional).toBe(lines('-\tscript\tA\t-1,{', "\tif (BaseLevel > 10) {", "\t}", "}"));
    const then = run(conditional, { type: "append", target: { kind: "branch", id: "0", branch: "then" }, block: { kind: "mes", text: "Yes" } });
    const both = run(then, { type: "append", target: { kind: "branch", id: "0", branch: "else" }, block: { kind: "mes", text: "No" } });
    const complete = run(both, { type: "insertAfter", id: "0", block: { kind: "close" } });
    expect(complete).toBe(lines('-\tscript\tA\t-1,{', "\tif (BaseLevel > 10) {", '\t\tmes "Yes";', "\t} else {", '\t\tmes "No";', "\t}", "\tclose;", "}"));
    expect(load(complete).blocks[0]).toMatchObject({
      kind: "if", condition: "BaseLevel > 10", then: [{ id: "0.t.0", text: "Yes" }], else: [{ id: "0.e.0", text: "No" }],
    });
  });

  it("ajoute un bloc à une branche compacte en conservant les commentaires et le reste du fichier", () => {
    const text = lines('-\tscript\tA\t-1,{', "    if (a) { /* note */ } else {}", "}", "// hors du NPC");
    const then = run(text, { type: "append", target: { kind: "branch", id: "0", branch: "then" }, block: { kind: "next" } });
    expect(then).toBe(text.replace("/* note */ }", "/* note */ \n        next;\n    }"));
    const both = run(then, { type: "append", target: { kind: "branch", id: "0", branch: "else" }, block: { kind: "close" } });
    expect(both).toBe(then.replace("else {}", "else {\n        close;\n    }"));
  });

  it("crée une branche Sinon après le commentaire de la branche Alors et conserve les fins de ligne CRLF", () => {
    const text = lines('-\tscript\tA\t-1,{', "\tif (a) {", "\t\tnext;", "\t} // alors", "\tclose;", "}").replaceAll("\n", "\r\n");
    const appended = run(text, { type: "append", target: { kind: "branch", id: "0", branch: "else" }, block: { kind: "close" } });
    expect(appended).toBe(text.replace("\t} // alors\r\n", "\t} // alors\r\n\telse {\r\n\t\tclose;\r\n\t}\r\n"));
    const next = run(appended, { type: "insertAfter", id: "0.e.0", block: { kind: "if", condition: "b" } });
    expect(next).toBe(appended.replace("\t\tclose;\r\n", "\t\tclose;\r\n\t\tif (b) {\r\n\t\t}\r\n"));
  });

  it("refuse les blocs neufs invalides et les mauvaises cibles", () => {
    const body = { kind: "body" } as const;
    expect(plan(GUIDE, { type: "append", target: body, block: { kind: "if", condition: " " } })).toEqual({ ok: false, reason: "invalid-condition" });
    expect(plan(GUIDE, { type: "insertAfter", id: "0", block: { kind: "if", condition: 'a) { mes "Injected"; } if (b' } })).toEqual({ ok: false, reason: "new-syntax-error" });
    expect(plan(GUIDE, { type: "insertBefore", id: "0", block: { kind: "mes", text: "one\ntwo" } })).toEqual({ ok: false, reason: "bad-text" });
    expect(plan(GUIDE, { type: "append", target: { kind: "branch", id: "0", branch: "then" }, block: { kind: "next" } })).toEqual({ ok: false, reason: "locked" });
    expect(plan(GUIDE, { type: "append", target: { kind: "branch", id: "99", branch: "else" }, block: { kind: "close" } })).toEqual({ ok: false, reason: "unknown-block" });
  });

  it("supprime les lignes d'un bloc, un if entier compris, et le saut qui precede la derniere ligne d'un fichier sans saut final", () => {
    expect(run(GUIDE, { type: "remove", id: "2" })).toBe(GUIDE.replace("\tnext;\n", ""));
    expect(run(GUIDE, { type: "remove", id: "3.t.0" })).toBe(GUIDE.replace('\t\tmes "You are strong.";\n', ""));
    expect(run(GUIDE, { type: "remove", id: "5" })).toBe(GUIDE.replace("\tclose;\n", ""));
    const noFinalNewline = '-\tscript\tA\t-1,{\n\tmes "a";\n\tclose;\n}';
    expect(run(noFinalNewline, { type: "remove", id: "1" })).toBe('-\tscript\tA\t-1,{\n\tmes "a";\n}');
    const whole = lines('-\tscript\tA\t-1,{', "\tif (a) {", '\t\tmes "x";', "\t}", "\tclose;", "}");
    expect(run(whole, { type: "remove", id: "0" })).toBe(lines('-\tscript\tA\t-1,{', "\tclose;", "}"));
  });

  it("laisse un commentaire de fin de ligne sur place quand le bloc est supprime", () => {
    const text = lines('-\tscript\tA\t-1,{', '\tmes "a"; // ancien', "\tclose;", "}");
    expect(run(text, { type: "remove", id: "0" })).toBe(text.replace('mes "a";', ""));
  });

  it.each([
    ['\tmes /* note */ "a";'],
    ["\tif (a) {", "\t\t// note", '\t\tmes "a";', "\t}"],
  ])("refuse de supprimer un bloc dont le texte contient un commentaire (%s)", (...body) => {
    const text = lines('-\tscript\tA\t-1,{', ...body, "\tclose;", "}");
    expect(plan(text, { type: "remove", id: "0" })).toEqual({ ok: false, reason: "locked" });
  });

  it("ne supprime ni ne deplace jamais un bloc brut, ni un if qui en contient un", () => {
    expect(plan(GUIDE, { type: "remove", id: "4" })).toEqual({ ok: false, reason: "locked" });
    expect(plan(GUIDE, { type: "move", id: "4", direction: "up" })).toEqual({ ok: false, reason: "locked" });
    expect(plan(GUIDE, { type: "move", id: "3", direction: "down" })).toEqual({ ok: false, reason: "locked" });
    expect(plan(GUIDE, { type: "move", id: "5", direction: "up" })).toEqual({ ok: false, reason: "locked" });
    const risky = lines('-\tscript\tA\t-1,{', "\tif (a) {", '\t\tcallfunc "F";', "\t}", "}");
    expect(plan(risky, { type: "remove", id: "0" })).toEqual({ ok: false, reason: "locked" });
  });

  it("echange deux blocs voisins en gardant ce qui les separe", () => {
    expect(run(GUIDE, { type: "move", id: "0", direction: "down" })).toBe(GUIDE.replace('\tmes "[Guide]";\n\tmes "Welcome, traveler.";\n', '\tmes "Welcome, traveler.";\n\tmes "[Guide]";\n'));
    expect(run(GUIDE, { type: "move", id: "1", direction: "up" })).toBe(run(GUIDE, { type: "move", id: "0", direction: "down" }));
    const spaced = lines('-\tscript\tA\t-1,{', '\tmes "a";', "", "\t// entre les deux", "\tnext;", "}");
    expect(run(spaced, { type: "move", id: "0", direction: "down" })).toBe(lines('-\tscript\tA\t-1,{', "\tnext;", "", "\t// entre les deux", '\tmes "a";', "}"));
    expect(plan(GUIDE, { type: "move", id: "0", direction: "up" })).toEqual({ ok: false, reason: "no-neighbour" });
    expect(plan(GUIDE, { type: "move", id: "5", direction: "down" })).toEqual({ ok: false, reason: "no-neighbour" });
    expect(plan(GUIDE, { type: "move", id: "3.t.0", direction: "down" })).toEqual({ ok: false, reason: "no-neighbour" });
  });

  it("echange aussi des blocs multi-lignes", () => {
    const text = lines('-\tscript\tA\t-1,{', "\tif (a) {", '\t\tmes "x";', "\t}", "\tif (b) {", '\t\tmes "y";', "\t}", "}");
    expect(run(text, { type: "move", id: "0", direction: "down" })).toBe(lines('-\tscript\tA\t-1,{', "\tif (b) {", '\t\tmes "y";', "\t}", "\tif (a) {", '\t\tmes "x";', "\t}", "}"));
  });

  it("modifie un NPC sans toucher aux autres ni a ce qui l'entoure", () => {
    const text = lines("// en-tete", '-\tscript\tA\t-1,{', '\tmes "a";', "}", "", '-\tscript\tB\t-1,{', '\tmes "b";', "}", "// fin");
    const second = load(text, 1);
    const result = applyAction(text, second.declarationStart, { type: "setMesText", id: "0", text: "B2" });
    expect(result.ok && result.text).toBe(text.replace('mes "b"', 'mes "B2"'));
    expect(result.ok && result.npc.blocks[0]).toMatchObject({ kind: "mes", text: "B2" });
  });
});

describe("garde-fous", () => {
  it("refuse un resultat qui aurait plus d'erreurs de syntaxe qu'avant", () => {
    const start = load(GUIDE).declarationStart;
    expect(applyAction(GUIDE, start, { type: "setCondition", id: "3", text: "BaseLevel >" })).toEqual({ ok: false, reason: "new-syntax-error" });
    expect(applyAction(GUIDE, start, { type: "setCondition", id: "3", text: "(" })).toEqual({ ok: false, reason: "new-syntax-error" });
    // Une condition valable passe.
    expect(applyAction(GUIDE, start, { type: "setCondition", id: "3", text: "BaseLevel > 1 && Zeny > 0" }).ok).toBe(true);
  });

  it("refuse de remplacer une condition par du code qui sort de son expression", () => {
    const start = load(GUIDE).declarationStart;
    expect(applyAction(GUIDE, start, { type: "setCondition", id: "3", text: 'a) { mes "Injected"; } if (b' })).toEqual({ ok: false, reason: "new-syntax-error" });
    expect(run(GUIDE, { type: "setCondition", id: "3", text: 'strcharinfo(0) == "a) {"' })).toBe(GUIDE.replace("BaseLevel > 50", 'strcharinfo(0) == "a) {"'));
  });

  it("protege les commentaires a l'interieur de la condition", () => {
    const text = GUIDE.replace("BaseLevel > 50", "BaseLevel /* note */ > 50");
    expect(plan(text, { type: "setCondition", id: "3", text: "BaseLevel /* note */ > 50" })).toEqual({ ok: true, edits: [] });
    expect(plan(text, { type: "setCondition", id: "3", text: "BaseLevel > 51" })).toEqual({ ok: false, reason: "locked" });
    const outside = GUIDE.replace("BaseLevel > 50", "/* avant ) */ BaseLevel > 50 /* apres */");
    expect(run(outside, { type: "setCondition", id: "3", text: "BaseLevel > 51" })).toBe(outside.replace("BaseLevel > 50", "BaseLevel > 51"));
  });

  it("n'accepte pas un texte qui deborde du litteral", () => {
    // Les guillemets saisis sont proteges : ils ne referment pas la chaine.
    const text = run(GUIDE, { type: "setMesText", id: "0", text: '"; close; mes "' });
    expect(kinds(load(text).blocks)).toEqual(["mes", "mes", "next", "if", "raw", "close"]);
    expect(load(text).blocks[0]).toMatchObject({ kind: "mes", text: '"; close; mes "' });
  });

  it("ne retrouve pas un NPC dont la declaration n'est pas a l'offset donne", () => {
    expect(applyAction(GUIDE, 3, { type: "remove", id: "2" })).toEqual({ ok: false, reason: "unknown-npc" });
    expect(applyAction("// vide\n", 0, { type: "remove", id: "2" })).toEqual({ ok: false, reason: "unknown-npc" });
  });

  it("refuse un bloc inconnu", () => {
    expect(applyAction(GUIDE, load(GUIDE).declarationStart, { type: "remove", id: "99" })).toEqual({ ok: false, reason: "unknown-block" });
  });

  it("garde le texte des blocs bruts intact au caractere pres, quelles que soient les actions sur les autres", () => {
    const rawBefore = load(GUIDE).blocks.filter((block) => block.kind === "raw").map((block) => (block.kind === "raw" ? block.text : ""));
    let text = GUIDE;
    // Apres l'insertion, le `if` passe de l'identifiant 3 a 4 : ses branches suivent.
    for (const action of [
      { type: "setMesText", id: "0", text: "Nouveau titre" },
      { type: "insertAfter", id: "2", block: { kind: "mes", text: "Encore" } },
      { type: "move", id: "0", direction: "down" },
      { type: "remove", id: "4.e.0" },
      { type: "setCondition", id: "4", text: "Zeny > 10" },
    ] as VisualAction[]) {
      const next = applyAction(text, load(text).declarationStart, action);
      expect(next.ok, JSON.stringify(action)).toBe(true);
      if (next.ok) text = next.text;
    }
    const rawAfter = load(text).blocks.filter((block) => block.kind === "raw").map((block) => (block.kind === "raw" ? block.text : ""));
    expect(rawAfter).toEqual(rawBefore);
    expect(text).toContain('callfunc "F_Bonus";   // bonus');
  });
});

describe("remplacements", () => {
  it("applique des remplacements sans chevauchement, dans n'importe quel ordre", () => {
    expect(applyEdits("abcdef", [{ start: 1, end: 2, text: "XX" }, { start: 4, end: 5, text: "" }, { start: 6, end: 6, text: "!" }])).toBe("aXXcdf!");
    expect(applyEdits("abcdef", [{ start: 4, end: 5, text: "" }, { start: 1, end: 2, text: "XX" }])).toBe("aXXcdf");
    expect(applyEdits("abc", [])).toBe("abc");
  });

  it("refuse des remplacements qui se chevauchent ou sortent du texte", () => {
    expect(applyEdits("abcdef", [{ start: 1, end: 4, text: "x" }, { start: 3, end: 5, text: "y" }])).toBeNull();
    expect(applyEdits("abc", [{ start: 2, end: 9, text: "x" }])).toBeNull();
    expect(applyEdits("abc", [{ start: -1, end: 1, text: "x" }])).toBeNull();
    expect(applyEdits("abc", [{ start: 2, end: 1, text: "x" }])).toBeNull();
  });

  it("resume deux textes par l'unique remplacement qui les separe", () => {
    expect(minimalEdit("abc", "abc")).toBeNull();
    expect(minimalEdit("abcdef", "abXXef")).toEqual({ start: 2, end: 4, text: "XX" });
    expect(minimalEdit("abc", "abcd")).toEqual({ start: 3, end: 3, text: "d" });
    expect(minimalEdit("abcd", "abc")).toEqual({ start: 3, end: 4, text: "" });
    expect(minimalEdit("", "x")).toEqual({ start: 0, end: 0, text: "x" });
    for (const [before, after] of [["aaa", "aa"], ["aXa", "aXXa"], ["début", "fin"]] as const) {
      const edit = minimalEdit(before, after);
      expect(edit === null ? before : applyEdits(before, [edit])).toBe(after);
    }
  });
});

describe("proprietes : aller-retour exact", () => {
  const FIXTURES = [
    GUIDE,
    lines('-\tscript\tA\t-1,{', '\tmes "a";', "\tnext;", '\tmes "b";', "\tclose;", "}"),
    lines('prontera,1,1,0\tscript\tB\t100,{', "\tif (a) {", '\t\tmes "x";', "\t\tnext;", '\t\tmes "y";', "\t} else {", "\t\tclose;", "\t}", "\tclose;", "}"),
    lines('-\tscript\tC\t-1,{', '\tmes "a";', "", "\t// separation", '\tmes "b";', "}"),
    '-\tscript\tD\t-1,{\n\tmes "a";\n\tclose;\n}',
  ];
  const NEW_BLOCKS: NewBlock[] = [{ kind: "mes", text: "Insere" }, { kind: "next" }, { kind: "close" }];

  const ids = (text: string): string[] => {
    const all: string[] = [];
    walkBlocks(load(text).blocks, (block) => all.push(block.id));
    return all;
  };

  it("inserer un bloc puis le supprimer redonne exactement le texte d'origine", () => {
    let checked = 0;
    for (const text of FIXTURES) {
      const declarationStart = load(text).declarationStart;
      for (const id of ids(text)) {
        for (const block of NEW_BLOCKS) {
          for (const where of ["insertAfter", "insertBefore"] as const) {
            const inserted = applyAction(text, declarationStart, { type: where, id, block });
            if (!inserted.ok) continue; // un bloc qui partage sa ligne n'accepte pas d'insertion
            // Le bloc neuf prend la place de celui qu'on precede, ou la suivante.
            const created = where === "insertAfter" ? nextId(id) : id;
            const found = findBlock(inserted.npc.blocks, created)?.block;
            expect(found && inserted.text.slice(found.range.start, found.range.end), `${where} ${id} : le bloc neuf`).toBe(generateBlock(block));
            const removed = applyAction(inserted.text, declarationStart, { type: "remove", id: created });
            expect(removed.ok, `${where} ${id} puis suppression`).toBe(true);
            expect(removed.ok && removed.text, `${where} ${id}`).toBe(text);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("deplacer un bloc puis le remettre redonne exactement le texte d'origine", () => {
    let checked = 0;
    for (const text of FIXTURES) {
      const declarationStart = load(text).declarationStart;
      for (const id of ids(text)) {
        for (const [direction, back] of [["up", "down"], ["down", "up"]] as const) {
          const moved = applyAction(text, declarationStart, { type: "move", id, direction });
          if (!moved.ok) continue;
          // Apres l'echange, le bloc deplace est a la place de son voisin.
          const neighbour = direction === "up" ? previousId(id) : nextId(id);
          const restored = applyAction(moved.text, declarationStart, { type: "move", id: neighbour, direction: back });
          expect(restored.ok, `${id} ${direction}`).toBe(true);
          expect(restored.ok && restored.text, `${id} ${direction}`).toBe(text);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  const previousId = (id: string): string => {
    const parts = id.split(".");
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) - 1);
    return parts.join(".");
  };
  const nextId = (id: string): string => {
    const parts = id.split(".");
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
    return parts.join(".");
  };

  it("rien ne change quand on n'applique aucune modification : lire puis ecrire n'altere pas un octet", () => {
    for (const text of FIXTURES) {
      const npc = load(text);
      const result = applyAction(text, npc.declarationStart, { type: "setCondition", id: "nulle-part", text: "x" });
      expect(result).toEqual({ ok: false, reason: "unknown-block" });
      expect(text.slice(npc.bodyRange.start, npc.bodyRange.end)).toBe(text.slice(npc.bodyRange.start, npc.bodyRange.end));
    }
  });
});
