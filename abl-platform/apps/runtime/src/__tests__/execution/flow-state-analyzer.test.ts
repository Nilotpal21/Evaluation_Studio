import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticContext } from '../../services/diagnostics/types.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { AgentIR } from '@abl/compiler';

const mockSessions = new Map<string, Partial<RuntimeSession>>();

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: vi.fn((id: string) => mockSessions.get(id)),
  })),
}));

describe('FlowStateAnalyzer', () => {
  let analyzer: InstanceType<
    typeof import('../services/diagnostics/analyzers/flow-state.js').FlowStateAnalyzer
  >;

  beforeEach(async () => {
    mockSessions.clear();
    const { FlowStateAnalyzer } =
      await import('../../services/diagnostics/analyzers/flow-state.js');
    analyzer = new FlowStateAnalyzer();
  });

  const baseContext: DiagnosticContext = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    depth: 'standard',
  };

  const minimalFlowIR = {
    flow: {
      steps: ['greeting', 'collect'],
      definitions: {
        greeting: { name: 'greeting', respond: 'Hello' },
        collect: { name: 'collect', gather: {} },
      },
    },
  } as unknown as AgentIR;

  it('returns empty findings when no sessionId provided', async () => {
    const findings = await analyzer.analyze(baseContext);
    expect(findings).toEqual([]);
  });

  it('returns empty findings when session not found', async () => {
    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'nonexistent' });
    expect(findings).toEqual([]);
  });

  it('returns empty findings for non-flow sessions', async () => {
    mockSessions.set('sess-1', {
      agentIR: { flow: undefined } as unknown as AgentIR,
      currentFlowStep: undefined,
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-1' });
    expect(findings).toEqual([]);
  });

  it('reports FLOW_STEP_STALLED when idle too long', async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
    mockSessions.set('sess-2', {
      agentIR: minimalFlowIR,
      currentFlowStep: 'collect',
      lastActivityAt: sixMinutesAgo,
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-2' });
    const stalled = findings.filter((f) => f.code === 'FLOW_STEP_STALLED');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].severity).toBe('warning');
    expect(stalled[0].title).toContain('collect');
  });

  it('does not report FLOW_STEP_STALLED when recently active', async () => {
    mockSessions.set('sess-3', {
      agentIR: minimalFlowIR,
      currentFlowStep: 'collect',
      lastActivityAt: new Date(),
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-3' });
    const stalled = findings.filter((f) => f.code === 'FLOW_STEP_STALLED');
    expect(stalled).toHaveLength(0);
  });

  it('reports FLOW_STEP_LOOP when backtrack count exceeds threshold', async () => {
    mockSessions.set('sess-4', {
      agentIR: minimalFlowIR,
      currentFlowStep: 'collect',
      lastActivityAt: new Date(),
      backtrackCounts: { collect: 8, greeting: 1 },
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-4' });
    const loops = findings.filter((f) => f.code === 'FLOW_STEP_LOOP');
    expect(loops).toHaveLength(1);
    expect(loops[0].severity).toBe('error');
    expect(loops[0].title).toContain('collect');
  });

  it('does not report FLOW_STEP_LOOP when backtrack counts are low', async () => {
    mockSessions.set('sess-5', {
      agentIR: minimalFlowIR,
      currentFlowStep: 'collect',
      lastActivityAt: new Date(),
      backtrackCounts: { collect: 2, greeting: 1 },
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-5' });
    const loops = findings.filter((f) => f.code === 'FLOW_STEP_LOOP');
    expect(loops).toHaveLength(0);
  });

  it('reports both stalled and loop when both conditions met', async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
    mockSessions.set('sess-6', {
      agentIR: minimalFlowIR,
      currentFlowStep: 'collect',
      lastActivityAt: sixMinutesAgo,
      backtrackCounts: { collect: 10 },
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-6' });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('FLOW_STEP_STALLED');
    expect(codes).toContain('FLOW_STEP_LOOP');
  });

  it('reports FLOW_STEP_LOOP for multiple steps exceeding threshold', async () => {
    mockSessions.set('sess-7', {
      agentIR: minimalFlowIR,
      currentFlowStep: 'collect',
      lastActivityAt: new Date(),
      backtrackCounts: { collect: 7, greeting: 6 },
    });

    const findings = await analyzer.analyze({ ...baseContext, sessionId: 'sess-7' });
    const loops = findings.filter((f) => f.code === 'FLOW_STEP_LOOP');
    expect(loops).toHaveLength(2);
  });
});
