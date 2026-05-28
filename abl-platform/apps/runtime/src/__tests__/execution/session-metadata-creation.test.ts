import { describe, it, expect } from 'vitest';
import { initializeSessionMetadata } from '../../services/session-metadata.js';

describe('createSessionFromResolved — metadata option', () => {
  it('stores metadata as session.data.values._metadata', () => {
    const sessionData = { values: {} as Record<string, unknown> };
    initializeSessionMetadata(sessionData, {
      sessionToken: 'jwt-1',
      userProfile: { name: 'Alice' },
    });
    expect(sessionData.values._metadata).toEqual({
      sessionToken: 'jwt-1',
      userProfile: { name: 'Alice' },
    });
  });

  it('does not create _metadata key when metadata is undefined', () => {
    const sessionData = { values: {} as Record<string, unknown> };
    initializeSessionMetadata(sessionData, undefined);
    expect(sessionData.values).not.toHaveProperty('_metadata');
  });

  it('does not create _metadata key when metadata is empty object', () => {
    const sessionData = { values: {} as Record<string, unknown> };
    initializeSessionMetadata(sessionData, {});
    expect(sessionData.values).not.toHaveProperty('_metadata');
  });

  it('preserves existing session.data.values keys', () => {
    const sessionData = { values: { customer_name: 'Bob' } as Record<string, unknown> };
    initializeSessionMetadata(sessionData, { token: 'abc' });
    expect(sessionData.values.customer_name).toBe('Bob');
    expect(sessionData.values._metadata).toEqual({ token: 'abc' });
  });
});
