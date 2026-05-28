import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { TriggerRegistration } from '../models/trigger-registration.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validTrigger = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  workflowId: 'wf-1',
  connectorName: 'slack',
  triggerName: 'new_message',
  triggerType: 'webhook' as const,
  connectionId: 'conn-1',
});

describe('TriggerRegistration', () => {
  it('sets default fields on instantiation', () => {
    const trigger = new TriggerRegistration(validTrigger());
    expect(trigger._id).toBeDefined();
    expect(trigger.tenantId).toBe('tenant-1');
    expect(trigger.projectId).toBe('proj-1');
    expect(trigger.workflowId).toBe('wf-1');
    expect(trigger.connectorName).toBe('slack');
    expect(trigger.triggerName).toBe('new_message');
    expect(trigger.triggerType).toBe('webhook');
    expect(trigger.connectionId).toBe('conn-1');
    expect(trigger.config).toEqual({});
    expect(trigger.status).toBe('active');
    expect(trigger.consecutiveErrors).toBe(0);
  });

  it('requires tenantId', () => {
    const data = validTrigger();
    delete (data as any).tenantId;
    const err = new TriggerRegistration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validTrigger();
    delete (data as any).projectId;
    const err = new TriggerRegistration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires workflowId', () => {
    const data = validTrigger();
    delete (data as any).workflowId;
    const err = new TriggerRegistration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.workflowId).toBeDefined();
  });

  it('allows optional connectorName', () => {
    const data = validTrigger();
    delete (data as any).connectorName;
    const err = new TriggerRegistration(data).validateSync();
    expect(err).toBeUndefined();
  });

  it('requires triggerName', () => {
    const data = validTrigger();
    delete (data as any).triggerName;
    const err = new TriggerRegistration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggerName).toBeDefined();
  });

  it('requires triggerType', () => {
    const data = validTrigger();
    delete (data as any).triggerType;
    const err = new TriggerRegistration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggerType).toBeDefined();
  });

  it('allows optional connectionId', () => {
    const data = validTrigger();
    delete (data as any).connectionId;
    const err = new TriggerRegistration(data).validateSync();
    expect(err).toBeUndefined();
  });

  it('validates triggerType enum', () => {
    const err = new TriggerRegistration({
      ...validTrigger(),
      triggerType: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggerType).toBeDefined();
  });

  it('accepts valid triggerType values', () => {
    for (const triggerType of ['webhook', 'cron', 'event']) {
      const err = new TriggerRegistration({ ...validTrigger(), triggerType }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('validates status enum', () => {
    const err = new TriggerRegistration({
      ...validTrigger(),
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    for (const status of ['active', 'paused', 'error']) {
      const trigger = new TriggerRegistration({ ...validTrigger(), status });
      const err = trigger.validateSync();
      expect(err).toBeUndefined();
      expect(trigger.status).toBe(status);
    }
  });

  it('validates missedFirePolicy enum', () => {
    const err = new TriggerRegistration({
      ...validTrigger(),
      missedFirePolicy: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.missedFirePolicy).toBeDefined();
  });

  it('accepts valid missedFirePolicy values', () => {
    for (const policy of ['fire_once', 'fire_all', 'skip']) {
      const err = new TriggerRegistration({
        ...validTrigger(),
        missedFirePolicy: policy,
      }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('stores webhook fields', () => {
    const trigger = new TriggerRegistration({
      ...validTrigger(),
      webhookUrl: 'https://hooks.example.com/abc',
      webhookSecret: 'hmac-secret-123',
    });
    expect(trigger.webhookUrl).toBe('https://hooks.example.com/abc');
    expect(trigger.webhookSecret).toBe('hmac-secret-123');
  });

  it('stores polling fields', () => {
    const trigger = new TriggerRegistration({
      ...validTrigger(),
      triggerType: 'cron',
      pollingIntervalMs: 60000,
      bullmqJobId: 'job-abc',
    });
    expect(trigger.pollingIntervalMs).toBe(60000);
    expect(trigger.bullmqJobId).toBe('job-abc');
  });

  it('stores cron fields', () => {
    const trigger = new TriggerRegistration({
      ...validTrigger(),
      triggerType: 'cron',
      cronExpression: '0 * * * *',
      missedFirePolicy: 'fire_once',
    });
    expect(trigger.cronExpression).toBe('0 * * * *');
    expect(trigger.missedFirePolicy).toBe('fire_once');
  });

  it('stores health tracking fields', () => {
    const now = new Date();
    const trigger = new TriggerRegistration({
      ...validTrigger(),
      lastFiredAt: now,
      lastErrorAt: now,
      consecutiveErrors: 3,
    });
    expect(trigger.lastFiredAt).toEqual(now);
    expect(trigger.lastErrorAt).toEqual(now);
    expect(trigger.consecutiveErrors).toBe(3);
  });

  it('persists and retrieves from database', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const doc = await TriggerRegistration.create(validTrigger());
    const found = await TriggerRegistration.findOne({ _id: doc._id, tenantId: 'tenant-1' });
    expect(found).toBeDefined();
    expect(found!.connectorName).toBe('slack');
    expect(found!.triggerName).toBe('new_message');
  });
});
