# ABLP-555 / ABLP-864 Hidden Issues Audit and Implementation Plan

Date: 2026-05-09
Status: Draft implementation plan
Scope: ABLP-555 and ABLP-864 only

## Executive Summary

ABLP-555 and ABLP-864 are both propagation bugs.

ABLP-555 loses the step-level reasoning goal before runtime prompt assembly. The runtime now correctly prefers `step.reasoning_zone.goal`, but the legacy FLOW parser stores `GOAL: |` as the literal string `"|"`, so the compiled IR and runtime prompt faithfully carry the wrong value.

ABLP-864 executes the multi-agent delegation flow correctly, but the trace/debug surfaces do not have a single canonical delegation lifecycle contract. Runtime emits some delegation fields as `from` / `to`, helper emitters and Studio replay expect `fromAgent` / `targetAgent`, delegated child execution is recorded as a fresh `user_message`, and there is no explicit event for supervisor reactivation after a delegate returns.

## ABLP-555 Audit

### Reproduced Scenarios

| Scenario                                                             | Current result                                      | Status                 |
| -------------------------------------------------------------------- | --------------------------------------------------- | ---------------------- |
| FLOW step `REASONING: true` with inline `GOAL: classify contracts`   | IR has `reasoning_zone.goal = "classify contracts"` | Works                  |
| FLOW step `REASONING: true` with quoted `GOAL: "classify contracts"` | Covered by existing runtime regression              | Works for runtime path |
| FLOW step `REASONING: true` with block `GOAL: \|`                    | AST and IR have `goal = "\|"`                       | Broken                 |
| FLOW step `REASONING: true` with blank multiline `GOAL:`             | AST and IR flatten lines with spaces                | Partially broken       |
| FLOW step `REASONING: true` with no step goal but agent goal exists  | Parser validation allows fallback                   | Works                  |

### Data Flow Matrix

| Field                        | Parser AST                | Compiler IR            | Runtime prompt         | Trace surface        | Verdict |
| ---------------------------- | ------------------------- | ---------------------- | ---------------------- | -------------------- | ------- |
| Agent `GOAL: \|`             | OK via `parseGoal()`      | OK                     | OK as fallback         | OK                   | Good    |
| Step inline `GOAL`           | OK                        | OK                     | OK                     | OK                   | Good    |
| Step `GOAL: \|`              | GAP, stores `"\|"`        | Copies bad value       | Renders `Goal: \|`     | Shows bad goal       | Broken  |
| Step blank multiline `GOAL:` | GAP, flattens to one line | Copies flattened value | Renders flattened goal | Shows flattened goal | Risk    |

### Root Cause

Top-level `GOAL` has a block-aware parser path in `parseGoal()`:

- `packages/core/src/parser/agent-based-parser.ts`

FLOW step `GOAL` uses a separate branch in `parseFlow()` and treats any non-empty value as inline text. For `GOAL: |`, the value is `"|"`, so it never consumes the indented block. The compiler then copies `step.goal` into `reasoning_zone.goal` without validation or normalization.

### Hidden Issues

1. `GOAL: |` is accepted without warning but silently compiles to `"|"`.
2. Blank multiline step goals work only by accident and collapse line breaks to spaces.
3. Existing ABLP-555 regression coverage is runtime-focused and does not protect the parser/compiler boundary.
4. Other step-level string fields using custom block parsing may have inconsistent `|` behavior. The immediate blast radius is step `GOAL`, but the implementation should audit `RESPOND`, `STEP_CONSTRAINTS`, and nested behavior profile FLOW parsing before closing.
5. Runtime fallback `step.reasoning_zone.goal || agentGoal` masks empty strings, so an intentionally empty compiled step goal falls back to agent goal. That is acceptable today because parser validation requires some goal, but tests should pin the expected fallback behavior.

## ABLP-864 Audit

### Reproduced / Confirmed Scenarios

| Jira symptom                                   | Current code path                                                                                                                                                         | Verdict        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Incorrect agent header always shows supervisor | Interactions choose one `interaction.agentName` via dominant event count                                                                                                  | Confirmed risk |
| Duplicate Decision and Tool Thought            | `reasoning-executor` emits both `decision` and `tool_thought` for the same system tool reason/thought                                                                     | Confirmed      |
| Wrong exit shown around delegation             | Delegate child execution gets its own `agent_exit`; parent ceding/resuming control is not explicit                                                                        | Confirmed      |
| Missing trace when returning to supervisor     | Active thread is restored, but no `thread_return` / `delegate_return` event is emitted                                                                                    | Confirmed      |
| Delegated input labeled as user input          | Delegate child calls `executeMessage()` without provenance metadata                                                                                                       | Confirmed      |
| Final response mismatch with welcome message   | Multiple renderable `message.agent` events can exist; debug surfaces lack final-response provenance strong enough to distinguish init/welcome from final parent synthesis | Confirmed risk |

### Data Flow Matrix

| Field / concept            | Runtime delegate emission                         | Child execution                   | Trace adapter                    | Studio replay                 | Interactions tab                   | Verdict                 |
| -------------------------- | ------------------------------------------------- | --------------------------------- | -------------------------------- | ----------------------------- | ---------------------------------- | ----------------------- |
| Source agent               | `from`, `agentName` on start                      | Not forwarded as provenance       | Reads `agentName` / `agent`      | Sometimes expects `fromAgent` | Banner reads `fromAgent` or `from` | Drift                   |
| Target agent               | `to`                                              | Stored in child session agent     | Adapter does not infer from `to` | Expects `targetAgent`         | Banner misses `to`                 | Broken in some surfaces |
| Delegated input provenance | Message string only                               | Emits `user_message`              | No provenance field              | Displays as user message      | Groups as user input               | Broken                  |
| Parent cedes control       | Only `delegate_start`                             | Child `agent_enter` follows       | No parent pause event            | No explicit marker            | Ambiguous                          | Broken                  |
| Parent resumes control     | Active thread restored only                       | Parent continues                  | No event                         | No marker                     | Missing boundary                   | Broken                  |
| Final response             | `message.agent` emitted for any renderable result | Includes init and final responses | Replayed by timestamp only       | Can synthesize stale response | May show wrong final               | Risk                    |
| Reason/thought             | `decision` and `tool_thought` both emitted        | N/A                               | Both preserved                   | Both rendered                 | Duplicate cards                    | Broken                  |

### Root Cause

There is no canonical multi-agent trace lifecycle contract for delegation. Multiple producers and consumers use different field names and different semantics:

- Runtime delegate path emits `from` / `to`.
- `TraceEmitter` helper emits `fromAgent` / `targetAgent`.
- Studio replay displays `data.targetAgent`.
- Interactions lifecycle banners read `toAgent` / `targetAgent` / `target`, but not `to`.
- Delegated child execution reuses the normal user-message execution path without `source: "delegate"` or equivalent provenance.
- Parent reactivation after delegate completion is a state change, not a trace event.

### Hidden Issues

1. Live trace and historical replay can disagree because event normalization differs.
2. Nested delegation will make the single "primary agent" interaction header increasingly misleading.
3. Fan-out likely shares the same lifecycle/provenance gaps and needs the same contract audit.
4. Delegate failure and timeout paths emit incomplete target fields and lack parent resume markers.
5. `agent_lifecycle` events exist for delegate before/after hooks but are not mapped into the Studio lifecycle event set, so they do not repair the user-visible flow.
6. EventBus `message.agent` payloads are renderable-message oriented, not final-response oriented. Debug replay needs a canonical final response event or a provenance flag to avoid selecting an initial welcome response.

## Implementation Plan

### Phase 1: Fix ABLP-555 Parser and Compiler Coverage

Files:

- `packages/core/src/parser/agent-based-parser.ts`
- `packages/core/src/__tests__/agent-based-parser-flow-goal.test.ts` or an existing parser test file
- `packages/compiler/src/__tests__/ir/flow-reasoning-goal-compilation.test.ts`
- `apps/runtime/src/__tests__/execution/reasoning-zone-init-guard.test.ts`

Changes:

1. Extract a reusable helper for colon-value multiline text:
   - Treat empty value and `|` as block indicators.
   - Consume only lines indented deeper than the property line.
   - Dedent block text consistently with `parseMultiLineString()`.
   - Preserve newlines for block text.
2. Use the helper for FLOW step `GOAL`.
3. Keep inline and quoted `GOAL` behavior unchanged.
4. Add parser tests for:
   - `GOAL: |` under a FLOW step.
   - blank multiline `GOAL:` under a FLOW step.
   - inline unquoted goal.
   - quoted goal.
   - no step goal falls back to agent goal for `REASONING: true`.
5. Add compiler tests proving `reasoning_zone.goal` contains the full multiline step goal and never literal `"|"`.
6. Add/extend runtime prompt test proving the LLM system prompt contains the step goal and not the agent fallback when a multiline step goal exists.

Acceptance criteria:

- `GOAL: |` compiles to the block contents.
- No `reasoning_zone.goal` can be exactly `"|"` for a valid block-scalar goal.
- Existing quoted and inline goal behavior remains unchanged.
- Parser warnings/errors remain stable except for any intentional new warning on malformed block goals.

### Phase 2: Define a Canonical Delegation Trace Contract

Files:

- `apps/runtime/src/services/trace-emitter.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/studio/src/utils/trace-event-adapter.ts`
- `apps/studio/src/utils/replay-trace-events.ts`
- `apps/studio/src/components/observatory/interactions/event-processor.ts`
- `apps/studio/src/components/observatory/interactions/types.ts`

Canonical fields:

```ts
{
  sourceAgent: string;
  targetAgent: string;
  fromAgent: string; // compatibility alias for existing consumers
  toAgent: string;   // compatibility alias for existing consumers
  invocationType: 'delegate' | 'fan_out' | 'handoff';
  parentSessionId: string;
  childSessionId?: string;
  parentThreadIndex?: number;
  childThreadIndex?: number;
  inputKind?: 'user' | 'delegated' | 'system' | 'resume';
}
```

Changes:

1. Update delegate start/complete/failure/timeout emissions to include canonical fields plus compatibility aliases.
2. Keep `from` / `to` temporarily for backward compatibility, but do not make new code depend on them.
3. Add an explicit lifecycle event after delegate completion and before parent continuation:
   - Preferred type: `thread_return`
   - Data: `fromAgent: targetAgent`, `toAgent: parentAgent`, `returnType: "delegate"`, `childSessionId`, `parentThreadIndex`, `childThreadIndex`
4. Add an explicit parent pause marker when delegation starts:
   - Either enrich `delegate_start` with `parentAction: "pause"` or add `agent_pause`.
   - Prefer enriching `delegate_start` to keep event count modest.
5. Add `inputKind: "delegated"` or `source: "delegate"` to child `executeMessage()` options and suppress `user_message` for delegated inputs.
6. Emit a distinct `delegated_message` trace event for the child input, so Studio can show "Delegated input" without losing observability.
7. Update trace adapter normalization to infer `agentName` from canonical fields when top-level `agentName` is missing.
8. Update Studio replay and lifecycle banners to read canonical fields first, then compatibility aliases.

Acceptance criteria:

- Delegation start clearly shows supervisor to child.
- Child execution shows child agent as active.
- Child input is not labeled as a user message.
- Return to supervisor is visible before the supervisor's next LLM decision.
- Historical replay and live trace ingestion render the same agent names and target names.

### Phase 3: Remove Duplicate Decision / Tool Thought Rendering

Files:

- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/studio/src/components/observatory/interactions/event-processor.ts`
- `apps/studio/src/components/observatory/interactions/DecisionContent.tsx`
- Relevant Studio/runtime tests

Preferred approach:

1. Keep one structured decision event for system routing/delegation actions.
2. Keep `tool_thought` for regular business tools and for UI "thinking" surfaces.
3. For system tools, attach thought/reasoning to the `decision` event only, or mark the emitted `tool_thought` as `visibility: "chat_thought_only"` so Observatory can suppress the duplicate decision card.
4. Preserve the Studio transport behavior that forwards visible thought messages when needed.

Acceptance criteria:

- A single delegation decision appears in Observatory.
- Chat thought behavior does not regress.
- Existing `llmCallId` correlation is preserved for whichever thought/decision event remains visible.

### Phase 4: Fix Final Response Attribution

Files:

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/channel/response-provenance.ts`
- `apps/studio/src/utils/replay-trace-events.ts`
- `apps/studio/src/store/session-store.ts`
- Relevant replay and session trace tests

Changes:

1. Emit or persist a canonical final response trace event when `finalizeExecutionResult()` returns a user-visible result:
   - Type: `agent_response` or `message.agent.finalized`.
   - Data: `agentName`, `content`, `responseMetadata`, `isFinalForTurn: true`, `source: "finalizeExecutionResult"`.
2. Mark init/welcome responses as `isFinalForTurn: false` or `phase: "init"`.
3. Update replay synthesis to prefer `isFinalForTurn: true` for the final chat/debug response.
4. Add a regression where ON_START emits a welcome message, then the supervisor delegates and later returns a final synthesized answer. Replay must show the final synthesized answer as final, not the welcome.

Acceptance criteria:

- Debug final response matches chat final response for multi-agent delegation.
- Welcome/init responses remain visible in the timeline but are not selected as final answer.

### Phase 5: Fan-Out, Nested Delegate, and Failure Coverage

Files:

- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/__tests__/multi-agent-orchestration.e2e.test.ts`
- `apps/studio/src/__tests__/interactions-event-processor.test.ts`
- `apps/studio/src/__tests__/replay-trace-events.test.ts`

Scenarios:

1. Supervisor delegates sequentially to DatabaseQueryAgent then DocumentSearchAgent.
2. Child agent delegates to grandchild and returns to child, then supervisor.
3. Delegate target fails.
4. Delegate target times out.
5. Fan-out starts multiple child agents and returns aggregated results.
6. ON_START welcome plus final synthesized response.

Acceptance criteria:

- Agent path shows the true sequence.
- Lifecycle banners show start, child enter, child exit, parent return.
- Failure/timeout traces include source and target agent names.
- Fan-out traces use the same canonical field names.

## Verification Plan

Run build before tests:

```bash
pnpm --filter @abl/compiler build
pnpm --filter @agent-platform/runtime build
pnpm --filter @agent-platform/studio build
```

Targeted tests:

```bash
pnpm --filter @abl/core test:fast -- agent-based-parser
pnpm --filter @abl/compiler test:fast -- flow-reasoning-goal
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/reasoning-zone-init-guard.test.ts
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/multi-agent-orchestration.e2e.test.ts
pnpm --filter @agent-platform/studio test:fast -- interactions
pnpm --filter @agent-platform/studio test:fast -- replay-trace-events
```

Manual / evidence checks:

1. Reproduce ABLP-555 with the Jira DSL and confirm the LLM prompt contains the full step goal.
2. Reproduce ABLP-864 with ContractTriage, DatabaseQueryAgent, and DocumentSearchAgent.
3. Capture Studio Observatory timeline showing:
   - ContractTriage receives user input.
   - ContractTriage delegates to DatabaseQueryAgent.
   - DatabaseQueryAgent receives delegated input, not user input.
   - DatabaseQueryAgent exits.
   - Control returns to ContractTriage.
   - ContractTriage delegates to DocumentSearchAgent.
   - Control returns to ContractTriage.
   - ContractTriage final response matches chat final response.

## Rollout Notes

1. Preserve old `from` / `to` fields for at least one release while adding canonical aliases.
2. Make Studio consumers read canonical fields first and legacy fields second.
3. Do not change business execution semantics in the trace fix phases.
4. Keep trace payloads free of sensitive delegated input values where the existing trace policy requires redaction or metadata-only logging.
5. Update Jira with before/after trace snippets once implementation is complete.

## Open Questions

1. Should delegated child input be completely hidden from chat-like transcript views, or shown as a system/delegated input row?
2. Should `thread_return` be reused for delegate return, or should runtime introduce `delegate_return` for clearer semantics?
3. Should system-tool `tool_thought` remain for Studio transport only, or should all observability use the enriched `decision` event?
4. Should the final response event be emitted as a trace event, EventBus event, or both?
