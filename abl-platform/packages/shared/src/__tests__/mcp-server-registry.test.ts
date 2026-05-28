/**
 * MCPServerRegistryService Tests
 *
 * Coverage:
 * - getServerConfigs: DB load, cache hit/miss, TTL expiry
 * - getServerConfigs: project verification gate
 * - getServerConfigs: graceful error handling (returns [])
 * - getServerConfigs: bounded cache eviction at MAX_CACHE_SIZE
 * - toServerConfig: env decryption, JSON validation, string-value enforcement
 * - toServerConfig: null on decryption failure
 * - toServerConfig: null when URL blocked by SSRF validator
 * - toServerConfig: tags parsed from JSON string
 * - invalidate / invalidateAll
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ─── Mock for structured logger used by the implementation ─────────────────────
const { mockLogError, mockLogWarn, mockLogInfo } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    child: vi.fn().mockReturnThis(),
    setCorrelationId: vi.fn(),
  }),
}));

// ─── Module-level mock for the dynamic import inside getServerConfigs ─────────
// The source uses:  await import('../repos/mcp-server-config-repo.js')
// Vitest resolves this relative to the source file, so we mock by the same path.
const mockFindMcpServerConfigsByProject: Mock = vi.fn();

vi.mock('../repos/mcp-server-config-repo.js', () => ({
  findMcpServerConfigsByProject: (...args: unknown[]) => mockFindMcpServerConfigsByProject(...args),
}));

// Import AFTER vi.mock so the mock is in place
import {
  MCPServerRegistryService,
  type MCPDecryptor,
  type ProjectVerifier,
  type UrlValidator,
} from '../services/mcp-server-registry.js';
import type { NormalizedMCPServerConfig } from '../types/mcp-server.js';

// =============================================================================
// Helpers
// =============================================================================

function makeRow(overrides: Partial<NormalizedMCPServerConfig> = {}): NormalizedMCPServerConfig {
  return {
    id: 'srv-1',
    tenantId: 'tenant-a',
    projectId: 'proj-1',
    name: 'test-server',
    transport: 'sse',
    url: 'https://mcp.example.com/sse',
    encryptedEnv: null,
    priority: 0,
    tags: null,
    connectionTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    autoReconnect: false,
    maxReconnectAttempts: 3,
    lastConnectionStatus: null,
    lastConnectionAt: null,
    lastConnectionLatencyMs: null,
    lastConnectionToolCount: null,
    lastConnectionError: null,
    createdBy: null,
    modifiedBy: null,
    _v: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDecryptor(result: string | Error = '{}'): MCPDecryptor {
  return {
    decryptForTenant: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

// =============================================================================
// Test suite
// =============================================================================

const TENANT = 'tenant-a';
const PROJECT = 'proj-1';

beforeEach(() => {
  vi.useFakeTimers();
  mockFindMcpServerConfigsByProject.mockReset();
  mockLogError.mockReset();
  mockLogWarn.mockReset();
  mockLogInfo.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── getServerConfigs — DB load and basic mapping ─────────────────────────────

describe('MCPServerRegistryService.getServerConfigs — DB load', () => {
  it('returns configs loaded from DB', async () => {
    const row = makeRow({ id: 'srv-1', name: 'my-server', url: 'https://mcp.example.com/sse' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('srv-1');
    expect(result[0].name).toBe('my-server');
    expect(result[0].url).toBe('https://mcp.example.com/sse');
    expect(result[0].transport).toBe('sse');
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledOnce();
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledWith(TENANT, PROJECT);
  });

  it('maps optional fields: priority, connectionTimeoutMs, requestTimeoutMs, autoReconnect, maxReconnectAttempts', async () => {
    const row = makeRow({
      priority: 5,
      connectionTimeoutMs: 5_000,
      requestTimeoutMs: 15_000,
      autoReconnect: true,
      maxReconnectAttempts: 10,
    });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg.priority).toBe(5);
    expect(cfg.connectionTimeoutMs).toBe(5_000);
    expect(cfg.requestTimeoutMs).toBe(15_000);
    expect(cfg.autoReconnect).toBe(true);
    expect(cfg.maxReconnectAttempts).toBe(10);
  });

  it('returns empty array when DB returns no rows', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toEqual([]);
  });

  it('filters out null configs (e.g. from failed decryption)', async () => {
    // First row: env decryption will fail → null
    // Second row: valid → included
    const rowBad = makeRow({ id: 'srv-bad', encryptedEnv: 'ciphertext' });
    const rowGood = makeRow({ id: 'srv-good', encryptedEnv: null });
    mockFindMcpServerConfigsByProject.mockResolvedValue([rowBad, rowGood]);

    // Decryptor throws only for the bad one (we simulate by making it throw always
    // but the bad row has encryptedEnv — easiest to test via the url-blocked path instead)
    const decryptor: MCPDecryptor = {
      decryptForTenant: vi.fn().mockRejectedValue(new Error('key not found')),
    };
    const svc = new MCPServerRegistryService(decryptor);
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    // rowBad is filtered (decryption failed), rowGood passes (no encryptedEnv)
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('srv-good');
  });
});

// ─── getServerConfigs — caching ───────────────────────────────────────────────

describe('MCPServerRegistryService.getServerConfigs — caching', () => {
  it('returns cached result within TTL without re-querying DB', async () => {
    const row = makeRow();
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());

    // First call: populates cache
    await svc.getServerConfigs(TENANT, PROJECT);
    // Second call within TTL
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(1);
    // DB was only queried once
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledOnce();
  });

  it('re-fetches from DB after TTL expires (60 s)', async () => {
    const row = makeRow();
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());

    // First call
    await svc.getServerConfigs(TENANT, PROJECT);
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(1);

    // Advance past 60 s TTL
    vi.advanceTimersByTime(61_000);

    // Second call after TTL should re-query
    await svc.getServerConfigs(TENANT, PROJECT);
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(2);
  });

  it('caches per (tenantId, projectId) key — different keys are independent', async () => {
    const row = makeRow();
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());

    await svc.getServerConfigs('tenant-a', 'proj-1');
    await svc.getServerConfigs('tenant-a', 'proj-2');
    await svc.getServerConfigs('tenant-b', 'proj-1');

    // Each distinct key should have triggered its own DB query
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(3);

    // Repeated calls with same keys should NOT trigger new queries
    await svc.getServerConfigs('tenant-a', 'proj-1');
    await svc.getServerConfigs('tenant-a', 'proj-2');
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(3);
  });
});

// ─── getServerConfigs — project verification gate ─────────────────────────────

describe('MCPServerRegistryService.getServerConfigs — verifyProject', () => {
  it('returns [] when verifyProject returns false', async () => {
    const verifier: ProjectVerifier = vi.fn().mockResolvedValue(false);
    const svc = new MCPServerRegistryService(makeDecryptor(), verifier);

    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toEqual([]);
    expect(mockFindMcpServerConfigsByProject).not.toHaveBeenCalled();
  });

  it('proceeds to DB load when verifyProject returns true', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([makeRow()]);
    const verifier: ProjectVerifier = vi.fn().mockResolvedValue(true);
    const svc = new MCPServerRegistryService(makeDecryptor(), verifier);

    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(1);
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledOnce();
  });

  it('calls verifyProject with (projectId, tenantId) — note arg order', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([]);
    const verifier: ProjectVerifier = vi.fn().mockResolvedValue(true);
    const svc = new MCPServerRegistryService(makeDecryptor(), verifier);

    await svc.getServerConfigs(TENANT, PROJECT);

    expect(verifier).toHaveBeenCalledWith(PROJECT, TENANT);
  });
});

// ─── getServerConfigs — error handling ────────────────────────────────────────

describe('MCPServerRegistryService.getServerConfigs — error handling', () => {
  it('returns [] and does not throw when DB query fails', async () => {
    mockFindMcpServerConfigsByProject.mockRejectedValue(new Error('mongo connection refused'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const svc = new MCPServerRegistryService(makeDecryptor());
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toEqual([]);
  });

  it('logs the error context when DB query fails', async () => {
    mockLogError.mockClear();
    mockFindMcpServerConfigsByProject.mockRejectedValue(new Error('timeout'));

    const svc = new MCPServerRegistryService(makeDecryptor());
    await svc.getServerConfigs(TENANT, PROJECT);

    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load MCP server configs'),
      expect.objectContaining({ tenantId: TENANT, projectId: PROJECT }),
    );
  });

  it('returns [] and does not throw when verifyProject throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const verifier: ProjectVerifier = vi.fn().mockRejectedValue(new Error('auth service down'));
    const svc = new MCPServerRegistryService(makeDecryptor(), verifier);

    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toEqual([]);
  });
});

// ─── getServerConfigs — bounded cache eviction ────────────────────────────────

describe('MCPServerRegistryService.getServerConfigs — cache eviction at MAX_CACHE_SIZE', () => {
  it('evicts the oldest cache entry when size reaches 500', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([]);

    const svc = new MCPServerRegistryService(makeDecryptor());

    // Fill cache to MAX_CACHE_SIZE (500) using unique (tenantId, projectId) pairs
    const CAPACITY = 500;
    for (let i = 0; i < CAPACITY; i++) {
      // Stagger time so entries have different loadedAt — advancing fake timers
      // ensures the Map insertion order tracks oldest-first
      await svc.getServerConfigs('tenant-fill', `proj-${i}`);
    }

    // At this point the cache has 500 entries; 'tenant-fill:proj-0' is the oldest.
    // Adding one more new key must evict the oldest entry.
    await svc.getServerConfigs('tenant-new', 'proj-extra');

    // The new key should be fresh (cached), so calling it again hits the cache (1 call total)
    mockFindMcpServerConfigsByProject.mockClear();
    await svc.getServerConfigs('tenant-new', 'proj-extra');
    expect(mockFindMcpServerConfigsByProject).not.toHaveBeenCalled();

    // The oldest entry ('tenant-fill:proj-0') should have been evicted —
    // calling it again should re-query the DB.
    await svc.getServerConfigs('tenant-fill', 'proj-0');
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledOnce();
  });
});

// ─── toServerConfig — env decryption ─────────────────────────────────────────

describe('MCPServerRegistryService — toServerConfig env decryption', () => {
  it('decrypts encryptedEnv and attaches env to output', async () => {
    const encryptedEnv = 'encrypted-blob';
    const plainEnv = JSON.stringify({ API_KEY: 'secret', BASE_URL: 'https://api.example.com' });
    const decryptor = makeDecryptor(plainEnv);
    const row = makeRow({ encryptedEnv });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(decryptor);
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg).toBeDefined();
    expect(cfg.env).toEqual({ API_KEY: 'secret', BASE_URL: 'https://api.example.com' });
    expect(decryptor.decryptForTenant).toHaveBeenCalledWith(encryptedEnv, TENANT);
  });

  it('leaves env undefined when encryptedEnv is null', async () => {
    const row = makeRow({ encryptedEnv: null });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg.env).toBeUndefined();
  });

  it('returns null (skips server) when decrypted env is not an object', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = makeRow({ encryptedEnv: 'encrypted-blob' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    // Decrypts to a JSON array instead of an object
    const svc = new MCPServerRegistryService(makeDecryptor('["not","an","object"]'));
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(0);
  });

  it('returns null (skips server) when decrypted env is null literal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = makeRow({ encryptedEnv: 'encrypted-blob' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor('null'));
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(0);
  });

  it('returns null (skips server) when env values are not strings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = makeRow({ encryptedEnv: 'encrypted-blob' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    // One value is a number — invalid
    const svc = new MCPServerRegistryService(makeDecryptor(JSON.stringify({ PORT: 8080 })));
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(0);
  });

  it('returns null (skips server) when decryption throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = makeRow({ encryptedEnv: 'corrupted-blob' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor(new Error('decryption key expired')));
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(0);
  });
});

// ─── toServerConfig — tags parsing ────────────────────────────────────────────

describe('MCPServerRegistryService — toServerConfig tags', () => {
  it('parses tags from a valid JSON string', async () => {
    const row = makeRow({ tags: '["prod","eu-west"]' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg.tags).toEqual(['prod', 'eu-west']);
  });

  it('leaves tags undefined when tags field is null', async () => {
    const row = makeRow({ tags: null });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg.tags).toBeUndefined();
  });

  it('silently skips invalid tags JSON and leaves tags undefined', async () => {
    // No console.error expected — invalid tags are non-critical
    const row = makeRow({ tags: 'not-valid-json' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg.tags).toBeUndefined();
  });
});

// ─── toServerConfig — SSRF URL validation ────────────────────────────────────

describe('MCPServerRegistryService — toServerConfig SSRF URL validation', () => {
  it('skips server and returns null when URL is blocked by SSRF validator', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = makeRow({ url: 'http://169.254.169.254/latest/meta-data/' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const urlValidator: UrlValidator = vi.fn().mockReturnValue({
      safe: false,
      reason: 'AWS metadata endpoint blocked',
    });
    const svc = new MCPServerRegistryService(makeDecryptor(), undefined, urlValidator);
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(0);
    expect(urlValidator).toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data/');
  });

  it('includes server when URL passes SSRF validator', async () => {
    const row = makeRow({ url: 'https://mcp.example.com/sse' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const urlValidator: UrlValidator = vi.fn().mockReturnValue({ safe: true });
    const svc = new MCPServerRegistryService(makeDecryptor(), undefined, urlValidator);
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://mcp.example.com/sse');
  });

  it('skips URL validation when no urlValidator injected', async () => {
    const row = makeRow({ url: 'http://192.168.1.1/sse' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    // No validator — should not throw, should include the server
    const svc = new MCPServerRegistryService(makeDecryptor());
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(1);
  });

  it('skips URL validation when url field is null/undefined', async () => {
    const row = makeRow({ url: null });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const urlValidator: UrlValidator = vi.fn().mockReturnValue({ safe: true });
    const svc = new MCPServerRegistryService(makeDecryptor(), undefined, urlValidator);
    const result = await svc.getServerConfigs(TENANT, PROJECT);

    expect(result).toHaveLength(1);
    // Validator should NOT be called for a null/undefined URL
    expect(urlValidator).not.toHaveBeenCalled();
  });

  it('logs blocked URL with context', async () => {
    mockLogWarn.mockClear();
    const row = makeRow({ name: 'danger-server', url: 'http://10.0.0.1/sse' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const urlValidator: UrlValidator = () => ({ safe: false, reason: 'private range' });
    const svc = new MCPServerRegistryService(makeDecryptor(), undefined, urlValidator);
    await svc.getServerConfigs(TENANT, PROJECT);

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('URL blocked'),
      expect.objectContaining({
        server: 'danger-server',
        url: 'http://10.0.0.1/sse',
        reason: 'private range',
      }),
    );
  });
});

// ─── invalidate ───────────────────────────────────────────────────────────────

describe('MCPServerRegistryService.invalidate', () => {
  it('removes a specific cache entry so the next call re-queries the DB', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([makeRow()]);

    const svc = new MCPServerRegistryService(makeDecryptor());

    // Warm cache
    await svc.getServerConfigs(TENANT, PROJECT);
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(1);

    // Invalidate this specific key
    svc.invalidate(TENANT, PROJECT);

    // Should re-fetch
    await svc.getServerConfigs(TENANT, PROJECT);
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(2);
  });

  it('does not affect other cached entries', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([]);

    const svc = new MCPServerRegistryService(makeDecryptor());

    // Warm two different keys
    await svc.getServerConfigs('tenant-a', 'proj-1');
    await svc.getServerConfigs('tenant-a', 'proj-2');
    mockFindMcpServerConfigsByProject.mockClear();

    // Invalidate only the first
    svc.invalidate('tenant-a', 'proj-1');

    // proj-2 should still be cached
    await svc.getServerConfigs('tenant-a', 'proj-2');
    expect(mockFindMcpServerConfigsByProject).not.toHaveBeenCalled();

    // proj-1 should re-fetch
    await svc.getServerConfigs('tenant-a', 'proj-1');
    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the key does not exist in the cache', () => {
    const svc = new MCPServerRegistryService(makeDecryptor());
    // Should not throw
    expect(() => svc.invalidate('nonexistent', 'proj-x')).not.toThrow();
  });
});

// ─── invalidateAll ────────────────────────────────────────────────────────────

describe('MCPServerRegistryService.invalidateAll', () => {
  it('clears all cache entries so every subsequent call re-fetches', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([]);

    const svc = new MCPServerRegistryService(makeDecryptor());

    await svc.getServerConfigs('tenant-a', 'proj-1');
    await svc.getServerConfigs('tenant-a', 'proj-2');
    await svc.getServerConfigs('tenant-b', 'proj-1');
    mockFindMcpServerConfigsByProject.mockClear();

    svc.invalidateAll();

    await svc.getServerConfigs('tenant-a', 'proj-1');
    await svc.getServerConfigs('tenant-a', 'proj-2');
    await svc.getServerConfigs('tenant-b', 'proj-1');

    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledTimes(3);
  });

  it('is a no-op on an empty cache', () => {
    const svc = new MCPServerRegistryService(makeDecryptor());
    expect(() => svc.invalidateAll()).not.toThrow();
  });
});

// ─── toServerConfig — auth headers decryption and resolution ──────────────────

describe('MCPServerRegistryService — toServerConfig auth headers', () => {
  it('decrypts auth config and resolves auth headers for bearer type', async () => {
    const encryptedAuthConfig = 'encrypted-auth-blob';
    const decryptor: MCPDecryptor = {
      decryptForTenant: vi.fn().mockResolvedValue(JSON.stringify({ token: 'my-bearer-token' })),
    };
    const row = makeRow({
      encryptedAuthConfig,
      authType: 'bearer',
    });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(decryptor);
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg).toBeDefined();
    expect(cfg.authType).toBe('bearer');
    expect(cfg.headers).toBeDefined();
    expect(cfg.headers!.Authorization).toContain('Bearer');
  });

  it('skips server when auth decryption fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const decryptor: MCPDecryptor = {
      decryptForTenant: vi.fn().mockRejectedValue(new Error('key expired')),
    };
    const row = makeRow({
      encryptedAuthConfig: 'encrypted-auth-blob',
      authType: 'bearer',
    });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(decryptor);
    const result = await svc.getServerConfigs(TENANT, PROJECT);
    expect(result).toHaveLength(0);
  });

  it('skips server when resolveAuthHeaders throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const decryptor: MCPDecryptor = {
      decryptForTenant: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ tokenEndpoint: 'http://not-https.com/token' })),
    };
    const row = makeRow({
      encryptedAuthConfig: 'encrypted-auth-blob',
      authType: 'oauth2_client_credentials',
    });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(decryptor);
    const result = await svc.getServerConfigs(TENANT, PROJECT);
    expect(result).toHaveLength(0);
  });

  it('skips auth header resolution when authType is none', async () => {
    const decryptor: MCPDecryptor = {
      decryptForTenant: vi.fn(),
    };
    const row = makeRow({
      encryptedAuthConfig: null,
      authType: 'none',
    });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(decryptor);
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    expect(cfg.authType).toBeUndefined();
    expect(cfg.headers).toBeUndefined();
    expect(decryptor.decryptForTenant).not.toHaveBeenCalled();
  });

  it('skips auth header resolution when encryptedAuthConfig is null', async () => {
    const decryptor: MCPDecryptor = {
      decryptForTenant: vi.fn(),
    };
    const row = makeRow({
      encryptedAuthConfig: null,
      authType: 'bearer',
    });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(decryptor);
    const [cfg] = await svc.getServerConfigs(TENANT, PROJECT);

    // No encrypted auth config, so no headers resolved
    expect(cfg.headers).toBeUndefined();
    expect(decryptor.decryptForTenant).not.toHaveBeenCalled();
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('MCPServerRegistryService — tenant isolation', () => {
  it('passes tenantId to decryptForTenant for each row', async () => {
    const encryptedEnv = 'enc-blob';
    const plainEnv = JSON.stringify({ TOKEN: 'abc' });
    const decryptor: MCPDecryptor = {
      decryptForTenant: vi.fn().mockResolvedValue(plainEnv),
    };
    const row = makeRow({ encryptedEnv, tenantId: 'tenant-a' });
    mockFindMcpServerConfigsByProject.mockResolvedValue([row]);

    const svc = new MCPServerRegistryService(decryptor);
    await svc.getServerConfigs('tenant-a', PROJECT);

    expect(decryptor.decryptForTenant).toHaveBeenCalledWith(encryptedEnv, 'tenant-a');
  });

  it('passes tenantId and projectId to findMcpServerConfigsByProject', async () => {
    mockFindMcpServerConfigsByProject.mockResolvedValue([]);

    const svc = new MCPServerRegistryService(makeDecryptor());
    await svc.getServerConfigs('tenant-x', 'proj-y');

    expect(mockFindMcpServerConfigsByProject).toHaveBeenCalledWith('tenant-x', 'proj-y');
  });
});
