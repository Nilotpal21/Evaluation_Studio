import { describe, test, expect } from 'vitest';
import type { PipelineDefinition, PipelineNode } from '../pipeline/types.js';
import { buildRunRecordSteps } from '../pipeline/handlers/pipeline-trigger.service.js';

describe('buildRunRecordSteps', () => {
  test('maps nodes to steps for graph pipelines', () => {
    const nodes: PipelineNode[] = [
      { id: 'read', type: 'read-conversation', config: {}, transitions: [{ target: 'store' }] },
      { id: 'store', type: 'store-results', config: {}, transitions: [] },
    ];

    const result = buildRunRecordSteps(
      { nodes, entryNodeId: 'read', steps: [] } as unknown as PipelineDefinition,
      [],
    );

    expect(result).toEqual([
      { id: 'read', name: 'read', type: 'read-conversation', status: 'pending' },
      { id: 'store', name: 'store', type: 'store-results', status: 'pending' },
    ]);
  });

  test('maps nodes with labels to steps', () => {
    const nodes: PipelineNode[] = [
      {
        id: 'read',
        type: 'read-conversation',
        label: 'Read Customer Conversation',
        config: {},
        transitions: [],
      },
    ];

    const result = buildRunRecordSteps(
      { nodes, entryNodeId: 'read', steps: [] } as unknown as PipelineDefinition,
      [],
    );

    expect(result).toEqual([
      {
        id: 'read',
        name: 'Read Customer Conversation',
        type: 'read-conversation',
        status: 'pending',
      },
    ]);
  });

  test('falls back to steps array for non-graph pipelines', () => {
    const steps = [{ id: 's1', name: 'Step 1', type: 'evaluate-metrics', config: {} }];

    const result = buildRunRecordSteps({ steps } as unknown as PipelineDefinition, steps);

    expect(result).toEqual([
      { id: 's1', name: 'Step 1', type: 'evaluate-metrics', status: 'pending' },
    ]);
  });
});
