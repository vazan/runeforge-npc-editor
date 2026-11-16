# License

*🇫🇷 [Version française](FR-Licence)*

> This page summarises the project's licensing. It is an **inventory, not legal advice**. An independent legal review before any distribution or sale has **not** happened. Details: [`docs/LEGAL.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/LEGAL.md) (French).

## The product

RuneForge Studio is licensed under the **GNU General Public License, version 3 only (GPL-3.0-only)**. The full text is in [`LICENSE`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/LICENSE); the pnpm and Cargo manifests declare the same license.

The choice of GPL-3.0-only is an implementation decision that lets the project bundle material derived from rAthena (below). It is not a certification of compatibility.

## rAthena-derived content

- The **bundled offline command library** contains the signatures and help text of rAthena's `script_commands.txt` (credited to the rAthena Dev Team), generated from a local rAthena checkout and distributed under GPL-3.0-only with its provenance references.
- The table of **script-constant values** and the **job-class names** are generated from rAthena sources (`script_constants.hpp`, `pc.cpp`, `map_msg.conf`). They contain names and numbers, no server code lines, and are distributed under GPL-3.0-only.
- **No rAthena server code or database is embedded.** Your server's files are read at runtime from *your* project. The revision of the checkout used to generate the library is unknown.
- Test fixtures are authored for this project (original text, same file layout as the emulator).

## Dependencies

An offline inventory (`pnpm exec tsx scripts/licenses-report.ts`) classifies every dependency by SPDX expression. As of 2026-11-15:

- **No GPL, AGPL or LGPL dependency** and no unknown license among the shipped components.
- Five Rust crates under **MPL-2.0** (file-level copyleft) are linked through the Tauri stack — used unmodified; their notices and source locations must be kept.
- Everything else is permissive (MIT, Apache-2.0, BSD, Zlib, Unicode…).

Full lists: [`THIRD_PARTY_LICENSES.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/THIRD_PARTY_LICENSES.md) (Windows) and [`THIRD_PARTY_LICENSES_LINUX.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/THIRD_PARTY_LICENSES_LINUX.md).

Open points before distribution: a complete third-party notices bundle with license texts; confirming the license of Monaco's icon font (`codicon.ttf`) and shipping Monaco's `ThirdPartyNotices.txt`; reviewing the LGPL libraries redistributed inside an AppImage (WebKitGTK, GTK, libsoup).

## Trademarks and affiliation

- RuneForge Studio is an **unofficial tool, not affiliated with Gravity**. "Ragnarok Online" and "Gravity" belong to their respective owners. The notice is shown on the welcome screen and in *About*.
- **No Ragnarok Online asset** (sprites, maps, music, brand) is included. The current icon is an original placeholder.
- **"RuneForge Studio" is a working name**; a prior-art and trademark search has not been done.

## Contributing

The project is GPL-3.0-only, so contributed code and data must be compatible with that license. Do not contribute material you are not allowed to license that way, and do not paste proprietary or private server content into issues or test fixtures.
