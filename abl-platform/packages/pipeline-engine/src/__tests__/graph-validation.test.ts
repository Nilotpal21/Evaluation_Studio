import { describe, test, expect } from 'vitest';
import { validateGraphPipeline } from '../pipeline/validation.js';
import { NodeRegistry } from '../pipeline/node-registry.js';
import { registerAnalyticsNodes, registerBuiltinNodes } from '../pipeline/register-nodes.js';
import { ContractRegistry } from '../pipeline/contracts/registry.js';
import type { PipelineDefinition, PipelineNode } from '../pipeline/types.js';

function createRegistry(): NodeRegistry {
  const r = new NodeRegistry();
  registerAnalyticsNodes(r);
  registerBuiltinNodes(r);
  return r;
}

function makePipeline(nodes: PipelineNode[], entryNodeId: string): PipelineDefinition {
  return {
    _id: 'test',
    tenantId: 't1',
    name: 'Test',
    version: 1,
    status: 'draft',
    nodes,
    entryNodeId,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('validateGraphPipeline', () => {
  test('valid linear pipeline passes', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'sentiment',
        type: 'compute-sentiment',
        config: {},
        transitions: [{ target: 'store' }],
      },
      {
        id: 'store',
        type: 'store-insight',
        config: {},
        transitions: [],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'sentiment'), registry);
    expect(result.errors).toHaveLength(0);
  });

  test('missing entry node', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'compute-sentiment',
        config: {},
        transitions: [],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'missing'), registry);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('Entry node'))).toBe(true);
  });

  test('unknown node type', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'totally-fake',
        config: {},
        transitions: [],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'a'), registry);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('Unknown node type'))).toBe(true);
  });

  test('dangling transition target', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'compute-sentiment',
        config: {},
        transitions: [{ target: 'nowhere' }],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'a'), registry);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('not found'))).toBe(true);
  });

  test('duplicate node IDs', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'compute-sentiment',
        config: {},
        transitions: [],
      },
      {
        id: 'a',
        type: 'store-insight',
        config: {},
        transitions: [],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'a'), registry);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('Duplicate'))).toBe(true);
  });

  test('orphan node warning', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'compute-sentiment',
        config: {},
        transitions: [],
      },
      {
        id: 'orphan',
        type: 'store-insight',
        config: {},
        transitions: [],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'a'), registry);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('unreachable'))).toBe(true);
  });

  test('back-edge without maxVisits warning', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'a',
        type: 'compute-sentiment',
        config: {},
        transitions: [{ target: 'b' }],
      },
      {
        id: 'b',
        type: 'store-insight',
        config: {},
        transitions: [{ target: 'a' }],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'a'), registry);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('maxVisits'))).toBe(true);
  });

  test('node-group children validated', () => {
    const registry = createRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'group1',
        type: 'node-group',
        config: {},
        transitions: [],
        children: [{ id: 'child1', type: 'fake-type', config: {} }],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'group1'), registry);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('Unknown node type'))).toBe(true);
  });

  test('contract validation accepts required input fields from direct upstream output schema', () => {
    const registry = createRegistry();
    const contracts = new ContractRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'read-conversation',
        type: 'read-conversation',
        config: {},
        transitions: [{ target: 'compute-quality' }],
        contractVersion: 1,
      },
      {
        id: 'compute-quality',
        type: 'compute-quality',
        config: {},
        transitions: [],
        contractVersion: 1,
      },
    ];

    const result = validateGraphPipeline(
      makePipeline(nodes, 'read-conversation'),
      registry,
      contracts,
    );
    expect(result.errors).toEqual([]);
  });

  test('contract validation rejects missing required input fields from direct upstream output schema', () => {
    const registry = createRegistry();
    const contracts = new ContractRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'db-query',
        type: 'db-query',
        config: { database: 'clickhouse', query: 'SELECT 1' },
        transitions: [{ target: 'compute-quality' }],
        contractVersion: 1,
      },
      {
        id: 'compute-quality',
        type: 'compute-quality',
        config: {},
        transitions: [],
        contractVersion: 1,
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'db-query'), registry, contracts);
    const dataFlowErrors = result.errors.filter(
      (error) => error.field === 'inputRequirements.fromPreviousSteps',
    );

    expect(dataFlowErrors).toHaveLength(2);
    expect(dataFlowErrors.map((error) => error.message).join(' | ')).toContain(
      "requires previous step field 'messages'",
    );
    expect(dataFlowErrors.map((error) => error.message).join(' | ')).toContain(
      "requires previous step field 'transcript'",
    );
  });

  test('contract validation only considers directly connected previous node output schema', () => {
    const registry = createRegistry();
    const contracts = new ContractRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'read-conversation',
        type: 'read-conversation',
        config: {},
        transitions: [{ target: 'transform-data' }],
        contractVersion: 1,
      },
      {
        id: 'transform-data',
        type: 'transform',
        config: { mapping: {} },
        transitions: [{ target: 'compute-quality' }],
        contractVersion: 1,
      },
      {
        id: 'compute-quality',
        type: 'compute-quality',
        config: {},
        transitions: [],
        contractVersion: 1,
      },
    ];

    const result = validateGraphPipeline(
      makePipeline(nodes, 'read-conversation'),
      registry,
      contracts,
    );
    const dataFlowErrors = result.errors.filter(
      (error) => error.field === 'inputRequirements.fromPreviousSteps',
    );

    expect(dataFlowErrors).toHaveLength(2);
    expect(
      dataFlowErrors.every((error) => error.message.includes('transform-data:transform')),
    ).toBe(true);
  });

  test('contract validation warns instead of errors for legacy unstamped nodes', () => {
    const registry = createRegistry();
    const contracts = new ContractRegistry();
    const nodes: PipelineNode[] = [
      {
        id: 'db-query',
        type: 'db-query',
        config: { database: 'clickhouse', query: 'SELECT 1' },
        transitions: [{ target: 'compute-quality' }],
        contractVersion: 1,
      },
      {
        id: 'compute-quality',
        type: 'compute-quality',
        config: {},
        transitions: [],
      },
    ];

    const result = validateGraphPipeline(makePipeline(nodes, 'db-query'), registry, contracts);
    const dataFlowErrors = result.errors.filter(
      (error) => error.field === 'inputRequirements.fromPreviousSteps',
    );
    const dataFlowWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes("requires previous step field '"),
    );

    expect(dataFlowErrors).toEqual([]);
    expect(dataFlowWarnings).toHaveLength(2);
  });
});
