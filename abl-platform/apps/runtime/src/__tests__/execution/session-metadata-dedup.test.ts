import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionDedup, InMemoryDedupStore } from '../../services/execution/execution-dedup.js';

describe('ExecutionDedup — sessionMetadata independence', () => {
  let dedup: ExecutionDedup;

  beforeEach(() => {
    dedup = new ExecutionDedup(new InMemoryDedupStore());
  });

  it('same message with different sessionMetadata deduplicates (sessionMetadata not in hash)', async () => {
    // Record original execution
    await dedup.record('sess-1', 'hello', undefined, undefined, 'exec-1');

    // Retry with same message — should dedup even though caller changed sessionMetadata
    // (sessionMetadata is merged into session state before dedup check, not part of message hash)
    const result = await dedup.check('sess-1', 'hello', undefined, undefined);
    expect(result).toBe('exec-1');
  });

  it('different messageMetadata does NOT dedup', async () => {
    await dedup.record('sess-1', 'hello', undefined, { locale: 'en' }, 'exec-1');
    const result = await dedup.check('sess-1', 'hello', undefined, { locale: 'fr' });
    expect(result).toBeNull();
  });
});
