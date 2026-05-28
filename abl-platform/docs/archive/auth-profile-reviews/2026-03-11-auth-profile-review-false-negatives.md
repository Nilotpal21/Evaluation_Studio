# Auth Profile Design — False Negatives Review

> Review date: 2026-03-11
> Reviewed by: Automated codebase audit
> Design doc: `docs/plans/2026-03-11-auth-profile-design.md`
> Scope: False negatives only — things the codebase needs that the design still misses after two amendment rounds.

---

## How to Read This Document

Each finding includes:

- **Evidence**: exact file path and line reference
- **What the design says**: what (if anything) the design covers
- **The gap**: what is missing

Findings are grouped by the five audit dimensions in the review task.

---

## 1. Credential Patterns Not Covered

### 1.1 `TriggerRegistration.webhookSecret` — Plain-Text, Not in Migration Table

**Evidence**: `packages/database/src/models/trigger-registration.model.ts:28,65`

`ITriggerRegistration.webhookSecret` is stored as a plain `String` field with no `encryptionPlugin`. The schema has `TriggerRegistrationSchema.plugin(tenantIsolationPlugin)` but no encryption plugin.

**What the design says**: The design's "Additional Consumers Found in Audit" table covers `GitIntegration.webhookSecret` (plain text, explicit action item) and `GuardrailPolicy.settings.webhookSecret`. `TriggerRegistration.webhookSecret` is not mentioned anywhere in the design.

**The gap**: `TriggerRegistration` is a live production model used by workflow trigger subscriptions. Its HMAC secret for verifying inbound webhooks is stored in plaintext. It needs the same migration treatment as `GitIntegration.webhookSecret`: migrate to Auth Profile with `webhookVerification` addon and add interim at-rest encryption.

---

### 1.2 `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` — Second Guardrail Credential Location

**Evidence**: `packages/database/src/models/guardrail-policy.model.ts:24,123`

`IGuardrailProviderOverride.apiKeyCredentialId` is an embedded array field on `GuardrailPolicy` (distinct from the top-level `TenantGuardrailProviderConfig.apiKeyCredentialId`). Both models store guardrail provider API key references, but through different foreign keys and different model types.

**What the design says**: Section 4 consumer table lists `TenantGuardrailProviderConfig.authProfileId` (replacing `apiKeyCredentialId`). The "Additional Consumers Found in Audit" mentions `GuardrailPolicy.settings.webhookSecret` but not the `providerOverrides[].apiKeyCredentialId` field.

**The gap**: `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` is a second, independent reference to `LLMCredential` inside an embedded subdocument array. It is not in the consumer mapping table and has no migration action. Any policy-level override that specifies a custom API key for a guardrail provider will silently break in Phase 3 when `LLMCredential` is deleted.

---

### 1.3 `SDKChannel.secretKey` — Plain-Text, Not Flagged as At-Rest Exposure

**Evidence**: `packages/database/src/models/sdk-channel.model.ts:28-31,51-64`

`ISDKChannel.secretKey` is stored as a plain `String` with no `encryptionPlugin`. The schema uses only `tenantIsolationPlugin`. The field is the HMAC secret for SDK channel identity verification (`hmacEnforcement: 'required'`).

**What the design says**: Section 14 migration table correctly identifies `SDKChannel` as a simplified model that drops `secretKey` in favour of `authProfileId` with `webhookVerification` addon. However, unlike `GitIntegration.webhookSecret` (which gets an explicit callout: "Stored as plain text — Not encrypted at rest"), there is no equivalent callout for `SDKChannel.secretKey`.

**The gap**: `SDKChannel.secretKey` is also plaintext at rest. The migration table should add the same "stored as plain text" warning and an interim encryption action to prevent a window where plaintext HMAC secrets sit in the database while the Auth Profile migration is underway.

---

### 1.4 `ModelConfig.credentialId` — Not in the Consumer Mapping Table

**Evidence**: `packages/database/src/models/model-config.model.ts:19,53`

`IModelConfig.credentialId` stores a reference to `LLMCredential._id`. It is a project-scoped per-model credential override that allows individual projects to use a different LLM API key than the tenant-level connection.

**What the design says**: Section 4 consumer mapping table lists `TenantModel.connections[].credentialId` → `TenantModel.connections[].authProfileId` as the migration target. `ModelConfig.credentialId` (a different model from `TenantModel`) does not appear anywhere in the design.

**The gap**: `ModelConfig` has a separate `credentialId` that bypasses the `TenantModel.connections[]` lookup. At Phase 3 when `LLMCredential` documents are deleted, any `ModelConfig` record with `credentialId` set will silently produce null credentials. The consumer mapping table needs a `ModelConfig` row, and `model-resolution.ts` must be updated with dual-read.

---

### 1.5 Email Channel SMTP Credentials — Permanent Env-Var Path Not Acknowledged

**Evidence**: `apps/runtime/src/services/email/transports/resolve-transport.ts:93-100`

The SMTP transport (`SmtpTransport`) is always constructed from `process.env.SMTP_RELAY_HOST`, `SMTP_RELAY_PORT`, `SMTP_RELAY_USER`, `SMTP_RELAY_PASS`. There is no per-tenant credential resolution for the outbound email relay; it is a single global SMTP configuration.

**What the design says**: Section 14 lists "Stays Unchanged: Voice service vars" and similar env-only paths. `SMTP_RELAY_*` env vars are not mentioned.

**The gap**: The design's "Obsolete After Migration" list only covers channel-specific OAuth vars (`CHANNEL_OAUTH_SLACK_*`, etc.). The `SMTP_RELAY_*` env vars represent a credential class — outbound email relay authentication — that is silently left on the legacy env-var path with no `EnvironmentVariable` record to migrate either. The design should explicitly acknowledge this as out of scope or document why it is acceptable (single global relay vs per-tenant relay).

The `GraphTransport` (Microsoft 365 email via Graph API) does use per-tenant credentials sourced from `ChannelConnection.encryptedCredentials`, which is in scope. That inconsistency between the two email transport paths needs documentation.

---

### 1.6 Neo4j Credentials in `search-ai` — No DB Record, No Migration Path

**Evidence**: `apps/search-ai/src/services/knowledge-graph/neo4j-client.ts:93`, `apps/search-ai/src/services/knowledge-graph/taxonomy-graph.service.ts:105`

Neo4j connections use `neo4j.auth.basic(this.config.username, this.config.password)` where `config` comes from `SearchAIConfig` (env vars: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`). These are infrastructure-level credentials for the graph database.

**What the design says**: Not mentioned anywhere in the design.

**The gap**: The design explicitly excludes infrastructure env vars for voice services. The same principle should be explicitly applied to Neo4j (and by extension, Redis, MongoDB, Elasticsearch connection credentials). Without an explicit exclusion, implementers may try to migrate Neo4j credentials into Auth Profiles, which would be wrong — these are infrastructure-layer secrets, not service-auth credentials. The "Explicitly Out of Scope" list should be extended.

---

### 1.7 `CredentialAgeMonitor` — Does Not Include `AuthProfile`

**Evidence**: `apps/runtime/src/services/credential-age-monitor.ts:41-54`

`CredentialAgeMonitor.checkAll()` hardcodes queries against `ToolSecret`, `LLMCredential`, and `ApiKey`. It uses `createdAt` / `rotatedAt` fields to detect stale credentials and emits `credential.age.warning` / `credential.age.critical` events.

**What the design says**: `CredentialAgeMonitor` is not mentioned at all.

**The gap**: After migration, `ToolSecret` and `LLMCredential` will be empty. `CredentialAgeMonitor` will find zero credentials and silently stop producing age alerts. It must be updated to query `AuthProfile` instead, using the new `rotationStartedAt` / `lastValidatedAt` / `createdAt` fields. The design should include a migration action for this monitoring service.

---

## 2. Consumer Models Not Listed

### 2.1 `ConnectorConnection.encryptionKeyVersion` — Orphaned Key-Version Field

**Evidence**: `packages/database/src/models/connector-connection.model.ts:27,53`

`IConnectorConnection.encryptionKeyVersion` is stored as a number (default `1`) alongside `encryptedCredentials`. This is a per-record key-version tracker that the existing codebase writes but never uses for decryption (as the design's Section 1 notes, `KeyVersion` is never consulted during encryption/decryption today).

**What the design says**: The design removes `encryptionKeyVersion` from `AuthProfile` as "no stored key-version-to-key mapping exists." The migration table says `ConnectorConnection` drops `encryptedCredentials` and `oauth2RefreshToken` for `authProfileId`.

**The gap**: The migration table for `ConnectorConnection` does not include `encryptionKeyVersion`. If the schema field is left in place after migration it becomes dead weight. If dropped, the migration table should explicitly list it. This is a minor housekeeping gap but affects schema accuracy.

---

### 2.2 `connectors/base` `TokenManager` — Writes Directly to `EndUserOAuthToken`, No Dual-Read Plan

**Evidence**: `packages/connectors/base/src/auth/token-manager.ts:31,57-70`

`TokenManager` in `packages/connectors/base` takes a `Model<IEndUserOAuthToken>` constructor argument and writes `accessToken`/`refreshToken` directly to it. `SharePointConnector` passes the `tokenModel` from its constructor.

**What the design says**: Section 14 "Dual-Read Coverage for Specific Consumers" covers `tool-oauth-service.ts` and `connection-resolver.ts`. `TokenManager` in `packages/connectors/base` is not listed.

**The gap**: `TokenManager.storeTokens()` and `TokenManager.refreshToken()` bypass `AuthProfileService` entirely and write directly to `EndUserOAuthToken`. When `EndUserOAuthToken` is deleted in Phase 3, all SharePoint (and any future) connector token operations break. This package needs a dual-read adapter: if `AUTH_PROFILE_ENABLED`, write to `AuthProfile` via `AuthProfileService`; otherwise write to `EndUserOAuthToken`.

---

### 2.3 `OrgProxyConfig` — 6-Field Merge Into Single Auth Profile Blob Unspecified

**Evidence**: `packages/database/src/models/org-proxy-config.model.ts:23-27`

`IOrgProxyConfig` has six independently encrypted fields: `encryptedProxyUsername`, `encryptedProxyPassword`, `encryptedProxyToken`, `encryptedCaCertificate`, `encryptedClientCert`, `encryptedClientKey`. These map to at least three different auth types (`basic` = username+password, `bearer` = token, `mtls` = cert+key+ca).

**What the design says**: Section 14 says `OrgProxyConfig` drops "6 encrypted fields" and keeps `authProfileId`. Section 4 says "Org Proxy" uses `basic`, `bearer`, `mtls`.

**The gap**: One `OrgProxyConfig` record may have fields for multiple auth types populated simultaneously (e.g., a proxy that accepts either bearer token or mTLS). The design does not specify how a multi-credential `OrgProxyConfig` migrates: does it create one Auth Profile per auth type, or does it pick one? The migration script needs a decision rule here to avoid data loss.

---

## 3. Runtime Execution Paths Not Covered

### 3.1 Voice Service Factory Cache Not Invalidated on Auth Profile Rotation

**Evidence**: `apps/runtime/src/services/voice/voice-service-factory.ts:35,66-77`

`VoiceServiceFactory` caches decrypted `DeepgramService`, `ElevenLabsService`, and `TwilioService` instances per-tenant with a fixed 10-minute TTL (`CACHE_TTL_MS = 10 * 60 * 1000`). `invalidate(tenantId)` exists but is only called from test code — nothing in the server wires rotation events to it.

**What the design says**: Section 12 "Streaming / WebSocket / SSE / Voice Auth Lifecycle" says: "LiveKit voice sessions: Voice service credentials (Deepgram, ElevenLabs) cached for call duration. Refresh buffer (60s) must exceed expected max call duration (30min)." Section 8 says the session-level credential cache is "invalidated when rotation events occur (via Redis pub/sub notification)."

**The gap**: The `VoiceServiceFactory` cache is a separate, process-local cache that is not wired to any Redis pub/sub invalidation mechanism. The design's Redis pub/sub invalidation covers the session-level `RuntimeSecretsProvider` cache inside `LLMWiringService` — it does not cover the voice service factory cache. After an Auth Profile rotation for a Deepgram/ElevenLabs/Twilio credential, the factory will continue serving stale decrypted API keys for up to 10 minutes. The design must specify that Auth Profile rotation events also invalidate `VoiceServiceFactory` caches (via the same Redis pub/sub channel).

---

### 3.2 `pipeline-engine` Service Token Uses Shared `JWT_SECRET` — Not Differentiated

**Evidence**: `packages/pipeline-engine/src/pipeline/services/eval/eval-auth.ts:9-51`

`createServiceToken()` uses `process.env.JWT_SECRET` (the platform-wide JWT secret shared with user authentication) to mint service-to-service JWTs. If `JWT_SECRET` is rotated, eval tokens stop working immediately.

**What the design says**: Section 16 "Stays Unchanged" explicitly lists `JWT_SECRET` as staying unchanged. The design does not cover `pipeline-engine`'s use of the same secret.

**The gap**: The design does not mention that `JWT_SECRET` rotation impacts the eval pipeline's service-to-service authentication. Any key rotation plan that rotates `JWT_SECRET` will break eval sessions mid-flight. This is a cross-cutting concern that the design should acknowledge, even if only to confirm it is out of scope and point to pipeline-engine's own documentation.

---

### 3.3 Admin API Authentication — No Coverage

**Evidence**: `apps/admin/src/lib/runtime-proxy.ts` (found as the only file matching admin credential patterns)

**What the design says**: Not mentioned.

**The gap**: The Admin application proxies requests to the runtime. The mechanism by which the admin service authenticates to the runtime is not described anywhere in the design. Given that `INTERNAL_API_KEY` is listed as "stays unchanged," this is presumably out of scope, but the design does not say this explicitly. If the admin service uses `INTERNAL_API_KEY` for runtime proxying and that key is not migrated to Auth Profile, there is a potential credential class left undocumented.

---

### 3.4 Sandbox JWT Authentication — No Rotation Consideration

**Evidence**: `apps/runtime/src/routes/memory-api.ts:62-83`, `apps/runtime/src/config/index.ts:298`

The memory-api callback route verifies JWTs signed with `SANDBOX_JWT_SECRET`. Sandbox pod tokens are short-lived (configurable via `SANDBOX_JWT_EXPIRY_SECONDS`), but the signing secret itself has no rotation mechanism.

**What the design says**: `SANDBOX_JWT_SECRET` is listed in "Stays Unchanged."

**The gap**: No gap in design intent, but the design should explicitly note that `SANDBOX_JWT_SECRET` rotation requires coordinated pod restart (since in-flight sandbox sessions will have tokens signed with the old key). This is an operational gap that is invisible from the design document.

---

## 4. Test Infrastructure Gaps

### 4.1 No Shared Mock Factory for `AuthProfile`

**Evidence**: `apps/runtime/src/__tests__/` — grep for `mock.*AuthProfile` returns zero results. The existing tests use inline mock objects for `ToolSecret`, `LLMCredential`, and `EndUserOAuthToken` (e.g., `tool-secrets-authz.test.ts`, `oauth-authz.test.ts`, `secrets-provider.test.ts`).

**What the design says**: Nothing about test infrastructure.

**The gap**: The design introduces a new model that will be referenced across 400+ runtime test files (indirectly via `authProfileService.resolve()`). Without a shared mock factory (analogous to the existing `makeToolSecret()` / `makeLLMCredential()` patterns), every test that touches credential resolution will need to duplicate `AuthProfile` mock construction. The design should specify a test helper package:

```typescript
// packages/test-helpers/src/auth-profile-factory.ts
export function makeAuthProfile(overrides?: Partial<IAuthProfile>): IAuthProfile;
export function makeDecryptedCredentials(authType: string): DecryptedCredentials;
```

---

### 4.2 `CredentialAgeMonitor` Tests Will Silently Pass After Migration with Zero Coverage

**Evidence**: `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts`

The test file mocks `ToolSecret`, `LLMCredential`, and `ApiKey`. After Phase 3, these mocks return empty arrays and the monitor's `checkAll()` produces no events — all tests still pass (zero alerts is a valid outcome when zero credentials are found), but the monitor is effectively dead.

**What the design says**: Nothing about updating tests for monitoring services.

**The gap**: The `CredentialAgeMonitor` test suite needs to be updated to use `AuthProfile` as the credential source in Phase 2/3. Without this, the monitor silently stops alerting on stale credentials post-migration and tests give false confidence.

---

### 4.3 `EndUserOAuthToken` Not in Cascade Delete — Test Gap

**Evidence**: `packages/database/src/cascade/cascade-delete.ts:219-258`

`deleteUser()` deletes `LLMCredential` records where `credentialScope: 'user'` (line 243-244). `EndUserOAuthToken` is not deleted in `deleteUser()`, `deleteTenant()`, or `deleteProject()`.

**What the design says**: Section 11 GDPR says: "User deletion: Delete all personal Auth Profiles where `createdBy === subjectId`." Section 14 migration says `EndUserOAuthToken` is replaced by `AuthProfile` with `visibility: personal`.

**The gap**: Even during Phase 1 (dual-read), `EndUserOAuthToken` records need to be deleted in `deleteUser()` for GDPR compliance. Currently they are not. The existing `packages/database/src/__tests__/mongo-cascade.test.ts` does not test for `EndUserOAuthToken` deletion. The design's GDPR section specifies the right end state (delete personal `AuthProfile` on user deletion) but does not flag that the interim state (`EndUserOAuthToken` not deleted on user deletion) is a pre-existing GDPR compliance gap that must be fixed independently of the Auth Profile migration.

---

## 5. Monitoring and Alerting Gaps

### 5.1 No Alerting Specification for New Failure Modes

**What the design says**: Section 10 defines `AuthProfileError` with typed `reason` discriminants. Section 10 defines trace events (`auth_profile_resolved`, `auth_profile_refresh`, `auth_profile_failed`, `auth_profile_rotated`). Section 9 defines `AUTH_PROFILE_CERT_PIN_MISMATCH` error code with "report-only destination: emits audit event to ClickHouse."

**The gap**: The design introduces several new operational failure modes that have no corresponding alerting thresholds or health check specifications:

| New Failure Mode                                                     | Design Coverage        | Missing                                                |
| -------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| `AUTH_PROFILE_TOKEN_REFRESH_FAILED` at scale                         | Error code defined     | No alert threshold (e.g., >N failures/min → PagerDuty) |
| `AUTH_PROFILE_DECRYPTION_FAILED` (key rotation left data unreadable) | Error code defined     | No health check endpoint; no alert                     |
| `AUTH_PROFILE_CERT_PIN_MISMATCH`                                     | Emits ClickHouse event | No alerting on report-only mismatch rate               |
| Proxy chain resolution failures                                      | Error code defined     | No alert                                               |
| Redis lock contention timeout on token refresh                       | Retry logic defined    | No metric for sustained lock contention                |
| `CredentialAgeMonitor` — post-migration gap                          | Not mentioned          | Monitor will silently report zero aged creds           |

The design should add a subsection specifying which new trace/audit events should trigger operational alerts and what thresholds are appropriate.

---

### 5.2 No Health Check Endpoint for `AuthProfileService`

**What the design says**: The health registry at `apps/runtime/src/health/service-registry.ts` lists health endpoints for MongoDB, Redis, ClickHouse, and 10+ other services. The design does not add `authProfileService` to any health check.

**The gap**: `authProfileService.resolve()` is now on the critical path for every agent turn (credential resolution). A health check that verifies: (a) the MongoDB connection can query `AuthProfile`, (b) a known test profile can be decrypted, and (c) the Redis lock mechanism is reachable — would catch misconfiguration before production traffic hits. The design should specify a `/health` sub-check or add `AuthProfile` to the existing `service-registry.ts` registry.

---

### 5.3 Cascade Delete Does Not Include `AuthProfile` or `EndUserOAuthToken`

**Evidence**: `packages/database/src/cascade/cascade-delete.ts:26-128`

`deleteTenant()` deletes `LLMCredential` (line 103) and `ConnectorConnection` (line 102) but not `AuthProfile` or `EndUserOAuthToken`. `deleteProject()` deletes `ConnectorConnection` (line 192) but not `AuthProfile`. `deleteUser()` deletes `LLMCredential` scoped by user (line 243-244) but not `EndUserOAuthToken` or `AuthProfile`.

**What the design says**: Section 11 GDPR says: "Auth Profile MUST be included in `MongoGDPRStore` AND `cascade-delete.ts` from day one." However the cascade-delete file is the actual implementation — the design does not provide the exact `deleteMany` calls to add, nor does it note that `EndUserOAuthToken` is currently absent from cascade delete (a pre-existing gap).

**The gap**: The cascade-delete implementation change needed is concrete and blocking for GDPR compliance from day one:

- `deleteTenant()`: add `AuthProfile.deleteMany({ tenantId })` and `EndUserOAuthToken.deleteMany({ tenantId })`
- `deleteProject()`: add `AuthProfile.deleteMany({ projectId })` (project-scoped profiles)
- `deleteUser()`: add `EndUserOAuthToken.deleteMany({ tenantId: ..., userId })` and `AuthProfile.deleteMany({ tenantId: ..., createdBy: userId, visibility: 'personal' })`

The design should include these exact changes rather than a general statement.

---

## Summary Table

| #   | Finding                                                                            | Severity | File Reference                                                       |
| --- | ---------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| 1.1 | `TriggerRegistration.webhookSecret` plain-text, not in migration table             | High     | `packages/database/src/models/trigger-registration.model.ts:28`      |
| 1.2 | `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` missing from consumer map | High     | `packages/database/src/models/guardrail-policy.model.ts:24`          |
| 1.3 | `SDKChannel.secretKey` plain-text, at-rest exposure not flagged                    | Medium   | `packages/database/src/models/sdk-channel.model.ts:28`               |
| 1.4 | `ModelConfig.credentialId` not in consumer mapping table                           | High     | `packages/database/src/models/model-config.model.ts:19`              |
| 1.5 | `SMTP_RELAY_*` env-var credential path not acknowledged as out of scope            | Low      | `apps/runtime/src/services/email/transports/resolve-transport.ts:96` |
| 1.6 | Neo4j credentials not in scope exclusion list                                      | Low      | `apps/search-ai/src/services/knowledge-graph/neo4j-client.ts:93`     |
| 1.7 | `CredentialAgeMonitor` not updated to query `AuthProfile`                          | Medium   | `apps/runtime/src/services/credential-age-monitor.ts:41`             |
| 2.1 | `ConnectorConnection.encryptionKeyVersion` not in migration table                  | Low      | `packages/database/src/models/connector-connection.model.ts:27`      |
| 2.2 | `connectors/base` `TokenManager` has no dual-read plan                             | High     | `packages/connectors/base/src/auth/token-manager.ts:31`              |
| 2.3 | `OrgProxyConfig` multi-credential merge strategy unspecified                       | Medium   | `packages/database/src/models/org-proxy-config.model.ts:23`          |
| 3.1 | `VoiceServiceFactory` cache not wired to Auth Profile rotation invalidation        | Medium   | `apps/runtime/src/services/voice/voice-service-factory.ts:35`        |
| 3.2 | `pipeline-engine` `JWT_SECRET` dependency on rotation not acknowledged             | Low      | `packages/pipeline-engine/src/pipeline/services/eval/eval-auth.ts:9` |
| 3.3 | Admin API authentication path not addressed                                        | Low      | `apps/admin/src/lib/runtime-proxy.ts`                                |
| 3.4 | `SANDBOX_JWT_SECRET` rotation operational gap not documented                       | Low      | `apps/runtime/src/routes/memory-api.ts:62`                           |
| 4.1 | No shared `AuthProfile` mock factory for tests                                     | Medium   | (cross-cutting)                                                      |
| 4.2 | `CredentialAgeMonitor` tests give false confidence post-migration                  | Medium   | `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts` |
| 4.3 | `EndUserOAuthToken` absent from cascade delete — pre-existing GDPR gap             | High     | `packages/database/src/cascade/cascade-delete.ts:219`                |
| 5.1 | No alerting thresholds for new Auth Profile failure modes                          | Medium   | (cross-cutting)                                                      |
| 5.2 | No health check endpoint for `authProfileService`                                  | Medium   | `apps/runtime/src/health/service-registry.ts`                        |
| 5.3 | Cascade delete concrete implementation changes not specified                       | High     | `packages/database/src/cascade/cascade-delete.ts:26`                 |

---

**High-severity findings requiring design amendments before implementation begins**: 1.1, 1.2, 1.4, 2.2, 4.3, 5.3.
