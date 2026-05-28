import express from 'express';
import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import { createRuntimeReadinessHandler } from '../change-management/readiness.js';
import type { ServiceChangeCompatibilityResult } from '@agent-platform/database';

function createCompatibilityResult(
  overrides: Partial<ServiceChangeCompatibilityResult> = {},
): ServiceChangeCompatibilityResult {
  return {
    service: 'runtime',
    environment: 'staging',
    enforcementMode: 'soft_ready',
    outcome: 'ready',
    ready: true,
    shouldExit: false,
    checkedAt: new Date(),
    checkedChangeIds: ['seed.platform-core'],
    blockingIssues: [],
    warningIssues: [],
    ...overrides,
  };
}

function createApp(
  compatibility: ServiceChangeCompatibilityResult | null,
  overrides: Partial<Parameters<typeof createRuntimeReadinessHandler>[0]> = {},
) {
  const app = express();
  const onHardFail = vi.fn();

  app.get(
    '/health/ready',
    createRuntimeReadinessHandler({
      isShuttingDown: () => false,
      getHeapUsedMb: () => 128,
      getHeapLimitMb: () => 1536,
      isMongoReady: async () => true,
      pingRedis: async () => undefined,
      loadCompatibility: async () => compatibility,
      onHardFail,
      ...overrides,
    }),
  );

  return { app, onHardFail };
}

describe('createRuntimeReadinessHandler', () => {
  test('returns not_ready when required change blockers exist', async () => {
    const compatibility = createCompatibilityResult({
      ready: false,
      outcome: 'not_ready',
      blockingIssues: [
        {
          changeId: 'seed.platform-core',
          severity: 'blocking',
          status: 'missing',
          reason: 'missing',
          message: 'seed.platform-core is missing from change history.',
        },
      ],
    });
    const { app, onHardFail } = createApp(compatibility);

    const response = await request(app).get('/health/ready').expect(503);

    expect(response.body).toMatchObject({
      status: 'not_ready',
      reason: 'change_incompatible',
      changeManagement: {
        enforcementMode: 'soft_ready',
        blockers: [
          {
            changeId: 'seed.platform-core',
            reason: 'missing',
          },
        ],
      },
    });
    expect(onHardFail).not.toHaveBeenCalled();
  });

  test('returns ready while surfacing warn_only compatibility warnings', async () => {
    const { app } = createApp(
      createCompatibilityResult({
        enforcementMode: 'warn_only',
        outcome: 'warn_only',
        warningIssues: [
          {
            changeId: 'clickhouse.006-json-path-index',
            severity: 'warning',
            status: 'missing',
            reason: 'missing',
            message: 'clickhouse.006-json-path-index is missing from change history.',
          },
        ],
      }),
    );

    const response = await request(app).get('/health/ready').expect(200);

    expect(response.body).toMatchObject({
      status: 'ready',
      changeManagement: {
        outcome: 'warn_only',
        warnings: [
          {
            changeId: 'clickhouse.006-json-path-index',
            reason: 'missing',
          },
        ],
      },
    });
  });

  test('invokes hard-fail handling when compatibility requires it', async () => {
    const compatibility = createCompatibilityResult({
      enforcementMode: 'hard_fail',
      ready: false,
      shouldExit: true,
      outcome: 'not_ready',
      blockingIssues: [
        {
          changeId: 'seed.rbac-tool-permissions',
          severity: 'blocking',
          status: 'missing',
          reason: 'missing',
          message: 'seed.rbac-tool-permissions is missing from change history.',
        },
      ],
    });
    const { app, onHardFail } = createApp(compatibility);

    await request(app).get('/health/ready').expect(503);

    expect(onHardFail).toHaveBeenCalledWith(compatibility);
  });

  // ─── Workflow event-sourcing pipeline gates (ABLP-2) ────────────────────
  test('workflow-sink gates are skipped when the hooks are not provided', async () => {
    // Default createApp() omits the new hooks — readiness must stay ready,
    // preserving the default-off posture for environments with the sink off.
    const { app } = createApp(createCompatibilityResult());
    const response = await request(app).get('/health/ready').expect(200);
    expect(response.body).toMatchObject({ status: 'ready' });
  });

  test('workflow consumer unhealthy ⇒ 503 workflow_consumer_not_healthy', async () => {
    const { app } = createApp(createCompatibilityResult(), {
      isWorkflowConsumerHealthy: () => false,
    });
    const response = await request(app).get('/health/ready').expect(503);
    expect(response.body).toMatchObject({
      status: 'not_ready',
      reason: 'workflow_consumer_not_healthy',
    });
  });

  test('workflow consumer hook throwing ⇒ 503 (fail closed)', async () => {
    const { app } = createApp(createCompatibilityResult(), {
      isWorkflowConsumerHealthy: () => {
        throw new Error('boom');
      },
    });
    const response = await request(app).get('/health/ready').expect(503);
    expect(response.body).toMatchObject({
      reason: 'workflow_consumer_not_healthy',
    });
  });

  test('workflow ClickHouse unhealthy ⇒ 503 workflow_clickhouse_not_healthy', async () => {
    const { app } = createApp(createCompatibilityResult(), {
      isWorkflowConsumerHealthy: () => true,
      isWorkflowClickHouseHealthy: async () => false,
    });
    const response = await request(app).get('/health/ready').expect(503);
    expect(response.body).toMatchObject({
      status: 'not_ready',
      reason: 'workflow_clickhouse_not_healthy',
    });
  });

  test('both workflow gates healthy ⇒ 200 ready', async () => {
    const { app } = createApp(createCompatibilityResult(), {
      isWorkflowConsumerHealthy: () => true,
      isWorkflowClickHouseHealthy: () => true,
    });
    const response = await request(app).get('/health/ready').expect(200);
    expect(response.body).toMatchObject({ status: 'ready' });
  });
});
