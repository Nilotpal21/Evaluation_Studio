/**
 * Tests for MFA API Routes
 *
 * Covers:
 *   POST /api/mfa/setup         - Initialize MFA setup
 *   POST /api/mfa/verify        - Verify TOTP / recovery / setup code
 *   POST /api/mfa/confirm       - Confirm MFA setup with first TOTP code
 *   GET  /api/mfa/status        - Get MFA status
 *   DELETE /api/mfa/disable     - Disable MFA
 *   POST /api/mfa/recovery      - Verify recovery code
 *   POST /api/mfa/recovery/regenerate - Regenerate recovery codes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireAuthOrMFAPending = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
  requireAuthOrMFAPending: mockRequireAuthOrMFAPending,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
  getUserById: vi.fn(),
  createTokenPair: vi.fn(() => ({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    expiresIn: 900,
  })),
  resolveUserTenantContext: vi.fn(() => ({ tenantId: 'tenant-1', role: 'member' })),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(() => ({
    id: 'user-1',
    email: 'test@test.com',
    passwordHash: 'hashed-pw',
  })),
}));

const mockSetupMFA = vi.fn();
const mockGetMFAStatus = vi.fn();
const mockConfirmMFASetup = vi.fn();
const mockVerifyMFACode = vi.fn();
const mockVerifyRecoveryCode = vi.fn();
const mockDisableMFA = vi.fn();
const mockRegenerateRecoveryCodes = vi.fn();
const mockLogAuditEvent = vi.fn();

vi.mock('@/services/auth/mfa-service', () => ({
  setupMFA: mockSetupMFA,
  getMFAStatus: mockGetMFAStatus,
  confirmMFASetup: mockConfirmMFASetup,
  verifyMFACode: mockVerifyMFACode,
  verifyRecoveryCode: mockVerifyRecoveryCode,
  disableMFA: mockDisableMFA,
  regenerateRecoveryCodes: mockRegenerateRecoveryCodes,
}));

const mockVerifyPassword = vi.fn();
vi.mock('@/services/auth/password-service', () => ({
  verifyPassword: mockVerifyPassword,
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    MFA_SETUP_CONFIRMED: 'MFA_SETUP_CONFIRMED',
    RECOVERY_CODE_USED: 'RECOVERY_CODE_USED',
    MFA_VERIFIED: 'MFA_VERIFIED',
    MFA_FAILED: 'MFA_FAILED',
    MFA_LOCKED: 'MFA_LOCKED',
    MFA_DISABLED: 'mfa_disabled',
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: Function) => handler,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  role: 'member',
};

function makeRequest(url: string, body?: unknown, method = 'POST'): NextRequest {
  const opts: Record<string, unknown> = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockRequireAuthOrMFAPending.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockLogAuditEvent.mockReset();
});

// ===========================================================================
// POST /api/mfa/setup
// ===========================================================================

describe('POST /api/mfa/setup', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/mfa/setup/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/mfa/setup'));
    expect(res.status).toBe(401);
  });

  it('returns 409 when MFA is already enabled', async () => {
    mockGetMFAStatus.mockResolvedValue({ enabled: true, confirmed: true });

    const res = await handler(makeRequest('/api/mfa/setup'));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toContain('already enabled');
  });

  it('returns secret and recovery codes on success', async () => {
    mockGetMFAStatus.mockResolvedValue({ enabled: false });
    mockSetupMFA.mockResolvedValue({
      secret: 'BASE32SECRET',
      otpauthUrl: 'otpauth://totp/test?secret=BASE32SECRET',
      recoveryCodes: ['code1', 'code2', 'code3'],
    });

    const res = await handler(makeRequest('/api/mfa/setup'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.secret).toBe('BASE32SECRET');
    expect(body.otpauthUrl).toContain('otpauth://');
    expect(body.recoveryCodes).toHaveLength(3);
  });

  it('returns 500 on service error', async () => {
    mockGetMFAStatus.mockRejectedValue(new Error('DB error'));

    const res = await handler(makeRequest('/api/mfa/setup'));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toContain('Failed to setup MFA');
  });
});

// ===========================================================================
// POST /api/mfa/verify
// ===========================================================================

describe('POST /api/mfa/verify', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/mfa/verify/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/mfa/verify', { code: '123456' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing code', async () => {
    const res = await handler(makeRequest('/api/mfa/verify', {}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid request');
  });

  it('returns 400 for empty code', async () => {
    const res = await handler(makeRequest('/api/mfa/verify', { code: '' }));
    expect(res.status).toBe(400);
  });

  it('verifies TOTP code successfully', async () => {
    mockVerifyMFACode.mockResolvedValue(true);
    mockGetMFAStatus.mockResolvedValue({ enabled: true, confirmed: true });

    const res = await handler(makeRequest('/api/mfa/verify', { code: '123456', type: 'totp' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.status).toBeDefined();
  });

  it('returns 401 on invalid TOTP code', async () => {
    mockVerifyMFACode.mockResolvedValue(false);

    const res = await handler(makeRequest('/api/mfa/verify', { code: '000000', type: 'totp' }));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.verified).toBe(false);
  });

  it('verifies recovery code successfully', async () => {
    mockVerifyRecoveryCode.mockResolvedValue(true);
    mockGetMFAStatus.mockResolvedValue({ enabled: true, confirmed: true });

    const res = await handler(
      makeRequest('/api/mfa/verify', { code: 'recovery1', type: 'recovery' }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verified).toBe(true);
  });

  it('confirms MFA setup with setup type', async () => {
    mockConfirmMFASetup.mockResolvedValue(true);
    mockGetMFAStatus.mockResolvedValue({ enabled: true, confirmed: true });

    const res = await handler(makeRequest('/api/mfa/verify', { code: '123456', type: 'setup' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verified).toBe(true);
  });

  it('defaults type to totp when not provided', async () => {
    mockVerifyMFACode.mockResolvedValue(true);
    mockGetMFAStatus.mockResolvedValue({ enabled: true });

    const res = await handler(makeRequest('/api/mfa/verify', { code: '123456' }));
    expect(res.status).toBe(200);
    expect(mockVerifyMFACode).toHaveBeenCalledWith('user-1', '123456');
  });

  it('returns 429 when MFA is locked', async () => {
    mockVerifyMFACode.mockRejectedValue(new Error('Account is locked'));

    const res = await handler(makeRequest('/api/mfa/verify', { code: '000000', type: 'totp' }));
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toContain('locked');
  });

  it('returns 500 on unexpected error', async () => {
    mockVerifyMFACode.mockRejectedValue(new Error('Unexpected'));

    const res = await handler(makeRequest('/api/mfa/verify', { code: '123456', type: 'totp' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/mfa/confirm
// ===========================================================================

describe('POST /api/mfa/confirm', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/mfa/confirm/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/mfa/confirm', { code: '123456' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid code format (not 6 digits)', async () => {
    const res = await handler(makeRequest('/api/mfa/confirm', { code: 'abc' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid code format');
  });

  it('returns 400 for empty code', async () => {
    const res = await handler(makeRequest('/api/mfa/confirm', { code: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing code', async () => {
    const res = await handler(makeRequest('/api/mfa/confirm', {}));
    expect(res.status).toBe(400);
  });

  it('confirms MFA setup successfully', async () => {
    mockConfirmMFASetup.mockResolvedValue(true);

    const res = await handler(makeRequest('/api/mfa/confirm', { code: '123456' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain('MFA successfully enabled');
  });

  it('returns 400 for wrong TOTP code', async () => {
    mockConfirmMFASetup.mockResolvedValue(false);

    const res = await handler(makeRequest('/api/mfa/confirm', { code: '000000' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid code');
  });

  it('returns 409 when already confirmed', async () => {
    mockConfirmMFASetup.mockRejectedValue(new Error('MFA already confirmed'));

    const res = await handler(makeRequest('/api/mfa/confirm', { code: '123456' }));
    expect(res.status).toBe(409);
  });

  it('returns 500 on unexpected error', async () => {
    mockConfirmMFASetup.mockRejectedValue(new Error('DB crash'));

    const res = await handler(makeRequest('/api/mfa/confirm', { code: '123456' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /api/mfa/status
// ===========================================================================

describe('GET /api/mfa/status', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/mfa/status/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/mfa/status', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns MFA status when enabled', async () => {
    mockGetMFAStatus.mockResolvedValue({ enabled: true, confirmed: true });

    const req = new NextRequest(new URL('/api/mfa/status', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.confirmed).toBe(true);
  });

  it('returns MFA status when disabled', async () => {
    mockGetMFAStatus.mockResolvedValue({ enabled: false });

    const req = new NextRequest(new URL('/api/mfa/status', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it('returns 500 on service error', async () => {
    mockGetMFAStatus.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(new URL('/api/mfa/status', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// DELETE /api/mfa/disable
// ===========================================================================

describe('DELETE /api/mfa/disable', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/mfa/disable/route');
    handler = mod.DELETE;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/mfa/disable', 'http://localhost:3000'), {
      method: 'DELETE',
      body: JSON.stringify({ code: '123456' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when neither code nor password provided', async () => {
    const req = new NextRequest(new URL('/api/mfa/disable', 'http://localhost:3000'), {
      method: 'DELETE',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('TOTP code or password');
  });

  it('disables MFA with valid TOTP code', async () => {
    mockVerifyMFACode.mockResolvedValue(true);
    mockDisableMFA.mockResolvedValue(undefined);

    const req = new NextRequest(new URL('/api/mfa/disable', 'http://localhost:3000'), {
      method: 'DELETE',
      body: JSON.stringify({ code: '123456' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain('MFA disabled');
    expect(mockDisableMFA).toHaveBeenCalledWith('user-1');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'mfa_disabled',
        metadata: { method: 'totp' },
      }),
    );
  });

  it('returns 403 with invalid TOTP code', async () => {
    mockVerifyMFACode.mockResolvedValue(false);

    const req = new NextRequest(new URL('/api/mfa/disable', 'http://localhost:3000'), {
      method: 'DELETE',
      body: JSON.stringify({ code: '000000' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handler(req);
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('Invalid TOTP code');
  });

  it('disables MFA with valid password', async () => {
    const { getUserById } = await import('@/services/auth-service');
    vi.mocked(getUserById).mockResolvedValue({
      id: 'user-1',
      email: 'test@test.com',
      passwordHash: 'hashed-pw',
    } as any);
    mockVerifyPassword.mockResolvedValue(true);
    mockDisableMFA.mockResolvedValue(undefined);

    const req = new NextRequest(new URL('/api/mfa/disable', 'http://localhost:3000'), {
      method: 'DELETE',
      body: JSON.stringify({ password: 'mypassword' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mfa_disabled',
        metadata: { method: 'password' },
      }),
    );
  });

  it('returns 403 with invalid password', async () => {
    const { getUserById } = await import('@/services/auth-service');
    vi.mocked(getUserById).mockResolvedValue({
      id: 'user-1',
      email: 'test@test.com',
      passwordHash: 'hashed-pw',
    } as any);
    mockVerifyPassword.mockResolvedValue(false);

    const req = new NextRequest(new URL('/api/mfa/disable', 'http://localhost:3000'), {
      method: 'DELETE',
      body: JSON.stringify({ password: 'wrong' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockVerifyMFACode.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(new URL('/api/mfa/disable', 'http://localhost:3000'), {
      method: 'DELETE',
      body: JSON.stringify({ code: '123456' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handler(req);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/mfa/recovery
// ===========================================================================

describe('POST /api/mfa/recovery', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/mfa/recovery/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuthOrMFAPending.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/mfa/recovery', { code: 'abcd1234' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid recovery code format', async () => {
    const res = await handler(makeRequest('/api/mfa/recovery', { code: 'short' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid recovery code');
  });

  it('returns 400 for missing code', async () => {
    const res = await handler(makeRequest('/api/mfa/recovery', {}));
    expect(res.status).toBe(400);
  });

  it('returns 401 for invalid recovery code', async () => {
    mockVerifyRecoveryCode.mockResolvedValue(false);

    const res = await handler(makeRequest('/api/mfa/recovery', { code: 'wrong123' }));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toContain('Invalid recovery code');
  });

  it('returns access token on valid recovery code', async () => {
    mockVerifyRecoveryCode.mockResolvedValue(true);

    const { resolveUserTenantContext, createTokenPair } = await import('@/services/auth-service');
    vi.mocked(resolveUserTenantContext).mockResolvedValue({
      tenantId: 'tenant-1',
      role: 'member',
    } as any);
    vi.mocked(createTokenPair).mockResolvedValue({
      accessToken: 'recovery-access-token',
      refreshToken: 'recovery-refresh-token',
      expiresIn: 900,
    } as any);

    const res = await handler(makeRequest('/api/mfa/recovery', { code: 'valid123' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.accessToken).toBe('recovery-access-token');
    expect(body.expiresIn).toBe(900);
  });

  it('returns 500 on unexpected error', async () => {
    mockVerifyRecoveryCode.mockRejectedValue(new Error('DB error'));

    const res = await handler(makeRequest('/api/mfa/recovery', { code: 'valid123' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/mfa/recovery/regenerate
// ===========================================================================

describe('POST /api/mfa/recovery/regenerate', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/mfa/recovery/regenerate/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/mfa/recovery/regenerate', { code: '123456' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when neither code nor password provided', async () => {
    const res = await handler(makeRequest('/api/mfa/recovery/regenerate', {}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Re-authentication required');
  });

  it('returns 401 when re-authentication fails', async () => {
    mockVerifyMFACode.mockResolvedValue(false);

    const res = await handler(makeRequest('/api/mfa/recovery/regenerate', { code: '000000' }));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toContain('Re-authentication failed');
  });

  it('regenerates recovery codes with valid TOTP code', async () => {
    mockVerifyMFACode.mockResolvedValue(true);
    mockRegenerateRecoveryCodes.mockResolvedValue(['new-code-1', 'new-code-2']);

    const res = await handler(makeRequest('/api/mfa/recovery/regenerate', { code: '123456' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.recoveryCodes).toEqual(['new-code-1', 'new-code-2']);
    expect(body.message).toContain('New recovery codes generated');
  });

  it('regenerates recovery codes with valid password', async () => {
    mockVerifyMFACode.mockResolvedValue(false);

    const { findUserById } = await import('@/repos/auth-repo');
    vi.mocked(findUserById).mockResolvedValue({
      id: 'user-1',
      email: 'test@test.com',
      passwordHash: 'hashed-pw',
    } as any);
    mockVerifyPassword.mockResolvedValue(true);
    mockRegenerateRecoveryCodes.mockResolvedValue(['pw-code-1', 'pw-code-2']);

    const res = await handler(
      makeRequest('/api/mfa/recovery/regenerate', { password: 'mypassword' }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.recoveryCodes).toEqual(['pw-code-1', 'pw-code-2']);
  });

  it('returns 400 on service error', async () => {
    mockVerifyMFACode.mockResolvedValue(true);
    mockRegenerateRecoveryCodes.mockRejectedValue(new Error('Service error'));

    const res = await handler(makeRequest('/api/mfa/recovery/regenerate', { code: '123456' }));
    expect(res.status).toBe(400);
  });
});
