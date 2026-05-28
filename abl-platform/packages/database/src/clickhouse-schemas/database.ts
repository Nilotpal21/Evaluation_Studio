export const DEFAULT_CLICKHOUSE_DATABASE = 'abl_platform';

export const CLICKHOUSE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates that a value is a safe ClickHouse identifier (table name, cluster name, etc.).
 * Throws if the value does not match `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function assertValidIdentifier(value: string, label: string): void {
  if (!CLICKHOUSE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid ClickHouse identifier for ${label}: ${value}`);
  }
}

export function resolveClickHouseDatabaseName(database?: string): string {
  const resolved =
    database?.trim() || process.env.CLICKHOUSE_DATABASE || DEFAULT_CLICKHOUSE_DATABASE;

  if (!CLICKHOUSE_IDENTIFIER_PATTERN.test(resolved)) {
    throw new Error(`Invalid ClickHouse database identifier: ${resolved}`);
  }

  return resolved;
}
