import { CompactEncrypt } from 'jose';
import { signSdkBootstrapArtifact } from '@agent-platform/shared';
import {
  createLocalSdkJweKeyHandle,
  isCompactJwe,
  readCompactJweProtectedHeader,
  signSDKSessionToken,
  unwrapCompactToken,
  wrapCompactToken,
  type SDKJweKeyHandle,
  type SDKTokenEnvelopePurpose,
} from '@agent-platform/shared-auth';
import { describe, expect, it } from 'vitest';
import {
  createDisabledSdkJweKeyProvider,
  createStaticSdkJweKeyProvider,
  type RuntimeSdkJweKeyInput,
  type RuntimeSdkJweKeyProvider,
} from '../../services/identity/sdk-jwe-keyring.js';
import {
  resolveSdkTokenEnvelopePolicy,
  type RuntimeSdkJweCapability,
  type SDKTokenEnvelopePolicyInput,
} from '../../services/identity/sdk-token-envelope-policy.js';
import {
  verifyRuntimeSdkBootstrapToken,
  verifyRuntimeSdkSessionToken,
  wrapRuntimeSdkBootstrapToken,
  wrapRuntimeSdkSessionToken,
  type RuntimeEnvelopeResult,
  type RuntimeSdkTokenEnvelopeDeps,
} from '../../services/identity/sdk-token-envelope-runtime.js';

const SESSION_SECRET = 's'.repeat(64);
const BOOTSTRAP_SECRET = 'b'.repeat(64);
const encoder = new TextEncoder();

const READY_CAPABILITY: RuntimeSdkJweCapability = {
  supported: true,
  canIssueBootstrap: true,
  canIssueSession: true,
  canVerify: true,
};

const DISABLED_CAPABILITY: RuntimeSdkJweCapability = {
  supported: false,
  canIssueBootstrap: false,
  canIssueSession: false,
  canVerify: false,
  blockedReason: 'provider_disabled',
};

const BASE_POLICY_INPUT: SDKTokenEnvelopePolicyInput = {
  tenantId: 'tenant-hidden',
  projectId: 'project-hidden',
  channelId: 'channel-hidden',
  bootstrapType: 'customer',
  channelAuthMode: 'hosted_exchange',
  runtimeCapability: READY_CAPABILITY,
};

function keyBytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function sessionKey(kid = 'session-key', value = 1): SDKJweKeyHandle {
  return createLocalSdkJweKeyHandle({
    kid,
    purpose: 'sdk_session',
    keyBytes: keyBytes(value),
  });
}

function bootstrapKey(kid = 'bootstrap-key', value = 2): SDKJweKeyHandle {
  return createLocalSdkJweKeyHandle({
    kid,
    purpose: 'sdk_bootstrap',
    keyBytes: keyBytes(value),
  });
}

function protectedHeaderForPurpose(
  purpose: SDKTokenEnvelopePurpose,
  kid: string,
): Record<string, unknown> {
  return {
    alg: 'dir',
    enc: 'A256GCM',
    kid,
    typ: purpose === 'sdk_session' ? 'abl-sdk-session+jwe' : 'abl-sdk-bootstrap+jwe',
    cty: purpose === 'sdk_session' ? 'abl-sdk-session+jwt' : 'abl-sdk-bootstrap+hmac',
    epv: 1,
  };
}

function replaceProtectedHeader(token: string, header: Record<string, unknown>): string {
  const parts = token.split('.');
  parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url');
  return parts.join('.');
}

async function encryptWithHeader(
  header: Record<string, unknown>,
  plaintext = 'inner.signed.token',
  bytes = keyBytes(1),
): Promise<string> {
  return new CompactEncrypt(encoder.encode(plaintext)).setProtectedHeader(header).encrypt(bytes);
}

function createProvider(keys: RuntimeSdkJweKeyInput[]): RuntimeSdkJweKeyProvider {
  return createStaticSdkJweKeyProvider({ keys });
}

function createFullProvider(): RuntimeSdkJweKeyProvider {
  return createProvider([
    {
      kid: 'active',
      purposes: ['sdk_bootstrap', 'sdk_session'],
      status: 'active',
      keyBytes: keyBytes(1),
    },
    {
      kid: 'previous',
      purposes: ['sdk_bootstrap', 'sdk_session'],
      status: 'previous',
      keyBytes: keyBytes(2),
    },
    {
      kid: 'disabled',
      purposes: ['sdk_bootstrap', 'sdk_session'],
      status: 'disabled',
      keyBytes: keyBytes(3),
    },
  ]);
}

function createDeps(
  keyProvider: RuntimeSdkJweKeyProvider = createFullProvider(),
): RuntimeSdkTokenEnvelopeDeps {
  return {
    keyProvider,
    getSessionSigningSecret: () => SESSION_SECRET,
    getBootstrapSigningSecret: () => BOOTSTRAP_SECRET,
    maxEncryptedBootstrapBytes: 4096,
    maxEncryptedSessionBytes: 4096,
  };
}

function createSignedSessionToken(
  overrides: Partial<Parameters<typeof signSDKSessionToken>[0]> = {},
  secret = SESSION_SECRET,
  options: Parameters<typeof signSDKSessionToken>[2] = { expiresIn: '5m' },
): string {
  return signSDKSessionToken(
    {
      type: 'sdk_session',
      tenantId: 'tenant-hidden',
      projectId: 'project-hidden',
      channelId: 'channel-hidden',
      permissions: ['session:read', 'session:send_message'],
      bootstrapType: 'customer',
      verifiedUserId: 'verified-sensitive-user',
      tokenEnvelope: 'jwe',
      userContext: {
        userId: 'verified-sensitive-user',
        customAttributes: { policyId: 'sensitive-policy-id' },
      },
      ...overrides,
    },
    secret,
    options,
  );
}

function createSignedBootstrapToken(secret = BOOTSTRAP_SECRET, exp = Date.now() + 60_000): string {
  return signSdkBootstrapArtifact(
    {
      type: 'customer',
      tenantId: 'tenant-hidden',
      projectId: 'project-hidden',
      channelId: 'channel-hidden',
      permissions: ['session:read', 'session:send_message'],
      exp,
      verifiedUserId: 'verified-sensitive-user',
      channelArtifact: 'artifact-sensitive',
      jti: 'jti-hidden',
      userContext: {
        userId: 'verified-sensitive-user',
        customAttributes: { policyId: 'sensitive-policy-id' },
      },
    },
    secret,
  );
}

function expectFailure<T>(
  result: RuntimeEnvelopeResult<T>,
  expected: Pick<Extract<RuntimeEnvelopeResult<T>, { success: false }>, 'status' | 'code'> & {
    logReason?: string;
  },
): void {
  expect(result).toMatchObject({
    success: false,
    status: expected.status,
    code: expected.code,
    ...(expected.logReason ? { logReason: expected.logReason } : {}),
  });
  expect(JSON.stringify(result)).not.toMatch(
    /verified-sensitive-user|sensitive-policy-id|active-key|previous-key|disabled-key|unknown-kid/,
  );
}

const policyHiddenScenarios = [
  {
    name: 'absent channel and project policy remains signed legacy',
    input: {},
    expected: { policyMode: 'signed', reason: 'legacy_default', acceptsJweBootstrap: true },
  },
  {
    name: 'project inherit is not a resolved policy and falls back to signed legacy',
    input: { projectDefaultPolicy: 'inherit' as const },
    expected: { policyMode: 'signed', reason: 'legacy_default' },
  },
  {
    name: 'channel inherit allows project signed default',
    input: {
      projectDefaultPolicy: 'signed' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'inherit' },
    },
    expected: { policyMode: 'signed', reason: 'project_default' },
  },
  {
    name: 'channel inherit allows project preferred default',
    input: {
      projectDefaultPolicy: 'jwe_preferred' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'inherit' },
    },
    expected: { policyMode: 'jwe_preferred', bootstrapMode: 'jwe', sessionMode: 'jwe' },
  },
  {
    name: 'channel inherit allows project required default',
    input: {
      projectDefaultPolicy: 'jwe_required' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'inherit' },
    },
    expected: {
      policyMode: 'jwe_required',
      requiresEncryptedBootstrap: true,
      acceptsSignedSession: false,
    },
  },
  {
    name: 'invalid channel policy cannot suppress required project default',
    input: {
      projectDefaultPolicy: 'jwe_required' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'encrypted' },
    },
    expected: { policyMode: 'jwe_required', requiresEncryptedBootstrap: true },
  },
  {
    name: 'null channel policy cannot suppress required project default',
    input: {
      projectDefaultPolicy: 'jwe_required' as const,
      channelConfig: { sdkTokenEnvelopePolicy: null },
    },
    expected: { policyMode: 'jwe_required', requiresEncryptedBootstrap: true },
  },
  {
    name: 'case-mismatched channel policy cannot suppress required project default',
    input: {
      projectDefaultPolicy: 'jwe_required' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'JWE_REQUIRED' },
    },
    expected: { policyMode: 'jwe_required', requiresEncryptedBootstrap: true },
  },
  {
    name: 'channel signed override is explicit even when project is required',
    input: {
      projectDefaultPolicy: 'jwe_required' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'signed' },
    },
    expected: { policyMode: 'signed', reason: 'channel_override', acceptsSignedBootstrap: true },
  },
  {
    name: 'channel preferred override beats project signed default',
    input: {
      projectDefaultPolicy: 'signed' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
    },
    expected: { policyMode: 'jwe_preferred', reason: 'channel_override' },
  },
  {
    name: 'channel required override beats project preferred default',
    input: {
      projectDefaultPolicy: 'jwe_preferred' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
    },
    expected: { policyMode: 'jwe_required', reason: 'strict_required' },
  },
  {
    name: 'preferred mode may issue bootstrap JWE while session budget is blocked',
    input: {
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
      runtimeCapability: {
        supported: true,
        canIssueBootstrap: true,
        canIssueSession: false,
        canVerify: true,
        blockedReason: 'transport_budget_unverified' as const,
      },
    },
    expected: {
      policyMode: 'jwe_preferred',
      bootstrapMode: 'jwe',
      sessionMode: 'signed',
      reason: 'transport_budget_unverified',
    },
  },
  {
    name: 'preferred mode may issue session JWE while bootstrap capability is blocked',
    input: {
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
      runtimeCapability: {
        supported: true,
        canIssueBootstrap: false,
        canIssueSession: true,
        canVerify: true,
        blockedReason: 'key_provider_unavailable' as const,
      },
    },
    expected: {
      policyMode: 'jwe_preferred',
      bootstrapMode: 'signed',
      sessionMode: 'jwe',
      reason: 'keyring_unavailable',
    },
  },
  {
    name: 'preferred mode disables JWE acceptance when verification is not ready',
    input: {
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
      runtimeCapability: DISABLED_CAPABILITY,
    },
    expected: {
      policyMode: 'jwe_preferred',
      acceptsJweBootstrap: false,
      acceptsJweSession: false,
      bootstrapMode: 'signed',
      sessionMode: 'signed',
    },
  },
  {
    name: 'required mode fails closed when provider is disabled',
    input: {
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
      runtimeCapability: DISABLED_CAPABILITY,
    },
    expected: {
      policyMode: 'jwe_required',
      canIssueBootstrap: false,
      canIssueSession: false,
      acceptsSignedBootstrap: false,
      reason: 'keyring_unavailable',
    },
  },
  {
    name: 'required mode can verify previous JWE even when active bootstrap key is missing',
    input: {
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
      runtimeCapability: {
        supported: true,
        canIssueBootstrap: false,
        canIssueSession: true,
        canVerify: true,
        blockedReason: 'key_provider_unavailable' as const,
      },
    },
    expected: {
      policyMode: 'jwe_required',
      acceptsJweBootstrap: true,
      canIssueBootstrap: false,
      canIssueSession: true,
    },
  },
  {
    name: 'signed policy can still verify JWE during rollback when capability is ready',
    input: { channelConfig: { sdkTokenEnvelopePolicy: 'signed' } },
    expected: { policyMode: 'signed', acceptsJweBootstrap: true, acceptsJweSession: true },
  },
  {
    name: 'signed policy does not advertise JWE acceptance when capability is disabled',
    input: {
      channelConfig: { sdkTokenEnvelopePolicy: 'signed' },
      runtimeCapability: DISABLED_CAPABILITY,
    },
    expected: { policyMode: 'signed', acceptsJweBootstrap: false, acceptsJweSession: false },
  },
  {
    name: 'anonymous channel ignores required project default',
    input: {
      channelAuthMode: 'anonymous' as const,
      projectDefaultPolicy: 'jwe_required' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
    },
    expected: { policyMode: 'signed', acceptsJweBootstrap: false, reason: 'legacy_default' },
  },
  {
    name: 'public-key bootstrap remains outside first-release JWE scope',
    input: {
      bootstrapType: 'public_key' as const,
      projectDefaultPolicy: 'jwe_required' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
    },
    expected: {
      policyMode: 'signed',
      acceptsJweBootstrap: false,
      reason: 'unsupported_bootstrap_type',
    },
  },
  {
    name: 'studio preview bootstrap remains outside first-release JWE scope',
    input: {
      bootstrapType: 'studio_preview' as const,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
    },
    expected: {
      policyMode: 'signed',
      acceptsJweSession: false,
      reason: 'unsupported_bootstrap_type',
    },
  },
] satisfies Array<{
  name: string;
  input: Partial<SDKTokenEnvelopePolicyInput>;
  expected: Record<string, unknown>;
}>;

const keyringHiddenScenarios = [
  {
    name: 'active bootstrap-only key supports bootstrap issuance but not session issuance',
    keys: [
      {
        kid: 'bootstrap-active',
        purposes: ['sdk_bootstrap'],
        status: 'active',
        keyBytes: keyBytes(1),
      },
    ],
    expected: {
      supported: true,
      canIssueBootstrap: true,
      canIssueSession: false,
      canVerify: true,
      blockedReason: 'key_provider_unavailable',
    },
  },
  {
    name: 'active session-only key supports session issuance but not bootstrap issuance',
    keys: [
      {
        kid: 'session-active',
        purposes: ['sdk_session'],
        status: 'active',
        keyBytes: keyBytes(2),
      },
    ],
    expected: {
      supported: true,
      canIssueBootstrap: false,
      canIssueSession: true,
      canVerify: true,
      blockedReason: 'key_provider_unavailable',
    },
  },
  {
    name: 'previous-only keyring can verify but cannot issue',
    keys: [
      {
        kid: 'previous-only',
        purposes: ['sdk_bootstrap', 'sdk_session'],
        status: 'previous',
        keyBytes: keyBytes(3),
      },
    ],
    expected: {
      supported: true,
      canIssueBootstrap: false,
      canIssueSession: false,
      canVerify: true,
      blockedReason: 'key_provider_unavailable',
    },
  },
  {
    name: 'disabled-only keyring is unsupported',
    keys: [
      {
        kid: 'disabled-only',
        purposes: ['sdk_bootstrap', 'sdk_session'],
        status: 'disabled',
        keyBytes: keyBytes(4),
      },
    ],
    expected: {
      supported: false,
      canIssueBootstrap: false,
      canIssueSession: false,
      canVerify: false,
      blockedReason: 'key_provider_unavailable',
    },
  },
] satisfies Array<{
  name: string;
  keys: RuntimeSdkJweKeyInput[];
  expected: RuntimeSdkJweCapability;
}>;

const keyringGateScenarios = [
  {
    name: 'redaction gate blocks before diagnostics and budget gates',
    safetyGates: {
      redactionVerified: false,
      diagnosticsReady: false,
      bootstrapTransportBudgetVerified: false,
      sessionTransportBudgetVerified: false,
    },
    blockedReason: 'redaction_unverified',
  },
  {
    name: 'diagnostics gate blocks before transport budgets',
    safetyGates: {
      redactionVerified: true,
      diagnosticsReady: false,
      bootstrapTransportBudgetVerified: false,
      sessionTransportBudgetVerified: false,
    },
    blockedReason: 'diagnostics_unready',
  },
  {
    name: 'bootstrap transport budget gate blocks capability',
    safetyGates: {
      redactionVerified: true,
      diagnosticsReady: true,
      bootstrapTransportBudgetVerified: false,
      sessionTransportBudgetVerified: true,
    },
    blockedReason: 'transport_budget_unverified',
  },
  {
    name: 'session transport budget gate blocks capability',
    safetyGates: {
      redactionVerified: true,
      diagnosticsReady: true,
      bootstrapTransportBudgetVerified: true,
      sessionTransportBudgetVerified: false,
    },
    blockedReason: 'transport_budget_unverified',
  },
] satisfies Array<{
  name: string;
  safetyGates: {
    redactionVerified: boolean;
    diagnosticsReady: boolean;
    bootstrapTransportBudgetVerified: boolean;
    sessionTransportBudgetVerified: boolean;
  };
  blockedReason: RuntimeSdkJweCapability['blockedReason'];
}>;

const headerRejectScenarios = [
  {
    name: 'rejects non-dir alg',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), alg: 'A256KW' },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects missing alg',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), alg: undefined },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects non-A256GCM enc',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), enc: 'A128GCM' },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects missing enc',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), enc: undefined },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects zip compression',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), zip: 'DEF' },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects bootstrap typ for session purpose',
    header: {
      ...protectedHeaderForPurpose('sdk_session', 'session-key'),
      typ: 'abl-sdk-bootstrap+jwe',
    },
    code: 'INVALID_HEADER',
  },
  {
    name: 'rejects missing typ',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), typ: undefined },
    code: 'INVALID_HEADER',
  },
  {
    name: 'rejects generic JWT cty',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), cty: 'JWT' },
    code: 'INVALID_HEADER',
  },
  {
    name: 'rejects bootstrap cty for session purpose',
    header: {
      ...protectedHeaderForPurpose('sdk_session', 'session-key'),
      cty: 'abl-sdk-bootstrap+hmac',
    },
    code: 'INVALID_HEADER',
  },
  {
    name: 'rejects missing cty',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), cty: undefined },
    code: 'INVALID_HEADER',
  },
  {
    name: 'rejects future envelope version',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), epv: 2 },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects string envelope version',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), epv: '1' },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects missing envelope version',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), epv: undefined },
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects missing kid',
    header: { ...protectedHeaderForPurpose('sdk_session', 'session-key'), kid: undefined },
    code: 'INVALID_HEADER',
  },
  {
    name: 'rejects empty kid',
    header: { ...protectedHeaderForPurpose('sdk_session', ''), kid: '' },
    code: 'INVALID_HEADER',
  },
  {
    name: 'rejects whitespace kid',
    header: { ...protectedHeaderForPurpose('sdk_session', '   '), kid: '   ' },
    code: 'INVALID_HEADER',
  },
] satisfies Array<{ name: string; header: Record<string, unknown>; code: string }>;

const malformedTokenScenarios = [
  { name: 'empty token', token: '', code: 'INVALID_TOKEN' },
  { name: 'blank token', token: '   ', code: 'INVALID_TOKEN' },
  {
    name: 'two segment legacy bootstrap shape',
    token: 'payload.signature',
    code: 'INVALID_HEADER',
  },
  { name: 'three segment signed JWT shape', token: 'a.b.c', code: 'INVALID_HEADER' },
  { name: 'four segment partial JWE shape', token: 'a.b.c.d', code: 'INVALID_HEADER' },
  { name: 'six segment overlong shape', token: 'a.b.c.d.e.f', code: 'INVALID_HEADER' },
] satisfies Array<{ name: string; token: string; code: string }>;

function mutateCompactTokenSegment(
  token: string,
  segmentIndex: number,
  mutate: (segment: string) => string,
): string {
  const parts = token.split('.');
  parts[segmentIndex] = mutate(parts[segmentIndex] ?? '');
  return parts.join('.');
}

const compactShapeRejectScenarios = [
  {
    name: 'rejects non-empty encrypted key segment for direct encryption mode',
    mutate: (token: string) => mutateCompactTokenSegment(token, 1, () => 'wrapped-key'),
    code: 'UNSUPPORTED_ENVELOPE',
  },
  {
    name: 'rejects padded protected header',
    mutate: (token: string) => mutateCompactTokenSegment(token, 0, (segment) => `${segment}=`),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects padded initialization vector',
    mutate: (token: string) => mutateCompactTokenSegment(token, 2, (segment) => `${segment}=`),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects padded ciphertext',
    mutate: (token: string) => mutateCompactTokenSegment(token, 3, (segment) => `${segment}=`),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects padded authentication tag',
    mutate: (token: string) => mutateCompactTokenSegment(token, 4, (segment) => `${segment}=`),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects plus character in protected header segment',
    mutate: (token: string) => mutateCompactTokenSegment(token, 0, (segment) => `${segment}+`),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects slash character in initialization vector segment',
    mutate: (token: string) => mutateCompactTokenSegment(token, 2, (segment) => `${segment}/`),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects newline in ciphertext segment',
    mutate: (token: string) => mutateCompactTokenSegment(token, 3, (segment) => `${segment}\n`),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects empty initialization vector segment',
    mutate: (token: string) => mutateCompactTokenSegment(token, 2, () => ''),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects empty ciphertext segment',
    mutate: (token: string) => mutateCompactTokenSegment(token, 3, () => ''),
    code: 'INVALID_TOKEN',
  },
  {
    name: 'rejects empty authentication tag segment',
    mutate: (token: string) => mutateCompactTokenSegment(token, 4, () => ''),
    code: 'INVALID_TOKEN',
  },
] satisfies Array<{
  name: string;
  mutate: (token: string) => string;
  code: string;
}>;

const keyConstructionRejectScenarios = [
  {
    name: 'rejects zero-length key bytes',
    input: { kid: 'bad-zero', purpose: 'sdk_session' as const, keyBytes: new Uint8Array(0) },
  },
  {
    name: 'rejects short A256GCM key bytes',
    input: { kid: 'bad-short', purpose: 'sdk_session' as const, keyBytes: keyBytes(1, 31) },
  },
  {
    name: 'rejects long A256GCM key bytes',
    input: { kid: 'bad-long', purpose: 'sdk_session' as const, keyBytes: keyBytes(1, 33) },
  },
  {
    name: 'rejects empty key id',
    input: { kid: '', purpose: 'sdk_session' as const, keyBytes: keyBytes(1) },
  },
  {
    name: 'rejects whitespace key id',
    input: { kid: '   ', purpose: 'sdk_session' as const, keyBytes: keyBytes(1) },
  },
] satisfies Array<{
  name: string;
  input: Parameters<typeof createLocalSdkJweKeyHandle>[0];
}>;

const runtimeFailureScenarios = [
  {
    name: 'unknown session kid returns generic invalid token',
    makeToken: async () =>
      encryptWithHeader(
        protectedHeaderForPurpose('sdk_session', 'unknown-kid'),
        createSignedSessionToken(),
      ),
    verify: (token: string) => verifyRuntimeSdkSessionToken(token, createDeps()),
    expected: { status: 401, code: 'INVALID_SDK_TOKEN', logReason: 'sdk_jwe_unwrap_failed' },
  },
  {
    name: 'disabled session kid returns generic invalid token',
    makeToken: async () =>
      encryptWithHeader(
        protectedHeaderForPurpose('sdk_session', 'disabled'),
        createSignedSessionToken(),
        keyBytes(3),
      ),
    verify: (token: string) => verifyRuntimeSdkSessionToken(token, createDeps()),
    expected: { status: 401, code: 'INVALID_SDK_TOKEN', logReason: 'sdk_jwe_unwrap_failed' },
  },
  {
    name: 'unknown bootstrap kid returns generic invalid token',
    makeToken: async () =>
      encryptWithHeader(
        protectedHeaderForPurpose('sdk_bootstrap', 'unknown-kid'),
        createSignedBootstrapToken(),
      ),
    verify: (token: string) => verifyRuntimeSdkBootstrapToken(token, createDeps()),
    expected: { status: 401, code: 'INVALID_SDK_TOKEN', logReason: 'sdk_jwe_unwrap_failed' },
  },
  {
    name: 'session verifier rejects bootstrap-purpose JWE',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedBootstrapToken(),
        purpose: 'sdk_bootstrap',
        key: bootstrapKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkSessionToken(token, createDeps()),
    expected: { status: 401, code: 'INVALID_SDK_TOKEN', logReason: 'sdk_jwe_unwrap_failed' },
  },
  {
    name: 'bootstrap verifier rejects session-purpose JWE',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedSessionToken(),
        purpose: 'sdk_session',
        key: sessionKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkBootstrapToken(token, createDeps()),
    expected: { status: 401, code: 'INVALID_SDK_TOKEN', logReason: 'sdk_jwe_unwrap_failed' },
  },
  {
    name: 'session JWE with wrong inner signing secret is invalid',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedSessionToken({}, 'wrong-session-secret'.repeat(4)),
        purpose: 'sdk_session',
        key: sessionKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkSessionToken(token, createDeps()),
    expected: {
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_session_signed_verify_failed',
    },
  },
  {
    name: 'session-purpose JWE carrying signed bootstrap artifact is invalid',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedBootstrapToken(),
        purpose: 'sdk_session',
        key: sessionKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkSessionToken(token, createDeps()),
    expected: {
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_session_signed_verify_failed',
    },
  },
  {
    name: 'bootstrap-purpose JWE carrying signed SDK session JWT is invalid',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedSessionToken(),
        purpose: 'sdk_bootstrap',
        key: bootstrapKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkBootstrapToken(token, createDeps()),
    expected: {
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_bootstrap_signed_verify_failed',
    },
  },
  {
    name: 'expired inner SDK session JWT stays expired after decrypt',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedSessionToken({}, SESSION_SECRET, { expiresIn: '-1s' }),
        purpose: 'sdk_session',
        key: sessionKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkSessionToken(token, createDeps()),
    expected: {
      status: 401,
      code: 'EXPIRED_SDK_TOKEN',
      logReason: 'sdk_session_expired',
    },
  },
  {
    name: 'expired inner hosted exchange bootstrap artifact stays invalid after decrypt',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedBootstrapToken(BOOTSTRAP_SECRET, Date.now() - 60_000),
        purpose: 'sdk_bootstrap',
        key: bootstrapKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkBootstrapToken(token, createDeps()),
    expected: {
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_bootstrap_signed_verify_failed',
    },
  },
  {
    name: 'bootstrap JWE with wrong inner signing secret is invalid',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedBootstrapToken('wrong-bootstrap-secret'.repeat(4)),
        purpose: 'sdk_bootstrap',
        key: bootstrapKey('active', 1),
      }),
    verify: (token: string) => verifyRuntimeSdkBootstrapToken(token, createDeps()),
    expected: {
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_bootstrap_signed_verify_failed',
    },
  },
  {
    name: 'oversized encrypted session token returns size failure before decrypt',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedSessionToken(),
        purpose: 'sdk_session',
        key: sessionKey('active', 1),
      }),
    verify: (token: string) =>
      verifyRuntimeSdkSessionToken(token, { ...createDeps(), maxEncryptedSessionBytes: 16 }),
    expected: { status: 400, code: 'SDK_TOKEN_TOO_LARGE', logReason: 'sdk_jwe_unwrap_failed' },
  },
  {
    name: 'oversized encrypted bootstrap token returns size failure before decrypt',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedBootstrapToken(),
        purpose: 'sdk_bootstrap',
        key: bootstrapKey('active', 1),
      }),
    verify: (token: string) =>
      verifyRuntimeSdkBootstrapToken(token, { ...createDeps(), maxEncryptedBootstrapBytes: 16 }),
    expected: { status: 400, code: 'SDK_TOKEN_TOO_LARGE', logReason: 'sdk_jwe_unwrap_failed' },
  },
  {
    name: 'disabled provider cannot verify JWE even if token was previously issued',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedSessionToken(),
        purpose: 'sdk_session',
        key: sessionKey('active', 1),
      }),
    verify: (token: string) =>
      verifyRuntimeSdkSessionToken(token, createDeps(createDisabledSdkJweKeyProvider())),
    expected: {
      status: 503,
      code: 'SDK_JWE_UNAVAILABLE',
      logReason: 'sdk_jwe_verify_unavailable:provider_disabled',
    },
  },
  {
    name: 'key resolver exception is normalized to generic decrypt failure',
    makeToken: async () =>
      wrapCompactToken({
        plaintext: createSignedSessionToken(),
        purpose: 'sdk_session',
        key: sessionKey('active', 1),
      }),
    verify: (token: string) =>
      verifyRuntimeSdkSessionToken(token, {
        ...createDeps(),
        keyProvider: {
          getCapability: () => READY_CAPABILITY,
          getActiveKey: () => null,
          resolveKey: () => {
            throw new Error('backend unavailable with active');
          },
          listSafeMetadata: () => [],
        },
      }),
    expected: {
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      logReason: 'sdk_jwe_unwrap_failed',
    },
  },
] satisfies Array<{
  name: string;
  makeToken: () => Promise<string>;
  verify: (token: string) => Promise<RuntimeEnvelopeResult<unknown>>;
  expected: { status: 400 | 401 | 503; code: string; logReason: string };
}>;

const hiddenScenarioCount =
  policyHiddenScenarios.length +
  keyringHiddenScenarios.length +
  keyringGateScenarios.length +
  headerRejectScenarios.length +
  malformedTokenScenarios.length +
  compactShapeRejectScenarios.length +
  keyConstructionRejectScenarios.length +
  runtimeFailureScenarios.length +
  11;

describe('ABLP-862 SDK JWE hidden scenario coverage', () => {
  it('locks at least fifty additional hidden scenario cases outside the slower E2E harness', () => {
    expect(hiddenScenarioCount).toBeGreaterThanOrEqual(50);
  });

  describe('policy resolver hidden scenarios', () => {
    it.each(policyHiddenScenarios)('$name', ({ input, expected }) => {
      expect(
        resolveSdkTokenEnvelopePolicy({
          ...BASE_POLICY_INPUT,
          ...input,
          runtimeCapability: input.runtimeCapability ?? READY_CAPABILITY,
        }),
      ).toMatchObject(expected);
    });
  });

  describe('keyring hidden scenarios', () => {
    it.each(keyringHiddenScenarios)('$name', ({ keys, expected }) => {
      expect(createProvider(keys).getCapability()).toEqual(expected);
    });

    it.each(keyringGateScenarios)('$name', ({ safetyGates, blockedReason }) => {
      const provider = createStaticSdkJweKeyProvider({
        keys: [
          {
            kid: 'active',
            purposes: ['sdk_bootstrap', 'sdk_session'],
            status: 'active',
            keyBytes: keyBytes(1),
          },
        ],
        safetyGates,
      });

      expect(provider.getCapability()).toMatchObject({
        supported: false,
        canIssueBootstrap: false,
        canIssueSession: false,
        canVerify: false,
        blockedReason,
      });
    });

    it('allows the same kid for distinct purposes without cross-purpose resolution', () => {
      const provider = createProvider([
        {
          kid: 'shared-kid',
          purposes: ['sdk_bootstrap'],
          status: 'active',
          keyBytes: keyBytes(1),
        },
        {
          kid: 'shared-kid',
          purposes: ['sdk_session'],
          status: 'active',
          keyBytes: keyBytes(2),
        },
      ]);

      expect(provider.getActiveKey('sdk_bootstrap')).toMatchObject({ kid: 'shared-kid' });
      expect(provider.getActiveKey('sdk_session')).toMatchObject({ kid: 'shared-kid' });
      expect(provider.resolveKey('shared-kid', 'sdk_bootstrap')).toMatchObject({
        purpose: 'sdk_bootstrap',
      });
      expect(provider.resolveKey('shared-kid', 'sdk_session')).toMatchObject({
        purpose: 'sdk_session',
      });
    });

    it('deduplicates repeated purposes on one key record', () => {
      const provider = createProvider([
        {
          kid: 'deduped',
          purposes: ['sdk_session', 'sdk_session'],
          status: 'active',
          keyBytes: keyBytes(3),
        },
      ]);

      expect(provider.listSafeMetadata()).toEqual([
        { kid: 'deduped', purposes: ['sdk_session'], status: 'active', alg: 'dir' },
      ]);
    });

    it('defensively copies metadata arrays returned to diagnostics', () => {
      const provider = createFullProvider();
      const metadata = provider.listSafeMetadata();

      metadata[0]?.purposes.splice(0);

      expect(provider.listSafeMetadata()[0]?.purposes).toEqual(['sdk_bootstrap', 'sdk_session']);
    });

    it('defensively copies raw key bytes supplied at construction time', async () => {
      const rawBytes = keyBytes(9);
      const provider = createProvider([
        {
          kid: 'copied-key',
          purposes: ['sdk_session'],
          status: 'active',
          keyBytes: rawBytes,
        },
      ]);
      rawBytes.fill(7);

      const wrapped = await wrapRuntimeSdkSessionToken(
        createSignedSessionToken(),
        createDeps(provider),
      );
      expect(wrapped).toMatchObject({ success: true, envelope: 'jwe' });
      if (!wrapped.success) {
        throw new Error(wrapped.logReason);
      }
      await expect(
        verifyRuntimeSdkSessionToken(wrapped.data, createDeps(provider)),
      ).resolves.toMatchObject({ success: true, envelope: 'jwe' });
    });

    it('never serializes key bytes through safe metadata or active key handles', () => {
      const provider = createFullProvider();
      const serialized = JSON.stringify({
        metadata: provider.listSafeMetadata(),
        active: provider.getActiveKey('sdk_session'),
      });

      expect(serialized).not.toMatch(/1,1,1|2,2,2|keyBytes|material|secret/i);
    });

    it('does not return disabled keys for active issuance or verification', () => {
      const provider = createProvider([
        {
          kid: 'disabled-active-looking-key',
          purposes: ['sdk_session'],
          status: 'disabled',
          keyBytes: keyBytes(8),
        },
      ]);

      expect(provider.getActiveKey('sdk_session')).toBeNull();
      expect(provider.resolveKey('disabled-active-looking-key', 'sdk_session')).toBeNull();
    });
  });

  describe('shared envelope hidden scenarios', () => {
    it.each(headerRejectScenarios)('$name', async ({ header, code }) => {
      const valid = await wrapCompactToken({
        plaintext: 'inner.signed.token',
        purpose: 'sdk_session',
        key: sessionKey(),
      });
      const token = replaceProtectedHeader(valid, header);

      expect(readCompactJweProtectedHeader(token)).toBeNull();
      await expect(
        unwrapCompactToken({
          token,
          purpose: 'sdk_session',
          resolveKey: () => sessionKey(),
        }),
      ).rejects.toMatchObject({ code });
    });

    it.each(malformedTokenScenarios)('$name', async ({ token, code }) => {
      expect(isCompactJwe(token)).toBe(false);
      await expect(
        unwrapCompactToken({
          token,
          purpose: 'sdk_session',
          resolveKey: () => sessionKey(),
        }),
      ).rejects.toMatchObject({ code });
    });

    it.each(compactShapeRejectScenarios)('$name', async ({ mutate, code }) => {
      const valid = await wrapCompactToken({
        plaintext: 'inner.signed.token',
        purpose: 'sdk_session',
        key: sessionKey(),
      });
      const token = mutate(valid);

      await expect(
        unwrapCompactToken({
          token,
          purpose: 'sdk_session',
          resolveKey: () => sessionKey(),
        }),
      ).rejects.toMatchObject({ code });
    });

    it.each(keyConstructionRejectScenarios)('$name', ({ input }) => {
      expect(() => createLocalSdkJweKeyHandle(input)).toThrow();
    });

    it('rejects duplicate key records for the same kid and purpose', () => {
      expect(() =>
        createProvider([
          {
            kid: 'duplicate',
            purposes: ['sdk_session'],
            status: 'active',
            keyBytes: keyBytes(1),
          },
          {
            kid: 'duplicate',
            purposes: ['sdk_session'],
            status: 'previous',
            keyBytes: keyBytes(2),
          },
        ]),
      ).toThrow(/Duplicate SDK JWE key/);
    });

    it('rejects plaintext that becomes too large after decrypt', async () => {
      const token = await wrapCompactToken({
        plaintext: 'large-plaintext'.repeat(20),
        purpose: 'sdk_session',
        key: sessionKey(),
      });

      await expect(
        unwrapCompactToken({
          token,
          purpose: 'sdk_session',
          maxPlaintextBytes: 16,
          resolveKey: () => sessionKey(),
        }),
      ).rejects.toMatchObject({ code: 'TOKEN_TOO_LARGE' });
    });

    it('normalizes key resolver exceptions without exposing backend details', async () => {
      const token = await wrapCompactToken({
        plaintext: 'inner.signed.token',
        purpose: 'sdk_session',
        key: sessionKey(),
      });

      await expect(
        unwrapCompactToken({
          token,
          purpose: 'sdk_session',
          resolveKey: () => {
            throw new Error('key vault outage for session-key');
          },
        }),
      ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    });

    it('treats a valid protected header as format detection only, not successful decrypt', async () => {
      const headerOnlyToken = [
        Buffer.from(
          JSON.stringify(protectedHeaderForPurpose('sdk_session', 'session-key')),
        ).toString('base64url'),
        '',
        'iv',
        'ciphertext',
        'tag',
      ].join('.');

      expect(isCompactJwe(headerOnlyToken)).toBe(true);
      await expect(
        unwrapCompactToken({
          token: headerOnlyToken,
          purpose: 'sdk_session',
          resolveKey: () => sessionKey(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('rejects plaintext size before encryption', async () => {
      await expect(
        wrapCompactToken({
          plaintext: 'sensitive'.repeat(10),
          purpose: 'sdk_session',
          key: sessionKey(),
          maxPlaintextBytes: 16,
        }),
      ).rejects.toMatchObject({ code: 'TOKEN_TOO_LARGE' });
    });

    it('rejects ciphertext size after encryption', async () => {
      await expect(
        wrapCompactToken({
          plaintext: 'inner.signed.token',
          purpose: 'sdk_session',
          key: sessionKey(),
          maxCiphertextBytes: 16,
        }),
      ).rejects.toMatchObject({ code: 'TOKEN_TOO_LARGE' });
    });

    it('rejects key handles that were fabricated outside the provider factory', async () => {
      const forgedKey = {
        kid: 'forged',
        purpose: 'sdk_session',
        alg: 'dir',
        toJSON: () => ({ kid: 'forged', purpose: 'sdk_session', alg: 'dir' }),
      } as SDKJweKeyHandle;

      await expect(
        wrapCompactToken({
          plaintext: 'inner.signed.token',
          purpose: 'sdk_session',
          key: forgedKey,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    });

    it('rejects wrong-purpose key handles during wrap', async () => {
      await expect(
        wrapCompactToken({
          plaintext: 'inner.signed.token',
          purpose: 'sdk_session',
          key: bootstrapKey(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PURPOSE' });
    });

    it('rejects wrong-purpose key handles returned by a resolver', async () => {
      const token = await wrapCompactToken({
        plaintext: 'inner.signed.token',
        purpose: 'sdk_session',
        key: sessionKey(),
      });

      await expect(
        unwrapCompactToken({
          token,
          purpose: 'sdk_session',
          resolveKey: () => bootstrapKey('session-key'),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PURPOSE' });
    });
  });

  describe('runtime wrapper hidden scenarios', () => {
    it.each(runtimeFailureScenarios)('$name', async ({ makeToken, verify, expected }) => {
      const token = await makeToken();

      expectFailure(await verify(token), expected);
    });

    it('verifies previous session keys but never uses them for new issuance', async () => {
      const previousProvider = createProvider([
        {
          kid: 'previous',
          purposes: ['sdk_session'],
          status: 'previous',
          keyBytes: keyBytes(2),
        },
      ]);
      const token = await wrapCompactToken({
        plaintext: createSignedSessionToken(),
        purpose: 'sdk_session',
        key: sessionKey('previous', 2),
      });

      await expect(
        verifyRuntimeSdkSessionToken(token, createDeps(previousProvider)),
      ).resolves.toMatchObject({ success: true, envelope: 'jwe' });
      await expect(
        wrapRuntimeSdkSessionToken(createSignedSessionToken(), createDeps(previousProvider)),
      ).resolves.toMatchObject({
        success: false,
        status: 503,
        code: 'SDK_JWE_UNAVAILABLE',
      });
    });

    it('verifies previous bootstrap keys but never uses them for new issuance', async () => {
      const previousProvider = createProvider([
        {
          kid: 'previous',
          purposes: ['sdk_bootstrap'],
          status: 'previous',
          keyBytes: keyBytes(2),
        },
      ]);
      const token = await wrapCompactToken({
        plaintext: createSignedBootstrapToken(),
        purpose: 'sdk_bootstrap',
        key: bootstrapKey('previous', 2),
      });

      await expect(
        verifyRuntimeSdkBootstrapToken(token, createDeps(previousProvider)),
      ).resolves.toMatchObject({ success: true, envelope: 'jwe' });
      await expect(
        wrapRuntimeSdkBootstrapToken(createSignedBootstrapToken(), createDeps(previousProvider)),
      ).resolves.toMatchObject({
        success: false,
        status: 503,
        code: 'SDK_JWE_UNAVAILABLE',
      });
    });

    it('keeps signed session verification available when JWE provider is disabled', async () => {
      await expect(
        verifyRuntimeSdkSessionToken(
          createSignedSessionToken(),
          createDeps(createDisabledSdkJweKeyProvider()),
        ),
      ).resolves.toMatchObject({
        success: true,
        envelope: 'signed',
        data: { channelId: 'channel-hidden' },
      });
    });

    it('keeps signed bootstrap verification available when JWE provider is disabled', async () => {
      await expect(
        verifyRuntimeSdkBootstrapToken(
          createSignedBootstrapToken(),
          createDeps(createDisabledSdkJweKeyProvider()),
        ),
      ).resolves.toMatchObject({
        success: true,
        envelope: 'signed',
        data: { channelId: 'channel-hidden' },
      });
    });
  });
});
