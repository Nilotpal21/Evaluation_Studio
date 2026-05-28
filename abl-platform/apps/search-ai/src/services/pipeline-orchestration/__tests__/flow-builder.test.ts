/**
 * Unit tests for Pipeline Flow Builder
 *
 * Tests BullMQ Flows integration and critical safety patterns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PipelineFlowBuilder,
  getWorkerLockSettings,
  checkBackpressure,
  safeAddFlow,
} from '../flow-builder.js';
import {
  FLOW_CHILD_DEFAULTS,
  MAX_QUEUE_DEPTH,
  BackpressureError,
  FlowBuildError,
  FlowCreationValidationError,
} from '../types.js';
import type { ISearchPipelineDefinition } from '@agent-platform/database';
import type { FlowBuildContext } from '../types.js';

// ─── Test Helpers ────────────────────────────────────────────────────────

function createMockContext(overrides?: Partial<FlowBuildContext>): FlowBuildContext {
  return {
    documentId: 'doc-123',
    tenantId: 'tenant-456',
    sourceId: 'source-789',
    indexId: 'index-abc',
    document: {
      extension: 'pdf',
      mimeType: 'application/pdf',
      size: 1048576,
      name: 'test.pdf',
    },
    source: {
      connector: 'upload',
    },
    ...overrides,
  };
}

// Mock pipeline definition
function createMockPipeline(): ISearchPipelineDefinition {
  return {
    _id: 'pipeline-123',
    tenantId: 'tenant-456',
    knowledgeBaseId: 'kb-789',
    name: 'Test Pipeline',
    description: 'Test pipeline for unit tests',
    version: 1,
    status: 'active',
    isDefault: false,
    flows: [
      {
        id: 'flow-001',
        name: 'default-flow',
        description: 'Default processing flow',
        enabled: true,
        priority: 10,
        stages: [
          {
            id: 'stage-001',
            name: 'extraction',
            type: 'extraction',
            provider: 'mock-extraction',
            config: { model: 'v1' },
            order: 0,
          },
          {
            id: 'stage-002',
            name: 'enrichment',
            type: 'enrichment',
            provider: 'mock-enrichment',
            config: { temperature: 0.7 },
            order: 1,
          },
          {
            id: 'stage-003',
            name: 'embedding',
            type: 'embedding',
            provider: 'bge-m3',
            config: {},
            order: 2,
          },
        ],
        selectionRules: [],
      },
    ],
    createdBy: 'test-user',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ISearchPipelineDefinition;
}

describe('getWorkerLockSettings', () => {
  it('should return 10 min for docling-extraction', () => {
    const settings = getWorkerLockSettings('search-docling-extraction');

    expect(settings).toEqual({
      lockDuration: 600_000, // 10 minutes
      stalledInterval: 300_000, // 5 minutes
    });
  });

  it('should return 2 min for enrichment', () => {
    const settings = getWorkerLockSettings('search-enrichment');

    expect(settings).toEqual({
      lockDuration: 120_000, // 2 minutes
      stalledInterval: 60_000, // 1 minute
    });
  });

  it('should return 3 min for embedding', () => {
    const settings = getWorkerLockSettings('search-embedding');

    expect(settings).toEqual({
      lockDuration: 180_000, // 3 minutes
      stalledInterval: 90_000, // 1.5 minutes
    });
  });

  it('should return 1 min default for unknown stages', () => {
    const settings = getWorkerLockSettings('search-unknown-stage');

    expect(settings).toEqual({
      lockDuration: 60_000, // 1 minute
      stalledInterval: 30_000, // 30 seconds
    });
  });
});

describe('checkBackpressure', () => {
  it('should pass when queue depth is below threshold', async () => {
    const mockQueue = {
      getWaitingCount: vi.fn().mockResolvedValue(100),
    } as any;

    await expect(checkBackpressure(mockQueue, 'search-extraction')).resolves.toBeUndefined();
    expect(mockQueue.getWaitingCount).toHaveBeenCalledTimes(1);
  });

  it('should throw BackpressureError when queue depth exceeds threshold', async () => {
    const mockQueue = {
      getWaitingCount: vi.fn().mockResolvedValue(600),
    } as any;

    await expect(checkBackpressure(mockQueue, 'search-extraction')).rejects.toThrow(
      BackpressureError,
    );

    try {
      await checkBackpressure(mockQueue, 'search-extraction');
    } catch (error) {
      expect(error).toBeInstanceOf(BackpressureError);
      const bpError = error as BackpressureError;
      expect(bpError.queueName).toBe('search-extraction');
      expect(bpError.currentDepth).toBe(600);
      expect(bpError.maxDepth).toBe(MAX_QUEUE_DEPTH['search-extraction']);
      expect(bpError.retryAfterMs).toBe(30_000);
    }
  });

  it('should use default max depth for unknown queues', async () => {
    const mockQueue = {
      getWaitingCount: vi.fn().mockResolvedValue(600),
    } as any;

    await expect(checkBackpressure(mockQueue, 'search-unknown-queue')).rejects.toThrow(
      BackpressureError,
    );
  });
});

describe('PipelineFlowBuilder', () => {
  let builder: PipelineFlowBuilder;

  beforeEach(() => {
    builder = new PipelineFlowBuilder();
  });

  describe('buildFlow', () => {
    it('should build flow with correct structure', async () => {
      const pipeline = createMockPipeline();
      const context = createMockContext();

      const result = await builder.buildFlow(pipeline, context);

      expect(result.success).toBe(true);
      expect(result.flow).toBeDefined();
      expect(result.flow!.name).toContain('doc-123');
      // Queue name depends on extraction provider — mock-extraction routes to search-extraction
      expect(result.flow!.queueName).toBe('search-extraction');
      expect(result.details.stageCount).toBe(3);
      // New architecture: single flat job with no children.
      // Workers chain sequentially via _enrichmentStage/_embeddingStage in job data.
      // Only the root queue appears in queueNames.
      expect(result.details.queueNames).toContain('search-extraction');
    });

    it('should apply FLOW_CHILD_DEFAULTS to root job', async () => {
      const pipeline = createMockPipeline();
      const context = createMockContext();

      const result = await builder.buildFlow(pipeline, context);

      expect(result.success).toBe(true);
      expect(result.flow!.opts).toMatchObject({
        failParentOnFailure: FLOW_CHILD_DEFAULTS.failParentOnFailure,
        removeOnComplete: FLOW_CHILD_DEFAULTS.removeOnComplete,
        removeOnFail: FLOW_CHILD_DEFAULTS.removeOnFail,
        attempts: FLOW_CHILD_DEFAULTS.attempts,
        backoff: FLOW_CHILD_DEFAULTS.backoff,
      });
    });

    it('should inject downstream stage configs into job data for sequential chaining', async () => {
      const pipeline = createMockPipeline();
      const context = createMockContext();

      const result = await builder.buildFlow(pipeline, context);

      expect(result.success).toBe(true);
      // New architecture: no BullMQ Flow children — workers chain sequentially.
      // Downstream stages are injected as _enrichmentStage and _embeddingStage in job data.
      expect(result.flow!.children).toBeUndefined();
      expect(result.flow!.data).toHaveProperty('_enrichmentStage');
      expect(result.flow!.data).toHaveProperty('_embeddingStage');

      const data = result.flow!.data as Record<string, any>;
      expect(data._enrichmentStage).toMatchObject({
        pipelineId: 'pipeline-123',
        provider: 'mock-enrichment',
      });
      expect(data._embeddingStage).toMatchObject({
        pipelineId: 'pipeline-123',
        provider: 'bge-m3',
      });
    });

    it('should include pipeline context in job data', async () => {
      const pipeline = createMockPipeline();
      const context = createMockContext();

      const result = await builder.buildFlow(pipeline, context);

      expect(result.success).toBe(true);
      expect(result.flow!.data).toMatchObject({
        pipelineId: 'pipeline-123',
        pipelineVersion: 1,
        documentId: 'doc-123',
        tenantId: 'tenant-456',
        sourceId: 'source-789',
        indexId: 'index-abc',
        stageType: 'extraction',
        provider: 'mock-extraction',
      });
    });

    it('should fail when no enabled flows found', async () => {
      const pipeline = createMockPipeline();
      pipeline.flows[0].enabled = false;

      const context = createMockContext();

      const result = await builder.buildFlow(pipeline, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should throw FlowBuildError when flow has no stages', async () => {
      const pipeline = createMockPipeline();
      pipeline.flows[0].stages = [];

      const context = createMockContext();

      await expect(builder.buildFlow(pipeline, context)).rejects.toThrow(FlowBuildError);
    });
  });
});

describe('safeAddFlow', () => {
  it('should return result when flow is created successfully', async () => {
    const mockFlowProducer = {
      add: vi.fn().mockResolvedValue({
        job: { id: 'flow-job-123' },
      }),
    } as any;

    const mockParentQueue = {
      getJob: vi.fn().mockResolvedValue({ id: 'flow-job-123' }),
    } as any;

    const mockFlow = {
      name: 'test-flow',
      queueName: 'search-extraction',
      data: {},
    } as any;

    const result = await safeAddFlow(mockFlowProducer, mockFlow, mockParentQueue);

    expect(result.job.id).toBe('flow-job-123');
    expect(mockFlowProducer.add).toHaveBeenCalledWith(mockFlow);
    expect(mockParentQueue.getJob).toHaveBeenCalledWith('flow-job-123');
  });

  it('should throw FlowCreationValidationError when parent job does not exist', async () => {
    const mockFlowProducer = {
      add: vi.fn().mockResolvedValue({
        job: { id: 'flow-job-123' },
      }),
    } as any;

    const mockParentQueue = {
      getJob: vi.fn().mockResolvedValue(null), // Job doesn't exist
    } as any;

    const mockFlow = {
      name: 'test-flow',
      queueName: 'search-extraction',
      data: {},
    } as any;

    await expect(safeAddFlow(mockFlowProducer, mockFlow, mockParentQueue)).rejects.toThrow(
      FlowCreationValidationError,
    );

    try {
      await safeAddFlow(mockFlowProducer, mockFlow, mockParentQueue);
    } catch (error) {
      expect(error).toBeInstanceOf(FlowCreationValidationError);
      const validationError = error as FlowCreationValidationError;
      expect(validationError.flowName).toBe('test-flow');
      expect(validationError.flowJobId).toBe('flow-job-123');
      expect(validationError.message).toContain('Redis may be in READONLY mode');
    }
  });
});

describe('FLOW_CHILD_DEFAULTS', () => {
  it('should have failParentOnFailure: true', () => {
    expect(FLOW_CHILD_DEFAULTS.failParentOnFailure).toBe(true);
  });

  it('should have removeOnComplete configured', () => {
    expect(FLOW_CHILD_DEFAULTS.removeOnComplete).toEqual({
      age: 3600,
      count: 200,
    });
  });

  it('should have removeOnFail configured', () => {
    expect(FLOW_CHILD_DEFAULTS.removeOnFail).toEqual({
      age: 86400,
      count: 1000,
    });
  });

  it('should have retry with exponential backoff', () => {
    expect(FLOW_CHILD_DEFAULTS.attempts).toBe(3);
    expect(FLOW_CHILD_DEFAULTS.backoff).toEqual({
      type: 'exponential',
      delay: 5000,
    });
  });

  it('should not include worker-only options in job defaults', () => {
    // lockDuration, stalledInterval, maxStalledCount are WorkerOptions, not JobsOptions
    expect(FLOW_CHILD_DEFAULTS).not.toHaveProperty('maxStalledCount');
    expect(FLOW_CHILD_DEFAULTS).not.toHaveProperty('lockDuration');
    expect(FLOW_CHILD_DEFAULTS).not.toHaveProperty('stalledInterval');
  });
});

describe('MAX_QUEUE_DEPTH', () => {
  it('should have depth limits for all critical queues', () => {
    expect(MAX_QUEUE_DEPTH['search-extraction']).toBe(500);
    expect(MAX_QUEUE_DEPTH['search-docling-extraction']).toBe(300);
    expect(MAX_QUEUE_DEPTH['search-enrichment']).toBe(1000);
    expect(MAX_QUEUE_DEPTH['search-embedding']).toBe(500);
  });
});
