/**
 * Escalation Integration Tests
 *
 * Tests the EscalationResolutionHandler with real HumanTask model (via MongoMemoryServer),
 * in-memory suspension store (DI-injected), and in-memory lock manager.
 *
 * These tests use direct DB operations because the handler itself operates on
 * Mongoose models — this is the integration boundary being tested.
 *
 * INT-1: Resolution with lock and atomic claim
 * INT-2: on_human_complete condition evaluation
 * INT-3: Resolution of already-completed escalation returns error
 * INT-4: Status query for existing and non-existing escalations
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type mongoose from 'mongoose';
import { EscalationResolutionHandler } from '../services/escalation/resolution-handler.js';
import type {
  EscalationResolution,
  EscalationResolutionHandlerDeps,
} from '../services/escalation/resolution-handler.js';
import type { LockPort } from '../services/execution/resumption-service.js';
import type { SuspensionStore, SuspendedExecution } from '@agent-platform/execution';
import { clearCollections, setupTestMongo, teardownTestMongo } from './helpers/setup-mongo.js';

// =============================================================================
// IN-MEMORY TEST DOUBLES (injected via DI, not vi.mock)
// =============================================================================

class InMemorySuspensionStore implements SuspensionStore {
  private suspensions: SuspendedExecution[] = [];

  async create(s: SuspendedExecution): Promise<void> {
    this.suspensions.push({ ...s });
  }

  async load(id: string): Promise<SuspendedExecution | null> {
    return this.suspensions.find((s) => s.suspensionId === id) ?? null;
  }

  async loadScoped(_t: string, id: string): Promise<SuspendedExecution | null> {
    return this.suspensions.find((s) => s.suspensionId === id) ?? null;
  }

  async loadByCallbackId(cbId: string): Promise<SuspendedExecution | null> {
    return this.suspensions.find((s) => s.callbackId === cbId) ?? null;
  }

  async claimForResume(id: string): Promise<boolean> {
    const found = this.suspensions.find((s) => s.suspensionId === id && s.status === 'suspended');
    if (found) {
      found.status = 'resuming';
      return true;
    }
    return false;
  }

  async releaseClaim(id: string): Promise<void> {
    const found = this.suspensions.find((s) => s.suspensionId === id);
    if (found) found.status = 'suspended';
  }

  async complete(id: string): Promise<void> {
    const found = this.suspensions.find((s) => s.suspensionId === id);
    if (found) {
      found.status = 'completed';
      found.completedAt = new Date();
    }
  }

  async fail(id: string, error: { code: string; message: string }): Promise<void> {
    const found = this.suspensions.find((s) => s.suspensionId === id);
    if (found) {
      found.status = 'failed';
      found.error = error;
    }
  }

  async expire(id: string): Promise<void> {
    const found = this.suspensions.find((s) => s.suspensionId === id);
    if (found) found.status = 'expired';
  }

  async cancel(id: string): Promise<void> {
    const found = this.suspensions.find((s) => s.suspensionId === id);
    if (found) found.status = 'cancelled';
  }

  async findByBarrier(): Promise<SuspendedExecution[]> {
    return [];
  }

  async findExpired(): Promise<SuspendedExecution[]> {
    return [];
  }

  async findBySession(sessionId: string): Promise<SuspendedExecution[]> {
    return this.suspensions.filter((s) => s.sessionId === sessionId);
  }

  async list(): Promise<SuspendedExecution[]> {
    return [];
  }

  getSuspension(id: string): SuspendedExecution | undefined {
    return this.suspensions.find((s) => s.suspensionId === id);
  }
}

class InMemoryLockPort implements LockPort {
  acquireCalled = false;
  releaseCalled = false;
  private shouldFail = false;

  setFailMode(fail: boolean): void {
    this.shouldFail = fail;
  }

  async acquire(key: string): Promise<{ key: string; owner: string } | null> {
    this.acquireCalled = true;
    if (this.shouldFail) return null;
    return { key, owner: 'test-owner' };
  }

  async release(): Promise<void> {
    this.releaseCalled = true;
  }

  async extend(): Promise<boolean> {
    return true;
  }
}

// =============================================================================
// SETUP
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let HumanTaskModel: mongoose.Model<any>;

beforeAll(async () => {
  await setupTestMongo();

  const mod = await import('@agent-platform/database/models');
  HumanTaskModel = mod.HumanTask;
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// =============================================================================
// HELPERS
// =============================================================================

const TEST_TENANT_ID = 'test-tenant-001';
const TEST_PROJECT_ID = 'test-project-001';
const TEST_SESSION_ID = 'test-session-001';

async function seedHumanTask(overrides?: Record<string, unknown>) {
  const doc = new HumanTaskModel({
    tenantId: TEST_TENANT_ID,
    projectId: TEST_PROJECT_ID,
    type: 'escalation',
    mailbox: 'agent',
    status: 'pending',
    priority: 'medium',
    title: 'Test escalation',
    description: 'Customer needs human assistance',
    source: {
      type: 'agent_escalation',
      sessionId: TEST_SESSION_ID,
      agentName: 'test-agent',
    },
    context: {
      on_human_complete: [
        { condition: 'decision == "resolved"', action: 'continue' },
        { condition: 'decision == "transfer"', action: 'handoff' },
        { condition: 'always', action: 'continue' },
      ],
    },
    escalationChain: [],
    currentEscalationLevel: 0,
    ...overrides,
  });
  await doc.save();
  return doc;
}

function buildHandler(overrides?: Partial<EscalationResolutionHandlerDeps>): {
  handler: EscalationResolutionHandler;
  suspensionStore: InMemorySuspensionStore;
  lockPort: InMemoryLockPort;
} {
  const suspensionStore = new InMemorySuspensionStore();
  const lockPort = new InMemoryLockPort();

  const handler = new EscalationResolutionHandler({
    humanTaskModel: HumanTaskModel,
    suspensionStore,
    lockManager: lockPort,
    ...overrides,
  });

  return { handler, suspensionStore, lockPort };
}

// =============================================================================
// TESTS
// =============================================================================

describe('EscalationResolutionHandler', () => {
  describe('handleResolution', () => {
    it('INT-1: resolves an escalation with lock and atomic claim', async () => {
      const task = await seedHumanTask();
      const { handler, suspensionStore, lockPort } = buildHandler();

      await suspensionStore.create({
        suspensionId: 'susp-001',
        executionId: 'exec-001',
        sessionId: TEST_SESSION_ID,
        tenantId: TEST_TENANT_ID,
        projectId: TEST_PROJECT_ID,
        reason: { type: 'escalation', humanTaskId: task._id },
        continuation: {
          type: 'escalation',
          escalationConfig: { on_human_complete: [] },
          humanTaskId: task._id,
        },
        channelBinding: { channelType: 'chat', tenantId: TEST_TENANT_ID },
        callbackId: 'cb-001',
        callbackSecret: '',
        status: 'suspended',
        suspendedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        resumeAttempts: 0,
      });

      const resolution: EscalationResolution = {
        decision: 'resolved',
        notes: 'Customer issue fixed',
        respondedBy: 'human-agent-001',
      };

      const result = await handler.handleResolution(
        TEST_SESSION_ID,
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
        resolution,
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('continue');
      expect(result.humanTaskId).toBe(task._id);

      expect(lockPort.acquireCalled).toBe(true);
      expect(lockPort.releaseCalled).toBe(true);

      const updatedTask = await HumanTaskModel.findOne({ _id: task._id }).lean();
      expect(updatedTask?.status).toBe('completed');
      expect(updatedTask?.response?.respondedBy).toBe('human-agent-001');
      expect(updatedTask?.response?.decision).toBe('resolved');

      const completedSuspension = suspensionStore.getSuspension('susp-001');
      expect(completedSuspension?.status).toBe('completed');
    });

    it('INT-2: evaluates on_human_complete conditions — first match wins', async () => {
      await seedHumanTask();
      const { handler } = buildHandler();

      const result = await handler.handleResolution(
        TEST_SESSION_ID,
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
        { decision: 'transfer', respondedBy: 'agent-002' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('handoff');
    });

    it('INT-2b: on_human_complete with no matching condition falls through to "always"', async () => {
      await seedHumanTask();
      const { handler } = buildHandler();

      const result = await handler.handleResolution(
        TEST_SESSION_ID,
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
        { decision: 'unknown_decision', respondedBy: 'agent-003' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('continue');
    });

    it('INT-2c: empty on_human_complete defaults to "continue"', async () => {
      await seedHumanTask({
        context: { on_human_complete: [] },
      });
      const { handler } = buildHandler();

      const result = await handler.handleResolution(
        TEST_SESSION_ID,
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
        { decision: 'anything', respondedBy: 'agent-004' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('continue');
    });

    it('INT-3: rejects resolution of already-completed escalation', async () => {
      await seedHumanTask({ status: 'completed' });
      const { handler } = buildHandler();

      const result = await handler.handleResolution(
        TEST_SESSION_ID,
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
        { decision: 'resolved', respondedBy: 'agent-005' },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ESCALATION_ALREADY_RESOLVED');
    });

    it('returns not found for non-existent escalation', async () => {
      const { handler } = buildHandler();

      const result = await handler.handleResolution(
        'nonexistent-session',
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
        { decision: 'resolved', respondedBy: 'agent-006' },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ESCALATION_NOT_FOUND');
    });

    it('enforces tenant isolation — cross-tenant returns not found', async () => {
      await seedHumanTask();
      const { handler } = buildHandler();

      const result = await handler.handleResolution(
        TEST_SESSION_ID,
        'other-tenant-id',
        TEST_PROJECT_ID,
        { decision: 'resolved', respondedBy: 'agent-007' },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ESCALATION_NOT_FOUND');
    });

    it('returns error when lock cannot be acquired', async () => {
      await seedHumanTask();
      const failingLockPort = new InMemoryLockPort();
      failingLockPort.setFailMode(true);

      const { handler } = buildHandler({ lockManager: failingLockPort });

      const result = await handler.handleResolution(
        TEST_SESSION_ID,
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
        { decision: 'resolved', respondedBy: 'agent-008' },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOCK_ACQUISITION_FAILED');
    });

    it('emits escalation_resolved trace event on success', async () => {
      await seedHumanTask();
      const traceEvents: Array<{
        sessionId: string;
        event: { type: string; data: Record<string, unknown> };
      }> = [];
      const { handler } = buildHandler({
        onTraceEvent: (sessionId, event) => {
          traceEvents.push({ sessionId, event });
        },
      });

      await handler.handleResolution(TEST_SESSION_ID, TEST_TENANT_ID, TEST_PROJECT_ID, {
        decision: 'resolved',
        respondedBy: 'agent-009',
      });

      const resolvedEvent = traceEvents.find((e) => e.event.type === 'escalation_resolved');
      expect(resolvedEvent).toBeDefined();
      expect(resolvedEvent?.sessionId).toBe(TEST_SESSION_ID);
      expect(resolvedEvent?.event.data.decision).toBe('resolved');
    });
  });

  describe('getStatus', () => {
    it('INT-4: returns status for existing escalation', async () => {
      const task = await seedHumanTask({
        connectorTicketId: 'INC001',
        connectorTicketUrl: 'https://itsm.example.com/INC001',
      });
      const { handler } = buildHandler();

      const result = await handler.getStatus(TEST_SESSION_ID, TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(result.success).toBe(true);
      expect(result.data?.humanTaskId).toBe(task._id);
      expect(result.data?.status).toBe('pending');
      expect(result.data?.priority).toBe('medium');
      expect(result.data?.connectorTicketId).toBe('INC001');
      expect(result.data?.connectorTicketUrl).toBe('https://itsm.example.com/INC001');
    });

    it('returns not found for non-existent escalation', async () => {
      const { handler } = buildHandler();

      const result = await handler.getStatus(
        'nonexistent-session',
        TEST_TENANT_ID,
        TEST_PROJECT_ID,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ESCALATION_NOT_FOUND');
    });

    it('enforces tenant isolation on status query', async () => {
      await seedHumanTask();
      const { handler } = buildHandler();

      const result = await handler.getStatus(TEST_SESSION_ID, 'other-tenant', TEST_PROJECT_ID);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ESCALATION_NOT_FOUND');
    });
  });
});
