# Auth Profile Design — Existing Code Impact Review

**Reviewer:** Claude Opus 4.6 (code review agent)
**Date:** 2026-03-11
**Documents reviewed:**

- `2026-03-11-auth-profile-design.md` (design)
- `2026-03-11-auth-profile-code-changes.md` (code change inventory)
- `2026-03-11-auth-profile-redundancy-analysis.md` (redundancy analysis)
- `2026-03-11-auth-profile-connections-analysis.md` (connections analysis)

**Method:** Claims verified via codebase search (grep, glob, file reads) against the actual `develop` branch.

---

## 1. Model Deletion Claims (3 models)

### 1.1 LLMCredential

- **Claim:** Model at `packages/database/src/models/llm-credential.model.ts`, collection `llm_credentials`
- **Verification:** File exists. Fields match: `encryptedApiKey`, `encryptedEndpoint`, `credentialScope`, `ownerId`, `tenantId`, `provider`, `name`, `authType`, `authConfig`, `customHeaders`, `isActive`, `isDefault`, `lastUsedAt`, `lastValidatedAt`.
- **Reference count:** 57 files reference `LLMCredential`.
- **Verdict:** ✅ Verified — model exists as claimed.

**⚠️ Incomplete — reference count underestimated.** The code-changes doc lists ~12 files in its impact table. The actual grep finds **57 files** referencing `LLMCredential`. Many are in search-ai workers (`shared.ts`, `embedding-worker.ts`, `kg-enrichment-worker.ts`, `enrichment-worker.ts`, `vocabulary-generation-worker.ts`, plus all IDP sync workers: `okta-user-sync-worker.ts`, `google-group-sync-worker.ts`, `google-user-sync-worker.ts`, `azuread-group-sync-worker.ts`, `azuread-user-sync-worker.ts`, `idp-sync-scheduler.ts`, `okta-group-sync-worker.ts`), `pipeline-engine` services, `workflow-engine/services/database.ts`, and seed scripts. The documents do not account for the full breadth of BullMQ worker impact.

### 1.2 EndUserOAuthToken

- **Claim:** Model at `packages/database/src/models/end-user-oauth-token.model.ts`
- **Verification:** File exists. Fields: `encryptedAccessToken`, `encryptedRefreshToken` (via `encryptionPlugin`).
- **Reference count:** 29 files.
- **Verdict:** ✅ Verified — model exists as claimed.

**⚠️ Incomplete — ConnectorConfig.oauthTokenId reference missed.** The `ConnectorConfig` model (`packages/database/src/models/connector-config.model.ts`) has a field `oauthTokenId: string | null` that explicitly references `EndUserOAuthToken._id` (line 26 comment: "References EndUserOAuthToken.\_id"). This model is not mentioned in any of the four documents. `ConnectorConfig` is used by SearchAI's connector sync worker, discovery worker, permission crawl worker, and webhook renewal scheduler. All of these resolve OAuth tokens through this reference.

### 1.3 ToolSecret

- **Claim:** Model at `packages/database/src/models/tool-secret.model.ts`
- **Verification:** File exists. Field: `encryptedValue` (via `encryptionPlugin`).
- **Reference count:** 26 files.
- **Verdict:** ✅ Verified — model exists as claimed.

---

## 2. Models Missed (not documented anywhere)

### 2.1 TenantServiceInstance

- **File:** `packages/database/src/models/tenant-service-instance.model.ts`
- **Encrypted fields:** `encryptedApiKey`, `encryptedConfig`
- **Encryption:** Uses `encryptionPlugin`
- **Purpose:** Stores third-party voice service credentials (Deepgram, ElevenLabs, Twilio) per tenant.
- **Used by:** `VoiceServiceFactory` (decrypts and caches), `tenant-service-instances.ts` route (CRUD), voice services (`deepgram-service.ts`, `elevenlabs-service.ts`, `twilio-service.ts`).
- **Reference count:** 13 files.
- **Verdict:** ❌ Incorrect (omission) — This is a credential-bearing model with encrypted API keys that is **not mentioned in any of the four documents**. It should be in the "Models to Simplify" list. The `VoiceServiceFactory` manually decrypts credentials via `EncryptionService.decryptForTenant()` — exactly the pattern Auth Profile aims to replace.

### 2.2 ArchWorkspaceConfig

- **File:** `packages/database/src/models/arch-workspace-config.model.ts`
- **Encrypted fields:** `encryptedApiKey`, `encryptedEndpoint`
- **Encryption:** Uses `encryptionPlugin`
- **Purpose:** Stores per-tenant Arch AI assistant LLM credentials (model, provider, API key).
- **Used by:** `arch-llm.ts`, `arch.service.ts` (8 files total).
- **Verdict:** ❌ Incorrect (omission) — Another credential-bearing model not documented. Has the same encrypted fields as `LLMCredential` (`encryptedApiKey`, `encryptedEndpoint`). Should be in "Models to Simplify" or "Models to Delete" (if Arch credentials should just reference a shared LLM Auth Profile).

### 2.3 Organization.ssoConfigs

- **File:** `packages/database/src/models/organization.model.ts`
- **Encrypted field:** `ssoConfigs[].encryptedConfig` (per SSO configuration)
- **Encryption:** Uses `encryptionPlugin`
- **Purpose:** SSO SAML/OIDC configuration secrets (certificates, client secrets).
- **Used by:** SSO routes (`apps/studio/src/app/api/sso/config/route.ts`, `sso-helpers.ts`).
- **Verdict:** ⚠️ Incomplete — While SSO config may be considered "platform auth" rather than "service auth," the design doc's stated goal is to replace "all scattered credential models." The SSO config stores encrypted secrets (SAML certificates, OIDC client secrets) and uses the same encryption plugin. The documents should explicitly state whether this is in-scope or out-of-scope and why.

### 2.4 WebhookSubscription.encryptedSecret

- **File:** `packages/database/src/models/webhook-subscription.model.ts`
- **Encrypted field:** `encryptedSecret` (HMAC secret for webhook delivery signing)
- **Encryption:** Uses `encryptionPlugin`
- **Used by:** `delivery-worker.ts` (BullMQ worker that decrypts HMAC secret for webhook signing)
- **Verdict:** ⚠️ Incomplete — Not mentioned in any document. This is a webhook HMAC signing secret, which maps directly to the Auth Profile addon mechanism `webhookVerification`. Should be documented as a candidate for Auth Profile `webhookVerification` addon.

### 2.5 WebhookSubscriptionConnector.encryptedClientState

- **File:** `packages/database/src/models/webhook-subscription-connector.model.ts`
- **Encrypted field:** `encryptedClientState` (validation secret for Microsoft Graph webhooks)
- **Verdict:** ⚠️ Incomplete — Minor, but another encrypted credential field not documented.

### 2.6 ConnectorConfig (SearchAI)

- **File:** `packages/database/src/models/connector-config.model.ts`
- **Auth-related field:** `oauthTokenId` (references `EndUserOAuthToken._id`), `connectionConfig.clientId`, `connectionConfig.scopes`
- **Verdict:** ❌ Incorrect (omission) — The `ConnectorConfig` model is entirely absent from all four documents. This is a SearchAI-specific model that stores connector authentication references and is used by multiple BullMQ workers (connector-sync-worker, connector-discovery-worker, connector-permission-crawl-worker, webhook-renewal scheduler). The `oauthTokenId` field should become `authProfileId`.

### 2.7 Contact.identities[].encryptedValue

- **File:** `packages/database/src/models/contact.model.ts`
- **Encrypted field:** `identities[].encryptedValue` (PII — encrypted identity values with blind indexes)
- **Verdict:** ✅ Correctly excluded — This is PII encryption, not service authentication. Not in scope for Auth Profile.

---

## 3. Model Simplification Claims (8 models)

### 3.1 ConnectorConnection

- **Claim:** Drop `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider`
- **Verification:** Model at `packages/database/src/models/connector-connection.model.ts`. Fields confirmed present. Note: the model does NOT use `encryptionPlugin` (explicit comment in code). Encryption is done manually in `ConnectionService`.
- **Verdict:** ✅ Verified.

### 3.2 MCPServerConfig

- **Claim:** Drop `encryptedAuthConfig`, `encryptedEnv`
- **Verification:** Model exists. Both fields present, both use `encryptionPlugin`.
- **Verdict:** ✅ Verified.

### 3.3 ChannelConnection

- **Claim:** Drop `encryptedCredentials`
- **Verification:** Model exists. Field present. Uses `encryptionPlugin` for `encryptedCredentials` plus manual encryption for `config.encryptedInboundAuthToken`.
- **⚠️ Incomplete:** The connections analysis correctly identifies two encrypted fields (`encryptedCredentials` + `config.encryptedInboundAuthToken`), but the design doc's simplification table only mentions `encryptedCredentials`. The `encryptedInboundAuthToken` (used for inbound webhook verification) should also be covered.
- **Verdict:** ⚠️ Incomplete — `config.encryptedInboundAuthToken` not in design table.

### 3.4 ServiceNode

- **Claim:** Drop `encryptedSecrets`, `authConfig`
- **Verification:** Model exists. Both fields present. Uses `encryptionPlugin` with `skipTenantScoping: true` (no `tenantId` field).
- **Verdict:** ✅ Verified. The connections analysis correctly flags the `skipTenantScoping` concern.

### 3.5 OrgProxyConfig

- **Claim:** Drop 6 encrypted fields
- **Verification:** Model exists. Confirmed 6 encrypted fields: `encryptedProxyUsername`, `encryptedProxyPassword`, `encryptedProxyToken`, `encryptedCaCertificate`, `encryptedClientCert`, `encryptedClientKey`.
- **Verdict:** ✅ Verified.

### 3.6 TenantModel.connections[].credentialId

- **Claim:** Drop `credentialId`, replace with `authProfileId`
- **Verification:** `TenantModel` model exists at `packages/database/src/models/tenant-model.model.ts`. The `connections[]` subdocument references `LLMCredential` via `credentialId`.
- **Verdict:** ✅ Verified.

### 3.7 TenantGuardrailProviderConfig.apiKeyCredentialId

- **Claim:** Drop `apiKeyCredentialId`, replace with `authProfileId`
- **Verification:** Model exists at `packages/database/src/models/guardrail-provider-config.model.ts`. Field `apiKeyCredentialId` confirmed (line 58).
- **Verdict:** ✅ Verified.

### 3.8 GitIntegration.credentials.secretId

- **Claim:** Drop `credentials.secretId`, replace with `authProfileId`
- **Verification:** Model exists at `packages/database/src/models/git-integration.model.ts`. `credentials` subdocument has `type: 'oauth' | 'token' | 'ssh_key' | 'app'` and `secretId: string`. Note: `secretId` stores an encrypted token, not a reference to another model.
- **⚠️ Note:** The `webhookSecret` field on `GitIntegration` is also a credential (used for Git webhook verification). Not mentioned.
- **Verdict:** ✅ Verified (main claim). ⚠️ Incomplete (`webhookSecret` field not mentioned).

---

## 4. Service Modification Claims

### 4.1 OAuth Services (redundancy analysis claims)

| Service                 | Claimed Path                                                                | Exists? | LOC Claim   | Notes                                                                  |
| ----------------------- | --------------------------------------------------------------------------- | ------- | ----------- | ---------------------------------------------------------------------- |
| Studio Connector OAuth  | `apps/studio/src/lib/connector-oauth.ts`                                    | ✅ Yes  | 191 LOC     | Verified                                                               |
| Tool OAuth Service      | `apps/runtime/src/services/tool-oauth-service.ts`                           | ✅ Yes  | 556 LOC     | Verified                                                               |
| Channel OAuth Service   | `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`          | ✅ Yes  | 118 LOC     | Verified                                                               |
| Channel OAuth Providers | `apps/runtime/src/services/channel-oauth/providers/`                        | ✅ Yes  | 3 providers | Plus `__tests__/` subdirectory with 3 test files (not counted in docs) |
| Connection Resolver     | `packages/connectors/src/auth/connection-resolver.ts`                       | ✅ Yes  | 259 LOC     | Verified                                                               |
| Token Manager           | `packages/connectors/base/src/auth/token-manager.ts`                        | ✅ Yes  | 215 LOC     | Verified                                                               |
| Agent Transfer OAuth2   | `packages/agent-transfer/src/adapters/auth/oauth2-client.ts`                | ✅ Yes  | 56 LOC      | Verified                                                               |
| HTTP Tool Executor      | `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | ✅ Yes  | —           | Verified                                                               |

**Verdict:** ✅ Verified — All 7+ OAuth implementations exist as claimed.

### 4.2 Credential Resolution Services

| Service                            | Claimed Path                                                                | Exists? |
| ---------------------------------- | --------------------------------------------------------------------------- | ------- |
| model-resolution.ts                | `apps/runtime/src/services/llm/model-resolution.ts`                         | ✅ Yes  |
| tenant-model-adapter.ts            | `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts`            | ✅ Yes  |
| query-model-resolver.ts            | `apps/search-ai-runtime/src/services/llm-config/query-model-resolver.ts`    | ✅ Yes  |
| embedding-credentials.ts           | `apps/search-ai/src/services/llm-config/embedding-credentials.ts`           | ✅ Yes  |
| connection-resolver.ts (connector) | `packages/connectors/src/auth/connection-resolver.ts`                       | ✅ Yes  |
| connection-resolver.ts (channel)   | `apps/runtime/src/channels/connection-resolver.ts`                          | ✅ Yes  |
| inline-mcp-provider.ts             | `apps/runtime/src/services/mcp/inline-mcp-provider.ts`                      | ✅ Yes  |
| http-tool-executor.ts              | `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | ✅ Yes  |
| secrets-provider.ts                | `apps/runtime/src/services/secrets-provider.ts`                             | ✅ Yes  |

**Verdict:** ✅ Verified — All 9 resolution paths exist.

### 4.3 Services MISSED

**❌ `VoiceServiceFactory`** — `apps/runtime/src/services/voice/voice-service-factory.ts`
Resolves `TenantServiceInstance` encrypted credentials via `EncryptionService.decryptForTenant()`. Creates and caches voice service instances per tenant. Not mentioned in any document. This is a credential resolution path that should migrate to `AuthProfileService.resolve()`.

**❌ `CredentialAgeMonitor`** — `apps/runtime/src/services/credential-age-monitor.ts`
Background service that scans LLMCredential records for age-based rotation warnings. Uses `LLMCredential` directly. Not mentioned in any document. Must be updated to scan Auth Profiles instead.

**❌ `EmbeddingProviderResolver`** — `packages/search-ai-internal/src/embedding/resolver.ts`
Resolves embedding credentials for SearchAI. References `LLMCredential` indirectly through `embedding-credentials.ts`. Not specifically called out as a service needing modification.

**❌ `tool-oauth-service-singleton.ts`** — `apps/runtime/src/services/tool-oauth-service-singleton.ts`
Singleton wrapper for ToolOAuthService. Must be updated or removed alongside the main service.

**❌ SearchAI resolver.ts** — `apps/search-ai/src/services/llm-config/resolver.ts`
An LLM config resolver that references LLMCredential. Not mentioned in the code-changes inventory.

**❌ SearchAI defaults.ts** — `apps/search-ai/src/services/llm-config/defaults.ts`
References LLMCredential for default configuration. Not mentioned.

**⚠️ `proxy-config-service.ts`** — `apps/runtime/src/services/proxy-config-service.ts`
Service layer for OrgProxyConfig. Mentioned in the OrgProxyConfig model section but not explicitly called out as a service to modify.

**⚠️ `session-field-encryption.ts`** — `packages/agent-transfer/src/security/session-field-encryption.ts`
Agent transfer session encryption. Uses `encryptForTenant`/`decryptForTenant`. Not a credential model per se, but is part of the encryption surface that Auth Profile touches.

---

## 5. Route/API Claims

### 5.1 Routes Verified

| Route                    | Path                                                                        | Exists? |
| ------------------------ | --------------------------------------------------------------------------- | ------- |
| Connector OAuth initiate | `apps/studio/src/app/api/projects/[id]/connections/oauth/initiate/route.ts` | ✅      |
| Connector OAuth callback | `apps/studio/src/app/api/projects/[id]/connections/oauth/callback/route.ts` | ✅      |
| Tool OAuth routes        | `apps/runtime/src/routes/oauth.ts`                                          | ✅      |
| Channel OAuth routes     | `apps/runtime/src/routes/channel-oauth.ts`                                  | ✅      |
| Channel connections      | `apps/runtime/src/routes/channel-connections.ts`                            | ✅      |
| Tool secrets             | `apps/runtime/src/routes/tool-secrets.ts`                                   | ✅      |
| Guardrail providers      | `apps/runtime/src/routes/guardrail-providers.ts`                            | ✅      |
| Proxy config             | `apps/runtime/src/routes/proxy-config.ts`                                   | ✅      |
| Tenant models            | `apps/runtime/src/routes/tenant-models.ts`                                  | ✅      |

### 5.2 Routes MISSED

**❌ `tenant-service-instances` route** — `apps/runtime/src/routes/tenant-service-instances.ts`
CRUD for voice service credentials (Deepgram, ElevenLabs, Twilio). Not mentioned in any document. Mount: `/api/tenants/:tenantId/service-instances`.

**❌ `platform-admin-models` route** — `apps/runtime/src/routes/platform-admin-models.ts`
Platform admin route that references `encryptForTenant`/`decryptForTenant`. Likely handles credential data for admin operations.

**❌ Studio credential routes** (partially documented):

- `apps/studio/src/app/api/credentials/route.ts` — LLM credential CRUD
- `apps/studio/src/app/api/credentials/[id]/route.ts` — individual credential ops
- `apps/studio/src/app/api/tenant-credentials/route.ts` — tenant-scoped credential CRUD
- `apps/studio/src/app/api/tenant-credentials/[id]/route.ts` — individual tenant credential ops
- `apps/studio/src/app/api/tenant-credentials/[id]/impact/route.ts` — credential impact analysis

The code-changes doc mentions `credential-repo.ts` and the credential routes but does not enumerate all 5 Studio credential route files.

**⚠️ SSO routes** — `apps/studio/src/app/api/sso/config/route.ts` and 6 other SSO route files. These handle SSO SAML/OIDC configuration with encrypted secrets. Whether in-scope depends on the scoping decision for Organization SSO configs.

**⚠️ Studio MCP server routes** — Referenced indirectly but not listed: the Studio API routes for MCP server CRUD (where `encryptedEnv` and `encryptedAuthConfig` are set).

**⚠️ `device-auth` route** — `apps/runtime/src/routes/device-auth.ts`. Potentially relevant for device OAuth flows (device authorization grant).

---

## 6. Encryption Analysis Verification

### 6.1 Encryption call site count

- **Claim:** 105 files reference encryption.
- **Verification:** grep for `encryptForTenant|decryptForTenant` returns **77 files**. Adding `encryptionPlugin`/`fieldsToEncrypt` in model files adds 16 more. The "105" figure likely includes additional patterns (OAuthEncryptor, EncryptedVault, etc.).
- **Verdict:** ⚠️ Incomplete — The 105 number is plausible but not precisely verifiable. The breakdown by pattern is directionally correct.

### 6.2 EncryptedVault

- **Claim (redundancy doc):** `EncryptedVault` at `compiler/platform/security/encrypted-vault.ts`
- **Verification:** File exists at `packages/compiler/src/platform/security/encrypted-vault.ts`. Only 3 files reference it (the file itself, its index re-export, and its test).
- **Verdict:** ✅ Verified.

---

## 7. Reuse vs Rewrite Assessment Accuracy

### 7.1 Lines of Code Impact

- **Claim:** ~2,901 lines to delete, ~740 to modify, ~2,590 to add (net -311).
- **Assessment:** The deletion estimate is likely **underestimated** given the 5 missed credential models and 6+ missed services/routes. The modification estimate is also low — the SearchAI workers alone (22 files referencing credentials) represent significant modification work not fully accounted for.
- **Verdict:** ⚠️ Incomplete — LOC estimates are directionally correct but undercount by an estimated 20-30% due to missed models and services.

### 7.2 Migration Risk Assessment

- **Claim:** LLM credentials are "low risk," connector connections are "medium risk," runtime model resolution is "high risk."
- **Assessment:** Largely correct. However, the assessment misses:
  - **Voice credentials (TenantServiceInstance):** Medium risk — voice calls are real-time and latency-sensitive. Credential resolution is on the hot path for STT/TTS.
  - **SearchAI workers:** Medium risk — sync workers run as long-lived BullMQ jobs. Mid-migration credential resolution failures would corrupt sync state.
- **Verdict:** ⚠️ Incomplete — Voice and SearchAI worker risks unmentioned.

---

## 8. Missing Risks

### 8.1 WebSocket Auth + Credential Passing

The runtime uses WebSocket connections (`apps/runtime/src/websocket/handler.ts`) for real-time agent sessions. The WebSocket handler:

- Authenticates via query parameter token (`extractUserIdFromToken`)
- Resolves tenant membership and project agents
- Eventually triggers LLM calls which resolve credentials via `model-resolution.ts`

**Risk:** WebSocket sessions are long-lived. If Auth Profile migration changes credential resolution mid-session, active sessions could fail. The design does not address how to handle in-flight WebSocket sessions during migration.

### 8.2 BullMQ Workers with Credential Resolution

Multiple BullMQ workers resolve credentials at job execution time:

1. **SearchAI connector-sync-worker** — loads `EndUserOAuthToken` and `ConnectorConfig` for OAuth-authenticated document crawling
2. **SearchAI embedding-worker** — resolves LLM credentials for embedding generation (via `EmbeddingProviderResolver`)
3. **SearchAI kg-enrichment-worker, enrichment-worker, vocabulary-generation-worker** — resolve LLM credentials for AI operations
4. **SearchAI IDP sync workers** (6 workers: okta-user, okta-group, google-user, google-group, azuread-user, azuread-group) — reference `LLMCredential` through shared imports
5. **Runtime delivery-worker** — decrypts `WebhookSubscription.encryptedSecret` for HMAC signing
6. **Runtime inbound-worker** — resolves channel credentials for inbound message processing

**Risk:** These workers run independently from the main server process. They import credential models at module level (e.g., `getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken')`). A phased migration would require dual-read support in every worker, or a synchronized cutover. None of this is addressed in the migration strategy.

### 8.3 Cross-Service Communication

- **SearchAI-Runtime** (`apps/search-ai-runtime/`) has its own `query-model-resolver.ts` that is a near-duplicate of SearchAI's `tenant-model-adapter.ts`. Both resolve `LLMCredential` independently. The documents mention this but do not address the coordination risk: these are separate deployable services that need synchronized Auth Profile migration.
- **Pipeline Engine** (`packages/pipeline-engine/`) references `LLMCredential` for eval preflight. It is a separate package used by both SearchAI and potentially other consumers.
- **Workflow Engine** (`apps/workflow-engine/`) imports `LLMCredential` in `services/database.ts`.

### 8.4 Audit Logging for Credential Access

- The codebase has `writeAuditLog` calls in credential routes (e.g., `tenant-service-instances.ts` line 26).
- `LLMCredential` model has `lastUsedAt` and `lastValidatedAt` fields for access tracking.
- The `CredentialAgeMonitor` service (`apps/runtime/src/services/credential-age-monitor.ts`) scans credentials for rotation compliance.
- The design doc's Auth Profile model includes `lastUsedAt` and `lastValidatedAt` (good), but does not mention migrating the `CredentialAgeMonitor` or ensuring audit log continuity during migration.

### 8.5 ConnectorConfig (SearchAI) — Major Omission

The `ConnectorConfig` model (`packages/database/src/models/connector-config.model.ts`) is entirely absent from all four documents. This model:

- Has `oauthTokenId` field referencing `EndUserOAuthToken._id`
- Has `connectionConfig` with `clientId` and `scopes`
- Is used by 5+ SearchAI workers and the connector service
- Is the primary model for enterprise data connector authentication (SharePoint, Jira, Confluence, HubSpot, ServiceNow, Salesforce)

This is a significant gap. When `EndUserOAuthToken` is deleted, every `ConnectorConfig.oauthTokenId` reference breaks. The migration must include a plan for this model.

### 8.6 Environment Variable Overlap

The `EnvironmentVariable` model (`packages/database/src/models/environment-variable.model.ts`) is correctly listed as "untouched" in the design, but the note says "secret env vars storing credentials should migrate." The documents do not provide a heuristic for identifying which environment variables are actually credentials vs. config. The `secrets-provider.ts` falls back to environment variables when no `ToolSecret` is found — this fallback chain needs to be re-evaluated.

### 8.7 SDK Channel HMAC Secrets

The `SDKChannel` model has a `secretKey` field (encrypted HMAC secret for identity verification) and `hmacEnforcement` mode. Not mentioned in any document. This is analogous to webhook verification and could map to Auth Profile's `webhookVerification` addon.

### 8.8 Race Condition in Token Refresh Migration

The redundancy analysis correctly identifies that only one of three token refresh implementations uses distributed locking (Connection Resolver). The design proposes unified refresh with distributed lock support. **Risk:** During migration, if the old (unlocked) refresh and new (locked) refresh coexist, concurrent refresh attempts could produce inconsistent token states. The migration strategy does not address this race window.

---

## 9. Summary Score

| Category               | Verified | Incomplete | Incorrect (Omission) |
| ---------------------- | -------- | ---------- | -------------------- |
| Models to Delete (3)   | 3        | 0          | 0                    |
| Models to Simplify (8) | 6        | 2          | 0                    |
| Models Missed          | —        | 3          | 3                    |
| Services (21 claimed)  | 21       | 0          | 0                    |
| Services Missed        | —        | 2          | 5                    |
| Routes                 | 9+       | 3          | 2                    |
| Encryption Analysis    | 2        | 1          | 0                    |
| Migration Risk         | 3        | 2          | 0                    |

**Overall assessment:** The documents are **directionally correct** and demonstrate strong understanding of the core credential systems. The OAuth redundancy analysis is particularly thorough. However, **6 credential-bearing models are entirely missing** from the analysis (TenantServiceInstance, ArchWorkspaceConfig, ConnectorConfig, WebhookSubscription, WebhookSubscriptionConnector, SDKChannel), and **5+ services/routes** that interact with credentials are not documented. The BullMQ worker credential resolution surface is significantly underestimated.

**Recommended action before implementation:**

1. Add the 6 missed models to the inventory with clear in-scope/out-of-scope decisions
2. Document the BullMQ worker migration strategy (22+ workers reference credentials)
3. Add a WebSocket session continuity plan for the migration window
4. Address the ConnectorConfig.oauthTokenId gap explicitly — this is a hard dependency on EndUserOAuthToken deletion
5. Clarify scope boundaries: Organization SSO, EnvironmentVariable secrets, SDK Channel HMAC secrets
