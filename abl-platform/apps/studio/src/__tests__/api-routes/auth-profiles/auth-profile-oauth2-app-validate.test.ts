/**
 * Unit tests for validateOAuth2AppProfile.
 *
 * Tests the oauth2_app grant-lookup + piece-validate branch using injected
 * dependencies — no vi.mock, no database, no registry singleton.
 */

import { describe, it, expect } from 'vitest';
import type { IAuthProfile } from '@agent-platform/database/models';
import {
  validateOAuth2AppProfile,
  type FindOAuthGrantFn,
  type OAuthGrant,
  type PieceValidatorRegistry,
} from '@/app/api/auth-profiles/_piece-auth-validator';

function makeProfile(overrides: Partial<IAuthProfile> = {}): IAuthProfile {
  return {
    _id: 'profile-1',
    tenantId: 'tenant-1',
    name: 'Test OAuth App',
    authType: 'oauth2_app',
    connector: 'slack',
    connectionMode: 'shared',
    status: 'active',
    scope: 'tenant',
    projectId: null,
    visibility: 'shared',
    config: {},
    encryptedSecrets: '{}',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IAuthProfile;
}

const baseParams = {
  profile: makeProfile(),
  decryptedSecrets: {},
  tenantId: 'tenant-1',
  grantUserId: '__tenant__',
  provider: 'auth-profile:profile-1',
};

describe('validateOAuth2AppProfile', () => {
  describe('grant not found', () => {
    it('returns valid:false with authorization-required message', async () => {
      const findGrant: FindOAuthGrantFn = async () => null;
      const result = await validateOAuth2AppProfile(baseParams, { findGrant });
      expect(result).toEqual({
        valid: false,
        error: 'No OAuth grant found — user authorization required',
      });
    });
  });

  describe('expired grant', () => {
    it('returns valid:false when expiresAt is in the past', async () => {
      const expiredGrant: OAuthGrant = {
        expiresAt: new Date(Date.now() - 60_000),
        encryptedAccessToken: 'old-token',
      };
      const findGrant: FindOAuthGrantFn = async () => expiredGrant;
      const result = await validateOAuth2AppProfile(baseParams, { findGrant });
      expect(result).toEqual({
        valid: false,
        error: 'OAuth grant has expired — reauthorization required',
      });
    });

    it('treats a null expiresAt as non-expired', async () => {
      const grant: OAuthGrant = { expiresAt: null, encryptedAccessToken: 'xoxp-token' };
      const findGrant: FindOAuthGrantFn = async () => grant;
      const result = await validateOAuth2AppProfile(baseParams, { findGrant });
      expect(result.valid).toBe(true);
    });
  });

  describe('valid grant, no piece validate hook', () => {
    it('returns valid:true when the connector has no validateAuth', async () => {
      const grant: OAuthGrant = { expiresAt: null, encryptedAccessToken: 'xoxp-token' };
      const findGrant: FindOAuthGrantFn = async () => grant;

      const registry: PieceValidatorRegistry = {
        has: () => false,
        get: () => undefined,
      };
      const result = await validateOAuth2AppProfile(baseParams, {
        findGrant,
        getRegistry: async () => registry,
      });
      expect(result).toEqual({ valid: true });
    });

    it('returns valid:true when the connector slug is not in the registry', async () => {
      const grant: OAuthGrant = { expiresAt: null, encryptedAccessToken: 'xoxp-token' };
      const findGrant: FindOAuthGrantFn = async () => grant;

      const registry: PieceValidatorRegistry = {
        has: () => false,
        get: () => undefined,
      };
      const result = await validateOAuth2AppProfile(
        { ...baseParams, profile: makeProfile({ connector: 'unknown-connector' }) },
        { findGrant, getRegistry: async () => registry },
      );
      expect(result).toEqual({ valid: true });
    });
  });

  describe('valid grant, piece validate hook present', () => {
    it('returns valid:true when the piece hook succeeds', async () => {
      const grant: OAuthGrant = { expiresAt: null, encryptedAccessToken: 'xoxp-token' };
      const findGrant: FindOAuthGrantFn = async () => grant;

      const registry: PieceValidatorRegistry = {
        has: () => true,
        get: () => ({
          auth: {
            validateAuth: async ({ auth }: { auth: unknown }) => {
              expect((auth as Record<string, unknown>).access_token).toBe('xoxp-token');
              return { valid: true } as const;
            },
          },
        }),
      };

      const result = await validateOAuth2AppProfile(baseParams, {
        findGrant,
        getRegistry: async () => registry,
        normalizeAuth: (_name, auth) => auth,
      });
      expect(result).toEqual({ valid: true });
    });

    it('returns valid:false with the error from the piece hook', async () => {
      const grant: OAuthGrant = { expiresAt: null, encryptedAccessToken: 'xoxp-token' };
      const findGrant: FindOAuthGrantFn = async () => grant;

      const registry: PieceValidatorRegistry = {
        has: () => true,
        get: () => ({
          auth: {
            validateAuth: async () => ({ valid: false, error: 'token_expired' }),
          },
        }),
      };

      const result = await validateOAuth2AppProfile(baseParams, {
        findGrant,
        getRegistry: async () => registry,
        normalizeAuth: (_name, auth) => auth,
      });
      expect(result).toEqual({ valid: false, error: 'token_expired' });
    });

    it('surfaces thrown errors from the validate hook as valid:false', async () => {
      const grant: OAuthGrant = { expiresAt: null, encryptedAccessToken: 'xoxp-token' };
      const findGrant: FindOAuthGrantFn = async () => grant;

      const registry: PieceValidatorRegistry = {
        has: () => true,
        get: () => ({
          auth: {
            validateAuth: async () => {
              throw new Error('network timeout');
            },
          },
        }),
      };

      const result = await validateOAuth2AppProfile(baseParams, {
        findGrant,
        getRegistry: async () => registry,
        normalizeAuth: (_name, auth) => auth,
      });
      expect(result).toEqual({ valid: false, error: 'network timeout' });
    });
  });

  describe('connectionMode principal selection (caller responsibility)', () => {
    it('passes the provided grantUserId to findGrant unchanged', async () => {
      let capturedUserId: string | undefined;
      const findGrant: FindOAuthGrantFn = async ({ userId }) => {
        capturedUserId = userId;
        return null;
      };

      await validateOAuth2AppProfile({ ...baseParams, grantUserId: 'user-123' }, { findGrant });
      expect(capturedUserId).toBe('user-123');
    });

    it('passes __tenant__ when the caller supplies the shared principal', async () => {
      let capturedUserId: string | undefined;
      const findGrant: FindOAuthGrantFn = async ({ userId }) => {
        capturedUserId = userId;
        return null;
      };

      await validateOAuth2AppProfile({ ...baseParams, grantUserId: '__tenant__' }, { findGrant });
      expect(capturedUserId).toBe('__tenant__');
    });
  });

  describe('grant provider key forwarding', () => {
    it('passes the provider key through to findGrant', async () => {
      let capturedProvider: string | undefined;
      const findGrant: FindOAuthGrantFn = async ({ provider }) => {
        capturedProvider = provider;
        return null;
      };

      await validateOAuth2AppProfile(
        { ...baseParams, provider: 'auth-profile:profile-99' },
        { findGrant },
      );
      expect(capturedProvider).toBe('auth-profile:profile-99');
    });
  });
});
