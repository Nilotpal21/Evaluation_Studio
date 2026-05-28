import { describe, expect, it } from 'vitest';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import { VALIDATION_CODES } from '@abl/compiler';
import { runDiagnostics } from '../diagnostics/index.js';

function makeAgent(name: string, overrides: Record<string, unknown> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name, description: '', tags: [], version: '1.0.0' },
    execution: { hints: {}, timeouts: {} },
    identity: { goal: '', persona: '', limitations: [], system_prompt: '' },
    tools: [],
    gather: { fields: [] },
    memory: { session: [], persistent: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { handoffs: [], delegates: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: { action: 'respond' } },
    ...overrides,
  } as unknown as AgentIR;
}

function makeCompilationOutput(agents: Record<string, AgentIR>): CompilationOutput {
  return {
    version: '1.0',
    compiled_at: new Date().toISOString(),
    agents,
    deployment: {} as CompilationOutput['deployment'],
  };
}

describe('runDiagnostics single-agent scope', () => {
  it('filters missing-agent routing findings when validating one agent in isolation', () => {
    const compiled = makeCompilationOutput({
      LeadEngagementRouter: makeAgent('LeadEngagementRouter', {
        available_agents: ['LeadQualifier'],
      }),
    });

    const report = runDiagnostics(compiled, {
      depth: 'deep',
      agentName: 'LeadEngagementRouter',
    });

    expect(
      report.topIssues.some((finding) => finding.code === VALIDATION_CODES.INVALID_ROUTING_TARGET),
    ).toBe(false);
  });

  it('keeps missing-agent routing findings in full-project scope', () => {
    const compiled = makeCompilationOutput({
      LeadEngagementRouter: makeAgent('LeadEngagementRouter', {
        available_agents: ['LeadQualifier'],
      }),
    });

    const report = runDiagnostics(compiled, { depth: 'deep' });

    expect(
      report.topIssues.some((finding) => finding.code === VALIDATION_CODES.INVALID_ROUTING_TARGET),
    ).toBe(true);
  });

  it('still reports self-routing in single-agent scope', () => {
    const compiled = makeCompilationOutput({
      LeadEngagementRouter: makeAgent('LeadEngagementRouter', {
        available_agents: ['LeadEngagementRouter'],
      }),
    });

    const report = runDiagnostics(compiled, {
      depth: 'deep',
      agentName: 'LeadEngagementRouter',
    });

    expect(
      report.topIssues.some((finding) => finding.code === VALIDATION_CODES.SELF_ROUTING_TARGET),
    ).toBe(true);
  });

  it('returns full error and warning code sets separately from topIssues', () => {
    const compiled = makeCompilationOutput({
      LeadEngagementRouter: makeAgent('LeadEngagementRouter', {
        available_agents: ['LeadQualifier'],
      }),
    });

    const report = runDiagnostics(compiled, { depth: 'deep' });

    expect(report.errorCodes).toContain(VALIDATION_CODES.INVALID_ROUTING_TARGET);
    expect(report.warningCodes).toContain('QG-01');
  });
});
