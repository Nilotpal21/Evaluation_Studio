/**
 * Platform Admin Traces API Tests
 *
 * Verifies cross-tenant trace inspection endpoints for platform admins.
 *
 * Covers:
 * 1. GET /search — cross-tenant trace search with filters
 * 2. GET /:traceId — trace detail with safe columns only (no PII)
 * 3. GET /:traceId/performance — STI path-level performance
 * 4. GET /:traceId/cost — LLM cost breakdown
 * 5. GET /sessions/:sessionId/summary — session metadata without content
 * 6. Data boundary: data, error_message, metadata, actor_id never exposed
 * 7. Audit logging on every lookup
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => {
    _req.tenantContext = {
      userId: 'admin-user-1',
      tenantId: 'admin-tenant',
      isSuperAdmin: true,
      permissions: [],
    };
    next();
  },
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

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: () => 'test-req-id',
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({ security: { platformAdminAllowedIps: [] } }),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockWriteAuditLog = vi.fn();
vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
}));

// Mock ClickHouse client
const mockQuery = vi.fn();
const mockGetClickHouseClient = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => mockGetClickHouseClient(),
}));

// Mock database models
const mockTenantFindOne = vi.fn();
const mockSessionModelFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  Tenant: {
    findOne: (...args: any[]) => mockTenantFindOne(...args),
  },
  Session: {
    findOne: (...args: any[]) => mockSessionModelFindOne(...args),
  },
}));

// Mock session repo
const mockFindSessionById = vi.fn();
const mockFindSessionSummaryByAnyId = vi.fn();
vi.mock('../repos/session-repo.js', () => ({
  findSessionById: (...args: any[]) => mockFindSessionById(...args),
  findSessionSummaryByAnyId: (...args: any[]) => mockFindSessionSummaryByAnyId(...args),
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import platformAdminTracesRouter from '../routes/platform-admin-traces.js';

// =============================================================================
// Helpers
// =============================================================================

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/admin/traces', platformAdminTracesRouter);
  return app;
}

function mockClickHouseResult(rows: any[]) {
  return {
    json: async () => rows,
    text: async () => JSON.stringify(rows),
  };
}

const SAMPLE_EVENTS = [
  {
    event_id: 'evt-1',
    event_type: 'agent.entered',
    category: 'agent',
    timestamp: '2026-03-13T10:00:00.000Z',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    session_id: 'session-1',
    trace_id: 'trace-abc',
    span_id: 'span-1',
    parent_span_id: '',
    agent_name: 'billing-support',
    deployment_id: 'deploy-1',
    channel: 'web',
    actor_type: 'user',
    duration_ms: '0',
    has_error: '0',
    error_type: '',
  },
  {
    event_id: 'evt-2',
    event_type: 'llm.call.completed',
    category: 'llm',
    timestamp: '2026-03-13T10:00:01.200Z',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    session_id: 'session-1',
    trace_id: 'trace-abc',
    span_id: 'span-2',
    parent_span_id: 'span-1',
    agent_name: 'billing-support',
    deployment_id: 'deploy-1',
    channel: '',
    actor_type: '',
    duration_ms: '1200',
    has_error: '0',
    error_type: '',
  },
  {
    event_id: 'evt-3',
    event_type: 'tool.call.failed',
    category: 'tool',
    timestamp: '2026-03-13T10:00:02.500Z',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    session_id: 'session-1',
    trace_id: 'trace-abc',
    span_id: 'span-3',
    parent_span_id: 'span-1',
    agent_name: 'billing-support',
    deployment_id: 'deploy-1',
    channel: '',
    actor_type: '',
    duration_ms: '340',
    has_error: '1',
    error_type: 'timeout',
  },
];

// =============================================================================
// Tests
// =============================================================================

describe('Platform Admin Traces API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClickHouseClient.mockReturnValue({
      query: mockQuery,
    });
    mockFindSessionById.mockResolvedValue(null);
    mockFindSessionSummaryByAnyId.mockResolvedValue(null);
    mockSessionModelFindOne.mockReturnValue({
      lean: () => ({
        exec: async () => null,
      }),
    });
    mockTenantFindOne.mockReturnValue({
      lean: () => ({
        exec: async () => ({ _id: 'tenant-1', name: 'Acme Corp' }),
      }),
    });
    app = createApp();
  });

  // ─── GET /search ─────────────────────────────────────────────────────

  describe('GET /search', () => {
    test('returns cross-tenant trace summaries', async () => {
      mockQuery.mockResolvedValueOnce(
        mockClickHouseResult([
          {
            trace_id: 'trace-abc',
            tenant_id: 'tenant-1',
            project_id: 'project-1',
            session_id: 'session-1',
            agent_name: 'billing-support',
            channel: 'web',
            started_at: '2026-03-13T10:00:00.000Z',
            ended_at: '2026-03-13T10:00:05.000Z',
            total_duration_ms: 5000,
            event_count: 12,
            error_count: 1,
            event_types: ['agent.entered', 'llm.call.completed', 'tool.call.failed'],
          },
        ]),
      );

      const res = await request(app).get('/api/platform/admin/traces/search').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.traces).toHaveLength(1);
      expect(res.body.traces[0]).toMatchObject({
        traceId: 'trace-abc',
        tenantId: 'tenant-1',
        tenantName: 'Acme Corp',
        eventCount: 12,
        errorCount: 1,
      });
    });

    test('supports filter params', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult([]));

      await request(app)
        .get('/api/platform/admin/traces/search')
        .query({
          tenantId: 'tenant-1',
          hasError: 'true',
          agentName: 'billing-support',
          channel: 'web',
          minDurationMs: '1000',
        })
        .expect(200);

      const queryCall = mockQuery.mock.calls[0][0];
      expect(queryCall.query).toContain('tenant_id = {tenantId:String}');
      expect(queryCall.query).toContain('has_error = 1');
      expect(queryCall.query).toContain('agent_name = {agentName:String}');
      expect(queryCall.query).toContain('channel = {channel:String}');
      expect(queryCall.query).toContain('total_duration_ms >= {minDurationMs:UInt32}');
    });

    test('writes audit log', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult([]));

      await request(app).get('/api/platform/admin/traces/search').expect(200);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:trace-search',
          userId: 'admin-user-1',
        }),
      );
    });
  });

  // ─── GET /:traceId ──────────────────────────────────────────────────

  describe('GET /:traceId', () => {
    test('returns trace timeline with safe columns only', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult(SAMPLE_EVENTS));

      const res = await request(app).get('/api/platform/admin/traces/trace-abc').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.trace).toMatchObject({
        traceId: 'trace-abc',
        tenantId: 'tenant-1',
        tenantName: 'Acme Corp',
        totalEvents: 3,
        hasErrors: true,
        errorCount: 1,
      });
      expect(res.body.timeline).toHaveLength(3);

      // Verify NO PII fields are present
      for (const event of res.body.timeline) {
        expect(event).not.toHaveProperty('data');
        expect(event).not.toHaveProperty('error_message');
        expect(event).not.toHaveProperty('metadata');
        expect(event).not.toHaveProperty('actor_id');
      }
    });

    test('queries only safe columns from ClickHouse', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult(SAMPLE_EVENTS));

      await request(app).get('/api/platform/admin/traces/trace-abc').expect(200);

      const queryCall = mockQuery.mock.calls[0][0];
      const sql = queryCall.query;

      // Must NOT contain blocked columns
      expect(sql).not.toContain('data');
      expect(sql).not.toContain('error_message');
      expect(sql).not.toContain('metadata');
      expect(sql).not.toContain('actor_id');

      // Must contain safe columns
      expect(sql).toContain('event_type');
      expect(sql).toContain('span_id');
      expect(sql).toContain('duration_ms');
      expect(sql).toContain('has_error');
      expect(sql).toContain('error_type');
    });

    test('returns 404 for unknown trace', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult([]));

      const res = await request(app).get('/api/platform/admin/traces/unknown-trace').expect(404);

      expect(res.body.error).toBe('Trace not found');
    });

    test('writes audit log with tenantId', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult(SAMPLE_EVENTS));

      await request(app).get('/api/platform/admin/traces/trace-abc').expect(200);

      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform-admin:trace-lookup',
          tenantId: 'tenant-1',
          metadata: expect.objectContaining({ traceId: 'trace-abc' }),
        }),
      );
    });
  });

  // ─── GET /:traceId/performance ──────────────────────────────────────

  describe('GET /:traceId/performance', () => {
    test('returns STI path-level performance', async () => {
      mockQuery.mockResolvedValueOnce(
        mockClickHouseResult([
          {
            sti_path: 'agent.execute',
            span_id: 'span-1',
            parent_span_id: '',
            session_id: 'session-1',
            agent_name: 'billing-support',
            deployment_id: 'deploy-1',
            config_hash: 'abc123',
            started_at: '2026-03-13T10:00:00.000Z',
            ended_at: '2026-03-13T10:00:02.400Z',
            duration_ms: '2400',
            has_error: '0',
            error_type: '',
            input_tokens: '420',
            output_tokens: '380',
            total_tokens: '800',
            model_id: 'gpt-4o',
            provider: 'openai',
            tool_name: '',
            attributes: '{"depth":0,"outcome":"success"}',
          },
          {
            sti_path: 'tool.call',
            span_id: 'span-3',
            parent_span_id: 'span-1',
            session_id: 'session-1',
            agent_name: 'billing-support',
            deployment_id: 'deploy-1',
            config_hash: 'abc123',
            started_at: '2026-03-13T10:00:01.500Z',
            ended_at: '2026-03-13T10:00:01.840Z',
            duration_ms: '340',
            has_error: '1',
            error_type: 'timeout',
            input_tokens: '0',
            output_tokens: '0',
            total_tokens: '0',
            model_id: '',
            provider: '',
            tool_name: 'lookup_invoice',
            attributes: '{"depth":1,"outcome":"error"}',
          },
        ]),
      );

      const res = await request(app)
        .get('/api/platform/admin/traces/trace-abc/performance')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.paths).toHaveLength(2);
      expect(res.body.paths[0]).toMatchObject({
        stiPath: 'agent.execute',
        durationMs: 2400,
        totalTokens: 800,
        modelId: 'gpt-4o',
      });
      expect(res.body.paths[1]).toMatchObject({
        stiPath: 'tool.call',
        toolName: 'lookup_invoice',
        hasError: true,
        errorType: 'timeout',
      });
      expect(res.body.totals).toMatchObject({
        totalPaths: 2,
        errorPaths: 1,
        totalTokens: 800,
      });
      expect(res.body.totals.modelBreakdown).toHaveLength(1);
      expect(res.body.totals.modelBreakdown[0]).toMatchObject({
        modelId: 'gpt-4o',
        tokens: 800,
        count: 1,
      });
    });
  });

  // ─── GET /:traceId/cost ─────────────────────────────────────────────

  describe('GET /:traceId/cost', () => {
    test('returns LLM cost breakdown', async () => {
      // First query: resolve session_id from trace
      mockQuery.mockResolvedValueOnce(mockClickHouseResult([{ session_id: 'session-1' }]));

      // Second query: LLM metrics
      mockQuery.mockResolvedValueOnce(
        mockClickHouseResult([
          {
            model_id: 'gpt-4o',
            provider: 'openai',
            operation_type: 'chat',
            agent_name: 'billing-support',
            input_tokens: '420',
            output_tokens: '380',
            total_tokens: '800',
            estimated_cost: '0.0142',
            latency_ms: '1200',
            success: '1',
            error_type: '',
            timestamp: '2026-03-13T10:00:01.200Z',
          },
        ]),
      );

      const res = await request(app).get('/api/platform/admin/traces/trace-abc/cost').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.calls).toHaveLength(1);
      expect(res.body.calls[0]).toMatchObject({
        modelId: 'gpt-4o',
        provider: 'openai',
        totalTokens: 800,
        estimatedCost: 0.0142,
        success: true,
      });
      expect(res.body.totals.callCount).toBe(1);
      expect(res.body.totals.byModel).toHaveLength(1);
    });

    test('returns empty when no session found', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult([]));

      const res = await request(app).get('/api/platform/admin/traces/trace-abc/cost').expect(200);

      expect(res.body.calls).toHaveLength(0);
      expect(res.body.totals.callCount).toBe(0);
    });
  });

  // ─── GET /sessions/:sessionId/summary ───────────────────────────────

  describe('GET /sessions/:sessionId/summary', () => {
    test('returns session metadata without content', async () => {
      // ClickHouse query for tenant resolution
      mockQuery.mockResolvedValueOnce(
        mockClickHouseResult([{ tenant_id: 'tenant-1', project_id: 'project-1' }]),
      );

      // MongoDB session lookup
      mockFindSessionById.mockResolvedValueOnce({
        projectId: 'project-1',
        status: 'completed',
        disposition: 'resolved',
        channel: 'web',
        currentAgent: 'billing-support',
        agentVersion: '2.1.0',
        startedAt: new Date('2026-03-13T10:00:00.000Z'),
        lastActivityAt: new Date('2026-03-13T10:05:00.000Z'),
        endedAt: new Date('2026-03-13T10:05:00.000Z'),
        messageCount: 8,
        tokenCount: 2400,
        estimatedCost: 0.045,
        errorCount: 1,
        handoffCount: 0,
        traceEventCount: 15,
        identityTier: 2,
        isTest: false,
      });

      const res = await request(app)
        .get('/api/platform/admin/traces/sessions/session-1/summary')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.summary).toMatchObject({
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        tenantName: 'Acme Corp',
        status: 'completed',
        channel: 'web',
        messageCount: 8,
        errorCount: 1,
      });

      // Verify NO content fields
      expect(res.body.summary).not.toHaveProperty('messages');
      expect(res.body.summary).not.toHaveProperty('context');
      expect(res.body.summary).not.toHaveProperty('conversation');
    });

    test('falls back to direct session lookup when ClickHouse is unavailable', async () => {
      mockGetClickHouseClient.mockReturnValue(null);
      mockFindSessionSummaryByAnyId.mockResolvedValue({
        id: 'db-session-1',
        runtimeSessionId: 'runtime-session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        disposition: null,
        channel: 'http_async',
        currentAgent: 'Webhook_Agent',
        agentVersion: 'v1',
        startedAt: '2026-03-13T10:00:00.000Z',
        lastActivityAt: '2026-03-13T10:00:05.000Z',
        endedAt: null,
        messageCount: 2,
        tokenCount: 0,
        estimatedCost: 0,
        errorCount: 0,
        handoffCount: 0,
        traceEventCount: 3,
        identityTier: 2,
        isTest: true,
      });

      const res = await request(app)
        .get('/api/platform/admin/traces/sessions/runtime-session-1/summary')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.summary).toMatchObject({
        sessionId: 'runtime-session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channel: 'http_async',
        currentAgent: 'Webhook_Agent',
        identityTier: 2,
      });
      expect(mockFindSessionSummaryByAnyId).toHaveBeenCalledWith('runtime-session-1');
    });

    test('returns 404 for unknown session', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult([]));

      await request(app)
        .get('/api/platform/admin/traces/sessions/unknown-session/summary')
        .expect(404);
    });
  });

  // ─── Data boundary enforcement ──────────────────────────────────────

  describe('data boundary', () => {
    test('SAFE_EVENT_COLUMNS does not include blocked columns', async () => {
      mockQuery.mockResolvedValueOnce(mockClickHouseResult(SAMPLE_EVENTS));

      await request(app).get('/api/platform/admin/traces/trace-abc').expect(200);

      const sql = mockQuery.mock.calls[0][0].query;

      // The SELECT should be explicit safe columns, not SELECT *
      expect(sql).not.toMatch(/SELECT\s+\*/);

      // Blocked columns must never appear in the SELECT
      // Split the query at FROM to get just the SELECT part
      const selectPart = sql.split('FROM')[0];
      expect(selectPart).not.toContain(' data');
      expect(selectPart).not.toContain(',data');
      expect(selectPart).not.toContain('error_message');
      expect(selectPart).not.toContain('metadata');
      expect(selectPart).not.toContain('actor_id');
    });
  });

  // ─── ClickHouse unavailable ─────────────────────────────────────────

  describe('error handling', () => {
    test('returns 500 when ClickHouse query fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      const res = await request(app).get('/api/platform/admin/traces/search').expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Failed to search traces');
    });
  });
});
