# Development

*🇫🇷 [Version française](FR-Developpement)*

How to build, test and contribute. The canonical, always-current setup notes are in [`docs/DEV_SETUP.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/DEV_SETUP.md) (French); this page is the English walkthrough.

## Prerequisites

| Tool | Tested version | Notes |
|---|---|---|
| Node.js | 22.15 (≥ 22 required) | |
| pnpm | 10.33 | `corepack enable`, then `corepack prepare pnpm@10.33.0 --activate` |
| Rust | 1.93 stable | via [rustup](https://rustup.rs) |
| Windows | Visual Studio Build Tools ("Desktop development with C++") and WebView2 | Tested on Windows 11 |
| Linux (Ubuntu) | Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/) | Built and tested on Ubuntu 26.04 (WSL2) |

No NASM or CMake is needed.

**Linux packages (Ubuntu):**

```bash
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev \
  librsvg2-dev libayatana-appindicator3-dev libxdo-dev patchelf curl wget file
```

Under **WSL**, copy the sources to the Linux disk (`~/…`), never `/mnt/c`, and never share `node_modules` or `target/` between Windows and Linux.

## Everyday commands

```bash
pnpm install                                         # install and link the workspace
pnpm check                                           # typecheck + ESLint + Vitest
pnpm rust:check                                      # clippy -D warnings + cargo test (workspace)
pnpm check:all                                       # both of the above
pnpm build                                           # build the frontend
pnpm --filter @runeforge/desktop tauri dev           # run in development (Vite + native window)
pnpm --filter @runeforge/desktop tauri build --no-bundle   # executable in target/release/
pnpm build:linux                                     # from Windows: build the Linux ELF + AppImage inside WSL
pnpm e2e                                             # Windows only: end-to-end run on the real executable
```

> ⚠️ **Never run `npm install`** in this repository — the package manager is pnpm. A stray `npm install` adds an unrelated package and a `package-lock.json`, which breaks `pnpm install --frozen-lockfile` and CI.
>
> After **moving or renaming the project folder**, stale absolute paths remain in `target/` and in Vite's cache: run `cargo clean -p runeforge-filesystem -p runeforge-updater -p runeforge-studio -p runeforge-remote-transport -p runeforge-git` and delete `apps/desktop/node_modules/.vite`.

No installer or `.deb`/`.rpm` is produced. `pnpm build:linux` writes the raw ELF and an AppImage to `target/release/`; the AppImage bundler downloads and runs three tools on first use, so the script stops until you pass `--allow-download` (`--no-appimage` builds the ELF only). Details: [`docs/RELEASE.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/RELEASE.md).

## Tests and measurements

| Layer | How |
|---|---|
| TypeScript unit/property tests | `pnpm test` (Vitest); fixtures are authored for this project |
| Component tests | Vitest + Testing Library (jsdom) |
| Rust | `cargo test --workspace` |
| End-to-end (Windows) | `pnpm e2e` builds an `e2e` variant and drives the real executable through WebView2's debugging protocol; screenshots and completion latency go to `target/e2e-artifacts`. `pnpm e2e --skip-build` re-runs without rebuilding. Mouse- and completion-driven steps are timing-sensitive: re-run a failing step alone (`E2E_ONLY="<name fragment>"`) on an idle machine before suspecting a regression |
| Accessibility audit | `pnpm exec tsx scripts/e2e/accessibility.ts <e2e-exe> [captures-dir]` |
| Real-server measurements | `scripts/*-report.ts` (parser, analysis, round-trip, registry, commands, catalogue, references, project report, maps, labels, load order, wizards, visual, simulation). They **read** a server folder and never write to it |

The `e2e` Cargo feature exposes a test hook and an embedded *test* update key. **It must never be in a distributed build** (`release:prepare` refuses such an executable).

## Conventions

- TypeScript `strict` with `noUncheckedIndexedAccess`; no `any` without justification.
- Internal packages are consumed as **TypeScript source** (no build step) — DEC-003.
- **Evidence-based**: a feature or rule is "verified" only with a command that was run and its result, recorded in `docs/STATUS.md`. Do not claim more than was measured.
- **Safety first**: no code path may write a user file without an explicit action; don't widen IPC permissions without declaring the command (a Rust test enforces this).
- **Minimal diffs.** Record non-obvious choices as a numbered entry in `docs/DECISIONS.md`.
- Update `CHANGELOG.md` and the relevant `docs/` page with the change.

## Where things are

See [Architecture](EN-Architecture) for the layout and the dependency graph.

## Contributing

The short version is in [`CONTRIBUTING.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/CONTRIBUTING.md); the pull-request checklist is in the repository's pull-request template.

1. Look at the open issues and the [Roadmap](EN-Roadmap). For anything sizeable, open an issue first to agree on the approach.
2. Branch from `master`, keep the change focused.
3. Run `pnpm check:all` (and `pnpm e2e` on Windows if you touched UI behaviour). Add or update tests — for a diagnostic rule, include a test that would fail if the rule were removed.
4. Open a pull request describing the **what and why** and the **evidence** (commands run).

Issue and bug-report guidance: [Troubleshooting and FAQ](EN-Troubleshooting-and-FAQ#reporting-a-bug). Security issues: [Privacy and security](EN-Privacy-and-Security#reporting-a-vulnerability).

## Editing this wiki

The wiki sources live in the **`wiki/` folder of the main repository**, so they are reviewed like code. GitHub wikis are a separate Git repository (`<repo>.wiki.git`) that exists once the wiki has been enabled and its first page created in the web interface. To publish:

```bash
git clone https://github.com/vazan/runeforge-npc-editor.wiki.git ../runeforge-npc-editor.wiki
cp wiki/*.md ../runeforge-npc-editor.wiki/
cd ../runeforge-npc-editor.wiki && git add -A && git commit -m "Sync wiki from main repository" && git push
```

Conventions: each page exists in English (`EN-…`) and French (`FR-…`) and links to its twin on the first line; internal links omit the `.md` extension (GitHub wiki style); screenshots live in `docs/images/` and are referenced by `…/blob/HEAD/docs/images/<name>.png?raw=true`. When you change one language, change the other.

The screenshots come from the end-to-end scenario's artifacts (a small synthetic project); regenerate them with `pnpm e2e`.
