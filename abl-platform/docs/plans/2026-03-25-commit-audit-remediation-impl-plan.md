# Commit Audit Remediation — Implementation Plan

**Date:** 2026-03-25
**Audit Window:** March 21–25, 2026 (443 commits, 2.8:1 fix:feat ratio)
**Ticket:** [ABLP-2]

---

## Executive Summary

The 4-day audit surfaced 6 systemic categories. This plan addresses them in 5 phases ordered by blast radius (production safety first, then prevention, then test quality). Each phase has explicit exit criteria, affected files, and estimated scope.

---

## Phase 1 — Fix Production Code Defects (CRITICAL)

**Goal:** Eliminate all unsafe error handling patterns that can crash in production.
**Risk if deferred:** Unsafe error casts throw `TypeError` when `err` is a string or `undefined`. The swallowed catch hides memory-bridge cleanup failures.

### 1A. Fix unsafe error casts in runtime-executor.ts

**File:** `apps/runtime/src/services/runtime-executor.ts`
**10 instances** at lines: 355, 442, 463, 590, 605, 818, 882, 889, 1390, 2433

**Pattern — replace each unsafe cast with the safe instanceof check:**

```typescript
// SAFE pattern to use everywhere:
err instanceof Error ? err.message : String(err);
```

### 1B. Fix unsafe error name checks in search-ai-sdk/client.ts

**File:** `packages/search-ai-sdk/src/client.ts`
**2 instances** at lines: 421, 490

**Pattern — replace unsafe `.name` access with proper instanceof check:**

```typescript
// SAFE pattern for AbortError detection:
(err instanceof DOMException && err.name === 'AbortError') ||
  (err instanceof Error && err.name === 'AbortError');
```

Note: `AbortError` is a `DOMException` in Node 18+ but the `instanceof DOMException` check is the most precise. Keep the `instanceof Error` fallback for older runtimes.

### 1C. Fix swallowed catch in runtime-executor.ts

**File:** `apps/runtime/src/services/runtime-executor.ts`
**Line 2402**

Replace the empty `.catch(() => {})` with a logged handler:

```typescript
.catch((err) => {
  log.warn('Failed to unregister memory bridge', {
    sessionId,
    error: err instanceof Error ? err.message : String(err),
  });
});
```

### 1D. Document acceptable empty catch in elevenlabs-service.ts

**File:** `apps/runtime/src/services/voice/elevenlabs-service.ts`
**Line 185** — This is a legitimate `Promise.race` rejection guard. Add a comment:

```typescript
// Intentional: prevent unhandled rejection when reader.read() wins the race
timeoutPromise.catch(() => {});
```

No functional change — just documentation.

### Exit Criteria — Phase 1

- [ ] Zero unsafe error casts in production server code (grep confirms 0 hits in non-test files)
- [ ] Zero empty `.catch(() => {})` in production code without explicit justification comment
- [ ] `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/search-ai-sdk` succeeds
- [ ] `pnpm test --filter=@agent-platform/runtime --filter=@agent-platform/search-ai-sdk` passes
- [ ] Commit: `[ABLP-2] fix(runtime,search-ai-sdk): replace 13 unsafe error casts with instanceof checks`

---

## Phase 2 — Strengthen Preventive Hooks (HIGH)

**Goal:** Ensure the patterns fixed in Phase 1 cannot recur, and add the missing enforcement for commit hygiene.

### 2A. Verify unsafe-error-cast-lint.sh hook coverage

**File:** `.claude/hooks/unsafe-error-cast-lint.sh`
**Status:** Already exists and blocks the primary unsafe cast pattern.

**Action:** Verify it also catches:

- Unsafe `.name` access (not just `.message`)
- Alternate variable names (`error`, `e`, `ex` — not just `err`)

If not, extend the grep pattern to cover all variants. The regex should match any `(varname as Error).property` pattern.

### 2B. Add commit scope enforcement hook

**New file:** `.claude/hooks/commit-scope-lint.sh`

Enforce: feat commits should have a deletion ratio below 30%. This catches the pattern where commit `9e7fe8074` had 55% deletions.

**Logic:**

1. Only triggers on `git commit` commands containing "feat" in the message
2. Computes deletion ratio from `git diff --cached --numstat`
3. Warns (exit 0) if deletion ratio exceeds 30%
4. Suggests splitting deletions into a separate `refactor` commit

### 2C. Add commit size warning hook

**New file:** `.claude/hooks/commit-size-warn.sh`

Warn when a single commit is over-large.

**Logic:**

1. Triggers on `git commit` commands
2. Counts files changed via `git diff --cached --name-only`
3. Counts distinct packages touched
4. Warns at >50 files or >3 packages
5. Non-blocking (exit 0) — advisory only

### 2D. Extend swallowed-catch-lint.sh to handle edge cases

**File:** `.claude/hooks/swallowed-catch-lint.sh`
**Status:** Already blocks `.catch(() => {})`.

**Action:** Verify it also catches:

- Named-but-unused parameter variant: `.catch((_) => {})`
- ALLOW if comment contains "intentional", "race", or "prevent unhandled"

### 2E. Wire unsafe-error-cast check into pre-commit hook

**File:** `.husky/pre-commit`

Add a staged-file scan for unsafe error casts to match the Claude hook, so non-Claude edits are also caught. Place it after the existing `findById` check section.

### Exit Criteria — Phase 2

- [ ] `unsafe-error-cast-lint.sh` catches `.name` variant and alternate variable names
- [ ] New `commit-scope-lint.sh` and `commit-size-warn.sh` hooks added to `.claude/settings.json`
- [ ] Pre-commit hook catches unsafe error casts in staged files
- [ ] All hooks pass on a clean working tree
- [ ] Commit: `[ABLP-2] ci(hooks): add commit scope and size warnings, extend error cast detection`

---

## Phase 3 — Rewrite E2E Tests (HIGH)

**Goal:** Replace 3 mock-heavy "E2E" tests with real E2E tests that exercise the full middleware chain.

### 3A. Rewrite observatory-api-e2e.test.ts

**File:** `apps/runtime/src/__tests__/integration/observatory-api-e2e.test.ts`
**Current state:** 780 lines, 12 vi.mock() calls — mocks auth, RBAC, rate limiter, shared-auth, session repo, project repo, DB models, audit helpers, encryption, eventstore, DB availability.
**Problem:** Would pass even with completely broken auth.

**Rewrite strategy:**

1. Start a real Express app with the full runtime router (no mocked middleware)
2. Use a real MongoDB instance (from test docker-compose or `mongodb-memory-server`)
3. Use a real Redis instance (from test docker-compose)
4. Seed test data via POST API calls, not direct DB inserts
5. Generate real JWT tokens for auth (using shared-auth test utilities)
6. Assert tenant isolation: requests with Tenant-A's token cannot see Tenant-B's sessions
7. Assert RBAC: requests without required permissions get 403/404
8. Assert rate limiting: excessive requests get 429

**Target:** Real HTTP → real auth → real RBAC → real DB → real response
**Estimated size:** ~600-800 lines (similar size, but testing real behavior)

### 3B. Rewrite module-preview.e2e.test.ts

**File:** `apps/runtime/src/__tests__/module-preview.e2e.test.ts`
**Current state:** 742 lines, 7 vi.mock() calls — not actually E2E (no HTTP server, calls resolver directly).
**Problem:** Tests nothing about the HTTP layer, auth, or validation.

**Rewrite strategy:**

1. **Rename** to `module-preview.unit.test.ts` (it is genuinely a unit test of the resolver)
2. **Create new true E2E** (`module-preview.e2e.test.ts`):
   - Start real Express app with the deployment/preview routes
   - Seed project + agent data via API
   - Test preview resolution via HTTP endpoint
   - Assert auth/RBAC on preview endpoints
   - Assert proper error responses for invalid inputs

### 3C. Rewrite deployment-pipeline.e2e.test.ts

**File:** `apps/runtime/src/__tests__/deployment-pipeline.e2e.test.ts`
**Current state:** 802 lines, 1 vi.mock() (but mocks 7 DB models + 6 hoisted fns). Not actually E2E (no HTTP server).
**Problem:** Tests deployment resolution without any real infrastructure.

**Rewrite strategy:**

1. **Rename** to `deployment-pipeline.integration.test.ts` (it tests resolver logic, not HTTP)
2. **Create new true E2E** (`deployment-pipeline.e2e.test.ts`):
   - Start real Express app with deployment routes
   - Seed deployment data via API
   - Test the full deployment resolution + session creation flow via HTTP
   - Verify deployment artifacts are correctly resolved
   - Test the real-LLM path (gated by API key availability, using `describe.runIf`)

### 3D. Shared E2E test infrastructure

Before rewriting individual tests, create shared helpers:

**New file:** `apps/runtime/src/__tests__/helpers/e2e-harness.ts`

Provides:

- `createTestServer(options?)` — Start real Express app with full middleware chain. Return `{ app, server, baseUrl, cleanup }`
- `createTestAuth(tenantId, userId, permissions)` — Generate real JWT using shared-auth. Return `{ token, headers }`
- `seedTestData(baseUrl, auth)` — Create project, agents, sessions via API. Return `{ projectId, agentId, sessionId }`

### Exit Criteria — Phase 3

- [ ] `observatory-api-e2e.test.ts` has 0 `vi.mock()` calls and starts a real server with real auth
- [ ] `module-preview.e2e.test.ts` either renamed to `.unit.test.ts` or rewritten as real E2E
- [ ] `deployment-pipeline.e2e.test.ts` either renamed to `.integration.test.ts` or rewritten as real E2E
- [ ] All rewritten tests pass: `pnpm test --filter=@agent-platform/runtime`
- [ ] Tests actually catch auth/RBAC/isolation bugs (verify by temporarily breaking auth and confirming test failure)
- [ ] E2E test quality hook (`e2e-test-quality-lint.sh`) reports 0 violations
- [ ] Commit per file: 3 separate commits for reviewability

---

## Phase 4 — Pre-Commit Build/Test Gate (MEDIUM)

**Goal:** Reduce the fix-to-feat ratio from 2.8:1 to <0.5:1 by catching breakage before it's committed.

### 4A. Add diff-aware typecheck to pre-commit

The pre-push hook already runs `turbo typecheck --filter="...[$REMOTE_REF]"`. The pre-commit hook does NOT typecheck.

**Current state:** The Claude hook `typecheck-before-commit.sh` runs `tsc --noEmit` on affected packages before Claude-authored commits. But non-Claude commits (manual, other tools) skip typecheck entirely until push.

**File:** `.husky/pre-commit`

**Action:** Add a lightweight, diff-aware typecheck step after lint-staged. For each affected package with a `tsconfig.json`, run `tsc --noEmit` and block commit on failure.

**Trade-off:** Adds ~5-15s to commit time. Can be skipped with `SKIP_TYPECHECK=1 git commit`. The Claude hook already covers Claude-authored commits, so this primarily catches manual edits.

### 4B. Do NOT add tests to pre-commit

**Rationale:** Running tests on every commit is too slow. The pre-push hook already enforces this. The audit's real problem wasn't missing test runs — it was that agents were committing without running `pnpm build && pnpm test` first. The typecheck in 4A catches the majority of breakage (type deletions, signature mismatches) in <15s.

### 4C. Document the "build-test-commit" workflow

**File:** `docs/sdlc/pipeline.md` (update Commit Conventions section)

Add explicit pre-commit checklist:

1. `npx prettier --write <changed-files>`
2. `pnpm build --filter=<affected-package>`
3. `pnpm test --filter=<affected-package>`
4. `git add <files> && git commit`

Note that the pre-commit hook enforces steps 1-2 (prettier + typecheck). Step 3 is enforced at push time. Skipping these steps results in the 2.8:1 fix-to-feat ratio observed in the March 21-25 audit.

### Exit Criteria — Phase 4

- [ ] Pre-commit hook runs typecheck on affected packages
- [ ] `docs/sdlc/pipeline.md` updated with pre-commit checklist
- [ ] Manual verification: intentionally break a type → commit is blocked
- [ ] Commit: `[ABLP-2] ci(hooks): add pre-commit typecheck, document build-test workflow`

---

## Phase 5 — Systemic Pattern Prevention (MEDIUM)

**Goal:** Address the root causes behind mega-commits, mislabeled commits, and "pre-existing failure" patterns.

### 5A. Add commit type validation to commitlint

**File:** `commitlint.config.ts`

Add a custom rule that warns when a `feat` commit message contains words suggesting it's actually a fix or refactor ("fix", "resolve", "patch", "correct", "repair", "restore"). Suggest using `fix` or `refactor` type instead.

### 5B. Add agents.md learning about deletion regressions

**File:** `apps/runtime/agents.md`

Append learning:

- **Root cause:** Feature commits deleted type definitions and helpers consumed by other packages, causing 35+ build errors
- **Fix:** Feature commits MUST be additive — no deleting exports. The `exported-symbol-guard.sh` hook enforces this for Claude commits. Verify manually for non-Claude commits.
- **Scope rule:** Max 1 package per feat commit. Cross-package changes need a refactor commit first.

### 5C. Add agents.md learning about test breakage cascade

**File:** `apps/runtime/agents.md`

Append learning:

- **Root cause:** Design token and component refactors changed CSS selectors/class names without updating test mocks
- **Stale mock hook:** `stale-mock-warn.sh` exists but is warning-only. When changing component signatures, grep for corresponding test files and update mocks in the same commit.
- **Label accuracy:** "Pre-existing failures" that follow directly after the introducing commit are not pre-existing.

### 5D. Add cross-cutting learning about mega-commits

**File:** `docs/sdlc-logs/agents.md`

Append learning:

- Commits over 50 files or 3 packages are unrevertable and unreviewable
- Rule: 1 concern per commit. "3 sprints in 1 commit" is never acceptable
- The `commit-size-warn.sh` hook warns at >50 files or >3 packages

### 5E. Update CLAUDE.md with audit findings

**File:** `CLAUDE.md` (Key Rules section)

Add two new rules:

- **Commit scope limit**: Max 1 package per feat commit, max 50 files per commit. Split larger changes into a chain of focused commits. A PreToolUse hook (`commit-size-warn.sh`) warns on violations.
- **Feat commits must be additive**: Zero deletions of existing exports/types in feat commits. Deletions go in a separate `refactor` commit. Deletion ratio >30% triggers a warning via `commit-scope-lint.sh`.

### Exit Criteria — Phase 5

- [ ] `commitlint.config.ts` warns on feat-type commits that describe fixes
- [ ] `apps/runtime/agents.md` updated with deletion regression + test breakage learnings
- [ ] `docs/sdlc-logs/agents.md` updated with mega-commit learning
- [ ] `CLAUDE.md` updated with commit scope rules
- [ ] Commit: `[ABLP-2] docs(sdlc): add commit audit learnings and scope enforcement rules`

---

## Implementation Order & Dependencies

```
Phase 1 ──→ Phase 2 ──→ Phase 5
  (fix)      (prevent)    (document)
                │
                └──→ Phase 4
                      (typecheck)

Phase 3 (independent, can run in parallel with Phase 2)
  (E2E rewrites)
```

- **Phase 1** has no dependencies — pure code fixes
- **Phase 2** depends on Phase 1 (hooks should reflect fixed patterns)
- **Phase 3** is independent — can start immediately in parallel
- **Phase 4** depends on Phase 2 (builds on hook infrastructure)
- **Phase 5** depends on Phases 1-4 (documents what was done)

## Scope Summary

| Phase | Files Changed             | Lines Changed (est.) | Risk                                   |
| ----- | ------------------------- | -------------------- | -------------------------------------- |
| 1     | 3 files                   | ~50 lines            | LOW — mechanical replacements          |
| 2     | 4–5 files                 | ~150 lines           | LOW — new hooks + hook extensions      |
| 3     | 3–4 test files + 1 helper | ~2,000 lines         | MEDIUM — test rewrites need real infra |
| 4     | 2 files                   | ~30 lines            | LOW — pre-commit extension             |
| 5     | 4–5 doc files             | ~100 lines           | LOW — documentation only               |

**Total estimated:** ~2,330 lines across ~15 files, 5 commits.

---

## Verification Plan

After all 5 phases:

1. `pnpm build` — full monorepo build passes
2. `pnpm test` — all tests pass
3. `grep -rE 'as Error\)' apps/ packages/ --include="*.ts" | grep -v test | grep -v node_modules` — 0 hits
4. `grep -rn 'vi\.mock' apps/runtime/src/__tests__/**/*e2e*` — 0 hits
5. Re-run the same audit script for the next 4-day window — fix-to-feat ratio should drop below 1:1
