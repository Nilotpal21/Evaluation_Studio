/**
 * Auth Services Tests
 *
 * Tests for:
 * - auth-service (JWT, token management, Google OAuth, device auth, tenant context)
 * - password-service (hashing, validation, strength checks)
 * - organization-service (create org, link workspace)
 * - workspace-service (create workspace, slug generation)
 * - invitation-service (create, accept, revoke, list)
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { expectRejectedMessage } from './helpers/expect-rejected-message';

// Mock server-only (imported by auth-service and @/lib/auth)
vi.mock('server-only', () => ({}));

const mockIsPlatformAdminUser = vi.hoisted(() => vi.fn());

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@abl/compiler/platform/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock @/lib/super-admin (imported by auth-service for checkIsSuperAdmin)
vi.mock('@/lib/super-admin', () => ({
  checkIsSuperAdmin: () => false,
}));

vi.mock('@/lib/platform-auth-policy', () => ({
  isPlatformAdminUser: (...args: unknown[]) => mockIsPlatformAdminUser(...args),
}));

const mockLogAuditEvent = vi.fn();

vi.mock('@/services/audit-service', () => ({
  logWorkspaceInvitationAcceptanceAudit: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

// =============================================================================
// MOCKS - auth-service dependencies
// =============================================================================

const mockFindUserById = vi.fn();
const mockFindUserByEmail = vi.fn();
const mockFindUserByGoogleId = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockCreateRefreshTokenRepo = vi.fn();
const mockFindRefreshToken = vi.fn();
const mockUpdateRefreshToken = vi.fn();
const mockRotateRefreshToken = vi.fn();
const mockFindRefreshTokensByFamily = vi.fn();
const mockRevokeRefreshTokenFamily = vi.fn();
const mockRevokeUserRefreshTokens = vi.fn();
const mockRevokeRefreshTokenByToken = vi.fn();
const mockFindTenantMembership = vi.fn();
const mockFindDefaultTenantMembership = vi.fn();
const mockFindUserTenantMemberships = vi.fn();
const mockFindUserLastActiveTenantId = vi.fn();
const mockHasInactiveTenantMemberships = vi.fn();
const mockCountPendingInvitations = vi.fn();
const mockFindPendingInvitationsForEmail = vi.fn();
const mockUpdateUserLastActiveTenantId = vi.fn();

vi.mock('@/repos/auth-repo', () => ({
  findUserById: (...args: unknown[]) => mockFindUserById(...args),
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  findUserByGoogleId: (...args: unknown[]) => mockFindUserByGoogleId(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  createRefreshToken: (...args: unknown[]) => mockCreateRefreshTokenRepo(...args),
  findRefreshToken: (...args: unknown[]) => mockFindRefreshToken(...args),
  updateRefreshToken: (...args: unknown[]) => mockUpdateRefreshToken(...args),
  rotateRefreshToken: (...args: unknown[]) => mockRotateRefreshToken(...args),
  findRefreshTokensByFamily: (...args: unknown[]) => mockFindRefreshTokensByFamily(...args),
  revokeRefreshTokenFamily: (...args: unknown[]) => mockRevokeRefreshTokenFamily(...args),
  revokeUserRefreshTokens: (...args: unknown[]) => mockRevokeUserRefreshTokens(...args),
  revokeRefreshTokenByToken: (...args: unknown[]) => mockRevokeRefreshTokenByToken(...args),
  findTenantMembership: (...args: unknown[]) => mockFindTenantMembership(...args),
  findDefaultTenantMembership: (...args: unknown[]) => mockFindDefaultTenantMembership(...args),
  findUserTenantMemberships: (...args: unknown[]) => mockFindUserTenantMemberships(...args),
  findUserLastActiveTenantId: (...args: unknown[]) => mockFindUserLastActiveTenantId(...args),
  hasInactiveTenantMemberships: (...args: unknown[]) => mockHasInactiveTenantMemberships(...args),
  countPendingInvitations: (...args: unknown[]) => mockCountPendingInvitations(...args),
  findPendingInvitationsForEmail: (...args: unknown[]) =>
    mockFindPendingInvitationsForEmail(...args),
  updateUserLastActiveTenantId: (...args: unknown[]) => mockUpdateUserLastActiveTenantId(...args),
}));

// Mock workspace-repo for organization-service and invitation-service
const mockFindTenantBySlug = vi.fn();
const mockCreateWorkspaceWithOwner = vi.fn();
const mockFindTenantMember = vi.fn();
const mockFindInvitationByEmail = vi.fn();
const mockDeleteInvitation = vi.fn();
const mockCreateInvitationRepo = vi.fn();
const mockUpdateInvitation = vi.fn();
const mockFindInvitations = vi.fn();
const mockFindInvitationByTokenWithRelations = vi.fn();
const mockCreateTenantMember = vi.fn();
const mockFindTenantById = vi.fn();
const mockUpdateTenant = vi.fn();
const mockFindTenantsForOrganization = vi.fn();
const mockCountTenantMembers = vi.fn();
const mockFindTenantMembershipsByUserId = vi.fn();

vi.mock('@/repos/workspace-repo', () => ({
  findTenantBySlug: (...args: unknown[]) => mockFindTenantBySlug(...args),
  createWorkspaceWithOwner: (...args: unknown[]) => mockCreateWorkspaceWithOwner(...args),
  findTenantMember: (...args: unknown[]) => mockFindTenantMember(...args),
  findInvitationByEmail: (...args: unknown[]) => mockFindInvitationByEmail(...args),
  deleteInvitation: (...args: unknown[]) => mockDeleteInvitation(...args),
  createInvitation: (...args: unknown[]) => mockCreateInvitationRepo(...args),
  updateInvitation: (...args: unknown[]) => mockUpdateInvitation(...args),
  findInvitations: (...args: unknown[]) => mockFindInvitations(...args),
  findInvitationByTokenWithRelations: (...args: unknown[]) =>
    mockFindInvitationByTokenWithRelations(...args),
  createTenantMember: (...args: unknown[]) => mockCreateTenantMember(...args),
  findTenantById: (...args: unknown[]) => mockFindTenantById(...args),
  updateTenant: (...args: unknown[]) => mockUpdateTenant(...args),
  findTenantsForOrganization: (...args: unknown[]) => mockFindTenantsForOrganization(...args),
  countTenantMembers: (...args: unknown[]) => mockCountTenantMembers(...args),
  findTenantMembershipsByUserId: (...args: unknown[]) => mockFindTenantMembershipsByUserId(...args),
}));

// Mock org-repo for organization-service
const mockFindOrganizationBySlug = vi.fn();
const mockCreateOrganizationRepo = vi.fn();
const mockCreateOrgMember = vi.fn();
const mockFindOrgMember = vi.fn();

vi.mock('@/repos/org-repo', () => ({
  findOrganizationBySlug: (...args: unknown[]) => mockFindOrganizationBySlug(...args),
  createOrganization: (...args: unknown[]) => mockCreateOrganizationRepo(...args),
  createOrgMember: (...args: unknown[]) => mockCreateOrgMember(...args),
  findOrgMember: (...args: unknown[]) => mockFindOrgMember(...args),
}));

// Mock @agent-platform/shared for invitation-service
vi.mock('@agent-platform/shared', () => ({
  slugify: (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, ''),
  createEmailService: () => ({
    sendEmail: vi.fn().mockResolvedValue(undefined),
  }),
  workspaceInvitationEmail: vi.fn().mockReturnValue({
    subject: 'Invitation',
    html: '<p>You have been invited</p>',
  }),
}));

// Mock @/lib/token-hash
vi.mock('@/lib/token-hash', () => ({
  hashToken: (token: string) => `hashed:${token}`,
}));

// Mock @/config
vi.mock('@/config', () => ({
  getConfig: () => ({
    jwt: {
      secret: 'test-jwt-secret-that-is-long-enough-for-signing-tokens',
      accessExpiry: '15m',
      refreshExpiry: '7d',
    },
    auth: {
      password: {
        bcryptCost: 12,
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigit: true,
        requireSpecialChar: false,
        commonPasswords: [
          'password',
          'password1',
          'Password1',
          '12345678',
          '123456789',
          'qwerty123',
          'abc12345',
          'iloveyou',
          'admin123',
          'welcome1',
          'monkey123',
          'dragon12',
          'master12',
          'letmein1',
          'football',
          'baseball',
          'trustno1',
          'sunshine',
          'princess',
          'whatever',
        ],
        historyCount: 5,
        resetTokenTtlMs: 60 * 60 * 1000,
        verificationTokenTtlMs: 24 * 60 * 60 * 1000,
      },
      lockout: { maxFailedAttempts: 5, lockDurationMs: 15 * 60 * 1000 },
      mfa: { partialTokenTtlSeconds: 300, issuer: 'KorePlatform' },
      tokens: {
        sdkSessionTtlSeconds: 14400,
        deviceAuthTtlMs: 15 * 60 * 1000,
        refreshCookieMaxAgeSeconds: 7 * 24 * 60 * 60,
        mfaCookieMaxAgeSeconds: 300,
      },
      sso: { authCodeTtlSeconds: 60, oidcStateTtlSeconds: 600, samlAssertionTtlSeconds: 3600 },
      rateLimits: { login: { maxAttempts: 10, windowMs: 15 * 60 * 1000 } },
      validation: {
        maxEmailLength: 254,
        maxPasswordLength: 128,
        maxNameLength: 200,
        emailRegex: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
      },
      workspace: { maxPerUser: 10 },
      timingProtection: { minResponseMs: 200 },
    },
    oauth: {
      microsoft: {},
      linkedin: {},
    },
    server: { frontendUrl: 'http://localhost:5173' },
    encryption: { masterKey: undefined },
  }),
  isConfigLoaded: () => true,
}));

// Mock @/lib/auth-helpers (imported transitively by invitation-service)
vi.mock('@/lib/auth-helpers', () => ({
  getFrontendUrl: () => 'http://localhost:5173',
  getEmailRegex: () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  getMicrosoftConfig: () => ({}),
  getLinkedInConfig: () => ({}),
}));

// Mock @agent-platform/shared/errors (imported transitively by invitation-service and auth-service)
vi.mock('@agent-platform/shared/errors', () => {
  class AppError extends Error {
    code: string;
    statusCode: number;
    constructor(
      message: string,
      opts?: { code?: string; statusCode?: number; cause?: unknown; messages?: string[] },
    ) {
      super(message);
      this.name = 'AppError';
      this.code = opts?.code || 'INTERNAL_ERROR';
      this.statusCode = opts?.statusCode || 500;
    }
  }
  return {
    AppError,
    ErrorCodes: {
      BAD_REQUEST: { code: 'BAD_REQUEST', statusCode: 400 },
      UNAUTHORIZED: { code: 'UNAUTHORIZED', statusCode: 401 },
      FORBIDDEN: { code: 'FORBIDDEN', statusCode: 403 },
      NOT_FOUND: { code: 'NOT_FOUND', statusCode: 404 },
      CONFLICT: { code: 'CONFLICT', statusCode: 409 },
      GONE: { code: 'GONE', statusCode: 410 },
      UNPROCESSABLE_ENTITY: { code: 'UNPROCESSABLE_ENTITY', statusCode: 422 },
      TOO_MANY_REQUESTS: { code: 'TOO_MANY_REQUESTS', statusCode: 429 },
      SERVICE_UNAVAILABLE: { code: 'SERVICE_UNAVAILABLE', statusCode: 503 },
      INTERNAL_ERROR: { code: 'INTERNAL_ERROR', statusCode: 500 },
    },
  };
});

// Mock @/services/invitation-service with actual implementation.
// The module's transitive @/ alias imports fail in dynamic-import resolution,
// but since all its dependencies are already mocked above, we load it via
// vi.importActual with its relative path.
vi.mock('@/services/invitation-service', async () => {
  return await vi.importActual('../services/invitation-service');
});

const mockBcryptHash = vi.fn(async (data: string, cost: number) => `bcrypt:${cost}:${data}`);
const mockBcryptCompare = vi.fn(async (data: string, hash: string) => hash === `bcrypt:12:${data}`);

vi.mock('bcryptjs', () => ({
  hash: (...args: Parameters<typeof mockBcryptHash>) => mockBcryptHash(...args),
  compare: (...args: Parameters<typeof mockBcryptCompare>) => mockBcryptCompare(...args),
}));

const passwordServiceModulePromise = import('../services/auth/password-service');
const authServiceModulePromise = import('../services/auth-service');

// =============================================================================
// PASSWORD SERVICE TESTS
// =============================================================================

describe('Password Service', () => {
  let passwordService: typeof import('../services/auth/password-service');

  beforeAll(async () => {
    passwordService = await passwordServiceModulePromise;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasInactiveTenantMemberships.mockResolvedValue(false);
  });

  describe('hashPassword', () => {
    test('hashes password with bcrypt', async () => {
      const result = await passwordService.hashPassword('MyPassword123');
      expect(result).toBe('bcrypt:12:MyPassword123');
    });

    test('different passwords produce different hashes', async () => {
      const hash1 = await passwordService.hashPassword('Password1');
      const hash2 = await passwordService.hashPassword('Password2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    test('returns true for matching password', async () => {
      const result = await passwordService.verifyPassword(
        'MyPassword123',
        'bcrypt:12:MyPassword123',
      );
      expect(result).toBe(true);
    });

    test('returns false for non-matching password', async () => {
      const result = await passwordService.verifyPassword(
        'WrongPassword',
        'bcrypt:12:MyPassword123',
      );
      expect(result).toBe(false);
    });
  });

  describe('validatePasswordStrength', () => {
    test('accepts a strong password', () => {
      const result = passwordService.validatePasswordStrength('MyStr0ngP@ss');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('rejects password shorter than 8 characters', () => {
      const result = passwordService.validatePasswordStrength('Ab1cde');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters long');
    });

    test('rejects password without uppercase letter', () => {
      const result = passwordService.validatePasswordStrength('lowercase123');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one uppercase letter');
    });

    test('rejects password without lowercase letter', () => {
      const result = passwordService.validatePasswordStrength('UPPERCASE123');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one lowercase letter');
    });

    test('rejects password without a number', () => {
      const result = passwordService.validatePasswordStrength('NoNumbersHere');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one number');
    });

    test('rejects common passwords', () => {
      const result = passwordService.validatePasswordStrength('Password1');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password is too common, please choose a stronger password');
    });

    test('rejects common passwords case-insensitively', () => {
      const result = passwordService.validatePasswordStrength('TRUSTNO1');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password is too common, please choose a stronger password');
    });

    test('reports multiple validation errors at once', () => {
      const result = passwordService.validatePasswordStrength('abc');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    test('accepts boundary length password (exactly 8 chars)', () => {
      const result = passwordService.validatePasswordStrength('Abcdef1x');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});

// =============================================================================
// AUTH SERVICE TESTS
// =============================================================================

describe('Auth Service', () => {
  let authService: typeof import('../services/auth-service');

  beforeAll(async () => {
    authService = await authServiceModulePromise;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformAdminUser.mockResolvedValue(false);
    mockFindUserTenantMemberships.mockResolvedValue([]);
    mockFindUserLastActiveTenantId.mockResolvedValue(null);
    mockHasInactiveTenantMemberships.mockResolvedValue(false);
    mockUpdateUserLastActiveTenantId.mockResolvedValue(undefined);
  });

  describe('createAccessToken / verifyAccessToken', () => {
    test('creates a valid JWT access token', () => {
      const token = authService.createAccessToken({ id: 'user-1', email: 'test@example.com' });
      expect(token).toBeTruthy();
      expect(token.split('.')).toHaveLength(3);
    });

    test('verifies a valid access token', () => {
      const token = authService.createAccessToken({ id: 'user-1', email: 'test@example.com' });
      const payload = authService.verifyAccessToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('user-1');
      expect(payload!.email).toBe('test@example.com');
      expect(payload!.type).toBe('access');
    });

    test('includes tenant context in token when provided', () => {
      const tenantCtx = { tenantId: 'tenant-1', role: 'ADMIN', orgId: 'org-1' };
      const token = authService.createAccessToken(
        { id: 'user-1', email: 'test@example.com' },
        tenantCtx,
      );
      const payload = authService.verifyAccessToken(token);
      expect(payload!.tenantId).toBe('tenant-1');
      expect(payload!.role).toBe('ADMIN');
      expect(payload!.orgId).toBe('org-1');
    });

    test('returns null for invalid token', () => {
      const result = authService.verifyAccessToken('invalid.token.here');
      expect(result).toBeNull();
    });

    test('returns null for a non-access type token', () => {
      const partialToken = authService.createPartialToken({
        id: 'user-1',
        email: 'test@example.com',
      });
      const result = authService.verifyAccessToken(partialToken);
      expect(result).toBeNull();
    });

    test('sets tokenClass to user', () => {
      const token = authService.createAccessToken({ id: 'user-1', email: 'test@example.com' });
      const payload = authService.verifyAccessToken(token);
      expect(payload!.tokenClass).toBe('user');
    });
  });

  describe('createPartialToken', () => {
    test('creates a token with type mfa_pending', () => {
      const token = authService.createPartialToken({ id: 'user-1', email: 'test@example.com' });
      expect(token).toBeTruthy();
      // Decode the token manually to check the type
      const [, payloadPart] = token.split('.');
      const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf-8'));
      expect(decoded.type).toBe('mfa_pending');
      expect(decoded.sub).toBe('user-1');
    });
  });

  describe('createRefreshToken', () => {
    test('creates a refresh token and stores hashed version', async () => {
      mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-1' });

      const result = await authService.createRefreshToken('user-1');

      expect(result.token).toBeTruthy();
      expect(result.token.length).toBeGreaterThan(32);
      expect(result.id).toBe('rt-1');
      expect(result.familyId).toBeTruthy();
      expect(result.generation).toBe(1);
      expect(mockCreateRefreshTokenRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          token: expect.stringContaining('hashed:'),
          userId: 'user-1',
          expiresAt: expect.any(Date),
          familyId: expect.any(String),
          generation: 1,
        }),
      );
    });
  });

  describe('createTokenPair', () => {
    test('returns access and refresh tokens with expiry', async () => {
      mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-1' });

      const pair = await authService.createTokenPair({ id: 'user-1', email: 'test@example.com' });

      expect(pair.accessToken).toBeTruthy();
      expect(pair.refreshToken).toBeTruthy();
      expect(pair.expiresIn).toBeGreaterThan(0);
    });

    test('includes tenant context in access token when provided', async () => {
      mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-1' });
      const tenantCtx = { tenantId: 't-1', role: 'OWNER' };

      const pair = await authService.createTokenPair(
        { id: 'user-1', email: 'test@example.com' },
        tenantCtx,
      );
      const payload = authService.verifyAccessToken(pair.accessToken);

      expect(payload!.tenantId).toBe('t-1');
      expect(payload!.role).toBe('OWNER');
    });
  });

  describe('refreshTokens', () => {
    test('returns null for non-existent token', async () => {
      mockFindRefreshToken.mockResolvedValue(null);

      const result = await authService.refreshTokens('non-existent-token');
      expect(result).toBeNull();
    });

    test('revokes all tokens on reuse of revoked token without family', async () => {
      mockFindRefreshToken.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 10000),
        familyId: null,
        generation: 1,
      });

      const result = await authService.refreshTokens('reused-token');
      expect(result).toBeNull();
      expect(mockRevokeUserRefreshTokens).toHaveBeenCalledWith('user-1');
    });

    test('returns null for expired token', async () => {
      mockFindRefreshToken.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 10000),
      });

      const result = await authService.refreshTokens('expired-token');
      expect(result).toBeNull();
    });

    test('rotates token and strips archived workspace context when auth-repo excludes it', async () => {
      const archivedWorkspaceMembership = {
        tenantId: 'tenant-archived',
        role: 'ADMIN',
        status: 'active',
        tenant: { id: 'tenant-archived', status: 'archived', organizationId: 'org-1' },
      };

      mockFindRefreshToken.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 600000),
        familyId: 'family-1',
        generation: 1,
        user: { id: 'user-1', email: 'test@example.com' },
      });
      mockRotateRefreshToken.mockResolvedValue({ id: 'rt-1', revokedAt: new Date() });
      mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-2' });
      mockFindDefaultTenantMembership.mockImplementation(async () => {
        expect(archivedWorkspaceMembership.tenant.status).toBe('archived');
        return null;
      });

      const result = await authService.refreshTokens('valid-token');

      expect(result).not.toBeNull();
      expect(result!.accessToken).toBeTruthy();
      expect(result!.refreshToken).toBeTruthy();
      expect(mockRotateRefreshToken).toHaveBeenCalledWith('rt-1', { revokedAt: expect.any(Date) });

      const payload = authService.verifyAccessToken(result!.accessToken);
      expect(payload?.tenantId).toBeUndefined();
      expect(payload?.role).toBeUndefined();
    });

    test('includes active tenant context when refresh resolves an active workspace', async () => {
      mockFindRefreshToken.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 600000),
        familyId: 'family-1',
        generation: 1,
        user: { id: 'user-1', email: 'test@example.com' },
      });
      mockRotateRefreshToken.mockResolvedValue({ id: 'rt-1', revokedAt: new Date() });
      mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-2' });
      mockFindDefaultTenantMembership.mockResolvedValue({
        tenantId: 'tenant-1',
        role: 'ADMIN',
        tenant: { organizationId: 'org-1' },
      });

      const result = await authService.refreshTokens('valid-token');

      expect(result).not.toBeNull();
      const payload = authService.verifyAccessToken(result!.accessToken);
      expect(payload?.tenantId).toBe('tenant-1');
      expect(payload?.role).toBe('ADMIN');
      expect(payload?.orgId).toBe('org-1');
    });

    test('prefers the requested tenant context when refresh is scoped to a switched workspace', async () => {
      mockFindRefreshToken.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 600000),
        familyId: 'family-1',
        generation: 1,
        user: { id: 'user-1', email: 'test@example.com' },
      });
      mockRotateRefreshToken.mockResolvedValue({ id: 'rt-1', revokedAt: new Date() });
      mockCreateRefreshTokenRepo.mockResolvedValue({ id: 'rt-2' });
      mockFindTenantMembership.mockResolvedValue({
        tenantId: 'tenant-2',
        role: 'MEMBER',
        tenant: { organizationId: 'org-2' },
      });

      const result = await authService.refreshTokens('valid-token', 'tenant-2');

      expect(mockFindTenantMembership).toHaveBeenCalledWith('user-1', 'tenant-2');
      expect(mockFindDefaultTenantMembership).not.toHaveBeenCalled();
      expect(result).not.toBeNull();
      const payload = authService.verifyAccessToken(result!.accessToken);
      expect(payload?.tenantId).toBe('tenant-2');
      expect(payload?.role).toBe('MEMBER');
      expect(payload?.orgId).toBe('org-2');
    });
  });

  describe('revokeRefreshToken', () => {
    test('returns true when token is found and revoked', async () => {
      mockRevokeRefreshTokenByToken.mockResolvedValue(1);
      const result = await authService.revokeRefreshToken('valid-token');
      expect(result).toBe(true);
    });

    test('returns false when token is not found', async () => {
      mockRevokeRefreshTokenByToken.mockResolvedValue(0);
      const result = await authService.revokeRefreshToken('bad-token');
      expect(result).toBe(false);
    });
  });

  describe('revokeAllUserTokens', () => {
    test('calls revokeUserRefreshTokens with userId', async () => {
      mockRevokeUserRefreshTokens.mockResolvedValue(undefined);
      await authService.revokeAllUserTokens('user-1');
      expect(mockRevokeUserRefreshTokens).toHaveBeenCalledWith('user-1');
    });
  });

  describe('resolveUserTenantContext', () => {
    test('returns tenant context for user with membership', async () => {
      mockFindDefaultTenantMembership.mockResolvedValue({
        tenantId: 'tenant-1',
        role: 'ADMIN',
        tenant: { organizationId: 'org-1' },
      });

      const ctx = await authService.resolveUserTenantContext('user-1');
      expect(ctx).toEqual({
        tenantId: 'tenant-1',
        role: 'ADMIN',
        orgId: 'org-1',
      });
    });

    test('prefers an organization-linked workspace over a newer personal workspace', async () => {
      mockFindUserTenantMemberships.mockResolvedValue([
        {
          tenantId: 'tenant-personal',
          role: 'MEMBER',
          createdAt: '2026-04-12T10:00:00.000Z',
          tenant: { organizationId: null },
        },
        {
          tenantId: 'tenant-enterprise',
          role: 'ADMIN',
          createdAt: '2026-04-01T10:00:00.000Z',
          tenant: { organizationId: 'org-1' },
        },
      ]);

      const ctx = await authService.resolveUserTenantContext('user-1');

      expect(ctx).toEqual({
        tenantId: 'tenant-enterprise',
        role: 'ADMIN',
        orgId: 'org-1',
      });
      expect(mockFindDefaultTenantMembership).not.toHaveBeenCalled();
    });

    test('prefers the last active workspace over organization and recency heuristics', async () => {
      mockFindUserTenantMemberships.mockResolvedValue([
        {
          tenantId: 'tenant-personal',
          role: 'MEMBER',
          createdAt: '2026-04-12T10:00:00.000Z',
          tenant: { organizationId: null },
        },
        {
          tenantId: 'tenant-enterprise',
          role: 'ADMIN',
          createdAt: '2026-04-01T10:00:00.000Z',
          tenant: { organizationId: 'org-1' },
        },
      ]);
      mockFindUserLastActiveTenantId.mockResolvedValue('tenant-personal');

      const ctx = await authService.resolveUserTenantContext('user-1');

      expect(ctx).toEqual({
        tenantId: 'tenant-personal',
        role: 'MEMBER',
        orgId: undefined,
      });
      expect(mockFindDefaultTenantMembership).not.toHaveBeenCalled();
    });

    test('prefers the most recently joined active workspace when no organization workspace exists', async () => {
      mockFindUserTenantMemberships.mockResolvedValue([
        {
          tenantId: 'tenant-older',
          role: 'MEMBER',
          createdAt: '2026-03-01T10:00:00.000Z',
          tenant: { organizationId: null },
        },
        {
          tenantId: 'tenant-newer',
          role: 'VIEWER',
          createdAt: '2026-04-12T10:00:00.000Z',
          tenant: { organizationId: null },
        },
      ]);

      const ctx = await authService.resolveUserTenantContext('user-1');

      expect(ctx).toEqual({
        tenantId: 'tenant-newer',
        role: 'VIEWER',
        orgId: undefined,
      });
      expect(mockFindDefaultTenantMembership).not.toHaveBeenCalled();
    });

    test('returns null when user has no membership', async () => {
      mockFindDefaultTenantMembership.mockResolvedValue(null);

      const ctx = await authService.resolveUserTenantContext('user-1');
      expect(ctx).toBeNull();
    });

    test('throws when only inactive memberships remain', async () => {
      const deactivatedMembership = {
        tenantId: 'tenant-1',
        role: 'MEMBER',
        status: 'deactivated',
        tenant: { id: 'tenant-1', status: 'active', organizationId: null },
      };
      mockFindDefaultTenantMembership.mockImplementation(async () => {
        expect(deactivatedMembership.status).toBe('deactivated');
        expect(deactivatedMembership.tenant.status).toBe('active');
        return null;
      });
      mockHasInactiveTenantMemberships.mockResolvedValue(true);

      await expectRejectedMessage(
        authService.resolveUserTenantContext('user-1'),
        'Workspace membership is not active',
      );
    });

    test('returns null for DB-managed platform admins with inactive memberships', async () => {
      mockFindDefaultTenantMembership.mockResolvedValue(null);
      mockHasInactiveTenantMemberships.mockResolvedValue(true);
      mockIsPlatformAdminUser.mockResolvedValue(true);

      const ctx = await authService.resolveUserTenantContext('user-1', {
        platformAdminEmail: 'admin@example.com',
      });

      expect(ctx).toBeNull();
      expect(mockIsPlatformAdminUser).toHaveBeenCalledWith({
        id: 'user-1',
        email: 'admin@example.com',
      });
    });

    test('throws on error', async () => {
      mockFindDefaultTenantMembership.mockRejectedValue(new Error('DB error'));

      await expectRejectedMessage(authService.resolveUserTenantContext('user-1'), 'DB error');
    });

    test('omits orgId when tenant has no organizationId', async () => {
      mockFindDefaultTenantMembership.mockResolvedValue({
        tenantId: 'tenant-1',
        role: 'MEMBER',
        tenant: { organizationId: null },
      });

      const ctx = await authService.resolveUserTenantContext('user-1');
      expect(ctx!.orgId).toBeUndefined();
    });
  });

  describe('getUserTenants', () => {
    test('returns formatted list of tenant memberships', async () => {
      mockFindUserTenantMemberships.mockResolvedValue([
        {
          tenantId: 't-1',
          tenant: { name: 'Workspace A', organizationId: 'org-1' },
          role: 'OWNER',
        },
        { tenantId: 't-2', tenant: { name: 'Workspace B', organizationId: null }, role: 'MEMBER' },
      ]);

      const tenants = await authService.getUserTenants('user-1');

      expect(tenants).toHaveLength(2);
      expect(tenants[0]).toEqual({
        tenantId: 't-1',
        tenantName: 'Workspace A',
        role: 'OWNER',
        orgId: 'org-1',
      });
      expect(tenants[1].orgId).toBeUndefined();
    });

    test('skips memberships whose active-tenant join is missing', async () => {
      mockFindUserTenantMemberships.mockResolvedValue([
        {
          tenantId: 't-1',
          tenant: { name: 'Workspace A', organizationId: 'org-1' },
          role: 'OWNER',
        },
        {
          tenantId: 't-archived',
          role: 'MEMBER',
        },
      ]);

      const tenants = await authService.getUserTenants('user-1');

      expect(tenants).toEqual([
        {
          tenantId: 't-1',
          tenantName: 'Workspace A',
          role: 'OWNER',
          orgId: 'org-1',
        },
      ]);
    });
  });

  describe('switchTenant', () => {
    test('returns new access token with tenant context', async () => {
      mockFindTenantMembership.mockResolvedValue({
        tenantId: 't-1',
        role: 'ADMIN',
        tenant: { organizationId: 'org-1' },
      });

      const result = await authService.switchTenant(
        { id: 'user-1', email: 'test@example.com' },
        't-1',
      );

      expect(result.accessToken).toBeTruthy();
      expect(result.tenantContext.tenantId).toBe('t-1');
      expect(result.tenantContext.role).toBe('ADMIN');
      expect(mockUpdateUserLastActiveTenantId).toHaveBeenCalledWith('user-1', 't-1');
    });

    test('preserves DB-managed platform admin claim when switching tenants', async () => {
      mockFindTenantMembership.mockResolvedValue({
        tenantId: 't-1',
        role: 'ADMIN',
        tenant: { organizationId: 'org-1' },
      });
      mockIsPlatformAdminUser.mockResolvedValue(true);

      const result = await authService.switchTenant(
        { id: 'user-1', email: 'admin@example.com' },
        't-1',
      );
      const payload = authService.verifyAccessToken(result.accessToken);

      expect(mockIsPlatformAdminUser).toHaveBeenCalledWith({
        id: 'user-1',
        email: 'admin@example.com',
      });
      expect(payload?.isSuperAdmin).toBe(true);
    });

    test('throws when user is not a member of target tenant', async () => {
      mockFindTenantMembership.mockResolvedValue(null);

      await expectRejectedMessage(
        authService.switchTenant({ id: 'user-1', email: 'test@example.com' }, 't-999'),
        'Not a member of this tenant',
      );
    });

    test('throws when auth-repo excludes an archived workspace membership', async () => {
      const archivedWorkspaceMembership = {
        tenantId: 't-archived',
        role: 'ADMIN',
        status: 'active',
        tenant: { id: 't-archived', status: 'archived', organizationId: 'org-1' },
      };
      mockFindTenantMembership.mockImplementation(async () => {
        expect(archivedWorkspaceMembership.tenant.status).toBe('archived');
        return null;
      });

      await expectRejectedMessage(
        authService.switchTenant(
          { id: 'user-1', email: 'test@example.com' },
          archivedWorkspaceMembership.tenantId,
        ),
        'Not a member of this tenant',
      );
    });
  });

  describe('findOrCreateGoogleUser', () => {
    test('returns existing user found by googleId', async () => {
      const existingUser = {
        id: 'user-1',
        googleId: 'google-123',
        email: 'test@example.com',
        name: 'Test User',
      };
      mockFindUserByGoogleId.mockResolvedValue(existingUser);
      mockUpdateUser.mockResolvedValue({ ...existingUser, lastLoginAt: new Date() });

      const result = await authService.findOrCreateGoogleUser({
        googleId: 'google-123',
        email: 'test@example.com',
        name: 'Test User',
      });

      expect(result.id).toBe('user-1');
      expect(mockUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ lastLoginAt: expect.any(Date) }),
      );
    });

    test('links to existing email-only (no password) user', async () => {
      mockFindUserByGoogleId.mockResolvedValue(null);
      mockFindUserByEmail.mockResolvedValue({
        id: 'user-2',
        email: 'test@example.com',
        passwordHash: null,
      });
      mockUpdateUser.mockResolvedValue({ id: 'user-2', googleId: 'google-456' });

      const result = await authService.findOrCreateGoogleUser({
        googleId: 'google-456',
        email: 'test@example.com',
      });

      expect(result.id).toBe('user-2');
      expect(mockUpdateUser).toHaveBeenCalledWith(
        'user-2',
        expect.objectContaining({ googleId: 'google-456' }),
      );
    });

    test('throws when email matches a password-based account', async () => {
      mockFindUserByGoogleId.mockResolvedValue(null);
      mockFindUserByEmail.mockResolvedValue({
        id: 'user-3',
        email: 'test@example.com',
        passwordHash: 'hash123',
      });

      await expectRejectedMessage(
        authService.findOrCreateGoogleUser({
          googleId: 'google-789',
          email: 'test@example.com',
        }),
        'An account with this email already exists',
      );
    });

    test('creates a new user when no existing user found', async () => {
      mockFindUserByGoogleId.mockResolvedValue(null);
      mockFindUserByEmail.mockResolvedValue(null);
      mockCreateUser.mockResolvedValue({
        id: 'user-new',
        email: 'new@example.com',
        googleId: 'google-new',
        authProvider: 'google',
      });

      const result = await authService.findOrCreateGoogleUser({
        googleId: 'google-new',
        email: 'NEW@EXAMPLE.COM',
        name: 'New User',
      });

      expect(result.id).toBe('user-new');
      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@example.com', // normalized
          authProvider: 'google',
        }),
      );
    });
  });

  describe('getPendingInvitationCount', () => {
    test('normalizes email and returns count', async () => {
      mockCountPendingInvitations.mockResolvedValue(3);

      const count = await authService.getPendingInvitationCount('  TEST@EXAMPLE.COM  ');

      expect(count).toBe(3);
      expect(mockCountPendingInvitations).toHaveBeenCalledWith('test@example.com');
    });
  });

  // Device auth tests removed — Runtime owns device auth flow.
  // See apps/runtime/src/__tests__/device-auth-*.test.ts
});

// =============================================================================
// WORKSPACE SERVICE TESTS
// =============================================================================

describe('Workspace Service', () => {
  let workspaceService: typeof import('../services/workspace-service');

  beforeEach(async () => {
    vi.clearAllMocks();
    workspaceService = await import('../services/workspace-service');
  });

  describe('generateUniqueSlug', () => {
    test('returns base slug when no collision', async () => {
      mockFindTenantBySlug.mockResolvedValue(null);

      const slug = await workspaceService.generateUniqueSlug('My Workspace');
      expect(slug).toBe('my-workspace');
    });

    test('appends timestamp suffix on collision', async () => {
      mockFindTenantBySlug.mockResolvedValue({ id: 'existing-1' });

      const slug = await workspaceService.generateUniqueSlug('My Workspace');
      expect(slug).toMatch(/^my-workspace-[a-z0-9]+$/);
    });
  });

  describe('createWorkspace', () => {
    test('creates workspace with generated slug', async () => {
      mockFindTenantBySlug.mockResolvedValue(null);
      mockCreateWorkspaceWithOwner.mockResolvedValue({
        tenant: { id: 'ws-1', name: 'Test Workspace', slug: 'test-workspace' },
        member: { id: 'mem-1' },
      });

      const result = await workspaceService.createWorkspace({
        name: 'Test Workspace',
        ownerId: 'user-1',
      });

      expect(result.id).toBe('ws-1');
      expect(result.name).toBe('Test Workspace');
      expect(result.slug).toBe('test-workspace');
      expect(mockCreateWorkspaceWithOwner).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Test Workspace', ownerId: 'user-1' }),
        expect.objectContaining({ role: 'OWNER' }),
      );
    });

    test('uses provided slug when given', async () => {
      mockCreateWorkspaceWithOwner.mockResolvedValue({
        tenant: { id: 'ws-2', name: 'Custom', slug: 'custom-slug' },
        member: { id: 'mem-1' },
      });

      const result = await workspaceService.createWorkspace({
        name: 'Custom',
        slug: 'custom-slug',
        ownerId: 'user-1',
      });

      expect(result.slug).toBe('custom-slug');
    });
  });

  describe('createDefaultWorkspace', () => {
    test('creates workspace with user name', async () => {
      mockFindTenantBySlug.mockResolvedValue(null);
      mockCreateWorkspaceWithOwner.mockResolvedValue({
        tenant: { id: 'ws-3', name: 'Alice Workspace', slug: 'alice-workspace' },
        member: { id: 'mem-1' },
      });

      const result = await workspaceService.createDefaultWorkspace('user-1', 'Alice');
      expect(result.name).toBe('Alice Workspace');
    });

    test('uses "My" when no name provided', async () => {
      mockFindTenantBySlug.mockResolvedValue(null);
      mockCreateWorkspaceWithOwner.mockResolvedValue({
        tenant: { id: 'ws-4', name: 'My Workspace', slug: 'my-workspace' },
        member: { id: 'mem-1' },
      });

      await workspaceService.createDefaultWorkspace('user-1');
      expect(mockCreateWorkspaceWithOwner).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My Workspace' }),
        expect.any(Object),
      );
    });
  });
});

// =============================================================================
// ORGANIZATION SERVICE TESTS
// =============================================================================

describe('Organization Service', () => {
  let orgService: typeof import('../services/organization-service');

  beforeEach(async () => {
    vi.clearAllMocks();
    orgService = await import('../services/organization-service');
  });

  describe('createOrganization', () => {
    test('creates organization with slug and membership', async () => {
      mockFindOrganizationBySlug.mockResolvedValue(null);
      mockCreateOrganizationRepo.mockResolvedValue({ id: 'org-1', name: 'My Org', slug: 'my-org' });
      mockCreateOrgMember.mockResolvedValue({});

      const result = await orgService.createOrganization({
        name: 'My Org',
        ownerId: 'user-1',
        billingEmail: 'billing@example.com',
      });

      expect(result.id).toBe('org-1');
      expect(result.slug).toBe('my-org');
      expect(mockCreateOrgMember).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', role: 'ORG_OWNER' }),
      );
    });

    test('appends suffix when slug already exists', async () => {
      mockFindOrganizationBySlug.mockResolvedValue({ id: 'existing-org' });
      mockCreateOrganizationRepo.mockResolvedValue({
        id: 'org-2',
        name: 'My Org',
        slug: 'my-org-abc123',
      });
      mockCreateOrgMember.mockResolvedValue({});

      const result = await orgService.createOrganization({
        name: 'My Org',
        ownerId: 'user-1',
        billingEmail: 'billing@example.com',
      });

      expect(result.id).toBe('org-2');
    });

    test('links initial tenant when provided and user is owner', async () => {
      mockFindOrganizationBySlug.mockResolvedValue(null);
      mockCreateOrganizationRepo.mockResolvedValue({
        id: 'org-3',
        name: 'Linked Org',
        slug: 'linked-org',
      });
      mockCreateOrgMember.mockResolvedValue({});
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockUpdateTenant.mockResolvedValue({});

      const result = await orgService.createOrganization({
        name: 'Linked Org',
        ownerId: 'user-1',
        billingEmail: 'billing@example.com',
        initialTenantId: 'tenant-1',
      });

      expect(result.id).toBe('org-3');
      expect(mockUpdateTenant).toHaveBeenCalledWith('tenant-1', { organizationId: 'org-3' });
    });

    test('throws when non-owner tries to link initial tenant', async () => {
      mockFindOrganizationBySlug.mockResolvedValue(null);
      mockCreateOrganizationRepo.mockResolvedValue({ id: 'org-4', name: 'Org', slug: 'org' });
      mockCreateOrgMember.mockResolvedValue({});
      mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

      await expectRejectedMessage(
        orgService.createOrganization({
          name: 'Org',
          ownerId: 'user-1',
          billingEmail: 'billing@example.com',
          initialTenantId: 'tenant-1',
        }),
        'Only workspace owners can link workspaces to organizations',
      );
    });
  });

  describe('linkWorkspaceToOrg', () => {
    test('links workspace when both org and tenant membership valid', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindOrgMember.mockResolvedValue({ role: 'ORG_OWNER' });
      mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: null });
      mockUpdateTenant.mockResolvedValue({});

      await orgService.linkWorkspaceToOrg('tenant-1', 'org-1', 'user-1');

      expect(mockUpdateTenant).toHaveBeenCalledWith('tenant-1', { organizationId: 'org-1' });
    });

    test('throws when requester is not tenant OWNER', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });

      await expectRejectedMessage(
        orgService.linkWorkspaceToOrg('tenant-1', 'org-1', 'user-1'),
        'Only workspace owners can link workspaces to organizations',
      );
    });

    test('throws when requester has no tenant membership', async () => {
      mockFindTenantMember.mockResolvedValue(null);

      await expectRejectedMessage(
        orgService.linkWorkspaceToOrg('tenant-1', 'org-1', 'user-1'),
        'Only workspace owners can link workspaces to organizations',
      );
    });

    test('throws when requester is not ORG_OWNER or ORG_ADMIN', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindOrgMember.mockResolvedValue({ role: 'ORG_MEMBER' });

      await expectRejectedMessage(
        orgService.linkWorkspaceToOrg('tenant-1', 'org-1', 'user-1'),
        'Only organization owners and admins can link workspaces',
      );
    });

    test('throws when workspace is already linked to different org', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindOrgMember.mockResolvedValue({ role: 'ORG_ADMIN' });
      mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'other-org' });

      await expectRejectedMessage(
        orgService.linkWorkspaceToOrg('tenant-1', 'org-1', 'user-1'),
        'This workspace is already linked to another organization',
      );
    });

    test('throws when workspace not found', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindOrgMember.mockResolvedValue({ role: 'ORG_OWNER' });
      mockFindTenantById.mockResolvedValue(null);

      await expectRejectedMessage(
        orgService.linkWorkspaceToOrg('tenant-1', 'org-1', 'user-1'),
        'Workspace not found',
      );
    });

    test('allows re-link to same org (idempotent)', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindOrgMember.mockResolvedValue({ role: 'ORG_OWNER' });
      mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
      mockUpdateTenant.mockResolvedValue({});

      await orgService.linkWorkspaceToOrg('tenant-1', 'org-1', 'user-1');
      expect(mockUpdateTenant).toHaveBeenCalledWith('tenant-1', { organizationId: 'org-1' });
    });
  });

  describe('getOrganizationWorkspaces', () => {
    test('returns workspaces with member counts', async () => {
      mockFindTenantsForOrganization.mockResolvedValue([
        { id: 't-1', name: 'WS 1', slug: 'ws-1', status: 'active' },
        { id: 't-2', name: 'WS 2', slug: 'ws-2', status: 'active' },
      ]);
      mockCountTenantMembers.mockResolvedValueOnce(5).mockResolvedValueOnce(3);

      const results = await orgService.getOrganizationWorkspaces('org-1');

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: 't-1',
        name: 'WS 1',
        slug: 'ws-1',
        status: 'active',
        memberCount: 5,
      });
      expect(results[1].memberCount).toBe(3);
    });
  });
});

// =============================================================================
// INVITATION SERVICE TESTS
// =============================================================================

describe('Invitation Service', () => {
  let invitationService: typeof import('../services/invitation-service');

  beforeEach(async () => {
    vi.clearAllMocks();
    invitationService = await import('../services/invitation-service');
  });

  describe('createInvitation', () => {
    test('creates invitation for valid OWNER inviter', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindUserByEmail.mockResolvedValue(null);
      mockFindInvitationByEmail.mockResolvedValue(null);
      mockCreateInvitationRepo.mockResolvedValue({
        id: 'inv-1',
        email: 'invite@example.com',
        role: 'MEMBER',
        status: 'pending',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      mockFindUserById.mockResolvedValue({ name: 'Admin', email: 'admin@example.com' });
      mockFindTenantById.mockResolvedValue({ name: 'Test Workspace' });

      const result = await invitationService.createInvitation({
        tenantId: 'tenant-1',
        email: 'invite@example.com',
        role: 'MEMBER',
        invitedBy: 'user-1',
      });

      expect(result.id).toBe('inv-1');
      expect(result.role).toBe('MEMBER');
      expect(result.status).toBe('pending');
    });

    test('throws when inviter is not a member', async () => {
      mockFindTenantMember.mockResolvedValue(null);

      await expectRejectedMessage(
        invitationService.createInvitation({
          tenantId: 'tenant-1',
          email: 'invite@example.com',
          role: 'MEMBER',
          invitedBy: 'user-1',
        }),
        'Inviter is not a member of this workspace',
      );
    });

    test('throws when ADMIN tries to invite OWNER', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });

      await expectRejectedMessage(
        invitationService.createInvitation({
          tenantId: 'tenant-1',
          email: 'invite@example.com',
          role: 'OWNER',
          invitedBy: 'user-1',
        }),
        'Admins cannot invite users with OWNER role',
      );
    });

    test('throws when MEMBER tries to send invitation', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

      await expectRejectedMessage(
        invitationService.createInvitation({
          tenantId: 'tenant-1',
          email: 'invite@example.com',
          role: 'VIEWER',
          invitedBy: 'user-1',
        }),
        'Only workspace owners and admins can send invitations',
      );
    });

    test('throws when user is already a member', async () => {
      mockFindTenantMember
        .mockResolvedValueOnce({ role: 'OWNER' }) // inviter check
        .mockResolvedValueOnce({ role: 'MEMBER' }); // existing membership check
      mockFindUserByEmail.mockResolvedValue({ id: 'user-existing' });

      await expectRejectedMessage(
        invitationService.createInvitation({
          tenantId: 'tenant-1',
          email: 'existing@example.com',
          role: 'MEMBER',
          invitedBy: 'user-1',
        }),
        'User is already a member of this workspace',
      );
    });

    test('throws when pending invitation already exists', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindUserByEmail.mockResolvedValue(null);
      mockFindInvitationByEmail.mockResolvedValue({
        id: 'inv-old',
        status: 'pending',
        expiresAt: new Date(Date.now() + 100000),
      });

      await expectRejectedMessage(
        invitationService.createInvitation({
          tenantId: 'tenant-1',
          email: 'invite@example.com',
          role: 'MEMBER',
          invitedBy: 'user-1',
        }),
        'An invitation has already been sent to this email',
      );
    });

    test('deletes expired invitation before creating new one', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindUserByEmail.mockResolvedValue(null);
      mockFindInvitationByEmail.mockResolvedValue({
        id: 'inv-expired',
        status: 'expired',
        expiresAt: new Date(Date.now() - 100000),
      });
      mockDeleteInvitation.mockResolvedValue({});
      mockCreateInvitationRepo.mockResolvedValue({
        id: 'inv-new',
        email: 'invite@example.com',
        role: 'MEMBER',
        status: 'pending',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      mockFindUserById.mockResolvedValue(null);
      mockFindTenantById.mockResolvedValue(null);

      const result = await invitationService.createInvitation({
        tenantId: 'tenant-1',
        email: 'invite@example.com',
        role: 'MEMBER',
        invitedBy: 'user-1',
      });

      expect(mockDeleteInvitation).toHaveBeenCalledWith('inv-expired', 'tenant-1');
      expect(result.id).toBe('inv-new');
    });

    test('normalizes email to lowercase', async () => {
      mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
      mockFindUserByEmail.mockResolvedValue(null);
      mockFindInvitationByEmail.mockResolvedValue(null);
      mockCreateInvitationRepo.mockResolvedValue({
        id: 'inv-2',
        email: 'test@example.com',
        role: 'MEMBER',
        status: 'pending',
        expiresAt: new Date(),
      });
      mockFindUserById.mockResolvedValue(null);
      mockFindTenantById.mockResolvedValue(null);

      await invitationService.createInvitation({
        tenantId: 'tenant-1',
        email: '  TEST@EXAMPLE.COM  ',
        role: 'MEMBER',
        invitedBy: 'user-1',
      });

      expect(mockCreateInvitationRepo).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'test@example.com' }),
      );
    });
  });

  describe('acceptInvitation', () => {
    test('creates membership and marks invitation accepted', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue({
        id: 'inv-1',
        tenantId: 'tenant-1',
        email: 'user@example.com',
        role: 'MEMBER',
        status: 'pending',
        expiresAt: new Date(Date.now() + 100000),
      });
      mockFindTenantMember.mockResolvedValue(null);
      mockCreateTenantMember.mockResolvedValue({});
      mockUpdateInvitation.mockResolvedValue({});

      const result = await invitationService.acceptInvitation(
        'token-123',
        'user-1',
        'user@example.com',
      );

      expect(result.tenantId).toBe('tenant-1');
      expect(result.role).toBe('MEMBER');
      expect(result.membershipCreated).toBe(true);
      expect(mockCreateTenantMember).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1', role: 'MEMBER' }),
      );
      expect(mockUpdateUserLastActiveTenantId).toHaveBeenCalledWith('user-1', 'tenant-1');
    });

    test('throws for invalid token', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue(null);

      await expectRejectedMessage(
        invitationService.acceptInvitation('bad-token', 'user-1', 'user@example.com'),
        'Invalid invitation',
      );
    });

    test('throws when invitation already used', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue({
        id: 'inv-1',
        status: 'accepted',
        expiresAt: new Date(Date.now() + 100000),
      });

      await expectRejectedMessage(
        invitationService.acceptInvitation('token', 'user-1', 'user@example.com'),
        'This invitation has already been used',
      );
    });

    test('throws when invitation expired', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue({
        id: 'inv-1',
        status: 'pending',
        expiresAt: new Date(Date.now() - 100000),
      });

      await expectRejectedMessage(
        invitationService.acceptInvitation('token', 'user-1', 'user@example.com'),
        'This invitation has expired',
      );
    });

    test('throws when email does not match', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue({
        id: 'inv-1',
        email: 'invited@example.com',
        status: 'pending',
        expiresAt: new Date(Date.now() + 100000),
      });

      await expectRejectedMessage(
        invitationService.acceptInvitation('token', 'user-1', 'other@example.com'),
        'This invitation was sent to a different email address',
      );
    });

    test('handles existing member gracefully', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue({
        id: 'inv-1',
        tenantId: 'tenant-1',
        email: 'user@example.com',
        role: 'ADMIN',
        status: 'pending',
        expiresAt: new Date(Date.now() + 100000),
      });
      mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });
      mockUpdateInvitation.mockResolvedValue({});

      const result = await invitationService.acceptInvitation(
        'token',
        'user-1',
        'user@example.com',
      );

      // Returns existing role, not invited role
      expect(result.role).toBe('MEMBER');
      expect(result.membershipCreated).toBe(false);
      expect(mockCreateTenantMember).not.toHaveBeenCalled();
      expect(mockUpdateInvitation).toHaveBeenCalled();
      expect(mockUpdateUserLastActiveTenantId).toHaveBeenCalledWith('user-1', 'tenant-1');
    });
  });

  describe('revokeInvitation', () => {
    test('marks invitation as revoked', async () => {
      mockUpdateInvitation.mockResolvedValue({});

      await invitationService.revokeInvitation('inv-1', 'tenant-1');

      expect(mockUpdateInvitation).toHaveBeenCalledWith('inv-1', 'tenant-1', { status: 'revoked' });
    });
  });

  describe('listInvitations', () => {
    test('returns formatted invitation list', async () => {
      mockFindInvitations.mockResolvedValue([
        {
          id: 'inv-1',
          email: 'a@example.com',
          role: 'MEMBER',
          status: 'pending',
          invitedBy: 'user-1',
          inviter: { name: 'Alice', email: 'alice@example.com' },
          expiresAt: new Date('2026-03-01'),
          createdAt: new Date('2026-02-01'),
        },
        {
          id: 'inv-2',
          email: 'b@example.com',
          role: 'VIEWER',
          status: 'accepted',
          invitedBy: 'user-2',
          inviter: null,
          expiresAt: new Date('2026-03-01'),
          createdAt: new Date('2026-02-01'),
        },
      ]);

      const results = await invitationService.listInvitations('tenant-1');

      expect(results).toHaveLength(2);
      expect(results[0].inviterName).toBe('Alice');
      expect(results[1].inviterName).toBeNull();
      expect(mockFindInvitations).toHaveBeenCalledWith('tenant-1', { includeInviter: true });
    });
  });

  describe('getInvitationByToken', () => {
    test('returns formatted invitation data', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue({
        id: 'inv-1',
        email: 'user@example.com',
        role: 'MEMBER',
        status: 'pending',
        tenant: { name: 'Test Workspace' },
        inviter: { name: 'Alice' },
        expiresAt: new Date('2026-03-01'),
      });

      const result = await invitationService.getInvitationByToken('token-abc');

      expect(result).not.toBeNull();
      expect(result!.workspaceName).toBe('Test Workspace');
      expect(result!.inviterName).toBe('Alice');
    });

    test('returns null for non-existent token', async () => {
      mockFindInvitationByTokenWithRelations.mockResolvedValue(null);

      const result = await invitationService.getInvitationByToken('bad-token');
      expect(result).toBeNull();
    });
  });
});
