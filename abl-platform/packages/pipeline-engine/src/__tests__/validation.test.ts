import { describe, test, expect } from 'vitest';
import { validatePipeline, validateGraphPipeline } from '../pipeline/validation.js';
import { NodeRegistry } from '../pipeline/node-registry.js';
import type { PipelineDefinition } from '../pipeline/types.js';

function makePipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    _id: 'pip-1',
    tenantId: 't-1',
    name: 'Test Pipeline',
    version: 1,
    status: 'draft',
    trigger: { type: 'manual' },
    steps: [
      { id: 'step-1', name: 'Step 1', type: 'evaluate-metrics', config: { metrics: ['toxicity'] } },
    ],
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PipelineDefinition;
}

describe('validatePipeline', () => {
  test('valid pipeline returns no errors', () => {
    expect(validatePipeline(makePipeline())).toEqual([]);
  });

  test('empty steps array returns error', () => {
    const errors = validatePipeline(makePipeline({ steps: [], status: 'active' }));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('at least one step');
  });

  test('duplicate step IDs returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          { id: 'dup', name: 'A', type: 'evaluate-metrics', config: { metrics: ['x'] } },
          { id: 'dup', name: 'B', type: 'evaluate-metrics', config: { metrics: ['y'] } },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('Duplicate step ID'))).toBe(true);
  });

  test('unknown activity type returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [{ id: 's1', name: 'S1', type: 'nonexistent-type', config: {} }],
      }),
    );
    expect(errors.some((e) => e.message.includes('Unknown activity type'))).toBe(true);
  });

  test('unsafe expression returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          { id: 's1', name: 'S1', type: 'evaluate-metrics', config: { metrics: ['x'] } },
          {
            id: 's2',
            name: 'S2',
            type: 'transform',
            config: { mapping: {} },
            condition: { expression: "eval('code')" },
          },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('unsupported operations'))).toBe(true);
  });

  test('condition referencing unknown step returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            config: { metrics: ['x'] },
            condition: { expression: "steps.nonexistent.output.status == 'ok'" },
          },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('unknown step'))).toBe(true);
  });

  test('condition referencing later step returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            config: { metrics: ['x'] },
            condition: { expression: "steps.s2.output.status == 'ok'" },
          },
          { id: 's2', name: 'S2', type: 'evaluate-metrics', config: { metrics: ['y'] } },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('not before this step'))).toBe(true);
  });

  test('non-contiguous parallel group returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['x'] },
          },
          { id: 's2', name: 'S2', type: 'evaluate-metrics', config: { metrics: ['y'] } },
          {
            id: 's3',
            name: 'S3',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['z'] },
          },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('not contiguous'))).toBe(true);
  });

  test('contiguous parallel group passes', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['x'] },
          },
          {
            id: 's2',
            name: 'S2',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['y'] },
          },
          {
            id: 's3',
            name: 'S3',
            type: 'store-results',
            config: { destination: 'clickhouse', table: 't' },
          },
        ],
      }),
    );
    expect(errors).toEqual([]);
  });

  test('kafka trigger without topic returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: { type: 'kafka' },
      }),
    );
    expect(errors.some((e) => e.message.includes('kafkaTopic'))).toBe(true);
  });

  test('schedule trigger without cron returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: { type: 'schedule' },
      }),
    );
    expect(errors.some((e) => e.message.includes('schedule'))).toBe(true);
  });

  // --- Scoping filter for abl.* topics ---

  test('abl.* topic without eventFilter returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: { type: 'kafka', kafkaTopic: 'abl.session.created' },
      }),
    );
    expect(errors.some((e) => e.message.includes('eventFilter'))).toBe(true);
  });

  test('abl.* topic with projectId filter passes', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: {
          type: 'kafka',
          kafkaTopic: 'abl.message.user',
          eventFilter: { field: 'projectId', equals: 'proj-1' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('eventFilter'))).toBe(false);
  });

  test('abl.* topic with tenantId filter passes', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: {
          type: 'kafka',
          kafkaTopic: 'abl.session.created',
          eventFilter: { field: 'tenantId', equals: 't-1' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('eventFilter'))).toBe(false);
  });

  test('non-abl topic without eventFilter passes', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: { type: 'kafka', kafkaTopic: 'custom.events' },
      }),
    );
    expect(errors.some((e) => e.message.includes('eventFilter'))).toBe(false);
  });

  test('multi-trigger strategies persisted as a Map validate correctly', () => {
    const strategies = new Map([
      [
        'default',
        {
          executionMode: 'batch' as const,
          steps: [{ id: 'read', type: 'read-conversation', config: {} }],
        },
      ],
    ]);

    const errors = validatePipeline(
      makePipeline({
        status: 'active',
        supportedTriggers: [
          {
            id: 'manual',
            type: 'manual',
            strategy: 'default',
            label: 'Manual Trigger',
            description: 'Run on demand',
          },
        ],
        defaultTriggerIds: ['manual'],
        strategies: strategies as unknown as PipelineDefinition['strategies'],
      }),
    );

    expect(errors).toEqual([]);
  });
});

describe('validatePipeline with registry', () => {
  test('accepts a type from registry not in ACTIVITY_TYPES', () => {
    const registry = new NodeRegistry();
    registry.register({
      type: 'custom-compute',
      category: 'compute',
      label: 'Custom',
      description: 'A custom node',
      configSchema: { fields: [] },
      executionModel: 'async',
    });

    const pipeline: PipelineDefinition = {
      _id: 'test-pipe',
      tenantId: 'tenant1',
      name: 'Test',
      version: 1,
      status: 'active',
      steps: [{ id: 'step1', type: 'custom-compute', config: {} }],
      createdBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const errors = validatePipeline(pipeline, registry);
    const typeErrors = errors.filter((e) => e.message.includes('Unknown activity type'));
    expect(typeErrors).toHaveLength(0);
  });

  test('rejects unknown type even with registry', () => {
    const registry = new NodeRegistry();
    registry.register({
      type: 'custom-compute',
      category: 'compute',
      label: 'Custom',
      description: 'A custom node',
      configSchema: { fields: [] },
      executionModel: 'async',
    });

    const pipeline: PipelineDefinition = {
      _id: 'test-pipe',
      tenantId: 'tenant1',
      name: 'Test',
      version: 1,
      status: 'active',
      steps: [{ id: 'step1', type: 'totally-unknown', config: {} }],
      createdBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const errors = validatePipeline(pipeline, registry);
    const typeErrors = errors.filter((e) => e.message.includes('Unknown activity type'));
    expect(typeErrors).toHaveLength(1);
  });

  test('still works without registry (backward compat)', () => {
    const pipeline: PipelineDefinition = {
      _id: 'test-pipe',
      tenantId: 'tenant1',
      name: 'Test',
      version: 1,
      status: 'active',
      steps: [{ id: 'step1', type: 'compute-toxicity', config: {} }],
      createdBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // No registry passed — falls back to ACTIVITY_TYPES
    const errors = validatePipeline(pipeline);
    const typeErrors = errors.filter((e) => e.message.includes('Unknown activity type'));
    expect(typeErrors).toHaveLength(0);
  });
});

// ── Graph Pipeline Trigger Validation ──

function makeGraphRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register({
    type: 'compute-mentions',
    category: 'compute',
    label: 'Compute Mentions',
    description: 'Counts brand mentions',
    configSchema: { fields: [] },
    executionModel: 'async',
  });
  return registry;
}

function makeGraphPipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    _id: 'graph-pip-1',
    tenantId: 't-1',
    name: 'Graph Test Pipeline',
    version: 1,
    status: 'draft',
    nodes: [
      {
        id: 'node-1',
        type: 'compute-mentions',
        config: {},
        transitions: [],
      },
    ],
    entryNodeId: 'node-1',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PipelineDefinition;
}

describe('validateGraphPipeline trigger validation', () => {
  test('valid kafka trigger with eventFilter passes', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(
      makeGraphPipeline({
        trigger: {
          type: 'kafka',
          kafkaTopic: 'abl.session.created',
          eventFilter: { field: 'projectId', equals: 'proj-1' },
        },
      }),
      registry,
    );
    const triggerErrors = errors.filter((e) => e.field === 'trigger');
    expect(triggerErrors).toHaveLength(0);
  });

  test('manual trigger passes', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(
      makeGraphPipeline({
        trigger: { type: 'manual' },
      }),
      registry,
    );
    const triggerErrors = errors.filter((e) => e.field === 'trigger');
    expect(triggerErrors).toHaveLength(0);
  });

  test('no trigger passes (manual-only)', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(makeGraphPipeline(), registry);
    const triggerErrors = errors.filter((e) => e.field === 'trigger');
    expect(triggerErrors).toHaveLength(0);
  });

  test('kafka trigger without kafkaTopic returns error', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(
      makeGraphPipeline({
        trigger: { type: 'kafka' },
      }),
      registry,
    );
    expect(errors.some((e) => e.field === 'trigger' && e.message.includes('kafkaTopic'))).toBe(
      true,
    );
  });

  test('abl.* topic without eventFilter returns error', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(
      makeGraphPipeline({
        trigger: { type: 'kafka', kafkaTopic: 'abl.session.created' },
      }),
      registry,
    );
    expect(errors.some((e) => e.field === 'trigger' && e.message.includes('eventFilter'))).toBe(
      true,
    );
  });

  test('schedule trigger returns error (not yet supported)', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(
      makeGraphPipeline({
        trigger: { type: 'schedule' },
      }),
      registry,
    );
    expect(
      errors.some((e) => e.field === 'trigger' && e.message.includes('not yet supported')),
    ).toBe(true);
  });

  test('multiple unconditional transitions returns error', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(
      makeGraphPipeline({
        entryNodeId: 'n1',
        nodes: [
          {
            id: 'n1',
            type: 'read-conversation',
            config: {},
            transitions: [{ target: 'n2' }, { target: 'n3' }],
          },
          { id: 'n2', type: 'read-conversation', config: {}, transitions: [] },
          { id: 'n3', type: 'read-conversation', config: {}, transitions: [] },
        ],
      }),
      registry,
    );
    expect(
      errors.some(
        (e) => e.field === 'transitions' && e.message.includes('unconditional transitions'),
      ),
    ).toBe(true);
  });

  test('conditional transitions with one unconditional fallback passes', () => {
    const registry = makeGraphRegistry();
    const { errors } = validateGraphPipeline(
      makeGraphPipeline({
        entryNodeId: 'n1',
        nodes: [
          {
            id: 'n1',
            type: 'read-conversation',
            config: {},
            transitions: [{ target: 'n2', condition: 'output.score > 0.5' }, { target: 'n3' }],
          },
          { id: 'n2', type: 'read-conversation', config: {}, transitions: [] },
          { id: 'n3', type: 'read-conversation', config: {}, transitions: [] },
        ],
      }),
      registry,
    );
    expect(errors.some((e) => e.message.includes('unconditional transitions'))).toBe(false);
  });
});
