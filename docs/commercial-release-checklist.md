# Commercial Release Checklist — Golden Pro CRM v1.0

> Source of truth for what "shippable to paying customers" means. The Supervisor (see `supervisor-agent.md`) is the only one who flips items from ✗ to ✓. Updated dates trail the status.

## Legend
- ✓ done & verified
- ◐ in progress
- ✗ not started
- ⛔ blocker (release cannot ship)
- 🔒 security-critical (Supervisor escalates if unchecked at deploy time)

---

## 1. Engineering — code & infra

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 1.1 | `npm run lint` clean on `main` | ✓ | any | tsc --noEmit, currently zero errors |
| 1.2 | `npm run build` succeeds | ◐ | any | verify post-payment-fields work |
| 1.3 | `npm run test:smoke` covers golden path | ✗ | claude/codex | needs auth → create customer → quote → send WA → mark paid |
| 1.4 | E2E test for store webhook | ✗ | codex | signed event roundtrip + idempotency |
| 1.5 | Production env template (`.env.production.example`) reviewed | ◐ | supervisor | all keys documented, no placeholder leaks |
| 1.6 | Dockerfile produces a runnable image | ✗ | hermes | `docker run -p 3000:3000` boots + /api/health = ok |
| 1.7 | Cloud Run + VPS deploy scripts both succeed once on staging | ✗ | hermes | use existing `deploy:cloudrun` / `deploy:vps` |
| 1.8 | Backup + restore for SQLite + Supabase documented | ✗ | claude | `docs/backup-restore.md` |
| 1.9 | Observability: errors → log file or Sentry | ✗ | codex | structured logs at minimum |
| 1.10 | Graceful shutdown drains in-flight WA messages | ✗ | codex | SIGTERM handler |

## 2. Security 🔒

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 2.1 🔒 | No secrets ever in repo (gitleaks scan clean) | ✓ | supervisor | `.gitignore` hardened; `scripts/security-audit.mjs` runs locally |
| 2.2 🔒 | Auth required on every mutating `/api/*` route | ◐ | supervisor | spot-checked; need full audit |
| 2.3 🔒 | Store webhook HMAC verification mandatory in prod | ✓ | n/a | implemented in `server/storeWebhook.ts` |
| 2.4 🔒 | Outbound WhatsApp gated by launch code in prod | ✓ | n/a | `OUTBOUND_LAUNCH_CODE` enforced |
| 2.5 🔒 | Rate limiting on `/api/auth/*` and webhook | ✗ | codex | express-rate-limit; per-IP + per-account |
| 2.6 🔒 | Input validation (zod) on every public endpoint | ✗ | codex | currently ad-hoc |
| 2.7 🔒 | npm audit clean (or accepted/documented exceptions) | ✗ | any | `npm audit --production` |
| 2.8 🔒 | Supabase RLS policies reviewed for every table | ✗ | claude | go table-by-table |
| 2.9 🔒 | Firestore rules reviewed by Supervisor | ◐ | supervisor | `firestore.rules` exists; do a line-by-line pass |
| 2.10 🔒 | Logs scrubbed of PII (phone, name, address) | ✗ | codex | redact in middleware |
| 2.11 🔒 | HTTPS-only in production (HSTS) | ✗ | hermes | Caddy/CF tunnel terminates TLS — verify HSTS header |
| 2.12 🔒 | Penetration smoke (sqlmap + nikto baseline) | ✗ | supervisor | run on staging URL |

## 3. Product & UX

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 3.1 | Arabic copy review for every user-visible string | ✗ | hermes | brand-voice skill |
| 3.2 | RTL layout verified on all pages | ✗ | claude | mobile + desktop |
| 3.3 | Empty states + onboarding for new accounts | ✗ | claude | no blank dashboards |
| 3.4 | Mobile responsive (≤375px) | ✗ | claude | screenshot pass |
| 3.5 | Quote PDF template polished (logo, fields, watermark) | ◐ | claude | payment fields wiring in progress |
| 3.6 | Print preview matches PDF | ✗ | claude | test post-PDF wiring |
| 3.7 | Error toasts in Arabic with actionable wording | ✗ | claude | not "Internal Server Error" |
| 3.8 | Loading skeletons (no naked spinners) | ✗ | claude | |

## 4. Billing & commercial

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 4.1 | Pricing tiers defined (free / pro / business) | ✗ | supervisor | research-driven; hermes can scan competitors |
| 4.2 | Payment gateway integrated (Tap/Moyasar/Stripe) | ✗ | codex | KSA-first → Tap or Moyasar |
| 4.3 | Subscription state in DB + UI | ✗ | codex | quotas, expiry, renewal |
| 4.4 | Invoicing for KSA VAT compliance | ✗ | supervisor | ZATCA-compliant invoice |
| 4.5 | Refund policy documented | ✗ | supervisor | `docs/refund-policy.md` |
| 4.6 | Terms of Service + Privacy Policy (Arabic + English) | ✗ | hermes | legal:legal-response skill |

## 5. Marketing & GTM

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 5.1 | Landing page (Arabic-first) | ✗ | hermes | marketing:draft-content skill |
| 5.2 | Pricing page | ✗ | hermes | depends on 4.1 |
| 5.3 | Demo video (60-90s, Arabic VO) | ✗ | human + hermes | scripted by hermes; recorded by owner |
| 5.4 | Case study from beta tester | ✗ | human | needs 1 paying pilot |
| 5.5 | SEO: meta tags, sitemap.xml, robots.txt | ✗ | claude | golden-* skills available |
| 5.6 | Salla App Store listing draft | ✗ | hermes | screenshots, description, pricing |
| 5.7 | Email onboarding sequence (welcome → activation → upgrade) | ✗ | hermes | marketing:email-sequence skill |
| 5.8 | Brand voice guideline doc | ✗ | hermes | brand-voice:generate-guidelines |

## 6. Operations & support

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 6.1 | Runbook for: WhatsApp disconnect, reminder cron failure, webhook 500 | ✗ | codex | `docs/runbook.md` |
| 6.2 | On-call contact + escalation path | ✗ | human | who pages who, off-hours |
| 6.3 | Support email + auto-acknowledge | ✗ | hermes | `support@…` + 24h SLA |
| 6.4 | Status page (public) | ✗ | hermes | uptime monitor → public URL |
| 6.5 | Data export for customers (GDPR/PDPL right-to-portability) | ✗ | codex | JSON dump endpoint |

---

## Definition of Done — v1 release

**Hard gates (cannot ship without):**
- All 🔒 security items: ✓
- 1.1, 1.2, 1.5, 1.6 (engineering basics): ✓
- 3.1, 3.2, 3.7 (Arabic UX must not embarrass us): ✓
- 4.1, 4.2, 4.3 (someone can actually pay): ✓
- 4.4 (ZATCA invoicing for KSA): ✓ or documented exception
- 5.1, 5.2 (landing + pricing pages live): ✓
- 6.1, 6.2 (we can respond when it breaks): ✓

**Nice-to-have (ship without, schedule after):**
- 5.3, 5.4, 5.6 (demo video, case study, Salla listing)
- 1.10, 6.4 (graceful shutdown, status page)

## Current standing — 2026-06-18

Done: 4 / 60 items. Hard-gate items remaining: ~24. Realistic first-pass ETA depends on agent throughput; supervisor will set sprint targets and reassess weekly.
