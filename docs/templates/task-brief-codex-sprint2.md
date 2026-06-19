# Task Brief — 🔒 Rate limiting hardening + Zod input validation

> Supervisor sprint #2. Owner: **Codex**.
> Two security-hard-gate items. Deliver on branch `codex/security-rate-limit-zod`.

## Release-checklist links

- `2.5 🔒` — Rate limiting on `/api/auth/*` and webhook; per-IP + per-account
- `2.6 🔒` — Input validation (zod) on every public endpoint

## Goal

The current rate limiter is in-memory-only and applies a single coarse bucket (240 req/min to all `/api/*`, 120 req/min to webhooks). For a commercial v1, we need:

1. **Per-IP + per-account rate limiting** — in-memory is fine for single-owner; the key enhancement is **per-authenticated-UID tracking** so one aggressive customer session cannot starve the operator.
2. **Input validation with zod** on every public endpoint that accepts request body — currently validation is ad-hoc (`if (!req.body?.xxx) throw ...`). Replace with zod schemas. This prevents unexpected payloads from reaching business logic.

## Files of interest

- `server.ts` — `createRateLimiter()` at line 165, `apiRateLimit` at line 268, `webhookRateLimit` at line 273. All existing routes at lines 280–920.
- `server/crmApi.ts` — routes registered here; need zod schemas per endpoint.
- `package.json` — need to add `zod` dependency (currently not listed).

## Inputs you can rely on

- In-memory Map-based rate limiter already exists as `createRateLimiter(options)`.
- `clientIp()` helper already extracts real IP from X-Forwarded-For.
- Express `asyncRoute` wrapper exists (line 77).
- Existing `requireFirebaseUser` middleware attaches `(req as AuthedRequest).user: { uid, role, email }`.
- `.env.example` already documents `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX`, `WEBHOOK_RATE_LIMIT_WINDOW_MS`, `WEBHOOK_RATE_LIMIT_MAX`.

## What to build

### Rate limiting (2.5)

1. Augment `createRateLimiter` to accept an optional `keyFn: (req) => string` parameter that lets callers key on UID instead of IP for authenticated routes. Fall back to IP when `keyFn` is absent.
2. Create a separate `authRateLimit` instance: window=5min, max=20 attempts, keyed by IP (for the login/unauthenticated auth endpoints).
3. Apply `authRateLimit` to `/api/auth/*` and any unauthenticated mutation paths:
   - `/api/auth/login` (local auth)
   - `/api/auth/register`
4. Ensure `apiRateLimit` (240/min per IP) still covers all authenticated routes.
5. Add `RateLimit-By` header to responses so the frontend can hint which bucket was hit.

### Zod validation (2.6)

1. `npm install zod` (add to dependencies).
2. Create `server/validation.ts` with a helper:
   ```ts
   import { z } from 'zod';
   import { Request, Response, NextFunction } from 'express';

   export function validate(schema: z.ZodSchema) {
     return (req: Request, res: Response, next: NextFunction) => {
       const result = schema.safeParse(req.body);
       if (!result.success) {
         res.status(400).json({
           error: 'Validation failed',
           details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
         });
         return;
       }
       req.body = result.data; // use parsed/coerced data
       next();
     };
   }
   ```
3. Define zod schemas for **every mutation endpoint** that takes a body. Start with these (most security-relevant):
   - `POST /api/auth/login` — `{ email, password }` (both strings)
   - `POST /api/store/webhook` — flexible schema (the webhook body shape from Salla/Meta is variable; keep an open schema but reject non-object payloads)
   - `POST /api/whatsapp/send-test` — `{ phone: string, message?: string }`
   - `POST /api/escalations/:id/resolve` — `{ notes?: string }`
   - `POST /api/escalations/:id/assign` — `{ assigned_to: string, notes?: string }`
   - `POST /api/bookings/pre-alerts/run` — no body
   - `POST /api/leads/public` (Landing.tsx form) — `{ name: string, phone: string, service: string, message?: string }`
4. For each route, validate input _before_ hitting business logic, and return 400 with structured errors.
5. Update `.env.example` if any new rate-limit-related keys are added.

## Success criteria (mechanical)

- [ ] `npm install` succeeds (zod added)
- [ ] `npm run lint` passes
- [ ] `npm run build` passes
- [ ] `npm run test:smoke` still green
- [ ] New `/api/auth/*` routes reject >20 requests in 5min from same IP with HTTP 429
- [ ] Sending invalid body to any validated endpoint returns `400 { error: "Validation failed", details: [...] }`
- [ ] Valid requests still flow through normally
- [ ] `npm audit --omit=dev` shows no new vulnerabilities from zod (zod is routinely audited, should be 0)

## Out of scope

- Do NOT add per-account persistence (Redis/DB-backed). In-memory is fine for single-owner v1 — the key fix is per-UID tracking.
- Do NOT build the `GET /api/track/event` CAPI endpoint (that's a separate checklist item).
- Do NOT change any route handler logic beyond adding validate() middleware.

## Time-box

3–4 hours. If you can't finish, push WIP to branch and describe what's left in the PR.

## PR template

```bash
git add -A
git commit -m "security: harden rate-limiting (per-uid) + zod input validation on all public endpoints"
git push -u origin codex/security-rate-limit-zod
gh pr create --base main \\
  --title "security: rate-limit + zod validation" \\
  --body "Closes 2.5 🔒 and 2.6 🔒. See task brief for details."
```
