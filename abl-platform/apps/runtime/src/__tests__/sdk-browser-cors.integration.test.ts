import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  bootstrapProject,
  createSdkBootstrapChannel,
  createSdkPublicKey,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';

describe('browser SDK CORS integration', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness({}, { autoIndex: false });
  }, 120_000);

  beforeEach(async () => {
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await harness.close();
  }, 120_000);

  test('reflects external origins on successful sdk init responses', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-cors-success-admin'),
      uniqueSlug('tenant-sdk-cors-success'),
      uniqueSlug('project-sdk-cors-success'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Cross-Origin SDK Key',
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const origin = 'https://customer.example.com';
    const response = await requestJson<{ token: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Public-Key': key.key!,
      },
      body: {},
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('vary') ?? '').toContain('Origin');
    expect(typeof response.body.token).toBe('string');
  });

  test('allows preflight requests for external sdk init callers', async () => {
    const origin = 'https://customer.example.com';
    const response = await requestJson<Record<string, never>>(harness, '/api/v1/sdk/init', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-public-key',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods') ?? '').toContain('POST');
    expect(response.headers.get('access-control-allow-headers') ?? '').toContain('X-Public-Key');
    expect(response.headers.get('vary') ?? '').toContain('Origin');
  });

  test('reflects external origins even when sdk init is blocked by an allowlist', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-cors-blocked-admin'),
      uniqueSlug('tenant-sdk-cors-blocked'),
      uniqueSlug('project-sdk-cors-blocked'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Origin Locked SDK Key',
      allowedOrigins: ['https://allowed.example'],
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const blockedOrigin = 'https://blocked.example';
    const response = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        Origin: blockedOrigin,
        'X-Public-Key': key.key!,
      },
      body: {},
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Origin not allowed');
    expect(response.headers.get('access-control-allow-origin')).toBe(blockedOrigin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('vary') ?? '').toContain('Origin');
  });
});
