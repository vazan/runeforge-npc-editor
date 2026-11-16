# Compatibility and limitations

*🇫🇷 [Version française](FR-Compatibilite-et-Limites)*

This page says plainly what is **verified**, what is **assumed** and what is **unknown**. Nothing is embellished. Detailed sources: [`docs/COMPATIBILITY.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/COMPATIBILITY.md) and [`docs/KNOWN_LIMITATIONS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/KNOWN_LIMITATIONS.md) (French). Status as of **2026-11-15**.

## Emulators

| Family · profile | State | What RuneForge does |
|---|---|---|
| **rAthena · Renewal** | **Verified by reading** (the server was never executed) on one local fork; revision unknown | Offline command library, checks from your server's sources, load rules, databases, diagnostics `RA0001`–`RA0016` |
| **rAthena · Pre-renewal** | **Partial**: the logic (`Mode: Prerenewal` imports, `npc/pre-re/…`) is tested on authored fixtures | Same features, never confronted with a real pre-renewal server |
| **Hercules** | **Not supported** — no installation was available to verify | Nothing: no registry, catalogue, template or command alert. Only the lexer and parser apply, and their match with Hercules syntax is an **assumption**. The application says so instead of guessing |
| Custom fork / no server | Supported through your declarations | Project commands and constants (`commands.custom`, `constants.custom`); never reported as a "certain error" |

Diagnostics rely on **reading** the server, never running it, so they are "probable", not "certain". Unlocking Hercules needs a Hercules copy provided by you (or downloaded with your explicit consent); the method is the one used for rAthena: read the code, write independent oracles, mutate, compare against real scripts.

## Platforms

| Platform | State |
|---|---|
| **Windows 11** | Application fully verified: automated end-to-end run on the real executable (WebView2), accessibility audit, startup measured (UI rendered in 360–489 ms) |
| **Linux x86_64** | Builds; all TypeScript and Rust tests pass (Ubuntu 26.04 on WSL2); the executable was **launched for 20 seconds under WSLg** (it starts, nothing more). **Unverified**: WebKitGTK rendering, Monaco, input methods, keyboard, high-DPI, accessibility, an in-window update |
| Other distributions, ARM | Not tried. The binary links dynamically to GTK 3, WebKitGTK 4.1, libsoup 3, glibc and OpenSSL 3, so it will not start on a distribution lacking them or older than the build machine |
| macOS | Not supported |
| Distribution | Pre-release 0.1.0-beta.1: a raw Windows `.exe` and a raw Linux binary (glibc ≥ 2.39) on the Releases page. No installer, no `.deb`/`.rpm`, no code signing. An AppImage can be built (needs glibc ≥ 2.43 when built on Ubuntu 26.04) |
| WebView2 / Windows 10 | Windows 11 is the tested system; Windows 10 is offered in bug templates but not a verified target |

## Features and their maturity

| Area | State |
|---|---|
| Safe editor, encodings, recovery | **Verified** (Windows) |
| Syntax and local semantic diagnostics, navigation, rename | **Verified** (Windows) |
| rAthena command, item, monster, map and constant checks | **Verified** (Windows, Renewal) |
| Project report | **Verified**; a snapshot of indexed files, copy-only export |
| NPC templates and wizards | **Verified statically**; no generated script was loaded by a running server |
| Git panel (read-only) | **Verified** (Windows) |
| Local deployment with backup and restore | **Verified** (Windows) |
| Visual dialogue editor, node builder | **Partial**: create new NPCs, edit dialogue blocks; cannot re-read an existing script as a graph |
| Dialogue simulation | **Partial**: a local preview, not a server |
| AI assistance | **Partial**: tested with a simulated provider only; no real provider verified |
| SFTP | **Early**: read-only comparison; no upload |
| Signed updates | **Implemented and tested against a fake GitHub**; the production key and a first signed release exist, but no update has been installed from a real release yet |
| Extensions | **Static JSON manifests only**, temporary; no code, no permissions |

## Language engine limits

- Rules reproduce the **local rAthena server's** behaviour; differences in other revisions or forks are unknown.
- **No diagnostic does not mean the script loads**: only a run on your server settles it.
- Operator precedence follows C conventions and is not confronted with every server subtlety.
- Non-ASCII characters outside strings and comments become `Unknown` tokens; unknown declaration types are kept as raw declarations and their `{…}` body is not analysed.
- Context for completion is deduced from the line and the two before it, not from the full syntax tree; an instruction spread over more than a couple of lines may not be recognised.
- Only **literal** numbers and strings are checked against the item, monster and map databases (not variables or expressions); an unknown constant is **not** reported.
- Argument *count* is checked for commands; argument *types* are not.
- `callfunc "Name"` calls with a literal string are tracked; bare-name calls and dynamic strings are partly or not tracked; event references by string (`donpcevent`, `addtimer`, `doevent`) are not.
- The index is in memory (no persistence) and is rebuilt on every project open; there is no continuous disk watching.

## Other limits

- Explorer: no rename, move or delete of files.
- Editor: one group, no tab drag-and-drop, encoding switch not in the status bar.
- Accessibility: automated audit only (names, contrast of text, keyboard, dialogs). **No screen-reader test** (NVDA, Narrator), no non-text contrast, 200 % zoom, forced-colors or IME audit. See [`docs/ACCESSIBILITY.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/ACCESSIBILITY.md).
- The simulator plays only a click on the NPC (plus `OnInit`); timers and touch events are not triggered. Quests are modelled by state only; the test character has no party, guild, mount or equipment.
- Performance numbers come from **one machine**; a modest machine and Linux were not measured.

## What "BLOCKED_EXTERNAL" means in the project documents

Work that depends on a third party and cannot be done by the code alone: a Hercules installation, a Windows/Linux code-signing certificate, a production update-signing key, an independent legal and security review, a Linux desktop to test on, network access for dependency audits.
