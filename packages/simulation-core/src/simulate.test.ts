import { describe, expect, it } from "vitest";
import { parse } from "@runeforge/runescript-parser";
import type { NpcDeclaration } from "@runeforge/runescript-parser";
import { SimulationSession } from "./session";
import type { FunctionSource, SimulationContext, SimulationView, SimulationWorld, SimValue, TranscriptEntry } from "./types";

const character: SimulationContext = {
  level: 42, job: 3, zeny: 100,
  variables: new Map(), items: new Map([["501", 2]]), quests: new Map([[100, 1]]),
};

interface Options {
  readonly context?: Partial<SimulationContext>;
  readonly world?: SimulationWorld;
  /** Déclarations placées avant le NPC (fonctions globales). */
  readonly before?: string;
  /** Texte placé après le corps (labels, OnInit...) dans le même NPC. */
}

function load(source: string): { npc: NpcDeclaration; functions: Map<string, FunctionSource> } {
  const result = parse(source);
  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  const functions = new Map<string, FunctionSource>();
  let npc: NpcDeclaration | undefined;
  for (const declaration of result.ast.declarations) {
    if (declaration.kind === "FunctionDeclaration") functions.set(declaration.name.toLowerCase(), { declaration, source });
    if (declaration.kind === "NpcDeclaration") npc = declaration;
  }
  if (npc === undefined) throw new Error("NPC expected");
  return { npc, functions };
}

function scenario(body: string, options: Options = {}): SimulationSession {
  const source = `${options.before ?? ""}-\tscript\tExample\t-1,{\n${body}\n}\n`;
  const { npc, functions } = load(source);
  return new SimulationSession(npc, { ...character, ...options.context }, { source, functions, ...options.world });
}

/** Avance en répondant à chaque attente avec `answer`, jusqu'à la fin ou jusqu'à `limit` attentes. */
function play(session: SimulationSession, answer: (view: SimulationView) => SimValue | undefined = () => 1, limit = 50): SimulationView {
  let view = session.advance();
  for (let step = 0; step < limit; step += 1) {
    const kind = view.state.kind;
    if (kind !== "page" && kind !== "choice" && kind !== "input") break;
    view = session.advance(answer(view));
  }
  return view;
}

const lines = (view: SimulationView): readonly string[] => view.messages;

/** Écarts notés (opérations que le serveur refuserait) : `detail`, et le nombre d'exécutions. */
const faults = (view: SimulationView): readonly { readonly detail: string; readonly count: number }[] =>
  view.transcript.flatMap((entry: TranscriptEntry) => (entry.kind === "fault" ? [{ detail: entry.detail, count: entry.count }] : []));

/** Instructions notées « non simulées » : leur nom. */
const unsimulated = (view: SimulationView): readonly string[] => view.transcript.flatMap((entry) => (entry.kind === "effect" ? [entry.name] : []));

describe("isolated NPC dialogue simulation", () => {
  it("steps through dialogue and selects a branch with player state and mutable test variables", () => {
    const sim = scenario(`
      mes "Welcome";
      next;
      .@option = select("Buy::Leave");
      if (.@option == 1 && BaseLevel >= 40 && Class == 3 && countitem(501) == 2 && checkquest(100) == 1) {
        Zeny -= 20;
        set .@receipt$, "Bought for " + 20;
        mes .@receipt$;
      } else {
        mes "Farewell";
      }
      close;`);
    expect(sim.advance()).toMatchObject({ state: { kind: "page" }, messages: ["Welcome"] });
    expect(sim.advance()).toMatchObject({ state: { kind: "choice", options: [{ value: 1, label: "Buy" }, { value: 3, label: "Leave" }] } });
    expect(sim.advance(2).state.kind).toBe("choice");
    const result = sim.advance(1);
    expect(result).toMatchObject({ state: { kind: "closed" }, messages: ["Welcome", "Bought for 20"], zeny: 80 });
    expect(result.variables.get("@menu")).toBe(1);
    expect(result.variables.get(".@receipt$")).toBe("Bought for 20");
    expect(character.zeny).toBe(100);
    expect(character.variables.size).toBe(0);
  });

  it("handles menu labels and dash continuation", () => {
    const body = `
      menu "Read:Review",L_Read,"Leave",-;
      mes "Goodbye";
      end;
    L_Read:
      mes "Read";
      end;`;
    const read = scenario(body);
    const leave = scenario(body);
    expect(read.advance().state.kind).toBe("choice");
    expect(leave.advance().state.kind).toBe("choice");
    expect(read.advance(2).messages).toEqual(["Read"]);
    expect(leave.advance(3).messages).toEqual(["Goodbye"]);
  });

  it("records what the player chose in the transcript, between the NPC's lines", () => {
    const sim = scenario('mes "Pick"; .@a = select("Red:Blue"); mes "You chose " + .@a; close;');
    sim.advance();
    const view = sim.advance(2);
    expect(view.transcript).toEqual([
      { kind: "mes", text: "Pick" },
      { kind: "player", text: "Blue" },
      { kind: "mes", text: "You chose 2" },
    ]);
  });

  it("ignores a response the pending pause does not accept and never mutates its inputs", () => {
    const sim = scenario('select("A:B"); mes "after"; close;');
    sim.advance();
    expect(sim.advance(9).state.kind).toBe("choice");
    expect(sim.advance("A").state.kind).toBe("choice");
    expect(sim.advance(1).messages).toEqual(["after"]);
    expect(sim.advance(1).state.kind).toBe("closed");
  });

  it("stops endless loops with a limit, quoting the instruction it reached", () => {
    expect(scenario("L_Loop: goto L_Loop;").advance().state).toMatchObject({ kind: "limit", detail: "steps", text: "goto L_Loop;" });
    // Le budget d'étapes s'épuise sur l'instruction ou l'expression en cours : un extrait du fichier la cite.
    expect(scenario("while (1) { .@i++; }").advance().state).toMatchObject({ kind: "limit", detail: "steps", text: expect.stringMatching(/\S/) });
  });

  it("notes a division by zero, which the server refuses, and carries on with 0", () => {
    const view = play(scenario('mes "a" + (10 / 0) + (7 % 0); mes "b"; close;'));
    expect(view.state.kind).toBe("closed");
    expect(lines(view)).toEqual(["a00", "b"]);
    expect(faults(view)).toEqual([{ detail: "divide", count: 1 }, { detail: "divide", count: 1 }]);
  });
});

describe("variables", () => {
  it("reads a permanent character variable that was never set as 0, like the server (the Bard#2 report)", () => {
    // npc/quests/bard_quest.txt, Bard#2 : `if (bard_q > 5) set gef_bard_q,bard_q;` halted the old simulator at line 1.
    const view = play(scenario(`
      if (bard_q > 5) set gef_bard_q,bard_q;
      set @name$,strcharinfo(0);
      if (gef_bard_q > 29) { mes "Story"; } else { mes "Hello " + @name$ + " " + gef_bard_q; }
      close;`));
    expect(view.state.kind).toBe("closed");
    expect(lines(view)).toEqual(["Hello Player 0"]);
  });

  it("seeds variables of every scope from the context, whatever the case", () => {
    const view = play(scenario(`
      mes "" + BARD_Q + "," + #acct + "," + $glob + "," + $@tmp + "," + .npcvar + "," + @t + "," + .@loc;
      mes name$ + "," + #acct$;
      close;`, {
      context: {
        variables: new Map<string, SimValue>([
          ["bard_q", 7], ["#ACCT", 2], ["$glob", 3], ["$@tmp", 4], [".npcvar", 5], ["@t", 6], [".@loc", 8], ["name$", "Ann"], ["#acct$", "x"],
        ]),
      },
    }));
    expect(lines(view)).toEqual(["7,2,3,4,5,6,8", "Ann,x"]);
  });

  it("converts the value to the type of the variable, as `set` does", () => {
    const view = play(scenario(`
      .@n = "42abc";
      .@s$ = 7;
      .@z = "abc";
      mes .@n + 1;
      mes .@s$ + "!";
      mes .@z;
      close;`));
    expect(lines(view)).toEqual(["43", "7!", "0"]);
  });

  it("supports arrays: setarray, indices, size without trailing zeros, deletearray, copyarray, inarray", () => {
    const view = play(scenario(`
      setarray .@a[0], 10, 20, 30, 0;
      mes getarraysize(.@a);
      .@a[5] = 7;
      mes getarraysize(.@a);
      .@i = 1;
      mes .@a[.@i] + .@a[.@i + 1];
      deletearray .@a[0], 1;
      mes .@a[0] + "," + .@a[1];
      copyarray .@b[0], .@a[0], 2;
      mes .@b[0] + "," + .@b[1] + "," + getarraysize(.@b);
      mes inarray(.@a, 30) + "," + inarray(.@a, 99);
      cleararray .@a[0], 9, 2;
      mes .@a[0] + .@a[1];
      close;`));
    expect(lines(view)).toEqual(["3", "6", "50", "20,30", "20,30,2", "1,-1", "18"]);
  });

  it("treats x and x[0] as the same element and keeps string and numeric arrays apart", () => {
    const view = play(scenario(`
      $@list[0] = 5;
      mes $@list;
      $@list$[0] = "s";
      mes $@list$ + $@list;
      explode(.@p$, "a:b:c", ":");
      mes implode(.@p$, "-") + getarraysize(.@p$);
      close;`));
    expect(lines(view)).toEqual(["5", "s5", "a-b-c3"]);
  });

  it("applies compound assignments, increments, bit operations and integer division like the server", () => {
    const view = play(scenario(`
      .@x = 10;
      .@x += 5; .@x -= 3; .@x *= 2; .@x /= 5; .@x %= 3;
      mes .@x;
      .@y = 5;
      mes .@y++ + "," + ++.@y + "," + .@y-- + "," + --.@y;
      mes (6 & 3) + "," + (6 | 3) + "," + (6 ^ 3) + "," + (1 << 4) + "," + (256 >> 2) + "," + (7 / 2) + "," + (-7 / 2) + "," + (-7 % 3);
      mes !0 + "," + !5 + "," + -3 + "," + ~0;
      close;`));
    expect(lines(view)).toEqual(["1", "5,7,7,5", "2,7,5,16,64,3,-3,-1", "1,0,-3,-1"]);
  });

  it("evaluates both sides of && and || and of ?: like the server", () => {
    const view = play(scenario(`
      .@a = 0;
      .@r = (.@a++ == 5) && (.@a++ == 1);
      mes .@r + "," + .@a;
      .@t = 1 ? (.@b = 10) : (.@c = 100);
      mes .@t + "," + .@b + "," + .@c;
      close;`));
    expect(lines(view)).toEqual(["0,2", "10,10,100"]);
  });

  it("compares and concatenates strings, and notes a type mix the server rejects", () => {
    expect(lines(play(scenario('if ("abc" == "abc" && "abc" < "abd" && "x" != "y") mes "ok" + 1 + "2"; close;')))).toEqual(["ok12"]);
    // Le serveur s'arrête sur un texte mêlé à un nombre ; ici l'égalité compare les textes, le reste calcule sur les nombres.
    const mixed = play(scenario('if ("1" == 1) mes "same"; mes "x" * 2; mes "7" - 2; mes -"3"; close;'));
    expect(lines(mixed)).toEqual(["same", "0", "5", "-3"]);
    expect(faults(mixed)).toEqual(Array.from({ length: 4 }, () => ({ detail: "operand", count: 1 })));
  });

  it("lets the result of an unknown function take the type of what it is compared with, without blaming the script", () => {
    // `instance_live_info(ILI_NAME)` returns a text on the server; the simulation assumes 0 and must not stop on `==`.
    const view = play(scenario('if (instance_live_info(1) == "Villa") mes "villa"; else mes "other"; mes "n" + (unknown_fn(2) - 1); close;'));
    expect(lines(view)).toEqual(["other", "n-1"]);
    expect(faults(view)).toEqual([]);
    expect(view.transcript.filter((entry) => entry.kind === "assumed").map((entry) => entry.name)).toEqual(["instance_live_info", "unknown_fn"]);
  });

  it("resolves constants from the world and reads bare words that are neither as unset variables", () => {
    const sim = scenario('if (Class == Job_Archer && Sex == SEX_MALE && .@n == Unknown_Name) mes "yes"; mes Job_Archer + 0; close;', {
      world: { constants: new Map([["job_archer", 3], ["sex_male", 1]]) },
    });
    expect(lines(play(sim))).toEqual(["yes", "3"]);
    expect(sim.unresolvedNames()).toEqual(new Set(["unknown_name"]));
  });

  it("exposes the character parameters with defaults and lets variables override them", () => {
    const view = play(scenario('mes JobLevel + "," + Weight + "," + MaxWeight + "," + SkillPoint + "," + Upper + "," + BaseClass; Zeny += 5; BaseLevel = 50; mes BaseLevel + "," + Zeny; close;', {
      context: { job: 4008, level: 99, variables: new Map([["weight", 1500]]) },
    }));
    expect(lines(view)).toEqual(["50,1500,20000,0,1,1", "50,105"]);
  });

  it("keeps the Zeny balance from going negative, which the server refuses", () => {
    const view = play(scenario("Zeny -= 101; mes Zeny; close;"));
    expect(lines(view)).toEqual(["0"]);
    expect(faults(view)).toEqual([{ detail: "zeny", count: 1 }]);
  });

  it("passes a variable to a subroutine by reference so the callee reads and edits the caller's array", () => {
    const view = play(scenario(`
      setarray .@list[0], 5, 6, 7;
      callsub S_Edit, .@list;
      mes .@list[0] + "," + .@list[1] + "," + .@list[2] + "," + getarraysize(.@list);
      end;
    S_Edit:
      mes getarraysize(getarg(0)) + ":" + getelementofarray(getarg(0), 1);
      set getelementofarray(getarg(0), 1), 60;
      return;`));
    expect(lines(view)).toEqual(["3:6", "5,60,7,3"]);
  });

  it("keeps the variables of another NPC apart from the ones of the simulated NPC", () => {
    const view = play(scenario(`
      .own = 1;
      set getvariableofnpc(.count, "Other"), 5;
      set getvariableofnpc(.own, "Example"), 2;
      mes getvariableofnpc(.count, "Other") + "," + .count + "," + .own;
      close;`));
    expect(lines(view)).toEqual(["5,0,2"]);
  });

  it("handles dynamic variable names with setd and getd", () => {
    const view = play(scenario(`
      setd ".@v" + 2 + "$", "dyn";
      mes .@v2$ + getd(".@v2$");
      setd "$@arr[3]", 9;
      mes $@arr[3];
      close;`));
    expect(lines(view)).toEqual(["dyndyn", "9"]);
  });
});

describe("control flow", () => {
  it("runs switch with case, default, fallthrough and break", () => {
    const body = `
      switch (select("One:Two:Three:Four")) {
        case 1: mes "a";
        case 2: mes "b"; break;
        case 3: mes "c"; break;
        default: mes "d";
      }
      mes "end"; close;`;
    expect(lines(play(scenario(body), () => 1))).toEqual(["a", "b", "end"]);
    expect(lines(play(scenario(body), () => 2))).toEqual(["b", "end"]);
    expect(lines(play(scenario(body), () => 3))).toEqual(["c", "end"]);
    expect(lines(play(scenario(body), () => 4))).toEqual(["d", "end"]);
  });

  it("runs a switch with no matching case and no default as a no-op", () => {
    expect(lines(play(scenario('switch (9) { case 1: mes "x"; } mes "after"; close;')))).toEqual(["after"]);
  });

  it("runs while, do-while, for, break and continue", () => {
    const view = play(scenario(`
      for (.@i = 1; .@i <= 5; .@i++) { if (.@i == 2) continue; if (.@i == 5) break; mes "f" + .@i; }
      .@w = 0;
      while (.@w < 3) { .@w++; mes "w" + .@w; }
      do { mes "d" + .@w; .@w--; } while (.@w > 2);
      for (;;) { break; }
      close;`));
    expect(lines(view)).toEqual(["f1", "f3", "f4", "w1", "w2", "w3", "d3"]);
  });

  it("jumps with goto, including to a label inside a block", () => {
    const view = play(scenario(`
      goto L_Skip;
      mes "never";
    L_Skip:
      mes "skipped";
      if (1) {
        mes "in";
        goto L_Inner;
        mes "never2";
      L_Inner:
        mes "inner";
      }
      goto L_Missing;`));
    expect(lines(view)).toEqual(["skipped", "in", "inner"]);
    // Un label introuvable : le serveur arrête le script, la simulation s'y termine en le notant.
    expect(view.state.kind).toBe("end");
    expect(faults(view)).toEqual([{ detail: "label L_Missing", count: 1 }]);
  });

  it("calls subroutines with arguments and return values, scoping .@ variables per call", () => {
    const view = play(scenario(`
      .@x = 1;
      callsub S_Show, "a", 2;
      mes "x=" + .@x;
      .@sum = callsub(S_Add, 3, 4);
      mes "sum=" + .@sum + " count=" + .@cnt;
      end;
    S_Show:
      .@x = 99;
      mes getarg(0) + getarg(1) + "/" + getargcount() + "/" + getarg(5, "none");
      return;
    S_Add:
      .@cnt = 5;
      return getarg(0) + getarg(1);`));
    expect(lines(view)).toEqual(["a2/2/none", "x=1", "sum=7 count=0"]);
    expect(view.state.kind).toBe("end");
  });

  it("notes a return outside a call, a missing argument and a missing subroutine, and stops runaway recursion", () => {
    const outside = scenario('mes "a"; return; mes "b";').advance();
    expect(outside).toMatchObject({ state: { kind: "end" }, messages: ["a"] });
    expect(faults(outside)).toEqual([{ detail: "return", count: 1 }]);
    // `getarg` sans l'argument demandé : 0 tient lieu de l'argument, le sous-programme continue puis rend la main.
    const missing = play(scenario('callsub S_A; mes "back"; end; S_A: mes "arg=" + getarg(0); return;'));
    expect(lines(missing)).toEqual(["arg=0", "back"]);
    expect(faults(missing)).toEqual([{ detail: "getarg", count: 1 }]);
    const nowhere = play(scenario('callsub S_Nowhere; mes "after"; close;'));
    expect(lines(nowhere)).toEqual(["after"]);
    expect(faults(nowhere)).toEqual([{ detail: "label S_Nowhere", count: 1 }]);
    expect(play(scenario("callsub S_A; end; S_A: callsub S_A; return;")).state).toMatchObject({ kind: "limit", detail: "calls" });
  });

  it("ends the script when a called unit runs off its end without return", () => {
    expect(play(scenario("callsub S_A; mes \"back\"; close; S_A: mes \"in\";")).state.kind).toBe("end");
  });

  it("calls functions from the world, the same file and the script itself", () => {
    const before = "function\tscript\tF_Twice\t{ return getarg(0) * 2; }\nfunction\tscript\tF_Say\t{ mes \"say \" + getarg(0); return; }\n";
    const view = play(scenario(`
      mes callfunc("F_Twice", 21);
      callfunc "F_Say", "hi";
      mes F_Twice(5);
      F_Say "direct";
      function Local { mes "local " + getarg(0); return getarg(0) + 1; }
      mes Local(1);
      mes callfunc("F_Nowhere", 1) + 0;
      callfunc "F_Nowhere";
      close;`, { before }));
    expect(lines(view)).toEqual(["42", "say hi", "10", "say direct", "local 1", "2", "0"]);
    const notes = view.transcript.filter((entry) => entry.kind === "assumed" || entry.kind === "effect").map((entry) => entry.kind);
    expect(notes).toEqual(["assumed", "effect"]);
  });
});

describe("pauses", () => {
  it("reads numeric and text input, clamped like the server, and reports what was entered", () => {
    const sim = scenario(`
      input .@n, 1, 10;
      input .@s$;
      mes .@n + "/" + .@s$;
      close;`);
    expect(sim.advance().state).toEqual({ kind: "input", numeric: true, min: 1, max: 10 });
    expect(sim.advance("text").state.kind).toBe("input");
    expect(sim.advance(50).state).toEqual({ kind: "input", numeric: false, min: 0, max: 10_000_000 });
    expect(sim.advance(3).state.kind).toBe("input");
    const view = sim.advance("Poring");
    expect(view.messages).toEqual(["10/Poring"]);
    expect(view.transcript.filter((entry) => entry.kind === "player").map((entry) => entry.text)).toEqual(["50", "Poring"]);
  });

  it("returns the clamp direction of input", () => {
    const sim = scenario("mes input(.@n, 1, 10); close;");
    sim.advance();
    expect(sim.advance(99).messages).toEqual(["1"]);
  });

  it("keeps running after close2 but ends the script with close, close3 and end", () => {
    const sim = scenario('mes "a"; close2; mes "b"; close;');
    expect(sim.advance().state).toEqual({ kind: "page", closing: true });
    expect(sim.advance()).toMatchObject({ state: { kind: "closed" }, messages: ["a", "b"] });
    expect(scenario('mes "a"; close3; mes "b";').advance().state.kind).toBe("closed");
    expect(scenario('mes "a"; end; mes "b";').advance()).toMatchObject({ state: { kind: "end" }, messages: ["a"] });
    expect(scenario('next;').advance().state).toEqual({ kind: "page", closing: false });
  });

  it("ends the script on a menu without options, where the player can only cancel, and limits too many options", () => {
    // `select("")` : la fenêtre n'offre aucun choix, annuler termine le script (le `close` suivant est inatteignable).
    expect(scenario('mes "x"; select(""); mes "never"; close;').advance()).toMatchObject({ state: { kind: "end" }, messages: ["x"] });
    expect(scenario('select("::");').advance().state.kind).toBe("end");
    expect(scenario(`select("${"a:".repeat(70)}b");`).advance().state).toMatchObject({ kind: "limit", detail: "menu" });
  });

  it("limits the amount of text a script can produce", () => {
    expect(scenario('for (.@i = 0; .@i < 5000; .@i++) mes "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";').advance().state)
      .toMatchObject({ kind: "limit", detail: "text" });
  });
});

describe("what the simulation does not run", () => {
  it("notes unsimulated commands where they happen and keeps the dialogue going", () => {
    const view = play(scenario(`
      cutin "bard_eland02", 2;
      mes "[Errende]";
      specialeffect2 EF_STEAL;
      mes "Why, hello there~";
      getexp 100, 50;
      close;`));
    expect(view.state.kind).toBe("closed");
    expect(view.transcript.map((entry) => (entry.kind === "mes" ? entry.text : `${entry.kind}:${entry.kind === "effect" ? entry.name : ""}`))).toEqual([
      "effect:cutin", "[Errende]", "effect:specialeffect2", "Why, hello there~", "effect:getexp",
    ]);
    expect(view.transcript[0]).toMatchObject({ kind: "effect", text: 'cutin "bard_eland02", 2;', count: 1 });
  });

  it("folds an instruction run many times into one line with its count", () => {
    const view = play(scenario('for (.@i = 0; .@i < 4; .@i++) specialeffect(1); mes "done"; close;'));
    const effects = view.transcript.filter((entry) => entry.kind === "effect");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ name: "specialeffect", count: 4 });
  });

  it("gives an unknown function the value 0, notes it, and lets the test impose another value", () => {
    const body = 'if (somecustomfn(3) == 5) mes "five"; else mes "zero"; close;';
    const plain = play(scenario(body));
    expect(lines(plain)).toEqual(["zero"]);
    expect(plain.transcript).toContainEqual(expect.objectContaining({ kind: "assumed", name: "somecustomfn", value: 0, text: expect.stringContaining("somecustomfn(3)") }));
    const forced = play(scenario(body, { context: { results: new Map([["somecustomfn", 5]]) } }));
    expect(lines(forced)).toEqual(["five"]);
  });

  it("assumes what depends on the server (weight, renewal) and lets the test change it", () => {
    const body = 'if (checkweight(501, 5) && checkre(0)) mes "can"; else mes "cannot"; close;';
    expect(lines(play(scenario(body)))).toEqual(["can"]);
    expect(lines(play(scenario(body, { context: { results: new Map([["checkweight", 0]]) } })))).toEqual(["cannot"]);
  });

  it("shows spoken text of the NPC as speech, not as a dialogue page", () => {
    const view = play(scenario('npctalk "I am talking"; announce "Hear ye", 0; mapannounce "prontera", "Map news", 0; close;'));
    expect(view.transcript).toEqual([
      { kind: "speech", name: "npctalk", text: "I am talking" },
      { kind: "speech", name: "announce", text: "Hear ye" },
      { kind: "speech", name: "mapannounce", text: "Map news" },
    ]);
    expect(view.messages).toEqual([]);
  });
});

describe("OnInit", () => {
  it("runs OnInit before the first visit so NPC variables are ready, without showing its effects", () => {
    const view = play(scenario(`
      mes "Price: " + .price;
      mes "Items: " + getarraysize(.items);
      close;
    OnInit:
      .price = 500;
      setarray .items[0], 1, 2, 3;
      specialeffect 1;
      mes "never shown";
      next;
      .price = 0;
      end;`));
    expect(lines(view)).toEqual(["Price: 500", "Items: 3"]);
    expect(view.transcript.filter((entry) => entry.kind === "effect")).toEqual([]);
  });

  it("keeps going when OnInit fails", () => {
    expect(lines(play(scenario('mes "ok"; close; OnInit: .x = 1 / 0;')))).toEqual(["ok"]);
  });
});

describe("quests and inventory", () => {
  it("follows the quest state machine of the server commands", () => {
    const view = play(scenario(`
      mes isbegin_quest(7) + "," + checkquest(7);
      setquest 7;
      mes isbegin_quest(7) + "," + checkquest(7);
      completequest 7;
      mes isbegin_quest(7) + "," + checkquest(7);
      changequest 7, 8;
      completequest 100;
      changequest 100, 9;
      erasequest 100;
      mes checkquest(100) + "," + checkquest(9) + "," + checkquest(8);
      close;`));
    expect(lines(view)).toEqual(["0,-1", "1,1", "2,2", "-1,1,1"]);
    expect([...view.quests]).toEqual([[8, 1], [9, 1]]);
  });

  it("gives and removes items by id or name, and notes it when too many are removed", () => {
    const view = play(scenario(`
      getitem 501, 3;
      getitem "Red_Potion", 1;
      getitem Blue_Potion, 2;
      mes countitem(501) + "," + countitem("red_potion") + "," + countitem(Blue_Potion);
      delitem 501, 5;
      mes countitem(501);
      delitem Blue_Potion, 9;
      mes "after";`, { context: { items: new Map([["501", 2]]) } }));
    // Le joueur perd ce qu'il avait ; le serveur arrête alors le script (doc `delitem`), la simulation le note et continue.
    expect(lines(view)).toEqual(["5,1,2", "0", "after"]);
    expect(faults(view)).toEqual([{ detail: "delitem", count: 1 }]);
    expect(view.state.kind).toBe("end");
    expect([...view.items]).toEqual([["red_potion", 1]]);
  });

  it("resolves item names through the world constants so ids and names agree", () => {
    const view = play(scenario('getitem Red_Potion, 2; mes countitem(501) + "," + countitem("Red_Potion"); close;', {
      world: { constants: new Map([["red_potion", 501]]) },
    }));
    expect(lines(view)).toEqual(["4,4"]);
  });
});

describe("built-in functions", () => {
  it("draws random numbers from a seed so a run replays identically", () => {
    const body = 'mes rand(100) + "," + rand(5, 9) + "," + rand(0) + "," + rand(7, 7); close;';
    const first = lines(play(scenario(body, { world: { seed: 42 } })));
    expect(lines(play(scenario(body, { world: { seed: 42 } })))).toEqual(first);
    expect(lines(play(scenario(body, { world: { seed: 43 } })))).not.toEqual(first);
    const [a, b, c, d] = (first[0] ?? "").split(",").map(Number);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    expect(b).toBeGreaterThanOrEqual(5);
    expect(b).toBeLessThanOrEqual(9);
    expect([c, d]).toEqual([0, 7]);
  });

  it("answers the character and NPC information the dialogue prints", () => {
    const sim = new SimulationSession(
      load("prontera,150,180,4\tscript\tKafra#home::kafra_home\t112,{\nmes strcharinfo(0) + \"|\" + strcharinfo(1) + \"|\" + strcharinfo(3) + \"|\" + getcharid(0) + \"|\" + getcharid(1);\nmes strnpcinfo(0) + \"|\" + strnpcinfo(1) + \"|\" + strnpcinfo(2) + \"|\" + strnpcinfo(3) + \"|\" + strnpcinfo(4);\nclose;\n}\n").npc,
      { ...character, name: "Ayata" },
    );
    expect(lines(play(sim))).toEqual(["Ayata||prontera|150000|0", "Kafra#home|Kafra|home|kafra_home|prontera"]);
  });

  it("computes with strings and numbers", () => {
    const view = play(scenario(`
      mes atoi("12x") + "," + getstrlen("hello") + "," + charat("hello", 1) + "," + substr("foobar", 3, 5) + "," + substr("foo", 2, 1) + ".";
      mes strtoupper("ab") + strtolower("CD") + "," + strpos("foobarfoo", "foo", 1) + "," + compare("Bloody Murderer", "BLOOD") + "," + compare("Blood", "Bloody");
      mes replacestr("testing tester", "test", "dash") + "," + replacestr("Donkey", "don", "mon", 0) + "," + countstr("test Test", "test", 0);
      mes sprintf("%s has %d and %03d%%", "Zoo", 5, 7) + "," + min(4, 2, 9) + "," + max(4, 2, 9) + "," + abs(-3) + "," + pow(2, 10) + "," + cap_value(15, 0, 10) + "," + strcmp("a", "b");
      close;`));
    expect(lines(view)).toEqual([
      "12,5,e,bar,.",
      "ABcd,6,1,0",
      "dashing dasher,monkey,2",
      "Zoo has 5 and 007%,2,9,3,1024,10,-1",
    ]);
  });

  it("reads the simulated clock for gettime", () => {
    const view = play(scenario('mes gettime(7) + "-" + gettime(6) + "-" + gettime(5) + " " + gettime(3) + ":" + gettime(2) + " " + gettime(9); close;', {
      world: { clock: Date.UTC(2024, 1, 29, 8, 5, 30) },
    }));
    expect(lines(view)).toEqual(["2024-2-29 8:5 20240229"]);
  });

  it("gives the test character no party, guild or equipment", () => {
    const view = play(scenario('mes is_party_leader() + "," + getpartyname(1) + "|" + isequipped(2236) + "," + getequipid(2) + "," + playerattached(); close;'));
    expect(lines(view)).toEqual(["0,|0,-1,150000"]);
  });

  it("reads a parameter by its name through readparam", () => {
    expect(lines(play(scenario("mes readparam(BaseLevel) + readparam(Zeny); close;")))).toEqual(["142"]);
  });
});

/** Comportements que le contrôle par mutations (une modification volontaire du moteur à la fois) a trouvés sans test. */
describe("behaviours pinned by mutation testing", () => {
  it("keeps the displayed variables free of the parameters shown elsewhere and of default array elements", () => {
    const view = play(scenario(".@a[3] = 5; .@a[3] = 0; .@b = 1; Zeny += 1; close;"));
    expect([...view.variables.keys()]).toEqual([".@b"]);
    expect(view.zeny).toBe(101);
  });

  it("caps the number of variable elements a script can create", () => {
    expect(scenario("cleararray .@a[0], 1, 30000;").advance().state).toMatchObject({ kind: "limit", detail: "variables" });
  });

  it("gives || and && their truth tables", () => {
    expect(lines(play(scenario('mes (1 || 0) + "," + (0 || 0) + "," + (1 && 0) + "," + (1 && 2); close;')))).toEqual(["1,0,0,1"]);
  });

  it("notes shifts and sums the server cannot represent, and carries on with 0 or the nearest safe integer", () => {
    const view = play(scenario('mes (1 << 64) + "," + (1 << -1) + "," + (9007199254740991 + 1) + "," + (-9007199254740991 - 2); close;'));
    expect(lines(view)).toEqual(["0,0,9007199254740991,-9007199254740991"]);
    expect(faults(view)).toEqual([{ detail: "shift", count: 1 }, { detail: "shift", count: 1 }, { detail: "overflow", count: 1 }, { detail: "overflow", count: 1 }]);
  });

  it("leaves a loop on break, and only that loop", () => {
    const view = play(scenario(`
      for (.@j = 1; .@j <= 5; .@j++) { if (.@j == 3) break; mes "b" + .@j; }
      while (1) { mes "w"; break; }
      close;`));
    expect(lines(view)).toEqual(["b1", "b2", "w"]);
  });

  it("jumps to a label inside the else branch of a condition", () => {
    const view = play(scenario(`
      goto L_E;
      mes "never";
      if (0) { mes "then"; } else { mes "skipped"; L_E: mes "in else"; }
      mes "after";
      close;`));
    expect(lines(view)).toEqual(["in else", "after"]);
  });

  it("takes an unknown bare word as the item of that name, and a text as a name, never as a number", () => {
    const view = play(scenario(`
      getitem Blue_Potion, 2;
      getitem "0501", 1;
      mes countitem("blue_potion") + "," + countitem(Blue_Potion) + "," + countitem(501) + "," + countitem("0501");
      close;`));
    expect(lines(view)).toEqual(["2,2,2,1"]);
    expect([...view.items].sort()).toEqual([["0501", 1], ["501", 2], ["blue_potion", 2]]);
  });

  it("skips an instruction without its argument and notes it", () => {
    const view = play(scenario('mes; mes "next"; close;'));
    expect(lines(view)).toEqual(["next"]);
    expect(faults(view)).toEqual([{ detail: "mes", count: 1 }]);
  });

  it("deletes to the end of the array when deletearray has no count", () => {
    const view = play(scenario(`
      setarray .@a[0], 1, 2, 3, 4;
      deletearray .@a[1];
      mes getarraysize(.@a);
      deletearray .@a;
      mes getarraysize(.@a);
      close;`));
    expect(lines(view)).toEqual(["1", "0"]);
  });

  it("draws both bounds of rand(low, high)", () => {
    const view = play(scenario(`
      for (.@i = 0; .@i < 60; .@i++) { if (rand(1, 2) == 1) .@ones++; else .@twos++; }
      mes (.@ones > 0 && .@twos > 0) + "," + (.@ones + .@twos);
      close;`));
    expect(lines(view)).toEqual(["1,60"]);
  });

  it("ignores completequest for a quest that is not in the log and derives HUNTING and PLAYTIME from the quest state", () => {
    const view = play(scenario(`
      completequest 55;
      mes checkquest(55) + "," + checkquest(100, HUNTING) + "," + checkquest(101, HUNTING) + "," + checkquest(102, HUNTING) + "," + checkquest(100, PLAYTIME);
      close;`, {
      context: { quests: new Map([[100, 1], [101, 2]]) },
      world: { constants: new Map([["hunting", 2], ["playtime", 1]]) },
    }));
    expect(lines(view)).toEqual(["-1,0,2,-1,0"]);
    expect(view.transcript.filter((entry) => entry.kind === "assumed")).toHaveLength(4);
  });

  it("reads a signed number at the start of a text", () => {
    expect(lines(play(scenario('mes atoi("-12x") + atoi(" 7"); close;')))).toEqual(["-5"]);
  });

  it("refuses a text longer than the limit and a number that is not an integer as the answer to an input", () => {
    const text = scenario("input .@s$; mes getstrlen(.@s$); close;");
    text.advance();
    expect(text.advance("x".repeat(256)).state.kind).toBe("input");
    expect(text.advance("x".repeat(255)).messages).toEqual(["255"]);
    const number = scenario("input .@n; mes .@n; close;");
    number.advance();
    expect(number.advance(1.5).state.kind).toBe("input");
    expect(number.advance(3).messages).toEqual(["3"]);
  });
});

/** Un NPC dont le script a une erreur de syntaxe : le simulateur le joue quand même (l'analyseur est tolérant). */
function broken(source: string): SimulationSession {
  const result = parse(source);
  const npc = result.ast.declarations.find((declaration): declaration is NpcDeclaration => declaration.kind === "NpcDeclaration");
  if (npc === undefined) throw new Error("NPC expected");
  return new SimulationSession(npc, character, { source });
}

describe("no operation halts the dialogue", () => {
  it.each([
    ["a division by zero", "mes 1 / 0;"],
    ["an index out of range", ".@a[-1] = 5; .@b[100000] = 1;"],
    ["a missing argument", "mes getarg(2);"],
    ["a subroutine that does not exist", "callsub S_Nowhere;"],
    ["a call without function name", "callfunc;"],
    ["an array written past the limit", "setarray .@a[99999], 1, 2;"],
    ["a target that is not a variable", "set 5, 6; input 7;"],
    ["too many items removed", "delitem 501, 99;"],
    ["an enormous random range", "mes rand(0, 99999999999);"],
    ["a power the server cannot represent", "mes pow(10, 99);"],
    ["a menu with an odd number of arguments", 'menu "a", L_a, "b";'],
    ["a text under a numeric operator", 'mes -"abc" + ("x" * 2);'],
    ["a missing item amount", "getitem 501;"],
    ["a switch without braces", 'switch (1) mes "x";'],
    ["an increment of a text variable", '.@s$ = "a"; .@s$++;'],
  ])("goes on after %s", (_name, body) => {
    const view = play(scenario(`mes "before"; ${body}\n mes "alive"; close;`));
    expect(view.state.kind).toBe("closed");
    expect(lines(view)[0]).toBe("before");
    expect(lines(view).at(-1)).toBe("alive");
    expect(view.transcript.some((entry) => entry.kind === "fault" || entry.kind === "effect")).toBe(true);
  });

  it("counts how many times an operation was refused, on one line", () => {
    const view = play(scenario('for (.@i = 0; .@i < 5; .@i++) mes 7 / .@z; close;'));
    expect(faults(view)).toEqual([{ detail: "divide", count: 5 }]);
  });

  it("plays an NPC that has syntax errors, noting what it could not read", () => {
    const view = play(broken('-\tscript\tA\t-1,{\n\tmes "a";\n\t.@x = ;\n\tmes "b";\n\t@@@ ### ;;;\n\tclose;\n}\n'));
    expect(view.state.kind).toBe("closed");
    expect(lines(view)).toEqual(["a", "b"]);
    expect(unsimulated(view)).toEqual(["syntax", "syntax"]);
  });

  it("ends an NPC whose body is never closed at its last instruction", () => {
    const view = play(broken('-\tscript\tA\t-1,{\n\tmes "a";\n\tmes "b";\n'));
    expect(view.state.kind).toBe("end");
    expect(lines(view)).toEqual(["a", "b"]);
  });

  it("quotes the file that defines a called function, not the file of the NPC", () => {
    const library = 'function\tscript\tF_Lib\t{\n\tcutin "lib_image", 2;\n\tmes getarg(0);\n\treturn;\n}\n';
    const declaration = parse(library).ast.declarations.find((item) => item.kind === "FunctionDeclaration");
    if (declaration?.kind !== "FunctionDeclaration") throw new Error("function expected");
    const functions = new Map<string, FunctionSource>([["f_lib", { declaration, source: library }]]);
    const view = play(scenario('callfunc "F_Lib", "hello"; mes 1 / 0; close;', { world: { functions } }));
    expect(lines(view)).toEqual(["hello", "0"]);
    expect(view.transcript.filter((entry) => entry.kind === "effect" || entry.kind === "fault")).toMatchObject([
      { kind: "effect", name: "cutin", text: 'cutin "lib_image", 2;' },
      { kind: "fault", detail: "divide", text: "1 / 0" },
    ]);
  });

  it("recovers inside an expression, so the rest of the instruction still runs", () => {
    const view = play(scenario('mes "x" + callsub(S_Nowhere) + "y"; close;'));
    expect(lines(view)).toEqual(["x0y"]);
    expect(faults(view)).toEqual([{ detail: "label S_Nowhere", count: 1 }]);
  });

  it("compares a text and a number as texts where the server would have stopped", () => {
    const view = play(scenario('mes ("1" == 1) + "," + ("1" != 1) + "," + ("a" == 0) + "," + ("a" != 0); close;'));
    expect(lines(view)).toEqual(["1,0,0,1"]);
    expect(faults(view)).toEqual(Array.from({ length: 4 }, () => ({ detail: "operand", count: 1 })));
  });

  it("reads back an array element written past the bounds at the nearest valid index", () => {
    const view = play(scenario('.@a[-5] = 7; .@b[100000] = 9; mes .@a[0] + "," + .@b[99999] + "," + getarraysize(.@a); close;'));
    expect(lines(view)).toEqual(["7,9,1"]);
    expect(faults(view)).toEqual([{ detail: "index", count: 1 }, { detail: "index", count: 1 }]);
  });

  it("does not blame the script for a compound assignment that involves an assumed value", () => {
    const view = play(scenario('.@s$ = "abc"; .@s$ -= unknownfn(1); mes .@s$; close;'));
    expect(lines(view)).toEqual(["0"]);
    expect(faults(view)).toEqual([]);
  });

  it("keeps an assumed value and a refused operation apart even when they start at the same place", () => {
    const view = play(scenario("mes unknownfn(1) / 0; close;"));
    expect(faults(view)).toEqual([{ detail: "divide", count: 1 }]);
    expect(view.transcript.filter((entry) => entry.kind === "assumed")).toMatchObject([{ name: "unknownfn", count: 1 }]);
  });

  it("turns a defect of the simulator itself into a visible note and ends the script instead of throwing", () => {
    const constants = { get: () => { throw new Error("boom"); } } as unknown as ReadonlyMap<string, SimValue>;
    const view = play(scenario('mes "a"; mes Something; mes "b";', { world: { constants }, context: { items: new Map() } }));
    expect(view.state.kind).toBe("end");
    expect(lines(view)).toEqual(["a"]);
    expect(view.transcript.at(-1)).toMatchObject({ kind: "fault", detail: "internal", text: "boom" });
  });

  it("gives the same transcript twice for the same seed even when operations are refused", () => {
    const body = 'mes rand(1000) + "," + (5 / .@zero) + "," + getarg(1); mes "x" + -"y"; close;';
    expect(play(scenario(body, { world: { seed: 9 } })).transcript).toEqual(play(scenario(body, { world: { seed: 9 } })).transcript);
  });
});
