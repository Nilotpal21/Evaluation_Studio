/**
 * GET /api/pipelines/triggers - List available trigger definitions
 *
 * Returns the trigger registry for the trigger picker UI.
 * Supports optional `?category=` filter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { listTriggerDefinitions } from '@agent-platform/pipeline-engine/triggers';

export async function GET(req: NextRequest) {
  const user = await requireTenantAuth(req);
  if (isAuthError(user)) return user;

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category') ?? undefined;

  const triggers = listTriggerDefinitions(category ? { category } : undefined);

  return NextResponse.json({
    success: true,
    data: triggers,
  });
}
