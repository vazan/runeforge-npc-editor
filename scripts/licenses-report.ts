/**
 * Inventaire des licences des dependances (TypeScript et Rust), hors ligne : `pnpm licenses list` lit `node_modules` et
 * `cargo metadata --offline` lit `Cargo.lock` et le cache local de Cargo. Aucun acces reseau.
 *
 * Usage : pnpm exec tsx scripts/licenses-report.ts [--json] [--list-all] [--markdown] [--target <triplet Rust>]
 *
 * Classe chaque composant d'apres son expression SPDX (`OR` : on peut choisir l'une des licences, `AND` : toutes s'appliquent) :
 * - `permissive` : MIT, Apache-2.0, BSD, ISC, Zlib, Unlicense, 0BSD, CC0, Unicode... ;
 * - `copyleft-faible` : MPL, LGPL, EPL, CDDL (obligations sur les modifications du composant) ;
 * - `copyleft-fort` : GPL, AGPL ;
 * - `a-examiner` : expression absente, non reconnue ou personnalisee.
 * Pour Rust, seules les caisses reellement liees pour la cible (Windows par defaut, voir `--target`) sont comptees (parcours de `resolve` depuis les membres de l'espace de
 * travail, arete `normal` pour l'execution, `build` pour la construction). Ce n'est PAS un avis juridique.
 */
import { execSync } from "node:child_process";

const asJson = process.argv.includes("--json");
const listAll = process.argv.includes("--list-all");
const asMarkdown = process.argv.includes("--markdown");
/** Cible des caisses Rust comptees : Windows par defaut ; `--target x86_64-unknown-linux-gnu` pour Linux (a lancer sous Linux : le cache de Cargo doit contenir les caisses de la cible). */
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex === -1 ? "x86_64-pc-windows-msvc" : (process.argv[targetIndex + 1] ?? "");
if (!/^[a-z0-9_.-]+$/.test(target)) throw new Error("--target : un triplet Rust, par exemple x86_64-unknown-linux-gnu");

type Category = "permissive" | "copyleft-faible" | "copyleft-fort" | "a-examiner";

const PERMISSIVE = /^(MIT|MIT-0|Apache-2\.0|BSD-[0-9]-Clause|BSD-[0-9]-Clause-Clear|ISC|Zlib|Unlicense|0BSD|CC0-1\.0|BlueOak-1\.0\.0|Unicode-3\.0|Unicode-DFS-2016|Python-2\.0|BSL-1\.0|CC-BY-4\.0|W3C|WTFPL)$/;
const WEAK = /^(MPL-[0-9.]+|LGPL-[0-9.]+(-only|-or-later)?|EPL-[0-9.]+|CDDL-[0-9.]+)$/;
const STRONG = /^(A?GPL-[0-9.]+(-only|-or-later)?)$/;

/** Evalue une expression SPDX : la categorie la plus favorable que l'on peut choisir (OR) en cumulant les contraintes (AND). */
function classify(expression: string | null | undefined): Category {
  if (expression === null || expression === undefined || expression.trim() === "") return "a-examiner";
  // Cargo ecrit encore `MIT/Apache-2.0` : la barre oblique est un OU (ancienne syntaxe de crates.io).
  const tokens = expression
    .replace(/\s*\/\s*/g, " OR ")
    .replace(/[()]/g, (paren) => ` ${paren} `)
    .split(/\s+/)
    .filter((token) => token !== "");
  let position = 0;
  const order: Category[] = ["permissive", "copyleft-faible", "copyleft-fort", "a-examiner"];
  const worst = (a: Category, b: Category): Category => (order.indexOf(a) >= order.indexOf(b) ? a : b);
  const best = (a: Category, b: Category): Category => (order.indexOf(a) <= order.indexOf(b) ? a : b);
  const atom = (): Category => {
    const token = tokens[position];
    position += 1;
    if (token === "(") {
      const inner = orExpression();
      if (tokens[position] === ")") position += 1;
      return inner;
    }
    if (token === undefined) return "a-examiner";
    const name = token.replace(/\+$/, "");
    // `X WITH exception` : l'exception n'aggrave jamais la licence.
    if (tokens[position] === "WITH") position += 2;
    if (PERMISSIVE.test(name)) return "permissive";
    if (WEAK.test(name)) return "copyleft-faible";
    if (STRONG.test(name)) return "copyleft-fort";
    return "a-examiner";
  };
  const andExpression = (): Category => {
    let result = atom();
    while (tokens[position] === "AND") {
      position += 1;
      result = worst(result, atom());
    }
    return result;
  };
  const orExpression = (): Category => {
    let result = andExpression();
    while (tokens[position] === "OR" || tokens[position] === "/") {
      position += 1;
      result = best(result, andExpression());
    }
    return result;
  };
  return orExpression();
}

interface Component {
  readonly ecosystem: "typescript" | "rust";
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly category: Category;
  /** `execution` : livre avec l'application ; `construction` : outil de build/test, jamais livre. */
  readonly usage: "execution" | "construction";
}

// --- TypeScript -----------------------------------------------------------------------------------------------------------
function pnpmLicenses(production: boolean): Map<string, { license: string; versions: string[] }> {
  const output = execSync(`pnpm licenses list${production ? " --prod" : ""} --json`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const byLicense = JSON.parse(output) as Record<string, { name: string; versions: string[]; license: string }[]>;
  const result = new Map<string, { license: string; versions: string[] }>();
  for (const [license, packages] of Object.entries(byLicense)) {
    for (const entry of packages) result.set(entry.name, { license, versions: entry.versions });
  }
  return result;
}

const components: Component[] = [];
{
  const production = pnpmLicenses(true);
  for (const [name, entry] of pnpmLicenses(false)) {
    const usage = production.has(name) ? "execution" : "construction";
    components.push({ ecosystem: "typescript", name, version: entry.versions.join(", "), license: entry.license, category: classify(entry.license), usage });
  }
}

// --- Rust -----------------------------------------------------------------------------------------------------------------
interface CargoMetadata {
  packages: { id: string; name: string; version: string; license: string | null; license_file: string | null; source: string | null }[];
  workspace_members: string[];
  resolve: { nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
}
{
  const output = execSync(`cargo metadata --offline --format-version 1 --filter-platform ${target}`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const metadata = JSON.parse(output) as CargoMetadata;
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const reach = (kinds: ReadonlySet<string | null>): Set<string> => {
    const seen = new Set<string>(metadata.workspace_members);
    const stack = [...metadata.workspace_members];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined) break;
      for (const dependency of nodes.get(id)?.deps ?? []) {
        // Les dependances de developpement ne comptent que pour les membres de l'espace de travail ; ensuite seules `normal`/`build`.
        const wanted = dependency.dep_kinds.some((kind) => kinds.has(kind.kind));
        if (wanted && !seen.has(dependency.pkg)) {
          seen.add(dependency.pkg);
          stack.push(dependency.pkg);
        }
      }
    }
    return seen;
  };
  const runtime = reach(new Set([null]));
  const everything = reach(new Set([null, "build", "dev"]));
  const members = new Set(metadata.workspace_members);
  for (const pkg of metadata.packages) {
    if (members.has(pkg.id) || !everything.has(pkg.id)) continue;
    const license = pkg.license ?? (pkg.license_file === null ? "" : `(fichier ${pkg.license_file})`);
    components.push({
      ecosystem: "rust",
      name: pkg.name,
      version: pkg.version,
      license: license === "" ? "(aucune)" : license,
      category: classify(pkg.license),
      usage: runtime.has(pkg.id) ? "execution" : "construction",
    });
  }
}

// --- Sortie ---------------------------------------------------------------------------------------------------------------
if (asMarkdown) {
  const runtime = components.filter((component) => component.usage === "execution").sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  console.log("| Composant | Version | Licence | Écosystème | Catégorie |\n|---|---|---|---|---|");
  for (const component of runtime) console.log(`| ${component.name} | ${component.version} | ${component.license} | ${component.ecosystem} | ${component.category} |`);
  process.exit(0);
}
const categories: Category[] = ["permissive", "copyleft-faible", "copyleft-fort", "a-examiner"];
if (asJson) {
  console.log(JSON.stringify(components, null, 2));
  process.exit(0);
}
for (const ecosystem of ["typescript", "rust"] as const) {
  for (const usage of ["execution", "construction"] as const) {
    const subset = components.filter((component) => component.ecosystem === ecosystem && component.usage === usage);
    const counts = categories.map((category) => `${category} ${subset.filter((component) => component.category === category).length}`).join(" | ");
    console.log(`${ecosystem} / ${usage} : ${subset.length} composants | ${counts}`);
  }
}
const byLicense = new Map<string, number>();
for (const component of components.filter((candidate) => candidate.usage === "execution")) byLicense.set(component.license, (byLicense.get(component.license) ?? 0) + 1);
console.log("\nLicences des composants livres avec l'application (execution) :");
for (const [license, count] of [...byLicense].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${license}`);
const flagged = components.filter((component) => component.category !== "permissive");
console.log(`\nA examiner (${flagged.length}) : tout ce qui n'est pas clairement permissif`);
for (const component of flagged.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))) {
  console.log(`  [${component.category}] ${component.ecosystem}/${component.usage} ${component.name}@${component.version} : ${component.license}`);
}
if (listAll) {
  console.log("\nTous les composants d'execution :");
  for (const component of components.filter((candidate) => candidate.usage === "execution").sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${component.ecosystem} ${component.name}@${component.version} : ${component.license}`);
  }
}
