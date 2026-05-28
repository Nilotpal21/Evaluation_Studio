import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsConfigLoaded = vi.fn();
const mockGetConfig = vi.fn();
const mockRegistryGet = vi.fn();

const mockBridge = {
  get_content: vi.fn(),
  set_content: vi.fn(),
  delete_content: vi.fn(),
};

vi.mock('../../config/index.js', () => ({
  isConfigLoaded: (...args: unknown[]) => mockIsConfigLoaded(...args),
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../../services/execution/memory-bridge-registry.js', () => ({
  getMemoryBridgeRegistry: () => ({
    get: (...args: unknown[]) => mockRegistryGet(...args),
  }),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import memoryApiRouter from '../../routes/memory-api.js';

const SANDBOX_SECRET = 'sandbox-secret';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(memoryApiRouter);
  return app;
}

function signSandboxToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, SANDBOX_SECRET);
}

describe('Memory API route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockIsConfigLoaded.mockReturnValue(true);
    mockGetConfig.mockReturnValue({
      sandbox: {
        jwtSecret: SANDBOX_SECRET,
      },
    });

    mockBridge.get_content.mockResolvedValue({ stored: 'value' });
    mockBridge.set_content.mockResolvedValue(undefined);
    mockBridge.delete_content.mockResolvedValue(true);

    mockRegistryGet.mockReturnValue({
      bridge: mockBridge,
      accountId: 'tenant-1',
      createdAt: Date.now(),
    });
  });

  it('returns 503 when runtime config has not loaded', async () => {
    const app = createApp();
    mockIsConfigLoaded.mockReturnValue(false);

    await request(app)
      .post('/api/v1/memory')
      .expect(503, {
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Config not loaded' },
      });
  });

  it('returns 503 when sandbox auth is not configured', async () => {
    const app = createApp();
    mockGetConfig.mockReturnValue({
      sandbox: {
        jwtSecret: '',
      },
    });

    await request(app)
      .post('/api/v1/memory')
      .expect(503, {
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Sandbox auth not configured' },
      });
  });

  it('returns 401 for invalid sandbox tokens', async () => {
    const app = createApp();

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401, {
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      });
  });

  it('returns 400 when the sandbox token is missing a sessionId', async () => {
    const app = createApp();
    const token = signSandboxToken({ accountId: 'tenant-1' });

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .expect(400, {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Token missing sessionId' },
      });
  });

  it('returns 404 when the session is not registered', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });
    mockRegistryGet.mockReturnValue(undefined);

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'get', memoryStoreName: 'profile' })
      .expect(404, {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Session not found' },
      });
  });

  it('returns 404 when the token accountId does not match the registered session', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });
    mockRegistryGet.mockReturnValue({
      bridge: mockBridge,
      accountId: 'tenant-2',
      createdAt: Date.now(),
    });

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'get', memoryStoreName: 'profile' })
      .expect(404, {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Session not found' },
      });

    expect(mockBridge.get_content).not.toHaveBeenCalled();
  });

  it('returns 400 when action or memoryStoreName is missing', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400, {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Missing action or memoryStoreName' },
      });
  });

  it('supports bare sandbox tokens for get requests', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });
    mockBridge.get_content.mockResolvedValue({ stored: 'value' });

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', token)
      .send({ action: 'get', memoryStoreName: 'profile' })
      .expect(200, {
        success: true,
        data: { stored: 'value' },
      });

    expect(mockRegistryGet).toHaveBeenCalledWith('session-1');
    expect(mockBridge.get_content).toHaveBeenCalledWith('profile');
  });

  it('unwraps payload.content for set requests', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });
    const content = { foo: 'bar' };

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({
        action: 'set',
        memoryStoreName: 'profile',
        payload: { content },
      })
      .expect(200, {
        success: true,
      });

    expect(mockBridge.set_content).toHaveBeenCalledWith('profile', content);
  });

  it('returns deleted state for delete requests', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });
    mockBridge.delete_content.mockResolvedValue(false);

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({
        action: 'delete',
        memoryStoreName: 'profile',
      })
      .expect(200, {
        success: true,
        data: { deleted: false },
      });

    expect(mockBridge.delete_content).toHaveBeenCalledWith('profile');
  });

  it('returns 400 for unknown actions', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({
        action: 'rename',
        memoryStoreName: 'profile',
      })
      .expect(400, {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Unknown action: rename' },
      });
  });

  it('returns 500 when the bridge throws unexpectedly', async () => {
    const app = createApp();
    const token = signSandboxToken({ sessionId: 'session-1', accountId: 'tenant-1' });
    mockBridge.get_content.mockRejectedValue(new Error('boom'));

    await request(app)
      .post('/api/v1/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'get', memoryStoreName: 'profile' })
      .expect(500, {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
  });
});
