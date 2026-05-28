import { describe, it, expect } from 'vitest';
import { GuardrailPipelineImpl } from '@abl/compiler';
import type { Guardrail, GuardrailContext } from '@abl/compiler';

/**
 * Integration tests for tool guardrail evaluation via the real pipeline.
 *
 * These tests verify that GuardrailPipelineImpl correctly handles tool_input
 * and tool_output guardrail kinds — the same pipeline used by
 * FlowStepExecutor.executeFlowCall() in production. The wiring from executor
 * to pipeline is covered by E2E tests; this suite validates pipeline behavior
 * for tool-specific guardrail scenarios.
 *
 * Replaces the previous mock-heavy unit tests (21 vi.mock() calls) with
 * zero-mock integration tests against the real pipeline.
 */
describe('Tool guardrail pipeline integration', () => {
  // ── tool_input guardrails (pre-tool-execution) ──────────────────

  it('should evaluate tool_input guardrails and pass clean input', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'tool-input-pii-block',
        description: 'Block PII in tool inputs',
        kind: 'tool_input',
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII detected in tool input' },
        priority: 1,
      },
    ];

    const context: GuardrailContext = { toolName: 'search' };
    const result = await pipeline.execute(
      guardrails,
      'search for hotels in Paris',
      'tool_input',
      context,
    );

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should block tool_input containing PII before tool execution', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'tool-input-pii-block',
        description: 'Block PII in tool inputs',
        kind: 'tool_input',
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII detected in tool input' },
        priority: 1,
      },
    ];

    const context: GuardrailContext = { toolName: 'search' };
    const result = await pipeline.execute(
      guardrails,
      'search for SSN 123-45-6789',
      'tool_input',
      context,
    );

    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('tool-input-pii-block');
    expect(result.primaryViolation?.action).toBe('block');
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.failed).toBe(1);
  });

  // ── tool_output guardrails (post-tool-execution) ────────────────

  it('should evaluate tool_output guardrails and block PII in output', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'tool-output-pii-block',
        description: 'Block PII in tool outputs',
        kind: 'tool_output',
        tier: 'local',
        check: 'abl.contains_pii(tool_output)',
        action: { type: 'block', message: 'PII in tool output' },
        priority: 1,
      },
    ];

    const context: GuardrailContext = {
      toolName: 'search',
      toolSuccess: true,
      toolDurationMs: 150,
    };
    const result = await pipeline.execute(
      guardrails,
      'User SSN: 123-45-6789',
      'tool_output',
      context,
    );

    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('tool-output-pii-block');
    expect(result.primaryViolation?.action).toBe('block');
  });

  it('should pass clean tool_output through guardrails', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'tool-output-pii-block',
        description: 'Block PII in tool outputs',
        kind: 'tool_output',
        tier: 'local',
        check: 'abl.contains_pii(tool_output)',
        action: { type: 'block', message: 'PII in tool output' },
        priority: 1,
      },
    ];

    const context: GuardrailContext = { toolName: 'search', toolSuccess: true };
    const result = await pipeline.execute(
      guardrails,
      'Found 3 hotels in Paris with available rooms',
      'tool_output',
      context,
    );

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // ── Kind filtering: tool_input vs tool_output ───────────────────

  it('should only evaluate guardrails matching the requested kind', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'input-only-guard',
        description: 'Only fires on tool_input',
        kind: 'tool_input',
        tier: 'local',
        check: 'true', // Always triggers
        action: { type: 'block', message: 'Blocked by input guard' },
        priority: 1,
      },
      {
        name: 'output-only-guard',
        description: 'Only fires on tool_output',
        kind: 'tool_output',
        tier: 'local',
        check: 'true', // Always triggers
        action: { type: 'warn', message: 'Warning from output guard' },
        priority: 1,
      },
    ];

    // Evaluating as tool_output should NOT trigger the tool_input guard
    const outputResult = await pipeline.execute(guardrails, 'any content', 'tool_output', {});
    expect(outputResult.passed).toBe(true); // warn does not fail
    expect(outputResult.warnings).toHaveLength(1);
    expect(outputResult.warnings[0].name).toBe('output-only-guard');
    // input guard should NOT have fired
    expect(outputResult.violations.some((v) => v.name === 'input-only-guard')).toBe(false);

    // Evaluating as tool_input should NOT trigger the tool_output guard
    const inputResult = await pipeline.execute(guardrails, 'any content', 'tool_input', {});
    expect(inputResult.passed).toBe(false); // block fails the pipeline
    expect(inputResult.violations).toHaveLength(1);
    expect(inputResult.violations[0].name).toBe('input-only-guard');
    expect(inputResult.warnings.some((w) => w.name === 'output-only-guard')).toBe(false);
  });

  // ── tool_input and tool_output are separate from input/output ───

  it('should not cross-fire between tool and non-tool guardrail kinds', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'regular-input-guard',
        description: 'Fires on regular input only',
        kind: 'input',
        tier: 'local',
        check: 'true',
        action: { type: 'block', message: 'Blocked by regular input guard' },
        priority: 1,
      },
      {
        name: 'tool-input-guard',
        description: 'Fires on tool_input only',
        kind: 'tool_input',
        tier: 'local',
        check: 'true',
        action: { type: 'block', message: 'Blocked by tool input guard' },
        priority: 1,
      },
    ];

    // Regular input guard should not fire for tool_input evaluation
    const toolResult = await pipeline.execute(guardrails, 'test content', 'tool_input', {});
    expect(toolResult.violations).toHaveLength(1);
    expect(toolResult.violations[0].name).toBe('tool-input-guard');

    // Tool input guard should not fire for regular input evaluation
    const inputResult = await pipeline.execute(guardrails, 'test content', 'input', {});
    expect(inputResult.violations).toHaveLength(1);
    expect(inputResult.violations[0].name).toBe('regular-input-guard');
  });

  // ── No tool guardrails = pipeline is a no-op ───────────────────

  it('should pass through when no guardrails are defined', async () => {
    const pipeline = new GuardrailPipelineImpl();

    const inputResult = await pipeline.execute([], 'any content', 'tool_input', {});
    expect(inputResult.passed).toBe(true);
    expect(inputResult.violations).toHaveLength(0);
    expect(inputResult.warnings).toHaveLength(0);
    expect(inputResult.metrics.totalChecks).toBe(0);

    const outputResult = await pipeline.execute([], 'any content', 'tool_output', {});
    expect(outputResult.passed).toBe(true);
    expect(outputResult.metrics.totalChecks).toBe(0);
  });

  it('should pass through when guardrails exist but none match the tool kind', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'input-guard',
        description: 'Only fires on regular input',
        kind: 'input',
        tier: 'local',
        check: 'true',
        action: { type: 'block', message: 'Blocked' },
        priority: 1,
      },
    ];

    // No tool_input guardrails defined, so pipeline should be a no-op
    const result = await pipeline.execute(guardrails, 'test content', 'tool_input', {});
    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(0);
  });

  // ── Tool context propagation ────────────────────────────────────

  it('should propagate tool context to CEL evaluation for tool_input', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'tool-input-length-guard',
        description: 'Block excessively long tool inputs',
        kind: 'tool_input',
        tier: 'local',
        check: 'abl.length(tool_input) > 100',
        action: { type: 'block', message: 'Tool input too long' },
        priority: 1,
      },
    ];

    const context: GuardrailContext = { toolName: 'search' };

    // Short input should pass
    const shortResult = await pipeline.execute(guardrails, 'short query', 'tool_input', context);
    expect(shortResult.passed).toBe(true);

    // Long input should block
    const longInput = 'a'.repeat(200);
    const longResult = await pipeline.execute(guardrails, longInput, 'tool_input', context);
    expect(longResult.passed).toBe(false);
    expect(longResult.primaryViolation?.name).toBe('tool-input-length-guard');
  });

  it('should propagate tool context to CEL evaluation for tool_output', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'tool-name-check',
        description: 'Warn when specific tool name is used',
        kind: 'tool_output',
        tier: 'local',
        check: 'tool_name == "dangerous-tool"',
        action: { type: 'warn', message: 'Dangerous tool was used' },
        priority: 1,
      },
    ];

    // Safe tool name should not warn
    const safeResult = await pipeline.execute(guardrails, 'result data', 'tool_output', {
      toolName: 'search',
      toolSuccess: true,
    });
    expect(safeResult.passed).toBe(true);
    expect(safeResult.warnings).toHaveLength(0);

    // Dangerous tool name should warn
    const dangerResult = await pipeline.execute(guardrails, 'result data', 'tool_output', {
      toolName: 'dangerous-tool',
      toolSuccess: true,
    });
    expect(dangerResult.passed).toBe(true); // warn does not fail
    expect(dangerResult.warnings).toHaveLength(1);
    expect(dangerResult.warnings[0].name).toBe('tool-name-check');
  });

  // ── Multiple tool guardrails with priority ordering ─────────────

  it('should evaluate multiple tool guardrails and report primary violation by priority', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'pii-check',
        description: 'Block PII in tool input',
        kind: 'tool_input',
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII detected' },
        priority: 1,
      },
      {
        name: 'length-check',
        description: 'Warn on long tool input',
        kind: 'tool_input',
        tier: 'local',
        check: 'abl.length(tool_input) > 10',
        action: { type: 'warn', message: 'Input is long' },
        priority: 2,
      },
    ];

    // Input with PII and moderate length
    const result = await pipeline.execute(
      guardrails,
      'SSN: 123-45-6789 with extra data',
      'tool_input',
      { toolName: 'search' },
    );

    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('pii-check');
    // Both checks should have been evaluated
    expect(result.metrics.totalChecks).toBe(2);
  });

  // ── Pipeline reuse across tool evaluations ──────────────────────

  it('should support reusing a pipeline instance across tool_input and tool_output evaluations', async () => {
    const pipeline = new GuardrailPipelineImpl();

    const inputGuardrails: Guardrail[] = [
      {
        name: 'tool-input-pii',
        description: 'Block PII in tool inputs',
        kind: 'tool_input',
        tier: 'local',
        check: 'abl.contains_pii(tool_input)',
        action: { type: 'block', message: 'PII in input' },
        priority: 1,
      },
    ];

    const outputGuardrails: Guardrail[] = [
      {
        name: 'tool-output-pii',
        description: 'Block PII in tool outputs',
        kind: 'tool_output',
        tier: 'local',
        check: 'abl.contains_pii(tool_output)',
        action: { type: 'block', message: 'PII in output' },
        priority: 1,
      },
    ];

    // First: clean tool_input should pass
    const inputPass = await pipeline.execute(
      inputGuardrails,
      'search hotels in Paris',
      'tool_input',
      { toolName: 'search' },
    );
    expect(inputPass.passed).toBe(true);

    // Second: PII in tool_output should block
    const outputBlock = await pipeline.execute(
      outputGuardrails,
      'Customer SSN: 123-45-6789',
      'tool_output',
      { toolName: 'search', toolSuccess: true },
    );
    expect(outputBlock.passed).toBe(false);
    expect(outputBlock.primaryViolation?.name).toBe('tool-output-pii');

    // Third: clean tool_output should pass (no state leakage)
    const outputPass = await pipeline.execute(
      outputGuardrails,
      'Found 3 hotels with available rooms',
      'tool_output',
      { toolName: 'search', toolSuccess: true },
    );
    expect(outputPass.passed).toBe(true);
  });

  // ── Metrics are populated for tool guardrails ───────────────────

  it('should populate pipeline metrics with latency data for tool guardrails', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'tool-input-check',
        description: 'Always warns',
        kind: 'tool_input',
        tier: 'local',
        check: 'true',
        action: { type: 'warn', message: 'Always warns' },
        priority: 1,
      },
    ];

    const result = await pipeline.execute(guardrails, 'test input', 'tool_input', {
      toolName: 'search',
    });

    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.tier1LatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
