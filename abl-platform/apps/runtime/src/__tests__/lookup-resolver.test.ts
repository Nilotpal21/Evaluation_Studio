import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';

/**
 * Mock @agent-platform/database before importing the resolver.
 * The LookupEntry mock provides a chainable findOne().lean() pattern.
 */
const mockLean = vi.fn().mockResolvedValue(null);
const mockFindOne = vi.fn().mockReturnValue({ lean: mockLean });
vi.mock('@agent-platform/database', () => ({
  LookupEntry: {
    findOne: mockFindOne,
  },
}));

import {
  resolveInlineLookup,
  resolveLookup,
  resolveLookupBatch,
  fuzzyMatch,
  clearCaches,
} from '../services/execution/lookup-resolver.js';
import type { LookupContext } from '../services/execution/lookup-resolver.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<LookupContext> = {}): LookupContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    ...overrides,
  };
}

function makeInlineTable(overrides: Partial<LookupTableIR> = {}): LookupTableIR {
  return {
    name: 'test_table',
    source: 'inline',
    values: ['LAX', 'JFK', 'CDG', 'LHR', 'NRT'],
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearCaches();
  mockFindOne.mockClear();
  mockLean.mockClear();
  mockLean.mockResolvedValue(null);
  mockFindOne.mockReturnValue({ lean: mockLean });
});

// ─── 1. O(1) Set Lookup ────────────────────────────────────────────────────

describe('O(1) Set-based inline lookup', () => {
  it('matches exact value via Set (case-insensitive)', () => {
    const table = makeInlineTable();
    const result = resolveInlineLookup('lax', table);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('LAX');
  });

  it('matches exact value via Set (already correct case)', () => {
    const table = makeInlineTable();
    const result = resolveInlineLookup('JFK', table);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('JFK');
  });

  it('returns not found for non-existent value', () => {
    const table = makeInlineTable();
    const result = resolveInlineLookup('XYZ', table);
    expect(result.found).toBe(false);
    expect(result.matched_value).toBeUndefined();
  });

  it('returns not found for empty values array', () => {
    const table = makeInlineTable({ values: [] });
    const result = resolveInlineLookup('LAX', table);
    expect(result.found).toBe(false);
  });

  it('returns not found for undefined values', () => {
    const table = makeInlineTable({ values: undefined });
    const result = resolveInlineLookup('LAX', table);
    expect(result.found).toBe(false);
  });
});

// ─── 2. Normalized Values ──────────────────────────────────────────────────

describe('Normalized values (case-insensitive O(1) lookup)', () => {
  it('uses normalized_values for case-insensitive matching', () => {
    const table = makeInlineTable({
      values: ['Los Angeles', 'New York', 'Chicago'],
      normalized_values: ['los angeles', 'new york', 'chicago'],
    });

    const result = resolveInlineLookup('los angeles', table);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('Los Angeles');
  });

  it('falls back to values when normalized_values not present', () => {
    const table = makeInlineTable({
      values: ['Alpha', 'Beta', 'Gamma'],
      normalized_values: undefined,
    });

    const result = resolveInlineLookup('alpha', table);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('Alpha');
  });
});

// ─── 3. Case-Sensitive ─────────────────────────────────────────────────────

describe('Case-sensitive inline lookup', () => {
  it('matches only exact case when case_sensitive=true', () => {
    const table = makeInlineTable({ case_sensitive: true });

    expect(resolveInlineLookup('LAX', table).found).toBe(true);
    expect(resolveInlineLookup('lax', table).found).toBe(false);
    expect(resolveInlineLookup('Lax', table).found).toBe(false);
  });

  it('returns exact input as matched_value when case-sensitive', () => {
    const table = makeInlineTable({ case_sensitive: true });

    const result = resolveInlineLookup('JFK', table);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('JFK');
  });
});

// ─── 4. Fuzzy Early Termination ────────────────────────────────────────────

describe('Fuzzy match early termination', () => {
  it('short-circuits at similarity=1.0 for exact (case-insensitive) match', () => {
    const result = fuzzyMatch('new york', ['Los Angeles', 'New York', 'Chicago'], 0.8);
    expect(result).not.toBeNull();
    expect(result!.value).toBe('New York');
    expect(result!.similarity).toBe(1.0);
  });

  it('returns best match above threshold for close spelling', () => {
    const result = fuzzyMatch('Los Angelos', ['Los Angeles', 'New York', 'Chicago'], 0.8);
    expect(result).not.toBeNull();
    expect(result!.value).toBe('Los Angeles');
    expect(result!.similarity).toBeGreaterThan(0.8);
  });

  it('returns null below threshold', () => {
    const result = fuzzyMatch('xyz', ['Los Angeles', 'New York'], 0.8);
    expect(result).toBeNull();
  });

  it('handles empty candidates', () => {
    const result = fuzzyMatch('test', [], 0.8);
    expect(result).toBeNull();
  });

  it('inline lookup uses fuzzy when exact match fails', () => {
    const table = makeInlineTable({
      values: ['Los Angeles', 'New York', 'Chicago', 'San Francisco'],
      fuzzy_match: true,
      fuzzy_threshold: 0.8,
    });

    const result = resolveInlineLookup('Los Angelos', table);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('Los Angeles');
    expect(result.similarity).toBeDefined();
  });

  it('inline lookup rejects distant fuzzy match', () => {
    const table = makeInlineTable({
      values: ['Los Angeles', 'New York'],
      fuzzy_match: true,
      fuzzy_threshold: 0.8,
    });

    const result = resolveInlineLookup('xyz', table);
    expect(result.found).toBe(false);
  });
});

// ─── 5. Collection Source — Tenant-Scoped ──────────────────────────────────

describe('Collection source with LookupEntry model', () => {
  const collectionTable: LookupTableIR = {
    name: 'airports',
    source: 'collection',
    table_name: 'airport_codes',
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
  };

  it('queries LookupEntry with tenant/project scoping', async () => {
    mockLean.mockResolvedValue({ value: 'LAX' });

    const result = await resolveLookup('lax', collectionTable, makeContext());

    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('LAX');

    // Verify the query includes tenant/project scoping
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        tableName: 'airport_codes',
      }),
    );
  });

  it('uses case-insensitive regex when case_sensitive=false', async () => {
    mockLean.mockResolvedValue(null);

    await resolveLookup('lax', collectionTable, makeContext());

    const query = mockFindOne.mock.calls[0][0];
    expect(query.value).toBeInstanceOf(RegExp);
    expect(query.value.flags).toContain('i');
  });

  it('uses exact string when case_sensitive=true', async () => {
    mockLean.mockResolvedValue(null);
    const table = { ...collectionTable, case_sensitive: true };

    await resolveLookup('LAX', table, makeContext());

    const query = mockFindOne.mock.calls[0][0];
    expect(query.value).toBe('LAX');
  });

  it('returns not found when no document matches', async () => {
    mockLean.mockResolvedValue(null);

    const result = await resolveLookup('NOTEXIST', collectionTable, makeContext());

    expect(result.found).toBe(false);
    expect(result.matched_value).toBeUndefined();
  });

  it('returns error when table_name is missing', async () => {
    const table: LookupTableIR = {
      ...collectionTable,
      table_name: undefined,
    };

    const result = await resolveLookup('LAX', table, makeContext());
    expect(result.found).toBe(false);
    expect(result.error).toContain('table_name');
  });

  it('returns error on database failure', async () => {
    mockFindOne.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });

    const result = await resolveLookup('LAX', collectionTable, makeContext());
    expect(result.found).toBe(false);
    expect(result.error).toBe('Collection lookup failed');
  });
});

// ─── 6. Collection Source Cache ────────────────────────────────────────────

describe('Collection source caching', () => {
  const collectionTable: LookupTableIR = {
    name: 'airports',
    source: 'collection',
    table_name: 'airport_codes',
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
  };

  it('returns cached result on second call', async () => {
    mockLean.mockResolvedValue({ value: 'LAX' });

    const ctx = makeContext();
    const result1 = await resolveLookup('lax', collectionTable, ctx);
    const result2 = await resolveLookup('lax', collectionTable, ctx);

    expect(result1.found).toBe(true);
    expect(result2.found).toBe(true);
    expect(result2.matched_value).toBe('LAX');

    // DB should only be called once — second call is from cache
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  it('cache is cleared by clearCaches()', async () => {
    mockLean.mockResolvedValue({ value: 'LAX' });

    const ctx = makeContext();
    await resolveLookup('lax', collectionTable, ctx);
    clearCaches();
    await resolveLookup('lax', collectionTable, ctx);

    // After clearing, DB should be called again
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });
});

// ─── 7. API Timeout ────────────────────────────────────────────────────────

describe('API source timeout', () => {
  it('returns error when API request times out', async () => {
    const table: LookupTableIR = {
      name: 'external',
      source: 'api',
      endpoint: 'https://api.example.com/lookup',
      timeout_ms: 100,
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };

    const slowFetch = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );

    const result = await resolveLookup('test', table, makeContext({ fetchFn: slowFetch as any }));
    expect(result.found).toBe(false);
    expect(result.error).toBe('API lookup failed');
  });

  it('returns error for missing endpoint', async () => {
    const table: LookupTableIR = {
      name: 'external',
      source: 'api',
      endpoint: undefined,
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };

    const result = await resolveLookup('test', table, makeContext());
    expect(result.found).toBe(false);
    expect(result.error).toContain('endpoint');
  });

  it('successful API lookup returns matched value', async () => {
    const table: LookupTableIR = {
      name: 'external',
      source: 'api',
      endpoint: 'https://api.example.com/lookup',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };

    const mockFetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ found: true, matched_value: 'matched!' }),
    });

    const result = await resolveLookup('test', table, makeContext({ fetchFn: mockFetchFn as any }));
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('matched!');
  });

  it('caches successful API responses', async () => {
    const table: LookupTableIR = {
      name: 'external',
      source: 'api',
      endpoint: 'https://api.example.com/lookup',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };

    const mockFetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ found: true, matched_value: 'cached-value' }),
    });

    const ctx = makeContext({ fetchFn: mockFetchFn as any });
    await resolveLookup('test', table, ctx);
    await resolveLookup('test', table, ctx);

    // Fetch should only be called once
    expect(mockFetchFn).toHaveBeenCalledTimes(1);
  });
});

// ─── 8. API Circuit Breaker ────────────────────────────────────────────────

describe('API circuit breaker', () => {
  const apiTable: LookupTableIR = {
    name: 'external',
    source: 'api',
    endpoint: 'https://api.example.com/lookup',
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
  };

  it('opens circuit after 3 consecutive failures', async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const ctx = makeContext({ fetchFn: failingFetch as any });

    // 3 failures to trigger circuit breaker (different values, errors not cached)
    for (let i = 0; i < 3; i++) {
      await resolveLookup(`val-${i}`, apiTable, ctx);
    }

    // 4th call should hit circuit breaker without making a fetch
    const result = await resolveLookup('val-3', apiTable, ctx);

    expect(result.found).toBe(false);
    expect(result.error).toContain('circuit breaker open');
    // Only 3 fetch calls made, not 4
    expect(failingFetch).toHaveBeenCalledTimes(3);
  });

  it('closes circuit after reset timeout', async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const ctx = makeContext({ fetchFn: failingFetch as any });

    // Trigger circuit breaker (different values, errors not cached)
    for (let i = 0; i < 3; i++) {
      await resolveLookup(`val-${i}`, apiTable, ctx);
    }

    // Verify circuit is open
    const openResult = await resolveLookup('test-open', apiTable, ctx);
    expect(openResult.error).toContain('circuit breaker open');

    // Advance time past reset period (30 seconds)
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    // Circuit should now be half-open — next call goes through
    const successFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ found: true, matched_value: 'recovered' }),
    });
    const recoveredCtx = makeContext({ fetchFn: successFetch as any });

    const result = await resolveLookup('test-recovered', apiTable, recoveredCtx);
    expect(result.found).toBe(true);
    expect(result.matched_value).toBe('recovered');

    vi.useRealTimers();
  });

  it('records HTTP error status as failure', async () => {
    const httpErrorFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });
    const ctx = makeContext({ fetchFn: httpErrorFetch as any });

    // 3 HTTP 503 errors to trigger circuit breaker
    // Use different values so caching is not an issue; do NOT clear caches
    // (clearCaches also resets circuit breakers)
    for (let i = 0; i < 3; i++) {
      await resolveLookup(`val-${i}`, apiTable, ctx);
    }

    // Circuit should be open — next call should not reach fetch
    const result = await resolveLookup('test', apiTable, ctx);
    expect(result.error).toContain('circuit breaker open');
  });
});

// ─── 9. Batch Parallel Resolution ──────────────────────────────────────────

describe('Batch resolution', () => {
  it('resolves multiple entries in parallel', async () => {
    const table = makeInlineTable({
      values: ['LAX', 'JFK', 'CDG'],
    });

    const entries = [
      { field: 'origin', value: 'lax', table },
      { field: 'destination', value: 'jfk', table },
      { field: 'unknown', value: 'xyz', table },
    ];

    const results = await resolveLookupBatch(entries, makeContext());

    expect(results.size).toBe(3);
    expect(results.get('origin')?.found).toBe(true);
    expect(results.get('origin')?.matched_value).toBe('LAX');
    expect(results.get('destination')?.found).toBe(true);
    expect(results.get('destination')?.matched_value).toBe('JFK');
    expect(results.get('unknown')?.found).toBe(false);
  });

  it('handles empty entries array', async () => {
    const results = await resolveLookupBatch([], makeContext());
    expect(results.size).toBe(0);
  });

  it('handles mixed source types', async () => {
    const inlineTable = makeInlineTable({ values: ['Alpha', 'Beta'] });
    const collectionTable: LookupTableIR = {
      name: 'db_lookup',
      source: 'collection',
      table_name: 'items',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };

    mockLean.mockResolvedValue({ value: 'DB-Result' });

    const entries = [
      { field: 'inline_field', value: 'alpha', table: inlineTable },
      { field: 'db_field', value: 'something', table: collectionTable },
    ];

    const results = await resolveLookupBatch(entries, makeContext());

    expect(results.get('inline_field')?.found).toBe(true);
    expect(results.get('inline_field')?.matched_value).toBe('Alpha');
    expect(results.get('db_field')?.found).toBe(true);
    expect(results.get('db_field')?.matched_value).toBe('DB-Result');
  });
});

// ─── 10. SSRF Protection ───────────────────────────────────────────────────

describe('SSRF protection', () => {
  it('blocks private IP addresses in API endpoints', async () => {
    const table: LookupTableIR = {
      name: 'malicious',
      source: 'api',
      endpoint: 'http://169.254.169.254/latest/meta-data/',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };

    const result = await resolveLookup('test', table, makeContext());

    expect(result.found).toBe(false);
    expect(result.error).toContain('blocked');
  });

  it('blocks localhost in production mode', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const table: LookupTableIR = {
      name: 'local',
      source: 'api',
      endpoint: 'http://localhost:8080/lookup',
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    };

    const result = await resolveLookup('test', table, makeContext());

    expect(result.found).toBe(false);
    expect(result.error).toContain('blocked');

    process.env.NODE_ENV = originalEnv;
  });
});

// ─── 11. Unknown Source ────────────────────────────────────────────────────

describe('Unknown source type', () => {
  it('returns error for unrecognized source', async () => {
    const table = {
      name: 'weird',
      source: 'graphql' as any,
      case_sensitive: false,
      fuzzy_match: false,
      fuzzy_threshold: 0.85,
    } as LookupTableIR;

    const result = await resolveLookup('test', table, makeContext());
    expect(result.found).toBe(false);
    expect(result.error).toContain('Unknown lookup source');
  });
});

// ─── 12. Missing Context ──────────────────────────────────────────────────

describe('Missing context for collection source', () => {
  const collectionTable: LookupTableIR = {
    name: 'airports',
    source: 'collection',
    table_name: 'airport_codes',
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
  };

  it('returns error when tenantId is missing', async () => {
    const result = await resolveLookup('LAX', collectionTable, {
      tenantId: '',
      projectId: 'project-1',
    });
    expect(result.found).toBe(false);
    expect(result.error).toContain('tenant and project context');
  });

  it('returns error when projectId is missing', async () => {
    const result = await resolveLookup('LAX', collectionTable, {
      tenantId: 'tenant-1',
      projectId: '',
    });
    expect(result.found).toBe(false);
    expect(result.error).toContain('tenant and project context');
  });
});
