/**
 * ClickHouse Client Configuration Tests
 *
 * Validates that createConfiguredClickHouseClient passes the correct
 * request_timeout to the @clickhouse/client createClient call,
 * reading from CLICKHOUSE_REQUEST_TIMEOUT_MS env var.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the third-party @clickhouse/client — allowed per test rules
const mockCreateClient = vi.fn().mockReturnValue({
  insert: vi.fn(),
  query: vi.fn(),
  command: vi.fn(),
  close: vi.fn(),
});

vi.mock('@clickhouse/client', () => ({
  createClient: mockCreateClient,
  ClickHouseLogLevel: { OFF: 'OFF' },
}));

describe('ClickHouse client request_timeout configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockClear();
    process.env = { ...originalEnv };
    // Clear any cached singleton
    delete (globalThis as Record<string, unknown>)['__abl_clickhouse_client__'];
  });

  afterEach(() => {
    process.env = originalEnv;
    delete (globalThis as Record<string, unknown>)['__abl_clickhouse_client__'];
  });

  test('uses default 120s timeout when CLICKHOUSE_REQUEST_TIMEOUT_MS is not set', async () => {
    delete process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS;

    const { getClickHouseClient } = await import('../clickhouse.js');
    getClickHouseClient();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateClient.mock.calls[0][0];
    expect(callArgs.request_timeout).toBe(120_000);
  });

  test('reads CLICKHOUSE_REQUEST_TIMEOUT_MS from env and passes as request_timeout', async () => {
    process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS = '120000';

    const { getClickHouseClient } = await import('../clickhouse.js');
    getClickHouseClient();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateClient.mock.calls[0][0];
    expect(callArgs.request_timeout).toBe(120_000);
  });

  test('createDedicatedClickHouseClient also respects CLICKHOUSE_REQUEST_TIMEOUT_MS', async () => {
    process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS = '60000';

    const { createDedicatedClickHouseClient } = await import('../clickhouse.js');
    createDedicatedClickHouseClient();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateClient.mock.calls[0][0];
    expect(callArgs.request_timeout).toBe(60_000);
  });

  test('handles non-numeric CLICKHOUSE_REQUEST_TIMEOUT_MS gracefully (NaN falls to default)', async () => {
    process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS = 'not-a-number';

    const { getClickHouseClient } = await import('../clickhouse.js');
    getClickHouseClient();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateClient.mock.calls[0][0];
    // parseInt('not-a-number') => NaN — should fall back to 120s default
    expect(callArgs.request_timeout).toBe(120_000);
  });
});
