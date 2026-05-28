# Auth Profile — Phase 2: Credential Consolidation (4-6 Sprints)

> **Master design doc:** [`2026-03-11-auth-profile-design.md`](./2026-03-11-auth-profile-design.md)
> **Phase 1 (Connector OAuth):** [`2026-03-11-auth-profile-phase1-core.md`](./2026-03-11-auth-profile-phase1-core.md)
> **Phase 3 (Enterprise & Cleanup):** [`2026-03-11-auth-profile-phase3-enterprise.md`](./2026-03-11-auth-profile-phase3-enterprise.md)

---

## Prerequisites

- Phase 1 stable in production with canary tenant validation
- `AuthProfile` model, `AuthProfileService`, project-scoped CRUD, OAuth flow, and connector dual-read all deployed and passing health checks
- No open `AUTH_PROFILE_DECRYPTION_FAILED` alerts

---

## Goal

Migrate **all** existing credential models to Auth Profile. After Phase 2, every credential in the platform reads from `AuthProfile` (with dual-read fallback to legacy models). This phase does NOT delete old models or fields --- that is Phase 3 cleanup.

---

## 1. Auth Types Added in Phase 2

Phase 2 adds 6 auth types, completing the 12 core types:

| `authType`      | `config` (non-sensitive)                                                          | `encryptedSecrets` (sensitive)                    | Library                 |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------- |
| `basic`         | ---                                                                               | `username`, `password`                            | ---                     |
| `custom_header` | `headers: Record<string, string>` (header names)                                  | `headerValues: Record<string, string>`            | ---                     |
| `aws_iam`       | `region`, `service`, `roleArn?`, `externalId?`                                    | `accessKeyId`, `secretAccessKey`, `sessionToken?` | `@aws-sdk/signature-v4` |
| `azure_ad`      | `tenantId`, `resource`, `endpoint?` (default `https://login.microsoftonline.com`) | `clientId`, `clientSecret`                        | `@azure/identity`       |
| `mtls`          | ---                                                                               | `clientCert`, `clientKey`, `caCert?`              | ---                     |
| `ssh_key`       | `keyType?: 'ed25519' \| 'rsa'` (default `'rsa'`)                                  | `privateKey`, `passphrase?`                       | ---                     |

### Validation Rules for New Types

| authType        | Required config                                                                           | Required secrets                                             |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `basic`         | ---                                                                                       | `username`, `password`                                       |
| `custom_header` | at least one header name                                                                  | matching header values (keys must match config.headers keys) |
| `aws_iam`       | `region`                                                                                  | `accessKeyId`, `secretAccessKey`                             |
| `azure_ad`      | `tenantId`, `resource`. `endpoint` optional (default `https://login.microsoftonline.com`) | `clientId`, `clientSecret`                                   |
| `ssh_key`       | `keyType` optional (default `'rsa'`)                                                      | `privateKey`                                                 |
| `mtls`          | ---                                                                                       | `clientCert`, `clientKey`                                    |

### Libraries Added

| Library                 | Version | Purpose                                   | Loading Strategy                                                               |
| ----------------------- | ------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| `@aws-sdk/signature-v4` | latest  | AWS SigV4 request signing                 | Direct import. **Must be explicitly added** --- not currently in the monorepo. |
| `@azure/identity`       | latest  | Azure AD authentication                   | Lazy `import()`                                                                |
| `ssh2`                  | latest  | SSH key authentication for Git operations | Lazy `import()` --- only loaded when `ssh_key` auth type is used               |

---

## 2. Addons Activated in Phase 2

Phase 2 activates the 3 core addon mechanisms. Remove the Phase 1 rejection guard that returns 400 on addon fields.

### 2.1 Request Signing (HMAC)

```typescript
signing?: {
  algorithm: 'hmac-sha256' | 'hmac-sha512' | 'aws-sig-v4' | 'rsa-sha256';
  signedComponents: ('body' | 'timestamp' | 'url' | 'headers')[];
  timestampHeader?: string;          // e.g. "X-Timestamp"
  signatureHeader?: string;          // e.g. "X-Signature"
  // signingSecret in encryptedSecrets
};
```

**Addon evaluation order:** Signing MUST be applied BEFORE the proxy addon rewrites the request target.

### 2.2 Webhook Verification (inbound only)

```typescript
webhookVerification?: {
  method: 'hmac-sha256' | 'hmac-sha1' | 'svix' | 'rsa-sha256';
  signatureHeader: string;           // "X-Hub-Signature-256"
  timestampHeader?: string;
  toleranceSeconds?: number;         // replay protection window
  // webhookSecret in encryptedSecrets
};
```

### 2.3 Proxy

```typescript
proxy?: {
  url: string;                       // SSRF-validated
  proxyAuthProfileId?: string;       // auth for the proxy itself
};
```

**Proxy validation rules:**

- `proxyAuthProfileId` MUST NOT equal `this._id` (self-reference)
- Max proxy chain depth = 1 (no nested proxies)
- Valid proxy auth types: `basic`, `bearer`, `api_key`, `mtls` only
- Same `tenantId` validation
- **Visibility check:** A shared profile MUST NOT reference a personal profile as its proxy

### Addon Encrypted Secrets

Addon secrets stored alongside base-type secrets in `encryptedSecrets`:

```typescript
{
  // Base-type secrets (varies by authType)
  apiKey?: string;
  // ... other base-type secrets

  // Addon secrets (present only when addon is configured)
  signingSecret?: string;           // for signing addon
  webhookSecret?: string;           // for webhookVerification addon
}
```

Zod validation: if `signing` addon present -> `signingSecret` required. If `webhookVerification` present -> `webhookSecret` required.

### Invalid Combination Matrix

These combinations MUST be rejected at profile creation/update time:

| Combination                       | Reason                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `aws_iam` + `signing`             | AWS SigV4 is itself a signing mechanism; double-signing corrupts the request    |
| `ssh_key` + `signing` / `proxy`   | SSH key is not used in HTTP requests                                            |
| `webhookVerification` + `signing` | Opposite directions (inbound verify vs outbound sign) --- use separate profiles |
| `mtls` + `proxy`                  | mTLS is typically terminated at the proxy, not forwarded through                |

---

## 3. Consumer Migration Table

All consumers NOT covered in Phase 1, migrated to `authProfileId` with dual-read.

| Consumer                                  | Auth Profile Types Expected                                                    | Reference Field                                     | Current Credential Source                                |
| ----------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------- |
| LLM Provider Connection                   | `api_key`, `azure_ad`, `aws_iam`, `oauth2_client_credentials`, `custom_header` | `TenantModel.connections[].authProfileId`           | `TenantModel.connections[].credentialId` (LLMCredential) |
| MCP Server                                | `api_key`, `bearer`, `custom_header`, `oauth2_client_credentials`, `none`      | `MCPServerConfig.authProfileId`                     | `MCPServerConfig.encryptedAuthConfig`                    |
| HTTP Tool (DSL-defined)                   | `api_key`, `bearer`, `basic`, `oauth2_client_credentials`, `custom_header`     | Resolved via `auth: "profile-name"` in DSL          | `{{secrets.KEY}}` via ToolSecret                         |
| Channel Connection                        | `oauth2_token`, `api_key`, `custom_header`                                     | `ChannelConnection.authProfileId`                   | `ChannelConnection.encryptedCredentials`                 |
| Git Integration                           | `oauth2_token`, `bearer`, `ssh_key`                                            | `GitIntegration.authProfileId`                      | `GitIntegration.credentials.secretId`                    |
| Service Node                              | `api_key`, `bearer`, `basic`, `oauth2_client_credentials`, `custom_header`     | `ServiceNode.authProfileId`                         | `ServiceNode.encryptedSecrets`                           |
| Guardrail Provider                        | `api_key`, `bearer`                                                            | `TenantGuardrailProviderConfig.authProfileId`       | `TenantGuardrailProviderConfig.apiKeyCredentialId`       |
| Org Proxy                                 | `basic`, `bearer`, `mtls`                                                      | `OrgProxyConfig.authProfileId`                      | `OrgProxyConfig` (6 encrypted fields)                    |
| Voice Service Instance                    | `api_key`                                                                      | `TenantServiceInstance.authProfileId`               | `TenantServiceInstance.encryptedApiKey`                  |
| Arch Workspace Config                     | `api_key`, `azure_ad`, `aws_iam`                                               | `ArchWorkspaceConfig.authProfileId`                 | `ArchWorkspaceConfig.encryptedApiKey`                    |
| Webhook Subscription                      | --- (uses `webhookVerification` addon)                                         | `WebhookSubscription.authProfileId`                 | `WebhookSubscription.encryptedSecret`                    |
| Webhook Subscription Connector (MS Graph) | --- (uses `webhookVerification` addon)                                         | `WebhookSubscriptionConnector.authProfileId`        | `WebhookSubscriptionConnector.encryptedClientState`      |
| SDK Channel (HMAC identity verification)  | --- (uses `webhookVerification` addon)                                         | `SDKChannel.authProfileId`                          | `SDKChannel.secretKey`                                   |
| ModelConfig                               | `api_key`, `azure_ad`, `aws_iam`                                               | `ModelConfig.authProfileId`                         | `ModelConfig.credentialId`                               |
| GuardrailPolicy provider overrides        | `api_key`, `bearer`                                                            | `GuardrailPolicy.providerOverrides[].authProfileId` | `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` |
| Trigger Registration                      | `api_key`, `bearer`, `oauth2_token`                                            | `TriggerRegistration.authProfileId`                 | Inline credentials                                       |
| TokenManager (connectors/base)            | `oauth2_token`                                                                 | Via `ConnectorConnection.authProfileId`             | `TokenManager` direct DB queries                         |

---

## 4. Model Deletion Targets (Prepared, Not Executed)

Phase 2 prepares these models for deletion. **Actual deletion happens in Phase 3** after the go/no-go gate.

| Model               | Replaced By                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `LLMCredential`     | `AuthProfile` with `authType: api_key \| azure_ad \| aws_iam`                 |
| `EndUserOAuthToken` | `AuthProfile` with `visibility: personal`, `authType: oauth2_token`           |
| `ToolSecret`        | `AuthProfile` (DSL changes from `{{secrets.KEY}}` to `auth: my-profile-name`) |

---

## 5. Dual-Read Patterns

### Generic Dual-Read Template

```typescript
async function resolveCredential(
  entity: { authProfileId?: string; credentialId?: string },
  tenantId: string,
) {
  if (entity.authProfileId) {
    return await authProfileService.resolve({ authProfileId: entity.authProfileId, tenantId });
  }
  if (entity.credentialId) {
    return await legacyCredentialService.resolve({ credentialId: entity.credentialId, tenantId });
  }
  throw new AuthProfileError('NO_CREDENTIAL', 'No credential configured');
}
```

### High-Risk Integration Points --- Specific Patterns

#### `connection-resolver.ts`

Currently resolves `ConnectorConnection.encryptedCredentials` directly. Dual-read:

```typescript
// In connection-resolver.ts
if (connection.authProfileId) {
  const creds = await authProfileService.resolve({
    authProfileId: connection.authProfileId,
    tenantId,
  });
  return mapToConnectionFormat(creds);
}
// Legacy fallback
return decryptInlineCredentials(connection.encryptedCredentials);
```

#### `tool-oauth-service.ts`

Currently manages `EndUserOAuthToken` directly. Phase 2 replaces with `AuthProfileService` token refresh (which has distributed lock --- fixing the existing race condition).

```typescript
// Replace direct EndUserOAuthToken queries with:
const tokenProfile = await authProfileService.resolve({
  tenantId,
  projectId,
  connector,
  connectionMode: 'per_user',
  userId,
});
// Token refresh now uses distributed lock (Phase 1 infrastructure)
```

#### `service-node-executor.ts`

Currently reads `ServiceNode.encryptedSecrets` and `ServiceNode.authConfig`. Dual-read:

```typescript
if (serviceNode.authProfileId) {
  const creds = await authProfileService.resolve({
    authProfileId: serviceNode.authProfileId,
    tenantId,
  });
  return applyAuthToRequest(request, creds);
}
// Legacy fallback
return applyLegacyAuth(request, serviceNode);
```

#### `llm-config/resolver.ts` and `model-resolution.ts`

Both resolve `LLMCredential` for LLM API calls. Dual-read:

```typescript
// In model-resolution.ts
if (modelConfig.authProfileId) {
  return await authProfileService.resolve({
    authProfileId: modelConfig.authProfileId,
    tenantId,
  });
}
// Legacy: resolve via LLMCredential
return await llmCredentialService.resolve(modelConfig.credentialId, tenantId);
```

#### `TokenManager` (connectors/base)

The `TokenManager` class manages OAuth tokens for connectors. Phase 2 updates it to prefer `AuthProfileService`:

```typescript
// In TokenManager
async getAccessToken(connectionId: string): Promise<string> {
  const connection = await ConnectorConnection.findOne({ _id: connectionId, tenantId });
  if (connection.authProfileId) {
    const creds = await authProfileService.resolve({
      authProfileId: connection.authProfileId,
      tenantId,
    });
    return creds.accessToken;
  }
  // Legacy path
  return this.legacyGetAccessToken(connectionId);
}
```

---

## 6. Worker Migration

### Worker Groups

~10-12 workers with direct credential access need dual-read updates, plus shared resolver updates that cascade to additional workers.

**Group 1 --- Search-AI Workers (shared resolver path):**
All 9 search-ai workers resolve credentials through `llm-config/resolver.ts`. Updating the resolver cascades to all of them:

- connector-sync-worker
- connector-discovery-worker
- connector-permission-crawl-worker
- embedding-worker
- kg-enrichment-worker
- enrichment-worker
- vocabulary-generation-worker
- webhook-renewal scheduler
- preprocessing-worker

**Group 2 --- IDP Sync Workers (direct credential access):**
6 workers that query `LLMCredential` directly:

- `idp-sync-scheduler.ts` (the coordinator)
- Azure AD, Okta, OneLogin, PingIdentity, Generic SCIM sync workers

**Group 3 --- Runtime Workers:**

- delivery-worker
- inbound-worker

**Group 4 --- Standalone:**

- embedding-worker singleton

### Shared Resolver Update

Update `llm-config/resolver.ts` to use dual-read. This single change propagates to all Group 1 workers.

### Worker Testing Strategy

For each worker group:

1. Unit tests for dual-read path (new credential resolution)
2. Integration test with canary tenant
3. Smoke test after each worker group deployment

---

## 7. Special Cases

### `idp-sync-scheduler.ts` Fix

The `idp-sync-scheduler.ts` does `LLMCredential.find()` with no filter and uses `(cred as any).metadata` type casts. Migration requires:

1. **Manual audit** of production `LLMCredential` documents to identify IDP-related records
2. Detection queries: `LLMCredential.find({ 'metadata.azureadUserSyncDeltaToken': { $exists: true } })` plus variants for Okta, OneLogin, etc.
3. Migrate matched records to `AuthProfile` with appropriate `authType`
4. Update scheduler to query `AuthProfile` with dual-read fallback

> **Warning:** Metadata field naming conventions may vary between operators. Manual production audit is required before scripting this migration.

### `embedding-worker` Singleton

The embedding worker maintains a singleton instance. Add Auth Profile resolution path:

```typescript
if (config.authProfileId) {
  const creds = await authProfileService.resolve({ authProfileId: config.authProfileId, tenantId });
  return createEmbeddingClient(creds);
}
// Legacy singleton path
```

### `CredentialAgeMonitor` Update

Currently hardcodes queries against `ToolSecret`, `LLMCredential`, and `ApiKey`. After migration, these collections will be empty. Update to query `AuthProfile` using `rotationStartedAt` / `lastValidatedAt` / `createdAt` fields.

### `VoiceServiceFactory` Cache Invalidation

Currently caches decrypted Deepgram/ElevenLabs/Twilio service instances per-tenant with 10-minute TTL. Wire Auth Profile rotation events (via Redis pub/sub) to call `VoiceServiceFactory.invalidate(tenantId)`.

### `OrgProxyConfig` Multi-Credential Merge Strategy

One `OrgProxyConfig` can have multiple auth types populated simultaneously. Strategy:

1. Create multiple Auth Profiles (one per auth type), linked via a `groupId` field
2. `OrgProxyConfig.authProfileId` references the primary auth profile
3. Additional profiles in the group resolved via `groupId` at runtime

---

## 8. `EncryptionService` Multi-Key Prerequisite

**MUST be completed before rotation features can be used in production.**

The current `EncryptionService` supports only a single master key. Extend to support multiple key versions:

```typescript
interface EncryptionServiceConfig {
  current: { version: number; key: string };
  previous?: { version: number; key: string }[];
}
```

This enables:

- Decrypt with older key version while encrypting with current
- `rotationGracePeriodMs` and `previousEncryptedSecrets` to function
- Phase 3 re-encryption batch job

Until this ships, the runtime check added in Phase 1 (reject `rotationPolicy` with error) remains active.

---

## 9. Pre-Flight Auth Propagation

### Compiler Changes

The compiler propagates `per_user` auth requirements up the agent -> workflow -> tool dependency tree:

```typescript
authRequirements: [
  {
    connector: 'gmail',
    authType: 'oauth2_token',
    connectionMode: 'per_user',
    consent: 'preflight',
    scopes: ['gmail.send', 'gmail.compose'],
    authProfileId: 'ap-google-1', // resolved at compile time
    authProfileName: 'gmail-app', // for audit trail
  },
];
```

### Propagation Rules

| Rule                              | Behavior                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| `per_user` + `consent: preflight` | Bubbles up to entry point, blocks session start                       |
| `per_user` + `consent: inline`    | Bubbles up as optional, inline consent at runtime                     |
| `shared`                          | No pre-flight, developer's token used, does not bubble                |
| Nested calls                      | Compiler walks full dependency tree, deduplicates by connector+scopes |
| Duplicate connectors              | Union of scopes                                                       |

### Runtime Integration

`RuntimeSecretsProvider` integration via `LLMWiringService._wireExecutor()`:

```typescript
// In RuntimeSecretsProvider.getSecret()
// Step 1: Check session-level cache (max 200 entries, LRU eviction, per-session)
// Step 2: authProfileService.resolve() with 5-level $or query
// Step 3: Cache result for session duration
```

---

## 10. Tenant-Scoped API

Phase 2 adds tenant-level routes (workspace admin only):

```
GET    /api/auth-profiles                              # list tenant-level profiles
POST   /api/auth-profiles                              # create tenant-level profile
GET    /api/auth-profiles/:id                          # get (redacted secrets)
PUT    /api/auth-profiles/:id                          # update
DELETE /api/auth-profiles/:id                          # delete
POST   /api/auth-profiles/:id/validate                 # test credentials
```

All routes use `withRouteHandler` for auth enforcement. Requires admin role + `AUTH_PROFILE_*` permissions.

---

## 11. Migration Script

### Ordering

1. **LLMCredential -> AuthProfile** (highest volume, most consumers)
2. **ToolSecret -> AuthProfile** (DSL reference updates)
3. **EndUserOAuthToken -> AuthProfile** (requires lock sequencing)

### EndUserOAuthToken Lock Sequencing

The migration script must handle the token refresh race:

1. Lock by legacy token's `_id`: `auth-profile:migrate:{legacyTokenId}`
2. Create the Auth Profile with migrated data
3. Immediately re-lock on new Auth Profile ID: `auth-profile:refresh:{tenantId}:{profileId}`
4. Release legacy lock

> The lock key format in the master design doc references `profileId` before the profile exists. This two-step handoff is the correct approach.

### Rollback Procedures

Each migration step is independently rollable:

- **LLMCredential:** Delete created Auth Profiles with `category: 'llm'`, consumers fall back to `credentialId`
- **ToolSecret:** Delete created Auth Profiles with `category: 'tool'`, DSL fallback to `{{secrets.KEY}}`
- **EndUserOAuthToken:** Delete created Auth Profiles with `visibility: 'personal', authType: 'oauth2_token'`

### Name Collision Prevention

- Generate name from credential type + provider: "OpenAI API Key", "Google OAuth App"
- If collision, append suffix: "OpenAI API Key (2)"
- Create unique indexes AFTER data migration with `{ background: true }`

---

## 12. Feature Flag

```typescript
const AUTH_PROFILE_ENABLED = process.env.AUTH_PROFILE_ENABLED === 'true';
```

All dual-read paths gate on this flag. When `AUTH_PROFILE_ENABLED` is `false`, all consumers use legacy credential resolution exclusively (no Auth Profile queries even if `authProfileId` is populated).

### Dual-Read Deletion Guard

Auth Profile deletion is blocked while dual-read is active for any consumer referencing it. This is operationally fragile (see feasibility review) --- implement via a `migrationStatus` field on Auth Profile:

- `'active'` --- normal operation
- `'migrating'` --- created by migration script, deletion blocked
- `'migrated'` --- all consumers confirmed reading via `authProfileId`

---

## 13. Go/No-Go Criteria for Phase 3

Before Phase 3 can begin:

- [ ] All 10-12 workers confirmed reading `authProfileId` (not `credentialId`) in production metrics for 30+ days
- [ ] Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors for preceding 14 days
- [ ] `EncryptionService` multi-key support deployed and tested
- [ ] All consumers listed in Section 3 have `authProfileId` populated in production
- [ ] Dual-read fallback path exercised < 1% of total credential resolutions
- [ ] Full MongoDB snapshot taken with retention policy documented
- [ ] Canary tenant fully migrated and stable for 14+ days

---

## 14. Dependencies on Other Phases

### Depends on Phase 1

- `AuthProfile` model and `AuthProfileService` must be deployed and stable
- Project-scoped CRUD API operational
- OAuth flow (initiate/callback) working
- `ConnectorConfig` and `ConnectorConnection` dual-read validated
- GDPR cascade in place
- Health check and alerting operational

### Phase 3 Depends on Phase 2

- All consumers migrated with dual-read
- All workers updated
- Migration scripts executed successfully
- Go/no-go criteria met

---

## 15. Deliverables Checklist

1. [ ] 6 additional auth types implemented with Zod validation
2. [ ] 3 core addons activated with invalid combination enforcement
3. [ ] `@aws-sdk/signature-v4`, `@azure/identity`, `ssh2` libraries added
4. [ ] `LLMCredential` migration script + consumer dual-read (`TenantModel.connections[]`, `ModelConfig`)
5. [ ] `ToolSecret` migration script + `RuntimeSecretsProvider` dual-read
6. [ ] `EndUserOAuthToken` migration script with lock sequencing
7. [ ] All 13 consumer models updated with `authProfileId` field + dual-read
8. [ ] Worker Group 1 (search-ai): `llm-config/resolver.ts` dual-read
9. [ ] Worker Group 2 (IDP sync): `idp-sync-scheduler.ts` + 5 sync workers
10. [ ] Worker Group 3 (runtime): delivery-worker, inbound-worker
11. [ ] `embedding-worker` singleton updated
12. [ ] `connection-resolver.ts` dual-read
13. [ ] `tool-oauth-service.ts` replaced with `AuthProfileService` token refresh
14. [ ] `service-node-executor.ts` dual-read
15. [ ] `TokenManager` (connectors/base) dual-read
16. [ ] `EncryptionService` multi-key support
17. [ ] Pre-flight auth propagation (compiler + runtime)
18. [ ] Tenant-scoped CRUD API (`/api/auth-profiles/*`)
19. [ ] `CredentialAgeMonitor` updated to query `AuthProfile`
20. [ ] `VoiceServiceFactory` cache invalidation wired to Auth Profile rotation
21. [ ] `ModelConfig.credentialId` -> `authProfileId` migration
22. [ ] `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` -> `authProfileId` migration
23. [ ] `OrgProxyConfig` multi-credential merge strategy implemented
24. [ ] Migration scripts with rollback procedures tested
25. [ ] Full test suite for all new dual-read paths
