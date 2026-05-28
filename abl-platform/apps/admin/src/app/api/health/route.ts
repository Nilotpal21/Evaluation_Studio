/**
 * Health Check API
 *
 * GET /api/health — Returns health status for K8s probes
 */

import { NextResponse } from 'next/server';
import { getServiceBuildInfo } from '@agent-platform/shared/build-info';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { status: 'ok', service: 'admin', build: getServiceBuildInfo() },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
