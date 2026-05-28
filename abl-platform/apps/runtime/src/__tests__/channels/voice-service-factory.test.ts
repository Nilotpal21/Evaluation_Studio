import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockDualReadCredentials = vi.fn();
  const mockResolveAuthProfileCredentials = vi.fn();
  const mockResolveTenantPlaintextValue = vi.fn();
  const mockFindActiveVoiceServiceInstanceById = vi.fn();
  const mockFindDefaultActiveVoiceServiceInstance = vi.fn();
  const mockFindDefaultTenantModelForVoice = vi.fn();
  const mockResolveVoiceMode = vi.fn();
  const mockDeepgramFromCredentials = vi.fn();
  const mockElevenLabsFromCredentials = vi.fn();
  const mockTwilioFromCredentials = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    mockDualReadCredentials,
    mockResolveAuthProfileCredentials,
    mockResolveTenantPlaintextValue,
    mockFindActiveVoiceServiceInstanceById,
    mockFindDefaultActiveVoiceServiceInstance,
    mockFindDefaultTenantModelForVoice,
    mockResolveVoiceMode,
    mockDeepgramFromCredentials,
    mockElevenLabsFromCredentials,
    mockTwilioFromCredentials,
    mockLogger,
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mocks.mockLogger),
}));

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: unknown[]) =>
    mocks.mockResolveTenantPlaintextValue(...args),
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  dualReadCredentials: (...args: unknown[]) => mocks.mockDualReadCredentials(...args),
}));

vi.mock('../../services/auth-profile-resolver.js', () => ({
  resolveAuthProfileCredentials: (...args: unknown[]) =>
    mocks.mockResolveAuthProfileCredentials(...args),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('../../services/voice/voice-service-instance-repo.js', () => ({
  findActiveVoiceServiceInstanceById: (...args: unknown[]) =>
    mocks.mockFindActiveVoiceServiceInstanceById(...args),
  findDefaultActiveVoiceServiceInstance: (...args: unknown[]) =>
    mocks.mockFindDefaultActiveVoiceServiceInstance(...args),
}));

vi.mock('../../repos/llm-resolution-repo.js', () => ({
  findDefaultTenantModelForVoice: (...args: unknown[]) =>
    mocks.mockFindDefaultTenantModelForVoice(...args),
}));

vi.mock('../../services/voice/voice-mode-resolver.js', () => ({
  resolveVoiceMode: (...args: unknown[]) => mocks.mockResolveVoiceMode(...args),
}));

vi.mock('../../services/voice/deepgram-service.js', () => ({
  DeepgramService: {
    fromCredentials: (...args: unknown[]) => mocks.mockDeepgramFromCredentials(...args),
  },
}));

vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  ElevenLabsService: {
    fromCredentials: (...args: unknown[]) => mocks.mockElevenLabsFromCredentials(...args),
  },
}));

vi.mock('../../services/voice/twilio-service.js', () => ({
  TwilioService: {
    fromCredentials: (...args: unknown[]) => mocks.mockTwilioFromCredentials(...args),
  },
}));

import { VoiceServiceFactory } from '../../services/voice/voice-service-factory.js';

type MockServiceInstance = {
  _id: string;
  id: string;
  tenantId: string;
  serviceType: string;
  isActive: boolean;
  isDefault: boolean;
  authProfileId: string | null;
  encryptedApiKey: string;
  encryptedConfig: Record<string, unknown> | string;
};

function createInstance(
  serviceType: string,
  overrides: Partial<MockServiceInstance> = {},
): MockServiceInstance {
  return {
    _id: `${serviceType}-instance`,
    id: `${serviceType}-instance`,
    tenantId: 'tenant-1',
    serviceType,
    isActive: true,
    isDefault: true,
    authProfileId: `profile-${serviceType}`,
    encryptedApiKey: `${serviceType}-legacy-key`,
    encryptedConfig: {},
    ...overrides,
  };
}

function createResolvedProfile(apiKey: string, config: Record<string, unknown> = {}) {
  return {
    secrets: { apiKey },
    config,
  };
}

describe('VoiceServiceFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.mockFindDefaultActiveVoiceServiceInstance.mockReset();
    mocks.mockFindActiveVoiceServiceInstanceById.mockReset();
    mocks.mockDualReadCredentials.mockReset();
    mocks.mockResolveAuthProfileCredentials.mockReset();
    mocks.mockResolveTenantPlaintextValue.mockReset();
    mocks.mockFindDefaultTenantModelForVoice.mockReset();
    mocks.mockResolveVoiceMode.mockReset();
    mocks.mockDeepgramFromCredentials.mockReset();
    mocks.mockElevenLabsFromCredentials.mockReset();
    mocks.mockTwilioFromCredentials.mockReset();

    mocks.mockFindDefaultActiveVoiceServiceInstance.mockResolvedValue(null);
    mocks.mockFindActiveVoiceServiceInstanceById.mockResolvedValue(null);
    mocks.mockDualReadCredentials.mockImplementation(
      async (opts: {
        authProfileId?: string | null;
        resolve: () => Promise<unknown>;
        legacyFallback: () => Promise<unknown>;
      }) => {
        if (opts.authProfileId) {
          return { source: 'auth-profile', credentials: await opts.resolve() };
        }
        return { source: 'legacy', credentials: await opts.legacyFallback() };
      },
    );
    mocks.mockResolveAuthProfileCredentials.mockImplementation(
      async (authProfileId: string, _tenantId: string) => {
        switch (authProfileId) {
          case 'profile-deepgram':
            return createResolvedProfile('deepgram-key', { model: 'nova-3' });
          case 'profile-elevenlabs':
            return createResolvedProfile('elevenlabs-key', {
              voiceId: 'Bella',
              model: 'flash-v2',
            });
          case 'profile-google':
            return createResolvedProfile('google-service-key', { modelId: 'chirp_3' });
          case 'profile-s2s:openai':
            return createResolvedProfile('openai-key', { model: 'gpt-realtime' });
          default:
            return null;
        }
      },
    );
    mocks.mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
    mocks.mockResolveVoiceMode.mockReturnValue('pipeline');
  });

  it('caches STT services per tenant and resolves only the tenant-scoped Deepgram instance', async () => {
    const deepgramService = { kind: 'deepgram-service' };
    mocks.mockDeepgramFromCredentials.mockReturnValue(deepgramService);
    mocks.mockFindDefaultActiveVoiceServiceInstance.mockImplementation(
      async (tenantId: string, serviceType: string) => {
        if (tenantId === 'tenant-1' && serviceType === 'deepgram') {
          return createInstance('deepgram');
        }
        return null;
      },
    );

    const factory = new VoiceServiceFactory(null);
    const first = await factory.getSTTService('tenant-1');
    const second = await factory.getSTTService('tenant-1');

    expect(first).toBe(deepgramService);
    expect(second).toBe(deepgramService);
    expect(mocks.mockFindDefaultActiveVoiceServiceInstance).toHaveBeenCalledTimes(1);
    expect(mocks.mockFindDefaultActiveVoiceServiceInstance).toHaveBeenCalledWith(
      'tenant-1',
      'deepgram',
    );
    expect(mocks.mockResolveAuthProfileCredentials).toHaveBeenCalledWith(
      'profile-deepgram',
      'tenant-1',
    );
    expect(mocks.mockDeepgramFromCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.mockDeepgramFromCredentials).toHaveBeenCalledWith('deepgram-key', {
      model: 'nova-3',
    });
  });

  it('resolves both STT and TTS voice credentials through the public tenant-scoped path', async () => {
    mocks.mockFindDefaultActiveVoiceServiceInstance.mockImplementation(
      async (_tenantId: string, serviceType: string) => {
        if (serviceType === 'deepgram') {
          return createInstance('deepgram');
        }

        if (serviceType === 'elevenlabs') {
          return createInstance('elevenlabs', {
            isDefault: false,
          });
        }

        return null;
      },
    );

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveVoiceCredentials('tenant-1');

    expect(mocks.mockFindDefaultActiveVoiceServiceInstance).toHaveBeenCalledWith(
      'tenant-1',
      'deepgram',
    );
    expect(mocks.mockFindDefaultActiveVoiceServiceInstance).toHaveBeenCalledWith(
      'tenant-1',
      'elevenlabs',
    );
    expect(mocks.mockResolveAuthProfileCredentials).toHaveBeenCalledWith(
      'profile-deepgram',
      'tenant-1',
    );
    expect(mocks.mockResolveAuthProfileCredentials).toHaveBeenCalledWith(
      'profile-elevenlabs',
      'tenant-1',
    );
    expect(result).toEqual({
      stt: {
        apiKey: 'deepgram-key',
        model: 'nova-3',
      },
      tts: {
        apiKey: 'elevenlabs-key',
        voiceId: 'Bella',
        model: 'flash-v2',
      },
    });
  });

  it('uses legacy decrypted credentials when the tenant service instance has no auth profile', async () => {
    mocks.mockFindDefaultActiveVoiceServiceInstance.mockImplementation(
      async (_tenantId: string, serviceType: string) => {
        if (serviceType === 'elevenlabs') {
          return createInstance('elevenlabs', {
            authProfileId: null,
            encryptedApiKey: 'elevenlabs-legacy-key',
            encryptedConfig: { voiceId: 'Bella', model: 'flash-v2' },
          });
        }
        return null;
      },
    );

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveVoiceCredentials('tenant-1');

    expect(mocks.mockResolveAuthProfileCredentials).not.toHaveBeenCalled();
    expect(mocks.mockFindDefaultActiveVoiceServiceInstance).toHaveBeenCalledWith(
      'tenant-1',
      'deepgram',
    );
    expect(mocks.mockFindDefaultActiveVoiceServiceInstance).toHaveBeenCalledWith(
      'tenant-1',
      'elevenlabs',
    );
    expect(result).toEqual({
      stt: null,
      tts: {
        apiKey: 'elevenlabs-legacy-key',
        voiceId: 'Bella',
        model: 'flash-v2',
      },
    });
  });

  it('fails closed when a legacy voice API key cannot be decrypted', async () => {
    mocks.mockFindDefaultActiveVoiceServiceInstance.mockImplementation(
      async (_tenantId: string, serviceType: string) => {
        if (serviceType === 'elevenlabs') {
          return createInstance('elevenlabs', {
            authProfileId: null,
            encryptedApiKey: 'ciphertext-api-key',
            encryptedConfig: { voiceId: 'Bella', model: 'flash-v2' },
          });
        }
        return null;
      },
    );
    mocks.mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => {
        if (value === 'ciphertext-api-key') {
          return null;
        }
        return value ?? null;
      },
    );

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveVoiceCredentials('tenant-1');

    expect(result).toEqual({
      stt: null,
      tts: null,
    });
    expect(mocks.mockResolveTenantPlaintextValue).toHaveBeenCalledWith(
      'ciphertext-api-key',
      'tenant-1',
      { decryptionFailed: false },
    );
  });

  it('resolves Google STT model from modelId config', async () => {
    mocks.mockFindDefaultActiveVoiceServiceInstance.mockImplementation(
      async (_tenantId: string, serviceType: string) => {
        if (serviceType === 'google') {
          return createInstance('google');
        }

        return null;
      },
    );

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveVoiceCredentials('tenant-1', {
      sttServiceType: 'google',
      ttsServiceType: 'elevenlabs',
    });

    expect(result.stt).toEqual({
      apiKey: 'google-service-key',
      model: 'chirp_3',
    });
  });

  it('checks tenant realtime model availability before delegating voice mode resolution', async () => {
    mocks.mockFindDefaultTenantModelForVoice.mockResolvedValue(null);
    mocks.mockResolveVoiceMode.mockReturnValue('pipeline');

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveVoiceMode({
      tenantId: 'tenant-1',
      deploymentVoiceConfig: {
        mode: 'realtime',
      },
    });

    expect(result).toBe('pipeline');
    expect(mocks.mockFindDefaultTenantModelForVoice).toHaveBeenCalledWith('tenant-1');
    expect(mocks.mockResolveVoiceMode).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      deploymentVoiceConfig: {
        mode: 'realtime',
      },
      tenantHasRealtimeModel: false,
    });
  });

  it('returns S2S credentials through the provider lookup path with the public return shape', async () => {
    mocks.mockFindDefaultActiveVoiceServiceInstance.mockImplementation(
      async (_tenantId: string, serviceType: string) => {
        if (serviceType === 's2s:openai') {
          return createInstance('s2s:openai');
        }
        return null;
      },
    );

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveS2SCredentials('tenant-1', 's2s:openai');

    expect(result).toEqual({
      credentials: {
        apiKey: 'openai-key',
        config: { model: 'gpt-realtime' },
      },
    });
    expect(mocks.mockFindDefaultActiveVoiceServiceInstance).toHaveBeenCalledWith(
      'tenant-1',
      's2s:openai',
    );
    expect(mocks.mockResolveAuthProfileCredentials).toHaveBeenCalledWith(
      'profile-s2s:openai',
      'tenant-1',
    );
  });

  it('resolves explicit service instances by id when requested', async () => {
    mocks.mockFindActiveVoiceServiceInstanceById.mockResolvedValue(
      createInstance('custom:orpheus', {
        _id: 'orpheus-2',
        id: 'orpheus-2',
        authProfileId: null,
        encryptedApiKey: 'orpheus-key',
        encryptedConfig: { model: 'canopylabs/orpheus-v1-english', voiceId: 'austin' },
      }),
    );

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveServiceCredentials('tenant-1', 'custom:orpheus', {
      instanceId: 'orpheus-2',
    });

    expect(mocks.mockFindActiveVoiceServiceInstanceById).toHaveBeenCalledWith(
      'tenant-1',
      'orpheus-2',
      'custom:orpheus',
    );
    expect(result).toEqual({
      apiKey: 'orpheus-key',
      config: { model: 'canopylabs/orpheus-v1-english', voiceId: 'austin' },
      instanceId: 'orpheus-2',
    });
  });

  it('decrypts stringified legacy voice config before parsing it', async () => {
    mocks.mockFindActiveVoiceServiceInstanceById.mockResolvedValue(
      createInstance('custom:orpheus', {
        _id: 'orpheus-3',
        id: 'orpheus-3',
        authProfileId: null,
        encryptedApiKey: 'ciphertext-api-key',
        encryptedConfig: 'ciphertext-config',
      }),
    );
    mocks.mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => {
        if (value === 'ciphertext-api-key') {
          return 'orpheus-key';
        }
        if (value === 'ciphertext-config') {
          return JSON.stringify({
            model: 'canopylabs/orpheus-v1-english',
            voiceId: 'austin',
          });
        }
        return value ?? null;
      },
    );

    const factory = new VoiceServiceFactory(null);
    const result = await factory.resolveServiceCredentials('tenant-1', 'custom:orpheus', {
      instanceId: 'orpheus-3',
    });

    expect(result).toEqual({
      apiKey: 'orpheus-key',
      config: { model: 'canopylabs/orpheus-v1-english', voiceId: 'austin' },
      instanceId: 'orpheus-3',
    });
  });
});
