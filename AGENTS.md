# AGENTS.md — Shared context contract for Codex, Claude Code, Hermes

> Three AI agents share **this Git working tree** and **this GitHub repository** as a single source of truth. They do **not** share chat memory. Whatever state must survive across agents lives in files committed to `main` (or feature branches) on `origin`.

## Repository

- **Remote:** https://github.com/G00lden/golden-pro-crm  (private)
- **Default branch:** `main`
- **GitHub account (all agents use it):** `G00lden`

## How each agent authenticates with GitHub

| Agent       | Mechanism                                              | Verify                                                  |
|-------------|--------------------------------------------------------|---------------------------------------------------------|
| Claude Code | `gh` CLI logged in as `G00lden` (token scopes `repo,read:org`) | `gh auth status`                                        |
| Codex CLI   | `github@openai-curated` plugin enabled in `~/.codex/config.toml` | `codex --version` (must succeed), Codex GitHub plugin UI |
| Hermes      | `github` MCP server entry in `~/AppData/Local/hermes/config.yaml` | `hermes mcp list` shows `github`                        |

All three ultimately push and pull the same `origin` over HTTPS. Git identity is set **per-repo** (`git config --local`) as `G00lden / abdullah050088@gmail.com`.

## Shared-context rules

1. **Never** rely on chat memory from another agent. If the next agent needs to know something, write it to a file in the repo.
2. **`AGENTS.md`** (this file) is the entry-point contract. Every agent should read it at session start.
3. **`docs/handoff-summary.md`** is the running narrative — append a dated block whenever a non-trivial change is made.
4. Before starting work: `git fetch && git status`. If `main` moved, `git pull --rebase` first.
5. Before ending work: commit, then `git push`. Never leave uncommitted state for the next agent.

## Branch policy

- Trivial edits → straight to `main`.
- Multi-file features → `feat/<short-slug>` branch, open PR with `gh pr create`, merge after self-review.
- Long-running experiments → `exp/<slug>` branch, never auto-merge.

## File ownership (so agents don't fight each other)

- `src/`, `server/`, `scripts/` — any agent.
- `.env*`, `data/*.db*`, anything under `.security-backup-*/` — **never** committed; per-machine only.
- `AGENTS.md`, `docs/handoff-summary.md` — edit deliberately; these are how agents talk to each other.

## What is **not** shared via this repo

- Chat history of any agent.
- Local databases (`data/golden-crm.db*`) — those are per-machine.
- Anything matched by `.gitignore`. If a secret must be shared between machines, use the existing `.env.example` template + an out-of-band secret store, never the repo.

## Quick commands

```bash
# Sync before working
git fetch origin && git pull --rebase origin main

# Save progress
git add -A && git commit -m "msg" && git push

# Inspect what another agent did
git log --oneline -20
git diff HEAD~1
```
