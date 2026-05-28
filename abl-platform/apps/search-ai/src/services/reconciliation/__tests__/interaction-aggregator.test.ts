import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mock references are available inside vi.mock factories
const { mockQuery, mockGetClickHouseClient } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockGetClickHouseClient = vi.fn(() => ({ query: mockQuery }));
  return { mockQuery, mockGetClickHouseClient };
});

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: mockGetClickHouseClient,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Must import AFTER mocks
import { InteractionAggregator } from '../interaction-aggregator.js';

describe('InteractionAggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure env vars are set so the constructor initializes the client
    process.env.CLICKHOUSE_URL = 'http://localhost:8123';
  });

  it('returns correct stats with proper clickRate computation', async () => {
    mockQuery.mockResolvedValue({
      json: () =>
        Promise.resolve([
          { attribute_type: 'interest_rate', impressions: '200', clicks: '20', unique_users: '5' },
          { attribute_type: 'apr', impressions: '100', clicks: '10', unique_users: '3' },
        ]),
    });

    const aggregator = new InteractionAggregator();
    const result = await aggregator.aggregateInteractions('t1', 'idx1', 14);

    expect(result.size).toBe(2);

    const ir = result.get('interest_rate');
    expect(ir).toBeDefined();
    expect(ir!.impressions).toBe(200);
    expect(ir!.clicks).toBe(20);
    expect(ir!.uniqueUsers).toBe(5);
    expect(ir!.clickRate).toBeCloseTo(0.1);

    const apr = result.get('apr');
    expect(apr).toBeDefined();
    expect(apr!.clickRate).toBeCloseTo(0.1);
  });

  it('passes correct query params (tenantId, indexId, windowDays)', async () => {
    mockQuery.mockResolvedValue({
      json: () => Promise.resolve([]),
    });

    const aggregator = new InteractionAggregator();
    await aggregator.aggregateInteractions('tenant-abc', 'index-xyz', 7);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: expect.objectContaining({
          tenantId: 'tenant-abc',
          indexId: 'index-xyz',
          windowDays: 7,
        }),
        format: 'JSONEachRow',
      }),
    );
  });

  it('handles zero impressions without division by zero', async () => {
    mockQuery.mockResolvedValue({
      json: () =>
        Promise.resolve([
          { attribute_type: 'test', impressions: '0', clicks: '0', unique_users: '0' },
        ]),
    });

    const aggregator = new InteractionAggregator();
    const result = await aggregator.aggregateInteractions('t1', 'idx1', 14);

    const stat = result.get('test');
    expect(stat).toBeDefined();
    expect(stat!.clickRate).toBe(0);
    expect(stat!.impressions).toBe(0);
  });

  it('returns empty map when ClickHouse query fails (fail-open)', async () => {
    mockQuery.mockRejectedValue(new Error('Connection refused'));

    const aggregator = new InteractionAggregator();
    const result = await aggregator.aggregateInteractions('t1', 'idx1', 14);

    expect(result.size).toBe(0);
  });

  it('returns 0 for NaN values from ClickHouse (parseInt fallback)', async () => {
    mockQuery.mockResolvedValue({
      json: () =>
        Promise.resolve([
          {
            attribute_type: 'broken_attr',
            impressions: 'not_a_number',
            clicks: '',
            unique_users: 'undefined',
          },
        ]),
    });

    const aggregator = new InteractionAggregator();
    const result = await aggregator.aggregateInteractions('t1', 'idx1', 14);

    const stat = result.get('broken_attr');
    expect(stat).toBeDefined();
    expect(stat!.impressions).toBe(0);
    expect(stat!.clicks).toBe(0);
    expect(stat!.uniqueUsers).toBe(0);
    expect(stat!.clickRate).toBe(0);
  });

  it('returns empty map when ClickHouse is unavailable at construction', async () => {
    // Clear env vars so the constructor skips client init
    delete process.env.CLICKHOUSE_URL;
    delete process.env.CLICKHOUSE_HOST;

    const aggregator = new InteractionAggregator();
    const result = await aggregator.aggregateInteractions('t1', 'idx1', 14);

    expect(result.size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns empty map for windowDays <= 0 without querying ClickHouse', async () => {
    const aggregator = new InteractionAggregator();

    const resultZero = await aggregator.aggregateInteractions('t1', 'idx1', 0);
    expect(resultZero.size).toBe(0);

    const resultNeg = await aggregator.aggregateInteractions('t1', 'idx1', -5);
    expect(resultNeg.size).toBe(0);

    // Should not have queried ClickHouse
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
