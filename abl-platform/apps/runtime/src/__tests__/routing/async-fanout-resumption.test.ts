import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BranchResult,
  CallbackRegistry,
  FanOutBarrierStore,
  ResumeData,
  SuspendedExecution,
} from '@agent-platform/execution';
import { getFanOutContinuationOwner } from '@agent-platform/execution';
import { MemorySuspensionStore } from '../../services/execution/memory-suspension-store.js';
import { ResumptionService } from '../../services/execution/resumption-service.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import {
  buildParentResumeSuspensionContract,
  buildRemoteBranchSuspensionContract,
} from '../../services/execution/fanout/async-fanout-coordinator.js';
import {
  startSuspensionTimeoutWorker,
  stopSuspensionTimeoutWorker,
} from '../../services/queues/suspension-timeout-worker.js';

function createSession(): RuntimeSession {
  const parentState = {
    gatherProgress: {},
    conversationPhase: 'active',
    context: {},
    activeAgent: {
      name: 'SupervisorAgent',
      mode: 'reasoning',
    },
  };
  const parentData = {
    values: {},
    gatheredKeys: new Set<string>(),
  };

  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentName: 'SupervisorAgent',
    agentIR: { name: 'SupervisorAgent', type: 'reasoning' } as any,
    compilationOutput: null,
    conversationHistory: [],
    state: parentState,
    data: parentData,
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    threads: [
      {
        agentName: 'SupervisorAgent',
        agentIR: { name: 'SupervisorAgent', type: 'reasoning' } as any,
        conversationHistory: [],
        state: parentState,
        data: parentData,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
      {
        agentName: 'RemoteShippingAgent',
        agentIR: { name: 'RemoteShippingAgent', type: 'reasoning' } as any,
        conversationHistory: [],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        data: {
          values: {
            _fan_out_branch_id: 'branch-1',
          },
          gatheredKeys: new Set<string>(),
        },
        startedAt: Date.now(),
        returnExpected: false,
        status: 'waiting',
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  };
}

function createChannelBinding() {
  return {
    channelType: 'web_debug',
    tenantId: 'tenant-1',
    wsSessionId: 'session-1',
  };
}

function createParentSuspension(): SuspendedExecution {
  const contract = buildParentResumeSuspensionContract({
    barrierId: 'barrier-1',
    parentThreadIndex: 0,
    parentExecutionId: 'exec-1',
    callbackId: 'parent-callback',
    timeoutSeconds: 660,
  });

  return {
    suspensionId: 'parent-suspension',
    executionId: 'exec-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    reason: contract.reason,
    continuation: contract.continuation,
    channelBinding: createChannelBinding(),
    callbackId: contract.reason.callbackId,
    callbackSecret: '',
    barrierId: 'barrier-1',
    status: 'suspended',
    suspendedAt: new Date(),
    expiresAt: new Date(Date.now() + 660_000),
    resumeAttempts: 0,
  };
}

function createRemoteBranchSuspension(): SuspendedExecution {
  const contract = buildRemoteBranchSuspensionContract({
    branch: {
      branchId: 'branch-1',
      targetAgent: 'RemoteShippingAgent',
      threadIndex: 1,
    },
    barrierId: 'barrier-1',
    parentExecutionId: 'exec-1',
    callbackId: 'remote-callback',
    timeoutSeconds: 600,
  });

  return {
    suspensionId: 'branch-suspension',
    executionId: 'remote-task-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    reason: contract.reason,
    continuation: contract.continuation,
    channelBinding: createChannelBinding(),
    callbackId: contract.reason.callbackId,
    callbackSecret: 'secret',
    barrierId: 'barrier-1',
    status: 'suspended',
    suspendedAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    resumeAttempts: 0,
  };
}

function createLegacyBranchSuspension(): SuspendedExecution {
  return {
    suspensionId: 'legacy-branch-suspension',
    executionId: 'legacy-task-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    reason: {
      type: 'fan_out_branch',
      target: 'LegacyAgent',
      barrierId: 'barrier-1',
      callbackId: 'legacy-callback',
      timeout: 600,
    },
    continuation: {
      type: 'fan_out_branch',
      barrierId: 'barrier-1',
      branchAgent: 'LegacyAgent',
      threadIndex: 1,
      parentExecutionId: 'exec-legacy',
    },
    channelBinding: createChannelBinding(),
    callbackId: 'legacy-callback',
    callbackSecret: 'legacy-secret',
    barrierId: 'barrier-1',
    status: 'suspended',
    suspendedAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    resumeAttempts: 0,
  };
}

describe('async fan-out continuation contract', () => {
  it('builds remote branch suspension contracts with the new dedicated continuation type', () => {
    const contract = buildRemoteBranchSuspensionContract({
      branch: {
        branchId: 'branch-1',
        targetAgent: 'Remote_Billing_Agent',
        threadIndex: 2,
      },
      barrierId: 'barrier-1',
      parentExecutionId: 'parent-exec-1',
      callbackId: 'callback-1',
      timeoutSeconds: 600,
    });

    expect(contract.reason).toEqual({
      type: 'fan_out_remote_branch',
      target: 'Remote_Billing_Agent',
      barrierId: 'barrier-1',
      branchId: 'branch-1',
      callbackId: 'callback-1',
      timeout: 600,
    });
    expect(contract.continuation).toEqual({
      type: 'fan_out_remote_branch',
      barrierId: 'barrier-1',
      branchId: 'branch-1',
      branchAgent: 'Remote_Billing_Agent',
      threadIndex: 2,
      parentExecutionId: 'parent-exec-1',
    });
    expect(getFanOutContinuationOwner(contract.continuation)).toBe('remote_branch');
  });

  it('builds parent resume suspension contracts with a dedicated parent continuation type', () => {
    const contract = buildParentResumeSuspensionContract({
      barrierId: 'barrier-2',
      parentThreadIndex: 0,
      parentExecutionId: 'parent-exec-2',
      callbackId: 'callback-2',
      timeoutSeconds: 600,
    });

    expect(contract.reason).toEqual({
      type: 'fan_out_parent_resume',
      barrierId: 'barrier-2',
      callbackId: 'callback-2',
      timeout: 600,
    });
    expect(contract.continuation).toEqual({
      type: 'fan_out_parent_resume',
      barrierId: 'barrier-2',
      parentThreadIndex: 0,
      parentExecutionId: 'parent-exec-2',
    });
    expect(getFanOutContinuationOwner(contract.continuation)).toBe('parent_resume');
  });

  it('keeps the legacy fan_out_branch continuation classified as compatibility-only', () => {
    expect(getFanOutContinuationOwner(createLegacyBranchSuspension().continuation as any)).toBe(
      'legacy',
    );
  });
});

describe('async fan-out resumption flow', () => {
  let suspensionStore: MemorySuspensionStore;
  let currentSession: RuntimeSession;
  let executor: {
    executeMessage: ReturnType<typeof vi.fn>;
    rehydrateSession: ReturnType<typeof vi.fn>;
    saveSessionSnapshot: ReturnType<typeof vi.fn>;
  };
  let barrierStore: FanOutBarrierStore & {
    completeBranch: ReturnType<typeof vi.fn>;
    getResults: ReturnType<typeof vi.fn>;
    getParentSuspension: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let callbackRegistry: CallbackRegistry;
  let channelDispatcher: { deliver: ReturnType<typeof vi.fn> };
  let resumeDispatcher: { enqueueResume: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquire: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    extend: ReturnType<typeof vi.fn>;
  };
  let service: ResumptionService;

  beforeEach(async () => {
    suspensionStore = new MemorySuspensionStore();
    currentSession = createSession();
    executor = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'resumed',
        action: { type: 'respond' },
      }),
      rehydrateSession: vi.fn().mockImplementation(async () => currentSession),
      saveSessionSnapshot: vi.fn().mockImplementation(async (session: RuntimeSession) => {
        currentSession = session;
      }),
    };
    barrierStore = {
      create: vi.fn(),
      completeBranch: vi.fn(),
      get: vi.fn(),
      getResults: vi.fn(),
      setParentSuspension: vi.fn(),
      getParentSuspension: vi.fn(),
      cancel: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof barrierStore;
    callbackRegistry = {
      register: vi.fn(),
      lookup: vi.fn(),
      claim: vi.fn(),
      remove: vi.fn(),
    };
    channelDispatcher = {
      deliver: vi.fn().mockResolvedValue(undefined),
    };
    resumeDispatcher = {
      enqueueResume: vi.fn().mockResolvedValue(undefined),
    };
    lockManager = {
      acquire: vi.fn().mockResolvedValue({ key: 'lock:session-1', owner: 'worker-1' }),
      release: vi.fn().mockResolvedValue(undefined),
      extend: vi.fn().mockResolvedValue(true),
    };

    service = new ResumptionService({
      suspensionStore,
      callbackRegistry,
      barrierStore,
      channelDispatcher: channelDispatcher as any,
      executor,
      resumeDispatcher,
      lockManager,
    });

    await suspensionStore.create(createParentSuspension());
    await suspensionStore.create(createRemoteBranchSuspension());
    await suspensionStore.create(createLegacyBranchSuspension());
  });

  it('records remote branch completion, updates session thread state, and queues parent resume once', async () => {
    barrierStore.completeBranch.mockResolvedValue({
      allComplete: true,
      completedCount: 2,
      totalCount: 2,
      disposition: 'recorded',
      branchKey: 'branch-1',
      parentResumeReady: true,
    });
    barrierStore.getParentSuspension.mockResolvedValue('parent-suspension');

    const resumePayload: ResumeData = {
      type: 'fan_out_remote_branch_result',
      callbackId: 'remote-callback',
      tenantId: 'tenant-1',
      payload: {
        kind: 'task',
        status: { state: 'completed' },
        artifacts: [
          {
            parts: [{ kind: 'text', text: 'Shipping will arrive tomorrow.' }],
          },
        ],
      },
      receivedAt: Date.now(),
    };

    await service.resume('branch-suspension', resumePayload);

    expect(barrierStore.completeBranch).toHaveBeenCalledWith(
      'barrier-1',
      expect.objectContaining({
        branchId: 'branch-1',
        branchAgent: 'RemoteShippingAgent',
        status: 'completed',
        response: 'Shipping will arrive tomorrow.',
      }),
    );
    expect(currentSession.threads[1].status).toBe('completed');
    expect(currentSession.threads[1].pendingResponse).toBe('Shipping will arrive tomorrow.');
    expect(executor.saveSessionSnapshot).toHaveBeenCalled();
    expect(executor.rehydrateSession).toHaveBeenCalledWith('session-1', {
      locator: {
        kind: 'production',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
    });
    expect(resumeDispatcher.enqueueResume).toHaveBeenCalledWith(
      'parent-suspension',
      expect.objectContaining({
        type: 'fan_out_parent_resume',
        callbackId: 'barrier-1',
      }),
    );
    expect(channelDispatcher.deliver).not.toHaveBeenCalled();
    expect((await suspensionStore.load('branch-suspension'))?.status).toBe('completed');
  });

  it('falls back to legacy session rehydration when a suspension has no project locator data', async () => {
    barrierStore.completeBranch.mockResolvedValue({
      allComplete: false,
      completedCount: 1,
      totalCount: 2,
      disposition: 'recorded',
      branchKey: 'branch-no-project',
      parentResumeReady: false,
    });

    const projectlessSuspension = {
      ...createRemoteBranchSuspension(),
      suspensionId: 'branch-suspension-no-project',
      callbackId: 'remote-callback-no-project',
      projectId: undefined,
      continuation: {
        ...createRemoteBranchSuspension().continuation,
        branchId: 'branch-no-project',
      },
      reason: {
        ...createRemoteBranchSuspension().reason,
        callbackId: 'remote-callback-no-project',
        branchId: 'branch-no-project',
      },
    } satisfies SuspendedExecution;
    await suspensionStore.create(projectlessSuspension);

    await service.resume('branch-suspension-no-project', {
      type: 'fan_out_remote_branch_result',
      callbackId: 'remote-callback-no-project',
      tenantId: 'tenant-1',
      payload: { response: 'legacy resume' },
      receivedAt: Date.now(),
    });

    expect(executor.rehydrateSession).toHaveBeenCalledWith('session-1', undefined);
  });

  it('treats duplicate fan-out callbacks as no-ops without requeueing parent resume', async () => {
    barrierStore.completeBranch.mockResolvedValue({
      allComplete: false,
      completedCount: 1,
      totalCount: 2,
      disposition: 'duplicate',
      branchKey: 'branch-1',
      parentResumeReady: false,
    });

    await service.resume('branch-suspension', {
      type: 'fan_out_remote_branch_result',
      callbackId: 'remote-callback',
      tenantId: 'tenant-1',
      payload: { response: 'already recorded' },
      receivedAt: Date.now(),
    });

    expect(executor.saveSessionSnapshot).not.toHaveBeenCalled();
    expect(resumeDispatcher.enqueueResume).not.toHaveBeenCalled();
    expect(channelDispatcher.deliver).not.toHaveBeenCalled();
    expect((await suspensionStore.load('branch-suspension'))?.status).toBe('completed');
  });

  it('delivers the parent aggregate response and updates the parent fan-out snapshot', async () => {
    barrierStore.getResults.mockResolvedValue({
      'branch-1': {
        branchId: 'branch-1',
        branchAgent: 'LocalBillingAgent',
        status: 'completed',
        response: 'Billing updated.',
        completedAt: 10,
      } satisfies BranchResult,
      'branch-2': {
        branchId: 'branch-2',
        branchAgent: 'RemoteShippingAgent',
        status: 'timeout',
        error: 'Timed out waiting for callback',
        completedAt: 20,
      } satisfies BranchResult,
    });

    await service.resume('parent-suspension', {
      type: 'fan_out_parent_resume',
      callbackId: 'barrier-1',
      tenantId: 'tenant-1',
      payload: {},
      receivedAt: Date.now(),
    });

    expect(channelDispatcher.deliver).toHaveBeenCalledWith(
      expect.any(Object),
      'session-1',
      expect.objectContaining({
        response: expect.stringContaining('Billing updated.'),
        action: expect.objectContaining({
          type: 'fan_out',
          taskCount: 2,
          failedCount: 1,
        }),
      }),
    );
    expect(channelDispatcher.deliver).toHaveBeenCalledWith(
      expect.any(Object),
      'session-1',
      expect.objectContaining({
        response: expect.stringContaining(
          "I couldn't complete RemoteShippingAgent before the async timeout.",
        ),
      }),
    );
    expect(currentSession.data.values._last_fan_out).toEqual(
      expect.objectContaining({
        results: [
          {
            target: 'LocalBillingAgent',
            status: 'completed',
            response: 'Billing updated.',
          },
          {
            target: 'RemoteShippingAgent',
            status: 'error',
            response: "I couldn't complete RemoteShippingAgent before the async timeout.",
          },
        ],
      }),
    );
    expect(barrierStore.delete).toHaveBeenCalledWith('barrier-1');
    expect((await suspensionStore.load('parent-suspension'))?.status).toBe('completed');
  });
});

describe('async fan-out timeout worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks expired fan-out branches as timed out and queues parent resume when the barrier closes', async () => {
    const expiredSuspension = createRemoteBranchSuspension();
    expiredSuspension.expiresAt = new Date(Date.now() - 1000);

    const suspensionStore = {
      findExpired: vi.fn().mockResolvedValueOnce([expiredSuspension]).mockResolvedValue([]),
      expire: vi.fn().mockResolvedValue(undefined),
    } as any;
    const callbackRegistry = {
      remove: vi.fn().mockResolvedValue(undefined),
    } as CallbackRegistry;
    const barrierStore = {
      completeBranch: vi.fn().mockResolvedValue({
        allComplete: true,
        completedCount: 2,
        totalCount: 2,
        disposition: 'recorded',
        branchKey: 'branch-1',
        parentResumeReady: true,
      }),
      getParentSuspension: vi.fn().mockResolvedValue('parent-suspension'),
    } as unknown as FanOutBarrierStore;
    const resumeDispatcher = {
      enqueueResume: vi.fn().mockResolvedValue(undefined),
    };

    const timer = startSuspensionTimeoutWorker({
      suspensionStore,
      callbackRegistry,
      barrierStore,
      resumeDispatcher,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(barrierStore.completeBranch).toHaveBeenCalledWith(
      'barrier-1',
      expect.objectContaining({
        branchId: 'branch-1',
        branchAgent: 'RemoteShippingAgent',
        status: 'timeout',
      }),
    );
    expect(resumeDispatcher.enqueueResume).toHaveBeenCalledWith(
      'parent-suspension',
      expect.objectContaining({
        type: 'fan_out_parent_resume',
        callbackId: 'barrier-1',
      }),
    );

    stopSuspensionTimeoutWorker(timer);
  });
});
