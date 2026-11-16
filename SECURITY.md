# Security policy

RuneForge Studio is a **pre-release** (version 0.1.0-beta.1) desktop application that reads and edits local script files. **No external security review has been done yet.** The threat model and the measures in place are described in [`docs/SECURITY.md`](docs/SECURITY.md) (French) and summarised on the wiki ([Privacy and security](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Privacy-and-Security), [en français](https://github.com/vazan/runeforge-npc-editor/wiki/FR-Confidentialite-et-Securite)).

## Supported versions

Only the latest pre-release ([0.1.0-beta.1](https://github.com/vazan/runeforge-npc-editor/releases)) and the current `master` are supported. Security fixes are made on `master` first and shipped in a new release; older pre-releases are not patched.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a vulnerability.**

Use GitHub's **private vulnerability reporting**: [report a vulnerability](https://github.com/vazan/runeforge-npc-editor/security/advisories/new). Include:

- what the problem is and which part of the application it affects;
- the version or commit, and your operating system;
- the steps to reproduce it, with a **minimal** example;
- the impact you expect (for example "writes outside the project folder", "runs a program the user did not approve", "sends data without consent").

Never include real secrets (API keys, tokens, SSH keys, signing keys, passwords) in a report.

If the reporting form is not available, open a [Question](https://github.com/vazan/runeforge-npc-editor/issues/new/choose) issue titled **"Security contact request"** with **no technical details**, and a maintainer will arrange a private channel.

## What to expect

This is a small project maintained in people's free time, so there are **no guaranteed response times**. We will do our best to acknowledge a report, confirm the problem, fix it, and credit you if you wish. Please give us a reasonable chance to fix an issue before disclosing it publicly.

## What is in scope

The application and its tooling, in particular:

- file access: path validation, approved folders, atomic writes, links that escape a folder;
- the native (IPC) command surface and the content security policy;
- the signed-update mechanism (manifest signature, download verification, executable replacement) and the release tooling;
- the processes the application launches (`git`, and the OpenSSH `ssh` client for the SFTP preview);
- network use that happens without an explicit user action, and secrets that are stored, logged or sent when they should not be (API keys and access tokens are meant to stay in memory only).

## Known limits

Not done yet, and documented as such: an external security review, dependency audits (`pnpm audit`, `cargo audit`), Windows code signing, an update actually installed from a real release (the production signing key and a first signed release exist since 0.1.0-beta.1, but no update has been installed from them yet), and an independent review of the content security policy's network scope. See [Privacy and security](https://github.com/vazan/runeforge-npc-editor/wiki/EN-Privacy-and-Security) and [`docs/SECURITY.md`](docs/SECURITY.md).

Vulnerabilities in rAthena or in third-party dependencies should be reported to those projects; tell us too if RuneForge Studio is affected in a way they cannot fix.
