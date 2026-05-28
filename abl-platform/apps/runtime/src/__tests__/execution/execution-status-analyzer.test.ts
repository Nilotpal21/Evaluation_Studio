import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticContext } from '../../services/diagnostics/types.js';
import type { RuntimeSession } from '../../services/execution/types.js';

const mockSessions = new Map<string, Partial<RuntimeSession>>();

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: vi.fn((id: string) => mockSessions.get(id)),
  })),
}));

describe('ExecutionStatusAnalyzer', () => {
  let analyzer: InstanceType<
    typeof import('../services/diagnostics/analyzers/execution-status.js').ExecutionStatusAnalyzer
  >;

  beforeEach(async () => {
    mockSessions.clear();
    const { ExecutionStatusAnalyzer } =
      await import('../../services/diagnostics/analyzers/execution-status.js');
    analyzer = new ExecutionStatusAnalyzer();
  });

  const baseContext: DiagnosticContext = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    depth: 'standard',
  };

  it('returns empty findings when no sessionId provided', async () => {
    const findings = await analyzer.analyze(baseContext);
    expect(findings).toEqual([]);
  });

  it('returns SESSION_NOT_FOUND when session does not exist', async () => {
    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'nonexistent' });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('SESSION_NOT_FOUND');
  });

  it('reports SESSION_HEALTH_ERROR for error-severity health entries', async () => {
    mockSessions.set('sess-1', {
      sessionHealth: [
        {
          category: 'llm',
          severity: 'error',
          code: 'LLM_WIRING_FAILED',
          message: 'No credential found',
          timestamp: Date.now(),
        },
      ],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-1' });
    const healthErrors = findings.filter((f) => f.code === 'SESSION_HEALTH_ERROR');
    expect(healthErrors).toHaveLength(1);
    expect(healthErrors[0].severity).toBe('error');
    expect(healthErrors[0].title).toContain('LLM_WIRING_FAILED');
  });

  it('skips warning-severity health entries', async () => {
    mockSessions.set('sess-1', {
      sessionHealth: [
        {
          category: 'tool',
          severity: 'warning',
          code: 'TOOL_BIND_WARN',
          message: 'Optional tool unavailable',
          timestamp: Date.now(),
        },
      ],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-1' });
    const healthErrors = findings.filter((f) => f.code === 'SESSION_HEALTH_ERROR');
    expect(healthErrors).toHaveLength(0);
  });

  it('reports NO_LLM_CLIENT when session has no llmClient', async () => {
    mockSessions.set('sess-2', {
      llmClient: undefined,
      sessionHealth: [],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-2' });
    const noLlm = findings.filter((f) => f.code === 'NO_LLM_CLIENT');
    expect(noLlm).toHaveLength(1);
    expect(noLlm[0].severity).toBe('error');
  });

  it('does not report NO_LLM_CLIENT when llmClient is present', async () => {
    mockSessions.set('sess-3', {
      llmClient: {} as RuntimeSession['llmClient'],
      sessionHealth: [],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-3' });
    const noLlm = findings.filter((f) => f.code === 'NO_LLM_CLIENT');
    expect(noLlm).toHaveLength(0);
  });

  it('reports LAST_EXECUTION_FAILED when session is escalated', async () => {
    mockSessions.set('sess-4', {
      llmClient: {} as RuntimeSession['llmClient'],
      sessionHealth: [],
      isEscalated: true,
      escalationReason: 'Tool execution timeout',
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-4' });
    const failed = findings.filter((f) => f.code === 'LAST_EXECUTION_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toContain('Tool execution timeout');
  });

  it('does not report LAST_EXECUTION_FAILED when not escalated', async () => {
    mockSessions.set('sess-5', {
      llmClient: {} as RuntimeSession['llmClient'],
      sessionHealth: [],
      isEscalated: false,
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-5' });
    const failed = findings.filter((f) => f.code === 'LAST_EXECUTION_FAILED');
    expect(failed).toHaveLength(0);
  });

  it('reports multiple findings when multiple issues exist', async () => {
    mockSessions.set('sess-6', {
      llmClient: undefined,
      sessionHealth: [
        {
          category: 'llm',
          severity: 'error',
          code: 'LLM_WIRING_FAILED',
          message: 'No credential',
          timestamp: Date.now(),
        },
      ],
      isEscalated: true,
      escalationReason: 'Unrecoverable error',
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-6' });
    expect(findings.length).toBeGreaterThanOrEqual(3);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('SESSION_HEALTH_ERROR');
    expect(codes).toContain('NO_LLM_CLIENT');
    expect(codes).toContain('LAST_EXECUTION_FAILED');
  });
});
