import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
} from '@agent-platform/database';
import { ReindexOrchestrator } from '../orchestrator.js';
import type {
  ChangeStore,
  CheckpointHandler,
  PersistedChangeSet,
  ReindexAction,
  ReindexEstimate,
  ReindexParams,
} from '../types.js';

// ─── Mock Dependencies ──────────────────────────────────────────────────

vi.mock('../router.js', () => ({
  buildReindexPlan: vi.fn(),
}));

import { buildReindexPlan } from '../router.js';
const mockBuildReindexPlan = vi.mocked(buildReindexPlan);

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

function createMockStore(): ChangeStore {
  return {
    save: vi.fn().mockResolvedValue('stored-id'),
    get: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockResolvedValue([]),
    markProcessed: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockHandler(checkpoint: 1 | 2 | 3 | 4): CheckpointHandler {
  return {
    checkpoint,
    estimate: vi.fn().mockReturnValue({
      totalItems: 0,
      estimatedDurationMin: 0,
      estimatedCostUsd: 0,
    } satisfies ReindexEstimate),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('ReindexOrchestrator', () => {
  let store: ChangeStore;
  let handler2: CheckpointHandler;
  let handler3: CheckpointHandler;
  let handler4: CheckpointHandler;
  let orchestrator: ReindexOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockStore();
    handler2 = createMockHandler(2);
    handler3 = createMockHandler(3);
    handler4 = createMockHandler(4);
    orchestrator = new ReindexOrchestrator(store, [handler2, handler3, handler4]);
  });

  describe('analyze', () => {
    it('returns hasChanges=false for identical pipelines', async () => {
      const pipeline = makePipeline();
      const result = await orchestrator.analyze('tenant-1', 'index-1', pipeline, pipeline);

      expect(result.hasChanges).toBe(false);
      expect(result.plan.actions).toHaveLength(0);
      expect(mockBuildReindexPlan).not.toHaveBeenCalled();
    });

    it('detects embedding changes and calls router', async () => {
      const oldPipeline = makePipeline();
      const newPipeline = makePipeline({
        activeEmbeddingConfig: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 512,
        },
      });

      const mockPlan = {
        actions: [
          {
            chunkId: 'chunk-1',
            flowId: '',
            checkpoint: 4 as const,
            stages: ['embedding' as const],
          },
        ],
        summary: {
          checkpoint1Count: 0,
          checkpoint2Count: 0,
          checkpoint3Count: 0,
          checkpoint4Count: 1,
          totalDocuments: 0,
          totalChunks: 1,
          estimatedCostUsd: 0.0001,
          estimatedDurationMin: 1,
        },
      };
      mockBuildReindexPlan.mockResolvedValue(mockPlan);

      const result = await orchestrator.analyze('tenant-1', 'index-1', oldPipeline, newPipeline);

      expect(result.hasChanges).toBe(true);
      expect(result.changeSet.embeddingChanged).toBe(true);
      expect(result.plan).toEqual(mockPlan);
      expect(mockBuildReindexPlan).toHaveBeenCalledOnce();
    });

    it('detects pre-chunk changes', async () => {
      const oldPipeline = makePipeline();
      const newPipeline = makePipeline({
        flows: [
          makeFlow({
            stages: [makeStage({ provider: 'tika' })],
          }),
        ],
      });

      mockBuildReindexPlan.mockResolvedValue({
        actions: [
          {
            documentId: 'doc-1',
            flowId: 'flow-1',
            checkpoint: 2 as const,
            stages: [
              'extraction' as const,
              'chunking' as const,
              'enrichment' as const,
              'embedding' as const,
            ],
          },
        ],
        summary: {
          checkpoint1Count: 0,
          checkpoint2Count: 1,
          checkpoint3Count: 0,
          checkpoint4Count: 0,
          totalDocuments: 1,
          totalChunks: 0,
          estimatedCostUsd: 0.005,
          estimatedDurationMin: 1,
        },
      });

      const result = await orchestrator.analyze('tenant-1', 'index-1', oldPipeline, newPipeline);

      expect(result.hasChanges).toBe(true);
      expect(result.changeSet.preChunkChanges).toHaveLength(1);
    });

    it('detects routing changes', async () => {
      const oldPipeline = makePipeline();
      const newPipeline = makePipeline({
        flows: [makeFlow({ priority: 99 })],
      });

      mockBuildReindexPlan.mockResolvedValue({
        actions: [],
        summary: {
          checkpoint1Count: 0,
          checkpoint2Count: 0,
          checkpoint3Count: 0,
          checkpoint4Count: 0,
          totalDocuments: 0,
          totalChunks: 0,
          estimatedCostUsd: 0,
          estimatedDurationMin: 0,
        },
      });

      const result = await orchestrator.analyze('tenant-1', 'index-1', oldPipeline, newPipeline);

      expect(result.hasChanges).toBe(true);
      expect(result.changeSet.routingChanged).toBe(true);
    });
  });

  describe('execute', () => {
    it('persists change set and dispatches to handlers', async () => {
      const actions: ReindexAction[] = [
        {
          documentId: 'doc-1',
          flowId: 'flow-1',
          checkpoint: 2,
          stages: ['extraction', 'chunking', 'enrichment', 'embedding'],
        },
        {
          chunkId: 'chunk-1',
          flowId: 'flow-1',
          checkpoint: 3,
          stages: ['enrichment', 'embedding'],
        },
        {
          chunkId: 'chunk-2',
          documentId: 'doc-2',
          flowId: '',
          checkpoint: 4,
          stages: ['embedding'],
        },
      ];

      const analyzeResult = {
        changeSet: {
          embeddingChanged: true,
          routingChanged: false,
          preChunkChanges: [],
          postChunkChanges: [],
        },
        plan: {
          actions,
          summary: {
            checkpoint1Count: 0,
            checkpoint2Count: 1,
            checkpoint3Count: 1,
            checkpoint4Count: 1,
            totalDocuments: 1,
            totalChunks: 2,
            estimatedCostUsd: 0.01,
            estimatedDurationMin: 1,
          },
        },
        hasChanges: true,
      };

      const result = await orchestrator.execute(
        'tenant-1',
        'kb-1',
        'pipeline-1',
        'index-1',
        analyzeResult,
        2,
        1,
      );

      expect(result.totalItems).toBe(3);
      expect(result.batchId).toBeDefined();

      // Store interactions
      expect(store.save).toHaveBeenCalledOnce();
      const savedChangeSet = (store.save as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as PersistedChangeSet;
      expect(savedChangeSet.tenantId).toBe('tenant-1');
      expect(savedChangeSet.status).toBe('executing');
      expect(savedChangeSet.previousPipelineVersion).toBe(1);
      expect(savedChangeSet.newPipelineVersion).toBe(2);

      expect(store.markProcessed).toHaveBeenCalledOnce();

      // Handler dispatches
      expect(handler2.execute).toHaveBeenCalledOnce();
      const h2Actions = (handler2.execute as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ReindexAction[];
      expect(h2Actions).toHaveLength(1);
      expect(h2Actions[0].checkpoint).toBe(2);

      expect(handler3.execute).toHaveBeenCalledOnce();
      const h3Actions = (handler3.execute as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ReindexAction[];
      expect(h3Actions).toHaveLength(1);
      expect(h3Actions[0].checkpoint).toBe(3);

      expect(handler4.execute).toHaveBeenCalledOnce();
      const h4Actions = (handler4.execute as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ReindexAction[];
      expect(h4Actions).toHaveLength(1);
      expect(h4Actions[0].checkpoint).toBe(4);
    });

    it('passes correct ReindexParams to handlers', async () => {
      const analyzeResult = {
        changeSet: {
          embeddingChanged: true,
          routingChanged: false,
          preChunkChanges: [],
          postChunkChanges: [],
        },
        plan: {
          actions: [
            {
              chunkId: 'chunk-1',
              documentId: 'doc-1',
              flowId: '',
              checkpoint: 4 as const,
              stages: ['embedding' as const],
            },
          ],
          summary: {
            checkpoint1Count: 0,
            checkpoint2Count: 0,
            checkpoint3Count: 0,
            checkpoint4Count: 1,
            totalDocuments: 0,
            totalChunks: 1,
            estimatedCostUsd: 0.0001,
            estimatedDurationMin: 1,
          },
        },
        hasChanges: true,
      };

      await orchestrator.execute('tenant-1', 'kb-1', 'pipeline-1', 'index-1', analyzeResult, 2, 1);

      const params = (handler4.execute as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as ReindexParams;
      expect(params.tenantId).toBe('tenant-1');
      expect(params.knowledgeBaseId).toBe('kb-1');
      expect(params.pipelineId).toBe('pipeline-1');
      expect(params.indexId).toBe('index-1');
      expect(params.batchId).toBeDefined();
    });

    it('skips checkpoints with no handler', async () => {
      const orchestratorWithGap = new ReindexOrchestrator(store, [handler4]);

      const analyzeResult = {
        changeSet: {
          embeddingChanged: false,
          routingChanged: false,
          preChunkChanges: [
            {
              flowId: 'f1',
              flowName: 'Flow',
              stageType: 'extraction' as const,
              changeType: 'config-changed' as const,
            },
          ],
          postChunkChanges: [],
        },
        plan: {
          actions: [
            {
              documentId: 'doc-1',
              flowId: 'flow-1',
              checkpoint: 2 as const,
              stages: ['extraction' as const],
            },
          ],
          summary: {
            checkpoint1Count: 0,
            checkpoint2Count: 1,
            checkpoint3Count: 0,
            checkpoint4Count: 0,
            totalDocuments: 1,
            totalChunks: 0,
            estimatedCostUsd: 0.005,
            estimatedDurationMin: 1,
          },
        },
        hasChanges: true,
      };

      const result = await orchestratorWithGap.execute(
        'tenant-1',
        'kb-1',
        'pipeline-1',
        'index-1',
        analyzeResult,
        2,
        1,
      );

      // Should still complete without error
      expect(result.totalItems).toBe(1);
      expect(handler4.execute).not.toHaveBeenCalled();
    });

    it('aborts remaining checkpoints when a handler throws', async () => {
      (handler2.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('handler failed'));

      const analyzeResult = {
        changeSet: {
          embeddingChanged: true,
          routingChanged: false,
          preChunkChanges: [],
          postChunkChanges: [],
        },
        plan: {
          actions: [
            {
              documentId: 'doc-1',
              flowId: 'flow-1',
              checkpoint: 2 as const,
              stages: ['extraction' as const],
            },
            {
              chunkId: 'chunk-1',
              documentId: 'doc-2',
              flowId: '',
              checkpoint: 4 as const,
              stages: ['embedding' as const],
            },
          ],
          summary: {
            checkpoint1Count: 0,
            checkpoint2Count: 1,
            checkpoint3Count: 0,
            checkpoint4Count: 1,
            totalDocuments: 1,
            totalChunks: 1,
            estimatedCostUsd: 0.01,
            estimatedDurationMin: 1,
          },
        },
        hasChanges: true,
      };

      const result = await orchestrator.execute(
        'tenant-1',
        'kb-1',
        'pipeline-1',
        'index-1',
        analyzeResult,
        2,
        1,
      );

      // handler2 failed — later checkpoints should NOT run
      expect(handler2.execute).toHaveBeenCalledOnce();
      expect(handler4.execute).not.toHaveBeenCalled();
      // Should NOT mark as processed when a checkpoint fails
      expect(store.markProcessed).not.toHaveBeenCalled();
      expect(result.totalItems).toBe(2);
    });

    it('marks change set as processed after execution', async () => {
      const analyzeResult = {
        changeSet: {
          embeddingChanged: false,
          routingChanged: false,
          preChunkChanges: [],
          postChunkChanges: [],
        },
        plan: {
          actions: [],
          summary: {
            checkpoint1Count: 0,
            checkpoint2Count: 0,
            checkpoint3Count: 0,
            checkpoint4Count: 0,
            totalDocuments: 0,
            totalChunks: 0,
            estimatedCostUsd: 0,
            estimatedDurationMin: 0,
          },
        },
        hasChanges: false,
      };

      await orchestrator.execute('tenant-1', 'kb-1', 'pipeline-1', 'index-1', analyzeResult, 2, 1);

      expect(store.markProcessed).toHaveBeenCalledWith('tenant-1', expect.any(String));
    });
  });
});
