import { describe, expect, it } from 'vitest';

import { redactAuthProfile, redactAuthProfileList } from '../redact.js';

describe('redactAuthProfile', () => {
  const fullProfile = {
    _id: 'ap-1',
    tenantId: 'tenant-1',
    name: 'Google OAuth',
    authType: 'oauth2_app',
    status: 'active',
    encryptedSecrets: 'enc-aes256gcm-abc123',
    previousEncryptedSecrets: 'enc-aes256gcm-old456',
    encryptionKeyVersion: 3,
  };

  it('strips encryptedSecrets from profile', () => {
    const result = redactAuthProfile(fullProfile);
    expect(result).not.toHaveProperty('encryptedSecrets');
  });

  it('strips previousEncryptedSecrets from profile', () => {
    const result = redactAuthProfile(fullProfile);
    expect(result).not.toHaveProperty('previousEncryptedSecrets');
  });

  it('strips encryptionKeyVersion from profile', () => {
    const result = redactAuthProfile(fullProfile);
    expect(result).not.toHaveProperty('encryptionKeyVersion');
  });

  it('returns null for null input', () => {
    expect(redactAuthProfile(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(redactAuthProfile(undefined)).toBeNull();
  });

  it('does not mutate original object', () => {
    const original = { ...fullProfile };
    redactAuthProfile(original);
    expect(original.encryptedSecrets).toBe('enc-aes256gcm-abc123');
    expect(original.previousEncryptedSecrets).toBe('enc-aes256gcm-old456');
    expect(original.encryptionKeyVersion).toBe(3);
  });

  it('preserves all non-secret fields', () => {
    const result = redactAuthProfile(fullProfile)!;
    expect(result._id).toBe('ap-1');
    expect(result.tenantId).toBe('tenant-1');
    expect(result.name).toBe('Google OAuth');
    expect(result.authType).toBe('oauth2_app');
    expect(result.status).toBe('active');
  });
});

describe('redactAuthProfileList', () => {
  it('strips secrets from all items in array', () => {
    const profiles = [
      { _id: 'ap-1', encryptedSecrets: 'secret1', encryptionKeyVersion: 1 },
      { _id: 'ap-2', encryptedSecrets: 'secret2', encryptionKeyVersion: 2 },
    ];
    const result = redactAuthProfileList(profiles);
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty('encryptedSecrets');
    expect(result[1]).not.toHaveProperty('encryptedSecrets');
    expect(result[0]._id).toBe('ap-1');
    expect(result[1]._id).toBe('ap-2');
  });

  it('handles empty array', () => {
    expect(redactAuthProfileList([])).toEqual([]);
  });
});
