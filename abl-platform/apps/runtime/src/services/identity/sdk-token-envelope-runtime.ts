import { createHash } from 'node:crypto';
import {
  isSdkBootstrapArtifactPayload,
  verifySdkBootstrapArtifact,
  type SDKBootstrapArtifactPayload,
} from '@agent-platform/shared';
import {
  AuthError,
  SDKTokenEnvelopeError,
  unwrapCompactToken,
  verifySDKSessionToken,
  wrapCompactToken,
  type SDKSessionTokenPayload,
  type SDKTokenEnvelopeMode,
  type SDKTokenEnvelopePurpose,
} from '@agent-platform/shared-auth';
import type { RuntimeSdkJweKeyProvider } from './sdk-jwe-keyring.js';

export interface RuntimeSdkTokenEnvelopeDeps {
  keyProvider: RuntimeSdkJweKeyProvider;
  getSessionSigningSecret(): string;
  getBootstrapSigningSecret(token: string): string;
  maxEncryptedBootstrapBytes: number;
  maxEncryptedSessionBytes: number;
}

export type RuntimeEnvelopeResult<T> =
  | {
      success: true;
      data: T;
      envelope: SDKTokenEnvelopeMode;
      safeKidAlias?: string;
      epv?: number;
    }
  | {
      success: false;
      status: 400 | 401 | 503;
      code: string;
      logReason: string;
    };

function tokenSegmentCount(token: string): number {
  return token.split('.').length;
}

function isJweShapedToken(token: string): boolean {
  return tokenSegmentCount(token) === 5;
}

function invalidToken(logReason: string): RuntimeEnvelopeResult<never> {
  return {
    success: false,
    status: 401,
    code: 'INVALID_SDK_TOKEN',
    logReason,
  };
}

function unavailable(logReason: string): RuntimeEnvelopeResult<never> {
  return {
    success: false,
    status: 503,
    code: 'SDK_JWE_UNAVAILABLE',
    logReason,
  };
}

function oversized(logReason: string): RuntimeEnvelopeResult<never> {
  return {
    success: false,
    status: 400,
    code: 'SDK_TOKEN_TOO_LARGE',
    logReason,
  };
}

function classifyEnvelopeError(error: unknown, logReason: string): RuntimeEnvelopeResult<never> {
  if (error instanceof SDKTokenEnvelopeError && error.code === 'TOKEN_TOO_LARGE') {
    return oversized(logReason);
  }
  return invalidToken(logReason);
}

function safeKidAlias(kid: string): string {
  return `kid_${createHash('sha256').update(kid).digest('hex').slice(0, 12)}`;
}

function requireIssueCapability(
  deps: RuntimeSdkTokenEnvelopeDeps,
  purpose: SDKTokenEnvelopePurpose,
): RuntimeEnvelopeResult<null> {
  const capability = deps.keyProvider.getCapability();
  const canIssue =
    purpose === 'sdk_bootstrap' ? capability.canIssueBootstrap : capability.canIssueSession;
  if (!capability.supported || !canIssue) {
    return unavailable(`sdk_jwe_issue_unavailable:${capability.blockedReason ?? 'unknown'}`);
  }
  return { success: true, data: null, envelope: 'jwe' };
}

async function wrapRuntimeSdkToken(input: {
  signedToken: string;
  purpose: SDKTokenEnvelopePurpose;
  deps: RuntimeSdkTokenEnvelopeDeps;
  maxEncryptedBytes: number;
}): Promise<RuntimeEnvelopeResult<string>> {
  const capability = requireIssueCapability(input.deps, input.purpose);
  if (!capability.success) {
    return capability;
  }

  const key = input.deps.keyProvider.getActiveKey(input.purpose);
  if (!key) {
    return unavailable('sdk_jwe_active_key_unavailable');
  }

  try {
    const encrypted = await wrapCompactToken({
      plaintext: input.signedToken,
      purpose: input.purpose,
      key,
      maxCiphertextBytes: input.maxEncryptedBytes,
    });
    return {
      success: true,
      data: encrypted,
      envelope: 'jwe',
      safeKidAlias: safeKidAlias(key.kid),
      epv: 1,
    };
  } catch (error) {
    if (error instanceof SDKTokenEnvelopeError && error.code === 'TOKEN_TOO_LARGE') {
      return oversized('sdk_jwe_wrap_token_too_large');
    }
    return unavailable('sdk_jwe_wrap_failed');
  }
}

async function unwrapRuntimeSdkToken(input: {
  token: string;
  purpose: SDKTokenEnvelopePurpose;
  deps: RuntimeSdkTokenEnvelopeDeps;
  maxEncryptedBytes: number;
}): Promise<RuntimeEnvelopeResult<string>> {
  const capability = input.deps.keyProvider.getCapability();
  if (!capability.supported || !capability.canVerify) {
    return unavailable(`sdk_jwe_verify_unavailable:${capability.blockedReason ?? 'unknown'}`);
  }

  try {
    const plaintext = await unwrapCompactToken({
      token: input.token,
      purpose: input.purpose,
      maxCiphertextBytes: input.maxEncryptedBytes,
      resolveKey: (kid, purpose) => input.deps.keyProvider.resolveKey(kid, purpose),
    });
    return {
      success: true,
      data: plaintext,
      envelope: 'jwe',
      epv: 1,
    };
  } catch (error) {
    return classifyEnvelopeError(error, 'sdk_jwe_unwrap_failed');
  }
}

function verifySignedBootstrapArtifact(
  token: string,
  deps: RuntimeSdkTokenEnvelopeDeps,
): RuntimeEnvelopeResult<SDKBootstrapArtifactPayload> {
  let artifact: SDKBootstrapArtifactPayload | null;
  try {
    artifact = verifySdkBootstrapArtifact(token, deps.getBootstrapSigningSecret(token));
  } catch {
    return invalidToken('sdk_bootstrap_secret_resolution_failed');
  }

  if (!artifact || !isSdkBootstrapArtifactPayload(artifact)) {
    return invalidToken('sdk_bootstrap_signed_verify_failed');
  }
  return { success: true, data: artifact, envelope: 'signed' };
}

function verifySignedSdkSessionToken(
  token: string,
  deps: RuntimeSdkTokenEnvelopeDeps,
  envelope: SDKTokenEnvelopeMode,
): RuntimeEnvelopeResult<SDKSessionTokenPayload> {
  try {
    const payload = verifySDKSessionToken(token, deps.getSessionSigningSecret());
    return { success: true, data: payload, envelope };
  } catch (error) {
    if (error instanceof AuthError && error.code === 'EXPIRED_TOKEN') {
      return {
        success: false,
        status: 401,
        code: 'EXPIRED_SDK_TOKEN',
        logReason: 'sdk_session_expired',
      };
    }
    return invalidToken('sdk_session_signed_verify_failed');
  }
}

export function wrapRuntimeSdkBootstrapToken(
  signedToken: string,
  deps: RuntimeSdkTokenEnvelopeDeps,
): Promise<RuntimeEnvelopeResult<string>> {
  return wrapRuntimeSdkToken({
    signedToken,
    purpose: 'sdk_bootstrap',
    deps,
    maxEncryptedBytes: deps.maxEncryptedBootstrapBytes,
  });
}

export function wrapRuntimeSdkSessionToken(
  signedToken: string,
  deps: RuntimeSdkTokenEnvelopeDeps,
): Promise<RuntimeEnvelopeResult<string>> {
  return wrapRuntimeSdkToken({
    signedToken,
    purpose: 'sdk_session',
    deps,
    maxEncryptedBytes: deps.maxEncryptedSessionBytes,
  });
}

export async function verifyRuntimeSdkBootstrapToken(
  token: string,
  deps: RuntimeSdkTokenEnvelopeDeps,
): Promise<RuntimeEnvelopeResult<SDKBootstrapArtifactPayload>> {
  if (!isJweShapedToken(token)) {
    return verifySignedBootstrapArtifact(token, deps);
  }

  const unwrapped = await unwrapRuntimeSdkToken({
    token,
    purpose: 'sdk_bootstrap',
    deps,
    maxEncryptedBytes: deps.maxEncryptedBootstrapBytes,
  });
  if (!unwrapped.success) {
    return unwrapped;
  }

  const verified = verifySignedBootstrapArtifact(unwrapped.data, deps);
  if (!verified.success) {
    return verified;
  }
  return {
    success: true,
    data: verified.data,
    envelope: 'jwe',
    epv: unwrapped.epv,
  };
}

export async function verifyRuntimeSdkSessionToken(
  token: string,
  deps: RuntimeSdkTokenEnvelopeDeps,
): Promise<RuntimeEnvelopeResult<SDKSessionTokenPayload>> {
  if (!isJweShapedToken(token)) {
    return verifySignedSdkSessionToken(token, deps, 'signed');
  }

  const unwrapped = await unwrapRuntimeSdkToken({
    token,
    purpose: 'sdk_session',
    deps,
    maxEncryptedBytes: deps.maxEncryptedSessionBytes,
  });
  if (!unwrapped.success) {
    return unwrapped;
  }

  const verified = verifySignedSdkSessionToken(unwrapped.data, deps, 'jwe');
  if (!verified.success) {
    return verified;
  }
  return {
    success: true,
    data: verified.data,
    envelope: 'jwe',
    epv: unwrapped.epv,
  };
}
