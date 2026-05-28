/**
 * Integration Test: Auth Profile Delegation (INT-1)
 *
 * Tests that ConnectionResolver.resolveAuth() correctly delegates credential
 * resolution to the auth profile system. All OAuth token management, refresh,
 * and distributed locking are handled by auth profiles — the connection layer
 * is a pure binding record.
 *
 * Uses MongoMemoryServer for real DB operations.
 * No mocks of codebase components.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConnectionResolver } from '../../auth/connection-resolver.js';
import type {
  ConnectorConnectionModel,
  AuthProfileResolverLike,
} from '../../auth/connection-resolver.js';
import type { IConnectorConnection } from '@agent-platform/database/models';

// ─── MongoDB Setup ──────────────────────────────────────────────────────────

let mongod: MongoMemoryServer | undefined;
let mongoAvailable = false;

const connectionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    connectorName: { type: String, required: true },
    displayName: { type: String, required: true },
    scope: { type: String, enum: ['tenant', 'user'], default: 'tenant' },
    userId: { type: String },
    authProfileId: { type: String, required: true },
    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'auth_profile_delegation_test', _id: false },
);

connectionSchema.index({ tenantId: 1, projectId: 1 });

let ConnModel: mongoose.Model<mongoose.Document>;

// ─── Mongoose Model Adapter for ConnectorConnectionModel ────────────────────

function createConnectionModelAdapter(
  model: mongoose.Model<mongoose.Document>,
): ConnectorConnectionModel {
  return {
    async findOne(filter: Record<string, unknown>): Promise<IConnectorConnection | null> {
      return model.findOne(filter).lean().exec() as Promise<IConnectorConnection | null>;
    },
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    await mongoose.connection.asPromise();
    ConnModel = mongoose.model('AuthProfileDelegationTest', connectionSchema);
    await mongoose.connection.syncIndexes();
    mongoAvailable = true;
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[INT] MongoMemoryServer unavailable -- tests will be skipped',
      err instanceof Error ? err.message : String(err),
    );
  }
}, 30_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
});

beforeEach(async () => {
  if (!mongoAvailable) return;
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function seedConnection(
  overrides: Partial<{
    connectorName: string;
    tenantId: string;
    projectId: string;
    authProfileId: string;
    scope: 'tenant' | 'user';
    userId: string;
  }> = {},
): Promise<IConnectorConnection> {
  const doc = await ConnModel.create({
    _id: crypto.randomUUID(),
    tenantId: overrides.tenantId ?? 'tenant-1',
    projectId: overrides.projectId ?? 'project-1',
    connectorName: overrides.connectorName ?? 'slack',
    displayName: 'Test Connection',
    scope: overrides.scope ?? 'tenant',
    userId: overrides.userId,
    authProfileId: overrides.authProfileId ?? 'ap-1',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return doc.toObject() as unknown as IConnectorConnection;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Integration: Auth Profile Delegation (INT-1)', () => {
  it('skips if MongoDB unavailable', ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');
  });

  it('resolveAuth passes authProfileId, tenantId, and projectId to resolver', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const connection = await seedConnection({
      authProfileId: 'ap-slack-oauth',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    let capturedOpts: Record<string, unknown> | undefined;
    const authProfileResolver: AuthProfileResolverLike = {
      async resolve(opts) {
        capturedOpts = opts;
        return { accessToken: 'resolved-token' };
      },
    };

    const connectionModel = createConnectionModelAdapter(ConnModel);
    const resolver = new ConnectionResolver(connectionModel, authProfileResolver);

    const result = await resolver.resolveAuth(connection);

    expect(result).toEqual({ accessToken: 'resolved-token' });
    expect(capturedOpts).toEqual({
      authProfileId: 'ap-slack-oauth',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
  });

  it('concurrent resolveAuth calls all delegate to auth profile resolver', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const connection = await seedConnection({ authProfileId: 'ap-concurrent' });

    let resolveCallCount = 0;
    const authProfileResolver: AuthProfileResolverLike = {
      async resolve() {
        resolveCallCount++;
        await new Promise((r) => setTimeout(r, 10));
        return { accessToken: `token-${resolveCallCount}` };
      },
    };

    const connectionModel = createConnectionModelAdapter(ConnModel);
    const resolver = new ConnectionResolver(connectionModel, authProfileResolver);

    const results = await Promise.all([
      resolver.resolveAuth(connection),
      resolver.resolveAuth(connection),
      resolver.resolveAuth(connection),
    ]);

    for (const result of results) {
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('accessToken');
    }

    expect(resolveCallCount).toBe(3);
  });

  it('resolveAuth propagates errors from auth profile resolver', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const connection = await seedConnection({ authProfileId: 'ap-broken' });

    const authProfileResolver: AuthProfileResolverLike = {
      async resolve() {
        throw new Error('Auth profile resolution failed: token expired');
      },
    };

    const connectionModel = createConnectionModelAdapter(ConnModel);
    const resolver = new ConnectionResolver(connectionModel, authProfileResolver);

    await expect(resolver.resolveAuth(connection)).rejects.toThrow(
      'Auth profile resolution failed: token expired',
    );
  });

  it('different connections resolve credentials from different auth profiles', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const conn1 = await seedConnection({
      connectorName: 'slack',
      authProfileId: 'ap-slack',
    });
    const conn2 = await seedConnection({
      connectorName: 'github',
      authProfileId: 'ap-github',
    });

    const authProfileResolver: AuthProfileResolverLike = {
      async resolve(opts) {
        if (opts.authProfileId === 'ap-slack') {
          return { botToken: 'xoxb-slack-token' };
        }
        if (opts.authProfileId === 'ap-github') {
          return { token: 'ghp-github-token' };
        }
        return {};
      },
    };

    const connectionModel = createConnectionModelAdapter(ConnModel);
    const resolver = new ConnectionResolver(connectionModel, authProfileResolver);

    const slackAuth = await resolver.resolveAuth(conn1);
    expect(slackAuth).toEqual({ botToken: 'xoxb-slack-token' });

    const githubAuth = await resolver.resolveAuth(conn2);
    expect(githubAuth).toEqual({ token: 'ghp-github-token' });
  });

  it('resolve + resolveAuth chain works end-to-end through real DB', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    await seedConnection({
      connectorName: 'slack',
      authProfileId: 'ap-team-slack',
      scope: 'tenant',
    });

    const authProfileResolver: AuthProfileResolverLike = {
      async resolve(opts) {
        expect(opts.authProfileId).toBe('ap-team-slack');
        return { apiKey: 'sk-live-key' };
      },
    };

    const connectionModel = createConnectionModelAdapter(ConnModel);
    const resolver = new ConnectionResolver(connectionModel, authProfileResolver);

    const resolved = await resolver.resolve({
      connectorName: 'slack',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(resolved.connection.authProfileId).toBe('ap-team-slack');
    expect(resolved.scope).toBe('tenant');

    const auth = await resolver.resolveAuth(resolved.connection);
    expect(auth).toEqual({ apiKey: 'sk-live-key' });
  });

  it('auth profile resolver receives tenant and project from connection record', async ({
    skip,
  }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const connection = await seedConnection({
      tenantId: 'tenant-abc',
      projectId: 'project-xyz',
      authProfileId: 'ap-scoped',
    });

    const capturedCalls: Array<Record<string, unknown>> = [];
    const authProfileResolver: AuthProfileResolverLike = {
      async resolve(opts) {
        capturedCalls.push(opts);
        return { token: 'scoped-token' };
      },
    };

    const connectionModel = createConnectionModelAdapter(ConnModel);
    const resolver = new ConnectionResolver(connectionModel, authProfileResolver);

    await resolver.resolveAuth(connection);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]).toEqual({
      authProfileId: 'ap-scoped',
      tenantId: 'tenant-abc',
      projectId: 'project-xyz',
    });
  });
});
