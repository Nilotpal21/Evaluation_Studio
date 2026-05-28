/**
 * POST /api/arch/validate-key -- API key validation (thin handler)
 *
 * Auth → validate → service → response.
 * Business logic lives in @/services/arch.service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { validateApiKey } from '@/services/arch.service';

export const dynamic = 'force-dynamic';

const log = createLogger('arch-validate-key-route');

const validateKeySchema = z.object({
  provider: z.string().min(1).max(100),
  apiKey: z.string().min(1).max(500),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    if (isAuthError(user)) return user;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
        },
        { status: 400 },
      );
    }

    const parsed = validateKeySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
        { status: 400 },
      );
    }

    const { provider, apiKey } = parsed.data;
    const result = await validateApiKey(provider, apiKey);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    log.error(`Validate key error: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to validate key' } },
      { status: 500 },
    );
  }
}
