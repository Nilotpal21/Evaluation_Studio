/**
 * JWT Utilities
 *
 * Shared JWT payload construction and signing used by both
 * dev-login (auth.ts) and device auth (device-auth-service.ts).
 */

import crypto from 'node:crypto';
import { signPlatformAccessToken } from '@agent-platform/shared-auth';

// =============================================================================
// Types
// =============================================================================

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
}

export interface MembershipRecord {
  tenantId: string;
  role: string;
  tenant: { organizationId: string | null };
}

// =============================================================================
// Membership Resolution
// =============================================================================

/**
 * Resolve the first tenant membership for a user (by creation order).
 * Returns null if the user has no memberships.
 */
export async function resolveFirstMembership(userId: string): Promise<MembershipRecord | null> {
  const { TenantMember, Tenant } = await import('@agent-platform/database/models');
  const member = await TenantMember.findOne({ userId }).sort({ createdAt: 1 }).lean();
  if (!member) return null;

  const tenant = await Tenant.findOne(
    { _id: (member as any).tenantId },
    { organizationId: 1 },
  ).lean();
  return {
    tenantId: (member as any).tenantId,
    role: (member as any).role,
    tenant: { organizationId: (tenant as any)?.organizationId ?? null },
  };
}

// =============================================================================
// JWT Payload
// =============================================================================

/**
 * Build a JWT access token payload with optional tenant context.
 */
export function buildAccessTokenPayload(
  user: UserRecord,
  membership?: MembershipRecord | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sub: user.id,
    email: user.email,
    type: 'access',
    tokenClass: 'user',
    name: user.name,
  };

  if (membership) {
    payload.tenantId = membership.tenantId;
    payload.role = membership.role;
    if (membership.tenant.organizationId) {
      payload.orgId = membership.tenant.organizationId;
    }
  }

  return payload;
}

/**
 * Sign a JWT payload with the given secret and expiry (in seconds).
 */
export function signAccessToken(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSec = 86400, // 24h
): string {
  return signPlatformAccessToken(payload, secret, { expiresIn: expiresInSec });
}

// =============================================================================
// Refresh Token
// =============================================================================

/**
 * Create a refresh token, store it hashed, and return the raw value.
 */
export async function createStoredRefreshToken(userId: string, expiryDays = 7): Promise<string> {
  const { RefreshToken } = await import('@agent-platform/database/models');
  const raw = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');

  await RefreshToken.create({
    token: hashed,
    userId,
    familyId: crypto.randomUUID(),
    generation: 1,
    expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
  });

  return raw;
}
