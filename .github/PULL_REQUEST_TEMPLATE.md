## What and why

<!-- What does this change, and why? Link the issue it addresses: "Fixes #123". For anything sizeable, please agree on the approach in an issue first. -->

## Evidence

<!-- Claims need proof. List the commands you ran and what they showed. -->

- [ ] `pnpm check:all` passes (types, ESLint, TypeScript tests, clippy, Rust tests)
- [ ] `pnpm e2e` passes on Windows, if the change affects UI behaviour
- [ ] Tests added or updated. For a diagnostic rule: a test that **fails if the rule is removed**

## Checklist

- [ ] The change is focused and as small as it can be
- [ ] No code path writes a user file without an explicit user action
- [ ] Any new native (IPC) command is declared and granted explicitly
- [ ] Documentation updated where behaviour changed: `docs/`, the wiki (**English and French**), `CHANGELOG.md`
- [ ] No secrets, and no private or proprietary server content, in code, fixtures or screenshots
- [ ] I am allowed to contribute this under GPL-3.0-only

## Notes for reviewers

<!-- Anything that is not verified, a trade-off you made, or a part you want a second opinion on. -->
