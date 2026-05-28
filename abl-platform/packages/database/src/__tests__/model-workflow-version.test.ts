import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { WorkflowVersion } from '../models/workflow-version.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validVersion = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  workflowId: 'wf-001',
  version: '0.1.0',
  sourceHash: 'abc12345def67890',
  definition: {
    nodes: [],
    edges: [],
    envVars: {},
    inputSchema: null,
    outputSchema: null,
  },
  createdBy: 'user-1',
});

describe('WorkflowVersion model', () => {
  it('creates a version with required fields', async ({ skip }) => {
    requireMongo(skip);
    const doc = await WorkflowVersion.create(validVersion());
    expect(doc._id).toBeDefined();
    expect(doc.version).toBe('0.1.0');
    expect(doc.workflowId).toBe('wf-001');
    expect(doc.createdBy).toBe('user-1');
    expect(doc.changelog).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('stores version as a String (semver)', async ({ skip }) => {
    requireMongo(skip);
    const doc = await WorkflowVersion.create({ ...validVersion(), version: '1.2.3' });
    expect(doc.version).toBe('1.2.3');
    expect(typeof doc.version).toBe('string');
  });

  it('requires createdBy', () => {
    const data = validVersion();
    delete (data as any).createdBy;
    const err = new WorkflowVersion(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  it('requires definition', () => {
    const data = validVersion();
    delete (data as any).definition;
    const err = new WorkflowVersion(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.definition).toBeDefined();
  });

  it('enforces unique constraint on tenantId + projectId + workflowId + version', async ({
    skip,
  }) => {
    requireMongo(skip);
    await WorkflowVersion.create(validVersion());
    await expect(WorkflowVersion.create(validVersion())).rejects.toThrow();
  });

  it('allows same version number for different tenants', async ({ skip }) => {
    requireMongo(skip);
    const v1 = await WorkflowVersion.create(validVersion());
    const v2 = await WorkflowVersion.create({
      ...validVersion(),
      tenantId: 'tenant-b',
    });
    expect(v1._id).not.toBe(v2._id);
  });

  it('allows same version number for different projects', async ({ skip }) => {
    requireMongo(skip);
    const v1 = await WorkflowVersion.create(validVersion());
    const v2 = await WorkflowVersion.create({
      ...validVersion(),
      projectId: 'proj-2',
    });
    expect(v1._id).not.toBe(v2._id);
  });

  it('stores definition snapshot with nodes and edges', async ({ skip }) => {
    requireMongo(skip);
    const definition = {
      nodes: [
        {
          id: 'n1',
          nodeType: 'start',
          name: 'Start',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'n2',
          nodeType: 'text_to_text',
          name: 'LLM Call',
          position: { x: 200, y: 100 },
          config: { model: 'gpt-4', temperature: 0.7 },
        },
        {
          id: 'n3',
          nodeType: 'end',
          name: 'End',
          position: { x: 400, y: 0 },
          config: {},
        },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', label: 'done' },
      ],
      envVars: { API_KEY: 'test-key' },
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    };
    const doc = await WorkflowVersion.create({
      ...validVersion(),
      version: '0.2.0',
      definition,
      changelog: 'Added LLM node',
    });
    const fetched = await WorkflowVersion.findOne({
      _id: doc._id,
      tenantId: 'tenant-1',
    }).lean();
    expect(fetched!.definition.nodes).toHaveLength(3);
    expect(fetched!.definition.edges).toHaveLength(2);
    expect(fetched!.definition.envVars).toEqual({ API_KEY: 'test-key' });
    expect(fetched!.definition.inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
    expect(fetched!.changelog).toBe('Added LLM node');
  });

  it('preserves expanded workflow definition fields', async ({ skip }) => {
    requireMongo(skip);
    const archivedAt = new Date('2026-04-16T00:00:00.000Z');
    const definition = {
      nodes: [],
      edges: [],
      envVars: {},
      inputSchema: null,
      outputSchema: null,
      type: 'cx_automation',
      entryAgent: 'triage_agent',
      steps: [{ id: 'step-1', type: 'agent' }],
      slaMinutes: 15,
      escalationRules: [{ threshold: 2 }],
      notificationRules: [{ channel: 'email', enabled: true }],
      archivedAt,
    };

    const doc = await WorkflowVersion.create({
      ...validVersion(),
      version: '0.3.0',
      definition,
    });

    const fetched = await WorkflowVersion.findOne({
      _id: doc._id,
      tenantId: 'tenant-1',
    }).lean();

    expect(fetched!.definition.type).toBe('cx_automation');
    expect(fetched!.definition.entryAgent).toBe('triage_agent');
    expect(fetched!.definition.steps).toEqual([{ id: 'step-1', type: 'agent' }]);
    expect(fetched!.definition.slaMinutes).toBe(15);
    expect(fetched!.definition.escalationRules).toEqual([{ threshold: 2 }]);
    expect(fetched!.definition.notificationRules).toEqual([{ channel: 'email', enabled: true }]);
    expect(new Date(fetched!.definition.archivedAt as string | Date).toISOString()).toBe(
      archivedAt.toISOString(),
    );
  });

  it('defaults changelog to null and _v to 1', () => {
    const doc = new WorkflowVersion(validVersion());
    expect(doc.changelog).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('defaults definition arrays to empty', async ({ skip }) => {
    requireMongo(skip);
    const doc = await WorkflowVersion.create({
      ...validVersion(),
      definition: {},
    });
    const fetched = await WorkflowVersion.findOne({
      _id: doc._id,
      tenantId: 'tenant-1',
    }).lean();
    expect(fetched!.definition.nodes).toEqual([]);
    expect(fetched!.definition.edges).toEqual([]);
    // When definition is passed as {}, Mixed fields without explicit values
    // may not receive their schema defaults after round-tripping through MongoDB
    expect(fetched!.definition.envVars ?? {}).toEqual({});
    expect(fetched!.definition.inputSchema ?? null).toBeNull();
    expect(fetched!.definition.outputSchema ?? null).toBeNull();
  });
});
