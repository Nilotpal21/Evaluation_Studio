import { describe, it, expect } from 'vitest';
import {
  STAGE_ORDER,
  getDownstreamStages,
  stageToCheckpoint,
  findEarliestDifferingStage,
  buildSummary,
} from '../helpers.js';
import type { ReindexAction } from '../types.js';
import type { ISearchPipelineStage } from '@agent-platform/database';

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

describe('STAGE_ORDER', () => {
  it('has correct pipeline stage ordering', () => {
    expect(STAGE_ORDER).toEqual([
      'extraction',
      'chunking',
      'enrichment',
      'multimodal',
      'embedding',
    ]);
  });
});

describe('getDownstreamStages', () => {
  it('returns all stages from extraction', () => {
    expect(getDownstreamStages('extraction')).toEqual([
      'extraction',
      'chunking',
      'enrichment',
      'multimodal',
      'embedding',
    ]);
  });

  it('returns enrichment and downstream from enrichment', () => {
    expect(getDownstreamStages('enrichment')).toEqual(['enrichment', 'multimodal', 'embedding']);
  });

  it('returns only embedding from embedding', () => {
    expect(getDownstreamStages('embedding')).toEqual(['embedding']);
  });

  it('returns chunking and downstream from chunking', () => {
    expect(getDownstreamStages('chunking')).toEqual([
      'chunking',
      'enrichment',
      'multimodal',
      'embedding',
    ]);
  });

  it('returns multimodal + embedding from multimodal', () => {
    expect(getDownstreamStages('multimodal')).toEqual(['multimodal', 'embedding']);
  });
});

describe('stageToCheckpoint', () => {
  it('maps extraction to checkpoint 2', () => {
    expect(stageToCheckpoint('extraction')).toBe(2);
  });

  it('maps chunking to checkpoint 2', () => {
    expect(stageToCheckpoint('chunking')).toBe(2);
  });

  it('maps enrichment to checkpoint 3', () => {
    expect(stageToCheckpoint('enrichment')).toBe(3);
  });

  it('maps multimodal to checkpoint 3', () => {
    expect(stageToCheckpoint('multimodal')).toBe(3);
  });

  it('maps embedding to checkpoint 4', () => {
    expect(stageToCheckpoint('embedding')).toBe(4);
  });
});

describe('findEarliestDifferingStage', () => {
  it('returns null for identical stages', () => {
    const stages = [makeStage({ type: 'extraction' }), makeStage({ type: 'enrichment' })];
    expect(findEarliestDifferingStage(stages, stages)).toBeNull();
  });

  it('detects extraction provider change', () => {
    const old = [makeStage({ type: 'extraction', provider: 'docling' })];
    const updated = [makeStage({ type: 'extraction', provider: 'tika' })];
    expect(findEarliestDifferingStage(old, updated)).toBe('extraction');
  });

  it('detects enrichment config change', () => {
    const old = [
      makeStage({ type: 'extraction' }),
      makeStage({ type: 'enrichment', providerConfig: { model: 'gpt-4' } }),
    ];
    const updated = [
      makeStage({ type: 'extraction' }),
      makeStage({ type: 'enrichment', providerConfig: { model: 'gpt-4o' } }),
    ];
    expect(findEarliestDifferingStage(old, updated)).toBe('enrichment');
  });

  it('returns earliest stage when multiple differ', () => {
    const old = [
      makeStage({ type: 'extraction', provider: 'docling' }),
      makeStage({ type: 'enrichment', provider: 'openai' }),
    ];
    const updated = [
      makeStage({ type: 'extraction', provider: 'tika' }),
      makeStage({ type: 'enrichment', provider: 'anthropic' }),
    ];
    expect(findEarliestDifferingStage(old, updated)).toBe('extraction');
  });

  it('detects stage added in new', () => {
    const old: ISearchPipelineStage[] = [];
    const updated = [makeStage({ type: 'enrichment' })];
    expect(findEarliestDifferingStage(old, updated)).toBe('enrichment');
  });

  it('detects stage removed in new', () => {
    const old = [makeStage({ type: 'enrichment' })];
    const updated: ISearchPipelineStage[] = [];
    expect(findEarliestDifferingStage(old, updated)).toBe('enrichment');
  });

  it('detects multimodal stage added', () => {
    const old = [makeStage({ type: 'enrichment' })];
    const updated = [
      makeStage({ type: 'enrichment' }),
      makeStage({ type: 'multimodal', provider: 'vision-llm' }),
    ];
    expect(findEarliestDifferingStage(old, updated)).toBe('multimodal');
  });

  it('detects multimodal config change', () => {
    const old = [
      makeStage({
        type: 'multimodal',
        provider: 'vision-llm',
        providerConfig: { model: 'gpt-4o' },
      }),
    ];
    const updated = [
      makeStage({
        type: 'multimodal',
        provider: 'vision-llm',
        providerConfig: { model: 'claude-sonnet-4-6' },
      }),
    ];
    expect(findEarliestDifferingStage(old, updated)).toBe('multimodal');
  });
});

describe('buildSummary', () => {
  it('returns zeros for empty actions', () => {
    const summary = buildSummary([]);
    expect(summary.checkpoint1Count).toBe(0);
    expect(summary.checkpoint2Count).toBe(0);
    expect(summary.checkpoint3Count).toBe(0);
    expect(summary.checkpoint4Count).toBe(0);
    expect(summary.totalDocuments).toBe(0);
    expect(summary.totalChunks).toBe(0);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.estimatedDurationMin).toBe(0);
  });

  it('counts checkpoints correctly', () => {
    const actions: ReindexAction[] = [
      { documentId: 'd1', flowId: 'f1', checkpoint: 2, stages: ['extraction'] },
      { documentId: 'd2', flowId: 'f1', checkpoint: 2, stages: ['extraction'] },
      { chunkId: 'c1', flowId: 'f2', checkpoint: 3, stages: ['enrichment'] },
      { chunkId: 'c2', flowId: '', checkpoint: 4, stages: ['embedding'] },
      { chunkId: 'c3', flowId: '', checkpoint: 4, stages: ['embedding'] },
      { chunkId: 'c4', flowId: '', checkpoint: 4, stages: ['embedding'] },
    ];

    const summary = buildSummary(actions);
    expect(summary.checkpoint2Count).toBe(2);
    expect(summary.checkpoint3Count).toBe(1);
    expect(summary.checkpoint4Count).toBe(3);
    expect(summary.totalDocuments).toBe(2); // checkpoint 1 + 2
    expect(summary.totalChunks).toBe(4); // checkpoint 3 + 4
  });

  it('estimates cost for checkpoint 2 (extraction)', () => {
    const actions: ReindexAction[] = [
      { documentId: 'd1', flowId: 'f1', checkpoint: 2, stages: ['extraction'] },
    ];
    const summary = buildSummary(actions);
    expect(summary.estimatedCostUsd).toBe(0.01); // $0.005 per doc
  });

  it('estimates cost for checkpoint 4 (embedding)', () => {
    const actions: ReindexAction[] = [
      { chunkId: 'c1', flowId: '', checkpoint: 4, stages: ['embedding'] },
    ];
    const summary = buildSummary(actions);
    expect(summary.estimatedCostUsd).toBe(0); // $0.00005 rounds to 0.00
  });

  it('estimates duration for mixed actions', () => {
    const actions: ReindexAction[] = [
      { documentId: 'd1', flowId: 'f1', checkpoint: 2, stages: ['extraction'] }, // 30s
      { chunkId: 'c1', flowId: 'f2', checkpoint: 3, stages: ['enrichment'] }, // 10s
    ];
    const summary = buildSummary(actions);
    expect(summary.estimatedDurationMin).toBe(1); // ceil(40/60) = 1
  });
});
