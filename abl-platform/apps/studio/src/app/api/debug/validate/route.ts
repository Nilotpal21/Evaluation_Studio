/**
 * POST /api/debug/validate - Validate debug token (called by MCP server)
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { findDebugTokenByToken, updateDebugToken } from '@/repos/sdk-repo';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('debug-validate-route');

export async function POST(request: NextRequest) {
  try {
    const serviceSecret = request.headers.get('x-service-secret');
    const expectedSecret = process.env.DEBUG_SERVICE_SECRET;
    const isValid =
      serviceSecret &&
      expectedSecret &&
      Buffer.byteLength(serviceSecret) === Buffer.byteLength(expectedSecret) &&
      timingSafeEqual(Buffer.from(serviceSecret), Buffer.from(expectedSecret));
    if (!isValid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { token } = await request.json();

    if (!token) {
      return NextResponse.json({ valid: false, error: 'Token required' }, { status: 400 });
    }

    const { DebugToken, User } = await import('@agent-platform/database/models');
    const debugToken = (await DebugToken.findOne({ token }).lean()) as any;

    if (!debugToken || debugToken.expiresAt < new Date() || debugToken.revokedAt) {
      return NextResponse.json({ valid: false, error: 'Invalid or expired token' });
    }

    // Look up the associated user
    const user = (await User.findOne(
      { _id: debugToken.userId },
      { _id: 1, email: 1, name: 1 },
    ).lean()) as any;

    // Use repo function to update last used
    await updateDebugToken(debugToken._id, { lastUsedAt: new Date() });

    return NextResponse.json({
      valid: true,
      userId: user?._id || debugToken.userId,
      scopes: JSON.parse(debugToken.scopes),
      sessionIds: JSON.parse(debugToken.sessionIds),
    });
  } catch (error) {
    log.error(`Validate token error: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ valid: false, error: 'Internal server error' }, { status: 500 });
  }
}
