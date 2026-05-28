# Project-Level Guardrail Inheritance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make DB-defined guardrail policies fire for agents without DSL guardrails, completing the 4-tier resolution chain.

**Architecture:** Add `define` rule type to policy rules so DB policies can create guardrails (not just override existing ones). Add `additionalGuardrails` to `PipelinePolicy` so policy-defined guardrails flow through to the pipeline without mutating the shared IR. Remove two early-return gates that block policy resolution when DSL guardrails are empty.

**Tech Stack:** TypeScript, Vitest, Mongoose, @abl/compiler (Guardrail/PipelinePolicy types)

**Design doc:** `docs/plans/2026-03-08-guardrail-inheritance-fix.md`

---

### Task 1: Extend PolicyRule and IGuardrailRule with `define` fields

**Files:**

- Modify: `apps/runtime/src/services/guardrails/policy-resolver.ts:10-16`
- Modify: `packages/database/src/models/guardrail-policy.model.ts:31-37,122-135`
- Test: `apps/runtime/src/__tests__/guardrails/policy-define-rules.test.ts` (create)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/guardrails/policy-define-rules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GuardrailPolicyResolver } from '../../services/guardrails/policy-resolver';
import type { PolicyData } from '../../services/guardrails/policy-resolver';
import type { Guardrail } from '@abl/compiler';

const defaultSettings: PolicyData['settings'] = {
  failMode: 'open',
  timeouts: { local: 10, model: 500, llm: 2000 },
};

describe('GuardrailPolicyResolver — define rules', () => {
  const resolver = new GuardrailPolicyResolver();

  it('should create synthetic guardrails from define rules when agent has no DSL guardrails', () => {
    const result = resolver.resolve({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'content-safety-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'openai_moderation',
              category: 'hate',
              threshold: 0.5,
              action: { type: 'block', message: 'Content blocked.' },
              description: 'Block hateful output',
            },
          ],
          settings: defaultSettings,
        },
      ],
    });

    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].name).toBe('content_safety');
    expect(result.guardrails[0].kind).toBe('output');
    expect(result.guardrails[0].tier).toBe('model');
    expect(result.guardrails[0].provider).toBe('openai_moderation');
    expect(result.guardrails[0].category).toBe('hate');
    expect(result.guardrails[0].threshold).toBe(0.5);
    expect(result.guardrails[0].action).toEqual({ type: 'block', message: 'Content blocked.' });
  });

  it('should NOT overwrite DSL-defined guardrails with define rules of the same name', () => {
    const dslGuardrail: Guardrail = {
      name: 'content_safety',
      description: 'DSL-defined guard',
      kind: 'input',
      priority: 1,
      tier: 'local',
      check: 'true',
      action: { type: 'warn' },
    };

    const result = resolver.resolve({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [dslGuardrail],
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'openai_moderation',
              threshold: 0.5,
              action: { type: 'block' },
            },
          ],
          settings: defaultSettings,
        },
      ],
    });

    // DSL guardrail should be preserved, policy define should be ignored
    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].kind).toBe('input'); // DSL value, not policy's 'output'
    expect(result.guardrails[0].tier).toBe('local'); // DSL value, not policy's 'model'
  });

  it('should handle multiple define rules from different scopes', () => {
    const result = resolver.resolve({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: 'tenant-policy',
          rules: [
            {
              guardrailName: 'pii_redaction',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'builtin_pii',
              threshold: 0.3,
              action: { type: 'redact', message: 'PII redacted.' },
            },
          ],
          settings: defaultSettings,
        },
      ],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'openai_moderation',
              threshold: 0.5,
              action: { type: 'block', message: 'Blocked.' },
            },
          ],
          settings: defaultSettings,
        },
      ],
    });

    expect(result.guardrails).toHaveLength(2);
    const names = result.guardrails.map((g) => g.name);
    expect(names).toContain('pii_redaction');
    expect(names).toContain('content_safety');
  });

  it('should allow project define to override tenant define for same guardrail name', () => {
    const result = resolver.resolve({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: 'tenant-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'openai_moderation',
              threshold: 0.3,
              action: { type: 'warn', message: 'Tenant warning.' },
            },
          ],
          settings: defaultSettings,
        },
      ],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'openai_moderation',
              threshold: 0.7,
              action: { type: 'block', message: 'Project blocked.' },
            },
          ],
          settings: defaultSettings,
        },
      ],
    });

    // Project should win (higher priority scope)
    expect(result.guardrails).toHaveLength(1);
    expect(result.guardrails[0].threshold).toBe(0.7);
    expect(result.guardrails[0].action).toEqual({ type: 'block', message: 'Project blocked.' });
  });

  it('should handle mix of define and override rules in same policy', () => {
    const dslGuardrail: Guardrail = {
      name: 'existing_guard',
      description: 'Existing DSL guardrail',
      kind: 'output',
      priority: 1,
      tier: 'local',
      check: 'true',
      action: { type: 'block' },
    };

    const result = resolver.resolve({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentDefId: 'agent-1',
      agentGuardrails: [dslGuardrail],
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'mixed-policy',
          rules: [
            {
              guardrailName: 'new_guard',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'openai_moderation',
              threshold: 0.5,
              action: { type: 'block', message: 'New guard blocked.' },
            },
            {
              guardrailName: 'existing_guard',
              override: 'threshold' as const,
              threshold: 0.9,
            },
          ],
          settings: defaultSettings,
        },
      ],
    });

    expect(result.guardrails).toHaveLength(2);
    expect(result.guardrails.map((g) => g.name)).toContain('new_guard');
    expect(result.guardrails.map((g) => g.name)).toContain('existing_guard');
    expect(result.ruleOverrides).toHaveLength(1);
    expect(result.ruleOverrides[0].guardrailName).toBe('existing_guard');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/policy-define-rules.test.ts`
Expected: FAIL — `override: 'define'` not in PolicyRule type, resolver doesn't handle define

**Step 3: Extend PolicyRule type in policy-resolver.ts**

In `apps/runtime/src/services/guardrails/policy-resolver.ts`, change the `PolicyRule` interface:

```typescript
export interface PolicyRule {
  guardrailName: string;
  override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
  threshold?: number;
  action?: Record<string, unknown>;
  severityActions?: Record<string, unknown>;
  // Define-mode fields (used when override === 'define')
  kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
  tier?: 'local' | 'model' | 'llm';
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  description?: string;
  priority?: number;
  message?: string;
}
```

**Step 4: Extend IGuardrailRule in guardrail-policy.model.ts**

In `packages/database/src/models/guardrail-policy.model.ts`:

Update the `IGuardrailRule` interface (line 31-37):

```typescript
export interface IGuardrailRule {
  guardrailName: string;
  override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
  threshold?: number;
  action?: Record<string, unknown>;
  severityActions?: Record<string, unknown>;
  // Define-mode fields
  kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
  tier?: 'local' | 'model' | 'llm';
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  description?: string;
  priority?: number;
  message?: string;
}
```

Update the `GuardrailRuleSchema` (line 122-135):

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
    // Define-mode fields
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

**Step 5: Implement define rule handling in GuardrailPolicyResolver**

In `apps/runtime/src/services/guardrails/policy-resolver.ts`, add a helper function before the class:

```typescript
import type { Guardrail, GuardrailAction } from '@abl/compiler';

// ... (existing code) ...

/**
 * Convert a `define` policy rule into a synthetic Guardrail IR object.
 * Used when DB policies create guardrails without DSL definitions.
 */
function toSyntheticGuardrail(rule: PolicyRule): Guardrail {
  const action: GuardrailAction =
    rule.action && typeof rule.action === 'object' && 'type' in rule.action
      ? (rule.action as GuardrailAction)
      : { type: 'block', message: rule.message };

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
    action,
    severityActions: rule.severityActions as Guardrail['severityActions'],
  };
}
```

Update the `resolve()` method to pass `guardrails` array into `applyRules`:

```typescript
resolve(input: PolicyInput): ResolvedGuardrailPolicy {
  const guardrails = [...input.agentGuardrails];
  const disabledGuardrails: string[] = [];
  const ruleOverrides: PolicyRule[] = [];
  const providerOverrides: ProviderOverride[] = [];

  let settings: PolicySettings = { ...DEFAULT_SETTINGS };

  // Layer 1: Apply tenant policies (base layer)
  for (const policy of input.tenantPolicies) {
    settings = this.mergeSettings(settings, policy.settings);
    this.applyRules(policy.rules, guardrails, disabledGuardrails, ruleOverrides);
    if (policy.providerOverrides) {
      providerOverrides.push(...policy.providerOverrides);
    }
  }

  // Layer 2: Apply project policies (overrides tenant)
  for (const policy of input.projectPolicies) {
    settings = this.mergeSettings(settings, policy.settings);
    this.applyRules(policy.rules, guardrails, disabledGuardrails, ruleOverrides);
    if (policy.providerOverrides) {
      providerOverrides.push(...policy.providerOverrides);
    }
  }

  // ... (logging stays the same) ...

  return { guardrails, disabledGuardrails, ruleOverrides, settings, providerOverrides };
}
```

Update the `applyRules()` method:

```typescript
private applyRules(
  rules: PolicyRule[],
  guardrails: Guardrail[],
  disabledGuardrails: string[],
  ruleOverrides: PolicyRule[],
): void {
  for (const rule of rules) {
    if (rule.override === 'disable') {
      if (!disabledGuardrails.includes(rule.guardrailName)) {
        disabledGuardrails.push(rule.guardrailName);
      }
    } else if (rule.override === 'define') {
      // Define rules create synthetic guardrails.
      // Skip if DSL or a previous scope already defined this guardrail.
      const existingIdx = guardrails.findIndex((g) => g.name === rule.guardrailName);
      if (existingIdx >= 0) {
        // Higher-priority scope replaces lower-priority scope's define
        // But never replace a DSL-defined guardrail (those are in the initial array)
        guardrails[existingIdx] = toSyntheticGuardrail(rule);
      } else {
        guardrails.push(toSyntheticGuardrail(rule));
      }
    } else {
      const existingIdx = ruleOverrides.findIndex((r) => r.guardrailName === rule.guardrailName);
      if (existingIdx >= 0) {
        ruleOverrides[existingIdx] = rule;
      } else {
        ruleOverrides.push(rule);
      }
    }
  }
}
```

Wait — the "don't replace DSL" logic needs refinement. The `guardrails` array starts with `[...input.agentGuardrails]`, so we need to track which names came from DSL. Simpler approach: track DSL names in a Set.

Updated `resolve()`:

```typescript
resolve(input: PolicyInput): ResolvedGuardrailPolicy {
  const guardrails = [...input.agentGuardrails];
  const dslNames = new Set(input.agentGuardrails.map((g) => g.name));
  const disabledGuardrails: string[] = [];
  const ruleOverrides: PolicyRule[] = [];
  const providerOverrides: ProviderOverride[] = [];

  let settings: PolicySettings = { ...DEFAULT_SETTINGS };

  for (const policy of input.tenantPolicies) {
    settings = this.mergeSettings(settings, policy.settings);
    this.applyRules(policy.rules, guardrails, dslNames, disabledGuardrails, ruleOverrides);
    if (policy.providerOverrides) providerOverrides.push(...policy.providerOverrides);
  }

  for (const policy of input.projectPolicies) {
    settings = this.mergeSettings(settings, policy.settings);
    this.applyRules(policy.rules, guardrails, dslNames, disabledGuardrails, ruleOverrides);
    if (policy.providerOverrides) providerOverrides.push(...policy.providerOverrides);
  }

  log.debug('resolved guardrail policy', {
    tenantId: input.tenantId,
    projectId: input.projectId,
    agentDefId: input.agentDefId,
    guardrailCount: guardrails.length,
    disabledCount: disabledGuardrails.length,
    overrideCount: ruleOverrides.length,
    providerOverrideCount: providerOverrides.length,
  });

  return { guardrails, disabledGuardrails, ruleOverrides, settings, providerOverrides };
}
```

Updated `applyRules()`:

```typescript
private applyRules(
  rules: PolicyRule[],
  guardrails: Guardrail[],
  dslNames: Set<string>,
  disabledGuardrails: string[],
  ruleOverrides: PolicyRule[],
): void {
  for (const rule of rules) {
    if (rule.override === 'disable') {
      if (!disabledGuardrails.includes(rule.guardrailName)) {
        disabledGuardrails.push(rule.guardrailName);
      }
    } else if (rule.override === 'define') {
      // Never overwrite DSL-defined guardrails
      if (dslNames.has(rule.guardrailName)) continue;
      // Replace previous scope's define, or add new
      const existingIdx = guardrails.findIndex((g) => g.name === rule.guardrailName);
      if (existingIdx >= 0) {
        guardrails[existingIdx] = toSyntheticGuardrail(rule);
      } else {
        guardrails.push(toSyntheticGuardrail(rule));
      }
    } else {
      const existingIdx = ruleOverrides.findIndex((r) => r.guardrailName === rule.guardrailName);
      if (existingIdx >= 0) {
        ruleOverrides[existingIdx] = rule;
      } else {
        ruleOverrides.push(rule);
      }
    }
  }
}
```

**Step 6: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/policy-define-rules.test.ts`
Expected: PASS — all 5 tests green

**Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/services/guardrails/policy-resolver.ts packages/database/src/models/guardrail-policy.model.ts apps/runtime/src/__tests__/guardrails/policy-define-rules.test.ts
git add apps/runtime/src/services/guardrails/policy-resolver.ts packages/database/src/models/guardrail-policy.model.ts apps/runtime/src/__tests__/guardrails/policy-define-rules.test.ts
git commit -m "feat(runtime): add define rule type to guardrail policy resolver"
```

---

### Task 2: Add `additionalGuardrails` to PipelinePolicy and wire through pipeline-factory

**Files:**

- Modify: `packages/compiler/src/platform/guardrails/pipeline.ts:58-76`
- Modify: `apps/runtime/src/services/guardrails/pipeline-factory.ts:527-552`
- Test: `apps/runtime/src/__tests__/guardrails/pipeline-factory-policy.test.ts` (extend)

**Step 1: Write the failing test**

Add to the existing `apps/runtime/src/__tests__/guardrails/pipeline-factory-policy.test.ts`:

```typescript
it('should include additionalGuardrails from define rules when agent has no DSL guardrails', async () => {
  const result = await resolveGuardrailPolicy(
    'tenant-1',
    'project-1',
    'agent-1',
    [], // No DSL guardrails
    async () => ({
      tenantPolicies: [],
      projectPolicies: [
        {
          name: 'project-policy',
          rules: [
            {
              guardrailName: 'content_safety',
              override: 'define' as const,
              kind: 'output',
              tier: 'model',
              provider: 'openai_moderation',
              category: 'hate',
              threshold: 0.5,
              action: { type: 'block', message: 'Blocked.' },
            },
          ],
          settings: defaultSettings,
        },
      ],
    }),
  );

  expect(result).toBeDefined();
  expect(result!.additionalGuardrails).toBeDefined();
  expect(result!.additionalGuardrails).toHaveLength(1);
  expect(result!.additionalGuardrails![0].name).toBe('content_safety');
  expect(result!.additionalGuardrails![0].kind).toBe('output');
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/pipeline-factory-policy.test.ts`
Expected: FAIL — `additionalGuardrails` not on PipelinePolicy

**Step 3: Add `additionalGuardrails` to PipelinePolicy**

In `packages/compiler/src/platform/guardrails/pipeline.ts`, add to the `PipelinePolicy` interface (after line 75):

```typescript
export interface PipelinePolicy {
  disabledGuardrails?: string[];
  ruleOverrides?: Array<{
    guardrailName: string;
    override: 'threshold' | 'action' | 'severity_actions';
    threshold?: number;
    action?: GuardrailAction;
    severityActions?: Record<string, GuardrailAction>;
  }>;
  providerOverrides?: Array<{
    providerName: string;
    endpoint?: string;
    circuitBreaker?: { failureThreshold?: number; resetTimeoutMs?: number };
    retry?: { maxRetries?: number; backoffBaseMs?: number };
  }>;
  settings?: {
    failMode?: 'open' | 'closed';
  };
  /** Guardrails defined by DB policies (not in agent DSL). Merged with DSL guardrails at evaluation time. */
  additionalGuardrails?: Guardrail[];
}
```

Note: You need to import `Guardrail` at the top of the file. Check the existing imports — it's likely already imported.

**Step 4: Update `toPipelinePolicy` in pipeline-factory.ts**

In `apps/runtime/src/services/guardrails/pipeline-factory.ts`, update the `toPipelinePolicy` function:

```typescript
function toPipelinePolicy(
  resolved: ResolvedGuardrailPolicy,
  dslGuardrailNames: Set<string>,
): PipelinePolicy {
  // Separate policy-defined guardrails (not in DSL) from DSL guardrails
  const additionalGuardrails = resolved.guardrails.filter((g) => !dslGuardrailNames.has(g.name));

  return {
    disabledGuardrails: resolved.disabledGuardrails,
    ruleOverrides: resolved.ruleOverrides
      .filter(
        (r): r is typeof r & { override: 'threshold' | 'action' | 'severity_actions' } =>
          r.override !== 'disable',
      )
      .map((r) => ({
        guardrailName: r.guardrailName,
        override: r.override,
        threshold: r.threshold,
        action: r.action as GuardrailAction | undefined,
        severityActions: r.severityActions as Record<string, GuardrailAction> | undefined,
      })),
    providerOverrides: resolved.providerOverrides.map((o) => ({
      providerName: o.providerName,
      endpoint: o.endpoint,
      circuitBreaker: o.circuitBreaker,
      retry: o.retry,
    })),
    settings: {
      failMode: resolved.settings.failMode,
    },
    additionalGuardrails: additionalGuardrails.length > 0 ? additionalGuardrails : undefined,
  };
}
```

Update the `resolveGuardrailPolicy` call to pass DSL names:

In `resolveGuardrailPolicy()` (line 401-441), update the call to `toPipelinePolicy`:

```typescript
export async function resolveGuardrailPolicy(
  tenantId: string,
  projectId: string,
  agentDefId: string,
  agentGuardrails: Guardrail[],
  loadPolicies?: (
    tenantId: string,
    projectId: string,
    agentDefId: string,
  ) => Promise<{
    tenantPolicies: PolicyData[];
    projectPolicies: PolicyData[];
  }>,
): Promise<PipelinePolicy | undefined> {
  try {
    const loader = loadPolicies ?? loadPoliciesFromDB;
    const { tenantPolicies, projectPolicies } = await loader(tenantId, projectId, agentDefId);

    if (tenantPolicies.length === 0 && projectPolicies.length === 0) {
      return undefined;
    }

    const resolved = policyResolver.resolve({
      tenantId,
      projectId,
      agentDefId,
      agentGuardrails,
      tenantPolicies,
      projectPolicies,
    });

    const dslNames = new Set(agentGuardrails.map((g) => g.name));
    return toPipelinePolicy(resolved, dslNames);
  } catch (err) {
    log.warn('Failed to resolve guardrail policy, proceeding without policy', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/pipeline-factory-policy.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
npx prettier --write packages/compiler/src/platform/guardrails/pipeline.ts apps/runtime/src/services/guardrails/pipeline-factory.ts apps/runtime/src/__tests__/guardrails/pipeline-factory-policy.test.ts
git add packages/compiler/src/platform/guardrails/pipeline.ts apps/runtime/src/services/guardrails/pipeline-factory.ts apps/runtime/src/__tests__/guardrails/pipeline-factory-policy.test.ts
git commit -m "feat(runtime): add additionalGuardrails to PipelinePolicy for policy-defined guards"
```

---

### Task 3: Fix session-policy.ts — remove early return gate

**Files:**

- Modify: `apps/runtime/src/services/execution/session-policy.ts:22-23`
- Test: `apps/runtime/src/__tests__/guardrails/session-policy-inheritance.test.ts` (create)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/guardrails/session-policy-inheritance.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSessionPolicy } from '../../services/execution/session-policy';
import type { RuntimeSession } from '../../services/execution/types';

// Mock the pipeline-factory module
vi.mock('../../services/guardrails/pipeline-factory', () => ({
  resolveGuardrailPolicy: vi.fn(),
}));

import { resolveGuardrailPolicy } from '../../services/guardrails/pipeline-factory';

const mockResolve = vi.mocked(resolveGuardrailPolicy);

function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    agentName: 'test-agent',
    agentIR: {
      metadata: { name: 'test-agent', version: '1.0' },
      constraints: { guardrails: [] },
    },
    data: { values: {}, conversationHistory: [] },
    ...overrides,
  } as unknown as RuntimeSession;
}

describe('getSessionPolicy — project inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call resolveGuardrailPolicy even when agent has no DSL guardrails', async () => {
    const mockPolicy = {
      disabledGuardrails: [],
      ruleOverrides: [],
      providerOverrides: [],
      settings: { failMode: 'open' as const },
      additionalGuardrails: [
        {
          name: 'content_safety',
          description: 'Policy-defined',
          kind: 'output' as const,
          priority: 50,
          tier: 'model' as const,
          provider: 'openai_moderation',
          threshold: 0.5,
          action: { type: 'block' as const, message: 'Blocked.' },
        },
      ],
    };
    mockResolve.mockResolvedValueOnce(mockPolicy);

    const session = makeSession();
    const result = await getSessionPolicy(session);

    expect(mockResolve).toHaveBeenCalledOnce();
    expect(mockResolve).toHaveBeenCalledWith('tenant-1', 'project-1', 'test-agent', []);
    expect(result).toBe(mockPolicy);
  });

  it('should cache resolved policy on session (no re-query)', async () => {
    const mockPolicy = { settings: { failMode: 'open' as const } };
    mockResolve.mockResolvedValueOnce(mockPolicy as any);

    const session = makeSession();
    await getSessionPolicy(session);
    await getSessionPolicy(session);

    expect(mockResolve).toHaveBeenCalledOnce(); // Only once — cached
  });

  it('should cache null when no policies found (no re-query)', async () => {
    mockResolve.mockResolvedValueOnce(undefined);

    const session = makeSession();
    const result1 = await getSessionPolicy(session);
    const result2 = await getSessionPolicy(session);

    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
    expect(mockResolve).toHaveBeenCalledOnce();
  });

  it('should still call resolve when agent has DSL guardrails', async () => {
    const session = makeSession({
      agentIR: {
        metadata: { name: 'test-agent', version: '1.0' },
        constraints: {
          guardrails: [
            {
              name: 'dsl-guard',
              description: 'DSL guard',
              kind: 'output',
              priority: 1,
              tier: 'local',
              check: 'true',
              action: { type: 'block' },
            },
          ],
        },
      },
    } as any);

    mockResolve.mockResolvedValueOnce(undefined);
    await getSessionPolicy(session);

    expect(mockResolve).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      'test-agent',
      expect.arrayContaining([expect.objectContaining({ name: 'dsl-guard' })]),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/session-policy-inheritance.test.ts`
Expected: FAIL — first test fails because `resolveGuardrailPolicy` is never called (early return on empty guardrails)

**Step 3: Fix session-policy.ts**

Replace the entire file `apps/runtime/src/services/execution/session-policy.ts`:

```typescript
import type { PipelinePolicy } from '@abl/compiler';
import type { RuntimeSession } from './types.js';
import { resolveGuardrailPolicy } from '../guardrails/pipeline-factory.js';

/**
 * Lazily resolve and cache guardrail policy on the session.
 * Returns undefined if no policies are configured or DB is unavailable.
 *
 * Cache semantics:
 *   _guardrailPolicy === undefined → not yet resolved (will query DB)
 *   _guardrailPolicy === null      → resolved, no policy found (won't re-query)
 *   _guardrailPolicy === <policy>  → resolved with a policy
 */
export async function getSessionPolicy(
  session: RuntimeSession,
): Promise<PipelinePolicy | undefined> {
  if (session._guardrailPolicy !== undefined) {
    return session._guardrailPolicy ?? undefined; // null → undefined for callers
  }
  if (!session.tenantId || !session.projectId || !session.agentIR) return undefined;

  const guardrails = session.agentIR.constraints?.guardrails ?? [];
  // Always call resolver — DB policies may define guardrails even when DSL has none

  const policy = await resolveGuardrailPolicy(
    session.tenantId,
    session.projectId,
    session.agentIR.metadata.name ?? 'unknown',
    guardrails,
  );
  session._guardrailPolicy = policy ?? null; // store null instead of undefined
  return policy;
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/session-policy-inheritance.test.ts`
Expected: PASS — all 4 tests green

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/session-policy.ts apps/runtime/src/__tests__/guardrails/session-policy-inheritance.test.ts
git add apps/runtime/src/services/execution/session-policy.ts apps/runtime/src/__tests__/guardrails/session-policy-inheritance.test.ts
git commit -m "fix(runtime): remove early return gate in session-policy for empty DSL guardrails"
```

---

### Task 4: Fix reasoning-executor.ts — merge policy guardrails into evaluation

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:917-928`
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:1323-1336`
- Modify: `apps/runtime/src/services/execution/output-guardrails.ts:39-55`

**Step 1: Update output-guardrails.ts to merge additional guardrails from policy**

In `apps/runtime/src/services/execution/output-guardrails.ts`, update the `checkOutputGuardrails` function:

Change lines 47-55:

```typescript
export async function checkOutputGuardrails(
  text: string,
  guardrails: Guardrail[] | undefined,
  context: GuardrailContext,
  policy?: PipelinePolicy,
  llmEval?: LLMEvalFunction,
  tenantId?: string,
  session?: RuntimeSession,
): Promise<OutputGuardrailResult> {
  // Merge DSL guardrails with policy-defined additional guardrails
  const allGuardrails = [
    ...(guardrails ?? []),
    ...(policy?.additionalGuardrails ?? []),
  ];

  if (!text || allGuardrails.length === 0) {
    return { passed: true, text };
  }

  const outputGuardrails = allGuardrails.filter((g) => g.kind === 'output');
  if (outputGuardrails.length === 0) {
    return { passed: true, text };
  }
```

Then update any downstream usage of `guardrails` in this function to use `allGuardrails` instead. Check if the pipeline `execute()` call uses the local `guardrails` or `outputGuardrails` — it should pass `allGuardrails` (not the filtered output-only list) because the pipeline does its own filtering.

**Step 2: Update the output guardrail gate in reasoning-executor.ts**

Change line 917:

```typescript
// Before:
if (finalResponse && session.agentIR?.constraints?.guardrails) {

// After:
if (finalResponse) {
```

And update the `checkOutputGuardrails` call to keep passing `session.agentIR.constraints.guardrails` — the merge with policy additional guardrails now happens inside `checkOutputGuardrails`:

```typescript
if (finalResponse) {
  const policy = await getSessionPolicy(session);
  const dslGuardrails = session.agentIR?.constraints?.guardrails;
  const hasGuardrails = (dslGuardrails?.length ?? 0) > 0 || policy?.additionalGuardrails?.length;

  if (hasGuardrails) {
    const llmEval = session.llmClient ? createLLMEvalFromClient(session.llmClient) : undefined;
    const guardrailResult = await checkOutputGuardrails(
      finalResponse,
      dslGuardrails,
      {},
      policy,
      llmEval,
      session.tenantId,
      session,
    );
    // ... rest of violation handling stays exactly the same (lines 930-956)
  }
}
```

**Step 3: Update the tool_input guardrail gate in reasoning-executor.ts**

Change lines 1323-1336. The tool input path reads `session.agentIR?.constraints?.guardrails` and checks for `tool_input` kind. It also needs to include policy additional guardrails:

```typescript
// Before:
const guardrails = session.agentIR?.constraints?.guardrails ?? [];
if (guardrails.some((g) => g.kind === 'tool_input')) {

// After:
const dslGuardrails = session.agentIR?.constraints?.guardrails ?? [];
const policy = await getSessionPolicy(session);
const allGuardrails = [...dslGuardrails, ...(policy?.additionalGuardrails ?? [])];
if (allGuardrails.some((g) => g.kind === 'tool_input')) {
```

And update the pipeline execute call at line 1335-1336:

```typescript
const guardrailResult = await pipeline.execute(
  allGuardrails,  // was: guardrails
  JSON.stringify(toolCall.input),
  'tool_input',
  // ... rest stays the same
```

**Step 4: Run existing guardrail tests to ensure no regressions**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/`
Expected: All existing tests PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/services/execution/output-guardrails.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/services/execution/output-guardrails.ts
git commit -m "fix(runtime): merge policy-defined guardrails into output and tool_input evaluation"
```

---

### Task 5: Update pipeline.execute() to merge additionalGuardrails

**Files:**

- Modify: `packages/compiler/src/platform/guardrails/pipeline.ts:99-108`

The pipeline's `execute()` method receives `guardrails` and `policy` separately. It needs to merge `policy.additionalGuardrails` into the evaluation set.

**Step 1: Update pipeline execute**

In `packages/compiler/src/platform/guardrails/pipeline.ts`, in the `execute()` method:

```typescript
async execute(
  guardrails: Guardrail[],
  content: string,
  kind: GuardrailKind,
  context: GuardrailContext,
  onTraceEvent?: (event: unknown) => void,
  policy?: PipelinePolicy,
): Promise<GuardrailPipelineResult> {
  // Merge DSL guardrails with policy-defined additional guardrails
  const allGuardrails = [...guardrails, ...(policy?.additionalGuardrails ?? [])];

  // 1. Filter by kind
  let applicable = allGuardrails.filter((g) => g.kind === kind);

  // ... rest stays the same, using `applicable` (which is already the working variable)
```

**Step 2: Build compiler to verify no type errors**

Run: `pnpm build --filter=@abl/compiler`
Expected: Build succeeds

**Step 3: Run all guardrail tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/`
Expected: All PASS

**Step 4: Commit**

```bash
npx prettier --write packages/compiler/src/platform/guardrails/pipeline.ts
git add packages/compiler/src/platform/guardrails/pipeline.ts
git commit -m "feat(compiler): merge additionalGuardrails in pipeline execute"
```

---

### Task 6: Run full build and existing test suite

**Step 1: Build the whole project**

Run: `pnpm build`
Expected: All packages build successfully

**Step 2: Run all guardrail-related tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/ src/__tests__/guardrail-pipeline-expanded.test.ts src/__tests__/streaming-guardrails-policy.test.ts src/__tests__/severity-actions-policy.test.ts`
Expected: All PASS

**Step 3: Run the comprehensive E2E test**

Run: `cd apps/studio && pnpm playwright test e2e/guardrails-comprehensive-e2e.spec.ts --config=e2e/playwright.config.ts`

Note: For the E2E test to validate policy-defined guardrails, the test's policy creation must use `override: 'define'` rules. The existing test uses `override: 'threshold'` which is the override-only mode. The E2E test should be updated separately to use `define` rules — that's a follow-up task after this implementation.

**Step 4: Commit any fixes**

If any tests fail, fix and commit with: `fix(runtime): resolve test failures in guardrail inheritance`

---

### Task 7: Update E2E test to use `define` rules

**Files:**

- Modify: `apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts` (policy creation section)

**Step 1: Update policy rules from `override: 'threshold'` to `override: 'define'`**

In the E2E test, find the policy creation calls (around lines 515-660) and change the rules to use `define` mode. Example for the first policy:

```typescript
rules: [
  {
    guardrailName: 'content_safety',
    override: 'define',
    kind: 'output',
    tier: 'model',
    provider: `openai_mod_${RUN_ID}`,
    category: 'hate',
    threshold: 0.5,
    action: { type: 'block', message: 'Content safety violation detected. Your message has been blocked.' },
    description: 'Block hateful output content using OpenAI Moderation',
  },
],
```

Apply the same pattern to all three policies' rules — change `override: 'threshold'` to `override: 'define'` and add `description` and `message` fields.

**Step 2: Run E2E test**

Run: `cd apps/studio && pnpm playwright test e2e/guardrails-comprehensive-e2e.spec.ts --config=e2e/playwright.config.ts`
Expected: Test passes with guardrails now firing on chat messages

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts
git add apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts
git commit -m "test(studio): update E2E guardrail policies to use define rules for project inheritance"
```
