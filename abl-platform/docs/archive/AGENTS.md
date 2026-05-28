# AGENTS.md

CRITICAL: NEVER switch branches or run "git checkout" unless explicitly instructed by the user.
CRITICAL: Only work on the current branch. Do not create new branches without explicit user approval.
CRITICAL: NEVER add "Co-Authored-By" lines to commit messages.

Run `pnpm build` before `pnpm test` — Turbo enforces build order and tests will fail on stale compiled output.

CRITICAL: Always run `npx prettier --write <files>` on all changed files BEFORE `git commit`. The pre-commit hook runs lint-staged with `prettier --check`. If check fails, lint-staged's stash/restore cycle will **silently revert your uncommitted edits** to their pre-edit state, losing work.

## Quick Reference

- Monorepo: pnpm + Turbo. Docker for all infra (see `docker-compose.yml`).
- Runtime (3112), SearchAI (3113), SearchAI-Runtime (3114), Studio (5173), Admin (3003)
- Python services: Docling (8080), BGE-M3 (8000), Preprocessing (8003)
- Port constants: `packages/config/src/constants.ts`
- Three repos: abl-platform (source), abl-platform-deploy (helm/argocd), abl-platform-infra (terraform)

## Core Invariants

> Full details with examples and rules in the `platform-principles` skill.

1. **Resource Isolation**: Scope every query to the appropriate ownership level:
   - **Tenant**: Every query includes `tenantId`. Use `findOne({_id, tenantId})`, never `findById`.
   - **Project**: Use `requireProjectPermission(req, res, 'obj:op')`, verify `resource.projectId === req.params.projectId`. Routes under `/api/projects/:projectId/...`.
   - **User**: Filter by `createdBy`/`ownerId`. Users must not access other users' resources even within the same tenant/project.
   - Cross-scope access returns **404** (not 403) to avoid leaking existence.
2. **Centralized Auth**: Use `createUnifiedAuthMiddleware`/`requireAuth`. Never custom token verification. Permissions via `requirePermission()`.
3. **Stateless Distributed**: No pod-local state as truth. Redis/MongoDB for all shared state. Distributed locks via Redis `SET NX PX`.
4. **Traceability**: Every execution path emits `TraceEvent`s via shared `TraceStore`. No ad-hoc logging as substitute.
5. **Compliance**: Encryption at rest/transit, data minimization with TTLs, right to erasure cascades, audit logging.
6. **Performance**: Compress before storing (async gzip), validate payload size at boundaries, batch operations, conversation sliding windows.

## Key Rules

> Full coding standards, anti-patterns table, and detailed rules in the `code-standards` skill.

- Never `console.log` in server code — use `createLogger('module')` from `@abl/compiler/platform`
- Never `.catch(() => {})` — log or propagate every error
- `err instanceof Error ? err.message : String(err)` — never `(err as Error).message`
- `fs.promises` for all file I/O in server code — no sync I/O in async paths
- No `any` where structured types exist — use discriminated unions
- No inline magic numbers — named constants or config
- Provider-neutral LLM types: `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`
- No domain-specific field names in engine code — use IR metadata
- Every in-memory `Map` needs max size, TTL, and eviction
- Return `{ success, data?, error?: { code, message } }` on failure — not `{}`
- **Dockerfile package.json sync**: When adding a new `packages/<name>/` workspace package, add its `COPY packages/<name>/package.json packages/<name>/package.json` line to **every** Dockerfile under `apps/` that uses `pnpm install --frozen-lockfile`. Without this, pnpm cannot resolve the dependency graph and builds fail with missing modules. Check: `apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`.

## Skills Reference

Detailed domain knowledge has been moved to on-demand skills to save context:

| Skill                            | Use When                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `platform-principles`            | Planning features, code review, architecture decisions                                                      |
| `code-standards`                 | Writing or reviewing any code                                                                               |
| `studio-design-system`           | Working on `apps/studio/` UI (colors, typography, animations, components)                                   |
| `search-ai-development`          | Working on SearchAI ingestion pipeline, workers, or LLM credential resolution                               |
| `infrastructure-guide`           | Debugging connections, Docker ports, service setup, cross-repo work                                         |
| `i18n-guide`                     | Adding user-facing strings, error messages, localization                                                    |
| `bullmq-flows-guide`             | Debugging BullMQ Flows, implementing PipelineFlowBuilder, Redis memory, stalled jobs, flow scaling          |
| `analytics-pipeline-development` | Designing or implementing any analytics pipeline (intent, sentiment, quality eval, anomaly detection, etc.) |
