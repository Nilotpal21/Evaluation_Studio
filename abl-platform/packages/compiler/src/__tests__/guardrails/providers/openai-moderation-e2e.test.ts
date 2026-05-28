/**
 * openai-moderation provider × kind E2E tests.
 *
 * Tests the full guardrail pipeline with the openai-moderation provider
 * across all 5 guardrail kinds (input, output, tool_input, tool_output, handoff)
 * and the valid action types for each kind.
 *
 * All OpenAI API calls are mocked via vi.stubGlobal('fetch').
 *
 * Valid actions per kind (from guardrail-validator.ts):
 *   input:       block, warn, redact, fix, filter, escalate
 *   output:      block, warn, redact, fix, reask, filter, escalate
 *   tool_input:  block, warn, redact, fix, filter, escalate
 *   tool_output: block, warn, redact, fix, filter, escalate
 *   handoff:     block, warn, redact, escalate
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailPipelineImpl } from '../../../platform/guardrails/pipeline';
import { GuardrailProviderRegistry } from '../../../platform/guardrails/provider-registry';
import { OpenAIModerationProvider } from '../../../platform/guardrails/providers/openai-moderation';
import type { Guardrail, GuardrailKind } from '../../../platform/ir/schema';

// ── Mock fetch globally ────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Build a mock OpenAI moderation API response. */
function moderationResponse(
  categories: Record<string, boolean>,
  scores: Record<string, number>,
  flagged = true,
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [{ flagged, categories, category_scores: scores }],
    }),
  };
}

/** Flagged hate response (score 0.92 > default threshold 0.5). */
function flaggedHateResponse() {
  return moderationResponse({ hate: true, violence: false }, { hate: 0.92, violence: 0.01 });
}

/** Safe response (no categories flagged). */
function safeResponse() {
  return moderationResponse(
    { hate: false, violence: false },
    { hate: 0.01, violence: 0.002 },
    false,
  );
}

function createPipeline(): GuardrailPipelineImpl {
  const registry = new GuardrailProviderRegistry();
  const provider = new OpenAIModerationProvider({ apiKey: 'test-key-e2e' });
  registry.register(provider);
  return new GuardrailPipelineImpl(registry);
}

function moderationGuardrail(overrides: Partial<Guardrail> & { kind: GuardrailKind }): Guardrail {
  return {
    name: `moderation_${overrides.kind}_check`,
    description: 'OpenAI moderation guardrail',
    kind: overrides.kind,
    priority: 1,
    tier: 'model',
    provider: 'openai-moderation',
    category: 'hate',
    threshold: 0.5,
    action: { type: 'block' },
    ...overrides,
  };
}

describe('openai-moderation provider × kind E2E', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // =========================================================================
  // INPUT KIND
  // =========================================================================
  describe('kind: input', () => {
    it('should block input flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [
          moderationGuardrail({
            kind: 'input',
            action: { type: 'block', message: 'Hate speech detected' },
          }),
        ],
        'hateful content',
        'input',
        {},
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].provider).toBe('openai-moderation');
      expect(result.violations[0].kind).toBe('input');
      expect(result.violations[0].score).toBeCloseTo(0.92, 1);
    });

    it('should warn on input flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'warn' } })],
        'hateful content',
        'input',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].action).toBe('warn');
      expect(result.warnings[0].provider).toBe('openai-moderation');
    });

    it('should redact input flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'redact', redactMode: 'pii' } })],
        'hateful content',
        'input',
        {},
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean input', async () => {
      mockFetch.mockResolvedValueOnce(safeResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'block' } })],
        'hello world',
        'input',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should escalate input flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'escalate' } })],
        'hateful content',
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
    it('should block output flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'output', action: { type: 'block' } })],
        'hateful output',
        'output',
        {},
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('output');
    });

    it('should warn on output flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'output', action: { type: 'warn' } })],
        'hateful output',
        'output',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('output');
    });

    it('should redact output flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'output', action: { type: 'redact', redactMode: 'pii' } })],
        'hateful output',
        'output',
        {},
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean output', async () => {
      mockFetch.mockResolvedValueOnce(safeResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'output', action: { type: 'block' } })],
        'friendly response',
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
    const toolContext = { toolName: 'search_api', toolParameters: { query: 'test' } };

    it('should block tool_input flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'tool_input', action: { type: 'block' } })],
        'hateful tool input',
        'tool_input',
        toolContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('tool_input');
    });

    it('should warn on tool_input flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'tool_input', action: { type: 'warn' } })],
        'hateful tool input',
        'tool_input',
        toolContext,
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('tool_input');
    });

    it('should redact tool_input flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [
          moderationGuardrail({
            kind: 'tool_input',
            action: { type: 'redact', redactMode: 'pii' },
          }),
        ],
        'hateful tool input',
        'tool_input',
        toolContext,
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean tool_input', async () => {
      mockFetch.mockResolvedValueOnce(safeResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'tool_input', action: { type: 'block' } })],
        'safe tool input',
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
      toolName: 'content_gen',
      toolResult: { text: 'generated content' },
      toolSuccess: true,
      toolDurationMs: 200,
    };

    it('should block tool_output flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'tool_output', action: { type: 'block' } })],
        'hateful tool output',
        'tool_output',
        toolOutputContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('tool_output');
    });

    it('should warn on tool_output flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'tool_output', action: { type: 'warn' } })],
        'hateful tool output',
        'tool_output',
        toolOutputContext,
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('tool_output');
    });

    it('should redact tool_output flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [
          moderationGuardrail({
            kind: 'tool_output',
            action: { type: 'redact', redactMode: 'pii' },
          }),
        ],
        'hateful tool output',
        'tool_output',
        toolOutputContext,
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should pass clean tool_output', async () => {
      mockFetch.mockResolvedValueOnce(safeResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'tool_output', action: { type: 'block' } })],
        'safe tool output',
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
      handoffContext: 'Customer escalation',
      handoffReason: 'specialized_help',
    };

    it('should block handoff flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'handoff', action: { type: 'block' } })],
        'hateful handoff content',
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].kind).toBe('handoff');
    });

    it('should warn on handoff flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'handoff', action: { type: 'warn' } })],
        'hateful handoff content',
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('handoff');
    });

    it('should redact handoff flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'handoff', action: { type: 'redact', redactMode: 'pii' } })],
        'hateful handoff content',
        'handoff',
        handoffContext,
      );

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });

    it('should escalate handoff flagged for hate', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'handoff', action: { type: 'escalate' } })],
        'hateful handoff content',
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('escalate');
    });

    it('should pass clean handoff', async () => {
      mockFetch.mockResolvedValueOnce(safeResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'handoff', action: { type: 'block' } })],
        'friendly handoff content',
        'handoff',
        handoffContext,
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // =========================================================================
  // CROSS-KIND AND PROVIDER-SPECIFIC TESTS
  // =========================================================================
  describe('cross-kind and provider-specific behavior', () => {
    it('should only evaluate guardrails matching the requested kind', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const guardrails = [
        moderationGuardrail({ name: 'input_mod', kind: 'input', action: { type: 'block' } }),
        moderationGuardrail({ name: 'output_mod', kind: 'output', action: { type: 'block' } }),
      ];

      const result = await pipeline.execute(guardrails, 'hateful content', 'input', {});

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('input_mod');
      // Only 1 fetch call (for the input guardrail)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should send correct content to OpenAI API', async () => {
      mockFetch.mockResolvedValueOnce(safeResponse());
      const pipeline = createPipeline();

      await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'block' } })],
        'content to check',
        'input',
        {},
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input).toBe('content to check');
    });

    it('should handle API errors gracefully (fail-open)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'block' } })],
        'test content',
        'input',
        {},
      );

      // Fail-open: API error → safe → no violation
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should handle network errors gracefully (fail-open)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'block' } })],
        'test content',
        'input',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should detect violence category across kinds', async () => {
      mockFetch.mockResolvedValueOnce(
        moderationResponse({ hate: false, violence: true }, { hate: 0.02, violence: 0.88 }),
      );
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [
          moderationGuardrail({
            kind: 'output',
            category: 'violence',
            action: { type: 'block' },
          }),
        ],
        'violent content',
        'output',
        {},
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].score).toBeCloseTo(0.88, 1);
    });

    it('should use severity-based action mapping', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const guardrail = moderationGuardrail({
        kind: 'input',
        action: { type: 'warn' },
        severityActions: {
          critical: { type: 'block', message: 'Critical hate content blocked' },
          high: { type: 'warn' },
        },
      });

      // Score 0.92 → severity 'critical' → should use block action from severityActions
      const result = await pipeline.execute([guardrail], 'hateful content', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
    });

    it('should track metrics correctly', async () => {
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', action: { type: 'block' } })],
        'hateful content',
        'input',
        {},
      );

      expect(result.metrics.totalChecks).toBe(1);
      expect(result.metrics.failed).toBe(1);
      expect(result.metrics.tier2LatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.costUsd).toBe(0); // OpenAI moderation is free
    });

    it('should respect custom threshold', async () => {
      // Score 0.92 but threshold set to 0.95 → should pass
      mockFetch.mockResolvedValueOnce(flaggedHateResponse());
      const pipeline = createPipeline();

      const result = await pipeline.execute(
        [moderationGuardrail({ kind: 'input', threshold: 0.95, action: { type: 'block' } })],
        'borderline content',
        'input',
        {},
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });
});
