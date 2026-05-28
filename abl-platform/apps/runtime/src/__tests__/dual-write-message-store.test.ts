/**
 * DualWriteMessageStore Unit Tests
 *
 * Tests the dual-write wrapper that delegates reads to Mongo and
 * fire-and-forgets writes to ClickHouse when USE_MONGO_CLICKHOUSE=true.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// MOCK SETUP
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  Message: { create: vi.fn(), find: vi.fn(), countDocuments: vi.fn(), deleteMany: vi.fn() },
  Session: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import type { Message } from '@abl/compiler/platform/core/types.js';
import type { AddMessageParams } from '@abl/compiler/platform/stores/message-store.js';
import type { ClickHouseMessageStore } from '../services/stores/clickhouse-message-store.js';
import {
  DualWriteMessageStore,
  type ClickHouseStoreFactory,
} from '../services/stores/store-factory.js';
import { MongoMessageStore } from '../services/stores/mongo-message-store.js';

// =============================================================================
// HELPERS
// =============================================================================

const ORIGINAL_ENV = { ...process.env };

function makeFakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    role: 'user',
    content: 'hello',
    channel: 'web_chat',
    timestamp: new Date(),
    traceId: 'trace-1',
    metadata: {},
    ...overrides,
  };
}

function makeFakeMongoStore(): MongoMessageStore {
  const store = Object.create(MongoMessageStore.prototype);
  store.config = { type: 'mongodb' };
  store.addMessage = vi.fn();
  store.getMessages = vi.fn();
  store.getMessageCount = vi.fn();
  store.deleteBySession = vi.fn();
  store.cleanup = vi.fn();
  store.scrubMessages = vi.fn();
  store.scrubMessagesBySession = vi.fn();
  return store as MongoMessageStore;
}

function makeFakeChStore(): ClickHouseMessageStore {
  return {
    addMessage: vi.fn().mockResolvedValue(makeFakeMessage()),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessageCount: vi.fn().mockResolvedValue(0),
    deleteBySession: vi.fn().mockResolvedValue(0),
    cleanup: vi.fn().mockResolvedValue(0),
    scrubByContact: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    config: { type: 'clickhouse' as const },
  } as unknown as ClickHouseMessageStore;
}

// =============================================================================
// TESTS
// =============================================================================

describe('DualWriteMessageStore', () => {
  let mongoStore: MongoMessageStore;
  let chStore: ClickHouseMessageStore;
  let chFactory: ClickHouseStoreFactory;

  beforeEach(() => {
    mongoStore = makeFakeMongoStore();
    chStore = makeFakeChStore();
    chFactory = vi.fn().mockResolvedValue(chStore);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // addMessage
  // ---------------------------------------------------------------------------

  describe('addMessage', () => {
    test('returns Mongo result when dual-write is disabled', async () => {
      delete process.env.USE_MONGO_CLICKHOUSE;
      const expected = makeFakeMessage();
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

      const store = new DualWriteMessageStore(mongoStore, chFactory);
      const result = await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'hi',
        channel: 'web_chat',
        traceId: 'trace-1',
      });

      expect(result).toBe(expected);
      expect(mongoStore.addMessage).toHaveBeenCalledOnce();
      expect(chFactory).not.toHaveBeenCalled();
    });

    test('returns Mongo result and fires ClickHouse write when enabled', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      const expected = makeFakeMessage();
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

      const store = new DualWriteMessageStore(mongoStore, chFactory);
      const params: AddMessageParams = {
        sessionId: 'sess-1',
        role: 'user',
        content: 'hi',
        channel: 'web_chat',
        traceId: 'trace-1',
        metadata: { tenantId: 'tenant-1' },
      };
      const result = await store.addMessage(params);

      expect(result).toBe(expected);
      expect(mongoStore.addMessage).toHaveBeenCalledOnce();

      // Allow fire-and-forget promise to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(chFactory).toHaveBeenCalledWith('tenant-1');
      expect(chStore.addMessage).toHaveBeenCalledWith(params);
    });

    test('forwards projectId in params to the ClickHouse addMessage call', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(makeFakeMessage());

      const store = new DualWriteMessageStore(mongoStore, chFactory);
      const params: AddMessageParams = {
        sessionId: 'sess-acw',
        role: 'assistant',
        content: 'After-call summary',
        channel: 'voice',
        traceId: 'trace-acw',
        tenantId: 'tenant-1',
        projectId: 'proj-boardwalk',
        metadata: { tenantId: 'tenant-1' },
      };

      await store.addMessage(params);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const chCall = (chStore.addMessage as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as AddMessageParams;
      expect(chCall.projectId).toBe('proj-boardwalk');
    });

    test('ClickHouse failure does not fail overall addMessage', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      const expected = makeFakeMessage();
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(expected);
      (chStore.addMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('CH connection refused'),
      );

      const store = new DualWriteMessageStore(mongoStore, chFactory);
      const result = await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'hi',
        channel: 'web_chat',
        traceId: 'trace-1',
        metadata: { tenantId: 'tenant-1' },
      });

      // Mongo result is still returned
      expect(result).toBe(expected);

      // Wait for the fire-and-forget promise
      await new Promise((resolve) => setTimeout(resolve, 10));

      // ClickHouse was called but its failure is swallowed
      expect(chStore.addMessage).toHaveBeenCalled();
    });

    test('does not write to ClickHouse when tenantId is missing from metadata', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      const expected = makeFakeMessage();
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

      const store = new DualWriteMessageStore(mongoStore, chFactory);
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'hi',
        channel: 'web_chat',
        traceId: 'trace-1',
        // no metadata with tenantId
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(chFactory).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Read methods delegate to Mongo
  // ---------------------------------------------------------------------------

  describe('read delegation', () => {
    test('getMessages delegates to Mongo', async () => {
      const msgs = [makeFakeMessage()];
      (mongoStore.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue(msgs);

      const store = new DualWriteMessageStore(mongoStore);
      const result = await store.getMessages({ sessionId: 'sess-1' });
      expect(result).toBe(msgs);
    });

    test('getMessageCount delegates to Mongo', async () => {
      (mongoStore.getMessageCount as ReturnType<typeof vi.fn>).mockResolvedValue(42);

      const store = new DualWriteMessageStore(mongoStore);
      const result = await store.getMessageCount('sess-1');
      expect(result).toBe(42);
    });

    test('deleteBySession delegates to Mongo', async () => {
      (mongoStore.deleteBySession as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      const store = new DualWriteMessageStore(mongoStore);
      const result = await store.deleteBySession('sess-1');
      expect(result).toBe(5);
    });

    test('cleanup delegates to Mongo', async () => {
      (mongoStore.cleanup as ReturnType<typeof vi.fn>).mockResolvedValue(10);

      const store = new DualWriteMessageStore(mongoStore);
      const result = await store.cleanup(86400000);
      expect(result).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Scrub methods call both stores
  // ---------------------------------------------------------------------------

  describe('scrub methods', () => {
    test('scrubMessages calls both Mongo and ClickHouse', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      (mongoStore.scrubMessages as ReturnType<typeof vi.fn>).mockResolvedValue(3);

      const store = new DualWriteMessageStore(mongoStore, chFactory);
      const result = await store.scrubMessages('tenant-1', 'contact-1');

      expect(result).toBe(3);
      expect(mongoStore.scrubMessages).toHaveBeenCalledWith('tenant-1', 'contact-1');

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(chFactory).toHaveBeenCalledWith('tenant-1');
      expect(chStore.scrubByContact).toHaveBeenCalledWith('contact-1');
    });

    test('scrubMessagesBySession calls both Mongo and ClickHouse', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      (mongoStore.scrubMessagesBySession as ReturnType<typeof vi.fn>).mockResolvedValue(2);

      const store = new DualWriteMessageStore(mongoStore, chFactory);
      const result = await store.scrubMessagesBySession('tenant-1', 'sess-1');

      expect(result).toBe(2);
      expect(mongoStore.scrubMessagesBySession).toHaveBeenCalledWith('tenant-1', 'sess-1');

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(chFactory).toHaveBeenCalledWith('tenant-1');
      expect(chStore.deleteBySession).toHaveBeenCalledWith('sess-1');
    });
  });

  // ---------------------------------------------------------------------------
  // Per-tenant cache bounded at 100
  // ---------------------------------------------------------------------------

  describe('per-tenant ClickHouse cache', () => {
    test('caches ClickHouse stores per tenant', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(makeFakeMessage());

      const store = new DualWriteMessageStore(mongoStore, chFactory);

      // First call for tenant-1
      await store.addMessage({
        sessionId: 's1',
        role: 'user',
        content: 'a',
        channel: 'web_chat',
        traceId: '',
        metadata: { tenantId: 'tenant-1' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second call for same tenant
      await store.addMessage({
        sessionId: 's2',
        role: 'user',
        content: 'b',
        channel: 'web_chat',
        traceId: '',
        metadata: { tenantId: 'tenant-1' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Factory should only be called once for same tenant
      expect(chFactory).toHaveBeenCalledTimes(1);
    });

    test('evicts oldest entry when cache exceeds 100 tenants', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(makeFakeMessage());

      const store = new DualWriteMessageStore(mongoStore, chFactory);

      // Fill cache with 100 tenants
      for (let i = 0; i < 100; i++) {
        await store.addMessage({
          sessionId: `s-${i}`,
          role: 'user',
          content: 'x',
          channel: 'web_chat',
          traceId: '',
          metadata: { tenantId: `tenant-${i}` },
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      expect(store.clickHouseCacheSize).toBe(100);

      // Adding tenant-100 should evict tenant-0
      await store.addMessage({
        sessionId: 's-100',
        role: 'user',
        content: 'x',
        channel: 'web_chat',
        traceId: '',
        metadata: { tenantId: 'tenant-100' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.clickHouseCacheSize).toBe(100);
      // Factory was called 101 times (100 initial + 1 after eviction)
      expect(chFactory).toHaveBeenCalledTimes(101);
    });

    test('LRU: accessing existing tenant moves it to end, preventing eviction', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(makeFakeMessage());

      const store = new DualWriteMessageStore(mongoStore, chFactory);

      // Fill cache with 100 tenants (tenant-0 through tenant-99)
      for (let i = 0; i < 100; i++) {
        await store.addMessage({
          sessionId: `s-${i}`,
          role: 'user',
          content: 'x',
          channel: 'web_chat',
          traceId: '',
          metadata: { tenantId: `tenant-${i}` },
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      // Access tenant-0 to refresh it (moves to end of LRU)
      await store.addMessage({
        sessionId: 's-refresh',
        role: 'user',
        content: 'refresh',
        channel: 'web_chat',
        traceId: '',
        metadata: { tenantId: 'tenant-0' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // tenant-0 was already cached, so factory should NOT be called again for it
      const tenant0Calls = (chFactory as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: string[]) => c[0] === 'tenant-0',
      );
      expect(tenant0Calls).toHaveLength(1);

      // Now add tenant-100 — should evict tenant-1 (oldest non-refreshed), not tenant-0
      await store.addMessage({
        sessionId: 's-new',
        role: 'user',
        content: 'new',
        channel: 'web_chat',
        traceId: '',
        metadata: { tenantId: 'tenant-100' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.clickHouseCacheSize).toBe(100);
      // Factory called for tenant-100 (new entry)
      expect(chFactory).toHaveBeenCalledWith('tenant-100');
    });
  });

  // ---------------------------------------------------------------------------
  // mongoStore accessor
  // ---------------------------------------------------------------------------

  test('mongoStore accessor returns underlying MongoMessageStore', () => {
    const store = new DualWriteMessageStore(mongoStore);
    expect(store.mongoStore).toBe(mongoStore);
  });

  // ---------------------------------------------------------------------------
  // No chFactory provided
  // ---------------------------------------------------------------------------

  test('works with no chFactory (ClickHouse disabled)', async () => {
    process.env.USE_MONGO_CLICKHOUSE = 'true';
    const expected = makeFakeMessage();
    (mongoStore.addMessage as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

    const store = new DualWriteMessageStore(mongoStore); // no factory
    const result = await store.addMessage({
      sessionId: 'sess-1',
      role: 'user',
      content: 'hi',
      channel: 'web_chat',
      traceId: '',
      metadata: { tenantId: 'tenant-1' },
    });

    expect(result).toBe(expected);
    // No errors thrown
  });
});
