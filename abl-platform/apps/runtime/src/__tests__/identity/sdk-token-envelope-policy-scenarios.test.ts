import { describe, expect, it } from 'vitest';
import {
  resolveSdkTokenEnvelopePolicy,
  type RuntimeSdkJweCapability,
  type SDKTokenEnvelopePolicy,
  type SDKTokenEnvelopePolicyInput,
} from '../../services/identity/sdk-token-envelope-policy.js';

const READY_CAPABILITY: RuntimeSdkJweCapability = {
  supported: true,
  canIssueBootstrap: true,
  canIssueSession: true,
  canVerify: true,
};

const REDACTION_BLOCKED_CAPABILITY: RuntimeSdkJweCapability = {
  supported: true,
  canIssueBootstrap: false,
  canIssueSession: false,
  canVerify: true,
  blockedReason: 'redaction_unverified',
};

const TRANSPORT_BLOCKED_CAPABILITY: RuntimeSdkJweCapability = {
  supported: true,
  canIssueBootstrap: true,
  canIssueSession: false,
  canVerify: true,
  blockedReason: 'transport_budget_unverified',
};

const DISABLED_CAPABILITY: RuntimeSdkJweCapability = {
  supported: false,
  canIssueBootstrap: false,
  canIssueSession: false,
  canVerify: false,
  blockedReason: 'provider_disabled',
};

const REQUIRED_BLOCKER_CAPABILITIES = [
  {
    blockedReason: 'provider_disabled',
    expectedReason: 'keyring_unavailable',
  },
  {
    blockedReason: 'key_provider_unavailable',
    expectedReason: 'keyring_unavailable',
  },
  {
    blockedReason: 'transport_budget_unverified',
    expectedReason: 'transport_budget_unverified',
  },
  {
    blockedReason: 'diagnostics_unready',
    expectedReason: 'diagnostics_unready',
  },
  {
    blockedReason: 'redaction_unverified',
    expectedReason: 'redaction_unverified',
  },
] satisfies Array<{
  blockedReason: RuntimeSdkJweCapability['blockedReason'];
  expectedReason: SDKTokenEnvelopePolicy['reason'];
}>;

const BASE_INPUT: SDKTokenEnvelopePolicyInput = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  channelId: 'channel-1',
  bootstrapType: 'customer',
  channelAuthMode: 'hosted_exchange',
  runtimeCapability: READY_CAPABILITY,
};

type ExpectedPolicyFields = Pick<
  SDKTokenEnvelopePolicy,
  | 'policyMode'
  | 'bootstrapMode'
  | 'sessionMode'
  | 'requiresEncryptedBootstrap'
  | 'requiresEncryptedSession'
  | 'acceptsSignedBootstrap'
  | 'acceptsSignedSession'
  | 'acceptsJweBootstrap'
  | 'acceptsJweSession'
  | 'canIssueBootstrap'
  | 'canIssueSession'
  | 'reason'
>;

interface Scenario {
  name: string;
  input: SDKTokenEnvelopePolicyInput;
  expected: ExpectedPolicyFields;
}

const scenarios = [
  {
    name: 'legacy hosted_exchange channels stay signed when no project or channel policy exists',
    input: BASE_INPUT,
    expected: {
      policyMode: 'signed',
      bootstrapMode: 'signed',
      sessionMode: 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'legacy_default',
    },
  },
  {
    name: 'anonymous channels ignore JWE policy and keep signed compatibility',
    input: {
      ...BASE_INPUT,
      channelAuthMode: 'anonymous',
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
      projectDefaultPolicy: 'jwe_required',
    },
    expected: {
      policyMode: 'signed',
      bootstrapMode: 'signed',
      sessionMode: 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: false,
      acceptsJweSession: false,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'legacy_default',
    },
  },
  {
    name: 'non-customer hosted_exchange bootstrap types are outside first-release JWE scope',
    input: {
      ...BASE_INPUT,
      bootstrapType: 'studio_preview',
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
    },
    expected: {
      policyMode: 'signed',
      bootstrapMode: 'signed',
      sessionMode: 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: false,
      acceptsJweSession: false,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'unsupported_bootstrap_type',
    },
  },
  {
    name: 'project default can prefer JWE when channel inherits',
    input: {
      ...BASE_INPUT,
      projectDefaultPolicy: 'jwe_preferred',
      channelConfig: { sdkTokenEnvelopePolicy: 'inherit' },
    },
    expected: {
      policyMode: 'jwe_preferred',
      bootstrapMode: 'jwe',
      sessionMode: 'jwe',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'project_default',
    },
  },
  {
    name: 'channel policy overrides a signed project default',
    input: {
      ...BASE_INPUT,
      projectDefaultPolicy: 'signed',
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
    },
    expected: {
      policyMode: 'jwe_required',
      bootstrapMode: 'jwe',
      sessionMode: 'jwe',
      requiresEncryptedBootstrap: true,
      requiresEncryptedSession: true,
      acceptsSignedBootstrap: false,
      acceptsSignedSession: false,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'strict_required',
    },
  },
  {
    name: 'channel signed policy can intentionally override a required project default',
    input: {
      ...BASE_INPUT,
      projectDefaultPolicy: 'jwe_required',
      channelConfig: { sdkTokenEnvelopePolicy: 'signed' },
    },
    expected: {
      policyMode: 'signed',
      bootstrapMode: 'signed',
      sessionMode: 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'channel_override',
    },
  },
  {
    name: 'preferred mode downgrades issuance to signed when redaction preflight is blocked',
    input: {
      ...BASE_INPUT,
      runtimeCapability: REDACTION_BLOCKED_CAPABILITY,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
    },
    expected: {
      policyMode: 'jwe_preferred',
      bootstrapMode: 'signed',
      sessionMode: 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'redaction_unverified',
    },
  },
  {
    name: 'preferred mode can issue bootstrap JWE while keeping session signed when transport is blocked',
    input: {
      ...BASE_INPUT,
      runtimeCapability: TRANSPORT_BLOCKED_CAPABILITY,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
    },
    expected: {
      policyMode: 'jwe_preferred',
      bootstrapMode: 'jwe',
      sessionMode: 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'transport_budget_unverified',
    },
  },
  {
    name: 'required mode fails closed instead of downgrading when provider is disabled',
    input: {
      ...BASE_INPUT,
      runtimeCapability: DISABLED_CAPABILITY,
      channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
    },
    expected: {
      policyMode: 'jwe_required',
      bootstrapMode: 'jwe',
      sessionMode: 'jwe',
      requiresEncryptedBootstrap: true,
      requiresEncryptedSession: true,
      acceptsSignedBootstrap: false,
      acceptsSignedSession: false,
      acceptsJweBootstrap: false,
      acceptsJweSession: false,
      canIssueBootstrap: false,
      canIssueSession: false,
      reason: 'keyring_unavailable',
    },
  },
  {
    name: 'invalid channel policy is ignored and project default remains authoritative',
    input: {
      ...BASE_INPUT,
      projectDefaultPolicy: 'jwe_preferred',
      channelConfig: { sdkTokenEnvelopePolicy: 'encrypted' },
    },
    expected: {
      policyMode: 'jwe_preferred',
      bootstrapMode: 'jwe',
      sessionMode: 'jwe',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'project_default',
    },
  },
] satisfies Scenario[];

describe('sdk token envelope policy scenarios', () => {
  it.each(scenarios)('$name', ({ input, expected }) => {
    expect(resolveSdkTokenEnvelopePolicy(input)).toMatchObject(expected);
  });

  it.each(REQUIRED_BLOCKER_CAPABILITIES)(
    'keeps jwe_required fail-closed when capability is blocked by $blockedReason',
    ({ blockedReason, expectedReason }) => {
      expect(
        resolveSdkTokenEnvelopePolicy({
          ...BASE_INPUT,
          runtimeCapability: {
            supported: blockedReason !== 'provider_disabled',
            canIssueBootstrap: false,
            canIssueSession: false,
            canVerify: blockedReason !== 'provider_disabled',
            blockedReason,
          },
          channelConfig: { sdkTokenEnvelopePolicy: 'jwe_required' },
        }),
      ).toMatchObject({
        policyMode: 'jwe_required',
        bootstrapMode: 'jwe',
        sessionMode: 'jwe',
        requiresEncryptedBootstrap: true,
        requiresEncryptedSession: true,
        acceptsSignedBootstrap: false,
        acceptsSignedSession: false,
        canIssueBootstrap: false,
        canIssueSession: false,
        reason: expectedReason,
      });
    },
  );
});
