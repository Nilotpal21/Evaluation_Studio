/**
 * Alias Resolver Service (Pipeline Stage 2.5)
 *
 * Resolves alias field names from vocabulary/agent filters to actual
 * vector store paths under metadata.canonical.*. Also performs enum value
 * coercion (e.g., "high" → 0.8 for priority).
 *
 * Sits between Stage 2 (vocabulary resolution) and Stage 3 (query building).
 *
 * Caching: LRU (500 entries, 5min TTL) + Redis pub/sub invalidation.
 * Same pattern as VocabularyResolver and CanonicalMapperService.
 */

import type { ICanonicalSchema, ICanonicalField } from '@agent-platform/database/models';
import { getLazyModel } from '../../db/index.js';

const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
import { LRUCache } from 'lru-cache';
import { createLogger } from '@abl/compiler/platform';
import {
  createRedisConnection,
  createSubscriber,
  resolveRedisOptionsFromEnv,
  type RedisClient,
  type RedisConnectionHandle,
} from '@agent-platform/redis';

const logger = createLogger('alias-resolver');

const ALIAS_INVALIDATE_CHANNEL = 'alias-resolver:invalidate';

// ─── Types ───────────────────────────────────────────────────────────────

export interface AliasFilter {
  field: string;
  operator: string;
  value: unknown;
}

export interface ResolvedFilter {
  field: string;
  operator: string;
  value: unknown;
  /** The original alias name before resolution (for traceability) */
  originalAlias?: string;
}

interface CachedSchema {
  /** Alias name → canonical field definition */
  byAlias: Map<string, ICanonicalField>;
  /** Vector store field name → canonical field definition */
  byStorageField: Map<string, ICanonicalField>;
  /**
   * Source connector field name → canonical field definition. Populated for
   * JSON-record KBs where the user-facing field name (`brand`, `basePrice`)
   * differs from the synthetic slot name (`custom_string_1`). Without this
   * map, filters like `{field: "brand"}` silently match 0 docs because the
   * field isn't found in byAlias / byStorageField and the resolver falls
   * back to the prefixed-passthrough `metadata.canonical.brand` — which is
   * not where the value actually lives.
   */
  bySourceField: Map<string, ICanonicalField>;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class AliasResolver {
  private cache: LRUCache<string, CachedSchema>;
  private subscriber: RedisClient | null = null;
  private handle: RedisConnectionHandle | null = null;

  constructor() {
    this.cache = new LRUCache<string, CachedSchema>({
      max: 500,
      ttl: 1000 * 60 * 5, // 5 minutes
    });

    this.initRedis();
    logger.info('AliasResolver initialized');
  }

  /**
   * Resolve alias field names to vector store paths and coerce enum values.
   *
   * For each filter:
   * 1. Look up alias name in CanonicalSchema
   * 2. Replace field with `metadata.canonical.{storageField}`
   * 3. If value matches an enum key, replace with the stored value
   * 4. Passthrough if alias not found (may be a raw storage field name)
   */
  async resolve(
    filters: AliasFilter[],
    knowledgeBaseId: string,
    tenantId: string,
  ): Promise<ResolvedFilter[]> {
    if (filters.length === 0) return [];

    const schema = await this.loadSchema(knowledgeBaseId, tenantId);

    return filters.map((f) => {
      // Normalize field: strip prefixes so schema lookup works regardless of input format
      // UI sends "canonical.source_type", agent sends "source_type", alias resolver expects raw name
      const rawField = f.field.replace(/^metadata\.canonical\./, '').replace(/^canonical\./, '');
      const canonical =
        schema.byAlias.get(rawField) ??
        schema.byStorageField.get(rawField) ??
        schema.bySourceField.get(rawField);

      if (!canonical) {
        // Unknown field — passthrough with metadata.canonical prefix if not already prefixed
        const field = f.field.startsWith('metadata.') ? f.field : `metadata.canonical.${rawField}`;
        return { field, operator: f.operator, value: f.value };
      }

      let resolvedValue = f.value;

      // Enum coercion: if value matches a display name, replace with stored value
      if (canonical.enumValues && typeof f.value === 'string') {
        const enumVal = (canonical.enumValues as Record<string, unknown>)[f.value.toLowerCase()];
        if (enumVal !== undefined) {
          resolvedValue = enumVal;
        }
      }

      return {
        field: `metadata.canonical.${canonical.storageField}`,
        operator: f.operator,
        value: resolvedValue,
        originalAlias: f.field !== canonical.storageField ? f.field : undefined,
      };
    });
  }

  /**
   * Resolve a single alias name to its vector store path.
   * Returns null if the alias is not found.
   */
  async resolveFieldName(
    alias: string,
    knowledgeBaseId: string,
    tenantId: string,
  ): Promise<string | null> {
    const schema = await this.loadSchema(knowledgeBaseId, tenantId);
    const canonical =
      schema.byAlias.get(alias) ??
      schema.byStorageField.get(alias) ??
      schema.bySourceField.get(alias);
    return canonical ? `metadata.canonical.${canonical.storageField}` : null;
  }

  /**
   * Invalidate cached schema for a KB. Broadcasts to other pods.
   */
  async invalidateCache(knowledgeBaseId: string, tenantId: string): Promise<void> {
    const cacheKey = `${tenantId}:${knowledgeBaseId}`;
    this.cache.delete(cacheKey);

    if (this.handle) {
      try {
        await this.handle.client.publish(
          ALIAS_INVALIDATE_CHANNEL,
          JSON.stringify({ knowledgeBaseId, tenantId }),
        );
      } catch (error) {
        logger.error('Failed to publish alias cache invalidation', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Get cache metrics for monitoring.
   */
  getCacheMetrics(): { size: number } {
    return { size: this.cache.size };
  }

  /**
   * Cleanup Redis connections on shutdown.
   */
  async cleanup(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(ALIAS_INVALIDATE_CHANNEL);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    if (this.handle) {
      await this.handle.disconnect();
      this.handle = null;
    }
    logger.info('AliasResolver cleanup complete');
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async loadSchema(knowledgeBaseId: string, tenantId: string): Promise<CachedSchema> {
    const cacheKey = `${tenantId}:${knowledgeBaseId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const doc = await CanonicalSchema.findOne({
        knowledgeBaseId,
        tenantId,
        status: 'active',
      })
        .sort({ version: -1 })
        .lean();

      const fields = (doc?.fields as ICanonicalField[]) ?? [];

      const byAlias = new Map<string, ICanonicalField>();
      const byStorageField = new Map<string, ICanonicalField>();
      const bySourceField = new Map<string, ICanonicalField>();

      for (const f of fields) {
        byAlias.set(f.name, f);
        byStorageField.set(f.storageField, f);
        if (f.sourceConnectorField) {
          bySourceField.set(f.sourceConnectorField, f);
        }
      }

      const schema: CachedSchema = { byAlias, byStorageField, bySourceField };
      this.cache.set(cacheKey, schema);
      return schema;
    } catch (error) {
      logger.error('Failed to load canonical schema for alias resolution', {
        knowledgeBaseId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { byAlias: new Map(), byStorageField: new Map(), bySourceField: new Map() };
    }
  }

  private initRedis(): void {
    try {
      const opts = resolveRedisOptionsFromEnv() ?? {};
      this.handle = createRedisConnection(opts);
      this.subscriber = createSubscriber(this.handle);

      this.subscriber.on('error', (err: Error) => {
        logger.warn('Alias resolver subscriber Redis error (non-fatal)', {
          error: err.message,
        });
      });
      this.subscriber.subscribe(ALIAS_INVALIDATE_CHANNEL, (err: Error | null | undefined) => {
        if (err) {
          logger.error('Failed to subscribe to alias invalidation channel', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel === ALIAS_INVALIDATE_CHANNEL) {
          try {
            const { knowledgeBaseId, tenantId } = JSON.parse(message);
            this.cache.delete(`${tenantId}:${knowledgeBaseId}`);
          } catch (error) {
            logger.error('Failed to parse alias invalidation message', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    } catch (error) {
      logger.error('Failed to initialize Redis pub/sub for alias resolver', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let aliasResolverInstance: AliasResolver | null = null;

export function getAliasResolver(): AliasResolver {
  if (!aliasResolverInstance) {
    aliasResolverInstance = new AliasResolver();
  }
  return aliasResolverInstance;
}
