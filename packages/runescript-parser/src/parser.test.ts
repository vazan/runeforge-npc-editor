import { describe, expect, it } from "vitest";
import type { AstNode, NpcDeclaration, Statement, TopLevelDeclaration } from "./index";
import { childrenOf, findNodeAt, parse, walk } from "./index";

function codes(text: string): string[] {
  return parse(text).diagnostics.map((diagnostic) => diagnostic.code);
}

function firstDeclaration(text: string): TopLevelDeclaration {
  const declaration = parse(text).ast.declarations[0];
  if (declaration === undefined) throw new Error("aucune declaration");
  return declaration;
}

function npc(text: string): NpcDeclaration {
  const declaration = firstDeclaration(text);
  if (declaration.kind !== "NpcDeclaration") throw new Error(`attendu NpcDeclaration, obtenu ${declaration.kind}`);
  return declaration;
}

function bodyOf(text: string): readonly Statement[] {
  return npc(text).body?.statements ?? [];
}

const wrap = (code: string): string => `prontera,150,150,4\tscript\tTest\t100,{\n${code}\n}\n`;

/** Verifie que toutes les plages sont dans le texte et que chaque enfant est dans son parent. */
function expectValidRanges(text: string, root: AstNode): void {
  walk(root, (node) => {
    expect(node.range.start).toBeGreaterThanOrEqual(0);
    expect(node.range.end).toBeGreaterThanOrEqual(node.range.start);
    expect(node.range.end).toBeLessThanOrEqual(text.length);
    for (const child of childrenOf(node)) {
      expect(child.range.start).toBeGreaterThanOrEqual(node.range.start);
      expect(child.range.end).toBeLessThanOrEqual(node.range.end);
    }
  });
}

describe("declarations de premier niveau", () => {
  it("decode un NPC simple", () => {
    const text = 'prontera,150,150,4\tscript\tKafra Employee#kaf1\t115,{\n\tmes "Bonjour";\n\tclose;\n}\n';
    const result = parse(text);
    expect(result.diagnostics).toEqual([]);
    const declaration = npc(text);
    expect(declaration.floating).toBe(false);
    expect(declaration.location).toMatchObject({ map: "prontera", x: { value: 150 }, y: { value: 150 }, extra: [{ value: 4 }] });
    expect(declaration.name).toMatchObject({ full: "Kafra Employee#kaf1", display: "Kafra Employee#kaf1", unique: "Kafra Employee#kaf1" });
    expect(declaration.sprite?.text).toBe("115");
    expect(declaration.body?.statements).toHaveLength(2);
    expect(text.slice(declaration.range.start, declaration.range.end)).toBe(text.trimEnd());
  });

  it("separe nom affiche et nom unique autour de ::", () => {
    const declaration = npc("-\tscript\t::GlobalHelper\t-1,{\n\tend;\n}\n");
    expect(declaration.floating).toBe(true);
    expect(declaration.location).toBeNull();
    expect(declaration.name).toMatchObject({ display: "", unique: "GlobalHelper" });
    const named = npc("prontera,1,1,0\tscript\tOld Man::oldman01\t50,{\n}\n");
    expect(named.name).toMatchObject({ display: "Old Man", unique: "oldman01" });
  });

  it("accepte script(CLOAKED), sprite constante et zone de declenchement", () => {
    const declaration = npc("t_garden,116,47,0\tscript(CLOAKED)\t#life_wp11\tHIDDEN_WARP_NPC,2,3,{\n\tend;\n}\n");
    expect(declaration.states).toEqual(["CLOAKED"]);
    expect(declaration.sprite?.text).toBe("HIDDEN_WARP_NPC");
    expect(declaration.trigger).toMatchObject({ x: { value: 2 }, y: { value: 3 } });
  });

  it("tolere plusieurs tabulations entre les champs", () => {
    const declaration = npc("prontera,1,1,0\t\tscript\t\tAlign Test\t\t100,{\n\tend;\n}\n");
    expect(declaration.fields.map((field) => field.text)).toEqual(["prontera,1,1,0", "script", "Align Test", "100,"]);
  });

  it("decode une fonction", () => {
    const declaration = firstDeclaration("function\tscript\tF_Test\t{\n\treturn 1;\n}\n");
    expect(declaration).toMatchObject({ kind: "FunctionDeclaration", name: "F_Test" });
    expect(parse("function\tscript\tF_Test\t{\n\treturn 1;\n}\n").diagnostics).toEqual([]);
  });

  it("decode warp, warp2 et leurs etats", () => {
    const warp = firstDeclaration("prontera,150,150,0\twarp\tpront01\t2,2,geffen,120,60\n");
    expect(warp).toMatchObject({
      kind: "WarpDeclaration",
      variant: "warp",
      spanX: { value: 2 },
      spanY: { value: 2 },
      destination: { map: "geffen", x: { value: 120 }, y: { value: 60 } },
    });
    const warp2 = firstDeclaration("prontera,150,150,0\twarp2(HIDDEN)\tpront02\t1,1,1@orcs,10,20\n");
    expect(warp2).toMatchObject({ kind: "WarpDeclaration", variant: "warp2", states: ["HIDDEN"], destination: { map: "1@orcs" } });
    expect(parse("prontera,150,150,0\twarp\tpront01\t2,2,geffen,120,60\n").diagnostics).toEqual([]);
  });

  it("decode les boutiques (shop, itemshop, marketshop)", () => {
    const shop = firstDeclaration("prontera,150,150,4\tshop\tTool Dealer\t53,501:50,502:-1\n");
    expect(shop).toMatchObject({ kind: "ShopDeclaration", shopType: "shop", options: [] });
    if (shop.kind === "ShopDeclaration") {
      expect(shop.items.map((item) => [item.item.text, item.price?.value])).toEqual([["501", 50], ["502", -1]]);
    }
    const discounted = firstDeclaration("-\tshop\tFloating Shop\t53,yes,501:50\n");
    if (discounted.kind === "ShopDeclaration") {
      expect(discounted.floating).toBe(true);
      expect(discounted.options.map((option) => option.text)).toEqual(["yes"]);
    }
    const itemShop = firstDeclaration("prontera,1,1,4\titemshop\tTrader\t53,7539:2,501:5\n");
    if (itemShop.kind === "ShopDeclaration") {
      expect(itemShop.options.map((option) => option.text)).toEqual(["7539:2"]);
      expect(itemShop.items).toHaveLength(1);
    }
    const market = firstDeclaration("prontera,1,1,4\tmarketshop\tMarket\t53,501:50:10,502:20:-1\n");
    if (market.kind === "ShopDeclaration") {
      expect(market.items.map((item) => item.stock?.value)).toEqual([10, -1]);
    }
  });

  it("decode monstres, boss et mapflag", () => {
    const monster = firstDeclaration("prt_fild08,0,0\tmonster\tPoring\t1002,10,5000,0\n");
    expect(monster).toMatchObject({ kind: "MonsterDeclaration", boss: false });
    if (monster.kind === "MonsterDeclaration") {
      expect(monster.parameters.map((parameter) => parameter.text)).toEqual(["1002", "10", "5000", "0"]);
    }
    const boss = firstDeclaration("moc_pryd04,0,0\tboss_monster\tOsiris\t1038,1,3600000,3000000,Mob::OnKilled\n");
    expect(boss).toMatchObject({ kind: "MonsterDeclaration", boss: true });
    const flag = firstDeclaration("prontera\tmapflag\tnosave\tSavePoint\n");
    expect(flag).toMatchObject({ kind: "MapflagDeclaration", map: { text: "prontera" }, flag: { text: "nosave" } });
    if (flag.kind === "MapflagDeclaration") expect(flag.parameters.map((parameter) => parameter.text)).toEqual(["SavePoint"]);
  });

  it("decode duplicate(label)", () => {
    const duplicate = firstDeclaration("airport,158,43,5\tduplicate(airport1)\tAirport Staff#airport1b\t90\n");
    expect(duplicate).toMatchObject({ kind: "DuplicateDeclaration", target: "airport1", floating: false });
  });

  it("conserve un type de declaration inconnu dans un noeud Raw avec un diagnostic d'extension", () => {
    const text = "prontera,1,1,0\tcustomthing\tFoo\t1,2,3\n";
    const result = parse(text);
    expect(result.ast.declarations[0]).toMatchObject({ kind: "RawDeclaration", originalText: "prontera,1,1,0\tcustomthing\tFoo\t1,2,3" });
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.category, diagnostic.confidence])).toEqual([
      ["RS0031", "unknown-extension", "unknown"],
    ]);
  });

  it("signale des champs separes par des espaces", () => {
    expect(codes("prontera,1,1,0 script Foo 100,{\n\tend;\n}\n")).toContain("RS0032");
  });

  it("signale un script sans bloc de code", () => {
    const result = parse("prontera,1,1,0\tscript\tFoo\t100\n");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RS0033"]);
    const declaration = result.ast.declarations[0];
    expect(declaration).toMatchObject({ kind: "NpcDeclaration", body: null });
  });

  it("signale des coordonnees invalides et un nombre de valeurs incorrect", () => {
    expect(codes("prontera,abc,1,0\twarp\tw\t1,1,geffen,1,1\n")).toContain("RS0034");
    expect(codes("prontera,1\twarp\tw\t1,1,geffen,1,1\n")).toContain("RS0036");
    expect(codes("prontera,1,1,0\twarp\tw\t1,1,geffen\n")).toContain("RS0036");
  });

  it("accepte un warp sans direction (le serveur ne lit que carte,x,y) mais l'exige d'un script, d'une boutique et d'un duplicate", () => {
    // `npc_parse_warp` : `sscanf(w1, "%15[^,],%6hd,%6hd", ...) != 3` ; `npc_parse_script`, `npc_parse_shop` et
    // `npc_parse_duplicate` lisent quatre valeurs (`!= 4`).
    expect(codes("prontera,1,1\twarp\tw\t1,1,geffen,1,1\n")).toEqual([]);
    expect(codes("prontera,1,1,0\twarp\tw\t1,1,geffen,1,1\n")).toEqual([]);
    expect(codes("prontera,1\twarp\tw\t1,1,geffen,1,1\n")).toContain("RS0036");
    expect(codes("prontera,1,1\tscript\tFoo\t100,{\n\tend;\n}\n")).toContain("RS0036");
    expect(codes("prontera,1,1\tshop\tFoo\t100,501:50\n")).toContain("RS0036");
    const message = parse("prontera,1\twarp\tw\t1,1,geffen,1,1\n").diagnostics.find((diagnostic) => diagnostic.code === "RS0036");
    expect(message?.params).toMatchObject({ expected: "map,x,y" });
  });

  it("lit plusieurs declarations d'un meme fichier", () => {
    const text = [
      "// commentaire",
      "prontera,1,1,0\twarp\tw1\t1,1,geffen,1,1",
      "",
      "prontera,2,2,4\tscript\tA\t100,{",
      "\tend;",
      "}",
      "prontera\tmapflag\tnosave",
      "",
    ].join("\n");
    const result = parse(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.ast.declarations.map((declaration) => declaration.kind)).toEqual([
      "WarpDeclaration",
      "NpcDeclaration",
      "MapflagDeclaration",
    ]);
  });
});

describe("instructions", () => {
  it("decoupe commandes avec et sans parentheses", () => {
    const statements = bodyOf(wrap('\tmes "A";\n\tmes("B");\n\tclose;'));
    expect(statements.map((statement) => statement.kind)).toEqual(["CommandStatement", "CommandStatement", "CommandStatement"]);
    expect(statements[0]).toMatchObject({ name: "mes", parenthesized: false, terminated: true });
    expect(statements[1]).toMatchObject({ name: "mes", parenthesized: true });
    expect(statements[2]).toMatchObject({ name: "close", args: [] });
  });

  it("gere les labels, y compris les labels d'evenement et en colonne 0", () => {
    const statements = bodyOf(wrap("\tend;\nOnInit:\n\tend;\nL_Next:\n\tclose;"));
    expect(statements.filter((statement) => statement.kind === "LabelStatement").map((statement) => (statement as { name: string }).name)).toEqual(["OnInit", "L_Next"]);
  });

  it("analyse if / else if / else avec et sans accolades", () => {
    const statements = bodyOf(wrap("\tif (BaseLevel < 250)\n\t\tend;\n\tif (.@a == 1) {\n\t\tmes \"x\";\n\t} else if (.@a == 2) mes \"y\"; else {\n\t\tmes \"z\";\n\t}"));
    expect(statements.map((statement) => statement.kind)).toEqual(["IfStatement", "IfStatement"]);
    const second = statements[1];
    expect(second).toMatchObject({ kind: "IfStatement", alternate: { kind: "IfStatement" } });
    expect(parse(wrap("\tif (BaseLevel < 250)\n\t\tend;")).diagnostics).toEqual([]);
  });

  it("analyse while, do-while, for et switch", () => {
    const code = [
      "\twhile (.@i < 3) { .@i++; }",
      "\tdo { .@i--; } while (.@i > 0);",
      "\tfor (.@j = 0; .@j < 5; .@j++) mes \"x\";",
      "\tfor (set .@k,0; .@k < 5; set .@k,.@k+1) mes \"y\";",
      "\tswitch (select(\"a:b\")) {",
      "\tcase 1:",
      "\t\tmes \"one\";",
      "\t\tbreak;",
      "\tdefault:",
      "\t\tmes \"other\";",
      "\t}",
    ].join("\n");
    const result = parse(wrap(code));
    expect(result.diagnostics).toEqual([]);
    expect(bodyOf(wrap(code)).map((statement) => statement.kind)).toEqual([
      "WhileStatement",
      "DoWhileStatement",
      "ForStatement",
      "ForStatement",
      "SwitchStatement",
    ]);
  });

  it("analyse goto, return, break, continue et menu avec le marqueur '-'", () => {
    const statements = bodyOf(wrap('\tmenu "Make",-,"Cancel",L_Cancel;\n\tgoto L_End;\nL_Cancel:\n\treturn;\nL_End:\n\tclose;'));
    expect(statements[0]).toMatchObject({ kind: "CommandStatement", name: "menu" });
    const menu = statements[0];
    if (menu?.kind === "CommandStatement") {
      expect(menu.args.map((arg) => arg.kind)).toEqual(["StringLiteral", "Placeholder", "StringLiteral", "Identifier"]);
      expect(menu.args[1]).toMatchObject({ reason: "dash" });
    }
    expect(statements[1]).toMatchObject({ kind: "GotoStatement", label: "L_End" });
    expect(parse(wrap('\tmenu "Make",-,"Cancel",L_Cancel;\nL_Cancel:\n\tclose;')).diagnostics).toEqual([]);
  });

  it("analyse les fonctions locales (declaration et definition)", () => {
    const code = "\tfunction SF_Sell;\n\tSF_Sell;\n\tclose;\n\tfunction SF_Sell {\n\t\treturn;\n\t}";
    const statements = bodyOf(wrap(code));
    expect(statements[0]).toMatchObject({ kind: "FunctionStatement", name: "SF_Sell", body: null });
    expect(statements[3]).toMatchObject({ kind: "FunctionStatement", name: "SF_Sell" });
    expect(parse(wrap(code)).diagnostics).toEqual([]);
  });

  it("analyse affectations, parametres et mises a jour", () => {
    const code = "\t.@a = 1;\n\tZeny -= 5;\n\t.@a++;\n\t$count += 1;\n\t#bank[2] = .@a * 2;\n\tset .@b, .@a > 1 ? 10 : 20;\n\tsetarray .@arr[0], 1, 2, 3;";
    const result = parse(wrap(code));
    expect(result.diagnostics).toEqual([]);
    const kinds = bodyOf(wrap(code)).map((statement) => statement.kind);
    expect(kinds).toEqual(["ExpressionStatement", "ExpressionStatement", "ExpressionStatement", "ExpressionStatement", "ExpressionStatement", "CommandStatement", "CommandStatement"]);
  });

  it("classe les variables par prefixe et suffixe", () => {
    const statements = bodyOf(wrap('\tset .@s$, "a";\n\tset $@g, 1;\n\tset ##acc, 2;\n\tset \'inst, 3;'));
    const variables = statements.map((statement) => (statement.kind === "CommandStatement" ? statement.args[0] : undefined));
    expect(variables[0]).toMatchObject({ kind: "Variable", prefix: ".@", scope: "script", name: "s", isString: true });
    expect(variables[1]).toMatchObject({ prefix: "$@", scope: "global-temporary", name: "g" });
    expect(variables[2]).toMatchObject({ prefix: "##", scope: "account-global" });
    expect(variables[3]).toMatchObject({ prefix: "'", scope: "instance" });
  });

  it("respecte la precedence des operateurs", () => {
    const statements = bodyOf(wrap("\t.@a = 1 + 2 * 3;"));
    const statement = statements[0];
    if (statement?.kind !== "ExpressionStatement") throw new Error("attendu ExpressionStatement");
    expect(statement.expression).toMatchObject({
      kind: "Assignment",
      value: { kind: "Binary", operator: "+", right: { kind: "Binary", operator: "*" } },
    });
  });

  it("decode les chaines avec echappements et codes couleur", () => {
    const statements = bodyOf(wrap('\tmes "He said \\"hi\\" ^FF0000red^000000";'));
    const mes = statements[0];
    if (mes?.kind !== "CommandStatement") throw new Error("attendu CommandStatement");
    expect(mes.args[0]).toMatchObject({ kind: "StringLiteral", value: 'He said "hi" ^FF0000red^000000', unterminated: false });
  });

  it("accepte les arguments entre parentheses avec espaces et retours a la ligne", () => {
    const result = parse(wrap('\tcloakoffnpcself( "Oscar#life" );\n\tcallfunc("F_X",\n\t\t1, 2);'));
    expect(result.diagnostics).toEqual([]);
  });
});

describe("erreurs et recuperation", () => {
  it("signale un point-virgule manquant sans perdre la suite", () => {
    const result = parse(wrap('\tmes "a"\n\tmes "b";'));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RS0020"]);
    expect(bodyOf(wrap('\tmes "a"\n\tmes "b";'))).toHaveLength(2);
  });

  it("signale un bloc non ferme et s'arrete a la declaration suivante", () => {
    const text = "prontera,1,1,0\tscript\tA\t100,{\n\tmes \"x\";\n\nprontera,2,2,0\tscript\tB\t100,{\n\tend;\n}\n";
    const result = parse(text);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RS0011"]);
    expect(result.ast.declarations.map((declaration) => declaration.kind)).toEqual(["NpcDeclaration", "NpcDeclaration"]);
    const second = result.ast.declarations[1];
    expect(second).toMatchObject({ name: { full: "B" } });
  });

  it("signale une accolade fermante orpheline au premier niveau", () => {
    const result = parse("}\nprontera,1,1,0\twarp\tw\t1,1,geffen,1,1\n");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RS0010"]);
    expect(result.ast.declarations).toHaveLength(1);
  });

  it("signale une parenthese non fermee", () => {
    expect(codes(wrap("\tif (.@a == 1 {\n\t\tend;\n\t}"))).toContain("RS0012");
    expect(codes(wrap('\tmes ("a";'))).toContain("RS0012");
  });

  it("signale else sans if, case hors switch, label manquant apres goto", () => {
    expect(codes(wrap("\telse mes \"x\";"))).toContain("RS0040");
    expect(codes(wrap("\tcase 1: mes \"x\";"))).toContain("RS0041");
    expect(codes(wrap("\tgoto ;"))).toContain("RS0024");
  });

  it("signale chaines et commentaires non fermes", () => {
    expect(codes(wrap('\tmes "abc;'))).toContain("RS0001");
    expect(codes(wrap("\tmes \"a\";\n\t/* ouvert"))).toContain("RS0002");
  });

  it("signale un caractere inattendu dans le code", () => {
    expect(codes(wrap("\tmes \"a\"; \\ \n\tclose;"))).toContain("RS0003");
  });

  it("signale du texte apres une declaration sur la meme ligne", () => {
    // Sur la ligne d'un warp, le texte supplementaire fait partie du dernier champ (pas de RS0035).
    expect(codes("prontera,1,1,0\twarp\tw\t1,1,geffen,1,1\tmes junk\n")).not.toContain("RS0035");
    // Apres l'accolade fermante d'un script, tout texte restant sur la ligne est signale.
    expect(codes("prontera,1,1,0\tscript\tA\t100,{\n} trailing\n")).toContain("RS0035");
    // Sur sa propre ligne, ce texte est un en-tete incomplet.
    expect(codes("prontera,1,1,0\tscript\tA\t100,{\n}\ntrailing\n")).toContain("RS0030");
  });

  it("signale un en-tete incomplet", () => {
    expect(codes("hello world\n")).toContain("RS0030");
  });

  it("ne reporte aucune erreur pour du code valide avec else if enchaines", () => {
    const code = "\tif (a) mes \"1\";\n\telse if (b) mes \"2\";\n\telse mes \"3\";";
    expect(parse(wrap(code)).diagnostics).toEqual([]);
  });
});

describe("cas issus de scripts reels (corpus du serveur)", () => {
  it("condition de if = expression complete commencant par une parenthese", () => {
    const code = "\tif (getarg(0) == 1)&&(getarg(1) == 1)&&(Zeny<@healfee) goto Zeny_Short_Both;\nZeny_Short_Both:\n\tend;";
    const result = parse(wrap(code));
    expect(result.diagnostics).toEqual([]);
    const statement = bodyOf(wrap(code))[0];
    expect(statement).toMatchObject({ kind: "IfStatement", condition: { kind: "Binary", operator: "&&" }, consequent: { kind: "GotoStatement" } });
  });

  it("commande dont le premier argument est une expression parenthesee (getexp (...)?a:b,0;)", () => {
    const code = "\tgetexp (checkre(3))?1000:10000,0;";
    const result = parse(wrap(code));
    expect(result.diagnostics).toEqual([]);
    const statement = bodyOf(wrap(code))[0];
    if (statement?.kind !== "CommandStatement") throw new Error("attendu CommandStatement");
    expect(statement.parenthesized).toBe(false);
    expect(statement.args).toHaveLength(2);
    expect(statement.args[0]).toMatchObject({ kind: "Conditional" });
  });

  it("normalise mes (\"a\"); en un appel parenthese a un seul argument, et garde la liste d'arguments", () => {
    const single = bodyOf(wrap('\tmes ("a");'))[0];
    expect(single).toMatchObject({ kind: "CommandStatement", parenthesized: true, args: [{ kind: "StringLiteral" }] });
    const list = bodyOf(wrap("\tgetitem (501, 2);"))[0];
    expect(list).toMatchObject({ kind: "CommandStatement", parenthesized: true });
    if (list?.kind === "CommandStatement") expect(list.args).toHaveLength(2);
  });

  it("lit une chaine de 1000 else if sans troncature ni diagnostic", () => {
    const chain = Array.from({ length: 1000 }, (_, index) => `\telse if (.@r <= ${index}) getitem ${index},1;`).join("\n");
    const code = `\tif (.@r <= -1) getitem 1,1;\n${chain}\n\telse getitem 2,1;`;
    const result = parse(wrap(code));
    expect(result.truncated).toBe(false);
    expect(result.diagnostics).toEqual([]);
    let depth = 0;
    let node: Statement | null = bodyOf(wrap(code))[0] ?? null;
    while (node !== null && node.kind === "IfStatement") {
      depth += 1;
      node = node.alternate;
    }
    expect(depth).toBe(1001);
  });

  it("variables dont le nom commence par un chiffre et constantes de sprite alphanumeriques", () => {
    const code = "\tif (.@a >= $050320_ein_typing) mes \"x\";\n\tswitch($2011_agit_invest) {\n\tcase 11: setarray.@cas$[0],\"prt\",\"pay\"; break;\n\t}\n\tclasschange( 4_DR_KID_01, \"Kid#doram03t\", bc_self );";
    expect(parse(wrap(code)).diagnostics).toEqual([]);
  });

  it("variable chaine permanente sans prefixe (currentquest$)", () => {
    const code = '\tmes "^0000FF"+getd("." + currentquest$ + "_collectionname$")+"^000000";';
    expect(parse(wrap(code)).diagnostics).toEqual([]);
  });

  it("accepte une position avec une valeur supplementaire apres la direction", () => {
    expect(parse("1@mcd,144,212,5,0\tscript\tbattle#1\tHIDDEN_WARP_NPC,{\n\tend;\n}\n").diagnostics).toEqual([]);
  });

  it("signale une seule fois la virgule a la place du ; dans un for (le serveur la tolere)", () => {
    const result = parse(wrap("\tfor ( .@i = 0, .@i < .@size; .@i++ ) {\n\t\tmes \"x\";\n\t}"));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RS0022"]);
  });

  it("signale une seule fois un ':' ou une ')' parasite apres une affectation", () => {
    expect(parse(wrap("\t.@type = getarg(0):\n\tclose;")).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RS0020"]);
    expect(parse(wrap("\t.@total = ( .@a <= 1 ) ? .@a : ( .@b ));\n\tclose;")).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["RS0010"]);
  });

  it("accepte l'operateur d'affectation ~= et les sauts de ligne dans une liste d'arguments", () => {
    expect(parse(wrap("\t.@a ~= 3;\n\tcallfunc(\"F\",\n\t\t1,\n\t\t2);")).diagnostics).toEqual([]);
  });
});

describe("limites et robustesse", () => {
  it("n'explose pas la pile sur une imbrication extreme et marque le resultat comme tronque", () => {
    const deep = `${"(".repeat(5000)}1${")".repeat(5000)}`;
    const result = parse(wrap(`\t.@a = ${deep};\n\tclose;`));
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "RS0050")).toBe(true);
    expect(result.tokens.map((token) => token.text).join("")).toBe(wrap(`\t.@a = ${deep};\n\tclose;`));
  });

  it("n'explose pas sur des blocs profondement imbriques", () => {
    const code = `${"{".repeat(3000)}${"}".repeat(3000)}`;
    const result = parse(wrap(code));
    expect(result.truncated).toBe(true);
  });

  it("limite le nombre de diagnostics conserves", () => {
    const code = Array.from({ length: 50 }, () => '\tmes "a"').join("\n");
    const result = parse(wrap(code), { maxDiagnostics: 10 });
    expect(result.diagnostics.length).toBeLessThanOrEqual(10);
  });

  it("findNodeAt retrouve le noeud le plus profond", () => {
    const text = wrap('\tmes "Bonjour";');
    const result = parse(text);
    const offset = text.indexOf("Bonjour") + 2;
    const node = findNodeAt(result.ast, offset);
    expect(node).toMatchObject({ kind: "StringLiteral" });
  });

  it("produit toujours des plages valides sur un texte reel de reference", () => {
    const text = [
      "// en-tete",
      "prontera,150,150,4\tscript\tTest#1\t100,{",
      "\tmes \"[Test]\";",
      "\tif (select(\"Oui:Non\") == 1) {",
      "\t\tgetitem 501, 1;",
      "\t}",
      "\tclose;",
      "OnInit:",
      "\tend;",
      "}",
      "",
    ].join("\n");
    const result = parse(text);
    expect(result.diagnostics).toEqual([]);
    expectValidRanges(text, result.ast);
  });

  it("fuzz deterministe : jamais d'exception, jetons sans perte, plages valides", () => {
    const fragments = [
      "prontera,150,150,4", "\t", "script", "warp", "shop", "monster", "mapflag", "duplicate(a)", "function", "{", "}", "(", ")", "[", "]",
      ";", ",", ":", "\n", " ", "mes", "close", "next", "if", "else", "while", "for", "do", "switch", "case", "default", "break", "return", "goto",
      ".@x", "$y", "'z", "#w", "Zeny", "=", "+=", "++", "?", "-", "!", "&&", "\"str\"", "\"un", "/*", "*/", "//", "100", "0x1F", "é", "😀", "\\",
    ];
    let state = 0x1badf00d;
    const random = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let run = 0; run < 400; run += 1) {
      const count = Math.floor(random() * 60);
      let text = "";
      for (let i = 0; i < count; i += 1) text += fragments[Math.floor(random() * fragments.length)] ?? "";
      const result = parse(text);
      expect(result.tokens.map((token) => token.text).join("")).toBe(text);
      walk(result.ast, (node) => {
        expect(node.range.start).toBeGreaterThanOrEqual(0);
        expect(node.range.end).toBeGreaterThanOrEqual(node.range.start);
        expect(node.range.end).toBeLessThanOrEqual(text.length);
      });
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.range.start).toBeGreaterThanOrEqual(0);
        expect(diagnostic.range.end).toBeLessThanOrEqual(text.length);
      }
    }
  });
});
