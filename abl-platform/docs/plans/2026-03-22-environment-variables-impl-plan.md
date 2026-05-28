# LLD & Implementation Plan: Environment Variables

**Status:** ALPHA
**Slug:** `environment-variables`
**Date:** 2026-03-22
**Feature Spec:** `docs/features/environment-variables.md`
**Test Spec:** `docs/testing/environment-variables.md`
**HLD:** `docs/specs/environment-variables.hld.md`

---

## 1. Summary

The environment variables feature is substantially implemented. This LLD documents the current implementation and defines a phased plan to close the remaining gaps identified in the feature spec and HLD:

1. **Phase 1:** Base fallback in RuntimeSecretsProvider (live resolution path)
2. **Phase 2:** Studio UI for base value management
3. **Phase 3:** E2E and integration test suite
4. **Phase 4:** Hardening (variable diff, validation improvements, observability)

Each phase has explicit exit criteria and is independently shippable.

## 2. Current Implementation Status

### 2.1 Implemented Components

| Component                               | File                                                                     | Status                     |
| --------------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| Canonical Environment type              | `packages/config/src/environment.ts`                                     | Complete                   |
| Environment Variable model              | `packages/database/src/models/environment-variable.model.ts`             | Complete                   |
| Deployment model (partial unique index) | `packages/database/src/models/deployment.model.ts`                       | Complete                   |
| Snapshot model                          | `packages/database/src/models/deployment-variable-snapshot.model.ts`     | Complete                   |
| Config Variable model                   | `packages/database/src/models/project-config-variable.model.ts`          | Complete                   |
| CRUD routes                             | `apps/runtime/src/routes/environment-variables.ts`                       | Complete                   |
| Security repo                           | `apps/runtime/src/repos/security-repo.ts`                                | Complete                   |
| Deployment repo                         | `apps/runtime/src/repos/deployment-repo.ts`                              | Complete                   |
| Snapshot service (base+override dedup)  | `apps/runtime/src/services/snapshot-service.ts`                          | Complete                   |
| RuntimeSecretsProvider                  | `apps/runtime/src/services/secrets-provider.ts`                          | Partial (no base fallback) |
| EnvVarStore implementation              | `apps/runtime/src/services/execution/llm-wiring.ts`                      | Complete                   |
| Studio API client                       | `apps/studio/src/api/environment-variables.ts`                           | Complete                   |
| Studio SWR hook                         | `apps/studio/src/hooks/useEnvVars.ts`                                    | Complete                   |
| Studio UI (per-environment)             | `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` | Partial (no base)          |

### 2.2 Gaps

| Gap                                                  | Severity | Phase   |
| ---------------------------------------------------- | -------- | ------- |
| No base fallback in `getEnvVar()` (live resolution)  | Medium   | Phase 1 |
| Studio UI cannot manage base (null) variables        | Medium   | Phase 2 |
| No E2E tests for base+override lifecycle             | High     | Phase 3 |
| No integration tests for secrets provider resolution | High     | Phase 3 |
| No variable diff between environments                | Low      | Phase 4 |
| Tool test service may lack base fallback             | Medium   | Phase 1 |

## 3. Phase 1: Base Fallback in RuntimeSecretsProvider

**Goal:** Enable live (non-snapshot) resolution to fall back to base variables when no environment-specific override exists.

**Duration:** 1 day
**Risk:** Low — additive change, no breaking behavior

### 3.1 Task 1: Add Base Fallback to `getEnvVar()`

**File:** `apps/runtime/src/services/secrets-provider.ts`
**Lines:** ~232-270 (getEnvVar method)

**Current behavior:** Queries `envVarStore.findEnvVar({ environment: this.environment, key })`. If no result, returns `undefined`.

**Target behavior:** If no env-specific result, query `envVarStore.findEnvVar({ environment: null, key })` as base fallback. If base found, decrypt and cache. If neither found, proceed to existing namespace warning logic.

**Change description:**

```typescript
// In getEnvVar(), after the existing findEnvVar call returns null:
// Add base fallback query
if (!record) {
  const baseRecord = await this.envVarStore.findEnvVar({
    tenantId: this.tenantId,
    projectId: this.projectId,
    environment: null, // base lookup
    key,
    variableNamespaceIds: this.variableNamespaceIds,
  });

  if (baseRecord) {
    const value = this.decryptor.decryptForTenant(baseRecord.encryptedValue, this.tenantId);
    this.envVarCache.set(key, value);
    log.debug('Environment variable resolved from base', { key, layer: 'envVarStore-base' });
    return value;
  }
}
```

**Type change required:** The `EnvVarStore.findEnvVar()` interface parameter `environment` must accept `string | null`:

```typescript
// In secrets-provider.ts, EnvVarStore interface:
environment: string | null; // null = base lookup
```

**Impact on EnvVarStore implementation** (`llm-wiring.ts`): The MongoDB query `{ environment: params.environment }` already handles `null` correctly — `{ environment: null }` matches documents where environment is null. No change needed in the implementation.

### 3.2 Task 2: Update EnvVarStore Interface Type

**File:** `apps/runtime/src/services/secrets-provider.ts`
**Line:** ~56

**Change:** `environment: string;` -> `environment: string | null;`

### 3.3 Task 3: Add Base Fallback to Studio Tool Test Service

**File:** `apps/studio/src/services/tool-test-service.ts`

**Investigation needed:** Read the file to find how it creates a secrets provider. If it uses `RuntimeSecretsProvider` from the runtime package, the Phase 1 change propagates automatically. If it has a separate implementation, apply the same two-query pattern.

### 3.4 Exit Criteria

- [ ] `RuntimeSecretsProvider.getEnvVar("KEY")` returns base value when no env-specific override exists
- [ ] `RuntimeSecretsProvider.getEnvVar("KEY")` returns env-specific value when both base and override exist
- [ ] `RuntimeSecretsProvider.getEnvVar("KEY")` returns `undefined` when neither base nor override exists
- [ ] EnvVarStore interface accepts `environment: string | null`
- [ ] Studio tool test service resolves base variables
- [ ] Build passes: `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio`
- [ ] Existing tests pass: `pnpm test --filter=@agent-platform/runtime -- --run`

## 4. Phase 2: Studio UI for Base Value Management

**Goal:** Allow users to create, view, and edit base (shared) variables from the Studio UI.

**Duration:** 2-3 days
**Risk:** Medium — UI change, requires UX decisions on how to present base vs override

### 4.1 Task 1: Update EnvironmentVariablesSection Props

**File:** `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx`

**Current:** `environment: string` prop (required)
**Target:** `environment: string | null` prop, where `null` means "base variables"

When `environment` is `null`:

- Fetch variables with `environment: null` filter (or no environment filter to show all)
- Create new variables with `environment: null`
- Label as "Base / Shared" in the UI
- Show indicator for which variables have per-environment overrides

### 4.2 Task 2: Add Environment Selector Tab

**File:** New or modified component in `apps/studio/src/components/deployments/`

Add a tab or dropdown with options:

- **Base (Shared)** — variables with `environment: null`
- **Dev** — variables with `environment: "dev"`
- **Staging** — variables with `environment: "staging"`
- **Production** — variables with `environment: "production"`

When the user selects an environment tab, the `EnvironmentVariablesSection` fetches and displays variables for that environment. When "Base" is selected, it shows base variables.

### 4.3 Task 3: Visual Indicator for Override Status

For each base variable, show an indicator if it has per-environment overrides:

- Green dot: override exists for this environment
- No dot: using base value

For each env-specific variable, show if it's overriding a base value:

- "Overrides base: [base value preview]" tooltip

### 4.4 Exit Criteria

- [ ] Users can create base variables (environment: null) from Studio UI
- [ ] Users can view base variables separately from env-specific variables
- [ ] Users can edit and delete base variables
- [ ] Visual indicator shows override status
- [ ] Tab/dropdown switches between base and per-environment views
- [ ] Build passes: `pnpm build --filter=@agent-platform/studio`

## 5. Phase 3: E2E and Integration Test Suite

**Goal:** Implement the test scenarios defined in `docs/testing/environment-variables.md`.

**Duration:** 3-5 days
**Risk:** Medium — test infrastructure setup, encryption in tests

### 5.1 Task 1: Test Infrastructure Setup

**Files:**

- `apps/runtime/src/__tests__/e2e/env-vars-e2e.test.ts` (new)
- `apps/runtime/src/__tests__/integration/secrets-provider-env-vars.test.ts` (new)

**Setup requirements:**

- MongoMemoryServer for ephemeral DB
- Real encryption service with test master key
- Express server on random port with full middleware chain
- Test auth helper for creating JWTs with specific permissions
- Test data factories for creating projects, tenants, variables

### 5.2 Task 2: Implement E2E Tests (E2E-1 through E2E-10)

Priority order:

1. E2E-1: Full CRUD lifecycle (foundational)
2. E2E-2: Base+override via deployment (validates core feature)
3. E2E-5: Duplicate key rejection (data integrity)
4. E2E-7: Cross-project isolation (security)
5. E2E-3: Copy between environments
6. E2E-6: Invalid input rejection
7. E2E-8: Namespace-scoped access
8. E2E-9: One-active-deployment
9. E2E-4: Environment validation
10. E2E-10: Variable count limit

### 5.3 Task 3: Implement Integration Tests (INT-1 through INT-8)

Priority order:

1. INT-1: SecretsProvider env-specific resolution (core path)
2. INT-2: SecretsProvider base fallback (new in Phase 1)
3. INT-3: Snapshot base+override dedup
4. INT-5: Encryption round-trip
5. INT-6: Snapshot ciphertext preservation
6. INT-4: Deployment repo retire previous
7. INT-7: Concurrent deployment race condition
8. INT-8: Environment normalization (may already be covered by existing unit tests)

### 5.4 Exit Criteria

- [ ] 10 E2E test scenarios implemented and passing
- [ ] 8 integration test scenarios implemented and passing
- [ ] No mocks of codebase components in E2E tests
- [ ] Real MongoDB (MongoMemoryServer) and encryption in all tests
- [ ] Tests run in CI pipeline

## 6. Phase 4: Hardening

**Goal:** Close remaining gaps and improve operational readiness.

**Duration:** 2-3 days
**Risk:** Low — independent improvements

### 6.1 Task 1: Variable Diff Between Environments

**New endpoint:** `GET /api/projects/:projectId/env-vars/diff?env1=dev&env2=production`

**Response:**

```typescript
{
  success: true,
  diff: {
    onlyInEnv1: [{ key: "DEV_ONLY_VAR", environment: "dev" }],
    onlyInEnv2: [{ key: "PROD_ONLY_VAR", environment: "production" }],
    bothDiffer: [{ key: "API_URL", env1Value: "dev-url", env2Value: "prod-url" }],
    bothSame: [{ key: "SHARED_KEY" }],
    baseOnly: [{ key: "BASE_VAR" }],
  }
}
```

### 6.2 Task 2: Improved Validation

Enhance the validate endpoint to also check:

- Variables defined but never referenced in any agent (unused variables)
- Variables with base value but no overrides (potentially forgot to set environment-specific values)
- Variables approaching the value size limit

### 6.3 Task 3: Observability Improvements

- Add metrics for variable resolution cache hit rate
- Add metrics for base fallback usage frequency
- Add structured log for snapshot creation latency
- Add alert configuration for resolution failure rate

### 6.4 Exit Criteria

- [ ] Diff endpoint implemented and tested
- [ ] Enhanced validation returns unused variables and coverage warnings
- [ ] Observability metrics exported
- [ ] All new code has E2E or integration tests

## 7. File Change Matrix

### Phase 1 Files

| File                                            | Change                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `apps/runtime/src/services/secrets-provider.ts` | Add base fallback in `getEnvVar()`, update EnvVarStore interface type |
| `apps/studio/src/services/tool-test-service.ts` | Verify/add base fallback                                              |

### Phase 2 Files

| File                                                                     | Change                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` | Accept `environment: string \| null`, base variable management |
| `apps/studio/src/components/deployments/EnvironmentVariablesTabs.tsx`    | New — environment selector tabs                                |
| `apps/studio/src/api/environment-variables.ts`                           | Already supports `environment: string \| null`                 |

### Phase 3 Files

| File                                                                       | Change                                   |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/runtime/src/__tests__/e2e/env-vars-e2e.test.ts`                      | New — 10 E2E test scenarios              |
| `apps/runtime/src/__tests__/integration/secrets-provider-env-vars.test.ts` | New — secrets provider integration tests |
| `apps/runtime/src/__tests__/integration/snapshot-env-vars.test.ts`         | New — snapshot integration tests         |
| `apps/runtime/src/__tests__/integration/deployment-retire.test.ts`         | New — deployment repo tests              |

### Phase 4 Files

| File                                               | Change                              |
| -------------------------------------------------- | ----------------------------------- |
| `apps/runtime/src/routes/environment-variables.ts` | Add diff endpoint, enhance validate |
| `apps/runtime/src/services/secrets-provider.ts`    | Add observability metrics           |

## 8. Risk Assessment

| Risk                                                        | Probability | Impact | Mitigation                                                                 |
| ----------------------------------------------------------- | ----------- | ------ | -------------------------------------------------------------------------- |
| Base fallback causes unexpected behavior in existing agents | Low         | Medium | Base only applies when no env-specific value exists; additive behavior     |
| Encryption setup in test environment                        | Medium      | High   | Use `encryption_master_key` env var, document setup in test infrastructure |
| Studio UI complexity for base vs override                   | Medium      | Medium | Start with simple tab view, iterate based on user feedback                 |
| MongoMemoryServer partial index support                     | Low         | High   | Verify index creation in test setup, fail fast if missing                  |

## 9. Dependencies Between Phases

```
Phase 1 (Base Fallback) ──────┐
                               ├──► Phase 3 (Tests)
Phase 2 (Studio UI) ──────────┘        │
                                        ▼
                                 Phase 4 (Hardening)
```

- Phase 3 depends on Phase 1 (tests validate base fallback behavior)
- Phase 3 can partially run in parallel with Phase 2 (API tests don't need UI)
- Phase 4 is independent but benefits from Phase 3 test infrastructure

## 10. Wiring Checklist

Critical integration points that must be verified after implementation:

- [ ] `RuntimeSecretsProvider.getEnvVar()` calls `envVarStore.findEnvVar({ environment: null })` as fallback
- [ ] `EnvVarStore` interface in `secrets-provider.ts` accepts `environment: string | null`
- [ ] `llm-wiring.ts` EnvVarStore implementation handles `{ environment: null }` MongoDB query correctly
- [ ] `snapshot-service.ts` queries `{ environment: { $in: [env, null] } }` and deduplicates
- [ ] `deployment-repo.ts` `retirePreviousActiveDeployment` returns pre-update document
- [ ] `deployment.model.ts` has partial unique index on `(projectId, environment)` where `status: 'active'`
- [ ] Studio `EnvironmentVariablesSection` passes `environment: null` for base variable operations
- [ ] Studio `api/environment-variables.ts` sends `environment: null` in create payload
- [ ] Route handler in `environment-variables.ts` accepts `environment: null` via Zod schema
- [ ] Copy route only copies env-specific overrides, not base values
- [ ] Validate route checks base variables as fallback when reporting coverage

## 11. Success Metrics

| Metric                          | Target                            | Measurement                |
| ------------------------------- | --------------------------------- | -------------------------- |
| Base fallback resolution works  | 100% of tests pass                | INT-2 test                 |
| E2E test coverage               | 10 scenarios passing              | CI pipeline                |
| Integration test coverage       | 8 scenarios passing               | CI pipeline                |
| No regression in existing tests | 0 failures                        | CI pipeline                |
| Studio base variable management | Users can CRUD base variables     | Manual verification        |
| Variable diff accuracy          | 100% match with manual inspection | E2E test for diff endpoint |
