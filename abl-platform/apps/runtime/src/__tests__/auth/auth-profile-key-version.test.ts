import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentAuthProfileKeyVersion } from '../../services/auth-profile/auth-profile-key-version.js';

const ORIGINAL_CURRENT = process.env.ENCRYPTION_CURRENT_MASTER_KEY_VERSION;
const ORIGINAL_PREVIOUS = process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS;

describe('getCurrentAuthProfileKeyVersion', () => {
  afterEach(() => {
    if (ORIGINAL_CURRENT === undefined) {
      delete process.env.ENCRYPTION_CURRENT_MASTER_KEY_VERSION;
    } else {
      process.env.ENCRYPTION_CURRENT_MASTER_KEY_VERSION = ORIGINAL_CURRENT;
    }

    if (ORIGINAL_PREVIOUS === undefined) {
      delete process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS;
    } else {
      process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS = ORIGINAL_PREVIOUS;
    }
  });

  it('prefers ENCRYPTION_CURRENT_MASTER_KEY_VERSION when present', () => {
    process.env.ENCRYPTION_CURRENT_MASTER_KEY_VERSION = '7';
    process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS = 'tenant:5,tenant:6';

    expect(getCurrentAuthProfileKeyVersion()).toBe(7);
  });

  it('derives the current version from previous master keys when explicit current is absent', () => {
    delete process.env.ENCRYPTION_CURRENT_MASTER_KEY_VERSION;
    process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS = 'tenant-a:2,tenant-b:5';

    expect(getCurrentAuthProfileKeyVersion()).toBe(6);
  });

  it('falls back to version 1 when no key metadata is configured', () => {
    delete process.env.ENCRYPTION_CURRENT_MASTER_KEY_VERSION;
    delete process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS;

    expect(getCurrentAuthProfileKeyVersion()).toBe(1);
  });
});
