/**
 * E2E: Multi-Channel Preflight Consent (Suite 2)
 *
 * Tests preflight consent across both WS handlers.
 *
 * Real components:
 * - checkAuthPreflight, checkAuthPreflightFromIR, hasActiveAuthGate,
 *   queueMessageBehindAuthGate, satisfyConnector, cleanupAuthGate
 * - resolveConsentState
 * - collectAuthRequirements
 * - ServerMessages (WS event builders)
 *
 * Mock boundaries: Token lookup callbacks (injected functions), Logger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

vi.mock('../../services/auth-profile-resolver.js', () => ({
  resolveByName: vi.fn().mockResolvedValue(null),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import {
  checkAuthPreflight,
  checkAuthPreflightFromIR,
  hasActiveAuthGate,
  queueMessageBehindAuthGate,
  satisfyConnector,
  cleanupAuthGate,
  getAuthGateState,
} from '../../services/auth-profile/auth-preflight.js';
import {
  resolveConsentState,
  type TokenLookupFunctions,
} from '../../services/auth-profile/consent-state-resolver.js';
import { ServerMessages } from '../../websocket/events.js';
import type { AuthRequirementIR } from '@abl/compiler';

// ── Helpers ─────────────────────────────────────────────────────────

/** Create token lookups where all return false (nothing satisfied) */
function noTokenLookups(): TokenLookupFunctions {
  return {
    hasSessionToken: vi.fn().mockResolvedValue(false),
    hasUserToken: vi.fn().mockResolvedValue(false),
    hasTenantToken: vi.fn().mockResolvedValue(false),
  };
}

/** Create token lookups where specific profiles are satisfied */
function satisfiedTokenLookups(satisfiedProfiles: string[]): TokenLookupFunctions {
  return {
    hasSessionToken: vi.fn().mockResolvedValue(false),
    hasUserToken: vi.fn(async (requirement: AuthRequirementIR) => {
      return satisfiedProfiles.includes(requirement.auth_profile_ref);
    }),
    hasTenantToken: vi.fn().mockResolvedValue(false),
  };
}

function makePreflightRequirement(
  authProfileRef: string,
  overrides: Partial<AuthRequirementIR> = {},
): AuthRequirementIR {
  return {
    connector: authProfileRef,
    auth_profile_ref: authProfileRef,
    connection_mode: 'per_user',
    consent_mode: 'preflight',
    ...overrides,
  };
}

function makeInlineRequirement(
  authProfileRef: string,
  overrides: Partial<AuthRequirementIR> = {},
): AuthRequirementIR {
  return {
    connector: authProfileRef,
    auth_profile_ref: authProfileRef,
    connection_mode: 'per_user',
    consent_mode: 'inline',
    ...overrides,
  };
}

function makeCompilationOutput(
  tools: Array<Record<string, unknown>>,
): Parameters<typeof checkAuthPreflightFromIR>[1] {
  return {
    agents: {
      agent1: {
        tools,
      },
    },
  };
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('Suite 2: Multi-Channel Preflight Consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up any auth gate states created during tests
    cleanupAuthGate('session-main');
    cleanupAuthGate('session-sdk');
    cleanupAuthGate('session-test');
    cleanupAuthGate('session-queue');
    cleanupAuthGate('session-cleanup');
    cleanupAuthGate('session-satisfied');
  });

  it('2.1: Main WS handler sends auth_required on session init when tools need preflight', async () => {
    const requirements = [
      makePreflightRequirement('google-creds'),
      makePreflightRequirement('salesforce-creds'),
    ];

    const state = await checkAuthPreflight(
      'session-main',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    // Auth gate should be active with both connectors pending
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.pending).toHaveLength(2);
    expect(state!.satisfied).toHaveLength(0);
    expect(hasActiveAuthGate('session-main')).toBe(true);

    // Verify the auth_required ServerMessage can be built
    const msg = ServerMessages.authRequired('session-main', state!.pending, state!.satisfied);
    expect(msg.type).toBe('auth_required');
    expect(msg.sessionId).toBe('session-main');
    expect(msg.code).toBe('AUTH_PREFLIGHT_REQUIRED');
  });

  it('2.2: SDK WS handler sends auth_required on session init', async () => {
    const requirements = [makePreflightRequirement('slack-creds')];

    const state = await checkAuthPreflight(
      'session-sdk',
      requirements,
      { userId: 'user-sdk', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.pending).toHaveLength(1);
    expect(state!.pending[0].authProfileRef).toBe('slack-creds');

    // Verify ServerMessage
    const msg = ServerMessages.authRequired('session-sdk', state!.pending, state!.satisfied);
    expect(msg.type).toBe('auth_required');
    expect(msg.code).toBe('AUTH_PREFLIGHT_REQUIRED');
  });

  it('2.3: consent_satisfy updates auth gate state, sends auth_gate_updated', async () => {
    const requirements = [
      makePreflightRequirement('google-creds'),
      makePreflightRequirement('salesforce-creds'),
    ];

    await checkAuthPreflight(
      'session-test',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    // Satisfy one connector
    const result = satisfyConnector('session-test', 'google-creds');

    expect(result).not.toBeNull();
    expect(result!.allSatisfied).toBe(false);
    expect(result!.state.pending).toHaveLength(1);
    expect(result!.state.satisfied).toHaveLength(1);
    expect(result!.state.satisfied[0].authProfileRef).toBe('google-creds');

    // Verify auth_gate_updated message
    const msg = ServerMessages.authGateUpdated(
      'session-test',
      result!.state.pending,
      result!.state.satisfied,
    );
    expect(msg.type).toBe('auth_gate_updated');
    expect(msg.code).toBe('AUTH_PREFLIGHT_REQUIRED');
  });

  it('2.4: All connectors satisfied -> sends auth_gate_satisfied, replays queued messages', async () => {
    const requirements = [
      makePreflightRequirement('google-creds'),
      makePreflightRequirement('salesforce-creds'),
    ];

    await checkAuthPreflight(
      'session-test',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    // Queue some messages while gate is active
    queueMessageBehindAuthGate('session-test', 'Hello');
    queueMessageBehindAuthGate('session-test', 'How are you?');

    // Satisfy first connector
    satisfyConnector('session-test', 'google-creds');

    // Satisfy second connector
    const result = satisfyConnector('session-test', 'salesforce-creds');

    expect(result).not.toBeNull();
    expect(result!.allSatisfied).toBe(true);
    expect(result!.state.active).toBe(false);
    expect(result!.queuedMessages).toHaveLength(2);
    expect(result!.queuedMessages[0].text).toBe('Hello');
    expect(result!.queuedMessages[1].text).toBe('How are you?');

    // Verify auth_gate_satisfied message
    const msg = ServerMessages.authGateSatisfied('session-test');
    expect(msg.type).toBe('auth_gate_satisfied');
    expect(msg.sessionId).toBe('session-test');
    expect(msg.code).toBe('AUTH_PREFLIGHT_SATISFIED');

    // Gate should no longer be active
    expect(hasActiveAuthGate('session-test')).toBe(false);
  });

  it('2.5: Messages sent while auth gate active are queued (max 100)', async () => {
    const requirements = [makePreflightRequirement('google-creds')];

    await checkAuthPreflight(
      'session-queue',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    // Queue messages up to the limit
    for (let i = 0; i < 100; i++) {
      const queued = queueMessageBehindAuthGate('session-queue', `msg-${i}`);
      expect(queued).toBe(true);
    }

    // 101st message should throw
    expect(() => {
      queueMessageBehindAuthGate('session-queue', 'overflow');
    }).toThrow('Too many queued messages');

    // Verify queue depth in state
    const state = getAuthGateState('session-queue');
    expect(state).toBeDefined();
    expect(state!.queuedMessages).toHaveLength(100);
  });

  it('2.6: Auth gate cleanup on session disconnect', async () => {
    const requirements = [makePreflightRequirement('google-creds')];

    await checkAuthPreflight(
      'session-cleanup',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    expect(hasActiveAuthGate('session-cleanup')).toBe(true);

    // Simulate disconnect cleanup
    cleanupAuthGate('session-cleanup');

    expect(hasActiveAuthGate('session-cleanup')).toBe(false);
    expect(getAuthGateState('session-cleanup')).toBeUndefined();
  });

  it('2.7: No auth_required when all tools use consent: inline (not preflight)', async () => {
    // Only inline requirements - no preflight gate needed
    const requirements = [
      makeInlineRequirement('google-creds'),
      makeInlineRequirement('salesforce-creds'),
    ];

    const state = await checkAuthPreflight(
      'session-test',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    // No gate should be created for inline-only requirements
    expect(state).toBeNull();
    expect(hasActiveAuthGate('session-test')).toBe(false);
  });

  it('2.8: No auth_required when all tokens already satisfied', async () => {
    const requirements = [
      makePreflightRequirement('google-creds'),
      makePreflightRequirement('salesforce-creds'),
    ];

    // All profiles already have tokens
    const lookups = satisfiedTokenLookups(['google-creds', 'salesforce-creds']);

    const state = await checkAuthPreflight(
      'session-satisfied',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      lookups,
    );

    // All satisfied → no gate needed
    expect(state).toBeNull();
    expect(hasActiveAuthGate('session-satisfied')).toBe(false);
  });

  it('2.9: Mixed preflight + inline tools -> only preflight tools in auth_required', async () => {
    const requirements = [
      makePreflightRequirement('google-creds'),
      makeInlineRequirement('slack-creds'),
      makePreflightRequirement('salesforce-creds'),
    ];

    const state = await checkAuthPreflight(
      'session-test',
      requirements,
      { userId: 'user-1', tenantId: 'tenant-1' },
      noTokenLookups(),
    );

    // Only preflight requirements should appear in the gate
    expect(state).not.toBeNull();
    expect(state!.pending).toHaveLength(2);
    const pendingRefs = state!.pending.map((p) => p.authProfileRef).sort();
    expect(pendingRefs).toEqual(['google-creds', 'salesforce-creds']);
    // Inline connector should not be in pending or satisfied
    expect(state!.satisfied).toHaveLength(0);
  });

  describe('checkAuthPreflightFromIR integration', () => {
    it('extracts requirements from IR and activates gate', async () => {
      const compilationOutput = makeCompilationOutput([
        {
          name: 'gmail_lookup',
          auth_profile_ref: 'google-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        },
        {
          name: 'sf_query',
          auth_profile_ref: 'salesforce-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        },
        {
          name: 'simple_tool',
          // No auth_profile_ref — should be ignored
        },
      ]);

      const state = await checkAuthPreflightFromIR(
        'session-test',
        compilationOutput,
        { userId: 'user-1', tenantId: 'tenant-1' },
        noTokenLookups(),
      );

      expect(state).not.toBeNull();
      expect(state!.pending).toHaveLength(2);
      expect(state!.active).toBe(true);
    });

    it('scopes requirement extraction to the active agent when agentNames are provided', async () => {
      const compilationOutput = {
        agents: {
          entry_agent: {
            tools: [
              {
                name: 'simple_lookup',
              },
            ],
          },
          oauth_agent: {
            tools: [
              {
                name: 'oauth_lookup',
                auth_profile_ref: 'google-creds',
                consent_mode: 'preflight',
                connection_mode: 'per_user',
              },
            ],
          },
        },
      };

      const state = await checkAuthPreflightFromIR(
        'session-test',
        compilationOutput,
        { userId: 'user-1', tenantId: 'tenant-1' },
        noTokenLookups(),
        { agentNames: ['entry_agent'] },
      );

      expect(state).toBeNull();
    });

    it('returns null when compilation output is null', async () => {
      const state = await checkAuthPreflightFromIR(
        'session-test',
        null,
        { userId: 'user-1', tenantId: 'tenant-1' },
        noTokenLookups(),
      );

      expect(state).toBeNull();
    });

    it('returns null when no tools have auth requirements', async () => {
      const compilationOutput = makeCompilationOutput([
        { name: 'plain_tool' },
        { name: 'another_tool' },
      ]);

      const state = await checkAuthPreflightFromIR(
        'session-test',
        compilationOutput,
        { userId: 'user-1', tenantId: 'tenant-1' },
        noTokenLookups(),
      );

      expect(state).toBeNull();
    });
  });

  describe('resolveConsentState integration', () => {
    it('resolves 3-tier token lookup (session -> user -> tenant)', async () => {
      const requirements: AuthRequirementIR[] = [
        makePreflightRequirement('google-creds'),
        makePreflightRequirement('salesforce-creds'),
        makePreflightRequirement('shared-creds', { connection_mode: 'shared' }),
      ];

      const lookups: TokenLookupFunctions = {
        hasSessionToken: vi.fn(
          async (requirement: AuthRequirementIR) => requirement.auth_profile_ref === 'google-creds',
        ),
        hasUserToken: vi.fn(
          async (requirement: AuthRequirementIR) =>
            requirement.auth_profile_ref === 'salesforce-creds',
        ),
        hasTenantToken: vi.fn(
          async (requirement: AuthRequirementIR) => requirement.auth_profile_ref === 'shared-creds',
        ),
      };

      const results = await resolveConsentState(
        requirements,
        { sessionId: 'sess-1', userId: 'user-1', tenantId: 'tenant-1' },
        lookups,
      );

      expect(results).toHaveLength(3);

      // google-creds: found at session tier
      const google = results.find((r) => r.authProfileRef === 'google-creds');
      expect(google!.satisfied).toBe(true);
      expect(google!.resolvedVia).toBe('session');

      // salesforce-creds: found at user tier
      const sf = results.find((r) => r.authProfileRef === 'salesforce-creds');
      expect(sf!.satisfied).toBe(true);
      expect(sf!.resolvedVia).toBe('user');

      // shared-creds: found at tenant tier
      const shared = results.find((r) => r.authProfileRef === 'shared-creds');
      expect(shared!.satisfied).toBe(true);
      expect(shared!.resolvedVia).toBe('tenant');
    });

    it('marks unsatisfied when no tier has token', async () => {
      const requirements: AuthRequirementIR[] = [makePreflightRequirement('missing-creds')];

      const results = await resolveConsentState(
        requirements,
        { sessionId: 'sess-1', userId: 'user-1', tenantId: 'tenant-1' },
        noTokenLookups(),
      );

      expect(results).toHaveLength(1);
      expect(results[0].satisfied).toBe(false);
      expect(results[0].resolvedVia).toBeUndefined();
    });

    it('suppresses tenant-token reuse for session-scoped SDK callers even when the IR requests shared auth', async () => {
      const requirements: AuthRequirementIR[] = [
        makePreflightRequirement('shared-creds', { connection_mode: 'shared' }),
      ];

      const lookups: TokenLookupFunctions = {
        hasSessionToken: vi.fn(async () => false),
        hasUserToken: vi.fn(async () => false),
        hasTenantToken: vi.fn(async () => true),
      };

      const results = await resolveConsentState(
        requirements,
        {
          sessionId: 'sdk-session-1',
          userId: 'sdk-session-1',
          tenantId: 'tenant-1',
          allowTenantTokenReuse: false,
        },
        lookups,
      );

      expect(results).toHaveLength(1);
      expect(results[0].satisfied).toBe(false);
      expect(results[0].resolvedVia).toBeUndefined();
      expect(lookups.hasTenantToken).not.toHaveBeenCalled();
    });
  });
});
