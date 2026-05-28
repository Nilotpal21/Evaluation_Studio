import type { SDKChannelDoc } from '../../repos/channel-repo.js';
import { findProjectSettings } from '../../repos/project-settings-repo.js';
import { getRuntimeSdkJweKeyProvider } from './sdk-jwe-runtime-config.js';
import {
  resolveSdkTokenEnvelopePolicy,
  type SDKTokenEnvelopeBootstrapType,
  type SDKTokenEnvelopeConfiguredPolicyMode,
  type SDKTokenEnvelopePolicy,
  type SDKTokenEnvelopeResolvedPolicyMode,
} from './sdk-token-envelope-policy.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResolvedPolicyMode(value: unknown): value is SDKTokenEnvelopeResolvedPolicyMode {
  return value === 'signed' || value === 'jwe_preferred' || value === 'jwe_required';
}

function resolveProjectDefaultPolicy(
  settings: unknown,
): SDKTokenEnvelopeConfiguredPolicyMode | undefined {
  if (!isRecord(settings) || !isRecord(settings.sdkDefaults)) {
    return undefined;
  }

  const rawPolicy = settings.sdkDefaults.hostedExchangeTokenEnvelopePolicy;
  return isResolvedPolicyMode(rawPolicy) ? rawPolicy : undefined;
}

export async function resolveRuntimeSdkTokenEnvelopePolicy(input: {
  tenantId: string;
  projectId: string;
  channel: Pick<SDKChannelDoc, 'id' | 'authMode' | 'config'>;
  bootstrapType: SDKTokenEnvelopeBootstrapType;
}): Promise<SDKTokenEnvelopePolicy> {
  const projectSettings = await findProjectSettings(input.projectId, input.tenantId);
  return resolveSdkTokenEnvelopePolicy({
    tenantId: input.tenantId,
    projectId: input.projectId,
    channelId: input.channel.id,
    channelAuthMode: input.channel.authMode === 'hosted_exchange' ? 'hosted_exchange' : 'anonymous',
    bootstrapType: input.bootstrapType,
    projectDefaultPolicy: resolveProjectDefaultPolicy(projectSettings),
    channelConfig: input.channel.config,
    runtimeCapability: getRuntimeSdkJweKeyProvider().getCapability(),
  });
}
