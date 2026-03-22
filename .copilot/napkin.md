# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-03-22] Validate service health after startup**
   Do instead: after `npm run dev`, check API and Ops endpoints with HTTP requests before diagnosing frontend.

## Shell & Command Reliability
1. **[2026-03-22] Prefer task runner for predefined services**
   Do instead: use configured VS Code tasks when available for service startup and inspect output by task/terminal.

## Domain Behavior Guardrails
1. **[2026-03-22] API depends on local Postgres and Ops Control**
   Do instead: confirm Postgres container healthy and Ops on :3115 before treating API as down.

## User Directives
1. **[2026-03-22] Keep troubleshooting hands-on**
   Do instead: run commands, inspect logs, and return concrete root cause plus fix steps.
