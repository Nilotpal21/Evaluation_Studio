import { NextRequest, NextResponse } from 'next/server';
import { getServiceBuildInfo } from '@agent-platform/shared/build-info';

export const dynamic = 'force-dynamic';

const DEV_LOGIN_PROBE_EMAIL = 'sdk-browser-stack@e2e-smoke.test';
const DEV_LOGIN_PROBE_NAME = 'SDK Browser Stack Probe';

export async function GET(request: NextRequest) {
  if (process.env.ENABLE_DEV_LOGIN !== 'true') {
    return NextResponse.json(
      { status: 'disabled', service: 'studio' },
      {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  try {
    const probeResponse = await fetch(new URL('/api/auth/dev-login', request.nextUrl.origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: DEV_LOGIN_PROBE_EMAIL,
        name: DEV_LOGIN_PROBE_NAME,
      }),
      cache: 'no-store',
    });

    if (!probeResponse.ok) {
      return NextResponse.json(
        { status: 'not_ready', service: 'studio' },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      );
    }
  } catch {
    return NextResponse.json(
      { status: 'not_ready', service: 'studio' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  return NextResponse.json(
    {
      status: 'ready',
      service: 'studio',
      build: getServiceBuildInfo(),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
