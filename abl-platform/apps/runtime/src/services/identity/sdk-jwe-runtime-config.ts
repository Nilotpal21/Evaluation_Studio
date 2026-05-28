import { hkdfSync } from 'node:crypto';
import { isSdkBootstrapArtifactPayload } from '@agent-platform/shared';
import { getConfig, type RuntimeConfig } from '../../config/index.js';
import {
  createDisabledSdkJweKeyProvider,
  createStaticSdkJweKeyProvider,
  type RuntimeSdkJweKeyProvider,
} from './sdk-jwe-keyring.js';
import {
  getRuntimeSdkSessionSigningSecret,
  getRuntimeSdkBootstrapSigningSecret,
  getRuntimeTenantScopedSdkBootstrapSigningSecret,
} from './sdk-secret-config.js';
import type { RuntimeSdkTokenEnvelopeDeps } from './sdk-token-envelope-runtime.js';

const DEFAULT_MAX_ENCRYPTED_BOOTSTRAP_BYTES = 4096;
const DEFAULT_MAX_ENCRYPTED_SESSION_BYTES = 4096;
const SDK_JWE_HKDF_SALT = Buffer.from('abl-platform-sdk-jwe-v1');
const SDK_JWE_BOOTSTRAP_KID = 'runtime-derived-sdk-bootstrap-v1';
const SDK_JWE_SESSION_KID = 'runtime-derived-sdk-session-v1';

function deriveSdkJweKey(masterKeyHex: string, info: string): Uint8Array | null {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  if (masterKey.byteLength !== 32) {
    return null;
  }

  return new Uint8Array(hkdfSync('sha256', masterKey, SDK_JWE_HKDF_SALT, Buffer.from(info), 32));
}

function resolveMaxEncryptedBootstrapBytes(config: RuntimeConfig): number {
  return config.auth?.sdk?.jwe?.maxEncryptedBootstrapBytes ?? DEFAULT_MAX_ENCRYPTED_BOOTSTRAP_BYTES;
}

function resolveMaxEncryptedSessionBytes(config: RuntimeConfig): number {
  return config.auth?.sdk?.jwe?.maxEncryptedSessionBytes ?? DEFAULT_MAX_ENCRYPTED_SESSION_BYTES;
}

function decodeUnsignedSdkBootstrapArtifactTenant(token: string): string | null {
  try {
    const [encodedPayload] = token.split('.');
    if (!encodedPayload) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as unknown;
    return isSdkBootstrapArtifactPayload(payload) && payload.type === 'customer'
      ? payload.tenantId
      : null;
  } catch {
    return null;
  }
}

function resolveRuntimeSdkBootstrapSigningSecret(token: string): string {
  const tenantId = decodeUnsignedSdkBootstrapArtifactTenant(token);
  return tenantId
    ? getRuntimeTenantScopedSdkBootstrapSigningSecret(tenantId)
    : getRuntimeSdkBootstrapSigningSecret();
}

export function getRuntimeSdkJweKeyProvider(): RuntimeSdkJweKeyProvider {
  const config = getConfig();
  if (config.auth?.sdk?.jwe?.enabled === false || !config.encryption?.masterKey) {
    return createDisabledSdkJweKeyProvider();
  }

  const bootstrapKey = deriveSdkJweKey(
    config.encryption.masterKey,
    'abl-platform:sdk-jwe:sdk_bootstrap',
  );
  const sessionKey = deriveSdkJweKey(
    config.encryption.masterKey,
    'abl-platform:sdk-jwe:sdk_session',
  );
  if (!bootstrapKey || !sessionKey) {
    return createDisabledSdkJweKeyProvider();
  }

  return createStaticSdkJweKeyProvider({
    keys: [
      {
        kid: SDK_JWE_BOOTSTRAP_KID,
        purposes: ['sdk_bootstrap'],
        status: 'active',
        keyBytes: bootstrapKey,
      },
      {
        kid: SDK_JWE_SESSION_KID,
        purposes: ['sdk_session'],
        status: 'active',
        keyBytes: sessionKey,
      },
    ],
  });
}

export function getRuntimeSdkTokenEnvelopeDeps(): RuntimeSdkTokenEnvelopeDeps {
  const config = getConfig();
  return {
    keyProvider: getRuntimeSdkJweKeyProvider(),
    getSessionSigningSecret: getRuntimeSdkSessionSigningSecret,
    getBootstrapSigningSecret: resolveRuntimeSdkBootstrapSigningSecret,
    maxEncryptedBootstrapBytes: resolveMaxEncryptedBootstrapBytes(config),
    maxEncryptedSessionBytes: resolveMaxEncryptedSessionBytes(config),
  };
}
