import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  mockEmit,
  mockWarn,
  mockError,
  mockGetEventStore,
  mockGetCurrentTraceId,
  mockFlush,
  mockGetSharedSTRBuffer,
  mockGetSTRWriter,
  mockAddTraceEvent,
  mockGetTraceStore,
  mockGetRuntimeExecutor,
  mockListSessions,
  mockCountSessions,
  mockFindSessionById,
  mockFindSessionByRuntimeId,
  mockFindMessagesForSession,
  mockFindStoredSessionByAnyId,
  mockListStoredSessionCleanupIds,
  mockResolveStoredSessionCompatibilityId,
  mockUpdateSession,
  mockFindProjectAgentByPath,
  mockFindProjectAgentByName,
  mockBuildAgentDetails,
  mockIsDatabaseAvailable,
  mockClickHouseQuery,
  mockGetClickHouseClient,
} = vi.hoisted(() => {
  const mockEmit = vi.fn();
  const mockWarn = vi.fn();
  const mockError = vi.fn();
  const mockFlush = vi.fn(() => []);
  const mockAddTraceEvent = vi.fn();

  return {
    mockEmit,
    mockWarn,
    mockError,
    mockGetEventStore: vi.fn(() => ({ emitter: { emit: mockEmit } })),
    mockGetCurrentTraceId: vi.fn(() => undefined as string | undefined),
    mockFlush,
    mockGetSharedSTRBuffer: vi.fn(() => ({
      flush: mockFlush,
      reportFlushSuccess: vi.fn(),
      reportFlushFailure: vi.fn(),
    })),
    mockGetSTRWriter: vi.fn(() => null),
    mockAddTraceEvent,
    mockGetTraceStore: vi.fn(() => ({
      addEvent: mockAddTraceEvent,
      getTrace: () => null,
      getEvents: () => [],
      getSessionInfo: () => null,
      removeSession: vi.fn(),
      clearSession: vi.fn(),
    })),
    mockGetRuntimeExecutor: vi.fn(),
    mockListSessions: vi.fn(),
    mockCountSessions: vi.fn(),
    mockFindSessionById: vi.fn(),
    mockFindSessionByRuntimeId: vi.fn(),
    mockFindMessagesForSession: vi.fn(),
    mockFindStoredSessionByAnyId: vi.fn(),
    mockListStoredSessionCleanupIds: vi.fn(),
    mockResolveStoredSessionCompatibilityId: vi.fn(
      (session: Record<string, unknown>, fallbackId: string) =>
        (typeof session.id === 'string' && session.id) ||
        (typeof session._id === 'string' && session._id) ||
        (typeof session.runtimeSessionId === 'string' && session.runtimeSessionId) ||
        fallbackId,
    ),
    mockUpdateSession: vi.fn(),
    mockFindProjectAgentByPath: vi.fn(),
    mockFindProjectAgentByName: vi.fn(),
    mockBuildAgentDetails: vi.fn(),
    mockIsDatabaseAvailable: vi.fn(),
    mockClickHouseQuery: vi.fn(),
    mockGetClickHouseClient: vi.fn(),
  };
});

vi.mock('../services/eventstore-singleton.js', () => ({
  getEventStore: mockGetEventStore,
}));

vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: mockGetCurrentTraceId,
}));

vi.mock('@agent-platform/shared-observability/sti', () => ({
  getSharedSTRBuffer: mockGetSharedSTRBuffer,
}));

vi.mock('../services/tracing/str-writer-singleton.js', () => ({
  getSTRWriter: mockGetSTRWriter,
}));

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: mockGetTraceStore,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: mockError,
    debug: vi.fn(),
  }),
}));

vi.mock('../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: unknown[]) => mockGetRuntimeExecutor(...args),
}));

vi.mock('../repos/session-repo.js', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  countSessions: (...args: unknown[]) => mockCountSessions(...args),
  findSessionById: (...args: unknown[]) => mockFindSessionById(...args),
  findSessionByRuntimeId: (...args: unknown[]) => mockFindSessionByRuntimeId(...args),
  findStoredSessionByAnyId: (...args: unknown[]) => mockFindStoredSessionByAnyId(...args),
  findMessagesForSession: (...args: unknown[]) => mockFindMessagesForSession(...args),
  listStoredSessionCleanupIds: (...args: unknown[]) => mockListStoredSessionCleanupIds(...args),
  resolveStoredSessionCompatibilityId: (...args: unknown[]) =>
    mockResolveStoredSessionCompatibilityId(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}));

vi.mock('../repos/project-repo.js', () => ({
  findProjectAgentByPath: (...args: unknown[]) => mockFindProjectAgentByPath(...args),
  findProjectAgentByName: (...args: unknown[]) => mockFindProjectAgentByName(...args),
  findProjectAgentForProject: vi.fn().mockResolvedValue(null),
  findProjectByIdAndTenant: vi
    .fn()
    .mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-1', ownerId: 'user-1' }),
  findProjectMember: vi.fn().mockResolvedValue({ role: 'admin' }),
}));

vi.mock('../services/dsl-utils.js', () => ({
  buildAgentDetails: (...args: unknown[]) => mockBuildAgentDetails(...args),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireProjectPermission: vi.fn().mockResolvedValue(true),
  requireSensitiveProjectPermission: vi.fn().mockResolvedValue(true),
  requireWriteAccess: vi.fn().mockResolvedValue(true),
  requirePermissionInline: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    createRequireSessionOwnership: vi.fn(
      () => (_req: unknown, _res: unknown, next: () => void) => next(),
    ),
    buildSessionListFilter: vi.fn((_authContext: unknown, projectId: string) => ({ projectId })),
    toAuthContext: vi.fn((tenantContext: unknown) => tenantContext),
  };
});

vi.mock('../attachments/multimodal-service-client.js', () => ({
  MultimodalServiceClient: vi.fn().mockImplementation(() => ({
    deleteBySession: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: (...args: unknown[]) => mockIsDatabaseAvailable(...args),
  isDatabaseReady: (...args: unknown[]) => mockIsDatabaseAvailable(...args),
  requirePrisma: vi.fn(),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  canStartSession: vi.fn().mockResolvedValue(true),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
  claimSessionSlot: vi.fn().mockResolvedValue(1),
  releaseSessionSlot: vi.fn().mockResolvedValue(0),
  incrementSessionCount: vi.fn().mockResolvedValue(1),
  decrementSessionCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditSessionModified: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tenant-config.js', () => ({
  PLAN_LIMITS: { TEAM: { messageRetentionDays: 90 } },
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
    getProjectConfig: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
  }),
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

vi.mock('@agent-platform/database/cascade', () => ({
  deleteSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/auth-profile/paused-execution-store.js', () => ({
  getPausedExecutionStore: () => ({
    cleanupSession: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
  parseClickHouseTimestamp: (value: string | Date) => new Date(value),
}));

vi.mock('@agent-platform/database/clickhouse.js', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
  parseClickHouseTimestamp: (value: string | Date) => new Date(value),
}));

vi.mock('lucide-react', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const stub = () => null;
  return new Proxy(actual, {
    get: (target, prop) => (prop in target ? target[prop as string] : stub),
  });
});

import { processSlackFileReferences } from '../channels/adapters/slack-file-processor.js';
import { emitChannelResponseSent } from '../services/channel-trace-utils.js';
import { normalizeEventType } from '../../../studio/src/lib/event-types.js';

let baseUrl: string;
let server: http.Server;

const DEFAULT_TENANT_CONTEXT = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  permissions: ['*:*'],
  authType: 'user' as const,
  role: 'ADMIN',
  isSuperAdmin: false,
};

let requestTenantContext = { ...DEFAULT_TENANT_CONTEXT };
let requestUser = { id: 'user-1', email: 'test@test.com' };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & Record<string, unknown>, _res, next) => {
    req.tenantContext = { ...requestTenantContext };
    req.user = { ...requestUser };
    next();
  });

  const sessionsRouter = (await import('../routes/sessions.js')).default;
  app.use('/api/projects/:projectId/sessions', sessionsRouter);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();

  mockGetEventStore.mockReturnValue({ emitter: { emit: mockEmit } });
  mockGetCurrentTraceId.mockReturnValue(undefined);
  mockGetSTRWriter.mockReturnValue(null);
  mockGetTraceStore.mockReturnValue({
    addEvent: mockAddTraceEvent,
    getTrace: () => null,
    getEvents: () => [],
    getSessionInfo: () => null,
    removeSession: vi.fn(),
    clearSession: vi.fn(),
  });

  mockIsDatabaseAvailable.mockReturnValue(false);
  mockFindStoredSessionByAnyId.mockImplementation((...args: unknown[]) =>
    mockFindSessionById(...args),
  );
  mockListStoredSessionCleanupIds.mockResolvedValue([]);
  mockGetClickHouseClient.mockReturnValue(null);
  mockGetRuntimeExecutor.mockReturnValue(makeExecutor());

  requestTenantContext = { ...DEFAULT_TENANT_CONTEXT };
  requestUser = { id: 'user-1', email: 'test@test.com' };

  const rbac = await import('../middleware/rbac.js');
  vi.mocked(rbac.requireProjectPermission).mockResolvedValue(true);
  vi.mocked(rbac.requireWriteAccess).mockResolvedValue(true);
  vi.mocked(rbac.requirePermissionInline).mockImplementation(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  );
});

function makeExecutor(overrides: Record<string, unknown> = {}) {
  return {
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(null),
    getSessionDetail: vi.fn().mockReturnValue(null),
    endSession: vi.fn(),
    ...overrides,
  };
}

function makeDbSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-session-1',
    currentAgent: 'Booking_Agent',
    channel: 'web_debug',
    status: 'active',
    messageCount: 5,
    tokenCount: 100,
    estimatedCost: 0.01,
    errorCount: 0,
    handoffCount: 0,
    callDuration: null,
    disposition: null,
    dispositionCode: null,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    lastActivityAt: new Date('2025-01-01T00:01:00Z'),
    endedAt: null,
    projectId: 'proj-1',
    environment: 'staging',
    runtimeSessionId: undefined,
    tenantId: 'tenant-1',
    context: '{}',
    ...overrides,
  };
}

async function request(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let body: { traces: Array<Record<string, unknown>> } | null = null;
  try {
    body = text ? (JSON.parse(text) as { traces: Array<Record<string, unknown>> }) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

function mockClickHouseRows(
  rows: Array<{
    event_id: string;
    event_type: string;
    category: string;
    span_id?: string;
    parent_span_id?: string;
    agent_name?: string;
    timestamp: string;
    duration_ms?: number;
    has_error?: number;
    data: string;
    _enc?: string;
  }>,
) {
  mockClickHouseQuery.mockImplementation(
    async (args: { query?: string; query_params?: Record<string, unknown> }) => {
      const query = typeof args.query === 'string' ? args.query : '';
      const queryParams =
        args.query_params && typeof args.query_params === 'object' ? args.query_params : {};

      let filteredRows = [...rows];
      if (typeof queryParams.spanId === 'string') {
        filteredRows = filteredRows.filter((row) => row.span_id === queryParams.spanId);
      }
      if (typeof queryParams.parentSpanId === 'string') {
        filteredRows = filteredRows.filter(
          (row) => row.parent_span_id === queryParams.parentSpanId,
        );
      }
      if (query.includes('SELECT count() AS total')) {
        return {
          json: async () => [{ total: filteredRows.length }],
        };
      }

      const offset =
        typeof queryParams.offset === 'number'
          ? queryParams.offset
          : Number.parseInt(String(queryParams.offset ?? 0), 10) || 0;
      const limit =
        typeof queryParams.limit === 'number'
          ? queryParams.limit
          : Number.parseInt(String(queryParams.limit ?? filteredRows.length), 10) ||
            filteredRows.length;

      return {
        json: async () => filteredRows.slice(offset, offset + limit),
      };
    },
  );

  mockGetClickHouseClient.mockReturnValue({
    query: (...args: unknown[]) => mockClickHouseQuery(...args),
  });
}

describe('reported channel and attachment trace wiring gaps', () => {
  test('studio reverse mapping normalizes persisted dotted channel and lifecycle trace types', () => {
    expect({
      'channel.message.received': normalizeEventType('channel.message.received'),
      'channel.message.sent': normalizeEventType('channel.message.sent'),
      'channel.response.sent': normalizeEventType('channel.response.sent'),
      'channel.webhook.delivered': normalizeEventType('channel.webhook.delivered'),
      'agent.error.handled': normalizeEventType('agent.error.handled'),
      'agent.profile.applied': normalizeEventType('agent.profile.applied'),
      'agent.voice.config_resolved': normalizeEventType('agent.voice.config_resolved'),
      'agent.hook.executed': normalizeEventType('agent.hook.executed'),
      'flow.action_handler.executed': normalizeEventType('flow.action_handler.executed'),
      'agent.escalation.triggered': normalizeEventType('agent.escalation.triggered'),
      'agent.escalation.resolved': normalizeEventType('agent.escalation.resolved'),
      'agent.escalation.itsm_created': normalizeEventType('agent.escalation.itsm_created'),
    }).toEqual({
      'channel.message.received': 'channel_message_received',
      'channel.message.sent': 'channel_message_sent',
      'channel.response.sent': 'channel_response_sent',
      'channel.webhook.delivered': 'channel_webhook_delivered',
      'agent.error.handled': 'agent_error_handled',
      'agent.profile.applied': 'behavior_profile_applied',
      'agent.voice.config_resolved': 'voice_config_resolved',
      'agent.hook.executed': 'hook_executed',
      'flow.action_handler.executed': 'action_handler_executed',
      'agent.escalation.triggered': 'escalation_triggered',
      'agent.escalation.resolved': 'escalation_resolved',
      'agent.escalation.itsm_created': 'itsm_ticket_created',
    });
  });

  test('historical /traces replay includes channel category rows and normalizes dotted channel event types', async () => {
    mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
    mockClickHouseRows([
      {
        event_id: 'evt-channel-in',
        event_type: 'channel.message.received',
        category: 'channel',
        timestamp: '2026-04-06T09:00:00.000Z',
        data: JSON.stringify({
          channel_type: 'slack',
          status: 'processed',
        }),
      },
      {
        event_id: 'evt-channel-out',
        event_type: 'channel.response.sent',
        category: 'channel',
        timestamp: '2026-04-06T09:00:01.000Z',
        data: JSON.stringify({
          channel_type: 'slack',
          status: 'sent',
          latency_ms: 120,
        }),
      },
    ]);

    const { status, body, text } = await request('/api/projects/proj-1/sessions/s1/traces');

    expect(status, text).toBe(200);
    expect(body.traces.map((trace: { type: string }) => trace.type)).toEqual([
      'channel_message_received',
      'channel_response_sent',
    ]);
    expect(
      mockClickHouseQuery.mock.calls.some(([args]) => {
        const query = String((args as { query?: string }).query ?? '');
        return query.includes('category IN') && query.includes("'channel'");
      }),
    ).toBe(true);
  });

  test('historical /traces replay includes attachment lifecycle rows alongside channel response events', async () => {
    mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
    mockClickHouseRows([
      {
        event_id: 'evt-attachment-process',
        event_type: 'attachment.processed',
        category: 'attachment',
        timestamp: '2026-04-06T09:00:00.000Z',
        data: JSON.stringify({
          channel: 'slack',
          provider: 'slack',
          stage: 'download',
          success: true,
          externalAttachmentId: 'F123',
          filename: 'test-slack-image.png',
        }),
      },
      {
        event_id: 'evt-attachment-upload',
        event_type: 'attachment.uploaded',
        category: 'attachment',
        timestamp: '2026-04-06T09:00:00.500Z',
        data: JSON.stringify({
          channel: 'slack',
          provider: 'slack',
          stage: 'upload',
          success: true,
          attachmentId: 'att-123',
          filename: 'test-slack-image.png',
        }),
      },
      {
        event_id: 'evt-attachment-preprocess',
        event_type: 'attachment.preprocessed',
        category: 'attachment',
        agent_name: 'SlackTestAgent',
        timestamp: '2026-04-06T09:00:01.000Z',
        data: JSON.stringify({
          attachmentCount: 1,
          contentBlockCount: 2,
          attachmentSummary: '1 image',
        }),
      },
      {
        event_id: 'evt-channel-out',
        event_type: 'channel.response.sent',
        category: 'channel',
        timestamp: '2026-04-06T09:00:02.000Z',
        data: JSON.stringify({
          channel_type: 'slack',
          status: 'sent',
          latency_ms: 120,
        }),
      },
    ]);

    const { status, body, text } = await request('/api/projects/proj-1/sessions/s1/traces');

    expect(status, text).toBe(200);
    expect(body.traces.map((trace: { type: string }) => trace.type)).toEqual([
      'attachment_process',
      'attachment_upload',
      'attachment_preprocess',
      'channel_response_sent',
    ]);
    expect(body.traces[0]).toEqual(
      expect.objectContaining({
        type: 'attachment_process',
        data: expect.objectContaining({
          stage: 'download',
          filename: 'test-slack-image.png',
        }),
      }),
    );
    expect(body.traces[2]).toEqual(
      expect.objectContaining({
        type: 'attachment_preprocess',
        agentName: 'SlackTestAgent',
        data: expect.objectContaining({
          attachmentCount: 1,
          contentBlockCount: 2,
        }),
      }),
    );
    expect(
      mockClickHouseQuery.mock.calls.some(([args]) => {
        const query = String((args as { query?: string }).query ?? '');
        return (
          query.includes('category IN') &&
          query.includes("'attachment'") &&
          query.includes("'channel'")
        );
      }),
    ).toBe(true);
  });

  test('channel.response.sent emitter includes the canonical schema fields used by EventStore consumers', () => {
    emitChannelResponseSent('sess-1', 'slack', 150, {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      traceId: 'trace-1',
      configHash: 'cfg-123',
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    const event = mockEmit.mock.calls[0]?.[0] as {
      duration_ms: number;
      data: Record<string, unknown>;
    };

    expect(event.duration_ms).toBe(150);
    expect(event.data).toEqual(
      expect.objectContaining({
        channel_type: 'slack',
        channelType: 'slack',
        latency_ms: 150,
        latencyMs: 150,
        status: 'sent',
      }),
    );
  });

  test('unexpected Slack attachment processor exceptions emit the failure trace callback', async () => {
    const onTraceEvent = vi.fn();

    const result = await processSlackFileReferences(
      [
        {
          slackFileId: 'F123',
          name: 'report.pdf',
          mimetype: 'application/pdf',
          filetype: 'pdf',
          size: 1024,
          downloadUrl: 'https://files.slack.com/download/report.pdf',
        },
      ],
      {
        botToken: 'xoxb-test',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        channel: 'slack',
        provider: 'slack',
        onTraceEvent,
        downloadFn: vi.fn().mockRejectedValue(new Error('cdn boom')),
        uploadFn: vi.fn().mockResolvedValue({
          success: true,
          attachmentId: 'att-123',
          status: 'pending',
        }),
      },
    );

    expect(result).toEqual([]);
    expect(onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          success: false,
          externalAttachmentId: 'F123',
          filename: 'report.pdf',
          error: 'cdn boom',
        }),
      }),
    );
  });
});
