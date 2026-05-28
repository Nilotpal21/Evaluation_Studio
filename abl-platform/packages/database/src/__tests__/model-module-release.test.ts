import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { ModuleRelease } from '../models/module-release.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const validArtifact = () => ({
  dslFormat: 'yaml' as const,
  entryAgentName: 'main_agent',
  agents: {
    main_agent: { dslContent: 'AGENT: main_agent', sourceHash: 'abc123' },
  },
  tools: {},
});

const validContract = () => ({
  providedAgents: [{ name: 'main_agent', description: 'Main agent' }],
  providedTools: [],
  requiredConfigKeys: [],
  requiredEnvVars: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
  warnings: [],
});

const validRelease = () => ({
  tenantId: 'tenant-1',
  moduleProjectId: 'mod-proj-1',
  version: '1.0.0',
  artifact: validArtifact(),
  compiledIR: { type: 'module' },
  contract: validContract(),
  sourceHash: 'sha256-abc123',
  createdBy: 'user-1',
});

// ─── ModuleRelease Model ─────────────────────────────────────────────────────

describe('ModuleRelease', () => {
  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires tenantId', () => {
    const data = validRelease();
    delete (data as any).tenantId;
    const doc = new ModuleRelease(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires moduleProjectId', () => {
    const data = validRelease();
    delete (data as any).moduleProjectId;
    const doc = new ModuleRelease(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.moduleProjectId).toBeDefined();
  });

  it('requires version', () => {
    const data = validRelease();
    delete (data as any).version;
    const doc = new ModuleRelease(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.version).toBeDefined();
  });

  it('requires artifact', () => {
    const data = validRelease();
    delete (data as any).artifact;
    const doc = new ModuleRelease(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.artifact).toBeDefined();
  });

  it('requires contract', () => {
    const data = validRelease();
    delete (data as any).contract;
    const doc = new ModuleRelease(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.contract).toBeDefined();
  });

  it('requires sourceHash', () => {
    const data = validRelease();
    delete (data as any).sourceHash;
    const doc = new ModuleRelease(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceHash).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validRelease();
    delete (data as any).createdBy;
    const doc = new ModuleRelease(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new ModuleRelease(validRelease());
    expect(doc._id).toBeDefined();
    expect(typeof doc._id).toBe('string');
    // UUID v7 format: 8-4-4-4-12 hex chars
    expect(doc._id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.moduleProjectId).toBe('mod-proj-1');
    expect(doc.version).toBe('1.0.0');
    expect(doc.sourceHash).toBe('sha256-abc123');
    expect(doc.createdBy).toBe('user-1');
    expect(doc.releaseNotes).toBeNull();
    expect(doc.archivedAt).toBeNull();
    expect(doc.archivedBy).toBeNull();
  });

  it('stores sourceHash correctly', () => {
    const doc = new ModuleRelease({ ...validRelease(), sourceHash: 'sha256-deadbeef' });
    expect(doc.sourceHash).toBe('sha256-deadbeef');
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique (tenantId, moduleProjectId, version)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ModuleRelease.create(validRelease());
    await expect(ModuleRelease.create(validRelease())).rejects.toThrow(/duplicate key/i);
  });

  it('allows same version for different moduleProjectId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ModuleRelease.create(validRelease());
    const release2 = { ...validRelease(), moduleProjectId: 'mod-proj-2' };
    const created = await ModuleRelease.create(release2);
    expect(created.version).toBe('1.0.0');
  });

  it('scopes queries by tenantId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ModuleRelease.create(validRelease());
    await ModuleRelease.create({ ...validRelease(), tenantId: 'tenant-2', version: '2.0.0' });

    const tenant1Results = await ModuleRelease.find({ tenantId: 'tenant-1' });
    expect(tenant1Results).toHaveLength(1);
    expect(tenant1Results[0].tenantId).toBe('tenant-1');
  });

  it('supports listing by (tenantId, moduleProjectId) sorted by createdAt desc', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ModuleRelease.create({ ...validRelease(), version: '1.0.0' });
    // Small delay to ensure different createdAt timestamps
    await new Promise((r) => setTimeout(r, 10));
    await ModuleRelease.create({ ...validRelease(), version: '2.0.0' });

    const results = await ModuleRelease.find({
      tenantId: 'tenant-1',
      moduleProjectId: 'mod-proj-1',
    }).sort({ createdAt: -1 });

    expect(results).toHaveLength(2);
    expect(results[0].version).toBe('2.0.0');
    expect(results[1].version).toBe('1.0.0');
  });

  it('persists soft delete fields (archivedAt, archivedBy)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const release = await ModuleRelease.create(validRelease());
    expect(release.archivedAt).toBeNull();
    expect(release.archivedBy).toBeNull();

    const now = new Date();
    await ModuleRelease.findOneAndUpdate(
      { _id: release._id, tenantId: 'tenant-1' },
      { $set: { archivedAt: now, archivedBy: 'user-2' } },
    );

    const updated = await ModuleRelease.findOne({ _id: release._id, tenantId: 'tenant-1' });
    expect(updated!.archivedAt).toBeInstanceOf(Date);
    expect(updated!.archivedBy).toBe('user-2');
  });

  it('persists with createdAt timestamp', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const release = await ModuleRelease.create(validRelease());
    expect(release.createdAt).toBeInstanceOf(Date);
  });
});
