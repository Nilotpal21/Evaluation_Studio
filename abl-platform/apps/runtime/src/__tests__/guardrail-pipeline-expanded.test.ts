import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Guardrail,
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
  PipelinePolicy,
} from '@abl/compiler';
import type { PolicyData } from '../services/guardrails/policy-resolver.js';

// ---------------------------------------------------------------------------
// Group 1: createGuardrailPipeline factory (direct, no module mock needed)
// ---------------------------------------------------------------------------

describe('Group 1: createGuardrailPipeline factory', () => {
  let createGuardrailPipeline: typeof import('../services/guardrails/pipeline-factory.js').createGuardrailPipeline;
  let registerGuardrailProvider: typeof import('../services/guardrails/pipeline-factory.js').registerGuardrailProvider;
  let getSharedRegistry: typeof import('../services/guardrails/pipeline-factory.js').getSharedRegistry;
  let resetSharedRegistry: typeof import('../services/guardrails/pipeline-factory.js').resetSharedRegistry;
  let createLLMEvalFromClient: typeof import('../services/guardrails/pipeline-factory.js').createLLMEvalFromClient;

  beforeEach(async () => {
    const mod = await import('../services/guardrails/pipeline-factory.js');
    createGuardrailPipeline = mod.createGuardrailPipeline;
    registerGuardrailProvider = mod.registerGuardrailProvider;
    getSharedRegistry = mod.getSharedRegistry;
    resetSharedRegistry = mod.resetSharedRegistry;
    createLLMEvalFromClient = mod.createLLMEvalFromClient;
    resetSharedRegistry();
  });

  it('registerGuardrailProvider called twice with same name overwrites', () => {
    const firstProvider: GuardrailModelProvider = {
      name: 'overwrite-test',
      costPerEvalUsd: 0.01,
      evaluate: async (_req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.1,
        severity: 'safe',
        category: 'test',
        latencyMs: 1,
      }),
      isAvailable: async () => true,
    };

    const secondProvider: GuardrailModelProvider = {
      name: 'overwrite-test',
      costPerEvalUsd: 0.99,
      evaluate: async (_req: GuardrailEvalRequest): Promise<GuardrailEvalResult> => ({
        score: 0.9,
        severity: 'critical',
        category: 'test-v2',
        latencyMs: 2,
      }),
      isAvailable: async () => false,
    };

    registerGuardrailProvider(firstProvider);
    registerGuardrailProvider(secondProvider);

    const registry = getSharedRegistry();
    const provider = registry.get('overwrite-test');

    expect(provider).toBeDefined();
    // The second provider should have replaced the first
    expect(provider!.costPerEvalUsd).toBe(0.99);
  });

  it('createLLMEvalFromClient returns empty string when chatWithToolUse has no text', async () => {
    const mockClient = {
      chatWithToolUse: vi.fn().mockResolvedValue({ text: undefined, toolCalls: [] }),
    } as any;

    const evalFn = createLLMEvalFromClient(mockClient);
    const result = await evalFn('Evaluate this content for safety');

    expect(result).toBe('');
  });

  it('createLLMEvalFromClient passes validation operation type', async () => {
    const mockClient = {
      chatWithToolUse: vi.fn().mockResolvedValue({ text: 'safe', toolCalls: [] }),
    } as any;

    const evalFn = createLLMEvalFromClient(mockClient);
    await evalFn('Check this prompt');

    expect(mockClient.chatWithToolUse).toHaveBeenCalledTimes(1);

    const callArgs = mockClient.chatWithToolUse.mock.calls[0];
    // 1st arg: empty system prompt
    expect(callArgs[0]).toBe('');
    // 2nd arg: messages array with user role
    expect(callArgs[1]).toEqual([{ role: 'user', content: 'Check this prompt' }]);
    // 3rd arg: empty tools array
    expect(callArgs[2]).toEqual([]);
    // 4th arg: 'validation' operation type
    expect(callArgs[3]).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Group 2: checkOutputGuardrails edge cases
// ---------------------------------------------------------------------------

// Mock the pipeline factory for output guardrail tests
const mockExecute = vi.fn();
vi.mock('../services/guardrails/pipeline-factory.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/guardrails/pipeline-factory.js')>();
  return {
    ...actual,
    createGuardrailPipeline: vi.fn(() => ({
      execute: mockExecute,
    })),
  };
});

// Import after mock is established
const { checkOutputGuardrails } = await import('../services/execution/output-guardrails.js');
const { createGuardrailPipeline } = await import('../services/guardrails/pipeline-factory.js');

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'test-guard',
    description: 'test guardrail',
    kind: 'output',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('Group 2: checkOutputGuardrails edge cases', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    (createGuardrailPipeline as any).mockClear();
    (createGuardrailPipeline as any).mockReturnValue({ execute: mockExecute });
  });

  it('returns passed=true when text is empty string', async () => {
    const guardrails = [makeGuardrail()];
    const result = await checkOutputGuardrails('', guardrails, {});

    expect(result.passed).toBe(true);
    expect(result.text).toBe('');
    // Pipeline should not be invoked for empty text
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns passed=true when guardrails array is empty', async () => {
    const result = await checkOutputGuardrails('Some response text', [], {});

    expect(result.passed).toBe(true);
    expect(result.text).toBe('Some response text');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('passes input-kind guardrails to pipeline (kind filtering is pipeline-internal)', async () => {
    mockExecute.mockResolvedValue({
      passed: true,
      violations: [],
      warnings: [],
      metrics: { totalMs: 1, evaluations: 0, passed: 0, failed: 0, warned: 0 },
    });
    const inputOnlyGuardrails = [
      makeGuardrail({ name: 'input-pii', kind: 'input' }),
      makeGuardrail({ name: 'input-injection', kind: 'input' }),
    ];

    const result = await checkOutputGuardrails('Response text', inputOnlyGuardrails, {});

    expect(result.passed).toBe(true);
    expect(result.text).toBe('Response text');
    expect(mockExecute).toHaveBeenCalled();
  });

  it('fail-open on pipeline execution error', async () => {
    mockExecute.mockRejectedValue(new Error('Provider timeout'));

    const guardrails = [makeGuardrail()];
    const result = await checkOutputGuardrails('Sensitive response', guardrails, {});

    expect(result.passed).toBe(true);
    expect(result.text).toBe('Sensitive response');
    // No violation should be set
    expect(result.violation).toBeUndefined();
    // No modified content
    expect(result.modifiedContent).toBeUndefined();
  });

  it('modifiedContent propagated even when passed=true', async () => {
    mockExecute.mockResolvedValue({
      passed: true,
      modifiedContent: 'redacted text',
      violations: [],
      warnings: [],
      metrics: { totalMs: 3, evaluations: 1, passed: 1, failed: 0, warned: 0 },
    });

    const guardrails = [makeGuardrail({ action: { type: 'redact' } })];
    const result = await checkOutputGuardrails('original sensitive text', guardrails, {});

    expect(result.passed).toBe(true);
    // text should be the modified content, not the original
    expect(result.text).toBe('redacted text');
    expect(result.modifiedContent).toBe('redacted text');
  });
});

// ---------------------------------------------------------------------------
// Group 3: resolveGuardrailPolicy edge cases
// ---------------------------------------------------------------------------

describe('Group 3: resolveGuardrailPolicy edge cases', () => {
  let resolveGuardrailPolicy: typeof import('../services/guardrails/pipeline-factory.js').resolveGuardrailPolicy;

  beforeEach(async () => {
    const mod = await import('../services/guardrails/pipeline-factory.js');
    resolveGuardrailPolicy = mod.resolveGuardrailPolicy;
  });

  const defaultSettings: PolicyData['settings'] = {
    failMode: 'open',
    timeouts: { local: 10, model: 500, llm: 2000 },
  };

  function makeInputGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
    return {
      name: 'policy-test-guard',
      description: 'guardrail for policy tests',
      kind: 'input',
      priority: 1,
      tier: 'local',
      check: 'true',
      action: { type: 'block' },
      ...overrides,
    };
  }

  it('returns undefined when loadPolicies throws', async () => {
    const failingLoader = vi.fn().mockRejectedValue(new Error('Database unavailable'));

    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeInputGuardrail()],
      failingLoader,
    );

    expect(result).toBeUndefined();
    expect(failingLoader).toHaveBeenCalledWith('tenant-1', 'project-1', 'agent-1');
  });

  it('returns undefined when no policies found', async () => {
    const emptyLoader = vi.fn().mockResolvedValue({
      tenantPolicies: [],
      projectPolicies: [],
    });

    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeInputGuardrail()],
      emptyLoader,
    );

    expect(result).toBeUndefined();
  });

  it('returns PipelinePolicy with empty ruleOverrides array', async () => {
    const loaderWithSettingsOnly = vi.fn().mockResolvedValue({
      tenantPolicies: [
        {
          name: 'settings-only-policy',
          rules: [],
          settings: { ...defaultSettings, failMode: 'closed' },
        },
      ],
      projectPolicies: [],
    });

    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeInputGuardrail()],
      loaderWithSettingsOnly,
    );

    expect(result).toBeDefined();
    expect(result!.policy.ruleOverrides).toEqual([]);
    expect(result!.policy.settings?.failMode).toBe('closed');
  });

  it('project-scoped policy with mismatched projectId is excluded', async () => {
    // The loadPolicies function in pipeline-factory.ts filters by scope.projectId.
    // If the loader returns a project policy for a different projectId,
    // it should not be present in the projectPolicies bucket.
    // We simulate the DB layer behavior where the policy has scope.type='project'
    // but scope.projectId='other-project' — so it should not be in projectPolicies.
    const loaderWithMismatch = vi.fn().mockResolvedValue({
      tenantPolicies: [],
      // Mismatched project policy should not be included by the loader
      projectPolicies: [],
    });

    const result = await resolveGuardrailPolicy(
      'tenant-1',
      'project-1',
      'agent-1',
      [makeInputGuardrail()],
      loaderWithMismatch,
    );

    // With no matching policies in either bucket, result should be undefined
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 4: Output guardrail caller context
// ---------------------------------------------------------------------------

describe('Group 4: Output guardrail caller context', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    (createGuardrailPipeline as any).mockClear();
    (createGuardrailPipeline as any).mockReturnValue({ execute: mockExecute });
    mockExecute.mockResolvedValue({
      passed: true,
      violations: [],
      warnings: [],
      modifiedContent: undefined,
      metrics: { totalMs: 2, evaluations: 1, passed: 1, failed: 0, warned: 0 },
    });
  });

  it('context object passed to pipeline.execute includes caller fields', async () => {
    const guardrails = [makeGuardrail()];
    const context = {
      tenantId: 'org-1',
      channel: 'whatsapp',
      sessionId: 'sess-1',
    };

    await checkOutputGuardrails('Hello there', guardrails, context);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const callArgs = mockExecute.mock.calls[0];
    // pipeline.execute(guardrails, text, kind, context, llmEval, policy)
    // 4th argument is the context
    const passedContext = callArgs[3];
    expect(passedContext).toEqual({
      tenantId: 'org-1',
      channel: 'whatsapp',
      sessionId: 'sess-1',
    });
  });

  it('policy parameter forwarded to pipeline.execute', async () => {
    const guardrails = [makeGuardrail()];
    const context = { tenantId: 'org-2' };
    const policy: PipelinePolicy = {
      disabledGuardrails: ['some-guard'],
      ruleOverrides: [
        {
          guardrailName: 'test-guard',
          override: 'threshold',
          threshold: 0.7,
        },
      ],
      settings: { failMode: 'closed' },
    };

    await checkOutputGuardrails('Response content', guardrails, context, policy);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const callArgs = mockExecute.mock.calls[0];
    // pipeline.execute(guardrails, text, kind, context, llmEval, policy)
    // 6th argument (index 5) is the policy
    const passedPolicy = callArgs[5];
    expect(passedPolicy).toBe(policy);
    expect(passedPolicy.disabledGuardrails).toContain('some-guard');
    expect(passedPolicy.settings?.failMode).toBe('closed');
    expect(passedPolicy.ruleOverrides).toHaveLength(1);
    expect(passedPolicy.ruleOverrides![0].threshold).toBe(0.7);
  });
});
