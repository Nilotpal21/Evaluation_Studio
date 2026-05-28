# LLD: Environment Variables — Hardening to STABLE

**Feature Spec**: `docs/features/environment-variables.md`
**HLD**: `docs/specs/environment-variables.hld.md`
**Test Spec**: `docs/testing/environment-variables.md`
**Status**: DONE
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                              | Rationale                                                                                                                   | Alternatives Rejected                     |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| D-1 | All 4 bug fixes in Phase 1                            | Each fix is < 20 LOC, independent, and unblocks downstream work                                                             | Spreading fixes across phases             |
| D-2 | Base fallback in EnvVarStore, not secrets-provider    | Store does DB query — adding second query there means provider benefits automatically                                       | Fix in secrets-provider (double the work) |
| D-3 | Cache sentinel uses `Map.has()` + store `undefined`   | Standard JS pattern, minimal change, `has()` distinguishes "not in map" from "mapped to undef"                              | Sentinel symbol (over-engineered)         |
| D-4 | Namespace pagination via aggregation in route handler | The existing `findEnvironmentVariables` in shared repo is generic; route-specific aggregation avoids breaking other callers | Modify shared repo function               |
| D-5 | New endpoints added to existing router file           | No new route files needed — these are natural extensions of the env vars API                                                | Separate router file                      |
| D-6 | Diff endpoint decrypts for comparison                 | AES-GCM nonce means identical plaintext produces different ciphertext                                                       | Ciphertext comparison (incorrect)         |

### Key Interfaces & Types

No new interfaces or types. All changes are within existing function bodies. The `EnvVarStore` interface from `@abl/compiler/platform/constructs/executors/secrets-provider.ts` remains unchanged:

```typescript
// Existing — no changes
interface EnvVarStore {
  findEnvVar(params: {
    tenantId: string;
    projectId: string;
    environment: string;
    key: string;
    variableNamespaceIds?: string[];
  }): Promise<{ encryptedValue: string } | null>;
}
```

### Module Boundaries

| Module                             | Responsibility                     | Depends On                               |
| ---------------------------------- | ---------------------------------- | ---------------------------------------- |
| `environment-variables.ts` (route) | HTTP endpoints, validation, auth   | security-repo, namespace-membership-repo |
| `llm-wiring.ts` (EnvVarStore)      | DB queries for variable resolution | `@agent-platform/database/models`        |
| `secrets-provider.ts`              | Resolution chain with caching      | EnvVarStore, decryptor                   |
| `security-repo.ts` (shared)        | Generic CRUD operations            | `@agent-platform/database/models`        |

---

## 2. File-Level Change Map

### Modified Files

| File                                                                     | Change Description                                                                                                                                                      | Risk       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --- |
| `apps/runtime/src/routes/environment-variables.ts`                       | Fix create route null check (L120), add aggregation for namespace pagination (L300-355), fix validate to include base vars (L880-886), add diff/export/import endpoints | Medium     |
| `apps/runtime/src/services/execution/llm-wiring.ts`                      | Add base fallback second query in `findEnvVar()` (L253-293)                                                                                                             | Low        |
| `apps/runtime/src/services/secrets-provider.ts`                          | Fix cache sentinel: `Map.has()` instead of `!== undefined` (L234-236)                                                                                                   | Low        |
| `apps/studio/src/components/deployments/EnvironmentsTab.tsx`             | Add "Base (Default)" pseudo-tab                                                                                                                                         | Low        |
| `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` | Accept `environment: string                                                                                                                                             | null` prop | Low |

### New Files

| File                                                               | Purpose                           | LOC Estimate |
| ------------------------------------------------------------------ | --------------------------------- | ------------ |
| `apps/runtime/src/__tests__/env-vars-e2e.test.ts`                  | E2E tests: E2E-1 through E2E-14   | ~800         |
| `apps/runtime/src/__tests__/secrets-provider-integration.test.ts`  | Integration: INT-1, INT-2, INT-11 | ~200         |
| `apps/runtime/src/__tests__/snapshot-service-integration.test.ts`  | Integration: INT-3, INT-6         | ~150         |
| `apps/runtime/src/__tests__/deployment-repo-integration.test.ts`   | Integration: INT-4, INT-7         | ~120         |
| `apps/runtime/src/__tests__/env-vars-namespace-pagination.test.ts` | Integration: INT-9                | ~100         |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Critical Bug Fixes (FR-1, FR-2, FR-3, FR-4, FR-11)

**Goal**: Fix all 4 critical bugs so the core system works correctly.

**Tasks**:

1.1. **Fix create route null check (GAP-001)**

- File: `apps/runtime/src/routes/environment-variables.ts:120`
- Change: Replace `if (!environment || !key || !value)` with `if (environment === undefined || !key || value === undefined || value === null)`
- Also update the Zod schema for the create body to use `.nullable()` for environment
- FR: FR-1

  1.2. **Fix EnvVarStore base fallback (GAP-002)**

- File: `apps/runtime/src/services/execution/llm-wiring.ts:253-293`
- Change: In `findEnvVar()`, when the first query (exact environment) returns null, perform a second query with `environment: null` (same tenantId, projectId, key, and namespace filtering)
- Both the namespace-aware and non-namespace paths need the fallback
- FR: FR-2, FR-10

  1.3. **Fix cache sentinel (GAP-004)**

- File: `apps/runtime/src/services/secrets-provider.ts:232-270`
- Change: Replace `if (cached !== undefined)` at L234 with `if (this.envVarCache.has(key))` and return `this.envVarCache.get(key)`
- After resolution (whether found or not), always `this.envVarCache.set(key, value)` where value may be `undefined`
- FR: FR-3, FR-11

  1.4. **Fix namespace pagination (GAP-003)**

- File: `apps/runtime/src/routes/environment-variables.ts:300-370`
- Change: When `namespaceId` is provided, replace the current `findEnvironmentVariables()` + post-filter pattern with a MongoDB aggregation pipeline that does `$lookup` on `variable_namespace_memberships`, `$match` for namespace, then `$facet` with `$skip/$limit` and `$count`
- Use `EnvironmentVariable.aggregate()` directly in the route handler (since the shared repo function is generic and shouldn't know about namespace joins)
- FR: FR-4

  1.5. **Fix validate endpoint base coverage (FR-8)**

- File: `apps/runtime/src/routes/environment-variables.ts:880-886`
- Change: Also query `findEnvironmentVariables({ tenantId, projectId, environment: null })` and merge keys into `definedKeys` set before computing missing
- FR: FR-8

**Files Touched**:

- `apps/runtime/src/routes/environment-variables.ts` — create route, list route, validate route
- `apps/runtime/src/services/execution/llm-wiring.ts` — EnvVarStore.findEnvVar()
- `apps/runtime/src/services/secrets-provider.ts` — getEnvVar() cache logic

**Exit Criteria**:

- [ ] `pnpm build --filter=apps/runtime` succeeds with 0 errors
- [ ] POST `/env-vars` with `{ environment: null, key: "TEST", value: "val" }` returns 201
- [ ] Manually verify (via curl or test) that EnvVarStore resolves base variable when env-specific is missing
- [ ] Existing tests (`pnpm test --filter=apps/runtime`) pass with no regressions
- [ ] `npx prettier --write` on all changed files

**Test Strategy**:

- Manual verification via API calls (quick smoke test)
- Full E2E coverage comes in Phase 4

**Rollback**: Revert individual file changes. Each fix is independent.

---

### Phase 2: New API Endpoints (FR-6, FR-7)

**Goal**: Add diff, export, and import endpoints.

**Tasks**:

2.1. **Add GET `/diff` endpoint**

- File: `apps/runtime/src/routes/environment-variables.ts`
- Use `openapi.route('get', '/diff', { ... })` pattern (same as all other routes in this file)
- Add before the `/:id` parameterized route (Express route ordering)
- Query params: `source` and `target` (both required, validated against `z.enum(VALID_ENVIRONMENTS)`)
- Query all variables for both environments, decrypt values, compare by key
- Return `{ added, removed, changed, unchanged }` — mask values in changed array (show key only)
- Auth: `requireProjectPermission(req, res, 'env_var:read')`
- Wrap in `try/catch` with `log.error()` and 500 response on failure
- FR: FR-6

  2.2. **Add POST `/export` endpoint**

- File: `apps/runtime/src/routes/environment-variables.ts`
- Use `openapi.route('post', '/export', { ... })` pattern
- Add before the `/:id` parameterized route
- Body: `z.object({ environment: z.enum(VALID_ENVIRONMENTS) })`
- Query all variables for the environment, decrypt each, return as JSON array
- Auth: `requireProjectPermission(req, res, 'env_var:read')`
- Audit log: `writeAuditLog({ action: 'env-variable:export', ... })`
- FR: FR-7

  2.3. **Add POST `/import` endpoint**

- File: `apps/runtime/src/routes/environment-variables.ts`
- Use `openapi.route('post', '/import', { ... })` pattern
- Add before the `/:id` parameterized route
- Body: `z.object({ environment: z.enum(VALID_ENVIRONMENTS), variables: z.array(z.object({ key: z.string().regex(KEY_PATTERN), value: z.string().max(16384), isSecret: z.boolean().optional(), description: z.string().optional() })), overwrite: z.boolean().default(false) })`
- Loop through variables: for each, check if exists. If exists and `!overwrite`, skip. Otherwise upsert via `createEnvironmentVariable` or `updateEnvironmentVariable`
- Auth: `requireProjectPermission(req, res, 'env_var:create')`
- Audit log: `writeAuditLog({ action: 'env-variable:import', ... })`
- FR: FR-7

**Files Touched**:

- `apps/runtime/src/routes/environment-variables.ts` — 3 new route handlers

**Exit Criteria**:

- [ ] `pnpm build --filter=apps/runtime` succeeds
- [ ] GET `/diff?source=dev&target=staging` returns correct diff structure
- [ ] POST `/export` returns decrypted variables as JSON
- [ ] POST `/import` creates variables and respects overwrite flag
- [ ] All new endpoints require auth and return 401/403 without it
- [ ] Existing tests pass with no regressions

**Test Strategy**:

- Manual verification via curl
- Full E2E coverage in Phase 4 (E2E-13, E2E-14)

**Rollback**: Remove the 3 new route handler blocks. Zero impact on existing functionality.

---

### Phase 3: Studio UI — Base Value Tab (FR-5)

**Goal**: Allow Studio users to manage base (`environment: null`) variables.

**Tasks**:

3.1. **Update EnvironmentVariablesSection to accept nullable environment**

- File: `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx`
- Change `environment: string` prop to `environment: string | null`
- When `environment` is null, pass `null` (not `undefined`) to API calls
- Ensure the "Create Variable" dialog sends `environment: null`

  3.2. **Add "Base (Default)" tab to EnvironmentsTab**

- File: `apps/studio/src/components/deployments/EnvironmentsTab.tsx`
- Add a new tab before dev/staging/production tabs
- Label: "Base (Default)" with a distinguishing icon or badge
- Renders `EnvironmentVariablesSection` with `environment={null}`

  3.3. **Update useEnvVars hook for null environment**

- File: `apps/studio/src/hooks/useEnvVars.ts`
- Ensure SWR key handles `environment=null` without encoding issues
- API client calls should send `environment=null` in the body (not query string)

**Files Touched**:

- `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx`
- `apps/studio/src/components/deployments/EnvironmentsTab.tsx`
- `apps/studio/src/hooks/useEnvVars.ts`
- `apps/studio/src/api/environment-variables.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=apps/studio` succeeds
- [ ] "Base (Default)" tab visible in Studio UI
- [ ] Can create, read, update, delete base variables from the UI
- [ ] Base tab is visually distinct from environment-specific tabs

**Test Strategy**:

- Manual UI verification in browser
- No automated UI tests (API-level E2E in Phase 4 covers the backend)

**Rollback**: Revert the 3-4 file changes. Base tab disappears, all env-specific functionality intact.

---

### Phase 4: E2E & Integration Tests

**Goal**: Full test coverage per test spec — 14 E2E + 11 integration scenarios.

**Tasks**:

4.1. **Create E2E test infrastructure**

- File: `apps/runtime/src/__tests__/env-vars-e2e.test.ts`
- Setup: MongoMemoryServer, real Express app, full middleware chain, test JWTs
- Shared `beforeAll`/`afterAll` for server lifecycle
- Test data seeding via API calls (no direct DB access)

  4.2. **Implement E2E scenarios E2E-1 through E2E-7** (core CRUD + isolation)

- E2E-1: Full CRUD lifecycle
- E2E-2: Base value + override resolution via deployment
- E2E-3: Copy between environments
- E2E-4: Pre-deploy validation with base fallback
- E2E-5: Duplicate key rejection
- E2E-6: Invalid input rejection
- E2E-7: Cross-project isolation

  4.3. **Implement E2E scenarios E2E-8 through E2E-14** (advanced features)

- E2E-8: Namespace-scoped access
- E2E-9: One active deployment
- E2E-10: Variable count limit
- E2E-11: Base value CRUD (bug fix verification)
- E2E-12: Namespace pagination (bug fix verification)
- E2E-13: Variable diff
- E2E-14: Bulk export/import

  4.4. **Create integration test: secrets-provider**

- File: `apps/runtime/src/__tests__/secrets-provider-integration.test.ts`
- INT-1: Env-specific resolution
- INT-2: Base fallback (bug fix verification)
- INT-11: Cache sentinel (bug fix verification)

  4.5. **Create integration test: snapshot service**

- File: `apps/runtime/src/__tests__/snapshot-service-integration.test.ts`
- INT-3: Base+override dedup
- INT-6: Ciphertext preservation

  4.6. **Create integration test: deployment repo**

- File: `apps/runtime/src/__tests__/deployment-repo-integration.test.ts`
- INT-4: Retire previous active
- INT-7: Concurrent race condition

  4.7. **Create integration test: namespace pagination**

- File: `apps/runtime/src/__tests__/env-vars-namespace-pagination.test.ts`
- INT-9: Aggregation pipeline correctness

**Files Touched**:

- All new test files listed in File-Level Change Map

**Exit Criteria**:

- [ ] All 14 E2E tests pass
- [ ] All 11 integration tests pass (INT-1 through INT-11, INT-8 existing, INT-10 may be deferred if tool-test-service is hard to test in isolation)
- [ ] `pnpm test --filter=apps/runtime` passes with no regressions
- [ ] No `vi.mock()` or `jest.mock()` in any E2E test file
- [ ] No direct DB access (Mongoose model imports) in E2E test file

**Test Strategy**:

- These ARE the tests. Each scenario from the test spec becomes a test case.
- MongoMemoryServer for ephemeral DB
- Real encryption with test master key

**Rollback**: Delete test files. No production code impact.

---

## 4. Wiring Checklist

- [ ] New diff/export/import routes registered in existing router — add BEFORE `/:id` parameterized route to prevent Express capture
- [ ] No new services or DI registration needed
- [ ] No new models needed
- [ ] No new types to export
- [ ] No new middleware needed — reuse existing auth chain
- [ ] No new workers
- [ ] Studio base tab component rendered in EnvironmentsTab parent
- [ ] API client functions in `apps/studio/src/api/environment-variables.ts` updated for new endpoints (if Studio needs to call diff/export/import)

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. The `environment` field already supports `null` in the Mongoose schema enum.

### Feature Flags

None. Per HLD decision D-13.

### Configuration Changes

No new environment variables or config keys.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 bugs fixed (GAP-001 through GAP-004)
- [ ] All 11 functional requirements (FR-1 through FR-11) implemented
- [ ] 14 E2E tests passing
- [ ] 11 integration tests passing
- [ ] `pnpm build` succeeds across all affected packages
- [ ] `pnpm test` passes with no regressions
- [ ] Feature spec status updated to STABLE
- [ ] Testing matrix updated with actual coverage status
- [ ] No `vi.mock()` in E2E tests
- [ ] All new endpoints follow existing auth/audit/rate-limit patterns

---

## 7. Open Questions

1. INT-10 (tool-test-service base fallback) — may be difficult to test in isolation since `createSecretsProviderForToolTest` requires Studio context. Defer if blocking?
2. E2E-2 requires deployment API — should we use the actual deployment endpoint or call `createDeploymentSnapshot` directly? (Recommendation: actual endpoint for true E2E, but accept direct call if deployment API setup is prohibitively complex in test harness.)

---

## 8. FR-to-Task Traceability

| FR    | Task(s)              | Phase |
| ----- | -------------------- | ----- |
| FR-1  | 1.1                  | 1     |
| FR-2  | 1.2                  | 1     |
| FR-3  | 1.3                  | 1     |
| FR-4  | 1.4                  | 1     |
| FR-5  | 3.1, 3.2, 3.3        | 3     |
| FR-6  | 2.1                  | 2     |
| FR-7  | 2.2, 2.3             | 2     |
| FR-8  | 1.5                  | 1     |
| FR-9  | (already working)    | N/A   |
| FR-10 | 1.2 (base fallback)  | 1     |
| FR-11 | 1.3 (cache sentinel) | 1     |
