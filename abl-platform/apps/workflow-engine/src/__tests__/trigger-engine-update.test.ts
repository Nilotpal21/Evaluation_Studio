/**
 * TriggerEngine.updateTrigger — characterization tests
 *
 * Exercises every branch of `TriggerEngine.updateTrigger` that route-level
 * mocks of the engine cannot reach: cron preset normalization (strict),
 * BullMQ reschedule + rollback, connector rewire + rollback, the
 * CONNECTOR_RUNTIME_UNAVAILABLE 503 path, and the audit-emitter contract on
 * both success and failure paths. None of these branches were covered by the
 * pre-existing route tests, which stub `updateTrigger` entirely.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TriggerEngine,
  summarizeTriggerError,
  type TriggerEngineDeps,
  type TriggerAuditEvent,
} from '../services/trigger-engine.js';

interface MemoryTrigger {
  _id: string;
  workflowId: string;
  tenantId: string;
  projectId: string;
  triggerType: string;
  status: string;
  config: Record<string, unknown>;
  cronExpression?: string;
}

/**
 * In-memory model + scheduler + connector stubs. Driven by deps injection
 * (constructor parameters) rather than `vi.mock` to honor the platform-mock
 * lint rule — no module-level mocks, and the same harness can swap individual
 * methods to simulate failure modes.
 */
function makeHarness(initial: MemoryTrigger) {
  const triggerStore = new Map<string, MemoryTrigger>([[initial._id, { ...initial }]]);
  const workflowUpdates: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
  }> = [];
  const auditEvents: TriggerAuditEvent[] = [];
  const schedulerCalls: Array<
    | { kind: 'scheduleCron'; id: string; cron: string; tz?: string }
    | { kind: 'scheduleOnce'; id: string; delayMs: number }
    | { kind: 'unschedule'; id: string }
  > = [];
  const connectorCalls: Array<
    | { kind: 'register'; input: Record<string, unknown> }
    | { kind: 'deregister'; id: string; strategy: string }
  > = [];

  const triggerModel: TriggerEngineDeps['triggerModel'] = {
    create: vi.fn().mockResolvedValue({ _id: initial._id }),
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      const doc = triggerStore.get(filter._id as string);
      if (!doc) return null;
      // Honor tenant scope — cross-tenant lookups behave like 404.
      if (doc.tenantId !== filter.tenantId) return null;
      return { ...doc };
    }),
    findOneAndUpdate: vi.fn(
      async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const id = filter._id as string;
        const doc = triggerStore.get(id);
        if (!doc) return null;
        const $set = (update.$set ?? {}) as Record<string, unknown>;
        const $unset = (update.$unset ?? {}) as Record<string, unknown>;
        const next: MemoryTrigger = { ...doc };
        for (const [k, v] of Object.entries($set)) {
          if (k === 'config') next.config = v as Record<string, unknown>;
          else (next as unknown as Record<string, unknown>)[k] = v;
        }
        for (const k of Object.keys($unset)) {
          delete (next as unknown as Record<string, unknown>)[k];
        }
        triggerStore.set(id, next);
        return next;
      },
    ),
  };

  const workflowModel: TriggerEngineDeps['workflowModel'] = {
    findOne: vi.fn().mockResolvedValue({
      _id: initial.workflowId,
      name: 'wf',
    }),
    findOneAndUpdate: vi.fn(
      async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        workflowUpdates.push({ filter, update });
        return { _id: initial.workflowId };
      },
    ),
  };

  return {
    triggerStore,
    workflowUpdates,
    auditEvents,
    schedulerCalls,
    connectorCalls,
    triggerModel,
    workflowModel,
    auditEmitter: (event: TriggerAuditEvent) => {
      auditEvents.push(event);
    },
    makeScheduler: (
      overrides: Partial<
        Pick<
          NonNullable<TriggerEngineDeps['scheduler']>,
          'scheduleCron' | 'scheduleOnce' | 'unschedule'
        >
      > = {},
    ): NonNullable<TriggerEngineDeps['scheduler']> =>
      ({
        scheduleCron: vi.fn(async (id: string, _data, cron: string, tz?: string) => {
          schedulerCalls.push({ kind: 'scheduleCron', id, cron, tz });
        }),
        scheduleOnce: vi.fn(async (id: string, _data, delayMs: number) => {
          schedulerCalls.push({ kind: 'scheduleOnce', id, delayMs });
        }),
        schedulePolling: vi.fn(async () => undefined),
        unschedule: vi.fn(async (id: string) => {
          schedulerCalls.push({ kind: 'unschedule', id });
        }),
        ...overrides,
      }) as unknown as NonNullable<TriggerEngineDeps['scheduler']>,
    makeConnector: (
      overrides: Partial<NonNullable<TriggerEngineDeps['connectorTriggerEngine']>> = {},
    ): NonNullable<TriggerEngineDeps['connectorTriggerEngine']> => ({
      registerTrigger: vi.fn(async (input) => {
        connectorCalls.push({
          kind: 'register',
          input: input as unknown as Record<string, unknown>,
        });
        return { triggerType: 'webhook' };
      }),
      deregisterTrigger: vi.fn(async (id: string, strategy: string) => {
        connectorCalls.push({ kind: 'deregister', id, strategy });
      }),
      ...overrides,
    }),
  };
}

function makeDeps(
  h: ReturnType<typeof makeHarness>,
  overrides: Partial<TriggerEngineDeps> = {},
): TriggerEngineDeps {
  return {
    triggerModel: h.triggerModel,
    workflowModel: h.workflowModel,
    restateClient: { startWorkflow: vi.fn().mockResolvedValue(undefined) },
    auditEmitter: h.auditEmitter,
    ...overrides,
  };
}

const baseCronTrigger: MemoryTrigger = {
  _id: 'reg-cron',
  workflowId: 'wf-1',
  tenantId: 't1',
  projectId: 'p1',
  triggerType: 'cron',
  status: 'active',
  config: { preset: 'daily', timezone: 'UTC', time: '09:00' },
  cronExpression: '0 9 * * *',
};

describe('TriggerEngine.updateTrigger — validation and cross-tenant scoping', () => {
  let h: ReturnType<typeof makeHarness>;
  let engine: TriggerEngine;

  beforeEach(() => {
    h = makeHarness(baseCronTrigger);
    engine = new TriggerEngine(makeDeps(h));
  });

  it('throws Trigger not found when registrationId does not exist', async () => {
    await expect(
      engine.updateTrigger('does-not-exist', { preset: 'daily' }, 't1', 'p1'),
    ).rejects.toThrow('Trigger not found');
  });

  it('returns 404-equivalent (Trigger not found) when tenantId mismatches', async () => {
    await expect(
      engine.updateTrigger('reg-cron', { preset: 'daily' }, 'other-tenant', 'p1'),
    ).rejects.toThrow('Trigger not found');
  });

  it('surfaces invalid time format as a validation error (strict mode)', async () => {
    await expect(
      engine.updateTrigger(
        'reg-cron',
        { preset: 'daily', timezone: 'UTC', time: '25:99' },
        't1',
        'p1',
      ),
    ).rejects.toThrow(/Invalid time format/);
  });

  it('surfaces invalid cron expression as a validation error (strict mode)', async () => {
    await expect(
      engine.updateTrigger(
        'reg-cron',
        { preset: 'cron', timezone: 'UTC', cronExpression: 'not-a-cron' },
        't1',
        'p1',
      ),
    ).rejects.toThrow(/Invalid cron expression/);
  });

  it('does NOT unschedule the existing job when validation fails (no silent stop)', async () => {
    const scheduler = h.makeScheduler();
    engine = new TriggerEngine(makeDeps(h, { scheduler }));
    await expect(
      engine.updateTrigger(
        'reg-cron',
        { preset: 'cron', timezone: 'UTC', cronExpression: 'bad' },
        't1',
        'p1',
      ),
    ).rejects.toThrow(/Invalid cron expression/);
    expect(scheduler.unschedule).not.toHaveBeenCalled();
    expect(h.triggerStore.get('reg-cron')?.config).toEqual(baseCronTrigger.config);
  });
});

describe('TriggerEngine.updateTrigger — cron happy path', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness(baseCronTrigger);
  });

  it('persists the new config and reschedules cron for active triggers', async () => {
    const scheduler = h.makeScheduler();
    const engine = new TriggerEngine(makeDeps(h, { scheduler }));
    await engine.updateTrigger(
      'reg-cron',
      { preset: 'weekly', timezone: 'UTC', time: '10:30', dayOfWeek: 3 },
      't1',
      'p1',
    );
    const persisted = h.triggerStore.get('reg-cron');
    expect(persisted?.config.preset).toBe('weekly');
    expect(persisted?.cronExpression).toBe('30 10 * * 3');
    // Stale schedule cleaned, new schedule wired.
    expect(h.schedulerCalls.some((c) => c.kind === 'unschedule')).toBe(true);
    const scheduled = h.schedulerCalls.find((c) => c.kind === 'scheduleCron') as
      | { kind: 'scheduleCron'; cron: string }
      | undefined;
    expect(scheduled?.cron).toBe('30 10 * * 3');
    // Denormalized workflow doc copy updated alongside the registration.
    expect(h.workflowUpdates.length).toBeGreaterThan(0);
    // Success audit emitted.
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.updated',
      registrationId: 'reg-cron',
      outcome: 'success',
    });
  });

  it('switches preset and removes the top-level cronExpression for once', async () => {
    const scheduler = h.makeScheduler();
    const engine = new TriggerEngine(makeDeps(h, { scheduler }));
    await engine.updateTrigger(
      'reg-cron',
      {
        preset: 'once',
        timezone: 'America/New_York',
        datetime: '2099-07-16T02:02',
      },
      't1',
      'p1',
    );
    const persisted = h.triggerStore.get('reg-cron');
    // Top-level cron string cleared so legacy readers can't fire the old schedule.
    expect(persisted?.cronExpression).toBeUndefined();
    // Schedule wired as a one-shot delay.
    expect(h.schedulerCalls.some((c) => c.kind === 'scheduleOnce')).toBe(true);
  });

  it('does NOT reschedule when the trigger is paused', async () => {
    h.triggerStore.set('reg-cron', { ...baseCronTrigger, status: 'paused' });
    const scheduler = h.makeScheduler();
    const engine = new TriggerEngine(makeDeps(h, { scheduler }));
    await engine.updateTrigger(
      'reg-cron',
      { preset: 'daily', timezone: 'UTC', time: '06:00' },
      't1',
      'p1',
    );
    // unschedule is always called to clear any lingering job; scheduleCron must not be.
    expect(h.schedulerCalls.find((c) => c.kind === 'scheduleCron')).toBeUndefined();
    expect(h.triggerStore.get('reg-cron')?.cronExpression).toBe('0 6 * * *');
  });
});

describe('TriggerEngine.updateTrigger — cron reschedule failure + rollback', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness(baseCronTrigger);
  });

  it('reverts DB config and re-establishes previous schedule when scheduleCron throws (rollback succeeds)', async () => {
    const scheduleCron = vi
      .fn<[string, Record<string, unknown>, string, string | undefined], Promise<void>>()
      .mockImplementationOnce(() => Promise.reject(new Error('redis blew up')))
      // Rollback call succeeds.
      .mockImplementationOnce(() => Promise.resolve());
    const scheduler = h.makeScheduler({ scheduleCron });
    const engine = new TriggerEngine(makeDeps(h, { scheduler }));

    await expect(
      engine.updateTrigger(
        'reg-cron',
        { preset: 'weekly', timezone: 'UTC', time: '10:30', dayOfWeek: 3 },
        't1',
        'p1',
      ),
    ).rejects.toThrow('redis blew up');

    // DB reverted to original config.
    const persisted = h.triggerStore.get('reg-cron');
    expect(persisted?.config).toEqual(baseCronTrigger.config);
    expect(persisted?.cronExpression).toBe(baseCronTrigger.cronExpression);
    // Status stays active because rollback restored the schedule.
    expect(persisted?.status).toBe('active');
    // Failure audit emitted.
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.update_failed',
      outcome: 'error',
      metadata: expect.objectContaining({ rollback: 'restored', reasonCode: expect.any(String) }),
    });
  });

  it('reverts DB and marks status=error when both schedule + rollback fail', async () => {
    const scheduleCron = vi
      .fn<[string, Record<string, unknown>, string, string | undefined], Promise<void>>()
      .mockRejectedValue(new Error('redis down'));
    const scheduler = h.makeScheduler({ scheduleCron });
    const engine = new TriggerEngine(makeDeps(h, { scheduler }));

    await expect(
      engine.updateTrigger(
        'reg-cron',
        { preset: 'weekly', timezone: 'UTC', time: '10:30', dayOfWeek: 3 },
        't1',
        'p1',
      ),
    ).rejects.toThrow('redis down');

    const persisted = h.triggerStore.get('reg-cron');
    expect(persisted?.config).toEqual(baseCronTrigger.config);
    expect(persisted?.status).toBe('error');
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.update_failed',
      outcome: 'error',
      metadata: expect.objectContaining({ rollback: 'failed' }),
    });
  });
});

describe('TriggerEngine.updateTrigger — connector-backed triggers', () => {
  const baseConnectorTrigger: MemoryTrigger = {
    _id: 'reg-conn',
    workflowId: 'wf-1',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'webhook',
    status: 'active',
    config: {
      connectorName: 'gmail',
      triggerName: 'new_email',
      connectionId: 'conn-abc',
      triggerParams: { label: 'Inbox' },
    },
  };

  it('rewires the provider (deregister old, register new) and persists config on success', async () => {
    const h = makeHarness(baseConnectorTrigger);
    const connector = h.makeConnector();
    const engine = new TriggerEngine(makeDeps(h, { connectorTriggerEngine: connector }));

    await engine.updateTrigger(
      'reg-conn',
      {
        connectorName: 'gmail',
        triggerName: 'new_email',
        connectionId: 'conn-abc',
        triggerParams: { label: 'Updates' },
      },
      't1',
      'p1',
    );

    // Exactly one deregister of the old wiring followed by one register of the new.
    expect(h.connectorCalls[0]).toMatchObject({ kind: 'deregister' });
    expect(h.connectorCalls[1]).toMatchObject({ kind: 'register' });
    expect(h.triggerStore.get('reg-conn')?.config.triggerParams).toEqual({ label: 'Updates' });
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.updated',
      outcome: 'success',
      metadata: expect.objectContaining({ connectorBacked: true }),
    });
    // F-2 boundary: the wider `config` blob (incl. webhook-display fields like
    // `callbackAccessToken`) must NOT be forwarded to the connector engine's
    // register call. Only the typed named params survive.
    const registerCall = h.connectorCalls.find((c) => c.kind === 'register');
    expect(registerCall).toBeDefined();
    if (registerCall?.kind === 'register') {
      expect(registerCall.input.config).toBeUndefined();
    }
  });

  it('strips non-connector keys from the rollback re-register call (F-2)', async () => {
    const h = makeHarness({
      ...baseConnectorTrigger,
      config: {
        ...baseConnectorTrigger.config,
        callbackUrl: 'https://customer/cb',
        callbackAccessToken: 'display-token-do-not-forward',
      },
    });
    const registerTrigger = vi
      .fn<[Record<string, unknown>], Promise<{ triggerType: string }>>()
      .mockRejectedValueOnce(new Error('provider 502'))
      .mockResolvedValueOnce({ triggerType: 'webhook' });
    const connector = h.makeConnector({ registerTrigger });
    const engine = new TriggerEngine(makeDeps(h, { connectorTriggerEngine: connector }));

    await expect(
      engine.updateTrigger(
        'reg-conn',
        { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'conn-abc-new' },
        't1',
        'p1',
      ),
    ).rejects.toThrow('provider 502');

    // Rollback register call MUST also strip the display token, even though it
    // re-registers with the previous `existingConfig` (which carries the token).
    const registerCalls = h.connectorCalls.filter((c) => c.kind === 'register');
    for (const c of registerCalls) {
      if (c.kind !== 'register') continue;
      expect(c.input.config).toBeUndefined();
      // Belt-and-braces: explicitly assert the token literal is absent from
      // every property of the register call's input. Catches a future change
      // that might add a new pass-through field carrying the value.
      const serialized = JSON.stringify(c.input);
      expect(serialized).not.toContain('display-token-do-not-forward');
    }
  });

  it('rolls back to previous config (and keeps status active) when register fails but rollback re-register succeeds', async () => {
    const h = makeHarness(baseConnectorTrigger);
    const registerTrigger = vi
      .fn<[Record<string, unknown>], Promise<{ triggerType: string }>>()
      .mockRejectedValueOnce(new Error('provider 502'))
      .mockResolvedValueOnce({ triggerType: 'webhook' });
    const connector = h.makeConnector({ registerTrigger });
    const engine = new TriggerEngine(makeDeps(h, { connectorTriggerEngine: connector }));

    await expect(
      engine.updateTrigger(
        'reg-conn',
        { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'conn-abc-new' },
        't1',
        'p1',
      ),
    ).rejects.toThrow('provider 502');

    // DB config was never overwritten (provider rewire failed before the persist step).
    expect(h.triggerStore.get('reg-conn')?.config.connectionId).toBe('conn-abc');
    expect(h.triggerStore.get('reg-conn')?.status).toBe('active');
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.update_failed',
      outcome: 'error',
      metadata: expect.objectContaining({ rollback: 'restored', reasonCode: expect.any(String) }),
    });
  });

  it('marks status=error when both provider register AND rollback re-register fail', async () => {
    const h = makeHarness(baseConnectorTrigger);
    const registerTrigger = vi
      .fn<[Record<string, unknown>], Promise<{ triggerType: string }>>()
      .mockRejectedValueOnce(new Error('provider 502'))
      .mockRejectedValueOnce(new Error('provider still 502'));
    const connector = h.makeConnector({ registerTrigger });
    const engine = new TriggerEngine(makeDeps(h, { connectorTriggerEngine: connector }));

    await expect(
      engine.updateTrigger(
        'reg-conn',
        { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'conn-abc-new' },
        't1',
        'p1',
      ),
    ).rejects.toThrow('provider 502');

    expect(h.triggerStore.get('reg-conn')?.status).toBe('error');
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.update_failed',
      outcome: 'error',
      metadata: expect.objectContaining({ rollback: 'failed', connectorBacked: true }),
    });
  });

  it('throws CONNECTOR_RUNTIME_UNAVAILABLE and emits a failure audit when connectorTriggerEngine is not wired', async () => {
    const h = makeHarness(baseConnectorTrigger);
    // No connectorTriggerEngine in deps.
    const engine = new TriggerEngine(makeDeps(h));

    await expect(
      engine.updateTrigger(
        'reg-conn',
        { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'conn-x' },
        't1',
        'p1',
      ),
    ).rejects.toThrow('CONNECTOR_RUNTIME_UNAVAILABLE');

    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.update_failed',
      outcome: 'error',
      metadata: expect.objectContaining({ reason: 'CONNECTOR_RUNTIME_UNAVAILABLE' }),
    });
  });
});

describe('summarizeTriggerError — F-3 audit reason sanitization', () => {
  it('returns err.name as the reasonCode by default', () => {
    class TimeoutError extends Error {
      override name = 'TimeoutError';
    }
    const out = summarizeTriggerError(new TimeoutError('upstream timeout'));
    expect(out.code).toBe('TimeoutError');
    expect(out.message).toBe('upstream timeout');
  });

  it('prefers err.code when present (Node SystemError shape)', () => {
    const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const out = summarizeTriggerError(err);
    expect(out.code).toBe('ECONNREFUSED');
    expect(out.message).toBe('connection refused');
  });

  it('falls back to ERROR when name is the default Error class', () => {
    const out = summarizeTriggerError(new Error('plain error'));
    expect(out.code).toBe('ERROR');
    expect(out.message).toBe('plain error');
  });

  it('redacts Bearer-token substrings from the message', () => {
    const out = summarizeTriggerError(
      new Error('upstream rejected: Bearer abc123XYZ_secret-token-do-not-leak with status 401'),
    );
    expect(out.message).not.toContain('abc123XYZ_secret-token-do-not-leak');
    expect(out.message).toContain('Bearer [REDACTED]');
  });

  it('redacts Bearer in non-Error throws too (defensive)', () => {
    const out = summarizeTriggerError('Bearer secret123abcDEF');
    expect(out.code).toBe('ERROR');
    expect(out.message).toContain('Bearer [REDACTED]');
    expect(out.message).not.toContain('secret123abcDEF');
  });
});

describe('TriggerEngine.updateTrigger — F-3 audit emission never carries bearer tokens', () => {
  it('redacts Bearer-shaped substrings in connector rollback failure audit metadata', async () => {
    const h = makeHarness({
      _id: 'reg-conn-token',
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      triggerType: 'webhook',
      status: 'active',
      config: {
        connectorName: 'gmail',
        triggerName: 'new_email',
        connectionId: 'conn-abc',
      },
    });
    const registerTrigger = vi
      .fn<[Record<string, unknown>], Promise<{ triggerType: string }>>()
      .mockRejectedValue(
        new Error('upstream auth failed: Bearer leak-this-token-zxc987 returned 401'),
      );
    const connector = h.makeConnector({ registerTrigger });
    const engine = new TriggerEngine(makeDeps(h, { connectorTriggerEngine: connector }));

    await expect(
      engine.updateTrigger(
        'reg-conn-token',
        { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'conn-new' },
        't1',
        'p1',
      ),
    ).rejects.toThrow();

    const failed = h.auditEvents.find((e) => e.action === 'trigger.update_failed');
    expect(failed).toBeDefined();
    const serialized = JSON.stringify(failed?.metadata ?? {});
    expect(serialized).not.toContain('leak-this-token-zxc987');
    expect(serialized).toContain('Bearer [REDACTED]');
    expect(failed?.metadata?.reasonCode).toBe('ERROR');
  });
});

describe('TriggerEngine.updateTrigger — webhook config patch semantics', () => {
  const baseWebhook: MemoryTrigger = {
    _id: 'reg-hook',
    workflowId: 'wf-1',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'webhook',
    status: 'active',
    config: {
      callbackUrl: 'https://customer.example/cb',
      callbackAccessToken: 'secret-existing',
    },
  };

  it('preserves existing callbackAccessToken when the patch omits the token field', async () => {
    const h = makeHarness(baseWebhook);
    const engine = new TriggerEngine(makeDeps(h));
    await engine.updateTrigger(
      'reg-hook',
      { callbackUrl: 'https://customer.example/cb-v2' },
      't1',
      'p1',
    );
    const persisted = h.triggerStore.get('reg-hook');
    expect(persisted?.config.callbackUrl).toBe('https://customer.example/cb-v2');
    expect(persisted?.config.callbackAccessToken).toBe('secret-existing');
  });

  it('clears callbackUrl AND callbackAccessToken when callbackUrl is set to ""', async () => {
    const h = makeHarness(baseWebhook);
    const engine = new TriggerEngine(makeDeps(h));
    await engine.updateTrigger('reg-hook', { callbackUrl: '' }, 't1', 'p1');
    const persisted = h.triggerStore.get('reg-hook');
    expect(persisted?.config.callbackUrl).toBeUndefined();
    expect(persisted?.config.callbackAccessToken).toBeUndefined();
  });
});
