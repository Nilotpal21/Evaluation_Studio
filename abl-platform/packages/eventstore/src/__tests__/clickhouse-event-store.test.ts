import { describe, expect, it, vi } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';
import { ClickHouseEventStore } from '../stores/clickhouse/clickhouse-event-store.js';
import { PROJECT_A, TENANT_A } from './helpers.js';

vi.mock('@agent-platform/database/clickhouse.js', () => ({
  BufferedClickHouseWriter: vi.fn().mockImplementation(function () {
    return {
      insert: vi.fn(),
      insertMany: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      get pending() {
        return 0;
      },
    };
  }),
}));

describe('ClickHouseEventStore validation', () => {
  const timeRange = {
    from: new Date('2026-02-27T00:00:00Z'),
    to: new Date('2026-02-28T00:00:00Z'),
  };

  function createStore() {
    const client = {
      query: vi.fn(),
      command: vi.fn(),
      insert: vi.fn(),
    } as unknown as ClickHouseClient;

    return {
      client,
      store: new ClickHouseEventStore({ client }),
    };
  }

  it('fails closed before querying when aggregate groupBy contains an unsupported dimension', async () => {
    const { client, store } = createStore();

    await expect(
      store.aggregate({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange,
        groupBy: ['category', 'raw_sql' as never],
        metrics: ['count'],
      }),
    ).rejects.toThrow('Unsupported aggregate groupBy dimension: raw_sql');

    expect(client.query).not.toHaveBeenCalled();
  });

  it('fails closed before querying when aggregate metrics contain an unsupported name', async () => {
    const { client, store } = createStore();

    await expect(
      store.aggregate({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange,
        groupBy: ['category'],
        metrics: ['count', 'raw_sql' as never],
      }),
    ).rejects.toThrow('Unsupported aggregate metric: raw_sql');

    expect(client.query).not.toHaveBeenCalled();
  });

  it('fails closed before querying when count groupBy contains an unsupported dimension', async () => {
    const { client, store } = createStore();

    await expect(
      store.count({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange,
        groupBy: 'raw_sql' as never,
      }),
    ).rejects.toThrow('Unsupported count groupBy dimension: raw_sql');

    expect(client.query).not.toHaveBeenCalled();
  });

  it('scrubs payload and top-level error text for PII event types', async () => {
    const { client, store } = createStore();

    await store.scrubPII(TENANT_A, new Date('2026-02-01T00:00:00Z'), ['tool.call.failed']);

    expect(client.command).toHaveBeenCalledTimes(2);
    const commandArgs = vi
      .mocked(client.command)
      .mock.calls.map((call) => call[0] as { query: string });
    expect(
      commandArgs.some((arg) => arg.query.includes('ALTER TABLE abl_platform.platform_events')),
    ).toBe(true);
    expect(
      commandArgs.some((arg) =>
        arg.query.includes('ALTER TABLE abl_platform.platform_events_by_session'),
      ),
    ).toBe(true);
    for (const commandArg of commandArgs) {
      expect(commandArg.query).toContain('data = \'{"anonymized":true}\'');
      expect(commandArg.query).toContain("error_message = ''");
      expect(commandArg.query).toContain("error_type = ''");
      expect(commandArg.query).toContain("metadata = '{}'");
      expect(commandArg.query).toContain('custom_dimensions = map()');
      expect(commandArg.query).toContain('SETTINGS mutations_sync = 1');
    }
  });

  it('applies lifecycle mutations to the session projection table', async () => {
    const { client, store } = createStore();

    await store.purgeExpired(TENANT_A, new Date('2026-02-01T00:00:00Z'));
    await store.deleteBySessionIds(TENANT_A, ['session-1']);
    await store.anonymizeActor(TENANT_A, 'user-123456789');
    await store.deleteTenant(TENANT_A);

    const queries = vi
      .mocked(client.command)
      .mock.calls.map((call) => (call[0] as { query: string }).query);
    const bySessionMutations = queries.filter((query) =>
      query.includes('ALTER TABLE abl_platform.platform_events_by_session'),
    );
    expect(bySessionMutations).toHaveLength(4);
    for (const query of queries) {
      expect(query).toContain('SETTINGS mutations_sync = 1');
    }
    expect(
      bySessionMutations.some((query) => query.includes('timestamp < {olderThan:DateTime64(3)}')),
    ).toBe(true);
    expect(
      bySessionMutations.some((query) =>
        query.includes('session_id IN {sessionIds:Array(String)}'),
      ),
    ).toBe(true);
    expect(
      bySessionMutations.some((query) => query.includes('UPDATE actor_id = {anonymizedId:String}')),
    ).toBe(true);
    expect(
      bySessionMutations.some((query) =>
        query.includes('DELETE WHERE tenant_id = {tenantId:String}'),
      ),
    ).toBe(true);
  });
});
