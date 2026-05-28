// packages/compiler/src/__tests__/guardrails/guardrail-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateGuardrails, validateGuardrailsForIR } from '../../platform/ir/guardrail-validator';
import { validateIR } from '../../platform/ir/validate-ir';
import { VALIDATION_CODES } from '../../platform/ir/validation-types';
import type { AgentIR, Guardrail } from '../../platform/ir/schema';

function makeGuardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test',
    description: 'test',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('validateGuardrails', () => {
  it('should reject reask on input guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'input', action: { type: 'reask' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toContain('reask');
  });

  it('should allow reask on output guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'output', action: { type: 'reask' } }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it('should reject fix on handoff guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'handoff', action: { type: 'fix', fixStrategy: 'truncate' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it('should reject filter on handoff guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'handoff', action: { type: 'filter' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it('should warn on fix without fixStrategy', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'input', action: { type: 'fix' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('fixStrategy');
  });

  it('should validate severity_actions too', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({
        kind: 'input',
        severityActions: { high: { type: 'reask' } },
      }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('reask');
  });

  it('should accept valid guardrails with no diagnostics', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'input', action: { type: 'block' } }),
      makeGuardrail({ kind: 'output', action: { type: 'reask', maxReasks: 2 } }),
      makeGuardrail({ kind: 'tool_input', action: { type: 'redact' } }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('validateGuardrailsForIR', () => {
  function makeAgentIR(guardrails: Guardrail[]): AgentIR {
    return {
      ir_version: '1.0',
      metadata: { name: 'test_agent', version: '1', description: '' },
      // mode is deprecated — execution style derived from flow presence
      execution: {} as any,
      identity: { persona: '', goal: '' },
      tools: [],
      gather: { fields: [] },
      memory: {},
      constraints: { constraints: [], guardrails },
      coordination: { handoffs: [] },
      completion: { conditions: [] },
      error_handling: {},
    } as unknown as AgentIR;
  }

  it('should return error diagnostic for reask on input kind', () => {
    const agent = makeAgentIR([makeGuardrail({ kind: 'input', action: { type: 'reask' } })]);
    const diags = validateGuardrailsForIR(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_GUARDRAIL_ACTION);
    expect(diags[0].agent).toBe('test_agent');
  });

  it('should return error diagnostic for fix on handoff kind', () => {
    const agent = makeAgentIR([
      makeGuardrail({ kind: 'handoff', action: { type: 'fix', fixStrategy: 'truncate' } }),
    ]);
    const diags = validateGuardrailsForIR(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_GUARDRAIL_ACTION);
  });

  it('should return warning diagnostic for fix without fixStrategy', () => {
    const agent = makeAgentIR([makeGuardrail({ kind: 'input', action: { type: 'fix' } })]);
    const diags = validateGuardrailsForIR(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].code).toBe(VALIDATION_CODES.GUARDRAIL_ACTION_WARNING);
  });

  it('should return no diagnostics for valid combinations', () => {
    const agent = makeAgentIR([
      makeGuardrail({ kind: 'input', action: { type: 'block' } }),
      makeGuardrail({ kind: 'output', action: { type: 'reask' } }),
    ]);
    const diags = validateGuardrailsForIR(agent);
    expect(diags).toHaveLength(0);
  });

  it('should return empty for agents with no guardrails', () => {
    const agent = makeAgentIR([]);
    const diags = validateGuardrailsForIR(agent);
    expect(diags).toHaveLength(0);
  });

  it('should surface guardrail diagnostics via full validateIR', () => {
    const agent = makeAgentIR([makeGuardrail({ kind: 'input', action: { type: 'reask' } })]);
    const diags = validateIR(agent, [agent]);
    const guardrailDiags = diags.filter(
      (d) => d.code === VALIDATION_CODES.INVALID_GUARDRAIL_ACTION,
    );
    expect(guardrailDiags.length).toBeGreaterThanOrEqual(1);
  });
});
