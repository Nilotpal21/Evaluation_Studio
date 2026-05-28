import { describe, expect, test } from 'vitest';
import type { SDKSessionTokenPayload } from '@agent-platform/shared-auth';
import {
  deriveLegacyAnonymousSdkUserId,
  issueSdkSessionPrincipalId,
  normalizeSdkUserContext,
  normalizeLegacySdkSessionPayload,
} from '../../services/identity/sdk-session-token.js';

describe('sdk-session-token identity helpers', () => {
  test('normalizeSdkUserContext preserves metadata fields', () => {
    expect(
      normalizeSdkUserContext({
        userId: 'sdk-user-1',
        customAttributes: { locale: 'en-US' },
      }),
    ).toEqual({
      success: true,
      data: {
        userId: 'sdk-user-1',
        customAttributes: { locale: 'en-US' },
      },
    });
  });

  test('normalizeSdkUserContext rejects oversized values', () => {
    const value = 'x'.repeat(600);
    const result = normalizeSdkUserContext({
      customAttributes: { note: value },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_USER_CONTEXT');
    }
  });

  test('issueSdkSessionPrincipalId generates a stable SDK session principal prefix', () => {
    expect(issueSdkSessionPrincipalId()).toMatch(/^sdk_/);
  });

  test('normalizeLegacySdkSessionPayload backfills a stable session principal from the token', () => {
    const payload = {
      type: 'sdk_session',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
      identityTier: 0,
      verificationMethod: 'none',
      iat: 1,
      exp: 2,
    } satisfies SDKSessionTokenPayload;

    const normalized = normalizeLegacySdkSessionPayload(payload, 'legacy-token-value');

    expect(normalized.sessionId).toBe(deriveLegacyAnonymousSdkUserId('legacy-token-value'));
    expect(normalized.sessionPrincipal).toBe(deriveLegacyAnonymousSdkUserId('legacy-token-value'));
    expect(normalized.authScope).toBe('session');
    expect(normalized.verifiedUserId).toBeUndefined();
  });

  test('normalizeLegacySdkSessionPayload preserves verified identity separately from metadata', () => {
    const payload = {
      type: 'sdk_session',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
      sessionId: 'sdk-session-verified',
      verifiedUserId: 'verified-user',
      userContext: {
        userId: 'display-user',
      },
      identityTier: 2,
      verificationMethod: 'hmac',
      iat: 1,
      exp: 2,
    } satisfies SDKSessionTokenPayload;

    const normalized = normalizeLegacySdkSessionPayload(payload, 'legacy-token-value');

    expect(normalized.sessionId).toBe('sdk-session-verified');
    expect(normalized.sessionPrincipal).toBe('sdk-session-verified');
    expect(normalized.verifiedUserId).toBe('verified-user');
    expect(normalized.authScope).toBe('user');
    expect(normalized.userContext?.userId).toBe('display-user');
  });

  test('normalizeLegacySdkSessionPayload keeps metadata-only userContext out of verified identity', () => {
    const payload = {
      type: 'sdk_session',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
      identityTier: 2,
      verificationMethod: 'hmac',
      userContext: {
        userId: 'display-user',
        customAttributes: { plan: 'pro' },
      },
      iat: 1,
      exp: 2,
    } satisfies SDKSessionTokenPayload;

    const normalized = normalizeLegacySdkSessionPayload(payload, 'legacy-token-value');

    expect(normalized.sessionId).toBe(deriveLegacyAnonymousSdkUserId('legacy-token-value'));
    expect(normalized.sessionPrincipal).toBe(deriveLegacyAnonymousSdkUserId('legacy-token-value'));
    expect(normalized.verifiedUserId).toBeUndefined();
    expect(normalized.authScope).toBe('session');
    expect(normalized.identityTier).toBe(2);
    expect(normalized.userContext).toEqual({
      userId: 'display-user',
      customAttributes: { plan: 'pro' },
    });
  });
});
