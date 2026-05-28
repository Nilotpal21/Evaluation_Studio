# Session Timeout and Disposition Unification — Low-Level Design

**Status**: IN PROGRESS
**Date**: 2026-03-30
**Owner**: Platform team
**Related Feature Doc**: [docs/features/sub-features/session-timeout-disposition-unification.md](../features/sub-features/session-timeout-disposition-unification.md)
**Related Testing Guide**: [docs/testing/sub-features/session-timeout-disposition-unification.md](../testing/sub-features/session-timeout-disposition-unification.md)
**Related HLD Spec**: [docs/specs/session-timeout-disposition-unification.hld.md](../specs/session-timeout-disposition-unification.hld.md)

## 0. Implementation Progress

- [x] Phase 1: shared lifecycle policy and terminalization foundations (Slices 1-2B)
- [x] Phase 2: cleanup unification over the shared terminalization path
- [x] Phase 3A: shared disconnect policy
- [x] Phase 3B: SDK `end_session` terminalization
- [x] Phase 3C: end-hook execution after terminalization
- [x] Phase 4A: transfer TTL policy injection
- [x] Phase 4B: structured transfer end metadata request path
- [x] Review follow-up: cleanup retention treats canonical `escalated` sessions as terminal
- [x] Phase 4C: transfer-driven parent conversation end and durable transfer metadata parity
- [x] Phase 5: Studio migration and compatibility cleanup
- [x] Phase 6A: billing policy/control-plane scaffolding
- [x] Phase 6B1: compare-only derivation preview and per-session assessment boundary
- [x] Phase 6B2: billing replay/backfill and parity validation
- [ ] Phase 6C: billing usage materialization and event emission (6C1 manual materialization, 6C2A due-planning, 6C2B scheduled orchestration, 6C3A batch-scoped session-result persistence, 6C3B idempotent materialization-application control-plane records, 6C4 published session reporting plus platform/tenant/project time-window APIs, 6C5A admin consumer cutover onto published reports, 6C5B low-frequency publication scheduling, 6C5C/6C5D Studio tenant + project billing consumer cutover, 6C5E Studio analytics tenant-usage alias/quarantine, 6C5F tenant operator visibility for materialized-vs-published batches, 6C5G platform operator visibility for cross-tenant publication lag, 6C5H platform-to-tenant usage drilldown, 6C5I bounded manual publish/apply on pending tenant batches, 6C5J inline tenant batch/application inspection, and 6C5K tenant per-session results drill-in all landed; downstream invoice/ledger writes still pending)

## 1. Scope

This LLD turns the HLD into a concrete implementation plan. It focuses on:

- where lifecycle policy is persisted
- how terminal conversation-session state is resolved and written once
- how `session.ended` is emitted for every end path through the existing event bus
- how user-facing end hooks execute after terminalization
- how non-user-facing automation stays pipeline-driven off `session.ended`
- how transfer TTLs and transfer end metadata align with the same lifecycle model
- how billing stays explicitly out of the terminalization critical path
- how future billing-unit derivation remains declarative and configurable
- how future billing-domain aggregate events support dashboards without coupling them to raw lifecycle events
- how compatibility routes stay working during rollout

## 2. Non-Negotiable Invariants

1. Tenant defaults remain the ultimate fallback source of truth.
2. Project-scoped lifecycle reads/writes must remain project-isolated and return 404 on cross-project access.
3. Runtime and transfer-driven conversation end paths must use one shared disposition mapper and one shared terminalization service.
4. Every successful conversation-session terminal path must emit `session.ended`.
5. `session.ended` must be emitted before end-hook side effects are attempted.
6. End-hook failures must never suppress persisted terminal state or event emission.
7. Agent-transfer TTLs must not silently fall back to hardcoded store defaults when project policy exists.
8. Terminalization must not write billing ledgers, billing line items, replay/materialization artifacts, or legacy `UsagePeriod` documents, and it must not treat `sessions.billingPeriod` as billing truth.
9. Explicit session overrides are trusted runtime actions, not arbitrary client-provided state.
10. Redis hot-store expiry and terminal session disposition remain separate concepts.
11. Every implementation slice must be deployable incrementally without requiring an all-at-once caller cutover.
12. Any future billing-unit derivation rules and billing materialization trigger basis must be declarative and configurable, not hardcoded in runtime lifecycle code.

## 3. Contracts

### 3.1 Project lifecycle settings route

`GET /api/projects/:projectId/session-lifecycle`

Response shape:

```json
{
  "success": true,
  "data": {
    "runtime": {
      "idleSeconds": 1800,
      "maxAgeSeconds": 28800
    },
    "endHook": {
      "mode": "ignore"
    },
    "channels": {
      "web_chat": {
        "defaultDisposition": "abandoned",
        "disconnectBehavior": "detach",
        "endHook": {
          "mode": "respond",
          "message": "This chat has ended."
        }
      }
    },
    "agentTransfer": {
      "ttl": {
        "chat": 1800,
        "email": 14400,
        "voice": 0,
        "messaging": 1800,
        "campaign": 3600
      }
    }
  }
}
```

`PATCH /api/projects/:projectId/session-lifecycle`

- merge semantics, not replace-all
- auth: project-scoped RBAC with project-admin-only write access for hook fields
- validation: positive integer seconds where applicable, `0` allowed only for `voice` transfer TTL
- end-hook validation:
  - `ignore` requires no extra fields
  - `respond` requires `message`

### 3.2 Effective policy inspection route

`GET /api/projects/:projectId/session-lifecycle/effective?channel=<channel>&agentName=<name>`

Response shape:

```json
{
  "success": true,
  "data": {
    "runtime": {
      "idleSeconds": { "value": 900, "source": "agent" },
      "maxAgeSeconds": { "value": 3600, "source": "project" }
    },
    "disconnect": {
      "defaultDisposition": { "value": "completed", "source": "project.channel.api" },
      "disconnectBehavior": { "value": "end", "source": "project.channel.api" }
    },
    "endHook": {
      "mode": { "value": "respond", "source": "project.channel.web_chat" },
      "message": { "value": "This chat has ended.", "source": "project.channel.web_chat" }
    },
    "agentTransfer": {
      "ttl": { "value": 1800, "source": "project.agentTransfer.chat" }
    }
  }
}
```

### 3.3 Shared terminalization service

Target service contract:

```typescript
type TerminalSource =
  | 'close_api'
  | 'bulk_close'
  | 'cleanup'
  | 'disconnect'
  | 'sdk_end_session'
  | 'transfer_end'
  | 'provider_end';

interface TerminateConversationSessionInput {
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName?: string;
  channel?: string;
  disposition: CallDisposition;
  source: TerminalSource;
  explicitOverrides?: Partial<ResolvedSessionLifecyclePolicy>;
  transferMetadata?: {
    dispositionCode?: string;
    wrapUpNotes?: string;
  };
}

interface TerminateConversationSessionResult {
  sessionId: string;
  disposition: CanonicalSessionDisposition;
  status: CanonicalSessionStatus;
  endedAt: string;
  eventEmitted: boolean;
  eventId?: string;
  hook: {
    attempted: boolean;
    mode?: 'ignore' | 'respond';
    outcome?: 'ignored' | 'sent' | 'skipped' | 'failed';
    error?: string;
  };
}
```

Behavior:

- resolves effective lifecycle policy
- normalizes final disposition/status
- persists terminal session state once
- emits `session.ended`
- then executes the resolved end hook best effort
- leaves non-user-facing automation to pipeline subscribers

### 3.4 `session.ended` event contract

Envelope remains aligned with `PlatformEvent<T, P>`. Payload becomes:

```json
{
  "disposition": "timeout",
  "status": "abandoned",
  "terminalSource": "cleanup",
  "durationMs": 45000,
  "turnCount": 3,
  "agentsUsed": ["support-agent"],
  "reason": "timeout"
}
```

Notes:

- `reason` remains as a compatibility alias during rollout.
- The event is the downstream contract for pipeline execution.
- Hook outcome is traced separately and is not required by pipeline consumers.

### 3.5 Transfer-session end route extension

`POST /api/v1/agent-transfer/sessions/:id/end`

Compatibility behavior:

- existing empty-body end requests still succeed
- new optional body:

```json
{
  "reason": "completed",
  "dispositionCode": "resolved",
  "wrapUpNotes": "Customer issue fixed"
}
```

- runtime writes metadata before ending the transfer session
- if transfer end implies conversation end, runtime invokes the shared terminalization service
- normalized `reason` is mapped through the shared disposition service

### 3.6 Compiler normalization

Current:

- `execution.session_idle_timeout` -> `execution.timeouts.session_timeout_ms`

Target:

```typescript
execution.sessionLifecycle = {
  idleSeconds?: number;
  maxAgeSeconds?: number;
  disconnect?: {
    defaultDisposition?: CallDisposition;
    disconnectBehavior?: 'end' | 'detach';
  };
};
```

Legacy `session_idle_timeout` remains supported and normalizes into `sessionLifecycle.idleSeconds`.

### 3.7 Billing-unit configuration contract (follow-on, separate billing scope)

This rollout does **not** implement billing-unit derivation, but it should leave a clean configurable contract for the billing domain to consume later.

Candidate control-plane shape:

```json
{
  "billingUnits": {
    "enabled": false,
    "managedBy": "platform_admin",
    "scope": "tenant_subscription_plan",
    "plans": {
      "FREE": {
        "base": {
          "intervalMinutes": 15,
          "excludeChannels": ["web_debug"],
          "excludeSessionTypes": [],
          "excludeProactiveWithoutReply": true,
          "minUserMessages": 1,
          "minInteractiveTurns": 1,
          "minEngagedSeconds": 0
        },
        "addons": {
          "llm": {
            "mode": "per_call",
            "bucketSize": null,
            "includedProviders": [],
            "includedModels": [],
            "excludedModels": []
          },
          "tool": {
            "mode": "per_call",
            "bucketSize": null,
            "includedTools": [],
            "excludedTools": []
          }
        },
        "materialization": {
          "basis": "time_window",
          "timeWindowMinutes": 15,
          "completedSessionsBatchSize": 100,
          "maxBatchAgeSeconds": 300
        }
      },
      "TEAM": {},
      "BUSINESS": {},
      "ENTERPRISE": {}
    },
    "defaultPlanBehavior": {
      "startAllPlansIdentical": true
    }
  }
}
```

Interpretation:

- `TEAM`, `BUSINESS`, and `ENTERPRISE` may inherit the same defaults initially as `FREE`
- the config model stays plan-aware even if the initial values are identical
- the billing domain may later diverge plan-specific values without changing the lifecycle/runtime contract

Rules:

- lifecycle runtime does not read or enforce this config in the timeout-unification rollout
- billing services should read this config alongside `session.ended`, usage telemetry, interaction summaries, and the tenant's active subscription plan
- if config is absent, billing should fall back to subscription-plan defaults rather than hardcoded runtime behavior
- billing-unit policy is tenant-level only for now; project-level overrides are not supported
- only platform admins may change billing-unit policy
- billing services should materialize usage and emit `billing.usage.updated` after each configured time window or processed batch of completed sessions
- dashboards should consume `billing.usage.updated` rather than raw `session.ended` for billing views

Optional normalized shape inside the billing domain:

```json
{
  "tenantId": "tenant-123",
  "effectivePlan": "TEAM",
  "billingUnits": {
    "base": {
      "intervalMinutes": 15,
      "excludeChannels": ["web_debug"],
      "excludeSessionTypes": [],
      "excludeProactiveWithoutReply": true,
      "minUserMessages": 1,
      "minInteractiveTurns": 1,
      "minEngagedSeconds": 0
    },
    "addons": {
      "llm": {
        "mode": "per_call",
        "bucketSize": null,
        "includedProviders": [],
        "includedModels": [],
        "excludedModels": []
      },
      "tool": {
        "mode": "per_call",
        "bucketSize": null,
        "includedTools": [],
        "excludedTools": []
      }
    },
    "materialization": {
      "basis": "time_window",
      "timeWindowMinutes": 15,
      "completedSessionsBatchSize": 100,
      "maxBatchAgeSeconds": 300
    }
  }
}
```

## 4. File Inventory and Change Map

### New runtime files

| File                                                                     | Responsibility                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session-lifecycle/policy-service.ts`          | Resolve effective lifecycle policy from tenant, project, agent, and explicit layers |
| `apps/runtime/src/services/session-lifecycle/disposition-service.ts`     | Normalize end reason and derive session status                                      |
| `apps/runtime/src/services/session-lifecycle/terminalization-service.ts` | Persist terminal state, emit `session.ended`, and coordinate end-hook execution     |
| `apps/runtime/src/services/session-lifecycle/end-hook-runner.ts`         | Execute resolved `ignore` / `respond` end-hook behavior                             |
| `apps/runtime/src/routes/project-session-lifecycle.ts`                   | Project-scoped lifecycle settings route                                             |
| `apps/studio/src/app/api/projects/[id]/session-lifecycle/route.ts`       | Studio proxy for the lifecycle route                                                |
| `apps/studio/src/hooks/useSessionLifecycleSettings.ts`                   | Studio SWR/react-query hook for lifecycle settings                                  |

### Modified runtime files

| File                                                           | Change                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/tenant-config.ts`                   | Merge project lifecycle overrides for security-like timeout fields without dropping tenant defaults   |
| `apps/runtime/src/channels/pipeline/session-factory.ts`        | Replace direct timeout resolution with the shared policy service                                      |
| `apps/runtime/src/routes/chat.ts`                              | Use resolved lifecycle policy when creating runtime sessions                                          |
| `apps/runtime/src/websocket/sdk-handler.ts`                    | Route SDK `end_session` and disconnect policy through the shared lifecycle + terminalization services |
| `apps/runtime/src/channels/pipeline/lifecycle-manager.ts`      | Replace direct `channelLifecycle` lookups with lifecycle policy resolution                            |
| `apps/runtime/src/routes/sessions.ts`                          | Use the shared terminalization service for close and bulk-close                                       |
| `apps/runtime/src/services/session-cleanup-job.ts`             | Use shared timeout policy and shared terminalization/disposition logic                                |
| `apps/runtime/src/routes/agent-transfer-settings.ts`           | Delegate TTL reads/writes to the shared lifecycle backend for compatibility                           |
| `apps/runtime/src/routes/agent-transfer-sessions.ts`           | Accept structured end metadata and route through shared normalization                                 |
| `apps/runtime/src/services/agent-transfer/index.ts`            | Resolve and pass transfer TTLs into store create/extend flows; invoke terminalization when needed     |
| `apps/runtime/src/services/stores/mongo-conversation-store.ts` | Stop being a partial special case for event emission; align with shared terminalization ownership     |
| `apps/runtime/src/services/event-bus/types.ts`                 | Widen `SessionEndedPayload` to carry canonical disposition/status/source fields                       |
| `apps/runtime/src/server.ts`                                   | Mount the new lifecycle route and wire terminalization dependencies                                   |

### Modified package files

| File                                                                           | Change                                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/project-settings.model.ts`                       | Add `sessionLifecycle` schema section                                                                |
| `packages/compiler/src/platform/ir/compiler.ts`                                | Normalize legacy timeout field into new IR lifecycle structure                                       |
| `packages/compiler/src/platform/core/types.ts`                                 | Export canonical lifecycle/disposition/end-hook types as needed                                      |
| `packages/agent-transfer/src/session/transfer-session-store.ts`                | Stop relying on fallback TTLs when caller provides resolved policy; support metadata-before-end flow |
| `packages/agent-transfer/src/config/schema.ts`                                 | Align config defaults with the canonical transfer TTL policy                                         |
| `packages/agent-transfer/src/post-agent/disposition-handler.ts`                | Integrate with runtime path or trim to the final supported behavior                                  |
| `packages/eventstore/src/schema/events/session-events.ts`                      | Widen `session.ended` schema additively for canonical lifecycle payload                              |
| `packages/pipeline-engine/src/__tests__/integration-trigger-execution.test.ts` | Validate widened payload compatibility for `session.ended` consumers                                 |

### Modified Studio files

| File                                                                | Change                                              |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` | Move TTL controls onto the shared lifecycle backend |
| `apps/studio/src/components/settings/ProjectSettingsPage.tsx`       | Surface lifecycle settings entry point              |
| `apps/studio/src/api/agent-transfer.ts`                             | Use lifecycle-backed TTL settings during rollout    |

### Billing files intentionally not touched

The following subsystems are explicitly out of scope for direct writes from terminalization:

- `packages/database/src/models/credit-ledger.model.ts`
- `packages/database/src/models/billing-line-item.model.ts`
- `packages/database/src/models/billing-replay-run.model.ts`
- `packages/database/src/models/billing-replay-session-result.model.ts`
- `packages/database/src/models/billing-materialization-batch.model.ts`
- `packages/database/src/models/billing-materialization-application.model.ts`
- `packages/database/src/models/billing-materialization-session-result.model.ts`
- `packages/database/src/models/billing-materialization-checkpoint.model.ts`
- retired legacy `UsagePeriod` artifacts

Recommended downstream billing derivation guidance for the follow-on billing feature:

- exclude debug sessions such as `web_debug`
- exclude proactive sessions with no or below-minimum user interaction
- split base billing units into 15-minute billable intervals
- meter LLM and tool usage as addon billing units
- emit `billing.usage.updated` after materializing usage for a configured time window or processed batch of completed sessions so dashboards consume billing aggregates rather than raw lifecycle events

## 5. Incremental Implementation Slices

### Rollout guardrails

Every slice should follow the same no-regression pattern:

- ship behind a feature flag, shadow-mode branch, or caller-level opt-in until parity is proven
- change only one primary behavior surface at a time
- keep legacy callers and compatibility routes intact until the new path passes parity checks
- emit slice-specific metrics for old-path usage, new-path usage, parity mismatch, and rollback reason
- prefer dual-read or compare-only validation before switching the write or terminalization source of truth
- do not delete old code or old settings surfaces in the same slice that introduces the new path

Recommended runtime flags:

- `SESSION_LIFECYCLE_ROUTE_ENABLED`
- `SESSION_TERMINALIZATION_ENABLED`
- `SESSION_END_HOOKS_ENABLED`
- `TRANSFER_TTL_UNIFICATION_ENABLED`
- `TRANSFER_CONVERSATION_END_UNIFICATION_ENABLED`

### Phase 1: Shared lifecycle core and contracts

**Goal**: Introduce canonical policy, disposition, project/channel end-hook, and event contracts without changing all call sites yet.

**Slices**:

- **Slice 1A**: Add schema/types/contracts only. No runtime caller changes.
- **Slice 1B**: Add policy and disposition services in compare-only mode with unit coverage.
- **Slice 1C**: Widen `session.ended` schemas additively and verify existing pipeline consumers still parse the payload.

**Tasks**:
1.1. Add `sessionLifecycle` fields to `ProjectSettings`.
1.2. Create `policy-service.ts`, `disposition-service.ts`, and lifecycle types.
1.3. Normalize compiler lifecycle IR fields, including legacy timeout alias support.
1.4. Widen runtime/EventStore `session.ended` schemas additively.
1.5. Add unit tests for precedence resolution, end-reason mapping, and project/channel end-hook config validation.

**Files Touched**:

- `packages/database/src/models/project-settings.model.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/core/types.ts`
- `apps/runtime/src/services/session-lifecycle/policy-service.ts`
- `apps/runtime/src/services/session-lifecycle/disposition-service.ts`
- `apps/runtime/src/services/event-bus/types.ts`
- `packages/eventstore/src/schema/events/session-events.ts`

**Exit Criteria**:

- [ ] Shared lifecycle services and types exist with unit coverage.
- [ ] Compiler emits normalized lifecycle IR for legacy and new fields.
- [ ] `session.ended` schema accepts canonical lifecycle payload fields while remaining backward compatible.
- [ ] Affected package builds succeed.

**Test Strategy**:

- Unit: precedence resolution, default fallback, status mapping, hook validation
- Integration: `ProjectSettings` schema read/write and event schema validation

**Rollback**: Revert new services and schema fields; existing behavior remains unchanged.

### Phase 2: Runtime terminalization and event emission

**Goal**: Put runtime session create, cleanup, explicit close, and bulk-close behind the shared lifecycle and terminalization services.

**Slices**:

- **Slice 2A**: Add read-only lifecycle routes and effective-policy inspection without changing live runtime behavior.
- **Slice 2B**: Route explicit close and bulk-close through the terminalization service behind `SESSION_TERMINALIZATION_ENABLED`.
- **Slice 2C**: Move cleanup job terminalization onto the same service only after close-route parity is green.

**Tasks**:
2.1. Replace timeout resolution in `session-factory.ts` and `chat.ts`.
2.2. Introduce `terminalization-service.ts` and route `sessions.ts` close/bulk-close through it.
2.3. Update `session-cleanup-job.ts` to use the same policy and terminalization path.
2.4. Align `mongo-conversation-store.ts` so runtime does not depend on scattered direct event emission behavior.
2.5. Add effective-policy inspection route and runtime tests.

**Files Touched**:

- `apps/runtime/src/channels/pipeline/session-factory.ts`
- `apps/runtime/src/routes/chat.ts`
- `apps/runtime/src/services/session-cleanup-job.ts`
- `apps/runtime/src/routes/sessions.ts`
- `apps/runtime/src/services/session-lifecycle/terminalization-service.ts`
- `apps/runtime/src/routes/project-session-lifecycle.ts`
- `apps/runtime/src/services/stores/mongo-conversation-store.ts`

**Exit Criteria**:

- [ ] Runtime create/cleanup/close all call the shared policy or terminalization service.
- [ ] Every successful runtime terminal path emits exactly one `session.ended` event.
- [ ] Project override E2E test passes.
- [ ] Session cleanup still differentiates `timeout` vs `unengaged`.

**Test Strategy**:

- Integration: runtime close, bulk-close, cleanup regression tests
- E2E: project timeout override enforcement plus end-event emission

**Rollback**: Revert call sites to old helpers; keep shared services dormant.

### Phase 3: Channel disconnect, SDK convergence, and end hooks

**Goal**: Unify channel disconnect defaults and SDK explicit end behavior, then layer user-facing end hooks on top.

**Slices**:

- **Slice 3A**: Move channel disconnect resolution to the shared policy service with legacy fallback still present.
- **Slice 3B**: Route SDK `end_session` through the shared terminalization service.
- **Slice 3C**: Enable `ignore` / `respond` end hooks after disconnect and SDK parity are green.

**Tasks**:
3.1. Replace direct `channelLifecycle` reads in disconnect handlers with the policy service.
3.2. Preserve trusted SDK `end_session` as an explicit override but route it through the shared terminalization service.
3.3. Add `end-hook-runner.ts` and execute it only after terminalization has persisted state and emitted the event.
3.4. Support only `ignore` and `respond` runtime hook modes, with project default plus channel override.
3.5. Keep non-user-facing API/function/webhook automation on `session.ended` pipelines instead of runtime hook config.
3.6. Add integration tests for `web_chat`, `web_debug`, `api`, and `voice`.

**Files Touched**:

- `apps/runtime/src/channels/pipeline/lifecycle-manager.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/services/session-lifecycle/end-hook-runner.ts`

**Exit Criteria**:

- [ ] Channel disconnect behavior comes from the shared resolver.
- [ ] SDK `end_session` still forces a clean explicit close.
- [ ] End hooks run after event emission and fail open.
- [ ] Project-level end-hook config with channel override is enforced, and no agent-level hook override exists.
- [ ] Integration tests cover channel default vs explicit override behavior.

**Test Strategy**:

- Integration: disconnect behavior matrix and hook failure handling
- E2E: SDK explicit end on a detach-default channel with `respond` and `ignore` hook modes

**Rollback**: Revert handlers to direct `channelLifecycle` lookups and disable end-hook invocation.

### Phase 4: Agent-transfer lifecycle alignment

**Goal**: Make transfer-session TTLs and transfer end metadata honor project lifecycle policy and use shared terminalization when they end the conversation.

**Slices**:

- **Slice 4A**: Inject resolved transfer TTLs into create/extend without changing transfer end semantics.
- **Slice 4B**: Add structured transfer end metadata write path.
- **Slice 4C**: Route transfer-driven parent conversation end through shared terminalization only after 4A and 4B are stable.

**Tasks**:
4.1. Resolve project transfer TTLs before calling `TransferSessionStore.create()` and `extendTTL()`.
4.2. Extend the transfer end route to accept structured reason and metadata.
4.3. Wire `DispositionHandler` or equivalent runtime logic into a supported end-to-end path.
4.4. When transfer completion ends the parent conversation session, invoke the shared terminalization service.
4.5. Align transfer schema defaults with canonical policy defaults.

**Files Touched**:

- `apps/runtime/src/services/agent-transfer/index.ts`
- `apps/runtime/src/routes/agent-transfer-settings.ts`
- `apps/runtime/src/routes/agent-transfer-sessions.ts`
- `packages/agent-transfer/src/session/transfer-session-store.ts`
- `packages/agent-transfer/src/config/schema.ts`
- `packages/agent-transfer/src/post-agent/disposition-handler.ts`

**Exit Criteria**:

- [ ] Transfer-session TTLs use resolved project policy in create and extend paths.
- [ ] Transfer-session end accepts optional reason/metadata without breaking legacy callers.
- [ ] Transfer-driven conversation end uses the shared terminalization service when applicable.
- [x] Post-agent metadata survives until end cleanup for both `end` and `return` post-agent actions.

**Test Strategy**:

- Integration: TTL injection, metadata-before-end flow, transfer-driven conversation end
- E2E: transfer policy + post-agent metadata capture

**Rollback**: Revert agent-transfer route and adapter wiring; old defaults resume.

### Phase 5: Studio migration and compatibility cleanup

**Goal**: Move Studio to the dedicated lifecycle route while keeping compatibility stable.

**Slices**:

- **Slice 5A**: Studio read-only integration with the new lifecycle route.
- **Slice 5B**: Studio write integration with compatibility route fallback.
- **Slice 5C**: Deprecation messaging and old-surface cleanup planning, but no destructive removal in the same release.

**Tasks**:
5.1. Add Studio proxy, hook, and settings UI.
5.2. Repoint transfer TTL controls to the shared lifecycle backend.
5.3. Refresh docs, feature indexes, testing guide, and operator copy.
5.4. Optionally mark old compatibility fields/routes as deprecated in follow-up docs.

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/session-lifecycle/route.ts`
- `apps/studio/src/hooks/useSessionLifecycleSettings.ts`
- `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`
- `apps/studio/src/components/settings/ProjectSettingsPage.tsx`
- `docs/...`

**Exit Criteria**:

- [ ] Studio reads and writes lifecycle settings through the dedicated route.
- [ ] Compatibility routes still pass regression tests.
- [ ] Docs reflect one authoritative lifecycle model.

**Test Strategy**:

- Integration: Studio proxy route behavior
- E2E: settings save/load and operator close flows

**Rollback**: Return Studio controls to legacy endpoints while leaving backend compatibility intact.

### Phase 6: Billing-unit follow-on scaffolding

**Goal**: Prepare a future billing implementation to derive units from emitted lifecycle and usage data without coupling billing writes to runtime terminalization.

**Slices**:

- **Slice 6A**: Define billing-unit config contract, billing materialization basis, and `billing.usage.updated` contract in the billing domain.
- **Slice 6B1**: Add compare-only derivation services and preview surfaces, plus a per-session billing assessment boundary that consumes terminal session data without emitting `billing.usage.updated` from lifecycle code.
- **Slice 6B2**: Add replay/backfill jobs against historical `session.ended` plus usage telemetry, grouped by configured time window or completed-session batches, and persist compare-only parity outputs for review.
- **Slice 6C1**: Add durable materialization batches and manual platform-admin materialization that emits truthful aggregate `billing.usage.updated` events from the billing domain.
- **Slice 6C2A**: Add scheduler-owned checkpoints plus a scheduler-safe due-planning surface for `time_window` and `completed_sessions` without wiring the worker yet.
- **Slice 6C2B**: Add scheduled `time_window` and `completed_sessions` trigger orchestration so aggregate emission no longer depends on manual admin invocation.
- **Slice 6C3**: Introduce billing-unit writes only after compare-only outputs and aggregate materialization are stable and approved, starting with an idempotent materialization-application control-plane record that selects deal and accounting period without mutating legacy priced billing surfaces.
- **Slice 6C4**: Publish applied batch session results into an authoritative per-session reporting model and expose time-windowed usage/billing-unit reports at platform-admin, tenant-workspace, and project scopes without introducing money or credit conversion.
- **Slice 6C5**: Cut operator/admin consumers over to the published reporting plane, starting with platform-admin global usage dashboards and tenant-admin usage tabs before migrating Studio billing views off the legacy analytics path.
  Add a second low-frequency publication scheduler so completed batches can reach report rows without lengthening the materialization scheduler pass.
  Follow with a Studio analytics alias/quarantine slice so the remaining `tenant-usage` analytics consumers stop depending on the same route name that billing previously used.
  Add an operator visibility slice that exposes recent materialization batches, pending publication counts, and last materialized/published timestamps so admins can understand why published reports may lag behind completed batches.
  Follow with a platform-level visibility slice that aggregates pending publication across tenants on the global Admin usage surface without introducing any new write path.
  Then add a drilldown slice so platform operators can jump from a lagging-tenant row directly into that tenant's Usage tab publication section.
  Finish the operator loop with a bounded manual publish/apply action on tenant batches, reusing the idempotent application control plane instead of coupling any new writes to the scheduler path.
  Add one more read-only inspection slice so tenant operators can open batch/application detail inline from the same table and understand scope, deal resolution, and deferred projection reasons without leaving the Usage tab.
  Extend that same operator surface with a paginated per-session results drill-in so included and excluded sessions are inspectable without moving into platform-admin-only routes.

**Files Touched**:

- billing settings storage under the billing domain, not lifecycle project settings
- billing-domain routes/services/models to be defined in the billing feature
- `docs/features/billing.md`
- `docs/plans/...` in the billing feature area

**Exit Criteria**:

- [ ] Billing-unit rules are fully configurable and not hardcoded.
- [x] Compare-only derivation can explain excluded debug/proactive sessions and 15-minute interval splits.
- [x] Per-session billing assessment is available without coupling `session.ended` terminalization to `billing.usage.updated`.
- [x] Addon billing-unit derivation for LLM/tool usage is configurable by mode and scope.
- [x] Billing materialization basis is configurable as `time_window` or `completed_sessions`.
- [x] The billing domain can emit `billing.usage.updated` for dashboard consumption without requiring dashboards to infer billing completion from raw `session.ended`.
- [x] Tenant aggregate billing outputs can expose project and channel breakdowns without forcing separate project batches.
- [x] Admin operator consumers can read billing-unit reports from the published reporting projection without depending on the legacy platform `usage-summary` route.
- [x] Studio analytics consumers use a dedicated analytics proxy path while the legacy `tenant-usage` Studio route remains as a compatibility shim.
- [x] Admin tenant usage surfaces can distinguish completed materialization from published report visibility through a dedicated publication-status route and recent-batch summary.
- [x] Admin global usage surfaces can see cross-tenant pending publication counts and recent lagging tenants through a platform publication-status route.
- [x] Admin global usage surfaces can deep-link directly into the tenant Usage publication section for a lagging tenant.
- [x] Admin tenant usage surfaces can manually publish a completed pending batch through the existing idempotent apply path and refresh report visibility in place.
- [x] Admin tenant usage surfaces can inspect materialization scope and application/projection detail inline from the recent batch table without navigating away.
- [x] Admin tenant usage surfaces can inspect paginated per-session materialization results inline from the same batch detail surface.

**Test Strategy**:

- Integration: config parsing and derivation parity
- Integration: per-session assessment parity and lifecycle/billing decoupling
- Replay/backfill validation against sampled historical sessions
- Integration/E2E: due planning, checkpoint advancement, and scheduled aggregate materialization

**Rollback**: Disable compare-only assessment/derivation jobs and preserve `session.ended` lifecycle emission unchanged.

## 6. Wiring Checklist

- [ ] Each slice has an explicit feature flag, shadow-mode gate, or caller opt-in path
- [ ] Parity metrics exist before any old path is retired
- [ ] New runtime lifecycle route mounted in `server.ts`
- [ ] Project settings repo/service exports lifecycle helpers
- [ ] Shared lifecycle services imported by session create, cleanup, disconnect, close, and transfer flows
- [ ] Shared terminalization service emits `session.ended` for every successful end path
- [ ] End-hook runner executes only after event emission
- [ ] Studio proxy route registered and used by settings UI
- [ ] Compatibility routes delegate to the new backend service, not duplicated logic
- [ ] No direct billing model writes are introduced in terminalization paths
- [ ] New types exported from the package where they are defined

## 7. Acceptance Criteria (Whole Feature)

- [ ] Project lifecycle settings are persisted and enforced on live runtime sessions.
- [ ] Agent overrides are enforced from compiler IR.
- [ ] Channel disconnect, explicit close, cleanup, SDK end, and transfer-driven conversation end all use one terminalization service.
- [ ] Every successful terminalization emits exactly one canonical `session.ended` event.
- [ ] Event emission happens before end-hook execution is attempted.
- [ ] End hooks support `ignore` and `respond`, and hook failures do not suppress terminalization.
- [ ] Non-user-facing automation remains pipeline-driven off `session.ended` rather than runtime hook config.
- [ ] Transfer TTL settings are honored by live store create/extend paths.
- [ ] Post-agent metadata capture is wired end-to-end.
- [ ] Terminalization does not directly write billing ledgers, billing line items, replay/materialization artifacts, or legacy usage-period documents.
- [ ] No slice requires all callers to migrate in the same deployment.
- [ ] Future billing-unit derivation remains config-driven and downstream-only.
- [ ] Studio exposes one authoritative lifecycle settings experience.
- [ ] `pnpm build` and affected test suites pass.

## 8. Open Questions

1. Whether the effective-policy route should be runtime-only at first, or exposed in Studio immediately.
2. What should the default interaction threshold be for a proactive session to become billable?
   Recommendation: require at least `minUserMessages = 1` and `minInteractiveTurns = 1`.
3. Should the base billable interval always default to 15 minutes but remain configurable?
   Recommendation: yes, default `intervalMinutes = 15`, configurable by billing policy.
4. Should LLM and tool addon units start as `per_call`, `bucketed`, or `off`?
   Recommendation: `per_call` initially, with optional bucket support later.
