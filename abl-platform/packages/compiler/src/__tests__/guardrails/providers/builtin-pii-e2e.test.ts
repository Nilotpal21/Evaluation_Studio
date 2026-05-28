/**
 * builtin-pii provider × kind E2E tests.
 *
 * Tests the full guardrail pipeline with the builtin-pii provider
 * across all 5 guardrail kinds (input, output, tool_input, tool_output, handoff)
 * and the valid action types for each kind.
 *
 * Valid actions per kind (from guardrail-validator.ts):
 *   input:       block, warn, redact, fix, filter, escalate
 *   output:      block, warn, redact, fix, reask, filter, escalate
 *   tool_input:  block, warn, redact, fix, filter, escalate
 *   tool_output: block, warn, redact, fix, filter, escalate
 *   handoff:     block, warn, redact, escalate
 */
import { describe, it, expect } from 'vitest';
import { GuardrailPipelineImpl } from '../../../platform/guardrails/pipeline';
import { GuardrailProviderRegistry } from '../../../platform/guardrails/provider-registry';
import type { Guardrail, GuardrailKind } from '../../../platform/ir/schema';

// The registry auto-registers builtin-pii on construction
function createPipeline(): GuardrailPipelineImpl {
  const registry = new GuardrailProviderRegistry();
  return new GuardrailPipelineImpl(registry);
}

function piiGuardrail(overrides: Partial<Guardrail> & { kind: GuardrailKind }): Guardrail {
  return {
    name: `pii_${overrides.kind}_check`,
    description: 'PII detection guardrail',
    kind: overrides.kind,
    priority: 1,
    tier: 'model',
    provider: 'builtin-pii',
    category: 'pii',
    threshold: 0.5,
    action: { type: 'block' },
    ...overrides,
  };
}

const PII_CONTENT = 'Contact john@example.com or call 555-123-4567';
const CLEAN_CONTENT = 'Hello, how are you today?';

describe('builtin-pii provider × kind E2E', () => {
  // =========================================================================
  // INPUT KIND
  // =========================================================================
  describe('kind: input', () => {
    it('should block input containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [
          piiGuardrail({
            kind: 'input',
            action: { type: 'block', message: 'PII detected in input' },
          }),
        ],
        PII_CONTENT,
        'input',
        {},
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].provider).toBe('builtin-pii');
      expect(result.violations[0].kind).toBe('input');
    });

    it('should warn on input containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'input', action: { type: 'warn', message: 'PII found in input' } })],
        PII_CONTENT,
        'input',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].action).toBe('warn');
      expect(result.warnings[0].provider).toBe('builtin-pii');
    });

    it('should redact PII from input', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [
          piiGuardrail({
            kind: 'input',
            action: { type: 'redact', redactMode: 'pii' },
          }),
        ],
        PII_CONTENT,
        'input',
        {},
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean input', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'input', action: { type: 'block' } })],
        CLEAN_CONTENT,
        'input',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should escalate input containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'input', action: { type: 'escalate' } })],
        PII_CONTENT,
        'input',
        {},
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('escalate');
    });
  });

  // =========================================================================
  // OUTPUT KIND
  // =========================================================================
  describe('kind: output', () => {
    it('should block output containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'output', action: { type: 'block', message: 'PII in output' } })],
        PII_CONTENT,
        'output',
        {},
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('output');
    });

    it('should warn on output containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'output', action: { type: 'warn' } })],
        PII_CONTENT,
        'output',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('output');
    });

    it('should redact PII from output', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'output', action: { type: 'redact', redactMode: 'pii' } })],
        PII_CONTENT,
        'output',
        {},
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean output', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'output', action: { type: 'block' } })],
        CLEAN_CONTENT,
        'output',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // =========================================================================
  // TOOL_INPUT KIND
  // =========================================================================
  describe('kind: tool_input', () => {
    const toolContext = { toolName: 'search_api', toolParameters: { query: PII_CONTENT } };

    it('should block tool_input containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_input', action: { type: 'block' } })],
        PII_CONTENT,
        'tool_input',
        toolContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('tool_input');
    });

    it('should warn on tool_input containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_input', action: { type: 'warn' } })],
        PII_CONTENT,
        'tool_input',
        toolContext,
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('tool_input');
    });

    it('should redact PII from tool_input', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_input', action: { type: 'redact', redactMode: 'pii' } })],
        PII_CONTENT,
        'tool_input',
        toolContext,
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean tool_input', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_input', action: { type: 'block' } })],
        CLEAN_CONTENT,
        'tool_input',
        toolContext,
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // =========================================================================
  // TOOL_OUTPUT KIND
  // =========================================================================
  describe('kind: tool_output', () => {
    const toolOutputContext = {
      toolName: 'customer_lookup',
      toolResult: { name: 'John', email: 'john@example.com' },
      toolSuccess: true,
      toolDurationMs: 150,
    };

    it('should block tool_output containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_output', action: { type: 'block' } })],
        PII_CONTENT,
        'tool_output',
        toolOutputContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('tool_output');
    });

    it('should warn on tool_output containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_output', action: { type: 'warn' } })],
        PII_CONTENT,
        'tool_output',
        toolOutputContext,
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('tool_output');
    });

    it('should redact PII from tool_output', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_output', action: { type: 'redact', redactMode: 'pii' } })],
        PII_CONTENT,
        'tool_output',
        toolOutputContext,
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean tool_output', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'tool_output', action: { type: 'block' } })],
        CLEAN_CONTENT,
        'tool_output',
        toolOutputContext,
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // =========================================================================
  // HANDOFF KIND
  // =========================================================================
  describe('kind: handoff', () => {
    const handoffContext = {
      sourceAgent: 'triage_agent',
      targetAgent: 'specialist_agent',
      handoffContext: 'Customer needs specialized help',
      handoffReason: 'escalation',
    };

    it('should block handoff containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'handoff', action: { type: 'block' } })],
        PII_CONTENT,
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('handoff');
    });

    it('should warn on handoff containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'handoff', action: { type: 'warn' } })],
        PII_CONTENT,
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('handoff');
    });

    it('should redact PII from handoff', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'handoff', action: { type: 'redact', redactMode: 'pii' } })],
        PII_CONTENT,
        'handoff',
        handoffContext,
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should escalate handoff containing PII', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'handoff', action: { type: 'escalate' } })],
        PII_CONTENT,
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('escalate');
    });

    it('should pass clean handoff', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'handoff', action: { type: 'block' } })],
        CLEAN_CONTENT,
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // =========================================================================
  // CROSS-KIND TESTS
  // =========================================================================
  describe('cross-kind behavior', () => {
    it('should only evaluate guardrails matching the requested kind', async () => {
      const pipeline = createPipeline();
      const guardrails = [
        piiGuardrail({ name: 'input_pii', kind: 'input', action: { type: 'block' } }),
        piiGuardrail({ name: 'output_pii', kind: 'output', action: { type: 'block' } }),
      ];

      const result = await pipeline.execute(guardrails, PII_CONTENT, 'input', {});

      // Only the input guardrail should fire
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('input_pii');
    });

    it('should report correct severity from PII detection score', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'input', action: { type: 'warn' } })],
        'My SSN is 123-45-6789',
        'input',
        {},
      );

      // PII detected → score 1.0 → severity 'critical'
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].severity).toBe('critical');
      expect(result.warnings[0].score).toBe(1.0);
    });

    it('should track metrics across evaluation', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.execute(
        [piiGuardrail({ kind: 'input', action: { type: 'block' } })],
        PII_CONTENT,
        'input',
        {},
      );

      expect(result.metrics.totalChecks).toBe(1);
      expect(result.metrics.failed).toBe(1);
      expect(result.metrics.tier2LatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should use severity-based action mapping when severityActions defined', async () => {
      const pipeline = createPipeline();
      const guardrail = piiGuardrail({
        kind: 'input',
        action: { type: 'warn' },
        severityActions: {
          critical: { type: 'block', message: 'Critical PII found' },
          high: { type: 'warn' },
        },
      });

      // PII score = 1.0 → severity = critical → should use block action
      const result = await pipeline.execute([guardrail], PII_CONTENT, 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
    });
  });
});
