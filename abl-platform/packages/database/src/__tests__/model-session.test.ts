import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from './helpers/setup-mongo.js';
import { Session } from '../models/session.model.js';
import { Message } from '../models/message.model.js';
import { Contact } from '../models/contact.model.js';
import { Fact } from '../models/fact.model.js';
beforeAll(async () => {
  await setupTestMongo();
  await initTestDEKFacade('a'.repeat(64));
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Session Model ──────────────────────────────────────────────────────────

describe('Session', () => {
  const validSession = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    currentAgent: 'booking_agent',
    environment: 'production',
    channel: 'web',
    startedAt: new Date(),
    lastActivityAt: new Date(),
  });

  // ── Default values (no DB needed) ──────────────────────────────────────

  it('sets default fields on instantiation', () => {
    const session = new Session(validSession());
    expect(session._id).toBeDefined();
    expect(session.tenantId).toBe('tenant-1');
    expect(session.projectId).toBe('proj-1');
    expect(session.currentAgent).toBe('booking_agent');
    expect(session.environment).toBe('production');
    expect(session.channel).toBe('web');
    expect(session.contactId).toBeNull();
    expect(session.callerNumber).toBeNull();
    expect(session.initiatedById).toBeNull();
    expect(session.customerId).toBeNull();
    expect(session.anonymousId).toBeNull();
    expect(session.agentVersion).toBeNull();
    expect(session.entryAgentName).toBeNull();
    expect(session.workflowId).toBeNull();
    expect(session.workflowStepId).toBeNull();
    expect(session.parentId).toBeNull();
    expect(session.channelHistory).toEqual([]);
    expect(session.status).toBe('active');
    expect(session.disposition).toBeNull();
    expect(session.dispositionCode).toBeNull();
    expect(session.deploymentId).toBeNull();
    // Session._id is the canonical stored/public session identifier.
    expect(session.projectSlug).toBeNull();
    expect(session.region).toBeNull();
    expect(session.callDuration).toBeNull();
    expect(session.messageCount).toBe(0);
    expect(session.tokenCount).toBe(0);
    expect(session.estimatedCost).toBe(0);
    expect(session.errorCount).toBe(0);
    expect(session.handoffCount).toBe(0);
    expect(session.traceEventCount).toBe(0);
    expect(session.billingPeriod).toBeNull();
    expect(session.isTest).toBe(false);
    expect(session.tags).toEqual([]);
    expect(session.endedAt).toBeNull();
    expect(session.archivedAt).toBeNull();
    expect(session._v).toBe(1);
  });

  // ── Validation tests (no DB needed, use validateSync) ──────────────────

  it('requires tenantId', () => {
    const data = validSession();
    delete (data as any).tenantId;
    const err = new Session(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validSession();
    delete (data as any).projectId;
    const err = new Session(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires currentAgent', () => {
    const data = validSession();
    delete (data as any).currentAgent;
    const err = new Session(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.currentAgent).toBeDefined();
  });

  it('requires environment', () => {
    const data = validSession();
    delete (data as any).environment;
    const err = new Session(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  it('validates environment enum', () => {
    const err = new Session({ ...validSession(), environment: 'invalid' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  it('accepts valid environment values', () => {
    const envs = ['dev', 'staging', 'production'];
    for (const env of envs) {
      const doc = new Session({ ...validSession(), environment: env });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.environment).toBe(env);
    }
  });

  it('requires channel', () => {
    const data = validSession();
    delete (data as any).channel;
    const err = new Session(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.channel).toBeDefined();
  });

  it('validates channel enum', () => {
    const err = new Session({ ...validSession(), channel: 'invalid' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.channel).toBeDefined();
  });

  it('accepts valid channel values', () => {
    const channels = [
      'web',
      'web_chat',
      'web_debug',
      'voice',
      'sms',
      'whatsapp',
      'email',
      'api',
      'sdk',
    ];
    for (const ch of channels) {
      const doc = new Session({ ...validSession(), channel: ch });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.channel).toBe(ch);
    }
  });

  it('validates status enum', () => {
    const err = new Session({ ...validSession(), status: 'invalid' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['active', 'idle', 'ended', 'completed', 'escalated', 'abandoned', 'archived'];
    for (const status of statuses) {
      const doc = new Session({ ...validSession(), status });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.status).toBe(status);
    }
  });

  it('requires startedAt', () => {
    const data = validSession();
    delete (data as any).startedAt;
    const err = new Session(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.startedAt).toBeDefined();
  });

  it('requires lastActivityAt', () => {
    const data = validSession();
    delete (data as any).lastActivityAt;
    const err = new Session(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.lastActivityAt).toBeDefined();
  });

  // ── DB-dependent tests ─────────────────────────────────────────────────

  it('sets timestamps on creation', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const session = await Session.create(validSession());
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.updatedAt).toBeInstanceOf(Date);
  });
});

// ─── Message Model ──────────────────────────────────────────────────────────

describe('Message', () => {
  const validMessage = () => ({
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    role: 'user' as const,
    content: 'Hello, I need help',
    channel: 'web',
  });

  // ── Default values (no DB needed) ──────────────────────────────────────

  it('sets default fields on instantiation', () => {
    const msg = new Message(validMessage());
    expect(msg._id).toBeDefined();
    expect(msg.sessionId).toBe('session-1');
    expect(msg.tenantId).toBe('tenant-1');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello, I need help');
    expect(msg.channel).toBe('web');
    expect(msg.traceId).toBeNull();
    expect(msg.hasPII).toBe(false);
    expect(msg.scrubbed).toBe(false);
    expect(msg.encrypted).toBe(false);
    expect(msg.timestamp).toBeInstanceOf(Date);
    expect(msg.expiresAt).toBeNull();
    expect(msg.idempotencyKey).toBeUndefined();
    expect(msg._v).toBe(1);
  });

  // ── Validation tests (no DB needed, use validateSync) ──────────────────

  it('requires sessionId', () => {
    const data = validMessage();
    delete (data as any).sessionId;
    const err = new Message(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sessionId).toBeDefined();
  });

  it('requires tenantId', () => {
    const data = validMessage();
    delete (data as any).tenantId;
    const err = new Message(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires role', () => {
    const data = validMessage();
    delete (data as any).role;
    const err = new Message(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  it('validates role enum', () => {
    const err = new Message({ ...validMessage(), role: 'invalid' as any }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  it('accepts valid role values', () => {
    const roles = ['user', 'assistant', 'system', 'tool'] as const;
    for (const role of roles) {
      const doc = new Message({ ...validMessage(), role });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.role).toBe(role);
    }
  });

  it('requires content', () => {
    const data = validMessage();
    delete (data as any).content;
    const err = new Message(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.content).toBeDefined();
  });

  it('requires channel', () => {
    const data = validMessage();
    delete (data as any).channel;
    const err = new Message(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.channel).toBeDefined();
  });

  it('sets default timestamp', () => {
    const before = new Date();
    const msg = new Message(validMessage());
    const after = new Date();
    expect(msg.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(msg.timestamp.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  // ── DB-dependent tests ─────────────────────────────────────────────────

  it('enforces unique idempotencyKey when set', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Message.create({ ...validMessage(), idempotencyKey: 'key-1' });
    await expect(
      Message.create({
        ...validMessage(),
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('allows multiple messages without idempotencyKey', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Message.create(validMessage());
    const msg2 = await Message.create(validMessage());
    expect(msg2._id).toBeDefined();
  });
});

// ─── Contact Model ──────────────────────────────────────────────────────────

describe('Contact', () => {
  const validContact = () => ({
    tenantId: 'tenant-1',
    type: 'customer',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });

  // ── Default values (no DB needed) ──────────────────────────────────────

  it('sets default fields on instantiation', () => {
    const contact = new Contact(validContact());
    expect(contact._id).toBeDefined();
    expect(contact.tenantId).toBe('tenant-1');
    expect(contact.type).toBe('customer');
    expect(contact.identity).toBeNull();
    expect(contact.identityType).toBeNull();
    expect(contact.displayName).toBeNull();
    expect(contact.department).toBeNull();
    expect(contact.employeeId).toBeNull();
    expect(contact.company).toBeNull();
    expect(contact.accountRef).toBeNull();
    expect(contact.channel).toBeNull();
    expect(contact.metadata).toBeNull();
    expect(contact.tags).toEqual([]);
    expect(contact.deletedAt).toBeNull();
    expect(contact._v).toBe(1);
  });

  // ── Validation tests (no DB needed, use validateSync) ──────────────────

  it('requires tenantId', () => {
    const data = validContact();
    delete (data as any).tenantId;
    const err = new Contact(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires type', () => {
    const data = validContact();
    delete (data as any).type;
    const err = new Contact(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.type).toBeDefined();
  });

  it('validates type enum', () => {
    const err = new Contact({ ...validContact(), type: 'invalid' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.type).toBeDefined();
  });

  it('accepts valid type values', () => {
    const types = ['employee', 'customer', 'anonymous'];
    for (const type of types) {
      const doc = new Contact({ ...validContact(), type });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.type).toBe(type);
    }
  });

  it('validates identityType enum', () => {
    const err = new Contact({ ...validContact(), identityType: 'invalid' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.identityType).toBeDefined();
  });

  it('accepts valid identityType values', () => {
    const identityTypes = ['email', 'phone', 'external', null];
    for (const identityType of identityTypes) {
      const doc = new Contact({ ...validContact(), identityType });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.identityType).toBe(identityType);
    }
  });

  it('requires firstSeenAt', () => {
    const data = validContact();
    delete (data as any).firstSeenAt;
    const err = new Contact(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.firstSeenAt).toBeDefined();
  });

  it('requires lastSeenAt', () => {
    const data = validContact();
    delete (data as any).lastSeenAt;
    const err = new Contact(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.lastSeenAt).toBeDefined();
  });
});

// ─── Fact Model ─────────────────────────────────────────────────────────────

describe('Fact', () => {
  const validFact = () => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    projectId: 'proj-1',
    key: 'user.preference.language',
    value: '"en"',
    sourceType: 'agent',
  });

  // ── Default values (no DB needed) ──────────────────────────────────────

  it('sets default fields on instantiation', () => {
    const fact = new Fact(validFact());
    expect(fact._id).toBeDefined();
    expect(fact.key).toBe('user.preference.language');
    expect(fact.value).toBe('"en"');
    expect(fact.sourceType).toBe('agent');
    expect(fact.expiresAt).toBeNull();
    expect(fact.sourceAgentName).toBeNull();
    expect(fact.sourceSessionId).toBeNull();
    expect(fact.sourceTraceId).toBeNull();
    expect(fact.metadata).toBeNull();
    expect(fact._v).toBe(1);
  });

  it('stores expiresAt when provided', () => {
    const expiresAt = new Date(Date.now() + 3600000);
    const fact = new Fact({ ...validFact(), expiresAt });
    expect(fact.expiresAt).toEqual(expiresAt);
  });

  // ── Validation tests (no DB needed, use validateSync) ──────────────────

  it('requires key', () => {
    const err = new Fact({ value: 'v', sourceType: 's' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.key).toBeDefined();
  });

  it('requires value', () => {
    const err = new Fact({ key: 'k', sourceType: 's' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.value).toBeDefined();
  });

  it('requires sourceType', () => {
    const err = new Fact({ key: 'k', value: 'v' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceType).toBeDefined();
  });

  // ── DB-dependent tests ─────────────────────────────────────────────────

  it('enforces unique key', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Fact.create(validFact());
    await expect(Fact.create(validFact())).rejects.toThrow(/duplicate key/i);
  });
});
