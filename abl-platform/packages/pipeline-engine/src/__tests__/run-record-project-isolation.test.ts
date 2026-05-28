import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PipelineRunRecordModel } from '../schemas/pipeline-run-record.schema.js';

describe('PipelineRunRecord — projectId + triggerInput', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await PipelineRunRecordModel.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it('persists projectId and triggerInput', async () => {
    await PipelineRunRecordModel.create({
      _id: 'run-1',
      runId: 'run-1',
      pipelineId: 'pipe-1',
      pipelineVersion: 1,
      tenantId: 'tenant-a',
      projectId: 'project-x',
      status: 'pending',
      trigger: { type: 'manual', triggerId: 't1', executionMode: 'realtime' },
      input: {},
      triggerInput: { sessionId: 'sess-1', hello: 'world' },
      startedAt: new Date(),
      steps: [],
    });

    const found = await PipelineRunRecordModel.findOne({ runId: 'run-1' }).lean();
    expect(found?.projectId).toBe('project-x');
    expect(found?.triggerInput).toEqual({ sessionId: 'sess-1', hello: 'world' });
    expect(found?.triggerInputTruncated).toBeUndefined();
  });

  it('filters by tenantId + projectId composite index', async () => {
    await PipelineRunRecordModel.create([
      {
        _id: 'r-a',
        runId: 'r-a',
        pipelineId: 'p1',
        pipelineVersion: 1,
        tenantId: 'tenant-a',
        projectId: 'project-x',
        status: 'completed',
        trigger: { type: 'kafka', triggerId: 't1', executionMode: 'batch' },
        input: {},
        steps: [],
        startedAt: new Date(),
      },
      {
        _id: 'r-b',
        runId: 'r-b',
        pipelineId: 'p1',
        pipelineVersion: 1,
        tenantId: 'tenant-a',
        projectId: 'project-y',
        status: 'completed',
        trigger: { type: 'kafka', triggerId: 't1', executionMode: 'batch' },
        input: {},
        steps: [],
        startedAt: new Date(),
      },
    ]);

    const xRuns = await PipelineRunRecordModel.find({
      tenantId: 'tenant-a',
      projectId: 'project-x',
    }).lean();
    expect(xRuns).toHaveLength(2); // includes run-1 from first test + r-a
    expect(xRuns.every((r) => r.projectId === 'project-x')).toBe(true);
  });
});
