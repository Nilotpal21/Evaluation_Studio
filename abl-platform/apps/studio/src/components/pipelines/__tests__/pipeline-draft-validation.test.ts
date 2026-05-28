/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { validatePipelineDraft } from '../pipeline-draft-validation';
import { TRIGGER_NODE_ID } from '../pipeline-trigger-constants';

function pipelineNode(id: string, label: string, config: Record<string, unknown> = {}): Node {
  return {
    id,
    type: 'pipelineNode',
    position: { x: 0, y: 0 },
    data: {
      label,
      activityType: 'delay',
      category: 'logic',
      config,
    },
  };
}

function edge(source: string, target: string): Edge {
  return { id: `e-${source}-${target}`, source, target, type: 'pipelineEdge' };
}

/**
 * Helper for tests that don't intentionally exercise trigger-connectivity:
 * builds an edge from the synthetic trigger node to the named entry node so the
 * "Pipeline has no entry node" check passes.
 */
function triggerEdge(entryId: string): Edge {
  return edge(TRIGGER_NODE_ID, entryId);
}

describe('validatePipelineDraft', () => {
  it('accepts named upstream references', () => {
    const nodes = [
      pipelineNode('node-a', 'Warm Up'),
      pipelineNode('node-b', 'Inspect', {
        source: 'steps.warm_up.output.delayed',
      }),
    ];

    const result = validatePipelineDraft(nodes, [triggerEdge('node-a'), edge('node-a', 'node-b')]);

    expect(result.valid).toBe(true);
  });

  it('rejects duplicate node names because they create ambiguous references', () => {
    const result = validatePipelineDraft(
      [pipelineNode('node-a', 'Warm Up'), pipelineNode('node-b', 'Warm Up')],
      [triggerEdge('node-a'), edge('node-a', 'node-b')],
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('steps.warm_up'))).toBe(true);
  });

  it('rejects references to nodes that are not direct upstream', () => {
    const nodes = [
      pipelineNode('node-a', 'Warm Up'),
      pipelineNode('node-b', 'Inspect', {
        source: '{{steps.warm_up.output.delayed}}',
      }),
    ];

    // Both nodes are entry-connected to keep the test focused on the
    // "not a direct upstream" reference check rather than orphan/trigger errors.
    const result = validatePipelineDraft(nodes, [triggerEdge('node-a'), triggerEdge('node-b')]);

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('not a direct upstream'))).toBe(
      true,
    );
  });

  it('warns when a referenced field is not declared by the upstream node output contract', () => {
    const nodes = [
      pipelineNode('node-a', 'Warm Up'),
      pipelineNode('node-b', 'Inspect', {
        source: '{{steps.warm_up.output.missing}}',
      }),
    ];

    const result = validatePipelineDraft(nodes, [triggerEdge('node-a'), edge('node-a', 'node-b')]);

    expect(result.valid).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('Field "missing"'),
      }),
    );
  });

  // New: explicit coverage for the regressions we just fixed.
  it('flags a single disconnected node as an error (previously a silent pass)', () => {
    const result = validatePipelineDraft([pipelineNode('node-a', 'Store Results')], []);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.severity === 'error' && issue.message.includes('disconnected'),
      ),
    ).toBe(true);
  });

  it('flags a graph with no edge from the trigger node as missing an entry', () => {
    const nodes = [pipelineNode('node-a', 'A'), pipelineNode('node-b', 'B')];

    // Two connected nodes but neither is wired to the trigger.
    const result = validatePipelineDraft(nodes, [edge('node-a', 'node-b')]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.severity === 'error' && issue.message.includes('no entry node'),
      ),
    ).toBe(true);
  });
});
