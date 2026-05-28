/**
 * Integration test: Graph Pipeline Execution
 *
 * Exercises the graph walker with various pipeline topologies using
 * mocked node executors. Tests linear flows, conditional branching,
 * loops with maxVisits, stepsToGraph backward compatibility, failure
 * strategies, template substitution, and diamond graphs.
 */
import { describe, test, expect } from 'vitest';
import { walkGraph } from '../pipeline/graph-walker.js';
import { stepsToGraph } from '../pipeline/graph-utils.js';
import { substituteTemplates } from '../pipeline/template-engine.js';
import type { PipelineNode, PipelineStep, StepOutput } from '../pipeline/types.js';

// Mock executor that returns config as output data
async function mockExecuteNode(
  nodeId: string,
  nodeType: string,
  config: Record<string, any>,
): Promise<StepOutput> {
  return { status: 'success', data: { ...config, nodeId } };
}

describe('Integration: Graph Pipeline Execution', () => {
  test('linear flow: A → B → C', async () => {
    const nodes: PipelineNode[] = [
      { id: 'read', type: 'read-conversation', config: {}, transitions: [{ target: 'compute' }] },
      {
        id: 'compute',
        type: 'compute-sentiment',
        config: {},
        transitions: [{ target: 'store' }],
      },
      { id: 'store', type: 'store-insight', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'read', {}, mockExecuteNode);
    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toEqual(['read', 'compute', 'store']);
  });

  test('conditional branching: high score → alert, low score → store', async () => {
    const executor = async (
      id: string,
      type: string,
      config: Record<string, any>,
    ): Promise<StepOutput> => {
      if (id === 'eval') return { status: 'success', data: { score: 0.9, flagged: true } };
      return { status: 'success', data: { ...config, nodeId: id } };
    };

    const nodes: PipelineNode[] = [
      {
        id: 'eval',
        type: 'compute-quality',
        config: {},
        transitions: [
          { target: 'alert', condition: 'output.flagged == true', order: 1 },
          { target: 'store', order: 2 },
        ],
      },
      { id: 'alert', type: 'send-notification', config: {}, transitions: [{ target: 'store' }] },
      { id: 'store', type: 'store-insight', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'eval', {}, executor);
    expect(result.status).toBe('completed');
    expect(result.nodeOutputs['alert']).toBeDefined();
    expect(result.nodeOutputs['store']).toBeDefined();
  });

  test('loop with maxVisits: retry node 3 times', async () => {
    let callCount = 0;
    const executor = async (id: string): Promise<StepOutput> => {
      callCount++;
      if (id === 'retry' && callCount < 3) {
        return { status: 'success', data: { retry: true } };
      }
      return { status: 'success', data: { done: true } };
    };

    const nodes: PipelineNode[] = [
      {
        id: 'retry',
        type: 'compute',
        config: {},
        maxVisits: 3,
        transitions: [
          { target: 'done', condition: 'output.done == true', order: 1 },
          { target: 'retry', order: 2 },
        ],
      },
      { id: 'done', type: 'store', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'retry', {}, executor);
    expect(result.status).toBe('completed');
    expect(result.visitCounts['retry']).toBe(3);
    expect(result.nodeOutputs['done']).toBeDefined();
  });

  test('stepsToGraph backward compat: converts legacy steps to graph', async () => {
    const steps: PipelineStep[] = [
      { id: 'read', type: 'read-conversation', config: {} },
      { id: 'eval', type: 'compute-sentiment', config: {} },
      { id: 'store', type: 'store-insight', config: {} },
    ];

    const { nodes, entryNodeId } = stepsToGraph(steps);
    expect(entryNodeId).toBe('read');
    expect(nodes).toHaveLength(3);

    const result = await walkGraph(nodes, entryNodeId, {}, mockExecuteNode);
    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toHaveLength(3);
  });

  test('stepsToGraph with parallel group', async () => {
    const steps: PipelineStep[] = [
      { id: 'read', type: 'read-conversation', config: {} },
      { id: 's1', type: 'compute-sentiment', parallel: 'p1', config: {} },
      { id: 's2', type: 'compute-toxicity', parallel: 'p1', config: {} },
      { id: 'store', type: 'store-insight', config: {} },
    ];

    const { nodes, entryNodeId } = stepsToGraph(steps);
    expect(entryNodeId).toBe('read');
    // read + group-p1 + store = 3 top-level nodes
    expect(nodes).toHaveLength(3);

    const groupNode = nodes.find((n) => n.type === 'node-group');
    expect(groupNode).toBeDefined();
    expect(groupNode!.children).toHaveLength(2);
  });

  test('failure with stop strategy halts pipeline', async () => {
    const executor = async (id: string): Promise<StepOutput> => {
      if (id === 'bad') return { status: 'fail', data: { error: 'boom' } };
      return { status: 'success', data: {} };
    };

    const nodes: PipelineNode[] = [
      { id: 'good', type: 'compute', config: {}, transitions: [{ target: 'bad' }] },
      {
        id: 'bad',
        type: 'compute',
        config: {},
        onFailure: 'stop',
        transitions: [{ target: 'after' }],
      },
      { id: 'after', type: 'store', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'good', {}, executor);
    expect(result.status).toBe('failed');
    expect(result.nodeOutputs['good']).toBeDefined();
    expect(result.nodeOutputs['bad'].status).toBe('fail');
    expect(result.nodeOutputs['after']).toBeUndefined();
  });

  test('template substitution in node configs', () => {
    const template = 'Hello {{input.name}}, your score is {{steps.eval.output.score}}';
    const context = {
      input: { name: 'User' },
      steps: { eval: { output: { score: 0.85 } } },
    };
    expect(substituteTemplates(template, context)).toBe('Hello User, your score is 0.85');
  });

  test('diamond graph: A → B,C → D (via conditional transitions)', async () => {
    const executor = async (
      id: string,
      type: string,
      config: Record<string, any>,
    ): Promise<StepOutput> => {
      if (id === 'start') return { status: 'success', data: { path: 'left' } };
      return { status: 'success', data: { nodeId: id } };
    };

    const nodes: PipelineNode[] = [
      {
        id: 'start',
        type: 'compute',
        config: {},
        transitions: [
          { target: 'left', condition: "output.path == 'left'", order: 1 },
          { target: 'right', order: 2 },
        ],
      },
      { id: 'left', type: 'compute', config: {}, transitions: [{ target: 'end' }] },
      { id: 'right', type: 'compute', config: {}, transitions: [{ target: 'end' }] },
      { id: 'end', type: 'store', config: {}, transitions: [] },
    ];

    const result = await walkGraph(nodes, 'start', {}, executor);
    expect(result.status).toBe('completed');
    expect(result.nodeOutputs['left']).toBeDefined();
    expect(result.nodeOutputs['right']).toBeUndefined(); // took left path
    expect(result.nodeOutputs['end']).toBeDefined();
  });
});
