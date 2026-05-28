import { signSdkBootstrapArtifact } from '@agent-platform/shared';
import { signSDKSessionToken } from '@agent-platform/shared-auth';
import { describe, expect, it } from 'vitest';
import {
  createDisabledSdkJweKeyProvider,
  createStaticSdkJweKeyProvider,
  type RuntimeSdkJweKeyProvider,
} from '../../services/identity/sdk-jwe-keyring.js';
import {
  verifyRuntimeSdkBootstrapToken,
  verifyRuntimeSdkSessionToken,
  wrapRuntimeSdkBootstrapToken,
  wrapRuntimeSdkSessionToken,
  type RuntimeSdkTokenEnvelopeDeps,
} from '../../services/identity/sdk-token-envelope-runtime.js';

const SESSION_SECRET = 's'.repeat(64);
const BOOTSTRAP_SECRET = 'b'.repeat(64);

function keyBytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function createProvider(): RuntimeSdkJweKeyProvider {
  return createStaticSdkJweKeyProvider({
    keys: [
      {
        kid: 'active-key',
        purposes: ['sdk_bootstrap', 'sdk_session'],
        status: 'active',
        keyBytes: keyBytes(1),
      },
      {
        kid: 'previous-key',
        purposes: ['sdk_session'],
        status: 'previous',
        keyBytes: keyBytes(2),
      },
    ],
  });
}

function createDeps(
  keyProvider: RuntimeSdkJweKeyProvider = createProvider(),
): RuntimeSdkTokenEnvelopeDeps {
  return {
    keyProvider,
    getSessionSigningSecret: () => SESSION_SECRET,
    getBootstrapSigningSecret: () => BOOTSTRAP_SECRET,
    maxEncryptedBootstrapBytes: 4096,
    maxEncryptedSessionBytes: 4096,
  };
}

function createSignedBootstrapToken(): string {
  return signSdkBootstrapArtifact(
    {
      type: 'customer',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:read', 'session:send_message'],
      exp: Date.now() + 60_000,
      verifiedUserId: 'verified-user-1',
      channelArtifact: 'artifact-1',
      jti: 'jti-1',
      userContext: {
        userId: 'verified-user-1',
        customAttributes: { policyId: 'policy-sensitive' },
      },
    },
    BOOTSTRAP_SECRET,
  );
}

function createSignedSessionToken(): string {
  return signSDKSessionToken(
    {
      type: 'sdk_session',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:read', 'session:send_message'],
      bootstrapType: 'customer',
      verifiedUserId: 'verified-user-1',
      tokenEnvelope: 'jwe',
      userContext: {
        userId: 'verified-user-1',
        customAttributes: { policyId: 'policy-sensitive' },
      },
    },
    SESSION_SECRET,
    { expiresIn: '5m' },
  );
}

function tamperToken(token: string): string {
  const parts = token.split('.');
  parts[4] = Buffer.from(new Uint8Array(16).fill(9)).toString('base64url');
  return parts.join('.');
}

describe('runtime SDK token envelope wrappers', () => {
  it('wraps and verifies hosted_exchange bootstrap artifacts through the existing signed verifier', async () => {
    const deps = createDeps();
    const signedBootstrap = createSignedBootstrapToken();

    const wrapped = await wrapRuntimeSdkBootstrapToken(signedBootstrap, deps);
    expect(wrapped).toMatchObject({
      success: true,
      envelope: 'jwe',
      epv: 1,
    });
    if (!wrapped.success) {
      throw new Error(wrapped.logReason);
    }
    expect(wrapped.safeKidAlias).toMatch(/^kid_[0-9a-f]{12}$/);
    expect(wrapped.safeKidAlias).not.toBe('active-key');
    expect(wrapped.data).not.toContain('verified-user-1');
    expect(wrapped.data).not.toContain('policy-sensitive');

    const verified = await verifyRuntimeSdkBootstrapToken(wrapped.data, deps);
    expect(verified).toMatchObject({
      success: true,
      envelope: 'jwe',
      epv: 1,
      data: {
        type: 'customer',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        verifiedUserId: 'verified-user-1',
      },
    });
  });

  it('wraps and verifies SDK session tokens through the existing signed JWT verifier', async () => {
    const deps = createDeps();
    const signedSession = createSignedSessionToken();

    const wrapped = await wrapRuntimeSdkSessionToken(signedSession, deps);
    expect(wrapped).toMatchObject({
      success: true,
      envelope: 'jwe',
      epv: 1,
    });
    if (!wrapped.success) {
      throw new Error(wrapped.logReason);
    }
    expect(wrapped.safeKidAlias).toMatch(/^kid_[0-9a-f]{12}$/);
    expect(wrapped.safeKidAlias).not.toBe('active-key');
    expect(wrapped.data).not.toContain('verified-user-1');
    expect(wrapped.data).not.toContain('policy-sensitive');

    const verified = await verifyRuntimeSdkSessionToken(wrapped.data, deps);
    expect(verified).toMatchObject({
      success: true,
      envelope: 'jwe',
      epv: 1,
      data: {
        type: 'sdk_session',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        verifiedUserId: 'verified-user-1',
        tokenEnvelope: 'jwe',
      },
    });
  });

  it('keeps legacy signed bootstrap and SDK session verification available', async () => {
    const deps = createDeps(createDisabledSdkJweKeyProvider());

    await expect(
      verifyRuntimeSdkBootstrapToken(createSignedBootstrapToken(), deps),
    ).resolves.toMatchObject({
      success: true,
      envelope: 'signed',
      data: { type: 'customer', verifiedUserId: 'verified-user-1' },
    });
    await expect(
      verifyRuntimeSdkSessionToken(createSignedSessionToken(), deps),
    ).resolves.toMatchObject({
      success: true,
      envelope: 'signed',
      data: { type: 'sdk_session', verifiedUserId: 'verified-user-1' },
    });
  });

  it('returns typed bootstrap failures when secret resolution cannot complete', async () => {
    await expect(
      verifyRuntimeSdkBootstrapToken(createSignedBootstrapToken(), {
        ...createDeps(),
        getBootstrapSigningSecret: () => {
          throw new Error('missing tenant secret');
        },
      }),
    ).resolves.toEqual({
      success: false,
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_bootstrap_secret_resolution_failed',
    });
  });

  it('fails closed for tampered encrypted tokens without exposing key details', async () => {
    const deps = createDeps();
    const wrapped = await wrapRuntimeSdkSessionToken(createSignedSessionToken(), deps);
    if (!wrapped.success) {
      throw new Error(wrapped.logReason);
    }

    await expect(verifyRuntimeSdkSessionToken(tamperToken(wrapped.data), deps)).resolves.toEqual({
      success: false,
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_jwe_unwrap_failed',
    });
  });

  it('reports unavailable capability for JWE issuance and verification', async () => {
    const deps = createDeps(createDisabledSdkJweKeyProvider());

    await expect(wrapRuntimeSdkSessionToken(createSignedSessionToken(), deps)).resolves.toEqual({
      success: false,
      status: 503,
      code: 'SDK_JWE_UNAVAILABLE',
      logReason: 'sdk_jwe_issue_unavailable:provider_disabled',
    });

    const wrapped = await wrapRuntimeSdkSessionToken(createSignedSessionToken(), createDeps());
    if (!wrapped.success) {
      throw new Error(wrapped.logReason);
    }
    await expect(verifyRuntimeSdkSessionToken(wrapped.data, deps)).resolves.toEqual({
      success: false,
      status: 503,
      code: 'SDK_JWE_UNAVAILABLE',
      logReason: 'sdk_jwe_verify_unavailable:provider_disabled',
    });
  });

  it('enforces encrypted token size budgets before accepting browser-carried tokens', async () => {
    const deps = {
      ...createDeps(),
      maxEncryptedSessionBytes: 16,
    };

    await expect(wrapRuntimeSdkSessionToken(createSignedSessionToken(), deps)).resolves.toEqual({
      success: false,
      status: 400,
      code: 'SDK_TOKEN_TOO_LARGE',
      logReason: 'sdk_jwe_wrap_token_too_large',
    });
  });
});
