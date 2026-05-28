/**
 * MFA Repository
 *
 * MongoDB repository for MFA operations.
 * MFA data is stored as an embedded subdocument on the User model.
 */

import { ensureDb } from '@/lib/ensure-db';

// ─── UserMFA ─────────────────────────────────────────────────────────────
// Auth-internal: all userId values come from verified JWT sessions, not user input.
// MFA operates on the User model via the authenticated userId.

/**
 * Find UserMFA record by userId, including recovery codes.
 */
export async function findUserMFA(userId: string): Promise<any | null> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const user = await User.findOne({ _id: userId }).select('mfa').lean();
  if (!user?.mfa) return null;
  return {
    id: userId,
    userId,
    verified: user.mfa.verified,
    encryptedSecret: user.mfa.encryptedSecret,
    enabledAt: user.mfa.enabledAt,
    lastUsedAt: user.mfa.lastUsedAt,
    failedAttempts: user.mfa.failedAttempts,
    lockedUntil: user.mfa.lockedUntil,
    recoveryCodes: user.mfa.recoveryCodes || [],
  };
}

/**
 * Upsert UserMFA record by userId.
 */
export async function upsertUserMFA(userId: string, data: any): Promise<any> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');

  // MongoDB cannot use dot-notation $set on a null parent field.
  // The User schema defaults `mfa` to null, so first-time MFA setup would fail with
  // "Cannot create field 'encryptedSecret' in element {mfa: null}".
  // Initialize `mfa` to {} atomically if it is currently null.
  await User.updateOne({ _id: userId, mfa: null }, { $set: { mfa: {} } });

  const mfaData: any = {};
  if (data.encryptedSecret !== undefined) mfaData['mfa.encryptedSecret'] = data.encryptedSecret;
  if (data.verified !== undefined) mfaData['mfa.verified'] = data.verified;
  if (data.enabledAt !== undefined) mfaData['mfa.enabledAt'] = data.enabledAt;
  if (data.lastUsedAt !== undefined) mfaData['mfa.lastUsedAt'] = data.lastUsedAt;
  if (data.failedAttempts !== undefined) mfaData['mfa.failedAttempts'] = data.failedAttempts;
  if (data.lockedUntil !== undefined) mfaData['mfa.lockedUntil'] = data.lockedUntil;

  const result = await User.findOneAndUpdate({ _id: userId }, { $set: mfaData }, { new: true })
    .select('mfa')
    .lean();
  if (!result?.mfa) return null;
  return { id: userId, userId, ...result.mfa };
}

/**
 * Update UserMFA record by userId.
 */
export async function updateUserMFA(userId: string, data: any): Promise<any> {
  await ensureDb();
  return upsertUserMFA(userId, data);
}

/**
 * Delete UserMFA record by userId.
 */
export async function deleteUserMFA(userId: string): Promise<any> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const result = await User.findOneAndUpdate(
    { _id: userId },
    { $unset: { mfa: 1 } },
    { new: true },
  ).lean();
  return result ? { id: userId, userId } : null;
}

// ─── RecoveryCode ────────────────────────────────────────────────────────

/**
 * Create multiple recovery codes (embedded in user.mfa.recoveryCodes).
 */
export async function createRecoveryCodes(data: any[]): Promise<any> {
  await ensureDb();
  if (data.length === 0) return { count: 0 };
  // All codes should have the same mfaId (userId)
  const userId = data[0].mfaId;
  const { User } = await import('@agent-platform/database/models');

  // Ensure mfa is not null before dot-notation $push (same guard as upsertUserMFA).
  await User.updateOne({ _id: userId, mfa: null }, { $set: { mfa: {} } });

  const codes = data.map((item) => ({
    codeHash: item.codeHash,
    createdAt: new Date(),
    usedAt: null,
  }));
  await User.findOneAndUpdate(
    { _id: userId },
    {
      $push: { 'mfa.recoveryCodes': { $each: codes } },
    },
  );
  return { count: codes.length };
}

/**
 * Delete all recovery codes for a given mfaId (userId).
 */
export async function deleteRecoveryCodes(mfaId: string): Promise<any> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  await User.findOneAndUpdate(
    { _id: mfaId },
    {
      $set: { 'mfa.recoveryCodes': [] },
    },
  );
  return { count: 0 };
}

/**
 * Find a recovery code by mfaId (userId) and codeHash.
 * Only returns unused codes (usedAt = null).
 */
export async function findRecoveryCode(mfaId: string, codeHash: string): Promise<any | null> {
  await ensureDb();
  const { User } = await import('@agent-platform/database/models');
  const user = await User.findOne({ _id: mfaId }).select('mfa.recoveryCodes').lean();
  if (!user?.mfa?.recoveryCodes) return null;
  const code = user.mfa.recoveryCodes.find(
    (rc: any) => rc.codeHash === codeHash && rc.usedAt == null,
  );
  if (!code) return null;
  return { id: `${mfaId}-${codeHash}`, mfaId, ...code };
}

/**
 * Mark a recovery code as used.
 */
export async function markRecoveryCodeUsed(id: string): Promise<any> {
  await ensureDb();
  // id format: "userId-codeHash"
  const [mfaId, ...hashParts] = id.split('-');
  const codeHash = hashParts.join('-');
  const { User } = await import('@agent-platform/database/models');
  await User.findOneAndUpdate(
    { _id: mfaId, 'mfa.recoveryCodes.codeHash': codeHash },
    { $set: { 'mfa.recoveryCodes.$.usedAt': new Date() } },
  );
  return { id, mfaId, codeHash, usedAt: new Date() };
}
