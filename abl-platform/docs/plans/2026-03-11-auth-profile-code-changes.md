# Auth Profile — Existing Code Change Inventory

**Date:** 2026-03-11
**Companion to:** `docs/plans/2026-03-11-auth-profile-design.md`

---

## Table of Contents

1. [Models to DELETE (3)](#1-models-to-delete-3)
2. [Models to SIMPLIFY (8+)](#2-models-to-simplify-8)
3. [Services to MODIFY](#3-services-to-modify)
4. [Routes/API Endpoints to MODIFY](#4-routesapi-endpoints-to-modify)
5. [Shared Type Definitions to MODIFY](#5-shared-type-definitions-to-modify)
6. [Test Files to MODIFY/DELETE](#6-test-files-to-modifydelete)
7. [Database Schema Changes](#7-database-schema-changes)
8. [Reuse vs Rewrite Assessment](#8-reuse-vs-rewrite-assessment)
9. [Completely New Code](#9-completely-new-code)
10. [Migration Script Requirements](#10-migration-script-requirements)

---

## 1. Models to DELETE (3)

### 1.1 `LLMCredential`

**Model file:** `packages/database/src/models/llm-credential.model.ts`
**Collection:** `llm_credentials`
**Fields:** `credentialScope`, `ownerId`, `tenantId`, `provider`, `name`, `encryptedApiKey`, `encryptedEndpoint`, `customHeaders`, `authType`, `authConfig`, `isActive`, `isDefault`, `lastUsedAt`, `lastValidatedAt`
**Encryption plugin:** `fieldsToEncrypt: ['encryptedApiKey', 'encryptedEndpoint']`

| File Path                                                                           | Current Usage                                                                                                                             | Required Change                                                                       | Effort |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/llm-credential.model.ts`                              | Model definition (85 LOC)                                                                                                                 | DELETE file                                                                           | S      |
| `packages/database/src/models/index.ts`                                             | Export `LLMCredential`, `ILLMCredential` (line 241)                                                                                       | Remove export                                                                         | S      |
| `packages/database/src/index.ts`                                                    | Export `LLMCredential`, `ILLMCredential` (lines 90-91)                                                                                    | Remove export                                                                         | S      |
| `packages/database/src/cascade/cascade-delete.ts`                                   | Imports `LLMCredential` for tenant cascade delete                                                                                         | Replace with `AuthProfile` query (category='llm')                                     | S      |
| `packages/database/src/__tests__/encryption-e2e.test.ts`                            | Tests `LLMCredential` encryption roundtrip                                                                                                | Rewrite to test `AuthProfile` encryption                                              | M      |
| `packages/database/src/__tests__/mongo-cascade.test.ts`                             | Tests cascade delete of credentials                                                                                                       | Update to `AuthProfile`                                                               | S      |
| `packages/database/src/__tests__/model-billing.test.ts`                             | References `LLMCredential` in test fixtures                                                                                               | Update references                                                                     | S      |
| `packages/database/seed-mongo.ts`                                                   | Seeds demo LLM credentials                                                                                                                | Rewrite to seed `AuthProfile` with `authType: api_key`                                | S      |
| `scripts/seed-tenant.ts`                                                            | Seeds tenant with credentials                                                                                                             | Rewrite to create `AuthProfile`                                                       | S      |
| `apps/studio/src/repos/credential-repo.ts`                                          | Full CRUD repo for `LLMCredential` (~100 LOC)                                                                                             | REWRITE as `AuthProfile` repo (filter by `category: 'llm'`)                           | L      |
| `apps/studio/src/app/api/credentials/route.ts`                                      | User-scoped LLM credential CRUD                                                                                                           | REWRITE to use `AuthProfile` service                                                  | M      |
| `apps/studio/src/app/api/credentials/[id]/route.ts`                                 | GET/PATCH/DELETE user credential by ID                                                                                                    | REWRITE to use `AuthProfile` service                                                  | M      |
| `apps/studio/src/app/api/tenant-credentials/route.ts`                               | Tenant-scoped LLM credential CRUD                                                                                                         | REWRITE to use `AuthProfile` service                                                  | M      |
| `apps/studio/src/app/api/tenant-credentials/[id]/route.ts`                          | GET/PATCH/DELETE tenant credential                                                                                                        | REWRITE to use `AuthProfile` service                                                  | M      |
| `apps/studio/src/app/api/tenant-credentials/[id]/impact/route.ts`                   | Impact analysis before deletion                                                                                                           | REWRITE to query `AuthProfile` consumers                                              | M      |
| `apps/studio/src/app/api/models/route.ts`                                           | References `credentialId` when creating models                                                                                            | Replace `credentialId` with `authProfileId`                                           | S      |
| `apps/studio/src/app/api/models/[id]/route.ts`                                      | References `credentialId` on model update                                                                                                 | Replace `credentialId` with `authProfileId`                                           | S      |
| `apps/studio/src/components/admin/AddConnectionDialog.tsx`                          | UI for linking credential to model                                                                                                        | Rewrite to select `AuthProfile`                                                       | M      |
| `apps/studio/src/components/admin/ModelsPage.tsx`                                   | Displays credential info on models                                                                                                        | Update to show `AuthProfile` name/status                                              | M      |
| `apps/studio/src/__tests__/model-management.test.tsx`                               | Tests model+credential management UI                                                                                                      | Rewrite fixture data                                                                  | M      |
| `apps/studio/src/__tests__/lib-arch.test.ts`                                        | References `LLMCredential` in tests                                                                                                       | Update references                                                                     | S      |
| `apps/studio/src/lib/arch-llm.ts`                                                   | References credential for Arch AI LLM calls                                                                                               | Update to use `AuthProfile`                                                           | S      |
| `apps/runtime/src/repos/llm-resolution-repo.ts`                                     | `findDefaultUserCredential`, `findDefaultTenantCredential`, `findCredentialById` — all query `LLMCredential` directly                     | REWRITE to query `AuthProfile` via `authProfileService.resolve()`                     | L      |
| `apps/runtime/src/repos/tenant-model-repo.ts`                                       | Model connection CRUD references `credentialId`                                                                                           | Replace `credentialId` references with `authProfileId`                                | M      |
| `apps/runtime/src/routes/tenant-models.ts`                                          | Tenant model CRUD, encrypts/decrypts credentials via `credentialId` lookup                                                                | Replace credential resolution with `AuthProfile` lookup                               | M      |
| `apps/runtime/src/services/llm/model-resolution.ts`                                 | 5-level resolution chain; Level 4 resolves `credentialId` from `TenantModel.connections[].credentialId` then decrypts via `LLMCredential` | REWRITE credential resolution to use `authProfileId` + `AuthProfileService.resolve()` | L      |
| `apps/runtime/src/services/credential-age-monitor.ts`                               | Monitors `LLMCredential` age for rotation alerts                                                                                          | Replace `LLMCredential` queries with `AuthProfile` queries                            | M      |
| `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts`                | Tests credential age monitor                                                                                                              | Update to mock `AuthProfile`                                                          | M      |
| `apps/runtime/src/__tests__/tenant-model-routes.test.ts`                            | Tests tenant model CRUD with credential IDs                                                                                               | Update test data to use `authProfileId`                                               | M      |
| `apps/runtime/src/__tests__/repos-data.test.ts`                                     | Tests repo functions with credential data                                                                                                 | Update fixture data                                                                   | M      |
| `apps/runtime/src/routes/__tests__/platform-admin-models.test.ts`                   | Tests platform admin model routes                                                                                                         | Update credential references                                                          | S      |
| `apps/search-ai/src/db/index.ts`                                                    | Imports/registers `LLMCredential` model                                                                                                   | Remove import                                                                         | S      |
| `apps/search-ai/src/services/llm-config/resolver.ts`                                | Resolves `apiKey` from `LLMCredential`                                                                                                    | REWRITE to use `AuthProfile` resolution                                               | L      |
| `apps/search-ai/src/services/llm-config/embedding-credentials.ts`                   | Resolves embedding API keys from `LLMCredential`                                                                                          | REWRITE to use `AuthProfile`                                                          | M      |
| `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts`                    | Reads `TenantModel.connections[].credentialId` then fetches `LLMCredential`                                                               | Replace with `authProfileId` resolution                                               | M      |
| `apps/search-ai/src/services/llm-config/__tests__/embedding-credentials.test.ts`    | Tests embedding credential resolution                                                                                                     | Rewrite mocks                                                                         | M      |
| `apps/search-ai/src/services/llm-config/__tests__/resolver.test.ts`                 | Tests LLM resolver with credential mocks                                                                                                  | Rewrite mocks                                                                         | M      |
| `apps/search-ai/src/__tests__/llm-config-api.test.ts`                               | Integration test for LLM config                                                                                                           | Update credential fixtures                                                            | M      |
| `apps/search-ai/src/__tests__/per-index-config-integration.test.ts`                 | Per-index config test with credentials                                                                                                    | Update fixtures                                                                       | S      |
| `apps/search-ai/src/workers/shared.ts`                                              | Shared worker utilities reference `LLMCredential`                                                                                         | Update import                                                                         | S      |
| `apps/search-ai-runtime/src/services/llm-config/query-model-resolver.ts`            | Resolves model credentials at query time                                                                                                  | REWRITE to use `AuthProfile`                                                          | M      |
| `apps/search-ai-runtime/src/routes/query.ts`                                        | Query route uses resolved credentials                                                                                                     | Update to pass `authProfileId`                                                        | S      |
| `apps/search-ai-runtime/src/routes/idp-sync.ts`                                     | IdP sync uses credentials                                                                                                                 | Update credential references                                                          | S      |
| `apps/search-ai/src/services/custom-domain-generator.service.ts`                    | Uses credentials for external calls                                                                                                       | Update to `AuthProfile`                                                               | S      |
| `apps/search-ai/src/services/org-profile-generator.service.ts`                      | Uses credentials for LLM calls                                                                                                            | Update to `AuthProfile`                                                               | S      |
| `apps/search-ai/src/services/structured-data/text-to-sql.ts`                        | Uses credentials for LLM calls                                                                                                            | Update to `AuthProfile`                                                               | S      |
| `apps/search-ai/src/__tests__/structured-data/*.test.ts` (2 files)                  | Tests with credential mocks                                                                                                               | Update mocks                                                                          | S      |
| `apps/search-ai/src/workers/idp-sync-scheduler.ts`                                  | Uses credentials for IdP calls                                                                                                            | Update to `AuthProfile`                                                               | S      |
| `apps/search-ai/src/workers/okta-*.ts` (3 files)                                    | Okta sync workers use credentials                                                                                                         | Update to `AuthProfile`                                                               | M      |
| `apps/search-ai/src/workers/google-*.ts` (2 files)                                  | Google sync workers use credentials                                                                                                       | Update to `AuthProfile`                                                               | M      |
| `apps/search-ai/src/workers/azuread-*.ts` (2 files)                                 | Azure AD sync workers use credentials                                                                                                     | Update to `AuthProfile`                                                               | M      |
| `apps/search-ai/src/db/dual-connection.ts`                                          | Dual-database support references `LLMCredential`                                                                                          | Update import                                                                         | S      |
| `apps/workflow-engine/src/services/database.ts`                                     | Imports `LLMCredential` for database init                                                                                                 | Remove import                                                                         | S      |
| `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts`              | Creates LLM clients using `LLMCredential`                                                                                                 | Update to use `AuthProfile`                                                           | M      |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts`             | Preflight checks credential existence                                                                                                     | Update to check `AuthProfile`                                                         | S      |
| `packages/pipeline-engine/src/pipeline/server.ts`                                   | Imports `LLMCredential` for pipeline server                                                                                               | Update import                                                                         | S      |
| `packages/database/src/migrations/scripts/20260219_001_unified_credential_store.ts` | Migration for credential unification                                                                                                      | Keep as-is (historical); add new migration for `AuthProfile`                          | S      |

**Total files referencing `LLMCredential`: 65+ (excluding docs)**

---

### 1.2 `EndUserOAuthToken`

**Model file:** `packages/database/src/models/end-user-oauth-token.model.ts`
**Collection:** `end_user_oauth_tokens`
**Fields:** `tenantId`, `userId`, `provider`, `providerUserId`, `encryptedAccessToken`, `encryptedRefreshToken`, `scope`, `expiresAt`, `refreshedAt`, `consentedAt`, `revokedAt`, `lastUsedAt`
**Encryption plugin:** `fieldsToEncrypt: ['encryptedAccessToken', 'encryptedRefreshToken']`

| File Path                                                                | Current Usage                                                                                                                          | Required Change                                                                              | Effort |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/end-user-oauth-token.model.ts`             | Model definition (77 LOC)                                                                                                              | DELETE file                                                                                  | S      |
| `packages/database/src/models/index.ts`                                  | Export (line 276)                                                                                                                      | Remove export                                                                                | S      |
| `packages/database/src/index.ts`                                         | Export (lines 157-158)                                                                                                                 | Remove export                                                                                | S      |
| `packages/database/src/models/connector-config.model.ts`                 | `oauthTokenId: string` references `EndUserOAuthToken._id`                                                                              | Replace with `authProfileId`                                                                 | S      |
| `packages/database/src/__tests__/model-security.test.ts`                 | Tests `EndUserOAuthToken` model                                                                                                        | Rewrite for `AuthProfile` with `authType: oauth2_token`                                      | M      |
| `packages/shared/src/types/security.ts`                                  | Re-exports `NormalizedEndUserOAuthToken`                                                                                               | Remove re-export                                                                             | S      |
| `packages/shared-kernel/src/types/security.ts`                           | Defines `NormalizedEndUserOAuthToken` interface                                                                                        | Remove interface                                                                             | S      |
| `packages/shared-kernel/src/index.ts`                                    | Exports security types                                                                                                                 | Remove `NormalizedEndUserOAuthToken` export                                                  | S      |
| `packages/shared/src/index.ts`                                           | Exports security types                                                                                                                 | Remove `NormalizedEndUserOAuthToken` re-export                                               | S      |
| `packages/shared/src/repos/security-repo.ts`                             | `findEndUserOAuthTokens`, `countEndUserOAuthTokens`, `createEndUserOAuthToken`, `revokeEndUserOAuthToken`, `findEndUserOAuthTokenById` | REWRITE to query `AuthProfile` where `authType: 'oauth2_token'` and `visibility: 'personal'` | L      |
| `packages/shared/src/repos/index.ts`                                     | Exports OAuth token repo functions                                                                                                     | Update exports                                                                               | S      |
| `packages/shared/src/__tests__/security-repo.test.ts`                    | Tests OAuth token repo                                                                                                                 | Rewrite for `AuthProfile`                                                                    | M      |
| `packages/connectors/base/src/auth/token-manager.ts`                     | `TokenManager` class manages OAuth lifecycle via `Model<IEndUserOAuthToken>`                                                           | REWRITE to use `AuthProfile` service                                                         | L      |
| `packages/connectors/base/src/__tests__/token-manager.test.ts.skip`      | Tests for TokenManager                                                                                                                 | Rewrite for new auth model                                                                   | M      |
| `packages/connectors/sharepoint/src/sharepoint-connector.ts`             | Uses `EndUserOAuthToken` for SharePoint auth                                                                                           | Replace with `AuthProfile` resolution                                                        | M      |
| `apps/runtime/src/server.ts`                                             | Imports/registers `EndUserOAuthToken` model at startup                                                                                 | Remove import                                                                                | S      |
| `apps/runtime/src/routes/oauth.ts`                                       | Full OAuth flow: initiate, callback, list, revoke — all targeting `EndUserOAuthToken`                                                  | REWRITE to create/manage `AuthProfile` with `authType: oauth2_token`                         | L      |
| `apps/runtime/src/__tests__/oauth-authz.test.ts`                         | Authz tests for OAuth routes                                                                                                           | Rewrite for new route shape                                                                  | M      |
| `apps/runtime/src/repos/security-repo.ts`                                | Duplicated security repo for runtime                                                                                                   | Remove `EndUserOAuthToken` functions                                                         | S      |
| `apps/runtime/src/__tests__/repos-data.test.ts`                          | Tests repo data with OAuth tokens                                                                                                      | Update fixtures                                                                              | S      |
| `apps/runtime/src/services/tool-oauth-service.ts`                        | `ToolOAuthService` stores/retrieves OAuth tokens via `OAuthTokenStore`                                                                 | REWRITE store interface to use `AuthProfile`                                                 | L      |
| `apps/runtime/src/__tests__/tool-oauth-service.test.ts`                  | Tests tool OAuth service                                                                                                               | Rewrite mocks                                                                                | M      |
| `apps/runtime/src/services/secrets-provider.ts`                          | `OAuthTokenResolver` interface resolves access tokens                                                                                  | Rewrite to use `AuthProfile` resolution                                                      | M      |
| `apps/runtime/src/__tests__/secrets-provider.test.ts`                    | Tests secrets provider OAuth resolution                                                                                                | Update mocks                                                                                 | M      |
| `apps/search-ai/src/db/index.ts`                                         | Imports `EndUserOAuthToken` model                                                                                                      | Remove import                                                                                | S      |
| `apps/search-ai/src/repos/connector.repository.ts`                       | Queries `EndUserOAuthToken` for connector auth                                                                                         | Replace with `AuthProfile` query                                                             | M      |
| `apps/search-ai/src/workers/connector-sync-worker.ts`                    | Uses OAuth token for sync operations                                                                                                   | Update to `AuthProfile`                                                                      | M      |
| `apps/search-ai/src/workers/connector-discovery-worker.ts`               | Uses OAuth token for discovery                                                                                                         | Update to `AuthProfile`                                                                      | M      |
| `apps/search-ai/src/workers/connector-permission-crawl-worker.ts`        | Uses OAuth token for permission crawl                                                                                                  | Update to `AuthProfile`                                                                      | M      |
| `apps/search-ai/src/__tests__/connector-sync-worker.test.ts`             | Tests sync worker with OAuth mocks                                                                                                     | Update mocks                                                                                 | M      |
| `apps/search-ai/src/__tests__/connector-permission-crawl-worker.test.ts` | Tests permission crawl                                                                                                                 | Update mocks                                                                                 | M      |
| `apps/search-ai/src/__tests__/routes/connectors-auth.test.ts`            | Tests connector auth routes                                                                                                            | Update for `AuthProfile`                                                                     | M      |
| `apps/search-ai/src/__tests__/routes/connectors-sync.test.ts`            | Tests connector sync routes                                                                                                            | Update fixtures                                                                              | S      |
| `apps/search-ai/src/scheduler/webhook-renewal.ts`                        | Renews OAuth tokens for webhook subscriptions                                                                                          | REWRITE to use `AuthProfile` token refresh                                                   | M      |

**Total files referencing `EndUserOAuthToken`: 35+ (excluding docs)**

---

### 1.3 `ToolSecret`

**Model file:** `packages/database/src/models/tool-secret.model.ts`
**Collection:** `tool_secrets`
**Fields:** `tenantId`, `projectId`, `toolName`, `secretKey`, `encryptedValue`, `environment`, `version`, `expiresAt`, `rotatedAt`, `createdBy`
**Encryption plugin:** `fieldsToEncrypt: ['encryptedValue']`

| File Path                                                            | Current Usage                                                                                                                                       | Required Change                                                                  | Effort |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/tool-secret.model.ts`                  | Model definition (72 LOC)                                                                                                                           | DELETE file                                                                      | S      |
| `packages/database/src/models/index.ts`                              | Export (line 275)                                                                                                                                   | Remove export                                                                    | S      |
| `packages/database/src/__tests__/encryption-e2e.test.ts`             | Tests `ToolSecret` encryption                                                                                                                       | Update to `AuthProfile`                                                          | S      |
| `packages/database/src/__tests__/model-security.test.ts`             | Tests `ToolSecret` model                                                                                                                            | Rewrite for `AuthProfile`                                                        | M      |
| `packages/shared-kernel/src/types/security.ts`                       | Defines `NormalizedToolSecret` interface                                                                                                            | Remove interface                                                                 | S      |
| `packages/shared-kernel/src/index.ts`                                | Exports `NormalizedToolSecret`                                                                                                                      | Remove export                                                                    | S      |
| `packages/shared/src/types/security.ts`                              | Re-exports `NormalizedToolSecret`                                                                                                                   | Remove re-export                                                                 | S      |
| `packages/shared/src/index.ts`                                       | Exports tool secret types/repos                                                                                                                     | Remove tool secret exports                                                       | S      |
| `packages/shared/src/repos/security-repo.ts`                         | Full CRUD for `ToolSecret`: `createToolSecret`, `findToolSecrets`, `countToolSecrets`, `findToolSecretById`, `updateToolSecret`, `deleteToolSecret` | REWRITE to `AuthProfile` queries (or DELETE if all secrets become `AuthProfile`) | L      |
| `packages/shared/src/repos/index.ts`                                 | Exports tool secret repo functions                                                                                                                  | Update exports                                                                   | S      |
| `packages/shared/src/__tests__/security-repo.test.ts`                | Tests tool secret repo                                                                                                                              | Rewrite                                                                          | M      |
| `packages/shared/src/validation/tool-secret-schemas.ts`              | Zod schemas for tool secret API                                                                                                                     | DELETE or rewrite for `AuthProfile`                                              | S      |
| `packages/shared/src/validation/index.ts`                            | Exports tool secret schemas                                                                                                                         | Update exports                                                                   | S      |
| `apps/runtime/src/repos/security-repo.ts`                            | Duplicated tool secret CRUD                                                                                                                         | Remove tool secret functions                                                     | M      |
| `apps/runtime/src/routes/tool-secrets.ts`                            | Full CRUD route: create, list, rotate, delete (~200 LOC)                                                                                            | DELETE route entirely; replaced by `/api/auth-profiles`                          | L      |
| `apps/runtime/src/__tests__/tool-secrets-authz.test.ts`              | Authz tests for tool secret routes                                                                                                                  | DELETE                                                                           | S      |
| `apps/runtime/src/__tests__/repos-data.test.ts`                      | Tool secret test data                                                                                                                               | Remove fixtures                                                                  | S      |
| `apps/runtime/src/services/secrets-provider.ts`                      | `ToolSecretStore` interface + `RuntimeSecretsProvider` resolves tool secrets from DB                                                                | REWRITE to use `AuthProfile` with `auth: "profile-name"` DSL resolution          | L      |
| `apps/runtime/src/__tests__/secrets-provider.test.ts`                | Tests secrets provider with tool secret mocks                                                                                                       | Rewrite                                                                          | M      |
| `apps/runtime/src/services/execution/llm-wiring.ts`                  | Wires `ToolSecretStore` and `SecretDecryptor`                                                                                                       | Rewire to `AuthProfile` resolution                                               | M      |
| `apps/runtime/src/__tests__/llm-wiring.test.ts`                      | Tests LLM wiring with tool secrets                                                                                                                  | Update mocks                                                                     | M      |
| `apps/runtime/src/services/credential-age-monitor.ts`                | Monitors `ToolSecret` age                                                                                                                           | Replace with `AuthProfile` query                                                 | S      |
| `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts` | Tests age monitor for tool secrets                                                                                                                  | Update                                                                           | S      |
| `apps/studio/src/services/tool-test-service.ts`                      | Resolves tool secrets for testing tools in Studio                                                                                                   | Replace with `AuthProfile` lookup                                                | M      |
| `apps/studio/src/__tests__/tool-test-service.test.ts`                | Tests tool test service                                                                                                                             | Update mocks                                                                     | M      |
| `apps/studio/src/components/admin/SecretsPage.tsx`                   | Full UI for tool secret management (~500 LOC)                                                                                                       | REWRITE as `AuthProfilesPage`                                                    | L      |
| `scripts/kms-encryption-roundtrip.ts`                                | Tests encryption with `ToolSecret`                                                                                                                  | Update to `AuthProfile`                                                          | S      |

**Total files referencing `ToolSecret`: 30+ (excluding docs)**

---

## 2. Models to SIMPLIFY (8+)

### 2.1 `ConnectorConnection`

**File:** `packages/database/src/models/connector-connection.model.ts`

**Fields to DROP:**

- `encryptedCredentials` (line 25, schema line 52) — blob of all connector auth data
- `encryptionKeyVersion` (line 26, schema line 53)
- `oauth2TokenExpiresAt` (line 28, schema line 59)
- `oauth2RefreshToken` (line 29, schema line 60)
- `oauth2Provider` (line 30, schema line 61)
- `authType` enum field (line 24, schema line 47-51) — auth type moves to `AuthProfile`

**Field to ADD:** `authProfileId: string`

| File Path                                                                   | Current State                                                                     | Required Change                                                                  | Effort |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/connector-connection.model.ts`                | Model with 6 inline credential fields                                             | Remove 6 fields, add `authProfileId`                                             | M      |
| `packages/connectors/src/auth/connection-resolver.ts`                       | `ConnectionResolver` class decrypts `encryptedCredentials`, handles OAuth refresh | REWRITE to resolve via `AuthProfile`; move refresh logic to `AuthProfileService` | L      |
| `packages/connectors/src/__tests__/connection-resolver.test.ts`             | Tests connection resolution with encrypted data                                   | Rewrite for `AuthProfile`                                                        | M      |
| `packages/connectors/src/services/connection-service.ts`                    | `ConnectionService` CRUD with encrypt/decrypt callbacks                           | Simplify: remove encrypt/decrypt, store `authProfileId`                          | L      |
| `packages/connectors/src/__tests__/connection-service.test.ts`              | Tests connection service                                                          | Rewrite for simplified model                                                     | M      |
| `packages/connectors/src/__tests__/connector-tool-executor.test.ts`         | Tests tool execution with connections                                             | Update credential resolution mocks                                               | M      |
| `apps/studio/src/lib/connection-service.ts`                                 | Studio singleton wiring encrypt/decrypt to `ConnectionService`                    | Simplify: remove encryption wiring                                               | M      |
| `apps/studio/src/app/api/projects/[id]/connections/oauth/initiate/route.ts` | Initiates connector OAuth flow                                                    | REWRITE to create `AuthProfile` with `authType: oauth2_token`                    | M      |
| `apps/studio/src/app/api/projects/[id]/connections/oauth/callback/route.ts` | OAuth callback creates `ConnectorConnection` with encrypted tokens                | REWRITE to create `AuthProfile`, link via `authProfileId`                        | M      |
| `packages/project-io/src/export/layer-assemblers/connections-assembler.ts`  | Exports `ConnectorConnection` with `encryptedCredentials`                         | Update export shape: export `authProfileId` ref                                  | M      |
| `packages/project-io/src/__tests__/connections-assembler.test.ts`           | Tests connection export                                                           | Update test data                                                                 | M      |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`               | Import applies connection data                                                    | Update to handle `authProfileId`                                                 | S      |
| `apps/studio/src/app/api/projects/[id]/import/doctor/route.ts`              | Import doctor checks connections                                                  | Update checks for `authProfileId`                                                | S      |
| `apps/workflow-engine/src/index.ts`                                         | Imports `ConnectorConnection` for workflow wiring                                 | Update to use simplified model                                                   | S      |
| `apps/workflow-engine/src/__tests__/connections-routes.test.ts`             | Tests workflow engine connections                                                 | Update fixtures                                                                  | M      |
| `apps/workflow-engine/src/__tests__/graceful-shutdown.test.ts`              | References connection model                                                       | Update import                                                                    | S      |
| `apps/workflow-engine/src/__tests__/index-wiring.test.ts`                   | Tests index wiring with connections                                               | Update                                                                           | S      |
| `packages/database/src/__tests__/model-connector-connection.test.ts`        | Tests connector connection model                                                  | Rewrite for simplified schema                                                    | M      |

### 2.2 `MCPServerConfig`

**File:** `packages/database/src/models/mcp-server-config.model.ts`

**Fields to DROP:**

- `encryptedEnv` (line 24, schema line 56) — encrypted env vars blob
- `encryptedAuthConfig` (line 26, schema line 62) — encrypted auth config blob
- `authType` enum (line 25, schema line 57-60) — auth type moves to `AuthProfile`

**Field to ADD:** `authProfileId: string | null`

| File Path                                                               | Current State                                                | Required Change                             | Effort |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- | ------ |
| `packages/database/src/models/mcp-server-config.model.ts`               | Model with `encryptedEnv`, `encryptedAuthConfig`, `authType` | Remove 3 fields, add `authProfileId`        | M      |
| `packages/shared/src/repos/mcp-server-config-repo.ts`                   | CRUD with encrypted auth fields                              | Simplify: remove encrypt/decrypt for auth   | M      |
| `packages/shared/src/__tests__/mcp-server-config-repo.test.ts`          | Tests MCP config CRUD                                        | Update fixtures                             | M      |
| `packages/shared/src/services/mcp-server-registry.ts`                   | Registry decrypts `encryptedAuthConfig`                      | Resolve auth via `AuthProfile`              | M      |
| `packages/shared/src/__tests__/mcp-server-registry.test.ts`             | Tests registry with encrypted configs                        | Update mocks                                | M      |
| `packages/shared/src/tools/resolve-tool-implementations.ts`             | Resolves MCP tool implementations                            | Update auth resolution                      | S      |
| `packages/shared/src/tools/dsl-property-parser.ts`                      | Parses DSL tool properties including `encryptedCredentials`  | Update to parse `authProfileId`             | S      |
| `packages/shared/src/__tests__/dsl-property-parser.test.ts`             | Tests DSL property parsing                                   | Update test data                            | S      |
| `packages/shared/src/types/mcp-server.ts`                               | Type definitions for MCP servers                             | Remove encrypted auth fields                | S      |
| `packages/compiler/src/platform/mcp/server-manager.ts`                  | Manages MCP servers with auth config                         | Update to use `AuthProfile`                 | M      |
| `packages/compiler/src/__tests__/mcp-client.test.ts`                    | Tests MCP client                                             | Update auth mocks                           | S      |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/route.ts`            | MCP server CRUD route                                        | Remove auth encryption, use `authProfileId` | M      |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts` | MCP server detail route                                      | Remove auth encryption, use `authProfileId` | M      |
| `apps/studio/src/__tests__/api-mcp-routes.test.ts`                      | Tests MCP routes                                             | Update fixtures                             | M      |
| `apps/studio/src/lib/mcp-server-response.ts`                            | Response normalization                                       | Remove encrypted field handling             | S      |
| `apps/studio/src/__tests__/mcp-server-response.test.ts`                 | Tests response normalization                                 | Update                                      | S      |
| `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`                 | Runtime MCP provider decrypts auth                           | Resolve via `AuthProfile`                   | M      |
| `apps/runtime/src/__tests__/mcp-server-registry.test.ts`                | Tests MCP server registry                                    | Update mocks                                | M      |
| `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`                | Tests inline MCP provider                                    | Update                                      | S      |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts`     | Exports MCP configs with encrypted auth                      | Update export shape                         | M      |
| `packages/project-io/src/__tests__/core-assembler.test.ts`              | Tests core assembler                                         | Update fixtures                             | M      |
| `apps/studio/src/services/export-job-processor.ts`                      | Processes MCP config export                                  | Update for new shape                        | S      |
| `apps/studio/src/__tests__/api-export-routes.test.ts`                   | Tests export routes                                          | Update fixtures                             | S      |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`                 | Export route handler                                         | Update MCP export                           | S      |

### 2.3 `ChannelConnection`

**File:** `packages/database/src/models/channel-connection.model.ts`

**Fields to DROP:**

- `encryptedCredentials` (line 50, schema line 72)

**Field to ADD:** `authProfileId: string | null`

| File Path                                                               | Current State                                                     | Required Change                                                   | Effort |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ------ |
| `packages/database/src/models/channel-connection.model.ts`              | Model with `encryptedCredentials` field + encryption plugin       | Remove `encryptedCredentials`, add `authProfileId`, update plugin | M      |
| `apps/runtime/src/channels/connection-resolver.ts`                      | `resolveChannelConnection()` decrypts `encryptedCredentials`      | REWRITE to resolve via `AuthProfile`                              | M      |
| `apps/runtime/src/routes/channel-connections.ts`                        | CRUD route encrypts/decrypts credentials inline                   | Remove encryption logic, use `authProfileId`                      | L      |
| `apps/runtime/src/routes/channel-oauth.ts`                              | Channel OAuth flow stores encrypted tokens in `ChannelConnection` | REWRITE to create `AuthProfile` + link via `authProfileId`        | L      |
| `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`      | Generic OAuth flow for channels                                   | Update to create `AuthProfile` instead of storing inline tokens   | M      |
| `apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts`     | Provider interface returns `credentials: Record<string, string>`  | Update to return data for `AuthProfile` creation                  | S      |
| `apps/runtime/src/__tests__/channel-connections-authz.test.ts`          | Authz tests                                                       | Update credential fixtures                                        | M      |
| `apps/runtime/src/__tests__/webhooks/channel-webhooks-route.test.ts`    | Webhook route tests                                               | Update                                                            | S      |
| `apps/runtime/src/__tests__/webhooks/*.test.ts` (4 more files)          | Various webhook tests                                             | Update channel credential resolution                              | M      |
| `apps/runtime/src/__tests__/http-async-channel-authz.test.ts`           | HTTP async channel tests                                          | Update                                                            | S      |
| `apps/runtime/src/__tests__/cross-tenant-isolation.test.ts`             | Cross-tenant tests with channels                                  | Update                                                            | S      |
| `apps/runtime/src/__tests__/slack-*.test.ts` (2 files)                  | Slack channel tests                                               | Update credential handling                                        | M      |
| `apps/runtime/src/__tests__/email-smtp-server.test.ts`                  | Email SMTP tests                                                  | Update                                                            | S      |
| `apps/runtime/src/services/email/smtp-server.ts`                        | SMTP server decrypts channel credentials                          | Update to `AuthProfile`                                           | M      |
| `apps/runtime/src/channels/adapters/msteams-adapter.ts`                 | MS Teams adapter uses decrypted creds                             | Update to `AuthProfile`                                           | M      |
| `apps/runtime/src/channels/adapters/korevg-adapter.ts`                  | KoreVG adapter                                                    | Update credential resolution                                      | S      |
| `apps/runtime/src/channels/adapters/vxml-adapter.ts`                    | VXML adapter                                                      | Update credential resolution                                      | S      |
| `apps/runtime/src/routes/channel-genesys.ts`                            | Genesys route                                                     | Update credential handling                                        | S      |
| `apps/runtime/src/routes/channel-audiocodes.ts`                         | AudioCodes route                                                  | Update credential handling                                        | S      |
| `apps/runtime/src/routes/channel-vxml.ts`                               | VXML route                                                        | Update credential handling                                        | S      |
| `apps/runtime/src/routes/http-async-channel.ts`                         | HTTP async channel route                                          | Update credential handling                                        | S      |
| `apps/runtime/src/services/voice/korevg/korevg-router.ts`               | KoreVG voice router                                               | Update                                                            | S      |
| `apps/studio/src/api/channel-connections.ts`                            | Studio API client for channels                                    | Update types                                                      | S      |
| `apps/studio/src/components/deployments/channels/channel-normalizer.ts` | Normalizes channel data                                           | Remove encrypted cred handling                                    | S      |
| `apps/studio/src/__tests__/channel-normalizer.test.ts`                  | Tests normalizer                                                  | Update                                                            | S      |
| `apps/studio/src/__tests__/channel-integration.test.ts`                 | Channel integration tests                                         | Update                                                            | M      |
| `apps/studio/src/hooks/useConnectors.ts`                                | Hook for connector state                                          | Update types                                                      | S      |
| `apps/studio/src/components/admin/ConnectorsPage.tsx`                   | Connectors admin page                                             | Update to show `AuthProfile` link                                 | M      |
| `apps/studio/src/components/deployments/channels/tabs/TestingTab.tsx`   | Channel testing tab                                               | Update credential display                                         | S      |
| `packages/project-io/src/export/layer-assemblers/channels-assembler.ts` | Exports channel connections                                       | Update export shape                                               | M      |
| `packages/project-io/src/__tests__/channels-assembler.test.ts`          | Tests channel export                                              | Update                                                            | M      |

### 2.4 `ServiceNode`

**File:** `packages/database/src/models/service-node.model.ts`

**Fields to DROP:**

- `encryptedSecrets` (line 25, schema line 54) — encrypted secrets blob
- `authType` (line 23, schema line 52)
- `authConfig` (line 24, schema line 53)

**Field to ADD:** `authProfileId: string | null`

| File Path                                                     | Current State                                             | Required Change                               | Effort |
| ------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------- | ------ |
| `packages/database/src/models/service-node.model.ts`          | Model with `encryptedSecrets`, `authType`, `authConfig`   | Remove 3 fields, add `authProfileId`          | M      |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`    | ServiceNode opts into encryption with `skipTenantScoping` | Remove ServiceNode-specific encryption config | S      |
| `packages/database/src/__tests__/model-misc.test.ts`          | Tests ServiceNode model                                   | Update for simplified schema                  | S      |
| `apps/runtime/src/services/adapters/service-node-executor.ts` | Decrypts `encryptedSecrets` for auth headers              | REWRITE to resolve auth via `AuthProfile`     | L      |
| `apps/runtime/src/services/adapters/index.ts`                 | Exports service node executor                             | Update imports                                | S      |
| `apps/studio/src/repos/service-node-repo.ts`                  | CRUD for service nodes with encrypted data                | Remove encryption handling                    | M      |
| `apps/studio/src/app/api/service-nodes/route.ts`              | Service node CRUD route                                   | Remove encryption, use `authProfileId`        | M      |
| `apps/studio/src/app/api/service-nodes/[id]/route.ts`         | Service node detail route                                 | Remove encryption, use `authProfileId`        | M      |

### 2.5 `TenantModel.connections[]`

**File:** `packages/database/src/models/tenant-model.model.ts`

**Fields to DROP on `ITenantModelConnection`:**

- `credentialId` (line 19, schema line 77) — references `LLMCredential._id`

**Field to ADD:** `authProfileId: string`

| File Path                                                  | Current State                                                     | Required Change                             | Effort |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- | ------ |
| `packages/database/src/models/tenant-model.model.ts`       | `credentialId: string` in embedded connection schema              | Replace `credentialId` with `authProfileId` | S      |
| `apps/runtime/src/repos/tenant-model-repo.ts`              | All connection CRUD uses `credentialId`                           | Replace with `authProfileId`                | M      |
| `apps/runtime/src/repos/llm-resolution-repo.ts`            | `findTenantModelByProvider` filters on `connections.credentialId` | Replace with `connections.authProfileId`    | S      |
| `apps/runtime/src/routes/tenant-models.ts`                 | Connection CRUD routes accept `credentialId` in body              | Replace with `authProfileId`                | M      |
| `apps/runtime/src/__tests__/tenant-model-routes.test.ts`   | Tests with `credentialId`                                         | Update fixtures                             | M      |
| `apps/studio/src/repos/credential-repo.ts`                 | `findModelsUsingCredential()` queries `connections.credentialId`  | Rewrite for `authProfileId`                 | S      |
| `apps/studio/src/components/admin/AddConnectionDialog.tsx` | UI sends `credentialId` when creating connection                  | Send `authProfileId`                        | M      |
| `apps/studio/src/components/admin/ModelsPage.tsx`          | Shows credential name per connection                              | Show `AuthProfile` name                     | M      |
| `apps/admin/src/app/(dashboard)/models/[id]/page.tsx`      | Admin model detail shows connections                              | Update credential display                   | S      |
| `packages/database/src/__tests__/model-project.test.ts`    | Tests project model with connections                              | Update `credentialId` references            | S      |

### 2.6 `TenantGuardrailProviderConfig`

**File:** `packages/database/src/models/guardrail-provider-config.model.ts`

**Fields to DROP:**

- `apiKeyCredentialId` (line 58, schema line 160) — references `LLMCredential._id`

**Field to ADD:** `authProfileId: string | null`

| File Path                                                         | Current State                                                  | Required Change                                | Effort |
| ----------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- | ------ |
| `packages/database/src/models/guardrail-provider-config.model.ts` | `apiKeyCredentialId?: string`                                  | Replace with `authProfileId?: string`          | S      |
| `apps/runtime/src/routes/guardrail-providers.ts`                  | CRUD route accepts `apiKeyCredentialId`                        | Replace with `authProfileId`                   | S      |
| `apps/runtime/src/__tests__/guardrails/provider-routes.test.ts`   | Tests provider routes                                          | Update fixture data                            | S      |
| `apps/runtime/src/services/guardrails/pipeline-factory.ts`        | Resolves API key from `apiKeyCredentialId` via `LLMCredential` | Resolve via `AuthProfile`                      | M      |
| `apps/runtime/src/services/guardrails/policy-resolver.ts`         | Policy resolver references `credentialId`                      | Update reference                               | S      |
| `apps/studio/src/app/api/admin/guardrail-providers/route.ts`      | Studio admin route for guardrail providers                     | Update `apiKeyCredentialId` to `authProfileId` | S      |
| `apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts`            | E2E tests for guardrails                                       | Update credential references                   | S      |

### 2.7 `GitIntegration`

**File:** `packages/database/src/models/git-integration.model.ts`

**Fields to DROP on `IGitCredentials`:**

- `secretId` (line 16, schema line 56) — references a `ToolSecret._id`
- `type` enum (line 15, schema line 56) — auth type moves to `AuthProfile`

**Entire `credentials` subdocument replaced by:** `authProfileId: string`

| File Path                                                     | Current State                                 | Required Change                                     | Effort |
| ------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- | ------ |
| `packages/database/src/models/git-integration.model.ts`       | `credentials: { type, secretId }` subdocument | Replace with `authProfileId: string`                | M      |
| `packages/database/src/__tests__/model-collaboration.test.ts` | Tests git integration model                   | Update credential fields                            | S      |
| `packages/project-io/src/git/index.ts`                        | Git operations use `credentials.secretId`     | Replace with `AuthProfile` resolution               | M      |
| `packages/project-io/src/git/provider-factory.ts`             | Creates git providers using `credentials`     | Resolve via `AuthProfile`                           | M      |
| `apps/studio/src/app/api/projects/[id]/git/route.ts`          | Git integration CRUD                          | Replace `credentials` with `authProfileId`          | M      |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`     | Git push uses credentials                     | Update to `AuthProfile` resolution                  | S      |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`     | Git pull uses credentials                     | Update to `AuthProfile` resolution                  | S      |
| `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`  | Git promote uses credentials                  | Update                                              | S      |
| `apps/studio/src/app/api/projects/[id]/git/status/route.ts`   | Git status uses credentials                   | Update                                              | S      |
| `apps/studio/src/app/api/projects/[id]/git/history/route.ts`  | Git history uses credentials                  | Update                                              | S      |
| `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`   | Git webhook handler                           | May need `AuthProfile` for verification             | S      |
| `apps/studio/src/__tests__/api-git-routes.test.ts`            | Tests git routes                              | Update credential fixtures                          | M      |
| `apps/studio/src/__tests__/api-webhook-git-routes.test.ts`    | Tests webhook git routes                      | Update                                              | S      |
| `apps/studio/src/components/settings/GitIntegrationTab.tsx`   | UI for git integration setup                  | Replace credential form with `AuthProfile` selector | M      |
| `apps/studio/src/components/settings/ProjectSettingsPage.tsx` | Settings page with git tab                    | Minor updates                                       | S      |
| `apps/studio/src/api/project-io.ts`                           | API client for project IO                     | Update git types                                    | S      |

### 2.8 `OrgProxyConfig`

**File:** `packages/database/src/models/org-proxy-config.model.ts`

**Fields to DROP (6 encrypted fields):**

- `encryptedProxyUsername` (line 23, schema line 48)
- `encryptedProxyPassword` (line 24, schema line 49)
- `encryptedProxyToken` (line 25, schema line 50)
- `encryptedCaCertificate` (line 26, schema line 51)
- `encryptedClientCert` (line 27, schema line 52)
- `encryptedClientKey` (line 28, schema line 53)
- `proxyAuthType` (line 22, schema line 47)

**Field to ADD:** `authProfileId: string | null`

| File Path                                                               | Current State                                      | Required Change                                                  | Effort |
| ----------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| `packages/database/src/models/org-proxy-config.model.ts`                | Model with 6 encrypted fields + `proxyAuthType`    | Remove 7 fields, add `authProfileId`                             | M      |
| `packages/database/src/__tests__/model-misc.test.ts`                    | Tests OrgProxyConfig model                         | Update for simplified schema                                     | S      |
| `packages/shared/src/repos/security-repo.ts`                            | CRUD for `OrgProxyConfig` with encrypted fields    | Simplify: remove encrypted field handling                        | M      |
| `packages/shared/src/__tests__/security-repo.test.ts`                   | Tests proxy config repo                            | Update                                                           | M      |
| `packages/shared-kernel/src/types/security.ts`                          | `NormalizedOrgProxyConfig` with 6 encrypted fields | Simplify interface: remove encrypted fields, add `authProfileId` | S      |
| `apps/runtime/src/routes/proxy-config.ts`                               | Proxy config CRUD with encryption of 6 fields      | Simplify: remove field encryption, use `authProfileId`           | L      |
| `apps/runtime/src/__tests__/proxy-config-authz.test.ts`                 | Authz tests for proxy config                       | Update                                                           | M      |
| `apps/runtime/src/__tests__/proxy-config-service.test.ts`               | Tests proxy config service                         | Update                                                           | M      |
| `apps/runtime/src/services/proxy-config-service.ts`                     | `ProxyConfigService` decrypts proxy credentials    | Resolve via `AuthProfile`                                        | M      |
| `packages/compiler/src/platform/constructs/executors/proxy-resolver.ts` | Uses decrypted proxy credentials                   | Update to receive from `AuthProfile`                             | M      |
| `packages/compiler/src/__tests__/constructs/proxy-resolver.test.ts`     | Tests proxy resolver                               | Update mocks                                                     | M      |
| `packages/compiler/src/platform/constructs/index.ts`                    | Exports proxy-related types                        | Update types                                                     | S      |
| `packages/compiler/src/index.ts`                                        | Exports `OrgProxyConfigRecord` type                | Update type                                                      | S      |

---

## 3. Services to MODIFY

| File Path                                                                | Current State                                                                                               | Required Change                                                                                                        | Effort |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/services/llm/model-resolution.ts`                      | 5-level resolution chain queries `LLMCredential` via `findCredentialById`, decrypts via `EncryptionService` | REWRITE Level 4-5 to call `AuthProfileService.resolve({ tenantId, authProfileId })`                                    | L      |
| `apps/runtime/src/services/execution/llm-wiring.ts`                      | Wires `ToolSecretStore`, `OAuthTokenResolver`, `SecretDecryptor`, `ProxyConfigStore`                        | REWRITE to wire single `AuthProfileService` for all credential resolution                                              | L      |
| `apps/runtime/src/services/secrets-provider.ts`                          | Multi-layer lookup: session token -> ToolSecret DB -> IR config -> env vars                                 | REWRITE: replace ToolSecret layer with `AuthProfile` resolution; replace OAuth layer with `AuthProfile` personal token | L      |
| `apps/runtime/src/services/tool-oauth-service.ts`                        | Manages OAuth flow, stores tokens in `EndUserOAuthToken`                                                    | REWRITE to create `AuthProfile` with `authType: oauth2_token`, `visibility: personal`                                  | L      |
| `apps/runtime/src/services/tool-oauth-service-singleton.ts`              | Lazy singleton for `ToolOAuthService`                                                                       | Update constructor args                                                                                                | S      |
| `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`       | Channel OAuth flow manager                                                                                  | REWRITE to create `AuthProfile` tokens instead of storing inline                                                       | M      |
| `apps/runtime/src/channels/connection-resolver.ts`                       | Decrypts `ChannelConnection.encryptedCredentials`                                                           | REWRITE to resolve `authProfileId` via `AuthProfile`                                                                   | M      |
| `apps/runtime/src/services/proxy-config-service.ts`                      | Decrypts proxy credentials from 6 fields                                                                    | Resolve credentials via `AuthProfile`                                                                                  | M      |
| `apps/runtime/src/services/adapters/service-node-executor.ts`            | Decrypts `ServiceNode.encryptedSecrets` for auth                                                            | Resolve via `AuthProfile`                                                                                              | M      |
| `apps/runtime/src/services/credential-age-monitor.ts`                    | Monitors 3 models: `ToolSecret`, `LLMCredential`, `ApiKey`                                                  | Monitor `AuthProfile` (by `lastValidatedAt` / `expiresAt`)                                                             | M      |
| `apps/runtime/src/services/guardrails/pipeline-factory.ts`               | Resolves `apiKeyCredentialId` to decrypted key                                                              | Resolve via `AuthProfile`                                                                                              | M      |
| `packages/connectors/src/auth/connection-resolver.ts`                    | `ConnectionResolver` class with OAuth refresh logic                                                         | REWRITE to use `AuthProfile` for token refresh                                                                         | L      |
| `packages/connectors/src/services/connection-service.ts`                 | `ConnectionService` with encrypt/decrypt callbacks                                                          | Simplify: remove callbacks, use `authProfileId`                                                                        | M      |
| `packages/connectors/base/src/auth/token-manager.ts`                     | `TokenManager` for OAuth token lifecycle                                                                    | REWRITE to use `AuthProfile` token management                                                                          | L      |
| `apps/studio/src/lib/connection-service.ts`                              | Studio singleton wiring encryption to `ConnectionService`                                                   | Simplify: remove encryption wiring                                                                                     | M      |
| `apps/search-ai/src/services/llm-config/resolver.ts`                     | Resolves `apiKey` from `LLMCredential` for LLM calls                                                        | REWRITE to use `AuthProfile`                                                                                           | L      |
| `apps/search-ai/src/services/llm-config/embedding-credentials.ts`        | Resolves embedding keys from `LLMCredential`                                                                | REWRITE to use `AuthProfile`                                                                                           | M      |
| `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts`         | Resolves `credentialId` from `TenantModel.connections`                                                      | Replace with `authProfileId` resolution                                                                                | M      |
| `apps/search-ai-runtime/src/services/llm-config/query-model-resolver.ts` | Resolves model credentials at query time                                                                    | REWRITE to use `AuthProfile`                                                                                           | M      |
| `packages/project-io/src/git/provider-factory.ts`                        | Creates git providers using `credentials.secretId`                                                          | Resolve via `AuthProfile`                                                                                              | M      |
| `apps/studio/src/services/tool-test-service.ts`                          | Resolves tool secrets for testing                                                                           | Replace with `AuthProfile` lookup                                                                                      | M      |

---

## 4. Routes/API Endpoints to MODIFY

### Routes to DELETE

| File Path                                 | Endpoint                   | Reason                           |
| ----------------------------------------- | -------------------------- | -------------------------------- |
| `apps/runtime/src/routes/tool-secrets.ts` | `/api/tool-secrets` (CRUD) | Replaced by `/api/auth-profiles` |

### Routes to REWRITE

| File Path                                                                   | Endpoint                                             | Required Change                                               | Effort                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- | --- |
| `apps/runtime/src/routes/oauth.ts`                                          | `/api/v1/oauth/*` (initiate, callback, list, revoke) | REWRITE to create `AuthProfile` with `authType: oauth2_token` | L                               |
| `apps/runtime/src/routes/channel-oauth.ts`                                  | `/api/v1/channel-oauth/:channelType/authorize        | callback`                                                     | REWRITE to create `AuthProfile` | L   |
| `apps/studio/src/app/api/credentials/route.ts`                              | `GET/POST /api/credentials`                          | REWRITE to use `AuthProfile`                                  | M                               |
| `apps/studio/src/app/api/credentials/[id]/route.ts`                         | `GET/PATCH/DELETE /api/credentials/:id`              | REWRITE to use `AuthProfile`                                  | M                               |
| `apps/studio/src/app/api/tenant-credentials/route.ts`                       | `GET/POST /api/tenant-credentials`                   | REWRITE to use `AuthProfile`                                  | M                               |
| `apps/studio/src/app/api/tenant-credentials/[id]/route.ts`                  | `GET/PATCH/DELETE /api/tenant-credentials/:id`       | REWRITE to use `AuthProfile`                                  | M                               |
| `apps/studio/src/app/api/tenant-credentials/[id]/impact/route.ts`           | `GET /api/tenant-credentials/:id/impact`             | REWRITE to query `AuthProfile` consumers                      | M                               |
| `apps/studio/src/app/api/projects/[id]/connections/oauth/initiate/route.ts` | `POST .../connections/oauth/initiate`                | REWRITE for `AuthProfile` OAuth                               | M                               |
| `apps/studio/src/app/api/projects/[id]/connections/oauth/callback/route.ts` | `POST .../connections/oauth/callback`                | REWRITE for `AuthProfile` OAuth                               | M                               |

### Routes to MODIFY (field changes)

| File Path                                                               | Endpoint                                       | Required Change                                                  | Effort |
| ----------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- | ------ |
| `apps/runtime/src/routes/tenant-models.ts`                              | `/api/tenants/:tenantId/models`                | Replace `credentialId` with `authProfileId` in connection CRUD   | M      |
| `apps/runtime/src/routes/channel-connections.ts`                        | `/api/projects/:projectId/channel-connections` | Remove credential encryption, use `authProfileId`                | L      |
| `apps/runtime/src/routes/proxy-config.ts`                               | `/api/proxy-configs`                           | Remove 6 encrypted fields, use `authProfileId`                   | L      |
| `apps/runtime/src/routes/guardrail-providers.ts`                        | `/api/tenants/:tenantId/guardrail-providers`   | Replace `apiKeyCredentialId` with `authProfileId`                | S      |
| `apps/runtime/src/routes/platform-admin-models.ts`                      | Platform admin model routes                    | Replace `credentialId`                                           | S      |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/route.ts`            | MCP server CRUD                                | Remove `encryptedAuthConfig`/`encryptedEnv`, use `authProfileId` | M      |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts` | MCP server detail                              | Same                                                             | M      |
| `apps/studio/src/app/api/service-nodes/route.ts`                        | Service node CRUD                              | Remove encrypted secrets, use `authProfileId`                    | M      |
| `apps/studio/src/app/api/service-nodes/[id]/route.ts`                   | Service node detail                            | Same                                                             | M      |
| `apps/studio/src/app/api/projects/[id]/git/route.ts`                    | Git integration CRUD                           | Replace `credentials` with `authProfileId`                       | M      |
| `apps/studio/src/app/api/admin/guardrail-providers/route.ts`            | Guardrail provider admin                       | Replace `apiKeyCredentialId`                                     | S      |
| `apps/studio/src/app/api/models/route.ts`                               | Model CRUD                                     | Replace `credentialId` references                                | S      |
| `apps/studio/src/app/api/models/[id]/route.ts`                          | Model detail                                   | Replace `credentialId` references                                | S      |

---

## 5. Shared Type Definitions to MODIFY

| File Path                                               | Current State                                                                                         | Required Change                                      | Effort |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ |
| `packages/shared-kernel/src/types/security.ts`          | Defines `NormalizedToolSecret`, `NormalizedOrgProxyConfig`, `NormalizedEndUserOAuthToken`             | Remove all 3 types; add `NormalizedAuthProfile` type | M      |
| `packages/shared-kernel/src/index.ts`                   | Exports all 3 security types                                                                          | Update exports                                       | S      |
| `packages/shared/src/types/security.ts`                 | Re-exports from shared-kernel                                                                         | Update re-exports                                    | S      |
| `packages/shared/src/index.ts`                          | Exports security types + repo functions                                                               | Update exports                                       | S      |
| `packages/shared/src/repos/index.ts`                    | Exports `createToolSecret`, `findToolSecrets`, `createOrgProxyConfig`, `findEndUserOAuthTokens`, etc. | Update to export `AuthProfile` repo functions        | M      |
| `packages/shared/src/validation/tool-secret-schemas.ts` | Zod schemas for tool secret API                                                                       | DELETE or replace with `AuthProfile` validation      | S      |
| `packages/shared/src/validation/index.ts`               | Exports tool secret schemas                                                                           | Update                                               | S      |
| `packages/connectors/src/auth/index.ts`                 | Exports connection resolver types                                                                     | Update for `AuthProfile` types                       | S      |
| `packages/connectors/src/index.ts`                      | Exports connector connection types                                                                    | Update                                               | S      |
| `packages/shared/src/types/mcp-server.ts`               | MCP server types with encrypted auth fields                                                           | Remove encrypted fields, add `authProfileId`         | S      |

---

## 6. Test Files to MODIFY/DELETE

| File Path                                                                        | Category        | Action                                                     | Effort |
| -------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------- | ------ |
| `packages/database/src/__tests__/encryption-e2e.test.ts`                         | DB              | Rewrite for `AuthProfile`                                  | M      |
| `packages/database/src/__tests__/model-security.test.ts`                         | DB              | Rewrite (removes `ToolSecret` + `EndUserOAuthToken` tests) | M      |
| `packages/database/src/__tests__/model-misc.test.ts`                             | DB              | Update `ServiceNode` + `OrgProxyConfig` tests              | M      |
| `packages/database/src/__tests__/model-billing.test.ts`                          | DB              | Update `LLMCredential` references                          | S      |
| `packages/database/src/__tests__/model-connector-connection.test.ts`             | DB              | Rewrite for simplified model                               | M      |
| `packages/database/src/__tests__/model-collaboration.test.ts`                    | DB              | Update git integration tests                               | S      |
| `packages/database/src/__tests__/model-project.test.ts`                          | DB              | Update connection credential references                    | S      |
| `packages/database/src/__tests__/mongo-cascade.test.ts`                          | DB              | Update cascade delete tests                                | M      |
| `packages/shared/src/__tests__/security-repo.test.ts`                            | Shared          | Rewrite entirely                                           | L      |
| `packages/shared/src/__tests__/mcp-server-config-repo.test.ts`                   | Shared          | Update for `authProfileId`                                 | M      |
| `packages/shared/src/__tests__/mcp-server-registry.test.ts`                      | Shared          | Update                                                     | M      |
| `packages/shared/src/__tests__/dsl-property-parser.test.ts`                      | Shared          | Update                                                     | S      |
| `packages/connectors/src/__tests__/connection-resolver.test.ts`                  | Connectors      | Rewrite                                                    | L      |
| `packages/connectors/src/__tests__/connection-service.test.ts`                   | Connectors      | Rewrite                                                    | M      |
| `packages/connectors/src/__tests__/connector-tool-executor.test.ts`              | Connectors      | Update                                                     | M      |
| `packages/compiler/src/__tests__/constructs/proxy-resolver.test.ts`              | Compiler        | Update                                                     | M      |
| `apps/runtime/src/__tests__/tool-secrets-authz.test.ts`                          | Runtime         | DELETE                                                     | S      |
| `apps/runtime/src/__tests__/oauth-authz.test.ts`                                 | Runtime         | Rewrite for new route shape                                | M      |
| `apps/runtime/src/__tests__/tool-oauth-service.test.ts`                          | Runtime         | Rewrite                                                    | M      |
| `apps/runtime/src/__tests__/secrets-provider.test.ts`                            | Runtime         | Rewrite                                                    | M      |
| `apps/runtime/src/__tests__/llm-wiring.test.ts`                                  | Runtime         | Update                                                     | M      |
| `apps/runtime/src/__tests__/tenant-model-routes.test.ts`                         | Runtime         | Update `credentialId` fixtures                             | M      |
| `apps/runtime/src/__tests__/repos-data.test.ts`                                  | Runtime         | Update all credential fixtures                             | M      |
| `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts`             | Runtime         | Update                                                     | M      |
| `apps/runtime/src/__tests__/proxy-config-authz.test.ts`                          | Runtime         | Update                                                     | M      |
| `apps/runtime/src/__tests__/proxy-config-service.test.ts`                        | Runtime         | Update                                                     | M      |
| `apps/runtime/src/__tests__/channel-connections-authz.test.ts`                   | Runtime         | Update                                                     | M      |
| `apps/runtime/src/__tests__/guardrails/provider-routes.test.ts`                  | Runtime         | Update                                                     | S      |
| `apps/runtime/src/__tests__/mcp-server-registry.test.ts`                         | Runtime         | Update                                                     | M      |
| `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`                         | Runtime         | Update                                                     | S      |
| `apps/runtime/src/__tests__/cross-tenant-isolation.test.ts`                      | Runtime         | Update                                                     | S      |
| `apps/runtime/src/__tests__/debug_llm*.test.ts` (2 files)                        | Runtime         | Update credential mocks                                    | S      |
| `apps/runtime/src/__tests__/route-validation.test.ts`                            | Runtime         | Update                                                     | S      |
| `apps/studio/src/__tests__/model-management.test.tsx`                            | Studio          | Rewrite credential references                              | M      |
| `apps/studio/src/__tests__/lib-arch.test.ts`                                     | Studio          | Update                                                     | S      |
| `apps/studio/src/__tests__/tool-test-service.test.ts`                            | Studio          | Update                                                     | M      |
| `apps/studio/src/__tests__/api-mcp-routes.test.ts`                               | Studio          | Update                                                     | M      |
| `apps/studio/src/__tests__/api-export-routes.test.ts`                            | Studio          | Update                                                     | S      |
| `apps/studio/src/__tests__/api-route-validation.test.ts`                         | Studio          | Update                                                     | S      |
| `apps/studio/src/__tests__/api-git-routes.test.ts`                               | Studio          | Update                                                     | M      |
| `apps/studio/src/__tests__/api-webhook-git-routes.test.ts`                       | Studio          | Update                                                     | S      |
| `apps/studio/src/__tests__/channel-normalizer.test.ts`                           | Studio          | Update                                                     | S      |
| `apps/studio/src/__tests__/channel-integration.test.ts`                          | Studio          | Update                                                     | M      |
| `apps/studio/src/__tests__/mcp-server-response.test.ts`                          | Studio          | Update                                                     | S      |
| `apps/search-ai/src/__tests__/connector-sync-worker.test.ts`                     | Search-AI       | Update                                                     | M      |
| `apps/search-ai/src/__tests__/connector-permission-crawl-worker.test.ts`         | Search-AI       | Update                                                     | M      |
| `apps/search-ai/src/__tests__/routes/connectors-auth.test.ts`                    | Search-AI       | Update                                                     | M      |
| `apps/search-ai/src/__tests__/routes/connectors-sync.test.ts`                    | Search-AI       | Update                                                     | S      |
| `apps/search-ai/src/__tests__/llm-config-api.test.ts`                            | Search-AI       | Update                                                     | M      |
| `apps/search-ai/src/services/llm-config/__tests__/embedding-credentials.test.ts` | Search-AI       | Rewrite                                                    | M      |
| `apps/search-ai/src/services/llm-config/__tests__/resolver.test.ts`              | Search-AI       | Rewrite                                                    | M      |
| `apps/search-ai/src/__tests__/per-index-config-integration.test.ts`              | Search-AI       | Update                                                     | S      |
| `apps/search-ai/src/workers/__tests__/okta-user-sync-worker.test.ts`             | Search-AI       | Update                                                     | M      |
| `apps/workflow-engine/src/__tests__/route-integration.test.ts`                   | Workflow Engine | Update                                                     | M      |
| `apps/workflow-engine/src/__tests__/connections-routes.test.ts`                  | Workflow Engine | Update                                                     | M      |
| `apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts`                           | E2E             | Update                                                     | S      |
| `apps/studio/e2e/workflow-apple-care-e2e.spec.ts`                                | E2E             | Update                                                     | S      |

---

## 7. Database Schema Changes

### New Model: `AuthProfile`

**New file:** `packages/database/src/models/auth-profile.model.ts`

- 17 auth types as discriminated union
- AES-256-GCM encrypted `encryptedSecrets` blob (single field vs per-field)
- Tenant isolation plugin
- Encryption plugin on `['encryptedSecrets', 'previousEncryptedSecrets']`
- 7 indexes (see design doc section 9)

### Collections to DROP

| Collection              | Model               | Action               |
| ----------------------- | ------------------- | -------------------- |
| `llm_credentials`       | `LLMCredential`     | DROP after migration |
| `end_user_oauth_tokens` | `EndUserOAuthToken` | DROP after migration |
| `tool_secrets`          | `ToolSecret`        | DROP after migration |

### Collections to ALTER (field drops + adds)

| Collection                          | Model                           | Fields Removed                                                                                                             | Field Added                   |
| ----------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `connector_connections`             | `ConnectorConnection`           | `encryptedCredentials`, `encryptionKeyVersion`, `oauth2TokenExpiresAt`, `oauth2RefreshToken`, `oauth2Provider`, `authType` | `authProfileId`               |
| `mcp_server_configs`                | `MCPServerConfig`               | `encryptedEnv`, `encryptedAuthConfig`, `authType`                                                                          | `authProfileId`               |
| `channel_connections`               | `ChannelConnection`             | `encryptedCredentials`                                                                                                     | `authProfileId`               |
| `service_nodes`                     | `ServiceNode`                   | `encryptedSecrets`, `authType`, `authConfig`                                                                               | `authProfileId`               |
| `tenant_models`                     | `TenantModel`                   | `connections[].credentialId`                                                                                               | `connections[].authProfileId` |
| `tenant_guardrail_provider_configs` | `TenantGuardrailProviderConfig` | `apiKeyCredentialId`                                                                                                       | `authProfileId`               |
| `git_integrations`                  | `GitIntegration`                | `credentials: { type, secretId }`                                                                                          | `authProfileId`               |
| `org_proxy_configs`                 | `OrgProxyConfig`                | 6 encrypted fields + `proxyAuthType`                                                                                       | `authProfileId`               |
| `connector_configs`                 | `ConnectorConfig`               | `oauthTokenId`                                                                                                             | `authProfileId`               |

---

## 8. Reuse vs Rewrite Assessment

### Fully Reusable (keep as-is)

| Component                                                            | Why                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`           | Same AES-256-GCM encryption; `AuthProfile` uses `fieldsToEncrypt: ['encryptedSecrets', 'previousEncryptedSecrets']` |
| `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`     | `AuthProfile` uses standard tenant isolation                                                                        |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts`          | Reused for `AuthProfile` audit                                                                                      |
| `@agent-platform/shared/encryption` (EncryptionService)              | `encryptForTenant`/`decryptForTenant` reused for all `AuthProfile` secret encryption                                |
| Redis distributed lock (`SET NX PX`)                                 | Reused for OAuth token refresh lock                                                                                 |
| RBAC middleware (`requirePermission`, `requireProjectPermission`)    | Reused for `AuthProfile` route authorization                                                                        |
| `packages/database/src/model-registry.ts`                            | Used for dual-database support if needed                                                                            |
| `@agent-platform/openapi/express` + `@agent-platform/openapi/nextjs` | Reused for new `AuthProfile` routes                                                                                 |

### Partially Reusable (logic reused, interface changes)

| Component                                                          | What to Keep                                             | What Changes                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/tool-oauth-service.ts`                  | OAuth flow logic (PKCE, state management, code exchange) | Token storage: `EndUserOAuthToken` -> `AuthProfile` with `authType: oauth2_token`; two-layer linking via `linkedAppProfileId` |
| `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts` | Provider adapter pattern, state management               | Token storage: inline `ChannelConnection` -> `AuthProfile`                                                                    |
| `packages/connectors/src/auth/connection-resolver.ts`              | Resolution priority logic (user > tenant)                | Credential source: `encryptedCredentials` -> `AuthProfile` resolution                                                         |
| `packages/connectors/base/src/auth/token-manager.ts`               | Token refresh timing logic (buffer period)               | Model: `IEndUserOAuthToken` -> `AuthProfile`; refresh via `linkedAppProfileId`                                                |
| `apps/runtime/src/services/secrets-provider.ts`                    | Multi-layer lookup chain, session token extraction       | Replace ToolSecret + OAuth layers with AuthProfile resolution                                                                 |
| `apps/runtime/src/services/llm/model-resolution.ts`                | 5-level resolution priority logic                        | Replace Level 4 credential step: `credentialId` -> `authProfileId`                                                            |

### Must Rewrite (completely new logic)

| Component                                          | Reason                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `AuthProfile` Mongoose model                       | New model with discriminated union, 17 auth types, addon blocks                                        |
| `AuthProfileService`                               | New: CRUD, resolve, validate, rotate, two-layer OAuth, scope inheritance                               |
| `AuthProfile` REST routes (tenant + project level) | New: unified CRUD + OAuth initiate/callback + validate endpoint                                        |
| Pre-flight auth propagation (runtime)              | New: `authRequirements` manifest in IR, consent flow                                                   |
| Compiler `AUTH:` section parsing                   | New: DSL `auth: "profile-name"` resolution, `connection: per_user/shared`, `consent: preflight/inline` |
| `AuthProfile` Zod validation schemas               | New: per-authType validation of `config` + `secrets` required fields                                   |
| Token refresh unification                          | New: single refresh implementation replacing 3 separate ones                                           |
| Studio `AuthProfilesPage` UI                       | New: management page for auth profiles                                                                 |
| Studio connector setup flow (3-step wizard)        | Partially new: step 1 (oauth2_app) + step 2 (shared vs per_user)                                       |

---

## 9. Completely New Code

| File (Proposed Path)                                                              | Description                                                | Effort |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| `packages/database/src/models/auth-profile.model.ts`                              | AuthProfile Mongoose model + schema + indexes              | L      |
| `packages/shared/src/types/auth-profile.ts`                                       | TypeScript types for all 17 auth types + addons            | L      |
| `packages/shared/src/validation/auth-profile-schemas.ts`                          | Zod validation schemas per authType                        | L      |
| `packages/shared/src/repos/auth-profile-repo.ts`                                  | Repository: CRUD, find by scope, resolve inheritance       | L      |
| `packages/shared/src/services/auth-profile-service.ts`                            | Service: resolve, decrypt, validate, token refresh, rotate | XL     |
| `apps/runtime/src/routes/auth-profiles.ts`                                        | Runtime REST routes for tenant-level auth profiles         | L      |
| `apps/studio/src/app/api/auth-profiles/route.ts`                                  | Studio tenant-level auth profile routes                    | M      |
| `apps/studio/src/app/api/auth-profiles/[id]/route.ts`                             | Studio auth profile detail routes                          | M      |
| `apps/studio/src/app/api/auth-profiles/[id]/validate/route.ts`                    | Credential validation endpoint                             | M      |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`                    | Studio project-level auth profile routes                   | M      |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[id]/route.ts`               | Project auth profile detail                                | M      |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`     | Unified OAuth initiate                                     | M      |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`     | Unified OAuth callback                                     | M      |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` | End-user consent flow                                      | M      |
| `apps/studio/src/components/settings/AuthProfilesPage.tsx`                        | Auth profiles management UI                                | L      |
| `apps/studio/src/components/settings/AuthProfileForm.tsx`                         | Auth profile create/edit form (type-specific)              | L      |
| `apps/studio/src/components/settings/ConnectorSetupWizard.tsx`                    | 3-step connector OAuth setup flow                          | L      |
| `apps/studio/src/components/runtime/ConsentPrompt.tsx`                            | Pre-flight/inline consent UI                               | M      |
| `packages/compiler/src/platform/ir/auth-requirements.ts`                          | IR auth requirements propagation                           | L      |
| `packages/database/src/migrations/scripts/2026XXXX_auth_profile_migration.ts`     | Data migration script                                      | XL     |
| `packages/shared/src/__tests__/auth-profile-repo.test.ts`                         | Repo tests                                                 | L      |
| `packages/shared/src/__tests__/auth-profile-service.test.ts`                      | Service tests                                              | L      |
| `apps/runtime/src/__tests__/auth-profiles-routes.test.ts`                         | Route tests                                                | L      |
| `apps/runtime/src/__tests__/auth-profiles-authz.test.ts`                          | Authorization tests                                        | M      |

---

## 10. Migration Script Requirements

### Phase 1: Create AuthProfile Documents

1. **LLMCredential -> AuthProfile**: Map `encryptedApiKey` -> `encryptedSecrets: { apiKey }`, `encryptedEndpoint` -> `config.endpoint`, `customHeaders` -> `config.customHeaders`; set `authType` from `authType` field; set `category: 'llm'`; set `scope` from `credentialScope`
2. **EndUserOAuthToken -> AuthProfile**: Map to `authType: oauth2_token`, `visibility: personal`, `encryptedSecrets: { accessToken, refreshToken }`, `config: { provider, scopes, expiresAt }`
3. **ToolSecret -> AuthProfile**: Map to appropriate `authType` based on usage (most become `api_key` or `bearer`); set `category: 'tool'`
4. **Inline ConnectorConnection credentials** -> Extract and create `AuthProfile`, link via `authProfileId`
5. **Inline MCPServerConfig auth** -> Extract and create `AuthProfile`, link via `authProfileId`
6. **Inline ChannelConnection credentials** -> Extract and create `AuthProfile`, link via `authProfileId`
7. **Inline ServiceNode secrets** -> Extract and create `AuthProfile`, link via `authProfileId`
8. **Inline OrgProxyConfig credentials** -> Extract and create `AuthProfile`, link via `authProfileId`

### Phase 2: Update Consumer References

9. Update `TenantModel.connections[].credentialId` -> `.authProfileId`
10. Update `TenantGuardrailProviderConfig.apiKeyCredentialId` -> `.authProfileId`
11. Update `GitIntegration.credentials.secretId` -> `.authProfileId`
12. Update `ConnectorConfig.oauthTokenId` -> `.authProfileId`

### Phase 3: Drop Old Fields/Collections

13. Drop `llm_credentials` collection
14. Drop `end_user_oauth_tokens` collection
15. Drop `tool_secrets` collection
16. Remove deprecated fields from simplified models (via `$unset`)

### Estimated Migration Complexity: XL

- ~8 source collections need credential extraction
- Encryption re-keying: old fields used per-field encryption; new model uses single `encryptedSecrets` blob
- Must handle partial failures (idempotent with `$setOnInsert`)
- Distributed lock for production rollout

---

## Summary Statistics

| Category                            | File Count        | Effort Distribution       |
| ----------------------------------- | ----------------- | ------------------------- |
| Models to DELETE (3 model files)    | 3 files           | 3 S                       |
| Files referencing deleted models    | ~130 unique files | 40 S, 60 M, 30 L          |
| Models to SIMPLIFY (8+ model files) | 9 files           | 9 M                       |
| Files referencing simplified models | ~100 unique files | 35 S, 45 M, 20 L          |
| New files to CREATE                 | ~24 files         | 5 M, 12 L, 2 XL           |
| Test files to MODIFY/DELETE         | ~55 files         | 20 S, 30 M, 5 L           |
| **Total unique files impacted**     | **~200**          |                           |
| **Estimated total effort**          |                   | **~8-12 developer-weeks** |
