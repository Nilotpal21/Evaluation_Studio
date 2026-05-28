/**
 * Device Authorization Service (RFC 8628)
 *
 * Provides device authorization flow for CLI/MCP tool authentication.
 */

import crypto from 'node:crypto';
import { getConfig } from '../config/index.js';
import {
  resolveFirstMembership,
  buildAccessTokenPayload,
  signAccessToken,
  createStoredRefreshToken,
} from '../utils/jwt-utils.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Hash a token with SHA-256 for secure storage.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a user-friendly device code (e.g., "ABCD-1234").
 * Excludes ambiguous characters: 0, O, 1, I.
 */
export function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

// =============================================================================
// DEVICE AUTH FUNCTIONS
// =============================================================================

/**
 * Create a device authorization request.
 * Returns unhashed device_code (for the CLI) and user_code (for display).
 */
export async function createDeviceAuthRequest(scopes: string[]): Promise<{
  deviceCode: string;
  userCode: string;
  expiresAt: Date;
}> {
  const { DeviceAuthRequest } = await import('@agent-platform/database/models');
  const deviceCode = crypto.randomBytes(32).toString('hex');
  const hashedDeviceCode = hashToken(deviceCode);
  const userCode = generateUserCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await DeviceAuthRequest.create({
    deviceCode: hashedDeviceCode,
    userCode,
    scopes,
    expiresAt,
  });

  return { deviceCode, userCode, expiresAt };
}

/**
 * Get device auth request by user code (for authorization page).
 */
export async function getDeviceAuthByUserCode(userCode: string) {
  const { DeviceAuthRequest } = await import('@agent-platform/database/models');
  return DeviceAuthRequest.findOne({ userCode }).lean();
}

/**
 * Authorize a device auth request (user grants permission from browser).
 */
export async function authorizeDeviceRequest(userCode: string, userId: string): Promise<boolean> {
  const { DeviceAuthRequest } = await import('@agent-platform/database/models');
  const result = await DeviceAuthRequest.updateOne(
    {
      userCode,
      authorizedAt: null,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        userId,
        authorizedAt: new Date(),
      },
    },
  );

  return result.modifiedCount > 0;
}

/**
 * Poll for device token (CLI/MCP tool calls this).
 * Returns status and userId/scopes on success.
 */
export async function pollDeviceToken(deviceCode: string): Promise<{
  status: 'pending' | 'authorized' | 'expired' | 'consumed';
  userId?: string;
  scopes?: string[];
}> {
  const { DeviceAuthRequest } = await import('@agent-platform/database/models');
  const hashedDeviceCode = hashToken(deviceCode);
  const request = await DeviceAuthRequest.findOne({ deviceCode: hashedDeviceCode }).lean();

  if (!request) {
    return { status: 'expired' }; // Invalid code treated as expired
  }

  if (request.expiresAt < new Date()) {
    return { status: 'expired' };
  }

  if (request.consumedAt) {
    return { status: 'consumed' };
  }

  if (!request.authorizedAt || !request.userId) {
    return { status: 'pending' };
  }

  // Mark as consumed
  await DeviceAuthRequest.updateOne({ _id: request._id }, { $set: { consumedAt: new Date() } });

  const scopes = Array.isArray(request.scopes)
    ? request.scopes
    : (JSON.parse(request.scopes as string) as string[]);

  return {
    status: 'authorized',
    userId: request.userId,
    scopes,
  };
}

/**
 * Create a JWT token pair for an authorized device.
 * Resolves tenant context from user's membership.
 */
export async function createDeviceTokenPair(userId: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const config = getConfig();
  const { findUserById } = await import('../repos/auth-repo.js');

  const user = await findUserById(userId);
  if (!user) {
    throw new AppError('User not found', { ...ErrorCodes.NOT_FOUND });
  }

  const membership = await resolveFirstMembership(user.id);
  const payload = buildAccessTokenPayload(user as any, membership);

  const expiresIn = 24 * 60 * 60; // 24 hours
  const accessToken = signAccessToken(payload, config.jwt.secret, expiresIn);
  const refreshToken = await createStoredRefreshToken(user.id);

  return { accessToken, refreshToken, expiresIn };
}
