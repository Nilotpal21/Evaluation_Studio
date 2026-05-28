import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PipelineDefinitionModel } from '../schemas/pipeline-definition.schema.js';
import { PipelineConfigModel } from '../schemas/pipeline-config.schema.js';
import { PipelineRunRecordModel } from '../schemas/pipeline-run-record.schema.js';
import {
  validateManualTriggerInput,
  ManualTriggerValidationError,
} from '../pipeline/handlers/pipeline-trigger.service.js';

describe('triggerManual — input validation (unit)', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Promise.all([
      PipelineDefinitionModel.syncIndexes(),
      PipelineConfigModel.syncIndexes(),
      PipelineRunRecordModel.syncIndexes(),
    ]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });
  beforeEach(async () => {
    await Promise.all([
      PipelineDefinitionModel.deleteMany({}),
      PipelineConfigModel.deleteMany({}),
      PipelineRunRecordModel.deleteMany({}),
    ]);
  });

  const seedPipeline = async () => {
    await PipelineDefinitionModel.create({
      _id: 'def-1',
      tenantId: '__platform__',
      name: 'Sentiment',
      version: 1,
      status: 'active',
      pipelineType: 'sentiment_analysis',
      supportedTriggers: [
        {
          id: 't-kafka',
          type: 'kafka',
          kafkaTopic: 'abl.session.ended',
          strategy: 'default',
          label: 'On Session End',
          description: 'Triggered when session ends',
          inputSchema: {
            required: ['tenantId', 'sessionId'],
            properties: {
              tenantId: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
      ],
      defaultTriggerIds: ['t-kafka'],
      nodes: [{ id: 'n1', type: 'noop', label: 'Start' }],
      entryNodeId: 'n1',
      createdBy: 'test',
    });
  };

  const seedBuiltinConfig = async () => {
    await PipelineConfigModel.create({
      tenantId: 'tenant-a',
      projectId: 'project-x',
      pipelineType: 'sentiment_analysis',
      enabled: true,
      activeTriggers: ['t-kafka'],
      createdBy: 'test',
      updatedBy: 'test',
    });
  };

  const seedCustomPipeline = async () => {
    await PipelineDefinitionModel.create({
      _id: 'custom-1',
      tenantId: 'tenant-a',
      projectId: 'project-x',
      name: 'Custom Friction Score',
      version: 1,
      status: 'active',
      supportedTriggers: [
        {
          id: 'manual-trigger',
          type: 'manual',
          strategy: 'default',
          label: 'Manual test',
          description: 'Run the custom pipeline manually',
          inputSchema: { required: ['payload'], properties: { payload: { type: 'object' } } },
        },
      ],
      defaultTriggerIds: ['manual-trigger'],
      nodes: [{ id: 'n1', type: 'noop', label: 'Start' }],
      entryNodeId: 'n1',
      createdBy: 'test',
    });
  };

  it('rejects when trigger is not active on config', async () => {
    await seedPipeline();
    await seedBuiltinConfig();
    // Set activeTriggers to a different trigger ID so 't-kafka' is not active.
    // Note: empty array falls through to defaultTriggerIds per resolveActiveTriggers logic.
    await PipelineConfigModel.updateOne(
      { tenantId: 'tenant-a', pipelineType: 'sentiment_analysis' },
      { $set: { activeTriggers: ['t-other'] } },
    );

    await expect(
      validateManualTriggerInput({
        pipelineId: 'def-1',
        tenantId: 'tenant-a',
        projectId: 'project-x',
        triggerId: 't-kafka',
        data: { sessionId: 'sess-1' },
      }),
    ).rejects.toMatchObject({ code: 'TRIGGER_NOT_ACTIVE' });
  });

  it('falls back to platform defaults when the requested project has no builtin config', async () => {
    await seedPipeline();
    await seedBuiltinConfig();

    const result = await validateManualTriggerInput({
      pipelineId: 'def-1',
      tenantId: 'tenant-a',
      projectId: 'project-OTHER',
      triggerId: 't-kafka',
      data: { sessionId: 'sess-1' },
    });

    expect(result.pipeline._id).toBe('def-1');
    expect(result.config?.projectId ?? null).toBeNull();
    expect(result.trigger.id).toBe('t-kafka');
  });

  it('rejects when input fails inputSchema', async () => {
    await seedPipeline();
    await seedBuiltinConfig();

    await expect(
      validateManualTriggerInput({
        pipelineId: 'def-1',
        tenantId: 'tenant-a',
        projectId: 'project-x',
        triggerId: 't-kafka',
        data: {},
      }),
    ).rejects.toMatchObject({ code: 'INPUT_VALIDATION_FAILED' });
  });

  it('accepts valid input', async () => {
    await seedPipeline();
    await seedBuiltinConfig();

    const result = await validateManualTriggerInput({
      pipelineId: 'def-1',
      tenantId: 'tenant-a',
      projectId: 'project-x',
      triggerId: 't-kafka',
      data: { sessionId: 'sess-1' },
    });

    expect(result.pipeline._id).toBe('def-1');
    expect(result.trigger.id).toBe('t-kafka');
  });

  it('accepts builtin pipelines that only rely on platform defaults', async () => {
    await seedPipeline();

    const result = await validateManualTriggerInput({
      pipelineId: 'sentiment_analysis',
      tenantId: 'tenant-a',
      projectId: 'project-x',
      triggerId: 't-kafka',
      data: { sessionId: 'sess-1' },
    });

    expect(result.pipeline._id).toBe('def-1');
    expect(result.config?.projectId ?? null).toBeNull();
    expect(result.trigger.id).toBe('t-kafka');
  });

  it('accepts custom pipelines without a PipelineConfig row', async () => {
    await seedCustomPipeline();

    const result = await validateManualTriggerInput({
      pipelineId: 'custom-1',
      tenantId: 'tenant-a',
      projectId: 'project-x',
      triggerId: 'manual-trigger',
      data: { payload: { message: 'hello' } },
    });

    expect(result.pipeline._id).toBe('custom-1');
    expect(result.config).toBeNull();
    expect(result.trigger.id).toBe('manual-trigger');
  });

  it('rejects custom pipelines when projectId does not match the definition scope', async () => {
    await seedCustomPipeline();

    await expect(
      validateManualTriggerInput({
        pipelineId: 'custom-1',
        tenantId: 'tenant-a',
        projectId: 'project-OTHER',
        triggerId: 'manual-trigger',
        data: { payload: { message: 'hello' } },
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });
});
