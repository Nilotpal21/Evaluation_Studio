---
name: pre-review-checklist
description: Use when code is ready for review, before submitting a PR, after completing implementation, or when asked to self-review. Catches the top recurring review findings to reduce review round-trips.
---

# Pre-Review Checklist

## Overview

Self-review checklist derived from actual recurring review findings in this codebase. Run this before every PR to catch issues that historically cause multi-round review cycles.

## When to Use

- Before creating a PR
- After completing a feature implementation
- When asked to "self-review" or "check my work"
- Before running `/commit` on a significant change

## Automated Checks

Run `tools/pre-review-audit.sh` to verify auto-checkable items. The script covers items marked [AUTO] below.

```bash
tools/pre-review-audit.sh              # Check changed files
tools/pre-review-audit.sh --all        # Check entire codebase
tools/pre-review-audit.sh --files f1   # Check specific files
```

## Checklist

### Tenant & Project Isolation [AUTO]

- [ ] Every ID query uses `findOne({_id, tenantId})`, never `findById(id)`
- [ ] Updates use `findOneAndUpdate({_id, tenantId})`, never `findByIdAndUpdate`
- [ ] Routes under `/api/projects/:projectId/` use `requireProjectPermission(req, res, 'obj:op')`
- [ ] Cross-tenant access returns 404 (not 403)
- [ ] Resource ownership verified: `resource.projectId === req.params.projectId`

### Auth & Security [AUTO]

- [ ] Routes use `createUnifiedAuthMiddleware` or `requireAuth`, no custom token verification
- [ ] Permissions via `requirePermission()`, not ad-hoc checks
- [ ] JWT algorithm allowlist enforced (no algorithm confusion attacks)
- [ ] Input validated with Zod at system boundaries
- [ ] No SSRF vectors (URLs from user input validated)
- [ ] Sensitive fields encrypted at rest

### Error Handling [AUTO]

- [ ] No `.catch(() => {})` — every error logged or propagated
- [ ] `err instanceof Error ? err.message : String(err)` — never `(err as Error).message`
- [ ] Failure returns `{ success, data?, error?: { code, message } }` — not `{}`
- [ ] No swallowed promise rejections

### Logging & Observability [AUTO]

- [ ] No `console.log` in server code — uses `createLogger('module')` from `@abl/compiler/platform`
- [ ] Execution paths emit `TraceEvent`s via shared `TraceStore`
- [ ] Structured fields include `tenantId`, `projectId`, `sessionId` where applicable

### Type Safety [AUTO partial]

- [ ] No `any` where structured types exist — use discriminated unions
- [ ] Provider-neutral LLM types: `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`
- [ ] No domain-specific field names in engine code — use IR metadata

### Route Layering

- [ ] No direct `Model.find*` calls in route files
- [ ] No queue producer creation in route files
- [ ] Route files: auth -> validate -> service call -> response mapping only
- [ ] Route file under 300 LOC

### Resource Management [AUTO]

- [ ] Every in-memory `Map` has max size, TTL, and eviction
- [ ] `fs.promises` for all file I/O — no sync I/O in async paths
- [ ] No inline magic numbers — named constants or config
- [ ] Large payloads compressed before storage (async gzip)

### Frontend Patterns (all changed .tsx files) _(Evidence: 5 HIGH findings in Wave 4 review)_

- [ ] No raw `fetch()` or `axios` calls — all HTTP through project API client (`api/*.ts`). Grep: `fetch(` or `axios` in changed `.tsx` files [AUTO]
- [ ] After every mutation (POST/PUT/DELETE), SWR keys are revalidated via `mutate()`
- [ ] Async buttons/actions disabled while in-flight (loading guard)
- [ ] Zustand selectors are atomic — no inline `{ a, b }` objects in `useStore()` [AUTO]
- [ ] No non-null assertions (`!`) — use `?.` or `??` [AUTO]
- [ ] Keyboard shortcut handlers check for open `[role="dialog"]`
- [ ] No bare English strings in JSX — all use `t()` from `useTranslations()` [AUTO]
- [ ] No hardcoded `'en-US'` locale — use `undefined` for browser default [AUTO]

### Infrastructure

- [ ] New workspace packages added to ALL Dockerfiles (`apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`)
- [ ] User-facing strings use i18n translation keys
- [ ] Prettier run on all changed files before commit

### Test Coverage

- [ ] New code has tests (unit or integration)
- [ ] Authz tests: correct permission, cross-tenant 404, missing auth 401
- [ ] Existing tests still pass (`pnpm build && pnpm test`)

## Common Review Findings (Historical)

| Finding                           | Frequency | Example Commit                                                     |
| --------------------------------- | --------- | ------------------------------------------------------------------ |
| Missing tenant scoping on queries | High      | `fix(database): tenant/project isolation fixes`                    |
| JWT algorithm not allowlisted     | Medium    | `fix(runtime): add JWT algorithm allowlist`                        |
| Direct DB calls in route handlers | Medium    | `fix(runtime): address code review issues in Netcore provider`     |
| Missing logger in new modules     | Medium    | `fix(runtime): add logger to media downloaders`                    |
| Duplicate code not extracted      | Medium    | `fix(runtime): address three review findings in Instagram adapter` |
| Stale comments/warnings left in   | Low       | `docs(studio,admin): address PR 235 review findings`               |

## Key Files

| File                                         | Purpose                                      |
| -------------------------------------------- | -------------------------------------------- |
| `tools/pre-review-audit.sh`                  | Automated grep-based checks for [AUTO] items |
| `apps/runtime/src/__tests__/*-authz.test.ts` | Reference authz test patterns                |
| `packages/config/src/constants.ts`           | Port constants (avoid magic numbers)         |
