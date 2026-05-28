import { createHmac } from 'node:crypto';
import { getConfig } from '../../config/index.js';

const MISSING_SDK_SESSION_SIGNING_SECRET_ERROR =
  'AUTH_SDK_SESSION_SIGNING_SECRET must be configured for Runtime SDK session signing.';
const MISSING_SDK_BOOTSTRAP_SIGNING_SECRET_ERROR =
  'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET must be configured for Studio bootstrap artifact exchange.';

function normalizeSecret(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Runtime-only signing secret for sdk_session JWTs.
 *
 * Test harnesses may fall back to JWT_SECRET to avoid re-plumbing dozens of
 * isolated mocks. Non-test environments must configure a dedicated secret so
 * Studio/control-plane services cannot mint Runtime-trusted sdk_session tokens.
 */
export function getRuntimeSdkSessionSigningSecret(): string {
  const config = getConfig() as {
    env: string;
    jwt: { secret: string };
    auth?: { sdk?: { sessionSigningSecret?: string } };
  };
  const configured = normalizeSecret(config.auth?.sdk?.sessionSigningSecret);
  if (configured) {
    return configured;
  }

  if (config.env === 'test') {
    return config.jwt.secret;
  }

  throw new Error(MISSING_SDK_SESSION_SIGNING_SECRET_ERROR);
}

/**
 * Shared bootstrap artifact secret used only for preview/share artifacts
 * exchanged from Studio into Runtime.
 */
export function getRuntimeSdkBootstrapSigningSecret(): string {
  const config = getConfig() as {
    env: string;
    jwt: { secret: string };
    auth?: { sdk?: { bootstrapSigningSecret?: string } };
  };
  const configured = normalizeSecret(config.auth?.sdk?.bootstrapSigningSecret);
  if (configured) {
    return configured;
  }

  if (config.env === 'test') {
    return config.jwt.secret;
  }

  throw new Error(MISSING_SDK_BOOTSTRAP_SIGNING_SECRET_ERROR);
}

export function getRuntimeTenantScopedSdkBootstrapSigningSecret(tenantId: string): string {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error('tenantId is required to derive a tenant-scoped SDK bootstrap secret');
  }

  return createHmac('sha256', getRuntimeSdkBootstrapSigningSecret())
    .update(`sdk-bootstrap:${normalizedTenantId}`)
    .digest('base64url');
}

export { MISSING_SDK_BOOTSTRAP_SIGNING_SECRET_ERROR, MISSING_SDK_SESSION_SIGNING_SECRET_ERROR };
