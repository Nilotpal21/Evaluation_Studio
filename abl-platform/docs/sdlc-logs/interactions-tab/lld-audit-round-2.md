# LLD Audit Round 2: Interactions Tab

**Date**: 2026-04-02
**Phase**: LLD + Implementation Plan
**Auditor**: Manual audit (lld-reviewer agent spawn failed due to model config)
**Artifact**: `docs/plans/2026-04-02-interactions-tab-impl-plan.md`
**Round**: 2 of 5
**Focus**: Pattern consistency — matches existing code, no reinvention

---

## Verdict: APPROVED with recommendations to align with existing patterns

Existing E2E infrastructure discovered. LLD should reuse established patterns instead of creating new helpers. Recommendations provided for alignment.

---

## Existing Patterns Discovered

### 1. E2E Test Infrastructure ✅ EXISTS

**Location**: `apps/studio/e2e/`

**Discovered**:

- 23 E2E test files using `.spec.ts` naming (not `.test.ts`)
- Existing Playwright config at `apps/studio/playwright.config.ts`
- E2E helpers directory at `apps/studio/e2e/helpers/` with 12 helper files
- Global setup/teardown pattern (`global-setup.ts`, `global-teardown.ts`)

**Files**:

- `arch-ai.spec.ts`, `guardrails-comprehensive-e2e.spec.ts`, `full-platform-e2e.spec.ts` (61KB - comprehensive example)
- `sdk-chat-consolidation-e2e.spec.ts`, `workflow-apple-care-e2e.spec.ts`, etc.

**Pattern**: E2E tests in `apps/studio/e2e/`, unit tests in `apps/studio/src/__tests__/`

---

### 2. Playwright Configuration ✅ EXISTS

**File**: `apps/studio/playwright.config.ts`

**Current Config**:

```typescript
{
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,  // LLD proposes: retries: 2
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: studioBaseUrl,  // from env.STUDIO_URL or localhost:5173
    trace: 'on-first-retry',  // LLD proposes same
    screenshot: 'only-on-failure',  // LLD proposes same
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'echo "Using existing PM2 server"',
    url: studioBaseUrl,
    reuseExistingServer: true,  // Expects PM2 already running
  },
}
```

**Alignment**: LLD Phase 3 Task 3.1 proposes creating new Playwright config. **Should reuse existing config** instead.

---

### 3. Auth Helpers ✅ EXISTS

**File**: `apps/studio/e2e/helpers/auth.ts`

**Existing Functions**:

- `loginViaDevApi(page, options)` — Login via POST `/api/auth/dev-login`, inject cookies
- `getDevAccessToken(page, options)` — Get API token for Bearer auth
- `isIsolatedTestLoginEmail(email)` — Check if email is test-isolated

**Auth Flow** (from existing helper):

1. POST `/api/auth/dev-login` with `{ email, name }`
2. Inject `refresh_token` and `access_token` cookies into browser
3. Navigate to landing path (default: `/projects`)

**Email Pattern**: Use `@e2e-smoke.test` domain for isolated test users

- Example: `full-platform@e2e-smoke.test`, `studio-theme-docs@kore.ai`

**LLD Phase 3 Task 3.3**: Proposes creating new `auth.ts` helper with `loginAsTestUser()`, `setAuthContext()`, `getAuthToken()`

**Recommendation**: **REUSE** existing `auth.ts` and functions instead of creating new file. Align LLD task to use `loginViaDevApi()` pattern.

---

### 4. Test Database Pattern ✅ EXISTS (Different Approach)

**File**: `apps/studio/src/__tests__/helpers/studio-api-harness.ts`

**Existing Pattern**: Uses **MongoMemoryServer** (in-memory MongoDB) for unit/integration tests

- Starts in-memory DB, seeds data, runs test, tears down
- No persistent test DB (ephemeral per test run)
- Env snapshot/restore pattern for test isolation

**LLD Phase 3 Task 3.2**: Proposes creating `test-db.ts` with `seedTestSession()`, `seedTraceEvents()`, `clearTestData()` using real MongoDB (`TEST_MONGODB_URI`)

**Difference**:

- **Existing pattern**: In-memory ephemeral DB (unit/integration tests)
- **LLD proposal**: Real MongoDB test database (E2E tests)

**Assessment**: **Both patterns are valid for different test types**

- Unit/integration: MongoMemoryServer (already used)
- E2E: Real MongoDB (proposed in LLD - acceptable, no conflict)

**Recommendation**: LLD can proceed with real MongoDB for E2E tests. Clarify that E2E tests use real DB, integration tests use MongoMemoryServer.

---

### 5. E2E Test File Naming ✅ ALIGNED

**Pattern Discovered**: E2E tests use `.spec.ts` suffix

- `full-platform-e2e.spec.ts`, `guardrails-comprehensive-e2e.spec.ts`, etc.

**Unit Tests**: Use `.test.ts` suffix

- `interactions-flow-dsl.test.ts`, `mfa.test.ts`, etc.

**LLD Proposal**:

- Phase 2: `interactions-integration.test.ts` ✅ CORRECT (unit test naming)
- Phase 4: `e2e/interactions-tab.spec.ts` ✅ CORRECT (E2E test naming)

**Assessment**: ✅ **LLD naming is consistent with existing patterns**

---

### 6. Test Helper Pattern ✅ EXISTS

**Unit Test Helpers**: `apps/studio/src/__tests__/helpers/studio-api-harness.ts`

- Starts Express test server
- Uses MongoMemoryServer
- Env snapshot/restore

**E2E Test Helpers**: `apps/studio/e2e/helpers/` (12 files)

- `api.ts` — API call helpers
- `auth.ts` — Auth helpers (dev-login flow)
- `env.ts` — Environment config (`env.baseUrl`, `env.loginEmail`)
- `ui.ts` — UI interaction helpers (click, wait, etc.)
- `state.ts` — State management helpers
- `global-setup.ts`, `global-teardown.ts` — Test lifecycle

**LLD Phase 1 Task 1.2**: Proposes creating `helpers/test-utils.ts` for integration tests

- Functions: `createMockObservatoryStore()`, `waitForProcessing()`, `assertInteractionCount()`

**Assessment**: ✅ **LLD proposal is fine** — these are integration-test-specific helpers, different from E2E helpers. No conflict.

---

### 7. Fixture Pattern 🔍 LIMITED

**Existing Fixtures**: `apps/studio/src/__tests__/fixtures/docs-content/` (only docs fixtures found)

**No trace event fixtures found**. LLD proposal to create `fixtures/trace-events.ts` is **net new** — no existing pattern to follow.

**Assessment**: ✅ **LLD proposal is acceptable** — filling a gap, not reinventing.

---

## Findings

### HIGH-1: Reuse Existing Auth Helpers Instead of Creating New File

**Location**: Phase 3 Task 3.3 (Create authentication helpers)

**Issue**: LLD proposes creating new `e2e/helpers/auth.ts` with `loginAsTestUser()`, `setAuthContext()`, `getAuthToken()`, but this file **already exists** with established auth patterns.

**Current LLD Text** (Phase 3 Task 3.3):

> Create authentication helpers
>
> - File: `apps/studio/e2e/helpers/auth.ts`
> - Functions: `loginAsTestUser()`, `setAuthContext(tenant, project, user)`, `getAuthToken()`
> - **CRITICAL**: Auth context must include tenant/project/user for isolation verification
> - Use Studio's actual auth flow (POST /api/auth/login), not mocked tokens

**Existing File**: `apps/studio/e2e/helpers/auth.ts` with:

- `loginViaDevApi(page, options)` — Already implements POST `/api/auth/dev-login`, injects cookies
- `getDevAccessToken(page, options)` — Already returns auth token
- Email pattern: `@e2e-smoke.test` domain for isolated users

**Recommendation**: **REUSE existing auth helpers**. Update Phase 3 Task 3.3:

```markdown
3.3. Extend existing authentication helpers (if needed)

- File: `apps/studio/e2e/helpers/auth.ts` — **ALREADY EXISTS**
- Use existing functions: `loginViaDevApi(page, { email: 'interactions-tab@e2e-smoke.test' })`
- Use existing function: `getDevAccessToken(page, { email, baseUrl })` for API tokens
- Test isolation: Use `@e2e-smoke.test` email domain (existing pattern)
- **No new file creation needed** — extend only if tenant/project context helpers missing
```

**Rationale**: Don't reinvent auth helpers that already exist and follow established patterns. Reuse reduces maintenance and ensures consistency.

---

### HIGH-2: Reuse Existing Playwright Config Instead of Creating New

**Location**: Phase 3 Task 3.1 (Install and configure Playwright)

**Issue**: LLD proposes creating new `playwright.config.ts`, but this file **already exists** with similar configuration.

**Current LLD Text**:

> 3.1. Install and configure Playwright
>
> - Create: `apps/studio/playwright.config.ts`
> - Config: Base URL (http://localhost:5173), test directory (`e2e/`), browser (chromium), retries (2), timeout (30s)

**Existing Config**: `apps/studio/playwright.config.ts` — already has testDir='./e2e', retries in CI, trace on first retry, screenshot on failure

**Recommendation**: **REUSE existing Playwright config**. Update Phase 3 Task 3.1:

```markdown
3.1. Verify Playwright is installed (already in package.json)

- **No installation needed** — Playwright already installed
- **No config creation needed** — `playwright.config.ts` already exists
- Verify config: testDir='./e2e', retries=2 in CI, trace='on-first-retry', screenshot='only-on-failure'
- **No changes required** — existing config already suitable
```

**Rationale**: Playwright infrastructure already set up. Phase 3.1 should be verification, not creation.

---

### MEDIUM-1: Integration Tests Use MongoMemoryServer Pattern

**Location**: Phase 2 Test Strategy (Integration Tests)

**Issue**: LLD doesn't specify which DB pattern to use for integration tests. Existing pattern uses MongoMemoryServer (in-memory, ephemeral).

**Existing Pattern**: `studio-api-harness.ts` uses MongoMemoryServer for unit/integration tests — no persistent test DB.

**Recommendation**: Clarify in Phase 2 Test Strategy:

```markdown
**Test Strategy**:

- Integration: Logic-level service boundary. Fixtures → event-processor → assertions on output.
- **No database** — integration tests use in-memory fixtures only (not MongoMemoryServer, not real MongoDB)
- Tests are pure logic tests (event processing), not API/DB integration
```

**Rationale**: Integration tests for Interactions Tab don't need a DB — they test pure event processing logic with in-memory fixtures. Clarify to prevent confusion.

---

### MEDIUM-2: E2E Test DB Strategy Differs from Unit Test DB

**Location**: Phase 3 Task 3.2 (Create test database seeding scripts)

**Issue**: LLD proposes real MongoDB for E2E tests (`TEST_MONGODB_URI`), but existing unit/integration tests use MongoMemoryServer. This is intentional but should be clarified.

**Recommendation**: Add clarifying note to Phase 3 Task 3.2:

```markdown
3.2. Create test database seeding scripts

- File: `apps/studio/e2e/helpers/test-db.ts`
- **Note**: E2E tests use **real MongoDB** (TEST_MONGODB_URI), not MongoMemoryServer
- **Rationale**: E2E tests exercise full system (Studio + MongoDB + auth), not isolated logic
- Unit/integration tests use MongoMemoryServer (different pattern, no conflict)
```

**Rationale**: Clarifies why E2E tests don't follow the MongoMemoryServer pattern. Different test levels have different infrastructure needs.

---

### LOW-1: Phase 3 Exit Criteria Should Not Duplicate Config Creation

**Location**: Phase 3 Exit Criteria

**Issue**: Exit criteria says "Playwright installed: `pnpm playwright --version` succeeds", but Playwright is already installed.

**Recommendation**: Update exit criteria:

```markdown
- [x] Playwright already installed: `pnpm playwright --version` succeeds
- [x] Playwright config already exists: `playwright.config.ts` with correct settings
- [ ] Smoke test passes: `pnpm test:e2e smoke` launches browser, navigates to Studio, page loads
```

**Rationale**: Mark existing infrastructure as "already done" to avoid confusion about what Phase 3 actually creates.

---

## Strengths

1. **E2E test file naming correct**: LLD uses `.spec.ts` for E2E tests, `.test.ts` for unit tests (matches existing pattern)

2. **Test infrastructure segregation**: Unit tests in `src/__tests__/`, E2E tests in `e2e/` (matches existing pattern)

3. **Fixture creation is net new**: No existing trace event fixtures — LLD proposal fills a gap

4. **Integration test helpers are specific**: `test-utils.ts` for integration tests doesn't conflict with existing E2E helpers

5. **Anti-flakiness config matches existing**: `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'` (already in existing config)

6. **Test isolation pattern**: Proposes `tenant_test_001`, `project_test_001`, `user_test_001` for isolation tests (clear naming)

---

## Recommendations Summary

**HIGH Priority** (Avoid reinventing existing infrastructure):

1. **Reuse `e2e/helpers/auth.ts`** — Don't create new auth helper file, use existing `loginViaDevApi()` and `getDevAccessToken()`
2. **Reuse `playwright.config.ts`** — Don't create new Playwright config, verify existing config is sufficient

**MEDIUM Priority** (Clarify test strategy):

1. **Clarify integration test DB pattern** — Integration tests don't need DB (pure logic with in-memory fixtures)
2. **Clarify E2E test DB strategy** — E2E uses real MongoDB (intentionally different from MongoMemoryServer pattern)

**LOW Priority** (Minor updates):

1. **Update Phase 3 exit criteria** — Mark Playwright installation and config as "already done"

---

## Recommendations for Round 3

Round 3 (completeness) should focus on:

1. **FR coverage**: Verify every FR from feature spec is covered by at least one phase task
2. **File paths validation**: Verify all proposed file paths are correct and consistent
3. **Exit criteria measurability**: Ensure all exit criteria are concrete and measurable
4. **Wiring checklist completeness**: Verify wiring checklist covers all new components

---

## Next Steps

1. ✅ Address HIGH-1: Update Phase 3 Task 3.3 to reuse existing auth helpers
2. ✅ Address HIGH-2: Update Phase 3 Task 3.1 to verify (not create) Playwright config
3. ✅ Optional: Address MEDIUM-1 (clarify integration test DB strategy), MEDIUM-2 (E2E test DB note)
4. ✅ Optional: Address LOW-1 (update exit criteria checkboxes)
5. ⏭ Proceed to Round 3 audit (completeness)
