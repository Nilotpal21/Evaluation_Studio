# Universal Pipeline Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve the existing `packages/pipeline-engine/` from an analytics-specific step-array engine into a universal graph-based pipeline engine with branching, loops, parallel groups, pause/resume, and a self-describing node catalog — without breaking any existing pipelines.

**Architecture:** Extend the existing Restate-based pipeline engine with a graph execution model (nodes with embedded transitions), a `NodeRegistry` for self-describing node types, control-flow nodes (node-group, wait-for-event, delay, sub-pipeline), and generic data/integration nodes. All 21+ existing activity services auto-register as nodes. Legacy `steps[]` definitions auto-convert to graph format at runtime.

**Tech Stack:** TypeScript, Restate SDK (`@restatedev/restate-sdk`), MongoDB (Mongoose), Vitest, Zod

**Design Doc:** `docs/plans/2026-03-07-universal-pipeline-engine-design.md`

---

## Task 1: Node Type System — Interfaces & Types

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/types.ts`

**Step 1: Write the failing test**

Create test file for the new types:

```typescript
// packages/pipeline-engine/src/__tests__/node-types.test.ts
import { describe, test, expect } from 'vitest';
import type {
  NodeTypeDefinition,
  NodeCategory,
  PipelineNode,
  NodeTransition,
  GroupChildNode,
} from '../pipeline/types.js';

describe('NodeTypeDefinition', () => {
  test('can create a compute node type definition', () => {
    const def: NodeTypeDefinition = {
      type: 'compute-toxicity',
      category: 'compute',
      label: 'Toxicity Detection',
      description: 'Score messages for toxicity',
      configSchema: {
        fields: [
          {
            name: 'threshold',
            type: 'number',
            required: true,
            default: 0.7,
            description: 'Score threshold',
          },
        ],
      },
      executionModel: 'sync',
      defaultTimeout: 120_000,
      defaultRetries: 2,
      retryable: true,
    };
    expect(def.type).toBe('compute-toxicity');
    expect(def.category).toBe('compute');
    expect(def.configSchema.fields).toHaveLength(1);
    expect(def.configSchema.fields[0].required).toBe(true);
  });

  test('can create a logic node type definition', () => {
    const def: NodeTypeDefinition = {
      type: 'wait-for-event',
      category: 'logic',
      label: 'Wait for Event',
      description: 'Pause and wait for external signal',
      configSchema: {
        fields: [
          { name: 'eventName', type: 'string', required: true, description: 'Event name' },
          {
            name: 'timeoutMs',
            type: 'number',
            required: false,
            default: 86400000,
            description: 'Timeout',
          },
        ],
      },
      executionModel: 'control-flow',
    };
    expect(def.executionModel).toBe('control-flow');
  });

  test('can create an integration node with required capabilities', () => {
    const def: NodeTypeDefinition = {
      type: 'http-request',
      category: 'integration',
      label: 'HTTP Request',
      description: 'Make HTTP request',
      configSchema: { fields: [] },
      executionModel: 'async',
      requiredCapabilities: ['external-http'],
    };
    expect(def.requiredCapabilities).toContain('external-http');
  });
});

describe('PipelineNode', () => {
  test('can create a node with transitions', () => {
    const node: PipelineNode = {
      id: 'check',
      type: 'compute-toxicity',
      label: 'Check Toxicity',
      config: { threshold: 0.7 },
      transitions: [
        { target: 'alert', condition: 'output.score > 0.7', order: 1, label: 'toxic' },
        { target: 'store', order: 2, label: 'clean' },
      ],
    };
    expect(node.transitions).toHaveLength(2);
    expect(node.transitions[0].condition).toBe('output.score > 0.7');
  });

  test('can create a terminal node with empty transitions', () => {
    const node: PipelineNode = {
      id: 'store',
      type: 'store-insight',
      config: {},
      transitions: [],
    };
    expect(node.transitions).toHaveLength(0);
  });

  test('can create a node-group with children', () => {
    const node: PipelineNode = {
      id: 'eval-group',
      type: 'node-group',
      config: {},
      children: [
        { id: 'tox', type: 'compute-toxicity', config: { threshold: 0.7 } },
        { id: 'sent', type: 'compute-sentiment', config: { granularity: 'session' } },
      ],
      transitions: [{ target: 'store' }],
    };
    expect(node.children).toHaveLength(2);
    expect(node.children![0].id).toBe('tox');
  });

  test('can create a node with loop protection', () => {
    const node: PipelineNode = {
      id: 'validate',
      type: 'call-llm',
      config: {},
      maxVisits: 5,
      transitions: [
        { target: 'done', condition: 'output.valid == true', order: 1 },
        { target: 'fetch', order: 2 },
      ],
    };
    expect(node.maxVisits).toBe(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/node-types.test.ts`
Expected: FAIL — types not exported yet

**Step 3: Add types to types.ts**

Add the following to the end of `packages/pipeline-engine/src/pipeline/types.ts`:

```typescript
// ── Node Type System (Universal Pipeline Engine) ──

export type NodeCategory = 'data' | 'logic' | 'integration' | 'compute' | 'action';

export interface PortSchema {
  properties: Record<
    string,
    {
      type: string;
      description?: string;
    }
  >;
}

/**
 * Metadata that describes a node type — registered once at startup,
 * queried by the pipeline builder API and validation layer.
 * This is platform seed data: what nodes exist, what each needs, what it produces.
 */
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
}

/**
 * A transition from one node to another.
 * Embedded in the source node's transitions array.
 */
export interface NodeTransition {
  target: string;
  condition?: string;
  order?: number;
  label?: string;
}

/**
 * A child node inside a node-group. Executes in parallel.
 * Cannot have transitions — only the parent group has transitions.
 */
export interface GroupChildNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, any>;
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
}

/**
 * A node in the pipeline graph.
 * Carries filled-in config and outgoing transitions.
 */
export interface PipelineNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, any>;
  transitions: NodeTransition[];
  children?: GroupChildNode[];
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
  maxVisits?: number;
  position?: { x: number; y: number };
}
```

Also add `nodes` and `entryNodeId` to the existing `PipelineDefinition` interface:

```typescript
// Add to PipelineDefinition interface (after the existing steps? field):
  /** Graph-based flow (universal pipeline engine) */
  nodes?: PipelineNode[];
  entryNodeId?: string;
  /** Default failure strategy for all nodes */
  onNodeFailure?: 'stop' | 'skip' | 'continue';
```

**Step 4: Export new types from index.ts**

Add to `packages/pipeline-engine/src/index.ts`:

```typescript
export type {
  NodeTypeDefinition,
  NodeCategory,
  PortSchema,
  PipelineNode,
  NodeTransition,
  GroupChildNode,
} from './pipeline/types.js';
```

**Step 5: Run test to verify it passes**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/node-types.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/types.ts packages/pipeline-engine/src/index.ts packages/pipeline-engine/src/__tests__/node-types.test.ts
git commit -m "feat(pipeline-engine): add node type system interfaces for universal pipeline engine"
```

---

## Task 2: Node Registry

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/node-registry.ts`
- Create: `packages/pipeline-engine/src/__tests__/node-registry.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/node-registry.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { NodeRegistry } from '../pipeline/node-registry.js';
import type { NodeTypeDefinition } from '../pipeline/types.js';

const toxicityNode: NodeTypeDefinition = {
  type: 'compute-toxicity',
  category: 'compute',
  label: 'Toxicity Detection',
  description: 'Score messages for toxicity',
  configSchema: {
    fields: [
      {
        name: 'threshold',
        type: 'number',
        required: true,
        default: 0.7,
        description: 'Score threshold',
      },
      { name: 'categories', type: 'array', required: false, description: 'Categories to evaluate' },
    ],
  },
  executionModel: 'sync',
  defaultTimeout: 120_000,
  defaultRetries: 2,
  retryable: true,
};

const httpNode: NodeTypeDefinition = {
  type: 'http-request',
  category: 'integration',
  label: 'HTTP Request',
  description: 'Make HTTP request',
  configSchema: {
    fields: [
      { name: 'url', type: 'string', required: true, description: 'URL' },
      {
        name: 'method',
        type: 'enum',
        required: true,
        default: 'GET',
        description: 'HTTP method',
        values: ['GET', 'POST', 'PUT', 'DELETE'],
      },
    ],
  },
  executionModel: 'async',
  requiredCapabilities: ['external-http'],
};

const nodeGroupNode: NodeTypeDefinition = {
  type: 'node-group',
  category: 'logic',
  label: 'Parallel Group',
  description: 'Execute nodes in parallel',
  configSchema: { fields: [] },
  executionModel: 'control-flow',
};

describe('NodeRegistry', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  describe('register', () => {
    test('registers a node type', () => {
      registry.register(toxicityNode);
      expect(registry.has('compute-toxicity')).toBe(true);
    });

    test('throws on duplicate registration', () => {
      registry.register(toxicityNode);
      expect(() => registry.register(toxicityNode)).toThrow('already registered');
    });
  });

  describe('get', () => {
    test('returns registered node type', () => {
      registry.register(toxicityNode);
      const def = registry.get('compute-toxicity');
      expect(def).toBeDefined();
      expect(def!.label).toBe('Toxicity Detection');
    });

    test('returns undefined for unknown type', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });
  });

  describe('has', () => {
    test('returns true for registered type', () => {
      registry.register(toxicityNode);
      expect(registry.has('compute-toxicity')).toBe(true);
    });

    test('returns false for unknown type', () => {
      expect(registry.has('unknown')).toBe(false);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      registry.register(toxicityNode);
      registry.register(httpNode);
      registry.register(nodeGroupNode);
    });

    test('lists all node types', () => {
      const all = registry.list();
      expect(all).toHaveLength(3);
    });

    test('filters by category', () => {
      const compute = registry.list({ category: 'compute' });
      expect(compute).toHaveLength(1);
      expect(compute[0].type).toBe('compute-toxicity');
    });

    test('filters by capabilities', () => {
      const withHttp = registry.list({ capabilities: ['external-http'] });
      expect(withHttp).toHaveLength(2); // toxicity (no cap) + node-group (no cap)
      // http-request requires external-http but the filter returns nodes
      // whose requiredCapabilities are satisfied by the given capabilities
    });
  });

  describe('validateConfig', () => {
    beforeEach(() => {
      registry.register(toxicityNode);
    });

    test('validates valid config', () => {
      const result = registry.validateConfig('compute-toxicity', { threshold: 0.8 });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('fails for missing required field', () => {
      const result = registry.validateConfig('compute-toxicity', {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('threshold');
    });

    test('fails for unknown node type', () => {
      const result = registry.validateConfig('unknown', { foo: 'bar' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Unknown node type');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/node-registry.test.ts`
Expected: FAIL — module not found

**Step 3: Implement NodeRegistry**

```typescript
// packages/pipeline-engine/src/pipeline/node-registry.ts
import type { ConfigField, NodeCategory, NodeTypeDefinition } from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Registry of all available node types.
 * Populated at server startup, queried by API and validation.
 */
export class NodeRegistry {
  private nodes: Map<string, NodeTypeDefinition> = new Map();

  register(definition: NodeTypeDefinition): void {
    if (this.nodes.has(definition.type)) {
      throw new Error(`Node type '${definition.type}' is already registered`);
    }
    this.nodes.set(definition.type, definition);
  }

  get(type: string): NodeTypeDefinition | undefined {
    return this.nodes.get(type);
  }

  has(type: string): boolean {
    return this.nodes.has(type);
  }

  list(filters?: { category?: NodeCategory; capabilities?: string[] }): NodeTypeDefinition[] {
    let results = [...this.nodes.values()];

    if (filters?.category) {
      results = results.filter((n) => n.category === filters.category);
    }

    if (filters?.capabilities) {
      results = results.filter((n) => {
        if (!n.requiredCapabilities || n.requiredCapabilities.length === 0) return true;
        return n.requiredCapabilities.every((cap) => filters.capabilities!.includes(cap));
      });
    }

    return results;
  }

  validateConfig(type: string, config: Record<string, any>): ValidationResult {
    const definition = this.nodes.get(type);
    if (!definition) {
      return { valid: false, errors: [`Unknown node type: '${type}'`] };
    }
    return validateAgainstSchema(config, definition.configSchema);
  }
}

function validateAgainstSchema(
  config: Record<string, any>,
  schema: { fields: ConfigField[] },
): ValidationResult {
  const errors: string[] = [];

  for (const field of schema.fields) {
    if (field.required && !(field.name in config) && field.default === undefined) {
      errors.push(`Required field '${field.name}' is missing`);
    }
  }

  return { valid: errors.length === 0, errors };
}
```

**Step 4: Export from index.ts**

Add to `packages/pipeline-engine/src/index.ts`:

```typescript
export { NodeRegistry } from './pipeline/node-registry.js';
export type { ValidationResult } from './pipeline/node-registry.js';
```

**Step 5: Run test to verify it passes**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/node-registry.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/node-registry.ts packages/pipeline-engine/src/__tests__/node-registry.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add NodeRegistry for self-describing node type catalog"
```

---

## Task 3: Auto-Register Existing Activity Types as Nodes

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/register-nodes.ts`
- Create: `packages/pipeline-engine/src/__tests__/register-nodes.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/register-nodes.test.ts
import { describe, test, expect } from 'vitest';
import { NodeRegistry } from '../pipeline/node-registry.js';
import {
  registerAnalyticsNodes,
  registerBuiltinNodes,
  inferCategory,
} from '../pipeline/register-nodes.js';
import { ACTIVITY_TYPES } from '../pipeline/activity-metadata.js';

describe('registerAnalyticsNodes', () => {
  test('registers all existing activity types', () => {
    const registry = new NodeRegistry();
    registerAnalyticsNodes(registry);

    for (const type of Object.keys(ACTIVITY_TYPES)) {
      expect(registry.has(type)).toBe(true);
    }
  });

  test('infers correct categories', () => {
    expect(inferCategory('compute-sentiment')).toBe('compute');
    expect(inferCategory('compute-toxicity')).toBe('compute');
    expect(inferCategory('store-results')).toBe('action');
    expect(inferCategory('store-insight')).toBe('action');
    expect(inferCategory('send-notification')).toBe('action');
    expect(inferCategory('read-conversation')).toBe('data');
    expect(inferCategory('read-message-window')).toBe('data');
    expect(inferCategory('transform')).toBe('data');
    expect(inferCategory('evaluate-metrics')).toBe('compute');
    expect(inferCategory('call-llm')).toBe('compute');
    expect(inferCategory('run-legacy-workflow')).toBe('action');
  });

  test('preserves activity metadata', () => {
    const registry = new NodeRegistry();
    registerAnalyticsNodes(registry);

    const def = registry.get('evaluate-metrics');
    expect(def).toBeDefined();
    expect(def!.label).toBe('Evaluate Metrics');
    expect(def!.defaultTimeout).toBe(120_000);
    expect(def!.defaultRetries).toBe(2);
  });
});

describe('registerBuiltinNodes', () => {
  test('registers logic nodes', () => {
    const registry = new NodeRegistry();
    registerBuiltinNodes(registry);

    expect(registry.has('node-group')).toBe(true);
    expect(registry.has('wait-for-event')).toBe(true);
    expect(registry.has('delay')).toBe(true);
    expect(registry.has('sub-pipeline')).toBe(true);
  });

  test('registers data nodes', () => {
    const registry = new NodeRegistry();
    registerBuiltinNodes(registry);

    expect(registry.has('db-query')).toBe(true);
    expect(registry.has('filter')).toBe(true);
    expect(registry.has('aggregate')).toBe(true);
  });

  test('registers integration nodes', () => {
    const registry = new NodeRegistry();
    registerBuiltinNodes(registry);

    expect(registry.has('http-request')).toBe(true);
    expect(registry.has('send-email')).toBe(true);
    expect(registry.has('send-slack')).toBe(true);
    expect(registry.has('publish-kafka')).toBe(true);
  });

  test('all builtin nodes have configSchema', () => {
    const registry = new NodeRegistry();
    registerBuiltinNodes(registry);

    const all = registry.list();
    for (const def of all) {
      expect(def.configSchema).toBeDefined();
      expect(def.configSchema.fields).toBeDefined();
    }
  });
});

describe('full registry initialization', () => {
  test('analytics + builtin nodes do not conflict', () => {
    const registry = new NodeRegistry();
    registerAnalyticsNodes(registry);
    registerBuiltinNodes(registry);

    // Total = existing activity types + builtin nodes
    const all = registry.list();
    const expectedCount = Object.keys(ACTIVITY_TYPES).length + 8; // 8 builtin: node-group, wait-for-event, delay, sub-pipeline, db-query, filter, aggregate, http-request, send-email, send-slack, publish-kafka
    expect(all.length).toBeGreaterThanOrEqual(Object.keys(ACTIVITY_TYPES).length + 7);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/register-nodes.test.ts`
Expected: FAIL — module not found

**Step 3: Implement register-nodes.ts**

```typescript
// packages/pipeline-engine/src/pipeline/register-nodes.ts
import type { NodeCategory, NodeTypeDefinition } from './types.js';
import { ACTIVITY_TYPES } from './activity-metadata.js';
import type { NodeRegistry } from './node-registry.js';

/**
 * Infer NodeCategory from activity type name.
 */
export function inferCategory(type: string): NodeCategory {
  if (type.startsWith('compute-') || type.startsWith('evaluate-') || type.startsWith('call-'))
    return 'compute';
  if (type.startsWith('store-') || type.startsWith('send-')) return 'action';
  if (type.startsWith('read-') || type === 'transform') return 'data';
  if (type.startsWith('run-')) return 'action';
  if (
    [
      'simulate-persona',
      'execute-agent-turn',
      'run-eval-conversation',
      'judge-conversation',
      'aggregate-eval-run',
    ].includes(type)
  )
    return 'compute';
  return 'compute';
}

/**
 * Auto-register all existing ACTIVITY_TYPES entries as NodeTypeDefinitions.
 */
export function registerAnalyticsNodes(registry: NodeRegistry): void {
  for (const [type, metadata] of Object.entries(ACTIVITY_TYPES)) {
    const fields = Object.entries(metadata.configSchema.properties).map(([name, prop]) => ({
      name,
      type: prop.type as any,
      required: metadata.configSchema.required.includes(name),
      description: prop.description,
    }));

    registry.register({
      type,
      category: inferCategory(type),
      label: metadata.name,
      description: metadata.description,
      configSchema: { fields },
      executionModel: 'sync',
      defaultTimeout: metadata.defaultTimeout,
      defaultRetries: metadata.defaultRetries,
      retryable: true,
    });
  }
}

/**
 * Register built-in logic, data, and integration nodes.
 */
export function registerBuiltinNodes(registry: NodeRegistry): void {
  // Logic nodes
  registry.register({
    type: 'node-group',
    category: 'logic',
    label: 'Parallel Group',
    description:
      'Execute multiple nodes in parallel. All children must complete before transitions are evaluated.',
    configSchema: { fields: [] },
    executionModel: 'control-flow',
  });

  registry.register({
    type: 'wait-for-event',
    category: 'logic',
    label: 'Wait for Event',
    description: 'Pause pipeline execution until an external signal is received.',
    configSchema: {
      fields: [
        {
          name: 'eventName',
          type: 'string',
          required: true,
          description: 'Name of the event to wait for',
        },
        {
          name: 'timeoutMs',
          type: 'number',
          required: false,
          default: 86400000,
          description: 'Max wait time in ms',
          validation: { min: 1000, max: 604800000 },
        },
        {
          name: 'timeoutAction',
          type: 'enum',
          required: false,
          default: 'fail',
          description: 'Action on timeout',
          values: ['fail', 'skip', 'default-value'],
        },
        {
          name: 'defaultValue',
          type: 'object',
          required: false,
          description: 'Output when timeoutAction is default-value',
        },
      ],
    },
    executionModel: 'control-flow',
  });

  registry.register({
    type: 'delay',
    category: 'logic',
    label: 'Delay',
    description: 'Wait for a specified duration. Uses Restate durable sleep.',
    configSchema: {
      fields: [
        {
          name: 'durationMs',
          type: 'number',
          required: true,
          description: 'Duration in ms',
          validation: { min: 1000, max: 86400000 },
        },
      ],
    },
    executionModel: 'control-flow',
  });

  registry.register({
    type: 'sub-pipeline',
    category: 'logic',
    label: 'Sub-Pipeline',
    description: 'Execute another pipeline as a node.',
    configSchema: {
      fields: [
        {
          name: 'pipelineId',
          type: 'string',
          required: true,
          description: 'ID of the pipeline to execute',
        },
        {
          name: 'inputMapping',
          type: 'object',
          required: false,
          description: 'Map context fields to sub-pipeline input',
        },
      ],
    },
    executionModel: 'control-flow',
  });

  // Data nodes
  registry.register({
    type: 'db-query',
    category: 'data',
    label: 'Database Query',
    description: 'Execute a query against ClickHouse or MongoDB.',
    configSchema: {
      fields: [
        {
          name: 'database',
          type: 'enum',
          required: true,
          description: 'Database type',
          values: ['clickhouse', 'mongodb'],
        },
        {
          name: 'query',
          type: 'string',
          required: true,
          description: 'Query string with {{variable}} support',
        },
        {
          name: 'collection',
          type: 'string',
          required: false,
          description: 'MongoDB collection (required for mongodb)',
        },
        {
          name: 'limit',
          type: 'number',
          required: false,
          default: 1000,
          description: 'Max results',
          validation: { min: 1, max: 10000 },
        },
      ],
    },
    executionModel: 'sync',
    requiredCapabilities: ['database-access'],
  });

  registry.register({
    type: 'filter',
    category: 'data',
    label: 'Filter',
    description: 'Filter an array from a previous node using an expression.',
    configSchema: {
      fields: [
        { name: 'source', type: 'string', required: true, description: 'Path to array to filter' },
        {
          name: 'expression',
          type: 'string',
          required: true,
          description: 'Filter expression per item',
        },
      ],
    },
    executionModel: 'sync',
  });

  registry.register({
    type: 'aggregate',
    category: 'data',
    label: 'Aggregate',
    description: 'Aggregate values from previous node outputs.',
    configSchema: {
      fields: [
        {
          name: 'source',
          type: 'string',
          required: true,
          description: 'Path to array to aggregate',
        },
        {
          name: 'operations',
          type: 'array',
          required: true,
          description: 'Aggregation operations (count, sum, avg, min, max)',
        },
      ],
    },
    executionModel: 'sync',
  });

  // Integration nodes
  registry.register({
    type: 'http-request',
    category: 'integration',
    label: 'HTTP Request',
    description: 'Make an HTTP request to an external API.',
    configSchema: {
      fields: [
        {
          name: 'url',
          type: 'string',
          required: true,
          description: 'URL with {{variable}} support',
        },
        {
          name: 'method',
          type: 'enum',
          required: true,
          default: 'GET',
          description: 'HTTP method',
          values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        },
        { name: 'headers', type: 'object', required: false, description: 'Request headers' },
        { name: 'body', type: 'string', required: false, description: 'Request body template' },
        {
          name: 'timeoutMs',
          type: 'number',
          required: false,
          default: 30000,
          description: 'Request timeout',
          validation: { min: 1000, max: 120000 },
        },
      ],
    },
    executionModel: 'async',
    retryable: true,
    defaultTimeout: 30_000,
    defaultRetries: 3,
    requiredCapabilities: ['external-http'],
  });

  registry.register({
    type: 'send-email',
    category: 'integration',
    label: 'Send Email',
    description: 'Send an email via the platform email service.',
    configSchema: {
      fields: [
        { name: 'to', type: 'string', required: true, description: 'Recipient email' },
        { name: 'subject', type: 'string', required: true, description: 'Email subject' },
        { name: 'body', type: 'string', required: true, description: 'Email body (HTML)' },
      ],
    },
    executionModel: 'async',
    retryable: true,
    defaultRetries: 2,
    requiredCapabilities: ['email-send'],
  });

  registry.register({
    type: 'send-slack',
    category: 'integration',
    label: 'Send Slack Message',
    description: 'Send a Slack message via webhook or API.',
    configSchema: {
      fields: [
        { name: 'channel', type: 'string', required: true, description: 'Slack channel' },
        { name: 'message', type: 'string', required: true, description: 'Message text' },
        { name: 'webhookUrl', type: 'string', required: false, description: 'Slack webhook URL' },
      ],
    },
    executionModel: 'async',
    retryable: true,
    defaultRetries: 2,
    requiredCapabilities: ['slack-integration'],
  });

  registry.register({
    type: 'publish-kafka',
    category: 'integration',
    label: 'Publish to Kafka',
    description: 'Publish an event to a Kafka topic.',
    configSchema: {
      fields: [
        { name: 'topic', type: 'string', required: true, description: 'Kafka topic' },
        { name: 'key', type: 'string', required: false, description: 'Message key' },
        { name: 'payload', type: 'object', required: true, description: 'Message payload' },
      ],
    },
    executionModel: 'async',
    retryable: true,
    defaultRetries: 3,
  });
}
```

**Step 4: Export from index.ts**

Add to `packages/pipeline-engine/src/index.ts`:

```typescript
export {
  registerAnalyticsNodes,
  registerBuiltinNodes,
  inferCategory,
} from './pipeline/register-nodes.js';
```

**Step 5: Run test to verify it passes**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/register-nodes.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/register-nodes.ts packages/pipeline-engine/src/__tests__/register-nodes.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): auto-register existing activities + builtin nodes in NodeRegistry"
```

---

## Task 4: Graph Utilities — Conversion, Reachability, Back-Edge Detection

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/graph-utils.ts`
- Create: `packages/pipeline-engine/src/__tests__/graph-utils.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/graph-utils.test.ts
import { describe, test, expect } from 'vitest';
import {
  stepsToGraph,
  findReachableNodes,
  detectBackEdges,
  resolveTransition,
} from '../pipeline/graph-utils.js';
import type { PipelineStep, PipelineNode, NodeTransition, StepOutput } from '../pipeline/types.js';

describe('stepsToGraph', () => {
  test('converts sequential steps to nodes with transitions', () => {
    const steps: PipelineStep[] = [
      { id: 'a', type: 'compute-sentiment', config: {} },
      { id: 'b', type: 'store-insight', config: {} },
    ];
    const { nodes, entryNodeId } = stepsToGraph(steps);
    expect(entryNodeId).toBe('a');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].transitions).toEqual([{ target: 'b' }]);
    expect(nodes[1].transitions).toEqual([]);
  });

  test('converts parallel group to node-group', () => {
    const steps: PipelineStep[] = [
      { id: 'a', type: 'compute-sentiment', parallel: 'g1', config: {} },
      { id: 'b', type: 'compute-toxicity', parallel: 'g1', config: {} },
      { id: 'c', type: 'store-insight', config: {} },
    ];
    const { nodes, entryNodeId } = stepsToGraph(steps);
    expect(entryNodeId).toBe('group-g1');
    expect(nodes).toHaveLength(2); // group + store
    expect(nodes[0].type).toBe('node-group');
    expect(nodes[0].children).toHaveLength(2);
    expect(nodes[0].transitions).toEqual([{ target: 'c' }]);
  });

  test('handles empty steps', () => {
    const { nodes, entryNodeId } = stepsToGraph([]);
    expect(nodes).toHaveLength(0);
    expect(entryNodeId).toBe('');
  });
});

describe('findReachableNodes', () => {
  test('finds all reachable nodes in linear graph', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 't', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 't', config: {}, transitions: [{ target: 'c' }] },
      { id: 'c', type: 't', config: {}, transitions: [] },
    ];
    const reachable = findReachableNodes(nodes, 'a');
    expect(reachable).toEqual(new Set(['a', 'b', 'c']));
  });

  test('detects orphan nodes', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 't', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 't', config: {}, transitions: [] },
      { id: 'orphan', type: 't', config: {}, transitions: [] },
    ];
    const reachable = findReachableNodes(nodes, 'a');
    expect(reachable.has('orphan')).toBe(false);
  });

  test('handles branching', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 't', config: {}, transitions: [{ target: 'b' }, { target: 'c' }] },
      { id: 'b', type: 't', config: {}, transitions: [{ target: 'd' }] },
      { id: 'c', type: 't', config: {}, transitions: [{ target: 'd' }] },
      { id: 'd', type: 't', config: {}, transitions: [] },
    ];
    const reachable = findReachableNodes(nodes, 'a');
    expect(reachable).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  test('includes node-group children', () => {
    const nodes: PipelineNode[] = [
      {
        id: 'group',
        type: 'node-group',
        config: {},
        children: [
          { id: 'child1', type: 't', config: {} },
          { id: 'child2', type: 't', config: {} },
        ],
        transitions: [],
      },
    ];
    const reachable = findReachableNodes(nodes, 'group');
    expect(reachable.has('child1')).toBe(true);
    expect(reachable.has('child2')).toBe(true);
  });
});

describe('detectBackEdges', () => {
  test('detects no back-edges in linear graph', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 't', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 't', config: {}, transitions: [] },
    ];
    expect(detectBackEdges(nodes, 'a')).toHaveLength(0);
  });

  test('detects back-edge in loop', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 't', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 't', config: {}, transitions: [{ target: 'a' }] },
    ];
    const backEdges = detectBackEdges(nodes, 'a');
    expect(backEdges).toHaveLength(1);
    expect(backEdges[0]).toEqual({ from: 'b', to: 'a' });
  });

  test('detects back-edge in self-loop', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 't', config: {}, transitions: [{ target: 'a' }] },
    ];
    const backEdges = detectBackEdges(nodes, 'a');
    expect(backEdges).toHaveLength(1);
  });
});

describe('resolveTransition', () => {
  const successOutput: StepOutput = { status: 'success', data: { score: 0.9, status: 'FAIL' } };
  const context = { input: {}, nodeOutputs: {} };

  test('returns default transition when no conditions', () => {
    const transitions: NodeTransition[] = [{ target: 'next' }];
    expect(resolveTransition(transitions, successOutput, context)).toBe('next');
  });

  test('returns null for empty transitions', () => {
    expect(resolveTransition([], successOutput, context)).toBeNull();
  });

  test('evaluates conditions in order', () => {
    const transitions: NodeTransition[] = [
      { target: 'alert', condition: 'output.score > 0.7', order: 1 },
      { target: 'store', order: 2 },
    ];
    expect(resolveTransition(transitions, successOutput, context)).toBe('alert');
  });

  test('falls through to default when condition false', () => {
    const transitions: NodeTransition[] = [
      { target: 'alert', condition: 'output.score < 0.5', order: 1 },
      { target: 'store', order: 2 },
    ];
    expect(resolveTransition(transitions, successOutput, context)).toBe('store');
  });

  test('returns null when no condition matches and no default', () => {
    const transitions: NodeTransition[] = [
      { target: 'alert', condition: 'output.score < 0.1', order: 1 },
    ];
    expect(resolveTransition(transitions, successOutput, context)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/graph-utils.test.ts`
Expected: FAIL — module not found

**Step 3: Implement graph-utils.ts**

```typescript
// packages/pipeline-engine/src/pipeline/graph-utils.ts
import type {
  PipelineNode,
  PipelineStep,
  NodeTransition,
  StepOutput,
  GroupChildNode,
} from './types.js';

/**
 * Expression evaluator for transition conditions.
 * Supports: output.*, context.nodeOutputs.*, input.*
 * Uses the same safe expression evaluator but with different variable roots.
 */
function evaluateTransitionCondition(
  condition: string,
  output: Record<string, any>,
  context: { input: Record<string, any>; nodeOutputs: Record<string, StepOutput> },
): boolean {
  try {
    // Build a variable map for the expression evaluator
    // Transition expressions use: output.*, context.*, input.*
    const vars: Record<string, any> = {
      output,
      context: context.nodeOutputs,
      input: context.input,
    };

    // Simple expression evaluator supporting dot access, comparisons, logical ops
    return evalSimple(condition, vars);
  } catch {
    return false;
  }
}

/**
 * Minimal safe expression evaluator for transition conditions.
 * Supports: ==, !=, >, <, >=, <=, &&, ||, !, dot-path access, literals.
 */
function evalSimple(expr: string, vars: Record<string, any>): boolean {
  const trimmed = expr.trim();

  // Handle logical AND
  if (trimmed.includes('&&')) {
    const parts = splitTopLevel(trimmed, '&&');
    return parts.every((p) => evalSimple(p, vars));
  }

  // Handle logical OR
  if (trimmed.includes('||')) {
    const parts = splitTopLevel(trimmed, '||');
    return parts.some((p) => evalSimple(p, vars));
  }

  // Handle NOT
  if (trimmed.startsWith('!')) {
    return !evalSimple(trimmed.slice(1), vars);
  }

  // Handle comparisons
  for (const op of ['!=', '==', '>=', '<=', '>', '<'] as const) {
    const idx = trimmed.indexOf(op);
    if (idx !== -1) {
      // Make sure we're not matching a substring of another operator
      const left = resolveValue(trimmed.slice(0, idx).trim(), vars);
      const right = resolveValue(trimmed.slice(idx + op.length).trim(), vars);
      switch (op) {
        case '==':
          return left == right;
        case '!=':
          return left != right;
        case '>':
          return (left as number) > (right as number);
        case '<':
          return (left as number) < (right as number);
        case '>=':
          return (left as number) >= (right as number);
        case '<=':
          return (left as number) <= (right as number);
      }
    }
  }

  // Boolean literal or truthy check
  const val = resolveValue(trimmed, vars);
  return Boolean(val);
}

function splitTopLevel(expr: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    if (expr[i] === ')') depth--;
    if (depth === 0 && expr.substring(i, i + delimiter.length) === delimiter) {
      parts.push(current);
      current = '';
      i += delimiter.length - 1;
      continue;
    }
    current += expr[i];
  }
  parts.push(current);
  return parts;
}

function resolveValue(token: string, vars: Record<string, any>): unknown {
  const t = token.trim();

  // String literal
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return parseFloat(t);
  }

  // Boolean literal
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;

  // Dot-path resolution
  const parts = t.split('.');
  let current: any = vars;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

// ── Public API ──

/**
 * Resolve the next node by evaluating transitions in order.
 * Returns the target node ID of the first matching transition, or null.
 */
export function resolveTransition(
  transitions: NodeTransition[],
  output: StepOutput,
  context: { input: Record<string, any>; nodeOutputs: Record<string, StepOutput> },
): string | null {
  if (!transitions || transitions.length === 0) return null;

  const sorted = [...transitions].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

  for (const t of sorted) {
    if (!t.condition) {
      return t.target; // default/fallback
    }
    if (evaluateTransitionCondition(t.condition, output.data, context)) {
      return t.target;
    }
  }

  return null;
}

/**
 * Convert legacy steps[] to graph nodes with transitions.
 */
export function stepsToGraph(steps: PipelineStep[]): {
  nodes: PipelineNode[];
  entryNodeId: string;
} {
  if (!steps || steps.length === 0) {
    return { nodes: [], entryNodeId: '' };
  }

  const nodes: PipelineNode[] = [];
  let i = 0;

  while (i < steps.length) {
    const step = steps[i];

    if (step.parallel) {
      const groupTag = step.parallel;
      const children: GroupChildNode[] = [];

      while (i < steps.length && steps[i].parallel === groupTag) {
        children.push({
          id: steps[i].id,
          type: steps[i].activity ?? steps[i].type ?? 'unknown',
          label: steps[i].name,
          config: steps[i].config ?? {},
          timeout: steps[i].timeout,
          retries: steps[i].retries,
          onFailure: steps[i].onFailure,
        });
        i++;
      }

      nodes.push({
        id: `group-${groupTag}`,
        type: 'node-group',
        label: `Parallel: ${groupTag}`,
        config: {},
        children,
        transitions: [],
      });
    } else {
      nodes.push({
        id: step.id,
        type: step.activity ?? step.type ?? 'unknown',
        label: step.name,
        config: step.config ?? {},
        transitions: [],
        timeout: step.timeout,
        retries: step.retries,
        onFailure: step.onFailure,
        maxVisits: 1,
      });
      i++;
    }
  }

  // Wire sequential transitions
  for (let j = 0; j < nodes.length - 1; j++) {
    nodes[j].transitions = [{ target: nodes[j + 1].id }];
  }

  return { nodes, entryNodeId: nodes[0].id };
}

/**
 * Find all nodes reachable from entry via BFS.
 */
export function findReachableNodes(nodes: PipelineNode[], entryNodeId: string): Set<string> {
  const reachable = new Set<string>();
  const queue = [entryNodeId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) continue;

    for (const t of node.transitions) {
      if (!reachable.has(t.target)) {
        queue.push(t.target);
      }
    }

    if (node.children) {
      for (const child of node.children) {
        reachable.add(child.id);
      }
    }
  }

  return reachable;
}

/**
 * Detect back-edges (loops) in the graph via DFS.
 */
export function detectBackEdges(
  nodes: PipelineNode[],
  entryNodeId: string,
): Array<{ from: string; to: string }> {
  const backEdges: Array<{ from: string; to: string }> = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  function dfs(nodeId: string) {
    visited.add(nodeId);
    inStack.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    for (const t of node.transitions) {
      if (inStack.has(t.target)) {
        backEdges.push({ from: nodeId, to: t.target });
      } else if (!visited.has(t.target)) {
        dfs(t.target);
      }
    }

    inStack.delete(nodeId);
  }

  dfs(entryNodeId);
  return backEdges;
}
```

**Step 4: Export from index.ts**

Add to `packages/pipeline-engine/src/index.ts`:

```typescript
export {
  stepsToGraph,
  findReachableNodes,
  detectBackEdges,
  resolveTransition,
} from './pipeline/graph-utils.js';
```

**Step 5: Run test to verify it passes**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/graph-utils.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/graph-utils.ts packages/pipeline-engine/src/__tests__/graph-utils.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add graph utilities — steps-to-graph conversion, reachability, back-edge detection, transition resolution"
```

---

## Task 5: Graph-Based Pipeline Validation

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/validation.ts`
- Create: `packages/pipeline-engine/src/__tests__/graph-validation.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/graph-validation.test.ts
import { describe, test, expect } from 'vitest';
import { validateGraphPipeline } from '../pipeline/validation.js';
import { NodeRegistry } from '../pipeline/node-registry.js';
import { registerAnalyticsNodes, registerBuiltinNodes } from '../pipeline/register-nodes.js';
import type { PipelineDefinition, PipelineNode } from '../pipeline/types.js';

function createRegistry(): NodeRegistry {
  const r = new NodeRegistry();
  registerAnalyticsNodes(r);
  registerBuiltinNodes(r);
  return r;
}

function makePipeline(nodes: PipelineNode[], entryNodeId: string): PipelineDefinition {
  return {
    _id: 'test',
    tenantId: 't1',
    name: 'Test',
    version: 1,
    status: 'draft',
    nodes,
    entryNodeId,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('validateGraphPipeline', () => {
  const registry = createRegistry();

  test('valid linear pipeline passes', () => {
    const pipeline = makePipeline(
      [
        { id: 'a', type: 'compute-sentiment', config: {}, transitions: [{ target: 'b' }] },
        { id: 'b', type: 'store-insight', config: {}, transitions: [] },
      ],
      'a',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.errors).toHaveLength(0);
  });

  test('missing entry node', () => {
    const pipeline = makePipeline(
      [{ id: 'a', type: 'compute-sentiment', config: {}, transitions: [] }],
      'missing',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.errors.some((e) => e.message.includes('Entry node'))).toBe(true);
  });

  test('unknown node type', () => {
    const pipeline = makePipeline(
      [{ id: 'a', type: 'totally-fake', config: {}, transitions: [] }],
      'a',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.errors.some((e) => e.message.includes('Unknown node type'))).toBe(true);
  });

  test('dangling transition target', () => {
    const pipeline = makePipeline(
      [{ id: 'a', type: 'compute-sentiment', config: {}, transitions: [{ target: 'nowhere' }] }],
      'a',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.errors.some((e) => e.message.includes('not found'))).toBe(true);
  });

  test('duplicate node IDs', () => {
    const pipeline = makePipeline(
      [
        { id: 'a', type: 'compute-sentiment', config: {}, transitions: [{ target: 'a' }] },
        { id: 'a', type: 'store-insight', config: {}, transitions: [] },
      ],
      'a',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.errors.some((e) => e.message.includes('Duplicate'))).toBe(true);
  });

  test('orphan node warning', () => {
    const pipeline = makePipeline(
      [
        { id: 'a', type: 'compute-sentiment', config: {}, transitions: [] },
        { id: 'orphan', type: 'store-insight', config: {}, transitions: [] },
      ],
      'a',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.warnings?.some((w) => w.includes('unreachable'))).toBe(true);
  });

  test('back-edge without maxVisits warning', () => {
    const pipeline = makePipeline(
      [
        { id: 'a', type: 'compute-sentiment', config: {}, transitions: [{ target: 'b' }] },
        { id: 'b', type: 'store-insight', config: {}, transitions: [{ target: 'a' }] },
      ],
      'a',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.warnings?.some((w) => w.includes('maxVisits'))).toBe(true);
  });

  test('node-group children validated', () => {
    const pipeline = makePipeline(
      [
        {
          id: 'group',
          type: 'node-group',
          config: {},
          children: [{ id: 'c1', type: 'fake-type', config: {} }],
          transitions: [],
        },
      ],
      'group',
    );
    const result = validateGraphPipeline(pipeline, registry);
    expect(result.errors.some((e) => e.message.includes('Unknown node type'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/graph-validation.test.ts`
Expected: FAIL — `validateGraphPipeline` not exported

**Step 3: Add validateGraphPipeline to validation.ts**

Add the following function to `packages/pipeline-engine/src/pipeline/validation.ts`:

```typescript
import { NodeRegistry } from './node-registry.js';
import { findReachableNodes, detectBackEdges } from './graph-utils.js';
import type { PipelineNode } from './types.js';

export interface GraphValidationResult {
  errors: ValidationError[];
  warnings?: string[];
}

/**
 * Validate a graph-based pipeline definition.
 * Checks node types, configs, transitions, orphans, back-edges.
 */
export function validateGraphPipeline(
  definition: PipelineDefinition,
  registry: NodeRegistry,
): GraphValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const nodes = definition.nodes ?? [];
  const nodeIds = new Set<string>();
  const duplicateIds = new Set<string>();

  // 1. Check for duplicate node IDs
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      duplicateIds.add(node.id);
      errors.push({
        stepId: node.id,
        field: 'id',
        message: `Duplicate node ID: '${node.id}'`,
      });
    }
    nodeIds.add(node.id);
  }

  // 2. Entry node exists
  if (definition.entryNodeId && !nodeIds.has(definition.entryNodeId)) {
    errors.push({
      field: 'entryNodeId',
      message: `Entry node '${definition.entryNodeId}' not found in nodes`,
    });
  }

  // 3. Validate each node
  for (const node of nodes) {
    // 3a. Node type exists
    if (!registry.has(node.type)) {
      errors.push({
        stepId: node.id,
        field: 'type',
        message: `Unknown node type: '${node.type}'`,
      });
    }

    // 3b. Config validation
    if (registry.has(node.type)) {
      const configResult = registry.validateConfig(node.type, node.config);
      if (!configResult.valid) {
        for (const err of configResult.errors) {
          errors.push({
            stepId: node.id,
            field: 'config',
            message: err,
          });
        }
      }
    }

    // 3c. Transition targets exist
    for (const t of node.transitions) {
      if (!nodeIds.has(t.target)) {
        errors.push({
          stepId: node.id,
          field: 'transitions',
          message: `Transition target '${t.target}' not found in nodes`,
        });
      }
    }

    // 3d. Node-group children
    if (node.type === 'node-group' && node.children) {
      for (const child of node.children) {
        if (!registry.has(child.type)) {
          errors.push({
            stepId: child.id,
            field: 'type',
            message: `Unknown node type: '${child.type}' in group '${node.id}'`,
          });
        }
      }
    }
  }

  // 4. Orphan detection
  if (definition.entryNodeId && nodeIds.has(definition.entryNodeId)) {
    const reachable = findReachableNodes(nodes, definition.entryNodeId);
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        warnings.push(`Node '${node.id}' is unreachable from entry node`);
      }
    }
  }

  // 5. Back-edge detection
  if (definition.entryNodeId && nodeIds.has(definition.entryNodeId)) {
    const backEdges = detectBackEdges(nodes, definition.entryNodeId);
    for (const { from, to } of backEdges) {
      const targetNode = nodes.find((n) => n.id === to);
      if (targetNode && (!targetNode.maxVisits || targetNode.maxVisits <= 1)) {
        warnings.push(
          `Node '${to}' is a back-edge target from '${from}' but maxVisits is 1. Set maxVisits > 1 to enable looping.`,
        );
      }
    }
  }

  return {
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
```

**Step 4: Export from index.ts**

Add to `packages/pipeline-engine/src/index.ts`:

```typescript
export { validateGraphPipeline } from './pipeline/validation.js';
export type { GraphValidationResult } from './pipeline/validation.js';
```

**Step 5: Run test to verify it passes**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/graph-validation.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/validation.ts packages/pipeline-engine/src/__tests__/graph-validation.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add graph-based pipeline validation with orphan and back-edge detection"
```

---

## Task 6: Graph Walker — PipelineRun Workflow Extension

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts`
- Create: `packages/pipeline-engine/src/__tests__/graph-walker.test.ts`

**This is the largest task.** The graph walker replaces the step-array loop with a node-following traversal. The existing `run` handler must detect whether the pipeline uses `nodes` (graph) or `steps` (legacy) and dispatch accordingly.

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/graph-walker.test.ts
import { describe, test, expect } from 'vitest';
import { walkGraph } from '../pipeline/graph-walker.js';
import type { PipelineNode, StepOutput } from '../pipeline/types.js';

// Mock node executor — returns success with the node's config as output
async function mockExecuteNode(
  nodeId: string,
  nodeType: string,
  config: Record<string, any>,
): Promise<StepOutput> {
  return { status: 'success', data: { ...config, nodeId } };
}

describe('walkGraph', () => {
  test('walks linear graph A -> B -> C', async () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: { val: 1 }, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'compute', config: { val: 2 }, transitions: [{ target: 'c' }] },
      { id: 'c', type: 'compute', config: { val: 3 }, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'a', {}, mockExecuteNode);
    expect(Object.keys(result.nodeOutputs)).toEqual(['a', 'b', 'c']);
    expect(result.status).toBe('completed');
  });

  test('follows conditional transition', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'check',
        type: 'compute',
        config: { score: 0.9 },
        transitions: [
          { target: 'alert', condition: 'output.score > 0.7', order: 1 },
          { target: 'store', order: 2 },
        ],
      },
      { id: 'alert', type: 'compute', config: {}, transitions: [] },
      { id: 'store', type: 'compute', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'check', {}, mockExecuteNode);
    expect(result.nodeOutputs['alert']).toBeDefined();
    expect(result.nodeOutputs['store']).toBeUndefined();
  });

  test('follows default transition when condition is false', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'check',
        type: 'compute',
        config: { score: 0.3 },
        transitions: [
          { target: 'alert', condition: 'output.score > 0.7', order: 1 },
          { target: 'store', order: 2 },
        ],
      },
      { id: 'alert', type: 'compute', config: {}, transitions: [] },
      { id: 'store', type: 'compute', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'check', {}, mockExecuteNode);
    expect(result.nodeOutputs['store']).toBeDefined();
    expect(result.nodeOutputs['alert']).toBeUndefined();
  });

  test('respects maxVisits for loops', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'compute',
        config: { val: 1 },
        maxVisits: 3,
        transitions: [{ target: 'a' }],
      },
    ];

    const result = await walkGraph(nodes, 'a', {}, mockExecuteNode);
    expect(result.visitCounts['a']).toBe(3);
  });

  test('stops on node failure with stop strategy', async () => {
    const failExecutor = async (id: string) => {
      if (id === 'b') return { status: 'fail' as const, data: { error: 'boom' } };
      return { status: 'success' as const, data: {} };
    };

    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'compute', config: {}, onFailure: 'stop', transitions: [{ target: 'c' }] },
      { id: 'c', type: 'compute', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'a', {}, failExecutor);
    expect(result.nodeOutputs['b'].status).toBe('fail');
    expect(result.nodeOutputs['c']).toBeUndefined();
    expect(result.status).toBe('failed');
  });

  test('terminal node ends path', async () => {
    const nodes: PipelineNode[] = [{ id: 'a', type: 'compute', config: {}, transitions: [] }];

    const result = await walkGraph(nodes, 'a', {}, mockExecuteNode);
    expect(result.status).toBe('completed');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/graph-walker.test.ts`
Expected: FAIL — module not found

**Step 3: Implement graph-walker.ts**

```typescript
// packages/pipeline-engine/src/pipeline/graph-walker.ts
import type { PipelineNode, StepOutput } from './types.js';
import { resolveTransition } from './graph-utils.js';

export type NodeExecutorFn = (
  nodeId: string,
  nodeType: string,
  config: Record<string, any>,
) => Promise<StepOutput>;

export interface GraphWalkResult {
  status: 'completed' | 'failed';
  nodeOutputs: Record<string, StepOutput>;
  visitCounts: Record<string, number>;
}

const DEFAULT_MAX_VISITS = 1;
const HARD_MAX_VISITS = 100;

/**
 * Walk a pipeline graph from entryNodeId, following transitions.
 * Pure function — no Restate dependency. Delegates node execution to the provided executor.
 */
export async function walkGraph(
  nodes: PipelineNode[],
  entryNodeId: string,
  pipelineInput: Record<string, any>,
  executeNode: NodeExecutorFn,
  options?: {
    defaultOnFailure?: 'stop' | 'skip' | 'continue';
    maxVisitsHardCap?: number;
  },
): Promise<GraphWalkResult> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const nodeOutputs: Record<string, StepOutput> = {};
  const visitCounts: Record<string, number> = {};
  const hardCap = options?.maxVisitsHardCap ?? HARD_MAX_VISITS;

  let currentNodeId: string | null = entryNodeId;

  while (currentNodeId) {
    const node = nodeMap.get(currentNodeId);
    if (!node) break;

    // Loop guard
    visitCounts[node.id] = (visitCounts[node.id] ?? 0) + 1;
    const maxVisits = Math.min(node.maxVisits ?? DEFAULT_MAX_VISITS, hardCap);

    if (visitCounts[node.id] > maxVisits) {
      nodeOutputs[node.id] = {
        status: 'fail',
        data: { error: `Max visits (${maxVisits}) exceeded for node '${node.id}'` },
      };
      break;
    }

    // Execute node
    const output = await executeNode(node.id, node.type, node.config);
    nodeOutputs[node.id] = output;

    // Handle failure
    if (output.status === 'fail') {
      const failStrategy = node.onFailure ?? options?.defaultOnFailure ?? 'stop';
      if (failStrategy === 'stop') {
        break;
      }
    }

    // Resolve next node
    const context = { input: pipelineInput, nodeOutputs };
    currentNodeId = resolveTransition(node.transitions, output, context);
  }

  const hasFailure = Object.values(nodeOutputs).some((o) => o.status === 'fail');
  return {
    status: hasFailure ? 'failed' : 'completed',
    nodeOutputs,
    visitCounts,
  };
}
```

**Step 4: Export from index.ts**

Add to `packages/pipeline-engine/src/index.ts`:

```typescript
export { walkGraph } from './pipeline/graph-walker.js';
export type { GraphWalkResult, NodeExecutorFn } from './pipeline/graph-walker.js';
```

**Step 5: Run test to verify it passes**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/graph-walker.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/graph-walker.ts packages/pipeline-engine/src/__tests__/graph-walker.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add graph walker for node-based pipeline execution"
```

---

## Task 7: Integrate Graph Walker into PipelineRun Workflow

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts`

**Step 1: Read the current pipeline-run.workflow.ts in full**

Already read. The key change: add a branch at the top of the `run` handler that checks whether the pipeline uses `nodes` (graph mode) or `steps` (legacy mode).

**Step 2: Modify the run handler**

At the top of the `run` handler in `pipeline-run.workflow.ts`, add graph-mode detection:

```typescript
// At the top of the run handler, after extracting steps:
const steps = input.steps ?? pipelineDefinition.steps ?? [];
const hasGraphNodes =
  pipelineDefinition.nodes && pipelineDefinition.nodes.length > 0 && pipelineDefinition.entryNodeId;

if (hasGraphNodes) {
  // Graph mode — use graph walker
  return await runGraphMode(ctx, input);
}

// Legacy mode — existing step-array loop continues below unchanged
```

Add the `runGraphMode` function that uses `stepsToGraph` for any needed conversion and delegates to the graph walker pattern, but wired into Restate's durable execution:

```typescript
import { stepsToGraph, resolveTransition } from '../graph-utils.js';
```

The `runGraphMode` function follows the same graph-walking pattern as `graph-walker.ts` but uses `ctx.serviceClient(activityRouter).execute(...)` for durable node execution, `ctx.set()` for state tracking, and `ctx.run()` for timestamping — matching the existing Restate patterns.

**Step 3: Run existing pipeline-run tests to verify no regression**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/pipeline-run.test.ts`
Expected: PASS (existing tests use `steps[]` format, which should continue to work)

**Step 4: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts
git commit -m "feat(pipeline-engine): integrate graph walker into PipelineRun — dual-mode support for nodes and steps"
```

---

## Task 8: Node-Group Execution in Activity Router

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`

**Step 1: Add node-group handling**

Add `node-group` to the `SERVICE_HANDLERS` dispatch table, or handle it specially in the `execute` handler before dispatching. Node groups execute their children in parallel via the same `activityRouter` recursion.

The activity router's `execute` handler should check: if `step.type === 'node-group'` and `step.children`, fan out children via `CombineablePromise.all` using recursive `activityRouter.execute()` calls.

**Step 2: Run existing tests**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/activity-router.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts
git commit -m "feat(pipeline-engine): add node-group parallel execution to ActivityRouter"
```

---

## Task 9: Pipeline Definition Schema Update

**Files:**

- Modify: `packages/pipeline-engine/src/schemas/pipeline-definition.schema.ts`

**Step 1: Add nodes and entryNodeId to Mongoose schema**

Add `nodes` (Mixed array), `entryNodeId` (String), and `onNodeFailure` (String enum) fields to the existing `PipelineDefinitionModel` Mongoose schema. Use `Schema.Types.Mixed` for nodes since the structure is validated at the application layer via `validateGraphPipeline`.

**Step 2: Run existing tests**

Run: `cd packages/pipeline-engine && pnpm test`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/pipeline-engine/src/schemas/pipeline-definition.schema.ts
git commit -m "feat(pipeline-engine): add nodes/entryNodeId fields to pipeline definition schema"
```

---

## Task 10: Pipeline Node Catalog API

**Files:**

- Create: `apps/studio/src/app/api/pipelines/nodes/route.ts`

**Step 1: Implement the catalog endpoint**

Create a Next.js API route that initializes the `NodeRegistry`, registers all nodes, and returns the list filtered by query params.

```
GET /api/pipelines/nodes
  ?category=compute
  Response: { success: true, data: NodeTypeDefinition[] }

GET /api/pipelines/nodes/:type
  Response: { success: true, data: NodeTypeDefinition }
```

**Step 2: Test manually or add an API test**

Run: `curl http://localhost:5173/api/pipelines/nodes | jq '.data | length'`
Expected: Number >= 25 (21 analytics + builtin nodes)

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/pipelines/nodes/
git commit -m "feat(studio): add pipeline node catalog API — lists available node types with configSchemas"
```

---

## Task 11: Update Studio Pipeline CRUD to Accept Graph Format

**Files:**

- Modify: `apps/studio/src/app/api/pipelines/route.ts`
- Modify: `apps/studio/src/app/api/pipelines/[pipelineId]/route.ts`

**Step 1: Update POST /api/pipelines**

Accept `nodes`, `entryNodeId` in the request body. Run `validateGraphPipeline` if nodes are present. Save to MongoDB.

**Step 2: Update PATCH /api/pipelines/:id**

Accept graph fields in updates. Re-validate on update.

**Step 3: Test**

Run: `cd packages/pipeline-engine && pnpm test`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/pipelines/
git commit -m "feat(studio): accept graph-based pipeline definitions in CRUD API with validation"
```

---

## Task 12: Resume API for Paused Pipelines

**Files:**

- Create: `apps/studio/src/app/api/pipelines/runs/[runId]/events/[eventName]/route.ts`

**Step 1: Implement the resume endpoint**

```
POST /api/pipelines/runs/:runId/events/:eventName
Body: { ...payload }
```

Uses the Restate client to resolve the durable promise:

```typescript
const client = getRestateClient();
await client.workflow(PipelineRun).resolve(runId, eventName, body);
```

**Step 2: Commit**

```bash
git add apps/studio/src/app/api/pipelines/runs/
git commit -m "feat(studio): add pipeline resume API for wait-for-event nodes"
```

---

## Task 13: Wait-For-Event and Delay Handlers

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`

**Step 1: Add wait-for-event handler**

In the activity router, handle `wait-for-event` type by creating a Restate durable promise and awaiting it:

```typescript
if (activityType === 'wait-for-event') {
  const promise = ctx.promise(config.eventName);
  const data = await promise.get(); // suspends here
  return { status: 'success', data };
}
```

Note: The timeout and timeoutAction logic wraps this with a Restate `ctx.sleep()` race.

**Step 2: Add delay handler**

```typescript
if (activityType === 'delay') {
  await ctx.sleep(config.durationMs);
  return { status: 'success', data: { delayed: config.durationMs } };
}
```

**Step 3: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts
git commit -m "feat(pipeline-engine): add wait-for-event and delay control-flow handlers"
```

---

## Task 14: Integration Node Handlers — HTTP Request

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/http-request.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/http-request.test.ts`

**Step 1: Write the failing test**

Test that the service makes an HTTP request with the configured method, URL, headers, body, and returns the response.

**Step 2: Implement the service**

Use Node.js `fetch()` inside a `ctx.run()` block for Restate durability. Apply template substitution for `{{variable}}` patterns in URL, headers, and body.

**Step 3: Register in activity router**

Add `'http-request'` to the `SERVICE_HANDLERS` dispatch table.

**Step 4: Run tests**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/http-request.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/http-request.service.ts packages/pipeline-engine/src/__tests__/http-request.test.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts
git commit -m "feat(pipeline-engine): add http-request integration node"
```

---

## Task 15: Template Substitution Engine

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/template-engine.ts`
- Create: `packages/pipeline-engine/src/__tests__/template-engine.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect } from 'vitest';
import { substituteTemplates } from '../pipeline/template-engine.js';

describe('substituteTemplates', () => {
  test('substitutes simple variables', () => {
    expect(substituteTemplates('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  test('substitutes nested paths', () => {
    expect(substituteTemplates('Score: {{output.score}}', { output: { score: 0.9 } })).toBe(
      'Score: 0.9',
    );
  });

  test('replaces missing variables with empty string', () => {
    expect(substituteTemplates('Hello {{missing}}', {})).toBe('Hello ');
  });

  test('handles multiple substitutions', () => {
    expect(substituteTemplates('{{a}} and {{b}}', { a: 'X', b: 'Y' })).toBe('X and Y');
  });
});
```

**Step 2: Implement**

Simple regex-based `{{path}}` substitution with dot-path resolution.

**Step 3: Run test**

Expected: PASS

**Step 4: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/template-engine.ts packages/pipeline-engine/src/__tests__/template-engine.test.ts
git commit -m "feat(pipeline-engine): add template substitution engine for node configs"
```

---

## Task 16: End-to-End Integration Test — Graph Pipeline

**Files:**

- Create: `packages/pipeline-engine/src/__tests__/integration-graph-pipeline.test.ts`

**Step 1: Write integration test**

Test a complete graph pipeline with branching, parallel groups, and conditional transitions using mocked node executors. Verify:

- Linear flow works
- Conditional branching works
- Node-group parallel execution works
- Back-edge with maxVisits works
- Template substitution in configs works

**Step 2: Run test**

Run: `cd packages/pipeline-engine && pnpm test src/__tests__/integration-graph-pipeline.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/pipeline-engine/src/__tests__/integration-graph-pipeline.test.ts
git commit -m "test(pipeline-engine): add end-to-end integration tests for graph-based pipeline execution"
```

---

## Task 17: Run Full Test Suite and Fix Regressions

**Step 1: Build the package**

Run: `pnpm build`
Expected: PASS with no type errors

**Step 2: Run all tests**

Run: `cd packages/pipeline-engine && pnpm test`
Expected: All 33+ existing tests PASS, all new tests PASS

**Step 3: Fix any regressions**

If any existing tests fail, investigate and fix. The goal is zero regression — all existing pipeline definitions and activity services must work unchanged.

**Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix(pipeline-engine): resolve regressions from graph engine integration"
```

---

## Summary

| Task | Component               | New Files       | Modified Files                  |
| ---- | ----------------------- | --------------- | ------------------------------- |
| 1    | Node type interfaces    | 1 test          | `types.ts`, `index.ts`          |
| 2    | NodeRegistry            | 1 impl + 1 test | `index.ts`                      |
| 3    | Auto-registration       | 1 impl + 1 test | `index.ts`                      |
| 4    | Graph utilities         | 1 impl + 1 test | `index.ts`                      |
| 5    | Graph validation        | 1 test          | `validation.ts`, `index.ts`     |
| 6    | Graph walker            | 1 impl + 1 test | `index.ts`                      |
| 7    | PipelineRun integration | —               | `pipeline-run.workflow.ts`      |
| 8    | Node-group handler      | —               | `activity-router.service.ts`    |
| 9    | Schema update           | —               | `pipeline-definition.schema.ts` |
| 10   | Node catalog API        | 1 route         | —                               |
| 11   | CRUD updates            | —               | Studio pipeline routes          |
| 12   | Resume API              | 1 route         | —                               |
| 13   | Wait/delay handlers     | —               | `activity-router.service.ts`    |
| 14   | HTTP request node       | 1 impl + 1 test | `activity-router.service.ts`    |
| 15   | Template engine         | 1 impl + 1 test | —                               |
| 16   | Integration tests       | 1 test          | —                               |
| 17   | Full suite validation   | —               | Any regressions                 |

**Total: ~10 new files, ~8 modified files, 17 commits**
