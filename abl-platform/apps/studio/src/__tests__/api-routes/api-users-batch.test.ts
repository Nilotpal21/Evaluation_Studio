import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireTenantAuth, mockIsAuthError, mockFindUserById, mockTenantMemberFind } =
  vi.hoisted(() => ({
    mockRequireTenantAuth: vi.fn(),
    mockIsAuthError: vi.fn(),
    mockFindUserById: vi.fn(),
    mockTenantMemberFind: vi.fn(),
  }));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: (...args: unknown[]) => mockFindUserById(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantMember: {
    find: (...args: unknown[]) => mockTenantMemberFind(...args),
  },
}));

import { GET } from '@/app/api/users/batch/route';

function makeRequest(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'));
}

describe('GET /api/users/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      email: 'user-1@example.com',
      name: 'User One',
      tenantId: 'tenant-1',
      permissions: [],
    });
    mockIsAuthError.mockReturnValue(false);
    mockTenantMemberFind.mockReturnValue({
      lean: vi.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u3' }]),
    });
    mockFindUserById.mockImplementation(async (id: string) => ({
      id,
      name: `User ${id}`,
      email: `${id}@example.com`,
    }));
  });

  test('returns only users visible within the caller tenant', async () => {
    const response = await GET(makeRequest('/api/users/batch?ids=u1,u2,u1,u3'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockTenantMemberFind).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        userId: { $in: ['u1', 'u2', 'u3'] },
      },
      { userId: 1 },
    );
    expect(mockFindUserById).toHaveBeenCalledTimes(2);
    expect(mockFindUserById).toHaveBeenCalledWith('u1');
    expect(mockFindUserById).toHaveBeenCalledWith('u3');
    expect(body).toEqual({
      users: {
        u1: { id: 'u1', name: 'User u1', email: 'u1@example.com' },
        u3: { id: 'u3', name: 'User u3', email: 'u3@example.com' },
      },
    });
  });

  test('returns an empty payload when no ids are provided', async () => {
    const response = await GET(makeRequest('/api/users/batch'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ users: {} });
    expect(mockTenantMemberFind).not.toHaveBeenCalled();
    expect(mockFindUserById).not.toHaveBeenCalled();
  });
});
