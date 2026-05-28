/**
 * Session Route Integration Tests
 *
 * Mounts the sessions router on a real Express app and exercises
 * endpoints via Node's built-in fetch against an http.createServer listener.
 *
 * Endpoints under test:
 *   GET    /api/sessions                — list sessions
 *   GET    /api/sessions/:id            — get session detail
 *   DELETE /api/sessions/:id            — delete session
 *   POST   /api/sessions/:id/reset      — reset session
 *   GET    /api/sessions/:id/traces     — get session traces
 *   GET    /api/sessions/:id/analysis   — get session analysis
 *   GET    /api/sessions/:id/agent-spec — get agent specification
 *   POST   /api/sessions                — create session
 *   POST   /api/sessions/bulk-close     — bulk close sessions
 *   POST   /api/sessions/:id/close      — close session with disposition
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  PIIVault,
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
} from '@abl/compiler/platform';
import {
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
} from '../../services/trace-event-types.js';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

const mockGetRuntimeExecutor = vi.fn();
vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: any[]) => mockGetRuntimeExecutor(...args),
}));

const mockGetTraceStore = vi.fn();
vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: (...args: any[]) => mockGetTraceStore(...args),
}));

const mockBuildAgentDetails = vi.fn();
vi.mock('../../services/dsl-utils.js', () => ({
  buildAgentDetails: (...args: any[]) => mockBuildAgentDetails(...args),
}));

vi.mock('../../services/test-session.js', () => ({
  TestSessionService: {
    createSession: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    listSessions: vi.fn(),
  },
}));

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

const mockListSessions = vi.fn();
const mockCountSessions = vi.fn();
const mockFindSessionById = vi.fn();
const mockFindSessionByRuntimeId = vi.fn();
const mockFindMessagesForSession = vi.fn();
const mockFindMessagesForSessionCursor = vi.fn();
const mockFindMessagesByIdsForSession = vi.fn();
const mockFindStoredSessionByAnyId = vi.fn();
const mockListStoredSessionCleanupIds = vi.fn();
const mockResolveStoredSessionCompatibilityId = vi.fn(
  (session: Record<string, unknown>, fallbackId: string) =>
    (typeof session.id === 'string' && session.id) ||
    (typeof session._id === 'string' && session._id) ||
    (typeof session.runtimeSessionId === 'string' && session.runtimeSessionId) ||
    fallbackId,
);
const mockUpdateSession = vi.fn();

vi.mock('../../repos/session-repo.js', () => ({
  listSessions: (...args: any[]) => mockListSessions(...args),
  countSessions: (...args: any[]) => mockCountSessions(...args),
  findSessionById: (...args: any[]) => mockFindSessionById(...args),
  findSessionByRuntimeId: (...args: any[]) => mockFindSessionByRuntimeId(...args),
  findStoredSessionByAnyId: (...args: any[]) => mockFindStoredSessionByAnyId(...args),
  findMessagesForSession: (...args: any[]) => mockFindMessagesForSession(...args),
  findMessagesForSessionCursor: (...args: any[]) => mockFindMessagesForSessionCursor(...args),
  findMessagesByIdsForSession: (...args: any[]) => mockFindMessagesByIdsForSession(...args),
  listStoredSessionCleanupIds: (...args: any[]) => mockListStoredSessionCleanupIds(...args),
  resolveStoredSessionCompatibilityId: (...args: any[]) =>
    mockResolveStoredSessionCompatibilityId(...args),
  updateSession: (...args: any[]) => mockUpdateSession(...args),
}));

const mockFindProjectAgentByPath = vi.fn();
const mockFindProjectAgentByName = vi.fn();
const mockFindAgentVersion = vi.fn();
const mockFindProjectAgentForProject = vi.fn().mockResolvedValue(null);

vi.mock('../../repos/project-repo.js', () => ({
  findProjectAgentByPath: (...args: any[]) => mockFindProjectAgentByPath(...args),
  findProjectAgentByName: (...args: any[]) => mockFindProjectAgentByName(...args),
  findAgentVersion: (...args: any[]) => mockFindAgentVersion(...args),
  findProjectAgentForProject: (...args: any[]) => mockFindProjectAgentForProject(...args),
  findProjectByIdAndTenant: vi
    .fn()
    .mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-1', ownerId: 'user-1' }),
  findProjectMember: vi.fn().mockResolvedValue({ role: 'admin' }),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requireProjectPermission: vi.fn().mockResolvedValue(true),
  requireSensitiveProjectPermission: vi.fn().mockResolvedValue(true),
  requireWriteAccess: vi.fn().mockResolvedValue(true),
  requirePermissionInline: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

const mockRevealPIITokens = vi.fn();
vi.mock('../../services/pii/pii-token-vault-service.js', () => ({
  MAX_PII_REVEAL_SELECTOR_COUNT: 50,
  revealPIITokens: (...args: any[]) => mockRevealPIITokens(...args),
}));

vi.mock('../../attachments/multimodal-service-client.js', () => ({
  MultimodalServiceClient: vi.fn().mockImplementation(() => ({
    deleteBySession: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockIsDatabaseAvailable = vi.fn();
const mockIsDatabaseReady = vi.fn();
vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: (...args: any[]) => mockIsDatabaseAvailable(...args),
  isDatabaseReady: (...args: any[]) => mockIsDatabaseReady(...args),
  requirePrisma: vi.fn(),
}));

const mockBuildSessionListFilter = vi.fn((_authContext: unknown, projectId: string) => ({
  projectId,
}));
const mockToAuthContext = vi.fn((tenantContext: unknown) => tenantContext);
vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    // Explicit pass-through so the router.param('id', ...) middleware doesn't
    // accidentally invoke real DB lookups in tests.
    createRequireSessionOwnership: vi.fn(() => async (_req: any, _res: any, next: any) => next()),
    buildSessionListFilter: (...args: any[]) => mockBuildSessionListFilter(...args),
    toAuthContext: (...args: any[]) => mockToAuthContext(...args),
  };
});

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  canStartSession: vi.fn().mockResolvedValue(true),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
  claimSessionSlot: vi.fn().mockResolvedValue(1),
  releaseSessionSlot: vi.fn().mockResolvedValue(0),
  incrementSessionCount: vi.fn().mockResolvedValue(1),
  decrementSessionCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditSessionModified: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/tenant-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/tenant-config.js')>();
  return {
    ...actual,
    getTenantConfigService: () => ({
      getConfigAsync: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
      getProjectConfig: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
    }),
  };
});

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

const mockCascadeDeleteSession = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/cascade', () => ({
  deleteSession: (...args: any[]) => mockCascadeDeleteSession(...args),
}));

const mockSessionModelFind = vi.fn();
const mockSessionStateFind = vi.fn();
const mockSessionStateFindOne = vi.fn();
const mockSessionModelUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
const mockMessageDistinct = vi.fn().mockResolvedValue([]);
const mockAttachmentDistinct = vi.fn().mockResolvedValue([]);
const mockGetSessionWebSocket = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockPIIPatternFind = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  Session: {
    find: (...args: any[]) => mockSessionModelFind(...args),
    updateMany: (...args: any[]) => mockSessionModelUpdateMany(...args),
  },
  SessionState: {
    find: (...args: any[]) => mockSessionStateFind(...args),
    findOne: (...args: any[]) => mockSessionStateFindOne(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: any[]) => mockProjectRuntimeConfigFindOne(...args),
  },
  PIIPattern: {
    find: (...args: any[]) => mockPIIPatternFind(...args),
  },
  Message: {
    distinct: (...args: any[]) => mockMessageDistinct(...args),
  },
  Attachment: {
    distinct: (...args: any[]) => mockAttachmentDistinct(...args),
  },
}));

vi.mock('../../services/agent-transfer/message-bridge.js', () => ({
  getSessionWebSocket: (...args: any[]) => mockGetSessionWebSocket(...args),
}));

const mockPausedExecutionCleanupSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/auth-profile/paused-execution-store.js', () => ({
  getPausedExecutionStore: () => ({
    cleanupSession: (...args: any[]) => mockPausedExecutionCleanupSession(...args),
  }),
}));

const mockClickHouseQuery = vi.fn();
const mockGetClickHouseClient = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: any[]) => mockGetClickHouseClient(...args),
  parseClickHouseTimestamp: (value: string | Date) => new Date(value),
}));

vi.mock('@agent-platform/database/clickhouse.js', () => ({
  getClickHouseClient: (...args: any[]) => mockGetClickHouseClient(...args),
  parseClickHouseTimestamp: (value: string | Date) => new Date(value),
}));

// =============================================================================
// APP SETUP
// =============================================================================

import express from 'express';
import { resetProjectPIISnapshotCacheForTest } from '../../services/pii/session-pii-context.js';

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

  // Inject tenantContext for every request
  app.use((req: any, _res: any, next: any) => {
    req.tenantContext = { ...requestTenantContext };
    req.user = { ...requestUser };
    next();
  });

  const sessionsRouter = (await import('../../routes/sessions.js')).default;
  app.use('/api/projects/:projectId/sessions', sessionsRouter);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetProjectPIISnapshotCacheForTest();
  mockIsDatabaseAvailable.mockReturnValue(false);
  mockIsDatabaseReady.mockReturnValue(false);
  mockGetClickHouseClient.mockReturnValue(null);
  mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
  mockGetTraceStore.mockReturnValue(makeTraceStore());
  mockFindStoredSessionByAnyId.mockImplementation((...args: any[]) => mockFindSessionById(...args));
  mockFindMessagesForSession.mockResolvedValue([]);
  mockFindMessagesForSessionCursor.mockResolvedValue({
    messages: [],
    nextCursor: null,
    hasMore: false,
  });
  mockFindMessagesByIdsForSession.mockResolvedValue([]);
  mockListStoredSessionCleanupIds.mockResolvedValue([]);
  mockSessionModelFind.mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
  });
  mockSessionStateFind.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  });
  mockSessionStateFindOne.mockReturnValue(makeAwaitableLeanQuery(null));
  mockProjectRuntimeConfigFindOne.mockReturnValue(makeLeanQuery(null));
  mockPIIPatternFind.mockReturnValue(makeSortedLeanQuery([]));
  mockSessionModelUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockMessageDistinct.mockResolvedValue([]);
  mockAttachmentDistinct.mockResolvedValue([]);
  mockGetSessionWebSocket.mockReturnValue(undefined);
  requestTenantContext = { ...DEFAULT_TENANT_CONTEXT };
  requestUser = { id: 'user-1', email: 'test@test.com' };
  // Restore default RBAC pass-through after clearAllMocks (all functions)
  const rbac = await import('../../middleware/rbac.js');
  vi.mocked(rbac.requireProjectPermission).mockResolvedValue(true);
  vi.mocked(rbac.requireSensitiveProjectPermission).mockResolvedValue(true);
  vi.mocked(rbac.requireWriteAccess).mockResolvedValue(true);
  vi.mocked(rbac.requirePermissionInline).mockImplementation(
    () => (_req: any, _res: any, next: any) => next(),
  );
  mockRevealPIITokens.mockResolvedValue({ revealed: [], unavailable: [], auditLogCount: 0 });
});

// =============================================================================
// HELPERS
// =============================================================================

async function request(method: string, path: string, opts?: { body?: any }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function requestText(method: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { method });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

const BASE = '/api/projects/proj-1/sessions';
const ACTIVE_OR_IDLE_SESSION_STATUSES = ['active', 'idle'];

function makeLeanQuery<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

function makeAwaitableLeanQuery<T>(value: T) {
  const promise = Promise.resolve(value);
  return {
    lean: vi.fn().mockResolvedValue(value),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function makeSortedLeanQuery<T>(value: T) {
  return {
    sort: vi.fn().mockReturnValue(makeLeanQuery(value)),
  };
}

function mockProjectPIIConfig(params?: {
  piiRedaction?: {
    enabled: boolean;
    redact_input: boolean;
    redact_output: boolean;
  };
  patterns?: Array<Record<string, unknown>>;
}) {
  mockIsDatabaseReady.mockReturnValue(true);
  mockProjectRuntimeConfigFindOne.mockReturnValue(
    makeLeanQuery({
      pii_redaction: params?.piiRedaction ?? {
        enabled: true,
        redact_input: true,
        redact_output: true,
      },
    }),
  );
  mockPIIPatternFind.mockReturnValue(makeSortedLeanQuery(params?.patterns ?? []));
}

function makeContractPIIPattern(rawPattern?: Partial<Record<string, unknown>>) {
  return {
    _id: 'contract-pattern',
    name: 'ContractID',
    piiType: 'custom',
    builtinOverride: false,
    enabled: true,
    regex: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    defaultRenderMode: 'redacted',
    consumerAccess: [],
    redaction: {
      type: 'predefined',
      label: '[REDACTED_CONTRACT_ID]',
    },
    ...rawPattern,
  };
}
const RECENTLY_TERMINATED_SESSION_STATUSES = [
  'ended',
  'abandoned',
  'completed',
  'error',
  'escalated',
];

function makeExecutor(overrides: Record<string, any> = {}) {
  return {
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(null),
    getSessionDetail: vi.fn().mockReturnValue(null),
    rehydrateSession: vi.fn().mockResolvedValue(null),
    persistSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    ...overrides,
  };
}

function makeTraceStore(overrides: Record<string, any> = {}) {
  return {
    getEvents: vi.fn().mockReturnValue([]),
    getSessionInfo: vi.fn().mockReturnValue(null),
    finalizeSession: vi.fn(),
    removeSession: vi.fn(),
    clearSession: vi.fn(),
    ...overrides,
  };
}

function makeDbSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-session-1',
    currentAgent: 'Booking_Agent',
    entryAgentName: 'Booking_Agent',
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
    initiatedById: 'user-1',
    context: '{}',
    ...overrides,
  };
}

function makeRuntimeDeveloperSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'runtime-session-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    userId: 'user-1',
    agentName: 'Booking_Agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {
        session: {
          channel: 'debug_websocket',
          sessionId: 'runtime-session-1',
          userId: 'user-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
        },
      },
      gatheredKeys: new Set<string>(),
    },
    executionTreeValues: {},
    isComplete: false,
    isEscalated: false,
    transferInitiated: false,
    handoffStack: ['Booking_Agent'],
    delegateStack: [],
    callerContext: {
      tenantId: 'tenant-1',
      initiatedById: 'user-1',
      channel: 'web_debug',
      identityTier: 0,
      verificationMethod: 'none',
    },
    threads: [
      {
        agentName: 'Booking_Agent',
        conversationHistory: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
        state: {
          gatherProgress: {},
          conversationPhase: 'start',
          context: {},
        },
        data: {
          values: {},
          gatheredKeys: new Set<string>(),
        },
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date('2026-04-23T06:00:00.000Z'),
    lastActivityAt: new Date('2026-04-23T06:05:00.000Z'),
    channelType: 'debug_websocket',
    ...overrides,
  };
}

function getFilterValue(record: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, record);
}

function compareFilterValue(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function matchesSessionFilter(
  record: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === '$and') {
      return Array.isArray(value)
        ? value.every((clause) =>
            Boolean(
              clause &&
              typeof clause === 'object' &&
              matchesSessionFilter(record, clause as Record<string, unknown>),
            ),
          )
        : false;
    }

    if (key === '$or') {
      return Array.isArray(value)
        ? value.some((clause) =>
            Boolean(
              clause &&
              typeof clause === 'object' &&
              matchesSessionFilter(record, clause as Record<string, unknown>),
            ),
          )
        : false;
    }

    const actual = getFilterValue(record, key);

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const operators = value as Record<string, unknown>;
      return Object.entries(operators).every(([operator, operand]) => {
        switch (operator) {
          case '$in':
            return Array.isArray(operand)
              ? operand.some((candidate) => compareFilterValue(actual, candidate))
              : false;
          case '$regex': {
            const source =
              typeof operand === 'string'
                ? operand
                : operand instanceof RegExp
                  ? operand.source
                  : null;
            if (!source || typeof actual !== 'string') {
              return false;
            }
            const flags =
              typeof operators.$options === 'string'
                ? operators.$options
                : operand instanceof RegExp
                  ? operand.flags
                  : '';
            return new RegExp(source, flags).test(actual);
          }
          case '$options':
            return true;
          case '$gt':
            return actual instanceof Date && operand instanceof Date
              ? actual.getTime() > operand.getTime()
              : Number(actual) > Number(operand);
          case '$gte':
            return actual instanceof Date && operand instanceof Date
              ? actual.getTime() >= operand.getTime()
              : Number(actual) >= Number(operand);
          case '$lt':
            return actual instanceof Date && operand instanceof Date
              ? actual.getTime() < operand.getTime()
              : Number(actual) < Number(operand);
          case '$lte':
            return actual instanceof Date && operand instanceof Date
              ? actual.getTime() <= operand.getTime()
              : Number(actual) <= Number(operand);
          case '$exists':
            return operand ? actual !== undefined : actual === undefined;
          default:
            return false;
        }
      });
    }

    return compareFilterValue(actual, value);
  });
}

function getLiveSessionVisibilityClause(where: Record<string, unknown>): { $or: unknown[] } {
  const visibilityClause = Array.isArray(where.$and)
    ? where.$and.find((clause): clause is { $or: unknown[] } =>
        Boolean(
          clause &&
          typeof clause === 'object' &&
          '$or' in (clause as Record<string, unknown>) &&
          Array.isArray((clause as { $or?: unknown }).$or),
        ),
      )
    : undefined;

  if (!visibilityClause) {
    throw new Error('Expected live session visibility clause in session list filter');
  }

  return visibilityClause;
}

function makeFindQuery(result: unknown) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(result),
    }),
  };
}

function mockClickHouseEvents(
  events: Array<{
    id: string;
    type: string;
    timestamp: Date;
    data?: Record<string, unknown>;
    spanId?: string;
    parentSpanId?: string;
  }>,
) {
  const toPlatformEventType = (eventType: string): string => {
    switch (eventType) {
      case 'llm_call':
        return 'llm.call.completed';
      case 'tool_call':
        return 'tool.call.completed';
      case 'agent_enter':
        return 'agent.entered';
      case 'agent_exit':
        return 'agent.exited';
      case 'handoff':
        return 'agent.handoff';
      case 'session_created':
        return 'session.started';
      case 'session_ended':
        return 'session.ended';
      case 'user_message':
        return 'message.user.received';
      case 'agent_response':
        return 'message.agent.sent';
      case 'error':
        return 'system.error';
      default:
        return eventType.includes('.') ? eventType : RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE;
    }
  };

  const toCategory = (platformEventType: string): string => {
    if (platformEventType.startsWith('llm.')) return 'llm';
    if (platformEventType.startsWith('tool.')) return 'tool';
    if (platformEventType.startsWith('agent.')) return 'agent';
    if (platformEventType.startsWith('flow.')) return 'flow';
    if (platformEventType.startsWith('message.')) return 'message';
    if (platformEventType.startsWith('voice.')) return 'voice';
    if (platformEventType.startsWith('session.')) return 'session';
    if (platformEventType.startsWith('system.') || platformEventType === 'error') return 'system';
    return 'session';
  };

  const rows = events.map((event) => {
    const platformEventType = toPlatformEventType(event.type);
    const data =
      platformEventType === RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE
        ? { ...(event.data ?? {}), [RUNTIME_TRACE_TYPE_DATA_KEY]: event.type }
        : (event.data ?? {});

    return {
      event_id: event.id,
      event_type: platformEventType,
      category: toCategory(platformEventType),
      span_id: event.spanId ?? '',
      parent_span_id: event.parentSpanId ?? '',
      agent_name: '',
      timestamp: event.timestamp.toISOString(),
      duration_ms: 0,
      has_error: event.type === 'error' ? 1 : 0,
      data: JSON.stringify(data),
      _enc: '',
    };
  });

  mockClickHouseQuery.mockImplementation(
    async (args: { query?: string; query_params?: Record<string, unknown> }) => {
      const query = typeof args.query === 'string' ? args.query : '';
      const queryParams =
        args.query_params && typeof args.query_params === 'object' ? args.query_params : {};
      let filteredRows = rows;

      if (typeof queryParams.spanId === 'string') {
        filteredRows = filteredRows.filter((row) => row.span_id === queryParams.spanId);
      }

      if (typeof queryParams.parentSpanId === 'string') {
        filteredRows = filteredRows.filter(
          (row) => row.parent_span_id === queryParams.parentSpanId,
        );
      }

      const eventTypes = Array.isArray(queryParams.eventTypes)
        ? queryParams.eventTypes.map((eventType) => String(eventType))
        : [];
      const runtimeAtomicTraceTypes = Array.isArray(queryParams.runtimeAtomicTraceTypes)
        ? queryParams.runtimeAtomicTraceTypes.map((eventType) => String(eventType))
        : [];
      if (eventTypes.length > 0 || runtimeAtomicTraceTypes.length > 0) {
        filteredRows = filteredRows.filter((row) => {
          if (eventTypes.includes(row.event_type)) {
            return true;
          }
          if (row.event_type !== RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE) {
            return false;
          }
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          return runtimeAtomicTraceTypes.includes(
            String(parsed[RUNTIME_TRACE_TYPE_DATA_KEY] ?? ''),
          );
        });
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
    query: (...args: any[]) => mockClickHouseQuery(...args),
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Session Routes', () => {
  // ---------------------------------------------------------------------------
  // RBAC enforcement
  // ---------------------------------------------------------------------------
  describe('RBAC enforcement', () => {
    async function denyOnce() {
      const rbac = await import('../../middleware/rbac.js');
      vi.mocked(rbac.requireProjectPermission).mockImplementationOnce(async (_req, res) => {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return false;
      });
    }

    test('POST / returns 403 when requireProjectPermission denies (session:execute)', async () => {
      await denyOnce();
      const { status, body } = await request('POST', BASE, { body: { agentId: 'test/agent' } });
      expect(status).toBe(403);
      expect(body.success).toBe(false);
    });

    test('GET / returns 403 when requireProjectPermission denies (session:read)', async () => {
      await denyOnce();
      const { status, body } = await request('GET', BASE);
      expect(status).toBe(403);
      expect(body.success).toBe(false);
    });

    test('DELETE /:id returns 403 when requireProjectPermission denies (session:delete)', async () => {
      await denyOnce();
      const { status, body } = await request('DELETE', `${BASE}/session-1`);
      expect(status).toBe(403);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // GET / — list sessions
  // ---------------------------------------------------------------------------
  describe('GET / (list sessions)', () => {
    test('returns sessions from DB when database is available', async () => {
      const dbSession = makeDbSession();
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockListSessions.mockResolvedValue([dbSession]);
      mockCountSessions.mockResolvedValue(1);
      const executor = makeExecutor();
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].agentName).toBe('Booking_Agent');
      // body.total is the post-ghost-filter count (allSessions.length),
      // not the raw countSessions() DB result.
      expect(body.total).toBe(1);
    });

    test('normalizes persisted currentAgent paths in session list responses', async () => {
      const dbSession = makeDbSession({
        currentAgent: 'travel/Booking_Agent',
        entryAgentName: null,
      });
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockListSessions.mockResolvedValue([dbSession]);
      mockCountSessions.mockResolvedValue(1);
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].agentName).toBe('Booking_Agent');
    });

    test('supports agent, disposition, time-range, and mine filters for persisted sessions', async () => {
      const persistedSessions = [
        makeDbSession({
          id: 'db-match',
          currentAgent: 'Billing_Agent',
          entryAgentName: 'Billing_Agent',
          disposition: 'completed',
          lastActivityAt: new Date('2025-01-02T12:00:00Z'),
          environment: 'production',
          initiatedById: 'user-1',
        }),
        makeDbSession({
          id: 'db-other-user',
          currentAgent: 'Billing_Agent',
          entryAgentName: 'Billing_Agent',
          disposition: 'completed',
          lastActivityAt: new Date('2025-01-02T12:30:00Z'),
          environment: 'production',
          initiatedById: 'user-2',
        }),
        makeDbSession({
          id: 'db-wrong-disposition',
          currentAgent: 'Billing_Agent',
          entryAgentName: 'Billing_Agent',
          disposition: 'abandoned',
          lastActivityAt: new Date('2025-01-02T13:00:00Z'),
          environment: 'production',
          initiatedById: 'user-1',
        }),
        makeDbSession({
          id: 'db-outside-range',
          currentAgent: 'Billing_Agent',
          entryAgentName: 'Billing_Agent',
          disposition: 'completed',
          lastActivityAt: new Date('2024-12-30T09:00:00Z'),
          environment: 'production',
          initiatedById: 'user-1',
        }),
        makeDbSession({
          id: 'db-wrong-environment',
          currentAgent: 'Billing_Agent',
          entryAgentName: 'Billing_Agent',
          disposition: 'completed',
          lastActivityAt: new Date('2025-01-02T12:20:00Z'),
          environment: 'staging',
          initiatedById: 'user-1',
        }),
        makeDbSession({
          id: 'db-wrong-agent',
          currentAgent: 'Support_Agent',
          entryAgentName: 'Support_Agent',
          disposition: 'completed',
          lastActivityAt: new Date('2025-01-02T12:15:00Z'),
          environment: 'production',
          initiatedById: 'user-1',
        }),
      ];

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockCountSessions.mockImplementation(async (where: Record<string, unknown>) => {
        return persistedSessions.filter((session) => matchesSessionFilter(session, where)).length;
      });
      mockListSessions.mockImplementation(
        async (
          where: Record<string, unknown>,
          opts?: { skip?: number; take?: number; orderBy?: Record<string, string> },
        ) => {
          const filtered = persistedSessions.filter((session) =>
            matchesSessionFilter(session, where),
          );
          const sorted = opts?.orderBy?.lastActivityAt
            ? [...filtered].sort((left, right) => {
                const leftTime = left.lastActivityAt.getTime();
                const rightTime = right.lastActivityAt.getTime();
                return opts.orderBy?.lastActivityAt === 'desc'
                  ? rightTime - leftTime
                  : leftTime - rightTime;
              })
            : filtered;
          const skip = opts?.skip ?? 0;
          const take = opts?.take ?? sorted.length;
          return sorted.slice(skip, skip + take);
        },
      );
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request(
        'GET',
        `${BASE}?agentName=${encodeURIComponent('Billing Agent')}&environment=Production&disposition=completed&from=2025-01-01T00:00:00.000Z&to=2025-01-03T00:00:00.000Z&mine=true`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.total).toBe(1);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe('db-match');
      expect(body.sessions[0].agentName).toBe('Billing_Agent');
      expect(body.sessions[0].disposition).toBe('completed');
      expect(body.sessions[0].environment).toBe('production');
    });

    test('preserves requested string sort order after merging persisted sessions', async () => {
      const dbSessions = [
        makeDbSession({
          id: 'db-prod',
          environment: 'production',
          lastActivityAt: new Date('2025-01-01T00:03:00Z'),
        }),
        makeDbSession({
          id: 'db-dev',
          environment: 'development',
          lastActivityAt: new Date('2025-01-01T00:01:00Z'),
        }),
        makeDbSession({
          id: 'db-staging',
          environment: 'staging',
          lastActivityAt: new Date('2025-01-01T00:02:00Z'),
        }),
      ];

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockCountSessions.mockResolvedValue(dbSessions.length);
      mockListSessions.mockResolvedValue(dbSessions);
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}?sortBy=environment&sortDir=asc`);

      expect(status).toBe(200);
      expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([
        'db-dev',
        'db-prod',
        'db-staging',
      ]);
      expect(mockListSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          orderBy: { environment: 'asc' },
        }),
      );
    });

    test('excludes runtime-only sessions from DB-backed lists until they are persisted', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([
          {
            id: 'rt-live-1',
            agentName: 'Live_Agent',
            messageCount: 2,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:01:00Z',
            activeAgent: 'Live_Agent',
            threadCount: 1,
          },
        ]),
        getSession: vi.fn().mockReturnValue({
          id: 'rt-live-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channel: 'web_debug',
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(0);
      expect(body.total).toBe(0);
      expect(mockListSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          skip: 0,
          take: 50,
        }),
      );
    });

    test('supports agent, time-range, and mine filters for runtime-only sessions', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      const runtimeSessions = new Map<string, any>([
        [
          'rt-match',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-1',
            channelType: 'web_debug',
            versionInfo: {
              environment: 'production',
              versions: {},
            },
          },
        ],
        [
          'rt-other-user',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-2',
            channelType: 'web_debug',
            versionInfo: {
              environment: 'production',
              versions: {},
            },
          },
        ],
        [
          'rt-outside-range',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-1',
            channelType: 'web_debug',
            versionInfo: {
              environment: 'production',
              versions: {},
            },
          },
        ],
        [
          'rt-wrong-environment',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-1',
            channelType: 'web_debug',
            versionInfo: {
              environment: 'staging',
              versions: {},
            },
          },
        ],
        [
          'rt-other-agent',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-1',
            channelType: 'web_debug',
            versionInfo: {
              environment: 'production',
              versions: {},
            },
          },
        ],
      ]);
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([
          {
            id: 'rt-match',
            agentName: 'Billing_Agent',
            messageCount: 3,
            createdAt: '2025-01-02T11:55:00Z',
            lastActivityAt: '2025-01-02T12:00:00Z',
            activeAgent: 'Billing_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-other-user',
            agentName: 'Billing_Agent',
            messageCount: 2,
            createdAt: '2025-01-02T12:10:00Z',
            lastActivityAt: '2025-01-02T12:12:00Z',
            activeAgent: 'Billing_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-outside-range',
            agentName: 'Billing_Agent',
            messageCount: 1,
            createdAt: '2024-12-30T10:00:00Z',
            lastActivityAt: '2024-12-30T10:05:00Z',
            activeAgent: 'Billing_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-other-agent',
            agentName: 'Support_Agent',
            messageCount: 1,
            createdAt: '2025-01-02T12:15:00Z',
            lastActivityAt: '2025-01-02T12:16:00Z',
            activeAgent: 'Support_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-wrong-environment',
            agentName: 'Billing_Agent',
            messageCount: 2,
            createdAt: '2025-01-02T12:05:00Z',
            lastActivityAt: '2025-01-02T12:06:00Z',
            activeAgent: 'Billing_Agent',
            threadCount: 1,
          },
        ]),
        getSession: vi.fn((sessionId: string) => runtimeSessions.get(sessionId)),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request(
        'GET',
        `${BASE}?agentName=${encodeURIComponent('BillingAgent')}&environment=Production&from=2025-01-01T00:00:00.000Z&to=2025-01-03T00:00:00.000Z&mine=true`,
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.total).toBe(1);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe('rt-match');
      expect(body.sessions[0].agentName).toBe('Billing_Agent');
      expect(body.sessions[0].environment).toBe('production');
      expect(body.sessions[0].status).toBe('active');
    });

    test('returns 400 for invalid mine filter', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}?mine=maybe`);

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toEqual({
        code: 'INVALID_QUERY',
        message: 'mine must be a boolean query value',
      });
    });

    test('ended zero-activity sessions are excluded from total', async () => {
      // Zero-activity sessions are now filtered at the repo query layer via liveWhere.
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(0);
      expect(body.total).toBe(0);
      const listWhere = mockListSessions.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      const visibilityClause = getLiveSessionVisibilityClause(listWhere);

      expect(visibilityClause.$or).toEqual([
        { status: { $in: ACTIVE_OR_IDLE_SESSION_STATUSES } },
        { messageCount: { $gt: 0 } },
        { traceEventCount: { $gt: 0 } },
        {
          $and: [
            { status: { $in: RECENTLY_TERMINATED_SESSION_STATUSES } },
            { endedAt: { $gte: expect.any(Date) } },
          ],
        },
      ]);
      expect(mockListSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: [
            expect.objectContaining({ projectId: 'proj-1', tenantId: 'tenant-1' }),
            expect.any(Object),
          ],
        }),
        expect.objectContaining({
          orderBy: { lastActivityAt: 'desc' },
          take: 50,
        }),
      );
    });

    test('session with traces but no messages is NOT filtered as ghost', async () => {
      // traceEventCount > 0 means the session has activity — should survive the ghost filter
      const tracedSession = makeDbSession({
        messageCount: 0,
        traceEventCount: 3,
        runtimeSessionId: undefined,
      });
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockListSessions.mockResolvedValue([tracedSession]);
      mockCountSessions.mockResolvedValue(1);
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    test('ABLP-273 keeps recently timed-out sessions visible when timeout sweep beats async messageCount increment', async () => {
      const now = Date.now();
      const recentlyTimedOutSession = makeDbSession({
        id: 'db-session-timeout-race',
        status: 'ended',
        disposition: 'unengaged',
        messageCount: 0,
        traceEventCount: 0,
        startedAt: new Date(now - 60_000),
        lastActivityAt: new Date(now - 30_000),
        endedAt: new Date(now - 25_000),
      });
      const staleEndedGhostSession = makeDbSession({
        id: 'db-session-old-ghost',
        status: 'ended',
        disposition: 'unengaged',
        messageCount: 0,
        traceEventCount: 0,
        startedAt: new Date(now - 20 * 60_000),
        lastActivityAt: new Date(now - 15 * 60_000),
        endedAt: new Date(now - 10 * 60_000),
      });
      const persistedSessions = [recentlyTimedOutSession, staleEndedGhostSession];

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockCountSessions.mockImplementation(async (where: Record<string, unknown>) => {
        return persistedSessions.filter((session) => matchesSessionFilter(session, where)).length;
      });
      mockListSessions.mockImplementation(
        async (
          where: Record<string, unknown>,
          opts?: { skip?: number; take?: number; orderBy?: Record<string, string> },
        ) => {
          const filtered = persistedSessions.filter((session) =>
            matchesSessionFilter(session, where),
          );
          const sorted = opts?.orderBy?.lastActivityAt
            ? [...filtered].sort((left, right) => {
                const leftTime = left.lastActivityAt.getTime();
                const rightTime = right.lastActivityAt.getTime();
                return opts.orderBy?.lastActivityAt === 'desc'
                  ? rightTime - leftTime
                  : leftTime - rightTime;
              })
            : filtered;
          const skip = opts?.skip ?? 0;
          const take = opts?.take ?? sorted.length;
          return sorted.slice(skip, skip + take);
        },
      );
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.total).toBe(1);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([
        'db-session-timeout-race',
      ]);
      expect(body.sessions[0].id).toBe('db-session-timeout-race');
      expect(body.sessions[0].status).toBe('ended');
      expect(body.sessions[0].disposition).toBe('unengaged');

      const countWhere = mockCountSessions.mock.calls[0]?.[0] as Record<string, unknown>;
      const visibilityClause = getLiveSessionVisibilityClause(countWhere);
      expect(visibilityClause.$or).toEqual([
        { status: { $in: ACTIVE_OR_IDLE_SESSION_STATUSES } },
        { messageCount: { $gt: 0 } },
        { traceEventCount: { $gt: 0 } },
        {
          $and: [
            { status: { $in: RECENTLY_TERMINATED_SESSION_STATUSES } },
            { endedAt: { $gte: expect.any(Date) } },
          ],
        },
      ]);
      expect(matchesSessionFilter(recentlyTimedOutSession, countWhere)).toBe(true);
      expect(matchesSessionFilter(staleEndedGhostSession, countWhere)).toBe(false);
    });

    test('returns empty list when no sessions', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);
      const executor = makeExecutor();
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(0);
      // total is post-filter array length, not countSessions() result
      expect(body.total).toBe(0);
    });

    test('falls back to RuntimeExecutor when DB is unavailable', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([
          {
            id: 'rt-1',
            agentName: 'Test_Agent',
            messageCount: 3,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:01:00Z',
            activeAgent: 'Test_Agent',
            threadCount: 1,
          },
        ]),
        // Route calls getSession for tenant+project isolation check
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].agentName).toBe('Test_Agent');
      expect(body.sessions[0].status).toBe('active');
    });

    test('applies pagination and channel filtering when falling back to RuntimeExecutor only', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      const runtimeSessions = new Map<string, any>([
        [
          'rt-1',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelType: 'web_debug',
          },
        ],
        [
          'rt-2',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelType: 'web_debug',
          },
        ],
        [
          'rt-3',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelType: 'slack',
          },
        ],
      ]);
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([
          {
            id: 'rt-1',
            agentName: 'Newest_Agent',
            messageCount: 3,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:03:00Z',
            activeAgent: 'Newest_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-2',
            agentName: 'Older_Agent',
            messageCount: 2,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:02:00Z',
            activeAgent: 'Older_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-3',
            agentName: 'Other_Channel_Agent',
            messageCount: 1,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:04:00Z',
            activeAgent: 'Other_Channel_Agent',
            threadCount: 1,
          },
        ]),
        getSession: vi.fn((sessionId: string) => runtimeSessions.get(sessionId)),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}?channel=web_debug&limit=1&offset=1`);

      expect(status).toBe(200);
      expect(body.total).toBe(2);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(1);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe('rt-2');
      expect(body.sessions[0].channel).toBe('web_debug');
    });

    test('still lists runtime sessions when TraceStore is unavailable', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      mockGetTraceStore.mockImplementation(() => {
        throw new Error('trace-store unavailable');
      });
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([
          {
            id: 'rt-1',
            agentName: 'Trace_Optional_Agent',
            messageCount: 2,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:01:00Z',
            activeAgent: 'Trace_Optional_Agent',
            threadCount: 1,
          },
        ]),
        getSession: vi.fn().mockReturnValue({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channelType: 'web_debug',
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].traceEventCount).toBe(0);
    });

    test('scopes RuntimeExecutor fallback to the SDK caller ownership context', async () => {
      requestTenantContext = {
        tenantId: 'tenant-1',
        userId: 'sdk-session-a',
        permissions: ['session:read'],
        authType: 'sdk_session',
        role: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'proj-1',
        channelId: 'channel-1',
        sessionPrincipal: 'sdk-session-a',
        authScope: 'session',
      };
      mockIsDatabaseAvailable.mockReturnValue(false);
      const runtimeSessions = new Map<string, any>([
        [
          'rt-own',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            callerContext: {
              tenantId: 'tenant-1',
              channel: 'sdk_web',
              channelId: 'channel-1',
              sessionPrincipalId: 'sdk-session-a',
              anonymousId: 'sdk-session-a',
              identityTier: 0,
              verificationMethod: 'none',
              authScope: 'session',
            },
          },
        ],
        [
          'rt-other',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            callerContext: {
              tenantId: 'tenant-1',
              channel: 'sdk_web',
              channelId: 'channel-1',
              sessionPrincipalId: 'sdk-session-b',
              anonymousId: 'sdk-session-b',
              identityTier: 0,
              verificationMethod: 'none',
              authScope: 'session',
            },
          },
        ],
      ]);
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([
          {
            id: 'rt-own',
            agentName: 'Owned_Agent',
            messageCount: 2,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:01:00Z',
            activeAgent: 'Owned_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-other',
            agentName: 'Other_Agent',
            messageCount: 4,
            createdAt: '2025-01-01T00:02:00Z',
            lastActivityAt: '2025-01-01T00:03:00Z',
            activeAgent: 'Other_Agent',
            threadCount: 1,
          },
        ]),
        getSession: vi.fn((sessionId: string) => runtimeSessions.get(sessionId)),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe('rt-own');
    });

    test('scopes RuntimeExecutor fallback to the non-elevated platform member ownership context', async () => {
      requestTenantContext = {
        ...DEFAULT_TENANT_CONTEXT,
        role: 'MEMBER',
      };
      requestUser = { id: 'user-1', email: 'member@test.com' };
      mockIsDatabaseAvailable.mockReturnValue(false);
      const runtimeSessions = new Map<string, any>([
        [
          'rt-own',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-1',
            callerContext: {
              tenantId: 'tenant-1',
              channel: 'debug_websocket',
              initiatedById: 'user-1',
              identityTier: 0,
              verificationMethod: 'none',
            },
          },
        ],
        [
          'rt-other',
          {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-2',
            callerContext: {
              tenantId: 'tenant-1',
              channel: 'debug_websocket',
              initiatedById: 'user-2',
              identityTier: 0,
              verificationMethod: 'none',
            },
          },
        ],
      ]);
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([
          {
            id: 'rt-own',
            agentName: 'Owned_Agent',
            messageCount: 1,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivityAt: '2025-01-01T00:01:00Z',
            activeAgent: 'Owned_Agent',
            threadCount: 1,
          },
          {
            id: 'rt-other',
            agentName: 'Other_Agent',
            messageCount: 1,
            createdAt: '2025-01-01T00:02:00Z',
            lastActivityAt: '2025-01-01T00:03:00Z',
            activeAgent: 'Other_Agent',
            threadCount: 1,
          },
        ]),
        getSession: vi.fn((sessionId: string) => runtimeSessions.get(sessionId)),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe('rt-own');
    });

    test('respects limit and offset query params', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      await request('GET', `${BASE}?limit=10&offset=5`);

      // With no runtime-only sessions, pagination stays DB-bounded.
      expect(mockListSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          skip: 5,
          take: 10,
        }),
      );
    });

    test('uses exact DB pagination even when runtime-only sessions exist', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockCountSessions.mockResolvedValue(100);
      mockListSessions.mockResolvedValue([]);

      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          listSessions: vi.fn().mockReturnValue([
            {
              id: 'rt-live-1',
              agentName: 'Live_Agent',
              messageCount: 2,
              createdAt: '2025-01-01T00:00:00Z',
              lastActivityAt: '2025-01-01T00:01:00Z',
              activeAgent: 'Live_Agent',
              threadCount: 1,
            },
          ]),
          getSession: vi.fn().mockReturnValue({
            id: 'rt-live-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelType: 'web_debug',
          }),
        }),
      );
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      await request('GET', `${BASE}?limit=10&offset=5`);

      expect(mockListSessions).toHaveBeenCalledTimes(1);
      expect(mockListSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          skip: 5,
          take: 10,
        }),
      );
    });

    test('does not run persisted-runtime match queries for DB-backed lists', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockCountSessions.mockResolvedValue(5);
      mockListSessions.mockResolvedValue([]);

      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          listSessions: vi.fn().mockReturnValue([
            {
              id: 'rt-live-1',
              agentName: 'Live_Agent',
              messageCount: 2,
              createdAt: '2025-01-01T00:00:00Z',
              lastActivityAt: '2025-01-01T00:01:00Z',
              activeAgent: 'Live_Agent',
              threadCount: 1,
            },
          ]),
          getSession: vi.fn().mockReturnValue({
            id: 'rt-live-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelType: 'web_debug',
          }),
        }),
      );
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}?limit=10&offset=50`);

      expect(status).toBe(200);
      expect(body.total).toBe(5);
      expect(body.sessions).toHaveLength(0);
      expect(mockListSessions).toHaveBeenCalledTimes(1);
      expect(mockListSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          skip: 50,
          take: 10,
        }),
      );
    });

    test('handles RuntimeExecutor not initialized gracefully', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      mockGetRuntimeExecutor.mockImplementation(() => {
        throw new Error('Not initialized');
      });

      const { status, body } = await request('GET', BASE);

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(0);
    });
  });

  describe('GET /current and POST /attach (developer session recovery)', () => {
    test('returns the hottest owned runtime developer session with attached status', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      const runtimeSession = makeRuntimeDeveloperSession({
        id: 'runtime-current-1',
      });
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          listSessions: vi.fn().mockReturnValue([
            {
              id: 'runtime-current-1',
              agentName: 'Booking_Agent',
              messageCount: 2,
              createdAt: runtimeSession.createdAt.toISOString(),
              lastActivityAt: runtimeSession.lastActivityAt.toISOString(),
              activeAgent: 'Booking_Agent',
              threadCount: 1,
            },
          ]),
          getSession: vi
            .fn()
            .mockImplementation((sessionId: string) =>
              sessionId === 'runtime-current-1' ? runtimeSession : null,
            ),
        }),
      );
      mockGetSessionWebSocket.mockReturnValue({ readyState: 1, OPEN: 1 });

      const { status, body } = await request('GET', `${BASE}/current`);

      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        data: {
          identitySession: {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            userId: 'user-1',
            authType: 'user',
          },
          clientAttachment: {
            kind: 'studio_websocket',
            status: 'attached',
            channel: 'web_debug',
            resumable: true,
          },
          executionSession: {
            sessionId: 'runtime-current-1',
            projectId: 'proj-1',
            tenantId: 'tenant-1',
            agentName: 'Booking_Agent',
            channel: 'web_debug',
            source: 'runtime',
            state: 'running',
            createdAt: '2026-04-23T06:00:00.000Z',
            lastActivityAt: '2026-04-23T06:05:00.000Z',
          },
          resume: {
            sessionId: 'runtime-current-1',
            canResume: true,
            agent: {
              id: 'Booking_Agent',
              name: 'Booking_Agent',
              filePath: '',
              type: 'agent',
              mode: 'reasoning',
              toolCount: 0,
              gatherFieldCount: 0,
              isSupervisor: false,
              dsl: '',
            },
            messageCount: 2,
            lastActivityAt: '2026-04-23T06:05:00.000Z',
          },
        },
      });
    });

    test('rehydrates the latest detached cold execution session for current lookup', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      const runtimeSession = makeRuntimeDeveloperSession({
        id: 'cold-session-1',
        agentName: 'Cold_Agent',
        threads: [
          {
            agentName: 'Cold_Agent',
            conversationHistory: [{ role: 'user', content: 'resume me' }],
            state: {
              gatherProgress: {},
              conversationPhase: 'start',
              context: {},
            },
            data: {
              values: {},
              gatheredKeys: new Set<string>(),
            },
            startedAt: Date.now(),
            returnExpected: false,
            status: 'active',
          },
        ],
        conversationHistory: [{ role: 'user', content: 'resume me' }],
      });
      const rehydrateSession = vi.fn().mockResolvedValue(runtimeSession);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          listSessions: vi.fn().mockReturnValue([]),
          getSession: vi.fn().mockReturnValue(null),
          rehydrateSession,
        }),
      );
      mockSessionStateFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([
              {
                _id: 'cold-session-1',
                tenantId: 'tenant-1',
                projectId: 'proj-1',
                userId: 'user-1',
                channel: 'web_debug',
                agentName: 'Cold_Agent',
                lastActivityAt: new Date('2026-04-23T06:06:00.000Z'),
                createdAt: new Date('2026-04-23T06:00:00.000Z'),
              },
            ]),
          }),
        }),
      });

      const { status, body } = await request('GET', `${BASE}/current`);

      expect(status).toBe(200);
      expect(rehydrateSession).toHaveBeenCalledWith('cold-session-1', {
        locator: {
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: 'cold-session-1',
        },
      });
      expect(body.success).toBe(true);
      expect(body.data.executionSession.source).toBe('cold_state');
      expect(body.data.clientAttachment.status).toBe('detached');
      expect(body.data.executionSession.sessionId).toBe('cold-session-1');
      expect(body.data.resume.messageCount).toBe(1);
    });

    test('validates a specific attach target and returns 404 when it is no longer resumable', async () => {
      const rehydrateSession = vi.fn().mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          getSession: vi.fn().mockReturnValue(null),
          rehydrateSession,
        }),
      );

      const { status, body } = await request('POST', `${BASE}/attach`, {
        body: { sessionId: 'missing-session' },
      });

      expect(status).toBe(404);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found or no longer resumable',
        },
      });
      expect(rehydrateSession).toHaveBeenCalledWith('missing-session', {
        locator: {
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: 'missing-session',
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:id — session detail
  // ---------------------------------------------------------------------------
  describe('GET /:id (session detail)', () => {
    test('returns session from RuntimeExecutor when active', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: '2025-01-01T00:00:00Z' },
        ],
        traceEvents: [{ type: 'llm_call', timestamp: new Date().toISOString() }],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.agentName).toBe('Booking_Agent');
      expect(body.session.messages).toHaveLength(1);
    });

    test('hydrates active session traces from async trace stores', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: '2025-01-01T00:00:00Z' },
        ],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(
        makeTraceStore({
          getEvents: vi.fn().mockResolvedValue([
            {
              id: 'evt-1',
              sessionId: 'session-1',
              type: 'llm_call',
              timestamp: new Date('2025-01-01T00:00:01Z'),
              data: { model: 'gpt-4.1' },
            },
          ]),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.traceEvents).toHaveLength(1);
      expect(body.session.traceEvents[0]).toMatchObject({
        id: 'evt-1',
        type: 'llm_call',
      });
    });

    test('scrubs PII from historical session detail payloads before responding', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Card 4111 1111 1111 1111 belongs to jane.doe@example.com',
            contentEnvelope: {
              version: 2,
              format: 'message_envelope',
              text: 'Card 4111 1111 1111 1111 belongs to jane.doe@example.com',
            },
            timestamp: '2025-01-01T00:00:00Z',
          },
        ],
        traceEvents: [
          {
            id: 'evt-1',
            sessionId: 'session-1',
            type: 'llm_call',
            timestamp: new Date('2025-01-01T00:00:01Z'),
            data: {
              response: 'Card 4111 1111 1111 1111 belongs to jane.doe@example.com',
            },
          },
        ],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(200);
      const responseJson = JSON.stringify(body.session);
      expect(responseJson).not.toContain('4111 1111 1111 1111');
      expect(responseJson).not.toContain('jane.doe@example.com');
      expect(responseJson).toContain('[REDACTED_CARD]');
      expect(responseJson).toContain('[REDACTED_EMAIL]');
    });

    test('renders active custom-pattern PII through the session read boundary', async () => {
      const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'custom-contract-id',
          ['ContractID'],
          /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
          'ContractID',
          undefined,
          'custom',
        ),
      );
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: `Contract ${rawContractId}`,
            timestamp: '2025-01-01T00:00:00Z',
          },
        ],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };
      mockProjectPIIConfig({ patterns: [makeContractPIIPattern()] });

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
          piiVault: new PIIVault({ recognizerRegistry: registry }),
          piiRecognizerRegistry: registry,
          piiPatternConfigs: [
            {
              patternName: 'ContractID',
              defaultRenderMode: 'redacted',
              consumerAccess: [],
            },
          ],
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1?includeTraces=false`);

      expect(status).toBe(200);
      const responseJson = JSON.stringify(body.session);
      expect(responseJson).not.toContain(rawContractId);
      expect(responseJson).toContain('[REDACTED_CONTRACT_ID]');
    });

    test('rehydrates active session detail across pods before falling back to DB history', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'active', context: { stage: 'live' } },
        messages: [
          {
            id: 'msg-live-1',
            role: 'assistant',
            content: 'Still running',
            timestamp: '2025-01-01T00:00:00Z',
          },
        ],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      const traceStore = makeTraceStore({
        getEvents: vi.fn().mockResolvedValue([
          {
            id: 'evt-live-1',
            sessionId: 'session-1',
            type: 'llm_call',
            timestamp: new Date('2025-01-01T00:00:01Z'),
            data: { model: 'gpt-4.1' },
          },
        ]),
      });
      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValueOnce(null).mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue(null),
        rehydrateSession: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'session-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
        }),
      });

      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(
        makeDbSession({ id: 'db-session-1', runtimeSessionId: 'session-1' }),
      );
      mockFindMessagesForSession.mockResolvedValue([]);

      const { status, body } = await request('GET', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.state).toEqual({
        gatherProgress: {},
        conversationPhase: 'active',
        context: { stage: 'live' },
      });
      expect(body.session.traceEvents).toHaveLength(1);
      expect(executor.rehydrateSession).toHaveBeenCalledWith('db-session-1');
      expect(executor.rehydrateSession).toHaveBeenCalledWith('session-1');
      expect(traceStore.getEvents).toHaveBeenCalledWith('session-1', { tenantId: 'tenant-1' });
    });

    test('prefers persisted messages for active sessions when DB history is available', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [
          {
            id: 'msg-runtime-1',
            role: 'assistant',
            content: 'Fallback message',
            timestamp: '2025-01-01T00:00:00Z',
          },
        ],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockFindMessagesForSession.mockResolvedValue([
        {
          id: 'msg-db-1',
          role: 'assistant',
          content: 'Account summary',
          contentEnvelope: {
            version: 2,
            format: 'message_envelope',
            text: 'Account summary',
            richContent: { markdown: '| Name | Value |' },
          },
          timestamp: new Date('2025-01-01T00:00:00Z'),
        },
      ]);

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.messages).toEqual([
        {
          id: 'msg-db-1',
          role: 'assistant',
          content: 'Account summary',
          contentEnvelope: {
            version: 2,
            format: 'message_envelope',
            text: 'Account summary',
            richContent: { markdown: '| Name | Value |' },
          },
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ]);
      expect(mockFindMessagesForSession).toHaveBeenCalledWith('db-session-1', 200, 'tenant-1');
    });

    test('preserves message metadata when hydrating session detail from persisted history', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockFindMessagesForSession.mockResolvedValue([
        {
          id: 'msg-db-meta-1',
          role: 'assistant',
          content: 'Account summary',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
          timestamp: new Date('2025-01-01T00:00:00Z'),
        },
      ]);

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.messages).toEqual([
        {
          id: 'msg-db-meta-1',
          role: 'assistant',
          content: 'Account summary',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ]);
    });

    test('preserves fresher runtime-memory tail messages when persisted history is only a stale prefix', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [
          {
            id: 'msg-runtime-1',
            role: 'user',
            content: 'Show me my account',
            timestamp: '2025-01-01T00:00:00Z',
          },
          {
            id: 'msg-runtime-2',
            role: 'assistant',
            content: 'Latest in-memory answer',
            metadata: {
              isLlmGenerated: true,
              responseProvenance: {
                schemaVersion: 1,
                kind: 'llm',
                disclaimerRequired: true,
                usedLlmInternally: true,
              },
            },
            timestamp: '2025-01-01T00:00:10Z',
          },
        ],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockFindMessagesForSession.mockResolvedValue([
        {
          id: 'msg-db-1',
          role: 'user',
          content: 'Show me my account',
          timestamp: new Date('2025-01-01T00:00:00Z'),
        },
      ]);

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.messages).toEqual([
        {
          id: 'msg-db-1',
          role: 'user',
          content: 'Show me my account',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'msg-runtime-2',
          role: 'assistant',
          content: 'Latest in-memory answer',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
          timestamp: '2025-01-01T00:00:10Z',
        },
      ]);
    });

    test('merges persisted history head with an overlapping active runtime window', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        messages: [
          {
            id: 'msg-runtime-3',
            role: 'user',
            content: 'Show me my account',
            timestamp: '2025-01-01T00:00:20Z',
          },
          {
            id: 'msg-runtime-4',
            role: 'assistant',
            content: 'Latest in-memory answer',
            metadata: {
              isLlmGenerated: true,
              responseProvenance: {
                schemaVersion: 1,
                kind: 'llm',
                disclaimerRequired: true,
                usedLlmInternally: true,
              },
            },
            timestamp: '2025-01-01T00:00:30Z',
          },
        ],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockFindMessagesForSession.mockResolvedValue([
        {
          id: 'msg-db-1',
          role: 'user',
          content: 'Hi',
          timestamp: new Date('2025-01-01T00:00:00Z'),
        },
        {
          id: 'msg-db-2',
          role: 'assistant',
          content: 'Hello, how can I help?',
          timestamp: new Date('2025-01-01T00:00:10Z'),
        },
        {
          id: 'msg-db-3',
          role: 'user',
          content: 'Show me my account',
          timestamp: new Date('2025-01-01T00:00:20Z'),
        },
      ]);

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.messages).toEqual([
        {
          id: 'msg-db-1',
          role: 'user',
          content: 'Hi',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'msg-db-2',
          role: 'assistant',
          content: 'Hello, how can I help?',
          timestamp: '2025-01-01T00:00:10.000Z',
        },
        {
          id: 'msg-db-3',
          role: 'user',
          content: 'Show me my account',
          timestamp: '2025-01-01T00:00:20.000Z',
        },
        {
          id: 'msg-runtime-4',
          role: 'assistant',
          content: 'Latest in-memory answer',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
          timestamp: '2025-01-01T00:00:30Z',
        },
      ]);
    });

    test('falls back to DB when session not in RuntimeExecutor', async () => {
      const dbSession = makeDbSession();
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);
      mockFindMessagesForSession.mockResolvedValue([
        { id: 'msg-1', role: 'user', content: 'Hi', timestamp: new Date('2025-01-01T00:00:00Z') },
      ]);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.agentName).toBe('Booking_Agent');
      expect(body.session.messages).toHaveLength(1);
    });

    test('normalizes persisted currentAgent paths in session detail responses', async () => {
      const dbSession = makeDbSession({
        currentAgent: 'travel/Booking_Agent',
        entryAgentName: null,
      });
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);
      mockFindMessagesForSession.mockResolvedValue([
        { id: 'msg-1', role: 'user', content: 'Hi', timestamp: new Date('2025-01-01T00:00:00Z') },
      ]);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.agent.name).toBe('Booking_Agent');
      expect(body.session.agentName).toBe('Booking_Agent');
    });

    test('returns buffered traces for recently completed sessions before ClickHouse catches up', async () => {
      const traceStore = makeTraceStore({
        getEvents: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 'evt-buffered-1',
              sessionId: 'runtime-session-1',
              type: 'llm_call',
              timestamp: new Date('2025-01-01T00:00:01Z'),
              data: { model: 'gpt-4.1' },
            },
          ]),
      });

      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(traceStore);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(
        makeDbSession({
          id: 'db-session-1',
          runtimeSessionId: 'runtime-session-1',
          status: 'completed',
          endedAt: new Date('2025-01-01T00:01:00Z'),
        }),
      );
      mockFindMessagesForSession.mockResolvedValue([
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Finished',
          timestamp: new Date('2025-01-01T00:00:59Z'),
        },
      ]);

      const { status, body } = await request('GET', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.traceEvents).toHaveLength(1);
      expect(body.session.traceEvents[0]).toMatchObject({
        id: 'evt-buffered-1',
        type: 'llm_call',
      });
      expect(traceStore.getEvents).toHaveBeenNthCalledWith(1, 'db-session-1', {
        tenantId: 'tenant-1',
      });
      expect(traceStore.getEvents).toHaveBeenNthCalledWith(2, 'runtime-session-1', {
        tenantId: 'tenant-1',
      });
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('skips inline trace hydration when includeTraces=false', async () => {
      const dbSession = makeDbSession();
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);
      mockFindMessagesForSession.mockResolvedValue([
        { id: 'msg-1', role: 'user', content: 'Hi', timestamp: new Date('2025-01-01T00:00:00Z') },
      ]);

      const { status, body } = await request('GET', `${BASE}/db-session-1?includeTraces=false`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session.traceEvents).toEqual([]);
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('recovers historical ClickHouse traces when rows have blank event ids', async () => {
      const dbSession = makeDbSession();
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);
      mockFindMessagesForSession.mockResolvedValue([]);
      mockGetClickHouseClient.mockReturnValue({
        query: (...args: any[]) => mockClickHouseQuery(...args),
      });
      mockClickHouseQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce([
          {
            event_id: '',
            event_type: 'session.started',
            category: 'session',
            span_id: '',
            parent_span_id: '',
            agent_name: 'Booking_Agent',
            timestamp: '2026-03-22 10:00:00',
            duration_ms: 0,
            has_error: 0,
            data: JSON.stringify({ channel: 'web_debug' }),
            _enc: '',
          },
          {
            event_id: '',
            event_type: 'message.user.received',
            category: 'message',
            span_id: '',
            parent_span_id: '',
            agent_name: 'Booking_Agent',
            timestamp: '2026-03-22 10:00:01',
            duration_ms: 0,
            has_error: 0,
            data: JSON.stringify({ text: 'hello' }),
            _enc: '',
          },
          {
            event_id: '',
            event_type: 'message.user.received',
            category: 'message',
            span_id: '',
            parent_span_id: '',
            agent_name: 'Booking_Agent',
            timestamp: '2026-03-22 10:00:01',
            duration_ms: 0,
            has_error: 0,
            data: JSON.stringify({ text: 'hello' }),
            _enc: '',
          },
          {
            event_id: '',
            event_type: 'llm.call.completed',
            category: 'llm',
            span_id: 'span-1',
            parent_span_id: '',
            agent_name: 'Booking_Agent',
            timestamp: '2026-03-22 10:00:02',
            duration_ms: 123,
            has_error: 0,
            data: JSON.stringify({ model: 'gpt-4.1' }),
            _enc: '',
          },
        ]),
      });

      const { status, body } = await request('GET', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("'message'"),
          query_params: expect.objectContaining({
            sessionId: 'db-session-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
          }),
        }),
      );
      expect(body.session.traceEvents).toHaveLength(3);
      expect(body.session.traceEvents.map((event: { type: string }) => event.type)).toEqual([
        'session_created',
        'user_message',
        'llm_call',
      ]);
      const ids = body.session.traceEvents.map((event: { id: string }) => event.id);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(3);
    });

    test('returns 404 for nonexistent session', async () => {
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);

      const { status, body } = await request('GET', `${BASE}/nonexistent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('nonexistent');
    });

    test('enforces tenant isolation — rejects cross-tenant active session', async () => {
      const detail = {
        id: 'session-1',
        agentName: 'Booking_Agent',
        state: {},
        messages: [],
        traceEvents: [],
        threads: [],
        activeThreadIndex: 0,
        createdAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:01:00Z',
      };

      const executor = makeExecutor({
        getSessionDetail: vi.fn().mockReturnValue(detail),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-OTHER', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockIsDatabaseAvailable.mockReturnValue(false);

      const { status, body } = await request('GET', `${BASE}/session-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when DB lookups return null (tenant filter enforced at repo layer)', async () => {
      // The route trusts the repo to scope by tenantId; if the repo returns null
      // (as it does for cross-tenant IDs), the route returns 404.
      // Cross-tenant isolation at the query level is verified in repos-session.test.ts.
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);

      const { status, body } = await request('GET', `${BASE}/db-session-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:id/pii/reveal — audited raw PII reveal
  // ---------------------------------------------------------------------------
  describe('POST /:id/pii/reveal (admin PII reveal)', () => {
    test('returns 403 when exact sensitive reveal permission is missing', async () => {
      const rbac = await import('../../middleware/rbac.js');
      vi.mocked(rbac.requireSensitiveProjectPermission).mockImplementationOnce(
        async (_req, res) => {
          res.status(403).json({
            success: false,
            error: { code: 'SENSITIVE_PERMISSION_REQUIRED', message: 'Forbidden' },
            required: 'pii:reveal',
          });
          return false;
        },
      );

      const { status, body } = await request('POST', `${BASE}/db-session-1/pii/reveal`, {
        body: { reason: 'Compliance review', tokenIds: ['token-email'] },
      });

      expect(status).toBe(403);
      expect(body).toEqual({
        success: false,
        error: { code: 'SENSITIVE_PERMISSION_REQUIRED', message: 'Forbidden' },
        required: 'pii:reveal',
      });
      expect(mockFindSessionById).not.toHaveBeenCalled();
      expect(mockRevealPIITokens).not.toHaveBeenCalled();
    });

    test('returns 400 when reason is missing before revealing anything', async () => {
      const { status, body } = await request('POST', `${BASE}/db-session-1/pii/reveal`, {
        body: { tokenIds: ['token-email'] },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_PII_REVEAL_REQUEST');
      expect(mockFindSessionById).not.toHaveBeenCalled();
      expect(mockRevealPIITokens).not.toHaveBeenCalled();
    });

    test('returns non-leaky 404 for cross-project sessions', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ projectId: 'proj-OTHER' }));

      const { status, body } = await request('POST', `${BASE}/db-session-1/pii/reveal`, {
        body: { reason: 'Compliance review', tokenIds: ['token-email'] },
      });

      expect(status).toBe(404);
      expect(body).toEqual({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
      });
      expect(mockRevealPIITokens).not.toHaveBeenCalled();
    });

    test('reveals only selected token results through the audited reveal service', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockRevealPIITokens.mockResolvedValue({
        revealed: [
          {
            tokenId: 'token-email',
            token: '{{PII:email:token-email}}',
            piiType: 'email',
            patternName: 'email',
            value: 'alice@example.com',
            source: { surface: 'message', messageId: 'message-1' },
          },
        ],
        unavailable: [],
        auditLogCount: 1,
      });

      const { status, body } = await request('POST', `${BASE}/db-session-1/pii/reveal`, {
        body: {
          reason: 'Compliance review',
          ticketId: 'ABLP-535',
          tokenIds: ['token-email'],
        },
      });

      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        sessionId: 'db-session-1',
        revealed: [
          {
            tokenId: 'token-email',
            token: '{{PII:email:token-email}}',
            piiType: 'email',
            patternName: 'email',
            value: 'alice@example.com',
            source: { surface: 'message', messageId: 'message-1' },
          },
        ],
        unavailable: [],
        auditLogCount: 1,
      });
      expect(mockRevealPIITokens).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: 'db-session-1',
          tokenIds: ['token-email'],
          reason: 'Compliance review',
          ticketId: 'ABLP-535',
          actor: {
            actorId: 'user-1',
            authType: 'user',
            role: 'ADMIN',
          },
        }),
      );
    });

    test('expands selected message source refs into durable token ids without exposing raw message content', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockFindMessagesByIdsForSession.mockResolvedValue([
        {
          id: 'message-1',
          content: 'Card: {{PII:credit_card:11111111-1111-4111-8111-111111111111}}',
          contentEnvelope: {
            version: 2,
            format: 'text',
            text: 'Email {{PII:email:22222222-2222-4222-8222-222222222222}}',
          },
          rawContent: {
            text: 'Contract {{PII:custom_contract-id_contract-pattern:33333333-3333-4333-8333-333333333333}}',
          },
        },
      ]);

      const { status } = await request('POST', `${BASE}/db-session-1/pii/reveal`, {
        body: {
          reason: 'Compliance review',
          sourceRefs: [{ sourceMessageId: 'message-1' }],
        },
      });

      expect(status).toBe(200);
      expect(mockFindMessagesByIdsForSession).toHaveBeenCalledWith(
        'db-session-1',
        ['message-1'],
        'tenant-1',
        'proj-1',
      );
      const revealRequest = mockRevealPIITokens.mock.calls[0]?.[0];
      expect(revealRequest).toEqual(expect.objectContaining({ sourceRefs: [] }));
      expect(revealRequest.tokenIds).toEqual(
        expect.arrayContaining([
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
        ]),
      );
      expect(revealRequest.tokenIds).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id — delete session
  // ---------------------------------------------------------------------------
  describe('DELETE /:id (delete session)', () => {
    test('deletes active session from RuntimeExecutor', async () => {
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(false);

      const { status, body } = await request('DELETE', `${BASE}/session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Session deleted');
      expect(executor.endSession).toHaveBeenCalledWith('session-1');
      expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith('session-1', 'disconnect');
    });

    test('deletes session from DB when not in RuntimeExecutor', async () => {
      const dbSession = makeDbSession();
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);

      const { status, body } = await request('DELETE', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      // Route calls cascadeDeleteSession, not updateSession
      expect(mockCascadeDeleteSession).toHaveBeenCalledWith('db-session-1');
    });

    test('returns 404 when session not found anywhere', async () => {
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);

      const { status, body } = await request('DELETE', `${BASE}/nonexistent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('enforces tenant isolation on delete', async () => {
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-OTHER', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(false);

      const { status, body } = await request('DELETE', `${BASE}/session-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(executor.endSession).not.toHaveBeenCalled();
    });

    test('returns 404 when DB session belongs to a different project', async () => {
      // DB-path cross-project isolation: session.projectId !== req.params.projectId → 404
      const dbSession = makeDbSession({ projectId: 'proj-OTHER' });
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor()); // getSession returns null
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);

      const { status, body } = await request('DELETE', `${BASE}/db-session-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(mockCascadeDeleteSession).not.toHaveBeenCalled();
    });

    test('also cleans up RuntimeExecutor when deleting a DB-only session', async () => {
      const dbSession = makeDbSession();
      const executor = makeExecutor();
      const traceStore = makeTraceStore();
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);

      const { status } = await request('DELETE', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(executor.endSession).toHaveBeenCalledWith('db-session-1');
      expect(traceStore.removeSession).toHaveBeenCalledWith('db-session-1');
      expect(mockCascadeDeleteSession).toHaveBeenCalledWith('db-session-1');
      expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith('db-session-1', 'disconnect');
    });

    test('uses the repo compatibility helper when deleting a legacy persisted session', async () => {
      const dbSession = makeDbSession({ runtimeSessionId: 'legacy-runtime-session-1' });
      const executor = makeExecutor();
      const traceStore = makeTraceStore();
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);
      mockResolveStoredSessionCompatibilityId
        .mockReturnValueOnce('legacy-runtime-session-1')
        .mockReturnValueOnce('legacy-runtime-session-1');

      const { status, body } = await request('DELETE', `${BASE}/db-session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(executor.endSession).toHaveBeenCalledWith('legacy-runtime-session-1');
      expect(traceStore.removeSession).toHaveBeenCalledWith('legacy-runtime-session-1');
      expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith(
        'legacy-runtime-session-1',
        'disconnect',
      );
    });
  });

  describe('GET /:id/messages (cursor history)', () => {
    test('serves bounded runtime-backed history when no persisted DB session exists yet', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(null);

      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
        getSessionDetail: vi.fn().mockReturnValue({
          id: 'session-live-only',
          agentName: 'Booking_Agent',
          state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
          messages: [
            {
              id: 'msg-runtime-1',
              role: 'user',
              content: 'Hello',
              timestamp: '2025-01-01T00:00:00.000Z',
            },
            {
              id: 'msg-runtime-2',
              role: 'assistant',
              content: 'Live runtime reply',
              timestamp: '2025-01-01T00:00:05.000Z',
            },
          ],
          traceEvents: [],
          threads: [],
          activeThreadIndex: 0,
          createdAt: '2025-01-01T00:00:00.000Z',
          lastActivityAt: '2025-01-01T00:01:00.000Z',
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request(
        'GET',
        `${BASE}/session-live-only/messages?direction=asc`,
      );

      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        messages: [
          {
            id: 'msg-runtime-1',
            role: 'user',
            content: 'Hello',
            timestamp: '2025-01-01T00:00:00.000Z',
          },
          {
            id: 'msg-runtime-2',
            role: 'assistant',
            content: 'Live runtime reply',
            timestamp: '2025-01-01T00:00:05.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
    });

    test('merges a fresher runtime-memory suffix when cursor pagination sees only a stale persisted prefix', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockFindMessagesForSession.mockResolvedValue([
        {
          id: 'msg-db-1',
          role: 'user',
          content: 'Show me my account',
          timestamp: new Date('2025-01-01T00:00:00.000Z'),
        },
      ]);
      mockFindMessagesForSessionCursor.mockResolvedValue({
        messages: [
          {
            id: 'msg-db-1',
            role: 'user',
            content: 'Show me my account',
            timestamp: new Date('2025-01-01T00:00:00.000Z'),
          },
        ],
        nextCursor: null,
        hasMore: false,
      });

      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
        getSessionDetail: vi.fn().mockReturnValue({
          id: 'session-1',
          agentName: 'Booking_Agent',
          state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
          messages: [
            {
              id: 'msg-runtime-1',
              role: 'user',
              content: 'Show me my account',
              timestamp: '2025-01-01T00:00:00.000Z',
            },
            {
              id: 'msg-runtime-2',
              role: 'assistant',
              content: 'Latest in-memory answer',
              metadata: {
                isLlmGenerated: true,
                responseProvenance: {
                  schemaVersion: 1,
                  kind: 'llm',
                  disclaimerRequired: true,
                  usedLlmInternally: true,
                },
              },
              timestamp: '2025-01-01T00:00:10.000Z',
            },
          ],
          traceEvents: [],
          threads: [],
          activeThreadIndex: 0,
          createdAt: '2025-01-01T00:00:00.000Z',
          lastActivityAt: '2025-01-01T00:01:00.000Z',
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/session-1/messages?direction=asc`);

      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        messages: [
          {
            id: 'msg-db-1',
            role: 'user',
            content: 'Show me my account',
            timestamp: '2025-01-01T00:00:00.000Z',
          },
          {
            id: 'msg-runtime-2',
            role: 'assistant',
            content: 'Latest in-memory answer',
            metadata: {
              isLlmGenerated: true,
              responseProvenance: {
                schemaVersion: 1,
                kind: 'llm',
                disclaimerRequired: true,
                usedLlmInternally: true,
              },
            },
            timestamp: '2025-01-01T00:00:10.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
    });

    test('uses DB cursor pagination when the cursor is outside the active runtime merge window', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));

      const persistedMergeWindow = Array.from({ length: 200 }, (_, index) => {
        const messageNumber = index + 1;
        return {
          id: `msg-${String(messageNumber).padStart(3, '0')}`,
          role: messageNumber % 2 === 0 ? 'assistant' : 'user',
          content: `persisted message ${messageNumber}`,
          timestamp: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 60_000),
        };
      });

      mockFindMessagesForSession.mockResolvedValue(persistedMergeWindow);
      mockFindMessagesForSessionCursor.mockResolvedValue({
        messages: [
          {
            id: 'msg-226',
            role: 'assistant',
            content: 'older page after cursor',
            timestamp: new Date('2025-01-01T04:00:00.000Z'),
          },
        ],
        nextCursor: 'msg-226',
        hasMore: true,
      });

      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
        getSessionDetail: vi.fn().mockReturnValue({
          id: 'session-1',
          agentName: 'Booking_Agent',
          state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
          messages: [
            {
              id: 'msg-runtime-251',
              role: 'assistant',
              content: 'fresh active runtime tail',
              timestamp: '2025-01-01T04:10:00.000Z',
            },
          ],
          traceEvents: [],
          threads: [],
          activeThreadIndex: 0,
          createdAt: '2025-01-01T00:00:00.000Z',
          lastActivityAt: '2025-01-01T04:10:00.000Z',
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request(
        'GET',
        `${BASE}/session-1/messages?direction=asc&cursor=msg-225&limit=1`,
      );

      expect(status).toBe(200);
      expect(mockFindMessagesForSessionCursor).toHaveBeenCalledWith('db-session-1', 'tenant-1', {
        cursor: 'msg-225',
        limit: 1,
        direction: 'asc',
      });
      expect(body).toEqual({
        success: true,
        messages: [
          {
            id: 'msg-226',
            role: 'assistant',
            content: 'older page after cursor',
            timestamp: '2025-01-01T04:00:00.000Z',
          },
        ],
        nextCursor: 'msg-226',
        hasMore: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:id/traces — get traces
  // ---------------------------------------------------------------------------
  describe('GET /:id/traces (get traces)', () => {
    test('returns trace events for session', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      const events = [
        { id: 't1', sessionId: 's1', type: 'llm_call', timestamp: new Date(), data: {} },
        { id: 't2', sessionId: 's1', type: 'tool_call', timestamp: new Date(), data: {} },
      ];
      mockClickHouseEvents(events);

      const { status, body } = await request('GET', `${BASE}/s1/traces`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.traces).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    test('scrubs PII from trace route payloads before responding', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      mockClickHouseEvents([
        {
          id: 't1',
          sessionId: 's1',
          type: 'llm_call',
          timestamp: new Date(),
          data: {
            response: 'Email jane.doe@example.com with card 4111 1111 1111 1111',
          },
        },
      ]);

      const { status, body } = await request('GET', `${BASE}/s1/traces`);

      expect(status).toBe(200);
      const responseJson = JSON.stringify(body);
      expect(responseJson).not.toContain('jane.doe@example.com');
      expect(responseJson).not.toContain('4111 1111 1111 1111');
      expect(responseJson).toContain('[REDACTED_EMAIL]');
      expect(responseJson).toContain('[REDACTED_CARD]');
    });

    test('renders custom-pattern PII in trace payloads through the unified read boundary', async () => {
      const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'custom-contract-id',
          ['ContractID'],
          /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
          'ContractID',
          undefined,
          'custom',
        ),
      );
      mockFindSessionById.mockResolvedValue(null);
      mockProjectPIIConfig({ patterns: [makeContractPIIPattern()] });
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({
          id: 'live-session-custom-pii',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
          piiVault: new PIIVault({ recognizerRegistry: registry }),
          piiRecognizerRegistry: registry,
          piiPatternConfigs: [
            {
              patternName: 'ContractID',
              defaultRenderMode: 'redacted',
              consumerAccess: [],
            },
          ],
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(
        makeTraceStore({
          getEvents: vi.fn().mockResolvedValue([
            {
              id: 't1',
              sessionId: 'live-session-custom-pii',
              type: 'user_message',
              timestamp: new Date(),
              data: { message: `Contract ${rawContractId}` },
            },
          ]),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/live-session-custom-pii/traces`);

      expect(status).toBe(200);
      const responseJson = JSON.stringify(body);
      expect(responseJson).not.toContain(rawContractId);
      expect(responseJson).toContain('[REDACTED_CONTRACT_ID]');
    });

    test('honors disabled built-in recognizers in trace payloads with project PII context', async () => {
      const phoneNumber = '555-123-4567';
      const registry = new PIIRecognizerRegistry();
      registerBuiltInRecognizers(registry);
      registry.disableType('phone');
      mockFindSessionById.mockResolvedValue(null);
      mockProjectPIIConfig({
        patterns: [
          {
            _id: 'phone-override',
            name: 'phone',
            piiType: 'phone',
            builtinOverride: true,
            enabled: false,
            defaultRenderMode: 'redacted',
            consumerAccess: [],
          },
        ],
      });
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({
          id: 'live-session-disabled-phone',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
          piiVault: new PIIVault({ recognizerRegistry: registry }),
          piiRecognizerRegistry: registry,
          piiPatternConfigs: [
            {
              patternName: 'phone',
              defaultRenderMode: 'redacted',
              consumerAccess: [],
            },
          ],
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(
        makeTraceStore({
          getEvents: vi.fn().mockResolvedValue([
            {
              id: 't1',
              sessionId: 'live-session-disabled-phone',
              type: 'user_message',
              timestamp: new Date(),
              data: { message: `Call ${phoneNumber}` },
            },
          ]),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/live-session-disabled-phone/traces`);

      expect(status).toBe(200);
      const responseJson = JSON.stringify(body);
      expect(responseJson).toContain(phoneNumber);
      expect(responseJson).not.toContain('[REDACTED_PHONE]');
    });

    test('returns distributed trace buffer for active sessions rehydrated from another pod', async () => {
      mockFindSessionById.mockResolvedValue(
        makeDbSession({ id: 'db-session-1', runtimeSessionId: 'live-session-1', status: 'active' }),
      );
      const traceStore = makeTraceStore({
        getEvents: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 't1',
              sessionId: 'live-session-1',
              type: 'llm_call',
              timestamp: new Date('2025-01-01T00:00:00Z'),
              data: {},
            },
            {
              id: 't2',
              sessionId: 'live-session-1',
              type: 'tool_call',
              timestamp: new Date('2025-01-01T00:00:01Z'),
              data: {},
            },
          ]),
      });
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue(null),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);

      const { status, body } = await request('GET', `${BASE}/db-session-1/traces`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body._meta.source).toBe('memory');
      expect(body.traces).toHaveLength(2);
      expect(executor.rehydrateSession).not.toHaveBeenCalled();
      expect(traceStore.getEvents).toHaveBeenNthCalledWith(1, 'db-session-1', {
        tenantId: 'tenant-1',
      });
      expect(traceStore.getEvents).toHaveBeenNthCalledWith(2, 'live-session-1', {
        tenantId: 'tenant-1',
      });
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('merges durable traces when the distributed buffer is partial', async () => {
      mockFindSessionById.mockResolvedValue(
        makeDbSession({ id: 'db-session-1', runtimeSessionId: 'live-session-1', status: 'active' }),
      );
      const traceStore = makeTraceStore({
        getEvents: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 't-user',
              sessionId: 'live-session-1',
              type: 'user_message',
              timestamp: new Date('2025-01-01T00:00:00Z'),
              data: { message: 'hi' },
            },
          ]),
      });
      mockGetTraceStore.mockReturnValue(traceStore);
      mockClickHouseEvents([
        {
          id: 't-user',
          sessionId: 'db-session-1',
          type: 'user_message',
          timestamp: new Date('2025-01-01T00:00:00Z'),
          data: { message: 'hi' },
        },
        {
          id: 't-llm',
          sessionId: 'db-session-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T00:00:01Z'),
          data: { model: 'gpt-5.4' },
        },
      ]);

      const { status, body } = await request('GET', `${BASE}/db-session-1/traces`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body._meta).toEqual(
        expect.objectContaining({
          source: 'combined',
          source_chain: ['memory', 'clickhouse_platform_events'],
        }),
      );
      expect(body.traces.map((trace: { id: string }) => trace.id)).toEqual(['t-user', 't-llm']);
      expect(body.traces.map((trace: { type: string }) => trace.type)).toContain('llm_call');
      expect(mockClickHouseQuery).toHaveBeenCalled();
    });

    test('returns buffered traces for recently completed sessions before ClickHouse catches up', async () => {
      const traceStore = makeTraceStore({
        getEvents: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 't-buffered-1',
              sessionId: 'runtime-session-1',
              type: 'llm_call',
              timestamp: new Date('2025-01-01T00:00:00Z'),
              data: {},
            },
          ]),
      });

      mockFindSessionById.mockResolvedValue(
        makeDbSession({
          id: 'db-session-1',
          runtimeSessionId: 'runtime-session-1',
          status: 'completed',
          endedAt: new Date('2025-01-01T00:01:00Z'),
        }),
      );
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(traceStore);

      const { status, body } = await request('GET', `${BASE}/db-session-1/traces`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body._meta.source).toBe('memory');
      expect(body.traces).toHaveLength(1);
      expect(traceStore.getEvents).toHaveBeenNthCalledWith(1, 'db-session-1', {
        tenantId: 'tenant-1',
      });
      expect(traceStore.getEvents).toHaveBeenNthCalledWith(2, 'runtime-session-1', {
        tenantId: 'tenant-1',
      });
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('supports limit and offset pagination', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      const events = Array.from({ length: 5 }, (_, i) => ({
        id: `t${i}`,
        sessionId: 's1',
        type: 'llm_call',
        timestamp: new Date(),
        data: {},
      }));
      mockClickHouseEvents(events);

      const { status, body } = await request('GET', `${BASE}/s1/traces?limit=2&offset=1`);

      expect(status).toBe(200);
      expect(body.traces).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.offset).toBe(1);
      expect(body.limit).toBe(2);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('LIMIT {limit:UInt32} OFFSET {offset:UInt32}'),
          query_params: expect.objectContaining({
            projectId: 'proj-1',
            limit: 2,
            offset: 1,
          }),
        }),
      );
    });

    test('supports type filtering', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      const events = [
        { id: 't1', sessionId: 's1', type: 'llm_call', timestamp: new Date(), data: {} },
        { id: 't2', sessionId: 's1', type: 'tool_call', timestamp: new Date(), data: {} },
        { id: 't3', sessionId: 's1', type: 'error', timestamp: new Date(), data: {} },
      ];
      mockClickHouseEvents(events);

      const { status, body } = await request('GET', `${BASE}/s1/traces?types=llm_call,error`);

      expect(status).toBe(200);
      expect(body.traces).toHaveLength(2);
      // total reflects the post-type-filter count (type filter applied before total is computed;
      // contrast with pagination where total is computed before slice)
      expect(body.total).toBe(2);
      expect(
        mockClickHouseQuery.mock.calls.some(
          ([args]) =>
            Array.isArray(args?.query_params?.eventTypes) &&
            args.query_params.eventTypes.includes('llm_call') &&
            args.query_params.eventTypes.includes('error'),
        ),
      ).toBe(true);
    });

    test('replays generic durable runtime trace rows with their original event type', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      mockClickHouseEvents([
        {
          id: 't1',
          sessionId: 's1',
          type: 'completion_check',
          timestamp: new Date(),
          data: { result: 'complete' },
        },
        {
          id: 't2',
          sessionId: 's1',
          type: 'gather_field_activation',
          timestamp: new Date(),
          data: { field: 'customer_id' },
        },
      ]);

      const { status, body } = await request('GET', `${BASE}/s1/traces?types=completion_check`);

      expect(status).toBe(200);
      expect(body.traces).toHaveLength(1);
      expect(body.traces[0].type).toBe('completion_check');
      expect(body.traces[0].data).toEqual(
        expect.objectContaining({
          [RUNTIME_TRACE_TYPE_DATA_KEY]: 'completion_check',
          result: 'complete',
        }),
      );
      expect(body._meta).toEqual(
        expect.objectContaining({
          source: 'clickhouse_platform_events',
          source_chain: ['memory', 'clickhouse_platform_events'],
          loaded_count: 1,
          available_count: 1,
        }),
      );
      expect(
        mockClickHouseQuery.mock.calls.some(
          ([args]) =>
            Array.isArray(args?.query_params?.runtimeAtomicTraceTypes) &&
            args.query_params.runtimeAtomicTraceTypes.includes('completion_check'),
        ),
      ).toBe(true);
    });

    test('surfaces trace source diagnostics when live buffer lookup fails', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      mockGetTraceStore.mockReturnValue(
        makeTraceStore({
          getEvents: vi.fn().mockRejectedValue(new Error('redis unavailable')),
        }),
      );
      mockClickHouseEvents([
        { id: 't1', sessionId: 's1', type: 'llm_call', timestamp: new Date(), data: {} },
      ]);

      const { status, body } = await request('GET', `${BASE}/s1/traces`);

      expect(status).toBe(200);
      expect(body.traces).toHaveLength(1);
      expect(body._meta).toEqual(
        expect.objectContaining({
          source: 'clickhouse_platform_events',
          source_chain: ['memory', 'clickhouse_platform_events'],
          warnings: [
            expect.objectContaining({
              source: 'memory',
              code: 'TRACE_BUFFER_LOOKUP_FAILED',
            }),
          ],
        }),
      );
    });

    test('pushes spanId filtering down into ClickHouse queries', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      const events = [
        {
          id: 'root',
          sessionId: 's1',
          type: 'agent_enter',
          timestamp: new Date(),
          data: {},
          spanId: 'span-root',
        },
        {
          id: 'leaf',
          sessionId: 's1',
          type: 'tool_call',
          timestamp: new Date(),
          data: {},
          spanId: 'span-leaf',
        },
      ];
      mockClickHouseEvents(events);

      const { status, body } = await request('GET', `${BASE}/s1/traces?spanId=span-leaf`);

      expect(status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.traces).toHaveLength(1);
      expect(body.traces[0].spanId).toBe('span-leaf');
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('span_id = {spanId:String}'),
          query_params: expect.objectContaining({
            spanId: 'span-leaf',
          }),
        }),
      );
    });

    test('returns empty array when no traces exist for a verified stored session', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockGetTraceStore.mockReturnValue(makeTraceStore());

      const { status, body } = await request('GET', `${BASE}/db-session-1/traces`);

      expect(status).toBe(200);
      expect(body.traces).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    test('returns 404 when the session cannot be authorized through DB or Runtime', async () => {
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());

      const { status, body } = await request('GET', `${BASE}/unknown/traces`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    test('fails closed when the stored session has no projectId', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ projectId: undefined }));

      const { status, body } = await request('GET', `${BASE}/db-session-1/traces`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('queries ClickHouse with the canonical stored session id', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockClickHouseEvents([]);

      const { status } = await request('GET', `${BASE}/db-session-1/traces`);

      expect(status).toBe(200);
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: expect.objectContaining({
            sessionId: 'db-session-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
          }),
        }),
      );
    });

    test('returns 404 instead of falling back to an active runtime session for SDK callers', async () => {
      requestTenantContext = {
        tenantId: 'tenant-1',
        userId: 'sdk-session-a',
        permissions: ['session:read'],
        authType: 'sdk_session',
        role: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'proj-1',
        channelId: 'channel-1',
        sessionPrincipal: 'sdk-session-a',
        authScope: 'session',
      };
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          getSession: vi.fn().mockReturnValue({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            id: 'live-session-sdk-1',
          }),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/live-session-sdk-1/traces`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('returns 404 instead of falling back to an active runtime session for non-elevated user callers', async () => {
      requestTenantContext = {
        ...DEFAULT_TENANT_CONTEXT,
        role: 'MEMBER',
      };
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          getSession: vi.fn().mockReturnValue({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            id: 'live-session-user-1',
          }),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/live-session-user-1/traces`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id/traces/:spanId/children', () => {
    test('queries ClickHouse with parentSpanId instead of filtering full session traces in memory', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      mockClickHouseEvents([
        {
          id: 'child-1',
          sessionId: 's1',
          type: 'tool_call',
          timestamp: new Date(),
          data: {},
          parentSpanId: 'span-parent',
        },
        {
          id: 'child-2',
          sessionId: 's1',
          type: 'tool_call',
          timestamp: new Date(),
          data: {},
          parentSpanId: 'span-other',
        },
      ]);

      const { status, body } = await request('GET', `${BASE}/s1/traces/span-parent/children`);

      expect(status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.children).toHaveLength(1);
      expect(body.children[0].id).toBe('child-1');
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('parent_span_id = {parentSpanId:String}'),
          query_params: expect.objectContaining({
            projectId: 'proj-1',
            parentSpanId: 'span-parent',
          }),
        }),
      );
    });
  });

  describe('GET /:id/metrics', () => {
    test('counts all trace events while fetching only metric-relevant events from ClickHouse', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 's1', runtimeSessionId: 's1' }));
      mockClickHouseEvents([
        {
          id: 'llm-1',
          sessionId: 's1',
          type: 'llm_call',
          timestamp: new Date(),
          data: { tokensIn: 10, tokensOut: 20, cost: 0.123456, latencyMs: 45 },
        },
        {
          id: 'tool-1',
          sessionId: 's1',
          type: 'tool_call',
          timestamp: new Date(),
          data: { latencyMs: 15 },
        },
        {
          id: 'handoff-1',
          sessionId: 's1',
          type: 'handoff',
          timestamp: new Date(),
          data: {},
        },
      ]);

      const { status, body } = await request('GET', `${BASE}/s1/metrics`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.metrics.totalEvents).toBe(3);
      expect(body.metrics.totalLLMCalls).toBe(1);
      expect(body.metrics.totalToolCalls).toBe(1);
      expect(body.metrics.totalTokensIn).toBe(10);
      expect(body.metrics.totalTokensOut).toBe(20);
      expect(body.metrics.totalDurationMs).toBe(60);
      expect(
        mockClickHouseQuery.mock.calls.some(
          ([args]) =>
            Array.isArray(args?.query_params?.eventTypes) &&
            args.query_params.eventTypes.includes('llm_call') &&
            args.query_params.eventTypes.includes('tool_call') &&
            args.query_params.eventTypes.includes('error'),
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /export — export traces
  // ---------------------------------------------------------------------------
  describe('GET /export (export traces)', () => {
    test('queries export traces with the canonical stored session id', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockClickHouseEvents([
        {
          id: 'evt-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T00:00:00Z'),
          data: { value: 'ok' },
        },
      ]);

      const { status, text, headers } = await requestText(
        'GET',
        `${BASE}/export?sessionIds=db-session-1`,
      );

      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('text/csv');
      expect(text).toContain('evt-1');
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: expect.objectContaining({
            sessionId: 'db-session-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
          }),
        }),
      );
    });

    test('skips sessions that fail SDK ownership checks', async () => {
      requestTenantContext = {
        tenantId: 'tenant-1',
        userId: 'sdk-session-a',
        permissions: ['session:read'],
        authType: 'sdk_session',
        role: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'proj-1',
        channelId: 'channel-1',
        sessionPrincipal: 'sdk-session-a',
        authScope: 'session',
      };
      mockFindSessionById.mockResolvedValue(
        makeDbSession({
          id: 'db-session-2',
          runtimeSessionId: 'runtime-session-88',
          anonymousId: 'sdk-session-b',
          channelId: 'channel-1',
          initiatedById: null,
        }),
      );
      mockClickHouseEvents([
        {
          id: 'evt-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T00:00:00Z'),
          data: { value: 'blocked' },
        },
      ]);

      const { status, text } = await requestText('GET', `${BASE}/export?sessionIds=db-session-2`);

      expect(status).toBe(200);
      expect(text).not.toContain('evt-1');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('does not fall back to active runtime sessions for SDK callers without DB-backed ownership proof', async () => {
      requestTenantContext = {
        tenantId: 'tenant-1',
        userId: 'sdk-session-a',
        permissions: ['session:read'],
        authType: 'sdk_session',
        role: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'proj-1',
        channelId: 'channel-1',
        sessionPrincipal: 'sdk-session-a',
        authScope: 'session',
      };
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          getSession: vi
            .fn()
            .mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1', id: 'live-session-1' }),
        }),
      );
      mockClickHouseEvents([
        {
          id: 'evt-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T00:00:00Z'),
          data: { value: 'blocked' },
        },
      ]);

      const { status, text } = await requestText('GET', `${BASE}/export?sessionIds=live-session-1`);

      expect(status).toBe(200);
      expect(text).not.toContain('evt-1');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('does not fall back to active runtime sessions for non-elevated user callers without DB-backed ownership proof', async () => {
      requestTenantContext = {
        ...DEFAULT_TENANT_CONTEXT,
        role: 'MEMBER',
      };
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          getSession: vi.fn().mockReturnValue({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            id: 'live-session-user-2',
          }),
        }),
      );
      mockClickHouseEvents([
        {
          id: 'evt-2',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T00:00:00Z'),
          data: { value: 'blocked-user' },
        },
      ]);

      const { status, text } = await requestText(
        'GET',
        `${BASE}/export?sessionIds=live-session-user-2`,
      );

      expect(status).toBe(200);
      expect(text).not.toContain('evt-2');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /generations — generation events
  // ---------------------------------------------------------------------------
  describe('GET /generations', () => {
    test('uses the canonical stored session id for explicit session filters', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ id: 'db-session-1' }));
      mockClickHouseEvents([
        {
          id: 'gen-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T00:00:00Z'),
          data: {
            model: 'gpt-test',
            tokensIn: 12,
            tokensOut: 24,
            latencyMs: 150,
            cost: 0.01,
          },
        },
      ]);

      const { status, body } = await request('GET', `${BASE}/generations?sessionId=db-session-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.generations).toHaveLength(1);
      expect(body.generations[0].sessionId).toBe('db-session-1');
      expect(mockClickHouseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: expect.objectContaining({
            sessionId: 'db-session-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
          }),
        }),
      );
    });

    test('returns 404 for explicit session filters when the stored session lacks project scope', async () => {
      mockFindSessionById.mockResolvedValue(makeDbSession({ projectId: undefined }));

      const { status, body } = await request('GET', `${BASE}/generations?sessionId=db-session-1`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('returns 404 for explicit session filters that fail SDK ownership checks', async () => {
      requestTenantContext = {
        tenantId: 'tenant-1',
        userId: 'sdk-session-a',
        permissions: ['session:read'],
        authType: 'sdk_session',
        role: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'proj-1',
        channelId: 'channel-1',
        sessionPrincipal: 'sdk-session-a',
        authScope: 'session',
      };
      mockFindSessionById.mockResolvedValue(
        makeDbSession({
          id: 'db-session-3',
          anonymousId: 'sdk-session-b',
          channelId: 'channel-1',
          initiatedById: null,
        }),
      );

      const { status, body } = await request('GET', `${BASE}/generations?sessionId=db-session-3`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('returns 404 instead of falling back to an active runtime session for SDK callers', async () => {
      requestTenantContext = {
        tenantId: 'tenant-1',
        userId: 'sdk-session-a',
        permissions: ['session:read'],
        authType: 'sdk_session',
        role: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'proj-1',
        channelId: 'channel-1',
        sessionPrincipal: 'sdk-session-a',
        authScope: 'session',
      };
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          getSession: vi
            .fn()
            .mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1', id: 'live-session-2' }),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/generations?sessionId=live-session-2`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });

    test('returns 404 instead of falling back to an active runtime session for non-elevated user callers', async () => {
      requestTenantContext = {
        ...DEFAULT_TENANT_CONTEXT,
        role: 'MEMBER',
      };
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);
      mockGetRuntimeExecutor.mockReturnValue(
        makeExecutor({
          getSession: vi.fn().mockReturnValue({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            id: 'live-session-user-3',
          }),
        }),
      );

      const { status, body } = await request(
        'GET',
        `${BASE}/generations?sessionId=live-session-user-3`,
      );

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(mockClickHouseQuery).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:id/analysis — session analysis
  // ---------------------------------------------------------------------------
  describe('GET /:id/analysis (session analysis)', () => {
    test('returns analysis for active session', async () => {
      const session = {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        state: { gatherProgress: {}, conversationPhase: 'gathering', context: {} },
        agentIR: undefined,
      };
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue(session),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      const events = [
        {
          id: 't1',
          sessionId: 's1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T00:00:00Z'),
          data: {},
        },
        {
          id: 't2',
          sessionId: 's1',
          type: 'tool_call',
          timestamp: new Date('2025-01-01T00:00:05Z'),
          data: {},
        },
      ];
      mockGetTraceStore.mockReturnValue(
        makeTraceStore({
          getEvents: vi.fn().mockReturnValue(events),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/s1/analysis`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.analysis.summary.totalEvents).toBe(2);
      expect(body.analysis.summary.llmCalls).toBe(1);
      expect(body.analysis.summary.toolCalls).toBe(1);
    });

    test('returns 404 when session not found for analysis', async () => {
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());

      const { status, body } = await request('GET', `${BASE}/nonexistent/analysis`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('nonexistent');
    });

    test('returns 404 when session belongs to a different project', async () => {
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-OTHER' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      const { status, body } = await request('GET', `${BASE}/s1/analysis`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('detects errors in traces', async () => {
      const session = {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        agentIR: undefined,
      };
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue(session),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      const events = [
        {
          id: 't1',
          sessionId: 's1',
          type: 'error',
          timestamp: new Date(),
          data: { message: 'LLM timeout' },
        },
      ];
      mockGetTraceStore.mockReturnValue(
        makeTraceStore({
          getEvents: vi.fn().mockReturnValue(events),
        }),
      );

      const { status, body } = await request('GET', `${BASE}/s1/analysis`);

      expect(status).toBe(200);
      expect(body.analysis.summary.errors).toBe(1);
      expect(body.analysis.issues.length).toBeGreaterThan(0);
      expect(body.analysis.issues[0].type).toBe('error');
      expect(body.analysis.issues[0].description).toContain('LLM timeout');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:id/agent-spec — get agent specification
  // ---------------------------------------------------------------------------
  describe('GET /:id/agent-spec (agent specification)', () => {
    test('returns agent spec from DB when available', async () => {
      const session = {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        agentName: 'Booking_Agent',
        agentIR: { name: 'Booking_Agent' },
        threads: [{ agentName: 'Booking_Agent' }],
      };
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue(session),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectAgentByName.mockResolvedValue({
        name: 'Booking_Agent',
        dslContent: 'AGENT: Booking_Agent',
      });
      mockBuildAgentDetails.mockReturnValue({
        id: 'booking-agent',
        name: 'Booking_Agent',
        type: 'scripted',
        mode: 'flow',
        dsl: 'AGENT: Booking_Agent',
        ir: {},
        toolCount: 2,
        gatherFieldCount: 3,
      });

      const { status, body } = await request('GET', `${BASE}/session-1/agent-spec`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.agent.name).toBe('Booking_Agent');
      expect(body.agent.toolCount).toBe(2);
    });

    test('returns agent IR when DB record is not found', async () => {
      const session = {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        agentName: 'Test_Agent',
        agentIR: { name: 'Test_Agent', type: 'reasoning' },
        threads: [{ agentName: 'Test_Agent' }],
      };
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue(session),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectAgentByName.mockResolvedValue(null);

      const { status, body } = await request('GET', `${BASE}/session-1/agent-spec`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.agent.name).toBe('Test_Agent');
      expect(body.agent.ir).toBeDefined();
    });

    test('returns pinned historical agent spec from stored agent version', async () => {
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue({
        id: 'session-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        currentAgent: 'travel/Booking_Agent',
        agentVersion: '2.1.0',
      });
      mockFindProjectAgentByName.mockResolvedValue({
        _id: 'agent-db-1',
        name: 'Booking_Agent',
        dslContent: 'AGENT: Booking_Agent\nMODE: reasoning',
      });
      mockFindAgentVersion.mockResolvedValue({
        version: '2.1.0',
        dslContent: 'AGENT: Booking_Agent\nMODE: scripted',
        irContent: JSON.stringify({
          entry_agent: 'Booking_Agent',
          agents: {
            Booking_Agent: { metadata: { name: 'Booking_Agent' }, mode: 'scripted' },
          },
        }),
      });
      mockBuildAgentDetails.mockReturnValue({
        id: 'booking-agent',
        name: 'Booking_Agent',
        type: 'agent',
        mode: 'scripted',
        dsl: 'AGENT: Booking_Agent\nMODE: scripted',
        ir: { metadata: { name: 'Booking_Agent' }, mode: 'reasoning' },
        toolCount: 1,
        gatherFieldCount: 0,
        isSupervisor: false,
      });

      const { status, body } = await request('GET', `${BASE}/session-1/agent-spec`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.agent.name).toBe('Booking_Agent');
      expect(body.agent.mode).toBe('scripted');
      expect(body.agent.ir).toEqual({ metadata: { name: 'Booking_Agent' }, mode: 'scripted' });
      expect(mockFindProjectAgentByName).toHaveBeenCalledWith('Booking_Agent', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });
      expect(mockFindAgentVersion).toHaveBeenCalledWith('agent-db-1', '2.1.0', 'tenant-1');
    });

    test('returns only agent identity when stored version is unavailable', async () => {
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue({
        id: 'session-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        currentAgent: 'Booking_Agent',
        agentVersion: '9.9.9',
      });
      mockFindProjectAgentByName.mockResolvedValue({
        _id: 'agent-db-1',
        name: 'Booking_Agent',
        dslContent: 'AGENT: Booking_Agent\nMODE: reasoning',
      });
      mockFindAgentVersion.mockResolvedValue(null);

      const { status, body } = await request('GET', `${BASE}/session-1/agent-spec`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.agent.name).toBe('Booking_Agent');
      expect(body.agent.mode).toBeUndefined();
      expect(body.agent.dsl).toBeUndefined();
      expect(body.agent.ir).toBeUndefined();
      expect(mockFindAgentVersion).toHaveBeenCalledWith('agent-db-1', '9.9.9', 'tenant-1');
      expect(mockBuildAgentDetails).not.toHaveBeenCalled();
    });

    test('returns 404 when session not found', async () => {
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindStoredSessionByAnyId.mockResolvedValue(null);

      const { status, body } = await request('GET', `${BASE}/nonexistent/agent-spec`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // POST / — create session
  // ---------------------------------------------------------------------------
  describe('POST / (create session)', () => {
    test('returns 400 when agentId is missing', async () => {
      const { status, body } = await request('POST', BASE, { body: {} });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('agentId');
    });

    test('returns 404 when agent not found in DB', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectAgentByPath.mockResolvedValue(null);
      mockFindProjectAgentByName.mockResolvedValue(null);

      const { status, body } = await request('POST', BASE, { body: { agentId: 'unknown/agent' } });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('unknown/agent');
    });

    test('returns 201 with session on success', async () => {
      const fakeSession = {
        id: 'test-session-id',
        agent: { id: 'booking/agent', name: 'Booking_Agent' },
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectAgentByPath.mockResolvedValue({
        dslContent: 'AGENT: Booking_Agent',
        name: 'Booking_Agent',
      });
      mockBuildAgentDetails.mockReturnValue({ id: 'booking/agent', name: 'Booking_Agent' });
      const { TestSessionService } = await import('../../services/test-session.js');
      vi.mocked(TestSessionService.createSession).mockReturnValue(fakeSession as any);

      const { status, body } = await request('POST', BASE, { body: { agentId: 'booking/agent' } });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.session.id).toBe('test-session-id');
      expect(body.session.agentId).toBe('booking/agent');
      expect(body.session.agentName).toBe('Booking_Agent');
      expect(body.session.createdAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /bulk-close — bulk close sessions
  // ---------------------------------------------------------------------------
  describe('POST /bulk-close (bulk close)', () => {
    test('closes matching RuntimeExecutor sessions', async () => {
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([{ id: 'rt-1', agentName: 'Booking_Agent' }]),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(false);

      const { status, body } = await request('POST', `${BASE}/bulk-close`, {
        body: { projectId: 'proj-1' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.closedRuntime).toBe(1);
      expect(executor.endSession).toHaveBeenCalledWith('rt-1');
      expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith('rt-1', 'disconnect');
    });

    test('skips sessions belonging to different tenant', async () => {
      const executor = makeExecutor({
        listSessions: vi.fn().mockReturnValue([{ id: 'rt-1', agentName: 'Booking_Agent' }]),
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-OTHER', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(false);

      const { status, body } = await request('POST', `${BASE}/bulk-close`, {
        body: { projectId: 'proj-1' },
      });

      expect(status).toBe(200);
      expect(body.closedRuntime).toBe(0);
      expect(executor.endSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /cleanup-orphans', () => {
    test('keeps recent or artifact-backed zero-counter sessions out of orphan cleanup', async () => {
      const now = Date.now();
      const orphanCandidates = [
        makeDbSession({
          id: 'old-orphan',
          _id: 'old-orphan',
          status: 'active',
          messageCount: 0,
          traceEventCount: 0,
          tokenCount: 0,
          errorCount: 0,
          handoffCount: 0,
          startedAt: new Date(now - 20 * 60_000),
        }),
        makeDbSession({
          id: 'old-with-message',
          _id: 'old-with-message',
          status: 'idle',
          messageCount: 0,
          traceEventCount: 0,
          tokenCount: 0,
          errorCount: 0,
          handoffCount: 0,
          startedAt: new Date(now - 20 * 60_000),
        }),
        makeDbSession({
          id: 'old-with-attachment',
          _id: 'old-with-attachment',
          status: 'active',
          messageCount: 0,
          traceEventCount: 0,
          tokenCount: 0,
          errorCount: 0,
          handoffCount: 0,
          startedAt: new Date(now - 20 * 60_000),
        }),
        makeDbSession({
          id: 'recent-zero-counter',
          _id: 'recent-zero-counter',
          status: 'active',
          messageCount: 0,
          traceEventCount: 0,
          tokenCount: 0,
          errorCount: 0,
          handoffCount: 0,
          startedAt: new Date(now - 60_000),
        }),
      ];

      mockIsDatabaseAvailable.mockReturnValue(true);
      mockSessionModelFind.mockImplementation((where: Record<string, unknown>) =>
        makeFindQuery(
          orphanCandidates.filter((candidate) => matchesSessionFilter(candidate, where)),
        ),
      );
      mockMessageDistinct.mockResolvedValue(['old-with-message']);
      mockAttachmentDistinct.mockResolvedValue(['old-with-attachment']);

      const { status, body } = await request('POST', `${BASE}/cleanup-orphans?dryRun=true`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.dryRun).toBe(true);
      expect(body.orphanCount).toBe(1);
      expect(body.orphans.map((orphan: { id: string }) => orphan.id)).toEqual(['old-orphan']);

      const orphanFilter = mockSessionModelFind.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(orphanFilter.startedAt).toEqual({ $lt: expect.any(Date) });
      expect(mockMessageDistinct).toHaveBeenCalledWith(
        'sessionId',
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: { $in: ['old-orphan', 'old-with-message', 'old-with-attachment'] },
        }),
      );
      expect(mockCascadeDeleteSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:id/close — close session with disposition
  // ---------------------------------------------------------------------------
  describe('POST /:id/close (close with disposition)', () => {
    test('returns 400 for invalid disposition', async () => {
      const { status, body } = await request('POST', `${BASE}/session-1/close`, {
        body: { disposition: 'invalid' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('disposition');
    });

    test('closes session with valid disposition', async () => {
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-1' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(false);

      const { status, body } = await request('POST', `${BASE}/session-1/close`, {
        body: { disposition: 'completed' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.disposition).toBe('completed');
      expect(body.status).toBe('completed');
      expect(executor.endSession).toHaveBeenCalledWith('session-1');
      expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith('session-1', 'disconnect');
    });

    test('closes a persisted session using the canonical stored session id for cleanup', async () => {
      const dbSession = makeDbSession();
      const executor = makeExecutor();
      const traceStore = makeTraceStore();
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);

      const { status, body } = await request('POST', `${BASE}/db-session-1/close`, {
        body: { disposition: 'completed' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(executor.endSession).toHaveBeenCalledWith('db-session-1');
      expect(mockUpdateSession).toHaveBeenCalledWith(
        'db-session-1',
        expect.objectContaining({
          status: 'completed',
          disposition: 'completed',
          endedAt: expect.any(Date),
          lastActivityAt: expect.any(Date),
        }),
        'tenant-1',
      );
      expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith('db-session-1', 'disconnect');
      expect(traceStore.removeSession).toHaveBeenCalledWith('db-session-1');
    });

    test('uses the repo compatibility helper when closing a legacy persisted session', async () => {
      const dbSession = makeDbSession({ runtimeSessionId: 'legacy-runtime-session-2' });
      const executor = makeExecutor();
      const traceStore = makeTraceStore();
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(dbSession);
      mockResolveStoredSessionCompatibilityId
        .mockReturnValueOnce('legacy-runtime-session-2')
        .mockReturnValueOnce('legacy-runtime-session-2');

      const { status, body } = await request('POST', `${BASE}/db-session-1/close`, {
        body: { disposition: 'completed' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(executor.endSession).toHaveBeenCalledWith('legacy-runtime-session-2');
      expect(traceStore.removeSession).toHaveBeenCalledWith('legacy-runtime-session-2');
      expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith(
        'legacy-runtime-session-2',
        'disconnect',
      );
    });

    test('returns 404 when session not found anywhere', async () => {
      mockGetRuntimeExecutor.mockReturnValue(makeExecutor());
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSessionById.mockResolvedValue(null);
      mockFindSessionByRuntimeId.mockResolvedValue(null);

      const { status, body } = await request('POST', `${BASE}/nonexistent/close`, {
        body: { disposition: 'abandoned' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 404 when session belongs to a different project', async () => {
      // Close handler has a cross-project isolation check for in-memory sessions
      const executor = makeExecutor({
        getSession: vi.fn().mockReturnValue({ tenantId: 'tenant-1', projectId: 'proj-OTHER' }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(makeTraceStore());
      mockIsDatabaseAvailable.mockReturnValue(false);

      const { status, body } = await request('POST', `${BASE}/session-1/close`, {
        body: { disposition: 'completed' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(executor.endSession).not.toHaveBeenCalled();
    });
  });
});
