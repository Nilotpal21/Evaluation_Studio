/**
 * GET /api/invitations/pending — List pending invitations for the authenticated user
 *
 * Protected by requireAuth (not requireTenantAuth — user has no tenant yet).
 * Returns pending invitations for the user's email so the invitation picker
 * page can display them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findPendingInvitationsForEmail } from '@/repos/auth-repo';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('invitations');

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const invitations = await findPendingInvitationsForEmail(user.email);

    return NextResponse.json({
      invitations: invitations.map((inv) => ({
        id: inv.id,
        workspaceName: inv.workspaceName,
        role: inv.role,
        inviterName: inv.inviterName,
        expiresAt: inv.expiresAt,
      })),
    });
  } catch (error) {
    log.error('Error fetching pending invitations', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to fetch pending invitations' }, { status: 500 });
  }
}
