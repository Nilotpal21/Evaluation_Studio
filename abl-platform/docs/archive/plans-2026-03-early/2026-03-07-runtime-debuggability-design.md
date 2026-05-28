# Runtime Debuggability Design

Date: 2026-03-07
Status: Approved

## Problem

Runtime test failures take too long to debug (1+ hour sessions observed). The root causes:

1. RuntimeExecutor (2,626 LOC) is a black box -- assertions say _what_ failed, not _where_ execution diverged
2. MockAnthropicClient exists in 3+ copies with different interfaces
3. 474 test files with no execution-path index
4. DSL strings duplicated inline across dozens of tests
5. No execution trace dump on test failure

Production agents suffer similar opacity: the Observatory UI and TraceStore infrastructure are comprehensive, but the runtime doesn't capture _decision reasoning_ -- only outcomes.

## Part A: Test Infrastructure Improvements

### A1. Execution Diagnostics on Failure

New helper: `__tests__/helpers/execution-diagnostics.ts`

```typescript
function formatSessionDiagnostics(session: RuntimeSession): string;
```

On assertion failure, dumps:

- Compilation result (success/errors)
- Flow steps taken (step name, type, transition reason)
- Handoff evaluations (conditions checked, target, result)
- data.values at current state
- Gather progress (collected vs pending fields)
- LLM calls made (count, tools available, stop reasons)
- Trace events (last 20)
- Thread stack state
- Active agent name and mode

Usage pattern:

```typescript
try {
  expect(session.agentName).toBe('Child_Agent');
} catch (e) {
  console.error(formatSessionDiagnostics(session));
  throw e;
}
```

Also provides `expect`-compatible wrappers:

```typescript
expectWithDiagnostics(session).agentName.toBe('Child_Agent');
```

### A2. Consolidate Mock LLM Client

- Delete inline MockAnthropicClient from `reasoning-gather-handoff.test.ts` (lines 34-180)
- Import `ValidatingMockAnthropicClient` and `injectValidatingMockClient` from `helpers/history-validation.ts`
- ValidatingMockAnthropicClient is strictly better: validates message format, catches malformed payloads early with descriptive errors
- `pre-refactor/helpers/mock-llm-client.ts` stays -- it serves its own isolated scope

### A3. DSL Fixture Library

New directory: `__tests__/fixtures/`

Extract commonly repeated DSL patterns:

- `parent-child-handoff.abl` -- Parent routes to Child on condition
- `gather-three-fields.abl` -- Agent with 3 required gather fields
- `reasoning-gather.abl` -- Reasoning-mode agent with LLM extraction
- `multi-agent-routing.abl` -- Router with multiple handoff targets
- `simple-flow.abl` -- Minimal scripted flow (entry -> complete)

Loader helper:

```typescript
// __tests__/fixtures/index.ts
export function loadFixture(name: string): string;
export function loadFixturePair(parent: string, child: string): [string, string];
```

### A4. Test Execution Path Index

New file: `__tests__/TEST_INDEX.md`

Maps test files to execution paths covered:

```
| File | Covers |
|------|--------|
| flow-handoff-threads.test.ts | handoff, threads, return, pass-fields |
| reasoning-gather-handoff.test.ts | gather, extraction, handoff, delegate, traces |
| ...
```

Enables "handoff is broken -> which 3 files to check" in 5 seconds.

### A5. Domain-Aware Assertions

New helper: `__tests__/helpers/domain-assertions.ts`

```typescript
assertHandoffCompleted(session, { from: 'Parent', to: 'Child' });
// Failure: "Handoff from Parent to Child did not complete.
//   Active agent: Parent, Flow step: detect,
//   Handoff conditions: [{to: Child, when: 'intent == booking', evaluated: true, matched: false}]
//   data.values: {intent: undefined}"

assertGatherProgress(session, { collected: ['name'], pending: ['email'] });
// Failure: "Gather progress mismatch.
//   Expected collected: [name], Actual: []
//   Expected pending: [email], Actual: [name, email]
//   Extraction attempts: 0, LLM calls: 1"

assertFlowReached(session, 'confirm_step');
// Failure: "Flow did not reach 'confirm_step'.
//   Steps visited: [entry, detect], Current: detect
//   Transitions: [entry->detect (condition: always)]"

assertAgentComplete(session, 'BookingAgent');
// Failure: "Agent BookingAgent not complete.
//   isComplete: false, conversationPhase: gathering
//   Pending fields: [date, guests]"
```

## Part B: Production Debugging Analysis

### Existing Infrastructure (Strong Foundation)

| Layer       | Component               | What It Does                                                                                      |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| Capture     | TraceEmitter            | 28+ event types: LLM, tool, decision, handoff, flow, agent lifecycle                              |
| Storage     | TraceStore              | Ring buffer (500 events/session), Redis Streams, optional ClickHouse                              |
| Transport   | WebSocket               | Real-time trace streaming with replay on subscribe                                                |
| Debug       | Observatory DebugServer | Breakpoints, pause/resume, state inspection (port 9229)                                           |
| Debug       | MCP Debug Server        | 15+ MCP tools for Claude-assisted debugging                                                       |
| UI          | Observatory Module      | 10-tab DebugTabs: Timeline, Gather, Constraints, Context, History, LLM, IR, Analysis, Tests, Logs |
| UI          | StateMachineView        | Dagre.js graph with execution heatmap, pan/zoom                                                   |
| UI          | AgentFlowGraph          | Multi-agent handoff/delegation visualization                                                      |
| UI          | GatherProgressPanel     | Field collection status with progress bars                                                        |
| Diagnostics | DiagnosticPatterns      | 8 automated issue detectors                                                                       |

### Critical Gaps

#### Gap 1: Decision Reasoning Not Captured

**Current:** TraceEmitter logs `{type: 'handoff', data: {toAgent: 'Billing'}}`.
**Missing:** Which agents were candidates, what conditions were evaluated, what data values were compared.

**Fix (Tier 1, Low Effort):**
Enrich existing trace events in TraceEmitter with evaluation context:

```typescript
// handoff event enrichment
emitHandoff(session, {
  toAgent: 'Billing',
  candidates: ['Billing', 'Support', 'Sales'],
  evaluations: [
    {
      target: 'Billing',
      condition: 'intent == billing',
      result: true,
      values: { intent: 'billing' },
    },
    {
      target: 'Support',
      condition: 'intent == support',
      result: false,
      values: { intent: 'billing' },
    },
  ],
  selectedReason: 'first_match',
});
```

Impact: Every existing UI (Observatory EventTimeline, TraceViewer, MCP debug_get_recent_traces) immediately shows richer data with zero UI changes.

#### Gap 2: Construct-Layer Events Invisible

**Current:** ExecutionContextBridge stubs out trace service, so compiler-level decisions (flow step conditions, constraint evaluation order, gather validation) are black holes.

**Fix (Tier 2, Medium Effort):**
Replace stub TraceService in execution-context-bridge with a forwarding implementation:

```typescript
// Instead of stub:
traceService: {
  emit: () => {};
}

// Forward to real TraceStore:
traceService: {
  emit: (event) =>
    traceStore.addEvent(sessionId, {
      ...event,
      source: 'construct-layer',
      spanId: currentSpanId,
    });
}
```

Impact: Unlocks visibility into constraint backtracking, gather validation, flow condition evaluation, ON_INPUT branch selection.

#### Gap 3: No "Explain Decision" Capability

**Current:** `debug_explain_decision` MCP tool exists but is not implemented.

**Fix (Tier 3, Medium Effort):**

1. Query enriched trace events around the decision point
2. Build a causal chain: user message -> extraction -> data values -> condition evaluation -> decision
3. Return human-readable explanation

```
Q: Why did the agent hand off to Billing?
A: User said "I need to update my payment method".
   Extraction: {intent: "billing"} (confidence: 0.92)
   Handoff conditions evaluated:
     - TO: Billing WHEN intent == "billing" -> MATCHED (first match wins)
     - TO: Support WHEN intent == "support" -> skipped
   Result: Handed off to Billing with context {intent, request}
```

Impact: Directly addresses dev-time iteration -- the #1 pain point.

### Gaps Not Addressed (Future Work)

- Gather field extraction prompt introspection (PII scrubbing conflict)
- Breakpoint debugging UI in Studio (types exist, no implementation)
- Flame graph / performance profiler
- Real-time WebSocket streaming in TraceViewerPage (currently static load)
- Cost tracking per agent/tool/session

### Recommended Implementation Order

1. **Test improvements (Part A)** -- immediate, unblocks Claude Code self-service
2. **Enrich decision trace events (Gap 1)** -- low effort, high leverage
3. **Wire construct-layer tracing (Gap 2)** -- unlocks deep visibility
4. **Implement explain_decision (Gap 3)** -- caps the dev-time debugging story
