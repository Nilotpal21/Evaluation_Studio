/**
 * POST /api/mfa/recovery/regenerate - Regenerate recovery codes
 * Requires re-authentication via TOTP code or password.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { regenerateRecoveryCodes, verifyMFACode } from '@/services/auth/mfa-service';
import { verifyPassword } from '@/services/auth/password-service';
import { findUserById } from '@/repos/auth-repo';

const regenerateRequestSchema = z.object({
  code: z.string().optional().describe('TOTP code for re-authentication'),
  password: z.string().optional().describe('Password for re-authentication'),
});

const regenerateResponseSchema = z.object({
  recoveryCodes: z.array(z.string()),
  message: z.string(),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const body = await request.json();
    const { code, password } = body;

    if (!code && !password) {
      return NextResponse.json(
        { error: 'Re-authentication required. Provide a TOTP code or password.' },
        { status: 400 },
      );
    }

    let verified = false;

    if (code && typeof code === 'string') {
      verified = await verifyMFACode(user.id, code);
    }

    if (!verified && password && typeof password === 'string') {
      const dbUser = await findUserById(user.id);
      if (dbUser?.passwordHash) {
        verified = await verifyPassword(password, dbUser.passwordHash);
      }
    }

    if (!verified) {
      return NextResponse.json({ error: 'Re-authentication failed.' }, { status: 401 });
    }

    const codes = await regenerateRecoveryCodes(user.id);

    return NextResponse.json({
      recoveryCodes: codes,
      message: 'New recovery codes generated. Previous codes are now invalid.',
    });
  } catch (error) {
    console.error('[MFA] Recovery regenerate error:', error);
    return NextResponse.json({ error: 'Operation failed. Please try again.' }, { status: 400 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Regenerate recovery codes',
    description:
      'Generate new recovery codes for authenticated user. Requires re-authentication via TOTP or password. Invalidates previous codes.',
    body: regenerateRequestSchema,
    response: regenerateResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
