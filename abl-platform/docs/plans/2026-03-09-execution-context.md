# Execution Context for Graph Pipelines — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `sourceStep` config with a shared execution context — a flat key-value map accumulated as graph nodes execute, where each node type writes to a well-known key (e.g., `conversation`, `sentiment`) that downstream nodes read from.

**Architecture:** Each node type declares a `contextKey` (explicit or derived from type name). The graph walker builds an `executionContext` map as nodes execute, writing `result.data` under the node's `contextKey`. Services read from `executionContext` with fallback to `previousSteps[sourceStep]` for linear pipeline backward compat. Node-group children each write their own context keys after the group completes.

**Tech Stack:** TypeScript, Vitest, Mongoose, Restate SDK

---

## Task 1: Add `contextKey` to Types, Registry, and Seed Data

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/types.ts:271-285` (NodeTypeDefinition) and `:368-402` (NodeTypeDefinitionDoc)
- Modify: `packages/pipeline-engine/src/pipeline/node-registry.ts:122-137` (loadFromDocs)
- Modify: `packages/pipeline-engine/src/schemas/node-type-definition.schema.ts:75-118` (Mongoose schema)
- Modify: `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json`
- Test: `packages/pipeline-engine/src/__tests__/node-registry.test.ts`

**Step 1: Write the failing test**

In `packages/pipeline-engine/src/__tests__/node-registry.test.ts`, add to the `loadFromDocs` describe block:

```typescript
test('loads contextKey from doc', () => {
  const registry = new NodeRegistry();
  registry.loadFromDocs([
    {
      _id: 'compute-sentiment',
      tenantId: 'SYSTEM',
      label: 'Compute Sentiment',
      description: 'Sentiment analysis',
      category: 'compute',
      executionModel: 'async',
      defaultTimeout: 60000,
      defaultRetries: 0,
      traits: ['compute'],
      configSchema: [],
      contextKey: 'sentiment',
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const def = registry.get('compute-sentiment');
  expect(def?.contextKey).toBe('sentiment');
});

test('contextKey is undefined when not set in doc', () => {
  const registry = new NodeRegistry();
  registry.loadFromDocs([
    {
      _id: 'store-results',
      tenantId: 'SYSTEM',
      label: 'Store Results',
      description: 'Stores results',
      category: 'action',
      executionModel: 'async',
      defaultTimeout: 60000,
      defaultRetries: 0,
      traits: [],
      configSchema: [],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const def = registry.get('store-results');
  expect(def?.contextKey).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/node-registry.test.ts`
Expected: FAIL — `contextKey` does not exist on `NodeTypeDefinition`

**Step 3: Implement the type and registry changes**

In `packages/pipeline-engine/src/pipeline/types.ts`, add `contextKey` to `NodeTypeDefinition` (after `requiredCapabilities`):

```typescript
export interface NodeTypeDefinition {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  icon?: string;
  configSchema: { fields: ConfigField[] };
  inputSchema?: PortSchema;
  outputSchema?: PortSchema;
  executionModel: 'sync' | 'async' | 'control-flow';
  defaultTimeout?: number;
  defaultRetries?: number;
  retryable?: boolean;
  requiredCapabilities?: string[];
  /** Well-known key this node writes to in the execution context (e.g., 'conversation', 'sentiment'). */
  contextKey?: string;
}
```

Add `contextKey` to `NodeTypeDefinitionDoc` (after `requiredCapabilities`):

```typescript
  requiredCapabilities?: string[];

  /** Well-known key this node writes to in the execution context. */
  contextKey?: string;

  traits: NodeTrait[];
```

In `packages/pipeline-engine/src/schemas/node-type-definition.schema.ts`, add `contextKey` to the Mongoose schema (after `requiredCapabilities`):

```typescript
    requiredCapabilities: [{ type: String }],

    contextKey: { type: String },

    traits: [{ type: String, enum: ['compute', 'llm', 'storage'] }],
```

In `packages/pipeline-engine/src/pipeline/node-registry.ts`, update `loadFromDocs` to include `contextKey` in the definition (after `requiredCapabilities`):

```typescript
const definition: NodeTypeDefinition = {
  type: doc._id,
  category: doc.category,
  label: doc.label,
  description: doc.description,
  icon: doc.icon,
  configSchema: { fields },
  executionModel: doc.executionModel,
  defaultTimeout: doc.defaultTimeout,
  defaultRetries: doc.defaultRetries,
  retryable: doc.retryable,
  requiredCapabilities: doc.requiredCapabilities,
  contextKey: doc.contextKey,
  outputSchema: doc.outputSchema ? { properties: doc.outputSchema } : undefined,
};
```

**Step 4: Add `contextKey` to seed data**

In `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json`, add `contextKey` to each producer node type. Add the field after `"icon"` (or after `"description"`) for each entry:

| Node Type                     | contextKey               |
| ----------------------------- | ------------------------ |
| `read-conversation`           | `"conversation"`         |
| `read-message-window`         | `"messageWindow"`        |
| `compute-sentiment`           | `"sentiment"`            |
| `compute-intent`              | `"intent"`               |
| `compute-quality`             | `"quality"`              |
| `compute-mentions`            | `"mentions"`             |
| `conversation-analyzer`       | `"conversationAnalyzer"` |
| `compute-toxicity`            | `"toxicity"`             |
| `compute-tool-effectiveness`  | `"toolEffectiveness"`    |
| `compute-statistical`         | `"statistical"`          |
| `compute-predictive-features` | `"predictiveFeatures"`   |
| `evaluate-metrics`            | `"metrics"`              |
| `evaluate-policy`             | `"policy"`               |
| `call-llm`                    | `"llmResult"`            |

Do NOT add `contextKey` to consumer/control nodes: `store-results`, `store-insight`, `send-notification`, `node-group`, `wait-for-event`, `delay`, `sub-pipeline`, `transform`, `run-legacy-workflow`, `http-request`, `send-email`, `send-slack`, `publish-kafka`, `db-query`, `filter`, `aggregate`, `simulate-persona`, `execute-agent-turn`, `run-eval-conversation`, `judge-conversation`, `aggregate-eval-run`.

**Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/node-registry.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/types.ts packages/pipeline-engine/src/pipeline/node-registry.ts packages/pipeline-engine/src/schemas/node-type-definition.schema.ts packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json packages/pipeline-engine/src/__tests__/node-registry.test.ts
git add packages/pipeline-engine/src/pipeline/types.ts packages/pipeline-engine/src/pipeline/node-registry.ts packages/pipeline-engine/src/schemas/node-type-definition.schema.ts packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json packages/pipeline-engine/src/__tests__/node-registry.test.ts
git commit -m "[ABLP-2] feat(core): add contextKey to node type definitions and seed data"
```

---

## Task 2: Add `deriveContextKey` Utility and `resolveContextInput` Helper

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/execution-context.ts`
- Test: `packages/pipeline-engine/src/__tests__/execution-context.test.ts`

**Step 1: Write the failing tests**

Create `packages/pipeline-engine/src/__tests__/execution-context.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { deriveContextKey, resolveContextInput } from '../pipeline/execution-context.js';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

describe('deriveContextKey', () => {
  test('strips read- prefix', () => {
    expect(deriveContextKey('read-conversation')).toBe('conversation');
  });

  test('strips compute- prefix', () => {
    expect(deriveContextKey('compute-sentiment')).toBe('sentiment');
  });

  test('converts kebab-case to camelCase', () => {
    expect(deriveContextKey('read-message-window')).toBe('messageWindow');
    expect(deriveContextKey('conversation-analyzer')).toBe('conversationAnalyzer');
    expect(deriveContextKey('compute-tool-effectiveness')).toBe('toolEffectiveness');
    expect(deriveContextKey('compute-predictive-features')).toBe('predictiveFeatures');
  });

  test('returns null for non-producer types', () => {
    expect(deriveContextKey('store-results')).toBeNull();
    expect(deriveContextKey('node-group')).toBeNull();
    expect(deriveContextKey('send-notification')).toBeNull();
    expect(deriveContextKey('wait-for-event')).toBeNull();
    expect(deriveContextKey('delay')).toBeNull();
  });
});

describe('resolveContextInput', () => {
  const makeInput = (overrides: Partial<PipelineStepContext> = {}): PipelineStepContext => ({
    tenantId: 't-1',
    config: {},
    previousSteps: {},
    pipelineInput: {},
    ...overrides,
  });

  test('reads from executionContext when available', () => {
    const input = makeInput({
      executionContext: {
        conversation: { messages: [{ role: 'user', content: 'hello' }] },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'hello' }] });
  });

  test('falls back to previousSteps with sourceStep config for linear pipelines', () => {
    const input = makeInput({
      config: { sourceStep: 'read-conv' },
      previousSteps: {
        'read-conv': {
          status: 'success',
          data: { messages: [{ role: 'user', content: 'hi' }] },
        },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });

  test('falls back to default read-conversation step when no sourceStep config', () => {
    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: { messages: [{ role: 'user', content: 'default' }] },
        },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'default' }] });
  });

  test('returns undefined when nothing available', () => {
    const input = makeInput();
    expect(resolveContextInput(input, 'conversation')).toBeUndefined();
  });

  test('returns undefined when previousStep has failed status', () => {
    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'fail',
          data: { error: 'failed' },
        },
      },
    });

    expect(resolveContextInput(input, 'conversation')).toBeUndefined();
  });

  test('executionContext takes priority over previousSteps', () => {
    const input = makeInput({
      executionContext: {
        conversation: { messages: [{ role: 'user', content: 'from context' }] },
      },
      config: { sourceStep: 'read-conv' },
      previousSteps: {
        'read-conv': {
          status: 'success',
          data: { messages: [{ role: 'user', content: 'from previous' }] },
        },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'from context' }] });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/execution-context.test.ts`
Expected: FAIL — module `../pipeline/execution-context.js` does not exist

**Step 3: Add `executionContext` to `PipelineStepContext`**

In `packages/pipeline-engine/src/pipeline/types.ts`, add `executionContext` to `PipelineStepContext` (after `previousSteps`):

```typescript
  /**
   * Outputs from all previously completed steps, keyed by step ID.
   * Steps that were skipped have { status: 'skipped', data: {} }.
   */
  previousSteps: Record<string, StepOutput>;

  /**
   * Accumulated execution context from graph pipeline execution.
   * Keys are well-known names (e.g., 'conversation', 'sentiment') mapped
   * from node type contextKey. Undefined for linear pipelines.
   */
  executionContext?: Record<string, Record<string, any>>;

  /**
   * Pipeline-level input — from the trigger event payload or manual execute request body.
   */
  pipelineInput: Record<string, any>;
```

Also add `executionContext` to `ActivityRouterInput` in `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts` (after `previousSteps`):

```typescript
export interface ActivityRouterInput {
  step: PipelineStep;
  previousSteps: Record<string, StepOutput>;
  executionContext?: Record<string, Record<string, any>>;
  pipelineInput: Record<string, any>;
  resolvedConfig?: ResolvedPipelineConfig;
  executionMode?: 'batch' | 'realtime';
  triggerId?: string;
}
```

And pass it through in the `execute` handler where `stepContext` is built (around line 173):

```typescript
const stepContext: PipelineStepContext = {
  tenantId: pipelineInput.tenantId,
  projectId: pipelineInput.projectId,
  sessionId: pipelineInput.sessionId,
  executionMode: executionMode ?? 'batch',
  triggerId: triggerId ?? 'default',
  config: mergedConfig,
  previousSteps,
  executionContext,
  pipelineInput,
};
```

Note: destructure `executionContext` from `input` at the top of the handler (line 101):

```typescript
const {
  step,
  previousSteps,
  executionContext,
  pipelineInput,
  resolvedConfig,
  executionMode,
  triggerId,
} = input;
```

**Step 4: Implement the utility functions**

Create `packages/pipeline-engine/src/pipeline/execution-context.ts`:

```typescript
/**
 * Execution context utilities for graph pipelines.
 *
 * Each node type writes its output to a well-known key (contextKey) in the
 * execution context. Downstream nodes read from context by key name,
 * decoupling data flow from node IDs.
 */

import type { PipelineStepContext } from './types.js';

/**
 * Derive a context key from a node type name by stripping the verb prefix
 * and converting kebab-case to camelCase.
 *
 * Returns null for non-producer types (store-*, node-group, etc.).
 *
 * Examples:
 *   read-conversation       → conversation
 *   compute-sentiment       → sentiment
 *   conversation-analyzer  → conversationAnalyzer
 *   store-results           → null
 *   node-group              → null
 */
export function deriveContextKey(nodeType: string): string | null {
  const producerPrefixes = ['read-', 'compute-', 'evaluate-', 'call-'];

  for (const prefix of producerPrefixes) {
    if (nodeType.startsWith(prefix)) {
      const suffix = nodeType.slice(prefix.length);
      return suffix.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    }
  }

  return null;
}

/**
 * Resolve input data for a service by context key.
 *
 * 1. Checks executionContext[key] (graph pipelines)
 * 2. Falls back to previousSteps[sourceStep].data (linear pipelines)
 *
 * Returns the data record or undefined if not available.
 */
export function resolveContextInput(
  input: PipelineStepContext,
  contextKey: string,
): Record<string, any> | undefined {
  // Graph mode: read from execution context
  if (input.executionContext?.[contextKey]) {
    return input.executionContext[contextKey];
  }

  // Linear mode: fall back to previousSteps with sourceStep config
  const sourceStep = (input.config.sourceStep as string) ?? 'read-conversation';
  const step = input.previousSteps[sourceStep];
  return step?.status === 'success' ? step.data : undefined;
}
```

**Step 5: Export from package index**

In `packages/pipeline-engine/src/index.ts`, add the export:

```typescript
export { deriveContextKey, resolveContextInput } from './pipeline/execution-context.js';
```

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/execution-context.test.ts`
Expected: ALL PASS

**Step 7: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/execution-context.ts packages/pipeline-engine/src/__tests__/execution-context.test.ts packages/pipeline-engine/src/pipeline/types.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/index.ts
git add packages/pipeline-engine/src/pipeline/execution-context.ts packages/pipeline-engine/src/__tests__/execution-context.test.ts packages/pipeline-engine/src/pipeline/types.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/index.ts
git commit -m "[ABLP-2] feat(core): add execution context utilities and resolveContextInput helper"
```

---

## Task 3: Build Execution Context in Graph Walker + Fix Node-Group Children

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts:292-378`
- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts:300-353`
- Test: `packages/pipeline-engine/src/__tests__/execution-context.test.ts` (add integration-style tests)

This task changes the graph walker to:

1. Build `executionContext` as nodes execute
2. Pass `executionContext` to the activity router
3. Pass `children` to the activity router for node-group nodes
4. After node-group completes, extract child outputs into execution context

**Step 1: Write the failing tests**

Add to `packages/pipeline-engine/src/__tests__/execution-context.test.ts`:

```typescript
import { buildExecutionContext } from '../pipeline/execution-context.js';
import type { StepOutput } from '../pipeline/types.js';

describe('buildExecutionContext', () => {
  test('writes result.data under contextKey', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = {
      status: 'success',
      data: { messages: [{ role: 'user', content: 'hello' }], sessionId: 'sess-1' },
    };

    buildExecutionContext(context, 'read-conversation', result, 'conversation');
    expect(context.conversation).toEqual(result.data);
  });

  test('skips when result status is not success', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = { status: 'fail', data: { error: 'oops' } };

    buildExecutionContext(context, 'compute-sentiment', result, 'sentiment');
    expect(context.sentiment).toBeUndefined();
  });

  test('skips when contextKey is null', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = { status: 'success', data: { stored: true } };

    buildExecutionContext(context, 'store-results', result, null);
    expect(Object.keys(context)).toHaveLength(0);
  });

  test('uses explicit contextKey over derived', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = { status: 'success', data: { output: 'text' } };

    buildExecutionContext(context, 'call-llm', result, 'llmResult');
    expect(context.llmResult).toEqual(result.data);
    expect(context.llm).toBeUndefined();
  });

  test('extracts node-group child outputs into context', () => {
    const context: Record<string, Record<string, any>> = {};
    const groupResult: StepOutput = {
      status: 'success',
      data: {
        children: {
          'sentiment-node': { status: 'success', data: { score: 0.8 } },
          'intent-node': { status: 'success', data: { intent: 'billing' } },
        },
      },
    };
    const children = [
      { id: 'sentiment-node', type: 'compute-sentiment', config: {} },
      { id: 'intent-node', type: 'compute-intent', config: {} },
    ];

    buildExecutionContext(context, 'node-group', groupResult, null, children);
    expect(context.sentiment).toEqual({ score: 0.8 });
    expect(context.intent).toEqual({ intent: 'billing' });
  });

  test('skips failed children in node-group', () => {
    const context: Record<string, Record<string, any>> = {};
    const groupResult: StepOutput = {
      status: 'success',
      data: {
        children: {
          'sentiment-node': { status: 'success', data: { score: 0.8 } },
          'intent-node': { status: 'fail', data: { error: 'timeout' } },
        },
      },
    };
    const children = [
      { id: 'sentiment-node', type: 'compute-sentiment', config: {} },
      { id: 'intent-node', type: 'compute-intent', config: {} },
    ];

    buildExecutionContext(context, 'node-group', groupResult, null, children);
    expect(context.sentiment).toEqual({ score: 0.8 });
    expect(context.intent).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/execution-context.test.ts`
Expected: FAIL — `buildExecutionContext` does not exist

**Step 3: Implement `buildExecutionContext`**

In `packages/pipeline-engine/src/pipeline/execution-context.ts`, add:

```typescript
import type { PipelineStepContext, StepOutput, GroupChildNode } from './types.js';

/**
 * Write a node's output into the execution context under its contextKey.
 * For node-groups, extracts each child's output using derived context keys.
 *
 * @param context    The mutable execution context map
 * @param nodeType   The node's type (e.g., 'compute-sentiment')
 * @param result     The node's StepOutput
 * @param contextKey Explicit contextKey (from registry), or null to derive
 * @param children   For node-groups: child definitions to extract outputs from
 */
export function buildExecutionContext(
  context: Record<string, Record<string, any>>,
  nodeType: string,
  result: StepOutput,
  contextKey: string | null | undefined,
  children?: Array<{ id: string; type: string; config: Record<string, any> }>,
): void {
  // Node-group: extract each child's output into context
  if (nodeType === 'node-group' && children && result.status === 'success') {
    const childOutputs = result.data?.children as Record<string, StepOutput> | undefined;
    if (childOutputs) {
      for (const child of children) {
        const childKey = deriveContextKey(child.type);
        const childResult = childOutputs[child.id];
        if (childKey && childResult?.status === 'success') {
          context[childKey] = childResult.data;
        }
      }
    }
    return;
  }

  // Regular node: write under contextKey
  const key = contextKey ?? deriveContextKey(nodeType);
  if (key && result.status === 'success') {
    context[key] = result.data;
  }
}
```

Update the export in `packages/pipeline-engine/src/index.ts`:

```typescript
export {
  deriveContextKey,
  resolveContextInput,
  buildExecutionContext,
} from './pipeline/execution-context.js';
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/execution-context.test.ts`
Expected: ALL PASS

**Step 5: Update the graph walker**

In `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts`:

Add import at the top:

```typescript
import { buildExecutionContext, deriveContextKey } from '../execution-context.js';
```

In `runGraphMode`, add `executionContext` initialization after `nodeOutputs` (around line 301):

```typescript
const nodeOutputs: Record<string, StepOutput> = {};
const executionContext: Record<string, Record<string, any>> = {};
const visitCounts: Record<string, number> = {};
```

Update the activity router call (around line 343) to pass `executionContext` and `children`:

```typescript
const result = await ctx.serviceClient(activityRouter).execute({
  step: {
    id: node.id,
    type: node.type,
    config: node.config,
    timeout: node.timeout,
    retries: node.retries,
    onFailure: node.onFailure,
    ...(node.children ? { children: node.children } : {}),
  },
  previousSteps: nodeOutputs,
  executionContext,
  pipelineInput,
  resolvedConfig,
  executionMode,
  triggerId,
});
```

After `nodeOutputs[node.id] = result;` (around line 359), add execution context building:

```typescript
nodeOutputs[node.id] = result;

// Build execution context — write node output under its contextKey
buildExecutionContext(executionContext, node.type, result, undefined, node.children);

await updateStepState(ctx, node.id, result.status, result.durationMs);
```

Note: We pass `undefined` for `contextKey` here to use the derived key. If the registry is available in the future, pass `registry.get(node.type)?.contextKey` instead.

**Step 6: Update `executeNodeGroup` to pass `executionContext`**

In `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`, update `executeNodeGroup` to pass `executionContext` through to children (around line 304):

```typescript
async function executeNodeGroup(
  ctx: restate.Context,
  input: ActivityRouterInput,
): Promise<StepOutput> {
  const { step, previousSteps, executionContext, pipelineInput, resolvedConfig, executionMode, triggerId } = input;
```

And in the child dispatch (around line 331):

```typescript
const results = await restate.CombineablePromise.all(
  childSteps.map((childStep) =>
    ctx.serviceClient(activityRouter).execute({
      step: childStep,
      previousSteps,
      executionContext,
      pipelineInput,
      resolvedConfig,
      executionMode,
      triggerId,
    }),
  ),
);
```

**Step 7: Run full test suite**

Run: `pnpm vitest run`
Expected: ALL PASS (existing tests should not break — `executionContext` is optional)

**Step 8: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/execution-context.ts packages/pipeline-engine/src/__tests__/execution-context.test.ts packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/index.ts
git add packages/pipeline-engine/src/pipeline/execution-context.ts packages/pipeline-engine/src/__tests__/execution-context.test.ts packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/index.ts
git commit -m "[ABLP-2] feat(core): build execution context in graph walker and fix node-group children"
```

---

## Task 4: Migrate Compute Services to `resolveContextInput`

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts:135-146`
- Modify: `packages/pipeline-engine/src/pipeline/services/compute-intent.service.ts:141-152`
- Modify: `packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts:218-229`
- Modify: `packages/pipeline-engine/src/pipeline/services/compute-mentions.service.ts:73-82`
- Modify: `packages/pipeline-engine/src/pipeline/services/compute-statistical.service.ts:132-141`
- Modify: `packages/pipeline-engine/src/pipeline/services/conversation-analyzer.service.ts:149-154`
- Tests: existing tests in `src/__tests__/compute-mentions.test.ts` and others

Each compute service follows the same pattern. Replace the `sourceStep` lookup with `resolveContextInput`.

**Step 1: Write a test for backward compatibility**

In `packages/pipeline-engine/src/__tests__/compute-mentions.test.ts`, add a test that verifies `executionContext` is used when present. Find the existing test setup and add:

```typescript
test('reads from executionContext when available', async () => {
  const input = makeInput({
    executionContext: {
      conversation: {
        messages: [
          { role: 'user', content: 'I love Apple products but Samsung is cheaper' },
          { role: 'assistant', content: 'Both are great choices!' },
        ],
        transcript: '',
        metadata: { agentName: 'TestBot', channel: 'chat' },
      },
    },
    previousSteps: {}, // empty — should still work via executionContext
  });

  const result = await executeComputeMentions(input);
  expect(result.status).toBe('success');
});
```

Note: `executeComputeMentions` is the test helper that calls the service — look at the existing test file to match the exact pattern. The test may use `ctx` from Restate test utils.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/compute-mentions.test.ts`
Expected: FAIL — service falls back to `previousSteps['read-conversation']` which is empty

**Step 3: Migrate each service**

The pattern change for every compute service is identical. Replace:

```typescript
const sourceStep = (input.config.sourceStep as string) ?? 'read-conversation';
const conversationStep = input.previousSteps[sourceStep];

if (!conversationStep || conversationStep.status !== 'success') {
  return {
    status: 'fail',
    data: { error: `ServiceName requires a successful '${sourceStep}' step in previousSteps` },
    durationMs: Date.now() - startTime,
  };
}
```

With:

```typescript
import { resolveContextInput } from '../execution-context.js';

// ...

const conversationData = resolveContextInput(input, 'conversation');
if (!conversationData) {
  return {
    status: 'fail',
    data: {
      error: 'ServiceName requires conversation data (from read-conversation or execution context)',
    },
    durationMs: Date.now() - startTime,
  };
}
```

Then update data access — change `conversationStep.data.messages` to `conversationData.messages` (since `resolveContextInput` returns the `.data` directly).

**Apply this to each service:**

**`compute-sentiment.service.ts`** (around line 135):

```typescript
import { resolveContextInput } from '../execution-context.js';
// ...
const conversationData = resolveContextInput(input, 'conversation');
if (!conversationData) {
  return {
    status: 'fail',
    data: {
      error:
        'ComputeSentiment requires conversation data (from read-conversation or execution context)',
    },
    durationMs: Date.now() - startTime,
  };
}
// Then: conversationData.messages instead of conversationStep.data.messages
```

**`compute-intent.service.ts`** (around line 141):
Same pattern — `resolveContextInput(input, 'conversation')`, use `conversationData.messages`.

**`compute-quality.service.ts`** (around line 218):
Same pattern.

**`compute-mentions.service.ts`** (around line 73):
Same pattern.

**`compute-statistical.service.ts`** (around line 132):
Same pattern — the `createFrictionProfile` function also uses this pattern.

**`conversation-analyzer.service.ts`** (around line 149):
Same pattern.

**Step 4: Run the full test suite**

Run: `pnpm vitest run`
Expected: ALL PASS — existing tests pass because `resolveContextInput` falls back to `previousSteps[sourceStep]`

**Step 5: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts packages/pipeline-engine/src/pipeline/services/compute-intent.service.ts packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts packages/pipeline-engine/src/pipeline/services/compute-mentions.service.ts packages/pipeline-engine/src/pipeline/services/compute-statistical.service.ts packages/pipeline-engine/src/pipeline/services/conversation-analyzer.service.ts
git add packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts packages/pipeline-engine/src/pipeline/services/compute-intent.service.ts packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts packages/pipeline-engine/src/pipeline/services/compute-mentions.service.ts packages/pipeline-engine/src/pipeline/services/compute-statistical.service.ts packages/pipeline-engine/src/pipeline/services/conversation-analyzer.service.ts
git commit -m "[ABLP-2] refactor(core): migrate compute services to resolveContextInput for graph pipeline support"
```

---

## Task 5: Remove `sourceStep` from Compute Trait

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/trait-merger.ts:15-26`
- Test: `packages/pipeline-engine/src/__tests__/trait-merger.test.ts`
- Test: `packages/pipeline-engine/src/__tests__/config-driven-integration.test.ts`

**Step 1: Update the tests**

In `packages/pipeline-engine/src/__tests__/trait-merger.test.ts`, the test `'merges sourceStep for compute trait'` should be updated to verify `sourceStep` is NOT merged. Change:

```typescript
test('compute trait does not inject sourceStep (replaced by execution context)', () => {
  const doc = makeDoc({ traits: ['compute'] });
  const result = mergeTraitFields(doc);
  const sourceStep = result.find((f) => f.name === 'sourceStep');
  expect(sourceStep).toBeUndefined();
});
```

Update other tests in this file that assert `sourceStep` is present — they should now assert it's absent.

In `packages/pipeline-engine/src/__tests__/config-driven-integration.test.ts`, update the test `'compute nodes have trait-merged sourceStep field'` to reflect the removal:

```typescript
test('compute nodes no longer have trait-merged sourceStep field', () => {
  const def = registry.get('compute-sentiment');
  const fields = def!.configSchema.fields.map((f) => f.name);
  expect(fields).not.toContain('sourceStep');
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/trait-merger.test.ts src/__tests__/config-driven-integration.test.ts`
Expected: FAIL — tests expect no `sourceStep` but trait still injects it

**Step 3: Remove `sourceStep` from compute trait**

In `packages/pipeline-engine/src/pipeline/trait-merger.ts`, change the `compute` trait fields to an empty array:

```typescript
const TRAIT_FIELDS: Record<NodeTrait, ConfigFieldDefinition[]> = {
  compute: [],
  llm: [
    {
      name: 'model',
      type: 'string',
      required: false,
      label: 'LLM Model Override',
      description: 'Override the default LLM model for this node',
      group: 'advanced',
    },
  ],
  storage: [
    {
      name: 'skipDirectWrite',
      type: 'boolean',
      required: false,
      default: false,
      label: 'Skip Direct Write',
      description: 'Skip ClickHouse write (use store-results node instead)',
      group: 'advanced',
    },
  ],
};
```

Update the JSDoc at the top:

```typescript
/**
 * Merges trait-based standard fields into a node type's configSchema.
 *
 * Each trait defines standard fields that are auto-appended unless the
 * node's configSchema already defines a field with the same name.
 *
 * Traits:
 *   compute → (no fields — execution context replaces sourceStep)
 *   llm     → model
 *   storage → skipDirectWrite
 */
```

**Step 4: Also remove `sourceStep` from seed data**

In `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json`, remove any `sourceStep` entries from node configSchema arrays. Search for `"name": "sourceStep"` and remove those objects. (Some nodes like `store-insight` and `store-results` have `sourceStep` in their own configSchema — check if they still need it for the linear pipeline backward compat. If they only access via `resolveContextInput`, remove it.)

**Step 5: Run tests to verify they pass**

Run: `pnpm vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/trait-merger.ts packages/pipeline-engine/src/__tests__/trait-merger.test.ts packages/pipeline-engine/src/__tests__/config-driven-integration.test.ts packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json
git add packages/pipeline-engine/src/pipeline/trait-merger.ts packages/pipeline-engine/src/__tests__/trait-merger.test.ts packages/pipeline-engine/src/__tests__/config-driven-integration.test.ts packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json
git commit -m "[ABLP-2] refactor(core): remove sourceStep from compute trait, replaced by execution context"
```
