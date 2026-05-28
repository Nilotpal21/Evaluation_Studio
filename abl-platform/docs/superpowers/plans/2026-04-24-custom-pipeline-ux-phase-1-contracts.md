# Custom Pipeline UX — Phase 1: Contract Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**JIRA:** ABLP-564
**Branch:** `feat/ABLP-564-custom-pipeline-ux-redesign`
**Design spec:** `docs/superpowers/specs/2026-04-24-custom-pipeline-ux-design.md`
**Scope:** Phase 1 only (Contract foundation) — zero user-visible change.

**Goal:** Introduce three typed contracts (`TriggerContract`, `NodeContract`, `DestinationContract`) and a `ContractRegistry` that adapts existing node metadata and trigger definitions into them, without breaking any current consumer.

**Architecture:** Pure-TypeScript contracts live in a new `packages/pipeline-engine/src/pipeline/contracts/` subfolder. The `ContractRegistry` hydrates at construction from existing sources (`activity-metadata.ts`, `seed-data/trigger-definitions.json`) plus two new static data files (per-node enrichment + destination registry) plus one new JSON field per trigger (`exampleOutput`). No schema changes to Mongo. No changes to runtime or Studio consumers in this phase.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

---

## File Structure

### New files

| Path                                                                            | Responsibility                                                                                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/contracts/trigger-contract.ts`           | `TriggerContract` interface + runtime shape guard                                                                                      |
| `packages/pipeline-engine/src/pipeline/contracts/destination-contract.ts`       | `DestinationContract` interface + `DESTINATION_REGISTRY` (the 4 built-in destinations)                                                 |
| `packages/pipeline-engine/src/pipeline/contracts/node-contract.ts`              | `NodeContract` interface + `SideEffectClass` type                                                                                      |
| `packages/pipeline-engine/src/pipeline/contracts/node-contract-data.ts`         | `NODE_ENRICHMENT` — per-node `inputRequirements`, `compatibleTriggers`, `sideEffectClass`, `contractVersion` for all 32 existing nodes |
| `packages/pipeline-engine/src/pipeline/contracts/registry.ts`                   | `ContractRegistry` class — single lookup surface                                                                                       |
| `packages/pipeline-engine/src/pipeline/contracts/index.ts`                      | barrel export                                                                                                                          |
| `packages/pipeline-engine/src/__tests__/contracts/trigger-contract.test.ts`     | unit                                                                                                                                   |
| `packages/pipeline-engine/src/__tests__/contracts/destination-contract.test.ts` | unit                                                                                                                                   |
| `packages/pipeline-engine/src/__tests__/contracts/node-contract.test.ts`        | unit                                                                                                                                   |
| `packages/pipeline-engine/src/__tests__/contracts/registry.test.ts`             | unit                                                                                                                                   |
| `packages/pipeline-engine/src/__tests__/contracts/registry.integration.test.ts` | integration — asserts every existing node/trigger maps to a valid contract                                                             |

### Modified files

| Path                                                                       | Change                             |
| -------------------------------------------------------------------------- | ---------------------------------- |
| `packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json` | add `exampleOutput` to every entry |
| `packages/pipeline-engine/src/index.ts`                                    | re-export contracts                |
| `packages/pipeline-engine/package.json`                                    | add `./contracts` subpath export   |
| `packages/pipeline-engine/agents.md`                                       | append learning entry              |

---

## Task 1 — `TriggerContract`

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/contracts/trigger-contract.ts`
- Test: `packages/pipeline-engine/src/__tests__/contracts/trigger-contract.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `packages/pipeline-engine/src/__tests__/contracts/trigger-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isValidTriggerContract,
  type TriggerContract,
} from '../../pipeline/contracts/trigger-contract.js';

describe('TriggerContract', () => {
  const valid: TriggerContract = {
    id: 'session-ended',
    type: 'kafka',
    kafkaTopic: 'abl.session.ended',
    category: 'session',
    label: 'Session Ended',
    description: 'x',
    outputSchema: {
      required: ['tenantId', 'sessionId'],
      properties: {
        tenantId: { type: 'string' },
        sessionId: { type: 'string' },
      },
    },
    exampleOutput: { tenantId: 't1', sessionId: 's1' },
  };

  it('accepts a well-formed contract', () => {
    expect(isValidTriggerContract(valid)).toBe(true);
  });

  it('rejects a contract missing exampleOutput', () => {
    const { exampleOutput: _omit, ...missing } = valid;
    expect(isValidTriggerContract(missing)).toBe(false);
  });

  it('rejects a contract with an unknown type', () => {
    expect(
      isValidTriggerContract({ ...valid, type: 'http' as unknown as TriggerContract['type'] }),
    ).toBe(false);
  });

  it('rejects a contract whose outputSchema.required is not an array', () => {
    expect(
      isValidTriggerContract({
        ...valid,
        outputSchema: { required: 'tenantId' as unknown as string[], properties: {} },
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- trigger-contract.test.ts
```

Expected: FAIL with `Cannot find module '../../pipeline/contracts/trigger-contract.js'`.

- [ ] **Step 1.3: Write the contract type + guard**

Create `packages/pipeline-engine/src/pipeline/contracts/trigger-contract.ts`:

```ts
/**
 * TriggerContract — typed contract that declares what a pipeline trigger emits.
 *
 * Source of truth for:
 *   - trigger picker metadata
 *   - test-drawer example payloads
 *   - trigger↔node compatibility checks (cross-referenced by NodeContract.inputRequirements.fromTrigger)
 */

export type TriggerType = 'kafka' | 'manual' | 'schedule';

export type TriggerCategory = 'session' | 'message' | 'manual' | 'schedule' | 'other';

export interface TriggerContract {
  id: string;
  type: TriggerType;
  kafkaTopic?: string;
  category: TriggerCategory;
  label: string;
  description: string;
  /** Shape a pipelineInput is guaranteed to have when this trigger fires. */
  outputSchema: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  /** Realistic payload used by the test drawer and dataflow preview. */
  exampleOutput: Record<string, unknown>;
}

const TRIGGER_TYPES: ReadonlySet<TriggerType> = new Set(['kafka', 'manual', 'schedule']);
const TRIGGER_CATEGORIES: ReadonlySet<TriggerCategory> = new Set([
  'session',
  'message',
  'manual',
  'schedule',
  'other',
]);

export function isValidTriggerContract(value: unknown): value is TriggerContract {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.type !== 'string' || !TRIGGER_TYPES.has(v.type as TriggerType)) return false;
  if (v.kafkaTopic !== undefined && typeof v.kafkaTopic !== 'string') return false;
  if (typeof v.category !== 'string' || !TRIGGER_CATEGORIES.has(v.category as TriggerCategory))
    return false;
  if (typeof v.label !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  const out = v.outputSchema as Record<string, unknown> | undefined;
  if (!out || typeof out !== 'object') return false;
  if (!Array.isArray(out.required)) return false;
  if (!out.properties || typeof out.properties !== 'object') return false;
  if (!v.exampleOutput || typeof v.exampleOutput !== 'object') return false;
  return true;
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- trigger-contract.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 1.5: Format + commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/pipeline/contracts/trigger-contract.ts \
  packages/pipeline-engine/src/__tests__/contracts/trigger-contract.test.ts
git add \
  packages/pipeline-engine/src/pipeline/contracts/trigger-contract.ts \
  packages/pipeline-engine/src/__tests__/contracts/trigger-contract.test.ts
git commit -m "[ABLP-564] feat(pipeline-engine): add TriggerContract type and guard"
```

---

## Task 2 — `DestinationContract` + `DESTINATION_REGISTRY`

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/contracts/destination-contract.ts`
- Test: `packages/pipeline-engine/src/__tests__/contracts/destination-contract.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `packages/pipeline-engine/src/__tests__/contracts/destination-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DESTINATION_REGISTRY,
  isDestinationId,
  type DestinationId,
} from '../../pipeline/contracts/destination-contract.js';

describe('DestinationContract / DESTINATION_REGISTRY', () => {
  it('exposes exactly the four known destinations', () => {
    const ids = Object.keys(DESTINATION_REGISTRY).sort();
    expect(ids).toEqual(['callback', 'clickhouse', 'mongodb', 'none']);
  });

  it('marks only clickhouse as previewable', () => {
    expect(DESTINATION_REGISTRY.clickhouse.previewable).toBe(true);
    expect(DESTINATION_REGISTRY.mongodb.previewable).toBe(false);
    expect(DESTINATION_REGISTRY.callback.previewable).toBe(false);
    expect(DESTINATION_REGISTRY.none.previewable).toBe(false);
  });

  it('validates ClickHouse table format as database.table', () => {
    const regex = DESTINATION_REGISTRY.clickhouse.table.regex!;
    expect(regex.test('abl_platform.conversation_sentiment')).toBe(true);
    expect(regex.test('test_custom_politeness')).toBe(false);
    expect(regex.test('abl_platform.')).toBe(false);
    expect(regex.test('.foo')).toBe(false);
  });

  it('validates MongoDB collection format as bare identifier', () => {
    const regex = DESTINATION_REGISTRY.mongodb.table.regex!;
    expect(regex.test('test_custom_politeness')).toBe(true);
    expect(regex.test('abl_platform.conversation_sentiment')).toBe(false);
  });

  it('requires outputSchema only for ClickHouse', () => {
    expect(DESTINATION_REGISTRY.clickhouse.requiresOutputSchema).toBe(true);
    expect(DESTINATION_REGISTRY.mongodb.requiresOutputSchema).toBe(false);
  });

  it('isDestinationId narrows only for known IDs', () => {
    expect(isDestinationId('clickhouse')).toBe(true);
    expect(isDestinationId('postgres')).toBe(false);
    expect(isDestinationId(undefined)).toBe(false);
  });

  it('DestinationId literal union contains all registry keys', () => {
    const _typeCheck: DestinationId = 'clickhouse';
    expect(_typeCheck).toBe('clickhouse');
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- destination-contract.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 2.3: Write the contract + registry**

Create `packages/pipeline-engine/src/pipeline/contracts/destination-contract.ts`:

```ts
/**
 * DestinationContract — typed contract for the target of a store-results node.
 *
 * Source of truth for:
 *   - store-results config UX (destination enum, dependent field rules)
 *   - Preview tab filter (only `previewable: true` destinations show up)
 *   - table-name format validation
 */

export type DestinationId = 'clickhouse' | 'mongodb' | 'callback' | 'none';

export type TableFormat = 'database.table' | 'collection' | 'url' | 'none';

export interface DestinationContract {
  id: DestinationId;
  label: string;
  table: {
    format: TableFormat;
    regex?: RegExp;
    required: boolean;
    /** Human-readable field label in the Studio config form. */
    labelText: string;
  };
  /** True iff the Observability Preview tab can read from this destination. */
  previewable: boolean;
  /** True iff the store-results config must declare an outputSchema for this destination. */
  requiresOutputSchema: boolean;
  /** Which other store-results config fields appear/disappear based on this destination. */
  dependentFields: Array<{
    field: string;
    visibility: 'required' | 'optional' | 'hidden';
  }>;
}

export const DESTINATION_REGISTRY: Readonly<Record<DestinationId, DestinationContract>> = {
  clickhouse: {
    id: 'clickhouse',
    label: 'ClickHouse',
    table: {
      format: 'database.table',
      regex: /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/,
      required: true,
      labelText: 'ClickHouse table (database.table)',
    },
    previewable: true,
    requiresOutputSchema: true,
    dependentFields: [
      { field: 'table', visibility: 'required' },
      { field: 'outputSchema', visibility: 'required' },
      { field: 'sourceStep', visibility: 'optional' },
      { field: 'source', visibility: 'optional' },
    ],
  },
  mongodb: {
    id: 'mongodb',
    label: 'MongoDB',
    table: {
      format: 'collection',
      regex: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
      required: true,
      labelText: 'MongoDB collection',
    },
    previewable: false,
    requiresOutputSchema: false,
    dependentFields: [
      { field: 'table', visibility: 'required' },
      { field: 'collection', visibility: 'optional' },
      { field: 'sourceStep', visibility: 'optional' },
      { field: 'document', visibility: 'optional' },
    ],
  },
  callback: {
    id: 'callback',
    label: 'Callback URL',
    table: {
      format: 'url',
      required: true,
      labelText: 'Callback URL',
    },
    previewable: false,
    requiresOutputSchema: false,
    dependentFields: [{ field: 'callbackUrl', visibility: 'required' }],
  },
  none: {
    id: 'none',
    label: 'None (handled by compute step)',
    table: {
      format: 'none',
      required: false,
      labelText: '(not applicable)',
    },
    previewable: false,
    requiresOutputSchema: false,
    dependentFields: [],
  },
};

const DESTINATION_IDS: ReadonlySet<string> = new Set(Object.keys(DESTINATION_REGISTRY));

export function isDestinationId(value: unknown): value is DestinationId {
  return typeof value === 'string' && DESTINATION_IDS.has(value);
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- destination-contract.test.ts
```

Expected: 7 passing tests.

- [ ] **Step 2.5: Format + commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/pipeline/contracts/destination-contract.ts \
  packages/pipeline-engine/src/__tests__/contracts/destination-contract.test.ts
git add \
  packages/pipeline-engine/src/pipeline/contracts/destination-contract.ts \
  packages/pipeline-engine/src/__tests__/contracts/destination-contract.test.ts
git commit -m "[ABLP-564] feat(pipeline-engine): add DestinationContract and DESTINATION_REGISTRY"
```

---

## Task 3 — `NodeContract` + per-node enrichment data

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/contracts/node-contract.ts`
- Create: `packages/pipeline-engine/src/pipeline/contracts/node-contract-data.ts`
- Test: `packages/pipeline-engine/src/__tests__/contracts/node-contract.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `packages/pipeline-engine/src/__tests__/contracts/node-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isValidNodeContract, type NodeContract } from '../../pipeline/contracts/node-contract.js';
import { NODE_ENRICHMENT } from '../../pipeline/contracts/node-contract-data.js';
import { activityMetadata } from '../../pipeline/activity-metadata.js';

describe('NodeContract', () => {
  const valid: NodeContract = {
    type: 'read-conversation',
    category: 'data',
    label: 'Read Conversation',
    description: 'x',
    inputRequirements: { fromTrigger: ['sessionId'] },
    configSchema: { required: [], properties: {} },
    outputSchema: { properties: { transcript: { type: 'string' } } },
    compatibleTriggers: ['session-ended'],
    sideEffectClass: 'read',
    contractVersion: 1,
  };

  it('accepts a well-formed contract', () => {
    expect(isValidNodeContract(valid)).toBe(true);
  });

  it("accepts '*' as compatibleTriggers", () => {
    expect(isValidNodeContract({ ...valid, compatibleTriggers: '*' })).toBe(true);
  });

  it('rejects an unknown sideEffectClass', () => {
    expect(
      isValidNodeContract({
        ...valid,
        sideEffectClass: 'magic' as unknown as NodeContract['sideEffectClass'],
      }),
    ).toBe(false);
  });

  it('rejects contractVersion < 1', () => {
    expect(isValidNodeContract({ ...valid, contractVersion: 0 })).toBe(false);
  });
});

describe('NODE_ENRICHMENT coverage', () => {
  it('has an entry for every node in activityMetadata', () => {
    const metaKeys = Object.keys(activityMetadata).sort();
    const enrichmentKeys = Object.keys(NODE_ENRICHMENT).sort();
    expect(enrichmentKeys).toEqual(metaKeys);
  });

  it('read-message-window requires payload from trigger', () => {
    expect(NODE_ENRICHMENT['read-message-window'].inputRequirements.fromTrigger).toContain(
      'payload',
    );
  });

  it('read-message-window is only compatible with message-level triggers', () => {
    expect(NODE_ENRICHMENT['read-message-window'].compatibleTriggers).toEqual([
      'user-message',
      'agent-message',
    ]);
  });

  it('store-results has write side-effect class', () => {
    expect(NODE_ENRICHMENT['store-results'].sideEffectClass).toBe('write');
  });

  it('http-request has external side-effect class', () => {
    expect(NODE_ENRICHMENT['http-request'].sideEffectClass).toBe('external');
  });

  it('every enrichment entry has contractVersion >= 1', () => {
    for (const key of Object.keys(NODE_ENRICHMENT)) {
      expect(NODE_ENRICHMENT[key].contractVersion).toBeGreaterThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- node-contract.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3.3: Write the node-contract type**

Create `packages/pipeline-engine/src/pipeline/contracts/node-contract.ts`:

```ts
/**
 * NodeContract — strict typed contract per node type.
 *
 * Source of truth for:
 *   - node palette filtering by active trigger
 *   - save-time trigger↔node validation
 *   - expression autocomplete (upstream outputSchema lookups)
 *   - expression reference validation
 *   - dataflow-preview eligibility (via sideEffectClass)
 */

import type { NodeCategory, ConfigField } from '../types.js';

export type SideEffectClass = 'pure' | 'read' | 'write' | 'external';

export interface NodeContract {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;

  /** What the node reads. */
  inputRequirements: {
    /** Keys consumed directly from pipelineInput (i.e. from the trigger). */
    fromTrigger: string[];
    /** Upstream step output fields read by convention; placeholder key maps to field list. */
    fromPreviousSteps?: Record<string, string[]>;
  };

  /** Config schema (keeps the existing shape). */
  configSchema: {
    required: string[];
    properties: Record<string, ConfigField | { type: string; description?: string }>;
  };

  /** Output schema — powers expression autocomplete for downstream nodes. */
  outputSchema: {
    properties: Record<string, { type: string; description?: string }>;
  };

  /** Trigger allowlist. '*' means "works with any trigger." */
  compatibleTriggers: string[] | '*';

  /** Tells the dataflow-preview engine what is safe to re-execute. */
  sideEffectClass: SideEffectClass;

  /** Bumped whenever the contract tightens. Pipelines stamp this at save time. */
  contractVersion: number;

  defaultTimeout?: number;
  defaultRetries?: number;
}

const SIDE_EFFECT_CLASSES: ReadonlySet<SideEffectClass> = new Set([
  'pure',
  'read',
  'write',
  'external',
]);

export function isValidNodeContract(value: unknown): value is NodeContract {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string' || v.type.length === 0) return false;
  if (typeof v.category !== 'string') return false;
  if (typeof v.label !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  const input = v.inputRequirements as Record<string, unknown> | undefined;
  if (!input || !Array.isArray(input.fromTrigger)) return false;
  const cfg = v.configSchema as Record<string, unknown> | undefined;
  if (
    !cfg ||
    !Array.isArray(cfg.required) ||
    !cfg.properties ||
    typeof cfg.properties !== 'object'
  ) {
    return false;
  }
  const out = v.outputSchema as Record<string, unknown> | undefined;
  if (!out || !out.properties || typeof out.properties !== 'object') return false;
  if (v.compatibleTriggers !== '*' && !Array.isArray(v.compatibleTriggers)) return false;
  if (
    typeof v.sideEffectClass !== 'string' ||
    !SIDE_EFFECT_CLASSES.has(v.sideEffectClass as SideEffectClass)
  ) {
    return false;
  }
  if (typeof v.contractVersion !== 'number' || v.contractVersion < 1) return false;
  return true;
}
```

- [ ] **Step 3.4: Write the enrichment data**

Create `packages/pipeline-engine/src/pipeline/contracts/node-contract-data.ts`:

```ts
/**
 * Per-node enrichment data.
 *
 * The `activity-metadata.ts` file provides label/description/configSchema/outputSchema/
 * defaultTimeout/defaultRetries for each node type. This file adds the new contract
 * fields that were not previously captured:
 *   - inputRequirements (what the node reads from trigger vs upstream steps)
 *   - compatibleTriggers (trigger allowlist)
 *   - sideEffectClass (read / write / external / pure)
 *   - contractVersion
 *
 * Together, activityMetadata + NODE_ENRICHMENT produce a full NodeContract. The
 * ContractRegistry does that merge.
 *
 * Adding a new node type requires:
 *   1. An entry in activity-metadata.ts (existing pattern).
 *   2. An entry here with enrichment fields.
 *   An integration test in registry.integration.test.ts enforces coverage.
 */

import type { SideEffectClass } from './node-contract.js';

export interface NodeEnrichment {
  inputRequirements: {
    fromTrigger: string[];
    fromPreviousSteps?: Record<string, string[]>;
  };
  compatibleTriggers: string[] | '*';
  sideEffectClass: SideEffectClass;
  contractVersion: number;
}

/**
 * Initial enrichment values (contractVersion 1).
 *
 * Guidelines used when authoring these entries:
 *   - fromTrigger lists only keys the node *requires* from pipelineInput.
 *   - compatibleTriggers is '*' unless the node genuinely cannot work with a trigger
 *     (e.g. read-message-window needs a message-level trigger).
 *   - sideEffectClass: 'read' for DB/HTTP reads, 'write' for persistence, 'external'
 *     for outbound calls (LLM, email, slack, http-request), 'pure' otherwise.
 */
export const NODE_ENRICHMENT: Record<string, NodeEnrichment> = {
  // ── Data (read) ──────────────────────────────────────────────────────
  'read-conversation': {
    inputRequirements: { fromTrigger: ['sessionId'] },
    compatibleTriggers: ['session-ended', 'user-message', 'agent-message', 'manual'],
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'read-message-window': {
    inputRequirements: { fromTrigger: ['sessionId', 'payload'] },
    compatibleTriggers: ['user-message', 'agent-message'],
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'db-query': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'wait-for-event': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },

  // ── Compute (read) ───────────────────────────────────────────────────
  'compute-quality': {
    inputRequirements: {
      fromTrigger: [],
      fromPreviousSteps: { upstream: ['transcript', 'messages'] },
    },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-sentiment': {
    inputRequirements: {
      fromTrigger: [],
      fromPreviousSteps: { upstream: ['transcript', 'messages'] },
    },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-intent': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-mentions': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-toxicity': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-goal-completion': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-statistical': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-predictive-features': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-tool-effectiveness': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'evaluate-metrics': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'evaluate-policy': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'aggregate-eval-run': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },

  // ── External calls ───────────────────────────────────────────────────
  'llm-evaluate': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'conversation-analyzer': {
    inputRequirements: {
      fromTrigger: [],
      fromPreviousSteps: { upstream: ['transcript', 'messages'] },
    },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'http-request': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'send-notification': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'send-email': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'send-slack': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'publish-kafka': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'run-legacy-workflow': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'sub-pipeline': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'simulate-persona': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'execute-agent-turn': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'run-eval-conversation': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'judge-conversation': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },

  // ── Write ────────────────────────────────────────────────────────────
  'store-results': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'write',
    contractVersion: 1,
  },
  'store-insight': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'write',
    contractVersion: 1,
  },

  // ── Pure control flow ────────────────────────────────────────────────
  'node-group': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'pure',
    contractVersion: 1,
  },
};
```

- [ ] **Step 3.5: Run test to verify it passes**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- node-contract.test.ts
```

Expected: all passing. If the `NODE_ENRICHMENT coverage` test fails because a new node type was added to `activity-metadata.ts` but not here, add the missing enrichment entry.

- [ ] **Step 3.6: Format + commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/pipeline/contracts/node-contract.ts \
  packages/pipeline-engine/src/pipeline/contracts/node-contract-data.ts \
  packages/pipeline-engine/src/__tests__/contracts/node-contract.test.ts
git add \
  packages/pipeline-engine/src/pipeline/contracts/node-contract.ts \
  packages/pipeline-engine/src/pipeline/contracts/node-contract-data.ts \
  packages/pipeline-engine/src/__tests__/contracts/node-contract.test.ts
git commit -m "[ABLP-564] feat(pipeline-engine): add NodeContract type and per-node enrichment data"
```

---

## Task 4 — `ContractRegistry` class

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/contracts/registry.ts`
- Test: `packages/pipeline-engine/src/__tests__/contracts/registry.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `packages/pipeline-engine/src/__tests__/contracts/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ContractRegistry } from '../../pipeline/contracts/registry.js';

describe('ContractRegistry', () => {
  const registry = new ContractRegistry();

  it('hydrates triggers from seed-data/trigger-definitions.json', () => {
    const sessionEnded = registry.getTrigger('session-ended');
    expect(sessionEnded).toBeDefined();
    expect(sessionEnded!.id).toBe('session-ended');
    expect(sessionEnded!.type).toBe('kafka');
    expect(sessionEnded!.outputSchema.required).toContain('sessionId');
  });

  it('hydrates nodes by merging activityMetadata and NODE_ENRICHMENT', () => {
    const readConv = registry.getNode('read-conversation');
    expect(readConv).toBeDefined();
    expect(readConv!.type).toBe('read-conversation');
    expect(readConv!.inputRequirements.fromTrigger).toContain('sessionId');
    expect(readConv!.sideEffectClass).toBe('read');
    expect(readConv!.contractVersion).toBe(1);
    // preserves fields from activityMetadata:
    expect(readConv!.label).toBeTruthy();
    expect(readConv!.outputSchema.properties).toBeDefined();
  });

  it('hydrates destinations from DESTINATION_REGISTRY', () => {
    const ch = registry.getDestination('clickhouse');
    expect(ch).toBeDefined();
    expect(ch!.previewable).toBe(true);

    const mongo = registry.getDestination('mongodb');
    expect(mongo!.previewable).toBe(false);
  });

  it('getDestination returns undefined for unknown IDs', () => {
    expect(registry.getDestination('postgres')).toBeUndefined();
    expect(registry.getDestination(undefined as unknown as string)).toBeUndefined();
  });

  it('listTriggers / listNodes / listDestinations return non-empty arrays', () => {
    expect(registry.listTriggers().length).toBeGreaterThan(0);
    expect(registry.listNodes().length).toBeGreaterThan(0);
    expect(registry.listDestinations().length).toBe(4);
  });

  it('every returned NodeContract passes isValidNodeContract', async () => {
    const { isValidNodeContract } = await import('../../pipeline/contracts/node-contract.js');
    for (const node of registry.listNodes()) {
      expect(isValidNodeContract(node)).toBe(true);
    }
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- registry.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 4.3: Write the registry**

Create `packages/pipeline-engine/src/pipeline/contracts/registry.ts`:

```ts
/**
 * ContractRegistry — single lookup surface for TriggerContract / NodeContract /
 * DestinationContract. Hydrates from existing data sources without modifying them.
 *
 * Data sources:
 *   - seed-data/trigger-definitions.json    (existing)
 *   - activity-metadata.ts                  (existing)
 *   - contracts/node-contract-data.ts       (new — enrichment)
 *   - contracts/destination-contract.ts     (new — DESTINATION_REGISTRY)
 */

import type { NodeCategory } from '../types.js';
import { activityMetadata } from '../activity-metadata.js';
import triggerDefinitions from '../seed-data/trigger-definitions.json' with { type: 'json' };

import type { TriggerContract, TriggerCategory, TriggerType } from './trigger-contract.js';
import type { NodeContract } from './node-contract.js';
import {
  DESTINATION_REGISTRY,
  isDestinationId,
  type DestinationContract,
  type DestinationId,
} from './destination-contract.js';
import { NODE_ENRICHMENT } from './node-contract-data.js';

// A raw trigger definition from seed-data may omit `exampleOutput` until Task 6
// lands. Until then, we fall back to a minimal synthesized payload so the registry
// still produces a valid contract.
interface RawTriggerDefinition {
  id: string;
  type: TriggerType;
  kafkaTopic?: string;
  category: TriggerCategory | string;
  label: string;
  description: string;
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  exampleOutput?: Record<string, unknown>;
}

function normaliseCategory(value: string): TriggerCategory {
  if (value === 'session' || value === 'message' || value === 'manual' || value === 'schedule') {
    return value;
  }
  return 'other';
}

function synthesizeExampleOutput(required: string[]): Record<string, unknown> {
  // Minimal placeholders per commonly-required field; used only as a fallback.
  const payload: Record<string, unknown> = {};
  for (const field of required) {
    if (field === 'tenantId') payload[field] = 'tenant-dev-001';
    else if (field === 'sessionId') payload[field] = 'sess-example-001';
    else if (field === 'projectId') payload[field] = 'proj-example';
    else payload[field] = '';
  }
  return payload;
}

export class ContractRegistry {
  private readonly triggers = new Map<string, TriggerContract>();
  private readonly nodes = new Map<string, NodeContract>();
  private readonly destinations = new Map<DestinationId, DestinationContract>(
    Object.entries(DESTINATION_REGISTRY).map(([id, contract]) => [id as DestinationId, contract]),
  );

  constructor() {
    this.hydrateTriggers();
    this.hydrateNodes();
  }

  getTrigger(id: string): TriggerContract | undefined {
    return this.triggers.get(id);
  }

  getNode(type: string): NodeContract | undefined {
    return this.nodes.get(type);
  }

  getDestination(id: unknown): DestinationContract | undefined {
    if (!isDestinationId(id)) return undefined;
    return this.destinations.get(id);
  }

  listTriggers(): TriggerContract[] {
    return Array.from(this.triggers.values());
  }

  listNodes(): NodeContract[] {
    return Array.from(this.nodes.values());
  }

  listDestinations(): DestinationContract[] {
    return Array.from(this.destinations.values());
  }

  private hydrateTriggers(): void {
    const defs = triggerDefinitions as RawTriggerDefinition[];
    for (const def of defs) {
      const required = def.inputSchema?.required ?? [];
      const properties = def.inputSchema?.properties ?? {};
      const contract: TriggerContract = {
        id: def.id,
        type: def.type,
        kafkaTopic: def.kafkaTopic,
        category: normaliseCategory(def.category),
        label: def.label,
        description: def.description,
        outputSchema: { required, properties },
        exampleOutput: def.exampleOutput ?? synthesizeExampleOutput(required),
      };
      this.triggers.set(contract.id, contract);
    }
  }

  private hydrateNodes(): void {
    for (const [type, meta] of Object.entries(activityMetadata)) {
      const enrichment = NODE_ENRICHMENT[type];
      if (!enrichment) {
        // Safety net — a node in activityMetadata with no enrichment is a bug the
        // coverage test in node-contract.test.ts should catch first. Skip silently
        // here so the registry remains usable for the rest of the nodes.
        continue;
      }
      const contract: NodeContract = {
        type,
        category: (meta as unknown as { category?: NodeCategory }).category ?? 'compute',
        label: (meta as unknown as { name?: string }).name ?? type,
        description: (meta as unknown as { description?: string }).description ?? '',
        inputRequirements: enrichment.inputRequirements,
        configSchema: (meta as unknown as NodeContract['configSchema']).configSchema ?? {
          required: [],
          properties: {},
        },
        outputSchema: (meta as unknown as NodeContract['outputSchema']).outputSchema ?? {
          properties: {},
        },
        compatibleTriggers: enrichment.compatibleTriggers,
        sideEffectClass: enrichment.sideEffectClass,
        contractVersion: enrichment.contractVersion,
        defaultTimeout: (meta as unknown as { defaultTimeout?: number }).defaultTimeout,
        defaultRetries: (meta as unknown as { defaultRetries?: number }).defaultRetries,
      };
      this.nodes.set(type, contract);
    }
  }
}
```

- [ ] **Step 4.4: Run test to verify it passes**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- registry.test.ts
```

Expected: all 6 tests pass. If the "every returned NodeContract passes isValidNodeContract" test fails, inspect which node is broken and fix its enrichment or adjust `hydrateNodes` field plumbing.

- [ ] **Step 4.5: Format + commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/pipeline/contracts/registry.ts \
  packages/pipeline-engine/src/__tests__/contracts/registry.test.ts
git add \
  packages/pipeline-engine/src/pipeline/contracts/registry.ts \
  packages/pipeline-engine/src/__tests__/contracts/registry.test.ts
git commit -m "[ABLP-564] feat(pipeline-engine): add ContractRegistry lookup surface"
```

---

## Task 5 — Barrel + package exports

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/contracts/index.ts`
- Modify: `packages/pipeline-engine/src/index.ts`
- Modify: `packages/pipeline-engine/package.json` (exports map)

- [ ] **Step 5.1: Write the barrel test**

Append to `packages/pipeline-engine/src/__tests__/contracts/registry.test.ts` (same file as Task 4, after the existing `describe`):

```ts
describe('contracts barrel', () => {
  it('re-exports the public types and registry', async () => {
    const mod = await import('../../pipeline/contracts/index.js');
    expect(mod.ContractRegistry).toBeDefined();
    expect(mod.DESTINATION_REGISTRY).toBeDefined();
    expect(mod.isDestinationId).toBeDefined();
    expect(mod.isValidTriggerContract).toBeDefined();
    expect(mod.isValidNodeContract).toBeDefined();
    expect(mod.NODE_ENRICHMENT).toBeDefined();
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- registry.test.ts
```

Expected: FAIL with `Cannot find module '../../pipeline/contracts/index.js'`.

- [ ] **Step 5.3: Write the barrel**

Create `packages/pipeline-engine/src/pipeline/contracts/index.ts`:

```ts
export type { TriggerContract, TriggerType, TriggerCategory } from './trigger-contract.js';
export { isValidTriggerContract } from './trigger-contract.js';

export type { NodeContract, SideEffectClass } from './node-contract.js';
export { isValidNodeContract } from './node-contract.js';

export type { DestinationContract, DestinationId, TableFormat } from './destination-contract.js';
export { DESTINATION_REGISTRY, isDestinationId } from './destination-contract.js';

export type { NodeEnrichment } from './node-contract-data.js';
export { NODE_ENRICHMENT } from './node-contract-data.js';

export { ContractRegistry } from './registry.js';
```

- [ ] **Step 5.4: Run the barrel test**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- registry.test.ts
```

Expected: all tests pass including the new barrel test.

- [ ] **Step 5.5: Re-export from package root**

Edit `packages/pipeline-engine/src/index.ts`. Find the last export statement and append:

```ts
// Contracts (Phase 1 of custom-pipeline UX redesign — ABLP-564)
export * from './pipeline/contracts/index.js';
```

- [ ] **Step 5.6: Add the subpath export**

Edit `packages/pipeline-engine/package.json`. Inside the `"exports"` map, add a new entry after `"./metadata"`:

```json
    "./contracts": {
      "types": "./dist/pipeline/contracts/index.d.ts",
      "import": "./dist/pipeline/contracts/index.js",
      "default": "./dist/pipeline/contracts/index.js"
    },
```

- [ ] **Step 5.7: Build the package to ensure types export cleanly**

```bash
pnpm --filter @agent-platform/pipeline-engine build
```

Expected: build succeeds. If TypeScript complains about a missing declaration in `dist`, verify the `contracts/` directory was traversed by the compiler (it should be — all sources under `src` are included by the existing tsconfig).

- [ ] **Step 5.8: Format + commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/pipeline/contracts/index.ts \
  packages/pipeline-engine/src/index.ts \
  packages/pipeline-engine/package.json \
  packages/pipeline-engine/src/__tests__/contracts/registry.test.ts
git add \
  packages/pipeline-engine/src/pipeline/contracts/index.ts \
  packages/pipeline-engine/src/index.ts \
  packages/pipeline-engine/package.json \
  packages/pipeline-engine/src/__tests__/contracts/registry.test.ts
git commit -m "[ABLP-564] feat(pipeline-engine): expose contracts via package barrel and ./contracts subpath"
```

---

## Task 6 — Add `exampleOutput` to every trigger definition

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json`
- Test: `packages/pipeline-engine/src/__tests__/contracts/registry.test.ts` (extend existing)

- [ ] **Step 6.1: Write the failing test**

Append to `packages/pipeline-engine/src/__tests__/contracts/registry.test.ts`:

```ts
describe('TriggerContract exampleOutput', () => {
  const registry = new ContractRegistry();

  it('session-ended has example payload with tenantId + sessionId', () => {
    const ex = registry.getTrigger('session-ended')!.exampleOutput;
    expect(ex.tenantId).toBeDefined();
    expect(ex.sessionId).toBeDefined();
  });

  it('user-message includes a nested payload with role, content, messageId', () => {
    const ex = registry.getTrigger('user-message')!.exampleOutput;
    expect(ex.payload).toMatchObject({
      role: 'user',
      content: expect.any(String),
      messageId: expect.any(String),
      messageIndex: expect.any(Number),
    });
  });

  it('agent-message includes a nested payload with role: assistant', () => {
    const ex = registry.getTrigger('agent-message')!.exampleOutput;
    expect((ex.payload as { role?: string }).role).toBe('assistant');
  });

  it('every trigger has a non-empty exampleOutput sourced from JSON (not synthesized)', async () => {
    // Import the raw JSON to confirm the new field is present at source,
    // not filled in by the synthesize fallback.
    const defs = (
      await import('../../pipeline/seed-data/trigger-definitions.json', { with: { type: 'json' } })
    ).default as Array<Record<string, unknown>>;
    for (const def of defs) {
      expect(def.exampleOutput, `${def.id} missing exampleOutput in JSON`).toBeDefined();
    }
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- registry.test.ts
```

Expected: the "every trigger has a non-empty exampleOutput" test fails because no entries have `exampleOutput` yet.

- [ ] **Step 6.3: Add `exampleOutput` to every trigger**

Replace the entire contents of `packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json` with:

```json
[
  {
    "id": "session-ended",
    "type": "kafka",
    "kafkaTopic": "abl.session.ended",
    "category": "session",
    "label": "Session Ended",
    "description": "Fires when a conversation session ends. Use for batch analysis of complete conversations.",
    "inputSchema": {
      "required": ["tenantId", "sessionId"],
      "properties": {
        "tenantId": { "type": "string", "description": "Tenant ID from session event" },
        "sessionId": { "type": "string", "description": "Session ID to analyze" }
      }
    },
    "exampleOutput": {
      "tenantId": "tenant-dev-001",
      "sessionId": "sess-abc-123"
    }
  },
  {
    "id": "user-message",
    "type": "kafka",
    "kafkaTopic": "abl.message.user",
    "category": "message",
    "label": "User Message Received",
    "description": "Fires on each incoming user message. Use for real-time analysis and detection.",
    "inputSchema": {
      "required": ["tenantId", "sessionId"],
      "properties": {
        "tenantId": { "type": "string", "description": "Tenant ID from message event" },
        "sessionId": { "type": "string", "description": "Session the message belongs to" }
      }
    },
    "exampleOutput": {
      "tenantId": "tenant-dev-001",
      "sessionId": "sess-abc-123",
      "payload": {
        "role": "user",
        "content": "Hello, I can't log in to my account.",
        "messageId": "msg-user-001",
        "messageIndex": 0
      }
    }
  },
  {
    "id": "agent-message",
    "type": "kafka",
    "kafkaTopic": "abl.message.agent",
    "category": "message",
    "label": "Agent Message Sent",
    "description": "Fires on each outgoing agent message. Use for response quality checks and guardrails.",
    "inputSchema": {
      "required": ["tenantId", "sessionId"],
      "properties": {
        "tenantId": { "type": "string", "description": "Tenant ID from message event" },
        "sessionId": { "type": "string", "description": "Session the message belongs to" }
      }
    },
    "exampleOutput": {
      "tenantId": "tenant-dev-001",
      "sessionId": "sess-abc-123",
      "payload": {
        "role": "assistant",
        "content": "I'd be happy to help you recover your account. Can you share the email address?",
        "messageId": "msg-agent-001",
        "messageIndex": 1
      }
    }
  },
  {
    "id": "manual",
    "type": "manual",
    "category": "other",
    "label": "Manual Trigger",
    "description": "Trigger the pipeline on demand via the API or Studio UI.",
    "inputSchema": {
      "required": ["tenantId"],
      "properties": {
        "tenantId": { "type": "string", "description": "Tenant ID" }
      }
    },
    "exampleOutput": {
      "tenantId": "tenant-dev-001"
    }
  },
  {
    "id": "schedule",
    "type": "schedule",
    "category": "other",
    "label": "Scheduled",
    "description": "Run the pipeline on a recurring schedule using a cron expression.",
    "inputSchema": {
      "required": ["tenantId"],
      "properties": {
        "tenantId": { "type": "string", "description": "Tenant ID" }
      }
    },
    "exampleOutput": {
      "tenantId": "tenant-dev-001"
    }
  }
]
```

- [ ] **Step 6.4: Run tests to verify they pass**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- registry.test.ts
```

Expected: all tests pass.

- [ ] **Step 6.5: Format + commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json \
  packages/pipeline-engine/src/__tests__/contracts/registry.test.ts
git add \
  packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json \
  packages/pipeline-engine/src/__tests__/contracts/registry.test.ts
git commit -m "[ABLP-564] feat(pipeline-engine): add exampleOutput to every trigger definition"
```

---

## Task 7 — Registry integration test + package learnings

**Files:**

- Create: `packages/pipeline-engine/src/__tests__/contracts/registry.integration.test.ts`
- Modify: `packages/pipeline-engine/agents.md`

- [ ] **Step 7.1: Write the integration test**

Create `packages/pipeline-engine/src/__tests__/contracts/registry.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ContractRegistry } from '../../pipeline/contracts/registry.js';
import { isValidTriggerContract } from '../../pipeline/contracts/trigger-contract.js';
import { isValidNodeContract } from '../../pipeline/contracts/node-contract.js';
import { activityMetadata } from '../../pipeline/activity-metadata.js';

describe('ContractRegistry — end-to-end coverage', () => {
  const registry = new ContractRegistry();

  it('produces a valid TriggerContract for every entry in trigger-definitions.json', () => {
    const triggers = registry.listTriggers();
    expect(triggers.length).toBeGreaterThan(0);
    for (const t of triggers) {
      expect(isValidTriggerContract(t), `${t.id} is not a valid TriggerContract`).toBe(true);
    }
  });

  it('produces a valid NodeContract for every entry in activityMetadata', () => {
    const nodes = registry.listNodes();
    const metaKeys = Object.keys(activityMetadata).sort();
    const nodeTypes = nodes.map((n) => n.type).sort();
    expect(nodeTypes, 'NodeContract coverage must equal activityMetadata keys').toEqual(metaKeys);
    for (const n of nodes) {
      expect(isValidNodeContract(n), `${n.type} is not a valid NodeContract`).toBe(true);
    }
  });

  it('exposes exactly four destinations', () => {
    const ids = registry
      .listDestinations()
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(['callback', 'clickhouse', 'mongodb', 'none']);
  });

  it('every node that writes has sideEffectClass=write', () => {
    const write = new Set(['store-results', 'store-insight']);
    for (const n of registry.listNodes()) {
      if (write.has(n.type)) {
        expect(n.sideEffectClass, `${n.type}`).toBe('write');
      }
    }
  });

  it('every node that calls an external service has sideEffectClass=external', () => {
    const external = new Set([
      'llm-evaluate',
      'conversation-analyzer',
      'http-request',
      'send-notification',
      'send-email',
      'send-slack',
      'publish-kafka',
      'run-legacy-workflow',
      'sub-pipeline',
      'simulate-persona',
      'execute-agent-turn',
      'run-eval-conversation',
      'judge-conversation',
    ]);
    for (const n of registry.listNodes()) {
      if (external.has(n.type)) {
        expect(n.sideEffectClass, `${n.type}`).toBe('external');
      }
    }
  });

  it('read-message-window is gated to message-level triggers only', () => {
    const rmw = registry.getNode('read-message-window')!;
    expect(rmw.compatibleTriggers).toEqual(['user-message', 'agent-message']);
    expect(rmw.inputRequirements.fromTrigger).toContain('payload');
  });

  it('ClickHouse destination table regex matches abl_platform.<table> patterns', () => {
    const ch = registry.getDestination('clickhouse')!;
    expect(ch.table.regex!.test('abl_platform.conversation_sentiment')).toBe(true);
    expect(ch.table.regex!.test('foo_db.bar_table')).toBe(true);
    expect(ch.table.regex!.test('test_custom_politeness')).toBe(false);
  });
});
```

- [ ] **Step 7.2: Run the integration test**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- registry.integration.test.ts
```

Expected: all 7 tests pass. If any fail, the failure message will point to the specific contract entry that needs attention.

- [ ] **Step 7.3: Run the full pipeline-engine test suite**

```bash
pnpm --filter @agent-platform/pipeline-engine build
pnpm --filter @agent-platform/pipeline-engine test
```

Expected: build succeeds, all existing tests pass, all new contract tests pass. No regressions.

- [ ] **Step 7.4: Update package agents.md**

Append to `packages/pipeline-engine/agents.md` (at the end of the file):

```markdown
## 2026-04-24 — ABLP-564 Phase 1: Contract Foundation

**Category**: architecture
**Learning**: Phase 1 of the custom-pipeline UX redesign introduces three typed contracts in `src/pipeline/contracts/`: `TriggerContract`, `NodeContract`, `DestinationContract`, plus a `ContractRegistry` that hydrates from existing sources (`activity-metadata.ts`, `seed-data/trigger-definitions.json`) and two new data files (`node-contract-data.ts` with per-node enrichment, `destination-contract.ts` with `DESTINATION_REGISTRY`). Contracts are the single source of truth going forward for all UX-side validation, autocomplete, preview filtering, and error interpretation. Zero user-visible change in this phase; downstream phases consume the registry.
**Files**: `src/pipeline/contracts/*.ts`, `src/pipeline/seed-data/trigger-definitions.json` (extended with `exampleOutput`), `src/index.ts` (barrel), `package.json` (added `./contracts` subpath export)
**Impact**: New node types must register an entry in BOTH `activity-metadata.ts` (existing shape) AND `contracts/node-contract-data.ts` (enrichment). The `registry.integration.test.ts` enforces coverage. When a contract tightens for an existing node, bump its `contractVersion` in `node-contract-data.ts`.
```

- [ ] **Step 7.5: Format + commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/__tests__/contracts/registry.integration.test.ts \
  packages/pipeline-engine/agents.md
git add \
  packages/pipeline-engine/src/__tests__/contracts/registry.integration.test.ts \
  packages/pipeline-engine/agents.md
git commit -m "[ABLP-564] test(pipeline-engine): add ContractRegistry integration coverage and log package learning"
```

---

## Phase 1 Exit Criteria

Before declaring Phase 1 complete, verify:

- [ ] `pnpm --filter @agent-platform/pipeline-engine build` succeeds.
- [ ] `pnpm --filter @agent-platform/pipeline-engine test` — all tests pass, including the five new contract test files.
- [ ] `pnpm --filter @agent-platform/pipeline-engine typecheck` (if this script exists; otherwise rely on build) — no errors.
- [ ] `pnpm --filter=@agent-platform/pipeline-engine lint` — no new violations.
- [ ] No change to any consumer behaviour: `apps/runtime` and `apps/studio` build unchanged. Run `pnpm build` at repo root — should produce no diff in consumer output beyond the new package barrel.
- [ ] Commit log on `feat/ABLP-564-custom-pipeline-ux-redesign` shows 7 commits prefixed `[ABLP-564]`, each under the 40-file / 3-package commit limits.
- [ ] `packages/pipeline-engine/agents.md` records the Phase 1 learning entry.

## Handoff to Phase 2

Phase 2 (save-time validation + preview filter) consumes the `ContractRegistry` from this phase. Specifically:

- `validateGraphPipeline` will call `registry.getTrigger(def.trigger.id)` + `registry.getNode(firstNode.type)` and cross-check `inputRequirements.fromTrigger` against `outputSchema.required`.
- `findStoreTable` (`apps/runtime/src/services/pipeline-observability/previewable-pipelines-service.ts`) will call `registry.getDestination(storeNode.config.destination)` and early-return `null` when `previewable === false`.

Both consumers can be implemented without further contract changes.
