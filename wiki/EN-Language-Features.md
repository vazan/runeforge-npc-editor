# Language features

*🇫🇷 [Version française](FR-Fonctions-du-Langage)*

RuneForge understands the **rAthena script language** (NPC scripts, functions, warps, shops, monsters, mapflags). This page lists what the editor offers while you type.

> The parser is *tolerant* and *lossless*: any text — even broken — produces a tree and diagnostics, never an exception, and the original text is never regenerated from the tree. It was run over ~2,300 real scripts with 0 crashes and 0 lost characters.

## Shortcuts

| Feature | Shortcut |
|---|---|
| Complete (commands, labels, functions, NPCs, variables, items, monsters, maps, constants) | `Ctrl+Space` |
| Signature help (highlights the current parameter) | `Ctrl+Shift+Space` |
| Hover: documentation, signature, origin | mouse |
| Go to definition | `F12` or `Ctrl+click` |
| Find all references | `Shift+F12` |
| Rename (labels and local variables, only where safe) | `F2` |
| Go to a project symbol (global function, NPC) | `Ctrl+T` |
| Document outline | `Ctrl+Shift+O` |
| Go to file | `Ctrl+P` |
| Quick action (e.g. declare a command of your fork) | `Ctrl+.` |
| Search the server databases and insert | `Ctrl+Shift+D` |
| Problems panel | `Ctrl+J` |
| Project report | `Ctrl+Shift+M` |
| Command palette | `Ctrl+Shift+P` |

## What is proposed and documented

| Kind | Needs a recognised rAthena server? |
|---|---|
| Labels, local and global functions, NPC names, variables of your project | No |
| **Commands** with signature, argument count and manual excerpt | No for the bundled offline library; yes for server-specific checks |
| **Items, monsters, maps, constants** of your server | Yes (read from your files) |
| NPC **templates** | rAthena only |

- **Offline command library**: 667 rAthena commands with signatures and help text are bundled, so completion and hover work even without a server folder. The help text comes from rAthena's `script_commands.txt` (GPL-3.0).
- At an argument position that expects an item or a monster, completion writes the **identifier**; in the databases palette, `Shift+Enter` inserts the **quoted name** instead.
- Completion lists are capped (for example 200 references) and refine as you keep typing.

## Rename (`F2`)

Rename only changes what it can prove is safe: **labels**, **local functions** and **local variables** (`.@x`, `.x`) of one script, with every occurrence known for certain. It refuses — and explains why — for global functions and NPC names (other files may reference them, sometimes by string), global variables, `On…` event labels, scripts that failed to parse completely, and invalid or already-used names. Checked on 841 real scripts: 1,002 renames applied, **0 new diagnostics**.

## NPC templates

In an empty file (or at the start of a line, outside a script) type `npc-` and press Enter:

| Template | Produces |
|---|---|
| `npc-script` | An NPC with a short dialogue |
| `npc-warp` | A warp portal |
| `npc-shop` | A shop with two items |
| `npc-healer` | A healer NPC with a menu |

`Tab` moves from field to field. Default values (map, coordinates, sprite, items) are **examples to replace**. Templates analyse without any diagnostic and their commands are checked against a real server's command table, but none has been loaded by a running server.

For guided forms, see [NPC tools](EN-NPC-Tools).

## Declaring your fork's commands

If your server fork adds commands, an `RA0001` ("unknown command") warning will appear. Press `Ctrl+.` on it to **declare the command** in `.runeforge/project.json` (never in a server file), or add it by hand in **Settings › Project**. You can also lower or turn off those alerts there. See [Server integration](EN-Server-Integration).

## Navigation scope

- **Definition** (`F12`) offers a single target (an editor limitation); duplicates are reported by the diagnostics instead.
- **References** cover labels, functions called with a literal `callfunc "Name"`, NPC names used in `duplicate(...)`, local variables, and global variables of the current file. References by dynamic string (`donpcevent`, `addtimer`…) are not tracked.
- **Project symbol search** (`Ctrl+T`) lists global functions and NPC names (100 results at most).
- The index lives in memory and is rebuilt each time a project opens: about 1.2 s for 841 files, about 7 s for 5,000 files, in the background.

## Measured responsiveness

On one reference machine (Ryzen 7, Windows 11), completion lists appear in roughly 11–16 ms in the real application (the language service itself answers in 0.1–0.8 ms). These are measurements, not guarantees; see [`docs/PERFORMANCE.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/PERFORMANCE.md).
