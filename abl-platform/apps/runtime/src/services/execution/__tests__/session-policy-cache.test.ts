import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for session policy cache sentinel behavior — verifying that when
 * resolveGuardrailPolicy returns undefined, the cache stores null as sentinel
 * so subsequent calls don't re-query the DB.
 */

const mockResolvePolicy = vi.fn();
const mockGetGuardrailPolicyEpoch = vi.fn().mockResolvedValue(0);

vi.mock('../../guardrails/pipeline-factory.js', () => ({
  resolveGuardrailPolicy: (...args: unknown[]) => mockResolvePolicy(...args),
}));

vi.mock('../../guardrails/policy-epoch.js', () => ({
  getGuardrailPolicyEpoch: (...args: unknown[]) => mockGetGuardrailPolicyEpoch(...args),
}));

import { getSessionGuardrailCacheScopeKey, getSessionPolicy } from '../session-policy.js';

function createMockSession(overrides: Record<string, unknown> = {}): any {
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

describe('getSessionPolicy cache sentinel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGuardrailPolicyEpoch.mockResolvedValue(0);
  });

  it('resolves from DB on first call and caches the result', async () => {
    const mockPolicy = {
      disabledGuardrails: [],
      ruleOverrides: [],
      settings: { failMode: 'open' },
    };
    mockResolvePolicy.mockResolvedValue({ policy: mockPolicy, streamingConfig: null });

    const session = createMockSession();

    const result1 = await getSessionPolicy(session);
    expect(result1).toBe(mockPolicy);
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1);

    // Second call should return cached value without DB call
    const result2 = await getSessionPolicy(session);
    expect(result2).toBe(mockPolicy);
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1); // still 1 — no re-query
  });

  it('stores null sentinel when policy resolves to undefined — does NOT re-query DB', async () => {
    mockResolvePolicy.mockResolvedValue(undefined);

    const session = createMockSession();

    const result1 = await getSessionPolicy(session);
    expect(result1).toBeUndefined();
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1);

    // Second call — should return cached undefined (via null sentinel) without re-querying
    const result2 = await getSessionPolicy(session);
    expect(result2).toBeUndefined();
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1); // still 1 — sentinel prevents re-query
  });

  it('re-queries when the epoch advances even after caching a null sentinel', async () => {
    const refreshedPolicy = {
      disabledGuardrails: ['pii-check'],
      ruleOverrides: [],
      settings: { failMode: 'closed' },
    };
    mockResolvePolicy
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ policy: refreshedPolicy, streamingConfig: null });
    mockGetGuardrailPolicyEpoch.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const session = createMockSession();

    const first = await getSessionPolicy(session);
    const second = await getSessionPolicy(session);

    expect(first).toBeUndefined();
    expect(second).toBe(refreshedPolicy);
    expect(mockResolvePolicy).toHaveBeenCalledTimes(2);
  });

  it('internal cache value is null (not undefined) for "resolved to nothing"', async () => {
    mockResolvePolicy.mockResolvedValue(undefined);

    const session = createMockSession();
    await getSessionPolicy(session);

    // The internal cache should be null (sentinel), not undefined
    expect(session._guardrailPolicy).toBeNull();
  });

  it('returns undefined without caching when session has no tenantId', async () => {
    const session = createMockSession({ tenantId: undefined });

    const result = await getSessionPolicy(session);
    expect(result).toBeUndefined();
    expect(mockResolvePolicy).not.toHaveBeenCalled();

    // _guardrailPolicy should remain undefined (not cached)
    expect(session._guardrailPolicy).toBeUndefined();
  });

  it('returns undefined without caching when session has no projectId', async () => {
    const session = createMockSession({ projectId: undefined });

    const result = await getSessionPolicy(session);
    expect(result).toBeUndefined();
    expect(mockResolvePolicy).not.toHaveBeenCalled();
    expect(session._guardrailPolicy).toBeUndefined();
  });

  it('calls resolver and caches sentinel when session has no guardrails (DB may have policies)', async () => {
    mockResolvePolicy.mockResolvedValue(undefined);

    const session = createMockSession({
      agentIR: {
        metadata: { name: 'test-agent' },
        constraints: { guardrails: [] },
      },
    });

    const result = await getSessionPolicy(session);
    expect(result).toBeUndefined();
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1);
    expect(session._guardrailPolicy).toBeNull(); // null sentinel cached
  });

  it('returns undefined without caching when session has no agentIR', async () => {
    const session = createMockSession({ agentIR: undefined });

    const result = await getSessionPolicy(session);
    expect(result).toBeUndefined();
    expect(mockResolvePolicy).not.toHaveBeenCalled();
    expect(session._guardrailPolicy).toBeUndefined();
  });

  it('returns cached policy directly when _guardrailPolicy is already set', async () => {
    const existingPolicy = {
      disabledGuardrails: ['some-rule'],
      ruleOverrides: [],
      settings: { failMode: 'closed' },
    };

    const session = createMockSession();
    session._guardrailPolicy = existingPolicy;
    session._guardrailPolicyEpoch = 0;
    session._guardrailPolicyScopeKey = getSessionGuardrailCacheScopeKey(session);

    const result = await getSessionPolicy(session);
    expect(result).toBe(existingPolicy);
    expect(mockResolvePolicy).not.toHaveBeenCalled();
  });

  it('returns undefined from cache when _guardrailPolicy is null (sentinel)', async () => {
    const session = createMockSession();
    session._guardrailPolicy = null;
    session._guardrailPolicyEpoch = 0;
    session._guardrailPolicyScopeKey = getSessionGuardrailCacheScopeKey(session);

    const result = await getSessionPolicy(session);
    expect(result).toBeUndefined(); // null sentinel maps to undefined for callers
    expect(mockResolvePolicy).not.toHaveBeenCalled();
  });
});
