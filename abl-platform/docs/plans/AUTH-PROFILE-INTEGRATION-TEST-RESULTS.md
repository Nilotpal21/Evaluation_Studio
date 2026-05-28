# Auth Profile — Integration Test Results

**Date:** 2026-03-18
**Runner:** vitest 4.0.18
**Scope:** All `*auth-profile*` test files across packages

---

## Summary

| Category                | Files  | Passed  | Failed | Skipped | Notes                                   |
| ----------------------- | ------ | ------- | ------ | ------- | --------------------------------------- |
| **E2E Tests (new)**     | 6      | 61      | 0      | 0       | All 7 suites green                      |
| **Runtime integration** | 14     | 90      | 37     | 0       | 3 files with known gaps                 |
| **Database**            | 6      | 73      | 0      | 15      | 15 skipped need MongoMemoryServer       |
| **Shared**              | 3      | 87      | 0      | 0       | All green                               |
| **Compiler**            | 2      | 20      | 0      | 0       | All green                               |
| **Project-IO**          | 1      | 11      | 0      | 0       | All green                               |
| **Studio**              | 4      | 29      | 45     | 0       | 2 files with module resolution issues   |
| **Search-AI**           | 3      | 8       | 4      | 0       | search-ai resolveByName not implemented |
| **Connectors**          | 1      | 5       | 0      | 0       | All green                               |
| **TOTAL**               | **40** | **384** | **86** | **15**  |                                         |

---

## E2E Test Files (All PASS)

See [AUTH-PROFILE-E2E-CHECKLIST.md](./AUTH-PROFILE-E2E-CHECKLIST.md) for detailed scenario-by-scenario results.

**Architecture (03-18 update):** JIT auth tests (Suites 1, 5, 7) were rewritten to remove all `vi.mock()` on codebase modules. Auth profiles are seeded via the new `authProfileRoutes` REST API (supertest) against real MongoMemoryServer. Only Redis and Logger remain mocked (true infrastructure boundaries).

| File                                                                 | Tests | Result  |
| -------------------------------------------------------------------- | ----- | ------- |
| `apps/runtime/src/__tests__/e2e/auth-jit-multichannel.test.ts`       | 14    | ✅ PASS |
| `apps/runtime/src/__tests__/e2e/auth-preflight-multichannel.test.ts` | 14    | ✅ PASS |
| `apps/runtime/src/__tests__/e2e/auth-oauth-callback-jit.test.ts`     | 5     | ✅ PASS |
| `packages/compiler/src/__tests__/e2e/auth-dsl-to-runtime.test.ts`    | 13    | ✅ PASS |
| `apps/runtime/src/__tests__/e2e/auth-jit-rich-content.test.ts`       | 4     | ✅ PASS |
| `apps/studio/src/__tests__/e2e/auth-studio-events.test.ts`           | 11    | ✅ PASS |

---

## Passing Integration Tests

### Runtime

| File                                                   | Tests | Result  | Covers Roadmap IS            |
| ------------------------------------------------------ | ----- | ------- | ---------------------------- |
| `auth-profile-cache.test.ts`                           | 10    | ✅ PASS | IS-2.8 (cache behavior)      |
| `auth-profile-health.test.ts`                          | 4     | ✅ PASS | Infrastructure health        |
| `auth-profile-propagation.test.ts`                     | 13    | ✅ PASS | Multi-agent auth propagation |
| `auth-profile/secrets-provider-auth-profile.test.ts`   | 6     | ✅ PASS | IS-2.1 (secrets resolution)  |
| `auth-profile/tool-oauth-service-auth-profile.test.ts` | 5     | ✅ PASS | IS-5.1 (OAuth service)       |
| `auth-profile/model-resolution-auth-profile.test.ts`   | 6     | ✅ PASS | Model-level auth profile     |
| `auth-profile-alerting.test.ts`                        | ✅    | ✅ PASS | IS-3.10 (credential age)     |
| `auth-profile-config-var-resolution.test.ts`           | ✅    | ✅ PASS | IS-2.6 (config vars)         |
| `auth-profile-consumer-error-handling.test.ts`         | ✅    | ✅ PASS | IS-1.8 (consumer errors)     |
| `auth-profile-credential-age-monitor.test.ts`          | ✅    | ✅ PASS | IS-3.10 (credential age)     |
| `auth-profile-rotation.test.ts`                        | 9     | ✅ PASS | IS-1.5 (rotation job)        |
| `auth-profile-rotation-scheduler.test.ts`              | ✅    | ✅ PASS | IS-1.5 (rotation lifecycle)  |
| `auth-profile-mtls-tool-executor.test.ts`              | ✅    | ✅ PASS | IS-3.1 (mTLS)                |
| `auth-profile-voice-cache-invalidation.test.ts`        | 5     | ✅ PASS | IS-3.10 (voice cache)        |
| `e2e/auth-profile-connector-setup.test.ts`             | ✅    | ✅ PASS | Connector setup              |
| `e2e/auth-profile-oauth-flow.test.ts`                  | 4     | ✅ PASS | IS-5.1 (OAuth flow)          |

### Database

| File                                        | Tests | Result  | Notes                |
| ------------------------------------------- | ----- | ------- | -------------------- |
| `auth-profile-factory.test.ts`              | ✅    | ✅ PASS | Fixture generation   |
| `auth-profile/auth-profile-model.test.ts`   | ✅    | ✅ PASS | Schema validation    |
| `auth-profile/auth-profile-indexes.test.ts` | ✅    | ✅ PASS | Index verification   |
| `model-auth-profile.test.ts`                | 22+   | ✅ PASS | 15 skipped (need DB) |
| `auth-profile-audit-events.test.ts`         | ✅    | ✅ PASS | IS-3.9 (audit trail) |
| `cascade-delete-auth-profile.test.ts`       | ✅    | ✅ PASS | IS-1.3 (cascade)     |

### Shared

| File                           | Tests | Result  | Covers Roadmap IS                                |
| ------------------------------ | ----- | ------- | ------------------------------------------------ |
| `auth-profile-schema.test.ts`  | ✅    | ✅ PASS | Schema validation                                |
| `auth-profile-errors.test.ts`  | 4     | ✅ PASS | Error types                                      |
| `auth-profile-service.test.ts` | 40+   | ✅ PASS | IS-1.3, IS-2.2, IS-2.3 (resolve, delete, access) |

### Compiler + Project-IO

| File                               | Tests | Result  | Covers Roadmap IS       |
| ---------------------------------- | ----- | ------- | ----------------------- |
| `ir/compiler-auth-profile.test.ts` | 4     | ✅ PASS | IS-2.5, IS-2.7 (DSL→IR) |
| `ir/validate-auth-profile.test.ts` | 5     | ✅ PASS | IS-2.7 (validation)     |
| `auth-profile-mapping.test.ts`     | 11    | ✅ PASS | Import/export mapping   |

### Studio

| File                              | Tests | Result  |
| --------------------------------- | ----- | ------- |
| `api-auth-profile-routes.test.ts` | ✅    | ✅ PASS |
| `api-auth-profile-bulk.test.ts`   | ✅    | ✅ PASS |

### Search-AI + Connectors

| File                                         | Tests | Result  |
| -------------------------------------------- | ----- | ------- |
| `embedding-credentials-auth-profile.test.ts` | 4     | ✅ PASS |
| `resolver-auth-profile.test.ts`              | 4     | ✅ PASS |
| `token-manager-auth-profile.test.ts`         | 5     | ✅ PASS |

---

## Failing Integration Tests

### Runtime — Pre-existing Gaps (Not caused by our changes)

| File                                             | Failed | Root Cause                                                                                                                               | Roadmap Phase     |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `auth-profile-cache-name-based.test.ts`          | 8      | `cache.setByName()` / `cache.getByName()` not implemented on AuthProfileCache                                                            | Phase 2 (IS-2.8)  |
| `auth-profile-resolve-by-name.test.ts`           | 17     | `getAuthProfileCache` not exported from `auth-profile-cache.ts`                                                                          | Phase 2 (IS-2.1)  |
| `auth-profile-tool-executor-integration.test.ts` | 9      | Same: `getAuthProfileCache` not exported                                                                                                 | Phase 2 (IS-2.10) |
| `auth-profile-resolver-grace-period.test.ts`     | 3      | `resolveWithGracePeriod()` passes corrupted JSON strings directly to `JSON.parse()` — grace period not yet wired into resolver correctly | Phase 1 (IS-1.6)  |
| `e2e/auth-profile-token-refresh.test.ts`         | 2      | Lock key prefix mismatch: tests expect `auth-profile:refresh-lock:` but code uses `auth-profile:op-lock:`                                | Phase 1 (IS-1.5)  |

### Studio — Module Resolution Issues

| File                                          | Failed | Root Cause                                                                                                                                               |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-profiles/auth-profile-api.test.ts`      | 35     | `ERR_MODULE_NOT_FOUND` for `@/app/api/projects/[id]/auth-profiles/...` dynamic imports — vitest can't resolve Next.js path aliases in dynamic `import()` |
| `auth-profiles/auth-profile-security.test.ts` | 10     | Same module resolution issue                                                                                                                             |

### Search-AI

| File                                   | Failed | Root Cause                                                    | Roadmap Phase    |
| -------------------------------------- | ------ | ------------------------------------------------------------- | ---------------- |
| `auth-profile-resolve-by-name.test.ts` | 4      | `resolveByName` function not implemented in search-ai package | Phase 2 (IS-2.2) |

---

## Roadmap Integration Scenarios Coverage

### Phase 1: Hardening & Wiring

| IS     | Scenario                       | Test Coverage                                                                              | Status                                       |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| IS-1.1 | SSRF blocked on validate       | No test file found                                                                         | ❌ NOT COVERED                               |
| IS-1.2 | SSRF blocked on OAuth callback | No test file found                                                                         | ❌ NOT COVERED                               |
| IS-1.3 | Cascade delete                 | `cascade-delete-auth-profile.test.ts` ✅, `auth-profile-service.test.ts` (delete tests) ✅ | ✅ COVERED                                   |
| IS-1.4 | Redis down consent             | No test file found                                                                         | ❌ NOT COVERED                               |
| IS-1.5 | Rotation job lifecycle         | `auth-profile-rotation.test.ts` ✅, `auth-profile-rotation-scheduler.test.ts` ✅           | ✅ COVERED (unit), ❌ not wired in server.ts |
| IS-1.6 | Grace period fallback          | `auth-profile-resolver-grace-period.test.ts` — 3 FAIL                                      | ⚠️ FAILING                                   |
| IS-1.7 | Consumer count accuracy        | `auth-profile-service.test.ts` (getConsumerCount) ✅                                       | ✅ COVERED                                   |
| IS-1.8 | Consumer error handling        | `auth-profile-consumer-error-handling.test.ts` ✅                                          | ✅ COVERED                                   |

### Phase 2: Name Resolution + DSL

| IS     | Scenario                         | Test Coverage                                                                                         | Status                                        |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| IS-2.1 | DSL → Compile → Resolve → HTTP   | `auth-dsl-to-runtime.test.ts` ✅ (compile), `auth-profile-tool-executor-integration.test.ts` — 9 FAIL | ⚠️ PARTIAL (compile OK, executor not wired)   |
| IS-2.2 | Name resolution tenant isolation | `auth-profile-resolve-by-name.test.ts` — FAIL                                                         | ⚠️ FAILING (getAuthProfileCache not exported) |
| IS-2.3 | Environment-based resolution     | `auth-profile-service.test.ts` (resolve with env) ✅                                                  | ✅ COVERED                                    |
| IS-2.4 | auth_profile precedence          | `compiler-auth-profile.test.ts` ✅                                                                    | ✅ COVERED (compile-time)                     |
| IS-2.5 | auth_jit compiles                | `auth-dsl-to-runtime.test.ts` (4.2) ✅                                                                | ✅ COVERED                                    |
| IS-2.6 | Config var interpolation         | `auth-profile-config-var-resolution.test.ts` ✅, `auth-dsl-to-runtime.test.ts` (4.5) ✅               | ✅ COVERED                                    |
| IS-2.7 | Compile-time validation warnings | `validate-auth-profile.test.ts` ✅, `auth-dsl-to-runtime.test.ts` (4.9) ✅                            | ✅ COVERED                                    |
| IS-2.8 | Cache behavior name-based        | `auth-profile-cache-name-based.test.ts` — 8 FAIL                                                      | ⚠️ FAILING (setByName not implemented)        |

### Phase 3: mTLS + Bulk + Infra

| IS      | Scenario                  | Test Coverage                                                                                        | Status                  |
| ------- | ------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| IS-3.1  | mTLS tool call            | `auth-profile-mtls-tool-executor.test.ts` ✅                                                         | ✅ COVERED              |
| IS-3.2  | Studio mTLS creation      | No test                                                                                              | ❌ NOT COVERED (manual) |
| IS-3.3  | Bulk delete mixed         | `api-auth-profile-bulk.test.ts` ✅                                                                   | ✅ COVERED              |
| IS-3.4  | Bulk tenant isolation     | `api-auth-profile-bulk.test.ts` ✅                                                                   | ✅ COVERED              |
| IS-3.5  | Bulk revoke/activate      | `api-auth-profile-bulk.test.ts` ✅                                                                   | ✅ COVERED              |
| IS-3.6  | Bulk action limits        | `api-auth-profile-bulk.test.ts` ✅                                                                   | ✅ COVERED              |
| IS-3.7  | SDKChannel encryption     | `sdk-channel.model.ts` has encryption plugin ✅                                                      | ✅ IMPLEMENTED          |
| IS-3.8  | TokenManager auth profile | `token-manager-auth-profile.test.ts` ✅                                                              | ✅ COVERED              |
| IS-3.9  | Audit trail redaction     | `auth-profile-audit-events.test.ts` ✅                                                               | ✅ COVERED              |
| IS-3.10 | Credential age monitoring | `auth-profile-credential-age-monitor.test.ts` ✅, `auth-profile-voice-cache-invalidation.test.ts` ✅ | ✅ COVERED              |

### Phase 4: Preflight Consent

| IS      | Scenario                    | Test Coverage                | Status                            |
| ------- | --------------------------- | ---------------------------- | --------------------------------- |
| IS-4.1  | Full preflight flow         | E2E Suite 2 (2.1-2.9) ✅     | ✅ COVERED                        |
| IS-4.2  | Existing tokens skip        | E2E Suite 2 (2.8) ✅         | ✅ COVERED                        |
| IS-4.3  | "Connect All" sequential    | No test (UI-level)           | ❌ NOT COVERED (requires browser) |
| IS-4.4  | Mixed consent modes         | E2E Suite 2 (2.9) ✅         | ✅ COVERED                        |
| IS-4.5  | Auth gate blocks messages   | E2E Suite 2 (2.5) ✅         | ✅ COVERED                        |
| IS-4.6  | Consent persistence         | Not testable without full DB | ❌ NOT COVERED                    |
| IS-4.7  | Scope deduplication         | E2E Suite 4 (4.7) ✅         | ✅ COVERED                        |
| IS-4.8  | Preflight timeout/abandon   | E2E Suite 2 (2.6) ✅         | ✅ COVERED                        |
| IS-4.9  | SDK preflight               | E2E Suite 2 (2.2) ✅         | ✅ COVERED                        |
| IS-4.10 | Zero preflight requirements | E2E Suite 2 (2.7) ✅         | ✅ COVERED                        |

### Phase 5: JIT Auth

| IS      | Scenario              | Test Coverage                          | Status         |
| ------- | --------------------- | -------------------------------------- | -------------- |
| IS-5.1  | Full JIT flow         | E2E Suites 1 + 3 ✅                    | ✅ COVERED     |
| IS-5.2  | JIT timeout           | E2E Suite 1 (1.5) ✅, Suite 5 (5.4) ✅ | ✅ COVERED     |
| IS-5.3  | JIT user cancels      | E2E Suite 1 (1.4) ✅                   | ✅ COVERED     |
| IS-5.4  | Second tool JIT       | Not explicitly tested                  | ❌ NOT COVERED |
| IS-5.5  | Multiple pending JIT  | Not explicitly tested                  | ❌ NOT COVERED |
| IS-5.6  | Disconnect during JIT | E2E Suite 7 (7.3) ✅                   | ✅ COVERED     |
| IS-5.7  | SDK custom handler    | Not testable (SDK-side)                | ❌ NOT COVERED |
| IS-5.8  | SDK default handler   | Not testable (SDK-side)                | ❌ NOT COVERED |
| IS-5.9  | Non-OAuth JIT error   | E2E Suite 1 (1.6) ✅                   | ✅ COVERED     |
| IS-5.10 | OAuth callback race   | E2E Suite 3 (3.3) ✅                   | ✅ COVERED     |
| IS-5.11 | Concurrent sessions   | E2E Suite 7 (7.1, 7.2) ✅              | ✅ COVERED     |

---

## Coverage Summary

| Phase     | Scenarios | Covered      | Failing    | Not Covered  |
| --------- | --------- | ------------ | ---------- | ------------ |
| Phase 1   | 8         | 4            | 1          | 3            |
| Phase 2   | 8         | 5            | 2          | 1            |
| Phase 3   | 10        | 9            | 0          | 1            |
| Phase 4   | 10        | 8            | 0          | 2            |
| Phase 5   | 11        | 7            | 0          | 4            |
| **Total** | **47**    | **33 (70%)** | **3 (6%)** | **11 (23%)** |

### Remaining Gaps (11 not covered)

1. **IS-1.1, IS-1.2**: SSRF validation tests — implementation exists but no tests
2. **IS-1.4**: Redis down consent — no test
3. **IS-3.2**: Studio mTLS form — manual UI testing needed
4. **IS-4.3**: "Connect All" UI flow — browser-level testing needed
5. **IS-4.6**: Consent persistence across sessions — needs full DB integration
6. **IS-5.4**: Second tool JIT in same conversation — can be added
7. **IS-5.5**: Multiple pending JIT tool calls — can be added
8. **IS-5.7, IS-5.8**: SDK-side handlers — needs SDK test harness

### Failing Tests Root Causes (3)

1. **Grace period** (IS-1.6): `resolveWithGracePeriod()` not wired correctly into resolver
2. **Name-based cache** (IS-2.8): `setByName`/`getByName` methods not implemented on `AuthProfileCache`
3. **Tool executor integration** (IS-2.1, IS-2.2): `getAuthProfileCache` not exported — Phase 2 work
