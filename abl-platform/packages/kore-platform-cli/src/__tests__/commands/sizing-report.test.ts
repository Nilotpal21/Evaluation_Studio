import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCloudResults } from '../../commands/sizing-report.js';

// Mock global fetch to intercept k6CloudFetch calls
const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mockFetch;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function makeRunDetail(
  id: number,
  overrides: Partial<{
    started: string;
    ended: string;
    duration: number;
    vus: number;
    run_status: number;
  }> = {},
) {
  return {
    'k6-run': {
      id,
      status: 2,
      created: '2026-03-25T10:00:00Z',
      started: '2026-03-25T10:00:00Z',
      ended: '2026-03-25T10:05:00Z',
      duration: 300,
      vus: 50,
      run_status: 2,
      ...overrides,
    },
  };
}

function makeAggregateResponse(value: number | null) {
  if (value === null) {
    return { status: 'success', data: { resultType: 'vector', result: [] } };
  }
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: {}, values: [[1711360000, value]] }],
    },
  };
}

function setupMockResponses(
  runs: Array<{
    id: number;
    reqs: number;
    reqRate: number;
    p50: number;
    p95: number;
    p99: number;
    minMs: number;
    maxMs: number;
    errorRate: number | null;
    started?: string;
    ended?: string;
  }>,
) {
  mockFetch.mockImplementation((url: string) => {
    const path = new URL(url).pathname;

    // List tests
    if (path.includes('/loadtests/v2/tests')) {
      return Promise.resolve(
        jsonResponse({
          'k6-tests': [{ id: 1, name: 'runtime.ts', project_id: 42 }],
        }),
      );
    }

    // List runs for test
    if (path.includes('/loadtests/v2/runs') && url.includes('test_id=')) {
      return Promise.resolve(
        jsonResponse({
          'k6-runs': runs.map((r) => ({
            id: r.id,
            status: 2,
            created: r.started ?? '2026-03-25T10:00:00Z',
            started: r.started ?? '2026-03-25T10:00:00Z',
            ended: r.ended ?? '2026-03-25T10:05:00Z',
            duration: 300,
            vus: 50,
            run_status: 2,
          })),
        }),
      );
    }

    // Run detail
    const runDetailMatch = path.match(/\/loadtests\/v2\/runs\/(\d+)$/);
    if (runDetailMatch) {
      const runId = parseInt(runDetailMatch[1], 10);
      const run = runs.find((r) => r.id === runId);
      if (run) {
        return Promise.resolve(
          jsonResponse(
            makeRunDetail(run.id, {
              started: run.started ?? '2026-03-25T10:00:00Z',
              ended: run.ended ?? '2026-03-25T10:05:00Z',
            }),
          ),
        );
      }
    }

    // Aggregate queries
    if (path.includes('query_aggregate_k6')) {
      // Extract runId and metric from path
      const runIdMatch = path.match(/test_runs\((\d+)\)/);
      const metricMatch = path.match(/metric='([^']+)'/);
      const queryMatch = path.match(/query='([^']+)'/);
      const runId = runIdMatch ? parseInt(runIdMatch[1], 10) : 0;
      const metric = metricMatch ? metricMatch[1] : '';
      const query = queryMatch ? queryMatch[1] : '';
      const run = runs.find((r) => r.id === runId);

      if (run) {
        if (metric === 'http_reqs' && query === 'value()') {
          return Promise.resolve(jsonResponse(makeAggregateResponse(run.reqs)));
        }
        if (metric === 'http_reqs' && query === 'rate()') {
          return Promise.resolve(jsonResponse(makeAggregateResponse(run.reqRate)));
        }
        if (metric === 'http_req_duration') {
          if (query.includes('0.50')) {
            return Promise.resolve(jsonResponse(makeAggregateResponse(run.p50)));
          }
          if (query.includes('0.95')) {
            return Promise.resolve(jsonResponse(makeAggregateResponse(run.p95)));
          }
          if (query.includes('0.99')) {
            return Promise.resolve(jsonResponse(makeAggregateResponse(run.p99)));
          }
          if (query.includes('0.0')) {
            return Promise.resolve(jsonResponse(makeAggregateResponse(run.minMs)));
          }
          if (query.includes('1.0')) {
            return Promise.resolve(jsonResponse(makeAggregateResponse(run.maxMs)));
          }
        }
        if (metric === 'http_req_failed') {
          return Promise.resolve(jsonResponse(makeAggregateResponse(run.errorRate)));
        }
      }
    }

    return Promise.resolve(jsonResponse({}));
  });
}

describe('fetchCloudResults', () => {
  it('averages metrics across last N runs when --last > 1', async () => {
    setupMockResponses([
      {
        id: 103,
        reqs: 3000,
        reqRate: 30,
        p50: 30,
        p95: 300,
        p99: 900,
        minMs: 3,
        maxMs: 3000,
        errorRate: 0.03,
        started: '2026-03-25T12:00:00Z',
        ended: '2026-03-25T12:05:00Z',
      },
      {
        id: 102,
        reqs: 2000,
        reqRate: 20,
        p50: 20,
        p95: 200,
        p99: 600,
        minMs: 2,
        maxMs: 2000,
        errorRate: 0.02,
        started: '2026-03-25T11:00:00Z',
        ended: '2026-03-25T11:05:00Z',
      },
      {
        id: 101,
        reqs: 1000,
        reqRate: 10,
        p50: 10,
        p95: 100,
        p99: 300,
        minMs: 1,
        maxMs: 1000,
        errorRate: 0.01,
        started: '2026-03-25T10:00:00Z',
        ended: '2026-03-25T10:05:00Z',
      },
    ]);

    const result = await fetchCloudResults('42', 'test-token', 3);
    const svc = result.services as Record<string, Record<string, unknown>>;
    const runtime = svc['runtime'] as Record<string, unknown>;

    expect(runtime).toBeDefined();
    // Average of 3000, 2000, 1000
    expect(runtime.totalRequests).toBe(2000);
    // Average of 0.03, 0.02, 0.01
    expect(runtime.errorRate).toBeCloseTo(0.02, 5);
    // Average p95: (300 + 200 + 100) / 3 = 200
    const latency = runtime.latency as Record<string, number>;
    expect(latency.p95Ms).toBe(200);
    expect(latency.p50Ms).toBe(20);
    // Uses latest run metadata
    expect(runtime.cloudRunId).toBe(103);
    expect(runtime.runsAveraged).toBe(3);
  });

  it('returns single run metrics unchanged when --last is 1', async () => {
    setupMockResponses([
      {
        id: 201,
        reqs: 5000,
        reqRate: 50,
        p50: 15,
        p95: 150,
        p99: 450,
        minMs: 1,
        maxMs: 1500,
        errorRate: 0.05,
        started: '2026-03-25T10:00:00Z',
        ended: '2026-03-25T10:05:00Z',
      },
    ]);

    const result = await fetchCloudResults('42', 'test-token', 1);
    const svc = result.services as Record<string, Record<string, unknown>>;
    const runtime = svc['runtime'] as Record<string, unknown>;

    expect(runtime).toBeDefined();
    expect(runtime.totalRequests).toBe(5000);
    expect(runtime.errorRate).toBe(0.05);
    expect(runtime.runsAveraged).toBe(1);
  });

  it('derives real error rate from http_req_failed metric', async () => {
    setupMockResponses([
      {
        id: 301,
        reqs: 10000,
        reqRate: 100,
        p50: 20,
        p95: 200,
        p99: 600,
        minMs: 2,
        maxMs: 2000,
        errorRate: 0.08,
      },
    ]);

    const result = await fetchCloudResults('42', 'test-token', 1);
    const svc = result.services as Record<string, Record<string, unknown>>;
    const runtime = svc['runtime'] as Record<string, unknown>;

    expect(runtime.errorRate).toBe(0.08);
    expect(result.overallErrorRate).toBeCloseTo(0.08, 5);
  });

  it('falls back to 0 error rate when http_req_failed returns null', async () => {
    setupMockResponses([
      {
        id: 401,
        reqs: 10000,
        reqRate: 100,
        p50: 20,
        p95: 200,
        p99: 600,
        minMs: 2,
        maxMs: 2000,
        errorRate: null,
      },
    ]);

    const result = await fetchCloudResults('42', 'test-token', 1);
    const svc = result.services as Record<string, Record<string, unknown>>;
    const runtime = svc['runtime'] as Record<string, unknown>;

    expect(runtime.errorRate).toBe(0);
  });

  it('selects only last N runs when more are available', async () => {
    setupMockResponses([
      {
        id: 503,
        reqs: 3000,
        reqRate: 30,
        p50: 30,
        p95: 300,
        p99: 900,
        minMs: 3,
        maxMs: 3000,
        errorRate: 0,
        started: '2026-03-25T12:00:00Z',
        ended: '2026-03-25T12:05:00Z',
      },
      {
        id: 502,
        reqs: 2000,
        reqRate: 20,
        p50: 20,
        p95: 200,
        p99: 600,
        minMs: 2,
        maxMs: 2000,
        errorRate: 0,
        started: '2026-03-25T11:00:00Z',
        ended: '2026-03-25T11:05:00Z',
      },
      {
        id: 501,
        reqs: 1000,
        reqRate: 10,
        p50: 10,
        p95: 100,
        p99: 300,
        minMs: 1,
        maxMs: 1000,
        errorRate: 0,
        started: '2026-03-25T10:00:00Z',
        ended: '2026-03-25T10:05:00Z',
      },
    ]);

    // Request last 2 — should only use runs 503 and 502
    const result = await fetchCloudResults('42', 'test-token', 2);
    const svc = result.services as Record<string, Record<string, unknown>>;
    const runtime = svc['runtime'] as Record<string, unknown>;

    // Average of 3000, 2000 = 2500
    expect(runtime.totalRequests).toBe(2500);
    expect(runtime.runsAveraged).toBe(2);
  });
});
