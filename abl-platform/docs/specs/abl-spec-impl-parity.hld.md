# HLD: ABL Spec-Implementation Parity

**Feature Spec**: `docs/features/abl-spec-impl-parity.md`
**Test Spec**: `docs/testing/abl-spec-impl-parity.md`
**Status**: APPROVED
**Author**: Platform team
**Date**: 2026-03-25

---

## 1. Problem Statement

The ABL specification defines 15+ major constructs. The parser and compiler correctly handle them all — DSL compiles to IR. However, **9 constructs silently produce no runtime effect**: the IR is generated but the runtime never executes the corresponding logic. Agent developers write valid ABL (e.g., `ESCALATE:`, `HOOKS:`, `BEHAVIOR_PROFILES:`), get no compilation errors, but the features do not work at runtime.

This creates **false confidence** — the most dangerous category of platform bug. A developer believes their escalation logic, lifecycle hooks, or error recovery are in place, but they are not. `STATUS.md` compounds this by reporting stale information.

The goal is to close every gap where the ABL spec describes working behavior but the runtime does not execute it. Every spec-described feature must be **production wired**: code path executes + trace events emitted + E2E tests verify the behavior through the HTTP API.

---

## 2. Alternatives Considered

### Option A: Runtime-Only Wiring (Incremental)

- **Description**: Wire each gap individually in the runtime, extending existing executor files. Add hook execution to reasoning-executor, escalation wiring to escalation-bridge, etc. Minimal new abstractions — follow the existing pattern of inline wiring (like guardrails).
- **Pros**: Lowest risk — each gap is independently deployable. Follows existing guardrail wiring pattern (proven). No new services or infrastructure. Each feature self-gates based on IR field presence (no feature flags).
- **Cons**: reasoning-executor.ts is already 3,114 LOC — adding hooks inline increases complexity. No central lifecycle orchestrator. Harder to test hooks + profiles + escalation interactions in isolation.
- **Effort**: M (4-6 weeks for 9 FRs)

### Option B: Lifecycle Orchestrator Service

- **Description**: Extract a new `LifecycleOrchestrator` service that owns the before_turn → guardrails → LLM → after_turn → error_handling pipeline. Each feature (hooks, profiles, escalation) becomes a plugin registered with the orchestrator.
- **Pros**: Clean separation of concerns. reasoning-executor shrinks significantly. Each feature is testable in isolation. Future features (breakpoints, extensions) plug in naturally.
- **Cons**: Major refactor of the execution path — high risk of regressions. Requires touching reasoning-executor, flow-step-executor, and routing-executor simultaneously. Sprint 2 of architecture simplification already wired construct executors — this would be a second restructuring. Significantly higher effort.
- **Effort**: L (8-12 weeks, including migration)

### Option C: Feature-Flag-Gated Parallel Path

- **Description**: Build all new wiring behind feature flags. Run old (no-op) and new (wired) paths in parallel with shadow comparison. Gradually enable per tenant.
- **Pros**: Zero-risk rollout. Can A/B test per tenant. Revert is instant (flag off).
- **Cons**: Sprint 2 of architecture simplification already tried shadow mode and it was killed as unnecessary overhead — construct executors use the same core algorithms. Feature flags add code complexity and maintenance burden. IR-gated activation already provides natural self-gating (if IR field is absent, feature doesn't activate). Doubles the code surface during the parallel period.
- **Effort**: L (6-8 weeks, including shadow infrastructure)

### Recommendation: Option A — Runtime-Only Wiring (Incremental)

**Rationale**: Option A is the clear winner. The guardrail wiring pattern (Sprint 1-2 of architecture simplification) proved that inline wiring works reliably — guardrails are wired at 5 checkpoints with zero issues. IR-gated activation means no feature flags are needed: if `hooks` is `undefined` on the IR, hook execution is a no-op. Each FR is independently deployable and testable. The risk of Option B (massive refactor) and Option C (shadow overhead already proven wasteful) far outweigh the incremental complexity in existing files. The architecture simplification plan (Sprint 4+) can extract a lifecycle orchestrator later if needed, after all gaps are wired and stable.

---

## 3. Architecture

### System Context Diagram

```
                    ┌─────────────────────────────┐
                    │         Agent Developer      │
                    │  (writes ABL DSL)            │
                    └──────────┬──────────────────┘
                               │ ABL Source
                               ▼
                    ┌──────────────────────┐
                    │  Parser + Compiler   │
                    │  (packages/compiler) │
                    │                      │
                    │  DSL → AgentIR       │
                    │  - EscalationConfig  │
                    │  - HooksConfig       │
                    │  - BehaviorProfileIR │
                    │  - VoiceConfigIR*    │
                    │  - ActionHandlerIR   │
                    │  - AttachmentFieldIR │
                    │  - OnErrorConfig     │
                    └──────────┬──────────┘
                               │ AgentIR (deployed)
                               ▼
┌────────────────────────────────────────────────────────────────┐
│                     Runtime (apps/runtime)                      │
│                                                                │
│  ┌───────────────┐    ┌──────────────────┐    ┌─────────────┐ │
│  │ Session Mgr   │───▶│ Runtime Executor │───▶│ Trace Store │ │
│  └───────────────┘    └────────┬─────────┘    └─────────────┘ │
│                                │                               │
│         ┌──────────────────────┼──────────────────────┐        │
│         ▼                      ▼                      ▼        │
│  ┌─────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │ Reasoning   │    │ Flow-Step        │    │ Routing      │  │
│  │ Executor    │    │ Executor         │    │ Executor     │  │
│  │ (hooks,     │    │ (gather,         │    │ (profiles,   │  │
│  │  guardrails,│    │  action handlers,│    │  handoffs)   │  │
│  │  LLM calls) │    │  attachments)    │    │              │  │
│  └──────┬──────┘    └────────┬─────────┘    └──────┬───────┘  │
│         │                    │                      │          │
│         ▼                    ▼                      ▼          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Shared Execution Services                   │   │
│  │  ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐ │   │
│  │  │ Hook        │ │ Escalation   │ │ Error Handler    │ │   │
│  │  │ Executor*   │ │ Bridge       │ │ Router           │ │   │
│  │  └─────────────┘ └──────┬───────┘ └──────────────────┘ │   │
│  │  ┌─────────────┐ ┌──────┼───────┐ ┌──────────────────┐ │   │
│  │  │ Profile     │ │ Transfer     │ │ Voice Config     │ │   │
│  │  │ Resolver    │ │ Tool Exec    │ │ Resolver*        │ │   │
│  │  └─────────────┘ └──────────────┘ └──────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                │                               │
└────────────────────────────────┼───────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
     ┌──────────────┐  ┌──────────────┐    ┌──────────────┐
     │ Agent        │  │ Connector    │    │ Voice/TTS    │
     │ Transfer     │  │ (ITSM)      │    │ Provider     │
     │ Module       │  │ ServiceNow/ │    │ (ElevenLabs/ │
     │              │  │ Zendesk     │    │  Azure/etc)  │
     └──────────────┘  └──────────────┘    └──────────────┘

* = New module introduced by this HLD
```

### Component Diagram — New and Modified Components

```
┌─ New Components ──────────────────────────────────────────────┐
│                                                               │
│  hook-executor.ts                                             │
│    - executeHook(hookType, hookAction, session, traceStore)   │
│    - Reuses ToolBindingExecutor for CALL actions              │
│    - Timeout-isolated (configurable, default 10s per hook)    │
│    - Non-fatal by default (critical?: boolean on HookAction)  │
│                                                               │
│  voice-config-resolver.ts                                     │
│    - resolveVoiceConfig(ir, effectiveConfig) → VoiceParams    │
│    - Merges IR base + profile override + external fallback    │
│                                                               │
│  escalation/resolution-handler.ts                             │
│    - handleResolution(sessionId, resolution, traceStore)      │
│    - Evaluates OnHumanComplete conditions                     │
│    - Resumes paused session via resumption-service pattern    │
│                                                               │
└───────────────────────────────────────────────────────────────┘

┌─ Modified Components ────────────────────────────────────────┐
│                                                               │
│  escalation-bridge.ts                                         │
│    + Set session status "escalated"                           │
│    + Wire agent-transfer (transfer_to_agent / set_queue)      │
│    + Fire connector action for ITSM (if configured)           │
│    + Pause session when on_human_complete is defined          │
│                                                               │
│  reasoning-executor.ts                                        │
│    + Call hookExecutor.execute('before_turn') before LLM      │
│    + Call hookExecutor.execute('after_turn') after LLM        │
│    + Consume merged tool set from profile resolver             │
│                                                               │
│  flow-step-executor.ts                                        │
│    + Wire AttachmentFieldIR validation in GATHER              │
│    + Wire ActionHandlerIR dispatch on user interaction         │
│                                                               │
│  error-handler-router.ts                                      │
│    + Extend resolution chain: step → agent-level ON_ERROR     │
│    + Handle: invalid_input, validation_error, unknown_error   │
│                                                               │
│  profile-resolver.ts                                          │
│    + Per-turn re-evaluation (not just session init)            │
│    + Emit behavior_profile_applied trace events                │
│                                                               │
│  runtime-executor.ts                                          │
│    + Call hookExecutor.execute('before_agent') at session init │
│    + Call hookExecutor.execute('after_agent') at session end   │
│                                                               │
│  sessions.ts (routes)                                         │
│    + POST /:sessionId/escalation/resolve                      │
│    + GET  /:sessionId/escalation                              │
│                                                               │
│  schema.ts (compiler IR)                                      │
│    + VoiceConfigIR: add provider?, voice_id?, speed?           │
│    + HookAction: add critical?: boolean                        │
│    + EscalationConfig: add connector_action?: string           │
│                                                               │
│  compiler.ts                                                  │
│    + Compile ACTION_HANDLERS: DSL block → ActionHandlerIR[]   │
│    + Populate VoiceConfigIR.provider/voice_id/speed from DSL  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Data Flow — ESCALATE (FR-1 + FR-2)

```
1. Agent DSL defines ESCALATE: block with triggers, context_for_human, on_human_complete
2. Compiler produces EscalationConfig IR (with optional connector_action)
3. At runtime, escalation trigger condition evaluates to true
4. routing-executor calls escalation-bridge.handleEscalation()

   escalation-bridge.handleEscalation():
   ├── a. Create HumanTask record (tenantId, projectId scoped)
   ├── b. Set session.status = "escalated"
   ├── c. Emit "escalation_triggered" trace event
   ├── d. [Path A] Call TransferToolExecutor via EscalationRouting mapping:
   │       ├── routing.connection → transfer_to_agent target parameter
   │       ├── routing.queue → set_queue queue name (if defined)
   │       ├── routing.skills → agent filter skills for routing
   │       ├── routing.priority → escalation priority level
   │       ├── routing.voice → SIP transfer params (voice channel only)
   │       ├── routing.post_agent → 'return' | 'end' (after human resolves)
   │       └── Agent-transfer module routes to human agent queue
   ├── e. [Path B] If connector_action defined:
   │       ├── Resolve connector action from packages/connectors
   │       ├── Fire webhook with context_for_human as payload
   │       ├── Store ticketId/ticketUrl on HumanTask
   │       └── Emit "itsm_ticket_created" trace event
   └── f. If on_human_complete.length > 0: pause session
         └── Session enters "escalated" state, waiting for resolution

5. Human agent resolves (via external system)
6. POST /api/projects/:projectId/sessions/:sessionId/escalation/resolve
   ├── a. Validate auth (requireProjectPermission)
   ├── b. Find HumanTask by source.sessionId + tenantId
   ├── c. Update HumanTask status → "completed"
   ├── d. Evaluate OnHumanComplete[] conditions
   ├── e. Execute matched action (continue/escalate/handoff/complete)
   ├── f. Resume session via resumption-service pattern
   └── g. Emit "escalation_resolved" trace event
```

### Data Flow — HOOKS (FR-3)

```
Session Lifecycle:
  ┌─────────────────────────────────────────────────────────┐
  │ Session Init                                             │
  │   runtime-executor.ts                                    │
  │   └─▶ hookExecutor.execute('before_agent', ir.hooks)     │
  │        ├── CALL: toolBindingExecutor.execute(tool_name)  │
  │        ├── SET: session.variables[key] = value           │
  │        └── RESPOND: send message to channel              │
  │                                                          │
  │ Each Turn:                                               │
  │   reasoning-executor.ts                                  │
  │   ├─▶ hookExecutor.execute('before_turn', ir.hooks)      │
  │   ├─▶ [input guardrails]                                 │
  │   ├─▶ [LLM call + tool dispatch]                         │
  │   ├─▶ [output guardrails]                                │
  │   └─▶ hookExecutor.execute('after_turn', ir.hooks)       │
  │                                                          │
  │ Session Complete:                                        │
  │   runtime-executor.ts                                    │
  │   └─▶ hookExecutor.execute('after_agent', ir.hooks)      │
  └─────────────────────────────────────────────────────────┘

Hook Execution (hook-executor.ts):
  1. Check if hook action is defined (IR-gated: no action → no-op)
  2. Wrap in timeout (default 10s, configurable)
  3. Execute actions sequentially:
     - CALL → ToolBindingExecutor (existing infrastructure)
     - SET → session.variables mutation
     - RESPOND → channel message send
  4. Emit "hook_executed" trace event
  5. On failure:
     - If critical === true: throw → main execution aborts
     - If critical !== true (default): log warning, continue
```

### Sequence Diagram — Profile-Driven Per-Turn Tool Adaptation (FR-4)

```
  Client         Runtime         ProfileResolver     ReasoningExecutor    LLM
    │               │                  │                    │               │
    │ POST message  │                  │                    │               │
    │──────────────▶│                  │                    │               │
    │               │ evaluate         │                    │               │
    │               │ profiles         │                    │               │
    │               │─────────────────▶│                    │               │
    │               │                  │ check WHEN         │               │
    │               │                  │ conditions         │               │
    │               │                  │ (channel, tier,    │               │
    │               │                  │  time, custom)     │               │
    │               │                  │                    │               │
    │               │  effectiveConfig │                    │               │
    │               │◀─────────────────│                    │               │
    │               │ (tools merged:   │                    │               │
    │               │  base - hidden   │                    │               │
    │               │  + added)        │                    │               │
    │               │                  │                    │               │
    │               │ emit trace: behavior_profile_applied  │               │
    │               │──────────────────────────────────────▶│               │
    │               │                  │                    │               │
    │               │                  │  execute turn      │               │
    │               │                  │  with merged tools │               │
    │               │──────────────────────────────────────▶│               │
    │               │                  │                    │ chatWithTools │
    │               │                  │                    │──────────────▶│
    │               │                  │                    │◀──────────────│
    │               │                  │                    │               │
    │◀──────────────│                  │                    │               │
    │   response    │                  │                    │               │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | All new queries use `findOne({ _id, tenantId })` pattern. HumanTask lookups for escalation resolution: `findOne({ 'source.sessionId': sessionId, tenantId })`. Escalation resolution API uses `requireProjectPermission()`. Cross-tenant access returns 404, not 403. New `{ 'source.sessionId': 1 }` index on human_tasks collection supports efficient session-based lookup without tenant index scan. Hook tool calls inherit session's tenantId — ToolBindingExecutor already scopes tools per tenant.                                                                                                                                                                                        |
| 2   | **Data Access Pattern** | **Existing repository layer**: HumanTask uses Mongoose model (`packages/database/src/models/human-task.model.ts`). No new collections — extend existing HumanTask with 3 ITSM fields (`connectorTicketId`, `connectorTicketUrl`, `connectorActionName`). Session status uses existing in-memory session map + MongoDB persistence. **No caching changes** — HumanTask is write-once-read-few (created on escalation, read on resolution). Profile evaluation reads from in-memory IR (already loaded at session init).                                                                                                                                                                            |
| 3   | **API Contract**        | **New endpoints**: `POST /api/projects/:projectId/sessions/:sessionId/escalation/resolve` — body: `{ resolution: { decision: string, notes?: string, fields?: Record<string, unknown> } }`, response: `{ success: true, data: { sessionId, status, action } }`. `GET /api/projects/:projectId/sessions/:sessionId/escalation` — response: `{ success: true, data: { status, humanTask, ticketUrl? } }`. **Error envelope**: standard `{ success: false, error: { code, message } }`. Error codes: `ESCALATION_NOT_FOUND` (404), `ESCALATION_ALREADY_RESOLVED` (409), `SESSION_NOT_ESCALATED` (400). **No breaking changes** to existing APIs — all new behavior is additive and IR-gated.         |
| 4   | **Security Surface**    | **Auth**: Escalation resolution requires `requireProjectPermission(req, res, 'session:execute')` — reuses existing permission (already covers mutating session state; `session:resolve` does not exist in the codebase). Hook tool calls go through full middleware chain (SSRF protection, tool permissions). ITSM webhook payloads contain only `context_for_human` — no raw session data leaked. **Input validation**: Zod schemas for resolution body (`z.string().min(1)` for IDs, never `.cuid()`). Connector action payloads validated against connector schema before dispatch. **PII**: `context_for_human` may contain PII — apply existing `TraceScrubber` to escalation trace events. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | **Hook failures**: Non-fatal by default. New `critical?: boolean` field on `HookAction` (default `false`). Critical hook failure throws, aborting the turn. Non-critical failure: emit warning trace event, continue main execution. **Escalation failures**: Agent-transfer failure → session stays active, emit error trace event, attempt ON_ERROR handler chain. ITSM webhook failure → non-blocking, escalation continues without ticket. **Agent-level ON_ERROR**: The `ErrorHandlerRouter.resolveErrorHandler()` already implements a 3-step chain: (1) step-level on_error, (2) agent-level `error_handling.handlers` (type + subtype match), (3) agent-level `error_handling.default_handler`. The gap is NOT the chain — it's that `resolveErrorHandler` is currently only called for `tool_error` (reasoning-executor.ts:2796). Non-tool errors (`invalid_input`, `validation_error`, `unknown_error`) never reach the handler chain. FR-8 wires these additional error sites into the existing chain. Actions: `continue`, `escalate`, `handoff`, `complete`, `backtrack`, `retry_step`. `backtrack` transitions to the step specified by `ErrorHandler.backtrack_to` and is only meaningful in flow-step-executor contexts (not reasoning-executor, which has no flow steps). |
| 6   | **Failure Modes** | **Escalation + agent-transfer down**: Session remains active, user sees "unable to connect to agent" response via ON_ERROR handler. HumanTask is still created (local operation). Retry via standard error handler. **Hook tool timeout**: Each hook has configurable timeout (default 10s). Timeout treated as non-critical failure. Uses AbortSignal pattern (same as `executeWithRetry` in error-handler-router.ts:163). **Profile evaluation failure**: Catch at evaluation layer, fall through to base config (no overrides applied). Emit warning trace. **ITSM connector timeout**: Non-blocking, 30s timeout. Escalation continues, ticket creation retried via standard retry. **Session pause + pod restart**: Paused session state persisted to MongoDB. On pod restart, session reload picks up "escalated" status. Resolution endpoint works against any pod (stateless).                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | **Idempotency**   | **Escalation creation**: `escalation-bridge.ts` already has idempotency check (`findOne` before `create`, lines 32-37). Extended: if HumanTask already exists for session, skip creation, return existing. **Escalation resolution**: Resolution endpoint checks HumanTask status — `ESCALATION_ALREADY_RESOLVED` (409) if already completed. Resolution is not retryable (human decisions are final). **ITSM webhook**: Connector action is fire-and-forget with idempotency key (`sessionId + escalationTimestamp`). Duplicate connector calls produce the same ticket (connector-level dedup). **Hook execution**: Hooks are per-turn, not idempotent (each turn fires fresh). No dedup needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | **Observability** | **New trace event types** (all via `TraceStore.addEvent()`): `escalation_triggered` (trigger condition, priority, reason, path: agent-transfer/itsm/both), `escalation_resolved` (resolution data, human agent ID, duration, action taken), `itsm_ticket_created` (connector name, ticket ID, ticket URL), `hook_executed` (hook type, actions executed, duration, success/failure, tool calls made), `behavior_profile_applied` (profile name, overrides: tools added/hidden count, voice override), `action_handler_executed` (action ID, handler result, transition target), `voice_config_resolved` (provider, voice_id, source: ir/profile/external), `agent_error_handled` (error type, handler matched, action taken). **Existing infrastructure**: SpanTree and EventTimeline in Studio automatically surface these events — no UI changes needed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Hooks**: Add ~20-50ms per turn for before_turn + after_turn (2 sequential hook executions). Tool-calling hooks (CALL) add tool execution latency on top. Timeout cap: 10s per hook (configurable). **Profiles**: In-memory condition evaluation — negligible (<1ms). Tool set merge: O(n) where n = tool count — negligible. **Escalation**: One-time cost on trigger (HumanTask creation + optional ITSM webhook). No per-turn cost. Session pause releases LLM context (positive for resource usage). **Attachment validation**: O(1) field checks per attachment — negligible. **Overall budget**: hooks are the only material addition to per-turn latency. Target: <100ms overhead for non-tool-calling hooks.                                                                                                                                                                                                                                                                                                                                                                                      |
| 10  | **Migration Path**     | **Zero-downtime migration**: All new behavior is IR-gated. Existing agents without `hooks`, `escalation`, `behavior_profiles` in their IR see zero behavior change. **HumanTask schema**: 3 new optional fields (`connectorTicketId`, `connectorTicketUrl`, `connectorActionName`) — MongoDB schema-less, no migration script needed. New index `{ 'source.sessionId': 1 }` added via `ensureIndex()` on startup. **VoiceConfigIR extension**: New optional fields (`provider?`, `voice_id?`, `speed?`) — backward compatible, existing IR without these fields continues to work (external provisioning fallback). **HookAction.critical**: New optional boolean, default false — existing hooks (if any IR existed) would not change behavior. **EscalationConfig.connector_action**: New optional string — existing escalation configs without it skip ITSM path. **Deployment order**: Deploy compiler first (new IR fields), then runtime (consumes new fields).                                                                                                                                      |
| 11  | **Rollback Plan**      | **Per-feature rollback**: Each FR is independently deployable. Rollback = revert the specific commit. IR-gated activation means even if compiler produces new fields, old runtime ignores them. **Escalation rollback**: Revert escalation-bridge changes → back to fire-and-forget (current behavior). HumanTask records with ITSM fields are harmless (unused fields in MongoDB). **Hooks rollback**: Remove hook executor calls from reasoning-executor/runtime-executor → hooks become no-op again. No data to clean up. **Profile rollback**: Revert per-turn re-evaluation → back to session-init-only evaluation. Base tool set still works. **Compiler IR rollback**: Optional fields on VoiceConfigIR/HookAction/EscalationConfig are backward-compatible. Old compiler produces IR without them, new runtime falls back gracefully. **Deployed IR blobs post-rollback**: IR blobs already compiled with new optional fields are harmless — unknown fields are ignored by the old runtime. ITSM connector actions configured in DSL silently become no-ops, matching pre-implementation behavior. |
| 12  | **Test Strategy**      | **E2E tests (16 scenarios)**: All via HTTP API against real Express servers (random port, full middleware chain). Seed agents via `compileToResolvedAgent()` with ABL strings. No mocks of codebase components. External services (ITSM connectors, TTS providers, LLM) mocked via DI only. Test harness: `runtime-api-harness` with MongoMemoryServer + redis-server-harness. **Integration tests (12 scenarios)**: Test real service boundaries: EscalationBridge→TransferToolExecutor, ErrorHandlerRouter→RuntimeExecutor, ProfileResolver→ReasoningExecutor, HookExecutor→ToolBindingExecutor. Both services real, not stubbed. **Unit tests (10 scenarios)**: Hook action parsing, profile condition evaluation, OnHumanComplete condition matching, attachment field validation. **Security tests (15 items)**: Cross-tenant 404, cross-project 404, cross-user 404, missing auth 401, insufficient permissions 403. **Performance tests (4 scenarios)**: Hooks latency overhead, concurrent escalation, hook timeout behavior, profile evaluation at scale.                                         |

---

## 5. Data Model

### Modified Collections

#### human_tasks (extend existing)

```typescript
// New fields on IHumanTask interface
interface IHumanTaskExtension {
  connectorTicketId?: string; // ITSM ticket reference (e.g., "INC0012345")
  connectorTicketUrl?: string; // ITSM ticket URL (e.g., "https://instance.service-now.com/...")
  connectorActionName?: string; // Which connector action was invoked (e.g., "servicenow_create_incident")
}

// New index for session-based escalation lookups
// { 'source.sessionId': 1 }
```

**No new collections created.** Session status already includes `"escalated"` — no schema change needed.

### IR Type Extensions (packages/compiler)

```typescript
// VoiceConfigIR — extend existing (schema.ts:23-27)
interface VoiceConfigIR {
  ssml?: string;
  instructions?: string;
  plain_text?: string;
  // NEW:
  provider?: string; // e.g., "elevenlabs", "azure", "google"
  voice_id?: string; // Provider-specific voice identifier
  speed?: number; // Speech rate multiplier (0.5-2.0)
}

// ExecutionConfig — extend existing (schema.ts:390-475)
// VoiceConfigIR does NOT currently exist on ExecutionConfig or AgentIR.
// Decision: Add voice?: VoiceConfigIR to ExecutionConfig.
// Rationale: ExecutionConfig already holds all runtime execution params
// (model, temperature, timeouts, concurrency). Voice provider/voice_id
// is an execution-level concern, not identity or metadata.
// The compiler populates it from DSL EXECUTION: voice: blocks.
interface ExecutionConfig {
  // ... existing fields (mode, hints, timeouts, model, etc.)
  // NEW:
  voice?: VoiceConfigIR; // Agent-level voice configuration
}

// HookAction — extend existing (schema.ts:1345)
interface HookAction {
  call?: string; // Tool name to invoke
  set?: Record<string, string>; // Variables to set
  respond?: string; // Message to send
  // existing: voice_config?, rich_content?, actions?
  // NEW:
  critical?: boolean; // If true, hook failure aborts execution (default: false)
}

// EscalationConfig — extend existing (schema.ts:1241-1246)
interface EscalationConfig {
  triggers: EscalationTrigger[];
  context_for_human: string[];
  on_human_complete: OnHumanComplete[]; // REQUIRED (not optional), may be empty []
  routing?: EscalationRouting; // EXISTING — connection, queue, skills, priority, post_agent, voice, provider_config
  // NEW:
  connector_action?: string; // Connector action name for ITSM webhook
  // Note: connector_action is a flat field on EscalationConfig (not on EscalationRouting)
  // because EscalationRouting describes agent-transfer routing (connection/queue/skills),
  // while connector_action describes an independent ITSM webhook path. Both can fire
  // concurrently on the same escalation — they are orthogonal concerns.
}

// EscalationRouting — existing (schema.ts:1260-1271)
interface EscalationRouting {
  connection: string; // Maps to transfer_to_agent target
  queue?: string; // Maps to set_queue queue name
  skills?: string[]; // Agent filter skills for routing
  priority?: number; // Escalation priority level
  post_agent?: 'return' | 'end'; // What happens after human agent resolves
  voice?: {
    // Voice transfer params
    transfer_method?: 'invite' | 'refer' | 'bye';
    sip_headers?: Record<string, string>;
  };
  provider_config?: Record<string, unknown>;
}
```

### Key Relationships

```
HumanTask.source.sessionId ──▶ Session._id
HumanTask.connectorTicketId ──▶ External ITSM system (ServiceNow/Zendesk)
Session.status "escalated" ◀──▶ HumanTask.status "pending"|"assigned"|"in_progress"
AgentIR.hooks ──▶ HookExecutor (new, runtime)
AgentIR.behavior_profiles ──▶ ProfileResolver (existing, extended)
AgentIR.escalation ──▶ EscalationBridge (existing, extended)
GatherStepIR.on_action ──▶ ActionHandlerIR dispatch (existing IR, new runtime wiring)
GatherStepIR.fields[].attachment ──▶ AttachmentFieldIR validation (existing IR, new runtime wiring)
```

---

## 6. API Design

### New Endpoints

| Method | Path                                                              | Purpose                      | Auth                                          |
| ------ | ----------------------------------------------------------------- | ---------------------------- | --------------------------------------------- |
| POST   | `/api/projects/:projectId/sessions/:sessionId/escalation/resolve` | Resolve an escalated session | `requireProjectPermission('session:execute')` |
| GET    | `/api/projects/:projectId/sessions/:sessionId/escalation`         | Get escalation status        | `requireProjectPermission('session:read')`    |

### Escalation Resolution — Request/Response

```typescript
// POST /api/projects/:projectId/sessions/:sessionId/escalation/resolve
// Request body:
{
  resolution: {
    decision: string;          // "resolved" | "transferred" | "closed"
    notes?: string;            // Human agent notes
    fields?: Record<string, unknown>;  // Custom resolution fields
    respondedBy: string;       // Human agent identifier
  }
}

// Success response:
{
  success: true,
  data: {
    sessionId: string;
    previousStatus: "escalated";
    newStatus: "active" | "completed";
    action: "continue" | "escalate" | "handoff" | "complete";
    humanTaskId: string;
  }
}

// Error responses:
{ success: false, error: { code: "ESCALATION_NOT_FOUND", message: "No active escalation for this session" } }     // 404
{ success: false, error: { code: "ESCALATION_ALREADY_RESOLVED", message: "Escalation already resolved" } }        // 409
{ success: false, error: { code: "SESSION_NOT_ESCALATED", message: "Session is not in escalated state" } }         // 400
```

### Escalation Status — Response

```typescript
// GET /api/projects/:projectId/sessions/:sessionId/escalation
{
  success: true,
  data: {
    status: "pending" | "assigned" | "in_progress" | "completed" | "expired";
    humanTask: {
      id: string;
      priority: string;
      title: string;
      createdAt: string;
      assignedTo?: string;
      connectorTicketUrl?: string;
    };
    session: {
      status: "escalated" | "active";
      escalatedAt: string;
    }
  }
}
```

**Cross-phase note**: The feature spec (section 8) and test spec E2E scenarios use `/api/v1/sessions/:sessionId/...` paths, which are incorrect. The actual codebase session routes use `/api/projects/:projectId/sessions/...` (confirmed in `sessions.ts`). The HLD uses the correct project-scoped paths. The LLD should use these correct paths and note the correction.

### Modified Endpoints

No existing endpoints are modified. The existing `POST /api/projects/:projectId/sessions/:sessionId/messages` endpoint now triggers hooks, profile evaluation, and action handler dispatch internally — but the API contract (request/response shapes) is unchanged.

### Error Responses

| Code                          | HTTP | When                                       |
| ----------------------------- | ---- | ------------------------------------------ |
| `ESCALATION_NOT_FOUND`        | 404  | No HumanTask for session (or cross-tenant) |
| `ESCALATION_ALREADY_RESOLVED` | 409  | HumanTask already in "completed" status    |
| `SESSION_NOT_ESCALATED`       | 400  | Session status is not "escalated"          |
| `INVALID_RESOLUTION`          | 422  | Resolution body fails Zod validation       |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Escalation creation, resolution, and ITSM ticket creation produce audit events via existing `TraceStore`. Hook execution traces include tool names called and variables set. All trace events include `tenantId`, `projectId`, `sessionId` for filterability.
- **Rate Limiting**: Escalation resolution endpoint uses existing `tenantRateLimit` middleware. No new rate limit rules — escalation resolution is low-frequency (human-speed). Hook tool calls go through existing per-session tool rate limiting and count against the same tool invocation quota. Worst case per turn: before_turn CALL + after_turn CALL + N reasoning tool calls = N+2 tool invocations per turn. This is within the existing rate limit budget (tool rate limits are per-session, not per-turn), but agents with aggressive hooks should be monitored via `hook_executed` trace duration.
- **Caching**: No new caching. HumanTask is write-once-read-few. Profile evaluation reads from in-memory IR (loaded at session init). Voice config resolution is per-session, not cacheable across sessions.
- **Encryption**: HumanTask `context_for_human` and resolution `fields` stored in MongoDB — encrypted at rest via existing MongoDB encryption. ITSM webhook payloads transmitted over HTTPS (connector infrastructure handles TLS). No new credential paths — ITSM connectors use existing connector auth (OAuth, API key).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                | Type            | Risk                                                                                                                                                               |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agent-transfer` | Runtime library | LOW — stable, 8 transfer tools implemented. Build has pre-existing TS2353 errors in ivr-digit-input.ts/ivr-menu.ts (non-blocking for transfer_to_agent/set_queue). |
| `packages/connectors`     | Runtime library | LOW — stable connector infrastructure, well-tested. ITSM connector actions are new but follow existing pattern.                                                    |
| `packages/compiler`       | Build-time      | LOW — compiler changes are additive (new optional IR fields, ACTION_HANDLERS compilation). Parser already handles all DSL blocks.                                  |
| `packages/database`       | Runtime library | LOW — HumanTask model extension is optional fields only. No migration needed.                                                                                      |
| MongoDB                   | Infrastructure  | LOW — existing, no version upgrade needed. New index added via `ensureIndex()`.                                                                                    |
| Redis                     | Infrastructure  | LOW — existing, used for session state. No new Redis patterns.                                                                                                     |

### Downstream (depends on this feature)

| Consumer                               | Impact                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio (SpanTree/EventTimeline)        | POSITIVE — new trace events auto-surface in existing viewers. No UI changes needed.                                                                             |
| Agent developers                       | POSITIVE — ABL constructs that were no-ops now work. Breaking change only if agent relied on no-op behavior (unlikely — why write code you know doesn't work?). |
| ITSM integrations (ServiceNow/Zendesk) | NEW — connector actions enable ticket creation. Requires connector configuration per tenant.                                                                    |
| Documentation consumers                | POSITIVE — STATUS.md and ABL_SPEC.md become accurate.                                                                                                           |

---

## 9. Decisions Made & Open Questions

### Decisions Made

1. **ESCALATE timeout behavior**: Auto-resume with `unknown_error` type, routed through agent-level ON_ERROR handler. Configurable timeout at project level (`escalation.defaultTimeout`, default 24h). Matches existing HumanTask `dueAt` + `expired` status pattern.

2. **HOOKS ordering relative to guardrails**: Hooks execute BEFORE input guardrails. Rationale: hooks may set variables that affect guardrail evaluation. Guardrails are the last safety check before LLM call. Order: `before_turn` hooks → input guardrails → LLM → output guardrails → `after_turn` hooks.

3. **OnHumanComplete extensibility**: Keep minimal. `OnHumanComplete` is `{ condition: string; action: string }`. Action string maps to known actions (`continue`, `escalate`, `handoff`, `complete`). If richer post-resolution actions (SET, RESPOND, GOTO) are needed, extend in a follow-up.

4. **ACTION_HANDLERS compiler scope**: Include in this HLD. The compiler change is small (map DSL block to existing `ActionHandlerIR` type), and the feature is not testable without it.

### Open Questions

1. **Hook tool call metering for billing**: Hook tool calls (CALL actions in before_turn/after_turn) execute via ToolBindingExecutor and count against per-session tool invocation quotas. Should they be metered separately for billing purposes, or counted the same as reasoning tool calls? Deferred to billing team.

2. **ITSM connector failure surfacing in Studio**: When an ITSM connector action fails (timeout, auth error), the failure is captured in trace events. Should Studio surface a distinct visual indicator (e.g., warning badge on escalation events), or rely on the generic error trace display? Deferred to Studio UX review.

---

## 10. Detailed Component Design

### 10.1 Hook Executor (`hook-executor.ts`)

**New module**: `apps/runtime/src/services/execution/hook-executor.ts`

Follows the guardrail wiring pattern: dedicated module, called from executors at lifecycle points, trace events at every execution, non-blocking failure by default.

```
Interface:
  executeHook(
    hookType: 'before_agent' | 'after_agent' | 'before_turn' | 'after_turn',
    hooks: HooksConfig | undefined,
    session: RuntimeSession,
    traceStore: TraceStore
  ): Promise<void>

Implementation:
  1. If hooks[hookType] is undefined → return (IR-gated no-op)
  2. Create AbortController with timeout (default 10s)
  3. For each action in hookAction:
     a. CALL → toolBindingExecutor.execute(hookAction.call, session)
     b. SET → session.variables[key] = value for each entry
     c. RESPOND → session.sendMessage(hookAction.respond)
  4. Emit 'hook_executed' trace event (type, duration, success, tool calls)
  5. On error:
     a. If hookAction.critical === true → throw (caller handles)
     b. Else → emit warning trace event, return normally
```

**Key design decisions**:

- Reuses `ToolBindingExecutor` for CALL actions — no duplicate tool dispatch logic
- Timeout via `AbortSignal` — same pattern as `executeWithRetry` in error-handler-router.ts
- Sequential action execution within a hook (CALL → SET → RESPOND order)
- No parallel hook execution (hooks are ordering-sensitive)

### 10.2 Escalation Resolution Handler

**New module**: `apps/runtime/src/services/escalation/resolution-handler.ts`

```
Interface:
  handleResolution(
    sessionId: string,
    tenantId: string,
    projectId: string,
    resolution: ResolutionPayload,
    traceStore: TraceStore
  ): Promise<ResolutionResult>

Implementation:
  1. Find HumanTask: findOne({ 'source.sessionId': sessionId, tenantId })
  2. If not found → throw ESCALATION_NOT_FOUND
  3. If status === 'completed' → throw ESCALATION_ALREADY_RESOLVED
  4. Update HumanTask: status → 'completed', response → resolution data
  5. Evaluate OnHumanComplete[] (required field, may be empty []):
     a. If array is empty → default to 'continue'
     b. For each entry, evaluate condition against resolution data
     c. First matching condition's action is executed
     d. No match → default to 'continue' (resume normal execution)
  6. Resume session:
     a. Set session.status back to 'active'
     b. Trigger resumption (follows await-attachment resumption-service pattern)
  7. Emit 'escalation_resolved' trace event
  8. Return { action, sessionId, newStatus }
```

**Key design decisions**:

- Follows `resumption-service.ts` pattern for session resume (proven with await-attachment)
- OnHumanComplete evaluation is simple string matching (condition → action map)
- Resolution is atomic (HumanTask update + session resume in same transaction context)
- Stateless — any pod can handle the resolution request

### 10.3 Voice Config Resolver

**New module**: `apps/runtime/src/services/voice/voice-config-resolver.ts`

**IR location decision**: `VoiceConfigIR` does NOT currently exist on `ExecutionConfig` or `AgentIR`. This HLD adds `voice?: VoiceConfigIR` to `ExecutionConfig` (schema.ts:390). Rationale: `ExecutionConfig` already holds all runtime execution params (model, temperature, timeouts, concurrency). Voice provider/voice_id is an execution-level concern. The compiler populates it from DSL `EXECUTION: voice:` blocks.

```
Interface:
  resolveVoiceConfig(
    ir: AgentIR,
    effectiveConfig: EffectiveAgentConfig | undefined
  ): VoiceParams

Implementation:
  1. Start with IR base: ir.execution.voice (VoiceConfigIR — new field on ExecutionConfig)
  2. Apply profile override: effectiveConfig?.voiceConfig (if present, overrides base)
  3. Map to TTS params:
     - provider → ttsVendor (KorevgSession constructor param)
     - voice_id → ttsVoice
     - speed → ttsSpeed
  4. Fallback: if provider/voice_id absent, use external provisioning (current behavior)
  5. Emit 'voice_config_resolved' trace event
```

### 10.4 Agent-Level ON_ERROR — Wire Non-Tool Error Sites

**Modified modules**: `apps/runtime/src/services/execution/reasoning-executor.ts`, `apps/runtime/src/services/execution/flow-step-executor.ts`

**Key insight**: The error handler chain is already complete in `error-handler-router.ts` (lines 45-67):

1. Step-level on_error handlers (line 52)
2. Agent-level `error_handling.handlers` — type + subtype match (lines 56-59)
3. Agent-level `error_handling.default_handler` (lines 62-64)

**The gap is NOT the chain — it's the call sites.** Currently `resolveErrorHandler` is only called for `tool_error` (reasoning-executor.ts:2796 creates `ErrorContext` with `type: 'tool_error'`). Non-tool errors (`invalid_input`, `validation_error`, `unknown_error`) are caught by generic try/catch blocks and never routed to the handler chain.

```
Fix: Wire additional error call sites:

  reasoning-executor.ts:
    - Catch blocks for invalid user input → create ErrorContext({ type: 'invalid_input' })
    - Catch blocks for LLM failures → create ErrorContext({ type: 'unknown_error' })
    - Call resolveErrorHandler() at each site → execute matched handler action

  flow-step-executor.ts:
    - GATHER field validation failures → create ErrorContext({ type: 'validation_error' })
    - General execution errors → create ErrorContext({ type: 'unknown_error' })
    - Call resolveErrorHandler() at each site → execute matched handler action

No changes to error-handler-router.ts itself — the chain is correct as-is.
```

### 10.5 IR-Gated Activation Model

Every feature self-gates based on IR field presence. No feature flags needed.

| Feature           | Gate Check                                                                                                                 | No-Op Behavior                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESCALATE          | `ir.escalation !== undefined`                                                                                              | Fire-and-forget (current behavior)                                                                                                                   |
| HOOKS             | `ir.hooks?.before_turn !== undefined` (per hook type)                                                                      | Skip hook execution                                                                                                                                  |
| BEHAVIOR_PROFILES | `ir.behavior_profiles?.length > 0`                                                                                         | Use base tool set                                                                                                                                    |
| Voice IR          | `ir.execution.voice?.provider !== undefined`                                                                               | External provisioning (current behavior)                                                                                                             |
| ACTION_HANDLERS   | `gatherStep.on_action?.length > 0`                                                                                         | Ignore user interactions                                                                                                                             |
| Attachment Fields | `field.attachment !== undefined`                                                                                           | Generic attachment handling                                                                                                                          |
| Agent ON_ERROR    | `ir.error_handling.handlers.some(h => ['invalid_input', 'validation_error', 'unknown_error', 'DEFAULT'].includes(h.type))` | Default error handler only (note: `error_handling` is always present on `AgentIR` — the gate checks whether handlers for non-tool error types exist) |

---

## 11. Implementation Phasing

### Phase 1: Core Infrastructure (Tier 1)

**Scope**: Hook executor, escalation wiring, agent-level ON_ERROR
**Duration**: Independent, parallelizable
**Exit criteria**: E2E tests pass for FR-1, FR-3, FR-8

### Phase 2: Spec Fidelity (Tier 2)

**Scope**: Voice IR, behavior profiles per-turn, ACTION_HANDLERS, GATHER attachments
**Dependencies**: Voice IR depends on compiler change. ACTION_HANDLERS depends on compiler change.
**Exit criteria**: E2E tests pass for FR-4, FR-5, FR-6, FR-7

### Phase 3: Documentation Sync (Tier 3)

**Scope**: STATUS.md, ABL_SPEC.md, TOOLS_AND_GATHER.md
**Dependencies**: All code changes committed
**Exit criteria**: Manual review confirms accuracy

---

## 12. References

- Feature spec: `docs/features/abl-spec-impl-parity.md`
- Test spec: `docs/testing/abl-spec-impl-parity.md`
- Architecture simplification plan: `docs/plans/2026-03-07-architecture-simplification-plan.md`
- Guardrail wiring (canonical pattern): `apps/runtime/src/services/guardrails/output-guardrails.ts`
- Await-attachment resumption pattern: `apps/runtime/src/services/execution/await-attachment-executor.ts`, `apps/runtime/src/services/execution/resumption-service.ts`
- Agent transfer tools: `apps/runtime/src/services/execution/transfer-tool-executor.ts`
- Error handler router: `apps/runtime/src/services/execution/error-handler-router.ts`
- Profile resolver: `apps/runtime/src/services/execution/profile-resolver.ts`
- Voice session: `apps/runtime/src/services/voice/korevg/korevg-session.ts`
