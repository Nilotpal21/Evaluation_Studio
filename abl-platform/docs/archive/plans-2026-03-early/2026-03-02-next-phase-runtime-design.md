# Next Phase Runtime: Mixed Fan-Out + Prompt Consolidation + Tool Context

**Date**: 2026-03-02
**Scope**: Design items 3.5, 3.1 (Phase A), and 4.2 from `DESIGN_IMPLEMENTATION_ABL_ENGINE.md`
**Execution**: 3.5 + 3.1A in parallel, then 4.2

---

## 1. Mixed Agent + Tool Fan-Out Targets (3.5)

### Problem

The `__fan_out__` tool only accepts agent names in its `target` enum. To call a tool, the supervisor must handoff to a child agent that then calls the tool — a full LLM round-trip (3-5s) just for one HTTP call. With 3 tool calls routed through child agents sequentially, the user waits 15s for what could be 1s of parallel HTTP.

### Current Code

`prompt-builder.ts` builds the schema:

```typescript
target: { type: 'string', enum: handoffTargets }  // ONLY agent names
```

`routing-executor.ts` `handleFanOut()` always creates child sessions and runs full agent loops.

### Design

Add a `type` discriminator to fan-out tasks. Tool tasks execute directly; agent tasks use existing child session path.

#### Schema Change

```typescript
// __fan_out__ task schema (prompt-builder.ts)
{
  type: { type: 'string', enum: ['agent', 'tool'] },
  target: { type: 'string', enum: [...agentNames, ...toolNames] },
  intent: { type: 'string', description: 'For agents: sub-request. For tools: ignored.' },
  params: { type: 'object', description: 'For tools: input parameters. For agents: ignored.' },
  context: { type: 'object', description: 'Optional handoff context (agents only).' },
}
```

#### Dispatch Logic

In `handleFanOut()`, after validation and deduplication:

```
for each task in executableTasks:
  if task.type === 'tool':
    → toolExecutor.execute(task.target, task.params, timeoutMs)
    → No child session, no LLM, no semaphore needed
    → Result wrapped as SubTaskResult
  else:  // task.type === 'agent' (or undefined for backward compat)
    → Existing path: createChildSession → wire LLM → executeMessage
```

Tool tasks skip the semaphore because they don't consume LLM capacity. They still participate in `Promise.allSettled` and contribute to `FanOutResult`.

#### Tool Name Collection

The supervisor's own `ir.tools` (excluding system tools) provide tool-type targets. `ir.coordination.handoffs` provide agent-type targets. Both merged into `target` enum.

```typescript
const agentTargets = handoffTargets; // existing
const toolTargets = (ir.tools ?? []).filter((t) => !t.system).map((t) => t.name);
const allTargets = [...agentTargets, ...toolTargets];
```

#### Trace Events

Tool tasks emit: `fan_out_task_start` (type: 'tool'), `tool_call`, `fan_out_task_complete`.
Agent tasks emit existing events unchanged.

#### Backward Compatibility

If `task.type` is omitted, default to `'agent'` (existing behavior). No breaking change to current fan-out callers.

#### Files Changed

| File                                                      | Change                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/prompt-builder.ts`   | Add `type` + `params` to `__fan_out__` schema. Merge tool names into target enum.             |
| `apps/runtime/src/services/execution/routing-executor.ts` | Branch in `handleFanOut()`: tool → direct execute, agent → existing path.                     |
| `apps/runtime/src/services/execution/types.ts`            | Extend `FanOutTask` type with `type?: 'agent' \| 'tool'`, `params?: Record<string, unknown>`. |
| `apps/runtime/src/__tests__/fan-out.test.ts`              | Add: tool-only fan-out, mixed fan-out, backward compat (no type field), tool validation.      |

---

## 2. Prompt Consolidation (3.1 Phase A)

### Problem

99 prompts hardcoded across `constants.ts` and `prompt-builder.ts`. `buildSystemPrompt()` assembles prompts via 30+ `parts.push()` calls across 150 lines of conditional code. Two interpolation engines exist. Dead code (`ENTITY_EXTRACTION_PROMPT`). Non-engineers cannot read or review prompts.

### Current Code

Three buckets in `packages/compiler/src/platform/constants.ts`:

- `SYSTEM_PROMPT_TEMPLATES` (~36 entries): identity, supervisor, specialist, escalation, context, gather, voice
- `SYSTEM_TOOL_DESCRIPTIONS` (~18 entries): handoff, delegate, escalate, fan_out, set_context
- `DEFAULT_MESSAGES` (~35 entries): fallback user-facing messages

Two interpolation engines:

- `interpolateTemplate()` in `apps/runtime/src/services/execution/value-resolution.ts`
- `interpolateMessage()` in `packages/compiler/src/platform/constructs/executors/constraint-executor.ts`

### Design

Phase A consolidates without DB dependency. Three deliverables:

#### A. PromptCatalog Module

Create `apps/runtime/src/services/execution/prompt-catalog.ts`:

```typescript
export const PromptCatalog = {
  // System prompt base templates — one per agent type
  systemPrompt: {
    supervisor: `You are {{name}}, an AI assistant.
{{#if goal}}Your goal: {{goal}}{{/if}}
{{#if persona}}Persona: {{persona}}{{/if}}

## CRITICAL: You are a ROUTING-ONLY supervisor
{{supervisor_mandate}}

## Routing Rules (use {{handoff_tool}} tool):
{{routing_rules}}

{{#if escalation}}## Escalation\n{{escalation_instructions}}{{/if}}
{{#if context}}## Current Context\n{{context_json}}{{/if}}`,

    specialist: `...`,
    standalone: `...`,
  },

  // Tool descriptions — keyed by tool + context
  toolDescriptions: {
    handoff_supervisor: '...',
    handoff_agent: '...',
    delegate: '...',
    escalate: '...',
    fan_out: '...',
    set_context: '...',
  },

  // Default user-facing messages
  messages: {
    error_tool_timeout: '...',
    handoff_message: '...',
    // ... all 35 DEFAULT_MESSAGES entries
  },
} as const;

export type PromptKey = keyof typeof PromptCatalog.systemPrompt;
export type MessageKey = keyof typeof PromptCatalog.messages;
```

#### B. Rewrite `buildSystemPrompt()`

Replace 30+ `parts.push()` calls with template rendering:

```typescript
function buildSystemPrompt(session: RuntimeSession): string {
  const ir = session.agentIR;
  const templateKey = resolveTemplateKey(ir); // 'supervisor' | 'specialist' | 'standalone'
  const template = PromptCatalog.systemPrompt[templateKey];

  const context = buildTemplateContext(session); // { name, goal, persona, routing_rules, ... }
  let prompt = renderTemplate(template, context);

  // Append dynamic sections (memory recall, constraint warnings, etc.)
  prompt += buildDynamicSections(session);
  return prompt;
}
```

#### C. Unify Interpolation

Single `renderTemplate()` function supporting `{{var}}`, `{{#if var}}...{{/if}}`, `{{#each items}}...{{/each}}`:

```typescript
// apps/runtime/src/services/execution/template-engine.ts
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
): string { ... }
```

Delete `interpolateMessage()` from compiler. Update `interpolateTemplate()` callers to use the new engine. Remove dead `ENTITY_EXTRACTION_PROMPT`.

#### Files Changed

| File                                                                         | Change                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/prompt-catalog.ts`                      | **New**. All prompts in one typed module.                                                             |
| `apps/runtime/src/services/execution/template-engine.ts`                     | **New**. Unified template renderer (~80 lines).                                                       |
| `apps/runtime/src/services/execution/prompt-builder.ts`                      | Rewrite `buildSystemPrompt()` to use catalog + template. Rewrite `buildTools()` to read from catalog. |
| `packages/compiler/src/platform/constants.ts`                                | Keep as backward-compat re-export from catalog. Mark deprecated.                                      |
| `packages/compiler/src/platform/constructs/executors/constraint-executor.ts` | Replace `interpolateMessage()` with `renderTemplate()`.                                               |
| `apps/runtime/src/services/execution/value-resolution.ts`                    | Replace `interpolateTemplate()` with `renderTemplate()`.                                              |
| `apps/runtime/src/__tests__/prompt-catalog.test.ts`                          | **New**. Test each template renders correctly with various contexts.                                  |
| `apps/runtime/src/__tests__/template-engine.test.ts`                         | **New**. Test `{{var}}`, `{{#if}}`, `{{#each}}`, edge cases.                                          |

---

## 3. Tool Context Access (4.2)

### Problem

Tools receive only LLM-provided `params`. Common session variables (user_location, currency, loyalty_tier) must be passed explicitly by the LLM every call — wasting tokens and introducing hallucination risk. Tools cannot write state back to the session.

### Current Code

```typescript
// ToolExecutor interface — no context
execute(toolName: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
```

`ToolSessionContext` exists at constructor level for audit/tracing but is never forwarded to tool endpoints.

### Design

No interface change. Enrich params before calling execute; parse writes from result after.

#### ABL Syntax

```yaml
TOOLS:
  - check_inventory:
      TYPE: http
      URL: 'https://api.example.com/inventory'
      CONTEXT_ACCESS:
        READ: [user_location, preferred_currency, loyalty_tier]
        WRITE: [last_inventory_check]
      PARAMS:
        item_id: { TYPE: string }
```

#### IR Schema Extension

```typescript
// packages/compiler/src/platform/ir/schema.ts
export interface ToolDefinition {
  // ... existing fields
  context_read?: string[]; // session vars injected into tool params
  context_write?: string[]; // session vars tool is allowed to update
}
```

#### Runtime Flow

**Before tool execution** (in `reasoning-executor.ts`, before `toolExecutor.execute()`):

```typescript
const toolDef = ir.tools.find((t) => t.name === toolCall.name);
if (toolDef?.context_read?.length) {
  const contextSnapshot: Record<string, unknown> = {};
  for (const key of toolDef.context_read) {
    const value = session.data.values[key];
    if (value !== undefined) contextSnapshot[key] = value;
  }
  params._context = contextSnapshot;
}
```

**After tool result** (in `reasoning-executor.ts`, after getting result):

```typescript
if (toolDef?.context_write?.length && result?.context_updates) {
  for (const [key, value] of Object.entries(result.context_updates)) {
    if (toolDef.context_write.includes(key)) {
      session.data.values[key] = value;
    }
  }
}
```

#### Prompt Builder

For tools with `context_read`, the system prompt mentions which context vars are auto-injected so the LLM doesn't duplicate them in params:

```
Tool "check_inventory" automatically receives: user_location, preferred_currency, loyalty_tier
from session context. You do NOT need to pass these as parameters.
```

#### Trace Events

Emit `tool_context_injected` with `{ toolName, contextKeys, contextValues }` before execution.
Emit `tool_context_updated` with `{ toolName, updates }` after write-back.

#### Files Changed

| File                                                        | Change                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/compiler/src/platform/ir/schema.ts`               | Add `context_read?: string[]`, `context_write?: string[]` to `ToolDefinition`. |
| `packages/core/src/parser/agent-based-parser.ts`            | Parse `CONTEXT_ACCESS` block with `READ` and `WRITE` sub-keys.                 |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Inject context before `execute()`. Parse `context_updates` after.              |
| `apps/runtime/src/services/execution/prompt-builder.ts`     | Add context-access note to tool descriptions.                                  |
| `apps/runtime/src/__tests__/tool-context.test.ts`           | **New**. Test context injection, write-back, whitelist enforcement.            |

---

## Execution Plan

```
Phase 1 (parallel):
  Stream A: 3.5 Mixed Fan-Out (prompt-builder, routing-executor, types, tests)
  Stream B: 3.1A Prompt Consolidation (prompt-catalog, template-engine, prompt-builder rewrite, tests)

Phase 2 (sequential, after Phase 1):
  4.2 Tool Context Access (ir/schema, parser, reasoning-executor, prompt-builder, tests)
```

### Dependency Notes

- 3.5 and 3.1A both touch `prompt-builder.ts` but in different sections: 3.5 modifies the `__fan_out__` tool schema, 3.1A rewrites `buildSystemPrompt()`. No conflict.
- 4.2 follows because it also touches `reasoning-executor.ts` and `prompt-builder.ts` — easier to apply after 3.1A's refactor stabilizes.

### Verification

1. `pnpm build` — all packages compile
2. `pnpm --filter @agent-platform/runtime test -- --run fan-out` — mixed fan-out tests pass
3. `pnpm --filter @agent-platform/runtime test -- --run prompt-catalog` — template tests pass
4. `pnpm --filter @agent-platform/runtime test -- --run template-engine` — engine tests pass
5. `pnpm --filter @agent-platform/runtime test -- --run prompt-builder` — existing tests pass (no regression)
6. `pnpm --filter @agent-platform/runtime test -- --run tool-context` — context injection tests pass
7. `pnpm --filter @agent-platform/runtime test -- --run reasoning-executor` — existing tests pass
8. `pnpm --filter @agent-platform/runtime test -- --run traveldesk` — E2E tests pass

## Implementation Plan

**Goal:** Add mixed agent+tool fan-out targets, externalize all prompts/tool schemas/descriptions into a MongoDB-backed PromptCatalog with a unified template engine, and add tool context access (read/write session variables).

**Architecture:** Three independent streams. Stream A (Tasks 1-4) adds `type` discriminator to fan-out so supervisors can dispatch directly to tools. Stream B (Tasks 5-14) creates a `PromptTemplate` MongoDB model, builds a comprehensive `PromptCatalog`, adds a seed script, creates a `PromptTemplateLoader` service (DB -> cache -> fallback), rewrites `buildSystemPrompt()` and `buildTools()` to use it, and centralizes regex patterns. Stream C (Tasks 15-18) adds `context_read`/`context_write` to tool definitions. Streams A and B can run in parallel. Stream C follows after both merge.

**Tech Stack:** TypeScript, Vitest, Mongoose, ABL parser (`@abl/core`), IR schema (`@abl/compiler`), runtime executor

---

### Stream A: Mixed Agent + Tool Fan-Out (3.5)

#### Task 1: Extend fan-out types and schema

Add `FanOutTask` named type with `type?: 'agent' | 'tool'` and `params?: Record<string, unknown>` to `types.ts`. Update `__fan_out__` tool schema in `prompt-builder.ts` to include `type` discriminator and `params` field. Merge tool names into target enum alongside agent names.

#### Task 2: Implement tool-type dispatch in handleFanOut

Branch in `handleFanOut()`: tool tasks execute via `toolExecutor.execute()` directly (no child session, no LLM, no semaphore), agent tasks use existing child session path. Tool tasks skip semaphore, participate in `Promise.allSettled`, contribute to `FanOutResult`. Default `type` to `'agent'` for backward compatibility.

#### Task 3: Collect tool names for fan-out targets

Extract tool names from `ir.tools` (excluding system tools) as tool-type targets. Merge with `handoffTargets` as agent-type targets. Build combined target enum for `__fan_out__` schema.

#### Task 4: Fan-out tests

Test: tool-only fan-out, mixed agent+tool fan-out, backward compat (no type field defaults to agent), tool validation (invalid tool name rejected), trace events for tool tasks.

### Stream B: Prompt Consolidation (3.1 Phase A)

#### Task 5: Create PromptTemplate Mongoose model

MongoDB model for externalized prompts with `key`, `category`, `version`, `template`, `variables`, `metadata` fields. Seeded with all existing prompts from `constants.ts`.

#### Task 6-8: Build PromptCatalog and seed script

Comprehensive catalog covering full system prompt templates (supervisor, specialist, standalone) with all dynamic sections (context, memory, voice, constraints), complete tool JSON schemas, all descriptions and messages. Seed script populates MongoDB.

#### Task 9-10: PromptTemplateLoader service

DB -> cache -> fallback chain. Loads templates from MongoDB with in-memory LRU cache (TTL-based). Falls back to hardcoded catalog if DB unavailable.

#### Task 11-12: Rewrite buildSystemPrompt and buildTools

Replace 30+ `parts.push()` calls with template rendering via catalog. Unify two interpolation engines into single `renderTemplate()` supporting `{{var}}`, `{{#if}}`, `{{#each}}`.

#### Task 13-14: Centralize regex patterns and cleanup

Extract all regex patterns (correction detection, entity extraction, etc.) into catalog. Remove dead code (`ENTITY_EXTRACTION_PROMPT`). Mark `constants.ts` as deprecated backward-compat re-export.

### Stream C: Tool Context Access (4.2)

#### Task 15: Add context_read/context_write to IR schema

Add `context_read?: string[]` and `context_write?: string[]` to `ToolDefinition` in IR schema. Parse `CONTEXT_ACCESS` block with `READ` and `WRITE` sub-keys in parser.

#### Task 16: Implement context injection before tool execution

In `reasoning-executor.ts`, before `toolExecutor.execute()`, inject `_context` object with session variable values for whitelisted `context_read` keys.

#### Task 17: Implement context write-back after tool result

After tool result, parse `context_updates` from result and write back to session values for whitelisted `context_write` keys only.

#### Task 18: Prompt builder context-access notes and tests

Add context-access note to tool descriptions in system prompt. Test context injection, write-back, whitelist enforcement, trace events (`tool_context_injected`, `tool_context_updated`).
