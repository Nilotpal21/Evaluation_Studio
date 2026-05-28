import type {
  RealtimeProviderType,
  RealtimeVoiceCapabilityKey,
  RealtimeVoiceProviderCapabilityProfile,
  RealtimeVoiceProviderCapabilities,
} from '@abl/compiler/platform/llm/realtime/types.js';

export const VOICE_PROVIDER_CAPABILITY_KEYS = [
  'supportsPromptRefresh',
  'supportsToolRefresh',
  'supportsToolResultInjection',
  'supportsPartialAssistantTranscript',
  'supportsProviderTurnDetection',
  'supportsBargeInSignal',
] as const satisfies readonly RealtimeVoiceCapabilityKey[];

const OPENAI_REALTIME_CAPABILITIES = {
  supportsPromptRefresh: true,
  supportsToolRefresh: true,
  supportsToolResultInjection: true,
  supportsPartialAssistantTranscript: true,
  supportsProviderTurnDetection: true,
  supportsBargeInSignal: true,
} as const satisfies RealtimeVoiceProviderCapabilities;

const GEMINI_LIVE_CAPABILITIES = {
  supportsPromptRefresh: false,
  supportsToolRefresh: false,
  supportsToolResultInjection: true,
  supportsPartialAssistantTranscript: true,
  supportsProviderTurnDetection: false,
  supportsBargeInSignal: true,
} as const satisfies RealtimeVoiceProviderCapabilities;

const ULTRAVOX_CAPABILITIES = {
  supportsPromptRefresh: false,
  supportsToolRefresh: false,
  supportsToolResultInjection: false,
  supportsPartialAssistantTranscript: false,
  supportsProviderTurnDetection: true,
  supportsBargeInSignal: false,
} as const satisfies RealtimeVoiceProviderCapabilities;

export const VOICE_PROVIDER_CAPABILITY_PROFILES = {
  openai_realtime: {
    providerType: 'openai_realtime',
    capabilities: OPENAI_REALTIME_CAPABILITIES,
    notes: [
      'Mid-session prompt and tool refresh use session.update on the provider socket.',
      'Tool results inject through conversation items and a follow-up response.create call.',
      'Assistant transcript deltas and provider speech-started signals are both surfaced.',
    ],
  },
  gemini_live: {
    providerType: 'gemini_live',
    capabilities: GEMINI_LIVE_CAPABILITIES,
    notes: [
      'Tool results are supported, but system prompt and tool updates do not apply mid-session.',
      'Assistant transcript parts and interruption flags are available from serverContent.',
      'Current session setup does not expose a provider-owned turn-detection contract.',
    ],
  },
  ultravox: {
    providerType: 'ultravox',
    capabilities: ULTRAVOX_CAPABILITIES,
    notes: [
      'System prompt and tools are fixed at call creation time.',
      'Server-side tool-result injection is not available because tool handling stays client-side.',
      'Ultravox accepts VAD settings at call creation, but the runtime does not receive transcript deltas.',
    ],
  },
} as const satisfies Record<RealtimeProviderType, RealtimeVoiceProviderCapabilityProfile>;

export function getVoiceProviderCapabilityProfile(
  providerType: RealtimeProviderType,
): RealtimeVoiceProviderCapabilityProfile {
  return VOICE_PROVIDER_CAPABILITY_PROFILES[providerType];
}

export function listVoiceProviderCapabilityProfiles(): RealtimeVoiceProviderCapabilityProfile[] {
  return Object.values(VOICE_PROVIDER_CAPABILITY_PROFILES).map((profile) => ({
    ...profile,
    notes: [...profile.notes],
  }));
}

export function supportsVoiceProviderCapability(
  providerType: RealtimeProviderType,
  capabilityKey: RealtimeVoiceCapabilityKey,
): boolean {
  return getVoiceProviderCapabilityProfile(providerType).capabilities[capabilityKey];
}

export function getUnsupportedVoiceCapabilities(
  providerType: RealtimeProviderType,
  required: Partial<RealtimeVoiceProviderCapabilities>,
): RealtimeVoiceCapabilityKey[] {
  const profile = getVoiceProviderCapabilityProfile(providerType);
  const unsupported: RealtimeVoiceCapabilityKey[] = [];

  for (const capabilityKey of VOICE_PROVIDER_CAPABILITY_KEYS) {
    if (required[capabilityKey] && !profile.capabilities[capabilityKey]) {
      unsupported.push(capabilityKey);
    }
  }

  return unsupported;
}

export interface VoiceProviderCapabilityTraceRow {
  providerType: RealtimeProviderType;
  capabilities: RealtimeVoiceProviderCapabilities;
  notes: readonly string[];
}

export function getVoiceProviderCapabilityTraceRows(): VoiceProviderCapabilityTraceRow[] {
  return listVoiceProviderCapabilityProfiles().map((profile) => ({
    providerType: profile.providerType,
    capabilities: profile.capabilities,
    notes: profile.notes,
  }));
}
