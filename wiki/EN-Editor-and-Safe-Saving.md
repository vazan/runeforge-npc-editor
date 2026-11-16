# Editor and safe saving

*🇫🇷 [Version française](FR-Editeur-et-Enregistrement-Sur)*

Your script source is treated as sacred. This page describes the workspace and the guarantees around your files. Every guarantee below is backed by a test or a measurement recorded in the repository (see [`docs/STATUS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/STATUS.md)).

## The workspace

![The editor with diagnostics, the explorer and the Problems panel](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/images/editor-diagnostics.png?raw=true)

| Area | What it does |
|---|---|
| **Explorer** (left) | Project tree. Arrow keys to move, Enter to open. Filter box on top. Create empty files; no rename, move or delete (a deliberate choice) |
| **Tabs + editor** (centre) | The Monaco editor (the engine of VS Code) with RuneScript colouring |
| **Bottom panel** | **Problems**, **References**, **Project report**, **Git** |
| **Status bar** | Recognised server and mode, number of known commands, indexing progress, error and warning counts, cursor, encoding, line ending, saved state |

Menus: **File**, **View**, **Go**, **Help**. Everything is also reachable from the **command palette** (`Ctrl+Shift+P`).

## What happens when you save

| Situation | Behaviour |
|---|---|
| Open a file and save it **without changes** | **Nothing is written** |
| Save after editing | **Only the changed bytes** differ from the original |
| The file uses a legacy encoding (e.g. windows-1252, Shift_JIS), has a BOM, or uses CRLF, LF or **mixed** line endings | All **preserved** |
| You type a character the file's encoding cannot represent | The save is **blocked**; the character is never silently replaced |
| The file was changed by another program | If you have not edited it here, it reloads when you return to the window. Otherwise you are offered **compare, reload or overwrite** — never a silent overwrite |
| The application or the machine crashes | Unsaved changes are kept as **recovery snapshots** and offered back at the next start |

How this was verified: opening and re-saving **2,303 real scripts** reproduced every file byte for byte, including 58 files in a legacy encoding and 4 with mixed line endings.

Under the hood, writes are atomic (temporary file, then replace) and conditional: RuneForge refuses to overwrite a file whose fingerprint changed since it was read.

## Local history and comparison

- **Compare with saved version** shows your unsaved edits against disk.
- **Show local history** lists earlier local snapshots in the comparison view (they cannot yet be restored in one click).
- If the project is a Git repository, see [Git and deployment](EN-Git-and-Deployment).

## Settings that affect editing

Open with `Ctrl+,`. Tabs: **General**, **Editor** (font size, wrapping, whitespace, tab width), **Project** (see [Server integration](EN-Server-Integration)), **AI model**, **Privacy**, **Updates**, **About**.

A project can carry its own configuration in `.runeforge/project.json`. RuneForge writes that file **only when you ask** (for example by choosing "Create configuration" or a quick action).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open a folder |
| `Ctrl+N` | New file |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save all |
| `Ctrl+W` | Close the tab |
| `Ctrl+PageDown` / `Ctrl+PageUp` | Next / previous tab |
| `Ctrl+B` | Toggle the sidebar |
| `Ctrl+J` | Toggle the bottom panel |
| `Ctrl+,` | Settings |
| `Ctrl+P` | Go to file |
| `Ctrl+Shift+P` | Command palette |

Language shortcuts (completion, definition, rename…) are on [Language features](EN-Language-Features).

## Known limits

One editor group only; no drag-and-drop tab reordering; the encoding cannot yet be changed from the status bar (only via the "unsaveable characters" dialog); no continuous disk watching (the index resynchronises when the window regains focus, at most every 15 seconds). Full list: [`docs/KNOWN_LIMITATIONS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/KNOWN_LIMITATIONS.md).
