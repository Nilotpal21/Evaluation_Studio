import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockRefreshTokenCreate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  RefreshToken: {
    create: (...args: unknown[]) => mockRefreshTokenCreate(...args),
  },
}));

import { createStoredRefreshToken } from '../utils/jwt-utils.js';

describe('jwt-utils refresh token lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('stores root lineage fields for runtime-minted refresh tokens', async () => {
    mockRefreshTokenCreate.mockResolvedValue({});

    const raw = await createStoredRefreshToken('user-1');

    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    expect(mockRefreshTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        token: expect.stringMatching(/^[a-f0-9]{64}$/),
        userId: 'user-1',
        familyId: expect.any(String),
        generation: 1,
        expiresAt: expect.any(Date),
      }),
    );
  });
});
