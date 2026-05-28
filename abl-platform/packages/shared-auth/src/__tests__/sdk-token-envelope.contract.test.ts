import { describe, expect, test } from 'vitest';
import { CompactEncrypt } from 'jose';
import {
  createLocalSdkJweKeyHandle,
  isCompactJwe,
  readCompactJweProtectedHeader,
  signSDKSessionToken,
  unwrapCompactToken,
  verifySDKSessionToken,
  wrapCompactToken,
} from '../index.js';

type SdkTokenEnvelopeExport =
  | 'isCompactJwe'
  | 'wrapCompactToken'
  | 'unwrapCompactToken'
  | 'readCompactJweProtectedHeader';

type SharedAuthModule = Record<SdkTokenEnvelopeExport, unknown>;

const EXPECTED_EXPORTS = [
  'isCompactJwe',
  'wrapCompactToken',
  'unwrapCompactToken',
  'readCompactJweProtectedHeader',
] satisfies SdkTokenEnvelopeExport[];
const textEncoder = new TextEncoder();

function replaceProtectedHeader(token: string, header: Record<string, unknown>): string {
  const parts = token.split('.');
  parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url');
  return parts.join('.');
}

async function loadSharedAuthModule(): Promise<Partial<SharedAuthModule>> {
  return (await import('../index.js')) as Partial<SharedAuthModule>;
}

describe('SDK token envelope contract', () => {
  test('exports the JWE envelope primitives required by Runtime wrappers', async () => {
    const sharedAuth = await loadSharedAuthModule();

    for (const exportName of EXPECTED_EXPORTS) {
      expect(typeof sharedAuth[exportName], `${exportName} must be exported`).toBe('function');
    }
  });

  test('raw signed SDK verifier remains a signed-token verifier, not a hidden JWE resolver', () => {
    const signedToken = signSDKSessionToken(
      {
        type: 'sdk_session',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:read'],
        bootstrapType: 'customer',
      },
      's'.repeat(64),
      { expiresIn: '5m' },
    );
    const jweShapedToken = ['protected', 'encrypted-key', 'iv', 'ciphertext', 'tag'].join('.');

    expect(verifySDKSessionToken(signedToken, 's'.repeat(64)).channelId).toBe('channel-1');
    expect(() => verifySDKSessionToken(jweShapedToken, 's'.repeat(64))).toThrow();
  });

  test('wraps and unwraps an SDK session token with safe protected headers', async () => {
    const key = createLocalSdkJweKeyHandle({
      kid: 'sdk-jwe-test-key',
      purpose: 'sdk_session',
      keyBytes: new Uint8Array(32).fill(1),
    });
    const signedToken = signSDKSessionToken(
      {
        type: 'sdk_session',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:read'],
        bootstrapType: 'customer',
        userContext: {
          userId: 'sensitive-user',
          customAttributes: { policyId: 'policy-sensitive' },
        },
      },
      's'.repeat(64),
      { expiresIn: '5m' },
    );

    const encrypted = await wrapCompactToken({
      plaintext: signedToken,
      purpose: 'sdk_session',
      key,
      maxPlaintextBytes: 4096,
      maxCiphertextBytes: 8192,
    });

    expect(isCompactJwe(encrypted)).toBe(true);
    expect(encrypted).not.toContain('sensitive-user');
    expect(encrypted).not.toContain('policy-sensitive');
    expect(readCompactJweProtectedHeader(encrypted)).toEqual({
      alg: 'dir',
      enc: 'A256GCM',
      kid: 'sdk-jwe-test-key',
      typ: 'abl-sdk-session+jwe',
      cty: 'abl-sdk-session+jwt',
      epv: 1,
    });

    await expect(
      unwrapCompactToken({
        token: encrypted,
        purpose: 'sdk_session',
        resolveKey: () => key,
      }),
    ).resolves.toBe(signedToken);
  });

  test('key handles serialize safe metadata without raw key material', () => {
    const key = createLocalSdkJweKeyHandle({
      kid: 'safe-key',
      purpose: 'sdk_bootstrap',
      keyBytes: new Uint8Array(32).fill(2),
    });

    expect(JSON.stringify(key)).toBe(
      JSON.stringify({ kid: 'safe-key', purpose: 'sdk_bootstrap', alg: 'dir' }),
    );
    expect(JSON.stringify(key)).not.toContain('2,2,2');
    expect(Object.keys(key)).toEqual(['kid', 'purpose', 'alg', 'toJSON']);
  });

  test('rejects purpose mismatch, tampering, and size violations', async () => {
    const sessionKey = createLocalSdkJweKeyHandle({
      kid: 'session-key',
      purpose: 'sdk_session',
      keyBytes: new Uint8Array(32).fill(3),
    });
    const bootstrapKey = createLocalSdkJweKeyHandle({
      kid: 'bootstrap-key',
      purpose: 'sdk_bootstrap',
      keyBytes: new Uint8Array(32).fill(4),
    });
    const encrypted = await wrapCompactToken({
      plaintext: 'inner.signed.token',
      purpose: 'sdk_session',
      key: sessionKey,
    });
    const parts = encrypted.split('.');
    parts[4] = Buffer.from(new Uint8Array(16).fill(9)).toString('base64url');

    await expect(
      unwrapCompactToken({
        token: encrypted,
        purpose: 'sdk_bootstrap',
        resolveKey: () => bootstrapKey,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_HEADER' });
    await expect(
      unwrapCompactToken({
        token: parts.join('.'),
        purpose: 'sdk_session',
        resolveKey: () => sessionKey,
      }),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    await expect(
      wrapCompactToken({
        plaintext: 'x'.repeat(10),
        purpose: 'sdk_session',
        key: sessionKey,
        maxPlaintextBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_TOO_LARGE' });
  });

  test('rejects unsafe or unsupported protected headers before returning plaintext', async () => {
    const keyBytes = new Uint8Array(32).fill(5);
    const key = createLocalSdkJweKeyHandle({
      kid: 'header-key',
      purpose: 'sdk_session',
      keyBytes,
    });
    const encryptWithHeader = (header: Record<string, unknown>) =>
      new CompactEncrypt(textEncoder.encode('inner.signed.token'))
        .setProtectedHeader(header)
        .encrypt(keyBytes);

    const baseHeader = {
      alg: 'dir',
      enc: 'A256GCM',
      kid: 'header-key',
      typ: 'abl-sdk-session+jwe',
      cty: 'abl-sdk-session+jwt',
      epv: 1,
    };

    const validToken = await encryptWithHeader(baseHeader);

    await expect(
      unwrapCompactToken({
        token: replaceProtectedHeader(validToken, { ...baseHeader, zip: 'DEF' }),
        purpose: 'sdk_session',
        resolveKey: () => key,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENVELOPE' });
    await expect(
      unwrapCompactToken({
        token: await encryptWithHeader({ ...baseHeader, kid: undefined }),
        purpose: 'sdk_session',
        resolveKey: () => key,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_HEADER' });
    await expect(
      unwrapCompactToken({
        token: await encryptWithHeader({ ...baseHeader, typ: 'abl-sdk-bootstrap+jwe' }),
        purpose: 'sdk_session',
        resolveKey: () => key,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_HEADER' });
    await expect(
      unwrapCompactToken({
        token: await encryptWithHeader({ ...baseHeader, epv: 2 }),
        purpose: 'sdk_session',
        resolveKey: () => key,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENVELOPE' });
  });
});
