# Server integration

*🇫🇷 [Version française](FR-Integration-Serveur)*

RuneForge can read your **rAthena** server folder to make its checks specific to the server you actually run. It **only reads** your files and **never launches** the game server.

## Recognition

When you open a project that contains a rAthena server, the status bar shows it (for example `rAthena · re`). The server is recognised from characteristic files:

`src/map/script.cpp` · `npc/re/scripts_main.conf` · `npc/pre-re/scripts_main.conf` · `conf/map_athena.conf` · `doc/script_commands.txt` (its presence is noted, its content is not opened).

- **Several servers in one project?** Nothing is chosen automatically; the status bar says "Choose a server" and you pick the folder in **Settings › Project**.
- **No server** (a standalone script folder), **Hercules**, or a **precompiled server without `src/`**: the offline command library still gives completion, hover and signatures, but no server-specific alert is raised.

## What is read from your files

At project open and whenever the server settings change:

| Need | Read from your server |
|---|---|
| Command names and argument counts | `src/map/script.cpp` (the command table) and `src/custom/script_def.inc` (your custom commands) |
| Scripts that are loaded, and their order | `npc/re/scripts_main.conf` or `npc/pre-re/scripts_main.conf` and what they `import:` / `delnpc:` |
| Maps that are loaded | `conf/map_athena.conf` and its imports (`map:`, `delmap:`) |
| Map index | `db/map_index.txt`, `db/import/map_index.txt` |
| Items, monsters | `db/item_db.yml`, `db/mob_db.yml` and their imports (`db/re/` or `db/pre-re/` according to the mode, then `db/import/`) |
| Constants | `db/const.yml`, `src/map/script_constants.hpp` |
| Random options (`RDMOPT_…`) | `db/item_randomopt_db.yml` and imports |
| Mode (Renewal / pre-Renewal) | `src/config/renewal.hpp` (or your setting) |

This data is read at runtime and kept in memory; no server file is copied into RuneForge or into your project. On a reference server this is fast: 27,826 items, 2,555 monsters, 1,248 maps and 10,552 constants read in about 0.1 s, identical to a full YAML parser (0 differences).

## Settings › Project

| Setting | Purpose |
|---|---|
| Server folder | Choose among detected servers, or point to one |
| Compile mode | `re` or `pre-re`, if it cannot be detected (missing `renewal.hpp` assumes Renewal and says so) |
| **Index scope** | `sources` (default) or `loaded` (only scripts the server loads) |
| Alert level | Unknown commands; unresolved references (items, monsters, maps) |
| Cross-file checks | `validation.crossFile`, off by default |
| **Custom commands** | One per line: `name` or `name args` (for example `mycmd s?`). Without an argument notation the count is not checked |
| **Custom constants** | Complement the server's constants |

These settings are saved in `.runeforge/project.json` **only when you ask**. A custom command **complements** a recognised server's registry; it never replaces it (alone, it would make every other command "unknown").

## Searching the databases

`Ctrl+Shift+D` opens a palette over your server's items, monsters, maps and constants. Prefix a query with `item:`, `mob:`, `map:` or `const:` to restrict it. `Enter` inserts the identifier, `Shift+Enter` the quoted name. Nothing is written to a file — it inserts into the open editor.

## The load-order rules

Some mistakes make a server silently ignore or refuse a script. RuneForge reads the server's code to flag them:

- **`RA0015`** — an NPC on a map the server does not load (`conf/map_athena.conf`) is ignored with **no message** at all.
- **`RA0014`** — a label named like a command, a constant or a parameter is refused.
- **`RA0016`** — a function called by its bare name before it is loaded (loaded by a later file, defined further down the same file, or recursion) prevents the script from loading.

See [Diagnostics](EN-Diagnostics) for the whole list.

## Limits worth knowing

- **rAthena only.** Hercules has no adapter yet (see [Compatibility and limitations](EN-Compatibility-and-Limitations)).
- Rules were proven against **one local rAthena fork in Renewal mode** (revision unknown). Pre-renewal logic is tested on authored fixtures, not on a real pre-renewal install. A fork that changes how `callfunc` parses or how arguments are noted could produce false alerts — declare its differences or tune the alert level.
- A server compiled with other options can differ from the source read: commands under `#ifdef` are considered known, so they are never flagged wrongly, but a command missing from the binary is not detected.
- With `use_sql_db: yes` the server reads items and monsters from MySQL, so the YAML files RuneForge reads may differ from what the server uses.
- Changing server, mode or scope re-reads the whole project.
