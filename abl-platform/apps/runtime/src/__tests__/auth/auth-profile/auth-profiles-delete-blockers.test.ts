import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { buildAuthProfileOAuthProviderKey } from '@agent-platform/shared/services/auth-profile';
import { initDEKFacade } from '@agent-platform/database/kms';
import { setMasterKey } from '@agent-platform/database/models';
import { clearCollections, setupTestMongo, teardownTestMongo } from '../../helpers/setup-mongo.js';
import {
  injectTenantContext,
  makeTenantContext,
  ROLE_PERMISSIONS,
} from '../../helpers/auth-context.js';
import { buildActiveAuthProfileOAuthGrantFilter } from '../../../services/oauth-grant-service.js';

const { fakeRedisClient } = vi.hoisted(() => {
  class FakeRedisClient {
    private readonly locks = new Map<string, string>();

    reset(): void {
      this.locks.clear();
    }

    async set(
      key: string,
      value: string,
      ttlMode: string,
      ttlMs: number,
      createMode: string,
    ): Promise<'OK' | null> {
      void ttlMode;
      void ttlMs;
      void createMode;

      if (this.locks.has(key)) {
        return null;
      }

      this.locks.set(key, value);
      return 'OK';
    }

    async eval(_script: string, _numKeys: number, key: string, value: string): Promise<number> {
      if (this.locks.get(key) !== value) {
        return 0;
      }

      this.locks.delete(key);
      return 1;
    }
  }

  return {
    fakeRedisClient: new FakeRedisClient(),
  };
});

vi.mock('../../../services/redis/redis-client.js', () => ({
  getRedisClient: () => fakeRedisClient,
  getRedisHandle: () => ({
    client: fakeRedisClient,
    isReady: () => true,
    duplicate: () => (fakeRedisClient.duplicate ? fakeRedisClient.duplicate() : fakeRedisClient),
    disconnect: async () => {},
  }),
}));

import { authProfileRoutes } from '../../../routes/auth-profiles.js';

const TEST_TENANT = 'tenant-auth-profile-delete-blockers';
const TEST_USER = 'user-auth-profile-delete-blockers';
const MONGO_SETUP_TIMEOUT_MS = 60_000;

let app: express.Express;
let server: Server;

async function createWorkspaceAuthProfile(name: string): Promise<string> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const profile = await (
    AuthProfile as {
      create(doc: Record<string, unknown>): Promise<{ _id: string }>;
    }
  ).create({
    name,
    tenantId: TEST_TENANT,
    projectId: null,
    scope: 'tenant',
    visibility: 'shared',
    createdBy: TEST_USER,
    authType: 'oauth2_app',
    config: {
      authorizationUrl: 'https://accounts.example.com/o/oauth2/auth',
      tokenUrl: 'https://oauth.example.com/token',
    },
    encryptedSecrets: JSON.stringify({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
    status: 'active',
  });

  return String(profile._id);
}

async function createDurableOAuthGrant(params: {
  profileId: string;
  revokedAt?: Date | null;
}): Promise<void> {
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  await (
    EndUserOAuthToken as {
      create(doc: Record<string, unknown>): Promise<unknown>;
    }
  ).create({
    tenantId: TEST_TENANT,
    userId: '__tenant__',
    provider: buildAuthProfileOAuthProviderKey(params.profileId),
    providerUserId: '__tenant__',
    encryptedAccessToken: 'access-token',
    encryptedRefreshToken: 'refresh-token',
    scope: 'openid email',
    expiresAt: new Date('2026-06-01T00:00:00.000Z'),
    consentedAt: new Date('2026-04-01T00:00:00.000Z'),
    revokedAt: params.revokedAt ?? null,
  });
}

async function loadWorkspaceAuthProfile(profileId: string): Promise<{
  name: string;
  status: string;
} | null> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  return (
    AuthProfile as {
      findOne(filter: Record<string, unknown>): Promise<{ name: string; status: string } | null>;
    }
  ).findOne({
    _id: profileId,
    tenantId: TEST_TENANT,
  });
}

beforeAll(async () => {
  setMasterKey('ab'.repeat(32));
  await setupTestMongo();
  await initDEKFacade({ masterKeyHex: 'ab'.repeat(32) });

  app = express();
  app.use(express.json());
  app.use(
    injectTenantContext(
      makeTenantContext(TEST_TENANT, TEST_USER, 'ADMIN', {
        permissions: [...ROLE_PERMISSIONS.ADMIN, 'auth-profile:delete'],
      }),
    ),
  );
  app.use('/api/auth-profiles', authProfileRoutes);
  server = app.listen(0);

  const { AuthProfile } = await import('@agent-platform/database/models');
  await (AuthProfile as { findOne(filter: Record<string, unknown>): Promise<unknown> }).findOne({
    tenantId: 'warmup',
  });
}, MONGO_SETUP_TIMEOUT_MS);

beforeEach(() => {
  fakeRedisClient.reset();
});

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  server?.close();
  await teardownTestMongo();
}, MONGO_SETUP_TIMEOUT_MS);

describe('DELETE /api/auth-profiles/:id durable grant blockers', () => {
  it('returns 409 and leaves the profile active when a live durable OAuth grant exists', async () => {
    const profileId = await createWorkspaceAuthProfile('Workspace OAuth App With Grant');
    await createDurableOAuthGrant({ profileId });

    const response = await request(server).delete(`/api/auth-profiles/${profileId}`);

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('PROFILE_IN_USE');
    expect(response.body.error.consumers).toEqual([
      {
        type: 'EndUserOAuthToken',
        count: 1,
      },
    ]);

    const storedProfile = await loadWorkspaceAuthProfile(profileId);
    expect(storedProfile).toMatchObject({
      name: 'Workspace OAuth App With Grant',
      status: 'active',
    });
  });

  it('builds delete-blocker filters that only match active durable OAuth grants', () => {
    expect(
      buildActiveAuthProfileOAuthGrantFilter({
        tenantId: TEST_TENANT,
        profileId: 'profile-123',
      }),
    ).toEqual({
      tenantId: TEST_TENANT,
      provider: buildAuthProfileOAuthProviderKey('profile-123'),
      revokedAt: null,
    });
  });
});
