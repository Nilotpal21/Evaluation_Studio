import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
const mockNormalizeDraft = vi.fn();
const mockSetSessionDraftPointer = vi.fn();
const mockExecuteIntegrationOps = vi.fn();
const mockHandleApiError = vi.fn();
const mockFindOne = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/lib/arch-ai/integration-draft-service', () => ({
  normalizeDraft: (...args: unknown[]) => mockNormalizeDraft(...args),
  setSessionDraftPointer: (...args: unknown[]) => mockSetSessionDraftPointer(...args),
}));

vi.mock('@/lib/arch-ai/tools/integration-ops', () => ({
  executeIntegrationOps: (...args: unknown[]) => mockExecuteIntegrationOps(...args),
}));

vi.mock('@/lib/api-response', () => ({
  ErrorCode: { NOT_FOUND: 'NOT_FOUND', VALIDATION_ERROR: 'VALIDATION_ERROR' },
  actionJson: (extra: Record<string, unknown> = {}, status = 200) =>
    NextResponse.json({ success: true, ...extra }, { status }),
  errorJson: (message: string | string[], status: number, code: string) =>
    NextResponse.json({ success: false, errors: [{ msg: message, code }] }, { status }),
  handleApiError: (...args: unknown[]) => mockHandleApiError(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ArchIntegrationDraft: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

import { POST } from '@/app/api/arch-ai/integration-drafts/[id]/resume/route';

const authenticatedUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 't1',
  permissions: ['project:update'],
};

const draftDoc = {
  _id: 'draft-1',
  tenantId: 't1',
  projectId: 'p1',
  status: 'draft',
  pendingSteps: [],
};

const normalizedDraft = {
  id: 'draft-1',
  title: 'Slack',
  status: 'draft',
  source: 'in_project',
  providerKey: 'slack',
  toolIds: [],
  authProfileIds: [],
  envVarKeys: [],
  configVarKeys: [],
  variableNamespaceIds: [],
  targetAgentNames: [],
  pendingSteps: [],
  lastIntentSummary: null,
  connectionIds: [],
  lastTestStatus: null,
  lastTestAt: null,
  lastTestError: null,
  testHistory: [],
  createdAt: '2026-05-05T00:00:00.000Z',
  updatedAt: '2026-05-05T00:00:01.000Z',
};

function makeFindOneChain(result: unknown) {
  return {
    lean: vi.fn().mockResolvedValue(result),
  };
}

function makeRequest(body: unknown = { sessionId: 's1' }) {
  return new NextRequest('http://localhost:3000/api/arch-ai/integration-drafts/draft-1/resume', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/arch-ai/integration-drafts/:id/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'p1', tenantId: 't1' },
    });
    mockIsAccessError.mockReturnValue(false);
    mockNormalizeDraft.mockReturnValue(normalizedDraft);
    mockSetSessionDraftPointer.mockResolvedValue(undefined);
    mockExecuteIntegrationOps.mockResolvedValue({
      success: true,
      data: { status: 'draft', changes: [], pendingSteps: [] },
    });
    mockHandleApiError.mockImplementation((error: unknown) =>
      NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
    );
  });

  test('happy path: sets pointer, revalidates, returns draft + revalidation', async () => {
    mockFindOne
      .mockReturnValueOnce(makeFindOneChain(draftDoc))
      .mockReturnValueOnce(makeFindOneChain(draftDoc));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'draft-1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.draft).toEqual(normalizedDraft);
    expect(body.revalidation).toEqual({
      status: 'draft',
      changes: [],
      pendingSteps: [],
    });

    expect(mockSetSessionDraftPointer).toHaveBeenCalledWith({
      tenantId: 't1',
      projectId: 'p1',
      userId: 'user-1',
      sessionId: 's1',
      draftId: 'draft-1',
    });

    expect(mockExecuteIntegrationOps).toHaveBeenCalledWith(
      { action: 'revalidate', draftId: 'draft-1' },
      expect.objectContaining({
        projectId: 'p1',
        sessionId: 's1',
        user: expect.objectContaining({
          tenantId: 't1',
          userId: 'user-1',
        }),
        authToken: 'test-token',
      }),
    );
  });

  test('returns 404 when draft does not exist for this tenant', async () => {
    mockFindOne.mockReturnValueOnce(makeFindOneChain(null));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'missing' }),
    });

    expect(response.status).toBe(404);
    expect(mockSetSessionDraftPointer).not.toHaveBeenCalled();
    expect(mockExecuteIntegrationOps).not.toHaveBeenCalled();
  });

  test('returns 400 when body lacks sessionId', async () => {
    mockFindOne.mockReturnValueOnce(makeFindOneChain(draftDoc));

    const response = await POST(makeRequest({}), {
      params: Promise.resolve({ id: 'draft-1' }),
    });

    expect(response.status).toBe(400);
    expect(mockSetSessionDraftPointer).not.toHaveBeenCalled();
    expect(mockExecuteIntegrationOps).not.toHaveBeenCalled();
  });
});
