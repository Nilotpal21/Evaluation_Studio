import { describe, it, expect } from 'vitest';
import { mergeSessionMetadata, updateSessionMetadata } from '../../services/session-metadata.js';

describe('mergeSessionMetadata', () => {
  it('sets _metadata on empty session', () => {
    const result = mergeSessionMetadata(undefined, { token: 'abc' });
    expect(result).toEqual({ token: 'abc' });
  });

  it('preserves existing keys not in update', () => {
    const existing = { userProfile: { name: 'Alice' }, token: 'old' };
    const result = mergeSessionMetadata(existing, { token: 'new' });
    expect(result).toEqual({ userProfile: { name: 'Alice' }, token: 'new' });
  });

  it('replaces nested objects (no deep merge)', () => {
    const existing = { userProfile: { name: 'Alice', dept: 'Eng' } };
    const result = mergeSessionMetadata(existing, { userProfile: { name: 'Bob' } });
    expect(result).toEqual({ userProfile: { name: 'Bob' } });
    // dept is gone — replaced, not deep-merged
  });

  it('stores null values for key deletion', () => {
    const existing = { token: 'abc', profile: {} };
    const result = mergeSessionMetadata(existing, { token: null });
    expect(result).toEqual({ token: null, profile: {} });
  });

  it('adds new keys alongside existing ones', () => {
    const existing = { a: 1 };
    const result = mergeSessionMetadata(existing, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('returns incoming when existing is undefined', () => {
    const result = mergeSessionMetadata(undefined, { x: 1 });
    expect(result).toEqual({ x: 1 });
  });

  it('returns existing unchanged when incoming is undefined', () => {
    const existing = { x: 1 };
    const result = mergeSessionMetadata(existing, undefined);
    expect(result).toEqual({ x: 1 });
  });

  it('empty object is a no-op — does not create _metadata key', () => {
    const existing = { a: 1 };
    const result = mergeSessionMetadata(existing, {});
    expect(result).toEqual({ a: 1 });
  });

  it('returns undefined when both existing and incoming are undefined', () => {
    const result = mergeSessionMetadata(undefined, undefined);
    expect(result).toBeUndefined();
  });
});

describe('updateSessionMetadata', () => {
  it('updates the session data store in place', () => {
    const sessionData = { values: { _metadata: { token: 'old', locale: 'en' } } };

    const updated = updateSessionMetadata(sessionData, { token: 'new' });

    expect(updated).toBe(true);
    expect(sessionData.values._metadata).toEqual({ token: 'new', locale: 'en' });
  });

  it('returns false when incoming metadata is empty', () => {
    const sessionData = { values: { _metadata: { token: 'old' } } };

    const updated = updateSessionMetadata(sessionData, {});

    expect(updated).toBe(false);
    expect(sessionData.values._metadata).toEqual({ token: 'old' });
  });

  it('rejects an oversized incoming payload before merge', () => {
    const sessionData = { values: {} as Record<string, unknown> };

    expect(() => updateSessionMetadata(sessionData, { big: 'x'.repeat(70_000) })).toThrow(/65536/);
  });

  it('rejects when the merged payload exceeds the post-merge limit', () => {
    const sessionData = {
      values: {
        _metadata: { existing: 'x'.repeat(250_000) },
      } as Record<string, unknown>,
    };

    expect(() => updateSessionMetadata(sessionData, { token: 'y'.repeat(20_000) })).toThrow(
      /262144/,
    );
  });
});
