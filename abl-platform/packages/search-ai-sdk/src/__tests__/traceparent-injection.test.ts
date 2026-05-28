/**
 * SearchAI SDK — traceparent header injection tests
 *
 * Verifies that the SearchAIClient.buildHeaders() method correctly injects
 * W3C traceparent and X-Trace-Id headers when an observability context is
 * present, and omits them when it is not.
 *
 * client.ts uses a lazy dynamic import for @abl/compiler/platform/observability.
 * We wait for the module-level import() promise to settle before testing.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetObservabilityContext } = vi.hoisted(() => ({
  mockGetObservabilityContext: vi.fn<[], { traceId: string; spanId: string } | undefined>(),
}));

// Mock the lazy-imported observability module that client.ts uses
vi.mock('@abl/compiler/platform/observability', () => ({
  getObservabilityContext: mockGetObservabilityContext,
}));

// Mock global fetch so requests don't actually go out
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

import { SearchAIClient, _observabilityReady } from '../client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(overrides?: Partial<ConstructorParameters<typeof SearchAIClient>[0]>) {
  return new SearchAIClient({
    runtimeUrl: 'http://localhost:3004',
    engineUrl: 'http://localhost:3005',
    authToken: 'test-jwt',
    ...overrides,
  });
}

/**
 * Trigger a request and capture the headers passed to fetch.
 * We need a small delay on first call to let the module-level lazy import
 * in client.ts resolve (import('@abl/compiler/platform/observability')).
 */
async function captureHeaders(client: SearchAIClient): Promise<Record<string, string>> {
  // Wait for the lazy observability import to settle (deterministic, no timing)
  await _observabilityReady;

  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => [],
  });

  // Trigger a GET request
  await client.listIndexes();

  const [, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return options.headers as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchAI SDK traceparent injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('injects traceparent and X-Trace-Id when observability context exists', async () => {
    mockGetObservabilityContext.mockReturnValue({
      traceId: 'abcd1234abcd1234abcd1234abcd1234',
      spanId: '1234abcd1234abcd',
    });

    const client = createClient();
    const headers = await captureHeaders(client);

    expect(headers['traceparent']).toBe('00-abcd1234abcd1234abcd1234abcd1234-1234abcd1234abcd-01');
    expect(headers['X-Trace-Id']).toBe('abcd1234abcd1234abcd1234abcd1234');
  }, 15000);

  test('omits trace headers when no observability context', async () => {
    mockGetObservabilityContext.mockReturnValue(undefined);

    const client = createClient();
    const headers = await captureHeaders(client);

    expect(headers['traceparent']).toBeUndefined();
    expect(headers['X-Trace-Id']).toBeUndefined();
  }, 15000);

  test('still includes Content-Type and Authorization headers', async () => {
    mockGetObservabilityContext.mockReturnValue(undefined);

    const client = createClient({ authToken: 'my-token' });
    const headers = await captureHeaders(client);

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer my-token');
  });

  test('traceparent format follows W3C spec (00-{traceId}-{spanId}-01)', async () => {
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    mockGetObservabilityContext.mockReturnValue({ traceId, spanId });

    const client = createClient();
    const headers = await captureHeaders(client);

    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  test('includes custom headers alongside trace headers', async () => {
    mockGetObservabilityContext.mockReturnValue({
      traceId: 'abcd1234abcd1234abcd1234abcd1234',
      spanId: '1234abcd1234abcd',
    });

    const client = createClient({
      headers: { 'X-Custom': 'value' },
    });
    const headers = await captureHeaders(client);

    expect(headers['X-Custom']).toBe('value');
    expect(headers['traceparent']).toBeDefined();
    expect(headers['X-Trace-Id']).toBeDefined();
  });
});
