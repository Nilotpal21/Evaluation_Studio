# Test Specification: Session Scope Enforcement

**Feature Spec**: `docs/features/sub-features/session-scope-enforcement.md`
**Parent Feature**: [Memory & Sessions](../../features/memory-sessions.md)
**HLD**: `docs/specs/session-scope-enforcement.hld.md`
**LLD**: [docs/plans/session-scope-enforcement.lld.md](../../plans/session-scope-enforcement.lld.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-23

---

## 1. Feature Metadata

- **Package(s)**: `apps/runtime`, `packages/database`, `packages/shared-auth`, `packages/shared-encryption`, `packages/eventstore`, `packages/agent-transfer`, `apps/search-ai`, `packages/web-sdk`, `apps/studio`
- **Feature Area**: session identity, isolation, contact anchoring, auth-profile actor semantics, model-resolution contract preservation, memory ownership semantics, queue durability, hot/cold restore, migration safety, client-contract hardening, analytics/query semantics, retention/GDPR, encryption/DEK alignment, Studio read-model parity
- **Risk Level**: Critical (touches production session create, resume, restore, message persistence, and migration behavior)

---

## 2. Current State

The codebase still has major gaps for the full cross-package rollout, but the runtime core is no longer starting from zero. The branch now has real adversarial coverage for several of the highest-risk seams:

- converted runtime boundaries now have fail-closed tests for HTTP chat, LiveKit token issuance, and Twilio media bootstrap
- `ExecutionScope` / `SessionLocator` conversion is covered through runtime scope-factory, session-locator, tiered-store, Redis lookup, and suspension-resumption tests
- human canonical-contact resolution has targeted unit coverage, including the `channelArtifact` precedence fix for anonymous SDK callers
- follow-up `sessionMetadata` validation is now covered as a real `413 PAYLOAD_TOO_LARGE` failure in runtime executor, HTTP chat, and channel session-resolver tests

The remaining program-wide gaps are still substantial:

- `apps/runtime/src/__tests__/tiered-session-store.test.ts` covers hot/cold behavior, but the tests currently normalize use of `loadInternal()` / `getVersionInternal()` / `deleteInternal()` instead of challenging that design with cross-tenant negatives.
- `apps/runtime/src/__tests__/message-persistence-queue-full.test.ts` covers queue buffering and direct-write fallback, but the current contract still allows enqueue without tenant/project scope in several tests.
- WebSocket and SDK tests cover session create/resume and ownership paths, but they do not yet force missing-scope and incomplete-resume failures as first-class regressions.
- Identity/contact flows already have good building blocks, but there is not yet an end-to-end assertion that every human production session resolves to `contactId` before creation, including guest and voice scenarios.
- The hot Redis store currently has behavior around reverse tenant lookup expiry that should be tested as an isolation failure, not just a cache miss.
- Reporting/admin trace surfaces still depend on legacy identity fields or incomplete trace dimensions, and tests do not yet verify canonical `subject` / `actor` semantics in those read models.
- Shared ownership and SDK session-list coverage still assumes legacy `customerId` / `channelArtifact` / `anonymousId` priority logic rather than canonical subject/actor semantics.
- Studio retention/GDPR coverage still reflects heuristic subject discovery across `contactId`, `customerId`, `anonymousId`, and `callerNumber`.
- Agent-transfer coverage already leans toward `contactId`, but it does not yet assert that provider-side synthetic user IDs remain non-authoritative transport aliases.
- Studio session, trace, debug-chat, and proxy tests do not yet verify additive canonical scope summaries, migration status, or debug-only caller-data semantics.
- Eventstore/audit coverage still focuses on `actor_id` anonymization and does not yet verify privacy-safe canonical session-principal/subject/actor summaries.
- Auth-profile coverage verifies some propagation and connector flows, but it does not yet assert that credential ownership follows canonical actor/session-principal semantics rather than overloaded session `userId` or human subject identity.
- Model-resolution coverage already protects the current cache-key contract, but the session-scope rollout does not yet assert that canonical human subject identity stays out of model-resolution cache scope and reasoning-settings resolution.
- Memory coverage still assumes persistent-memory ownership is `(tenantId, userId, projectId)` and does not yet distinguish contact-backed human continuity from actor-owned/debug memory or service-principal state.
- The underlying KMS/DEK stack already has solid primitive coverage for project/environment scope, but the session-scope implications are not tested end to end.
- Mongo durable session payloads (`session_states`, `messages`) already encrypt with project-scoped settings, while Redis session storage, queue payloads, transfer-session metadata, and ClickHouse/session-event encryption still rely on tenant-scoped convenience wrappers in practice.
- Contact identity encryption and crypto-shredding are intentionally tenant-scoped today, but the repository does not yet have tests that assert this is an explicit exception rather than an accidental mismatch.

This test spec exists to move those risks into explicit red tests before implementation starts.

---

## 3. Coverage Matrix

| FR    | Description                                                                                                                         | Unit | Integration | E2E | Manual | Status      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ----------- |
| FR-1  | Production session create requires validated `ExecutionScope` at every boundary                                                     | ✅   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-2  | Every production session is project-scoped                                                                                          | ❌   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-3  | Runtime uses explicit `sessionPrincipalId`, `subject`, `actor`, and `identityEvidence`; human sessions always anchor to `contactId` | ✅   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-4  | Production session operations stop using bare `sessionId` locators                                                                  | ✅   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-5  | Redis reverse lookup expiry fails closed and no empty-tenant namespace remains                                                      | ✅   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-6  | Cold-store restore/version/delete/touch require scoped access on production paths                                                   | ✅   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-7  | Queue enqueue requires full scope and durable actor/subject/evidence provenance at enqueue time                                     | ✅   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-8  | ALS mirrors validated scope and no longer acts as the primary scope source                                                          | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-9  | Debug and system flows use discriminated scope types by end of rollout                                                              | ✅   | ❌          | ❌  | ❌     | IN PROGRESS |
| FR-10 | Legacy session/cold-store/message artifacts migrate safely                                                                          | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-11 | Adversarial regressions are captured before enforcement is enabled                                                                  | ✅   | ✅          | ❌  | ❌     | IN PROGRESS |
| FR-12 | Rollout emits scope/migration observability counters, logs, and analytics-friendly dimensions                                       | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-13 | Retention, GDPR, archive, and erasure flows resolve subjects through canonical/migration-aware semantics                            | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-14 | Session ownership and session-list filters move from legacy identity tiers to canonical subject/actor checks                        | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-15 | Contact promotion, merge, back-link, and deletion flows preserve canonical human-subject semantics                                  | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-16 | Agent transfer/handoff keeps canonical `contactId` authoritative and provider aliases non-authoritative                             | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-17 | Audit/event/export/archive surfaces preserve privacy-safe canonical scope summaries                                                 | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-18 | Studio proxies, session/traces/debug surfaces, transfer views, and retention tooling stay aligned                                   | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-19 | Project-scoped session artifacts use project/environment-scoped DEKs rather than tenant-wide shortcuts                              | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-20 | Tenant-scoped contact identity crypto remains an explicit exception                                                                 | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-21 | Legacy encrypted artifacts are re-encrypted/quarantined with KMS audit telemetry                                                    | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-22 | Auth-profile resolution follows canonical actor/auth-scope semantics rather than overloaded `userId`                                | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-23 | Model resolution preserves actor-scoped full resolve and subject-agnostic reasoning settings                                        | ❌   | ❌          | ❌  | ❌     | PLANNED     |
| FR-24 | Memory separates contact-backed human continuity from actor-owned/project/session memory                                            | ✅   | ❌          | ❌  | ❌     | IN PROGRESS |

Legend: ✅ = Covered, ❌ = Not covered

---

## 4. E2E Test Scenarios

> E2E tests must use the real HTTP/WebSocket surfaces. No mocking of codebase components, no direct DB assertions, and no bypassing auth or middleware.

### E2E-1: Production HTTP Session Create Rejects Missing Project Scope

- **Covers**: FR-1, FR-2, FR-11
- **Preconditions**: Runtime server, Redis, MongoDB, and auth middleware are running.
- **Steps**:
  1. Call a real project-scoped HTTP session-create or chat bootstrap route with valid tenant auth but missing or malformed production scope inputs.
  2. Retry with a mismatched `projectId` relative to the route path or auth context.
  3. Query the allowed session-inspection API surface to confirm no production session was created.
- **Expected Result**: The request fails closed and no runtime or durable session is created.
- **Response Contract**: Expect `400` with the stable invalid-scope error envelope planned by the feature spec, not an implicit fallback or empty success shape.
- **Auth Context**: Valid tenant auth; invalid or missing project scope.
- **Isolation Check**: Cross-project misuse must return the same non-leaky behavior used elsewhere for isolation.

### E2E-2: Guest Human Session Resolves to an Anonymous Contact Before Production Session Creation

- **Covers**: FR-1, FR-3, FR-8, FR-11
- **Preconditions**: Real HTTP or SDK bootstrap path that supports unauthenticated guest usage.
- **Steps**:
  1. Start a real guest session with tier-0 identity evidence and no authenticated platform user.
  2. Complete the normal session bootstrap through the public surface.
  3. Read session metadata through an allowed diagnostics/admin API or response payload designed for testing.
- **Expected Result**: The session is created successfully with a canonical human subject anchored to `contactId` and a runtime-generated `sessionPrincipalId`; the session does not rely on absent `userId` or a bespoke guest-only subject type.
- **Auth Context**: Tenant + project context with guest/anonymous human caller.
- **Isolation Check**: A guest session in one project cannot be resumed or inspected from a different project.

### E2E-3: Customer-Known Voice Caller Resolves or Creates a Contact Before Persistence

- **Covers**: FR-1, FR-3, FR-7, FR-11
- **Preconditions**: Real Twilio/voice entry harness or equivalent testable voice HTTP+WebSocket bootstrap surface.
- **Steps**:
  1. Initiate a voice session with caller identity evidence such as phone or external customer identifier that is known to the channel but not yet known to the platform.
  2. Send enough audio/events to trigger runtime session bootstrap and durable session creation.
  3. Inspect the resulting session through an allowed admin/diagnostics surface.
- **Expected Result**: The persisted production session carries a `contactId` subject before steady-state persistence continues; identity strength is recorded as evidence rather than as the authoritative subject.
- **Auth Context**: Project-scoped voice boundary with channel/provider verification as applicable.
- **Isolation Check**: A caller identifier from tenant A cannot resolve or resume a session in tenant B.

### E2E-4: SDK / WebSocket Session Create and Resume Enforce Scoped Ownership and Canonical Subject Semantics

- **Covers**: FR-1, FR-2, FR-3, FR-8, FR-11, FR-14
- **Preconditions**: Real SDK init + `/ws/sdk` bootstrap path with project-scoped token issuance.
- **Steps**:
  1. Start a real SDK session with valid tenant/project scope.
  2. Resume the session successfully using the same tenant/project context.
  3. Retry resume with mismatched tenant or project scope.
  4. Retry resume with a principal that does not own the session.
- **Expected Result**: Same-scope resume succeeds; cross-scope or wrong-owner resume fails closed without leaking whether the session exists.
- **Response Contract**: Cross-scope or wrong-owner resume attempts should return the same non-leaky `404` behavior used elsewhere for isolation, not `403`.
- **Additional Assertion**: Authoritative human identity comes from verified bootstrap / trusted evidence and canonical contact linkage, not from raw SDK `userContext.userId`.
- **Auth Context**: Project-scoped SDK token or equivalent runtime auth context.
- **Isolation Check**: Cross-tenant, cross-project, and wrong-owner resume attempts return not-found style behavior.

### E2E-5: Mid-Session Verification Strengthens Evidence Without Changing the Human Subject Model

- **Covers**: FR-3, FR-7, FR-8, FR-11
- **Preconditions**: Real verification flow is available for at least one method such as OTP, HMAC, email link, or OAuth.
- **Steps**:
  1. Start a real guest or low-confidence human session.
  2. Complete the verification flow through the public API.
  3. Continue the same session and inspect its metadata through an allowed diagnostics surface.
- **Expected Result**: Verification raises identity strength and may enrich or merge contact linkage, but the session remains a human `contact` subject rather than switching to a different subject type.
- **Auth Context**: Tenant + project scope with the same session principal used across verification.
- **Isolation Check**: Verification artifacts issued in one tenant/project cannot promote a session in another.

### E2E-6: Legacy Migrated Session Resumes, Invalid Legacy Session Fails Closed

- **Covers**: FR-10, FR-11, FR-12
- **Preconditions**: Migration harness can seed one migratable legacy record and one intentionally invalid record.
- **Steps**:
  1. Seed one legacy session that can be backfilled safely and one that cannot.
  2. Resume the migrated session through the real runtime entry surface and assert success.
  3. Attempt to resume the invalid session and assert fail-closed behavior.
  4. Inspect rollout counters or logs through the supported observability surface.
- **Expected Result**: Backfillable records resume; unsafe records are quarantined or expired and cannot be resumed.
- **Auth Context**: Same tenant/project used by the migrated record.
- **Isolation Check**: Invalid legacy rows do not fall back to a permissive global or empty-scope behavior.

### E2E-7: Studio Session Proxy, Detail, and Trace Routes Surface Canonical Scope Metadata Without Legacy Identity Leakage

- **Covers**: FR-12, FR-17, FR-18
- **Preconditions**: Studio app server and runtime server are both running with project-scoped auth.
- **Steps**:
  1. Create or resume a real production session through runtime.
  2. Fetch the session list, session detail, and session traces through Studio proxy routes.
  3. Repeat for one migrated compatibility-path session if the harness supports it.
- **Expected Result**: Studio proxies remain project-scoped, fail closed on bad scope, and return additive canonical scope/migration metadata without surfacing raw legacy identity fields as the primary model.
- **Auth Context**: Valid Studio tenant auth plus project scope.
- **Isolation Check**: Cross-project access through Studio proxy routes returns the same non-leaky failure shape as runtime.

### E2E-8: Studio Debug / Preview Caller Data Never Becomes Authoritative Production Identity

- **Covers**: FR-9, FR-18
- **Preconditions**: Studio debug chat or preview share flow is available in a staging/E2E harness.
- **Steps**:
  1. Launch a debug/preview session with callerData or custom attributes that resemble customer identity.
  2. Exercise the session enough to create traces/messages and inspect the resulting debug payloads through the supported surface.
  3. Verify that no production session access, reporting, or ownership path treats those debug fields as canonical production identity.
- **Expected Result**: Debug/preview sessions stay on debug-only scope semantics; callerData remains contextual metadata and never upgrades into authoritative production `subject`.
- **Auth Context**: Authenticated Studio operator or signed preview token as applicable.
- **Isolation Check**: Debug callerData cannot be used to resume or inspect unrelated production sessions.

### E2E-9: Contact-Backed Human Memory Persists Across Customer Sessions Without Leaking Into Debug or Actor-Owned Memory

- **Covers**: FR-3, FR-18, FR-24
- **Preconditions**: Real runtime surface with an agent that exercises persistent memory or contact-backed context across sessions.
- **Steps**:
  1. Start a real human production session and trigger memory/contact-context writes through normal runtime behavior.
  2. Start a second real human session for the same canonical contact in the same tenant/project and verify the remembered context is available.
  3. Start a Studio debug or other actor-owned session in the same project and verify that customer/contact memory is not implicitly reused as actor/debug memory.
- **Expected Result**: Human continuity follows canonical contact-backed semantics; actor/debug memory stays isolated and does not inherit customer memory by accident.
- **Auth Context**: Real project-scoped runtime auth for the human session plus authenticated Studio/debug context for the comparison flow.
- **Isolation Check**: A different contact or debug actor cannot read the remembered human context through fallback `userId` semantics.

### E2E-10: Debug and System Discriminants Cannot Be Coerced Into Production Scope

- **Covers**: FR-9, FR-11, FR-18
- **Preconditions**: Real runtime and any debug/system entry surfaces are available in the harness.
- **Steps**:
  1. Attempt to send a debug-shaped payload through a production-only session-create or resume boundary.
  2. Attempt to replay a system/job payload through a production boundary.
  3. Attempt the inverse where a production payload is routed through a debug-only or system-only path.
- **Expected Result**: Each path rejects the wrong scope kind fail-closed rather than coercing it into a best-effort production/debug/system session.
- **Response Contract**: Expect a stable `400` contract error such as `UNSUPPORTED_SCOPE_KIND` for wrong-boundary scope-kind mismatches.
- **Auth Context**: Valid auth for each caller class; failure should come from scope-kind mismatch, not missing auth.
- **Isolation Check**: No production durable state is created when discriminants are wrong.

### E2E-11: Rollout Mode Can Safely Roll Back From `enforce` to `warn`

- **Covers**: FR-10, FR-11, FR-12
- **Preconditions**: Runtime can be started or reconfigured in `enforce` and `warn` modes with observability surfaces enabled.
- **Steps**:
  1. In `enforce` mode, send one request or payload that should fail under strict scope enforcement.
  2. Change rollout mode to `warn` without changing the payload.
  3. Re-run the same request and inspect observability surfaces.
- **Expected Result**: `enforce` blocks the request; `warn` allows controlled compatibility behavior while emitting explicit warnings/counters; rollback does not require code changes or hidden data repair.
- **Auth Context**: Same tenant/project/actor context across both runs.
- **Isolation Check**: Rollback to `warn` must not widen access beyond the documented compatibility path.

---

## 5. Integration Test Scenarios

### INT-1: Redis Reverse Lookup Expiry Is an Isolation Failure, Not a Namespace Fallback

- **Boundary**: Runtime session store -> Redis
- **Setup**: Seed a valid production session, then expire or remove `sess-tid:{sessionId}`.
- **Steps**: Attempt load, save, touch, and delete operations through the production store interface.
- **Expected Result**: All operations fail closed; no `sess::...` or equivalent empty-tenant key is read or written.
- **Failure Mode**: Missing reverse lookup must surface as an explicit validation/isolation failure.

### INT-2: Cold Restore Cannot Bypass Tenant and Project Scope

- **Boundary**: Tiered session store -> cold Mongo store
- **Setup**: Seed a cold-store record for tenant/project A and create a hot-store miss.
- **Steps**: Attempt restore/version/delete/touch using matching scope and then mismatched tenant/project scope.
- **Expected Result**: Matching scope succeeds; mismatched scope returns no session and performs no mutation.
- **Failure Mode**: Unscoped internal helper paths are not used on the production path.

### INT-3: Queue Enqueue Requires Full Scope Up Front

- **Boundary**: Runtime message pipeline -> BullMQ enqueue contract
- **Setup**: Build valid and invalid enqueue payloads that differ only in missing project, subject, actor, or evidence fields.
- **Steps**: Call `persistMessage()` and `persistTurnMetrics()` through the public producer contract.
- **Expected Result**: Invalid payloads are rejected synchronously at enqueue time; valid payloads preserve the original actor/subject/evidence envelope end to end.
- **Failure Mode**: No steady-state late repair of tenant/project fields or synthetic worker identity.

### INT-4: ALS Mirrors Explicit Scope Only

- **Boundary**: Boundary scope builder -> ALS -> repository/store layer
- **Setup**: Build a validated scope at the boundary and mirror it into ALS.
- **Steps**: Execute downstream store/message operations, then rerun with missing or mismatched ALS compared to the explicit scope.
- **Expected Result**: Downstream code consumes mirrored ALS values when present, but the explicit boundary scope remains authoritative and mismatches fail.
- **Failure Mode**: Deep layers must not invent tenant/project/subject values from missing ALS.

### INT-5: Session Fork / Copy Preserves Contact Subject and Actor Semantics

- **Boundary**: Session service -> clone/fork helper -> durable store
- **Setup**: Seed one human contact-backed session and one service-principal-backed session.
- **Steps**: Fork or clone each session through the supported service boundary.
- **Expected Result**: Human sessions preserve `subject.kind = 'contact'`; non-human sessions preserve `service_principal`; actor provenance remains distinct in both cases.
- **Failure Mode**: No overloaded `userId` or `customerId` copy semantics survive in the new contract.

### INT-6: Migration Classifier Backfills Human Contact Subjects and Quarantines Unsafe Rows

- **Boundary**: Migration job -> durable session/message stores
- **Setup**: Seed records that are fully derivable, partially derivable, and ambiguous.
- **Steps**: Run the migration classifier against the fixture set.
- **Expected Result**: Human sessions with derivable contact linkage are backfilled deterministically; ambiguous records are quarantined or expired.
- **Failure Mode**: Migration must not invent human subject identity when evidence is insufficient.

### INT-7: Service Principal Sessions Cannot Masquerade as Human Contact Sessions

- **Boundary**: Scope builder -> session service -> authorization/service layers
- **Setup**: Build one workflow/agent/integration session and one human contact-backed session with overlapping trace/session metadata.
- **Steps**: Attempt human-only operations with the service-principal subject and human resume/access patterns with the non-human subject.
- **Expected Result**: Human-only paths reject service-principal subjects unless explicitly elevated by policy.
- **Failure Mode**: Non-human sessions must not acquire human access semantics through missing or partial fields.

### INT-8: Retention / GDPR Subject Resolution Uses Canonical Subject Mapping Plus Explicit Compatibility Telemetry

- **Boundary**: Retention service -> GDPR store -> sessions/messages/attachments/eventstore
- **Setup**: Seed canonical contact-backed rows, canonical service-principal rows, and legacy rows discoverable only through compatibility fields.
- **Steps**: Execute subject lookup, erasure planning, and anonymization against each fixture set.
- **Expected Result**: Canonical rows resolve via canonical mapping first; legacy compatibility paths are explicitly counted/logged and never widen tenant/project scope.
- **Failure Mode**: No silent reliance on heuristic field scans once canonical subject is available.

### INT-9: Session Ownership and Session-List Filters Use Canonical Subject / Actor Semantics

- **Boundary**: Shared-auth middleware -> runtime session query/authz surfaces
- **Setup**: Seed human contact-backed sessions, service-principal sessions, and legacy sessions with tiered identity fields.
- **Steps**: Exercise ownership checks and list-filter builders for matching and mismatched callers across SDK/user/api-key contexts.
- **Expected Result**: Canonical subject/actor checks decide access; legacy fields are used only through an explicit compatibility path during migration.
- **Failure Mode**: `customerId`, `channelArtifact`, or `anonymousId` priority logic must not remain the hidden default.

### INT-10: Contact Promotion, Merge, and Delete Flows Preserve Canonical Subject Semantics

- **Boundary**: Promote/link orchestration -> contact lifecycle -> message/back-link cleanup
- **Setup**: Seed low-confidence human sessions, verified follow-up evidence, merge candidates, and a deletable contact.
- **Steps**: Promote evidence, merge/back-link as applicable, then run delete/anonymize flows.
- **Expected Result**: The same human subject remains canonical through promotion/merge, and delete flows scrub or cascade consistently across dependent artifacts.
- **Failure Mode**: Stronger evidence must not create a second subject model for the same human or leave linked artifacts behind.

### INT-11: Agent Transfer Preserves Canonical Contact Subject While Provider Aliases Stay Transport-Only

- **Boundary**: Transfer adapter -> transfer session store -> Studio/operator read model
- **Setup**: Initiate a transfer through a provider adapter that can synthesize a provider-side user ID.
- **Steps**: Create the transfer session, inspect stored provider metadata, and read the session back through operator-facing APIs.
- **Expected Result**: Canonical human identity remains the original `contactId`; synthetic/provider user IDs remain in provider metadata only.
- **Failure Mode**: Downstream tooling must not present provider aliases as the authoritative subject.

### INT-12: Eventstore / Audit Summaries Preserve Privacy-Safe Canonical Scope Semantics

- **Boundary**: Trace emitter / audit logger -> eventstore / ClickHouse -> replay or summary query
- **Setup**: Emit events for human contact, platform-user actor, and service-principal actor/session combinations.
- **Steps**: Query stored events, summaries, anonymization utilities, and replay adapters.
- **Expected Result**: Subject/actor semantics remain queryable and privacy-safe; anonymization can target the appropriate semantics without relying only on raw `actor_id`.
- **Failure Mode**: Historical replay and summaries must not collapse back to actor-only identity.

### INT-13: Studio Read Models and Proxies Stay Consistent With Canonical Runtime Scope

- **Boundary**: Runtime session/trace APIs -> Studio proxy routes -> Studio hooks/read models
- **Setup**: Seed canonical sessions, migrated sessions, and debug sessions.
- **Steps**: Fetch through Studio proxies and hydrate session detail, traces, and transfer/insights hooks.
- **Expected Result**: Studio remains identity-light by default but can surface additive canonical scope summary and migration flags without inventing identity locally.
- **Failure Mode**: Studio read models must not disagree with runtime about canonical subject, actor, or debug-vs-production classification.

### INT-14: Session-Adjacent Encrypted Payloads Use Project-Scoped DEKs While Contact Identity Crypto Stays Tenant-Scoped

- **Boundary**: Session bootstrap / queue / transfer / ClickHouse write paths -> shared encryption / KMS resolver
- **Setup**: Seed one canonical project-scoped production session, one transfer session tied to that project, and one tenant-scoped contact identity fixture.
- **Steps**: Persist session state, enqueue message payloads, write transfer metadata, and emit an encrypted ClickHouse/event row; separately resolve/create and erase a contact.
- **Expected Result**: Session-adjacent artifacts resolve project/environment DEKs for the production project, while contact encrypted identities, blind indexes, and salt lifecycle remain tenant-scoped.
- **Failure Mode**: No project-scoped production artifact silently downgrades to tenant-wide DEK scope, and no contact identity path is accidentally split by project.

### INT-15: Legacy Tenant-Scoped Session Ciphertext Is Re-Encrypted, Quarantined, or Explicitly Compatibility-Tracked

- **Boundary**: Migration job / compatibility decrypt path -> KMS audit -> durable stores
- **Setup**: Seed legacy project-scoped session artifacts encrypted under tenant sentinels plus canonical project-scoped artifacts encrypted correctly.
- **Steps**: Run migration or compatibility processing, then inspect resulting records and KMS audit signals.
- **Expected Result**: Legacy tenant-scoped ciphertext is either re-encrypted under the correct project/environment DEK, quarantined/expired, or served only through an explicit compatibility path with telemetry.
- **Failure Mode**: No silent declaration that tenant-scoped ciphertext is already compliant for a project-scoped production artifact.

### INT-16: Auth Profile Resolution Follows Canonical Actor and Session-Principal Semantics

- **Boundary**: Runtime auth context -> auth-profile preflight/resolution -> tool execution
- **Setup**: Seed shared, personal, and session-scoped auth-profile fixtures plus one human contact-backed session and one service-principal/debug-style actor context.
- **Steps**: Resolve tool auth and preflight requirements for matching and mismatched actor contexts while keeping the human subject constant.
- **Expected Result**: Credential ownership follows canonical actor/session-principal semantics; the human `contact` subject does not implicitly authorize personal/per-user credentials.
- **Failure Mode**: Overloaded `userId` or caller-context fallbacks must not let the wrong actor resolve a personal or session-scoped credential.

### INT-17: Model Resolution Preserves Actor-Scoped Full Resolve and Subject-Agnostic Reasoning Settings

- **Boundary**: Runtime execution scope -> model-resolution service -> cache keys
- **Setup**: Build fixtures for the same tenant/project/agent with varying actor contexts and the same human contact subject.
- **Steps**: Call full `resolve()` and settings-only reasoning resolution while varying actor scope, subject identity, and settings snapshot inputs independently.
- **Expected Result**: Full resolution changes only when actor-scoped credential policy or versioned inputs require it; reasoning-settings cache identity remains unaffected by actor or human-subject-only changes.
- **Failure Mode**: `contactId` or subject-kind changes must not churn reasoning-settings caches or become hidden full-resolution identity dimensions unless policy explicitly depends on them.

### INT-18: Memory Ownership Separates Contact, Actor, Project, and Session Semantics

- **Boundary**: Session bootstrap -> runtime executor -> memory integration / fact store / contact context
- **Setup**: Seed one human contact-backed session flow, one platform-user/debug flow, one service-principal flow, and one project-scoped memory fixture.
- **Steps**: Execute REMEMBER/RECALL or equivalent memory reads/writes through each path, then inspect which store/context was used.
- **Expected Result**: Session memory remains per session, project memory remains project-scoped, human continuity resolves through contact-backed context, and actor/debug memory stays isolated from human memory.
- **Failure Mode**: `callerContext.customerId || session.userId` fallback behavior must not remain the hidden memory owner contract.

### INT-19: Rollout Mode Supports Safe `enforce` -> `warn` Rollback

- **Boundary**: Rollout mode config -> runtime/session boundaries -> compatibility counters
- **Setup**: Start with strict enforcement enabled and fixtures that are known to exercise a compatibility path.
- **Steps**: Execute the failing request in `enforce`, flip to `warn`, rerun the same request, and inspect logs/counters.
- **Expected Result**: Rollback restores controlled compatibility behavior without data corruption, hidden coercion, or stale strict-mode state.
- **Failure Mode**: Rollback must not require process-local cache clearing or manual repair to resume compatibility behavior.

---

## 6. Unit Test Scenarios

### UT-1: Human Scope Builder Always Produces `subject.kind = 'contact'`

- **Module**: Planned scope builder / mapper
- **Input**: Guest human caller, verified human caller, voice caller with external/customer-side identity
- **Expected Output**: All human inputs yield a `contact` subject; raw external IDs remain in evidence, not subject.

### UT-2: Non-Human Scope Builder Produces `service_principal`

- **Module**: Planned scope builder / mapper
- **Input**: Workflow, agent, and integration session sources
- **Expected Output**: Result uses `subject.kind = 'service_principal'` with the expected `principalType`.

### UT-3: Identity Evidence Builder Preserves Strength While Redacting Raw Artifacts

- **Module**: Planned identity evidence helper
- **Input**: Phone, external ID, cookie, caller ID, and email artifacts with different verification strengths
- **Expected Output**: Output contains normalized strength and hashed/redacted artifacts suitable for durable scope/audit storage.

### UT-4: Compatibility Classifier Distinguishes Backfillable vs Quarantine Records

- **Module**: Planned migration classifier
- **Input**: Fully scoped rows, rows missing only contact linkage, rows missing project scope, ambiguous mixed-principal rows
- **Expected Output**: Deterministic classification into backfill, quarantine, expire, or explicit debug/system buckets.

### UT-5: SDK User Context Does Not Become Authoritative Human Identity

- **Module**: Planned SDK/bootstrap scope builder or identity mapper
- **Input**: Requests containing `userContext.userId` with and without verified bootstrap artifacts or trusted boundary evidence
- **Expected Output**: `userContext.userId` is treated as personalization or hinting input only; authoritative human identity is built from verified bootstrap/evidence and resolves to canonical `contact` subject semantics.

### UT-6: Ownership Matcher and Session-List Filter Prefer Canonical Subject Semantics

- **Module**: Shared session ownership / list-filter helpers
- **Input**: Canonical contact-backed identities, service-principal identities, and legacy compatibility fixtures
- **Expected Output**: Canonical subject/actor semantics drive allow/deny/filter decisions; compatibility paths are explicit and measurable.

### UT-7: GDPR Subject Resolver Classifies Canonical, Compatibility, and Quarantine Cases Correctly

- **Module**: Planned retention/GDPR subject resolver or migration-aware lookup helper
- **Input**: Canonical contact rows, service-principal rows, legacy field-only rows, and ambiguous mixed-identity rows
- **Expected Output**: Deterministic routing into canonical lookup, compatibility lookup with telemetry, or quarantine/error buckets.

### UT-8: Transfer Alias Mapping Keeps `contactId` Canonical

- **Module**: Agent-transfer adapter/session mapping helper
- **Input**: Human contact identity plus provider-generated synthetic user IDs or aliases
- **Expected Output**: Canonical subject remains the original `contactId`; provider aliases are stored only in provider metadata.

### UT-9: Encryption Scope Mapper Selects Project DEKs for Session Artifacts and Tenant Scope for Contacts

- **Module**: Session crypto helper / KMS scope resolver adapter
- **Input**: Project-scoped session payloads, queue payloads, transfer-session metadata, ClickHouse rows with `project_id`, and tenant-wide contact identity operations
- **Expected Output**: Session-adjacent artifacts resolve `tenantId + projectId + environment`; contact identity crypto resolves the documented tenant-scoped path only.

### UT-10: Encrypted-Artifact Migration Classifier Distinguishes Re-Encrypt, Compatibility, and Quarantine Cases

- **Module**: Planned encrypted-artifact migration classifier
- **Input**: Canonical project-scoped ciphertext, legacy tenant-scoped ciphertext with derivable project, legacy ciphertext without safe project derivation
- **Expected Output**: Deterministic routing into no-op, re-encrypt, compatibility-tracked, or quarantine buckets.

### UT-11: Auth Profile Context Builder Derives Credential Ownership From Canonical Actor/Auth Scope

- **Module**: Auth-profile context builder / propagation helper
- **Input**: Platform-user, session-principal, service-principal, and human-contact subject combinations
- **Expected Output**: Credential-owner resolution follows canonical actor/auth-scope semantics; human subject identity does not become the fallback owner of personal/session credentials.

### UT-12: Model-Resolution Cache Builders Keep Contact Subject Out of Scope Identity

- **Module**: Model-resolution versioning helpers
- **Input**: Same versioned snapshot with varying `contactId`, subject kind, actor `userId`, and reasoning-settings inputs
- **Expected Output**: Full-resolution cache keys change only for actor/user or versioned-input differences that already matter; reasoning-settings keys ignore both actor-only and subject-only identity changes.

### UT-13: Memory Ownership Mapper Separates Contact-Backed Human Memory From Actor-Owned Memory

- **Module**: Memory scope/ownership helper or runtime memory bootstrap mapper
- **Input**: Human contact session, debug/platform-user session, service-principal session, and project memory declaration
- **Expected Output**: Human memory resolves to contact-backed ownership, actor-owned memory resolves to explicit actor ownership, project memory resolves to project scope, and no path falls back to overloaded raw `userId` semantics.

---

## 7. Cross-Cutting Reporting / Insights / Studio / Encryption Assertions

- Reporting, admin-session, and trace-inspection surfaces must expose or derive canonical human vs `service_principal` classification without treating raw `customerId` / `anonymousId` as authoritative identity.
- Auth-profile validation must confirm that personal/per-user/session credentials are resolved from canonical actor semantics rather than from human subject identity or raw session `userId` fallback behavior.
- Model-resolution validation must confirm that human-subject identity does not become a hidden cache dimension and that reasoning-settings resolution remains settings-only.
- Memory validation must distinguish contact-backed human continuity from actor-owned/debug memory, project memory, and session working state.
- Historical trace replay must preserve enough canonical scope metadata that Studio/admin views do not disagree with live traces about `subject`, `actor`, or migration status.
- Migration-period dashboards and analytics checks should differentiate canonical rows from compatibility/fallback rows so rollout safety can be evaluated with real data.
- Studio session list/detail/trace/read-model surfaces should remain identity-light by default, but they must agree with runtime about canonical scope summary and debug-vs-production classification.
- Retention/GDPR and archive/export tooling should expose enough canonical/migration metadata that operators can understand what subject was scrubbed or archived without reconstructing legacy identity fields manually.
- Encryption/KMS validation should distinguish project-scoped session-artifact writes from tenant-scoped contact-identity operations and should surface compatibility-path usage for any tenant-scoped DEK fallback still serving project-scoped session data.
- KMS audit validation should confirm that project-scoped encrypted session artifacts emit `projectId`, `environment`, and `dekId` strongly enough to support rollout monitoring, re-encryption, and compliance review.

---

## 8. Security & Isolation Tests

- Cross-tenant session create, resume, restore, and queue operations must fail closed and return the repo-standard non-leaky response shape.
- Cross-project resume or attachment/message follow-on access must fail closed even when `sessionId` is valid.
- Cross-user or wrong-contact access must fail closed for reusable service boundaries, not only for route-local guards.
- Service-principal sessions must not exercise human-only access paths unless an explicit elevated policy exists.
- Missing auth must return `401`; insufficient elevated policy for admin/system reads must return the expected privileged-access failure.
- Validation must reject malformed or partial scope objects, including missing `projectId`, missing subject, missing actor, or missing identity evidence in production flows.
- Studio proxy routes must preserve runtime isolation semantics and must not downgrade cross-project/cross-user failures into leaky client-side distinctions.
- Debug callerData, preview custom attributes, and provider-side transfer aliases must never acquire production ownership semantics.
- Wrong-scope-kind requests should return the documented `400` contract errors, while wrong-owner or wrong-tenant access to existing resources should continue returning non-leaky `404` behavior.
- Personal/per-user/session auth profiles must not resolve successfully for the wrong actor just because a human contact subject or legacy `userId` field happens to be present.
- Human contact-backed memory must not bleed into debug/platform-user/service-principal memory through shared `userId` fallback behavior.
- Reasoning-settings caches must not fragment on contact subject or other human-identity dimensions that are outside the documented contract.
- Project-scoped production session crypto must not silently downgrade to tenant-scoped DEK defaults when `projectId` or environment context is missing.
- Contact identity crypto and crypto-shredding tests must prove that tenant-scoped behavior is a documented exception, not a legacy leak.
- Threat-model regression coverage should explicitly exercise the high-risk abuse paths called out in the feature spec: sessionId-only restore, reverse-lookup fallback, partial-scope queue replay, wrong scope-kind routing, overloaded `userId` ownership, and DEK-scope downgrade.

---

## 9. Performance & Load Tests

- Run a migration-batch stress test that confirms `SESSION_SCOPE_MIGRATION_BATCH_SIZE` does not introduce unbounded scans or lock contention.
- Run a queue-enqueue burst test to confirm the added boundary validation does not materially regress throughput for valid scoped payloads.
- Run a hot-session resume benchmark before and after enforcement to confirm the fix does not add avoidable extra Redis/Mongo round trips.

---

## 10. Test Infrastructure

- **Required services**: Runtime server, Studio app server or route harness, Redis, MongoDB, BullMQ worker infrastructure, EventStore / ClickHouse surfaces as needed, KMS/DEK test harness or configured local provider, and any channel-specific test harness needed for SDK or voice entry paths.
- **Data seeding**:
  - fully scoped production human sessions
  - guest human sessions that should resolve to anonymous contacts
  - customer-known but platform-new voice sessions
  - non-human workflow/agent/integration sessions
  - legacy sessions missing only contact linkage
  - ambiguous legacy sessions that should be quarantined
  - transfer sessions with provider-side synthetic aliases
  - auth-profile fixtures covering shared, personal, and session-scoped credentials across platform-user, service-principal, and human-contact-backed flows
  - retention/GDPR fixtures covering canonical, compatibility, and ambiguous subject lookup
  - contact-backed human memory fixtures plus actor-owned/debug memory and project-memory fixtures
  - project-scoped session artifacts encrypted under correct DEK scope
  - legacy project-scoped session artifacts encrypted under tenant-scoped compatibility paths
  - tenant-scoped contact identity fixtures with expected blind-index and salt behavior
- **Environment variables**:
  - rollout mode flag for `audit` / `warn` / `enforce`
  - migration batch-size controls
  - KMS / DEK configuration for local or test provider startup
  - channel/test credentials required for SDK or voice harnesses
  - Studio/runtime proxy configuration for session, traces, insights, and preview paths
- **CI configuration**:
  - targeted runtime suites should run before repo-wide validation
  - red-first adversarial tests should be allowed to fail only before the implementation branch is intended to turn them green
  - Studio proxy/hook/component tests should run after the relevant runtime/eventstore/shared-auth packages are built
  - crypto-alignment coverage should include `packages/database` and `packages/shared-encryption` suites when session-scope changes touch DEK behavior

---

## 11. Test File Mapping

| Test File                                                                        | Current Type     | Target Type           | Covers                        |
| -------------------------------------------------------------------------------- | ---------------- | --------------------- | ----------------------------- |
| `apps/runtime/src/__tests__/session-scope-factory.test.ts`                       | unit             | unit/integration      | FR-1, FR-2, FR-3, FR-9, FR-11 |
| `apps/runtime/src/__tests__/channels/pipeline-session-factory.test.ts`           | integration      | integration           | FR-1, FR-3, FR-7, FR-11       |
| `apps/runtime/src/__tests__/channels/livekit-routes.test.ts`                     | integration      | e2e/integration       | FR-1, FR-2, FR-3, FR-11       |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`                     | integration      | integration/e2e       | FR-3, FR-6, FR-11, FR-24      |
| `apps/runtime/src/__tests__/channels/ws-twilio-handler.test.ts`                  | integration      | integration/e2e       | FR-1, FR-3, FR-11             |
| `apps/runtime/src/__tests__/identity/production-contact-resolution.test.ts`      | unit             | unit                  | FR-3, FR-11, FR-14            |
| `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`                        | integration      | e2e                   | FR-1, FR-2, FR-7, FR-11       |
| `apps/runtime/src/__tests__/sessions/session-locator.test.ts`                    | integration      | integration           | FR-4, FR-5, FR-6, FR-11       |
| `apps/runtime/src/__tests__/routing/async-fanout-resumption.test.ts`             | integration      | integration           | FR-4, FR-6, FR-11             |
| `apps/runtime/src/__tests__/sessions/session-resolver-gaps.test.ts`              | integration      | integration           | FR-4, FR-6, FR-7, FR-11       |
| `apps/runtime/src/__tests__/execution/runtime-executor.test.ts`                  | unit/integration | integration           | FR-3, FR-7, FR-11, FR-24      |
| `apps/runtime/src/__tests__/session/runtime-session-identity.test.ts`            | unit             | unit/integration      | FR-3, FR-24                   |
| `apps/runtime/src/__tests__/redis-session-store-lookup.test.ts`                  | integration      | integration           | FR-5, FR-11                   |
| `apps/runtime/src/__tests__/tiered-session-store.test.ts`                        | unit             | integration           | FR-4, FR-5, FR-6, FR-11       |
| `apps/runtime/src/__tests__/message-persistence-queue-full.test.ts`              | unit             | integration           | FR-7, FR-11, FR-12            |
| `apps/runtime/src/__tests__/sessions/session-security.test.ts`                   | integration      | integration           | FR-1, FR-2, FR-3, FR-4        |
| `apps/runtime/src/__tests__/execution/contexts/orchestration/*.test.ts`          | unit/integration | unit/integration      | FR-3, FR-8, FR-10, FR-15      |
| `apps/runtime/src/__tests__/auth/*.integration.test.ts`                          | integration      | e2e/integration       | FR-1, FR-2, FR-3              |
| `apps/runtime/src/__tests__/channels/*.e2e.test.ts`                              | e2e              | e2e                   | FR-1, FR-2, FR-3, FR-11       |
| `packages/database/src/migrations/scripts/*session*`                             | integration      | integration           | FR-10, FR-12                  |
| `packages/shared-auth/src/__tests__/session-ownership.test.ts`                   | unit/integration | unit/integration      | FR-14                         |
| `packages/database/src/__tests__/encryption-plugin-dek.test.ts`                  | unit/integration | unit/integration      | FR-19, FR-20                  |
| `packages/database/src/__tests__/clickhouse-encryption-interceptor.test.ts`      | unit             | unit                  | FR-19                         |
| `packages/database/src/__tests__/kms-resolver.test.ts`                           | unit             | unit                  | FR-19, FR-21                  |
| `packages/shared-encryption/src/__tests__/tenant-encryption-facade.test.ts`      | unit             | unit                  | FR-19, FR-21                  |
| `apps/runtime/src/__tests__/auth/kms-per-tenant-integration.test.ts`             | integration      | integration           | FR-19, FR-21                  |
| `apps/runtime/src/__tests__/auth/encryption-salt-lifecycle.test.ts`              | integration      | integration           | FR-20                         |
| `apps/runtime/src/__tests__/auth/auth-profile-propagation.test.ts`               | unit             | unit/integration      | FR-22                         |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-executor-integration.test.ts` | integration      | integration           | FR-22                         |
| `apps/runtime/src/__tests__/model-resolution-versioning.test.ts`                 | unit             | unit                  | FR-23                         |
| `apps/runtime/src/__tests__/memory-integration.test.ts`                          | integration      | integration           | FR-24                         |
| `apps/runtime/src/__tests__/mongodb-fact-store-scope.test.ts`                    | unit             | unit/integration      | FR-24                         |
| `apps/runtime/src/__tests__/memory-scope-integration.test.ts`                    | integration      | integration           | FR-24                         |
| `packages/eventstore/src/__tests__/retention-gdpr.test.ts`                       | integration      | integration           | FR-13, FR-17                  |
| `apps/studio/src/__tests__/retention-scheduler.test.ts`                          | integration      | integration           | FR-13, FR-18                  |
| `apps/studio/src/__tests__/hooks/session-hooks.test.ts`                          | unit/integration | unit/integration      | FR-17, FR-18                  |
| `apps/studio/src/__tests__/session-lifecycle-api.e2e.test.ts`                    | e2e              | e2e                   | FR-1, FR-2, FR-18             |
| `apps/studio/src/__tests__/hooks/project-agent-session-launcher.test.ts`         | unit/integration | unit/integration      | FR-9, FR-18                   |
| `apps/studio/src/__tests__/agent-transfer-ui.test.ts`                            | component        | component/integration | FR-16, FR-18                  |
| `packages/agent-transfer/src/adapters/five9/__tests__/*.test.ts`                 | integration      | integration/e2e       | FR-16                         |
| `packages/agent-transfer/src/__tests__/unit/session-field-encryption.test.ts`    | unit             | unit                  | FR-19                         |

---

## 12. Manual Validation Scenarios

### MAN-1: Rollout Dashboard Review

Review compatibility-path, quarantine, and scope-failure metrics during `audit` and `warn` modes before enabling `enforce`.

### MAN-2: Operator Session Inspection

Inspect migrated and newly created sessions through existing diagnostics/session views to confirm actor, subject, identity evidence, tenant, and project metadata are coherent.

### MAN-3: Channel-Specific Smoke Pass

**Covers**: FR-3, FR-15

Exercise one HTTP, one SDK, and one voice flow in a staging environment to confirm all human sessions are contact-backed and that non-human sessions retain service-principal semantics.

### MAN-4: Studio Operator Review

Review Studio session detail, traces, transfer monitoring, and debug/preview flows to confirm canonical scope metadata is visible where needed and that debug-only caller data is not presented as authoritative production identity.

### MAN-5: Compliance / Erasure Drill

Run a staged retention or GDPR erasure flow against canonical and migrated fixtures to confirm operator tooling, audit output, and archive metadata stay consistent.

### MAN-6: DEK Scope / Re-Encryption Drill

Run a staged migration or compatibility pass against legacy tenant-scoped session ciphertext to confirm project-scoped artifacts are re-encrypted or quarantined as designed and that KMS audit telemetry is complete.

### MAN-7: Auth and Memory Ownership Drill

**Covers**: FR-16, FR-22, FR-23, FR-24

Exercise one human customer session, one Studio/debug session, one service-principal flow, and one transfer/handoff flow in staging to confirm auth-profile ownership, model-resolution behavior, transfer alias handling, and persistent-memory semantics all follow canonical actor/contact boundaries.

---

## 13. Exit Criteria

The runtime safety harness is partially green now: converted boundary, locator/store, voice bootstrap, and follow-up metadata regressions are covered with real runtime tests. The overall feature is still not exit-ready because the Studio, reporting, auth-profile, memory, migration, and crypto workstreams remain open.

- All adversarial tests added in Phase 0 exist and start red against the pre-fix behavior.
- At least five E2E scenarios and five integration scenarios are written against real runtime surfaces or real service boundaries.
- Phase 1 tests pass with production boundaries fail-closed.
- No test still relies on missing tenant/project scope or missing human subject as valid steady-state behavior.
- Targeted runtime test suites pass before broader repo validation.
- Rollout observability proves compatibility-path usage is trending to zero before Phase 3 cleanup starts.
- Studio proxy/read-model tests prove that historical traces, session detail, and debug flows agree with runtime canonical scope semantics.
- Retention/GDPR and eventstore tests prove that canonical subject semantics survive anonymization, archive/export, and migration compatibility paths.
- Auth-profile tests prove that personal/per-user/session credentials follow canonical actor semantics and do not fall back to human subject identity.
- Model-resolution tests prove that canonical human subject identity does not leak into cache keys or reasoning-settings scope.
- Memory tests prove that contact-backed human continuity is separate from actor/debug memory and that compatibility shims are measurable.
- KMS/DEK tests prove that project-scoped production session artifacts no longer depend on tenant-scoped convenience wrappers, while tenant-scoped contact crypto remains an explicit exception.
- Migration coverage proves legacy tenant-scoped session ciphertext is either re-encrypted, compatibility-tracked, or quarantined with auditable metadata.
- Rollback coverage proves the system can move from `enforce` back to `warn` without hidden state corruption or manual repair.

---

## 14. Open Testing Questions

1. Do voice E2E tests run reliably enough in CI today, or should the first voice coverage land as high-fidelity integration tests and graduate to full E2E after harness hardening?
2. Which reporting or analytics validation surface should become the canonical assertion point for canonical `subjectKind` / `actorKind` and compatibility-path dimensions during rollout?
3. Which assertion surface should be the source of truth for project-scoped DEK usage during rollout: KMS audit rows, `dek_registry`, compatibility counters, or a combination of all three?

Resolved testing decisions captured by the feature spec and reflected in this test plan:

- canonical subject/actor/evidence assertions should anchor on session-detail responses backed by the dedicated runtime diagnostics/read-model payload
- actor-owned auth-profile behavior should be asserted through both auth-preflight summaries and tool-auth resolution traces where available
- contact-backed human memory should be asserted through both contact-context APIs and REMEMBER/RECALL behavior during the compatibility window
