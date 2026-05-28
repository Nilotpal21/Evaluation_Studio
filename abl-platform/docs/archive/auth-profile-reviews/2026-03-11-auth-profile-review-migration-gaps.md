# Auth Profile Design — Migration Strategy Gap Review

> Reviewed: `docs/plans/2026-03-11-auth-profile-design.md` (Section 14: Migration Strategy)
> Date: 2026-03-11
> Reviewer: Claude (automated codebase audit)
> Scope: Consumer completeness, migration ordering, dual-read coverage, BullMQ worker migration

---

## 1. Consumer Completeness — Models With Credential Fields NOT Listed in Design

The design's "Models Simplified (14)" table accounts for most consumers. The following credential-bearing
models found in `packages/database/src/models/` are **not listed** or have gaps:

### 1.1 `GitIntegration.webhookSecret` — Missing from Migration Table

**Location:** `packages/database/src/models/git-integration.model.ts:39`

```ts
webhookSecret: { type: String, default: null }, // plain text, NO encryption plugin
```

The design's simplified-models table says `GitIntegration` drops `credentials.secretId` and
`webhookSecret` and keeps `authProfileId`. However, the current model stores `webhookSecret` as
**plain text** (no `encryptionPlugin` applied). The migration plan must address how a plaintext
field is migrated to an Auth Profile with the `webhookVerification` addon — the existing `webhookSecret`
cannot be encrypted-at-rest-migrated in the same pattern as the other `encrypted*` fields.

Additionally, `GitIntegration.credentials.secretId` is an opaque string pointer to a secret store
(not a direct encrypted field), meaning there is a missing description of which secret store
`secretId` points to and how to resolve it for migration.

### 1.2 `GuardrailPolicy.settings.webhookSecret` — Unlisted, Plain Text

**Location:** `packages/database/src/models/guardrail-policy.model.ts:67`

```ts
export interface IGuardrailSettings {
  webhookSecret?: string; // plain text, NO encryption plugin
}
```

`GuardrailPolicy` embeds a `webhookSecret` in its `settings` subdocument. This is used for inbound
webhook verification for guardrail event callbacks. The design lists `TenantGuardrailProviderConfig`
as a consumer (drops `apiKeyCredentialId`, keeps `authProfileId`) but does not address
`GuardrailPolicy.settings.webhookSecret`. This field needs the `webhookVerification` addon pattern
in Auth Profile and should be encrypted at rest (it is currently not).

### 1.3 `EnvironmentVariable` — Scope Ambiguity Creates a Migration Hole

**Location:** `packages/database/src/models/environment-variable.model.ts:25`

```ts
encryptedValue: string; // AES-256-GCM via encryptionPlugin
isSecret: boolean; // marks credential-valued env vars
```

The design says:

> `EnvironmentVariable` — deployment config, not auth (secret env vars storing credentials should
> migrate)

This is contradictory in one sentence. `EnvironmentVariable` records with `isSecret: true` that store
API keys or tokens ARE credential-bearing and the design acknowledges they "should migrate" but
provides no migration path for them. Specifically:

- There is no mechanism described for detecting which env vars are credentials vs. deployment config.
- The dual-read pattern does not apply to `{{env.KEY}}` DSL references — old agents using env vars
  remain on the legacy path indefinitely with no cleanup gate.
- The design's "Obsolete After Migration (Phase 4)" section lists `ANTHROPIC_API_KEY` and similar env
  vars as obsolete but makes no mention of `EnvironmentVariable` DB records that replicate them.

The migration must either (a) explicitly exclude ALL `EnvironmentVariable` records and accept the
ongoing split-brain risk, or (b) define a migration path for `isSecret: true` records.

### 1.4 `Organization.ssoConfigs[].encryptedConfig` — Noted as Future, but Silently Encrypts IdP Secrets

**Location:** `packages/database/src/models/organization.model.ts:19`

```ts
encryptedConfig: { type: String, required: true }, // encrypted SAML/OIDC IdP config
```

The design explicitly defers this to a future phase, which is acceptable. However, the `encryptionPlugin`
is applied to `Organization` with `fieldsToEncrypt: ['encryptedConfig']`. The migration must
explicitly state that, during Phase 1–3, `SSOConfig` remains on the legacy encryption path and that
the `EncryptionService` key rotation prerequisite (Section 16) does not break this path.

### 1.5 `TenantModel.connections[].credentialId` — Actual Mongoose Model Diverges From Prisma Schema

**Location:** `packages/database/src/models/tenant-model.model.ts:19,77`

The design's simplified-models table says:

| Model                       | Fields Dropped | Keeps           |
| --------------------------- | -------------- | --------------- |
| `TenantModel.connections[]` | `credentialId` | `authProfileId` |

The **Mongoose model** in `packages/database/src/models/tenant-model.model.ts` stores only
`credentialId: string` in `ITenantModelConnection` — it does NOT have an inline `encryptedApiKey`.
The Prisma schema (`TenantModelConnection`) has both `credentialId` and `encryptedApiKey`, but these
are separate models. The migration table conflates the Prisma `TenantModelConnection` (which has
`encryptedApiKey`) with the Mongoose `ITenantModelConnection` (which only has `credentialId`).

This divergence means:

- The runtime credential resolution path (`model-resolution.ts`) goes through `LLMCredential` via
  `credentialId`, not inline storage.
- Migrating `TenantModel.connections` therefore requires migrating `LLMCredential` first — a
  dependency ordering constraint not stated in the design.

---

## 2. Migration Ordering — No Dependency Sequence Defined

The design describes a feature-flag-gated dual-read rollout but does not specify the order in which
the 3 deleted models must be migrated relative to the 14 simplified models.

### 2.1 Critical Ordering Constraint: LLMCredential Must Be Migrated First

Multiple consumers depend on `LLMCredential` via a `credentialId` foreign key:

- `TenantModel.connections[].credentialId` (Mongoose model, runtime path)
- `ModelConfig.credentialId` (Prisma model, studio path)
- `TenantModelConnection.credentialId` (Prisma model)
- `idp-sync-scheduler.ts` — directly queries `LLMCredential.find({ isActive: true })` to schedule
  IdP sync jobs (see `apps/search-ai/src/workers/idp-sync-scheduler.ts:226–231`)

If `LLMCredential` documents are migrated (converted to Auth Profiles and deleted) before
`TenantModel.connections[].credentialId` references are updated, runtime model resolution will fail
silently (dual-read falls back to `credentialId`, but the record no longer exists).

**Required order:**

1. Create Auth Profile documents (migration script populates `authProfileId` alongside existing `credentialId`)
2. Update consumers to dual-read (`authProfileId` || `credentialId` fallback)
3. Only THEN remove `LLMCredential` documents

This ordering constraint is not stated anywhere in Section 14.

### 2.2 No Rollback Strategy Defined

The design has a 4-phase table (Pre-migration → Phase 1: Both → Phase 2: All new → Phase 3: Cleanup)
but provides no rollback procedure. If the migration script runs and creates malformed Auth Profiles
(e.g., encryption failures, missing `linkedAppProfileId`), the only recovery path is:

- Keep `credentialId` fields populated (dual-read fallback would catch this)
- But: if Phase 3 cleanup ran and removed old fields, rollback is destructive

**Missing:** An explicit statement that Phase 3 cleanup is irreversible and that a backup snapshot
must be taken before running it.

### 2.3 No Post-Migration Validation Defined

There is no described mechanism for verifying that migration was complete and correct:

- No checksum/count comparison between old credential records and new Auth Profile records
- No smoke-test runbook (e.g., "verify N tenants have M Auth Profiles, spot-check decryption works")
- No canary tenant strategy (migrate one tenant first, verify, then batch-migrate remaining)

The design should include at minimum: expected record counts, a query to find orphaned `credentialId`
references (consumers where `authProfileId IS NULL` and `credentialId` references a nonexistent
`LLMCredential`), and criteria for declaring migration complete.

### 2.4 In-Flight Requests During Migration Window

The design handles WebSocket session continuity (Section 14, "WebSocket Session Continuity") but does
not address:

- **BullMQ jobs enqueued before migration:** A job enqueued with a `credentialId` payload will
  attempt to fetch a credential that may have been migrated. Workers must check dual-read at job
  execution time, not job enqueue time. The design states workers use dual-read, but does not address
  jobs already in the queue at migration cutover.
- **Token refresh races during migration:** If an `oauth2_token` record is being migrated while a
  concurrent token refresh attempts to update `encryptedAccessToken` on the old `EndUserOAuthToken`
  model, the write will succeed but the Auth Profile will have the old token. The migration script
  must acquire the per-token Redis distributed lock during migration or accept a brief inconsistency.

---

## 3. Dual-Read Coverage Gaps

The design's dual-read pattern is:

```typescript
const credential = entity.authProfileId
  ? await authProfileService.resolve({ authProfileId: entity.authProfileId, tenantId })
  : await legacyCredentialService.resolve({ credentialId: entity.credentialId, tenantId });
```

### 3.1 Dual-Read Not Specified for All 14 Consumer Paths

The design names dual-read for:

- Runtime model resolution (`model-resolution.ts`)
- BullMQ workers (section 14, "BullMQ Worker Migration Strategy")
- WebSocket sessions

Not explicitly covered:

- `connection-resolver.ts` — reads `encryptedCredentials` and `config.encryptedInboundAuthToken`
  directly from `ChannelConnection` documents
  (`apps/runtime/src/channels/connection-resolver.ts:43,69,122,148,215`). If `ChannelConnection`
  is migrated to use `authProfileId`, the resolver needs dual-read. The design says `ChannelConnection`
  drops `encryptedCredentials` / `config.encryptedInboundAuthToken` but does not specify the
  dual-read path for `connection-resolver.ts`.
- `tool-oauth-service.ts` — directly reads `EndUserOAuthToken.encryptedAccessToken` / `encryptedRefreshToken`.
  The design says this service is being replaced by unified token refresh in `AuthProfileService`,
  but dual-read for the transition period is not specified.
- `apps/runtime/src/services/adapters/service-node-executor.ts` — reads `ServiceNode.encryptedSecrets`.
  No dual-read path specified for this executor.

### 3.2 Auth Profile Deleted While Old Credential Still Referenced

Section 10 states:

> Consumers with dangling `authProfileId` get: "Auth profile 'X' not found. Reconfigure authentication."

But the symmetric case is unaddressed: if dual-read is active and a consumer has `authProfileId` set
(migration complete for that record) but the corresponding old `credentialId` record was NOT yet
deleted (Phase 1/2 window), and then the Auth Profile is deleted, the fallback to `credentialId`
would silently resurrect the stale credential. The design must state that Auth Profile deletion
should be blocked (or warn) when dual-read is still active for the consumer.

### 3.3 Race Condition: Simultaneous Migration + Token Refresh

`AuthProfileService.resolve()` for `oauth2_token` profiles performs a read-refresh-write cycle under
a Redis distributed lock. The migration script that copies `EndUserOAuthToken` records to Auth
Profiles must also acquire the same Redis lock key during the copy. If this is not done, a concurrent
token refresh on the old `EndUserOAuthToken` record will write a newer token that the migration script
then overwrites with the stale value.

The design specifies the lock key pattern for token refresh (Section 5, "Token Refresh (unified)")
but does not extend it to the migration script.

### 3.4 Performance Impact of Dual-Read on Hot Paths Not Addressed

`model-resolution.ts` is on the critical path for every LLM call. During Phase 1 (both old and new
pods active), new pods perform two DB reads per resolution when `authProfileId` is missing (one
attempted fetch of Auth Profile → not found → fallback to old path). The metadata cache in
`ModelResolutionService` partially mitigates this, but:

- The cache TTL is configurable (default loaded from DB) and may be short
- `clearCache(tenantId)` is called after credential mutations — during migration, every credential
  write (migration progress) will invalidate cache entries for the entire tenant, potentially causing
  a cache stampede on busy tenants

The design should include a note about temporarily elevating the metadata cache TTL during the
migration window.

---

## 4. BullMQ Worker Migration — Incomplete Worker Enumeration

The design states "22+ BullMQ workers" and lists specific workers to update. The actual count from
`apps/search-ai/src/workers/` is **36 worker files**. The credential-touching subset is larger than
the design acknowledges.

### 4.1 Workers Named in Design vs. Workers That Actually Touch Credentials

Design names: `connector-sync-worker`, `connector-discovery-worker`,
`connector-permission-crawl-worker`, `webhook-renewal scheduler`, `embedding-worker`,
`kg-enrichment-worker`, `enrichment-worker`, `vocabulary-generation-worker`, `6× IDP sync workers`,
`delivery-worker`, `inbound-worker`.

Workers found by codebase search that touch credentials but are NOT named:

| Worker                        | Credential Access                                                                                   | Evidence                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `page-processing-worker`      | `llmConfig.useCases.progressiveSummarization.apiKey`, `llmConfig.useCases.questionSynthesis.apiKey` | `apps/search-ai/src/workers/page-processing-worker.ts:101,134`      |
| `noise-detection-worker`      | `llmConfig.useCases.noiseDetection.apiKey`                                                          | `apps/search-ai/src/workers/noise-detection-worker.ts:104`          |
| `question-synthesis-worker`   | `llmConfig.useCases.questionSynthesis.apiKey`                                                       | `apps/search-ai/src/workers/question-synthesis-worker.ts:95`        |
| `scope-classification-worker` | `llmConfig.useCases.scopeClassification.apiKey`                                                     | `apps/search-ai/src/workers/scope-classification-worker.ts:91`      |
| `tree-building-worker`        | `llmConfig.apiKey`                                                                                  | `apps/search-ai/src/workers/tree-building-worker.ts:89`             |
| `taxonomy-setup-worker`       | `llmConfig.apiKey`                                                                                  | `apps/search-ai/src/workers/taxonomy-setup-worker.ts:76`            |
| `multimodal-worker`           | `llmConfig.useCases.multimodal.apiKey`                                                              | `apps/search-ai/src/workers/multimodal-worker.ts:59`                |
| `schema-sync-worker`          | `connectorConfig.oauthTokenId` → `ConnectorConfig.oauthTokenId`                                     | `apps/search-ai/src/workers/schema-sync-worker.ts:65`               |
| `permission-recrawl-worker`   | `oauthTokenId` via ConnectorConfig                                                                  | `apps/search-ai/src/__tests__/permission-recrawl-worker.test.ts:93` |

These workers all resolve credentials through the `llm-config` resolver
(`apps/search-ai/src/services/llm-config/resolver.ts`) which reads `LLMCredential.encryptedApiKey`
directly. They must be updated with dual-read once `LLMCredential` is migrated.

### 4.2 IDP Sync Scheduler Uses `LLMCredential` as IDP Credential Store (Architectural Misuse)

**Location:** `apps/search-ai/src/workers/idp-sync-scheduler.ts:226–244`

```typescript
const LLMCredential = mongoose.model<ILLMCredential>('LLMCredential');
const credentials = await LLMCredential.find({ isActive: true });
// Filter credentials by provider (based on metadata field names)
const providerCredentials = credentials.filter((cred) => {
  const metadata = (cred as any).metadata || {};
  if (provider === 'azuread') {
    return metadata.azureadUserSyncDeltaToken !== undefined || metadata.tenantId;
  } else if (provider === 'okta') {
    return metadata.oktaUserSyncLastUpdated !== undefined || metadata.oktaDomain;
  }
```

The IdP sync scheduler repurposes `LLMCredential` to store AzureAD / Okta / Google admin
credentials by using the untyped `metadata` field. This is a documented workaround (the comment says
"we should add a provider field to LLMCredential"). After `LLMCredential` is deleted in Phase 3,
this scheduler breaks entirely — it will find zero credentials and silently stop scheduling IdP
syncs.

The design's worker update strategy must address this misuse explicitly. A new `AuthProfile` with
`authType: oauth2_client_credentials` or `api_key` and `category: 'infrastructure'` would be the
correct replacement, but the migration script must detect and convert these misused `LLMCredential`
records since they do not look like standard LLM credentials.

### 4.3 Workers With In-Memory Credential Singletons — Cache Invalidation Not Specified

`embedding-worker.ts` and `kg-enrichment-worker.ts` use module-level lazy singletons for credentials:

```typescript
// apps/search-ai/src/workers/embedding-worker.ts:82–103
let _embeddingProvider: EmbeddingProvider | undefined;
function getEmbeddingProvider(): EmbeddingProvider {
  if (!_embeddingProvider) {
    const config = {
      apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY, // env var path
    };
    _embeddingProvider = createEmbeddingProvider(config);
  }
  return _embeddingProvider;
}
```

This singleton is initialized once from `process.env` and never invalidated. It is used as a fallback
when no pipeline-specific config is found. After Auth Profile migration:

- Rotating a credential in Auth Profile does NOT invalidate this singleton
- The singleton bypasses the dual-read path entirely (it reads from env vars, not DB)
- The design's "Obsolete After Migration (Phase 4)" section lists `OPENAI_API_KEY` as obsolete, but
  this singleton will silently continue using the old env var value

Migration must add explicit singleton invalidation logic (e.g., clear `_embeddingProvider` when
`AUTH_PROFILE_ENABLED` is true and the env var is being removed) or accept that these workers will
use stale credentials until restarted.

---

## 5. Summary Table

| Gap                                                                                | Severity | Section               | Status        |
| ---------------------------------------------------------------------------------- | -------- | --------------------- | ------------- |
| `GitIntegration.webhookSecret` not encrypted, migration path unclear               | High     | Consumer completeness | Unaddressed   |
| `GuardrailPolicy.settings.webhookSecret` unlisted, plain text                      | High     | Consumer completeness | Unaddressed   |
| `EnvironmentVariable.isSecret` migration path contradictory                        | Medium   | Consumer completeness | Contradictory |
| `LLMCredential` must migrate before `TenantModel.connections[]` (ordering dep)     | High     | Migration ordering    | Unaddressed   |
| No rollback strategy for Phase 3 cleanup                                           | High     | Migration ordering    | Unaddressed   |
| No post-migration validation / canary strategy                                     | Medium   | Migration ordering    | Unaddressed   |
| BullMQ jobs in-flight at migration cutover                                         | Medium   | Migration ordering    | Unaddressed   |
| OAuth token refresh race during migration                                          | High     | Dual-read coverage    | Unaddressed   |
| `connection-resolver.ts` dual-read path not specified                              | High     | Dual-read coverage    | Unaddressed   |
| `tool-oauth-service.ts` dual-read path not specified                               | High     | Dual-read coverage    | Unaddressed   |
| `service-node-executor.ts` dual-read path not specified                            | Medium   | Dual-read coverage    | Unaddressed   |
| Auth Profile deletion while dual-read is active (stale fallback)                   | Medium   | Dual-read coverage    | Unaddressed   |
| Cache stampede on metadata cache during migration                                  | Low      | Dual-read coverage    | Unaddressed   |
| 9 unnamed workers touch credentials (page-processing, noise-detection, etc.)       | High     | BullMQ workers        | Unaddressed   |
| IdP sync scheduler misuses `LLMCredential` for IDP creds; breaks on Phase 3 delete | Critical | BullMQ workers        | Unaddressed   |
| `embedding-worker` in-memory singleton bypasses dual-read, no invalidation         | Medium   | BullMQ workers        | Unaddressed   |

```

---

## Key Files Referenced

- `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` — design doc under review (Section 14)
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/git-integration.model.ts` — plain-text `webhookSecret` gap
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/guardrail-policy.model.ts` — unencrypted `settings.webhookSecret`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/environment-variable.model.ts` — `isSecret` credential records
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/tenant-model.model.ts` — `credentialId` (not inline `encryptedApiKey`)
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/idp-sync-scheduler.ts:226` — critical: misuses `LLMCredential` for IDP credentials
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/embedding-worker.ts:82` — module-level singleton bypasses dual-read
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/channels/connection-resolver.ts:43` — no dual-read path specified for channel connections
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/tool-oauth-service.ts:29` — OAuth token service not addressed in dual-read plan
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/page-processing-worker.ts:101` — unnamed worker touching credentials
```
