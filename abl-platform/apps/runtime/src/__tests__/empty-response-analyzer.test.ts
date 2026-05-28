import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticContext } from '../services/diagnostics/types.js';
import type { RuntimeSession } from '../services/execution/types.js';
import type { AgentIR } from '@abl/compiler';

const mockSessions = new Map<string, Partial<RuntimeSession>>();

vi.mock('../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: vi.fn((id: string) => mockSessions.get(id)),
  })),
}));

describe('EmptyResponseAnalyzer', () => {
  let analyzer: InstanceType<
    typeof import('../services/diagnostics/analyzers/empty-response.js').EmptyResponseAnalyzer
  >;

  beforeEach(async () => {
    mockSessions.clear();
    const { EmptyResponseAnalyzer } =
      await import('../services/diagnostics/analyzers/empty-response.js');
    analyzer = new EmptyResponseAnalyzer();
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

  it('returns empty findings when session not found', async () => {
    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'nonexistent' });
    expect(findings).toEqual([]);
  });

  it('reports EMPTY_RESPONSE_LLM_FAILED when LLM wiring failed', async () => {
    mockSessions.set('sess-1', {
      sessionHealth: [
        {
          category: 'llm',
          severity: 'error',
          code: 'LLM_WIRING_FAILED',
          message: 'No active credential for tenant',
          timestamp: Date.now(),
        },
      ],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-1' });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('EMPTY_RESPONSE_LLM_FAILED');
    expect(findings[0].severity).toBe('error');
  });

  it('reports EMPTY_RESPONSE_NO_REASONING when flow has no reasoning or respond', async () => {
    const agentIR = {
      metadata: { name: 'test-agent' },
      flow: {
        steps: ['step1', 'step2'],
        definitions: {
          step1: { name: 'step1', gather: {} },
          step2: { name: 'step2', call: 'some_tool' },
        },
      },
    } as unknown as AgentIR;

    mockSessions.set('sess-2', {
      agentIR,
      sessionHealth: [],
      llmClient: {} as RuntimeSession['llmClient'],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-2' });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('EMPTY_RESPONSE_NO_REASONING');
    expect(findings[0].severity).toBe('warning');
  });

  it('does not report NO_REASONING when flow has reasoning zones', async () => {
    const agentIR = {
      metadata: { name: 'test-agent' },
      flow: {
        steps: ['step1'],
        definitions: {
          step1: { name: 'step1', reasoning_zone: { tools: [] } },
        },
      },
    } as unknown as AgentIR;

    mockSessions.set('sess-3', {
      agentIR,
      sessionHealth: [],
      llmClient: {} as RuntimeSession['llmClient'],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-3' });
    const noReasoning = findings.filter((f) => f.code === 'EMPTY_RESPONSE_NO_REASONING');
    expect(noReasoning).toHaveLength(0);
  });

  it('does not report NO_REASONING when flow has respond steps', async () => {
    const agentIR = {
      metadata: { name: 'test-agent' },
      flow: {
        steps: ['step1'],
        definitions: {
          step1: { name: 'step1', respond: 'Hello!' },
        },
      },
    } as unknown as AgentIR;

    mockSessions.set('sess-4', {
      agentIR,
      sessionHealth: [],
      llmClient: {} as RuntimeSession['llmClient'],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-4' });
    const noReasoning = findings.filter((f) => f.code === 'EMPTY_RESPONSE_NO_REASONING');
    expect(noReasoning).toHaveLength(0);
  });

  it('reports EMPTY_RESPONSE_UNKNOWN when no LLM client and no clear cause', async () => {
    mockSessions.set('sess-5', {
      llmClient: undefined,
      sessionHealth: [],
      agentIR: null,
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-5' });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('EMPTY_RESPONSE_UNKNOWN');
    expect(findings[0].severity).toBe('warning');
  });

  it('does not report UNKNOWN when LLM client is present and agent has reasoning', async () => {
    const agentIR = {
      metadata: { name: 'test-agent' },
      flow: {
        steps: ['step1'],
        definitions: {
          step1: { name: 'step1', reasoning_zone: { tools: [] } },
        },
      },
    } as unknown as AgentIR;

    mockSessions.set('sess-6', {
      agentIR,
      sessionHealth: [],
      llmClient: {} as RuntimeSession['llmClient'],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-6' });
    expect(findings).toHaveLength(0);
  });

  it('prioritizes LLM_FAILED over other checks', async () => {
    const agentIR = {
      metadata: { name: 'test-agent' },
      flow: {
        steps: ['step1'],
        definitions: {
          step1: { name: 'step1' },
        },
      },
    } as unknown as AgentIR;

    mockSessions.set('sess-7', {
      agentIR,
      llmClient: undefined,
      sessionHealth: [
        {
          category: 'llm',
          severity: 'error',
          code: 'LLM_WIRING_FAILED',
          message: 'Failed',
          timestamp: Date.now(),
        },
      ],
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-7' });
    // Should return early with just the LLM_FAILED finding
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('EMPTY_RESPONSE_LLM_FAILED');
  });
});
