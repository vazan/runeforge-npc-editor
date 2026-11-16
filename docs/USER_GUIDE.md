# User guide — RuneForge Studio

> *Version française : [`GUIDE_UTILISATEUR.md`](GUIDE_UTILISATEUR.md).* This guide describes what the application **actually** does today (Windows 11; for Linux, see § 1). What does not exist yet is listed under "Limits"; details are in
> [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) (in French). RuneForge Studio is an **unofficial tool, not affiliated with Gravity**.

## 1. Installation

There is no installer: the application is a single executable. Download `runeforge-studio-<version>-windows-x86_64.exe` (or the Linux file, see below) from the [Releases page](https://github.com/vazan/runeforge-npc-editor/releases) and run it — or build it with `pnpm --filter @runeforge/desktop tauri build --no-bundle` (folder `target/release/`). The Windows executable is not code-signed, so SmartScreen may warn on first launch. It needs Microsoft's **WebView2** runtime (shipped with Windows 11).
**Linux**: the `runeforge-studio` executable (no extension) builds and its tests pass (Ubuntu 26.04), but **the window has never been opened on Linux**: its display, keyboard and input are not verified. It needs `libwebkit2gtk-4.1`, `libgtk-3` and `libssl3` from your distribution; a file downloaded from GitHub is not executable: `chmod +x runeforge-studio-<version>-linux-x86_64`. See [`DEV_SETUP.md`](DEV_SETUP.md). Later versions install from inside the application (**Help › Updates…**, see § 12).

## 2. First launch

The welcome screen offers to **open a project folder** and lists recent projects. Pick the folder that holds your scripts — typically the root of your rAthena server, or its `npc/` folder. The application **changes nothing when it opens a project**.
Language (French, English or the system's) and theme (light, dark or the system's) are set in **Settings** (Ctrl+,).

## 3. The workspace

On the left, the **explorer** (arrow keys to move, Enter to open); in the middle, the **tabs** and the editor; at the bottom, the **Problems**, **References** and **Project report** panels; the **status bar** summarizes the recognized server and the indexing state.

- **Saving**: Ctrl+S (Ctrl+Shift+S for all). A file opened and saved **without changes is not rewritten**; otherwise only the modified bytes change. Legacy encodings (for example windows-1252), BOM and line endings (CRLF/LF, even mixed) are **preserved**.
  A character that cannot be represented in the file's encoding **blocks** the save instead of being replaced.
- **File changed elsewhere**: if it was not modified here it is reloaded when you return to the window; otherwise the application offers to **compare, reload or overwrite** — never a silent overwrite.
- **Crash**: your unsaved changes are kept in snapshots; the application offers them back on restart.

## 4. Your rAthena server

The application ships with an offline rAthena scripting library for command completion, hover help and signatures; it does not read `doc/script_commands.txt` at runtime. If the project contains a rAthena server, the application **recognizes** it (status bar) and reads **from your files** the command table (`src/map/script.cpp`) and custom definitions (`src/custom/script_def.inc`) for server-specific checks, plus the mode (renewal or pre-renewal), the loaded script lists
(`npc/…/scripts_main.conf`), the loaded maps (`conf/map_athena.conf`) and the databases (items, monsters, maps, constants, random options). Several servers in one project? Choose yours in **Settings › Project**. **Hercules is not supported** yet.

Settings › Project: server folder, mode, **index scope** (`sources`: the files your patterns select; `loaded`: only the scripts the server loads), alert level for unknown commands and unresolved references, and your fork's custom **commands** and **constants**.
These settings are saved in `.runeforge/project.json`, **only when you ask**.

## 5. Writing a script

| Feature | Shortcut |
|---|---|
| Complete (commands, labels, functions, NPCs, variables, items, monsters, maps, constants) | Ctrl+Space |
| Signature help (current parameter) | Ctrl+Shift+Space |
| Hover: documentation, signature, source | mouse |
| Go to definition | F12 (or Ctrl+click) |
| All references | Shift+F12 |
| Rename (labels and local variables, wherever it is safe) | F2 |
| Go to a project symbol (function, NPC) | Ctrl+T |
| Go to file | Ctrl+P |
| Quick action (e.g. declare a command of your fork) | Ctrl+. |
| Search the server databases (items, monsters, maps, constants) and insert | Ctrl+Shift+D |
| Command palette | Ctrl+Shift+P |

In an empty file, type **`npc-`** then Enter to insert an NPC **template** (`npc-script`, `npc-warp`, `npc-shop`, `npc-healer`); Tab moves from field to field. The templates are checked against your server's registry.

**NPC wizards** (menu **File › NPC wizard…**, or the command palette): one form per kind of NPC — **warp portal**, **warper NPC**, **shop**, **healer** (rAthena). Fill in the fields: the **script is generated live** on the right; every field tells you what is wrong (number, map name, sprite,
item list…) and **no script is generated while an error remains**; a warning (price of 0, absurd price, duplicate item) blocks nothing. A **local check** (the same analysis as the editor, indexing nothing) then reports the problems of the generated script. Three outputs, all explicit:
- **Copy** the script to the clipboard;
- **Add to the open file**: the script is added **at the end** of the displayed file, undoable with Ctrl+Z; it is written to disk only when you save (Ctrl+S);
- **Create the file**: creates a new file (the proposed name can be edited; an existing file is never overwritten) containing the script, to be saved with Ctrl+S.

A server only loads a script file that one of your `scripts_*.conf` files lists — the application never edits them. The proposed texts are in English without accents; the local analysis is not a run of the server.

## 6. Understanding diagnostics

Problems appear in the editor (underlines), in the **Problems** panel (Ctrl+J) and, for the whole project, in the **Project report** (Ctrl+Shift+M: per file, most serious first, click to open, copy as text for a ticket).
Each message says **what, where, why and how to fix**, with its confidence level. **A local analysis is not a run of the server**: only the server confirms.

| Code | Means |
|---|---|
| `RS…` | syntax error (unterminated string or block, `;` expected, incomplete header, tabs…) |
| `RA0001` | command unknown to the server (or a function no file defines) |
| `RA0006` | wrong number of arguments (from the server's table) |
| `RA0002` | `goto`/`callsub`/`menu` to a label that does not exist |
| `RA0003` | label or local function defined twice |
| `RA0012` | `function X;` never defined |
| `RA0004`, `RA0013` | `callfunc "X"` or `duplicate(X)` without a target (complete index only) |
| `RA0005`, `RA0011` | duplicate NPC name or global function |
| `RA0008`, `RA0009`, `RA0010` | map, item or monster not found in your server's databases |
| `RA0015` | NPC on a map the server **does not load**: it ignores it **without any message** |
| `RA0014` | label named like a command, a constant or a parameter: the server refuses it |
| `RA0016` | function called **by name** before the server has loaded it: the script does not load (`callfunc "Name"` is not concerned) |

The full list and the evidence: [`LANGUAGE_SPEC.md`](LANGUAGE_SPEC.md). Alerts about unknown commands can be tuned (or turned off) in Settings › Project.

## 7. Shortcuts

Ctrl+O open a folder · Ctrl+N new file · Ctrl+S / Ctrl+Shift+S save · Ctrl+W close the tab · Ctrl+PageDown / PageUp switch tab · Ctrl+B sidebar · Ctrl+J bottom panel · Ctrl+, settings · F12 · Shift+F12 · F2 · Ctrl+T · Ctrl+P ·
Ctrl+Shift+P · Ctrl+Shift+D · Ctrl+Shift+M · Ctrl+Space · Ctrl+Shift+Space · Ctrl+.

## 8. Privacy and security

By default, the application makes no network requests and sends no telemetry. Checking for updates contacts GitHub only when you press "Check for updates" (§ 12). The SFTP preview connects only to the host you enter, after you confirm that exact destination in a native dialog (§ 9). The AI proposal sends the displayed NPC and prompt; the prompt generator sends the prompt without an existing NPC. Both require explicit consent, and non-loopback destinations require separate confirmation. An entered API key is sent as a bearer token but is never saved; the endpoint and model identifier are saved in Settings › AI model. HTTP is accepted only for loopback or private IPv4 addresses and is unencrypted, so use it only on a trusted network. The application reads scripts without executing them and limits file operations to approved folders. See [`SECURITY.md`](SECURITY.md) (in French).
Recovery snapshots contain your source code and stay on your machine.
The **local diagnostic log** is **off by default** (Settings › Privacy). When on, it only records events — project opened, indexing finished with counters, save failure or conflict, unhandled interface error — in `logs\runeforge.log` under the application's local data folder
(`%LOCALAPPDATA%\dev.runeforge.studio`), 512 KiB at most plus one previous generation: **never code, paths or error messages**. It never leaves your machine; untick the box to stop it.

## 9. Wizards, dialogues, Git and local deployment

- **File › NPC wizard…** offers four rAthena forms (warp portal, warp NPC, shop and healer). Review the preview, then copy the script, append it to the open file or create a file. Press Ctrl+S to save.
- **File › Visual dialogue editor…** opens the NPC under the cursor. Unsupported instructions remain locked. Review the diff, apply the changes to the document and press Ctrl+S to save.
- **File › Create NPC with visual builder…** is a node editor. Drag a command from the library onto the canvas (or activate it to insert it after the selected node), then drag from a node's **output socket** (right edge) to another node's **input socket** (left edge) to connect them: the script follows the wires, not the position of the nodes. A condition has **Then** and **Otherwise** outputs, and several wires can enter one input so that branches rejoin. Without a mouse, activate an output socket and then an input socket; press Delete on an output to disconnect it, or use the × button on a wire; Escape cancels a connection in progress. Every path must end with `close` or `end`: unconnected nodes and outputs are reported and block the creation, and a connection that would make the flow loop is refused. Only commands with a known argument signature are enabled; arguments and offline help are inside each node. The generated script is checked locally before a new unsaved project file is created; save it with Ctrl+S before loading it on a server. See [DEC-042](DECISIONS.md).
- The visual builder can load a temporary JSON extension manifest containing static command names, signatures and help. It does not accept extension code or runtime permissions, and the extension is not saved by the application.
- **File › Simulate dialogue…** plays the NPC under the cursor in a local preview. It runs variables of every scope (a variable that was never set is 0, as on the server), constants, arrays, `switch`, loops, `callsub` and `callfunc` (to the functions of the same file and to those of the other files of the project that the index knows), quest and inventory commands, `input` and `close2`. Instructions that need the game server (`warp`, `cutin`, `specialeffect`…) are listed as *Not simulated* and skipped; values the server would compute are *assumed* (0 unless you set them under *Assumed function results*) and flagged, so a run that reaches its end does not prove that the NPC works on the server. The simulation never stops on an error: an operation the server would refuse (division by zero, a missing argument, a label that does not exist…) appears as an *Invalid operation* line that gives the reason, and the dialogue goes on with a default value; an NPC with syntax errors is played anyway, and what could not be read is listed as *Not simulated*. Only a limit (an endless loop, too much text) interrupts a run, with a status message that quotes the instruction it reached. Pick the test character's **class by name** (the names the server itself gives, such as *Knight*, *High Priest* or *Rune Knight*; the script reads the matching class number in `Class`), its level and its Zeny. Under *Variables, inventory, quests and assumptions* set the test character's variables, items and quests; the random seed makes a run repeatable. Nothing is sent to a server and no file or game state changes.
- The simulation dialog also offers an **optional AI proposal**. Choose an OpenAI-compatible endpoint and model. The exact NPC source and instruction are shown before sending; remote endpoints require a separate confirmation. The suggestion is validated and shown beside the original. Approving it creates a separate, unsaved file; it never replaces the current document. API keys are held only in memory.
- **File › Generate NPC from prompt…** creates a new NPC without requiring an existing script. Configure an OpenAI-compatible base URL (for example `http://10.10.11.74:8000/v1`) and model under Settings › AI model. Review the generated script and local diagnostics before approving a separate unsaved project file. The prompt, endpoint and model are shown before sending; non-loopback endpoints require separate confirmation. API keys are volatile and are not saved.
- **View › Show Git changes** lists changes and lets you compare a file with `HEAD`. Enable Git only for projects you trust. The application runs your installed Git client to read the repository.
- **File › Deploy to a folder…** prepares a plan from saved scripts. Review the plan before confirming the copy. You can then restore files replaced by the last deployment if they still match the deployed version.
- **File › SFTP preview…** compares saved scripts with a remote directory over SFTP, **read-only**: nothing is uploaded, backed up, reloaded or run remotely. Enter the host, port, user, the server's **`ssh-ed25519` public host key** (get it through a trusted channel: the application cannot verify it for you) and an absolute remote directory, then list 1–100 saved `.txt` scripts of the project (4 MiB per file, 16 MiB in total). A native dialog asks you to confirm the exact destination before anything connects. It uses the OpenSSH `ssh` client installed on your computer and your SSH agent (public-key authentication only; no password is asked or stored). Each file is reported as *Identical*, *Different* or *Missing remotely*; unsaved edits are not compared. It has been tested only on simulated data, never against a real SSH server: treat it as early.

## 10. Limits

Direct editing of the general-purpose graph and execution against a truly isolated rAthena test server remain incomplete. Declarative extension manifests are temporary and static only. Simulation and AI are limited previews, not substitutes for a real server test; no real AI provider has been verified. The Hercules adapter is also incomplete, and SSH/SFTP offers only the read-only comparison (no upload). Windows currently runs from a standalone executable. The installer is pending, and so is running the window on Linux (the executable builds and its tests pass there, but it has never been started); updating from a GitHub release (§ 12) exists on Windows and Linux, never runs by itself, and no update has yet been installed from a real release (the first release, 0.1.0-beta.1, is published; a second one is needed to try it). The project report is a snapshot of indexed files. The [compatibility matrix](COMPATIBILITY.md) describes diagnostic coverage for rAthena Renewal.

## 11. When something goes wrong

- *No command is offered*: the server is not recognized — look at the status bar and Settings › Project.
- *Too many `RA0001` alerts*: your fork has commands the local server does not know — declare them (Ctrl+. on the alert) or adjust the alert level.
- *A file looks wrong*: check the encoding in the status bar (legacy encodings are preserved).
- Report a problem with the **project report copied as text** (it never contains the content of your scripts).

## 12. Updating the application

**Help › Updates…** (or Settings › Updates) looks for a newer version in the **releases of a GitHub repository**. **Nothing is contacted until you press "Check for updates"**: the application checks nothing at startup and never updates itself.

1. **Repository**: `owner/name` of the repository that publishes the versions (by default the publisher's). Only GitHub is contacted.
2. **Channel**: "Stable releases only" (default) or "Stable and beta releases".
3. **Access token**, only if the repository is **private**: on GitHub (Settings › Developer settings › Fine-grained tokens) create a token limited to **this repository**, with the **Contents: Read-only** permission and an expiry date, and paste it into the field. It stays in memory until you close the application, is never saved, and is sent only to GitHub. Such a token can also read the repository's code, so do not make it broader than needed.
4. **Check for updates**. If a newer version is published, the application shows its version, date, size and notes (plain text).
5. **Install and restart**: save your changes first (the application restarts; the button says so). A system dialog asks you to confirm, then the application downloads the executable (with a progress bar), checks its fingerprint, replaces itself and restarts.

Every published version is **signed by the publisher**, and the application installs only what that signature vouches for: if GitHub or the network sent anything else, it refuses it ("the signature is not valid") without downloading anything. A failure leaves the old version in place. On Windows, if the message says the previous version could not be put back, rename `runeforge-studio.exe.old` (next to the application) back to `runeforge-studio.exe`; on Linux, the previous version stays next to the application as `runeforge-studio.old` until the next launch, so you can go back by hand (`mv runeforge-studio.old runeforge-studio`). Automatic installation exists on **Windows and Linux** (on Linux it has not been tried in the window) and needs an application folder you can write to: an executable installed by a package in `/usr/bin` does not update itself. On any other system, the button explains that it is not available. A build that does not contain the publisher's signing key ("this build cannot verify updates") has to be replaced by hand once.

Last evidence validation: 2026-11-10 · commit ebf2bf0+local-changes.
