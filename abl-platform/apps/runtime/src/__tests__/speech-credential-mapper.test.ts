import { describe, expect, it } from 'vitest';

import {
  buildSpeechCredentialInput,
  sanitizeVoiceServiceConfig,
} from '../services/voice/speech-credential-mapper.js';

describe('speech-credential-mapper', () => {
  it('maps AWS STT credentials into the Jambonz payload shape', () => {
    const input = buildSpeechCredentialInput(
      'aws',
      {
        apiKey: 'AKIAEXAMPLE',
        config: {
          secretAccessKey: 'secret-value',
          awsRegion: 'us-east-1',
        },
      },
      'tenant-1',
    );

    expect(input).toEqual({
      vendor: 'aws',
      label: 't:tenant-1',
      useForStt: true,
      useForTts: true,
      apiKey: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-value',
      awsRegion: 'us-east-1',
      roleArn: undefined,
    });
  });

  it('treats an AWS primary credential ARN as a roleArn', () => {
    const input = buildSpeechCredentialInput(
      'aws',
      {
        apiKey: 'arn:aws:iam::123456789012:role/runtime-stt',
        config: {
          awsRegion: 'us-west-2',
        },
      },
      'tenant-1',
    );

    expect(input.apiKey).toBeUndefined();
    expect(input.roleArn).toBe('arn:aws:iam::123456789012:role/runtime-stt');
    expect(input.awsRegion).toBe('us-west-2');
  });

  it('maps Google service-account JSON with an optional STT model ID', () => {
    const input = buildSpeechCredentialInput(
      'google',
      {
        apiKey: '{ "client_email": "voice@example.com", "private_key": "secret" }',
        config: {
          modelId: 'chirp_3',
        },
      },
      'tenant-1',
    );

    expect(input).toEqual({
      vendor: 'google',
      label: 't:tenant-1',
      useForStt: true,
      useForTts: true,
      apiKey: '{ "client_email": "voice@example.com", "private_key": "secret" }',
      modelId: 'chirp_3',
    });
  });

  it('maps Microsoft custom endpoint settings, cartesia/openai defaults, and PlayHT options', () => {
    const microsoft = buildSpeechCredentialInput(
      'microsoft',
      {
        apiKey: 'azure-key',
        config: {
          region: 'eastus',
          customSttEndpointId: 'endpoint-123',
          customSttEndpointUrl:
            'https://eastus.stt.speech.microsoft.com/speech/recognition/interactive/cognitiveservices/v1?cid=endpoint-123',
        },
      },
      'tenant-1',
    );

    const cartesia = buildSpeechCredentialInput(
      'cartesia',
      { apiKey: 'cartesia-key', config: { modelId: 'cartesia-sonic' } },
      'tenant-1',
    );

    const openai = buildSpeechCredentialInput(
      'openai',
      { apiKey: 'openai-key', config: {} },
      'tenant-1',
    );

    const playht = buildSpeechCredentialInput(
      'playht',
      {
        apiKey: 'playht-key',
        config: {
          userId: 'playht-user',
          voiceEngine: 'Play3.0-mini',
        },
      },
      'tenant-1',
    );

    expect(microsoft).toMatchObject({
      vendor: 'microsoft',
      useForTts: true,
      apiKey: 'azure-key',
      region: 'eastus',
      customSttEndpoint: 'endpoint-123',
      customSttEndpointUrl:
        'https://eastus.stt.speech.microsoft.com/speech/recognition/interactive/cognitiveservices/v1?cid=endpoint-123',
    });
    expect(cartesia.useForTts).toBe(true);
    expect(cartesia.modelId).toBe('cartesia-sonic');
    expect(cartesia.sttModelId).toBe('ink-whisper');
    expect(openai.modelId).toBe('whisper-1');
    expect(playht).toMatchObject({
      vendor: 'playht',
      useForStt: false,
      useForTts: true,
      apiKey: 'playht-key',
      userId: 'playht-user',
      voiceEngine: 'Play3.0-mini',
    });
  });

  it('maps ElevenLabs playback settings into Jambonz speech credential options', () => {
    const input = buildSpeechCredentialInput(
      'elevenlabs',
      {
        apiKey: 'elevenlabs-key',
        config: {
          model: 'eleven_multilingual_v2',
          stability: '0.35',
          similarityBoost: 0.82,
          style: '0.2',
          useSpeakerBoost: 'false',
          speed: '0.9',
        },
      },
      'tenant-1',
    );

    expect(input).toEqual({
      vendor: 'elevenlabs',
      label: 't:tenant-1',
      useForStt: false,
      useForTts: true,
      apiKey: 'elevenlabs-key',
      modelId: 'eleven_multilingual_v2',
      options: {
        stability: 0.35,
        similarity_boost: 0.82,
        style: 0.2,
        use_speaker_boost: false,
      },
    });
    expect(input.options).not.toHaveProperty('speed');
  });

  it('removes sensitive config keys before returning service config to the UI', () => {
    expect(
      sanitizeVoiceServiceConfig('aws', {
        awsRegion: 'us-east-1',
        secretAccessKey: 'secret-value',
      }),
    ).toEqual({
      awsRegion: 'us-east-1',
    });

    expect(
      sanitizeVoiceServiceConfig('houndify', {
        userId: 'voice-user',
        clientKey: 'secret-client-key',
      }),
    ).toEqual({
      userId: 'voice-user',
    });
  });

  it('derives the Microsoft custom STT recognition URL from region and deployment ID', () => {
    const input = buildSpeechCredentialInput(
      'microsoft',
      {
        apiKey: 'azure-key',
        config: {
          region: 'eastus',
          customSttEndpointId: '47bde09f-9d10-4163-9daa-1abc7fc59fd6',
        },
      },
      'tenant-1',
    );

    expect(input).toMatchObject({
      vendor: 'microsoft',
      apiKey: 'azure-key',
      region: 'eastus',
      customSttEndpoint: '47bde09f-9d10-4163-9daa-1abc7fc59fd6',
      customSttEndpointUrl:
        'https://eastus.stt.speech.microsoft.com/speech/recognition/interactive/cognitiveservices/v1?cid=47bde09f-9d10-4163-9daa-1abc7fc59fd6',
    });
  });

  it('replaces Microsoft Cognitive Services base URLs with recognition URLs', () => {
    const input = buildSpeechCredentialInput(
      'microsoft',
      {
        apiKey: 'azure-key',
        config: {
          region: 'EastUS',
          customSttEndpointId: 'endpoint-123',
          customSttEndpointUrl: 'https://eastus.api.cognitive.microsoft.com/',
        },
      },
      'tenant-1',
    );

    expect(input.customSttEndpointUrl).toBe(
      'https://eastus.stt.speech.microsoft.com/speech/recognition/interactive/cognitiveservices/v1?cid=endpoint-123',
    );
  });
});
