# LLD: Session Scope Enforcement

**Feature Spec**: [docs/features/sub-features/session-scope-enforcement.md](../features/sub-features/session-scope-enforcement.md)
**HLD**: [docs/specs/session-scope-enforcement.hld.md](../specs/session-scope-enforcement.hld.md)
**Test Spec**: [docs/testing/sub-features/session-scope-enforcement.md](../testing/sub-features/session-scope-enforcement.md)
**Status**: IN PROGRESS
**Date**: 2026-04-16

---

## 1. Problem Statement

The approved feature spec and HLD define the target architecture, but the repository still runs on the old execution model: production session creation accepts partial scope, storage adapters still allow bare `sessionId` access, queue persistence repairs missing scope late, and downstream consumers such as ownership checks, auth-profile resolution, memory, Studio diagnostics, and trace/reporting surfaces still infer identity through overloaded legacy fields.

That creates two implementation risks:

1. The core isolation fix can stall if the feature is treated as one giant runtime-plus-Studio-plus-crypto rewrite.
2. A naive refactor can close the obvious session-scope gaps while quietly breaking adjacent contracts such as model resolution, auth ownership, or human-memory continuity.

This LLD turns the approved architecture into an executable plan that keeps the production boundary and storage fixes on the critical path, while still giving operator surfaces, compliance flows, and DEK alignment a concrete migration path.

## 2. Design Decisions

## 2.1. Implementation Status Snapshot (2026-04-16)

- **Phase 1 runtime boundary work is materially landed in `apps/runtime`.** The branch now has `ExecutionScope` / `SessionLocator` contracts, converted production session-create paths, canonical contact-backed human scope construction, LiveKit token preflight, Twilio fail-closed bootstrap handling, and `413 PAYLOAD_TOO_LARGE` propagation for follow-up `sessionMetadata` violations.
- **Phase 2 storage / rehydrate work is partially landed in `apps/runtime`.** Production resume, cold-restore, reverse-lookup expiry, locator-aware session-store seams, canonical-contact backfill on resumed SDK/HTTP sessions, fact-store re-keying after contact resolution, and session-refresh continuity via stable runtime session IDs are covered on the converted runtime path; compatibility APIs still exist outside that hardened path.
- **Phases 3-5 remain open.** Shared ownership/auth-profile/model-resolution/memory alignment, Studio/reporting/read-model parity, migration jobs, and DEK alignment are still follow-on workstreams.

### Decision Log

| #    | Decision                                                                                                            | Rationale                                                                                                                                                                                                                                                 | Alternatives Rejected                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| D-1  | Split the work into a core critical path plus two sibling workstreams                                               | The feature spans runtime boundaries, storage, auth, reporting, Studio, GDPR, and crypto. Core runtime isolation fixes must not wait on every downstream read model.                                                                                      | One monolithic implementation phase touching all 9 packages at once                                         |
| D-2  | Treat "Phase 0 red tests first" as an execution rule inside each phase, not as a separately merged broken phase     | The approved feature/test strategy requires red-first validation, but deployable phases still need to land green. Each phase starts by writing or tightening tests on the branch, verifying the failure locally, then implementing to green before merge. | Committing permanently red tests to `develop`; skipping the red-first discipline                            |
| D-3  | Add dedicated scope contracts under `apps/runtime/src/services/session/`                                            | Boundary adapters, stores, queue producers, and diagnostics need one shared source of truth for `ExecutionScope`, `SessionLocator`, and `ScopeDiagnostics`.                                                                                               | Scattering ad hoc types across route handlers, websocket handlers, and store adapters                       |
| D-4  | Introduce a `ScopedSessionFacade` between boundary code and the existing store/service layer                        | The current `SessionService` and `SessionStore` APIs are too permissive. A facade lets us migrate callers incrementally while concentrating compatibility policy and telemetry.                                                                           | Rewriting every store and caller in one pass; leaving store access distributed across handlers              |
| D-5  | Boundary adapters own human subject resolution before production session creation                                   | The product decision is that every human production session is anchored to `contactId`. That has to happen before any runtime session, queue payload, or durable session row is created.                                                                  | Letting deeper layers infer or repair `contactId`; keeping `customerId` as an authoritative session subject |
| D-6  | Queue producers move to an explicit scoped envelope, while workers keep only a bounded compatibility lane           | The queue contract is a critical isolation seam. Missing tenant/project/actor/subject data must stop at enqueue time for steady-state traffic.                                                                                                            | Continuing late repair in workers; relying on synthetic worker identity                                     |
| D-7  | Preserve the existing model-resolution contract and migrate memory with single-write / compatibility-read semantics | Full model resolution is already correctly actor-scoped. Human memory should move to contact-backed ownership without long-lived dual-write drift.                                                                                                        | Adding `contactId` to reasoning-settings cache keys; dual-writing old and new memory lanes indefinitely     |
| D-8  | Make `scopeDiagnostics` the canonical operator read model, then let Studio/admin/reporting consume it additively    | One canonical diagnostics payload avoids three partially overlapping operator truths.                                                                                                                                                                     | Separate bespoke shapes for Studio detail, traces, admin sessions, and GDPR/retention tooling               |
| D-9  | Keep contact crypto tenant-scoped, but force project/environment DEKs for project-scoped session artifacts          | This matches the approved architecture: contact is the tenant-wide human anchor; production session data is project-scoped and should use project-scoped crypto semantics.                                                                                | Re-project-scoping contact identities; leaving session-adjacent crypto on tenant-wide wrappers              |
| D-10 | Keep wrong-scope-kind rejection and rollout mode policy centralized in `ScopePolicy`                                | The same fail-closed contract needs to apply across HTTP, WebSocket, queue, and later Studio/admin entry points.                                                                                                                                          | Re-implementing `INVALID_SESSION_SCOPE` / `UNSUPPORTED_SCOPE_KIND` behavior independently in each handler   |

### Key Interfaces & Types

```typescript
export type ScopeEnforcementMode = 'audit' | 'warn' | 'enforce';

export type SessionSubject =
  | { kind: 'contact'; contactId: string }
  | {
      kind: 'service_principal';
      principalType: 'workflow' | 'agent' | 'integration';
      principalId: string;
    };

export type SessionActor =
  | { kind: 'contact'; contactId: string }
  | { kind: 'platform_user'; userId: string }
  | { kind: 'api_key'; keyId: string }
  | {
      kind: 'service_principal';
      principalType: 'workflow' | 'agent' | 'integration';
      principalId: string;
    };

export interface IdentityEvidence {
  identityTier: 0 | 1 | 2;
  verificationMethod: string;
  artifacts: Array<{
    type: 'external' | 'phone' | 'email' | 'cookie' | 'caller_id' | 'device_id';
    valueHash: string;
  }>;
}

export type ProductionExecutionScope = {
  kind: 'production';
  tenantId: string;
  projectId: string;
  sessionId: string;
  channelId: string;
  environment: string;
  source: string;
  authType: string;
  traceId: string;
  actor: SessionActor;
  subject: SessionSubject;
  identityEvidence: IdentityEvidence;
  callerContext: Record<string, unknown>;
};

export type SessionLocator = {
  tenantId: string;
  projectId: string;
  sessionId: string;
};

export type PrivilegedSessionLocator = SessionLocator & {
  accessMode: 'admin' | 'observability' | 'gdpr';
  reason: string;
  redactionMode: 'redacted' | 'full';
};

export interface ScopeDiagnostics {
  scopeKind: 'production' | 'debug' | 'system';
  sessionLocator: SessionLocator | null;
  subject: { kind: SessionSubject['kind']; id: string };
  actor: { kind: SessionActor['kind']; id: string };
  authType: string | null;
  source: string | null;
  environment: string | null;
  identityEvidenceSummary: {
    identityTier: number | null;
    verificationMethod: string | null;
    artifactTypes: string[];
  };
  migrationStatus: 'native' | 'backfilled' | 'compatibility' | 'quarantined';
  compatibilityPathUsed: string | null;
}

export interface ScopedPersistenceEnvelope {
  scope: ProductionExecutionScope;
  message: {
    dbSessionId: string;
    role: string;
    content: string;
    channel: string;
    traceId?: string;
  };
}
```

### Module Boundaries

| Module                                                                                             | Responsibility                                                                                  | Depends On                                                                                |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session`                                                                | Own scope contracts, validation, policy, facade, migration helpers, diagnostics summary         | `packages/shared-auth`, `packages/database`, `packages/shared-encryption`                 |
| Runtime boundary adapters (`routes/chat.ts`, websocket handlers, session factory, queue producers) | Build validated scope before creating sessions or enqueuing persistence work                    | `ExecutionScopeFactory`, contact resolution, trace-id helpers                             |
| Session storage adapters (`SessionStore`, Redis, tiered store, cold repo)                          | Enforce `SessionLocator` and remove unscoped production-path helpers                            | `ScopedSessionFacade`, `packages/database`, Redis                                         |
| Shared auth + ownership                                                                            | Evaluate session read/list/resume/delete authorization using canonical subject/actor semantics  | `packages/shared-auth`, diagnostics summary, caller identity                              |
| Auth-profile / model-resolution / memory services                                                  | Consume canonical actor and subject inputs without changing the model-resolution cache contract | `apps/runtime/src/services/auth-profile`, `apps/runtime/src/services/llm`, memory bridges |
| Diagnostics / Studio / reporting / compliance                                                      | Surface canonical scope, migration state, and compatibility path usage additively               | `ScopeDiagnosticsService`, eventstore, Studio proxy routes                                |
| Encryption + migration workstream                                                                  | Align DEK scope, classify legacy ciphertext, re-encrypt or quarantine unsafe artifacts          | `packages/shared-encryption`, `packages/database`, KMS audit logger                       |

---

## 3. File-Level Change Map

### New Files

| File                                                                       | Purpose                                                                                                          | LOC Estimate |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/services/session/execution-scope.ts`                     | Canonical `ExecutionScope`, `SessionActor`, `SessionSubject`, `IdentityEvidence`, and `SessionLocator` contracts | 150          |
| `apps/runtime/src/services/session/execution-scope-factory.ts`             | Boundary validation, contact resolution handoff, actor/subject/evidence/environment construction                 | 250          |
| `apps/runtime/src/services/session/scope-policy.ts`                        | `audit` / `warn` / `enforce` behavior, stable error envelopes, compatibility counters                            | 140          |
| `apps/runtime/src/services/session/scoped-session-facade.ts`               | Production session CRUD API over `SessionLocator` and validated scope                                            | 220          |
| `apps/runtime/src/services/session/scope-diagnostics-service.ts`           | Canonical diagnostics/read-model builder for session detail, admin, and Studio                                   | 180          |
| `apps/runtime/src/services/session/session-scope-migration.ts`             | Backfill classification, quarantine decisions, and rollout helper utilities                                      | 220          |
| `apps/runtime/src/__tests__/session-scope-factory.test.ts`                 | Unit coverage for scope building, actor/subject classification, and error envelopes                              | 220          |
| `apps/runtime/src/__tests__/session-scope-boundaries.integration.test.ts`  | Integration coverage for boundary enforcement and queue envelope validation                                      | 260          |
| `apps/runtime/src/__tests__/session-scope-diagnostics.integration.test.ts` | Diagnostics/read-model coverage for canonical scope summary                                                      | 220          |
| `packages/database/src/migrations/<timestamp>_session_scope_backfill.ts`   | Additive backfill for session/message scope fields and migration status                                          | 260          |
| `packages/database/src/migrations/<timestamp>_session_scope_reencrypt.ts`  | Re-encryption / compatibility classification for legacy project-scoped session artifacts                         | 240          |

### Modified Files

| File                                                                  | Change Description                                                                                                | Risk   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/services/session/types.ts`                          | Add canonical scope metadata to hot-session data and remove optional-identity assumptions from the runtime shape  | High   |
| `apps/runtime/src/services/session/session-store.ts`                  | Replace bare-ID production operations with scoped locator methods                                                 | High   |
| `apps/runtime/src/services/session/session-service.ts`                | Shift session create/load/save/delete/touch/version APIs toward scope-aware contracts                             | High   |
| `apps/runtime/src/services/session/redis-session-store.ts`            | Remove empty-tenant fallback and enforce locator-based reads/writes                                               | High   |
| `apps/runtime/src/services/session/tiered-session-store.ts`           | Remove unscoped cold-store production fallback and rehydrate by scoped locator                                    | High   |
| `apps/runtime/src/services/session/session-state-repo.ts`             | Promote scoped cold-store methods and confine `*Internal` helpers to privileged migration/admin flows only        | High   |
| `apps/runtime/src/services/session/session-bootstrap.ts`              | Accept validated production scope instead of optional tenant/project/user fragments                               | High   |
| `apps/runtime/src/channels/pipeline/session-factory.ts`               | Build and pass validated scope into runtime session creation and DB session linking                               | High   |
| `apps/runtime/src/routes/chat.ts`                                     | Fail closed on invalid production scope and build canonical scope before session creation                         | High   |
| `apps/runtime/src/websocket/handler.ts`                               | Enforce production vs debug discriminants and scoped persistence envelopes                                        | High   |
| `apps/runtime/src/websocket/sdk-handler.ts`                           | Deprecate `userContext.userId` as authoritative identity, resolve canonical contact-backed subject                | High   |
| `apps/runtime/src/websocket/twilio-media-handler.ts`                  | Resolve/create contact before production session bootstrap and persistence                                        | High   |
| `apps/runtime/src/channels/pipeline/message-pipeline.ts`              | Pass scoped persistence envelope instead of partial tenant/project values                                         | High   |
| `apps/runtime/src/services/message-persistence-queue.ts`              | Require full enqueue scope, bounded repair lane only for compatibility traffic, preserve actor/subject provenance | High   |
| `apps/runtime/src/services/stores/mongo-conversation-store.ts`        | Persist additive canonical scope summary and stop emitting blank tenant/project lifecycle fields                  | Medium |
| `packages/shared-auth/src/middleware/session-ownership.ts`            | Replace legacy identity-tier ownership logic with canonical subject/actor evaluation                              | High   |
| `apps/runtime/src/services/auth-profile/auth-preflight.ts`            | Resolve session/user auth ownership from canonical actor/auth-scope inputs                                        | Medium |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`         | Feed tool-auth resolution from canonical actor/auth scope, not overloaded session `userId`                        | Medium |
| `apps/runtime/src/services/tool-oauth-service.ts`                     | Keep session-scoped artifacts actor-owned and aligned with new locator/scope semantics                            | Medium |
| `apps/runtime/src/services/llm/model-resolution.ts`                   | Switch full resolution to canonical actor input while preserving current cache contract                           | Medium |
| `apps/runtime/src/services/llm/model-resolution-versioning.ts`        | Add explicit regression guard comments/tests for subject-free reasoning-settings caching                          | Low    |
| `apps/runtime/src/services/execution/memory-executor.ts`              | Move human memory ownership to contact-backed keys and keep actor/debug memory separate                           | Medium |
| `apps/runtime/src/services/execution/tool-memory-bridge.ts`           | Route memory reads/writes to contact/project/actor lanes explicitly                                               | Medium |
| `apps/runtime/src/services/contact-context-service.ts`                | Serve as canonical human continuity lane during compatibility-read migration                                      | Medium |
| `apps/runtime/src/services/trace/emit-to-eventstore.ts`               | Emit canonical scope dimensions and privacy-safe summaries                                                        | Medium |
| `apps/runtime/src/services/trace/clickhouse-session-trace-events.ts`  | Persist/replay canonical subject/actor summary fields                                                             | Medium |
| `apps/runtime/src/routes/admin-sessions.ts`                           | Expose canonical diagnostics/migration data for operators                                                         | Medium |
| `apps/runtime/src/routes/platform-admin-traces.ts`                    | Preserve privacy-safe actor/subject summaries in historical trace views                                           | Medium |
| `apps/studio/src/app/api/runtime/sessions/[id]/route.ts`              | Proxy `scopeDiagnostics` to Studio                                                                                | Medium |
| `apps/studio/src/app/api/runtime/sessions/[id]/traces/route.ts`       | Keep historical trace replay aligned with canonical scope summary                                                 | Medium |
| `apps/studio/src/components/session/SessionDetailPage.tsx`            | Render additive canonical diagnostics without redesigning the page                                                | Low    |
| `apps/studio/src/hooks/useSessionDetail.ts`                           | Type and expose the new diagnostics payload                                                                       | Low    |
| `apps/studio/src/services/retention/mongo-gdpr-store.ts`              | Replace heuristic subject discovery with canonical/migration-aware resolution                                     | Medium |
| `apps/studio/src/services/retention/retention-service.ts`             | Keep bounded compatibility scan and canonical subject handling aligned                                            | Medium |
| `packages/agent-transfer/src/security/session-field-encryption.ts`    | Align project-scoped transfer/session artifacts with project/environment DEKs                                     | Medium |
| `apps/runtime/src/services/agent-transfer/index.ts`                   | Preserve canonical `contactId` as authoritative human subject; provider aliases remain transport-only             | Medium |
| `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts` | Stop using tenant-scoped convenience wrappers for project-scoped session-event crypto                             | Medium |
| `packages/database/src/models/session.model.ts`                       | Add additive scope summary and migration fields to durable session rows                                           | High   |
| `packages/database/src/models/message.model.ts`                       | Add additive migration/classification fields needed for backfill and diagnostics                                  | Medium |

### Deleted Files

No files should be deleted during the core rollout. Legacy helpers stay in place until compatibility usage is near zero and rollback drills are complete.

---

## 4. Implementation Phases

**Execution rule that applies to every phase**: author or tighten the relevant tests first on the working branch, verify the failure locally, then implement until the phase lands green. The red-first verification is mandatory, but phases merge only when build and test gates pass.

### Phase 1: Boundary Scope Contracts

**Goal**: Make production session creation and queue enqueue fail closed at the runtime boundaries.

**Tasks**:
1.1. Add `execution-scope.ts`, `execution-scope-factory.ts`, and `scope-policy.ts` under `apps/runtime/src/services/session/`.
1.2. Introduce `ScopeEnforcementMode` and stable error envelopes for `INVALID_SESSION_SCOPE` and `UNSUPPORTED_SCOPE_KIND`.
1.3. Update `routes/chat.ts`, `routes/livekit.ts`, `services/session/session-bootstrap.ts`, `channels/pipeline/session-factory.ts`, `websocket/handler.ts`, `websocket/sdk-handler.ts`, and `websocket/twilio-media-handler.ts` to build validated production scope before session creation or token issuance.
1.4. Resolve/create canonical `contactId` subjects for human production sessions at the boundary; keep `service_principal` for non-human flows.
1.5. Replace partial queue producer inputs with `ScopedPersistenceEnvelope` in `message-persistence-queue.ts`, `channels/pipeline/message-pipeline.ts`, and the handler call sites that enqueue persistence work; follow-up `_metadata` validation must also fail closed instead of logging-and-dropping.
1.6. Add or tighten adversarial tests for missing project scope, wrong scope kind, missing queue scope, voice boundary fail-open regressions, `channelArtifact` precedence, SDK identity deprecation behavior, and early queue provenance preservation.
1.7. Add compatibility counters and structured warnings to remaining fallback paths so rollout impact is measurable before Phase 2 removes them.

**Files Touched**:

- `apps/runtime/src/services/session/execution-scope.ts` — new contracts
- `apps/runtime/src/services/session/execution-scope-factory.ts` — boundary scope builder
- `apps/runtime/src/services/session/scope-policy.ts` — rollout mode + error envelopes
- `apps/runtime/src/services/session/production-contact-scope.ts` — shared helper for required canonical contact-backed production scope
- `apps/runtime/src/services/identity/production-contact-resolution.ts` — canonical contact resolution and identity-artifact precedence
- `apps/runtime/src/services/session-metadata.ts` — shared request/post-merge metadata validation contract
- `apps/runtime/src/services/runtime-executor.ts` — follow-up metadata enforcement and scoped persistence propagation
- `apps/runtime/src/routes/chat.ts` — HTTP boundary enforcement
- `apps/runtime/src/routes/livekit.ts` — LiveKit token boundary enforcement before `200` success
- `apps/runtime/src/websocket/handler.ts` — runtime/debug boundary enforcement
- `apps/runtime/src/websocket/sdk-handler.ts` — SDK boundary enforcement + contact anchoring
- `apps/runtime/src/websocket/twilio-media-handler.ts` — voice boundary enforcement + fail-closed contact anchoring
- `apps/runtime/src/channels/pipeline/session-factory.ts` — shared session creation path
- `apps/runtime/src/services/message-persistence-queue.ts` — enqueue envelope changes
- `apps/runtime/src/channels/pipeline/message-pipeline.ts` — queue producer wiring
- `apps/runtime/src/__tests__/message-persistence-queue-full.test.ts` — current-type unit tests extended first, with target integration intent tracked
- `apps/runtime/src/__tests__/channels/pipeline-session-factory.test.ts` — boundary path assertions
- `apps/runtime/src/__tests__/session-scope-factory.test.ts` — new unit coverage
- `apps/runtime/src/__tests__/channels/livekit-routes.test.ts` — LiveKit token fail-closed regression coverage
- `apps/runtime/src/__tests__/channels/ws-twilio-handler.test.ts` — Twilio fail-open regression coverage
- `apps/runtime/src/__tests__/identity/production-contact-resolution.test.ts` — contact-resolution precedence coverage
- `apps/runtime/src/__tests__/sessions/chat-routes.test.ts` — HTTP `413 PAYLOAD_TOO_LARGE` and scope regressions
- `apps/runtime/src/__tests__/execution/runtime-executor.test.ts` — post-merge metadata overflow rejection coverage

**Status (2026-04-16)**: The converted runtime boundary work described above is green in targeted runtime suites. Remaining Phase 1 work is mostly parity and rollout instrumentation on unconverted or downstream paths.

**Exit Criteria**:

- [ ] Production HTTP/session-create and queue-enqueue paths reject missing `projectId` and malformed production scope with stable `400` error codes.
- [ ] Wrong-scope-kind payloads are rejected with `UNSUPPORTED_SCOPE_KIND` on converted boundaries.
- [ ] Human production session creation resolves or creates canonical `contactId` before the runtime session is considered valid.
- [ ] Queue producers on converted paths require explicit scope and provenance instead of optional tenant/project fields.
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with `0` type errors.
- [ ] Targeted runtime tests for queue/boundary enforcement pass on the feature branch after being verified red first.

**Test Strategy**:

- Unit: `session-scope-factory.test.ts`, queue envelope validation helpers, policy/error-envelope tests
- Integration: queue producer/worker boundary tests, converted route/websocket handler tests, SDK bootstrap assertions
- E2E: not required to complete Phase 1 merge, but the converted response envelopes must be compatible with the planned E2E scenarios

**Rollback**: Set `SESSION_SCOPE_ENFORCEMENT_MODE=audit` or `warn` and retain the compatibility envelope readers. No data rollback is required because the phase is additive and keeps backward-readable fields.

---

### Phase 2: Scoped Session Storage & ALS Propagation

**Goal**: Remove bare-`sessionId` production storage access and make ALS a propagation layer only.

**Tasks**:
2.1. Introduce `ScopedSessionFacade` and shift converted callers away from direct `SessionStore` access.
2.2. Refactor `SessionStore` and `SessionService` so production load/save/delete/touch/version/lock operations use `SessionLocator`.
2.3. Remove empty-string tenant fallback in `RedisSessionStore`; reverse-lookup expiry must fail closed.
2.4. Replace `TieredSessionStore` production cold fallback with scoped repo methods; confine `loadInternal()` / `getVersionInternal()` / `deleteInternal()` / `touchInternal()` to privileged migration or observability code only.
2.5. Mirror validated scope into ALS only after the boundary has built it; update `MongoConversationStore` and other deep data paths to consume mirrored scope rather than inventing it.
2.6. Tighten reusable service boundaries that currently depend on route-local project/session checks.
2.7. Add integration coverage for cross-tenant cold restore, wrong-project delete/touch/getVersion, reverse-lookup expiry, and scoped lock/delete behavior.

**Files Touched**:

- `apps/runtime/src/services/session/scoped-session-facade.ts` — new facade
- `apps/runtime/src/services/session/session-store.ts` — interface changes
- `apps/runtime/src/services/session/session-service.ts` — locator-aware orchestration
- `apps/runtime/src/services/session/redis-session-store.ts` — fail-closed reverse lookup
- `apps/runtime/src/services/session/tiered-session-store.ts` — scoped cold restore
- `apps/runtime/src/services/session/session-state-repo.ts` — scoped repo APIs
- `apps/runtime/src/services/stores/mongo-conversation-store.ts` — ALS propagation only
- `apps/runtime/src/__tests__/tiered-session-store.test.ts` — current-type unit tests tightened first, target integration cases added
- `apps/runtime/src/__tests__/redis-session-store-*.test.ts` — reverse-lookup / scoped store coverage
- `apps/runtime/src/__tests__/session-scope-boundaries.integration.test.ts` — new integration coverage

**Status (2026-04-16)**: Locator-aware runtime resume, cold-restore, reverse-lookup fail-closed behavior, and scoped store/repository seams are landed on converted production paths. Broader ALS-only cleanup and compatibility API retirement remain follow-on work.

**Exit Criteria**:

- [ ] No converted production path calls `load(sessionId)`, `delete(sessionId)`, `touch(sessionId)`, or `getVersion(sessionId)` without a `SessionLocator`.
- [ ] Redis reverse-lookup expiry fails closed and never reads/writes the empty-tenant namespace.
- [ ] Tiered cold restore/version/delete/touch on production paths require scope and no longer use unscoped internal helpers.
- [ ] ALS is populated from validated scope and mismatched/missing ALS cannot widen access.
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds.
- [ ] Targeted store/session integration tests pass.

**Test Strategy**:

- Unit: facade/locator helpers, store mocks updated to current interface
- Integration: Redis store, tiered store, session-service, conversation-store ALS behavior
- E2E: session create/resume flows continue to work through converted boundaries

**Rollback**: Keep compatibility wrappers in `ScopedSessionFacade`, revert converted callers to `warn` mode, and keep privileged internal cold-store helpers available for migration/admin use.

---

### Phase 3: Canonical Subject / Actor Semantics in Shared Services

**Goal**: Make ownership, auth profiles, model resolution, transfer semantics, and memory agree on canonical subject/actor meaning.

**Tasks**:
3.1. Replace legacy `customerId` / `channelArtifact` / `anonymousId` ownership priority logic in `packages/shared-auth` with canonical subject/actor evaluation plus explicit policy checks.
3.2. Feed auth-profile preflight, tool-auth resolution, and session-scoped OAuth cleanup from canonical actor/auth-scope inputs.
3.3. Preserve the model-resolution contract while shifting full resolution callers to canonical actor scope and keeping reasoning-settings cache keys free of human subject dimensions.
3.4. Move human cross-session memory to contact-backed ownership, with compatibility-read fallback for legacy `userId`-owned facts; keep actor/debug/service-principal memory explicit and separate.
3.5. Update agent-transfer/handoff adapters so canonical `contactId` remains authoritative and provider aliases remain transport metadata only.
3.6. Add or tighten tests covering session ownership, auth-profile propagation, model-resolution cache invariants, memory ownership separation, and transfer alias handling.

**Files Touched**:

- `packages/shared-auth/src/middleware/session-ownership.ts` — canonical ownership evaluator
- `apps/runtime/src/services/auth-profile/auth-preflight.ts` — actor-auth semantics
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` — canonical actor inputs
- `apps/runtime/src/services/tool-oauth-service.ts` — session principal cleanup
- `apps/runtime/src/services/llm/model-resolution.ts` — actor-scoped caller inputs
- `apps/runtime/src/services/llm/model-resolution-versioning.ts` — explicit contract guardrails
- `apps/runtime/src/services/execution/memory-executor.ts` — contact-backed ownership
- `apps/runtime/src/services/execution/tool-memory-bridge.ts` — lane separation
- `apps/runtime/src/services/contact-context-service.ts` — human memory continuity
- `apps/runtime/src/services/agent-transfer/index.ts` — canonical contact authority
- `packages/agent-transfer/src/session/types.ts` — explicit canonical subject metadata
- `apps/runtime/src/__tests__/auth/session-ownership-authz.test.ts` — ownership coverage
- `apps/runtime/src/__tests__/auth/auth-profile-propagation.test.ts` — auth-profile coverage
- `apps/runtime/src/__tests__/model-resolution-versioning.test.ts` — cache contract preservation
- `apps/runtime/src/__tests__/memory-integration.test.ts` / `mongodb-fact-store-scope.test.ts` — memory ownership migration
- `apps/runtime/src/__tests__/agent-transfer-*.test.ts` — provider alias handling

**Exit Criteria**:

- [ ] Session ownership, list filters, resume/delete/read checks use canonical subject/actor semantics on converted paths.
- [ ] Auth-profile resolution no longer depends on overloaded session `userId` or human subject identity.
- [ ] Existing model-resolution cache/versioning tests remain green without adding human-subject identity to reasoning-settings keys.
- [ ] Human memory writes are contact-backed; actor/debug/service-principal memory remains isolated.
- [ ] Agent-transfer tests prove provider aliases never replace canonical `contactId`.

**Test Strategy**:

- Unit: ownership evaluator, auth-profile helper changes, memory owner-key helpers
- Integration: auth-profile propagation, memory fact store scope, transfer adapter behavior
- E2E: SDK/session resume and guest/contact continuity scenarios should continue to pass with new ownership semantics

**Rollback**: Re-enable legacy ownership evaluation and compatibility-read memory paths via flags while keeping additive diagnostics in place.

---

### Phase 4A: Diagnostics, Studio, Reporting, and Compliance Workstream

**Goal**: Surface canonical scope safely to operators, Studio, reporting, and GDPR/retention flows without blocking the core runtime contract rollout.

**Tasks**:
4.1. Implement `ScopeDiagnosticsService` and add `scopeDiagnostics` to runtime/admin session-detail responses.
4.2. Update trace emitters/readers, eventstore/audit summaries, and admin/reporting surfaces to use canonical `scopeKind`, `subjectKind`, `actorKind`, `authType`, `source`, `migrationStatus`, and `compatibilityPathUsed` dimensions.
4.3. Update Studio proxy routes, hooks, and session detail UI to render additive diagnostics rather than infer identity from legacy fields.
4.4. Update retention, GDPR, archive, and export flows to resolve subjects canonically, keeping only a bounded legacy scan for migration compatibility.
4.5. Add or tighten tests for Studio proxy responses, admin traces, reporting dimensions, and GDPR/retention subject resolution.

**Files Touched**:

- `apps/runtime/src/services/session/scope-diagnostics-service.ts` — new canonical payload builder
- `apps/runtime/src/services/trace/emit-to-eventstore.ts` — diagnostics dimensions
- `apps/runtime/src/services/trace/clickhouse-session-trace-events.ts` — historical replay fields
- `apps/runtime/src/routes/admin-sessions.ts` — operator read model
- `apps/runtime/src/routes/platform-admin-traces.ts` — privacy-safe subject/actor summary
- `apps/studio/src/app/api/runtime/sessions/[id]/route.ts` — diagnostics proxy
- `apps/studio/src/app/api/runtime/sessions/[id]/traces/route.ts` — trace replay proxy
- `apps/studio/src/hooks/useSessionDetail.ts` — diagnostics typing
- `apps/studio/src/components/session/SessionDetailPage.tsx` — additive diagnostics rendering
- `apps/studio/src/services/retention/mongo-gdpr-store.ts` — canonical subject lookup
- `apps/studio/src/services/retention/retention-service.ts` — compatibility scan bounds

**Exit Criteria**:

- [ ] Session detail responses expose canonical `scopeDiagnostics`.
- [ ] Live and historical traces share the same privacy-safe canonical subject/actor summary fields.
- [ ] Studio session detail renders additive diagnostics without needing legacy identity fields as the primary source.
- [ ] Retention/GDPR/archive/export paths use canonical subject semantics plus bounded compatibility scanning.
- [ ] Targeted Studio/runtime/admin tests pass.

**Test Strategy**:

- Unit: diagnostics summary builders and redaction helpers
- Integration: session detail/admin trace/reporting routes, GDPR store resolution
- E2E: Studio proxy detail + trace scenarios from the test spec

**Rollback**: Keep diagnostics additive and feature-flagged. Studio can ignore `scopeDiagnostics` while runtime/admin continue to expose compatibility-safe legacy fields during rollback.

---

### Phase 4B: Encryption & DEK Alignment Workstream

**Goal**: Align project-scoped session artifacts with project/environment DEKs while preserving tenant-scoped contact crypto as an explicit exception.

**Tasks**:
4.1. Add a runtime encryption-scope matrix and classifier for session-adjacent artifacts.
4.2. Update Redis session encryption, queue payload encryption, agent-transfer session-field encryption, and ClickHouse/session-event encryption to resolve project/environment DEKs for project-scoped production session artifacts.
4.3. Preserve tenant-scoped contact identity crypto and crypto-shredding semantics as a documented exception.
4.4. Implement migration/re-encryption utilities and compatibility counters for legacy tenant-scoped ciphertext backing project-scoped session artifacts.
4.5. Emit auditable `projectId`, `environment`, `dekId`, and compatibility-path metadata for rollout monitoring.

**Files Touched**:

- `apps/runtime/src/services/session/redis-session-store.ts` — project-scoped session crypto
- `apps/runtime/src/services/message-persistence-queue.ts` — scoped queue encryption metadata
- `apps/runtime/src/services/agent-transfer/index.ts` — scoped transfer crypto inputs
- `packages/agent-transfer/src/security/session-field-encryption.ts` — project-scoped DEK resolution
- `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts` — session-event crypto alignment
- `apps/runtime/src/services/kms/kms-audit-logger.ts` — rollout audit dimensions
- `packages/database/src/migrations/<timestamp>_session_scope_reencrypt.ts` — re-encryption / quarantine migration

**Exit Criteria**:

- [ ] No new project-scoped production session artifact writes depend on tenant-scoped DEK convenience wrappers.
- [ ] Contact identity crypto remains tenant-scoped and explicitly tested as such.
- [ ] KMS audit surfaces expose `projectId`, `environment`, `dekId`, and compatibility-path metadata for session-scope rollout monitoring.
- [ ] Re-encryption/quarantine logic exists for legacy ciphertext classifications.

**Test Strategy**:

- Unit: DEK scope selection helpers, encryption-scope classifier
- Integration: queue/session/transfer/clickhouse crypto wiring, KMS audit assertions
- Manual: rollout dashboard validation for compatibility counters and audit rows

**Rollback**: Keep compatibility decrypt path enabled while pausing re-encryption jobs and forcing new writes back to `warn` mode if rollout metrics regress.

---

### Phase 5: Debug/System Split, Migration, and Rollout Closure

**Goal**: Complete discriminated debug/system contracts, migrate legacy data safely, and remove compatibility paths once rollout metrics allow it.

**Tasks**:
5.1. Introduce `DebugExecutionScope` and `SystemExecutionScope` handling in debug/session bootstrap, system jobs, and related worker entry points.
5.2. Update debug resume and system worker flows so missing scope never acts as control flow.
5.3. Run additive backfill for durable sessions, cold-store rows, and message artifacts; quarantine or age out rows that cannot be classified safely.
5.4. Use the bounded queue repair lane only for pre-enforcement artifacts, with telemetry and retirement criteria.
5.5. Remove unscoped production-path helpers and legacy `userId`-based compatibility paths once compatibility counters trend to zero.
5.6. Rehearse rollout `audit -> warn -> enforce` and rollback `enforce -> warn`, then finalize docs/test matrix sync.

**Files Touched**:

- `apps/runtime/src/services/debug-integration.ts` — debug scope discriminants
- `apps/runtime/src/channels/pipeline/session-factory.ts` — debug/system split completion
- `apps/runtime/src/websocket/handler.ts` — debug resume handling
- `apps/runtime/src/services/session/session-scope-migration.ts` — backfill / quarantine helpers
- `packages/database/src/migrations/<timestamp>_session_scope_backfill.ts` — additive migration
- `apps/runtime/src/services/message-persistence-queue.ts` — bounded repair-lane retirement
- `apps/runtime/src/services/session/tiered-session-store.ts` / `session-state-repo.ts` — cleanup of remaining compatibility helpers
- `docs/features/sub-features/session-scope-enforcement.md` — implementation sync
- `docs/testing/sub-features/session-scope-enforcement.md` — coverage status sync

**Exit Criteria**:

- [ ] Debug/system entry points use explicit discriminants and wrong-kind payloads fail closed.
- [ ] Backfillable legacy rows are migrated; unsafe rows are quarantined or expired according to the approved policy.
- [ ] Compatibility-path usage is near zero and repair-lane traffic is bounded and observable.
- [ ] Forward rollout (`audit -> warn -> enforce`) and rollback (`enforce -> warn`) are both exercised successfully.
- [ ] Targeted runtime/database builds succeed, followed by repo-level `pnpm build` before broader test execution.

**Test Strategy**:

- Unit: discriminant validation, migration classifiers
- Integration: rollback mode transitions, repair-lane behavior, migration utilities
- E2E: wrong-scope-kind rejection, migrated-session resume, Studio diagnostics, rollback scenarios

**Rollback**: Change `SESSION_SCOPE_ENFORCEMENT_MODE` back to `warn`, pause migrations and re-encryption jobs, and retain compatibility readers until the incident is understood. No destructive schema rollback is planned.

---

## 5. Wiring Checklist

- [ ] Export new scope contracts and facade from `apps/runtime/src/services/session/index.ts`
- [ ] Register `ExecutionScopeFactory`, `ScopePolicy`, `ScopedSessionFacade`, and `ScopeDiagnosticsService` in the runtime service wiring
- [ ] Update `routes/chat.ts`, `websocket/handler.ts`, `websocket/sdk-handler.ts`, and `websocket/twilio-media-handler.ts` to call `ExecutionScopeFactory` before session creation
- [ ] Update `channels/pipeline/session-factory.ts` and `services/session/session-bootstrap.ts` to accept validated scope inputs instead of optional identity fragments
- [ ] Update queue producers (`message-pipeline.ts`, websocket handlers, route handlers) to pass `ScopedPersistenceEnvelope`
- [ ] Update `SessionStore` mocks and tests everywhere the interface changes (`load`, `getVersion`, `delete`, `touch`, lock operations)
- [ ] Wire `scopeDiagnostics` into runtime session detail/admin routes, then into Studio proxy routes/hooks/components
- [ ] Update shared-auth session ownership middleware and any session list filters to consume canonical subject/actor semantics
- [ ] Feed auth-profile preflight/tool-auth/tool-oauth cleanup from canonical actor/auth-scope helpers
- [ ] Update memory bridges and fact-store owner-key helpers to separate contact, actor, and session lanes
- [ ] Update eventstore/trace/admin/reporting emitters and readers to persist the new dimensions
- [ ] Register/add migration scripts for additive backfill and DEK re-encryption classification
- [ ] Update OpenAPI / response-contract docs for stable invalid-scope error envelopes where those routes are documented

---

## 6. Cross-Phase Concerns

### Database Migrations

- Additive durable-session fields are expected on `packages/database/src/models/session.model.ts`:
  - `scopeKind`
  - `scopeVersion`
  - `subject`
  - `actor`
  - `identityEvidenceSummary`
  - `channelId`
  - `source`
  - `authType`
  - `environment`
  - `traceId`
  - `migrationStatus`
  - `compatibilityPathUsed`
- Additive message/cold-store classification fields should support backfill visibility and quarantine.
- No legacy identity fields (`customerId`, `anonymousId`, `initiatedById`, etc.) should be dropped before Phase 5 cleanup and rollback drills are complete.
- Migration scripts must be idempotent and safe to re-run.

### Feature Flags

| Flag                                 | Default | Phase | Purpose                                                          |
| ------------------------------------ | ------- | ----- | ---------------------------------------------------------------- |
| `SESSION_SCOPE_ENFORCEMENT_MODE`     | `audit` | 1     | Central rollout mode: `audit`, `warn`, `enforce`                 |
| `SESSION_SCOPE_COMPAT_READS_ENABLED` | `true`  | 2     | Keep bounded compatibility readers while storage callers migrate |
| `SESSION_SCOPE_QUEUE_REPAIR_ENABLED` | `true`  | 1     | Allow bounded pre-enforcement repair lane only during migration  |
| `SESSION_SCOPE_DIAGNOSTICS_ENABLED`  | `true`  | 4A    | Gate additive diagnostics payload exposure if needed             |
| `SESSION_SCOPE_DEK_COMPAT_MODE`      | `warn`  | 4B    | Track compatibility decrypts before strict DEK enforcement       |

### Configuration Changes

- No new third-party dependencies are planned.
- Runtime/config surfaces need one new enforcement-mode config and optional compatibility flags.
- Metrics/logging dimensions should be standardized for:
  - `scope_validation_failure`
  - `compatibility_path_used`
  - `migration_status`
  - `subject_kind`
  - `actor_kind`
  - `scope_kind`
  - `dek_scope_classification`

### Performance Budget

- Boundary scope construction should target less than 50 ms incremental p95 overhead on HTTP/WebSocket bootstrap, excluding external verification hops.
- Contact resolution should remain a single resolve-or-create operation on converted production paths.
- Queue enqueue should stay O(1) relative to payload size after the scoped envelope replaces partial-scope repair logic.
- Diagnostics payloads must be derived from additive summaries or projections, not reconstructed by scanning raw session artifacts on every read.

### Related Plans / Dependency Notes

- [docs/plans/2026-04-02-integration-auth-profiles-impl-plan.md](2026-04-02-integration-auth-profiles-impl-plan.md) is the relevant auth-profile precedent; session scope enforcement should reuse its actor/auth ownership direction rather than inventing a second one.
- [docs/plans/2026-03-22-omnichannel-session-continuity-impl-plan.md](2026-03-22-omnichannel-session-continuity-impl-plan.md) already assumes project-scoped recall/live-session semantics around `contactId`; session scope enforcement should strengthen that foundation, not fork it.
- [docs/plans/2026-03-14-web-sdk-jwt-jwe-auth.md](2026-03-14-web-sdk-jwt-jwe-auth.md) is historical, but its warning about self-declared SDK `userContext.userId` reinforces the client-contract deprecation already approved in this feature.

---

## 7. Acceptance Criteria (Whole Feature)

- [ ] All core phases (1, 2, 3, 5) complete with their exit criteria met
- [ ] Sibling workstreams (4A, 4B) are either complete or explicitly split into approved follow-on sub-features without blocking core boundary enforcement
- [ ] E2E and integration scenarios from [docs/testing/sub-features/session-scope-enforcement.md](../testing/sub-features/session-scope-enforcement.md) are implemented or explicitly tracked with status updates
- [ ] No production session-create path accepts missing `projectId` or wrong scope kind
- [ ] No production hot/cold store path relies on bare `sessionId` or empty-tenant fallback
- [ ] Queue enqueue requires full production scope and durable provenance on steady-state paths
- [ ] Session detail/admin/Studio surfaces expose canonical `scopeDiagnostics`
- [ ] Auth-profile, model-resolution, and memory ownership semantics align with canonical actor/subject contracts
- [ ] Project-scoped session artifacts use project/environment DEKs or are explicitly tracked through compatibility metrics and migration state
- [ ] Rollout and rollback drills (`audit -> warn -> enforce` and `enforce -> warn`) are documented and executed successfully
- [ ] Targeted runtime/database builds pass, followed by repo-level `pnpm build` before broader test execution
- [ ] Feature spec, HLD, testing spec, and SDLC logs are synced after implementation

---

## 8. FR-to-Phase Traceability

| FR Group                                 | Covered In |
| ---------------------------------------- | ---------- |
| FR-1, FR-2, FR-3, FR-7, FR-11, FR-12     | Phase 1    |
| FR-4, FR-5, FR-6, FR-8                   | Phase 2    |
| FR-14, FR-15, FR-16, FR-22, FR-23, FR-24 | Phase 3    |
| FR-13, FR-17, FR-18                      | Phase 4A   |
| FR-19, FR-20, FR-21                      | Phase 4B   |
| FR-9, FR-10                              | Phase 5    |

---

## 9. Open Operational Questions

1. Should voice coverage start as high-fidelity integration tests if CI harness reliability is still shaky, then graduate to full E2E later?
2. Which reporting surface should be the canonical rollout assertion point for `subjectKind`, `actorKind`, and `compatibilityPathUsed`: admin session detail, ClickHouse validation queries, or a dedicated dashboard check?
3. Which DEK rollout-health signal should be primary for go/no-go decisions: KMS audit rows, `dek_registry`, compatibility counters, or a combined dashboard?
