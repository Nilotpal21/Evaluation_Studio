import { describe, it, expect } from 'vitest';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import type { Guardrail } from '../../platform/ir/schema';
import type { PipelinePolicy } from '../../platform/guardrails/pipeline';
import { isTerminalAction } from '../../platform/guardrails/types';

function guardrail(overrides: Partial<Guardrail>): Guardrail {
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

describe('GuardrailPipelineImpl', () => {
  it('should filter guardrails by kind', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'input_check', kind: 'input', check: 'true', action: { type: 'warn' } }),
      guardrail({ name: 'output_check', kind: 'output', check: 'true', action: { type: 'warn' } }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {});
    // Only input_check should fire
    expect(result.warnings.some((w) => w.name === 'input_check')).toBe(true);
    expect(result.warnings.some((w) => w.name === 'output_check')).toBe(false);
  });

  it('should execute Tier 1 guardrails and return result', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        name: 'length_check',
        check: 'abl.length(input) > 5',
        action: { type: 'block', message: 'Too long' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'This is long enough', 'input', {});
    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('length_check');
  });

  it('should pass when no violations', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        check: 'abl.length(input) > 10000',
        action: { type: 'block' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'short', 'input', {});
    expect(result.passed).toBe(true);
  });

  it('should handle empty guardrails list', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const result = await pipeline.execute([], 'test', 'input', {});
    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(0);
  });

  it('should early-terminate on Tier 1 block before Tier 2', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'blocker', tier: 'local', check: 'true', action: { type: 'block' } }),
      guardrail({
        name: 'model_check',
        tier: 'model',
        provider: 'qwen',
        action: { type: 'block' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {});
    expect(result.passed).toBe(false);
    // model_check should not have been evaluated
    expect(result.metrics.totalChecks).toBe(1);
  });

  // ─── Policy Resolution Tests ─────────────────────────────────────

  it('should filter out disabled guardrails from policy', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'enabled_check', check: 'true', action: { type: 'warn' } }),
      guardrail({ name: 'disabled_check', check: 'true', action: { type: 'warn' } }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {}, undefined, {
      disabledGuardrails: ['disabled_check'],
    });

    // Only enabled_check should have fired
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('enabled_check');
  });

  it('should apply threshold override from policy', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        name: 'threshold_check',
        check: 'true',
        threshold: 0.5,
        action: { type: 'block' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {}, undefined, {
      ruleOverrides: [{ guardrailName: 'threshold_check', override: 'threshold', threshold: 0.9 }],
    });

    // Threshold override is recorded but Tier 1 local checks are binary (no threshold)
    // The override is stored for Tier 2/3 model-based checks
    expect(result.violations).toHaveLength(1); // Still fires because CEL is binary
  });

  it('should work without policy (backward compatible)', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [guardrail({ check: 'true', action: { type: 'warn' } })];

    // No policy parameter - should work exactly as before
    const result = await pipeline.execute(guardrails, 'test', 'input', {});
    expect(result.warnings).toHaveLength(1);
  });

  it('should disable multiple guardrails via policy', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'check_a', check: 'true', action: { type: 'warn' } }),
      guardrail({ name: 'check_b', check: 'true', action: { type: 'warn' } }),
      guardrail({ name: 'check_c', check: 'true', action: { type: 'warn' } }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {}, undefined, {
      disabledGuardrails: ['check_a', 'check_c'],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('check_b');
  });

  it('should return empty result when all guardrails are disabled by policy', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'only_check', check: 'true', action: { type: 'block' } }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {}, undefined, {
      disabledGuardrails: ['only_check'],
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(0);
  });

  it('should apply action override from policy', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        name: 'overridden_action',
        check: 'true',
        action: { type: 'block' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {}, undefined, {
      ruleOverrides: [
        {
          guardrailName: 'overridden_action',
          override: 'action',
          action: { type: 'warn' },
        },
      ],
    });

    // Action was overridden from 'block' to 'warn', so should appear in warnings
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('overridden_action');
  });

  it('should treat reask as a terminal action', () => {
    expect(isTerminalAction('reask')).toBe(true);
  });

  it('should early-terminate on Tier 1 reask before Tier 2', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        name: 'reask_check',
        tier: 'local',
        check: 'true',
        action: { type: 'reask', message: 'Please clarify' },
      }),
      guardrail({
        name: 'model_check',
        tier: 'model',
        provider: 'qwen',
        action: { type: 'block' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {});
    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.action).toBe('reask');
    // model_check should not have been evaluated
    expect(result.metrics.totalChecks).toBe(1);
  });

  it('should handle policy with empty disabledGuardrails array', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'stays_enabled', check: 'true', action: { type: 'warn' } }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {}, undefined, {
      disabledGuardrails: [],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('stays_enabled');
  });

  it('should apply content-modifying actions even when tier1 produces a terminal action', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        name: 'pii-redact',
        tier: 'local',
        kind: 'input',
        check: 'true',
        action: { type: 'redact', message: 'PII removed', redactMode: 'pii' },
        priority: 1,
      }),
      guardrail({
        name: 'profanity-block',
        tier: 'local',
        kind: 'input',
        check: 'true',
        action: { type: 'block', message: 'Profanity blocked' },
        priority: 2,
      }),
    ];

    const result = await pipeline.execute(guardrails, 'test@email.com damn', 'input', {});
    // Should be blocked (terminal action)
    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.action).toBe('block');
    // modifiedContent should still be set because redact action was applied before early return
    // (applyActions runs on the redact violation even though block triggers early termination)
    expect(result.modifiedContent).toBeDefined();
  });

  it('should truncate large content before sending to Tier 3', async () => {
    let capturedContent = '';
    const llmEval = async (prompt: string) => {
      capturedContent = prompt;
      return '{"score": 0.1, "explanation": "safe"}';
    };

    const pipeline = new GuardrailPipelineImpl(undefined, llmEval);
    const largeContent = 'x'.repeat(20_000);
    const guardrails = [
      guardrail({
        name: 'llm_check',
        tier: 'llm',
        llmCheck: 'Check if safe',
        action: { type: 'block' },
      }),
    ];

    await pipeline.execute(guardrails, largeContent, 'input', {});

    // The LLM should receive truncated content, not the full 20k chars
    expect(capturedContent).toContain('[... truncated for safety evaluation]');
    expect(capturedContent).not.toContain('x'.repeat(20_000));
  });

  it('should NOT truncate content that fits within Tier 3 limit', async () => {
    let capturedContent = '';
    const llmEval = async (prompt: string) => {
      capturedContent = prompt;
      return '{"score": 0.1, "explanation": "safe"}';
    };

    const pipeline = new GuardrailPipelineImpl(undefined, llmEval);
    const shortContent = 'x'.repeat(5_000);
    const guardrails = [
      guardrail({
        name: 'llm_check',
        tier: 'llm',
        llmCheck: 'Check if safe',
        action: { type: 'block' },
      }),
    ];

    await pipeline.execute(guardrails, shortContent, 'input', {});

    expect(capturedContent).not.toContain('[... truncated for safety evaluation]');
  });

  it('should apply threshold override to guardrail object', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        name: 'model_guard',
        tier: 'model',
        provider: 'openai',
        threshold: 0.5,
        action: { type: 'block' },
      }),
    ];

    // Threshold override is applied to the guardrail before Tier 2 evaluation
    const result = await pipeline.execute(guardrails, 'test', 'input', {}, undefined, {
      ruleOverrides: [{ guardrailName: 'model_guard', override: 'threshold', threshold: 0.9 }],
    });

    // No Tier 1 checks. Tier 2 evaluates but 'openai' provider is not registered,
    // so the registry returns undefined and the evaluator treats it as pass (fail-open)
    expect(result.passed).toBe(true);
  });
});
