import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { EvalRun, Tenant } from '@agent-platform/database/models';
import {
  runEvalRetentionCleanup,
  type EvalRetentionCleanupTraceEvent,
  type EvalRetentionTraceSink,
} from '../pipeline/services/eval/eval-retention-cleanup.js';

let mongod: MongoMemoryServer | undefined;
let mongoReady = false;

async function setupMongo() {
  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: process.env.MONGOMS_VERSION ?? '7.0.20' },
    });
    await mongoose.connect(mongod.getUri(), {
      directConnection: true,
      serverSelectionTimeoutMS: 120_000,
    });
    await mongoose.connection.asPromise();
    mongoReady = true;
  } catch {
    mongoReady = false;
  }
}

async function teardownMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
  mongod = undefined;
  mongoReady = false;
}

async function clearCollections() {
  if (!mongoReady) return;
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
}

async function createTenant(
  tenantId: string,
  evalRetention: {
    evalConversationsTtlDays: number;
    evalScoresTtlDays: number;
    syntheticTtlDays: number;
    hardDeleteExpiredRuns?: boolean;
  },
) {
  await Tenant.create({
    _id: tenantId,
    name: tenantId,
    slug: tenantId,
    ownerId: 'owner-1',
    settings: { evalRetention },
  });
}

async function createRun(params: {
  tenantId: string;
  runId: string;
  knownSource?: 'production' | 'eval' | 'synthetic';
  createdAt: Date;
}) {
  await EvalRun.create({
    _id: params.runId,
    tenantId: params.tenantId,
    projectId: 'project-1',
    evalSetId: 'eval-set-1',
    status: 'completed',
    triggerSource: 'manual',
    knownSource: params.knownSource ?? 'eval',
    triggeredBy: 'user-1',
    summary: {
      totalConversations: 1,
      totalEvaluations: 1,
      avgScore: 0.8,
      scoresByEvaluator: {},
      durationMs: 100,
      estimatedCost: 0.01,
      actualCost: 0.01,
      stdDev: 0,
      confidenceInterval: [0.8, 0.8],
      passAtK: 1,
      passExpK: 1,
    },
    baselineRunId: 'baseline-1',
    regressionDetails: [
      {
        evaluatorId: 'evaluator-1',
        personaId: 'persona-1',
        scenarioId: 'scenario-1',
        baselineScore: 1,
        currentScore: 0.8,
        delta: -0.2,
      },
    ],
  });
  await EvalRun.collection.updateOne(
    { _id: params.runId, tenantId: params.tenantId },
    { $set: { createdAt: params.createdAt } },
  );
}

function createRecordingTraceSink(): {
  events: EvalRetentionCleanupTraceEvent[];
  sink: EvalRetentionTraceSink;
} {
  const events: EvalRetentionCleanupTraceEvent[] = [];
  return {
    events,
    sink: {
      appendEvent: async (_traceId, event) => {
        events.push(event);
      },
    },
  };
}

beforeAll(async () => {
  await setupMongo();
});

afterAll(async () => {
  await teardownMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('runEvalRetentionCleanup', () => {
  test('archives expired runs and preserves summaries while stripping detail fields', async ({
    skip,
  }) => {
    if (!mongoReady) return skip();
    const now = new Date('2026-05-11T00:00:00.000Z');
    await createTenant('tenant-archive', {
      evalConversationsTtlDays: 10,
      evalScoresTtlDays: 10,
      syntheticTtlDays: 7,
    });
    await createRun({
      tenantId: 'tenant-archive',
      runId: 'expired-eval',
      createdAt: new Date('2026-04-20T00:00:00.000Z'),
    });
    await createRun({
      tenantId: 'tenant-archive',
      runId: 'expired-synthetic',
      knownSource: 'synthetic',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    await createRun({
      tenantId: 'tenant-archive',
      runId: 'fresh-eval',
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
    });

    const trace = createRecordingTraceSink();
    const summary = await runEvalRetentionCleanup(now, { traceSink: trace.sink });

    expect(summary).toMatchObject({ tenantsScanned: 1, runsArchived: 2, runsDeleted: 0 });
    expect(trace.events.map((event) => event.type)).toEqual([
      'eval.retention.cleanup_started',
      'eval.retention.run_archived',
      'eval.retention.run_archived',
      'eval.retention.cleanup_complete',
    ]);
    expect(trace.events[0].data).toMatchObject({
      tenantId: 'tenant-archive',
      runsScannedTarget: 2,
    });
    expect(trace.events[1].data).toMatchObject({
      tenantId: 'tenant-archive',
      runId: 'expired-eval',
      archivedReason: 'retention_expired',
      retainedFields: ['summary', 'status', 'archivedAt', 'archivedReason'],
    });
    expect(trace.events[3].data).toMatchObject({
      tenantId: 'tenant-archive',
      archivedCount: 2,
      hardDeletedCount: 0,
      errorCount: 0,
    });

    const expired = await EvalRun.findOne({ tenantId: 'tenant-archive', _id: 'expired-eval' });
    const synthetic = await EvalRun.findOne({
      tenantId: 'tenant-archive',
      _id: 'expired-synthetic',
    });
    const fresh = await EvalRun.findOne({ tenantId: 'tenant-archive', _id: 'fresh-eval' });

    expect(expired?.archived).toBe(true);
    expect(expired?.archivedReason).toBe('retention_expired');
    expect(expired?.summary?.totalConversations).toBe(1);
    expect(expired?.baselineRunId).toBeUndefined();
    expect(expired?.regressionDetails ?? []).toHaveLength(0);
    expect(synthetic?.archived).toBe(true);
    expect(fresh?.archived).toBe(false);
  });

  test('hard deletes expired runs when the tenant opts in', async ({ skip }) => {
    if (!mongoReady) return skip();
    const now = new Date('2026-05-11T00:00:00.000Z');
    await createTenant('tenant-delete', {
      evalConversationsTtlDays: 40,
      evalScoresTtlDays: 40,
      syntheticTtlDays: 7,
      hardDeleteExpiredRuns: true,
    });
    await createRun({
      tenantId: 'tenant-delete',
      runId: 'deleted-eval',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    const trace = createRecordingTraceSink();
    const summary = await runEvalRetentionCleanup(now, { traceSink: trace.sink });

    expect(summary).toMatchObject({ tenantsScanned: 1, runsArchived: 0, runsDeleted: 1 });
    expect(trace.events.map((event) => event.type)).toEqual([
      'eval.retention.cleanup_started',
      'eval.retention.run_hard_deleted',
      'eval.retention.cleanup_complete',
    ]);
    expect(trace.events[1].data).toMatchObject({
      tenantId: 'tenant-delete',
      runId: 'deleted-eval',
      deletedAt: now.toISOString(),
    });
    await expect(
      EvalRun.findOne({ tenantId: 'tenant-delete', _id: 'deleted-eval' }),
    ).resolves.toBeNull();
  });

  test('emits cleanup_error when tenant retention settings are invalid', async ({ skip }) => {
    if (!mongoReady) return skip();
    const now = new Date('2026-05-11T00:00:00.000Z');
    await createTenant('tenant-invalid', {
      evalConversationsTtlDays: 10,
      evalScoresTtlDays: 10,
      syntheticTtlDays: 10,
    });
    const trace = createRecordingTraceSink();

    const summary = await runEvalRetentionCleanup(now, { traceSink: trace.sink });

    expect(summary.tenantsScanned).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(trace.events.map((event) => event.type)).toEqual([
      'eval.retention.cleanup_error',
      'eval.retention.cleanup_complete',
    ]);
    expect(trace.events[0].data).toMatchObject({
      tenantId: 'tenant-invalid',
      errorCode: 'Error',
    });
    expect(trace.events[1].data).toMatchObject({
      tenantId: 'tenant-invalid',
      archivedCount: 0,
      hardDeletedCount: 0,
      errorCount: 1,
    });
  });
});
