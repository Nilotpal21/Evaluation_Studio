import { afterEach, describe, expect, it } from 'vitest';
import type { RealtimeVoiceProviderCapabilityProfile } from '@abl/compiler/platform/llm/realtime/types.js';
import { resolveVoiceSemanticConvergencePlan } from '../../services/voice/voice-semantic-convergence.js';

const OPENAI_REALTIME_CAPABILITIES = {
  providerType: 'openai_realtime',
  capabilities: {
    supportsPromptRefresh: true,
    supportsToolRefresh: true,
    supportsToolResultInjection: true,
    supportsPartialAssistantTranscript: true,
    supportsProviderTurnDetection: true,
    supportsBargeInSignal: true,
  },
  notes: ['OpenAI Realtime supports tool-result injection.'],
} as const satisfies RealtimeVoiceProviderCapabilityProfile;

const ULTRAVOX_CAPABILITIES = {
  providerType: 'ultravox',
  capabilities: {
    supportsPromptRefresh: false,
    supportsToolRefresh: false,
    supportsToolResultInjection: false,
    supportsPartialAssistantTranscript: false,
    supportsProviderTurnDetection: true,
    supportsBargeInSignal: false,
  },
  notes: ['Ultravox does not support server-side tool-result injection.'],
} as const satisfies RealtimeVoiceProviderCapabilityProfile;

const ORIGINAL_MODE = process.env.VOICE_SEMANTIC_CONVERGENCE_MODE;
const ORIGINAL_FAMILIES = process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES;

describe('voice-semantic-convergence', () => {
  afterEach(() => {
    if (ORIGINAL_MODE === undefined) {
      delete process.env.VOICE_SEMANTIC_CONVERGENCE_MODE;
    } else {
      process.env.VOICE_SEMANTIC_CONVERGENCE_MODE = ORIGINAL_MODE;
    }

    if (ORIGINAL_FAMILIES === undefined) {
      delete process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES;
    } else {
      process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES = ORIGINAL_FAMILIES;
    }
  });

  it('defaults to the legacy path when convergence mode is off', () => {
    delete process.env.VOICE_SEMANTIC_CONVERGENCE_MODE;
    delete process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES;

    expect(
      resolveVoiceSemanticConvergencePlan({
        family: 'sdk_voice_realtime',
        providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
        hasCoordinatorExecutor: true,
      }),
    ).toMatchObject({
      family: 'sdk_voice_realtime',
      mode: 'off',
      strategy: 'legacy',
      reason: 'global_mode_off',
    });
  });

  it('uses the coordinator tool strategy when the family is allowlisted and the provider supports tool results', () => {
    process.env.VOICE_SEMANTIC_CONVERGENCE_MODE = 'enforce';
    process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES = 'sdk_voice_realtime,twilio_voice';

    expect(
      resolveVoiceSemanticConvergencePlan({
        family: 'sdk_voice_realtime',
        providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
        hasCoordinatorExecutor: true,
      }),
    ).toMatchObject({
      family: 'sdk_voice_realtime',
      mode: 'enforce',
      strategy: 'coordinator_tool',
      reason: 'enforce_coordinator_tool',
      providerType: 'openai_realtime',
    });
  });

  it('keeps unsupported providers explicit partials even when convergence is enabled', () => {
    process.env.VOICE_SEMANTIC_CONVERGENCE_MODE = 'shadow';
    delete process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES;

    expect(
      resolveVoiceSemanticConvergencePlan({
        family: 'sdk_voice_realtime',
        providerCapabilityProfile: ULTRAVOX_CAPABILITIES,
        hasCoordinatorExecutor: true,
      }),
    ).toMatchObject({
      family: 'sdk_voice_realtime',
      mode: 'shadow',
      strategy: 'legacy',
      reason: 'missing_tool_result_injection',
      providerType: 'ultravox',
    });
  });

  it('falls back to the legacy path when the family is not allowlisted', () => {
    process.env.VOICE_SEMANTIC_CONVERGENCE_MODE = 'enforce';
    process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES = 'twilio_voice';

    expect(
      resolveVoiceSemanticConvergencePlan({
        family: 'sdk_voice_realtime',
        providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
        hasCoordinatorExecutor: true,
      }),
    ).toMatchObject({
      family: 'sdk_voice_realtime',
      mode: 'off',
      strategy: 'legacy',
      reason: 'family_not_allowlisted',
    });
  });
});
