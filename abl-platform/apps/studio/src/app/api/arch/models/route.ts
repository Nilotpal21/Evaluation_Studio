/**
 * GET /api/arch/models -- LLM model list (thin handler)
 *
 * Auth → service → response.
 * Business logic lives in @/services/arch.service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { MODEL_REGISTRY } from '@abl/compiler/platform/llm/model-registry.js';
import { getArchModels } from '@/services/arch.service';

export const dynamic = 'force-dynamic';

const log = createLogger('arch-models-route');

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    if (isAuthError(user)) return user;

    const data = getArchModels(MODEL_REGISTRY);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    log.error(`Models error: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch model list' } },
      { status: 500 },
    );
  }
}
