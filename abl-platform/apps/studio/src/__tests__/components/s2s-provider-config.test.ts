import { describe, expect, test } from 'vitest';
import {
  isSupportedStudioS2SProvider,
  normalizeActiveS2SProviderConfig,
  normalizeS2SProviderConfig,
} from '../../components/deployments/channels/s2s-provider-config';

describe('normalizeS2SProviderConfig', () => {
  test('marks only runtime-wired S2S providers as selectable', () => {
    expect(isSupportedStudioS2SProvider('s2s:openai')).toBe(true);
    expect(isSupportedStudioS2SProvider('s2s:microsoft')).toBe(true);
    expect(isSupportedStudioS2SProvider('s2s:google')).toBe(true);
    expect(isSupportedStudioS2SProvider('s2s:grok')).toBe(true);
    expect(isSupportedStudioS2SProvider('s2s:deepgram')).toBe(false);
    expect(isSupportedStudioS2SProvider('deepgram')).toBe(false);
  });

  test('switching to Azure OpenAI keeps deployment optional and applies OpenAI realtime defaults', () => {
    const result = normalizeS2SProviderConfig(
      {
        s2sProvider: 's2s:google',
        s2sModel: 'gemini-3.1-flash-live-preview',
        s2sVoice: 'Puck',
        s2sTemperature: 0.1,
      },
      's2s:microsoft',
    );

    expect(result).toMatchObject({
      s2sProvider: 's2s:microsoft',
      s2sVoice: 'marin',
      s2sTemperature: 0.6,
      s2sTurnDetection: 'server_vad',
      s2sThreshold: 0.5,
      s2sSilenceDuration: 700,
      s2sPrefixPadding: 300,
    });
    expect(result).not.toHaveProperty('s2sModel');
  });

  test('switching to OpenAI resets provider-specific fields and clamps temperature', () => {
    const result = normalizeS2SProviderConfig(
      {
        asrVendor: 'deepgram',
        s2sProvider: 's2s:google',
        s2sModel: 'gemini-3.1-flash-live-preview',
        s2sVoice: 'Puck',
        s2sTemperature: 0.1,
        s2sAgentId: 'agent-old',
        s2sConversationId: 'conversation-old',
      },
      's2s:openai',
    );

    expect(result).toMatchObject({
      asrVendor: 'deepgram',
      s2sProvider: 's2s:openai',
      s2sModel: 'gpt-realtime-1.5',
      s2sVoice: 'marin',
      s2sTemperature: 0.6,
      s2sTurnDetection: 'server_vad',
      s2sThreshold: 0.5,
      s2sSilenceDuration: 700,
      s2sPrefixPadding: 300,
    });
    expect(result).not.toHaveProperty('s2sAgentId');
    expect(result).not.toHaveProperty('s2sConversationId');
  });

  test('switching to Gemini resets stale OpenAI model and voice', () => {
    const result = normalizeS2SProviderConfig(
      {
        provider: 'byoc_sip',
        s2sProvider: 's2s:openai',
        s2sModel: 'gpt-realtime-1.5',
        s2sVoice: 'marin',
        s2sTemperature: 1.5,
        s2sTurnDetection: 'server_vad',
        s2sThreshold: 0.5,
      },
      's2s:google',
    );

    expect(result).toEqual({
      provider: 'byoc_sip',
      s2sProvider: 's2s:google',
      s2sModel: 'gemini-2.0-flash-exp',
      s2sVoice: 'Puck',
      s2sTemperature: 1.5,
      s2sStartSensitivity: 'START_SENSITIVITY_UNSPECIFIED',
      s2sEndSensitivity: 'END_SENSITIVITY_UNSPECIFIED',
      s2sSilenceDuration: 100,
      s2sPrefixPadding: 20,
    });
  });

  test('prefills Gemini activity detection timing with recommended values', () => {
    const result = normalizeActiveS2SProviderConfig(
      {
        s2sProvider: 's2s:google',
        s2sModel: 'gemini-3.1-flash-live-preview',
        s2sVoice: 'Puck',
      },
      's2s:google',
    );

    expect(result).toMatchObject({
      s2sProvider: 's2s:google',
      s2sSilenceDuration: 100,
      s2sPrefixPadding: 20,
    });
  });

  test('normalizes Gemini activity detection settings from storage', () => {
    const result = normalizeActiveS2SProviderConfig(
      {
        s2sProvider: 's2s:google',
        s2sModel: 'gemini-3.1-flash-live-preview',
        s2sVoice: 'Puck',
        s2sTemperature: 1,
        s2sStartSensitivity: 'START_SENSITIVITY_HIGH',
        s2sEndSensitivity: 'END_SENSITIVITY_LOW',
        s2sSilenceDuration: 1200,
        s2sPrefixPadding: 250,
      },
      's2s:google',
    );

    expect(result).toMatchObject({
      s2sProvider: 's2s:google',
      s2sModel: 'gemini-3.1-flash-live-preview',
      s2sVoice: 'Puck',
      s2sTemperature: 1,
      s2sStartSensitivity: 'START_SENSITIVITY_HIGH',
      s2sEndSensitivity: 'END_SENSITIVITY_LOW',
      s2sSilenceDuration: 1200,
      s2sPrefixPadding: 250,
    });
  });

  test('switching to Deepgram clears hidden temperature and voice fields', () => {
    const result = normalizeS2SProviderConfig(
      {
        s2sProvider: 's2s:grok',
        s2sModel: 'grok-2-1212',
        s2sVoice: 'ara',
        s2sTemperature: 1.2,
        s2sTurnDetection: 'server_vad',
      },
      's2s:deepgram',
    );

    expect(result).toEqual({
      s2sProvider: 's2s:deepgram',
      s2sModel: 'aura-asteria-en',
    });
  });

  test('switching to ElevenLabs clears model-based S2S fields', () => {
    const result = normalizeS2SProviderConfig(
      {
        s2sProvider: 's2s:openai',
        s2sModel: 'gpt-realtime-1.5',
        s2sVoice: 'marin',
        s2sTemperature: 0.8,
      },
      's2s:elevenlabs',
    );

    expect(result).toEqual({
      s2sProvider: 's2s:elevenlabs',
    });
  });

  test('normalizes stale same-provider OpenAI config loaded from storage', () => {
    const result = normalizeActiveS2SProviderConfig(
      {
        s2sProvider: 's2s:openai',
        s2sModel: 'gemini-3.1-flash-live-preview',
        s2sVoice: 'Puck',
        s2sTemperature: 0.1,
        s2sAgentId: 'agent-old',
      },
      's2s:openai',
    );

    expect(result).toMatchObject({
      s2sProvider: 's2s:openai',
      s2sModel: 'gpt-realtime-1.5',
      s2sVoice: 'marin',
      s2sTemperature: 0.6,
    });
    expect(result).not.toHaveProperty('s2sAgentId');
  });

  test('preserves newer Grok model ids while normalizing stale voices', () => {
    const result = normalizeActiveS2SProviderConfig(
      {
        s2sProvider: 's2s:grok',
        s2sModel: 'grok-voice-think-fast-1.0',
        s2sVoice: 'marin',
        s2sTemperature: 0,
      },
      's2s:grok',
    );

    expect(result).toMatchObject({
      s2sProvider: 's2s:grok',
      s2sModel: 'grok-voice-think-fast-1.0',
      s2sVoice: 'ara',
      s2sTemperature: 0,
    });
  });

  test('normalizes stale same-provider Azure OpenAI config without forcing deployment', () => {
    const result = normalizeActiveS2SProviderConfig(
      {
        s2sProvider: 's2s:microsoft',
        s2sModel: 'gpt-realtime-2',
        s2sVoice: 'Puck',
        s2sTemperature: 0.1,
      },
      's2s:microsoft',
    );

    expect(result).toMatchObject({
      s2sProvider: 's2s:microsoft',
      s2sVoice: 'marin',
      s2sTemperature: 0.6,
    });
    expect(result).not.toHaveProperty('s2sModel');
  });
});
