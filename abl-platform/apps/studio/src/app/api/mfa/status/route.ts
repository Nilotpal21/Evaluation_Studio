/**
 * GET /api/mfa/status - Get MFA status for the current user
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getMFAStatus } from '@/services/auth/mfa-service';

const statusResponseSchema = z.object({
  enabled: z.boolean().describe('Whether MFA is enabled'),
  confirmed: z.boolean().optional().describe('Whether MFA setup was confirmed'),
  recoveryCodes: z.array(z.string()).optional().describe('Available recovery codes (if any)'),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const status = await getMFAStatus(user.id);
    return NextResponse.json(status);
  } catch (error) {
    console.error('[MFA] Status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get MFA status',
    description: 'Retrieve current MFA enablement status for authenticated user.',
    response: statusResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
