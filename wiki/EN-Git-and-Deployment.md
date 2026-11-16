# Git and deployment

*🇫🇷 [Version française](FR-Git-et-Deploiement)*

Two optional features connect your project to the outside: a **read-only Git panel**, and **deployment** of saved scripts to a folder (with a read-only SFTP comparison).

## Git panel (read-only)

**View › Show Git changes** lists the working tree and index changes and lets you **compare a file with `HEAD`**. The status bar shows the branch.

- RuneForge runs your installed **`git`** program, and only when you open the Git tab or compare a file.
- **You must enable Git for each project** (a confirmation box, refused by default). Why: a repository received from someone else can declare programs in its `.git/config` that `git status` would run. RuneForge forces `core.fsmonitor=false`, clears the environment passed to Git (18 allowed variables), uses `--no-optional-locks` so nothing is written to the repository, and only runs `rev-parse`, `status` and `cat-file`. **Only enable Git for projects you trust**: a repository that declares a *filter* program could still have it run by `git status`.
- It never runs write commands (no commit, no checkout) and no network command.
- Limits: 5,000 files listed, a 15-second timeout per call, submodules ignored.

## Deploy to a folder

**File › Deploy to a folder…** copies **saved** scripts to a destination you choose.

1. RuneForge builds a **plan** (what will be created or replaced). Review it — nothing is copied yet. At most 2,000 files per plan.
2. Confirm. A **backup** of each file to be replaced is made first, and the copy is verified.
3. Afterwards you can **restore** the files replaced by the last deployment — but only if they still match the deployed version; a file changed since is refused.

Newly created files are kept on restore. You still manage your `scripts_*.conf` lists and the reload on your server yourself: RuneForge never edits them and never restarts a server.

## SFTP preview (read-only comparison)

**File › SFTP preview…** compares saved scripts with a remote directory. **It uploads nothing, backs nothing up, reloads nothing and runs no remote command.**

- You give the host, port, user, **pinned host public key (`ssh-ed25519`)**, an absolute remote directory, and 1–100 project-relative `.txt` paths (at most 4 MiB per file and 16 MiB total).
- A **native dialog asks your consent for the exact destination** before connecting; a configuration file cannot grant it.
- Authentication is by **public key through your SSH agent** only — no passwords. It uses the **OpenSSH `ssh` client already installed** (on Windows `System32\OpenSSH\ssh.exe`, on Linux `/usr/bin/ssh`) with the host key checked strictly against the one you pinned.
- Each file is reported as **Identical**, **Different** or **Missing remotely**, with local and remote byte counts.

> Status: covered by unit tests on simulated data (6 Rust and 5 TypeScript tests, run on 2026-11-15) and by no end-to-end scenario. **No run against a real SSH server is recorded** — treat this preview as **early**. The application cannot verify the host key you pin, so obtain it through a trusted channel. Details: [`docs/SECURITY.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/SECURITY.md) ("Aperçu SFTP") and [`docs/KNOWN_LIMITATIONS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/KNOWN_LIMITATIONS.md).

## What is not there

- No upload over SSH/SFTP yet (only the comparison).
- No Git write operations, and no automatic loading of deployed scripts on a server.
- Running scripts against a genuinely isolated rAthena test server is on the [roadmap](EN-Roadmap), not available.
