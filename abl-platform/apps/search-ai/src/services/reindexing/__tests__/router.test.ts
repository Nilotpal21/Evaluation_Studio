import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
} from '@agent-platform/database';
import type { ChangeSet } from '../types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────

function mockCursorFrom<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

const { mockSearchDocument, mockSearchChunk } = vi.hoisted(() => {
  const makeFindChain = (items: unknown[] = []) => ({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnValue({
      cursor: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const item of items) yield item;
        },
      }),
    }),
  });
  return {
    mockSearchDocument: { find: vi.fn().mockReturnValue(makeFindChain()) },
    mockSearchChunk: { find: vi.fn().mockReturnValue(makeFindChain()) },
  };
});

vi.mock('../../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchDocument') return mockSearchDocument;
    if (name === 'SearchChunk') return mockSearchChunk;
    return {};
  },
}));

vi.mock('../../flow-selection/flow-selection.service.js', () => {
  const MockFlowSelectionService = vi.fn(function (this: Record<string, unknown>) {
    this.selectFlow = vi.fn().mockResolvedValue({ success: true, flow: null });
  });
  return { FlowSelectionService: MockFlowSelectionService };
});

const SearchDocument = mockSearchDocument;
const SearchChunk = mockSearchChunk;
import { FlowSelectionService } from '../../flow-selection/flow-selection.service.js';
import { buildReindexPlan } from '../router.js';

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
      makeStage({ id: 's2', type: 'enrichment', provider: 'openai' }),
      makeStage({ id: 's3', type: 'embedding', provider: 'bge-m3' }),
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
    activeEmbeddingConfig: { provider: 'bge-m3', model: 'bge-m3', dimensions: 1024 },
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function emptyChangeSet(): ChangeSet {
  return {
    embeddingChanged: false,
    routingChanged: false,
    preChunkChanges: [],
    postChunkChanges: [],
  };
}

function makeFindChain(items: unknown[]) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnValue({
      cursor: vi.fn().mockReturnValue(mockCursorFrom(items)),
    }),
  };
}

function mockDocFind(docs: Array<{ _id: string; [k: string]: unknown }>) {
  const chain = makeFindChain(docs);
  (SearchDocument.find as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

function mockChunkFind(chunks: Array<{ _id: string; [k: string]: unknown }>) {
  const chain = makeFindChain(chunks);
  (SearchChunk.find as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('buildReindexPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty plan when no changes', async () => {
    const plan = await buildReindexPlan(
      'tenant-1',
      'index-1',
      makePipeline(),
      makePipeline(),
      emptyChangeSet(),
    );

    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.totalDocuments).toBe(0);
    expect(plan.summary.totalChunks).toBe(0);
  });

  describe('embedding changes (checkpoint 4)', () => {
    it('creates embedding actions for all chunks', async () => {
      mockChunkFind([
        { _id: 'chunk-1', documentId: 'doc-1' },
        { _id: 'chunk-2', documentId: 'doc-1' },
        { _id: 'chunk-3', documentId: 'doc-2' },
      ]);

      const plan = await buildReindexPlan('tenant-1', 'index-1', makePipeline(), makePipeline(), {
        ...emptyChangeSet(),
        embeddingChanged: true,
      });

      expect(plan.actions).toHaveLength(3);
      expect(plan.actions.every((a) => a.checkpoint === 4)).toBe(true);
      expect(plan.actions.every((a) => a.stages[0] === 'embedding')).toBe(true);
      expect(plan.summary.checkpoint4Count).toBe(3);
    });
  });

  describe('pre-chunk changes (checkpoint 2)', () => {
    it('creates extraction actions for documents in affected flows', async () => {
      mockDocFind([{ _id: 'doc-1' }, { _id: 'doc-2' }]);

      const plan = await buildReindexPlan('tenant-1', 'index-1', makePipeline(), makePipeline(), {
        ...emptyChangeSet(),
        preChunkChanges: [
          {
            flowId: 'flow-1',
            flowName: 'Flow 1',
            stageType: 'extraction',
            changeType: 'provider-changed',
          },
        ],
      });

      expect(plan.actions).toHaveLength(2);
      expect(plan.actions.every((a) => a.checkpoint === 2)).toBe(true);
      expect(plan.actions[0].flowId).toBe('flow-1');
      expect(plan.summary.checkpoint2Count).toBe(2);
    });
  });

  describe('post-chunk changes (checkpoint 3)', () => {
    it('creates enrichment actions for chunks in affected flows', async () => {
      mockChunkFind([{ _id: 'chunk-1' }, { _id: 'chunk-2' }]);

      const plan = await buildReindexPlan('tenant-1', 'index-1', makePipeline(), makePipeline(), {
        ...emptyChangeSet(),
        postChunkChanges: [
          {
            flowId: 'flow-2',
            flowName: 'Flow 2',
            stageType: 'enrichment',
            changeType: 'config-changed',
          },
        ],
      });

      expect(plan.actions).toHaveLength(2);
      expect(plan.actions.every((a) => a.checkpoint === 3)).toBe(true);
      expect(plan.actions[0].flowId).toBe('flow-2');
      expect(plan.summary.checkpoint3Count).toBe(2);
    });

    it('skips flows already covered by pre-chunk changes', async () => {
      // Pre-chunk for flow-1, post-chunk also for flow-1 -> should skip
      mockDocFind([{ _id: 'doc-1' }]);

      const plan = await buildReindexPlan('tenant-1', 'index-1', makePipeline(), makePipeline(), {
        ...emptyChangeSet(),
        preChunkChanges: [
          {
            flowId: 'flow-1',
            flowName: 'Flow 1',
            stageType: 'extraction',
            changeType: 'provider-changed',
          },
        ],
        postChunkChanges: [
          {
            flowId: 'flow-1',
            flowName: 'Flow 1',
            stageType: 'enrichment',
            changeType: 'config-changed',
          },
        ],
      });

      // Only the pre-chunk action, not the post-chunk (same flow)
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].checkpoint).toBe(2);
    });
  });

  describe('embedding + pre-chunk dedup', () => {
    it('skips embedding for chunks whose documents are already covered by pre-chunk', async () => {
      // Pre-chunk covers doc-1
      mockDocFind([{ _id: 'doc-1' }]);
      // Embedding would cover all chunks, but doc-1's chunks should be skipped
      mockChunkFind([
        { _id: 'chunk-1', documentId: 'doc-1' },
        { _id: 'chunk-2', documentId: 'doc-2' },
      ]);

      // Need to handle the two different find calls (doc for pre-chunk, chunk for embedding)
      (SearchDocument.find as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeFindChain([{ _id: 'doc-1' }]),
      );
      (SearchChunk.find as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeFindChain([
          { _id: 'chunk-1', documentId: 'doc-1' },
          { _id: 'chunk-2', documentId: 'doc-2' },
        ]),
      );

      const plan = await buildReindexPlan('tenant-1', 'index-1', makePipeline(), makePipeline(), {
        ...emptyChangeSet(),
        embeddingChanged: true,
        preChunkChanges: [
          {
            flowId: 'flow-1',
            flowName: 'Flow 1',
            stageType: 'extraction',
            changeType: 'provider-changed',
          },
        ],
      });

      // 1 pre-chunk (doc-1) + 1 embedding (chunk-2, since chunk-1's doc is covered)
      const preChunkActions = plan.actions.filter((a) => a.checkpoint === 2);
      const embeddingActions = plan.actions.filter((a) => a.checkpoint === 4);

      expect(preChunkActions).toHaveLength(1);
      expect(preChunkActions[0].documentId).toBe('doc-1');
      expect(embeddingActions).toHaveLength(1);
      expect(embeddingActions[0].chunkId).toBe('chunk-2');
    });
  });

  describe('routing + pre-chunk combined', () => {
    it('processes pre-chunk changes even when routing changed (after fix)', async () => {
      // No documents returned for routing (no routing impact)
      let docFindCallCount = 0;
      (SearchDocument.find as ReturnType<typeof vi.fn>).mockImplementation(() => {
        docFindCallCount++;
        if (docFindCallCount === 1) {
          // First call: routing resolver (all docs) - return empty
          return makeFindChain([]);
        }
        // Second call: pre-chunk resolver (by flowId) - return doc
        return makeFindChain([{ _id: 'doc-A' }]);
      });

      const plan = await buildReindexPlan('tenant-1', 'index-1', makePipeline(), makePipeline(), {
        ...emptyChangeSet(),
        routingChanged: true,
        preChunkChanges: [
          {
            flowId: 'flow-1',
            flowName: 'Flow 1',
            stageType: 'extraction',
            changeType: 'provider-changed',
          },
        ],
      });

      // Pre-chunk should still be processed even though routing changed
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].checkpoint).toBe(2);
      expect(plan.actions[0].documentId).toBe('doc-A');
    });
  });

  describe('summary', () => {
    it('produces correct summary with mixed checkpoints', async () => {
      // Pre-chunk docs
      (SearchDocument.find as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeFindChain([{ _id: 'doc-1' }]),
      );
      // Embedding chunks
      (SearchChunk.find as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeFindChain([{ _id: 'chunk-1', documentId: 'doc-1' }]),
      );

      const plan = await buildReindexPlan('tenant-1', 'index-1', makePipeline(), makePipeline(), {
        ...emptyChangeSet(),
        embeddingChanged: true,
        preChunkChanges: [
          {
            flowId: 'flow-1',
            flowName: 'Flow 1',
            stageType: 'extraction',
            changeType: 'provider-changed',
          },
        ],
      });

      // doc-1 covered by pre-chunk, so embedding skips chunk-1 (doc-1 is covered)
      expect(plan.summary.checkpoint2Count).toBe(1);
      expect(plan.summary.checkpoint4Count).toBe(0);
      expect(plan.summary.totalDocuments).toBe(1);
      expect(plan.summary.totalChunks).toBe(0);
      expect(plan.summary.estimatedCostUsd).toBeGreaterThan(0);
      expect(plan.summary.estimatedDurationMin).toBeGreaterThan(0);
    });
  });
});
