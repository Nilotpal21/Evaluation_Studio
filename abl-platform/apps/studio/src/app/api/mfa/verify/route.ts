/**
 * POST /api/mfa/verify - Verify a TOTP code or confirm MFA setup
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth');
import {
  confirmMFASetup,
  verifyMFACode,
  verifyRecoveryCode,
  getMFAStatus,
} from '@/services/auth/mfa-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { checkRateLimit } from '@/lib/rate-limit';

const verifyRequestSchema = z.object({
  code: z.string().min(1),
  type: z.enum(['totp', 'recovery', 'setup']).default('totp'),
});

const verifyResponseSchema = z.object({
  verified: z.boolean(),
  status: z
    .object({
      enabled: z.boolean(),
      confirmed: z.boolean().optional(),
      recoveryCodes: z.array(z.string()).optional(),
    })
    .optional(),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  // Rate limit MFA verification attempts to prevent brute-force
  const rl = await checkRateLimit(`mfa-verify:${user.id}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many verification attempts. Please try again later.' },
      { status: 429 },
    );
  }

  const body = await request.json();
  const result = verifyRequestSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  const { code, type } = result.data;

  try {
    let valid = false;
    const auditMeta: Record<string, unknown> = { type };

    if (type === 'setup') {
      // Confirm initial MFA setup with first TOTP code
      valid = await confirmMFASetup(user.id, code);
      if (valid) {
        await logAuditEvent({
          userId: user.id,
          action: AuditActions.MFA_SETUP_CONFIRMED,
          ip: request.headers.get('x-forwarded-for') || undefined,
          userAgent: request.headers.get('user-agent') || undefined,
        });
      }
    } else if (type === 'recovery') {
      // Verify recovery code (single-use)
      valid = await verifyRecoveryCode(user.id, code);
      if (valid) {
        await logAuditEvent({
          userId: user.id,
          action: AuditActions.RECOVERY_CODE_USED,
          ip: request.headers.get('x-forwarded-for') || undefined,
          userAgent: request.headers.get('user-agent') || undefined,
        });
      }
    } else {
      // Verify standard TOTP code
      valid = await verifyMFACode(user.id, code);
    }

    if (valid) {
      await logAuditEvent({
        userId: user.id,
        action: AuditActions.MFA_VERIFIED,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: auditMeta,
      });

      const status = await getMFAStatus(user.id);
      return NextResponse.json({ verified: true, status });
    }

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.MFA_FAILED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: auditMeta,
    });

    return NextResponse.json({ verified: false }, { status: 401 });
  } catch (error) {
    // Handle lock errors from too many failed attempts
    if (error instanceof Error && error.message?.includes('locked')) {
      await logAuditEvent({
        userId: user.id,
        action: AuditActions.MFA_LOCKED,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
      });
      return NextResponse.json(
        { error: 'MFA temporarily locked due to too many failed attempts' },
        { status: 429 },
      );
    }

    log.error('MFA verify error', { err: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Verification failed. Please try again.' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Verify MFA code',
    description:
      'Verify TOTP code, recovery code, or initial setup code. Logs audit events and may lock account after repeated failures.',
    body: verifyRequestSchema,
    response: verifyResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
