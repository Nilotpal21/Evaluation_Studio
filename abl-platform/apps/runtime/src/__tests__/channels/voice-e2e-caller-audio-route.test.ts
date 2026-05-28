import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const {
  mockElevenLabsConfigured,
  mockSynthesize,
  mockGetSupportedLanguagesAndVoices,
  mockLogger,
  routeFactory,
  openApiRoute,
  openApiRouter,
} = vi.hoisted(() => {
  const mockElevenLabsConfigured = vi.fn(() => true);
  const mockSynthesize = vi.fn(async (text: string, options?: Record<string, unknown>) =>
    Buffer.from(`audio:${text}:${String(options?.voiceId || 'default')}`),
  );
  const mockGetSupportedLanguagesAndVoices = vi.fn(
    async (_vendor: string, _input?: { label?: string }) => ({
      tts: [{ code: 'en-US', name: 'English (US)', voices: [{ value: 'mark', name: 'Mark' }] }],
      stt: [],
    }),
  );
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const routeFactory = (method: string) => {
    return (router: any, path: string, ...handlers: any[]) => {
      const lastHandler = handlers[handlers.length - 1];
      const middlewares = handlers.slice(0, -1);
      router[method](path, ...middlewares, lastHandler);
    };
  };
  const openApiRoute = {
    get: routeFactory('get'),
    post: routeFactory('post'),
  };
  const openApiRouter = vi.fn((_registry: unknown, _opts: unknown) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: 'get' | 'post', path: string, _schema: unknown, ...handlers: any[]) => {
        openApiRoute[method](router, path, ...handlers);
      },
    };
  });

  return {
    mockElevenLabsConfigured,
    mockSynthesize,
    mockGetSupportedLanguagesAndVoices,
    mockLogger,
    routeFactory,
    openApiRoute,
    openApiRouter,
  };
});

vi.mock('../../services/voice/twilio-service.js', () => ({
  getTwilioService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

vi.mock('../../services/voice/deepgram-service.js', () => ({
  getDeepgramService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  getElevenLabsService: vi.fn(() => ({
    isConfigured: () => mockElevenLabsConfigured(),
    synthesize: (...args: Parameters<typeof mockSynthesize>) => mockSynthesize(...args),
  })),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-route-1', userId: 'user-route-1' };
    next();
  }),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/feature-gate.js', () => ({
  requireFeature: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../services/voice/jambonz-provisioning.service.js', () => ({
  getJambonzProvisioningService: vi.fn(() => ({
    getSupportedLanguagesAndVoices: (vendor: string, input?: { label?: string }) =>
      mockGetSupportedLanguagesAndVoices(vendor, input),
  })),
}));

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: openApiRouter,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import express from 'express';

async function createServer() {
  const app = express();
  app.use(express.json());

  const voiceRouter = (await import('../../routes/voice.js')).default;
  app.use('/api/v1/voice', voiceRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

describe('GET /api/v1/voice/e2e/caller-audio', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    const created = await createServer();
    baseUrl = created.baseUrl;
    server = created.server;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockElevenLabsConfigured.mockReturnValue(true);
    mockGetSupportedLanguagesAndVoices.mockResolvedValue({
      tts: [{ code: 'en-US', name: 'English (US)', voices: [{ value: 'mark', name: 'Mark' }] }],
      stt: [],
    });
  });

  test('returns synthesized audio and caches repeated requests for the same text', async () => {
    const url = new URL('/api/v1/voice/e2e/caller-audio', baseUrl);
    url.searchParams.set('text', 'cache probe route test');
    url.searchParams.set('voiceId', 'voice-a');

    const first = await fetch(url);
    const firstBody = Buffer.from(await first.arrayBuffer());
    const second = await fetch(url);
    const secondBody = Buffer.from(await second.arrayBuffer());

    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('audio/mpeg');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(firstBody.length).toBeGreaterThan(0);
    expect(second.status).toBe(200);
    expect(secondBody.equals(firstBody)).toBe(true);

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize).toHaveBeenCalledWith('cache probe route test', {
      outputFormat: 'mp3_22050_32',
      voiceId: 'voice-a',
    });
  });

  test('returns 503 when ElevenLabs is not configured', async () => {
    mockElevenLabsConfigured.mockReturnValue(false);

    const url = new URL('/api/v1/voice/e2e/caller-audio', baseUrl);
    url.searchParams.set('text', 'unconfigured route test');

    const response = await fetch(url);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toContain('ElevenLabs is not configured');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  test('fetches ElevenLabs speech options with the tenant-scoped Jambonz label', async () => {
    const url = new URL('/api/v1/voice/speech-options', baseUrl);
    url.searchParams.set('vendor', 'elevenlabs');

    const response = await fetch(url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tts[0].voices[0]).toEqual({ value: 'mark', name: 'Mark' });
    expect(mockGetSupportedLanguagesAndVoices).toHaveBeenCalledWith('elevenlabs', {
      label: 't:tenant-route-1',
    });
  });

  test('fetches Microsoft speech options with the tenant-scoped Jambonz label', async () => {
    const url = new URL('/api/v1/voice/speech-options', baseUrl);
    url.searchParams.set('vendor', 'microsoft');

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(mockGetSupportedLanguagesAndVoices).toHaveBeenCalledWith('microsoft', {
      label: 't:tenant-route-1',
    });
  });
});
