import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { RoutingExecutor } from '../../services/execution/routing-executor.js';
import { AgentRegistryStore } from '../../services/execution/agent-registry.js';
import {
  createInitialThread,
  type AgentRegistry,
  type ExecutorContext,
  type RuntimeSession,
} from '../../services/execution/types.js';
import type { LLMWiringService } from '../../services/execution/llm-wiring.js';
import type { AuthRequirement } from '../../types/index.js';

const { mockCreateTokenLookups, mockEvaluateAuthPreflightFromIR } = vi.hoisted(() => ({
  mockCreateTokenLookups: vi.fn(),
  mockEvaluateAuthPreflightFromIR: vi.fn(),
}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  createTokenLookups: (...args: unknown[]) => mockCreateTokenLookups(...args),
  evaluateAuthPreflightFromIR: (...args: unknown[]) => mockEvaluateAuthPreflightFromIR(...args),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
      setCorrelationId: vi.fn(),
    }),
  };
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn().mockReturnValue({ allowLocalhost: false }),
}));

function makeSupervisorIR(): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'Supervisor', type: 'agent', version: '1.0' },
    identity: { goal: 'Delegate internal policy work' },
    coordination: {
      delegates: [
        {
          agent: 'PolicyChild',
          purpose: 'Evaluate policy',
          input: {},
          returns: {},
          use_result: 'delegate_result',
          on_failure: 'continue',
          experienceMode: 'silent_delegate',
        },
      ],
    },
    tools: [],
  } as unknown as AgentIR;
}

function makePolicyChildIR(): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'PolicyChild', type: 'agent', version: '1.0' },
    identity: { goal: 'Evaluate secure policy' },
    coordination: {},
    tools: [
      {
        name: 'secure_policy_lookup',
        auth_profile_ref: 'policy-oauth',
        connection_mode: 'per_user',
        consent_mode: 'preflight',
      },
    ],
  } as unknown as AgentIR;
}

function makeSession(supervisorIR: AgentIR, childIR: AgentIR): RuntimeSession {
  const session = {
    id: 'session-delegate-auth',
    agentName: 'Supervisor',
    agentIR: supervisorIR,
    compilationOutput: {
      agents: {
        Supervisor: supervisorIR,
        PolicyChild: childIR,
      },
    },
    conversationHistory: [{ role: 'user', content: 'check the policy' }],
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
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    authToken: 'auth-token-1',
    callerContext: {
      channel: 'sdk_websocket',
      authScope: 'user',
    },
    _activationAuthContext: {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      authToken: 'auth-token-1',
      authScope: 'user',
      callerContext: {
        channel: 'sdk_websocket',
        authScope: 'user',
      },
    },
    _sessionAgentRegistry: {
      PolicyChild: { dsl: '', ir: childIR, location: 'local' },
    },
  } as unknown as RuntimeSession;

  createInitialThread(session);
  return session;
}

function makeLLMWiring(): Pick<
  LLMWiringService,
  'wireLLMClient' | 'wireToolExecutor' | 'clearCooldown'
> {
  return {
    wireLLMClient: vi.fn(async (session: RuntimeSession, agentIR: AgentIR) => {
      session.llmClient = { agentName: agentIR.metadata.name } as RuntimeSession['llmClient'];
    }),
    wireToolExecutor: vi.fn(),
    clearCooldown: vi.fn(),
  };
}

function makeContext(agentRegistry: AgentRegistry): ExecutorContext {
  const executeMessage: ExecutorContext['executeMessage'] = vi.fn(async () => ({
    response: JSON.stringify({ allowed: true }),
    action: { type: 'complete' },
  }));

  return {
    executeMessage,
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn(() => null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: (template: string) => template,
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry,
    agentRegistryStore: new AgentRegistryStore(),
    sessions: new Map<string, RuntimeSession>(),
    config: { timeoutMs: 1000, maxConcurrentFanOutCalls: 10 } as ExecutorContext['config'],
  };
}

describe('delegate auth preflight', () => {
  beforeEach(() => {
    mockCreateTokenLookups.mockReset();
    mockEvaluateAuthPreflightFromIR.mockReset();
    mockCreateTokenLookups.mockReturnValue({
      hasSessionToken: vi.fn(),
      hasUserToken: vi.fn(),
      hasTenantToken: vi.fn(),
    });
  });

  it('blocks delegate before child execution when target auth is missing', async () => {
    const supervisorIR = makeSupervisorIR();
    const childIR = makePolicyChildIR();
    const pendingRequirement: AuthRequirement = {
      connector: 'policy',
      authProfileRef: 'policy-oauth',
      connectionMode: 'per_user',
    };
    mockEvaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [pendingRequirement],
      satisfied: [],
    });

    const session = makeSession(supervisorIR, childIR);
    const context = makeContext({});
    const routing = new RoutingExecutor(context, makeLLMWiring() as LLMWiringService);
    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await routing.handleDelegate(
      session,
      { target: 'PolicyChild', input: { orderId: 'order-1' } },
      undefined,
      (event) => traces.push(event),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Cannot delegate to PolicyChild until required authorization is complete.',
    );
    expect(context.executeMessage).not.toHaveBeenCalled();
    expect(context.markExecuting).not.toHaveBeenCalled();
    expect(session.threads).toHaveLength(1);
    expect(session.delegateStack).toEqual([]);
    expect(traces).toContainEqual(
      expect.objectContaining({
        type: 'delegate_start',
        data: expect.objectContaining({
          from: 'Supervisor',
          to: 'PolicyChild',
          blocked: true,
          blockReason: 'auth_preflight',
          suppressChildOutput: true,
          authPreflight: {
            satisfied: false,
            missingRequirements: [
              {
                connector: 'policy',
                authProfileRef: 'policy-oauth',
                connectionMode: 'per_user',
              },
            ],
          },
        }),
      }),
    );
    expect(traces.some((event) => event.type === 'agent_activation')).toBe(false);
  });

  it('executes delegate child when target auth preflight is satisfied', async () => {
    const supervisorIR = makeSupervisorIR();
    const childIR = makePolicyChildIR();
    mockEvaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [],
      satisfied: [
        {
          connector: 'policy',
          authProfileRef: 'policy-oauth',
          connectionMode: 'per_user',
        },
      ],
    });

    const session = makeSession(supervisorIR, childIR);
    const context = makeContext({});
    const routing = new RoutingExecutor(context, makeLLMWiring() as LLMWiringService);

    const result = await routing.handleDelegate(session, {
      target: 'PolicyChild',
      input: { orderId: 'order-1' },
      message: 'evaluate order policy',
    });

    expect(result.success).toBe(true);
    expect(context.executeMessage).toHaveBeenCalledTimes(1);
    expect(context.executeMessage).toHaveBeenCalledWith(
      expect.stringContaining('__delegate__'),
      'evaluate order policy',
      undefined,
      undefined,
      expect.objectContaining({
        messageSource: 'delegate',
        sourceAgent: 'Supervisor',
        parentSessionId: session.id,
      }),
    );
    expect(session.data.values.delegate_result).toEqual(
      expect.objectContaining({
        responseData: { allowed: true },
      }),
    );
    expect(session.delegateStack).toEqual([]);
  });
});
