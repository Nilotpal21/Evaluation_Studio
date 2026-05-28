/**
 * POST /api/mfa/confirm - Confirm MFA setup with first TOTP code
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { confirmMFASetup } from '@/services/auth/mfa-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth');

const confirmRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Must be 6 digits'),
});

const confirmResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const { code } = await request.json();

    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return NextResponse.json(
        { error: 'Invalid code format. Must be 6 digits.' },
        { status: 400 },
      );
    }

    const confirmed = await confirmMFASetup(user.id, code);

    if (!confirmed) {
      return NextResponse.json(
        { error: 'Invalid code. Check your authenticator app and try again.' },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, message: 'MFA successfully enabled.' });
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('already confirmed')) {
      return NextResponse.json({ error: 'MFA has already been confirmed' }, { status: 409 });
    }
    log.error('MFA confirm error', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Confirm MFA setup',
    description:
      'Verify first TOTP code to complete MFA enablement. Must be called after /api/mfa/setup.',
    body: confirmRequestSchema,
    response: confirmResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
