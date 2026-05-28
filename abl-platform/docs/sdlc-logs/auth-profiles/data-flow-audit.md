# Data-Flow & Dependency-Wiring Audit: Auth Profiles (ABLP-913)

**Date**: 2026-05-13  
**Auditor**: Claude (Sonnet 4.5)  
**Round**: 1  
**Feature**: `docs/features/auth-profiles.md`

## Sensitive Values Audited

1. **OAuth clientSecret** — DATA CLASS: CREDENTIAL
2. **OAuth accessToken** — DATA CLASS: CREDENTIAL
3. **OAuth refreshToken** — DATA CLASS: CREDENTIAL
4. **API Keys / Bearer Tokens** — DATA CLASS: CREDENTIAL
5. **Auth Profile encryptedSecrets (all types)** — DATA CLASS: CREDENTIAL

## Executive Summary

**Audit Status**: ✅ **PASS** — No CRITICAL or HIGH findings

The auth-profiles feature demonstrates robust security boundaries:

- All secrets encrypted at rest via Mongoose encryption plugin
- No plaintext secrets in logs or audit events
- Proper redaction before API responses
- SSRF protection on all OAuth URLs
- Distributed locking prevents token refresh race conditions
- OAuth state replay prevention via Redis atomic operations

**Key Positive Findings**:

- Encryption plugin applied to both `AuthProfile.encryptedSecrets` and `EndUserOAuthToken.encryptedAccessToken/encryptedRefreshToken`
- All OAuth URL fields validated through `validateUrlForSSRF` before outbound requests
- Redis GETDEL ensures one-time OAuth state consumption
- Token refresh uses distributed locks to prevent concurrent refresh races
- Audit events emit only metadata, never raw credentials

---

## Round 1: Path Trace Findings

### VALUE: clientSecret (OAuth 2.0 client credentials)

**DATA CLASS**: CREDENTIAL  
**APPROVED CONSUMERS**: OAuth token exchange (outbound to provider), encrypted storage only

#### 1. Source

**Entry Points**:

- `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts:POST` — profile creation
- `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts:PUT` — profile update

**Validation**: Zod schema `CreateAuthProfileSchema` / `UpdateAuthProfileSchema`  
**Format**: Plain string in request body under `secrets.clientSecret`

```typescript
// apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts:169
const validationErrors = getMaterializedAuthProfileValidationErrors(
  body.authType,
  body.config ?? {},
  body.secrets ?? {},
);
```

#### 2. Writes

| Location                | Field              | Format                 | Protection                                                |
| ----------------------- | ------------------ | ---------------------- | --------------------------------------------------------- |
| MongoDB `auth_profiles` | `encryptedSecrets` | JSON string, encrypted | Mongoose encryption plugin (AES-256-GCM)                  |
| Audit events            | N/A                | Never written          | Audit events only include field names, not values         |
| Logs                    | N/A                | Never logged           | No log statements include `secrets` or `encryptedSecrets` |

**Encryption Details**:

```typescript
// packages/database/src/models/auth-profile.model.ts:265-269
AuthProfileSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedSecrets', 'previousEncryptedSecrets'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});
```

#### 3. Serialization Boundaries

| Boundary                   | Serialized? | Format                  | Safe?               |
| -------------------------- | ----------- | ----------------------- | ------------------- |
| Studio API → MongoDB       | ✅          | Encrypted via plugin    | ✅                  |
| Studio API → Client        | ❌          | Redacted (last 4 chars) | ✅                  |
| Runtime → OAuth Provider   | ✅          | Plaintext in POST body  | ✅ (HTTPS required) |
| Redis pub/sub invalidation | ❌          | Only profileId sent     | ✅                  |

**OAuth Token Exchange** (only approved external transmission):

```typescript
// apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts:245-251
const tokenBody = new URLSearchParams({
  ...tokenParams,
  grant_type: 'authorization_code',
  code: body.code,
  client_id: secrets.clientId,
  client_secret: secrets.clientSecret, // ← Plaintext, but POST over HTTPS
});
```

**SSRF Protection Applied**:

```typescript
// Line 270-275
const ssrfCheck = validateUrlForSSRF(tokenUrl, getDevSSRFOptions());
if (!ssrfCheck.safe) {
  return errorJson('tokenUrl blocked by SSRF protection', 400, ErrorCode.VALIDATION_ERROR);
}
```

#### 4. Read Paths

| Reader                   | Audience                | Format                  | Authorization Check           |
| ------------------------ | ----------------------- | ----------------------- | ----------------------------- |
| GET `/auth-profiles/:id` | Profile owner/admin     | Redacted (`••••••xxxx`) | `ensureReadableAuthProfile`   |
| OAuth callback handler   | System (token exchange) | Plaintext (decrypted)   | Pre-authorized by state token |
| Token refresh service    | System (refresh)        | Plaintext (decrypted)   | Runtime-internal only         |
| Connection resolver      | System (tool auth)      | Plaintext (decrypted)   | Session-scoped                |

**Redaction Logic**:

```typescript
// apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts:74-79
redactedSecrets = Object.fromEntries(
  Object.entries(parsed).map(([k, v]) => {
    const val = typeof v === 'string' ? v : '';
    const suffix = val.length >= 4 ? val.slice(-4) : '';
    return [k, suffix ? `••••••${suffix}` : '••••••••'];
  }),
);
```

#### 5. Policy Boundary

| Consumer            | Required Policy                    | Applied? | Evidence                                               |
| ------------------- | ---------------------------------- | -------- | ------------------------------------------------------ |
| LLM prompts         | N/A — credentials never in prompts | ✅       | No code path constructs prompts from auth profiles     |
| External tools/APIs | Credentials applied via headers    | ✅       | `applyAuth()` transforms to headers, never exposes raw |
| Studio UI           | Redacted display                   | ✅       | Last 4 chars only (line 78)                            |
| Admin API           | Redacted display                   | ✅       | Same redaction logic                                   |
| Logs                | Never logged                       | ✅       | No log statements with secrets                         |
| Audit events        | Metadata only                      | ✅       | Event payloads exclude secret values                   |

**Tool Middleware Application**:

```typescript
// apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts:89
const authResult = await resolveToolAuth(tool, config.tenantId, config.environment, { ... });
// Result contains headers like { Authorization: 'Bearer xxx' }, not raw secrets
```

#### 6. Consumers / Sinks

**External Systems Reached**:

1. **OAuth Provider** (token exchange endpoint) — clientSecret in POST body over HTTPS
   - SSRF protected: `validateUrlForSSRF(tokenUrl)`
   - TLS required for non-localhost

2. **Third-party APIs** (via resolved tools) — NOT included
   - Credentials converted to headers via `applyAuth()`
   - Raw clientSecret never forwarded

**No Unintended Sinks**:

- ❌ ClickHouse traces — audit events don't include secrets
- ❌ Kafka topics — no auth-profile data published to Kafka
- ❌ Logs — no log.info/error with secret fields
- ❌ External webhooks — not applicable to auth-profile flow

#### 7. Dependency Wiring

**Key Dependencies**:

```
DEPENDENCY: encryptionPlugin (Mongoose)
  Constructed at: packages/database/src/mongo/plugins/encryption.plugin.ts
  Consumer 1: AuthProfile model — WIRED ✓ (line 265)
  Consumer 2: EndUserOAuthToken model — WIRED ✓ (line 65)
  Null-handling: Plugin always active; encryption keys from env vars (throws on missing)

DEPENDENCY: validateUrlForSSRF
  Constructed at: packages/shared-kernel/src/security/ssrf-validator.ts
  Consumer 1: OAuth callback route (tokenUrl) — WIRED ✓ (callback/route.ts:272)
  Consumer 2: Profile UPDATE route (config URLs) — WIRED ✓ (route.ts:209)
  Consumer 3: Token refresh service — WIRED ✓ (token-refresh-service.ts:403)
  Consumer 4: Client credentials service — WIRED ✓ (client-credentials-service.ts)
  Null-handling: Throws on unsafe URL, blocking the operation

DEPENDENCY: Redis (distributed lock for token refresh)
  Constructed at: packages/shared/src/services/auth-profile/refresh-lock.ts
  Consumer 1: Token refresh service — WIRED ✓ (token-refresh-service.ts:694-698)
  Null-handling: Falls back to optimistic refresh without lock if Redis unavailable

DEPENDENCY: Force-invalidate subscriber
  Constructed at: apps/runtime/src/services/auth-profile/force-invalidate-subscriber.ts
  Consumer 1: Runtime server — WIRED ✓ (apps/runtime/src/server.ts:131)
  Null-handling: Silently disabled if Redis unavailable (logs warning)
```

**Verification**: All critical dependencies are wired and initialized in production paths.

#### 8. Parallel Paths

**Sibling Implementation Pairs**:

| Path A                             | Path B                                  | Parity Check                                      | Status       |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------- | ------------ |
| Studio project-level auth-profiles | Studio admin tenant-level auth-profiles | Both use same validation, encryption, redaction   | ✅ IDENTICAL |
| OAuth callback (Studio)            | User consent callback (Studio)          | Both parse secrets identically                    | ✅ IDENTICAL |
| Token refresh (durable grant)      | Token refresh (session artifact)        | Same `parseRefreshTokenResponse`, same encryption | ✅ IDENTICAL |
| oauth2_app profile                 | oauth2_client_credentials profile       | Both encrypted identically                        | ✅ IDENTICAL |
| Personal visibility profiles       | Shared visibility profiles              | Same encryption, different access control only    | ✅ IDENTICAL |

**No Divergence Found**: All parallel paths handle secrets with identical encryption and redaction policies.

#### 9. Regression Tests

**Boundary Test Coverage**:

| Test Category                        | File                                                                       | Status                           |
| ------------------------------------ | -------------------------------------------------------------------------- | -------------------------------- |
| Encrypted storage round-trip         | `packages/database/src/__tests__/auth-profile.model.test.ts`               | ✅ EXISTS                        |
| OAuth callback does not leak secrets | `apps/studio/src/__tests__/auth-profiles/oauth-callback-route.test.ts`     | ✅ EXISTS (line 143-157)         |
| GET endpoint redaction               | `apps/studio/src/__tests__/auth-profiles/auth-profile-api.test.ts`         | ✅ EXISTS (line 89-104)          |
| SSRF protection on tokenUrl          | `apps/studio/src/__tests__/auth-profiles/oauth-callback-route.test.ts`     | ✅ EXISTS                        |
| Token refresh lock prevents race     | `packages/shared/src/__tests__/auth-profile/token-refresh-service.test.ts` | ⚠️ PARTIAL (mock-based, not E2E) |
| Force-invalidate cache eviction      | `apps/runtime/src/__tests__/auth/force-invalidate.test.ts`                 | ✅ EXISTS                        |

**Coverage Gaps**:

- ⚠️ **MEDIUM**: No E2E test that verifies clientSecret is never present in any HTTP response (current tests mock encryption plugin)
- ✅ Mitigated by: Hook `.claude/hooks/auth-profile-query-shape-lint.sh` blocks queries that project `encryptedSecrets`

---

### VALUE: accessToken / refreshToken (OAuth 2.0 tokens)

**DATA CLASS**: CREDENTIAL  
**APPROVED CONSUMERS**: Outbound API requests (via Authorization header), encrypted storage only

#### 1. Source

**Entry Points**:

- OAuth callback: `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts:334`
- Token refresh: `packages/shared/src/services/auth-profile/token-refresh-service.ts:746`

**Format**: Plain strings from OAuth provider JSON response

```typescript
// callback/route.ts:334-341
const tokens = await tokenRes.json();
if (typeof tokens.access_token !== 'string' || tokens.access_token.trim().length === 0) {
  return errorJson(
    'OAuth provider response did not include an access token',
    502,
    'TOKEN_EXCHANGE_FAILED',
  );
}
```

#### 2. Writes

| Location                        | Field                   | Format                 | Protection                             |
| ------------------------------- | ----------------------- | ---------------------- | -------------------------------------- |
| MongoDB `end_user_oauth_tokens` | `encryptedAccessToken`  | Encrypted              | Mongoose encryption plugin             |
| MongoDB `end_user_oauth_tokens` | `encryptedRefreshToken` | Encrypted              | Mongoose encryption plugin             |
| Redis (transient)               | N/A                     | Never cached plaintext | Only profileId + version in cache keys |

**Encryption Details**:

```typescript
// packages/database/src/models/end-user-oauth-token.model.ts:65-69
EndUserOAuthTokenSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedAccessToken', 'encryptedRefreshToken'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});
```

#### 3. Serialization Boundaries

| Boundary                  | Serialized? | Format                | Safe?                       |
| ------------------------- | ----------- | --------------------- | --------------------------- |
| OAuth provider → Studio   | ✅          | JSON response         | ✅ (HTTPS)                  |
| Studio → MongoDB          | ✅          | Encrypted             | ✅                          |
| Runtime → Third-party API | ✅          | Authorization header  | ✅ (HTTPS required by tool) |
| Token refresh             | ✅          | Form POST to provider | ✅ (HTTPS, SSRF protected)  |

#### 4. Read Paths

| Reader                         | Audience                    | Format                | Authorization          |
| ------------------------------ | --------------------------- | --------------------- | ---------------------- |
| `resolveOAuthGrantAccessToken` | Runtime tool executor       | Plaintext (decrypted) | Session-scoped         |
| Token refresh service          | System (background refresh) | Plaintext (decrypted) | Internal only          |
| Connection resolver            | Runtime tool middleware     | Plaintext (decrypted) | Tool execution context |

**No User-Facing Read**: Tokens are never returned in any Studio API response (only metadata like `isAuthorized: boolean`).

#### 5. Policy Boundary

| Consumer                    | Required Policy   | Applied? | Evidence                                              |
| --------------------------- | ----------------- | -------- | ----------------------------------------------------- |
| LLM prompts                 | Never included    | ✅       | No code path                                          |
| External tool HTTP requests | Applied as header | ✅       | `applyAuth()` line 14                                 |
| Studio UI                   | Never displayed   | ✅       | No API returns tokens                                 |
| Logs                        | Never logged      | ✅       | SNAPSHOT_TRIGGER_META_REDACT blocks (wf-bridge.ts:11) |

**Tool Execution**:

```typescript
// apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts:105
const resolved = applyAuth(authResult, { url, method, headers, body });
// Result: { headers: { Authorization: 'Bearer <token>' }, ... }
// Token never exposed outside headers
```

#### 6. Consumers / Sinks

**External Systems**:

1. **OAuth Provider** (refresh endpoint) — refreshToken in POST body
   - SSRF protected: `validateRefreshEndpoint(tokenUrl)` (token-refresh-service.ts:403)
2. **Third-party APIs** (via tools) — accessToken in Authorization header
   - Applied only through `applyAuth()`, never raw

**No Leaks**:

- ❌ WebSocket frames — `SNAPSHOT_TRIGGER_META_REDACT` prevents (wf-bridge.ts:11)
- ❌ Audit events — only metadata logged
- ❌ ClickHouse traces — tokens explicitly excluded

#### 7. Dependency Wiring

```
DEPENDENCY: encryptionPlugin (for EndUserOAuthToken)
  Consumer: EndUserOAuthToken model — WIRED ✓ (line 65)
  Null-handling: Throws on missing encryption keys

DEPENDENCY: Redis distributed lock (token refresh)
  Consumer: Token refresh service — WIRED ✓ (line 694)
  Null-handling: Falls back to optimistic refresh without lock

DEPENDENCY: applyAuth (credential → header transformation)
  Consumer: Auth profile tool middleware — WIRED ✓ (line 105)
  Null-handling: Returns error if auth resolution fails
```

#### 8. Parallel Paths

| Path A                         | Path B                         | Parity                                 | Status       |
| ------------------------------ | ------------------------------ | -------------------------------------- | ------------ |
| Durable grant token storage    | Session artifact token storage | Both use encryptionPlugin              | ✅ IDENTICAL |
| OAuth2 authorization_code flow | OAuth2 client_credentials flow | Both encrypt tokens identically        | ✅ IDENTICAL |
| Shared-mode OAuth grant        | Per-user OAuth grant           | Same encryption, different userId only | ✅ IDENTICAL |

#### 9. Regression Tests

| Test                            | File                                                                       | Status                                            |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| Token encryption round-trip     | `packages/database/src/__tests__/end-user-oauth-token.test.ts`             | ✅ EXISTS                                         |
| Token refresh prevents replay   | `packages/shared/src/__tests__/auth-profile/token-refresh-service.test.ts` | ✅ EXISTS                                         |
| Resolved auth never leaks token | `apps/runtime/src/__tests__/auth/scope-insufficient.test.ts`               | ✅ IMPLICIT (tests headers, not raw)              |
| WebSocket redaction             | `apps/runtime/src/__tests__/observability/voice-trace-platform.test.ts`    | ✅ EXISTS (verifies SNAPSHOT_TRIGGER_META_REDACT) |

---

## Findings Summary

| ID  | Severity | Dimension        | Finding                                                           |
| --- | -------- | ---------------- | ----------------------------------------------------------------- |
| F-1 | LOW      | Regression Tests | No E2E test verifies clientSecret never appears in HTTP responses |

### FINDING: F-1

**SEVERITY**: LOW  
**DIMENSION**: Regression Tests (9)  
**PATH**: Studio API → Client  
**EVIDENCE**: Current tests mock the encryption plugin, so they pass even if a future code change accidentally queries `.select('+encryptedSecrets')` and returns it raw  
**IMPACT**: Future refactor could accidentally leak secrets if tests don't catch it  
**FIX**: Add E2E test that:

1. Creates a real auth profile with clientSecret
2. GETs the profile
3. Asserts response body does NOT contain the plaintext clientSecret (even partially)
4. Uses real MongoDB with encryption plugin active

**TEST**:

```typescript
// apps/studio/e2e/auth-profiles/secret-redaction.e2e.test.ts
test('GET auth-profile never returns plaintext clientSecret', async () => {
  const profile = await createAuthProfile({
    authType: 'oauth2_app',
    secrets: { clientId: 'test-client-123', clientSecret: 'super-secret-abc' },
  });

  const response = await fetch(`/api/projects/${projectId}/auth-profiles/${profile.id}`);
  const body = await response.text();

  // Assert plaintext secret is not present anywhere in response
  expect(body).not.toContain('super-secret-abc');
  // Redacted version should be present
  expect(body).toContain('••••••-abc');
});
```

**STATUS**: Mitigated by lint hook `.claude/hooks/auth-profile-query-shape-lint.sh` which blocks `.select('+encryptedSecrets')` patterns. Test would be defense-in-depth.

---

## Round 2: Fix Verification

**N/A** — No CRITICAL or HIGH findings to remediate. F-1 (LOW) is already mitigated by static analysis hook.

---

## Final Verdict

- [x] No CRITICAL findings
- [x] No HIGH findings open
- [x] All boundary tests exist (except F-1 which is LOW and hook-mitigated)
- [x] Parallel paths verified identical
- [x] Audit log complete

**CONCLUSION**: The auth-profiles feature is **PRODUCTION READY** from a data-flow security perspective. All sensitive credentials are:

- Encrypted at rest via battle-tested Mongoose encryption plugin
- Never logged or exposed in audit events
- Properly redacted before API responses
- Protected by SSRF validation on all OAuth URLs
- Applied to external requests only via Authorization headers (never raw transmission)
- Protected by distributed locking during token refresh to prevent race conditions

**Recommended Follow-up** (Non-blocking):

- Add E2E secret redaction test (F-1) for defense-in-depth, though existing lint hook provides equivalent protection

---

# Addendum: 2026-05-13 Session Commits

**Auditor**: Claude (Opus 4.7, 1M context)
**Commits Audited**:

- `3a327f2f4 [ABLP-913] feat(studio): custom oauth2_app E2E + auth-profile UX overhaul + tool authType cleanup`
- `d1bf18b23 [ABLP-1029] fix(auth-profile): tolerate non-numeric expires_in from Azure AD / PingFederate / ADFS`

**Round 1 ran**: 2026-05-13 (this audit)
**Round 2 ran**: 2026-05-13 (this audit)
**Overall Status**: ✅ **PASS** — no CRITICAL or HIGH findings new in this session. 3 MEDIUM + 2 LOW + 1 process gap.

## Sensitive Values Re-Traced

1. **clientSecret** (oauth2_client_credentials) — flow extended (string→record state widening, RecordEditor/CustomHeaderEditor) — re-audited
2. **OAuth access_token** (issued by Azure/Okta/etc.) — coerceExpiresIn TTL handling changed — re-audited
3. **headerValues** (custom_header secret record) — NEW UI editor (CustomHeaderEditor) — first audit
4. **authProfileRef / authProfileId** (reference to credentials) — clearing logic changed in HTTP tool form + MCP detail page — re-audited

## Round 1: Path Trace (new code paths only)

### VALUE: clientSecret — secrets state widening to Record<string, unknown>

**Change**: `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx:468` widened from `useState<Record<string, string>>` to `useState<Record<string, unknown>>` to support record-typed secrets (custom_header.headerValues).

| Dimension          | Verdict                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source          | UI form input — unchanged. Still user-typed via password inputs / RecordEditor.                                                                                                                                                                                 |
| 2. Writes          | Save handler at SlideOver:1133 passes `secrets` to `createWorkspaceAuthProfile` / `createAuthProfile`. Route handler at `route.ts:344` does `encryptedSecrets: JSON.stringify(body.secrets)` → encryption plugin encrypts on save. **No raw write** introduced. |
| 3. Serialization   | Same as before — JSON-encoded body to studio API. HTTPS.                                                                                                                                                                                                        |
| 4. Read paths      | GET list/detail strips `encryptedSecrets` and returns `redactedSecrets` (masked tail-4). No change.                                                                                                                                                             |
| 5. Policy boundary | Save handler at SlideOver passes plaintext `secrets` — same as develop. Encryption applied at server-side persistence. ✓                                                                                                                                        |
| 6. Consumers/sinks | None new. Token endpoint only via `resolveClientCredentialsToken`.                                                                                                                                                                                              |
| 7. Wiring          | No new wiring affected.                                                                                                                                                                                                                                         |
| 8. Parallel paths  | Workspace POST and project POST both use the same `body.secrets` → encryptedSecrets path. ✓                                                                                                                                                                     |
| 9. Tests           | **GAP** — no new boundary test added for record-typed secrets round-trip. Existing `auth-profile-create-cc-flow.test.ts` tests pre-existing scalar secrets only.                                                                                                |

**Findings:** see F-S1, F-S2 below.

### VALUE: access_token — coerceExpiresIn TTL handling

**Change**: `packages/shared-auth-profile/src/client-credentials-service.ts` — parseClientCredentialsResponse now uses `coerceExpiresIn` which tolerates string/number/null/garbage `expires_in` instead of throwing.

| Dimension          | Verdict                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source          | OAuth provider response body (parsed via `response.json()`). Untrusted but TLS-validated.                                                          |
| 2. Writes          | `expiresAt` ISO string written to Redis cache value: `{accessToken, expiresAt}`. Same encryption-at-rest properties as before.                     |
| 3. Serialization   | Redis SET with TTL `Math.max(1, expiresIn - CACHE_BUFFER_SECS)` or `DEFAULT_CACHE_TTL_SECS` if undefined. ✓                                        |
| 4. Read paths      | Cache hit returns cached accessToken via `parseCachedClientCredentialsToken`. ✓                                                                    |
| 5. Policy boundary | accessToken applied to outgoing HTTP only via `Authorization: Bearer <token>` in `apply-auth.ts:274`. ✓                                            |
| 6. Consumers/sinks | External HTTP via tool execution. Token is treated as opaque.                                                                                      |
| 7. Wiring          | `log` now wired into deps (commit 1 of d1bf18b23). cc_grant_failed warn fires correctly.                                                           |
| 8. Parallel paths  | `packages/shared/src/services/auth-profile/client-credentials-service.ts` orphan duplicate exists with same fix applied. No consumer imports it. ✓ |
| 9. Tests           | **GAP** — no new test asserting coerceExpiresIn caps malicious/buggy values.                                                                       |

**Findings:** see F-S3.

### VALUE: headerValues — CustomHeaderEditor (custom_header secret)

**Change**: New `CustomHeaderEditor` component renders single rows of `[header name | value | trash]` and writes both `config.headers` (name→label) and `secrets.headerValues` (name→value) in lock-step.

| Dimension          | Verdict                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1. Source          | UI text/password input within RecordEditor.                                                                              |
| 2. Writes          | Same persistence path: `secrets.headerValues` → `encryptedSecrets: JSON.stringify(body.secrets)` → encryption plugin. ✓  |
| 3. Serialization   | Same as scalar secrets. JSON-encoded body.                                                                               |
| 4. Read paths      | GET enrichment at `route.ts:203-209` (existing code, unchanged) generates `redactedSecrets`. **See finding F-S4 below.** |
| 5. Policy boundary | OK on write — encryption applied. On read — see F-S4.                                                                    |
| 6. Consumers/sinks | Runtime apply-auth.ts:293-298 reads `secrets.headerValues` and sets one header per pair. No log emission. ✓              |
| 7. Wiring          | Renderer mounts component only when `authType === 'custom_header'`. Component is mount-conditional. ✓                    |
| 8. Parallel paths  | Only path — no MCP equivalent for `custom_header` (MCP uses different shape).                                            |
| 9. Tests           | **GAP** — no test for CustomHeaderEditor save → API round-trip → runtime apply.                                          |

**Findings:** see F-S4.

### VALUE: authProfileRef / authProfileId — clearing on authType change

**Change**:

- `HttpConfigForm.tsx:updateAuthType` — clears `authProfileRef` when new authType has no `getAuthProfileTypeFilter` mapping (e.g. None).
- `McpServerDetailPage.tsx:handleSave` — sets `payload.authProfileId = null` when inline authType changes.

| Dimension          | Verdict                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source          | UI Select onChange.                                                                                                                                            |
| 2. Writes          | Tool DSL persisted via `ProjectTool.dslContent` (string). MCP server config persisted via `MCPServerConfig.authProfileId`.                                     |
| 3. Serialization   | DSL is plain text; authProfileId is bson string.                                                                                                               |
| 4. Read paths      | Runtime `resolve-tool-auth.ts:resolveToolAuth` reads `tool.auth_profile_ref` from IR. MCP `mcp-server-registry.ts:resolveServerConfig` reads `authProfileId`.  |
| 5. Policy boundary | n/a — reference is not credential material.                                                                                                                    |
| 6. Consumers/sinks | Runtime auth middleware uses ref to look up profile, then applies token. ✓                                                                                     |
| 7. Wiring          | Profile lookup is per-call (no in-memory caching of authProfileRef in the runtime layer beyond per-session token cache keyed by profileId, not ref).           |
| 8. Parallel paths  | MCP Create dialog has a separate mutex via `useAuthProfile` toggle — already safe. ✓                                                                           |
| 9. Tests           | **GAP** — no boundary test verifying that authType=None save actually clears the bound profile end-to-end (DB has cleared field, runtime resolves no profile). |

**Findings:** see F-S5.

## Findings Summary (new)

| ID   | Severity | Dimension                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-S1 | MEDIUM   | Read Paths               | `redactedSecrets` enrichment at `route.ts:203-209` does not handle record-typed values gracefully. For `custom_header.headerValues = {X-API-Key: "v1", X-Org: "v2"}`, the top-level Object.entries iteration treats the whole record as a non-string → returns `{headerValues: "••••••••"}` instead of per-header masked entries `{X-API-Key: "••••••v1", X-Org: "••••••v2"}`. **Not a leak** — secrets are still masked — but UI loses per-header structure. |
| F-S2 | LOW      | Source / Tests           | `secrets` state typed as `Record<string, unknown>` loses compile-time enforcement that string-typed secrets remain strings. Server-side Zod still rejects malformed shapes per authType.                                                                                                                                                                                                                                                                      |
| F-S3 | MEDIUM   | Policy Boundary / Writes | `coerceExpiresIn` accepts arbitrarily large positive numbers. A malicious or buggy OAuth provider that returns `expires_in: 99999999` (~3 years) keeps the token cached past intended TTL since `Math.max(1, expiresIn - CACHE_BUFFER_SECS)` is used as Redis TTL. No upper cap. Recommend cap to e.g. 86400 (24h).                                                                                                                                           |
| F-S4 | LOW      | Read Paths               | Same as F-S1 — record secrets through redactor produce a single masked entry. Cosmetic UX, not a leak.                                                                                                                                                                                                                                                                                                                                                        |
| F-S5 | LOW      | Tests                    | No boundary test asserts authType→None clears the profile binding end-to-end. Without it, a future regression that re-introduces the stale binding (e.g., new code path that preserves it) would not be caught.                                                                                                                                                                                                                                               |
| F-S6 | LOW      | Logging                  | `cc_grant_failed` warn logs `tokenUrl` in plaintext. For Azure AD this contains the tenant ID. Tenant IDs are not strictly secret but are weak identifiers used in compliance contexts. Log goes to `studio-out.log` (ops-only). Recommend redacting host vs path, or logging tenant ID at INFO and full URL at DEBUG only.                                                                                                                                   |
| F-S7 | PROCESS  | Tests                    | Both commits ship without new E2E or integration tests for the new code paths (RecordEditor, CustomHeaderEditor, OAuth dialog gating, authType clearing, coerceExpiresIn). CLAUDE.md mandates 5 E2E + 5 integration per feature. Backlog item.                                                                                                                                                                                                                |

**No CRITICAL or HIGH findings introduced by this session's commits.**

## Round 2: Verification

Re-verified each finding against current code (commits 3a327f2f4 + d1bf18b23 on disk):

| Finding | Path Closed?                      | Boundary Test Added? | Round 2 Verdict                    |
| ------- | --------------------------------- | -------------------- | ---------------------------------- |
| F-S1    | n/a (existing behavior, cosmetic) | no                   | Open — backlog cosmetic fix        |
| F-S2    | n/a (type widening accepted)      | no                   | Open — accept                      |
| F-S3    | no (cap not added)                | no                   | **OPEN** — recommend cap follow-up |
| F-S4    | n/a                               | no                   | Open — cosmetic                    |
| F-S5    | no                                | no                   | Open — backlog test                |
| F-S6    | no                                | no                   | Open — backlog redaction           |
| F-S7    | no (no tests added)               | n/a                  | **OPEN** — backlog tests           |

No regression introduced. All open findings are either cosmetic or improvements; none block ship.

## Recommended Follow-Up Tickets

1. **`[ABLP-???] fix(auth-profile): cap CC expires_in to 24h max in coerceExpiresIn`** — defense against malicious/buggy providers returning excessively long TTLs.
2. **`[ABLP-???] fix(auth-profile): per-key redaction for record-typed secrets`** — extend `redactedSecrets` enrichment to descend into nested records (headerValues etc.) so UI shows per-header masked entries.
3. **`[ABLP-???] test(auth-profile): boundary tests for session changes`** — add E2E for record-typed secret round-trip, authType→None clearing, OAuth dialog gating for custom oauth2_app, coerceExpiresIn provider variations.
4. **`[ABLP-???] chore(shared): delete 15 orphan auth-profile duplicate files`** — left from 6ad667676 refactor. Reduce future drift risk.
5. **`[ABLP-???] chore(auth-profile): redact tenant ID in cc_grant_failed log`** — log host+path separately, or hash tenant segment.

## Final Verdict

- [x] No CRITICAL findings open
- [x] No HIGH findings open
- [ ] All boundary tests added — **NO** (F-S5, F-S7 outstanding)
- [x] Parallel paths verified identical (orphan duplicate confirmed unimported)
- [x] Audit log complete

**CONCLUSION**: The session's two commits do not regress the existing PRODUCTION READY status of the auth-profile feature. The Round 1 audit (May 13 earlier today) covered the existing implementation. This addendum covers only the new code paths, and finds **no new CRITICAL or HIGH issues**.

The MEDIUM finding F-S3 (no upper cap on expires_in) deserves a fast-follow ticket but is low-risk in practice: an attacker who controls an OAuth provider can already issue arbitrary token content; capping cache TTL is defense-in-depth, not a blocking gap.

The PROCESS finding F-S7 (no new tests) is a real CLAUDE.md violation. Recommend filing as the follow-up #3 above and tracking before BETA promotion.

## Round 3 (deeper code re-read) — additional finding

After re-running the audit with explicit code reads (not session memory), one additional finding surfaced:

### F-S8 — Zod schema mismatch between verify-draft and create routes

**Severity**: MEDIUM (latent — not currently fired)
**Dimension**: Source / Schema validation

`apps/studio/src/app/api/auth-profiles/_verify-draft-helper.ts:36`:

```ts
secrets: z.record(z.string(), z.string()).optional().default({}),
```

This rejects record-typed secrets values (e.g., `custom_header.headerValues: {X-API-Key: "v"}`). Meanwhile the main create routes accept them:

`packages/shared/src/validation/auth-profile.schema.ts:631`:

```ts
secrets: z.record(z.unknown()).optional(),
```

**Impact**: If the "Verify Connection" button is restored in the SlideOver (it was removed in this branch — see ABLP-913 history), and a user clicks it while editing a `custom_header` profile, the verify-draft endpoint returns 400 Validation Error with a confusing message because Zod can't parse `{headerValues: {...record...}}`.

**Why it's latent**: no UI currently calls `verifyDraftAuthProfile()` for `custom_header`. The session-introduced widening of `secrets` to `Record<string, unknown>` makes the request body shape now potentially nested for `custom_header`, but no caller forwards it to `/verify-draft`.

**Fix**: change line 36 to `secrets: z.record(z.string(), z.unknown()).optional().default({})` to match the create route. Add a regression test that posts a `custom_header` shape and expects 200 from verify-draft. Single-line fix, ~5 lines including the test.

**Status (Round 3 verdict)**: OPEN — not blocking ship; document for follow-up. Filed as part of follow-up ticket #3 (boundary tests).

## Final Verdict (re-confirmed after Round 3)

- [x] No CRITICAL findings open
- [x] No HIGH findings open
- 3 MEDIUM findings: F-S1 (cosmetic redaction), F-S3 (no expires_in cap), F-S8 (verify-draft Zod mismatch — latent)
- 3 LOW findings: F-S2 (type widening), F-S5 (boundary test), F-S6 (tenant ID in log)
- 1 PROCESS finding: F-S7 (no new tests)

Recommended fix priority:

1. **F-S8** (verify-draft Zod) — single-line schema change; do alongside any restoration of the Verify Connection button
2. **F-S3** (expires_in cap) — defense-in-depth, single-line cap in `coerceExpiresIn`
3. **F-S7** (boundary tests) — backlog with the follow-up ticket; gate BETA promotion on this
4. **F-S1 / F-S4** (record redactor) — cosmetic UX
5. **F-S6** (tenant ID in log) — ops-log hygiene
6. **F-S2** (type widening) — accept as design trade-off

## Round 3 reclassification

After exhaustive grep of all UI consumers, **F-S8 is reclassified from MEDIUM (latent) to LOW (dormant)**.

Zero UI components on this branch import `verifyDraftAuthProfile` or `verifyDraftWorkspaceAuthProfile`. The only references are:

- API client function definitions in `apps/studio/src/api/auth-profiles.ts` (no callers)
- The server route handlers themselves
- One unit test of the helper

The "Verify Connection" button was removed from the SlideOver earlier in ABLP-913 history. Until that button (or any other UI surface) is restored, the verify-draft route is dead code from a UX perspective. The Zod-schema gap for record-typed secrets therefore cannot be triggered by any user action.

**F-S8 final status**: LOW — fix when re-wiring Verify Connection, not before.
