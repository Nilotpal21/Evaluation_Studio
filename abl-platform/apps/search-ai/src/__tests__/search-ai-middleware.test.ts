/**
 * SearchAI Auth Middleware Unit Tests
 *
 * Tests for the auth middleware configuration and behavior.
 * External dependencies (@agent-platform/shared, database models) are mocked.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// =============================================================================
// Auth Middleware Tests
// =============================================================================

describe('auth middleware', () => {
  const mockCreateUnifiedAuthMiddleware = vi.fn();
  const mockRequireAuthWithTenant = vi.fn();
  const mockUnifiedAuthHandler = vi.fn();
  const mockRequireAuthHandler = vi.fn();
  const mockRequireTenantContextHandler = vi.fn();
  const mockExpandScopesToPermissions = vi.fn();
  const mockLoggerInfo = vi.fn();
  const mockLoggerWarn = vi.fn();
  const mockLoggerError = vi.fn();

  beforeEach(async () => {
    vi.resetModules();

    // Mock the shared auth module
    mockCreateUnifiedAuthMiddleware.mockClear();
    mockRequireAuthWithTenant.mockClear();
    mockUnifiedAuthHandler.mockClear();
    mockRequireAuthHandler.mockClear();
    mockRequireTenantContextHandler.mockClear();
    mockCreateUnifiedAuthMiddleware.mockReturnValue(mockUnifiedAuthHandler);
    mockRequireAuthWithTenant.mockReturnValue([
      mockRequireAuthHandler,
      mockRequireTenantContextHandler,
    ]);
    mockRequireTenantContextHandler.mockImplementation(
      (_req: Request, _res: Response, next: NextFunction) => {
        next();
      },
    );
    mockLoggerInfo.mockClear();
    mockLoggerWarn.mockClear();
    mockLoggerError.mockClear();
    mockExpandScopesToPermissions.mockClear();
    mockExpandScopesToPermissions.mockImplementation((scopes: string[]) => scopes);

    vi.doMock('@agent-platform/shared-auth', () => ({
      createUnifiedAuthMiddleware: mockCreateUnifiedAuthMiddleware,
      expandScopesToPermissions: mockExpandScopesToPermissions,
      requireAuthWithTenant: mockRequireAuthWithTenant,
    }));

    // Mock createLogger — auth.ts calls createLogger('auth') at module scope
    vi.doMock('@abl/compiler/platform', () => ({
      createLogger: () => ({
        info: mockLoggerInfo,
        warn: mockLoggerWarn,
        error: mockLoggerError,
        debug: vi.fn(),
      }),
    }));

    vi.doMock('jsonwebtoken', () => ({
      default: {
        verify: vi.fn(),
        sign: vi.fn(),
      },
    }));

    vi.doMock('crypto', () => ({
      default: {
        createHash: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue('hashedkey'),
          }),
        }),
      },
    }));

    vi.doMock('../config/index.js', () => ({
      getConfig: vi.fn().mockReturnValue({
        env: 'test',
        jwt: { secret: 'test-secret-key-for-testing-purposes' },
      }),
    }));

    vi.doMock('@agent-platform/database/models', () => ({
      User: {
        findById: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      },
      ApiKey: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      },
    }));

    // Mock auth-repo — auth.ts now delegates to real DB lookups via repos
    vi.doMock('../repos/auth-repo.js', () => ({
      findUserById: vi.fn().mockResolvedValue(null),
      resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'admin', customRoleId: null }),
      resolveDefaultTenant: vi.fn().mockResolvedValue(null),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('unifiedAuth is created by calling createUnifiedAuthMiddleware', async () => {
    await import('../middleware/auth.js');
    expect(mockCreateUnifiedAuthMiddleware).toHaveBeenCalledTimes(1);
  });

  test('unifiedAuth config includes getJwtSecret function', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    expect(typeof config.getJwtSecret).toBe('function');
    expect(config.getJwtSecret()).toBe('test-secret-key-for-testing-purposes');
  });

  test('unifiedAuth config includes logger with info, warn, error', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    expect(typeof config.logger.info).toBe('function');
    expect(typeof config.logger.warn).toBe('function');
    expect(typeof config.logger.error).toBe('function');
  });

  test('unifiedAuth config logger.info delegates to createLogger instance', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    config.logger.info('test message', { key: 'value' });
    expect(mockLoggerInfo).toHaveBeenCalledWith('test message', { key: 'value' });
  });

  test('unifiedAuth config logger.warn delegates to createLogger instance', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    config.logger.warn('warning message');
    // The logger wrapper passes (msg, meta ?? {}) — so missing meta becomes {}
    expect(mockLoggerWarn).toHaveBeenCalledWith('warning message', {});
  });

  test('unifiedAuth config logger.error delegates to createLogger instance', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    config.logger.error('error message');
    expect(mockLoggerError).toHaveBeenCalledWith('error message', {});
  });

  test('onAuthEvent is a no-op function', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    // Should not throw
    expect(() => config.onAuthEvent({ outcome: 'success', authType: 'user' })).not.toThrow();
  });

  test('isSuperAdmin always returns false', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    expect(config.isSuperAdmin('any-user')).toBe(false);
    expect(config.isSuperAdmin('admin')).toBe(false);
  });

  test('resolvePermissions returns role-based permissions for admin', async () => {
    await import('../middleware/auth.js');
    const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
    const result = await config.resolvePermissions('tenant-1', 'user-1', 'admin', null);
    // Admin role gets specific permissions (not wildcard)
    expect(result).toContain('index:read');
    expect(result).toContain('index:write');
    expect(result).toContain('admin:indexes:read');
    expect(result.length).toBeGreaterThan(0);
  });

  // ─── getUserById ──────────────────────────────────────────────────────

  describe('getUserById', () => {
    test('returns null when user not found in database', async () => {
      await import('../middleware/auth.js');
      const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
      const user = await config.getUserById('test-user');
      // auth-repo.findUserById returns null by default (user not in DB)
      expect(user).toBeNull();
    });

    test('returns user from database when found', async () => {
      // Need fresh module state with findUserById returning a user
      vi.resetModules();
      mockCreateUnifiedAuthMiddleware.mockClear();

      vi.doMock('@agent-platform/shared-auth', () => ({
        createUnifiedAuthMiddleware: mockCreateUnifiedAuthMiddleware,
        expandScopesToPermissions: mockExpandScopesToPermissions,
        requireAuthWithTenant: mockRequireAuthWithTenant,
      }));
      vi.doMock('@abl/compiler/platform', () => ({
        createLogger: () => ({
          info: mockLoggerInfo,
          warn: mockLoggerWarn,
          error: mockLoggerError,
          debug: vi.fn(),
        }),
      }));
      vi.doMock('jsonwebtoken', () => ({
        default: { verify: vi.fn(), sign: vi.fn() },
      }));
      vi.doMock('crypto', () => ({
        default: {
          createHash: vi.fn().mockReturnValue({
            update: vi.fn().mockReturnValue({
              digest: vi.fn().mockReturnValue('hashedkey'),
            }),
          }),
        },
      }));
      vi.doMock('../config/index.js', () => ({
        getConfig: vi.fn().mockReturnValue({
          env: 'test',
          jwt: { secret: 'test-secret-key-for-testing-purposes' },
        }),
      }));
      vi.doMock('@agent-platform/database/models', () => ({
        User: { findById: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) },
        ApiKey: { findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) },
      }));
      vi.doMock('../repos/auth-repo.js', () => ({
        findUserById: vi.fn().mockResolvedValue({
          id: 'user@example.com',
          email: 'user@example.com',
          name: 'Test User',
        }),
        resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'admin', customRoleId: null }),
        resolveDefaultTenant: vi.fn().mockResolvedValue(null),
      }));

      await import('../middleware/auth.js');
      const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
      const user = await config.getUserById('user@example.com');
      expect(user?.email).toBe('user@example.com');
    });
  });

  // ─── resolveApiKey ────────────────────────────────────────────────────

  describe('resolveApiKey', () => {
    test('returns null when API key not found', async () => {
      await import('../middleware/auth.js');
      const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
      const result = await config.resolveApiKey('abl_invalidkey');
      expect(result).toBeNull();
    });

    test('returns API key data when found', async () => {
      vi.doMock('@agent-platform/database/models', () => ({
        User: {
          findById: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(null),
          }),
        },
        ApiKey: {
          findOne: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue({
              _id: 'key-1',
              tenantId: 'tenant-1',
              clientId: 'client-1',
              createdBy: 'user-1',
              prefix: 'abl_test',
              scopes: ['workflows.execute'],
              projectIds: ['proj-1'],
              environments: ['dev'],
              expiresAt: null,
            }),
          }),
        },
      }));

      vi.resetModules();
      vi.doMock('@agent-platform/shared-auth', () => ({
        createUnifiedAuthMiddleware: mockCreateUnifiedAuthMiddleware,
        expandScopesToPermissions: mockExpandScopesToPermissions,
        requireAuthWithTenant: mockRequireAuthWithTenant,
      }));
      vi.doMock('@abl/compiler/platform', () => ({
        createLogger: () => ({
          info: mockLoggerInfo,
          warn: mockLoggerWarn,
          error: mockLoggerError,
          debug: vi.fn(),
        }),
      }));
      vi.doMock('jsonwebtoken', () => ({
        default: { verify: vi.fn(), sign: vi.fn() },
      }));
      vi.doMock('crypto', () => ({
        default: {
          createHash: vi.fn().mockReturnValue({
            update: vi.fn().mockReturnValue({
              digest: vi.fn().mockReturnValue('hashedkey'),
            }),
          }),
        },
      }));
      vi.doMock('../config/index.js', () => ({
        getConfig: vi.fn().mockReturnValue({
          env: 'test',
          jwt: { secret: 'test-secret' },
        }),
      }));
      vi.doMock('@agent-platform/database/models', () => ({
        User: {
          findById: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
        },
        ApiKey: {
          findOne: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue({
              _id: 'key-1',
              tenantId: 'tenant-1',
              clientId: 'client-1',
              createdBy: 'user-1',
              prefix: 'abl_test',
              scopes: ['workflows.execute'],
              projectIds: ['proj-1'],
              environments: ['dev'],
              expiresAt: null,
            }),
          }),
        },
      }));
      vi.doMock('../repos/auth-repo.js', () => ({
        findUserById: vi.fn().mockResolvedValue(null),
        resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'admin', customRoleId: null }),
        resolveDefaultTenant: vi.fn().mockResolvedValue(null),
      }));

      await import('../middleware/auth.js');
      const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
      mockExpandScopesToPermissions.mockReturnValue(['workflow:read', 'workflow:execute']);
      const result = await config.resolveApiKey('abl_testkey123');
      expect(result).toEqual({
        tenantId: 'tenant-1',
        apiKeyId: 'key-1',
        clientId: 'client-1',
        createdBy: 'user-1',
        scopes: ['workflow:read', 'workflow:execute'],
        projectIds: ['proj-1'],
        environments: ['dev'],
      });
      expect(mockExpandScopesToPermissions).toHaveBeenCalledWith(['workflows.execute']);
    });

    test('returns null when API key prefix does not match', async () => {
      vi.resetModules();
      mockCreateUnifiedAuthMiddleware.mockClear();

      vi.doMock('@agent-platform/shared-auth', () => ({
        createUnifiedAuthMiddleware: mockCreateUnifiedAuthMiddleware,
        expandScopesToPermissions: mockExpandScopesToPermissions,
        requireAuthWithTenant: mockRequireAuthWithTenant,
      }));
      vi.doMock('@abl/compiler/platform', () => ({
        createLogger: () => ({
          info: mockLoggerInfo,
          warn: mockLoggerWarn,
          error: mockLoggerError,
          debug: vi.fn(),
        }),
      }));
      vi.doMock('jsonwebtoken', () => ({
        default: { verify: vi.fn(), sign: vi.fn() },
      }));
      vi.doMock('crypto', () => ({
        default: {
          createHash: vi.fn().mockReturnValue({
            update: vi.fn().mockReturnValue({
              digest: vi.fn().mockReturnValue('hashedkey'),
            }),
          }),
        },
      }));
      vi.doMock('../config/index.js', () => ({
        getConfig: vi.fn().mockReturnValue({
          env: 'test',
          jwt: { secret: 'test-secret' },
        }),
      }));
      vi.doMock('@agent-platform/database/models', () => ({
        User: {
          findById: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
        },
        ApiKey: {
          findOne: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue({
              _id: 'key-1',
              tenantId: 'tenant-1',
              clientId: 'client-1',
              createdBy: 'user-1',
              prefix: 'abl_diff',
              scopes: ['workflows.execute'],
              projectIds: ['proj-1'],
              environments: ['dev'],
              expiresAt: null,
            }),
          }),
        },
      }));
      vi.doMock('../repos/auth-repo.js', () => ({
        findUserById: vi.fn().mockResolvedValue(null),
        resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'admin', customRoleId: null }),
        resolveDefaultTenant: vi.fn().mockResolvedValue(null),
      }));

      await import('../middleware/auth.js');
      const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
      const result = await config.resolveApiKey('abl_testkey123');
      expect(result).toBeNull();
      expect(mockExpandScopesToPermissions).not.toHaveBeenCalled();
    });

    test('returns null when API key is expired', async () => {
      vi.resetModules();
      mockCreateUnifiedAuthMiddleware.mockClear();

      vi.doMock('@agent-platform/shared-auth', () => ({
        createUnifiedAuthMiddleware: mockCreateUnifiedAuthMiddleware,
        expandScopesToPermissions: mockExpandScopesToPermissions,
        requireAuthWithTenant: mockRequireAuthWithTenant,
      }));
      vi.doMock('@abl/compiler/platform', () => ({
        createLogger: () => ({
          info: mockLoggerInfo,
          warn: mockLoggerWarn,
          error: mockLoggerError,
          debug: vi.fn(),
        }),
      }));
      vi.doMock('jsonwebtoken', () => ({
        default: { verify: vi.fn(), sign: vi.fn() },
      }));
      vi.doMock('crypto', () => ({
        default: {
          createHash: vi.fn().mockReturnValue({
            update: vi.fn().mockReturnValue({
              digest: vi.fn().mockReturnValue('hashedkey'),
            }),
          }),
        },
      }));
      vi.doMock('../config/index.js', () => ({
        getConfig: vi.fn().mockReturnValue({
          env: 'test',
          jwt: { secret: 'test-secret' },
        }),
      }));
      vi.doMock('@agent-platform/database/models', () => ({
        User: {
          findById: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
        },
        ApiKey: {
          findOne: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue({
              _id: 'key-1',
              tenantId: 'tenant-1',
              clientId: 'client-1',
              createdBy: 'user-1',
              prefix: 'abl_test',
              scopes: ['workflows.execute'],
              projectIds: ['proj-1'],
              environments: ['dev'],
              expiresAt: new Date(Date.now() - 1000),
            }),
          }),
        },
      }));
      vi.doMock('../repos/auth-repo.js', () => ({
        findUserById: vi.fn().mockResolvedValue(null),
        resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'admin', customRoleId: null }),
        resolveDefaultTenant: vi.fn().mockResolvedValue(null),
      }));

      await import('../middleware/auth.js');
      const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
      const result = await config.resolveApiKey('abl_testkey123');
      expect(result).toBeNull();
      expect(mockExpandScopesToPermissions).not.toHaveBeenCalled();
    });

    test('returns null when database throws', async () => {
      vi.doMock('@agent-platform/database/models', () => ({
        User: {
          findById: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(null),
          }),
        },
        ApiKey: {
          findOne: vi.fn().mockReturnValue({
            lean: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        },
      }));

      vi.resetModules();
      vi.doMock('@agent-platform/shared-auth', () => ({
        createUnifiedAuthMiddleware: mockCreateUnifiedAuthMiddleware,
        expandScopesToPermissions: mockExpandScopesToPermissions,
        requireAuthWithTenant: mockRequireAuthWithTenant,
      }));
      vi.doMock('@abl/compiler/platform', () => ({
        createLogger: () => ({
          info: mockLoggerInfo,
          warn: mockLoggerWarn,
          error: mockLoggerError,
          debug: vi.fn(),
        }),
      }));
      vi.doMock('jsonwebtoken', () => ({
        default: { verify: vi.fn(), sign: vi.fn() },
      }));
      vi.doMock('crypto', () => ({
        default: {
          createHash: vi.fn().mockReturnValue({
            update: vi.fn().mockReturnValue({
              digest: vi.fn().mockReturnValue('hashedkey'),
            }),
          }),
        },
      }));
      vi.doMock('../config/index.js', () => ({
        getConfig: vi.fn().mockReturnValue({
          env: 'test',
          jwt: { secret: 'test-secret' },
        }),
      }));
      vi.doMock('../repos/auth-repo.js', () => ({
        findUserById: vi.fn().mockResolvedValue(null),
        resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'admin', customRoleId: null }),
        resolveDefaultTenant: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('@agent-platform/database/models', () => ({
        User: {
          findById: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
        },
        ApiKey: {
          findOne: vi.fn().mockReturnValue({
            lean: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        },
      }));

      await import('../middleware/auth.js');
      const config = mockCreateUnifiedAuthMiddleware.mock.calls[0][0];
      const result = await config.resolveApiKey('abl_broken');
      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith('Failed to resolve API key', {
        error: 'DB error',
      });
    });
  });

  // ─── authMiddleware composition ───────────────────────────────────────

  describe('authMiddleware', () => {
    test('authMiddleware is exported', async () => {
      const mod = await import('../middleware/auth.js');
      expect(typeof mod.authMiddleware).toBe('function');
    });

    test('authMiddleware chains unifiedAuth and requireAuthWithTenant', async () => {
      // Mock unifiedAuth to call next immediately
      mockUnifiedAuthHandler.mockImplementation(
        (_req: Request, _res: Response, next: NextFunction) => {
          next();
        },
      );
      mockRequireAuthHandler.mockImplementation(
        (_req: Request, _res: Response, next: NextFunction) => {
          next();
        },
      );

      const mod = await import('../middleware/auth.js');
      const req = {} as Request;
      const res = {} as Response;
      const next = vi.fn();

      mod.authMiddleware(req, res, next);

      expect(mockUnifiedAuthHandler).toHaveBeenCalled();
      expect(mockRequireAuthHandler).toHaveBeenCalled();
      expect(mockRequireTenantContextHandler).toHaveBeenCalled();
    });

    test('authMiddleware passes errors to next', async () => {
      const testError = new Error('Auth failed');
      mockUnifiedAuthHandler.mockImplementation(
        (_req: Request, _res: Response, next: NextFunction) => {
          next(testError);
        },
      );

      const mod = await import('../middleware/auth.js');
      const req = {} as Request;
      const res = {} as Response;
      const next = vi.fn();

      mod.authMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith(testError);
    });

    test('authMiddleware enforces tenant context after authentication', async () => {
      mockUnifiedAuthHandler.mockImplementation(
        (req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
          req.user = { id: 'user-1' };
          next();
        },
      );
      mockRequireAuthHandler.mockImplementation(
        (_req: Request, _res: Response, next: NextFunction) => {
          next();
        },
      );
      mockRequireTenantContextHandler.mockImplementation(
        (_req: Request, res: Response, _next: NextFunction) => {
          (res as any).status(403).json({
            success: false,
            error: {
              code: 'TENANT_CONTEXT_REQUIRED',
              message: 'Tenant context is required for this operation',
            },
          });
        },
      );

      const mod = await import('../middleware/auth.js');
      const req = {} as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response;
      const next = vi.fn();

      mod.authMiddleware(req, res, next);

      expect((res as any).status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
