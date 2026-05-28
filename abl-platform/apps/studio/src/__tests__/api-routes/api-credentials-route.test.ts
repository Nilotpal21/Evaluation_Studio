import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockCreateLLMCredential = vi.fn();
const mockFindLLMCredentials = vi.fn();
const mockLogAuditEvent = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/repos/credential-repo', () => ({
  createLLMCredential: (...args: unknown[]) => mockCreateLLMCredential(...args),
  findLLMCredentials: (...args: unknown[]) => mockFindLLMCredentials(...args),
}));

vi.mock('@/services/audit-service', () => ({
  AuditActions: {
    CREDENTIAL_CREATED: 'credential.created',
  },
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: unknown) => handler,
}));

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:5173/api/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('credentials route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthError.mockReturnValue(false);
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      tenantId: 'tenant-1',
    });
    mockCreateLLMCredential.mockResolvedValue({
      id: 'cred-1',
      name: 'OpenRouter key',
      provider: 'openrouter',
      authType: 'api_key',
      isActive: true,
      isDefault: false,
      createdAt: new Date('2026-05-21T00:00:00.000Z'),
    });
  });

  it('accepts OpenRouter as a personal credential provider', async () => {
    const { POST } = await import('../../app/api/credentials/route.js');

    const response = await POST(
      makePostRequest({
        name: 'OpenRouter key',
        provider: 'openrouter',
        apiKey: 'sk-or-test',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.provider).toBe('openrouter');
    expect(mockCreateLLMCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        credentialScope: 'user',
        ownerId: 'user-1',
        provider: 'openrouter',
        name: 'OpenRouter key',
        encryptedApiKey: 'sk-or-test',
      }),
    );
  });
});
