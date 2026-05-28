import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../platform/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import { createEmptyPipelineResult } from '../../platform/guardrails/types';
import type { Guardrail, GuardrailViolation } from '../../platform/ir/schema';

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

function makeTier2ViolationResult(costUsd: number) {
  const result = createEmptyPipelineResult();
  const violation: GuardrailViolation = {
    name: 'model_check',
    kind: 'input',
    tier: 'model',
    action: 'block',
    severity: 'high',
    message: 'blocked',
    priority: 1,
    latencyMs: 5,
  };

  result.passed = false;
  result.violations = [violation];
  result.primaryViolation = violation;
  result.metrics.totalChecks = 1;
  result.metrics.failed = 1;
  result.metrics.tier2LatencyMs = 5;
  result.metrics.totalLatencyMs = 5;
  result.metrics.costUsd = costUsd;

  return result;
}

async function flushBestEffortWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('Guardrail pipeline side-effect handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('logs cost recording failures instead of swallowing them', async () => {
    const costChecker = {
      checkBudget: vi.fn().mockResolvedValue({ exceeded: false, action: 'none' }),
      recordCost: vi.fn().mockRejectedValue(new Error('billing unavailable')),
    };

    const pipeline = new GuardrailPipelineImpl(undefined, undefined, { costChecker });
    vi.spyOn((pipeline as any).tier2, 'evaluate').mockResolvedValue(makeTier2ViolationResult(0.42));

    await pipeline.execute(
      [
        guardrail({
          name: 'model_check',
          tier: 'model',
          provider: 'test-provider',
          action: { type: 'block' },
        }),
      ],
      'hello',
      'input',
      {},
    );

    await flushBestEffortWork();

    expect(costChecker.recordCost).toHaveBeenCalledWith(0.42);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Guardrail pipeline side effect failed',
      expect.objectContaining({
        sideEffect: 'record guardrail evaluation cost',
        error: 'billing unavailable',
      }),
    );
  });

  test('logs webhook delivery failures instead of swallowing them', async () => {
    const webhook = {
      deliver: vi.fn().mockRejectedValue(new Error('webhook offline')),
    };

    const pipeline = new GuardrailPipelineImpl(undefined, undefined, { webhook });

    await pipeline.execute(
      [
        guardrail({
          name: 'warn_check',
          tier: 'local',
          action: { type: 'warn' },
        }),
      ],
      'hello',
      'input',
      {},
    );

    await flushBestEffortWork();

    expect(webhook.deliver).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Guardrail pipeline side effect failed',
      expect.objectContaining({
        sideEffect: 'deliver guardrail warning webhook',
        error: 'webhook offline',
      }),
    );
  });
});
