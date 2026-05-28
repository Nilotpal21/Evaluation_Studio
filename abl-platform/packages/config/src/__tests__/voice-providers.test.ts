import { describe, expect, it } from 'vitest';

import {
  CHANNEL_STT_PROVIDER_TYPES,
  CHANNEL_TTS_PROVIDER_TYPES,
  RUNTIME_VOICE_SERVICE_TYPES,
  S2S_PROVIDER_TYPES,
  TTS_PREVIEW_PROVIDER_TYPES,
  VOICE_PROVIDER_DEFINITIONS,
  getS2STelephonySupport,
  getS2STelephonySupportMessage,
  getSpeechProviderRole,
  getVoiceProviderLabel,
  isChannelSttVoiceServiceType,
  isChannelTtsVoiceServiceType,
  isRuntimeVoiceServiceType,
  isS2SProviderType,
  listAdminVoiceProviders,
} from '../constants/voice-providers.js';

describe('voice provider registry', () => {
  it('exports the expected runtime service types', () => {
    expect(RUNTIME_VOICE_SERVICE_TYPES).toEqual([
      'deepgram',
      'google',
      'aws',
      'microsoft',
      'nuance',
      'gladia',
      'soniox',
      'cobalt',
      'ibm',
      'nvidia',
      'assemblyai',
      'houndify',
      'voxist',
      'cartesia',
      'speechmatics',
      'openai',
      'verbio',
      'rimelabs',
      'playht',
      'inworld',
      'elevenlabs',
      'custom:orpheus',
      'twilio',
      's2s:openai',
      's2s:microsoft',
      's2s:elevenlabs',
      's2s:google',
      's2s:deepgram',
      's2s:ultravox',
      's2s:grok',
    ]);
  });

  it('exports the expected S2S provider types', () => {
    expect(S2S_PROVIDER_TYPES).toEqual([
      's2s:openai',
      's2s:microsoft',
      's2s:elevenlabs',
      's2s:google',
      's2s:deepgram',
      's2s:ultravox',
      's2s:grok',
    ]);
  });

  it('keeps admin provider groups aligned to the intended voice surfaces', () => {
    expect(listAdminVoiceProviders('stt').map((provider) => provider.serviceType)).toEqual([
      'deepgram',
      'google',
      'aws',
      'microsoft',
      'nuance',
      'gladia',
      'soniox',
      'cobalt',
      'ibm',
      'nvidia',
      'assemblyai',
      'houndify',
      'voxist',
      'cartesia',
      'speechmatics',
      'openai',
      'verbio',
    ]);
    expect(listAdminVoiceProviders('tts').map((provider) => provider.serviceType)).toEqual([
      'deepgram',
      'google',
      'aws',
      'microsoft',
      'nuance',
      'cartesia',
      'verbio',
      'rimelabs',
      'playht',
      'inworld',
      'elevenlabs',
      'custom:orpheus',
    ]);
    expect(listAdminVoiceProviders('s2s').map((provider) => provider.serviceType)).toEqual(
      S2S_PROVIDER_TYPES,
    );
  });

  it('marks current partial S2S providers for telephony capability messaging', () => {
    expect(getS2STelephonySupport('s2s:openai')).toBe('full');
    expect(getS2STelephonySupport('s2s:microsoft')).toBe('full');
    expect(getS2STelephonySupport('s2s:deepgram')).toBe('partial');
    expect(getS2STelephonySupport('s2s:ultravox')).toBe('partial');
    expect(getS2STelephonySupportMessage('s2s:deepgram')).toContain(
      'inline agent handoff and prompt-swap flows remain limited',
    );
    expect(getS2STelephonySupportMessage('s2s:openai')).toBeNull();
  });

  it('exposes the expanded Studio channel filtering sets for STT and TTS providers', () => {
    expect(CHANNEL_STT_PROVIDER_TYPES).toEqual([
      'deepgram',
      'google',
      'aws',
      'microsoft',
      'nuance',
      'gladia',
      'soniox',
      'cobalt',
      'ibm',
      'nvidia',
      'assemblyai',
      'houndify',
      'voxist',
      'cartesia',
      'speechmatics',
      'openai',
      'verbio',
      'azure',
    ]);
    expect(CHANNEL_TTS_PROVIDER_TYPES).toEqual([
      'deepgram',
      'google',
      'aws',
      'microsoft',
      'nuance',
      'cartesia',
      'verbio',
      'rimelabs',
      'playht',
      'inworld',
      'elevenlabs',
      'custom:orpheus',
      'azure',
    ]);
    expect(TTS_PREVIEW_PROVIDER_TYPES).toEqual(['elevenlabs', 'custom:orpheus']);
  });

  it('exposes helper predicates and labels that match the registry', () => {
    expect(isRuntimeVoiceServiceType('deepgram')).toBe(true);
    expect(isRuntimeVoiceServiceType('google')).toBe(true);
    expect(isChannelSttVoiceServiceType('google')).toBe(true);
    expect(isChannelTtsVoiceServiceType('custom:orpheus')).toBe(true);
    expect(isS2SProviderType('s2s:grok')).toBe(true);
    expect(isS2SProviderType('s2s:microsoft')).toBe(true);
    expect(isS2SProviderType('deepgram')).toBe(false);
    expect(getVoiceProviderLabel('s2s:grok')).toBe('Grok Realtime (S2S)');
    expect(getVoiceProviderLabel('s2s:microsoft')).toBe('Azure OpenAI Realtime');
  });

  it('keeps runtime speech roles aligned with Jambonz sync expectations', () => {
    expect(getSpeechProviderRole('deepgram')).toEqual({ useForStt: true, useForTts: true });
    expect(getSpeechProviderRole('playht')).toEqual({ useForStt: false, useForTts: true });
    expect(getSpeechProviderRole('elevenlabs')).toEqual({ useForStt: false, useForTts: true });
    expect(getSpeechProviderRole('custom:orpheus')).toBeNull();
    expect(getSpeechProviderRole('s2s:openai')).toBeNull();
  });

  it('only exposes runtime-managed providers in the channel TTS selector when they support TTS', () => {
    const invalidTtsProviders = VOICE_PROVIDER_DEFINITIONS.filter(
      (provider) =>
        provider.capabilities.runtimeCrud &&
        provider.capabilities.channelTtsSelectable &&
        provider.capabilities.speechRole !== null &&
        provider.capabilities.speechRole.useForTts === false,
    ).map((provider) => provider.serviceType);

    expect(invalidTtsProviders).toEqual([]);
  });
});
