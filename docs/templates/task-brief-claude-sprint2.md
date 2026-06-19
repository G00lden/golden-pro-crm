# Task Brief — GTM + GA4 + Meta Pixel client-side tracking

> Supervisor sprint #2. Owner: **Claude Code**.
> Deliver on branch `claude/ad-tracking-gtm-pixels`.

## Release-checklist links

- `5.9` — Google Tag Manager container loaded (every other tag goes through GTM)
- `5.10` — Google Analytics 4 (GA4)
- `5.11` — Meta Pixel (Facebook + Instagram)

## Goal

The landing page (`/landing`) already calls `trackEvent()` from `src/track.ts` which pushes to `window.dataLayer` and attempts `POST /api/track/event`. But GTM, GA4, and Meta Pixel are **completely missing** — no container loaded, no tags, no measurement. Without these, ad spend is blind: we fire events into the void.

Wire the full client-side tracking stack:
1. **GTM container** — loads via `<script>` in the HTML. Every pixel goes through GTM as a single source of truth.
2. **GA4** — fires page_view, wa_click, call_click, lead_submit as GA4 events (enhanced measurement on).
3. **Meta Pixel** — fires the same events as standard Meta events (Lead, Contact, ViewContent).

## Files of interest

- `src/track.ts` — existing tracking shim. Already pushes to `window.dataLayer`. This is the wire: GTM listens to dataLayer.push().
- `src/pages/Landing.tsx` — calls `trackEvent()` on every CTA click. Add a `loadGTM()` call in the mount effect.
- `index.html` or `src/main.tsx` — entry point where GTM script should load (or conditionally in Landing.tsx).
- `src/vite-env.d.ts` — may need type declarations for GTM / fbq globals.
- `.env.example` — should document `VITE_GTM_ID`, `VITE_GA4_ID`, `VITE_META_PIXEL_ID`.

## Inputs you can rely on

- GTM container ID format: `GTM-XXXXXXX`. We'll use a placeholder env var `VITE_GTM_ID` — the user fills in the real ID.
- GA4 measurement ID format: `G-XXXXXXXXXX`.
- Meta Pixel ID format: `1234567890`.
- Existing `captureUtm()` call in Landing.tsx already persists first-touch UTM in localStorage.
- `trackEvent()` pushes `{ event, event_id, value, currency, utm, page, ts }` to `window.dataLayer`.
- The project uses **Vite** — env vars are `import.meta.env.VITE_*`.

## What to build

### 5.9 — GTM container

1. Create `src/gtm.ts` with:
   - `loadGTM(containerId: string)` — injects GTM `<script>` and `<noscript>` into document head/body. Only call once.
   - Exports `initializeTracking(env: Record<string, string | undefined>)` that reads `VITE_GTM_ID`, `VITE_GA4_ID`, `VITE_META_PIXEL_ID` and calls loadGTM if GTM_ID is present.
2. In `src/main.tsx` or `src/pages/Landing.tsx`, call `initializeTracking(import.meta.env)` early in the component tree (before any trackEvent call).
3. Ensure GTM loads only on `/landing` route (not on auth-protected CRM pages), or make it conditional via an env flag like `VITE_ENABLE_TRACKING=true`.

### 5.10 — GA4 via GTM

1. In the landing page's mount effect, configure GTM to also handle GA4. The cleanest approach: after GTM loads, also fire a direct `gtag('config', GA4_ID)` call to ensure GA4 works even if GTM config lags.
2. Create `src/ga4.ts`:
   - `initGA4(measurementId: string)` — loads gtag.js inline if GTM is not available, or relies on GTM's built-in GA4 tag.
   - `ga4Event(name: string, params?: Record<string, unknown>)` — fires a GA4 event via gtag.
3. Wire `trackEvent()` in `src/track.ts` to also call `ga4Event()` when GA4 is initialized, so we have a direct path independent of GTM.

### 5.11 — Meta Pixel

1. Create `src/metaPixel.ts`:
   - `initMetaPixel(pixelId: string)` — injects Meta Pixel base code into document head (standard fbq init).
   - `trackMetaEvent(eventName: string, params?: Record<string, unknown>)` — wraps `fbq('track', eventName, params)`.
2. Wire `trackEvent()` to also call `trackMetaEvent()`.
3. Map standard trackEvent names to Meta standard events:
   - `page_view` → `PageView`
   - `wa_click` → `Contact` (with `{ content_name: 'WhatsApp Click', content_category: source }`)
   - `call_click` → `Contact` (with `{ content_name: 'Phone Call', content_category: source }`)
   - `lead_submit` → `Lead` (with `{ value, currency, ... }` when present)

### Config file

4. Update `.env.example` to include all three IDs:
   ```
   VITE_GTM_ID=
   VITE_GA4_ID=
   VITE_META_PIXEL_ID=
   VITE_ENABLE_TRACKING=false
   ```

### Type declarations

5. Add to `src/vite-env.d.ts`:
   - GTM `dataLayer` type
   - `fbq` type (Meta Pixel)
   - `gtag` type (GA4)

## Success criteria (mechanical)

- [ ] `npm run lint` passes
- [ ] `npm run build` passes
- [ ] `npm run test:smoke` still green
- [ ] With `VITE_GTM_ID` set and `VITE_ENABLE_TRACKING=true`, visiting `/landing` shows the GTM container loaded in Network tab
- [ ] With `VITE_GA4_ID` set, GA4 network requests appear on page load
- [ ] With `VITE_META_PIXEL_ID` set, `fbq` network requests appear on page_view, wa_click, and lead_submit events
- [ ] Without any env var set, no tracking scripts load (zero impact on dev)
- [ ] No errors in browser console related to missing tracking IDs

## Out of scope

- TikTok / Snap / Google Ads / Clarity pixels (5.12–5.15)
- Server-side CAPI (5.20+)
- Cookie consent banner (5.7 — a separate task)
- The `POST /api/track/event` server endpoint

## Time-box

3–4 hours. If GTM container setup is complex, deliver GA4 + Meta Pixel direct (without GTM) in round 1 and add GTM in a follow-up PR.

## PR template

```bash
git add -A
git commit -m "feat: GTM + GA4 + Meta Pixel client-side tracking stack"
git push -u origin claude/ad-tracking-gtm-pixels
gh pr create --base main \\
  --title "feat: client-side ad tracking (GTM + GA4 + Meta Pixel)" \\
  --body "Closes 5.9, 5.10, 5.11. See docs/templates/task-brief-claude-sprint2.md"
```
