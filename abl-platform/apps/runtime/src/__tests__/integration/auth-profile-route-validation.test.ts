import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { initDEKFacade } from '@agent-platform/database/kms';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

import { setMasterKey } from '@agent-platform/database/models';
import { authProfileRoutes } from '../../routes/auth-profiles.js';
import {
  ROLE_PERMISSIONS,
  injectTenantContext,
  makeTenantContext,
} from '../helpers/auth-context.js';
import { clearCollections, setupTestMongo, teardownTestMongo } from '../helpers/setup-mongo.js';

const TEST_TENANT = 'tenant-auth-profile-route';
const TEST_USER = 'user-auth-profile-route';

let app: express.Express;
let server: Server;

beforeAll(async () => {
  setMasterKey('ab'.repeat(32));
  await setupTestMongo();
  await initDEKFacade({ masterKeyHex: 'ab'.repeat(32) });

  app = express();
  app.use(express.json());
  app.use(
    injectTenantContext(
      makeTenantContext(TEST_TENANT, TEST_USER, 'ADMIN', {
        permissions: [
          ...ROLE_PERMISSIONS.ADMIN,
          'auth-profile:create',
          'auth-profile:read',
          'auth-profile:delete',
        ],
      }),
    ),
  );
  app.use('/api/auth-profiles', authProfileRoutes);
  server = app.listen(0);

  const { AuthProfile } = await import('@agent-platform/database/models');
  await (AuthProfile as { findOne(filter: Record<string, unknown>): Promise<unknown> }).findOne({
    tenantId: 'warmup',
  });
}, 30_000);

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  server?.close();
  await teardownTestMongo();
});

describe('POST /api/auth-profiles validation', () => {
  it('rejects custom_header payloads when config and secret keys drift', async () => {
    const response = await request(server)
      .post('/api/auth-profiles')
      .send({
        name: 'Mismatched custom header profile',
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        authType: 'custom_header',
        config: {
          headers: {
            Authorization: 'auth-header',
          },
        },
        secrets: {
          headerValues: {
            'X-Api-Key': 'secret-value',
          },
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('headerValues');
  });

  it('accepts valid custom_header payloads with matching keys', async () => {
    const response = await request(server)
      .post('/api/auth-profiles')
      .send({
        name: 'Matching custom header profile',
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        authType: 'custom_header',
        config: {
          headers: {
            Authorization: 'auth-header',
          },
        },
        secrets: {
          headerValues: {
            Authorization: 'secret-value',
          },
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.authType).toBe('custom_header');
  });

  it('rejects manual oauth2_token creation through the runtime auth profile route', async () => {
    const response = await request(server)
      .post('/api/auth-profiles')
      .send({
        name: 'Manual token profile',
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        authType: 'oauth2_token',
        linkedAppProfileId: 'app-profile-1',
        config: {
          provider: 'google',
        },
        secrets: {
          accessToken: 'ya29.token',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.message).toContain('system-managed');
  });

  it('rejects kerberos profile creation when ENABLE_KERBEROS is disabled', async () => {
    const previous = process.env.ENABLE_KERBEROS;
    process.env.ENABLE_KERBEROS = 'false';
    try {
      const response = await request(server)
        .post('/api/auth-profiles')
        .send({
          name: 'Kerberos profile (disabled build)',
          projectId: null,
          scope: 'tenant',
          visibility: 'shared',
          authType: 'kerberos',
          config: {
            realm: 'EXAMPLE.COM',
            kdc: 'kdc.example.com',
            servicePrincipal: 'HTTP/service.example.com',
          },
          secrets: {
            principal: 'svc-user@EXAMPLE.COM',
            password: 'secret',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('AUTH_KERBEROS_NOT_BUILT');
      expect(response.body.error.message).toContain('not enabled');
    } finally {
      if (previous === undefined) {
        delete process.env.ENABLE_KERBEROS;
      } else {
        process.env.ENABLE_KERBEROS = previous;
      }
    }
  });

  it('rejects incompatible usageMode/authType combinations', async () => {
    const response = await request(server)
      .post('/api/auth-profiles')
      .send({
        name: 'Invalid API key preflight profile',
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        authType: 'api_key',
        usageMode: 'preflight',
        config: {
          headerName: 'X-Api-Key',
        },
        secrets: {
          apiKey: 'sk-test',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.message).toContain('usageMode');
  });

  it('normalizes oauth2_app legacy scopes to defaultScopes before persisting', async () => {
    const response = await request(server)
      .post('/api/auth-profiles')
      .send({
        name: 'Legacy scopes OAuth app',
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        authType: 'oauth2_app',
        config: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          scopes: ['openid', 'email'],
        },
        secrets: {
          clientId: 'cid',
          clientSecret: 'secret',
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);

    const { AuthProfile } = await import('@agent-platform/database/models');
    const stored = await (
      AuthProfile as {
        findOne(
          filter: Record<string, unknown>,
        ): Promise<{ config: Record<string, unknown> } | null>;
      }
    ).findOne({
      tenantId: TEST_TENANT,
      name: 'Legacy scopes OAuth app',
    });

    expect(stored?.config.defaultScopes).toEqual(['openid', 'email']);
    expect(stored?.config.scopes).toBeUndefined();
  });

  it('persists oauth2_app usageMode for supported preflight flows', async () => {
    const response = await request(server)
      .post('/api/auth-profiles')
      .send({
        name: 'Preflight OAuth app',
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        authType: 'oauth2_app',
        usageMode: 'preflight',
        config: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
        secrets: {
          clientId: 'cid',
          clientSecret: 'secret',
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.usageMode).toBe('preflight');
  });
});

describe('GET /api/auth-profiles/:id', () => {
  it('includes migration metadata for legacy oauth2_token profiles', async () => {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const profile = await (
      AuthProfile as {
        create(doc: Record<string, unknown>): Promise<{ _id: string }>;
      }
    ).create({
      name: 'Legacy runtime token profile',
      tenantId: TEST_TENANT,
      projectId: null,
      scope: 'tenant',
      visibility: 'shared',
      createdBy: TEST_USER,
      authType: 'oauth2_token',
      config: {
        provider: 'google',
        tokenType: 'bearer',
      },
      encryptedSecrets: JSON.stringify({
        accessToken: 'ya29.legacy-token',
      }),
      linkedAppProfileId: 'oauth-app-1',
      status: 'active',
    });

    const response = await request(server).get(`/api/auth-profiles/${profile._id}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.migration).toEqual({
      status: 'legacy_read_only',
      message: expect.stringContaining('migration records'),
      replacementAuthProfileId: 'oauth-app-1',
      replacementAuthType: 'oauth2_app',
    });
  });
});

describe('DELETE /api/auth-profiles/:id', () => {
  it('rejects deleting legacy oauth2_token migration records before delete infrastructure checks', async () => {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const profile = await (
      AuthProfile as {
        create(doc: Record<string, unknown>): Promise<{ _id: string }>;
        findOne(filter: Record<string, unknown>): Promise<{ status: string } | null>;
      }
    ).create({
      name: 'Legacy runtime token profile delete',
      tenantId: TEST_TENANT,
      projectId: null,
      scope: 'tenant',
      visibility: 'shared',
      createdBy: TEST_USER,
      authType: 'oauth2_token',
      config: {
        provider: 'google',
        tokenType: 'bearer',
      },
      encryptedSecrets: JSON.stringify({
        accessToken: 'ya29.legacy-token-delete',
      }),
      linkedAppProfileId: 'oauth-app-delete-1',
      status: 'active',
    });

    const response = await request(server).delete(`/api/auth-profiles/${profile._id}`);

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('migration records');

    const stored = await (
      AuthProfile as {
        findOne(filter: Record<string, unknown>): Promise<{ status: string } | null>;
      }
    ).findOne({
      _id: profile._id,
      tenantId: TEST_TENANT,
    });

    expect(stored?.status).toBe('active');
  });
});
