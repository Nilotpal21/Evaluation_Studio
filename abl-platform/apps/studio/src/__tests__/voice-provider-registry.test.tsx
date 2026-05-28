import { describe, expect, it } from 'vitest';

import {
  VOICE_SERVICE_CARD_CONFIGS,
  validateVoiceServiceConfig,
} from '../components/voice/voice-provider-registry';

describe('voice-provider-registry', () => {
  it('exposes Google service account JSON and STT model ID as separate fields', () => {
    const google = VOICE_SERVICE_CARD_CONFIGS.find((config) => config.serviceType === 'google');

    expect(google?.fields.map((field) => field.key)).toEqual(['apiKey', 'modelId']);
    expect(google?.fields.find((field) => field.key === 'apiKey')).toMatchObject({
      label: 'Service Account JSON',
      type: 'textarea',
      storage: 'apiKey',
    });
    expect(google?.fields.find((field) => field.key === 'modelId')).toMatchObject({
      label: 'STT Model ID',
      placeholder: 'chirp_3',
      storage: 'config',
    });
  });

  it('exposes ElevenLabs playback tuning controls with help text', () => {
    const elevenLabs = VOICE_SERVICE_CARD_CONFIGS.find(
      (config) => config.serviceType === 'elevenlabs',
    );

    expect(elevenLabs?.fields.map((field) => field.key)).toEqual([
      'apiKey',
      'voiceId',
      'model',
      'speed',
      'stability',
      'similarityBoost',
      'style',
      'useSpeakerBoost',
    ]);

    expect(elevenLabs?.fields.find((field) => field.key === 'speed')).toMatchObject({
      label: 'Speed',
      type: 'range',
      defaultValue: '1',
      min: 0.7,
      max: 1.2,
      step: 0.05,
      storage: 'config',
    });
    expect(elevenLabs?.fields.find((field) => field.key === 'stability')).toMatchObject({
      label: 'Stability',
      type: 'range',
      defaultValue: '0.5',
      min: 0,
      max: 1,
      step: 0.05,
      storage: 'config',
    });
    expect(elevenLabs?.fields.find((field) => field.key === 'similarityBoost')).toMatchObject({
      label: 'Similarity boost',
      type: 'range',
      defaultValue: '0.75',
      min: 0,
      max: 1,
      step: 0.05,
      storage: 'config',
    });
    expect(elevenLabs?.fields.find((field) => field.key === 'style')).toMatchObject({
      label: 'Style exaggeration',
      type: 'range',
      defaultValue: '0',
      min: 0,
      max: 1,
      step: 0.05,
      storage: 'config',
    });
    expect(elevenLabs?.fields.find((field) => field.key === 'useSpeakerBoost')).toMatchObject({
      label: 'Speaker boost',
      type: 'toggle',
      defaultValue: 'true',
      storage: 'config',
    });

    for (const key of ['speed', 'stability', 'similarityBoost', 'style', 'useSpeakerBoost']) {
      expect(elevenLabs?.fields.find((field) => field.key === key)?.hint).toEqual(
        expect.any(String),
      );
    }
  });

  it('rejects Azure OpenAI deployment values that look like URLs', () => {
    expect(
      validateVoiceServiceConfig('s2s:microsoft', {
        deploymentName: 'https://my-resource.openai.azure.com/openai/realtime',
      }),
    ).toEqual({
      isValid: false,
      fieldErrors: {
        deploymentName: 'Use only the Azure deployment name, not a URL, endpoint, or path.',
      },
    });

    expect(
      validateVoiceServiceConfig('s2s:microsoft', {
        deploymentName: 'my-resource.openai.azure.com',
      }).fieldErrors,
    ).toHaveProperty('deploymentName');

    expect(
      validateVoiceServiceConfig('s2s:microsoft', {
        deploymentName: 'gpt-realtime-2',
      }),
    ).toEqual({
      isValid: true,
      fieldErrors: {},
    });
  });
});
