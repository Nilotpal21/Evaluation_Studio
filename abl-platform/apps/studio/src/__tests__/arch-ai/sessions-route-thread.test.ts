import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
const mockCreate = vi.fn();
const mockGetCurrent = vi.fn();
const mockForceArchiveStuck = vi.fn();
const mockForceArchiveForFreshStart = vi.fn();
const mockForceArchiveScopedFreshStart = vi.fn();
const mockSpecDocumentCreate = vi.fn();
const mockAuditEmit = vi.fn();
const mockAuditFlush = vi.fn();
const mockAuditDestroy = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/lib/api-response', () => ({
  actionJson: (payload: unknown, status = 200) =>
    NextResponse.json({ success: true, ...(payload as Record<string, unknown>) }, { status }),
  errorJson: (message: string, status = 500, code = 'ERROR') =>
    NextResponse.json({ success: false, error: { code, message } }, { status }),
  handleApiError: (error: unknown) =>
    NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 },
    ),
}));

vi.mock('@/lib/arch-ai/constants', () => ({
  ARCH_AI_SESSION_RECOVERY: {
    STUCK_SESSION_THRESHOLD_MS: 60_000,
  },
}));

vi.mock('@/lib/arch-audit-pipeline-writer', () => ({
  getStudioArchAuditPipelineWriter: vi.fn(() => ({ write: vi.fn() })),
}));

vi.mock('@agent-platform/database/models', () => ({
  ArchJournal: {},
  ArchSpecDocument: {},
}));

vi.mock('@agent-platform/arch-ai/models', () => ({
  ArchSessionModel: {},
}));

vi.mock('mongoose', () => ({
  default: { connection: {} },
}));

vi.mock('@agent-platform/arch-ai', () => {
  class SessionAlreadyExistsError extends Error {}

  return {
    SessionAlreadyExistsError,
    SessionService: vi.fn().mockImplementation(function SessionService() {
      return {
        create: (...args: unknown[]) => mockCreate(...args),
        getCurrent: (...args: unknown[]) => mockGetCurrent(...args),
        forceArchiveStuck: (...args: unknown[]) => mockForceArchiveStuck(...args),
        forceArchiveForFreshStart: (...args: unknown[]) => mockForceArchiveForFreshStart(...args),
        forceArchiveScopedFreshStart: (...args: unknown[]) =>
          mockForceArchiveScopedFreshStart(...args),
      };
    }),
    JournalService: vi.fn().mockImplementation(function JournalService() {}),
    SpecDocumentService: vi.fn().mockImplementation(function SpecDocumentService() {
      return {
        create: (...args: unknown[]) => mockSpecDocumentCreate(...args),
      };
    }),
    AuditLogEmitter: vi.fn().mockImplementation(function AuditLogEmitter() {
      return {
        emit: (...args: unknown[]) => mockAuditEmit(...args),
        flush: (...args: unknown[]) => mockAuditFlush(...args),
        destroy: (...args: unknown[]) => mockAuditDestroy(...args),
      };
    }),
  };
});

import { POST } from '@/app/api/arch-ai/sessions/route';

const authenticatedUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 'tenant-1',
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/arch-ai/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/arch-ai/sessions thread scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({ project: { id: 'proj-123' } });
    mockIsAccessError.mockReturnValue(false);
    mockForceArchiveStuck.mockResolvedValue(0);
    mockForceArchiveForFreshStart.mockResolvedValue(0);
    mockForceArchiveScopedFreshStart.mockResolvedValue(0);
    mockGetCurrent.mockResolvedValue(null);
    mockSpecDocumentCreate.mockResolvedValue(undefined);
    mockAuditFlush.mockResolvedValue(undefined);
    mockCreate.mockImplementation(async (_ctx, projectId, scopeOptions) => ({
      id: 'sess-created',
      tenantId: authenticatedUser.tenantId,
      userId: authenticatedUser.id,
      state: 'IDLE',
      metadata: {
        mode: projectId ? 'IN_PROJECT' : 'ONBOARDING',
        projectId,
        surface: scopeOptions?.surface,
        agentName: scopeOptions?.agentName,
        threadId: scopeOptions?.threadId,
      },
    }));
  });

  it('generates the thread id on the backend for force-created onboarding sessions', async () => {
    const response = await POST(makeRequest({ mode: 'ONBOARDING', force: true }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.session.metadata.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mockCreate).toHaveBeenCalledWith({ tenantId: 'tenant-1', userId: 'user-1' }, undefined, {
      surface: undefined,
      agentName: undefined,
      threadId: body.session.metadata.threadId,
    });
    expect(mockForceArchiveStuck).not.toHaveBeenCalled();
    expect(mockForceArchiveScopedFreshStart).not.toHaveBeenCalled();
    expect(mockGetCurrent).not.toHaveBeenCalled();
  });

  it('archives the exact scoped thread before force-creating when caller supplies threadId', async () => {
    mockForceArchiveScopedFreshStart.mockResolvedValueOnce(1);

    const response = await POST(
      makeRequest({
        projectId: 'proj-123',
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: 'thread-cli-1',
        force: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(mockForceArchiveScopedFreshStart).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'proj-123',
      {
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: 'thread-cli-1',
      },
    );
    expect(mockCreate).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'proj-123',
      {
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: 'thread-cli-1',
      },
    );
  });

  it('generates and preserves backend thread scope for force-created agent editor sessions', async () => {
    const response = await POST(
      makeRequest({
        projectId: 'proj-123',
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        force: true,
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.session.metadata).toMatchObject({
      mode: 'IN_PROJECT',
      projectId: 'proj-123',
      surface: 'agent-editor',
      agentName: 'BookingRequestAgent',
    });
    expect(body.session.metadata.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mockRequireProjectAccess).toHaveBeenCalledWith('proj-123', authenticatedUser);
    expect(mockCreate).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'proj-123',
      {
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: body.session.metadata.threadId,
      },
    );
  });

  it('rejects agent editor session creation without an agent name before creating a session', async () => {
    const response = await POST(
      makeRequest({
        projectId: 'proj-123',
        surface: 'agent-editor',
        force: true,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'agentName is required for agent-editor sessions',
      },
    });
    expect(mockRequireProjectAccess).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
