import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkAuthPreflight,
  createTokenLookups,
  hasActiveAuthGate,
  hasActiveAuthGateAsync,
  queueMessageBehindAuthGate,
  queueMessageBehindAuthGateAsync,
  satisfyConnector,
  cleanupAuthGate,
  getAuthGateState,
} from '../../services/auth-profile/auth-preflight.js';
import type { AuthRequirementIR } from '@abl/compiler';

const resolveByNameMock = vi.fn();
const resolveAuthProfileCredentialsMock = vi.fn();
const resolveAuthProfileRefMock = vi.fn();
const mockIsRedisAvailable = vi.fn();
const mockGetRedisClient = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockGetAccessToken = vi.fn();
const mockProjectConfigVariableFindOne = vi.fn();
const mockVariableNamespaceMembershipFindOne = vi.fn();

vi.mock('../../services/auth-profile-resolver.js', () => ({
  resolveByName: (...args: unknown[]) => resolveByNameMock(...args),
  resolveAuthProfileCredentials: (...args: unknown[]) => resolveAuthProfileCredentialsMock(...args),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('../../services/auth-profile/resolve-tool-auth.js', () => ({
  resolveAuthProfileRef: (...args: unknown[]) => resolveAuthProfileRefMock(...args),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => mockIsRedisAvailable(),
  getRedisClient: () => mockGetRedisClient(),
  getRedisHandle: () => ({
    client: mockGetRedisClient(),
    isReady: () => true,
    duplicate: () =>
      mockGetRedisClient().duplicate ? mockGetRedisClient().duplicate() : mockGetRedisClient(),
    disconnect: async () => {},
  }),
}));

vi.mock('../../services/tool-oauth-service-singleton.js', () => ({
  getToolOAuthService: () => ({
    getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectConfigVariable: {
    findOne: (...args: unknown[]) => mockProjectConfigVariableFindOne(...args),
  },
  VariableNamespaceMembership: {
    findOne: (...args: unknown[]) => mockVariableNamespaceMembershipFindOne(...args),
  },
}));

const noopLookups = {
  hasSessionToken: async () => false,
  hasUserToken: async () => false,
  hasTenantToken: async () => false,
};

const allSatisfiedLookups = {
  hasSessionToken: async () => true,
  hasUserToken: async () => false,
  hasTenantToken: async () => false,
};

function makeReq(overrides: Partial<AuthRequirementIR> = {}): AuthRequirementIR {
  return {
    connector: 'gmail',
    auth_profile_ref: 'google-creds',
    connection_mode: 'per_user',
    consent_mode: 'preflight',
    ...overrides,
  };
}

describe('auth-preflight', () => {
  const sessionId = 'test-session-1';

  beforeEach(() => {
    resolveByNameMock.mockReset();
    resolveAuthProfileCredentialsMock.mockReset();
    resolveAuthProfileRefMock.mockReset();
    mockIsRedisAvailable.mockReset();
    mockGetRedisClient.mockReset();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockGetAccessToken.mockReset();
    mockIsRedisAvailable.mockReturnValue(false);
    mockGetRedisClient.mockReturnValue(null);
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockProjectConfigVariableFindOne.mockReset();
    mockVariableNamespaceMembershipFindOne.mockReset();
    mockProjectConfigVariableFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    });
    mockVariableNamespaceMembershipFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
  });

  afterEach(() => {
    cleanupAuthGate(sessionId);
  });

  describe('checkAuthPreflight', () => {
    it('returns null when no auth requirements exist', async () => {
      const result = await checkAuthPreflight(sessionId, undefined, {}, noopLookups);
      expect(result).toBeNull();
    });

    it('returns null when requirements array is empty', async () => {
      const result = await checkAuthPreflight(sessionId, [], {}, noopLookups);
      expect(result).toBeNull();
    });

    it('returns null when all requirements are inline (not preflight)', async () => {
      const reqs = [makeReq({ consent_mode: 'inline' })];
      const result = await checkAuthPreflight(sessionId, reqs, {}, noopLookups);
      expect(result).toBeNull();
    });

    it('returns null when all preflight requirements are already satisfied', async () => {
      const reqs = [makeReq()];
      const result = await checkAuthPreflight(sessionId, reqs, {}, allSatisfiedLookups);
      expect(result).toBeNull();
    });

    it('returns auth gate with pending requirements when tokens not found', async () => {
      const reqs = [
        makeReq({ connector: 'gmail', auth_profile_ref: 'google-creds' }),
        makeReq({ connector: 'calendar', auth_profile_ref: 'google-calendar-creds' }),
      ];
      const result = await checkAuthPreflight(sessionId, reqs, {}, noopLookups);
      expect(result).not.toBeNull();
      expect(result!.active).toBe(true);
      expect(result!.pending).toHaveLength(2);
      expect(result!.satisfied).toHaveLength(0);
    });

    it('returns mixed pending/satisfied when some tokens exist', async () => {
      const reqs = [
        makeReq({ connector: 'gmail', auth_profile_ref: 'google-creds' }),
        makeReq({ connector: 'salesforce', auth_profile_ref: 'sf-creds' }),
      ];
      const partialLookups = {
        hasSessionToken: async (requirement: AuthRequirementIR) =>
          requirement.auth_profile_ref === 'google-creds',
        hasUserToken: async () => false,
        hasTenantToken: async () => false,
      };
      const result = await checkAuthPreflight(sessionId, reqs, {}, partialLookups);
      expect(result).not.toBeNull();
      expect(result!.pending).toHaveLength(1);
      expect(result!.pending[0].authProfileRef).toBe('sf-creds');
      expect(result!.satisfied).toHaveLength(1);
      expect(result!.satisfied[0].authProfileRef).toBe('google-creds');
    });

    it('materializes config-var auth profile refs before returning pending requirements', async () => {
      resolveAuthProfileRefMock.mockResolvedValue('google-prod-profile');
      resolveByNameMock.mockResolvedValue({
        profileId: 'profile-123',
        authType: 'oauth2_app',
        environment: null,
        config: {},
        secrets: {},
      });

      const result = await checkAuthPreflight(
        sessionId,
        [makeReq({ auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}' })],
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          userId: 'user-1',
          environment: 'production',
        },
        noopLookups,
      );

      expect(result?.pending).toEqual([
        {
          requirementKey: 'profile:profile-123|mode:per_user',
          connector: 'gmail',
          authProfileRef: 'google-prod-profile',
          profileId: 'profile-123',
          environment: null,
          connectionMode: 'per_user',
        },
      ]);
    });

    it('scopes preflight config-var namespace membership lookups by tenant and project', async () => {
      resolveAuthProfileRefMock.mockResolvedValue('google-prod-profile');
      resolveByNameMock.mockResolvedValue({
        profileId: 'profile-123',
        authType: 'oauth2_app',
        environment: null,
        config: {},
        secrets: {},
      });
      mockProjectConfigVariableFindOne.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ _id: 'config-1', value: 'google-prod-profile' }),
        }),
      });
      mockVariableNamespaceMembershipFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'membership-1' }),
      });

      await checkAuthPreflight(
        sessionId,
        [
          makeReq({
            auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
            variable_namespace_ids: ['ns-prod'],
          }),
        ],
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          userId: 'user-1',
          environment: 'production',
        },
        noopLookups,
      );

      const configVarStore = resolveAuthProfileRefMock.mock.calls[0][3];
      await configVarStore.findConfigVar({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        key: 'AUTH_PROFILE_NAME',
        variableNamespaceIds: ['ns-prod'],
      });

      expect(mockVariableNamespaceMembershipFindOne).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        variableId: 'config-1',
        variableType: 'config',
        namespaceId: { $in: ['ns-prod'] },
      });
    });

    it('deduplicates requirements that resolve to the same auth profile', async () => {
      resolveAuthProfileRefMock.mockImplementation(async (ref: string) =>
        ref === '{{config.AUTH_PROFILE_NAME}}' ? 'google-prod-profile' : ref,
      );
      resolveByNameMock.mockResolvedValue({
        profileId: 'profile-123',
        authType: 'oauth2_app',
        environment: 'production',
        config: {},
        secrets: {},
      });

      const result = await checkAuthPreflight(
        sessionId,
        [
          makeReq({
            connector: 'gmail-read',
            auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
            scopes: ['gmail.readonly'],
          }),
          makeReq({
            connector: 'gmail-send',
            auth_profile_ref: 'google-prod-profile',
            scopes: ['gmail.send'],
          }),
        ],
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          userId: 'user-1',
          environment: 'production',
        },
        noopLookups,
      );

      expect(result?.pending).toEqual([
        {
          requirementKey: 'profile:profile-123|mode:per_user',
          connector: 'gmail-read',
          authProfileRef: 'google-prod-profile',
          profileId: 'profile-123',
          environment: 'production',
          scopes: ['gmail.readonly', 'gmail.send'],
          connectionMode: 'per_user',
        },
      ]);
    });
  });

  describe('hasActiveAuthGate', () => {
    it('returns false for unknown session', () => {
      expect(hasActiveAuthGate('nonexistent')).toBe(false);
    });

    it('returns true after checkAuthPreflight activates a gate', async () => {
      const reqs = [makeReq()];
      await checkAuthPreflight(sessionId, reqs, {}, noopLookups);
      expect(hasActiveAuthGate(sessionId)).toBe(true);
    });
  });

  describe('queueMessageBehindAuthGate', () => {
    it('returns false when no gate is active', () => {
      expect(queueMessageBehindAuthGate('no-gate', 'hello')).toBe(false);
    });

    it('queues messages when gate is active', async () => {
      await checkAuthPreflight(sessionId, [makeReq()], {}, noopLookups);
      expect(queueMessageBehindAuthGate(sessionId, 'hello')).toBe(true);
      expect(queueMessageBehindAuthGate(sessionId, 'world')).toBe(true);
      const state = getAuthGateState(sessionId);
      expect(state!.queuedMessages).toHaveLength(2);
    });

    it('preserves queued per-message metadata until the gate is satisfied', async () => {
      const metadata = {
        locale: 'en-US',
        context: { plan: 'enterprise' },
      };
      const interactionContext = {
        language: 'en',
        locale: 'en-US',
        timezone: 'America/New_York',
      };

      await checkAuthPreflight(sessionId, [makeReq()], {}, noopLookups);
      expect(
        queueMessageBehindAuthGate(sessionId, 'hello', ['att-1'], metadata, interactionContext),
      ).toBe(true);

      const result = satisfyConnector(sessionId, 'google-creds');
      expect(result).not.toBeNull();
      expect(result!.queuedMessages).toEqual([
        {
          text: 'hello',
          attachmentIds: ['att-1'],
          messageMetadata: metadata,
          interactionContext,
        },
      ]);
    });
  });

  describe('satisfyConnector', () => {
    it('returns null for unknown session', () => {
      expect(satisfyConnector('nonexistent', 'ref')).toBeNull();
    });

    it('moves connector from pending to satisfied', async () => {
      const reqs = [
        makeReq({ connector: 'gmail', auth_profile_ref: 'google-creds' }),
        makeReq({ connector: 'salesforce', auth_profile_ref: 'sf-creds' }),
      ];
      await checkAuthPreflight(sessionId, reqs, {}, noopLookups);

      const result = satisfyConnector(sessionId, 'google-creds');
      expect(result).not.toBeNull();
      expect(result!.allSatisfied).toBe(false);
      expect(result!.state.pending).toHaveLength(1);
      expect(result!.state.satisfied).toHaveLength(1);
    });

    it('unblocks session and returns queued messages when all satisfied', async () => {
      const reqs = [makeReq({ connector: 'gmail', auth_profile_ref: 'google-creds' })];
      await checkAuthPreflight(sessionId, reqs, {}, noopLookups);

      queueMessageBehindAuthGate(sessionId, 'queued message');

      const result = satisfyConnector(sessionId, 'google-creds');
      expect(result).not.toBeNull();
      expect(result!.allSatisfied).toBe(true);
      expect(result!.queuedMessages).toHaveLength(1);
      expect(result!.queuedMessages[0].text).toBe('queued message');
      expect(hasActiveAuthGate(sessionId)).toBe(false);
    });
  });

  describe('cleanupAuthGate', () => {
    it('removes auth gate state', async () => {
      await checkAuthPreflight(sessionId, [makeReq()], {}, noopLookups);
      expect(hasActiveAuthGate(sessionId)).toBe(true);
      cleanupAuthGate(sessionId);
      expect(hasActiveAuthGate(sessionId)).toBe(false);
    });
  });

  describe('queueMessageBehindAuthGate overflow', () => {
    it('throws when queue exceeds max capacity (100 messages)', async () => {
      await checkAuthPreflight(sessionId, [makeReq()], {}, noopLookups);
      // Fill the queue to capacity
      for (let i = 0; i < 100; i++) {
        expect(queueMessageBehindAuthGate(sessionId, `msg-${i}`)).toBe(true);
      }
      // 101st message should throw
      expect(() => queueMessageBehindAuthGate(sessionId, 'overflow')).toThrow(
        'Too many queued messages, please complete authentication first',
      );
      // Queue size should remain at 100
      const state = getAuthGateState(sessionId);
      expect(state!.queuedMessages).toHaveLength(100);
    });
  });

  describe('eviction at max capacity', () => {
    afterEach(() => {
      // Clean up all sessions created in this test
      for (let i = 0; i < 10001; i++) {
        cleanupAuthGate(`eviction-session-${i}`);
      }
    });

    it('evicts oldest entry when auth gate map is at max capacity', async () => {
      // Create MAX_AUTH_GATE_ENTRIES (10000) sessions
      for (let i = 0; i < 10000; i++) {
        await checkAuthPreflight(`eviction-session-${i}`, [makeReq()], {}, noopLookups);
      }
      // First session should exist
      expect(hasActiveAuthGate('eviction-session-0')).toBe(true);
      // Adding one more should evict the first
      await checkAuthPreflight('eviction-session-10000', [makeReq()], {}, noopLookups);
      expect(hasActiveAuthGate('eviction-session-10000')).toBe(true);
      // First entry should have been evicted
      expect(hasActiveAuthGate('eviction-session-0')).toBe(false);
    });
  });

  describe('persistence hardening', () => {
    it('fails closed when Redis-backed auth gate state is unavailable outside test mode', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalAllowInMemory = process.env.ALLOW_INMEMORY_AUTH_GATE_STATE_STORE;
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_INMEMORY_AUTH_GATE_STATE_STORE;
      mockIsRedisAvailable.mockReturnValue(false);
      mockGetRedisClient.mockReturnValue(null);

      try {
        await expect(checkAuthPreflight(sessionId, [makeReq()], {}, noopLookups)).rejects.toThrow(
          'Authentication state could not be persisted. Please retry.',
        );
        expect(hasActiveAuthGate(sessionId)).toBe(false);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalAllowInMemory === undefined) {
          delete process.env.ALLOW_INMEMORY_AUTH_GATE_STATE_STORE;
        } else {
          process.env.ALLOW_INMEMORY_AUTH_GATE_STATE_STORE = originalAllowInMemory;
        }
      }
    });

    it('fails closed when auth gate persistence cannot be written', async () => {
      mockIsRedisAvailable.mockReturnValue(true);
      mockGetRedisClient.mockReturnValue({
        get: mockRedisGet,
        set: mockRedisSet,
        del: mockRedisDel,
      });
      mockRedisSet.mockRejectedValueOnce(new Error('redis write failed'));

      await expect(checkAuthPreflight(sessionId, [makeReq()], {}, noopLookups)).rejects.toThrow(
        'Authentication state could not be persisted. Please retry.',
      );
      expect(hasActiveAuthGate(sessionId)).toBe(false);
    });

    it('preserves the prior queued state when a later persistence write fails', async () => {
      mockIsRedisAvailable.mockReturnValue(true);
      mockGetRedisClient.mockReturnValue({
        get: mockRedisGet,
        set: mockRedisSet,
        del: mockRedisDel,
      });

      await checkAuthPreflight(sessionId, [makeReq()], {}, noopLookups);
      expect(getAuthGateState(sessionId)?.queuedMessages).toHaveLength(0);

      mockRedisSet.mockRejectedValueOnce(new Error('redis write failed'));

      await expect(queueMessageBehindAuthGateAsync(sessionId, 'hello')).rejects.toThrow(
        'Authentication state could not be persisted. Please retry.',
      );
      expect(getAuthGateState(sessionId)?.queuedMessages).toHaveLength(0);
    });

    it('fails closed when persisted auth gate state cannot be read', async () => {
      mockIsRedisAvailable.mockReturnValue(true);
      mockGetRedisClient.mockReturnValue({
        get: mockRedisGet,
        set: mockRedisSet,
        del: mockRedisDel,
      });
      mockRedisGet.mockRejectedValueOnce(new Error('redis read failed'));

      await expect(hasActiveAuthGateAsync(sessionId)).rejects.toThrow(
        'Authentication state could not be read. Please retry.',
      );
    });
  });

  describe('createTokenLookups', () => {
    it('consults real session-scoped OAuth artifacts for anonymous SDK sessions', async () => {
      resolveByNameMock.mockResolvedValue({
        profileId: 'app-1',
        name: 'google-creds',
        authType: 'oauth2_app',
        config: {},
        secrets: {},
      });
      mockGetAccessToken.mockResolvedValueOnce('session-scoped-token');

      const lookups = createTokenLookups('tenant-1', 'project-1', 'production', {
        authScope: 'session',
        sessionPrincipal: 'sdk-session-1',
      });

      const result = await lookups.hasSessionToken(
        makeReq({
          auth_profile_ref: 'google-creds',
          scopes: ['calendar.readonly'],
        }),
        'runtime-session-1',
      );

      expect(result).toBe(true);
      expect(mockGetAccessToken).toHaveBeenCalledWith('tenant-1', 'sdk-session-1', 'google-creds', {
        projectId: 'project-1',
        environment: 'production',
        scopes: ['calendar.readonly'],
        lookupScope: 'user',
        preferAuthProfile: true,
        authScope: 'session',
      });
    });
  });
});
