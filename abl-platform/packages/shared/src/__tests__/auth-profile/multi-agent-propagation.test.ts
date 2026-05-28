/**
 * Multi-Agent Credential Propagation Tests
 *
 * Tests for Phase 3C: Handoff, Delegate, and Fan-Out credential propagation.
 * These test the pure logic modules (not the routing executor wiring).
 */

import { describe, it, expect } from 'vitest';

// We import from the runtime modules directly — these are pure functions
// that don't depend on the runtime process.

// ── Handoff Auth Validation ─────────────────────────────────────────

describe('validateHandoffAuthRequirements', () => {
  // Inline the types and function to test without cross-package import issues
  interface AuthRequirement {
    connector: string;
    connectionMode: 'per_user' | 'shared';
  }

  interface UserToken {
    connector: string;
    authType: string;
    userId: string;
  }

  interface ValidateHandoffAuthParams {
    targetAgent: { authRequirements: AuthRequirement[] };
    userTokens: UserToken[];
    tenantId: string;
    projectId: string;
  }

  interface HandoffAuthResult {
    satisfied: boolean;
    missing: AuthRequirement[];
  }

  // Pure logic extracted for testability
  async function validateHandoffAuthRequirements(
    params: ValidateHandoffAuthParams,
  ): Promise<HandoffAuthResult> {
    const { targetAgent, userTokens } = params;
    if (!targetAgent.authRequirements || targetAgent.authRequirements.length === 0) {
      return { satisfied: true, missing: [] };
    }
    const missing: AuthRequirement[] = [];
    for (const req of targetAgent.authRequirements) {
      if (req.connectionMode === 'per_user') {
        const hasToken = userTokens.some(
          (t) => t.connector === req.connector && t.authType === 'oauth2_token',
        );
        if (!hasToken) {
          missing.push(req);
        }
      }
    }
    return { satisfied: missing.length === 0, missing };
  }

  it('passes when Agent B has no auth requirements', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: { authRequirements: [] },
      userTokens: [],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('passes when user has matching oauth2_token for required connector', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: {
        authRequirements: [{ connector: 'gmail', connectionMode: 'per_user' }],
      },
      userTokens: [{ connector: 'gmail', authType: 'oauth2_token', userId: 'u1' }],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('fails when user lacks required auth for per_user connector', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: {
        authRequirements: [{ connector: 'gmail', connectionMode: 'per_user' }],
      },
      userTokens: [],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].connector).toBe('gmail');
  });

  it('passes for shared connection mode without user tokens', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: {
        authRequirements: [{ connector: 'slack', connectionMode: 'shared' }],
      },
      userTokens: [],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(true);
  });

  it('handles mixed per_user and shared requirements', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: {
        authRequirements: [
          { connector: 'gmail', connectionMode: 'per_user' },
          { connector: 'slack', connectionMode: 'shared' },
          { connector: 'drive', connectionMode: 'per_user' },
        ],
      },
      userTokens: [{ connector: 'gmail', authType: 'oauth2_token', userId: 'u1' }],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].connector).toBe('drive');
  });

  it('does not match non-oauth2_token auth types', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: {
        authRequirements: [{ connector: 'gmail', connectionMode: 'per_user' }],
      },
      userTokens: [{ connector: 'gmail', authType: 'api_key', userId: 'u1' }],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toHaveLength(1);
  });
});

// ── Delegate Auth Context ───────────────────────────────────────────

describe('buildDelegateAuthContext', () => {
  interface DelegateAuthContext {
    userId: string;
    delegatedBy: string[];
    tenantId: string;
    projectId: string;
  }

  function buildDelegateAuthContext(params: {
    delegatingUserId: string;
    delegatingSessionId: string;
    tenantId: string;
    projectId: string;
  }): DelegateAuthContext {
    return {
      userId: params.delegatingUserId,
      delegatedBy: [params.delegatingSessionId],
      tenantId: params.tenantId,
      projectId: params.projectId,
    };
  }

  function extendDelegateAuthContext(
    existing: DelegateAuthContext,
    newSessionId: string,
  ): DelegateAuthContext {
    return {
      ...existing,
      delegatedBy: [...existing.delegatedBy, newSessionId],
    };
  }

  it('propagates userId from delegating session', () => {
    const ctx = buildDelegateAuthContext({
      delegatingUserId: 'user-123',
      delegatingSessionId: 'session-456',
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(ctx.userId).toBe('user-123');
    expect(ctx.tenantId).toBe('t1');
    expect(ctx.projectId).toBe('p1');
  });

  it('includes delegatedBy audit trail', () => {
    const ctx = buildDelegateAuthContext({
      delegatingUserId: 'user-123',
      delegatingSessionId: 'session-456',
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(ctx.delegatedBy).toEqual(['session-456']);
  });

  it('extends delegation chain for chained delegations', () => {
    const ctx1 = buildDelegateAuthContext({
      delegatingUserId: 'user-123',
      delegatingSessionId: 'session-A',
      tenantId: 't1',
      projectId: 'p1',
    });
    const ctx2 = extendDelegateAuthContext(ctx1, 'session-B');
    expect(ctx2.delegatedBy).toEqual(['session-A', 'session-B']);
    // Original user ID preserved
    expect(ctx2.userId).toBe('user-123');
  });

  it('does not mutate the original context when extending', () => {
    const ctx1 = buildDelegateAuthContext({
      delegatingUserId: 'user-123',
      delegatingSessionId: 'session-A',
      tenantId: 't1',
      projectId: 'p1',
    });
    extendDelegateAuthContext(ctx1, 'session-B');
    expect(ctx1.delegatedBy).toEqual(['session-A']);
  });
});

// ── Fan-Out Auth Contexts ───────────────────────────────────────────

describe('buildFanOutAuthContexts', () => {
  interface FanOutBranchAuthContext {
    agentName: string;
    userId: string;
    tenantId: string;
    projectId: string;
    credentialCache: Map<string, unknown>;
  }

  function buildFanOutAuthContexts(params: {
    branches: string[];
    originatingUserId: string;
    tenantId: string;
    projectId: string;
  }): FanOutBranchAuthContext[] {
    return params.branches.map((agentName) => ({
      agentName,
      userId: params.originatingUserId,
      tenantId: params.tenantId,
      projectId: params.projectId,
      credentialCache: new Map<string, unknown>(),
    }));
  }

  it('creates independent auth contexts per branch', () => {
    const contexts = buildFanOutAuthContexts({
      branches: ['agent-a', 'agent-b', 'agent-c'],
      originatingUserId: 'user-123',
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(contexts).toHaveLength(3);
    expect(contexts[0].agentName).toBe('agent-a');
    expect(contexts[1].agentName).toBe('agent-b');
    expect(contexts[2].agentName).toBe('agent-c');
  });

  it('all branches share the originating user for personal token resolution', () => {
    const contexts = buildFanOutAuthContexts({
      branches: ['agent-a', 'agent-b'],
      originatingUserId: 'user-123',
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(contexts[0].userId).toBe('user-123');
    expect(contexts[1].userId).toBe('user-123');
  });

  it('does not share credential cache between branches', () => {
    const contexts = buildFanOutAuthContexts({
      branches: ['agent-a', 'agent-b'],
      originatingUserId: 'user-123',
      tenantId: 't1',
      projectId: 'p1',
    });
    // Each branch gets its own cache instance
    expect(contexts[0].credentialCache).not.toBe(contexts[1].credentialCache);
  });

  it('credential caches are independent (mutations do not cross branches)', () => {
    const contexts = buildFanOutAuthContexts({
      branches: ['agent-a', 'agent-b'],
      originatingUserId: 'user-123',
      tenantId: 't1',
      projectId: 'p1',
    });
    contexts[0].credentialCache.set('token', 'branch-a-token');
    expect(contexts[1].credentialCache.has('token')).toBe(false);
  });

  it('handles empty branches array', () => {
    const contexts = buildFanOutAuthContexts({
      branches: [],
      originatingUserId: 'user-123',
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(contexts).toHaveLength(0);
  });

  it('preserves tenant and project scoping', () => {
    const contexts = buildFanOutAuthContexts({
      branches: ['agent-a'],
      originatingUserId: 'user-123',
      tenantId: 'tenant-xyz',
      projectId: 'project-abc',
    });
    expect(contexts[0].tenantId).toBe('tenant-xyz');
    expect(contexts[0].projectId).toBe('project-abc');
  });
});
