/**
 * Verification de l'aide aux commandes (completion, aide de signature, survol) sur un serveur rAthena reel (M3-S3).
 *
 * Usage : pnpm exec tsx scripts/commands-report.ts --server-root <racine du serveur> [--step N] [--json]
 *
 * Lecture seule. **Oracle independant du service** : l'AST du parseur. Pour un appel sur N dans les scripts charges par le
 * serveur, on place le curseur la ou le parseur dit qu'il y a un nom de commande ou un argument, et on verifie que le
 * service (qui, lui, ne lit que le texte qui precede le curseur) retrouve la meme commande et le meme rang d'argument :
 * - survol sur le nom -> la commande ;
 * - completion apres les deux premieres lettres du nom (debut d'instruction) -> la commande est proposee ;
 * - aide de signature au debut de chaque argument -> la commande, avec le bon rang d'argument ;
 * puis les modeles de NPC contre le registre du serveur.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildRathenaRegistry, detectRenewal, RATHENA_PATHS, resolveRathenaScripts } from "@runeforge/emulator-rathena";
import { analyzeFile } from "@runeforge/runescript-analysis";
import { LineIndex, normalizeToLf } from "@runeforge/runescript-core";
import { LanguageServer } from "@runeforge/runescript-language-server";
import { NPC_TEMPLATES, renderTemplate } from "@runeforge/npc-templates";
import { childrenOf, parse } from "@runeforge/runescript-parser";
import type { AstNode, CommandStatement } from "@runeforge/runescript-parser";
import { statSync } from "node:fs";
import { join } from "node:path";
import { parseCommandLine } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--step"]);
const root = cli.value("--server-root");
if (root === undefined) {
  console.error("Usage : tsx scripts/commands-report.ts --server-root <racine du serveur> [--step N] [--json]");
  process.exit(2);
}
const serverRoot: string = root;
const step = Math.max(1, Math.floor(Number(cli.value("--step")) || 40));
const asJson = cli.has("--json");

function readOptional(relative: string): string | null {
  try {
    return readFileSync(join(serverRoot, relative)).toString("latin1");
  } catch {
    return null;
  }
}

const full = buildRathenaRegistry({
  builtinSource: readOptional(RATHENA_PATHS.builtinSource),
  customBuiltins: readOptional(RATHENA_PATHS.customBuiltins),
  commandDoc: readOptional(RATHENA_PATHS.commandDoc),
});
const registry = full.registry;
if (registry === null) {
  console.error("Aucun registre de commandes dans ce serveur : rien a verifier.");
  process.exit(2);
}
const renewal = detectRenewal(readOptional(RATHENA_PATHS.renewalHeader));
const load = await resolveRathenaScripts(
  {
    readText: (path) => Promise.resolve(readOptional(path)),
    existingFiles: (paths) =>
      Promise.resolve(
        new Set(
          paths.filter((path) => {
            try {
              return statSync(join(serverRoot, path)).isFile();
            } catch {
              return false;
            }
          }),
        ),
      ),
  },
  renewal.renewal,
);

const lines: string[] = [];
const say = (text: string): void => {
  lines.push(text);
};
const report: Record<string, unknown> = {};

// --- 1. Informations des commandes ------------------------------------------------------------------------------------
{
  const server = new LanguageServer();
  server.setCommandRegistry(registry);
  let withSignature = 0;
  let withDocs = 0;
  let generated = 0;
  let truncated = 0;
  for (const definition of registry.definitions()) {
    const info = server.commandInfo(definition.name);
    if (info === undefined) continue;
    if (definition.signatures.length > 0) withSignature += 1;
    else generated += 1;
    if (info.documentation !== null) withDocs += 1;
    if (info.documentationTruncated) truncated += 1;
  }
  say(`COMMANDES : ${registry.size} ; signature du manuel : ${withSignature} ; signature generee depuis la table : ${generated} ; avec aide : ${withDocs} (dont ${truncated} extraits coupes)`);
  report["commands"] = { total: registry.size, withSignature, generated, withDocs, truncated };
}

// --- 2. Appels reels --------------------------------------------------------------------------------------------------
interface Failure {
  readonly check: string;
  readonly where: string;
  readonly detail: string;
}
const failures: Failure[] = [];
const tally = {
  sites: 0,
  hover: { checked: 0, ok: 0 },
  completion: { checked: 0, ok: 0 },
  signature: { checked: 0, ok: 0 },
  /** Aucune aide ne doit apparaitre hors des arguments : apres le `;` de l'instruction, et sur le nom lui-meme. */
  silent: { checked: 0, ok: 0 },
  arguments: 0,
};
const note = (check: string, where: string, detail: string): void => {
  if (failures.length < 40) failures.push({ check, where, detail });
};

function expectedParameter(argIndex: number, parameterCount: number, variadic: boolean): number {
  const last = parameterCount - 1;
  return variadic && last >= 0 && argIndex > last ? last : argIndex;
}

const started = performance.now();
let seen = 0;
/** Durees (ms) des requetes les plus lourdes : liste complete des commandes au debut d'une instruction, aide de signature. */
const latency = { listAll: [] as number[], signature: [] as number[] };
const server = new LanguageServer();
server.setCommandRegistry(registry);
for (const uri of load.files) {
  const raw = readOptional(uri);
  if (raw === null) continue;
  const text = normalizeToLf(raw);
  const parsed = parse(text);
  const sites: CommandStatement[] = [];
  const stack: AstNode[] = [parsed.ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.kind === "CommandStatement" && node.terminated && registry.has(node.name) && !node.args.some((argument) => argument.kind === "ErrorExpression")) {
      seen += 1;
      if (seen % step === 0) sites.push(node);
    }
    for (const child of childrenOf(node)) stack.push(child);
  }
  if (sites.length === 0) continue;

  server.updateDocument(uri, 1, text);
  const lines2 = new LineIndex(text);
  for (const site of sites) {
    tally.sites += 1;
    const definition = registry.get(site.name);
    if (definition === undefined) continue;
    const where = `${uri}:${lines2.positionAt(site.nameRange.start).line + 1}`;
    const nameLower = site.name.toLowerCase();

    // Survol sur le nom.
    tally.hover.checked += 1;
    const hover = server.hover(uri, lines2.positionAt(site.nameRange.start + 1));
    if (hover?.kind === "command" && hover.name.toLowerCase() === nameLower) tally.hover.ok += 1;
    else note("survol", where, `${site.name} -> ${hover === undefined ? "rien" : hover.kind}`);

    // Liste complete (Ctrl+Espace sans fragment) au debut de l'instruction : la requete la plus lourde (~700 propositions).
    if (latency.listAll.length < 400) {
      const before = performance.now();
      server.completion(uri, lines2.positionAt(site.nameRange.start), { explicit: true });
      latency.listAll.push(performance.now() - before);
    }

    // Completion apres les deux premieres lettres, au debut d'une instruction.
    tally.completion.checked += 1;
    const cut = Math.min(2, site.name.length);
    const items = server.completion(uri, lines2.positionAt(site.nameRange.start + cut));
    if (items.some((item) => item.label.toLowerCase() === nameLower)) tally.completion.ok += 1;
    else note("completion", where, `${site.name} absent des ${items.length} propositions`);

    // Pas d'aide apres l'instruction terminee, ni juste apres le nom (avant l'espace ou la parenthese).
    for (const [label, offset] of [["apres le point-virgule", site.range.end], ["sur le nom", site.nameRange.end]] as const) {
      tally.silent.checked += 1;
      const help = server.signatureHelp(uri, lines2.positionAt(offset));
      if (help === undefined) tally.silent.ok += 1;
      else note("silence", where, `${site.name} ${label} -> aide de ${help.command.name}`);
    }

    // Aide de signature au debut de chaque argument.
    site.args.forEach((argument, index) => {
      if (argument.kind === "Placeholder" && argument.reason === "empty") return;
      // `setarray.@x[0], ...` : le premier argument touche le nom (sans espace) ; le curseur y est encore sur le nom, rien a verifier.
      if (argument.range.start <= site.nameRange.end) return;
      tally.arguments += 1;
      tally.signature.checked += 1;
      const before = performance.now();
      const help = server.signatureHelp(uri, lines2.positionAt(argument.range.start));
      if (latency.signature.length < 5000) latency.signature.push(performance.now() - before);
      const view = help?.signatures[help.activeSignature];
      const variadic = definition.arity?.max === null;
      // Le rang attendu depend de la signature choisie : on verifie le nom, puis le rang contre cette signature.
      const wanted = view === undefined ? index : expectedParameter(index, view.parameters.length, variadic);
      if (help !== undefined && help.command.name.toLowerCase() === nameLower && (help.activeParameter === wanted || help.activeParameter === index)) {
        tally.signature.ok += 1;
      } else {
        note("signature", `${uri}:${lines2.positionAt(argument.range.start).line + 1}`, `${site.name} argument ${index} -> ${help === undefined ? "rien" : `${help.command.name} #${help.activeParameter}`}`);
      }
    });
  }
}
const ms = performance.now() - started;
say(`APPELS REELS : ${tally.sites} instructions-commandes echantillonnees (1 sur ${step}), ${tally.arguments} arguments, ${ms.toFixed(0)} ms`);
const pct = (ok: number, checked: number): string => (checked === 0 ? "n/a" : `${((100 * ok) / checked).toFixed(2)} %`);
say(`  survol sur le nom            : ${tally.hover.ok}/${tally.hover.checked} (${pct(tally.hover.ok, tally.hover.checked)})`);
say(`  completion apres 2 lettres   : ${tally.completion.ok}/${tally.completion.checked} (${pct(tally.completion.ok, tally.completion.checked)})`);
say(`  aide de signature (arguments): ${tally.signature.ok}/${tally.signature.checked} (${pct(tally.signature.ok, tally.signature.checked)})`);
say(`  aucune aide hors des arguments: ${tally.silent.ok}/${tally.silent.checked} (${pct(tally.silent.ok, tally.silent.checked)})`);
const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
};
say(`  latences : liste complete (${latency.listAll.length} requetes) p50 ${quantile(latency.listAll, 0.5).toFixed(2)} ms, p99 ${quantile(latency.listAll, 0.99).toFixed(2)} ms, max ${Math.max(0, ...latency.listAll).toFixed(2)} ms ; aide de signature (${latency.signature.length} requetes) p50 ${quantile(latency.signature, 0.5).toFixed(3)} ms, p99 ${quantile(latency.signature, 0.99).toFixed(3)} ms, max ${Math.max(0, ...latency.signature).toFixed(2)} ms`);
report["latency"] = { listAllP50: quantile(latency.listAll, 0.5), listAllP99: quantile(latency.listAll, 0.99), signatureP50: quantile(latency.signature, 0.5), signatureP99: quantile(latency.signature, 0.99) };
for (const failure of failures.slice(0, 15)) say(`    ${failure.check} ${failure.where} : ${failure.detail}`);
report["calls"] = { step, ...tally, ms, failures };

// --- 3. Modeles de NPC ------------------------------------------------------------------------------------------------
{
  say("MODELES DE NPC contre le registre du serveur");
  const results: { id: string; parseDiagnostics: number; analysisDiagnostics: number; unknownCalls: number }[] = [];
  for (const template of NPC_TEMPLATES) {
    const text = renderTemplate(template);
    const parsed = parse(text);
    const analysis = analyzeFile(parsed, `${template.id}.txt`, { commands: registry });
    results.push({ id: template.id, parseDiagnostics: parsed.diagnostics.length, analysisDiagnostics: analysis.diagnostics.length, unknownCalls: analysis.unknownCalls.length });
    say(`  ${template.id} : ${parsed.diagnostics.length} diagnostic(s) de syntaxe, ${analysis.diagnostics.length} d'analyse (dont arite), ${analysis.unknownCalls.length} commande(s) inconnue(s)`);
  }
  report["templates"] = results;
}

if (asJson) console.log(JSON.stringify(report, null, 2));
else console.log(lines.join("\n"));
