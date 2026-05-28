/**
 * GET /api/pipelines/templates
 *
 * Returns the template index so Studio can show the new-pipeline template picker.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { listTemplates } from '@agent-platform/pipeline-engine/templates';

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  try {
    const templates = await listTemplates();
    return NextResponse.json({ success: true, data: templates });
  } catch (error) {
    return handleApiError(error, 'Templates GET');
  }
}
