# Release Checklist — Golden Pro CRM v1.0 (private project + ad-landing)

> Source of truth for what "ready to ship" means for this project. Context: this is a **private** internal CRM that Abdullah uses to run Golden Pro's operations, plus a **public ad-landing page** (profile + products) used as the destination for paid ad campaigns (Meta / TikTok / Snap / Google). The Supervisor (see `supervisor-agent.md`) is the only role that flips items from ✗ to ✓. Dates trail each status change.

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
| 1.2 | `npm run build` succeeds | ✓ | any | verified 2026-06-18: vite build 9.97s, 0 errors (1 chunk-size warning, non-blocking) |
| 1.3 | `npm run test:golden` covers golden path | ✓ | supervisor | verified 2026-06-18: 7/7 steps pass (auth → customer → quote → confirm → WA → list) |
| 1.4 | E2E test for store webhook | ✗ | codex | signed event roundtrip + idempotency |
| 1.5 | Production env template (`.env.production.example`) reviewed | ◐ | supervisor | all keys documented, no placeholder leaks |
| 1.6 | Dockerfile produces a runnable image | ◐ | hermes | supervisor 2026-07-04: reviewed `Dockerfile` (node:22-slim, `npm ci` → `npm run build` → non-root `node` user → `HEALTHCHECK` on `/api/health` → `npm start`) plus root `docker-compose.yml` (persistent volumes for `.runtime` + `.wa-session`) — structurally sound and consistent with `docs/deployment.md`. Could **not** execute `docker build` in this sandbox: egress to `production.cloudfront.docker.com` (the image-layer CDN) is blocked by the agent-proxy egress policy (403), confirmed via `/root/.ccr/README.md` guidance — this is a policy boundary, not a code defect. Still needs one real `docker run -p 3000:3000` + `/api/health` boot check on an unrestricted host before flipping to ✓. |
| 1.7 | Cloud Run + VPS deploy scripts both succeed once on staging | ◐ | hermes | supervisor 2026-07-04: found a **second, more complete** deploy path not referenced by the checklist before: `deploy/bootstrap-vps.sh` (installs Docker CE + ufw on Ubuntu 24.04, creates service user), `deploy/remote-start.sh`, `deploy/Caddyfile` (HTTPS reverse proxy), `deploy/docker-compose.yml` (adds a `caddy` sidecar), orchestrated end-to-end by `scripts/deploy-vps.ps1` (local checks → tar archive without secrets → scp/ssh → remote compose up → optional Cloudflare DNS). This is real, non-trivial engineering, not a stub. However: (a) never run against a real VPS — no staging verification exists in any doc; (b) `docs/deployment.md` explicitly states the app is **NOT suitable for Cloud Run** (WhatsApp + SQLite need a long-lived process + stable disk), yet `package.json`'s `deploy:cloudrun` script and this checklist item still imply Cloud Run is a target — **architectural contradiction that needs a decision**: either drop the Cloud Run requirement from Definition-of-Done and this item (recommended — matches the documented single-container architecture), or split VPS/SQLite off from a future stateless Cloud Run frontend. Flagged for human/Supervisor decision, not flipped either way. |
|| 1.8 | Backup + restore for SQLite + Supabase documented | ✓ | claude | supervisor 2026-07-09: cherry-picked from `codex/p0-security-backup-salla` onto `claude/backup-restore`, merged to main. `npm run backup:now` works (5.1MB zip → `.runtime/backups/`), `npm run restore:latest` verified. Docs at `docs/backup-restore.md`. |
| 1.9 | Observability: errors → log file or Sentry | ✓ | codex | verified 2026-07-04: `server/logger.ts` — structured JSON `logEvent`/`logError` with PII redaction (`redactValue`: phone/token/secret/bearer patterns), appends to `logs/server-errors.log` (path overridable via `STRUCTURED_LOG_FILE`) plus console. Used at 39 call sites across 10+ server files (`server.ts` global unhandled-error handler + scheduler failures, `ivrEngine.ts`, `gateway.ts`, `routes-telephony.ts`, `routes-gateway.ts`, `auth.ts`, `bookingNotifications.ts`, `routes-whatsapp.ts`). Meets "structured logs at minimum" bar; no Sentry, which is fine per the item's own wording. |
| 1.10 | Graceful shutdown drains in-flight WA messages | ✗ | codex | verified 2026-07-04: no `SIGTERM`/`SIGINT` handler found anywhere in `server.ts` or `server/`. Confirmed still not started. |

## 2. Security 🔒

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 2.1 🔒 | No secrets ever in repo (precheck scan clean) | ✓ | supervisor | `.gitignore` hardened; `npm run supervisor:precheck` enforces |
| 2.2 🔒 | Auth required on every mutating `/api/*` route | ◐ | supervisor | spot-checked; need full audit |
| 2.3 🔒 | Store webhook HMAC verification mandatory in prod | ✓ | n/a | implemented in `server/storeWebhook.ts` |
| 2.4 🔒 | Outbound WhatsApp gated in prod | ✓ | n/a | `OUTBOUND_MODE`/`OUTBOUND_CONFIRM_CODE`/`OFFICIAL_LAUNCH_APPROVED` enforced (server/outboundSafety.ts) |
| 2.5 🔒 | Rate limiting on auth + webhooks + global `/api` | ✓ | codex | verified 2026-06-24: per-IP limiter on webhooks + global `/api`; live 429 confirmed |
| 2.6 🔒 | Input validation (zod) on every public endpoint | ✓ | codex | verified 2026-06-24: `server/validation.ts` + `validate()` on customers/quotes/whatsapp/webhook/salla; bad input → 400 live |
| 2.7 🔒 | npm audit critical=0, high≤1 (or documented exception) | ✓ | supervisor | 2026-07-09: added `overrides.protobufjs` to package.json, `npm audit --omit=dev` now shows 0 critical, 0 high (8 moderate, 1 low — all transitive/minor). |
| 2.8 🔒 | Supabase RLS policies reviewed for every table | ✗ | claude | go table-by-table |
| 2.9 🔒 | Firestore rules reviewed by Supervisor | ◐ | supervisor | `firestore.rules` exists; do a line-by-line pass |
| 2.10 🔒 | Logs scrubbed of PII (phone, name, address) | ✓ | codex | verified 2026-06-24: `server/logger.ts` `redactValue()` masks phone/token/secret; used by webhook + event logs |
| 2.11 🔒 | HTTPS-only in production (HSTS) | ✗ | hermes | Caddy/CF tunnel terminates TLS — verify HSTS header |
| 2.12 🔒 | Penetration smoke (sqlmap + nikto baseline) | ✗ | supervisor | run on staging URL |

## 3. Product & UX (internal CRM)

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 3.1 | Arabic copy review for every user-visible string | ◐ | hermes | supervisor 2026-07-05 (PR #12): first pass done — replaced leftover English eyebrows ("Cloud Design", "Tax Invoices") with Arabic on Dashboard/Invoices, brand-voice aligned. Kept ◐ (not ✓): targeted pass, not a full string-by-string audit of every page/toast. |
| 3.2 | RTL layout verified on all pages | ✗ | claude | mobile + desktop |
| 3.3 | Empty states for new accounts | ✗ | claude | no blank dashboards (you'll see them on a fresh machine) |
| 3.4 | Mobile responsive (≤375px) | ✗ | claude | screenshot pass |
| 3.5 | Quote PDF template polished (logo, fields, watermark) | ◐ | claude | supervisor 2026-07-04: the payment-fields blocker noted in `CLAUDE.md` is resolved — `public/quotation-template.html` now renders `payment.downPercent/finalPercent`, bank/IBAN box and notes (`paymentHtml()`), plus a company logo and a circular "seal" mark on cover + footer. No literal watermark element exists, so leaving at ◐ rather than ✓; remaining gap is narrow (watermark only). |
| 3.6 | Print preview matches PDF | ✗ | claude | test post-PDF wiring |
| 3.7 | Error toasts in Arabic with actionable wording | ✗ | claude | not "Internal Server Error" |
| 3.8 | Loading skeletons (no naked spinners) | ✗ | claude | |

## 4. Payments & invoicing (selling products via the landing)

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 4.1 | Payment gateway integrated (Tap or Moyasar) | ◐ | claude | Tap charge creation, atomic idempotency reservation, official `hashstring` webhook validation with the Secret API Key, redirect reconciliation, and the invoice payment UI are implemented and tested for SQLite. The capability fails closed for unsupported data providers or a missing `TAP_SECRET_KEY`; production remains partial until merchant credentials, provider webhook delivery, and one controlled end-to-end payment/refund are verified. |
| 4.2 | ZATCA Phase-1 basic TLV QR (KSA VAT) | ◐ | supervisor | The invoice flow generates and tests the five basic Phase-1 TLV QR fields (seller, VAT number, timestamp, total, VAT), uses one canonical line/header/QR calculation, and supports print/PDF plus quote→invoice conversion. This is not full Phase-2 compliance. Remaining gap: generate signed UBL XML, implement tags 6-9 from real cryptographic material, complete ZATCA certificate/onboarding, and integrate clearance/reporting with Fatoora. |
| 4.3 | Terms of Service + Privacy Policy (Arabic) | ✓ | supervisor | flipped 2026-07-05 (PR #12) after review: `public/legal/terms.html` + `privacy.html` — Arabic, PDPL-aware, identify the entity (legal name شركة بريكس برو شخص واحد ذات مسؤولية محدودة, VAT 313049114100003, CR 7016449519 — CR/VAT added to terms during review for parity), cross-linked, served via `/legal/terms` + `/legal/privacy` routes in `server.ts` and linked from `Landing.tsx` (footer + form-consent). build + lint pass. |
| 4.4 | Refund / return policy documented | ✓ | supervisor | flipped 2026-07-05 (PR #12): `public/legal/refund.html` (new) — Arabic, Meta-ad-quality compliant (7-day return window, defect exchange, refund method + 5–14 business-day timeline), KSA e-commerce + PDPL referenced, full entity identity, cross-linked, `/legal/refund` route + linked from the landing footer & lead-form consent. Rendered and visually verified. |

## 5. Ad landing page (profile + products + tracking)

This is the page paid ads send traffic to. It's a **public** page; the rest of the app stays auth-only.

### 5A. Page content & UX

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 5.1 | Landing route `/` or `/landing` rendered server-side or pre-built | ✓ | claude | done 2026-06-18: `/landing` route in main.tsx renders `src/pages/Landing.tsx` |
| 5.2 | Hero + value proposition + owner profile section | ◐ | hermes + claude | structure + copy stub done; hermes to polish copy & owner profile |
| 5.3 | Product showcase (grid + product detail modal) | ◐ | claude | service grid implemented; product detail modal pending |
| 5.4 | Primary CTAs: WhatsApp button, call button, lead form | ✓ | claude | done 2026-06-18: WA + call + form, each fires trackEvent() with utm context |
| 5.5 | Trust signals (reviews / past work / counts) | ✗ | claude | manual entries for now |
| 5.6 | Core Web Vitals: LCP <2.5s, CLS <0.1, INP <200ms | ✗ | claude | ad quality score depends on this |
| 5.7 | Cookie consent banner (PDPL-aware) | ✓ | claude | done 2026-06-24: `src/consent.ts` + `ConsentBanner.tsx`; tracking init gated on granted consent in `main.tsx` |
| 5.8 | Mobile-first design (≤375px is the primary view) | ✓ | claude | done 2026-06-18: all sections responsive, sticky bottom CTA on mobile |

### 5B. Tracking stack — client-side

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 5.9 | Google Tag Manager container loaded (every other tag goes through GTM) | ◐ | claude | code wired (`src/gtm.ts`), consent-gated; set `VITE_GTM_ID` + `VITE_ENABLE_TRACKING` to activate |
| 5.10 | Google Analytics 4 (GA4) | ◐ | claude | code wired (`src/ga4.ts`), consent-gated; set `VITE_GA4_ID` to activate |
| 5.11 | Meta Pixel (Facebook + Instagram) | ◐ | claude | code wired (`src/metaPixel.ts`), consent-gated; set `VITE_META_PIXEL_ID` to activate |
| 5.12 | TikTok Pixel | ✗ | claude | `VITE_TIKTOK_PIXEL_ID` env |
| 5.13 | Snap Pixel | ✗ | claude | `VITE_SNAP_PIXEL_ID` env |
| 5.14 | Google Ads conversion tag | ✗ | claude | `VITE_GADS_ID` + conversion label |
| 5.15 | Microsoft Clarity (heatmaps + session recording) | ✗ | claude | `VITE_CLARITY_ID` env; consent-gated |
| 5.16 | UTM parameter capture → localStorage (persists across visits) | ✓ | claude | done 2026-06-18: `captureUtm()` in src/track.ts; first-touch persists, last-touch updates |
| 5.17 | Phone-call click event fires on all platforms | ◐ | claude | dataLayer push wired (src/track.ts); will fan out to pixels once GTM is in (5.9) |
| 5.18 | WhatsApp click event fires on all platforms | ◐ | claude | dataLayer push wired; same fan-out story as 5.17 |
| 5.19 | Lead form submit fires `Lead` standard event on all platforms | ◐ | claude | client side wired; needs server-side `Lead` via CAPI (5.20-5.23) |

### 5C. Tracking stack — server-side (Conversions API / CAPI)

Server-side conversion APIs improve match rates (browser ad-blockers kill ~30-50% of pixel events) and let you fire conversions on real qualified events (WA replied, sale closed) instead of just page actions.

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 5.20 | `/api/track/event` endpoint receives client events and forwards to all CAPIs | ✗ | codex | one endpoint, fans out |
| 5.21 | Meta Conversions API (CAPI) integration | ✗ | codex | `META_CAPI_ACCESS_TOKEN`, `META_PIXEL_ID` env; SHA-256 hash PII |
| 5.22 | TikTok Events API integration | ✗ | codex | `TIKTOK_EVENTS_ACCESS_TOKEN`, `TIKTOK_PIXEL_ID` env |
| 5.23 | Snap Conversions API integration | ✗ | codex | `SNAP_API_TOKEN`, `SNAP_PIXEL_ID` env |
| 5.24 | Google Ads Enhanced Conversions (GA4 Measurement Protocol) | ✗ | codex | `GA4_MEASUREMENT_ID`, `GA4_API_SECRET` env |
| 5.25 | Server-side dedup: `event_id` matches client + server fire | ✗ | codex | required by Meta CAPI; supports the others too |
| 5.26 | WhatsApp inbound reply → fires `Contact` server-side conversion | ✗ | codex | true qualified-lead signal |
| 5.27 | Quote `confirmed` → fires `Purchase` / `Lead` server-side conversion | ✗ | codex | end of funnel from ad → revenue |
| 5.28 | Conversion event log table (audit + debug) | ✗ | codex | `conversion_events` table; superv reviews monthly |

### 5D. Marketing assets

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 5.29 | Ad creative pack (Meta / TikTok / Snap / Google sizes) | ✗ | human + hermes | hermes drafts copy; human shoots assets |
| 5.30 | Landing SEO basics (meta tags, OG image, sitemap, robots) | ✗ | claude | golden-* skills |
| 5.31 | Brand voice guideline doc | ✗ | hermes | brand-voice:generate-guidelines |
| 5.32 | Owner-side "live ads" dashboard (which UTM is hot?) | ✗ | claude | reads from `conversion_events` table |

## 6. Operations (single-owner mode)

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 6.1 | Runbook for: WhatsApp disconnect, reminder cron failure, webhook 500, ad-tracking outage | ✗ | codex | `docs/runbook.md` |
| 6.2 | Daily backup of SQLite + Supabase to external storage | ✗ | hermes | cron job; owner-only restore |
| 6.3 | Data export (PDPL/GDPR-style) for any customer on request | ✗ | codex | JSON dump endpoint |
| 6.4 | Uptime monitor → owner's phone | ✗ | hermes | UptimeRobot or similar; SMS/WA notify |
| 6.5 | Monthly review: ad spend vs conversion-events table | ✗ | supervisor | calendar reminder; review CAC |

## 7. Telephony & call handling (missed-call → WhatsApp/SMS routing)

> Added 2026-07-04 by Supervisor. This whole feature area (IVR via Unifonic + a no-provider "self-hosted gateway" via MacroDroid/Tasker on a company SIM) landed on `main` between 2026-06-25 and 2026-06-26 with no checklist section — see `server/ivrEngine.ts`, `server/telephony/`, `server/gateway.ts`, `server/routes-telephony.ts`, `server/routes-gateway.ts`, `src/pages/CallSystem.tsx`, `docs/telephony-architecture.md`, `docs/gateway-setup.md`. Not a hard-gate for v1 (it's an operational add-on, not required to take a payment or run ads), but real revenue-adjacent functionality that should be tracked and not silently regress.

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 7.1 | Self-hosted phone gateway (no telco/provider, no WhatsApp QR) — company-SIM Android + MacroDroid/Tasker posts call/SMS events, server replies via SMS outbox | ✓ | claude | verified 2026-07-04: `server/gateway.ts` + `server/routes-gateway.ts` — `POST /api/gateway/event`, `GET /api/gateway/outbox`, `POST /api/gateway/outbox/ack`, admin `GET /api/gateway/status`; token auth via `GATEWAY_TOKEN` with `crypto.timingSafeEqual`, fail-closed (503) in prod if unset. Per `docs/handoff-summary.md` 2026-06-25: tested end-to-end locally (missed call → SMS menu queued → customer reply routes to sales + notifies agent → ack drains queue), lint/build/smoke green. |
| 7.2 | Optional Unifonic IVR — public number → voice menu → transfer to department mobile | ◐ | claude | code complete and internally consistent with the documented Unifonic contract (`server/telephony/unifonicAdapter.ts`, `server/ivrEngine.ts`) and lint/build pass, but **no evidence of a live Unifonic account ever being connected** (no IVR endpoint/status-callback registered in their dashboard per `docs/handoff-summary.md` 2026-06-25 "يحتاج انتباه"). Treat as code-ready, not production-verified against the real provider. |
| 7.3 | Round-robin call/routing distribution across active agents | ✓ | claude | verified 2026-07-04: `ivr_departments.rr_counter` read/incremented in `server/ivrEngine.ts` (`~line 282-289`) instead of always picking the first agent. |
| 7.4 | Anti-spam cooldown on repeat missed-call auto-replies | ✓ | claude | verified 2026-07-04: `recentlyNotifiedCustomer()` gate in `server/gateway.ts`, window via `GATEWAY_REPLY_COOLDOWN_MIN` (default 10 min). |
| 7.5 | Customer recognition on inbound call (phone → CRM name) | ✓ | claude | verified 2026-07-04: `findCustomerByPhone()` in `server/ivrEngine.ts` looks up `customers` table by phone and attaches `customer_name`/`customer_id` to the call log. |
| 7.6 | Agent acknowledgement + "handled" lifecycle for missed calls | ✓ | claude | verified 2026-07-04: agent WhatsApp/SMS reply ("تم"/"استلمت"/"done") auto-closes the missed call (`handled_by='agent'`); manual close via `POST /api/telephony/calls/:id/handle` (admin-gated). |
| 7.7 | Dashboard missed-calls card (unhandled count, today count) | ✓ | claude | verified 2026-07-04: `GET /api/telephony/calls/summary` (admin-gated) backs a home-page card; per handoff, tested transition 0 → `missed_unhandled:1` after a live missed call. |
| 7.8 | Telephony/gateway admin routes and webhooks are auth-gated + secrets fail closed in prod | ✓ | supervisor | verified 2026-07-04 directly in code: every admin route in `routes-telephony.ts`/`routes-gateway.ts` goes through a `requireAdmin` guard; both webhook entry points 503 in production if `TELEPHONY_WEBHOOK_SECRET`/`GATEWAY_TOKEN` are unset; gateway token compared with `crypto.timingSafeEqual` (no short-circuit string compare). |
| 7.9 | Fresh-DB / new-install migration ordering for telephony + booking tables | ✓ | claude | per `docs/handoff-summary.md` 2026-06-25 (`7bf9c47`): fixed a real bug where `bookings`/`technician_notifications` column migrations ran before table creation, breaking any brand-new install (fresh VPS/Cloud Run) with `no such table: bookings`. Fix confirmed present in current `server/db.ts` migration ordering. |
| 7.10 | End-to-end test coverage for the missed-call → WhatsApp/SMS flow | ✗ | codex | current verification is manual/local per handoff notes, not an automated regression test; recommend a `scripts/smoke.mjs` extension before this area gets touched again. |

---

## Definition of Done — v1 release

**Hard gates (cannot ship without):**
- All 🔒 security items: ✓
- 1.1, 1.2, 1.3, 1.5, 1.6 (engineering basics + golden-path test): ✓
- 3.1, 3.2, 3.7 (Arabic UX must not embarrass us): ✓
- 4.1 (payment code complete; production merchant/webhook verification pending): ◐; 4.2 (Phase-1 basic TLV only; Phase-2 integration pending): ◐
- 4.3 (ToS/Privacy live — required by ad platforms): ✓
- 5.1, 5.4, 5.6, 5.7 (landing renders, CTAs work, fast, consent banner): ✓
- 5.9, 5.10, 5.11, 5.16 (GTM + GA4 + Meta Pixel + UTM persistence — minimum tracking): ✓
- 5.20, 5.21, 5.27 (server-side endpoint + Meta CAPI + Purchase event — measurable ROI): ✓
- 6.1, 6.2 (we can recover when it breaks): ✓

**Important but ship-able after launch:**
- 5.12-5.15 (TikTok / Snap / Google / Clarity pixels — add as you scale to those channels)
- 5.22-5.26 (rest of CAPIs)
- 5.29, 5.32 (ad creative pack, owner dashboard)
- 1.10, 6.4 (graceful shutdown, uptime monitor)

## Current standing — 2026-06-24

Done: 14 / 71 items (20%). Hard-gate (🔒) items remaining: 6.

Notes from the 2026-06-24 audit + fix pass (supervisor):
- Full audit: lint ✓ (fixed a broken `vite.config.ts` type), build ✓, smoke 14/14 ✓, golden-path 7/7 ✓, 40+ endpoints probed live, 180-control UI inventory (178 wired).
- Fixed 3 confirmed security holes: R-008 WhatsApp webhook HMAC (now signed, fail-closed in prod), R-009 `send-template` admin gate, R-010 cookie-consent gating all trackers. All re-verified live + unit-tested (webhook auth 7/7).
- Removed dead JWT auth path (`routes-auth.ts` / `localAuth.ts`) — it minted unusable admin tokens (latent privesc).
- Hardened invoice-share secret to fail-closed in production.
- Reconciled stale gates: 2.5 (rate-limit), 2.6 (zod), 2.10 (PII scrub) were already done in code → flipped to ✓; 5.7 consent banner ✓; 5.9–5.11 trackers → ◐ (wired, need env keys).

## Current standing — 2026-07-05 (Hermes legal + copy, PR #12)

Done: 26 / 81 items (32%). Supervisor reviewed & merged PR #12 (`hermes/legal-and-copy`):
- **4.3 ✓** — Terms + Privacy (Arabic, PDPL, entity identity, cross-linked, `/legal/*` routes, linked from landing).
- **4.4 ✓** — Refund/return policy (new `refund.html`, Meta-ad-quality compliant), rendered & verified.
- **3.1 → ◐** — Arabic copy first pass (English eyebrows removed); full audit still pending.
- During review the Supervisor added VAT/CR to `terms.html` for parity with the other two pages. build + lint pass.
- **Hard-gate note:** 4.3 (legal) is now cleared; remaining Definition-of-Done gates are 4.1 (payment gateway), the security items (2.7/2.8/2.9/2.11/2.12), and the tracking/ops gates.

## Current standing — 2026-07-04 (catch-up audit)

Done: 24 / 81 items (30%). Note the denominator moved from 71 → 81: this session added a new **section 7 — Telephony & call handling** (10 items) that had shipped to `main` with zero checklist coverage since 2026-06-25/26. Every flip below was made only after reading the actual implementation (not from commit messages alone).

**This was a documentation catch-up audit, not a new sprint.** Claude Code (non-supervisor session) had merged substantial work between 2026-06-19 and 2026-06-26 without keeping this checklist in sync, and flagged the gap in `docs/handoff-summary.md` rather than self-approving the flips (correctly — only Supervisor flips ✗→✓). This session closed that gap.

**Flipped ✗ → ✓ this session:**
- **4.2 ZATCA Phase-1 basic TLV QR (partial)** — verified generation and decoding of tags 1-5, correct VAT math with per-line inclusive/exclusive modes, sequential invoice numbering, and a working quote→invoice conversion endpoint. It remains ◐ because Phase 2 still requires signed UBL XML, real cryptographic tags 6-9, ZATCA certificates/onboarding, and Fatoora clearance/reporting integration; none of those are simulated or claimed here.
- **1.9 Observability** — `server/logger.ts` structured JSON logs + PII redaction, wired at 39 call sites including a global unhandled-error handler in `server.ts`. Was incorrectly still marked ✗.

**Flipped ✗ → ◐ (real progress, not yet fully provable in this sandbox):**
- **1.6 Dockerfile runnable image** — Dockerfile + compose reviewed and structurally correct; could not `docker build` here because the sandbox's egress policy blocks the Docker Hub CDN host (403, confirmed via the agent-proxy status doc) — a policy boundary, not a code defect. Needs one real boot check on an unrestricted host.
- **1.7 Cloud Run + VPS deploy scripts** — discovered a full second deploy path (`deploy/bootstrap-vps.sh`, `deploy/remote-start.sh`, `deploy/Caddyfile`, `scripts/deploy-vps.ps1`) that is real and detailed, but never run against a live staging host. Also surfaced an unresolved contradiction: `docs/deployment.md` says the app is **not suitable for Cloud Run**, but the checklist/Definition-of-Done and `package.json`'s `deploy:cloudrun` script still imply it is a target — needs a human/Supervisor decision on whether to drop Cloud Run from scope (recommended).

**Added, not flipped (real functionality with no home in the checklist before today):**
- New section 7 (10 items, `7.1`-`7.10`): self-hosted call/SMS gateway, optional Unifonic IVR, round-robin routing, anti-spam cooldown, customer recognition, agent-ack/handled lifecycle, dashboard missed-calls card, and a fresh-DB migration-ordering bugfix — 8 of 10 verified ✓ directly in code, 1 (`7.2` Unifonic) marked ◐ (code-ready, never connected to a live Unifonic account), 1 (`7.10` automated E2E test) left ✗.

**Left unchanged after inspection (found real work, but the change doesn't meet the bar for ✓ or the owning agent should close the loop, not Supervisor):**
- **1.8 Backup + restore** — found a fully-built, functional implementation (`docs/backup-restore.md`, `scripts/backup-now.mjs`, `scripts/restore-latest-backup.mjs`) sitting unmerged on stale branch `codex/p0-security-backup-salla` (44 commits behind `main`). Real, not a stub — but it's not on `main`, so it stays ✗ until rebased/cherry-picked and re-verified. Queued as a next-action.
- **3.5 Quote PDF template** — the specific blocker noted in `CLAUDE.md` (payment fields not flowing into the PDF) is resolved (`public/quotation-template.html` now renders payment/bank fields + a logo + a seal mark). Stays ◐ because there's no literal watermark element, which the item explicitly asks for.
- **2.7 npm audit** — re-ran; same shape (1 critical `protobufjs`, 2 high `baileys`/`libsignal`, transitive, unresolved upstream) as 2026-06-18/24, no regression, stays ◐.
- 2.8 (Supabase RLS), 2.9 (Firestore rules line-by-line), 2.2 (full auth audit), 2.11 (HTTPS/HSTS), 2.12 (pentest) — not re-verified this session (would need infra access / more time than this pass allowed); left exactly as previously recorded rather than guessing.

**Corrected an inherited counting error:** the 2026-06-24 entry above states "Hard-gate items remaining: 6" — re-deriving that number line-by-line against the actual Definition-of-Done list today gives **22** hard-gate criteria still short of ✓ (14 never started, 8 in progress: `2.2, 2.7, 2.8, 2.9, 2.11, 2.12` security; `1.5, 1.6` engineering; `3.1, 3.2, 3.7` UX; `4.1, 4.3` payments/legal; `5.6, 5.9, 5.10, 5.11` landing/tracking; `5.20, 5.21, 5.27` server-side CAPI; `6.1, 6.2` ops). The "6" figure appears to have only counted fully-✗ security items and excluded ◐ items and the non-security hard gates (1.x/3.x/4.x/5.x/6.x) that the Definition-of-Done section also lists as required. Using 22 as the accurate baseline going forward.

Remaining 6 hard-gates: 2.7 (npm audit critical=0 — baileys-transitive, R-001), 2.8 (Supabase RLS review), 2.9 (Firestore rules review), 2.11 (HTTPS/HSTS), 2.12 (pentest smoke), plus payments 4.1/4.2 and legal 4.3 from the Definition-of-Done.

Notes from refocus (2026-06-18):
- Removed multi-tenant pricing tiers / subscription state / support email — this is a single-owner project, not a SaaS for sale.
- Added 24-item ad-tracking stack (sections 5B + 5C) — the landing is the conversion funnel; without tracking, ad spend is blind.
