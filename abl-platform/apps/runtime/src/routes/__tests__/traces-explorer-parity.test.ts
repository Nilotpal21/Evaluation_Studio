import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockClickHouseQuery, mockSessionFind } = vi.hoisted(() => ({
  mockClickHouseQuery: vi.fn(),
  mockSessionFind: vi.fn(),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: (...args: unknown[]) => mockClickHouseQuery(...args),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    find: (...args: unknown[]) => mockSessionFind(...args),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: () => true,
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn().mockResolvedValue(true),
}));

import tracesRouter from '../traces.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      authType: 'user',
      role: 'ADMIN',
      permissions: ['session:read'],
      isSuperAdmin: false,
    } as typeof req.tenantContext;
    next();
  });
  app.use('/api/projects/:projectId/traces', tracesRouter);
  return app;
}

function mockClickHouseRows(rows: Array<Record<string, unknown>>, total = rows.length) {
  mockClickHouseQuery.mockResolvedValueOnce({
    json: async () => rows,
  });
  mockClickHouseQuery.mockResolvedValueOnce({
    json: async () => [{ total }],
  });
}

function mockSessionEnvironmentLookup(environment: string) {
  mockSessionFind.mockReturnValueOnce({
    limit: () => ({
      lean: () => ({
        exec: async () => [{ _id: 'session-1' }],
      }),
    }),
  });
  mockSessionFind.mockReturnValueOnce({
    lean: () => ({
      exec: async () => [{ _id: 'session-1', environment }],
    }),
  });
}

describe('trace explorer parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('round-trips trace filters through ClickHouse and enriches legacy rows from Session.environment', async () => {
    mockClickHouseRows([
      {
        // ClickHouse aliases use `resolved_*` to avoid CYCLIC_ALIASES /
        // ILLEGAL_AGGREGATION under the 24.3+ analyzer; the mapper expects
        // this shape.
        resolved_trace_id: 'trace-1',
        resolved_span_id: 'span-llm-1',
        resolved_session_id: 'session-1',
        agent_name: 'CignaRouter',
        environment: '',
        channel: 'web_chat',
        // SQL now emits pre-formatted UTC ISO via
        // `formatDateTime(..., '%Y-%m-%dT%H:%i:%S.%fZ')` to avoid V8 parsing
        // ClickHouse's space-separated DateTime64 text as local time.
        started_at: '2026-05-12T16:00:00.000Z',
        duration_ms: 842,
        event_count: 3,
        error_count: 0,
        warning_count: 2,
        warning_codes: ['REASONING_FALLBACK', 'OPENAI_RESPONSES_REASONING_ITEM_MISSING'],
        diagnostic_code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
        diagnostic_customer_message:
          "I'm having trouble completing that request. Please try again.",
        diagnostic_operator_hint:
          'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
        diagnostic_trace_id: 'trace-1',
        diagnostic_category: 'llm',
        diagnostic_severity: 'error',
        diagnostic_agent_name: 'CignaRouter',
        diagnostic_tool_name: '',
        diagnostic_recommended_action:
          'Verify Responses history uses previous_response_id or preserves reasoning items adjacent to function_call items.',
        event_types: ['llm.call.started', 'llm.call.completed'],
        input_tokens: 128,
        output_tokens: 32,
        estimated_cost: 0.0043219,
      },
    ]);
    mockSessionEnvironmentLookup('production');

    const response = await request(createApp()).get(
      '/api/projects/project-1/traces?environment=production&type=llm_call&status=ok&minLatencyMs=100&maxLatencyMs=1000&minTokens=100&maxTokens=200&minCost=0.001&maxCost=0.01&sortBy=totalTokens&sortDir=asc&limit=25',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      total: 1,
      offset: 0,
      limit: 25,
      traces: [
        {
          traceId: 'trace-1',
          spanId: 'span-llm-1',
          sessionId: 'session-1',
          agentName: 'CignaRouter',
          environment: 'production',
          channel: 'web_chat',
          type: 'llm_call',
          status: 'ok',
          durationMs: 842,
          inputTokens: 128,
          outputTokens: 32,
          totalTokens: 160,
          estimatedCost: 0.004322,
          eventCount: 3,
          errorCount: 0,
          warningCount: 2,
          warnings: [
            {
              code: 'REASONING_FALLBACK',
              severity: 'warning',
            },
            {
              code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
              severity: 'warning',
            },
          ],
          operatorDiagnostics: [
            {
              code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
              customerMessage: "I'm having trouble completing that request. Please try again.",
              operatorHint:
                'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
              traceId: 'trace-1',
              severity: 'error',
              category: 'llm',
              agentName: 'CignaRouter',
              toolName: null,
              recommendedAction:
                'Verify Responses history uses previous_response_id or preserves reasoning items adjacent to function_call items.',
            },
          ],
          preview: 'llm.call.completed, llm.call.started',
        },
      ],
    });
    expect(response.body.traces[0]).not.toHaveProperty('data');

    expect(mockClickHouseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('FROM abl_platform.platform_events'),
        query_params: expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          environments: ['production'],
          legacyEnvironmentSessionIds: ['session-1'],
          categories: ['llm'],
          minLatencyMs: 100,
          maxLatencyMs: 1000,
          minTokens: 100,
          maxTokens: 200,
          minCost: 0.001,
          maxCost: 0.01,
          limit: 25,
          offset: 0,
        }),
        format: 'JSONEachRow',
      }),
    );
    const [{ query }] = mockClickHouseQuery.mock.calls[0] as [{ query: string }];
    expect(query).toContain('tenant_id = {tenantId:String}');
    expect(query).toContain('project_id = {projectId:String}');
    expect(query).toContain('environment IN {environments:Array(String)}');
    expect(query).toContain(
      "OR (environment = '' AND session_id IN {legacyEnvironmentSessionIds:Array(String)})",
    );
    expect(query).toContain('category IN {categories:Array(String)}');
    expect(query).toContain('HAVING error_count = 0');
    expect(query).toContain('ORDER BY total_tokens ASC');
    expect(query).toContain('LIMIT {limit:UInt32} OFFSET {offset:UInt32}');
    expect(query).toContain("JSONExtractBool(data, 'isReasoningFallback')");
    expect(query).toContain("groupUniqArrayIf('REASONING_FALLBACK'");
    expect(query).toContain("JSONExtractString(JSONExtractRaw(data, 'diagnostic'), 'code')");
    expect(query).toContain("JSONExtractRaw(data, 'errorEnvelope')");
    expect(query).toContain("'OPENAI_RESPONSES_REASONING_ITEM_MISSING'");
    // Regression guards for ABLP-1001 — the new ClickHouse analyzer (24.3+)
    // rejects these patterns with CYCLIC_ALIASES / ILLEGAL_AGGREGATION. They
    // shipped in PR #1022 and caused 100 % failure of the v2 trace explorer
    // for 7 days before being caught.
    expect(query).toContain('AS resolved_trace_id');
    expect(query).toContain('AS resolved_span_id');
    expect(query).toContain('AS resolved_session_id');
    expect(query).toContain('GROUP BY resolved_trace_id, resolved_span_id');
    expect(query).toContain("formatDateTime(min(timestamp), '%Y-%m-%dT%H:%i:%S.%fZ')");
    expect(query).not.toMatch(/AS\s+trace_id\b/);
    expect(query).not.toMatch(/AS\s+span_id\b/);
    expect(query).not.toMatch(/anyLast\(session_id\)\s+AS\s+session_id\b/);
    expect(query).not.toContain('GROUP BY trace_key');
    expect(mockClickHouseQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: expect.stringContaining('SELECT count() AS total'),
        query_params: expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          limit: 25,
          offset: 0,
        }),
        format: 'JSONEachRow',
      }),
    );
    // Count-query regression guard for ABLP-1001 — outer-level WITH that
    // references the inner FROM-subquery's columns raises UNKNOWN_IDENTIFIER
    // (Code 47). The WITH must live INSIDE the subquery so the column scope
    // covers it.
    const [{ query: countQuery }] = mockClickHouseQuery.mock.calls[1] as [{ query: string }];
    expect(countQuery).toContain('SELECT count() AS total');
    expect(countQuery).toMatch(/SELECT\s+count\(\)\s+AS\s+total\s+FROM\s+\(\s*WITH\s+if\(trace_id/);
    expect(countQuery).toContain('GROUP BY resolved_trace_id, resolved_span_id');

    expect(mockSessionFind).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        environment: { $in: ['production'] },
        startedAt: expect.any(Object),
        lastActivityAt: expect.any(Object),
      },
      { _id: 1 },
    );
    expect(mockSessionFind).toHaveBeenCalledWith(
      { _id: { $in: ['session-1'] }, tenantId: 'tenant-1', projectId: 'project-1' },
      { _id: 1, environment: 1 },
    );
  });

  test('preserves UTC when ClickHouse returns space-separated DateTime64 text', async () => {
    // Regression for ABLP-1001 timezone-drift bug: pre-fix the mapper called
    // `new Date('2026-05-12 03:13:38.847').toISOString()`, which V8 parses as
    // local time (5h30 off on Asia/Calcutta, 8h off on PST). The mapper now
    // routes through normalizeClickHouseDateTimeToIso to keep the UTC instant.
    mockClickHouseRows([
      {
        resolved_trace_id: 'trace-tz',
        resolved_span_id: 'span-tz',
        resolved_session_id: 'session-tz',
        agent_name: 'TZAgent',
        environment: 'production',
        channel: 'web_chat',
        // ClickHouse's pre-format SQL emits the ISO+Z form we now expect.
        started_at: '2026-05-12T03:13:38.847Z',
        duration_ms: 100,
        event_count: 1,
        error_count: 0,
        warning_count: 0,
        warning_codes: [],
        event_types: ['llm.call.completed'],
        input_tokens: 0,
        output_tokens: 0,
        estimated_cost: 0,
      },
      {
        // Legacy ClickHouse text format (space separator, no Z) MUST still be
        // parsed as UTC — never as the server's local time.
        resolved_trace_id: 'trace-legacy',
        resolved_span_id: 'span-legacy',
        resolved_session_id: 'session-legacy',
        agent_name: 'TZAgent',
        environment: 'production',
        channel: 'web_chat',
        started_at: '2026-05-12 03:13:38.847',
        duration_ms: 100,
        event_count: 1,
        error_count: 0,
        warning_count: 0,
        warning_codes: [],
        event_types: ['llm.call.completed'],
        input_tokens: 0,
        output_tokens: 0,
        estimated_cost: 0,
      },
    ]);

    const response = await request(createApp()).get('/api/projects/project-1/traces');
    expect(response.status).toBe(200);
    expect(response.body.traces).toHaveLength(2);
    expect(response.body.traces[0].startedAt).toBe('2026-05-12T03:13:38.847Z');
    expect(response.body.traces[1].startedAt).toBe('2026-05-12T03:13:38.847Z');
  });

  test('rejects invalid boolean filters before querying ClickHouse', async () => {
    const response = await request(createApp()).get(
      '/api/projects/project-1/traces?errorsOnly=sometimes',
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'errorsOnly must be a boolean query value',
      },
    });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });
});
