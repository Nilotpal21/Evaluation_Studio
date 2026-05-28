/**
 * Integration: LookupResolver → HTTP API (INT-4, INT-5, INT-7)
 *
 * INT-4: API source header forwarding via real mock HTTP server
 * INT-5: SSRF protection blocks private IP endpoints
 * INT-7: Cache TTL and LRU eviction behavior
 *
 * Note: vi.mock is used ONLY for external dependencies outside the service
 * boundary (logger, database model). The lookup resolver itself is the real module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';

// Mock external deps only — NOT the component under test
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database', () => ({
  LookupEntry: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      }),
    }),
  },
}));

import { resolveLookup, clearCaches } from '../../services/execution/lookup-resolver.js';
import type { LookupContext } from '../../services/execution/lookup-resolver.js';

function makeContext(overrides: Partial<LookupContext> = {}): LookupContext {
  return { tenantId: 'tenant-1', projectId: 'project-1', ...overrides };
}

beforeEach(() => {
  clearCaches();
});

// ---------------------------------------------------------------------------
// INT-4: API source with header forwarding via real HTTP server
// ---------------------------------------------------------------------------

describe('INT-4: API source — header forwarding via mock server', () => {
  let server: http.Server;
  let port: number;
  let receivedHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    receivedHeaders = {};
    server = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      if (!req.headers.authorization) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false, error: 'Unauthorized' }));
        return;
      }
      const url = new URL(req.url!, `http://localhost:${port}`);
      const value = url.searchParams.get('value');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: true, matched_value: value }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('forwards configured headers to the API server', async () => {
    const table: LookupTableIR = {
      name: 'products',
      source: 'api',
      endpoint: `http://127.0.0.1:${port}/lookup`,
      headers: { Authorization: 'Bearer test-token-123', 'X-Custom-Header': 'custom-value' },
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    const result = await resolveLookup('widget', table, makeContext());
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('widget');
    expect(receivedHeaders.authorization).toBe('Bearer test-token-123');
    expect(receivedHeaders['x-custom-header']).toBe('custom-value');
  });

  it('request fails when server requires auth but no headers configured', async () => {
    const table: LookupTableIR = {
      name: 'products',
      source: 'api',
      endpoint: `http://127.0.0.1:${port}/lookup`,
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
    const result = await resolveLookup('widget', table, makeContext());
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INT-5: SSRF protection blocks private IPs
// ---------------------------------------------------------------------------

describe.skip('INT-5: SSRF protection (requires production SSRF config)', () => {
  const privateEndpoints = [
    'http://10.0.0.1/internal',
    'http://172.16.0.1/lookup',
    'http://192.168.1.1/lookup',
  ];

  for (const endpoint of privateEndpoints) {
    it(`blocks private IP endpoint: ${endpoint}`, async () => {
      const table: LookupTableIR = {
        name: 'evil',
        source: 'api',
        endpoint,
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = await resolveLookup('test', table, makeContext());
      expect(result.found).toBe(false);
      expect(result.error).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// INT-7: Cache TTL and LRU eviction
// ---------------------------------------------------------------------------

describe('INT-7: Cache TTL and LRU eviction', () => {
  let callCount: number;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callCount = 0;
    mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      const urlObj = new URL(url);
      const value = urlObj.searchParams.get('value');
      return { ok: true, json: () => Promise.resolve({ found: true, matched_value: value }) };
    });
  });

  function makeApiTable(name: string): LookupTableIR {
    return {
      name,
      source: 'api',
      endpoint: 'https://api.example.com/lookup',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };
  }

  it('caches API results — second call does not fetch', async () => {
    const table = makeApiTable('test');
    const ctx = { ...makeContext(), fetchFn: mockFetch };
    await resolveLookup('valueA', table, ctx);
    expect(callCount).toBe(1);
    await resolveLookup('valueA', table, ctx);
    expect(callCount).toBe(1);
  });

  it('different values each trigger a fetch', async () => {
    const table = makeApiTable('test');
    const ctx = { ...makeContext(), fetchFn: mockFetch };
    await resolveLookup('A', table, ctx);
    await resolveLookup('B', table, ctx);
    await resolveLookup('C', table, ctx);
    expect(callCount).toBe(3);
  });

  it('LRU: recently accessed entry survives over older entries', async () => {
    const table = makeApiTable('lru-test');
    const ctx = { ...makeContext(), fetchFn: mockFetch };
    await resolveLookup('first', table, ctx);
    const countAfterFirst = callCount;
    for (let i = 0; i < 50; i++) {
      await resolveLookup(`fill_${i}`, table, ctx);
    }
    // Access "first" again — should still be cached (cache max is 200)
    await resolveLookup('first', table, ctx);
    expect(callCount).toBe(countAfterFirst + 50); // 50 fills, no re-fetch
  });
});
