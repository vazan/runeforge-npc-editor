# Contributing to RuneForge Studio

Thanks for your interest! RuneForge Studio is a free (GPL-3.0-only) desktop IDE for rAthena NPC scripts. Bug reports from real servers are especially valuable, because the diagnostics are only as good as the servers they were checked against.

*En français : voir [Développement](https://github.com/vazan/runeforge-npc-editor/wiki/FR-Developpement). Issues and pull requests in **English or French** are both welcome.*

## Ways to help

| You want to… | Do this |
|---|---|
| Report a bug | [Bug report](https://github.com/vazan/runeforge-npc-editor/issues/new/choose). Tell us if any of your files was changed or lost: that is the highest-priority kind of bug |
| Report a wrong diagnostic | [Diagnostic report](https://github.com/vazan/runeforge-npc-editor/issues/new/choose): a false alarm or a missed problem, with what **your real server** did with the script |
| Suggest a feature | [Feature request](https://github.com/vazan/runeforge-npc-editor/issues/new/choose): describe the scripting problem before the solution |
| Ask a question | Check the [FAQ](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Troubleshooting-and-FAQ), then open a *Question* issue |
| Fix the docs or translations | Edit `wiki/` (EN and FR), `docs/` or the README and open a pull request |
| Test on Linux or with another fork | Tell us what you see: the Linux window and Hercules are the least verified areas |
| Report a vulnerability | **Not** in a public issue: see [SECURITY.md](SECURITY.md) |

**Never paste secrets** (API keys, tokens, SSH keys, signing keys, passwords) in an issue, and share only a minimal, anonymised script excerpt, never a whole server.

## Before you write code

1. For anything sizeable, **open an issue first** so we can agree on the approach before you invest time.
2. Read the [Architecture](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Architecture) and [Development](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Development) pages, and the [known limitations](docs/KNOWN_LIMITATIONS.md) (some things are deliberately out of scope).

## Setting up

Requirements: Node.js ≥ 22, pnpm 10 (`corepack enable`), Rust stable; on Windows the Visual Studio C++ build tools and WebView2; on Linux the WebKitGTK 4.1, GTK 3 and OpenSSL development packages. Details: [`docs/DEV_SETUP.md`](docs/DEV_SETUP.md).

```bash
pnpm install                                         # use pnpm, never npm
pnpm check                                           # types + ESLint + TypeScript tests
pnpm rust:check                                      # clippy -D warnings + Rust tests
pnpm check:all                                       # both
pnpm --filter @runeforge/desktop tauri dev           # run the application
pnpm e2e                                             # Windows only: end-to-end run on the real executable
```

## Principles

These recur throughout the code and the decision log ([`docs/DECISIONS.md`](docs/DECISIONS.md)). Changes that go against them will be sent back.

- **Source text is sacred.** No code path may write a user's file without an explicit action, and saving must preserve bytes, encodings and line endings.
- **Evidence before claims.** Something is "verified" only with a command that was run and its result. Rules are proven in the server's own code and checked against independent oracles. Do not write documentation that claims more than was measured.
- **Silence over invention.** Without proof (no server registry, Hercules), say nothing rather than guess.
- **Least privilege.** Native commands are explicit; the web page gets no generic file or shell permission and never sees an absolute path.
- **Nothing without consent.** Network, Git and SFTP happen only on an explicit user action. No telemetry.
- **Minimal diffs.** Keep a change focused. Record non-obvious decisions as a numbered entry in `docs/DECISIONS.md`.

## Pull requests

1. Branch from `master`.
2. Run `pnpm check:all` (and `pnpm e2e` on Windows if you touched UI behaviour).
3. Add or update tests. For a diagnostic rule, include a test that **fails if the rule is removed**.
4. Update the documentation that your change makes wrong: `docs/`, the wiki (**English and French**: change both), and `CHANGELOG.md`.
5. Open the pull request and fill in the template: what and why, and the evidence you ran.

Commit messages: a short imperative summary; the usual prefixes (`feat:`, `fix:`, `docs:`) are welcome but not enforced.

## Licensing of contributions

The project is **GPL-3.0-only**. Contribute only code and data you have the right to license that way, and never paste proprietary or private server content into issues, fixtures or screenshots. rAthena-derived data is already documented in [`docs/LEGAL.md`](docs/LEGAL.md).

## Be kind

Be respectful and assume good faith: this is a small project, and reviews are done in people's free time. Discrimination, harassment and personal attacks are not welcome and may lead to comments being removed or people being blocked. A formal code of conduct has not been adopted yet.
