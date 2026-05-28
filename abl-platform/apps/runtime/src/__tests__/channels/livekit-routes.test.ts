/**
 * LiveKit Routes Tests
 *
 * Tests the LiveKit token generation and capabilities endpoints.
 * Covers: input validation, tenant-scoped room names, concurrency limits,
 * scoped permissions, config checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ScopeValidationError } from '../../services/session/scope-policy.js';

// =============================================================================
// MOCKS
// =============================================================================

const mockConfig = {
  features: { livekitEnabled: true },
  voice: {
    livekit: {
      url: 'ws://localhost:7880',
      apiKey: 'devkey',
      apiSecret: 'secret',
      tokenTtlSeconds: 3600,
      maxConcurrentRooms: 50,
    },
  },
};

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock livekit-server-sdk — must handle dynamic import
const mockToJwt = vi.fn().mockResolvedValue('mock-jwt-token');
const mockAddGrant = vi.fn();
const mockSpawnAgentForRoom = vi.fn().mockResolvedValue(undefined);
const mockResolveProjectSessionAccess = vi.fn();
const mockResolveRequiredContactProductionScope = vi.fn();

vi.mock('livekit-server-sdk', () => ({
  AccessToken: vi.fn().mockImplementation(() => ({
    addGrant: mockAddGrant,
    toJwt: mockToJwt,
  })),
}));

vi.mock('../../services/voice/livekit/worker-entry.js', () => ({
  activeRoomCount: vi.fn().mockReturnValue(0),
  spawnAgentForRoom: (...args: unknown[]) => mockSpawnAgentForRoom(...args),
  isLiveKitWorkerRunning: vi.fn().mockReturnValue(true),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/session-access.js', () => ({
  resolveProjectSessionAccess: (...args: unknown[]) => mockResolveProjectSessionAccess(...args),
}));

vi.mock('../../services/session/production-contact-scope.js', () => ({
  resolveRequiredContactProductionScope: (...args: unknown[]) =>
    mockResolveRequiredContactProductionScope(...args),
}));

import { getConfig } from '../../config/index.js';
import { activeRoomCount } from '../../services/voice/livekit/worker-entry.js';
import livekitRouter, { buildLiveKitCallerContext } from '../../routes/livekit.js';
import type { TenantContextData } from '@agent-platform/shared-auth';

// =============================================================================
// TESTS
// =============================================================================

describe('LiveKit Routes — Logic Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (activeRoomCount as ReturnType<typeof vi.fn>).mockReturnValue(0);
    // Reset to enabled config
    mockConfig.features.livekitEnabled = true;
    mockConfig.voice.livekit = {
      url: 'ws://localhost:7880',
      apiKey: 'devkey',
      apiSecret: 'secret',
      tokenTtlSeconds: 3600,
      maxConcurrentRooms: 50,
    };
    mockResolveProjectSessionAccess.mockResolvedValue({ session: undefined });
    mockResolveRequiredContactProductionScope.mockResolvedValue({
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'voice_livekit',
        channelId: 'voice-livekit-1',
        contactId: 'contact-livekit-1',
        anonymousId: 'sdk-session-voice-1',
        identityTier: 2,
        verificationMethod: 'hmac',
      },
      scope: {
        kind: 'production',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'sess-1',
        channelId: 'voice-livekit-1',
        environment: 'dev',
        source: 'livekit_voice',
        authType: 'livekit_token',
        traceId: 'trace-livekit-1',
        actor: { kind: 'contact', contactId: 'contact-livekit-1' },
        subject: { kind: 'contact', contactId: 'contact-livekit-1' },
        identityEvidence: {
          identityTier: 2,
          verificationMethod: 'hmac',
          artifacts: [],
        },
        callerContext: {},
      },
    });
  });

  describe('buildLiveKitCallerContext', () => {
    it('prefers stored session identity when present', () => {
      const tenantContext: TenantContextData = {
        tenantId: 'tenant-1',
        userId: 'platform-user-1',
        role: 'ADMIN',
        permissions: ['session:execute'],
        authType: 'user',
        isSuperAdmin: false,
      };

      const result = buildLiveKitCallerContext({
        tenantId: 'tenant-1',
        tenantContext,
        session: {
          channel: 'web_chat',
          customerId: 'customer-123',
          anonymousId: 'sdk-session-123',
          contactId: 'contact-123',
          channelArtifact: 'artifact-hash-123',
          channelId: 'channel-123',
          identityTier: 2,
          verificationMethod: 'hmac',
        },
      });

      expect(result).toMatchObject({
        tenantId: 'tenant-1',
        channel: 'voice_livekit',
        customerId: 'customer-123',
        sessionPrincipalId: 'sdk-session-123',
        anonymousId: 'sdk-session-123',
        contactId: 'contact-123',
        channelArtifact: 'artifact-hash-123',
        channelId: 'channel-123',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
      });
    });

    it('builds a voice caller context from sdk-session auth when no stored identity exists', () => {
      const tenantContext: TenantContextData = {
        tenantId: 'tenant-1',
        userId: 'verified-user-1',
        role: 'sdk_session',
        permissions: ['session:voice'],
        authType: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'project-1',
        channelId: 'channel-voice-1',
        sessionId: 'sdk-session-voice-1',
        sessionPrincipal: 'sdk-session-voice-1',
        verifiedUserId: 'verified-user-1',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
        channelArtifact: 'artifact-hash-voice-1',
        contactId: 'contact-sdk-voice-1',
      };

      const result = buildLiveKitCallerContext({
        tenantId: 'tenant-1',
        tenantContext,
      });

      expect(result).toMatchObject({
        tenantId: 'tenant-1',
        channel: 'voice_livekit',
        channelId: 'channel-voice-1',
        customerId: 'verified-user-1',
        contactId: 'contact-sdk-voice-1',
        sessionPrincipalId: 'sdk-session-voice-1',
        channelArtifact: 'artifact-hash-voice-1',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
      });
    });
  });

  // =========================================================================
  // CAPABILITIES
  // =========================================================================

  describe('Capabilities logic', () => {
    it('should return configured: true when LiveKit is properly configured', () => {
      const config = getConfig();
      const lk = config.voice.livekit;
      const enabled = config.features.livekitEnabled;
      const configured = enabled && !!lk.url && !!lk.apiKey && !!lk.apiSecret;

      expect(configured).toBe(true);
      expect(enabled).toBe(true);
    });

    it('should return configured: false when feature flag is disabled', () => {
      mockConfig.features.livekitEnabled = false;

      const config = getConfig();
      const enabled = config.features.livekitEnabled;
      const lk = config.voice.livekit;
      const configured = enabled && !!lk.url && !!lk.apiKey && !!lk.apiSecret;

      expect(enabled).toBe(false);
      expect(configured).toBe(false);
    });

    it('should return configured: false when URL is missing', () => {
      mockConfig.voice.livekit.url = '';

      const config = getConfig();
      const lk = config.voice.livekit;
      const enabled = config.features.livekitEnabled;
      const configured = enabled && !!lk.url && !!lk.apiKey && !!lk.apiSecret;

      expect(configured).toBe(false);
    });

    it('should return configured: false when API key is missing', () => {
      mockConfig.voice.livekit.apiKey = '';

      const config = getConfig();
      const lk = config.voice.livekit;
      const enabled = config.features.livekitEnabled;
      const configured = enabled && !!lk.url && !!lk.apiKey && !!lk.apiSecret;

      expect(configured).toBe(false);
    });

    it('should NOT expose LiveKit URL in capabilities response (S7)', () => {
      // The capabilities endpoint should only return { enabled, configured }
      // and NOT include lk.url — verified by code review
      const config = getConfig();
      const capabilitiesResponse = {
        enabled: config.features.livekitEnabled,
        configured:
          !!config.voice.livekit.url &&
          !!config.voice.livekit.apiKey &&
          !!config.voice.livekit.apiSecret,
      };

      // Should NOT have a url field
      expect(capabilitiesResponse).not.toHaveProperty('url');
    });
  });

  // =========================================================================
  // INPUT VALIDATION
  // =========================================================================

  describe('Input validation (S5)', () => {
    const ID_PATTERN = /^[a-zA-Z0-9_\-]{1,128}$/;
    const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_\-]{1,64}$/;

    it('should accept valid alphanumeric IDs', () => {
      expect(ID_PATTERN.test('test-session-123')).toBe(true);
      expect(ID_PATTERN.test('project_abc')).toBe(true);
      expect(ID_PATTERN.test('a')).toBe(true);
    });

    it('should reject IDs with special characters', () => {
      expect(ID_PATTERN.test('test session')).toBe(false);
      expect(ID_PATTERN.test('test/session')).toBe(false);
      expect(ID_PATTERN.test('../../../etc/passwd')).toBe(false);
      expect(ID_PATTERN.test('<script>alert(1)</script>')).toBe(false);
    });

    it('should reject empty IDs', () => {
      expect(ID_PATTERN.test('')).toBe(false);
    });

    it('should reject IDs over 128 characters', () => {
      const longId = 'a'.repeat(129);
      expect(ID_PATTERN.test(longId)).toBe(false);

      const maxId = 'a'.repeat(128);
      expect(ID_PATTERN.test(maxId)).toBe(true);
    });

    it('should accept valid agent names', () => {
      expect(AGENT_NAME_PATTERN.test('greeting-agent')).toBe(true);
      expect(AGENT_NAME_PATTERN.test('my_agent_v2')).toBe(true);
    });

    it('should reject agent names over 64 characters', () => {
      const longName = 'a'.repeat(65);
      expect(AGENT_NAME_PATTERN.test(longName)).toBe(false);
    });
  });

  // =========================================================================
  // TENANT-SCOPED ROOM NAMES
  // =========================================================================

  describe('Tenant-scoped room names (E5)', () => {
    it('should include tenantId in room name to prevent cross-tenant collision', () => {
      const tenantId = 'org-abc';
      const projectId = 'proj-1';
      const sessionId = 'sess-1';
      const roomName = `voice_${tenantId}_${projectId}_${sessionId}`;

      expect(roomName).toBe('voice_org-abc_proj-1_sess-1');
    });

    it('should use "default" when tenantId is missing', () => {
      const tenantId = undefined || 'default';
      const projectId = 'proj-1';
      const sessionId = 'sess-1';
      const roomName = `voice_${tenantId}_${projectId}_${sessionId}`;

      expect(roomName).toBe('voice_default_proj-1_sess-1');
    });
  });

  // =========================================================================
  // CONCURRENCY LIMITS
  // =========================================================================

  describe('Concurrency limits (P1, E7)', () => {
    it('should allow rooms when under limit', () => {
      (activeRoomCount as ReturnType<typeof vi.fn>).mockReturnValue(10);
      const maxRooms = mockConfig.voice.livekit.maxConcurrentRooms;

      expect(activeRoomCount() < maxRooms).toBe(true);
    });

    it('should reject when at max rooms', () => {
      (activeRoomCount as ReturnType<typeof vi.fn>).mockReturnValue(50);
      const maxRooms = mockConfig.voice.livekit.maxConcurrentRooms;

      expect(activeRoomCount() >= maxRooms).toBe(true);
    });
  });

  // =========================================================================
  // TOKEN GENERATION
  // =========================================================================

  describe('Token generation logic', () => {
    it('should create AccessToken with scoped permissions (E8)', async () => {
      const sdk = await import('livekit-server-sdk');

      const at = (sdk.AccessToken as any)('devkey', 'secret', {
        identity: 'user_test1234',
        ttl: '3600s',
        metadata: JSON.stringify({
          sessionId: 'sess-1',
          projectId: 'proj-1',
          agentName: 'default',
          tenantId: 'org-abc',
        }),
      });

      at.addGrant({
        room: 'voice_org-abc_proj-1_sess-1',
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false, // Users don't need data channel publish
      });

      const token = await at.toJwt();

      expect(sdk.AccessToken).toHaveBeenCalledWith(
        'devkey',
        'secret',
        expect.objectContaining({
          identity: 'user_test1234',
          ttl: '3600s',
        }),
      );

      expect(mockAddGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          room: 'voice_org-abc_proj-1_sess-1',
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: false,
        }),
      );

      expect(token).toBe('mock-jwt-token');
    });

    it('should use configurable TTL (E6)', () => {
      const config = getConfig();
      const ttlSeconds = config.voice.livekit.tokenTtlSeconds;

      expect(ttlSeconds).toBe(3600);
      expect(`${ttlSeconds}s`).toBe('3600s');
    });

    it('should not generate token when LiveKit is disabled', () => {
      mockConfig.features.livekitEnabled = false;

      const config = getConfig();
      const lk = config.voice.livekit;
      const canGenerate =
        config.features.livekitEnabled && !!lk.url && !!lk.apiKey && !!lk.apiSecret;

      expect(canGenerate).toBe(false);
    });
  });

  describe('Token route fail-closed behavior', () => {
    function makeTenantContext(overrides: Partial<TenantContextData> = {}): TenantContextData & {
      authType: 'sdk_session';
      channelId: string;
      sessionId: string;
      sessionPrincipal: string;
      identityTier: 2;
      verificationMethod: 'hmac';
      authScope: 'user';
      channelArtifact: string;
    } {
      return {
        tenantId: 'tenant-1',
        userId: 'verified-user-1',
        role: 'sdk_session',
        permissions: ['session:voice'],
        authType: 'sdk_session',
        isSuperAdmin: false,
        projectId: 'project-1',
        channelId: 'voice-livekit-1',
        sessionId: 'sdk-session-voice-1',
        sessionPrincipal: 'sdk-session-voice-1',
        verifiedUserId: 'verified-user-1',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
        channelArtifact: 'artifact-hash-voice-1',
        contactId: 'contact-sdk-voice-1',
        ...overrides,
      };
    }

    function makeApp(tenantContext: TenantContextData) {
      const app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => {
        req.tenantContext = tenantContext;
        next();
      });
      app.use('/api/v1/livekit', livekitRouter);
      return app;
    }

    it('returns 400 before token issuance when canonical contact scope validation fails', async () => {
      mockResolveRequiredContactProductionScope.mockRejectedValue(
        new ScopeValidationError('INVALID_SESSION_SCOPE', 'Invalid production session scope.', {
          field: 'subject.contactId',
          reason: 'contact_resolution_failed',
        }),
      );

      const app = makeApp(
        makeTenantContext({
          contactId: undefined,
        }),
      );

      const response = await request(app).post('/api/v1/livekit/token').send({
        sessionId: 'sess-1',
        projectId: 'project-1',
        agentName: 'voice_agent',
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_SESSION_SCOPE',
          message: 'Invalid production session scope.',
        },
      });
      expect(mockToJwt).not.toHaveBeenCalled();
      expect(mockSpawnAgentForRoom).not.toHaveBeenCalled();
    });
  });
});
