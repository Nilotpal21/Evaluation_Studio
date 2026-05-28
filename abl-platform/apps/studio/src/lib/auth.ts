/**
 * Server-side auth helper for Next.js API routes.
 *
 * Verifies JWT from Authorization header and returns the authenticated user.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { verifyPlatformAccessToken } from '@agent-platform/shared-auth';
import {
  verifyAccessToken,
  resolveUserTenantContext,
  revokeAllUserTokens,
} from '@/services/auth-service';
import type { JWTPayload } from '@/services/auth-service';
import { findTenantMembership, findUserById, resetFailedLoginAttempts } from '@/repos/auth-repo';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { resolveStudioPermissions } from '@/lib/permission-resolver';
import { findTenantById, findTenantMember, updateTenantMember } from '@/repos/workspace-repo';
import { logAuditEvent, setCurrentAuditContext } from '@/services/audit-service';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from './workspace-permission';
import { checkIsSuperAdmin } from './super-admin';
import { isPlatformAdminUser } from './platform-auth-policy';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  tenantId?: string;
  /** Set when the JWT named a tenant but the membership was revoked/deactivated. */
  revokedTenantId?: string;
  role?: string;
  /** Resolved RBAC permissions (e.g. ['tool:read', 'tool:write']) */
  permissions: string[];
  canCreateWorkspace?: boolean; // decoded from JWT claim; absent = true
}

// ─── Auth Result Cache ──────────────────────────────────────────────────────
// Caches the fully resolved AuthenticatedUser per JWT token for 30 seconds.
// Eliminates 2-3 MongoDB queries (findUserById, findTenantMembership,
// resolveStudioPermissions) on repeated requests with the same token.
// Short TTL ensures membership/role changes propagate within 30s.

interface CachedAuthResult {
  user: AuthenticatedUser;
  cachedAt: number;
}

const AUTH_CACHE_TTL_MS = 30_000; // 30 seconds
const AUTH_CACHE_MAX = 200;
const authResultCache = new Map<string, CachedAuthResult>();

/** Invalidate cached auth for a specific user (call on role/membership change). */
export function invalidateAuthCache(tokenOrUserId?: string): void {
  if (tokenOrUserId) {
    // Try direct key first
    if (authResultCache.delete(tokenOrUserId)) return;
    // Fall back to scanning by userId
    for (const [key, entry] of authResultCache) {
      if (entry.user.id === tokenOrUserId) {
        authResultCache.delete(key);
      }
    }
  } else {
    authResultCache.clear();
  }
}

/**
 * Get the authenticated user from a Next.js API request.
 * Validates JWT from Authorization: Bearer header.
 * Returns null if no valid credential is found.
 *
 * Results are cached for 30s per token to avoid repeated MongoDB lookups
 * on high-frequency polling endpoints (session list, analytics).
 */
export async function getAuthenticatedUser(
  request: NextRequest,
): Promise<AuthenticatedUser | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const payload = verifyAccessToken(token);
  if (!payload) return null;

  // Check cache — same token within TTL means same user/tenant/permissions
  const cached = authResultCache.get(token);
  if (cached && Date.now() - cached.cachedAt < AUTH_CACHE_TTL_MS) {
    return cached.user;
  }

  const user = await findUserById(payload.sub);
  if (!user?.id) return null;

  // Revalidate tenant context from the database instead of trusting the JWT.
  // This prevents stale tokens from continuing to use archived workspaces or
  // deactivated memberships after the token was issued.
  let tenantId: string | undefined;
  let revokedTenantId: string | undefined;
  let role: string | undefined;

  if (payload.tenantId) {
    const membership = await findTenantMembership(user.id, payload.tenantId);
    if (membership) {
      tenantId = membership.tenantId;
      role = membership.role;
    } else {
      // Membership was revoked or deactivated after this token was issued.
      revokedTenantId = payload.tenantId;
    }
  } else {
    // Tokens created before tenant assignment (first-login race), refresh edge
    // cases, or super-admin tokens without an explicit tenant can still fall
    // back to the user's current active workspace context.
    const tenantContext = await resolveUserTenantContext(user.id);
    if (tenantContext) {
      tenantId = tenantContext.tenantId;
      role = tenantContext.role;
    }
  }

  // Resolve RBAC permissions (empty array if no tenant context)
  const permissions =
    tenantId && role ? await resolveStudioPermissions(tenantId, user.id, role) : [];

  const result: AuthenticatedUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    tenantId,
    revokedTenantId,
    role,
    permissions,
    ...(payload.canCreateWorkspace === false ? { canCreateWorkspace: false } : {}),
  };

  // Cache the result — evict oldest if at capacity
  if (authResultCache.size >= AUTH_CACHE_MAX) {
    const oldest = authResultCache.keys().next().value;
    if (oldest !== undefined) authResultCache.delete(oldest);
  }
  authResultCache.delete(token);
  authResultCache.set(token, { user: result, cachedAt: Date.now() });

  return result;
}

/**
 * Require authentication for a route handler.
 * Returns the user or a 401 response.
 */
export async function requireAuth(request: NextRequest): Promise<AuthenticatedUser | NextResponse> {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
  }
  setCurrentAuditContext({
    requestId:
      request.headers.get('x-request-id') ?? request.headers.get('x-correlation-id') ?? undefined,
    tenantId: user.tenantId,
    userId: user.id,
  });
  return user;
}

/**
 * Helper to check if requireAuth returned a response (error) or a user.
 */
export function isAuthError(result: AuthenticatedUser | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}

export function getAuthErrorInfo(error: unknown): { message: string; status: number } | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const errorWithStatus = error as Error & {
    status?: unknown;
    statusCode?: unknown;
  };
  const status =
    typeof errorWithStatus.statusCode === 'number'
      ? errorWithStatus.statusCode
      : typeof errorWithStatus.status === 'number'
        ? errorWithStatus.status
        : null;

  if (typeof status !== 'number' || status < 400 || status >= 500) {
    return null;
  }

  return {
    message: error.message,
    status,
  };
}

export type TenantAuthenticatedUser = AuthenticatedUser & { tenantId: string };
export type MemberLifecycleStatus = 'active' | 'suspended' | 'locked' | 'deactivated';

export interface MemberLifecycleContext {
  authResult: AuthenticatedUser;
  tenantId: string;
  userId: string;
  actorMembership: any;
  targetMembership: any;
}

/**
 * Require authentication AND tenant membership.
 * Returns the user with guaranteed tenantId, or a 401/403 response.
 * Use this instead of requireAuth + user.tenantId! for routes that need a tenant.
 */
export async function requireTenantAuth(
  request: NextRequest,
): Promise<TenantAuthenticatedUser | NextResponse> {
  const result = await requireAuth(request);
  if (result instanceof NextResponse) return result;
  if (!result.tenantId) {
    if (result.revokedTenantId) {
      try {
        const tenant = await findTenantById(result.revokedTenantId);
        if (tenant?.ownerId) {
          const owner = await findUserById(tenant.ownerId);
          if (owner?.email) {
            const ownerLabel = owner.name ? `${owner.name} (${owner.email})` : owner.email;
            const workspaceName = tenant.name ?? 'this workspace';
            return errorJson(
              `Your access to ${workspaceName} has been revoked. Contact ${ownerLabel} to restore access.`,
              403,
              ErrorCode.FORBIDDEN,
            );
          }
        }
      } catch {
        // Fall through to generic message if lookup fails
      }
    }
    return errorJson(
      'You do not have access to a workspace. Contact your workspace owner to restore access.',
      403,
      ErrorCode.FORBIDDEN,
    );
  }
  return result as TenantAuthenticatedUser;
}

/**
 * Human-readable label for audit fields (createdBy, modifiedBy).
 * Preference: name > email > id.
 */
export function formatUserLabel(user: Pick<AuthenticatedUser, 'id' | 'email' | 'name'>): string {
  return user.name || user.email || user.id;
}

/**
 * Check if a user ID is in the SUPER_ADMIN_USER_IDS env var.
 */
export { checkIsSuperAdmin } from './super-admin';

/**
 * Require platform admin (super-admin) access for a route handler.
 * Returns the user or a 403 response. Must be called after requireAuth.
 */
export async function requirePlatformAdminAccess(
  user: AuthenticatedUser,
): Promise<NextResponse | null> {
  if (!(await isPlatformAdminUser(user))) {
    return NextResponse.json(
      { success: false, error: 'Forbidden: Platform administrator access required' },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Require OWNER or ADMIN role within the user's tenant.
 * Returns null if authorized, or a 403 response if not.
 */
export async function requireAdminRole(
  userId: string,
  tenantId: string,
): Promise<NextResponse | null> {
  const membership = await findTenantMembership(userId, tenantId);
  if (!membership || !ADMIN_ROLES.has(membership.role)) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  return null;
}

export async function requireMemberLifecycleContext(
  request: NextRequest,
  params: Promise<{ tenantId: string; userId: string }>,
  options?: { targetMemberStatuses?: MemberLifecycleStatus[] },
): Promise<MemberLifecycleContext | NextResponse> {
  const { tenantId, userId } = await params;

  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) {
    return authResult;
  }

  if (authResult.tenantId && tenantId !== authResult.tenantId) {
    return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
  }

  const workspaceAccess = await requireWorkspacePermission(
    tenantId,
    authResult,
    WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
    {
      denyBehavior: 'not_found',
    },
  );
  if (workspaceAccess instanceof NextResponse) {
    return workspaceAccess;
  }

  const targetMembership = await findTenantMember(tenantId, userId, {
    memberStatuses: options?.targetMemberStatuses ?? [
      'active',
      'suspended',
      'locked',
      'deactivated',
    ],
  });
  if (!targetMembership) {
    return errorJson('Member not found', 404, ErrorCode.NOT_FOUND);
  }

  return {
    authResult,
    tenantId,
    userId,
    actorMembership: workspaceAccess.membership,
    targetMembership,
  };
}

export async function applyMemberLifecycleStatus(
  request: NextRequest,
  context: MemberLifecycleContext,
  nextStatus: MemberLifecycleStatus,
  action: string,
  options?: {
    clearUserLoginLock?: boolean;
    revokeTokens?: boolean;
  },
): Promise<NextResponse> {
  await updateTenantMember(context.tenantId, context.userId, { status: nextStatus });

  if (options?.clearUserLoginLock) {
    await resetFailedLoginAttempts(context.userId, {
      restoreLockedMemberships: 'always',
    });
  }

  if (options?.revokeTokens !== false) {
    await revokeAllUserTokens(context.userId);
  }

  await logAuditEvent({
    userId: context.authResult.id,
    tenantId: context.tenantId,
    action,
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    metadata: {
      targetUserId: context.userId,
      previousStatus: context.targetMembership.status || 'active',
      nextStatus,
    },
  });

  return NextResponse.json({ success: true, status: nextStatus });
}

// =============================================================================
// IP ALLOWLISTING
// =============================================================================

/**
 * Check if a client IP is in the platform admin allowlist.
 * Supports plain IPs and CIDR ranges. Empty list = no restriction.
 */
function isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) return true;
  const normalised = clientIp.replace(/^::ffff:/, '');
  return allowedIps.some((entry) => {
    if (entry.includes('/')) {
      return cidrMatch(normalised, entry);
    }
    return normalised === entry;
  });
}

function cidrMatch(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const ipNum = ipToNumber(ip);
  const baseNum = ipToNumber(base);
  if (ipNum === null || baseNum === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) >>> 0 === (baseNum & mask) >>> 0;
}

function ipToNumber(ip: string): number | null {
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  let num = 0;
  for (const o of octets) {
    const v = parseInt(o, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    num = ((num << 8) | v) >>> 0;
  }
  return num;
}

/**
 * Require that the request originates from an allowed IP for platform admin access.
 * Reads PLATFORM_ADMIN_ALLOWED_IPS env var (comma-separated IPs/CIDRs).
 * Empty = no IP restriction.
 */
export function requirePlatformAdminIpAccess(request: NextRequest): NextResponse | null {
  const raw = process.env.PLATFORM_ADMIN_ALLOWED_IPS || '';
  if (!raw) return null; // No list = no restriction

  const allowedIps = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedIps.length === 0) return null;

  // SECURITY: Use the rightmost X-Forwarded-For value (appended by the trusted
  // reverse proxy) instead of the leftmost (client-controlled and spoofable).
  // Falls back to X-Real-IP (set by nginx) or empty string.
  const forwardedFor = request.headers.get('x-forwarded-for');
  const forwardedParts = forwardedFor?.split(',').map((s) => s.trim()) ?? [];
  const clientIp =
    forwardedParts[forwardedParts.length - 1] || request.headers.get('x-real-ip') || '';

  if (!isIpAllowed(clientIp, allowedIps)) {
    return NextResponse.json(
      { success: false, error: 'Forbidden: IP address not in platform admin allowlist' },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Like requireAuth but also accepts mfa_pending tokens.
 * Used for MFA recovery where the user has a partial (mfa_pending) token.
 */
export async function requireAuthOrMFAPending(
  request: NextRequest,
): Promise<AuthenticatedUser | NextResponse> {
  // Try standard access token first
  const user = await getAuthenticatedUser(request);
  if (user) return user;

  // Try mfa_partial cookie (set during login when MFA is required)
  const mfaPartialToken = request.cookies.get('mfa_partial')?.value;

  // Also check Authorization header for mfa_pending tokens
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const tokenToVerify = mfaPartialToken || bearerToken;

  if (!tokenToVerify) {
    return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
  }

  try {
    const { getConfig, isConfigLoaded } = await import('@/config');
    const secret = isConfigLoaded() ? getConfig().jwt.secret : process.env.JWT_SECRET;
    if (!secret) {
      return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
    }

    const payload = verifyPlatformAccessToken(tokenToVerify, secret) as unknown as JWTPayload;
    if (payload.type !== 'access' && payload.type !== 'mfa_pending') {
      return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
    }

    const dbUser = await findUserById(payload.sub);
    if (!dbUser) {
      return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
    }

    let mfaTenantId: string | undefined;
    let mfaRole: string | undefined;

    if (payload.tenantId) {
      const membership = await findTenantMembership(dbUser.id, payload.tenantId);
      if (membership) {
        mfaTenantId = membership.tenantId;
        mfaRole = membership.role;
      }
    } else {
      const ctx = await resolveUserTenantContext(dbUser.id);
      if (ctx) {
        mfaTenantId = ctx.tenantId;
        mfaRole = ctx.role;
      }
    }

    const mfaPerms =
      mfaTenantId && mfaRole ? await resolveStudioPermissions(mfaTenantId, dbUser.id, mfaRole) : [];
    return {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      tenantId: mfaTenantId,
      role: mfaRole,
      permissions: mfaPerms,
    };
  } catch {
    return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
  }
}
