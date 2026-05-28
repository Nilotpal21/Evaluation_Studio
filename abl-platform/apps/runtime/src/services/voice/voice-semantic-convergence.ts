import type { RealtimeVoiceProviderCapabilityProfile } from '@abl/compiler/platform/llm/realtime/types.js';
import { VOICE_PARITY_FAMILY_IDS, type VoiceParityFamily } from './voice-dsl-parity.js';

export type VoiceSemanticConvergenceMode = 'off' | 'shadow' | 'enforce';

export type VoiceSemanticConvergenceStrategy = 'legacy' | 'coordinator_tool';

export interface VoiceSemanticConvergencePlan {
  family: VoiceParityFamily;
  mode: VoiceSemanticConvergenceMode;
  strategy: VoiceSemanticConvergenceStrategy;
  providerType?: RealtimeVoiceProviderCapabilityProfile['providerType'];
  reason:
    | 'global_mode_off'
    | 'family_not_allowlisted'
    | 'missing_tool_result_injection'
    | 'missing_coordinator_executor'
    | 'shadow_coordinator_tool'
    | 'enforce_coordinator_tool';
  notes: string[];
}

function parseMode(rawValue: string | undefined): VoiceSemanticConvergenceMode {
  const normalized = rawValue?.trim().toLowerCase();
  if (normalized === 'shadow' || normalized === 'enforce') {
    return normalized;
  }
  return 'off';
}

function parseFamilyAllowlist(rawValue: string | undefined): Set<VoiceParityFamily> | null {
  const knownFamilies = new Set<string>(VOICE_PARITY_FAMILY_IDS);
  const normalized = rawValue
    ?.split(',')
    .map((value) => value.trim())
    .filter((value): value is VoiceParityFamily => knownFamilies.has(value));

  if (!normalized || normalized.length === 0) {
    return null;
  }

  return new Set(normalized);
}

export function resolveVoiceSemanticConvergencePlan(params: {
  family: VoiceParityFamily;
  providerCapabilityProfile?: RealtimeVoiceProviderCapabilityProfile;
  hasCoordinatorExecutor: boolean;
}): VoiceSemanticConvergencePlan {
  const mode = parseMode(process.env.VOICE_SEMANTIC_CONVERGENCE_MODE);
  if (mode === 'off') {
    return {
      family: params.family,
      mode,
      strategy: 'legacy',
      providerType: params.providerCapabilityProfile?.providerType,
      reason: 'global_mode_off',
      notes: [],
    };
  }

  const allowlist = parseFamilyAllowlist(process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES);
  if (allowlist && !allowlist.has(params.family)) {
    return {
      family: params.family,
      mode: 'off',
      strategy: 'legacy',
      providerType: params.providerCapabilityProfile?.providerType,
      reason: 'family_not_allowlisted',
      notes: [`Family '${params.family}' is not included in VOICE_SEMANTIC_CONVERGENCE_FAMILIES.`],
    };
  }

  if (!params.providerCapabilityProfile?.capabilities.supportsToolResultInjection) {
    return {
      family: params.family,
      mode,
      strategy: 'legacy',
      providerType: params.providerCapabilityProfile?.providerType,
      reason: 'missing_tool_result_injection',
      notes: [
        ...(params.providerCapabilityProfile?.notes ?? []),
        'Canonical realtime convergence requires provider tool-result injection.',
      ],
    };
  }

  if (!params.hasCoordinatorExecutor) {
    return {
      family: params.family,
      mode,
      strategy: 'legacy',
      providerType: params.providerCapabilityProfile.providerType,
      reason: 'missing_coordinator_executor',
      notes: [
        'The realtime voice session was allowlisted for semantic convergence, but no coordinator turn executor was provided.',
      ],
    };
  }

  return {
    family: params.family,
    mode,
    strategy: 'coordinator_tool',
    providerType: params.providerCapabilityProfile.providerType,
    reason: mode === 'shadow' ? 'shadow_coordinator_tool' : 'enforce_coordinator_tool',
    notes: [
      ...params.providerCapabilityProfile.notes,
      'Realtime turns route through the canonical voice-turn coordinator via a dedicated voice-turn tool.',
    ],
  };
}
