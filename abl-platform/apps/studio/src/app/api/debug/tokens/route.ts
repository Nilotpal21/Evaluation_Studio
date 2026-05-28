/**
 * GET    /api/debug/tokens - List active debug tokens
 * DELETE /api/debug/tokens - Revoke all debug tokens
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findDebugTokens, revokeDebugTokens } from '@/repos/sdk-repo';

function parseStoredStringArray(value: string[]): string[] {
  if (value.length === 1) {
    const [serialized] = value;
    try {
      const parsed = JSON.parse(serialized);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      // Fall through to the stored array shape.
    }
  }

  return value;
}

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    // Use repo function
    const tokens = await findDebugTokens({
      userId: user.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    });

    return NextResponse.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        scopes: parseStoredStringArray(t.scopes),
        sessionIds: parseStoredStringArray(t.sessionIds),
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
      })),
    });
  } catch (error) {
    console.error('[Debug] List tokens error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    // Use repo function
    await revokeDebugTokens({ userId: user.id, revokedAt: null });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Debug] Revoke all tokens error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
