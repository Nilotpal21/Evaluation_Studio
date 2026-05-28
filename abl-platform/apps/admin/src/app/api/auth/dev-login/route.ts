import { NextRequest, NextResponse } from 'next/server';
import {
  AdminAuthError,
  createAdminSessionPayload,
  createAdminSessionResponse,
} from '../../../../lib/studio-admin-auth';
import { buildStudioApiUrl } from '../../../../lib/studio-url';
import { createLogger } from '../../../../lib/logger';

const log = createLogger('admin-auth-dev-login-route');

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { email?: string; name?: string };
    const { email, name } = body;

    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    // Forward to Studio's dev-login endpoint
    let studioResponse: Response;
    try {
      studioResponse = await fetch(buildStudioApiUrl('/api/auth/dev-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
      });
    } catch {
      return NextResponse.json(
        { error: 'Studio server not reachable. Is it running?' },
        { status: 502 },
      );
    }

    if (!studioResponse.ok) {
      const err = (await studioResponse.json().catch(() => ({ error: 'Unknown error' }))) as {
        error?: string;
      };
      return NextResponse.json(
        { error: err.error || 'Studio login failed' },
        { status: studioResponse.status },
      );
    }

    const data = (await studioResponse.json()) as {
      accessToken: string;
      user: Record<string, unknown>;
    };
    return createAdminSessionResponse(createAdminSessionPayload(data));
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    log.error('Dev login failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
