/**
 * Preview service unit tests (ABLP-564 Phase 7).
 *
 * Uses pure preview-supported nodes so the tests exercise the real preview
 * service without DB or external service calls.
 */

import { describe, expect, it } from 'vitest';
import { previewNode } from '../pipeline/services/preview.service.js';
import type { PipelineNode } from '../pipeline/types.js';

function makePreviewArgs(overrides: Partial<Parameters<typeof previewNode>[0]> = {}) {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    pipelineId: 'pipeline-1',
    sampleSessionId: 'session-1',
    pipelineInput: {},
    triggerId: 'preview-trigger',
    pipelineName: 'Preview Test',
    ...overrides,
  };
}

describe('preview service', () => {
  it('walks the same transition branch as graph execution', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'entry',
        type: 'delay',
        config: { durationMs: 50 },
        transitions: [
          { target: 'matched', condition: 'output.delayed == 50', order: 1 },
          { target: 'unmatched', order: 2 },
        ],
      },
      { id: 'matched', type: 'delay', config: { durationMs: 10 }, transitions: [] },
      { id: 'unmatched', type: 'delay', config: { durationMs: 20 }, transitions: [] },
    ];

    const result = await previewNode(
      makePreviewArgs({ nodes, entryNodeId: 'entry', nodeId: 'matched' }),
    );

    expect(result.status).toBe('success');
    expect(result.output).toMatchObject({ delayed: 10, skipped: 'preview' });
    expect(result.skippedNodes).toEqual(['entry', 'matched']);
  });

  it('reports when the requested node is not reached by transition conditions', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'entry',
        type: 'delay',
        config: { durationMs: 50 },
        transitions: [
          { target: 'matched', condition: 'output.delayed == 50', order: 1 },
          { target: 'unmatched', order: 2 },
        ],
      },
      { id: 'matched', type: 'delay', config: { durationMs: 10 }, transitions: [] },
      { id: 'unmatched', type: 'delay', config: { durationMs: 20 }, transitions: [] },
    ];

    await expect(
      previewNode(makePreviewArgs({ nodes, entryNodeId: 'entry', nodeId: 'unmatched' })),
    ).rejects.toThrow('was not reached');
  });

  it('lets inspect-output read a named upstream node reference', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'entry',
        type: 'delay',
        label: 'Warm Up',
        config: { durationMs: 25 },
        transitions: [{ target: 'inspect' }],
      },
      {
        id: 'inspect',
        type: 'inspect-output',
        config: { sourceStep: 'warm_up', fieldPath: 'delayed' },
        transitions: [],
      },
    ];

    const result = await previewNode(
      makePreviewArgs({ nodes, entryNodeId: 'entry', nodeId: 'inspect' }),
    );

    expect(result.status).toBe('success');
    expect(result.output).toMatchObject({
      sourceStep: 'warm_up',
      fieldPath: 'delayed',
      output: 25,
    });
  });

  it('fails unsupported preview-only nodes instead of silently skipping them', async () => {
    const nodes: PipelineNode[] = [
      { id: 'entry', type: 'wait-for-event', config: { eventName: 'manual' }, transitions: [] },
    ];

    const result = await previewNode(
      makePreviewArgs({ nodes, entryNodeId: 'entry', nodeId: 'entry' }),
    );

    expect(result.status).toBe('fail');
    expect(result.output.error).toBe('This node type is not supported in preview mode');
    expect(result.skippedNodes).toEqual([]);
  });
});
