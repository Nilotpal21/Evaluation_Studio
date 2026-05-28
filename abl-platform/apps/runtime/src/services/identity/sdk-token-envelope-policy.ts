export type SDKTokenEnvelopeMode = 'signed' | 'jwe';

export type SDKTokenEnvelopeResolvedPolicyMode = 'signed' | 'jwe_preferred' | 'jwe_required';

export type SDKTokenEnvelopeConfiguredPolicyMode = 'inherit' | SDKTokenEnvelopeResolvedPolicyMode;

export type SDKTokenEnvelopeBootstrapType =
  | 'public_key'
  | 'studio_preview'
  | 'studio_share'
  | 'customer';

export type SDKTokenEnvelopeChannelAuthMode = 'anonymous' | 'hosted_exchange';

export type RuntimeSdkJweCapabilityBlockReason =
  | 'provider_disabled'
  | 'key_provider_unavailable'
  | 'transport_budget_unverified'
  | 'diagnostics_unready'
  | 'redaction_unverified';

export interface RuntimeSdkJweCapability {
  supported: boolean;
  canIssueBootstrap: boolean;
  canIssueSession: boolean;
  canVerify: boolean;
  blockedReason?: RuntimeSdkJweCapabilityBlockReason;
}

export interface SDKTokenEnvelopePolicyInput {
  tenantId: string;
  projectId: string;
  channelId: string;
  bootstrapType: SDKTokenEnvelopeBootstrapType;
  channelAuthMode: SDKTokenEnvelopeChannelAuthMode;
  projectDefaultPolicy?: SDKTokenEnvelopeConfiguredPolicyMode;
  runtimeCapability: RuntimeSdkJweCapability;
  channelConfig?: Record<string, unknown>;
}

export type SDKTokenEnvelopePolicyReason =
  | 'project_default'
  | 'channel_override'
  | 'legacy_default'
  | 'unsupported_bootstrap_type'
  | 'keyring_unavailable'
  | 'transport_budget_unverified'
  | 'diagnostics_unready'
  | 'redaction_unverified'
  | 'strict_required';

export interface SDKTokenEnvelopePolicy {
  policyMode: SDKTokenEnvelopeResolvedPolicyMode;
  bootstrapMode: SDKTokenEnvelopeMode;
  sessionMode: SDKTokenEnvelopeMode;
  requiresEncryptedBootstrap: boolean;
  requiresEncryptedSession: boolean;
  acceptsSignedBootstrap: boolean;
  acceptsSignedSession: boolean;
  acceptsJweBootstrap: boolean;
  acceptsJweSession: boolean;
  canIssueBootstrap: boolean;
  canIssueSession: boolean;
  reason: SDKTokenEnvelopePolicyReason;
}

const CHANNEL_POLICY_CONFIG_KEY = 'sdkTokenEnvelopePolicy';

const CAPABILITY_REASON_TO_POLICY_REASON: Record<
  RuntimeSdkJweCapabilityBlockReason,
  SDKTokenEnvelopePolicyReason
> = {
  provider_disabled: 'keyring_unavailable',
  key_provider_unavailable: 'keyring_unavailable',
  transport_budget_unverified: 'transport_budget_unverified',
  diagnostics_unready: 'diagnostics_unready',
  redaction_unverified: 'redaction_unverified',
};

function isConfiguredPolicyMode(value: unknown): value is SDKTokenEnvelopeConfiguredPolicyMode {
  return (
    value === 'inherit' ||
    value === 'signed' ||
    value === 'jwe_preferred' ||
    value === 'jwe_required'
  );
}

function isResolvedPolicyMode(value: unknown): value is SDKTokenEnvelopeResolvedPolicyMode {
  return value === 'signed' || value === 'jwe_preferred' || value === 'jwe_required';
}

function resolveCapabilityReason(
  capability: RuntimeSdkJweCapability,
): SDKTokenEnvelopePolicyReason {
  return capability.blockedReason
    ? CAPABILITY_REASON_TO_POLICY_REASON[capability.blockedReason]
    : 'keyring_unavailable';
}

function canVerifyJwe(capability: RuntimeSdkJweCapability): boolean {
  return capability.supported && capability.canVerify;
}

function canIssueBootstrapJwe(capability: RuntimeSdkJweCapability): boolean {
  return capability.supported && capability.canIssueBootstrap;
}

function canIssueSessionJwe(capability: RuntimeSdkJweCapability): boolean {
  return capability.supported && capability.canIssueSession;
}

function resolveConfiguredPolicy(input: SDKTokenEnvelopePolicyInput): {
  policyMode: SDKTokenEnvelopeResolvedPolicyMode;
  reason: SDKTokenEnvelopePolicyReason;
} {
  const rawChannelPolicy = input.channelConfig?.[CHANNEL_POLICY_CONFIG_KEY];
  const channelPolicy = isConfiguredPolicyMode(rawChannelPolicy) ? rawChannelPolicy : undefined;

  if (channelPolicy && channelPolicy !== 'inherit') {
    return {
      policyMode: channelPolicy,
      reason: 'channel_override',
    };
  }

  if (isResolvedPolicyMode(input.projectDefaultPolicy)) {
    return {
      policyMode: input.projectDefaultPolicy,
      reason: 'project_default',
    };
  }

  return {
    policyMode: 'signed',
    reason: 'legacy_default',
  };
}

export function resolveSdkTokenEnvelopePolicy(
  input: SDKTokenEnvelopePolicyInput,
): SDKTokenEnvelopePolicy {
  const hostedExchangeEligible =
    input.channelAuthMode === 'hosted_exchange' && input.bootstrapType === 'customer';

  if (!hostedExchangeEligible) {
    return {
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
      reason:
        input.channelAuthMode === 'hosted_exchange'
          ? 'unsupported_bootstrap_type'
          : 'legacy_default',
    };
  }

  const configuredPolicy = resolveConfiguredPolicy(input);

  if (configuredPolicy.policyMode === 'signed') {
    return {
      policyMode: 'signed',
      bootstrapMode: 'signed',
      sessionMode: 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: canVerifyJwe(input.runtimeCapability),
      acceptsJweSession: canVerifyJwe(input.runtimeCapability),
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: configuredPolicy.reason,
    };
  }

  if (configuredPolicy.policyMode === 'jwe_preferred') {
    const bootstrapIssueReady = canIssueBootstrapJwe(input.runtimeCapability);
    const sessionIssueReady = canIssueSessionJwe(input.runtimeCapability);
    const degraded = !bootstrapIssueReady || !sessionIssueReady;

    return {
      policyMode: 'jwe_preferred',
      bootstrapMode: bootstrapIssueReady ? 'jwe' : 'signed',
      sessionMode: sessionIssueReady ? 'jwe' : 'signed',
      requiresEncryptedBootstrap: false,
      requiresEncryptedSession: false,
      acceptsSignedBootstrap: true,
      acceptsSignedSession: true,
      acceptsJweBootstrap: canVerifyJwe(input.runtimeCapability),
      acceptsJweSession: canVerifyJwe(input.runtimeCapability),
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: degraded ? resolveCapabilityReason(input.runtimeCapability) : configuredPolicy.reason,
    };
  }

  return {
    policyMode: 'jwe_required',
    bootstrapMode: 'jwe',
    sessionMode: 'jwe',
    requiresEncryptedBootstrap: true,
    requiresEncryptedSession: true,
    acceptsSignedBootstrap: false,
    acceptsSignedSession: false,
    acceptsJweBootstrap: canVerifyJwe(input.runtimeCapability),
    acceptsJweSession: canVerifyJwe(input.runtimeCapability),
    canIssueBootstrap: canIssueBootstrapJwe(input.runtimeCapability),
    canIssueSession: canIssueSessionJwe(input.runtimeCapability),
    reason:
      canIssueBootstrapJwe(input.runtimeCapability) && canIssueSessionJwe(input.runtimeCapability)
        ? 'strict_required'
        : resolveCapabilityReason(input.runtimeCapability),
  };
}
