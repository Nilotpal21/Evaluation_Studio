/**
 * DELETE /api/mfa/disable - Disable MFA for the current user
 *
 * Requires re-authentication: either a valid TOTP code or the account password.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { disableMFA, verifyMFACode } from '@/services/auth/mfa-service';
import { verifyPassword } from '@/services/auth/password-service';
import { getUserById } from '@/services/auth-service';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const log = createLogger('mfa-disable-route');

const disableRequestSchema = z.object({
  code: z.string().optional().describe('TOTP code for re-authentication'),
  password: z.string().optional().describe('Password for re-authentication'),
});

const disableResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    let body: { code?: string; password?: string } = {};
    try {
      body = await request.json();
    } catch {
      // Body may be empty
    }

    const { code, password } = body;

    if (!code && !password) {
      return NextResponse.json(
        { error: 'Please provide your current TOTP code or password to confirm' },
        { status: 400 },
      );
    }

    // Verify identity via TOTP code
    if (code) {
      const valid = await verifyMFACode(user.id, code);
      if (!valid) {
        return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 403 });
      }
    }
    // Verify identity via password
    else if (password) {
      const fullUser = await getUserById(user.id);
      if (!fullUser?.passwordHash) {
        return NextResponse.json(
          { error: 'Password verification not available for this account' },
          { status: 400 },
        );
      }
      const valid = await verifyPassword(password, fullUser.passwordHash);
      if (!valid) {
        return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
      }
    }

    await disableMFA(user.id);

    await logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.MFA_DISABLED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        method: code ? 'totp' : 'password',
      },
    });

    return NextResponse.json({ success: true, message: 'MFA disabled.' });
  } catch (error) {
    log.error('MFA disable error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const DELETE = withOpenAPI(
  {
    summary: 'Disable MFA',
    description:
      'Disable MFA for authenticated user. Requires re-authentication via TOTP code or password.',
    body: disableRequestSchema,
    response: disableResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
