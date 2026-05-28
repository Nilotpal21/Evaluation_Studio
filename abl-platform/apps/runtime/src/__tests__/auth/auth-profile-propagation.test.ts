import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthRequirement } from '../../types/index.js';
import type { ActivationAuthContext } from '../../services/execution/types.js';

const { mockCreateTokenLookups, mockEvaluateAuthPreflightFromIR } = vi.hoisted(() => ({
  mockCreateTokenLookups: vi.fn(),
  mockEvaluateAuthPreflightFromIR: vi.fn(),
}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  createTokenLookups: (...args: unknown[]) => mockCreateTokenLookups(...args),
  evaluateAuthPreflightFromIR: (...args: unknown[]) => mockEvaluateAuthPreflightFromIR(...args),
}));

import {
  buildDelegateAuthContext,
  extendDelegateAuthContext,
} from '../../services/execution/auth-profile-delegate.js';
import {
  buildFanOutAuthContext,
  buildFanOutAuthContexts,
} from '../../services/execution/auth-profile-fanout.js';
import { validateHandoffAuthRequirements } from '../../services/execution/auth-profile-handoff.js';

function makeAuthContext(overrides: Partial<ActivationAuthContext> = {}): ActivationAuthContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    authToken: 'auth-token-1',
    authScope: 'user',
    callerContext: {
      channel: 'sdk_websocket',
      authScope: 'user',
      customerId: 'customer-1',
    },
    ...overrides,
  };
}

describe('auth profile propagation helpers', () => {
  beforeEach(() => {
    mockCreateTokenLookups.mockReset();
    mockEvaluateAuthPreflightFromIR.mockReset();
  });

  describe('buildDelegateAuthContext', () => {
    it('preserves runtime auth context and starts a delegation chain', () => {
      const context = buildDelegateAuthContext({
        authContext: makeAuthContext(),
        delegatingSessionId: 'session-root',
      });

      expect(context.userId).toBe('user-1');
      expect(context.tenantId).toBe('tenant-1');
      expect(context.projectId).toBe('project-1');
      expect(context.authScope).toBe('user');
      expect(context.callerContext?.channel).toBe('sdk_websocket');
      expect(context.delegatedBy).toEqual(['session-root']);
    });

    it('extends an existing delegation chain without duplicating the same hop', () => {
      const baseContext = buildDelegateAuthContext({
        authContext: makeAuthContext({ delegatedBy: ['session-root'] }),
        delegatingSessionId: 'session-root',
      });

      const extended = extendDelegateAuthContext(baseContext, 'session-child');
      const deduped = extendDelegateAuthContext(extended, 'session-child');

      expect(extended.delegatedBy).toEqual(['session-root', 'session-child']);
      expect(deduped.delegatedBy).toEqual(['session-root', 'session-child']);
    });
  });

  describe('buildFanOutAuthContexts', () => {
    it('creates one independent branch context per target agent', () => {
      const contexts = buildFanOutAuthContexts({
        branches: ['Billing_Agent', 'Support_Agent'],
        authContext: makeAuthContext({ delegatedBy: ['session-root'] }),
      });

      expect(contexts).toHaveLength(2);
      expect(contexts[0].agentName).toBe('Billing_Agent');
      expect(contexts[0].branchAgentName).toBe('Billing_Agent');
      expect(contexts[1].agentName).toBe('Support_Agent');
      expect(contexts[0].delegatedBy).toEqual(['session-root']);
      expect(contexts[0].branchCredentialCache).not.toBe(contexts[1].branchCredentialCache);

      contexts[0].branchCredentialCache.set('token', 'abc');
      expect(contexts[1].branchCredentialCache.has('token')).toBe(false);
    });

    it('builds a single branch context with a fresh cache', () => {
      const context = buildFanOutAuthContext({
        agentName: 'Returns_Agent',
        authContext: makeAuthContext({ authScope: 'session', userId: 'session-principal-1' }),
      });

      expect(context.agentName).toBe('Returns_Agent');
      expect(context.branchAgentName).toBe('Returns_Agent');
      expect(context.userId).toBe('session-principal-1');
      expect(context.authScope).toBe('session');
      expect(context.branchCredentialCache.size).toBe(0);
    });
  });

  describe('validateHandoffAuthRequirements', () => {
    it('short-circuits when the target agent has no tools', async () => {
      const result = await validateHandoffAuthRequirements({
        targetAgentName: 'Billing_Agent',
        targetAgentIR: { tools: [] },
        authContext: makeAuthContext(),
      });

      expect(result).toEqual({ satisfied: true, missing: [] });
      expect(mockCreateTokenLookups).not.toHaveBeenCalled();
      expect(mockEvaluateAuthPreflightFromIR).not.toHaveBeenCalled();
    });

    it('uses runtime auth context to evaluate target-agent preflight requirements', async () => {
      const pending: AuthRequirement[] = [
        {
          connector: 'gmail',
          authProfileRef: 'billing-gmail',
          connectionMode: 'per_user',
          scopes: ['mail.read'],
        },
      ];
      mockCreateTokenLookups.mockReturnValue({
        hasSessionToken: vi.fn(),
        hasUserToken: vi.fn(),
        hasTenantToken: vi.fn(),
      });
      mockEvaluateAuthPreflightFromIR.mockResolvedValue({
        pending,
        satisfied: [],
      });

      const result = await validateHandoffAuthRequirements({
        targetAgentName: 'Billing_Agent',
        targetAgentIR: {
          tools: [
            {
              name: 'lookup_invoice',
              auth_profile_ref: 'billing-gmail',
              connection_mode: 'per_user',
              consent_mode: 'preflight',
            },
          ],
        } as any,
        authContext: makeAuthContext({
          authScope: 'session',
          userId: 'session-principal-1',
        }),
        environment: 'staging',
      });

      expect(mockCreateTokenLookups).toHaveBeenCalledWith('tenant-1', 'project-1', 'staging', {
        authScope: 'session',
        sessionPrincipal: 'session-principal-1',
      });
      expect(mockEvaluateAuthPreflightFromIR).toHaveBeenCalledWith(
        {
          agents: {
            Billing_Agent: {
              tools: [
                expect.objectContaining({
                  name: 'lookup_invoice',
                  auth_profile_ref: 'billing-gmail',
                }),
              ],
            },
          },
        },
        expect.objectContaining({
          userId: 'session-principal-1',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          environment: 'staging',
          authScope: 'session',
          allowTenantTokenReuse: false,
        }),
        expect.anything(),
        { agentNames: ['Billing_Agent'] },
      );
      expect(result).toEqual({
        satisfied: false,
        missing: pending,
      });
    });

    it('returns satisfied when auth preflight reports no pending requirements', async () => {
      mockCreateTokenLookups.mockReturnValue({
        hasSessionToken: vi.fn(),
        hasUserToken: vi.fn(),
        hasTenantToken: vi.fn(),
      });
      mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);

      const result = await validateHandoffAuthRequirements({
        targetAgentName: 'Support_Agent',
        targetAgentIR: {
          tools: [
            {
              name: 'fetch_ticket',
              auth_profile_ref: 'support-api',
              connection_mode: 'shared',
              consent_mode: 'preflight',
            },
          ],
        } as any,
        authContext: makeAuthContext(),
      });

      expect(result).toEqual({
        satisfied: true,
        missing: [],
      });
    });
  });
});
