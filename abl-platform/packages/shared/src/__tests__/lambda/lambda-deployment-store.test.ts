import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
};

// Stub `scanKeys` so it yields whatever the test's `mockRedis.keys` returns —
// the production code uses `for await (const k of scanKeys(client, pattern))`.
vi.mock('@agent-platform/redis', () => ({
  scanKeys: async function* (_client: unknown, pattern: string): AsyncIterable<string> {
    const keys: string[] = await mockRedis.keys(pattern);
    for (const k of keys) yield k;
  },
}));

import {
  RedisLambdaDeploymentStore,
  type LambdaDeploymentRecord,
} from '../../services/lambda/lambda-deployment-store.js';

function makeRecord(overrides: Partial<LambdaDeploymentRecord> = {}): LambdaDeploymentRecord {
  return {
    tenantId: 'tenant-1',
    runtime: 'javascript',
    functionName: 'abl-runner-tenant-1-js',
    status: 'active',
    region: 'us-east-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('RedisLambdaDeploymentStore', () => {
  let store: RedisLambdaDeploymentStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new RedisLambdaDeploymentStore(mockRedis as any);
  });

  it('get returns null when key does not exist', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await store.get('tenant-1', 'javascript');
    expect(result).toBeNull();
    expect(mockRedis.get).toHaveBeenCalledWith('lambda:runner:tenant-1:javascript');
  });

  it('get returns parsed record when key exists', async () => {
    const record = makeRecord();
    mockRedis.get.mockResolvedValue(JSON.stringify(record));
    const result = await store.get('tenant-1', 'javascript');
    expect(result).toEqual(record);
  });

  it('upsert serializes record to Redis', async () => {
    const record = makeRecord();
    mockRedis.set.mockResolvedValue('OK');
    await store.upsert(record);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'lambda:runner:tenant-1:javascript',
      JSON.stringify(record),
    );
  });

  it('updateStatus merges status and extra fields', async () => {
    const record = makeRecord({ status: 'deploying' });
    mockRedis.get.mockResolvedValue(JSON.stringify(record));
    mockRedis.set.mockResolvedValue('OK');
    await store.updateStatus('tenant-1', 'javascript', 'active', {
      lastHealthCheck: '2026-01-02T00:00:00Z',
    });
    const saved = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(saved.status).toBe('active');
    expect(saved.lastHealthCheck).toBe('2026-01-02T00:00:00Z');
  });

  it('updateStatus throws when record not found', async () => {
    mockRedis.get.mockResolvedValue(null);
    await expect(store.updateStatus('tenant-1', 'javascript', 'active')).rejects.toThrow(
      'not found',
    );
  });

  it('delete removes the key', async () => {
    mockRedis.del.mockResolvedValue(1);
    await store.delete('tenant-1', 'javascript');
    expect(mockRedis.del).toHaveBeenCalledWith('lambda:runner:tenant-1:javascript');
  });

  it('listByTenant returns all records for a tenant', async () => {
    const jsRecord = makeRecord({ runtime: 'javascript' });
    const pyRecord = makeRecord({ runtime: 'python', functionName: 'abl-runner-tenant-1-py' });
    mockRedis.keys.mockResolvedValue([
      'lambda:runner:tenant-1:javascript',
      'lambda:runner:tenant-1:python',
    ]);
    mockRedis.get
      .mockResolvedValueOnce(JSON.stringify(jsRecord))
      .mockResolvedValueOnce(JSON.stringify(pyRecord));
    const results = await store.listByTenant('tenant-1');
    expect(results).toHaveLength(2);
  });

  it('get returns null and logs warning when JSON is invalid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRedis.get.mockResolvedValue('not-valid-json!!!');
    const result = await store.get('tenant-1', 'javascript');
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it('listByTenant skips malformed entries', async () => {
    mockRedis.keys.mockResolvedValue([
      'lambda:runner:tenant-1:javascript',
      'lambda:runner:tenant-1:python',
    ]);
    mockRedis.get
      .mockResolvedValueOnce('not-valid-json')
      .mockResolvedValueOnce(JSON.stringify(makeRecord({ runtime: 'python' })));
    const results = await store.listByTenant('tenant-1');
    expect(results).toHaveLength(1);
    expect(results[0].runtime).toBe('python');
  });

  it('listByTenant skips null values from redis', async () => {
    mockRedis.keys.mockResolvedValue(['lambda:runner:tenant-1:javascript']);
    mockRedis.get.mockResolvedValueOnce(null);
    const results = await store.listByTenant('tenant-1');
    expect(results).toHaveLength(0);
  });

  it('uses default logger when no custom logger is provided', () => {
    const defaultStore = new RedisLambdaDeploymentStore(mockRedis as any);
    expect(defaultStore).toBeDefined();
  });

  it('uses custom logger when provided', async () => {
    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const customStore = new RedisLambdaDeploymentStore(mockRedis as any, customLogger);
    mockRedis.get.mockResolvedValue('not-valid-json');
    await customStore.get('tenant-1', 'javascript');
    expect(customLogger.warn).toHaveBeenCalledWith(
      'Failed to parse deployment record',
      expect.objectContaining({ tenantId: 'tenant-1' }),
    );
  });
});
