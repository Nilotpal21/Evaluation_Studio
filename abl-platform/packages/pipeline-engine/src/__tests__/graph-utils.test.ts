import { describe, test, expect } from 'vitest';
import {
  stepsToGraph,
  findReachableNodes,
  detectBackEdges,
  resolveTransition,
} from '../pipeline/graph-utils.js';
import type { PipelineStep, PipelineNode, NodeTransition, StepOutput } from '../pipeline/types.js';

// ── stepsToGraph ──

describe('stepsToGraph', () => {
  test('converts sequential steps to nodes with transitions', () => {
    const steps: PipelineStep[] = [
      { id: 'a', name: 'Step A', type: 'compute', config: { key: 'val' } },
      { id: 'b', name: 'Step B', type: 'store', config: {} },
    ];

    const result = stepsToGraph(steps);

    expect(result.entryNodeId).toBe('a');
    expect(result.nodes).toHaveLength(2);

    const nodeA = result.nodes.find((n) => n.id === 'a')!;
    expect(nodeA.transitions).toEqual([{ target: 'b' }]);

    const nodeB = result.nodes.find((n) => n.id === 'b')!;
    expect(nodeB.transitions).toEqual([]);
  });

  test('converts parallel group to node-group', () => {
    const steps: PipelineStep[] = [
      { id: 'a', name: 'Child A', type: 'compute', config: {}, parallel: 'g1' },
      { id: 'b', name: 'Child B', type: 'compute', config: {}, parallel: 'g1' },
      { id: 'c', name: 'After', type: 'store', config: {} },
    ];

    const result = stepsToGraph(steps);

    // Should produce a node-group node + step c = 2 nodes
    expect(result.nodes).toHaveLength(2);

    const group = result.nodes.find((n) => n.type === 'node-group')!;
    expect(group).toBeDefined();
    expect(group.children).toHaveLength(2);
    expect(group.children!.map((c) => c.id)).toEqual(['a', 'b']);
    expect(group.transitions).toEqual([{ target: 'c' }]);

    const nodeC = result.nodes.find((n) => n.id === 'c')!;
    expect(nodeC.transitions).toEqual([]);
  });

  test('handles empty steps', () => {
    const result = stepsToGraph([]);
    expect(result.nodes).toEqual([]);
    expect(result.entryNodeId).toBe('');
  });
});

// ── findReachableNodes ──

describe('findReachableNodes', () => {
  test('finds all reachable in linear graph', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'compute', config: {}, transitions: [{ target: 'c' }] },
      { id: 'c', type: 'store', config: {}, transitions: [] },
    ];

    const reachable = findReachableNodes(nodes, 'a');
    expect(reachable).toEqual(new Set(['a', 'b', 'c']));
  });

  test('detects orphan nodes', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'store', config: {}, transitions: [] },
      { id: 'orphan', type: 'compute', config: {}, transitions: [] },
    ];

    const reachable = findReachableNodes(nodes, 'a');
    expect(reachable).toEqual(new Set(['a', 'b']));
    expect(reachable.has('orphan')).toBe(false);
  });

  test('handles branching', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'b' }, { target: 'c' }] },
      { id: 'b', type: 'compute', config: {}, transitions: [{ target: 'd' }] },
      { id: 'c', type: 'compute', config: {}, transitions: [{ target: 'd' }] },
      { id: 'd', type: 'store', config: {}, transitions: [] },
    ];

    const reachable = findReachableNodes(nodes, 'a');
    expect(reachable).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  test('includes node-group children', () => {
    const nodes: PipelineNode[] = [
      {
        id: 'group1',
        type: 'node-group',
        config: {},
        transitions: [],
        children: [
          { id: 'child1', type: 'compute', config: {} },
          { id: 'child2', type: 'compute', config: {} },
        ],
      },
    ];

    const reachable = findReachableNodes(nodes, 'group1');
    expect(reachable.has('group1')).toBe(true);
    expect(reachable.has('child1')).toBe(true);
    expect(reachable.has('child2')).toBe(true);
  });
});

// ── detectBackEdges ──

describe('detectBackEdges', () => {
  test('no back-edges in linear graph', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'compute', config: {}, transitions: [{ target: 'c' }] },
      { id: 'c', type: 'store', config: {}, transitions: [] },
    ];

    const backEdges = detectBackEdges(nodes, 'a');
    expect(backEdges).toEqual([]);
  });

  test('detects back-edge in loop', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'b' }] },
      { id: 'b', type: 'compute', config: {}, transitions: [{ target: 'a' }] },
    ];

    const backEdges = detectBackEdges(nodes, 'a');
    expect(backEdges).toEqual([{ from: 'b', to: 'a' }]);
  });

  test('detects back-edge in self-loop', () => {
    const nodes: PipelineNode[] = [
      { id: 'a', type: 'compute', config: {}, transitions: [{ target: 'a' }] },
    ];

    const backEdges = detectBackEdges(nodes, 'a');
    expect(backEdges).toEqual([{ from: 'a', to: 'a' }]);
  });
});

// ── resolveTransition ──

describe('resolveTransition', () => {
  const makeOutput = (data: Record<string, unknown>): StepOutput => ({
    status: 'success',
    data,
  });

  const defaultContext = { input: {}, nodeOutputs: {} };

  test('returns default transition when no conditions', () => {
    const transitions: NodeTransition[] = [{ target: 'next' }];
    const result = resolveTransition(transitions, makeOutput({}), defaultContext);
    expect(result).toBe('next');
  });

  test('returns null for empty transitions', () => {
    const result = resolveTransition([], makeOutput({}), defaultContext);
    expect(result).toBeNull();
  });

  test('evaluates conditions in order', () => {
    const transitions: NodeTransition[] = [
      { target: 'alert', condition: 'output.score > 0.7', order: 1 },
      { target: 'store', order: 2 },
    ];
    const result = resolveTransition(transitions, makeOutput({ score: 0.9 }), defaultContext);
    expect(result).toBe('alert');
  });

  test('falls through to default when condition false', () => {
    const transitions: NodeTransition[] = [
      { target: 'alert', condition: 'output.score < 0.5', order: 1 },
      { target: 'store', order: 2 },
    ];
    const result = resolveTransition(transitions, makeOutput({ score: 0.9 }), defaultContext);
    expect(result).toBe('store');
  });

  test('returns null when no condition matches and no default', () => {
    const transitions: NodeTransition[] = [
      { target: 'alert', condition: 'output.score > 0.7', order: 1 },
    ];
    const result = resolveTransition(transitions, makeOutput({ score: 0.3 }), defaultContext);
    expect(result).toBeNull();
  });
});
