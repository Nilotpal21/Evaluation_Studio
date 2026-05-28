/**
 * POST /api/auth/resolve-account
 * Resolve whether an email belongs to an existing user or a new user.
 * Used by the login page to route users to the correct flow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkRateLimit } from '@/lib/rate-limit';
import { findUserByEmail } from '@/repos/auth-repo';
import { authError, getAuthRouteClientIp, parseOptionalJsonBody } from '../route-utils';
import { isEmailAllowedForAuth } from '@/lib/platform-auth-policy';

const log = createLogger('auth:resolve-account');

const resolveAccountRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(254),
  inviteToken: z.string().max(512).optional(),
});

const resolveAccountResponseSchema = z.object({
  status: z.enum(['existing', 'new']),
});

async function handler(request: NextRequest) {
  try {
    const ip = getAuthRouteClientIp(request);
    const rl = await checkRateLimit(`resolve-account:${ip}`, 10, 60 * 1000);
    if (!rl.allowed) {
      return authError('Too many requests. Please try again later.', 429, {
        'Retry-After': String(rl.retryAfter),
      });
    }

    const body = await parseOptionalJsonBody<unknown>(request);
    if (!body) {
      return authError('A valid email address is required', 400);
    }
    const parsed = resolveAccountRequestSchema.safeParse(body);
    if (!parsed.success) {
      return authError('A valid email address is required', 400);
    }

    const normalizedEmail = parsed.data.email.toLowerCase().trim();
    const inviteToken = parsed.data.inviteToken;

    // Check if account already exists — existing users can always sign in;
    // allowlist only gates new account creation.
    const user = await findUserByEmail(normalizedEmail);
    if (!user) {
      if (
        !(await isEmailAllowedForAuth(normalizedEmail, { inviteToken: inviteToken || undefined }))
      ) {
        return NextResponse.json(
          {
            error: 'This email domain is not approved for platform access.',
            code: 'DOMAIN_NOT_ALLOWED',
          },
          { status: 403 },
        );
      }
    }

    return NextResponse.json({
      status: user ? 'existing' : 'new',
    });
  } catch (error) {
    log.error('resolve-account error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Resolve account status by email',
    description:
      'Check whether an email belongs to an existing user or is new. Rate limited to prevent bulk enumeration.',
    body: resolveAccountRequestSchema,
    response: resolveAccountResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);
