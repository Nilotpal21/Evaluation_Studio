/**
 * TDD lock tests for the reask retry loop — Slice 2 [ABLP-413]
 *
 * Tests the reask retry orchestration logic: when a guardrail returns
 * action='reask', the executor retries the LLM up to maxReasks times,
 * emitting guardrail_reask trace events on each attempt.
 *
 * Uses dependency injection for the LLM and guardrail checker — no vi.mock.
 */

import { describe, it, expect } from 'vitest';
import {
  executeReaskLoop,
  type ReaskLoopDeps,
  type ReaskLoopResult,
} from '../services/execution/reask-executor.js';
import type { OutputGuardrailResult } from '../services/execution/output-guardrails.js';

/**
 * Helper: creates a guardrail result for a reask violation.
 */
function makeReaskViolation(guardrailName = 'output-guard'): OutputGuardrailResult {
  return {
    passed: false,
    text: 'bad content',
    violation: {
      guardrailName,
      action: 'reask',
      message: 'Content violates policy',
    },
    pipelineResult: {
      passed: false,
      violations: [
        {
          name: guardrailName,
          kind: 'output',
          tier: 'local',
          action: 'reask',
          severity: 'high',
          message: 'Content violates policy',
          priority: 1,
          latencyMs: 5,
          resolvedAction: { type: 'reask', maxReasks: 2 },
        },
      ],
      primaryViolation: {
        name: guardrailName,
        kind: 'output',
        tier: 'local',
        action: 'reask',
        severity: 'high',
        message: 'Content violates policy',
        priority: 1,
        latencyMs: 5,
        resolvedAction: { type: 'reask', maxReasks: 2 },
      },
      warnings: [],
      metrics: {
        totalChecks: 1,
        passed: 0,
        failed: 1,
        warnings: 0,
        totalLatencyMs: 5,
        tier1LatencyMs: 5,
        tier2LatencyMs: 0,
        tier3LatencyMs: 0,
        compoundFPREstimate: 0,
        costUsd: 0,
        cacheHits: 0,
        cacheMisses: 0,
        policyVersion: 0,
      },
    },
  };
}

function makePassingResult(text: string): OutputGuardrailResult {
  return {
    passed: true,
    text,
    pipelineResult: {
      passed: true,
      violations: [],
      warnings: [],
      metrics: {
        totalChecks: 1,
        passed: 1,
        failed: 0,
        warnings: 0,
        totalLatencyMs: 3,
        tier1LatencyMs: 3,
        tier2LatencyMs: 0,
        tier3LatencyMs: 0,
        compoundFPREstimate: 0,
        costUsd: 0,
        cacheHits: 0,
        cacheMisses: 0,
        policyVersion: 0,
      },
    },
  };
}

describe('executeReaskLoop', () => {
  it('should retry the LLM and return clean content when guardrail passes on retry', async () => {
    let llmCallCount = 0;
    const deps: ReaskLoopDeps = {
      generateResponse: async () => {
        llmCallCount++;
        // Retry 1 returns bad, retry 2 returns clean
        return llmCallCount === 1 ? 'bad content' : 'clean content';
      },
      checkGuardrails: async (text: string) => {
        if (text === 'clean content') return makePassingResult(text);
        return makeReaskViolation();
      },
      onTraceEvent: () => {},
      agentName: 'test-agent',
    };

    const result = await executeReaskLoop(deps, makeReaskViolation(), 2);

    expect(result.finalText).toBe('clean content');
    expect(result.reaskCount).toBe(2);
    expect(result.succeeded).toBe(true);
    // executeReaskLoop is called AFTER the first guardrail failure.
    // Retry 1 → bad content (llmCallCount=1), retry 2 → clean content (llmCallCount=2)
    expect(llmCallCount).toBe(2);
  });

  it('should emit guardrail_reask trace events on each retry attempt', async () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    let callCount = 0;

    const deps: ReaskLoopDeps = {
      generateResponse: async () => {
        callCount++;
        return callCount === 2 ? 'clean content' : 'bad content';
      },
      checkGuardrails: async (text: string) => {
        if (text === 'clean content') return makePassingResult(text);
        return makeReaskViolation();
      },
      onTraceEvent: (event) => traceEvents.push(event),
      agentName: 'test-agent',
    };

    await executeReaskLoop(deps, makeReaskViolation(), 2);

    const reaskTraces = traceEvents.filter((e) => e.type === 'guardrail_reask');
    expect(reaskTraces.length).toBeGreaterThanOrEqual(1);
    expect(reaskTraces[0].data).toHaveProperty('reaskCount');
    expect(reaskTraces[0].data).toHaveProperty('maxReasks');
  });

  it('should fall back to block message when all retries produce bad content', async () => {
    const deps: ReaskLoopDeps = {
      generateResponse: async () => 'always bad content',
      checkGuardrails: async () => makeReaskViolation(),
      onTraceEvent: () => {},
      agentName: 'test-agent',
    };

    const result = await executeReaskLoop(deps, makeReaskViolation(), 2);

    expect(result.succeeded).toBe(false);
    expect(result.reaskCount).toBe(2);
    // Should return a safe fallback, not the bad content
    expect(result.finalText).not.toBe('always bad content');
  });

  it('should hard-cap maxReasks at 5 even if configured higher', async () => {
    let callCount = 0;
    const deps: ReaskLoopDeps = {
      generateResponse: async () => {
        callCount++;
        return 'bad content';
      },
      checkGuardrails: async () => makeReaskViolation(),
      onTraceEvent: () => {},
      agentName: 'test-agent',
    };

    // Request 10 reasks — should be capped at 5
    const result = await executeReaskLoop(deps, makeReaskViolation(), 10);

    expect(result.reaskCount).toBeLessThanOrEqual(5);
    expect(callCount).toBeLessThanOrEqual(5);
    expect(result.succeeded).toBe(false);
  });
});
