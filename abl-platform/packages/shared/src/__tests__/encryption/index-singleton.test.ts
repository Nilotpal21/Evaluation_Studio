// packages/shared/src/__tests__/encryption/index-singleton.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const VALID_KEY = crypto.randomBytes(32).toString('hex');

describe('index.ts — singleton, generateMasterKey, _resetEncryptionServiceForTesting', () => {
  let origKey: string | undefined;

  beforeEach(() => {
    origKey = process.env.ENCRYPTION_MASTER_KEY;
  });

  afterEach(async () => {
    if (origKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = origKey;

    // Always reset the singleton after each test
    const mod = await import('../../encryption/index.js');
    mod._resetEncryptionServiceForTesting();
  });

  it('getEncryptionService() returns a singleton', async () => {
    process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
    const mod = await import('../../encryption/index.js');
    mod._resetEncryptionServiceForTesting();

    const svc1 = mod.getEncryptionService();
    const svc2 = mod.getEncryptionService();
    expect(svc1).toBe(svc2);
  });

  it('getEncryptionService() throws when ENCRYPTION_MASTER_KEY is missing', async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    const mod = await import('../../encryption/index.js');
    mod._resetEncryptionServiceForTesting();

    expect(() => mod.getEncryptionService()).toThrow('ENCRYPTION_MASTER_KEY');
  });

  it('_resetEncryptionServiceForTesting() resets the singleton', async () => {
    process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
    const mod = await import('../../encryption/index.js');
    mod._resetEncryptionServiceForTesting();

    const svc1 = mod.getEncryptionService();
    mod._resetEncryptionServiceForTesting();
    const svc2 = mod.getEncryptionService();
    // After reset, a new instance is created
    expect(svc1).not.toBe(svc2);
  });

  it('generateMasterKey() returns a 64-char hex string', async () => {
    const mod = await import('../../encryption/index.js');
    const key = mod.generateMasterKey();
    expect(key).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  it('generateMasterKey() returns different keys each time', async () => {
    const mod = await import('../../encryption/index.js');
    const k1 = mod.generateMasterKey();
    const k2 = mod.generateMasterKey();
    expect(k1).not.toBe(k2);
  });
});
