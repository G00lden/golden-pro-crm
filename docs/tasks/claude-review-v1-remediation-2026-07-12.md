# Task Brief — independently review CRM releases 1.0.0–1.0.9

## Title

`Review and challenge PR #63 before production`

## Owner

`claude` (Hermes may perform the review if Claude is unavailable)

## Release-checklist link

Security hard gates `2.2`, `2.8`, `2.9`, `2.11`, and `2.12` in
`docs/commercial-release-checklist.md`.

## Branch

Review `codex/v1-remediation` / PR #63. Put corrective commits on
`claude/review-v1-remediation` if changes are required.

## Goal

Perform the independent review Codex cannot give its own work. Challenge the
auth, tenant isolation, financial calculations, migrations, production build,
and deployment behavior. Confirm the public dev-server exposure is closed in
the candidate without locking the owner out of production.

## Files of interest

- `docs/handoff-summary.md` — release-by-release behavior and side effects.
- `docs/architecture.md` — dependency boundaries and deliberate debt.
- `server/auth.ts`, `server/crmApi.ts`, `server/repositories/` — security boundary.
- `shared/financial.ts`, `shared/date.ts`, `server/db.ts` — business correctness.
- `Dockerfile`, `scripts/start-server.mjs`, `.github/workflows/` — production gate.

## Success criteria

- [ ] Review every commit in PR #63 and leave an explicit approve/request-changes decision.
- [ ] `npm run test:unit`, `npm run test:integration`, `npm run lint`, and `npm run build` pass.
- [ ] `npm run security:source` and `npm run security:dependencies` pass.
- [ ] Verify production returns 404 for `/@vite/client`, `/src/main.tsx`,
  `/package.json`, and `/server.ts` on a staging instance.
- [ ] Verify a real Firebase user can log in and an existing admin remains admin.
- [ ] Confirm no migration rewrites historical financial values.

## Out of scope

- Do not merge before the two workflow files are uploaded with `workflow` scope.
- Do not deploy or delete live data during review.
- Do not enable outbound WhatsApp or payment actions.

## Time-box

Two hours. If blocked, leave exact evidence and reproduction commands on PR #63.
