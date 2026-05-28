# LLD: ABL Spec-Implementation Parity

**Feature Spec**: `docs/features/abl-spec-impl-parity.md`
**HLD**: `docs/specs/abl-spec-impl-parity.hld.md`
**Test Spec**: `docs/testing/abl-spec-impl-parity.md`
**Status**: DRAFT
**Date**: 2026-03-25

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                        | Rationale                                                                                                                                                                                                                                  | Alternatives Rejected                                                                                        |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| D-1 | Compiler IR extensions first, then runtime                      | Runtime modules import from `packages/compiler` (Turbo build dependency). IR types must exist before runtime can type-check against them.                                                                                                  | Parallel (type errors), Runtime-first (no types to import)                                                   |
| D-2 | Batch FRs into 6 phases by touched file                         | Reduces merge conflicts. Each phase still independently deployable via IR-gating. Matches architecture simplification Sprint pattern.                                                                                                      | One commit per FR (11+ commits, higher conflict risk), monolithic (too large to review)                      |
| D-3 | Hook executor follows output-guardrails.ts pattern              | Pure function module, called from executors at lifecycle points, trace events, non-fatal by default. Proven pattern — guardrails wired at 5 checkpoints with zero issues.                                                                  | Class-based (unnecessary for stateless hooks), Inline in reasoning-executor (too complex for 3,114 LOC file) |
| D-4 | Resolution handler follows resumption-service.ts pattern        | Class-based with DI, distributed locks, atomic claim. Proven for pod-restart survival with await-attachment.                                                                                                                               | Direct Mongoose operations (no lock safety), EventBus (async, harder to test)                                |
| D-5 | Session routes use `:id` param (not `:sessionId`)               | Existing sessions.ts uses `:id` for session ID with `router.param('id', ...)` ownership check at line 100. New routes inherit this chain.                                                                                                  | New `:sessionId` param (would need duplicate ownership middleware)                                           |
| D-6 | VoiceConfigAST extension required in packages/core              | `VoiceConfigAST` at `packages/core/src/types/agent-based.ts:29-33` only has `ssml?`, `instructions?`, `plainText?`. Parser must populate new fields before compiler can map them.                                                          | Skip parser (compiler can't map fields that don't exist in AST)                                              |
| D-7 | Per-turn profile re-evaluation at reasoning-executor turn start | `assembleProfileContext` uses `turnCount` and `timestamp` — profiles with `WHEN: session.turn_count > 3` only activate after turn 3. Session-init-only evaluation misses these.                                                            | Keep session-init-only (misses turn-count and time-based profiles)                                           |
| D-8 | No adaptation to ToolBindingExecutor for hooks                  | Hook CALL actions use the same `session.toolExecutor.execute(toolName, params)` interface. Session context (tenantId, userId) already available. Tool params come from DSL (static) vs LLM (dynamic) — executor doesn't care about origin. | Wrap in adapter (unnecessary, same interface)                                                                |

### Key Interfaces & Types

```typescript
// NEW: hook-executor.ts interface
export async function executeHook(
  hookType: 'before_agent' | 'after_agent' | 'before_turn' | 'after_turn',
  hooks: HooksConfig | undefined,
  session: RuntimeSession,
  traceStore: TraceStore,
): Promise<void>;

// NEW: resolution-handler.ts interface
export interface ResolutionPayload {
  decision: string;
  notes?: string;
  fields?: Record<string, unknown>;
  respondedBy: string;
}
export interface ResolutionResult {
  action: 'continue' | 'escalate' | 'handoff' | 'complete' | 'backtrack';
  sessionId: string;
  newStatus: 'active' | 'completed';
  humanTaskId: string;
}
export class EscalationResolutionHandler {
  constructor(deps: EscalationResolutionDeps);
  handleResolution(
    sessionId: string,
    tenantId: string,
    projectId: string,
    resolution: ResolutionPayload,
    traceStore: TraceStore,
  ): Promise<ResolutionResult>;
}

// NEW: voice-config-resolver.ts interface
export interface VoiceParams {
  ttsVendor?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
}
export function resolveVoiceConfig(
  ir: AgentIR,
  effectiveConfig?: EffectiveAgentConfig,
): VoiceParams;

// EXTENDED: ErrorContext (error-handler-router.ts:24-30)
// No change to interface — new error types wired through existing interface:
// { type: 'invalid_input' | 'validation_error' | 'unknown_error', message, retryable }
```

### Module Boundaries

| Module                        | Responsibility                                                                        | Depends On                                       |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `hook-executor.ts`            | Execute HOOKS lifecycle actions (CALL/SET/RESPOND)                                    | ToolBindingExecutor, TraceStore, RuntimeSession  |
| `resolution-handler.ts`       | Handle escalation resolution, evaluate OnHumanComplete                                | HumanTask model, ResumptionService, SessionStore |
| `voice-config-resolver.ts`    | Resolve voice params from IR + profile + external                                     | AgentIR, EffectiveAgentConfig                    |
| `routing-executor.ts` (mod)   | Extend handleEscalate(): ITSM connector action, session pause, enhanced trace events  | ConnectorRegistry, HumanTask, LockPort           |
| `escalation-bridge.ts`        | No changes — keeps EventBus→HumanTask creation responsibility only                    | HumanTask                                        |
| `reasoning-executor.ts` (mod) | Hook injection points, per-turn profile re-eval                                       | HookExecutor, ProfileResolver                    |
| `runtime-executor.ts` (mod)   | Session-level hooks (before_agent, after_agent), escalation pause check at turn entry | HookExecutor                                     |
| `flow-step-executor.ts` (mod) | AttachmentFieldIR validation, ActionHandlerIR dispatch                                | AttachmentFieldIR, ActionHandlerIR               |
| `error-handler-router.ts`     | No changes — existing 3-step chain is correct                                         | —                                                |

---

## 2. File-Level Change Map

### New Files

| File                                                               | Purpose                                            | LOC Estimate |
| ------------------------------------------------------------------ | -------------------------------------------------- | ------------ |
| `apps/runtime/src/services/execution/hook-executor.ts`             | Hook lifecycle execution engine                    | ~120         |
| `apps/runtime/src/services/escalation/resolution-handler.ts`       | Escalation resolution + session resume             | ~180         |
| `apps/runtime/src/services/voice/voice-config-resolver.ts`         | Voice IR → TTS params resolution                   | ~60          |
| `apps/runtime/src/__tests__/escalation.e2e.test.ts`                | E2E: ESCALATE agent-transfer + ITSM                | ~300         |
| `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`           | E2E: HOOKS before/after agent/turn                 | ~250         |
| `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`         | E2E: BEHAVIOR_PROFILES overrides                   | ~200         |
| `apps/runtime/src/__tests__/voice-ir-resolution.e2e.test.ts`       | E2E: Voice provider/voice_id from IR               | ~150         |
| `apps/runtime/src/__tests__/action-handlers.e2e.test.ts`           | E2E: ACTION_HANDLERS execution                     | ~200         |
| `apps/runtime/src/__tests__/gather-attachments-e2e.test.ts`        | E2E: GATHER attachment field validation            | ~150         |
| `apps/runtime/src/__tests__/agent-on-error.e2e.test.ts`            | E2E: Agent-level ON_ERROR routing                  | ~200         |
| `apps/runtime/src/__tests__/escalation-integration.test.ts`        | INT: EscalationBridge + Resolution (INT-1,2,10,11) | ~250         |
| `apps/runtime/src/__tests__/hooks-integration.test.ts`             | INT: HookExecutor → ToolBinding (INT-5,6)          | ~150         |
| `apps/runtime/src/__tests__/error-handler-integration.test.ts`     | INT: Error handler routing (INT-3,12)              | ~150         |
| `apps/runtime/src/__tests__/behavior-profiles-integration.test.ts` | INT: Profile per-turn re-eval (INT-4)              | ~120         |
| `apps/runtime/src/__tests__/voice-config-integration.test.ts`      | INT: Voice config resolver (INT-7)                 | ~100         |
| `apps/runtime/src/__tests__/action-handlers-integration.test.ts`   | INT: Action handler dispatch (INT-8)               | ~120         |
| `apps/runtime/src/__tests__/gather-attachment-integration.test.ts` | INT: Attachment field validation (INT-9)           | ~120         |

### Modified Files

| File                                                        | Change Description                                                                                                       | Risk |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| `packages/compiler/src/platform/ir/schema.ts`               | Extend VoiceConfigIR (+3 fields), HookAction (+critical), EscalationConfig (+connector_action), ExecutionConfig (+voice) | Low  |
| `packages/core/src/types/agent-based.ts`                    | Extend VoiceConfigAST with provider?, voiceId?, speed?                                                                   | Low  |
| `packages/compiler/src/platform/ir/compiler.ts`             | Populate voice fields in ExecutionConfig (~line 537), compile ACTION_HANDLERS block                                      | Med  |
| `packages/database/src/models/human-task.model.ts`          | Add 3 ITSM fields + compound `{ source.sessionId, tenantId }` index                                                      | Low  |
| `apps/runtime/src/services/execution/routing-executor.ts`   | Extend handleEscalate(): ITSM connector action, session pause, enhanced trace events                                     | High |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Add hook calls (before_turn/after_turn), per-turn profile re-eval, non-tool error routing                                | High |
| `apps/runtime/src/services/runtime-executor.ts`             | Add hook calls (before_agent/after_agent)                                                                                | Med  |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Wire AttachmentFieldIR validation, non-tool error routing                                                                | Med  |
| `apps/runtime/src/services/execution/profile-resolver.ts`   | Add per-turn re-evaluation call, emit trace events                                                                       | Med  |
| `apps/runtime/src/services/voice/korevg/korevg-session.ts`  | Read voice params from resolver instead of hardcoded defaults                                                            | Med  |
| `apps/runtime/src/routes/sessions.ts`                       | Add escalation resolve + status endpoints                                                                                | Med  |
| `docs/reference/STATUS.md`                                  | Correct guardrails, test counts, file paths                                                                              | Low  |
| `docs/reference/ABL_SPEC.md`                                | Remove partial markers for newly implemented features                                                                    | Low  |
| `docs/reference/TOOLS_AND_GATHER.md`                        | Clarify example tool names vs platform built-ins                                                                         | Low  |

---

## 3. Implementation Phases

### Phase 1: Compiler IR Extensions

**Goal**: Extend all IR types and compiler to produce new fields. Runtime phases depend on these types existing.

**Tasks**:

1.1. Extend `VoiceConfigIR` in `schema.ts` with `provider?: string`, `voice_id?: string`, `speed?: number` (line 23-27)

1.2. Add `voice?: VoiceConfigIR` to `ExecutionConfig` in `schema.ts` (after `inline_gather` at line 474)

1.3. Add `critical?: boolean` to `HookAction` in `schema.ts` (line 1345)

1.4. Add `connector_action?: string` to `EscalationConfig` in `schema.ts` (after `routing` at line 1245)

1.5. Extend `VoiceConfigAST` in `packages/core/src/types/agent-based.ts` with `provider?: string`, `voiceId?: string`, `speed?: number` (line 29-33)

1.6. Update `compileVoiceConfig()` in `compiler.ts` (line 1688-1695) to map `provider`, `voice_id`, `speed` from AST to IR

1.7. Add `voice: compileVoiceConfig(doc.execution?.voice)` to ExecutionConfig compilation in `compiler.ts` (after `inline_gather` at ~line 537)

1.8. Add `voice?: VoiceConfigAST` to `ExecutionConfigAST` in `packages/core/src/types/agent-based.ts` (after `conversation_history_window` at line 1028). This is the AST-level container — the parser populates this, compiler maps it to IR.

1.9. Verify parser handles `EXECUTION: voice:` blocks and populates `doc.execution.voice` with new AST fields. Search for the parser's `EXECUTION:` block handler and extend it to parse nested `voice:` block into `VoiceConfigAST`. If the parser already handles `voice:`, verify it populates the new fields (provider, voiceId, speed).

1.10. Add `critical?: boolean` to `HookAction` in `packages/core/src/types/agent-based.ts` (line 1071-1078). Map it in `compileHookAction()` at `compiler.ts:2352`: `critical: ast.critical`.

1.11. Add `actionHandlers?: ActionHandlerAST[]` to `AgentBasedDocument` interface in `packages/core/src/types/agent-based.ts`. Add `action_handlers?: ActionHandlerIR[]` to `AgentIR` interface in `packages/compiler/src/platform/ir/schema.ts`. Verify parser handles `ACTION_HANDLERS:` block and populates `doc.actionHandlers`.

1.12. Add agent-level ACTION_HANDLERS compilation: `action_handlers: compileActionHandlers(doc.actionHandlers)` in the main compile function (~line 540+). The `compileActionHandlers()` function already exists at line 1746-1758.

1.13. Add `escalation` variant to `SuspendedContinuation` in `packages/execution/src/suspension.ts` (after existing variants ~line 90): `| { type: 'escalation'; escalationConfig: EscalationConfig; humanTaskId: string }`. Add corresponding `escalation` entry to `SuspensionReason` in `packages/execution/src/types.ts` (after existing entries ~line 86): `| { type: 'escalation'; humanTaskId: string; callbackId?: string }`. Without this, Phase 2 session pause (`suspensionStore.save()`) will not compile.

1.14. Run `pnpm build --filter=@abl/compiler --filter=@abl/core --filter=@abl/execution` and fix any type errors

1.15. Add unit tests for new compiler output: verify `VoiceConfigIR.provider/voice_id/speed` populated, `HookAction.critical` field preserved, `EscalationConfig.connector_action` preserved, agent-level `action_handlers` compiled

**Files Touched**:

- `packages/compiler/src/platform/ir/schema.ts` — IR type extensions (VoiceConfigIR, HookAction, EscalationConfig, AgentIR)
- `packages/core/src/types/agent-based.ts` — AST type extensions (VoiceConfigAST, ExecutionConfigAST, HookAction, AgentBasedDocument)
- `packages/compiler/src/platform/ir/compiler.ts` — compilation logic (voice, critical, action_handlers)
- `packages/execution/src/suspension.ts` — SuspendedContinuation 'escalation' variant
- `packages/execution/src/types.ts` — SuspensionReason 'escalation' variant
- `packages/compiler/src/__tests__/` — unit tests for new compilation

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/compiler --filter=@abl/core --filter=@abl/execution` succeeds with 0 type errors
- [ ] Unit test: ABL with `EXECUTION: voice: { provider: elevenlabs, voice_id: aria, speed: 1.2 }` compiles to IR with `execution.voice.provider === 'elevenlabs'`
- [ ] Unit test: ABL with `HOOKS: before_turn: { call: my_tool, critical: true }` compiles to IR with `hooks.before_turn.critical === true`
- [ ] Unit test: ABL with `ESCALATE: connector_action: servicenow_create_incident` compiles to IR with `coordination.escalation.connector_action === 'servicenow_create_incident'`
- [ ] Unit test: ABL with `ACTION_HANDLERS:` block at agent level compiles to `action_handlers: ActionHandlerIR[]`
- [ ] Unit test: ABL with `ON_ERROR: handlers: [{ type: validation_error, then: continue, respond: "Try again" }]` compiles to `error_handling.handlers` with correct type/then/respond mapping
- [ ] Existing compiler tests still pass: `pnpm test --filter=@abl/compiler`

**Test Strategy**:

- Unit: New compiler output assertions for each IR extension
- No integration/E2E at this phase — compiler is a build-time tool

**Rollback**: Revert schema.ts + compiler.ts + agent-based.ts + suspension.ts + types.ts changes. New optional fields are additive — old IR blobs are unaffected. SuspendedContinuation variant harmless if unused.

---

### Phase 2: ESCALATE Production Wiring (FR-1 + FR-2)

**Goal**: Wire ESCALATE to agent-transfer module, add ITSM connector action, implement session pause/resume with resolution API.

**Tasks**:

2.1. Extend HumanTask Mongoose model (`packages/database/src/models/human-task.model.ts`):

- Add `connectorTicketId?: string`, `connectorTicketUrl?: string`, `connectorActionName?: string` to IHumanTask interface (after line 99) and schema (after line 181)
- Add compound index `{ 'source.sessionId': 1, tenantId: 1 }` (after line 193) — supports resolution query and enforces tenant isolation at index level
- Run `pnpm build --filter=@abl/database`

  2.2. Create `apps/runtime/src/services/escalation/resolution-handler.ts`:

- Class-based with DI (follows `resumption-service.ts` pattern)
- Dependencies: HumanTask model, session store, lock manager (LockPort interface)
- `handleResolution()`: find HumanTask by `{ 'source.sessionId': sessionId, tenantId, projectId }`, check status, update to 'completed', evaluate `OnHumanComplete[]` conditions (empty array → default 'continue', iterate entries, first match wins), resume session, emit `escalation_resolved` trace event
- Atomic claim pattern: check-then-update with distributed lock: `lockManager.acquire(\`escalation-resolve:\${sessionId}\`, { keyPrefix: 'escalation', ttlMs: 300000, retryAttempts: 5, retryDelayMs: 200 })`

  2.3. Extend `apps/runtime/src/services/execution/routing-executor.ts` — `handleEscalate()` method (line 2407+):

- **Signature change**: Change from synchronous `handleEscalate(): { success; message; error? }` to `async handleEscalate(): Promise<{ success; message; error? }>`. Update caller in reasoning-executor.ts:2391 from `const result = this.routing.handleEscalate(...)` to `const result = await this.routing.handleEscalate(...)`. Update all 4 test call sites in `escalation-transfer-wiring.test.ts` to use `await`.
- **Agent-transfer already wired** at lines 2487-2560. No changes needed for FR-1 agent-transfer (already maps routing.connection → adapter, routing.queue → queue, routing.skills → skills, routing.priority → priority). Existing fire-and-forget pattern (void IIFE) preserved.
- After agent-transfer block (~line 2560), add ITSM connector action: if `escalationConfig.connector_action` defined, use `createConnectorToolExecutorAdapter(session.tenantId, session.projectId)` to get an executor adapter (same DI pattern as ToolBindingExecutor for connector tools), then `adapter.execute(escalationConfig.connector_action, { context: filterEscalationContext(session, escalationConfig) }, 30000)`. Update HumanTask with returned `ticketId`/`ticketUrl` via `HumanTask.findOneAndUpdate({ 'source.sessionId': session.id, tenantId: session.tenantId }, { connectorTicketId, connectorTicketUrl, connectorActionName })`. Fire-and-forget (void async, log errors) to preserve escalation latency. Emit `itsm_ticket_created` trace event.
- After ITSM block, add session pause: if `escalationConfig.on_human_complete.length > 0`, set `session.isEscalated = true` (already done at line 2444), create `SuspendedExecution` record in MongoDB via `suspensionStore.create(...)` (note: use `create()` not `save()` — see `SuspensionStore` interface at `suspension-store.ts:12`). The `SuspendedExecution` object must include all required fields: `suspensionId`, `executionId`, `sessionId`, `tenantId`, `projectId`, `reason: { type: 'escalation', humanTaskId }`, `continuation: { type: 'escalation', escalationConfig, humanTaskId }`, `channelBinding`, `callbackId`, `status: 'suspended'`, `suspendedAt`, `expiresAt`, `resumeAttempts: 0`. This follows the await-attachment pattern — the session is paused at the persistence layer, not just in memory.
- Emit enhanced `escalation_triggered` trace event with trigger condition, priority, path (agent-transfer/itsm/both), pause status

  2.3b. Add escalation pause check in `apps/runtime/src/services/runtime-executor.ts`:

- At the top of `executeMessage()` (before any processing), check for active escalation: `const suspensions = await suspensionStore.findBySession(sessionId)`, then filter: `suspensions.find(s => s.continuation?.type === 'escalation' && s.status === 'suspended')`. If found and not resolved, return `{ success: false, error: { code: 'SESSION_ESCALATED', message: 'Session is escalated and awaiting human resolution. Use POST /:id/escalation/resolve to resume.' } }` with HTTP 409.
- This prevents message processing while the session is in escalated state — any pod can enforce this check since the suspension is in MongoDB.
- Note: `SuspensionStore.findBySession(sessionId)` returns `SuspendedExecution[]` (actual API at suspension-store.ts:53). Filter locally by continuation type.

  2.4. Add escalation routes to `apps/runtime/src/routes/sessions.ts` (insert after existing `/:id/close` route block, among other `/:id/*` routes — the `router.param('id')` ownership check at line 100 applies automatically):

- `POST /:id/escalation/resolve` — Zod body: `z.object({ resolution: z.object({ decision: z.string().min(1), notes: z.string().optional(), fields: z.record(z.unknown()).optional(), respondedBy: z.string().min(1) }) })`. Auth: `requireProjectPermission('session:execute')`. Calls `resolutionHandler.handleResolution()`.
- `GET /:id/escalation` — Auth: `requireProjectPermission('session:read')`. Returns HumanTask status + ticket URL.
- Error responses: `ESCALATION_NOT_FOUND` (404), `ESCALATION_ALREADY_RESOLVED` (409), `SESSION_NOT_ESCALATED` (400), `INVALID_RESOLUTION` (422)

  2.5. Wire resolution handler into session route file — instantiate `EscalationResolutionHandler` with dependencies from runtime DI container

  2.5b. Register Phase 2 trace event types in `apps/runtime/src/services/trace-event-types.ts` (`TRACE_TO_PLATFORM_TYPE` map):

- `escalation_triggered` → `agent.escalation.triggered`
- `escalation_resolved` → `agent.escalation.resolved`
- `itsm_ticket_created` → `agent.escalation.itsm_created`

  2.6. Write E2E tests (`apps/runtime/src/__tests__/escalation.e2e.test.ts`):

- Use `startRuntimeApiHarness((app) => { app.use('/api/auth', authRouter); app.use('/api/platform/admin/tenants', platformAdminTenantsRouter); app.use('/api/projects/:projectId/sessions', sessionsRouter); })` with explicit route mounting (established E2E pattern, 20+ existing tests)
- Import: `import { compileToResolvedAgent } from '../services/execution/types.js'`
- Import: `import { bootstrapProject, authHeaders, requestJson } from './helpers/channel-e2e-bootstrap.js'`
- Seed agent with ABL containing `ESCALATE:` block via `compileToResolvedAgent()`
- Test: escalation trigger → session status becomes 'escalated' → HumanTask created → resolution API resumes session → on_human_complete action executes
- Test: escalation with `connector_action` → ITSM ticket created (mock connector via DI)
- Test: cross-tenant escalation resolution returns 404
- Test: double resolution returns 409
- Auth context: use `devLogin` + `bootstrapProject` from `channel-e2e-bootstrap.ts`

**Files Touched**:

- `packages/database/src/models/human-task.model.ts` — 3 fields + compound index
- `apps/runtime/src/services/escalation/resolution-handler.ts` — NEW
- `apps/runtime/src/services/execution/routing-executor.ts` — extend handleEscalate() with ITSM + pause
- `apps/runtime/src/services/runtime-executor.ts` — escalation pause check at turn entry
- `apps/runtime/src/routes/sessions.ts` — 2 new endpoints
- `apps/runtime/src/services/trace-event-types.ts` — register escalation trace event types
- `apps/runtime/src/__tests__/escalation.e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime --filter=@abl/database` succeeds with 0 type errors
- [ ] E2E: POST message triggers escalation → session status is 'escalated' (via GET session API)
- [ ] E2E: POST escalation/resolve with valid resolution → session resumes, on_human_complete action matches
- [ ] E2E: POST escalation/resolve with already-resolved → 409
- [ ] E2E: GET escalation for cross-tenant session → 404
- [ ] E2E: Escalation with `connector_action` creates HumanTask with `connectorTicketId` set
- [ ] E2E: ITSM connector failure does not block escalation (fire-and-forget, HumanTask still created)
- [ ] E2E: Escalation resolution by user without `session:execute` permission returns 403
- [ ] E2E: Cross-user escalation GET by non-owner without `session:read` returns 404
- [ ] Trace events: `escalation_triggered` and `escalation_resolved` emitted (verified via trace API)
- [ ] Existing escalation tests still pass

**Integration Tests** (`apps/runtime/src/__tests__/escalation-integration.test.ts` — NEW):

- INT-1: EscalationBridge → TransferToolExecutor → HumanTask creation (real modules, verify session.isEscalated + HumanTask record + agent-transfer adapter called)
- INT-2: ResolutionHandler → HumanTask update → SuspensionStore (verify distributed lock + atomic claim + session resume)
- INT-10: ITSM connector adapter execute with context_for_human payload (DI-mocked external connector, verify payload shape)
- INT-11: Escalation with empty routing config → no agent-transfer call (verify escalation still succeeds as HITL-only)

**Test Strategy**:

- E2E: Real HTTP API via `startRuntimeApiHarness()` with explicit route mounting, `compileToResolvedAgent()` seeding
- Integration: EscalationBridge → TransferToolExecutor, ResolutionHandler → SuspensionStore (real modules, DI-mocked connector for ITSM)
- Unit: OnHumanComplete condition matching, EscalationRouting → tool param mapping

**Rollback**: Revert routing-executor.ts (ITSM + pause additions) + runtime-executor.ts (pause check) + sessions.ts (2 new routes) + resolution-handler.ts. HumanTask ITSM fields are harmless unused MongoDB fields. Session behavior returns to fire-and-forget escalation.

---

### Phase 3: Execution Lifecycle — HOOKS + ON_ERROR (FR-3 + FR-8)

**Goal**: Wire hook lifecycle execution and non-tool error routing through the existing error handler chain.

**Tasks**:

3.1. Create `apps/runtime/src/services/execution/hook-executor.ts`:

- Pure function `executeHook(hookType, hooks, session, traceStore)` following output-guardrails.ts pattern
- IR-gated: if `hooks?.[hookType]` is undefined, return immediately (no-op)
- Overall hook timeout: configurable (default 10s from `hooks.defaultTimeout` config). Guard the entire hook action sequence — if SET/RESPOND follow a CALL, the timeout covers all actions combined.
- Execute actions sequentially:
  - `CALL`: `session.toolExecutor.execute(hookAction.call, {}, timeoutMs)` — ToolBindingExecutor at `session.toolExecutor` (wired at `llm-wiring.ts:433/475/811/821/846`). The tool executor's own timeout parameter handles per-tool timeout.
  - `SET`: `session.data.values[key] = value` for each entry in `hookAction.set`
  - `RESPOND`: push message to session conversation history + emit via `onChunk`
- Emit `hook_executed` trace event (hookType, actionsExecuted, duration, success/failure)
- On error: if `hookAction.critical === true` → throw; else → emit warning trace event, return normally

  3.2. Wire hooks in `apps/runtime/src/services/runtime-executor.ts`:

- At session init (after profile resolution, ~line 761): `await executeHook('before_agent', agentIR.hooks, session, traceStore)`
- At session complete (in session close logic): `await executeHook('after_agent', agentIR.hooks, session, traceStore)`

  3.3. Wire hooks in `apps/runtime/src/services/execution/reasoning-executor.ts`:

- Before input guardrails in the reasoning loop (~line 1070): `await executeHook('before_turn', session.agentIR.hooks, session, traceStore)`
- After output guardrails / after LLM response (~line 1240): `await executeHook('after_turn', session.agentIR.hooks, session, traceStore)`

  3.4. Wire non-tool error routing in `reasoning-executor.ts`:

- Identify catch blocks handling non-tool errors (line 3010 outer catch, lines 2599/2624 guardrail errors)
- At each site, create `ErrorContext({ type: 'unknown_error', message, retryable: false })` and call `resolveErrorHandler(errorCtx, session.agentIR)`
- If resolution exists, execute handler action (continue/escalate/handoff/complete/backtrack)
- Emit `agent_error_handled` trace event

  3.5. Wire non-tool error routing in `flow-step-executor.ts`:

- GATHER field validation failures → `ErrorContext({ type: 'validation_error', message, retryable: false })`
- General execution errors → `ErrorContext({ type: 'unknown_error', message, retryable: false })`
- Call `resolveErrorHandler()` at each site

  3.5b. Register Phase 3 trace event types in `apps/runtime/src/services/trace-event-types.ts`:

- `hook_executed` → `agent.hook.executed`
- `agent_error_handled` → `agent.error.handled`

  3.6. Write E2E tests (`apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`):

- Agent with `HOOKS: before_turn: { call: audit_logger, set: { turn_logged: true } }` → verify tool called, variable set
- Agent with `HOOKS: after_turn: { respond: "Turn complete" }` → verify message in response
- Agent with `HOOKS: before_agent / after_agent` → verify fired on session init/complete
- Hook with `critical: true` that fails → verify turn aborted
- Hook with `critical: false` (default) that fails → verify turn continues

  3.7. Write E2E tests (`apps/runtime/src/__tests__/agent-on-error.e2e.test.ts`):

- Agent with `ON_ERROR: handlers: [{ type: validation_error, then: continue, respond: "Please try again" }]` → send invalid input → verify error handler response
- Agent with `ON_ERROR: default_handler: { then: escalate }` → trigger unknown error → verify escalation

**Files Touched**:

- `apps/runtime/src/services/execution/hook-executor.ts` — NEW
- `apps/runtime/src/services/runtime-executor.ts` — before_agent/after_agent hooks
- `apps/runtime/src/services/execution/reasoning-executor.ts` — before_turn/after_turn hooks + non-tool error routing
- `apps/runtime/src/services/execution/flow-step-executor.ts` — non-tool error routing
- `apps/runtime/src/services/trace-event-types.ts` — register hook/error trace event types
- `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/agent-on-error.e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 type errors
- [ ] E2E: before_turn hook CALL action executes tool (verified via trace events)
- [ ] E2E: before_turn hook SET action sets session variable (verified via session data API)
- [ ] E2E: after_turn hook RESPOND action produces message in conversation
- [ ] E2E: before_agent fires once on session init; after_agent fires once on session complete
- [ ] E2E: Hook execution order: before_turn → guardrails → LLM → guardrails → after_turn
- [ ] E2E: Critical hook failure aborts turn; non-critical hook failure continues
- [ ] E2E: Non-tool error (validation_error) routed to agent-level ON_ERROR handler
- [ ] E2E: ON_ERROR default_handler fires for unknown_error type
- [ ] Trace events: `hook_executed` and `agent_error_handled` emitted
- [ ] Existing reasoning-executor tests still pass
- [ ] Hook execution adds < 100ms overhead per turn (for non-CALL hooks)

**Integration Tests**:

- `apps/runtime/src/__tests__/hooks-integration.test.ts` — NEW:
  - INT-5: HookExecutor → ToolBindingExecutor CALL action (real tool dispatch, verify tool called + result returned)
  - INT-6: HookExecutor with `critical: true` tool failure → error propagation (verify throw vs log-and-continue)
- `apps/runtime/src/__tests__/error-handler-integration.test.ts` — NEW:
  - INT-3: resolveErrorHandler for non-tool errors (validation_error, unknown_error) → verify handler matched + action returned
  - INT-12: Error handler with `then: escalate` action → verify escalation triggered from error path

**Test Strategy**:

- E2E: Real HTTP API, agents seeded with HOOKS/ON_ERROR ABL blocks
- Integration: HookExecutor → ToolBindingExecutor, resolveErrorHandler call sites (real modules, DI-mocked external tools)
- Unit: Hook action parsing, timeout behavior, critical vs non-critical failure

**Rollback**: Remove `executeHook()` calls from reasoning-executor and runtime-executor. Hooks become no-op again. Remove error routing calls — errors go to generic catch blocks.

---

### Phase 4: Profile Per-Turn + Voice IR Resolution (FR-4 + FR-5)

**Goal**: Enable per-turn profile re-evaluation and wire voice config from IR to TTS provider.

**Tasks**:

4.1. Add per-turn profile re-evaluation in `reasoning-executor.ts`:

- First, verify that `session.turnCount` (or equivalent counter) is incremented per turn. If not, add `session.turnCount = (session.turnCount ?? 0) + 1` at the start of each turn in reasoning-executor, before profile re-evaluation. Note: `runtime-executor.ts:754` hardcodes `turnCount: 0` for session init — per-turn profiles would never activate without a counter increment.
- At the start of each turn (before hook execution), call `assembleProfileContext()` with updated session state: `{ channelType, sessionMeta: { isNew: false, language: session.language, turnCount: session.turnCount } }`
- Call `resolveActiveProfiles(agentIR.behavior_profiles, profileCtx)`
- If active profiles changed from `session._activeProfileNames`, call `buildEffectiveConfig(agentIR, activeProfiles)` and update `session._effectiveConfig`
- Emit `behavior_profile_applied` trace event when profiles change (profile names, tools added/hidden count, voice override present)

  4.2. Verify `prompt-builder.ts:646` (`session._effectiveConfig?.tools ?? ir?.tools`) already consumes merged tool set. Confirm TOOLS_ADD/TOOLS_HIDE are reflected in LLM tool calls (this may already work once `_effectiveConfig` is updated per-turn).

  4.3. Create `apps/runtime/src/services/voice/voice-config-resolver.ts`:

- Pure function `resolveVoiceConfig(ir, effectiveConfig)` returning `VoiceParams`
- Priority: profile override (`effectiveConfig?.voiceConfig`) > IR base (`ir.execution.voice`) > external provisioning (return empty)
- Map: `provider` → `ttsVendor`, `voice_id` → `ttsVoice`, `speed` → `ttsSpeed`
- Emit `voice_config_resolved` trace event

  4.4. Wire voice resolver in `korevg-session.ts` (or its router `korevg-router.ts`):

- At voice session creation (~line 278 of korevg-router.ts), call `resolveVoiceConfig(runtimeSession.agentIR, runtimeSession._effectiveConfig)` — `runtimeSession` is available at this point in the handler
- Merge priority (lowest to highest): IR voice config → profile override → connection config → URL params. This preserves existing override behavior while adding IR as the base source.
- Use resolved `ttsVendor`/`ttsVoice` instead of hardcoded defaults (`elevenlabs`, `EXAVITQu4vr4xnSDxMaL`)
- Fallback: if resolver returns empty, use existing external provisioning behavior
- Note: `_effectiveConfig` may not exist at voice session creation time if profile resolution hasn't run. Handle gracefully — resolver returns empty if no config available.

  4.4b. Register Phase 4 trace event types in `apps/runtime/src/services/trace-event-types.ts`:

- `behavior_profile_applied` → `agent.profile.applied`
- `voice_config_resolved` → `agent.voice.config_resolved`

  4.5. Write E2E tests (`apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`):

- Agent with profile `WHEN: session.turn_count > 1` TOOLS_ADD → first turn has base tools, second turn has added tool (verified via trace or tool list API)
- Agent with profile TOOLS_HIDE → hidden tool not in LLM call tool list
- Agent with profile VOICE override → verify voice config changes per-turn

  4.6. Write E2E tests (`apps/runtime/src/__tests__/voice-ir-resolution.e2e.test.ts`):

- **Implementation prerequisite**: Requires Phase 1 VoiceConfigIR extension
- Agent with `EXECUTION: voice: { provider: elevenlabs, voice_id: aria }` → verify TTS provider receives correct vendor/voice (may require DI-mocked TTS provider to capture params)

**Files Touched**:

- `apps/runtime/src/services/execution/reasoning-executor.ts` — per-turn profile re-eval
- `apps/runtime/src/services/execution/profile-resolver.ts` — emit trace events
- `apps/runtime/src/services/execution/types.ts` — add `turnCount?: number` to `RuntimeSession` interface
- `apps/runtime/src/services/voice/voice-config-resolver.ts` — NEW
- `apps/runtime/src/services/voice/korevg/korevg-session.ts` or `korevg-router.ts` — wire resolver
- `apps/runtime/src/services/trace-event-types.ts` — register profile/voice trace event types
- `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/voice-ir-resolution.e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 type errors
- [ ] E2E: Profile with `WHEN: session.turn_count > 1` activates on turn 2 (TOOLS_ADD tool appears in trace)
- [ ] E2E: TOOLS_HIDE removes tool from LLM tool list (tool not available for LLM to call)
- [ ] E2E: `behavior_profile_applied` trace event emitted with profile names and override counts
- [ ] E2E: DSL voice config `{ provider: elevenlabs, voice_id: aria }` reaches TTS session creation
- [ ] E2E: Agent without voice config in IR uses external provisioning (existing behavior unchanged)
- [ ] Existing profile resolver tests still pass
- [ ] Profile per-turn evaluation adds < 1ms overhead (in-memory computation)

**Integration Tests**:

- `apps/runtime/src/__tests__/behavior-profiles-integration.test.ts` — NEW:
  - INT-4: ProfileResolver per-turn re-evaluation → verify active profiles change on turn N based on `WHEN: session.turn_count > N` condition
- `apps/runtime/src/__tests__/voice-config-integration.test.ts` — NEW:
  - INT-7: VoiceConfigResolver with IR + profile override → verify merge priority (IR < profile < connection config)

**Test Strategy**:

- E2E: Real HTTP API, agents with BEHAVIOR_PROFILES and voice config
- Integration: ProfileResolver → ReasoningExecutor, VoiceConfigResolver (real modules, verify tool list and voice config changes)
- Unit: Profile condition evaluation with different turn counts, voice config merge priority

**Rollback**: Revert per-turn evaluation in reasoning-executor (back to session-init-only). Revert voice resolver wiring (back to hardcoded/external defaults).

---

### Phase 5: Flow-Level — ACTION_HANDLERS + GATHER Attachments (FR-6 + FR-7)

**Goal**: Wire ACTION_HANDLERS dispatch and declarative GATHER attachment field validation.

**Tasks**:

5.1. Verify action handler runtime dispatch in `flow-step-executor.ts` (lines 2379-2460):

- Existing logic: reads `SESSION_KEY_ACTION_EVENT`, matches `step.on_action` by `action_id`, executes `set`/`respond`/`transition`
- This already works for inline `on_action` on GATHER steps. The gap is agent-level `ACTION_HANDLERS:` DSL block.
- If Phase 1 added agent-level `action_handlers` to AgentIR, wire the dispatch to also check `agentIR.action_handlers` when no step-level match is found.

  5.2. Wire `AttachmentFieldIR` validation in `flow-step-executor.ts` GATHER handling (~line 3702):

- When collecting attachment fields, read `field.attachment` (`AttachmentFieldIR`)
- Validate: `allowed_mime_types` (reject if file MIME type not in list), `max_file_size_bytes` (reject if file exceeds limit), `category` (tag for classification)
- Forward `processing.ocr_enabled` and `processing.transcription_enabled` to multimodal pipeline
- Reject non-conforming files with error message (not a silent failure)

  5.2b. Register Phase 5 trace event type in `apps/runtime/src/services/trace-event-types.ts`:

- `action_handler_executed` → `flow.action_handler.executed`

  5.3. Write E2E tests (`apps/runtime/src/__tests__/action-handlers.e2e.test.ts`):

- Agent with `ACTION_HANDLERS:` block → user clicks button → handler fires → SET + RESPOND + transition execute
- Agent with `on_action` on GATHER step → same dispatch, verify step-level takes priority

  5.4. Write E2E tests (`apps/runtime/src/__tests__/gather-attachments-e2e.test.ts`):

- Agent with GATHER attachment field: `allowed_mime_types: [image/png], max_file_size_bytes: 1048576` → send valid PNG → accepted. Send invalid JPEG → rejected with error message. Send oversized file → rejected.
- Agent with `processing: { ocr_enabled: true }` → verify OCR flag forwarded (may need DI-mocked multimodal pipeline)

**Files Touched**:

- `apps/runtime/src/services/execution/flow-step-executor.ts` — action handler fallback + attachment validation
- `apps/runtime/src/services/trace-event-types.ts` — register action handler trace event type
- `apps/runtime/src/__tests__/action-handlers.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/gather-attachments-e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] E2E: Button click with matching `action_id` → handler SET/RESPOND/transition execute
- [ ] E2E: Agent-level ACTION_HANDLERS fallback when step-level has no match
- [ ] E2E: GATHER attachment field rejects file with disallowed MIME type (error message in response)
- [ ] E2E: GATHER attachment field rejects file exceeding `max_file_size_bytes` (error message)
- [ ] E2E: GATHER attachment field with `ocr_enabled: true` forwards flag to processing pipeline
- [ ] Trace events: `action_handler_executed` emitted with action_id and result
- [ ] Existing flow-step-executor tests still pass

**Integration Tests**:

- `apps/runtime/src/__tests__/action-handlers-integration.test.ts` — NEW:
  - INT-8: FlowStepExecutor action dispatch → step-level on_action matched → SET/RESPOND/transition executed (real handler matching)
- `apps/runtime/src/__tests__/gather-attachment-integration.test.ts` — NEW:
  - INT-9: GATHER attachment field validation → allowed_mime_types filter + max_file_size_bytes check + processing flags forwarded

**Test Strategy**:

- E2E: Real HTTP API, agents with ACTION_HANDLERS and GATHER attachment fields
- Integration: FlowStepExecutor action dispatch, attachment field validation (real modules)
- Unit: Attachment field validation (MIME type matching, size comparison)

**Rollback**: Revert flow-step-executor changes. Action handlers and attachment fields become unvalidated (current behavior).

---

### Phase 6: Documentation Sync (FR-9)

**Goal**: Update STATUS.md, ABL_SPEC.md, and TOOLS_AND_GATHER.md to reflect reality.

**Tasks**:

6.1. Update `docs/reference/STATUS.md`:

- Correct guardrails row: "not wired" → "wired at 5 checkpoints" with file references
- Update test counts (current: ~14,000+ across all packages)
- Fix stale file paths (`apps/platform` → `apps/runtime`)
- Update "Designed vs Implemented" table with newly wired features
- Add entry for each newly wired feature (HOOKS, ESCALATE, ON_ERROR, etc.)

  6.2. Update `docs/reference/ABL_SPEC.md`:

- Remove `[Partial]` markers from features that are now fully implemented
- Keep `[Roadmap]` on `grant_memory` (still deferred)
- Add note that ESCALATE ITSM integration is new beyond original spec

  6.3. Update `docs/reference/TOOLS_AND_GATHER.md`:

- Add clarifying note: `web_search`, `send_email`, `get_weather` are example tool names, not platform-provided built-in tools
- Clarify that `code_interpreter` is not a platform tool

  6.4. Run `/post-impl-sync abl-spec-impl-parity` to update feature spec, test matrix, and design doc status

**Files Touched**:

- `docs/reference/STATUS.md`
- `docs/reference/ABL_SPEC.md`
- `docs/reference/TOOLS_AND_GATHER.md`
- `docs/features/abl-spec-impl-parity.md` (via post-impl-sync)
- `docs/testing/abl-spec-impl-parity.md` (via post-impl-sync)

**Exit Criteria**:

- [ ] STATUS.md guardrails row says "wired" with correct checkpoint details
- [ ] STATUS.md file paths use `apps/runtime` (not `apps/platform`)
- [ ] STATUS.md test counts are current
- [ ] ABL_SPEC.md has 0-1 `[Partial]` markers remaining (only `grant_memory` stays as `[Roadmap]`)
- [ ] TOOLS_AND_GATHER.md clarifies example tool names
- [ ] Feature spec status updated to reflect implementation state

**Test Strategy**:

- Manual review: all doc changes verified against current codebase state
- No automated tests for documentation

**Rollback**: Git revert documentation commits. Docs return to pre-update state.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This prevents the #1 agent failure mode: writing code that nothing calls.

- [ ] `hook-executor.ts` exported from `apps/runtime/src/services/execution/index.ts`
- [ ] `executeHook()` called from `runtime-executor.ts` (before_agent, after_agent)
- [ ] `executeHook()` called from `reasoning-executor.ts` (before_turn, after_turn)
- [ ] `resolution-handler.ts` instantiated in session routes with DI deps
- [ ] Resolution handler wired to `POST /:id/escalation/resolve` route
- [ ] Escalation status wired to `GET /:id/escalation` route
- [ ] `voice-config-resolver.ts` called from `korevg-router.ts` or `korevg-session.ts` at session creation
- [ ] `routing-executor.ts:handleEscalate()` already wires agent-transfer (existing lines 2487-2560)
- [ ] `routing-executor.ts:handleEscalate()` fires connector action for ITSM when `coordination.escalation.connector_action` defined
- [ ] `routing-executor.ts:handleEscalate()` creates SuspendedExecution for session pause when `on_human_complete.length > 0`
- [ ] `runtime-executor.ts:executeMessage()` checks for escalation suspension at turn entry
- [ ] HumanTask model has 3 new ITSM fields + compound `{ 'source.sessionId': 1, tenantId: 1 }` index
- [ ] `reasoning-executor.ts` calls profile re-evaluation per turn (not just session init)
- [ ] `reasoning-executor.ts` routes non-tool errors through `resolveErrorHandler()`
- [ ] `flow-step-executor.ts` routes validation errors through `resolveErrorHandler()`
- [ ] `flow-step-executor.ts` validates `AttachmentFieldIR` properties in GATHER
- [ ] Agent-level `action_handlers` dispatch wired in `flow-step-executor.ts` (fallback after step-level)
- [ ] All new trace event types emitted: `escalation_triggered`, `escalation_resolved`, `itsm_ticket_created`, `hook_executed`, `behavior_profile_applied`, `action_handler_executed`, `voice_config_resolved`, `agent_error_handled`
- [ ] All 8 new trace types registered in `apps/runtime/src/services/trace-event-types.ts` (`TRACE_TO_PLATFORM_TYPE` map) with corresponding platform event types
- [ ] New Zod schemas defined for escalation resolution request body
- [ ] New routes registered in sessions router (not in a separate file)
- [ ] `apps/runtime/src/services/escalation/index.ts` barrel export created for `EscalationResolutionHandler`
- [ ] `routing-executor.ts:handleEscalate()` signature changed to `async` + caller at reasoning-executor.ts:2391 updated to `await` + 4 test call sites updated

---

## 5. Cross-Phase Concerns

### Database Changes

- **Phase 2**: HumanTask model extends with 3 optional fields + 1 new index. MongoDB schema-less — no migration script. Index added via `ensureIndex()` on model initialization.

### Feature Flags

- **None**. All features use IR-gated activation (HLD section 10.5). If IR field is absent/undefined, feature is a no-op.

### Configuration Changes

No new environment variables. Runtime configuration (per-project):

| Config                      | Level   | Default        | Description                                      |
| --------------------------- | ------- | -------------- | ------------------------------------------------ |
| `escalation.defaultTimeout` | Project | 86400000 (24h) | Max time for human resolution before auto-resume |
| `hooks.defaultTimeout`      | Runtime | 10000 (10s)    | Default timeout per hook execution               |

Note: No `escalation.enableItsmWebhook` toggle — ITSM activation is IR-gated. If `coordination.escalation.connector_action` is present in the compiled IR, ITSM fires. If tenants don't want ITSM, they omit `connector_action` from their ABL. This aligns with the HLD's "no feature flags" stance (section 10.5).

### API Path Correction

The feature spec and test spec use `/api/v1/sessions/:sessionId/...` which is incorrect. The actual routes are `/api/projects/:projectId/sessions/:id/...` (confirmed in `sessions.ts`). The LLD uses the correct paths. The test spec will be corrected during `/post-impl-sync`.

### HLD Deviations

These intentional deviations from the HLD were identified during LLD review:

1. **Escalation wiring location**: HLD section 3 places escalation modifications (session status, agent-transfer, ITSM, pause) in `escalation-bridge.ts`. LLD moves them to `routing-executor.ts:handleEscalate()` because the bridge is an EventBus subscriber with no session access — all session mutation, ITSM connector action, and pause logic require the execution context available in `handleEscalate()`. The bridge retains its original EventBus→HumanTask creation responsibility only.

2. **Compound index**: HLD section 5 defines `{ 'source.sessionId': 1 }` index on HumanTask. LLD upgrades to compound `{ 'source.sessionId': 1, tenantId: 1 }` for tenant isolation at index level — strictly better, no trade-offs.

3. **error-handler-router.ts**: HLD lists as modified file. LLD identifies the 3-step chain is already complete — the fix is at call sites (reasoning-executor, flow-step-executor), not the router itself.

### Cross-Document Corrections (for /post-impl-sync)

These inconsistencies between documents will be corrected during Phase 6 `/post-impl-sync`:

1. **Permission string**: Test spec uses `escalation:resolve` (E2E-1, E2E-15, E2E-16). Correct value is `session:execute` (HLD, LLD). No `escalation:resolve` permission exists in codebase.
2. **Trace event names**: Test spec E2E-13 expects `on_error_handler_executed`. Correct name is `agent_error_handled` (HLD, LLD, registered in trace-event-types.ts).
3. **ITSM config toggle**: Feature spec section 11 lists `escalation.enableItsmWebhook`. Removed in LLD — ITSM is IR-gated via `connector_action` field presence.
4. **Attachment trace event**: Test spec E2E-12 expects `attachment_processing_requested`. Not defined in LLD or HLD — evaluate during implementation whether to add or remove from test spec.

---

## 6. Acceptance Criteria (Whole Feature)

**Production Wired Criterion** — every FR satisfies all 4 conditions:

- [ ] (a) Code path executes at runtime
- [ ] (b) Trace events are emitted
- [ ] (c) E2E tests verify behavior through HTTP API
- [ ] (d) ABL_SPEC.md markers are updated

**Quantitative criteria**:

- [ ] All 16 E2E test scenarios from test spec pass
- [ ] All 12 integration test scenarios from test spec pass
- [ ] 0 ABL spec constructs compile successfully but fail to execute at runtime (false confidence = NONE)
- [ ] STATUS.md accuracy: all rows match code reality
- [ ] ABL_SPEC.md partial markers: 0-1 remaining (only `grant_memory` as Roadmap)
- [ ] Hooks add < 100ms overhead per turn (non-CALL hooks)
- [ ] Profile per-turn evaluation adds < 1ms overhead
- [ ] No regressions: `pnpm build && pnpm test` passes across all packages
- [ ] Feature spec updated with implementation details (via `/post-impl-sync`)
- [ ] Testing matrix updated with actual coverage (via `/post-impl-sync`)

---

## 7. Open Questions

1. ~~Parser handling of EXECUTION: voice: blocks~~ — **CLOSED**: Converted to definitive tasks 1.8 (ExecutionConfigAST voice field), 1.9 (parser verification/extension). VoiceConfigAST extension in task 1.5.

2. ~~Agent-level action_handlers on AgentIR~~ — **CLOSED**: Converted to definitive task 1.11 (add `actionHandlers` to AST + `action_handlers` to IR + parser verification).

3. **Connector DI pattern for ITSM E2E tests**: E2E tests for FR-2 need to mock the ITSM connector (external third-party service). Use `createConnectorToolExecutorAdapter()` with a DI-injected mock connector in the test harness. The adapter pattern is already used by ToolBindingExecutor.
