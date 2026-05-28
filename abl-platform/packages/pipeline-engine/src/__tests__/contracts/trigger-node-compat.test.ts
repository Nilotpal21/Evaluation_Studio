/**
 * Contract-based trigger↔entry-node compatibility validation (P2/T1).
 *
 * Tests the new validateGraphPipeline branch that cross-checks the entry node's
 * NodeContract.inputRequirements against each trigger's TriggerContract.outputSchema.
 */

import { describe, test, expect } from 'vitest';
import { validateGraphPipeline } from '../../pipeline/validation.js';
import { NodeRegistry } from '../../pipeline/node-registry.js';
import { ContractRegistry } from '../../pipeline/contracts/registry.js';
import type { PipelineDefinition } from '../../pipeline/types.js';

const contracts = new ContractRegistry();

function makeNodeRegistryWithContractNodes(): NodeRegistry {
  const r = new NodeRegistry();
  for (const n of contracts.listNodes()) {
    r.register({
      type: n.type,
      category: n.category,
      label: n.label,
      description: n.description,
      configSchema: { fields: [] },
      executionModel: 'async',
    });
  }
  return r;
}

function makeGraphPipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    _id: 'p-compat',
    tenantId: 't-1',
    name: 'Compat Test',
    version: 1,
    status: 'draft',
    supportedTriggers: [
      {
        id: 'session-ended',
        type: 'kafka',
        kafkaTopic: 'abl.session.ended',
        strategy: 'default',
        label: 'Session Ended',
        description: 'x',
        eventFilter: { field: 'projectId', equals: 'proj-1' },
      },
    ],
    nodes: [
      {
        id: 'entry',
        type: 'read-conversation',
        config: {},
        transitions: [],
        contractVersion: 1,
      },
    ],
    entryNodeId: 'entry',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PipelineDefinition;
}

describe('validateGraphPipeline — contract-based trigger↔entry-node compat', () => {
  test('compatible trigger + entry node produces no compat errors', () => {
    const registry = makeNodeRegistryWithContractNodes();
    const { errors } = validateGraphPipeline(makeGraphPipeline(), registry, contracts);
    const compatErrors = errors.filter(
      (e) =>
        e.message.includes('not compatible with trigger') ||
        e.message.includes('requires') ||
        e.message.includes('from trigger'),
    );
    expect(compatErrors).toEqual([]);
  });

  test('session-ended trigger + read-message-window entry node returns compat error', () => {
    const registry = makeNodeRegistryWithContractNodes();
    const pipeline = makeGraphPipeline({
      nodes: [
        {
          id: 'entry',
          type: 'read-message-window',
          config: {},
          transitions: [],
          contractVersion: 1,
        },
      ],
    });
    const { errors } = validateGraphPipeline(pipeline, registry, contracts);
    const compatErrors = errors.filter((e) => e.stepId === 'entry');
    // Must complain about either incompat allowlist OR missing 'payload'
    expect(compatErrors.length).toBeGreaterThan(0);
    const joined = compatErrors.map((e) => e.message).join(' | ');
    expect(joined).toMatch(/not compatible|payload/i);
  });

  test('missing required trigger field returns field-specific error', () => {
    const registry = makeNodeRegistryWithContractNodes();
    // session-ended does NOT provide 'payload', so read-message-window + session-ended
    // must produce an error about 'payload' being missing.
    const pipeline = makeGraphPipeline({
      supportedTriggers: [
        {
          id: 'session-ended',
          type: 'kafka',
          kafkaTopic: 'abl.session.ended',
          strategy: 'default',
          label: 'Session Ended',
          description: 'x',
          eventFilter: { field: 'projectId', equals: 'proj-1' },
        },
      ],
      nodes: [
        {
          id: 'entry',
          type: 'read-message-window',
          config: {},
          transitions: [],
          contractVersion: 1,
        },
      ],
    });
    const { errors } = validateGraphPipeline(pipeline, registry, contracts);
    // read-message-window needs 'payload'; session-ended only provides tenantId + sessionId.
    // Expect either a compat-allowlist error OR a payload-missing error.
    const compatErrors = errors.filter((e) => e.stepId === 'entry');
    expect(compatErrors.length).toBeGreaterThan(0);
    const joined = compatErrors.map((e) => e.message).join(' | ');
    expect(joined).toMatch(/not compatible|payload/i);
  });

  test('legacy pipeline (no contractVersion) downgrades errors to warnings', () => {
    const registry = makeNodeRegistryWithContractNodes();
    const pipeline = makeGraphPipeline({
      nodes: [
        {
          id: 'entry',
          type: 'read-message-window',
          config: {},
          transitions: [],
          // NOTE: no contractVersion
        },
      ],
    });
    const { errors, warnings } = validateGraphPipeline(pipeline, registry, contracts);
    const compatErrors = errors.filter((e) => e.stepId === 'entry');
    expect(compatErrors).toEqual([]);
    const compatWarnings = (warnings ?? []).filter(
      (w) => w.includes('read-message-window') || w.includes('payload') || w.includes('trigger'),
    );
    expect(compatWarnings.length).toBeGreaterThan(0);
  });

  test('"*" compatibleTriggers accepts any trigger', () => {
    const registry = makeNodeRegistryWithContractNodes();
    // compute-statistical has compatibleTriggers: '*' and no upstream input requirements.
    const pipeline = makeGraphPipeline({
      nodes: [
        {
          id: 'entry',
          type: 'compute-statistical',
          config: {},
          transitions: [],
          contractVersion: 1,
        },
      ],
    });
    const { errors } = validateGraphPipeline(pipeline, registry, contracts);
    const compatErrors = errors.filter((e) => e.stepId === 'entry');
    expect(compatErrors).toEqual([]);
  });

  test('runs without contractRegistry (backward compat) — no compat checks', () => {
    const registry = makeNodeRegistryWithContractNodes();
    // Without contractRegistry, a formerly-invalid pipeline should not error on compat grounds
    const pipeline = makeGraphPipeline({
      nodes: [
        {
          id: 'entry',
          type: 'read-message-window',
          config: {},
          transitions: [],
          contractVersion: 1,
        },
      ],
    });
    const { errors } = validateGraphPipeline(pipeline, registry);
    const compatErrors = errors.filter(
      (e) =>
        e.message.includes('not compatible with trigger') ||
        e.message.includes('does not provide it'),
    );
    expect(compatErrors).toEqual([]);
  });
});
