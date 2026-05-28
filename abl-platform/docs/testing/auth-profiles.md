# Feature Test Guide: Auth Profiles

**Feature**: Auth Profiles -- unified credential management with encryption, rotation, OAuth lifecycle, and multi-level resolution
**Owner**: Platform team
**Branch**: KI081/feat/ablp-913-auth-profiles
**Related Feature Doc**: [docs/features/auth-profiles.md](../features/auth-profiles.md)
**First tested**: 2026-03-18
**Last updated**: 2026-05-13
**Overall status**: ACTIVE COVERAGE -- 191 verified auth-related test files across database (14), shared/shared-auth-profile (42), runtime (82), studio (52), and project-io (1). **ABLP-913 (FR-9..FR-33) core implementation and 2026-05-13 review hardening have landed — unit/integration coverage exists for all P0 FRs; E2E coverage remains PARTIAL. Eight ABLP-913 E2E specs are authored under `apps/studio/e2e/auth-profiles/`, but strict end-to-end execution depth is still pending.**

---

## ABLP-913 Coverage Matrix (FR-9 .. FR-31)

The feature spec adds ABLP-913 FRs covering: profile typing, Integrations Tab, session-init scan, Authorize CTA + To-be-Authorized state, profile-only type-aware assignment UI, Used-by view extension, two revoke actions with blast-radius warnings, project-scoped consent persistence, mid-session token invalidation, audit logs, OAuth error mapping, and insufficient-scope error handling.

| FR    | Priority | Description                                      | Unit | Integration | E2E | Manual | Status   | Mapped Tests / Actual Files                                                                          |
| ----- | -------- | ------------------------------------------------ | ---- | ----------- | --- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| FR-9  | P0       | profileType discriminator + backfill             | ✅   | ✅          | -   | -      | PARTIAL  | `20260508_019_profile_type.test.ts`, `cascade-delete-auth-profile.test.ts`                           |
| FR-10 | P0       | Integrations Tab vendor-grouped view             | ✅   | ✅          | ✅  | -      | PARTIAL  | `integrations-route.test.ts`, `integration-catalog.test.ts`, `integration-auth-profiles.e2e.test.ts` |
| FR-11 | P0       | usageMode applies everywhere it is referenced    | ✅   | ✅          | -   | -      | PARTIAL  | `is-authorized.test.ts`, `session-scanner.test.ts`                                                   |
| FR-12 | P0       | Session-init scan (Preconfigured/JIT/Preflight)  | ✅   | ✅          | -   | -      | PARTIAL  | `session-scanner.test.ts`, runtime bootstrap wiring                                                  |
| FR-13 | P0       | Profile-level Authorize CTA (card + slide-over)  | ✅   | ✅          | -   | -      | PARTIAL  | `auth-profile-slide-over-authorize-flow.test.tsx`, OAuth callback route test                         |
| FR-14 | P1       | Computed `isAuthorized` per user                 | ✅   | ✅          | -   | -      | PARTIAL  | `is-authorized.test.ts`, `AuthProfileHealthPill.test.tsx`                                            |
| FR-15 | P1       | Disabled-row dropdown for unauthorized OAuth     | ✅   | -           | -   | -      | PARTIAL  | `AuthProfileAssignment.test.tsx`                                                                     |
| FR-16 | P0       | refreshUrl required at CREATE for Preconfigured  | ✅   | ✅          | -   | -      | PARTIAL  | `auth-profile-schema.test.ts`, validate route test                                                   |
| FR-17 | P0       | Auto refresh + alert + revert to To-be-Auth      | ✅   | ✅          | -   | -      | PARTIAL  | `token-refresh-service.test.ts`, `auth-profile-alerting.test.ts`                                     |
| FR-18 | P0       | Type-aware stepped assignment UI                 | ✅   | ✅          | -   | -      | PARTIAL  | `AuthProfileAssignment.test.tsx`, IntegrationNodeConfig wiring                                       |
| FR-19 | P2       | Pre-filter on arrival via CTA                    | -    | -           | -   | -      | DEFERRED | Not implemented                                                                                      |
| FR-20 | P0       | Inline-Add removed; credentials must be profiles | N/A  | N/A         | N/A | -      | REMOVED  | Removed per 2026-05-09 meeting decision                                                              |
| FR-21 | P1       | Used-by extended (ToolDefinition + A2A)          | ✅   | ✅          | -   | -      | PARTIAL  | `auth-profile-consumers-routes.test.ts`                                                              |
| FR-22 | P0       | Deletion guard with consumer list (extended)     | ✅   | ✅          | -   | -      | PARTIAL  | `cascade-delete-auth-profile.test.ts`, consumer routes test                                          |
| FR-23 | P0       | Two revoke actions (Profile + User Tokens)       | ✅   | ✅          | -   | -      | PARTIAL  | `revoke-user-tokens-route.test.ts`, `RevokeUserTokensConfirm.test.tsx`                               |
| FR-24 | P0       | Pre-revoke blast-radius warning                  | ✅   | ✅          | -   | -      | PARTIAL  | `blast-radius-aggregator.test.ts`, `revoke-preview-route.test.ts`                                    |
| FR-25 | P2       | Sensitive-field-change advisory                  | ✅   | -           | -   | -      | PARTIAL  | `SensitiveFieldChangeAdvisory.tsx` exists (UI component)                                             |
| FR-26 | P0       | Mid-session invalidation (TTL P1 + force P2)     | ✅   | ✅          | -   | -      | PARTIAL  | `force-invalidate.test.ts`, subscriber + publisher tests                                             |
| FR-27 | P1       | Clear delete-time errors at consumer call site   | ✅   | ✅          | -   | -      | PARTIAL  | `auth-profile-consumer-error-handling.test.ts`, resolve-tool-auth                                    |
| FR-28 | P0       | Project-scoped consent persistence               | ✅   | ✅          | -   | -      | PARTIAL  | `20260508_020_end_user_oauth_token_project.test.ts`                                                  |
| FR-29 | P1       | Insufficient-scope detection + sanitized prompt  | ✅   | ✅          | -   | -      | PARTIAL  | `scope-insufficient-detector.test.ts`, `scope-insufficient.test.ts`                                  |
| FR-30 | P1       | auth_profile_audit_events emit points            | ✅   | ✅          | -   | -      | PARTIAL  | `audit-event-emitter.test.ts`, `audit-events-route.test.ts`                                          |
| FR-31 | P1       | Activity tab in slide-over                       | ✅   | -           | -   | -      | PARTIAL  | `ActivityTabPanel.tsx` component (no dedicated test yet)                                             |

> Mandatory minimums per SDLC pipeline: ≥5 E2E + ≥5 integration. ABLP-913 has **8 authored E2E specs** (E2E-8..E2E-15) and **15 integration** scenarios (INT-9..INT-31, including a/b variants). Final strict E2E execution remains pending.

---

## ABLP-913 E2E Test Scenarios (NEW)

> All scenarios run against a real Express server (port: 0), a real MongoMemoryServer, real ioredis-mock for cache/lock, real EncryptionService. Only third-party OAuth providers are DI-stubbed. NO `vi.mock` of `@agent-platform/*`, `@abl/*`, or relative paths.

### E2E-8: Integration Profile Lifecycle + Authorize CTA (FR-9, FR-10, FR-13, FR-30)

**Purpose**: Verify the full Integration profile flow — create with vendor, view in Integrations Tab, click Authorize CTA, complete OAuth, token reused across multiple consumers, audit events emitted.

**Auth Context**: tenant=T1, project=P1, user=admin (with `auth_profile:write`)

```
1. POST /api/projects/P1/auth-profiles
   { name: "Salesforce Prod", profileType: "integration", connector: "salesforce",
     authType: "oauth2_app", usageMode: "preconfigured", config: {clientId, clientSecret,
     authorizationUrl, tokenUrl, refreshUrl, scopes: "read api"} }
   -> 201; profile.profileType === "integration"; isAuthorized=false
2. GET /api/projects/P1/auth-profiles/integrations
   -> 200; vendor "salesforce" group includes the new profile with isAuthorized=false flag
3. POST /api/projects/P1/auth-profiles/{id}/oauth/initiate (from slide-over Authorize CTA)
   -> 200; PKCE state stored
4. POST /api/projects/P1/auth-profiles/oauth/callback (DI-stubbed provider returns access+refresh)
   -> 200; token persisted on profile; audit event "authorized" written
5. GET /api/projects/P1/auth-profiles/{id}
   -> 200; isAuthorized=true; lastAuthorizedAt populated; lastAuthorizedBy=admin.id
6. Create 2 HTTP tools and 1 integration node referencing this profile (via tool config API)
7. Trigger a runtime tool call from each consumer (POST /api/runtime/.../tool-call)
   -> All 3 calls succeed using the SAME shared token (verify via runtime trace events)
8. GET /api/projects/P1/auth-profiles/{id}/audit-events
   -> Returns ≥ 1 "authorized" event with actorContext.source="profile"
```

**Isolation checks**: Cross-tenant GET integrations returns 404. Cross-project listing does not include this profile.

### E2E-9: Project-Scoped Consent Persistence (FR-28)

**Purpose**: Verify a JIT-authorized user does not re-prompt across sessions in the same project AND is re-prompted in a different project.

**Auth Context**: tenant=T1, projects=P1+P2, end-user=U1

```
1. Admin creates Custom JIT profile in P1: connector="google", usageMode="jit"
2. Start session 1 in P1 as U1; runtime triggers JIT prompt at first tool call
3. POST /api/projects/P1/auth-profiles/oauth/user-consent for U1 -> token stored
   { tenantId: T1, projectId: P1, userId: U1, provider: google } (unique key)
4. Tool call succeeds with U1's token
5. End session 1; start session 2 in P1 as U1; runtime tool call resolves cached token
   -> NO re-prompt; token reused (verify via audit log: no new "authorized" event)
6. Create equivalent profile in P2 (same connector, same JIT mode)
7. Start session in P2 as U1; runtime tool call -> JIT prompt fires AGAIN (project boundary)
8. After step 7 completes, GET /api/projects/P1/auth-profiles/{p1ProfileId}/audit-events?eventType=authorized
   -> exactly 1 "authorized" event (from step 3); no new event added by the P1 session 2 reuse
9. GET /api/projects/P2/auth-profiles/{p2ProfileId}/audit-events?eventType=authorized
   -> exactly 1 "authorized" event from the P2 prompt (project boundary forced re-auth)
10. Negative API check: re-issue session 1's runtime context in P1 -> tool call still succeeds (token reused).
    Re-issue session 1's auth context in P2 with the P2 profile -> JIT prompt fires (no cross-project leak).
```

**Isolation check**: HTTP-only verification — across P1 and P2, audit-event endpoint shows exactly one authorize-per-project for U1, and the P2 session must trigger a JIT prompt. No direct DB queries used to verify isolation.

### E2E-10: Type-Aware Assignment UI + Profile-Only Credential Assignment (FR-15, FR-18, FR-20)

**Purpose**: Verify the new `AuthProfileAssignment` flow at HTTP-tool config — saved-profile selection only, no inline credential entry — and assert disabled-row behavior for unauthorized OAuth.

**Auth Context**: tenant=T1, project=P1, user=builder

```
1. Create 1 saved api_key profile (authorized; isAuthorized=true) and 1 oauth2_app profile
   (NOT authorized; isAuthorized=false) in P1
2. Open HTTP-tool config (POST /api/projects/P1/tools)
3. AuthProfileAssignment Step 1: select authType="api_key"
   -> dropdown shows the saved api_key profile + "Create Auth Profile" CTA; no inline secret entry option is exposed
4. Choose the saved profile
   -> tool config holds opaque authProfileId reference
5. GET /api/projects/P1/tools/{toolId}
   -> response includes `authProfileId` field; response body has NO `apiKey` plaintext field
   -> response body string-search for the saved secret returns no matches (HTTP-level redaction check)
6. AuthProfileAssignment metadata via GET /api/projects/P1/auth-profiles?authType=oauth2_app
   -> response shape includes `inlineAllowed: false` for complex types and per-profile `isAuthorized`
      flags; the unauthorized OAuth profile carries `selectable: false` (drives the disabled-row UI).
   -> "Add value inline" not exposed for any auth type.
7. Trigger a runtime tool call against the new tool
   -> runtime decrypts the saved profile credential and apply-auth attaches it to the outbound HTTP call
      (verified via runtime trace event payload, not raw DB read).
```

**Note (UI assertions)**: This E2E exercises the HTTP API contract that drives the new `AuthProfileAssignment` component. The disabled-row rendering and dropdown DOM behavior are deferred to a future browser/Playwright test; the API response shape (`inlineAllowed`, `selectable`, `isAuthorized`) is what this E2E verifies.

**Isolation check**: Tool config never stores plaintext credentials. Encryption round-trip is verified at integration level by INT-20.

### E2E-11: Profile Deletion Guard + Clear Consumer Errors (FR-22, FR-27)

**Purpose**: Verify deletion is blocked when consumers exist; deletion succeeds after detach; consumer tool calls return clear auth error post-delete.

**Auth Context**: tenant=T1, project=P1, admin (Studio operations steps 1-5); end-user=U1 (runtime tool call step 6)

```
1. [admin] Create profile P; create HTTP tool TX referencing P; create MCP server M referencing P
2. [admin] DELETE /api/projects/P1/auth-profiles/{P.id}
   -> 409 PROFILE_IN_USE; body lists 2 consumers (HTTP tool TX, MCP server M)
3. [admin] Update TX to remove the auth assignment
4. [admin] DELETE /api/projects/P1/auth-profiles/{P.id} again
   -> 409; body lists 1 remaining consumer (MCP server M)
5. [admin] Force-delete via UI confirmation flow:
   DELETE /api/projects/P1/auth-profiles/{P.id}?confirm=true&consumerCount=1
   -> 200; profile deleted
6. [end-user U1] Start a session in P1 and trigger a runtime tool call on MCP server M
   -> Runtime returns structured error
      { success: false, error: { code: "AUTH_PROFILE_DELETED",
        message: "Auth profile X has been deleted; reconfigure this consumer." } }
   -> NOT a generic 500; sanitized message (no tenantId, no profileId)
```

### E2E-12: Session-Init Scan — Preconfigured Refresh + Preflight Prompt (FR-12, FR-17)

**Purpose**: Verify session start scans agent IR, validates Preconfigured tokens (refreshing if expired), and triggers Preflight prompts upfront before first tool call.

**Auth Context**: tenant=T1, project=P1, end-user=U1

```
1. Create 2 profiles: PA (oauth2_app preconfigured, expired access token, valid refresh token)
   and PP (oauth2_app preflight, no token yet for U1)
2. Build agent IR with 2 tools: T1 uses PA, T2 uses PP
3. POST /api/runtime/sessions for U1 with this agent
   -> Runtime: AuthProfileSessionScanner walks IR, collects {PA, PP}
   -> For PA: detects expired token; calls token-refresh-service with Redis lock; receives new token
   -> For PP: identifies as preflight; emits authorization request to SDK channel
4. SDK presents authorization prompt for PP; user U1 authorizes (DI-stubbed provider)
5. Session is now ready: GET /api/runtime/sessions/{id} -> status="ready"
6. Tool call to T1 -> uses freshly-refreshed PA token (no further refresh needed)
7. Tool call to T2 -> uses U1's just-authorized PP token
8. Verify audit events: "token_refreshed" for PA, "authorized" for PP
9. Failure case: re-run with PA refresh endpoint returning 500
   -> Session creation fails with structured error
      { error: { code: "AUTH_PROFILE_REFRESH_FAILED", profileId: PA.id } }
   -> Profile PA's per-user state reverts to isAuthorized=false; alert evaluator fires
```

### E2E-13: Two Revoke Actions with Blast-Radius (FR-23, FR-24)

**Purpose**: Verify both revoke flows show blast-radius before confirmation; Revoke Profile decommissions; Revoke User Tokens leaves profile intact.

**Auth Context**: tenant=T1, project=P1, admin + 2 users (U1, U2) with prior JIT consent

```
1. Create JIT profile PJ; both U1 and U2 have authorized (2 EndUserOAuthToken rows)
2. Create 3 HTTP tools, 2 integration nodes, 1 MCP server referencing PJ
3. UI calls GET /api/projects/P1/auth-profiles/{PJ.id}/revoke-preview?type=tokens
   (endpoint defined in feature spec §8 API table, FR-24)
   -> { affectedConsumers: { tools: 3, integrationNodes: 2, mcpServers: 1, a2aServers: 0,
        connectorConnections: 0, channelConnections: 0 },
        affectedUsers: 2, activeSessions: <count> }
4. POST /api/projects/P1/auth-profiles/{PJ.id}/revoke-user-tokens (no userId param)
   -> 200; both EndUserOAuthToken rows deleted; profile.status still "active"
5. U1 starts new session -> JIT re-prompt fires (token gone)
6. POST /api/projects/P1/auth-profiles/{PJ.id}/revoke-user-tokens?userId=U2
   (after U2 re-authorized, then targeted per-user revoke)
   -> 200; only U2's token deleted; U1's stays
7. POST /api/projects/P1/auth-profiles/{PJ.id}/revoke (Revoke Profile)
   -> 200; profile.status="revoked"; encryptedSecrets cleared;
      remaining EndUserOAuthToken rows cascade-deleted
8. All 6 consumers now return AUTH_PROFILE_REVOKED on next tool call
9. Audit log shows 3 events: "tokens_revoked" (per-profile), "tokens_revoked" (per-user U2),
   "profile_revoked" (final)
```

### E2E-14: Mid-Session Token Invalidation via Force-Invalidate (FR-26)

**Purpose**: Verify revocation propagates to active runtime sessions — both via TTL (P1 baseline) and via the explicit force-invalidate broadcast (P2).

**Auth Context**: tenant=T1, project=P1, end-user=U1, admin

```
1. Create Preconfigured profile PA, authorized; admin completes OAuth
2. U1 starts session; runtime caches PA token in pod-local LRU
3. Verify cache hit on first tool call (trace event "auth_profile.cache_hit")
4. Admin calls POST /api/projects/P1/auth-profiles/{PA.id}/force-invalidate
   -> 200; runtime publishes Redis pub/sub message "auth-profile:invalidate" with profileId
   -> Subscribed runtime pod evicts the cache entry
5. Within 1 second of force-invalidate, U1's next tool call
   -> Runtime detects empty cache; re-resolves from MongoDB; surfaces re-auth prompt
6. Verify trace event sequence: "auth_profile.cache_invalidated" (force) -> "auth_profile.reauth_required"
7. TTL fallback path: skip force-invalidate; advance test clock by 5 min;
   next tool call sees TTL expiry -> same re-resolve behavior
```

### E2E-15: Insufficient-Scope Detection + Sanitized Re-Auth Prompt (FR-29)

**Purpose**: Verify both detection paths — OAuth callback (granted < requested) and tool-call (provider 401/403 with `insufficient_scope`) — emit detailed admin audit while showing sanitized end-user prompt.

**Auth Context**: tenant=T1, project=P1, end-user=U1, admin

```
Path A — OAuth callback insufficient grant:
1. Create JIT profile PJ requesting scopes "read write delete"
2. U1 authorizes; DI-stubbed provider grants only "read write" (omits delete)
3. POST /api/projects/P1/auth-profiles/oauth/callback
   -> 200, but server detects scope-set diff
   -> Audit event "scope_insufficient_detected" written with payload
      { requestedScopes: ["read","write","delete"], grantedScopes: ["read","write"],
        missingScopes: ["delete"] }
   -> Token still stored (downstream may still work for read/write)
4. Admin views Activity tab GET /audit-events?profileId=PJ.id
   -> Sees the detailed scope-mismatch event (admin-visible, full diagnostic)

Path B — Tool-call insufficient_scope:
5. U1 invokes a tool that needs the "delete" scope
6. DI-stubbed provider returns 401 with body { error: "insufficient_scope" }
7. Runtime detects this and:
   - emits audit event "scope_insufficient_detected" with the runtime context
   - returns sanitized error to SDK:
     { error: { code: "REAUTHORIZATION_REQUIRED",
       message: "This action requires additional permissions. Please re-authorize." } }
   - The user-visible message MUST NOT include scope names, provider details, or tenant/profile IDs
8. SDK surfaces the sanitized prompt; user clicks re-authorize; flow returns to OAuth initiate
9. Audit event count for "scope_insufficient_detected" >= 2 (one per path)
```

**Sanitization check (CLAUDE.md)**: User-visible message free of `tenantId`, `profileId`, `provider`, scope names, internal codes.

---

## ABLP-913 Integration Test Scenarios (NEW)

> All scenarios use real `AuthProfileService`, real `EncryptionService`, real `tenantIsolationPlugin`, real `auditTrailPlugin`. MongoDB via MongoMemoryServer. Redis via ioredis-mock. NO mocking of platform internals.
>
> **Integration scenario IDs align with their primary FR number** for traceability (INT-9 → FR-9, INT-12 → FR-12, etc.). FRs without a dedicated INT scenario are intentional: FR-11 covered by INT-12 (usageMode resolution within session-init scan); FR-14 covered by INT-13 (computed `isAuthorized` returned in the same authorization route); FR-15 covered by INT-18 (the `selectable: false` API-shape contract); FR-19 (P2 pre-filter) is unit-only; FR-25 (P2 advisory) is unit-only.

### INT-9: profileType Discriminator + Backfill (FR-9, MIG-1)

**Boundary**: AuthProfileService → MongoDB (auth_profiles model)

```
1. Pre-migration: insert 3 profiles directly: A (connector="google"), B (connector="slack"),
   C (no connector)
2. Run migration script `YYYYMMDD_NNN_auth_profile_profile_type.ts`
3. Assert post-migration: A.profileType="integration", B.profileType="integration",
   C.profileType="custom"
4. Create new profile via service with explicit profileType="custom"
   -> stored as-is; not overridden
5. Create with profileType="integration" but no connector
   -> Validation rejects with structured error code AUTH_PROFILE_TYPE_MISMATCH
6. Migration is idempotent: re-running produces no diff
7. Rollback script reverses: profileType field unset; data unchanged otherwise
```

### INT-10: Integrations Tab Vendor Grouping Endpoint (FR-10)

**Boundary**: Studio API route → AuthProfileService → MongoDB

```
1. Seed 5 profiles: 2 with connector="salesforce", 1 with "google", 1 with "slack",
   1 with profileType="custom" (no connector)
2. GET /api/projects/P1/auth-profiles/integrations
3. Response shape:
   { vendors: [
       { connector: "salesforce", profileCount: 2, profiles: [{id, name, isAuthorized, ...}] },
       { connector: "google", profileCount: 1, ... },
       { connector: "slack", profileCount: 1, ... }
   ] }
4. Custom-only profile NOT included in any vendor group
5. Tenant T2 query returns empty (cross-tenant isolation via plugin)
6. Vendor catalog ordering deterministic (by name asc)
```

### INT-12: Session-Init Scan — Walk Agent IR (FR-11, FR-12)

**Boundary**: AuthProfileSessionScanner → AgentIR walker → AuthProfileService

```
1. Build a synthetic agent IR with 4 tools: T1 (preconfigured PA), T2 (jit PJ),
   T3 (preflight PP), T4 (no auth)
2. Inject 1 nested integration node referencing PA
3. Call AuthProfileSessionScanner.scan(ir, { tenantId, projectId, userId })
4. Returns ScanResult:
   {
     preconfigured: [{ profileId: PA.id, status: "valid"|"refreshing"|"failed" }],
     jit: [{ profileId: PJ.id, deferredUntilFirstUse: true }],
     preflight: [{ profileId: PP.id, requiresUpfrontConsent: true }],
     issues: []  // structured errors when refresh fails
   }
5. usageMode taxonomy enforced: 'user_token' behaves like JIT (deferred); 'preconfigured'
   resolves upfront; 'preflight' returns requiresUpfrontConsent
6. Scan completes in O(N) where N = unique authProfileIds (no duplicates resolved)
```

### INT-13: Authorize CTA + Computed isAuthorized (FR-13, FR-14)

**Boundary**: Studio API route → AuthProfileService → EndUserOAuthToken model

```
1. Create Preconfigured profile (no token yet); GET it -> isAuthorized=false
2. Trigger Authorize CTA flow: POST /oauth/initiate -> /oauth/callback (DI-stubbed)
3. Token stored at profile level; lastAuthorizedAt + lastAuthorizedBy populated
4. GET profile -> isAuthorized=true
5. Create JIT profile; for user U1, isAuthorized starts false
6. After U1 authorizes (EndUserOAuthToken row exists for {T1,P1,U1,google}):
   GET /api/projects/P1/auth-profiles?asUser=U1 -> isAuthorized=true for that profile
7. For user U2 (no token): same GET shows isAuthorized=false
8. Verify Authorize CTA call from non-authorized user returns 403 (RBAC: requires auth_profile:write)
```

### INT-16: refreshUrl Required at CREATE for Preconfigured OAuth (FR-16)

**Boundary**: Studio API route → CreateAuthProfileSchema (Zod)

```
1. POST create with authType="oauth2_app", usageMode="preconfigured", config without refreshUrl
   -> 400 Validation; error code AUTH_PROFILE_REFRESH_URL_REQUIRED
2. POST same with usageMode="jit" and no refreshUrl
   -> 201 Created (refreshUrl optional for non-Preconfigured)
3. PUT update on EXISTING preconfigured profile that lacks refreshUrl
   -> 200 OK (backward-compat; not blocked); validate endpoint returns warning code AUTH_PROFILE_REFRESH_URL_MISSING
4. Validate endpoint warning text matches feature spec FR-16
```

### INT-17: Auto-Refresh Failure → Alert + Revert isAuthorized (FR-17)

**Boundary**: Runtime token-refresh-service → AuthProfileService → AlertEvaluator

```
1. Create Preconfigured profile with stored access+refresh tokens
2. DI-stubbed provider returns 500 on refresh
3. Runtime calls refreshOAuth2Token (with Redis lock)
4. Distributed lock acquired (verify in ioredis-mock)
5. Refresh fails 3 times (retry policy from feature spec)
6. Audit event "token_refresh_failed" written with diagnostic code
7. Profile-level isAuthorized state reverts to false (computed); UI badge becomes "To be Authorized"
8. AuthProfileAlertEvaluator captures the failure in its 4 dimensions
9. Lock released even on failure
```

### INT-18: AuthProfileAssignment Component → Tool Config (FR-18, FR-20)

**Boundary**: Studio API for HTTP tool create/update → AuthProfileService

```
1. POST tool with auth type="api_key" + saved profile selection
   -> tool.authProfileId set; no inline value
2. POST tool with auth type="api_key" + inline secret payload
   -> 400 Validation; error AUTH_PROFILE_INLINE_DEPRECATED
3. POST tool with auth type="oauth2_app" + inline secret payload
   -> 400 Validation; error AUTH_PROFILE_INLINE_DEPRECATED
4. POST tool with auth type="oauth2_app" + saved unauthorized OAuth profile
   -> 201 (allowed; UI shows disabled-row but backend permits)
5. Empty-state: GET /auth-profiles?authType=basic returns []
   -> UI renders "No profiles found" message + Create CTA (verify response shape)
```

### INT-20: Inline Credential Rejection + Saved Profile Redaction (FR-20)

**Boundary**: AuthProfileService → encryptionPlugin → MongoDB

```
1. Attempt to create an auth profile with inlineHostedTool metadata from the service/API
   -> rejected with AUTH_PROFILE_INLINE_DEPRECATED
2. Create a saved api_key auth profile with secret "secret-XYZ"
3. Read raw MongoDB document for the saved profile
   -> encryptedSecrets field is encrypted (AES-256-GCM); plaintext "secret-XYZ" absent
4. Create/update a tool to reference the saved profile
   -> tool.authProfileId references the saved profile; tool.config has no plaintext secret
5. Decrypt saved profile via service
   -> decrypted secrets match { apiKey: "secret-XYZ" }
6. Standard profile list returns the saved profile with redacted secrets only
```

### INT-21: /consumers Endpoint Extended (FR-21)

**Boundary**: Studio API route → consumers query → all consumer collections

```
1. Seed: 1 ConnectorConnection, 1 ChannelConnection, 1 MCPServerConfig, 1 ServiceNode,
   1 ToolDefinition (NEW; via tool config), 1 GitIntegration, 1 TriggerRegistration,
   1 A2AServer (gated; if model exists)
2. GET /api/projects/P1/auth-profiles/{id}/consumers
3. Response includes all 7-8 consumer types with counts and per-consumer auth-state
4. ToolDefinition entries include tool.id, tool.name, tool.authState
5. A2A entry guarded: when A2AServer model not present, returns
   { warning: "a2a_model_not_yet_available" } and a2aServers: []
6. Cross-tenant query returns empty
```

### INT-22: Deletion Guard with Extended Consumer List (FR-22)

**Boundary**: Studio + Runtime delete handlers → consumer check

```
1. Create profile P; create 1 HTTP tool referencing P, 1 MCP server referencing P
2. DELETE → 409 PROFILE_IN_USE; body includes consumer breakdown:
   { connectorConnections: 0, channelConnections: 0, mcpServers: 1, serviceNodes: 0,
     toolDefinitions: 1, gitIntegrations: 0, triggerRegistrations: 0, a2aServers: 0 }
3. Detach tool; DELETE -> still 409 (1 MCP server)
4. Detach MCP server; DELETE -> 200 OK
5. Force-delete with confirmation: DELETE?confirm=true&consumerCount=N matches actual count
   -> 200 OK; cascade-deletes EndUserOAuthToken rows; emits "profile_deleted" audit event
```

### INT-23a: Revoke User Tokens — Per-Profile Bulk (FR-23)

**Boundary**: New endpoint POST /:profileId/revoke-user-tokens → EndUserOAuthToken model

```
1. Create JIT profile PJ; seed 3 EndUserOAuthToken rows for users U1/U2/U3
2. POST /revoke-user-tokens (no userId)
3. Response: { deletedCount: 3, affectedUsers: ["U1","U2","U3"] }
4. EndUserOAuthToken collection has 0 rows for PJ
5. profile.status remains "active"; encryptedSecrets unchanged
6. Audit event "tokens_revoked" written with payload { scope: "all_users", count: 3 }
```

### INT-23b: Revoke User Tokens — Per-User (FR-23)

**Boundary**: Same endpoint with ?userId= query param

```
1. Same setup as INT-23a
2. POST /revoke-user-tokens?userId=U2
3. Response: { deletedCount: 1, affectedUsers: ["U2"] }
4. EndUserOAuthToken still has rows for U1 and U3
5. Audit event "tokens_revoked" with payload { scope: "single_user", userId: U2 }
6. Concurrent OAuth callback race: while revoke for U2 in flight, OAuth callback for U2 lands
   -> revoke wins (callback's tokens are immediately deleted by the in-flight revoke);
      verify final EndUserOAuthToken count = 2 (U1, U3)
```

### INT-24: Pre-Revoke Blast-Radius Preview Aggregation (FR-24)

**Boundary**: Studio API `GET /:profileId/revoke-preview` → blast-radius aggregator service → 7+ consumer collections + EndUserOAuthToken + active sessions cache

```
1. Seed deterministic state: profile PJ; 4 HTTP tools, 3 integration nodes, 2 MCP servers,
   1 ChannelConnection, 1 ConnectorConnection, 0 A2A servers (gated), 5 EndUserOAuthToken rows
   for 5 distinct users, 2 active sessions known to be using PJ
2. GET /api/projects/P1/auth-profiles/{PJ.id}/revoke-preview?type=tokens
   -> 200; payload exactly:
      { type: "tokens",
        affectedConsumers: { tools: 4, integrationNodes: 3, mcpServers: 2,
          a2aServers: 0, connectorConnections: 1, channelConnections: 1,
          serviceNodes: 0, gitIntegrations: 0, triggerRegistrations: 0 },
        affectedUsers: 5, activeSessions: 2 }
3. GET ...?type=tokens&userId=U2 (per-user preview)
   -> affectedUsers: 1; activeSessions counts only U2's sessions
4. GET ...?type=profile (Revoke Profile preview)
   -> includes the same consumer counts + a flag `irreversible: true` and
      `cascadeDeletesTokens: 5`
5. Cross-tenant T2 query for the same profile id -> 404
6. Cross-project P2 query for the profile -> 404
7. Profile id that does not exist -> 404
8. Aggregation completes within 300ms P95 for fixtures (low priority perf assertion)
```

### INT-26: Mid-Session Invalidation — Redis Pub/Sub Broadcast (FR-26)

**Boundary**: Studio force-invalidate route → Redis pub/sub → runtime subscriber → AuthProfileCache

```
1. Runtime pod boots, subscribes to "auth-profile:invalidate" channel
2. Cache populated with profile P credentials
3. POST force-invalidate publishes message { profileId: P.id, tenantId: T1 }
4. Runtime subscriber receives within < 100ms (ioredis-mock pub/sub)
5. AuthProfileCache.invalidate(P.id) called; entry evicted
6. Trace event "auth_profile.cache_invalidated" emitted with reason="force"
7. TTL fallback verified separately: do NOT call force-invalidate; advance clock 5 min;
   next access misses cache (TTL eviction) — same effect
```

### INT-27: Clear Auth Errors at Tool Call When Profile Deleted (FR-27)

**Boundary**: Runtime tool-call path → AuthProfileService.resolve

```
1. Create profile P; create tool T referencing P
2. Delete profile P (force-confirm with consumerCount=1)
3. Runtime invokes tool T
4. Service.resolve throws AuthProfileError with code AUTH_PROFILE_NOT_FOUND
5. Runtime catches and returns structured response to caller:
   { success: false,
     error: { code: "AUTH_PROFILE_DELETED",
              message: "Auth profile X has been deleted; reconfigure this consumer." } }
6. End-user-visible message is sanitized (no tenantId/profileId)
7. Audit event "profile_deleted" already written from step 2
```

### INT-28: Project-Scoped Consent — EndUserOAuthToken Index Behavior (FR-28, MIG-2)

**Boundary**: EndUserOAuthToken model → MongoDB unique index

```
1. Run migration: drop {tenantId,userId,provider} unique; create {tenantId,projectId,userId,provider}
2. Insert: { tenantId:T1, projectId:P1, userId:U1, provider:"google", ... } -> OK
3. Insert: { tenantId:T1, projectId:P1, userId:U1, provider:"google", ... } again
   -> DuplicateKeyError (unique violated)
4. Insert: { tenantId:T1, projectId:P2, userId:U1, provider:"google", ... }
   -> OK (different projectId)
5. Lookup query findOne({tenantId:T1,projectId:P1,userId:U1,provider:"google"}) -> first row
6. Lookup query findOne({tenantId:T1,projectId:P2,userId:U1,provider:"google"}) -> second row
7. Cross-project: findOne({tenantId:T1,projectId:P3,userId:U1,provider:"google"}) -> null
8. Backfill cases (covered in MIG-2 below)
```

### INT-29a: Insufficient-Scope at OAuth Callback (FR-29)

**Boundary**: OAuth callback handler → scope diff → audit event emitter

```
1. Profile PJ requests scopes ["read","write","delete"]
2. OAuth callback receives token response with scope: "read write" (delete absent)
3. Handler computes diff: missingScopes=["delete"]; grantedScopes=["read","write"]
4. Audit event "scope_insufficient_detected" written:
   { profileId, requestedScopes, grantedScopes, missingScopes, source: "oauth_callback" }
5. Token still stored (downstream may still work for granted scopes)
6. Admin GET /audit-events?profileId=PJ.id&eventType=scope_insufficient_detected -> sees event
```

### INT-29b: Insufficient-Scope at Tool Call (FR-29)

**Boundary**: Runtime tool-call path → provider error parser → user-facing error sanitizer

```
1. PJ has token with scope "read write" (no delete)
2. Tool that needs delete invoked; DI-stubbed provider returns
   401 { error: "insufficient_scope", error_description: "delete scope required" }
3. Runtime detects insufficient_scope error class
4. Audit event "scope_insufficient_detected" with source="tool_call" and tool/runtime context
5. Runtime returns sanitized response to SDK:
   { error: { code: "REAUTHORIZATION_REQUIRED",
              message: "This action requires additional permissions. Please re-authorize." } }
6. Sanitization assertion: response payload free of tenantId, profileId, provider name, scope names
```

### INT-30: Audit-Events Emit Points (FR-30)

**Boundary**: AuthProfileAuditEventEmitter → auth_profile_audit_events collection

```
For each event type, trigger the action and assert exactly one event is written:
- "authorized" (Authorize CTA success)
- "authorize_failed" (OAuth callback failure)
- "token_refreshed" (refresh-service success)
- "token_refresh_failed" (refresh-service failure)
- "profile_revoked" (revoke endpoint)
- "tokens_revoked" (revoke-user-tokens endpoint, per-profile and per-user variants)
- "profile_updated" (PUT to profile)
- "sensitive_field_changed" (PUT changing clientId/secret/scopes/tokenUrl/refreshUrl)
- "profile_deleted" (DELETE profile)
- "scope_insufficient_detected" (callback or tool-call)

Each event document includes tenantId, projectId, profileId, actorUserId, actorContext, eventPayload, createdAt.
TTL index causes documents older than 365 days to be evicted (verified by setting createdAt to past).
```

### INT-31: Activity Tab Pagination (FR-31)

**Boundary**: GET /audit-events endpoint → Studio Activity tab data source

```
1. Seed 75 events for profile PJ via direct emitter calls
2. GET /api/projects/P1/auth-profiles/{PJ.id}/audit-events
   -> Response: { events: [50 most recent], nextCursor: <cursor> }
3. GET ?cursor=<cursor>&limit=50
   -> Response: { events: [25 remaining], nextCursor: null }
4. GET ?eventType=tokens_revoked
   -> Filtered list across full set
5. Cross-tenant T2 query returns [] (tenantIsolationPlugin)
6. Cross-project P2 query returns [] (explicit projectId in filter)
```

---

## ABLP-913 Migration Tests (NEW)

> Migration scripts MUST live under `packages/database/src/migrations/scripts/` per the existing migration framework (registry, runner, lock, checksum, idempotency). Each script gets a dedicated test suite under `packages/database/src/__tests__/migrations/` (NEW directory; sibling to the existing `packages/database/src/__tests__/migration-runner.test.ts` which validates the framework itself). The test suites use MongoMemoryServer to run the migration end-to-end against seed data.

### MIG-1: profileType Backfill (FR-9)

**Migration script**: `YYYYMMDD_NNN_auth_profile_profile_type.ts`

```
1. Pre-state: insert 5 auth_profiles directly without profileType field:
   - p1: connector="google" -> expected profileType="integration"
   - p2: connector="" -> expected profileType="custom"
   - p3: connector=null -> expected profileType="custom"
   - p4: connector="slack" -> expected profileType="integration"
   - p5: connector="custom-internal" -> expected profileType="integration" (any non-empty string)
2. Run migration; assert post-state matches expectations
3. Re-run migration: idempotent; no diffs; no error
4. Verify lock acquired (Redis SET NX) and released even on failure
5. Run rollback script: profileType field unset on all 5 rows; data otherwise unchanged
6. Migration runner test pattern: see packages/database/src/__tests__/migration-runner.test.ts
```

### MIG-2: EndUserOAuthToken projectId + profileId Backfill + Index Swap (FR-28)

**Migration script**: `YYYYMMDD_NNN_end_user_oauth_token_project_scope.ts`

```
1. Pre-state: existing rows without projectId/profileId; existing unique index
   {tenantId,userId,provider}
2. Three backfill cases:
   (a) Token has linked-app metadata pointing to a profile with projectId
       -> backfill projectId=profile.projectId, profileId=profile._id
   (b) Token's source profile is tenant-scoped (profile.projectId is null)
       -> leave projectId null; set profileId from linked-app where deterministic
       -> log non-blocking deprecation warning at next refresh
   (c) Token has no resolvable source profile (e.g., legacy oauth2_token records)
       -> leave both null; force re-auth at next use (matches existing fallback semantics)
3. Index migration:
   - DROP unique {tenantId,userId,provider}
   - CREATE unique {tenantId,projectId,userId,provider}
   - CREATE non-unique {tenantId,profileId,userId}
4. Idempotency: re-run produces no diff
5. Rollback: drop new indexes; recreate old unique index; clear projectId/profileId fields
6. Edge: post-migration insert with projectId=null on a tenant where the new unique index
   is enforced -> succeeds (null projectId allowed; treat as legacy bucket)
   (Verify with a partial unique index strategy if MongoDB requires it.)
```

---

---

## Coverage Matrix

Maps each functional requirement to test types with existing coverage assessment.

| FR   | Requirement                       | Unit                                                                     | Integration                                            | E2E / Browser                                 | Manual | Coverage |
| ---- | --------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------- | ------ | -------- |
| FR-1 | Encryption at rest (AES-256-GCM)  | model tests, encryption engine tests, cache / grace-period tests         | DB integration tests                                   | -                                             | -      | HIGH     |
| FR-2 | 17 auth types with Zod validation | schema tests, `apply-auth` dispatch tests, update validator tests        | -                                                      | -                                             | -      | HIGH     |
| FR-3 | Scope-aware resolution            | service tests, runtime resolver tests, resolve-by-name tests             | runtime route validation / connector setup integration | -                                             | -      | HIGH     |
| FR-4 | OAuth2 lifecycle                  | token refresh, client creds, linked-app resolver, durable grant tests    | route validation + callback / connector setup coverage | OAuth flow + token refresh integration suites | -      | HIGH     |
| FR-5 | Secret redaction                  | dedicated redaction tests in shared package                              | -                                                      | -                                             | -      | HIGH     |
| FR-6 | Dual-read migration               | dedicated dual-read + consumer-dual-read tests                           | connector/runtime integration coverage                 | connector setup integration                   | -      | HIGH     |
| FR-7 | 404 isolation                     | Studio API tests, workspace list / consumers / validate route tests      | runtime route validation                               | -                                             | -      | HIGH     |
| FR-8 | Health/alerting                   | health, alerting, credential age, rotation scheduler, cache invalidation | -                                                      | -                                             | -      | HIGH     |

---

## Current Verified Inventory (2026-05-13)

| Package / Area                 | Verified Files | Representative Coverage                                                                                                                    |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/database`            | 14             | schema/indexes, CRUD integration, migrations, factory, audit events                                                                        |
| `packages/shared`              | 35             | auth schemas, service resolve logic, `apply-auth`, `dual-read`, redaction, cache, lock, auth state helpers                                 |
| `packages/shared-auth-profile` | 7              | extracted legacy helpers, linked-app validation, canonical token refresh parity                                                            |
| `apps/runtime`                 | 82             | runtime router validation, by-name lookup, grace-period fallback, health/alerting, durable OAuth grants, session scan, force invalidation  |
| `apps/studio`                  | 52             | project/workspace/admin API routes, bulk actions, OAuth initiate/callback/finalizer, integrations route, consumer discovery, slide-over UI |
| `packages/project-io`          | 1              | import/export profile mapping and fuzzy resolution                                                                                         |

Representative modern suites:

- `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts`
- `packages/shared/src/__tests__/auth-profile/dual-read.test.ts`
- `packages/shared/src/__tests__/auth-profile/secret-redaction.test.ts`
- `packages/shared-auth-profile/src/__tests__/legacy-auth-profile.test.ts`
- `apps/runtime/src/__tests__/auth/auth-profile-resolve-by-name.test.ts`
- `apps/runtime/src/__tests__/auth/auth-profile-resolver-grace-period.test.ts`
- `apps/runtime/src/__tests__/auth/oauth-grant-service.test.ts`
- `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts`
- `apps/studio/src/__tests__/auth-profile-oauth-initiate-route.test.ts`
- `apps/studio/src/__tests__/auth-profile-oauth-callback-route.test.ts`
- `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-security.test.ts`

---

## Resolved Path Drift

The March 2026 docs were stale because several suites moved or landed after the original inventory:

- Runtime auth-profile tests now primarily live under `apps/runtime/src/__tests__/auth/**` plus `apps/runtime/src/__tests__/integration/**`, not the older root-level paths.
- Studio auth-profile route coverage now spans both `apps/studio/src/__tests__/api-routes/auth-profiles/**` and route-specific suites at `apps/studio/src/__tests__/auth-profile-*.test.ts`.
- Shared auth-profile coverage is split across `packages/shared/src/__tests__/auth-profile/**` and `packages/shared-auth-profile/src/__tests__/**`; both need to be counted during audits.

Examples of stale-path fixes:

| Prior doc expectation                                                   | Current verified path                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/auth-profile-resolve-by-name.test.ts`       | `apps/runtime/src/__tests__/auth/auth-profile-resolve-by-name.test.ts`        |
| `apps/runtime/src/__tests__/auth-profile-resolver-grace-period.test.ts` | `apps/runtime/src/__tests__/auth/auth-profile-resolver-grace-period.test.ts`  |
| `apps/studio/src/__tests__/api-auth-profile-bulk.test.ts`               | `apps/studio/src/__tests__/api-routes/api-auth-profile-bulk.test.ts`          |
| `apps/studio/src/__tests__/auth-profiles/auth-profile-api.test.ts`      | `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-api.test.ts` |

---

## E2E Test Scenarios (Minimum 5)

All E2E tests must exercise the real system through HTTP API. No mocks, no direct DB access, real Express servers.

### E2E-1: Auth Profile CRUD Lifecycle

**Purpose**: Verify create, read, update, delete through Studio API with real encryption and tenant isolation.

```
1. POST /api/projects/:projectId/auth-profiles  (api_key type)
   -> 201, profile created with encrypted secrets
2. GET /api/projects/:projectId/auth-profiles/:id
   -> 200, secrets redacted (no encryptedSecrets in response)
3. PUT /api/projects/:projectId/auth-profiles/:id (change name)
   -> 200, name updated
4. DELETE /api/projects/:projectId/auth-profiles/:id
   -> 200, profile deleted
5. GET /api/projects/:projectId/auth-profiles/:id
   -> 404, profile not found
```

**Isolation checks**: Cross-tenant GET returns 404. Cross-project GET returns 404.

### E2E-2: OAuth2 Authorization Flow

**Purpose**: Verify full OAuth2 flow from initiate through callback and token storage.

```
1. POST /api/projects/:projectId/auth-profiles (oauth2_app with authorizationUrl, tokenUrl)
   -> 201, app profile created
2. POST /api/projects/:projectId/auth-profiles/oauth/initiate
   -> 200, returns authUrl with PKCE state and code_verifier stored
3. POST /api/projects/:projectId/auth-profiles/oauth/callback
   (simulate callback with authorization code)
   -> 200, oauth2_token profile created and linked to app profile
4. GET /api/projects/:projectId/auth-profiles/:tokenProfileId
   -> 200, token profile with linkedAppProfileId set
5. DELETE /api/projects/:projectId/auth-profiles/:appProfileId
   -> 409, blocked because token profile references it
```

### E2E-3: Dual-Read Migration Path

**Purpose**: Verify that connectors resolve credentials via auth profile when `authProfileId` is present, and via legacy when it is absent.

```
1. Create connector config with legacy embedded credentials (no authProfileId)
2. Create auth profile for the same connector
3. Connector uses legacy credentials
4. Update connector config to set authProfileId
5. Connector resolves credentials from auth profile
6. Revoke auth profile (status: 'revoked')
   -> Credential resolution fails (no silent fallback to legacy)
```

### E2E-4: Token Refresh with Distributed Locking

**Purpose**: Verify expired tokens trigger refresh and distributed locks prevent concurrent refresh.

```
1. Create oauth2_app profile and oauth2_token profile with short TTL
2. Wait for token to approach expiry (within 5-min buffer)
3. Trigger credential resolution from two concurrent requests
   -> Only one acquires refresh lock
   -> Both get refreshed token
4. Verify token updated in DB with new expiry
5. Verify refresh trace events emitted
```

### E2E-5: Personal Profile Isolation

**Purpose**: Verify that personal profiles are only visible to their owner.

```
1. User A creates personal profile (visibility: 'personal')
2. User A can read, update, and list the profile
3. User B cannot read the profile (404)
4. User B cannot see it in list results
5. User B cannot update it (404)
6. User B cannot delete it (404)
7. Admin/workspace list does not expose personal profiles across users
```

### E2E-6: Key Rotation and Grace Period

**Purpose**: Verify key rotation re-encrypts profiles and grace period prevents outage.

```
1. Create profile with key version 1
2. Trigger rotation job with new master key (version 2)
3. Profile re-encrypted with version 2
4. previousEncryptedSecrets populated with version 1 data
5. Within grace period: both version 1 and version 2 decryption work
6. After grace period: only version 2 decryption works
```

### E2E-7: Scope-Aware Resolution Precedence

**Purpose**: Verify the 5-level resolution cascade.

```
1. Create tenant-level profile (scope: tenant, name: 'provider-key')
2. Create project-level profile (scope: project, name: 'provider-key')
3. Create personal profile (scope: project, visibility: personal, name: 'provider-key')
4. Resolution for User A (personal owner):
   -> Returns personal profile (highest priority)
5. Resolution for User B (not personal owner):
   -> Returns project-level shared profile
6. Delete project-level profile
7. Resolution for User B:
   -> Falls back to tenant-level profile
```

---

## Integration Test Scenarios (Minimum 5)

Integration tests exercise real service boundaries without mocking codebase components. Only external services may be mocked via dependency injection.

### INT-1: Encryption Plugin Round-Trip

**Purpose**: Verify the encryptionPlugin correctly encrypts on save and decrypts on read with real EncryptionService.

```
1. Initialize EncryptionService with test master key
2. Create AuthProfile document through Mongoose model
3. Verify raw MongoDB document has encrypted encryptedSecrets (not plaintext)
4. Read document back through model
5. Verify decrypted secrets match original input
6. Verify previousEncryptedSecrets also encrypted/decrypted correctly
```

### INT-2: Tenant Isolation Plugin Enforcement

**Purpose**: Verify tenantIsolationPlugin prevents cross-tenant access at the database layer.

```
1. Create profile for tenant-A
2. Query with tenant-B context
   -> Returns empty (not found)
3. Update with tenant-B context
   -> Returns null (no match)
4. Delete with tenant-B context
   -> Returns null (no match)
5. Create profile for tenant-B
6. List with tenant-A context
   -> Only returns tenant-A profiles
```

### INT-3: AuthProfileService.resolve() Multi-Level Cascade

**Purpose**: Verify the full resolution cascade with real service layer (mocked DB, real business logic).

```
1. Set up profiles at all 5 levels
2. Verify resolution order: personal > shared > project+env > project > tenant
3. Verify each level falls through correctly when higher levels absent
4. Verify expired profiles are skipped
5. Verify revoked profiles are skipped
6. Verify trace events emitted at each resolution step
```

### INT-4: Token Refresh Service with Redis Lock

**Purpose**: Verify token refresh acquires lock, calls token endpoint, and updates DB.

```
1. Create expired oauth2_token profile with valid linked oauth2_app
2. Set up mock token endpoint (returns fresh token)
3. Call refreshOAuth2Token() with real Redis lock
4. Verify lock acquired (Redis SET NX PX)
5. Verify token endpoint called with correct parameters
6. Verify profile updated with new token and expiry
7. Verify lock released
8. Second concurrent call gets lock contention (skips refresh)
```

### INT-5: Import/Export Auth Profile Resolution

**Purpose**: Verify project import correctly resolves auth profile references.

```
1. Export project with 3 auth profiles (api_key, bearer, oauth2_app)
2. Delete original profiles
3. Create target profiles with same names
4. Import project
5. Verify authProfileId references rewritten to target profile IDs
6. Verify exact name match (case-insensitive) auto-resolves
7. Verify fuzzy match (different name, same authType+connector) is suggested but not auto-applied
```

### INT-6: Consumer Discovery and Delete Guard

**Purpose**: Verify consumer count/list and delete blocking when consumers exist.

```
1. Create auth profile
2. Create connector config referencing authProfileId
3. Create model config referencing authProfileId
4. GET consumers endpoint -> returns both consumers
5. DELETE profile -> blocked (409) because consumers exist
6. Remove consumer references
7. DELETE profile -> succeeds
```

### INT-7: Client Credentials Grant with Redis Cache

**Purpose**: Verify client credentials token exchange and caching.

```
1. Create oauth2_client_credentials profile
2. Set up mock token endpoint
3. First call: exchanges credentials, caches token in Redis
4. Second call: returns cached token (no endpoint call)
5. Verify Redis key: auth-profile:cc-token:{tenantId}:{profileId}
6. Verify TTL = expires_in - 60s buffer
7. After TTL expiry: re-exchanges credentials
```

---

## Missing Test Coverage (Priority Ordered)

### High Priority

| Area                          | Why It Matters                                                                                                        | Suggested Approach                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Advanced addon / protocol E2E | Signing, proxy, webhook verification, mTLS, and phase-3 protocol paths still have shallower end-to-end coverage       | Add targeted integration/E2E around real outbound request decoration |
| Durable grant lifecycle       | Runtime OAuth grants now resolve via linked apps; revocation / migration sweeps still need deeper end-to-end coverage | Add connector OAuth + revoke / rotate scenarios                      |
| SearchAI consumer parity      | SearchAI resolver exists but is still lightly represented in this dedicated matrix                                    | Add focused resolver tests and a cross-package integration sweep     |

### Medium Priority

| Area                                                  | Why It Matters                                      | Suggested Approach                                               |
| ----------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `resolveWithGracePeriod()`                            | Key rotation safety remains load-bearing            | Add integration cases around multi-step rotation windows         |
| `applySigning()` / `verifyWebhook()` / `applyProxy()` | Addon mechanism correctness                         | Expand from unit coverage into route/integration coverage        |
| SearchAI resolver                                     | Credential resolution for model/embedding providers | Add dedicated package-level matrix entry                         |
| Addon combination matrix                              | Invalid combos should be rejected at create time    | Keep schema-focused unit coverage current with future auth types |

### Low Priority

| Area                          | Why It Matters                                                          | Suggested Approach                                                       |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `validateAuthProfileUpdate()` | Prevents authType mutation                                              | Keep parity between `packages/shared` and `packages/shared-auth-profile` |
| `validateLinkedAppProfile()`  | Cross-tenant link prevention                                            | Add browser or route-level UX coverage for linked-app failures           |
| Batch OAuth UI                | Consent-panel/browser flow is still lighter than backend route coverage | Add focused Studio component/browser coverage                            |

---

## Test Infrastructure

### Test Factory

File: `packages/database/src/__tests__/helpers/auth-profile-factory.ts`

Provides `createAuthProfileFixture()` for generating test auth profile documents. Supports all 17 auth types with sensible defaults. Allows override of any field.

### Mocking Patterns

- **Mongoose model**: Mock `findOne()`, `find()`, `create()`, `countDocuments()`, `findOneAndDelete()` methods
- **Redis**: Mock `set()`, `get()`, `del()` for lock and cache operations
- **fetch()**: Mock `globalThis.fetch` for OAuth2 token exchange endpoints
- **Encryption**: Unit tests work with plaintext JSON strings in `encryptedSecrets`; integration tests should use real EncryptionService

### Running Tests

```bash
# All auth profile tests across packages
pnpm test --filter=@agent-platform/database -- --grep "auth-profile"
pnpm test --filter=@agent-platform/shared -- --grep "auth-profile"
pnpm test --filter=@agent-platform/project-io -- --grep "auth-profile"
pnpm test --filter=runtime -- --grep "auth-profile"
pnpm test --filter=studio -- --grep "auth-profile"

# Specific test file
pnpm test --filter=@agent-platform/shared -- src/__tests__/auth-profile/auth-profile-service.test.ts

# E2E tests (requires running infrastructure)
pnpm test --filter=runtime -- src/__tests__/e2e/auth-profile-connector-setup.test.ts
pnpm test --filter=runtime -- src/__tests__/e2e/auth-profile-oauth-flow.test.ts
pnpm test --filter=runtime -- src/__tests__/e2e/auth-profile-token-refresh.test.ts
```

---

## Test Execution History

| Date       | Iteration                   | Tests Run                                  | Result               | Notes                                                                                                                                                                                                           |
| ---------- | --------------------------- | ------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-18 | Initial audit               | 0                                          | AUDIT ONLY           | Test files inventoried, execution status not verified                                                                                                                                                           |
| 2026-03-19 | Focused hardening run       | 12 files                                   | PASS                 | Runtime + Studio auth-profile suites (per prior test spec)                                                                                                                                                      |
| 2026-03-19 | Final audit follow-up       | 1 file                                     | PASS                 | Runtime delete guard regression test                                                                                                                                                                            |
| 2026-03-22 | File existence verification | 37 files checked                           | 24 exist, 13 missing | First doc correction pass; several paths were still stale                                                                                                                                                       |
| 2026-04-03 | Post-impl sync inventory    | 84 files checked                           | VERIFIED             | Route, runtime, shared, shared-auth-profile, Studio, and project-io counts refreshed                                                                                                                            |
| 2026-05-13 | Post-review hardening sync  | `pnpm build` + 6 focused suites / 77 tests | PASS                 | Build passed. Focused shared, Studio, and runtime auth-profile regressions passed. Full `pnpm test` blocked by known `@agent-platform/shared-auth` scope registry mismatch already present on `origin/develop`. |

---

## Immediate Follow-Up Priorities

| Priority | Area                  | Action                                                                  |
| -------- | --------------------- | ----------------------------------------------------------------------- |
| P1       | Advanced addon E2E    | Add request-signing / proxy / webhook-verification integration coverage |
| P1       | Durable grant flows   | Expand connector OAuth revoke / rotate / migration sweeps               |
| P2       | SearchAI parity       | Add dedicated auth-profile resolver coverage in SearchAI                |
| P2       | Batch consent UI      | Add Studio component/browser coverage around batch OAuth panels         |
| P3       | SecurityAI regression | Add semgrep run to pre-merge pipeline                                   |
