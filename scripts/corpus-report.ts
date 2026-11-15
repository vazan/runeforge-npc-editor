/**
 * Mesure du parseur sur un corpus reel de scripts (CLAUDE.md 16.2 / 20 : "corpus mesure").
 *
 * Usage : pnpm exec tsx scripts/corpus-report.ts <dossier> [--examples N] [--json]
 *
 * Lecture seule. Les fichiers sont decodes en latin1 (1 octet = 1 caractere) : cela rend la
 * mesure independante de l'encodage reel et garantit l'absence d'erreur de decodage.
 * Tout diagnostic de syntaxe sur un corpus qui charge sur un vrai serveur est un faux positif
 * potentiel a examiner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { LineIndex } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";

const args = process.argv.slice(2);
const root = args.find((argument) => !argument.startsWith("--"));
const exampleCount = Number(args[args.indexOf("--examples") + 1] ?? 3) || 3;
const asJson = args.includes("--json");
if (root === undefined) {
  console.error("Usage : tsx scripts/corpus-report.ts <dossier> [--examples N] [--json]");
  process.exit(2);
}

const files: string[] = [];
(function walk(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.toLowerCase().endsWith(".txt")) files.push(full);
  }
})(root);

interface Example {
  file: string;
  line: number;
  message: string;
  excerpt: string;
}

const byCode = new Map<string, { count: number; files: Set<string>; examples: Example[] }>();
let bytes = 0;
let totalDiagnostics = 0;
let crashes = 0;
let losslessFailures = 0;
let truncated = 0;
let declarationCount = 0;
const declarationKinds = new Map<string, number>();
let filesWithSyntaxErrors = 0;
let elapsed = 0;

for (const file of files) {
  const buffer = readFileSync(file);
  bytes += buffer.length;
  const text = buffer.toString("latin1");
  const relativePath = relative(root, file);
  try {
    const started = performance.now();
    const result = parse(text);
    elapsed += performance.now() - started;
    if (result.tokens.map((token) => token.text).join("") !== text) losslessFailures += 1;
    if (result.truncated) truncated += 1;
    declarationCount += result.ast.declarations.length;
    for (const declaration of result.ast.declarations) {
      declarationKinds.set(declaration.kind, (declarationKinds.get(declaration.kind) ?? 0) + 1);
    }
    let hasSyntaxError = false;
    let lineIndex: LineIndex | undefined;
    for (const diagnostic of result.diagnostics) {
      totalDiagnostics += 1;
      if (diagnostic.category === "syntax-error") hasSyntaxError = true;
      const entry = byCode.get(diagnostic.code) ?? { count: 0, files: new Set<string>(), examples: [] };
      entry.count += 1;
      entry.files.add(relativePath);
      if (entry.examples.length < exampleCount) {
        lineIndex ??= new LineIndex(text);
        const position = lineIndex.positionAt(diagnostic.range.start);
        const lineRange = lineIndex.lineRange(position.line);
        entry.examples.push({
          file: relativePath,
          line: position.line + 1,
          message: diagnostic.message,
          excerpt: text.slice(lineRange.start, Math.min(lineRange.end, lineRange.start + 110)).replace(/\r?\n$/, ""),
        });
      }
      byCode.set(diagnostic.code, entry);
    }
    if (hasSyntaxError) filesWithSyntaxErrors += 1;
  } catch (error) {
    crashes += 1;
    console.error(`CRASH ${relativePath}: ${String(error)}`);
  }
}

const megabytes = bytes / 1048576;
const summary = {
  root,
  files: files.length,
  megabytes: Number(megabytes.toFixed(1)),
  parseSeconds: Number((elapsed / 1000).toFixed(2)),
  throughputMBps: Number((megabytes / (elapsed / 1000)).toFixed(1)),
  crashes,
  losslessFailures,
  truncatedFiles: truncated,
  declarations: declarationCount,
  declarationKinds: Object.fromEntries([...declarationKinds.entries()].sort((a, b) => b[1] - a[1])),
  totalDiagnostics,
  filesWithSyntaxErrors,
  diagnosticsByCode: Object.fromEntries(
    [...byCode.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([code, entry]) => [code, { count: entry.count, files: entry.files.size, examples: entry.examples }]),
  ),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Corpus : ${summary.root}`);
  console.log(`${summary.files} fichiers, ${summary.megabytes} Mo, analyse en ${summary.parseSeconds} s (${summary.throughputMBps} Mo/s)`);
  console.log(`Plantages : ${crashes} | pertes de texte : ${losslessFailures} | fichiers tronques : ${truncated}`);
  console.log(`Declarations : ${declarationCount} ${JSON.stringify(summary.declarationKinds)}`);
  console.log(`Diagnostics : ${totalDiagnostics} (fichiers avec erreur de syntaxe : ${filesWithSyntaxErrors})`);
  for (const [code, entry] of Object.entries(summary.diagnosticsByCode)) {
    console.log(`\n${code} x${entry.count} dans ${entry.files} fichier(s)`);
    for (const example of entry.examples) {
      console.log(`  ${example.file}:${example.line}  ${example.message}\n    | ${example.excerpt}`);
    }
  }
}
