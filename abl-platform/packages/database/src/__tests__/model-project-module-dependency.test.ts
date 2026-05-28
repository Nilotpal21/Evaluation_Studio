import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { ProjectModuleDependency } from '../models/project-module-dependency.model.js';

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

const validContract = () => ({
  providedAgents: [{ name: 'billing_agent', description: 'Billing' }],
  providedTools: [{ name: 'charge_card', toolType: 'http' }],
  requiredConfigKeys: [{ key: 'API_KEY', isSecret: true }],
  requiredEnvVars: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
  warnings: [],
});

const validDependency = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-consumer-1',
  moduleProjectId: 'mod-proj-1',
  moduleProjectName: 'Billing Module',
  alias: 'billing',
  selector: { type: 'version' as const, value: '1.0.0' },
  resolvedReleaseId: 'release-1',
  resolvedVersion: '1.0.0',
  configOverrides: { API_KEY: 'sk-test-123' },
  contractSnapshot: validContract(),
  createdBy: 'user-1',
});

// ─── ProjectModuleDependency Model ───────────────────────────────────────────

describe('ProjectModuleDependency', () => {
  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires tenantId', () => {
    const data = validDependency();
    delete (data as any).tenantId;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validDependency();
    delete (data as any).projectId;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires moduleProjectId', () => {
    const data = validDependency();
    delete (data as any).moduleProjectId;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.moduleProjectId).toBeDefined();
  });

  it('requires alias', () => {
    const data = validDependency();
    delete (data as any).alias;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.alias).toBeDefined();
  });

  it('requires selector', () => {
    const data = validDependency();
    delete (data as any).selector;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.selector).toBeDefined();
  });

  it('requires resolvedReleaseId', () => {
    const data = validDependency();
    delete (data as any).resolvedReleaseId;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.resolvedReleaseId).toBeDefined();
  });

  it('requires contractSnapshot', () => {
    const data = validDependency();
    delete (data as any).contractSnapshot;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.contractSnapshot).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validDependency();
    delete (data as any).createdBy;
    const doc = new ProjectModuleDependency(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new ProjectModuleDependency(validDependency());
    expect(doc._id).toBeDefined();
    expect(doc._id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-consumer-1');
    expect(doc.moduleProjectId).toBe('mod-proj-1');
    expect(doc.alias).toBe('billing');
    expect(doc.resolvedReleaseId).toBe('release-1');
    expect(doc.createdBy).toBe('user-1');
  });

  it('stores selector sub-document with version type', () => {
    const doc = new ProjectModuleDependency(validDependency());
    expect(doc.selector.type).toBe('version');
    expect(doc.selector.value).toBe('1.0.0');
  });

  it('stores selector sub-document with environment type', () => {
    const doc = new ProjectModuleDependency({
      ...validDependency(),
      selector: { type: 'environment', value: 'production' },
    });
    expect(doc.selector.type).toBe('environment');
    expect(doc.selector.value).toBe('production');
  });

  it('stores configOverrides as Record<string, string>', () => {
    const doc = new ProjectModuleDependency(validDependency());
    expect(doc.configOverrides).toEqual({ API_KEY: 'sk-test-123' });
  });

  it('defaults configOverrides to empty object', () => {
    const data = validDependency();
    delete (data as any).configOverrides;
    const doc = new ProjectModuleDependency(data);
    expect(doc.configOverrides).toEqual({});
  });

  it('stores contractSnapshot correctly', () => {
    const doc = new ProjectModuleDependency(validDependency());
    expect(doc.contractSnapshot.providedAgents).toHaveLength(1);
    expect(doc.contractSnapshot.providedAgents[0].name).toBe('billing_agent');
    expect(doc.contractSnapshot.providedTools).toHaveLength(1);
    expect(doc.contractSnapshot.requiredConfigKeys).toHaveLength(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique (tenantId, projectId, alias)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectModuleDependency.create(validDependency());
    await expect(ProjectModuleDependency.create(validDependency())).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows same alias in different projects', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectModuleDependency.create(validDependency());
    const dep2 = { ...validDependency(), projectId: 'proj-consumer-2' };
    const created = await ProjectModuleDependency.create(dep2);
    expect(created.alias).toBe('billing');
  });

  it('supports reverse lookup by (tenantId, moduleProjectId)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectModuleDependency.create(validDependency());
    await ProjectModuleDependency.create({
      ...validDependency(),
      projectId: 'proj-consumer-2',
      alias: 'billing-v2',
    });

    const results = await ProjectModuleDependency.find({
      tenantId: 'tenant-1',
      moduleProjectId: 'mod-proj-1',
    });
    expect(results).toHaveLength(2);
  });

  it('persists with timestamps', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const dep = await ProjectModuleDependency.create(validDependency());
    expect(dep.createdAt).toBeInstanceOf(Date);
    expect(dep.updatedAt).toBeInstanceOf(Date);
  });
});
