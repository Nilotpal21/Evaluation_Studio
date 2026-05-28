import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const { mockApiRequest, mockIsAuthenticated, mockGetCurrentProjectId } = vi.hoisted(() => ({
  mockApiRequest: vi.fn(),
  mockIsAuthenticated: vi.fn(),
  mockGetCurrentProjectId: vi.fn(),
}));

vi.mock('../../lib/api-client.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

vi.mock('../../lib/credentials.js', () => ({
  isAuthenticated: (...args: unknown[]) => mockIsAuthenticated(...args),
}));

vi.mock('../../lib/config.js', () => ({
  getCurrentProjectId: (...args: unknown[]) => mockGetCurrentProjectId(...args),
  getCurrentProjectSlug: () => 'support-ops',
}));

vi.mock('ora', () => ({
  default: () => ({
    start: () => ({
      stop: vi.fn(),
    }),
  }),
}));

describe('agent commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIsAuthenticated.mockReturnValue(true);
    mockGetCurrentProjectId.mockReturnValue('project-1');
    mockApiRequest.mockResolvedValue({
      id: 'agent-1',
      name: 'BookingAgent',
      agentPath: 'project-1/BookingAgent',
    });
  });

  it('creates agents without sending legacy agentPath input', async () => {
    const { registerAgentCommands } = await import('../../commands/agents.js');
    const program = new Command();
    program.exitOverride();
    registerAgentCommands(program);

    await program.parseAsync(['node', 'test', 'agents', 'create', 'BookingAgent'], {
      from: 'node',
    });

    expect(mockApiRequest).toHaveBeenCalledWith('/api/projects/project-1/agents', {
      method: 'POST',
      body: { name: 'BookingAgent' },
    });
  });
});
