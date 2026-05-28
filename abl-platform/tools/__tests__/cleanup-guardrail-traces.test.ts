/**
 * CL-1 through CL-4: Unit / integration tests for
 * tools/cleanup-guardrail-traces.ts
 *
 * Mocks:
 *   - `@clickhouse/client` (external third-party — allowed per CLAUDE.md)
 *   - `process.argv` to inject CLI flags
 *   - `process.env` for CLICKHOUSE_URL presence / absence
 *   - `console.log` / `console.warn` for output assertions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @clickhouse/client — MUST be declared before the import of the SUT
// ---------------------------------------------------------------------------

/** Records every query() and command() call for assertion. */
interface RecordedCall {
  method: 'ping' | 'query' | 'command' | 'close';
  args?: unknown;
}

const calls: RecordedCall[] = [];
let pingResult = { success: true };

/**
 * Counter that the mock count-query returns. On first invocation it returns
 * `mockCount`; after a command() call (DELETE) it returns '0' to simulate
 * that records have been cleaned.
 */
let mockCount = '42';
let deleteCalled = false;

const mockJsonFn = vi.fn(async () => [{ cnt: deleteCalled ? '0' : mockCount }]);

const mockClient = {
  ping: vi.fn(async () => {
    calls.push({ method: 'ping' });
    return pingResult;
  }),
  query: vi.fn(async (params: unknown) => {
    calls.push({ method: 'query', args: params });
    return { json: mockJsonFn };
  }),
  command: vi.fn(async (params: unknown) => {
    calls.push({ method: 'command', args: params });
    deleteCalled = true;
  }),
  close: vi.fn(async () => {
    calls.push({ method: 'close' });
  }),
};

vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn(() => mockClient),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Saves + restores env and argv between tests. */
let savedEnv: NodeJS.ProcessEnv;
let savedArgv: string[];

/** Spies */
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Snapshot env + argv
  savedEnv = { ...process.env };
  savedArgv = [...process.argv];

  // Reset recorded calls & mock state
  calls.length = 0;
  deleteCalled = false;
  mockCount = '42';
  pingResult = { success: true };
  mockClient.ping.mockClear();
  mockClient.query.mockClear();
  mockClient.command.mockClear();
  mockClient.close.mockClear();
  mockJsonFn.mockClear();

  // Provide a ClickHouse URL so the script doesn't short-circuit
  process.env.CLICKHOUSE_URL = 'http://localhost:8123';
  // Non-production so dry-run defaults to true
  process.env.NODE_ENV = 'test';

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // Restore env + argv
  process.env = savedEnv;
  process.argv = savedArgv;

  logSpy.mockRestore();
  warnSpy.mockRestore();

  // Reset modules so the next test gets a fresh main() invocation
  vi.resetModules();
});

/**
 * Dynamically import the script so that each test gets its own top-level
 * `main()` execution (the script calls main() at module scope).
 */
async function runScript(args: string[]): Promise<void> {
  process.argv = ['node', 'cleanup-guardrail-traces.ts', ...args];
  await import('../cleanup-guardrail-traces.js');
  // Give the main().catch() chain a tick to settle
  await new Promise((r) => setTimeout(r, 50));
}

// ---------------------------------------------------------------------------
// CL-1: Dry-run mode
// ---------------------------------------------------------------------------

describe('CL-1: Dry-run mode', () => {
  it('prints "Would delete N records" without executing DELETE', async () => {
    mockCount = '7';

    await runScript(['--dry-run']);

    // Only ping + one SELECT count query + close should have been called
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('ping');
    expect(methods).toContain('query');
    expect(methods).not.toContain('command');
    expect(methods).toContain('close');

    // Exactly one query call (the SELECT count)
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(mockClient.command).not.toHaveBeenCalled();

    // Output includes the count
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Would delete');
    expect(output).toContain('7');
    expect(output).toContain('DRY-RUN');
  });

  it('defaults to dry-run in non-production NODE_ENV', async () => {
    // NODE_ENV is already 'test' from beforeEach — no --dry-run flag needed
    await runScript([]);

    expect(mockClient.command).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('DRY-RUN');
  });
});

// ---------------------------------------------------------------------------
// CL-2: Confirmed run
// ---------------------------------------------------------------------------

describe('CL-2: Confirmed run', () => {
  it('executes ALTER TABLE DELETE when --dry-run=false', async () => {
    mockCount = '15';

    await runScript(['--dry-run=false']);

    // Should have: ping, query (count), command (delete), close
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(mockClient.command).toHaveBeenCalledTimes(1);

    // Verify the DELETE command has the expected structure
    const commandArgs = mockClient.command.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(commandArgs.query).toContain('ALTER TABLE');
    expect(commandArgs.query).toContain('DELETE');
    expect(commandArgs.query).toContain('abl_platform.trace_events');

    // Verify parameterized arguments
    expect(commandArgs.query_params).toHaveProperty('presetKey', 'sensitive_data_block');
    expect(commandArgs.query_params).toHaveProperty('ttlDays', 90);
    expect(commandArgs.query_params).toHaveProperty('types');
    expect(commandArgs.query_params.types).toEqual(
      expect.arrayContaining(['guardrail_input_blocked', 'guardrail_output_blocked']),
    );

    // Output reports the deletion count
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Deleted');
    expect(output).toContain('15');
  });

  it('respects --ttl-days in the parameterized query', async () => {
    await runScript(['--dry-run=false', '--ttl-days=30']);

    const commandArgs = mockClient.command.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(commandArgs.query_params).toHaveProperty('ttlDays', 30);
  });
});

// ---------------------------------------------------------------------------
// CL-3: Idempotency
// ---------------------------------------------------------------------------

describe('CL-3: Idempotency', () => {
  it('second confirmed run reports 0 records affected', async () => {
    // First run — 42 records
    mockCount = '42';
    await runScript(['--dry-run=false']);

    const firstOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(firstOutput).toContain('42');
    expect(mockClient.command).toHaveBeenCalledTimes(1);

    // After the first DELETE, deleteCalled is true, so mockJsonFn returns '0'
    // Reset spies + module cache for second run (vi.mock is hoisted and persists)
    logSpy.mockClear();
    mockClient.query.mockClear();
    mockClient.command.mockClear();
    mockClient.close.mockClear();
    mockClient.ping.mockClear();
    calls.length = 0;
    vi.resetModules();

    // Re-set env since resetModules doesn't affect process.env
    process.env.CLICKHOUSE_URL = 'http://localhost:8123';
    process.env.NODE_ENV = 'test';

    // Second run — picks up 0 because deleteCalled=true from the first run
    await runScript(['--dry-run=false']);

    const secondOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // The second run should report 0 records deleted
    expect(secondOutput).toContain('Deleted 0 records');
    // DELETE still called (the script always runs it), but 0 affected
    expect(mockClient.command).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// CL-4: Safety guard
// ---------------------------------------------------------------------------

describe('CL-4: Safety guard', () => {
  it('exits gracefully with a warning when CLICKHOUSE_URL is unset', async () => {
    delete process.env.CLICKHOUSE_URL;
    delete process.env.CLICKHOUSE_HOST;

    await runScript([]);

    // Should NOT have tried to create/use the client
    expect(mockClient.ping).not.toHaveBeenCalled();
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.command).not.toHaveBeenCalled();

    // Should have logged a warning about missing config
    const warnOutput = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnOutput).toContain('CLICKHOUSE_URL');
    expect(warnOutput).toContain('skipping');
  });

  it('includes tenant_id filter when --tenant is provided', async () => {
    await runScript(['--dry-run', '--tenant=tenant-abc-123']);

    // The query should include the tenant filter
    const queryArgs = mockClient.query.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(queryArgs.query).toContain('tenant_id');
    expect(queryArgs.query_params).toHaveProperty('tenantId', 'tenant-abc-123');
  });

  it('does NOT include tenant_id filter when --tenant is omitted', async () => {
    await runScript(['--dry-run']);

    const queryArgs = mockClient.query.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(queryArgs.query).not.toContain('tenant_id');
    expect(queryArgs.query_params).not.toHaveProperty('tenantId');
  });
});
