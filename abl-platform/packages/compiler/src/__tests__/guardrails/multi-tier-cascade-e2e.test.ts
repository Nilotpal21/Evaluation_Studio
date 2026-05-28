/**
 * Multi-Tier Cascade and Action Combination E2E Tests
 *
 * Tests the guardrail pipeline's tiered evaluation:
 *   - Tier ordering: local → model → llm
 *   - Early termination: tier1 block skips tier2/tier3
 *   - Mixed actions across tiers
 *   - All valid action × kind combinations from guardrail-validator
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import { GuardrailProviderRegistry } from '../../platform/guardrails/provider-registry';
import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '../../platform/guardrails/provider';
import type { LLMEvalFunction } from '../../platform/guardrails/tier3-evaluator';
import type { Guardrail, GuardrailKind, GuardrailActionType } from '../../platform/ir/schema';

// ─── Mock Fetch (needed for custom-http if used) ───────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Mock Provider ──────────────────────────────────────────────────────────

class MockProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd: number;
  private result: GuardrailEvalResult;
  evaluateCalled = false;

  constructor(name: string, result: Partial<GuardrailEvalResult>, cost = 0.001) {
    this.name = name;
    this.costPerEvalUsd = cost;
    this.result = {
      score: 0,
      severity: 'safe',
      category: 'test',
      latencyMs: 1,
      ...result,
    };
  }

  async evaluate(): Promise<GuardrailEvalResult> {
    this.evaluateCalled = true;
    return this.result;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGuardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test-guard',
    description: 'Test guardrail',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Multi-Tier Cascade E2E', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ─── Tier Ordering ──────────────────────────────────────────────────────

  describe('tier ordering: local → model → llm', () => {
    it('should evaluate tier1 (local) before tier2 (model)', async () => {
      const modelProvider = new MockProvider('model-check', {
        score: 0.9,
        severity: 'critical',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'local-blocker',
          tier: 'local',
          check: 'true',
          action: { type: 'block', message: 'Blocked locally' },
        }),
        makeGuardrail({
          name: 'model-check',
          tier: 'model',
          provider: 'model-check',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('local-blocker');
      expect(result.violations[0].tier).toBe('local');
      // Model provider should NOT have been called (early termination)
      expect(modelProvider.evaluateCalled).toBe(false);
    });

    it('should evaluate tier2 (model) before tier3 (llm)', async () => {
      const modelProvider = new MockProvider('model-blocker', {
        score: 0.95,
        severity: 'critical',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      let llmCalled = false;
      const mockLLM: LLMEvalFunction = async () => {
        llmCalled = true;
        return '{"score": 0.9, "explanation": "LLM check"}';
      };

      const pipeline = new GuardrailPipelineImpl(registry, mockLLM);
      const guardrails = [
        makeGuardrail({
          name: 'model-blocker',
          tier: 'model',
          provider: 'model-blocker',
          threshold: 0.5,
          action: { type: 'block', message: 'Blocked by model' },
        }),
        makeGuardrail({
          name: 'llm-check',
          tier: 'llm',
          llmCheck: 'Check for safety',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].tier).toBe('model');
      expect(llmCalled).toBe(false);
    });

    it('should run all 3 tiers when no early termination', async () => {
      const modelProvider = new MockProvider('model-warn', {
        score: 0.6,
        severity: 'medium',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      let llmCalled = false;
      const mockLLM: LLMEvalFunction = async () => {
        llmCalled = true;
        return '{"score": 0.3, "explanation": "LLM says safe"}';
      };

      const pipeline = new GuardrailPipelineImpl(registry, mockLLM);
      const guardrails = [
        makeGuardrail({
          name: 'local-warn',
          tier: 'local',
          check: 'true',
          action: { type: 'warn', message: 'Local warning' },
        }),
        makeGuardrail({
          name: 'model-warn',
          tier: 'model',
          provider: 'model-warn',
          threshold: 0.5,
          action: { type: 'warn', message: 'Model warning' },
        }),
        makeGuardrail({
          name: 'llm-check',
          tier: 'llm',
          llmCheck: 'Check content',
          threshold: 0.5,
          action: { type: 'warn' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      // All tiers evaluated, all warn (non-terminal) → pipeline passes
      expect(result.passed).toBe(true);
      expect(result.warnings.length).toBeGreaterThanOrEqual(2); // local + model warn
      expect(llmCalled).toBe(true);
    });
  });

  // ─── Early Termination ────────────────────────────────────────────────

  describe('early termination', () => {
    it('tier1 block should skip tier2 and tier3', async () => {
      const modelProvider = new MockProvider('tier2-provider', {
        score: 0.9,
        severity: 'critical',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      let llmCalled = false;
      const mockLLM: LLMEvalFunction = async () => {
        llmCalled = true;
        return '{"score": 0.9}';
      };

      const pipeline = new GuardrailPipelineImpl(registry, mockLLM);
      const guardrails = [
        makeGuardrail({
          name: 'tier1-blocker',
          tier: 'local',
          check: 'true',
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier2-check',
          tier: 'model',
          provider: 'tier2-provider',
          threshold: 0.5,
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier3-check',
          tier: 'llm',
          llmCheck: 'Check',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.metrics.totalChecks).toBe(1);
      expect(modelProvider.evaluateCalled).toBe(false);
      expect(llmCalled).toBe(false);
    });

    it('tier1 escalate should skip tier2 and tier3', async () => {
      const modelProvider = new MockProvider('tier2-provider', {
        score: 0.9,
        severity: 'critical',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'tier1-escalate',
          tier: 'local',
          check: 'true',
          action: { type: 'escalate', message: 'Escalating' },
        }),
        makeGuardrail({
          name: 'tier2-check',
          tier: 'model',
          provider: 'tier2-provider',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('escalate');
      expect(modelProvider.evaluateCalled).toBe(false);
    });

    it('tier1 warn should NOT skip tier2', async () => {
      const modelProvider = new MockProvider('tier2-provider', {
        score: 0.8,
        severity: 'high',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'tier1-warn',
          tier: 'local',
          check: 'true',
          action: { type: 'warn', message: 'Just a warning' },
        }),
        makeGuardrail({
          name: 'tier2-blocker',
          tier: 'model',
          provider: 'tier2-provider',
          threshold: 0.5,
          action: { type: 'block', message: 'Blocked by model' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      // Tier1 warn is non-terminal → tier2 runs and blocks
      expect(result.passed).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].tier).toBe('model');
      expect(modelProvider.evaluateCalled).toBe(true);
    });

    it('tier2 block should skip tier3', async () => {
      const modelProvider = new MockProvider('tier2-blocker', {
        score: 0.9,
        severity: 'critical',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      let llmCalled = false;
      const mockLLM: LLMEvalFunction = async () => {
        llmCalled = true;
        return '{"score": 0.9}';
      };

      const pipeline = new GuardrailPipelineImpl(registry, mockLLM);
      const guardrails = [
        makeGuardrail({
          name: 'tier1-pass',
          tier: 'local',
          check: 'false',
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier2-blocker',
          tier: 'model',
          provider: 'tier2-blocker',
          threshold: 0.5,
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier3-check',
          tier: 'llm',
          llmCheck: 'Check',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.tier === 'model')).toBe(true);
      expect(llmCalled).toBe(false);
    });
  });

  // ─── Mixed Actions Across Tiers ───────────────────────────────────────

  describe('mixed actions across tiers', () => {
    it('tier1 warn + tier2 block = overall block', async () => {
      const modelProvider = new MockProvider('model-check', {
        score: 0.85,
        severity: 'high',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'tier1-warn',
          tier: 'local',
          check: 'true',
          action: { type: 'warn' },
        }),
        makeGuardrail({
          name: 'tier2-block',
          tier: 'model',
          provider: 'model-check',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'content', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.violations).toHaveLength(1);
    });

    it('tier1 redact + tier2 warn = pass with modified content', async () => {
      const modelProvider = new MockProvider('model-check', {
        score: 0.6,
        severity: 'medium',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'pii-redact',
          tier: 'local',
          check: 'abl.contains_pii(input)',
          action: { type: 'redact', redactMode: 'pii' },
        }),
        makeGuardrail({
          name: 'model-warn',
          tier: 'model',
          provider: 'model-check',
          threshold: 0.5,
          action: { type: 'warn' },
        }),
      ];

      const result = await pipeline.execute(
        guardrails,
        'Email me at user@example.com',
        'input',
        {},
      );

      // Tier1 redact is non-terminal → tier2 runs → warn
      // Pipeline passes (warn + redact are non-terminal)
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    it('tier1 pass + tier2 pass + tier3 block = overall block', async () => {
      const modelProvider = new MockProvider('model-check', {
        score: 0.2,
        severity: 'low',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const mockLLM: LLMEvalFunction = async () => {
        return '{"score": 0.95, "explanation": "LLM detected harmful content"}';
      };

      const pipeline = new GuardrailPipelineImpl(registry, mockLLM);
      const guardrails = [
        makeGuardrail({
          name: 'tier1-check',
          tier: 'local',
          check: 'false',
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier2-check',
          tier: 'model',
          provider: 'model-check',
          threshold: 0.5,
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier3-check',
          tier: 'llm',
          llmCheck: 'Check for subtly harmful content',
          threshold: 0.5,
          action: { type: 'block', message: 'LLM blocked' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'subtle harmful content', 'input', {});

      // Tier1 passes (check=false), tier2 passes (score 0.2 < 0.5), tier3 blocks
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.tier === 'llm')).toBe(true);
    });
  });

  // ─── All Valid Action × Kind Combinations ─────────────────────────────

  describe('valid action × kind combinations', () => {
    /**
     * ALLOWED_ACTIONS from guardrail-validator.ts:
     *   input:       block, warn, redact, fix, filter, escalate
     *   output:      block, warn, redact, fix, reask, filter, escalate
     *   tool_input:  block, warn, redact, fix, filter, escalate
     *   tool_output: block, warn, redact, fix, filter, escalate
     *   handoff:     block, warn, redact, escalate
     */
    const VALID_COMBOS: Array<{ kind: GuardrailKind; action: GuardrailActionType }> = [
      // input
      { kind: 'input', action: 'block' },
      { kind: 'input', action: 'warn' },
      { kind: 'input', action: 'redact' },
      { kind: 'input', action: 'fix' },
      { kind: 'input', action: 'filter' },
      { kind: 'input', action: 'escalate' },
      // output
      { kind: 'output', action: 'block' },
      { kind: 'output', action: 'warn' },
      { kind: 'output', action: 'redact' },
      { kind: 'output', action: 'fix' },
      { kind: 'output', action: 'reask' },
      { kind: 'output', action: 'filter' },
      { kind: 'output', action: 'escalate' },
      // tool_input
      { kind: 'tool_input', action: 'block' },
      { kind: 'tool_input', action: 'warn' },
      { kind: 'tool_input', action: 'redact' },
      { kind: 'tool_input', action: 'fix' },
      { kind: 'tool_input', action: 'filter' },
      { kind: 'tool_input', action: 'escalate' },
      // tool_output
      { kind: 'tool_output', action: 'block' },
      { kind: 'tool_output', action: 'warn' },
      { kind: 'tool_output', action: 'redact' },
      { kind: 'tool_output', action: 'fix' },
      { kind: 'tool_output', action: 'filter' },
      { kind: 'tool_output', action: 'escalate' },
      // handoff
      { kind: 'handoff', action: 'block' },
      { kind: 'handoff', action: 'warn' },
      { kind: 'handoff', action: 'redact' },
      { kind: 'handoff', action: 'escalate' },
    ];

    for (const { kind, action } of VALID_COMBOS) {
      it(`should accept ${action} on ${kind}`, async () => {
        const modelProvider = new MockProvider('combo-provider', {
          score: 0.8,
          severity: 'high',
        });
        const registry = new GuardrailProviderRegistry();
        registry.register(modelProvider);

        const pipeline = new GuardrailPipelineImpl(registry);
        const guardrail = makeGuardrail({
          name: `${kind}-${action}-guard`,
          kind,
          tier: 'model',
          provider: 'combo-provider',
          threshold: 0.5,
          action: {
            type: action,
            message: `Test ${action} on ${kind}`,
            ...(action === 'fix' ? { fixStrategy: 'truncate' as const } : {}),
            ...(action === 'reask' ? { maxReasks: 2 } : {}),
          },
        });

        const context: Record<string, unknown> = {};
        if (kind === 'tool_input' || kind === 'tool_output') {
          Object.assign(context, { toolName: 'test-tool' });
        }
        if (kind === 'handoff') {
          Object.assign(context, {
            sourceAgent: 'agent-a',
            targetAgent: 'agent-b',
          });
        }

        const result = await pipeline.execute([guardrail], 'test content', kind, context);

        // Score 0.8 >= threshold 0.5 → violation triggered
        // Terminal actions (block, escalate) → result.passed = false
        // Non-terminal actions → result.passed = true (warn, redact, fix, filter)
        const isTerminal = action === 'block' || action === 'escalate' || action === 'reask';
        const isWarn = action === 'warn';

        if (isTerminal) {
          expect(result.passed).toBe(false);
          expect(result.violations.length).toBeGreaterThanOrEqual(1);
        } else if (isWarn) {
          expect(result.passed).toBe(true);
          expect(result.warnings.length).toBeGreaterThanOrEqual(1);
        } else if (action === 'filter') {
          // Filter is non-terminal but can escalate to block via applyActions
          // when filtered content falls below filterMinLength. With short test
          // content and category-based patterns, escalation is expected.
          expect(result.violations.length).toBeGreaterThanOrEqual(1);
        } else {
          // Non-terminal non-warn: redact, fix
          // These go to violations but don't mark passed=false
          expect(result.passed).toBe(true);
        }
      });
    }

    // Invalid combinations
    const INVALID_COMBOS: Array<{ kind: GuardrailKind; action: GuardrailActionType }> = [
      { kind: 'input', action: 'reask' },
      { kind: 'tool_input', action: 'reask' },
      { kind: 'tool_output', action: 'reask' },
      { kind: 'handoff', action: 'reask' },
      { kind: 'handoff', action: 'fix' },
      { kind: 'handoff', action: 'filter' },
    ];

    for (const { kind, action } of INVALID_COMBOS) {
      it(`should reject ${action} on ${kind} via validator`, async () => {
        // Import validator inline to keep test self-contained
        const { validateGuardrails } = await import('../../platform/ir/guardrail-validator');

        const diagnostics = validateGuardrails([
          makeGuardrail({
            kind,
            action: {
              type: action,
              ...(action === 'fix' ? { fixStrategy: 'truncate' as const } : {}),
            },
          }),
        ]);

        expect(diagnostics.length).toBeGreaterThanOrEqual(1);
        expect(diagnostics[0].severity).toBe('error');
      });
    }
  });

  // ─── Priority Ordering Within Tiers ───────────────────────────────────

  describe('priority ordering within tiers', () => {
    it('should use highest priority violation as primaryViolation across tiers', async () => {
      const modelProvider = new MockProvider('model-check', {
        score: 0.8,
        severity: 'high',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'low-priority-local',
          tier: 'local',
          priority: 10,
          check: 'true',
          action: { type: 'block', message: 'Low priority' },
        }),
        makeGuardrail({
          name: 'high-priority-local',
          tier: 'local',
          priority: 1,
          check: 'true',
          action: { type: 'block', message: 'High priority' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      expect(result.primaryViolation?.name).toBe('high-priority-local');
      expect(result.primaryViolation?.priority).toBe(1);
    });
  });

  // ─── Metrics Aggregation Across Tiers ─────────────────────────────────

  describe('metrics aggregation across tiers', () => {
    it('should aggregate check counts across all evaluated tiers', async () => {
      const modelProvider = new MockProvider('model-safe', {
        score: 0.1,
        severity: 'safe',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const mockLLM: LLMEvalFunction = async () => {
        return '{"score": 0.1, "explanation": "Safe"}';
      };

      const pipeline = new GuardrailPipelineImpl(registry, mockLLM);
      const guardrails = [
        makeGuardrail({
          name: 'tier1-a',
          tier: 'local',
          check: 'false',
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier1-b',
          tier: 'local',
          check: 'false',
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier2-check',
          tier: 'model',
          provider: 'model-safe',
          threshold: 0.5,
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'tier3-check',
          tier: 'llm',
          llmCheck: 'Check',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'safe content', 'input', {});

      expect(result.passed).toBe(true);
      // 2 tier1 + 1 tier2 + 1 tier3 = 4 total checks
      expect(result.metrics.totalChecks).toBe(4);
      expect(result.metrics.passed).toBe(4);
      expect(result.metrics.failed).toBe(0);
    });

    it('should accumulate cost from tier2 providers', async () => {
      const provider1 = new MockProvider('provider-a', { score: 0.1, severity: 'safe' }, 0.005);
      const provider2 = new MockProvider('provider-b', { score: 0.2, severity: 'low' }, 0.01);
      const registry = new GuardrailProviderRegistry();
      registry.register(provider1);
      registry.register(provider2);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'check-a',
          tier: 'model',
          provider: 'provider-a',
          threshold: 0.5,
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'check-b',
          tier: 'model',
          provider: 'provider-b',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      // $0.005 + $0.01 = $0.015
      expect(result.metrics.costUsd).toBeCloseTo(0.015, 5);
    });

    it('should track tier-specific latency', async () => {
      const modelProvider = new MockProvider('slow-model', {
        score: 0.1,
        severity: 'safe',
      });
      const registry = new GuardrailProviderRegistry();
      registry.register(modelProvider);

      const pipeline = new GuardrailPipelineImpl(registry);
      const guardrails = [
        makeGuardrail({
          name: 'local-check',
          tier: 'local',
          check: 'false',
          action: { type: 'block' },
        }),
        makeGuardrail({
          name: 'model-check',
          tier: 'model',
          provider: 'slow-model',
          threshold: 0.5,
          action: { type: 'block' },
        }),
      ];

      const result = await pipeline.execute(guardrails, 'test', 'input', {});

      expect(result.metrics.tier1LatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.tier2LatencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
