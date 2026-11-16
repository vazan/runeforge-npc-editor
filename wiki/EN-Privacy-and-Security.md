# Privacy and security

*🇫🇷 [Version française](FR-Confidentialite-et-Securite)*

> This is an overview, not a certification. **No external security review has been done.** The detailed, test-by-test threat model is [`docs/SECURITY.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/SECURITY.md) (French).

## Privacy in one table

| Question | Answer |
|---|---|
| Does it send telemetry? | **No.** There is no analytics code |
| Does it use the network? | **Only when you trigger a feature that needs it**: *Check for updates* (GitHub), an *AI proposal / generation* you confirm (the endpoint you configure), an *SFTP preview* you consent to (the host you name) |
| Does it check for updates in the background? | **No.** Never at startup, never automatically |
| What does it launch? | Your installed `git` (Git panel, after you enable it per project) and the OpenSSH `ssh` client (SFTP preview, after you consent). Nothing else. **It never launches your game server** |
| Does it run my scripts? | **No.** Your code is text: the parser reads it and executes nothing |
| Is anything stored? | Locally only — see below |

## What is stored on your machine

| Data | Where | Sensitivity |
|---|---|---|
| `.runeforge/project.json` | Inside your project | No secret. Written **only on your action** |
| Settings, recent projects, session | The application's data folder | Folder paths |
| **Recovery snapshots, local history** | The application's data folder | **Contain your source code** — same sensitivity as your scripts |
| Projects for which Git is allowed | The application's config folder | Hashed project identifiers; never inside the project |
| AI endpoint and model name | Local settings | No API key |
| **API key, GitHub update token** | **Memory only** until you close the app | **Never saved** (not in settings, logs or files) |
| Diagnostic log | `logs/runeforge.log` in the local data folder | **Off by default** — see below |

### The optional diagnostic log

**Settings › Privacy** has a checkbox, **off by default**. When on, it records only *events* — project opened, indexing finished with counters, save failure or conflict, unhandled interface error — never code, paths, file names or error messages. The native side validates every event against a fixed schema. It is capped at 512 KiB plus one previous generation, never leaves your machine, and stops the moment you untick the box. On Windows it lives under `%LOCALAPPDATA%\dev.runeforge.studio\logs\`. It is safe to attach to a bug report.

## How the application is hardened

- **Least privilege.** One window, **27 explicitly named native commands**, no generic file-system or shell permission given to the web page. A Rust test fails if a command is granted without being declared (or the reverse).
- **The interface never handles absolute paths.** It only knows opaque *approved roots* and *relative paths*, validated and canonicalised in Rust: empty, absolute, `..`, device names, alternate data streams and links that escape the root are refused.
- **No write without an explicit action**, and never over a file changed elsewhere without your decision. Writes are atomic.
- **Content Security Policy** without `unsafe-eval` and without inline scripts. (`style-src 'unsafe-inline'` is accepted because Monaco injects styles at runtime; it cannot execute code.)
- **Bounded everything**: files read (20 MiB), tree scan (200,000 files, 64 levels), configuration (1 MiB), diagnostics per file (1,000), Git output and runtime.
- **Signed updates**: see [Updates](EN-Updates).
- **No `unsafe` Rust** in the project's own crates and application core; dependency and lockfiles are versioned and installed with a frozen lockfile.
- **Test hook isolation**: the end-to-end test hook only exists in a build with the `e2e` feature, which must never be distributed.

## What has not been done

- No external security review or penetration test.
- No `pnpm audit` / `cargo audit` run yet (it needs network access).
- The CSP's `connect-src` allows HTTPS and HTTP so a local AI provider can be configured; the application-level check restricts HTTP to loopback and private IPv4 addresses, but the wider CSP scope still needs an independent review before distribution.
- No Windows code signing; no OS-level secret storage (secrets simply stay in memory).
- On Linux, the window has barely been exercised, and GTK/WebKitGTK/OpenSSL security updates come from your distribution.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting: [report a vulnerability](https://github.com/vazan/runeforge-npc-editor/security/advisories/new). (The repository owner must have enabled *Private vulnerability reporting* under Settings › Code security.)

For non-security bugs, see [Troubleshooting and FAQ](EN-Troubleshooting-and-FAQ#reporting-a-bug) — and never paste secrets in a report.
