# PR Review — Template

> The Supervisor uses this for every PR review. The same template doubles as the **PR description** the author fills out — the author answers the questions, the Supervisor verifies the answers.

---

## What changed

One paragraph in plain language. Not a file list.

## Why

Link the release-checklist item this closes (e.g. `Closes 2.5 🔒`). If the PR doesn't map to a checklist item, justify why we're shipping it now.

## How to verify

Step-by-step commands or click paths that prove the change works. The reviewer runs them.

```bash
# example
npm run dev
curl -sS http://localhost:3000/api/health
# then in browser: …
```

## Engineering checks (author fills in, supervisor verifies)

- [ ] `npm run lint` passes locally
- [ ] `npm run build` passes locally
- [ ] No new TODO/FIXME without a tracked task
- [ ] No `console.log` in production paths
- [ ] No commented-out dead code

## Security checks 🔒 (author fills in, supervisor verifies)

- [ ] No secrets in diff (grep for `ghp_`, `sk-`, `AIza`, `-----BEGIN PRIVATE KEY`)
- [ ] If new endpoint: auth + input validation + rate-limit covered
- [ ] If webhook: signature/HMAC verified
- [ ] If DB query: parameterized, no string concat
- [ ] Error responses do not leak stack traces or internal paths
- [ ] PII not added to logs

## Product / Marketing checks (author fills in, supervisor verifies)

- [ ] User-visible Arabic copy reads naturally (RTL-correct)
- [ ] Empty state / error toast has actionable wording
- [ ] If pricing-impacting: checklist updated (item 4.x)
- [ ] Telemetry on new flow (event names listed)

## Out of scope

What was deliberately NOT changed in this PR (helps the reviewer not look for it).

## Reviewer verdict

_(Supervisor fills in — one of three:)_

- [ ] **Approve** — merging.
- [ ] **Request changes** — exact list of changes required, ordered.
- [ ] **Reject** — close with reasoning; corrective task brief at `docs/templates/task-brief.md` filed.
