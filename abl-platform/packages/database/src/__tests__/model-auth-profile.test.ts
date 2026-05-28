import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from './helpers/setup-mongo.js';
import { AuthProfile } from '../models/auth-profile.model.js';
import { makeAuthProfile, AUTH_TYPE_FIXTURES } from './helpers/auth-profile-factory.js';

beforeAll(async () => {
  await setupTestMongo();
  await initTestDEKFacade('ab'.repeat(32));
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Schema Defaults ───────────────────────────────────────────────────────

describe('AuthProfile schema defaults', () => {
  it('generates _id on instantiation', () => {
    const profile = new AuthProfile(makeAuthProfile());
    expect(profile._id).toBeDefined();
  });

  it('defaults status to active', () => {
    const profile = new AuthProfile(makeAuthProfile({ status: undefined as any }));
    expect(profile.status).toBe('active');
  });

  it('defaults environment to null', () => {
    const profile = new AuthProfile(makeAuthProfile({ environment: undefined as any }));
    expect(profile.environment).toBeNull();
  });

  it('sets createdAt/updatedAt on save', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const profile = await AuthProfile.create(makeAuthProfile());
    expect(profile.createdAt).toBeInstanceOf(Date);
    expect(profile.updatedAt).toBeInstanceOf(Date);
  });
});

// ─── Required Fields ────────────────────────────────────────────────────────

describe('AuthProfile required fields', () => {
  // scope and visibility have defaults so deleting them doesn't trigger validation error
  for (const field of ['tenantId', 'name', 'createdBy', 'authType', 'encryptedSecrets']) {
    it(`requires ${field}`, () => {
      const data = makeAuthProfile();
      delete (data as any)[field];
      const doc = new AuthProfile(data);
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors[field]).toBeDefined();
    });
  }
});

// ─── Auth Type Enum ─────────────────────────────────────────────────────────

describe('AuthProfile authType enum', () => {
  const VALID_TYPES = [
    'none',
    'api_key',
    'bearer',
    'oauth2_app',
    'oauth2_token',
    'oauth2_client_credentials',
  ];

  for (const authType of VALID_TYPES) {
    it(`accepts authType: ${authType}`, () => {
      const doc = new AuthProfile(makeAuthProfile({ authType }));
      const err = doc.validateSync();
      expect(err?.errors?.authType).toBeUndefined();
    });
  }

  it('rejects invalid authType', () => {
    const doc = new AuthProfile(makeAuthProfile({ authType: 'invalid_type' }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.authType).toBeDefined();
  });
});

// ─── Status Enum ────────────────────────────────────────────────────────────

describe('AuthProfile status enum', () => {
  for (const status of ['active', 'expired', 'revoked', 'invalid'] as const) {
    it(`accepts status: ${status}`, () => {
      const doc = new AuthProfile(makeAuthProfile({ status }));
      const err = doc.validateSync();
      expect(err?.errors?.status).toBeUndefined();
    });
  }

  it('rejects invalid status', () => {
    const doc = new AuthProfile(makeAuthProfile({ status: 'unknown' as any }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });
});

// ─── Scope + Visibility Enums ───────────────────────────────────────────────

describe('AuthProfile scope/visibility enums', () => {
  it('accepts scope: tenant', () => {
    const doc = new AuthProfile(makeAuthProfile({ scope: 'tenant', projectId: null }));
    expect(doc.validateSync()?.errors?.scope).toBeUndefined();
  });

  it('accepts scope: project', () => {
    const doc = new AuthProfile(makeAuthProfile({ scope: 'project' }));
    expect(doc.validateSync()?.errors?.scope).toBeUndefined();
  });

  it('rejects invalid scope', () => {
    const doc = new AuthProfile(makeAuthProfile({ scope: 'global' as any }));
    const err = doc.validateSync();
    expect(err?.errors?.scope).toBeDefined();
  });

  it('accepts visibility: shared', () => {
    const doc = new AuthProfile(makeAuthProfile({ visibility: 'shared' }));
    expect(doc.validateSync()?.errors?.visibility).toBeUndefined();
  });

  it('accepts visibility: personal', () => {
    const doc = new AuthProfile(makeAuthProfile({ visibility: 'personal' }));
    expect(doc.validateSync()?.errors?.visibility).toBeUndefined();
  });
});

// ─── Per Auth Type Config Fixtures ──────────────────────────────────────────

describe('AuthProfile per-type fixture validation', () => {
  for (const authType of Object.keys(AUTH_TYPE_FIXTURES)) {
    it(`creates and saves ${authType} profile without error`, async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      const profile = await AuthProfile.create(
        makeAuthProfile({ authType, name: `Test-${authType}-${Date.now()}` }),
      );
      expect(profile._id).toBeDefined();
      expect(profile.authType).toBe(authType);
    });
  }
});

// ─── Indexes ────────────────────────────────────────────────────────────────

describe('AuthProfile indexes', () => {
  it('has required indexes', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const indexes = await AuthProfile.collection.indexes();
    const indexKeys = indexes.map((i: any) => Object.keys(i.key).join(','));
    expect(indexKeys).toContainEqual(expect.stringContaining('tenantId'));
    const uniqueIndexes = indexes.filter((i: any) => i.unique);
    expect(uniqueIndexes.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces unique name per tenant+environment at tenant-level', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const base = makeAuthProfile({
      scope: 'tenant',
      projectId: null,
      name: 'unique-test',
      environment: null,
    });
    await AuthProfile.create(base);
    await expect(AuthProfile.create({ ...base, _id: undefined })).rejects.toThrow(/duplicate key/i);
  });

  it('enforces unique name per tenant+project+environment at project-level', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const base = makeAuthProfile({
      scope: 'project',
      projectId: 'proj-dup-test',
      name: 'unique-proj-test',
      environment: 'production',
    });
    await AuthProfile.create(base);
    await expect(AuthProfile.create({ ...base, _id: undefined })).rejects.toThrow(/duplicate key/i);
  });

  it('allows same name in different environments', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const base = makeAuthProfile({ name: 'same-name-env-test' });
    await AuthProfile.create({ ...base, environment: 'dev' });
    const prod = await AuthProfile.create({
      ...makeAuthProfile({ name: 'same-name-env-test' }),
      environment: 'production',
    });
    expect(prod._id).toBeDefined();
  });

  it('allows same name in different projects', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await AuthProfile.create(makeAuthProfile({ name: 'cross-proj', projectId: 'proj-A' }));
    const b = await AuthProfile.create(
      makeAuthProfile({ name: 'cross-proj', projectId: 'proj-B' }),
    );
    expect(b._id).toBeDefined();
  });

  it('allows same personal profile name for different owners in same project/environment', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await AuthProfile.create(
      makeAuthProfile({
        scope: 'project',
        projectId: 'proj-personal-1',
        visibility: 'personal',
        createdBy: 'user-A',
        name: 'my-personal-token',
      }),
    );

    const secondOwnerProfile = await AuthProfile.create(
      makeAuthProfile({
        scope: 'project',
        projectId: 'proj-personal-1',
        visibility: 'personal',
        createdBy: 'user-B',
        name: 'my-personal-token',
      }),
    );

    expect(secondOwnerProfile._id).toBeDefined();
  });

  it('enforces personal profile uniqueness per owner in same project/environment', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const base = makeAuthProfile({
      scope: 'project',
      projectId: 'proj-personal-dup',
      visibility: 'personal',
      createdBy: 'user-A',
      name: 'owner-scoped-token',
      environment: 'production',
    });

    await AuthProfile.create(base);
    await expect(AuthProfile.create({ ...base, _id: undefined })).rejects.toThrow(/duplicate key/i);
  });
});

// ─── Plugin Integration ─────────────────────────────────────────────────────

describe('AuthProfile plugin integration', () => {
  it('encrypts encryptedSecrets on save (encryption plugin)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const profile = await AuthProfile.create(
      makeAuthProfile({ encryptedSecrets: '{"apiKey":"plaintext-secret"}' }),
    );
    const raw = await AuthProfile.collection.findOne({ _id: profile._id });
    expect(raw!.encryptedSecrets).not.toBe('{"apiKey":"plaintext-secret"}');
  });

  it('decrypts encryptedSecrets on find (encryption plugin)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const original = '{"apiKey":"test-decrypt-value"}';
    await AuthProfile.create(makeAuthProfile({ encryptedSecrets: original }));
    const found = await AuthProfile.findOne({ tenantId: 'tenant-test-1' });
    expect(found!.encryptedSecrets).toBe(original);
  });

  it('tenant isolation plugin scopes queries to tenantId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await AuthProfile.create(makeAuthProfile({ tenantId: 'tenant-iso-A', name: 'iso-test' }));
    await AuthProfile.create(makeAuthProfile({ tenantId: 'tenant-iso-B', name: 'iso-test' }));
    const results = await AuthProfile.find({ tenantId: 'tenant-iso-A' });
    expect(results.every((r: any) => r.tenantId === 'tenant-iso-A')).toBe(true);
  });
});
