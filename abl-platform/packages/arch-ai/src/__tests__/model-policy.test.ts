import { describe, expect, it } from 'vitest';
import { getModelCapabilities } from '@abl/compiler/platform/llm/model-capabilities.js';
import { MODEL_REGISTRY } from '@abl/compiler/platform/llm/model-registry.js';

import {
  DEFAULT_ARCH_MODEL_POLICY_DEFAULTS,
  normalizeArchModelPolicyDefaults,
  resolveDefaultArchModelPolicyDefaults,
  resolveArchExecutionModel,
  resolveArchModelClass,
  inferArchModelPolicyFromText,
  selectArchModelPolicyDefaults,
  type ArchModelPolicyCandidate,
} from '../model-policy.js';

function findRegistryModel(predicate: (modelId: string) => boolean): string {
  const modelId = Object.keys(MODEL_REGISTRY).find(predicate);
  expect(modelId).toBeDefined();
  return modelId!;
}

function registryCandidate(
  modelId: string,
  overrides: Omit<ArchModelPolicyCandidate, 'modelId'> = {},
): ArchModelPolicyCandidate {
  const capabilities = getModelCapabilities(modelId);
  return {
    modelId,
    supportsTools: capabilities.supportsTools,
    isReasoningModel: capabilities.isReasoningModel,
    supportsReasoningEffort: capabilities.supportsReasoningEffort,
    supportsThinking: capabilities.supportsThinking,
    supportsThinkingBudget: capabilities.supportsThinkingBudget,
    ...overrides,
  };
}

describe('Arch model policy', () => {
  it('resolves ordinary support, classifier, and dispatcher work to the fast tool-capable class', () => {
    expect(resolveArchModelClass({ agentType: 'support' })).toBe('fast_tool_capable');
    expect(resolveArchModelClass({ agentType: 'classifier' })).toBe('fast_tool_capable');
    expect(resolveArchModelClass({ agentType: 'dispatcher' })).toBe('fast_tool_capable');
  });

  it('infers support and dispatcher topology hints without selecting provider models', () => {
    expect(
      inferArchModelPolicyFromText({
        name: 'TriageAgent',
        role: 'Classify requests and route to support specialists',
        isEntryPoint: true,
        hasOutgoingEdges: true,
      }),
    ).toEqual({
      agentType: 'dispatcher',
      reasoningRequired: false,
      defaultModelClass: 'fast_tool_capable',
    });
    expect(
      inferArchModelPolicyFromText({
        name: 'OrdersAgent',
        role: 'Resolve order status and replacement requests',
      }),
    ).toEqual({
      agentType: 'support',
      reasoningRequired: false,
      defaultModelClass: 'fast_tool_capable',
    });
  });

  it('infers reasoning and research only from explicit source evidence', () => {
    expect(
      inferArchModelPolicyFromText({
        name: 'PolicyAdvisor',
        role: 'Perform eligibility analysis and policy synthesis for edge cases',
      }),
    ).toEqual({
      agentType: 'reasoning',
      reasoningRequired: true,
      defaultModelClass: 'reasoning',
    });
    expect(
      inferArchModelPolicyFromText({
        name: 'ResearchAgent',
        role: 'Research multi-source evidence and produce source synthesis',
      }),
    ).toEqual({
      agentType: 'research',
      reasoningRequired: true,
      defaultModelClass: 'research',
    });
  });

  it('treats research and reasoning agent types as explicit opt-in signals', () => {
    expect(resolveArchModelClass({ agentType: 'research' })).toBe('research');
    expect(resolveArchModelClass({ agentType: 'reasoning' })).toBe('reasoning');
  });

  it('does not let fast defaults override required reasoning', () => {
    expect(
      resolveArchModelClass({
        reasoningRequired: true,
        defaultModelClass: 'fast_tool_capable',
      }),
    ).toBe('reasoning');
  });

  it('keeps explicit research class when reasoning is required', () => {
    expect(
      resolveArchModelClass({
        reasoningRequired: true,
        defaultModelClass: 'research',
      }),
    ).toBe('research');
  });

  it('keeps an explicit model ahead of catalog defaults and policy intent', () => {
    expect(
      resolveArchExecutionModel({
        explicitModel: 'custom-manual-model',
        modelPolicy: { agentType: 'research' },
        modelDefaults: {
          research: 'configured-research-model',
        },
      }),
    ).toBe('custom-manual-model');
  });

  it('ignores blank explicit models before falling back to the fast catalog default', () => {
    expect(
      resolveArchExecutionModel({
        explicitModel: '   ',
        modelPolicy: { agentType: 'support' },
        modelDefaults: {
          fastToolCapable: 'configured-fast-model',
        },
      }),
    ).toBe('configured-fast-model');
  });

  it('does not use optional policy intent to select a concrete execution model', () => {
    expect(
      resolveArchExecutionModel({
        modelPolicy: {
          agentType: 'research',
          reasoningRequired: true,
          defaultModelClass: 'research',
        },
        modelDefaults: {
          fastToolCapable: 'configured-fast-model',
          reasoning: 'configured-reasoning-model',
          research: 'configured-research-model',
        },
      }),
    ).toBe('configured-fast-model');
  });

  it('keeps built-in fast support defaults on a non-reasoning tool-capable model family', () => {
    const capabilities = getModelCapabilities(DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable);

    expect(capabilities.supportsTools).toBe(true);
    expect(capabilities.isReasoningModel).toBe(false);
    expect(capabilities.supportsReasoningEffort).toBe(false);
    expect(capabilities.supportsThinking).toBe(false);
    expect(capabilities.supportsThinkingBudget).toBe(false);
  });

  it('selects non-reasoning catalog models for support defaults even when fast reasoning models exist', () => {
    const reasoningCandidate = findRegistryModel(
      (modelId) =>
        getModelCapabilities(modelId).supportsTools &&
        getModelCapabilities(modelId).isReasoningModel,
    );
    const supportCandidate = findRegistryModel((modelId) => {
      const capabilities = getModelCapabilities(modelId);
      return capabilities.supportsTools && !capabilities.isReasoningModel;
    });
    const defaults = selectArchModelPolicyDefaults([
      registryCandidate(reasoningCandidate, {
        tier: 'fast',
        isDefault: true,
      }),
      registryCandidate(supportCandidate, {
        tier: 'balanced',
        isDefault: false,
      }),
    ]);

    expect(defaults.fastToolCapable).toBeDefined();
    expect(getModelCapabilities(defaults.fastToolCapable!).isReasoningModel).toBe(false);
  });

  it('classifies dotted GPT-5 model IDs as reasoning-capable even without catalog flags', () => {
    const defaults = selectArchModelPolicyDefaults([
      {
        modelId: 'gpt-5.4',
        supportsTools: true,
        tier: 'powerful',
        isDefault: true,
      },
      {
        modelId: 'gpt-4o',
        supportsTools: true,
        tier: 'balanced',
        isDefault: true,
      },
    ]);

    expect(defaults.fastToolCapable).toBe('gpt-4o');
    expect(defaults.reasoning).toBe('gpt-5.4');
    expect(defaults.research).toBe('gpt-5.4');
  });

  it('selects reasoning-capable catalog defaults but leaves execution selection to fast default', () => {
    const supportCandidate = findRegistryModel((modelId) => {
      const capabilities = getModelCapabilities(modelId);
      return capabilities.supportsTools && !capabilities.isReasoningModel;
    });
    const reasoningCandidate = findRegistryModel(
      (modelId) =>
        getModelCapabilities(modelId).supportsTools &&
        getModelCapabilities(modelId).isReasoningModel,
    );
    const defaults = selectArchModelPolicyDefaults([
      registryCandidate(supportCandidate, {
        tier: 'balanced',
        isDefault: true,
      }),
      registryCandidate(reasoningCandidate, {
        tier: 'powerful',
        isDefault: true,
      }),
    ]);
    const supportModel = resolveArchExecutionModel({
      modelPolicy: { agentType: 'support' },
      modelDefaults: defaults,
    });
    const reasoningModel = resolveArchExecutionModel({
      modelPolicy: { agentType: 'reasoning' },
      modelDefaults: defaults,
    });

    expect(getModelCapabilities(supportModel).isReasoningModel).toBe(false);
    expect(getModelCapabilities(reasoningModel).isReasoningModel).toBe(false);
  });

  it('fills partial defaults from the package policy', () => {
    expect(normalizeArchModelPolicyDefaults({ reasoning: 'configured-reasoning-model' })).toEqual({
      ...DEFAULT_ARCH_MODEL_POLICY_DEFAULTS,
      reasoning: 'configured-reasoning-model',
    });
  });

  it('ignores blank model-default overrides', () => {
    expect(
      normalizeArchModelPolicyDefaults({
        fastToolCapable: '   ',
        reasoning: 'configured-reasoning-model',
      }),
    ).toEqual({
      ...DEFAULT_ARCH_MODEL_POLICY_DEFAULTS,
      reasoning: 'configured-reasoning-model',
    });
  });

  it('lets deployment configuration define package fallback models', () => {
    expect(
      resolveDefaultArchModelPolicyDefaults({
        ARCH_FAST_TOOL_MODEL: 'tenant-fast-tool-model',
        ARCH_REASONING_MODEL: 'tenant-reasoning-model',
        ARCH_RESEARCH_MODEL: 'tenant-research-model',
      }),
    ).toEqual({
      fastToolCapable: 'tenant-fast-tool-model',
      reasoning: 'tenant-reasoning-model',
      research: 'tenant-research-model',
    });
  });
});
