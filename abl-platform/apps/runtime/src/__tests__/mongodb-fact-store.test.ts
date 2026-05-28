import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';

describe('MongoDBFactStore', () => {
  let store: InMemoryFactStore;

  beforeEach(() => {
    store = new InMemoryFactStore({ type: 'memory' });
  });

  afterEach(() => {
    store.stop();
  });

  test('set() stores fact and get() retrieves it', async () => {
    const fact = await store.set({ key: 'user.prefs.color', value: 'blue' });

    expect(fact).toBeDefined();
    expect(fact.key).toBe('user.prefs.color');
    expect(fact.value).toBe('blue');
    expect(fact.id).toBeDefined();

    const retrieved = await store.get({ key: 'user.prefs.color' });
    expect(retrieved).not.toBeNull();
    expect(retrieved!.value).toBe('blue');
    expect(retrieved!.key).toBe('user.prefs.color');
  });

  test('get() returns null for non-existent key', async () => {
    const result = await store.get({ key: 'nonexistent.key' });
    expect(result).toBeNull();
  });

  test('query() with prefix returns matching facts', async () => {
    await store.set({ key: 'preferences.hotel.view', value: 'ocean' });
    await store.set({ key: 'preferences.hotel.room', value: 'suite' });
    await store.set({ key: 'preferences.flight.class', value: 'business' });
    await store.set({ key: 'other.key', value: 'unrelated' });

    const hotelPrefs = await store.query({ prefix: 'preferences.hotel' });

    expect(hotelPrefs).toHaveLength(2);
    const keys = hotelPrefs.map((f) => f.key);
    expect(keys).toContain('preferences.hotel.view');
    expect(keys).toContain('preferences.hotel.room');
  });

  test('delete() removes fact', async () => {
    await store.set({ key: 'to.delete', value: 'temp' });

    const beforeDelete = await store.get({ key: 'to.delete' });
    expect(beforeDelete).not.toBeNull();

    const deleted = await store.delete('to.delete');
    expect(deleted).toBe(true);

    const afterDelete = await store.get({ key: 'to.delete' });
    expect(afterDelete).toBeNull();
  });

  test('delete() returns false for non-existent key', async () => {
    const deleted = await store.delete('does.not.exist');
    expect(deleted).toBe(false);
  });

  test('set() with same key upserts (overwrites)', async () => {
    const first = await store.set({ key: 'user.name', value: 'Alice' });
    expect(first.value).toBe('Alice');
    const firstId = first.id;

    const second = await store.set({ key: 'user.name', value: 'Bob' });
    expect(second.value).toBe('Bob');
    // InMemoryFactStore preserves the ID on upsert
    expect(second.id).toBe(firstId);

    // Only one fact should exist for this key
    const retrieved = await store.get({ key: 'user.name' });
    expect(retrieved).not.toBeNull();
    expect(retrieved!.value).toBe('Bob');
  });

  test('Expired facts are cleaned up', async () => {
    // Set a fact with a very short TTL (1ms)
    await store.set({ key: 'ephemeral', value: 'temp', ttlMs: 1 });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // get() should return null for expired facts
    const result = await store.get({ key: 'ephemeral' });
    expect(result).toBeNull();

    // query() should also exclude expired facts
    const queryResult = await store.query({ prefix: 'ephemeral' });
    expect(queryResult).toHaveLength(0);
  });
});
