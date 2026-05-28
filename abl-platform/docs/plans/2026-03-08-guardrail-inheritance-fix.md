# Project-Level Guardrail Inheritance Fix

**Date:** 2026-03-08
**Status:** Approved
**Scope:** Runtime fix to make DB-defined guardrail policies apply to agents without DSL guardrails

## Problem

Project-level guardrail policies created via the Studio UI never fire for agents that don't have `guardrails:` blocks in their DSL. Two gates in the runtime prevent this:

1. **`session-policy.ts:22-23`** — Early-returns `undefined` when `agentIR.constraints.guardrails` is empty, so `resolveGuardrailPolicy()` is never called
2. **`reasoning-executor.ts:917`** — Skips output guardrail evaluation when `session.agentIR?.constraints?.guardrails` is falsy

The `policy-resolver.ts` correctly implements the 4-tier resolution chain (Platform → Tenant → Project → Agent DSL), but it's never invoked for agents without DSL guardrails.

Additionally, the DB policy rule schema (`IGuardrailRule`) only supports **override** semantics (`disable`, `threshold`, `action`, `severity_actions`). It cannot **define** new guardrails — it can only modify parameters of existing ones. When `agentGuardrails` is empty, there's nothing to override.

## Design

### Core Change: Add `define` Rule Type

Extend `IGuardrailRule.override` to include `'define'` — a rule that creates a guardrail definition rather than overriding an existing one.

A `define` rule carries the full guardrail specification:

```typescript
interface IGuardrailRule {
  guardrailName: string;
  override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
  // Existing override fields
  threshold?: number;
  action?: Record<string, unknown>;
  severityActions?: Record<string, unknown>;
  // New define fields (only used when override === 'define')
  kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
  tier?: 'local' | 'model' | 'llm';
  provider?: string;
  category?: string;
  check?: string; // CEL expression (tier: local)
  llmCheck?: string; // Natural language check (tier: llm)
  description?: string;
  priority?: number;
  message?: string; // Default violation message
}
```

### Fix 1: `session-policy.ts` — Remove early return

```typescript
// Before (broken):
const guardrails = session.agentIR.constraints?.guardrails ?? [];
if (guardrails.length === 0) return undefined;

// After (fixed):
const guardrails = session.agentIR.constraints?.guardrails ?? [];
// Always call resolver — DB policies may define guardrails even when DSL has none
```

### Fix 2: `policy-resolver.ts` — Handle `define` rules

In `applyRules()`, when `rule.override === 'define'`, convert the rule into a synthetic `Guardrail` object and add it to the guardrails array:

```typescript
private applyRules(
  rules: PolicyRule[],
  guardrails: Guardrail[],           // NEW param
  disabledGuardrails: string[],
  ruleOverrides: PolicyRule[],
): void {
  for (const rule of rules) {
    if (rule.override === 'disable') {
      // ... existing logic
    } else if (rule.override === 'define') {
      // Don't re-define if agent DSL already has this guardrail
      if (!guardrails.some(g => g.name === rule.guardrailName)) {
        guardrails.push(toSyntheticGuardrail(rule));
      }
    } else {
      // ... existing override logic
    }
  }
}
```

The `toSyntheticGuardrail()` function maps rule fields to `Guardrail`:

```typescript
function toSyntheticGuardrail(rule: PolicyRule): Guardrail {
  return {
    name: rule.guardrailName,
    description: rule.description ?? `Policy-defined: ${rule.guardrailName}`,
    kind: rule.kind ?? 'output',
    priority: rule.priority ?? 50,
    tier: rule.tier ?? (rule.provider ? 'model' : rule.llmCheck ? 'llm' : 'local'),
    provider: rule.provider,
    category: rule.category,
    threshold: rule.threshold,
    check: rule.check,
    llmCheck: rule.llmCheck,
    action: normalizeAction(rule.action, rule.message),
    severityActions: rule.severityActions
      ? normalizeSeverityActions(rule.severityActions)
      : undefined,
  };
}
```

### Fix 3: `reasoning-executor.ts` — Check session policy too

```typescript
// Before (broken):
if (finalResponse && session.agentIR?.constraints?.guardrails) {

// After (fixed):
if (finalResponse) {
  const policy = await getSessionPolicy(session);
  const hasGuardrails = (session.agentIR?.constraints?.guardrails?.length ?? 0) > 0 || policy;
  if (hasGuardrails) {
```

### Fix 4: `IGuardrailRule` Schema — Add define fields

Extend the Mongoose schema with optional define fields:

```typescript
const GuardrailRuleSchema = new Schema<IGuardrailRule>(
  {
    guardrailName: { type: String, required: true },
    override: {
      type: String,
      required: true,
      enum: ['disable', 'threshold', 'action', 'severity_actions', 'define'],
    },
    threshold: { type: Number, default: undefined },
    action: { type: Schema.Types.Mixed, default: undefined },
    severityActions: { type: Schema.Types.Mixed, default: undefined },
    // Define fields
    kind: {
      type: String,
      default: undefined,
      enum: ['input', 'output', 'tool_input', 'tool_output', 'handoff'],
    },
    tier: { type: String, default: undefined, enum: ['local', 'model', 'llm'] },
    provider: { type: String, default: undefined },
    category: { type: String, default: undefined },
    check: { type: String, default: undefined },
    llmCheck: { type: String, default: undefined },
    description: { type: String, default: undefined },
    priority: { type: Number, default: undefined },
    message: { type: String, default: undefined },
  },
  { _id: false },
);
```

## Data Flow

```
Agent without DSL guardrails → chat message
  └→ reasoning-executor: finalResponse ready
      └→ getSessionPolicy(session)
          ├→ agentIR.guardrails = [] (empty)
          ├→ resolveGuardrailPolicy(tenantId, projectId, agentName, [])
          │   └→ loadPoliciesFromDB() → finds project-scoped active policies
          │       └→ policy has rules with override: 'define'
          │           └→ resolver.resolve()
          │               ├→ define rules → synthetic Guardrail objects
          │               ├→ override rules → ruleOverrides
          │               └→ returns { guardrails: [synthetic...], settings, ... }
          └→ toPipelinePolicy(resolved) → PipelinePolicy with guardrails
      └→ checkOutputGuardrails(finalResponse, policy)
          └→ guardrails fire ✓
```

## File Plan

**Modified files:**

- `apps/runtime/src/services/execution/session-policy.ts` — Remove early return
- `apps/runtime/src/services/execution/reasoning-executor.ts` — Fix output guardrail gate condition
- `apps/runtime/src/services/guardrails/policy-resolver.ts` — Handle `define` rules, add `toSyntheticGuardrail()`
- `apps/runtime/src/services/guardrails/pipeline-factory.ts` — Pass guardrails from resolved policy to PipelinePolicy
- `packages/database/src/models/guardrail-policy.model.ts` — Add define fields to schema and interface

**New files:**

- `apps/runtime/src/services/guardrails/__tests__/policy-define-rules.test.ts` — Unit tests for define rule handling
- `apps/runtime/src/services/execution/__tests__/session-policy-inheritance.test.ts` — Integration tests for project-level inheritance

**No changes to:**

- Studio UI (policies already support creating rules with `kind`, `provider`, etc.)
- API routes (policy CRUD already accepts arbitrary rule shapes via Mixed)

## Backward Compatibility

- Existing policies with `override: 'threshold' | 'action' | 'severity_actions' | 'disable'` continue to work unchanged
- Existing agents with DSL guardrails continue to work — `define` rules don't overwrite DSL-defined guardrails of the same name
- The `define` type is purely additive — no migration needed

## Out of Scope

- Input guardrail enforcement on user messages (no existing code path)
- Policy creation UI changes (covered by `2026-03-08-guardrails-ui-design.md`)
- Provider health check / circuit breaker for policy-defined providers
