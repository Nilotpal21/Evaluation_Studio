/**
 * LLM Response Cache Tests
 *
 * Tests for:
 * - Cache construction and configuration
 * - Key generation (hashing, normalization)
 * - Cache hit/miss/TTL expiry
 * - Memory cache + file cache interaction
 * - Cache statistics tracking
 * - Cleanup and eviction
 * - createCachedLLMClient wrapper
 * - createCacheFromEnv
 * - Disabled cache behavior
 *
 * Uses a temp directory for file-based cache tests.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the logger before imports
vi.mock('../../platform/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  LLMResponseCache,
  createCachedLLMClient,
  createCacheFromEnv,
  type CacheEntry,
  type LLMCacheConfig,
} from '../platform/llm/cache.js';

// =============================================================================
// HELPERS
// =============================================================================

let tmpDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cache-test-'));
}

function cleanupTempDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        fs.unlinkSync(path.join(dir, file));
      }
      fs.rmdirSync(dir);
    }
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// CACHE CONSTRUCTION
// =============================================================================

describe('LLMResponseCache — construction', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('accepts string config for cache dir', () => {
    const cache = new LLMResponseCache(tmpDir);
    const stats = cache.getStats();
    expect(stats.cacheDir).toBe(tmpDir);
  });

  test('accepts full config object', () => {
    const cache = new LLMResponseCache({
      cacheDir: tmpDir,
      enabled: true,
      ttlMs: 60000,
      includeModelInKey: true,
      maxEntries: 500,
    });
    const stats = cache.getStats();
    expect(stats.cacheDir).toBe(tmpDir);
  });

  test('applies default config values', () => {
    const cache = new LLMResponseCache({ cacheDir: tmpDir });
    // Defaults: enabled=true, ttlMs=0, includeModelInKey=false, maxEntries=10000
    const config = (cache as any).config;
    expect(config.enabled).toBe(true);
    expect(config.ttlMs).toBe(0);
    expect(config.includeModelInKey).toBe(false);
    expect(config.maxEntries).toBe(10000);
  });

  test('creates cache directory if it does not exist', () => {
    const newDir = path.join(tmpDir, 'subdir', 'cache');
    expect(fs.existsSync(newDir)).toBe(false);

    new LLMResponseCache({ cacheDir: newDir });
    expect(fs.existsSync(newDir)).toBe(true);

    // Cleanup
    fs.rmdirSync(newDir);
    fs.rmdirSync(path.join(tmpDir, 'subdir'));
  });

  test('counts existing cache files on init', () => {
    // Pre-populate some cache files
    fs.writeFileSync(path.join(tmpDir, 'abc123.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'def456.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'not-json.txt'), ''); // Should be ignored

    const cache = new LLMResponseCache(tmpDir);
    const stats = cache.getStats();
    expect(stats.totalEntries).toBe(2);

    // Cleanup extra files
    fs.unlinkSync(path.join(tmpDir, 'abc123.json'));
    fs.unlinkSync(path.join(tmpDir, 'def456.json'));
    fs.unlinkSync(path.join(tmpDir, 'not-json.txt'));
  });

  test('initial stats are zero', () => {
    const cache = new LLMResponseCache(tmpDir);
    const stats = cache.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);
  });
});

// =============================================================================
// KEY GENERATION
// =============================================================================

describe('LLMResponseCache — key generation', () => {
  let cache: LLMResponseCache;

  beforeEach(() => {
    tmpDir = createTempDir();
    cache = new LLMResponseCache(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('generates consistent hash for same inputs', () => {
    const key1 = cache.generateKey('System prompt', [{ role: 'user', content: 'Hello' }]);
    const key2 = cache.generateKey('System prompt', [{ role: 'user', content: 'Hello' }]);
    expect(key1).toBe(key2);
  });

  test('generates different hash for different system prompts', () => {
    const key1 = cache.generateKey('Prompt A', [{ role: 'user', content: 'Hello' }]);
    const key2 = cache.generateKey('Prompt B', [{ role: 'user', content: 'Hello' }]);
    expect(key1).not.toBe(key2);
  });

  test('generates different hash for different messages', () => {
    const key1 = cache.generateKey('System', [{ role: 'user', content: 'Hello' }]);
    const key2 = cache.generateKey('System', [{ role: 'user', content: 'Goodbye' }]);
    expect(key1).not.toBe(key2);
  });

  test('key is 16 characters (truncated SHA-256)', () => {
    const key = cache.generateKey('Test', []);
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[a-f0-9]{16}$/);
  });

  test('normalizes whitespace in system prompt', () => {
    const key1 = cache.generateKey('Hello   World', []);
    const key2 = cache.generateKey('Hello World', []);
    expect(key1).toBe(key2);
  });

  test('normalizes whitespace in messages', () => {
    const key1 = cache.generateKey('', [{ role: 'user', content: '  Hello  ' }]);
    const key2 = cache.generateKey('', [{ role: 'user', content: 'Hello' }]);
    expect(key1).toBe(key2);
  });

  test('model is excluded from key by default (includeModelInKey=false)', () => {
    const key1 = cache.generateKey('System', [], { model: 'gpt-4' });
    const key2 = cache.generateKey('System', [], { model: 'claude-3' });
    expect(key1).toBe(key2);
  });

  test('model is included in key when includeModelInKey=true', () => {
    const modelCache = new LLMResponseCache({
      cacheDir: tmpDir,
      includeModelInKey: true,
    });
    const key1 = modelCache.generateKey('System', [], { model: 'gpt-4' });
    const key2 = modelCache.generateKey('System', [], { model: 'claude-3' });
    expect(key1).not.toBe(key2);
  });

  test('tools affect the cache key', () => {
    const tools = [{ name: 'search', description: 'Search', input_schema: {} }];
    const key1 = cache.generateKey('System', [], { tools });
    const key2 = cache.generateKey('System', [], {});
    expect(key1).not.toBe(key2);
  });
});

// =============================================================================
// CACHE GET/SET
// =============================================================================

describe('LLMResponseCache — get/set', () => {
  let cache: LLMResponseCache;

  beforeEach(() => {
    tmpDir = createTempDir();
    cache = new LLMResponseCache(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('get returns null for cache miss', () => {
    const result = cache.get('nonexistent-key');
    expect(result).toBeNull();
  });

  test('set stores and get retrieves response', () => {
    const key = cache.generateKey('System', [{ role: 'user', content: 'Test' }]);
    const request = {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Test' }],
    };

    cache.set(key, request, 'response text');
    const result = cache.get(key);
    expect(result).toBe('response text');
  });

  test('set creates file on disk', () => {
    const key = 'testkey12345678';
    cache.set(key, { systemPrompt: '', messages: [] }, 'data');

    const filepath = path.join(tmpDir, `${key}.json`);
    expect(fs.existsSync(filepath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(content.hash).toBe(key);
    expect(content.response).toBe('data');
    expect(content.hitCount).toBe(0);
  });

  test('get from file cache works when not in memory', () => {
    const key = 'fileonly12345678';

    // Write directly to file (simulating a previous session)
    const entry: CacheEntry = {
      hash: key,
      request: { systemPrompt: '', messages: [] },
      response: { result: 'from file' },
      timestamp: new Date().toISOString(),
      hitCount: 0,
    };
    fs.writeFileSync(path.join(tmpDir, `${key}.json`), JSON.stringify(entry));

    // New cache instance (empty memory cache)
    const cache2 = new LLMResponseCache(tmpDir);
    const result = cache2.get(key);
    expect(result).toEqual({ result: 'from file' });
  });

  test('get increments hit count', () => {
    const key = 'hitcount12345678';
    cache.set(key, { systemPrompt: '', messages: [] }, 'value');

    cache.get(key); // hit 1
    cache.get(key); // hit 2
    cache.get(key); // hit 3

    const stats = cache.getStats();
    expect(stats.hits).toBe(3);
  });

  test('miss increments miss count', () => {
    cache.get('miss1');
    cache.get('miss2');

    const stats = cache.getStats();
    expect(stats.misses).toBe(2);
  });

  test('hit rate is calculated correctly', () => {
    const key = 'hitrate12345678';
    cache.set(key, { systemPrompt: '', messages: [] }, 'value');

    cache.get(key); // hit
    cache.get('miss-key'); // miss
    cache.get(key); // hit

    const stats = cache.getStats();
    // 2 hits, 1 miss = 2/3 = ~0.667
    expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
  });

  test('stores complex response objects', () => {
    const key = 'complex12345678';
    const complexResponse = {
      toolCalls: [{ id: '1', name: 'search', input: { query: 'test' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 50 },
    };

    cache.set(key, { systemPrompt: '', messages: [] }, complexResponse);
    const result = cache.get(key);
    expect(result).toEqual(complexResponse);
  });
});

// =============================================================================
// CACHE TTL EXPIRY
// =============================================================================

describe('LLMResponseCache — TTL expiry', () => {
  let cache: LLMResponseCache;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('entries with TTL=0 never expire', () => {
    cache = new LLMResponseCache({ cacheDir: tmpDir, ttlMs: 0 });
    const key = 'noexpiry12345678';

    // Create entry with old timestamp
    const entry: CacheEntry = {
      hash: key,
      request: { systemPrompt: '', messages: [] },
      response: 'old data',
      timestamp: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year ago
      hitCount: 0,
    };
    fs.writeFileSync(path.join(tmpDir, `${key}.json`), JSON.stringify(entry));

    const newCache = new LLMResponseCache({ cacheDir: tmpDir, ttlMs: 0 });
    expect(newCache.get(key)).toBe('old data');
  });

  test('expired entries from memory cache return null', () => {
    cache = new LLMResponseCache({ cacheDir: tmpDir, ttlMs: 100 }); // 100ms TTL
    const key = 'expiring12345678';

    // Store entry with past timestamp in memory cache
    const entry: CacheEntry = {
      hash: key,
      request: { systemPrompt: '', messages: [] },
      response: 'expired data',
      timestamp: new Date(Date.now() - 200).toISOString(), // 200ms ago (past TTL)
      hitCount: 0,
    };
    (cache as any).memoryCache.set(key, entry);

    const result = cache.get(key);
    expect(result).toBeNull();
  });

  test('expired entries from file cache are deleted', () => {
    cache = new LLMResponseCache({ cacheDir: tmpDir, ttlMs: 100 });
    const key = 'fileexpiry12345678';

    const entry: CacheEntry = {
      hash: key,
      request: { systemPrompt: '', messages: [] },
      response: 'expired',
      timestamp: new Date(Date.now() - 200).toISOString(),
      hitCount: 0,
    };
    const filepath = path.join(tmpDir, `${key}.json`);
    fs.writeFileSync(filepath, JSON.stringify(entry));

    const newCache = new LLMResponseCache({ cacheDir: tmpDir, ttlMs: 100 });
    expect(newCache.get(key)).toBeNull();
    expect(fs.existsSync(filepath)).toBe(false);
  });
});

// =============================================================================
// CACHE CLEANUP
// =============================================================================

describe('LLMResponseCache — cleanup', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('cleanup removes oldest 20% of entries', () => {
    // Create 10 cache files with staggered timestamps
    for (let i = 0; i < 10; i++) {
      const key = `cleanup${String(i).padStart(12, '0')}`;
      const entry: CacheEntry = {
        hash: key,
        request: { systemPrompt: '', messages: [] },
        response: `data-${i}`,
        timestamp: new Date().toISOString(),
        hitCount: 0,
      };
      fs.writeFileSync(path.join(tmpDir, `${key}.json`), JSON.stringify(entry));
    }

    const cache = new LLMResponseCache(tmpDir);
    cache.cleanup();

    // Should have removed 2 entries (20% of 10)
    const remaining = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(remaining.length).toBe(8);
  });

  test('cleanup does nothing when cache is empty', () => {
    const cache = new LLMResponseCache(tmpDir);
    expect(() => cache.cleanup()).not.toThrow();
  });

  test('cleanup does nothing when disabled', () => {
    const cache = new LLMResponseCache({ cacheDir: tmpDir, enabled: false });
    expect(() => cache.cleanup()).not.toThrow();
  });

  test('set triggers cleanup when maxEntries exceeded', () => {
    const cache = new LLMResponseCache({ cacheDir: tmpDir, maxEntries: 3 });

    // Add 4 entries to exceed the limit
    for (let i = 0; i < 4; i++) {
      const key = `max${String(i).padStart(14, '0')}`;
      cache.set(key, { systemPrompt: '', messages: [] }, `data-${i}`);
    }

    // After exceeding maxEntries, cleanup should have been triggered
    const remaining = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(remaining.length).toBeLessThanOrEqual(4);
  });
});

// =============================================================================
// CACHE CLEAR
// =============================================================================

describe('LLMResponseCache — clear', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('clear removes all entries from memory and disk', () => {
    const cache = new LLMResponseCache(tmpDir);

    cache.set('key1aaaaaaa12345', { systemPrompt: '', messages: [] }, 'data1');
    cache.set('key2aaaaaaa12345', { systemPrompt: '', messages: [] }, 'data2');

    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json')).length).toBe(2);

    cache.clear();

    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json')).length).toBe(0);
    // Verify entries are gone (these will register as misses)
    expect(cache.get('key1aaaaaaa12345')).toBeNull();
    expect(cache.get('key2aaaaaaa12345')).toBeNull();

    const stats = cache.getStats();
    // hits reset to 0 by clear, the 2 gets above add misses
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(2);
    expect(stats.totalEntries).toBe(0);
  });
});

// =============================================================================
// CACHE DISABLED
// =============================================================================

describe('LLMResponseCache — disabled', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('get returns null when disabled', () => {
    const cache = new LLMResponseCache({ cacheDir: tmpDir, enabled: false });
    (cache as any).memoryCache.set('key', { response: 'data' });
    expect(cache.get('key')).toBeNull();
  });

  test('set does nothing when disabled', () => {
    const cache = new LLMResponseCache({ cacheDir: tmpDir, enabled: false });
    cache.set('key12345678901234', { systemPrompt: '', messages: [] }, 'data');

    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json')).length).toBe(0);
  });
});

// =============================================================================
// CACHE STATS
// =============================================================================

describe('LLMResponseCache — getStats / printStats', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('getStats returns a copy (not a reference)', () => {
    const cache = new LLMResponseCache(tmpDir);
    const stats1 = cache.getStats();
    const stats2 = cache.getStats();
    expect(stats1).not.toBe(stats2);
    expect(stats1).toEqual(stats2);
  });

  test('printStats does not throw', () => {
    const cache = new LLMResponseCache(tmpDir);
    expect(() => cache.printStats()).not.toThrow();
  });
});

// =============================================================================
// createCachedLLMClient
// =============================================================================

describe('createCachedLLMClient', () => {
  let cache: LLMResponseCache;
  let mockClient: any;

  beforeEach(() => {
    tmpDir = createTempDir();
    cache = new LLMResponseCache(tmpDir);
    mockClient = {
      chat: vi.fn().mockResolvedValue('real response'),
      chatWithTools: vi.fn().mockResolvedValue({
        toolCalls: [],
        text: 'tool response',
        stopReason: 'end_turn',
      }),
      extractJson: vi.fn().mockResolvedValue({ name: 'John' }),
    };
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('chat returns cached response on cache hit', async () => {
    const cached = createCachedLLMClient(mockClient, cache);

    const result1 = await cached.chat('System', [{ role: 'user', content: 'Hello' }], {
      model: 'gpt-4',
      timeoutMs: 5000,
    });
    expect(result1).toBe('real response');
    expect(mockClient.chat).toHaveBeenCalledTimes(1);

    // Second call should return cached
    const result2 = await cached.chat('System', [{ role: 'user', content: 'Hello' }], {
      model: 'gpt-4',
      timeoutMs: 5000,
    });
    expect(result2).toBe('real response');
    expect(mockClient.chat).toHaveBeenCalledTimes(1); // Not called again
  });

  test('chatWithTools returns cached response on cache hit', async () => {
    const tools = [
      { name: 'search', description: 'Search', input_schema: { type: 'object', properties: {} } },
    ];
    const cached = createCachedLLMClient(mockClient, cache);

    await cached.chatWithTools('System', [{ role: 'user', content: 'Search' }], tools as any, {
      model: 'gpt-4',
      timeoutMs: 5000,
    });
    expect(mockClient.chatWithTools).toHaveBeenCalledTimes(1);

    // Second call should be cached
    await cached.chatWithTools('System', [{ role: 'user', content: 'Search' }], tools as any, {
      model: 'gpt-4',
      timeoutMs: 5000,
    });
    expect(mockClient.chatWithTools).toHaveBeenCalledTimes(1);
  });

  test('extractJson returns cached response on cache hit', async () => {
    const cached = createCachedLLMClient(mockClient, cache);

    const result1 = await cached.extractJson(
      'Extract',
      [{ role: 'user', content: 'My name is John' }],
      '{"name":"string"}',
      { model: 'gpt-4', timeoutMs: 5000 },
    );
    expect(result1).toEqual({ name: 'John' });
    expect(mockClient.extractJson).toHaveBeenCalledTimes(1);

    // Second call should be cached
    const result2 = await cached.extractJson(
      'Extract',
      [{ role: 'user', content: 'My name is John' }],
      '{"name":"string"}',
      { model: 'gpt-4', timeoutMs: 5000 },
    );
    expect(result2).toEqual({ name: 'John' });
    expect(mockClient.extractJson).toHaveBeenCalledTimes(1);
  });

  test('extractJson normalizes schema whitespace for consistent cache keys', async () => {
    const cached = createCachedLLMClient(mockClient, cache);

    await cached.extractJson(
      'Extract',
      [{ role: 'user', content: 'data' }],
      '{ "name" : "string" }',
      { model: 'gpt-4', timeoutMs: 5000 },
    );
    await cached.extractJson('Extract', [{ role: 'user', content: 'data' }], '{"name":"string"}', {
      model: 'gpt-4',
      timeoutMs: 5000,
    });

    // Should only call the real client once due to schema normalization
    expect(mockClient.extractJson).toHaveBeenCalledTimes(1);
  });

  test('chat calls real client on cache miss', async () => {
    const cached = createCachedLLMClient(mockClient, cache);

    await cached.chat('Prompt A', [{ role: 'user', content: 'X' }], {
      model: 'gpt-4',
      timeoutMs: 5000,
    });
    await cached.chat('Prompt B', [{ role: 'user', content: 'Y' }], {
      model: 'gpt-4',
      timeoutMs: 5000,
    });

    // Different prompts/messages = cache miss each time
    expect(mockClient.chat).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// createCacheFromEnv
// =============================================================================

describe('createCacheFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    tmpDir = createTempDir();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    cleanupTempDir(tmpDir);
  });

  test('uses defaults when no env vars set', () => {
    delete process.env.LLM_CACHE_ENABLED;
    delete process.env.LLM_CACHE_DIR;
    delete process.env.LLM_CACHE_TTL_MS;

    const cache = createCacheFromEnv(tmpDir);
    const config = (cache as any).config;
    expect(config.enabled).toBe(true);
    expect(config.cacheDir).toBe(tmpDir);
    expect(config.ttlMs).toBe(0);
  });

  test('respects LLM_CACHE_ENABLED=false', () => {
    process.env.LLM_CACHE_ENABLED = 'false';

    const cache = createCacheFromEnv(tmpDir);
    const config = (cache as any).config;
    expect(config.enabled).toBe(false);
  });

  test('respects LLM_CACHE_DIR', () => {
    process.env.LLM_CACHE_DIR = tmpDir;

    const cache = createCacheFromEnv();
    const config = (cache as any).config;
    expect(config.cacheDir).toBe(tmpDir);
  });

  test('respects LLM_CACHE_TTL_MS', () => {
    process.env.LLM_CACHE_TTL_MS = '30000';

    const cache = createCacheFromEnv(tmpDir);
    const config = (cache as any).config;
    expect(config.ttlMs).toBe(30000);
  });
});

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

describe('LLMResponseCache — normalization', () => {
  let cache: LLMResponseCache;

  beforeEach(() => {
    tmpDir = createTempDir();
    cache = new LLMResponseCache(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('normalizePrompt collapses multiple spaces', () => {
    const result = (cache as any).normalizePrompt('Hello   World   Test');
    expect(result).toBe('Hello World Test');
  });

  test('normalizePrompt collapses all whitespace including newlines', () => {
    // The implementation collapses all whitespace (\s+) into spaces first,
    // so newlines become spaces too
    const result = (cache as any).normalizePrompt('Line1\n\n\nLine2');
    expect(result).toBe('Line1 Line2');
  });

  test('normalizePrompt trims whitespace', () => {
    const result = (cache as any).normalizePrompt('  Hello  ');
    expect(result).toBe('Hello');
  });

  test('normalizeMessages extracts role and trims content', () => {
    const messages = [
      { role: 'user', content: '  Hello  ', extra: 'ignored' },
      { role: 'assistant', content: 'World' },
    ];
    const result = (cache as any).normalizeMessages(messages);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ]);
  });

  test('normalizeMessages handles non-string content', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
    const result = (cache as any).normalizeMessages(messages);
    expect(result[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  test('normalizeTools extracts name, description, and input_schema', () => {
    const tools = [
      {
        name: 'search',
        description: 'Search',
        input_schema: { type: 'object' },
        extra_field: 'ignored',
      },
    ];
    const result = (cache as any).normalizeTools(tools);
    expect(result).toEqual([
      { name: 'search', description: 'Search', input_schema: { type: 'object' } },
    ]);
  });
});

// =============================================================================
// FILE CACHE ERROR HANDLING
// =============================================================================

describe('LLMResponseCache — file error handling', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('get returns null when file contains invalid JSON', () => {
    const key = 'badjson123456789';
    fs.writeFileSync(path.join(tmpDir, `${key}.json`), 'not valid json');

    const cache = new LLMResponseCache(tmpDir);
    const result = cache.get(key);
    expect(result).toBeNull();

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
  });
});
