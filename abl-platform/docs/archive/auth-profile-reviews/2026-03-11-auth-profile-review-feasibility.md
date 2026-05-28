# Auth Profile Design — Feasibility Review

## Feasibility Review

### What Was Reviewed

The design establishes a single `AuthProfile` entity to replace three credential models (`LLMCredential`, `EndUserOAuthToken`, `ToolSecret`) and strip inline encrypted fields from 14 consumer models, covering 17 auth types, 5 addon layers, 16 consumer types, and 31+ BullMQ workers. No implementation exists yet.

---

## 1. Scope Risk

**The design is not incrementally deliverable as written.**

The design says "replace all" and structures migration as three phases, but Phase 1 is itself enormous. It requires: the `AuthProfile` model, `AuthProfileService`, 6+ new API route files (tenant-level CRUD, project-level CRUD, OAuth initiate/callback/user-consent, consumers endpoint, revoke, clone, bulk operations), Zod discriminated-union validation for 17 auth types, `applyAuth()` dispatcher for 15 request mutations, token refresh with Redis distributed locking, the 5-level `$or` resolution query wired into `RuntimeSecretsProvider`, GDPR cascade integration, audit trail ciphertext masking, all UI pages (Auth Profiles management page, slide-over, `AuthProfilePicker`, pre-flight modal, connector setup flow), and dual-read across 31+ workers — all before the first user-facing value is delivered.

**The original problem — connector OAuth flow — requires only:**

1. `AuthProfile` model with `oauth2_app` and `oauth2_token` auth types
2. The two-layer OAuth API (initiate, callback) for project-scoped profiles
3. `ConnectorConfig.authProfileId` and `ConnectorConnection.authProfileId` fields with dual-read
4. The connector setup flow in Studio (Section 7.12)
5. The `AuthProfilePicker` component
6. Basic CRUD for `oauth2_app` and `oauth2_token` types

That is roughly 20-25% of the design. Everything else — enterprise auth types, addons, 31+ worker migration, LLM credential migration, pre-flight propagation, import/export, voice lifecycle, multi-agent credential propagation — is orthogonal to unblocking connector OAuth.

**Recommended phase split:**

- Phase 1 (unblock connector OAuth, 3-4 sprints): `AuthProfile` model with `oauth2_app`, `oauth2_token`, `oauth2_client_credentials` types only. Project-scoped CRUD. OAuth initiate/callback APIs. `ConnectorConfig` and `ConnectorConnection` dual-read. Studio connector setup flow. `AuthProfilePicker`. GDPR cascade from day one (design correctly requires this). No enterprise types. No addons. No worker migration.
- Phase 2 (credential consolidation, 4-6 sprints): `LLMCredential` migration to `api_key`/`azure_ad`/`aws_iam` auth types. `ToolSecret` migration. `EndUserOAuthToken` migration. 31+ worker dual-read. `idp-sync-scheduler` fix. `embedding-worker` singleton fix. `connection-resolver.ts`, `tool-oauth-service.ts`, `service-node-executor.ts` dual-read. Pre-flight auth propagation. Runtime hook into `RuntimeSecretsProvider`.
- Phase 3 (enterprise types and addons, 2-3 sprints): `kerberos`, `saml`, `hawk`, `digest`, `ws_security`, `mtls`, `ssh_key`. All 5 addon layers. Certificate pinning. Multi-agent credential propagation. Import/export auth mapping. Voice lifecycle auth. `EncryptionService` multi-key prerequisite and re-encryption batch job. Phase 3 cleanup (drop old fields and models).

**Kerberos, SAML, Hawk, WS-Security should be Phase 3.** They require native C++ bindings (`kerberos` npm), SOAP library (`soap`, ~8MB), and SAML XML processing. Each is an independent protocol with distinct operational requirements. None are needed to unblock the connector OAuth problem.

---

## 2. Migration Risk

**The "replace all" framing understates the blast radius.**

The design correctly identifies dual-read as the migration safety net, but the actual blast radius is larger than the document conveys:

**Workers — testing burden is under-specified.** The design lists 31+ BullMQ workers needing dual-read, but provides no test strategy for them. The 9 search-ai workers that resolve credentials through `llm-config/resolver.ts` all share one code path, which is fortunate — but that resolver has no test coverage for the dual-read branch since it does not exist yet. The 6 IdP sync workers have a more serious problem (see below). The testing burden for the worker migration is at minimum: unit tests for each worker's dual-read path (new credential resolution), integration tests with a canary tenant, and smoke tests after each worker group is deployed. This is not scoped.

**IdP Sync Scheduler — the fix is harder than described.** The design says to detect `LLMCredential` records with metadata heuristics (`azureadUserSyncDeltaToken`, `oktaUserSyncLastUpdated`, etc.) and migrate them to `AuthProfile`. But the actual code at line 226-244 of `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/idp-sync-scheduler.ts` does `LLMCredential.find()` with no filter (fetches ALL credentials) and then uses `(cred as any).metadata` type casts to guess provider type from arbitrary field names. There is no structured `provider` field on `LLMCredential` to query against. The migration detection query in the design (`LLMCredential.find({ 'metadata.azureadUserSyncDeltaToken': { $exists: true } })`) is correct, but it will miss credentials where the metadata was stored under different field naming conventions by different operators over time. Manual audit of production `LLMCredential` documents is required before this migration can be safely scripted.

**Token refresh race during migration — the lock key is wrong.** The design says the migration script must acquire `auth-profile:refresh:{tenantId}:{profileId}` to prevent concurrent token refresh from overwriting a migrated token. But `EndUserOAuthToken` records have their own `_id` (not an Auth Profile ID, which doesn't exist yet during migration). The lock key format references `profileId` before the profile is created. The correct approach is to lock by the legacy token's ID during migration creation, then immediately re-lock on the new Auth Profile ID — a two-step handoff that the design does not describe.

**Auth Profile deletion blocked during dual-read is operationally fragile.** Section 14 says "Block Auth Profile deletion while dual-read is active for any consumer." This requires tracking, per Auth Profile, whether all consumers have migrated away from their legacy `credentialId`. There is no proposed mechanism to determine this state — no flag, no query, no migration table. In practice, operators will be unable to delete any Auth Profile during the entire multi-month migration window, and the 409 error will be confusing.

**Rollback for Phase 3 is a full MongoDB restore.** This is correctly documented, but the implication is that Phase 3 cannot be rolled back at the service level — only at the infrastructure level. If a production bug surfaces post-Phase 3, the recovery path is a full tenant restore from backup, not a code revert. This needs an explicit go/no-go criteria documented before Phase 3 begins.

---

## 3. Performance Risk

**Auth Profile resolution on every tool call — latency budget not defined.**

The design places `authProfileService.resolve()` as step 2 in `RuntimeSecretsProvider.getSecret()`, below a session-level cache. The session-level cache handles repeat calls within a session, but the first call per session per tool will hit the 5-level `$or` MongoDB query. For an agent with 5 distinct tools each resolving a different auth profile, that is 5 MongoDB queries at session start. The design mentions session-level caching but does not define:

- Maximum cache size (the design says "max 200 entries" but does not explain the eviction strategy — LRU? FIFO?)
- Whether the cache is per-session or per-pod (per-session is the right answer but should be stated explicitly)
- The P99 latency budget for the `$or` query against a tenant with thousands of Auth Profiles

The 9-index plan in Section 9 is comprehensive, but the single compound `$or` query across 5 branches uses different index shapes for each branch. MongoDB will execute the `$or` branches as separate index scans and merge results. With a large dataset, this can be significantly slower than a sequential waterfall with early exit. The design's claim that "the 5-level resolution MUST be collapsed into a single DB query" should be load-tested against realistic data volumes before committing to this pattern.

**Redis distributed lock on every token refresh — Redis unavailability path is under-specified.**

The design says callers that cannot acquire the lock wait 100ms exponentially up to 2 seconds, then fail with `AUTH_PROFILE_TOKEN_REFRESH_FAILED`. But it does not address what happens when Redis is completely unavailable (connection refused, not just lock contention). The existing `tool-oauth-service.ts` refreshes without a Redis lock and succeeds even when Redis is down. The new design would make Redis a hard dependency for any session involving an OAuth token near expiry. The Redis unavailability fallback path — whether to proceed without the lock (risking a duplicate refresh) or fail the session — needs an explicit policy decision.

**`oauth2_client_credentials` token cached in Redis — shared across all sessions.**

The Redis cache key is `auth-profile:cc-token:{tenantId}:{profileId}`. This is correct for sharing tokens across sessions, but if the token is invalidated at the provider (revoked externally), there is no cache invalidation path — the stale token will be used until TTL expires. The design should document this as a known limitation or add a proactive invalidation mechanism triggered by 401 responses.

---

## 4. Operational Risk

**`ENCRYPTION_MASTER_KEY` rotation prerequisite is a blocking dependency that does not exist.**

The current `EncryptionService` in `/Users/prasannaarikala/projects/agent-platform/packages/shared/src/encryption/engine.ts` takes a single `masterKeyHex` string and has no concept of previous keys. The `EncryptionServiceConfig` type has three fields: `masterKeyHex`, `defaultStrategy`, and `cache`. There is no `previous[]` array.

The design's `encryptionKeyVersion` field and `previousEncryptedSecrets` rotation mechanism require `EncryptionService` to support decrypting with an older key while encrypting with the current key. This is a non-trivial change to a security-critical component. The design correctly marks this as a Phase 2 prerequisite (Section 16), but this prerequisite must be completed before any rotation feature of Auth Profile can be used in production. The `rotationGracePeriodMs` and `previousEncryptedSecrets` fields will exist in the schema from day one but will be inert until this prerequisite ships. Operators could set `rotationPolicy` on an Auth Profile and get no actual rotation behavior — this should be enforced by a runtime check that throws if rotation is attempted before the multi-key `EncryptionService` is in place.

**GDPR cascade — personal profiles will be missed without explicit coverage.**

The current `/Users/prasannaarikala/projects/agent-platform/packages/database/src/cascade/cascade-delete.ts` line 103 deletes `LLMCredential` on tenant deletion. It does not delete `EndUserOAuthToken` on tenant deletion (this is missing from the existing code and represents a pre-existing GDPR gap). When `AuthProfile` is introduced, personal `oauth2_token` profiles (`visibility: personal`, `createdBy: userId`) will contain user PII (`providerUserId` is explicitly noted as PII in Section 2.3) and encrypted OAuth tokens. The design says "include Auth Profile in GDPR cascade from day one" — this is correct and essential. But the existing `MongoGDPRStore` in `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/services/retention/mongo-gdpr-store.ts` covers sessions, messages, and traces but has no credential model deletion. The GDPR store and `cascade-delete.ts` both need explicit Auth Profile coverage before any personal profiles exist in production.

**Monitoring — the design's health signals are adequate but not wired to anything.**

Section 10 defines `AUTH_PROFILE_DECRYPTION_FAILED` (500) and Section 11 defines ClickHouse audit events for runtime decrypt. But there is no defined alert threshold, no SLA, and no proposed dashboard. In practice, a misconfigured `ENCRYPTION_MASTER_KEY` rotation that corrupts decryption of Auth Profiles would surface as `AUTH_PROFILE_DECRYPTION_FAILED` errors — but only if something is watching. The design should specify at minimum: an alert on `AUTH_PROFILE_DECRYPTION_FAILED` rate > 0, an alert on `auth_profile_refresh` failure rate > 5% over 5 minutes, and an alert on `AUTH_PROFILE_TOKEN_REFRESH_FAILED` errors in production sessions.

---

## 5. Team Risk

**The design document is too long to function as an implementation guide.**

At 1,700+ lines, the document covers the full system design, implementation details, cross-field validation rules, addon combination matrices, migration scripts, GDPR compliance, and audit requirements in a single file. A developer picking up "Phase 1 — OAuth connector flow" must read past 1,400 lines of irrelevant material to understand their scope. Sections 6 (pre-flight propagation), 12 (versioning), 13 (import/export), and most of Section 14 (worker migration) are not relevant to Phase 1.

The design should be split into:

- `auth-profile-core-design.md` — model, auth types limited to Phase 1 (oauth2_app, oauth2_token, oauth2_client_credentials), scoping, CRUD API, database schema
- `auth-profile-migration-plan.md` — dual-read patterns, worker migration, idp-sync-scheduler fix, embedding-worker singleton, rollback procedures
- `auth-profile-enterprise-addons.md` — enterprise auth types, addons, pre-flight propagation, multi-agent credential propagation, import/export

**Concrete code examples are present for the core model but sparse for integration points.**

The design provides strong code examples for the Mongoose schema, the `validateAuthProfileAccess` helper, the `$or` resolution query, and the token refresh lock. However, the integration into `RuntimeSecretsProvider.getSecret()` is shown as a call stack diagram (Section 8, Runtime Hook Point) rather than actual TypeScript. The dual-read pattern in Section 14 is shown as a generic template but not as actual code for `connection-resolver.ts`, `tool-oauth-service.ts`, or `service-node-executor.ts` — the three highest-risk integration points. These need concrete code examples before implementation begins.

**A new developer cannot understand the design without also reading the existing codebase.**

The design assumes familiarity with `RuntimeSecretsProvider`, `LLMWiringService._wireExecutor()`, `tenantIsolationPlugin`, `encryptionPlugin`, `auditTrailPlugin`, and `cascade-delete.ts`. Cross-references to specific line numbers (e.g., "line 103 of cascade-delete.ts", "line 82-103 of embedding-worker.ts", "line 226-244 of idp-sync-scheduler.ts") are accurate and helpful, but the design does not explain what each of these does in enough detail to onboard a developer who has not already read those files. The design is best understood as a review artifact for an experienced team, not an implementation guide for new contributors.

---

## 6. Phasing Recommendation

### Phase 1 — Unblock Connector OAuth (3-4 sprints)

**Scope:** Minimum to enable the connector OAuth flow end-to-end.

Auth types implemented: `oauth2_app`, `oauth2_token`, `oauth2_client_credentials`, `api_key`, `bearer`, `none`.

Items included:

1. `AuthProfile` Mongoose model (full schema from Section 9, all fields, correct plugins)
2. `AuthProfileService` with methods: `create`, `update`, `delete`, `resolve` (5-level `$or` query), `validateAccess`
3. Project-scoped CRUD API (`/api/projects/:pid/auth-profiles/*`) for the 6 auth types above
4. OAuth initiate, callback, and user-consent endpoints (Section 8)
5. `ConnectorConfig.authProfileId` and `ConnectorConnection.authProfileId` with dual-read (fallback to existing fields)
6. GDPR cascade: add `AuthProfile` to `cascade-delete.ts` tenant deletion AND `MongoGDPRStore` user deletion (do not defer this)
7. Audit trail ciphertext masking fix (Section 11 — required to avoid leaking ciphertext into audit logs from day one)
8. Studio connector setup flow (Section 7.12) and `AuthProfilePicker` component (Section 7.7)
9. Auth Profiles management page (Section 7.11) limited to the 6 Phase 1 auth types
10. `providerUserId` moved to `encryptedSecrets` or gated — do not defer this PII issue
11. Rate limits on OAuth endpoints (specified in design, enforce from day one)
12. SSRF validation on all URL fields in `oauth2_app` config (Section 11)
13. Zod `.strict()` on all config schemas (Section 11)
14. Structured `AuthProfileError` with `retryable` discriminator (Section 10)
15. Four trace events via `TraceStore` (Section 10)

Items deferred to Phase 2 or later: enterprise auth types (`kerberos`, `saml`, `hawk`), infrastructure types (`mtls`, `ws_security`, `ssh_key`), `digest`, all 5 addons, worker migration (31+ workers), `idp-sync-scheduler` fix, `embedding-worker` singleton fix, `LLMCredential` migration, `ToolSecret` migration, `EndUserOAuthToken` migration, pre-flight auth propagation, multi-agent credential propagation, import/export auth mapping, voice lifecycle, `EncryptionService` multi-key support, rotation batch job.

### Phase 2 — Credential Consolidation (4-6 sprints)

**Prerequisite:** Phase 1 stable in production with canary tenant validation.

Items:

1. `api_key`, `bearer`, `basic`, `aws_iam`, `azure_ad`, `custom_header` auth types (complete the non-enterprise set)
2. `LLMCredential` migration: create Auth Profiles, populate `authProfileId` on consumers, dual-read in `llm-config/resolver.ts`, `model-resolution.ts`, `tenant-model-repo.ts`
3. `ToolSecret` migration: dual-read in `RuntimeSecretsProvider.getSecret()` (the primary hot path)
4. `EndUserOAuthToken` migration: replace `tool-oauth-service.ts` with `AuthProfileService` token refresh (with distributed Redis lock)
5. `idp-sync-scheduler.ts` fix: migrate LLMCredential IdP records to Auth Profile, update scheduler query
6. `embedding-worker.ts` singleton: add Auth Profile resolution path when `AUTH_PROFILE_ENABLED`
7. `connection-resolver.ts`, `service-node-executor.ts` dual-read
8. 31+ BullMQ worker dual-read (9 search-ai workers via shared `llm-config/resolver.ts` change, others individually)
9. `EncryptionService` multi-key prerequisite (needed before rotation features are surfaced to users)
10. Pre-flight auth propagation in compiler and runtime
11. Tenant-scoped Auth Profile CRUD API (`/api/auth-profiles/*`)
12. Runtime hook into `RuntimeSecretsProvider` (`authProfileService.resolve()` as step 2)

### Phase 3 — Enterprise Types, Addons, Cleanup (2-3 sprints)

**Prerequisite:** Phase 2 stable with all workers migrated. Full MongoDB snapshot taken before cleanup.

Items:

1. Enterprise auth types: `kerberos` (with Docker build changes), `saml`, `hawk`, `digest`
2. Infrastructure types: `mtls`, `ws_security`, `ssh_key`
3. All 5 addon layers: `signing`, `jwtWrapping`, `webhookVerification`, `certificatePinning`, `proxy`
4. Addon invalid-combination matrix enforcement
5. Multi-agent credential propagation (handoff, delegate, fan-out)
6. Import/export auth mapping step
7. Voice lifecycle auth (LiveKit call duration caching)
8. Rotation batch job (re-encrypt all `encryptedSecrets` with new master key version)
9. Phase 3 cleanup: drop `credentialId` from consumer models, delete `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` collections
10. Env var obsolescence: remove `CHANNEL_OAUTH_*`, `OAUTH_PROVIDER_*`, LLM API key env vars from all Dockerfiles

**Go/no-go gate for cleanup:** All 31+ workers confirmed reading `authProfileId` (not `credentialId`) in production metrics for 30+ days. Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors in the preceding 14 days. Full MongoDB snapshot confirmed with retention policy documented.

---

## Summary

The design is technically sound and well-reasoned. The security properties (distributed lock fixing the token refresh race, Zod `.strict()` against prototype pollution, SSRF validation, ciphertext masking in audit trail, 404-not-403 for cross-scope access) are all correct. The phasing risk comes from scope compression — the design bundles a foundational infrastructure change with a concrete user-facing problem and attempts to deliver both simultaneously. Separating connector OAuth (Phase 1) from credential consolidation (Phase 2) and enterprise types (Phase 3) reduces the blast radius of any single phase to a manageable level. The critical day-one requirements that must not be deferred are GDPR cascade coverage, audit trail ciphertext masking, and SSRF validation — all three protect data that will exist in production from the moment the first Auth Profile is created.

---

I was unable to write this to disk because no Write or Bash tool is available in this session. The full document content above should be saved to `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-review-feasibility.md` and then formatted with `npx prettier --write docs/plans/2026-03-11-auth-profile-review-feasibility.md`.

Key files referenced in this review:

- `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (reviewed)
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/cascade/cascade-delete.ts` (line 103 — LLMCredential present, AuthProfile absent)
- `/Users/prasannaarikala/projects/agent-platform/packages/shared/src/encryption/engine.ts` and `types.ts` (single-key EncryptionService confirmed)
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/idp-sync-scheduler.ts` (lines 226-244 — any-cast metadata heuristic confirmed)
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/embedding-worker.ts` (lines 82-103 — env-var singleton confirmed)
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/tool-oauth-service.ts` (lines 415-475 — no Redis lock on refresh confirmed)
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/services/retention/mongo-gdpr-store.ts` (no credential model coverage confirmed)
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/llm-wiring.ts` (lines 349-373 — RuntimeSecretsProvider construction, no authProfileService)
