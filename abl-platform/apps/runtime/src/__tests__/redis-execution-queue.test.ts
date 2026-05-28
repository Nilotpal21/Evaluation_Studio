import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisExecutionQueue } from '../services/execution/redis-execution-queue.js';
import { RedisDedupStore } from '../services/execution/execution-dedup.js';
import { createExecution } from '@agent-platform/execution';

function makeExec(sessionId: string, message: string) {
  return createExecution({
    sessionId,
    tenantId: 'tenant-1',
    message,
    agentName: 'test_agent',
  });
}

function createMockRedis() {
  return {
    rpush: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    lpop: vi.fn().mockResolvedValue(null),
    lindex: vi.fn().mockResolvedValue(null),
    llen: vi.fn().mockResolvedValue(0),
    lrange: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

describe('RedisExecutionQueue', () => {
  let queue: RedisExecutionQueue;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    queue = new RedisExecutionQueue(mockRedis as any);
  });

  it('enqueue calls RPUSH with serialized execution and sets TTL', async () => {
    const exec = makeExec('sess-1', 'hello');
    await queue.enqueue('sess-1', exec);

    expect(mockRedis.rpush).toHaveBeenCalledWith('exec:queue:sess-1', JSON.stringify(exec));
    expect(mockRedis.expire).toHaveBeenCalledWith('exec:queue:sess-1', 600);
  });

  it('dequeue calls LPOP and parses result', async () => {
    const exec = makeExec('sess-1', 'hello');
    mockRedis.lpop.mockResolvedValue(JSON.stringify(exec));

    const result = await queue.dequeue('sess-1');
    expect(result?.message).toBe('hello');
    expect(mockRedis.lpop).toHaveBeenCalledWith('exec:queue:sess-1');
  });

  it('dequeue returns null when queue is empty', async () => {
    const result = await queue.dequeue('sess-1');
    expect(result).toBeNull();
  });

  it('peek calls LINDEX 0 without removing', async () => {
    const exec = makeExec('sess-1', 'hello');
    mockRedis.lindex.mockResolvedValue(JSON.stringify(exec));

    const result = await queue.peek('sess-1');
    expect(result?.message).toBe('hello');
    expect(mockRedis.lindex).toHaveBeenCalledWith('exec:queue:sess-1', 0);
  });

  it('peek returns null for empty queue', async () => {
    const result = await queue.peek('sess-1');
    expect(result).toBeNull();
  });

  it('length calls LLEN', async () => {
    mockRedis.llen.mockResolvedValue(3);
    const len = await queue.length('sess-1');
    expect(len).toBe(3);
    expect(mockRedis.llen).toHaveBeenCalledWith('exec:queue:sess-1');
  });

  it('setActive and getActive use SET/GET with TTL', async () => {
    const exec = makeExec('sess-1', 'active');
    exec.status = 'running';

    await queue.setActive('sess-1', exec);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'exec:active:sess-1',
      JSON.stringify(exec),
      'EX',
      300,
    );

    mockRedis.get.mockResolvedValue(JSON.stringify(exec));
    const result = await queue.getActive('sess-1');
    expect(result?.message).toBe('active');
    expect(result?.status).toBe('running');
  });

  it('getActive returns null when no active execution', async () => {
    const result = await queue.getActive('sess-1');
    expect(result).toBeNull();
  });

  it('clearActive calls DEL', async () => {
    await queue.clearActive('sess-1');
    expect(mockRedis.del).toHaveBeenCalledWith('exec:active:sess-1');
  });

  it('cancelAll reads all items and deletes the key', async () => {
    const e1 = makeExec('sess-1', 'a');
    const e2 = makeExec('sess-1', 'b');
    mockRedis.lrange.mockResolvedValue([JSON.stringify(e1), JSON.stringify(e2)]);

    const cancelled = await queue.cancelAll('sess-1');
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0].status).toBe('cancelled');
    expect(cancelled[1].status).toBe('cancelled');
    expect(cancelled[0].message).toBe('a');
    expect(cancelled[1].message).toBe('b');
    expect(mockRedis.lrange).toHaveBeenCalledWith('exec:queue:sess-1', 0, -1);
    expect(mockRedis.del).toHaveBeenCalledWith('exec:queue:sess-1');
  });

  it('cancelAll returns empty array when queue is empty', async () => {
    const cancelled = await queue.cancelAll('sess-1');
    expect(cancelled).toHaveLength(0);
    expect(mockRedis.del).toHaveBeenCalledWith('exec:queue:sess-1');
  });

  it('serialization does not preserve AbortSignal functionality', async () => {
    const exec = makeExec('sess-1', 'with-signal');
    exec.signal = new AbortController().signal;

    await queue.enqueue('sess-1', exec);

    // JSON.stringify serializes AbortSignal as {} — it loses all functionality.
    // When deserialized, it will NOT be an AbortSignal instance.
    const serialized = mockRedis.rpush.mock.calls[0][1];
    const parsed = JSON.parse(serialized);
    expect(parsed.signal).not.toBeInstanceOf(AbortSignal);
    expect(parsed.message).toBe('with-signal');
  });
});

describe('RedisDedupStore', () => {
  let store: RedisDedupStore;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    store = new RedisDedupStore(mockRedis as any);
  });

  it('get delegates to Redis GET', async () => {
    mockRedis.get.mockResolvedValue('exec-123');
    const result = await store.get('some-key');
    expect(result).toBe('exec-123');
    expect(mockRedis.get).toHaveBeenCalledWith('some-key');
  });

  it('get returns null when key does not exist', async () => {
    const result = await store.get('missing-key');
    expect(result).toBeNull();
  });

  it('set uses SET with PX and NX flags', async () => {
    const result = await store.set('dedup-key', 'exec-456', 5000);
    expect(result).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith('dedup-key', 'exec-456', 'PX', 5000, 'NX');
  });

  it('set returns false when key already exists (NX fails)', async () => {
    mockRedis.set.mockResolvedValue(null);
    const result = await store.set('existing-key', 'exec-789', 5000);
    expect(result).toBe(false);
  });
});
