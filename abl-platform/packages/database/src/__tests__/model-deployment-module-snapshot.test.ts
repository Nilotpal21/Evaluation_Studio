import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { DeploymentModuleSnapshot } from '../models/deployment-module-snapshot.model.js';

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

const validSnapshot = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  deploymentId: 'deploy-1',
  snapshotHash: 'sha256-snapshot-abc',
  compressedPayload: Buffer.from('compressed-module-data'),
  createdBy: 'user-1',
});

// ─── DeploymentModuleSnapshot Model ──────────────────────────────────────────

describe('DeploymentModuleSnapshot', () => {
  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires tenantId', () => {
    const data = validSnapshot();
    delete (data as any).tenantId;
    const doc = new DeploymentModuleSnapshot(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validSnapshot();
    delete (data as any).projectId;
    const doc = new DeploymentModuleSnapshot(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires deploymentId', () => {
    const data = validSnapshot();
    delete (data as any).deploymentId;
    const doc = new DeploymentModuleSnapshot(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.deploymentId).toBeDefined();
  });

  it('requires snapshotHash', () => {
    const data = validSnapshot();
    delete (data as any).snapshotHash;
    const doc = new DeploymentModuleSnapshot(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.snapshotHash).toBeDefined();
  });

  it('requires compressedPayload', () => {
    const data = validSnapshot();
    delete (data as any).compressedPayload;
    const doc = new DeploymentModuleSnapshot(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.compressedPayload).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validSnapshot();
    delete (data as any).createdBy;
    const doc = new DeploymentModuleSnapshot(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new DeploymentModuleSnapshot(validSnapshot());
    expect(doc._id).toBeDefined();
    expect(doc._id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.deploymentId).toBe('deploy-1');
    expect(doc.snapshotHash).toBe('sha256-snapshot-abc');
    expect(doc.createdBy).toBe('user-1');
  });

  it('stores compressedPayload as Buffer', () => {
    const doc = new DeploymentModuleSnapshot(validSnapshot());
    expect(Buffer.isBuffer(doc.compressedPayload)).toBe(true);
    expect(doc.compressedPayload.toString()).toBe('compressed-module-data');
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique (tenantId, deploymentId)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DeploymentModuleSnapshot.create(validSnapshot());
    await expect(DeploymentModuleSnapshot.create(validSnapshot())).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows different deploymentIds for same project', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DeploymentModuleSnapshot.create(validSnapshot());
    const snap2 = { ...validSnapshot(), deploymentId: 'deploy-2' };
    const created = await DeploymentModuleSnapshot.create(snap2);
    expect(created.deploymentId).toBe('deploy-2');
  });

  it('stores and retrieves Buffer data correctly', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const payload = Buffer.from(JSON.stringify({ agents: ['a', 'b'] }));
    const snap = await DeploymentModuleSnapshot.create({
      ...validSnapshot(),
      compressedPayload: payload,
    });

    const retrieved = await DeploymentModuleSnapshot.findOne({
      _id: snap._id,
      tenantId: 'tenant-1',
    });
    expect(retrieved).toBeDefined();
    const retrievedBuf = Buffer.from(retrieved!.compressedPayload);
    expect(JSON.parse(retrievedBuf.toString())).toEqual({ agents: ['a', 'b'] });
  });

  it('supports consumer listing by (tenantId, projectId)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DeploymentModuleSnapshot.create(validSnapshot());
    await DeploymentModuleSnapshot.create({
      ...validSnapshot(),
      deploymentId: 'deploy-2',
    });
    // Different project
    await DeploymentModuleSnapshot.create({
      ...validSnapshot(),
      projectId: 'proj-2',
      deploymentId: 'deploy-3',
    });

    const results = await DeploymentModuleSnapshot.find({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(results).toHaveLength(2);
  });

  it('persists with createdAt timestamp', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const snap = await DeploymentModuleSnapshot.create(validSnapshot());
    expect(snap.createdAt).toBeInstanceOf(Date);
  });
});
