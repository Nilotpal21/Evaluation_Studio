import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createDiagnoseHandler, type WorkflowEngineDiagnoseDeps } from '../diagnose-handler.js';

function buildDeps(
  overrides: Partial<WorkflowEngineDiagnoseDeps> = {},
): WorkflowEngineDiagnoseDeps {
  return {
    getServiceBuildInfo: () => ({ version: 'test', commit: 'abc123' }),
    probeMongo: async () => ({ ok: true, latencyMs: 5 }),
    probeRedis: async () => ({ ok: true, latencyMs: 2 }),
    probeClickHouse: async () => null,
    probeKafka: async () => null,
    getOutboxPollerState: () => ({ running: false, pollIntervalMs: null, unpublishedRows: null }),
    env: {},
    ...overrides,
  };
}

function createApp(deps: WorkflowEngineDiagnoseDeps) {
  const app = express();
  app.get('/diagnose', createDiagnoseHandler(deps));
  return app;
}

describe('workflow-engine /diagnose', () => {
  test('default posture: all-off flags, Mongo+Redis only, pipeline idle', async () => {
    const app = createApp(buildDeps());
    const res = await request(app).get('/diagnose').expect(200);

    expect(res.body.service).toBe('workflow-engine');
    expect(res.body.build).toEqual({ version: 'test', commit: 'abc123' });
    expect(res.body.dependencies.mongodb.ok).toBe(true);
    expect(res.body.dependencies.redis.ok).toBe(true);
    expect(res.body.dependencies.clickhouse).toBeUndefined();
    expect(res.body.dependencies.kafka).toBeUndefined();
    expect(res.body.pipeline.outboxPoller).toEqual({
      running: false,
      pollIntervalMs: null,
      unpublishedRows: null,
    });
    expect(res.body.pipeline.kafkaTopics).toBeUndefined();

    const outboxFlag = res.body.flags.find(
      (f: { name: string }) => f.name === 'WORKFLOW_OUTBOX_ENABLED',
    );
    expect(outboxFlag).toMatchObject({ value: '', isDefault: true });
  });

  test('flags section reflects explicit env values', async () => {
    const app = createApp(
      buildDeps({
        env: {
          WORKFLOW_OUTBOX_ENABLED: 'true',
          WORKFLOW_OUTBOX_BATCH_SIZE: '250',
        },
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);

    const snapshotByName = Object.fromEntries(
      res.body.flags.map((f: { name: string }) => [f.name, f]),
    );
    expect(snapshotByName.WORKFLOW_OUTBOX_ENABLED).toMatchObject({
      value: 'true',
      isDefault: false,
    });
    expect(snapshotByName.WORKFLOW_OUTBOX_BATCH_SIZE).toMatchObject({
      value: '250',
      isDefault: false,
    });
    // Unset flag stays marked as default.
    expect(snapshotByName.WORKFLOW_MONGO_TTL_ENABLED).toMatchObject({
      value: '',
      isDefault: true,
    });
  });

  test('Mongo probe failure surfaces into dependencies.mongodb without failing the whole response', async () => {
    const app = createApp(
      buildDeps({
        probeMongo: async () => ({ ok: false, latencyMs: 1200, detail: 'connection refused' }),
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);
    expect(res.body.dependencies.mongodb).toEqual({
      ok: false,
      latencyMs: 1200,
      detail: 'connection refused',
    });
  });

  test('Kafka probe present ⇒ dependencies.kafka and pipeline.kafkaTopics both populated', async () => {
    const app = createApp(
      buildDeps({
        probeKafka: async () => ({
          ok: true,
          brokers: ['localhost:19092'],
          latencyMs: 80,
          topics: {
            'abl.workflow.execution': { exists: true, partitionCount: 6 },
            'abl.human.task': { exists: false },
          },
        }),
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);
    expect(res.body.dependencies.kafka.ok).toBe(true);
    expect(res.body.dependencies.kafka.topics['abl.workflow.execution']).toEqual({
      exists: true,
      partitionCount: 6,
    });
    expect(res.body.pipeline.kafkaTopics['abl.human.task']).toEqual({ exists: false });
  });

  test('Outbox poller running ⇒ pipeline.outboxPoller exposes cadence + backlog', async () => {
    const app = createApp(
      buildDeps({
        getOutboxPollerState: () => ({ running: true, pollIntervalMs: 1000, unpublishedRows: 42 }),
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);
    expect(res.body.pipeline.outboxPoller).toEqual({
      running: true,
      pollIntervalMs: 1000,
      unpublishedRows: 42,
    });
  });

  test('auditLogger receives one info event per invocation with request metadata', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const app = createApp(
      buildDeps({
        auditLogger: {
          info: (event, fields) => events.push({ event, fields }),
        },
      }),
    );
    await request(app)
      .get('/diagnose')
      .set('User-Agent', 'curl/8.4.0')
      .set('X-Request-Id', 'req-abc123')
      .expect(200);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('diagnose.invoked');
    expect(events[0].fields).toMatchObject({
      userAgent: 'curl/8.4.0',
      requestId: 'req-abc123',
    });
  });
});
