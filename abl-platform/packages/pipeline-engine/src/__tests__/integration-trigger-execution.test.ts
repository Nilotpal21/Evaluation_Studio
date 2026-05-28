/**
 * Integration test: Trigger → Execution Path
 *
 * Tests the pipeline engine's core execution path: event arrives → trigger
 * matches active pipelines → resolves strategy/steps → dispatches to activity
 * router → real service handlers execute → run record created.
 *
 * Uses real MongoDB (MongoMemoryServer) for definitions, configs, and run records.
 * This is intentional — integration tests MUST test against real service boundaries.
 * Uses minimal Restate context (ctx.run passthrough) — same pattern as other
 * integration tests. No Redis (definition cache is fail-open to MongoDB).
 *
 * This test covers what the config CRUD E2E tests do NOT: the actual pipeline
 * execution path that runs in production when a Kafka event arrives.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PipelineDefinitionModel } from '../schemas/pipeline-definition.schema.js';
import { PipelineConfigModel } from '../schemas/pipeline-config.schema.js';
import { PipelineRunRecordModel } from '../schemas/pipeline-run-record.schema.js';
import {
  pipelineTrigger,
  buildRunRecordSteps,
} from '../pipeline/handlers/pipeline-trigger.service.js';
import { evaluateMetricsService } from '../pipeline/services/evaluate-metrics.service.js';
import { transformService } from '../pipeline/services/transform.service.js';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// MongoDB setup — real database via MongoMemoryServer (not mocked)
// ---------------------------------------------------------------------------

let mongod: MongoMemoryServer;
const TEST_STARTUP_TIMEOUT_MS = 300_000;
const TEST_SHUTDOWN_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { startupTimeout: 30000 } });
  await mongoose.connect(mongod.getUri());
  // Only sync indexes for pipeline-engine models (global syncIndexes fails on
  // partial filter expressions from other packages not supported by in-memory MongoDB)
  await PipelineDefinitionModel.syncIndexes();
  await PipelineConfigModel.syncIndexes();
  await PipelineRunRecordModel.syncIndexes();
}, TEST_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
}, TEST_SHUTDOWN_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all([
    PipelineRunRecordModel.deleteMany({}),
    PipelineConfigModel.deleteMany({}),
    PipelineDefinitionModel.deleteMany({}),
  ]);
});

// ---------------------------------------------------------------------------
// Extract raw handlers from Restate service definitions
// ---------------------------------------------------------------------------

const handleEvent = (pipelineTrigger as any).service.handleEvent as (
  ctx: any,
  event: Record<string, unknown>,
) => Promise<void>;

const triggerManual = (pipelineTrigger as any).service.triggerManual as (
  ctx: any,
  input: Record<string, unknown>,
) => Promise<{ runId: string }>;

function extractHandler(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return svc.service.execute;
}

// ---------------------------------------------------------------------------
// Restate context mock — supports trigger + workflow interactions
// ---------------------------------------------------------------------------

function createTriggerCtx() {
  const workflows: Array<{ runId: string; input: any }> = [];
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: (..._args: any[]) => {} },
    rand: {
      uuidv4: () => `uuid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      random: () => 0.5,
    },
    workflowSendClient: (_workflow: any, runId: string) => ({
      run: (input: any) => {
        workflows.push({ runId, input });
      },
    }),
    _workflows: workflows,
  };
}

function createActivityCtx() {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: (..._args: any[]) => {} },
  };
}

// ---------------------------------------------------------------------------
// Seed data factories
// ---------------------------------------------------------------------------

function seedDefinition(overrides: Record<string, any> = {}) {
  return {
    _id: `def-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    tenantId: '__platform__',
    name: 'Test Pipeline',
    pipelineType: 'sentiment_analysis',
    version: 1,
    status: 'active',
    configSchema: { fields: [] },
    supportedTriggers: [
      {
        id: 'on-session-end',
        type: 'kafka',
        kafkaTopic: 'abl.session.ended',
        strategy: 'batch',
        label: 'On Session End',
        description: 'Triggered when session ends',
      },
    ],
    defaultTriggerIds: ['on-session-end'],
    strategies: new Map([
      [
        'batch',
        {
          executionMode: 'batch',
          steps: [
            {
              id: 'step-1',
              name: 'Transform',
              type: 'transform',
              config: { mapping: { transformed: 'pipelineInput.sessionId' } },
            },
            {
              id: 'step-2',
              name: 'Evaluate',
              type: 'evaluate-metrics',
              config: { metrics: ['test_metric'] },
            },
          ],
          onStepFailure: 'stop',
        },
      ],
    ]),
    steps: [{ id: 'default-step', name: 'Default', type: 'transform', config: {} }],
    createdBy: 'test',
    ...overrides,
  };
}

function seedConfig(overrides: Record<string, any> = {}) {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    pipelineType: 'sentiment_analysis',
    enabled: true,
    version: 1,
    config: { samplingRate: 1.0 },
    createdBy: 'test',
    updatedBy: 'test',
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Integration: Trigger → Execution Path', () => {
  describe('Trigger matching with real MongoDB', () => {
    test('handleEvent matches pipeline by kafkaTopic and dispatches workflow', async () => {
      const def = seedDefinition();
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(seedConfig());

      const ctx = createTriggerCtx();
      await handleEvent(ctx, {
        tenantId: 'tenant-1',
        type: 'session.ended',
        sessionId: 'sess-123',
      });

      expect(ctx._workflows).toHaveLength(1);
      expect(ctx._workflows[0].input.pipelineDefinition._id).toBe(def._id);
      expect(ctx._workflows[0].input.matchedTriggerId).toBe('on-session-end');
      expect(ctx._workflows[0].input.executionMode).toBe('batch');
      expect(ctx._workflows[0].input.steps).toHaveLength(2);

      // Run record persisted in real MongoDB
      const records = await PipelineRunRecordModel.find({ pipelineId: def._id }).lean();
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('running');
      expect(records[0].trigger.type).toBe('kafka');
      expect(records[0].trigger.triggerId).toBe('on-session-end');
    });

    test('handleEvent skips pipeline when config is disabled', async () => {
      await PipelineDefinitionModel.create(seedDefinition());
      await PipelineConfigModel.create(seedConfig({ enabled: false }));

      const ctx = createTriggerCtx();
      await handleEvent(ctx, {
        tenantId: 'tenant-1',
        type: 'session.ended',
        sessionId: 'sess-456',
      });

      expect(ctx._workflows).toHaveLength(0);
    });

    test('handleEvent respects tenant isolation — platform + own tenant only', async () => {
      const platformDef = seedDefinition({ tenantId: '__platform__' });
      await PipelineDefinitionModel.create(platformDef);

      const otherTenantDef = seedDefinition({
        tenantId: 'tenant-2',
        pipelineType: 'quality_evaluation',
      });
      await PipelineDefinitionModel.create(otherTenantDef);

      await PipelineConfigModel.create(seedConfig());
      await PipelineConfigModel.create(seedConfig({ pipelineType: 'quality_evaluation' }));

      const ctx = createTriggerCtx();
      await handleEvent(ctx, { tenantId: 'tenant-1', type: 'session.ended' });

      expect(ctx._workflows).toHaveLength(1);
      expect(ctx._workflows[0].input.pipelineDefinition._id).toBe(platformDef._id);
    });
  });

  describe('Event filter matching', () => {
    test('eventFilter skips non-matching events, passes matching ones', async () => {
      const def = seedDefinition({
        supportedTriggers: [
          {
            id: 'on-session-end',
            type: 'kafka',
            kafkaTopic: 'abl.session.ended',
            strategy: 'batch',
            label: 'On Session End',
            description: 'Triggered when session ends',
            eventFilter: { field: 'data.source', equals: 'web' },
          },
        ],
      });
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(seedConfig());

      const ctx = createTriggerCtx();

      await handleEvent(ctx, {
        tenantId: 'tenant-1',
        type: 'session.ended',
        data: { source: 'mobile' },
      });
      expect(ctx._workflows).toHaveLength(0);

      await handleEvent(ctx, {
        tenantId: 'tenant-1',
        type: 'session.ended',
        data: { source: 'web' },
      });
      expect(ctx._workflows).toHaveLength(1);
    });
  });

  describe('Multi-trigger and strategy resolution', () => {
    test('resolves correct strategy per trigger based on kafkaTopic', async () => {
      const def = seedDefinition({
        supportedTriggers: [
          {
            id: 'on-session-end',
            type: 'kafka',
            kafkaTopic: 'abl.session.ended',
            strategy: 'batch',
            label: 'On Session End',
            description: 'Triggered when session ends',
          },
          {
            id: 'on-message',
            type: 'kafka',
            kafkaTopic: 'abl.message.created',
            strategy: 'realtime',
            label: 'On Message',
            description: 'Triggered on new message',
          },
        ],
        defaultTriggerIds: ['on-session-end', 'on-message'],
        strategies: new Map([
          [
            'batch',
            {
              executionMode: 'batch',
              steps: [{ id: 'batch-step', name: 'Batch', type: 'transform', config: {} }],
              onStepFailure: 'stop',
            },
          ],
          [
            'realtime',
            {
              executionMode: 'realtime',
              steps: [{ id: 'rt-step', name: 'Realtime', type: 'evaluate-metrics', config: {} }],
              onStepFailure: 'skip',
            },
          ],
        ]),
      });
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(seedConfig());

      const ctx1 = createTriggerCtx();
      await handleEvent(ctx1, { tenantId: 'tenant-1', type: 'session.ended' });
      expect(ctx1._workflows).toHaveLength(1);
      expect(ctx1._workflows[0].input.executionMode).toBe('batch');
      expect(ctx1._workflows[0].input.steps[0].id).toBe('batch-step');

      await PipelineRunRecordModel.deleteMany({});

      const ctx2 = createTriggerCtx();
      await handleEvent(ctx2, { tenantId: 'tenant-1', type: 'message.created' });
      expect(ctx2._workflows).toHaveLength(1);
      expect(ctx2._workflows[0].input.executionMode).toBe('realtime');
      expect(ctx2._workflows[0].input.steps[0].id).toBe('rt-step');
    });

    test('config activeTriggers overrides definition defaultTriggerIds', async () => {
      const def = seedDefinition({
        supportedTriggers: [
          {
            id: 'trigger-a',
            type: 'kafka',
            kafkaTopic: 'abl.session.ended',
            strategy: 'batch',
            label: 'Trigger A',
            description: 'First trigger',
          },
          {
            id: 'trigger-b',
            type: 'kafka',
            kafkaTopic: 'abl.session.ended',
            strategy: 'batch',
            label: 'Trigger B',
            description: 'Second trigger',
          },
        ],
        defaultTriggerIds: ['trigger-a', 'trigger-b'],
      });
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(seedConfig({ activeTriggers: ['trigger-b'] }));

      const ctx = createTriggerCtx();
      await handleEvent(ctx, { tenantId: 'tenant-1', type: 'session.ended' });

      expect(ctx._workflows).toHaveLength(1);
      expect(ctx._workflows[0].input.matchedTriggerId).toBe('trigger-b');
    });
  });

  describe('Sampling rate enforcement', () => {
    test('skips when random roll >= sampling rate', async () => {
      const def = seedDefinition();
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(
        seedConfig({
          config: {
            samplingRate: 0.3,
            triggerConfigs: { 'on-session-end': { samplingRate: 0.3 } },
          },
        }),
      );

      const ctx = createTriggerCtx();
      await handleEvent(ctx, { tenantId: 'tenant-1', type: 'session.ended' });
      expect(ctx._workflows).toHaveLength(0);
    });
  });

  describe('Manual trigger path', () => {
    test('triggerManual validates and dispatches workflow with projectId', async () => {
      const def = seedDefinition({ tenantId: 'tenant-1' });
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(seedConfig({ activeTriggers: ['on-session-end'] }));

      const ctx = createTriggerCtx();
      const result = await triggerManual(ctx, {
        pipelineId: def._id,
        tenantId: 'tenant-1',
        projectId: 'project-1',
        triggeredBy: 'user-123',
        triggerId: 'on-session-end',
        data: { sessionId: 'manual-sess' },
      });

      expect(result.runId).toBeDefined();
      expect(ctx._workflows).toHaveLength(1);
      expect(ctx._workflows[0].input.matchedTriggerId).toBe('on-session-end');

      const record = await PipelineRunRecordModel.findOne({ pipelineId: def._id }).lean();
      expect(record).toBeTruthy();
      expect(record!.trigger.type).toBe('manual');
      expect(record!.trigger.triggeredBy).toBe('user-123');
      expect(record!.projectId).toBe('project-1');
      expect(record!.triggerInput).toMatchObject({ sessionId: 'manual-sess' });
      expect(record!.triggerInputTruncated).toBe(false);
    });
  });

  describe('Trigger → Activity dispatch with real handlers', () => {
    test('full path: event → match → resolve steps → dispatch to real handlers', async () => {
      const def = seedDefinition();
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(seedConfig());

      const triggerCtx = createTriggerCtx();
      await handleEvent(triggerCtx, {
        tenantId: 'tenant-1',
        type: 'session.ended',
        sessionId: 'sess-exec-test',
      });

      expect(triggerCtx._workflows).toHaveLength(1);
      const workflowInput = triggerCtx._workflows[0].input;

      const activityCtx = createActivityCtx();
      const stepOutputs: Record<string, StepOutput> = {};

      for (const step of workflowInput.steps) {
        const activityType = step.activity ?? step.type;
        let result: StepOutput;

        if (activityType === 'transform') {
          result = await extractHandler(transformService)(activityCtx, {
            tenantId: workflowInput.pipelineInput.tenantId,
            config: step.config,
            previousSteps: { ...stepOutputs },
            pipelineInput: workflowInput.pipelineInput,
          } as PipelineStepContext);
        } else if (activityType === 'evaluate-metrics') {
          result = await extractHandler(evaluateMetricsService)(activityCtx, {
            tenantId: workflowInput.pipelineInput.tenantId,
            config: step.config,
            previousSteps: { ...stepOutputs },
            pipelineInput: workflowInput.pipelineInput,
          } as PipelineStepContext);
        } else {
          result = { status: 'success', data: { nodeId: step.id } };
        }

        stepOutputs[step.id] = result;
      }

      expect(Object.keys(stepOutputs)).toHaveLength(2);
      expect(stepOutputs['step-1'].status).toBe('success');
      expect(stepOutputs['step-2'].status).toBe('success');
    });
  });

  describe('Run record lifecycle', () => {
    test('buildRunRecordSteps produces correct entries', () => {
      const def = seedDefinition() as any;
      const steps = [
        { id: 's1', name: 'Step 1', type: 'transform', config: {} },
        { id: 's2', name: 'Step 2', type: 'evaluate-metrics', config: {} },
      ];

      const result = buildRunRecordSteps(def, steps as any);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 's1', name: 'Step 1', type: 'transform', status: 'pending' });
    });

    test('run record captures correct trigger metadata', async () => {
      const def = seedDefinition();
      await PipelineDefinitionModel.create(def);
      await PipelineConfigModel.create(seedConfig());

      const ctx = createTriggerCtx();
      await handleEvent(ctx, {
        tenantId: 'tenant-1',
        type: 'session.ended',
        sessionId: 'sess-record-test',
      });

      const records = await PipelineRunRecordModel.find({}).lean();
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.pipelineId).toBe(def._id);
      expect(record.pipelineVersion).toBe(1);
      expect(record.tenantId).toBe('tenant-1');
      expect(record.status).toBe('running');
      expect(record.trigger.type).toBe('kafka');
      expect(record.trigger.kafkaTopic).toBe('abl.session.ended');
      expect(record.trigger.triggerId).toBe('on-session-end');
      expect(record.trigger.executionMode).toBe('batch');
      expect(record.input).toMatchObject({ tenantId: 'tenant-1', sessionId: 'sess-record-test' });
      expect(record.steps).toHaveLength(2);
      expect(record.startedAt).toBeDefined();
    });
  });
});
