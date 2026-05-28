import { NextRequest, NextResponse } from 'next/server';
import {
  AdminAuthError,
  createAdminSessionPayload,
  createAdminSessionRedirectResponse,
} from '../../../../../lib/studio-admin-auth';
import { buildAdminLoginUrl, buildAdminPostLoginUrl } from '../../../../../lib/admin-auth-redirect';
import { buildStudioApiUrl } from '../../../../../lib/studio-url';
import { createLogger } from '../../../../../lib/logger';

interface StudioExchangeSuccess {
  accessToken?: string;
  error?: string;
}

interface StudioMeResponse {
  id?: string;
  email?: string;
  name?: string | null;
  isSuperAdmin?: boolean;
}

const log = createLogger('admin-auth-studio-callback-route');

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const redirectPath = request.nextUrl.searchParams.get('redirect');
  const loginUrl = buildAdminLoginUrl(request, { redirectPath });

  if (!code) {
    loginUrl.searchParams.set('error', 'Missing Studio auth code.');
    return NextResponse.redirect(loginUrl);
  }

  try {
    let exchangeResponse: Response;
    try {
      exchangeResponse = await fetch(buildStudioApiUrl('/api/sso/exchange'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch (error) {
      log.error('Studio SSO exchange request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      loginUrl.searchParams.set('error', 'Studio SSO is currently unavailable.');
      return NextResponse.redirect(loginUrl);
    }

    const exchangeData = await readJson<StudioExchangeSuccess>(exchangeResponse);
    if (!exchangeResponse.ok || typeof exchangeData?.accessToken !== 'string') {
      loginUrl.searchParams.set(
        'error',
        exchangeData?.error || 'Studio SSO login could not be completed.',
      );
      return NextResponse.redirect(loginUrl);
    }

    let meResponse: Response;
    try {
      meResponse = await fetch(buildStudioApiUrl('/api/auth/me'), {
        headers: {
          Authorization: `Bearer ${exchangeData.accessToken}`,
        },
      });
    } catch (error) {
      log.error('Studio profile request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      loginUrl.searchParams.set('error', 'Unable to load the Studio account profile.');
      return NextResponse.redirect(loginUrl);
    }

    const meData = await readJson<StudioMeResponse>(meResponse);
    if (!meResponse.ok || !meData?.id || !meData.email) {
      loginUrl.searchParams.set('error', 'Unable to verify the Studio account profile.');
      return NextResponse.redirect(loginUrl);
    }

    const session = createAdminSessionPayload({
      accessToken: exchangeData.accessToken,
      user: {
        id: meData.id,
        email: meData.email,
        name: meData.name ?? null,
        isSuperAdmin: meData.isSuperAdmin === true,
      },
    });

    return createAdminSessionRedirectResponse(
      session,
      buildAdminPostLoginUrl(request, redirectPath),
    );
  } catch (error) {
    if (error instanceof AdminAuthError) {
      loginUrl.searchParams.set('error', error.message);
      return NextResponse.redirect(loginUrl);
    }

    log.error('Unexpected admin SSO callback failure', {
      error: error instanceof Error ? error.message : String(error),
    });
    loginUrl.searchParams.set('error', 'Admin SSO login failed unexpectedly.');
    return NextResponse.redirect(loginUrl);
  }
}
