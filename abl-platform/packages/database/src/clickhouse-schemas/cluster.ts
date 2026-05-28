import type { ClickHouseClient } from '@clickhouse/client';
import { assertValidIdentifier } from './database.js';

/**
 * Auto-detect the ClickHouse cluster name from the connected server.
 * Queries system.clusters for the cluster that the current node belongs to.
 * Returns undefined if no cluster is configured (single-node / non-replicated).
 */
export async function detectClusterName(client: ClickHouseClient): Promise<string | undefined> {
  try {
    const result = await client.query({
      query: `SELECT cluster FROM system.clusters WHERE is_local = 1 AND cluster != 'default' LIMIT 1`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ cluster: string }>;
    const cluster = rows[0]?.cluster;
    if (cluster) {
      assertValidIdentifier(cluster, 'cluster');
      console.log(`[CH Schema] Cluster auto-detected: '${cluster}'`);
      return cluster;
    }
    console.log('[CH Schema] No cluster detected (single-node mode)');
    return undefined;
  } catch {
    console.log('[CH Schema] Cluster detection skipped (system.clusters not accessible)');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// ON CLUSTER injection helpers (shared across init.ts, init-all.ts, engine-reconciler.ts)
// ---------------------------------------------------------------------------

/**
 * Inject `ON CLUSTER '<cluster>'` into a DDL statement based on its type.
 * Handles CREATE TABLE, CREATE DATABASE, ALTER TABLE, DROP VIEW,
 * CREATE MATERIALIZED VIEW.
 */
export function injectOnClusterForStatement(query: string, cluster: string): string {
  assertValidIdentifier(cluster, 'cluster');
  const trimmed = query.trim();

  if (/^CREATE\s+DATABASE/i.test(trimmed)) {
    return trimmed.replace(
      /(CREATE\s+DATABASE\s+IF\s+NOT\s+EXISTS\s+\S+)/i,
      `$1 ON CLUSTER '${cluster}'`,
    );
  }

  if (/^CREATE\s+MATERIALIZED\s+VIEW/i.test(trimmed)) {
    return trimmed.replace(
      /(CREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\s+\S+)/i,
      `$1 ON CLUSTER '${cluster}'`,
    );
  }

  if (/^CREATE\s+TABLE/i.test(trimmed)) {
    return trimmed.replace(
      /(CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+\S+)/i,
      `$1 ON CLUSTER '${cluster}'`,
    );
  }

  if (/^ALTER\s+TABLE/i.test(trimmed)) {
    return trimmed.replace(/(ALTER\s+TABLE\s+\S+)/i, `$1 ON CLUSTER '${cluster}'`);
  }

  if (/^DROP\s+VIEW/i.test(trimmed)) {
    return trimmed.replace(/(DROP\s+VIEW\s+IF\s+EXISTS\s+\S+)/i, `$1 ON CLUSTER '${cluster}'`);
  }

  return trimmed;
}

/**
 * Apply ON CLUSTER to a DDL statement if cluster is set.
 * Returns the statement unchanged if cluster is undefined.
 */
export function applyOnCluster(ddl: string, cluster: string | undefined): string {
  if (!cluster) return ddl;
  return injectOnClusterForStatement(ddl, cluster);
}
