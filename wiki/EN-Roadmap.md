# Roadmap

*🇫🇷 [Version française](FR-Feuille-de-route)*

The project is built in **vertical slices** (code + tests + documentation), in a fixed order **M0 → M9**. No durations are estimated on purpose. The live, evidence-backed record is [`docs/STATUS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/STATUS.md); the executable plan is [`docs/ROADMAP.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/ROADMAP.md). As of **2026-11-15**:

| Milestone | Theme | State | What is left |
|---|---|---|---|
| **M0** | Foundations: monorepo, Tauri app, lexer/parser measured on real scripts | ✅ Verified | — (the CI now runs on GitHub and is green on `master`) |
| **M1** | Desktop IDE: explorer, tabs, Monaco, safe saving, recovery, FR/EN, themes | ✅ Verified (Windows) | Linux end-to-end; change encoding from the status bar |
| **M2** | Language engine: scopes, references, workspace index, semantic diagnostics | ✅ Verified (Windows) | Hercules unverified |
| **M3** | IntelliSense: navigation, completion, hover, signature help, safe rename, commands, templates | ✅ Verified (Windows, rAthena) | Hercules; argument completion by other kinds |
| **M4** | Emulators and databases: rAthena adapter, items/monsters/maps/constants, project report, map and load-order rules | 🔶 In progress (M4-S1 to S3d verified) | Hercules adapter; `RC0001`–`RC0003` (cross-profile compatibility); more argument kinds (skills, quests, item groups) |
| **M5** | Release V1: startup budget, accessibility audit, docs, diagnostic log, signed updates (Windows + Linux) | 🔶 In progress | An update installed from a real release (needs a second release); installer; code signing; Linux window and packages; screen-reader test; dependency audits |
| **M6** | Wizards and server: wizards, read-only Git, local deployment | 🔶 In progress | More wizards (buffer, quest); SFTP upload and validation on a test server |
| **M7** | Visual studio: dialogue blocks, node builder, JSON extensions | 🔶 In progress | Re-read an existing script as an editable graph; `select`/`menu` with several outputs, `goto`, loops; undo/redo in the dialog |
| **M8** | Simulation and AI | 🔶 In progress | Event triggering (`OnTimer`, `OnTouch`, `donpcevent`); verification with real AI providers; independent review of the network surface |
| **M9** | Advanced studio | 🔶 In progress | Persistent extensions and permission management; a truly isolated test server; dependency audit |

## Recently delivered

- The **first public pre-release, 0.1.0-beta.1**: a Windows `.exe` and a Linux binary with a signed update manifest, and the production update-signing key.
- A dialogue simulator that **never stops on an error**, runs functions from other project files, and picks the test character's class by name.
- A node-graph NPC builder.
- Signed in-app updates from GitHub releases, for Windows and Linux.
- Function load-order checking (`RA0016`), map-loading checks (`RA0015`) and reserved-label checks (`RA0014`).
- A Linux build path (`pnpm build:linux`) with an AppImage.

## What would help most

- **Testing on a Linux desktop** and reporting what the window really does.
- **A Hercules installation** to unblock an adapter.
- **Real-world rAthena forks**: false alarms and missed problems (use the *Diagnostic report* issue template).
- A **screen-reader** review of the interface.
- Translations and wording review for both interface languages.

See [Development](EN-Development) to get started.
