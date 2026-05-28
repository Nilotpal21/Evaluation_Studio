/**
 * GET /api/pipelines/activities - List available pipeline activity types
 *
 * Returns metadata for all registered activity types (evaluate-metrics,
 * store-results, send-notification, etc.). Used by the pipeline editor
 * UI to populate the step type selector with config schemas.
 *
 * This is a metadata endpoint — requires basic auth but no tenant context.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { listActivityTypes } from '@agent-platform/pipeline-engine/metadata';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  return NextResponse.json({ activityTypes: listActivityTypes() });
}
