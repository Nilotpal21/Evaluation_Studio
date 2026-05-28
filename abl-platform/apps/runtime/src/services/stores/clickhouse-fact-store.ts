/**
 * ClickHouse Fact Store
 *
 * Implements FactStore for ClickHouse backend using @clickhouse/client.
 * Uses ReplacingMergeTree(updated_at) — set() inserts a new row and
 * reads use FINAL to deduplicate by key automatically.
 */

import { randomUUID } from 'crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';
import {
  FactStore,
  type FactStoreConfig,
  type Fact,
  type FactSource,
  type SetFactParams,
  type GetFactParams,
  type QueryFactsParams,
  type BatchSetParams,
} from '@abl/compiler/platform/stores/fact-store.js';

function tryParseJson(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

// =============================================================================
// TYPES
// =============================================================================

interface ClickHouseFactRow {
  id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  source_type: string;
  source_agent_name: string;
  source_session_id: string;
  source_trace_id: string;
  metadata: string;
}

export interface ClickHouseFactStoreOptions {
  client: ClickHouseClient;
}

const TABLE = 'abl_platform.facts';
const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class ClickHouseFactStore extends FactStore {
  private client: ClickHouseClient;

  constructor(config: FactStoreConfig, options: ClickHouseFactStoreOptions) {
    super(config);
    this.client = options.client;
  }

  async set(params: SetFactParams): Promise<Fact> {
    const now = new Date();
    const ttlMs = this.parseTtl(params.ttlMs);
    const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs) : null;
    const source = params.source || { type: 'system' as const };

    // Check if key already exists to preserve id and createdAt
    const existing = await this.get({ key: params.key });

    const id = existing?.id || randomUUID();
    const createdAt = existing?.createdAt || now;

    const row: ClickHouseFactRow = {
      id,
      key: params.key,
      value: JSON.stringify(params.value),
      created_at: toClickHouseDateTime(createdAt),
      updated_at: toClickHouseDateTime(now),
      expires_at: expiresAt ? toClickHouseDateTime(expiresAt) : null,
      source_type: source.type,
      source_agent_name: source.agentName || '',
      source_session_id: source.sessionId || '',
      source_trace_id: source.traceId || '',
      metadata: JSON.stringify(params.metadata || {}),
    };

    await this.client.insert({
      table: TABLE,
      values: [row],
      format: 'JSONEachRow',
    });

    return this.mapToFact(row);
  }

  async get(params: GetFactParams): Promise<Fact | null> {
    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${TABLE} FINAL
        SETTINGS max_execution_time = 5
        WHERE key = {key:String}
          AND (expires_at IS NULL OR expires_at > now64(3))
        LIMIT 1
      `,
      query_params: { key: params.key },
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseFactRow>();
    if (rows.length === 0) return null;

    return this.mapToFact(rows[0]);
  }

  async delete(key: string): Promise<boolean> {
    const exists = await this.exists(key);

    if (exists) {
      await this.client.command({
        query: `
          ALTER TABLE ${TABLE} DELETE
          WHERE key = {key:String}
          ${WAIT_FOR_LOCAL_MUTATION_SETTING}
        `,
        query_params: { key },
      });
    }

    return exists;
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.query({
      query: `
        SELECT 1 AS found
        FROM ${TABLE} FINAL
        SETTINGS max_execution_time = 5
        WHERE key = {key:String}
          AND (expires_at IS NULL OR expires_at > now64(3))
        LIMIT 1
      `,
      query_params: { key },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{ found: number }>();
    return rows.length > 0;
  }

  async query(params: QueryFactsParams): Promise<Fact[]> {
    const conditions: string[] = [];
    const queryParams: Record<string, unknown> = {};

    if (params.prefix) {
      conditions.push(`key LIKE {prefix:String}`);
      queryParams.prefix = `${params.prefix}%`;
    }

    if (params.pattern) {
      const regex = params.pattern.replace(/\./g, '\\\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
      conditions.push(`match(key, {pattern:String})`);
      queryParams.pattern = `^${regex}$`;
    }

    if (params.sourceType) {
      conditions.push(`source_type = {sourceType:String}`);
      queryParams.sourceType = params.sourceType;
    }

    if (!params.includeExpired) {
      conditions.push(`(expires_at IS NULL OR expires_at > now64(3))`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitClause = params.limit ? `LIMIT {limit:UInt32}` : '';

    if (params.limit) {
      queryParams.limit = params.limit;
    }

    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${TABLE} FINAL
        SETTINGS max_execution_time = 5
        ${whereClause}
        ORDER BY updated_at DESC
        ${limitClause}
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseFactRow>();
    return rows.map((row) => this.mapToFact(row));
  }

  async batchSet(params: BatchSetParams): Promise<Fact[]> {
    const results: Fact[] = [];

    for (const factParams of params.facts) {
      const fact = await this.set({
        ...factParams,
        source: factParams.source || params.defaultSource,
      });
      results.push(fact);
    }

    return results;
  }

  async batchDelete(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    const countResult = await this.client.query({
      query: `
        SELECT count() AS cnt
        FROM ${TABLE} FINAL
        SETTINGS max_execution_time = 5
        WHERE key IN ({keys:Array(String)})
      `,
      query_params: { keys },
      format: 'JSONEachRow',
    });

    const countRows = await countResult.json<{ cnt: string }>();
    const count = parseInt(countRows[0]?.cnt || '0', 10);

    if (count > 0) {
      await this.client.command({
        query: `
          ALTER TABLE ${TABLE} DELETE
          WHERE key IN ({keys:Array(String)})
          ${WAIT_FOR_LOCAL_MUTATION_SETTING}
        `,
        query_params: { keys },
      });
    }

    return count;
  }

  async clear(): Promise<number> {
    const countResult = await this.client.query({
      query: `SELECT count() AS cnt FROM ${TABLE} FINAL SETTINGS max_execution_time = 5`,
      format: 'JSONEachRow',
    });

    const countRows = await countResult.json<{ cnt: string }>();
    const count = parseInt(countRows[0]?.cnt || '0', 10);

    if (count > 0) {
      await this.client.command({
        query: `TRUNCATE TABLE ${TABLE}`,
      });
    }

    return count;
  }

  async cleanup(): Promise<number> {
    const countResult = await this.client.query({
      query: `
        SELECT count() AS cnt
        FROM ${TABLE} FINAL
        SETTINGS max_execution_time = 5
        WHERE expires_at IS NOT NULL AND expires_at < now64(3)
      `,
      format: 'JSONEachRow',
    });

    const countRows = await countResult.json<{ cnt: string }>();
    const count = parseInt(countRows[0]?.cnt || '0', 10);

    if (count > 0) {
      await this.client.command({
        query: `
          ALTER TABLE ${TABLE} DELETE
          WHERE expires_at IS NOT NULL AND expires_at < now64(3)
          ${WAIT_FOR_LOCAL_MUTATION_SETTING}
        `,
      });
    }

    return count;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private parseChDate(s: string): Date {
    // ClickHouse format 'YYYY-MM-DD HH:MM:SS.mmm' has no timezone indicator;
    // append 'Z' so JavaScript interprets it as UTC (not local time).
    if (s && !s.endsWith('Z') && !s.includes('T')) {
      return new Date(s.replace(' ', 'T') + 'Z');
    }
    return new Date(s);
  }

  private mapToFact(row: ClickHouseFactRow): Fact {
    return {
      id: row.id,
      key: row.key,
      value: tryParseJson(row.value) ?? row.value,
      createdAt: this.parseChDate(row.created_at),
      updatedAt: this.parseChDate(row.updated_at),
      expiresAt: row.expires_at ? this.parseChDate(row.expires_at) : null,
      source: {
        type: row.source_type as FactSource['type'],
        agentName: row.source_agent_name || undefined,
        sessionId: row.source_session_id || undefined,
        traceId: row.source_trace_id || undefined,
      },
      metadata: tryParseJson(row.metadata) || {},
    };
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createClickHouseFactStore(
  client: ClickHouseClient,
  config?: Partial<FactStoreConfig>,
): ClickHouseFactStore {
  return new ClickHouseFactStore({ type: 'clickhouse', ...config }, { client });
}
