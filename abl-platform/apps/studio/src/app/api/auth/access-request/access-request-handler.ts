import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { checkRateLimit } from '@/lib/rate-limit';
import { getAuthRouteClientIp, parseOptionalJsonBody } from '../route-utils';
import { isEmailAllowedForAuth, sendAccessRequestEmail } from '@/lib/platform-auth-policy';

const log = createLogger('auth-access-request');

export const accessRequestSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(200).optional(),
  message: z.string().max(1000).optional(),
});

export const accessRequestResponseSchema = z.object({
  success: z.literal(true),
});

export async function handler(request: NextRequest) {
  const clientIp = getAuthRouteClientIp(request);
  const rl = await checkRateLimit(`access-request:${clientIp}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const body = await parseOptionalJsonBody<unknown>(request);
  const parsed = accessRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase().trim();
  if (await isEmailAllowedForAuth(email)) {
    return NextResponse.json(
      { error: 'This email domain is already approved. Please try signing in again.' },
      { status: 409 },
    );
  }

  try {
    await sendAccessRequestEmail({
      email,
      name: parsed.data.name?.trim(),
      message: parsed.data.message?.trim(),
      ip: clientIp,
      userAgent: request.headers.get('user-agent') || undefined,
    });
  } catch (error) {
    log.error('Failed to send access request email', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Unable to send access request.' }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
