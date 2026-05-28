import { NextResponse } from 'next/server';
import { getServiceBuildInfo } from '@agent-platform/shared/build-info';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { status: 'ok', service: 'studio', build: getServiceBuildInfo() },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
