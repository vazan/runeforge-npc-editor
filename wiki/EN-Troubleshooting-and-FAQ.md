# Troubleshooting and FAQ

*🇫🇷 [Version française](FR-Depannage-et-FAQ)*

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| **No command is offered** while typing | No rAthena server was recognised. Look at the status bar and **Settings › Project**; pick the server folder. Without a server you still get the offline command library, but server-specific checks stay silent |
| **Too many `RA0001` ("unknown command")** | Your fork has commands the local server table does not know. Declare them (`Ctrl+.` on the alert, or Settings › Project), or lower/turn off that alert level |
| A function is reported unknown although it exists | It is defined in a file outside the index (`sources` pattern too narrow, or an exclusion). Check Settings › Project; widen `sources`, or use the "loaded" scope if the file really is loaded by the server |
| **Many duplicate NPC names (`RA0005`)** | The index mixes exclusive variants (`re/` and `pre-re/`). Use the index scope **"Scripts loaded by the server"** |
| The Project report shows few files | By default it only lists scripts the server loads. Untick the box to show everything (the report recomputes) |
| A file's accents look wrong | Check the encoding in the status bar. Non-UTF-8 files are assumed `windows-1252` (configurable per project). Displayed text may be off, but **the bytes are preserved** |
| `RA0016` on a function you "call by name" | The server only knows a function after its definition is loaded. Load the defining file earlier in `scripts_*.conf`, define the function higher up in the file, or call it with `callfunc "Name"` |
| A script is "valid" in RuneForge but not loaded by the server | A local analysis is not a server run. Also make sure a `scripts_*.conf` file **lists** the script — RuneForge never edits those lists |
| Save was blocked | A character cannot be represented in the file's encoding. RuneForge refuses to replace it silently; change or remove the character |
| "This folder has no RuneForge configuration yet" | Informational. Choose *Create configuration* only if you want a `.runeforge/project.json` |
| **The Git panel asks you to enable Git** | Git is refused until you allow it for that project (confirmation box). Accept only for repositories you trust |
| "This build cannot verify updates" | Expected today: no production signing key or real release exists yet. See [Updates](EN-Updates) |
| End-to-end tests fail once on a busy machine | Some steps that drive the mouse or the completion list are timing-sensitive. Re-run the failing step alone on an idle machine before concluding it is a regression |
| Linux: window does not open | Install `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libssl3`; a build from a newer glibc will not start on an older distribution. For a quick try under WSL: `GDK_BACKEND=x11 ./runeforge-studio` |

## FAQ

**Is RuneForge Studio official or affiliated with Gravity?**
No. It is an **unofficial** tool. "Ragnarok Online" and "Gravity" are trademarks of their owners. No game asset (sprite, map, music, brand) is included.

**Does it run my server or my scripts?**
Never. It reads script text and your server's files. A local analysis is *not* a run of the server; only the server confirms real behaviour.

**Will it modify or corrupt my scripts?**
It is designed so that it cannot do so silently: no write without your action, byte-exact preservation of encodings, BOMs and line endings, atomic writes, conflict detection, crash recovery. If you ever see otherwise, that is the **highest-priority** kind of bug — please report it.

**Which emulators are supported?**
**rAthena** (Renewal verified; pre-renewal logic tested on fixtures). **Hercules is not supported yet**: for a Hercules project only the lexer and parser apply, and RuneForge says "no registry" rather than guessing.

**Which platforms?**
Windows 11 is fully verified. Linux x86_64 builds and passes all tests but its window has hardly been tested. macOS is not supported.

**Is there an installer or a download?**
Not yet. Build from source ([Development](EN-Development)). No release has been published.

**Why is it called "RuneForge Studio"?**
It is a working name; a trademark search has not been done.

**What license is it under?**
GPL-3.0-only. See [License](EN-License).

**Can I use it on a server fork?**
Yes. RuneForge reads the fork's own files. Differences it cannot read (a changed parser, new commands) can be declared in Settings › Project.

**Is the AI feature required?**
No. It is optional, off until you configure an endpoint, and asks for consent before every send.

**Is the interface translated?**
English and French, switchable in Settings. Some content stays English by design (class names, generated NPC text).

**How do I follow progress?**
See the [Roadmap](EN-Roadmap) and the repository's [`CHANGELOG.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/CHANGELOG.md).

## Reporting a bug

Open an issue with the templates: [new issue](https://github.com/vazan/runeforge-npc-editor/issues/new/choose). Issues in **English or French** are welcome.

- **Bug report** — includes a mandatory question on whether any of your files were changed or lost.
- **Diagnostic report** — for a false alarm, a missed problem or wrong command documentation. Please include what you observed on a real server (RuneForge never runs it).
- **Feature request** — describe the need before the solution.

Useful, safe things to attach: the version (Settings › About), your OS, whether it is a Windows `.exe`, a Linux binary, an AppImage or a source build, the emulator shown in the status bar, a **minimal anonymised** script sample (with encoding, BOM and line endings for file-handling bugs), the **Project report copied as text** (it never contains your script contents) and the diagnostic log if you enabled it.

**Never paste** API keys, tokens, SSH keys, signing keys (`*.key`) or passwords. **Security vulnerabilities do not belong in public issues** — see [Privacy and security](EN-Privacy-and-Security#reporting-a-vulnerability).
