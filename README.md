<div align="center">

# RuneForge Studio

**A desktop IDE for writing and checking [rAthena](https://github.com/rathena/rathena) NPC scripts.**

[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)
[![CI](https://github.com/vazan/runeforge-npc-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/vazan/runeforge-npc-editor/actions/workflows/ci.yml)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-lightgrey)
![Status](https://img.shields.io/badge/status-pre--release-yellow)

[Wiki](https://github.com/vazan/runeforge-npc-editor/wiki) ·
[Getting started](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Getting-Started) ·
[Changelog](CHANGELOG.md) ·
[Français](README.fr.md)

<img src="docs/images/editor-diagnostics.png" alt="RuneForge Studio showing an NPC script with underlined problems and the Problems panel" width="860">

</div>

RuneForge Studio opens your rAthena server folder, understands your scripts, and tells you what the server would complain about — **without ever running the server, and without touching your files unless you save.**

> **Pre-release (0.1.0-beta.1).** [Download it from the Releases page](https://github.com/vazan/runeforge-npc-editor/releases) (a Windows `.exe` and a Linux binary, no installer) or build it from source. Windows 11 is fully verified; on Linux it builds and passes its tests but the window has barely been exercised. rAthena only — Hercules is not supported yet. [What is and isn't verified →](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Compatibility-and-Limitations)

## Highlights

- **Your files are safe.** Nothing is written unless you save; encodings, BOMs and line endings are preserved (byte-for-byte round trip on 2,303 real scripts); a changed file is never overwritten silently; unsaved work survives a crash.
- **It understands rAthena.** Completion, hover, go to definition, rename and diagnostics, checked against *your* server's commands, items, monsters, maps and load order.
- **Faster NPCs.** Templates, wizards, a visual dialogue editor, a node-graph builder and a local dialogue simulator.
- **Private by default.** No telemetry; the network is used only when you ask (updates, optional AI, SFTP preview).

More: [diagnostics](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Diagnostics) · [NPC tools](https://github.com/vazan/runeforge-npc-editor/wiki/EN-NPC-Tools) · [Git and deployment](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Git-and-Deployment).

## Quick start

Requires Node.js ≥ 22, pnpm 10 and Rust (stable), plus [platform tools](docs/DEV_SETUP.md): Visual Studio C++ build tools and WebView2 on Windows, WebKitGTK 4.1 / GTK 3 / OpenSSL packages on Linux.

```bash
git clone https://github.com/vazan/runeforge-npc-editor.git
cd runeforge-npc-editor
pnpm install                                         # use pnpm, not npm
pnpm --filter @runeforge/desktop tauri dev           # run it
pnpm --filter @runeforge/desktop tauri build --no-bundle   # or build target/release/runeforge-studio
```

Then **Open project folder…** and pick your rAthena server (or its `npc/` folder). Nothing is modified when a project opens.

## Documentation

- **[Wiki](https://github.com/vazan/runeforge-npc-editor/wiki)** (English and Français): user guide, diagnostics reference, server integration, architecture, development.
- **[`docs/`](docs/)** (mostly French): the evidence-backed project record — [status](docs/STATUS.md), [known limitations](docs/KNOWN_LIMITATIONS.md), [security model](docs/SECURITY.md), [design decisions](docs/DECISIONS.md).

## Contributing

Contributions are welcome — reports from real servers especially. Please read [CONTRIBUTING.md](CONTRIBUTING.md), and use the [issue forms](https://github.com/vazan/runeforge-npc-editor/issues/new/choose) (English or French). Found a vulnerability? See [SECURITY.md](SECURITY.md); do not open a public issue.

## License

[GPL-3.0-only](LICENSE). It bundles command signatures and help text derived from [rAthena](https://github.com/rathena/rathena) (GPL-3.0); no rAthena server code or database is embedded. Third-party notices: [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md). Built with [Tauri](https://tauri.app), [React](https://react.dev) and the [Monaco editor](https://github.com/microsoft/monaco-editor).

*RuneForge Studio is an unofficial tool, not affiliated with Gravity. "Ragnarok Online" and "Gravity" are trademarks of their owners; "RuneForge Studio" is a working name.*
