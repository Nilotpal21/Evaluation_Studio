/**
 * MFA Service (TOTP + Recovery Codes)
 *
 * - TOTP: RFC 6238, configurable digits/period/window via auth.mfa config
 * - Recovery codes: configurable count/length, bcrypt-hashed, single-use
 * - TOTP secret: Encrypted via EncryptionService before DB storage
 * - Lockout: configurable threshold and duration via auth.mfa config
 * All constants read from centralized config (auth.mfa.*).
 */

import crypto from 'crypto';
import {
  findUserMFA,
  upsertUserMFA,
  updateUserMFA,
  deleteUserMFA,
  createRecoveryCodes,
  deleteRecoveryCodes,
  markRecoveryCodeUsed,
} from '@/repos/mfa-repo';
import { findUserById } from '@/repos/auth-repo';
import { findTenantById } from '@/repos/workspace-repo';
import { findOrganizationById } from '@/repos/org-repo';
import { findSubscription } from '@/repos/compliance-repo';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { getConfig, isConfigLoaded } from '@/config';
import { MFA_RECOVERY_CHARS, BASE32_CHARS } from '@/lib/auth-constants';
import { decryptMFASecret, encryptMFASecret } from './mfa-encryption';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MFASetupResult {
  secret: string; // Base32 TOTP secret (for QR code)
  otpauthUrl: string; // otpauth:// URI for authenticator apps
  recoveryCodes: string[];
}

export interface MFAStatus {
  enabled: boolean;
  verified: boolean;
  recoveryCodesRemaining: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getMFAConfig() {
  if (!isConfigLoaded()) {
    // Fallback for early bootstrap / test environments
    return {
      totpWindow: 1,
      totpDigits: 6,
      totpPeriod: 30,
      recoveryCodeCount: 10,
      recoveryCodeLength: 8,
      recoveryCodeBcryptCost: 10,
      lockThreshold: 10,
      lockDurationMs: 30 * 60 * 1000,
      partialTokenTtlSeconds: 300,
      issuer: 'KorePlatform',
    };
  }
  return getConfig().auth.mfa;
}

// ---------------------------------------------------------------------------
// TOTP Helpers (RFC 6238 implementation)
// ---------------------------------------------------------------------------

function generateBase32Secret(length = 20): string {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    result += BASE32_CHARS[bytes[i] % 32];
  }
  return result;
}

function base32Decode(encoded: string): Buffer {
  const bits: number[] = [];
  for (const char of encoded.toUpperCase()) {
    const val = BASE32_CHARS.indexOf(char);
    if (val === -1) continue;
    for (let i = 4; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret: string, time?: number): string {
  const config = getMFAConfig();
  const now = time ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / config.totpPeriod);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(0, 0);
  counterBuffer.writeUInt32BE(counter, 4);

  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    Math.pow(10, config.totpDigits);

  return code.toString().padStart(config.totpDigits, '0');
}

function verifyTOTPCode(secret: string, code: string): boolean {
  const config = getMFAConfig();
  const now = Math.floor(Date.now() / 1000);
  for (let i = -config.totpWindow; i <= config.totpWindow; i++) {
    const expected = generateTOTP(secret, now + i * config.totpPeriod);
    if (timingSafeEqual(code, expected)) {
      return true;
    }
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Recovery Code Helpers
// ---------------------------------------------------------------------------

function generateRecoveryCode(): string {
  const config = getMFAConfig();
  let code = '';
  for (let i = 0; i < config.recoveryCodeLength; i++) {
    code += MFA_RECOVERY_CHARS[crypto.randomInt(MFA_RECOVERY_CHARS.length)];
  }
  return code;
}

async function hashRecoveryCode(code: string): Promise<string> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(code, getMFAConfig().recoveryCodeBcryptCost);
}

async function compareRecoveryCode(code: string, hash: string): Promise<boolean> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.compare(code, hash);
}

// ---------------------------------------------------------------------------
// MFA Service
// ---------------------------------------------------------------------------

/**
 * Set up MFA for a user. Returns the TOTP secret and recovery codes.
 * Setup is not complete until confirmSetup() is called with a valid code.
 */
export async function setupMFA(userId: string): Promise<MFASetupResult> {
  // Check if MFA already set up
  const existing = await findUserMFA(userId);
  if (existing?.verified) {
    throw new AppError('MFA is already enabled. Disable it first to reconfigure.', {
      ...ErrorCodes.BAD_REQUEST,
    });
  }

  // Generate TOTP secret
  const secret = generateBase32Secret();

  // Encrypt secret before storage
  const encryptedSecret = encryptMFASecret(secret, userId);

  // Generate recovery codes
  const mfaConfig = getMFAConfig();
  const recoveryCodes: string[] = [];
  const codeHashes: string[] = [];
  for (let i = 0; i < mfaConfig.recoveryCodeCount; i++) {
    const code = generateRecoveryCode();
    recoveryCodes.push(code);
    codeHashes.push(await hashRecoveryCode(code));
  }

  // Upsert MFA record
  const mfa = await upsertUserMFA(userId, {
    encryptedSecret,
    verified: false,
    failedAttempts: 0,
    lockedUntil: null,
  });

  // Delete old recovery codes and create new ones
  await deleteRecoveryCodes(mfa.id);
  await createRecoveryCodes(codeHashes.map((hash) => ({ mfaId: mfa.id, codeHash: hash })));

  // Build otpauth URL
  const otpauthUrl = `otpauth://totp/${mfaConfig.issuer}:${userId}?secret=${secret}&issuer=${encodeURIComponent(mfaConfig.issuer)}&digits=${mfaConfig.totpDigits}&period=${mfaConfig.totpPeriod}`;

  return { secret, otpauthUrl, recoveryCodes };
}

/**
 * Confirm MFA setup by verifying the first TOTP code.
 */
export async function confirmMFASetup(userId: string, code: string): Promise<boolean> {
  const mfa = await findUserMFA(userId);

  if (!mfa)
    throw new AppError('MFA not set up. Call setupMFA first.', { ...ErrorCodes.BAD_REQUEST });
  if (mfa.verified) throw new AppError('MFA already confirmed.', { ...ErrorCodes.BAD_REQUEST });

  const secret = decryptSecret(mfa.encryptedSecret, userId);
  if (!verifyTOTPCode(secret, code)) {
    return false;
  }

  await updateUserMFA(userId, {
    verified: true,
    enabledAt: new Date(),
  });

  return true;
}

/**
 * Verify a TOTP code for an authenticated user.
 */
export async function verifyMFACode(userId: string, code: string): Promise<boolean> {
  const mfa = await findUserMFA(userId);

  if (!mfa || !mfa.verified) return false;

  // Check lock
  if (mfa.lockedUntil && mfa.lockedUntil > new Date()) {
    throw new AppError('MFA temporarily locked due to too many failed attempts.', {
      ...ErrorCodes.FORBIDDEN,
    });
  }

  const secret = decryptSecret(mfa.encryptedSecret, userId);
  const valid = verifyTOTPCode(secret, code);

  if (valid) {
    await updateUserMFA(userId, {
      lastUsedAt: new Date(),
      failedAttempts: 0,
      lockedUntil: null,
    });
    return true;
  }

  // Record failure
  const mfaConfig = getMFAConfig();
  const failedAttempts = mfa.failedAttempts + 1;
  const updateData: any = { failedAttempts };

  if (failedAttempts >= mfaConfig.lockThreshold) {
    updateData.lockedUntil = new Date(Date.now() + mfaConfig.lockDurationMs);
  }

  await updateUserMFA(userId, updateData);
  return false;
}

/**
 * Verify a recovery code (single-use).
 */
export async function verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
  const mfa = await findUserMFA(userId);

  if (!mfa || !mfa.verified) return false;

  // Get unused recovery codes
  const recoveryCodes = mfa.recoveryCodes?.filter((rc: any) => !rc.usedAt) ?? [];

  for (const rc of recoveryCodes) {
    if (await compareRecoveryCode(code.toUpperCase(), rc.codeHash)) {
      // Mark as used (single-use)
      await markRecoveryCodeUsed(rc.id);
      // Reset failed attempts on successful recovery
      await updateUserMFA(userId, {
        failedAttempts: 0,
        lockedUntil: null,
        lastUsedAt: new Date(),
      });
      return true;
    }
  }

  return false;
}

/**
 * Regenerate recovery codes. Invalidates all existing codes.
 */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const mfa = await findUserMFA(userId);

  if (!mfa || !mfa.verified) {
    throw new AppError('MFA must be enabled to regenerate recovery codes.', {
      ...ErrorCodes.BAD_REQUEST,
    });
  }

  // Delete old codes
  await deleteRecoveryCodes(mfa.id);

  // Generate new codes
  const mfaConfig = getMFAConfig();
  const codes: string[] = [];
  const codeHashes: { mfaId: string; codeHash: string }[] = [];
  for (let i = 0; i < mfaConfig.recoveryCodeCount; i++) {
    const code = generateRecoveryCode();
    codes.push(code);
    codeHashes.push({
      mfaId: mfa.id,
      codeHash: await hashRecoveryCode(code),
    });
  }

  await createRecoveryCodes(codeHashes);

  return codes;
}

/**
 * Disable MFA for a user.
 */
export async function disableMFA(userId: string): Promise<void> {
  const mfa = await findUserMFA(userId);
  if (!mfa) return;

  await deleteRecoveryCodes(mfa.id);
  await deleteUserMFA(userId);
}

/**
 * Get MFA status for a user.
 */
export async function getMFAStatus(userId: string): Promise<MFAStatus> {
  const mfa = await findUserMFA(userId);

  if (!mfa) {
    return { enabled: false, verified: false, recoveryCodesRemaining: 0 };
  }

  const recoveryCodesRemaining = mfa.recoveryCodes?.filter((rc: any) => !rc.usedAt).length ?? 0;

  return {
    enabled: mfa.verified,
    verified: mfa.verified,
    recoveryCodesRemaining,
  };
}

/**
 * Check if MFA is required for a user in a given tenant.
 */
export async function isMFARequired(userId: string, tenantId?: string): Promise<boolean> {
  if (!tenantId) return false;

  // Resolve tenant → organization (MFA policy is org-level)
  const tenant = await findTenantById(tenantId);
  if (!tenant?.organizationId) return false;

  const org = await findOrganizationById(tenant.organizationId);

  if (!org) return false;

  // Check org settings for MFA requirement
  try {
    const settings = JSON.parse(org.settings || '{}');
    if (settings.requireMfa) return true;
  } catch (error) {
    console.warn(`[MFA] Failed to parse org settings for tenant ${tenantId}:`, error);
  }

  // Check plan-level MFA requirement (BUSINESS+ requires MFA)
  const sub = await findSubscription({ organizationId: org.id });
  const planTier = sub?.planTier ?? 'FREE';
  return planTier === 'BUSINESS' || planTier === 'ENTERPRISE';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decryptSecret(encryptedSecret: string, userId: string): string {
  return decryptMFASecret(encryptedSecret, userId);
}
