/**
 * Twilio Webhook Signature Validation Tests
 *
 * Verifies that the /connect and /status voice routes enforce
 * X-Twilio-Signature validation via the validateTwilioSignature middleware.
 *
 * Test cases:
 *   - Missing X-Twilio-Signature header → 403
 *   - Invalid signature → 403
 *   - Valid signature → route handler executes (connect returns TwiML, status returns 200)
 *   - Twilio not configured → 503 (skips signature check, route handler rejects)
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

const mockIsConfigured = vi.fn(() => true);
const mockValidateWebhookSignature = vi.fn(async () => true);
const mockGenerateStreamTwiML = vi.fn(() => '<Response><Connect><Stream /></Connect></Response>');
const mockGenerateMediaStreamToken = vi.fn(() => 'media-token-123');
const mockConversationEndSession = vi.fn(async () => ({}));
const mockSessionFindOne = vi.fn();
const mockSessionUpdateOne = vi.fn(async () => ({ acknowledged: true, modifiedCount: 1 }));

function createSessionQuery(result: unknown) {
  return {
    sort: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn(async () => result),
  };
}

vi.mock('../../services/voice/twilio-service.js', () => ({
  getTwilioService: vi.fn(() => ({
    isConfigured: () => mockIsConfigured(),
    validateWebhookSignature: (...args: any[]) => mockValidateWebhookSignature(...args),
    generateStreamTwiML: (...args: any[]) => mockGenerateStreamTwiML(...args),
    generateMediaStreamToken: () => mockGenerateMediaStreamToken(),
  })),
}));

vi.mock('../../services/voice/deepgram-service.js', () => ({
  getDeepgramService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  getElevenLabsService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      endSession: (...args: any[]) => mockConversationEndSession(...args),
    },
  })),
}));

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    findOne: (...args: any[]) => mockSessionFindOne(...args),
    updateOne: (...args: any[]) => mockSessionUpdateOne(...args),
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';

// =============================================================================
// HELPERS
// =============================================================================

async function createServer() {
  const app = express();
  // The voice router adds its own urlencoded parser, but we also need JSON for
  // tests that send JSON bodies to non-webhook routes
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

async function postUrlEncoded(
  baseUrl: string,
  path: string,
  body: Record<string, string>,
  headers?: Record<string, string>,
) {
  const urlEncodedBody = new URLSearchParams(body).toString();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: urlEncodedBody,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // response may be TwiML XML or empty, not JSON
  }
  return { status: res.status, text, json, headers: res.headers };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Twilio webhook signature validation', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeEach(() => {
    mockIsConfigured.mockReturnValue(true);
    mockValidateWebhookSignature.mockReset();
    mockValidateWebhookSignature.mockResolvedValue(true);
    mockGenerateStreamTwiML.mockClear();
    mockGenerateMediaStreamToken.mockClear();
    mockGenerateMediaStreamToken.mockReturnValue('media-token-123');
    mockConversationEndSession.mockClear();
    mockConversationEndSession.mockResolvedValue({});
    mockSessionFindOne.mockReset();
    mockSessionFindOne.mockReturnValue(createSessionQuery(null));
    mockSessionUpdateOne.mockClear();
    mockSessionUpdateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  });

  beforeAll(async () => {
    const created = await createServer();
    baseUrl = created.baseUrl;
    server = created.server;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ---------------------------------------------------------------------------
  // /connect
  // ---------------------------------------------------------------------------

  describe('POST /api/v1/voice/connect', () => {
    test('returns 403 when X-Twilio-Signature header is missing', async () => {
      mockIsConfigured.mockReturnValue(true);

      const { status, json } = await postUrlEncoded(baseUrl, '/api/v1/voice/connect', {
        sessionId: 'sess-1',
      });

      expect(status).toBe(403);
      expect(json.error).toMatch(/Missing X-Twilio-Signature/i);
    });

    test('returns 403 when signature is invalid', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockValidateWebhookSignature.mockResolvedValueOnce(false);

      const { status, json } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/connect',
        { sessionId: 'sess-1' },
        { 'X-Twilio-Signature': 'bad-signature' },
      );

      expect(status).toBe(403);
      expect(json.error).toMatch(/Invalid Twilio webhook signature/i);
    });

    test('returns TwiML when signature is valid', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockValidateWebhookSignature.mockResolvedValueOnce(true);

      const { status, text, headers } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/connect',
        { sessionId: 'sess-1' },
        { 'X-Twilio-Signature': 'valid-sig' },
      );

      expect(status).toBe(200);
      expect(text).toContain('<Response>');
      expect(headers.get('content-type')).toContain('text/xml');
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      expect(mockGenerateStreamTwiML).toHaveBeenCalled();
    });

    test('forwards caller metadata into TwiML custom parameters', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockValidateWebhookSignature.mockResolvedValueOnce(true);

      const { status } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/connect',
        {
          sessionId: 'sess-identity',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          From: '+15551230001',
          To: '+15558675309',
          providerVerificationStrength: 'strong',
        },
        { 'X-Twilio-Signature': 'valid-sig' },
      );

      expect(status).toBe(200);
      expect(mockGenerateStreamTwiML).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-identity',
          customParameters: expect.objectContaining({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            caller: '+15551230001',
            called: '+15558675309',
            providerVerificationStrength: 'strong',
          }),
        }),
      );
    });

    test('returns 503 when Twilio is not configured (skips sig check)', async () => {
      mockIsConfigured.mockReturnValue(false);

      const { status, text } = await postUrlEncoded(baseUrl, '/api/v1/voice/connect', {
        sessionId: 'sess-1',
      });

      expect(status).toBe(503);
      expect(text).toMatch(/not configured/i);
    });
  });

  // ---------------------------------------------------------------------------
  // /status
  // ---------------------------------------------------------------------------

  describe('POST /api/v1/voice/status', () => {
    test('returns 403 when X-Twilio-Signature header is missing', async () => {
      mockIsConfigured.mockReturnValue(true);

      const { status, json } = await postUrlEncoded(baseUrl, '/api/v1/voice/status', {
        CallSid: 'CA123',
        CallStatus: 'completed',
      });

      expect(status).toBe(403);
      expect(json.error).toMatch(/Missing X-Twilio-Signature/i);
    });

    test('returns 403 when signature is invalid', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockValidateWebhookSignature.mockResolvedValueOnce(false);

      const { status, json } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/status',
        { CallSid: 'CA123', CallStatus: 'completed' },
        { 'X-Twilio-Signature': 'bad-signature' },
      );

      expect(status).toBe(403);
      expect(json.error).toMatch(/Invalid Twilio webhook signature/i);
    });

    test('returns 200 when signature is valid', async () => {
      mockValidateWebhookSignature.mockResolvedValueOnce(true);

      const { status } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/status',
        { CallSid: 'CA123', CallStatus: 'completed' },
        { 'X-Twilio-Signature': 'valid-sig' },
      );

      expect(status).toBe(200);
    });

    test('finalizes an active matched session with the mapped disposition', async () => {
      mockValidateWebhookSignature.mockResolvedValueOnce(true);
      mockSessionFindOne.mockReturnValueOnce(
        createSessionQuery({
          _id: 'session-twilio-1',
          status: 'active',
          disposition: 'abandoned',
        }),
      );

      const { status } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/status',
        { CallSid: 'CA123', CallStatus: 'completed' },
        { 'X-Twilio-Signature': 'valid-sig' },
      );

      expect(status).toBe(200);
      expect(mockSessionFindOne).toHaveBeenCalledWith({
        'metadata.voiceMetadata.callSid': 'CA123',
      });
      expect(mockConversationEndSession).toHaveBeenCalledWith('session-twilio-1', 'completed');
      expect(mockSessionUpdateOne).not.toHaveBeenCalled();
    });

    test('patches disposition on an already-ended matched session without re-ending it', async () => {
      mockValidateWebhookSignature.mockResolvedValueOnce(true);
      mockSessionFindOne.mockReturnValueOnce(
        createSessionQuery({
          _id: 'session-twilio-2',
          status: 'ended',
          disposition: 'abandoned',
        }),
      );

      const { status } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/status',
        { CallSid: 'CA999', CallStatus: 'completed' },
        { 'X-Twilio-Signature': 'valid-sig' },
      );

      expect(status).toBe(200);
      expect(mockConversationEndSession).not.toHaveBeenCalled();
      expect(mockSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'session-twilio-2' },
        expect.objectContaining({
          $set: expect.objectContaining({
            disposition: 'completed',
            lastActivityAt: expect.any(Date),
          }),
        }),
      );
    });

    test('ignores non-terminal call statuses for session-finalization purposes', async () => {
      mockValidateWebhookSignature.mockResolvedValueOnce(true);

      const { status } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/status',
        { CallSid: 'CA321', CallStatus: 'ringing' },
        { 'X-Twilio-Signature': 'valid-sig' },
      );

      expect(status).toBe(200);
      expect(mockSessionFindOne).not.toHaveBeenCalled();
      expect(mockConversationEndSession).not.toHaveBeenCalled();
      expect(mockSessionUpdateOne).not.toHaveBeenCalled();
    });

    test('returns 403 when validateWebhookSignature throws', async () => {
      mockValidateWebhookSignature.mockRejectedValueOnce(new Error('SDK error'));

      const { status, json } = await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/status',
        { CallSid: 'CA123', CallStatus: 'completed' },
        { 'X-Twilio-Signature': 'some-sig' },
      );

      expect(status).toBe(403);
      expect(json.error).toMatch(/validation failed/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Signature params forwarded correctly
  // ---------------------------------------------------------------------------

  describe('signature validation parameters', () => {
    test('passes signature, reconstructed URL, and body to validateWebhookSignature', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockValidateWebhookSignature.mockResolvedValueOnce(true);

      await postUrlEncoded(
        baseUrl,
        '/api/v1/voice/connect',
        { sessionId: 'sess-1' },
        { 'X-Twilio-Signature': 'test-sig-123' },
      );

      expect(mockValidateWebhookSignature).toHaveBeenCalledWith(
        'test-sig-123',
        expect.stringContaining('/api/v1/voice/connect'),
        expect.objectContaining({ sessionId: 'sess-1' }),
      );
    });

    test('uses config-derived base URL and ignores x-forwarded-proto/host headers', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockValidateWebhookSignature.mockResolvedValueOnce(true);

      // Set a known public base URL via env var (same pattern as channel-connections.ts)
      const originalPublicBase = process.env.RUNTIME_PUBLIC_BASE_URL;
      process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.example.com';

      try {
        const urlEncodedBody = new URLSearchParams({
          CallSid: 'CA1',
          CallStatus: 'ringing',
        }).toString();
        await fetch(`${baseUrl}/api/v1/voice/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Twilio-Signature': 'fwd-sig',
            // These attacker-controlled headers must NOT influence the URL
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'evil.attacker.com',
          },
          body: urlEncodedBody,
        });

        // URL must use the config-derived base, not the attacker's forwarded headers
        expect(mockValidateWebhookSignature).toHaveBeenCalledWith(
          'fwd-sig',
          'https://runtime.example.com/api/v1/voice/status',
          expect.objectContaining({ CallSid: 'CA1' }),
        );
      } finally {
        if (originalPublicBase === undefined) {
          delete process.env.RUNTIME_PUBLIC_BASE_URL;
        } else {
          process.env.RUNTIME_PUBLIC_BASE_URL = originalPublicBase;
        }
      }
    });

    test('falls back to localhost:3112 when no RUNTIME_PUBLIC_BASE_URL is set', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockValidateWebhookSignature.mockResolvedValueOnce(true);

      const originalPublicBase = process.env.RUNTIME_PUBLIC_BASE_URL;
      const originalBase = process.env.RUNTIME_BASE_URL;
      delete process.env.RUNTIME_PUBLIC_BASE_URL;
      delete process.env.RUNTIME_BASE_URL;

      try {
        await postUrlEncoded(
          baseUrl,
          '/api/v1/voice/connect',
          { sessionId: 'sess-1' },
          { 'X-Twilio-Signature': 'fallback-sig' },
        );

        expect(mockValidateWebhookSignature).toHaveBeenCalledWith(
          'fallback-sig',
          'http://localhost:3112/api/v1/voice/connect',
          expect.objectContaining({ sessionId: 'sess-1' }),
        );
      } finally {
        if (originalPublicBase !== undefined) {
          process.env.RUNTIME_PUBLIC_BASE_URL = originalPublicBase;
        }
        if (originalBase !== undefined) {
          process.env.RUNTIME_BASE_URL = originalBase;
        }
      }
    });
  });
});
