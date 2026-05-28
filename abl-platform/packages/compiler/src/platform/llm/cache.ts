/**
 * LLM Response Cache
 *
 * Provides file-based caching for LLM responses to speed up test re-runs.
 * Caches based on a hash of:
 * - System prompt
 * - Messages
 * - Model
 * - Tools (if any)
 *
 * Usage:
 * ```typescript
 * const cache = new LLMResponseCache('./cache');
 * const cachedClient = createCachedLLMClient(realClient, cache);
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('llm-cache');

// =============================================================================
// TYPES
// =============================================================================

export interface CacheEntry {
  hash: string;
  request: {
    systemPrompt: string;
    messages: unknown[];
    model?: string;
    tools?: unknown[];
  };
  response: unknown;
  timestamp: string;
  hitCount: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  totalEntries: number;
  cacheDir: string;
}

export interface LLMCacheConfig {
  /** Directory to store cache files */
  cacheDir: string;
  /** Whether caching is enabled */
  enabled?: boolean;
  /** TTL in milliseconds (0 = no expiry) */
  ttlMs?: number;
  /** Whether to include model in cache key (set false for model-agnostic caching) */
  includeModelInKey?: boolean;
  /** Max cache entries before cleanup */
  maxEntries?: number;
}

// =============================================================================
// LLM RESPONSE CACHE
// =============================================================================

export class LLMResponseCache {
  private config: Required<LLMCacheConfig>;
  private stats: CacheStats;
  private memoryCache: Map<string, CacheEntry> = new Map();

  constructor(config: LLMCacheConfig | string) {
    // Allow simple string config for cache dir
    if (typeof config === 'string') {
      config = { cacheDir: config };
    }

    this.config = {
      cacheDir: config.cacheDir,
      enabled: config.enabled ?? true,
      ttlMs: config.ttlMs ?? 0,
      includeModelInKey: config.includeModelInKey ?? false, // Default to model-agnostic
      maxEntries: config.maxEntries ?? 10000,
    };

    this.stats = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      totalEntries: 0,
      cacheDir: this.config.cacheDir,
    };

    // Ensure cache directory exists
    if (this.config.enabled && !fs.existsSync(this.config.cacheDir)) {
      fs.mkdirSync(this.config.cacheDir, { recursive: true });
    }

    // Load existing entries count
    if (this.config.enabled && fs.existsSync(this.config.cacheDir)) {
      try {
        const files = fs.readdirSync(this.config.cacheDir).filter((f) => f.endsWith('.json'));
        this.stats.totalEntries = files.length;
      } catch {
        // Ignore errors
      }
    }
  }

  /**
   * Generate a cache key hash
   */
  generateKey(
    systemPrompt: string,
    messages: unknown[],
    options?: { model?: string; tools?: unknown[] },
  ): string {
    const keyData = {
      systemPrompt: this.normalizePrompt(systemPrompt),
      messages: this.normalizeMessages(messages),
      tools: options?.tools ? this.normalizeTools(options.tools) : undefined,
      model: this.config.includeModelInKey ? options?.model : undefined,
    };

    const json = JSON.stringify(keyData);
    return crypto.createHash('sha256').update(json).digest('hex').substring(0, 16);
  }

  /**
   * Get cached response
   */
  get(key: string): unknown | null {
    if (!this.config.enabled) return null;

    // Check memory cache first
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      if (this.isExpired(memEntry)) {
        this.memoryCache.delete(key);
      } else {
        this.stats.hits++;
        this.updateHitRate();
        memEntry.hitCount++;
        return memEntry.response;
      }
    }

    // Check file cache
    const filepath = this.getFilePath(key);
    if (!fs.existsSync(filepath)) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      const entry: CacheEntry = JSON.parse(content);

      if (this.isExpired(entry)) {
        fs.unlinkSync(filepath);
        this.stats.misses++;
        this.stats.totalEntries--;
        this.updateHitRate();
        return null;
      }

      // Update hit count
      entry.hitCount++;
      fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));

      // Store in memory cache
      this.memoryCache.set(key, entry);

      this.stats.hits++;
      this.updateHitRate();
      return entry.response;
    } catch {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }
  }

  /**
   * Store response in cache
   */
  set(key: string, request: CacheEntry['request'], response: unknown): void {
    if (!this.config.enabled) return;

    const entry: CacheEntry = {
      hash: key,
      request,
      response,
      timestamp: new Date().toISOString(),
      hitCount: 0,
    };

    // Store in memory
    this.memoryCache.set(key, entry);

    // Store in file
    const filepath = this.getFilePath(key);
    try {
      fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));
      this.stats.totalEntries++;

      // Cleanup if over limit
      if (this.stats.totalEntries > this.config.maxEntries) {
        this.cleanup();
      }
    } catch (err) {
      log.error('Failed to write cache entry', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check if entry is expired
   */
  private isExpired(entry: CacheEntry): boolean {
    if (this.config.ttlMs === 0) return false;
    const age = Date.now() - new Date(entry.timestamp).getTime();
    return age > this.config.ttlMs;
  }

  /**
   * Get file path for cache key
   */
  private getFilePath(key: string): string {
    return path.join(this.config.cacheDir, `${key}.json`);
  }

  /**
   * Update hit rate statistic
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Normalize system prompt for consistent hashing
   */
  private normalizePrompt(prompt: string): string {
    return prompt
      .trim()
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/\n+/g, '\n'); // Collapse newlines
  }

  /**
   * Normalize messages for consistent hashing
   */
  private normalizeMessages(messages: unknown[]): unknown[] {
    return messages.map((msg: any) => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content.trim() : msg.content,
    }));
  }

  /**
   * Normalize tools for consistent hashing
   */
  private normalizeTools(tools: unknown[]): unknown[] {
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  /**
   * Cleanup old cache entries
   */
  cleanup(): void {
    if (!this.config.enabled || !fs.existsSync(this.config.cacheDir)) return;

    try {
      const files = fs
        .readdirSync(this.config.cacheDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const filepath = path.join(this.config.cacheDir, f);
          const stat = fs.statSync(filepath);
          return { file: f, filepath, mtime: stat.mtime.getTime() };
        })
        .sort((a, b) => a.mtime - b.mtime); // Oldest first

      // Remove oldest 20% if over limit
      const toRemove = Math.ceil(files.length * 0.2);
      for (let i = 0; i < toRemove && i < files.length; i++) {
        fs.unlinkSync(files[i].filepath);
        this.stats.totalEntries--;
      }

      log.info('Cleaned up old cache entries', { removed: toRemove });
    } catch (err) {
      log.error('Cache cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.memoryCache.clear();

    if (fs.existsSync(this.config.cacheDir)) {
      const files = fs.readdirSync(this.config.cacheDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(this.config.cacheDir, file));
      }
    }

    this.stats = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      totalEntries: 0,
      cacheDir: this.config.cacheDir,
    };
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Print cache statistics
   */
  printStats(): void {
    const stats = this.getStats();
    log.info('LLM Cache Statistics', {
      cacheDir: stats.cacheDir,
      totalEntries: stats.totalEntries,
      hits: stats.hits,
      misses: stats.misses,
      hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
    });
  }
}

// =============================================================================
// CACHED LLM CLIENT WRAPPER
// =============================================================================

import type { LLMClient, LLMToolDefinition, LLMToolUseResult } from '../constructs/types.js';

/**
 * Wrap an LLM client with caching
 */
export function createCachedLLMClient(client: LLMClient, cache: LLMResponseCache): LLMClient {
  return {
    chat: async (systemPrompt, messages, options) => {
      const key = cache.generateKey(systemPrompt, messages, { model: options?.model });

      // Check cache
      const cached = cache.get(key);
      if (cached !== null) {
        return cached as string;
      }

      // Make real request
      const response = await client.chat(systemPrompt, messages, options);

      // Cache response
      cache.set(key, { systemPrompt, messages, model: options?.model }, response);

      return response;
    },

    chatWithTools: async (systemPrompt, messages, tools, options) => {
      const key = cache.generateKey(systemPrompt, messages, {
        model: options?.model,
        tools: tools as unknown[],
      });

      // Check cache
      const cached = cache.get(key);
      if (cached !== null) {
        return cached as LLMToolUseResult;
      }

      // Make real request
      const response = await client.chatWithTools(systemPrompt, messages, tools, options);

      // Cache response
      cache.set(
        key,
        { systemPrompt, messages, model: options?.model, tools: tools as unknown[] },
        response,
      );

      return response;
    },

    extractJson: async (systemPrompt, messages, schema, options) => {
      // Normalize schema whitespace for consistent cache keys
      let normalizedSchema: string;
      try {
        normalizedSchema = JSON.stringify(JSON.parse(schema));
      } catch {
        normalizedSchema = schema;
      }
      const keyPrompt = `${systemPrompt}\n---SCHEMA---\n${normalizedSchema}`;
      const key = cache.generateKey(keyPrompt, messages, { model: options?.model });

      // Check cache
      const cached = cache.get(key);
      if (cached !== null) {
        return cached as Record<string, unknown>;
      }

      // Make real request
      const response = await client.extractJson(systemPrompt, messages, schema, options);

      // Cache response
      cache.set(key, { systemPrompt: keyPrompt, messages, model: options?.model }, response);

      return response;
    },
  };
}

// =============================================================================
// ENVIRONMENT-BASED CACHE CREATION
// =============================================================================

/**
 * Create a cache based on environment variables
 *
 * Environment variables:
 * - LLM_CACHE_ENABLED: 'true' or 'false' (default: 'true')
 * - LLM_CACHE_DIR: Cache directory path (default: '.llm-cache')
 * - LLM_CACHE_TTL_MS: TTL in milliseconds (default: 0 = no expiry)
 */
export function createCacheFromEnv(defaultDir?: string): LLMResponseCache {
  const enabled = process.env.LLM_CACHE_ENABLED !== 'false';
  const cacheDir = process.env.LLM_CACHE_DIR || defaultDir || '.llm-cache';
  const ttlMs = parseInt(process.env.LLM_CACHE_TTL_MS || '0', 10);

  return new LLMResponseCache({
    cacheDir,
    enabled,
    ttlMs,
  });
}
