# Updates

*🇫🇷 [Version française](FR-Mises-a-jour)*

RuneForge can update itself from the **releases of a GitHub repository** — but only when you ask, and only with a version signed by the publisher.

> **Current state:** the mechanism is implemented and tested against a local fake GitHub server. The production signing key exists and the first signed release, [0.1.0-beta.1](https://github.com/vazan/runeforge-npc-editor/releases), is published — but **no update has been installed from a real release yet**, and the real TLS connection to `api.github.com` has not been exercised from the application. Because 0.1.0-beta.1 is a beta, choose **"Stable and beta releases"** under Settings › Updates to be offered the next beta (the default "Stable releases only" ignores them). Builds made before the production key was embedded answer "this build cannot verify updates" (`not_configured`). See [Releasing](#for-maintainers-publishing-a-release).

## For users: updating

**Help › Updates…** (or **Settings › Updates**).

**Nothing is contacted until you press "Check for updates"**: the application checks nothing at startup and never updates itself.

1. **Repository** — `owner/name` of the repository that publishes the versions. Only GitHub is contacted.
2. **Channel** — "Stable releases only" (default) or "Stable and beta releases".
3. **Access token** — only if the repository is **private**. On GitHub create a *fine-grained token* limited to **that repository**, with **Contents: Read-only** and an expiry date. It stays in memory until you close the application, is never saved, and is sent only to GitHub. Note that such a token can also read the repository's source code.
4. **Check for updates** — if a newer version exists you see its version, date, size and notes (plain text).
5. **Install and restart** — save your work first (the application restarts). A system dialog asks you to confirm; then the executable is downloaded (progress bar), its fingerprint checked, the running executable replaced, and the application restarts. Installation is **refused while you have unsaved changes**.

### Why it is safe

GitHub and the network are treated as untrusted transports. The publisher **signs a manifest** with a private key; the application embeds the matching public key and installs **only what that signature vouches for** — including the file size and SHA-256 of the executable. A forged release, a hijacked repository or a man in the middle can block an update but never impose one. Only a strictly newer version is offered (never a downgrade), and a signed manifest must agree with the release tag and channel.

### If something fails

A failure leaves the old version in place.

| System | Behaviour |
|---|---|
| **Windows** | Executable replaced by renames inside the application folder, with rollback. If the message says the previous version could not be restored, rename `runeforge-studio.exe.old` back to `runeforge-studio.exe` |
| **Linux** | A single atomic `rename`. The previous version stays as `runeforge-studio.old` until the next successful launch; roll back by hand with `mv runeforge-studio.old runeforge-studio` |

The application folder must be **writable by you**: an executable under `C:\Program Files`, or installed by a package manager in `/usr/bin`, cannot update itself (`not_writable`). On any other OS the button explains that installation is unavailable.

## Limits

- **Windows and Linux (x86_64) only.** No macOS, no ARM binary.
- Never automatic; no differential updates; no resume of an interrupted download.
- **Not verified**: real TLS to `api.github.com`, private-repository download redirects, rate limits, antivirus behaviour; the in-window update on Linux.
- No Windows code signing: SmartScreen may warn when you first run a hand-downloaded executable.
- Changing or losing the signing key cuts updates for every copy already distributed.

## For maintainers: publishing a release

The complete procedure is in [`docs/RELEASE.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/RELEASE.md). In outline:

```bash
# once — creates the key pair OUTSIDE the repository and copies the public key
pnpm release:keygen --out <path-outside-the-repo>/runeforge-update.key

# each release: bump the version in apps/desktop/src-tauri/tauri.conf.json, update CHANGELOG.md, then
pnpm check:all
pnpm --filter @runeforge/desktop tauri build --no-bundle      # on each OS you ship
pnpm release:prepare --version X.Y.Z --notes notes.txt \
    --artifact windows-x86_64=<exe> --artifact linux-x86_64=<elf>
pnpm release:publish --repo owner/name --dir release-out/X.Y.Z        # preview only
pnpm release:publish --repo owner/name --dir release-out/X.Y.Z --yes  # creates a DRAFT release
```

Key points:

- **One signed manifest describes every platform** of a release.
- `release:prepare` refuses a wrong version, an executable that embeds the test key or lacks the production key, a wrong-OS executable header, or a non-empty output folder.
- The private key is the most sensitive secret of the product: back it up with its password in two safe places and **never commit it** (`*.key` is git-ignored except the public *test* fixtures).
- Review the draft on GitHub and **publish** it — drafts are invisible to the application.
- Before relying on it, publish a **test release** and verify the whole loop against the real GitHub.
