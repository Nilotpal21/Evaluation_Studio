import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockHandleResponse = vi.fn();

vi.mock('../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

vi.mock('../config/runtime', () => ({
  getRuntimeUrl: () => 'http://runtime.test',
}));

describe('softphone API diagnostics', () => {
  let fetchSoftphoneProjectDiagnostics: typeof import('../api/softphone').fetchSoftphoneProjectDiagnostics;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../api/softphone');
    fetchSoftphoneProjectDiagnostics = mod.fetchSoftphoneProjectDiagnostics;
  });

  it('maps topology compile diagnostics into softphone warnings', async () => {
    const response = { ok: true };
    mockApiFetch.mockResolvedValueOnce(response);
    mockHandleResponse.mockResolvedValueOnce({
      errors: ['WelcomeAgent: Line 4: Unknown tool "bad_tool"'],
      errorSummary: {
        failedAgentCount: 1,
        totalErrorCount: 1,
      },
    });

    const result = await fetchSoftphoneProjectDiagnostics('project with spaces');

    expect(result).toEqual({
      hasIssues: true,
      issueCount: 1,
      failedAgentCount: 1,
      messages: ['WelcomeAgent: Line 4: Unknown tool "bad_tool"'],
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/project%20with%20spaces/topology', {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(mockHandleResponse).toHaveBeenCalledWith(response);
  });

  it('returns a clean diagnostic result when topology has no errors', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    mockHandleResponse.mockResolvedValueOnce({});

    const result = await fetchSoftphoneProjectDiagnostics('project-1');

    expect(result).toEqual({
      hasIssues: false,
      issueCount: 0,
      failedAgentCount: 0,
      messages: [],
    });
  });
});
