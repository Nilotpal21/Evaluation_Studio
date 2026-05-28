import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BillingUsagePublishedSession, Tenant } from '@agent-platform/database/models';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';
import {
  BillingUsageReportError,
  BillingUsageReportService,
} from '../services/billing/billing-usage-report-service.js';

function publishedSession(params: {
  sessionId: string;
  tenantId: string;
  projectId: string;
  channel: string;
  endedAt: string;
  included: boolean;
  durationSeconds: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  interactiveTurnCount: number;
  engagedSeconds: number;
  llmCallCount: number;
  toolCallCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}) {
  const endedAt = new Date(params.endedAt);
  return {
    tenantId: params.tenantId,
    projectId: params.projectId,
    subscriptionId: 'sub-1',
    sessionId: params.sessionId,
    batchId: `batch-${params.sessionId}`,
    applicationId: `app-${params.sessionId}`,
    batchCreatedAt: new Date('2026-04-03T11:59:00.000Z'),
    triggerSource: 'manual' as const,
    materializationBasis: 'time_window' as const,
    channel: params.channel,
    status: 'completed',
    disposition: 'completed',
    sessionType: null,
    startedAt: new Date(endedAt.getTime() - params.durationSeconds * 1000),
    endedAt,
    publishedAt: new Date('2026-04-03T12:00:00.000Z'),
    durationSeconds: params.durationSeconds,
    userMessageCount: params.userMessageCount,
    assistantMessageCount: params.assistantMessageCount,
    toolMessageCount: params.toolMessageCount,
    interactiveTurnCount: params.interactiveTurnCount,
    engagedSeconds: params.engagedSeconds,
    llmCallCount: params.llmCallCount,
    toolCallCount: params.toolCallCount,
    metricsSource: 'message_fallback' as const,
    included: params.included,
    exclusionReasons: params.included ? [] : ['excluded_channel'],
    baseUnits: params.baseUnits,
    llmAddonUnits: params.llmAddonUnits,
    toolAddonUnits: params.toolAddonUnits,
    totalUnits: params.totalUnits,
  };
}

describe('BillingUsageReportService', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.VITEST = 'true';
    await setupTestMongo();
  }, 60_000);

  afterEach(async () => {
    await clearCollections();
  });

  afterAll(async () => {
    await teardownTestMongo();
  }, 60_000);

  it('aggregates published usage sessions into time windows with project and channel breakdowns', async () => {
    await BillingUsagePublishedSession.insertMany([
      publishedSession({
        sessionId: 'sess-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channel: 'api',
        endedAt: '2026-04-03T10:20:00.000Z',
        included: true,
        durationSeconds: 1200,
        userMessageCount: 2,
        assistantMessageCount: 2,
        toolMessageCount: 1,
        interactiveTurnCount: 5,
        engagedSeconds: 900,
        llmCallCount: 3,
        toolCallCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      }),
      publishedSession({
        sessionId: 'sess-2',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channel: 'api',
        endedAt: '2026-04-03T11:10:00.000Z',
        included: true,
        durationSeconds: 600,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 2,
        engagedSeconds: 300,
        llmCallCount: 1,
        toolCallCount: 0,
        baseUnits: 1,
        llmAddonUnits: 1,
        toolAddonUnits: 0,
        totalUnits: 2,
      }),
      publishedSession({
        sessionId: 'sess-3',
        tenantId: 'tenant-1',
        projectId: 'project-2',
        channel: 'voice',
        endedAt: '2026-04-03T11:45:00.000Z',
        included: false,
        durationSeconds: 300,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 2,
        engagedSeconds: 180,
        llmCallCount: 0,
        toolCallCount: 0,
        baseUnits: 0,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
      }),
    ]);

    const service = new BillingUsageReportService();
    const report = await service.getUsageReport({
      tenantId: 'tenant-1',
      windowStart: new Date('2026-04-03T10:00:00.000Z'),
      windowEnd: new Date('2026-04-03T12:00:00.000Z'),
      granularity: 'hour',
    });

    expect(report).toMatchObject({
      tenantId: 'tenant-1',
      projectId: null,
      granularity: 'hour',
      totals: {
        examinedSessionCount: 3,
        includedSessionCount: 2,
        excludedSessionCount: 1,
        durationSeconds: 2100,
        userMessageCount: 4,
        assistantMessageCount: 4,
        toolMessageCount: 1,
        interactiveTurnCount: 9,
        engagedSeconds: 1380,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 3,
        llmAddonUnits: 4,
        toolAddonUnits: 1,
        totalUnits: 8,
      },
      projectBreakdown: [
        {
          projectId: 'project-1',
          examinedSessionCount: 2,
          includedSessionCount: 2,
          excludedSessionCount: 0,
          totalUnits: 8,
        },
        {
          projectId: 'project-2',
          examinedSessionCount: 1,
          includedSessionCount: 0,
          excludedSessionCount: 1,
          totalUnits: 0,
        },
      ],
      channelBreakdown: [
        {
          channel: 'api',
          examinedSessionCount: 2,
          includedSessionCount: 2,
          excludedSessionCount: 0,
          totalUnits: 8,
        },
        {
          channel: 'voice',
          examinedSessionCount: 1,
          includedSessionCount: 0,
          excludedSessionCount: 1,
          totalUnits: 0,
        },
      ],
    });

    expect(report.windows).toHaveLength(2);
    expect(report.windows[0]).toMatchObject({
      windowStart: '2026-04-03T10:00:00.000Z',
      windowEnd: '2026-04-03T11:00:00.000Z',
      examinedSessionCount: 1,
      includedSessionCount: 1,
      excludedSessionCount: 0,
      totalUnits: 6,
    });
    expect(report.windows[1]).toMatchObject({
      windowStart: '2026-04-03T11:00:00.000Z',
      windowEnd: '2026-04-03T12:00:00.000Z',
      examinedSessionCount: 2,
      includedSessionCount: 1,
      excludedSessionCount: 1,
      totalUnits: 2,
    });
  });

  it('filters reports by projectId without leaking cross-project usage', async () => {
    await BillingUsagePublishedSession.insertMany([
      publishedSession({
        sessionId: 'sess-1',
        tenantId: 'tenant-2',
        projectId: 'project-1',
        channel: 'api',
        endedAt: '2026-04-03T10:20:00.000Z',
        included: true,
        durationSeconds: 1200,
        userMessageCount: 2,
        assistantMessageCount: 2,
        toolMessageCount: 1,
        interactiveTurnCount: 5,
        engagedSeconds: 900,
        llmCallCount: 3,
        toolCallCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      }),
      publishedSession({
        sessionId: 'sess-2',
        tenantId: 'tenant-2',
        projectId: 'project-2',
        channel: 'voice',
        endedAt: '2026-04-03T10:25:00.000Z',
        included: true,
        durationSeconds: 300,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 2,
        engagedSeconds: 180,
        llmCallCount: 1,
        toolCallCount: 0,
        baseUnits: 1,
        llmAddonUnits: 1,
        toolAddonUnits: 0,
        totalUnits: 2,
      }),
    ]);

    const service = new BillingUsageReportService();
    const report = await service.getUsageReport({
      tenantId: 'tenant-2',
      projectId: 'project-1',
      windowStart: new Date('2026-04-03T10:00:00.000Z'),
      windowEnd: new Date('2026-04-03T11:00:00.000Z'),
      granularity: 'hour',
    });

    expect(report.projectId).toBe('project-1');
    expect(report.totals).toMatchObject({
      examinedSessionCount: 1,
      includedSessionCount: 1,
      excludedSessionCount: 0,
      totalUnits: 6,
    });
    expect(report.projectBreakdown).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        totalUnits: 6,
      }),
    ]);
    expect(report.channelBreakdown).toEqual([
      expect.objectContaining({
        channel: 'api',
        totalUnits: 6,
      }),
    ]);
  });

  it('aggregates platform-wide published usage sessions into tenant, project, and channel breakdowns', async () => {
    await Tenant.create([
      {
        _id: 'tenant-alpha',
        name: 'Tenant Alpha',
        slug: 'tenant-alpha',
        ownerId: 'owner-alpha',
        status: 'active',
      },
      {
        _id: 'tenant-beta',
        name: 'Tenant Beta',
        slug: 'tenant-beta',
        ownerId: 'owner-beta',
        status: 'active',
      },
    ]);

    await BillingUsagePublishedSession.insertMany([
      publishedSession({
        sessionId: 'platform-sess-1',
        tenantId: 'tenant-alpha',
        projectId: 'project-a',
        channel: 'api',
        endedAt: '2026-04-04T09:10:00.000Z',
        included: true,
        durationSeconds: 900,
        userMessageCount: 2,
        assistantMessageCount: 2,
        toolMessageCount: 1,
        interactiveTurnCount: 4,
        engagedSeconds: 720,
        llmCallCount: 2,
        toolCallCount: 1,
        baseUnits: 1,
        llmAddonUnits: 2,
        toolAddonUnits: 1,
        totalUnits: 4,
      }),
      publishedSession({
        sessionId: 'platform-sess-2',
        tenantId: 'tenant-beta',
        projectId: 'project-b',
        channel: 'voice',
        endedAt: '2026-04-04T10:15:00.000Z',
        included: false,
        durationSeconds: 300,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 1,
        engagedSeconds: 120,
        llmCallCount: 0,
        toolCallCount: 0,
        baseUnits: 0,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
      }),
    ]);

    const service = new BillingUsageReportService();
    const report = await service.getPlatformUsageReport({
      windowStart: new Date('2026-04-04T09:00:00.000Z'),
      windowEnd: new Date('2026-04-04T11:00:00.000Z'),
      granularity: 'hour',
    });

    expect(report).toMatchObject({
      tenantId: null,
      projectId: null,
      totals: {
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        totalUnits: 4,
      },
      tenantBreakdown: [
        {
          tenantId: 'tenant-alpha',
          tenantName: 'Tenant Alpha',
          examinedSessionCount: 1,
          includedSessionCount: 1,
          excludedSessionCount: 0,
          totalUnits: 4,
        },
        {
          tenantId: 'tenant-beta',
          tenantName: 'Tenant Beta',
          examinedSessionCount: 1,
          includedSessionCount: 0,
          excludedSessionCount: 1,
          totalUnits: 0,
        },
      ],
      projectBreakdown: [
        {
          projectId: 'project-a',
          totalUnits: 4,
        },
        {
          projectId: 'project-b',
          totalUnits: 0,
        },
      ],
      channelBreakdown: [
        {
          channel: 'api',
          totalUnits: 4,
        },
        {
          channel: 'voice',
          totalUnits: 0,
        },
      ],
    });

    expect(report.windows).toHaveLength(2);
    expect(report.windows[0]).toMatchObject({
      windowStart: '2026-04-04T09:00:00.000Z',
      windowEnd: '2026-04-04T10:00:00.000Z',
      examinedSessionCount: 1,
      totalUnits: 4,
    });
    expect(report.windows[1]).toMatchObject({
      windowStart: '2026-04-04T10:00:00.000Z',
      windowEnd: '2026-04-04T11:00:00.000Z',
      examinedSessionCount: 1,
      totalUnits: 0,
    });
  });

  it('rejects oversized hourly report ranges', async () => {
    const service = new BillingUsageReportService();

    await expect(
      service.getUsageReport({
        tenantId: 'tenant-3',
        windowStart: new Date('2026-01-01T00:00:00.000Z'),
        windowEnd: new Date('2026-03-15T00:00:00.000Z'),
        granularity: 'hour',
      }),
    ).rejects.toMatchObject({
      code: 'WINDOW_TOO_LARGE',
    } satisfies Partial<BillingUsageReportError>);
  });
});
