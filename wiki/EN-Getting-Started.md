# Getting started

*🇫🇷 [Version française](FR-Premiers-Pas)*

RuneForge Studio is a **pre-release** (version 0.1.0-beta.1). A first [pre-release is published on the Releases page](https://github.com/vazan/runeforge-npc-editor/releases) for Windows and Linux; there is no installer, and you can also build it yourself from source.

## 1. Requirements

| | Windows | Linux |
|---|---|---|
| Verified level | **Full**: the real application is driven by an automated end-to-end run on Windows 11 | **Builds and tests pass** on Ubuntu 26.04 (WSL2, x86_64). The window was only started for 20 seconds; no UI test exists |
| Runtime | Microsoft **WebView2** (ships with Windows 11) | `libwebkit2gtk-4.1`, `libgtk-3`, `libssl3` from your distribution |
| Git (optional) | Only for the Git panel | Only for the Git panel |
| macOS | Not supported | — |

An AppImage can be built for Linux (`pnpm build:linux`) but needs a glibc as recent as the machine that built it, and has only been launched for 20 seconds. See [Compatibility and limitations](EN-Compatibility-and-Limitations).

## 2. Get the application

**Easiest: download a pre-release.** From the [Releases page](https://github.com/vazan/runeforge-npc-editor/releases), take the file for your system: `runeforge-studio-<version>-windows-x86_64.exe`, or `runeforge-studio-<version>-linux-x86_64` (it needs glibc 2.39 or newer; run `chmod +x` on it first). There is no installer: just run it. The Windows executable is not code-signed, so SmartScreen may warn on first launch.

**Or build it from source** — the full procedure is in [Development](EN-Development). The short version:

```bash
pnpm install
pnpm --filter @runeforge/desktop tauri build --no-bundle
```

The executable appears in `target/release/` (`runeforge-studio.exe` on Windows, `runeforge-studio` on Linux). On Linux, make it executable first: `chmod +x runeforge-studio`.

To try it without building a release binary: `pnpm --filter @runeforge/desktop tauri dev`.

## 3. First launch

1. The welcome screen offers **Open project folder…** and lists recent projects.
2. Pick the folder that holds your scripts — typically the **root of your rAthena server**, or its `npc/` folder.
3. RuneForge **changes nothing when it opens a project**. It reads the files, builds an index in the background, and the status bar shows the recognised server and the indexing progress.
4. Set the language (French, English or system) and theme (light, dark or system) in **Settings** (`Ctrl+,`).

## 4. Your first five minutes

| Do this | To see this |
|---|---|
| Open a script from the explorer (or `Ctrl+P`) | Syntax colouring and underlined problems |
| Press `Ctrl+J` | The **Problems** panel: what, where, why, how to fix |
| Press `Ctrl+Shift+M` | The **Project report**: problems across every indexed file |
| Put the cursor on a `callfunc "F_Name"` and press `F12` | Jump to the function's definition |
| In an empty file type `npc-` and press Enter | An NPC template (`npc-script`, `npc-warp`, `npc-shop`, `npc-healer`) |
| **File › NPC wizard…** | A form that generates a warp, warper, shop or healer script live |
| `Ctrl+Shift+D` | Search the server's items, monsters, maps and constants and insert one |

Nothing is written to disk until you press `Ctrl+S`.

## Next steps

- [Editor and safe saving](EN-Editor-and-Safe-Saving) — what "your files are safe" actually means.
- [Server integration](EN-Server-Integration) — make the checks specific to *your* server.
- [Language features](EN-Language-Features) — completion, hover, rename, shortcuts.
- Something odd? [Troubleshooting and FAQ](EN-Troubleshooting-and-FAQ).
