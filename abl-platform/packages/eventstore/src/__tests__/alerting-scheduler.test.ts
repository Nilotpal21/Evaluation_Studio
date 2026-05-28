import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AlertScheduler } from '../alerting/alert-scheduler.js';
import { AlertNotifier } from '../alerting/alert-notifier.js';
import {
  MemoryAlertRuleStore,
  MemoryCooldownStore,
  MemoryMetricsReader,
} from '../alerting/memory-stores.js';
import type { AlertRule, IAlertNotifier } from '../alerting/interfaces.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockNotifier(): IAlertNotifier {
  return {
    notify: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  };
}

// =============================================================================
// ALERT SCHEDULER
// =============================================================================

describe('AlertScheduler', () => {
  let ruleStore: MemoryAlertRuleStore;
  let cooldownStore: MemoryCooldownStore;
  let metricsReader: MemoryMetricsReader;
  let notifier: IAlertNotifier;
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let scheduler: AlertScheduler;

  beforeEach(() => {
    ruleStore = new MemoryAlertRuleStore();
    cooldownStore = new MemoryCooldownStore();
    metricsReader = new MemoryMetricsReader();
    notifier = createMockNotifier();
    emitter = { emit: vi.fn() };
  });

  afterEach(async () => {
    if (scheduler) {
      await scheduler.stop();
    }
  });

  function createScheduler(): AlertScheduler {
    scheduler = new AlertScheduler({
      ruleStore,
      cooldownStore,
      metricsReader,
      notifier,
      emitter: emitter as unknown as import('../interfaces/event-emitter.js').IEventEmitter,
    });
    return scheduler;
  }

  // ─── Basic Evaluation ─────────────────────────────────────────────────

  describe('evaluateAll()', () => {
    it('does nothing when not running', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);
      const s = createScheduler();
      // Not started
      await s.evaluateAll();
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it('does nothing when no rules exist', async () => {
      const s = createScheduler();
      await s.start();
      await s.evaluateAll();
      expect(s.getStats().evaluationsRun).toBe(0);
    });

    it('evaluates a rule and fires when threshold breached', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().evaluationsRun).toBe(1);
      expect(s.getStats().alertsFired).toBe(1);
      expect(notifier.notify).toHaveBeenCalledOnce();
    });

    it('does not fire when metric is below threshold', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.05);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().evaluationsRun).toBe(1);
      expect(s.getStats().alertsFired).toBe(0);
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it('uses correct comparison operator from rule', async () => {
      await ruleStore.createRule(
        createRule({
          id: 'rule-lt',
          metric: 'success_rate',
          operator: 'lt',
          threshold: 0.95,
        }),
      );
      metricsReader.setMetric('tenant-a', 'project-a', 'success_rate', 0.8);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().alertsFired).toBe(1);
    });
  });

  // ─── Cooldown ──────────────────────────────────────────────────────────

  describe('cooldown', () => {
    it('skips evaluation when rule is in cooldown', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);
      await cooldownStore.setCooldown('rule-1', 600); // 10 min cooldown

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().alertsSkippedCooldown).toBe(1);
      expect(s.getStats().evaluationsRun).toBe(0);
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it('sets cooldown after firing', async () => {
      await ruleStore.createRule(createRule({ cooldownSeconds: 120 }));
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(await cooldownStore.isInCooldown('rule-1')).toBe(true);
    });

    it('clears cooldown on resolution', async () => {
      await ruleStore.createRule(createRule());
      // Set initial state to firing
      await cooldownStore.setAlertState('rule-1', 'firing');
      // Metric is now below threshold
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.05);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().alertsResolved).toBe(1);
      expect(await cooldownStore.isInCooldown('rule-1')).toBe(false);
    });
  });

  // ─── State Transitions ─────────────────────────────────────────────────

  describe('state transitions', () => {
    it('fires on ok → firing transition', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().alertsFired).toBe(1);
      expect(await cooldownStore.getAlertState('rule-1')).toBe('firing');
    });

    it('resolves on firing → resolved transition', async () => {
      await ruleStore.createRule(createRule());
      await cooldownStore.setAlertState('rule-1', 'firing');
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.05);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().alertsResolved).toBe(1);
      expect(await cooldownStore.getAlertState('rule-1')).toBe('resolved');
    });

    it('does not notify when still ok (no change)', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.05);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });

  // ─── Multiple Rules ────────────────────────────────────────────────────

  describe('multiple rules', () => {
    it('evaluates multiple rules independently', async () => {
      await ruleStore.createRule(
        createRule({ id: 'rule-1', metric: 'error_rate', threshold: 0.1 }),
      );
      await ruleStore.createRule(
        createRule({ id: 'rule-2', metric: 'latency', operator: 'gt', threshold: 5000 }),
      );

      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5); // breached
      metricsReader.setMetric('tenant-a', 'project-a', 'latency', 3000); // not breached

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().evaluationsRun).toBe(2);
      expect(s.getStats().alertsFired).toBe(1);
      expect(notifier.notify).toHaveBeenCalledOnce();
    });

    it('only evaluates enabled rules', async () => {
      await ruleStore.createRule(createRule({ id: 'rule-enabled' }));
      await ruleStore.createRule(createRule({ id: 'rule-disabled', enabled: false }));
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      // Only 1 rule evaluated (the enabled one)
      expect(s.getStats().evaluationsRun).toBe(1);
    });
  });

  // ─── Event Emission ────────────────────────────────────────────────────

  describe('event emission', () => {
    it('emits alert.firing event on threshold breach', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(emitter.emit).toHaveBeenCalled();
      const emittedEvent = emitter.emit.mock.calls[0][0] as Record<string, unknown>;
      expect(emittedEvent.event_type).toBe('alert.firing');
      expect(emittedEvent.tenant_id).toBe('tenant-a');
      expect(emittedEvent.project_id).toBe('project-a');

      const data = emittedEvent.data as Record<string, unknown>;
      expect(data.rule_id).toBe('rule-1');
      expect(data.severity).toBe('critical');
      expect(data.current_value).toBe(0.5);
    });

    it('emits alert.resolved event on recovery', async () => {
      await ruleStore.createRule(createRule());
      await cooldownStore.setAlertState('rule-1', 'firing');
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.05);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      const emittedEvent = emitter.emit.mock.calls[0][0] as Record<string, unknown>;
      expect(emittedEvent.event_type).toBe('alert.resolved');
    });
  });

  // ─── Notification Tracking ─────────────────────────────────────────────

  describe('notification tracking', () => {
    it('counts sent notifications', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().notificationsSent).toBe(1);
      expect(s.getStats().notificationsFailed).toBe(0);
    });

    it('counts failed notifications', async () => {
      notifier = {
        notify: vi.fn().mockResolvedValue({ sent: 0, failed: 1 }),
      };
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.evaluateAll();

      expect(s.getStats().notificationsFailed).toBe(1);
    });
  });

  // ─── Stats ─────────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('returns initial zero stats', () => {
      const s = createScheduler();
      expect(s.getStats()).toEqual({
        evaluationsRun: 0,
        alertsFired: 0,
        alertsResolved: 0,
        alertsSkippedCooldown: 0,
        notificationsSent: 0,
        notificationsFailed: 0,
      });
    });

    it('returns a copy (not the internal object)', () => {
      const s = createScheduler();
      const stats1 = s.getStats();
      stats1.evaluationsRun = 999;
      expect(s.getStats().evaluationsRun).toBe(0);
    });
  });

  // ─── Start / Stop ─────────────────────────────────────────────────────

  describe('start() and stop()', () => {
    it('stop prevents further evaluation', async () => {
      await ruleStore.createRule(createRule());
      metricsReader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);

      const s = createScheduler();
      await s.start();
      await s.stop();
      await s.evaluateAll();

      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// ALERT NOTIFIER
// =============================================================================

describe('AlertNotifier', () => {
  it('delivers to all channels', async () => {
    const deliveryFn = vi.fn().mockResolvedValue({ statusCode: 200, success: true });
    const notifier = new AlertNotifier({ deliveryFn });

    const rule = createRule({
      channels: [
        { type: 'webhook', url: 'https://hook1.example.com' },
        { type: 'webhook', url: 'https://hook2.example.com' },
      ],
    });

    const result = await notifier.notify(rule, {
      ruleId: 'rule-1',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      breached: true,
      metricValue: 0.5,
      threshold: 0.1,
      operator: 'gt',
      state: 'firing',
      previousState: 'ok',
      evaluatedAt: new Date(),
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(deliveryFn).toHaveBeenCalledTimes(2);
  });

  it('counts failed deliveries', async () => {
    const deliveryFn = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, success: true })
      .mockRejectedValueOnce(new Error('Connection refused'));

    const notifier = new AlertNotifier({ deliveryFn });
    const rule = createRule({
      channels: [
        { type: 'webhook', url: 'https://good.example.com' },
        { type: 'webhook', url: 'https://down.example.com' },
      ],
    });

    const result = await notifier.notify(rule, {
      ruleId: 'rule-1',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      breached: true,
      metricValue: 0.5,
      threshold: 0.1,
      operator: 'gt',
      state: 'firing',
      previousState: 'ok',
      evaluatedAt: new Date(),
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('includes rule context in webhook payload', async () => {
    const deliveryFn = vi.fn().mockResolvedValue({ statusCode: 200, success: true });
    const notifier = new AlertNotifier({ deliveryFn });

    const rule = createRule({ name: 'Error Spike', severity: 'warning' });
    await notifier.notify(rule, {
      ruleId: 'rule-1',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      breached: true,
      metricValue: 0.5,
      threshold: 0.1,
      operator: 'gt',
      state: 'firing',
      previousState: 'ok',
      evaluatedAt: new Date(),
    });

    const payload = deliveryFn.mock.calls[0][0].payload;
    expect(payload.rule_name).toBe('Error Spike');
    expect(payload.severity).toBe('warning');
    expect(payload.current_value).toBe(0.5);
    expect(payload.threshold).toBe(0.1);
    expect(payload.state).toBe('firing');
  });

  it('passes secret and headers to delivery function', async () => {
    const deliveryFn = vi.fn().mockResolvedValue({ statusCode: 200, success: true });
    const notifier = new AlertNotifier({ deliveryFn });

    const rule = createRule({
      channels: [
        {
          type: 'webhook',
          url: 'https://hook.example.com',
          secret: 'my-secret',
          headers: { 'X-Custom': 'value' },
        },
      ],
    });

    await notifier.notify(rule, {
      ruleId: 'rule-1',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      breached: true,
      metricValue: 0.5,
      threshold: 0.1,
      operator: 'gt',
      state: 'firing',
      previousState: 'ok',
      evaluatedAt: new Date(),
    });

    const call = deliveryFn.mock.calls[0][0];
    expect(call.secret).toBe('my-secret');
    expect(call.headers).toEqual({ 'X-Custom': 'value' });
  });
});

// =============================================================================
// MEMORY STORES
// =============================================================================

describe('MemoryAlertRuleStore', () => {
  let store: MemoryAlertRuleStore;

  beforeEach(() => {
    store = new MemoryAlertRuleStore();
  });

  it('creates and retrieves a rule', async () => {
    const rule = createRule();
    await store.createRule(rule);
    const retrieved = await store.getRule('tenant-a', 'rule-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('High Error Rate');
  });

  it('enforces tenant isolation on getRule', async () => {
    await store.createRule(createRule());
    const result = await store.getRule('tenant-b', 'rule-1');
    expect(result).toBeNull();
  });

  it('returns only active rules', async () => {
    await store.createRule(createRule({ id: 'r1', enabled: true }));
    await store.createRule(createRule({ id: 'r2', enabled: false }));
    const active = await store.getActiveRules('tenant-a', 'project-a');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('r1');
  });

  it('updates a rule', async () => {
    await store.createRule(createRule());
    await store.updateRule('tenant-a', 'rule-1', { name: 'Updated Name' });
    const rule = await store.getRule('tenant-a', 'rule-1');
    expect(rule!.name).toBe('Updated Name');
  });

  it('enforces tenant isolation on update', async () => {
    await store.createRule(createRule());
    await store.updateRule('tenant-b', 'rule-1', { name: 'Hacked' });
    const rule = await store.getRule('tenant-a', 'rule-1');
    expect(rule!.name).toBe('High Error Rate');
  });

  it('deletes a rule', async () => {
    await store.createRule(createRule());
    await store.deleteRule('tenant-a', 'rule-1');
    const rule = await store.getRule('tenant-a', 'rule-1');
    expect(rule).toBeNull();
  });

  it('enforces tenant isolation on delete', async () => {
    await store.createRule(createRule());
    await store.deleteRule('tenant-b', 'rule-1');
    const rule = await store.getRule('tenant-a', 'rule-1');
    expect(rule).not.toBeNull();
  });
});

describe('MemoryCooldownStore', () => {
  let store: MemoryCooldownStore;

  beforeEach(() => {
    store = new MemoryCooldownStore();
  });

  it('returns false when no cooldown set', async () => {
    expect(await store.isInCooldown('rule-1')).toBe(false);
  });

  it('returns true during cooldown', async () => {
    await store.setCooldown('rule-1', 60);
    expect(await store.isInCooldown('rule-1')).toBe(true);
  });

  it('clears cooldown', async () => {
    await store.setCooldown('rule-1', 60);
    await store.clearCooldown('rule-1');
    expect(await store.isInCooldown('rule-1')).toBe(false);
  });

  it('defaults alert state to ok', async () => {
    expect(await store.getAlertState('rule-1')).toBe('ok');
  });

  it('tracks alert state', async () => {
    await store.setAlertState('rule-1', 'firing');
    expect(await store.getAlertState('rule-1')).toBe('firing');
  });
});

describe('MemoryMetricsReader', () => {
  let reader: MemoryMetricsReader;

  beforeEach(() => {
    reader = new MemoryMetricsReader();
  });

  it('returns 0 for unknown metrics', async () => {
    const result = await reader.queryMetric({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      metric: 'nonexistent',
      window: { value: 1, unit: 'hours' },
    });
    expect(result.value).toBe(0);
  });

  it('returns set metric values', async () => {
    reader.setMetric('tenant-a', 'project-a', 'error_rate', 0.15);
    const result = await reader.queryMetric({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      metric: 'error_rate',
      window: { value: 1, unit: 'hours' },
    });
    expect(result.value).toBe(0.15);
  });

  it('scopes metrics by tenant and project', async () => {
    reader.setMetric('tenant-a', 'project-a', 'error_rate', 0.5);
    reader.setMetric('tenant-b', 'project-a', 'error_rate', 0.1);
    const result = await reader.queryMetric({
      tenantId: 'tenant-b',
      projectId: 'project-a',
      metric: 'error_rate',
      window: { value: 1, unit: 'hours' },
    });
    expect(result.value).toBe(0.1);
  });
});

// =============================================================================
// HELPER for creating rules (shared)
// =============================================================================

function createRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-1',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    name: 'High Error Rate',
    enabled: true,
    metric: 'error_rate',
    operator: 'gt',
    threshold: 0.1,
    window: { value: 1, unit: 'hours' },
    severity: 'critical',
    cooldownSeconds: 300,
    channels: [
      {
        type: 'webhook',
        url: 'https://hooks.example.com/alerts',
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
