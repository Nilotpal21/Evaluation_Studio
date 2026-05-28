import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isInternalNetworkRequest } from '@agent-platform/shared-kernel/security';

export const DEFAULT_STUDIO_INTERNAL_ACCESS_HEADER_NAME = 'x-abl-internal-access';

function normalizeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function resolveInternalAccessHeaderName(): string {
  return (
    normalizeValue(process.env.STUDIO_INTERNAL_ACCESS_HEADER_NAME)?.toLowerCase() ??
    DEFAULT_STUDIO_INTERNAL_ACCESS_HEADER_NAME
  );
}

function matchesTrustedInternalAccessToken(
  actual: string | null,
  expected: string | null,
): boolean {
  const normalizedActual = normalizeValue(actual);
  const normalizedExpected = normalizeValue(expected);
  if (!normalizedActual || !normalizedExpected) {
    return false;
  }

  const actualBuffer = Buffer.from(normalizedActual, 'utf8');
  const expectedBuffer = Buffer.from(normalizedExpected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function hasTrustedInternalIngressAssertion(request: NextRequest): boolean {
  const headerName = resolveInternalAccessHeaderName();
  return matchesTrustedInternalAccessToken(
    request.headers.get(headerName),
    process.env.STUDIO_INTERNAL_ACCESS_TOKEN ?? null,
  );
}

export function requireInternalNetworkAccess(request: NextRequest): NextResponse | null {
  // Next.js route handlers do not expose a verified remote peer, so production
  // access must come from an ingress-injected shared secret rather than
  // forwarding headers that clients can spoof.
  if (hasTrustedInternalIngressAssertion(request)) {
    return null;
  }

  const allowLocalhostHostFallback =
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const allowed = isInternalNetworkRequest(
    {
      forwardedFor: request.headers.get('x-forwarded-for'),
      realIp: request.headers.get('x-real-ip'),
      host: request.nextUrl.host,
    },
    { allowLocalhostHostFallback },
  );

  if (allowed) {
    return null;
  }

  return NextResponse.json(
    { success: false, error: 'Forbidden: internal network access required' },
    { status: 403 },
  );
}
