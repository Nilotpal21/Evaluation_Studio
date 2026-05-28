import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CallbackRegistry,
  FanOutBarrierStore,
  SuspensionStore,
  SuspendedExecution,
} from '@agent-platform/execution';
import type {
  AgentRegistryEntry,
  ExecutorContext,
  RuntimeExecutorConfig,
  RuntimeSession,
} from '../../services/execution/types.js';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';

const mockSendTaskAsync = vi.fn();

vi.mock('@agent-platform/a2a', () => {
  class MockSsrfEndpointValidator {
    validate() {}
  }
  class MockAgentCardCache {
    get() {
      return undefined;
    }
    set() {}
  }
  return {
    sendTask: vi.fn(),
    sendTaskAsync: (...args: unknown[]) => mockSendTaskAsync(...args),
    SyncResponseForAsyncRequest: class extends Error {
      result: unknown;
      constructor(result: unknown) {
        super();
        this.result = result;
      }
    },
    createA2AClient: vi.fn(),
    createA2AClientWithAuth: vi.fn(),
    discoverAgent: vi.fn(),
    cancelRemoteTask: vi.fn(),
    SsrfEndpointValidator: MockSsrfEndpointValidator,
    AgentCardCache: MockAgentCardCache,
  };
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn().mockReturnValue({}),
}));

vi.mock('../../services/execution/memory-integration.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initializeActivatedAgentMemory: vi.fn().mockResolvedValue(undefined),
    executeRecallForAgentEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../services/execution/prompt-builder.js', () => ({
  isVoiceChannel: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/execution/prompt-template-loader.js', () => ({
  promptTemplateLoader: {
    load: vi.fn().mockReturnValue(''),
  },
}));

vi.mock('../../services/execution/value-resolution.js', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  interpolateVoiceConfig: vi.fn(),
  interpolateRichContent: vi.fn(),
  resolveValuePath: vi.fn(),
}));

vi.mock('../../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockReturnValue(null),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn(),
  createLLMEvalFromClient: vi.fn(),
}));

vi.mock('../../services/execution/multi-intent-strategy.js', () => ({
  resolveStrategy: vi.fn(),
}));

vi.mock('../../services/execution/intent-queue.js', () => ({
  enqueueIntents: vi.fn(),
  createIntentQueue: vi.fn(),
}));

import { RoutingExecutor } from '../../services/execution/routing-executor.js';
import { executeRecallForAgentEvent } from '../../services/execution/memory-integration.js';
import {
  KMSProviderPool,
  _resetKMSRegistryForTesting,
  setKMSProviderPool,
} from '@agent-platform/database/kms';
import {
  TenantEncryptionFacade,
  clearGlobalEncryptionFacade,
  setGlobalEncryptionFacade,
  type AcquiredDEK,
  type DEKScope,
} from '@agent-platform/shared-encryption';

class InMemoryDEKManager {
  private readonly entries = new Map<string, { tenantId: string; plaintext: Buffer }>();
  private readonly activeByScope = new Map<string, string>();

  async acquireDEK(scope: DEKScope, kekKeyId: string): Promise<AcquiredDEK> {
    const scopeKey = this.scopeKey(scope);
    const activeDekId = this.activeByScope.get(scopeKey);
    if (activeDekId) {
      const activeEntry = this.entries.get(activeDekId);
      if (activeEntry) {
        return {
          plaintext: Buffer.from(activeEntry.plaintext),
          dekId: activeDekId,
          kekKeyId,
          kekKeyVersion: 1,
        };
      }
    }

    const dekId = `test-dek-${randomBytes(8).toString('hex')}`;
    const plaintext = randomBytes(32);
    this.entries.set(dekId, { tenantId: scope.tenantId, plaintext });
    this.activeByScope.set(scopeKey, dekId);
    return { plaintext: Buffer.from(plaintext), dekId, kekKeyId, kekKeyVersion: 1 };
  }

  async unwrapDEK(dekId: string, tenantId: string): Promise<Buffer> {
    const entry = this.entries.get(dekId);
    if (!entry || entry.tenantId !== tenantId) {
      throw new Error('DEK not found for tenant');
    }
    return Buffer.from(entry.plaintext);
  }

  getCachedDEK(dekId: string, tenantId?: string): Buffer | null {
    const entry = this.entries.get(dekId);
    if (!entry || (tenantId && entry.tenantId !== tenantId)) {
      return null;
    }
    return Buffer.from(entry.plaintext);
  }

  getActiveDEKId(scope?: DEKScope): string {
    return scope
      ? (this.activeByScope.get(this.scopeKey(scope)) ?? 'unused-sync-path')
      : 'unused-sync-path';
  }

  clearCache(): void {
    for (const entry of this.entries.values()) {
      entry.plaintext.fill(0);
    }
    this.entries.clear();
    this.activeByScope.clear();
  }

  private scopeKey(scope: DEKScope): string {
    return `${scope.tenantId}:${scope.projectId}:${scope.environment}`;
  }
}

type FakeSuspension = SuspendedExecution;

class FakeBarrierStore implements FanOutBarrierStore {
  public createCalls: Array<{
    parentSessionId: string;
    parentExecutionId: string;
    tenantId: string;
    totalBranches: number;
    timeoutMs: number;
  }> = [];
  public completeCalls: Array<{ barrierId: string; result: any }> = [];
  public deletedBarrierIds: string[] = [];
  public parentSuspensionId: string | null = null;
  private readonly barrierId = 'barrier-1';
  private totalBranches = 0;
  private readonly results = new Map<string, any>();

  async create(params: {
    parentSessionId: string;
    parentExecutionId: string;
    tenantId: string;
    totalBranches: number;
    timeoutMs: number;
  }): Promise<string> {
    this.createCalls.push(params);
    this.totalBranches = params.totalBranches;
    return this.barrierId;
  }

  async completeBranch(barrierId: string, result: any) {
    this.completeCalls.push({ barrierId, result });
    const key = result.branchId ?? result.branchAgent;
    const alreadyExists = this.results.has(key);
    if (!alreadyExists) {
      this.results.set(key, result);
    }
    const completedCount = this.results.size;
    return {
      allComplete: completedCount >= this.totalBranches,
      completedCount,
      totalCount: this.totalBranches,
      disposition: alreadyExists ? 'duplicate' : 'recorded',
      branchKey: key,
      parentResumeReady: !alreadyExists && completedCount >= this.totalBranches,
    };
  }

  async get() {
    return null;
  }

  async getResults() {
    return Object.fromEntries(this.results.entries());
  }

  async setParentSuspension(_barrierId: string, suspensionId: string): Promise<void> {
    this.parentSuspensionId = suspensionId;
  }

  async getParentSuspension(): Promise<string | null> {
    return this.parentSuspensionId;
  }

  async cancel(): Promise<void> {}

  async delete(barrierId: string): Promise<void> {
    this.deletedBarrierIds.push(barrierId);
  }
}

class FakeSuspensionStore implements SuspensionStore {
  public created: FakeSuspension[] = [];
  public completed: string[] = [];
  public failed: Array<{ suspensionId: string; error: { code: string; message: string } }> = [];

  async create(suspension: FakeSuspension): Promise<void> {
    this.created.push(suspension);
  }
  async load(): Promise<FakeSuspension | null> {
    return null;
  }
  async loadScoped(): Promise<FakeSuspension | null> {
    return null;
  }
  async loadByCallbackId(): Promise<FakeSuspension | null> {
    return null;
  }
  async claimForResume(): Promise<boolean> {
    return true;
  }
  async releaseClaim(): Promise<void> {}
  async complete(suspensionId: string): Promise<void> {
    this.completed.push(suspensionId);
  }
  async fail(suspensionId: string, error: { code: string; message: string }): Promise<void> {
    this.failed.push({ suspensionId, error });
  }
  async expire(): Promise<void> {}
  async cancel(): Promise<void> {}
  async findByBarrier(): Promise<FakeSuspension[]> {
    return [];
  }
  async findExpired(): Promise<FakeSuspension[]> {
    return [];
  }
  async findBySession(): Promise<FakeSuspension[]> {
    return [];
  }
  async list(): Promise<FakeSuspension[]> {
    return [];
  }
}

class FakeCallbackRegistry implements CallbackRegistry {
  public registrations: Array<{
    callbackId: string;
    suspensionId: string;
    sessionId: string;
    tenantId: string;
    expiresAt: number;
  }> = [];
  public removed: string[] = [];

  async register(entry: {
    callbackId: string;
    suspensionId: string;
    sessionId: string;
    tenantId: string;
    expiresAt: number;
  }): Promise<void> {
    this.registrations.push(entry);
  }

  async lookup() {
    return null;
  }

  async claim() {
    return null;
  }

  async remove(callbackId: string): Promise<void> {
    this.removed.push(callbackId);
  }
}

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'session-1',
    agentName: 'SupervisorAgent',
    agentIR: { name: 'SupervisorAgent', type: 'reasoning' } as any,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  };

  if (session.threads.length === 0) {
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
  }

  return session;
}

function createMockConfig(overrides?: Partial<RuntimeExecutorConfig>): RuntimeExecutorConfig {
  return {
    timeoutMs: 5000,
    maxConcurrentFanOutCalls: 10,
    maxAsyncTimeoutSec: 600,
    ...overrides,
  };
}

function createMockAgentRegistry(
  agents: Record<string, Partial<AgentRegistryEntry>>,
): Record<string, AgentRegistryEntry> {
  const registry: Record<string, AgentRegistryEntry> = {};
  for (const [name, entry] of Object.entries(agents)) {
    registry[name] = {
      dsl: '',
      ir: { name, type: 'reasoning' } as any,
      ...entry,
    };
  }
  return registry;
}

function createMockLLMWiring() {
  return {
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    wireToolExecutor: vi.fn(),
    clearCooldown: vi.fn(),
    ensureSessionLLMClient: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('async fan-out execution wiring', () => {
  let barrierStore: FakeBarrierStore;
  let suspensionStore: FakeSuspensionStore;
  let callbackRegistry: FakeCallbackRegistry;
  let persistSession: ReturnType<typeof vi.fn>;
  let ctx: ExecutorContext;
  let executor: RoutingExecutor;
  let dekManager: InMemoryDEKManager;
  const originalKmsProvider = process.env.KMS_PROVIDER;

  beforeEach(async () => {
    mockSendTaskAsync.mockReset();
    vi.mocked(executeRecallForAgentEvent).mockClear();
    process.env.KMS_PROVIDER = 'local';
    _resetKMSRegistryForTesting();
    clearGlobalEncryptionFacade();

    const pool = new KMSProviderPool({ masterKeyHex: randomBytes(32).toString('hex') });
    await pool.initialize();
    setKMSProviderPool(pool);
    dekManager = new InMemoryDEKManager();
    setGlobalEncryptionFacade(new TenantEncryptionFacade(dekManager));

    barrierStore = new FakeBarrierStore();
    suspensionStore = new FakeSuspensionStore();
    callbackRegistry = new FakeCallbackRegistry();
    persistSession = vi.fn().mockResolvedValue(undefined);

    ctx = {
      executeMessage: vi.fn(),
      wireLLMClient: vi.fn().mockResolvedValue(undefined),
      checkConstraints: vi.fn().mockReturnValue(null),
      handleConstraintViolation: vi.fn(),
      interpolateTemplate: vi.fn((tpl: string) => tpl),
      debouncedPersist: vi.fn(),
      markExecuting: vi.fn(),
      unmarkExecuting: vi.fn(),
      cancelPendingPersist: vi.fn(),
      agentRegistry: createMockAgentRegistry({
        LocalBillingAgent: {},
        RemoteShippingAgent: {
          location: 'remote',
          remote: { endpoint: 'https://remote.example/agent' },
        },
      }),
      sessions: new Map(),
      config: createMockConfig(),
      asyncInfra: {
        callbackRegistry: callbackRegistry as any,
        suspensionStore: suspensionStore as any,
        barrierStore: barrierStore as any,
        callbackBaseUrl: 'https://callbacks.example/a2a',
      },
      persistSession,
      reasoning: {
        execute: vi.fn(),
      },
    } as unknown as ExecutorContext;

    (ctx.executeMessage as any).mockImplementation(
      async (sessionId: string, userMessage: string) => {
        expect(ctx.sessions.has(sessionId)).toBe(true);
        return {
          response: `handled:${userMessage}`,
          action: { type: 'respond' },
        };
      },
    );

    executor = new RoutingExecutor(ctx, createMockLLMWiring());
  });

  afterEach(() => {
    dekManager?.clearCache();
    clearGlobalEncryptionFacade();
    _resetKMSRegistryForTesting();
    if (originalKmsProvider === undefined) {
      delete process.env.KMS_PROVIDER;
    } else {
      process.env.KMS_PROVIDER = originalKmsProvider;
    }
  });

  it('registers local child sessions and persists remote branch state before dispatch', async () => {
    const session = createMockSession({ _sessionAgentRegistry: ctx.agentRegistry });
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const chunks: string[] = [];

    mockSendTaskAsync.mockImplementation(async () => {
      expect(persistSession).toHaveBeenCalled();
      expect(
        suspensionStore.created.some(
          (suspension) => suspension.continuation.type === 'fan_out_parent_resume',
        ),
      ).toBe(true);
    });

    const result = await executor.handleFanOut(
      session,
      {
        tasks: [
          { target: 'LocalBillingAgent', intent: 'Update the invoice totals' },
          { target: 'RemoteShippingAgent', intent: 'Check the shipping ETA' },
        ],
      },
      (chunk) => chunks.push(chunk),
      (event) => traceEvents.push(event),
    );

    expect(result).toEqual({
      success: true,
      results: [
        {
          target: 'LocalBillingAgent',
          status: 'completed',
          response: 'handled:Update the invoice totals',
        },
      ],
      failedCount: 0,
    });
    expect(chunks).toEqual([
      'Processing 1 remote task(s) asynchronously. Local results are ready, remote results will follow.',
    ]);
    expect(ctx.markExecuting).toHaveBeenCalledTimes(1);
    expect(ctx.unmarkExecuting).toHaveBeenCalledTimes(1);
    expect(ctx.sessions.size).toBe(0);
    expect(session.threads).toHaveLength(3);
    expect(session.threads[1].status).toBe('completed');
    expect(session.threads[2].status).toBe('waiting');
    expect(barrierStore.parentSuspensionId).toBeTruthy();
    expect(suspensionStore.created.map((suspension) => suspension.continuation.type)).toEqual([
      'fan_out_parent_resume',
      'fan_out_remote_branch',
    ]);
    expect(traceEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'fan_out_async_started',
        'fan_out_branch_registered',
        'fan_out_parent_suspended',
        'fan_out_branch_dispatched',
        'fan_out_barrier_progress',
      ]),
    );

    const recallCalls = vi.mocked(executeRecallForAgentEvent).mock.calls;
    expect(recallCalls).toHaveLength(2);
    expect(recallCalls.map(([, , phase]) => phase)).toEqual(['before', 'after']);
    for (const [recallSession, agentName] of recallCalls) {
      expect(recallSession.id).toContain('__fanout__');
      expect(recallSession.id).not.toBe(session.id);
      expect(recallSession.agentIR?.name).toBe(agentName);
    }
  });

  it('detokenizes API tool params in async fan-out barrier execution', async () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );
    const piiVault = new PIIVault({ recognizerRegistry: registry });
    const tokenized = piiVault.tokenize(rawContractId).text;
    const execute = vi.fn().mockResolvedValue({ found: true });
    const session = createMockSession({
      _sessionAgentRegistry: ctx.agentRegistry,
      piiVault,
      piiRecognizerRegistry: registry,
      piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
      piiPatternConfigs: [
        {
          patternName: 'ContractID',
          defaultRenderMode: 'redacted',
          consumerAccess: [],
        },
      ],
      toolExecutor: { execute } as RuntimeSession['toolExecutor'],
    });

    const result = await executor.handleFanOut(session, {
      tasks: [
        {
          target: 'RemoteShippingAgent',
          intent: 'Check the shipping ETA',
        },
        {
          type: 'tool',
          target: 'lookup_contract',
          intent: 'lookup contract',
          params: {
            contractId: tokenized,
            nested: {
              auditIds: [tokenized],
            },
          },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      'lookup_contract',
      {
        contractId: rawContractId,
        nested: {
          auditIds: [rawContractId],
        },
      },
      expect.any(Number),
    );
    const toolCompletion = barrierStore.completeCalls.find(
      (call) => call.result.branchAgent === 'lookup_contract',
    );
    expect(toolCompletion?.result.response).toBe(JSON.stringify({ found: true }));
  });

  it('completes the parent suspension immediately when every remote dispatch fails up front', async () => {
    const session = createMockSession({ _sessionAgentRegistry: ctx.agentRegistry });
    const chunks: string[] = [];

    mockSendTaskAsync.mockRejectedValue(new Error('remote transport unavailable'));

    const result = await executor.handleFanOut(
      session,
      {
        tasks: [
          { target: 'LocalBillingAgent', intent: 'Update the invoice totals' },
          { target: 'RemoteShippingAgent', intent: 'Check the shipping ETA' },
        ],
      },
      (chunk) => chunks.push(chunk),
    );

    expect(result).toEqual({
      success: true,
      results: [
        {
          target: 'LocalBillingAgent',
          status: 'completed',
          response: 'handled:Update the invoice totals',
        },
        {
          target: 'RemoteShippingAgent',
          status: 'error',
          error: 'remote transport unavailable',
        },
      ],
      failedCount: 1,
    });
    expect(chunks).toEqual([]);
    expect(suspensionStore.completed).toEqual([barrierStore.parentSuspensionId!]);
    expect(barrierStore.deletedBarrierIds).toEqual(['barrier-1']);
    expect(session.threads[2].status).toBe('completed');
    expect(session.threads[2].data.values._fan_out_error).toBe('remote transport unavailable');
  });

  it('fires agent:after recall exactly once on local async fan-out errors', async () => {
    const session = createMockSession({ _sessionAgentRegistry: ctx.agentRegistry });
    (ctx.executeMessage as any).mockRejectedValueOnce(new Error('local child failed'));

    const result = await executor.handleFanOut(session, {
      tasks: [{ target: 'LocalBillingAgent', intent: 'Update the invoice totals' }],
    });

    expect(result).toEqual({
      success: false,
      results: [
        {
          target: 'LocalBillingAgent',
          status: 'error',
          error: 'local child failed',
        },
      ],
      failedCount: 1,
    });

    const recallCalls = vi.mocked(executeRecallForAgentEvent).mock.calls;
    expect(recallCalls).toHaveLength(2);
    expect(recallCalls.map(([, , phase]) => phase)).toEqual(['before', 'after']);
    const afterCalls = recallCalls.filter(([, , phase]) => phase === 'after');
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0][0].id).toContain('__fanout__');
    expect(afterCalls[0][0].id).not.toBe(session.id);
  });
});
