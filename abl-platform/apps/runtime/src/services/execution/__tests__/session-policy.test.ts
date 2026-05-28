import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetGuardrailPolicyEpoch = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock('../../guardrails/pipeline-factory.js', () => ({
  resolveGuardrailPolicy: vi.fn(),
}));

vi.mock('../../guardrails/policy-epoch.js', () => ({
  getGuardrailPolicyEpoch: (...args: unknown[]) => mockGetGuardrailPolicyEpoch(...args),
}));

import { getSessionPolicy, toStreamingEvalConfig } from '../session-policy.js';
import { resolveGuardrailPolicy } from '../../guardrails/pipeline-factory.js';

const resolveGuardrailPolicyMock = vi.mocked(resolveGuardrailPolicy);

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentIR: {
      metadata: { name: 'test-agent' },
      constraints: {
        guardrails: [{ name: 'pii-check', kind: 'output', rules: [], priority: 1 }],
      },
    },
    ...overrides,
  };
}

describe('getSessionPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGuardrailPolicyEpoch.mockResolvedValue(0);
  });

  it('resolves policy from DB on first call', async () => {
    const policy = {
      disabledGuardrails: [],
      ruleOverrides: [],
      settings: { failMode: 'open' as const },
    };
    resolveGuardrailPolicyMock.mockResolvedValue({ policy, streamingConfig: null } as any);

    const session = makeSession();
    const result = await getSessionPolicy(session);

    expect(result).toBe(policy);
    expect(resolveGuardrailPolicyMock).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      'test-agent',
      session.agentIR.constraints.guardrails,
    );
  });

  it('returns cached policy on second call', async () => {
    const policy = {
      disabledGuardrails: [],
      ruleOverrides: [],
      settings: { failMode: 'open' as const },
    };
    resolveGuardrailPolicyMock.mockResolvedValue({ policy, streamingConfig: null } as any);
    mockGetGuardrailPolicyEpoch.mockResolvedValue(1);

    const session = makeSession();

    const first = await getSessionPolicy(session);
    const second = await getSessionPolicy(session);

    expect(first).toBe(second);
    // DB should only be called once
    expect(resolveGuardrailPolicyMock).toHaveBeenCalledTimes(1);
  });

  it('re-resolves cached policy when the project guardrail epoch advances', async () => {
    const initialPolicy = {
      disabledGuardrails: [],
      ruleOverrides: [],
      settings: { failMode: 'open' as const },
    };
    const refreshedPolicy = {
      disabledGuardrails: ['pii-check'],
      ruleOverrides: [],
      settings: { failMode: 'closed' as const },
    };
    resolveGuardrailPolicyMock
      .mockResolvedValueOnce({ policy: initialPolicy, streamingConfig: null } as any)
      .mockResolvedValueOnce({ policy: refreshedPolicy, streamingConfig: null } as any);
    mockGetGuardrailPolicyEpoch.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const session = makeSession();

    const first = await getSessionPolicy(session);
    const second = await getSessionPolicy(session);

    expect(first).toBe(initialPolicy);
    expect(second).toBe(refreshedPolicy);
    expect(resolveGuardrailPolicyMock).toHaveBeenCalledTimes(2);
  });

  it('re-resolves cached policy when the active thread agent changes under the same project epoch', async () => {
    const parentPolicy = {
      disabledGuardrails: [],
      ruleOverrides: [],
      settings: { failMode: 'open' as const },
    };
    const childPolicy = {
      disabledGuardrails: ['child-check'],
      ruleOverrides: [],
      settings: { failMode: 'closed' as const },
    };
    const parentIR = {
      metadata: { name: 'ParentAgent' },
      constraints: { guardrails: [{ name: 'parent-check', kind: 'output' }] },
    };
    const childIR = {
      metadata: { name: 'ChildAgent' },
      constraints: { guardrails: [{ name: 'child-check', kind: 'output' }] },
    };

    resolveGuardrailPolicyMock
      .mockResolvedValueOnce({ policy: parentPolicy, streamingConfig: null } as any)
      .mockResolvedValueOnce({ policy: childPolicy, streamingConfig: null } as any);
    mockGetGuardrailPolicyEpoch.mockResolvedValue(7);

    const session = makeSession({
      agentName: 'ParentAgent',
      agentIR: parentIR,
      activeThreadIndex: 0,
      versionInfo: { rawVersions: { ParentAgent: '1.0.0', ChildAgent: '1.0.0' } },
      threads: [
        { agentName: 'ParentAgent', agentIR: parentIR, _cachedIRHash: 'parent-hash' },
        { agentName: 'ChildAgent', agentIR: childIR, _cachedIRHash: 'child-hash' },
      ],
    });

    const first = await getSessionPolicy(session);
    session.activeThreadIndex = 1;
    const second = await getSessionPolicy(session);

    expect(first).toBe(parentPolicy);
    expect(second).toBe(childPolicy);
    expect(resolveGuardrailPolicyMock).toHaveBeenCalledTimes(2);
    expect(resolveGuardrailPolicyMock).toHaveBeenNthCalledWith(
      1,
      'tenant-1',
      'project-1',
      'ParentAgent',
      parentIR.constraints.guardrails,
    );
    expect(resolveGuardrailPolicyMock).toHaveBeenNthCalledWith(
      2,
      'tenant-1',
      'project-1',
      'ChildAgent',
      childIR.constraints.guardrails,
    );
  });

  it('returns undefined when tenantId is missing', async () => {
    const session = makeSession({ tenantId: undefined });
    const result = await getSessionPolicy(session);

    expect(result).toBeUndefined();
    expect(resolveGuardrailPolicyMock).not.toHaveBeenCalled();
  });

  it('returns undefined when projectId is missing', async () => {
    const session = makeSession({ projectId: undefined });
    const result = await getSessionPolicy(session);

    expect(result).toBeUndefined();
    expect(resolveGuardrailPolicyMock).not.toHaveBeenCalled();
  });

  it('calls resolver even when no guardrails are defined (DB may have policies)', async () => {
    resolveGuardrailPolicyMock.mockResolvedValue(undefined);

    const session = makeSession({
      agentIR: { metadata: { name: 'test' }, constraints: { guardrails: [] } },
    });
    const result = await getSessionPolicy(session);

    expect(result).toBeUndefined();
    expect(resolveGuardrailPolicyMock).toHaveBeenCalledTimes(1);
    expect(resolveGuardrailPolicyMock).toHaveBeenCalledWith('tenant-1', 'project-1', 'test', []);
  });

  it('returns undefined when agentIR is null', async () => {
    const session = makeSession({ agentIR: null });
    const result = await getSessionPolicy(session);

    expect(result).toBeUndefined();
    expect(resolveGuardrailPolicyMock).not.toHaveBeenCalled();
  });
});

describe('toStreamingEvalConfig', () => {
  it('preserves token interval and max latency from policy settings', () => {
    const config = toStreamingEvalConfig({
      enabled: true,
      defaultInterval: 'token',
      chunkSize: 64,
      maxLatencyMs: 750,
      earlyTermination: false,
    });

    expect(config).toEqual({
      interval: 'token',
      chunkSize: 64,
      maxLatencyMs: 750,
      earlyTermination: false,
    });
  });

  it('maps chunk_size to chunk for the evaluator', () => {
    const config = toStreamingEvalConfig({
      enabled: true,
      defaultInterval: 'chunk_size',
      chunkSize: 128,
      maxLatencyMs: 500,
      earlyTermination: true,
    });

    expect(config).toEqual({
      interval: 'chunk',
      chunkSize: 128,
      maxLatencyMs: 500,
      earlyTermination: true,
    });
  });
});
