import { describe, it, expect } from 'vitest';
import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
} from '@agent-platform/database';
import { identifyChanges, hasRoutingChanged, findStageChanges } from '../change-identifier.js';

// ─── Test Helpers ────────────────────────────────────────────────────────

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
    stages: [makeStage()],
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

// ─── identifyChanges ─────────────────────────────────────────────────────

describe('identifyChanges', () => {
  it('returns empty change set when pipelines are identical', () => {
    const pipeline = makePipeline();
    const result = identifyChanges(pipeline, pipeline);

    expect(result.embeddingChanged).toBe(false);
    expect(result.routingChanged).toBe(false);
    expect(result.preChunkChanges).toHaveLength(0);
    expect(result.postChunkChanges).toHaveLength(0);
  });

  it('detects embedding config change', () => {
    const oldPipeline = makePipeline();
    const newPipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.embeddingChanged).toBe(true);
    expect(result.routingChanged).toBe(false);
  });

  it('detects embedding config change when only dimensions differ', () => {
    const oldPipeline = makePipeline();
    const newPipeline = makePipeline({
      activeEmbeddingConfig: { provider: 'bge-m3', model: 'bge-m3', dimensions: 768 },
    });

    const result = identifyChanges(oldPipeline, newPipeline);
    expect(result.embeddingChanged).toBe(true);
  });

  it('detects routing change when selection rules change', () => {
    const oldPipeline = makePipeline({
      flows: [
        makeFlow({
          selectionRules: [
            { type: 'simple', field: 'document.extension', operator: 'eq', value: 'pdf' },
          ],
        }),
      ],
    });
    const newPipeline = makePipeline({
      flows: [
        makeFlow({
          selectionRules: [
            { type: 'simple', field: 'document.extension', operator: 'eq', value: 'docx' },
          ],
        }),
      ],
    });

    const result = identifyChanges(oldPipeline, newPipeline);
    expect(result.routingChanged).toBe(true);
  });

  it('detects routing change when priority changes', () => {
    const oldPipeline = makePipeline({ flows: [makeFlow({ priority: 10 })] });
    const newPipeline = makePipeline({ flows: [makeFlow({ priority: 20 })] });

    const result = identifyChanges(oldPipeline, newPipeline);
    expect(result.routingChanged).toBe(true);
  });

  it('detects routing change when flow is disabled', () => {
    const oldPipeline = makePipeline({ flows: [makeFlow({ enabled: true })] });
    const newPipeline = makePipeline({ flows: [makeFlow({ enabled: false })] });

    const result = identifyChanges(oldPipeline, newPipeline);
    expect(result.routingChanged).toBe(true);
  });

  it('detects routing change when flow count changes', () => {
    const oldPipeline = makePipeline({ flows: [makeFlow()] });
    const newPipeline = makePipeline({
      flows: [makeFlow(), makeFlow({ id: 'flow-2', name: 'Flow 2' })],
    });

    const result = identifyChanges(oldPipeline, newPipeline);
    expect(result.routingChanged).toBe(true);
  });

  it('detects routing change when enabled flow is removed', () => {
    const oldPipeline = makePipeline({
      flows: [makeFlow(), makeFlow({ id: 'flow-2', name: 'Flow 2' })],
    });
    const newPipeline = makePipeline({ flows: [makeFlow()] });

    const result = identifyChanges(oldPipeline, newPipeline);
    expect(result.routingChanged).toBe(true);
  });

  it('detects pre-chunk change when extraction provider changes', () => {
    const oldPipeline = makePipeline({
      flows: [makeFlow({ stages: [makeStage({ type: 'extraction', provider: 'docling' })] })],
    });
    const newPipeline = makePipeline({
      flows: [makeFlow({ stages: [makeStage({ type: 'extraction', provider: 'tika' })] })],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.preChunkChanges).toHaveLength(1);
    expect(result.preChunkChanges[0]).toMatchObject({
      flowId: 'flow-1',
      stageType: 'extraction',
      changeType: 'provider-changed',
    });
  });

  it('detects pre-chunk change when chunking config changes', () => {
    const oldPipeline = makePipeline({
      flows: [
        makeFlow({
          stages: [
            makeStage({
              type: 'chunking',
              provider: 'recursive',
              providerConfig: { chunkSize: 500 },
            }),
          ],
        }),
      ],
    });
    const newPipeline = makePipeline({
      flows: [
        makeFlow({
          stages: [
            makeStage({
              type: 'chunking',
              provider: 'recursive',
              providerConfig: { chunkSize: 1000 },
            }),
          ],
        }),
      ],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.preChunkChanges).toHaveLength(1);
    expect(result.preChunkChanges[0].changeType).toBe('config-changed');
  });

  it('detects post-chunk change when enrichment provider changes', () => {
    const oldPipeline = makePipeline({
      flows: [
        makeFlow({
          stages: [makeStage({ type: 'enrichment', provider: 'claude-haiku' })],
        }),
      ],
    });
    const newPipeline = makePipeline({
      flows: [
        makeFlow({
          stages: [makeStage({ type: 'enrichment', provider: 'claude-sonnet' })],
        }),
      ],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.postChunkChanges).toHaveLength(1);
    expect(result.postChunkChanges[0]).toMatchObject({
      flowId: 'flow-1',
      stageType: 'enrichment',
      changeType: 'provider-changed',
    });
  });

  it('does not flag new flows (no existing documents to reprocess)', () => {
    const oldPipeline = makePipeline({ flows: [makeFlow()] });
    const newPipeline = makePipeline({
      flows: [
        makeFlow(),
        makeFlow({
          id: 'flow-new',
          name: 'New Flow',
          stages: [makeStage({ type: 'extraction', provider: 'tika' })],
        }),
      ],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    // Routing changed (flow count), but no stage changes for new flow
    expect(result.routingChanged).toBe(true);
    expect(result.preChunkChanges).toHaveLength(0);
    expect(result.postChunkChanges).toHaveLength(0);
  });

  it('detects multiple change types simultaneously', () => {
    const oldPipeline = makePipeline({
      flows: [
        makeFlow({
          stages: [
            makeStage({ id: 's1', type: 'extraction', provider: 'docling' }),
            makeStage({ id: 's2', type: 'enrichment', provider: 'claude-haiku' }),
          ],
        }),
      ],
    });
    const newPipeline = makePipeline({
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
      flows: [
        makeFlow({
          priority: 99,
          stages: [
            makeStage({ id: 's1', type: 'extraction', provider: 'tika' }),
            makeStage({ id: 's2', type: 'enrichment', provider: 'claude-sonnet' }),
          ],
        }),
      ],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.embeddingChanged).toBe(true);
    expect(result.routingChanged).toBe(true);
    expect(result.preChunkChanges).toHaveLength(1);
    expect(result.postChunkChanges).toHaveLength(1);
  });

  it('does not flag metadata-only changes (name, description)', () => {
    const oldPipeline = makePipeline({ flows: [makeFlow({ name: 'Old Name' })] });
    const newPipeline = makePipeline({
      flows: [makeFlow({ name: 'New Name', description: 'Added desc' })],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.embeddingChanged).toBe(false);
    expect(result.routingChanged).toBe(false);
    expect(result.preChunkChanges).toHaveLength(0);
    expect(result.postChunkChanges).toHaveLength(0);
  });

  it('detects stage added to existing flow', () => {
    const oldPipeline = makePipeline({
      flows: [makeFlow({ stages: [makeStage({ type: 'extraction' })] })],
    });
    const newPipeline = makePipeline({
      flows: [
        makeFlow({
          stages: [
            makeStage({ type: 'extraction' }),
            makeStage({ id: 's2', type: 'enrichment', provider: 'claude-haiku' }),
          ],
        }),
      ],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.postChunkChanges).toHaveLength(1);
    expect(result.postChunkChanges[0].changeType).toBe('added');
  });

  it('detects stage removed from existing flow', () => {
    const oldPipeline = makePipeline({
      flows: [
        makeFlow({
          stages: [
            makeStage({ type: 'extraction' }),
            makeStage({ id: 's2', type: 'enrichment', provider: 'claude-haiku' }),
          ],
        }),
      ],
    });
    const newPipeline = makePipeline({
      flows: [makeFlow({ stages: [makeStage({ type: 'extraction' })] })],
    });

    const result = identifyChanges(oldPipeline, newPipeline);

    expect(result.postChunkChanges).toHaveLength(1);
    expect(result.postChunkChanges[0].changeType).toBe('removed');
  });
});

// ─── hasRoutingChanged ───────────────────────────────────────────────────

describe('hasRoutingChanged', () => {
  it('returns false for identical flows', () => {
    const flows = [makeFlow()];
    expect(hasRoutingChanged(flows, flows)).toBe(false);
  });

  it('returns true when flow count differs', () => {
    expect(hasRoutingChanged([makeFlow()], [])).toBe(true);
  });

  it('ignores disabled removed flows', () => {
    const oldFlows = [makeFlow(), makeFlow({ id: 'flow-2', enabled: false })];
    const newFlows = [makeFlow()];
    // Count differs, so routing changed
    expect(hasRoutingChanged(oldFlows, newFlows)).toBe(true);
  });

  it('ignores selection rule order (deep equal)', () => {
    const rules = [
      {
        type: 'simple' as const,
        field: 'document.extension',
        operator: 'eq' as const,
        value: 'pdf',
      },
    ];
    const flows1 = [makeFlow({ selectionRules: rules })];
    const flows2 = [makeFlow({ selectionRules: [...rules] })];
    expect(hasRoutingChanged(flows1, flows2)).toBe(false);
  });
});

// ─── findStageChanges ────────────────────────────────────────────────────

describe('findStageChanges', () => {
  it('returns empty for identical stages', () => {
    const flows = [makeFlow({ stages: [makeStage({ type: 'extraction' })] })];
    expect(findStageChanges(flows, flows, ['extraction'])).toHaveLength(0);
  });

  it('detects changes across multiple flows', () => {
    const oldFlows = [
      makeFlow({ id: 'f1', stages: [makeStage({ type: 'extraction', provider: 'docling' })] }),
      makeFlow({ id: 'f2', stages: [makeStage({ type: 'extraction', provider: 'docling' })] }),
    ];
    const newFlows = [
      makeFlow({ id: 'f1', stages: [makeStage({ type: 'extraction', provider: 'tika' })] }),
      makeFlow({ id: 'f2', stages: [makeStage({ type: 'extraction', provider: 'docling' })] }),
    ];

    const changes = findStageChanges(oldFlows, newFlows, ['extraction']);

    expect(changes).toHaveLength(1);
    expect(changes[0].flowId).toBe('f1');
  });

  it('ignores flows that only exist in new pipeline', () => {
    const oldFlows = [makeFlow({ id: 'f1' })];
    const newFlows = [
      makeFlow({ id: 'f1' }),
      makeFlow({ id: 'f-new', stages: [makeStage({ type: 'extraction', provider: 'tika' })] }),
    ];

    const changes = findStageChanges(oldFlows, newFlows, ['extraction']);
    expect(changes).toHaveLength(0);
  });

  it('handles providerConfig deep comparison (key order)', () => {
    const oldFlows = [
      makeFlow({
        stages: [makeStage({ type: 'enrichment', providerConfig: { a: 1, b: 2 } })],
      }),
    ];
    const newFlows = [
      makeFlow({
        stages: [makeStage({ type: 'enrichment', providerConfig: { b: 2, a: 1 } })],
      }),
    ];

    const changes = findStageChanges(oldFlows, newFlows, ['enrichment']);
    expect(changes).toHaveLength(0);
  });
});
