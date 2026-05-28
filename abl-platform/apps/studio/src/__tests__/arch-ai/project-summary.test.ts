import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetProjectAgents, mockFindProjectToolsByProject, mockCountDocuments } = vi.hoisted(
  () => ({
    mockGetProjectAgents: vi.fn(),
    mockFindProjectToolsByProject: vi.fn(),
    mockCountDocuments: vi.fn(),
  }),
);

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: (...args: unknown[]) => mockGetProjectAgents(...args),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  findProjectToolsByProject: (...args: unknown[]) => mockFindProjectToolsByProject(...args),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent-platform/database/models', () => ({
  ChannelConnection: {
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
}));

describe('arch project summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectAgents.mockResolvedValue([{ name: 'Router' }, { name: 'RefundsAgent' }]);
    mockFindProjectToolsByProject.mockResolvedValue({
      data: [{ name: 'lookup_order' }, { name: 'submit_refund' }],
      pagination: { page: 1, limit: 50, total: 2, hasMore: false },
    });
    mockCountDocuments.mockResolvedValue(1);
  });

  it('counts project tools from the paginated repository response', async () => {
    const { getProjectSummary } = await import('@/services/arch-project-service');

    const summary = await getProjectSummary('project-1', 'tenant-1');

    expect(summary).toMatchObject({
      agentCount: 2,
      toolCount: 2,
      channelCount: 1,
      agentNames: ['Router', 'RefundsAgent'],
    });
    expect(mockFindProjectToolsByProject).toHaveBeenCalledWith('tenant-1', 'project-1');
  });
});
