# Auth Profile Design Review: Environment Variables, Configuration & Secrets Management

**Reviewer:** DevOps/Infrastructure
**Date:** 2026-03-11
**Documents Reviewed:**

- `docs/plans/2026-03-11-auth-profile-design.md`
- `docs/plans/2026-03-11-auth-profile-setup-guide.md`
- `docs/plans/2026-03-11-auth-profile-connections-analysis.md`

---

## 1. Current Auth-Related Environment Variable Inventory

### 1.1 Encryption Keys (Critical Infrastructure)

| Variable                | Apps Using It                                                                   | Purpose                                       | Auth Profile Impact                                             |
| ----------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY` | Studio, Runtime, Search-AI, Search-AI-Runtime, Workflow-Engine, Pipeline-Engine | AES-256-GCM encryption of all secrets at rest | **STAYS** — Auth Profile depends on this for `encryptedSecrets` |

**Where loaded (source code):**

- `packages/shared/src/encryption/index.ts` — singleton `getEncryptionService()` reads `process.env.ENCRYPTION_MASTER_KEY`
- `packages/shared/src/encryption/master-key-resolver.ts` — `resolveMasterKey()` with vault fallback
- `apps/runtime/src/server.ts` (lines 1079, 1193)
- `apps/studio/src/db/index.ts` (line 18), `apps/studio/src/lib/ensure-db.ts` (line 21)
- `apps/search-ai/src/server.ts` (line 260)
- `apps/search-ai-runtime/src/server.ts` (line 169)
- `apps/workflow-engine/src/services/database.ts` (line 68)
- `packages/pipeline-engine/src/pipeline/bootstrap.ts` (line 15), `server.ts` (line 211)

**docker-compose.yml reference:** `ENCRYPTION_MASTER_KEY: ${ENCRYPTION_MASTER_KEY:?ENCRYPTION_MASTER_KEY must be set}` on workflow-engine and pipeline-engine services.

### 1.2 Platform Login OAuth (NextAuth — Stays Unchanged)

| Variable               | App    | Purpose                    | Auth Profile Impact                       |
| ---------------------- | ------ | -------------------------- | ----------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Studio | User login via Google      | **STAYS** — platform login, not tool auth |
| `GOOGLE_CLIENT_SECRET` | Studio | User login via Google      | **STAYS**                                 |
| `GITHUB_CLIENT_ID`     | Studio | User login via GitHub      | **STAYS**                                 |
| `GITHUB_CLIENT_SECRET` | Studio | User login via GitHub      | **STAYS**                                 |
| `NEXTAUTH_SECRET`      | Studio | NextAuth session signing   | **STAYS**                                 |
| `NEXTAUTH_URL`         | Studio | NextAuth callback base URL | **STAYS**                                 |

**Used in:** `apps/studio/src/app/api/auth/google/route.ts`, `apps/studio/src/app/api/auth/callback/route.ts`

### 1.3 Connector OAuth App Credentials (Replaced by Auth Profile)

| Variable Pattern                      | App             | Purpose                       | Auth Profile Impact                                  |
| ------------------------------------- | --------------- | ----------------------------- | ---------------------------------------------------- |
| `OAUTH_PROVIDER_<NAME>_CLIENT_ID`     | Studio          | Connector OAuth client ID     | **OBSOLETE** — replaced by `oauth2_app` Auth Profile |
| `OAUTH_PROVIDER_<NAME>_CLIENT_SECRET` | Studio          | Connector OAuth client secret | **OBSOLETE**                                         |
| `OAUTH_PROVIDER_<NAME>_AUTHORIZE_URL` | Runtime (tests) | Authorization URL override    | **OBSOLETE** — stored in Auth Profile `config`       |
| `OAUTH_PROVIDER_<NAME>_TOKEN_URL`     | Runtime (tests) | Token URL override            | **OBSOLETE**                                         |
| `OAUTH_PROVIDER_<NAME>_SCOPES`        | Runtime (tests) | Scope override                | **OBSOLETE**                                         |
| `OAUTH_PROVIDER_<NAME>_REVOKE_URL`    | Runtime (tests) | Revocation URL                | **OBSOLETE**                                         |

**Where loaded:**

- `apps/studio/src/lib/connector-oauth.ts` — `loadProviderCredentials()` function reads `OAUTH_PROVIDER_${provider.toUpperCase()}_CLIENT_ID` and `_CLIENT_SECRET`
- `apps/runtime/src/services/tool-oauth-service.ts` — scans all env vars for `OAUTH_PROVIDER_*_CLIENT_ID` pattern (line 526)
- `apps/runtime/src/__tests__/route-validation.test.ts` — extensive test fixtures

**Documented providers in `.env.example`:** GOOGLE, SLACK, GITHUB

### 1.4 Channel OAuth Credentials (Replaced by Auth Profile)

| Variable                              | App     | Purpose                                | Auth Profile Impact                                          |
| ------------------------------------- | ------- | -------------------------------------- | ------------------------------------------------------------ |
| `CHANNEL_OAUTH_SLACK_CLIENT_ID`       | Runtime | Slack channel OAuth                    | **OBSOLETE** — replaced by `oauth2_app` Auth Profile         |
| `CHANNEL_OAUTH_SLACK_CLIENT_SECRET`   | Runtime | Slack channel OAuth                    | **OBSOLETE**                                                 |
| `CHANNEL_OAUTH_SLACK_SIGNING_SECRET`  | Runtime | Slack event verification               | **PARTIALLY OBSOLETE** — maps to `webhookVerification` addon |
| `CHANNEL_OAUTH_SLACK_SCOPES`          | Runtime | Default Slack bot scopes               | **OBSOLETE** — stored in Auth Profile `config.defaultScopes` |
| `CHANNEL_OAUTH_MSTEAMS_APP_ID`        | Runtime | MS Teams channel OAuth                 | **OBSOLETE**                                                 |
| `CHANNEL_OAUTH_MSTEAMS_CLIENT_SECRET` | Runtime | MS Teams channel OAuth                 | **OBSOLETE**                                                 |
| `CHANNEL_OAUTH_MSTEAMS_TENANT_ID`     | Runtime | MS Teams tenant (defaults to "common") | **OBSOLETE**                                                 |
| `CHANNEL_OAUTH_META_APP_ID`           | Runtime | Meta (WhatsApp/Messenger) OAuth        | **OBSOLETE**                                                 |
| `CHANNEL_OAUTH_META_APP_SECRET`       | Runtime | Meta OAuth                             | **OBSOLETE**                                                 |
| `CHANNEL_OAUTH_WHATSAPP_SCOPES`       | Runtime | WhatsApp scopes                        | **OBSOLETE**                                                 |
| `CHANNEL_OAUTH_MESSENGER_SCOPES`      | Runtime | Messenger scopes                       | **OBSOLETE**                                                 |

**Where loaded:** `apps/runtime/src/services/channel-oauth/providers/index.ts` (lines 18-81)

### 1.5 LLM Provider Keys (Partially Replaced)

| Variable                | App(s)                 | Purpose               | Auth Profile Impact                                                                                             |
| ----------------------- | ---------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | Studio, Runtime, tests | LLM calls             | **PARTIALLY OBSOLETE** — Runtime credential from DB/Auth Profile; Studio `arch.service.ts` uses env as fallback |
| `OPENAI_API_KEY`        | Runtime (tests)        | LLM calls             | **PARTIALLY OBSOLETE** — same pattern                                                                           |
| `GOOGLE_AI_API_KEY`     | Runtime (tests)        | Google Gemini         | **PARTIALLY OBSOLETE**                                                                                          |
| `AZURE_OPENAI_API_KEY`  | Runtime                | Azure OpenAI          | **OBSOLETE** — replaced by `api_key` or `azure_ad` Auth Profile                                                 |
| `AZURE_OPENAI_ENDPOINT` | Runtime                | Azure endpoint        | **OBSOLETE** — stored in Auth Profile `config`                                                                  |
| `AWS_BEDROCK_REGION`    | Runtime                | Bedrock configuration | **PARTIALLY OBSOLETE** — some env-level config may remain for region defaults                                   |

**Note:** `ANTHROPIC_API_KEY` in Studio is used as a platform-level fallback for the Arch AI assistant (`apps/studio/src/services/arch.service.ts:2694`). This is a special case: it should migrate to an `AuthProfile { category: 'infrastructure' }` but may retain env var fallback during transition.

### 1.6 Voice Service Credentials (NOT Replaced by Auth Profile)

| Variable Family         | App(s)          | Purpose      | Auth Profile Impact                                |
| ----------------------- | --------------- | ------------ | -------------------------------------------------- |
| `TWILIO_*` (5 vars)     | Studio, Runtime | Voice/WebRTC | **STAYS** (could be future Auth Profile candidate) |
| `DEEPGRAM_*` (3 vars)   | Runtime         | STT          | **STAYS**                                          |
| `ELEVENLABS_*` (3 vars) | Runtime         | TTS          | **STAYS**                                          |
| `LIVEKIT_*` (5 vars)    | Runtime         | WebRTC voice | **STAYS**                                          |

These are not mentioned in the Auth Profile design. They are candidates for future inclusion but are out of scope for this phase.

### 1.7 Inter-Service Auth (Stays Unchanged)

| Variable             | App(s)                                                              | Purpose                   | Auth Profile Impact |
| -------------------- | ------------------------------------------------------------------- | ------------------------- | ------------------- |
| `JWT_SECRET`         | Studio, Runtime, Admin, Workflow-Engine, Pipeline-Engine, Telco-NOC | Inter-service JWT signing | **STAYS**           |
| `INTERNAL_API_KEY`   | Runtime                                                             | Service-to-service auth   | **STAYS**           |
| `SANDBOX_JWT_SECRET` | Runtime, Studio                                                     | Gvisor sandbox auth       | **STAYS**           |

### 1.8 Vault Provider Configuration (Stays Unchanged, Used by Auth Profile)

| Variable             | Purpose                    | Auth Profile Impact                                  |
| -------------------- | -------------------------- | ---------------------------------------------------- |
| `VAULT_ADDR`         | HashiCorp Vault address    | **STAYS** — vault can source `ENCRYPTION_MASTER_KEY` |
| `VAULT_TOKEN`        | HashiCorp Vault auth token | **STAYS**                                            |
| `AZURE_KEYVAULT_URL` | Azure Key Vault URL        | **STAYS**                                            |
| `AWS_SECRET_NAME`    | AWS Secrets Manager name   | **STAYS**                                            |
| `K8S_SECRETS_PATH`   | Kubernetes secrets mount   | **STAYS**                                            |

---

## 2. New Environment Variables Introduced by Auth Profile

### 2.1 Feature Flag (Required During Migration)

| Variable                | Required By     | Purpose                                           | Default |
| ----------------------- | --------------- | ------------------------------------------------- | ------- |
| `FEATURE_AUTH_PROFILES` | Studio, Runtime | Toggle between legacy and Auth Profile code paths | `false` |

**Finding:** The design mentions this flag (Section 6.5 Rollback Plan) but does not formalize the variable name. **Recommendation:** Standardize as `FEATURE_AUTH_PROFILES=true|false` and add to all `.env.example` files.

### 2.2 No New Encryption Keys

Auth Profile reuses the existing `ENCRYPTION_MASTER_KEY` and `encryptionPlugin` infrastructure. No new encryption keys are needed.

**Finding (POSITIVE):** The design correctly reuses the existing encryption stack. The `encryptionKeyVersion` field on `AuthProfile` provides key rotation tracking without new env vars.

### 2.3 No New Service URLs

Auth Profile is served by the existing Studio API routes (CRUD) and Runtime (resolution/refresh). No new services are introduced.

### 2.4 Potential New Variables

| Variable                                    | Potential Need                                                 | Recommendation              |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS` | Configurable buffer before token expiry (design hardcodes 60s) | Add as optional, default 60 |
| `AUTH_PROFILE_MAX_CONCURRENT_REFRESHES`     | Limit concurrent token refresh operations                      | Optional, default 10        |

---

## 3. Encryption Key Management Analysis

### 3.1 Current Configuration

`ENCRYPTION_MASTER_KEY` is a 32-byte hex string (64 hex characters) shared across all services that handle encrypted data.

**Services requiring the key:**

| Service           | How Configured                                  | Failure Mode Without Key                                      |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Studio            | `.env.local` (commented out in `.env.example`)  | Cannot encrypt/decrypt LLM credentials, tool secrets          |
| Runtime           | `.env` (commented out in `.env.example`)        | Cannot decrypt any credentials                                |
| Search-AI         | Reads from `process.env` in `server.ts`         | Logs warning, LLM credential decryption unavailable           |
| Search-AI-Runtime | Reads from `process.env` in `server.ts`         | Same as Search-AI                                             |
| Workflow-Engine   | docker-compose: `${ENCRYPTION_MASTER_KEY:?...}` | **Container fails to start** (required)                       |
| Pipeline-Engine   | docker-compose: `${ENCRYPTION_MASTER_KEY:?...}` | **Container fails to start** (required), also bootstrap check |

### 3.2 Key Sharing Requirement

**All services that read or write Auth Profile data MUST share the same `ENCRYPTION_MASTER_KEY`.** This is already the case for the current credential models. Auth Profile does not change this requirement.

**RISK:** The `.env.example` files for Studio and Runtime have the key **commented out** with instructions to "Generate with: openssl rand -hex 32". This means a fresh developer setup could have Studio and Runtime with **different or missing** keys.

**Recommendation:**

1. The root `.env.example` should be the single source of `ENCRYPTION_MASTER_KEY`.
2. Studio and Runtime should read from root `.env` (or have a shared env loading mechanism).
3. Currently, docker-compose **enforces** the key for workflow-engine and pipeline-engine (via `${ENCRYPTION_MASTER_KEY:?...}`), but Studio and Runtime running on host do not. Consider a startup check in both.

### 3.3 Key Rotation

**Current state:** The `encryptionPlugin` uses `encryptionKeyVersion: 1` hardcoded. The `master-key-resolver.ts` has vault fallback support but no multi-version key support. Key rotation would require:

1. Update `ENCRYPTION_MASTER_KEY` across all services simultaneously.
2. Re-encrypt all documents (no online re-encryption path exists).

**Auth Profile adds:** The `encryptionKeyVersion` field and `previousEncryptedSecrets` field support graceful rotation. **However**, the underlying `EncryptionService` singleton in `packages/shared/src/encryption/index.ts` loads the key **once** at startup and has no mechanism to hold multiple key versions.

**GAP (CRITICAL):** Auth Profile's key rotation design (`rotationPolicy`, `previousEncryptedSecrets`, `rotationGracePeriodMs`) assumes the encryption engine can decrypt with the previous key. The current `EncryptionService` cannot do this — it is initialized with a single `masterKeyHex`. **The engine must be extended to support multiple key versions before Auth Profile's rotation features can work.**

### 3.4 Vault Integration

The `packages/config/src/vault/` directory contains providers for:

- HashiCorp Vault (`hashicorp-vault.ts`)
- Azure Key Vault (`azure-keyvault.ts`)
- AWS Secrets Manager (`aws-secrets.ts`)
- Kubernetes Secrets (`k8s-secret-provider.ts`)
- File-based (`file-provider.ts`)

The `master-key-resolver.ts` already supports vault-first resolution. Auth Profile does not change vault integration but will benefit from it for production deployments.

---

## 4. Environment Variables That Become Obsolete

### 4.1 Connector OAuth (Studio) — REMOVE after migration Phase 4

| Obsolete Variable Pattern             | Replacement                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `OAUTH_PROVIDER_<NAME>_CLIENT_ID`     | `AuthProfile { authType: 'oauth2_app', encryptedSecrets: { clientId } }`     |
| `OAUTH_PROVIDER_<NAME>_CLIENT_SECRET` | `AuthProfile { authType: 'oauth2_app', encryptedSecrets: { clientSecret } }` |

**Files to update:**

- `apps/studio/.env.example` — remove lines 87-93
- `apps/studio/src/lib/connector-oauth.ts` — `loadProviderCredentials()` must be rewritten to use `AuthProfileService.resolve()`

### 4.2 Channel OAuth (Runtime) — REMOVE after migration Phase 4

| Obsolete Variable                     | Replacement                                                       |
| ------------------------------------- | ----------------------------------------------------------------- |
| `CHANNEL_OAUTH_SLACK_CLIENT_ID`       | `AuthProfile { authType: 'oauth2_app', connector: 'slack' }`      |
| `CHANNEL_OAUTH_SLACK_CLIENT_SECRET`   | Same Auth Profile, in `encryptedSecrets`                          |
| `CHANNEL_OAUTH_SLACK_SIGNING_SECRET`  | Auth Profile `webhookVerification` addon or separate Auth Profile |
| `CHANNEL_OAUTH_SLACK_SCOPES`          | Auth Profile `config.defaultScopes`                               |
| `CHANNEL_OAUTH_MSTEAMS_APP_ID`        | Auth Profile for MS Teams                                         |
| `CHANNEL_OAUTH_MSTEAMS_CLIENT_SECRET` | Same                                                              |
| `CHANNEL_OAUTH_MSTEAMS_TENANT_ID`     | Auth Profile `config.tenantId` (Azure AD config)                  |
| `CHANNEL_OAUTH_META_APP_ID`           | Auth Profile for Meta                                             |
| `CHANNEL_OAUTH_META_APP_SECRET`       | Same                                                              |
| `CHANNEL_OAUTH_WHATSAPP_SCOPES`       | Auth Profile `config.defaultScopes`                               |
| `CHANNEL_OAUTH_MESSENGER_SCOPES`      | Auth Profile `config.defaultScopes`                               |

**Files to update:**

- `apps/runtime/.env.example` — remove lines 117-123
- `apps/runtime/src/services/channel-oauth/providers/index.ts` — entire file must be rewritten

### 4.3 LLM Provider Keys (Partially Obsolete)

| Variable                      | Stays/Goes               | Reason                                                                                                            |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` (Runtime) | **GOES** after migration | Replaced by `LLMCredential` -> `AuthProfile { authType: 'api_key', category: 'llm' }`                             |
| `ANTHROPIC_API_KEY` (Studio)  | **STAYS as fallback**    | Used by `arch.service.ts` as platform-level Arch AI key; should eventually migrate to infrastructure Auth Profile |
| `OPENAI_API_KEY`              | **GOES**                 | Same as Anthropic in Runtime                                                                                      |
| `GOOGLE_AI_API_KEY`           | **GOES**                 | Same                                                                                                              |
| `AZURE_OPENAI_API_KEY`        | **GOES**                 | Replaced by `azure_ad` Auth Profile                                                                               |
| `AZURE_OPENAI_ENDPOINT`       | **GOES**                 | Stored in Auth Profile `config.endpoint`                                                                          |
| `AWS_BEDROCK_REGION`          | **PARTIAL**              | Region could remain as env config; credentials via `aws_iam` Auth Profile                                         |

**Note:** The `seed-tenant.ts` script and various test files reference LLM API keys from env vars. These testing/seeding patterns need Auth Profile-aware alternatives.

### 4.4 Summary Count

| Category             | Variables Becoming Obsolete               | Variables Staying |
| -------------------- | ----------------------------------------- | ----------------- |
| Connector OAuth      | ~6 (pattern-based, effectively unlimited) | 0                 |
| Channel OAuth        | 11                                        | 0                 |
| LLM Provider Keys    | 5-6                                       | 1 (Arch fallback) |
| Platform Login OAuth | 0                                         | 4                 |
| Encryption           | 0                                         | 1                 |
| Inter-Service Auth   | 0                                         | 3                 |
| Voice Services       | 0                                         | 16                |
| Vault Config         | 0                                         | 5                 |
| **Total**            | **~22-23**                                | **~30**           |

---

## 5. Docker / docker-compose Impact

### 5.1 Current docker-compose.yml Services

The `docker-compose.yml` defines infrastructure services (MongoDB, Redis, ClickHouse, etc.) and two application services:

| Service           | Auth-Related Env Vars                 | Auth Profile Impact                        |
| ----------------- | ------------------------------------- | ------------------------------------------ |
| `workflow-engine` | `JWT_SECRET`, `ENCRYPTION_MASTER_KEY` | **No change** — already has encryption key |
| `pipeline-engine` | `ENCRYPTION_MASTER_KEY`, `JWT_SECRET` | **No change**                              |

**Observation:** Studio and Runtime are NOT in `docker-compose.yml` — they run on the host during development. This means docker-compose does not need `OAUTH_PROVIDER_*` or `CHANNEL_OAUTH_*` variables today, and removing them from `.env.example` files has no docker-compose impact.

### 5.2 New Environment Variables for docker-compose

Only one new variable is recommended:

```yaml
# On workflow-engine and pipeline-engine (if they need to resolve Auth Profiles):
FEATURE_AUTH_PROFILES: ${FEATURE_AUTH_PROFILES:-false}
```

**Workflow-engine** needs `ENCRYPTION_MASTER_KEY` already (has it). If workflow-engine resolves Auth Profiles for workflow connections, no additional configuration is needed.

### 5.3 No New Volumes or Secrets Mounts

Auth Profile stores all credentials in MongoDB (encrypted). No new file mounts, secrets volumes, or sidecar containers are needed.

### 5.4 Production Docker Impact (Dockerfiles)

The existing Dockerfiles for all apps (`apps/runtime/Dockerfile`, `apps/studio/Dockerfile`, etc.) do not embed env vars — they receive them at runtime via Kubernetes or docker-compose. No Dockerfile changes are needed for Auth Profile.

---

## 6. Configuration Files Impact

### 6.1 `.env.example` Files Requiring Updates

| File                           | Changes Needed                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example` (root)          | Add `FEATURE_AUTH_PROFILES=false`                                                                                                     |
| `apps/studio/.env.example`     | Add `FEATURE_AUTH_PROFILES=false`; add deprecation comments to `OAUTH_PROVIDER_*` section                                             |
| `apps/runtime/.env.example`    | Add `FEATURE_AUTH_PROFILES=false`; add deprecation comments to `CHANNEL_OAUTH_*` section; add deprecation comments to LLM key section |
| `apps/admin/.env.example`      | No changes needed                                                                                                                     |
| Other app `.env.example` files | No changes needed (crawler, MCP server, preprocessing, telco-noc have no auth credential env vars)                                    |

### 6.2 Helm / Kubernetes Impact

Helm charts and Kubernetes manifests are maintained in the separate `abl-platform-deploy` repository (per `CLAUDE.md`). The following changes will be needed there:

| Item                              | Change                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| ConfigMap or Deployment env       | Add `FEATURE_AUTH_PROFILES` to Studio and Runtime deployments                   |
| Kubernetes Secret                 | Remove `OAUTH_PROVIDER_*` and `CHANNEL_OAUTH_*` entries after migration Phase 4 |
| ENCRYPTION_MASTER_KEY             | No change — already configured                                                  |
| Sealed Secrets / External Secrets | No change — Auth Profile secrets are in MongoDB, not in K8s secrets             |

**Note:** Since all OAuth credentials move from K8s secrets/env vars to MongoDB (encrypted), this actually **reduces** the Kubernetes secrets surface area. Fewer K8s Secret objects need to be managed by the platform team.

### 6.3 No Config Maps Impact

Auth Profile configuration (auth types, addon mechanisms) is defined in the application code (TypeScript types), not in config maps.

---

## 7. Risk Assessment & Recommendations

### 7.1 Critical Risks

| Risk                                                                                                                                        | Severity | Mitigation                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| **Encryption key rotation gap**: `EncryptionService` supports only one key at a time, but Auth Profile design assumes multi-version support | HIGH     | Extend `EncryptionService` to accept `{ current: key, previous: key[] }` before implementing rotation features |
| **Key inconsistency across services**: Studio/Runtime on host may use different or missing `ENCRYPTION_MASTER_KEY`                          | MEDIUM   | Add startup validation in both apps (fail-fast if key is missing or mismatched)                                |
| **Migration requires env var seeding**: Existing `OAUTH_PROVIDER_*` credentials in env vars must be converted to Auth Profile documents     | MEDIUM   | Migration script (Phase 2) must read env vars and create `oauth2_app` profiles. Document this clearly.         |

### 7.2 Operational Improvements

| Improvement                        | Description                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reduced secrets sprawl**         | ~22 env vars eliminated; OAuth credentials managed in DB with encryption, audit trail, and expiration                                             |
| **No more cross-app env var sync** | Currently `OAUTH_PROVIDER_*` must be set in Studio and `CHANNEL_OAUTH_*` in Runtime separately for the same providers. Auth Profile unifies this. |
| **Vault integration ready**        | Existing vault providers can source `ENCRYPTION_MASTER_KEY`; Auth Profile inherits this without additional vault configuration                    |
| **Simpler onboarding**             | New developers set one key (`ENCRYPTION_MASTER_KEY`) instead of configuring 10+ OAuth provider env vars                                           |

### 7.3 Recommendations

1. **Add startup encryption key validation** to Studio and Runtime. Currently neither validates the key at boot — they only fail when first attempting encryption/decryption. Add a health check that verifies `ENCRYPTION_MASTER_KEY` is set and valid (64 hex chars).

2. **Formalize the feature flag** as `FEATURE_AUTH_PROFILES` across all `.env.example` files before starting implementation.

3. **Do NOT remove obsolete env vars from `.env.example` until Phase 4.** During Phase 1-3, add deprecation comments (e.g., `# DEPRECATED: Will be replaced by Auth Profile in a future release`).

4. **Create a migration seed script** that reads `OAUTH_PROVIDER_*` and `CHANNEL_OAUTH_*` env vars and creates corresponding `oauth2_app` Auth Profiles in MongoDB. This bridges the gap between env-var-based configuration and database-backed Auth Profile.

5. **Extend EncryptionService for multi-key support** before implementing Auth Profile rotation features. Without this, the `encryptionKeyVersion`, `previousEncryptedSecrets`, and `rotationGracePeriodMs` fields are non-functional.

6. **Voice service credentials** (Twilio, Deepgram, ElevenLabs, LiveKit) should be noted as future Auth Profile candidates in the design document but explicitly excluded from scope.

7. **Update the `abl-platform-deploy` repo** to remove OAuth env var secrets from K8s manifests after Phase 4 is complete.

---

## 8. Appendix: Complete Env Var Disposition Matrix

| Variable                             | App            | Stays   | Obsolete | Notes                                             |
| ------------------------------------ | -------------- | ------- | -------- | ------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY`              | All            | YES     |          | Core infrastructure                               |
| `JWT_SECRET`                         | All            | YES     |          | Inter-service auth                                |
| `INTERNAL_API_KEY`                   | Runtime        | YES     |          | Service auth                                      |
| `NEXTAUTH_SECRET`                    | Studio         | YES     |          | Session management                                |
| `NEXTAUTH_URL`                       | Studio         | YES     |          | NextAuth config                                   |
| `GOOGLE_CLIENT_ID`                   | Studio         | YES     |          | Platform login                                    |
| `GOOGLE_CLIENT_SECRET`               | Studio         | YES     |          | Platform login                                    |
| `GITHUB_CLIENT_ID`                   | Studio         | YES     |          | Platform login                                    |
| `GITHUB_CLIENT_SECRET`               | Studio         | YES     |          | Platform login                                    |
| `OAUTH_PROVIDER_*_CLIENT_ID`         | Studio         |         | YES      | -> `oauth2_app` Auth Profile                      |
| `OAUTH_PROVIDER_*_CLIENT_SECRET`     | Studio         |         | YES      | -> `oauth2_app` Auth Profile                      |
| `CHANNEL_OAUTH_SLACK_CLIENT_ID`      | Runtime        |         | YES      | -> `oauth2_app` Auth Profile                      |
| `CHANNEL_OAUTH_SLACK_CLIENT_SECRET`  | Runtime        |         | YES      | -> `oauth2_app` Auth Profile                      |
| `CHANNEL_OAUTH_SLACK_SIGNING_SECRET` | Runtime        |         | YES      | -> `webhookVerification` addon                    |
| `CHANNEL_OAUTH_SLACK_SCOPES`         | Runtime        |         | YES      | -> Auth Profile `config`                          |
| `CHANNEL_OAUTH_MSTEAMS_*`            | Runtime        |         | YES      | -> `oauth2_app` Auth Profile                      |
| `CHANNEL_OAUTH_META_*`               | Runtime        |         | YES      | -> `oauth2_app` Auth Profile                      |
| `CHANNEL_OAUTH_WHATSAPP_SCOPES`      | Runtime        |         | YES      | -> Auth Profile `config`                          |
| `CHANNEL_OAUTH_MESSENGER_SCOPES`     | Runtime        |         | YES      | -> Auth Profile `config`                          |
| `ANTHROPIC_API_KEY`                  | Studio         | YES\*   |          | \*Arch AI fallback; should eventually migrate     |
| `ANTHROPIC_API_KEY`                  | Runtime        |         | YES      | -> `api_key` Auth Profile                         |
| `OPENAI_API_KEY`                     | Runtime        |         | YES      | -> `api_key` Auth Profile                         |
| `GOOGLE_AI_API_KEY`                  | Runtime        |         | YES      | -> `api_key` Auth Profile                         |
| `AZURE_OPENAI_API_KEY`               | Runtime        |         | YES      | -> `azure_ad` Auth Profile                        |
| `AZURE_OPENAI_ENDPOINT`              | Runtime        |         | YES      | -> Auth Profile `config`                          |
| `AWS_BEDROCK_REGION`                 | Runtime        | PARTIAL |          | Region config may stay; credentials via `aws_iam` |
| `TWILIO_*` (5 vars)                  | Runtime/Studio | YES     |          | Out of scope                                      |
| `DEEPGRAM_*` (3 vars)                | Runtime        | YES     |          | Out of scope                                      |
| `ELEVENLABS_*` (3 vars)              | Runtime        | YES     |          | Out of scope                                      |
| `LIVEKIT_*` (5 vars)                 | Runtime        | YES     |          | Out of scope                                      |
| `VAULT_ADDR`                         | Config pkg     | YES     |          | Vault infrastructure                              |
| `VAULT_TOKEN`                        | Config pkg     | YES     |          | Vault infrastructure                              |
| `AZURE_KEYVAULT_URL`                 | Config pkg     | YES     |          | Vault infrastructure                              |
| `AWS_SECRET_NAME`                    | Config pkg     | YES     |          | Vault infrastructure                              |
| `K8S_SECRETS_PATH`                   | Config pkg     | YES     |          | Vault infrastructure                              |
| `SANDBOX_JWT_SECRET`                 | Runtime        | YES     |          | Sandbox auth                                      |
| `PREVIEW_TOKEN_SECRET`               | Studio         | YES     |          | SDK preview tokens                                |
| `DEBUG_SERVICE_SECRET`               | Studio         | YES     |          | Debug endpoint auth                               |
| `FEATURE_AUTH_PROFILES`              | Studio/Runtime | **NEW** |          | Migration feature flag                            |
