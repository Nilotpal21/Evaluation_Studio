# Low-Level Design: Auth Profiles -- Gap Closure & Hardening

**Feature**: Auth Profiles -- Unified Credential Management
**Status**: DONE (historical gap-closure plan; post-impl sync refreshed 2026-04-03)
**Feature Spec**: [docs/features/auth-profiles.md](../features/auth-profiles.md)
**HLD**: [docs/specs/auth-profiles.hld.md](../specs/auth-profiles.hld.md)
**Test Spec**: [docs/testing/auth-profiles.md](../testing/auth-profiles.md)
**Last Updated**: 2026-04-03

---

## 1. Context

Auth Profiles is a mature feature with comprehensive implementation across 17 auth types, encrypted credential storage, multi-level resolution, OAuth2 lifecycle, Studio control-plane routes, a dedicated runtime auth-profile router, and durable OAuth grant support.

The original March 2026 LLD captured a gap-closure backlog. As of the 2026-04-03 post-implementation sync, most of those gaps are closed:

1. The previously missing runtime and Studio files (`auth-profile-rotation-scheduler.ts`, `auth-profile-tool-middleware.ts`, `paused-execution-store.ts`, `_auth-profile-route-utils.ts`, `_bulk-handler.ts`) are present.
2. Dedicated tests now exist for `applyAuth()`, `dualReadCredentials()`, and secret redaction.
3. Runtime coverage now includes by-name lookup, grace-period fallback, route validation, and durable OAuth grant resolution.
4. Studio coverage now includes bulk actions, OAuth initiate/callback, consumer routes, and workspace listing.
5. The remaining work is primarily advanced addon / protocol E2E breadth, remaining consumer migration away from embedded credentials, and eventual TraceStore-native observability.

The phased plan below is preserved as historical context for how the gap-closure work was organized.

---

## 2. Phased Implementation Plan

### Phase 1: Critical Test Gap Closure (Priority: HIGH)

**Goal**: Create missing tests for the 3 most critical untested paths.

**Exit criteria**:

- applyAuth() unit tests pass for all 17 auth types
- dualReadCredentials() unit tests pass for all 4 branch paths
- redactAuthProfile() unit tests pass for all edge cases

#### Phase 1.1: applyAuth() Dispatcher Tests

**File to create**: `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts`

**Test cases** (17 auth types):

| Auth Type                 | Verify                                      |
| ------------------------- | ------------------------------------------- |
| none                      | Returns empty headers                       |
| api_key                   | Sets header (or query) with prefix          |
| bearer                    | Sets `Authorization: Bearer <token>`        |
| oauth2_app                | Sets `Authorization: Bearer <access_token>` |
| oauth2_token              | Sets `Authorization: Bearer <access_token>` |
| oauth2_client_credentials | Sets `Authorization: Bearer <access_token>` |
| basic                     | Sets `Authorization: Basic <base64>`        |
| custom_header             | Sets custom header with value               |
| aws_iam                   | Returns awsCredentials object               |
| azure_ad                  | Returns azureCredentials object             |
| mtls                      | Returns tlsOptions with cert/key/ca         |
| ssh_key                   | Returns sshCredentials object               |
| digest                    | Returns digestCredentials object            |
| kerberos                  | Returns kerberosCredentials object          |
| saml                      | Returns samlCredentials object              |
| hawk                      | Sets Hawk authorization header              |
| ws_security               | Returns wsSecurityCredentials object        |

**Implementation approach**: Read `apply-auth.ts` source to verify each dispatch path and expected output structure.

#### Phase 1.2: dualReadCredentials() Tests

**File to create**: `packages/shared/src/__tests__/auth-profile/dual-read.test.ts`

**Test cases**:

1. AUTH_PROFILE_ENABLED=true + authProfileId present -> calls resolve(), returns source: 'auth-profile'
2. AUTH_PROFILE_ENABLED=true + authProfileId absent -> calls legacyFallback(), returns source: 'legacy'
3. AUTH_PROFILE_ENABLED=false + authProfileId present -> calls legacyFallback(), returns source: 'legacy'
4. AUTH_PROFILE_ENABLED=false + authProfileId absent -> calls legacyFallback(), returns source: 'legacy'
5. AUTH_PROFILE_ENABLED=true + authProfileId present + resolve() throws -> error propagates (no silent fallback)
6. legacyFallback() throws -> error propagates

**Implementation approach**: Mock `isAuthProfileEnabled()` and verify correct branch execution. Test that errors from resolve() are NOT caught.

#### Phase 1.3: redactAuthProfile() Tests

**File to create**: `packages/shared/src/__tests__/auth-profile/redact.test.ts`

**Test cases**:

1. Strips `encryptedSecrets` from profile object
2. Strips `previousEncryptedSecrets` from profile object
3. Strips `encryptionKeyVersion` from profile object
4. Returns null for null input
5. Returns null for undefined input
6. Does not mutate original object
7. Preserves all non-secret fields
8. `redactAuthProfileList()` strips from all items in array
9. `redactAuthProfileList()` handles empty array

**Implementation approach**: Pure function tests -- no mocking needed.

---

### Phase 2: Feature Flag and Addon Tests (Priority: MEDIUM)

**Goal**: Add tests for feature flag behavior and addon mechanisms.

**Exit criteria**:

- Feature flag unit tests pass for all input values
- applySigning() tests pass for HMAC and RSA
- verifyWebhook() tests pass for valid, tampered, and replay
- applyProxy() tests pass for all auth modes

#### Phase 2.1: Feature Flag Tests

**File to create**: `packages/shared/src/__tests__/auth-profile/feature-flag.test.ts`

**Test cases**:

1. `process.env.AUTH_PROFILE_ENABLED = 'true'` -> returns true
2. `process.env.AUTH_PROFILE_ENABLED = 'false'` -> returns false
3. `process.env.AUTH_PROFILE_ENABLED` undefined -> returns false
4. `process.env.AUTH_PROFILE_ENABLED = 'TRUE'` (uppercase) -> returns false (strict equality)
5. `process.env.AUTH_PROFILE_ENABLED = '1'` -> returns false

#### Phase 2.2: applySigning() Tests

**File to create**: `packages/shared/src/__tests__/auth-profile/apply-signing.test.ts`

**Test cases**: Read `apply-signing.ts` source to determine supported algorithms, then test each.

#### Phase 2.3: verifyWebhook() Tests

**File to create**: `packages/shared/src/__tests__/auth-profile/verify-webhook.test.ts`

**Test cases**: Read `verify-webhook.ts` source for signature algorithms and replay protection, then test each path.

#### Phase 2.4: applyProxy() Tests

**File to create**: `packages/shared/src/__tests__/auth-profile/apply-proxy.test.ts`

**Test cases**: Read `apply-proxy.ts` source for auth modes (none, basic, bearer), then test each.

---

### Phase 3: E2E Test Verification and Fix (Priority: HIGH)

**Goal**: Verify the 3 existing E2E test files run correctly and fix any failures.

**Exit criteria**:

- All 3 E2E test files execute without errors
- Test infrastructure requirements documented

#### Phase 3.1: E2E Test Environment Setup

**Verify prerequisites**:

1. MongoDB available (MongoMemoryServer or Docker)
2. Redis available (redis-mock or Docker)
3. Express server starts on random port
4. Encryption master key configured

#### Phase 3.2: Run and Fix E2E Tests

**Files to verify**:

1. `apps/runtime/src/__tests__/e2e/auth-profile-connector-setup.test.ts`
2. `apps/runtime/src/__tests__/e2e/auth-profile-oauth-flow.test.ts`
3. `apps/runtime/src/__tests__/e2e/auth-profile-token-refresh.test.ts`

**Approach**: Run each file, capture failures, fix broken tests or document infrastructure gaps.

---

### Phase 4: Missing Source File Clarification (Priority: MEDIUM)

**Goal**: Determine the status of 7 missing source files referenced in prior docs.

**Files to investigate**:

| Missing File                                                                | Expected Function               | Investigation                                                         |
| --------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `apps/runtime/src/services/auth-profile/auth-profile-rotation-scheduler.ts` | Periodic rotation scheduling    | Check if rotation is triggered differently (e.g., via BullMQ or cron) |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`    | Tool auth resolution middleware | Check if this logic lives in another file                             |
| `apps/runtime/src/services/auth-profile/paused-execution-store.ts`          | JIT auth pause/resume store     | Check if JIT auth is handled differently                              |
| `apps/runtime/src/services/runtime-maintenance-jobs.ts`                     | Startup/shutdown wiring         | Check if maintenance is wired elsewhere                               |
| `apps/studio/src/app/api/auth-profiles/_auth-profile-route-utils.ts`        | Shared route utilities          | Check if logic is inlined in routes                                   |
| `apps/studio/src/app/api/auth-profiles/_bulk-handler.ts`                    | Bulk action handler             | Check if bulk logic is inlined                                        |
| `apps/studio/src/hooks/useBatchOAuth.ts`                                    | Batch OAuth popup orchestration | Check if this feature is deferred                                     |

**Exit criteria**: Each file classified as (a) implemented elsewhere (document actual location), (b) deferred/not-yet-implemented (add to delivery plan), or (c) no longer needed (remove from docs).

---

### Phase 5: Documentation Corrections (Priority: LOW)

**Goal**: Fix all documentation inaccuracies identified by the SDLC pipeline.

**Changes**:

1. **Feature flag default**: Already corrected in Phase 1 feature spec (was "default: true", now correctly "default: false")
2. **Package naming**: Already corrected (was `@agent-platform/shared-auth-profile`, now `packages/shared/src/services/auth-profile/`)
3. **Unique index count**: Already corrected (was 4 partial, now 2 partial)
4. **Test file inventory**: Already corrected (was 37 files, now 24 verified + 13 missing)
5. **Source file inventory**: Already corrected with Verified column

**Exit criteria**: All documentation artifacts consistent with actual codebase state.

---

## 3. Wiring Checklist

This checklist tracks how auth profile components connect to the rest of the platform.

| #   | Component                          | Wired To                                                               | Verified |
| --- | ---------------------------------- | ---------------------------------------------------------------------- | -------- |
| 1   | AuthProfile model                  | encryptionPlugin (encrypts encryptedSecrets, previousEncryptedSecrets) | YES      |
| 2   | AuthProfile model                  | tenantIsolationPlugin (auto-injects tenantId)                          | YES      |
| 3   | AuthProfile model                  | auditTrailPlugin (tracks mutations)                                    | YES      |
| 4   | AuthProfileService                 | trace-events.ts (emits structured events)                              | YES      |
| 5   | dualReadCredentials                | feature-flag.ts (checks AUTH_PROFILE_ENABLED)                          | YES      |
| 6   | dualReadCredentials                | AuthProfileService.resolve (auth profile path)                         | YES      |
| 7   | token-refresh-service              | refresh-lock.ts (distributed Redis lock)                               | YES      |
| 8   | token-refresh-service              | oauth2-app-resolver.ts (parent app credentials)                        | YES      |
| 9   | client-credentials-service         | Redis (token cache)                                                    | YES      |
| 10  | auth-profile-resolver.ts (runtime) | AuthProfile model (findOne)                                            | YES      |
| 11  | auth-profile-cache.ts (runtime)    | credential-cache.ts (shared LRU)                                       | YES      |
| 12  | auth-profile-rotation-job.ts       | EncryptionService (re-encryption)                                      | YES      |
| 13  | auth-profile-health.ts             | platform-admin-health.ts (health endpoint)                             | YES      |
| 14  | auth-profile-alerting.ts           | Alert evaluator dimensions                                             | YES      |
| 15  | Studio routes                      | Mongoose AuthProfile model                                             | YES      |
| 16  | Studio OAuth routes                | oauth2-app-resolver, linked-app-validator                              | YES      |
| 17  | SearchAI resolver                  | AuthProfile model (findOne)                                            | YES      |
| 18  | project-io resolver                | Auth profile name-based resolution                                     | YES      |
| 19  | auth-profile-delegate.ts           | Execution context propagation                                          | YES      |
| 20  | auth-profile-fanout.ts             | Per-branch credential cache creation                                   | YES      |
| 21  | auth-profile-handoff.ts            | Handoff auth requirement validation                                    | YES      |

---

## 4. Database Migration Plan

No database migrations needed. The auth_profiles collection schema is already deployed and stable. The 2 partial unique indexes are already in place.

If personal-visibility unique indexes are added in the future:

```javascript
// Would add 2 more partial indexes:
AuthProfileSchema.index(
  { tenantId: 1, createdBy: 1, name: 1, environment: 1 },
  { unique: true, partialFilterExpression: { projectId: null, visibility: 'personal' } },
);
AuthProfileSchema.index(
  { tenantId: 1, projectId: 1, createdBy: 1, name: 1, environment: 1 },
  { unique: true, partialFilterExpression: { projectId: { $ne: null }, visibility: 'personal' } },
);
```

This is not currently needed and is listed as an open question.

---

## 5. Test Implementation Plan

### New Test Files to Create (Phase 1-2)

| File                                                                | FR Coverage | Priority |
| ------------------------------------------------------------------- | ----------- | -------- |
| `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts`     | FR-2, FR-3  | HIGH     |
| `packages/shared/src/__tests__/auth-profile/dual-read.test.ts`      | FR-6        | HIGH     |
| `packages/shared/src/__tests__/auth-profile/redact.test.ts`         | FR-5        | HIGH     |
| `packages/shared/src/__tests__/auth-profile/feature-flag.test.ts`   | FR-6        | MEDIUM   |
| `packages/shared/src/__tests__/auth-profile/apply-signing.test.ts`  | FR-2        | MEDIUM   |
| `packages/shared/src/__tests__/auth-profile/verify-webhook.test.ts` | FR-2        | MEDIUM   |
| `packages/shared/src/__tests__/auth-profile/apply-proxy.test.ts`    | FR-2        | MEDIUM   |

### E2E Tests to Verify (Phase 3)

| File                                                                  | FR Coverage | Priority |
| --------------------------------------------------------------------- | ----------- | -------- |
| `apps/runtime/src/__tests__/e2e/auth-profile-connector-setup.test.ts` | FR-6        | HIGH     |
| `apps/runtime/src/__tests__/e2e/auth-profile-oauth-flow.test.ts`      | FR-4        | HIGH     |
| `apps/runtime/src/__tests__/e2e/auth-profile-token-refresh.test.ts`   | FR-4        | HIGH     |

### Missing Test Files to Investigate (Phase 4)

The 13 missing test files may need to be recreated or confirmed as covered elsewhere. See Phase 4 of the implementation plan.

---

## 6. Rollback Strategy

Auth Profiles is a STABLE feature. The gap closure work in this LLD is additive (tests and documentation). No rollback needed for:

- New test files: Simply delete if problematic
- Documentation corrections: Revert git commit
- Source file investigation: Read-only analysis

The only production-affecting change would be adding personal-visibility unique indexes (if decided), which would require:

1. Verify no existing name collisions per owner
2. Apply index in a maintenance window
3. Rollback: Drop the new indexes if collisions are found

---

## 7. Implementation Order

```
Phase 1 (HIGH - ~2 days)
  |
  +-- 1.1 applyAuth() tests (17 test cases)
  +-- 1.2 dualReadCredentials() tests (6 test cases)
  +-- 1.3 redactAuthProfile() tests (9 test cases)
  |
Phase 2 (MEDIUM - ~1 day)
  |
  +-- 2.1 Feature flag tests (5 test cases)
  +-- 2.2 applySigning() tests
  +-- 2.3 verifyWebhook() tests
  +-- 2.4 applyProxy() tests
  |
Phase 3 (HIGH - ~1 day)
  |
  +-- 3.1 E2E environment setup
  +-- 3.2 Run and fix E2E tests
  |
Phase 4 (MEDIUM - ~0.5 day)
  |
  +-- 4.1 Investigate 7 missing source files
  |
Phase 5 (LOW - already done)
  |
  +-- 5.1 Documentation corrections (completed in this SDLC pipeline run)
```

Estimated total effort: ~4.5 days.
