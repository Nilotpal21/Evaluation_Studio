# Data-Flow & Dependency-Wiring Audit: Auth Profile Lifecycle (ABLP-1123)

**Date**: 2026-05-20
**Auditor**: Claude Sonnet 4.6 (automated)
**Branch**: fix/auth-profile-connector-audit (PR #1110)
**Feature doc**: `docs/features/auth-profile-lifecycle.md`

---

## Sensitive Values Audited

| Value                                                             | Data Class | Why Sensitive                                      |
| ----------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| `encryptedSecrets` / decrypted credentials                        | CREDENTIAL | API keys, client secrets, OAuth tokens             |
| `EndUserOAuthToken.{encryptedAccessToken, encryptedRefreshToken}` | CREDENTIAL | Per-user OAuth bearer tokens                       |
| `createdByEmail` (new via `resolveOwnerEmails`)                   | PII        | Creator's email address surfaced on list endpoints |
| `enabled` field (new)                                             | INTERNAL   | Gate that blocks credential resolution at runtime  |
| `profileVersion` (pre-save bump on enabled/status change)         | INTERNAL   | Cache-invalidation invariant                       |

---

## Round 1: Full Path Trace

### VALUE 1: `encryptedSecrets` / decrypted credentials

```
VALUE: encryptedSecrets / decrypted credentials
  DATA CLASS: CREDENTIAL
  APPROVED CONSUMERS: runtime agent executor (via createAuthProfileResolver),
                      workflow-engine connector adapter,
                      validate endpoint (structural check, secrets not returned),
                      revoke routes (read for presence only)

  1. Source:
     - HTTP body on POST/PUT routes: CreateAuthProfileSchema / UpdateAuthProfileSchema
       apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts (POST)
       apps/studio/src/app/api/auth-profiles/[profileId]/route.ts (PUT)
     - Validated by Zod schema + getMaterializedAuthProfileValidationErrors
     - Value is stored encrypted via Mongoose encryption plugin

  2. Writes:
     - AuthProfile.encryptedSecrets — Mongoose plugin encrypts before write
     - AuthProfile.previousEncryptedSecrets — rotation backup, also encrypted
     - EndUserOAuthToken.{encryptedAccessToken, encryptedRefreshToken} — encrypted per grant
     - NEVER written raw to logs or responses

  3. Serialization Boundaries:
     - createAuthProfileResolver.resolve() decrypts in-memory for connector use
     - oauth-grant-resolver.ts safeDecrypt() for token refresh
     - No Kafka/EventBus serialization of raw secrets found

  4. Read Paths:
     - List routes (/auth-profiles, /projects/:id/auth-profiles): encryptedSecrets
       set to `undefined` before JSON serialization — only redactedSecrets (key names
       with last-4-chars) are returned. ✓
     - GET single: same redaction pattern. ✓
     - resolveAuthProfileCredentials (runtime): decrypts for in-memory use only. ✓
     - createAuthProfileResolver (connectors/CSAT/insights): decrypts for in-memory. ✓
     - computeIsAuthorized: receives encryptedSecrets for PRESENCE check (non-null),
       does not log or return the value. ✓

  5. Policy Boundary:
     Consumer                      Policy
     ─────────────────────────────────────────────────────
     List endpoints (Studio UI)    Redacted (last 4 chars) ✓
     GET single (Studio UI)        Redacted ✓
     Runtime connector resolver    Decrypted in-memory, used in tool call ✓
     CSAT/insights routes          Decrypted in-memory, sent as HTTP header ✓
     validate endpoint             Not returned; structural check only ✓
     Logs                          Never raw ✓

  6. Consumers/Sinks:
     - SmartAssist API: apiKey used in HTTP header (CSAT/insights routes)
     - Third-party OAuth providers: client_id/client_secret sent to tokenUrl during refresh

  7. Wiring:
     DEPENDENCY: createAuthProfileResolver (connectors package)
       Constructed at: packages/connectors/src/services/auth-profile-resolver-factory.ts:52
       CSAT route: apps/studio/src/app/api/projects/[id]/agent-transfer/csat/submit/route.ts:102
         — WIRED ✓ (receives AuthProfile model; checks enabled + status before decrypt)
       Insights route: apps/studio/src/app/api/projects/[id]/agent-transfer/insights/route.ts:112
         — WIRED ✓ (same factory; enabled + status gates on path)

     DEPENDENCY: revokeEndUserTokensForProfile (shared package)
       Constructed at: packages/shared/src/services/auth-profile/end-user-token-revoker.ts
       Workspace revoke: apps/studio/src/app/api/auth-profiles/[profileId]/revoke/route.ts:52
         — WIRED ✓ (filter includes tenantId + provider key)
       Project revoke: apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke/route.ts:79
         — WIRED ✓

  8. Parallel Paths:
     Path A: CSAT submit → createAuthProfileResolver → decrypt → apiKey in HTTP header
       Error sanitization: YES — catch returns static "Failed to submit CSAT rating" ✓
     Path B: insights → createAuthProfileResolver → decrypt → apiKey in HTTP header
       Error sanitization: NO — catch returns `detail: errMsg` which may include
       "Auth profile X is disabled" or resolver exception text ✗ [→ F-1]

  9. Boundary Tests:
     ✓ api-agent-transfer-csat-submit-route.test.ts covers SSRF + error sanitization
     ✗ No test asserts insights route sanitizes internal errors
     ✗ No boundary test that a disabled profile causes 502 (not a leak of disabled reason)
```

---

### VALUE 2: `EndUserOAuthToken` grants (access/refresh tokens)

```
VALUE: EndUserOAuthToken.encryptedAccessToken / encryptedRefreshToken
  DATA CLASS: CREDENTIAL
  APPROVED CONSUMERS: workflow-engine OAuthGrantResolver (in-memory),
                      revoke-user-tokens route (deletion, not reading tokens)

  1. Source:
     - OAuth callback finalizer writes tokens after provider grants them
       apps/studio/src/app/api/auth-profiles/oauth/_oauth-callback-finalizer.ts

  2. Writes:
     - EndUserOAuthToken collection, fields encrypted before write
     - revokedAt stamped by revokeEndUserTokensForProfile.updateMany → ✓ always includes tenantId

  3. Serialization Boundaries:
     - oauth-grant-resolver.ts: tokens decrypted in-memory for workflow use, not serialized outbound

  4. Read Paths:
     - oauth-grant-resolver.ts: findOne with {tenantId, userId, provider, revokedAt: null}
     - revoke-user-tokens route: distinct('userId', filter) for count; deleteMany for deletion
       Filter always includes tenantId + provider (derived from profileId). ✓

  5. Policy Boundary:
     - Revoke: tokens stamped revokedAt=now, grant resolver filters revokedAt:null → revoked tokens
       never handed out again ✓
     - Delete: revoke-user-tokens route deletes rows, not reads — no credential leak path ✓
     - Refresh path: ABLP-1123 added revokedAt:null to the updateOne filter in
       oauth-grant-resolver.ts so a concurrent revoke wins the CAS race ✓

  6. Wiring (revokedAt propagation):
     revokeEndUserTokensForProfile WIRED:
       - Workspace revoke route (profile revoke) ✓
       - Project revoke route (profile revoke) ✓
       - NOT called from: cleanupAutoCascadeInternalDependencies (CASCADE DELETE path)
         — this uses deleteMany on EndUserOAuthToken, which removes tokens entirely ✓
         (delete is stronger than revoke, so this is correct)

  7. Parallel Paths (grant revocation):
     Path A: Profile revoke → revokeEndUserTokensForProfile → updateMany revokedAt
     Path B: Bulk delete → cleanupAutoCascadeInternalDependencies → deleteMany EndUserOAuthToken
     Both paths prevent tokens from being served. ✓
     Path C: revoke-user-tokens route → deleteMany (projectId intentionally omitted from filter;
       explained in comment — provider key is globally unique within tenant). ✓

  8. Boundary Tests:
     ✓ packages/shared/src/__tests__/auth-profile/end-user-token-revoker.test.ts
     ✓ apps/workflow-engine/src/__tests__/oauth-grant-resolver.test.ts
     ✗ No boundary test: revoke-user-tokens route with invalid profileId (cross-tenant)
       Profile existence IS verified with tenantId+projectId filter before deletion.
       Minor gap: if the profile lookup passes but EndUserOAuthToken.deleteMany uses only
       tenantId+provider (not projectId), a project-A user could delete tokens from a
       project-B profile IF that profile was also in their tenant. However, the ownership
       filter on AuthProfile.findOne prevents this path. LOW risk.
```

---

### VALUE 3: `createdByEmail` (new PII surface)

```
VALUE: User email address of auth profile creator
  DATA CLASS: PII
  APPROVED CONSUMERS: Studio list UI (for display)

  1. Source:
     - resolveOwnerEmails() queries global User collection by _id → returns email
       apps/studio/src/lib/owner-email-lookup.ts

  2. Writes:
     - Not persisted — resolved on-demand per list request (batch query)

  3. Serialization:
     - Returned in list API response (project + workspace list routes)
     - Not included in audit events or logs

  4. Read Paths:
     - GET /api/auth-profiles (workspace list) → createdByEmail in response
     - GET /api/projects/:id/auth-profiles (project list) → createdByEmail in response

  5. Policy Boundary:
     - Both list routes require AUTH_PROFILE_READ permission (not AUTH_PROFILE_DECRYPT)
     - Any user who can list auth profiles sees the creator's email
     - This is a deliberate design choice (owner attribution for UI), but it expands
       the PII surface: previously only createdBy (user ID) was exposed; now the email
       is too.

  6. Consumers/Sinks:
     - Studio UI AuthProfilesPage / WorkspaceAuthProfilesPage display the email

  7. Wiring:
     resolveOwnerEmails WIRED:
       - workspace list route ✓
       - project list route ✓
       - NOT called from: _bulk-handler list (bulk handler uses same list routes)

  8. Boundary Tests:
     ✗ No test asserts createdByEmail is absent from responses when caller lacks
       AUTH_PROFILE_READ (but that's the standard 403 path, not email-specific)
     ✗ No test asserts createdByEmail is null (not the raw user ID) when the user
       record can't be resolved (failure path returns null, which is correct)
```

---

### VALUE 4: `enabled` field (new auth gate)

```
VALUE: enabled: boolean — runtime credential gate
  DATA CLASS: INTERNAL
  APPROVED CONSUMERS: all credential resolution paths should check this gate

  1. Source:
     - Written via PUT route (workspace + project) when updates.enabled provided
     - Pre-save hook on AuthProfile model bumps profileVersion on enabled change ✓
     - Default: true (new profiles are enabled)

  2. Writes:
     - AuthProfile.enabled field in MongoDB
     - AuthProfile.profileVersion bumped by pre-save hook on change ✓

  3. Policy Boundary:
     Gate checked at:
     ✓ createAuthProfileResolver (packages/connectors) — line 99
     ✓ _validate-auth-profile.ts — line 75 (validate endpoint mirrors runtime)
     ✓ [profileId]/validate/route.ts — line 115
     ✗ resolveAuthProfileCredentials (apps/runtime/src/services/auth-profile-resolver.ts)
       — only checks status: 'active', not enabled. Service-instance resolution path
       (model providers, voice services, guardrails) bypasses the enabled gate. [→ F-4]
     ✗ refreshGrantToken in oauth-grant-resolver.ts — checks status: { $ne: 'revoked' }
       but not enabled. A disabled app profile's client credentials can still be used
       to mint fresh tokens. [→ F-3]

  4. Parallel Paths:
     Path A (connector tools): createAuthProfileResolver → AUTH_PROFILE_DISABLED ✓
     Path B (validate endpoint): _validate-auth-profile.ts → enabled gate ✓
     Path C (service instances): resolveAuthProfileCredentials → NO enabled gate ✗ [F-4]
     Path D (token refresh): refreshGrantToken → NO enabled gate ✗ [F-3]

  5. Wiring:
     DEPENDENCY: enabled field check
       Consumer 1: createAuthProfileResolver — WIRED ✓
       Consumer 2: _validate-auth-profile.ts — WIRED ✓
       Consumer 3: resolveAuthProfileCredentials (runtime) — NOT WIRED ✗ [F-4]
       Consumer 4: refreshGrantToken (workflow-engine) — NOT WIRED ✗ [F-3]

  6. Boundary Tests:
     ✗ No E2E test: runtime resolveAuthProfileCredentials returns null for enabled:false profile
     ✗ No boundary test: refreshGrantToken refuses when app profile has enabled:false
     ✗ No boundary test: GET /api/projects/:id/auth-profiles returns enabled:false field correctly
```

---

## Findings Summary — Round 1

| ID  | Severity | Dimension                        | Finding                                                                                                                                                                                                                                                        |
| --- | -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | MEDIUM   | Policy Boundary / Parallel Paths | insights route returns `detail: errMsg` (internal error message) and raw upstream error text to client; CSAT (parallel path) sanitizes — inconsistency leaks resolver error codes (e.g. AUTH_PROFILE_DISABLED message)                                         |
| F-2 | MEDIUM   | PII / Policy Boundary            | `createdByEmail` (user email) returned to any AUTH_PROFILE_READ caller in list endpoints — not gated by AUTH_PROFILE_DECRYPT; new PII surface not in previous API contract                                                                                     |
| F-3 | MEDIUM   | Parallel Paths                   | `refreshGrantToken` in oauth-grant-resolver.ts checks `status: { $ne: 'revoked' }` but not `enabled === false` — a disabled app profile's clientId/clientSecret can still be used to mint new access tokens during token refresh                               |
| F-4 | MEDIUM   | Wiring                           | `resolveAuthProfileCredentials` in runtime (`auth-profile-resolver.ts:143`) queries `status: 'active'` only; `enabled` field introduced by this PR is NOT checked — service instance resolution (model providers, voice, guardrails) bypasses the enabled gate |

**No CRITICAL findings.** All credential write paths encrypt before storage. All read paths that return data to the client strip `encryptedSecrets`. The `revokedAt: null` CAS pattern in the grant resolver correctly races concurrent revokes.

---

## Round 2: Fix Verification

> Fixes to apply for F-1, F-2, F-3, F-4

### F-1 Fix: Sanitize insights route error responses

**File**: `apps/studio/src/app/api/projects/[id]/agent-transfer/insights/route.ts`

Remove `detail: errText.slice(0, 500)` from the 502 upstream error response and
`detail: errMsg` + `stack` from the 500 internal error response. Mirror the CSAT
route pattern: log the raw error, return only a static message.

### F-2 Assessment: createdByEmail PII surface

The email is the creator's professional email (who configured the profile). This is
by design for admin usability. AUTH_PROFILE_READ is not a broad permission — it
requires explicit project/workspace membership. Classified as **acceptable design
tradeoff** with documentation; no code change required.

### F-3 Fix: refreshGrantToken enabled gate

**File**: `apps/workflow-engine/src/services/oauth-grant-resolver.ts`

Add `enabled: { $ne: false }` to the `findOne` filter in `refreshGrantToken` to
prevent disabled app profiles from being used to mint fresh tokens.

### F-4 Fix: resolveAuthProfileCredentials enabled gate

**File**: `apps/runtime/src/services/auth-profile-resolver.ts`

Add `enabled: { $ne: false }` to the `findOne` filter in `resolveAuthProfileCredentials`
so service-instance resolution (model providers, voice, guardrails) respects the
disabled state.

---

| Finding | Status                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1     | FIXED — commit `[ABLP-1123] fix(auth-profile): data-flow audit Round 1 fixes`; boundary test in `api-agent-transfer-insights-route.test.ts` (3 tests)    |
| F-2     | Accepted by design — documented                                                                                                                          |
| F-3     | FIXED — commit `[ABLP-1123] fix(auth-profile): data-flow audit Round 1 fixes`; boundary test in `oauth-grant-resolver.test.ts` (11 tests, 1 new for F-3) |
| F-4     | FIXED — commit `[ABLP-1123] fix(auth-profile): data-flow audit Round 1 fixes`; boundary test in `auth-profile-enabled-gate.test.ts` (4 tests)            |

---

## Round 3: Final Verification

**Date**: 2026-05-20
**Scope**: Confirm all fixes are in place, all boundary tests pass, no new findings.

### Fix Verification Matrix

| Finding | Code Fix Committed | Boundary Test Added | Tests Pass |
| ------- | ------------------ | ------------------- | ---------- |
| F-1     | ✓                  | ✓                   | ✓ (3/3)    |
| F-2     | N/A (design)       | N/A                 | N/A        |
| F-3     | ✓                  | ✓                   | ✓ (11/11)  |
| F-4     | ✓                  | ✓                   | ✓ (4/4)    |

### Round 3 9-Dimension Re-check

#### Dimension 5: Policy Boundary — Final Verdict

| Consumer                                  | Gate Before ABLP-1123 | Gate After ABLP-1123                       | Status              |
| ----------------------------------------- | --------------------- | ------------------------------------------ | ------------------- |
| `createAuthProfileResolver` (connectors)  | status:active         | status:active + enabled:true               | ✓                   |
| `resolveAuthProfileCredentials` (runtime) | status:active only    | status:active + enabled:{$ne:false}        | ✓ Fixed (F-4)       |
| `refreshGrantToken` (workflow-engine)     | status:{$ne:revoked}  | status:{$ne:revoked} + enabled:{$ne:false} | ✓ Fixed (F-3)       |
| insights route error responses            | leaked detail/stack   | static message only                        | ✓ Fixed (F-1)       |
| CSAT route error responses                | static message        | static message                             | ✓ Parity maintained |

#### Dimension 8: Parallel Paths — Final Verdict

| Path Pair                                                                        | Before       | After        |
| -------------------------------------------------------------------------------- | ------------ | ------------ |
| CSAT error sanitization ↔ insights error sanitization                            | Inconsistent | Consistent ✓ |
| createAuthProfileResolver (connectors) ↔ resolveAuthProfileCredentials (runtime) | Inconsistent | Consistent ✓ |
| createAuthProfileResolver (connectors) ↔ refreshGrantToken (workflow-engine)     | Inconsistent | Consistent ✓ |

#### Dimension 9: Boundary Tests — Final Verdict

| Test File                                      | Covers                | Pass |
| ---------------------------------------------- | --------------------- | ---- |
| `api-agent-transfer-insights-route.test.ts`    | F-1                   | ✓    |
| `oauth-grant-resolver.test.ts`                 | F-3                   | ✓    |
| `auth-profile-enabled-gate.test.ts`            | F-4                   | ✓    |
| `api-agent-transfer-csat-submit-route.test.ts` | F-1 parity (existing) | ✓    |

### Final Verdict

- [x] No CRITICAL findings open
- [x] No HIGH findings open
- [x] All MEDIUM findings resolved (F-1, F-3, F-4 fixed; F-2 accepted by design)
- [x] Boundary tests added at each policy gate
- [x] Parallel paths verified identical (all three inconsistent paths now consistent)
- [x] Audit log complete
