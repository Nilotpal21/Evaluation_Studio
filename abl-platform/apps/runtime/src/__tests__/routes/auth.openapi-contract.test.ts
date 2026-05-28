import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mockGetConfig = vi.fn();
const mockFindUserByEmail = vi.fn();
const mockCreateUser = vi.fn();
const mockResolveFirstMembership = vi.fn();
const mockBuildAccessTokenPayload = vi.fn();
const mockSignAccessToken = vi.fn();

vi.mock('../../config/index.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
}));

vi.mock('../../utils/jwt-utils.js', () => ({
  resolveFirstMembership: (...args: unknown[]) => mockResolveFirstMembership(...args),
  buildAccessTokenPayload: (...args: unknown[]) => mockBuildAccessTokenPayload(...args),
  signAccessToken: (...args: unknown[]) => mockSignAccessToken(...args),
}));

import authRouter from '../../routes/auth.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('Auth dev-login route contract', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mockGetConfig.mockReturnValue({
      env: 'development',
      jwt: { secret: 'test-secret' },
    });
    mockFindUserByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'dev@kore.ai',
      name: 'Dev User',
    });
    mockResolveFirstMembership.mockResolvedValue({
      tenantId: 'tenant-1',
      role: 'OWNER',
    });
    mockBuildAccessTokenPayload.mockReturnValue({ sub: 'user-1' });
    mockSignAccessToken.mockReturnValue('jwt-token');
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('returns the existing success envelope for a valid dev login request', async () => {
    const app = createApp();

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'dev@kore.ai', name: 'Dev User' })
      .expect(200, {
        accessToken: 'jwt-token',
        user: {
          id: 'user-1',
          email: 'dev@kore.ai',
          name: 'Dev User',
        },
        tenantId: 'tenant-1',
        role: 'OWNER',
      });

    expect(mockFindUserByEmail).toHaveBeenCalledWith('dev@kore.ai');
    expect(mockResolveFirstMembership).toHaveBeenCalledWith('user-1');
    expect(mockSignAccessToken).toHaveBeenCalledWith({ sub: 'user-1' }, 'test-secret');
  });

  it('creates a default dev user when the request body is empty', async () => {
    const app = createApp();
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: 'user-2',
      email: 'dev@kore.ai',
      name: 'dev',
    });
    mockBuildAccessTokenPayload.mockReturnValue({ sub: 'user-2' });

    await request(app).post('/api/auth/dev-login').send({}).expect(200);

    expect(mockFindUserByEmail).toHaveBeenCalledWith('dev@kore.ai');
    expect(mockCreateUser).toHaveBeenCalledWith({
      email: 'dev@kore.ai',
      name: 'dev',
      googleId: 'dev-dev@kore.ai',
    });
  });

  it('returns the current validation envelope for invalid request bodies', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'not-an-email' })
      .expect(400);

    expect(response.body.error).toBe('Invalid request');
    expect(response.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['email'],
        }),
      ]),
    );
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
  });

  it('returns 403 in production environments', async () => {
    const app = createApp();
    mockGetConfig.mockReturnValue({
      env: 'production',
      jwt: { secret: 'test-secret' },
    });

    await request(app).post('/api/auth/dev-login').send({}).expect(403, {
      error: 'Dev login not available in production',
    });

    expect(mockFindUserByEmail).not.toHaveBeenCalled();
  });

  it('returns 500 with the current failure envelope on unexpected errors', async () => {
    const app = createApp();
    mockFindUserByEmail.mockRejectedValue(new Error('db unavailable'));

    await request(app).post('/api/auth/dev-login').send({}).expect(500, {
      error: 'Dev login failed',
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
