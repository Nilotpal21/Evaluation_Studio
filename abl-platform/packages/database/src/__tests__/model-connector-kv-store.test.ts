import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { ConnectorKVStore } from '../models/connector-kv-store.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validEntry = () => ({
  tenantId: 'tenant-1',
  connectionId: 'conn-1',
  key: 'last_cursor',
  value: 'cursor-abc-123',
});

describe('ConnectorKVStore', () => {
  it('sets default fields on instantiation', () => {
    const entry = new ConnectorKVStore(validEntry());
    expect(entry._id).toBeDefined();
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.connectionId).toBe('conn-1');
    expect(entry.key).toBe('last_cursor');
    expect(entry.value).toBe('cursor-abc-123');
  });

  it('requires tenantId', () => {
    const data = validEntry();
    delete (data as any).tenantId;
    const err = new ConnectorKVStore(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires connectionId', () => {
    const data = validEntry();
    delete (data as any).connectionId;
    const err = new ConnectorKVStore(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.connectionId).toBeDefined();
  });

  it('requires key', () => {
    const data = validEntry();
    delete (data as any).key;
    const err = new ConnectorKVStore(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.key).toBeDefined();
  });

  it('requires value', () => {
    const data = validEntry();
    delete (data as any).value;
    const err = new ConnectorKVStore(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.value).toBeDefined();
  });

  it('stores complex values (objects)', () => {
    const entry = new ConnectorKVStore({
      ...validEntry(),
      value: { cursor: 'abc', page: 5, metadata: { total: 100 } },
    });
    expect(entry.value).toEqual({ cursor: 'abc', page: 5, metadata: { total: 100 } });
  });

  it('stores array values', () => {
    const entry = new ConnectorKVStore({
      ...validEntry(),
      value: ['item1', 'item2', 'item3'],
    });
    expect(entry.value).toEqual(['item1', 'item2', 'item3']);
  });

  it('stores expiresAt for TTL', () => {
    const expires = new Date('2026-04-01');
    const entry = new ConnectorKVStore({
      ...validEntry(),
      expiresAt: expires,
    });
    expect(entry.expiresAt).toEqual(expires);
  });

  it('enforces unique tenantId+connectionId+key', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorKVStore.create(validEntry());
    await expect(ConnectorKVStore.create(validEntry())).rejects.toThrow(/duplicate key/i);
  });

  it('allows same key for different connections', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorKVStore.create(validEntry());
    const doc = await ConnectorKVStore.create({
      ...validEntry(),
      connectionId: 'conn-2',
    });
    expect(doc.connectionId).toBe('conn-2');
  });

  it('allows same key for different tenants', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorKVStore.create(validEntry());
    const doc = await ConnectorKVStore.create({
      ...validEntry(),
      tenantId: 'tenant-2',
    });
    expect(doc.tenantId).toBe('tenant-2');
  });

  it('upserts by unique key', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorKVStore.create(validEntry());
    const updated = await ConnectorKVStore.findOneAndUpdate(
      { tenantId: 'tenant-1', connectionId: 'conn-1', key: 'last_cursor' },
      { value: 'cursor-xyz-999' },
      { new: true },
    );
    expect(updated!.value).toBe('cursor-xyz-999');
    const count = await ConnectorKVStore.countDocuments({ tenantId: 'tenant-1' });
    expect(count).toBe(1);
  });
});
