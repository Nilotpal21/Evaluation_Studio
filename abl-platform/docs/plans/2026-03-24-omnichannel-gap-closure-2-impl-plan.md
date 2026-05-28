# LLD: Omnichannel Session Continuity — Gap Closure Phase 2

**Feature Spec**: `docs/features/omnichannel-session-continuity.md`
**Parent LLD**: `docs/plans/2026-03-23-omnichannel-gap-closure-impl-plan.md`
**HLD**: `docs/specs/omnichannel-session-continuity.hld.md`
**Test Spec**: `docs/testing/omnichannel-session-continuity.md`
**Status**: DONE
**Date**: 2026-03-24

---

## 0. Scope

This LLD addresses 6 open gaps from the omnichannel feature spec (§8):

| ID      | Description                                                                               | Severity | Phase |
| ------- | ----------------------------------------------------------------------------------------- | -------- | ----- |
| GAP-017 | 3 of 4 omnichannel E2E test files use wrong SDK signing secret                            | Medium   | 1     |
| GAP-016 | GDPR cascade functions do not clean up omnichannel models                                 | High     | 2     |
| GAP-015 | No retention window field in OmnichannelProjectSettings; no enforcement in recall service | High     | 3     |
| GAP-014 | 5 of 6 identity verifiers implemented but not wired in server.ts verifierMap              | High     | 4     |
| GAP-019 | Real identity verification wiring in server.ts has no E2E test coverage                   | High     | 5     |
| GAP-018 | Zero test coverage for Studio omnichannel routes and OmnichannelSettingsPanel component   | Medium   | 6     |

---

## 1. Design Decisions

| #   | Decision                                                                                                                             | Rationale                                                                                                                                                                                                                  | Alternatives Rejected                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Extract shared `mintSdkSessionToken` helper into `runtime-api-harness.ts` (GAP-017)                                                  | 3 E2E test files duplicate `mintSdkSessionToken` with the wrong signing secret. A shared helper using `TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET` eliminates the class of error.                                             | Fix each file individually (leaves duplication, same bug likely recurs)                                                       |
| D-2 | Anonymize `OmnichannelAuditEvent` on GDPR cascade; hard-delete `ContactCapabilityConsent` and settings (GAP-016)                     | Follows existing `AuditLog` anonymization pattern. Audit events have compliance value (who accessed what) so must be anonymized, not deleted. Consent and settings have no post-deletion audit value.                      | Delete all three (loses audit trail); skip anonymization (GDPR non-compliant)                                                 |
| D-3 | Add `retention` section to `OmnichannelProjectSettings` separate from `recall.maxAgeDays` (GAP-015)                                  | `recall.maxAgeDays` is a recall query window (how far back to look). Retention is a compliance boundary (when data MUST be purged). Mixing these conflates operational and compliance concerns.                            | Reuse `maxAgeDays` for both (compliance boundary confused with query optimization)                                            |
| D-4 | Wire all 5 verifiers simultaneously in `server.ts` (GAP-014)                                                                         | All verifier classes exist and are tested. Phased wiring would leave the Map incomplete across deploys. Single wiring pass is safer and simpler.                                                                           | Phase by verifier type (unnecessary complexity, all already implemented)                                                      |
| D-5 | Fix `method` property on `EmailLinkVerifier` (`'otp'` → `'email_link'`) and `WebhookVerifier` (`'provider'` → `'webhook'`) (GAP-014) | These bugs cause Map key collisions — `email_link` overwrites `otp`, `webhook` overwrites `provider`. The verifierMap keys MUST match each verifier's `method`.                                                            | Keep wrong method values and use different Map keys (breaks `completeVerificationAndLink` which looks up by `attempt.method`) |
| D-6 | Add `'email_link'` and `'webhook'` to `VerificationMethod` union type (GAP-014)                                                      | The union type must include all possible verifier methods for type safety. Without this, `attempt.method` cannot hold these values without a cast.                                                                         | Use string instead of union (loses type safety)                                                                               |
| D-7 | Create generic `ConfigurableOAuthProviderAdapter` (GAP-014)                                                                          | The `OAuthProviderAdapter` interface exists but has no concrete implementation. A generic configurable adapter (authorization URL, token endpoint, userinfo endpoint from env/config) covers standard OAuth 2.0 providers. | Google-specific adapter (too narrow); skip OAuth wiring (leaves gap open)                                                     |
| D-8 | E2E identity verification test via real `RuntimeApiHarness` endpoints (GAP-019)                                                      | The verification flow (initiate → complete → session update) must be tested end-to-end through real HTTP + middleware. OTP is the only verifier testable without external services.                                        | Integration test with mocked verifiers (misses wiring bugs)                                                                   |
| D-9 | Studio tests use `vi.mock` for `apiFetch` following `AttachmentSettingsTab` pattern (GAP-018)                                        | Studio component tests are unit tests, not E2E. The E2E test quality lint only blocks mocks in E2E files. Studio tests mock the fetch layer and test component behavior — this is the established pattern.                 | E2E browser tests (overkill for proxy route + React component)                                                                |

### Key Interfaces & Types

```typescript
// packages/shared-auth/src/types/index.ts (MODIFIED)
export type VerificationMethod =
  | 'none'
  | 'cookie'
  | 'caller_id'
  | 'hmac'
  | 'otp'
  | 'oauth'
  | 'provider'
  | 'email_link'
  | 'webhook';

// packages/database/src/models/omnichannel-project-settings.model.ts (MODIFIED)
// New retention section added to IOmnichannelProjectSettings
retention: {
  maxRetentionDays: number; // Compliance boundary — data older than this MUST be purged
  enableAutoPurge: boolean; // Whether TTL-based auto-purge is active
}

// apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts (NEW impl)
// Generic OAuth provider adapter configurable via constructor
export class ConfigurableOAuthProviderAdapter implements OAuthProviderAdapter {
  constructor(config: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  });
}

// apps/runtime/src/__tests__/helpers/runtime-api-harness.ts (MODIFIED)
// Shared helper exported for all E2E tests
export function mintSdkSessionToken(opts: {
  tenantId: string;
  projectId: string;
  channelId: string;
  sessionId: string;
  contactId?: string;
  identityTier?: number;
  permissions?: string[];
}): string;
```

---

## 2. File-Level Change Map

### Modified Files

| File                                                                                 | Change Description                                                                                                                     | Risk   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`                          | Add shared `mintSdkSessionToken` helper using correct signing secret                                                                   | Low    |
| `apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts`                          | Replace local `mintSdkSessionToken` + `TEST_JWT_SECRET` with shared helper                                                             | Low    |
| `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`                    | Replace local `mintSdkSessionToken` + `TEST_JWT_SECRET` with shared helper                                                             | Low    |
| `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`                   | Replace local `mintSdkSessionToken` + `TEST_JWT_SECRET` with shared helper                                                             | Low    |
| `apps/runtime/src/__tests__/omnichannel-recovery.e2e.test.ts`                        | Replace local `mintSdkSessionToken` with shared helper (already uses correct secret)                                                   | Low    |
| `packages/database/src/cascade/cascade-delete.ts`                                    | Add OmnichannelAuditEvent anonymize + ContactCapabilityConsent/OmnichannelProjectSettings delete to `deleteTenant` and `deleteProject` | Medium |
| `packages/database/src/models/omnichannel-project-settings.model.ts`                 | Add `retention` subdocument schema (`maxRetentionDays`, `enableAutoPurge`)                                                             | Low    |
| `apps/runtime/src/services/omnichannel/types.ts`                                     | Add `retention` to settings types + `retentionMaxDays` to `RecallRequest`                                                              | Low    |
| `apps/runtime/src/services/omnichannel/omnichannel-settings-service.ts`              | Add retention to defaults, `mergeWithDefaults()`, and `updateOmnichannelSettings()`                                                    | Medium |
| `apps/runtime/src/services/omnichannel/recall-service.ts`                            | Enforce retention boundary: clamp `maxAgeDays` to `retentionMaxDays` from request                                                      | Medium |
| `apps/runtime/src/routes/omnichannel.ts`                                             | Add retention Zod schema + pass retention to recall request                                                                            | Medium |
| `packages/shared-auth/src/types/index.ts`                                            | Add `'email_link'` and `'webhook'` to `VerificationMethod` union                                                                       | Low    |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts` | Fix `method` property AND `initiate()` method arg from `'otp'` to `'email_link'`                                                       | Low    |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts`    | Fix `method` property AND `initiate()` method arg from `'provider'` to `'webhook'`                                                     | Low    |
| `apps/runtime/src/server.ts`                                                         | Wire all 5 additional verifiers into `verifierMap`                                                                                     | High   |

### New Files

| File                                                                                                 | Purpose                                                | LOC Estimate |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------ |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/configurable-oauth-provider-adapter.ts` | Generic OAuth 2.0 provider adapter for `OAuthVerifier` | ~80          |
| `apps/runtime/src/__tests__/omnichannel-identity-verification.e2e.test.ts`                           | E2E tests for identity verification flow (OTP path)    | ~250         |
| `apps/studio/src/__tests__/omnichannel-settings-panel.test.tsx`                                      | Unit tests for OmnichannelSettingsPanel component      | ~300         |

---

## 3. Implementation Phases

### Phase 1: E2E SDK Token Fix (GAP-017)

**Goal**: Fix the wrong SDK signing secret in 3 E2E test files and extract a shared helper to prevent recurrence.

**Tasks**:

1.1. Add `mintSdkSessionToken` to `runtime-api-harness.ts`

- Export a function that signs SDK session tokens with `TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET`
- Signature: `mintSdkSessionToken(opts: { tenantId, projectId, channelId, sessionId, contactId?, identityTier?, permissions? }): string`
- Uses `jwt.sign` with `algorithm: 'HS256'`, `expiresIn: '1h'`, `audience: 'sdk-session'` (existing tests use `audience`, not `subject`)
- Must support all optional fields used by existing local implementations (identityTier, permissions)

  1.2. Update `omnichannel-recall.e2e.test.ts`

- Remove local `TEST_JWT_SECRET` constant (line 47)
- Remove local `mintSdkSessionToken` function (lines 68-95)
- Import `mintSdkSessionToken` from `./helpers/runtime-api-harness.js`

  1.3. Update `omnichannel-live-session.e2e.test.ts`

- Same pattern: remove local secret + function, import shared helper

  1.4. Update `omnichannel-privacy-gates.e2e.test.ts`

- Same pattern: remove local secret + function, import shared helper

  1.5. Update `omnichannel-recovery.e2e.test.ts`

- Remove local `mintSdkSessionToken` function (already uses correct secret but still duplicated)
- Import shared helper

**Files Touched**:

- `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` — add shared helper
- `apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts` — replace local helper
- `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts` — replace local helper
- `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts` — replace local helper
- `apps/runtime/src/__tests__/omnichannel-recovery.e2e.test.ts` — replace local helper

**Exit Criteria**:

- [ ] `mintSdkSessionToken` exported from `runtime-api-harness.ts`
- [ ] No local `TEST_JWT_SECRET` constants remain in omnichannel E2E test files
- [ ] No local `mintSdkSessionToken` functions remain in omnichannel E2E test files
- [ ] All 4 omnichannel E2E test suites pass: `pnpm test --filter=runtime -- omnichannel`
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors

**Rollback**: Revert the 5 file changes — each test had its own working (if wrong) token function.

---

### Phase 2: GDPR Cascade Cleanup (GAP-016)

**Goal**: Add omnichannel model cleanup to `deleteTenant` and `deleteProject` cascade functions.

**Tasks**:

2.1. Add omnichannel model imports to `deleteTenant` in `cascade-delete.ts`

- Add `OmnichannelAuditEvent`, `ContactCapabilityConsent`, `OmnichannelProjectSettings` to the dynamic import

  2.2. Add omnichannel cleanup to `deleteTenant` body

- After existing `AuditLog` anonymization block (line ~153):
  - Anonymize `OmnichannelAuditEvent`: `updateMany({ tenantId }, { $set: { data: null, description: '[anonymized]' } })` — retain `sessionId` for audit trail integrity (same as how AuditLog retains record structure post-anonymization; `sessionId` alone is not PII)
  - Delete `ContactCapabilityConsent`: `deleteMany({ tenantId })`
  - Delete `OmnichannelProjectSettings`: `deleteMany({ tenantId })`
- Add counts to `anonymized` and `counts` respectively

  2.3. Add omnichannel model imports to `deleteProject` in `cascade-delete.ts`

- Add `OmnichannelAuditEvent`, `ContactCapabilityConsent`, `OmnichannelProjectSettings` to the dynamic import

  2.4. Add `anonymized` tracking dict to `deleteProject`

- Declare `const anonymized: Record<string, number> = {}` near line 218 (currently only `counts` is declared)
- Change the return statement at line 353 from `anonymized: {}` to `anonymized`

  2.5. Add omnichannel cleanup to `deleteProject` body

- After existing `ProjectSettings` deletion (line ~328):
  - Anonymize `OmnichannelAuditEvent`: `updateMany({ tenantId: projectTenantId, projectId }, { $set: { data: null, description: '[anonymized]' } })` → store in `anonymized.OmnichannelAuditEvent`
  - Delete `ContactCapabilityConsent`: `deleteMany({ tenantId: projectTenantId, projectId })` — scoped by both tenantId and projectId for tenant isolation
  - Delete `OmnichannelProjectSettings`: `deleteMany({ tenantId: projectTenantId, projectId })`
- Add deletion counts to `counts` dict

**Files Touched**:

- `packages/database/src/cascade/cascade-delete.ts` — add omnichannel model cleanup

**Exit Criteria**:

- [ ] `deleteTenant` anonymizes `OmnichannelAuditEvent` and deletes `ContactCapabilityConsent` + `OmnichannelProjectSettings`
- [ ] `deleteProject` anonymizes `OmnichannelAuditEvent` and deletes `ContactCapabilityConsent` + `OmnichannelProjectSettings`
- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] Existing cascade delete tests pass: `pnpm test --filter=@agent-platform/database -- cascade`

**Rollback**: Revert `cascade-delete.ts` — omnichannel data accumulates but no data loss.

---

### Phase 3: Retention Enforcement (GAP-015)

**Goal**: Add a retention compliance boundary to `OmnichannelProjectSettings` and enforce it in the recall service.

**Tasks**:

3.1. Add `retention` subdocument schema to `omnichannel-project-settings.model.ts`

- Add `RetentionConfigSchema`: `{ maxRetentionDays: Number (default: 90), enableAutoPurge: Boolean (default: false) }`
- Add `retention` field to `IOmnichannelProjectSettings` interface
- Add `retention` to the main schema with `default: () => ({})`

  3.2. Wire retention through the settings service layer

- In `apps/runtime/src/services/omnichannel/types.ts`:
  - Add `retention: { maxRetentionDays: number; enableAutoPurge: boolean }` to `IOmnichannelProjectSettings` runtime type
  - Add `retention?: { maxRetentionDays?: number; enableAutoPurge?: boolean }` to `IOmnichannelProjectSettingsUpdate`
  - Add `retentionMaxDays?: number` to `RecallRequest` interface
- In `apps/runtime/src/services/omnichannel/omnichannel-settings-service.ts`:
  - Add `retention: { maxRetentionDays: 90, enableAutoPurge: false }` to `DEFAULT_SETTINGS`
  - Add `retention` merge logic to `mergeWithDefaults()` (currently only merges recall, identity, consent, liveSync)
  - Add `retention` $set handling to `updateOmnichannelSettings()`
- In `apps/runtime/src/routes/omnichannel.ts`:
  - Add `retention` Zod schema to `OmnichannelSettingsUpdateSchema` (matching the 4 existing section schemas)

    3.3. Update recall service to enforce retention boundary

- In `recall-service.ts`, change `const maxAgeDays` to `let maxAgeDays` (line ~150)
- After computing `maxAgeDays`:
  - If `request.retentionMaxDays` is provided, clamp: `maxAgeDays = Math.min(maxAgeDays, request.retentionMaxDays)`
- In the omnichannel route POST handler for recall, pass `settings?.retention?.maxRetentionDays` from the already-loaded `settings` variable into the recall request

**Files Touched**:

- `packages/database/src/models/omnichannel-project-settings.model.ts` — add retention schema
- `apps/runtime/src/services/omnichannel/types.ts` — add retention to runtime types + RecallRequest
- `apps/runtime/src/services/omnichannel/omnichannel-settings-service.ts` — add retention to defaults, merge, update
- `apps/runtime/src/services/omnichannel/recall-service.ts` — enforce retention boundary
- `apps/runtime/src/routes/omnichannel.ts` — add retention Zod schema + pass to recall request

**Exit Criteria**:

- [ ] `IOmnichannelProjectSettings` includes `retention: { maxRetentionDays: number; enableAutoPurge: boolean }`
- [ ] `RetentionConfigSchema` with correct defaults exists
- [ ] Recall service clamps `maxAgeDays` to `retention.maxRetentionDays` when configured
- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] Existing omnichannel E2E tests pass (recall behavior unchanged for default settings)

**Rollback**: Revert schema addition + recall service change. Additive schema change, backward compatible.

---

### Phase 4: Identity Verifier Wiring (GAP-014)

**Goal**: Wire all 5 remaining identity verifiers into `server.ts` and fix type/method bugs.

**Tasks**:

4.1. Add `'email_link'` and `'webhook'` to `VerificationMethod` union in `packages/shared-auth/src/types/index.ts`

- Append `| 'email_link' | 'webhook'` to the existing union

  4.2. Fix `EmailLinkVerifier` method from `'otp'` to `'email_link'` in TWO places

- In `email-link-verifier.ts`, change the `method` class property value (line ~44)
- Also change `method: 'otp'` to `method: 'email_link'` in the `createVerificationAttempt()` call inside `initiate()` (line ~58) — this is what gets stored in the token store and used for verifier Map lookup in `completeVerificationAndLink`

  4.3. Fix `WebhookVerifier` method from `'provider'` to `'webhook'` in TWO places

- In `webhook-verifier.ts`, change the `method` class property value
- Also change `method: 'provider'` to `method: 'webhook'` in the `createVerificationAttempt()` call inside `initiate()` (line ~82)

  4.4. Create `ConfigurableOAuthProviderAdapter`

- New file: `apps/runtime/src/contexts/identity/infrastructure/verifiers/configurable-oauth-provider-adapter.ts`
- Implements `OAuthProviderAdapter` interface from `oauth-verifier.ts`
- Constructor takes `{ authorizationEndpoint, tokenEndpoint, userinfoEndpoint, clientId, clientSecret, redirectUri }`
- `createAuthorizationURL`: builds URL with standard OAuth 2.0 params (client_id, redirect_uri, response_type=code, state, code_challenge) — return `new URL(...)` object
- `validateAuthorizationCode`: POSTs to token endpoint with authorization_code grant
- `fetchUserEmail`: GETs userinfo endpoint with Bearer token, returns email field

  4.5. Wire all verifiers in `server.ts`

- Add imports for all verifier classes (currently only `OtpVerifier` is imported at line ~1379):
  ```
  import { createHmac } from 'node:crypto'; // Check if already imported
  import { EmailLinkVerifier } from './contexts/identity/infrastructure/verifiers/email-link-verifier.js';
  import { HmacVerifier } from './contexts/identity/infrastructure/verifiers/hmac-verifier.js';
  import { ProviderVerifier } from './contexts/identity/infrastructure/verifiers/provider-verifier.js';
  import { WebhookVerifier, SendChallengeFn } from './contexts/identity/infrastructure/verifiers/webhook-verifier.js';
  import { OAuthVerifier } from './contexts/identity/infrastructure/verifiers/oauth-verifier.js';
  import { ConfigurableOAuthProviderAdapter } from './contexts/identity/infrastructure/verifiers/configurable-oauth-provider-adapter.js';
  ```
  Note: Follow the same import pattern used for `OtpVerifier` (check if static or dynamic import).
- After the existing `otpVerifier` creation (line ~1406):
  ```
  const emailLinkVerifier = new EmailLinkVerifier(hmacSecret, tokenStore);
  const hmacVerifier = new HmacVerifier(hmacSecret);
  const providerVerifier = new ProviderVerifier();
  const webhookSendChallenge: SendChallengeFn = async (payload) => {
    // HTTP POST to payload.url with HMAC-signed challenge
    // Note: WebhookVerifier.initiate() wraps sendChallenge in try/catch (line 90-103), so network errors are handled
    const signature = createHmac('sha256', hmacSecret).update(JSON.stringify(payload)).digest('hex');
    const res = await fetch(payload.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
      body: JSON.stringify(payload),
    });
    return { success: res.ok };
  };
  const webhookVerifier = new WebhookVerifier(tokenStore, webhookSendChallenge, hmacSecret);
  ```
- OAuth verifier wiring (conditional — only when ALL 6 OAuth env vars are set):
  ```
  const oauthEnvVars = [
    'IDENTITY_OAUTH_CLIENT_ID', 'IDENTITY_OAUTH_CLIENT_SECRET',
    'IDENTITY_OAUTH_AUTHORIZATION_ENDPOINT', 'IDENTITY_OAUTH_TOKEN_ENDPOINT',
    'IDENTITY_OAUTH_USERINFO_ENDPOINT', 'IDENTITY_OAUTH_REDIRECT_URI',
  ];
  const oauthConfigured = oauthEnvVars.every(v => process.env[v]);
  if (oauthConfigured) {
    const oauthAdapter = new ConfigurableOAuthProviderAdapter({
      authorizationEndpoint: process.env.IDENTITY_OAUTH_AUTHORIZATION_ENDPOINT!,
      tokenEndpoint: process.env.IDENTITY_OAUTH_TOKEN_ENDPOINT!,
      userinfoEndpoint: process.env.IDENTITY_OAUTH_USERINFO_ENDPOINT!,
      clientId: process.env.IDENTITY_OAUTH_CLIENT_ID!,
      clientSecret: process.env.IDENTITY_OAUTH_CLIENT_SECRET!,
      redirectUri: process.env.IDENTITY_OAUTH_REDIRECT_URI!,
    });
    const oauthVerifier = new OAuthVerifier(tokenStore, oauthAdapter);
    verifierMap.set('oauth', oauthVerifier);
  } else if (process.env.IDENTITY_OAUTH_CLIENT_ID) {
    log.warn('OAuth verifier partially configured — missing env vars, skipping', {
      missing: oauthEnvVars.filter(v => !process.env[v]),
    });
  }
  ```
- Update verifierMap construction to include all verifiers:

  ```
  const verifierMap = new Map([
    ['otp', otpVerifier],
    ['email_link', emailLinkVerifier],
    ['hmac', hmacVerifier],
    ['provider', providerVerifier],
    ['webhook', webhookVerifier],
  ]);
  ```

  4.6. Export `ConfigurableOAuthProviderAdapter` from the identity barrel

- Add export to `apps/runtime/src/contexts/identity/index.ts`
- Note: All 6 verifier classes are already exported from this barrel (lines 57-67). Only the new adapter class needs a new export line.

**Files Touched**:

- `packages/shared-auth/src/types/index.ts` — extend union type
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts` — fix method
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts` — fix method
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/configurable-oauth-provider-adapter.ts` — new
- `apps/runtime/src/server.ts` — wire all verifiers
- `apps/runtime/src/contexts/identity/index.ts` — export adapter

**Exit Criteria**:

- [ ] `VerificationMethod` union includes `'email_link'` and `'webhook'`
- [ ] `EmailLinkVerifier.method === 'email_link'` (both property and `initiate()` attempt creation)
- [ ] `WebhookVerifier.method === 'webhook'` (both property and `initiate()` attempt creation)
- [ ] `ConfigurableOAuthProviderAdapter` implements `OAuthProviderAdapter` with all 3 methods
- [ ] `verifierMap` in `server.ts` contains entries for: `otp`, `email_link`, `hmac`, `provider`, `webhook` (and `oauth` when env vars set)
- [ ] `pnpm build --filter=@agent-platform/shared-auth` succeeds with 0 errors
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] Existing identity verification tests pass
- [ ] Existing omnichannel E2E tests pass

**Rollback**: Revert type union change + server.ts wiring + verifier method fixes. OTP-only verification continues working.

---

### Phase 5: Identity Verification E2E Tests (GAP-019)

**Goal**: Add E2E test coverage for the identity verification flow through real HTTP endpoints.

**Tasks**:

5.1. Create `omnichannel-identity-verification.e2e.test.ts`

- Uses `RuntimeApiHarness` pattern
- Imports shared `mintSdkSessionToken` from harness
- Test scenarios:
  a. **Initiate OTP verification**: `POST /api/identity/verify/initiate` returns attemptId and method
  b. **Complete OTP verification with valid proof**: `POST /api/identity/verify/complete` with correct OTP → success, session `identityTier` updated
  c. **Complete with invalid proof**: Wrong OTP → failure response with appropriate error code
  d. **Complete with expired attempt**: Attempt past TTL → NOT_FOUND error
  e. **Session reflects verification**: After successful verification, `GET /api/sessions/:id` shows updated `verifiedIdentity`
  f. **Verifier map has all methods**: Initiate with each supported method succeeds (or returns appropriate "not configured" for OAuth without env vars)

  5.2. Verify E2E test passes against real harness

- All tests use real Express + MongoMemoryServer + Redis (from harness)
- No mocks of codebase components

**Files Created**:

- `apps/runtime/src/__tests__/omnichannel-identity-verification.e2e.test.ts`

**Exit Criteria**:

- [ ] 6+ E2E test scenarios pass: `pnpm test --filter=runtime -- omnichannel-identity-verification`
- [ ] Tests use real HTTP endpoints (no mocked routes)
- [ ] Tests verify session state changes after verification
- [ ] No E2E test quality lint violations
- [ ] All existing omnichannel tests still pass

**Rollback**: Delete the test file — no production code changes.

---

### Phase 6: Studio Omnichannel Tests (GAP-018)

**Goal**: Add unit test coverage for the Studio omnichannel settings panel and proxy routes.

**Tasks**:

6.1. Create `omnichannel-settings-panel.test.tsx`

- Follow `attachment-settings-tab.test.tsx` pattern:
  - Mock `apiFetch` via `vi.hoisted` + `vi.mock`
  - Mock `useNavigationStore`, `sonner`, `next-intl`
  - Render with `NextIntlClientProvider`
- Test scenarios:
  a. **UT-1: renders loading state**: Component shows loading indicator while fetching
  b. **UT-2: renders settings form on successful load**: All 4 sections (recall, identity, consent, liveSync) rendered with correct defaults
  c. **UT-3: renders settings from API response**: Custom values from GET response displayed correctly
  d. **UT-4: save sends PATCH with changed fields**: Toggle a setting, click save, verify PATCH body
  e. **UT-5: shows success toast on save**: After successful PATCH, toast.success called
  f. **UT-6: shows error toast on save failure**: PATCH returns error, toast.error called
  g. **UT-7: handles runtime unreachable gracefully**: GET returns null data, component shows defaults

  Note: Retention UI and audit events UI do not yet exist in `OmnichannelSettingsPanel.tsx`. Tests for those sections will be added when the UI is implemented (future gap).

  6.2. Add i18n messages fixture for omnichannel settings

- Create messages object matching `settings.omnichannel.*` keys used by the component

**Files Created**:

- `apps/studio/src/__tests__/omnichannel-settings-panel.test.tsx`

**Exit Criteria**:

- [ ] 7+ unit tests pass: `pnpm test --filter=studio -- omnichannel-settings-panel`
- [ ] Tests follow `AttachmentSettingsTab` test pattern (vi.mock for apiFetch, NextIntlClientProvider wrapper)
- [ ] All existing Studio tests pass: `pnpm test --filter=studio`
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Rollback**: Delete the test file — no production code changes.

---

## 4. Wiring Checklist

- [ ] `ConfigurableOAuthProviderAdapter` exported from `apps/runtime/src/contexts/identity/index.ts`
- [ ] All 5 new verifiers instantiated and added to `verifierMap` in `server.ts`
- [ ] `OmnichannelAuditEvent`, `ContactCapabilityConsent`, `OmnichannelProjectSettings` imported in `cascade-delete.ts` for both `deleteTenant` and `deleteProject`
- [ ] `retention` section added to `OmnichannelProjectSettings` schema and interface
- [ ] `retention` wired through settings service (defaults, merge, update, Zod schema)
- [ ] `'email_link'` and `'webhook'` added to `VerificationMethod` union in `shared-auth`
- [ ] `mintSdkSessionToken` exported from `runtime-api-harness.ts` and imported by all 4 omnichannel E2E test files

## 5. Cross-Phase Concerns

### Database Migrations

No migration scripts needed. All schema changes are additive:

- `OmnichannelProjectSettings.retention` has defaults (`maxRetentionDays: 90`, `enableAutoPurge: false`)
- Existing documents without `retention` will use Mongoose defaults on read

### Configuration Changes

New optional env vars for OAuth verifier (Phase 4):

- `IDENTITY_OAUTH_CLIENT_ID` — OAuth client ID (enables OAuth verifier when set)
- `IDENTITY_OAUTH_CLIENT_SECRET` — OAuth client secret
- `IDENTITY_OAUTH_AUTHORIZATION_ENDPOINT` — Authorization URL
- `IDENTITY_OAUTH_TOKEN_ENDPOINT` — Token exchange URL
- `IDENTITY_OAUTH_USERINFO_ENDPOINT` — Userinfo URL
- `IDENTITY_OAUTH_REDIRECT_URI` — Redirect URI after auth

Existing env var (unchanged):

- `IDENTITY_VERIFICATION_HMAC_SECRET` — used by OTP, HMAC, email-link, and webhook verifiers

## 6. Risk Assessment

| Risk                                                                | Likelihood | Impact | Mitigation                                                                 |
| ------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------- |
| EmailLinkVerifier method fix breaks existing OTP tests              | Low        | Medium | EmailLinkVerifier has its own unit tests; OTP verifier is a separate class |
| GDPR cascade changes break existing cascade delete tests            | Low        | Medium | Additive — new deleteMany/updateMany calls after existing ones             |
| Retention enforcement changes recall behavior for existing projects | Low        | Medium | Default `maxRetentionDays: 90` is wider than default `maxAgeDays: 30`      |
| OAuth verifier wiring fails without env vars                        | Medium     | Low    | Conditional wiring — only instantiated when all 6 OAuth env vars are set   |
| Shared `mintSdkSessionToken` signature mismatch breaks tests        | Low        | Low    | Single source of truth; all tests use the same helper                      |

## 7. Acceptance Criteria (Whole Feature Gap Closure)

- [ ] All 6 gaps addressed (GAP-014, GAP-015, GAP-016, GAP-017, GAP-018, GAP-019)
- [ ] Feature spec gaps table updated: all 6 marked as Mitigated
- [ ] All omnichannel tests pass (existing + new)
- [ ] No regressions: `pnpm build && pnpm test`
- [ ] GDPR cascade covers all omnichannel models
- [ ] Retention boundary enforced in recall service
- [ ] All 6 identity verifiers wired in `server.ts`
- [ ] Studio settings panel has unit test coverage
- [ ] Identity verification has E2E test coverage
- [ ] SDK token signing secret correct across all E2E tests
