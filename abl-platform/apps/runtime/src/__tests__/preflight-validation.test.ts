import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticReport } from '../services/diagnostics/types.js';

// Mock the diagnostic engine
const mockDiagnose = vi.fn();
vi.mock('../services/diagnostics/engine.js', () => ({
  getDiagnosticEngine: () => ({ diagnose: mockDiagnose }),
  ensureAnalyzersReady: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
const { runPreflightValidation } = await import('../services/preflight-validation-service.js');

function makeReport(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    status: 'healthy',
    target: { type: 'agent', id: 'test-agent', agentName: 'test-agent' },
    findings: [],
    summary: { errors: 0, warnings: 0, infos: 0, analyzersRun: ['mock'] },
    config: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('preflight-validation-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ready status when no agents provided', async () => {
    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: [],
    });

    expect(result.status).toBe('ready');
    expect(result.agents).toEqual([]);
    expect(result.summary).toEqual({
      total: 0,
      passed: 0,
      warnings: 0,
      errors: 0,
      canonicalIssues: [],
    });
    expect(mockDiagnose).not.toHaveBeenCalled();
  });

  it('returns ready status when agent has no errors', async () => {
    mockDiagnose.mockResolvedValue(makeReport());

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['agent-a'],
    });

    expect(result.status).toBe('ready');
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].agentName).toBe('agent-a');
    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.errors).toBe(0);
    expect(result.summary.warnings).toBe(0);
    expect(result.summary.canonicalIssues).toEqual([]);
  });

  it('returns errors status when agent has errors', async () => {
    mockDiagnose.mockResolvedValue(
      makeReport({
        status: 'broken',
        summary: { errors: 2, warnings: 0, infos: 0, analyzersRun: ['mock'] },
      }),
    );

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['broken-agent'],
    });

    expect(result.status).toBe('errors');
    expect(result.summary.errors).toBe(2);
    expect(result.summary.passed).toBe(0);
    expect(result.summary.canonicalIssues).toEqual([]);
  });

  it('returns warnings status when agent has only warnings', async () => {
    mockDiagnose.mockResolvedValue(
      makeReport({
        status: 'degraded',
        summary: { errors: 0, warnings: 3, infos: 0, analyzersRun: ['mock'] },
      }),
    );

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['warn-agent'],
    });

    expect(result.status).toBe('warnings');
    expect(result.summary.warnings).toBe(3);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.errors).toBe(0);
    expect(result.summary.canonicalIssues).toEqual([]);
  });

  it('preserves canonical configuration classification from diagnostic reports', async () => {
    mockDiagnose.mockResolvedValue(
      makeReport({
        status: 'broken',
        findings: [
          {
            analyzer: 'model-resolution',
            severity: 'error',
            code: 'NO_CREDENTIAL',
            title: 'No active LLM credential found',
            detail: 'No active credential exists for this tenant.',
            suggestion: 'Add a credential.',
            evidence: [],
            canonical: {
              domain: 'configuration',
              category: 'llm',
              code: 'LLM_CREDENTIAL_MISSING',
            },
          },
        ],
        summary: { errors: 1, warnings: 0, infos: 0, analyzersRun: ['model-resolution'] },
      }),
    );

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['agent-a'],
    });

    expect(result.agents[0].report.findings[0].canonical).toEqual({
      domain: 'configuration',
      category: 'llm',
      code: 'LLM_CREDENTIAL_MISSING',
    });
    expect(result.summary.canonicalIssues).toEqual([
      {
        severity: 'error',
        category: 'llm',
        code: 'LLM_CREDENTIAL_MISSING',
        count: 1,
        agentNames: ['agent-a'],
      },
    ]);
  });

  it('returns errors status with mixed results across agents', async () => {
    mockDiagnose
      .mockResolvedValueOnce(makeReport()) // healthy
      .mockResolvedValueOnce(
        makeReport({
          status: 'broken',
          summary: { errors: 1, warnings: 0, infos: 0, analyzersRun: ['mock'] },
        }),
      ) // broken
      .mockResolvedValueOnce(
        makeReport({
          status: 'degraded',
          summary: { errors: 0, warnings: 2, infos: 0, analyzersRun: ['mock'] },
        }),
      ); // warnings

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['good', 'bad', 'meh'],
    });

    expect(result.status).toBe('errors');
    expect(result.agents).toHaveLength(3);
    expect(result.summary).toEqual({
      total: 3,
      passed: 2,
      warnings: 2,
      errors: 1,
      canonicalIssues: [],
    });
  });

  it('summary counts are correct across multiple agents', async () => {
    mockDiagnose
      .mockResolvedValueOnce(
        makeReport({
          status: 'broken',
          summary: { errors: 3, warnings: 1, infos: 0, analyzersRun: ['mock'] },
        }),
      )
      .mockResolvedValueOnce(
        makeReport({
          status: 'broken',
          summary: { errors: 2, warnings: 4, infos: 0, analyzersRun: ['mock'] },
        }),
      );

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['a1', 'a2'],
    });

    expect(result.summary.total).toBe(2);
    expect(result.summary.passed).toBe(0);
    expect(result.summary.errors).toBe(5);
    expect(result.summary.warnings).toBe(5);
    expect(result.summary.canonicalIssues).toEqual([]);
  });

  it('handles diagnose throwing an error gracefully', async () => {
    mockDiagnose.mockRejectedValue(new Error('Engine exploded'));

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['failing-agent'],
    });

    expect(result.status).toBe('errors');
    expect(result.summary.errors).toBe(1);
    expect(result.agents[0].report.status).toBe('broken');
    expect(result.agents[0].report.findings[0].code).toBe('PREFLIGHT_AGENT_FAILED');
    expect(result.summary.canonicalIssues).toEqual([]);
  });

  it('aggregates canonical issues across agents and severities', async () => {
    mockDiagnose
      .mockResolvedValueOnce(
        makeReport({
          status: 'broken',
          findings: [
            {
              analyzer: 'model-resolution',
              severity: 'error',
              code: 'NO_CREDENTIAL',
              title: 'No active LLM credential found',
              detail: 'No active credential exists for this tenant.',
              suggestion: 'Add a credential.',
              evidence: [],
              canonical: {
                domain: 'configuration',
                category: 'llm',
                code: 'LLM_CREDENTIAL_MISSING',
              },
            },
            {
              analyzer: 'credential-chain',
              severity: 'warning',
              code: 'CREDENTIAL_STALE',
              title: 'Credential may be stale',
              detail: 'Credential may require rotation.',
              suggestion: 'Rotate the credential.',
              evidence: [],
              canonical: {
                domain: 'configuration',
                category: 'llm',
                code: 'LLM_CREDENTIAL_STALE',
              },
            },
          ],
          summary: { errors: 1, warnings: 1, infos: 0, analyzersRun: ['mock'] },
        }),
      )
      .mockResolvedValueOnce(
        makeReport({
          status: 'broken',
          findings: [
            {
              analyzer: 'credential-chain',
              severity: 'error',
              code: 'NO_ACTIVE_CREDENTIAL',
              title: 'No active LLM credential found',
              detail: 'No active credential exists for this tenant.',
              suggestion: 'Add a credential.',
              evidence: [],
              canonical: {
                domain: 'configuration',
                category: 'llm',
                code: 'LLM_CREDENTIAL_MISSING',
              },
            },
          ],
          summary: { errors: 1, warnings: 0, infos: 0, analyzersRun: ['mock'] },
        }),
      );

    const result = await runPreflightValidation({
      tenantId: 't1',
      projectId: 'p1',
      agentNames: ['agent-a', 'agent-b'],
    });

    expect(result.summary.canonicalIssues).toEqual([
      {
        severity: 'error',
        category: 'llm',
        code: 'LLM_CREDENTIAL_MISSING',
        count: 2,
        agentNames: ['agent-a', 'agent-b'],
      },
      {
        severity: 'warning',
        category: 'llm',
        code: 'LLM_CREDENTIAL_STALE',
        count: 1,
        agentNames: ['agent-a'],
      },
    ]);
  });
});
