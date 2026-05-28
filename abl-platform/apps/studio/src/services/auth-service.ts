/**
 * Authentication Service
 *
 * Handles JWT token creation/validation and OAuth logic.
 */

import 'server-only';
import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { signPlatformAccessToken, verifyPlatformAccessToken } from '@agent-platform/shared-auth';
import { hashToken } from '@/lib/token-hash';
import {
  findUserById,
  findUserByEmail,
  findUserByGoogleId,
  createUser,
  updateUser,
  createRefreshToken as createRefreshTokenRepo,
  findRefreshToken,
  rotateRefreshToken,
  findRefreshTokensByFamily,
  revokeRefreshTokenFamily,
  revokeUserRefreshTokens,
  revokeRefreshTokenByToken,
  findTenantMembership,
  findDefaultTenantMembership,
  findUserTenantMemberships,
  findUserLastActiveTenantId,
  hasInactiveTenantMemberships,
  countPendingInvitations,
  findPendingInvitationsForEmail,
  updateUserLastActiveTenantId,
} from '@/repos/auth-repo';
import { acceptInvitationById } from '@/services/invitation-service';
import { logWorkspaceInvitationAcceptanceAudit } from '@/services/audit-service';
import { checkIsSuperAdmin } from '@/lib/super-admin';
import { isPlatformAdminUser, canUserCreateWorkspace } from '@/lib/platform-auth-policy';
import { assertNotReservedPrincipal } from '@agent-platform/shared-auth-profile/reserved-principals';

/**
 * Wraps createUser so every newly minted real-user record passes the RP-1
 * reserved-principal guard. Today User._id is mongoose-generated (UUIDv7) so
 * the assertion is a no-op; if a future change ever lets callers supply ids,
 * this is the single layer that prevents `userId='__tenant__'` from
 * colliding with the workspace OAuth synthetic principal.
 */
async function createRealUser(
  data: Parameters<typeof createUser>[0],
): Promise<Awaited<ReturnType<typeof createUser>>> {
  const user = await createUser(data);
  assertNotReservedPrincipal(user.id);
  return user;
}

/** Random per-instance dev secret — sessions will not persist across restarts. */
const log = createLogger('auth-service');
const devSecret = crypto.randomBytes(64).toString('hex');

/**
 * Grace window (ms) for concurrent refresh token rotation.
 * When two requests race to rotate the same token, the loser can reuse the
 * winner's refresh token if it was minted within this window.
 * Override via AUTH_REFRESH_GRACE_WINDOW_MS env var. Default: 10 seconds.
 */
const GRACE_WINDOW_MS = (() => {
  const envValue = process.env.AUTH_REFRESH_GRACE_WINDOW_MS;
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 10_000;
})();

const MAX_REFRESH_TOKEN_GENERATION_RETRIES = 5;

import { getConfig as getStudioConfig, isConfigLoaded as isStudioConfigLoaded } from '@/config';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

const INACTIVE_TENANT_MEMBERSHIP_MESSAGE = 'Workspace membership is not active';

/** Get config — uses centralized config when loaded, falls back to env vars */
function getConfig() {
  if (isStudioConfigLoaded()) {
    const cfg = getStudioConfig();
    return {
      auth: {
        jwtSecret: cfg.jwt.secret,
        jwtAccessExpiry: cfg.jwt.accessExpiry || '15m',
        jwtRefreshExpiry: cfg.jwt.refreshExpiry || '7d',
      },
      server: {
        frontendUrl: cfg.server.frontendUrl || 'http://localhost:5173',
      },
    };
  }
  return {
    auth: {
      jwtSecret: (() => {
        const secret = process.env.JWT_SECRET;
        if (!secret && process.env.NODE_ENV === 'production') {
          throw new AppError('JWT_SECRET is required in production', {
            ...ErrorCodes.SERVICE_UNAVAILABLE,
          });
        }
        return (
          secret ||
          (() => {
            console.warn(
              '[Auth] WARNING: Using random JWT secret. Sessions will not persist across restarts.',
            );
            return devSecret;
          })()
        );
      })(),
      jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '30m',
      jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
    },
    server: {
      frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
    },
  };
}
/** Minimal User shape used by auth functions */
interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  passwordHash: string | null;
  googleId: string | null;
  emailVerified: boolean;
  authProvider: string | null;
  lastLoginAt: Date | null;
}

// =============================================================================
// CONFIGURATION HELPERS
// =============================================================================

/**
 * Get JWT configuration from centralized config
 */
function getJWTConfig() {
  const config = getConfig();
  return {
    secret: config.auth.jwtSecret,
    accessExpiry: config.auth.jwtAccessExpiry,
    refreshExpiry: config.auth.jwtRefreshExpiry,
  };
}

/**
 * Get auth-specific config (token TTLs, lockout, MFA, etc.)
 */
function getAuthConfig() {
  if (isStudioConfigLoaded()) {
    return getStudioConfig().auth;
  }
  // Fallback: return defaults matching AuthConfigSchema
  return {
    mfa: { partialTokenTtlSeconds: 300, issuer: 'KorePlatform' },
    tokens: {
      sdkSessionTtlSeconds: 14400,
      deviceAuthTtlMs: 15 * 60 * 1000,
      refreshCookieMaxAgeSeconds: 7 * 24 * 60 * 60,
      mfaCookieMaxAgeSeconds: 300,
    },
    lockout: { maxFailedAttempts: 5, lockDurationMs: 15 * 60 * 1000 },
    sso: { authCodeTtlSeconds: 60, oidcStateTtlSeconds: 600, samlAssertionTtlSeconds: 3600 },
    rateLimits: { login: { maxAttempts: 10, windowMs: 15 * 60 * 1000 } },
  };
}

// =============================================================================
// TYPES
// =============================================================================

export interface JWTPayload {
  sub: string; // User ID
  email: string;
  type: 'access' | 'refresh' | 'mfa_pending';
  tokenClass?: 'user';
  tenantId?: string; // Scoped to active tenant
  role?: string; // TenantMember role: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER
  orgId?: string; // Parent organization (if tenant belongs to one)
  isSuperAdmin?: boolean; // Platform super admin — no tenant context needed
  canCreateWorkspace?: boolean; // absent = true (backward compat)
  iat?: number;
  exp?: number;
}

export interface TenantContext {
  tenantId: string;
  role: string;
  orgId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface TokenPairWithAuditContext extends TokenPair {
  userId: string;
  tenantId: string | null;
}

export interface RefreshTokenAuditContext {
  userId: string;
  tenantId: string | null;
}

function getMembershipCreatedAtMs(membership: {
  createdAt?: Date | string | number | null;
}): number {
  if (membership.createdAt instanceof Date) {
    return membership.createdAt.getTime();
  }

  if (typeof membership.createdAt === 'string' || typeof membership.createdAt === 'number') {
    const parsed = new Date(membership.createdAt).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function pickPreferredTenantMembership<
  T extends {
    createdAt?: Date | string | number | null;
    tenant?: { organizationId?: string | null } | null;
  },
>(memberships: T[]): T | null {
  if (memberships.length === 0) {
    return null;
  }

  return [...memberships].sort((left, right) => {
    const rightOrgScore = right.tenant?.organizationId ? 1 : 0;
    const leftOrgScore = left.tenant?.organizationId ? 1 : 0;
    if (rightOrgScore !== leftOrgScore) {
      return rightOrgScore - leftOrgScore;
    }

    return getMembershipCreatedAtMs(right) - getMembershipCreatedAtMs(left);
  })[0]!;
}

async function pickLastActiveTenantMembership<
  T extends {
    tenantId: string;
  },
>(userId: string, memberships: T[]): Promise<T | null> {
  const lastActiveTenantId = await findUserLastActiveTenantId(userId);
  if (!lastActiveTenantId) {
    return null;
  }

  return memberships.find((membership) => membership.tenantId === lastActiveTenantId) ?? null;
}

async function persistLastActiveTenant(userId: string, tenantId: string): Promise<void> {
  try {
    await updateUserLastActiveTenantId(userId, tenantId);
  } catch (error) {
    log.warn('Failed to persist last active workspace', {
      userId,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// =============================================================================
// TENANT CONTEXT RESOLUTION
// =============================================================================

/**
 * Resolve a user's preferred active tenant membership and role.
 * Prefers the user's last active workspace when it is still available, then
 * organization-linked workspaces, then the most recently joined active
 * workspace. Falls back to the legacy default-membership lookup for safety.
 */
export async function resolveUserTenantContext(
  userId: string,
  options?: { platformAdminEmail?: string | null },
): Promise<TenantContext | null> {
  const memberships = await findUserTenantMemberships(userId);
  const membership =
    Array.isArray(memberships) && memberships.length > 0
      ? ((await pickLastActiveTenantMembership(userId, memberships)) ??
        pickPreferredTenantMembership(memberships))
      : await findDefaultTenantMembership(userId);

  if (!membership) {
    if (checkIsSuperAdmin(userId)) {
      return null;
    }
    if (
      options?.platformAdminEmail &&
      (await isPlatformAdminUser({ id: userId, email: options.platformAdminEmail }))
    ) {
      return null;
    }
    if (await hasInactiveTenantMemberships(userId)) {
      throw new AppError(INACTIVE_TENANT_MEMBERSHIP_MESSAGE, { ...ErrorCodes.FORBIDDEN });
    }
    return null;
  }

  return {
    tenantId: membership.tenantId,
    role: membership.role,
    orgId: membership.tenant?.organizationId ?? undefined,
  };
}

/**
 * Resolve user context with auto-accept for single pending invitations.
 *
 * Logic:
 * 1. If user already has a tenant membership → return it (no auto-accept)
 * 2. If exactly 1 pending invitation → auto-accept it, return the new membership
 * 3. If 2+ pending invitations → signal the frontend to show a picker
 * 4. If 0 invitations → user needs onboarding (create workspace)
 */
export async function resolveUserContextOrAutoAcceptInvite(
  userId: string,
  email: string,
): Promise<{
  tenantContext: TenantContext | null;
  pendingInvitationChoice: boolean;
}> {
  // 1. Check existing membership
  const existing = await resolveUserTenantContext(userId, { platformAdminEmail: email });
  if (existing) {
    return { tenantContext: existing, pendingInvitationChoice: false };
  }

  // 2. Check pending invitations
  const invitations = await findPendingInvitationsForEmail(email);

  if (invitations.length === 1) {
    // Auto-accept single invitation
    try {
      const result = await acceptInvitationById(invitations[0].id, userId, email);
      await logWorkspaceInvitationAcceptanceAudit({
        userId,
        tenantId: result.tenantId,
        role: result.role,
        membershipCreated: result.membershipCreated,
        invitationId: invitations[0].id,
        acceptMethod: 'auto',
      });

      // Re-resolve tenant context to get full orgId
      const tenantContext = await resolveUserTenantContext(userId, { platformAdminEmail: email });
      return {
        tenantContext: tenantContext || {
          tenantId: result.tenantId,
          role: result.role,
        },
        pendingInvitationChoice: false,
      };
    } catch (error) {
      // If auto-accept fails (expired, already accepted, etc.), fall through
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Auto-accept invitation failed', { error: message });
    }
  }

  if (invitations.length > 1) {
    // Multiple invitations — let user choose
    return { tenantContext: null, pendingInvitationChoice: true };
  }

  // 3. No invitations, no membership — needs onboarding
  return { tenantContext: null, pendingInvitationChoice: false };
}

// =============================================================================
// JWT FUNCTIONS
// =============================================================================

/**
 * Create an access token for a user.
 * When tenantContext is provided, tenantId, role and orgId are included in the JWT payload.
 */
export function createAccessToken(
  user: Pick<User, 'id' | 'email'>,
  tenantContext?: TenantContext | null,
  options?: { isSuperAdmin?: boolean; canCreateWorkspace?: boolean },
): string {
  const { secret, accessExpiry } = getJWTConfig();
  const isSuperAdmin = options?.isSuperAdmin ?? checkIsSuperAdmin(user.id);

  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    type: 'access',
    tokenClass: 'user',
    ...(tenantContext
      ? {
          tenantId: tenantContext.tenantId,
          role: tenantContext.role,
          orgId: tenantContext.orgId,
        }
      : {}),
    ...(isSuperAdmin ? { isSuperAdmin: true } : {}),
    ...(options?.canCreateWorkspace === false ? { canCreateWorkspace: false } : {}),
  };

  // Convert expiry string to seconds for JWT
  const expiresInSeconds = Math.floor(parseExpiry(accessExpiry) / 1000);

  return signPlatformAccessToken(payload as unknown as Record<string, unknown>, secret, {
    expiresIn: expiresInSeconds,
  });
}

/**
 * Create a partial (MFA pending) access token.
 * This token has a short TTL and can only be used for MFA verification.
 */
export function createPartialToken(user: Pick<User, 'id' | 'email'>): string {
  if (!user?.id || !user?.email) {
    throw new AppError('Invalid user data for partial token', { ...ErrorCodes.BAD_REQUEST });
  }

  const { secret } = getJWTConfig();

  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    type: 'mfa_pending',
  };

  const { mfa } = getAuthConfig();
  return signPlatformAccessToken(payload as unknown as Record<string, unknown>, secret, {
    expiresIn: mfa.partialTokenTtlSeconds,
  });
}

/** Optional lineage info for refresh token rotation tracking */
export interface RefreshTokenLineage {
  familyId: string;
  generation: number;
  rotatedFromId?: string;
}

/** Result of creating a refresh token, including lineage metadata */
export interface CreatedRefreshToken {
  token: string;
  id: string;
  familyId: string;
  generation: number;
}

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

function getMaxFamilyGeneration(rows: Array<{ generation?: unknown }>, floor: number): number {
  return rows.reduce((max, row) => {
    const generation = typeof row.generation === 'number' ? row.generation : 1;
    return Math.max(max, generation);
  }, floor);
}

/**
 * Create a refresh token and store in database.
 * When lineage is provided, the token is part of an existing rotation chain.
 * When omitted, a new family is started with a fresh familyId and generation 1.
 */
export async function createRefreshToken(
  userId: string,
  lineage?: RefreshTokenLineage,
): Promise<CreatedRefreshToken> {
  const { refreshExpiry } = getJWTConfig();
  const token = crypto.randomBytes(64).toString('hex');
  const hashedToken = hashToken(token);

  // Parse expiry (e.g., '7d' -> 7 days)
  const expiryMs = parseExpiry(refreshExpiry);
  const expiresAt = new Date(Date.now() + expiryMs);

  const familyId = lineage?.familyId ?? crypto.randomUUID();
  const generation = lineage?.generation ?? 1;

  const created = await createRefreshTokenRepo({
    token: hashedToken,
    userId,
    expiresAt,
    familyId,
    generation,
    ...(lineage?.rotatedFromId ? { rotatedFromId: lineage.rotatedFromId } : {}),
  });

  return { token, id: created.id, familyId, generation };
}

/**
 * Create both access and refresh tokens.
 * When tenantContext is provided, tenantId, role and orgId are included in the access token.
 */
export async function createTokenPair(
  user: Pick<User, 'id' | 'email'>,
  tenantContext?: TenantContext | null,
): Promise<TokenPair> {
  const { accessExpiry } = getJWTConfig();
  const isSuperAdmin = await isPlatformAdminUser(user);
  const canCreate = isSuperAdmin || (await canUserCreateWorkspace(user.email));
  const accessToken = createAccessToken(user, tenantContext, {
    isSuperAdmin,
    canCreateWorkspace: canCreate,
  });
  const created = await createRefreshToken(user.id);

  // Parse access token expiry for response
  const expiryMs = parseExpiry(accessExpiry);
  const expiresIn = Math.floor(expiryMs / 1000);

  return {
    accessToken,
    refreshToken: created.token,
    expiresIn,
  };
}

/**
 * Build a TokenPair from a pre-minted raw refresh token string.
 * Used by the rotation path where the refresh token is created separately
 * with specific lineage parameters.
 */
async function buildTokenPair(
  user: Pick<User, 'id' | 'email'>,
  tenantContext: TenantContext | null,
  rawRefreshToken: string,
): Promise<TokenPairWithAuditContext> {
  const { accessExpiry } = getJWTConfig();
  const isSuperAdmin = await isPlatformAdminUser(user);
  const canCreate = isSuperAdmin || (await canUserCreateWorkspace(user.email));
  const accessToken = createAccessToken(user, tenantContext, {
    isSuperAdmin,
    canCreateWorkspace: canCreate,
  });
  const expiryMs = parseExpiry(accessExpiry);
  const expiresIn = Math.floor(expiryMs / 1000);
  return {
    accessToken,
    refreshToken: rawRefreshToken,
    expiresIn,
    userId: user.id,
    tenantId: tenantContext?.tenantId ?? null,
  };
}

/**
 * Verify and decode an access token
 */
export function verifyAccessToken(token: string): JWTPayload | null {
  const { secret } = getJWTConfig();
  try {
    const payload = verifyPlatformAccessToken(token, secret) as unknown as JWTPayload;
    if (payload.type !== 'access') {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Refresh tokens using a valid refresh token
 * Implements token rotation for security
 */
function toTenantContext(membership: {
  tenantId: string;
  role: string;
  tenant?: { organizationId?: string | null } | null;
}): TenantContext {
  return {
    tenantId: membership.tenantId,
    role: membership.role,
    orgId: membership.tenant?.organizationId ?? undefined,
  };
}

export async function refreshTokens(
  oldRefreshToken: string,
  requestedTenantId?: string,
): Promise<TokenPairWithAuditContext | null> {
  const hashedToken = hashToken(oldRefreshToken);
  const tokenRecord = await findRefreshToken(hashedToken);

  // Token doesn't exist
  if (!tokenRecord) {
    return null;
  }

  // Token expired
  if (tokenRecord.expiresAt < new Date()) {
    return null;
  }

  const familyId = tokenRecord.familyId ?? crypto.randomUUID();
  const presentedGen = tokenRecord.generation ?? 1;

  // Token already revoked — enter race-loss / replay detection path
  if (tokenRecord.revokedAt) {
    return handleRaceLossOrReplay(tokenRecord, familyId, presentedGen, requestedTenantId);
  }

  // Attempt to atomically claim the rotation of this specific token id.
  const rotated = await rotateRefreshToken(tokenRecord.id, { revokedAt: new Date() });

  if (rotated) {
    // Winner path: we claimed the rotation. Mint a new pair with lineage.
    const tenantContext = await resolveTenantContextForRefresh(
      tokenRecord.userId,
      requestedTenantId,
    );
    if (tenantContext === 'inactive') {
      return null;
    }

    const created = await createRefreshToken(tokenRecord.userId, {
      familyId,
      generation: presentedGen + 1,
      rotatedFromId: tokenRecord.id,
    });

    return buildTokenPair(tokenRecord.user, tenantContext, created.token);
  }

  // Race-loss: another request already rotated this token concurrently
  return handleRaceLossOrReplay(tokenRecord, familyId, presentedGen, requestedTenantId);
}

/**
 * Handle race-loss or replay of a revoked token.
 *
 * Inspects the token family to decide between:
 * 1. Genuine reuse attack (presented gen >1 behind family max) → revoke family
 * 2. No recent child within grace window → revoke family
 * 3. Legitimate race-loss / network-retry → mint sibling at maxGeneration + 1
 */
async function handleRaceLossOrReplay(
  tokenRecord: any,
  familyId: string,
  presentedGen: number,
  requestedTenantId?: string,
): Promise<TokenPairWithAuditContext | null> {
  // No family tracking (pre-migration token) — fall back to legacy behavior
  if (!tokenRecord.familyId) {
    await revokeUserRefreshTokens(tokenRecord.userId);
    return null;
  }

  const family = await findRefreshTokensByFamily(familyId);
  const maxGeneration = family.reduce(
    (max: number, row: any) => Math.max(max, row.generation ?? 1),
    presentedGen,
  );
  const graceCutoff = Date.now() - GRACE_WINDOW_MS;
  const hasRecentChild = family.some(
    (row: any) =>
      (row.generation ?? 1) > presentedGen && new Date(row.createdAt).getTime() >= graceCutoff,
  );

  // Genuine reuse: presented generation is more than 1 behind family head.
  // An attacker replaying a long-stolen token lands here.
  if (presentedGen < maxGeneration - 1) {
    log.warn('Token reuse attack detected — revoking family', {
      familyId,
      presentedGen,
      maxGeneration,
      delta: maxGeneration - presentedGen,
    });
    await revokeRefreshTokenFamily(familyId);
    return null;
  }

  // No recent child and presented token is revoked outside grace window:
  // also treat as reuse.
  if (!hasRecentChild) {
    log.warn('Revoked token replay outside grace window — revoking family', {
      familyId,
      presentedGen,
      maxGeneration,
    });
    await revokeRefreshTokenFamily(familyId);
    return null;
  }

  // Legitimate race-loss or network-retry replay within grace window.
  // Mint a sibling refresh token at maxGeneration + 1.
  const tenantContext = await resolveTenantContextForRefresh(tokenRecord.userId, requestedTenantId);
  if (tenantContext === 'inactive') {
    return null;
  }

  const sibling = await mintSiblingRefreshToken({
    userId: tokenRecord.userId,
    familyId,
    initialGeneration: maxGeneration + 1,
    rotatedFromId: tokenRecord.id,
  });

  log.info('Race-loss resolved — minted sibling refresh token', {
    familyId,
    siblingGeneration: sibling.generation,
  });

  return buildTokenPair(tokenRecord.user, tenantContext, sibling.token);
}

async function mintSiblingRefreshToken(params: {
  userId: string;
  familyId: string;
  initialGeneration: number;
  rotatedFromId: string;
}): Promise<CreatedRefreshToken> {
  let nextGeneration = params.initialGeneration;

  for (let attempt = 0; attempt < MAX_REFRESH_TOKEN_GENERATION_RETRIES; attempt += 1) {
    try {
      return await createRefreshToken(params.userId, {
        familyId: params.familyId,
        generation: nextGeneration,
        rotatedFromId: params.rotatedFromId,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error) || attempt >= MAX_REFRESH_TOKEN_GENERATION_RETRIES - 1) {
        throw error;
      }

      const family = await findRefreshTokensByFamily(params.familyId);
      nextGeneration = getMaxFamilyGeneration(family, nextGeneration) + 1;

      log.warn('Refresh token generation collision, retrying sibling mint', {
        familyId: params.familyId,
        attempt: attempt + 1,
        nextGeneration,
      });
    }
  }

  throw new AppError('Refresh token sibling mint failed after maximum retries', {
    ...ErrorCodes.INTERNAL_ERROR,
  });
}

/**
 * Resolve tenant context for a refresh operation.
 * Returns 'inactive' if the user only has inactive memberships.
 */
async function resolveTenantContextForRefresh(
  userId: string,
  requestedTenantId?: string,
): Promise<TenantContext | null | 'inactive'> {
  try {
    if (requestedTenantId) {
      const requestedMembership = await findTenantMembership(userId, requestedTenantId);
      if (requestedMembership?.tenant) {
        return toTenantContext(requestedMembership);
      }
    }

    return await resolveUserTenantContext(userId);
  } catch (error) {
    if (error instanceof AppError && error.message === INACTIVE_TENANT_MEMBERSHIP_MESSAGE) {
      return 'inactive';
    }
    throw error;
  }
}

export async function getRefreshTokenAuditContext(
  token: string,
): Promise<RefreshTokenAuditContext | null> {
  const hashedToken = hashToken(token);
  const tokenRecord = await findRefreshToken(hashedToken);
  if (!tokenRecord) {
    return null;
  }

  try {
    const tenantContext = await resolveUserTenantContext(tokenRecord.userId);
    return {
      userId: tokenRecord.userId,
      tenantId: tenantContext?.tenantId ?? null,
    };
  } catch (error) {
    if (error instanceof AppError && error.message === INACTIVE_TENANT_MEMBERSHIP_MESSAGE) {
      return {
        userId: tokenRecord.userId,
        tenantId: null,
      };
    }
    throw error;
  }
}

/**
 * Revoke a refresh token
 */
export async function revokeRefreshToken(token: string): Promise<boolean> {
  const hashedToken = hashToken(token);
  const count = await revokeRefreshTokenByToken(hashedToken);
  return count > 0;
}

/**
 * Revoke all refresh tokens for a user
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await revokeUserRefreshTokens(userId);
}

// =============================================================================
// TENANT MANAGEMENT
// =============================================================================

/**
 * Get all active tenants a user belongs to.
 */
export async function getUserTenants(userId: string): Promise<
  Array<{
    tenantId: string;
    tenantName: string;
    role: string;
    orgId?: string;
  }>
> {
  const memberships = await findUserTenantMemberships(userId);

  return memberships
    .filter((membership) => membership.tenant)
    .map((membership) => ({
      tenantId: membership.tenantId,
      tenantName: membership.tenant.name,
      role: membership.role,
      orgId: membership.tenant.organizationId ?? undefined,
    }));
}

/**
 * Switch the user's active tenant. Validates active membership and issues a
 * new access token scoped to that active workspace.
 */
export async function switchTenant(
  user: Pick<User, 'id' | 'email'>,
  tenantId: string,
): Promise<{ accessToken: string; tenantContext: TenantContext }> {
  const membership = await findTenantMembership(user.id, tenantId);

  if (!membership?.tenant) {
    throw new AppError('Not a member of this tenant', { ...ErrorCodes.FORBIDDEN });
  }

  const tenantContext: TenantContext = {
    tenantId: membership.tenantId,
    role: membership.role,
    orgId: membership.tenant.organizationId ?? undefined,
  };

  await persistLastActiveTenant(user.id, membership.tenantId);

  const isSuperAdmin = await isPlatformAdminUser(user);
  const canCreate = isSuperAdmin || (await canUserCreateWorkspace(user.email));
  const accessToken = createAccessToken(user, tenantContext, {
    isSuperAdmin,
    canCreateWorkspace: canCreate,
  });
  return { accessToken, tenantContext };
}

// =============================================================================
// USER FUNCTIONS
// =============================================================================

/**
 * Find or create a user from Google OAuth data.
 * Security: does NOT auto-link Google to existing email/password accounts.
 * Users must link accounts explicitly from settings while logged in.
 */
export async function findOrCreateGoogleUser(
  profile: {
    googleId: string;
    email: string;
    name?: string;
    avatarUrl?: string;
  },
  options?: { requireExistingUser?: boolean },
): Promise<User> {
  const normalizedEmail = profile.email.toLowerCase().trim();

  // First check if a user with this googleId already exists
  const existingByGoogle = await findUserByGoogleId(profile.googleId);

  if (existingByGoogle) {
    return updateUser(existingByGoogle.id, {
      lastLoginAt: new Date(),
      name: profile.name || existingByGoogle.name,
      avatarUrl: profile.avatarUrl || existingByGoogle.avatarUrl,
      emailVerified: true,
    });
  }

  // Check if a user with this email exists
  const existingByEmail = await findUserByEmail(normalizedEmail);

  if (existingByEmail) {
    if (options?.requireExistingUser) {
      if (existingByEmail.googleId && existingByEmail.googleId !== profile.googleId) {
        throw new AppError('This email is already linked to a different Google account.', {
          ...ErrorCodes.CONFLICT,
        });
      }

      return updateUser(existingByEmail.id, {
        lastLoginAt: new Date(),
        name: profile.name || existingByEmail.name,
        avatarUrl: profile.avatarUrl || existingByEmail.avatarUrl,
        emailVerified: true,
      });
    }

    // Auto-link Google to existing account (including email/password users).
    // OAuth providers verify email ownership, so this is safe.
    if (existingByEmail.passwordHash) {
      log.info('Linking Google account to existing email/password user', {
        userId: existingByEmail.id,
        authProvider: existingByEmail.authProvider,
      });
    }

    return updateUser(existingByEmail.id, {
      googleId: profile.googleId,
      lastLoginAt: new Date(),
      name: profile.name || existingByEmail.name,
      avatarUrl: profile.avatarUrl || existingByEmail.avatarUrl,
      emailVerified: true,
    });
  }

  if (options?.requireExistingUser) {
    throw new AppError(
      'This Google account must already belong to a Studio user before it can access Admin.',
      { ...ErrorCodes.NOT_FOUND },
    );
  }

  // Create new user
  return createRealUser({
    googleId: profile.googleId,
    email: normalizedEmail,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    emailVerified: true,
    authProvider: 'google',
  });
}

/**
 * Find or create a user from Microsoft OAuth data.
 * Security: does NOT auto-link Microsoft to existing email/password accounts.
 */
export async function findOrCreateMicrosoftUser(
  profile: {
    email: string;
    name?: string;
    avatarUrl?: string;
  },
  options?: { requireExistingUser?: boolean },
): Promise<User> {
  const normalizedEmail = profile.email.toLowerCase().trim();

  const existing = await findUserByEmail(normalizedEmail);

  if (existing) {
    if (options?.requireExistingUser) {
      return updateUser(existing.id, {
        lastLoginAt: new Date(),
        name: profile.name || existing.name,
        avatarUrl: profile.avatarUrl || existing.avatarUrl,
        emailVerified: true,
      });
    }

    // Auto-link Microsoft to existing account (including email/password users).
    // OAuth providers verify email ownership, so this is safe.
    if (existing.passwordHash) {
      log.info('Linking Microsoft account to existing email/password user', {
        userId: existing.id,
        authProvider: existing.authProvider,
      });
    }

    return updateUser(existing.id, {
      lastLoginAt: new Date(),
      name: profile.name || existing.name,
      avatarUrl: profile.avatarUrl || existing.avatarUrl,
      emailVerified: true,
    });
  }

  if (options?.requireExistingUser) {
    throw new AppError(
      'This Microsoft account must already belong to a Studio user before it can access Admin.',
      { ...ErrorCodes.NOT_FOUND },
    );
  }

  return createRealUser({
    email: normalizedEmail,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    emailVerified: true,
    authProvider: 'microsoft',
  });
}

/**
 * Find or create a user from LinkedIn OAuth data.
 * Security: does NOT auto-link LinkedIn to existing email/password accounts.
 */
export async function findOrCreateLinkedInUser(profile: {
  email: string;
  name?: string;
  avatarUrl?: string;
}): Promise<User> {
  const normalizedEmail = profile.email.toLowerCase().trim();

  const existing = await findUserByEmail(normalizedEmail);

  if (existing) {
    // Auto-link LinkedIn to existing account (including email/password users).
    // OAuth providers verify email ownership, so this is safe.
    if (existing.passwordHash) {
      log.info('Linking LinkedIn account to existing email/password user', {
        userId: existing.id,
        authProvider: existing.authProvider,
      });
    }

    return updateUser(existing.id, {
      lastLoginAt: new Date(),
      name: profile.name || existing.name,
      avatarUrl: profile.avatarUrl || existing.avatarUrl,
      emailVerified: true,
    });
  }

  return createRealUser({
    email: normalizedEmail,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    emailVerified: true,
    authProvider: 'linkedin',
  });
}

/**
 * Get count of pending workspace invitations for an email.
 * Returns the count so the UI can prompt the user to accept/review them.
 * Does NOT auto-accept — user must explicitly accept via /api/invitations/accept.
 */
export async function getPendingInvitationCount(email: string): Promise<number> {
  const normalizedEmail = email.toLowerCase().trim();
  return countPendingInvitations(normalizedEmail);
}

/**
 * Get user by ID
 */
export async function getUserById(id: string): Promise<User | null> {
  return findUserById(id);
}

// Device auth functions removed — Runtime owns device auth flow.
// All /api/auth/device/* requests are proxied to Runtime via proxy.ts.

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Parse expiry string (e.g., '15m', '7d') to milliseconds
 */
function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 15 * 60 * 1000; // Default 15 minutes
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}
