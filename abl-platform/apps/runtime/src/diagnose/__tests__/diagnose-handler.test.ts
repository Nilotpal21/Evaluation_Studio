import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createRuntimeDiagnoseHandler, type RuntimeDiagnoseDeps } from '../diagnose-handler.js';

function buildDeps(overrides: Partial<RuntimeDiagnoseDeps> = {}): RuntimeDiagnoseDeps {
  return {
    getServiceBuildInfo: () => ({ version: 'test', commit: 'abc123' }),
    probeMongo: async () => ({ ok: true, latencyMs: 5 }),
    probeRedis: async () => ({ ok: true, latencyMs: 2 }),
    probeClickHouse: async () => null,
    probeKafka: async () => null,
    getConsumerState: () => null,
    env: {},
    ...overrides,
  };
}

function createApp(deps: RuntimeDiagnoseDeps) {
  const app = express();
  app.get('/diagnose', createRuntimeDiagnoseHandler(deps));
  return app;
}

describe('runtime /diagnose', () => {
  test('default posture: Mongo+Redis only, consumer not wired', async () => {
    const app = createApp(buildDeps());
    const res = await request(app).get('/diagnose').expect(200);

    expect(res.body.service).toBe('runtime');
    expect(res.body.dependencies.mongodb.ok).toBe(true);
    expect(res.body.dependencies.redis.ok).toBe(true);
    expect(res.body.dependencies.clickhouse).toBeUndefined();
    expect(res.body.dependencies.kafka).toBeUndefined();
    expect(res.body.pipeline.workflowEventsConsumer).toBeNull();
    expect(res.body.pipeline.kafkaTopics).toBeUndefined();
    expect(res.body.pipeline.consumerGroups).toBeUndefined();
  });

  test('flags include workflow event-sourcing + runtime features', async () => {
    const app = createApp(
      buildDeps({
        env: { WORKFLOW_CH_SINK_ENABLED: 'true', FEATURE_VOICE_ENABLED: 'true' },
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);

    const byName = Object.fromEntries(res.body.flags.map((f: { name: string }) => [f.name, f]));
    expect(byName.WORKFLOW_CH_SINK_ENABLED).toMatchObject({ value: 'true', isDefault: false });
    expect(byName.FEATURE_VOICE_ENABLED).toMatchObject({ value: 'true', isDefault: false });
    expect(byName.FEATURE_STREAMING_ENABLED).toMatchObject({ value: '', isDefault: true });
  });

  test('consumer state surfaces topics + group IDs when wired', async () => {
    const app = createApp(
      buildDeps({
        getConsumerState: () => ({
          running: true,
          topics: ['abl.workflow.execution', 'abl.human.task'],
          groupIds: ['workflow-execution-consumer', 'human-task-consumer'],
        }),
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);
    expect(res.body.pipeline.workflowEventsConsumer).toEqual({
      running: true,
      topics: ['abl.workflow.execution', 'abl.human.task'],
      groupIds: ['workflow-execution-consumer', 'human-task-consumer'],
    });
  });

  test('Kafka probe populates topics + consumer groups sections', async () => {
    const app = createApp(
      buildDeps({
        probeKafka: async () => ({
          ok: true,
          brokers: ['localhost:19092'],
          latencyMs: 120,
          topics: {
            'abl.workflow.execution': { exists: true, partitionCount: 6 },
            'abl.human.task': { exists: true, partitionCount: 6 },
          },
          consumerGroups: {
            'workflow-execution-consumer': {
              state: 'Stable',
              protocol: 'RoundRobin',
              members: [
                {
                  memberId: 'consumer-1',
                  clientId: 'runtime-pod-A',
                  host: '/10.0.0.12',
                  assignments: [
                    { topic: 'abl.workflow.execution', partitions: [0, 1, 2, 3, 4, 5] },
                  ],
                },
              ],
            },
            'human-task-consumer': { state: 'Empty', members: [] },
          },
        }),
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);
    expect(res.body.dependencies.kafka.ok).toBe(true);
    expect(res.body.pipeline.kafkaTopics['abl.workflow.execution']).toMatchObject({ exists: true });
    expect(res.body.pipeline.consumerGroups['workflow-execution-consumer'].members).toHaveLength(1);
    expect(res.body.pipeline.consumerGroups['human-task-consumer'].members).toHaveLength(0);
  });

  test('ClickHouse probe unreachable ⇒ clickhouse section reports ok=false', async () => {
    const app = createApp(
      buildDeps({
        probeClickHouse: async () => ({
          ok: false,
          latencyMs: 3000,
          detail: 'connect ECONNREFUSED',
        }),
      }),
    );
    const res = await request(app).get('/diagnose').expect(200);
    expect(res.body.dependencies.clickhouse).toEqual({
      ok: false,
      latencyMs: 3000,
      detail: 'connect ECONNREFUSED',
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
      .set('X-Request-Id', 'req-xyz')
      .expect(200);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('diagnose.invoked');
    expect(events[0].fields).toMatchObject({
      userAgent: 'curl/8.4.0',
      requestId: 'req-xyz',
    });
  });
});
