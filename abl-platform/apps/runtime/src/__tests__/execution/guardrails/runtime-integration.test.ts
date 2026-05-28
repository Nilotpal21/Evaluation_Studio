import { describe, it, expect } from 'vitest';
import { GuardrailPipelineImpl } from '@abl/compiler';
import type { Guardrail, GuardrailContext } from '@abl/compiler';

/**
 * Runtime integration tests for the guardrail pipeline.
 *
 * These tests validate that the compiler package's GuardrailPipelineImpl
 * can be invoked from the runtime context with session-like data. The
 * pipeline is imported via the barrel export from @abl/compiler, the same
 * path used by production runtime code.
 *
 * Deep wiring into runtime-executor.ts happens incrementally; this test
 * suite validates the pipeline is callable and behaves correctly when
 * given data shaped like runtime session inputs and outputs.
 */
describe('Runtime guardrail integration', () => {
  // ── Input guardrails (pre-LLM) ────────────────────────────────

  it('should block input containing PII (SSN pattern)', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'pii_block',
        description: 'Block PII in user input',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ];

    const result = await pipeline.execute(guardrails, 'My SSN is 123-45-6789', 'input', {
      agentGoal: 'Help users with general queries',
    });

    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('pii_block');
    expect(result.primaryViolation?.action).toBe('block');
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.failed).toBe(1);
  });

  it('should pass clean input through PII guardrail', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'pii_block',
        description: 'Block PII in user input',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ];

    const result = await pipeline.execute(guardrails, 'I want to book a hotel in Paris', 'input', {
      agentGoal: 'Help users book hotels',
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should block input containing email PII', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'pii_block',
        description: 'Block PII in user input',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ];

    const result = await pipeline.execute(
      guardrails,
      'Contact me at john.doe@example.com',
      'input',
      { agentGoal: 'Help users' },
    );

    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('pii_block');
  });

  // ── Output guardrails (post-LLM) ─────────────────────────────

  it('should warn on long output from LLM', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'output_length_warn',
        description: 'Warn when output exceeds length threshold',
        kind: 'output',
        priority: 1,
        tier: 'local',
        check: 'abl.length(output) > 10',
        action: { type: 'warn', message: 'Response is longer than recommended' },
      },
    ];

    const result = await pipeline.execute(
      guardrails,
      'This is a moderately long response from the LLM that exceeds 10 chars',
      'output',
      {},
    );

    // warn actions do not fail the pipeline
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('output_length_warn');
    expect(result.warnings[0].action).toBe('warn');
  });

  it('should not warn on short output', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'output_length_warn',
        description: 'Warn when output exceeds length threshold',
        kind: 'output',
        priority: 1,
        tier: 'local',
        check: 'abl.length(output) > 100',
        action: { type: 'warn', message: 'Response too long' },
      },
    ];

    const result = await pipeline.execute(guardrails, 'Short reply', 'output', {});

    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  // ── Kind filtering ────────────────────────────────────────────

  it('should only evaluate guardrails matching the requested kind', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'input_guard',
        description: 'Input-only guard',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'true',
        action: { type: 'block', message: 'Blocked' },
      },
      {
        name: 'output_guard',
        description: 'Output-only guard',
        kind: 'output',
        priority: 1,
        tier: 'local',
        check: 'true',
        action: { type: 'warn', message: 'Warning' },
      },
    ];

    // When evaluating as 'output', only the output_guard should fire
    const result = await pipeline.execute(guardrails, 'test content', 'output', {});

    expect(result.passed).toBe(true); // warn does not fail
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('output_guard');
    // input_guard should NOT have fired
    expect(result.violations.some((v) => v.name === 'input_guard')).toBe(false);
  });

  // ── Context propagation ───────────────────────────────────────

  it('should propagate runtime context (agentGoal) to CEL evaluation', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'goal_check',
        description: 'Check agent goal is present',
        kind: 'input',
        priority: 1,
        tier: 'local',
        // agent_goal is set in CEL context from GuardrailContext.agentGoal
        check: 'abl.length(agent_goal) > 0',
        action: { type: 'warn', message: 'Agent goal is set' },
      },
    ];

    const context: GuardrailContext = {
      agentGoal: 'Help customers book flights',
    };

    const result = await pipeline.execute(guardrails, 'Hello', 'input', context);

    // The check expression evaluates to true (goal has length > 0), so warn fires
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('goal_check');
  });

  // ── Multiple guardrails with priority ordering ────────────────

  it('should evaluate multiple input guardrails and aggregate results', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'length_check',
        description: 'Block very long input',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'abl.length(input) > 1000',
        action: { type: 'block', message: 'Input too long' },
      },
      {
        name: 'pii_check',
        description: 'Block PII',
        kind: 'input',
        priority: 2,
        tier: 'local',
        check: 'abl.contains_pii(input)',
        action: { type: 'block', message: 'PII detected' },
      },
      {
        name: 'empty_check',
        description: 'Warn on very short input',
        kind: 'input',
        priority: 3,
        tier: 'local',
        check: 'abl.length(input) < 3',
        action: { type: 'warn', message: 'Input too short' },
      },
    ];

    // Input with PII but not too long or too short
    const result = await pipeline.execute(
      guardrails,
      'Please contact me at user@domain.com for details',
      'input',
      {},
    );

    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('pii_check');
    // length_check should pass, pii_check should fail, empty_check should pass
    expect(result.metrics.totalChecks).toBe(3);
  });

  // ── Empty guardrails (no-op pipeline) ─────────────────────────

  it('should pass through when no guardrails are defined', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const result = await pipeline.execute([], 'any content', 'input', {});

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(0);
  });

  // ── Pipeline reuse across multiple calls ──────────────────────

  it('should support reusing a single pipeline instance for multiple evaluations', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'pii_block',
        description: 'Block PII',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ];

    // First call: should block
    const result1 = await pipeline.execute(guardrails, 'SSN: 123-45-6789', 'input', {});
    expect(result1.passed).toBe(false);

    // Second call with clean input: should pass (no state leakage)
    const result2 = await pipeline.execute(guardrails, 'Hello, how are you?', 'input', {});
    expect(result2.passed).toBe(true);

    // Third call: should block again
    const result3 = await pipeline.execute(
      guardrails,
      'My card is 4111-1111-1111-1111',
      'input',
      {},
    );
    expect(result3.passed).toBe(false);
  });

  // ── Metrics are populated ─────────────────────────────────────

  it('should populate pipeline metrics with latency data', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'simple_check',
        description: 'Always triggers',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'true',
        action: { type: 'warn', message: 'Always warns' },
      },
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {});

    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.tier1LatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
