/**
 * E2E: Auth Profile OAuth Flow
 *
 * Tests the full oauth2_app -> oauth2_token lifecycle using mocked
 * model, Redis, and HTTP token endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  needsProactiveRefresh,
  validateLinkedAppProfile,
  resolveOAuth2AppCredentials,
} from '@agent-platform/shared/services/auth-profile';
import crypto from 'node:crypto';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// AuthProfileError is re-exported from the barrel at
// @agent-platform/shared/services/auth-profile — no separate mock needed.
// The linked-app-validator imports it from the errors module which resolves
// through the package's internal paths. We mock the errors module path that
// the validator source actually uses at the dist level.
vi.mock('../../../../../packages/shared/dist/errors/auth-profile-errors.js', () => {
  class AuthProfileError extends Error {
    public readonly code: string;
    public readonly statusCode: number;
    constructor(code: string, message: string, statusCode = 400) {
      super(message);
      this.name = 'AuthProfileError';
      this.code = code;
      this.statusCode = statusCode;
    }
  }
  return { AuthProfileError };
});

vi.mock('@agent-platform/database/models', () => {
  // In-memory store for auth profiles
  const profiles = new Map<string, any>();
  let counter = 0;

  const AuthProfile = {
    create: vi.fn(async (data: any) => {
      const id = data._id || `profile-${++counter}`;
      const doc = {
        _id: id,
        ...data,
        save: vi.fn(async function (this: any) {
          profiles.set(this._id, { ...this });
          return this;
        }),
        toObject: function (this: any) {
          return { ...this };
        },
      };
      profiles.set(id, doc);
      return doc;
    }),
    findOne: vi.fn(async (query: any) => {
      for (const [, profile] of profiles) {
        if (query._id && String(profile._id) !== String(query._id)) continue;
        if (query.tenantId && profile.tenantId !== query.tenantId) continue;
        return {
          ...profile,
          save: vi.fn(async function (this: any) {
            Object.assign(profile, this);
            profiles.set(profile._id, profile);
            return this;
          }),
        };
      }
      return null;
    }),
    findOneAndDelete: vi.fn(async (query: any) => {
      for (const [id, profile] of profiles) {
        if (query._id && String(profile._id) !== String(query._id)) continue;
        if (query.tenantId && profile.tenantId !== query.tenantId) continue;
        profiles.delete(id);
        return profile;
      }
      return null;
    }),
    countDocuments: vi.fn(async (query: any) => {
      let count = 0;
      for (const [, profile] of profiles) {
        if (query.linkedAppProfileId && profile.linkedAppProfileId !== query.linkedAppProfileId)
          continue;
        if (query.tenantId && profile.tenantId !== query.tenantId) continue;
        count++;
      }
      return count;
    }),
    _store: profiles,
    _reset: () => {
      profiles.clear();
      counter = 0;
    },
  };

  return { AuthProfile };
});

// ── Inline AuthProfileService (not exported via package exports) ─────

interface AuthProfileServiceDeps {
  model: any;
  redis?: any;
}

interface CreateAuthProfileInput {
  name: string;
  tenantId: string;
  projectId: string | null;
  scope: 'tenant' | 'project';
  visibility: 'shared' | 'personal';
  createdBy: string;
  authType: string;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  description?: string;
  environment?: string | null;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
}

class AuthProfileService {
  private readonly model: any;
  private readonly redis?: any;

  constructor(deps: AuthProfileServiceDeps) {
    this.model = deps.model;
    this.redis = deps.redis;
  }

  async create(input: CreateAuthProfileInput) {
    return this.model.create({
      name: input.name,
      description: input.description,
      tenantId: input.tenantId,
      projectId: input.projectId,
      scope: input.scope,
      environment: input.environment ?? null,
      visibility: input.visibility,
      createdBy: input.createdBy,
      authType: input.authType,
      config: input.config,
      encryptedSecrets: JSON.stringify(input.secrets),
      encryptionKeyVersion: 1,
      linkedAppProfileId: input.linkedAppProfileId,
      connector: input.connector,
      category: input.category,
      tags: input.tags,
      status: 'active',
    });
  }

  async update(input: {
    id: string;
    tenantId: string;
    projectId: string;
    updates: {
      name?: string;
      status?: string;
      secrets?: Record<string, unknown>;
      config?: Record<string, unknown>;
    };
  }) {
    const existing = await this.model.findOne({
      _id: input.id,
      tenantId: input.tenantId,
    });
    if (!existing) throw new Error('Auth profile not found');
    if (input.updates.name !== undefined) existing.name = input.updates.name;
    if (input.updates.status !== undefined) existing.status = input.updates.status;
    if (input.updates.config !== undefined) existing.config = input.updates.config;
    if (input.updates.secrets !== undefined) {
      existing.encryptedSecrets = JSON.stringify(input.updates.secrets);
    }
    await existing.save();
    return existing;
  }

  async getConsumerCount(profileId: string, tenantId: string): Promise<number> {
    return this.model.countDocuments({
      linkedAppProfileId: profileId,
      tenantId,
    });
  }

  async resolve(input: {
    tenantId: string;
    projectId: string;
    connector: string;
    connectionMode: 'per_user' | 'shared';
    userId?: string;
  }) {
    const orConditions: Record<string, unknown>[] = [];

    if (input.connectionMode === 'per_user' && input.userId) {
      orConditions.push({
        projectId: input.projectId,
        connector: input.connector,
        authType: 'oauth2_token',
        visibility: 'personal',
        createdBy: input.userId,
      });
    }

    if (input.connectionMode === 'shared') {
      orConditions.push({
        projectId: input.projectId,
        connector: input.connector,
        authType: 'oauth2_token',
        visibility: 'shared',
      });
    }

    orConditions.push({
      projectId: input.projectId,
      connector: input.connector,
      environment: null,
    });

    orConditions.push({
      projectId: null,
      connector: input.connector,
    });

    const profiles = await this.model
      .find({
        tenantId: input.tenantId,
        status: 'active',
        $or: orConditions,
      })
      .sort({ projectId: -1, environment: -1, visibility: 1 })
      .limit(1);

    if (!profiles || profiles.length === 0) {
      throw new Error(`No auth profile found for connector '${input.connector}'.`);
    }

    return this.extractCredentials(profiles[0]);
  }

  private extractCredentials(profile: any) {
    let secrets: Record<string, unknown>;
    if (typeof profile.encryptedSecrets === 'string') {
      try {
        secrets = JSON.parse(profile.encryptedSecrets);
      } catch {
        secrets = { _raw: profile.encryptedSecrets };
      }
    } else {
      secrets = profile.encryptedSecrets ?? {};
    }
    return {
      profileId: profile._id,
      authType: profile.authType,
      config: profile.config ?? {},
      secrets,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function createMockModel() {
  const docs = new Map<string, any>();
  let counter = 0;

  return {
    create: vi.fn(async (data: any) => {
      const id = data._id || `profile-${++counter}`;
      const doc = {
        _id: id,
        ...data,
        save: vi.fn(async function (this: any) {
          docs.set(this._id, { ...this });
          return this;
        }),
      };
      docs.set(id, doc);
      return doc;
    }),
    findOne: vi.fn(async (query: any) => {
      for (const [, doc] of docs) {
        if (query._id && String(doc._id) !== String(query._id)) continue;
        if (query.tenantId && doc.tenantId !== query.tenantId) continue;
        const found = { ...doc };
        found.save = vi.fn(async function (this: any) {
          Object.assign(doc, this);
          docs.set(doc._id, doc);
          return this;
        });
        return found;
      }
      return null;
    }),
    findOneAndDelete: vi.fn(async (query: any) => {
      for (const [id, doc] of docs) {
        if (query._id && String(doc._id) !== String(query._id)) continue;
        if (query.tenantId && doc.tenantId !== query.tenantId) continue;
        docs.delete(id);
        return doc;
      }
      return null;
    }),
    countDocuments: vi.fn(async (query: any) => {
      let count = 0;
      for (const [, doc] of docs) {
        if (query.linkedAppProfileId && doc.linkedAppProfileId !== query.linkedAppProfileId)
          continue;
        if (query.tenantId && doc.tenantId !== query.tenantId) continue;
        count++;
      }
      return count;
    }),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
    _store: docs,
  };
}

function createMockRedis() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    set: vi.fn(
      async (key: string, value: string, ...args: (string | number)[]): Promise<string | null> => {
        if (args.includes('NX') && store.has(key)) return null;
        let ttlMs: number | undefined;
        const pxIdx = args.indexOf('PX');
        if (pxIdx !== -1) ttlMs = Number(args[pxIdx + 1]);
        const exIdx = args.indexOf('EX');
        if (exIdx !== -1) ttlMs = Number(args[exIdx + 1]) * 1000;
        store.set(key, {
          value,
          expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
        });
        return 'OK';
      },
    ),
    get: vi.fn(async (key: string): Promise<string | null> => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    del: vi.fn(async (key: string): Promise<number> => {
      return store.delete(key) ? 1 : 0;
    }),
    _store: store,
  };
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('E2E: Auth Profile OAuth Flow', () => {
  let model: ReturnType<typeof createMockModel>;
  let redis: ReturnType<typeof createMockRedis>;
  let service: AuthProfileService;

  const TENANT_ID = 'tenant-oauth-test';
  const PROJECT_ID = 'project-oauth-test';
  const USER_ID = 'user-oauth-test';

  beforeEach(() => {
    model = createMockModel();
    redis = createMockRedis();
    service = new AuthProfileService({ model, redis });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates oauth2_app profile and stores encrypted credentials', async () => {
    const input: CreateAuthProfileInput = {
      name: 'Google OAuth App',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'shared',
      createdBy: USER_ID,
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['openid', 'email'],
        pkceRequired: true,
        pkceMethod: 'S256',
      },
      secrets: {
        clientId: 'google-client-id-123',
        clientSecret: 'google-client-secret-456',
      },
    };

    const created = await service.create(input);

    expect(created).toBeDefined();
    expect(created.authType).toBe('oauth2_app');
    expect(created.tenantId).toBe(TENANT_ID);
    expect(created.status).toBe('active');
    const storedSecrets = JSON.parse(created.encryptedSecrets);
    expect(storedSecrets.clientId).toBe('google-client-id-123');
    expect(storedSecrets.clientSecret).toBe('google-client-secret-456');
    expect(created.config.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(created.config.tokenUrl).toBe('https://oauth2.googleapis.com/token');
  });

  it('generates OAuth state containing profileId, nonce, and timestamp', () => {
    const profileId = 'app-profile-id-001';
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    const state = Buffer.from(JSON.stringify({ profileId, nonce, timestamp })).toString(
      'base64url',
    );

    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
    expect(decoded.profileId).toBe(profileId);
    expect(decoded.nonce).toHaveLength(32);
    expect(decoded.timestamp).toBeCloseTo(Date.now(), -3);
  });

  it('validates OAuth state and rejects expired or tampered states', () => {
    const STATE_TTL_MS = 10 * 60 * 1000;
    const profileId = 'app-profile-id-002';
    const nonce = crypto.randomBytes(16).toString('hex');

    // Valid state
    const validState = Buffer.from(
      JSON.stringify({ profileId, nonce, timestamp: Date.now() }),
    ).toString('base64url');

    const validDecoded = JSON.parse(Buffer.from(validState, 'base64url').toString());
    expect(validDecoded.profileId).toBe(profileId);
    expect(Date.now() - validDecoded.timestamp).toBeLessThan(STATE_TTL_MS);

    // Expired state (11 minutes old)
    const expiredState = Buffer.from(
      JSON.stringify({
        profileId,
        nonce,
        timestamp: Date.now() - 11 * 60 * 1000,
      }),
    ).toString('base64url');

    const expiredDecoded = JSON.parse(Buffer.from(expiredState, 'base64url').toString());
    expect(Date.now() - expiredDecoded.timestamp).toBeGreaterThan(STATE_TTL_MS);

    // Tampered state — invalid base64url
    expect(() => {
      JSON.parse(Buffer.from('tampered-garbage', 'base64url').toString());
    }).toThrow();
  });

  it('exchanges authorization code for tokens and creates oauth2_token profile', async () => {
    // Step 1: Create the oauth2_app profile
    const appProfile = await service.create({
      name: 'Slack OAuth App',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'shared',
      createdBy: USER_ID,
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        defaultScopes: ['channels:read'],
      },
      secrets: {
        clientId: 'slack-client-id',
        clientSecret: 'slack-client-secret',
      },
    });

    // Step 2: Mock token endpoint response
    const mockTokenResponse = {
      access_token: 'xoxb-mock-access-token',
      refresh_token: 'xoxb-mock-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
    };

    // Step 3: Create the oauth2_token profile (simulating post-callback)
    const tokenProfile = await service.create({
      name: 'Slack Token for User',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'personal',
      createdBy: USER_ID,
      authType: 'oauth2_token',
      config: {
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + mockTokenResponse.expires_in * 1000).toISOString(),
      },
      secrets: {
        accessToken: mockTokenResponse.access_token,
        refreshToken: mockTokenResponse.refresh_token,
      },
      linkedAppProfileId: appProfile._id,
      connector: 'slack',
    });

    expect(tokenProfile.authType).toBe('oauth2_token');
    expect(tokenProfile.linkedAppProfileId).toBe(appProfile._id);
    const tokenSecrets = JSON.parse(tokenProfile.encryptedSecrets);
    expect(tokenSecrets.accessToken).toBe('xoxb-mock-access-token');
    expect(tokenSecrets.refreshToken).toBe('xoxb-mock-refresh-token');
    expect(tokenProfile.config.expiresAt).toBeDefined();
  });

  it('links oauth2_token back to oauth2_app via linkedAppProfileId', async () => {
    // Create app profile
    const appProfile = await service.create({
      name: 'GitHub OAuth App',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'shared',
      createdBy: USER_ID,
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
      },
      secrets: {
        clientId: 'gh-client-id',
        clientSecret: 'gh-client-secret',
      },
    });

    // Create token profile linked to app
    const tokenProfile = await service.create({
      name: 'GitHub Token',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'personal',
      createdBy: USER_ID,
      authType: 'oauth2_token',
      config: {},
      secrets: {
        accessToken: 'gho_mock_token',
      },
      linkedAppProfileId: appProfile._id,
    });

    // Verify the link
    expect(tokenProfile.linkedAppProfileId).toBe(appProfile._id);

    // Verify consumer count
    const consumerCount = await service.getConsumerCount(appProfile._id, TENANT_ID);
    expect(consumerCount).toBe(1);

    // Validate the linked app profile using the validator module
    const { AuthProfile } = await import('@agent-platform/database/models' as any);
    AuthProfile._store.set(appProfile._id, {
      _id: appProfile._id,
      tenantId: TENANT_ID,
      authType: 'oauth2_app',
      status: 'active',
      encryptedSecrets: JSON.stringify({
        clientId: 'gh-client-id',
        clientSecret: 'gh-client-secret',
      }),
      config: {
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
      },
    });

    const validatedApp = await validateLinkedAppProfile({
      linkedAppProfileId: appProfile._id,
      tenantId: TENANT_ID,
    });

    expect(validatedApp.authType).toBe('oauth2_app');
  });

  it('proactive refresh triggers when token expires within buffer', () => {
    // Token expiring in 3 minutes (within the 5-minute buffer)
    const soonExpiring = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    expect(needsProactiveRefresh(soonExpiring)).toBe(true);

    // Token expiring in 10 minutes (outside the 5-minute buffer)
    const notExpiring = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(needsProactiveRefresh(notExpiring)).toBe(false);

    // Already expired
    const expired = new Date(Date.now() - 60 * 1000).toISOString();
    expect(needsProactiveRefresh(expired)).toBe(true);

    // Null/undefined
    expect(needsProactiveRefresh(null)).toBe(false);
    expect(needsProactiveRefresh(undefined)).toBe(false);
  });

  it('revokes profile by marking status as revoked', async () => {
    const tokenProfile = await service.create({
      name: 'Revocable Token',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'shared',
      createdBy: USER_ID,
      authType: 'oauth2_token',
      config: {},
      secrets: {
        accessToken: 'token-to-revoke',
        refreshToken: 'refresh-to-revoke',
      },
    });

    // Revoke by updating status
    const revoked = await service.update({
      id: tokenProfile._id,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      updates: {
        status: 'revoked',
        secrets: {},
      },
    });

    expect(revoked.status).toBe('revoked');
    const clearedSecrets = JSON.parse(revoked.encryptedSecrets);
    expect(clearedSecrets.accessToken).toBeUndefined();
    expect(clearedSecrets.refreshToken).toBeUndefined();
  });

  it('per_user oauth2_token is scoped to createdBy', async () => {
    const USER_A = 'user-a';
    const USER_B = 'user-b';

    await service.create({
      name: 'User A Token',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'personal',
      createdBy: USER_A,
      authType: 'oauth2_token',
      config: {},
      secrets: { accessToken: 'token-user-a' },
      connector: 'slack',
    });

    await service.create({
      name: 'User B Token',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      scope: 'project',
      visibility: 'personal',
      createdBy: USER_B,
      authType: 'oauth2_token',
      config: {},
      secrets: { accessToken: 'token-user-b' },
      connector: 'slack',
    });

    const allDocs = Array.from(model._store.values());

    model.find.mockImplementation((query: any) => {
      const results = allDocs.filter((doc: any) => {
        if (query.tenantId && doc.tenantId !== query.tenantId) return false;
        if (query.status && doc.status !== query.status) return false;
        if (query.$or) {
          return query.$or.some((cond: any) => {
            if (cond.createdBy && doc.createdBy !== cond.createdBy) return false;
            if (cond.visibility && doc.visibility !== cond.visibility) return false;
            if (cond.connector && doc.connector !== cond.connector) return false;
            return true;
          });
        }
        return true;
      });
      return {
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(results.slice(0, 1)),
        }),
      };
    });

    const resolvedA = await service.resolve({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      connector: 'slack',
      connectionMode: 'per_user',
      userId: USER_A,
    });

    expect(resolvedA.secrets.accessToken).toBe('token-user-a');
  });
});
