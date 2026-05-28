/**
 * Tests for PipelineTrigger per-pipeline enabled check and sampling.
 *
 * These are unit tests that verify the filtering logic in isolation.
 * The actual Restate handler is tested via the exported service definition.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

// We test the module's exported functions indirectly by importing the service
// and extracting the handler. We mock the DB models to control test scenarios.

// Mock Mongoose models
vi.mock('../schemas/pipeline-definition.schema.js', () => ({
  PipelineDefinitionModel: {
    find: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
  },
}));

vi.mock('../schemas/pipeline-config.schema.js', () => ({
  PipelineConfigModel: {
    find: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
    findOne: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../schemas/pipeline-run-record.schema.js', () => ({
  PipelineRunRecordModel: {
    create: vi.fn().mockResolvedValue({}),
    updateOne: vi.fn().mockResolvedValue({}),
  },
}));

// Mock the workflow reference
vi.mock('../pipeline/handlers/pipeline-run.workflow.js', () => ({
  pipelineRun: {},
}));

import { PipelineDefinitionModel } from '../schemas/pipeline-definition.schema.js';
import { PipelineConfigModel } from '../schemas/pipeline-config.schema.js';
import { PipelineRunRecordModel } from '../schemas/pipeline-run-record.schema.js';

// Import the service and extract handler
import { pipelineTrigger } from '../pipeline/handlers/pipeline-trigger.service.js';

const handleEvent = (pipelineTrigger as any).service.handleEvent as (
  ctx: any,
  event: Record<string, unknown>,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCtx() {
  const workflows: any[] = [];
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
    rand: {
      uuidv4: () => 'mock-uuid-1234',
      random: () => 0.5, // deterministic for sampling tests
    },
    workflowSendClient: () => ({
      run: (input: any) => workflows.push(input),
    }),
    _workflows: workflows,
  };
}

function makePipelineDefinition(overrides: Record<string, any> = {}) {
  return {
    _id: 'builtin:test-pipeline',
    tenantId: '__platform__',
    pipelineType: 'sentiment_analysis',
    name: 'Test Pipeline',
    version: 1,
    status: 'active',
    trigger: { type: 'kafka', kafkaTopic: 'abl.session.ended' },
    inputSchema: { required: ['tenantId', 'sessionId'], properties: {} },
    steps: [{ id: 'step-1', name: 'Step 1', type: 'compute-sentiment', config: {} }],
    createdBy: 'platform',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineTrigger — per-pipeline enabled check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('only pipelines with enabled config are triggered', async () => {
    const sentimentDef = makePipelineDefinition({
      _id: 'builtin:sentiment',
      pipelineType: 'sentiment_analysis',
      trigger: { type: 'kafka', kafkaTopic: 'abl.test.enabled.check1' },
    });
    const qualityDef = makePipelineDefinition({
      _id: 'builtin:quality',
      pipelineType: 'quality_evaluation',
      trigger: { type: 'kafka', kafkaTopic: 'abl.test.enabled.check1' },
    });

    // Both definitions match the topic
    vi.mocked(PipelineDefinitionModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([sentimentDef, qualityDef]),
    } as any);

    // Only sentiment_analysis is enabled
    vi.mocked(PipelineConfigModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([{ pipelineType: 'sentiment_analysis', config: {} }]),
    } as any);

    const ctx = createMockCtx();
    await handleEvent(ctx, {
      type: 'abl.test.enabled.check1',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
    });

    // Only sentiment pipeline should be triggered (1 workflow started)
    expect(ctx._workflows).toHaveLength(1);
    expect(PipelineRunRecordModel.updateOne).toHaveBeenCalledTimes(1);
  });

  test('disabled pipeline config blocks that specific pipeline, not others', async () => {
    const def1 = makePipelineDefinition({
      _id: 'builtin:sentiment',
      pipelineType: 'sentiment_analysis',
      trigger: { type: 'kafka', kafkaTopic: 'abl.test.enabled.check2' },
    });
    const def2 = makePipelineDefinition({
      _id: 'builtin:intent',
      pipelineType: 'intent_classification',
      trigger: { type: 'kafka', kafkaTopic: 'abl.test.enabled.check2' },
    });

    vi.mocked(PipelineDefinitionModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([def1, def2]),
    } as any);

    // Only intent is enabled, sentiment is disabled (not in results)
    vi.mocked(PipelineConfigModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([{ pipelineType: 'intent_classification', config: {} }]),
    } as any);

    const ctx = createMockCtx();
    await handleEvent(ctx, {
      type: 'abl.test.enabled.check2',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
    });

    // Only intent pipeline should be triggered
    expect(ctx._workflows).toHaveLength(1);
  });

  test('no enabled configs means no pipelines triggered', async () => {
    const def = makePipelineDefinition({
      trigger: { type: 'kafka', kafkaTopic: 'abl.test.enabled.check3' },
    });

    vi.mocked(PipelineDefinitionModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([def]),
    } as any);
    vi.mocked(PipelineConfigModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([]),
    } as any);

    const ctx = createMockCtx();
    await handleEvent(ctx, {
      type: 'abl.test.enabled.check3',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
    });

    expect(ctx._workflows).toHaveLength(0);
  });
});

describe('PipelineTrigger — sampling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('samplingRate < 1.0 skips events when roll >= rate', async () => {
    const def = makePipelineDefinition({
      trigger: { type: 'kafka', kafkaTopic: 'abl.test.sampling.check1' },
    });

    vi.mocked(PipelineDefinitionModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([def]),
    } as any);
    vi.mocked(PipelineConfigModel.find).mockReturnValueOnce({
      lean: vi
        .fn()
        .mockResolvedValue([{ pipelineType: 'sentiment_analysis', config: { samplingRate: 0.3 } }]),
    } as any);

    // ctx.rand.random() returns 0.5, which is >= 0.3, so should be sampled out
    const ctx = createMockCtx();
    await handleEvent(ctx, {
      type: 'abl.test.sampling.check1',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
    });

    expect(ctx._workflows).toHaveLength(0);
  });

  test('samplingRate = 1.0 processes all events', async () => {
    const def = makePipelineDefinition({
      trigger: { type: 'kafka', kafkaTopic: 'abl.test.sampling.check2' },
    });

    vi.mocked(PipelineDefinitionModel.find).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([def]),
    } as any);
    vi.mocked(PipelineConfigModel.find).mockReturnValueOnce({
      lean: vi
        .fn()
        .mockResolvedValue([{ pipelineType: 'sentiment_analysis', config: { samplingRate: 1.0 } }]),
    } as any);

    const ctx = createMockCtx();
    await handleEvent(ctx, {
      type: 'abl.test.sampling.check2',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
    });

    expect(ctx._workflows).toHaveLength(1);
  });
});
