import { describe, test, expect } from 'vitest';
import { walkGraph } from '../pipeline/graph-walker.js';
import type { PipelineNode, StepOutput } from '../pipeline/types.js';

// Mock executor — returns success with node's config as output data
async function mockExecuteNode(
  nodeId: string,
  _nodeType: string,
  config: Record<string, any>,
): Promise<StepOutput> {
  return { status: 'success', data: { ...config, nodeId } };
}

describe('walkGraph', () => {
  test('walks linear graph A → B → C', async () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: { step: 1 }, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'compute', config: { step: 2 }, transitions: [{ target: 'c' }] },
      { id: 'c', type: 'store', config: { step: 3 }, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'a', {}, mockExecuteNode);

    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toEqual(['a', 'b', 'c']);
    expect(result.nodeOutputs['a'].data.step).toBe(1);
    expect(result.nodeOutputs['b'].data.step).toBe(2);
    expect(result.nodeOutputs['c'].data.step).toBe(3);
    expect(result.visitCounts).toEqual({ a: 1, b: 1, c: 1 });
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
      { id: 'alert', type: 'action', config: { type: 'alert' }, transitions: [] },
      { id: 'store', type: 'store', config: { type: 'store' }, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'check', {}, mockExecuteNode);

    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toContain('alert');
    expect(Object.keys(result.nodeOutputs)).not.toContain('store');
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
      { id: 'alert', type: 'action', config: { type: 'alert' }, transitions: [] },
      { id: 'store', type: 'store', config: { type: 'store' }, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'check', {}, mockExecuteNode);

    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toContain('store');
    expect(Object.keys(result.nodeOutputs)).not.toContain('alert');
  });

  test('respects maxVisits for loops', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'compute',
        config: { loop: true },
        transitions: [{ target: 'a' }],
        maxVisits: 3,
      },
    ];

    const result = await walkGraph(nodes, 'a', {}, mockExecuteNode);

    expect(result.visitCounts['a']).toBe(3);
  });

  test('stops on node failure with stop strategy', async () => {
    const failExecutor = async (
      nodeId: string,
      _nodeType: string,
      config: Record<string, any>,
    ): Promise<StepOutput> => {
      if (nodeId === 'b') {
        return { status: 'fail', data: { error: 'something broke' } };
      }
      return { status: 'success', data: { ...config, nodeId } };
    };

    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'compute', config: {}, transitions: [{ target: 'c' }], onFailure: 'stop' },
      { id: 'c', type: 'store', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'a', {}, failExecutor);

    expect(result.nodeOutputs['b'].status).toBe('fail');
    expect(result.nodeOutputs['c']).toBeUndefined();
    expect(result.status).toBe('failed');
  });

  test('terminal node ends path', async () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: { only: true }, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'a', {}, mockExecuteNode);

    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toEqual(['a']);
    expect(result.nodeOutputs['a'].data.only).toBe(true);
  });
});
