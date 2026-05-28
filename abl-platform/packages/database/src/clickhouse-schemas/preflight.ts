/**
 * Preflight checks for ClickHouse schema operations.
 *
 * Validates Keeper availability, database engine compatibility, and
 * ClickHouse version before any schema changes are applied.
 * Shared by both init-all.ts and engine-reconciler.ts.
 */

import type { ClickHouseClient } from '@clickhouse/client';

export interface PreflightResult {
  keeperReachable: boolean;
  databaseEngine: string;
  clickhouseVersion: string;
}

/**
 * Run preflight checks against a ClickHouse cluster.
 *
 * 1. Keeper availability (via system.zookeeper)
 * 2. Database engine validation (must be Atomic or Replicated for EXCHANGE TABLES)
 * 3. ClickHouse version >= 21.8 (required for EXCHANGE TABLES)
 */
export async function runPreflightChecks(
  client: ClickHouseClient,
  database: string,
): Promise<PreflightResult> {
  // 1. Keeper availability
  let keeperReachable = false;
  try {
    await client.query({
      query:
        "SELECT count() FROM system.zookeeper WHERE path = '/' SETTINGS max_execution_time = 3",
      format: 'JSONEachRow',
    });
    keeperReachable = true;
  } catch {
    keeperReachable = false;
  }

  // 2. Database engine
  let databaseEngine = '';
  const dbResult = await client.query({
    query: `SELECT engine FROM system.databases WHERE name = '${database}'`,
    format: 'JSONEachRow',
  });
  const dbRows = (await dbResult.json()) as Array<{ engine: string }>;
  if (dbRows.length > 0) {
    databaseEngine = dbRows[0].engine;
  }

  // 3. ClickHouse version
  const versionResult = await client.query({
    query: 'SELECT version()',
    format: 'JSONEachRow',
  });
  const versionRows = (await versionResult.json()) as Array<{ 'version()': string }>;
  const clickhouseVersion = versionRows[0]?.['version()'] ?? '';

  console.log(
    `[CH Schema] Preflight: keeper=${keeperReachable ? 'reachable' : 'unreachable'}, dbEngine=${databaseEngine || 'n/a'}, version=${clickhouseVersion}`,
  );

  return { keeperReachable, databaseEngine, clickhouseVersion };
}

/**
 * Assert that all preflight checks passed for replicated mode.
 * Throws descriptive errors when a check fails.
 */
export function assertPreflightPassed(result: PreflightResult, database: string): void {
  if (!result.keeperReachable) {
    throw new Error(
      'CLICKHOUSE_REPLICATED=true but Keeper is not reachable. ' +
        'Fix Keeper or set CLICKHOUSE_REPLICATED=false.',
    );
  }

  if (
    result.databaseEngine &&
    result.databaseEngine !== 'Atomic' &&
    result.databaseEngine !== 'Replicated'
  ) {
    throw new Error(
      `Database '${database}' uses engine '${result.databaseEngine}'. ` +
        'EXCHANGE TABLES requires Atomic or Replicated database engine.',
    );
  }
  // If database doesn't exist yet, it will be created as Atomic (default in modern CH)

  const version = result.clickhouseVersion;
  if (version) {
    const [major, minor] = version.split('.').map(Number);
    if (major < 21 || (major === 21 && minor < 8)) {
      throw new Error(
        `ClickHouse version ${version} is too old. EXCHANGE TABLES requires >= 21.8.`,
      );
    }
  }
}
