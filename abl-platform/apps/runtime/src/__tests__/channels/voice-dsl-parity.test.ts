import { describe, expect, it } from 'vitest';
import { getVoiceChannelTypes } from '../../channels/manifest.js';
import type { ChannelType } from '../../channels/types.js';
import {
  VOICE_CONSTRUCT_IDS,
  VOICE_PARITY_FAMILY_IDS,
  getVoiceConstructParityRecord,
  getVoiceConstructParityTraceSnapshot,
  getVoiceParityFamiliesForChannelType,
  validateVoiceDslParity,
} from '../../services/voice/voice-dsl-parity.js';
import {
  VOICE_PROVIDER_CAPABILITY_KEYS,
  VOICE_PROVIDER_CAPABILITY_PROFILES,
  getUnsupportedVoiceCapabilities,
} from '../../services/voice/voice-provider-capabilities.js';

describe('voice DSL parity contract', () => {
  it('covers every realtime provider with an explicit capability profile', () => {
    expect(Object.keys(VOICE_PROVIDER_CAPABILITY_PROFILES).sort()).toEqual([
      'gemini_live',
      'openai_realtime',
      'ultravox',
    ]);

    for (const profile of Object.values(VOICE_PROVIDER_CAPABILITY_PROFILES)) {
      expect(profile.notes.length).toBeGreaterThan(0);
      for (const capabilityKey of VOICE_PROVIDER_CAPABILITY_KEYS) {
        expect(typeof profile.capabilities[capabilityKey]).toBe('boolean');
      }
    }
  });

  it('captures the known realtime provider constraints explicitly', () => {
    expect(
      getUnsupportedVoiceCapabilities('openai_realtime', {
        supportsPromptRefresh: true,
        supportsToolRefresh: true,
        supportsToolResultInjection: true,
      }),
    ).toEqual([]);

    expect(
      getUnsupportedVoiceCapabilities('gemini_live', {
        supportsPromptRefresh: true,
        supportsToolRefresh: true,
        supportsToolResultInjection: true,
      }).sort(),
    ).toEqual(['supportsPromptRefresh', 'supportsToolRefresh']);

    expect(
      getUnsupportedVoiceCapabilities('ultravox', {
        supportsToolResultInjection: true,
        supportsPartialAssistantTranscript: true,
        supportsBargeInSignal: true,
      }).sort(),
    ).toEqual([
      'supportsBargeInSignal',
      'supportsPartialAssistantTranscript',
      'supportsToolResultInjection',
    ]);
  });

  it('produces one parity row for every construct/family combination', () => {
    const snapshot = getVoiceConstructParityTraceSnapshot();
    expect(snapshot).toHaveLength(VOICE_CONSTRUCT_IDS.length * VOICE_PARITY_FAMILY_IDS.length);
    expect(validateVoiceDslParity()).toEqual([]);
  });

  it('covers every manifest voice channel with at least one parity family', () => {
    for (const channelType of getVoiceChannelTypes()) {
      expect(
        getVoiceParityFamiliesForChannelType(channelType as ChannelType).length,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the current voice parity hotspots explicit', () => {
    expect(getVoiceConstructParityRecord('sdk_voice_pipeline', 'flow_step_respond').status).toBe(
      'working',
    );
    expect(getVoiceConstructParityRecord('sdk_voice_pipeline', 'voice_config').status).toBe(
      'partial',
    );
    expect(getVoiceConstructParityRecord('sdk_voice_realtime', 'flow_step_respond').status).toBe(
      'partial',
    );
    expect(
      getVoiceConstructParityRecord('sdk_voice_realtime', 'handoff_delegate_return').status,
    ).toBe('partial');
    expect(getVoiceConstructParityRecord('livekit_voice', 'voice_config').status).toBe('partial');
    expect(getVoiceConstructParityRecord('bridge_voice', 'voice_config').status).toBe('partial');
  });
});
