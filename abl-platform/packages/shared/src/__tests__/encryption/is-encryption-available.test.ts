import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const VALID_KEY = crypto.randomBytes(32).toString('hex'); // 64 hex chars

describe('isEncryptionAvailable', () => {
  let origEnabled: string | undefined;
  let origMasterKey: string | undefined;

  beforeEach(() => {
    origEnabled = process.env.ENCRYPTION_ENABLED;
    origMasterKey = process.env.ENCRYPTION_MASTER_KEY;
  });

  afterEach(() => {
    if (origEnabled === undefined) delete process.env.ENCRYPTION_ENABLED;
    else process.env.ENCRYPTION_ENABLED = origEnabled;

    if (origMasterKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = origMasterKey;
  });

  // Fresh import each test to avoid module-level caching issues
  async function getIsEncryptionAvailable() {
    const mod = await import('../../encryption/index.js');
    return mod.isEncryptionAvailable;
  }

  it('returns false when both ENCRYPTION_ENABLED and ENCRYPTION_MASTER_KEY are unset', async () => {
    delete process.env.ENCRYPTION_ENABLED;
    delete process.env.ENCRYPTION_MASTER_KEY;
    const isEncryptionAvailable = await getIsEncryptionAvailable();
    expect(isEncryptionAvailable()).toBe(false);
  });

  it('returns true when ENCRYPTION_ENABLED is unset and ENCRYPTION_MASTER_KEY is valid (backward compat)', async () => {
    delete process.env.ENCRYPTION_ENABLED;
    process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
    const isEncryptionAvailable = await getIsEncryptionAvailable();
    expect(isEncryptionAvailable()).toBe(true);
  });

  it('returns true when ENCRYPTION_ENABLED=true and ENCRYPTION_MASTER_KEY is valid', async () => {
    process.env.ENCRYPTION_ENABLED = 'true';
    process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
    const isEncryptionAvailable = await getIsEncryptionAvailable();
    expect(isEncryptionAvailable()).toBe(true);
  });

  it('returns false when ENCRYPTION_ENABLED=true but ENCRYPTION_MASTER_KEY is unset', async () => {
    process.env.ENCRYPTION_ENABLED = 'true';
    delete process.env.ENCRYPTION_MASTER_KEY;
    const isEncryptionAvailable = await getIsEncryptionAvailable();
    expect(isEncryptionAvailable()).toBe(false);
  });

  it('returns false when ENCRYPTION_ENABLED=false and ENCRYPTION_MASTER_KEY is valid (kill-switch)', async () => {
    process.env.ENCRYPTION_ENABLED = 'false';
    process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
    const isEncryptionAvailable = await getIsEncryptionAvailable();
    expect(isEncryptionAvailable()).toBe(false);
  });

  it('returns false when ENCRYPTION_ENABLED=false and ENCRYPTION_MASTER_KEY is unset', async () => {
    process.env.ENCRYPTION_ENABLED = 'false';
    delete process.env.ENCRYPTION_MASTER_KEY;
    const isEncryptionAvailable = await getIsEncryptionAvailable();
    expect(isEncryptionAvailable()).toBe(false);
  });
});
