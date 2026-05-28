/**
 * POST /api/mfa/setup - Initialize MFA setup for authenticated user
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { setupMFA, getMFAStatus } from '@/services/auth/mfa-service';

const setupResponseSchema = z.object({
  secret: z.string().describe('Base32-encoded TOTP secret'),
  otpauthUrl: z.string().describe('otpauth:// URL for QR code generation'),
  recoveryCodes: z.array(z.string()).describe('One-time backup codes'),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    // Check if MFA is already enabled
    const status = await getMFAStatus(user.id);
    if (status.enabled) {
      return NextResponse.json(
        { error: 'MFA is already enabled. Disable it first to reconfigure.' },
        { status: 409 },
      );
    }

    const result = await setupMFA(user.id);

    return NextResponse.json({
      secret: result.secret,
      otpauthUrl: result.otpauthUrl,
      recoveryCodes: result.recoveryCodes,
    });
  } catch (error) {
    console.error('[MFA] Setup error:', error);
    return NextResponse.json({ error: 'Failed to setup MFA. Please try again.' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Initialize MFA setup',
    description:
      'Generate TOTP secret and recovery codes for authenticated user. Returns conflict if MFA already enabled.',
    response: setupResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
