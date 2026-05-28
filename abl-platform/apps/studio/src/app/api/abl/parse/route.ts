/**
 * POST /api/abl/parse - Parse ABL content and return AST/errors
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseAgentBasedABL } from '@abl/core';
import { requireAuth, isAuthError } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';

/** Maximum DSL input size (500KB) */
const MAX_DSL_SIZE = 512_000;

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const rl = await checkRateLimit(`parse:${authResult.id}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const { dsl } = await request.json();

    if (!dsl || typeof dsl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid ABL content' },
        { status: 400 },
      );
    }

    if (dsl.length > MAX_DSL_SIZE) {
      return NextResponse.json(
        { success: false, error: `ABL content exceeds maximum size of ${MAX_DSL_SIZE} bytes` },
        { status: 400 },
      );
    }

    const result = parseAgentBasedABL(dsl);

    return NextResponse.json({
      success: result.errors.length === 0,
      document: result.document,
      errors: result.errors,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error('[ABL API] Parse error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown parse error' },
      { status: 500 },
    );
  }
}
