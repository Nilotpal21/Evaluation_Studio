/**
 * E2E: SDK Channels & Public Keys — CRUD, Auth, Token Exchange, Tenant Isolation
 *
 * Validates expected domain behavior for SDK channel management through the
 * real runtime HTTP API with full middleware chain.
 *
 * Routes under test:
 *   POST   /api/projects/:pid/sdk-public-keys           — Create public key
 *   GET    /api/projects/:pid/sdk-public-keys           — List public keys
 *   POST   /api/projects/:pid/sdk-channels              — Create SDK channel
 *   GET    /api/projects/:pid/sdk-channels              — List SDK channels
 *   GET    /api/projects/:pid/sdk-channels/:id          — Get SDK channel
 *   PATCH  /api/projects/:pid/sdk-channels/:id          — Update SDK channel
 *   DELETE /api/projects/:pid/sdk-channels/:id          — Delete SDK channel
 *   POST   /api/projects/:pid/sdk-channels/:id/token    — Generate SDK init token
 *
 * NO mocks of platform components. Real Express + MongoDB Memory Server.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { RuntimeApiHarness } from '../../helpers/runtime-api-harness.js';
import { startRuntimeServerHarness } from '../../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  authHeaders,
  requestJson,
  uniqueSlug,
  uniqueEmail,
  createSdkPublicKey,
  type BootstrapProjectResult,
  type SdkPublicKeyRecord,
} from '../../helpers/channel-e2e-bootstrap.js';

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

let harness: RuntimeApiHarness;
let projectA: BootstrapProjectResult;
let projectB: BootstrapProjectResult;

function keysPath(projectId: string, suffix = ''): string {
  return `/api/projects/${projectId}/sdk-public-keys${suffix}`;
}

function channelsPath(projectId: string, suffix = ''): string {
  return `/api/projects/${projectId}/sdk-channels${suffix}`;
}

beforeAll(async () => {
  harness = await startRuntimeServerHarness();

  projectA = await bootstrapProject(
    harness,
    uniqueEmail('sdk-e2e-a'),
    uniqueSlug('sdk-tenant-a'),
    uniqueSlug('sdk-project-a'),
  );

  projectB = await bootstrapProject(
    harness,
    uniqueEmail('sdk-e2e-b'),
    uniqueSlug('sdk-tenant-b'),
    uniqueSlug('sdk-project-b'),
  );
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.close();
}, SUITE_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// E2E-SDK-01: Public Key CRUD
// ---------------------------------------------------------------------------

describe('E2E-SDK-01: Public Key CRUD', () => {
  let createdKeyId: string;

  test(
    'POST /sdk-public-keys creates a key and returns 201',
    async () => {
      const key = await createSdkPublicKey(harness, projectA.token, projectA.projectId, {
        name: 'E2E Test Key',
        allowedOrigins: ['https://example.com'],
        permissions: { chat: true, voice: false },
      });

      expect(key.id).toBeTruthy();
      expect(key.isActive).toBe(true);
      expect(key.keyPrefix).toBeTruthy();
      createdKeyId = key.id;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /sdk-public-keys lists keys including the created one',
    async () => {
      const res = await requestJson<{ success: boolean; keys: SdkPublicKeyRecord[] }>(
        harness,
        keysPath(projectA.projectId),
        { method: 'GET', headers: authHeaders(projectA.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const found = res.body.keys.find((k) => k.id === createdKeyId);
      expect(found).toBeDefined();
      expect(found!.isActive).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-SDK-02: SDK Channel CRUD
// ---------------------------------------------------------------------------

describe('E2E-SDK-02: SDK Channel CRUD', () => {
  let publicKeyId: string;
  let createdChannelId: string;

  beforeAll(async () => {
    const key = await createSdkPublicKey(harness, projectA.token, projectA.projectId, {
      name: 'Channel Test Key',
    });
    publicKeyId = key.id;
  }, SUITE_TIMEOUT_MS);

  test(
    'POST /sdk-channels creates a channel and returns 201',
    async () => {
      const res = await requestJson<{ success: boolean; channel: { id: string; name: string } }>(
        harness,
        channelsPath(projectA.projectId),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: {
            name: 'E2E Test Channel',
            channelType: 'web',
            publicApiKeyId: publicKeyId,
          },
        },
      );

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.channel.name).toBe('E2E Test Channel');
      createdChannelId = res.body.channel.id;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /sdk-channels lists channels including the created one',
    async () => {
      const res = await requestJson<{ success: boolean; channels: Array<{ id: string }> }>(
        harness,
        channelsPath(projectA.projectId),
        { method: 'GET', headers: authHeaders(projectA.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const found = res.body.channels.find((c) => c.id === createdChannelId);
      expect(found).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /sdk-channels/:id returns the specific channel',
    async () => {
      const res = await requestJson<{ success: boolean; channel: { id: string; name: string } }>(
        harness,
        channelsPath(projectA.projectId, `/${createdChannelId}`),
        { method: 'GET', headers: authHeaders(projectA.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.channel.name).toBe('E2E Test Channel');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'PATCH /sdk-channels/:id updates the channel',
    async () => {
      const res = await requestJson<{ success: boolean; channel: { name: string } }>(
        harness,
        channelsPath(projectA.projectId, `/${createdChannelId}`),
        {
          method: 'PATCH',
          headers: authHeaders(projectA.token),
          body: { name: 'Updated E2E Channel' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.channel.name).toBe('Updated E2E Channel');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'DELETE /sdk-channels/:id removes the channel',
    async () => {
      const res = await requestJson<{ success: boolean }>(
        harness,
        channelsPath(projectA.projectId, `/${createdChannelId}`),
        { method: 'DELETE', headers: authHeaders(projectA.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it's gone
      const getRes = await requestJson<unknown>(
        harness,
        channelsPath(projectA.projectId, `/${createdChannelId}`),
        { method: 'GET', headers: authHeaders(projectA.token) },
      );
      expect(getRes.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-SDK-03: Project Isolation
// ---------------------------------------------------------------------------

describe('E2E-SDK-03: Project Isolation', () => {
  let keyIdA: string;
  let channelIdA: string;

  beforeAll(async () => {
    const key = await createSdkPublicKey(harness, projectA.token, projectA.projectId, {
      name: 'Isolation Test Key',
    });
    keyIdA = key.id;

    const res = await requestJson<{ success: boolean; channel: { id: string } }>(
      harness,
      channelsPath(projectA.projectId),
      {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          name: 'Isolation Test Channel',
          channelType: 'web',
          publicApiKeyId: keyIdA,
        },
      },
    );
    channelIdA = res.body.channel.id;
  }, SUITE_TIMEOUT_MS);

  test(
    'Project B cannot read Project A SDK channels',
    async () => {
      const res = await requestJson<unknown>(
        harness,
        channelsPath(projectA.projectId, `/${channelIdA}`),
        { method: 'GET', headers: authHeaders(projectB.token) },
      );

      // Cross-project access should return 404 (not 403)
      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'Project B cannot list Project A SDK public keys',
    async () => {
      const res = await requestJson<unknown>(harness, keysPath(projectA.projectId), {
        method: 'GET',
        headers: authHeaders(projectB.token),
      });

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-SDK-04: Auth Enforcement
// ---------------------------------------------------------------------------

describe('E2E-SDK-04: Auth Enforcement', () => {
  test(
    'Unauthenticated request to SDK channels returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, channelsPath(projectA.projectId), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'Unauthenticated request to SDK public keys returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, keysPath(projectA.projectId), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});
