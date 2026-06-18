# Golden Pro CRM outbound safety

This project must not send WhatsApp/SMS reminders to real customers before the official launch.

## Modes

Set `OUTBOUND_MODE` in `.env` or `.env.production`:

- `dry_run`: default. No real message is sent. The app records a `dry_run` result only.
- `code`: real messages require a per-send confirmation code from the operator.
- `allowlist`: messages are sent only to numbers in `OUTBOUND_TEST_PHONE_ALLOWLIST`.
- `production`: real sending is allowed only when `OFFICIAL_LAUNCH_APPROVED=true`.

## Required pre-launch settings

```env
OUTBOUND_MODE=dry_run
OFFICIAL_LAUNCH_APPROVED=false
OUTBOUND_TEST_PHONE_ALLOWLIST=
```

This is the safest default for local testing, Salla integration testing, and database setup.

## Code-confirmed sending

Use this when you want limited live sending before the official launch. The backend will reject every message unless the request includes the correct code.

```env
OUTBOUND_MODE=code
OUTBOUND_CONFIRM_CODE=2232
OFFICIAL_LAUNCH_APPROVED=false
```

Scheduled automatic sends do not have an operator-entered code, so they remain blocked in this mode. Manual reminder, technician notification, and test-message actions prompt for the code.

## Controlled test sending

Use this only for your own phone numbers:

```env
OUTBOUND_MODE=allowlist
OFFICIAL_LAUNCH_APPROVED=false
OUTBOUND_TEST_PHONE_ALLOWLIST=9665xxxxxxxx,9665yyyyyyyy
```

Any other customer or technician number will be blocked as dry-run.

## Official launch

Only after final approval:

```env
OUTBOUND_MODE=production
OFFICIAL_LAUNCH_APPROVED=true
```

Before changing to production, run:

```powershell
npm run doctor:prod
npm run security:audit
npm run lint
npm run build
```

## Code-level guard

All WhatsApp sending goes through `server/whatsapp.ts`, which calls `server/outboundSafety.ts` before contacting WhatsApp Web or WhatsApp Cloud API. Reminder and technician notification flows treat dry-run as blocked, not as a successful customer send.
