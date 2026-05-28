import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { Project } from '../models/project.model.js';
import { ProjectAgent } from '../models/project-agent.model.js';
import { ProjectMember } from '../models/project-member.model.js';
import { AgentVersion } from '../models/agent-version.model.js';
import { AgentModelConfig } from '../models/agent-model-config.model.js';
import { Deployment } from '../models/deployment.model.js';
import { ModelConfig } from '../models/model-config.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Project Model ──────────────────────────────────────────────────────────

describe('Project', () => {
  const validProject = () => ({
    name: 'My Project',
    slug: 'my-project',
    ownerId: 'user-1',
  });

  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires name', () => {
    const doc = new Project({ slug: 'x', ownerId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires slug', () => {
    const doc = new Project({ name: 'X', ownerId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.slug).toBeDefined();
  });

  it('requires ownerId', () => {
    const doc = new Project({ name: 'X', slug: 'x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.ownerId).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new Project(validProject());
    expect(doc._id).toBeDefined();
    expect(doc.name).toBe('My Project');
    expect(doc.slug).toBe('my-project');
    expect(doc.ownerId).toBe('user-1');
    expect(doc.description).toBeNull();
    expect(doc.tenantId).toBeNull();
    expect(doc.entryAgentName).toBeNull();
    expect(doc.gitIntegrationId).toBeNull();
    expect(doc._v).toBe(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('persists with timestamps', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const proj = await Project.create(validProject());
    expect(proj._id).toBeDefined();
    expect(proj.createdAt).toBeInstanceOf(Date);
    expect(proj.updatedAt).toBeInstanceOf(Date);
  });

  it('enforces unique slug within a tenant', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Project.create({ ...validProject(), tenantId: 'tenant-1' });
    await expect(Project.create({ ...validProject(), tenantId: 'tenant-1' })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows duplicate names and slugs across tenants', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Project.create({ ...validProject(), tenantId: 'tenant-1' });

    const project = await Project.create({ ...validProject(), tenantId: 'tenant-2' });

    expect(project.name).toBe('My Project');
    expect(project.slug).toBe('my-project');
    expect(project.tenantId).toBe('tenant-2');
  });

  it('declares name as a tenant-scoped non-unique lookup index', () => {
    const index = Project.schema
      .indexes()
      .find(([key]) => JSON.stringify(key) === '{"tenantId":1,"name":1}');

    expect(index).toBeDefined();
    expect(index?.[1]).not.toMatchObject({ unique: true });
  });
});

// ─── ProjectAgent Model ─────────────────────────────────────────────────────

describe('ProjectAgent', () => {
  const validAgent = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'booking_agent',
    agentPath: 'proj-1/booking_agent',
  });

  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires projectId', () => {
    const doc = new ProjectAgent({ name: 'x', agentPath: 'x/x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires name', () => {
    const doc = new ProjectAgent({ projectId: 'p', agentPath: 'x/x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('derives agentPath from projectId and name when omitted', async () => {
    const doc = new ProjectAgent({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'booking_agent',
    });

    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.agentPath).toBe('proj-1/booking_agent');
  });

  it('rejects names that cannot be used in canonical agent paths and DSL references', async () => {
    const doc = new ProjectAgent({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'booking-agent',
    });

    await expect(doc.validate()).rejects.toThrow(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new ProjectAgent(validAgent());
    expect(doc._id).toBeDefined();
    expect(doc.projectId).toBe('proj-1');
    expect(doc.name).toBe('booking_agent');
    expect(doc.agentPath).toBe('proj-1/booking_agent');
    expect(doc.description).toBeNull();
    expect(doc.dslContent).toBeNull();
    expect(doc.activeVersions).toBeNull();
    expect(doc.ownerId).toBeNull();
    expect(doc.ownerTeamId).toBeNull();
    expect(doc.sourceHash).toBeNull();
    expect(doc.lastEditedBy).toBeNull();
    expect(doc.lastEditedAt).toBeNull();
    expect(doc._v).toBe(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique projectId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectAgent.create(validAgent());
    await expect(ProjectAgent.create(validAgent())).rejects.toThrow(/duplicate key/i);
  });

  it('allows same agentPath in different projects', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectAgent.create(validAgent());
    const agent2 = { ...validAgent(), projectId: 'proj-2', name: 'other_agent' };
    const created = await ProjectAgent.create(agent2);
    expect(created.agentPath).toBe('proj-2/other_agent');
  });

  it('allows same projectId+agentPath in different tenants', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectAgent.create(validAgent());
    const agent2 = {
      ...validAgent(),
      tenantId: 'tenant-2',
      name: 'other_agent',
    };
    const created = await ProjectAgent.create(agent2);
    expect(created.projectId).toBe(validAgent().projectId);
    expect(created.agentPath).toBe('proj-1/other_agent');
  });

  it('canonicalizes agentPath before enforcing uniqueness within same project', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectAgent.create(validAgent());
    const agent2 = { ...validAgent(), name: 'other_agent' };
    const created = await ProjectAgent.create(agent2);
    expect(created.agentPath).toBe('proj-1/other_agent');
  });

  it('canonicalizes arbitrary agentPath on create', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await ProjectAgent.create({
      ...validAgent(),
      agentPath: 'legacy/default/booking_agent',
    });

    expect(created.agentPath).toBe('proj-1/booking_agent');
  });

  it('canonicalizes arbitrary agentPath on insertMany', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const [created] = await ProjectAgent.insertMany([
      {
        ...validAgent(),
        agentPath: 'legacy/default/booking_agent',
      },
    ]);

    expect(created.agentPath).toBe('proj-1/booking_agent');
  });

  it('canonicalizes agentPath on direct findOneAndUpdate renames', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await ProjectAgent.create(validAgent());

    const updated = await ProjectAgent.findOneAndUpdate(
      { _id: created._id, tenantId: 'tenant-1' },
      { $set: { name: 'renamed_agent', agentPath: 'legacy/path' } },
      { new: true },
    );

    expect(updated?.name).toBe('renamed_agent');
    expect(updated?.agentPath).toBe('proj-1/renamed_agent');
  });

  it('rejects invalid names on direct bulkWrite identity updates', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await ProjectAgent.create(validAgent());

    await expect(
      ProjectAgent.bulkWrite([
        {
          updateOne: {
            filter: { _id: created._id, tenantId: 'tenant-1', projectId: 'proj-1' },
            update: { $set: { name: 'renamed-agent' } },
          },
        },
      ]),
    ).rejects.toThrow(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );
  });

  it('declares tenant-scoped non-unique lookup index for agentPath', () => {
    const index = ProjectAgent.schema
      .indexes()
      .find(([key]) => JSON.stringify(key) === '{"tenantId":1,"projectId":1,"agentPath":1}');

    expect(index).toBeDefined();
    expect(index?.[1]).not.toMatchObject({ unique: true });
  });
});

// ─── ProjectMember Model ────────────────────────────────────────────────────

describe('ProjectMember', () => {
  const validMember = () => ({
    projectId: 'proj-1',
    userId: 'user-1',
    role: 'tester',
  });

  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires projectId', () => {
    const doc = new ProjectMember({ userId: 'u', role: 'tester' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires userId', () => {
    const doc = new ProjectMember({ projectId: 'p', role: 'tester' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires role', () => {
    const doc = new ProjectMember({ projectId: 'p', userId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new ProjectMember(validMember());
    expect(doc._id).toBeDefined();
    expect(doc.projectId).toBe('proj-1');
    expect(doc.userId).toBe('user-1');
    expect(doc.role).toBe('tester');
    expect(doc.customRoleId).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('accepts the canonical custom project role vocabulary', () => {
    const doc = new ProjectMember({
      projectId: 'p',
      userId: 'u',
      role: 'custom',
      customRoleId: 'custom-role-1',
    });

    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.role).toBe('custom');
    expect(doc.customRoleId).toBe('custom-role-1');
  });

  it('rejects unsupported role values', () => {
    const doc = new ProjectMember({ projectId: 'p', userId: 'u', role: 'editor' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique projectId+userId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ProjectMember.create(validMember());
    await expect(ProjectMember.create(validMember())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── AgentVersion Model ─────────────────────────────────────────────────────

describe('AgentVersion', () => {
  const validVersion = () => ({
    agentId: 'agent-1',
    version: '1.0.0',
    status: 'draft',
    dslContent: 'agent booking { }',
    irContent: '{"type":"agent"}',
    sourceHash: 'abc123',
    createdBy: 'user-1',
  });

  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires agentId', () => {
    const data = validVersion();
    delete (data as any).agentId;
    const doc = new AgentVersion(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.agentId).toBeDefined();
  });

  it('requires version', () => {
    const data = validVersion();
    delete (data as any).version;
    const doc = new AgentVersion(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.version).toBeDefined();
  });

  it('requires status', () => {
    const data = validVersion();
    delete (data as any).status;
    const doc = new AgentVersion(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('requires dslContent', () => {
    const data = validVersion();
    delete (data as any).dslContent;
    const doc = new AgentVersion(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.dslContent).toBeDefined();
  });

  it('requires irContent', () => {
    const data = validVersion();
    delete (data as any).irContent;
    const doc = new AgentVersion(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.irContent).toBeDefined();
  });

  it('requires sourceHash', () => {
    const data = validVersion();
    delete (data as any).sourceHash;
    const doc = new AgentVersion(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceHash).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validVersion();
    delete (data as any).createdBy;
    const doc = new AgentVersion(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new AgentVersion(validVersion());
    expect(doc._id).toBeDefined();
    expect(doc.agentId).toBe('agent-1');
    expect(doc.version).toBe('1.0.0');
    expect(doc.status).toBe('draft');
    expect(doc.dslContent).toBe('agent booking { }');
    expect(doc.irContent).toBe('{"type":"agent"}');
    expect(doc.sourceHash).toBe('abc123');
    expect(doc.changelog).toBeNull();
    expect(doc.createdBy).toBe('user-1');
    expect(doc.promotedAt).toBeNull();
    expect(doc.promotedBy).toBeNull();
    expect(doc.testResults).toBeNull();
    expect(doc._v).toBe(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique agentId+version', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await AgentVersion.create(validVersion());
    await expect(AgentVersion.create(validVersion())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── AgentModelConfig Model ─────────────────────────────────────────────────

describe('AgentModelConfig', () => {
  const validConfig = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    agentName: 'booking_agent',
  });

  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires projectId', () => {
    const doc = new AgentModelConfig({ tenantId: 'tenant-1', agentName: 'x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires tenantId', () => {
    const doc = new AgentModelConfig({ projectId: 'p', agentName: 'x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires agentName', () => {
    const doc = new AgentModelConfig({ tenantId: 'tenant-1', projectId: 'p' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.agentName).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new AgentModelConfig(validConfig());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.agentName).toBe('booking_agent');
    expect(doc.defaultModel).toBeNull();
    expect(doc.operationModels).toBeNull();
    expect(doc.temperature).toBeNull();
    expect(doc.maxTokens).toBeNull();
    expect(doc._v).toBe(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique tenantId+projectId+agentName', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await AgentModelConfig.create(validConfig());
    await expect(AgentModelConfig.create(validConfig())).rejects.toThrow(/duplicate key/i);
    await expect(
      AgentModelConfig.create({
        ...validConfig(),
        tenantId: 'tenant-2',
      }),
    ).resolves.toBeDefined();
  });
});

// ─── Deployment Model ───────────────────────────────────────────────────────

describe('Deployment', () => {
  const validDeployment = () => ({
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    environment: 'production',
    entryAgentName: 'booking_agent',
    endpointSlug: 'proj-1-prod',
    createdBy: 'user-1',
  });

  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires projectId', () => {
    const data = validDeployment();
    delete (data as any).projectId;
    const doc = new Deployment(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires tenantId', () => {
    const data = validDeployment();
    delete (data as any).tenantId;
    const doc = new Deployment(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires environment', () => {
    const data = validDeployment();
    delete (data as any).environment;
    const doc = new Deployment(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  it('validates environment enum', () => {
    const doc = new Deployment({
      ...validDeployment(),
      environment: 'invalid',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  it('accepts valid environment values', () => {
    const envs = ['dev', 'staging', 'production'];
    for (const env of envs) {
      const doc = new Deployment({ ...validDeployment(), environment: env });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.environment).toBe(env);
    }
  });

  it('validates status enum', () => {
    const doc = new Deployment({
      ...validDeployment(),
      status: 'invalid',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['active', 'draining', 'retired'];
    for (const status of statuses) {
      const doc = new Deployment({ ...validDeployment(), status });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.status).toBe(status);
    }
  });

  it('requires entryAgentName', () => {
    const data = validDeployment();
    delete (data as any).entryAgentName;
    const doc = new Deployment(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.entryAgentName).toBeDefined();
  });

  it('requires endpointSlug', () => {
    const data = validDeployment();
    delete (data as any).endpointSlug;
    const doc = new Deployment(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.endpointSlug).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validDeployment();
    delete (data as any).createdBy;
    const doc = new Deployment(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new Deployment(validDeployment());
    expect(doc._id).toBeDefined();
    expect(doc.projectId).toBe('proj-1');
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.environment).toBe('production');
    expect(doc.label).toBeNull();
    expect(doc.description).toBeNull();
    expect(doc.entryAgentName).toBe('booking_agent');
    expect(doc.compilationHash).toBeNull();
    expect(doc.modelOverrides).toBeNull();
    expect(doc.voiceConfig).toBeNull();
    expect(doc.status).toBe('active');
    expect(doc.endpointSlug).toBe('proj-1-prod');
    expect(doc.previousDeploymentId).toBeNull();
    expect(doc.createdBy).toBe('user-1');
    expect(doc.retiredAt).toBeNull();
    expect(doc.drainingStartedAt).toBeNull();
    expect(doc._v).toBe(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('persists with timestamps', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const dep = await Deployment.create(validDeployment());
    expect(dep.createdAt).toBeInstanceOf(Date);
    expect(dep.updatedAt).toBeInstanceOf(Date);
  });

  it('enforces unique endpointSlug', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Deployment.create(validDeployment());
    await expect(Deployment.create(validDeployment())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── ModelConfig Model ──────────────────────────────────────────────────────

describe('ModelConfig', () => {
  const validConfig = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'GPT-4',
    modelId: 'gpt-4',
    provider: 'openai',
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1.0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    contextWindow: 128000,
    tier: 'premium',
    isDefault: true,
    priority: 1,
  });

  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires projectId', () => {
    const data = validConfig();
    delete (data as any).projectId;
    const doc = new ModelConfig(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires tenantId', () => {
    const data = validConfig();
    delete (data as any).tenantId;
    const doc = new ModelConfig(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires name', () => {
    const data = validConfig();
    delete (data as any).name;
    const doc = new ModelConfig(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires provider', () => {
    const data = validConfig();
    delete (data as any).provider;
    const doc = new ModelConfig(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.provider).toBeDefined();
  });

  it('requires temperature', () => {
    const data = validConfig();
    delete (data as any).temperature;
    const doc = new ModelConfig(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.temperature).toBeDefined();
  });

  it('requires maxTokens', () => {
    const data = validConfig();
    delete (data as any).maxTokens;
    const doc = new ModelConfig(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.maxTokens).toBeDefined();
  });

  it('requires tier', () => {
    const data = validConfig();
    delete (data as any).tier;
    const doc = new ModelConfig(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tier).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets fields on construction', () => {
    const doc = new ModelConfig(validConfig());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.name).toBe('GPT-4');
    expect(doc.modelId).toBe('gpt-4');
    expect(doc.provider).toBe('openai');
    expect(doc.temperature).toBe(0.7);
    expect(doc.maxTokens).toBe(4096);
    expect(doc.topP).toBe(1.0);
    expect(doc.frequencyPenalty).toBe(0);
    expect(doc.presencePenalty).toBe(0);
    expect(doc.inputCostPer1k).toBeNull();
    expect(doc.outputCostPer1k).toBeNull();
    expect(doc.supportsTools).toBe(true);
    expect(doc.supportsVision).toBe(false);
    expect(doc.supportsStreaming).toBe(true);
    expect(doc.contextWindow).toBe(128000);
    expect(doc.tier).toBe('premium');
    expect(doc.isDefault).toBe(true);
    expect(doc.priority).toBe(1);
    expect(doc.credentialId).toBeNull();
    expect(doc.tenantModelId).toBeNull();
    expect(doc._v).toBe(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique projectId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ModelConfig.create(validConfig());
    await expect(ModelConfig.create(validConfig())).rejects.toThrow(/duplicate key/i);
  });
});
