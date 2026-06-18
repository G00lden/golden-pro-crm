# Task Brief — Template

> The Supervisor fills this out when handing a task to Codex / Claude Code / Hermes. Paste the filled-out version into the target agent's chat as the first message of the session. The brief is self-contained — the agent has no other context.

---

## Title

`<one-line, imperative, ≤70 chars>`

## Owner

`<codex | claude | hermes>`

## Release-checklist link

`<e.g. 2.5 🔒 (Rate limiting)>` — also reference `docs/commercial-release-checklist.md`.

## Branch

```
git checkout -b <agent>/<slug>
```

## Goal (one paragraph)

Plain language: what problem are we solving and why does it matter for v1?

## Files of interest

- `path/to/file1.ts` — what to read first
- `path/to/file2.ts` — what to edit
- `docs/some-doc.md` — context

## Inputs you can rely on

- env keys: `KEY_A`, `KEY_B`
- existing helpers: `<name>` in `<file>`
- existing types: `<name>` in `<file>`

## Success criteria (mechanical)

- [ ] `npm run lint` passes
- [ ] `npm run build` passes
- [ ] `npm run test:smoke` still green (if applicable)
- [ ] Manual test: `<exact command or click path>` → `<expected observable>`
- [ ] No new entries in `npm audit --omit=dev` of moderate or higher severity

## Out of scope (do NOT touch)

- file/area 1
- file/area 2

## Time-box

`<e.g. 2 hours — if you can't finish, push WIP to the branch and write what's left in the PR description>`

## PR template

When done:

```bash
git add -A
git commit -m "<concise message>"
git push -u origin <branch>
gh pr create --base main \
  --title "<Type>: <Title>" \
  --body "<filled-out PR template from docs/templates/pr-review-template.md>"
```

The Supervisor reviews. Do not self-merge.
