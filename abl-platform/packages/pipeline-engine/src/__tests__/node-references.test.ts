import { describe, expect, it } from 'vitest';
import {
  buildStepOutputReferences,
  getNodeReferenceName,
  normalizeNodeReferenceName,
} from '../pipeline/node-references.js';
import type { PipelineNode, StepOutput } from '../pipeline/types.js';

describe('node reference helpers', () => {
  it('normalizes display labels into expression-safe references', () => {
    expect(normalizeNodeReferenceName('Read Messages')).toBe('read_messages');
    expect(normalizeNodeReferenceName('  Score: v2! ')).toBe('score_v2');
    expect(normalizeNodeReferenceName('2026 Eval')).toBe('node_2026_eval');
  });

  it('uses node label before internal id', () => {
    expect(getNodeReferenceName({ id: 'node-123', label: 'Quality Score' })).toBe('quality_score');
  });

  it('keeps id references and adds unique named references', () => {
    const output: StepOutput = { status: 'success', data: { score: 0.8 } };
    const references = buildStepOutputReferences([{ id: 'node-123', label: 'Quality Score' }], {
      'node-123': output,
    });

    expect(references['node-123']).toBe(output);
    expect(references.quality_score).toBe(output);
  });

  it('does not add ambiguous duplicate named references', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'delay', label: 'Check Score', config: {}, transitions: [] },
      { id: 'b', type: 'delay', label: 'Check Score', config: {}, transitions: [] },
    ];
    const references = buildStepOutputReferences(nodes, {
      a: { status: 'success', data: { value: 1 } },
      b: { status: 'success', data: { value: 2 } },
    });

    expect(references.a.data.value).toBe(1);
    expect(references.b.data.value).toBe(2);
    expect(references.check_score).toBeUndefined();
  });
});
