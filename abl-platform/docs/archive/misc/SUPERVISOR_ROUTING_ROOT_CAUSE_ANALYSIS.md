# ABL Supervisor Routing — Root Cause Analysis & Fix Plan

## Source

Analysis of 10 concerns from `ABL_SUPERVISOR_ROUTING_CONCERNS.md`, traced through:

- Compiler: `packages/compiler/src/platform/ir/compiler.ts`
- Runtime executor: `apps/runtime/src/services/runtime-executor.ts`
- Construct executors: `packages/compiler/src/platform/constructs/executors/`
- IR schema: `packages/compiler/src/platform/ir/schema.ts`

---

## Core Assumption Underlying Most Issues

**"The LLM will make correct decisions from natural language instructions."**

Concerns #1, #2, #3, #7, #8, #10 all stem from over-reliance on LLM interpretation. The ABL DSL has rich structured data (priorities, conditions, pass fields, WHEN guards) that is compiled into prose and handed to the LLM instead of being evaluated programmatically.

---

## Concern 1: Multi-intent — second agent silently overwrites the first

**Severity**: Critical

### Why it exists

The tool call loop at `runtime-executor.ts:2965` iterates `result.toolCalls` sequentially. At line 3058-3064, when `__handoff__` succeeds, it sets `breakLoop = true`. But it doesn't break immediately — the loop continues to the next tool call. At line 2979-2984:

```typescript
if (action) {
  finalAction = action;
} // overwrites previous action
if (breakLoop) {
  shouldBreak = true;
}
```

Both handoffs execute fully (each creates a child session, runs extraction + LLM, produces a response). But `finalAction` and `finalResponse` get overwritten by the second one. The first child agent's response is discarded at line 2986-2988 where `finalResponse` is reassigned.

### Assumptions made

- The code assumed the LLM would only make one `__handoff__` call per response. No guard was added.
- The sequential execution model was designed for regular tools (call several in parallel, return all results to LLM), not for terminal actions like handoff.

### Assumptions to clarify

- Should supervisors ever handle multi-intent in a single turn?
- If yes: sequential (respond to first, then second next turn) or combined (merge both responses)?
- If no: should the runtime block the second call or should the supervisor prompt prevent it?

### Design decision needed

**Multi-intent strategy**: Option A (sequential — first wins, second queued), Option B (combined response), or Option C (block at runtime, force LLM to pick one).

### Recommendation

**Option A + runtime guard**: Break the loop immediately after the first successful handoff. Queue remaining handoff targets in `session.data.values._pendingHandoffs`. On the next turn, if no new user input and pending handoffs exist, auto-execute the next one. This is the cheapest fix — no DSL changes, no prompt redesign.

---

## Concern 2: Handoff tool design — single enum vs agents-as-tools

**Severity**: High

### Why it exists

The compiler at `compiler.ts:323-337` generates a single `__handoff__` tool with two flat parameters:

```typescript
parameters: [
  { name: 'target', type: 'string', description: 'The agent to hand off to', required: true },
  { name: 'context', type: 'string', description: 'JSON context to pass', required: false },
];
```

Target names are listed only in the `description` string (`"Available targets: Agent_A, Agent_B"`). There's no per-agent description in the tool schema — the only signal the LLM gets is from the system prompt's "Routing Rules" section (`runtime-executor.ts:3934-3938`).

### Assumptions made

- A single tool with a string target would be sufficient for the LLM to route correctly.
- The system prompt descriptions would carry enough semantic signal.
- This was the simplest implementation and didn't require per-agent schema generation.

### Design decision needed

**Tool topology**: Single generic tool (current) vs per-agent typed tools. The per-agent pattern would produce `handoff_to_Sales_Agent(quote_id: string, budget: number)`, `handoff_to_Booking_Manager(booking_id: string)` — giving the LLM structured routing signal and typed context passing.

### Trade-offs

- **Single tool**: Simpler compilation, easier to add/remove agents, but LLM has weak routing signal.
- **Per-agent tools**: Stronger LLM signal, enforceable context (ties into Concern #3), but tool count grows linearly with agents. With 10+ agents, this clutters the LLM's tool list.

### Recommendation

**Per-agent tools for supervisors** (where routing precision matters), keep single tool for regular agents (where handoff is rare). This is a compiler change — `compileSystemTools()` would generate N tools instead of one when `isSupervisor=true`.

---

## Concern 3: Handoff context (`pass`) is not enforced

**Severity**: Critical

### Why it exists

Two disconnected systems handle context passing:

1. **Compiler-side** (`handoff-executor.ts:266-286`): `buildHandoffContext()` cherry-picks `pass` fields from source context. This works correctly in the `ConstructExecutor` path.

2. **Runtime-side** (`runtime-executor.ts:3170-3191`): The runtime's `handleHandoff()` also reads `pass` fields from the `HandoffConfig`, but the `__handoff__` tool schema has `context` as a single optional string. The LLM can pass anything — or nothing.

At line 3184: `Object.assign(childContext, context)` — the LLM's free-form context **overwrites** the structured `pass` fields. There is zero validation that the declared `pass` fields are actually present.

### Assumptions made

- The LLM would provide useful context if instructed in the system prompt.
- Runtime-side pass extraction from `session.data.values` would compensate for LLM omissions.
- Context enforcement wasn't considered a priority.

### Design decision needed

This concern is tightly coupled with #2. If per-agent tools are adopted, `pass` fields compile directly as required parameters per target — enforcement is automatic via the tool schema.

If single-tool is kept, the runtime needs a **post-extraction validation layer** in `handleHandoff()` that checks `pass` fields against `session.data.values` before proceeding, and blocks the handoff (returning error to LLM) if required fields are missing.

---

## Concern 4: Scripted agents run as reasoning after handoff

**Severity**: Critical

### Why it exists

This is a **confirmed bug**. The mode detection works at the top level (`runtime-executor.ts:407-408`):

```typescript
const isFlowMode = agentIR?.execution?.mode === 'scripted' && agentIR?.flow;
```

But in `handleHandoff()` at line 3252-3258, when the child agent is executed:

```typescript
const result = await this.executeMessage(childSession.id, lastUserMessage, onChunk, onTraceEvent);
```

`executeMessage()` dispatches to either `executeFlowStep()` or `executeWithTools()` based on the child's IR mode check. The check at line 407-408 **should** detect `mode === 'scripted'` and route to `executeFlowStep()`.

However, the system prompt at line 3947:

```
"You are a specialist agent. Help the user directly"
```

is applied to **all** child agents after handoff (line 3944-3954), regardless of mode. And the reasoning prompt builder at line 3882+ doesn't check for scripted mode — it always builds a reasoning-style prompt.

The root cause is that `executeMessage()` builds the system prompt **before** checking the mode, and the prompt is always reasoning-flavored. Even if `executeFlowStep()` is called, the child session's `conversationHistory` already has the reasoning-style system prompt from the initial wiring.

### Assumptions made

- All child agents would use reasoning mode (the supervisor pattern was designed around reasoning agents).
- The flow executor would override the system prompt when needed — but it doesn't, it uses the session's pre-built prompt.

### Design decision needed

None — this is a straightforward bug. The fix is: in `handleHandoff()`, check `targetAgentInfo.ir.execution?.mode` and skip the reasoning-style prompt building for scripted agents. Let `executeFlowStep()` handle its own prompting.

---

## Concern 5: Text + tool_call collision in supervisor responses

**Severity**: Medium

### Why it exists

At `runtime-executor.ts:2986-2988`:

```typescript
if (action?.type === 'handoff' && ...) {
  finalResponse = (toolResult as { response: string }).response;
}
```

The child agent's response overwrites `finalResponse`. Earlier in the same turn, if the LLM produced text content alongside the tool call, that text was already added to `messages` but the delivery check at line 3026:

```typescript
if (onChunk && finalAction.type === 'continue') {
  onChunk(finalResponse);
}
```

...only streams text when the action is `continue`, not `handoff`. So supervisor text alongside handoff is discarded — which is actually **correct behavior** for supervisors (the supervisor shouldn't talk to the user). But for regular agents with handoff capability, discarding text could lose useful context.

### Assumptions made

- Supervisor text alongside handoff is noise — the child's response is what matters.
- No distinction was made between supervisor-text (noise) and regular-agent-text (useful context).

### Design decision needed

- **For supervisors**: Suppress text when handoff is present (current behavior, correct).
- **For regular agents**: Prepend the agent's text to the child's response as a transition message.

This is low severity — the current behavior is accidentally correct for supervisors, which is the primary handoff path.

---

## Concern 6: Entity extraction hallucinates and conflicts with response gen

**Severity**: High

### Why it exists

Two independent LLM calls run sequentially:

1. **Extraction** (`runtime-executor.ts:2857-2906`): Uses `extractEntitiesWithLLM()` with a generic English prompt (`gather-executor.ts:150-167`):

   ```
   "You are an intelligent information extraction assistant..."
   ```

   This prompt doesn't include: field defaults, validation rules, allowed enum values, or the agent's persona language.

2. **Response generation** (`runtime-executor.ts:2928-3020`): Uses `executeWithTools()` with the agent's full system prompt including persona, tools, and gathered data.

These two calls have **no shared context**. The extraction LLM doesn't know what the response LLM will say, and vice versa. The extraction result is stored in `session.data.values` but not explicitly included in the response generation prompt (though it's indirectly available via the `## Current Context` JSON dump at line 3985).

### Assumptions made

- Extraction and response generation could be independent, pipeline-style.
- The extraction prompt could be generic and language-agnostic.
- Field metadata (defaults, enums, validation) wasn't needed for extraction accuracy.

### Root causes

1. Extraction prompt ignores field defaults — LLM invents values
2. Extraction prompt is always English — fails for non-English agents
3. No validation layer rejects hallucinated values before storage
4. Extraction results aren't fed into response generation context

### Design decisions needed

1. **Unified vs pipeline**: Merge extraction + response into one LLM call (structured output), or keep pipeline but connect them?
2. **Extraction prompt enrichment**: Include field defaults, enum values, validation rules, and agent persona language in the extraction prompt?

### Recommendation

Keep the pipeline (two calls) but:

- Enrich extraction prompt with field metadata from `GatherField` (type, validation, default, enum values)
- Use the agent's persona language for the extraction prompt
- Add post-extraction validation: reject values that violate `ValidationRule` constraints
- The grounding validator (`grounding-validator.ts`) already exists but needs the field metadata fed into it

---

## Concern 7: Routing conditions and escalation triggers need programmatic evaluation

**Severity**: High

### Why it exists

The compiler stores routing conditions as raw strings in `RoutingRule.when` (`schema.ts:922-928`). The runtime has a condition evaluator (`evaluateCondition()` in `evaluator.ts`) that can parse these expressions. But the supervisor flow at `runtime-executor.ts:3928-3943` renders conditions as **prose in the system prompt** only:

```typescript
parts.push(`- **${rule.to}**: ${desc}`);
```

The evaluator is never called on routing rules. The entire routing decision is delegated to the LLM.

Meanwhile, escalation triggers (`routing_failures >= 3`) reference runtime counters that don't exist — there's no `routing_failures` counter in `session.data.values`.

### Assumptions made

- LLM-based routing was sufficient for all cases.
- Programmatic pre-evaluation wasn't needed because the LLM would interpret conditions correctly.
- Runtime counters for escalation metrics were deferred to later implementation.

### Design decisions needed

1. **Hybrid routing**: Should the runtime evaluate conditions programmatically first and fall through to LLM only when ambiguous?
2. **Runtime counters**: Should `routing_failures`, `handoff_count`, etc. be tracked automatically in session state?

### Recommendation

Add a pre-evaluation layer in `handleMessage()` before the LLM call:

1. Evaluate all `RoutingRule.when` conditions against `session.data.values`
2. If exactly one matches — direct handoff (skip LLM)
3. If multiple match — pass only matching targets to LLM (narrowed tool enum)
4. If none match — full LLM routing (current behavior)
5. Track `routing_failures` and `handoff_count` as auto-incremented session counters

---

## Concern 8: Supervisor ROUTING priority ordering is lost in compilation

**Severity**: Medium

### Why it exists

The compiler at `compiler.ts:179` does assign priority:

```typescript
priority: idx + 1,  // Sequential 1-indexed
```

But the runtime prompt builder at `runtime-executor.ts:3935-3938` iterates `ir.routing.rules` as flat bullets:

```typescript
for (const rule of ir.routing!.rules) {
  parts.push(`- **${rule.to}**: ${desc}`);
}
```

No priority numbers, no ordering signal in the rendered prompt. The `rule.priority` field exists in the IR but is never used in the system prompt or in any programmatic evaluation.

### Assumptions made

- Document order in the prompt would implicitly convey priority to the LLM.
- Explicit priority numbers weren't needed because the LLM would interpret context clues.

### Recommendation

Low-effort, high-impact fix:

1. Include priority in the prompt: `"Priority ${rule.priority}: **${rule.to}** — ${desc}"`
2. Better yet: if the programmatic pre-evaluation from Concern #7 is implemented, use `rule.priority` for tiebreaking when multiple conditions match.

---

## Concern 9: Memory values not surfaced in LLM system prompts

**Severity**: Medium

### Why it exists

The reasoning executor's `buildSystemPrompt()` at `reasoning-executor.ts:373-403` includes:

- `identity.persona` and `identity.goal`
- `state.gatherProgress` (collected fields)
- Missing required fields

But it does **not** include:

- `state.memory.session` (session-scoped memory variables)
- `state.memory.persistentCache` (recalled persistent memory)

The runtime executor's prompt builder at `runtime-executor.ts:3985-3988` includes `session.data.values` as "Current Context" — which contains gathered values but **not** memory variables. Session memory lives in `state.memory.session` which is a separate namespace.

### Assumptions made

- `state.context` and `session.data.values` were sufficient — memory was for internal state tracking, not LLM context.
- The memory executor loads persistent data into `state.memory.persistentCache` and session defaults into `state.memory.session`, but nobody copies them into the prompt.

### Design decision needed

- Should all non-empty session memory and recalled persistent values be automatically included in the system prompt?
- Should the ABL author control which memory values are LLM-visible?

### Recommendation

Add a "Memory" section to the system prompt builder that includes:

1. Non-empty `state.memory.session` values
2. Non-empty `state.memory.persistentCache` values
3. Optionally: ABL-level `visible: true/false` flag per memory field (future)

---

## Concern 10: DELEGATE is LLM-discretionary — WHEN conditions blocked

**Severity**: Critical

### Why it exists

**Issue A (LLM prefers direct tools)**: The `__delegate__` tool at `compiler.ts:339-353` is generic:

```
"Call a sub-agent and use their result. Available targets: Fee_Calculator, ..."
```

It competes with 8+ specific tools like `check_change_eligibility` that have clear, descriptive schemas. The LLM naturally prefers the more specific tool. There's nothing in the prompt or tool schema saying "use delegation for fee calculation" — the ABL author's intent is invisible.

**Issue B (WHEN references non-GATHER variables)**: The delegate WHEN condition evaluator at `runtime-executor.ts:3313-3334` checks `session.data.values`. But entity extraction at line 2857-2868 only extracts GATHER fields. If the WHEN condition references `incident_category` which isn't a GATHER field, it stays `undefined` — condition fails — delegation blocked.

### Assumptions made

- The LLM would discover `__delegate__` and prefer it for the right cases.
- WHEN condition variables would already be populated (through GATHER or previous tool calls).
- No analysis was done on which variables WHEN conditions reference vs what extraction provides.

### Design decisions needed

1. **Delegation trigger**: Should delegation be LLM-driven (current), runtime-driven (auto-delegate when WHEN condition matches), or hybrid?
2. **Extraction scope**: Should extraction include variables referenced in DELEGATE WHEN conditions, not just GATHER fields?

### Recommendation

1. **Runtime-driven delegation**: After extraction, evaluate DELEGATE WHEN conditions programmatically. If a condition matches, invoke the delegate automatically — don't wait for the LLM. The LLM never needs to call `__delegate__` directly.
2. **Extended extraction scope**: Scan DELEGATE WHEN expressions for variable references at compile time. Include them in the extraction field list alongside GATHER fields. This requires a compiler change in `compileGather()` to union GATHER fields with DELEGATE WHEN variables.

---

## Design Decisions Summary

| Priority | Decision                                          | Affects Concerns |
| -------- | ------------------------------------------------- | ---------------- |
| **P0**   | Fix scripted-mode-after-handoff bug               | #4               |
| **P0**   | Break handoff loop after first success            | #1               |
| **P1**   | Add programmatic pre-evaluation for routing       | #7, #8, #10      |
| **P1**   | Extend extraction to DELEGATE WHEN variables      | #10              |
| **P1**   | Enrich extraction prompt with field metadata      | #6               |
| **P2**   | Per-agent tools for supervisors (agents-as-tools) | #2, #3           |
| **P2**   | Surface memory in system prompts                  | #9               |
| **P3**   | Text + handoff collision policy                   | #5               |

---

## Implementation Phases

### Phase 1: Bug fixes (runtime only, no IR/compiler changes)

- Fix #4: In `handleHandoff()`, check `targetAgentInfo.ir.execution?.mode` and skip reasoning-style prompt for scripted agents
- Fix #1: Break the tool call loop immediately after first successful handoff; queue remaining targets in `_pendingHandoffs`
- Fix #8: Include `rule.priority` in the routing prompt: `"Priority N: **Agent** — description"`

### Phase 2: Programmatic evaluation (runtime + compiler changes)

- Add pre-evaluation layer for supervisor routing (#7): evaluate `RoutingRule.when` against session state before LLM call
- Extend extraction scope (#10B): scan DELEGATE WHEN expressions for variable references, include in extraction field list
- Auto-delegate when WHEN matches (#10A): runtime-driven delegation instead of LLM-driven
- Add runtime counters: `routing_failures`, `handoff_count` as auto-incremented session fields

### Phase 3: Extraction quality (runtime changes)

- Enrich extraction prompt (#6): include field defaults, enum values, validation rules from `GatherField`
- Use agent's persona language in extraction prompt
- Post-extraction validation: reject values violating `ValidationRule` constraints
- Feed extraction results explicitly into response generation context

### Phase 4: Tool topology (compiler + runtime changes)

- Per-agent tools for supervisors (#2, #3): `compileSystemTools()` generates N tools instead of one when `isSupervisor=true`
- Typed context passing: `pass` fields compile as required parameters per target tool
- Keep single `__handoff__` for regular agents (where handoff is rare)

### Phase 5: Memory & polish (runtime changes)

- Surface memory in prompts (#9): add session memory and persistent cache to system prompt builder
- Text + handoff collision policy (#5): suppress for supervisors, prepend for regular agents

---

## Key Files Reference

| File                                                                        | Role                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/compiler.ts`                             | Routing compilation, system tools, coordination                      |
| `packages/compiler/src/platform/ir/schema.ts`                               | IR types: `RoutingConfig`, `RoutingRule`, `HandoffConfig`, `AgentIR` |
| `packages/compiler/src/platform/constants.ts`                               | System tool names: `SYSTEM_TOOL_HANDOFF`, `SYSTEM_TOOL_DELEGATE`     |
| `packages/compiler/src/platform/constructs/executor.ts`                     | Main construct orchestrator (phase pipeline)                         |
| `packages/compiler/src/platform/constructs/executors/handoff-executor.ts`   | Handoff context passing, dynamic target resolution                   |
| `packages/compiler/src/platform/constructs/executors/delegate-executor.ts`  | Sub-agent invocation, result mapping                                 |
| `packages/compiler/src/platform/constructs/executors/reasoning-executor.ts` | LLM-driven tool use loop, system prompt builder                      |
| `packages/compiler/src/platform/constructs/executors/gather-executor.ts`    | Entity extraction (GATHER fields only)                               |
| `packages/compiler/src/platform/constructs/executors/memory-executor.ts`    | Session + persistent memory recall/remember                          |
| `apps/runtime/src/services/runtime-executor.ts`                             | Runtime: handoff handling, system prompt, tool call loop             |
