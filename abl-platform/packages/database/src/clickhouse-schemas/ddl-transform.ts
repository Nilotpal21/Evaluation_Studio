import { resolveClickHouseDatabaseName } from './database.js';

export interface DDLTransformOptions {
  useReplicated: boolean;
  useTieredStorage: boolean;
  database: string;
}

export function resolveDDLTransformOptions(
  env: Record<string, string | undefined> = process.env,
): DDLTransformOptions {
  return {
    useReplicated: env.CLICKHOUSE_REPLICATED === 'true',
    useTieredStorage: env.CLICKHOUSE_TIERED_STORAGE === 'true',
    database: resolveClickHouseDatabaseName(env.CLICKHOUSE_DATABASE),
  };
}

/**
 * Strips the Replicated prefix from a ClickHouse engine declaration,
 * preserving any non-replication arguments (e.g. version column in
 * ReplicatedReplacingMergeTree).
 *
 * Engine argument list format:
 *   ReplicatedXxx('/path', '{replica}')              → Xxx()
 *   ReplicatedXxx('/path', '{replica}', versionCol)  → Xxx(versionCol)
 *
 * The two replication-only positional args are the ZooKeeper path (first
 * single-quoted string) and the replica name (second single-quoted string).
 * Everything after that is passed through.
 */
function stripReplicatedEngine(ddl: string): string {
  // Match: Replicated<EngineName>( '<zk_path>', '{replica}' [, remaining_args] )
  // Uses a regex that explicitly matches the two single-quoted replication args,
  // then captures any remaining args (which may contain nested parentheses).
  return ddl.replace(
    /Replicated(\w*MergeTree)\(\s*'[^']*'\s*,\s*'[^']*'(?:\s*,\s*([\s\S]*?))?\)/g,
    (_match: string, engineSuffix: string, remainingArgs: string | undefined): string => {
      const remaining = remainingArgs?.trim() ?? '';
      return `${engineSuffix}(${remaining})`;
    },
  );
}

/**
 * Strips TTL clauses that move data to a named volume (`TO VOLUME '...'`) while
 * keeping DELETE TTL rules and other TTL expressions intact.
 *
 * Handles:
 *   , col + INTERVAL N DAY TO VOLUME 'warm'
 *   , toDateTime(col) + INTERVAL N DAY TO VOLUME 'cold'
 * in either comma-first or comma-last positions inside a TTL block.
 */
function stripTieredStorageTtl(ddl: string): string {
  // Remove volume TTL clauses — leading comma variant
  ddl = ddl.replace(
    /,\s*(?:toDateTime\(\w+\)|\w+)\s*\+\s*INTERVAL\s+\d+\s+\w+\s+TO\s+VOLUME\s+'[^']+'/gi,
    '',
  );

  // Remove volume TTL clauses — trailing comma variant (clause is first in TTL list)
  ddl = ddl.replace(
    /(?:toDateTime\(\w+\)|\w+)\s*\+\s*INTERVAL\s+\d+\s+\w+\s+TO\s+VOLUME\s+'[^']+'\s*,?\s*/gi,
    '',
  );

  // Remove storage_policy setting (with or without trailing comma)
  ddl = ddl.replace(/\s*storage_policy\s*=\s*'[^']+'\s*,?/gi, '');

  return ddl;
}

/**
 * Cleans up TTL blocks after stripping:
 *  - Removes empty TTL blocks (TTL immediately followed by SETTINGS or end of
 *    statement)
 *  - Removes stray commas directly after the TTL keyword
 *  - Collapses excessive whitespace inside TTL blocks
 */
function cleanupTtlBlock(ddl: string): string {
  // Strip SQL line comments so they don't interfere with cleanup
  ddl = ddl.replace(/--[^\n]*/g, '');

  // Remove stray comma directly after TTL keyword
  ddl = ddl.replace(/\bTTL\s*,/g, 'TTL\n');

  // Remove empty TTL block: TTL <whitespace> SETTINGS → SETTINGS
  ddl = ddl.replace(/\bTTL\s+SETTINGS\b/g, 'SETTINGS');

  // Remove entirely empty TTL block at end of statement
  ddl = ddl.replace(/\bTTL\s*;/, ';');

  return ddl;
}

/**
 * Replaces `abl_platform.` database prefix with the resolved database name.
 */
function replaceDatabaseName(ddl: string, database: string): string {
  return ddl.replace(/\babl_platform\./g, `${database}.`);
}

/**
 * Applies all configured DDL transformations in order:
 * 1. Strip Replicated engines (when useReplicated=false)
 * 2. Strip tiered storage TTL rules (when useTieredStorage=false)
 * 3. Clean up leftover TTL artefacts
 * 4. Replace database name prefix
 */
export function transformDDL(ddl: string, options: DDLTransformOptions): string {
  let result = ddl;

  if (!options.useReplicated) {
    result = stripReplicatedEngine(result);
  }

  if (!options.useTieredStorage) {
    result = stripTieredStorageTtl(result);
  }

  if (!options.useReplicated || !options.useTieredStorage) {
    result = cleanupTtlBlock(result);
  }

  result = replaceDatabaseName(result, options.database);

  return result;
}
