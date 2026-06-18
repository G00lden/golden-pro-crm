# CLAUDE.md — Project-local guidance for Claude Code

> This project (`golden-pro-crm`) is worked on by **three** AI agents sharing the same Git repo: **Codex, Claude Code, Hermes**. Their chat memories do not overlap — only files in this repo do.

## On every session start

1. Read [AGENTS.md](AGENTS.md) — the shared contract between the three agents (branch policy, file ownership, sync rules).
2. Read [docs/handoff-summary.md](docs/handoff-summary.md) — newest section at the bottom tells you exactly where the previous agent stopped and what the next priorities are.
3. Run `git fetch && git status`. If `origin/main` moved, `git pull --rebase` first.

## On every session end

1. `git add -A && git commit -m "<concise msg>" && git push`.
2. If the work changes the project's overall state in a way the next agent should know, append a dated block to `docs/handoff-summary.md`.
3. Never leave uncommitted state for the next agent.

## Project conventions

- Stack: **Vite + React + TypeScript** front, **Express + tsx** server (`server.ts`), **SQLite** local DB (`data/golden-crm.db`, gitignored), **Supabase** + **Firestore** remote adapters.
- Dev server: `npm run dev` → `http://localhost:3000`. Health: `GET /api/health`.
- Lint: `npm run lint` (TypeScript `tsc --noEmit`). Build: `npm run build`. Smoke: `npm run test:smoke`.
- Secrets live in `.env` (gitignored). `.env.example` is the canonical key list — keep it current.
- WhatsApp session in `.wa-session/` (gitignored, per-machine).

## Hard rules

- **Never** commit secrets, `.env*`, local databases, `*-credentials*.json`, or `wa-qr.png`. `.gitignore` enforces this; double-check `git status` before commit.
- **Never** force-push `main`. Branch + PR for anything multi-file.
- **Never** mutate `AGENTS.md` or this file silently — they are the shared contract; change them deliberately.
- Outbound WhatsApp is gated by `OUTBOUND_LAUNCH_CODE` env. Don't bypass it; the safety is intentional.

## "Where it stopped" priorities

See the latest dated block in [docs/handoff-summary.md](docs/handoff-summary.md). At time of writing:
- payment fields wired in API/types; need to flow into PDF template (`public/quotation-template.html`)
- `/api/whatsapp/send` manual endpoint added; needs UI test once QR connected
