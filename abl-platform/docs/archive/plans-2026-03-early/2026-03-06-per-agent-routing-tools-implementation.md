# Per-Agent Routing Tools — Implementation Plan

> **Design doc**: [`2026-03-06-per-agent-routing-tools-design.md`](./2026-03-06-per-agent-routing-tools-design.md)
> **Status**: Planned
> **Date**: 2026-03-06
> **Estimated files**: 3 modified, 0 new

---

## Summary

Replace generic `__handoff__`, `__delegate__`, `__fan_out__` tools with per-agent `handoff_to_X` / `delegate_to_X` tools. Runtime-only change — no DSL, IR, or database modifications.

---

## Implementation Steps

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

## Testing Plan

### Unit Tests

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

### Integration Test

| Test                       | What                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Travel supervisor routing  | "Book a flight" → `delegate_to_Sales_Agent` (not `handoff_to_Live_Agent_Transfer`) |
| Multi-intent parallel      | "Book flight AND check booking" → two tool calls in one response                   |
| Handoff with typed context | Context fields populated per agent's PASS schema                                   |

---

## Verification

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

## Rollback

If per-agent tools cause regressions:

1. Revert prompt-builder.ts changes (restore `buildHandoffTool`, `buildDelegateTool`, `buildFanOutTool`)
2. Revert routing-executor.ts (restore `__handoff__`/`__delegate__`/`__fan_out__` cases)
3. Revert reasoning-executor.ts (restore `SYSTEM_TOOLS` array)

No data migration — change is purely in tool schema generation and dispatch.
