import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';

type ServiceInstanceResponse = {
  success: boolean;
  instance: {
    id: string;
    displayName: string;
    serviceType: string;
    isActive: boolean;
    isDefault: boolean;
    config?: Record<string, unknown>;
  };
  error?: string;
};

type ServiceInstanceListResponse = {
  success: boolean;
  instances: Array<{
    id: string;
    displayName: string;
    serviceType: string;
    isActive: boolean;
    config?: Record<string, unknown>;
  }>;
  error?: string;
};

type DeleteServiceInstanceResponse = {
  success: boolean;
  deleted: string;
  error?: string;
};

describe('voice provider registry service-instance E2E', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness(
      {
        JAMBONZ_BASE_API_URL: undefined,
        JAMBONZ_ACCOUNT_SID: undefined,
        JAMBONZ_API_KEY: undefined,
      },
      { bootstrapServer: true },
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  test('accepts registry-backed providers, preserves public config, rejects azure, and fails cross-tenant access closed', async () => {
    const tenantA = await bootstrapProject(
      harness,
      uniqueEmail('voice-registry-a'),
      uniqueSlug('voice-registry-a'),
      uniqueSlug('voice-registry-a-project'),
    );
    const tenantB = await bootstrapProject(
      harness,
      uniqueEmail('voice-registry-b'),
      uniqueSlug('voice-registry-b'),
      uniqueSlug('voice-registry-b-project'),
    );

    const createMicrosoft = await requestJson<ServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances`,
      {
        method: 'POST',
        headers: authHeaders(tenantA.token),
        body: {
          displayName: 'Azure Speech Custom STT',
          serviceType: 'microsoft',
          apiKey: 'azure-speech-key',
          config: {
            region: 'eastus',
            customSttEndpointId: 'endpoint-123',
            customSttEndpointUrl: 'https://speech.example.com/custom',
          },
          isDefault: true,
        },
      },
    );

    expect(createMicrosoft.status, JSON.stringify(createMicrosoft.body)).toBe(201);
    expect(createMicrosoft.body.instance).toMatchObject({
      serviceType: 'microsoft',
      isDefault: true,
      config: {
        region: 'eastus',
        customSttEndpointId: 'endpoint-123',
        customSttEndpointUrl: 'https://speech.example.com/custom',
      },
    });
    expect(createMicrosoft.body.instance).not.toHaveProperty('apiKey');

    const createGoogle = await requestJson<ServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances`,
      {
        method: 'POST',
        headers: authHeaders(tenantA.token),
        body: {
          displayName: 'Google Chirp STT',
          serviceType: 'google',
          apiKey: JSON.stringify({
            type: 'service_account',
            client_email: 'speech@example.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
          }),
          config: {
            modelId: 'chirp_3',
          },
        },
      },
    );

    expect(createGoogle.status, JSON.stringify(createGoogle.body)).toBe(201);
    expect(createGoogle.body.instance).toMatchObject({
      serviceType: 'google',
      config: {
        modelId: 'chirp_3',
      },
    });
    expect(createGoogle.body.instance).not.toHaveProperty('apiKey');

    const createDeepgram = await requestJson<ServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances`,
      {
        method: 'POST',
        headers: authHeaders(tenantA.token),
        body: {
          displayName: 'Existing Deepgram STT',
          serviceType: 'deepgram',
          apiKey: 'deepgram-key',
          config: {
            model: 'nova-3',
          },
        },
      },
    );
    expect(createDeepgram.status, JSON.stringify(createDeepgram.body)).toBe(201);
    expect(createDeepgram.body.instance).toMatchObject({
      serviceType: 'deepgram',
      config: {
        model: 'nova-3',
      },
    });

    const createElevenLabs = await requestJson<ServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances`,
      {
        method: 'POST',
        headers: authHeaders(tenantA.token),
        body: {
          displayName: 'Existing ElevenLabs TTS',
          serviceType: 'elevenlabs',
          apiKey: 'elevenlabs-key',
          config: {
            voiceId: 'EXAVITQu4vr4xnSDxMaL',
            model: 'eleven_multilingual_v2',
          },
        },
      },
    );
    expect(createElevenLabs.status, JSON.stringify(createElevenLabs.body)).toBe(201);
    expect(createElevenLabs.body.instance).toMatchObject({
      serviceType: 'elevenlabs',
      config: {
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        model: 'eleven_multilingual_v2',
      },
    });

    const rejectAzure = await requestJson<ServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances`,
      {
        method: 'POST',
        headers: authHeaders(tenantA.token),
        body: {
          displayName: 'Externally Managed Azure Speech',
          serviceType: 'azure',
          apiKey: 'azure-key',
        },
      },
    );
    expect(rejectAzure.status).toBe(400);
    expect(rejectAzure.body.error).toContain('Invalid serviceType');

    const listActive = await requestJson<ServiceInstanceListResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances?isActive=true`,
      {
        method: 'GET',
        headers: authHeaders(tenantA.token),
      },
    );
    expect(listActive.status, JSON.stringify(listActive.body)).toBe(200);
    expect(listActive.body.instances.map((instance) => instance.serviceType).sort()).toEqual([
      'deepgram',
      'elevenlabs',
      'google',
      'microsoft',
    ]);
    expect(listActive.body.instances.find((instance) => instance.serviceType === 'google')).toEqual(
      expect.objectContaining({
        config: {
          modelId: 'chirp_3',
        },
      }),
    );

    const crossTenantList = await requestJson<ServiceInstanceListResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances`,
      {
        method: 'GET',
        headers: authHeaders(tenantB.token),
      },
    );
    expect(crossTenantList.status).toBe(403);
    expect(crossTenantList.body.success).toBe(false);

    const crossTenantPatch = await requestJson<ServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances/${createGoogle.body.instance.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(tenantB.token),
        body: {
          displayName: 'Cross Tenant Update',
        },
      },
    );
    expect(crossTenantPatch.status).toBe(403);
    expect(crossTenantPatch.body.success).toBe(false);

    const patchGoogle = await requestJson<ServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances/${createGoogle.body.instance.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(tenantA.token),
        body: {
          isActive: false,
          config: {
            modelId: 'latest_long',
          },
        },
      },
    );
    expect(patchGoogle.status, JSON.stringify(patchGoogle.body)).toBe(200);
    expect(patchGoogle.body.instance).toMatchObject({
      serviceType: 'google',
      isActive: false,
      config: {
        modelId: 'latest_long',
      },
    });

    const deleteMicrosoft = await requestJson<DeleteServiceInstanceResponse>(
      harness,
      `/api/tenants/${tenantA.tenantId}/service-instances/${createMicrosoft.body.instance.id}`,
      {
        method: 'DELETE',
        headers: authHeaders(tenantA.token),
      },
    );
    expect(deleteMicrosoft.status, JSON.stringify(deleteMicrosoft.body)).toBe(200);
    expect(deleteMicrosoft.body).toEqual({
      success: true,
      deleted: createMicrosoft.body.instance.id,
    });
  }, 120_000);
});
