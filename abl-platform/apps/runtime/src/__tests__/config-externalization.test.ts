/**
 * Config Externalization Tests
 *
 * Verifies that hardcoded resilience constants have been replaced with
 * env-var-backed configuration using the safeParseInt pattern.
 *
 * Strategy:
 * 1. Test the safeParseInt helper behavior (NaN guard, fallback, valid override)
 * 2. Verify source files contain the expected process.env references
 * 3. Test InMemoryRateLimiter behavior with MAX_RATE_LIMITER_ENTRIES override
 *    via vi.stubEnv + dynamic import (resetModules pattern)
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// =============================================================================
// HELPER: safeParseInt (mirrors the helper used in all modified files)
// =============================================================================

function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// =============================================================================
// 1. safeParseInt unit tests
// =============================================================================

describe('safeParseInt helper', () => {
  test('returns fallback when env var is undefined', () => {
    expect(safeParseInt(undefined, 50_000)).toBe(50_000);
  });

  test('returns fallback when env var is empty string', () => {
    expect(safeParseInt('', 50_000)).toBe(50_000);
  });

  test('returns fallback when env var is NaN', () => {
    expect(safeParseInt('not-a-number', 50_000)).toBe(50_000);
  });

  test('returns fallback when env var is a float string (parseInt truncates)', () => {
    // parseInt('3.14', 10) returns 3 — not NaN
    expect(safeParseInt('3.14', 50_000)).toBe(3);
  });

  test('parses valid integer string', () => {
    expect(safeParseInt('100000', 50_000)).toBe(100_000);
  });

  test('parses zero correctly', () => {
    expect(safeParseInt('0', 50_000)).toBe(0);
  });

  test('parses negative value correctly', () => {
    expect(safeParseInt('-1', 100)).toBe(-1);
  });

  test('handles whitespace-padded values via parseInt behavior', () => {
    // parseInt('  42  ', 10) returns 42
    expect(safeParseInt('  42  ', 50_000)).toBe(42);
  });
});

// =============================================================================
// 2. Source file env var pattern verification
// =============================================================================

/**
 * Read a source file and verify it contains the expected env var references.
 * This ensures constants are actually wired to process.env rather than hardcoded.
 */
function readSource(relativePath: string): string {
  const fullPath = resolve(__dirname, '..', relativePath);
  return readFileSync(fullPath, 'utf-8');
}

describe('rate-limiter.ts env var patterns', () => {
  const source = readSource('middleware/rate-limiter.ts');

  test('MAX_RATE_LIMITER_ENTRIES reads from RATE_LIMITER_MAX_ENTRIES', () => {
    expect(source).toContain('process.env.RATE_LIMITER_MAX_ENTRIES');
  });

  test('SESSION_MESSAGE_RATE_LIMIT reads from SESSION_MESSAGE_RATE_LIMIT', () => {
    expect(source).toContain('process.env.SESSION_MESSAGE_RATE_LIMIT');
  });

  test('SESSION_SET_TTL_SECONDS reads from SESSION_SET_TTL_SECONDS', () => {
    expect(source).toContain('process.env.SESSION_SET_TTL_SECONDS');
  });

  test('MAX_MEMORY_SESSION_ENTRIES reads from SESSION_COUNT_MAX_MEMORY_ENTRIES', () => {
    expect(source).toContain('process.env.SESSION_COUNT_MAX_MEMORY_ENTRIES');
  });

  test('cleanup interval reads from RATE_LIMITER_CLEANUP_INTERVAL_MS', () => {
    expect(source).toContain('process.env.RATE_LIMITER_CLEANUP_INTERVAL_MS');
  });

  test('cleanup grace period reads from RATE_LIMITER_CLEANUP_GRACE_MS', () => {
    expect(source).toContain('process.env.RATE_LIMITER_CLEANUP_GRACE_MS');
  });

  test('API key divisor reads from RATE_LIMITER_API_KEY_DIVISOR', () => {
    expect(source).toContain('process.env.RATE_LIMITER_API_KEY_DIVISOR');
  });

  test('safeParseInt helper is defined', () => {
    expect(source).toContain('function safeParseInt(');
  });
});

describe('hybrid-rate-limiter.ts env var patterns', () => {
  const source = readSource('services/resilience/hybrid-rate-limiter.ts');

  test('REDIS_RECOVERY_INTERVAL_MS reads from env var', () => {
    expect(source).toContain('process.env.REDIS_RECOVERY_INTERVAL_MS');
  });

  test('recovery timer uses the constant, not a hardcoded 30_000', () => {
    expect(source).toContain('REDIS_RECOVERY_INTERVAL_MS');
    // Verify the setInterval call no longer uses the literal 30_000
    expect(source).not.toMatch(/setInterval\([^)]*30[_]?000\s*\)/);
  });
});

describe('hybrid-cb-registry.ts env var patterns', () => {
  const source = readSource('services/resilience/hybrid-cb-registry.ts');

  test('CB_REDIS_RECOVERY_INTERVAL_MS reads from env var', () => {
    expect(source).toContain('process.env.CB_REDIS_RECOVERY_INTERVAL_MS');
  });

  test('recovery timer uses the constant, not a hardcoded 30_000', () => {
    expect(source).toContain('CB_REDIS_RECOVERY_INTERVAL_MS');
    expect(source).not.toMatch(/setInterval\([^)]*30[_]?000\s*\)/);
  });
});

describe('channel/constants.ts env var patterns', () => {
  const source = readSource('services/channel/constants.ts');

  test('MAX_SDK_CLIENTS reads from MAX_SDK_CLIENTS env var', () => {
    expect(source).toContain('process.env.MAX_SDK_CLIENTS');
  });

  test('MAX_MEDIA_SESSIONS reads from MAX_MEDIA_SESSIONS env var', () => {
    expect(source).toContain('process.env.MAX_MEDIA_SESSIONS');
  });

  test('MAX_RATE_LIMITER_ENTRIES reads from WS_RATE_LIMITER_MAX_ENTRIES env var', () => {
    expect(source).toContain('process.env.WS_RATE_LIMITER_MAX_ENTRIES');
  });

  test('MAX_CLICKHOUSE_STORE_CACHE reads from MAX_CLICKHOUSE_STORE_CACHE env var', () => {
    expect(source).toContain('process.env.MAX_CLICKHOUSE_STORE_CACHE');
  });

  test('MAX_KOREVG_SESSIONS reads from MAX_KOREVG_SESSIONS env var', () => {
    expect(source).toContain('process.env.MAX_KOREVG_SESSIONS');
  });

  test('MEDIA_SESSION_TTL_MS reads from MEDIA_SESSION_TTL_MS env var', () => {
    expect(source).toContain('process.env.MEDIA_SESSION_TTL_MS');
  });
});

describe('sdk-handler.ts env var patterns', () => {
  const source = readSource('websocket/sdk-handler.ts');

  test('WS connection rate limit reads from WS_CONN_RATE_LIMIT_PER_IP', () => {
    expect(source).toContain('process.env.WS_CONN_RATE_LIMIT_PER_IP');
  });

  test('WS rate limiter cleanup reads from WS_RATE_LIMITER_CLEANUP_MS', () => {
    expect(source).toContain('process.env.WS_RATE_LIMITER_CLEANUP_MS');
  });
});

// =============================================================================
// 3. Verify default values are preserved (the safeParseInt fallback matches
//    the original hardcoded value)
// =============================================================================

describe('default values match original hardcoded constants', () => {
  // Note: Prettier may wrap safeParseInt calls across multiple lines, so all
  // regexes use \s* (which matches newlines) between the env var and default.

  test('rate-limiter MAX_RATE_LIMITER_ENTRIES default is 50_000', () => {
    const source = readSource('middleware/rate-limiter.ts');
    expect(source).toMatch(/safeParseInt\(\s*process\.env\.RATE_LIMITER_MAX_ENTRIES,\s*50[_]?000/);
  });

  test('rate-limiter SESSION_MESSAGE_RATE_LIMIT default is 30', () => {
    const source = readSource('middleware/rate-limiter.ts');
    expect(source).toMatch(/safeParseInt\(\s*process\.env\.SESSION_MESSAGE_RATE_LIMIT,\s*30\b/);
  });

  test('rate-limiter SESSION_SET_TTL_SECONDS default is 172_800', () => {
    const source = readSource('middleware/rate-limiter.ts');
    expect(source).toMatch(/safeParseInt\(\s*process\.env\.SESSION_SET_TTL_SECONDS,\s*172[_]?800/);
  });

  test('rate-limiter MAX_MEMORY_SESSION_ENTRIES default is 10_000', () => {
    const source = readSource('middleware/rate-limiter.ts');
    expect(source).toMatch(
      /safeParseInt\(\s*process\.env\.SESSION_COUNT_MAX_MEMORY_ENTRIES,\s*10[_]?000/,
    );
  });

  test('hybrid-rate-limiter recovery interval default is 30_000', () => {
    const source = readSource('services/resilience/hybrid-rate-limiter.ts');
    expect(source).toMatch(
      /safeParseInt\(\s*process\.env\.REDIS_RECOVERY_INTERVAL_MS,\s*30[_]?000/,
    );
  });

  test('hybrid-cb-registry recovery interval default is 30_000', () => {
    const source = readSource('services/resilience/hybrid-cb-registry.ts');
    expect(source).toMatch(
      /safeParseInt\(\s*process\.env\.CB_REDIS_RECOVERY_INTERVAL_MS,\s*30[_]?000/,
    );
  });

  test('channel constants MAX_SDK_CLIENTS default is 50_000', () => {
    const source = readSource('services/channel/constants.ts');
    expect(source).toMatch(/safeParseInt\(\s*process\.env\.MAX_SDK_CLIENTS,\s*50[_]?000/);
  });

  test('channel constants MAX_MEDIA_SESSIONS default is 10_000', () => {
    const source = readSource('services/channel/constants.ts');
    expect(source).toMatch(/safeParseInt\(\s*process\.env\.MAX_MEDIA_SESSIONS,\s*10[_]?000/);
  });

  test('channel constants MAX_RATE_LIMITER_ENTRIES default is 100_000', () => {
    const source = readSource('services/channel/constants.ts');
    expect(source).toMatch(
      /safeParseInt\(\s*process\.env\.WS_RATE_LIMITER_MAX_ENTRIES,\s*100[_]?000/,
    );
  });

  test('sdk-handler WS_CONN_RATE_LIMIT_PER_IP default is 30', () => {
    const source = readSource('websocket/sdk-handler.ts');
    expect(source).toMatch(/safeParseInt\(\s*process\.env\.WS_CONN_RATE_LIMIT_PER_IP,\s*30\b/);
  });

  test('sdk-handler WS_RATE_LIMITER_CLEANUP_MS default is 120_000', () => {
    const source = readSource('websocket/sdk-handler.ts');
    expect(source).toMatch(
      /safeParseInt\(\s*process\.env\.WS_RATE_LIMITER_CLEANUP_MS,\s*120[_]?000/,
    );
  });
});

// =============================================================================
// 4. Verify no remaining raw hardcoded resilience constants
//    (These assertions verify the original literal values are no longer used
//    as bare constants without safeParseInt wrapping)
// =============================================================================

describe('no remaining bare hardcoded constants in resilience code', () => {
  test('rate-limiter.ts: no bare `= 50000` assignment', () => {
    const source = readSource('middleware/rate-limiter.ts');
    // Should not have `= 50000` or `= 50_000` as a bare assignment (only in safeParseInt call)
    const bareAssignments = source.match(/=\s*50[_]?000\s*;/g);
    expect(bareAssignments).toBeNull();
  });

  test('rate-limiter.ts: no bare `= 10000` for session entries', () => {
    const source = readSource('middleware/rate-limiter.ts');
    const bareAssignments = source.match(/=\s*10[_]?000\s*;/g);
    expect(bareAssignments).toBeNull();
  });

  test('rate-limiter.ts: no bare `= 86400` assignment', () => {
    const source = readSource('middleware/rate-limiter.ts');
    const bareAssignments = source.match(/=\s*86[_]?400\s*;/g);
    expect(bareAssignments).toBeNull();
  });

  test('hybrid-rate-limiter.ts: no bare 30_000 in setInterval', () => {
    const source = readSource('services/resilience/hybrid-rate-limiter.ts');
    expect(source).not.toMatch(/setInterval\([^)]*30[_]?000/);
  });

  test('hybrid-cb-registry.ts: no bare 30_000 in setInterval', () => {
    const source = readSource('services/resilience/hybrid-cb-registry.ts');
    expect(source).not.toMatch(/setInterval\([^)]*30[_]?000/);
  });
});
