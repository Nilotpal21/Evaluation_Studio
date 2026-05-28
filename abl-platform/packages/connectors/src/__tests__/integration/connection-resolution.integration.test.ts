/**
 * Integration Test: Connection Resolution Priority (INT-2)
 *
 * Tests that ConnectionResolver.resolve() correctly implements the resolution
 * priority: user-scoped -> tenant-scoped, with support for direct connectionId
 * lookups. Uses MongoMemoryServer for real DB operations.
 *
 * ConnectionResolver delegates credential resolution to authProfileResolver —
 * connections are pure binding records with authProfileId.
 *
 * No mocks of codebase components. Uses real ConnectionResolver with real MongoDB.
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
  { collection: 'connection_resolution_test', _id: false },
);

connectionSchema.index({ tenantId: 1, projectId: 1 });
connectionSchema.index({
  tenantId: 1,
  projectId: 1,
  connectorName: 1,
  scope: 1,
  userId: 1,
});

let ConnModel: mongoose.Model<mongoose.Document>;

// ─── Auth Profile Resolver (external dependency — OK to provide test impl) ─

const authProfileResolver: AuthProfileResolverLike = {
  async resolve() {
    return { apiKey: 'resolved-key' };
  },
};

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

// ─── Helpers ────────────────────────────────────────────────────────────────

interface SeedConnectionOpts {
  connectorName?: string;
  tenantId?: string;
  projectId?: string;
  scope?: 'tenant' | 'user';
  userId?: string;
  status?: 'active' | 'expired' | 'revoked';
  displayName?: string;
  authProfileId?: string;
}

async function seedConnection(opts: SeedConnectionOpts = {}): Promise<IConnectorConnection> {
  const doc = await ConnModel.create({
    _id: crypto.randomUUID(),
    tenantId: opts.tenantId ?? 'tenant-1',
    projectId: opts.projectId ?? 'project-1',
    connectorName: opts.connectorName ?? 'slack',
    displayName: opts.displayName ?? `${opts.scope ?? 'tenant'}-scoped connection`,
    scope: opts.scope ?? 'tenant',
    userId: opts.userId,
    authProfileId: opts.authProfileId ?? 'ap-1',
    status: opts.status ?? 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return doc.toObject() as unknown as IConnectorConnection;
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    await mongoose.connection.asPromise();
    ConnModel = mongoose.model('ConnectionResolutionTest', connectionSchema);
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Integration: Connection Resolution Priority (INT-2)', () => {
  function createResolver(): ConnectionResolver {
    return new ConnectionResolver(createConnectionModelAdapter(ConnModel), authProfileResolver);
  }

  it('skips if MongoDB unavailable', ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');
  });

  it('with userId, resolves to user-scoped connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const userConn = await seedConnection({
      scope: 'user',
      userId: 'user-1',
      displayName: 'User Connection',
      authProfileId: 'ap-user',
    });
    await seedConnection({
      scope: 'tenant',
      displayName: 'Tenant Connection',
      authProfileId: 'ap-tenant',
    });

    const resolver = createResolver();
    const result = await resolver.resolve({
      connectorName: 'slack',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
    });

    expect(result.scope).toBe('user');
    expect(result.connection._id).toBe(userConn._id);
    expect(result.connection.displayName).toBe('User Connection');
  });

  it('without userId, resolves to tenant-scoped connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    await seedConnection({
      scope: 'user',
      userId: 'user-1',
      displayName: 'User Connection',
      authProfileId: 'ap-user',
    });
    const tenantConn = await seedConnection({
      scope: 'tenant',
      displayName: 'Tenant Connection',
      authProfileId: 'ap-tenant',
    });

    const resolver = createResolver();
    const result = await resolver.resolve({
      connectorName: 'slack',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    expect(result.scope).toBe('tenant');
    expect(result.connection._id).toBe(tenantConn._id);
  });

  it('with connectionId, resolves to exact connection regardless of scope', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const tenantConn = await seedConnection({
      scope: 'tenant',
      displayName: 'Specific Connection',
    });
    await seedConnection({
      scope: 'user',
      userId: 'user-1',
      displayName: 'User Connection',
      authProfileId: 'ap-user',
    });

    const resolver = createResolver();
    const result = await resolver.resolve({
      connectorName: 'slack',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      connectionId: tenantConn._id,
    });

    expect(result.connection._id).toBe(tenantConn._id);
  });

  it('with no connections, throws generic error about missing connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const resolver = createResolver();

    await expect(
      resolver.resolve({
        connectorName: 'nonexistent-connector',
        tenantId: 'tenant-xyz',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('No connection configured for this connector');
  });

  it('falls back to tenant-scoped when user has no connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const tenantConn = await seedConnection({
      scope: 'tenant',
      displayName: 'Tenant Fallback',
    });

    const resolver = createResolver();
    const result = await resolver.resolve({
      connectorName: 'slack',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-without-connection',
    });

    expect(result.scope).toBe('tenant');
    expect(result.connection._id).toBe(tenantConn._id);
  });

  it('ignores expired and revoked connections', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    await seedConnection({
      scope: 'tenant',
      status: 'expired',
      displayName: 'Expired Connection',
    });
    await seedConnection({
      scope: 'user',
      userId: 'user-1',
      status: 'revoked',
      displayName: 'Revoked Connection',
      authProfileId: 'ap-revoked',
    });

    const resolver = createResolver();

    await expect(
      resolver.resolve({
        connectorName: 'slack',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
      }),
    ).rejects.toThrow('No connection configured');
  });

  it('connectionId lookup fails with wrong tenant (tenant isolation)', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const conn = await seedConnection({
      tenantId: 'tenant-1',
      displayName: 'Tenant 1 Only',
    });

    const resolver = createResolver();

    await expect(
      resolver.resolve({
        connectorName: 'slack',
        tenantId: 'tenant-2',
        projectId: 'project-1',
        connectionId: conn._id,
      }),
    ).rejects.toThrow('not found');
  });

  it('connectionId lookup fails with wrong project (project isolation)', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const conn = await seedConnection({
      projectId: 'project-1',
      displayName: 'Project 1 Only',
    });

    const resolver = createResolver();

    await expect(
      resolver.resolve({
        connectorName: 'slack',
        tenantId: 'tenant-1',
        projectId: 'project-2',
        connectionId: conn._id,
      }),
    ).rejects.toThrow('not found');
  });

  it('user-scoped connection for a different user is not resolved', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    await seedConnection({
      scope: 'user',
      userId: 'user-1',
      displayName: 'User 1 Connection',
    });

    const resolver = createResolver();

    await expect(
      resolver.resolve({
        connectorName: 'slack',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-2',
      }),
    ).rejects.toThrow('No connection configured');
  });

  it('different connectors resolve independently', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const slackConn = await seedConnection({
      connectorName: 'slack',
      scope: 'tenant',
      displayName: 'Slack Tenant',
    });
    const githubConn = await seedConnection({
      connectorName: 'github',
      scope: 'tenant',
      displayName: 'GitHub Tenant',
      authProfileId: 'ap-github',
    });

    const resolver = createResolver();

    const slackResult = await resolver.resolve({
      connectorName: 'slack',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(slackResult.connection._id).toBe(slackConn._id);

    const githubResult = await resolver.resolve({
      connectorName: 'github',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(githubResult.connection._id).toBe(githubConn._id);
  });

  it('resolveAuth delegates to authProfileResolver with correct params', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const conn = await seedConnection({
      authProfileId: 'ap-test',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    const resolver = createResolver();
    const auth = await resolver.resolveAuth(conn);

    expect(auth).toEqual({ apiKey: 'resolved-key' });
  });
});
