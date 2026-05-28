import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionDedup, InMemoryDedupStore } from '../../services/execution/execution-dedup.js';

describe('ExecutionDedup', () => {
  let dedup: ExecutionDedup;
  let store: InMemoryDedupStore;

  beforeEach(() => {
    store = new InMemoryDedupStore();
    dedup = new ExecutionDedup(store);
  });

  it('returns null for first occurrence of a message', async () => {
    const result = await dedup.check('sess-1', 'hello', undefined, undefined);
    expect(result).toBeNull();
  });

  it('returns existing executionId for duplicate within window', async () => {
    await dedup.record('sess-1', 'hello', undefined, undefined, 'exec-abc');

    const result = await dedup.check('sess-1', 'hello', undefined, undefined);
    expect(result).toBe('exec-abc');
  });

  it('treats different messages as unique', async () => {
    await dedup.record('sess-1', 'hello', undefined, undefined, 'exec-abc');

    const result = await dedup.check('sess-1', 'goodbye', undefined, undefined);
    expect(result).toBeNull();
  });

  it('treats different sessions as unique', async () => {
    await dedup.record('sess-1', 'hello', undefined, undefined, 'exec-abc');

    const result = await dedup.check('sess-2', 'hello', undefined, undefined);
    expect(result).toBeNull();
  });

  it('includes attachmentIds in hash', async () => {
    await dedup.record('sess-1', 'hello', ['att-1'], undefined, 'exec-abc');

    // Same message, no attachments — different
    const result1 = await dedup.check('sess-1', 'hello', undefined, undefined);
    expect(result1).toBeNull();

    // Same message, same attachments — duplicate
    const result2 = await dedup.check('sess-1', 'hello', ['att-1'], undefined);
    expect(result2).toBe('exec-abc');
  });

  it('includes per-message metadata in the hash', async () => {
    await dedup.record(
      'sess-1',
      'hello',
      undefined,
      { locale: 'en-US', context: { plan: 'pro' } },
      'exec-abc',
    );

    expect(await dedup.check('sess-1', 'hello', undefined, undefined)).toBeNull();
    expect(
      await dedup.check('sess-1', 'hello', undefined, {
        context: { plan: 'pro' },
        locale: 'en-US',
      }),
    ).toBe('exec-abc');
  });

  it('includes explicit interaction context in the hash', async () => {
    await dedup.record('sess-1', 'hello', undefined, undefined, 'exec-abc', {
      language: 'es',
      timezone: 'Europe/Madrid',
    });

    expect(await dedup.check('sess-1', 'hello', undefined, undefined)).toBeNull();
    expect(
      await dedup.check('sess-1', 'hello', undefined, undefined, {
        language: 'es',
        timezone: 'Europe/Madrid',
      }),
    ).toBe('exec-abc');
  });

  it('includes explicit dedup keys in the hash', async () => {
    await dedup.record('sess-1', 'hello', undefined, undefined, 'exec-abc', undefined, 'msg-1');

    expect(await dedup.check('sess-1', 'hello', undefined, undefined)).toBeNull();
    expect(
      await dedup.check('sess-1', 'hello', undefined, undefined, undefined, 'msg-2'),
    ).toBeNull();
    expect(await dedup.check('sess-1', 'hello', undefined, undefined, undefined, 'msg-1')).toBe(
      'exec-abc',
    );
  });

  it('expires entries after TTL', async () => {
    // Use a very short TTL for testing
    dedup = new ExecutionDedup(store, 50); // 50ms

    await dedup.record('sess-1', 'hello', undefined, undefined, 'exec-abc');
    expect(await dedup.check('sess-1', 'hello', undefined, undefined)).toBe('exec-abc');

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 60));

    expect(await dedup.check('sess-1', 'hello', undefined, undefined)).toBeNull();
  });

  it('checkAndRecord returns null for new message and records it', async () => {
    const result = await dedup.checkAndRecord('sess-1', 'hello', undefined, undefined, 'exec-new');
    expect(result).toBeNull();

    // Verify it was recorded by checking
    const check = await dedup.check('sess-1', 'hello', undefined, undefined);
    expect(check).toBe('exec-new');
  });

  it('checkAndRecord returns existing executionId for duplicate', async () => {
    // First call records
    const first = await dedup.checkAndRecord('sess-1', 'hello', undefined, undefined, 'exec-first');
    expect(first).toBeNull();

    // Second call with same message returns the existing executionId
    const second = await dedup.checkAndRecord(
      'sess-1',
      'hello',
      undefined,
      undefined,
      'exec-second',
    );
    expect(second).toBe('exec-first');

    // Original value is preserved (not overwritten)
    const check = await dedup.check('sess-1', 'hello', undefined, undefined);
    expect(check).toBe('exec-first');
  });
});
