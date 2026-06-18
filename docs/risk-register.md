# Risk Register

Open risks the Supervisor is tracking. Closed risks moved to the bottom (do not delete — they become institutional memory).

| ID | Risk | Severity | Likelihood | Mitigation | Owner | Opened | Status |
|----|------|----------|------------|------------|-------|--------|--------|
| R-001 | npm audit shows 2 critical + 7 high vulnerabilities in production deps | High | High (already present) | Run `npm audit fix` → upgrade affected packages → re-test smoke path. Cap risk by enabling Dependabot. | codex | 2026-06-18 | Open |
| R-002 | WhatsApp via Baileys is unofficial — Meta can ban the account at any time | High | Medium | Keep `WHATSAPP_PROVIDER=cloud_api` path working as a fallback; document switch in runbook | claude | 2026-06-18 | Open |
| R-003 | No automated tests beyond `npm run test:smoke` placeholder — regressions ship silently | High | High | Implement golden-path smoke (item 1.3); add CI gate that blocks merge if smoke fails | codex | 2026-06-18 | Open |
| R-004 | Single-machine deploy — laptop offline = service down | Medium | Medium (acceptable pre-v1; blocker post-launch) | Move WhatsApp leg to VPS before v1 ships (item 1.7); document failover | hermes | 2026-06-18 | Open |
| R-005 | Pricing not defined — cannot plan billing integration, landing page, or sales conversations | High | High | Sprint #1 item 4.1 — supervisor + hermes own this | supervisor | 2026-06-18 | Open |
| R-006 | Local SQLite DB is not backed up — laptop loss = customer data loss | Medium | Low (dev phase) → High (post-launch) | Daily backup to encrypted external drive; document restore in item 1.8 | claude | 2026-06-18 | Open |
| R-007 | `STORE_WEBHOOK_OWNER_UID` and `STORE_WEBHOOK_SECRET` are placeholders in dev env — a real webhook delivery now would 401 forever | Low | Low | Owner sets these in `.env` before connecting a real store; supervisor verifies before any production deploy | human | 2026-06-18 | Open |

## Closed risks

_(none yet — once a risk is mitigated, move it here with a closure date and what proved it closed)_

## Conventions

- **Severity** = blast radius if it materializes (Low / Medium / High / Critical).
- **Likelihood** = probability it materializes within the next 30 days unless mitigated.
- A High + High is a release blocker until the mitigation is verified.
- Owner is the person/agent who drives the mitigation, not necessarily who executes it.
