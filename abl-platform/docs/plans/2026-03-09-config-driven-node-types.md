# Config-Driven Node Types — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all 35 node type definitions (metadata + config schemas) from hardcoded TypeScript to MongoDB, loaded at startup by NodeRegistry, so Studio can render accurate config forms and customers can configure nodes without code changes.

**Architecture:** New `node_type_definitions` MongoDB collection seeded with all 35 types. `NodeRegistry.loadFromDB()` replaces static `registerAnalyticsNodes()` + `registerBuiltinNodes()`. Trait-based standard fields (sourceStep, model, skipDirectWrite) are auto-merged at load time. `activity-metadata.ts` and `register-nodes.ts` are deleted. Validation and Studio routes switch to the DB-backed registry.

**Tech Stack:** Mongoose (MongoDB ODM), Vitest (testing), TypeScript, existing pipeline-engine package

**Design doc:** `/Users/Thiru/researchWS/abl-review/2026-03-09-config-driven-node-types-design.md`

---

## Task 1: Extend TypeScript Types

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/types.ts`

**Step 1: Write the failing test**

Create a test that imports the new types and validates their shape:

```typescript
// packages/pipeline-engine/src/__tests__/config-driven-types.test.ts
import { describe, test, expect } from 'vitest';
import type {
  ConfigFieldDefinition,
  StorageTableDefinition,
  StorageColumnDefinition,
  NodeTypeDefinitionDoc,
  NodeTrait,
} from '../pipeline/types.js';

describe('Config-driven type definitions', () => {
  test('ConfigFieldDefinition supports all field types including string[] and object[]', () => {
    const field: ConfigFieldDefinition = {
      name: 'taxonomy',
      type: 'object[]',
      required: false,
      label: 'Intent Taxonomy',
      description: 'Define intent categories',
      group: 'basic',
      itemSchema: [
        {
          name: 'category',
          type: 'string',
          required: true,
          label: 'Category',
          description: 'Group name',
        },
      ],
    };
    expect(field.type).toBe('object[]');
    expect(field.itemSchema).toHaveLength(1);
  });

  test('ConfigFieldDefinition supports showWhen for conditional visibility', () => {
    const field: ConfigFieldDefinition = {
      name: 'inputMessageCount',
      type: 'number',
      required: false,
      default: 3,
      label: 'Message Count',
      description: 'Max messages',
      group: 'advanced',
      showWhen: { field: 'inputMessageStrategy', equals: 'first_n_user' },
      validation: { min: 1, max: 20 },
    };
    expect(field.showWhen?.field).toBe('inputMessageStrategy');
  });

  test('StorageTableDefinition describes ClickHouse tables', () => {
    const table: StorageTableDefinition = {
      table: 'abl_platform.intent_classifications',
      granularity: 'session',
      columns: [
        { name: 'tenant_id', type: 'String', source: 'system', description: 'Tenant ID' },
        { name: 'intent', type: 'String', source: 'computed', description: 'Classified intent' },
      ],
    };
    expect(table.granularity).toBe('session');
    expect(table.columns).toHaveLength(2);
  });

  test('NodeTypeDefinitionDoc has traits and storageSchema', () => {
    const doc: NodeTypeDefinitionDoc = {
      _id: 'compute-intent',
      tenantId: 'SYSTEM',
      label: 'Classify Intent',
      description: 'LLM-based intent classification',
      category: 'compute',
      executionModel: 'async',
      defaultTimeout: 120000,
      defaultRetries: 2,
      retryable: true,
      traits: ['compute', 'llm', 'storage'],
      configSchema: [],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(doc.traits).toContain('llm');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/config-driven-types.test.ts`
Expected: FAIL — types don't exist yet

**Step 3: Add the new types to types.ts**

Add these types at the end of `packages/pipeline-engine/src/pipeline/types.ts`:

```typescript
// ── Config-Driven Node Type System ──

export type NodeTrait = 'compute' | 'llm' | 'storage';

export interface ConfigFieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'string[]' | 'object' | 'object[]';
  required: boolean;
  default?: unknown;
  label: string;
  description: string;
  placeholder?: string;
  group?: string;

  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
  };
  values?: string[];

  showWhen?: {
    field: string;
    equals: string | string[];
  };

  itemSchema?: ConfigFieldDefinition[];
}

export interface StorageColumnDefinition {
  name: string;
  type: string;
  source: 'system' | 'computed';
  description: string;
}

export interface StorageTableDefinition {
  table: string;
  granularity: 'message' | 'session' | 'customer' | 'metric';
  columns: StorageColumnDefinition[];
}

/**
 * MongoDB document shape for the node_type_definitions collection.
 * This is the DB-backed replacement for ACTIVITY_TYPES + registerBuiltinNodes.
 */
export interface NodeTypeDefinitionDoc {
  _id: string;
  tenantId: string;

  label: string;
  description: string;
  category: NodeCategory;
  icon?: string;

  executionModel: 'sync' | 'async' | 'control-flow';
  defaultTimeout: number;
  defaultRetries: number;
  retryable?: boolean;
  requiredCapabilities?: string[];

  traits: NodeTrait[];

  configSchema: ConfigFieldDefinition[];

  outputSchema?: Record<string, { type: string; description: string }>;

  storageSchema?: {
    tables: StorageTableDefinition[];
  };

  inputSchema?: {
    requiresPreviousStep?: string;
    requiredInputFields?: string[];
  };

  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

Also add exports to `packages/pipeline-engine/src/index.ts`:

```typescript
export type {
  ConfigFieldDefinition,
  StorageTableDefinition,
  StorageColumnDefinition,
  NodeTypeDefinitionDoc,
  NodeTrait,
} from './pipeline/types.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/config-driven-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/types.ts packages/pipeline-engine/src/__tests__/config-driven-types.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add config-driven node type definitions (types only)"
```

---

## Task 2: Create Mongoose Schema for node_type_definitions

**Files:**

- Create: `packages/pipeline-engine/src/schemas/node-type-definition.schema.ts`
- Modify: `packages/pipeline-engine/src/schemas/index.ts`
- Modify: `packages/pipeline-engine/src/index.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/node-type-definition-schema.test.ts
import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';

// We test the schema compiles and produces valid models
describe('NodeTypeDefinitionModel', () => {
  test('model is exported from package', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    expect(NodeTypeDefinitionModel).toBeDefined();
    expect(NodeTypeDefinitionModel.modelName).toBe('NodeTypeDefinition');
  });

  test('schema validates required fields', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({});
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['_id']).toBeDefined();
    expect(err!.errors['tenantId']).toBeDefined();
    expect(err!.errors['label']).toBeDefined();
  });

  test('schema accepts a valid compute-intent document', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({
      _id: 'compute-intent',
      tenantId: 'SYSTEM',
      label: 'Classify Intent',
      description: 'LLM-based intent classification',
      category: 'compute',
      executionModel: 'async',
      defaultTimeout: 120000,
      defaultRetries: 2,
      retryable: true,
      traits: ['compute', 'llm', 'storage'],
      configSchema: [
        {
          name: 'taxonomy',
          type: 'object[]',
          required: false,
          label: 'Intent Taxonomy',
          description: 'Define intent categories',
          group: 'basic',
          itemSchema: [
            {
              name: 'category',
              type: 'string',
              required: true,
              label: 'Category',
              description: 'Group name',
            },
          ],
        },
      ],
      version: 1,
      isActive: true,
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/node-type-definition-schema.test.ts`
Expected: FAIL — schema file doesn't exist

**Step 3: Create the Mongoose schema**

Create `packages/pipeline-engine/src/schemas/node-type-definition.schema.ts`:

```typescript
/**
 * NodeTypeDefinition Model
 *
 * Stores node type definitions for the pipeline engine.
 * Each node type describes its config schema, execution behavior,
 * traits (for auto-merged standard fields), and storage schema.
 *
 * Replaces the hardcoded ACTIVITY_TYPES dict and registerBuiltinNodes().
 * tenantId='SYSTEM' for platform-provided types; tenant-specific for custom.
 */

import mongoose, { Schema } from 'mongoose';
import type { NodeTypeDefinitionDoc } from '../pipeline/types.js';

// ─── Sub-schemas ──────────────────────────────────────────────────────────

const ConfigFieldDefinitionSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['string', 'number', 'boolean', 'enum', 'string[]', 'object', 'object[]'],
    },
    required: { type: Boolean, default: false },
    default: { type: Schema.Types.Mixed },
    label: { type: String, required: true },
    description: { type: String, required: true },
    placeholder: { type: String },
    group: { type: String },
    validation: {
      min: { type: Number },
      max: { type: Number },
      minLength: { type: Number },
      maxLength: { type: Number },
      pattern: { type: String },
      minItems: { type: Number },
      maxItems: { type: Number },
    },
    values: [{ type: String }],
    showWhen: {
      field: { type: String },
      equals: { type: Schema.Types.Mixed }, // string | string[]
    },
    itemSchema: [{ type: Schema.Types.Mixed }], // recursive ConfigFieldDefinition[]
  },
  { _id: false },
);

const StorageColumnDefinitionSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    source: { type: String, required: true, enum: ['system', 'computed'] },
    description: { type: String, required: true },
  },
  { _id: false },
);

const StorageTableDefinitionSchema = new Schema(
  {
    table: { type: String, required: true },
    granularity: {
      type: String,
      required: true,
      enum: ['message', 'session', 'customer', 'metric'],
    },
    columns: [StorageColumnDefinitionSchema],
  },
  { _id: false },
);

// ─── Main Schema ──────────────────────────────────────────────────────────

const NodeTypeDefinitionSchema = new Schema<NodeTypeDefinitionDoc>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },

    label: { type: String, required: true },
    description: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ['data', 'logic', 'integration', 'compute', 'action'],
    },
    icon: { type: String },

    executionModel: {
      type: String,
      required: true,
      enum: ['sync', 'async', 'control-flow'],
    },
    defaultTimeout: { type: Number, required: true, default: 60000 },
    defaultRetries: { type: Number, required: true, default: 0 },
    retryable: { type: Boolean },
    requiredCapabilities: [{ type: String }],

    traits: [{ type: String, enum: ['compute', 'llm', 'storage'] }],

    configSchema: [ConfigFieldDefinitionSchema],

    outputSchema: { type: Schema.Types.Mixed },

    storageSchema: {
      tables: [StorageTableDefinitionSchema],
    },

    inputSchema: {
      requiresPreviousStep: { type: String },
      requiredInputFields: [{ type: String }],
    },

    version: { type: Number, required: true, default: 1 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'node_type_definitions' },
);

// ─── Indexes ──────────────────────────────────────────────────────────────

NodeTypeDefinitionSchema.index({ tenantId: 1, isActive: 1 });
NodeTypeDefinitionSchema.index({ tenantId: 1, category: 1, isActive: 1 });

// ─── Model ────────────────────────────────────────────────────────────────

export const NodeTypeDefinitionModel =
  mongoose.models['NodeTypeDefinition'] ??
  mongoose.model<NodeTypeDefinitionDoc>('NodeTypeDefinition', NodeTypeDefinitionSchema);
```

Add to `packages/pipeline-engine/src/schemas/index.ts`:

```typescript
export { NodeTypeDefinitionModel } from './node-type-definition.schema.js';
```

Add to `packages/pipeline-engine/src/index.ts`:

```typescript
export { NodeTypeDefinitionModel } from './schemas/node-type-definition.schema.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/node-type-definition-schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/schemas/node-type-definition.schema.ts packages/pipeline-engine/src/schemas/index.ts packages/pipeline-engine/src/index.ts packages/pipeline-engine/src/__tests__/node-type-definition-schema.test.ts
git commit -m "feat(pipeline-engine): add NodeTypeDefinition Mongoose schema"
```

---

## Task 3: Create Seed Data JSON

This is the largest task — all 35 node type definitions as MongoDB-ready JSON.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json`

**Step 1: Create the seed data file**

Create `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json` containing an array of all 35 node type definitions.

**Source of truth:** The design doc at `/Users/Thiru/researchWS/abl-review/2026-03-09-config-driven-node-types-design.md` section "Concrete MongoDB Document Examples" (9 detailed examples) and section "Node Type Definitions (all 35)" (the complete list).

Every node type definition must follow the `NodeTypeDefinitionDoc` interface from Task 1. The format for each entry:

```json
{
  "_id": "<type-id>",
  "tenantId": "SYSTEM",
  "label": "...",
  "description": "...",
  "category": "data|logic|integration|compute|action",
  "icon": "...",
  "executionModel": "sync|async|control-flow",
  "defaultTimeout": 60000,
  "defaultRetries": 0,
  "retryable": false,
  "traits": [],
  "configSchema": [
    /* ConfigFieldDefinition[] */
  ],
  "outputSchema": {
    /* optional */
  },
  "storageSchema": {
    "tables": [
      /* optional */
    ]
  },
  "inputSchema": {
    /* optional */
  },
  "version": 1,
  "isActive": true
}
```

**Complete list of 35 node types to include (cross-referenced from `activity-metadata.ts` and `register-nodes.ts`):**

**From ACTIVITY_TYPES (25):**

1. `read-conversation` — data, traits: []
2. `read-message-window` — data, traits: []
3. `compute-sentiment` — compute, traits: [compute, llm, storage]
4. `compute-intent` — compute, traits: [compute, llm, storage]
5. `compute-quality` — compute, traits: [compute, llm, storage]
6. `compute-mentions` — compute, traits: [compute, llm, storage]
7. `conversation-analyzer` — compute, traits: [compute, llm, storage]
8. `compute-toxicity` — compute, traits: [compute]
9. `compute-tool-effectiveness` — compute, traits: [compute]
10. `compute-statistical` — compute, traits: [compute, storage]
11. `compute-predictive-features` — compute, traits: [compute, storage]
12. `evaluate-metrics` — compute, traits: []
13. `evaluate-policy` — compute, traits: []
14. `call-llm` — compute, traits: [llm]
15. `store-results` — action, traits: []
16. `store-insight` — action, traits: []
17. `send-notification` — action, traits: []
18. `transform` — data, traits: []
19. `run-legacy-workflow` — action, traits: []
20. `http-request` — integration, traits: []
21. `simulate-persona` — compute, traits: [llm]
22. `execute-agent-turn` — compute, traits: []
23. `run-eval-conversation` — compute, traits: [llm]
24. `judge-conversation` — compute, traits: [llm]
25. `aggregate-eval-run` — compute, traits: []

**From registerBuiltinNodes (10):** 26. `node-group` — logic, traits: [] 27. `wait-for-event` — logic, traits: [] 28. `delay` — logic, traits: [] 29. `sub-pipeline` — logic, traits: [] 30. `db-query` — data, traits: [] 31. `filter` — data, traits: [] 32. `aggregate` — data, traits: [] 33. `send-email` — integration, traits: [] 34. `send-slack` — integration, traits: [] 35. `publish-kafka` — integration, traits: []

For each entry, use the **detailed** configSchema from the design doc section "Node Type Definitions (all 35)" — NOT the simplified version from `activity-metadata.ts`. The design doc has the corrected, complete config fields with `label`, `group`, `showWhen`, `validation`, `itemSchema`, `placeholder`, etc.

**Step 2: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/seed-data.test.ts
import { describe, test, expect } from 'vitest';
import seedData from '../pipeline/seed-data/node-type-definitions.json';
import type { NodeTypeDefinitionDoc, ConfigFieldDefinition } from '../pipeline/types.js';

describe('seed data: node-type-definitions.json', () => {
  test('contains exactly 35 node type definitions', () => {
    expect(seedData).toHaveLength(35);
  });

  test('all entries have required top-level fields', () => {
    for (const entry of seedData) {
      expect(entry._id).toBeTruthy();
      expect(entry.tenantId).toBe('SYSTEM');
      expect(entry.label).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(['data', 'logic', 'integration', 'compute', 'action']).toContain(entry.category);
      expect(['sync', 'async', 'control-flow']).toContain(entry.executionModel);
      expect(typeof entry.defaultTimeout).toBe('number');
      expect(typeof entry.defaultRetries).toBe('number');
      expect(Array.isArray(entry.traits)).toBe(true);
      expect(Array.isArray(entry.configSchema)).toBe(true);
      expect(entry.version).toBe(1);
      expect(entry.isActive).toBe(true);
    }
  });

  test('no duplicate _id values', () => {
    const ids = seedData.map((d: any) => d._id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all configSchema fields have label and description', () => {
    for (const entry of seedData) {
      for (const field of entry.configSchema as any[]) {
        expect(field.label).toBeTruthy();
        expect(field.description).toBeTruthy();
        expect(field.name).toBeTruthy();
        expect(field.type).toBeTruthy();
      }
    }
  });

  test('compute-intent has taxonomy with itemSchema', () => {
    const intent = seedData.find((d: any) => d._id === 'compute-intent');
    expect(intent).toBeDefined();
    const taxonomy = (intent as any).configSchema.find((f: any) => f.name === 'taxonomy');
    expect(taxonomy).toBeDefined();
    expect(taxonomy.type).toBe('object[]');
    expect(taxonomy.itemSchema).toBeDefined();
    expect(taxonomy.itemSchema.length).toBeGreaterThan(0);
  });

  test('compute-mentions has companyName, competitors, mentionTypes', () => {
    const mentions = seedData.find((d: any) => d._id === 'compute-mentions');
    expect(mentions).toBeDefined();
    const names = (mentions as any).configSchema.map((f: any) => f.name);
    expect(names).toContain('companyName');
    expect(names).toContain('competitors');
    expect(names).toContain('mentionTypes');
  });

  test('compute-statistical has showWhen conditionals', () => {
    const stat = seedData.find((d: any) => d._id === 'compute-statistical');
    expect(stat).toBeDefined();
    const metricTable = (stat as any).configSchema.find((f: any) => f.name === 'metricTable');
    expect(metricTable).toBeDefined();
    expect(metricTable.showWhen).toBeDefined();
    expect(metricTable.showWhen.field).toBe('analysisType');
  });

  test('traits are valid values', () => {
    const validTraits = ['compute', 'llm', 'storage'];
    for (const entry of seedData) {
      for (const trait of entry.traits as string[]) {
        expect(validTraits).toContain(trait);
      }
    }
  });

  test('activity types match expected IDs', () => {
    const ids = new Set(seedData.map((d: any) => d._id));
    // Spot-check key types exist
    expect(ids.has('compute-sentiment')).toBe(true);
    expect(ids.has('compute-intent')).toBe(true);
    expect(ids.has('compute-quality')).toBe(true);
    expect(ids.has('compute-mentions')).toBe(true);
    expect(ids.has('evaluate-policy')).toBe(true);
    expect(ids.has('node-group')).toBe(true);
    expect(ids.has('delay')).toBe(true);
    expect(ids.has('http-request')).toBe(true);
    expect(ids.has('send-email')).toBe(true);
    expect(ids.has('publish-kafka')).toBe(true);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/seed-data.test.ts`
Expected: FAIL — JSON file doesn't exist

**Step 4: Create the JSON seed data file**

Create `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json` with all 35 entries. Use the design doc as the authoritative source for every field.

**Step 5: Run test to verify it passes**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/seed-data.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json packages/pipeline-engine/src/__tests__/seed-data.test.ts
git commit -m "feat(pipeline-engine): add seed data for all 35 node type definitions"
```

---

## Task 4: Trait Merging Logic

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/trait-merger.ts`

The trait merger takes a `NodeTypeDefinitionDoc` and returns a `NodeTypeDefinition` (the existing in-memory type used by NodeRegistry), with standard fields auto-merged based on traits.

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/trait-merger.test.ts
import { describe, test, expect } from 'vitest';
import { mergeTraitFields } from '../pipeline/trait-merger.js';
import type { NodeTypeDefinitionDoc, ConfigFieldDefinition } from '../pipeline/types.js';

function makeDoc(overrides: Partial<NodeTypeDefinitionDoc>): NodeTypeDefinitionDoc {
  return {
    _id: 'test-node',
    tenantId: 'SYSTEM',
    label: 'Test',
    description: 'Test node',
    category: 'compute',
    executionModel: 'async',
    defaultTimeout: 60000,
    defaultRetries: 0,
    traits: [],
    configSchema: [],
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('mergeTraitFields', () => {
  test('returns configSchema unchanged when traits is empty', () => {
    const doc = makeDoc({
      configSchema: [
        { name: 'foo', type: 'string', required: true, label: 'Foo', description: 'A foo' },
      ],
    });
    const result = mergeTraitFields(doc);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('foo');
  });

  test('merges sourceStep for compute trait', () => {
    const doc = makeDoc({ traits: ['compute'] });
    const result = mergeTraitFields(doc);
    const sourceStep = result.find((f) => f.name === 'sourceStep');
    expect(sourceStep).toBeDefined();
    expect(sourceStep!.type).toBe('string');
    expect(sourceStep!.default).toBe('read-conversation');
  });

  test('merges model for llm trait', () => {
    const doc = makeDoc({ traits: ['llm'] });
    const result = mergeTraitFields(doc);
    const model = result.find((f) => f.name === 'model');
    expect(model).toBeDefined();
    expect(model!.required).toBe(false);
  });

  test('merges skipDirectWrite for storage trait', () => {
    const doc = makeDoc({ traits: ['storage'] });
    const result = mergeTraitFields(doc);
    const skip = result.find((f) => f.name === 'skipDirectWrite');
    expect(skip).toBeDefined();
    expect(skip!.type).toBe('boolean');
    expect(skip!.default).toBe(false);
  });

  test('merges all three traits together', () => {
    const doc = makeDoc({
      traits: ['compute', 'llm', 'storage'],
      configSchema: [
        {
          name: 'threshold',
          type: 'number',
          required: false,
          label: 'Threshold',
          description: 'Score threshold',
        },
      ],
    });
    const result = mergeTraitFields(doc);
    const names = result.map((f) => f.name);
    expect(names).toContain('threshold');
    expect(names).toContain('sourceStep');
    expect(names).toContain('model');
    expect(names).toContain('skipDirectWrite');
  });

  test('does not duplicate if configSchema already has a trait field', () => {
    const doc = makeDoc({
      traits: ['compute'],
      configSchema: [
        {
          name: 'sourceStep',
          type: 'string',
          required: false,
          label: 'Source Step',
          description: 'Custom override',
          default: 'my-step',
        },
      ],
    });
    const result = mergeTraitFields(doc);
    const sourceSteps = result.filter((f) => f.name === 'sourceStep');
    expect(sourceSteps).toHaveLength(1);
    // Existing field takes precedence
    expect(sourceSteps[0].default).toBe('my-step');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/trait-merger.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement trait-merger.ts**

Create `packages/pipeline-engine/src/pipeline/trait-merger.ts`:

```typescript
/**
 * Merges trait-based standard fields into a node type's configSchema.
 *
 * Each trait defines standard fields that are auto-appended unless the
 * node's configSchema already defines a field with the same name.
 *
 * Traits:
 *   compute → sourceStep
 *   llm     → model
 *   storage → skipDirectWrite
 */

import type { ConfigFieldDefinition, NodeTypeDefinitionDoc, NodeTrait } from './types.js';

const TRAIT_FIELDS: Record<NodeTrait, ConfigFieldDefinition[]> = {
  compute: [
    {
      name: 'sourceStep',
      type: 'string',
      required: false,
      default: 'read-conversation',
      label: 'Source Step',
      description: 'Which prior step to read conversation data from',
      group: 'advanced',
    },
  ],
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

/**
 * Given a NodeTypeDefinitionDoc, return a new configSchema array with
 * trait-based standard fields merged in. Fields already present in the
 * doc's configSchema take precedence (not overwritten).
 */
export function mergeTraitFields(doc: NodeTypeDefinitionDoc): ConfigFieldDefinition[] {
  const existingNames = new Set(doc.configSchema.map((f) => f.name));
  const merged = [...doc.configSchema];

  for (const trait of doc.traits) {
    const traitFields = TRAIT_FIELDS[trait];
    if (!traitFields) continue;

    for (const field of traitFields) {
      if (!existingNames.has(field.name)) {
        merged.push(field);
        existingNames.add(field.name);
      }
    }
  }

  return merged;
}
```

Export from `packages/pipeline-engine/src/index.ts`:

```typescript
export { mergeTraitFields } from './pipeline/trait-merger.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/trait-merger.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/trait-merger.ts packages/pipeline-engine/src/__tests__/trait-merger.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add trait-based standard field merger"
```

---

## Task 5: Add loadFromDB() to NodeRegistry

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/node-registry.ts`
- Test: `packages/pipeline-engine/src/__tests__/node-registry.test.ts`

**Step 1: Write the failing test**

Add these tests to the existing `node-registry.test.ts`:

```typescript
import { mergeTraitFields } from '../pipeline/trait-merger.js';
import type { NodeTypeDefinitionDoc } from '../pipeline/types.js';

// ... existing tests ...

describe('loadFromDocs', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  const mockDocs: NodeTypeDefinitionDoc[] = [
    {
      _id: 'compute-intent',
      tenantId: 'SYSTEM',
      label: 'Classify Intent',
      description: 'LLM-based intent classification',
      category: 'compute',
      executionModel: 'async',
      defaultTimeout: 120000,
      defaultRetries: 2,
      retryable: true,
      traits: ['compute', 'llm', 'storage'],
      configSchema: [
        {
          name: 'taxonomy',
          type: 'object[]',
          required: false,
          label: 'Taxonomy',
          description: 'Intent taxonomy',
        },
      ],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: 'delay',
      tenantId: 'SYSTEM',
      label: 'Delay',
      description: 'Pause execution',
      category: 'logic',
      executionModel: 'control-flow',
      defaultTimeout: 86400000,
      defaultRetries: 0,
      traits: [],
      configSchema: [
        {
          name: 'durationMs',
          type: 'number',
          required: true,
          label: 'Duration',
          description: 'ms',
          validation: { min: 1000, max: 86400000 },
        },
      ],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  test('loads node types from document array', () => {
    registry.loadFromDocs(mockDocs);
    expect(registry.has('compute-intent')).toBe(true);
    expect(registry.has('delay')).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });

  test('merges trait fields during loading', () => {
    registry.loadFromDocs(mockDocs);
    const intent = registry.get('compute-intent')!;
    const fieldNames = intent.configSchema.fields.map((f) => f.name);
    expect(fieldNames).toContain('taxonomy');
    expect(fieldNames).toContain('sourceStep'); // from compute trait
    expect(fieldNames).toContain('model'); // from llm trait
    expect(fieldNames).toContain('skipDirectWrite'); // from storage trait
  });

  test('preserves non-config fields from doc', () => {
    registry.loadFromDocs(mockDocs);
    const intent = registry.get('compute-intent')!;
    expect(intent.type).toBe('compute-intent');
    expect(intent.category).toBe('compute');
    expect(intent.executionModel).toBe('async');
    expect(intent.defaultTimeout).toBe(120000);
    expect(intent.defaultRetries).toBe(2);
    expect(intent.retryable).toBe(true);
  });

  test('clears existing registrations before loading', () => {
    registry.register(toxicityNode);
    expect(registry.has('compute-toxicity')).toBe(true);
    registry.loadFromDocs(mockDocs);
    expect(registry.has('compute-toxicity')).toBe(false);
    expect(registry.has('compute-intent')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/node-registry.test.ts`
Expected: FAIL — `loadFromDocs` method doesn't exist

**Step 3: Add loadFromDocs() to NodeRegistry**

Edit `packages/pipeline-engine/src/pipeline/node-registry.ts`:

```typescript
import type { ConfigField, NodeCategory, NodeTypeDefinition } from './types.js';
import type { ConfigFieldDefinition, NodeTypeDefinitionDoc } from './types.js';
import { mergeTraitFields } from './trait-merger.js';

// ... existing code ...

export class NodeRegistry {
  private nodes: Map<string, NodeTypeDefinition> = new Map();

  // ... existing register(), get(), has(), list(), validateConfig() ...

  /**
   * Clear all registered nodes and load from an array of DB documents.
   * Trait-based standard fields are auto-merged into configSchema.
   */
  loadFromDocs(docs: NodeTypeDefinitionDoc[]): void {
    this.nodes.clear();

    for (const doc of docs) {
      const mergedFields = mergeTraitFields(doc);

      // Convert ConfigFieldDefinition[] to the existing ConfigField[] format
      const fields: ConfigField[] = mergedFields.map((f) => ({
        name: f.name,
        type: mapFieldType(f.type),
        required: f.required,
        default: f.default,
        description: f.description,
        validation: f.validation,
        values: f.values,
        items: f.itemSchema
          ? {
              type: 'object',
              properties: Object.fromEntries(
                f.itemSchema.map((s) => [s.name, { type: s.type, description: s.description }]),
              ),
            }
          : undefined,
      }));

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
        outputSchema: doc.outputSchema ? { properties: doc.outputSchema } : undefined,
      };

      this.nodes.set(doc._id, definition);
    }
  }
}

/**
 * Map ConfigFieldDefinition type strings to ConfigField type union.
 * ConfigFieldDefinition adds 'string[]' and 'object[]' which map to 'array'.
 */
function mapFieldType(type: string): ConfigField['type'] {
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
    case 'object':
      return type;
    case 'string[]':
    case 'object[]':
      return 'array';
    default:
      return 'string';
  }
}
```

Export `mapFieldType` is **not** needed publicly — keep it module-private.

**Step 4: Run test to verify it passes**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/node-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/node-registry.ts packages/pipeline-engine/src/__tests__/node-registry.test.ts
git commit -m "feat(pipeline-engine): add loadFromDocs() to NodeRegistry with trait merging"
```

---

## Task 6: Create Seed Script

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/seed-node-types.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/seed-node-types.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the Mongoose model
const mockBulkWrite = vi.fn().mockResolvedValue({ upsertedCount: 35, modifiedCount: 0 });
vi.mock('../schemas/node-type-definition.schema.js', () => ({
  NodeTypeDefinitionModel: {
    bulkWrite: mockBulkWrite,
  },
}));

describe('seedNodeTypes', () => {
  beforeEach(() => {
    mockBulkWrite.mockClear();
  });

  test('calls bulkWrite with upsert operations for all 35 types', async () => {
    const { seedNodeTypes } = await import('../pipeline/seed-node-types.js');
    const result = await seedNodeTypes();

    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    const operations = mockBulkWrite.mock.calls[0][0];
    expect(operations).toHaveLength(35);

    // Each operation is an updateOne with upsert
    for (const op of operations) {
      expect(op.updateOne).toBeDefined();
      expect(op.updateOne.filter._id).toBeTruthy();
      expect(op.updateOne.filter.tenantId).toBe('SYSTEM');
      expect(op.updateOne.upsert).toBe(true);
    }

    expect(result.count).toBe(35);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/seed-node-types.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement the seed script**

Create `packages/pipeline-engine/src/pipeline/seed-node-types.ts`:

```typescript
/**
 * Seed the node_type_definitions collection with all platform-provided node types.
 *
 * Idempotent: uses bulkWrite with upsert so it can be run repeatedly.
 * Only updates SYSTEM-tenanted docs — tenant-specific overrides are untouched.
 */

import { NodeTypeDefinitionModel } from '../schemas/node-type-definition.schema.js';
import seedData from './seed-data/node-type-definitions.json' with { type: 'json' };

export interface SeedResult {
  count: number;
}

export async function seedNodeTypes(): Promise<SeedResult> {
  const operations = seedData.map((entry) => ({
    updateOne: {
      filter: { _id: entry._id, tenantId: 'SYSTEM' },
      update: { $set: { ...entry, updatedAt: new Date() } },
      upsert: true,
    },
  }));

  await NodeTypeDefinitionModel.bulkWrite(operations);

  return { count: operations.length };
}
```

Export from `packages/pipeline-engine/src/index.ts`:

```typescript
export { seedNodeTypes } from './pipeline/seed-node-types.js';
export type { SeedResult } from './pipeline/seed-node-types.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/seed-node-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/seed-node-types.ts packages/pipeline-engine/src/__tests__/seed-node-types.test.ts packages/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add idempotent seed script for node type definitions"
```

---

## Task 7: Update Studio Registry to Support DB Loading

**Files:**

- Modify: `apps/studio/src/app/api/pipelines/_shared/registry.ts`

**Step 1: Read the existing file**

File: `apps/studio/src/app/api/pipelines/_shared/registry.ts` (already read — 23 lines)

**Step 2: Update the registry singleton to try DB first, fall back to static**

```typescript
/**
 * Shared NodeRegistry singleton for pipeline API routes.
 *
 * Tries to load from MongoDB first (config-driven node types).
 * Falls back to static registration if DB is unavailable.
 */
import {
  NodeRegistry,
  NodeTypeDefinitionModel,
  registerAnalyticsNodes,
  registerBuiltinNodes,
} from '@agent-platform/pipeline-engine';
import type { NodeTypeDefinitionDoc } from '@agent-platform/pipeline-engine';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('pipeline-registry');

let cachedRegistry: NodeRegistry | null = null;
let loadedFromDB = false;

export async function getNodeRegistry(): Promise<NodeRegistry> {
  if (cachedRegistry) return cachedRegistry;

  cachedRegistry = new NodeRegistry();

  try {
    const docs = await NodeTypeDefinitionModel.find({
      tenantId: 'SYSTEM',
      isActive: true,
    }).lean<NodeTypeDefinitionDoc[]>();

    if (docs.length > 0) {
      cachedRegistry.loadFromDocs(docs);
      loadedFromDB = true;
      logger.info({ count: docs.length }, 'Loaded node types from MongoDB');
    } else {
      // DB is connected but collection is empty — use static fallback
      registerAnalyticsNodes(cachedRegistry);
      registerBuiltinNodes(cachedRegistry);
      logger.warn('No node types in DB — using static fallback');
    }
  } catch (err: unknown) {
    // DB unavailable — use static fallback
    registerAnalyticsNodes(cachedRegistry);
    registerBuiltinNodes(cachedRegistry);
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to load node types from DB — using static fallback',
    );
  }

  return cachedRegistry;
}

/** For testing: reset the cached registry */
export function resetNodeRegistryCache(): void {
  cachedRegistry = null;
  loadedFromDB = false;
}
```

**Step 3: Update all callers to use async getNodeRegistry()**

The callers are:

- `apps/studio/src/app/api/pipelines/route.ts` — POST handler (create pipeline)
- `apps/studio/src/app/api/pipelines/[pipelineId]/route.ts` — PATCH handler (update pipeline)
- `apps/studio/src/app/api/pipelines/nodes/route.ts` — GET handler (list node types)

Each currently calls `getNodeRegistry()` synchronously. Change to `await getNodeRegistry()`:

In `route.ts` (POST):

```typescript
// Before:
const registry = getNodeRegistry();
// After:
const registry = await getNodeRegistry();
```

The handlers are already `async` functions, so this only requires adding `await`.

**Step 4: Run the affected tests**

Run: `cd packages/pipeline-engine && npx vitest run` (full test suite)
Expected: PASS — no pipeline-engine tests break (Studio route tests are separate)

**Step 5: Commit**

```bash
git add apps/studio/src/app/api/pipelines/_shared/registry.ts apps/studio/src/app/api/pipelines/route.ts apps/studio/src/app/api/pipelines/[pipelineId]/route.ts apps/studio/src/app/api/pipelines/nodes/route.ts
git commit -m "feat(studio): load node types from MongoDB with static fallback"
```

---

## Task 8: Update Validation to Use Registry Instead of ACTIVITY_TYPES

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/validation.ts`
- Test: `packages/pipeline-engine/src/__tests__/validation.test.ts`

Currently `validation.ts:45` checks `ACTIVITY_TYPES[activityType]` directly for step-based pipelines. Graph-based validation already uses the registry. We need to make step validation also use the registry.

**Step 1: Write the failing test**

Add to the existing validation test file a test that validates a step whose type exists in the registry but NOT in ACTIVITY_TYPES:

```typescript
test('validates a custom node type registered in registry but not in ACTIVITY_TYPES', () => {
  // Register a custom type in the registry
  const registry = new NodeRegistry();
  registry.register({
    type: 'custom-compute',
    category: 'compute',
    label: 'Custom Compute',
    description: 'A custom compute node',
    configSchema: { fields: [] },
    executionModel: 'async',
  });

  const pipeline: PipelineDefinition = {
    // ... minimal pipeline with a step of type 'custom-compute'
  };

  const errors = validatePipeline(pipeline, registry);
  const typeErrors = errors.filter((e) => e.message.includes('Unknown activity type'));
  expect(typeErrors).toHaveLength(0);
});
```

**Step 2: Update validatePipeline and validateSteps signatures**

Change `validatePipeline` to accept an optional `NodeRegistry` parameter:

```typescript
export function validatePipeline(
  pipeline: PipelineDefinition,
  registry?: NodeRegistry,
): ValidationError[] {
```

Update `validateSteps` to accept and use the registry:

```typescript
function validateSteps(
  steps: PipelineStep[],
  errors: ValidationError[],
  prefix = '',
  registry?: NodeRegistry,
): Set<string> {
  // ...
  // Replace: if (activityType && !ACTIVITY_TYPES[activityType])
  // With:    if (activityType && !isKnownType(activityType, registry))
}

function isKnownType(type: string, registry?: NodeRegistry): boolean {
  if (registry) return registry.has(type);
  return type in ACTIVITY_TYPES;
}
```

This maintains backward compatibility — callers without a registry still work via ACTIVITY_TYPES fallback.

**Step 3: Run full validation tests**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/validation.test.ts`
Expected: PASS — all existing tests still pass

**Step 4: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/validation.ts packages/pipeline-engine/src/__tests__/validation.test.ts
git commit -m "refactor(pipeline-engine): validation accepts NodeRegistry for step type checking"
```

---

## Task 9: Create GET /api/node-types Endpoint

**Files:**

- Create: `apps/studio/src/app/api/node-types/route.ts`

This is a new dedicated endpoint that returns node type definitions directly from the DB, richer than the existing `GET /api/pipelines/nodes` endpoint (which only returns the in-memory `NodeTypeDefinition` shape). The new endpoint returns the full `NodeTypeDefinitionDoc` shape including `traits`, `storageSchema`, `inputSchema`, and `configSchema` with the new `ConfigFieldDefinition` fields (`label`, `group`, `showWhen`, `itemSchema`, etc.).

**Step 1: Create the route**

```typescript
// apps/studio/src/app/api/node-types/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { NodeTypeDefinitionModel } from '@agent-platform/pipeline-engine';
import { requireAuth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');

  const filter: Record<string, unknown> = {
    tenantId: { $in: ['SYSTEM', auth.tenantId] },
    isActive: true,
  };

  if (category) {
    filter.category = category;
  }

  const nodeTypes = await NodeTypeDefinitionModel.find(filter)
    .sort({ category: 1, label: 1 })
    .lean();

  return NextResponse.json({ data: nodeTypes });
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/app/api/node-types/route.ts
git commit -m "feat(studio): add GET /api/node-types endpoint for config-driven node types"
```

---

## Task 10: Wire Seed into Runtime Startup

**Files:**

- Modify: `apps/runtime/src/index.ts` (or wherever the runtime app initializes)

The seed script should run on startup to ensure the DB has the latest node type definitions.

**Step 1: Find the runtime startup file**

Look for the main entry point in `apps/runtime/src/` — likely `index.ts` or `app.ts`. Find where MongoDB connection is established and add the seed call after it.

**Step 2: Add seed call after DB connection**

```typescript
import { seedNodeTypes } from '@agent-platform/pipeline-engine';

// After MongoDB connection is established:
await seedNodeTypes();
logger.info('Seeded node type definitions');
```

**Step 3: Run runtime build to verify no compilation errors**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add apps/runtime/src/...
git commit -m "feat(runtime): seed node type definitions on startup"
```

---

## Task 11: Update Existing Tests That Import Removed Modules

Once all the above tasks are done and the DB-backed flow is confirmed working, the old static registration files can be deprecated. But **do not delete them yet** — they serve as the fallback path in Task 7.

**Files to review for import updates:**

- `packages/pipeline-engine/src/__tests__/register-nodes.test.ts` — Tests `registerAnalyticsNodes` and `registerBuiltinNodes`. Keep as-is for now (these functions are the fallback).
- `packages/pipeline-engine/src/__tests__/validation.test.ts` — May import `ACTIVITY_TYPES` directly. Keep as-is (backward-compat).
- `packages/pipeline-engine/src/__tests__/activity-services.test.ts` — Keep as-is.

**Step 1: Add a new integration test for the full DB-backed flow**

```typescript
// packages/pipeline-engine/src/__tests__/config-driven-integration.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { NodeRegistry } from '../pipeline/node-registry.js';
import seedData from '../pipeline/seed-data/node-type-definitions.json';
import type { NodeTypeDefinitionDoc } from '../pipeline/types.js';

describe('Config-driven full integration', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    // Load directly from seed data (simulates DB load)
    registry.loadFromDocs(seedData as unknown as NodeTypeDefinitionDoc[]);
  });

  test('registry has all 35 node types', () => {
    expect(registry.list()).toHaveLength(35);
  });

  test('compute nodes have trait-merged sourceStep field', () => {
    const intent = registry.get('compute-intent')!;
    const fields = intent.configSchema.fields.map((f) => f.name);
    expect(fields).toContain('sourceStep');
    expect(fields).toContain('model');
    expect(fields).toContain('skipDirectWrite');
  });

  test('control-flow nodes have no trait fields', () => {
    const delay = registry.get('delay')!;
    const fields = delay.configSchema.fields.map((f) => f.name);
    expect(fields).not.toContain('sourceStep');
    expect(fields).not.toContain('model');
    expect(fields).not.toContain('skipDirectWrite');
    expect(fields).toContain('durationMs');
  });

  test('validateConfig works against DB-loaded types', () => {
    const result = registry.validateConfig('compute-intent', {});
    // compute-intent has no required fields — taxonomy is optional
    expect(result.valid).toBe(true);

    const evalResult = registry.validateConfig('evaluate-policy', {});
    // evaluate-policy requires policyId
    expect(evalResult.valid).toBe(false);
    expect(evalResult.errors[0]).toContain('policyId');
  });

  test('can filter by category', () => {
    const logic = registry.list({ category: 'logic' });
    expect(logic.length).toBe(4); // node-group, wait-for-event, delay, sub-pipeline
    for (const node of logic) {
      expect(node.category).toBe('logic');
    }
  });
});
```

**Step 2: Run the integration test**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/config-driven-integration.test.ts`
Expected: PASS

**Step 3: Run all existing tests to ensure no regressions**

Run: `cd packages/pipeline-engine && npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add packages/pipeline-engine/src/__tests__/config-driven-integration.test.ts
git commit -m "test(pipeline-engine): add integration tests for config-driven node types"
```

---

## Task 12: Update Package Exports and Documentation

**Files:**

- Modify: `packages/pipeline-engine/src/index.ts` — ensure all new exports are present
- Modify: `packages/pipeline-engine/package.json` — if any new entry points needed

**Step 1: Verify all new symbols are exported**

Check that `packages/pipeline-engine/src/index.ts` exports:

- `ConfigFieldDefinition`, `StorageTableDefinition`, `StorageColumnDefinition`, `NodeTypeDefinitionDoc`, `NodeTrait` (types)
- `NodeTypeDefinitionModel` (Mongoose model)
- `mergeTraitFields` (trait merger)
- `seedNodeTypes`, `SeedResult` (seed script)

**Step 2: Run build to verify no compilation errors**

Run: `pnpm build`
Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add packages/pipeline-engine/src/index.ts
git commit -m "chore(pipeline-engine): finalize config-driven node type exports"
```

---

## Summary of All Files

### Created

| File                                                                         | Purpose                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json` | All 35 node type definitions as MongoDB-ready JSON     |
| `packages/pipeline-engine/src/schemas/node-type-definition.schema.ts`        | Mongoose schema for `node_type_definitions` collection |
| `packages/pipeline-engine/src/pipeline/trait-merger.ts`                      | Merges trait-based standard fields into configSchema   |
| `packages/pipeline-engine/src/pipeline/seed-node-types.ts`                   | Idempotent seed script using bulkWrite                 |
| `apps/studio/src/app/api/node-types/route.ts`                                | New API endpoint returning full NodeTypeDefinitionDoc  |
| `packages/pipeline-engine/src/__tests__/config-driven-types.test.ts`         | Type definition tests                                  |
| `packages/pipeline-engine/src/__tests__/node-type-definition-schema.test.ts` | Mongoose schema tests                                  |
| `packages/pipeline-engine/src/__tests__/seed-data.test.ts`                   | Seed data validation tests                             |
| `packages/pipeline-engine/src/__tests__/trait-merger.test.ts`                | Trait merging tests                                    |
| `packages/pipeline-engine/src/__tests__/seed-node-types.test.ts`             | Seed script tests                                      |
| `packages/pipeline-engine/src/__tests__/config-driven-integration.test.ts`   | Full integration tests                                 |

### Modified

| File                                                           | Change                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/types.ts`               | Add `ConfigFieldDefinition`, `StorageTableDefinition`, `StorageColumnDefinition`, `NodeTypeDefinitionDoc`, `NodeTrait` |
| `packages/pipeline-engine/src/pipeline/node-registry.ts`       | Add `loadFromDocs()` method                                                                                            |
| `packages/pipeline-engine/src/pipeline/validation.ts`          | Accept optional `NodeRegistry` param in `validatePipeline()`                                                           |
| `packages/pipeline-engine/src/index.ts`                        | Export new types, model, functions                                                                                     |
| `packages/pipeline-engine/src/schemas/index.ts`                | Export `NodeTypeDefinitionModel`                                                                                       |
| `apps/studio/src/app/api/pipelines/_shared/registry.ts`        | Async DB-first loading with static fallback                                                                            |
| `apps/studio/src/app/api/pipelines/route.ts`                   | `await getNodeRegistry()`                                                                                              |
| `apps/studio/src/app/api/pipelines/[pipelineId]/route.ts`      | `await getNodeRegistry()`                                                                                              |
| `apps/studio/src/app/api/pipelines/nodes/route.ts`             | `await getNodeRegistry()`                                                                                              |
| `apps/runtime/src/...` (startup file)                          | Call `seedNodeTypes()` after DB connection                                                                             |
| `packages/pipeline-engine/src/__tests__/node-registry.test.ts` | Add `loadFromDocs` tests                                                                                               |
| `packages/pipeline-engine/src/__tests__/validation.test.ts`    | Add registry-based validation test                                                                                     |

### NOT Modified (kept as fallback)

| File                                                         | Reason                                              |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/activity-metadata.ts` | Static fallback when DB is empty                    |
| `packages/pipeline-engine/src/pipeline/register-nodes.ts`    | Static fallback when DB is unavailable              |
| All 25 service implementation files                          | No changes needed — services read config at runtime |
| Pipeline run workflow                                        | Unchanged                                           |
| Graph walker, expression evaluator, template engine          | Unchanged                                           |

### Deletion Candidates (Phase 1b, after DB is proven in production)

| File                                                         | When                                            |
| ------------------------------------------------------------ | ----------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/activity-metadata.ts` | After confirming DB loading works in production |
| `packages/pipeline-engine/src/pipeline/register-nodes.ts`    | After confirming DB loading works in production |
