/**
 * Mock ClickHouse Client for Tests
 *
 * Provides an in-memory mock of the ClickHouse client
 * for testing ClickHouse store implementations without a real server.
 */

import { vi } from 'vitest';

interface MockRow {
  [key: string]: unknown;
}

export interface MockClickHouseClient {
  query: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  /** In-memory rows for testing queries */
  _rows: Map<string, MockRow[]>;
  /** Add test data for a table */
  _addRows: (table: string, rows: MockRow[]) => void;
  /** Clear all test data */
  _clear: () => void;
}

export function createMockClickHouseClient(): MockClickHouseClient {
  const rows = new Map<string, MockRow[]>();

  const client: MockClickHouseClient = {
    query: vi.fn().mockImplementation(async (opts: { query: string; format?: string }) => {
      // Simple mock: return empty results by default
      const tableMatch = opts.query.match(/FROM\s+(\S+)/i);
      const table = tableMatch?.[1] || '';
      const tableRows = rows.get(table) || [];
      return {
        json: async () => tableRows,
        text: async () => JSON.stringify(tableRows),
      };
    }),
    insert: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    _rows: rows,
    _addRows: (table: string, newRows: MockRow[]) => {
      const existing = rows.get(table) || [];
      rows.set(table, [...existing, ...newRows]);
    },
    _clear: () => rows.clear(),
  };

  return client;
}
