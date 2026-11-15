// Construit l'executable de test (feature `e2e`, dossier de build separe) puis lance le scenario E2E Windows.
// Usage : pnpm e2e [--skip-build]
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const targetDir = join(root, "target", "e2e");
const exe = join(targetDir, "release", "runeforge-studio.exe");
const outDir = join(root, "target", "e2e-artifacts");

if (process.platform !== "win32") {
  console.error("Le scenario E2E utilise WebView2 (Windows). Sous Linux, voir docs/DEV_SETUP.md (tauri-driver, non teste).");
  process.exit(2);
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!process.argv.includes("--skip-build")) {
  run("pnpm", ["--filter", "@runeforge/desktop", "tauri", "build", "--no-bundle", "--features", "e2e"], { CARGO_TARGET_DIR: targetDir });
}
run("pnpm", ["exec", "tsx", "scripts/e2e/run.ts", `"${exe}"`, `"${outDir}"`]);
// Mises a jour signees (DEC-046) : faux serveur GitHub local, executable copie puis remplace.
run("pnpm", ["exec", "tsx", "scripts/e2e/update.ts", `"${exe}"`, `"${outDir}"`]);
