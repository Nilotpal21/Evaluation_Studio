# LLD: Priority 0 Session Provenance and Continuity Hardening

**Feature Specs**:

- `docs/features/sub-features/session-scope-enforcement.md`
- `docs/features/identity-verification.md`
- `docs/features/omnichannel-session-continuity.md`

**HLDs**:

- `docs/specs/session-scope-enforcement.hld.md`
- `docs/specs/identity-verification.hld.md`
- `docs/specs/omnichannel-session-continuity.hld.md`

**Testing Guides**:

- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/testing/identity-verification.md`
- `docs/testing/omnichannel-session-continuity.md`

**Prior LLDs**:

- `docs/plans/session-scope-enforcement.lld.md`
- `docs/plans/identity-verification.lld.md`
- `docs/plans/2026-03-22-omnichannel-session-continuity-impl-plan.md`

**Status**: DRAFT
**Date**: 2026-04-23

---

## 1. Why this plan exists

The three approved feature tracks now share one critical-path problem: runtime continuity still does not have a single durable provenance lane that survives boundary validation, verification, session resolution, omnichannel recall, auth ownership, and memory ownership without lossy reconstruction.

The separate feature LLDs are still useful, but they no longer isolate the Priority 0 execution path cleanly:

- `session-scope-enforcement` owns the canonical execution/scope contract.
- `identity-verification` owns the durable proof and resolution records.
- `omnichannel-session-continuity` consumes those records to authorize recall and live-session joins.

This plan exists to cut across those LLDs and define the smallest end-to-end slice that is good enough for future-ready signoff.

## 1.1. Current source snapshot (2026-04-23)

The repo has already landed meaningful groundwork:

- `apps/runtime/src/services/session/execution-scope.ts` and `apps/runtime/src/services/session/execution-scope-factory.ts` already define validated execution-scope contracts.
- `packages/database/src/models/session.model.ts` already persists `sessionPrincipalId`, `verifiedIdentity`, `attachedParticipants`, and `liveSyncState`.
- `apps/runtime/src/server.ts` already mounts both `/api/projects/:projectId/omnichannel` and `/api/identity/verify`.
- `apps/runtime/src/routes/omnichannel.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, and `packages/web-sdk/src/core/SessionManager.ts` already expose the basic omnichannel HTTP and SDK/WebSocket surfaces.

The remaining Priority 0 gaps are narrower, but they are still architectural blockers:

- `ProductionExecutionScope` does not carry a first-class `sessionPrincipalId`; some runtime paths still infer it from `callerContext`, `anonymousId`, or even `sessionId`.
- identity verification attempts and resolution records are still tenant-scoped and mostly `sessionId`-only (`verification-attempt.ts`, `session-resolution-key.ts`, `resolution-key-store.ts`).
- verification status reads in `routes/identity-verification.ts` only prove `tenantId`, not `projectId + sessionPrincipalId`.
- auth, tool OAuth, and durable memory still overload `userId` in places where the real owner is `contactId` or `sessionPrincipalId`.
- `executeOmnichannelRecall()` exists in `apps/runtime/src/services/execution/memory-integration.ts`, but it is not wired into any runtime execution path yet.
- verification-to-contact linking is partly present, but continuity still mixes `sessionId`, `anonymousId`, `customerId`, and `sessionPrincipalId` across SDK bootstrap, rehydrate, and recall paths.

---

## 2. Design Decisions

### Decision Log

| #   | Decision                                                                                                                                        | Rationale                                                                                                                                                                   | Alternatives Rejected                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| D-1 | Treat Priority 0 as one integrated implementation slice across session scope, verification, and omnichannel.                                    | The gaps are on the seams, not inside any one subsystem. Closing them separately would keep reconstructing provenance at boundaries.                                        | Continue updating the three feature LLDs independently and hope the contracts converge in implementation. |
| D-2 | Make `sessionPrincipalId` first-class in canonical production scope and diagnostics.                                                            | `sessionId` identifies the conversation row; `sessionPrincipalId` identifies the continuity principal. They must not be reconstructed from each other.                      | Keep `sessionPrincipalId` only in `callerContext` or derive it from `anonymousId` / `sessionId`.          |
| D-3 | Upgrade verification persistence from tenant-scoped `attempt/sessionId` records to project-safe provenance records.                             | Omnichannel continuity and status reads need `tenantId + projectId + sessionPrincipalId` and durable proof metadata, not a bare tenant-scoped lookup.                       | Keep tenant-only Redis keys and repair project safety in downstream callers.                              |
| D-4 | Keep `contactId`, `sessionPrincipalId`, and platform `userId` as separate ownership lanes.                                                      | Durable human memory belongs to the contact; session-scoped auth artifacts belong to the session principal; operator auth remains platform-user scoped.                     | Continue writing all three concerns through `runtimeSession.userId`.                                      |
| D-5 | Treat current HTTP/WebSocket omnichannel mounting as already landed; use Priority 0 only for missing execution-time and provenance wiring.      | `server.ts`, `routes/omnichannel.ts`, and the SDK already expose the transport surfaces. Re-planning those mounts would be rework.                                          | Re-open route mounting and settings reachability as if they were still unimplemented.                     |
| D-6 | Keep compatibility reads for `anonymousId`, tenant-only verification keys, and `sessionId`-only continuity, but instrument them and bound them. | Rollout safety still matters, but compatibility lanes must be measurable and explicitly temporary.                                                                          | Remove every compatibility lane in one cut, or leave them indefinitely without counters.                  |
| D-7 | Wire omnichannel recall through the existing runtime memory/bootstrap path rather than creating a second orchestration lane.                    | `executeOmnichannelRecall()` already exists in `memory-integration.ts`; reusing that path keeps recall ordering aligned with other memory initialization.                   | Add a separate omnichannel recall hook in a parallel runtime path.                                        |
| D-8 | Keep the existing model-resolution contract intact while changing caller ownership inputs.                                                      | Full model resolution remains user-scoped; reasoning-settings caches must still exclude `userId`. Priority 0 changes who supplies the actor, not the cache contract itself. | Re-key reasoning-settings caches on `sessionPrincipalId` or `contactId`.                                  |

### Key Interfaces and Types

```typescript
interface ProductionExecutionScope {
  kind: 'production';
  tenantId: string;
  projectId: string;
  sessionId: string;
  sessionPrincipalId: string;
  channelId: string;
  environment: string;
  source: string;
  authType: string;
  traceId: string;
  actor: SessionActor;
  subject: SessionSubject;
  identityEvidence: {
    identityTier: 0 | 1 | 2;
    verificationMethod: string;
    verificationAttemptId?: string;
    policySource?: string;
    grantScope?: string;
    verifiedAt?: string;
    artifacts: Array<{ type: string; valueHash: string }>;
  };
  callerContext: Record<string, unknown>; // compatibility-only shadow, not source of truth
}

interface VerificationAttemptRecord {
  id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  sessionPrincipalId: string;
  method: string;
  identityValue: string;
  identityType: string;
  status: 'pending' | 'verified' | 'expired' | 'failed';
  attempts: number;
  maxAttempts: number;
  policySource: string;
  grantScope: string;
  traceId: string;
  createdAt: Date;
  expiresAt: Date;
}

interface SessionResolutionRecord {
  tenantId: string;
  projectId: string;
  channelId: string;
  artifactHash: string;
  sessionLocator: { tenantId: string; projectId: string; sessionId: string };
  sessionPrincipalId: string;
  verificationAttemptId?: string;
  verificationMethod: string;
  identityTier: 0 | 1 | 2;
  policySource: string;
  grantScope: string;
  verifiedAt: Date;
  traceId: string;
  expiresAt: Date;
}

type DurableMemoryOwner =
  | { kind: 'contact'; id: string }
  | { kind: 'session_principal'; id: string }
  | { kind: 'platform_user'; id: string }
  | { kind: 'project'; id: string };
```

### Module Boundaries

| Module                                              | Responsibility                                                                                 | Depends On                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `services/session/*`                                | Canonical execution scope, diagnostics, and compatibility counters                             | shared-auth caller context, runtime session bootstrap         |
| `contexts/identity/*`                               | Verification attempts, status reads, proof completion, project-safe session-resolution records | Redis stores, session scope, trace/audit emitters             |
| `services/identity/*`                               | Contact linking, stored-session caller context rehydrate, SDK identity continuity              | contact context, session scope, verification resolution       |
| `services/execution/*`                              | Memory initialization, omnichannel recall wiring, auth/memory owner resolution                 | session scope, runtime session identity, omnichannel services |
| `services/auth-profile/*` + `tool-oauth-service.ts` | Session-vs-user auth ownership resolution                                                      | session scope actor inputs, auth profile stores               |
| `services/omnichannel/*` + Web SDK                  | Recall and live-session continuity consuming canonical provenance                              | resolution records, contact linking, WebSocket/HTTP routes    |

---

## 3. File-Level Change Map

### New Files

| File                                                                                       | Purpose                                                                     | LOC Estimate |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/contexts/identity/domain/session-resolution-record.ts`                   | Canonical project-safe resolution record type and helpers                   | 80           |
| `apps/runtime/src/services/session/execution-owners.ts`                                    | Shared resolver for contact/session-principal/platform-user ownership lanes | 120          |
| `apps/runtime/src/__tests__/execution/contexts/identity/session-resolution-record.test.ts` | Domain/store regression coverage for project-safe resolution records        | 180          |
| `apps/runtime/src/__tests__/execution/session-principal-ownership.integration.test.ts`     | Integration coverage for auth + memory owner separation                     | 220          |
| `apps/runtime/src/__tests__/channels/omnichannel-provenance.e2e.test.ts`                   | End-to-end continuity proof from verification -> resolution -> recall/join  | 300          |

### Modified Files

| File                                                                                  | Change Description                                                                                                            | Risk   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/services/session/execution-scope.ts`                                | Add first-class `sessionPrincipalId` and provenance-bearing diagnostics fields                                                | High   |
| `apps/runtime/src/services/session/execution-scope-factory.ts`                        | Require/build `sessionPrincipalId` on canonical production scope                                                              | High   |
| `apps/runtime/src/services/session/production-contact-scope.ts`                       | Resolve required production scope without treating `callerContext` as the source of truth                                     | High   |
| `apps/runtime/src/services/session/runtime-session-identity.ts`                       | Stop overloading `runtimeSession.userId` for contact/session-principal identity and rewire fact stores by explicit owner type | High   |
| `apps/runtime/src/services/identity/stored-session-caller-context.ts`                 | Rehydrate stored continuity from explicit `sessionPrincipalId` fields, not `anonymousId` aliasing                             | Medium |
| `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`             | Return and persist project-safe resolution data plus explicit `sessionPrincipalId` on new/resumed sessions                    | High   |
| `apps/runtime/src/routes/sdk-init.ts`                                                 | Keep SDK bootstrap token issuance aligned with explicit session principal semantics                                           | Medium |
| `apps/runtime/src/websocket/sdk-handler.ts`                                           | Consume `sessionPrincipalId` as first-class continuity principal and stop falling back to `sessionId` where not safe          | High   |
| `apps/runtime/src/routes/identity-verification.ts`                                    | Enforce `tenantId + projectId + sessionPrincipalId` on status reads and propagate provenance on initiate/complete             | High   |
| `apps/runtime/src/contexts/identity/domain/verification-attempt.ts`                   | Expand attempts with `projectId`, `sessionPrincipalId`, `policySource`, `grantScope`, `traceId`                               | High   |
| `apps/runtime/src/contexts/identity/domain/session-resolution-key.ts`                 | Replace or wrap the old key-only contract with project-safe `SessionResolutionRecord` helpers                                 | High   |
| `apps/runtime/src/contexts/identity/infrastructure/verification-token-store.ts`       | Update store contract to fetch/mutate provenance-bearing attempt records                                                      | High   |
| `apps/runtime/src/contexts/identity/infrastructure/redis-verification-token-store.ts` | Persist and deserialize the expanded attempt record shape                                                                     | High   |
| `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts`           | Persist full resolution records instead of bare `sessionId` values                                                            | High   |
| `apps/runtime/src/contexts/identity/use-cases/resolve-session.ts`                     | Return `SessionResolutionRecord`, not just `{ sessionId }`                                                                    | High   |
| `apps/runtime/src/contexts/identity/use-cases/register-resolution-key.ts`             | Register project-safe resolution records                                                                                      | Medium |
| `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`               | Register verification provenance and make contact-linking idempotent/backfill-safe                                            | Medium |
| `apps/runtime/src/services/identity/channel-contact-linking.ts`                       | Close the pre-link/post-link race and align session updates with verified contact outcomes                                    | High   |
| `apps/runtime/src/services/execution/memory-integration.ts`                           | Wire omnichannel recall into the actual initialization flow and make owner lanes explicit                                     | High   |
| `apps/runtime/src/services/runtime-executor.ts`                                       | Call omnichannel recall during runtime memory/bootstrap initialization                                                        | High   |
| `apps/runtime/src/services/execution/agent-activation-context.ts`                     | Pass explicit owner inputs into memory/bootstrap initialization                                                               | Medium |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`                         | Resolve session-scoped auth via explicit session principal instead of overloaded `userId`                                     | High   |
| `apps/runtime/src/services/tool-oauth-service.ts`                                     | Keep session-scoped artifacts owned by session principal while preserving tenant/shared modes                                 | High   |
| `apps/runtime/src/services/execution/llm-wiring.ts`                                   | Preserve full user-scoped resolution while sourcing the correct actor inputs from canonical scope                             | Medium |
| `apps/runtime/src/services/stores/mongodb-fact-store.ts`                              | Make durable human memory explicitly contact-owned and keep session-principal/project stores separate                         | High   |
| `packages/database/src/models/session.model.ts`                                       | Persist additive provenance summary fields needed for rehydrate/diagnostics                                                   | Medium |
| `packages/database/src/models/message.model.ts`                                       | Preserve additive provenance fields needed for recall/linking backfill                                                        | Medium |
| `packages/web-sdk/src/core/SessionManager.ts`                                         | Keep discover/join flows aligned with any response-shape changes in continuity records                                        | Medium |
| `packages/web-sdk/src/ui/UnifiedWidget.ts`                                            | Preserve live join UX if discovery/join payloads gain provenance metadata                                                     | Low    |

### Files intentionally not part of Priority 0

These are already wired or already present enough that Priority 0 should not spend time redoing them:

- `apps/runtime/src/server.ts` route mounting for omnichannel and identity verification
- `apps/runtime/src/routes/omnichannel.ts` transport surface
- `apps/studio/src/app/api/projects/[id]/omnichannel/route.ts`
- `apps/studio/src/app/api/projects/[id]/omnichannel/audit/route.ts`
- `apps/studio/src/components/projects/OmnichannelSettingsPanel.tsx`

---

## 4. Implementation Phases

Each phase must land green. Red-first test authoring is still required on-branch, but merge only happens after the corresponding build/test gates pass.

### Phase 1: Canonical Session Principal Contract

**Goal**: make `sessionPrincipalId` part of the canonical runtime scope instead of a caller-context-only shadow field.

**Tasks**:

1.1. Add `sessionPrincipalId` to `ProductionExecutionScope`, `ScopeDiagnostics`, and any typed session-locator summaries that feed rehydrate or operator views.
1.2. Update `execution-scope-factory.ts` and `production-contact-scope.ts` so canonical production scope cannot be built without a real session principal.
1.3. Update `runtime-session-identity.ts` and `stored-session-caller-context.ts` so compatibility reads can still accept old `anonymousId` inputs, but steady-state runtime logic does not infer ownership from them.
1.4. Update `initialize-session.ts`, `sdk-init.ts`, and `sdk-handler.ts` so new sessions, resumed sessions, and SDK-issued tokens all propagate the same principal field explicitly.
1.5. Add compatibility counters/logging for the remaining paths that still fall back to `anonymousId`, `sessionId`, or `callerContext.sessionPrincipalId`.

**Files Touched**:

- `apps/runtime/src/services/session/execution-scope.ts`
- `apps/runtime/src/services/session/execution-scope-factory.ts`
- `apps/runtime/src/services/session/production-contact-scope.ts`
- `apps/runtime/src/services/session/runtime-session-identity.ts`
- `apps/runtime/src/services/identity/stored-session-caller-context.ts`
- `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`
- `apps/runtime/src/routes/sdk-init.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/__tests__/session-scope-factory.test.ts`
- `apps/runtime/src/__tests__/session/runtime-session-identity.test.ts`
- `apps/runtime/src/__tests__/sessions/session-identity-integration.test.ts`

**Exit Criteria**:

- [ ] `ProductionExecutionScope` requires `sessionPrincipalId` everywhere on the production path.
- [ ] Resumed sessions no longer rely on `anonymousId -> sessionPrincipalId` as the primary mapping.
- [ ] SDK bootstrap, WS connect, and runtime session bootstrap all emit the same principal value.
- [ ] Compatibility counters exist for every remaining fallback path.

**Test Strategy**:

- Unit: scope factory, stored caller-context rehydrate, runtime identity owner resolution
- Integration: SDK bootstrap -> WS connect -> runtime session rehydrate preserves `sessionPrincipalId`

**Rollback**:

- Keep compatibility reads in place and gate strict enforcement behind the existing scope policy mode until fallback counters are near zero.

---

### Phase 2: Verification Provenance and Project-Safe Resolution Records

**Goal**: make verification attempts, status reads, and session resolution durable, project-safe, and provenance-bearing.

**Tasks**:

2.1. Expand `VerificationAttempt` and `StoredVerificationAttempt` with `projectId`, `sessionPrincipalId`, `policySource`, `grantScope`, and `traceId`.
2.2. Introduce `SessionResolutionRecord` and update Redis storage so the resolution layer returns `{ sessionLocator, sessionPrincipalId, verificationAttemptId, verificationMethod, identityTier, policySource, grantScope, verifiedAt, traceId }`.
2.3. Update `routes/identity-verification.ts` so `GET /:attemptId` enforces `tenantId + projectId + sessionPrincipalId`, with a separate explicit privileged internal-service lane if needed.
2.4. Update verification completion + `promote-and-link.ts` so successful proofs register the resolution record and emit trace/audit provenance.
2.5. Add compatibility readers for the old tenant-scoped `sessionId`-only keys and instrument their usage.

**Files Touched**:

- `apps/runtime/src/routes/identity-verification.ts`
- `apps/runtime/src/contexts/identity/domain/verification-attempt.ts`
- `apps/runtime/src/contexts/identity/domain/session-resolution-key.ts`
- `apps/runtime/src/contexts/identity/domain/session-resolution-record.ts`
- `apps/runtime/src/contexts/identity/infrastructure/verification-token-store.ts`
- `apps/runtime/src/contexts/identity/infrastructure/redis-verification-token-store.ts`
- `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts`
- `apps/runtime/src/contexts/identity/use-cases/resolve-session.ts`
- `apps/runtime/src/contexts/identity/use-cases/register-resolution-key.ts`
- `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`
- `apps/runtime/src/__tests__/execution/contexts/identity/identity-e2e-http.test.ts`
- `apps/runtime/src/__tests__/execution/contexts/identity/resolution-key-store.test.ts`
- `apps/runtime/src/__tests__/execution/contexts/identity/session-resolution-record.test.ts`

**Exit Criteria**:

- [ ] Verification attempts persist `projectId` and `sessionPrincipalId`.
- [ ] Wrong-project and wrong-session-principal status reads return non-leaky `404`.
- [ ] Session resolution returns a full `SessionResolutionRecord`, not a bare `sessionId`.
- [ ] Verification completion emits durable trace/audit provenance fields.

**Test Strategy**:

- Unit: record serialization/deserialization, resolution-record builders
- Integration: initiate -> complete -> status -> resolve-session with project-safe and wrong-principal assertions
- E2E: HTTP verification routes reject wrong-project and wrong-session-principal callers

**Rollback**:

- Dual-read old Redis key shapes while new records are being written; remove fallback only after counters and TTL expiration prove the old keys are gone.

---

### Phase 3: Auth and Memory Ownership Separation

**Goal**: stop using `runtimeSession.userId` as the catch-all owner for human memory, session-scoped auth, and platform-user actions.

**Tasks**:

3.1. Introduce a shared execution-owner resolver that returns `contactOwner`, `sessionPrincipalOwner`, and `platformUserOwner` explicitly from canonical scope/runtime state.
3.2. Update `runtime-session-identity.ts` and `mongodb-fact-store.ts` so durable human memory is contact-owned, session memory is session-principal-owned, and project memory stays project-scoped.
3.3. Update `resolve-tool-auth.ts` and `tool-oauth-service.ts` so session-scoped auth uses `sessionPrincipalId`, while shared/per-user auth keeps the existing user-scope semantics.
3.4. Update `llm-wiring.ts` to keep full model resolution user-scoped while taking the correct actor inputs from the new ownership resolver.
3.5. Add regression coverage so reasoning-settings cache keys remain user-free while full resolution still keys on the user-scoped actor as required by the model-resolution contract.

**Files Touched**:

- `apps/runtime/src/services/session/runtime-session-identity.ts`
- `apps/runtime/src/services/session/execution-owners.ts`
- `apps/runtime/src/services/stores/mongodb-fact-store.ts`
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`
- `apps/runtime/src/services/tool-oauth-service.ts`
- `apps/runtime/src/services/execution/llm-wiring.ts`
- `apps/runtime/src/__tests__/memory-scope-runtime.test.ts`
- `apps/runtime/src/__tests__/memory-scope-integration.test.ts`
- `apps/runtime/src/__tests__/auth/session-principal-ownership.integration.test.ts`
- `apps/runtime/src/__tests__/model-resolution-versioning.test.ts`

**Exit Criteria**:

- [ ] Durable human facts are keyed by `contactId`, not by `sessionPrincipalId` or legacy `userId` aliases.
- [ ] Session-scoped tool auth is keyed by `sessionPrincipalId`.
- [ ] Full model resolution remains user-scoped; reasoning-settings caches remain user-free.
- [ ] No new runtime path writes mixed ownership state back through `runtimeSession.userId` without an explicit compatibility reason.

**Test Strategy**:

- Unit: owner resolution, auth scope policy, fact-store owner filters
- Integration: session-scoped OAuth and contact-backed memory coexist without key collisions
- Regression: model-resolution contract suite

**Rollback**:

- Keep compatibility reads for legacy `userId`-owned artifacts and add counters so they can be retired gradually.

---

### Phase 4: Omnichannel Continuity and Linking Closure

**Goal**: consume the new provenance contract end-to-end for recall and live-session continuity, and close the verification-to-contact race.

**Tasks**:

4.1. Update session resolution callers in `initialize-session.ts`, `session-resolver.ts`, and `sdk-handler.ts` to consume `SessionResolutionRecord`.
4.2. Wire `executeOmnichannelRecall()` into the actual runtime memory/bootstrap path from `runtime-executor.ts` / `agent-activation-context.ts`.
4.3. Make contact-linking/backfill idempotent and ordered so verification completion cannot race earlier message persistence or recall discovery.
4.4. Keep `packages/web-sdk/src/core/SessionManager.ts` and `packages/web-sdk/src/ui/UnifiedWidget.ts` compatible if recall/discovery/join payloads gain new provenance-bearing fields.
4.5. Add end-to-end proof that verification completion produces a project-safe resolution record, links the session/contact correctly, and authorizes recall/join off that record rather than tenant-only artifact matches.

**Files Touched**:

- `apps/runtime/src/services/identity/session-resolver.ts`
- `apps/runtime/src/services/identity/channel-contact-linking.ts`
- `apps/runtime/src/services/execution/memory-integration.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/execution/agent-activation-context.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `packages/web-sdk/src/core/SessionManager.ts`
- `packages/web-sdk/src/ui/UnifiedWidget.ts`
- `apps/runtime/src/__tests__/channels/omnichannel-identity-verification.e2e.test.ts`
- `apps/runtime/src/__tests__/channels/omnichannel-cross-channel.e2e.test.ts`
- `apps/runtime/src/__tests__/channels/omnichannel-provenance.e2e.test.ts`

**Exit Criteria**:

- [ ] `executeOmnichannelRecall()` runs during the real runtime initialization path when both agent IR and project settings allow it.
- [ ] Recall and live-session continuity consume project-safe resolution records instead of tenant-only `sessionId` lookups.
- [ ] Verification completion cannot leave messages/session continuity in a pre-link race state.
- [ ] SDK discover/join flows still work with the updated payloads.

**Test Strategy**:

- Integration: recall bootstrap from runtime executor
- E2E: verification -> contact link -> recall, plus verification -> live-session discover/join
- Browser smoke: live join prompt still renders in the widget

**Rollback**:

- Keep the old continuity lookup path behind a compatibility branch until the new `SessionResolutionRecord` write path is verified in production-like environments.

---

## 5. Suggested Ticket Cuts

| Slice  | Scope                                                      | Primary Files                                                                                                                  |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `P0-A` | Session principal contract and compatibility counters      | `services/session/*`, `stored-session-caller-context.ts`, `sdk-init.ts`, `sdk-handler.ts`                                      |
| `P0-B` | Verification provenance records and protected status reads | `routes/identity-verification.ts`, `contexts/identity/*`, `promote-and-link.ts`                                                |
| `P0-C` | Auth + memory ownership separation                         | `runtime-session-identity.ts`, `mongodb-fact-store.ts`, `resolve-tool-auth.ts`, `tool-oauth-service.ts`, `llm-wiring.ts`       |
| `P0-D` | Omnichannel continuity wiring and linking race closure     | `memory-integration.ts`, `runtime-executor.ts`, `channel-contact-linking.ts`, `session-resolver.ts`, `sdk-handler.ts`, Web SDK |

Recommended execution order:

1. `P0-A` first because every later slice needs the canonical principal contract.
2. `P0-B` second because omnichannel continuity must consume durable verification provenance, not the old tenant-only keys.
3. `P0-C` third because auth/memory ownership must be correct before we broaden continuity usage.
4. `P0-D` last because it is the consumer convergence slice and should not invent its own interim contracts.

---

## 6. Wiring Checklist

- [ ] `sdk-init.ts` issues `sessionPrincipalId` distinctly from `sessionId` and `sdk-handler.ts` preserves it through WS auth state.
- [ ] `initialize-session.ts` writes project-safe `SessionResolutionRecord` data for new sessions and consumes it for resumed sessions.
- [ ] `routes/identity-verification.ts` passes `projectId + sessionPrincipalId` into store lookups and completion handlers.
- [ ] `promote-and-link.ts` updates the session/contact link and resolution record atomically enough for downstream continuity reads.
- [ ] `runtime-executor.ts` or `agent-activation-context.ts` calls `executeOmnichannelRecall()` before agent execution consumes memory state.
- [ ] `resolve-tool-auth.ts`, `tool-oauth-service.ts`, and `llm-wiring.ts` all receive explicit owner inputs from the same resolver.
- [ ] Web SDK live-session discovery/join still round-trips through the updated runtime payload shapes.

---

## 7. Acceptance Criteria (Whole Priority 0 Slice)

- [ ] Canonical production scope includes `sessionPrincipalId`, and diagnostics expose it without reconstructing from aliases.
- [ ] Verification attempts and session resolution are project-safe and provenance-bearing.
- [ ] Status reads enforce `tenantId + projectId + sessionPrincipalId`, with only explicit privileged contracts bypassing that requirement.
- [ ] Durable human memory, session-scoped auth, and platform-user actions no longer share one overloaded `userId` lane.
- [ ] Omnichannel recall is wired into the real runtime execution path and consumes the same provenance contract as live-session continuity.
- [ ] Verification completion -> contact linking -> recall/join has deterministic end-to-end coverage.
- [ ] `pnpm build --filter=runtime`
- [ ] `pnpm build --filter=web-sdk`
- [ ] `pnpm test --filter=runtime -- session-scope`
- [ ] `pnpm test --filter=runtime -- execution/contexts/identity`
- [ ] `pnpm test --filter=runtime -- omnichannel`

---

## 8. Open Questions

1. The privileged internal-service bypass for verification status reads should stay explicit and narrow. If an existing internal auth surface already carries that trust level, reuse it; do not introduce a generic bypass flag in the public route.
2. Existing Redis key migration can stay compatibility-read / new-write because both verification attempts and resolution records are TTL-bound. No bulk backfill job is required for Priority 0 unless production TTLs are found to be effectively indefinite.
