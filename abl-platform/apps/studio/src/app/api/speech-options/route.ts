/**
 * GET /api/speech-options — Proxy to runtime voice speech-options
 *
 * Fetches supported languages and voices for a given vendor
 * from the Jambonz voice gateway via the runtime.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { proxyToRuntime } from '@/lib/runtime-proxy';

async function getHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = user.tenantId;
  const vendor = request.nextUrl.searchParams.get('vendor');

  if (!vendor) {
    return NextResponse.json({ error: 'vendor query parameter is required' }, { status: 400 });
  }

  try {
    return await proxyToRuntime(
      request,
      `/api/v1/voice/speech-options?vendor=${encodeURIComponent(vendor)}`,
      { tenantId },
    );
  } catch (error) {
    console.error('[SpeechOptions] Proxy GET error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch speech options from runtime' },
      { status: 502 },
    );
  }
}

export const GET = getHandler;
