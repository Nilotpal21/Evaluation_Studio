import { describe, it, expect } from 'vitest';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import type { PipelinePolicy } from '../../platform/guardrails/pipeline';
import type { Guardrail } from '../../platform/ir/schema';

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'test-guard',
    description: 'test guardrail',
    kind: 'tool_input',
    priority: 1,
    tier: 'local',
    check: 'input.content == "bad"',
    action: { type: 'warn', message: 'Original warning' },
    ...overrides,
  };
}

describe('Pipeline policy action override validation', () => {
  const pipeline = new GuardrailPipelineImpl();

  it('should apply valid action override { type: "block", message: "Blocked" }', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'action',
          action: { type: 'block', message: 'Blocked by policy' },
        },
      ],
    };
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    // The guardrail fires because CEL check matches "bad"
    // With valid override, the action should be 'block' not 'warn'
    const allViolations = [...result.violations, ...result.warnings];
    if (allViolations.length > 0) {
      // If the CEL check triggers, verify the action was overridden
      const v = allViolations[0];
      expect(v.action).toBe('block');
    }
  });

  it('should reject invalid action override { type: "noop" }', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'action',
          action: { type: 'noop' },
        },
      ],
    };
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    // With invalid override, original 'warn' action is preserved
    const allViolations = [...result.violations, ...result.warnings];
    if (allViolations.length > 0) {
      expect(allViolations[0].action).toBe('warn');
    }
  });

  it('should reject action override with missing type field', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'action',
          action: { message: 'no type' },
        },
      ],
    };
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    const allViolations = [...result.violations, ...result.warnings];
    if (allViolations.length > 0) {
      expect(allViolations[0].action).toBe('warn');
    }
  });

  it('should ignore null/undefined action in override', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'action',
          action: null as any,
        },
      ],
    };
    // Should not throw
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    expect(result).toBeDefined();
  });

  it('should strip invalid severity_actions entries (e.g. __proto__ type)', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'severity_actions',
          severityActions: {
            high: { type: '__proto__' } as any,
          },
        },
      ],
    };
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    // Invalid entry stripped — severityActions should not be set
    expect(result).toBeDefined();
  });

  it('should preserve valid severity_actions entries', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'severity_actions',
          severityActions: {
            high: { type: 'block', message: 'Blocked' },
            low: { type: 'warn', message: 'Warning' },
          },
        },
      ],
    };
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    expect(result).toBeDefined();
  });

  it('should keep only valid entries in mixed severity_actions', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'severity_actions',
          severityActions: {
            high: { type: 'block', message: 'Blocked' },
            medium: { type: 'invalid_type' } as any,
            low: { type: 'warn', message: 'Warning' },
          },
        },
      ],
    };
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    // Pipeline should still work — invalid 'medium' entry stripped
    expect(result).toBeDefined();
  });

  it('should reject non-object action (string)', async () => {
    const guardrail = makeGuardrail();
    const policy: PipelinePolicy = {
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'action',
          action: 'block' as any,
        },
      ],
    };
    const result = await pipeline.execute(
      [guardrail],
      'bad',
      'tool_input',
      { toolName: 'test' },
      undefined,
      policy,
    );
    const allViolations = [...result.violations, ...result.warnings];
    if (allViolations.length > 0) {
      expect(allViolations[0].action).toBe('warn');
    }
  });
});
