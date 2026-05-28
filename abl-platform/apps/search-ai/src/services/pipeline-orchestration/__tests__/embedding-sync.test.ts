import { describe, it, expect } from 'vitest';
import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
} from '@agent-platform/database';
import { syncFlowEmbeddingStages, syncFlowEmbeddingStagesForFlow } from '../embedding-sync.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeStage(overrides: Partial<ISearchPipelineStage> = {}): ISearchPipelineStage {
  return {
    id: 'stage-1',
    name: 'Test Stage',
    type: 'extraction',
    provider: 'docling',
    providerConfig: {},
    onError: 'fail' as const,
    ...overrides,
  };
}

function makeFlow(overrides: Partial<ISearchPipelineFlow> = {}): ISearchPipelineFlow {
  return {
    id: 'flow-1',
    name: 'Flow 1',
    enabled: true,
    priority: 10,
    isDefault: false,
    stages: [
      makeStage({ id: 's1', type: 'extraction', provider: 'docling' }),
      makeStage({ id: 's2', type: 'chunking', provider: 'tree-builder' }),
      makeStage({
        id: 's3',
        type: 'embedding',
        provider: 'bge-m3',
        providerConfig: { model: 'bge-m3', dimensions: 1024 },
      }),
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePipeline(
  overrides: Partial<ISearchPipelineDefinition> = {},
): ISearchPipelineDefinition {
  return {
    _id: 'pipeline-1',
    tenantId: 'tenant-1',
    knowledgeBaseId: 'kb-1',
    name: 'Test Pipeline',
    description: '',
    version: 1,
    status: 'active',
    isDefault: false,
    flows: [makeFlow()],
    activeEmbeddingConfig: {
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    },
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('syncFlowEmbeddingStages', () => {
  it('returns 0 updates when stages already match', () => {
    const pipeline = makePipeline();
    const result = syncFlowEmbeddingStages(pipeline);

    expect(result.updatedCount).toBe(0);
    expect(result.affectedFlowIds).toHaveLength(0);
  });

  it('syncs embedding stages when provider differs', () => {
    const pipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
    });

    const result = syncFlowEmbeddingStages(pipeline);

    expect(result.updatedCount).toBe(1);
    expect(result.affectedFlowIds).toEqual(['flow-1']);

    const embeddingStage = pipeline.flows[0].stages.find((s) => s.type === 'embedding')!;
    expect(embeddingStage.provider).toBe('openai');
    expect(embeddingStage.providerConfig).toMatchObject({
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  });

  it('syncs embedding stages when model differs', () => {
    const pipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'bge-m3',
        model: 'bge-m3-v2',
        dimensions: 1024,
      },
    });

    const result = syncFlowEmbeddingStages(pipeline);

    expect(result.updatedCount).toBe(1);
    const embeddingStage = pipeline.flows[0].stages.find((s) => s.type === 'embedding')!;
    expect(embeddingStage.providerConfig).toMatchObject({
      model: 'bge-m3-v2',
      dimensions: 1024,
    });
  });

  it('syncs embedding stages when dimensions differ', () => {
    const pipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'bge-m3',
        model: 'bge-m3',
        dimensions: 768,
      },
    });

    const result = syncFlowEmbeddingStages(pipeline);

    expect(result.updatedCount).toBe(1);
    const embeddingStage = pipeline.flows[0].stages.find((s) => s.type === 'embedding')!;
    expect((embeddingStage.providerConfig as Record<string, unknown>).dimensions).toBe(768);
  });

  it('syncs across multiple flows', () => {
    const pipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
      flows: [makeFlow({ id: 'flow-1' }), makeFlow({ id: 'flow-2' }), makeFlow({ id: 'flow-3' })],
    });

    const result = syncFlowEmbeddingStages(pipeline);

    expect(result.updatedCount).toBe(3);
    expect(result.affectedFlowIds).toEqual(['flow-1', 'flow-2', 'flow-3']);

    for (const flow of pipeline.flows) {
      const embeddingStage = flow.stages.find((s) => s.type === 'embedding')!;
      expect(embeddingStage.provider).toBe('openai');
    }
  });

  it('preserves non-embedding providerConfig fields', () => {
    const pipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
      flows: [
        makeFlow({
          stages: [
            makeStage({
              id: 's3',
              type: 'embedding',
              provider: 'bge-m3',
              providerConfig: {
                model: 'bge-m3',
                dimensions: 1024,
                batchSize: 32,
                timeout: 5000,
              },
            }),
          ],
        }),
      ],
    });

    syncFlowEmbeddingStages(pipeline);

    const config = pipeline.flows[0].stages[0].providerConfig as Record<string, unknown>;
    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(1536);
    expect(config.batchSize).toBe(32);
    expect(config.timeout).toBe(5000);
  });

  it('skips flows without embedding stages', () => {
    const pipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
      flows: [
        makeFlow({
          id: 'flow-no-embed',
          stages: [makeStage({ id: 's1', type: 'extraction' })],
        }),
        makeFlow({ id: 'flow-with-embed' }),
      ],
    });

    const result = syncFlowEmbeddingStages(pipeline);

    expect(result.updatedCount).toBe(1);
    expect(result.affectedFlowIds).toEqual(['flow-with-embed']);
  });

  it('handles missing activeEmbeddingConfig gracefully', () => {
    const pipeline = makePipeline();
    (pipeline as any).activeEmbeddingConfig = undefined;

    const result = syncFlowEmbeddingStages(pipeline);

    expect(result.updatedCount).toBe(0);
    expect(result.affectedFlowIds).toHaveLength(0);
  });
});

describe('syncFlowEmbeddingStagesForFlow', () => {
  it('syncs a single flow to pipeline config', () => {
    const pipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
    });

    // Simulate a flow that just got its stages from a template (BGE-M3)
    const flow = makeFlow({
      id: 'upgraded-flow',
      templateVersion: '2.0.0',
    });

    const count = syncFlowEmbeddingStagesForFlow(flow, pipeline);

    expect(count).toBe(1);
    const embeddingStage = flow.stages.find((s) => s.type === 'embedding')!;
    expect(embeddingStage.provider).toBe('openai');
    expect(embeddingStage.providerConfig).toMatchObject({
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  });

  it('returns 0 for flow without embedding stages', () => {
    const pipeline = makePipeline();
    const flow = makeFlow({
      stages: [makeStage({ type: 'extraction' })],
    });

    const count = syncFlowEmbeddingStagesForFlow(flow, pipeline);
    expect(count).toBe(0);
  });
});
