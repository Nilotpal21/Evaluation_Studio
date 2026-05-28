# Lifecycle Events, Structured Tool Schemas & Compiler Validation — Design

> **Purpose**: Design for 3.3, 3.2, and 4.1 from the ABL Engine Design Implementation Plan
> **Status**: Approved
> **Date**: 2026-03-01
> **Reference**: [`docs/DESIGN_IMPLEMENTATION_ABL_ENGINE.md`](../DESIGN_IMPLEMENTATION_ABL_ENGINE.md)

---

## Table of Contents

- [1. Summary of Decisions](#1-summary-of-decisions)
- [2. Event Taxonomy](#2-event-taxonomy)
- [3. Change 3.3 — Declarative Lifecycle Events](#3-change-33--declarative-lifecycle-events)
- [4. Change 3.2 — Structured System Tool Schemas](#4-change-32--structured-system-tool-schemas)
- [5. Change 4.1 — Compiler RECALL Event Validation](#5-change-41--compiler-recall-event-validation)
- [6. Implementation Order](#6-implementation-order)

---

## 1. Summary of Decisions

Decisions made during brainstorming that diverge from or simplify the original design doc:

| Topic                    | Original Design                                               | Decision                                                                                         | Rationale                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent events             | 4 events (before_enter, after_enter, before_exit, after_exit) | 2 named events (`agent:<name>:before`, `agent:<name>:after`) + wildcard (`agent:*:before/after`) | before_enter vs after_enter both fire in same sync block — no meaningful distinction for RECALL actions. Named events are more useful than generic (load different context per specialist).    |
| Delegate events          | Separate `delegate:before` / `delegate:after`                 | Dropped — unified into agent events                                                              | Handoff, delegate, and fan-out all invoke a child agent. RECALL doesn't need to distinguish invocation mechanism. Event payload carries `invocationType` for tracing.                          |
| Tool BEFORE events       | `tool:<name>:before`                                          | Dropped                                                                                          | Tool params already set by LLM. Injecting context before HTTP execution doesn't change params. Weak use case until Tool Context Access (4.2) exists.                                           |
| Custom EVENTS field      | `events?: string[]` on ToolDefinition                         | Dropped                                                                                          | `tool:<name>:after` in RECALL gives per-tool targeting directly. Custom event names add indirection without proportional value.                                                                |
| Tool after success/error | `tool:<name>:after:success` / `tool:<name>:after:error`       | Dropped                                                                                          | ON_RESULT SET / ON_ERROR SET (2.3, completed) already handle success/error distinction for variable mapping.                                                                                   |
| Events scope             | Potentially RECALL and REMEMBER                               | RECALL only                                                                                      | REMEMBER is condition-driven (`WHEN: X IS SET`), fires on state change. Events are the trigger mechanism for RECALL only.                                                                      |
| `thought` field          | Not specified                                                 | Optional on system tools, gated by `enable_thinking` in ExecutionConfig                          | `enable_thinking` already exists in IR. Description externalized later with 3.1 (prompt template system).                                                                                      |
| Handoff context schema   | Typed object from PASS fields                                 | Description-based with per-agent field listings                                                  | One tool serves multiple targets with different PASS fields. Typed union is confusing. Rich description with per-agent fields + types + descriptions guides the LLM without schema complexity. |
| PASS field descriptions  | PASS is a flat name list                                      | Hybrid: flat names resolve from session memory, inline objects for overrides                     | DRY — descriptions come from `MEMORY.session` declarations. Inline override when session memory doesn't have the field or needs a handoff-specific description.                                |

---

## 2. Event Taxonomy

```
SESSION (2)                AGENT (named + wildcard)         TOOL (named + wildcard)
───────────                ─────────────────────            ───────────────────────
session:start              agent:<name>:before              tool:<name>:after
session:end                agent:<name>:after               tool:*:after
                           agent:*:before
                           agent:*:after
```

**4 built-in lifecycle patterns + named references by agent/tool name.**

### How Events Relate to RECALL and REMEMBER

Events are **RECALL-only**. REMEMBER is unaffected.

- **RECALL** is event-driven. The `ON:` field subscribes to events. When the event fires, the RECALL action executes (inject_context, load_memory, prompt_llm).
- **REMEMBER** is condition-driven. The `WHEN:` field evaluates conditions against `session.data.values`. It fires via `evaluateRememberAfterStateChange()` after any state mutation. Events do not trigger or affect REMEMBER.

They work together:

```
session:start → RECALL loads user.preferences FROM FactStore INTO session
User says "I'm Alex" → extraction sets session.data.values.user_name = "Alex"
  → REMEMBER evaluates: "user_name IS SET" → true → persists to FactStore
Next session → RECALL ON session:start loads user.name = "Alex" from FactStore
```

### Backward Compatibility

```typescript
const LEGACY_EVENT_ALIASES: Record<string, string> = {
  session_start: 'session:start',
  session_end: 'session:end',
  agent_enter: 'agent:*:after',
  agent_exit: 'agent:*:after',
  delegate_complete: 'agent:*:after',
};
```

Legacy event names in existing RECALL rules continue to work via alias resolution.

---

## 3. Change 3.3 — Declarative Lifecycle Events

### Scope

Pure runtime refactor. **No IR changes. No parser changes.** The event taxonomy is resolved at runtime from existing IR data (tool names from `ToolDefinition.name`, agent names from routing rules / coordination handoffs).

### Files Changed

| File                    | Change                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event-detector.ts`     | Delete `detectToolEvents()` + `detectEvents()`. Add `resolveToolAfterEvents()`, `resolveAgentEvents()`. Export `LIFECYCLE_PATTERNS`, `LEGACY_EVENT_ALIASES`. |
| `memory-integration.ts` | Update `executeRecallAfterToolCall()` to use `resolveToolAfterEvents()`. Update `initializeAllMemory()` to use `session:start`.                              |
| `memory-executor.ts`    | Add wildcard matching (`*`) in event comparison within `executeRecallForEvents()`.                                                                           |
| `routing-executor.ts`   | Emit `agent:<name>:before` / `agent:<name>:after` around handoff, delegate, and fan-out child execution.                                                     |
| `reasoning-executor.ts` | Emit `tool:<name>:after` after tool calls. Convert 1 fire-and-forget `.catch()` to `await`.                                                                  |
| `flow-step-executor.ts` | Emit `tool:<name>:after` after CALL steps. Convert 8 fire-and-forget `.catch()` sites to `await`.                                                            |

### event-detector.ts Rewrite

**Delete entirely:**

- `detectToolEvents(toolName: string)` — 5 hardcoded `startsWith` prefix rules
- `detectEvents(context)` — aggregator function

**Replace with:**

```typescript
export const LEGACY_EVENT_ALIASES: Record<string, string> = {
  session_start: 'session:start',
  session_end: 'session:end',
  agent_enter: 'agent:*:after',
  agent_exit: 'agent:*:after',
  delegate_complete: 'agent:*:after',
};

export const LIFECYCLE_PATTERNS: RegExp[] = [
  /^session:(start|end)$/,
  /^agent:[^:]+:(before|after)$/, // agent:<name>:before/after
  /^agent:\*:(before|after)$/, // agent:*:before/after (wildcard)
  /^tool:[^:]+:after$/, // tool:<name>:after
  /^tool:\*:after$/, // tool:*:after (wildcard)
  /^entity:[^:]+:extracted$/,
  /^step:(enter|exit):[^:]+$/,
];

/**
 * Resolve events after a tool call completes.
 * Returns the specific tool event + wildcard.
 */
export function resolveToolAfterEvents(toolName: string): string[] {
  return [`tool:${toolName}:after`, 'tool:*:after'];
}

/**
 * Resolve agent lifecycle events.
 * Fires for handoffs, delegates, and fan-out child agents.
 */
export function resolveAgentEvents(agentName: string, phase: 'before' | 'after'): string[] {
  return [`agent:${agentName}:${phase}`, `agent:*:${phase}`];
}

// KEEP unchanged: detectEntityEvents(), detectStepEvents()
```

### Wildcard Matching in memory-executor.ts

Update event comparison in `executeRecallForEvents()`:

```typescript
function eventMatches(instructionEvent: string, detectedEvents: string[]): boolean {
  // Normalize legacy aliases
  const normalized = LEGACY_EVENT_ALIASES[instructionEvent] || instructionEvent;

  // Direct match
  if (detectedEvents.includes(normalized)) return true;

  // Wildcard match: agent:*:before matches agent:Billing_Agent:before
  if (normalized.includes('*')) {
    const regex = new RegExp('^' + normalized.replace(/\*/g, '[^:]+') + '$');
    return detectedEvents.some((e) => regex.test(e));
  }

  return false;
}
```

### memory-integration.ts Changes

- `executeRecallAfterToolCall(session, toolName, onTraceEvent)` — calls `resolveToolAfterEvents(toolName)` instead of `detectToolEvents(toolName)`
- `initializeAllMemory()` — uses `['session:start']` as events, backward compat handled by `eventMatches()` normalizing `session_start` → `session:start`

### Executor Changes

**routing-executor.ts** — emit agent events around child execution (handoff, delegate, fan-out):

```
emit agent:<targetAgent>:before + agent:*:before → await RECALL
  [child agent runs]
emit agent:<targetAgent>:after + agent:*:after → await RECALL
```

Trace event payload:

```typescript
{
  type: 'agent_lifecycle',
  data: {
    agentName: targetAgent,
    phase: 'before' | 'after',
    invocationType: 'handoff' | 'delegate' | 'fan_out',
  }
}
```

**reasoning-executor.ts** — emit tool events after tool execution:

```
[tool executes, ON_RESULT/ON_ERROR SET applied]
emit tool:<toolName>:after + tool:*:after → await RECALL
```

**flow-step-executor.ts** — same tool event emission for CALL steps, digression calls.

### Fire-and-Forget Cleanup

Convert all `.catch(() => ...)` patterns to `await` with `try/catch`:

| File                    | Sites                                                                         | Pattern                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `flow-step-executor.ts` | 8 sites (digression, sub-intent, extraction variants, branch call, CALL step) | `evaluateRememberAfterStateChange().catch(...)` and `executeRecallAfterToolCall().catch(...)` |
| `reasoning-executor.ts` | 1 site (SET_CONTEXT handler)                                                  | `evaluateRememberAfterStateChange().catch(...)`                                               |

All become:

```typescript
try {
  await evaluateRememberAfterStateChange(session, onTraceEvent);
} catch (err) {
  log.warn('memory remember failed', {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

This ensures RECALL and REMEMBER complete before the next LLM iteration — especially important for `agent:<name>:before` events that load context the child agent needs.

### ABL Usage Examples

```yaml
# Supervisor agent with targeted context per specialist
MEMORY:
  recall:
    # Load billing-specific context before Billing_Agent
    - ON: agent:Billing_Agent:before
      ACTION: inject_context
      PATHS: [user.billing_history, user.payment_methods]

    # Load travel docs before Visa_Agent
    - ON: agent:Visa_Agent:before
      ACTION: inject_context
      PATHS: [user.nationality, user.passport_expiry]

    # Common context before any agent
    - ON: agent:*:before
      ACTION: inject_context
      PATHS: [user.name, user.language, user.tier]

    # After Booking_Agent finishes — persist outcomes
    - ON: agent:Booking_Agent:after
      ACTION: prompt_llm
      INSTRUCTION: 'Persist booking confirmation details'

    # After any agent — generic summary
    - ON: agent:*:after
      ACTION: prompt_llm
      INSTRUCTION: 'Summarize what the child agent accomplished'

    # After specific tool — load related memory
    - ON: tool:search_hotels:after
      ACTION: load_memory
      DOMAIN: hotel_preferences

    # After any tool — evaluate memory triggers
    - ON: tool:*:after
      ACTION: prompt_llm
      INSTRUCTION: 'Check if new information should be remembered'
```

---

## 4. Change 3.2 — Structured System Tool Schemas

### Files Changed

| File                      | Change                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt-builder.ts`       | Add `reason` to all system tools, `thought` when `enable_thinking`, context description with per-agent PASS field listings, agent descriptions in target |
| `reasoning-executor.ts`   | Strip `reason`/`thought` from tool input before execution, emit as trace events                                                                          |
| `routing-executor.ts`     | Same stripping for handoff/delegate/fan-out/escalate/complete                                                                                            |
| `constants.ts`            | Add `reason` and `thought` descriptions to `SYSTEM_TOOL_DESCRIPTIONS`                                                                                    |
| `compiler/ir/schema.ts`   | Extend `HandoffPassField` to support inline TYPE/DESCRIPTION                                                                                             |
| `agent-based-parser.ts`   | Parse hybrid PASS syntax (flat names + inline objects)                                                                                                   |
| `compiler/ir/compiler.ts` | Resolve PASS field descriptions from session memory declarations                                                                                         |

### `reason` — Required on All System Tools

Add `reason` as required string to all 6 system tools: `__handoff__`, `__delegate__`, `__escalate__`, `__fan_out__`, `__complete__`, `__set_context__`.

`__escalate__` already has `reason` — no change needed there.

```typescript
// prompt-builder.ts — added to every system tool schema
properties: {
  reason: {
    type: 'string',
    description: TD.reason,
  },
  // ... other tool-specific properties
},
required: ['reason', ...otherRequired],
```

### `thought` — Optional, Agent-Level Opt-In

Gated by `enable_thinking` in `ExecutionConfig` (already exists in IR schema):

```typescript
// prompt-builder.ts — conditional injection
if (ir.execution?.enable_thinking) {
  properties.thought = {
    type: 'string',
    description: TD.thought, // constant for now, externalized with 3.1 later
  };
  // NOT added to required — optional
}
```

### Stripping Before Execution

Both `reason` and `thought` are stripped from tool input before the tool executes. They're emitted as trace event fields for observability:

```typescript
// reasoning-executor.ts + routing-executor.ts
const { reason, thought, ...cleanInput } = toolCall.input;
if (reason || thought) {
  onTraceEvent?.({
    type: 'decision',
    data: {
      action: toolCall.name,
      reasoning: reason,
      thought,
    },
  });
}
// Pass cleanInput to tool executor
```

### PASS Field Descriptions — Hybrid DSL Syntax

PASS fields support two forms: flat name (resolves from session memory) or inline object with TYPE/DESCRIPTION.

**DSL syntax:**

```yaml
MEMORY:
  session:
    - NAME: customer_id
      TYPE: string
      DESCRIPTION: 'Unique customer identifier'
    - NAME: plan_type
      TYPE: string
      DESCRIPTION: 'Current subscription plan (basic, premium, enterprise)'

COORDINATION:
  HANDOFFS:
    - TO: Billing_Agent
      PASS:
        - customer_id # resolved from MEMORY.session
        - plan_type # resolved from MEMORY.session
        - outstanding_balance: # inline override
            TYPE: number
            DESCRIPTION: 'Amount owed by the customer in USD'

    - TO: Support_Agent
      PASS:
        - booking_id:
            TYPE: string
            DESCRIPTION: 'Booking reference number'
        - customer_tier:
            TYPE: string
            DESCRIPTION: 'Support tier (standard, premium, vip)'
```

**Resolution chain at compile time:**

1. If PASS field has inline TYPE/DESCRIPTION → use those
2. Else look up the name in `MEMORY.session` declarations → use those
3. Else fallback → `type: string`, no description

**IR representation:**

```typescript
// compiler/ir/schema.ts — extend HandoffConfig
interface ResolvedPassField {
  name: string;
  type: string; // resolved: inline → session memory → 'string'
  description?: string; // resolved: inline → session memory → undefined
}

interface HandoffConfig {
  to: string;
  // ... existing fields ...
  context?: {
    pass: ResolvedPassField[]; // was string[], now resolved with types/descriptions
    // ... existing fields ...
  };
}
```

**Backward compatibility:** Plain `PASS: [field1, field2]` list syntax continues to work — the parser treats each string element as a flat name with no inline override.

### Handoff Context Schema — Description-Based Per-Agent Guidance

Since each agent has different PASS fields, the context stays `type: object` with a dynamically built description listing per-agent fields with their resolved types and descriptions:

```typescript
// prompt-builder.ts — build context description from resolved PASS fields
const contextLines = handoffConfigs
  .map((config) => {
    const fields =
      config.context?.pass
        ?.map((f) => {
          const desc = f.description ? ` — ${f.description}` : '';
          return `  - ${f.name} (${f.type})${desc}`;
        })
        .join('\n') || '  (no specific fields)';
    return `${config.to}:\n${fields}`;
  })
  .join('\n');

const contextSchema = {
  type: 'object',
  description: `Context for the target agent. Populate relevant fields from conversation. Missing fields auto-filled from session.\n\nFields by target:\n${contextLines}`,
};
```

**What the LLM sees:**

```json
"context": {
  "type": "object",
  "description": "Context for the target agent. Populate relevant fields from conversation. Missing fields auto-filled from session.\n\nFields by target:\nBilling_Agent:\n  - customer_id (string) — Unique customer identifier\n  - plan_type (string) — Current subscription plan (basic, premium, enterprise)\n  - outstanding_balance (number) — Amount owed by the customer in USD\nSupport_Agent:\n  - booking_id (string) — Booking reference number\n  - customer_tier (string) — Support tier (standard, premium, vip)"
}
```

The LLM reads which target it's routing to, finds the matching fields in the description, and populates them. Runtime still falls back to session values for any field the LLM doesn't populate.

### Agent Descriptions in `target` Enum

Embed routing rule descriptions and/or agent goals in the `target` field description:

```typescript
// prompt-builder.ts — handoff target field
const targetDescription = handoffTargets.map(t => {
  const rule = ir.routing?.rules?.find(r => r.to === t);
  const agentGoal = agentRegistry[t]?.ir?.identity?.goal || '';
  const desc = rule?.description || agentGoal;
  return desc ? `"${t}": ${desc}` : `"${t}"`;
}).join('\n- ');

target: {
  type: 'string',
  enum: handoffTargets,
  description: `The specialist to route to:\n- ${targetDescription}`,
}
```

### Constants

Add to `SYSTEM_TOOL_DESCRIPTIONS` in `constants.ts`:

```typescript
reason: 'Brief reason for this action (used for tracing and debugging)',
thought: 'Your detailed reasoning about why this is the right action',
```

---

## 5. Change 4.1 — Compiler RECALL Event Validation

### Files Changed

| File                      | Change                                                                     |
| ------------------------- | -------------------------------------------------------------------------- |
| `compiler/ir/compiler.ts` | Add `validateRecallEvents()` pass, call during compilation                 |
| `event-detector.ts`       | Already exports `LIFECYCLE_PATTERNS` and `LEGACY_EVENT_ALIASES` (from 3.3) |

### Validation Logic

The compiler validates every RECALL `ON:` event against:

1. Built-in lifecycle patterns (from `LIFECYCLE_PATTERNS`)
2. Legacy aliases (from `LEGACY_EVENT_ALIASES`)
3. Tool names in `tool:<name>:after` references (from declared tools)
4. Agent names in `agent:<name>:before/after` references (from routing rules + coordination handoffs)

```typescript
function validateRecallEvents(
  recall: RecallInstruction[],
  declaredTools: ToolDefinition[],
  knownAgents: string[],
): ValidationDiagnostic[] {
  const toolNames = new Set(declaredTools.map((t) => t.name));
  const agentNames = new Set(knownAgents);
  const legacyAliases = new Set(Object.keys(LEGACY_EVENT_ALIASES));

  return recall
    .filter((r) => {
      const event = r.event;
      // Known legacy alias — valid
      if (legacyAliases.has(event)) return false;
      // Matches a lifecycle pattern
      if (LIFECYCLE_PATTERNS.some((p) => p.test(event))) {
        // If it references a specific tool, verify tool exists
        const toolMatch = event.match(/^tool:([^:*]+):after$/);
        if (toolMatch && !toolNames.has(toolMatch[1])) return true; // invalid tool
        // If it references a specific agent, verify agent exists
        const agentMatch = event.match(/^agent:([^:*]+):(before|after)$/);
        if (agentMatch && !agentNames.has(agentMatch[1])) return true; // invalid agent
        return false; // valid pattern with valid name
      }
      return true; // unrecognized event
    })
    .map((r) => {
      const toolMatch = r.event.match(/^tool:([^:*]+):after$/);
      const agentMatch = r.event.match(/^agent:([^:*]+):(before|after)$/);

      let message: string;
      if (toolMatch) {
        message = `RECALL event "${r.event}" references unknown tool "${toolMatch[1]}". Declared tools: ${[...toolNames].join(', ')}`;
      } else if (agentMatch) {
        message = `RECALL event "${r.event}" references unknown agent "${agentMatch[1]}". Known agents: ${[...agentNames].join(', ')}`;
      } else {
        message = `RECALL event "${r.event}" does not match any known event. Valid patterns: session:start, session:end, agent:<name>:before, agent:<name>:after, agent:*:before, agent:*:after, tool:<name>:after, tool:*:after`;
      }

      return {
        severity: 'warning' as const,
        message,
        location: { agent: 'unknown' },
      };
    });
}
```

### Integration

Called during `compileABLtoIR()` after all agents and tools are parsed:

```typescript
// compiler.ts — in compilation pipeline
if (ir.memory?.recall?.length) {
  const knownAgents = collectKnownAgents(ir); // from routing rules + coordination handoffs
  const recallDiagnostics = validateRecallEvents(ir.memory.recall, ir.tools || [], knownAgents);
  diagnostics.push(...recallDiagnostics);
}
```

---

## 6. Implementation Order

```
Step 1: 3.3 Declarative Lifecycle Events (foundation)
  ├── Rewrite event-detector.ts (delete prefix detection, add resolvers, export patterns)
  ├── Update memory-integration.ts (use new resolvers)
  ├── Add wildcard matching in memory-executor.ts
  ├── Emit agent events in routing-executor.ts (handoff, delegate, fan-out)
  ├── Emit tool events in reasoning-executor.ts + flow-step-executor.ts
  ├── Convert 9 fire-and-forget .catch() to await
  └── Tests: event resolution, wildcard matching, agent lifecycle, backward compat

Step 2: 3.2 Structured System Tool Schemas (builds on executor changes)
  ├── Extend HandoffPassField IR type with type/description
  ├── Parse hybrid PASS syntax in agent-based-parser.ts
  ├── Resolve PASS field descriptions from session memory in compiler
  ├── Add reason to all 6 system tools in prompt-builder.ts
  ├── Add thought (gated by enable_thinking) in prompt-builder.ts
  ├── Build context description with per-agent PASS field listings
  ├── Embed agent descriptions in target enum description
  ├── Strip reason/thought before execution in reasoning-executor.ts + routing-executor.ts
  ├── Add constants in constants.ts
  └── Tests: reason required, thought opt-in, PASS resolution, context description, target descriptions

Step 3: 4.1 Compiler RECALL Event Validation (depends on 3.3 exports)
  ├── Import LIFECYCLE_PATTERNS + LEGACY_EVENT_ALIASES from event-detector.ts
  ├── Implement validateRecallEvents() in compiler.ts
  ├── Validate tool names and agent names in event references
  └── Tests: valid lifecycle, valid tool ref, invalid tool ref, invalid agent ref, legacy alias
```

Steps 1 and 2 touch overlapping executor files but different concerns (event emission vs tool schema stripping). Step 3 is small and depends on Step 1's exports.

---

## Implementation Plan

_Merged from `2026-03-01-lifecycle-events-tool-schemas-plan.md`._

### Task 1: Rewrite event-detector.ts — Delete Hardcoded Prefixes, Add Resolvers

**Files:**

- Modify: `apps/runtime/src/services/execution/event-detector.ts` (all 93 lines)
- Test: `apps/runtime/src/__tests__/event-detector.test.ts`

**Step 1: Write the failing tests**

Create `apps/runtime/src/__tests__/event-detector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  resolveToolAfterEvents,
  resolveAgentEvents,
  LIFECYCLE_PATTERNS,
  LEGACY_EVENT_ALIASES,
} from '../services/execution/event-detector';

describe('resolveToolAfterEvents', () => {
  it('returns specific + wildcard events for a tool name', () => {
    const events = resolveToolAfterEvents('search_hotels');
    expect(events).toEqual(['tool:search_hotels:after', 'tool:*:after']);
  });

  it('handles tool names with special characters', () => {
    const events = resolveToolAfterEvents('buscar_vuelos');
    expect(events).toEqual(['tool:buscar_vuelos:after', 'tool:*:after']);
  });
});

describe('resolveAgentEvents', () => {
  it('returns named + wildcard events for agent before', () => {
    const events = resolveAgentEvents('Billing_Agent', 'before');
    expect(events).toEqual(['agent:Billing_Agent:before', 'agent:*:before']);
  });

  it('returns named + wildcard events for agent after', () => {
    const events = resolveAgentEvents('Visa_Agent', 'after');
    expect(events).toEqual(['agent:Visa_Agent:after', 'agent:*:after']);
  });
});

describe('LIFECYCLE_PATTERNS', () => {
  it('matches session events', () => {
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('session:start'))).toBe(true);
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('session:end'))).toBe(true);
  });

  it('matches named agent events', () => {
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('agent:Billing_Agent:before'))).toBe(true);
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('agent:Billing_Agent:after'))).toBe(true);
  });

  it('matches wildcard agent events', () => {
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('agent:*:before'))).toBe(true);
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('agent:*:after'))).toBe(true);
  });

  it('matches named tool events', () => {
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('tool:search_hotels:after'))).toBe(true);
  });

  it('matches wildcard tool events', () => {
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('tool:*:after'))).toBe(true);
  });

  it('rejects invalid events', () => {
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('booking_completed'))).toBe(false);
    expect(LIFECYCLE_PATTERNS.some((p) => p.test('tool:search:before'))).toBe(false); // no tool:before in new taxonomy
  });
});

describe('LEGACY_EVENT_ALIASES', () => {
  it('maps session_start to session:start', () => {
    expect(LEGACY_EVENT_ALIASES['session_start']).toBe('session:start');
  });

  it('maps agent_enter to agent:*:after', () => {
    expect(LEGACY_EVENT_ALIASES['agent_enter']).toBe('agent:*:after');
  });

  it('maps delegate_complete to agent:*:after', () => {
    expect(LEGACY_EVENT_ALIASES['delegate_complete']).toBe('agent:*:after');
  });
});
```

**Step 2: Run the tests to verify they fail**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/event-detector.test.ts`
Expected: FAIL — imports don't exist yet (resolveToolAfterEvents, resolveAgentEvents, LIFECYCLE_PATTERNS, LEGACY_EVENT_ALIASES)

**Step 3: Rewrite event-detector.ts**

Replace the entire contents of `apps/runtime/src/services/execution/event-detector.ts`:

```typescript
/**
 * Event resolution for the lifecycle event system.
 *
 * Event taxonomy (4 built-in patterns + named references):
 *   session:start, session:end
 *   agent:<name>:before, agent:<name>:after  (+ agent:*:before, agent:*:after)
 *   tool:<name>:after  (+ tool:*:after)
 *   entity:<field>:extracted, step:(enter|exit):<name>
 */

/** Legacy event names → new lifecycle format */
export const LEGACY_EVENT_ALIASES: Record<string, string> = {
  session_start: 'session:start',
  session_end: 'session:end',
  agent_enter: 'agent:*:after',
  agent_exit: 'agent:*:after',
  delegate_complete: 'agent:*:after',
};

/** Valid lifecycle event patterns (used by compiler validation in 4.1) */
export const LIFECYCLE_PATTERNS: RegExp[] = [
  /^session:(start|end)$/,
  /^agent:[^:]+:(before|after)$/,
  /^agent:\*:(before|after)$/,
  /^tool:[^:]+:after$/,
  /^tool:\*:after$/,
  /^entity:[^:]+:extracted$/,
  /^step:(enter|exit):[^:]+$/,
];

/**
 * Resolve events after a tool call completes.
 * Returns the specific tool event + wildcard.
 */
export function resolveToolAfterEvents(toolName: string): string[] {
  return [`tool:${toolName}:after`, 'tool:*:after'];
}

/**
 * Resolve agent lifecycle events.
 * Fires for handoffs, delegates, and fan-out child agents.
 */
export function resolveAgentEvents(agentName: string, phase: 'before' | 'after'): string[] {
  return [`agent:${agentName}:${phase}`, `agent:*:${phase}`];
}

/**
 * Resolve entity extraction events. KEPT from original.
 */
export function detectEntityEvents(fieldNames: string[]): string[] {
  return fieldNames.map((name) => `entity:${name}:extracted`);
}

/**
 * Resolve step transition events. KEPT from original.
 */
export function detectStepEvents(stepName: string): string[] {
  return [`step:enter:${stepName}`];
}
```

**Step 4: Run the tests to verify they pass**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/event-detector.test.ts`
Expected: PASS

**Step 5: Check for existing imports of deleted functions**

Run: `grep -rn "detectToolEvents\|detectEvents" apps/runtime/src/ --include='*.ts' | grep -v test | grep -v node_modules`

This will show all call sites that need updating in subsequent tasks. Do NOT fix them yet — they're covered by Tasks 3 and 5.

**Step 6: Commit**

```bash
git add apps/runtime/src/services/execution/event-detector.ts apps/runtime/src/__tests__/event-detector.test.ts
git commit -m "feat(runtime): rewrite event-detector with named lifecycle events

Delete hardcoded startsWith prefix detection (detectToolEvents, detectEvents).
Add resolveToolAfterEvents(), resolveAgentEvents() with named + wildcard patterns.
Export LIFECYCLE_PATTERNS and LEGACY_EVENT_ALIASES for compiler validation."
```

---

### Task 2: Add Wildcard Matching in memory-executor.ts

**Files:**

- Modify: `apps/runtime/src/services/execution/memory-executor.ts:87`
- Test: `apps/runtime/src/__tests__/memory-executor-events.test.ts`

**Step 1: Write the failing tests**

Create `apps/runtime/src/__tests__/memory-executor-events.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { eventMatches } from '../services/execution/event-matching';

describe('eventMatches', () => {
  it('matches exact event', () => {
    expect(eventMatches('session:start', ['session:start', 'session:end'])).toBe(true);
  });

  it('rejects non-matching event', () => {
    expect(eventMatches('session:end', ['session:start'])).toBe(false);
  });

  it('matches wildcard agent:*:before against specific agent', () => {
    expect(eventMatches('agent:*:before', ['agent:Billing_Agent:before'])).toBe(true);
  });

  it('matches wildcard agent:*:after against specific agent', () => {
    expect(eventMatches('agent:*:after', ['agent:Visa_Agent:after'])).toBe(true);
  });

  it('matches wildcard tool:*:after against specific tool', () => {
    expect(eventMatches('tool:*:after', ['tool:search_hotels:after'])).toBe(true);
  });

  it('does not match wildcard against wrong phase', () => {
    expect(eventMatches('agent:*:before', ['agent:Billing_Agent:after'])).toBe(false);
  });

  it('resolves legacy alias session_start to session:start', () => {
    expect(eventMatches('session_start', ['session:start'])).toBe(true);
  });

  it('resolves legacy alias agent_enter to agent:*:after', () => {
    expect(eventMatches('agent_enter', ['agent:Billing_Agent:after'])).toBe(true);
  });

  it('resolves legacy alias delegate_complete to agent:*:after', () => {
    expect(eventMatches('delegate_complete', ['agent:Support_Agent:after'])).toBe(true);
  });

  it('matches specific named agent event directly', () => {
    expect(eventMatches('agent:Billing_Agent:before', ['agent:Billing_Agent:before'])).toBe(true);
  });

  it('does not match different named agent', () => {
    expect(eventMatches('agent:Billing_Agent:before', ['agent:Visa_Agent:before'])).toBe(false);
  });
});
```

**Step 2: Run the tests to verify they fail**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/memory-executor-events.test.ts`
Expected: FAIL — `eventMatches` doesn't exist yet

**Step 3: Create the event-matching utility**

Create `apps/runtime/src/services/execution/event-matching.ts`:

```typescript
import { LEGACY_EVENT_ALIASES } from './event-detector';

/**
 * Check if a RECALL instruction's event matches any of the detected events.
 * Supports:
 * - Direct match: 'session:start' matches ['session:start']
 * - Wildcard match: 'agent:*:before' matches ['agent:Billing_Agent:before']
 * - Legacy alias: 'session_start' normalizes to 'session:start'
 */
export function eventMatches(instructionEvent: string, detectedEvents: string[]): boolean {
  // Normalize legacy aliases
  const normalized = LEGACY_EVENT_ALIASES[instructionEvent] || instructionEvent;

  // Direct match
  if (detectedEvents.includes(normalized)) return true;

  // Wildcard match: agent:*:before matches agent:Billing_Agent:before
  if (normalized.includes('*')) {
    const regex = new RegExp('^' + normalized.replace(/\*/g, '[^:]+') + '$');
    return detectedEvents.some((e) => regex.test(e));
  }

  return false;
}
```

**Step 4: Run the tests to verify they pass**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/memory-executor-events.test.ts`
Expected: PASS

**Step 5: Update memory-executor.ts to use eventMatches**

In `apps/runtime/src/services/execution/memory-executor.ts` at line 87, replace the inline `detectedEvents.includes(instruction.event)` with `eventMatches(instruction.event, detectedEvents)`.

Read the file first, then change:

```typescript
// OLD (line 87):
if (!detectedEvents.includes(instruction.event)) {
  continue;
}

// NEW:
if (!eventMatches(instruction.event, detectedEvents)) {
  continue;
}
```

Add the import at the top of the file:

```typescript
import { eventMatches } from './event-matching';
```

**Step 6: Run full memory-executor tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/memory-executor`
Expected: PASS (existing tests should still pass since direct match works the same)

**Step 7: Commit**

```bash
git add apps/runtime/src/services/execution/event-matching.ts apps/runtime/src/__tests__/memory-executor-events.test.ts apps/runtime/src/services/execution/memory-executor.ts
git commit -m "feat(runtime): add wildcard event matching with legacy alias support

Extract eventMatches() utility supporting direct match, wildcard (agent:*:before),
and legacy alias normalization (session_start → session:start)."
```

---

### Task 3: Update memory-integration.ts to Use New Resolvers

**Files:**

- Modify: `apps/runtime/src/services/execution/memory-integration.ts:48-108, 319-354`

**Step 1: Read the current file**

Read `apps/runtime/src/services/execution/memory-integration.ts` to understand current imports and usage.

**Step 2: Update imports**

Replace `detectToolEvents` import (from `./event-detector`) with `resolveToolAfterEvents`:

```typescript
// OLD:
import { detectToolEvents } from './event-detector';

// NEW:
import { resolveToolAfterEvents } from './event-detector';
```

**Step 3: Update initializeAllMemory**

At line ~88 inside `initializeAllMemory()`, change the events array:

```typescript
// OLD:
const events = ['session_start'];

// NEW:
const events = ['session:start'];
```

Legacy RECALL rules using `session_start` still work because `eventMatches()` normalizes via `LEGACY_EVENT_ALIASES`.

**Step 4: Update executeRecallAfterToolCall**

At line ~338 inside `executeRecallAfterToolCall()`, change the call:

```typescript
// OLD:
const toolEvents = detectToolEvents(toolName);

// NEW:
const toolEvents = resolveToolAfterEvents(toolName);
```

**Step 5: Build and run existing tests**

Run: `cd apps/runtime && pnpm build && pnpm vitest run src/__tests__/memory-integration`
Expected: PASS — existing tests should still pass (session:start normalizes, tool events now use resolvers)

**Step 6: Commit**

```bash
git add apps/runtime/src/services/execution/memory-integration.ts
git commit -m "feat(runtime): use new event resolvers in memory-integration

Replace detectToolEvents with resolveToolAfterEvents.
Use session:start instead of session_start (backward compat via eventMatches)."
```

---

### Task 4: Emit Agent Lifecycle Events in routing-executor.ts

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:306, 756, 1037-1127`
- Test: `apps/runtime/src/__tests__/routing-agent-events.test.ts`

**Step 1: Read the routing-executor.ts around handoff, delegate, and fan-out**

Read the file at lines 295-380 (handoff), 745-800 (delegate), 1030-1170 (fan-out) to understand the exact structure.

**Step 2: Write the tests**

Create `apps/runtime/src/__tests__/routing-agent-events.test.ts` that verifies:

- `resolveAgentEvents` is called with the target agent name and 'before' before child execution
- `resolveAgentEvents` is called with the target agent name and 'after' after child execution
- The RECALL system is invoked with the resolved events
- Trace events of type `agent_lifecycle` are emitted with `agentName`, `phase`, and `invocationType`

The exact test setup depends on the mocking patterns already used in `routing-executor.test.ts`. Read the existing test file first to match the pattern.

**Step 3: Add imports to routing-executor.ts**

```typescript
import { resolveAgentEvents } from './event-detector';
import { executeRecallForEvents } from './memory-integration';
```

**Step 4: Add agent events around handleHandoff**

Around line 306 (thread creation) and lines 369-374 (execution), wrap with:

```typescript
// BEFORE child agent — emit agent:<name>:before events + run RECALL
const beforeAgentEvents = resolveAgentEvents(targetAgentName, 'before');
await executeRecallForEvents(
  session,
  recall,
  beforeAgentEvents,
  `agent:${targetAgentName}:before`,
  onTraceEvent,
);
onTraceEvent?.({
  type: 'agent_lifecycle',
  data: { agentName: targetAgentName, phase: 'before', invocationType: 'handoff' },
});

// ... [existing thread creation + execution] ...

// AFTER child agent — emit agent:<name>:after events + run RECALL
const afterAgentEvents = resolveAgentEvents(targetAgentName, 'after');
await executeRecallForEvents(
  session,
  recall,
  afterAgentEvents,
  `agent:${targetAgentName}:after`,
  onTraceEvent,
);
onTraceEvent?.({
  type: 'agent_lifecycle',
  data: { agentName: targetAgentName, phase: 'after', invocationType: 'handoff' },
});
```

**Step 5: Add agent events around handleDelegate**

Same pattern around line 756 (thread creation) and 792 (execution), with `invocationType: 'delegate'`.

**Step 6: Add agent events around handleFanOut**

For fan-out, emit events for each child agent individually within the loop at lines 1037-1049:

```typescript
// For each task in fan-out:
const beforeEvents = resolveAgentEvents(task.agentName, 'before');
await executeRecallForEvents(
  session,
  recall,
  beforeEvents,
  `agent:${task.agentName}:before`,
  onTraceEvent,
);
onTraceEvent?.({
  type: 'agent_lifecycle',
  data: { agentName: task.agentName, phase: 'before', invocationType: 'fan_out' },
});

// ... [existing child execution] ...

const afterEvents = resolveAgentEvents(task.agentName, 'after');
await executeRecallForEvents(
  session,
  recall,
  afterEvents,
  `agent:${task.agentName}:after`,
  onTraceEvent,
);
onTraceEvent?.({
  type: 'agent_lifecycle',
  data: { agentName: task.agentName, phase: 'after', invocationType: 'fan_out' },
});
```

**Step 7: Run tests**

Run: `cd apps/runtime && pnpm build && pnpm vitest run src/__tests__/routing`
Expected: PASS

**Step 8: Commit**

```bash
git add apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/routing-agent-events.test.ts
git commit -m "feat(runtime): emit agent:<name>:before/after events in routing executor

Handoff, delegate, and fan-out all emit named agent lifecycle events.
RECALL rules can now load per-specialist context before agent starts
and persist results after agent completes."
```

---

### Task 5: Emit Tool Events + Fix Fire-and-Forget in Executors

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:655`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:1481-2376` (17 .catch sites)

**Step 1: Read the fire-and-forget sites**

Read `reasoning-executor.ts` around line 655 and `flow-step-executor.ts` at the .catch sites (lines 1481, 1490, 1580, 1589, 1695, 1700, 1711, 1762, 1767, 1779, 2063, 2072, 2150, 2155, 2167, 2371, 2376).

**Step 2: Fix reasoning-executor.ts fire-and-forget (line 655)**

Convert:

```typescript
// OLD (line 655):
evaluateRememberAfterStateChange(session, onTraceEvent).catch((err) =>
  log.warn('memory remember after set_context failed', {
    error: err instanceof Error ? err.message : String(err),
  }),
);

// NEW:
try {
  await evaluateRememberAfterStateChange(session, onTraceEvent);
} catch (err) {
  log.warn('memory remember after set_context failed', {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

**Step 3: Add tool event emission in reasoning-executor.ts**

After tool call completion (around lines 203-223 or 760-771 where tool calls are processed), add:

```typescript
import { resolveToolAfterEvents } from './event-detector';

// After tool result is processed and ON_RESULT/ON_ERROR SET applied:
const toolAfterEvents = resolveToolAfterEvents(toolCall.name);
await executeRecallForEvents(
  session,
  recall,
  toolAfterEvents,
  `tool:${toolCall.name}:after`,
  onTraceEvent,
);
```

Read the existing code carefully to find the right insertion point — it should be AFTER the tool result is stored in session state but BEFORE the next LLM iteration.

**Step 4: Fix all 17 fire-and-forget sites in flow-step-executor.ts**

For each `.catch(...)` site, convert to `await` + `try/catch`:

```typescript
// OLD pattern:
evaluateRememberAfterStateChange(session, onTraceEvent).catch((err) =>
  log.warn('memory remember failed', { error: err instanceof Error ? err.message : String(err) }),
);

// NEW pattern:
try {
  await evaluateRememberAfterStateChange(session, onTraceEvent);
} catch (err) {
  log.warn('memory remember failed', { error: err instanceof Error ? err.message : String(err) });
}
```

Apply this to ALL 17 sites. Group the consecutive ones (e.g., lines 1481+1490 are sequential REMEMBER + RECALL calls — both become awaited try/catch).

**Step 5: Add tool event emission in flow-step-executor.ts**

After CALL steps and digression/branch tool calls, add tool event emission same as reasoning-executor.

**Step 6: Build and run all runtime tests**

Run: `cd apps/runtime && pnpm build && pnpm vitest run`
Expected: PASS (all existing tests + new event tests)

**Step 7: Commit**

```bash
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "feat(runtime): emit tool events + convert fire-and-forget to await

Add tool:<name>:after event emission after tool calls in both executors.
Convert all 17 fire-and-forget .catch() sites to await with try/catch.
RECALL now completes before next LLM iteration."
```

---

### Task 6: Extend IR Schema with ResolvedPassField

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:764-778`
- Test: Type-level only — no runtime test needed

**Step 1: Read the current HandoffConfig**

Read `packages/compiler/src/platform/ir/schema.ts` at lines 764-778.

**Step 2: Add ResolvedPassField type and update HandoffConfig**

```typescript
// Add above HandoffConfig (around line 760):
export interface ResolvedPassField {
  name: string;
  type: string;         // resolved: inline → session memory → 'string'
  description?: string; // resolved: inline → session memory → undefined
}

// Update HandoffConfig.context.pass:
// OLD:
pass: string[];

// NEW:
pass: ResolvedPassField[];
```

**Step 3: Build to check for type errors**

Run: `pnpm build`

This will likely show errors in files that currently push `string[]` into `pass`. Note these sites — they'll be fixed in Task 8 (parser) and Task 9 (prompt-builder reads them).

Expected: Some type errors in compiler.ts and prompt-builder.ts. That's fine — we fix them in later tasks.

**Step 4: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts
git commit -m "feat(compiler): add ResolvedPassField type to HandoffConfig

PASS fields now carry name, type, and optional description.
Type errors in downstream consumers are fixed in subsequent commits."
```

---

### Task 7: Add reason/thought Constants

**Files:**

- Modify: `packages/compiler/src/platform/constants.ts:323-365`

**Step 1: Read the current SYSTEM_TOOL_DESCRIPTIONS**

Read `packages/compiler/src/platform/constants.ts` at lines 323-365.

**Step 2: Add reason and thought descriptions**

Add to the `SYSTEM_TOOL_DESCRIPTIONS` object:

```typescript
reason: 'Brief reason for this action (used for tracing and debugging)',
thought: 'Your detailed reasoning about why this is the right action',
```

**Step 3: Build**

Run: `pnpm build`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/compiler/src/platform/constants.ts
git commit -m "feat(compiler): add reason and thought to SYSTEM_TOOL_DESCRIPTIONS"
```

---

### Task 8: Parse Hybrid PASS Syntax in Parser + Resolve in Compiler

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts:2930-2931, 2966-2968`
- Modify: `packages/compiler/src/platform/ir/compiler.ts:865-869`
- Test: `packages/core/src/__tests__/parser-pass-fields.test.ts`
- Test: `packages/compiler/src/__tests__/compiler-pass-resolution.test.ts`

**Step 1: Write failing parser test**

Create `packages/core/src/__tests__/parser-pass-fields.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseABL } from '../parser/agent-based-parser';

describe('PASS field hybrid syntax', () => {
  it('parses flat name PASS fields as strings', () => {
    const abl = `
AGENT: Test_Agent
VERSION: 1.0
DESCRIPTION: 'Test agent'
COORDINATION:
  HANDOFFS:
    - TO: Billing_Agent
      PASS: [customer_id, plan_type]
`;
    const result = parseABL(abl);
    const handoff = result.agents[0].coordination?.handoffs?.[0];
    expect(handoff?.context?.pass).toEqual([{ name: 'customer_id' }, { name: 'plan_type' }]);
  });

  it('parses inline object PASS fields with TYPE and DESCRIPTION', () => {
    const abl = `
AGENT: Test_Agent
VERSION: 1.0
DESCRIPTION: 'Test agent'
COORDINATION:
  HANDOFFS:
    - TO: Billing_Agent
      CONTEXT:
        PASS:
          - customer_id
          - outstanding_balance:
              TYPE: number
              DESCRIPTION: 'Amount owed in USD'
`;
    const result = parseABL(abl);
    const handoff = result.agents[0].coordination?.handoffs?.[0];
    expect(handoff?.context?.pass).toEqual([
      { name: 'customer_id' },
      { name: 'outstanding_balance', type: 'number', description: 'Amount owed in USD' },
    ]);
  });
});
```

**Step 2: Run to verify failure**

Run: `cd packages/core && pnpm vitest run src/__tests__/parser-pass-fields.test.ts`
Expected: FAIL

**Step 3: Update parser to handle hybrid PASS syntax**

In `packages/core/src/parser/agent-based-parser.ts`, update the PASS parsing at lines 2930-2931 and 2966-2968.

Currently `parseArray(value)` returns `string[]`. We need to:

1. For flat `PASS: [a, b, c]` — each element becomes `{ name: element }`
2. For block syntax with inline objects — parse NAME + TYPE + DESCRIPTION

Read the surrounding code to understand the exact parsing context, then update accordingly. The output should always be `{ name: string, type?: string, description?: string }[]`.

**Step 4: Write failing compiler resolution test**

Create `packages/compiler/src/__tests__/compiler-pass-resolution.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('PASS field description resolution', () => {
  it('resolves flat name from session memory declarations', () => {
    // Test that a PASS field "customer_id" resolves type/description from
    // MEMORY.session declarations: { name: 'customer_id', type: 'string', description: 'Unique ID' }
    // Expected output: ResolvedPassField { name: 'customer_id', type: 'string', description: 'Unique ID' }
  });

  it('uses inline override when provided', () => {
    // Test that { name: 'balance', type: 'number', description: 'Amount owed' }
    // is kept as-is, not overridden by session memory
  });

  it('falls back to type string with no description for unknown names', () => {
    // Test that a name not in session memory gets { name: 'x', type: 'string' }
  });
});
```

**Step 5: Update compiler to resolve PASS field descriptions**

In `packages/compiler/src/platform/ir/compiler.ts`, in the section where handoff configs are compiled (look for where PASS is assembled), add resolution logic:

```typescript
function resolvePassFields(
  rawPass: Array<{ name: string; type?: string; description?: string }>,
  sessionMemory: SessionMemoryDeclaration[] | undefined,
): ResolvedPassField[] {
  const memoryLookup = new Map((sessionMemory || []).map((m) => [m.name, m]));

  return rawPass.map((field) => {
    // Inline override takes precedence
    if (field.type || field.description) {
      return {
        name: field.name,
        type: field.type || 'string',
        description: field.description,
      };
    }

    // Resolve from session memory
    const memDecl = memoryLookup.get(field.name);
    if (memDecl) {
      return {
        name: field.name,
        type: memDecl.type || 'string',
        description: memDecl.description,
      };
    }

    // Fallback
    return { name: field.name, type: 'string' };
  });
}
```

**Step 6: Run tests**

Run: `pnpm build && cd packages/core && pnpm vitest run src/__tests__/parser-pass-fields.test.ts && cd ../../packages/compiler && pnpm vitest run src/__tests__/compiler-pass-resolution.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser-pass-fields.test.ts packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/compiler-pass-resolution.test.ts
git commit -m "feat(compiler): parse hybrid PASS syntax + resolve descriptions from session memory

Flat PASS names resolve type/description from MEMORY.session declarations.
Inline objects with TYPE/DESCRIPTION override the resolution chain.
Fallback: type 'string', no description."
```

---

### Task 9: Add reason/thought + Context Description + Agent Descriptions in prompt-builder.ts

**Files:**

- Modify: `apps/runtime/src/services/execution/prompt-builder.ts:486-725`
- Test: `apps/runtime/src/__tests__/prompt-builder-system-tools.test.ts`

**Step 1: Write failing tests**

Create `apps/runtime/src/__tests__/prompt-builder-system-tools.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('system tool schemas', () => {
  it('adds reason as required to __handoff__', () => {
    // Build tools with a mock session + IR that has handoff targets
    // Verify reason is in properties and in required array
  });

  it('adds thought when enable_thinking is true', () => {
    // Build tools with IR.execution.enable_thinking = true
    // Verify thought is in properties but NOT in required
  });

  it('does NOT add thought when enable_thinking is false/undefined', () => {
    // Build tools with IR.execution.enable_thinking = false
    // Verify thought is NOT in properties
  });

  it('builds context description with per-agent PASS field listings', () => {
    // Build tools with handoff configs that have ResolvedPassField entries
    // Verify context.description includes "Billing_Agent:\n  - customer_id (string) — Unique ID"
  });

  it('includes agent descriptions in target enum description', () => {
    // Build tools with routing rules that have descriptions
    // Verify target.description includes agent descriptions
  });
});
```

**Step 2: Read prompt-builder.ts in detail**

Read `apps/runtime/src/services/execution/prompt-builder.ts` at lines 486-725 to understand exactly how system tools are built.

**Step 3: Add reason to all system tools**

For each system tool (**handoff**, **delegate**, **fan_out**, **escalate**, **set_context**), add `reason` to the properties and to the `required` array:

```typescript
properties: {
  reason: {
    type: 'string',
    description: SYSTEM_TOOL_DESCRIPTIONS.reason,
  },
  // ... existing properties
},
required: ['reason', ...existingRequired],
```

`__escalate__` already has `reason` — just verify it's already required.

**Step 4: Add thought conditionally**

After adding reason, check `ir.execution?.enable_thinking`:

```typescript
if (ir.execution?.enable_thinking) {
  properties.thought = {
    type: 'string',
    description: SYSTEM_TOOL_DESCRIPTIONS.thought,
  };
  // NOT added to required — always optional
}
```

**Step 5: Build context description from PASS fields**

For `__handoff__`, build the context description dynamically:

```typescript
const contextLines = handoffConfigs
  .map((config) => {
    const fields =
      config.context?.pass
        ?.map((f) => {
          const desc = f.description ? ` — ${f.description}` : '';
          return `  - ${f.name} (${f.type})${desc}`;
        })
        .join('\n') || '  (no specific fields)';
    return `${config.to}:\n${fields}`;
  })
  .join('\n');

const contextSchema = {
  type: 'object',
  description: `Context for the target agent. Populate relevant fields from conversation. Missing fields auto-filled from session.\n\nFields by target:\n${contextLines}`,
};
```

**Step 6: Add agent descriptions to target enum**

```typescript
const targetDescription = handoffTargets.map(t => {
  const rule = ir.routing?.rules?.find(r => r.to === t);
  const desc = rule?.description || '';
  return desc ? `"${t}": ${desc}` : `"${t}"`;
}).join('\n- ');

target: {
  type: 'string',
  enum: handoffTargets,
  description: `The specialist to route to:\n- ${targetDescription}`,
}
```

**Step 7: Run tests**

Run: `cd apps/runtime && pnpm build && pnpm vitest run src/__tests__/prompt-builder`
Expected: PASS

**Step 8: Commit**

```bash
git add apps/runtime/src/services/execution/prompt-builder.ts apps/runtime/src/__tests__/prompt-builder-system-tools.test.ts
git commit -m "feat(runtime): add reason/thought to system tools + structured context description

reason: required on all 6 system tools for traceability.
thought: optional, gated by enable_thinking in ExecutionConfig.
Context description: per-agent PASS field listings with types and descriptions.
Target enum: includes agent descriptions from routing rules."
```

---

### Task 10: Strip reason/thought Before Execution

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts`
- Modify: `apps/runtime/src/services/execution/routing-executor.ts`

**Step 1: Read where tool input is processed**

Read `reasoning-executor.ts` and `routing-executor.ts` to find where system tool inputs are passed to the tool executor / routing handler.

**Step 2: Add stripping logic**

In both files, before the system tool input is processed:

```typescript
const { reason, thought, ...cleanInput } = toolCall.input;
if (reason || thought) {
  onTraceEvent?.({
    type: 'decision',
    data: {
      action: toolCall.name,
      reasoning: reason,
      thought,
    },
  });
}
// Use cleanInput instead of toolCall.input for execution
```

**Step 3: Build and run tests**

Run: `cd apps/runtime && pnpm build && pnpm vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/services/execution/routing-executor.ts
git commit -m "feat(runtime): strip reason/thought from system tool input, emit as trace events

reason and thought are observability-only fields. They're captured in decision
trace events but not passed to the tool executor or routing handler."
```

---

### Task 11: Compiler RECALL Event Validation (4.1)

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:865-869`
- Test: `packages/compiler/src/__tests__/compiler-recall-validation.test.ts`

**Step 1: Write the failing tests**

Create `packages/compiler/src/__tests__/compiler-recall-validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateRecallEvents } from '../platform/ir/recall-validation';

describe('validateRecallEvents', () => {
  const declaredTools = [{ name: 'search_hotels' }, { name: 'book_room' }];
  const knownAgents = ['Billing_Agent', 'Support_Agent'];

  it('accepts valid session lifecycle events', () => {
    const recall = [{ event: 'session:start' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid named agent events', () => {
    const recall = [{ event: 'agent:Billing_Agent:before' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid wildcard agent events', () => {
    const recall = [{ event: 'agent:*:after' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid named tool events', () => {
    const recall = [{ event: 'tool:search_hotels:after' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid wildcard tool events', () => {
    const recall = [{ event: 'tool:*:after' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts legacy aliases', () => {
    const recall = [{ event: 'session_start' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('warns on unknown tool reference', () => {
    const recall = [{ event: 'tool:nonexistent:after' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('unknown tool');
    expect(diagnostics[0].message).toContain('nonexistent');
  });

  it('warns on unknown agent reference', () => {
    const recall = [{ event: 'agent:Unknown_Agent:before' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('unknown agent');
    expect(diagnostics[0].message).toContain('Unknown_Agent');
  });

  it('warns on completely unrecognized event', () => {
    const recall = [{ event: 'booking_completed' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('does not match any known event');
  });
});
```

**Step 2: Run to verify failure**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/compiler-recall-validation.test.ts`
Expected: FAIL — `validateRecallEvents` doesn't exist

**Step 3: Implement validateRecallEvents**

Create `packages/compiler/src/platform/ir/recall-validation.ts` (or add to compiler.ts — check the import structure):

```typescript
import {
  LIFECYCLE_PATTERNS,
  LEGACY_EVENT_ALIASES,
} from '../../../../apps/runtime/src/services/execution/event-detector';
```

Wait — the compiler package shouldn't import from the runtime app. The `LIFECYCLE_PATTERNS` and `LEGACY_EVENT_ALIASES` should be in a shared location. Options:

**Option A**: Duplicate the constants in the compiler (simple, small).
**Option B**: Move them to `packages/compiler/src/platform/constants.ts` and have runtime import from there.

Option B is cleaner. Move `LIFECYCLE_PATTERNS` and `LEGACY_EVENT_ALIASES` to `packages/compiler/src/platform/constants.ts` and re-export from the runtime's `event-detector.ts`.

Then implement `validateRecallEvents()`:

```typescript
import { LIFECYCLE_PATTERNS, LEGACY_EVENT_ALIASES } from '../constants';
import type { ValidationDiagnostic } from './schema';

export function validateRecallEvents(
  recall: Array<{ event: string }>,
  declaredTools: Array<{ name: string }>,
  knownAgents: string[],
): ValidationDiagnostic[] {
  const toolNames = new Set(declaredTools.map((t) => t.name));
  const agentNames = new Set(knownAgents);
  const legacyAliases = new Set(Object.keys(LEGACY_EVENT_ALIASES));

  return recall
    .filter((r) => {
      const event = r.event;
      if (legacyAliases.has(event)) return false;
      if (LIFECYCLE_PATTERNS.some((p) => p.test(event))) {
        const toolMatch = event.match(/^tool:([^:*]+):after$/);
        if (toolMatch && !toolNames.has(toolMatch[1])) return true;
        const agentMatch = event.match(/^agent:([^:*]+):(before|after)$/);
        if (agentMatch && !agentNames.has(agentMatch[1])) return true;
        return false;
      }
      return true;
    })
    .map((r) => {
      const toolMatch = r.event.match(/^tool:([^:*]+):after$/);
      const agentMatch = r.event.match(/^agent:([^:*]+):(before|after)$/);

      let message: string;
      if (toolMatch) {
        message = `RECALL event "${r.event}" references unknown tool "${toolMatch[1]}". Declared tools: ${[...toolNames].join(', ')}`;
      } else if (agentMatch) {
        message = `RECALL event "${r.event}" references unknown agent "${agentMatch[1]}". Known agents: ${[...agentNames].join(', ')}`;
      } else {
        message = `RECALL event "${r.event}" does not match any known event. Valid patterns: session:start, session:end, agent:<name>:before, agent:<name>:after, agent:*:before, agent:*:after, tool:<name>:after, tool:*:after`;
      }

      return {
        severity: 'warning' as const,
        message,
        location: { agent: 'unknown' },
      };
    });
}
```

**Step 4: Integrate into compilation pipeline**

In `packages/compiler/src/platform/ir/compiler.ts`, after RECALL is compiled (around line 869), add:

```typescript
if (ir.memory?.recall?.length) {
  const knownAgents = collectKnownAgents(ir);
  const recallDiagnostics = validateRecallEvents(ir.memory.recall, ir.tools || [], knownAgents);
  diagnostics.push(...recallDiagnostics);
}
```

Add a helper `collectKnownAgents(ir)` that gathers agent names from:

- `ir.routing?.rules?.map(r => r.to)`
- `ir.coordination?.handoffs?.map(h => h.to)`

**Step 5: Run tests**

Run: `pnpm build && cd packages/compiler && pnpm vitest run src/__tests__/compiler-recall-validation.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `pnpm build && pnpm test`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/compiler/src/platform/constants.ts packages/compiler/src/platform/ir/recall-validation.ts packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/compiler-recall-validation.test.ts apps/runtime/src/services/execution/event-detector.ts
git commit -m "feat(compiler): validate RECALL event names against lifecycle patterns

Compiler warns on: unknown tool references in tool:<name>:after,
unknown agent references in agent:<name>:before/after,
and completely unrecognized event patterns.
Legacy aliases (session_start etc.) are accepted silently."
```

---

### Task 12: Full Integration Test + Final Verification

**Files:**

- Test: `apps/runtime/src/__tests__/lifecycle-events-integration.test.ts`

**Step 1: Write an integration test**

Create an end-to-end test that verifies the full lifecycle:

```typescript
describe('lifecycle events integration', () => {
  it('fires session:start on session init', () => {
    // Create a session with RECALL rules for session:start
    // Call initializeAllMemory
    // Verify the RECALL action was executed
  });

  it('fires agent:<name>:before/after during handoff', () => {
    // Set up a supervisor with RECALL rules for agent:Billing_Agent:before/after
    // Trigger a handoff to Billing_Agent
    // Verify before events fire before child execution
    // Verify after events fire after child execution
  });

  it('fires tool:<name>:after after tool call', () => {
    // Set up an agent with RECALL rules for tool:search_hotels:after
    // Execute a tool call
    // Verify the RECALL action fires
  });

  it('fires wildcard events', () => {
    // Set up RECALL for agent:*:before
    // Handoff to any agent
    // Verify wildcard fires
  });

  it('legacy event aliases still work', () => {
    // Set up RECALL for session_start (legacy)
    // Verify it fires at session init
  });
});
```

**Step 2: Run all tests**

Run: `pnpm build && pnpm test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/lifecycle-events-integration.test.ts
git commit -m "test(runtime): add lifecycle events integration test

Verifies session, agent, tool events, wildcards, and legacy aliases
work end-to-end through the memory system."
```

---

## Summary

| Task | Change                                                     | Effort |
| ---- | ---------------------------------------------------------- | ------ |
| 1    | Rewrite event-detector.ts                                  | Small  |
| 2    | Add wildcard matching in memory-executor.ts                | Small  |
| 3    | Update memory-integration.ts to use new resolvers          | Small  |
| 4    | Emit agent lifecycle events in routing-executor.ts         | Medium |
| 5    | Emit tool events + fix fire-and-forget in executors        | Medium |
| 6    | Extend IR schema with ResolvedPassField                    | Small  |
| 7    | Add reason/thought constants                               | Small  |
| 8    | Parse hybrid PASS syntax + resolve in compiler             | Medium |
| 9    | Add reason/thought + context description in prompt-builder | Medium |
| 10   | Strip reason/thought before execution                      | Small  |
| 11   | Compiler RECALL event validation                           | Medium |
| 12   | Integration test + final verification                      | Small  |

**Tasks 1-5**: Change 3.3 (Declarative Lifecycle Events)
**Tasks 6-10**: Change 3.2 (Structured System Tool Schemas)
**Task 11**: Change 4.1 (Compiler RECALL Event Validation)
**Task 12**: Integration verification
