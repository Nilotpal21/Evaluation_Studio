import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockGetProjectAgents = vi.fn();
const mockCompileProjectAgentsForDiagnostics = vi.fn();
const mockExtractAppStaticGraph = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: (...args: unknown[]) => mockGetProjectAgents(...args),
}));

vi.mock('@/lib/abl/project-aware-compile', () => ({
  compileProjectAgentsForDiagnostics: (...args: unknown[]) =>
    mockCompileProjectAgentsForDiagnostics(...args),
}));

vi.mock('@abl/compiler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  platform: {
    extractAppStaticGraph: (...args: unknown[]) => mockExtractAppStaticGraph(...args),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

function makeRequest(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/projects/proj-1/topology'));
}

describe('GET /api/projects/:id/topology', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
    });
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: {
        _id: 'proj-1',
        tenantId: 'tenant-1',
      },
    });
    mockIsAccessError.mockReturnValue(false);
    mockGetProjectAgents.mockResolvedValue([
      {
        name: 'support_agent',
        dslContent: 'AGENT: support_agent\nGOAL: "Help"',
      },
    ]);
    mockCompileProjectAgentsForDiagnostics.mockResolvedValue({
      compiled: {
        agents: {
          support_agent: {
            metadata: {
              name: 'support_agent',
              type: 'agent',
            },
            identity: {
              goal: 'Help',
              persona: null,
              description: null,
            },
            tools: [],
            gather: { fields: [] },
            flow: { steps: [], definitions: {} },
          },
        },
      },
      errors: [],
      warnings: [],
      parseErrors: [],
    });
    mockExtractAppStaticGraph.mockReturnValue({
      app: {
        entryAgent: 'support_agent',
        agents: ['support_agent'],
        connections: [],
      },
    });
  });

  it('uses the canonical project-aware diagnostic compiler context', async () => {
    const { GET } = await import('@/app/api/projects/[id]/topology/route');

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockCompileProjectAgentsForDiagnostics).toHaveBeenCalledWith({
      agents: [
        {
          name: 'support_agent',
          dslContent: 'AGENT: support_agent\nGOAL: "Help"',
        },
      ],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    const body = await response.json();
    expect(body.topology.nodes).toEqual([
      expect.objectContaining({
        id: 'support_agent',
        isEntry: true,
      }),
    ]);
  });

  it('returns access errors before compiling', async () => {
    const denied = NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    mockRequireProjectAccess.mockResolvedValue(denied);
    mockIsAccessError.mockReturnValue(true);
    const { GET } = await import('@/app/api/projects/[id]/topology/route');

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(404);
    expect(mockCompileProjectAgentsForDiagnostics).not.toHaveBeenCalled();
  });

  it('returns topology experience metadata for inter-agent edges', async () => {
    mockCompileProjectAgentsForDiagnostics.mockResolvedValue({
      compiled: {
        agents: {
          support_agent: {
            metadata: {
              name: 'support_agent',
              type: 'supervisor',
            },
            identity: {
              goal: 'Route support',
              persona: null,
              description: null,
            },
            tools: [],
            gather: { fields: [] },
            flow: { steps: [], definitions: {} },
          },
          orders_agent: {
            metadata: {
              name: 'orders_agent',
              type: 'agent',
            },
            identity: {
              goal: 'Handle orders',
              persona: null,
              description: null,
            },
            tools: [],
            gather: { fields: [] },
            flow: { steps: [], definitions: {} },
          },
        },
      },
      errors: [],
      warnings: [],
      parseErrors: [],
    });
    mockExtractAppStaticGraph.mockReturnValue({
      app: {
        entryAgent: 'support_agent',
        agents: ['support_agent', 'orders_agent'],
        connections: [
          {
            from: 'support_agent',
            to: 'orders_agent',
            type: 'handoff',
            when: 'routing_intent == "orders"',
            returns: false,
            label: 'Customer needs order help',
            experienceMode: 'shared_voice_handoff',
          },
        ],
      },
    });
    const { GET } = await import('@/app/api/projects/[id]/topology/route');

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.topology.edges).toEqual([
      {
        from: 'support_agent',
        to: 'orders_agent',
        type: 'handoff',
        condition: 'routing_intent == "orders"',
        returns: false,
        experienceMode: 'shared_voice_handoff',
        label: 'Customer needs order help',
      },
    ]);
  });
});
