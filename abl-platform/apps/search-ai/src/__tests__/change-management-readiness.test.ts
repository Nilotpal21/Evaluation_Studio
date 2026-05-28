import express from 'express';
import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import { createSearchAiReadinessHandler } from '../change-management/readiness.js';
import type { ServiceChangeCompatibilityResult } from '@agent-platform/database';

function createCompatibilityResult(
  overrides: Partial<ServiceChangeCompatibilityResult> = {},
): ServiceChangeCompatibilityResult {
  return {
    service: 'search-ai',
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
  overrides: Partial<Parameters<typeof createSearchAiReadinessHandler>[0]> = {},
) {
  const app = express();
  const onHardFail = vi.fn();

  app.get(
    '/health/ready',
    createSearchAiReadinessHandler({
      isShuttingDown: () => false,
      isDatabaseReady: () => true,
      loadCompatibility: async () => compatibility,
      onHardFail,
      ...overrides,
    }),
  );

  return { app, onHardFail };
}

describe('createSearchAiReadinessHandler', () => {
  test('returns not_ready when required search-ai changes are missing', async () => {
    const { app } = createApp(
      createCompatibilityResult({
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
      }),
    );

    const response = await request(app).get('/health/ready').expect(503);

    expect(response.body).toMatchObject({
      ok: false,
      reason: 'change_incompatible',
      changeManagement: {
        blockers: [
          {
            changeId: 'seed.platform-core',
            reason: 'missing',
          },
        ],
      },
    });
  });

  test('returns ok while surfacing warn_only change-management warnings', async () => {
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
      ok: true,
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
});
