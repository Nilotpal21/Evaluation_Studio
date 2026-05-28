import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const {
  mockRequireProjectPermission,
  mockDecryptForTenant,
  mockEncryptForTenantAuto,
  mockIsTenantEncryptionReady,
  mockUpdateApplication,
  mockCreateSpeechCredential,
  mockFindSpeechCredentialByVendorAndLabel,
  mockDeleteSpeechCredential,
  mockAddPhoneNumber,
  mockLogger,
  mockCreate,
  mockFindOne,
  mockFindOneAndUpdate,
  makeExistingDoc,
  updateDocState,
  updateDoc,
} = vi.hoisted(() => {
  const mockRequireProjectPermission = vi.fn(async () => true);
  const mockDecryptForTenant = vi.fn(() => 'plain-inbound-token');
  const mockEncryptForTenantAuto = vi.fn(async (value: string) => `enc:${value}`);
  const mockIsTenantEncryptionReady = vi.fn(() => true);
  const mockUpdateApplication = vi.fn(async () => undefined);
  const mockCreateSpeechCredential = vi.fn(async () => 'speech-cred-001');
  const mockFindSpeechCredentialByVendorAndLabel = vi.fn(async () => null);
  const mockDeleteSpeechCredential = vi.fn(async () => undefined);
  const mockAddPhoneNumber = vi.fn(async () => 'new-pn');
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const makeExistingDoc = () => ({
    _id: 'conn-1',
    id: 'conn-1',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    channelType: 'voice_pipeline',
    displayName: 'Voice Pipeline',
    externalIdentifier: '+15551230000',
    encryptedCredentials: null,
    status: 'active',
    config: {
      provider: 'jambonz',
      asrVendor: 'deepgram',
      encryptedInboundAuthToken: 'enc-token',
      jambonzApplicationSid: 'app-123',
      jambonzPhoneNumberSid: 'pn-123',
      jambonzVoipCarrierSid: 'carrier-123',
      jambonzSipGatewaySid: 'gateway-123',
      twilioPhoneNumberSid: 'twilio-pn-123',
      phoneNumberSid: 'db-pn-123',
      orpheusSpeechCredentialSid: 'speech-cred-123',
      humeSpeechCredentialSid: 'hume-cred-123',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const updateDocState: { current: Record<string, unknown> } = { current: {} };
  const updateDoc = {
    lean: vi.fn(async () => makeExistingDoc()),
    set: vi.fn((key: string, value: unknown) => {
      updateDocState.current[key] = value;
    }),
    markModified: vi.fn(),
    save: vi.fn(async () => undefined),
    toObject: vi.fn(() => ({
      ...makeExistingDoc(),
      ...updateDocState.current,
    })),
  };

  const mockFindOne = vi.fn((query: Record<string, unknown>) => {
    if (query.projectId) {
      return updateDoc;
    }
    return {
      lean: vi.fn(async () => makeExistingDoc()),
    };
  });
  const mockCreate = vi.fn(async (payload: Record<string, unknown>) => ({
    _id: 'conn-created',
    id: 'conn-created',
    projectId: payload.projectId,
    tenantId: payload.tenantId,
    channelType: payload.channelType,
    displayName: payload.displayName,
    externalIdentifier: payload.externalIdentifier,
    encryptedCredentials: payload.encryptedCredentials,
    status: payload.status,
    config: payload.config,
    deploymentId: payload.deploymentId,
    environment: payload.environment,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const mockFindOneAndUpdate = vi.fn(async () => undefined);

  return {
    mockRequireProjectPermission,
    mockDecryptForTenant,
    mockEncryptForTenantAuto,
    mockIsTenantEncryptionReady,
    mockUpdateApplication,
    mockCreateSpeechCredential,
    mockFindSpeechCredentialByVendorAndLabel,
    mockDeleteSpeechCredential,
    mockAddPhoneNumber,
    mockLogger,
    mockCreate,
    mockFindOne,
    mockFindOneAndUpdate,
    makeExistingDoc,
    updateDocState,
    updateDoc,
  };
});

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
    next();
  }),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: Parameters<typeof mockRequireProjectPermission>) =>
    mockRequireProjectPermission(...args),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  encryptForTenantAuto: (...args: Parameters<typeof mockEncryptForTenantAuto>) =>
    mockEncryptForTenantAuto(...args),
  isTenantEncryptionReady: (...args: Parameters<typeof mockIsTenantEncryptionReady>) =>
    mockIsTenantEncryptionReady(...args),
  decryptForTenantAuto: (...args: Parameters<typeof mockDecryptForTenant>) =>
    mockDecryptForTenant(...args),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    voice: {
      jambonz: {
        voipCarrierSid: 'carrier-456',
      },
    },
  })),
}));

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: vi.fn(async () => null),
  findDeploymentById: vi.fn(async () => null),
}));

vi.mock('../../channels/manifest.js', () => ({
  CONNECTION_CAPABLE_TYPES: ['voice_pipeline', 'voice_realtime'],
  VOICE_TYPES: new Set(['voice_pipeline', 'voice_realtime']),
  buildWebhookUrl: vi.fn(() => null),
  getRequiredCredentials: vi.fn(() => []),
}));

vi.mock('../../channels/adapters/provider-api-base.js', () => ({
  getDisallowedProviderApiBaseOverrides: vi.fn(() => []),
  resolveProviderApiBase: vi.fn(() => undefined),
}));

vi.mock('../../services/a2a/agent-card-builder.js', () => ({
  invalidateCard: vi.fn(async () => undefined),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('@agent-platform/database/models', () => ({
  ChannelConnection: {
    create: (...args: Parameters<typeof mockCreate>) => mockCreate(...args),
    findOne: (...args: Parameters<typeof mockFindOne>) => mockFindOne(...args),
    findOneAndUpdate: (...args: Parameters<typeof mockFindOneAndUpdate>) =>
      mockFindOneAndUpdate(...args),
  },
}));

vi.mock('../../services/voice/jambonz-provisioning.service.js', () => ({
  getJambonzProvisioningService: vi.fn(() => ({
    updateApplication: (...args: Parameters<typeof mockUpdateApplication>) =>
      mockUpdateApplication(...args),
    createSpeechCredential: (...args: Parameters<typeof mockCreateSpeechCredential>) =>
      mockCreateSpeechCredential(...args),
    findSpeechCredentialByVendorAndLabel: (
      ...args: Parameters<typeof mockFindSpeechCredentialByVendorAndLabel>
    ) => mockFindSpeechCredentialByVendorAndLabel(...args),
    createApplication: vi.fn(async () => 'new-app'),
    addPhoneNumber: (...args: Parameters<typeof mockAddPhoneNumber>) => mockAddPhoneNumber(...args),
    deletePhoneNumber: vi.fn(async () => undefined),
    deleteSipGateway: vi.fn(async () => undefined),
    deleteVoipCarrier: vi.fn(async () => undefined),
    deleteApplication: vi.fn(async () => undefined),
    deleteSpeechCredential: (...args: Parameters<typeof mockDeleteSpeechCredential>) =>
      mockDeleteSpeechCredential(...args),
  })),
}));

import express from 'express';

async function createServer() {
  const app = express();
  app.use(express.json());

  const router = (await import('../../routes/channel-connections.js')).default;
  app.use('/api/projects/:projectId/channel-connections', router);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

describe('channel-connections voice PATCH', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    const created = await createServer();
    baseUrl = created.baseUrl;
    server = created.server;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ORPHEUS_TTS_AUTH_TOKEN = 'route-token';
    updateDocState.current = {};
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.projectId) {
        return updateDoc;
      }
      return {
        lean: vi.fn(async () => makeExistingDoc()),
      };
    });
    updateDoc.set.mockImplementation((key: string, value: unknown) => {
      updateDocState.current[key] = value;
    });
    updateDoc.lean.mockImplementation(async () => makeExistingDoc());
    updateDoc.toObject.mockImplementation(() => ({
      ...makeExistingDoc(),
      ...updateDocState.current,
    }));
    mockCreate.mockImplementation(async (payload: Record<string, unknown>) => ({
      _id: 'conn-created',
      id: 'conn-created',
      projectId: payload.projectId,
      tenantId: payload.tenantId,
      channelType: payload.channelType,
      displayName: payload.displayName,
      externalIdentifier: payload.externalIdentifier,
      encryptedCredentials: payload.encryptedCredentials,
      status: payload.status,
      config: payload.config,
      deploymentId: payload.deploymentId,
      environment: payload.environment,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  });

  test('allows create for voice_realtime without an explicit s2s provider', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: 'voice_realtime',
        external_identifier: '+15550001111',
        config: {
          mode: 'realtime',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'voice_realtime',
        config: expect.objectContaining({
          mode: 'realtime',
        }),
      }),
    );
  });

  test('rejects OpenAI realtime create with temperature below provider minimum', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: 'voice_realtime',
        external_identifier: '+15550001111',
        config: {
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sTemperature: 0.1,
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 's2s:openai temperature must be between 0.6 and 1.2',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('rejects unsupported realtime S2S providers', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: 'voice_realtime',
        external_identifier: '+15550001111',
        config: {
          mode: 'realtime',
          s2sProvider: 's2s:deepgram',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error:
        'Realtime voice S2S provider must be one of: s2s:openai, s2s:microsoft, s2s:google, s2s:grok',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('allows Azure OpenAI realtime config with service-instance deployment fallback', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: 'voice_realtime',
        external_identifier: '+15550001111',
        config: {
          mode: 'realtime',
          s2sProvider: 's2s:microsoft',
          s2sVoice: 'marin',
          s2sTemperature: 0.8,
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'voice_realtime',
        config: expect.objectContaining({
          s2sProvider: 's2s:microsoft',
          s2sVoice: 'marin',
          s2sTemperature: 0.8,
        }),
      }),
    );
  });

  test('rejects stale provider-mismatched model and voice fields', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: 'voice_realtime',
        external_identifier: '+15550001111',
        config: {
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gemini-3.1-flash-live-preview',
          s2sVoice: 'Puck',
          s2sTemperature: 0.8,
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'OpenAI Realtime model must be a realtime-capable model',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('allows zero temperature for Google realtime config', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: 'voice_realtime',
        external_identifier: '+15550001111',
        config: {
          mode: 'realtime',
          s2sProvider: 's2s:google',
          s2sModel: 'gemini-3.1-flash-live-preview',
          s2sVoice: 'Puck',
          s2sTemperature: 0,
          s2sStartSensitivity: 'START_SENSITIVITY_HIGH',
          s2sEndSensitivity: 'END_SENSITIVITY_LOW',
          s2sSilenceDuration: 900,
          s2sPrefixPadding: 250,
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'voice_realtime',
        config: expect.objectContaining({
          s2sProvider: 's2s:google',
          s2sTemperature: 0,
          s2sStartSensitivity: 'START_SENSITIVITY_HIGH',
          s2sEndSensitivity: 'END_SENSITIVITY_LOW',
          s2sSilenceDuration: 900,
          s2sPrefixPadding: 250,
        }),
      }),
    );
  });

  test('rejects unsupported Google realtime sensitivity values', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_type: 'voice_realtime',
        external_identifier: '+15550001111',
        config: {
          mode: 'realtime',
          s2sProvider: 's2s:google',
          s2sModel: 'gemini-3.1-flash-live-preview',
          s2sVoice: 'Puck',
          s2sTemperature: 0.8,
          s2sStartSensitivity: 'HIGH',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'Google realtime start sensitivity is not supported',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('rejects OpenAI realtime PATCH when a preserved temperature is below provider minimum', async () => {
    const realtimeConnection = {
      ...makeExistingDoc(),
      channelType: 'voice_realtime',
      config: {
        mode: 'realtime',
        s2sProvider: 's2s:openai',
        s2sModel: 'gpt-realtime-1.5',
        s2sTemperature: 0.1,
      },
    };

    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.projectId) {
        updateDoc.lean.mockImplementation(async () => realtimeConnection);
        return updateDoc;
      }
      return {
        lean: vi.fn(async () => realtimeConnection),
      };
    });

    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections/conn-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'realtime',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 's2s:openai temperature must be between 0.6 and 1.2',
    });
    expect(updateDoc.set).not.toHaveBeenCalled();
  });

  test('preserves hidden voice gateway fields across config PATCH', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections/conn-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          asrVendor: 'deepgram',
          ttsVendor: 'elevenlabs',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    const savedConfig = updateDocState.current.config as Record<string, unknown>;
    expect(savedConfig).toMatchObject({
      asrVendor: 'deepgram',
      ttsVendor: 'elevenlabs',
      encryptedInboundAuthToken: 'enc-token',
      jambonzApplicationSid: 'app-123',
      jambonzPhoneNumberSid: 'pn-123',
      jambonzVoipCarrierSid: 'carrier-123',
      jambonzSipGatewaySid: 'gateway-123',
      twilioPhoneNumberSid: 'twilio-pn-123',
      phoneNumberSid: 'db-pn-123',
      humeSpeechCredentialSid: 'hume-cred-123',
    });
    expect(savedConfig).not.toHaveProperty('inboundAuthToken');
    expect(savedConfig).not.toHaveProperty('orpheusSpeechCredentialSid');

    expect(body.connection.config).toMatchObject({
      asrVendor: 'deepgram',
      ttsVendor: 'elevenlabs',
      jambonzApplicationSid: 'app-123',
      jambonzPhoneNumberSid: 'pn-123',
      jambonzVoipCarrierSid: 'carrier-123',
      jambonzSipGatewaySid: 'gateway-123',
      twilioPhoneNumberSid: 'twilio-pn-123',
      phoneNumberSid: 'db-pn-123',
      humeSpeechCredentialSid: 'hume-cred-123',
    });
    expect(body.connection.config).not.toHaveProperty('encryptedInboundAuthToken');
    expect(body.connection.config).not.toHaveProperty('orpheusSpeechCredentialSid');
    expect(mockUpdateApplication).toHaveBeenCalledTimes(1);
    expect(mockDeleteSpeechCredential).toHaveBeenCalledWith('speech-cred-123');
  });

  test('allows explicit realtime PATCH without an s2s provider', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections/conn-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'realtime',
          ttsVendor: 'elevenlabs',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(updateDocState.current.config).toMatchObject({
      mode: 'realtime',
      ttsVendor: 'elevenlabs',
    });
  });

  test('creates Orpheus speech credential when switching to custom Orpheus TTS', async () => {
    updateDoc.toObject.mockImplementation(() => ({
      ...makeExistingDoc(),
      config: {
        ...makeExistingDoc().config,
        ttsVendor: 'elevenlabs',
        orpheusSpeechCredentialSid: undefined,
      },
      ...updateDocState.current,
    }));
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.projectId) {
        updateDoc.lean.mockImplementation(async () => ({
          ...makeExistingDoc(),
          config: {
            ...makeExistingDoc().config,
            ttsVendor: 'elevenlabs',
            orpheusSpeechCredentialSid: undefined,
          },
        }));
        return updateDoc;
      }
      return {
        lean: vi.fn(async () => ({
          ...makeExistingDoc(),
          config: {
            ...makeExistingDoc().config,
            ttsVendor: 'elevenlabs',
            orpheusSpeechCredentialSid: undefined,
          },
        })),
      };
    });

    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections/conn-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          asrVendor: 'deepgram',
          ttsVendor: 'custom:orpheus',
          ttsServiceInstanceId: 'svc-orpheus-1',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockCreateSpeechCredential).toHaveBeenCalledTimes(1);
    expect(mockCreateSpeechCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: 'custom:orpheus',
        customTtsUrl:
          'http://localhost:3112/api/v1/voice/custom-tts/orpheus?tenantId=tenant-1&serviceInstanceId=svc-orpheus-1',
        customTtsStreamingUrl:
          'ws://localhost:3112/ws/custom-tts/orpheus?tenantId=tenant-1&serviceInstanceId=svc-orpheus-1',
      }),
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conn-1', tenantId: 'tenant-1', projectId: 'proj-1' },
      { $set: { 'config.orpheusSpeechCredentialSid': 'speech-cred-001' } },
    );
  });

  test('reuses existing Orpheus speech credential on duplicate-label error and still registers DID', async () => {
    updateDoc.toObject.mockImplementation(() => ({
      ...makeExistingDoc(),
      config: {
        ...makeExistingDoc().config,
        ttsVendor: 'custom:orpheus',
        phoneNumber: '+17405308304',
        jambonzPhoneNumberSid: undefined,
        orpheusSpeechCredentialSid: undefined,
      },
      ...updateDocState.current,
    }));
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.projectId) {
        updateDoc.lean.mockImplementation(async () => ({
          ...makeExistingDoc(),
          config: {
            ...makeExistingDoc().config,
            ttsVendor: 'custom:orpheus',
            phoneNumber: '+17405308304',
            jambonzPhoneNumberSid: undefined,
            orpheusSpeechCredentialSid: undefined,
          },
        }));
        return updateDoc;
      }
      return {
        lean: vi.fn(async () => ({
          ...makeExistingDoc(),
          config: {
            ...makeExistingDoc().config,
            ttsVendor: 'custom:orpheus',
            phoneNumber: '+17405308304',
            jambonzPhoneNumberSid: undefined,
            orpheusSpeechCredentialSid: undefined,
          },
        })),
      };
    });
    mockCreateSpeechCredential.mockRejectedValueOnce(
      new Error(
        'Jambonz API error 422 /SpeechCredentials: {"msg":"Label t:tenant-1 is already in use for another speech credential"}',
      ),
    );
    mockFindSpeechCredentialByVendorAndLabel.mockResolvedValueOnce('speech-cred-existing');

    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections/conn-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          asrVendor: 'deepgram',
          ttsVendor: 'custom:orpheus',
          ttsServiceInstanceId: 'svc-orpheus-1',
          phoneNumber: '+17405308304',
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockFindSpeechCredentialByVendorAndLabel).toHaveBeenCalledWith(
      'custom:orpheus',
      't:tenant-1',
    );
    expect(mockAddPhoneNumber).toHaveBeenCalledWith({
      phoneNumber: '+17405308304',
      applicationSid: 'app-123',
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conn-1', tenantId: 'tenant-1', projectId: 'proj-1' },
      { $set: { 'config.jambonzPhoneNumberSid': 'new-pn' } },
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conn-1', tenantId: 'tenant-1', projectId: 'proj-1' },
      { $set: { 'config.orpheusSpeechCredentialSid': 'speech-cred-existing' } },
    );
  });

  test('recreates Orpheus speech credential when the selected service instance changes', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections/conn-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          asrVendor: 'deepgram',
          ttsVendor: 'custom:orpheus',
          ttsServiceInstanceId: 'svc-orpheus-2',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockDeleteSpeechCredential).toHaveBeenCalledWith('speech-cred-123');
    expect(mockCreateSpeechCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        customTtsUrl:
          'http://localhost:3112/api/v1/voice/custom-tts/orpheus?tenantId=tenant-1&serviceInstanceId=svc-orpheus-2',
        customTtsStreamingUrl:
          'ws://localhost:3112/ws/custom-tts/orpheus?tenantId=tenant-1&serviceInstanceId=svc-orpheus-2',
      }),
    );
  });

  test('preserves explicit Orpheus WS streaming flag across voice config PATCH', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/channel-connections/conn-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          asrVendor: 'deepgram',
          ttsVendor: 'custom:orpheus',
          orpheusWsStreamingEnabled: true,
        },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    const savedConfig = updateDocState.current.config as Record<string, unknown>;
    expect(savedConfig).toMatchObject({
      asrVendor: 'deepgram',
      ttsVendor: 'custom:orpheus',
      orpheusWsStreamingEnabled: true,
      encryptedInboundAuthToken: 'enc-token',
      jambonzApplicationSid: 'app-123',
      twilioPhoneNumberSid: 'twilio-pn-123',
      phoneNumberSid: 'db-pn-123',
      orpheusSpeechCredentialSid: 'speech-cred-123',
    });

    expect(body.connection.config).toMatchObject({
      asrVendor: 'deepgram',
      ttsVendor: 'custom:orpheus',
      orpheusWsStreamingEnabled: true,
      jambonzApplicationSid: 'app-123',
      twilioPhoneNumberSid: 'twilio-pn-123',
      phoneNumberSid: 'db-pn-123',
      orpheusSpeechCredentialSid: 'speech-cred-123',
    });
  });
});
