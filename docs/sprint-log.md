# Sprint Log

Append-only ledger of every supervisor-driven sprint. Newest at the top. The Supervisor adds a block at the start of every sprint and updates it at the end.

Format per sprint:

- **Sprint #N — `YYYY-MM-DD`**
- **Goal:** one sentence
- **Picks** (from `commercial-release-checklist.md`):
  - `X.Y` Title — owner — status at sprint end
- **Outcome:** merged / partial / rolled back, with commit refs
- **Notes:** what surprised us, what we learned

---

---

## Supervisor review — 2026-07-12 — PR #63 BLOCKED

1. **Merged / shipped:** no merge or production deployment. Codex completed and
   tested releases 1.0.0–1.0.9; draft PR #63 is open from
   `codex/v1-remediation`.
2. **Rejected / blocked:** self-approval is prohibited; a Claude/Hermes review
   is required. GitHub rejected the two workflow updates because the PAT and App
   lack workflow-write permission. Production replacement is also gated on a
   real Firebase login/admin verification.
3. **Release-checklist delta:** no statuses flipped. Standing remains 26/78
   done with 5 security hard gates remaining.
4. **Next-action queue:** Claude reviews PR #63 using
   `docs/tasks/claude-review-v1-remediation-2026-07-12.md`; the human owner grants
   GitHub `workflow` scope and confirms the production admin UID/email; Supervisor
   reruns staging security checks before merge.
5. **Risks / escalations:** the live domain still exposes Vite and source paths,
   reports package version 0.0.0, and lacks HSTS. Deploying the secure candidate
   without verifying Firebase/admin state could lock out the owner.

---

## Sprint #2 — 2026-06-19 — IN PROGRESS

**Goal:** Secure the API surface (rate limiting + input validation), wire client-side ad tracking (GTM + GA4 + Meta Pixel), and polish Arabic UX copy.

**Picks:**
- `2.5 🔒` Rate limiting (per-IP + per-UID) — **Codex** — in progress
- `2.6 🔒` Zod input validation on all public endpoints — **Codex** — in progress
- `5.9` GTM container loaded — **Claude Code** — in progress
- `5.10` Google Analytics 4 — **Claude Code** — in progress
- `5.11` Meta Pixel — **Claude Code** — in progress
- `3.1` Arabic copy review — **Hermes** — in progress
- `5.31` Brand voice guideline — **Hermes** — in progress

**Outcome:** _(filled at sprint end)_

**Notes:** _(filled at sprint end)_
