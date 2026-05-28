# Auth Profile — Phased Implementation Roadmap

**Date:** 2026-03-17
**Status:** Active
**Scope:** All remaining auth profile gaps — wiring, hardening, DSL, preflight consent, JIT auth
**Index:** See [AUTH-PROFILE-INDEX.md](./AUTH-PROFILE-INDEX.md) for document map

---

## What's Already Done

| Feature                                                                 | Where                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| AuthProfile Mongoose model (17 auth types, encryption, audit trail)     | `packages/database/src/models/auth-profile.model.ts`           |
| CRUD API (project + workspace scoped, 13 route files)                   | `apps/studio/src/app/api/**/auth-profiles/`                    |
| Studio UI (list, create/edit slide-over, status badges, picker, toggle) | `apps/studio/src/components/auth-profiles/` (8 components)     |
| OAuth flow (initiate, callback, user-consent)                           | Studio API routes + `AuthProfileOAuthDialog.tsx`               |
| KMS encryption (encrypt/decrypt encryptedSecrets, encryption plugin)    | `packages/database/src/mongo/plugins/encryption.plugin.ts`     |
| Multi-agent auth propagation (handoff, delegate, fan-out)               | `apps/runtime/src/services/execution/auth-profile-*.ts`        |
| Import/export auth mapping                                              | `packages/project-io/src/import/auth-mapping.ts`               |
| Pod-local cache (LRU, 200 entries, 5min TTL)                            | `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` |
| Dual-read migration pattern                                             | `packages/shared-auth-profile/src/dual-read.ts`                |
| `applyAuth()` with 17 auth type dispatchers + 5 addon enrichers         | `packages/shared-auth-profile/src/apply-auth.ts`               |
| Token refresh with distributed lock                                     | `packages/shared-auth-profile/src/token-refresh-service.ts`    |
| 27 test files across runtime, database, shared, search-ai, project-io   | See index                                                      |

---

## Phased Plan

### Phase 1: Hardening & Wiring (Security-First)

> **Goal:** Fix critical security issues and connect existing unwired code. Zero new features — just make what's already built actually work.
>
> **Estimated effort:** 3–4 days
>
> **Dependencies:** None — all code exists, just needs wiring/fixing.

#### 1A. Critical Security Fixes

| #   | Task                                                                                              | Files                                                                                                                              | Test                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1.1 | **SSRF in validate endpoint** — add `validateUrlForSSRF()` on `config.tokenUrl` before `fetch()`  | `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts`                                                | Unit: SSRF URL blocked → 400; internal IP → 400; valid URL → proceeds                                              |
| 1.2 | **SSRF in OAuth callback** — re-validate `tokenUrl` from app profile before fetch                 | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`                                                      | Unit: internal IP in tokenUrl → 400                                                                                |
| 1.3 | **Cascade delete protection** — query all 16 entity models for `authProfileId` refs before delete | `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts`, `packages/shared/src/services/auth-profile.service.ts` | Integration: profile with 2 consumers → DELETE returns 409 with counts; profile with 0 consumers → DELETE succeeds |
| 1.4 | **Redis soft-fail in user-consent** — return 503 when Redis unavailable                           | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts`                                                  | Unit: Redis down → 503, not silent success                                                                         |

**Acceptance:** `pnpm test --filter=studio` passes. Semgrep clean on touched files.

#### 1B. Rotation Job Wiring

| #   | Task                                                                                                                                                                             | Files                                                                             | Test                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1.5 | **Create start/stop wrapper** following KMS pattern — `startAuthProfileRotationJob()` / `stopAuthProfileRotationJob()` with `AUTH_ROTATION_INTERVAL_MS` env var (default 300000) | `apps/runtime/src/services/auth-profile/auth-profile-rotation-scheduler.ts` (new) | Unit: `startAuthProfileRotationJob()` returns handle with `stop()`       |
| 1.6 | **Wire into server.ts startup** after KMS rotation job (line ~1619)                                                                                                              | `apps/runtime/src/server.ts`                                                      | Integration: server starts → rotation job running; SIGTERM → job stopped |
| 1.7 | **Wire into server.ts shutdown** handler (line ~1862)                                                                                                                            | `apps/runtime/src/server.ts`                                                      | Same as above                                                            |

**Pattern to follow** (existing KMS wiring in server.ts):

```typescript
// Startup:
const { startKMSRotationJob } = await import('./services/kms/kms-rotation-job.js');
startKMSRotationJob({ intervalMinutes: ... });

// Shutdown:
const { stopKMSRotationJob } = await import('./services/kms/kms-rotation-job.js');
stopKMSRotationJob();
```

#### 1C. Grace Period Wiring

| #   | Task                                                                                                                                                                   | Files                                                           | Test                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1.8 | **Replace `JSON.parse(profile.encryptedSecrets)`** in resolver with `resolveWithGracePeriod(profile, decrypt)` from `packages/shared-auth-profile/src/grace-period.ts` | `apps/runtime/src/services/auth-profile-resolver.ts` (line ~63) | Integration: profile with stale primary key + valid `previousEncryptedSecrets` within grace period → resolves; both expired → throws |
| 1.9 | **Same change in search-ai resolver** if it exists                                                                                                                     | `apps/search-ai/src/services/auth-profile-resolver.ts`          | Same pattern                                                                                                                         |

#### 1D. Important Hardening Fixes

| #    | Task                                                                                                                         | Files                                                                    | Test                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1.10 | **Fix encryption/lean asymmetry** in GET handlers — verify encryption plugin with `.lean()`                                  | Auth profile list and detail GET routes                                  | Unit: GET returns decrypted config, not ciphertext                        |
| 1.11 | **Compute linkedConsumerCount** — replace hardcoded `0` in list response                                                     | List route + `/consumers` endpoint                                       | Integration: profile with 3 consumers → count = 3                         |
| 1.12 | **Standardize error handling** across 10 wired consumers — null return with `authProfileId` set = throw, not silent fallback | `connection-resolver`, `pipeline-factory`, `git-credentials`, `arch-llm` | Unit: per consumer — authProfileId set + profile not found → error thrown |
| 1.13 | **Replace `console.error` in MCP server registry**                                                                           | `apps/runtime/src/services/mcp/mcp-server-registry.ts`                   | Grep: zero `console.error` in file                                        |
| 1.14 | **Add lastUsedAt update** to model-resolution inline resolver (same debounced pattern)                                       | Model resolution resolver                                                | Unit: resolver call → `lastUsedAt` updated (debounced)                    |

**Phase 1 exit criteria:**

- [ ] All 14 tasks pass tests
- [ ] `pnpm build` clean
- [ ] `pnpm test` — runtime, studio, shared all pass
- [ ] `./tools/run-semgrep.sh` clean on touched files
- [ ] Rotation job starts on server boot, stops on SIGTERM
- [ ] Grace period fallback works end-to-end

#### Phase 1 Integration Scenarios

**IS-1.1: SSRF blocked on validate**

- [ ] Create auth profile with `config.tokenUrl = "http://169.254.169.254/latest/meta-data/"` (AWS metadata)
- [ ] `POST /api/projects/:id/auth-profiles/:profileId/validate` → 400 with SSRF error
- [ ] Same with `http://127.0.0.1:6379` (Redis), `http://10.0.0.1` (internal) → 400
- [ ] Valid external URL `https://oauth.provider.com/token` → proceeds normally

**IS-1.2: SSRF blocked on OAuth callback**

- [ ] Create oauth2_app profile where `tokenUrl` is internal IP
- [ ] OAuth callback with valid `code` → token exchange blocked → 400
- [ ] oauth2_app with valid external `tokenUrl` → exchange succeeds

**IS-1.3: Cascade delete prevents orphaned references**

- [ ] Create auth profile P1, create ServiceNode referencing P1 via `authProfileId`
- [ ] `DELETE /api/projects/:id/auth-profiles/P1` → 409 with `{ consumers: [{ type: 'ServiceNode', count: 1 }] }`
- [ ] Delete the ServiceNode → `DELETE P1` → 200 success
- [ ] Create profile P2 with zero consumers → `DELETE P2` → 200 success immediately

**IS-1.4: Redis down doesn't silently break consent**

- [ ] Stop Redis, call `POST /api/projects/:id/auth-profiles/oauth/user-consent` → 503
- [ ] Start Redis, same call → 200 (or normal flow)

**IS-1.5: Rotation job lifecycle**

- [ ] Start runtime server → logs show `[auth-profile-rotation] Job started, interval: 300000ms`
- [ ] Create auth profile with old `encryptionKeyVersion` → wait for rotation interval → profile re-encrypted with current key version
- [ ] `previousEncryptedSecrets` populated with old ciphertext
- [ ] SIGTERM → logs show `[auth-profile-rotation] Job stopped`
- [ ] Set `AUTH_ROTATION_INTERVAL_MS=60000` → job runs every 60s

**IS-1.6: Grace period fallback during key rotation**

- [ ] Profile has `encryptedSecrets` encrypted with key v2, `previousEncryptedSecrets` with key v1
- [ ] KMS rotates to key v3, primary decryption fails (v2 not yet re-encrypted)
- [ ] `resolveWithGracePeriod()` falls back to `previousEncryptedSecrets` (v1) within grace window → credentials resolve
- [ ] Grace period expires → both fail → error thrown (not silent null)

**IS-1.7: Consumer count accuracy**

- [ ] Profile used by 2 ServiceNodes + 1 ConnectorConnection → list API shows `linkedConsumerCount: 3`
- [ ] Delete one ServiceNode → count drops to 2
- [ ] Profile with zero consumers → `linkedConsumerCount: 0`

**IS-1.8: Consumer error handling standardization**

- [ ] ServiceNode with `authProfileId` set to a non-existent profile ID → tool execution throws clear error (not silent fallback to no auth)
- [ ] ServiceNode with `authProfileId` set to a revoked profile → throws with `AUTH_PROFILE_REVOKED` error code
- [ ] ServiceNode with no `authProfileId` → uses legacy auth path (no change)

---

### Phase 2: Runtime Name Resolution + DSL Integration

> **Goal:** Enable DSL authors to reference auth profiles by name. This is the prerequisite for both preflight consent and JIT auth.
>
> **Estimated effort:** 4–5 days
>
> **Dependencies:** Phase 1 (grace period wiring needed for resolution chain).

#### 2A. Name-Based Resolution

| #   | Task                                                                                                                                                                                                                                      | Files                                                          | Test                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | **Add `resolveByName(name, tenantId, environment?)`** — query: `findOne({ name, tenantId, status: 'active', $or: [{ expiresAt: { $gt: now } }, { expiresAt: null }] })`. Environment: exact match first, fallback to `environment: null`. | `apps/runtime/src/services/auth-profile-resolver.ts`           | Integration: resolve by name + tenantId → correct profile; wrong tenant → null; expired → null; environment fallback works |
| 2.2 | **Same in search-ai resolver**                                                                                                                                                                                                            | `apps/search-ai/src/services/auth-profile-resolver.ts`         | Same pattern                                                                                                               |
| 2.3 | **Cache integration** — `AuthProfileCache` key includes name-based lookups                                                                                                                                                                | `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` | Unit: name-based resolve caches; invalidate by name works                                                                  |

#### 2B. DSL Parser + AST

| #   | Task                                                                                                            | Files                                                                                    | Test                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2.4 | **Add `auth_profile` to tool AST types** — `authProfileRef?: string` on `ToolDefinition`                        | `packages/core/src/types/agent-based.ts`                                                 | Type-level                                                              |
| 2.5 | **Parse `auth_profile:` property** in tool-file-parser switch (line ~305) — new case alongside existing `auth:` | `packages/core/src/parser/tool-file-parser.ts`                                           | Unit: `auth_profile: "my-creds"` → AST has `authProfileRef: "my-creds"` |
| 2.6 | **Parse `auth_jit: true`** property — `jitAuth?: boolean` on AST                                                | `packages/core/src/parser/tool-file-parser.ts`, `packages/core/src/types/agent-based.ts` | Unit: `auth_jit: true` → AST has `jitAuth: true`                        |

#### 2C. Compiler IR + Builder

| #   | Task                                                                                                                                                  | Files                                                      | Test                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| 2.7 | **Add `authProfileRef?: string` and `jitAuth?: boolean`** to `ToolDefinition` in IR schema                                                            | `packages/compiler/src/platform/ir/schema.ts`              | Type-level                                                        |
| 2.8 | **Emit `authProfileRef`** in auth-config-builder when AST has `authProfileRef` — `auth_profile` takes precedence over inline `auth` when both present | `packages/compiler/src/platform/ir/auth-config-builder.ts` | Unit: DSL with `auth_profile: "x"` → IR has `authProfileRef: "x"` |
| 2.9 | **Compile-time validation** — warn (not error) if tool has `auth_jit: true` but no `auth_profile`                                                     | `packages/compiler/src/platform/ir/validate-preflight.ts`  | Unit: `auth_jit` without `auth_profile` → warning diagnostic      |

#### 2D. Runtime Tool Executor Integration

| #    | Task                                                                                                                          | Files                                                                                       | Test                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 2.10 | **Tool executor reads `authProfileRef`** from IR — if present, call `resolveByName()` and apply credentials via `applyAuth()` | `apps/runtime/src/services/adapters/service-node-executor.ts` (or equivalent tool executor) | Integration: DSL with `auth_profile: "staging-key"` → compiles → runtime resolves → HTTP call includes auth headers |
| 2.11 | **`auth_profile` precedence** — when both `auth:` and `auth_profile:` present, `auth_profile` wins                            | Same file                                                                                   | Unit: both set → authProfileRef used                                                                                |

#### 2E. Config Variable Resolution

| #    | Task                                                                                                                                     | Files                                                                                                           | Test                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 2.12 | **Detect `{{config.*}}` pattern** in `authProfileRef` — compiler preserves as template string, runtime resolves before `resolveByName()` | `packages/compiler/src/platform/ir/auth-config-builder.ts` (compile-time), runtime tool executor (resolve-time) | Integration: `auth_profile: "{{config.AUTH_PROFILE}}"` → config var resolves to profile name → profile resolves |

**Phase 2 exit criteria:**

- [ ] DSL `auth_profile: "name"` compiles to IR with `authProfileRef`
- [ ] DSL `auth_jit: true` compiles to IR with `jitAuth: true`
- [ ] Runtime resolves auth profiles by name with tenant isolation
- [ ] Config variable interpolation works end-to-end
- [ ] `pnpm build && pnpm test` — compiler, runtime, core all pass
- [ ] 3,947+ compiler tests still pass (no regressions)

#### Phase 2 Integration Scenarios

**IS-2.1: DSL → Compile → Resolve → HTTP call (happy path)**

- [ ] Write tool DSL: `auth_profile: "staging-api-key"`, `endpoint: https://httpbin.org/headers`
- [ ] Create auth profile named `"staging-api-key"` (type: `api_key`, header: `X-API-Key`, value: `test-123`)
- [ ] Compile DSL → IR has `authProfileRef: "staging-api-key"`
- [ ] Runtime loads IR, tool executes → HTTP request includes `X-API-Key: test-123` header
- [ ] Response confirms header was sent

**IS-2.2: Name resolution with tenant isolation**

- [ ] Tenant A creates profile named `"shared-creds"`
- [ ] Tenant B creates profile named `"shared-creds"` (same name, different tenant)
- [ ] Runtime resolving for Tenant A → gets Tenant A's profile (not B's)
- [ ] Runtime resolving for Tenant C (no such profile) → null (not cross-tenant leak)

**IS-2.3: Environment-based resolution fallback**

- [ ] Create profile `"api-creds"` with `environment: "staging"` and secret `staging-key`
- [ ] Create profile `"api-creds"` with `environment: null` (default) and secret `default-key`
- [ ] Resolve with `environment: "staging"` → gets `staging-key`
- [ ] Resolve with `environment: "production"` (no match) → falls back to default → gets `default-key`
- [ ] Resolve with `environment: "staging"` when staging profile is expired → falls back to default

**IS-2.4: auth_profile precedence over inline auth**

- [ ] DSL tool has both `auth: bearer` (inline) and `auth_profile: "my-profile"` (profile ref)
- [ ] Compile + run → `auth_profile` wins, inline `auth: bearer` ignored
- [ ] Remove `auth_profile:` line → recompile → inline `auth: bearer` takes effect

**IS-2.5: auth_jit compiles but doesn't execute yet (Phase 5)**

- [ ] DSL tool: `auth_profile: "google-oauth"`, `auth_jit: true`
- [ ] Compile → IR has `jitAuth: true` and `authProfileRef: "google-oauth"`
- [ ] Runtime loads IR → if token missing and `jitAuth: true` → tool fails with descriptive error (not crash) — JIT pause/resume is Phase 5

**IS-2.6: Config variable interpolation end-to-end**

- [ ] DSL: `auth_profile: "{{config.AUTH_PROFILE}}"`
- [ ] Project config var `AUTH_PROFILE = "prod-api-key"`
- [ ] Create profile named `"prod-api-key"`
- [ ] Compile → IR has `authProfileRef: "{{config.AUTH_PROFILE}}"` (preserved as template)
- [ ] Runtime resolves config var → `"prod-api-key"` → resolves profile → credentials applied
- [ ] Change config var to `"staging-api-key"` (different profile) → next execution uses new profile (no recompile needed)

**IS-2.7: Compile-time validation warnings**

- [ ] DSL tool: `auth_jit: true` but no `auth_profile:` → compiler emits WARNING (not error): "auth_jit requires auth_profile"
- [ ] DSL tool: `auth_profile: "x"` without `auth_jit` → compiles clean (no warning needed)
- [ ] DSL tool: `auth_profile: "x"` with `auth_jit: true` → compiles clean

**IS-2.8: Cache behavior for name-based lookups**

- [ ] First resolve by name → DB query executed, result cached
- [ ] Second resolve (same name, same tenant, within 5min) → cache hit, no DB query
- [ ] Update profile (change secret) → cache invalidated → next resolve hits DB with fresh data
- [ ] Cache at 200 entries → 201st entry evicts oldest

---

### Phase 3: mTLS + Bulk Actions + Infrastructure Gaps

> **Goal:** Complete the remaining Phase 1 wiring gaps and fix infrastructure issues.
>
> **Estimated effort:** 3–4 days
>
> **Dependencies:** Phase 1 (rotation wiring needed for infra gaps 5 & 6).

#### 3A. mTLS TLS Agent Wiring

| #   | Task                                                                                                                                                              | Files                                                                                        | Test                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 3.1 | **Tool executor reads `tlsOptions`** from `applyAuth()` result — creates `new https.Agent({ cert, key, ca, rejectUnauthorized: true })` and passes to HTTP client | Runtime HTTP tool executor                                                                   | Integration: mTLS auth profile → HTTPS request includes client certificate |
| 3.2 | **Studio mTLS form fields** — cert upload, key upload, CA upload in auth profile create/edit (auth type `mtls`)                                                   | `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`, `auth-type-metadata.ts` | Manual: create mTLS profile with cert files → saved correctly              |

#### 3B. Bulk Actions API

| #   | Task                                                                                                                                                                   | Files                                                                     | Test                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 3.3 | **`POST /api/projects/:id/auth-profiles/bulk`** — accepts `{ action: 'delete' \| 'revoke' \| 'activate', profileIds: string[] }`, max 50, tenant isolation per profile | `apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts` (new) | Integration: bulk delete 3 profiles → all removed; cross-tenant profile in batch → 404; >50 → 400 |
| 3.4 | **Workspace-level bulk** — same at workspace scope                                                                                                                     | `apps/studio/src/app/api/auth-profiles/bulk/route.ts` (new)               | Same pattern                                                                                      |
| 3.5 | **Cascade check on bulk delete** — reuse cascade check from 1.3 per profile                                                                                            | Same route files                                                          | Integration: bulk delete with consumer → 409 per profile, others proceed                          |

#### 3C. Infrastructure Gaps (from infra-gaps plan)

| #    | Task                                                                                 | Files                                                       | Source      |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------- |
| 3.6  | **SDKChannel.secretKey encryption** — migrate plain-text to encrypted field          | `packages/database/src/models/sdk-channel.model.ts`         | Infra Gap 2 |
| 3.7  | **TokenManager uses AuthProfile** — stop bypassing auth profile path                 | `packages/connectors/base/src/auth/token-manager.ts`        | Infra Gap 3 |
| 3.8  | **Audit trail redacts ciphertext** — sanitize encrypted fields before logging        | `packages/database/src/mongo/plugins/audit-trail.plugin.ts` | Infra Gap 4 |
| 3.9  | **CredentialAgeMonitor queries AuthProfile** — uses `rotationStartedAt` from Phase 1 | `apps/runtime/src/services/credential-age-monitor.ts`       | Infra Gap 5 |
| 3.10 | **VoiceServiceFactory cache invalidation** on auth profile rotation                  | `apps/runtime/src/services/voice/voice-service-factory.ts`  | Infra Gap 6 |

**Phase 3 exit criteria:**

- [ ] mTLS profiles create HTTPS agent with client certs
- [ ] Bulk actions work with tenant isolation and cascade protection
- [ ] 5 infrastructure gaps resolved
- [ ] `pnpm build && pnpm test` clean

#### Phase 3 Integration Scenarios

**IS-3.1: mTLS tool call end-to-end**

- [ ] Create auth profile type `mtls` with client cert, key, and CA cert
- [ ] DSL tool: `auth_profile: "mtls-profile"`, `endpoint: https://mtls-server.example.com/api`
- [ ] Runtime resolves profile → `applyAuth()` returns `tlsOptions: { cert, key, ca }`
- [ ] Tool executor creates `https.Agent` with client cert → HTTPS request succeeds
- [ ] Same call without mTLS profile → server rejects (no client cert)
- [ ] Expired client cert → TLS handshake fails → clear error (not crash)

**IS-3.2: Studio mTLS profile creation**

- [ ] Open auth profile create slide-over → select type `mtls`
- [ ] Upload client cert (.pem), client key (.pem), CA cert (.pem)
- [ ] Save → profile stored with encrypted secrets
- [ ] Edit → cert fields show "Certificate uploaded" (not the raw PEM)
- [ ] Re-upload new cert → saves correctly, old cert replaced

**IS-3.3: Bulk delete with mixed outcomes**

- [ ] Create profiles P1 (0 consumers), P2 (2 consumers), P3 (0 consumers)
- [ ] `POST /api/projects/:id/auth-profiles/bulk` with `{ action: "delete", profileIds: [P1, P2, P3] }`
- [ ] Response: `{ results: [{ id: P1, status: "ok" }, { id: P2, status: "error", error: "Has 2 consumers" }, { id: P3, status: "ok" }] }`
- [ ] P1 and P3 deleted, P2 still exists

**IS-3.4: Bulk actions tenant isolation**

- [ ] Tenant A creates profiles PA1, PA2
- [ ] Tenant B creates profile PB1
- [ ] Tenant A calls bulk delete with `[PA1, PB1]` → PA1 deleted, PB1 returns 404 (not 403)
- [ ] PB1 still exists for Tenant B

**IS-3.5: Bulk revoke and activate**

- [ ] Create 3 active profiles
- [ ] Bulk revoke all 3 → all status = `revoked`
- [ ] Bulk activate all 3 → all status = `active`
- [ ] Bulk revoke 1 expired profile → status stays `expired` (can't revoke what's already expired) or returns error

**IS-3.6: Bulk action limits**

- [ ] Call bulk with 50 profile IDs → succeeds
- [ ] Call bulk with 51 profile IDs → 400 "Maximum 50 profiles per request"
- [ ] Call bulk with 0 profile IDs → 400 "At least 1 profile required"

**IS-3.7: SDKChannel secret encryption migration**

- [ ] Existing SDKChannel with plain-text `secretKey` in DB
- [ ] After migration: `secretKey` is encrypted, read via API still returns plain-text (decrypted)
- [ ] New SDKChannel creation → `secretKey` encrypted at rest from creation

**IS-3.8: TokenManager uses AuthProfile path**

- [ ] Connector with `authProfileId` set → TokenManager resolves via auth profile (not legacy direct path)
- [ ] Token refresh cycle uses AuthProfile's `tokenRefreshService` with distributed lock
- [ ] Connector without `authProfileId` → legacy path still works (backward compat)

**IS-3.9: Audit trail no longer leaks ciphertext**

- [ ] Update auth profile secrets → audit trail event logged
- [ ] Inspect audit trail entry → `encryptedSecrets` field shows `"[REDACTED]"` not ciphertext
- [ ] Non-sensitive fields (name, status, config) still appear in audit trail

**IS-3.10: Credential age monitoring with AuthProfile**

- [ ] Auth profile with `rotationStartedAt` 30 days ago → CredentialAgeMonitor flags as stale
- [ ] Auth profile with `rotationStartedAt` 1 day ago → no alert
- [ ] Auth profile without `rotationStartedAt` (never rotated) → flags as "never rotated"

---

### Phase 4: Preflight Consent (Compiler + Runtime + UI)

> **Goal:** When a user opens a chat, prompt for all required OAuth consents upfront before the session starts.
>
> **Estimated effort:** 8–10 days
>
> **Dependencies:** Phase 2 (DSL `auth_profile` + name resolution required). Phase 1 (rotation/grace period for token validation).
>
> **Design refs:** GAP-3.1 through GAP-3.4

#### 4A. Compiler IR — Auth Requirement Collection (GAP-3.2 Phase 1)

| #   | Task                                                                                                                                                     | Files                                                                                    | Test                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 4.1 | **Add `AuthRequirementIR` type** — `{ connector, authProfileRef, scopes, connectionMode: 'per_user' \| 'shared', consentMode: 'preflight' \| 'inline' }` | `packages/compiler/src/platform/ir/schema.ts`                                            | Type-level                                                                   |
| 4.2 | **DSL `connection:` and `consent:` properties** on tools                                                                                                 | `packages/core/src/parser/tool-file-parser.ts`, `packages/core/src/types/agent-based.ts` | Unit: `connection: per_user, consent: preflight` → AST correct               |
| 4.3 | **`AuthRequirementCollector` post-compilation pass** — walks all agents/tools in IR, collects unique auth requirements, deduplicates scopes per provider | `packages/compiler/src/platform/ir/auth-requirement-collector.ts` (new)                  | Unit: project with 3 tools using 2 providers → 2 `AuthRequirementIR` entries |
| 4.4 | **Emit `authRequirements[]` on project IR**                                                                                                              | Compiler output                                                                          | Integration: full compile → IR contains auth requirements                    |

#### 4B. Runtime Preflight Check (GAP-3.1)

| #   | Task                                                                                                                                                                                                                     | Files                                            | Test                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------- |
| 4.5 | **Auth preflight check in session start** — on WebSocket `load_agent`, check `authRequirements` from compiled IR, resolve existing tokens per user, determine which are `pending` vs `satisfied`                         | `apps/runtime/src/websocket/handler.ts`          | Integration: load agent with 2 preflight connectors → returns pending list |
| 4.6 | **`auth_required` WebSocket event** — `{ type: 'auth_required', pending: AuthRequirement[], satisfied: AuthRequirement[] }`                                                                                              | `apps/runtime/src/websocket/handler.ts`          | Unit: event sent with correct structure                                    |
| 4.7 | **Auth gate session state** — session starts in `auth_pending` state, blocks message processing until all preflight connectors satisfied                                                                                 | `apps/runtime/src/websocket/handler.ts`          | Integration: send_message while auth_pending → held until satisfied        |
| 4.8 | **Consent satisfaction endpoint** — `POST /api/runtime/sessions/:sessionId/consent` — marks connector as satisfied, sends `auth_gate_updated` WS event. When all done, sends `auth_gate_satisfied` and unblocks session. | `apps/runtime/src/routes/chat.ts` (or new route) | Integration: satisfy all connectors → session unblocked                    |
| 4.9 | **Same for SDK handler**                                                                                                                                                                                                 | `apps/runtime/src/websocket/sdk-handler.ts`      | Same pattern                                                               |

#### 4C. Consent Persistence (GAP-3.3)

| #    | Task                                                                                                                                                 | Files                                                                    | Test                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 4.10 | **`ConsentStateResolver`** — 3-tier token lookup: (1) session-scoped token, (2) user-scoped token (contact identity), (3) tenant-scoped shared token | `apps/runtime/src/services/auth-profile/consent-state-resolver.ts` (new) | Integration: user has existing Google token → preflight skips Google; no token → pending |
| 4.11 | **Contact identity mapping** — map end-user WebSocket session to a stable identity for cross-session token reuse                                     | Depends on existing session identity model                               | Integration: same user in new session → previous tokens still valid                      |

#### 4D. Studio Batch Consent UI (GAP-3.4)

| #    | Task                                                                                                                        | Files                                                                    | Test                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 4.12 | **`BatchConsentGate` component** — wraps chat panel, renders consent UI or children based on auth gate state                | `apps/studio/src/components/auth-profiles/BatchConsentGate.tsx` (new)    | Unit: `auth_required` with pending → shows consent UI; no pending → renders children |
| 4.13 | **`BatchConsentPanel`** — header with progress bar, connector list, footer with Continue/Skip                               | `apps/studio/src/components/auth-profiles/BatchConsentPanel.tsx` (new)   | Unit: 3 connectors, 1 connected → progress 1/3                                       |
| 4.14 | **`ConsentConnectorRow`** — 5 states (pending, authorizing, connected, failed, skipped) with OAuth popup trigger            | `apps/studio/src/components/auth-profiles/ConsentConnectorRow.tsx` (new) | Unit: all 5 states render correctly                                                  |
| 4.15 | **Sequential "Connect All" flow** — processes pending connectors one-by-one (browsers block multiple popups)                | `apps/studio/src/hooks/useBatchOAuth.ts` (new)                           | Integration: 3 pending → sequential popup → all connected                            |
| 4.16 | **Batch consent Zustand store** (session-scoped, not persisted)                                                             | `apps/studio/src/store/batch-consent-store.ts` (new)                     | Unit: state transitions                                                              |
| 4.17 | **Wire into ChatPanel** — `BatchConsentGate` wraps chat, `auth_required` message from session store populates consent store | `apps/studio/src/components/chat/ChatPanel.tsx`                          | Integration: session with preflight → consent UI shown → authorize → chat unlocked   |
| 4.18 | **i18n keys** — `auth_profiles.batch_consent.*` namespace (24 keys)                                                         | `packages/i18n/locales/en/studio.json`                                   | n/a                                                                                  |

**Phase 4 exit criteria:**

- [ ] DSL `consent: preflight` compiles to IR auth requirements
- [ ] Runtime sends `auth_required` on session start for preflight connectors
- [ ] Session blocks until all preflight consents satisfied
- [ ] Studio shows batch consent UI with progress, "Connect All", error recovery
- [ ] Cross-session token reuse works via contact identity
- [ ] `pnpm build && pnpm test` clean
- [ ] E2E: load agent with 2 OAuth connectors → consent UI → authorize → chat works

#### Phase 4 Integration Scenarios

**IS-4.1: Full preflight consent flow (happy path)**

- [ ] DSL: agent uses 2 tools — `gmail-lookup` (`consent: preflight`) and `calendar-check` (`consent: preflight`)
- [ ] Compile → IR has `authRequirements: [{ connector: "gmail", consentMode: "preflight" }, { connector: "google-calendar", consentMode: "preflight" }]`
- [ ] User opens chat → WebSocket `load_agent` → runtime checks tokens → neither exists
- [ ] Runtime sends `auth_required: { pending: [gmail, google-calendar], satisfied: [] }`
- [ ] Studio renders `BatchConsentGate` with 2 pending connectors
- [ ] User clicks "Authorize" on Gmail → OAuth popup → completes → row shows "Connected"
- [ ] Runtime sends `auth_gate_updated: { pending: [google-calendar], satisfied: [gmail] }`
- [ ] Progress bar: "1 of 2 connected"
- [ ] User authorizes Google Calendar → `auth_gate_satisfied` → consent UI fades out → chat unlocked
- [ ] User sends first message → agent works normally

**IS-4.2: Preflight with existing tokens (skip consent)**

- [ ] User previously authorized Gmail in another session
- [ ] Open new chat with agent requiring Gmail + Calendar
- [ ] Runtime: Gmail token found (satisfied), Calendar not found (pending)
- [ ] `auth_required: { pending: [google-calendar], satisfied: [gmail] }`
- [ ] UI shows only Calendar as pending, Gmail already "Connected"
- [ ] User authorizes Calendar → session proceeds

**IS-4.3: "Connect All" sequential flow**

- [ ] Agent requires 3 connectors: Gmail, Calendar, Salesforce
- [ ] User clicks "Connect All Remaining"
- [ ] Gmail popup opens → user authorizes → popup closes → row updates to "Connected"
- [ ] 500ms delay → Calendar popup opens → user authorizes → "Connected"
- [ ] 500ms delay → Salesforce popup opens → user denies → row shows "Failed: Authorization denied"
- [ ] Progress: "2 of 3 connected", Salesforce shows "Retry" button
- [ ] "Continue" button still disabled (Salesforce is preflight-required)
- [ ] User clicks "Retry" on Salesforce → popup → authorizes → "Connected" → Continue enabled

**IS-4.4: Preflight with mixed consent modes**

- [ ] Agent has 3 tools: Gmail (`consent: preflight`), Slack (`consent: inline`), Weather (`consent: none`)
- [ ] Only Gmail appears in `auth_required.pending[]` — Slack and Weather don't block session start
- [ ] User authorizes Gmail → session starts
- [ ] Later, Slack tool triggers inline auth (Phase 5 JIT) or fails gracefully

**IS-4.5: Auth gate blocks messages**

- [ ] Session in `auth_pending` state (consent not complete)
- [ ] User sends `send_message` → held/queued (not processed)
- [ ] User sends `reset_session` → allowed (not blocked by auth gate)
- [ ] User sends `cancel_execution` → allowed
- [ ] Consent completes → held messages processed in order

**IS-4.6: Consent persistence across sessions**

- [ ] User authorizes Gmail in Session 1
- [ ] Session 1 ends (WebSocket disconnect)
- [ ] User opens Session 2 with same agent → `ConsentStateResolver` finds Gmail token via contact identity
- [ ] Gmail shows as "Connected" immediately, no re-authorization needed
- [ ] Token expires between sessions → Gmail shows as "Pending" again

**IS-4.7: Scope deduplication across tools**

- [ ] Tool A needs `gmail.readonly`, Tool B needs `gmail.readonly` + `gmail.send`
- [ ] Compiler deduplicates → single auth requirement for Gmail with merged scopes `[gmail.readonly, gmail.send]`
- [ ] User authorizes once with combined scopes → both tools work

**IS-4.8: Preflight timeout/abandon**

- [ ] User opens chat → consent UI shown → user closes browser tab without authorizing
- [ ] WebSocket disconnects → session cleaned up, no orphaned state
- [ ] User reopens → new session → consent UI shown again fresh

**IS-4.9: SDK preflight handling**

- [ ] SDK connects → `load_agent` → receives `auth_required` event
- [ ] SDK has no `onAuthChallenge` handler → session stays in `auth_pending`
- [ ] SDK sends `send_message` → receives error "Session requires authentication"
- [ ] SDK manually calls consent satisfaction endpoint after handling auth externally → session unblocked

**IS-4.10: Agent with zero preflight requirements**

- [ ] Agent with all tools using `consent: inline` or no auth
- [ ] `load_agent` → no `auth_required` event sent → session starts immediately
- [ ] `BatchConsentGate` renders children directly (no consent UI flash)

---

### Phase 5: JIT Auth (Mid-Conversation Authentication)

> **Goal:** When a tool needs user auth mid-conversation and no token exists, pause execution, prompt the user, resume after auth.
>
> **Estimated effort:** 6–8 days
>
> **Dependencies:** Phase 2 (DSL `auth_jit`), Phase 4 (consent infrastructure, OAuth flow reuse).

#### 5A. WebSocket Protocol

| #   | Task                                                                                                                               | Files                                                     | Test                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| 5.1 | **`auth_challenge` server→client message** — `{ type, toolCallId, authType, authUrl?, profileId, profileName, prompt, timeoutMs }` | `apps/runtime/src/websocket/handler.ts`, `sdk-handler.ts` | Unit: message serializes correctly                      |
| 5.2 | **`auth_response` client→server message** — `{ type, toolCallId, status: 'completed' \| 'cancelled' }`                             | Same files                                                | Unit: handler processes response                        |
| 5.3 | **Message type registration** — add to handler switch/case (currently 15 message types)                                            | Same files                                                | Unit: unknown type → ignored; `auth_response` → handled |

#### 5B. Execution Pause/Resume

| #   | Task                                                                                                                                                                                       | Files                                                                    | Test                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 5.4 | **`PausedExecutionStore`** — Redis-backed. Key: `paused-exec:{sessionId}:{toolCallId}`, TTL: 10min (`JIT_AUTH_TIMEOUT_MS`). Stores tool call params, auth profile ref, session context ID. | `apps/runtime/src/services/auth-profile/paused-execution-store.ts` (new) | Unit: pause → key exists in Redis; TTL expires → key gone             |
| 5.5 | **Tool executor pause logic** — if `jitAuth: true` and token missing: (1) save to PausedExecutionStore, (2) send `auth_challenge`, (3) await Promise that resolves on `auth_response`      | Runtime tool executor                                                    | Integration: tool needs auth → execution pauses → auth_challenge sent |
| 5.6 | **Resume on `auth_response`** — resolve waiting Promise, retry tool call with fresh credentials                                                                                            | Runtime tool executor + WebSocket handler                                | Integration: auth_response(completed) → tool retries → succeeds       |
| 5.7 | **Timeout handling** — reject Promise with `AuthTimeoutError` after TTL                                                                                                                    | PausedExecutionStore                                                     | Unit: no response within TTL → tool fails with user-friendly message  |
| 5.8 | **Cancellation** — `auth_response(cancelled)` → reject with `AuthCancelledError`                                                                                                           | WebSocket handler                                                        | Unit: cancelled → tool fails with "Authorization cancelled"           |

#### 5C. OAuth Flow for JIT

| #    | Task                                                                                                                                                                    | Files                                             | Test                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| 5.9  | **`initiateJitOAuth(profileId, sessionId, toolCallId)`** in ToolOAuthService — generates OAuth URL, returns it for `auth_challenge` message                             | `apps/runtime/src/services/tool-oauth-service.ts` | Unit: returns valid OAuth URL with state param                 |
| 5.10 | **OAuth callback → resume signal** — callback writes token → publishes Redis event `jit-auth:complete:{sessionId}:{toolCallId}` → PausedExecutionStore resolves Promise | OAuth callback handler, PausedExecutionStore      | Integration: OAuth complete → token stored → execution resumes |

#### 5D. Studio Chat UI

| #    | Task                                                                                                                      | Files                                                            | Test                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| 5.11 | **`AuthChallengeMessage` component** — renders auth prompt in chat with "Authorize" button, countdown timer, profile name | `apps/studio/src/components/chat/AuthChallengeMessage.tsx` (new) | Unit: renders button, countdown, profile info            |
| 5.12 | **OAuth popup on button click** — reuse `AuthProfileOAuthDialog` pattern                                                  | Same component                                                   | Integration: click → popup → OAuth → auth_response sent  |
| 5.13 | **Timeout/cancel UI** — countdown expires → "Authorization timed out"; user dismisses → sends `auth_response(cancelled)`  | Same component                                                   | Unit: timeout → disabled state with message              |
| 5.14 | **Wire into chat message renderer** — handle `auth_challenge` message type                                                | Chat message renderer                                            | Integration: auth_challenge arrives → UI renders in chat |

#### 5E. SDK Support

| #    | Task                                                                                                      | Files                | Test                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| 5.15 | **`onAuthChallenge` callback hook** — `onAuthChallenge(challenge) => Promise<'completed' \| 'cancelled'>` | SDK WebSocket client | Unit: callback fires on auth_challenge; default = log URL + cancel after timeout |
| 5.16 | **SDK types** — export `AuthChallengeMessage`, `AuthResponseMessage` types                                | SDK types package    | Type-level                                                                       |

#### 5F. Session Cleanup

| #    | Task                                                                                                                                          | Files                                   | Test                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| 5.17 | **Cleanup on disconnect** — on WebSocket close, `PausedExecutionStore.cleanupSession(sessionId)` deletes all `paused-exec:{sessionId}:*` keys | `apps/runtime/src/websocket/handler.ts` | Integration: disconnect → no orphaned Redis keys |
| 5.18 | **Session-scoped token revocation** (if `auth_scope: session`) — deferred, document as future work                                            | n/a                                     | n/a                                              |

**Phase 5 exit criteria:**

- [ ] Tool with `auth_jit: true` and missing token → chat shows "Authorize" button
- [ ] User clicks → OAuth popup → token stored → tool call retries → succeeds
- [ ] Timeout → tool fails gracefully with message
- [ ] Cancel → tool fails with "Authorization cancelled"
- [ ] SDK `onAuthChallenge` fires correctly
- [ ] No orphaned Redis keys after session disconnect
- [ ] `pnpm build && pnpm test` clean

#### Phase 5 Integration Scenarios

**IS-5.1: Full JIT auth flow (happy path)**

- [ ] DSL tool: `auth_profile: "google-oauth"`, `auth_jit: true`, `consent: inline`
- [ ] User asks: "What's on my calendar today?"
- [ ] Agent decides to call `calendar-lookup` tool
- [ ] Runtime: no OAuth token for this user → `jitAuth: true` → execution pauses
- [ ] Runtime sends `auth_challenge: { toolCallId: "tc_123", authType: "oauth2", authUrl: "https://accounts.google.com/...", profileName: "google-oauth", prompt: "This tool requires Google authorization", timeoutMs: 600000 }`
- [ ] Studio renders `AuthChallengeMessage` in chat: card with "Authorize with Google" button + 10min countdown
- [ ] User clicks → OAuth popup → user grants consent → callback stores token
- [ ] Callback publishes Redis event `jit-auth:complete:{sessionId}:tc_123`
- [ ] PausedExecutionStore resolves Promise → tool executor retries with fresh token
- [ ] Tool call succeeds → calendar events returned → agent responds with schedule

**IS-5.2: JIT auth timeout**

- [ ] Tool needs auth → `auth_challenge` sent → countdown starts (10min)
- [ ] User doesn't click (walks away from computer)
- [ ] After 10min: PausedExecutionStore TTL expires → Promise rejected with `AuthTimeoutError`
- [ ] Tool returns error to agent: "Authorization timed out. The user did not authorize Google within 10 minutes."
- [ ] Agent responds: "I wasn't able to check your calendar because the authorization timed out. Would you like to try again?"
- [ ] Studio UI: countdown hits 0 → button disabled → message "Authorization timed out"
- [ ] Redis key `paused-exec:{sessionId}:tc_123` cleaned up

**IS-5.3: JIT auth user cancels**

- [ ] Tool needs auth → `auth_challenge` sent → UI shows button
- [ ] User clicks "Cancel" (or closes OAuth popup without completing)
- [ ] Studio sends `auth_response: { toolCallId: "tc_123", status: "cancelled" }`
- [ ] Promise rejected with `AuthCancelledError`
- [ ] Tool returns error: "Authorization was cancelled by the user."
- [ ] Agent responds naturally: "No problem. I can't access your calendar without authorization. Is there anything else I can help with?"

**IS-5.4: JIT auth for second tool in same conversation**

- [ ] Agent uses Tool A (authorized in Phase 4 preflight) and Tool B (`auth_jit: true`, not pre-authorized)
- [ ] Conversation starts normally (Tool A works)
- [ ] Agent decides to call Tool B → JIT flow triggers
- [ ] User authorizes → Tool B works
- [ ] Agent calls Tool B again later in same conversation → token cached → no second auth prompt

**IS-5.5: JIT auth with multiple pending tool calls**

- [ ] Agent calls Tool A and Tool B simultaneously, both need JIT auth
- [ ] Runtime sends 2 `auth_challenge` messages (different `toolCallId`s)
- [ ] Studio shows 2 auth cards in chat
- [ ] User authorizes Tool A first → Tool A resumes, Tool B still waiting
- [ ] User authorizes Tool B → Tool B resumes
- [ ] Both results returned to agent

**IS-5.6: Session disconnect during JIT auth wait**

- [ ] Tool paused, waiting for auth_response
- [ ] User closes browser tab → WebSocket disconnects
- [ ] `PausedExecutionStore.cleanupSession(sessionId)` fires
- [ ] All `paused-exec:{sessionId}:*` Redis keys deleted
- [ ] No orphaned Promises, no memory leaks
- [ ] If user reconnects to same session → tool call is failed (not retried automatically)

**IS-5.7: SDK JIT auth with custom handler**

- [ ] SDK client registers: `onAuthChallenge: (challenge) => { openBrowser(challenge.authUrl); return waitForCallback(); }`
- [ ] Tool needs auth → `auth_challenge` event fires → SDK callback opens browser
- [ ] User completes OAuth in browser → SDK resolves with `'completed'`
- [ ] SDK sends `auth_response(completed)` → tool resumes

**IS-5.8: SDK JIT auth with default handler (no custom handler)**

- [ ] SDK client has no `onAuthChallenge` registered
- [ ] Tool needs auth → SDK logs: `"Tool requires authorization. Visit: https://accounts.google.com/..."`
- [ ] After timeout → SDK auto-responds with `'cancelled'`
- [ ] Tool fails with timeout message

**IS-5.9: JIT auth when profile doesn't support OAuth**

- [ ] Auth profile is type `api_key` (not OAuth) with `auth_jit: true`
- [ ] Tool needs auth → runtime detects non-OAuth type → cannot generate auth URL
- [ ] Tool fails immediately with clear error: "JIT auth is only supported for OAuth-type auth profiles"
- [ ] No `auth_challenge` sent (nothing for user to do)

**IS-5.10: JIT auth OAuth callback race condition**

- [ ] User opens OAuth popup → completes quickly → callback arrives BEFORE `PausedExecutionStore` has finished writing
- [ ] Callback waits (retry with backoff) for paused execution key to exist
- [ ] Key appears → callback resolves → execution resumes normally
- [ ] No "execution not found" errors

**IS-5.11: Concurrent sessions, same user, different JIT tools**

- [ ] User has 2 browser tabs, Session A and Session B, both with JIT auth tools
- [ ] Session A triggers JIT for Gmail, Session B triggers JIT for Salesforce
- [ ] Each gets independent `auth_challenge` with different `toolCallId`
- [ ] Authorizing Gmail in Session A does NOT affect Session B's Salesforce challenge
- [ ] OAuth `state` param includes `sessionId` to prevent cross-session token leaks

---

## Dependency Graph

```
Phase 1 (Hardening + Wiring)
  │
  ├──→ Phase 2 (Name Resolution + DSL)
  │      │
  │      ├──→ Phase 3 (mTLS + Bulk + Infra Gaps)  [parallel-safe with Phase 4]
  │      │
  │      └──→ Phase 4 (Preflight Consent)
  │             │
  │             └──→ Phase 5 (JIT Auth)
  │
  └──→ Phase 3 (partially — infra gaps 5 & 6 need rotation from Phase 1)
```

- **Phase 1** is the foundation — everything depends on it.
- **Phase 2** is the critical path — both Preflight and JIT need DSL + name resolution.
- **Phase 3** can run **in parallel** with Phase 4 (independent work streams).
- **Phase 5** depends on Phase 4 (reuses consent infrastructure and OAuth flow).

---

## Total Effort Estimate

| Phase                          | Days | Cumulative |
| ------------------------------ | ---- | ---------- |
| Phase 1: Hardening & Wiring    | 3–4  | 3–4        |
| Phase 2: Name Resolution + DSL | 4–5  | 7–9        |
| Phase 3: mTLS + Bulk + Infra   | 3–4  | 10–13      |
| Phase 4: Preflight Consent     | 8–10 | 18–23      |
| Phase 5: JIT Auth              | 6–8  | 24–31      |

**Total: ~24–31 days** (Phases 3 & 4 can overlap, saving 3–4 days → **~20–27 days effective**).

---

## Test Strategy Per Phase

| Phase | Unit Tests                                    | Integration Tests                              | E2E                                            |
| ----- | --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| 1     | SSRF blocking, error handling, consumer count | Rotation starts/stops, grace period fallback   | —                                              |
| 2     | Parser, IR emission, config var detection     | DSL → compile → resolve → HTTP call with auth  | —                                              |
| 3     | HTTPS agent creation, bulk validation         | Bulk delete with cascade, mTLS HTTP call       | —                                              |
| 4     | Auth requirement collector, consent store     | Session auth gate, token lookup, "Connect All" | Agent with 2 OAuth connectors → consent → chat |
| 5     | Pause/resume store, timeout, cancel           | auth_challenge → popup → resume → tool success | Full JIT flow in Studio chat                   |

**Test file naming convention:** `apps/runtime/src/__tests__/auth-profile-{feature}.test.ts`

---

## Risk Register

| Risk                                                                      | Impact | Mitigation                                                                     |
| ------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Phase 2 DSL changes break 3,947 compiler tests                            | High   | Run full compiler test suite after every parser change                         |
| Phase 4 WebSocket auth gate blocks legitimate messages                    | High   | Auth gate only blocks `send_message`, not `reset_session` / `cancel_execution` |
| Phase 5 Redis PausedExecutionStore TTL too short for slow OAuth providers | Medium | Configurable `JIT_AUTH_TIMEOUT_MS`, default 10min                              |
| Phase 3 mTLS cert handling introduces security surface                    | Medium | Never log cert/key contents; validate cert format on upload                    |
| Phase 4 preflight with 5+ connectors feels slow                           | Medium | "Connect All" sequential flow with progress bar; skip option                   |
