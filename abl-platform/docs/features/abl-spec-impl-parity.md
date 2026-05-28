# Feature: ABL Spec-Implementation Parity

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `governance`, `customer experience`, `integrations`
**Package(s)**: `apps/runtime`, `packages/compiler`, `packages/core`, `packages/agent-transfer`, `packages/database`, `docs/reference`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/abl-spec-impl-parity.md](../testing/abl-spec-impl-parity.md)
**Last Updated**: 2026-03-24

---

## 1. Introduction / Overview

### Problem Statement

The ABL specification (`docs/reference/ABL_SPEC.md`) defines 15+ major constructs that agent developers use to build conversational agents. The parser and compiler correctly handle all of these constructs — DSL compiles to IR without errors. However, **multiple constructs silently produce no runtime effect**: the IR is generated, but the runtime never executes the corresponding logic. Agent developers write valid ABL (e.g., `ESCALATE:`, `HOOKS:`), get no compilation errors, but the features simply do not work at runtime. Note: TEMPLATES are resolved at compile time via `resolveAllTemplateRefs()` in `compiler.ts:611-620` — the runtime never sees `TEMPLATE(name)` literals. The gap here is limited to runtime-only features.

This creates **false confidence** — the most dangerous category of platform bug. A developer believes their escalation logic, lifecycle hooks, or error recovery are in place, but they are not. `STATUS.md` compounds this by reporting stale information (e.g., listing guardrails as "not wired" when they have been wired since Feb 2026).

### Goal Statement

Close every gap where the ABL spec describes working behavior (no Roadmap marker) but the runtime does not execute it. Every spec-described feature must be **production wired**: code path executes, trace events emitted, E2E tests verify the behavior through the HTTP API. Update all documentation to reflect reality.

### Summary

This feature audits all ABL spec constructs against their runtime implementation, identifies gaps where parsed+compiled IR is not executed, and wires each gap to production. It also corrects stale documentation (STATUS.md, ABL_SPEC.md markers) and aligns type definitions across layers. The "production wired" criterion — execute + trace + E2E test — flows through every deliverable.

---

## 2. Scope

### Goals

- Wire all spec-described constructs to runtime execution (9 confirmed runtime gaps + doc sync)
- ESCALATE: integrate with agent-transfer module for human routing + connector actions for ITSM webhooks (ServiceNow, Zendesk)
- HOOKS: execute before_agent, after_agent, before_turn, after_turn lifecycle hooks
- BEHAVIOR_PROFILES: apply TOOLS_HIDE, TOOLS_ADD, VOICE overrides when WHEN conditions match
- Voice: resolve provider/voice_id from agent IR
- ACTION_HANDLERS: compile and execute explicit action handler DSL blocks
- GATHER-level attachments: wire AttachmentFieldIR with field-specific processing flags
- Agent-level ON_ERROR: handle non-tool errors (invalid_input, validation_error, unknown_error)
- Correct STATUS.md to reflect current state (guardrails wired, test counts, file paths)
- Update ABL_SPEC.md partial/roadmap markers post-implementation
- Emit trace events for every newly wired feature (Core Invariant #4)

### Non-Goals (Out of Scope)

- Full human agent chat UI / agent console (ESCALATE provides API + agent-transfer + ITSM webhook, not a chat bridge)
- Handoff `grant_memory` (explicitly marked Roadmap in spec)
- Breakpoint execution system (separate feature, types-only today)
- Trace export/playback (separate feature)
- Distributed tracing / W3C Trace Context (separate feature)
- Extensions: Scheduling, Localization, Interrupts, Advanced Nodes (all Proposed/Not Implemented)
- Studio UI panels dedicated to new features (generic trace viewers surface events automatically)
- New built-in tools (web_search, code_interpreter — these are NOT platform tools, just test mocks / provider capabilities)

---

## 3. User Stories

1. As an **agent developer**, I want my `ESCALATE:` block to actually route conversations to human agents via the agent-transfer module so that customers reach humans when the AI cannot help.
2. As an **agent developer**, I want my `ESCALATE:` block to optionally create tickets in ServiceNow/Zendesk via connector actions so that ITSM workflows are triggered automatically.
3. As an **agent developer**, I want my `HOOKS: before_turn` / `after_turn` blocks to execute tool calls and SET operations so that I can implement audit logging and metrics per conversation turn.
4. As an **agent developer**, I want `BEHAVIOR_PROFILES` TOOLS_ADD / TOOLS_HIDE / VOICE overrides to apply at runtime so that agent capabilities adapt based on channel, user tier, or other context.
5. As an **agent developer**, I want `voice: { provider: elevenlabs, voice_id: aria }` in my DSL to be resolved from IR and passed to the TTS provider so that I can control voice selection declaratively.
6. As an **agent developer**, I want `ACTION_HANDLERS:` to execute SET / RESPOND / THEN logic when a user clicks a button or selects a dropdown so that interactive actions have explicit handler logic.
7. As an **agent developer**, I want GATHER fields with `type: attachment` to respect `ocr_enabled`, `transcription_enabled`, and `max_file_size` from the IR so that attachment collection is declarative, not ad-hoc tool calls.
8. As an **agent developer**, I want agent-level `ON_ERROR:` handlers for `invalid_input`, `validation_error`, and `unknown_error` to execute so that my agents recover gracefully from non-tool errors.
9. As a **platform operator**, I want STATUS.md to accurately reflect the current implementation state so that I can make informed deployment decisions.

---

## 4. Functional Requirements

> **Production Wired Criterion**: Every FR below is only satisfied when (a) the code path executes at runtime, (b) trace events are emitted, (c) E2E tests verify the behavior through the HTTP API, and (d) ABL_SPEC.md markers are updated.

1. **FR-1 (ESCALATE — Agent Transfer)**: Today, `escalation-bridge.ts` creates a HumanTask record (type `'escalation'`) on escalation events in a fire-and-forget manner. The system must extend this to: (a) transition session status to `"escalated"` (the status value already exists in the session type), (b) pause the session when `on_human_complete` is defined in the IR, (c) wire escalation to the agent-transfer module (`transfer_to_agent` / `set_queue` via `TransferToolExecutor`), (d) provide a resolution API that resumes the session with human resolution data, and (e) evaluate the `on_human_complete` entries (`OnHumanComplete[]` from `EscalationConfig` — each is `{ condition: string; action: string }` where action is a known value like `continue`, `escalate`, `handoff`, `complete`). **Note**: If richer post-resolution actions (SET, RESPOND, GOTO) are needed, `OnHumanComplete` must be extended — this should be decided during HLD.

2. **FR-2 (ESCALATE — ITSM Webhook)**: The system must support an optional connector action that fires when an escalation triggers. This is a **new capability** beyond the ABL spec (which defines `triggers`, `context_for_human`, `on_human_complete` but not ITSM integration) — it is bundled here because production-viable escalation requires external ticket creation. The connector action uses the existing `connector` tool_type infrastructure (`packages/connectors`). The ITSM path and agent-transfer path are not mutually exclusive — both can fire on the same escalation. The ITSM connector action reference and resulting ticket ID/URL must be stored on the HumanTask record.

3. **FR-3 (HOOKS Lifecycle)**: The system must execute `before_agent`, `after_agent`, `before_turn`, and `after_turn` hooks defined in `AgentIR.hooks` (type `HooksConfig` with `HookAction` entries). Hooks may contain CALL (tool invocation), SET (variable assignment), and RESPOND (message) actions. Hook execution must emit `hook_executed` trace events.

4. **FR-4 (BEHAVIOR_PROFILES Overrides)**: The system must evaluate all behavior profiles (`BehaviorProfileIR[]`) whose `WHEN` condition is true, merge them by priority, and apply: (a) `TOOLS_ADD` — inject additional tool definitions into the agent's tool set for the current turn, (b) `TOOLS_HIDE` — remove named tools from the tool set, (c) `VOICE` — override voice config for the current turn. Profile application must emit `behavior_profile_applied` trace events.

5. **FR-5 (Voice IR Resolution)**: The current `VoiceConfigIR` type (`schema.ts:23-27`) only has `ssml?`, `instructions?`, `plain_text?` — it **lacks** `provider`, `voice_id`, and `speed` fields. The system must: (a) extend `VoiceConfigIR` with `provider?`, `voice_id?`, `speed?` fields (compiler IR change), (b) ensure the compiler populates these from DSL `EXECUTION: voice:` blocks, and (c) wire the runtime to read these values and pass them to the TTS provider. This is a **compiler + runtime gap**, not runtime-only. ABL_SPEC.md line 1277 explicitly confirms: "provider and voice_id fields are not yet resolved from agent IR."

6. **FR-6 (ACTION_HANDLERS)**: The `ActionHandlerIR` type exists in `schema.ts` (fields: `action_id`, `condition?`, `respond?`, `voice_config?`, `rich_content?`, `set?`, `transition?`) and appears as `on_action?: ActionHandlerIR[]` on `GatherStepIR`. The compiler must compile explicit `ACTION_HANDLERS:` DSL blocks to these IR entries, and the runtime must execute the corresponding handler (SET, RESPOND, transition) when a user interaction is received with a matching action ID. **Note**: This is both a compiler AND runtime gap — the explicit `ACTION_HANDLERS:` DSL block is not yet compiled, despite `ActionHandlerIR` existing in the schema.

7. **FR-7 (GATHER Attachment Fields)**: The system must respect `AttachmentFieldIR` properties (`category`, `allowed_mime_types`, `max_file_size`, `processing.ocr_enabled`, `processing.transcription_enabled`) when collecting attachments via GATHER fields. Validation must reject files that don't match constraints. Processing flags must be forwarded to the multimodal pipeline.

8. **FR-8 (Agent-Level ON_ERROR)**: The system must evaluate agent-level ON_ERROR handlers for non-tool errors: `invalid_input` (unparseable user message), `validation_error` (field validation failure), `unknown_error` (catch-all). The ErrorHandlerRouter's resolution chain must include agent-level handlers after step-level handlers.

9. **FR-9 (Documentation Sync)**: The system must update: (a) STATUS.md — correct guardrails to "wired", update test counts, fix stale file paths (`apps/platform` → `apps/runtime`), (b) ABL_SPEC.md — remove partial markers for features that become fully implemented, (c) TOOLS_AND_GATHER.md — clarify that `web_search`, `send_email`, `get_weather` are example names, not platform-provided built-in tools.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                            |
| -------------------------- | ------------ | ---------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project-level changes                                         |
| Agent lifecycle            | PRIMARY      | 7 constructs gain runtime execution                              |
| Customer experience        | PRIMARY      | Escalation, voice, interactive actions directly affect end users |
| Integrations / channels    | PRIMARY      | ITSM webhooks, voice provider, channel-specific templates        |
| Observability / tracing    | SECONDARY    | New trace event types for each wired feature                     |
| Governance / controls      | SECONDARY    | ESCALATE audit trail, ON_ERROR handling improve governance       |
| Enterprise / compliance    | SECONDARY    | Escalation to ITSM systems is an enterprise requirement          |
| Admin / operator workflows | SECONDARY    | STATUS.md accuracy affects operator decisions                    |

### Related Feature Integration Matrix

| Related Feature                             | Relationship Type | Why It Matters                                                                                   | Key Touchpoints                                        | Current State                            |
| ------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------- |
| [Agent Transfer](agent-transfer.md)         | depends on        | ESCALATE routes to human agents via agent-transfer module                                        | `packages/agent-transfer`, `transfer-tool-executor.ts` | Agent transfer works; ESCALATE not wired |
| [Connectors](connectors.md)                 | depends on        | ITSM webhook uses connector actions                                                              | `packages/connectors`, `connector-to-tool.ts`          | Connectors work; ESCALATE doesn't use    |
| [Attachments](attachments.md)               | extends           | GATHER attachment fields extend existing attachment tool infrastructure                          | `attachment-tool-executor.ts`, multimodal pipeline     | Tools work; GATHER-level IR not wired    |
| [Voice Capabilities](voice-capabilities.md) | extends           | Voice IR resolution extends existing voice channel support                                       | `korevg-session.ts`, `S2SSessionBridge.ts`             | Voice works; DSL voice config ignored    |
| [Guardrails](guardrails.md)                 | shares data with  | Already wired — STATUS.md correction only                                                        | `output-guardrails.ts`, `reasoning-executor.ts`        | Fully wired, docs stale                  |
| [ABL Language](abl-language.md)             | depends on        | Parser and compiler must produce correct IR for all constructs before runtime can wire execution | `agent-based-parser.ts`, `compiler.ts`                 | Parser/compiler complete                 |

---

## 6. Design Considerations

### ESCALATE Dual-Path Architecture

```
ESCALATE trigger fires
    ├── Path A: Agent Transfer
    │   ├── Session state → "escalated"
    │   ├── HumanTask created with context_for_human
    │   ├── transfer_to_agent via packages/agent-transfer
    │   ├── Human resolves → resolution data returned
    │   └── on_human_complete IR executed
    │
    └── Path B: ITSM Webhook (optional, concurrent)
        ├── Connector action fires (ServiceNow/Zendesk/custom)
        ├── Ticket ID returned and stored in session
        └── Ticket reference included in escalation context
```

Both paths can fire on the same escalation event. Path B is opt-in via a `connector_action` field in the ESCALATE IR.

### HOOKS Execution Model

Hooks execute synchronously within the request lifecycle:

- `before_agent` → session init (once per session)
- `before_turn` → before LLM call (every turn)
- `after_turn` → after LLM response (every turn)
- `after_agent` → session complete (once per session)

Hook failures are non-fatal by default — they emit error trace events but do not block the main execution path. **Note**: `HookAction` (`schema.ts:1345`) currently has no `critical` field. If abort-on-failure semantics are needed, a `critical?: boolean` field must be added to `HookAction` (compiler IR change). This decision should be made during HLD.

---

## 7. Technical Considerations

### Runtime is the Primary Target

Most gaps are in the runtime layer. Two exceptions require compiler IR changes:

1. **ACTION_HANDLERS** — the explicit `ACTION_HANDLERS:` DSL block is not yet compiled to `ActionHandlerIR[]` (the IR type exists but the compiler doesn't produce it from the standalone block).
2. **VoiceConfigIR** — the IR type (`schema.ts:23-27`) lacks `provider`, `voice_id`, `speed` fields. These must be added to the IR and populated by the compiler from DSL `EXECUTION: voice:` blocks.

All other work is uniformly about wiring existing IR data to execution logic in `apps/runtime/src/services/execution/`.

### Backward Compatibility

Two items require careful backward-compat handling:

1. **ESCALATE pause** — Sessions currently continue after escalation (fire-and-forget). Activate pause only when `on_human_complete` is defined in DSL. Otherwise, maintain current fire-and-forget behavior.
2. **HOOKS execution** — Previously no-op HOOKS blocks now execute tool calls. Validate hook tool references at compile time to catch broken references before runtime.

Note: TEMPLATES are NOT a backward-compat concern — `resolveAllTemplateRefs()` in `compiler.ts:611-620` resolves `TEMPLATE(name)` references at compile time. By the time IR reaches the runtime, respond fields contain resolved text. An undefined template throws error `E601` at compile time. Channel-specific variants are compiled to `RichContentIR` on IR nodes.

### Agent Transfer Integration

The agent-transfer module (`packages/agent-transfer`) already provides: `transfer_to_agent`, `check_hours`, `check_availability`, `set_queue`, `ivr_menu`, `ivr_digit_input`, `call_transfer`, `deflect_to_chat`. ESCALATE wiring reuses these tools rather than building new escalation infrastructure. The `TransferToolExecutor` at `apps/runtime/src/services/execution/transfer-tool-executor.ts` handles dispatch.

### Connector Action Integration for ITSM

The connector infrastructure (`packages/connectors`, tool_type `'connector'`) already supports executing external API actions. ITSM webhook support means: (1) allow ESCALATE IR to reference a connector action, (2) execute the action with escalation context as payload, (3) store the returned ticket/incident ID in the session.

---

## 8. How to Consume

### Studio UI

No new Studio UI required. All newly wired features emit trace events that surface automatically in:

- **SpanTree** — hook execution, template resolution, profile application spans
- **EventTimeline** — escalation, error handling, voice config events
- **ConstraintMonitor** — escalation trigger condition evaluation

### API (Runtime)

| Method | Path                                             | Purpose                                                  |
| ------ | ------------------------------------------------ | -------------------------------------------------------- |
| POST   | `/api/v1/sessions/:sessionId/escalation/resolve` | Resolve an escalated session (human completes)           |
| GET    | `/api/v1/sessions/:sessionId/escalation`         | Get escalation status and HumanTask details              |
| POST   | `/api/v1/sessions/:sessionId/messages`           | Existing — now triggers hooks, template resolution, etc. |

### API (Studio)

N/A — no new Studio API routes. Existing trace/session APIs surface the new data.

### Admin Portal

N/A — no admin-facing changes.

### Channel / SDK / Voice / A2A / MCP Integration

- **Voice**: DSL-specified `provider` and `voice_id` now reach the TTS provider. Existing voice channel infrastructure (Jambonz, ElevenLabs) receives these values.
- **SDK/Web**: `ACTION_HANDLERS` execute when SDK posts user interaction events. BEHAVIOR_PROFILES adapt tool sets based on channel context.
- **A2A**: Not affected.
- **MCP**: Not affected.

---

## 9. Data Model

### Collections / Tables

```text
Collection: human_tasks (existing — extend for ITSM)
Model: packages/database/src/models/human-task.model.ts

EXISTING STRUCTURE (IHumanTask):
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - type: 'approval' | 'data_entry' | 'review' | 'decision' | 'escalation'
  - status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'expired' | 'cancelled'
  - priority: 'low' | 'medium' | 'high' | 'critical'
  - title: string
  - description?: string
  - source: IHumanTaskSource (discriminated union):
    | { type: 'agent_escalation', sessionId: string, agentName: string }
    | { type: 'workflow_approval', workflowId, executionId, stepId }
    | { type: 'workflow_human_task', workflowId, executionId, stepId }
  - assignedTo?: string
  - assignedToTeam?: string
  - claimedBy?: string
  - fields: IHumanTaskFieldDef[]
  - context: Record<string, unknown>  ← escalation context_for_human goes here
  - response?: IHumanTaskResponse:
      { respondedBy: string, respondedAt: Date, fields: Record<string, unknown>, notes?: string, decision?: string }
  - dueAt?: Date
  - slaBreachedAt?: Date
  - escalationChain: string[]
  - currentEscalationLevel: number
  - createdAt, updatedAt: Date

EXISTING INDEXES:
  - { tenantId: 1, projectId: 1, status: 1, createdAt: -1 }
  - { 'source.type': 1, 'source.executionId': 1, 'source.stepId': 1 }
  - { status: 1, dueAt: 1 }

NEW FIELDS (for ITSM integration):
  - connectorTicketId?: string      ← ITSM ticket reference
  - connectorTicketUrl?: string     ← ITSM ticket URL
  - connectorActionName?: string    ← Which connector action was invoked

NEW INDEX (for session lookup):
  - { 'source.sessionId': 1 }      ← Needed for escalation resolution by session ID
```

```text
Session status enum (already includes "escalated"):
  'active' | 'waiting' | 'completed' | 'escalated' | 'suspended' | 'human_agent'
  Source: apps/runtime/src/services/session/types.ts:140
  No model change needed — verify escalation-bridge sets this status.
```

### Key Relationships

- HumanTask.source.sessionId → Session.\_id (via discriminated `agent_escalation` source)
- HumanTask.connectorTicketId → External ITSM system ticket
- Session.status `"escalated"` ↔ HumanTask.status `"pending"` | `"assigned"` | `"in_progress"`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                           | Purpose                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `apps/runtime/src/services/escalation-bridge.ts`                               | Existing escalation bridge — extend for agent-transfer |
| `apps/runtime/src/services/execution/transfer-tool-executor.ts`                | Agent transfer dispatch — ESCALATE wires here          |
| `apps/runtime/src/services/execution/reasoning-executor.ts`                    | Main reasoning loop — add hooks, template resolution   |
| `apps/runtime/src/services/execution/flow-step-executor.ts`                    | Flow execution — add hooks, template resolution        |
| `apps/runtime/src/services/execution/error-handler-router.ts`                  | Error routing — extend for agent-level non-tool errors |
| `apps/runtime/src/services/execution/routing-executor.ts`                      | Routing — behavior profile override application        |
| `apps/runtime/src/services/voice/korevg/korevg-session.ts`                     | Voice session — read IR voice config                   |
| `apps/runtime/src/tools/attachment-tool-executor.ts`                           | Attachment tools — GATHER-level field validation       |
| `packages/compiler/src/platform/ir/compiler.ts`                                | Compiler — ACTION_HANDLERS compilation                 |
| `packages/compiler/src/platform/ir/schema.ts`                                  | IR schema — verify types exist for all gaps            |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Tool dispatch — connector action for ITSM              |

### Routes / Handlers

| File                                  | Purpose                                   |
| ------------------------------------- | ----------------------------------------- |
| `apps/runtime/src/routes/sessions.ts` | Session routes — add escalation endpoints |

### Tests

| File                                                         | Type | Coverage Focus                           |
| ------------------------------------------------------------ | ---- | ---------------------------------------- |
| `apps/runtime/src/__tests__/escalation.e2e.test.ts`          | e2e  | ESCALATE agent-transfer + ITSM webhook   |
| `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`     | e2e  | HOOKS before/after agent/turn            |
| `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`   | e2e  | BEHAVIOR_PROFILES overrides              |
| `apps/runtime/src/__tests__/voice-ir-resolution.e2e.test.ts` | e2e  | Voice provider/voice_id from IR          |
| `apps/runtime/src/__tests__/action-handlers.e2e.test.ts`     | e2e  | ACTION_HANDLERS execution                |
| `apps/runtime/src/__tests__/gather-attachments-e2e.test.ts`  | e2e  | GATHER attachment field validation       |
| `apps/runtime/src/__tests__/agent-on-error.e2e.test.ts`      | e2e  | Agent-level ON_ERROR for non-tool errors |

---

## 11. Configuration

### Environment Variables

No new environment variables required. All features use existing infrastructure (agent-transfer, connectors, voice providers).

### Runtime Configuration

| Config                         | Level   | Description                                                |
| ------------------------------ | ------- | ---------------------------------------------------------- |
| `escalation.defaultTimeout`    | Project | Max time to wait for human resolution before expiring (ms) |
| `escalation.enableItsmWebhook` | Project | Enable/disable ITSM connector action on escalation         |

### DSL / Agent IR / Schema

IR types in `packages/compiler/src/platform/ir/schema.ts`:

- `EscalationConfig` (line 1241) — with `EscalationTrigger[]`, `context_for_human: string[]`, `OnHumanComplete[]`
- `HooksConfig` (line 1357) / `HookAction` (line 1345) — `before_agent?`, `after_agent?`, `before_turn?`, `after_turn?`, each a `HookAction` with `call?`, `set?`, `respond?`
- Templates — `AgentIR.templates: Record<string, string>` (line 186) + `RichContentIR` for channel variants. **No dedicated template IR type** — templates are resolved at compile time.
- `BehaviorProfileIR` (line 209) — WHEN, TOOLS_ADD, TOOLS_HIDE, VOICE
- `VoiceConfigIR` (line 23) — **currently only**: `ssml?`, `instructions?`, `plain_text?`. **Must extend with**: `provider?`, `voice_id?`, `speed?` (compiler IR change)
- `ActionHandlerIR` (line 83) — `action_id`, `condition?`, `respond?`, `set?`, `transition?`. Appears as `on_action?: ActionHandlerIR[]` on `GatherStepIR` (line 1653). **Note**: IR type exists but the standalone `ACTION_HANDLERS:` DSL block compilation is not yet implemented.
- `AttachmentFieldIR` (line 1001) — category, mime types, size limits, processing flags

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Project isolation | HumanTask records scoped by `projectId`. Escalation resolution API requires `requireProjectPermission()`. |
| Tenant isolation  | HumanTask records scoped by `tenantId`. All queries use `findOne({_id, tenantId})`.                       |
| User isolation    | Session escalation visible only to session owner and agents with escalation permissions.                  |

### Security & Compliance

- ESCALATE context_for_human may contain PII — apply trace scrubbing (existing `TraceScrubber`)
- ITSM webhook payloads must not leak session data beyond what's configured in `context_for_human`
- Connector actions for ITSM use existing connector auth (OAuth, API key) — no new credential paths
- Hook tool calls go through existing SSRF protection and tool middleware chain

### Performance & Scalability

- HOOKS add 2 tool calls per turn (before_turn + after_turn) — measure latency impact
- TEMPLATES resolution is string lookup + interpolation — negligible latency
- BEHAVIOR_PROFILES evaluation is in-memory condition check — negligible latency
- ESCALATE session pause releases the LLM context — no resource held during human resolution

### Reliability & Failure Modes

- Hook failure: non-fatal by default, logged as warning trace event, main execution continues
- ESCALATE agent-transfer failure: session remains active, emit error trace event, retry via existing error handler
- ITSM webhook failure: non-blocking, emit error trace event, escalation continues without ticket
- Voice IR resolution failure: fall back to external provisioning (current behavior)

### Observability

New trace event types:

- `escalation_triggered` — trigger condition, priority, reason
- `escalation_resolved` — resolution data, human agent, duration
- `hook_executed` — hook type, tool called, duration
- `behavior_profile_applied` — profile name, overrides applied
- `action_handler_executed` — action ID, handler result
- `voice_config_resolved` — provider, voice_id, source (IR vs external)

### Data Lifecycle

- HumanTask records: retain for 90 days (configurable per tenant), then archive
- ITSM ticket references: retain as long as the session is retained
- Hook execution traces: follow standard trace retention policy

---

## 13. Delivery Plan / Work Breakdown

**Sequencing**: Tier 1 items (1-3) are independent and can be parallelized. Tier 2 items 4-5 have a dependency (Voice IR depends on BEHAVIOR_PROFILES VOICE override wiring). Tier 2 item 6 (ACTION_HANDLERS) has a compiler prerequisite before runtime work. Tier 3 (doc sync) runs after all code changes are committed.

### Tier 1 — Must Fix (Execution Correctness)

1. **ESCALATE Production Wiring**
   1.1 Verify that `escalation-bridge.ts` sets session status to `"escalated"` when trigger fires (status value already exists in session types)
   1.2 Wire `escalation-bridge.ts` to agent-transfer module (`transfer_to_agent`, `set_queue` via `TransferToolExecutor`)
   1.3 Implement session pause on escalation trigger (only when `on_human_complete` defined in `EscalationConfig`)
   1.4 Add `POST /api/v1/sessions/:sessionId/escalation/resolve` endpoint
   1.5 Execute `OnHumanComplete[]` IR block when resolution received (map to `IHumanTaskResponse`)
   1.6 Add connector action support for ITSM webhooks (ServiceNow, Zendesk) — new capability beyond spec
   1.7 Extend HumanTask model with `connectorTicketId`, `connectorTicketUrl`, `connectorActionName` fields
   1.8 Add `{ 'source.sessionId': 1 }` index for session-based escalation lookups
   1.9 Emit `escalation_triggered` and `escalation_resolved` trace events
   1.10 E2E tests: escalation → agent-transfer → resolution → on_human_complete
   1.11 E2E tests: escalation → ITSM webhook → ticket created

2. **HOOKS Lifecycle Execution**
   2.1 Add hook execution to session init (`before_agent`) and session complete (`after_agent`)
   2.2 Add hook execution to turn boundaries (`before_turn`, `after_turn`) in reasoning-executor and flow-step-executor
   2.3 Hook actions: CALL (tool invocation via ToolBindingExecutor), SET (variable assignment), RESPOND (message) — per `HookAction` type
   2.4 Hook failure handling: non-fatal by default (note: `HookAction` lacks `critical` field — if abort-on-failure needed, extend IR in compiler)
   2.5 Emit `hook_executed` trace events
   2.6 Compile-time validation: verify hook tool references exist in agent's TOOLS section
   2.7 E2E tests: hooks fire in correct order, tool calls execute, variables set

3. **Agent-Level ON_ERROR**
   3.1 Extend ErrorHandlerRouter resolution chain: step-level → agent-level for non-tool errors
   3.2 Handle error types: `invalid_input`, `validation_error`, `unknown_error`
   3.3 Execute handler actions (RESPOND, SET, GOTO, RETRY) from agent-level ON_ERROR IR
   3.4 E2E tests: non-tool errors routed to agent-level handlers, recovery actions execute

### Tier 2 — Should Fix (Spec Fidelity)

4. **Voice IR Resolution** (compiler + runtime gap)
   4.1 Extend `VoiceConfigIR` in `schema.ts` with `provider?: string`, `voice_id?: string`, `speed?: number`
   4.2 Update compiler to populate new fields from DSL `EXECUTION: voice:` blocks
   4.3 Read `provider` and `voice_id` from VoiceConfigIR in voice session initialization
   4.4 Pass resolved values to TTS provider (KoreVG, ElevenLabs, Azure)
   4.5 Behavior profile VOICE overrides applied before TTS call
   4.6 Fall back to external provisioning when IR values absent
   4.7 Emit `voice_config_resolved` trace events
   4.8 E2E tests: DSL voice config reaches TTS provider

5. **BEHAVIOR_PROFILES Overrides**
   5.1 Evaluate active profiles and merge by priority (existing evaluation works)
   5.2 Apply TOOLS_ADD: inject additional tool definitions into current turn's tool set
   5.3 Apply TOOLS_HIDE: remove named tools from current turn's tool set
   5.4 Apply VOICE: override voice config for current turn
   5.5 Emit `behavior_profile_applied` trace events
   5.6 E2E tests: tools added/hidden based on channel context, voice overridden

6. **ACTION_HANDLERS Compilation & Execution** (compiler + runtime gap)
   6.1 Add compilation of standalone `ACTION_HANDLERS:` DSL block to `ActionHandlerIR[]` entries in compiler (the IR type exists at `schema.ts:83`, but the compiler doesn't produce it from the standalone block)
   6.2 Wire action handler dispatch in runtime when user interaction events arrive
   6.3 Execute handler actions: SET (`set`), RESPOND (`respond`), transition (`transition`) — per `ActionHandlerIR` fields
   6.4 Match incoming action ID to `ActionHandlerIR.action_id` from `GatherStepIR.on_action[]`
   6.5 Emit `action_handler_executed` trace events
   6.6 E2E tests: button click → handler fires → SET + RESPOND + transition

7. **GATHER Attachment Fields**
   7.1 Read AttachmentFieldIR properties during gather field collection
   7.2 Validate incoming attachments against `category`, `allowed_mime_types`, `max_file_size`
   7.3 Forward `processing.ocr_enabled`, `processing.transcription_enabled` to multimodal pipeline
   7.4 Reject non-conforming files with appropriate error message
   7.5 E2E tests: attachment validation, processing flag forwarding

### Tier 3 — Documentation Sync

8. **STATUS.md Update**
   8.1 Correct guardrails row: "not wired" → "wired" with checkpoint details
   8.2 Update test counts (current: ~14,000+ across all packages)
   8.3 Fix stale file paths (apps/platform → apps/runtime)
   8.4 Update "Designed vs Implemented" table
   8.5 Add new features implemented since Feb 2026

9. **ABL_SPEC.md & TOOLS_AND_GATHER.md Marker Updates**
   9.1 Remove partial markers from features that become fully implemented
   9.2 Add clarifying note to TOOLS_AND_GATHER.md that web_search/send_email/get_weather are example names, not platform-provided built-in tools
   9.3 Update implementation status legend if any new categories needed

---

## 14. Success Metrics

| Metric                                 | Baseline              | Target  | How Measured                                                       |
| -------------------------------------- | --------------------- | ------- | ------------------------------------------------------------------ |
| Spec constructs with runtime execution | ~75% (9 runtime gaps) | 100%    | Audit each ABL_SPEC.md construct against runtime code              |
| Spec constructs with E2E tests         | ~60%                  | 100%    | Count constructs with at least 1 E2E test                          |
| STATUS.md accuracy                     | Stale (Feb 2026)      | Current | Manual review — all rows match code reality                        |
| ABL_SPEC.md partial markers remaining  | 5 (Partial)           | 0-1     | Count remaining partial/roadmap markers (grant_memory stays)       |
| Zero-coverage executors (0% line cov)  | 3 files               | 0 files | Coverage report for error/escalate/complete executors              |
| Agent developer false-confidence risk  | HIGH (silent no-ops)  | NONE    | No construct compiles successfully but fails to execute at runtime |

---

## 15. Open Questions

1. **ESCALATE timeout behavior**: When a human doesn't resolve within the configured timeout, should the session auto-resume with a timeout error (triggering ON_ERROR), or remain paused indefinitely?
2. **HOOKS ordering with guardrails**: Do `before_turn` hooks execute before or after input guardrails? (Proposed: before, so hooks can modify context before guardrail evaluation.)
3. **BEHAVIOR_PROFILES TOOLS_ADD type safety**: When a behavior profile adds a tool via TOOLS_ADD, must the tool definition be complete (type, endpoint, params), or can it reference a tool defined elsewhere?
4. **ESCALATE + agent-transfer integration depth**: Should ESCALATE directly invoke `transfer_to_agent` tool (reusing the existing tool dispatch), or should it call a higher-level agent-transfer service API? The former is simpler but couples escalation to the tool execution path.
5. **ITSM connector action configuration**: Where should the connector action reference be configured — in the DSL `ESCALATE:` block (requires spec extension), in project config, or in a separate admin-level mapping?

---

## 16. Gaps, Known Issues & Limitations

| ID          | Description                                                                                                                                                                                                                                          | Severity | Status                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| GAP-001     | ESCALATE fire-and-forget — no session pause/resume, no agent-transfer wiring                                                                                                                                                                         | High     | Open                                                                   |
| GAP-002     | HOOKS IR types (`HooksConfig`/`HookAction`) exist but zero runtime execution                                                                                                                                                                         | High     | Open                                                                   |
| GAP-003     | BEHAVIOR_PROFILES merge produces `EffectiveAgentConfig` with tools_add/tools_hide applied (`profile-resolver.ts:294`), but `reasoning-executor.ts` only consumes `additionalConstraints` (line 1020) — merged tool set is NOT consumed for LLM calls | Medium   | Open                                                                   |
| GAP-004     | Voice `provider`/`voice_id`/`speed` not in `VoiceConfigIR` type — compiler IR extension + runtime wiring needed                                                                                                                                      | Medium   | Open                                                                   |
| GAP-005     | ACTION_HANDLERS DSL block not compiled to `ActionHandlerIR[]` (compiler gap)                                                                                                                                                                         | Medium   | Open                                                                   |
| GAP-006     | ACTION_HANDLERS IR not dispatched at runtime (runtime gap)                                                                                                                                                                                           | Medium   | Open                                                                   |
| GAP-007     | GATHER attachment fields use generic tool calls, not declarative AttachmentFieldIR                                                                                                                                                                   | Medium   | Open                                                                   |
| GAP-008     | Agent-level ON_ERROR handlers for non-tool errors not evaluated                                                                                                                                                                                      | Medium   | Open                                                                   |
| GAP-009     | STATUS.md stale — guardrails listed as "not wired" when they are                                                                                                                                                                                     | High     | Open                                                                   |
| GAP-010     | TOOLS_AND_GATHER.md lists web_search as generic tool (misleading)                                                                                                                                                                                    | Low      | Open                                                                   |
| ~~GAP-011~~ | ~~TEMPLATES RESPOND: TEMPLATE(name) not resolved~~                                                                                                                                                                                                   | ~~N/A~~  | **Not a gap** — resolved at compile time by `resolveAllTemplateRefs()` |

---

## 17. Testing & Validation

### Required Test Coverage

**E2E Tests** (minimum 5 — all via HTTP API, no mocks):

| #   | Scenario                                                 | Coverage Type | Status     | Test File / Note                  |
| --- | -------------------------------------------------------- | ------------- | ---------- | --------------------------------- |
| 1   | ESCALATE → agent-transfer routing → session pause        | e2e           | NOT TESTED | `escalation.e2e.test.ts`          |
| 2   | ESCALATE → ITSM webhook via connector action             | e2e           | NOT TESTED | `escalation.e2e.test.ts`          |
| 3   | ESCALATE → resolution API → on_human_complete executes   | e2e           | NOT TESTED | `escalation.e2e.test.ts`          |
| 4   | before_turn hook fires CALL + SET before LLM             | e2e           | NOT TESTED | `hooks-lifecycle.e2e.test.ts`     |
| 5   | after_turn hook fires after LLM response                 | e2e           | NOT TESTED | `hooks-lifecycle.e2e.test.ts`     |
| 6   | before_agent / after_agent fire on session lifecycle     | e2e           | NOT TESTED | `hooks-lifecycle.e2e.test.ts`     |
| 7   | BEHAVIOR_PROFILES TOOLS_ADD injects tool into turn       | e2e           | NOT TESTED | `behavior-profiles.e2e.test.ts`   |
| 8   | BEHAVIOR_PROFILES TOOLS_HIDE removes tool from turn      | e2e           | NOT TESTED | `behavior-profiles.e2e.test.ts`   |
| 9   | Voice provider/voice_id from IR reaches TTS              | e2e           | NOT TESTED | `voice-ir-resolution.e2e.test.ts` |
| 10  | ACTION_HANDLERS: button click → SET + RESPOND            | e2e           | NOT TESTED | `action-handlers.e2e.test.ts`     |
| 11  | GATHER attachment: mime type validation rejects bad file | e2e           | NOT TESTED | `gather-attachments-e2e.test.ts`  |
| 12  | GATHER attachment: ocr_enabled forwarded to pipeline     | e2e           | NOT TESTED | `gather-attachments-e2e.test.ts`  |
| 13  | Agent-level ON_ERROR: unknown_error handler executes     | e2e           | NOT TESTED | `agent-on-error.e2e.test.ts`      |
| 14  | Cross-tenant escalation returns 404                      | e2e           | NOT TESTED | `escalation.e2e.test.ts`          |
| 15  | Escalation resolution requires project permission        | e2e           | NOT TESTED | `escalation.e2e.test.ts`          |

**Integration Tests** (minimum 5 — real service boundaries):

| #   | Scenario                                                                               | Coverage Type | Status     | Test File / Note                        |
| --- | -------------------------------------------------------------------------------------- | ------------- | ---------- | --------------------------------------- |
| 16  | EscalationBridge → HumanTask model creation with `IAgentEscalationSource`              | integration   | NOT TESTED | `escalation-integration.test.ts`        |
| 17  | EscalationBridge → TransferToolExecutor agent-transfer wiring                          | integration   | NOT TESTED | `escalation-integration.test.ts`        |
| 18  | ErrorHandlerRouter resolution chain with agent-level handlers                          | integration   | NOT TESTED | `error-handler-integration.test.ts`     |
| 19  | BehaviorProfile merge + tool set modification (TOOLS_ADD/HIDE)                         | integration   | NOT TESTED | `behavior-profiles-integration.test.ts` |
| 20  | VoiceConfigIR resolution through voice provider abstraction                            | integration   | NOT TESTED | `voice-config-integration.test.ts`      |
| 21  | Hook execution ordering: before_agent → before_turn → [LLM] → after_turn → after_agent | integration   | NOT TESTED | `hooks-integration.test.ts`             |
| 22  | GATHER AttachmentFieldIR validation: mime type, size, processing flags                 | integration   | NOT TESTED | `gather-attachment-integration.test.ts` |

### Testing Notes

All scenarios are NOT TESTED — this is a PLANNED feature. Every scenario requires real HTTP API interaction, real Express middleware chain, and real service execution. No mocks of codebase components. Only external ITSM services may be mocked via dependency injection.

> Full testing details: [../testing/abl-spec-impl-parity.md](../testing/abl-spec-impl-parity.md)

---

## 18. References

- ABL Specification: `docs/reference/ABL_SPEC.md`
- Implementation Status: `docs/reference/STATUS.md`
- Tools & Gather Reference: `docs/reference/TOOLS_AND_GATHER.md`
- Agent Transfer: `docs/features/agent-transfer.md`
- Connectors: `docs/features/connectors.md`
- Attachments: `docs/features/attachments.md`
- Voice Capabilities: `docs/features/voice-capabilities.md`
- Guardrails: `docs/features/guardrails.md`
- SDLC Pipeline: `docs/sdlc/pipeline.md`
