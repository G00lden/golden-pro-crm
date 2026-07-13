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
|| 2.7 🔒 | npm audit critical=0, high≤1 (or documented exception) | ✓ | supervisor | 2026-07-09: added `overrides.protobufjs` to package.json, `npm audit --omit=dev` now shows 0 critical, 0 high (8 moderate, 1 low — all transitive/minor). |
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
|| 4.1 | Payment gateway integrated (Tap or Moyasar) | ✓ | claude | supervisor 2026-07-09: Tap payment gateway integrated — `server/routes-payment.ts` (613 lines, charge creation + HMAC webhook), `payments` table in db.ts, frontend \"ادفع الآن\" button on invoices, `createPayment()` in api.ts. Supports MADA, Apple Pay, STC Pay via `src_all`. Sandbox-tested. Build verified (15.69s, 0 errors). Production needs Tap merchant account (KSA business docs). |
| 4.2 | ZATCA-compliant invoice (KSA VAT) | ✓ | supervisor | flipped 2026-07-04 after code verification (not just commit-message trust): `src/pages/Invoices.tsx` implements real ZATCA Phase-1 TLV QR encoding (`generateZATCAQR` — tags 1-5: seller name, VAT number, ISO timestamp, total incl. VAT, VAT amount; base64 TLV, matches the published simplified-tax-invoice spec), rendered both live (`QRCodeDisplay`) and baked into the exported/printed PDF (`replaceInvoiceQrInClone`) via the `qrcode` npm package. `server/crmApi.ts` computes VAT correctly with per-line-item inclusive/exclusive modes (`vat_excluded` flag, `invoiceTotals()`), generates sequential `invoice_number`s (`INV-YYYYMMDD-NNN`), supports full CRUD + a real `POST /api/quotes/:id/convert-to-invoice` (quote→invoice conversion, not a stub), and stores `seller_vat_number`/`seller_name`/`seller_address`. This is functional, wired end-to-end, not a stub. Residual gap (does not block ✓ but worth tracking): no automated test asserts the TLV bytes decode to the exact values shown on screen — recommend adding one under 1.3/smoke coverage. |
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

> أُعيد تدقيق هذا القسم في 2026-07-13. مصدر الرد الصوتي والتحويل هو Unifonic حصراً. بوابة Android/MacroDroid قناة SMS احتياطية عند تعذر واتساب ولا تجيب عن المكالمات. راجع `docs/telephony-architecture.md` للعقد التشغيلي والأمني الحالي.

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 7.1 | Android gateway as SMS fallback only | ✓ | codex | `communication_outbox` tries WhatsApp first, then enqueues one idempotent SMS in `gateway_outbox`; Android is not advertised or used as voice ingress. |
| 7.2 | Unifonic IVR — public number → voice menu → one round-robin specialist | ◐ | codex | العقد الجديد منفذ ومحمي: GET أولي مع Authorization، POST اختيار العميل برمز جلسة مجزأ ومؤقت، وStatus POST مع Basic Authentication مستقل. يبقى الاختبار برقم Unifonic الحقيقي بوابة الإنتاج. |
| 7.3 | Round-robin call/routing distribution across active agents | ✓ | claude | verified 2026-07-04: `ivr_departments.rr_counter` read/incremented in `server/ivrEngine.ts` (`~line 282-289`) instead of always picking the first agent. |
| 7.4 | Anti-spam cooldown on repeat missed-call auto-replies | ✓ | claude | verified 2026-07-04: `recentlyNotifiedCustomer()` gate in `server/gateway.ts`, window via `GATEWAY_REPLY_COOLDOWN_MIN` (default 10 min). |
| 7.5 | Customer recognition on inbound call (phone → CRM name) | ✓ | codex | المطابقة تمر عبر مستودع CRM المحدد (SQLite/Supabase/Firestore) وتربط العميل من دون إنشاء عميل تلقائياً. |
| 7.6 | Independent call + follow-up lifecycle | ✓ | codex | `call_status` لا يتغير عند إغلاق المتابعة؛ `follow_up_status/outcome/notes` مستقلة، والمختص يرى المكالمات المسندة إليه فقط. |
| 7.7 | Dashboard missed-calls card (unhandled count, today count) | ✓ | claude | verified 2026-07-04: `GET /api/telephony/calls/summary` (admin-gated) backs a home-page card; per handoff, tested transition 0 → `missed_unhandled:1` after a live missed call. |
| 7.8 | Telephony admin routes and webhooks are auth-gated + retry-safe | ✓ | codex | إعدادات الهاتف للمسؤول/المدير؛ سجل المختص مقيّد بالتعيين؛ الأسرار تفشل مغلقة في الإنتاج؛ فشل حفظ الحدث يعيد 503 والمكرر يعيد 200 بلا أثر جانبي مكرر. |
| 7.9 | Fresh-DB / new-install migration ordering for telephony + booking tables | ✓ | claude | per `docs/handoff-summary.md` 2026-06-25 (`7bf9c47`): fixed a real bug where `bookings`/`technician_notifications` column migrations ran before table creation, breaking any brand-new install (fresh VPS/Cloud Run) with `no such table: bookings`. Fix confirmed present in current `server/db.ts` migration ordering. |
| 7.10 | Automated regression coverage for IVR/status/CRM/outbox flow | ✓ | codex | `npm run test:telephony` يغطي الجلسات المتكررة، الحماية، dedupe، الأحداث المتأخرة، round-robin، صلاحيات المختص، Lead، والحول إلى SMS. |

---

## Definition of Done — v1 release

**Hard gates (cannot ship without):**
- All 🔒 security items: ✓
- 1.1, 1.2, 1.3, 1.5, 1.6 (engineering basics + golden-path test): ✓
- 3.1, 3.2, 3.7 (Arabic UX must not embarrass us): ✓
- 4.1, 4.2 (can collect a payment + invoice it): ✓
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
- **4.2 ZATCA-compliant invoice** — verified real TLV QR generation (`src/pages/Invoices.tsx: generateZATCAQR`, tags 1-5 per the published spec), correct VAT math with per-line inclusive/exclusive modes, sequential invoice numbering, and a working quote→invoice conversion endpoint. This closes one of the two 4.x payment/invoicing hard-gates (4.1 payment gateway is still ✗).
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
