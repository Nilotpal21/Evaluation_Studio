import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const MOCK_CONFIG = {
  baseApiUrl: 'https://jambonz.example.com',
  accountSid: 'acc-123',
  apiKey: 'key-abc',
  voipCarrierSid: 'carrier-456',
};

describe('JambonzProvisioningService', () => {
  // Pre-import the module in beforeAll so the dynamic import doesn't time out
  // inside individual tests when many forked processes compete for resources.
  let JambonzProvisioningService: any;
  beforeAll(async () => {
    const mod = await import('../services/voice/jambonz-provisioning.service.js');
    JambonzProvisioningService = mod.JambonzProvisioningService;
  });

  beforeEach(() => vi.clearAllMocks());

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('createApplication sends POST /Applications with correct payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'app-sid-001' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    const sid = await svc.createApplication({
      name: 'test-bot',
      webhookUrl: 'wss://runtime.example.com/channels/jambonz?id=conn-1',
    });
    expect(sid).toBe('app-sid-001');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Applications',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteApplication sends DELETE /Applications/:sid', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    await expect(svc.deleteApplication('app-sid-001')).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Applications/app-sid-001',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('addPhoneNumber sends POST /PhoneNumbers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'pn-sid-002' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    const sid = await svc.addPhoneNumber({
      phoneNumber: '+12345678',
      applicationSid: 'app-sid-001',
    });
    expect(sid).toBe('pn-sid-002');
  });

  it('throws if baseApiUrl is not configured', async () => {
    const svc = new JambonzProvisioningService({} as any);
    await expect(svc.createApplication({ name: 'x', webhookUrl: 'wss://x' })).rejects.toThrow(
      'Jambonz not configured',
    );
  });

  // ── getSupportedLanguagesAndVoices ─────────────────────────────────────────

  it('getSupportedLanguagesAndVoices calls GET /speech/supportedLanguagesAndVoices with vendor', async () => {
    const mockResponse = {
      tts: [
        {
          value: 'en-US',
          name: 'English (US)',
          voices: [{ value: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' }],
        },
        { value: 'es-ES', name: 'Spanish', voices: [] },
      ],
      models: [{ name: 'Multilingual v2', value: 'eleven_multilingual_v2' }],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    const result = await svc.getSupportedLanguagesAndVoices('elevenlabs');

    expect(result.tts).toHaveLength(2);
    expect(result.tts[0]).toEqual({
      code: 'en-US',
      name: 'English (US)',
      voices: [{ value: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' }],
    });
    expect(result.stt).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Accounts/acc-123/SpeechCredentials/speech/supportedLanguagesAndVoices?vendor=elevenlabs',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getSupportedLanguagesAndVoices normalizes STT-capable vendor response', async () => {
    const mockResponse = {
      tts: [
        {
          value: 'en-US',
          name: 'English (US)',
          voices: [{ value: 'aura-asteria-en', name: 'Asteria' }],
        },
      ],
      stt: [
        { value: 'multi', name: 'Multilingual' },
        { value: 'en', name: 'English' },
      ],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    const result = await svc.getSupportedLanguagesAndVoices('deepgram');

    expect(result.tts).toHaveLength(1);
    expect(result.tts[0].code).toBe('en-US');
    expect(result.stt).toHaveLength(2);
    expect(result.stt[0]).toEqual({ code: 'multi', name: 'Multilingual' });
  });

  it('getSupportedLanguagesAndVoices encodes vendor with special characters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tts: [], stt: [] }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    await svc.getSupportedLanguagesAndVoices('vendor with spaces');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Accounts/acc-123/SpeechCredentials/speech/supportedLanguagesAndVoices?vendor=vendor%20with%20spaces',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getSupportedLanguagesAndVoices includes label when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tts: [], stt: [] }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    await svc.getSupportedLanguagesAndVoices('elevenlabs', { label: 't:tenant-1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Accounts/acc-123/SpeechCredentials/speech/supportedLanguagesAndVoices?vendor=elevenlabs&label=t%3Atenant-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getSupportedLanguagesAndVoices throws when Jambonz returns error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    await expect(svc.getSupportedLanguagesAndVoices('deepgram')).rejects.toThrow(
      'Jambonz API error 500',
    );
  });

  it('getSupportedLanguagesAndVoices throws if not configured', async () => {
    const svc = new JambonzProvisioningService({} as any);
    await expect(svc.getSupportedLanguagesAndVoices('deepgram')).rejects.toThrow(
      'Jambonz not configured',
    );
  });

  it('createApplication embeds token in call_hook url when webhookUrl contains ?token=', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'app-sid-002' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);
    const webhookUrl = 'wss://runtime.example.com/ws/korevg/conn-1?token=abc123secret';
    await svc.createApplication({ name: 'test-bot', webhookUrl });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.call_hook.url).toBe(webhookUrl);
    expect(body.call_status_hook.url).toBe(webhookUrl);
  });

  it('createSpeechCredential sends custom streaming payload for Orpheus', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'speech-cred-001' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    const sid = await svc.createSpeechCredential({
      vendor: 'custom:orpheus',
      label: 't:tenant-1',
      useForStt: false,
      useForTts: true,
      authToken: 'route-token',
      customTtsUrl: 'https://runtime.example.com/api/v1/voice/custom-tts/orpheus',
      customTtsStreamingUrl: 'wss://runtime.example.com/ws/custom-tts/orpheus',
    });

    expect(sid).toBe('speech-cred-001');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Accounts/acc-123/SpeechCredentials',
      expect.objectContaining({ method: 'POST' }),
    );

    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
    expect(body).toMatchObject({
      vendor: 'custom:orpheus',
      label: 't:tenant-1',
      use_for_stt: 0,
      use_for_tts: 1,
      auth_token: 'route-token',
      custom_stt_url: null,
      custom_tts_url: 'https://runtime.example.com/api/v1/voice/custom-tts/orpheus',
      custom_tts_streaming_url: 'wss://runtime.example.com/ws/custom-tts/orpheus',
    });
  });

  it('createSpeechCredential sends Microsoft STT custom endpoint fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'speech-cred-azure' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    await svc.createSpeechCredential({
      vendor: 'microsoft',
      label: 't:tenant-1',
      useForStt: true,
      useForTts: false,
      apiKey: 'azure-key',
      region: 'eastus',
      customSttEndpoint: 'endpoint-123',
      customSttEndpointUrl: 'https://speech.example.com',
    });

    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
    expect(body).toMatchObject({
      vendor: 'microsoft',
      label: 't:tenant-1',
      use_for_stt: 1,
      use_for_tts: 0,
      api_key: 'azure-key',
      region: 'eastus',
      custom_stt_endpoint: 'endpoint-123',
      custom_stt_endpoint_url: 'https://speech.example.com',
      use_custom_stt: true,
    });
  });

  it('createSpeechCredential sends Google service key and model ID separately', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'speech-cred-google' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    await svc.createSpeechCredential({
      vendor: 'google',
      label: 't:tenant-1',
      useForStt: true,
      useForTts: false,
      apiKey: '{ "client_email": "voice@example.com", "private_key": "secret" }',
      modelId: 'chirp_3',
    });

    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
    expect(body).toMatchObject({
      vendor: 'google',
      label: 't:tenant-1',
      use_for_stt: 1,
      use_for_tts: 0,
      service_key: '{ "client_email": "voice@example.com", "private_key": "secret" }',
      model_id: 'chirp_3',
    });
  });

  it('createSpeechCredential sends AWS access-key and region payloads', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'speech-cred-aws' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    await svc.createSpeechCredential({
      vendor: 'aws',
      label: 't:tenant-1',
      useForStt: true,
      useForTts: true,
      apiKey: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-value',
      awsRegion: 'us-east-1',
    });

    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
    expect(body).toMatchObject({
      vendor: 'aws',
      label: 't:tenant-1',
      use_for_stt: 1,
      use_for_tts: 1,
      access_key_id: 'AKIAEXAMPLE',
      secret_access_key: 'secret-value',
      aws_region: 'us-east-1',
    });
  });

  it('createSpeechCredential sends PlayHT TTS-specific fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'speech-cred-playht' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    await svc.createSpeechCredential({
      vendor: 'playht',
      label: 't:tenant-1',
      useForStt: false,
      useForTts: true,
      apiKey: 'playht-key',
      userId: 'playht-user',
      voiceEngine: 'Play3.0-mini',
    });

    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
    expect(body).toMatchObject({
      vendor: 'playht',
      label: 't:tenant-1',
      use_for_stt: 0,
      use_for_tts: 1,
      api_key: 'playht-key',
      user_id: 'playht-user',
      voice_engine: 'Play3.0-mini',
    });
  });

  it('createSpeechCredential sends ElevenLabs model and voice settings options', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'speech-cred-elevenlabs' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    await svc.createSpeechCredential({
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

    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
    expect(body).toMatchObject({
      vendor: 'elevenlabs',
      label: 't:tenant-1',
      use_for_stt: 0,
      use_for_tts: 1,
      api_key: 'elevenlabs-key',
      model_id: 'eleven_multilingual_v2',
      options: {
        stability: 0.35,
        similarity_boost: 0.82,
        style: 0.2,
        use_speaker_boost: false,
      },
    });
  });

  it('createSpeechCredential sends Speechmatics STT host field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'speech-cred-speechmatics' }),
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    await svc.createSpeechCredential({
      vendor: 'speechmatics',
      label: 't:tenant-1',
      useForStt: true,
      useForTts: false,
      apiKey: 'speechmatics-key',
      speechmaticsSttUri: 'eu2.rt.speechmatics.com',
    });

    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
    expect(body).toMatchObject({
      vendor: 'speechmatics',
      label: 't:tenant-1',
      use_for_stt: 1,
      use_for_tts: 0,
      api_key: 'speechmatics-key',
      speechmatics_stt_uri: 'eu2.rt.speechmatics.com',
    });
  });

  it('findSpeechCredentialByVendorAndLabel returns matching sid', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          speech_credential_sid: 'cred-1',
          vendor: 'deepgram',
          label: 't:tenant-1',
        },
        {
          speech_credential_sid: 'cred-2',
          vendor: 'custom:orpheus',
          label: 't:tenant-1',
        },
      ],
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    const sid = await svc.findSpeechCredentialByVendorAndLabel('custom:orpheus', 't:tenant-1');

    expect(sid).toBe('cred-2');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Accounts/acc-123/SpeechCredentials',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('testSpeechCredential calls the Jambonz speech credential test endpoint', async () => {
    const mockResult = {
      stt: { status: 'ok' },
      tts: { status: 'not tested' },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResult,
    });
    const svc = new JambonzProvisioningService(MOCK_CONFIG as any);

    await expect(svc.testSpeechCredential('speech-cred-001')).resolves.toEqual(mockResult);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Accounts/acc-123/SpeechCredentials/speech-cred-001/test',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
