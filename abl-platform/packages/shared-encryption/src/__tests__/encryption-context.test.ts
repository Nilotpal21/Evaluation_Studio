/**
 * Encryption Context Tests
 *
 * Tests AsyncLocalStorage-based environment propagation (Decision 12).
 */

import { describe, it, expect } from 'vitest';
import {
  encryptionContext,
  getEncryptionEnvironment,
  runWithEncryptionContext,
} from '../encryption-context.js';

describe('EncryptionContext (AsyncLocalStorage)', () => {
  it('getEncryptionEnvironment returns null when no context is active', () => {
    expect(getEncryptionEnvironment()).toBeNull();
  });

  it('runWithEncryptionContext sets and reads environment', () => {
    const result = runWithEncryptionContext({ environment: 'production' }, () => {
      return getEncryptionEnvironment();
    });
    expect(result).toBe('production');
  });

  it('environment is null outside runWithEncryptionContext', () => {
    runWithEncryptionContext({ environment: 'staging' }, () => {
      expect(getEncryptionEnvironment()).toBe('staging');
    });
    // Outside the run, should be null again
    expect(getEncryptionEnvironment()).toBeNull();
  });

  it('nested contexts override correctly', () => {
    runWithEncryptionContext({ environment: null }, () => {
      expect(getEncryptionEnvironment()).toBeNull();

      runWithEncryptionContext({ environment: 'dev' }, () => {
        expect(getEncryptionEnvironment()).toBe('dev');
      });

      // After inner context ends, outer context restored
      expect(getEncryptionEnvironment()).toBeNull();
    });
  });

  it('supports async operations within context', async () => {
    const result = await runWithEncryptionContext({ environment: 'async-env' }, async () => {
      // Simulate async operation
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getEncryptionEnvironment();
    });
    expect(result).toBe('async-env');
  });

  it('encryptionContext.getStore() returns the full context object', () => {
    runWithEncryptionContext({ environment: 'test' }, () => {
      const store = encryptionContext.getStore();
      expect(store).toEqual({ environment: 'test' });
    });
  });
});
