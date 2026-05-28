/**
 * Auth Repository
 *
 * MongoDB auth operations for Studio app.
 *
 * Used by: services/auth-service.ts, lib/auth.ts
 */

import { ensureDb } from '@/lib/ensure-db';

const ACTIVE_TENANT_STATUS = 'active';
const ACTIVE_TENANT_MEMBER_STATUS = 'active';
const LOCKED_TENANT_MEMBER_STATUS = 'locked';

function buildTenantMemberStatusFilter(statuses: string[]): Record<string, unknown> {
  const normalized = [...new Set(statuses)];
  const includesActive = normalized.includes(ACTIVE_TENANT_MEMBER_STATUS);
  const explicitStatuses = normalized.filter((status) => status !== ACTIVE_TENANT_MEMBER_STATUS);
  const clauses: Record<string, unknown>[] = [];

  if (includesActive) {
    clauses.push({ status: ACTIVE_TENANT_MEMBER_STATUS }, { status: { $exists: false } });
  }

  if (explicitStatuses.length > 0) {
    clauses.push({ status: { $in: explicitStatuses } });
  }

  if (clauses.length === 0) {
    return { status: { $in: normalized } };
  }

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

async function updateUserTenantMembershipStatuses(
  userId: string,
  fromStatuses: string[],
  nextStatus: string,
): Promise<number> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const result = await TenantMember.updateMany(
    {
      userId,
      ...buildTenantMemberStatusFilter(fromStatuses),
    },
    {
      $set: { status: nextStatus },
    },
  );
  return result.modifiedCount || 0;
}

// =============================================================================
// USER OPERATIONS
// =============================================================================

/**
 * Find user by ID.
 * Auth-internal: userId comes from verified JWT, not user input.
 */
export async function findUserById(id: string): Promise<any | null> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const doc = await User.findOne({ _id: id }).lean();
  return doc ? normalizeUser(doc) : null;
}

/**
 * Find user by email (case-insensitive, trimmed)
 */
export async function findUserByEmail(email: string): Promise<any | null> {
  await ensureDb();
  const normalized = email.toLowerCase().trim();
  const { User } = await import('@agent-platform/database/models');
  const doc = await User.findOne({ email: normalized }).lean();
  return doc ? normalizeUser(doc) : null;
}

/**
 * Find user by Google ID
 */
export async function findUserByGoogleId(googleId: string): Promise<any | null> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const doc = await User.findOne({ googleId }).lean();
  return doc ? normalizeUser(doc) : null;
}

/**
 * Create a new user
 */
export async function createUser(data: {
  email: string;
  name?: string | null;
  passwordHash?: string | null;
  googleId?: string | null;
  avatarUrl?: string | null;
  emailVerified?: boolean;
  authProvider?: string | null;
}): Promise<any> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const doc = await User.create({
    email: data.email.toLowerCase().trim(),
    name: data.name ?? null,
    passwordHash: data.passwordHash ?? null,
    googleId: data.googleId ?? null,
    avatarUrl: data.avatarUrl ?? null,
    emailVerified: data.emailVerified ?? false,
    authProvider: data.authProvider ?? null,
  });
  return normalizeUser(doc.toObject());
}

/**
 * Update user by ID
 */
export async function updateUser(
  id: string,
  data: {
    name?: string | null;
    avatarUrl?: string | null;
    emailVerified?: boolean;
    lastLoginAt?: Date;
    googleId?: string | null;
    passwordHash?: string | null;
  },
): Promise<any> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await User.findOne({ _id: id });
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) doc.set(key, value);
  }
  await doc.save();
  return normalizeUser(doc.toObject());
}

export async function findUserLastActiveTenantId(userId: string): Promise<string | null> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const doc = await User.findOne({ _id: userId }).select('lastActiveTenantId').lean();
  return typeof doc?.lastActiveTenantId === 'string' ? doc.lastActiveTenantId : null;
}

export async function updateUserLastActiveTenantId(
  userId: string,
  tenantId: string | null,
): Promise<void> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        lastActiveTenantId: tenantId,
      },
    },
  );
}

// =============================================================================
// ACCOUNT LOCKOUT OPERATIONS
// =============================================================================

/**
 * Atomically increment failed login attempts and lock the account if the
 * threshold is reached — all in a single findOneAndUpdate to prevent
 * burst-bypass race conditions.
 *
 * Returns `{ failedCount, locked }` so the caller knows what happened.
 */
export async function incrementFailedLoginAttempts(
  userId: string,
  maxFailedAttempts?: number,
  lockDurationMs?: number,
): Promise<{ failedCount: number; locked: boolean }> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');

  // Step 1: Atomically increment the counter
  const doc = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { failedLoginAttempts: 1 } },
    { new: true, projection: { failedLoginAttempts: 1 } },
  ).lean();
  const failedCount = doc?.failedLoginAttempts ?? 1;

  // Step 2: If threshold is reached, atomically lock only if counter still matches
  // (prevents double-lock from concurrent requests that both crossed the threshold)
  if (maxFailedAttempts && lockDurationMs && failedCount >= maxFailedAttempts) {
    const lockedUntil = new Date(Date.now() + lockDurationMs);
    await User.updateOne(
      { _id: userId, failedLoginAttempts: { $gte: maxFailedAttempts } },
      { $set: { loginLockedUntil: lockedUntil } },
    );
    await Promise.all([
      updateUserTenantMembershipStatuses(
        userId,
        [ACTIVE_TENANT_MEMBER_STATUS],
        LOCKED_TENANT_MEMBER_STATUS,
      ),
      revokeUserRefreshTokens(userId),
    ]);
    return { failedCount, locked: true };
  }

  return { failedCount, locked: false };
}

/**
 * Lock a user account for a given duration.
 */
export async function lockUserAccount(userId: string, lockDurationMs: number): Promise<void> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const lockedUntil = new Date(Date.now() + lockDurationMs);
  await Promise.all([
    User.updateOne({ _id: userId }, { $set: { loginLockedUntil: lockedUntil } }),
    updateUserTenantMembershipStatuses(
      userId,
      [ACTIVE_TENANT_MEMBER_STATUS],
      LOCKED_TENANT_MEMBER_STATUS,
    ),
    revokeUserRefreshTokens(userId),
  ]);
}

/**
 * Reset failed login attempts and optionally restore memberships locked by a
 * prior account-lockout event.
 */
export async function resetFailedLoginAttempts(
  userId: string,
  options?: { restoreLockedMemberships?: 'whenExpired' | 'always' },
): Promise<void> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const user = await User.findOne({ _id: userId }).select('loginLockedUntil').lean();
  await User.updateOne(
    { _id: userId },
    { $set: { failedLoginAttempts: 0, loginLockedUntil: null } },
  );

  const shouldRestoreLockedMemberships =
    options?.restoreLockedMemberships === 'always' ||
    (user?.loginLockedUntil && new Date(user.loginLockedUntil) <= new Date());

  if (shouldRestoreLockedMemberships) {
    await updateUserTenantMembershipStatuses(
      userId,
      [LOCKED_TENANT_MEMBER_STATUS],
      ACTIVE_TENANT_MEMBER_STATUS,
    );
  }
}

// =============================================================================
// PASSWORD HISTORY OPERATIONS
// =============================================================================

/**
 * Push a password hash to the user's password history (capped array).
 * Uses atomic $push with $slice to keep only the last N entries.
 */
export async function pushPasswordHistory(
  userId: string,
  hash: string,
  maxEntries: number,
): Promise<void> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  await User.updateOne(
    { _id: userId },
    {
      $push: {
        passwordHistory: {
          $each: [{ hash, changedAt: new Date() }],
          $slice: -maxEntries,
        },
      },
    },
  );
}

// =============================================================================
// REFRESH TOKEN OPERATIONS
// =============================================================================

/**
 * Create a refresh token with optional lineage fields for rotation tracking.
 */
export async function createRefreshToken(data: {
  token: string;
  userId: string;
  expiresAt: Date;
  familyId?: string;
  generation?: number;
  rotatedFromId?: string;
}): Promise<any> {
  await ensureDb();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const doc = await RefreshToken.create(data);
  return normalizeRefreshToken(doc.toObject());
}

/**
 * Find refresh token by token hash
 */
export async function findRefreshToken(token: string): Promise<any | null> {
  await ensureDb();
  const { RefreshToken, User } = await import('@agent-platform/database/models');
  const doc = await RefreshToken.findOne({ token }).lean();
  if (!doc) return null;

  // Include user data via manual join — sanitize to avoid leaking passwordHash
  const user = await User.findOne({ _id: doc.userId }).lean();
  const result = normalizeRefreshToken(doc);
  if (user) result.user = sanitizeUserForResponse(normalizeUser(user));
  return result;
}

/**
 * Update refresh token by ID
 */
export async function updateRefreshToken(
  id: string,
  data: { revokedAt?: Date | null },
): Promise<any> {
  await ensureDb();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const doc = await RefreshToken.findOneAndUpdate(
    { _id: id },
    { $set: data },
    { new: true },
  ).lean();
  return doc ? normalizeRefreshToken(doc) : null;
}

/**
 * Atomically revoke a refresh token only if it has not been revoked yet.
 * Returns the updated document if the caller won the race, or null if
 * the token was already revoked (race-loss or replay).
 */
export async function rotateRefreshToken(
  id: string,
  data: { revokedAt: Date; rotatedToId?: string },
): Promise<any | null> {
  await ensureDb();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const doc = await RefreshToken.findOneAndUpdate(
    { _id: id, revokedAt: null },
    { $set: data },
    { new: true },
  ).lean();
  return doc ? normalizeRefreshToken(doc) : null;
}

/**
 * Find all refresh tokens in a family.
 * Returns all rows (active and revoked) for reuse detection and
 * grace-window analysis during race-loss handling.
 */
export async function findRefreshTokensByFamily(familyId: string): Promise<any[]> {
  await ensureDb();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const docs = await RefreshToken.find({ familyId }).lean();
  return docs.map(normalizeRefreshToken);
}

/**
 * Revoke all active refresh tokens in a family.
 * Used when replay/reuse attack is detected (generation delta > 1).
 */
export async function revokeRefreshTokenFamily(familyId: string): Promise<number> {
  await ensureDb();
  const now = new Date();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const result = await RefreshToken.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  return result.modifiedCount || 0;
}

/**
 * Revoke all active refresh tokens for a user
 */
export async function revokeUserRefreshTokens(userId: string): Promise<number> {
  await ensureDb();
  const now = new Date();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const result = await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  return result.modifiedCount || 0;
}

/**
 * Revoke a specific refresh token by token hash
 */
export async function revokeRefreshTokenByToken(token: string): Promise<number> {
  await ensureDb();
  const now = new Date();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const result = await RefreshToken.updateMany(
    { token, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  return result.modifiedCount || 0;
}

// =============================================================================
// EMAIL VERIFICATION TOKEN OPERATIONS
// =============================================================================

/**
 * Create an email verification token
 */
export async function createEmailVerificationToken(data: {
  token: string;
  userId: string;
  expiresAt: Date;
}): Promise<any> {
  await ensureDb();
  const { EmailVerificationToken } = await import('@agent-platform/database/models');
  const doc = await EmailVerificationToken.create(data);
  return normalizeToken(doc.toObject());
}

/**
 * Find email verification token by token hash
 */
export async function findEmailVerificationToken(token: string): Promise<any | null> {
  await ensureDb();
  const { EmailVerificationToken } = await import('@agent-platform/database/models');
  const doc = await EmailVerificationToken.findOne({ token }).lean();
  return doc ? normalizeToken(doc) : null;
}

/**
 * Delete email verification token by ID
 */
export async function deleteEmailVerificationToken(id: string): Promise<void> {
  await ensureDb();
  const { EmailVerificationToken } = await import('@agent-platform/database/models');
  await EmailVerificationToken.findOneAndDelete({ _id: id });
}

// =============================================================================
// PASSWORD RESET TOKEN OPERATIONS
// =============================================================================

/**
 * Create a password reset token
 */
export async function createPasswordResetToken(data: {
  token: string;
  userId: string;
  expiresAt: Date;
}): Promise<any> {
  await ensureDb();
  const { PasswordResetToken } = await import('@agent-platform/database/models');
  const doc = await PasswordResetToken.create(data);
  return normalizeToken(doc.toObject());
}

/**
 * Find password reset token by token hash
 */
export async function findPasswordResetToken(token: string): Promise<any | null> {
  await ensureDb();
  const { PasswordResetToken } = await import('@agent-platform/database/models');
  const doc = await PasswordResetToken.findOne({ token }).lean();
  return doc ? normalizeToken(doc) : null;
}

/**
 * Delete password reset token by ID
 */
export async function deletePasswordResetToken(id: string): Promise<void> {
  await ensureDb();
  const { PasswordResetToken } = await import('@agent-platform/database/models');
  await PasswordResetToken.findOneAndDelete({ _id: id });
}

// Device auth repo functions removed — Runtime owns device auth flow.

// =============================================================================
// TENANT MEMBERSHIP OPERATIONS
// =============================================================================

/**
 * Join tenant memberships only against active tenants so auth flows never
 * resolve archived or suspended workspace context.
 */
async function attachActiveTenantsToMemberships(memberships: any[]): Promise<any[]> {
  if (memberships.length === 0) {
    return [];
  }

  const { Tenant } = await import('@agent-platform/database/models');
  const tenantIds = [...new Set(memberships.map((doc: any) => String(doc.tenantId)))];
  const tenants = await Tenant.find({
    _id: { $in: tenantIds },
    status: ACTIVE_TENANT_STATUS,
  }).lean();
  const tenantMap = new Map(
    tenants.map((tenant: any) => [String(tenant._id), normalizeTenant(tenant)]),
  );

  return memberships.flatMap((doc: any) => {
    const tenant = tenantMap.get(String(doc.tenantId));
    if (!tenant) {
      return [];
    }

    return [{ ...normalizeTenantMember(doc), tenant }];
  });
}

/**
 * Find an active tenant membership for a user in a specific active tenant.
 */
export async function findTenantMembership(userId: string, tenantId: string): Promise<any | null> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const doc = await TenantMember.findOne({
    userId,
    tenantId,
    ...buildTenantMemberStatusFilter([ACTIVE_TENANT_MEMBER_STATUS]),
  }).lean();
  if (!doc) {
    return null;
  }

  const [membership] = await attachActiveTenantsToMemberships([doc]);
  return membership ?? null;
}

/**
 * Find the first (oldest) active tenant membership for a user.
 */
export async function findDefaultTenantMembership(userId: string): Promise<any | null> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const docs = await TenantMember.find({
    userId,
    ...buildTenantMemberStatusFilter([ACTIVE_TENANT_MEMBER_STATUS]),
  })
    .sort({ createdAt: 1 })
    .lean();

  const [membership] = await attachActiveTenantsToMemberships(docs);
  return membership ?? null;
}

/**
 * Find all active tenant memberships for a user across active tenants.
 */
export async function findUserTenantMemberships(userId: string): Promise<any[]> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const docs = await TenantMember.find({
    userId,
    ...buildTenantMemberStatusFilter([ACTIVE_TENANT_MEMBER_STATUS]),
  })
    .sort({ createdAt: 1 })
    .lean();

  return attachActiveTenantsToMemberships(docs);
}

export async function hasInactiveTenantMemberships(userId: string): Promise<boolean> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const doc = await TenantMember.findOne({
    userId,
    status: { $exists: true, $ne: ACTIVE_TENANT_MEMBER_STATUS },
  })
    .select({ _id: 1 })
    .lean();

  return Boolean(doc);
}

// =============================================================================
// WORKSPACE INVITATION OPERATIONS
// =============================================================================

/**
 * Count pending workspace invitations for an email
 */
export async function countPendingInvitations(email: string): Promise<number> {
  await ensureDb();
  const normalized = email.toLowerCase().trim();
  const now = new Date();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  return WorkspaceInvitation.countDocuments({
    email: normalized,
    status: 'pending',
    expiresAt: { $gt: now },
  });
}

/**
 * Find pending workspace invitations for an email (with tenant info).
 * Used by auto-accept logic during auth callbacks.
 */
export async function findPendingInvitationsForEmail(email: string): Promise<any[]> {
  await ensureDb();
  const normalized = email.toLowerCase().trim();
  const now = new Date();
  const { WorkspaceInvitation, Tenant, User } = await import('@agent-platform/database/models');
  const docs = await WorkspaceInvitation.find({
    email: normalized,
    status: 'pending',
    expiresAt: { $gt: now },
  }).lean();

  if (docs.length === 0) return [];

  // Batch-fetch tenants and inviters
  const tenantIds = docs.map((d: any) => d.tenantId);
  const inviterIds = docs
    .map((d: any) => d.invitedBy)
    .filter((id: any): id is string => id !== null);
  const [tenants, inviters] = await Promise.all([
    Tenant.find({ _id: { $in: tenantIds } })
      .select('name')
      .lean(),
    inviterIds.length > 0
      ? User.find({ _id: { $in: inviterIds } })
          .select('name email')
          .lean()
      : [],
  ]);
  const tenantMap = new Map<string, { name: string }>(
    tenants.map((t: any) => [String(t._id), { name: t.name }]),
  );
  const inviterMap = new Map<string, { name: string; email: string }>(
    inviters.map((u: any) => [String(u._id), { name: u.name, email: u.email }]),
  );

  return docs.map((doc: any) => ({
    id: String(doc._id),
    tenantId: String(doc.tenantId),
    email: doc.email,
    role: doc.role,
    status: doc.status,
    expiresAt: doc.expiresAt,
    workspaceName: tenantMap.get(String(doc.tenantId))?.name || 'Unknown',
    inviterName: doc.invitedBy
      ? inviterMap.get(String(doc.invitedBy))?.name ||
        inviterMap.get(String(doc.invitedBy))?.email ||
        null
      : null,
  }));
}

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

/**
 * Normalize MongoDB user document
 */
function normalizeUser(doc: any): any {
  if (!doc) return doc;
  const result = { ...doc };
  if (result._id && !result.id) result.id = String(result._id);
  delete result._id;
  delete result.__v;
  if (!result.id) {
    return null;
  }
  return result;
}

/**
 * Strip sensitive fields from a normalized user object before returning
 * it in API responses. Internal auth checks (password verification, lockout)
 * should use the raw normalizeUser result instead.
 */
export function sanitizeUserForResponse(user: any): any {
  if (!user) return user;
  const obj = typeof user.toObject === 'function' ? user.toObject() : user;
  const { passwordHash, passwordHistory, failedLoginAttempts, loginLockedUntil, ...safe } = obj;
  return safe;
}

/**
 * Normalize refresh token document
 */
function normalizeRefreshToken(doc: any): any {
  if (!doc) return doc;
  const result = { ...doc };
  if (result._id && !result.id) result.id = String(result._id);
  if (result.userId) result.userId = String(result.userId);
  delete result._id;
  delete result.__v;
  return result;
}

/**
 * Normalize generic token document (email verification, password reset)
 */
function normalizeToken(doc: any): any {
  if (!doc) return doc;
  const result = { ...doc };
  if (result._id && !result.id) result.id = String(result._id);
  if (result.userId) result.userId = String(result.userId);
  delete result._id;
  delete result.__v;
  return result;
}

/**
 * Normalize tenant member document
 */
function normalizeTenantMember(doc: any): any {
  if (!doc) return doc;
  const result = { ...doc };
  if (result._id && !result.id) result.id = String(result._id);
  if (result.userId) result.userId = String(result.userId);
  if (result.tenantId) result.tenantId = String(result.tenantId);
  delete result._id;
  delete result.__v;
  return result;
}

/**
 * Normalize tenant document
 */
function normalizeTenant(doc: any): any {
  if (!doc) return doc;
  const result = { ...doc };
  if (result._id && !result.id) result.id = String(result._id);
  if (result.organizationId) result.organizationId = String(result.organizationId);
  delete result._id;
  delete result.__v;
  return result;
}
