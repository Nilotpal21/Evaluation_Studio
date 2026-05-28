import { NextRequest } from 'next/server';

function splitForwardedChain(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Normalize a forwarded IP chain to the proxy-appended client-facing value.
 *
 * Studio currently trusts the ingress/proxy hop to append the authoritative
 * address on the right-hand side of the `X-Forwarded-For` chain.
 */
export function normalizeForwardedIp(value: string | null | undefined): string | undefined {
  const parts = splitForwardedChain(value);
  return parts.at(-1);
}

/**
 * Extract the client IP from a Next.js request.
 *
 * Uses the **rightmost** value in X-Forwarded-For, which is the IP appended by
 * the trusted reverse proxy. The leftmost value is client-controlled and
 * spoofable.  Falls back to X-Real-IP (set by nginx) or 'unknown'.
 */
export function getClientIp(request: NextRequest): string {
  return (
    normalizeForwardedIp(request.headers.get('x-forwarded-for')) ??
    request.headers.get('x-real-ip')?.trim() ??
    'unknown'
  );
}
