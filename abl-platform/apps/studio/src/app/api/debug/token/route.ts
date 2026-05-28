/**
 * POST   /api/debug/token  - Create debug token
 * DELETE /api/debug/token  - Revoke single debug token
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireAuth, isAuthError } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { createDebugToken, findDebugTokenByToken, updateDebugToken } from '@/repos/sdk-repo';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const rl = await checkRateLimit(`debug-token:${user.id}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const scopes = body.scopes || ['read_traces', 'read_state', 'subscribe'];
    const sessionIds = body.sessionIds || [];

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Use repo function
    const debugToken = await createDebugToken({
      token,
      userId: user.id,
      scopes: JSON.stringify(scopes),
      sessionIds: JSON.stringify(sessionIds),
      expiresAt,
    });

    return NextResponse.json({
      token,
      expiresAt: debugToken.expiresAt,
      scopes,
    });
  } catch (error) {
    console.error('[Debug] Create token error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const body = await request.json().catch(() => ({}));
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'Token required' }, { status: 400 });
    }

    const { DebugToken } = await import('@agent-platform/database/models');
    await DebugToken.deleteMany({ token, userId: user.id });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Debug] Delete token error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
