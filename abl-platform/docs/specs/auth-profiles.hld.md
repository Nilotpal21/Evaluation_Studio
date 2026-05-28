# High-Level Design: Auth Profiles

**Feature**: Auth Profiles -- Unified Credential Management
**Status**: BETA (existing FR-1..FR-8 STABLE; ABLP-913 FR-9..FR-33 core implementation and 2026-05-13 review hardening landed; strict E2E depth pending)
**Feature Spec**: [docs/features/auth-profiles.md](../features/auth-profiles.md)
**Test Spec**: [docs/testing/auth-profiles.md](../testing/auth-profiles.md)
**Last Updated**: 2026-05-13
**Driving Tickets**: [ABLP-913](https://koreteam.atlassian.net/browse/ABLP-913) — Auth Profile Design — Decisions & Behavior Spec
**Discussion Inputs**: 2026-05-09 Auth Profile review meeting (full transcript referenced in feature spec §1.5)

> **Reading guide**: §1–§8 document the existing implementation that powers FR-1..FR-8. **§9 (ABLP-913 Architecture Extensions)** at the bottom of this document is the authoritative design for the new behaviors (FR-9..FR-31). When reading sections 1–8, treat them as the baseline that ABLP-913 extends rather than replaces.

---

## 0. Overview & Goal

Auth Profiles is the platform's unified, encrypted credential management layer. The shipped implementation (FR-1..FR-8) provides the data model, encryption, multi-level scope-aware resolution, OAuth2 lifecycle, dual-read migration, secret redaction, and 14+ consumer integrations. The **goal of ABLP-913** is to add the operator-facing behaviors that turn Auth Profiles from a credential store into a single unified concept admins can reason about: explicit Integration vs Custom typing, vendor-grouped Integrations Tab, profile-level Authorize CTA with "To be Authorized" state, saved-profile-only type-aware tool-config assignment, project-scoped end-user consent persistence, two clearly distinct revoke flows with blast-radius preview, mid-session token invalidation, and per-profile audit logs. The design must preserve all existing isolation, encryption, and dual-read invariants while introducing these behaviors with safe migration, backward-compatible UPDATE paths, and additive-only commits.

---

## 1. System Context

Auth Profiles is a cross-cutting credential management layer that sits between the platform's operator-facing surfaces (Studio, Admin) and the runtime execution engine. It provides a unified, encrypted credential store that all platform consumers query during execution.

### System Context Diagram

```
                            +-------------------+
                            |   Studio (Next.js) |
                            |   Port 5173        |
                            +---------+---------+
                                      |
                    +--------+--------+--------+--------+
                    |        |                 |        |
               CRUD+OAuth  Picker         Preflight  Consumers
                    |        |                 |        |
          +---------v--------v-----------------v--------v---------+
          |                     Auth Profiles                       |
          |  packages/shared/src/services/auth-profile/             |
          |  packages/shared/src/validation/auth-profile*.schema.ts |
          |  packages/database/src/models/auth-profile.model.ts     |
          +---------+---+---+---+---+---+---------+----------------+
                    |   |   |   |   |   |         |
                    v   v   v   v   v   v         v
                +-+ +-+ +-+ +-+ +-+ +-+   +------+------+
                |C| |M| |V| |M| |S| |G|   | Encryption  |
                |o| |o| |o| |C| |e| |u|   | Service     |
                |n| |d| |i| |P| |a| |a|   | (AES-256-   |
                |n| |e| |c| | | |r| |r|   |  GCM)       |
                |e| |l| |e| |S| |c| |d|   +------+------+
                |c| |s| | | |e| |h| |r|          |
                |t| | | | | |r| |A| |a|     +----v----+
                |o| | | | | |v| |I| |i|     | MongoDB |
                |r| | | | | |e| | | |l|     +---------+
                |s| | | | | |r| | | |s|
                +-+ +-+ +-+ +-+ +-+ +-+     +----+----+
                                              | Redis   |
                 14+ Consumer Types           +---------+
                                              (locks,
                                               CC tokens)
```

**Consumers** (14+ types): Connector configs, connector connections, model configs, MCP servers, channel connections, voice services, SearchAI models, SearchAI embeddings, guardrail providers, secrets provider, proxy configs, delivery workers, git credentials, agent transfer.

### Deployment Topology

- **Studio pods**: Handle CRUD, OAuth flows, and consumer discovery. Auth profile data persisted to shared MongoDB.
- **Runtime pods**: Resolve credentials during execution via pod-local LRU cache (200 entries, 5min TTL). Distributed Redis locks for token refresh. Rotation jobs run on a single leader via Redis lock.
- **SearchAI pods**: Independent auth profile resolver for model/embedding credential resolution.
- **All pods**: Share MongoDB (auth_profiles collection) and Redis (lock keys, CC token cache).

---

## 2. Component Architecture

### Package Structure

```
packages/
  shared/
    src/
      services/
        auth-profile.service.ts        # Core CRUD + resolve + token refresh
        auth-profile/
          apply-auth.ts                 # HTTP credential dispatch (17 types)
          apply-signing.ts              # HMAC/RSA signing addon
          apply-proxy.ts                # Proxy routing addon
          client-credentials-service.ts # CC grant with Redis cache
          credential-cache.ts           # LRU cache (200 entries, 5min TTL)
          dual-read.ts                  # Migration pattern
          grace-period.ts               # Key rotation fallback
          linked-app-validator.ts       # oauth2_app reference validation
          oauth2-app-resolver.ts        # Parent app credential resolution
          redact.ts                     # Secret field stripping
          refresh-lock.ts               # Redis distributed lock (30s TTL)
          # OAuth token refresh is canonical in packages/shared-auth-profile/src/token-refresh-service.ts
          trace-events.ts               # Structured trace event emitter
          update-validator.ts           # Prevents authType mutation
          verify-webhook.ts             # HMAC webhook verification
      validation/
        auth-profile.schema.ts          # Phase 1 Zod schemas (6 types)
        auth-profile-phase2.schema.ts   # Phase 2 Zod schemas (6 types)
        auth-profile-phase3.schema.ts   # Phase 3 Zod schemas (5 types)
        auth-profile-addons.schema.ts   # Addon schemas + invalid combos
      encryption/
        engine.ts                       # AES-256-GCM EncryptionService
        constants.ts                    # Algorithm parameters
        types.ts                        # Config interfaces
  database/
    src/models/
      auth-profile.model.ts             # Mongoose model (17 types, 11 indexes)

apps/
  studio/
    src/
      components/auth-profiles/         # 9 UI components
      hooks/useAuthProfiles.ts          # Data fetching hook
      api/auth-profiles.ts              # Typed API client
      app/api/auth-profiles/            # Workspace routes
      app/api/projects/[id]/auth-profiles/  # Project routes + OAuth
  runtime/
    src/
      services/auth-profile-resolver.ts # Runtime credential resolution
      services/auth-profile/            # Cache, rotation job
      services/execution/               # Delegate, fanout, handoff
      health/                           # Health probes, alert evaluator
  search-ai/
    src/services/auth-profile-resolver.ts  # SearchAI credential resolution
```

### Data Flow: Credential Resolution (Runtime)

```
Agent Execution
     |
     v
Tool/Model/Connector needs credentials
     |
     v
dualReadCredentials()
     |
     +---> authProfileId present?
     |         |
     |         NO ---> legacyFallback()
     |         |
     |         YES
     |         |
     v         v
resolveAuthProfileCredentials()
     |
     v
CredentialCache.get(tenantId:profileId:env)
     |
     +---> CACHE HIT ---> return cached
     |
     +---> CACHE MISS
               |
               v
          AuthProfile.findOne({ _id, tenantId, status: 'active' })
               |
               v
          Decrypt encryptedSecrets (encryptionPlugin)
               |
               +---> Decryption fails?
               |         |
               |         v
               |     resolveWithGracePeriod()
               |         |
               |         +---> previousEncryptedSecrets within grace window?
               |         |         YES ---> Use previous secrets
               |         |         NO  ---> Throw
               |
               v
          Token near expiry? (within 5-min buffer)
               |
               YES ---> acquireRefreshLock() ---> refreshOAuth2Token()
               |
               v
          applyAuth(authType, config, secrets)
               |
               v
          HTTP headers / query / TLS / typed credentials
```

### Data Flow: OAuth2 Authorization (Studio)

```
Studio UI
     |
     v
AuthProfileOAuthDialog
     |
     v
POST /api/projects/:projectId/auth-profiles/oauth/initiate
     |
     v
Find oauth2_app profile (by name or ID)
     |
     v
Generate PKCE code_verifier + code_challenge
Store state in session/Redis
     |
     v
Return authUrl (provider's authorization endpoint)
     |
     v
User completes consent in popup
     |
     v
Provider redirects to /oauth/auth-profile-callback
     |
     v
POST /api/projects/:projectId/auth-profiles/oauth/callback
     |
     v
Exchange code for tokens (code + code_verifier)
     |
     v
Create oauth2_token profile (linked to oauth2_app via linkedAppProfileId)
     |
     v
Encrypt tokens, store in MongoDB
```

---

## 3. Architectural Concerns (12 Areas)

### 3.1 Isolation

**Tenant isolation**: Every query includes `tenantId` via the `tenantIsolationPlugin` Mongoose plugin. The plugin automatically injects `tenantId` into all find/update/delete operations. Cross-tenant access returns 404 (not 403).

**Project isolation**: Project-scoped profiles include `projectId` in queries. Workspace fallback only allows tenant-scoped profiles (`projectId: null`), not profiles from other projects.

**User isolation**: Personal profiles (`visibility: 'personal'`) are filtered by `createdBy`. Other users' personal profiles are hidden as 404 in list, read, update, and delete operations.

**Evidence**: `packages/database/src/models/auth-profile.model.ts` (plugins applied at lines 166-170).

### 3.2 Security

- **Encryption at rest**: AES-256-GCM with tenant-scoped key derivation. Master key from `ENCRYPTION_MASTER_KEY` env var. Two strategies: PBKDF2 (100K iterations, legacy compat) and HKDF (SHA-256, preferred).
- **Secret redaction**: `redactAuthProfile()` strips `encryptedSecrets`, `previousEncryptedSecrets`, `encryptionKeyVersion` from all API responses.
- **SSRF prevention**: OAuth token URLs validated via `z.string().url()` at schema level. Client credentials endpoint validation at service level.
- **PKCE**: OAuth2 flows use S256 code challenge method by default.
- **Audit trail**: `auditTrailPlugin` records all create/update/delete operations.

**Evidence**: `packages/shared/src/encryption/engine.ts`, `packages/shared/src/services/auth-profile/redact.ts`.

### 3.3 Performance

- **Credential cache**: Pod-local LRU with 200 max entries and 5-minute TTL. Avoids repeated MongoDB lookups during execution sessions. Key: `tenantId:profileId:environment`.
- **lastUsedAt debounce**: Skips DB write if lastUsedAt was updated within 5-minute window to reduce write pressure.
- **Client credentials caching**: Redis-based with TTL = `expires_in - 60s` buffer. Key: `auth-profile:cc-token:{tenantId}:{profileId}`.
- **Proactive token refresh**: Triggers refresh 5 minutes before expiry to avoid latency spikes during execution.

**Evidence**: `packages/shared/src/services/auth-profile/credential-cache.ts`, `client-credentials-service.ts`.

### 3.4 Reliability

- **Grace period fallback**: During key rotation, `resolveWithGracePeriod()` falls back to `previousEncryptedSecrets` if primary decryption fails. This prevents credential outages during rolling key updates.
- **Distributed lock resilience**: `acquireRefreshLock()` treats lock acquisition failures as warnings (not errors). Degraded mode: multiple pods may refresh concurrently, but last-write-wins with correct tokens.
- **Dual-read error propagation**: When `authProfileId` is set, resolution errors propagate (no silent fallback to legacy). This surfaces credential issues immediately rather than masking them.

**Evidence**: `packages/shared/src/services/auth-profile/grace-period.ts`, `refresh-lock.ts`, `dual-read.ts`.

### 3.5 Observability

- **Trace events**: 16+ structured events via `emitAuthProfileTraceEvent()` covering resolution lifecycle, token refresh, credential caching, and OAuth flows. Currently uses structured logging (`log.info`); TraceStore integration deferred.
- **Health probes**: `checkAuthProfileHealth()` probes MongoDB connectivity, decryption capability, and Redis lock availability.
- **Alert evaluator**: `AuthProfileAlertEvaluator` monitors 4 dimensions: token refresh failures (3 consecutive), decryption failures (immediate), profile expiry warnings (7 days), high error rates (>5% in 5-min window). Bounded map eviction at 10K entries.

**Evidence**: `packages/shared/src/services/auth-profile/trace-events.ts`, `apps/runtime/src/health/auth-profile-health.ts`, `auth-profile-alerting.ts`.

### 3.6 Data Lifecycle

- **No automatic TTL**: Profiles persist until explicitly deleted or revoked. No background cleanup.
- **Cascade protection**: Deleting an `oauth2_app` profile is blocked if active `oauth2_token` profiles reference it via `linkedAppProfileId`.
- **Key rotation**: Batch re-encryption job processes profiles with stale `encryptionKeyVersion`. Configurable batch size (default 100). Stores previous secrets for grace period.
- **Import/export**: Profiles included in project export. Import uses name-based resolution with fuzzy matching (authType + scope + connector).

**Evidence**: `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts`, `packages/project-io/src/import/auth-profile-resolver.ts`.

### 3.7 Deployment

- **Dual-read activation**: Consumers opt into auth profile resolution by storing `authProfileId`. No global feature flag is required.
- **Zero-downtime**: Auth profile CRUD is additive. Consumers without `authProfileId` continue using legacy paths until migrated.
- **Rolling updates**: Pod-local caches may serve stale credentials for up to 5 minutes after a profile update. Distributed locks prevent concurrent token refresh across pods.

### 3.8 Migration

- **Dual-read pattern**: All 14+ consumer types can be migrated incrementally. Each consumer type adds `authProfileId` to its entity schema and uses `dualReadCredentials()` to choose between auth profile and legacy resolution.
- **No schema migration needed**: Auth profile model is standalone. Consumer entities add optional `authProfileId` field.
- **Rollback**: Reverting or clearing `authProfileId` on a consumer returns it to the legacy credential path as long as legacy fields remain populated.

**Evidence**: `packages/shared/src/services/auth-profile/dual-read.ts`, `packages/shared-auth-profile/src/dual-read.ts`.

### 3.9 Backwards Compatibility

- **API stability**: Studio routes follow the standard RESTful pattern. No breaking changes to existing consumer APIs.
- **Schema additive**: Auth profile fields (authType enum, addon mechanisms) are added without modifying existing documents.
- **Dual-read**: Existing consumers continue working via legacy paths until explicitly migrated.

### 3.10 Testing Strategy

- **Unit and integration coverage**: 191 auth-related test files are tracked across database, shared, shared-auth-profile, runtime, studio, and project-io. The 2026-05-13 focused post-review regression pass covered 77 tests across shared authorization/refresh, Studio OAuth callback/integrations routes, and runtime session scanner/force invalidation.
- **Runtime surface coverage**: Tests now include runtime by-name lookup, grace-period fallback, route validation, consumer discovery, bulk actions, and durable OAuth grant behavior.
- **Remaining gap shape**: Coverage is strongest for core CRUD/resolve/OAuth flows. The main remaining deficit is deeper end-to-end coverage for addon dispatch and advanced auth protocols.

See [docs/testing/auth-profiles.md](../testing/auth-profiles.md) for full coverage matrix.

### 3.11 Monitoring

- **Health endpoint**: Auth profile health integrated into platform admin health routes (`/api/platform/admin/system-health`).
- **Alert dimensions**: Token refresh failures, decryption failures, profile expiry warnings, high error rates.
- **Credential age monitoring**: `credential-age-monitor.ts` tracks credential staleness.

**Evidence**: `apps/runtime/src/routes/platform-admin-health.ts`, `apps/runtime/src/services/credential-age-monitor.ts`.

### 3.12 Error Handling

- **16 error codes**: `AuthProfileError` class with typed error codes (e.g., `PROFILE_NOT_FOUND`, `PROFILE_EXPIRED`, `REFRESH_FAILED`, `DECRYPTION_FAILED`, `LINKED_APP_INVALID`).
- **Status codes**: Each error code maps to an HTTP status (400, 404, 409, 500).
- **Error propagation**: Dual-read propagates auth profile errors (no silent fallback). Resolution errors include profileId and tenantId for debugging.
- **Grace period errors**: Decryption failures within grace period log warning and use previous secrets. Outside grace period, errors throw.

**Evidence**: `packages/shared/src/errors/auth-profile-errors.ts`.

---

## 4. Alternatives Considered

### Alternative 1: Per-Consumer Credential Storage (Status Quo Before Auth Profiles)

Each consumer type (connectors, models, channels) stores its own credentials. Rejected because:

- Credential rotation requires updating every consumer type independently
- No central audit or revocation capability
- Encryption implementations duplicated across consumer types

### Alternative 2: External Secrets Manager (Vault, AWS Secrets Manager)

Delegate all credential storage to an external secrets manager. Not chosen because:

- Adds external dependency and operational complexity
- Higher latency for credential resolution at execution time
- Self-hosted customers may not have a secrets manager available
- Auth Profiles can be extended to sync with external managers in the future

### Alternative 3: Separate Auth Profile Microservice

Extract auth profiles into a standalone microservice. Not chosen because:

- Increases deployment complexity (new service to operate)
- Adds network hop for credential resolution at execution time
- Current shared package architecture allows code reuse without service boundary overhead
- Can be extracted later if scaling demands require it

---

## 5. Data Model Design

See [Feature Spec Section 9: Data Model](../features/auth-profiles.md#9-data-model) for the complete schema, indexes, and relationship documentation.

Key design decisions:

- **UUIDv7 for \_id**: Monotonic, time-ordered, globally unique. Enables efficient range queries by creation time.
- **Partial unique indexes**: Two partial indexes for name uniqueness (tenant-scoped and project-scoped). No personal-visibility partials -- personal profiles allow name collisions across owners.
- **encryptedSecrets as string**: JSON-serialized then encrypted. Schema-level validation happens before encryption (Zod schemas validate the plaintext secrets object).
- **Addon fields as Mixed**: Forward-compatible schema -- Phase 3 addon fields are stored but not actively validated at the model level (validation is in Zod schemas).

---

## 6. API Design

See [Feature Spec Section 8: How to Consume](../features/auth-profiles.md#8-how-to-consume) for the complete API documentation.

Key design decisions:

- **Separate project and workspace routes**: Studio exposes both `/api/projects/:projectId/auth-profiles/` and `/api/auth-profiles/` because ownership and visibility rules differ by scope.
- **OAuth routes under project scope**: OAuth initiate, consent, and callback are project-scoped because they need project context for profile creation and linked app resolution.
- **No runtime REST API**: Runtime resolves credentials via internal services, not REST endpoints. This avoids exposing credential material over HTTP.
- **Secret redaction on all reads**: Every API response strips `encryptedSecrets`, `previousEncryptedSecrets`, and `encryptionKeyVersion`.

---

## 7. Risks and Mitigations

| Risk                                           | Severity | Mitigation                                                                           |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| Key rotation causes credential outage          | HIGH     | Grace period fallback (`previousEncryptedSecrets`), configurable rotation batch size |
| Concurrent token refresh corrupts token state  | HIGH     | Distributed Redis lock (SET NX PX, 30s TTL), lock failure treated as warning         |
| Cache serves stale credentials after update    | MEDIUM   | 5-minute TTL on LRU cache, explicit invalidation on profile events                   |
| Feature flag misconfiguration breaks consumers | MEDIUM   | Dual-read propagates errors when auth profile is configured (no silent fallback)     |
| Missing test coverage for critical paths       | MEDIUM   | 13 test files need recreation; applyAuth, dual-read, redaction tests needed          |
| Personal profile name collisions               | LOW      | Personal profiles are per-owner; name uniqueness is scoped to shared visibility      |

---

## 8. Implementation Trace

The shipped FR-1..FR-8 implementation is captured in detail in the feature spec ([§10 Key Implementation Files](../features/auth-profiles.md#10-key-implementation-files)) and the comprehensive change log under `docs/plans/` (auth-profile phase 1 through phase 5). This HLD intentionally avoids duplicating that file inventory; consult the feature spec for current file paths and coverage. The next sections cover the **forward-looking** ABLP-913 design.

---

## 9. ABLP-913 Architecture Extensions

> **Status**: CORE IMPLEMENTED. Core implementation and 2026-05-13 review hardening have landed on this branch. Strict E2E execution depth and production soak remain pending. Implementation tracked in `docs/plans/2026-05-08-auth-profile-ablp913-impl-plan.md`.
>
> **Decision log**: All 16 product-oracle decisions are captured in `docs/sdlc-logs/auth-profiles/feature-spec.log.md` (ABLP-913 Update Run section). The HLD below references decisions as `D-N` to avoid duplicating rationale.

### 9.0 — 2026-05-09 Meeting Deltas (override prior decisions)

The 2026-05-09 review revised six of the prior decisions. This sub-section is authoritative; later sub-sections in §9 are aligned to it.

| Topic                                     | Prior Decision (§9.x)                                                                        | 2026-05-09 Override                                                                                                                                                                                                                                           | Action                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Connections concept**                   | D-2: `ConnectorConnection` is a binding-only artifact, kept                                  | DEPRECATE the model entirely; integration nodes assign profiles directly. Full removal is a follow-up ticket.                                                                                                                                                 | FR-33; GAP-21                               |
| **Inline credential entry at tool level** | Earlier draft FR-20 + D-8: simple types allowed a tool-scoped encrypted profile draft        | REMOVED — every credential MUST be a saved auth profile. Workflow dropdown adds a prominent "Create Auth Profile" nudge in addition to existing entries.                                                                                                      | Updated FR-18, FR-20                        |
| **Preflight failure behavior**            | FR-12: block session start until Preflight authorizations complete or are explicitly skipped | DEGRADE TO JIT — Preflight failure does not block the conversation; the prompt is re-issued at first tool need.                                                                                                                                               | Updated FR-12                               |
| **Force-invalidate priority**             | FR-26: TTL-based eventual (5 min) as P1 baseline; Redis pub/sub broadcast as P2              | PROMOTED to P0 — every revoke MUST publish to `auth-profile:invalidate` so revocation takes immediate effect on active sessions. TTL stays as the safety net for missed messages.                                                                             | Updated FR-26                               |
| **Integrations Tab catalog**              | FR-10: vendor-grouped view derived from existing profiles only                               | INFORMATIONAL — list ALL supported vendors from a static integration catalog (including `profileCount: 0` vendors); each vendor card has a `Configure` CTA that deep-links to `/auth-profiles?connector=<name>`. Custom-only profiles excluded from this tab. | Updated FR-10; new `integration-catalog.ts` |
| **OAuth callback error messaging**        | FR-29: only insufficient_scope is mapped; other failures use generic text                    | NEW FR-32: map known OAuth error codes (`redirect_uri_mismatch`, `invalid_client`, `invalid_grant`, `access_denied`, etc.) to actionable admin-visible messages.                                                                                              | New FR-32                                   |

Two additional decisions added as deferred follow-ups:

- **Session-init optimization** (GAP-22) — snapshot the resolved `authProfileId[]` set into the deployed agent version at compile/deploy time so runtime reads the snapshot instead of walking IR fresh per session.
- **Per-trigger required-scopes documentation** (GAP-23) — Vijay owns the docs effort; a `requiredScopes` annotation on integration catalog entries is a candidate enhancement.

### 9.1 New Behaviors Introduced

ABLP-913 introduces seven coordinated behaviors on top of the existing infrastructure:

1. **Profile typing & vendor catalog** — explicit `profileType: 'integration' | 'custom'` discriminator (D-1) + vendor-grouped Integrations Tab as a filtered view, **not a separate data model** (D-2; FR-10).
2. **Profile-level Authorize CTA + isAuthorized state** — admins authorize Preconfigured profiles in place; "To be Authorized" indicator surfaces at every assignment site (FR-13, FR-14, D-9).
3. **Session-init credential scan** — runtime walks the agent IR at session start and resolves all credential needs upfront (FR-12).
4. **Type-aware assignment UI + saved-profile-only credentials** — new `AuthProfileAssignment` component coexisting with existing `AuthProfilePicker`; inline credential entry is removed and every credential must be a saved auth profile (FR-18, FR-20, D-10).
5. **Project-scoped consent persistence** — `EndUserOAuthToken` carries `projectId` + `profileId`; users authorize once per project, never re-prompted across sessions in that project (FR-28, D-4).
6. **Two revoke actions + blast-radius** — `Revoke Profile` (existing) plus `Revoke User Tokens` (new, per-profile bulk + optional per-user); both gated by a pre-revoke blast-radius preview endpoint (FR-23, FR-24, D-5, D-13).
7. **Mid-session invalidation, audit log, scope errors** — pod-local TTL (5 min) as P1; Redis pub/sub broadcast (P2) for instant invalidation; new `auth_profile_audit_events` collection with TTL; insufficient-scope detection at OAuth callback and at tool-call time (FR-26, FR-29, FR-30, FR-31, D-6, D-7, D-11).

### 9.2 Component Architecture (Additions)

```
                           +----------------------+
                           |  Studio (Next.js)    |
                           |  + Integrations Tab  |
                           |  + Authorize CTA     |
                           |  + Activity tab      |
                           |  + AuthProfileAssignment |
                           |  + Revoke modals     |
                           +-----+--------+-------+
                                 |        |
              project-scoped APIs|        |runtime APIs (read)
                                 v        v
        +---------------------- Studio API routes -------------------+
        |  POST .../revoke-user-tokens    GET .../revoke-preview      |
        |  POST .../force-invalidate      GET .../audit-events        |
        |  GET  .../integrations          (extended) .../consumers    |
        +---------+-------------+----------------+--------------------+
                  |             |                |
                  v             v                v
       +------------------+  +-------------+  +----------------------+
       | AuthProfile      |  | Audit Event |  | Blast-Radius         |
       | Service          |  | Emitter     |  | Aggregator           |
       | (extended)       |  | (NEW)       |  | (NEW)                |
       +---------+--------+  +------+------+  +----------+-----------+
                 |                  |                    |
                 |                  v                    v
                 |        +---------------------+  +-----+-------+
                 |        | auth_profile_audit  |  |  consumer   |
                 |        |    _events (NEW)    |  |  registries |
                 |        +---------------------+  +-------------+
                 v
       +-----------------------------------------------------+
       | Runtime (apps/runtime)                              |
       |   AuthProfileSessionScanner (NEW)                   |
       |     -> walks AgentIR, resolves auth refs upfront    |
       |   AuthProfileCache (existing) + invalidate hook     |
       |   ForceInvalidateSubscriber (NEW)                   |
       |     -> consumes Redis pub/sub channel               |
       |        "auth-profile:invalidate"                    |
       |   ScopeInsufficientDetector (NEW)                   |
       |     -> 401/403 + error:insufficient_scope handling  |
       +---------+-------------------------------------------+
                 |
                 v
       +------------------------+   +----------------+
       | end_user_oauth_tokens  |   | Redis pub/sub  |
       | (NEW: projectId,       |   | "auth-profile: |
       |  profileId fields)     |   |  invalidate"   |
       +------------------------+   +----------------+
```

**New components**:

- **AuthProfileSessionScanner** (`apps/runtime/src/services/auth-profile/session-scanner.ts`) — walks the agent IR at session start, returns `{ preconfigured[], jit[], preflight[], issues[] }`. Drives Preconfigured token validation/refresh inline and prepares JIT/Preflight prompt routing.
- **AuthProfileAuditEventEmitter** (`packages/shared/src/services/auth-profile/audit-event-emitter.ts`) — single emit point for the 10 ABLP-913 event types; writes to the new `auth_profile_audit_events` collection. Replaces ad-hoc `auditTrailPlugin` use for ABLP-913 lifecycle events (D-12). The plugin still captures generic CRUD writes.
- **BlastRadiusAggregator** (`packages/shared/src/services/auth-profile/blast-radius-aggregator.ts`) — composes the consumer registries already used by `/consumers` plus `EndUserOAuthToken` count plus active-session count into a single payload for `GET /:profileId/revoke-preview`.
- **ForceInvalidateSubscriber** (`apps/runtime/src/services/auth-profile/force-invalidate-subscriber.ts`) — boots with the runtime pod, subscribes to Redis pub/sub channel `auth-profile:invalidate`, calls `AuthProfileCache.invalidate(profileId)` on each message.
- **ScopeInsufficientDetector** (in tool-execution path) — recognizes `error: insufficient_scope` in provider 401/403, emits `scope_insufficient_detected` audit event, returns `REAUTHORIZATION_REQUIRED` sanitized error to SDK.
- **AuthProfileAssignment** (Studio component, `apps/studio/src/components/auth-profiles/AuthProfileAssignment.tsx`) — stepped, type-aware. Coexists with existing `AuthProfilePicker` (8 callers preserved per D-10). Auth types in the selector are organized into "Common" (the 9 listed in ABLP-913), "Enterprise" (Phase 2), and "Advanced" (Phase 3 visually de-emphasized) per D-15.
- **AuthProfileAuthorizationBadge** (Studio component) — renders "To be Authorized" / "Authorized as user@x" — orthogonal to the lifecycle status badge. Surfaced in the slide-over alongside the Authorize CTA per D-16, and in the Integrations Tab cards.
- **RevokeProfileConfirm / RevokeUserTokensConfirm** (Studio modals) — drive the revoke-preview endpoint and confirm flows.
- **Activity tab** in `AuthProfileSlideOver` — paginated feed driven by `GET /:profileId/audit-events` (50/page default per D-10).

### 9.3 Data Flow — Key Sequences

**Session-init scan (FR-12)**

```
SDK -> POST /api/runtime/sessions
  Runtime.startSession()
    ir = compile(agentDsl)
    scan = AuthProfileSessionScanner.scan(ir, {tenantId, projectId, userId})
      collect unique authProfileId references across nodes
      for each reference:
        profile = AuthProfileService.get(id)
        switch profile.usageMode:
          'preconfigured' ->
            cred = AuthProfileService.resolve(profile)
            if cred.tokenExpired:
              tokenRefreshService.refresh(profile)  # Redis lock
            if refresh fails -> issues.push(REFRESH_FAILED)   # blocking
          'jit' / 'user_token' -> mark deferredUntilFirstUse
          'preflight' -> requiresUpfrontConsent (NON-BLOCKING per 2026-05-09)
    if scan.issues (Preconfigured failures) -> return { error: AUTH_PROFILE_REFRESH_FAILED, ... }
    if any preflight -> SDK presents prompts; user may consent OR skip OR fail —
      successful consent persists tokens; declined/failed consent => downgrade
      that profile to deferredUntilFirstUse (JIT behavior). DO NOT block session.
    session.status = 'ready'
```

**Two revoke actions (FR-23, FR-24)**

```
[Revoke Profile]                       [Revoke User Tokens]
Studio modal                           Studio modal
  GET .../revoke-preview?type=profile    GET .../revoke-preview?type=tokens[&userId=…]
     payload: { affectedConsumers,         payload: { affectedConsumers,
                affectedUsers,                        affectedUsers,
                activeSessions,                       activeSessions }
                cascadeDeletesTokens,
                irreversible: true }
admin confirms                         admin confirms
POST .../revoke                        POST .../revoke-user-tokens[?userId=…]
  profile.status = 'revoked'             EndUserOAuthToken.deleteMany(
  profile.encryptedSecrets = null         {tenantId, profileId[, userId]})
  EndUserOAuthToken.deleteMany(           emit 'tokens_revoked' (scope:
   {tenantId, profileId})                  all_users | single_user)
  emit 'profile_revoked'                 publish Redis "auth-profile:invalidate"
  publish Redis "auth-profile:invalidate"
                                       runtime tool calls hitting cleared tokens:
runtime tool calls hitting revoked        re-prompt for re-auth (JIT) or
profiles return:                          structured AUTH_PROFILE_REFRESH_FAILED
{ error: { code: AUTH_PROFILE_REVOKED } } (Preconfigured)
```

**Mid-session invalidation (FR-26)**

```
admin -> POST /api/projects/:projectId/auth-profiles/:profileId/force-invalidate
  Studio API:
    publish Redis pub/sub channel "auth-profile:invalidate" with
    { profileId, tenantId, projectId }
  -> 200 (fire-and-forget; returns subscriber count if known)

each runtime pod's ForceInvalidateSubscriber:
  on message:
    AuthProfileCache.invalidate(profileId)
    emit trace 'auth_profile.cache_invalidated' (reason='force')

next tool call needing this profile:
  cache miss -> resolve from MongoDB
  if profile.status='revoked' OR profile is deleted ->
    return structured error to caller (sanitized for end-user)
```

**Insufficient-scope detection (FR-29)**

```
Path A — OAuth callback:
  callback handler receives token response with scope: "read write"
  compare against requestedScopes from PKCE state (e.g. "read write delete")
  if granted < requested:
    emit 'scope_insufficient_detected' (source='oauth_callback',
      payload: { requestedScopes, grantedScopes, missingScopes })
    token still stored (downstream may still work for partial scopes)

Path B — Tool call:
  provider returns 401 { error: 'insufficient_scope', error_description: '…' }
  ScopeInsufficientDetector:
    emit 'scope_insufficient_detected' (source='tool_call',
      payload: { requestedScopes, grantedScopes, missingScopes, toolId, runtimeContext })
    return structured error to SDK:
      { error: { code: 'REAUTHORIZATION_REQUIRED',
                 message: 'This action requires additional permissions. Please re-authorize.' } }
    SANITIZATION: response payload free of tenantId, profileId, provider name, scope names
```

### 9.4 The 12 Architectural Concerns — ABLP-913 Decisions

#### Structural Concerns

| #   | Concern                | ABLP-913 Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Resource Isolation** | `EndUserOAuthToken` becomes project-scoped via `{tenantId, projectId, userId, provider}` unique index (D-4). Cross-project token reuse is BLOCKED at the index level. `auth_profile_audit_events` carries denormalized `tenantId, projectId` for every row; queries always include both. Tool configs store only saved-profile `authProfileId` references; no inline credential payload is scoped through tools. Personal profiles unchanged.                                                                                                                                                                                           |
| 2   | **Auth & Permissions** | Authorize CTA, Revoke Profile, Revoke User Tokens, force-invalidate use the existing `auth_profile:write` permission via `requireProjectPermission`. Open Question: introduce a finer-grained `auth_profile:authorize` permission in a follow-up RBAC pass (Open Question 9 in feature spec). Inline credential entry is removed, so credential creation follows normal auth-profile create permissions. RBAC unchanged for read paths.                                                                                                                                                                                                 |
| 3   | **API Contract**       | Five new endpoints: `POST /:profileId/revoke-user-tokens` (with optional `userId` query); `POST /:profileId/force-invalidate` (P2); `GET /:profileId/revoke-preview?type=profile\|tokens[&userId=…]`; `GET /:profileId/audit-events` (cursor-paginated, 50/page default per D-10); `GET /api/projects/:projectId/auth-profiles/integrations` (vendor-grouped). All return the standard `{ success, data?, error?: { code, message } }` envelope. Existing `/oauth/callback` and `/oauth/user-consent` extended to write `projectId` + `profileId` to `EndUserOAuthToken`; `/consumers` extended (D-14) to include ToolDefinition + A2A. |
| 4   | **Security Surface**   | Inline credential entry is removed; tool config holds only an opaque saved-profile ID — never plaintext. `auth_profile_audit_events` payloads MUST NEVER include secret material. `revoke-preview` / `audit-events` responses are subject to existing `redactAuthProfile()`. Insufficient-scope user-facing message is sanitized per CLAUDE.md `User-Facing Runtime Error Sanitization`. SSRF protection unchanged (URL Zod schemas).                                                                                                                                                                                                   |

#### Behavioral Concerns

| #   | Concern           | ABLP-913 Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | New error codes: `AUTH_PROFILE_TYPE_MISMATCH` (FR-9 invalid `profileType`/`connector` combo); `AUTH_PROFILE_REFRESH_URL_REQUIRED` (FR-16 CREATE-time); `AUTH_PROFILE_REFRESH_URL_MISSING` (FR-16 validate-time warning); `AUTH_PROFILE_INLINE_DEPRECATED` (FR-20 inline credential rejection); `AUTH_PROFILE_REVOKED` / `AUTH_PROFILE_DELETED` / `AUTH_PROFILE_REFRESH_FAILED` (FR-12, FR-17, FR-27 runtime); `INSUFFICIENT_SCOPE` (admin-visible) / `REAUTHORIZATION_REQUIRED` (user-visible, sanitized). Validate endpoint returns warnings as non-blocking codes. |
| 6   | **Failure Modes** | Refresh failure → audit `token_refresh_failed`, alert evaluator fires, per-user `isAuthorized` becomes false (D-7). Revoke-wins race: `revoke-user-tokens` deleteMany runs after the OAuth callback's upsert, so any in-flight callback that lands first will be cleared by the revoke; tests cover this. Force-invalidate partial pod failure: P2 — surviving pods drop entries on TTL within ≤ 5 min as the safety net. Deleted profile at tool-call time → structured `AUTH_PROFILE_DELETED` error, never silent skip (FR-27).                                    |
| 7   | **Idempotency**   | All new endpoints use POST/GET semantics with idempotent server behavior: re-running `revoke-user-tokens` is safe (deleteMany on already-empty set is a no-op). Migration scripts MUST be idempotent and rollback-safe (test in MIG-1, MIG-2). `force-invalidate` is idempotent — duplicate publishes invalidate the same key.                                                                                                                                                                                                                                       |
| 8   | **Observability** | New trace events (via `emitAuthProfileTraceEvent`): `auth_profile.session_init.scan_completed`, `auth_profile.session_init.preconfigured_resolved`, `auth_profile.session_init.refresh_failed`, `auth_profile.cache_invalidated` (reason=force\|ttl), `auth_profile.scope_insufficient`. New audit-event collection drives the per-profile Activity tab. Health probes extended to include `auth_profile_audit_events` write-path probe. Alert evaluator extended with two new dimensions: `revoke_user_tokens_per_minute`, `scope_insufficient_per_hour`.           |

#### Operational Concerns

| #   | Concern                | ABLP-913 Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Session-init scan: P95 < 250ms for sessions with ≤ 10 unique auth references (success metric §14). Blast-radius aggregator: P95 < 300ms for fixtures (INT-24). `auth_profile_audit_events` write: best-effort, batched where possible; never on the hot path. Pod-local cache TTL: 5 min (existing). Force-invalidate Redis pub/sub propagation target: < 100ms intra-cluster.                                                                                                                                                                                                                                                                                                                             |
| 10  | **Migration Path**     | Two coordinated migrations (D-9): (1) `YYYYMMDD_NNN_auth_profile_profile_type` backfills `profileType` from `connector` presence (idempotent + reversible); (2) `YYYYMMDD_NNN_end_user_oauth_token_project_scope` adds `projectId` + `profileId`, drops old unique index, creates new compound unique + secondary indexes, with three backfill cases per OQ-6: profile.projectId known → use it; tenant-scoped profile → leave null + deprecation warning; unresolvable → leave null and force re-auth at next use. Both gated by Redis lock at the runner.                                                                                                                                                |
| 11  | **Rollback Plan**      | Each migration ships a rollback script that reverses the data shape (drop new fields, recreate old indexes). For the runtime: `AuthProfileSessionScanner` is feature-gated by an env flag `AUTH_PROFILE_SESSION_SCAN_ENABLED` (default ON post-rollout); if a regression is detected, ops can flip the flag to revert to lazy-resolve behavior without rolling code. Two-revoke actions: only the new endpoint is additive; rolling back means hiding the new UI button — server stays compatible.                                                                                                                                                                                                         |
| 12  | **Test Strategy**      | Coverage per the test spec: 8 new E2E (HTTP-only against real Express + MongoMemoryServer + ioredis-mock + DI-stubbed OAuth providers); ~18-20 new integration scenarios — 13 base IDs (INT-9, INT-10, INT-12, INT-13, INT-16, INT-17, INT-18, INT-20, INT-21, INT-22, INT-24, INT-26, INT-27, INT-28, INT-30, INT-31) plus a/b variants (INT-23a, INT-23b, INT-29a, INT-29b) — real services, no `vi.mock` of platform code per CLAUDE.md; 2 migration tests (idempotency + rollback). Performance assertions for session-init scan and blast-radius aggregator are STRETCH at functional level; load-test phase (capacity-planner) takes them to budget verification. No test mocks platform components. |

### 9.5 Data Model Design (additions)

**`auth_profiles` (new fields)**

| Field              | Type                           | Purpose                                                                                   |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `profileType`      | `'integration' \| 'custom'`    | Discriminator (D-1). Migration backfills from `connector` presence.                       |
| `lastAuthorizedAt` | `Date \| null`                 | Set on Authorize CTA success.                                                             |
| `lastAuthorizedBy` | `string \| null`               | Admin userId who authorized.                                                              |
| `inlineHostedTool` | `{ toolId, fieldKey } \| null` | Legacy compatibility metadata only. New inline credential creation is rejected per FR-20. |

New query index: `{ tenantId, projectId, profileType, connector }` powers Integrations Tab vendor grouping.

**`end_user_oauth_tokens` (new fields)**

| Field       | Type             | Purpose                                                                   |
| ----------- | ---------------- | ------------------------------------------------------------------------- |
| `projectId` | `string \| null` | Project-scoped consent (D-4). Required for new rows; nullable for legacy. |
| `profileId` | `string \| null` | FK to `auth_profiles`. Powers per-profile bulk revoke (FR-23).            |

> **Deviation note (vs feature spec §9)**: The feature spec text declares both `projectId` and `profileId` as `required`, but the backfill strategy (Open Question 6) explicitly leaves some legacy rows with `projectId: null` and `profileId: null` ("rows that cannot be deterministically mapped are left null and force re-auth at next use"). The HLD adopts `string | null` to match the practical migration reality. **LLD action**: Mongoose schema MUST be `{ required: false }` for both fields so existing rows remain valid; the application layer rejects writes that omit either field on **new** rows post-migration. The unique-index strategy below relies on a partial index for `projectId IS NOT NULL` to avoid blocking legacy null rows.

Index changes: drop unique `{tenantId, userId, provider}`; create unique `{tenantId, projectId, userId, provider}` **as a partial index** with filter `{ projectId: { $type: "string" } }` so legacy null-projectId rows do not collide; create non-unique `{tenantId, profileId, userId}` (also partial on `profileId IS NOT NULL`).

**`auth_profile_audit_events` (NEW collection)**

10 event types per FR-30. TTL-indexed at 365 days. Indexes:

- `{ tenantId, projectId, profileId, createdAt: -1 }` — Activity tab primary query
- `{ tenantId, eventType, createdAt: -1 }` — cross-profile event queries
- `{ createdAt: 1 }` (TTL: 365 days)

Plugins: `tenantIsolationPlugin` (reads); `auditTrailPlugin` is **not** applied to this collection (it would create a recursive write-tracking loop).

### 9.6 API Design (additions)

| Method | Path                                                                                  | Auth                 | Purpose                                                  |
| ------ | ------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------- |
| GET    | `/api/projects/:pid/auth-profiles/integrations`                                       | `auth_profile:read`  | Vendor-grouped Integrations Tab data (FR-10)             |
| GET    | `/api/projects/:pid/auth-profiles/:id/revoke-preview?type=profile\|tokens[&userId=…]` | `auth_profile:write` | Pre-revoke blast-radius (FR-24)                          |
| POST   | `/api/projects/:pid/auth-profiles/:id/revoke-user-tokens[?userId=…]`                  | `auth_profile:write` | Revoke User Tokens — bulk or per-user (FR-23)            |
| POST   | `/api/projects/:pid/auth-profiles/:id/force-invalidate`                               | `auth_profile:write` | Cross-pod cache invalidation broadcast (FR-26 P2)        |
| GET    | `/api/projects/:pid/auth-profiles/:id/audit-events[?eventType=…&cursor=…&limit=…]`    | `auth_profile:read`  | Per-profile audit events for Activity tab (FR-30, FR-31) |

**Modified endpoints**:

- `GET /:id/consumers` — extended (D-14) to include `ToolDefinition` (HTTP tools) and `A2AServer` (when model exists; otherwise returns `warning: "a2a_model_not_yet_available"` and `a2aServers: []`).
- `POST /oauth/callback` and `POST /oauth/user-consent` — write `projectId` + `profileId` to `EndUserOAuthToken`.
- `POST /:id/validate` — returns non-blocking warning code `AUTH_PROFILE_REFRESH_URL_MISSING` for existing profiles missing it.
- `POST /:id/revoke` — preview is now collected from `revoke-preview?type=profile`; behavior unchanged on confirm.

### 9.7 Alternatives Considered (ABLP-913)

**A. Profile typing via inferred `connector` presence (status quo)**

- Pros: zero migration; works today.
- Cons: fragile; conflates "has vendor metadata" with "is integration profile"; no index-based filtering for Integrations Tab; UI has to apply heuristics.
- **Rejected** in favor of D-1 (explicit `profileType` field).

**B. Tenant-scoped consent persistence (status quo `EndUserOAuthToken`)**

- Pros: zero migration; one row per `{tenant, user, provider}` is simpler.
- Cons: violates project-isolation invariant (CLAUDE.md Core Invariant #1); a token authorized in project A is silently reused in project B; ABLP-913 §13 explicitly mandates per-project consent.
- **Rejected** in favor of D-4 (project-scoped index).

**C. Single overloaded `revoke` endpoint with `mode` parameter**

- Pros: fewer routes; one URL.
- Cons: conflates two distinct operations with different semantics, side effects, and audit shapes; harder to RBAC; tests get tangled.
- **Rejected** in favor of D-13 (separate `revoke-user-tokens` endpoint).

**D. New status enum value `pending_authorization`**

- Pros: single enum tells the whole story.
- Cons: status currently models profile health (active/expired/revoked/invalid), authorization is a per-user concern; combining them is a combinatorial explosion (e.g., what is `expired AND pending_authorization`?); breaks the existing status lifecycle. A related sub-decision (D-3): unauthorized OAuth profiles are rendered as **disabled rows** in assignment dropdowns rather than hidden, so admins retain blast-radius visibility while preventing accidental selection.
- **Rejected** in favor of D-9 (computed `isAuthorized`) plus D-3 (disabled-row rendering).

**E. HTTP fanout for force-invalidate**

- Pros: no new transport.
- Cons: requires service discovery + per-pod failover; non-trivial reliability story; pub/sub is the project-wide pattern.
- **Rejected** in favor of D-6 (Redis pub/sub).

**F. Replace `AuthProfilePicker` outright with the new stepped UI**

- Pros: single component; fewer code paths.
- Cons: 8 existing callers across Git, Model, Guardrail, Voice, Connection, MCP, Channel — coordinated breaking change is high cost; Risk per CLAUDE.md "Export removal guard".
- **Rejected** in favor of D-10 (coexist; migrate incrementally).

**G. Per-tool plaintext storage of inline credentials**

- Pros: simplest model.
- Cons: violates encryption-at-rest invariant (CLAUDE.md Core Invariant #5); secrets visible in tool documents.
- **Rejected**. Earlier drafts considered transient encrypted profiles; ABLP-913 now requires saved auth profiles only.

### 9.8 Risks and Mitigations (ABLP-913)

| Risk                                                                | Severity | Mitigation                                                                                                                                                                           |
| ------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EndUserOAuthToken` index swap fails on a hot collection            | HIGH     | Migration runs under Redis lock; pre-create new index in background; drop-old + create-new performed in a single `collMod` with rollback ready.                                      |
| Backfill leaves orphan tokens (`projectId: null`)                   | MEDIUM   | Three-case strategy (D-4, OQ-6); orphan rows remain functional in a "tenant-fallback" bucket; deprecation warning emits at next refresh.                                             |
| Session-init scan blocks session start on slow refresh              | MEDIUM   | Refresh attempts have explicit timeout; scan returns `issues[]` rather than hanging; SDK shows clear error.                                                                          |
| Force-invalidate broadcast lost (Redis hiccup)                      | LOW      | TTL-based eventual consistency (≤ 5 min) is the safety net; any single message loss self-heals on next access.                                                                       |
| Legacy `inlineHostedTool` rows accumulate                           | LOW      | New inline credential creation is rejected. Existing legacy rows, if present, remain encrypted auth profiles and can be cleaned up with owning tool deletion or migration follow-up. |
| Audit log volume balloons in active sessions                        | LOW      | TTL 365 days; events emitted off the hot path; secondary index by `eventType` to avoid full-collection scans.                                                                        |
| Insufficient-scope detection misses non-standard provider responses | MEDIUM   | Detector is provider-agnostic — keyed off `error: insufficient_scope` AND HTTP 401/403 with WWW-Authenticate scope hints. Catch-all returns generic re-auth prompt.                  |
| `auth_profile:write` permission too coarse for new Authorize CTA    | MEDIUM   | Open Question 9 — addressed in a follow-up RBAC ticket; baseline reuses existing permission.                                                                                         |

### 9.9 Open Questions for LLD

These are deliberately punted from HLD to LLD where implementation choices are made:

1. **A2A model existence** — gate the `a2aServers` consumer query behind a runtime flag until the model lands. LLD defines the flag name and the no-op shape.
2. **Force-invalidate transport choice formalized** — pub/sub picked at HLD level; LLD defines exact channel name, payload schema, retry policy, and pod-side replay/de-dupe.
3. **`auth_profile:authorize` permission introduction** — punt to a follow-up RBAC ticket; LLD documents the temporary reuse of `auth_profile:write` and the upgrade path.
4. **Legacy inlineHostedTool cleanup (P2)** — if real legacy rows exist, decide whether to migrate, delete with owning tools, or promote them to saved profiles.
5. **Pod-local force-invalidate replay protection** — Redis pub/sub is at-most-once; LLD decides whether to add a small in-memory dedupe window (e.g. 60s) to suppress redundant invalidations under high churn.

### 9.10 Cross-Phase Traceability

Each ABLP-913 functional requirement maps to:

| FR    | HLD Section(s)                           | Component                                  |
| ----- | ---------------------------------------- | ------------------------------------------ |
| FR-9  | §9.5, §9.7-A                             | `profileType` field + migration            |
| FR-10 | §9.6, §9.5 (index)                       | `/integrations` endpoint                   |
| FR-11 | §9.4 #1                                  | `usageMode` enforcement in scan + revoke   |
| FR-12 | §9.2, §9.3, §9.4 #6, §9.4 #9             | AuthProfileSessionScanner                  |
| FR-13 | §9.2, §9.3                               | Authorize CTA wiring (Studio + slide-over) |
| FR-14 | §9.2, §9.4 #1, §9.7-D                    | Computed `isAuthorized`                    |
| FR-15 | §9.6, §9.2                               | API-shape `selectable: false` + UI         |
| FR-16 | §9.4 #5                                  | Schema change at CREATE                    |
| FR-17 | §9.3 (refresh path), §9.4 #6, §9.4 #8    | token-refresh-service alerts               |
| FR-18 | §9.2, §9.7-F                             | `AuthProfileAssignment` component          |
| FR-19 | §9.6 (UI behavior)                       | URL query param hand-off                   |
| FR-20 | §9.4 #4, §9.7-G                          | Transient encrypted profile                |
| FR-21 | §9.6                                     | Extended `/consumers`                      |
| FR-22 | §9.6                                     | DELETE with consumer-count guard           |
| FR-23 | §9.3, §9.6, §9.7-C                       | Two endpoints                              |
| FR-24 | §9.3, §9.6, §9.2 (BlastRadiusAggregator) | revoke-preview                             |
| FR-25 | §9.4 #5                                  | Studio toast (sensitive-field diff)        |
| FR-26 | §9.2, §9.3, §9.4 #1, §9.4 #6, §9.7-E     | force-invalidate broadcast                 |
| FR-27 | §9.4 #5, §9.4 #6                         | Structured `AUTH_PROFILE_DELETED` error    |
| FR-28 | §9.5, §9.4 #1, §9.4 #10, §9.7-B          | EndUserOAuthToken project scoping          |
| FR-29 | §9.2, §9.3, §9.4 #5, §9.4 #4             | ScopeInsufficientDetector + sanitization   |
| FR-30 | §9.2, §9.5, §9.4 #8                      | `auth_profile_audit_events` collection     |
| FR-31 | §9.2, §9.6                               | Activity tab + endpoint                    |
