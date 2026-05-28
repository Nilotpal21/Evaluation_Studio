import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  mockWriteAuditLog,
  mockGetAllPlanDefaults,
  mockGetResolvedPolicy,
  mockUpdateTenantOverrides,
  mockClearTenantOverrides,
  mockPreviewTenantUsage,
  mockCreateReplayRun,
  mockListReplayRuns,
  mockGetReplayRun,
  mockCreateMaterialization,
  mockListMaterializations,
  mockGetMaterialization,
  mockGetMaterializationResults,
  mockPlanNextMaterialization,
  mockGetPlatformMaterializationVisibility,
  mockGetMaterializationVisibility,
  mockApplyMaterialization,
  mockGetMaterializationApplication,
  mockGetUsageReport,
  mockGetPlatformUsageReport,
} = vi.hoisted(() => ({
  mockWriteAuditLog: vi.fn(),
  mockGetAllPlanDefaults: vi.fn(),
  mockGetResolvedPolicy: vi.fn(),
  mockUpdateTenantOverrides: vi.fn(),
  mockClearTenantOverrides: vi.fn(),
  mockPreviewTenantUsage: vi.fn(),
  mockCreateReplayRun: vi.fn(),
  mockListReplayRuns: vi.fn(),
  mockGetReplayRun: vi.fn(),
  mockCreateMaterialization: vi.fn(),
  mockListMaterializations: vi.fn(),
  mockGetMaterialization: vi.fn(),
  mockGetMaterializationResults: vi.fn(),
  mockPlanNextMaterialization: vi.fn(),
  mockGetPlatformMaterializationVisibility: vi.fn(),
  mockGetMaterializationVisibility: vi.fn(),
  mockApplyMaterialization: vi.fn(),
  mockGetMaterializationApplication: vi.fn(),
  mockGetUsageReport: vi.fn(),
  mockGetPlatformUsageReport: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  platformAdminAuthMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = {
      userId: 'admin-user-1',
      tenantId: 'admin-tenant',
      isSuperAdmin: true,
      permissions: [],
    };
    next();
  },
}));

vi.mock('@agent-platform/shared-auth', async () => {
  const actual = await vi.importActual('@agent-platform/shared-auth');
  return {
    ...actual,
    requirePlatformAdmin: () => (_req: any, _res: any, next: any) => next(),
    requirePlatformAdminIp: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('@agent-platform/shared-observability', async () => {
  const actual = await vi.importActual('@agent-platform/shared-observability');
  return {
    ...actual,
    getCurrentRequestId: () => 'test-req-id',
  };
});

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({ security: { platformAdminAllowedIps: [] } }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

vi.mock('../services/billing/billing-policy-service.js', () => ({
  BillingPolicyService: class BillingPolicyService {
    getAllPlanDefaults = mockGetAllPlanDefaults;
    getResolvedPolicy = mockGetResolvedPolicy;
    updateTenantOverrides = mockUpdateTenantOverrides;
    clearTenantOverrides = mockClearTenantOverrides;
  },
  BILLING_ADDON_MODE_VALUES: ['off', 'per_call', 'bucketed'],
  BILLING_MATERIALIZATION_BASIS_VALUES: ['time_window', 'completed_sessions'],
  hasBillingUnitPolicyOverrideValues: (value: Record<string, unknown>) =>
    Object.keys(value).length > 0,
}));

vi.mock('../services/billing/billing-usage-preview-service.js', () => ({
  BillingUsagePreviewService: class BillingUsagePreviewService {
    previewTenantUsage = mockPreviewTenantUsage;
  },
}));

vi.mock('../services/billing/billing-usage-report-service.js', () => ({
  BILLING_USAGE_REPORT_GRANULARITY_VALUES: ['hour', 'day', 'week', 'month'],
  BillingUsageReportError: class BillingUsageReportError extends Error {
    code: string;
    details: Record<string, unknown> | undefined;

    constructor(code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  BillingUsageReportService: class BillingUsageReportService {
    getUsageReport = mockGetUsageReport;
    getPlatformUsageReport = mockGetPlatformUsageReport;
  },
}));

vi.mock('../services/billing/billing-usage-replay-service.js', () => ({
  BillingUsageReplayService: class BillingUsageReplayService {
    createReplayRun = mockCreateReplayRun;
    listReplayRuns = mockListReplayRuns;
    getReplayRun = mockGetReplayRun;
  },
}));

vi.mock('../services/billing/billing-usage-materialization-service.js', () => ({
  BillingUsageMaterializationService: class BillingUsageMaterializationService {
    createMaterialization = mockCreateMaterialization;
    listMaterializations = mockListMaterializations;
    getMaterialization = mockGetMaterialization;
    getMaterializationResults = mockGetMaterializationResults;
  },
}));

vi.mock('../services/billing/billing-usage-materialization-planner-service.js', () => ({
  BillingUsageMaterializationPlannerService: class BillingUsageMaterializationPlannerService {
    planNextMaterialization = mockPlanNextMaterialization;
  },
}));

vi.mock('../services/billing/billing-usage-materialization-visibility-service.js', () => ({
  BillingUsageMaterializationVisibilityService: class BillingUsageMaterializationVisibilityService {
    getPlatformVisibility = mockGetPlatformMaterializationVisibility;
    getTenantVisibility = mockGetMaterializationVisibility;
  },
}));

vi.mock('../services/billing/billing-materialization-application-service.js', () => ({
  BillingMaterializationApplicationError: class BillingMaterializationApplicationError extends Error {
    code: string;
    details: Record<string, unknown> | undefined;

    constructor(code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  BillingMaterializationApplicationService: class BillingMaterializationApplicationService {
    applyMaterialization = mockApplyMaterialization;
    getMaterializationApplication = mockGetMaterializationApplication;
  },
}));

import platformAdminBillingPolicyRouter from '../routes/platform-admin-billing-policy.js';
import { BillingMaterializationApplicationError } from '../services/billing/billing-materialization-application-service.js';

const TENANT_ID = 'tenant-abc';

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/billing-policy', platformAdminBillingPolicyRouter);
  return app;
}

function buildResolvedPolicy() {
  return {
    tenantId: TENANT_ID,
    planTier: 'TEAM',
    planDefaults: {
      intervalMinutes: 15,
      excludedChannels: ['web_debug'],
      excludedSessionTypes: [],
      excludeProactiveWithoutUserInteraction: true,
      interactionThreshold: {
        minUserMessages: 1,
        minInteractiveTurns: 1,
        minEngagedSeconds: 0,
      },
      addons: {
        llm: {
          mode: 'per_call',
          bucketSize: null,
        },
        tool: {
          mode: 'per_call',
          bucketSize: null,
        },
      },
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    },
    overrides: {
      intervalMinutes: 30,
    },
    policy: {
      intervalMinutes: 30,
      excludedChannels: ['web_debug'],
      excludedSessionTypes: [],
      excludeProactiveWithoutUserInteraction: true,
      interactionThreshold: {
        minUserMessages: 1,
        minInteractiveTurns: 1,
        minEngagedSeconds: 0,
      },
      addons: {
        llm: {
          mode: 'per_call',
          bucketSize: null,
        },
        tool: {
          mode: 'per_call',
          bucketSize: null,
        },
      },
      materialization: {
        basis: 'time_window',
        timeWindowMinutes: 60,
        completedSessionsCount: null,
      },
    },
  };
}

function buildReplayDetail() {
  return {
    runId: 'replay-run-1',
    tenantId: TENANT_ID,
    projectId: 'project-123',
    status: 'completed',
    mode: 'compare_only',
    triggerSource: 'manual',
    triggeredBy: 'admin-user-1',
    planTier: 'TEAM',
    request: {
      projectId: 'project-123',
      windowStart: '2026-03-30T10:00:00.000Z',
      windowEnd: '2026-03-30T11:00:00.000Z',
      endedBefore: null,
    },
    policy: buildResolvedPolicy().policy,
    scope: {
      basis: 'time_window',
      windowStart: '2026-03-30T10:00:00.000Z',
      windowEnd: '2026-03-30T11:00:00.000Z',
      endedBefore: null,
      completedSessionsCount: null,
      periodLabel: '2026-03-30T10:00:00.000Z/2026-03-30T11:00:00.000Z',
    },
    summary: {
      examinedSessionCount: 2,
      includedSessionCount: 1,
      excludedSessionCount: 1,
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
      exclusionCounts: {
        excluded_channel: 1,
      },
      metricsSourceCounts: {
        clickhouse: 1,
        message_fallback: 1,
      },
    },
    warnings: [],
    resultCount: 2,
    failureReason: null,
    startedAt: '2026-03-30T11:05:00.000Z',
    completedAt: '2026-03-30T11:05:02.000Z',
    createdAt: '2026-03-30T11:05:00.000Z',
    updatedAt: '2026-03-30T11:05:02.000Z',
    page: {
      page: 1,
      limit: 50,
      total: 2,
      hasMore: false,
    },
    sessions: [
      {
        sessionId: 'sess-1',
        projectId: 'project-123',
        channel: 'api',
        status: 'completed',
        disposition: 'completed',
        sessionType: null,
        startedAt: '2026-03-30T10:00:00.000Z',
        endedAt: '2026-03-30T10:20:00.000Z',
        durationSeconds: 1200,
        userMessageCount: 2,
        assistantMessageCount: 2,
        toolMessageCount: 1,
        interactiveTurnCount: 2,
        engagedSeconds: 900,
        llmCallCount: 3,
        toolCallCount: 1,
        metricsSource: 'clickhouse',
        included: true,
        exclusionReasons: [],
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      },
      {
        sessionId: 'sess-2',
        projectId: 'project-123',
        channel: 'web_debug',
        status: 'completed',
        disposition: 'completed',
        sessionType: null,
        startedAt: '2026-03-30T10:25:00.000Z',
        endedAt: '2026-03-30T10:30:00.000Z',
        durationSeconds: 300,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 1,
        engagedSeconds: 120,
        llmCallCount: 1,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        included: false,
        exclusionReasons: ['excluded_channel'],
        baseUnits: 1,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
      },
    ],
  };
}

function buildUsageReport() {
  return {
    tenantId: TENANT_ID,
    projectId: null,
    granularity: 'day' as const,
    range: {
      windowStart: '2026-03-30T00:00:00.000Z',
      windowEnd: '2026-03-31T00:00:00.000Z',
      timeZone: 'UTC' as const,
    },
    totals: {
      examinedSessionCount: 2,
      includedSessionCount: 1,
      excludedSessionCount: 1,
      durationSeconds: 1500,
      userMessageCount: 3,
      assistantMessageCount: 3,
      toolMessageCount: 1,
      interactiveTurnCount: 7,
      engagedSeconds: 1080,
      llmCallCount: 4,
      toolCallCount: 1,
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
    },
    windows: [
      {
        windowStart: '2026-03-30T00:00:00.000Z',
        windowEnd: '2026-03-31T00:00:00.000Z',
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        durationSeconds: 1500,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 1,
        interactiveTurnCount: 7,
        engagedSeconds: 1080,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      },
    ],
    projectBreakdown: [
      {
        projectId: 'project-123',
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        durationSeconds: 1500,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 1,
        interactiveTurnCount: 7,
        engagedSeconds: 1080,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      },
    ],
    channelBreakdown: [
      {
        channel: 'api',
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        durationSeconds: 1500,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 1,
        interactiveTurnCount: 7,
        engagedSeconds: 1080,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
      },
    ],
  };
}

function buildPlatformUsageReport() {
  return {
    tenantId: null,
    projectId: null,
    granularity: 'day' as const,
    range: {
      windowStart: '2026-03-30T00:00:00.000Z',
      windowEnd: '2026-03-31T00:00:00.000Z',
      timeZone: 'UTC' as const,
    },
    totals: {
      examinedSessionCount: 3,
      includedSessionCount: 2,
      excludedSessionCount: 1,
      durationSeconds: 1800,
      userMessageCount: 4,
      assistantMessageCount: 4,
      toolMessageCount: 1,
      interactiveTurnCount: 8,
      engagedSeconds: 1200,
      llmCallCount: 4,
      toolCallCount: 1,
      baseUnits: 3,
      llmAddonUnits: 4,
      toolAddonUnits: 1,
      totalUnits: 8,
    },
    windows: [
      {
        windowStart: '2026-03-30T00:00:00.000Z',
        windowEnd: '2026-03-31T00:00:00.000Z',
        examinedSessionCount: 3,
        includedSessionCount: 2,
        excludedSessionCount: 1,
        durationSeconds: 1800,
        userMessageCount: 4,
        assistantMessageCount: 4,
        toolMessageCount: 1,
        interactiveTurnCount: 8,
        engagedSeconds: 1200,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 3,
        llmAddonUnits: 4,
        toolAddonUnits: 1,
        totalUnits: 8,
      },
    ],
    tenantBreakdown: [
      {
        tenantId: 'tenant-1',
        tenantName: 'Tenant One',
        examinedSessionCount: 2,
        includedSessionCount: 2,
        excludedSessionCount: 0,
        durationSeconds: 1500,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 1,
        interactiveTurnCount: 7,
        engagedSeconds: 1080,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 3,
        llmAddonUnits: 4,
        toolAddonUnits: 1,
        totalUnits: 8,
      },
    ],
    projectBreakdown: [
      {
        projectId: 'project-123',
        examinedSessionCount: 2,
        includedSessionCount: 2,
        excludedSessionCount: 0,
        durationSeconds: 1500,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 1,
        interactiveTurnCount: 7,
        engagedSeconds: 1080,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 3,
        llmAddonUnits: 4,
        toolAddonUnits: 1,
        totalUnits: 8,
      },
    ],
    channelBreakdown: [
      {
        channel: 'api',
        examinedSessionCount: 2,
        includedSessionCount: 2,
        excludedSessionCount: 0,
        durationSeconds: 1500,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 1,
        interactiveTurnCount: 7,
        engagedSeconds: 1080,
        llmCallCount: 4,
        toolCallCount: 1,
        baseUnits: 3,
        llmAddonUnits: 4,
        toolAddonUnits: 1,
        totalUnits: 8,
      },
    ],
  };
}

function buildMaterializationDetail() {
  return {
    batchId: 'materialization-batch-1',
    tenantId: TENANT_ID,
    projectId: 'project-123',
    subscriptionId: 'sub-1',
    status: 'completed',
    triggerSource: 'manual',
    triggeredBy: 'admin-user-1',
    request: {
      projectId: 'project-123',
      windowStart: '2026-03-30T10:00:00.000Z',
      windowEnd: '2026-03-30T11:00:00.000Z',
      endedBefore: null,
    },
    planTier: 'TEAM',
    policy: buildResolvedPolicy().policy,
    scope: {
      basis: 'time_window',
      windowStart: '2026-03-30T10:00:00.000Z',
      windowEnd: '2026-03-30T11:00:00.000Z',
      endedBefore: null,
      completedSessionsCount: null,
      periodLabel: '2026-03-30T10:00:00.000Z/2026-03-30T11:00:00.000Z',
    },
    summary: {
      examinedSessionCount: 2,
      includedSessionCount: 1,
      excludedSessionCount: 1,
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
      exclusionCounts: {
        excluded_channel: 1,
      },
      metricsSourceCounts: {
        clickhouse: 1,
        message_fallback: 1,
      },
    },
    warnings: [],
    resultCount: 2,
    eventId: 'evt-billing-1',
    eventDispatchAttempted: true,
    failureReason: null,
    startedAt: '2026-03-30T11:05:00.000Z',
    completedAt: '2026-03-30T11:05:02.000Z',
    createdAt: '2026-03-30T11:05:00.000Z',
    updatedAt: '2026-03-30T11:05:02.000Z',
  };
}

function buildMaterializationResultsDetail() {
  return {
    batchId: 'materialization-batch-1',
    page: {
      page: 2,
      limit: 1,
      total: 2,
      hasMore: false,
    },
    sessions: [
      {
        sessionId: 'sess-2',
        projectId: 'project-123',
        subscriptionId: 'sub-1',
        batchId: 'materialization-batch-1',
        sequence: 1,
        triggerSource: 'manual',
        materializationBasis: 'time_window',
        channel: 'web_debug',
        status: 'completed',
        disposition: 'completed',
        sessionType: null,
        startedAt: '2026-03-30T10:25:00.000Z',
        endedAt: '2026-03-30T10:30:00.000Z',
        durationSeconds: 300,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 1,
        engagedSeconds: 120,
        llmCallCount: 1,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        included: false,
        exclusionReasons: ['excluded_channel'],
        baseUnits: 1,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
        createdAt: '2026-03-30T11:05:02.000Z',
        updatedAt: '2026-03-30T11:05:02.000Z',
      },
    ],
  };
}

function buildMaterializationPlan() {
  return {
    tenantId: TENANT_ID,
    projectId: 'project-123',
    planTier: 'TEAM',
    policy: buildResolvedPolicy().policy,
    basis: 'completed_sessions',
    due: true,
    reason: 'due',
    checkpoint: {
      basis: 'completed_sessions',
      projectId: 'project-123',
      lastWindowEnd: null,
      lastEndedAt: '2026-03-30T10:00:00.000Z',
      lastSessionId: 'sess-2',
      lastBatchId: 'scheduled-batch-1',
      lastMaterializedAt: '2026-03-30T10:05:00.000Z',
    },
    scope: {
      basis: 'completed_sessions',
      windowStart: null,
      windowEnd: null,
      endedBefore: '2026-03-30T10:30:00.000Z',
      completedSessionsCount: 2,
      periodLabel: 'latest-2-sessions-until-2026-03-30T10:30:00.000Z',
      cursorStartAfterEndedAt: '2026-03-30T10:00:00.000Z',
      cursorStartAfterSessionId: 'sess-2',
      cursorEndEndedAt: '2026-03-30T10:30:00.000Z',
      cursorEndSessionId: 'sess-4',
    },
    stats: {
      candidateSessionCount: 2,
      requiredCompletedSessionsCount: 2,
      remainingCompletedSessionsCount: 0,
    },
  };
}

function buildMaterializationVisibility() {
  return {
    tenantId: TENANT_ID,
    projectId: 'project-123',
    summary: {
      completedBatchCount: 3,
      runningBatchCount: 1,
      failedBatchCount: 1,
      pendingPublicationCount: 2,
      publishedBatchCount: 1,
      supersededBatchCount: 0,
      lastMaterializedAt: '2026-04-02T12:05:00.000Z',
      lastPublishedAt: '2026-04-02T12:08:00.000Z',
    },
    batches: [
      {
        batchId: 'materialization-batch-1',
        projectId: 'project-123',
        triggerSource: 'scheduled',
        materializationStatus: 'completed',
        applicationStatus: 'projected',
        publicationStatus: 'published',
        publicationReason: null,
        resultCount: 2,
        totalUnits: 6,
        eventDispatchAttempted: true,
        startedAt: '2026-04-02T12:00:00.000Z',
        completedAt: '2026-04-02T12:05:00.000Z',
        publishedAt: '2026-04-02T12:08:00.000Z',
        applicationId: 'materialization-application-1',
      },
      {
        batchId: 'materialization-batch-2',
        projectId: 'project-123',
        triggerSource: 'scheduled',
        materializationStatus: 'completed',
        applicationStatus: 'missing',
        publicationStatus: 'pending',
        publicationReason: 'billing_usage_report_application_missing',
        resultCount: 1,
        totalUnits: 2,
        eventDispatchAttempted: true,
        startedAt: '2026-04-02T13:00:00.000Z',
        completedAt: '2026-04-02T13:02:00.000Z',
        publishedAt: null,
        applicationId: null,
      },
    ],
  };
}

function buildPlatformMaterializationVisibility() {
  return {
    summary: {
      completedBatchCount: 5,
      runningBatchCount: 1,
      failedBatchCount: 1,
      pendingPublicationCount: 3,
      publishedBatchCount: 2,
      supersededBatchCount: 0,
      lastMaterializedAt: '2026-04-02T14:05:00.000Z',
      lastPublishedAt: '2026-04-02T14:08:00.000Z',
    },
    tenants: [
      {
        tenantId: TENANT_ID,
        tenantName: 'Tenant Alpha',
        completedBatchCount: 3,
        runningBatchCount: 1,
        failedBatchCount: 0,
        pendingPublicationCount: 2,
        publishedBatchCount: 1,
        supersededBatchCount: 0,
        lastMaterializedAt: '2026-04-02T14:05:00.000Z',
        lastPublishedAt: '2026-04-02T14:08:00.000Z',
      },
      {
        tenantId: 'tenant-def',
        tenantName: 'Tenant Delta',
        completedBatchCount: 2,
        runningBatchCount: 0,
        failedBatchCount: 1,
        pendingPublicationCount: 1,
        publishedBatchCount: 1,
        supersededBatchCount: 0,
        lastMaterializedAt: '2026-04-02T13:05:00.000Z',
        lastPublishedAt: '2026-04-02T13:08:00.000Z',
      },
    ],
  };
}

function buildMaterializationApplicationDetail() {
  return {
    applicationId: 'materialization-application-1',
    tenantId: TENANT_ID,
    batchId: 'materialization-batch-1',
    projectId: 'project-123',
    subscriptionId: 'sub-1',
    status: 'projected',
    triggerSource: 'manual',
    triggeredBy: 'admin-user-1',
    appliedBy: 'admin-user-1',
    materializationBasis: 'time_window',
    materializationScope: {
      basis: 'time_window',
      windowStart: '2026-03-30T10:00:00.000Z',
      windowEnd: '2026-03-30T11:00:00.000Z',
      endedBefore: null,
      completedSessionsCount: null,
      periodLabel: '2026-03-30T10:00:00.000Z/2026-03-30T11:00:00.000Z',
    },
    summarySnapshot: {
      examinedSessionCount: 2,
      includedSessionCount: 1,
      excludedSessionCount: 1,
      baseUnits: 2,
      llmAddonUnits: 3,
      toolAddonUnits: 1,
      totalUnits: 6,
      exclusionCounts: {
        excluded_channel: 1,
      },
      metricsSourceCounts: {
        clickhouse: 1,
        message_fallback: 1,
      },
      projectBreakdown: [
        {
          projectId: 'project-123',
          examinedSessionCount: 2,
          includedSessionCount: 1,
          excludedSessionCount: 1,
          baseUnits: 2,
          llmAddonUnits: 3,
          toolAddonUnits: 1,
          totalUnits: 6,
        },
      ],
      channelBreakdown: [
        {
          channel: 'api',
          examinedSessionCount: 2,
          includedSessionCount: 1,
          excludedSessionCount: 1,
          baseUnits: 2,
          llmAddonUnits: 3,
          toolAddonUnits: 1,
          totalUnits: 6,
        },
      ],
    },
    warnings: [],
    dealResolution: {
      organizationId: 'org-123',
      dealId: 'deal-123',
      dealScope: 'project',
      matchType: 'project_exact',
    },
    accountingPeriod: {
      billingCycle: 'monthly',
      billingStartDate: '2026-03-15T00:00:00.000Z',
      referenceAt: '2026-04-02T11:00:00.000Z',
      periodStart: '2026-03-15T00:00:00.000Z',
      periodEnd: '2026-04-14T23:59:59.999Z',
      periodLabel: '2026-03',
    },
    projection: {
      usageReports: {
        status: 'applied',
        reason: null,
        targetId: 'materialization-batch-1',
        targetIds: [],
        appliedAt: '2026-04-02T12:05:00.000Z',
      },
      creditLedger: {
        status: 'deferred',
        reason: 'billing_unit_credit_mapping_not_configured',
        targetId: null,
        targetIds: [],
        appliedAt: null,
      },
      billingLineItems: {
        status: 'deferred',
        reason: 'billing_unit_price_mapping_not_configured',
        targetId: null,
        targetIds: [],
        appliedAt: null,
      },
    },
    appliedAt: '2026-04-02T12:05:00.000Z',
    createdAt: '2026-04-02T12:05:00.000Z',
    updatedAt: '2026-04-02T12:05:00.000Z',
  };
}

describe('Platform Admin Billing Policy API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockGetAllPlanDefaults.mockReturnValue({
      FREE: buildResolvedPolicy().planDefaults,
      TEAM: buildResolvedPolicy().planDefaults,
      BUSINESS: buildResolvedPolicy().planDefaults,
      ENTERPRISE: buildResolvedPolicy().planDefaults,
    });
    mockGetResolvedPolicy.mockResolvedValue(buildResolvedPolicy());
    mockUpdateTenantOverrides.mockResolvedValue(buildResolvedPolicy());
    mockClearTenantOverrides.mockResolvedValue({
      ...buildResolvedPolicy(),
      overrides: null,
      policy: buildResolvedPolicy().planDefaults,
    });
    mockPreviewTenantUsage.mockResolvedValue({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      planTier: 'TEAM',
      policy: buildResolvedPolicy().policy,
      scope: {
        basis: 'time_window',
        windowStart: '2026-03-30T10:00:00.000Z',
        windowEnd: '2026-03-30T11:00:00.000Z',
        endedBefore: null,
        completedSessionsCount: null,
        periodLabel: '2026-03-30T10:00:00.000Z/2026-03-30T11:00:00.000Z',
      },
      summary: {
        examinedSessionCount: 2,
        includedSessionCount: 1,
        excludedSessionCount: 1,
        baseUnits: 2,
        llmAddonUnits: 3,
        toolAddonUnits: 1,
        totalUnits: 6,
        exclusionCounts: {
          excluded_channel: 1,
        },
        metricsSourceCounts: {
          clickhouse: 1,
          message_fallback: 1,
        },
      },
      sessions: [
        {
          sessionId: 'sess-1',
          projectId: 'project-123',
          channel: 'api',
          status: 'completed',
          disposition: 'completed',
          sessionType: null,
          startedAt: '2026-03-30T10:00:00.000Z',
          endedAt: '2026-03-30T10:20:00.000Z',
          durationSeconds: 1200,
          userMessageCount: 2,
          assistantMessageCount: 2,
          toolMessageCount: 1,
          interactiveTurnCount: 2,
          engagedSeconds: 900,
          llmCallCount: 3,
          toolCallCount: 1,
          metricsSource: 'clickhouse',
          included: true,
          exclusionReasons: [],
          baseUnits: 2,
          llmAddonUnits: 3,
          toolAddonUnits: 1,
          totalUnits: 6,
        },
      ],
      warnings: [],
    });
    mockGetUsageReport.mockResolvedValue(buildUsageReport());
    mockGetPlatformUsageReport.mockResolvedValue(buildPlatformUsageReport());
    mockCreateReplayRun.mockResolvedValue(buildReplayDetail());
    mockListReplayRuns.mockResolvedValue({
      runs: [buildReplayDetail()],
    });
    mockGetReplayRun.mockResolvedValue(buildReplayDetail());
    mockCreateMaterialization.mockResolvedValue(buildMaterializationDetail());
    mockListMaterializations.mockResolvedValue({
      batches: [buildMaterializationDetail()],
    });
    mockGetMaterialization.mockResolvedValue(buildMaterializationDetail());
    mockGetMaterializationResults.mockResolvedValue(buildMaterializationResultsDetail());
    mockPlanNextMaterialization.mockResolvedValue(buildMaterializationPlan());
    mockGetPlatformMaterializationVisibility.mockResolvedValue(
      buildPlatformMaterializationVisibility(),
    );
    mockGetMaterializationVisibility.mockResolvedValue(buildMaterializationVisibility());
    mockApplyMaterialization.mockResolvedValue({
      created: true,
      application: buildMaterializationApplicationDetail(),
    });
    mockGetMaterializationApplication.mockResolvedValue(buildMaterializationApplicationDetail());
  });

  test('GET /plans returns plan defaults', async () => {
    const res = await request(app).get('/api/platform/admin/billing-policy/plans');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.plans.FREE.intervalMinutes).toBe(15);
    expect(mockGetAllPlanDefaults).toHaveBeenCalledTimes(1);
  });

  test('GET /:tenantId returns the resolved tenant policy', async () => {
    const res = await request(app).get(`/api/platform/admin/billing-policy/${TENANT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toBe(TENANT_ID);
    expect(res.body.planTier).toBe('TEAM');
    expect(res.body.policy.intervalMinutes).toBe(30);
    expect(mockGetResolvedPolicy).toHaveBeenCalledWith(TENANT_ID);
  });

  test('GET /:tenantId/preview returns compare-only billing usage derivation', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/preview?projectId=project-123&windowStart=2026-03-30T10:00:00.000Z&windowEnd=2026-03-30T11:00:00.000Z`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.planTier).toBe('TEAM');
    expect(res.body.summary).toMatchObject({
      examinedSessionCount: 2,
      includedSessionCount: 1,
      excludedSessionCount: 1,
      totalUnits: 6,
    });
    expect(mockPreviewTenantUsage).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      windowStart: new Date('2026-03-30T10:00:00.000Z'),
      windowEnd: new Date('2026-03-30T11:00:00.000Z'),
      endedBefore: undefined,
    });
  });

  test('GET /:tenantId/preview rejects invalid datetime query params', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/preview?windowStart=not-a-date`,
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockPreviewTenantUsage).not.toHaveBeenCalled();
  });

  test('GET /reports/usage returns the platform-wide published billing usage report', async () => {
    const res = await request(app).get(
      '/api/platform/admin/billing-policy/reports/usage?granularity=day&windowStart=2026-03-30T00:00:00.000Z&windowEnd=2026-03-31T00:00:00.000Z',
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totals.totalUnits).toBe(8);
    expect(res.body.tenantBreakdown[0].tenantName).toBe('Tenant One');
    expect(mockGetPlatformUsageReport).toHaveBeenCalledWith({
      windowStart: new Date('2026-03-30T00:00:00.000Z'),
      windowEnd: new Date('2026-03-31T00:00:00.000Z'),
      granularity: 'day',
    });
    expect(mockGetUsageReport).not.toHaveBeenCalled();
  });

  test('GET /materializations/publication-status returns platform publication visibility', async () => {
    const res = await request(app).get(
      '/api/platform/admin/billing-policy/materializations/publication-status?limit=10',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      visibility: buildPlatformMaterializationVisibility(),
    });
    expect(mockGetPlatformMaterializationVisibility).toHaveBeenCalledWith({
      limit: 10,
    });
  });

  test('GET /materializations/publication-status rejects invalid query params', async () => {
    const res = await request(app).get(
      '/api/platform/admin/billing-policy/materializations/publication-status?limit=0',
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockGetPlatformMaterializationVisibility).not.toHaveBeenCalled();
  });

  test('GET /:tenantId/reports/usage returns the applied billing usage report', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/reports/usage?projectId=project-123&granularity=day`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totals.totalUnits).toBe(6);
    expect(res.body.channelBreakdown[0].channel).toBe('api');
    expect(mockGetUsageReport).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      windowStart: undefined,
      windowEnd: undefined,
      granularity: 'day',
    });
  });

  test('POST /:tenantId/replays creates a compare-only replay run and writes an audit log', async () => {
    const res = await request(app)
      .post(`/api/platform/admin/billing-policy/${TENANT_ID}/replays`)
      .send({
        projectId: 'project-123',
        windowStart: '2026-03-30T10:00:00.000Z',
        windowEnd: '2026-03-30T11:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.replay.runId).toBe('replay-run-1');
    expect(mockCreateReplayRun).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      windowStart: new Date('2026-03-30T10:00:00.000Z'),
      windowEnd: new Date('2026-03-30T11:00:00.000Z'),
      endedBefore: undefined,
      triggeredBy: 'admin-user-1',
    });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform-admin:create-billing-usage-replay',
        tenantId: TENANT_ID,
      }),
    );
  });

  test('POST /:tenantId/replays rejects invalid replay input', async () => {
    const res = await request(app)
      .post(`/api/platform/admin/billing-policy/${TENANT_ID}/replays`)
      .send({
        windowStart: 'not-a-date',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid request');
    expect(mockCreateReplayRun).not.toHaveBeenCalled();
  });

  test('GET /:tenantId/replays lists persisted replay runs', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/replays?projectId=project-123&limit=5`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.runs).toHaveLength(1);
    expect(mockListReplayRuns).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      limit: 5,
    });
  });

  test('GET /:tenantId/replays/:runId returns replay run detail with paginated sessions', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/replays/replay-run-1?page=2&limit=1`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.replay.runId).toBe('replay-run-1');
    expect(mockGetReplayRun).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runId: 'replay-run-1',
      page: 2,
      limit: 1,
    });
  });

  test('GET /:tenantId/replays/:runId returns 404 when the replay run does not exist', async () => {
    mockGetReplayRun.mockResolvedValueOnce(null);

    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/replays/missing-run`,
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Billing replay run not found');
  });

  test('POST /:tenantId/materializations creates a billing materialization batch and writes an audit log', async () => {
    const res = await request(app)
      .post(`/api/platform/admin/billing-policy/${TENANT_ID}/materializations`)
      .send({
        projectId: 'project-123',
        windowStart: '2026-03-30T10:00:00.000Z',
        windowEnd: '2026-03-30T11:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.materialization.batchId).toBe('materialization-batch-1');
    expect(mockCreateMaterialization).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      windowStart: new Date('2026-03-30T10:00:00.000Z'),
      windowEnd: new Date('2026-03-30T11:00:00.000Z'),
      endedBefore: undefined,
      triggeredBy: 'admin-user-1',
    });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform-admin:create-billing-usage-materialization',
        tenantId: TENANT_ID,
      }),
    );
  });

  test('POST /:tenantId/materializations rejects invalid materialization input', async () => {
    const res = await request(app)
      .post(`/api/platform/admin/billing-policy/${TENANT_ID}/materializations`)
      .send({
        windowEnd: 'not-a-date',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid request');
    expect(mockCreateMaterialization).not.toHaveBeenCalled();
  });

  test('GET /:tenantId/materializations lists persisted materialization batches', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations?projectId=project-123&limit=5`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.materializations).toHaveLength(1);
    expect(mockListMaterializations).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      limit: 5,
    });
  });

  test('GET /:tenantId/materializations/due returns the next scheduler-safe materialization plan', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/due?projectId=project-123`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.plan.reason).toBe('due');
    expect(res.body.plan.scope.cursorEndSessionId).toBe('sess-4');
    expect(mockPlanNextMaterialization).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
    });
  });

  test('GET /:tenantId/materializations/due rejects invalid query params', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/due?projectId=`,
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockPlanNextMaterialization).not.toHaveBeenCalled();
  });

  test('GET /:tenantId/materializations/due returns 404 when there is no active subscription policy', async () => {
    mockPlanNextMaterialization.mockResolvedValueOnce(null);

    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/due`,
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('No active subscription found for tenant');
  });

  test('GET /:tenantId/materializations/publication-status returns tenant publication visibility', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/publication-status?projectId=project-123&limit=8`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      visibility: buildMaterializationVisibility(),
    });
    expect(mockGetMaterializationVisibility).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: 'project-123',
      limit: 8,
    });
  });

  test('GET /:tenantId/materializations/publication-status rejects invalid query params', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/publication-status?limit=0`,
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockGetMaterializationVisibility).not.toHaveBeenCalled();
  });

  test('GET /:tenantId/materializations/:batchId returns materialization batch detail', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/materialization-batch-1`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.materialization.batchId).toBe('materialization-batch-1');
    expect(mockGetMaterialization).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      batchId: 'materialization-batch-1',
    });
  });

  test('GET /:tenantId/materializations/:batchId returns 404 when batch is missing', async () => {
    mockGetMaterialization.mockResolvedValueOnce(null);

    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/missing-batch`,
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Billing materialization batch not found');
  });

  test('GET /:tenantId/materializations/:batchId/results returns paginated per-session results', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/materialization-batch-1/results?page=2&limit=1`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.results.batchId).toBe('materialization-batch-1');
    expect(res.body.results.sessions).toHaveLength(1);
    expect(mockGetMaterializationResults).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      batchId: 'materialization-batch-1',
      page: 2,
      limit: 1,
    });
  });

  test('GET /:tenantId/materializations/:batchId/results returns 404 when batch is missing', async () => {
    mockGetMaterializationResults.mockResolvedValueOnce(null);

    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/missing-batch/results`,
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Billing materialization batch not found');
  });

  test('POST /:tenantId/materializations/:batchId/apply records an application and writes an audit log', async () => {
    const res = await request(app).post(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/materialization-batch-1/apply`,
    );

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.application).toMatchObject({
      applicationId: 'materialization-application-1',
      batchId: 'materialization-batch-1',
      dealResolution: {
        dealId: 'deal-123',
        matchType: 'project_exact',
      },
      accountingPeriod: {
        periodLabel: '2026-03',
      },
    });
    expect(mockApplyMaterialization).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      batchId: 'materialization-batch-1',
      appliedBy: 'admin-user-1',
    });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform-admin:apply-billing-usage-materialization',
        tenantId: TENANT_ID,
        metadata: expect.objectContaining({
          batchId: 'materialization-batch-1',
          applicationId: 'materialization-application-1',
          created: true,
          dealId: 'deal-123',
        }),
      }),
    );
  });

  test('POST /:tenantId/materializations/:batchId/apply returns 200 for idempotent re-apply', async () => {
    mockApplyMaterialization.mockResolvedValueOnce({
      created: false,
      application: buildMaterializationApplicationDetail(),
    });

    const res = await request(app).post(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/materialization-batch-1/apply`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.application.applicationId).toBe('materialization-application-1');
  });

  test('POST /:tenantId/materializations/:batchId/apply returns 404 when the batch is missing', async () => {
    mockApplyMaterialization.mockResolvedValueOnce(null);

    const res = await request(app).post(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/missing-batch/apply`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: 'Billing materialization batch not found',
    });
  });

  test('POST /:tenantId/materializations/:batchId/apply maps billing control-plane errors', async () => {
    mockApplyMaterialization.mockRejectedValueOnce(
      new BillingMaterializationApplicationError(
        'NO_ACTIVE_DEAL',
        'No active deal matches this billing materialization batch',
        { organizationId: 'org-123', projectId: 'project-123' },
      ),
    );

    const res = await request(app).post(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/materialization-batch-1/apply`,
    );

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      success: false,
      error: 'No active deal matches this billing materialization batch',
      code: 'NO_ACTIVE_DEAL',
      details: { organizationId: 'org-123', projectId: 'project-123' },
    });
  });

  test('GET /:tenantId/materializations/:batchId/application returns application detail', async () => {
    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/materialization-batch-1/application`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.application).toMatchObject({
      applicationId: 'materialization-application-1',
      batchId: 'materialization-batch-1',
      projection: {
        creditLedger: {
          status: 'deferred',
        },
      },
    });
    expect(mockGetMaterializationApplication).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      batchId: 'materialization-batch-1',
    });
  });

  test('GET /:tenantId/materializations/:batchId/application returns 404 when the application is missing', async () => {
    mockGetMaterializationApplication.mockResolvedValueOnce(null);

    const res = await request(app).get(
      `/api/platform/admin/billing-policy/${TENANT_ID}/materializations/missing-batch/application`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: 'Billing materialization application not found',
    });
  });

  test('GET /:tenantId returns 404 when no active subscription exists', async () => {
    mockGetResolvedPolicy.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/platform/admin/billing-policy/missing');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('No active subscription');
  });

  test('PUT /:tenantId rejects empty override payloads', async () => {
    const res = await request(app).put(`/api/platform/admin/billing-policy/${TENANT_ID}`).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('No overrides provided');
    expect(mockUpdateTenantOverrides).not.toHaveBeenCalled();
  });

  test('PUT /:tenantId updates overrides and writes an audit log', async () => {
    const res = await request(app)
      .put(`/api/platform/admin/billing-policy/${TENANT_ID}`)
      .send({
        intervalMinutes: 30,
        materialization: {
          basis: 'completed_sessions',
          completedSessionsCount: 25,
          timeWindowMinutes: null,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpdateTenantOverrides).toHaveBeenCalledWith(TENANT_ID, {
      intervalMinutes: 30,
      materialization: {
        basis: 'completed_sessions',
        completedSessionsCount: 25,
        timeWindowMinutes: null,
      },
    });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform-admin:update-billing-unit-policy',
        tenantId: TENANT_ID,
      }),
    );
  });

  test('DELETE /:tenantId clears overrides and writes an audit log', async () => {
    const res = await request(app).delete(`/api/platform/admin/billing-policy/${TENANT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.overrides).toBeNull();
    expect(mockClearTenantOverrides).toHaveBeenCalledWith(TENANT_ID);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform-admin:clear-billing-unit-policy',
        tenantId: TENANT_ID,
      }),
    );
  });
});
