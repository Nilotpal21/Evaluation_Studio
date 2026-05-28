/**
 * GET /api/invitations/:token
 * Get invitation details by token (public — no auth required)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { getInvitationByToken } from '@/services/invitation-service';
import { isEmailAllowedForAuth } from '@/lib/platform-auth-policy';
import { checkRateLimit } from '@/lib/rate-limit';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('invitations');

// Path parameter schema
const paramsSchema = z.object({
  token: z.string(),
});

// Response schema
const invitationDetailsSchema = z.object({
  invitation: z.object({
    id: z.string(),
    tenantId: z.string(),
    tenantName: z.string(),
    email: z.string(),
    role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']),
    status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']),
    expiresAt: z.string(),
    inviterName: z.string().optional(),
    canSignUp: z.boolean(),
  }),
});

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}***@${domain}`;
}

async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    // Rate limit by IP to prevent token enumeration
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const rl = await checkRateLimit(`invite-lookup:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
      );
    }

    const { token } = await params;
    const invitation = await getInvitationByToken(token);

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    // Check if this email is on the allowlist (without invite bypass) to gate Sign Up
    const canSignUp = await isEmailAllowedForAuth(invitation.email);

    // Mask email to avoid leaking PII on a public endpoint
    return NextResponse.json({
      invitation: {
        ...invitation,
        email: maskEmail(invitation.email),
        canSignUp,
      },
    });
  } catch (error) {
    log.error('Get invitation by token error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get invitation by token',
    description:
      'Retrieve invitation details using the invitation token. Public endpoint, no authentication required.',
    tags: ['Invitations'],
    params: paramsSchema,
    response: invitationDetailsSchema,
    successStatus: 200,
    auth: false,
  },
  getHandler as any,
);
