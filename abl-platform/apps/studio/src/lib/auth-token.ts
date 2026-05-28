/**
 * Lightweight JWT helpers for Studio client-side role-aware rendering.
 *
 * These helpers intentionally decode claims without verifying signatures
 * because the browser only needs non-sensitive display state that is already
 * present in the signed token.
 */

export interface AccessTokenClaims {
  tenantId?: string;
  role?: string;
  isSuperAdmin?: boolean;
}

function decodeBase64Url(segment: string): string | null {
  if (!segment) {
    return null;
  }

  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

  try {
    if (typeof atob === 'function') {
      return atob(padded);
    }

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf-8');
    }
  } catch {
    return null;
  }

  return null;
}

export function readAccessTokenClaims(
  accessToken: string | null | undefined,
): AccessTokenClaims | null {
  if (!accessToken) {
    return null;
  }

  const [, payloadSegment] = accessToken.split('.');
  const decodedPayload = decodeBase64Url(payloadSegment);
  if (!decodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodedPayload) as Record<string, unknown>;
    return {
      tenantId: typeof parsed.tenantId === 'string' ? parsed.tenantId : undefined,
      role: typeof parsed.role === 'string' ? parsed.role : undefined,
      isSuperAdmin: parsed.isSuperAdmin === true,
    };
  } catch {
    return null;
  }
}

export function isWorkspaceAdminRole(role: unknown): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function canAccessWorkspaceAdmin(accessToken: string | null | undefined): boolean {
  return isWorkspaceAdminRole(readAccessTokenClaims(accessToken)?.role);
}
