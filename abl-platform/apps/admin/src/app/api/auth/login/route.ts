import { NextRequest, NextResponse } from 'next/server';
import {
  AdminAuthError,
  createAdminSessionPayload,
  createAdminSessionResponse,
} from '../../../../lib/studio-admin-auth';
import { buildStudioApiUrl } from '../../../../lib/studio-url';
import { createLogger } from '../../../../lib/logger';

const log = createLogger('admin-auth-login-route');

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    const { email, password } = body;

    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }

    let studioResponse: Response;
    try {
      studioResponse = await fetch(buildStudioApiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      return NextResponse.json(
        { error: 'Studio server not reachable. Is it running?' },
        { status: 502 },
      );
    }

    const data = (await studioResponse.json().catch(() => null)) as {
      error?: string;
      mfaRequired?: boolean;
      accessToken?: string;
      user?: Record<string, unknown>;
    } | null;

    if (!studioResponse.ok) {
      return NextResponse.json(
        { error: data?.error || 'Studio login failed' },
        { status: studioResponse.status },
      );
    }

    if (data?.mfaRequired) {
      return NextResponse.json(
        { error: 'MFA-enabled Studio accounts are not yet supported in the Admin app.' },
        { status: 409 },
      );
    }

    if (typeof data?.accessToken !== 'string' || !data.user) {
      return NextResponse.json(
        { error: 'Studio login did not return an access token.' },
        { status: 502 },
      );
    }

    return createAdminSessionResponse(
      createAdminSessionPayload({
        accessToken: data.accessToken,
        user: data.user,
      }),
    );
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    log.error('Password login failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
