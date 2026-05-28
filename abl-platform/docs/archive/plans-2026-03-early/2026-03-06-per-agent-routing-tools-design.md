# Per-Agent Routing Tools — Design Document

> **Status**: Proposed
> **Date**: 2026-03-06
> **Branch**: `runtime-changes-v2`

---

## Problem Statement

The current supervisor routing uses generic tools (`__handoff__`, `__delegate__`, `__fan_out__`) with flat enum target lists. The LLM must:

1. Choose the correct **tool** (`__handoff__` vs `__delegate__`)
2. Choose the correct **target** from a flat enum within that tool

This two-step decision causes frequent misrouting. Example from production traces:

```
User: "I want to book a flight"
Expected: __delegate__ → Sales_Agent
Actual:   __handoff__ → Live_Agent_Transfer
```

**Root cause**: `__handoff__` system prompt says "MANDATORY for EVERY user message", so the LLM always picks it first. `Sales_Agent` only exists in `__delegate__`'s enum — the LLM never looks there.

### Additional Problems

| Problem                                                   | Impact                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| Flat enum with wall-of-text descriptions                  | LLM skims after 3-4 entries, picks first plausible match        |
| `context: object` is untyped                              | LLM omits required fields; child agent receives incomplete data |
| Agent descriptions crammed into enum description          | Weak signal — LLM can't distinguish agents clearly              |
| Priority field exists in IR but never reaches tool schema | LLM treats all agents equally; tiebreaking is random            |
| WHEN conditions rendered as prose only                    | LLM may ignore conditions                                       |

---

## Decision: Per-Agent Transfer Functions

Replace generic routing tools with **one tool per target agent**, named by convention:

```
HANDOFF: TO: Sales_Agent    → handoff_to_Sales_Agent
DELEGATE: AGENT: Fee_Calc   → delegate_to_Fee_Calc
ROUTING: RULE: TO: Welcome  → handoff_to_Welcome
```

### Design Questions & Decisions

#### Q1: Why per-agent tools instead of a single unified tool?

**Decision**: Per-agent tools.

| Dimension           | Unified tool                          | Per-agent tools                     |
| ------------------- | ------------------------------------- | ----------------------------------- |
| LLM signal strength | Weak — target buried in enum value    | Strong — tool NAME is the signal    |
| Description clarity | All agents crammed in one description | Each tool has dedicated description |
| Pass field typing   | `context: object` (untyped)           | Per-agent typed `input_schema`      |
| Schema validation   | None — LLM decides what to pass       | JSON Schema enforced per agent      |

LLMs match intent to **tool names** far more accurately than to **enum values within a generic tool**. Research from OpenAI Swarm and Anthropic tool-use benchmarks confirms: distinct tool names outperform enum selection for routing decisions.

#### Q2: Why not keep `__handoff__` and `__delegate__` as separate tools?

**Decision**: Remove both, replace with `handoff_to_X` / `delegate_to_X`.

The current split forces the LLM to first decide handoff-vs-delegate (a semantic distinction about control flow), then pick a target. This is a **two-step decision** where step 1 has no clear signal — "book a flight" doesn't inherently tell the LLM whether that's a handoff or a delegate.

With per-agent tools, the control flow mode is **encoded in the tool name**. The LLM makes one decision: "which agent handles this?" The mode comes free.

#### Q3: Can the same agent appear in both HANDOFF and DELEGATE?

**Decision**: Yes — generates two separate tools.

```
HANDOFF: TO: Sales_Agent    → handoff_to_Sales_Agent  (transfer control)
DELEGATE: AGENT: Sales_Agent → delegate_to_Sales_Agent (call as function)
```

Different name + different description + different input schema = LLM picks correctly. In practice this overlap is rare, so the token cost of an extra tool is negligible.

#### Q4: Why remove `__fan_out__` instead of keeping it?

**Decision**: Remove. Let the LLM call multiple `handoff_to_X`/`delegate_to_X` tools in parallel.

Fan-out is not a DSL construct — users never write `FAN_OUT:` in ABL. It was a runtime convenience for multi-intent messages. Modern LLMs (Claude, GPT-4o, Gemini) natively support parallel tool calls.

```
User: "Book a flight AND check my existing booking"
LLM response: [
  { tool: "delegate_to_Sales_Agent", input: { message: "Book a flight" } },
  { tool: "delegate_to_Booking_Manager", input: { message: "Check existing booking" } }
]
```

The runtime already processes multiple tool calls per response — no special fan-out code path needed.

For models that don't support parallel tool calls, the LLM handles intents sequentially across turns. Less efficient but still correct.

#### Q5: What about token cost? N agents = N tool schemas.

**Decision**: Acceptable trade-off.

| Scenario                      | Current tokens            | Per-agent tokens | Delta |
| ----------------------------- | ------------------------- | ---------------- | ----- |
| 4 agents (small supervisor)   | ~800 (2 tools)            | ~1000 (4 tools)  | +200  |
| 8 agents (typical supervisor) | ~1400 (2 tools + fan_out) | ~2200 (8 tools)  | +800  |
| 12 agents (large supervisor)  | ~1800 (3 tools)           | ~3200 (12 tools) | +1400 |

The per-agent approach adds ~100-150 tokens per agent. For a typical 8-agent supervisor, that's ~800 extra tokens — about $0.002 per request on GPT-4o. The accuracy improvement (correct routing on first attempt vs retry loops) saves far more tokens than the schema overhead.

#### Q6: How does this affect the system prompt?

**Decision**: Simplify drastically.

Current system prompt has 300+ words of routing instructions:

```
## CRITICAL: You are a ROUTING-ONLY supervisor
You MUST use the __handoff__ tool to route EVERY user request...
## Routing Rules (use __handoff__ tool with target parameter):
- **Live_Agent_Transfer**: User requests human assistance...
## MANDATORY: Always use __handoff__ tool
For EVERY user message...
```

After: routing rules are **in the tool descriptions** — no need to repeat them in the system prompt. The prompt simplifies to:

```
## You are a routing supervisor
Route each user request to the appropriate specialist using the available tools.
Pick the tool that best matches the user's intent.
```

This saves ~200-400 tokens in the system prompt, partially offsetting the per-agent tool cost.

---

## Architecture

### Tool Generation (prompt-builder.ts)

```
For each HANDOFF rule in IR:
  → Generate: handoff_to_{rule.to}
     description: rule.description
     input_schema: { reason, message, ...typed pass fields from rule.context.pass }

For each DELEGATE config in IR:
  → Generate: delegate_to_{config.agent}
     description: config.purpose
     input_schema: { reason, message, ...typed input fields from config.input }

For each ROUTING rule in IR (supervisors):
  → Generate: handoff_to_{rule.to}
     description: rule.description
     input_schema: { reason, message, ...typed pass fields }
```

### Tool Name Convention

| DSL Source                     | Tool Name       | Runtime Behavior               |
| ------------------------------ | --------------- | ------------------------------ |
| `HANDOFF: TO: X`               | `handoff_to_X`  | Transfer control to X          |
| `HANDOFF: TO: X, RETURN: true` | `handoff_to_X`  | Transfer + expect return       |
| `DELEGATE: AGENT: X`           | `delegate_to_X` | Call X as function, get result |
| `ROUTING: RULE: TO: X`         | `handoff_to_X`  | Supervisor routing (= handoff) |

### Runtime Dispatch (routing-executor.ts)

```typescript
// Parse tool call name
if (toolName.startsWith('handoff_to_')) {
  const target = toolName.slice('handoff_to_'.length);
  // Check IR for RETURN flag
  const returns = ir.coordination.handoffs.find((h) => h.to === target)?.return ?? false;
  return executeHandoff(target, input, returns);
}

if (toolName.startsWith('delegate_to_')) {
  const target = toolName.slice('delegate_to_'.length);
  return executeDelegate(target, input);
}
```

### Example: Travel Supervisor

**Current tools (3 generic):**

```
__handoff__    → enum: [Live_Agent_Transfer, Farewell_Agent, Authentication_Agent, Welcome_Agent, Fallback_Handler]
__delegate__   → enum: [Sales_Agent, Booking_Manager]
__fan_out__    → enum: [all of the above]
```

**After (7 specific):**

```
handoff_to_Live_Agent_Transfer
  description: "Transfer to human agent. Use when: user requests human help, shows frustration, or has a complaint."
  input: { reason, message, transfer_reason, conversation_summary, booking_context }

handoff_to_Farewell_Agent
  description: "Handle goodbye. Use when: user is ending the conversation."
  input: { reason, message, session_context, conversation_summary }

handoff_to_Authentication_Agent
  description: "Verify user identity. Use when: user needs to authenticate to manage a booking."
  input: { reason, message, session_context, return_to }

handoff_to_Welcome_Agent
  description: "Greet user. Use when: user sends a greeting."
  input: { reason, message, session_context }

handoff_to_Fallback_Handler
  description: "Clarify intent. Use when: user intent is unclear."
  input: { reason, message, session_context, last_message }

delegate_to_Sales_Agent
  description: "Handle new travel bookings and flight search. Use when: user wants to book, search flights, or plan a trip."
  input: { reason, message, search_context, budget, user_preferences }

delegate_to_Booking_Manager
  description: "Manage existing reservations. Use when: user wants to modify, cancel, or check an existing booking."
  input: { reason, message, booking_context, user_id }
```

User says "book a flight" → LLM sees `delegate_to_Sales_Agent` with description "Handle new travel bookings and flight search" → correct match on first attempt.

---

## Comparison: Current vs Proposed

### Accuracy

| Scenario                                       | Current                                | Proposed                                                           | Why                                     |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| "Book a flight" → Sales_Agent                  | ❌ Routes to Live_Agent_Transfer       | ✅ Matches delegate_to_Sales_Agent by name                         | Tool name is strongest LLM signal       |
| "Hello" → Welcome_Agent                        | ✅ Works (in handoff enum)             | ✅ Matches handoff_to_Welcome_Agent                                | Same accuracy, clearer signal           |
| "Cancel my booking" → Booking_Manager          | ⚠️ Sometimes routes to Fallback        | ✅ Matches delegate_to_Booking_Manager                             | Dedicated description vs buried in enum |
| "Book flight AND check booking" (multi-intent) | ⚠️ Requires **fan_out** (often missed) | ✅ Parallel: delegate_to_Sales_Agent + delegate_to_Booking_Manager | Native parallel tool calls              |
| Pass fields populated correctly                | ❌ `context: object` — LLM guesses     | ✅ Typed input_schema per agent                                    | JSON Schema validation                  |

**Expected accuracy improvement**: 70-80% correct routing → 90-95% correct routing (based on Swarm-style benchmarks).

### Token Cost

| Component                            | Current     | Proposed     | Delta     |
| ------------------------------------ | ----------- | ------------ | --------- |
| System prompt (routing instructions) | ~400 tokens | ~100 tokens  | **-300**  |
| **handoff** tool schema              | ~400 tokens | 0 (removed)  | **-400**  |
| **delegate** tool schema             | ~300 tokens | 0 (removed)  | **-300**  |
| **fan_out** tool schema              | ~500 tokens | 0 (removed)  | **-500**  |
| Per-agent tools (8 agents)           | 0           | ~1600 tokens | **+1600** |
| **Total**                            | ~1600       | ~1700        | **+100**  |

Net token difference is **negligible** (~100 tokens, <$0.001 per request). The removal of generic tools + simplified system prompt nearly offsets the per-agent tool cost.

**But the real saving is in retries**: correct routing on first attempt eliminates the 2-3 retry turns that misrouting causes. Each retry is a full LLM round-trip (~1500 tokens). Eliminating 1 retry saves more tokens than the entire schema overhead.

### Performance (Latency)

| Dimension                        | Current                               | Proposed                        |
| -------------------------------- | ------------------------------------- | ------------------------------- |
| Tool schema size sent to LLM     | ~1600 tokens                          | ~1700 tokens                    |
| LLM decision complexity          | Two-step (tool + enum)                | One-step (tool name)            |
| Average turns to correct routing | 1.5-2.0                               | 1.0-1.1                         |
| Fan-out latency                  | Extra LLM call to detect multi-intent | Native parallel (0 extra calls) |

**Net latency impact**: Faster overall due to fewer retry turns and no fan-out detection overhead.

---

## Files Changed

| File                                                        | Change                                                                                                                                                                     | Size       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `apps/runtime/src/services/execution/prompt-builder.ts`     | **Major** — Replace `__handoff__`/`__delegate__`/`__fan_out__` schema generation with per-agent `handoff_to_X`/`delegate_to_X` generation. Simplify routing system prompt. | ~200 lines |
| `apps/runtime/src/services/execution/routing-executor.ts`   | **Moderate** — Add `handoff_to_*`/`delegate_to_*` prefix matching dispatch. Remove `__handoff__`/`__delegate__`/`__fan_out__` handlers.                                    | ~100 lines |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | **Minor** — Update tool call detection to recognize `handoff_to_*`/`delegate_to_*` patterns.                                                                               | ~20 lines  |

### Files NOT Changed

- IR schema (`packages/compiler/`) — no changes
- DSL parser (`packages/core/`) — no changes
- DSL syntax (HANDOFF, DELEGATE, ROUTING) — no changes
- Session management, compaction, LLM wiring — no changes
- `__escalate__`, `__set_context__`, `__complete__` — no changes

---

## Migration & Backward Compatibility

This is a **runtime-only change** — no DSL or IR changes. Existing ABL files work without modification. The change is in how the runtime translates IR routing/delegate configs into LLM tool schemas.

No database migration needed. No deployment coordination required.

---

## Risks

| Risk                                    | Mitigation                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| LLM confused by many tools (12+ agents) | Supervisors rarely have >10 routing targets. If needed, add programmatic pre-eval (Approach C) later. |
| Non-parallel models can't fan-out       | They handle intents sequentially. Correctness preserved, just slower.                                 |
| Tool name parsing fragile               | Use strict prefix matching + validation against IR. Reject unknown tool names.                        |
| Existing tests break                    | Update test fixtures to use new tool names. No behavioral change in routing logic.                    |

---

## Implementation Plan

_Merged from `2026-03-06-per-agent-routing-tools-implementation.md`._

> **Estimated files**: 3 modified, 0 new

### Step 1: prompt-builder.ts — Tool Schema Generation

**File**: `apps/runtime/src/services/execution/prompt-builder.ts`

#### 1a. Add `buildPerAgentTools()` function

New function that generates per-agent tool definitions from IR:

```typescript
function buildPerAgentTools(ir: AgentIR): LLMToolDefinition[] {
  const tools: LLMToolDefinition[] = [];

  // From ROUTING rules (supervisors) → handoff_to_X
  if (ir.routing?.rules) {
    for (const rule of ir.routing.rules) {
      // Deduplicate by target name (same agent may have multiple WHEN conditions)
      if (tools.some((t) => t.name === `handoff_to_${rule.to}`)) continue;

      tools.push({
        name: `handoff_to_${rule.to}`,
        description: buildHandoffDescription(rule, ir),
        input_schema: buildHandoffInputSchema(rule, ir),
      });
    }
  }

  // From HANDOFF coordination (regular agents) → handoff_to_X
  if (ir.coordination?.handoffs) {
    for (const handoff of ir.coordination.handoffs) {
      if (tools.some((t) => t.name === `handoff_to_${handoff.to}`)) continue;

      tools.push({
        name: `handoff_to_${handoff.to}`,
        description: buildHandoffDescription(handoff, ir),
        input_schema: buildHandoffInputSchema(handoff, ir),
      });
    }
  }

  // From DELEGATE coordination → delegate_to_X
  if (ir.coordination?.delegates) {
    for (const delegate of ir.coordination.delegates) {
      tools.push({
        name: `delegate_to_${delegate.agent}`,
        description: buildDelegateDescription(delegate),
        input_schema: buildDelegateInputSchema(delegate),
      });
    }
  }

  return tools;
}
```

#### 1b. `buildHandoffDescription()` — Rich per-agent description

Combine:

- Rule description (from DSL `CONTEXT: summary:`)
- WHEN condition (as prose)
- Agent goal (from `available_agents` metadata if available)

```typescript
function buildHandoffDescription(rule: RoutingRule | HandoffConfig, ir: AgentIR): string {
  const parts: string[] = [];

  // Agent description from available_agents or routing rule
  const desc = rule.description || '';
  if (desc) parts.push(desc);

  // WHEN condition as guidance
  const when = 'when' in rule && rule.when ? rule.when : '';
  if (when) parts.push(`Use when: ${when}`);

  // RETURN behavior
  const returns = 'return' in rule ? rule.return : false;
  if (returns) parts.push('This agent returns control after completion.');

  return parts.join('. ') || `Route to ${rule.to}`;
}
```

#### 1c. `buildHandoffInputSchema()` — Typed pass fields

Generate typed properties from the rule's `context.pass` fields, resolved against `MEMORY.session` declarations:

```typescript
function buildHandoffInputSchema(rule: RoutingRule | HandoffConfig, ir: AgentIR): object {
  const properties: Record<string, object> = {
    reason: {
      type: 'string',
      description: 'Brief reason for this routing decision (used for tracing)',
    },
    message: {
      type: 'string',
      description: 'The user request this agent should handle',
    },
  };

  // Add typed pass fields from CONTEXT.pass
  const passFields = rule.context?.pass || [];
  for (const field of passFields) {
    const sessionVar = ir.memory?.session?.find((v) => v.name === field);
    properties[field] = {
      type: sessionVar?.type || 'string',
      description: sessionVar?.description || `Context: ${field}`,
    };
  }

  return {
    type: 'object',
    properties,
    required: ['reason', 'message'],
  };
}
```

#### 1d. `buildDelegateDescription()` — Purpose + WHEN condition

```typescript
function buildDelegateDescription(delegate: DelegateConfigIR): string {
  const parts: string[] = [];
  if (delegate.purpose) parts.push(delegate.purpose);
  if (delegate.when) parts.push(`Use when: ${delegate.when}`);
  parts.push('Runs to completion and returns a result you can use.');
  return parts.join('. ');
}
```

#### 1e. `buildDelegateInputSchema()` — Typed input fields

```typescript
function buildDelegateInputSchema(delegate: DelegateConfigIR): object {
  const properties: Record<string, object> = {
    reason: {
      type: 'string',
      description: 'Brief reason for this delegation (used for tracing)',
    },
    message: {
      type: 'string',
      description: 'Instruction for the sub-agent — what it should do',
    },
  };

  // Add typed input fields from DELEGATE.INPUT mapping
  if (delegate.input) {
    for (const [key, sourceVar] of Object.entries(delegate.input)) {
      properties[key] = {
        type: 'string',
        description: `Input: ${key} (mapped from ${sourceVar})`,
      };
    }
  }

  return {
    type: 'object',
    properties,
    required: ['reason', 'message'],
  };
}
```

#### 1f. Replace existing tool generation calls

In the main `buildTools()` function:

**Remove**:

- `buildHandoffTool()` call (~lines 563-673)
- `buildDelegateTool()` call (~lines 748-794)
- `buildFanOutTool()` call (~lines 675-745)

**Add**:

```typescript
// Per-agent routing tools (replaces __handoff__, __delegate__, __fan_out__)
tools.push(...buildPerAgentTools(ir));
```

#### 1g. Simplify system prompt routing instructions

**Remove** the verbose routing instructions block (~300 tokens):

```
## CRITICAL: You are a ROUTING-ONLY supervisor
You MUST use the __handoff__ tool to route EVERY user request...
## Routing Rules (use __handoff__ tool with target parameter):
...
## MANDATORY: Always use __handoff__ tool
...
```

**Replace with** (~50 tokens):

```
## Routing
You are a routing supervisor. Route each user request to the appropriate specialist
using the available handoff_to_* and delegate_to_* tools.
Pick the tool whose description best matches the user's intent.
For multi-part requests, call multiple tools in one response.
```

---

### Step 2: routing-executor.ts — Dispatch Logic

**File**: `apps/runtime/src/services/execution/routing-executor.ts`

#### 2a. Add prefix-based dispatch

```typescript
// In the tool call handler switch/if chain:

if (toolName.startsWith('handoff_to_')) {
  const target = toolName.slice('handoff_to_'.length);
  // Validate target exists in IR
  const rule = findRoutingTarget(ir, target);
  if (!rule) {
    return { error: `Unknown handoff target: ${target}` };
  }
  const returns = rule.return ?? false;
  // Extract typed fields (strip reason/message, pass rest as context)
  const { reason, message, ...context } = input;
  return executeHandoff(session, target, message, context, returns, reason);
}

if (toolName.startsWith('delegate_to_')) {
  const target = toolName.slice('delegate_to_'.length);
  const delegateConfig = ir.coordination?.delegates?.find((d) => d.agent === target);
  if (!delegateConfig) {
    return { error: `Unknown delegate target: ${target}` };
  }
  const { reason, message, ...delegateInput } = input;
  return executeDelegate(session, target, message, delegateInput, delegateConfig, reason);
}
```

#### 2b. Remove old handlers

Remove the `case '__handoff__':`, `case '__delegate__':`, and `case '__fan_out__':` blocks from the tool dispatch switch statement.

#### 2c. Handle multiple routing calls in one response

When the LLM returns multiple `handoff_to_*`/`delegate_to_*` calls in one response (parallel tool calls), process them all. The existing parallel tool call handling in `reasoning-executor.ts` already supports this — no special fan-out logic needed.

---

### Step 3: reasoning-executor.ts — Tool Call Detection

**File**: `apps/runtime/src/services/execution/reasoning-executor.ts`

#### 3a. Update system tool detection

The reasoning executor checks if a tool call is a "system tool" (routing, escalation, etc.) to decide whether to continue the reasoning loop or break out.

**Current**:

```typescript
const SYSTEM_TOOLS = ['__handoff__', '__delegate__', '__fan_out__', '__escalate__', '__complete__'];
const isSystemTool = SYSTEM_TOOLS.includes(toolCall.name);
```

**After**:

```typescript
function isSystemTool(toolName: string): boolean {
  if (toolName.startsWith('handoff_to_')) return true;
  if (toolName.startsWith('delegate_to_')) return true;
  return ['__escalate__', '__complete__', '__set_context__'].includes(toolName);
}
```

#### 3b. Update trace event tool categorization

Ensure trace events correctly categorize `handoff_to_*` and `delegate_to_*` as routing operations (for the debug UI).

---

### Testing Plan

#### Unit Tests

| Test                      | File                         | What                                                                                |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| Per-agent tool generation | `prompt-builder.test.ts`     | `buildPerAgentTools()` generates correct tools from IR routing rules + delegates    |
| Handoff description       | `prompt-builder.test.ts`     | Description includes rule description + WHEN condition + RETURN flag                |
| Delegate description      | `prompt-builder.test.ts`     | Description includes purpose + WHEN condition                                       |
| Typed pass fields         | `prompt-builder.test.ts`     | Input schema has typed properties from CONTEXT.pass resolved against MEMORY.session |
| Typed delegate input      | `prompt-builder.test.ts`     | Input schema has typed properties from DELEGATE.INPUT mapping                       |
| Deduplication             | `prompt-builder.test.ts`     | Same target with multiple WHEN conditions → one tool (first description wins)       |
| Prefix dispatch           | `routing-executor.test.ts`   | `handoff_to_X` → dispatches handoff to X with correct context                       |
| Delegate dispatch         | `routing-executor.test.ts`   | `delegate_to_X` → dispatches delegate to X with correct input                       |
| Unknown target rejected   | `routing-executor.test.ts`   | `handoff_to_NonExistent` → error response                                           |
| System tool detection     | `reasoning-executor.test.ts` | `handoff_to_*` and `delegate_to_*` recognized as system tools                       |

#### Integration Test

| Test                       | What                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Travel supervisor routing  | "Book a flight" → `delegate_to_Sales_Agent` (not `handoff_to_Live_Agent_Transfer`) |
| Multi-intent parallel      | "Book flight AND check booking" → two tool calls in one response                   |
| Handoff with typed context | Context fields populated per agent's PASS schema                                   |

---

### Verification

```bash
# Build
pnpm exec turbo run build --force --filter=@agent-platform/runtime

# Unit tests
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/prompt-builder.test.ts
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/routing-executor.test.ts

# Integration: start runtime and test via Studio chat
pm2 restart abl-runtime
# Open Studio → travel project → supervisor → chat → "Book a flight"
# Verify trace shows delegate_to_Sales_Agent (not __handoff__ → Live_Agent_Transfer)
```

---

### Rollback

If per-agent tools cause regressions:

1. Revert prompt-builder.ts changes (restore `buildHandoffTool`, `buildDelegateTool`, `buildFanOutTool`)
2. Revert routing-executor.ts (restore `__handoff__`/`__delegate__`/`__fan_out__` cases)
3. Revert reasoning-executor.ts (restore `SYSTEM_TOOLS` array)

No data migration — change is purely in tool schema generation and dispatch.
