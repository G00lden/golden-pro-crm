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
| 1.6 | Dockerfile produces a runnable image | ✗ | hermes | `docker run -p 3000:3000` boots + /api/health = ok |
| 1.7 | Cloud Run + VPS deploy scripts both succeed once on staging | ✗ | hermes | use existing `deploy:cloudrun` / `deploy:vps` |
| 1.8 | Backup + restore for SQLite + Supabase documented | ✗ | claude | `docs/backup-restore.md` — own-data risk |
| 1.9 | Observability: errors → log file or Sentry | ✗ | codex | structured logs at minimum |
| 1.10 | Graceful shutdown drains in-flight WA messages | ✗ | codex | SIGTERM handler |

## 2. Security 🔒

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 2.1 🔒 | No secrets ever in repo (precheck scan clean) | ✓ | supervisor | `.gitignore` hardened; `npm run supervisor:precheck` enforces |
| 2.2 🔒 | Auth required on every mutating `/api/*` route | ◐ | supervisor | spot-checked; need full audit |
| 2.3 🔒 | Store webhook HMAC verification mandatory in prod | ✓ | n/a | implemented in `server/storeWebhook.ts` |
| 2.4 🔒 | Outbound WhatsApp gated by launch code in prod | ✓ | n/a | `OUTBOUND_LAUNCH_CODE` enforced |
| 2.5 🔒 | Rate limiting on `/api/auth/*` and webhook | ✗ | codex | express-rate-limit; per-IP + per-account |
| 2.6 🔒 | Input validation (zod) on every public endpoint | ✗ | codex | currently ad-hoc |
| 2.7 🔒 | npm audit critical=0, high≤1 (or documented exception) | ◐ | codex | 2026-06-18: `npm audit fix` reduced 25→12 vulns (1 critical, 2 high remaining — baileys/protobuf transitive) |
| 2.8 🔒 | Supabase RLS policies reviewed for every table | ✗ | claude | go table-by-table |
| 2.9 🔒 | Firestore rules reviewed by Supervisor | ◐ | supervisor | `firestore.rules` exists; do a line-by-line pass |
| 2.10 🔒 | Logs scrubbed of PII (phone, name, address) | ✗ | codex | redact in middleware |
| 2.11 🔒 | HTTPS-only in production (HSTS) | ✗ | hermes | Caddy/CF tunnel terminates TLS — verify HSTS header |
| 2.12 🔒 | Penetration smoke (sqlmap + nikto baseline) | ✗ | supervisor | run on staging URL |

## 3. Product & UX (internal CRM)

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 3.1 | Arabic copy review for every user-visible string | ✗ | hermes | brand-voice skill |
| 3.2 | RTL layout verified on all pages | ✗ | claude | mobile + desktop |
| 3.3 | Empty states for new accounts | ✗ | claude | no blank dashboards (you'll see them on a fresh machine) |
| 3.4 | Mobile responsive (≤375px) | ✗ | claude | screenshot pass |
| 3.5 | Quote PDF template polished (logo, fields, watermark) | ◐ | claude | payment fields wiring in progress |
| 3.6 | Print preview matches PDF | ✗ | claude | test post-PDF wiring |
| 3.7 | Error toasts in Arabic with actionable wording | ✗ | claude | not "Internal Server Error" |
| 3.8 | Loading skeletons (no naked spinners) | ✗ | claude | |

## 4. Payments & invoicing (selling products via the landing)

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 4.1 | Payment gateway integrated (Tap or Moyasar) | ✗ | codex | KSA-first; capture card + Apple Pay + STC Pay if Tap |
| 4.2 | ZATCA-compliant invoice (KSA VAT) | ✗ | supervisor | required by law for KSA sales |
| 4.3 | Terms of Service + Privacy Policy (Arabic) | ✗ | hermes | also required by Meta / TikTok / Google to run ads |
| 4.4 | Refund / return policy documented | ✗ | hermes | shown on the landing — required by Meta ad-quality |

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
| 5.7 | Cookie consent banner (PDPL-aware) | ✗ | claude | required before firing any pixel |
| 5.8 | Mobile-first design (≤375px is the primary view) | ✓ | claude | done 2026-06-18: all sections responsive, sticky bottom CTA on mobile |

### 5B. Tracking stack — client-side

| # | Item | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 5.9 | Google Tag Manager container loaded (every other tag goes through GTM) | ✗ | claude | `VITE_GTM_ID` env, gated by consent |
| 5.10 | Google Analytics 4 (GA4) | ✗ | claude | via GTM, anonymize_ip, enhanced measurement on |
| 5.11 | Meta Pixel (Facebook + Instagram) | ✗ | claude | `VITE_META_PIXEL_ID` env |
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

## Current standing — 2026-06-18

Done: 6 / 65 items (9%). Hard-gate items remaining: ~24.

Notes from refocus (2026-06-18):
- Removed multi-tenant pricing tiers / subscription state / support email — this is a single-owner project, not a SaaS for sale.
- Added 24-item ad-tracking stack (sections 5B + 5C) — the landing is the conversion funnel; without tracking, ad spend is blind.
- Promoted golden-path test to ✓ (`npm run test:golden` passes 7/7).
- npm audit improved 25→12 vulns; remaining 1 critical + 2 high are baileys-transitive — tracked as risk R-001 in `risk-register.md`.
