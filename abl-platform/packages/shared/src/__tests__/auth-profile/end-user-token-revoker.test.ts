/**
 * Boundary test for ABLP-1123: the helper that stamps `revokedAt` on every
 * active per-user OAuth grant for an auth profile. Verifies (a) the filter
 * is tenant-scoped + provider-keyed + only-active, (b) `revokedAt` is set
 * to a Date, (c) modifiedCount is propagated.
 */

import { describe, expect, it, vi } from 'vitest';
import { revokeEndUserTokensForProfile } from '../../services/auth-profile/end-user-token-revoker.js';

describe('revokeEndUserTokensForProfile', () => {
  it('updates only active grants for the given tenant + profile', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 3 });
    const tokenModel = { updateMany };

    const result = await revokeEndUserTokensForProfile(
      { tenantId: 'tenant-1', profileId: 'profile-abc' },
      { tokenModel },
    );

    expect(updateMany).toHaveBeenCalledOnce();
    const [filter, update] = updateMany.mock.calls[0]!;

    expect(filter).toMatchObject({
      tenantId: 'tenant-1',
      provider: 'auth-profile:profile-abc',
      revokedAt: null,
    });
    expect(update).toEqual({ $set: { revokedAt: expect.any(Date) } });

    expect(result).toEqual({ modifiedCount: 3 });
  });

  it('returns modifiedCount 0 when updateMany reports no matches', async () => {
    const tokenModel = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    };
    const result = await revokeEndUserTokensForProfile(
      { tenantId: 't', profileId: 'p' },
      { tokenModel },
    );
    expect(result.modifiedCount).toBe(0);
  });

  it('defaults modifiedCount to 0 when driver omits the field', async () => {
    const tokenModel = {
      updateMany: vi.fn().mockResolvedValue({} as { modifiedCount: number }),
    };
    const result = await revokeEndUserTokensForProfile(
      { tenantId: 't', profileId: 'p' },
      { tokenModel },
    );
    expect(result.modifiedCount).toBe(0);
  });
});
