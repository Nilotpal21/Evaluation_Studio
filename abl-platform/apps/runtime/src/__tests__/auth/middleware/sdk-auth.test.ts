/**
 * SDK public-key bootstrap resolver tests.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(),
}));

vi.mock('../../../repos/channel-repo.js', () => ({
  findPublicApiKeyForSdk: vi.fn(),
  updatePublicApiKeyLastUsed: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { resolveSdkInitFromPublicKey } from '../../../middleware/sdk-auth.js';
import { isDatabaseAvailable } from '../../../db/index.js';
import { findPublicApiKeyForSdk, updatePublicApiKeyLastUsed } from '../../../repos/channel-repo.js';

function createValidKeyRecord(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'key_1',
    projectId: 'proj_1',
    allowedOrigins: null,
    permissions: { chat: true, voice: false },
    project: { tenantId: 'tenant_1' },
    ...overrides,
  };
}

describe('resolveSdkInitFromPublicKey', () => {
  beforeEach(() => {
    vi.mocked(isDatabaseAvailable).mockReset();
    vi.mocked(findPublicApiKeyForSdk).mockReset();
    vi.mocked(updatePublicApiKeyLastUsed).mockReset();
  });

  test('returns 401 when X-Public-Key header is missing', async () => {
    const result = await resolveSdkInitFromPublicKey({});
    expect(result).toEqual({
      success: false,
      status: 401,
      body: { error: 'Missing X-Public-Key header' },
    });
  });

  test('returns 401 when the key format is invalid', async () => {
    const result = await resolveSdkInitFromPublicKey({ 'x-public-key': 'sk_invalid' });
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('expected failure');
    }
    expect(result.status).toBe(401);
    expect(result.body.error).toContain('pk_');
  });

  test('returns 503 when the database is unavailable', async () => {
    vi.mocked(isDatabaseAvailable).mockReturnValue(false);
    const result = await resolveSdkInitFromPublicKey({ 'x-public-key': 'pk_test_key_123' });
    expect(result).toEqual({
      success: false,
      status: 503,
      body: { error: 'Database unavailable for key validation' },
    });
  });

  test('hashes the raw public key before lookup', async () => {
    vi.mocked(isDatabaseAvailable).mockReturnValue(true);
    vi.mocked(findPublicApiKeyForSdk).mockResolvedValue(null);

    await resolveSdkInitFromPublicKey({ 'x-public-key': 'pk_test123' });

    expect(findPublicApiKeyForSdk).toHaveBeenCalledTimes(1);
    const hashArg = vi.mocked(findPublicApiKeyForSdk).mock.calls[0][0];
    expect(hashArg).not.toBe('pk_test123');
    expect(hashArg).toMatch(/^[a-f0-9]{64}$/);
  });

  test('returns 401 when the key is not found', async () => {
    vi.mocked(isDatabaseAvailable).mockReturnValue(true);
    vi.mocked(findPublicApiKeyForSdk).mockResolvedValue(null);

    const result = await resolveSdkInitFromPublicKey({ 'x-public-key': 'pk_missing' });
    expect(result).toEqual({
      success: false,
      status: 401,
      body: { error: 'Invalid or expired public API key' },
    });
  });

  test('rejects origins that are not in the allowlist', async () => {
    vi.mocked(isDatabaseAvailable).mockReturnValue(true);
    vi.mocked(findPublicApiKeyForSdk).mockResolvedValue(
      createValidKeyRecord({ allowedOrigins: JSON.stringify(['https://app.example.com']) }),
    );

    const result = await resolveSdkInitFromPublicKey({
      'x-public-key': 'pk_valid',
      origin: 'https://evil.example.com',
    });
    expect(result).toEqual({
      success: false,
      status: 403,
      body: { error: 'Origin not allowed' },
    });
  });

  test('accepts wildcard origin allowlists', async () => {
    vi.mocked(isDatabaseAvailable).mockReturnValue(true);
    vi.mocked(findPublicApiKeyForSdk).mockResolvedValue(
      createValidKeyRecord({
        allowedOrigins: JSON.stringify(['https://*.example.com']),
        permissions: { chat: true, voice: true },
      }),
    );
    vi.mocked(updatePublicApiKeyLastUsed).mockResolvedValue(undefined);

    const result = await resolveSdkInitFromPublicKey({
      'x-public-key': 'pk_valid',
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({
      success: true,
      data: {
        keyId: 'key_1',
        projectId: 'proj_1',
        tenantId: 'tenant_1',
        permissions: [
          'session:send_message',
          'session:read',
          'attachment:read',
          'attachment:write',
          'attachment:delete',
          'session:voice',
        ],
      },
    });
    expect(updatePublicApiKeyLastUsed).toHaveBeenCalledWith('key_1');
  });

  test('returns 500 when the project tenant scope is missing', async () => {
    vi.mocked(isDatabaseAvailable).mockReturnValue(true);
    vi.mocked(findPublicApiKeyForSdk).mockResolvedValue(
      createValidKeyRecord({ project: { tenantId: null } }),
    );

    const result = await resolveSdkInitFromPublicKey({ 'x-public-key': 'pk_valid' });
    expect(result).toEqual({
      success: false,
      status: 500,
      body: { error: 'Project has no associated tenant' },
    });
  });

  test('returns 500 on unexpected lookup errors', async () => {
    vi.mocked(isDatabaseAvailable).mockReturnValue(true);
    vi.mocked(findPublicApiKeyForSdk).mockRejectedValue(new Error('DB exploded'));

    const result = await resolveSdkInitFromPublicKey({ 'x-public-key': 'pk_valid' });
    expect(result).toEqual({
      success: false,
      status: 500,
      body: { error: 'Internal server error' },
    });
  });
});
