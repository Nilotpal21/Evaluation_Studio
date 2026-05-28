import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { hashToken } from '../../../../lib/token-hash';
import { findRefreshToken } from '../../../../repos/auth-repo';
import { checkDomainAllowed, getAllowedDomains } from '../../../../lib/docs/access';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get('refresh_token')?.value;

    if (!refreshToken) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'No refresh token' } },
        { status: 401 },
      );
    }

    const hashedToken = hashToken(refreshToken);
    const tokenRecord = await findRefreshToken(hashedToken);

    if (!tokenRecord || tokenRecord.revokedAt) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked token' } },
        { status: 401 },
      );
    }

    // Check expiry
    if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) < new Date()) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Token expired' } },
        { status: 401 },
      );
    }

    const email = tokenRecord.user?.email;
    if (!email) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'No email found' } },
        { status: 401 },
      );
    }

    const allowed = checkDomainAllowed(email, getAllowedDomains());

    return NextResponse.json({
      success: true,
      data: { email, allowed },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message } },
      { status: 500 },
    );
  }
}
