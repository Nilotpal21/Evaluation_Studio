/**
 * GET / PUT  /api/arch/config -- Arch workspace configuration (thin handler)
 *
 * Auth → validate → service → response.
 * Business logic lives in @/services/arch.service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getArchConfig, updateArchConfig } from '@/services/arch.service';

export const dynamic = 'force-dynamic';

const log = createLogger('arch-config-route');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const updateConfigSchema = z.object({
  modelId: z.string().max(200).optional(),
  provider: z.string().max(100).optional(),
  usePlatformCredits: z.boolean().optional(),
  maxTokensChat: z.number().min(512).max(8192).optional(),
  maxTokensGenerate: z.number().min(512).max(16384).optional(),
  temperature: z.number().min(0).max(2).optional(),
  rateLimitRpm: z.number().min(0).optional(),
  rateLimitRph: z.number().min(0).optional(),
  apiKey: z.string().max(500).optional(),
  endpoint: z.string().url().max(500).optional().nullable(),
  authType: z.enum(['api_key', 'bearer', 'custom']).optional(),
  customHeaders: z.record(z.string()).optional().nullable(),
  hyperParameters: z.record(z.unknown()).optional(),
  tenantModelId: z.string().max(200).optional().nullable(),
  authProfileId: z.string().max(200).optional().nullable(),
  lastValidatedAt: z.string().datetime().optional().nullable(),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const user = await requireTenantAuth(request);
    if (isAuthError(user)) return user;

    const data = await getArchConfig(user.tenantId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    log.error(`Config GET error: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch Arch config' } },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------

export async function PUT(request: NextRequest) {
  try {
    const user = await requireTenantAuth(request);
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

    const parsed = updateConfigSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
        { status: 400 },
      );
    }

    const result = await updateArchConfig(user.tenantId, user.id, parsed.data);

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    log.error(`Config PUT error: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update Arch config' },
      },
      { status: 500 },
    );
  }
}
