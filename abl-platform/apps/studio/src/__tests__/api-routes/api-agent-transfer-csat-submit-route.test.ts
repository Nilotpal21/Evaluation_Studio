import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockEnsureDb = vi.fn();
const mockConnectorConnectionFindOne = vi.fn();
const mockAuthProfileFindOne = vi.fn();
const mockResolve = vi.fn();
const mockCreateAuthProfileResolver = vi.fn();
const mockValidateUrlForSSRF = vi.fn();
const mockGetDevSSRFOptions = vi.fn(() => ({}));
const mockFetch = vi.fn();

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const params = await ctx.params;
      return handler({
        request,
        tenantId: 'tenant-1',
        params,
        user: {
          id: 'user-1',
          tenantId: 'tenant-1',
          permissions: ['connection:read'],
        },
        project: { id: params.id, tenantId: 'tenant-1' },
      });
    },
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ConnectorConnection: {
    findOne: (...args: unknown[]) => mockConnectorConnectionFindOne(...args),
  },
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
}));

vi.mock('@agent-platform/connectors/services', () => ({
  createAuthProfileResolver: (...args: unknown[]) => mockCreateAuthProfileResolver(...args),
}));

vi.mock('@agent-platform/shared/security', () => ({
  validateUrlForSSRF: (...args: unknown[]) => mockValidateUrlForSSRF(...args),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: (...args: unknown[]) => mockGetDevSSRFOptions(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    new URL('/api/projects/proj-1/agent-transfer/csat/submit', 'http://localhost:3000'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify(body),
    },
  );
}

const VALID_BODY = {
  provider: 'smartassist',
  userId: 'user-123',
  channel: 'rtm',
  botId: 'bot-456',
  orgId: 'org-789',
  conversationId: 'conv-abc',
  score: 5,
  surveyType: 'csat',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockEnsureDb.mockResolvedValue(undefined);
  mockCreateAuthProfileResolver.mockReturnValue({ resolve: mockResolve });
  mockValidateUrlForSSRF.mockReturnValue({ safe: true });
  // By default AuthProfile has no direct connector match — exercises the
  // legacy ConnectorConnection fallback path.
  mockAuthProfileFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
  mockConnectorConnectionFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      authProfileId: 'auth-profile-1',
      metadata: { baseUrl: 'https://smartassist.example.com' },
    }),
  });
  mockResolve.mockResolvedValue({ apiKey: 'smartassist-key' });
});

describe('POST /api/projects/[id]/agent-transfer/csat/submit', () => {
  it('blocks SmartAssist base URLs that fail SSRF validation', async () => {
    mockValidateUrlForSSRF.mockReturnValue({
      safe: false,
      reason: 'blocked by SSRF policy',
    });

    const { POST } = await import('@/app/api/projects/[id]/agent-transfer/csat/submit/route');
    const response = await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'MISCONFIGURED_CONNECTION',
        message: 'SmartAssist connection URL is not allowed',
      },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sanitizes upstream SmartAssist errors instead of returning raw provider text', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue('provider stack trace: token=secret'),
    });

    const { POST } = await import('@/app/api/projects/[id]/agent-transfer/csat/submit/route');
    const response = await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'SMARTASSIST_ERROR',
        message: 'SmartAssist CSAT submission failed',
      },
    });
    expect(JSON.stringify(body)).not.toContain('token=secret');
  });

  it('submits a project-scoped CSAT rating to SmartAssist when the connection is valid', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('Thanks for your feedback!'),
    });

    const { POST } = await import('@/app/api/projects/[id]/agent-transfer/csat/submit/route');
    const response = await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { message: 'Thanks for your feedback!' },
    });
    expect(mockConnectorConnectionFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connectorName: 'smartassist',
    });
    expect(mockValidateUrlForSSRF).toHaveBeenCalledWith('https://smartassist.example.com', {});
    expect(mockFetch).toHaveBeenCalledWith(
      'https://smartassist.example.com/agentassist/api/v1/csatResponse/save',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          apikey: 'smartassist-key',
        }),
      }),
    );
  });
});
