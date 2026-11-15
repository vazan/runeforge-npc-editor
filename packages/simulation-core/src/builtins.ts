import type { CallInfo, Machine, Reference, Script, SimValue } from "./types";
import { parseVariableName, toNumber, toText } from "./values";
import { MAX_INDEX } from "./store";

/**
 * Commandes et fonctions que la simulation exécute (dialogue, variables, tableaux, quêtes, inventaire, texte, nombres)
 * ou dont elle fixe une valeur de test (le personnage n'a ni groupe, ni guilde, ni équipement). Toute autre commande est
 * notée « non simulée » sans arrêter le dialogue ; toute autre fonction a la valeur 0, notée « supposée ».
 *
 * Le comportement de chaque entrée suit `doc/script_commands.txt` de rAthena.
 */
type Builtin = (machine: Machine, call: CallInfo) => Script<SimValue | undefined>;

const table = new Map<string, Builtin>();
const define = (names: string, builtin: Builtin): void => {
  for (const name of names.split(" ")) table.set(name, builtin);
};

/** Évalue tous les arguments, puis calcule. */
const pure = (compute: (args: SimValue[], machine: Machine, call: CallInfo) => SimValue | undefined): Builtin =>
  function* (machine, call) {
    return compute(yield* machine.values(call.args, call.depth), machine, call);
  };

/** Valeur fixée par le personnage de test (aucune note : ce n'est pas une inconnue du serveur). */
const state = (value: SimValue): Builtin => pure(() => value);

/** Valeur supposée faute de serveur : notée dans la transcription, remplaçable par le contexte de test. */
const assumed = (fallback: SimValue | ((args: SimValue[]) => SimValue)): Builtin =>
  function* (machine, call) {
    const args = yield* machine.values(call.args, call.depth);
    return machine.assume(call, typeof fallback === "function" ? fallback(args) : fallback);
  };

const str = (args: readonly SimValue[], index: number): string => toText(args[index] ?? "");
const num = (args: readonly SimValue[], index: number): number => toNumber(args[index] ?? 0);

function* reference(machine: Machine, call: CallInfo, index: number): Script<Reference> {
  const node = call.args[index];
  const found = node === undefined ? null : yield* machine.reference(node, call.depth + 1);
  if (found === null) return machine.unsupported(call.name, call.range);
  return found;
}

// --- Dialogue ----------------------------------------------------------------------------------------------------

define("mes", function* (machine, call) {
  if (call.args.length === 0) machine.invalid("mes", call.range);
  for (const value of yield* machine.values(call.args, call.depth)) machine.say(toText(value), call.range);
  return 0;
});
define("next", function* () {
  yield { kind: "page", closing: false };
  return 0;
});
// Le dialogue se ferme, le script continue (au contraire de `close`).
define("close2", function* () {
  yield { kind: "page", closing: true };
  return 0;
});
define("clear", state(0));
define("close close3", pure((_args, machine) => machine.stop({ kind: "closed" })));
define("end", pure((_args, machine) => machine.stop({ kind: "end" })));
define("select prompt", function* (machine, call) {
  return yield* machine.choose((yield* machine.values(call.args, call.depth)).map(toText), call.range);
});
define("input", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  // Bornes de `conf/script_athena.conf` (input_min_value 0, input_max_value 10000000).
  const min = call.args[1] === undefined ? 0 : toNumber(yield* machine.evaluate(call.args[1], call.depth + 1));
  const max = call.args[2] === undefined ? 10_000_000 : toNumber(yield* machine.evaluate(call.args[2], call.depth + 1));
  const response = yield { kind: "input", numeric: !target.isString, min, max };
  if (target.isString) {
    const entered = toText(response ?? "");
    machine.write(target, entered, call.range);
    machine.chosen(entered);
    return entered.length > max ? 1 : entered.length < min ? -1 : 0;
  }
  const amount = toNumber(response ?? 0);
  machine.write(target, Math.min(Math.max(amount, min), max), call.range);
  machine.chosen(String(amount));
  return amount > max ? 1 : amount < min ? -1 : 0;
});

// Paroles et annonces : le texte est montré, sa diffusion (carte, zone, serveur) n'est pas simulée.
const speech = (textIndex: number): Builtin =>
  function* (machine, call) {
    const args = yield* machine.values(call.args, call.depth);
    const spoken = args[textIndex];
    if (spoken !== undefined) machine.speak(call.name, toText(spoken));
    return 0;
  };
define("npctalk announce dispbottom", speech(0));
define("unittalk mapannounce message", speech(1));
define("areaannounce", speech(5));

// --- Variables ---------------------------------------------------------------------------------------------------

define("set", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const value = call.args[1];
  if (value === undefined) return machine.invalid("set", call.range);
  machine.write(target, yield* machine.evaluate(value, call.depth + 1), call.range);
  return machine.read(target);
});

function* named(machine: Machine, call: CallInfo): Script<Reference> {
  const [first] = call.args;
  const found = first === undefined ? null : parseVariableName(toText(yield* machine.evaluate(first, call.depth + 1)));
  if (found === null) return machine.invalid(call.name, call.range);
  return found;
}
define("setd", function* (machine, call) {
  const target = yield* named(machine, call);
  const value = call.args[1];
  if (value === undefined) return machine.invalid("setd", call.range);
  machine.write(target, yield* machine.evaluate(value, call.depth + 1), call.range);
  return machine.read(target);
});
define("getd", function* (machine, call) {
  return machine.read(yield* named(machine, call));
});

// --- Appels ------------------------------------------------------------------------------------------------------

define("callsub", function* (machine, call) {
  const [first, ...rest] = call.args;
  if (first === undefined) return machine.invalid("callsub", call.range);
  const label = first.kind === "Identifier" ? first.name : toText(yield* machine.evaluate(first, call.depth + 1));
  return yield* machine.callLabel(label, yield* machine.arguments(rest, call.depth), call.range, call.depth);
});
define("callfunc", function* (machine, call) {
  const [first, ...rest] = call.args;
  if (first === undefined) return machine.invalid("callfunc", call.range);
  const name = toText(yield* machine.evaluate(first, call.depth + 1));
  const args = yield* machine.arguments(rest, call.depth);
  if (machine.hasFunction(name)) return yield* machine.callFunction(name, args, call.range, call.depth);
  // Fonction absente du fichier ouvert : sa valeur et ses effets restent à vérifier sur le serveur.
  if (call.wantValue) return machine.assume(call, 0);
  machine.effect(call);
  return 0;
});
define("getarg", function* (machine, call) {
  const args = yield* machine.values(call.args, call.depth);
  return machine.getArgument(num(args, 0), call.range, args[1]);
});
define("getargcount", pure((_args, machine) => machine.argumentCount()));

// --- Tableaux ----------------------------------------------------------------------------------------------------

const at = (target: Reference, offset: number): Reference => ({ ...target, index: target.index + offset });

function check(machine: Machine, call: CallInfo, target: Reference, count: number): void {
  if (count < 0 || target.index + count > MAX_INDEX + 1) machine.invalid("index", call.range);
}

define("setarray", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const values = yield* machine.values(call.args.slice(1), call.depth);
  check(machine, call, target, values.length);
  values.forEach((value, offset) => machine.write(at(target, offset), value, call.range));
  return 0;
});
define("cleararray", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const args = yield* machine.values(call.args.slice(1), call.depth);
  const count = num(args, 1);
  check(machine, call, target, count);
  for (let offset = 0; offset < count; offset += 1) machine.write(at(target, offset), args[0] ?? 0, call.range);
  return 0;
});
define("copyarray", function* (machine, call) {
  const destination = yield* reference(machine, call, 0);
  const source = yield* reference(machine, call, 1);
  const count = num(yield* machine.values(call.args.slice(2), call.depth), 0);
  check(machine, call, destination, count);
  check(machine, call, source, count);
  const copied = Array.from({ length: count }, (_unused, offset) => machine.read({ ...at(source, offset) }));
  copied.forEach((value, offset) => machine.write(at(destination, offset), value, call.range));
  return 0;
});
define("deletearray", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const count = call.args[1] === undefined ? Number.MAX_SAFE_INTEGER : toNumber(yield* machine.evaluate(call.args[1], call.depth + 1));
  machine.removeFromArray(target, count);
  return 0;
});
define("getarraysize", function* (machine, call) {
  return machine.arraySize(yield* reference(machine, call, 0));
});
define("getelementofarray", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const index = num(yield* machine.values(call.args.slice(1), call.depth), 0);
  return machine.read(at({ ...target, index: 0 }, index));
});
define("inarray", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const [wanted] = yield* machine.values(call.args.slice(1), call.depth);
  const size = machine.arraySize(target);
  for (let index = 0; index < size; index += 1) {
    if (machine.read({ ...target, index }) === wanted) return index;
  }
  return -1;
});
define("explode", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const args = yield* machine.values(call.args.slice(1), call.depth);
  const delimiter = str(args, 1).charAt(0);
  const parts = delimiter === "" ? [str(args, 0)] : str(args, 0).split(delimiter);
  check(machine, call, target, parts.length);
  parts.forEach((part, offset) => machine.write(at(target, offset), part, call.range));
  return 0;
});
define("implode", function* (machine, call) {
  const target = yield* reference(machine, call, 0);
  const glue = str(yield* machine.values(call.args.slice(1), call.depth), 0);
  const parts: string[] = [];
  for (let index = 0; index < machine.arraySize(target); index += 1) parts.push(toText(machine.read({ ...target, index })));
  return parts.join(glue);
});

// --- Nombres -----------------------------------------------------------------------------------------------------

define("rand", pure((args, machine, call) => {
  const first = num(args, 0);
  if (args.length < 2) return first > 0 ? Math.floor(machine.random() * first) : 0;
  const low = Math.min(first, num(args, 1));
  const high = Math.max(first, num(args, 1));
  if (high - low > 0x7fffffff) machine.invalid("rand", call.range);
  return low + Math.floor(machine.random() * (high - low + 1));
}));
define("min", pure((args) => (args.length === 0 ? 0 : Math.min(...args.map(toNumber)))));
define("max", pure((args) => (args.length === 0 ? 0 : Math.max(...args.map(toNumber)))));
define("abs", pure((args) => Math.abs(num(args, 0))));
define("cap_value", pure((args) => Math.min(Math.max(num(args, 0), num(args, 1)), num(args, 2))));
define("pow", pure((args, machine, call) => {
  const result = num(args, 0) ** num(args, 1);
  if (!Number.isSafeInteger(result)) machine.invalid("pow", call.range);
  return result;
}));

// --- Texte -------------------------------------------------------------------------------------------------------

define("atoi", pure((args) => toNumber(str(args, 0))));
define("compare", pure((args) => Number(str(args, 0).toLowerCase().includes(str(args, 1).toLowerCase()))));
define("strcmp", pure((args) => {
  const [left, right] = [str(args, 0), str(args, 1)];
  return left === right ? 0 : left > right ? 1 : -1;
}));
define("getstrlen", pure((args) => str(args, 0).length));
define("charat", pure((args) => str(args, 0).charAt(num(args, 1))));
define("substr", pure((args) => {
  const [from, to] = [num(args, 1), num(args, 2)];
  return from < 0 || to < from ? "" : str(args, 0).slice(from, to + 1);
}));
define("strtoupper", pure((args) => str(args, 0).toUpperCase()));
define("strtolower", pure((args) => str(args, 0).toLowerCase()));
define("strpos", pure((args) => str(args, 0).indexOf(str(args, 1), num(args, 2))));
define("countstr", pure((args) => {
  const needle = args[2] === 0 ? str(args, 1).toLowerCase() : str(args, 1);
  const haystack = args[2] === 0 ? str(args, 0).toLowerCase() : str(args, 0);
  return needle === "" ? 0 : haystack.split(needle).length - 1;
}));
define("replacestr", pure((args) => {
  const sensitive = args[3] !== 0;
  const limit = args[4] === undefined ? Number.MAX_SAFE_INTEGER : num(args, 4);
  const search = str(args, 1);
  if (search === "") return str(args, 0);
  const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), sensitive ? "g" : "gi");
  let replaced = 0;
  return str(args, 0).replace(pattern, (match) => (replaced++ < limit ? str(args, 2) : match));
}));
define("sprintf", pure((args) => {
  let next = 1;
  return str(args, 0).replace(/%(0?)(\d*)([dis%])/g, (_match, zero: string, width: string, kind: string) => {
    if (kind === "%") return "%";
    const value = args[next++] ?? (kind === "s" ? "" : 0);
    const shown = kind === "s" ? toText(value) : String(toNumber(value));
    return shown.padStart(Number(width || 0), zero === "0" && kind !== "s" ? "0" : " ");
  });
}));

// --- Quêtes ------------------------------------------------------------------------------------------------------

/** Constantes `PLAYTIME` et `HUNTING` du serveur (`enum e_quest_check_type`). */
const PLAYTIME = 1;
const HUNTING = 2;

define("checkquest", function* (machine, call) {
  const args = yield* machine.values(call.args, call.depth);
  const state = machine.quests.get(num(args, 0)) ?? -1;
  if (args.length < 2 || num(args, 1) === 0) return state;
  const kind = num(args, 1);
  if (kind !== PLAYTIME && kind !== HUNTING) return state;
  // La progression de chasse et le temps écoulé ne sont pas modélisés : « terminée » seulement si la quête l'est.
  return machine.assume(call, state < 0 ? -1 : state === 2 ? 2 : 0);
});
define("isbegin_quest", pure((args, machine) => {
  const state = machine.quests.get(num(args, 0)) ?? -1;
  return state < 0 ? 0 : state === 2 ? 2 : 1;
}));
define("setquest", pure((args, machine) => {
  machine.quests.set(num(args, 0), 1);
  return 0;
}));
define("completequest", pure((args, machine) => {
  if ((machine.quests.get(num(args, 0)) ?? -1) >= 0) machine.quests.set(num(args, 0), 2);
  return 0;
}));
define("erasequest", pure((args, machine) => {
  machine.quests.delete(num(args, 0));
  return 0;
}));
define("changequest", pure((args, machine) => {
  if ((machine.quests.get(num(args, 0)) ?? -1) >= 0 && (machine.quests.get(num(args, 1)) ?? -1) < 0) {
    machine.quests.delete(num(args, 0));
    machine.quests.set(num(args, 1), 1);
  }
  return 0;
}));

// --- Inventaire --------------------------------------------------------------------------------------------------

define("countitem", function* (machine, call) {
  const [item] = call.args;
  return item === undefined ? 0 : machine.items.get(yield* machine.itemOperand(item, call.depth + 1)) ?? 0;
});
define("getitem getitem2", function* (machine, call) {
  const [item, amount] = call.args;
  if (item === undefined || amount === undefined) return machine.invalid(call.name, call.range);
  const key = yield* machine.itemOperand(item, call.depth + 1);
  const count = toNumber(yield* machine.evaluate(amount, call.depth + 1));
  if (count > 0) machine.items.set(key, (machine.items.get(key) ?? 0) + count);
  return 0;
});
define("delitem", function* (machine, call) {
  const [item, amount] = call.args;
  if (item === undefined || amount === undefined) return machine.invalid("delitem", call.range);
  const key = yield* machine.itemOperand(item, call.depth + 1);
  const count = toNumber(yield* machine.evaluate(amount, call.depth + 1));
  const owned = machine.items.get(key) ?? 0;
  if (count > owned) {
    // Le joueur perd ce qu'il a, puis le script s'arrête sur une erreur (doc `delitem`).
    machine.items.delete(key);
    return machine.invalid("delitem", call.range);
  }
  if (count > 0) {
    if (owned === count) machine.items.delete(key);
    else machine.items.set(key, owned - count);
  }
  return 0;
});
define("checkweight checkweight2", assumed(1));
define("getitemname", assumed((args) => `Item ${toText(args[0] ?? 0)}`));
define("mesitemlink", assumed((args) => `[Item ${toText(args[0] ?? 0)}]`));

// --- Personnage --------------------------------------------------------------------------------------------------

define("strcharinfo", pure((args, machine) => {
  switch (num(args, 0)) {
    case 0: return machine.context.name ?? "Player";
    case 3: return machine.npc.location?.map ?? "prontera";
    default: return "";
  }
}));
define("strnpcinfo", pure((args, machine) => {
  const { display, unique } = machine.npc.name;
  const hash = display.indexOf("#");
  switch (num(args, 0)) {
    case 0: return display;
    case 1: return hash < 0 ? display : display.slice(0, hash);
    case 2: return hash < 0 ? "" : display.slice(hash + 1);
    case 3: return unique;
    case 4: return machine.npc.location?.map ?? "";
    default: return "";
  }
}));
define("getcharid", pure((args) => ({ 0: 150_000, 3: 2_000_000 })[num(args, 0) as 0 | 3] ?? 0));
define("readparam", pure((_args, machine, call) => {
  const [first] = call.args;
  // `readparam(BaseLevel)` : le mot nu désigne le paramètre, pas sa valeur.
  if (first?.kind === "Identifier") return machine.read({ base: first.name.toLowerCase(), index: 0, isString: false });
  return machine.assume(call, 0);
}));
define("checkre", assumed(1));
define("playerattached getattachedrid", state(150_000));

/** Le personnage de test n'a ni groupe, ni guilde, ni partenaire, ne monte rien et ne porte aucun équipement. */
const NO_PARTY_NO_EQUIPMENT: Record<string, SimValue> = {
  is_party_leader: 0, is_guild_leader: 0, getpartyname: "", getguildname: "", getguildmaster: "", getpartnerid: 0,
  ismounting: 0, checkriding: 0, checkcart: 0, checkfalcon: 0, checkdragon: 0, checkwug: 0, checkmadogear: 0, checkoption: 0,
  isequipped: 0, isequippedcnt: 0, getequipid: -1, getequipname: "", getequipcardid: 0, getequiprefinerycnt: 0,
  getequipisequiped: 0, getequipisenableref: 0, getequiprefinecost: 0, getequippercentrefinery: 0, getequipweaponlv: 0,
  getequiparmorlv: 0, getskilllv: 0, vip_status: 0, is_baby: 0,
};
for (const [name, value] of Object.entries(NO_PARTY_NO_EQUIPMENT)) table.set(name, state(value));

// --- Temps -------------------------------------------------------------------------------------------------------

define("gettime", pure((args, machine) => {
  const now = new Date(machine.clock());
  switch (num(args, 0)) {
    case 1: return now.getUTCSeconds();
    case 2: return now.getUTCMinutes();
    case 3: return now.getUTCHours();
    case 4: return now.getUTCDay();
    case 5: return now.getUTCDate();
    case 6: return now.getUTCMonth() + 1;
    case 7: return now.getUTCFullYear();
    case 8: return Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
    case 9: return now.getUTCFullYear() * 10_000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
    default: return 0;
  }
}));
define("gettimetick", pure((args, machine) => {
  const seconds = Math.floor(machine.clock() / 1000);
  switch (num(args, 0)) {
    case 1: return seconds % 86_400;
    case 2: return seconds;
    default: return machine.clock() % 0x7fffffff;
  }
}));

// --- Autres fonctions dont la valeur n'est pas 0 -------------------------------------------------------------------

define("instance_npcname instance_mapname", assumed((args) => str(args, 0)));
define("getmapusers getareausers", assumed(1));

export const BUILTINS: ReadonlyMap<string, Builtin> = table;
