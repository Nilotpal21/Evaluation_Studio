import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { SDKChannel } from '../models/sdk-channel.model.js';
import { WidgetConfig } from '../models/widget-config.model.js';
import { Workflow } from '../models/workflow.model.js';
import { WorkspaceInvitation } from '../models/workspace-invitation.model.js';
import { ArchiveManifest } from '../models/archive-manifest.model.js';
import { OrgProxyConfig } from '../models/org-proxy-config.model.js';
import { ServiceNode } from '../models/service-node.model.js';
import { TenantTransfer } from '../models/tenant-transfer.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── SDKChannel Model ──────────────────────────────────────────────────────

describe('SDKChannel', () => {
  const validChannel = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Web Chat',
    channelType: 'web',
    publicApiKeyId: 'pak-1',
  });

  it('sets default fields on instantiation', () => {
    const ch = new SDKChannel(validChannel());
    expect(ch._id).toBeDefined();
    expect(ch.tenantId).toBe('tenant-1');
    expect(ch.projectId).toBe('proj-1');
    expect(ch.deploymentId).toBeNull();
    expect(ch.name).toBe('Web Chat');
    expect(ch.channelType).toBe('web');
    expect(ch.publicApiKeyId).toBe('pak-1');
    expect(ch.isActive).toBe(true);
    expect(ch._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validChannel();
    delete (data as any).tenantId;
    const err = new SDKChannel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validChannel();
    delete (data as any).projectId;
    const err = new SDKChannel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires name', () => {
    const data = validChannel();
    delete (data as any).name;
    const err = new SDKChannel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires channelType', () => {
    const data = validChannel();
    delete (data as any).channelType;
    const err = new SDKChannel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.channelType).toBeDefined();
  });

  it('requires publicApiKeyId', () => {
    const data = validChannel();
    delete (data as any).publicApiKeyId;
    const err = new SDKChannel(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.publicApiKeyId).toBeDefined();
  });

  it('enforces unique tenantId+projectId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await SDKChannel.create(validChannel());
    await expect(SDKChannel.create(validChannel())).rejects.toThrow(/duplicate key/i);
  });

  it('does not expose a reserved authProfileId schema path', () => {
    expect(SDKChannel.schema.path('authProfileId')).toBeUndefined();
  });
});

// ─── WidgetConfig Model ─────────────────────────────────────────────────────

describe('WidgetConfig', () => {
  const validWidget = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    mode: 'chat',
    position: 'bottom-right',
    voiceEnabled: false,
    chatEnabled: true,
  });

  it('sets default fields on instantiation', () => {
    const widget = new WidgetConfig(validWidget());
    expect(widget._id).toBeDefined();
    expect(widget.tenantId).toBe('tenant-1');
    expect(widget.projectId).toBe('proj-1');

    expect(widget.position).toBe('bottom-right');
    expect(widget.welcomeMessage).toBeNull();
    expect(widget.placeholderText).toBeNull();
    expect(widget.voiceEnabled).toBe(false);
    expect(widget.chatEnabled).toBe(true);
    expect(widget._v).toBe(1);
  });

  it('requires projectId', () => {
    const data = validWidget();
    delete (data as any).projectId;
    const err = new WidgetConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires tenantId', () => {
    const data = validWidget();
    delete (data as any).tenantId;
    const err = new WidgetConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires mode', () => {
    const data = validWidget();
    delete (data as any).mode;
    const err = new WidgetConfig(data).validateSync();
    expect(err).toBeDefined();
  });

  it('requires position', () => {
    const data = validWidget();
    delete (data as any).position;
    const err = new WidgetConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.position).toBeDefined();
  });

  it('requires voiceEnabled', () => {
    const data = validWidget();
    delete (data as any).voiceEnabled;
    const err = new WidgetConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.voiceEnabled).toBeDefined();
  });

  it('requires chatEnabled', () => {
    const data = validWidget();
    delete (data as any).chatEnabled;
    const err = new WidgetConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.chatEnabled).toBeDefined();
  });

  it('enforces unique projectId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await WidgetConfig.create(validWidget());
    await expect(WidgetConfig.create(validWidget())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── Workflow Model ─────────────────────────────────────────────────────────

describe('Workflow', () => {
  const validWorkflow = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Customer Support Flow',
  });

  it('sets default fields on instantiation', () => {
    const wf = new Workflow(validWorkflow());
    expect(wf._id).toBeDefined();
    expect(wf.tenantId).toBe('tenant-1');
    expect(wf.projectId).toBe('proj-1');
    expect(wf.name).toBe('Customer Support Flow');
    expect(wf.description).toBeNull();
    expect(wf.nodes).toEqual([]);
    expect(wf.edges).toEqual([]);
    expect(wf.status).toBe('draft');
    expect(wf.metadata).toBeNull();
    expect(wf._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validWorkflow();
    delete (data as any).tenantId;
    const err = new Workflow(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validWorkflow();
    delete (data as any).projectId;
    const err = new Workflow(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires name', () => {
    const data = validWorkflow();
    delete (data as any).name;
    const err = new Workflow(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('validates status enum', () => {
    const err = new Workflow({
      ...validWorkflow(),
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['draft', 'active', 'archived'];
    for (const status of statuses) {
      const wf = new Workflow({ ...validWorkflow(), status });
      const err = wf.validateSync();
      expect(err).toBeUndefined();
      expect(wf.status).toBe(status);
    }
  });

  it('enforces unique tenantId+projectId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Workflow.create(validWorkflow());
    await expect(Workflow.create(validWorkflow())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── WorkspaceInvitation Model ──────────────────────────────────────────────

describe('WorkspaceInvitation', () => {
  const validInvite = () => ({
    tenantId: 'tenant-1',
    email: 'new-user@example.com',
    role: 'member',
    token: 'invite-abc-123',
    expiresAt: new Date(Date.now() + 604800000),
  });

  it('sets default fields on instantiation', () => {
    const invite = new WorkspaceInvitation(validInvite());
    expect(invite._id).toBeDefined();
    expect(invite.tenantId).toBe('tenant-1');
    expect(invite.email).toBe('new-user@example.com');
    expect(invite.role).toBe('member');
    expect(invite.invitedBy).toBeNull();
    expect(invite.token).toBe('invite-abc-123');
    expect(invite.status).toBe('pending');
    expect(invite.expiresAt).toBeInstanceOf(Date);
    expect(invite.acceptedAt).toBeNull();
    expect(invite.acceptedBy).toBeNull();
    expect(invite._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validInvite();
    delete (data as any).tenantId;
    const err = new WorkspaceInvitation(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires email', () => {
    const data = validInvite();
    delete (data as any).email;
    const err = new WorkspaceInvitation(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.email).toBeDefined();
  });

  it('requires role', () => {
    const data = validInvite();
    delete (data as any).role;
    const err = new WorkspaceInvitation(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  it('requires token', () => {
    const data = validInvite();
    delete (data as any).token;
    const err = new WorkspaceInvitation(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.token).toBeDefined();
  });

  it('requires expiresAt', () => {
    const data = validInvite();
    delete (data as any).expiresAt;
    const err = new WorkspaceInvitation(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('validates status enum', () => {
    const err = new WorkspaceInvitation({
      ...validInvite(),
      token: 'unique-token',
      email: 'unique@example.com',
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['pending', 'accepted', 'expired', 'revoked'];
    for (const status of statuses) {
      const invite = new WorkspaceInvitation({
        ...validInvite(),
        status,
      });
      const err = invite.validateSync();
      expect(err).toBeUndefined();
      expect(invite.status).toBe(status);
    }
  });

  it('enforces unique token', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await WorkspaceInvitation.create(validInvite());
    await expect(
      WorkspaceInvitation.create({
        ...validInvite(),
        email: 'other@example.com',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('enforces unique tenantId+email', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await WorkspaceInvitation.create(validInvite());
    await expect(
      WorkspaceInvitation.create({
        ...validInvite(),
        token: 'different-token',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

// ─── ArchiveManifest Model ──────────────────────────────────────────────────

describe('ArchiveManifest', () => {
  const validManifest = () => ({
    tenantId: 'tenant-1',
    type: 'sessions',
    recordCount: 10000,
    sizeBytes: 52428800,
    storageKey: 'archives/2025/01/sessions.parquet',
    checksum: 'sha256-xyz',
    format: 'parquet',
    dateRangeStart: new Date('2025-01-01'),
    dateRangeEnd: new Date('2025-02-01'),
  });

  it('sets default fields on instantiation', () => {
    const manifest = new ArchiveManifest(validManifest());
    expect(manifest._id).toBeDefined();
    expect(manifest.tenantId).toBe('tenant-1');
    expect(manifest.type).toBe('sessions');
    expect(manifest.recordCount).toBe(10000);
    expect(manifest.sizeBytes).toBe(52428800);
    expect(manifest.storageKey).toBe('archives/2025/01/sessions.parquet');
    expect(manifest.storageBucket).toBeNull();
    expect(manifest.region).toBeNull();
    expect(manifest.checksum).toBe('sha256-xyz');
    expect(manifest.format).toBe('parquet');
    expect(manifest.dateRangeStart).toBeInstanceOf(Date);
    expect(manifest.dateRangeEnd).toBeInstanceOf(Date);
    expect(manifest._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validManifest();
    delete (data as any).tenantId;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires type', () => {
    const data = validManifest();
    delete (data as any).type;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.type).toBeDefined();
  });

  it('requires recordCount', () => {
    const data = validManifest();
    delete (data as any).recordCount;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.recordCount).toBeDefined();
  });

  it('requires sizeBytes', () => {
    const data = validManifest();
    delete (data as any).sizeBytes;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sizeBytes).toBeDefined();
  });

  it('requires storageKey', () => {
    const data = validManifest();
    delete (data as any).storageKey;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.storageKey).toBeDefined();
  });

  it('requires checksum', () => {
    const data = validManifest();
    delete (data as any).checksum;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.checksum).toBeDefined();
  });

  it('requires format', () => {
    const data = validManifest();
    delete (data as any).format;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.format).toBeDefined();
  });

  it('requires dateRangeStart', () => {
    const data = validManifest();
    delete (data as any).dateRangeStart;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.dateRangeStart).toBeDefined();
  });

  it('requires dateRangeEnd', () => {
    const data = validManifest();
    delete (data as any).dateRangeEnd;
    const err = new ArchiveManifest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.dateRangeEnd).toBeDefined();
  });
});

// ─── OrgProxyConfig Model ──────────────────────────────────────────────────

describe('OrgProxyConfig', () => {
  const validProxy = () => ({
    tenantId: 'tenant-1',
    name: 'Corporate Proxy',
    proxyUrl: 'https://proxy.corp.com:8080',
    proxyAuthType: 'basic',
    urlPatterns: '*',
    environment: 'production',
    priority: 1,
    createdBy: 'user-1',
  });

  it('sets default fields on instantiation', () => {
    const proxy = new OrgProxyConfig(validProxy());
    expect(proxy._id).toBeDefined();
    expect(proxy.tenantId).toBe('tenant-1');
    expect(proxy.name).toBe('Corporate Proxy');
    expect(proxy.proxyUrl).toBe('https://proxy.corp.com:8080');
    expect(proxy.proxyAuthType).toBe('basic');
    expect(proxy.encryptedProxyUsername).toBeNull();
    expect(proxy.encryptedProxyPassword).toBeNull();
    expect(proxy.encryptedProxyToken).toBeNull();
    expect(proxy.encryptedCaCertificate).toBeNull();
    expect(proxy.encryptedClientCert).toBeNull();
    expect(proxy.encryptedClientKey).toBeNull();
    expect(proxy.urlPatterns).toBe('*');
    expect(proxy.bypassPatterns).toBeNull();
    expect(proxy.environment).toBe('production');
    expect(proxy.priority).toBe(1);
    expect(proxy.enabled).toBe(true);
    expect(proxy.createdBy).toBe('user-1');
    expect(proxy._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validProxy();
    delete (data as any).tenantId;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires name', () => {
    const data = validProxy();
    delete (data as any).name;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires proxyUrl', () => {
    const data = validProxy();
    delete (data as any).proxyUrl;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.proxyUrl).toBeDefined();
  });

  it('requires proxyAuthType', () => {
    const data = validProxy();
    delete (data as any).proxyAuthType;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.proxyAuthType).toBeDefined();
  });

  it('requires urlPatterns', () => {
    const data = validProxy();
    delete (data as any).urlPatterns;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.urlPatterns).toBeDefined();
  });

  it('requires environment', () => {
    const data = validProxy();
    delete (data as any).environment;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  it('requires priority', () => {
    const data = validProxy();
    delete (data as any).priority;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.priority).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validProxy();
    delete (data as any).createdBy;
    const err = new OrgProxyConfig(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  it('enforces unique tenantId+name+environment', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await OrgProxyConfig.create(validProxy());
    await expect(OrgProxyConfig.create(validProxy())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── ServiceNode Model ─────────────────────────────────────────────────────

describe('ServiceNode', () => {
  const validNode = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'payment-api',
    displayName: 'Payment API',
    endpoint: 'https://api.stripe.com/v1/charges',
    method: 'POST',
    authType: 'bearer',
    timeoutMs: 30000,
    retryCount: 3,
    retryDelayMs: 1000,
    circuitBreakerThreshold: 5,
    circuitBreakerResetMs: 60000,
    isActive: true,
  });

  it('sets default fields on instantiation', () => {
    const node = new ServiceNode(validNode());
    expect(node._id).toBeDefined();
    expect(node.tenantId).toBe('tenant-1');
    expect(node.projectId).toBe('proj-1');
    expect(node.name).toBe('payment-api');
    expect(node.displayName).toBe('Payment API');
    expect(node.description).toBeNull();
    expect(node.endpoint).toBe('https://api.stripe.com/v1/charges');
    expect(node.method).toBe('POST');
    expect(node.authType).toBe('bearer');
    expect(node.authConfig).toBeNull();
    expect(node.encryptedSecrets).toBeNull();
    expect(node.inputSchema).toBeNull();
    expect(node.outputSchema).toBeNull();
    expect(node.timeoutMs).toBe(30000);
    expect(node.retryCount).toBe(3);
    expect(node.retryDelayMs).toBe(1000);
    expect(node.rateLimitPerMinute).toBeNull();
    expect(node.rateLimitPerHour).toBeNull();
    expect(node.circuitBreakerThreshold).toBe(5);
    expect(node.circuitBreakerResetMs).toBe(60000);
    expect(node.isActive).toBe(true);
    expect(node._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validNode();
    delete (data as any).tenantId;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validNode();
    delete (data as any).projectId;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires name', () => {
    const data = validNode();
    delete (data as any).name;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires displayName', () => {
    const data = validNode();
    delete (data as any).displayName;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.displayName).toBeDefined();
  });

  it('requires endpoint', () => {
    const data = validNode();
    delete (data as any).endpoint;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.endpoint).toBeDefined();
  });

  it('requires method', () => {
    const data = validNode();
    delete (data as any).method;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.method).toBeDefined();
  });

  it('requires authType', () => {
    const data = validNode();
    delete (data as any).authType;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.authType).toBeDefined();
  });

  it('requires timeoutMs', () => {
    const data = validNode();
    delete (data as any).timeoutMs;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.timeoutMs).toBeDefined();
  });

  it('requires retryCount', () => {
    const data = validNode();
    delete (data as any).retryCount;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.retryCount).toBeDefined();
  });

  it('requires retryDelayMs', () => {
    const data = validNode();
    delete (data as any).retryDelayMs;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.retryDelayMs).toBeDefined();
  });

  it('requires circuitBreakerThreshold', () => {
    const data = validNode();
    delete (data as any).circuitBreakerThreshold;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.circuitBreakerThreshold).toBeDefined();
  });

  it('requires circuitBreakerResetMs', () => {
    const data = validNode();
    delete (data as any).circuitBreakerResetMs;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.circuitBreakerResetMs).toBeDefined();
  });

  it('requires isActive', () => {
    const data = validNode();
    delete (data as any).isActive;
    const err = new ServiceNode(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.isActive).toBeDefined();
  });

  it('enforces unique projectId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ServiceNode.create(validNode());
    await expect(ServiceNode.create(validNode())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── TenantTransfer Model ──────────────────────────────────────────────────

describe('TenantTransfer', () => {
  const validTransfer = () => ({
    tenantId: 'tenant-1',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    status: 'pending',
    initiatedBy: 'user-1',
    expiresAt: new Date(Date.now() + 604800000),
  });

  it('sets default fields on instantiation', () => {
    const transfer = new TenantTransfer(validTransfer());
    expect(transfer._id).toBeDefined();
    expect(transfer.tenantId).toBe('tenant-1');
    expect(transfer.sourceOrgId).toBe('org-1');
    expect(transfer.targetOrgId).toBe('org-2');
    expect(transfer.status).toBe('pending');
    expect(transfer.initiatedBy).toBe('user-1');
    expect(transfer.sourceApprovedBy).toBeNull();
    expect(transfer.sourceApprovedAt).toBeNull();
    expect(transfer.targetApprovedBy).toBeNull();
    expect(transfer.targetApprovedAt).toBeNull();
    expect(transfer.rejectedBy).toBeNull();
    expect(transfer.rejectedAt).toBeNull();
    expect(transfer.rejectionReason).toBeNull();
    expect(transfer.cancelledBy).toBeNull();
    expect(transfer.cancelledAt).toBeNull();
    expect(transfer.assetInventory).toBeNull();
    expect(transfer.transferOptions).toBeNull();
    expect(transfer.executionStartedAt).toBeNull();
    expect(transfer.executionCompletedAt).toBeNull();
    expect(transfer.executionError).toBeNull();
    expect(transfer.expiresAt).toBeInstanceOf(Date);
    expect(transfer.logs).toEqual([]);
    expect(transfer._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validTransfer();
    delete (data as any).tenantId;
    const err = new TenantTransfer(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires sourceOrgId', () => {
    const data = validTransfer();
    delete (data as any).sourceOrgId;
    const err = new TenantTransfer(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceOrgId).toBeDefined();
  });

  it('requires targetOrgId', () => {
    const data = validTransfer();
    delete (data as any).targetOrgId;
    const err = new TenantTransfer(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.targetOrgId).toBeDefined();
  });

  it('requires status', () => {
    const data = validTransfer();
    delete (data as any).status;
    const err = new TenantTransfer(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('requires initiatedBy', () => {
    const data = validTransfer();
    delete (data as any).initiatedBy;
    const err = new TenantTransfer(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.initiatedBy).toBeDefined();
  });

  it('requires expiresAt', () => {
    const data = validTransfer();
    delete (data as any).expiresAt;
    const err = new TenantTransfer(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('stores transfer logs', () => {
    const transfer = new TenantTransfer({
      ...validTransfer(),
      logs: [
        {
          id: 'log-1',
          action: 'initiated',
          performedBy: 'user-1',
          details: { reason: 'org merger' },
          createdAt: new Date(),
        },
      ],
    });
    expect(transfer.logs).toHaveLength(1);
    expect(transfer.logs[0].action).toBe('initiated');
    expect(transfer.logs[0].performedBy).toBe('user-1');
  });
});
