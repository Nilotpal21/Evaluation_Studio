/**
 * Auth Profile Integration Tests
 *
 * Uses MongoMemoryServer for real database operations.
 * Tests encryption round-trip, CRUD, GDPR cascade, and tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from '../helpers/setup-mongo.js';
import { AuthProfile } from '../../models/auth-profile.model.js';
import { makeAuthProfile } from '../helpers/auth-profile-factory.js';

// ─── Setup / Teardown ────────────────────────────────────────────────────

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

// ─── Encryption Round-Trip (4 tests) ─────────────────────────────────────

describe('Encryption round-trip', () => {
  it('stores encryptedSecrets as ciphertext, not plaintext', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const secrets = '{"apiKey":"my-super-secret-key"}';
    const profile = await AuthProfile.create(makeAuthProfile({ encryptedSecrets: secrets }));

    const raw = await AuthProfile.collection.findOne({ _id: profile._id });
    expect(raw).not.toBeNull();
    expect(raw!.encryptedSecrets).not.toBe(secrets);
    // Ciphertext should be a non-empty string different from plaintext
    expect(typeof raw!.encryptedSecrets).toBe('string');
    expect((raw!.encryptedSecrets as string).length).toBeGreaterThan(0);
  });

  it('auto-decrypts encryptedSecrets on find', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const secrets = '{"token":"bearer-test-decrypt-12345"}';
    const profile = await AuthProfile.create(
      makeAuthProfile({ encryptedSecrets: secrets, name: 'decrypt-test' }),
    );

    const found = await AuthProfile.findOne({ _id: profile._id });
    expect(found).not.toBeNull();
    expect(found!.encryptedSecrets).toBe(secrets);
  });

  it('re-encrypts when secrets are updated', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const originalSecrets = '{"apiKey":"original-value"}';
    const updatedSecrets = '{"apiKey":"updated-value"}';

    const profile = await AuthProfile.create(
      makeAuthProfile({ encryptedSecrets: originalSecrets, name: 'update-enc-test' }),
    );
    const rawBefore = await AuthProfile.collection.findOne({ _id: profile._id });
    const cipherBefore = rawBefore!.encryptedSecrets;

    // Update via Mongoose (triggers save hooks)
    profile.encryptedSecrets = updatedSecrets;
    await profile.save();

    const rawAfter = await AuthProfile.collection.findOne({ _id: profile._id });
    expect(rawAfter!.encryptedSecrets).not.toBe(updatedSecrets);
    // Ciphertext should differ from both plaintext and original cipher
    expect(rawAfter!.encryptedSecrets).not.toBe(cipherBefore);

    // Mongoose find should return the updated plaintext
    const reloaded = await AuthProfile.findOne({ _id: profile._id });
    expect(reloaded!.encryptedSecrets).toBe(updatedSecrets);
  });

  it('.lean() still decrypts because post-find hooks fire on lean queries', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const secrets = '{"apiKey":"lean-gotcha-test"}';
    const profile = await AuthProfile.create(
      makeAuthProfile({ encryptedSecrets: secrets, name: 'lean-test' }),
    );

    const lean = await AuthProfile.findOne({ _id: profile._id }).lean();
    expect(lean).not.toBeNull();
    // .lean() bypasses getters, virtuals, and toJSON/toObject transforms,
    // but Mongoose post-find hooks still fire — so decryption happens.
    expect(lean!.encryptedSecrets).toBe(secrets);
  });
});

// ─── CRUD with Real DB (6 tests) ─────────────────────────────────────────

describe('CRUD with real DB', () => {
  it('persists a profile with all correct fields', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const data = makeAuthProfile({
      name: 'My API Key',
      authType: 'api_key',
      tenantId: 'tenant-crud-1',
      projectId: 'proj-crud-1',
      scope: 'project',
      visibility: 'shared',
      connector: 'salesforce',
      category: 'crm',
      tags: ['prod', 'sales'],
    });
    const profile = await AuthProfile.create(data);

    expect(profile._id).toBeDefined();
    expect(profile.name).toBe('My API Key');
    expect(profile.authType).toBe('api_key');
    expect(profile.tenantId).toBe('tenant-crud-1');
    expect(profile.projectId).toBe('proj-crud-1');
    expect(profile.scope).toBe('project');
    expect(profile.visibility).toBe('shared');
    expect(profile.status).toBe('active');
    expect(profile.connector).toBe('salesforce');
    expect(profile.category).toBe('crm');
    expect(profile.tags).toEqual(['prod', 'sales']);
    expect(profile.createdAt).toBeInstanceOf(Date);
    expect(profile.updatedAt).toBeInstanceOf(Date);
  });

  it('enforces unique name constraint within same tenant+project+environment', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const base = makeAuthProfile({
      name: 'dup-name-test',
      tenantId: 'tenant-dup',
      projectId: 'proj-dup',
      environment: 'production',
    });
    await AuthProfile.create(base);

    await expect(AuthProfile.create(makeAuthProfile({ ...base, _id: undefined }))).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows personal duplicate names across different owners in same project', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const base = {
      name: 'personal-namespace',
      tenantId: 'tenant-personal-dup',
      projectId: 'proj-personal-dup',
      environment: 'production',
      visibility: 'personal' as const,
      scope: 'project' as const,
    };

    const userA = await AuthProfile.create(
      makeAuthProfile({
        ...base,
        createdBy: 'user-a',
      }),
    );

    const userB = await AuthProfile.create(
      makeAuthProfile({
        ...base,
        createdBy: 'user-b',
      }),
    );

    expect(userA._id).toBeDefined();
    expect(userB._id).toBeDefined();
  });

  it('partial update preserves other fields', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(
      makeAuthProfile({
        name: 'partial-update',
        tenantId: 'tenant-partial',
        connector: 'original-connector',
        category: 'original-category',
      }),
    );

    await AuthProfile.updateOne({ _id: profile._id }, { $set: { connector: 'new-connector' } });

    const updated = await AuthProfile.findOne({ _id: profile._id });
    expect(updated!.connector).toBe('new-connector');
    expect(updated!.category).toBe('original-category');
    expect(updated!.name).toBe('partial-update');
  });

  it('delete removes the profile', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(
      makeAuthProfile({ name: 'delete-me', tenantId: 'tenant-del' }),
    );
    expect(profile._id).toBeDefined();

    const result = await AuthProfile.deleteOne({ _id: profile._id });
    expect(result.deletedCount).toBe(1);

    const gone = await AuthProfile.findOne({ _id: profile._id });
    expect(gone).toBeNull();
  });

  it('linkedAppProfileId references are queryable', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const appProfile = await AuthProfile.create(
      makeAuthProfile({
        name: 'OAuth App',
        authType: 'oauth2_app',
        tenantId: 'tenant-link',
      }),
    );

    const tokenProfile = await AuthProfile.create(
      makeAuthProfile({
        name: 'OAuth Token',
        authType: 'oauth2_token',
        tenantId: 'tenant-link',
        linkedAppProfileId: appProfile._id,
      }),
    );

    const linked = await AuthProfile.find({ linkedAppProfileId: appProfile._id });
    expect(linked).toHaveLength(1);
    expect(linked[0]._id).toBe(tokenProfile._id);
  });

  it('query by tenantId + authType returns correct results', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await AuthProfile.create(
      makeAuthProfile({
        name: 'api-key-1',
        tenantId: 'tenant-query',
        authType: 'api_key',
      }),
    );
    await AuthProfile.create(
      makeAuthProfile({
        name: 'bearer-1',
        tenantId: 'tenant-query',
        authType: 'bearer',
      }),
    );
    await AuthProfile.create(
      makeAuthProfile({
        name: 'api-key-other',
        tenantId: 'tenant-other',
        authType: 'api_key',
      }),
    );

    const results = await AuthProfile.find({
      tenantId: 'tenant-query',
      authType: 'api_key',
    });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('api-key-1');
  });
});

// ─── GDPR Cascade (4 tests) ──────────────────────────────────────────────

describe('GDPR cascade', () => {
  it('deleteTenant removes all tenant profiles', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const tenantId = 'tenant-cascade-del';
    await AuthProfile.create(makeAuthProfile({ name: 'profile-1', tenantId, projectId: 'proj-a' }));
    await AuthProfile.create(makeAuthProfile({ name: 'profile-2', tenantId, projectId: 'proj-b' }));
    await AuthProfile.create(
      makeAuthProfile({
        name: 'profile-3',
        tenantId,
        scope: 'tenant',
        projectId: null,
      }),
    );

    // Simulate cascade: delete all profiles for the tenant
    const result = await AuthProfile.deleteMany({ tenantId });
    expect(result.deletedCount).toBe(3);

    const remaining = await AuthProfile.find({ tenantId });
    expect(remaining).toHaveLength(0);
  });

  it('deleteProject removes project-scoped profiles, preserves tenant-scoped', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const tenantId = 'tenant-proj-cascade';
    const projectId = 'proj-cascade-target';

    await AuthProfile.create(makeAuthProfile({ name: 'proj-profile', tenantId, projectId }));
    await AuthProfile.create(
      makeAuthProfile({
        name: 'tenant-profile',
        tenantId,
        scope: 'tenant',
        projectId: null,
      }),
    );
    await AuthProfile.create(
      makeAuthProfile({
        name: 'other-proj-profile',
        tenantId,
        projectId: 'proj-other',
      }),
    );

    // Simulate cascade: delete by projectId
    const result = await AuthProfile.deleteMany({ projectId });
    expect(result.deletedCount).toBe(1);

    const remaining = await AuthProfile.find({ tenantId });
    expect(remaining).toHaveLength(2);
    expect(remaining.map((p: any) => p.name).sort()).toEqual([
      'other-proj-profile',
      'tenant-profile',
    ]);
  });

  it('deleteUser removes personal profiles, anonymizes shared', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const userId = 'user-gdpr-cascade';
    const tenantId = 'tenant-user-cascade';

    await AuthProfile.create(
      makeAuthProfile({
        name: 'personal-cred',
        tenantId,
        createdBy: userId,
        visibility: 'personal',
      }),
    );
    await AuthProfile.create(
      makeAuthProfile({
        name: 'shared-cred',
        tenantId,
        createdBy: userId,
        visibility: 'shared',
      }),
    );

    // Simulate deleteUser cascade: delete personal, anonymize shared
    const delResult = await AuthProfile.deleteMany({
      createdBy: userId,
      visibility: 'personal',
    });
    expect(delResult.deletedCount).toBe(1);

    // createdBy is immutable in the Mongoose schema, so GDPR erasure
    // must bypass Mongoose hooks via the native collection driver
    await AuthProfile.collection.updateMany(
      { createdBy: userId, visibility: { $ne: 'personal' } },
      { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
    );

    const remaining = await AuthProfile.find({ tenantId });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('shared-cred');
    expect(remaining[0].createdBy).toBe('[SYSTEM:gdpr-erasure]');
  });

  it('cascade preserves other tenants profiles', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const tenantA = 'tenant-cascade-A';
    const tenantB = 'tenant-cascade-B';

    await AuthProfile.create(makeAuthProfile({ name: 'A-profile', tenantId: tenantA }));
    await AuthProfile.create(makeAuthProfile({ name: 'B-profile', tenantId: tenantB }));

    // Delete tenant A's profiles
    await AuthProfile.deleteMany({ tenantId: tenantA });

    const tenantAProfiles = await AuthProfile.find({ tenantId: tenantA });
    expect(tenantAProfiles).toHaveLength(0);

    const tenantBProfiles = await AuthProfile.find({ tenantId: tenantB });
    expect(tenantBProfiles).toHaveLength(1);
    expect(tenantBProfiles[0].name).toBe('B-profile');
  });
});

// ─── Tenant Isolation (3 tests) ──────────────────────────────────────────

describe('Tenant isolation', () => {
  it('findOne with wrong tenantId returns null', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(
      makeAuthProfile({ name: 'iso-profile', tenantId: 'tenant-iso-correct' }),
    );

    const result = await AuthProfile.findOne({
      _id: profile._id,
      tenantId: 'tenant-iso-wrong',
    });
    expect(result).toBeNull();
  });

  it('find by tenantId returns only that tenants profiles', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await AuthProfile.create(makeAuthProfile({ name: 'alpha-1', tenantId: 'tenant-alpha' }));
    await AuthProfile.create(makeAuthProfile({ name: 'alpha-2', tenantId: 'tenant-alpha' }));
    await AuthProfile.create(makeAuthProfile({ name: 'beta-1', tenantId: 'tenant-beta' }));

    const alphaResults = await AuthProfile.find({ tenantId: 'tenant-alpha' });
    expect(alphaResults).toHaveLength(2);
    expect(alphaResults.every((p: any) => p.tenantId === 'tenant-alpha')).toBe(true);

    const betaResults = await AuthProfile.find({ tenantId: 'tenant-beta' });
    expect(betaResults).toHaveLength(1);
    expect(betaResults[0].tenantId).toBe('tenant-beta');
  });

  it('updateOne with wrong tenantId modifies nothing', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(
      makeAuthProfile({
        name: 'no-touch',
        tenantId: 'tenant-owner',
        status: 'active',
      }),
    );

    const result = await AuthProfile.updateOne(
      { _id: profile._id, tenantId: 'tenant-attacker' },
      { $set: { status: 'revoked' } },
    );
    expect(result.modifiedCount).toBe(0);

    // Original is unchanged
    const unchanged = await AuthProfile.findOne({ _id: profile._id });
    expect(unchanged!.status).toBe('active');
  });
});
