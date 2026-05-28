import { createHash } from 'crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindActivePublicApiKey = vi.fn();
const mockFindPublicApiKeyForSdk = vi.fn();
const mockFindWidgetConfig = vi.fn();

vi.mock('../../repos/channel-repo.js', () => ({
  findActivePublicApiKey: (...args: unknown[]) => mockFindActivePublicApiKey(...args),
  findPublicApiKeyForSdk: (...args: unknown[]) => mockFindPublicApiKeyForSdk(...args),
  findWidgetConfig: (...args: unknown[]) => mockFindWidgetConfig(...args),
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

import sdkRouter from '../../routes/sdk.js';

function createApp() {
  const app = express();
  app.use('/api/v1/sdk', sdkRouter);
  return app;
}

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

describe('SDK route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindPublicApiKeyForSdk.mockResolvedValue(null);
  });

  it('returns 401 when the API key header is missing', async () => {
    const app = createApp();

    await request(app).get('/api/v1/sdk/config/project-123').expect(401, {
      error: 'API key required',
    });

    expect(mockFindActivePublicApiKey).not.toHaveBeenCalled();
    expect(mockFindWidgetConfig).not.toHaveBeenCalled();
  });

  it('returns 401 when the API key is invalid', async () => {
    const app = createApp();
    const apiKey = 'pk_test_invalid';
    mockFindActivePublicApiKey.mockResolvedValue(null);

    await request(app).get('/api/v1/sdk/config/project-123').set('X-API-Key', apiKey).expect(401, {
      error: 'Invalid or expired API key',
    });

    expect(mockFindActivePublicApiKey).toHaveBeenCalledWith(hashApiKey(apiKey), 'project-123');
    expect(mockFindWidgetConfig).not.toHaveBeenCalled();
  });

  it('returns 403 when the request origin is not allowed', async () => {
    const app = createApp();
    mockFindActivePublicApiKey.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      allowedOrigins: ['https://widget.example'],
      permissions: {},
    });

    await request(app)
      .get('/api/v1/sdk/config/project-123')
      .set('X-API-Key', 'pk_test_origin')
      .set('Origin', 'https://denied.example')
      .expect(403, {
        error: 'Origin not allowed',
      });

    expect(mockFindWidgetConfig).not.toHaveBeenCalled();
  });

  it('returns 403 when an allowlisted key is used without an Origin header', async () => {
    const app = createApp();
    mockFindActivePublicApiKey.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      allowedOrigins: ['https://widget.example'],
      permissions: {},
    });

    await request(app)
      .get('/api/v1/sdk/config/project-123')
      .set('X-API-Key', 'pk_test_origin')
      .expect(403, {
        error: 'Origin not allowed',
      });

    expect(mockFindWidgetConfig).not.toHaveBeenCalled();
  });

  it('accepts wildcard origins with the same matcher used by sdk init', async () => {
    const app = createApp();
    mockFindActivePublicApiKey.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      allowedOrigins: JSON.stringify(['https://*.example.com']),
      permissions: { chat: true, voice: false },
    });

    const response = await request(app)
      .get('/api/v1/sdk/config/project-123')
      .set('X-API-Key', 'pk_test_valid')
      .set('Origin', 'https://app.example.com')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(response.headers.vary).toBe('Origin');
    expect(response.body.projectId).toBe('project-123');
  });

  it('returns wildcard CORS headers when the key has no origin allowlist', async () => {
    const app = createApp();
    mockFindActivePublicApiKey.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      allowedOrigins: [],
      permissions: {},
    });

    const response = await request(app)
      .get('/api/v1/sdk/config/project-123')
      .set('X-API-Key', 'pk_test_open')
      .set('Origin', 'https://any.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-headers']).toBe('X-API-Key, Content-Type');
    expect(response.headers.vary).toBeUndefined();
  });

  it('returns widget config and preserves the public response contract', async () => {
    const app = createApp();
    mockFindActivePublicApiKey.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      allowedOrigins: JSON.stringify(['https://widget.example']),
      permissions: JSON.stringify({ chat: true, voice: false }),
    });
    mockFindWidgetConfig.mockResolvedValue({
      id: 'widget-1',
      projectId: 'project-123',
      mode: 'voice',
      position: 'left',
      theme: { accent: '#0057ff' },
      welcomeMessage: 'Hello there',
      placeholderText: 'Ask something',
      voiceEnabled: true,
      chatEnabled: false,
    });

    const response = await request(app)
      .get('/api/v1/sdk/config/project-123')
      .set('X-API-Key', 'pk_test_valid')
      .set('Origin', 'https://widget.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('https://widget.example');
    expect(response.headers['access-control-allow-headers']).toBe('X-API-Key, Content-Type');
    expect(response.headers.vary).toBe('Origin');
    expect(response.body).toEqual({
      projectId: 'project-123',
      permissions: { chat: true, voice: false },
      config: {
        mode: 'voice',
        position: 'left',
        theme: { accent: '#0057ff' },
        welcomeMessage: 'Hello there',
        placeholderText: 'Ask something',
        voiceEnabled: true,
        chatEnabled: false,
      },
    });
  });

  it('returns 500 with the existing error envelope when widget lookup fails', async () => {
    const app = createApp();
    mockFindActivePublicApiKey.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      allowedOrigins: [],
      permissions: {},
    });
    mockFindWidgetConfig.mockRejectedValue(new Error('widget lookup failed'));

    await request(app)
      .get('/api/v1/sdk/config/project-123')
      .set('X-API-Key', 'pk_test_valid')
      .expect(500, {
        error: 'Failed to fetch configuration',
      });
  });
});
