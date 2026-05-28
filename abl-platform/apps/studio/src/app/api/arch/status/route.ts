/**
 * GET /api/arch/status -- Arch AI status check (thin handler)
 *
 * Auth → service → response.
 * Business logic lives in @/services/arch.service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getArchStatus } from '@/services/arch.service';

export const dynamic = 'force-dynamic';

const log = createLogger('arch-status-route');

export async function GET(request: NextRequest) {
  try {
    const user = await requireTenantAuth(request);
    if (isAuthError(user)) return user;

    const status = await getArchStatus(user.tenantId);
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    log.error(`Status error: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to check Arch status' } },
      { status: 500 },
    );
  }
}
