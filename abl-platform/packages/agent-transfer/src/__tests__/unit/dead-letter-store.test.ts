import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeadLetterStore,
  type DeadLetterEntry,
  type DeadLetterStoreHandle,
} from '../../events/dead-letter-store.js';

function makeEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: 'dl-1',
    queue: 'agent-desktop-events',
    jobId: 'job-42',
    eventType: 'agent_message',
    payload: { text: 'hello' },
    error: 'Timeout',
    failedAt: new Date('2026-03-01T00:00:00Z'),
    tenantId: 'tenant-1',
    retryCount: 3,
    resolved: false,
    ...overrides,
  };
}

function makeMockStore(): DeadLetterStoreHandle {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    find: vi.fn().mockResolvedValue([]),
    updateOne: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue(0),
  };
}

describe('DeadLetterStore', () => {
  let mockStore: DeadLetterStoreHandle;
  let deadLetterStore: DeadLetterStore;

  beforeEach(() => {
    mockStore = makeMockStore();
    deadLetterStore = new DeadLetterStore(mockStore);
  });

  it('saves entry via store handle', async () => {
    const entry = makeEntry();
    await deadLetterStore.save(entry);
    expect(mockStore.insert).toHaveBeenCalledWith(entry);
  });

  it('findByTenant queries with tenantId and resolved:false', async () => {
    const entries = [makeEntry(), makeEntry({ id: 'dl-2' })];
    vi.mocked(mockStore.find).mockResolvedValue(entries);

    const result = await deadLetterStore.findByTenant('tenant-1', 10);

    expect(mockStore.find).toHaveBeenCalledWith({ tenantId: 'tenant-1', resolved: false }, 10);
    expect(result).toHaveLength(2);
  });

  it('findByTenant uses default limit of 50', async () => {
    await deadLetterStore.findByTenant('tenant-1');
    expect(mockStore.find).toHaveBeenCalledWith({ tenantId: 'tenant-1', resolved: false }, 50);
  });

  it('markResolved updates the entry', async () => {
    await deadLetterStore.markResolved('dl-1');
    expect(mockStore.updateOne).toHaveBeenCalledWith({ id: 'dl-1' }, { resolved: true });
  });

  it('deleteOlderThan removes old entries and returns count', async () => {
    vi.mocked(mockStore.deleteMany).mockResolvedValue(5);
    const cutoff = new Date('2026-01-01');
    const count = await deadLetterStore.deleteOlderThan(cutoff);
    expect(mockStore.deleteMany).toHaveBeenCalledWith({ failedAt: { $lt: cutoff } });
    expect(count).toBe(5);
  });

  it('deleteOlderThan returns 0 when nothing deleted', async () => {
    vi.mocked(mockStore.deleteMany).mockResolvedValue(0);
    const count = await deadLetterStore.deleteOlderThan(new Date());
    expect(count).toBe(0);
  });
});
