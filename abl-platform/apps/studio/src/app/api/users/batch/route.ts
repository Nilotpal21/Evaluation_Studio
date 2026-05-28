import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { findUserById } from '@/repos/auth-repo';

/**
 * GET /api/users/batch?ids=id1,id2,id3
 *
 * Returns { users: { [id]: { id, name, email } } } for the requested IDs.
 * Only same-tenant users can be resolved. Max 20 IDs per request.
 */
export async function GET(request: NextRequest) {
  const result = await requireTenantAuth(request);
  if (isAuthError(result)) return result;

  const ids = request.nextUrl.searchParams.get('ids');
  if (!ids) {
    return NextResponse.json({ users: {} });
  }

  const idList = Array.from(
    new Set(
      ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).slice(0, 20);

  if (idList.length === 0) {
    return NextResponse.json({ users: {} });
  }

  const { TenantMember } = await import('@agent-platform/database/models');
  const memberships = await TenantMember.find(
    {
      tenantId: result.tenantId,
      userId: { $in: idList },
    },
    { userId: 1 },
  ).lean();
  const visibleIds = new Set(
    memberships.map((member: { userId?: string }) => member.userId).filter(Boolean),
  );

  const users: Record<string, { id: string; name: string; email: string }> = {};
  await Promise.all(
    idList.map(async (id) => {
      if (!visibleIds.has(id)) {
        return;
      }
      const user = await findUserById(id);
      if (user) {
        users[id] = { id: user.id ?? id, name: user.name ?? '', email: user.email ?? '' };
      }
    }),
  );

  return NextResponse.json({ users });
}
