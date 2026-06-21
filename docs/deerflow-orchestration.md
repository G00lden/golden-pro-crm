# DeerFlow Orchestration Notes

## Purpose

DeerFlow 2.0 Enhanced is an agent orchestration harness. In this CRM project it is intended to coordinate the work split between:

- DeerFlow supervisor: break a CRM objective into scoped tasks, select the executor, and keep task state.
- Codex: implement code changes, run tests, and commit to GitHub.
- Claude Code: review broad UX/architecture decisions and ambiguous refactors.
- Hermes: run local operations, diagnostics, research, and MCP-backed workflows.

It is not part of the CRM runtime. The CRM remains a Vite + Express + SQLite/Firestore application. DeerFlow lives under `.tools/` and is ignored by Git.

## Local Install State

Source URL:

```text
https://github.com/stophobia/deerflow2.0-enhanced
```

Local source path:

```text
.tools/deerflow2-enhanced-src/deerflow2.0-enhanced-main
```

Configured files copied locally:

```text
config.yaml
.env
frontend/.env
```

## Role Mapping

| Responsibility | Primary agent | Output |
| --- | --- | --- |
| Architecture and task decomposition | DeerFlow supervisor | task briefs and execution plan |
| CRM code edits and verification | Codex | commits, tests, local run evidence |
| UX polish and deep review | Claude Code | review notes or focused patches |
| Local ops, MCP connectors, diagnostics | Hermes | environment checks, MCP status, automation |

## Activation Blockers Found On Windows

The source was downloaded and configured, but full activation did not complete because the machine hit repeated Windows TLS body-decrypt failures while downloading toolchain dependencies:

- `git clone` failed with Schannel `SEC_E_DECRYPT_FAILURE`, so codeload ZIP fallback was used.
- `uv sync` tried to download Python 3.12/3.13 and failed with TLS decrypt errors.
- Using local Python 3.14 was not enough because `onnxruntime==1.20.1` has no cp314 wheel.
- `corepack pnpm --version` failed while downloading pnpm because the TLS socket closed before completion.
- `make` and `pnpm` are not currently installed.

## Manual Completion Steps

Install the missing toolchain outside the repo, then run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup-deerflow.ps1
cd .tools/deerflow2-enhanced-src/deerflow2.0-enhanced-main
uv sync --python 3.12
corepack enable
corepack prepare pnpm@latest --activate
cd frontend
pnpm install
```

After dependencies install, run the DeerFlow backend and frontend from its own README, then use it as the supervisor to assign tasks back into this CRM repo. Do not store API keys in this repository.

