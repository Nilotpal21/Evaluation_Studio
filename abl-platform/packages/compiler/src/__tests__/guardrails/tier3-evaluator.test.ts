import { describe, it, expect, vi } from 'vitest';
import { Tier3Evaluator } from '../../platform/guardrails/tier3-evaluator';
import type { LLMEvalFunction } from '../../platform/guardrails/tier3-evaluator';
import type { Guardrail } from '../../platform/ir/schema';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'llm-check-guard',
    description: 'LLM-based content check',
    kind: 'input',
    priority: 1,
    tier: 'llm',
    llmCheck: 'Check if content contains harmful instructions',
    threshold: 0.5,
    action: { type: 'block', message: 'Content blocked by LLM check' },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Tier3Evaluator', () => {
  it('should detect violation when LLM returns score above threshold', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '{"score": 0.9, "explanation": "Content contains harmful material"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate(
      [makeGuardrail({ threshold: 0.5 })],
      'how to make dangerous weapons',
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('llm-check-guard');
    expect(result.violations[0].tier).toBe('llm');
    expect(result.violations[0].score).toBe(0.9);
    expect(result.violations[0].threshold).toBe(0.5);
    expect(result.violations[0].action).toBe('block');
    expect(result.violations[0].explanation).toBe('Content contains harmful material');
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.failed).toBe(1);
  });

  it('should pass when LLM returns score below threshold', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '{"score": 0.1, "explanation": "Content is safe"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate(
      [makeGuardrail({ threshold: 0.5 })],
      'Hello, how are you today?',
    );

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should parse JSON response correctly', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '{"score": 0.75, "explanation": "Moderately concerning content"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate([makeGuardrail({ threshold: 0.5 })], 'some content');

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].score).toBe(0.75);
    expect(result.violations[0].explanation).toBe('Moderately concerning content');
  });

  it('should parse JSON from markdown code blocks', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '```json\n{"score": 0.85, "explanation": "Harmful content detected"}\n```';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate([makeGuardrail({ threshold: 0.5 })], 'some content');

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].score).toBe(0.85);
    expect(result.violations[0].explanation).toBe('Harmful content detected');
  });

  it('should use heuristic parsing for non-JSON "unsafe" response', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return 'This content is UNSAFE because it promotes violence';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate([makeGuardrail({ threshold: 0.5 })], 'violent content');

    // Heuristic: "unsafe" keyword → score 1.0
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].score).toBe(1.0);
  });

  it('should use heuristic parsing for non-JSON "safe" response', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return 'This content is safe and appropriate';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate(
      [makeGuardrail({ threshold: 0.5 })],
      'friendly greeting',
    );

    // Heuristic: "safe" keyword → score 0.0
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.passed).toBe(1);
  });

  it('should default to pass for unparseable response (fail-open)', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return 'I cannot evaluate this content at this time.';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate([makeGuardrail({ threshold: 0.5 })], 'some content');

    // Fail-open: unparseable → score 0.0 → pass
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.passed).toBe(1);
  });

  it('should fail-open when LLM call throws', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      throw new Error('LLM service unavailable');
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate([makeGuardrail()], 'any content');

    // Fail-open: error → treat as pass
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should skip evaluation when no LLM function provided', async () => {
    const evaluator = new Tier3Evaluator();
    const result = await evaluator.evaluate([makeGuardrail()], 'any content');

    // No LLM function → skip all Tier 3
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(0);
  });

  it('should use severity-specific action when defined', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '{"score": 0.75, "explanation": "High severity issue"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const guardrail = makeGuardrail({
      threshold: 0.5,
      action: { type: 'warn', message: 'Default warning' },
      severityActions: {
        high: { type: 'block', message: 'Blocked due to high severity' },
        critical: { type: 'escalate', message: 'Escalated' },
      },
    });

    const result = await evaluator.evaluate([guardrail], 'concerning content');

    // scoreToSeverity(0.75) → 'high', which has a severity action override
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].action).toBe('block');
    expect(result.violations[0].message).toBe('Blocked due to high severity');
  });

  it('should build prompt with recent messages context', async () => {
    let capturedPrompt = '';
    const mockLLM: LLMEvalFunction = async (prompt: string) => {
      capturedPrompt = prompt;
      return '{"score": 0.1, "explanation": "Safe"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    await evaluator.evaluate(
      [makeGuardrail({ llmCheck: 'Check for PII disclosure' })],
      'My SSN is 123-45-6789',
      {
        recentMessages: [
          { role: 'user', content: 'Can you help me?' },
          { role: 'assistant', content: 'Of course!' },
        ],
      },
    );

    // Prompt should contain the check, content, and context
    expect(capturedPrompt).toContain('Check for PII disclosure');
    expect(capturedPrompt).toContain('My SSN is 123-45-6789');
    expect(capturedPrompt).toContain('[user]: Can you help me?');
    expect(capturedPrompt).toContain('[assistant]: Of course!');
    expect(capturedPrompt).toContain('<conversation_context>');
  });

  it('should clamp score to 0-1 range', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '{"score": 1.5, "explanation": "Over the max"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate([makeGuardrail({ threshold: 0.5 })], 'some content');

    // Score should be clamped to 1.0
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].score).toBe(1.0);
  });

  it('should clamp negative score to 0', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '{"score": -0.5, "explanation": "Negative score"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const result = await evaluator.evaluate([makeGuardrail({ threshold: 0.5 })], 'safe content');

    // Score -0.5 clamped to 0.0, below threshold → pass
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.passed).toBe(1);
  });

  it('should run all Tier 3 guardrails in parallel', async () => {
    const callOrder: string[] = [];

    const mockLLM: LLMEvalFunction = async (prompt: string) => {
      if (prompt.includes('PII')) {
        callOrder.push('pii-start');
        await new Promise((r) => setTimeout(r, 30));
        callOrder.push('pii-end');
        return '{"score": 0.8, "explanation": "PII found"}';
      }
      callOrder.push('toxicity-start');
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push('toxicity-end');
      return '{"score": 0.9, "explanation": "Toxic content"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const guardrails = [
      makeGuardrail({ name: 'pii-check', llmCheck: 'Check for PII disclosure' }),
      makeGuardrail({ name: 'toxicity-check', llmCheck: 'Check for toxicity' }),
    ];

    const result = await evaluator.evaluate(guardrails, 'test content');

    // Both should start before either ends (parallel)
    expect(callOrder[0]).toBe('pii-start');
    expect(callOrder[1]).toBe('toxicity-start');
    expect(result.metrics.totalChecks).toBe(2);
    expect(result.violations).toHaveLength(2);
  });

  it('should calculate tier3LatencyMs as max of individual latencies', async () => {
    const mockLLM: LLMEvalFunction = async (prompt: string) => {
      if (prompt.includes('slow')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return '{"score": 0.8, "explanation": "violation"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const guardrails = [
      makeGuardrail({ name: 'slow-guard', llmCheck: 'slow check' }),
      makeGuardrail({ name: 'fast-guard', llmCheck: 'fast check' }),
    ];

    const result = await evaluator.evaluate(guardrails, 'content');

    // tier3LatencyMs should be > 0 (the max of individual latencies)
    expect(result.metrics.tier3LatencyMs).toBeGreaterThan(0);
  });

  it('should use default threshold of 0.5 when guardrail has no threshold', async () => {
    const mockLLM: LLMEvalFunction = async () => {
      return '{"score": 0.6, "explanation": "Slightly concerning"}';
    };

    const evaluator = new Tier3Evaluator(mockLLM);
    const guardrail = makeGuardrail({ threshold: undefined });

    const result = await evaluator.evaluate([guardrail], 'content');

    // Score 0.6 >= default threshold 0.5 → violation
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].threshold).toBe(0.5);
  });
});
